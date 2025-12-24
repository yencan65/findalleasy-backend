// server/adapters/coldwellAdapter.js
// =======================================================================
//  Coldwell Banker — S33 TITAN+ FINAL MAX + ADAPTER ENGINE TAM UYUMLU
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
export const COLDWELL_META = {
  name: "coldwell",
  displayName: "Coldwell Banker",
  provider: "coldwell",
  providerFamily: "coldwell",
  providerType: "real_estate",
  vertical: "estate",
  category: "estate",
  subCategory: ["luxury", "commercial", "residential"],
  
  country: "TR",
  regionAffinity: ["TR"],
  language: "tr",
  
  // Adapter Engine scoring
  providerScore: 0.75,
  priorityWeight: 1.15,
  commissionRateHint: 0.025,
  trustScore: 0.80,
  
  // Capabilities
  affiliateCapable: true,
  hasImages: true,
  hasPrices: true,
  hasStockInfo: false, // Emlakta stock yok
  hasRatings: false,
  hasPropertyDetails: true,
  
  // Rate limit (Adapter Engine ile senkron)
  rateLimit: {
    limit: 8,
    windowMs: 60000,
    burst: false,
    adaptive: true,
    category: "estate"
  },
  
  // Tags for categorization
  tags: ["real_estate", "luxury", "property", "emlak", "turkey", "estate_agent"],
  
  // Timeout settings
  defaultTimeoutMs: 15000,
  searchMaxResults: 40,
  
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
  propertiesFound: 0,
  rateLimitBlocks: 0
};

