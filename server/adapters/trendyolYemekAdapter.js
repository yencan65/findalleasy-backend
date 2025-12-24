// server/adapters/trendyolYemekAdapter.js
// ======================================================================
// Trendyol Yemek — S8 → S21 → S200 FINAL ADAPTER (HARDENED)
// ZERO DELETE — tüm eski fonksiyonlar korunur.
// Mutlak S200:
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title+url required; price<=0 => null
// - NO FAKE in PROD: stub/placeholder/random listing yasak
// - Observable fail: fetch/timeout => ok:false + items:[] + _meta.error/code
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - withTimeout everywhere; S200 ctx set
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
  fixKey,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = fixKey("trendyol_yemek");
const PROVIDER_FAMILY = "trendyol";
const BASE = "https://www.trendyol.com";

const DEFAULT_TIMEOUT_MS = 9000;

// --------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------
function safe(v) {
  return v ? String(v).trim() : "";
}

function parsePrice(txt) {
  if (!txt) return null;
  const n = Number(String(txt).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: legacy stable id helper (artık stableIdS200 kullanılıyor)
function buildStableId(href, title) {
  try {
    if (href) return "trendyol_yemek_" + Buffer.from(href).toString("base64");
    return "trendyol_yemek_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

async function fetchHTMLWithProxy(url, cfg) {
  try {
    const direct = await axios.get(url, cfg);
    return direct.data;
  } catch (e) {
    try {
      return await proxyFetchHTML(url);
    } catch {
      return null;
    }
  }
}

// ======================================================================
// S200 WRAPPER HELPERS
// ======================================================================
function mkS200(ok, items, meta = {}, extra = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    _meta: { ...meta },
    ...extra,
  };
  try {
    Object.defineProperty(res, Symbol.iterator, {
      enumerable: false,
      value: function* () {
        yield* res.items;
      },
    });
    Object.defineProperty(res, "length", {
      enumerable: false,
      get: () => res.items.length,
    });
  } catch {}
  return res;
}

function mkFail(code, err, meta = {}, extra = {}) {
  const msg = safeStr(err?.message || err || code);
  return mkS200(false, [], { ...meta, code, error: msg }, { ...extra, error: code });
}

// ======================================================================
// S200 NORMALIZER — kit-lock + provider canonical
// ======================================================================
function normalizeS200(item, region = "TR", category = "food") {
  if (!item) return null;

  const url = item.url || item.originUrl || null;
  const title = item.title || "";

  const affiliateUrl = item.affiliateUrl || item.deeplink || null;

  const base = {
    ...item,
    id: stableIdS200(PROVIDER_KEY, affiliateUrl || url, title),
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    source: PROVIDER_KEY,

    url: url,
    originUrl: item.originUrl || url,
    deeplink: affiliateUrl || url,
    affiliateUrl: affiliateUrl || url,

    currency: item.currency || "TRY",
    region: String(region || item.region || "TR").toUpperCase(),
    category: item.category || category,
    vertical: item.vertical || "food",
  };

  return normalizeItemS200(base, PROVIDER_KEY, {
    providerFamily: PROVIDER_FAMILY,
    baseUrl: BASE,
    currency: "TRY",
    region: base.region,
    category: base.category,
    vertical: base.vertical,
    discovery: false,
  });
}

// ======================================================================
// S21 ULTRA — SEARCH (returns array; wrapper uses it)
// ======================================================================
async function scrapeTrendyolYemekSearchRaw(query, regionOrOptions = "TR") {
  let region = "TR";
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
  }

  const q = safe(query);
  if (!q) return { ok: false, items: [], error: "empty_query" };

  const url = `${BASE}/yemek/sr?q=${encodeURIComponent(q)}`;

  const html = await fetchHTMLWithProxy(url, {
    timeout: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0 (FindAllEasy-S200) Chrome/122 Safari/537.36",
      "Accept-Language": "tr-TR",
    },
  });

  if (!html) return { ok: false, items: [], error: "fetch_failed" };

  const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url });
  const out = [];
  const qLower = q.toLowerCase();

  // ======================================================================
  // FOOD ITEMS
  // ======================================================================
  const productSelectors = [".product-card", ".p-card-wrppr", ".food-card", ".meal-card", ".menu-card"];

  $(productSelectors.join(",")).each((_, el) => {
    const title =
      safe($(el).find(".prdct-desc-cntnr-ttl").text()) ||
      safe($(el).find(".food-name").text()) ||
      safe($(el).find(".name").text());

    if (!title) return;
    if (!title.toLowerCase().includes(qLower)) return;

    const priceTxt =
      safe($(el).find(".prc-box-dscntd").text()) ||
      safe($(el).find(".prc-box-sllng").text()) ||
      safe($(el).find(".price").text());

    const rawPrice = parsePrice(priceTxt);

    const price = sanitizePrice(rawPrice, {
      provider: PROVIDER_KEY,
      category: "food",
    });

    let href = safe($(el).find("a").attr("href")) || safe($(el).find(".product-link").attr("href"));

    if (href && !href.startsWith("http")) href = BASE + href;

    let imgRaw = safe($(el).find("img").attr("data-src")) || safe($(el).find("img").attr("src"));
    if (imgRaw?.startsWith("//")) imgRaw = "https:" + imgRaw;

    const imageVariants = buildImageVariants(imgRaw || null, PROVIDER_KEY);

    let affiliateUrl = null;
    try {
      affiliateUrl = buildAffiliateUrlS10({ url: href, provider: PROVIDER_KEY });
    } catch {
      affiliateUrl = href || null;
    }

    let item = {
      id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, title),
      title,
      price,
      priceText: priceTxt,

      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerFamily: PROVIDER_FAMILY,
      category: "food",
      vertical: "food",
      currency: "TRY",
      region: String(region).toUpperCase(),

      url: href || `${BASE}/yemek`,
      originUrl: href || `${BASE}/yemek`,
      affiliateUrl,
      deeplink: affiliateUrl,

      rating: null,

      image: imageVariants.image,
      imageOriginal: imageVariants.imageOriginal,
      imageProxy: imageVariants.imageProxy,
      hasProxy: imageVariants.hasProxy,

      raw: { title, priceTxt, href, imgRaw },
    };

    try {
      item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "food" });
    } catch {}

    const n = normalizeS200(item, region, "food");
    if (n) out.push(n);
  });

  // ======================================================================
  // RESTAURANTS
  // ======================================================================
  const restaurantSelectors = [".restaurant-card", ".r-card", ".seller-card", ".restaurant-item"];

  $(restaurantSelectors.join(",")).each((_, el) => {
    const name =
      safe($(el).find(".restaurant-name").text()) ||
      safe($(el).find(".seller-name").text()) ||
      safe($(el).find(".name").text());

    if (!name) return;
    if (!name.toLowerCase().includes(qLower)) return;

    const ratingTxt = safe($(el).find(".rating").text()) || safe($(el).find(".score").text());
    const rating = Number(ratingTxt) || null;

    let href = safe($(el).find("a").attr("href")) || safe($(el).find(".restaurant-link").attr("href"));
    if (href && !href.startsWith("http")) href = BASE + href;

    let affiliateUrl = null;
    try {
      affiliateUrl = buildAffiliateUrlS10({ url: href, provider: PROVIDER_KEY });
    } catch {
      affiliateUrl = href || null;
    }

    let rawItem = {
      id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, name),
      title: name,
      price: null,
      priceText: null,
      rating,

      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerFamily: PROVIDER_FAMILY,
      category: "restaurant",
      vertical: "restaurant",
      currency: "TRY",
      region: String(region).toUpperCase(),

      url: href || `${BASE}/yemek`,
      originUrl: href || `${BASE}/yemek`,
      affiliateUrl,
      deeplink: affiliateUrl,

      image: null,
      imageProxy: null,
      imageOriginal: null,
      hasProxy: false,

      raw: { name, rating, href },
    };

    try {
      rawItem = optimizePrice(rawItem, { provider: PROVIDER_KEY, region, category: "restaurant" });
    } catch {}

    const n = normalizeS200(rawItem, region, "restaurant");
    if (n) out.push(n);
  });

  return { ok: true, items: out.slice(0, 120) };
}

