// server/adapters/dentalAdapter.js
// =======================================================================
//  Türkiye Diş Klinikleri — S33 TITAN+ FINAL + ADAPTER ENGINE TAM UYUMLU
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

// ============================================================
// ADAPTER ENGINE COMPATIBILITY LAYER
// ============================================================

// PROVIDER META (Adapter Engine formatı)
export const DENTAL_META = {
  name: "dental",
  displayName: "Diş Klinikleri",
  provider: "dental",
  providerFamily: "health",
  providerType: "dental",
  vertical: "health",
  category: "health",
  subCategory: ["dental", "medical", "healthcare"],
  
  country: "TR",
  regionAffinity: ["TR"],
  language: "tr",
  
  // Adapter Engine scoring
  providerScore: 0.70,
  priorityWeight: 1.05,
  commissionRateHint: 0.015, // Sağlıkta komisyon düşük
  trustScore: 0.85, // Sağlık yüksek güven
  
  // Capabilities
  affiliateCapable: false, // Sağlıkta affiliate genelde yok
  hasImages: true,
  hasPrices: true,
  hasStockInfo: false, // Sağlıkta stock yok
  hasRatings: true,
  hasAppointments: true,
  
  // Rate limit (Sağlık için düşük limit)
  rateLimit: {
    limit: 6,
    windowMs: 60000,
    burst: false,
    adaptive: true,
    category: "health"
  },
  
  // Tags for categorization
  tags: ["dental", "health", "medical", "clinic", "turkey", "healthcare"],
  
  // Timeout settings
  defaultTimeoutMs: 18000, // Sağlık servisleri yavaş olabilir
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
  clinicsFound: 0,
  rateLimitBlocks: 0
};

