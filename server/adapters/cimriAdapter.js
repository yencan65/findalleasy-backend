// server/adapters/cimriAdapter.js
// =======================================================================
//  CIMRI — S33 TITAN+ FINAL MAX + ADAPTER ENGINE TAM UYUMLU
// =======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";

// ============================================================
// RATE LIMITER IMPORT (Adapter Engine ile uyumlu)
// ============================================================
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200 } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// S200: deterministic request/trace ids (NO RANDOM)
// ---------------------------------------------------------------------------
let __s200_seq = 0;
const __s200_next = () => {
  __s200_seq = (__s200_seq + 1) % 1000000000;
  return __s200_seq;
};


// ============================================================
// ADAPTER ENGINE COMPATIBILITY LAYER
// ============================================================

// PROVIDER META (Adapter Engine formatı)
export const CIMRI_META = {
  name: "cimri",
  displayName: "Cimri",
  provider: "cimri",
  providerFamily: "cimri",
  providerType: "compare",
  vertical: "compare",
 category: "compare",
subCategory: ["product", "electronics", "tech", "compare"],

  
  country: "TR",
  regionAffinity: ["TR"],
  language: "tr",
  
  // Adapter Engine scoring
  providerScore: 0.71,
  priorityWeight: 1.10,
  commissionRateHint: 0.02,
  trustScore: 0.75,
  
  // Capabilities
  affiliateCapable: true,
  hasImages: true,
  hasPrices: true,
  hasStockInfo: true,
  hasRatings: false, // Cimri genelde rating göstermiyor
  hasMultipleOffers: true, // Karşılaştırma sitesi
  
  // Rate limit (Adapter Engine ile senkron)
  rateLimit: {
    limit: 15,
    windowMs: 60000,
    burst: true,
    adaptive: true,
    category: "compare"
  },
  
  // Tags for categorization
  tags: ["compare", "electronics", "tech", "price_comparison", "turkey"],
  
  // Timeout settings
  defaultTimeoutMs: 15000,
  searchMaxResults: 25,
  
  // Adapter Engine version compatibility
  adapterEngineVersion: "S33_TITAN",
  lastUpdated: "2024-12-08",
  status: "active"
};

// ============================================================
// ADAPTER METRICS (Adapter Engine uyumlu)
// ============================================================
const adapterMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  lastRequestTime: null,
  averageResponseTime: 0,
  itemsFound: 0,
  rateLimitBlocks: 0
};

function updateMetrics(success = true, responseTime = 0, itemsCount = 0) {
  adapterMetrics.totalRequests++;
  adapterMetrics.lastRequestTime = Date.now();
  
  if (success) {
    adapterMetrics.successfulRequests++;
    adapterMetrics.itemsFound += itemsCount;
    
    // Ortalama response time güncelle
    if (responseTime > 0) {
      adapterMetrics.averageResponseTime = 
        (adapterMetrics.averageResponseTime * (adapterMetrics.successfulRequests - 1) + responseTime) / 
        adapterMetrics.successfulRequests;
    }
  } else {
    adapterMetrics.failedRequests++;
  }
}

// ============================================================
// CORE HELPERS (Adapter Engine uyumlu)
// ============================================================
const safe = (v) => (v == null ? "" : String(v).trim());

