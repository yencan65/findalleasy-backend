// server/adapters/defactoAdapter.js
// =======================================================================
//  DeFacto — S33 TITAN+ FINAL MAX + ADAPTER ENGINE TAM UYUMLU
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
export const DEFACTO_META = {
  name: "defacto",
  displayName: "DeFacto",
  provider: "defacto",
  providerFamily: "defacto",
  providerType: "fashion",
  vertical: "fashion",
  category: "fashion",
  subCategory: ["clothing", "apparel", "fast_fashion"],
  
  country: "TR",
  regionAffinity: ["TR"],
  language: "tr",
  
  // Adapter Engine scoring
  providerScore: 0.78,
  priorityWeight: 1.10,
  commissionRateHint: 0.035,
  trustScore: 0.82,
  
  // Capabilities
  affiliateCapable: true,
  hasImages: true,
  hasPrices: true,
  hasStockInfo: true,
  hasRatings: false,
  hasSizes: true,
  
  // Rate limit (Adapter Engine ile senkron)
  rateLimit: {
    limit: 18,
    windowMs: 60000,
    burst: true,
    adaptive: true,
    category: "fashion"
  },
  
  // Tags for categorization
  tags: ["fashion", "clothing", "apparel", "fast_fashion", "turkey", "retail"],
  
  // Timeout settings
  defaultTimeoutMs: 16000,
  searchMaxResults: 50,
  
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
  productsFound: 0,
  rateLimitBlocks: 0
};

