// server/adapters/agodaAdapter.js
// ======================================================================
//  AGODA — S200 RAW CLEAN EDITION
//  ZERO DELETE • ZERO DRIFT • RAW RETURN ONLY
// ======================================================================

import axios from "axios";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";
// ----------------------------------------------------------------------
// STUB POLICY (HARD) — NO FAKE RESULTS IN PROD
// ----------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _s200FailArray(source, query, patchMeta = {}, code = "ERROR", err = null) {
  const a = [];
  try {
    Object.defineProperty(a, "ok", { value: false, enumerable: false });
    Object.defineProperty(a, "_meta", {
      value: {
        source,
        query: String(query || ""),
        code,
        ...(patchMeta || {}),
        ...(err ? { error: err?.message || String(err) } : {}),
      },
      enumerable: false,
    });
  } catch {}
  return a;
}

import {
  withTimeout, coerceItemsS200, normalizeItemS200, stableIdS200, safeStr,
} from "../core/s200AdapterKit.js";

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
const safe = (v) => (v ? String(v).trim() : "");

function normalizeUrl(u) {
  if (!u) return null;

  const x = String(u).trim();

  if (
    x === "" ||
    x === "#" ||
    x.startsWith("javascript") ||
    x.includes("void(0)")
  ) {
    return null;
  }

  if (x.startsWith("//")) return "https:" + x;
  if (x.startsWith("/") && !x.startsWith("http"))
    return `https://www.agoda.com${x}`;
  if (x.startsWith("http")) return x;

  return `https://www.agoda.com/${x}`;
}

function parsePrice(p) {
  if (p == null) return null;
  if (typeof p === "number") return p;

  const cleaned = Number(
    String(p)
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(cleaned) ? cleaned : null;
}

function normalizeRating(hotel) {
  const r = hotel?.ReviewScore ?? hotel?.Score ?? hotel?.Rating ?? null;
  if (r == null) return null;

  const n = Number(r);
  if (!Number.isFinite(n)) return null;

  // Agoda genelde 10 üzerinden verir, 5'e çeviriyoruz:
  return Math.max(0, Math.min(5, (n / 10) * 5));
}

function buildStableId(id, title = "") {
  const base = `${id || title || "agoda"}`;
  try {
    return "agoda_" + Buffer.from(base).toString("base64").slice(0, 32);
  } catch {
    return "agoda_" + base.replace(/\W+/g, "_");
  }
}

// ------------------------------------------------------------
// MAIN ADAPTER — RAW MODE
// ------------------------------------------------------------
export async function searchAgodaLegacy(query, regionOrOptions = {}) {
  if (!query || !String(query).trim()) return [];

  // REGION
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  // RATE LIMITER
  const limiterKey = `s200:adapter:agoda:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 12,
    windowMs: 60000,
    adaptive: true,
    burst: true,
  });

  if (!allowed) return [];

  try {
    const q = encodeURIComponent(query);

    const url =
      `https://www.agoda.com/api/zh-tw/Main/GetSearchResultList` +
      `?text=${q}&pagetypeid=103&origin=${region}` +
      `&currency=TRY&culture=tr-tr`;

    const response = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Safari",
        Accept: "application/json",
      },
    });

    const rawList = Array.isArray(response.data?.ResultList)
      ? response.data.ResultList
      : [];

    const items = [];

    rawList.forEach((hotel) => {
      const title = safe(hotel.HotelName || hotel.Name);
      if (!title) return;

      const url = normalizeUrl(hotel.HotelUrl || hotel.Url);
      if (!url) return;

      let price = parsePrice(
        hotel.MinPrice ??
          hotel.DisplayPrice ??
          hotel.DealPrice ??
          hotel.OriginalPrice ??
          hotel.Price
      );

      if (price == null || price <= 0) return;

      const rating = normalizeRating(hotel);

      const imgRaw =
        hotel.MainPhotoUrl ||
        hotel.ThumbnailUrl ||
        hotel.OptimizedThumbnailUrl ||
        null;

      const variants = buildImageVariants(imgRaw, "agoda");

      const id = buildStableId(hotel.HotelId, title);

      // ===========================
      // RAW ITEM — S200 UYUM
      // ===========================
      items.push({
        id,
        title,
        price,
        rating,
        provider: "agoda",   // Motor normalize edecek
        currency: "TRY",
        region,
        url,

        // HER ŞEY RAW ALTINDA
        raw: {
          ...hotel,
          imageRaw: imgRaw,
          imageVariants: variants,
          extractedAt: new Date().toISOString(),
        },
      });
    });

    return items.slice(0, 150);
  } catch (err) {
    const status = err?.response?.status || null;
    const code =
      status === 429 ? "HTTP_429" :
      status === 403 ? "HTTP_403" :
      status === 404 ? "HTTP_404" :
      status ? `HTTP_${status}` : "AGODA_FAIL";

    console.warn("Agoda adapter error:", err?.message || String(err));
    return _s200FailArray("agoda", query, { region, status }, code, err);
  }
}

// ------------------------------------------------------------
// EXPORTS
// ------------------------------------------------------------
export default { searchAgoda };
export const agodaAdapterConfig = {
  name: "agoda",
  fn: searchAgoda,
  provider: "agoda",
  timeoutMs: 15000,
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchAgoda(query, options = {}) {
  const started = Date.now();
  const providerKey = "agoda";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "agodaAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 15000) || 15000;

  try {
    const raw = await withTimeout(Promise.resolve(searchAgodaLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "agoda",
        _meta: {
          startedAt: started,
          durationMs: Date.now() - started,
          timeoutMs,
          error: errMsg,
          legacyOk: false,
        },
      };
    }

    const itemsIn = coerceItemsS200(raw);
    const out = [];
    let bad = 0;

    for (const it of itemsIn) {
      if (!it || typeof it !== "object") continue;

      const x = { ...it };

      // NO RANDOM ID — wipe any legacy/random ids and rebuild deterministically.
      x.id = null;
      x.listingId = null;
      x.listing_id = null;
      x.itemId = null;

      // Discovery sources: price forced null, affiliate injection OFF.
      if (false) {
        x.price = null;
        x.finalPrice = null;
        x.optimizedPrice = null;
        x.originalPrice = null;
        x.affiliateUrl = null;
        x.deeplink = null;
        x.deepLink = null;
        x.finalUrl = null;
      }

      const ni = normalizeItemS200(x, providerKey, {
        category: "general",
        vertical: "general",
        query: String(query || ""),
        region: String(options?.region || "TR").toUpperCase(),
      });

      if (!ni) {
        bad++;
        continue;
      }

      // Hard enforce stable id.
      ni.id = stableIdS200(providerKey, ni.url, ni.title);

      out.push(ni);
    }

    return {
      ok: true,
      items: out,
      count: out.length,
      source: "agoda",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        bad,
        legacyOk: true,
      },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e, 900) || "unknown_error";
    const isTimeout = e?.name === "TimeoutError" || /timed out|timeout/i.test(String(e?.message || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      source: "agoda",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        timeout: isTimeout,
        error: msg,
      },
    };
  }
}