function parsePriceStrong(v) {
  if (!v) return null;
  const n = Number(
    String(v)
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function stableId(provider, title, url, price) {
  const slug = slugify(title);
  const priceHash = crypto
    .createHash("md5")
    .update(String(price ?? ""))
    .digest("hex")
    .slice(0, 6);

  const urlHash = crypto
    .createHash("md5")
    .update(String(url || ""))
    .digest("hex")
    .slice(0, 6);

  return `${provider}_${slug}_${priceHash}_${urlHash}`;
}

function fallbackImage(title) {
  const q = encodeURIComponent(title || "product");
  return `https://source.unsplash.com/featured/?product,tech,${q}`;
}

// ============================================================
// CATEGORY INFERENCE (Adapter Engine ontology uyumlu)
// ============================================================
function inferCategoryAI(title) {
  const t = safe(title).toLowerCase();
  
  // Electronics
  if (t.includes("iphone") || t.includes("samsung") || t.includes("xiaomi") ||
      t.includes("huawei") || t.includes("oppo") || t.includes("vivo") ||
      t.includes("telefon") || t.includes("smartphone") || t.includes("cep telefonu")) {
    return "smartphone";
  }
  
  if (t.includes("laptop") || t.includes("notebook") || t.includes("macbook") ||
      t.includes("dizüstü") || t.includes("bilgisayar")) {
    return "laptop";
  }
  
  if (t.includes("tablet") || t.includes("ipad")) {
    return "tablet";
  }
  
  // Audio
  if (t.includes("kulaklık") || t.includes("headset") || t.includes("earphone") ||
      t.includes("airpods") || t.includes("bluetooth kulaklık")) {
    return "audio";
  }
  
  if (t.includes("hoparlör") || t.includes("speaker") || t.includes("ses sistemi")) {
    return "speaker";
  }
  
  // TV & Display
  if (t.includes("televizyon") || t.includes("tv") || t.includes("led tv") ||
      t.includes("smart tv") || t.includes("monitör") || t.includes("ekran")) {
    return "television";
  }
  
  // Home appliances
  if (t.includes("buzdolabı") || t.includes("çamaşır makinesi") || t.includes("bulaşık makinesi") ||
      t.includes("fırın") || t.includes("ocak") || t.includes("klima")) {
    return "appliance";
  }
  
  // Gaming
  if (t.includes("playstation") || t.includes("xbox") || t.includes("nintendo") ||
      t.includes("oyun") || t.includes("konsol") || t.includes("game")) {
    return "gaming";
  }
  
  // Wearables
  if (t.includes("akıllı saat") || t.includes("smartwatch") || t.includes("fitbit") ||
      t.includes("fitness tracker")) {
    return "wearable";
  }
  
  // Computer components
  if (t.includes("işlemci") || t.includes("cpu") || t.includes("ekran kartı") ||
      t.includes("ram") || t.includes("ssd") || t.includes("anakart")) {
    return "computer_component";
  }
  
  return "product";
}

function detectStock(root) {
  const txt = root.text().toLowerCase();
  if (txt.includes("tükendi") || txt.includes("out of stock") || 
      txt.includes("stokta yok") || txt.includes("stok dışı")) {
    return "out";
  }
  if (txt.includes("stokta sınırlı") || txt.includes("az kaldı") || 
      txt.includes("son ürün")) {
    return "limited";
  }
  if (txt.includes("stokta var") || txt.includes("mevcut")) {
    return "in_stock";
  }
  return "unknown";
}

// ============================================================
// QUALITY SCORE (Adapter Engine scoring uyumlu)
// ============================================================
function computeQualityScore(item) {
  let score = 0.0;
  
  // Adapter Engine base scoring
  
  // Title quality (0-0.30)
  if (item.title && item.title.length > 3) {
    score += 0.30;
    if (item.title.length > 10) score += 0.05;
  }
  
  // Price presence (0-0.25)
  if (item.price != null && item.price > 0) {
    score += 0.25;
  }
  
  // Image presence (0-0.15)
  if (item.image) {
    score += 0.15;
    if (item.hasProxy) score += 0.05;

  }
  
  // Stock status (0-0.10)
  if (item.stock !== "out") {
    score += 0.10;
    if (item.stock === "in_stock") score += 0.05;
  }
  
  // Category specificity (0-0.05)
  if (item.categoryAI !== "product") {
    score += 0.05;
  }
  
  // Provider trust bonus (from CIMRI_META)
  score += CIMRI_META.providerScore * 0.1;
  
  // Cap to 1.0
  return Math.min(1.0, score);
}

// ============================================================
// URL NORMALIZATION (Adapter Engine format)
// ============================================================
function normalizeUrl(href, baseUrl = "https://www.cimri.com") {
  if (!href) return null;
  
  let url = href;
  
  // Clean URL
  url = url.split('?')[0].split('#')[0].trim();
  
  if (url.startsWith("http")) {
    return url;
  }
  
  if (url.startsWith("//")) {
    return "https:" + url;
  }
  
  if (url.startsWith("/")) {
    return baseUrl + url;
  }
  
  // Relative URL
  return baseUrl + "/" + url;
}

// ============================================================
// PAGE SCRAPER (Adapter Engine compatible output)
// ============================================================
async function scrapeCimriPage(query, page = 1, region = "TR", signal = null) {
  const q = encodeURIComponent(query);
  
  let url;
  if (page > 1) {
    url = `https://www.cimri.com/arama?q=${q}&page=${page}`;
  } else {
    url = `https://www.cimri.com/arama?q=${q}`;
  }

  let html = null;
  const startTime = Date.now();

  // Try proxy first (from proxyEngine)
  try {
    html = await proxyFetchHTML(url, {
      timeout: 14000,
      signal,
      proxyRotation: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.cimri.com/",
        "DNT": "1"
      }
    });
  } catch (proxyError) {
    console.warn(`Cimri proxy hatası: ${proxyError.message}`);
    
    // Fallback to direct axios request
    try {
      const { data } = await axios.get(url, {
        timeout: 10000,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
        }
      });
      html = data;
    } catch (axiosError) {
      console.warn(`Cimri direct request hatası: ${axiosError.message}`);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const items = [];

  // Cimri specific selectors (geliştirilmiş)
  const selectors = [
    "a[class*='product-card']",
    "div[class*='product-card']",
    "li[class*='product-card']",
    "[data-test-id='product-card']",
    ".c-product-card",
    ".product-card",
    ".searchResultsItem",
    "article[class*='product']",
    ".zA7IN",
    ".productList",
    ".product-item"
  ];

  $(selectors.join(",")).each((i, el) => {
    try {
      const root = $(el);

      // URL extraction
      let href = safe(root.attr("href")) || 
                safe(root.find("a").attr("href")) ||
                safe(root.find("[data-product-url]").attr("data-product-url"));
      
      if (!href) return;
      
      const normalizedUrl = normalizeUrl(href);
      if (!normalizedUrl) return;

      // Title extraction (geliştirilmiş)
      const titleRaw = safe(root.find("h3, h2, [class*='title'], [class*='name']").text()) ||
                      safe(root.find(".product-title, .product-name, .title").text()) ||
                      safe(root.attr("data-product-name") || root.attr("title"));
      
      if (!titleRaw || titleRaw.length < 3) return;

      // Spam/irrelevant content filter
      const lt = titleRaw.toLowerCase();
      const spamKeywords = [
        "spam", "test", "örnek", "demo", "fake", "deneme", "reklam",
        "kupon", "indirim kodu", "promosyon"
      ];
      
      if (spamKeywords.some(keyword => lt.includes(keyword))) {
        return;
      }

      // Price extraction (geliştirilmiş)
      const priceText = safe(root.find("[class*='price'], .price, .product-price, .current-price").text()) ||
                       safe(root.find("[data-price]").attr("data-price")) ||
                       safe(root.attr("data-price"));

      const priceRaw = parsePriceStrong(priceText);
      const price = sanitizePrice(priceRaw);

      // Skip if no price (Cimri'de fiyat önemli)
      if (!price || price <= 0) return;

      // Image extraction
      let img = safe(root.find("img").attr("src")) ||
               safe(root.find("img").attr("data-src")) ||
               safe(root.find("img").attr("data-original")) ||
               safe(root.attr("data-image"));
      
      // Image normalization
      if (img?.startsWith("//")) img = "https:" + img;
      if (img?.startsWith("/")) img = "https://www.cimri.com" + img;
      if (!img || img.includes("placeholder") || img.includes("default")) {
        img = fallbackImage(titleRaw);
      }

      const imageData = buildImageVariants(img, "cimri");

      // Category inference
      const categoryAI = inferCategoryAI(titleRaw);

      // Stock detection
      const stock = detectStock(root);

      // ID generation (Adapter Engine compatible)
      const id = stableId("cimri", titleRaw, normalizedUrl, price);

      // Price optimization (Adapter Engine priceFixer)
      const optimizedPrice = price; // Cimri’de optimize yok

        

      // Affiliate URL (Adapter Engine affiliateEngine)
      const affiliateData = {
        url: normalizedUrl,
        provider: "cimri",
        title: titleRaw,
        price: price
      };
      
      const affiliateContext = {
        source: "cimri_adapter",
        campaign: "organic_search",
        medium: "adapter_engine",
        region: region
      };
      
      const deeplink = buildAffiliateUrl(affiliateData, affiliateContext);

      // Store/seller info (Cimri karşılaştırma)
      const storeName = safe(root.find("[class*='store'], [class*='seller'], .store-name").text());
      const isMultipleOffers = storeName ? true : false;

      // Discount detection
      const discountText = safe(root.find("[class*='discount'], .discount, .sale, .promo").text());
      let discountPercent = null;
      if (discountText) {
        const match = discountText.match(/(\d+)%/);
        if (match) discountPercent = parseInt(match[1]);
      }

      // Build item object (Adapter Engine format)
      const item = {
        // Core fields (required by Adapter Engine)
        id,
        title: titleRaw,
        provider: "cimri",
        url: deeplink || normalizedUrl,   // S200 pipeline doğru çalışır
originUrl: normalizedUrl,         // debug ve canonical için eklenmeli
deeplink: deeplink,
        price,
        currency: "TRY",
        region,
        category: "compare",
        adapterSource: "cimriAdapter",
        
        // Extended fields
        providerFamily: "cimri",
        providerType: "compare",
        vertical: "compare",
        
        // Price info
        finalPrice: price,
        optimizedPrice,
        priceText: priceText,
        discountPercent,
        hasDiscount: discountPercent != null,
        
        // Product info
        rating: null, // Cimri genelde rating göstermiyor
        reviewCount: null,
        stock,
        stockStatus: stock,
        
        // Store/seller info (Cimri özelliği)
        storeName: storeName || null,
        isMultipleOffers,
        
        // Image info
        image: imageData.image,
        imageOriginal: imageData.imageOriginal,
        imageProxy: imageData.imageProxy,
        hasProxy: imageData.hasProxy,
        imageVariants: imageData.variants || {},
        
        // Category info
        categoryAI,
        subCategory: categoryAI,
        tags: ["compare", "cimri", categoryAI].filter(Boolean),
        
        // Raw data (for debugging)
        raw: { 
          href,
          priceText,
          img,
          storeName,
          discountText,
          elementIndex: i 
        },
        
        // Adapter Engine metadata
        _meta: {
          adapterVersion: "S33_TITAN",
          scrapeTime: Date.now() - startTime,
          page: page,
          region: region,
          isComparisonSite: true
        }
      };

      // Calculate quality score (Adapter Engine compatible)
      item.qualityScore = computeQualityScore(item);
      item.score = item.qualityScore; // Alias for Adapter Engine
      
      items.push(item);
      
    } catch (itemError) {
      console.warn(`Cimri item parse hatası: ${itemError.message}`);
    }
  });

  return items;
}

// ============================================================
// RATE LIMIT HELPER (Adapter Engine entegrasyonu)
// ============================================================
async function checkCimriRateLimit(region = "TR") {
  const adapterName = "cimri";
  const category = "compare";
  
  try {
    // Adapter Engine'in rate limiter'ını kullan
    const key = rateLimiter.createAdapterKey(adapterName, region, category);
    const allowed = await rateLimiter.check(key, {
      provider: adapterName,
      limit: CIMRI_META.rateLimit.limit,
      windowMs: CIMRI_META.rateLimit.windowMs,
      burst: CIMRI_META.rateLimit.burst,
      adaptive: CIMRI_META.rateLimit.adaptive
    });
    
    if (!allowed) {
      console.warn(`⛔ Cimri rate limit aşıldı: ${region}`);
      adapterMetrics.rateLimitBlocks++;
      return false;
    }
    
    return true;
  } catch (error) {
    console.warn(`⚠️ Cimri rate limit kontrol hatası:`, error.message);
    return true; // Hata durumunda devam et
  }
}

// ============================================================
// MAIN ADAPTER FUNCTION (Adapter Engine signature)
// ============================================================
export async function searchCimriAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  
  // Parse options (Adapter Engine format)
  const region = options.region || "TR";
  const signal = options.signal || null;
  const timeoutMs = options.timeoutMs || CIMRI_META.defaultTimeoutMs;
  const maxResults = options.maxResults || CIMRI_META.searchMaxResults;
  const maxPages = options.maxPages || 2;
  
  console.log(`🔄 Cimri adapter çağrıldı: "${query}" (${region})`);

  try {
    // Rate limit kontrolü (Adapter Engine ile uyumlu)
    const rateLimitAllowed = await checkCimriRateLimit(region);
    if (!rateLimitAllowed) {
      throw new Error("Rate limit exceeded for Cimri adapter");
    }
    
    let allItems = [];
    
    // Multi-page scraping with delays
    for (let page = 1; page <= maxPages; page++) {
      try {
        // Add delay between pages to avoid rate limiting
        if (page > 1) {
          await new Promise(resolve => setTimeout(resolve, 800 + __s200_next() * 1200));
        }
        
        const pageItems = await scrapeCimriPage(query, page, region, signal);
        
        if (!pageItems || pageItems.length === 0) {
          break; // No more items
        }
        
        allItems = allItems.concat(pageItems);
        
        // Stop if we have enough items
        if (allItems.length >= maxResults) {
          allItems = allItems.slice(0, maxResults);
          break;
        }
        
      } catch (pageError) {
        console.warn(`Cimri sayfa ${page} hatası: ${pageError.message}`);
        break;
      }
    }
    
    // Sort by quality score (descending)
    allItems.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
    
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(true, totalTime, allItems.length);
    
    // Rate limit başarı istatistiğini güncelle
    const key = rateLimiter.createAdapterKey("cimri", region, "compare");
    rateLimiter.registerSuccess(key, 1);
    
    console.log(`✅ Cimri başarılı: ${allItems.length} ürün (${totalTime}ms)`);
    
    // Return in Adapter Engine expected format
    return {
      ok: true,
      items: allItems,
      count: allItems.length,
      query: query,
      provider: "cimri",
      region: region,
      meta: {
        adapter: "cimriAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        pagesScraped: Math.min(maxPages, allItems.length > 0 ? maxPages : 0),
        isComparisonSite: true,
        rateLimitInfo: {
          limit: CIMRI_META.rateLimit.limit,
          windowMs: CIMRI_META.rateLimit.windowMs
        }
      }
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(false, totalTime, 0);
    
    // Rate limit hatası durumunda
    if (error.message.includes("Rate limit")) {
      const key = rateLimiter.createAdapterKey("cimri", region, "compare");
      rateLimiter.registerError(key, 1);
    }
    
    console.error(`❌ CimriAdapter hata (${totalTime}ms):`, error.message);
    
    // Return error in Adapter Engine format
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      query: query,
      provider: "cimri",
      region: region,
      meta: {
        adapter: "cimriAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        error: true,
        rateLimited: error.message.includes("Rate limit")
      }
    };
  }
}

// ============================================================
// ADAPTER STATISTICS (Adapter Engine için)
// ============================================================
export function getCimriAdapterStats() {
  return {
    ...adapterMetrics,
    successRate: adapterMetrics.totalRequests > 0 
      ? (adapterMetrics.successfulRequests / adapterMetrics.totalRequests) * 100 
      : 0,
    rateLimitInfo: rateLimiter.getAdapterStats("cimri"),
    timestamp: new Date().toISOString(),
    version: "S33_TITAN"
  };
}

export function resetCimriRateLimit(region = "TR") {
  return rateLimiter.resetAdapter("cimri", region);
}

// ============================================================
// ADAPTER ENGINE COMPATIBILITY EXPORTS
// ============================================================

// Legacy function name for backward compatibility
export const searchCimri = searchCimriAdapter;

// Single item search (for testing/debugging)
export async function searchCimriScrape(query, options = {}) {
  const result = await searchCimriAdapter(query, options);
  return result.items || [];
}

// Adapter configuration for Adapter Engine registry
export const cimriAdapterConfig = {
  // Required by Adapter Engine
  name: "cimri",
  displayName: "Cimri",
  fn: searchCimriAdapter,
  
  // Adapter Engine metadata
  meta: CIMRI_META,
  
  // Timeout configuration
  timeoutMs: CIMRI_META.defaultTimeoutMs,
  
  // Priority in Adapter Engine
  priority: 0.4,

  
  // Categories for Adapter Engine routing
  categories: ["product", "electronics", "tech", "compare"],
  
  // Tags for filtering
  tags: CIMRI_META.tags,
  
  // Region support
  supportedRegions: ["TR"],
  
  // Rate limit info for Adapter Engine
  rateLimit: CIMRI_META.rateLimit,
  
  // Adapter Engine version
  adapterEngineVersion: ">=S10",
  
  // Status
  status: "active",
  lastTested: new Date().toISOString().split('T')[0],
  
  // Special flags for Adapter Engine
  isComparisonSite: true,
  supportsMultipleOffers: true
};

// ============================================================
// DEFAULT EXPORT (Adapter Engine compatible)
// ============================================================
export default {
  // Main search function
  searchCimriAdapter,
  
  // Legacy alias
  searchCimri,
  
  // Scrape function
  searchCimriScrape,
  
  // Adapter configuration
  ...cimriAdapterConfig,
  
  // Provider metadata
  CIMRI_META,
  
  // Statistics functions
  getCimriAdapterStats,
  resetCimriRateLimit,
  
  // Adapter Engine registration helper
  register: () => cimriAdapterConfig
};

// ============================================================================
// S200 WRAPPER HELPERS (AUTO-GENERATED)
// - ZERO DELETE: legacy funcs preserved as *Legacy
// - Output: { ok, items, count, source, _meta }
// - Observable fail: ok:false + items:[]
// - Deterministic IDs: normalizeItemS200 will enforce stableIdS200(providerKey,url,title)
// ============================================================================

function __s200_now() { return Date.now(); }

function __s200_result(providerKey, ok, items, meta) {
  const safeItems = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: safeItems,
    count: safeItems.length,
    source: providerKey,
    _meta: meta || {},
  };
}