function updateMetrics(success = true, responseTime = 0, itemsCount = 0) {
  adapterMetrics.totalRequests++;
  adapterMetrics.lastRequestTime = Date.now();
  
  if (success) {
    adapterMetrics.successfulRequests++;
    adapterMetrics.productsFound += itemsCount;
    
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

function parsePriceStrong(txt) {
  if (!txt) return null;
  try {
    const cleaned = txt
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
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
  const slug = slugify(title || "clothing");
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

// ============================================================
// CATEGORY INFERENCE (Fashion özel)
// ============================================================
function inferCategoryAI(title) {
  const t = safe(title).toLowerCase();
  
  // Gender detection
  const isMen = t.includes("erkek") || t.includes("men") || t.includes("man");
  const isWomen = t.includes("kadın") || t.includes("women") || t.includes("lady");
  const isKids = t.includes("çocuk") || t.includes("kids") || t.includes("child");
  
  // Clothing type detection
  if (t.includes("tişört") || t.includes("t-shirt") || t.includes("tshirt") ||
      t.includes("t shirt")) {
    return isMen ? "men_tshirt" : isWomen ? "women_tshirt" : "tshirt";
  }
  
  if (t.includes("gömlek") || t.includes("shirt") || t.includes("blouse")) {
    return isMen ? "men_shirt" : isWomen ? "women_shirt" : "shirt";
  }
  
  if (t.includes("pantolon") || t.includes("trouser") || t.includes("pants") ||
      t.includes("jean") || t.includes("kot")) {
    return isMen ? "men_pants" : isWomen ? "women_pants" : "pants";
  }
  
  if (t.includes("etek") || t.includes("skirt") || t.includes("dress")) {
    return "women_dress";
  }
  
  if (t.includes("kazak") || t.includes("sweater") || t.includes("sweatshirt") ||
      t.includes("hoodie") || t.includes("hoody")) {
    return isMen ? "men_sweater" : isWomen ? "women_sweater" : "sweater";
  }
  
  if (t.includes("ceket") || t.includes("jacket") || t.includes("coat") ||
      t.includes("mont")) {
    return isMen ? "men_jacket" : isWomen ? "women_jacket" : "jacket";
  }
  
  if (t.includes("ayakkabı") || t.includes("shoe") || t.includes("sneaker") ||
      t.includes("boot")) {
    return isMen ? "men_shoes" : isWomen ? "women_shoes" : "shoes";
  }
  
  if (t.includes("çanta") || t.includes("bag") || t.includes("handbag")) {
    return "bag";
  }
  
  if (t.includes("aksesuar") || t.includes("accessory") || t.includes("belt") ||
      t.includes("şapka") || t.includes("hat") || t.includes("scarf")) {
    return "accessory";
  }
  
  if (t.includes("iç giyim") || t.includes("underwear") || t.includes("boxer") ||
      t.includes("bra") || t.includes("panty")) {
    return "underwear";
  }
  
  // Gender-specific fallback
  if (isMen) return "men_clothing";
  if (isWomen) return "women_clothing";
  if (isKids) return "kids_clothing";
  
  return "clothing";
}

function inferSizeInfo(title) {
  const t = safe(title).toLowerCase();
  const sizes = [];
  
  // Size extraction patterns
  const sizePatterns = [
    /\b(XS|S|M|L|XL|XXL|XXXL)\b/i,
    /\b(\d+)\s*(numara|numara|num)\b/i,
    /\b(\d+)\s*(beden)\b/i,
    /\b(\d{2})\s*(inch|inç)\b/i,
    /\b(\d{2,3})\s*(cm)\b/i
  ];
  
  for (const pattern of sizePatterns) {
    const match = t.match(pattern);
    if (match) {
      sizes.push(match[1].toUpperCase());
    }
  }
  
  // Color extraction
  const colors = [
    "siyah", "beyaz", "kırmızı", "mavi", "yeşil", "sarı", "mor", "turuncu",
    "pembe", "gri", "kahverengi", "bej", "lacivert", "bordo", "füme"
  ];
  
  const foundColors = colors.filter(color => t.includes(color));
  
  return {
    sizes: sizes.length > 0 ? sizes : null,
    colors: foundColors.length > 0 ? foundColors : null
  };
}

// ============================================================
// QUALITY SCORE (Fashion özel scoring)
// ============================================================
function computeQualityScore(item) {
  let score = 0.0;
  
  // Title quality (0-0.25)
  if (item.title && item.title.length > 3) {
    score += 0.25;
    if (item.title.length > 10) score += 0.05;
  }
  
  // Price presence (0-0.25)
  if (item.price != null && item.price > 0) {
    score += 0.25;
  }
  
  // Image presence (0-0.20)
  if (item.image) {
    score += 0.20;
    if (item.imageProxy) score += 0.05;
  }
  
  // Fashion-specific details (0-0.15)
  const { sizes, colors } = inferSizeInfo(item.title);
  if (sizes) score += 0.05;
  if (colors) score += 0.05;
  if (item.categoryAI !== "clothing") score += 0.05;
  
  // Discount/optimized price bonus (0-0.05)
  if (item.optimizedPrice && item.optimizedPrice < item.price) {
    score += 0.05;
  }
  
  // Provider trust bonus (from DEFACTO_META)
  score += DEFACTO_META.providerScore * 0.1;
  
  // Cap to 1.0
  return Math.min(1.0, score);
}

// ============================================================
// URL NORMALIZATION
// ============================================================
function normalizeUrl(u, baseUrl = "https://www.defacto.com.tr") {
  if (!u) return null;
  
  let url = u;
  
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
// IMAGE HANDLING
// ============================================================
function fallbackImage(title) {
  const q = encodeURIComponent(title || "fashion clothing");
  return `https://source.unsplash.com/featured/?fashion,clothing,${q}`;
}

function extractImage(root) {
  let img = safe(root.find("img").attr("data-src")) ||
           safe(root.find("img").attr("data-original")) ||
           safe(root.find("img").attr("src")) ||
           safe(root.find("img").attr("data-lazy")) ||
           safe(root.attr("data-image"));
  
  // Image normalization
  if (img?.startsWith("//")) img = "https:" + img;
  if (img?.startsWith("/")) img = "https://www.defacto.com.tr" + img;
  
  return img;
}

// ============================================================
// RELEVANCE FILTER (Fashion özel)
// ============================================================
function isRelevantFashionItem(item, query) {
  if (!query) return true;
  
  const q = safe(query).toLowerCase();
  const title = safe(item.title).toLowerCase();
  const category = safe(item.categoryAI).toLowerCase();
  
  // Exact match in title
  if (title.includes(q)) {
    return true;
  }
  
  // Fashion-specific terms matching
  const fashionTerms = [
    "tişört", "t-shirt", "gömlek", "pantolon", "etek", "elbise",
    "kazak", "sweater", "ceket", "mont", "ayakkabı", "çanta",
    "erkek", "kadın", "çocuk", "aksesuar"
  ];
  
  const queryTerms = q.split(/\s+/).filter(term => term.length > 2);
  
  for (const term of queryTerms) {
    if (fashionTerms.includes(term)) {
      if (title.includes(term) || category.includes(term)) {
        return true;
      }
    }
  }
  
  return false;
}

// ============================================================
// RATE LIMIT HELPER
// ============================================================
async function checkDefactoRateLimit(region = "TR") {
  const adapterName = "defacto";
  const category = "fashion";
  
  try {
    const key = rateLimiter.createAdapterKey(adapterName, region, category);
    const allowed = await rateLimiter.check(key, {
      provider: adapterName,
      limit: DEFACTO_META.rateLimit.limit,
      windowMs: DEFACTO_META.rateLimit.windowMs,
      burst: DEFACTO_META.rateLimit.burst,
      adaptive: DEFACTO_META.rateLimit.adaptive
    });
    
    if (!allowed) {
      console.warn(`⛔ DeFacto rate limit aşıldı: ${region}`);
      adapterMetrics.rateLimitBlocks++;
      return false;
    }
    
    return true;
  } catch (error) {
    console.warn(`⚠️ DeFacto rate limit kontrol hatası:`, error.message);
    return true; // Hata durumunda devam et
  }
}

// ============================================================
// PAGE SCRAPER (Adapter Engine compatible)
// ============================================================
async function scrapeDefactoPage(query, page = 1, region = "TR", signal = null) {
  const startTime = Date.now();
  
  const q = encodeURIComponent(query);
  const url = `https://www.defacto.com.tr/tr-tr/search?q=${q}&page=${page}`;

  let html = null;

  // Try proxy first
  try {
    html = await proxyFetchHTML(url, {
      timeout: 14000,
      signal,
      proxyRotation: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.defacto.com.tr/",
        "DNT": "1"
      }
    });
  } catch (proxyError) {
    console.warn(`DeFacto proxy hatası: ${proxyError.message}`);
    
    // Fallback to direct axios request
    try {
      const response = await axios.get(url, {
        timeout: 12000,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
        }
      });
      html = response.data;
    } catch (axiosError) {
      console.warn(`DeFacto direct request hatası: ${axiosError.message}`);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const items = [];

  // DeFacto specific selectors
  const selectors = [
    ".product-card",
    ".product",
    ".product-item",
    ".product-card-wrapper",
    ".product-list-item",
    ".prd",
    "[data-product-id]",
    "article.product",
    ".col-6",
    ".col-4",
    ".col-3"
  ];

  $(selectors.join(",")).each((i, el) => {
    try {
      const root = $(el);

      // Title extraction
      const titleRaw =
        safe(root.find(".product-card__title").text()) ||
        safe(root.find(".product-name").text()) ||
        safe(root.find(".name").text()) ||
        safe(root.find("h3").text()) ||
        safe(root.find("h2").text()) ||
        safe(root.attr("data-product-name"));
      
      if (!titleRaw || titleRaw.length < 3) return;

      // Price extraction
      const priceText =
        safe(root.find(".product-card__price--new").text()) ||
        safe(root.find(".product-card__price").text()) ||
        safe(root.find(".new-price").text()) ||
        safe(root.find(".price").text()) ||
        safe(root.find(".amount").text()) ||
        safe(root.find("[data-price]").attr("data-price"));

      const priceRaw = parsePriceStrong(priceText);
      const price = sanitizePrice(priceRaw);

      // URL extraction
      let href =
        safe(root.find("a").attr("href")) ||
        safe(root.find(".product-card__link").attr("href")) ||
        safe(root.attr("data-url")) ||
        safe(root.attr("href"));
      
      if (!href) return;
      
      const normalizedUrl = normalizeUrl(href);
      if (!normalizedUrl) return;

      // Image extraction
      const img = extractImage(root);
      const imageData = buildImageVariants(img || fallbackImage(titleRaw), "defacto");

      // Category inference
      const categoryAI = inferCategoryAI(titleRaw);
      const sizeInfo = inferSizeInfo(titleRaw);

      // ID generation
      const id = stableId("defacto", titleRaw, normalizedUrl, price);

      // Price optimization
      const optimizedPrice = price != null
        ? optimizePrice(
            { 
              price, 
              provider: "defacto",
              category: categoryAI,
              title: titleRaw
            },
            { 
              provider: "defacto", 
              region,
              category: "fashion"
            }
          )
        : null;

      // Discount detection
      const oldPriceText = safe(root.find(".product-card__price--old").text()) ||
                          safe(root.find(".old-price").text());
      const oldPrice = parsePriceStrong(oldPriceText);
      let discountPercent = null;
      
      if (oldPrice && price) {
        discountPercent = Math.round(((oldPrice - price) / oldPrice) * 100);
      }

      // Affiliate URL
      const affiliateData = {
        url: normalizedUrl,
        provider: "defacto",
        title: titleRaw,
        price: price,
        category: categoryAI
      };
      
      const affiliateContext = {
        source: "defacto_adapter",
        campaign: "fashion_search",
        medium: "adapter_engine",
        region: region
      };
      
      const deeplink = buildAffiliateUrl(affiliateData, affiliateContext);

      // Build item object
      const item = {
        // Core fields (Adapter Engine)
        id,
        title: titleRaw,
        provider: "defacto",
        originUrl: normalizedUrl,
finalUrl: deeplink || normalizedUrl,
deeplink,
url: normalizedUrl,

        currency: "TRY",
        region,
        category: "fashion",
        adapterSource: "defactoAdapter",
        
        // Extended fields
        providerFamily: "defacto",
        providerType: "fashion",
        vertical: "fashion",
        
        // Price info
        finalPrice: price,
        optimizedPrice,
        priceText: priceText,
        oldPrice,
        discountPercent,
        hasDiscount: discountPercent != null,
        
        // Fashion-specific info
        categoryAI,
        sizes: sizeInfo.sizes,
        colors: sizeInfo.colors,
        
        // Image info
        image: imageData.image,
        imageOriginal: imageData.imageOriginal,
        imageProxy: imageData.imageProxy,
        hasProxy: imageData.hasProxy === true,

        imageVariants: imageData.variants || {},
        
        // Tags
        tags: ["fashion", "defacto", categoryAI].filter(Boolean),
        
        // Raw data
        raw: { 
          href,
          priceText,
          oldPriceText,
          img,
          elementIndex: i 
        },
        
        // Metadata
        _meta: {
          adapterVersion: "S33_TITAN",
          scrapeTime: Date.now() - startTime,
          page: page,
          region: region,
          isFashion: true
        }
      };

      // Calculate quality score
      item.qualityScore = computeQualityScore(item);
      item.score = item.qualityScore;
      
      // Relevance filter
      if (isRelevantFashionItem(item, query)) {
        items.push(item);
      }
      
    } catch (itemError) {
      console.warn(`DeFacto item parse hatası: ${itemError.message}`);
    }
  });

  return items;
}

// ============================================================
// MAIN ADAPTER FUNCTION (Adapter Engine signature)
// ============================================================
export async function searchDefactoAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  
  // Parse options
  const region = options.region || "TR";
  const signal = options.signal || null;
  const timeoutMs = options.timeoutMs || DEFACTO_META.defaultTimeoutMs;
  const maxResults = options.maxResults || DEFACTO_META.searchMaxResults;
  const maxPages = options.maxPages || 4;
  
  console.log(`👕 DeFacto adapter çağrıldı: "${query}" (${region})`);

  try {
    // Rate limit kontrolü
    const rateLimitAllowed = await checkDefactoRateLimit(region);
    if (!rateLimitAllowed) {
      throw new Error("Rate limit exceeded for DeFacto adapter");
    }
    
    const q = safe(query);
    if (!q) {
      return {
        ok: false,
        items: [],
        count: 0,
        error: "Empty query",
        query: query,
        provider: "defacto",
        region: region
      };
    }
    
    let allItems = [];
    let lastCount = null;
    
    // Multi-page scraping
    for (let page = 1; page <= maxPages; page++) {
      try {
        // Add delay between pages
        if (page > 1) {
          await new Promise(resolve => setTimeout(resolve, 800 + __s200_next() * 1200));
        }
        
        const pageItems = await scrapeDefactoPage(q, page, region, signal);
        
        if (!pageItems || pageItems.length === 0) {
          break;
        }
        
        // Check for duplicate page results
        if (lastCount !== null && lastCount === pageItems.length) {
          console.log(`↻ DeFacto page ${page} duplicate results, stopping`);
          break;
        }
        lastCount = pageItems.length;
        
        allItems = allItems.concat(pageItems);
        
        // Stop if we have enough items
        if (allItems.length >= maxResults) {
          allItems = allItems.slice(0, maxResults);
          break;
        }
        
      } catch (pageError) {
        console.warn(`DeFacto sayfa ${page} hatası: ${pageError.message}`);
        break;
      }
    }
    
    // Sort by quality score
    allItems.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
    
    // Remove duplicates by URL
    const seenUrls = new Set();
    const uniqueItems = allItems.filter(item => {
      if (!item.url) return true;
      if (seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    });
    
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(true, totalTime, uniqueItems.length);
    
    // Rate limit başarı istatistiğini güncelle
    const key = rateLimiter.createAdapterKey("defacto", region, "fashion");
    rateLimiter.registerSuccess(key, 1);
    
    console.log(`✅ DeFacto başarılı: ${uniqueItems.length} ürün (${totalTime}ms)`);
    
    // Return in Adapter Engine format
    return {
      ok: true,
      items: uniqueItems,
      count: uniqueItems.length,
      query: query,
      provider: "defacto",
      region: region,
      meta: {
        adapter: "defactoAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        pagesScraped: Math.min(maxPages, uniqueItems.length > 0 ? maxPages : 0),
        rateLimitInfo: {
          limit: DEFACTO_META.rateLimit.limit,
          windowMs: DEFACTO_META.rateLimit.windowMs
        }
      }
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(false, totalTime, 0);
    
    // Rate limit hatası durumunda
    if (error.message.includes("Rate limit")) {
      const key = rateLimiter.createAdapterKey("defacto", region, "fashion");
      rateLimiter.registerError(key, 1);
    }
    
    console.error(`❌ DeFactoAdapter hata (${totalTime}ms):`, error.message);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      query: query,
      provider: "defacto",
      region: region,
      meta: {
        adapter: "defactoAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        error: true,
        rateLimited: error.message.includes("Rate limit")
      }
    };
  }
}

// ============================================================
// ADAPTER STATISTICS
// ============================================================
export function getDefactoAdapterStats() {
  return {
    ...adapterMetrics,
    successRate: adapterMetrics.totalRequests > 0 
      ? (adapterMetrics.successfulRequests / adapterMetrics.totalRequests) * 100 
      : 0,
    rateLimitInfo: rateLimiter.getAdapterStats("defacto"),
    timestamp: new Date().toISOString(),
    version: "S33_TITAN"
  };
}

export function resetDefactoRateLimit(region = "TR") {
  return rateLimiter.resetAdapter("defacto", region);
}

// ============================================================
// ADAPTER ENGINE COMPATIBILITY EXPORTS
// ============================================================

// Legacy function names
export const searchDefacto = searchDefactoAdapter;
export const searchDefactoScrape = searchDefactoAdapter;

// Adapter configuration
export const defactoAdapterConfig = {
  name: "defacto",
  displayName: "DeFacto",
  fn: searchDefactoAdapter,
  meta: DEFACTO_META,
  timeoutMs: DEFACTO_META.defaultTimeoutMs,
  priority: 0.42,
priorityWeight: DEFACTO_META.priorityWeight,

  categories: ["fashion", "clothing", "apparel", "product"],
  tags: DEFACTO_META.tags,
  supportedRegions: ["TR"],
  rateLimit: DEFACTO_META.rateLimit,
  adapterEngineVersion: ">=S10",
  status: "active",
  lastTested: new Date().toISOString().split('T')[0],
  isFashionRetailer: true
};

// ============================================================
// DEFAULT EXPORT
// ============================================================
export default {
  searchDefactoAdapter,
  searchDefacto,
  searchDefactoScrape,
  ...defactoAdapterConfig,
  DEFACTO_META,
  getDefactoAdapterStats,
  resetDefactoRateLimit,
  register: () => defactoAdapterConfig
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
export async function searchDefactoAdapter(query, options = {}) {
  const providerKey = "defacto";
  const started = __s200_now();
  const timeoutMs =
    Number(options?.timeoutMs) ||
    Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
    9000;

  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "defactoAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const raw = await withTimeout(
      () => searchDefactoAdapterLegacy(query, options),
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