function updateMetrics(success = true, responseTime = 0, itemsCount = 0) {
  adapterMetrics.totalRequests++;
  adapterMetrics.lastRequestTime = Date.now();
  
  if (success) {
    adapterMetrics.successfulRequests++;
    adapterMetrics.clinicsFound += itemsCount;
    
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
// DENTAL PROVIDER CONFIGURATIONS
// ============================================================
const DENTAL_PROVIDERS = {
  dentgroup: {
    name: "dentgroup",
    displayName: "DentGroup",
    baseUrl: "https://www.dentgroup.com.tr",
    searchPath: "/arama?kelime=",
    timeoutMs: 15000,
    priority: 1.1,
    trustScore: 0.82
  },
  hospitadent: {
    name: "hospitadent",
    displayName: "Hospitadent",
    baseUrl: "https://www.hospitadent.com",
    searchPath: "/tr/arama?search=",
    timeoutMs: 15000,
    priority: 1.0,
    trustScore: 0.80
  },
  dentistanbul: {
    name: "dentistanbul",
    displayName: "Dentİstanbul",
    baseUrl: "https://www.dentistanbul.com.tr",
    searchPath: "/arama?kelime=",
    timeoutMs: 15000,
    priority: 1.05,
    trustScore: 0.83
  },
  dentalpark: {
    name: "dentalpark",
    displayName: "DentalPark",
    baseUrl: "https://www.dentalpark.com.tr",
    searchPath: "/arama?search=",
    timeoutMs: 15000,
    priority: 1.0,
    trustScore: 0.81
  }
};

// ============================================================
// CORE HELPERS (Adapter Engine uyumlu)
// ============================================================
const safe = (v) => (v != null ? String(v).trim() : "");

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

function parseRatingStrong(txt) {
  if (!txt) return null;
  try {
    const cleaned = txt.replace(",", ".").replace(/[^\d.]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 && n <= 5.1 ? n : null;
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
  const slug = slugify(title || "dental");
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
// DENTAL CATEGORY INFERENCE
// ============================================================
function inferDentalService(title) {
  const t = safe(title).toLowerCase();
  
  // Dental procedure detection
  if (t.includes("implant") || t.includes("diş implantı")) {
    return "implant";
  }
  
  if (t.includes("kanal tedavisi") || t.includes("kanal") || t.includes("root canal")) {
    return "root_canal";
  }
  
  if (t.includes("diş beyazlatma") || t.includes("bleaching") || t.includes("whitening")) {
    return "teeth_whitening";
  }
  
  if (t.includes("ortodonti") || t.includes("braket") || t.includes("tel tedavisi")) {
    return "orthodontics";
  }
  
  if (t.includes("diş eti") || t.includes("periodontoloji") || t.includes("gingival")) {
    return "periodontology";
  }
  
  if (t.includes("protez") || t.includes("denture") || t.includes("crown")) {
    return "prosthesis";
  }
  
  if (t.includes("pedodonti") || t.includes("çocuk diş") || t.includes("child dental")) {
    return "pedodontics";
  }
  
  if (t.includes("çekim") || t.includes("extraction") || t.includes("diş çekimi")) {
    return "extraction";
  }
  
  if (t.includes("dolgu") || t.includes("filling") || t.includes("restoration")) {
    return "filling";
  }
  
  if (t.includes("check-up") || t.includes("kontrol") || t.includes("muayene")) {
    return "checkup";
  }
  
  if (t.includes("estetik") || t.includes("cosmetic") || t.includes("gülüş tasarımı")) {
    return "cosmetic_dentistry";
  }
  
  if (t.includes("cerrahi") || t.includes("surgical") || t.includes("operation")) {
    return "surgical";
  }
  
  return "general_dentistry";
}

// ============================================================
// QUALITY SCORE (Dental özel scoring)
// ============================================================
function computeDentalQualityScore(item) {
  let score = 0.0;
  
  // Title quality (0-0.30)
  if (item.title && item.title.length > 3) {
    score += 0.30;
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
  
  // Rating (0-0.15)
  if (item.rating != null && item.rating > 0) {
    score += Math.min(0.15, item.rating * 0.03);
  }
  
  // Service specificity (0-0.05)
  if (item.serviceType !== "general_dentistry") {
    score += 0.05;
  }
  
  // Provider trust bonus
  const providerConfig = DENTAL_PROVIDERS[item.provider];
  if (providerConfig) {
    score += providerConfig.trustScore * 0.1;
  }
  
  // Cap to 1.0
  return Math.min(1.0, score);
}

// ============================================================
// URL NORMALIZATION
// ============================================================
function normalizeUrl(u, baseUrl) {
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
function fallbackDentalImage(title) {
  const q = encodeURIComponent(title || "dental clinic");
  return `https://source.unsplash.com/featured/?dental,clinic,medical,${q}`;
}

function extractDentalImage(root) {
  let img = safe(root.find("img").attr("data-src")) ||
           safe(root.find("img").attr("src")) ||
           safe(root.find("img").attr("data-original")) ||
           safe(root.attr("data-image"));
  
  // Image normalization
  if (img?.startsWith("//")) img = "https:" + img;
  
  return img;
}

// ============================================================
// RELEVANCE FILTER (Dental özel)
// ============================================================
function isRelevantDentalItem(title, query) {
  if (!query) return true;
  
  const t = safe(title).toLowerCase();
  const q = safe(query).toLowerCase();
  
  // Exact match
  if (t.includes(q)) {
    return true;
  }
  
  // Dental-specific terms matching
  const dentalTerms = [
    "diş", "dental", "implant", "kanal", "ortodonti", "protez",
    "beyazlatma", "çekim", "dolgu", "estetik", "cerrahi", "klinik",
    "hastane", "muayene", "check-up", "tedavi", "tedavisi"
  ];
  
  const queryTerms = q.split(/\s+/).filter(term => term.length > 2);
  
  for (const term of queryTerms) {
    if (dentalTerms.includes(term)) {
      if (t.includes(term)) {
        return true;
      }
    }
  }
  
  return false;
}

// ============================================================
// RATE LIMIT HELPER (Dental özel - düşük limit)
// ============================================================
async function checkDentalRateLimit(region = "TR") {
  const adapterName = "dental";
  const category = "health";
  
  try {
    const key = rateLimiter.createAdapterKey(adapterName, region, category);
    const allowed = await rateLimiter.check(key, {
      provider: adapterName,
      limit: DENTAL_META.rateLimit.limit,
      windowMs: DENTAL_META.rateLimit.windowMs,
      burst: DENTAL_META.rateLimit.burst,
      adaptive: DENTAL_META.rateLimit.adaptive
    });
    
    if (!allowed) {
      console.warn(`⛔ Dental rate limit aşıldı: ${region}`);
      adapterMetrics.rateLimitBlocks++;
      return false;
    }
    
    return true;
  } catch (error) {
    console.warn(`⚠️ Dental rate limit kontrol hatası:`, error.message);
    return true; // Hata durumunda devam et
  }
}

// ============================================================
// PROVIDER SCRAPER (Generic for all dental providers)
// ============================================================
async function scrapeDentalProvider(providerConfig, query, region = "TR", signal = null) {
  const startTime = Date.now();
  
  const url = `${providerConfig.baseUrl}${providerConfig.searchPath}${encodeURIComponent(query)}`;
  
  let html = null;

  // Try proxy first
  try {
    html = await proxyFetchHTML(url, {
      timeout: providerConfig.timeoutMs,
      signal,
      proxyRotation: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": providerConfig.baseUrl + "/",
        "DNT": "1"
      }
    });
  } catch (proxyError) {
    console.warn(`${providerConfig.displayName} proxy hatası: ${proxyError.message}`);
    
    // Fallback to direct axios request
    try {
      const response = await axios.get(url, {
        timeout: providerConfig.timeoutMs - 2000,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
        }
      });
      html = response.data;
    } catch (axiosError) {
      console.warn(`${providerConfig.displayName} direct request hatası: ${axiosError.message}`);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const items = [];

  // Dental clinic selectors
  const selectors = [
    ".service-item",
    ".service-box",
    ".treatment-card",
    ".service-card",
    ".clinic-item",
    ".doctor-card",
    ".treatment-item",
    "article.service",
    ".col-md-4",
    ".col-lg-3",
    "[data-service-id]"
  ];

  $(selectors.join(",")).each((i, el) => {
    try {
      const root = $(el);

      // Title extraction
      const titleRaw =
        safe(root.find(".title").text()) ||
        safe(root.find("h3").text()) ||
        safe(root.find(".service-title").text()) ||
        safe(root.find(".treatment-title").text()) ||
        safe(root.find(".name").text());
      
      if (!titleRaw || titleRaw.length < 3) return;
      
      // Relevance filter
      if (!isRelevantDentalItem(titleRaw, query)) {
        return;
      }

      // Price extraction
      const priceText =
        safe(root.find(".price").text()) ||
        safe(root.find(".service-price").text()) ||
        safe(root.find(".treatment-price").text()) ||
        safe(root.find(".amount").text()) ||
        safe(root.find("[data-price]").attr("data-price"));

      const priceRaw = parsePriceStrong(priceText);
      const price = sanitizePrice(priceRaw);

      // URL extraction
      let href =
        safe(root.find("a").attr("href")) ||
        safe(root.find(".service-link").attr("href")) ||
        safe(root.find(".read-more").attr("href"));
      
      if (!href) return;
      
      const normalizedUrl = normalizeUrl(href, providerConfig.baseUrl);
      if (!normalizedUrl) return;

      // Image extraction
      const img = extractDentalImage(root);
      const imageData = buildImageVariants(img || fallbackDentalImage(titleRaw), providerConfig.name);

      // Rating extraction
      const ratingText =
        safe(root.find(".rating").text()) ||
        safe(root.find(".review-score").text()) ||
        safe(root.find(".star-rating").text()) ||
        safe(root.find("[data-rating]").attr("data-rating"));
      
      const rating = parseRatingStrong(ratingText);

      // Service type inference
      const serviceType = inferDentalService(titleRaw);

      // ID generation
      const id = stableId(providerConfig.name, titleRaw, normalizedUrl, price);

      // Price optimization (sağlık hizmetleri için)
      const optimizedPrice = price != null
        ? optimizePrice(
            { 
              price, 
              provider: providerConfig.name,
              category: serviceType,
              title: titleRaw
            },
            { 
              provider: providerConfig.name, 
              region,
              category: "health"
            }
          )
        : null;

      // Affiliate URL (sağlıkta genelde yok, ama contact link olabilir)
      const affiliateData = {
        url: normalizedUrl,
        provider: providerConfig.name,
        title: titleRaw,
        price: price,
        serviceType: serviceType
      };
      
      const affiliateContext = {
        source: "dental_adapter",
        campaign: "health_search",
        medium: "adapter_engine",
        region: region
      };
      
      const deeplink = buildAffiliateUrl(affiliateData, affiliateContext) || normalizedUrl;

      // Build item object
     const item = {
  // Core fields
  id,
  title: titleRaw,
  provider: providerConfig.name,

  // 🔥 ZORUNLU S200 ÜÇLÜSÜ
  originUrl: normalizedUrl,
  finalUrl: deeplink || normalizedUrl,
  deeplink,
  url: normalizedUrl,

  price,
  currency: "TRY",
  region,
  category: "health",
  adapterSource: "dentalAdapter",

        
        // Extended fields
        providerFamily: "health",
        providerType: "dental",
        vertical: "health",
        
        // Price info
        finalPrice: price,
        optimizedPrice,
        priceText: priceText,
        
        // Dental-specific info
        serviceType,
        rating,
        
        // Location/contact info (if available)
        location: safe(root.find(".location").text()) ||
                 safe(root.find(".address").text()) ||
                 safe(root.find(".city").text()),
        
        // Image info
        image: imageData.image,
        imageOriginal: imageData.imageOriginal,
        imageProxy: imageData.imageProxy,
        hasProxy: imageData.hasProxy === true,
        imageVariants: imageData.variants || {},
        
        // Tags
        tags: ["dental", "health", providerConfig.name, serviceType].filter(Boolean),
        
        // Raw data
        raw: { 
          href,
          priceText,
          ratingText,
          img,
          elementIndex: i 
        },
        
        // Metadata
        _meta: {
          adapterVersion: "S33_TITAN",
          scrapeTime: Date.now() - startTime,
          provider: providerConfig.name,
          region: region,
          isHealthcare: true
        }
      };

      // Calculate quality score
      item.qualityScore = computeDentalQualityScore(item);
      item.score = item.qualityScore;
      
      items.push(item);
      
    } catch (itemError) {
      console.warn(`${providerConfig.displayName} item parse hatası: ${itemError.message}`);
    }
  });

  return items;
}

// ============================================================
// MAIN ADAPTER FUNCTION (Adapter Engine signature)
// ============================================================
export async function searchDentalAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  
  // Parse options
  const region = options.region || "TR";
  const signal = options.signal || null;
  const timeoutMs = options.timeoutMs || DENTAL_META.defaultTimeoutMs;
  const maxResults = options.maxResults || DENTAL_META.searchMaxResults;
  
  console.log(`🦷 Dental adapter çağrıldı: "${query}" (${region})`);

  try {
    // Rate limit kontrolü (sağlık için düşük limit)
    const rateLimitAllowed = await checkDentalRateLimit(region);
    if (!rateLimitAllowed) {
      throw new Error("Rate limit exceeded for Dental adapter");
    }
    
    const q = safe(query);
    if (!q) {
      return {
        ok: false,
        items: [],
        count: 0,
        error: "Empty query",
        query: query,
        provider: "dental",
        region: region
      };
    }
    
    // Scrape all dental providers in parallel with individual timeouts
    const scrapePromises = Object.values(DENTAL_PROVIDERS).map(async (provider) => {
      try {
        return await scrapeDentalProvider(provider, q, region, signal);
      } catch (providerError) {
        console.warn(`${provider.displayName} scrape hatası: ${providerError.message}`);
        return [];
      }
    });
    
    const providerResults = await Promise.allSettled(scrapePromises);
    
    let allItems = [];
    
    // Combine all results
    providerResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        allItems = allItems.concat(result.value);
      }
    });
    
    // Sort by quality score
    allItems.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
    
    // Limit results
    if (allItems.length > maxResults) {
      allItems = allItems.slice(0, maxResults);
    }
    
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(true, totalTime, allItems.length);
    
    // Rate limit başarı istatistiğini güncelle
    const key = rateLimiter.createAdapterKey("dental", region, "health");
    rateLimiter.registerSuccess(key, 1);
    
    console.log(`✅ Dental başarılı: ${allItems.length} klinik/hizmet (${totalTime}ms)`);
    
    // Return in Adapter Engine format
    return {
      ok: true,
      items: allItems,
      count: allItems.length,
      query: query,
      provider: "dental",
      region: region,
      meta: {
        adapter: "dentalAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        providersScraped: Object.keys(DENTAL_PROVIDERS).length,
        providersSuccessful: providerResults.filter(r => r.status === 'fulfilled').length,
        rateLimitInfo: {
          limit: DENTAL_META.rateLimit.limit,
          windowMs: DENTAL_META.rateLimit.windowMs
        }
      }
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(false, totalTime, 0);
    
    // Rate limit hatası durumunda
    if (error.message.includes("Rate limit")) {
      const key = rateLimiter.createAdapterKey("dental", region, "health");
      rateLimiter.registerError(key, 1);
    }
    
    console.error(`❌ DentalAdapter hata (${totalTime}ms):`, error.message);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      query: query,
      provider: "dental",
      region: region,
      meta: {
        adapter: "dentalAdapter",
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
export function getDentalAdapterStats() {
  return {
    ...adapterMetrics,
    successRate: adapterMetrics.totalRequests > 0 
      ? (adapterMetrics.successfulRequests / adapterMetrics.totalRequests) * 100 
      : 0,
    rateLimitInfo: rateLimiter.getAdapterStats("dental"),
    timestamp: new Date().toISOString(),
    version: "S33_TITAN",
    providers: Object.keys(DENTAL_PROVIDERS)
  };
}

export function resetDentalRateLimit(region = "TR") {
  return rateLimiter.resetAdapter("dental", region);
}

// ============================================================
// INDIVIDUAL PROVIDER FUNCTIONS (Legacy support)
// ============================================================
export async function searchDentGroup(query, options = {}) {
  const provider = DENTAL_PROVIDERS.dentgroup;
  const results = await scrapeDentalProvider(provider, query, options.region || "TR", options.signal);
  return {
    ok: true,
    items: results,
    count: results.length,
    provider: provider.name,
    query
  };
}

export async function searchHospitadent(query, options = {}) {
  const provider = DENTAL_PROVIDERS.hospitadent;
  const results = await scrapeDentalProvider(provider, query, options.region || "TR", options.signal);
  return {
    ok: true,
    items: results,
    count: results.length,
    provider: provider.name,
    query
  };
}

export async function searchDentIstanbul(query, options = {}) {
  const provider = DENTAL_PROVIDERS.dentistanbul;
  const results = await scrapeDentalProvider(provider, query, options.region || "TR", options.signal);
  return {
    ok: true,
    items: results,
    count: results.length,
    provider: provider.name,
    query
  };
}

export async function searchDentalPark(query, options = {}) {
  const provider = DENTAL_PROVIDERS.dentalpark;
  const results = await scrapeDentalProvider(provider, query, options.region || "TR", options.signal);
  return {
    ok: true,
    items: results,
    count: results.length,
    provider: provider.name,
    query
  };
}

// ============================================================
// ADAPTER ENGINE COMPATIBILITY EXPORTS
// ============================================================

// Legacy function names
export const searchDental = searchDentalAdapter;
export const searchDentalScrape = searchDentalAdapter;

// Adapter configuration
export const dentalAdapterConfig = {
  name: "dental",
  displayName: "Diş Klinikleri",
  fn: searchDentalAdapter,
  meta: DENTAL_META,
  timeoutMs: DENTAL_META.defaultTimeoutMs,
  priority: 0.38,
priorityWeight: DENTAL_META.priorityWeight,

  categories: ["health", "dental", "medical", "healthcare"],
  tags: DENTAL_META.tags,
  supportedRegions: ["TR"],
  rateLimit: DENTAL_META.rateLimit,
  adapterEngineVersion: ">=S10",
  status: "active",
  lastTested: new Date().toISOString().split('T')[0],
  isHealthcareService: true,
  isMultiProvider: true
};

// ============================================================
// DEFAULT EXPORT
// ============================================================
export default {
  searchDentalAdapter,
  searchDental,
  searchDentalScrape,
  // Individual provider functions
  searchDentGroup,
  searchHospitadent,
  searchDentIstanbul,
  searchDentalPark,
  // Adapter configuration
  ...dentalAdapterConfig,
  DENTAL_META,
  DENTAL_PROVIDERS,
  getDentalAdapterStats,
  resetDentalRateLimit,
  register: () => dentalAdapterConfig
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
export async function searchDentalAdapter(query, options = {}) {
  const providerKey = "dental";
  const started = __s200_now();
  const timeoutMs =
    Number(options?.timeoutMs) ||
    Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
    9000;

  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "dentalAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const raw = await withTimeout(
      () => searchDentalAdapterLegacy(query, options),
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