function __s200_errMeta(providerKey, started, err, extra) {
  const msg = (err && (err.message || err.toString())) || "unknown";
  const name = (err && err.name) || "Error";
  return {
    providerKey,
    startedAt: started,
    tookMs: Math.max(0, __s200_now() - started),
    error: { name, message: msg },
    ...(extra || {}),
  };
}


// ============================================================================
// S200 WRAPPED EXPORT (STRICT OUTPUT)
// - Adapts legacy object output to strict S200 shape
// ============================================================================
export async function searchCimriAdapter(query, options = {}) {
  const providerKey = "cimri";
  const started = __s200_now();
  const timeoutMs =
    Number(options?.timeoutMs) ||
    Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
    9000;

  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "cimriAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const raw = await withTimeout(
      () => searchCimriAdapterLegacy(query, options),
      timeoutMs,
      providerKey
    );

    const ok = raw && typeof raw === "object" ? (raw.ok !== false) : false;
    const arr = coerceItemsS200(raw && raw.items);
    const norm = [];
    for (const it of arr) {
      const cleaned = (it && typeof it === "object") ? { ...it, id: null, listingId: null } : it;
      const ni = normalizeItemS200(cleaned, providerKey);
      if (!ni) continue;
      norm.push(ni);
    }

    const meta = {
      startedAt: started,
      tookMs: __s200_now() - started,
      timeoutMs,
      okFrom: "legacy_object",
    };

    // preserve legacy extra fields into _meta (observable)
    if (raw && typeof raw === "object") {
      const extra = { ...raw };
      delete extra.ok; delete extra.items; delete extra.count; delete extra.source; delete extra._meta;
      meta.legacy = extra;
    }

    return __s200_result(providerKey, ok, norm, meta);
  } catch (err) {
    return __s200_result(providerKey, false, [], __s200_errMeta(providerKey, started, err, {
      timeoutMs,
      okFrom: "exception",
    }));
  }
}
