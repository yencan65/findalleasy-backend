// server/adapters/expediaAdapter.js
// ======================================================================
// EXPEDIA — S33 TITAN+ EDITION (FINAL)
// Zero Delete — eski fonksiyonlar / alias'lar korunur, çekirdek TITAN+ modüller eklenir.
// ----------------------------------------------------------------------
// • stableId v3.5 (slug + urlHash + entropy)
// • ImageVariants FULL (proxy-safe)
// • optimizedPrice + finalPrice
// • QualityScore S33 (hotel-weighted)
// • categoryAI: "hotel"
// • location + rating normalize
// • Multi-page S33
// • fallback (TITAN SAFE)
// • providerSignature + adapterVersion
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";
import { loadCheerioS200, coerceItemsS200, normalizeItemS200, priceOrNullS200, stableIdS200, withTimeout } from "../core/s200AdapterKit.js";
// ----------------------------------------------------------------------
// STUB POLICY (HARD) — NO FAKE RESULTS IN PROD
// ----------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _s200HttpInfo(err) {
  const status = err?.status || err?.response?.status || null;
  const code =
    status === 429 ? "HTTP_429" :
    status === 403 ? "HTTP_403" :
    status === 404 ? "HTTP_404" :
    status ? `HTTP_${status}` : "HTTP_ERR";
  const blocked = status === 403;
  const rateLimited = status === 429;
  const notFound = status === 404;
  return { status, code, blocked, rateLimited, notFound };
}

function _s200AttachMetaArray(arr, patch = {}) {
  if (!Array.isArray(arr)) return arr;
  try {
    const prev = (arr._meta && typeof arr._meta === "object") ? arr._meta : {};
    Object.defineProperty(arr, "_meta", { value: { ...prev, ...patch }, enumerable: false });
  } catch {}
  return arr;
}

function _s200FailArray(source, patchMeta = {}) {
  const a = [];
  try {
    Object.defineProperty(a, "ok", { value: false, enumerable: false });
    Object.defineProperty(a, "_meta", { value: { source, ...patchMeta }, enumerable: false });
  } catch {}
  return a;
}

// ------------------------------------------------------------
// HELPERS — S33 LEVEL
// ------------------------------------------------------------
async function checkRateLimit() {
  const key = "adapter_expedia_TR";

  const allowed = await rateLimiter.check(key, {
    limit: 20,
    windowMs: 60000,
    burst: true,
    adaptive: true
  });

  if (!allowed) {
    console.warn("⛔ Expedia rate limit aşıldı");
    throw new Error("Rate limit exceeded for expedia adapter");
  }

  return true;
}

const safe = (v) => (v ? String(v).trim() : "");

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
}

function stableId(title, href) {
  // S200 deterministic stable id (NO RANDOM)
  return stableIdS200("expedia", href || "", title || "expedia");
}

