// server/adapters/amazonAdapter.js
// ============================================================
// AMAZON ADAPTER - S220 → S200 RAW ULTRA (ANA MOTOR İLE %100 UYUMLU)
// ------------------------------------------------------------
// • Amazon.com.tr + Amazon Global desteklenir
// • S200 wrapFunctionAdapter ile uyumlu: SADECE RAW ARRAY döndürür
// • API + Scrape birlikte, unified adapter üzerinden
// • RateLimiter, optimizePrice, commissionMeta, affiliate URL hepsi korunur
// • Ana motor ok/items/count/meta paketini KENDİ üretir
// ============================================================

import axios from "axios";
import crypto from "crypto";
import * as cheerio from "cheerio";

import {
buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { rateLimiter } from "../utils/rateLimiter.js";
import { finalCategoryMultiplier } from "../core/commissionRates.js";

import {



  loadCheerioS200,
  coerceItemsS200,
  normalizeItemS200,
  withTimeout,
  safeStr,
  stableIdS200,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// S200: deterministic request/trace ids (NO RANDOM)
// ---------------------------------------------------------------------------
let __s200_seq = 0;
const __s200_next = () => {
  __s200_seq = (__s200_seq + 1) % 1000000000;
  return __s200_seq;
};
// --------------------------- S200 STRICT OUTPUT ---------------------------
const S200_SOURCE = "amazon";
const S200_PROVIDER_FAMILY = "product";
const S200_AT = "server/adapters/amazonAdapter.js";

function _s200Ok(items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: true, items: arr, count: arr.length, source: S200_SOURCE, _meta: meta || {} };
}

function _s200Fail(err, meta = {}) {
  const msg = safeStr(err?.message || err, 900) || "unknown_error";
  return { ok: false, items: [], count: 0, source: S200_SOURCE, _meta: { ...(meta || {}), error: msg } };
}

function _isTimeoutErr(e) {
  const msg = String(e?.message || "");
  return e?.name === "TimeoutError" || /timed out/i.test(msg) || /timeout/i.test(msg);
}

// ============================================================
// S10 ADAPTER STATS REGISTRY (Ana motor uyumlu)
// ============================================================

function s10_registerAdapterStatus(name, ok = true, duration = 300) {
  try {
    if (typeof globalThis.S10_AdapterRealtime === "undefined") {
      globalThis.S10_AdapterRealtime = {};
    }

    const key = String(name || "unknown").toLowerCase();

    if (!globalThis.S10_AdapterRealtime[key]) {
      globalThis.S10_AdapterRealtime[key] = {
        fail: 0,
        success: 0,
        avg: duration,
      };
    }

    if (!ok) globalThis.S10_AdapterRealtime[key].fail++;
    else globalThis.S10_AdapterRealtime[key].success++;

    globalThis.S10_AdapterRealtime[key].avg =
      globalThis.S10_AdapterRealtime[key].avg * 0.7 + duration * 0.3;
  } catch {
    // Silent fail
  }
}

// ============================================================
// HELPER FUNCS
// ============================================================

const safe = (x) => (x ? String(x).trim() : "");

// ============================================================
// AMAZON URL NORMALIZER
// ============================================================

function normalizeUrl(u) {
  if (!u) return null;

  let href = String(u).trim();
  const lower = href.toLowerCase();

  if (
    href === "#" ||
    lower.startsWith("javascript") ||
    lower.includes("void(") ||
    lower.includes("return false")
  ) {
    return null;
  }

  if (
    lower.includes("picassoredirect") ||
    lower.includes("slredirect") ||
    lower.includes("redirect.html?") ||
    lower.includes("redirect=true")
  ) {
    return null;
  }

  try {
    if (href.includes("%2Fdp%2F")) {
      href = decodeURIComponent(href);
    }
  } catch {}

  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("http")) return href;

  if (href.startsWith("/-/tr/")) {
    href = href.replace("/-/tr", "");
  }

  return "https://www.amazon.com.tr" + href;
}

// ============================================================
// PRICE PARSER & RATING
// ============================================================

