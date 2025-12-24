// server/adapters/genericCheckupAdapter.js
// =======================================================================
// GENERIC CHECK-UP ADAPTER — S33 TITAN+ EDITION (FINAL)
// Zero Delete — eski davranış korunur, TITAN çekirdeği eklenir.
// • stableId v3.5 (slug + hash + entropy)
// • qualityScore (health-weighted)
// • ImageVariants FULL
// • categoryAI → “health_checkup”
// • strong fallback
// • abort + timeout FULL
// =======================================================================

import axios from "axios";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { normalizeItemS200, coerceItemsS200, stableIdS200, withTimeout, TimeoutError } from "../core/s200AdapterKit.js";

// =======================================================================
// S200 FAIL-ARRAY HELPERS (keeps array signature, makes failure observable)
// =======================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

function _s200FailArray(source, query, opt = {}, code = "ADAPTER_FAIL", err = "") {
  const arr = [];
  try {
    Object.defineProperty(arr, "ok", { value: false, enumerable: false });
    Object.defineProperty(arr, "_meta", {
      value: {
        source,
        query: typeof query === "string" ? query : "",
        code,
        error: String(err || ""),
        stubAllowed: FINDALLEASY_ALLOW_STUBS,
        opt,
      },
      enumerable: false,
    });
  } catch {}
  return arr;
}

function _s200MarkOkArray(arr, source, meta = {}) {
  if (!Array.isArray(arr)) return arr;
  try {
    Object.defineProperty(arr, "ok", { value: true, enumerable: false });
    Object.defineProperty(arr, "_meta", { value: { source, ...meta }, enumerable: false });
  } catch {}
  return arr;
}


// ------------------------------------------------------------
// HELPERS (S33 LEVEL)
// ------------------------------------------------------------
const safe = (v) => (v == null ? "" : String(v).trim());

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
}

function stableId(title, url) {
  return stableIdS200("generic_checkup", url || "", title || "");
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.35;
  if (item.price != null) s += 0.10;
  if (item.image) s += 0.25;
  s += 0.30; // S33 entropy boost
  return Number(s.toFixed(2));
}

// TITAN Normalize
function normalizeResult(raw, query) {
  const title = raw.title || `Check-Up Paketi – ${query}`;
  const url = raw.url || "";
  const img = raw.image || null;

  const variants = buildImageVariants(img, "generic-checkup");

  const base = {
    id: stableId(title, url),
    title,
    price: raw.price ?? null,
    finalPrice: raw.price ?? null,
    optimizedPrice: raw.price ?? null,

    url,
    deeplink: url,

    provider: "generic_checkup",
    providerType: "health",
    providerFamily: "generic",
    providerSignature: "generic_checkup_s33",
    reliabilityScore: 0.72,
    adapterVersion: "S33.TITAN+",

    vertical: "health",
    category: "health",
    categoryAI: "health_checkup",

    currency: "TRY",
    region: "TR",

    image: variants.image,
    imageOriginal: variants.imageOriginal,
    imageProxy: variants.imageProxy,
    hasProxy: variants.hasProxy,

    raw,
  };

  return {
    ...base,
    qualityScore: computeQualityScore(base),
  };
}

// =======================================================================
// PRIMARY SCRAPER (S33)
// =======================================================================
export async function searchGenericCheckupAdapter(query = "", opts = {}) {
  const q = safe(query);
  const enc = encodeURIComponent(q);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);

  try {
    const url = `https://www.google.com/search?q=${enc}+checkup+paketi`;

    const { data: html } = await axios.get(url, {
      signal: controller.signal,
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123",
        Accept: "text/html",
      },
    });

    clearTimeout(timeout);

    const results = [];
    const regex = /<div class="BNeawe.*?">(.*?)<\/div>/gi;
    let match;

    while ((match = regex.exec(html))) {
      const title = safe(match[1].replace(/<\/?[^>]+>/g, ""));

      if (!title || title.length < 5) continue;

      const item = normalizeResult(
        {
          title,
          price: null,
          url: `https://www.google.com/search?q=${encodeURIComponent(title)}`,
          image: null,
        },
        q
      );

      results.push(item);
    }

    return results.slice(0, 40);
  } catch (err) {
    clearTimeout(timeout);
    return fallbackCheckup(query);
  }
}

// =======================================================================
// FALLBACK (S33 ULTRA)
// =======================================================================
export function fallbackCheckup(query = "") {
  const title = `Check-up bilgisine ulaşılamadı: ${query}`;
  const raw = { title, price: null, url: "", image: null };

  const base = normalizeResult(raw, query);

  return [
    {
      ...base,
      fallback: true,
      qualityScore: 0.10,
    },
  ];
}

export default {
  searchGenericCheckupAdapter,
  fallbackCheckup,
};

// =======================================================================
// S200 WRAPPED EXPORT — standard output { ok, items, count, source, _meta }
// =======================================================================
function _s200StripIds(x) {
  if (!x || typeof x !== "object") return x;
  const y = { ...x };
  delete y.id;
  delete y.listingId;
  return y;
}

function _s200NormalizeItems(arr, providerKey) {
  const out = [];
  const items = coerceItemsS200(arr);
  for (const it of items) {
    const clean = _s200StripIds(it);
    if (!clean) continue;
    if (true) {
      clean.price = null;
      clean.finalPrice = null;
      clean.optimizedPrice = null;
    }
    const norm = normalizeItemS200(clean, providerKey, { vertical: "health", category: "checkup", providerFamily: "discovery" });
    if (norm) out.push(norm);
  }
  return out;
}

export async function searchGenericCheckupAdapterS200(query, options = {}) {
  const startedAt = Date.now();
  const providerKey = "generic_checkup";
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { providerKey, adapter: "generic_checkup", query: typeof query === "string" ? query : "" };
  try {
    const raw = await withTimeout((searchGenericCheckupAdapter(query, options)), 6500, providerKey);
    const items = _s200NormalizeItems(raw, providerKey);
    return {
      ok: true,
      items,
      count: items.length,
      source: providerKey,
      _meta: { tookMs: Date.now() - startedAt, stub: false },
    };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e || "unknown");
    const isTimeout = (e && e.name === "TimeoutError") || /timed out|timeout/i.test(msg);
    if (FINDALLEASY_ALLOW_STUBS) {
      return {
        ok: true,
        items: [],
        count: 0,
        source: providerKey,
        _meta: { tookMs: Date.now() - startedAt, stub: true, error: msg, timeout: isTimeout },
      };
    }
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: { tookMs: Date.now() - startedAt, error: msg, timeout: isTimeout },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}