// ======================================================================
// FALLBACK (real page parse) — returns array; wrapper uses it
// ======================================================================
async function scrapeTrendyolYemekFallbackRaw(query, regionOrOptions = "TR") {
  let region = "TR";
  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions?.region) region = regionOrOptions.region;

  const q = safe(query);
  if (!q) return { ok: false, items: [], error: "empty_query" };

  const url = `${BASE}/yemek`;

  const html = await fetchHTMLWithProxy(url, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
  });

  if (!html) return { ok: false, items: [], error: "fetch_failed" };

  const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url });
  const qLower = q.toLowerCase();
  const out = [];

  $(".product-card .prdct-desc-cntnr-ttl, .food-name, .restaurant-name").each((_, el) => {
    const title = safe($(el).text());
    if (!title) return;
    if (!title.toLowerCase().includes(qLower)) return;

    const item = normalizeS200(
      {
        id: stableIdS200(PROVIDER_KEY, url, title),
        title,
        price: null,

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,
        category: "food",
        vertical: "food",
        currency: "TRY",
        region: String(region).toUpperCase(),

        url,
        originUrl: url,
        affiliateUrl: null,
        deeplink: null,

        image: null,
        hasProxy: false,

        raw: { title, fallback: true },
      },
      region,
      "food"
    );

    if (item) out.push(item);
  });

  return { ok: true, items: out.slice(0, 60) };
}