function parsePrice(t) {
  if (!t) return null;
  const clean = t.replace(/[^\d.,]/g, "").replace(",", ".");
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

function normalizeRating(t) {
  if (!t) return null;
  const m = String(t).match(/([\d.,]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : null;
}

function buildStableId(raw, title = "", provider = "amazon") {
  const base = `${provider}_${raw || title || "id"}`;
  try {
    return (
      "amazon_" +
      crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16)
    );
  } catch {
    return "amazon_" + String(base).replace(/\W+/g, "_");
  }
}

// ============================================================
// CATEGORY DETECTION (Ana motor ile uyumlu)
// ============================================================

function detectAmazonCategory(title, rawData = {}) {
  const titleLower = (title || "").toLowerCase();
  const rawCategory = (rawData.category || "").toLowerCase();

  if (
    titleLower.includes("iphone") ||
    titleLower.includes("samsung") ||
    titleLower.includes("telefon") ||
    titleLower.includes("smartphone") ||
    rawCategory.includes("telefon")
  ) {
    return "electronics";
  }

  if (
    titleLower.includes("laptop") ||
    titleLower.includes("notebook") ||
    titleLower.includes("macbook") ||
    rawCategory.includes("bilgisayar")
  ) {
    return "electronics";
  }

  if (
    titleLower.includes("kitap") ||
    titleLower.includes("book") ||
    rawCategory.includes("kitap")
  ) {
    return "book";
  }

  if (
    titleLower.includes("kıyafet") ||
    titleLower.includes("giyim") ||
    titleLower.includes("dress") ||
    titleLower.includes("clothing") ||
    rawCategory.includes("moda")
  ) {
    return "fashion";
  }

  if (
    titleLower.includes("ayakkabı") ||
    titleLower.includes("shoes") ||
    rawCategory.includes("ayakkabı")
  ) {
    return "fashion";
  }

  if (
    titleLower.includes("elektronik") ||
    titleLower.includes("electronic") ||
    rawCategory.includes("elektronik")
  ) {
    return "electronics";
  }

  if (
    titleLower.includes("ev") ||
    titleLower.includes("home") ||
    titleLower.includes("mutfak") ||
    rawCategory.includes("ev")
  ) {
    return "home";
  }

  if (
    titleLower.includes("oyun") ||
    titleLower.includes("game") ||
    rawCategory.includes("oyun")
  ) {
    return "gaming";
  }

  if (
    titleLower.includes("spor") ||
    titleLower.includes("sport") ||
    rawCategory.includes("spor")
  ) {
    return "sports";
  }

  return "product";
}

// ============================================================
// METADATA EXTRACTION
// ============================================================

function extractAmazonMetadata(productData, title) {
  const metadata = {
    marketplaceType: "amazon",
    providerType: "ecommerce",
    isAmazon: true,
    source: "api",
    features: [],
    deliveryInfo: {},
  };

  const titleLower = (title || "").toLowerCase();

  if (
    titleLower.includes("iphone") ||
    titleLower.includes("samsung") ||
    titleLower.includes("telefon")
  ) {
    metadata.productCategory = "phone";
    metadata.isElectronics = true;
    metadata.isMobile = true;
  } else if (
    titleLower.includes("laptop") ||
    titleLower.includes("notebook") ||
    titleLower.includes("macbook")
  ) {
    metadata.productCategory = "laptop";
    metadata.isElectronics = true;
    metadata.isComputer = true;
  } else if (titleLower.includes("kitap") || titleLower.includes("book")) {
    metadata.productCategory = "book";
  } else if (
    titleLower.includes("kıyafet") ||
    titleLower.includes("clothing") ||
    titleLower.includes("giyim") ||
    titleLower.includes("dress")
  ) {
    metadata.productCategory = "clothing";
  } else if (
    titleLower.includes("ayakkabı") ||
    titleLower.includes("shoes")
  ) {
    metadata.productCategory = "shoes";
  } else if (titleLower.includes("elektronik")) {
    metadata.productCategory = "electronics";
  } else {
    metadata.productCategory = "general";
  }

  return metadata;
}

// ============================================================
// REAL WORLD PRICE NORMALIZER
// ============================================================

function normalizeAmazonPrice(price, title, productType) {
  if (price == null) return null;

  if (price < 1) return null;
  if (price > 200000) return null;

  if (productType === "phone") {
    if (price < 1000 || price > 60000) return null;
  }

  if (productType === "laptop") {
    if (price < 3000 || price > 150000) return null;
  }

  if (productType === "electronics") {
    if (price < 50 || price > 100000) return null;
  }

  if (productType === "clothing" || productType === "shoes") {
    if (price < 20 || price > 20000) return null;
  }

  return price;
}

// ============================================================
// AFFILIATE URL BUILDER (Amazon özel)
// ============================================================

function buildAmazonAffiliateUrl(item, context = {}) {
  const baseUrl = item.url || "";
  if (!baseUrl) return baseUrl;

  try {
    const url = new URL(baseUrl);

    const affiliateTag = process.env.AMAZON_AFFILIATE_TAG || "findalleasy-21";
    url.searchParams.set("tag", affiliateTag);

    const subId = context.subid || "fae_amazon_s10";
    url.searchParams.set(
      "ref",
      `as_li_ss_tl?ie=UTF8&linkCode=ll2&tag=${affiliateTag}&linkId=${subId}`
    );

    url.searchParams.set("campaign", "findalleasy");
    url.searchParams.set("creative", "390961");
    url.searchParams.set(
      "creativeASIN",
      (item.id || "").replace("amazon_", "") || ""
    );

    return url.toString();
  } catch {
    return baseUrl;
  }
}

// ============================================================
// NORMALIZE AMAZON ITEM (Ana motor normalizeItem ile uyumlu)
// ============================================================

function normalizeAmazonItem(
  rawItem,
  mainCategory = "product",
  adapterName = "amazonAdapter"
) {
  const item = {
    id: rawItem.id || buildStableId(rawItem.url, rawItem.title, "amazon"),
    title: safe(rawItem.title),
    url: rawItem.url || null,
    price: rawItem.price ?? null,

    rating: rawItem.rating ?? null,
    provider: "amazon",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: mainCategory,
    adapterSource: adapterName,

    commissionRate: rawItem.commissionRate ?? 0.08,
    commissionMeta: {
      platformRate: 0.08,
      categoryMultiplier: finalCategoryMultiplier[mainCategory] || 1.0,
      providerTier: "premium",
      source: "amazon",
      isPrimeEligible: rawItem.isPrime || false,
      isFba: rawItem.isFba || false,
    },

    providerType: "ecommerce",
    vertical: "product",
    marketplaceType: "amazon",

    optimizedPrice: rawItem.optimizedPrice ?? null,
    discountPercentage: rawItem.discountPercentage ?? null,

    deliveryInfo:
      rawItem.deliveryInfo || {
        isPrime: rawItem.isPrime || false,
        estimatedDelivery: rawItem.estimatedDelivery || null,
        freeShipping: rawItem.freeShipping || false,
      },

    image: rawItem.image || null,
    imageVariants: buildImageVariants(rawItem.image, "amazon"),

    reviewCount: rawItem.reviewCount ?? null,

    raw: rawItem.raw || rawItem,

    score: rawItem.score ?? 0.01,
  };

  try {
    item.affiliateUrl =
      rawItem.affiliateUrl || buildAmazonAffiliateUrl(item, { subid: "s220" });
  } catch {
    // ignore
  }

  return item;
}

// ============================================================
// OPTIMIZE PRICE WRAPPER
// ============================================================

function applyOptimizePrice(item) {
  try {
    const optimized = optimizePrice(item, {
      provider: "amazon",
      region: item.region || "TR",
      category: item.category || "product",
      subCategory: detectAmazonCategory(item.title, item.raw),
      mode: "ecommerce",
      source: item.raw?.source || "api",
    });

    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.08;
      optimized.commissionMeta = {
        platformRate: 0.08,
        categoryMultiplier: finalCategoryMultiplier[item.category] || 1.0,
        providerTier: "premium",
        source: "amazon_adapter",
      };
    }

    if (!optimized.affiliateUrl) {
      try {
        optimized.affiliateUrl = buildAmazonAffiliateUrl(optimized, {
          subid: "s220_opt",
        });
      } catch {
        // ignore
      }
    }

    return optimized;
  } catch (e) {
    console.warn("Amazon optimize hata:", e?.message);
    return item;
  }
}

// ============================================================
// API ADAPTER (dummy-compatible AWS PAAPI5)
// ============================================================

const ACCESS_KEY = process.env.AMAZON_ACCESS_KEY || "";
const SECRET_KEY = process.env.AMAZON_SECRET_KEY || "";
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || "";

async function searchAmazonAPI(query, { signal, region = "TR" } = {}) {
  const limiterKey = `s220:adapter:amazon_api:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 25,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });

  if (!allowed) {
    return {
      ok: false,
      items: [],
      count: 0,
      error: "S220_RATE_LIMIT_EXCEEDED",
      adapterName: "amazon_api",
      _meta: { limiterKey, region, timestamp: Date.now() },
    };
  }

  if (!ACCESS_KEY || !SECRET_KEY || !PARTNER_TAG) {
    return { ok: false, items: [], count: 0 };
  }

  try {
    const payload = {
      Keywords: query,
      SearchIndex: "All",
      PartnerTag: PARTNER_TAG,
      PartnerType: "Associates",
      Resources: [
        "ItemInfo.Title",
        "Images.Primary.Large",
        "Offers.Listings.Price",
        "CustomerReviews",
      ],
    };

    const now = new Date().toISOString();

    const signature = crypto
      .createHmac("sha256", SECRET_KEY)
      .update(now + JSON.stringify(payload))
      .digest("hex");

    const response = await axios.post(
      "https://webservices.amazon.com.tr/paapi5/searchitems",
      payload,
      {
        signal,
        headers: {
          "X-Amz-Date": now,
          "X-Amz-Access-Key": ACCESS_KEY,
          "X-Amz-Signature": signature,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    const list = response.data?.SearchResult?.Items || [];
    const results = [];

    list.forEach((it) => {
      const title = safe(it.ItemInfo?.Title?.DisplayValue);
      if (!title) return;

      const href = normalizeUrl(it.DetailPageURL);
      if (!href) return;

      const rawPrice = it.Offers?.Listings?.[0]?.Price?.Amount ?? null;
      let price = rawPrice != null ? Number(rawPrice) : null;

      const detectedCategory = detectAmazonCategory(title, it);
      price = normalizeAmazonPrice(price, title, detectedCategory);

      const rating = it.CustomerReviews?.StarRating ?? null;
      const reviewCount = it.CustomerReviews?.TotalReviewCount ?? null;

      const item = normalizeAmazonItem(
        {
          id: buildStableId(it.ASIN || href, title, "amazon"),
          title,
          price,
          rating,
          reviewCount,
          url: href,
          currency: "TRY",
          region,
          isPrime:
            it.Offers?.Listings?.[0]?.DeliveryInfo?.IsPrimeEligible || false,
          isFba: it.Offers?.Listings?.[0]?.IsFBA || false,
          raw: {
            ...it,
            extractedAt: new Date().toISOString(),
            source: "api",
            category: detectedCategory,
          },
        },
        detectedCategory,
        "amazonApi"
      );

      results.push(applyOptimizePrice(item));
    });

    return {
      ok: true,
      items: results,
      count: results.length,
      metadata: {
        source: "api",
        apiUsed: true,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    console.error("Amazon API hata:", err.message);
    return { ok: false, items: [], count: 0 };
  }
}

// ============================================================
// SCRAPER ADAPTER
// ============================================================

async function searchAmazonScrape(query, { signal, region = "TR" } = {}) {
  const limiterKey = `s220:adapter:amazon_scrape:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 6,
    windowMs: 60000,
    burst: false,
    adaptive: true,
  });

  if (!allowed) {
    return {
      ok: false,
      items: [],
      count: 0,
      error: "S220_RATE_LIMIT_EXCEEDED",
      adapterName: "amazon_scrape",
      _meta: { limiterKey, region, timestamp: Date.now() },
    };
  }

  try {
    const url = `https://www.amazon.com.tr/s?k=${encodeURIComponent(query)}`;

    const response = await axios.get(url, {
      signal,
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    const $ = loadCheerioS200(response.data);
    const results = [];

    $(".s-main-slot .s-result-item").each((i, el) => {
      const w = $(el);

      const title = safe(w.find("h2 .a-text-normal").text());
      if (!title) return;

      const href = normalizeUrl(w.find("h2 a").attr("href"));
      if (!href) return;

      const priceText = safe(w.find(".a-offscreen").text());
      const rating = normalizeRating(safe(w.find(".a-icon-alt").text()));

      const reviewText = safe(
        w.find(".a-size-base.s-underline-text").text()
      );
      const reviewCount = reviewText.match(/\d+/)
        ? Number(reviewText.match(/\d+/)[0])
        : null;

      const imageRaw = safe(w.find("img.s-image").attr("src"));
      const isPrime = w.find(".s-prime").length > 0;

      let price = parsePrice(priceText);
      price = sanitizePrice(price, { provider: "amazon" });

      const category = detectAmazonCategory(title);
      price = normalizeAmazonPrice(price, title, category);

      const item = normalizeAmazonItem(
        {
          id: buildStableId(href, title, "amazon"),
          title,
          price,
          rating,
          reviewCount,
          url: href,
          currency: "TRY",
          region,
          isPrime,
          image: imageRaw,
          raw: {
            title,
            imageRaw,
            variants: buildImageVariants(imageRaw, "amazon"),
            extractedAt: new Date().toISOString(),
            source: "scraping",
            category,
          },
        },
        category,
        "amazonScraper"
      );

      results.push(applyOptimizePrice(item));
    });

    return {
      ok: true,
      items: results.slice(0, 40),
      count: results.length,
      metadata: {
        source: "scraping",
        apiUsed: false,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    console.error("Amazon scrape hata:", err.message);
    return { ok: false, items: [], count: 0 };
  }
}

// ============================================================
// UNIFIED ADAPTER (API → SCRAPE FALLBACK) — S200 RAW
// ============================================================

export async function searchAmazonAdapterLegacy(query, regionOrOptions = {}) {
  const q = safeStr(query, 220);

  // empty query => not an adapter failure
  if (!q) return _s200Ok([], { emptyQuery: true });

  // S200 global ctx (kit loglarında "unknown" düşmesin)
  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: S200_SOURCE, providerKey: S200_SOURCE, at: S200_AT };
  } catch {}

  const startTime = Date.now();
  const requestId = `amzn_${Date.now()}_${__s200_next().toString(36).slice(2, 11)}`;

  let region = "TR";
  let signal = null;
  let timeoutMs = 10000;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
    timeoutMs = regionOrOptions.timeoutMs || 10000;
  }

  // 🔒 RATE LIMITER (observable)
  const limiterKey = `s220:adapter:amazon_unified:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 20,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });

  if (!allowed) {
    s10_registerAdapterStatus("amazonAdapter", false, 0);
    return _s200Fail("RATE_LIMITED", { rateLimited: true, region, requestId });
  }

  console.log(`🛒 [${requestId}] Amazon adapter başladı: "${q.substring(0, 50)}"`);

  try {
    // ✅ withTimeout everywhere (observable timeout)
    const apiPromise = withTimeout(searchAmazonAPI(q, { region, signal }), timeoutMs, "amazon_api");
    const scrapePromise = withTimeout(
      searchAmazonScrape(q, { region, signal }),
      timeoutMs,
      "amazon_scrape"
    );

    const [apiData, scrapeData] = await Promise.allSettled([apiPromise, scrapePromise]);

    const apiOut = apiData.status === "fulfilled" ? apiData.value : null;
    const scrapeOut = scrapeData.status === "fulfilled" ? scrapeData.value : null;

    const combinedRaw = [
      ...coerceItemsS200(apiOut),
      ...coerceItemsS200(scrapeOut),
    ];

    // S200 normalize + contract lock + deterministic id
    const seen = new Set();
    const normalized = [];
    for (const it of combinedRaw) {
      // (paranoya) random id sızıntısı varsa kit id üretsin
      if (it && typeof it === "object" && typeof it.id === "string" && /Math\.random|random/i.test(it.id)) {
        try { delete it.id; } catch {}
      }

      const n = normalizeItemS200(it, S200_SOURCE, {
        providerFamily: S200_PROVIDER_FAMILY,
        vertical: "product",
        category: "product",
        region,
        requireRealUrlCandidate: true,
      });

      if (!n || !n.id) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      normalized.push(n);
    }

    const duration = Date.now() - startTime;

    const metaBase = {
      requestId,
      region,
      tookMs: duration,
      api: apiData.status === "fulfilled" ? "ok" : "fail",
      scrape: scrapeData.status === "fulfilled" ? "ok" : "fail",
      apiError: apiData.status === "rejected" ? safeStr(apiData.reason?.message || apiData.reason, 500) : "",
      scrapeError:
        scrapeData.status === "rejected" ? safeStr(scrapeData.reason?.message || scrapeData.reason, 500) : "",
    };

    if (!normalized.length) {
      // API+Scrape ikisi de çöktüyse/timeout ise => ok:false (observable)
      const bothFailed = apiData.status === "rejected" && scrapeData.status === "rejected";
      const timeout =
        (apiData.status === "rejected" && _isTimeoutErr(apiData.reason)) ||
        (scrapeData.status === "rejected" && _isTimeoutErr(scrapeData.reason));

      if (bothFailed) {
        s10_registerAdapterStatus("amazonAdapter", false, duration);
        return _s200Fail(timeout ? "TIMEOUT" : "NO_RESULTS", {
          ...metaBase,
          timeout: !!timeout,
          bothFailed: true,
        });
      }

      // partial success ama item yok => ok:true empty (no fake)
      s10_registerAdapterStatus("amazonAdapter", true, duration);
      return _s200Ok([], { ...metaBase, empty: true, partial: true });
    }

    s10_registerAdapterStatus("amazonAdapter", true, duration);
    return _s200Ok(normalized, {
      ...metaBase,
      rawCount: combinedRaw.length,
      count: normalized.length,
    });
  } catch (error) {
    const duration = Date.now() - startTime;

    console.error("❌ [Amazon adapter] Hata:", {
      message: error?.message,
      query: q.substring(0, 100),
      duration,
      timestamp: new Date().toISOString(),
    });

    s10_registerAdapterStatus("amazonAdapter", false, duration);

    const timeout = _isTimeoutErr(error);
    return _s200Fail(error, { requestId, region, tookMs: duration, timeout: !!timeout });
  }
}


// ============================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// ============================================================

export const amazonAdapterConfig = {
  name: "amazon",
  fn: searchAmazonAdapter,
  timeoutMs: 10000,
  priority: 1.4,
  category: "product",
  subCategories: [
    "electronics",
    "fashion",
    "home",
    "book",
    "gaming",
    "sports",
    "general",
  ],
  provider: "amazon",
  commissionRate: 0.08,
  vertical: "ecommerce",
  regionSupport: ["TR", "EU", "US", "UK"],
  metadata: {
    providerType: "ecommerce",
    hasAffiliate: true,
    hasPrime: true,
    isGlobal: true,
    trustScore: 9.5,
    deliverySpeed: "fast",
    returnPolicy: "flexible",
  },
  capabilities: {
    supportsApi: true,
    supportsScraping: true,
    supportsImages: true,
    supportsReviews: true,
    supportsPricing: true,
    supportsStockInfo: true,
  },
  s10Integration: {
    supportsCommissionEngine: true,
    supportsPriceOptimization: true,
    supportsAffiliateUrls: true,
    supportsUserTracking: true,
  },
};

// ============================================================
// TEST FUNCTION (S200 RAW'A GÖRE GÜNCELLENMİŞ)
// ============================================================

export async function testAmazonAdapter() {
  const query = "iphone 15 pro";
  const region = "TR";

  console.log("🧪 Amazon adapter test başlıyor...");

  try {
    const items = await searchAmazonAdapter(query, { region });

    console.log("✅ Test sonucu:", {
      isArray: Array.isArray(items),
      itemCount: items.length,
      sampleItem: items[0]
        ? {
            title: items[0].title.substring(0, 50),
            price: items[0].price,
            provider: items[0].provider,
            commissionRate: items[0].commissionRate,
            affiliateUrl: items[0].affiliateUrl ? "Var" : "Yok",
          }
        : null,
    });

    const firstItem = items[0];
    if (firstItem) {
      const requiredFields = ["id", "title", "url", "price", "provider"];
      const missingFields = requiredFields.filter((field) => !firstItem[field]);

      if (missingFields.length === 0) {
        console.log("🎉 Amazon adapter ana motorla %100 uyumlu (S200 RAW)!");
      } else {
        console.warn("⚠️ Eksik alanlar:", missingFields);
      }
    }

    return items;
  } catch (error) {
    console.error("❌ Test başarısız:", error.message);
    throw error;
  }
}

// ============================================================
// DEFAULT EXPORT
// ============================================================

export default {
  searchAmazonAdapter,
  amazonAdapterConfig,
  testAmazonAdapter,
};

console.log("🛒 AMAZON ADAPTER S220→S200 RAW YÜKLENDİ - ANA MOTOR %100 UYUMLU");

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchAmazonAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "amazon";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "amazonAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 10000) || 10000;

  try {
    const raw = await withTimeout(Promise.resolve(searchAmazonAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "amazon",
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
        category: "product",
        vertical: "product",
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
      source: "amazon",
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
      source: "amazon",
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
