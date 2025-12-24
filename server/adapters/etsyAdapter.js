// server/adapters/etsyAdapter.js
// ======================================================================
// ETSY — S33 TITAN+ EDITION (FINAL)
// Zero Delete — API + Scrape korunur, output yapısı TITAN standardına çekilir
// Rate Limiter uyumlu (ana motor ile entegre)
// ----------------------------------------------------------------------
// • stableId v3.5 (slug + urlHash + entropy6)
// • ImageVariants FULL
// • Price normalize → finalPrice + optimizedPrice
// • qualityScore S33 product-weighted
// • categoryAI = "handmade" (Etsy signature)
// • providerSignature + adapterVersion + reliabilityScore
// • API + Scrape çıktıları %100 aynı normalize formata sokulur
// • Multi-page S33
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200, coerceItemsS200, normalizeItemS200, priceOrNullS200, stableIdS200, withTimeout } from "../core/s200AdapterKit.js";

const ETSY_API_KEY = process.env.ETSY_API_KEY || "";
const ETSY_AFFILIATE_PID = process.env.ETSY_AFFILIATE_PID || "";

// ======================= RATE LIMITER =======================
async function checkRateLimit(source = "etsy") {
  const key = `adapter_${source}_TR`;
  const allowed = await rateLimiter.check(key, {
    limit: 18,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → ${source}`);
    throw new Error(`Rate limit exceeded for ${source}`);
  }
  
  return true;
}

// Kaynak başarısını kaydet
function registerSourceSuccess(source) {
  rateLimiter.registerSuccess(`adapter_${source}_TR`, 1);
}

// Kaynak hatasını kaydet
function registerSourceError(source) {
  rateLimiter.registerError(`adapter_${source}_TR`, 1);
}

// ======================= HELPERS (TITAN S33 LEVEL) =======================
const safe = (v) => (v ? String(v).trim() : "");

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
}

function stableId(title, href) {
  // S200 deterministic stable id (NO RANDOM)
  return stableIdS200("etsy", href || "", title || "etsy");
}

function parsePriceStrong(txt) {
  if (!txt) return null;

  const low = txt.toLowerCase();
  if (low.includes("free") || low.includes("ücretsiz")) return 0;

  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeCurrency(txt) {
  if (!txt) return "USD";
  if (txt.includes("₺") || txt.includes("TL")) return "TRY";
  if (txt.includes("€")) return "EUR";
  if (txt.includes("$")) return "USD";
  return "USD";
}

function computeQualityScore(item) {
  let s = 0;

  if (item.title) s += 0.25;
  if (item.price != null) s += 0.25;
  if (item.image) s += 0.25;
  if (item.shop_name) s += 0.10;
  if (item.rating != null) s += 0.05;

  s += 0.10; // entropy boost
  return Number(s.toFixed(2));
}

function categoryAI() {
  return "handmade";
}

// ======================= NORMALIZER — Ana motor uyumlu =======================
function normalizeEtsyItem(raw, region, query) {
  const title = raw.title || `Etsy – ${query}`;
  const price = parsePriceStrong(raw.price);
  const url = raw.url;

  const id = stableId(title, url);
  const img = buildImageVariants(raw.image, "etsy");

  // Ana motorun normalizeItem fonksiyonu ile uyumlu temel yapı
  const baseItem = {
  id,
  title,

  // S200 URL STANDARD
  originUrl: url,
  finalUrl: url,
  deeplink: url,
  url,

  // PRICE PIPELINE — ZORUNLU ÜÇLÜ
  price: price,
  finalPrice: price,
  optimizedPrice: price,

  rating: raw.rating ?? null,
  provider: "etsy",

  // IMAGE FIELDS — ZORUNLU DÖRTLÜ
  image: img.image,
  imageOriginal: img.imageOriginal,
  imageProxy: img.imageProxy,
  hasProxy: img.hasProxy,

  currency: raw.currency || "USD",
  region: region.toUpperCase(),
  category: "product",
  adapterSource: "etsyAdapter",

  raw: {
    title,
    price,
    rating: raw.rating ?? null,
    url,

    shop_name: raw.shop_name || null,
    shop_sales: raw.shop_sales || null,

    providerType: "product",
    providerFamily: "etsy",
    providerSignature: "etsy_s33",
    adapterVersion: "S33.TITAN+",
    reliabilityScore: 0.84,
    vertical: "product",
    categoryAI: categoryAI(),

    finalPrice: price,
    optimizedPrice: price,

    image: img.image,
    imageOriginal: img.imageOriginal,
    imageProxy: img.imageProxy,
    hasProxy: img.hasProxy,

    qualityScore: computeQualityScore({
      title,
      price,
      image: raw.image,
      shop_name: raw.shop_name,
      rating: raw.rating
    }),

    rawData: raw.raw || raw
  }
};


  return baseItem;
}

// ======================= 1) ETSY OFFICIAL API =======================
export async function searchEtsy(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  if (!ETSY_API_KEY || !ETSY_AFFILIATE_PID) {
    console.warn("⚠️ Etsy API env yok → scrape fallback");
    return [];
  }

  const q = safe(query);
  if (!q) return [];

  try {
    // Rate limiter kontrolü (API için)
    await checkRateLimit("etsy_api");
    
    const url = `https://openapi.etsy.com/v3/application/listings/active`;

    const { data } = await axios.get(url, {
      signal,
      timeout: 15000,
      headers: { "X-Api-Key": ETSY_API_KEY },
      params: {
        keywords: q,
        limit: 40,
        sort_on: "score",
        sort_order: "desc",
        includes: "images,shop",
      },
    });

    const items = data?.results || [];

    const normalized = items.map((p) =>
      normalizeEtsyItem(
        {
          title: p.title,
          price: p.price?.amount ? p.price.amount / 100 : null,
          rating: p.shop_rating || null,
          currency: p.price?.currency_code || "USD",
          image:
            p.images?.[0]?.url_fullxfull ||
            p.images?.[0]?.url_570xN ||
            null,
          shop_name: p.Shop?.shop_name || null,
          shop_sales: p.Shop?.transaction_sold_count || null,
          url: `${p.url}?pid=${ETSY_AFFILIATE_PID}`,
        },
        region,
        query
      )
    );

    registerSourceSuccess("etsy_api");
    return normalized;
  } catch (err) {
    if (err.message.includes("Rate limit exceeded")) {
      throw err;
    }
    registerSourceError("etsy_api");
    if (err?.name === "AbortError") return [];
    console.warn("⚠️ Etsy API hata:", err.message);
    return [];
  }
}

// ======================= 2) SCRAPE FALLBACK =======================
async function scrapeSinglePage(query, region, signal, page = 1) {
  try {
    // Rate limiter kontrolü (scrape için)
    await checkRateLimit("etsy_scrape");
    
    const q = encodeURIComponent(query);
    const link =
      page === 1
        ? `https://www.etsy.com/search?q=${q}`
        : `https://www.etsy.com/search?q=${q}&page=${page}`;

    const { data: html } = await axios.get(link, {
      signal,
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/124",
      },
    });

    const $ = loadCheerioS200(html);
    const items = [];

    const selectors = [
      ".v2-listing-card",
      ".wt-grid__item-xs-6",
      "li.wt-list-unstyled",
      ".wt-card",
      ".wt-list-row__item",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find("h3").text()) ||
        safe(wrap.find(".v2-listing-card__title").text()) ||
        safe(wrap.find(".wt-text-truncate").text());
      if (!title) return;

      const priceTxt =
        safe(wrap.find(".currency-value").text()) ||
        safe(wrap.find(".v2-listing-card__price").text()) ||
        safe(wrap.find(".wt-text-title-03").text());

      const price = parsePriceStrong(priceTxt);

      let href =
        wrap.find("a").attr("href") ||
        wrap.find(".v2-listing-card__info a").attr("href");
      if (!href) return;

      if (!href.startsWith("http")) href = "https://www.etsy.com" + href;

      const img =
        safe(wrap.find("img").attr("src")) ||
        safe(wrap.find("img").attr("data-src")) ||
        null;

      const shopName = safe(wrap.find(".shop-name").text());
      const shopSales = safe(wrap.find(".shop-sales").text());

      items.push(
        normalizeEtsyItem(
          {
            title,
            price,
            image: img,
            shop_name: shopName || null,
            shop_sales: shopSales || null,
            rating: null,
            currency: normalizeCurrency(priceTxt),
            url: href,
          },
          region,
          query
        )
      );
    });

    registerSourceSuccess("etsy_scrape");
    return items;
  } catch (err) {
    if (err.message.includes("Rate limit exceeded")) {
      throw err;
    }
    registerSourceError("etsy_scrape");
    if (err?.name === "AbortError") return [];
    console.warn("⚠️ Etsy scrape hata:", err.message);
    return [];
  }
}