function parsePriceStrong(txt) {
  if (!txt) return null;
  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function extractImage($, el) {
  let img =
    safe($(el).find("img").attr("src")) ||
    safe($(el).find("img").attr("data-src")) ||
    safe($(el).find("source").attr("srcset"));
  if (img?.includes(" ")) img = img.split(" ")[0];
  return img || null;
}

function extractLocation($, el) {
  const loc =
    safe($(el).find("[data-stid='property-location']").text()) ||
    safe($(el).find(".uitk-text-secondary-theme").text());
  return loc || null;
}

function extractRating($, el) {
  const r =
    safe($(el).find("[data-stid='review-score']").text()) ||
    safe($(el).find(".uitk-badge-base").text());
  const n = Number(r.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function categoryAI() {
  return "hotel";
}

// ------------------------------------------------------------
// Quality Score — S33 HOTEL WEIGHTING
// ------------------------------------------------------------
function computeQualityScore(item) {
  let s = 0;

  if (item.title) s += 0.30;
  if (item.price != null) s += 0.25;
  if (item.image) s += 0.25;
  if (item.rating != null) s += 0.10;
  if (item.location) s += 0.05;

  s += 0.05; // entropy boost
  return Number(s.toFixed(2));
}

// ------------------------------------------------------------
// TITAN NORMALIZER
// ------------------------------------------------------------
function normalizeExpediaItem(raw, region, query) {
  const title = raw.title || `Expedia Hotel — ${query}`;
  const url = raw.url || "";
  const price = parsePriceStrong(raw.price);
  const img = raw.image;

  const id = stableId(title, url);
  const imageData = buildImageVariants(img, "expedia");

  const baseItem = {
    id,
    title,

    // Price fields
    price,
    finalPrice: price,
    optimizedPrice: price,

    rating: raw.rating ?? null,

    // URL fields (CORE)
    originUrl: url,
    finalUrl: url,
    deeplink: url,
    url,

    provider: "expedia",
    currency: "USD",
    region: region.toUpperCase(),
    category: "travel",
    adapterSource: "expediaAdapter",

    raw: {
      title,
      price,
      rating: raw.rating ?? null,
      url,

      // URL fields in raw
      originUrl: url,
      finalUrl: url,
      deeplink: url,

      // Price fields in raw
      finalPrice: price,
      optimizedPrice: price,

      location: raw.location || null,

      providerType: "hotel",
      providerFamily: "expedia",
      providerSignature: "expedia_s33",
      adapterVersion: "S33.TITAN+",
      reliabilityScore: 0.91,
      vertical: "hotel",
      categoryAI: categoryAI(),

      image: imageData.image,
      imageOriginal: imageData.imageOriginal,
      imageProxy: imageData.imageProxy,
      hasProxy: imageData.hasProxy,

      qualityScore: computeQualityScore({
        title,
        price,
        image: raw.image,
        rating: raw.rating,
        location: raw.location
      }),

      rawData: raw.raw || raw
    }
  };

  return baseItem;
}


// ------------------------------------------------------------
// SCRAPER — MULTI PAGE S33
// ------------------------------------------------------------
async function scrapeExpediaPage(query, region, signal, page = 1) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.expedia.com/Hotel-Search?destination=${q}&page=${page}`;

    const res = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/125",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const $ = loadCheerioS200(res.data);
    const items = [];

    const selectors = [
      ".uitk-card-content-section",
      ".uitk-spacing-padding-blockend-three",
      ".uitk-layout-flex-item",
      "div[data-stid='property-listing']",
      "li[data-stid='result-item']",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find("[data-stid='content-hotel-title']").text()) ||
        safe(wrap.find("h3").text());
      if (!title) return;

      const priceTxt =
        safe(wrap.find("[data-stid='price-lockup-text']").text()) ||
        safe(wrap.find(".uitk-text-emphasis-theme").text()) ||
        safe(wrap.find(".uitk-text-bold").text());

      let href =
        safe(wrap.find("a[data-stid='property-name']").attr("href")) ||
        safe(wrap.find("a").attr("href"));
      if (!href) return;
      if (!href.startsWith("http"))
        href = "https://www.expedia.com" + href;

      const raw = {
        title,
        price: priceTxt,
        rating: extractRating(wrap, $),
        location: extractLocation(wrap, $),
        image: extractImage(wrap, $),
        url: href,
      };

      items.push(normalizeExpediaItem(raw, region, query));
    });

    return items;
  } catch (err) {
    const info = _s200HttpInfo(err);
    // Let outer layers decide fallback/ok status.
    const e = err instanceof Error ? err : new Error(String(err));
    try { e.status = info.status; e.code = info.code; } catch {}
    throw e;
  }
}

// Multi page
async function scrapeExpediaMulti(query, region, signal) {
  let all = [];
  let lastLen = null;
  let warn = null;

  for (let page = 1; page <= 3; page++) {
    try {
      const part = await scrapeExpediaPage(query, region, signal, page);
      if (!part.length) break;

      if (lastLen !== null && part.length === lastLen) break;
      lastLen = part.length;

      all.push(...part);
    } catch (err) {
      const info = _s200HttpInfo(err);
      // If we already have items, treat this as partial success and stop paging.
      if (all.length > 0) {
        warn = {
          where: "scrapeExpediaMulti",
          page,
          status: info.status,
          code: info.code,
          error: err?.message || String(err),
        };
        break;
      }
      // No items yet -> bubble up so caller can decide fallback/ok:false.
      throw err;
    }
  }

  if (warn) _s200AttachMetaArray(all, { partialFail: true, warn });

  return all.slice(0, 60);
}

// ------------------------------------------------------------
// FALLBACK — TITAN SAFE
// ------------------------------------------------------------
function fallbackExpedia(query, region) {
  const info = {
    source: "expedia",
    fallback: true,
    region: String(region || "TR").toUpperCase(),
    query: String(query || ""),
  };

  // PROD: NO FAKE LISTINGS. Return observable fail array.
  if (!FINDALLEASY_ALLOW_STUBS) {
    return _s200FailArray("expedia", {
      ...info,
      code: "FALLBACK_DISABLED",
      error: "No real Expedia results and stubs are disabled",
    });
  }

  // DEV ONLY (stubs allowed): one clearly marked placeholder.
  const raw = {
    title: `Expedia (stub) — sonuç yok: ${query}`,
    price: null,
    rating: null,
    location: null,
    url: "https://www.expedia.com",
    image: null,
    fallback: true,
  };

  const item = normalizeExpediaItem(raw, info.region, info.query);
  if (item?.raw) item.raw.qualityScore = 0.05;
  if (item) item.fallback = true;
  const arr = item ? [item] : [];
  return _s200AttachMetaArray(arr, { ...info, stub: true });
}

// ------------------------------------------------------------
// MAIN ADAPTER
// ------------------------------------------------------------
export async function searchExpediaAdapterItems(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object" && regionOrOptions) {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  const q = String(query || "");

  try {
    await checkRateLimit(); // ZORUNLU
    const results = await scrapeExpediaMulti(q, region, signal);

    if (Array.isArray(results) && results.length > 0) return results;

    const fb = fallbackExpedia(q, region);
    return _s200AttachMetaArray(fb, { noResults: true });
  } catch (err) {
    const info = _s200HttpInfo(err);
    console.warn("⚠️ ExpediaAdapter error:", err?.message || String(err));
    const fb = fallbackExpedia(q, region);
    return _s200AttachMetaArray(fb, {
      failed: true,
      cause: { status: info.status, code: info.code, error: err?.message || String(err) },
    });
  }
}

// ------------------------------------------------------------
// ALIAS — ZERO DELETE
// ------------------------------------------------------------
// ======================================================================
// S200 WRAPPER (observable fail, contract lock, deterministic id)
// ======================================================================
function _s200NormalizeList(out, providerKey, opts = {}) {
  const arr = coerceItemsS200(out);
  const res = [];
  for (const it of arr) {
    if (!it) continue;
    const clean = { ...it };
    delete clean.id;
    delete clean.listingId;
    if ("price" in clean) clean.price = priceOrNullS200(clean.price);
    const n = normalizeItemS200(clean, providerKey, opts);
    if (n) res.push(n);
  }
  return res;
}

export async function searchExpediaAdapter(query, options = {}) {
  const providerKey = "expedia";
  const started = Date.now();
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "expediaAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  try {
    const t = Number(options?.timeoutMs || options?.timeout || 6500);
    const raw = await withTimeout(
      searchExpediaAdapterItems(query, options),
      t,
      `${providerKey}_items`
    );

    const region = String(options?.region || "TR").toUpperCase();
    const items = _s200NormalizeList(raw, providerKey, {
      vertical: "travel",
      category: "travel",
      region,
    });

    const rawMeta = (raw && typeof raw === "object") ? raw._meta : null;
    const upstreamFail = raw?.ok === false || rawMeta?.failed === true;

    const ok = !(upstreamFail && items.length === 0);
    const meta = {
      tookMs: Date.now() - started,
      region,
      upstreamFail,
      ...(rawMeta ? { upstream: rawMeta } : {}),
      ...(upstreamFail && items.length > 0 ? { partialFail: true } : {}),
    };

    return { ok, items, count: items.length, source: providerKey, _meta: meta };
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = err?.name === "TimeoutError" || /timed out/i.test(msg);
    const info = _s200HttpInfo(err);
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: {
        tookMs: Date.now() - started,
        error: msg,
        timeout: isTimeout,
        status: info.status,
        code: info.code,
      },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchExpedia = searchExpediaAdapter;
export const searchExpediaScrape = scrapeExpediaMulti;

export default {
  searchExpedia,
  searchExpediaScrape,
  searchExpediaAdapter,
};
