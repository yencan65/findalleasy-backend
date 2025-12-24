// ============================================================================
//  LIV HOSPITAL — S22 ULTRA TITAN ADAPTER (FINAL VERSION)
// ----------------------------------------------------------------------------
//  ZERO DELETE — eski regex fallback korunur, üstüne Titan-grade kaplama eklenir
// ----------------------------------------------------------------------------
//  • proxyFetchHTML anti-bot bypass
//  • stableId (Merge Engine + Vitrin uyumlu)
//  • sanitizePrice + optimizePrice
//  • ImageVariants S22
//  • categoryAI("health")
//  • geoSignal extraction
//  • qualityScore
//  • signal / abort → tam destek
//  • fallback ultra güvenli
// ============================================================================

import axios from "axios";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { coerceItemsS200, fixKey, normalizeItemS200, withTimeout } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";


// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
const safe = (v) => (v == null ? "" : String(v).trim());

function stableId(seed, i = 0) {
  return "liv_" + Buffer.from(seed + "_" + i).toString("base64").slice(0, 14);
}

function parsePriceRaw(txt) {
  if (!txt) return null;
  return Number(txt.replace(/[^\d.,]/g, "").replace(",", "."));
}

function extractGeoSignal(title = "") {
  const t = title.toLowerCase();
  const cities = ["istanbul", "ankara", "izmir", "antalya", "bursa"];
  return cities.find((c) => t.includes(c)) || null;
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title?.length > 4) s += 0.4;
  if (item.image) s += 0.4;
  if (item.price != null) s += 0.2;
  return Number(s.toFixed(2));
}

// ------------------------------------------------------------
//  TITAN SCRAPER (Regex değil, proxy + pattern scanning)
// ------------------------------------------------------------
async function titanScrapeLiv(query, region, signal) {
  const q = encodeURIComponent(query.trim());
  const url = `https://www.livhospital.com.tr/search?term=${q}`;

  let html = null;

  // Anti-bot → önce proxy dene
  try {
    html = await proxyFetchHTML(url);
  } catch {
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S22)",
        },
      });
      html = data;
    } catch {
      return [
        {
          provider: "liv",
          title: "Liv Hospital erişilemedi",
          price: null,
          optimizedPrice: null,
          category: "health",
          region,
          fallback: true,
        },
      ];
    }
  }

  // ------------------------------------------------------------
  // Kart yakalama – tüm Liv ürün / hizmet / checkup kartları
  // ------------------------------------------------------------
  const cardRegex =
    /<a[^>]*href="(.*?)"[^>]*class="[^"]*(product-card|card|treatment|service)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const items = [];
  let match;

  while ((match = cardRegex.exec(html))) {
    const hrefRaw = match[1];
    const block = match[3];

    const titleMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/i);
    const priceMatch = block.match(/(\d[\d.,]+)\s?(TL|₺)/i);
    const imgMatch = block.match(/<img[^>]*src="(.*?)"/i);

    const title = titleMatch ? titleMatch[1].trim() : "Liv Hospital";

    const href = hrefRaw.startsWith("http")
      ? hrefRaw
      : "https://www.livhospital.com.tr" + hrefRaw;

    const imgRaw = imgMatch ? imgMatch[1] : null;
    const image = buildImageVariants(imgRaw);

    const priceRaw = priceMatch ? priceMatch[1] : null;
    const price = sanitizePrice(parsePriceRaw(priceRaw));
    const optimizedPrice = optimizePrice({ price }, { provider: "liv" });

    const id = stableId(href, items.length);

    const geoSignal = extractGeoSignal(title);
    const qualityScore = computeQualityScore({ title, image: imgRaw, price });

    items.push({
      id,
      provider: "liv",
      source: "liv",

      title,
      price,
      optimizedPrice,
      rating: null,

      category: "health",
      categoryAI: "health",
      geoSignal,
      qualityScore,

      currency: "TRY",
      region,

      url: href,
      deeplink: href,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      fallback: false,

      raw: {
        title,
        href,
        imgRaw,
        priceRaw,
      },
    });
  }

  if (items.length === 0) {
    return [
      {
        provider: "liv",
        title: `Liv Hospital sonuç bulunamadı (${query})`,
        price: null,
        optimizedPrice: null,
        category: "health",
        region,
        fallback: true,
      },
    ];
  }

  return items;
}

