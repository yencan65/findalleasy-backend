// server/adapters/circularAdapter.js
// =======================================================================
//  CIRCULAR — S33 TITAN+ FINAL MAX + ADAPTER ENGINE TAM UYUMLU
// =======================================================================

import axios from "axios";
import crypto from "crypto";

import {
proxyFetchJSON } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";

// ============================================================
// RATE LIMITER IMPORT (Adapter Engine ile uyumlu)
// ============================================================
import { rateLimiter } from "../utils/rateLimiter.js";


import {



  coerceItemsS200,
  normalizeItemS200,
  withTimeout,
  safeStr,
  fixKey,
} from "../core/s200AdapterKit.js";

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
export const CIRCULAR_META = {
  name: "circular",
  displayName: "Circular",
  provider: "circular",
  providerFamily: "circular",
  providerType: "car_rental",
  vertical: "car_rental",
  category: "car_rental",
  subCategory: ["car_daily", "mobility", "rental"],
  
  country: "TR",
  regionAffinity: ["TR"],
  language: "tr",
  
  // Adapter Engine scoring
  providerScore: 0.65,
  priorityWeight: 0.7,

  commissionRateHint: 0.04,
  trustScore: 0.70,
  
  // Capabilities
  affiliateCapable: true,
  hasImages: true,
  hasPrices: true,
  hasStockInfo: true,
  hasRatings: false,
  hasDailyRates: true,
  
  // Rate limit (Adapter Engine ile senkron)
  rateLimit: {
    limit: 10,
    windowMs: 60000,
    burst: false,
    adaptive: true,
    category: "car_rental"
  },
  
  // Tags for categorization
  tags: ["car_rental", "mobility", "daily_rental", "turkey", "transport"],
  
  // Timeout settings
  defaultTimeoutMs: 12000,
  searchMaxResults: 30,
  
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
  try {
    let clean = String(v)
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
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

function stableId(provider, title, href, price) {
  const slug = slugify(title || "car");
  const priceHash = crypto
    .createHash("md5")
    .update(String(price ?? ""))
    .digest("hex")
    .slice(0, 6);

  const urlHash = crypto
    .createHash("md5")
    .update(String(href || ""))
    .digest("hex")
    .slice(0, 6);

  return `${provider}_${slug}_${priceHash}_${urlHash}`;
}

// ============================================================
// CATEGORY INFERENCE (Adapter Engine ontology uyumlu)
// ============================================================
function inferCategoryAI(title, rawData = {}) {
  const t = safe(title).toLowerCase();
  
  // Car type detection
  if (t.includes("günlük") || t.includes("daily") || t.includes("day") || 
      rawData.rentalType === "daily") {
    return "car_daily";
  }
  
  if (t.includes("haftalık") || t.includes("weekly") || t.includes("week") ||
      rawData.rentalType === "weekly") {
    return "car_weekly";
  }
  
  if (t.includes("aylık") || t.includes("monthly") || t.includes("month") ||
      rawData.rentalType === "monthly") {
    return "car_monthly";
  }
  
  if (t.includes("uzun dönem") || t.includes("long term") || t.includes("long-term")) {
    return "car_long_term";
  }
  
  // Vehicle type detection
  if (t.includes("ekonomik") || t.includes("economy") || t.includes("compact")) {
    return "economy_car";
  }
  
  if (t.includes("orta") || t.includes("mid") || t.includes("sedan")) {
    return "mid_size";
  }
  
  if (t.includes("suv") || t.includes("jeep") || t.includes("4x4") || t.includes("offroad")) {
    return "suv";
  }
  
  if (t.includes("van") || t.includes("minibüs") || t.includes("minivan")) {
    return "van";
  }
  
  if (t.includes("lüks") || t.includes("luxury") || t.includes("premium")) {
    return "luxury";
  }
  
  // General categories
  if (t.includes("araç") || t.includes("oto") || t.includes("rent") || 
      t.includes("car") || t.includes("araba")) {
    return "car_rental";
  }
  
  return "mobility";
}

function detectStock(row) {
  if (!row) return "unknown";
  
  const s = JSON.stringify(row).toLowerCase();
  
  // Stock status detection
  if (s.includes("müsait değil") || s.includes("sold out") || 
      s.includes("not available") || s.includes("stok yok") ||
      s.includes("unavailable") || row.available === false) {
    return "out";
  }
  
  if (s.includes("sınırlı") || s.includes("limited") || s.includes("az kaldı") ||
      row.available === "limited") {
    return "limited";
  }
  
  if (s.includes("müsait") || s.includes("available") || s.includes("var") ||
      row.available === true || row.inStock === true) {
    return "available";
  }
  
  return "unknown";
}

// ============================================================
// QUALITY SCORE (Adapter Engine scoring uyumlu)
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
  
  if (item.image) {
  score += 0.20;
  if (item.hasProxy) score += 0.05;
}

  
  // Stock status (0-0.10)
  if (item.stock === "available") {
    score += 0.10;
  } else if (item.stock === "limited") {
    score += 0.05;
  }
  
 if (item.categoryAI && item.categoryAI !== "car_rental") {
  score += 0.02;
}

  
  // Rental-specific bonuses
  if (item.price < 1000) {
    score += 0.05; // Affordable daily rate
  }
  
  if (item.dailyPrice && item.dailyPrice > 0) {
    score += 0.03; // Has daily price specified
  }
  
  // Provider trust bonus (from CIRCULAR_META)
  score += CIRCULAR_META.providerScore * 0.1;
  
  // Cap to 1.0
  return Math.min(1.0, score);
}

// ============================================================
// URL NORMALIZATION (Adapter Engine format)
// ============================================================
function normalizeUrl(u, baseUrl = "https://www.circular.com") {
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
  const q = encodeURIComponent(title || "car rental");
  return `https://source.unsplash.com/featured/?car,rental,${q}`;
}

function extractImage(row) {
  let img = safe(row.image) ||
           safe(row.thumbnail) ||
           safe(row.img) ||
           safe(row.photo) ||
           safe(row.picture) ||
           safe(row.imageUrl);
  
  // Image normalization
  if (img?.startsWith("//")) img = "https:" + img;
  if (img?.startsWith("/")) img = "https://www.circular.com" + img;
 if (!img || img.includes("placeholder")) {
  return null;
}

  
  return img;
}

// ============================================================
// DATA EXTRACTION (Multi-shape support)
// ============================================================
function extractItemsFromData(data) {
  if (!data) return [];
  
  let items = [];
  
  // Try different data shapes
  if (Array.isArray(data)) {
    items = data;
  } else if (Array.isArray(data.results)) {
    items = data.results;
  } else if (Array.isArray(data.data?.results)) {
    items = data.data.results;
  } else if (Array.isArray(data.data?.items)) {
    items = data.data.items;
  } else if (Array.isArray(data.items)) {
    items = data.items;
  } else if (Array.isArray(data.listings)) {
    items = data.listings;
  } else if (Array.isArray(data.cars)) {
    items = data.cars;
  } else if (Array.isArray(data.vehicles)) {
    items = data.vehicles;
  } else if (Array.isArray(data.rentals)) {
    items = data.rentals;
  }
  
  return items;
}

// ============================================================
// RATE LIMIT HELPER (Adapter Engine entegrasyonu)
// ============================================================
async function checkCircularRateLimit(region = "TR") {
  const adapterName = "circular";
  const category = "car_rental";
  
  try {
    // Adapter Engine'in rate limiter'ını kullan
    const key = rateLimiter.createAdapterKey(adapterName, region, category);
    const allowed = await rateLimiter.check(key, {
      provider: adapterName,
      limit: CIRCULAR_META.rateLimit.limit,
      windowMs: CIRCULAR_META.rateLimit.windowMs,
      burst: CIRCULAR_META.rateLimit.burst,
      adaptive: CIRCULAR_META.rateLimit.adaptive
    });
    
    if (!allowed) {
      console.warn(`⛔ Circular rate limit aşıldı: ${region}`);
      adapterMetrics.rateLimitBlocks++;
      return false;
    }
    
    return true;
  } catch (error) {
    console.warn(`⚠️ Circular rate limit kontrol hatası:`, error.message);
    return true; // Hata durumunda devam et
  }
}

// ============================================================
// MAIN ADAPTER FUNCTION (Adapter Engine signature)
// ============================================================
export async function searchCircularAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  
  // Parse options (Adapter Engine format)
  const region = options.region || "TR";
  const signal = options.signal || null;
  const timeoutMs = options.timeoutMs || CIRCULAR_META.defaultTimeoutMs;
  const maxResults = options.maxResults || CIRCULAR_META.searchMaxResults;
  
  console.log(`🚗 Circular adapter çağrıldı: "${query}" (${region})`);

  try {
    // Rate limit kontrolü (Adapter Engine ile uyumlu)
    const rateLimitAllowed = await checkCircularRateLimit(region);
    if (!rateLimitAllowed) {
      throw new Error("Rate limit exceeded for Circular adapter");
    }
    
    const q = safe(query);
    if (!q) {
      return {
        ok: false,
        items: [],
        count: 0,
        error: "Empty query",
        query: query,
        provider: "circular",
        region: region
      };
    }
    
    const url = `https://www.circular.com/api/search?q=${encodeURIComponent(q)}`;

    
    let data = null;

    // Try proxy first (from proxyEngine)
    try {
      data = await proxyFetchJSON(url, {
        timeout: timeoutMs,
        signal,
        proxyRotation: true,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json",
          "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
          "Referer": "https://www.circular.com/",
          "DNT": "1"
        }
      });
    } catch (proxyError) {
      console.warn(`Circular proxy hatası: ${proxyError.message}`);
      
      // Fallback to direct axios request
      try {
        const response = await axios.get(url, {
          timeout: timeoutMs - 2000,
          signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json"
          }
        });
        data = response.data;
      } catch (axiosError) {
        console.warn(`Circular direct request hatası: ${axiosError.message}`);
        throw new Error(`Failed to fetch data: ${axiosError.message}`);
      }
    }

    if (!data) {
      throw new Error("No data received from Circular API");
    }

    // Extract items from data
    const rawItems = extractItemsFromData(data);
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return {
        ok: true,
        items: [],
        count: 0,
        query: query,
        provider: "circular",
        region: region,
        meta: {
          adapter: "circularAdapter",
          version: "S33_TITAN",
          responseTime: Date.now() - startTime,
          message: "No results found"
        }
      };
    }

    const out = [];

    for (const row of rawItems) {
      if (!row) continue;

      try {
        // Title extraction
        const title = safe(row.title) ||
                     safe(row.name) ||
                     safe(row.model) ||
                     safe(row.description) ||
                     safe(row.carModel) ;

        
        if (!title) continue;
// Price pipeline
        const rawPrice = parsePriceStrong(row.price) ||
                        parsePriceStrong(row.cost) ||
                        parsePriceStrong(row.amount) ||
                        parsePriceStrong(row.dailyPrice) ||
                        parsePriceStrong(row.pricePerDay) ||
                        parsePriceStrong(row.rate);

        const sanitized = sanitizePrice(rawPrice);
        const finalPrice = sanitized;

        // URL extraction
        const itemUrl = normalizeUrl(row.url) ||
                       normalizeUrl(row.link) ||
                       normalizeUrl(row.pageUrl) ||
                       normalizeUrl(row.detailUrl);

        // Image extraction
        const img = extractImage(row);
        const imageData = buildImageVariants(img || fallbackImage(title), "circular");

        // Stock detection
        const stock = detectStock(row);

        // Category inference
        const categoryAI = inferCategoryAI(title, row);

        // ID generation
        const id = stableId("circular", title, itemUrl, finalPrice);

        // Price optimization
        const optimizedPrice = finalPrice != null
          ? optimizePrice(
              { 
                price: finalPrice, 
                provider: "circular",
                category: categoryAI,
                title: title
              },
              { 
                provider: "circular", 
                region,
                category: "car_rental"
              }
            )
          : null;

        // Affiliate URL (Adapter Engine affiliateEngine)
        const affiliateData = {
          url: itemUrl,
          provider: "circular",
          title: title,
          price: finalPrice
        };
        
        const affiliateContext = {
          source: "circular_adapter",
          campaign: "organic_search",
          medium: "adapter_engine",
          region: region
        };
        
        const deeplink = itemUrl ? buildAffiliateUrl(affiliateData, affiliateContext) : null;

        // Additional rental info
        const dailyPrice = parsePriceStrong(row.dailyPrice) || finalPrice;
        const weeklyPrice = parsePriceStrong(row.weeklyPrice);
        const monthlyPrice = parsePriceStrong(row.monthlyPrice);
        
        const carType = safe(row.carType) || safe(row.vehicleType) || safe(row.type);
        const transmission = safe(row.transmission) || safe(row.gear);
        const fuelType = safe(row.fuelType) || safe(row.fuel);

        // Build item object (Adapter Engine format)
        const item = {
          // Core fields (required by Adapter Engine)
          id,
          title,
          provider: "circular",
         finalUrl: deeplink || itemUrl,

originUrl: itemUrl,
deeplink: deeplink,

          price: finalPrice,
          currency: "TRY",
          region,
          category: "car_rental",
          adapterSource: "circularAdapter",
          
          // Extended fields
          providerFamily: "circular",
          providerType: "car_rental",
          vertical: "car_rental",
          
          // Price info
          finalPrice,
          optimizedPrice,
          priceText: finalPrice ? `${finalPrice} TL/gün` : null,
          dailyPrice,
          weeklyPrice,
          monthlyPrice,
          
          // Car/rental specific info
          carType,
          transmission,
          fuelType,
          seats: row.seats || row.capacity,
          luggageCapacity: row.luggageCapacity || row.baggage,
          
          // Stock info
          stock,
          stockStatus: stock,
          
          // Image info
          image: imageData.image,
          imageOriginal: imageData.original || imageData.imageOriginal || null,

         imageProxy: imageData.proxy || imageData.imageProxy || null,
hasProxy: imageData.hasProxy === true,
imageVariants: imageData.variants || {},

          
          // Category info
          categoryAI,
          subCategory: categoryAI,
          tags: ["car_rental", "circular", categoryAI, carType].filter(Boolean),
          
          // Raw data (for debugging)
          raw: { 
            ...row,
            _extracted: true 
          },
          
          // Adapter Engine metadata
          _meta: {
            adapterVersion: "S33_TITAN",
            scrapeTime: Date.now() - startTime,
            region: region,
            isRentalService: true
          }
        };

        // Calculate quality score (Adapter Engine compatible)
        item.qualityScore = computeQualityScore(item);
        item.score = item.qualityScore; // Alias for Adapter Engine
        
        out.push(item);
        
        if (out.length >= maxResults) break;
        
      } catch (itemError) {
        console.warn(`Circular item parse hatası: ${itemError.message}`);
      }
    }

    // Sort by quality score (descending)
    out.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
    
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(true, totalTime, out.length);
    
    // Rate limit başarı istatistiğini güncelle
    const key = rateLimiter.createAdapterKey("circular", region, "car_rental");
    rateLimiter.registerSuccess(key, 1);
    
    console.log(`✅ Circular başarılı: ${out.length} araç (${totalTime}ms)`);
    
    // Return in Adapter Engine expected format
    return {
      ok: true,
      items: out,
      count: out.length,
      query: query,
      provider: "circular",
      region: region,
      meta: {
        adapter: "circularAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        rateLimitInfo: {
          limit: CIRCULAR_META.rateLimit.limit,
          windowMs: CIRCULAR_META.rateLimit.windowMs
        }
      }
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(false, totalTime, 0);
    
    // Rate limit hatası durumunda
    if (error.message.includes("Rate limit")) {
      const key = rateLimiter.createAdapterKey("circular", region, "car_rental");
      rateLimiter.registerError(key, 1);
    }
    
    console.error(`❌ CircularAdapter hata (${totalTime}ms):`, error.message);
    
    // Return error in Adapter Engine format
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      query: query,
      provider: "circular",
      region: region,
      meta: {
        adapter: "circularAdapter",
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
export function getCircularAdapterStats() {
  return {
    ...adapterMetrics,
    successRate: adapterMetrics.totalRequests > 0 
      ? (adapterMetrics.successfulRequests / adapterMetrics.totalRequests) * 100 
      : 0,
    rateLimitInfo: rateLimiter.getAdapterStats("circular"),
    timestamp: new Date().toISOString(),
    version: "S33_TITAN"
  };
}

export function resetCircularRateLimit(region = "TR") {
  return rateLimiter.resetAdapter("circular", region);
}

// ============================================================
// ADAPTER ENGINE COMPATIBILITY EXPORTS
// ============================================================

// Legacy function name for backward compatibility
export const searchCircular = searchCircularAdapter;

// Single item search (for testing/debugging)
export async function searchCircularScrape(query, options = {}) {
  const result = await searchCircularAdapter(query, options);
  return result.items || [];
}

// Adapter configuration for Adapter Engine registry
export const circularAdapterConfig = {
  // Required by Adapter Engine
  name: "circular",
  displayName: "Circular",
  fn: searchCircularAdapter,
  
  // Adapter Engine metadata
  meta: CIRCULAR_META,
  
  // Timeout configuration
  timeoutMs: CIRCULAR_META.defaultTimeoutMs,
  
  // Priority in Adapter Engine
  priorityWeight: 0.7,
  priority: 0.4,  

 // Categories for Adapter Engine routing
  categories: ["car_rental", "mobility", "transport", "rental"],
  
  // Tags for filtering
  tags: CIRCULAR_META.tags,
  
  // Region support
  supportedRegions: ["TR"],
  
  // Rate limit info for Adapter Engine
  rateLimit: CIRCULAR_META.rateLimit,
  
  // Adapter Engine version
  adapterEngineVersion: ">=S10",
  
  // Status
  status: "active",
  lastTested: new Date().toISOString().split('T')[0],
  
  // Special flags for Adapter Engine
  isRentalService: true,
  supportsDailyRates: true
};

// ============================================================
// DEFAULT EXPORT (Adapter Engine compatible)
// ============================================================
export default {
  // Main search function
  searchCircularAdapter,
  
  // Legacy alias
  searchCircular,
  
  // Scrape function
  searchCircularScrape,
  
  // Adapter configuration
  ...circularAdapterConfig,
  
  // Provider metadata
  CIRCULAR_META,
  
  // Statistics functions
  getCircularAdapterStats,
  resetCircularRateLimit,
  
  // Adapter Engine registration helper
  register: () => circularAdapterConfig
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
export async function searchCircularAdapter(query, options = {}) {
  const providerKey = "circular";
  const started = __s200_now();
  const timeoutMs =
    Number(options?.timeoutMs) ||
    Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
    9000;

  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "circularAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const raw = await withTimeout(
      () => searchCircularAdapterLegacy(query, options),
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