async function scrapeEtsyPages(query, region, signal) {
  let all = [];
  let last = null;

  for (let page = 1; page <= 3; page++) {
    const part = await scrapeSinglePage(query, region, signal, page);
    if (!part.length) break;
    if (last !== null && part.length === last) break;

    last = part.length;
    all.push(...part);
  }

  return all.slice(0, 80);
}

// ======================= 3) UNIFIED ADAPTER — Ana motor uyumlu =======================
export async function searchEtsyAdapterItems(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  try {
    // Ana adapter için rate limiter kontrolü
    await checkRateLimit("etsy");
    
    // Önce API'yi dene
    const apiResults = await searchEtsy(query, { region, signal });
    if (apiResults.length > 0) {
      registerSourceSuccess("etsy");
      return apiResults;
    }

    // API yoksa scrape et
    const scrapeResults = await scrapeEtsyPages(query, region, signal);
    
    // Başarılı isteği kaydet
    registerSourceSuccess("etsy");
    
    return scrapeResults;
  } catch (err) {
    // Hata durumunda rate limiter'a bildir
    if (!err.message.includes("Rate limit exceeded")) {
      registerSourceError("etsy");
    }
    
    console.warn("⚠️ EtsyAdapter genel hata:", err.message);
    return [];
  }
}