function updateMetrics(success = true, responseTime = 0, itemsCount = 0) {
  adapterMetrics.totalRequests++;
  adapterMetrics.lastRequestTime = Date.now();
  
  if (success) {
    adapterMetrics.successfulRequests++;
    adapterMetrics.propertiesFound += itemsCount;
    
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
function safe(v) {
  return v != null ? String(v).trim() : "";
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
  const slug = slugify(title || "property");
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

function parsePriceStrong(text) {
  if (!text) return null;
  try {
    const clean = text
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(clean);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function parseMeters(text) {
  if (!text) return null;
  const n = Number(text.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseRooms(text) {
  if (!text) return null;
  const match = text.match(/(\d+)\s*(oda|odalı|room|bedroom)/i);
  if (!match) return null;
  return Number(match[1]);
}

// ============================================================
// CATEGORY INFERENCE (Emlak özel)
// ============================================================
function inferPropertyType(title, location, price) {
  const t = safe(title).toLowerCase();
  const l = safe(location).toLowerCase();
  
  // Satılık/Kiralık detection
  const isForSale = t.includes("satılık") || t.includes("satilik") || 
                    t.includes("for sale") || t.includes("sale");
  const isForRent = t.includes("kiralık") || t.includes("kiralik") || 
                    t.includes("for rent") || t.includes("rental");
  
  // Property type detection
  if (t.includes("daire") || t.includes("apartman") || t.includes("apartment") ||
      t.includes("rezidans") || t.includes("residence")) {
    return isForSale ? "apartment_sale" : isForRent ? "apartment_rent" : "apartment";
  }
  
  if (t.includes("villa") || t.includes("müstakil") || t.includes("house") ||
      t.includes("ev") || t.includes("konut")) {
    return isForSale ? "house_sale" : isForRent ? "house_rent" : "house";
  }
  
  if (t.includes("arsa") || t.includes("tarla") || t.includes("land") ||
      t.includes("plot")) {
    return "land";
  }
  
  if (t.includes("işyeri") || t.includes("ofis") || t.includes("dükkan") ||
      t.includes("mağaza") || t.includes("commercial") || t.includes("office")) {
    return "commercial";
  }
  
  // Luxury detection
  if (t.includes("lüks") || t.includes("luxury") || t.includes("premium") ||
      t.includes("seaview") || t.includes("deniz manzaralı") || 
      (price && price > 5000000)) {
    return "luxury";
  }
  
  return "property";
}

// ============================================================
// LOCATION INFERENCE (Şehir/İlçe çıkarımı)
// ============================================================
function inferLocation(title, rawLocation) {
  const locations = [
    "istanbul", "ankara", "izmir", "antalya", "bursa", "adana", "konya",
    "mersin", "kocaeli", "muğla", "eskişehir", "trabzon", "samsun",
    "beşiktaş", "kadıköy", "şişli", "beşiktaş", "ataşehir", "beylikdüzü",
    "çankaya", "keçiören", "yenimahalle", "bornova", "karşıyaka", "konak",
    "konyaaltı", "muratreis", "kepez", "osmangazi", "nilüfer", "yıldırım",
    "seyhan", "yüreğir", "çukurova", "selçuklu", "meram", "karatay",
    "akdeniz", "toroslar", "yenişehir", "mevlana", "tekkeköy", "ilkadım"
  ];
  
  const text = (safe(title) + " " + safe(rawLocation)).toLowerCase();
  
  for (const loc of locations) {
    if (text.includes(loc)) {
      return loc.charAt(0).toUpperCase() + loc.slice(1);
    }
  }
  
  return rawLocation || null;
}

// ============================================================
// QUALITY SCORE (Emlak özel scoring)
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
    if (item.hasProxy === true) score += 0.05;

  }
  
  // Property details (0-0.15)
  if (item.size) score += 0.05;
  if (item.rooms) score += 0.05;
  if (item.location) score += 0.05;
  
  // Property type specificity (0-0.05)
  if (item.propertyType && !item.propertyType.includes("property")) {
    score += 0.05;
  }
  
  // Provider trust bonus (from COLDWELL_META)
  score += COLDWELL_META.providerScore * 0.1;
  
  // Cap to 1.0
  return Math.min(1.0, score);
}

// ============================================================
// URL NORMALIZATION
// ============================================================
function normalizeUrl(u, baseUrl = "https://www.coldwellbanker.com.tr") {
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
  const q = encodeURIComponent(title || "property real estate");
  return `https://source.unsplash.com/featured/?house,property,estate,${q}`;
}

function extractImage(root) {
  let img = safe(root.find("img").attr("data-src")) ||
           safe(root.find("img").attr("src")) ||
           safe(root.find("img").attr("data-original")) ||
           safe(root.attr("data-image"));
  
  // Image normalization
  if (img?.startsWith("//")) img = "https:" + img;
  if (img?.startsWith("/")) img = "https://www.coldwellbanker.com.tr" + img;
  
  return img;
}

// ============================================================
// RELEVANCE FILTER
// ============================================================
function isRelevant(item, query) {
  if (!query) return true;

  const q = safe(query).toLowerCase();
  const title = safe(item.title).toLowerCase();
  const location = safe(item.location).toLowerCase();
  const propertyType = safe(item.propertyType).toLowerCase();

  // Exact match
  if (title.includes(q) || location.includes(q)) {
    return true;
  }

  const realEstateTerms = ["daire", "ev", "villa", "arsa", "işyeri", "ofis"];
  const queryTerms = q.split(/\s+/).filter(term => term.length > 2);

  for (const term of queryTerms) {
    if (
      title.includes(term) ||
      location.includes(term) ||
      propertyType.includes(term)
    ) {
      return true;
    }
  }

  return false;
}


// ============================================================
// RATE LIMIT HELPER
// ============================================================
async function checkColdwellRateLimit(region = "TR") {
  const adapterName = "coldwell";
  const category = "estate";
  
  try {
    const key = rateLimiter.createAdapterKey(adapterName, region, category);
    const allowed = await rateLimiter.check(key, {
      provider: adapterName,
      limit: COLDWELL_META.rateLimit.limit,
      windowMs: COLDWELL_META.rateLimit.windowMs,
      burst: COLDWELL_META.rateLimit.burst,
      adaptive: COLDWELL_META.rateLimit.adaptive
    });
    
    if (!allowed) {
      console.warn(`⛔ Coldwell rate limit aşıldı: ${region}`);
      adapterMetrics.rateLimitBlocks++;
      return false;
    }
    
    return true;
  } catch (error) {
    console.warn(`⚠️ Coldwell rate limit kontrol hatası:`, error.message);
    return true; // Hata durumunda devam et
  }
}

// ============================================================
// PAGE SCRAPER
// ============================================================
async function scrapeColdwellPage(query, page = 1, region = "TR", signal = null) {
  const startTime = Date.now();
  
  const url = `https://www.coldwellbanker.com.tr/tr/arama?kelime=${encodeURIComponent(
    query
  )}&sayfa=${page}`;

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
        "Referer": "https://www.coldwellbanker.com.tr/",
        "DNT": "1"
      }
    });
  } catch (proxyError) {
    console.warn(`Coldwell proxy hatası: ${proxyError.message}`);
    
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
      console.warn(`Coldwell direct request hatası: ${axiosError.message}`);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const items = [];

  // Coldwell specific selectors
  const selectors = [
    ".ilan",
    ".listing-item",
    ".property-box",
    ".result-item",
    ".estate-card",
    ".realty-item",
    ".property-item",
    ".col-md-4",
    "article.property",
    "[data-property-id]"
  ];

  $(selectors.join(",")).each((i, el) => {
    try {
      const root = $(el);

      // Title extraction
      const titleRaw =
        safe(root.find(".ilan-baslik").text()) ||
        safe(root.find(".listing-title").text()) ||
        safe(root.find(".property-title").text()) ||
        safe(root.find(".title").text()) ||
        safe(root.find("h3").text()) ||
        safe(root.find("h2").text());
      
      if (!titleRaw || titleRaw.length < 3) return;

      // Price extraction
      const priceText =
        safe(root.find(".ilan-fiyat").text()) ||
        safe(root.find(".price").text()) ||
        safe(root.find(".property-price").text()) ||
        safe(root.find("[data-price]").attr("data-price"));

      const priceRaw = parsePriceStrong(priceText);
      const price = sanitizePrice(priceRaw);

      // URL extraction
      let href =
        safe(root.find("a").attr("href")) ||
        safe(root.find(".listing-link").attr("href")) ||
        safe(root.find(".property-link").attr("href"));
      
      if (!href) return;
      
      const normalizedUrl = normalizeUrl(href);
      if (!normalizedUrl) return;

      // Image extraction
      const img = extractImage(root);
      const imageData = buildImageVariants(img || fallbackImage(titleRaw), "coldwell");

      // Property details
      const rooms = parseRooms(
        safe(root.find(".oda-sayisi").text()) ||
        safe(root.find(".rooms").text()) ||
        safe(root.find(".bedrooms").text())
      );

      const size = parseMeters(
        safe(root.find(".metrekare").text()) ||
        safe(root.find(".size").text()) ||
        safe(root.find(".area").text()) ||
        safe(root.find("[data-area]").attr("data-area"))
      );

      const locationRaw =
        safe(root.find(".konum").text()) ||
        safe(root.find(".location").text()) ||
        safe(root.find(".address").text()) ||
        safe(root.find(".neighborhood").text());

      const location = inferLocation(titleRaw, locationRaw);

      // Property type inference
      const propertyType = inferPropertyType(titleRaw, location, price);

      // ID generation
      const id = stableId("coldwell", titleRaw, normalizedUrl, price);

      // Price optimization
      const optimizedPrice = price != null
        ? optimizePrice(
            { 
              price, 
              provider: "coldwell",
              category: propertyType,
              title: titleRaw,
              size: size
            },
            { 
              provider: "coldwell", 
              region,
              category: "estate"
            }
          )
        : null;

      // Affiliate URL
      const affiliateData = {
        url: normalizedUrl,
        provider: "coldwell",
        title: titleRaw,
        price: price,
        propertyType: propertyType
      };
      
      const affiliateContext = {
        source: "coldwell_adapter",
        campaign: "property_search",
        medium: "adapter_engine",
        region: region
      };
      
      const deeplink = buildAffiliateUrl(affiliateData, affiliateContext);

      // Build item object
      const item = {
        // Core fields (Adapter Engine)
        id,
        title: titleRaw,
        provider: "coldwell",
        originUrl: normalizedUrl,
finalUrl: deeplink || normalizedUrl,
deeplink,
url: normalizedUrl,

        price,
        currency: "TRY",
        region,
        category: "estate",
        adapterSource: "coldwellAdapter",
        
        // Extended fields
        providerFamily: "coldwell",
        providerType: "real_estate",
        vertical: "estate",
        
        // Price info
        finalPrice: price,
        optimizedPrice,
        priceText: priceText,
        
        // Property details
        propertyType,
        rooms,
        size,
        location,
        
        // Image info
        image: imageData.image,
        imageOriginal: imageData.original || imageData.imageOriginal || null,

        imageProxy: imageData.proxy || imageData.imageProxy || null,

        hasProxy: imageData.hasProxy === true,

        imageVariants: imageData.variants || {},
        
        // Tags
        tags: ["real_estate", "coldwell", propertyType].filter(Boolean),
        
        // Raw data
        raw: { 
          href,
          priceText,
          img,
          rooms,
          size,
          locationRaw,
          elementIndex: i 
        },
        
        // Metadata
        _meta: {
          adapterVersion: "S33_TITAN",
          scrapeTime: Date.now() - startTime,
          page: page,
          region: region,
          isRealEstate: true
        }
      };

      // Calculate quality score
      item.qualityScore = computeQualityScore(item);
      item.score = item.qualityScore;
      
      // Relevance filter
      if (isRelevant(item, query)) {
        items.push(item);
      }
      
    } catch (itemError) {
      console.warn(`Coldwell item parse hatası: ${itemError.message}`);
    }
  });

  return items;
}

// ============================================================
// JSON FALLBACK API
// ============================================================
async function fetchColdwellJsonFallback(query, region = "TR", signal = null) {
  try {
    const url = `https://www.coldwellbanker.com.tr/api/properties?text=${encodeURIComponent(
      query
    )}&page=1&region=${region}`;

    const response = await axios.get(url, {
      signal,
      timeout: 10000,
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    });

    const data = response.data;
    const list = data?.data || data?.results || [];
    
    if (!Array.isArray(list)) return [];

    return list.map((p) => {
      const title = safe(p.title) || safe(p.name) || `Coldwell Property ${p.id}`;
      const price = parsePriceStrong(p.price);
      const url = normalizeUrl(p.url || p.link);
      const propertyType = inferPropertyType(title, p.location, price);
      
      const item = {
    id: stableId("coldwell", title, url, price),
    title,
    provider: "coldwell",

    // URL fields — JSON fallback MUST have these
    originUrl: url,
    finalUrl: url,
    deeplink: url,

    url,
    price,
    currency: p.currency || "TRY",
    region: p.region || region,
    category: "estate",
    adapterSource: "coldwellAdapter_json",

        
        propertyType,
        rooms: parseRooms(p.rooms),
        size: parseMeters(p.size || p.area),
        location: inferLocation(title, p.location),
        
        image: p.image || p.thumbnail,
        imageOriginal: p.image || p.thumbnail,
        
        raw: p,
        
        _meta: {
          adapterVersion: "S33_TITAN",
          source: "json_api",
          isRealEstate: true
        }
      };
      
      item.qualityScore = computeQualityScore(item);
      item.score = item.qualityScore;
      
      return item;
    });
  } catch (error) {
    console.warn("Coldwell JSON fallback hatası:", error.message);
    return [];
  }
}

// ============================================================
// MAIN ADAPTER FUNCTION (Adapter Engine signature)
// ============================================================
export async function searchColdwellAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  
  // Parse options
  const region = options.region || "TR";
  const signal = options.signal || null;
  const timeoutMs = options.timeoutMs || COLDWELL_META.defaultTimeoutMs;
  const maxResults = options.maxResults || COLDWELL_META.searchMaxResults;
  const maxPages = options.maxPages || 3;
  
  console.log(`🏠 Coldwell adapter çağrıldı: "${query}" (${region})`);

  try {
    // Rate limit kontrolü
    const rateLimitAllowed = await checkColdwellRateLimit(region);
    if (!rateLimitAllowed) {
      throw new Error("Rate limit exceeded for Coldwell adapter");
    }
    
    const q = safe(query);
    if (!q) {
      return {
        ok: false,
        items: [],
        count: 0,
        error: "Empty query",
        query: query,
        provider: "coldwell",
        region: region
      };
    }
    
    let allItems = [];
    
    // Multi-page scraping
    for (let page = 1; page <= maxPages; page++) {
      try {
        // Add delay between pages
        if (page > 1) {
          const delay = Math.min(1200, timeoutMs * 0.15);
await new Promise(res => setTimeout(res, delay));

        }
        
        const pageItems = await scrapeColdwellPage(q, page, region, signal);
        
        if (!pageItems || pageItems.length === 0) {
          break;
        }
        
        allItems = allItems.concat(pageItems);
        
        // Stop if we have enough items
        if (allItems.length >= maxResults) {
          allItems = allItems.slice(0, maxResults);
          break;
        }
        
      } catch (pageError) {
        console.warn(`Coldwell sayfa ${page} hatası: ${pageError.message}`);
        break;
      }
    }
    
    // JSON fallback if needed
    if (allItems.length < 10) {
      const jsonItems = await fetchColdwellJsonFallback(q, region, signal);
      allItems = allItems.concat(jsonItems);
    }
    
    // Sort by quality score
    allItems.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
    
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(true, totalTime, allItems.length);
    
    // Rate limit başarı istatistiğini güncelle
    const key = rateLimiter.createAdapterKey("coldwell", region, "estate");
    rateLimiter.registerSuccess(key, 1);
    
    console.log(`✅ Coldwell başarılı: ${allItems.length} emlak (${totalTime}ms)`);
    
    // Return in Adapter Engine format
    return {
      ok: true,
      items: allItems,
      count: allItems.length,
      query: query,
      provider: "coldwell",
      region: region,
      meta: {
        adapter: "coldwellAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        pagesScraped: Math.min(maxPages, allItems.length > 0 ? maxPages : 0),
        rateLimitInfo: {
          limit: COLDWELL_META.rateLimit.limit,
          windowMs: COLDWELL_META.rateLimit.windowMs
        }
      }
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    // Update metrics
    updateMetrics(false, totalTime, 0);
    
    // Rate limit hatası durumunda
    if (error.message.includes("Rate limit")) {
      const key = rateLimiter.createAdapterKey("coldwell", region, "estate");
      rateLimiter.registerError(key, 1);
    }
    
    console.error(`❌ ColdwellAdapter hata (${totalTime}ms):`, error.message);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      query: query,
      provider: "coldwell",
      region: region,
      meta: {
        adapter: "coldwellAdapter",
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
export function getColdwellAdapterStats() {
  return {
    ...adapterMetrics,
    successRate: adapterMetrics.totalRequests > 0 
      ? (adapterMetrics.successfulRequests / adapterMetrics.totalRequests) * 100 
      : 0,
    rateLimitInfo: rateLimiter.getAdapterStats("coldwell"),
    timestamp: new Date().toISOString(),
    version: "S33_TITAN"
  };
}

export function resetColdwellRateLimit(region = "TR") {
  return rateLimiter.resetAdapter("coldwell", region);
}

// ============================================================
// ADAPTER ENGINE COMPATIBILITY EXPORTS
// ============================================================

// Legacy function names
export const searchColdwell = searchColdwellAdapter;
export const searchColdwellScrape = searchColdwellAdapter;

// Adapter configuration
export const coldwellAdapterConfig = {
  name: "coldwell",
  displayName: "Coldwell Banker",
  fn: searchColdwellAdapter,
  meta: COLDWELL_META,
  timeoutMs: COLDWELL_META.defaultTimeoutMs,
  priorityWeight: COLDWELL_META.priorityWeight,
priority: 0.45,

providerType: "real_estate",
vertical: "estate",
 categories: ["estate", "real_estate", "property", "luxury"],
  tags: COLDWELL_META.tags,
  supportedRegions: ["TR"],
  rateLimit: COLDWELL_META.rateLimit,
  adapterEngineVersion: ">=S10",
  status: "active",
  lastTested: new Date().toISOString().split('T')[0],
  isRealEstateService: true
};

// ============================================================
// DEFAULT EXPORT
// ============================================================
export default {
  searchColdwellAdapter,
  searchColdwell,
  searchColdwellScrape,
  ...coldwellAdapterConfig,
  COLDWELL_META,
  getColdwellAdapterStats,
  resetColdwellRateLimit,
  register: () => coldwellAdapterConfig
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
export async function searchColdwellAdapter(query, options = {}) {
  const providerKey = "coldwell";
  const started = __s200_now();
  const timeoutMs =
    Number(options?.timeoutMs) ||
    Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
    9000;

  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "coldwellAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const raw = await withTimeout(
      () => searchColdwellAdapterLegacy(query, options),
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