// ------------------------------------------------------------
//  PUBLIC ADAPTER — S22 FORMAT
// ------------------------------------------------------------
async function searchLivAdapterLegacy(query = "", opts = {}) {
  const region = opts.region || "TR";
  const signal = opts.signal || null;

  try {
    const items = await titanScrapeLiv(query, region.toUpperCase(), signal);

    return {
      ok: true,
      adapterName: "liv",
      items,
      count: items.length,
    };
  } catch (err) {
    return {
      ok: false,
      adapterName: "liv",
      items: [],
      count: 0,
      error: err?.message || "unknown",
    };
  }
}

// S8–S10 eski export uyumluluğu kırılmaz

// ============================================================================
// S200 WRAPPER — FINAL (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================

function _s200ResolveRegionSignal(regionOrOptions, fallbackRegion = "TR") {
  let region = fallbackRegion;
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || fallbackRegion;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || regionOrOptions.locale || fallbackRegion;
    signal = regionOrOptions.signal || null;
  }

  return { region: String(region || fallbackRegion).toUpperCase(), signal };
}

function _s200IsTimeout(e) {
  const n = String(e?.name || "").toLowerCase();
  const m = String(e?.message || "").toLowerCase();
  return n.includes("timeout") || m.includes("timed out");
}

function _s200IsFake(it) {
  if (!it || typeof it !== "object") return false;
  if (it.fallback === true || it.mock === true) return true;

  const u = String(it.affiliateUrl || it.deeplink || it.finalUrl || it.originUrl || it.url || "");
  if (!u) return false;

  if (u.includes("findalleasy.com/mock")) return true;
  return false;
}

export async function searchLivAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const { region, signal } = _s200ResolveRegionSignal(regionOrOptions, "TR");

  globalThis.__S200_ADAPTER_CTX = {
adapter: "liv",
    providerKey: "liv",
    source: "liv",  region,
  };
  try {
    const legacyOut = await withTimeout(
      searchLivAdapterLegacy(query, typeof regionOrOptions === "object" ? { region, signal } : { region }),
      6500,
      "liv"
    );

    const rawItems = coerceItemsS200(legacyOut);
    const rawCount = Array.isArray(rawItems) ? rawItems.length : 0;

    const blocked = !FINDALLEASY_ALLOW_STUBS && rawItems.some(_s200IsFake);
    const filtered = blocked ? [] : rawItems;

    const normalized = filtered
      .map((it) => {
        if (!it || typeof it !== "object") return null;

        const copy = { ...it };
        delete copy.id;
        delete copy.listingId;

        const pk = "liv";

        return normalizeItemS200(copy, pk, {
          providerFamily: "health",
          vertical: "health",
          category: "health",
          region,
        });
      })
      .filter(Boolean);

    const meta = {
      adapter: "liv",
      providerKey: "liv",
      source: "liv",
      region,
      ms: Date.now() - t0,
      allowStubs: FINDALLEASY_ALLOW_STUBS,
      legacyOk: legacyOut && typeof legacyOut === "object" ? legacyOut.ok : undefined,
      rawCount,
      normalizedCount: normalized.length,
      stubBlocked: blocked,
    };
    if (blocked) {
      return { ok: false, items: [], count: 0, source: "liv", _meta: { ...meta, error: "stub_blocked" } };
    }

    if (legacyOut && typeof legacyOut === "object" && legacyOut.ok === false) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: "liv",
        _meta: {
          ...meta,
          timeout: !!legacyOut.timeout,
          error: legacyOut.error || legacyOut.errorMessage || "legacy_fail",
        }
      };
    }

    return { ok: true, items: normalized, count: normalized.length, source: "liv", _meta: meta };
  } catch (e) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: "liv",
      _meta: {
        adapter: "liv",
        providerKey: "liv",
        source: "liv",
        region,
        ms: Date.now() - t0,
        allowStubs: FINDALLEASY_ALLOW_STUBS,
        timeout: _s200IsTimeout(e),
        error: e?.message || String(e),
      }
    };
  }
}

export const searchLiv = searchLivAdapter;
export const searchLivScrape = searchLivAdapter;

export default {
  searchLiv,
  searchLivScrape,
  searchLivAdapter,
  searchLivAdapterLegacy
};