// ======================================================================
// S200 WRAPPER (observable fail, contract lock, deterministic id)
// ======================================================================
function _s200IsProd() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.FINDALLEASY_ENV || "").toLowerCase() === "production" ||
    !!process.env.RENDER
  );
}
function _s200NormalizeList(out, providerKey, opts = {}) {
  const arr = coerceItemsS200(out);
  const res = [];
  for (const it of arr) {
    if (!it) continue;
    const clean = { ...it };
    // kill any random ids coming from legacy code
    delete clean.id;
    delete clean.listingId;
    if ("price" in clean) clean.price = priceOrNullS200(clean.price);
    const n = normalizeItemS200(clean, providerKey, opts);
    if (n) res.push(n);
  }
  return res;
}

export async function searchEtsyAdapter(query, options = {}) {
  const providerKey = "etsy";
  const started = Date.now();
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "etsyAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  try {
    const t = Number(options?.timeoutMs || options?.timeout || 6500);
    const raw = await withTimeout(searchEtsyAdapterItems(query, options), t, `${providerKey}_items`);
    const region = String(options?.region || "TR").toUpperCase();
    const items = _s200NormalizeList(raw, providerKey, { vertical: "product", category: "product", region });
    return { ok: true, items, count: items.length, source: providerKey, _meta: { tookMs: Date.now() - started, region } };
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = err?.name === "TimeoutError" || /timed out/i.test(msg);
    // PROD: no fake fallbacks
    if (_s200IsProd()) {
      return { ok: false, items: [], count: 0, source: "etsy", _meta: { tookMs: Date.now() - started, error: msg, timeout: isTimeout } };
    }
    // DEV: still observable fail, but keep empty list
    return { ok: false, items: [], count: 0, source: "etsy", _meta: { tookMs: Date.now() - started, error: msg, timeout: isTimeout, dev: true } };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// Diğer export'lar için de ana adapter'ı kullan
export const searchEtsyScrape = searchEtsyAdapter;
export default {
  searchEtsy: searchEtsyAdapter,
  searchEtsyAdapter,
};