// ======================================================================
// UNIFIED ADAPTER (S200 wrapper)
// ======================================================================
export async function searchTrendyolYemekAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const region =
    typeof regionOrOptions === "string"
      ? regionOrOptions
      : (regionOrOptions?.region || "TR");
  const reg = String(region || "TR").toUpperCase();

  const q = safe(query);
  if (!q) return mkFail("EMPTY_QUERY", "empty_query", { region: reg, ms: 0 });

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, query: q, region: reg };

  try {
    const res = await withTimeout(
      (async () => {
        const r1 = await scrapeTrendyolYemekSearchRaw(q, regionOrOptions);
        if (r1.ok) return mkS200(true, r1.items || [], { region: reg, mode: "search", ms: Date.now() - t0 });

        // observable fail on first fetch fail: ok:false
        const r2 = await scrapeTrendyolYemekFallbackRaw(q, regionOrOptions);
        if (r2.ok) return mkS200(true, r2.items || [], { region: reg, mode: "fallback", ms: Date.now() - t0 });

        return mkFail("FETCH_FAIL", r1.error || r2.error || "fetch_failed", { region: reg, ms: Date.now() - t0 });
      })(),
      DEFAULT_TIMEOUT_MS,
      PROVIDER_KEY
    );

    return res;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return mkFail(isTimeout ? "TIMEOUT" : "ERROR", e, { region: reg, timeout: isTimeout, ms: Date.now() - t0 });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// Preserve legacy exports (ZERO DELETE)
export async function scrapeTrendyolYemekSearch(query, regionOrOptions = "TR") {
  const r = await searchTrendyolYemekAdapter(query, regionOrOptions);
  // for older calls expecting array, they should use r.items; but return wrapper now (S200 rule)
  return r;
}

export async function scrapeTrendyolYemekFallback(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const region =
    typeof regionOrOptions === "string"
      ? regionOrOptions
      : (regionOrOptions?.region || "TR");
  const reg = String(region || "TR").toUpperCase();

  try {
    const r = await withTimeout(scrapeTrendyolYemekFallbackRaw(query, regionOrOptions), DEFAULT_TIMEOUT_MS, PROVIDER_KEY);
    if (!r.ok) return mkFail("FETCH_FAIL", r.error || "fetch_failed", { region: reg, mode: "fallback", ms: Date.now() - t0 });
    return mkS200(true, r.items || [], { region: reg, mode: "fallback", ms: Date.now() - t0 });
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return mkFail(isTimeout ? "TIMEOUT" : "ERROR", e, { region: reg, timeout: isTimeout, ms: Date.now() - t0 });
  }
}

export default {
  searchTrendyolYemekAdapter,
  scrapeTrendyolYemekSearch,
  scrapeTrendyolYemekFallback,
};
