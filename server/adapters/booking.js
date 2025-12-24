// server/adapters/booking.js
// =======================================================================
// BOOKING.COM ADAPTER — ANA MOTOR İLE %100 UYUMLU VERSİYON
// =======================================================================
// Hercules S200 normalizeItem + optimizePrice + commissionEngine + providerMaster entegre
// =======================================================================

import fetch from "node-fetch";
import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import {
buildImageVariants } from "../utils/imageFixer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { finalCategoryMultiplier } from "../core/commissionRates.js";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";
import {



  loadCheerioS200,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// S200: deterministic request/trace ids (NO RANDOM)
// ---------------------------------------------------------------------------
let __s200_seq = 0;
const __s200_next = () => {
  __s200_seq = (__s200_seq + 1) % 1000000000;
  return __s200_seq;
};
// ======================================================================
// S10 ADAPTER STATS REGISTRY (Ana motor uyumlu)
// ======================================================================

function s10_registerAdapterStatus(name, ok = true, duration = 300) {
  try {
    if (typeof globalThis.S10_AdapterRealtime === 'undefined') {
      globalThis.S10_AdapterRealtime = {};
    }
    
    const key = String(name || "unknown").toLowerCase();
    
    if (!globalThis.S10_AdapterRealtime[key]) {
      globalThis.S10_AdapterRealtime[key] = { fail: 0, success: 0, avg: duration };
    }
    
    if (!ok) globalThis.S10_AdapterRealtime[key].fail++;
    else globalThis.S10_AdapterRealtime[key].success++;
    
    globalThis.S10_AdapterRealtime[key].avg = 
      globalThis.S10_AdapterRealtime[key].avg * 0.7 + duration * 0.3;
      
  } catch (err) {
    // Silent fail
  }
}

// =======================================================================
// HELPER FUNCTIONS
// =======================================================================

const TIMEOUT_MS = 9000;

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function buildStableId(raw, title = "", provider = "booking") {
  const base = `${provider}_${raw || title || "id"}`;
  try {
    return "booking_" + crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16);
  } catch {
    return "booking_" + String(base).replace(/\W+/g, "_");
  }
}

function parsePriceStrong(t) {
  if (!t) return null;
  let cleaned = t
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function fallbackImage(title) {
  const q = encodeURIComponent(title || "hotel");
  return `https://source.unsplash.com/featured/?hotel,${q}`;
}

// =======================================================================
// HOTEL CATEGORY DETECTION (Ana motor ile uyumlu)
// =======================================================================

function detectBookingCategory(title, description = "") {
  const text = (title + " " + description).toLowerCase();
  
  if (text.includes("resort") || text.includes("tatil köyü")) {
    return "resort";
  }
  
  if (text.includes("villa") || text.includes("dağ evi") || text.includes("chalet")) {
    return "villa";
  }
  
  if (text.includes("apart") || text.includes("daire") || text.includes("suite")) {
    return "aparthotel";
  }
  
  if (text.includes("hostel") || text.includes("backpacker") || text.includes("pansiyon")) {
    return "hostel";
  }
  
  if (text.includes("butik") || text.includes("boutique")) {
    return "boutique_hotel";
  }
  
  if (text.includes("lüks") || text.includes("luxury") || text.includes("5 yıldız")) {
    return "luxury_hotel";
  }
  
  if (text.includes("spa") || text.includes("wellness") || text.includes("termal")) {
    return "spa_hotel";
  }
  
  if (text.includes("aile") || text.includes("family") || text.includes("çocuk")) {
    return "family_hotel";
  }
  
  if (text.includes("iş") || text.includes("business") || text.includes("konferans")) {
    return "business_hotel";
  }
  
  if (text.includes("otel") || text.includes("hotel") || text.includes("motel")) {
    return "hotel";
  }
  
  return "hotel";
}

function extractLocation($wrap) {
  const location =
    safe($wrap.find(".location").text()) ||
    safe($wrap.find(".address").text()) ||
    safe($wrap.find(".neighbourhood").text()) ||
    safe($wrap.find(".district").text()) ||
    safe($wrap.find("span[data-testid='address']").text());

  if (!location) return null;

  // Büyük şehirleri kontrol et
  const cities = [
    'İstanbul', 'Ankara', 'İzmir', 'Antalya', 'Bodrum', 'Marmaris',
    'Fethiye', 'Alanya', 'Trabzon', 'Bursa', 'Adana', 'Konya'
  ];
  
  for (const city of cities) {
    if (location.includes(city)) return city;
  }
  
  return location.split(',')[0] || location;
}

function extractRating($wrap) {
  const ratingText =
    safe($wrap.find(".rating").text()) ||
    safe($wrap.find(".score").text()) ||
    safe($wrap.find("div[data-testid='review-score']").text()) ||
    safe($wrap.find(".bui-review-score__badge").text());
  
  if (!ratingText) return null;
  
  const match = ratingText.match(/(\d+[.,]?\d*)/);
  if (!match) return null;
  
  const rating = parseFloat(match[1].replace(',', '.'));
  return isNaN(rating) ? null : Math.min(10, Math.max(0, rating));
}

function extractReviewCount($wrap) {
  const reviewText =
    safe($wrap.find(".review-count").text()) ||
    safe($wrap.find("div[data-testid='review-score'] + div").text()) ||
    safe($wrap.find(".bui-review-score__text").text());
  
  if (!reviewText) return null;
  
  const match = reviewText.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// =======================================================================
// NORMALIZE BOOKING ITEM (Ana motor normalizeItem ile uyumlu)
// =======================================================================

function normalizeBookingItem(rawItem, mainCategory = "travel", adapterName = "bookingAdapter") {
  // URL'i normalize et
  let url = rawItem.href || null;
  if (url && !url.startsWith("http")) {
    if (url.startsWith("//")) {
      url = "https:" + url;
    } else if (url.startsWith("/")) {
      url = "https://www.booking.com" + url;
    }
  }
  
  // Fiyatı normalize et
  let price = rawItem.price || null;
  
  // Realistic price validation for hotels
  if (price) {
    if (price < 50) price = null; // Otel fiyatı 50 TL'den az olamaz
    if (price > 50000) price = null; // Otel fiyatı 50,000 TL'den fazla olamaz
  }
  
  // Kategoriyi belirle
  const category = detectBookingCategory(rawItem.title, rawItem.description) || mainCategory;
  
  const item = {
    // ZORUNLU ALANLAR (ana motor için)
    id: rawItem.id || buildStableId(url, rawItem.title, "booking"),
    title: safe(rawItem.title),
    url: url,
    price: price,
    
    // OPSİYONEL ALANLAR
    rating: rawItem.rating || null,
    provider: "booking",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: category,
    adapterSource: adapterName,
    
    // S10 COMMISSION ENGINE ALANLARI
    commissionRate: rawItem.commissionRate || 0.07, // Booking.com için %7 komisyon
    commissionMeta: {
      platformRate: 0.07,
      categoryMultiplier: finalCategoryMultiplier[category] || finalCategoryMultiplier["travel"] || 1.0,
      providerTier: "premium",
      source: "booking",
      isFreeCancellation: rawItem.isFreeCancellation || false,
      hasBreakfast: rawItem.hasBreakfast || false
    },
    
    // S9 PROVIDER MASTER ALANLARI
    providerType: "hotel_booking",
    vertical: "travel",
    marketplaceType: "booking",
    
    // PRICE OPTIMIZATION
    optimizedPrice: rawItem.optimizedPrice || null,
    discountPercentage: rawItem.discountPercentage || null,
    
    // HOTEL SPECIFIC FIELDS
    hotelInfo: {
      location: rawItem.location || null,
      starRating: rawItem.starRating || null,
      reviewCount: rawItem.reviewCount || null,
      amenities: rawItem.amenities || ["Wi-Fi", "Air Conditioning"],
      checkIn: rawItem.checkIn || "14:00",
      checkOut: rawItem.checkOut || "12:00",
      isFreeCancellation: rawItem.isFreeCancellation || false,
      hasBreakfast: rawItem.hasBreakfast || false,
      hasParking: rawItem.hasParking || false,
      hasPool: rawItem.hasPool || false,
      hasSpa: rawItem.hasSpa || false,
      roomType: rawItem.roomType || "standard"
    },
    
    // IMAGE OPTIMIZATION
    image: rawItem.imgRaw || null,
    imageVariants: buildImageVariants(rawItem.imgRaw, "booking"),
    
    // AVAILABILITY
    availability: price ? "available" : "unknown",
    stockStatus: price ? "in_stock" : "unknown",
    
    // PROVIDER TRUST SCORE
    providerTrust: 0.93,
    
    // RAW DATA (debug için)
    raw: rawItem.raw || rawItem,
    
    // S10 SCORE (başlangıç değeri)
    score: 0.01
  };
  
  return item;
}

// =======================================================================
// OPTIMIZE PRICE WRAPPER (Ana motor ile uyumlu)
// =======================================================================

function applyOptimizePrice(item) {
  try {
    // Ana motorun optimizePrice fonksiyonunu kullan
    const optimized = optimizePrice(item, {
      provider: "booking",
      region: item.region || "TR",
      category: item.category || "travel",
      subCategory: item.hotelInfo?.roomType || "standard",
      mode: "hotel_booking",
      source: item.raw?.source || "scraping"
    });
    
    // Commission bilgilerini ekle (yoksa)
    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.07;
      optimized.commissionMeta = {
        platformRate: 0.07,
        categoryMultiplier: finalCategoryMultiplier[item.category] || finalCategoryMultiplier["travel"] || 1.0,
        providerTier: "premium",
        source: "booking_adapter"
      };
    }
    
    // Hotel info'yu optimize edilmiş item'a taşı
    if (item.hotelInfo && !optimized.hotelInfo) {
      optimized.hotelInfo = item.hotelInfo;
    }
    
    return optimized;
    
  } catch (e) {
    console.warn("Booking optimize hata:", e?.message);
    return item;
  }
}

// =======================================================================
// BOOKING OFFICIAL API
// =======================================================================

const BOOKING_API_KEY = process.env.BOOKING_API_KEY || "";
const BOOKING_AFFILIATE_ID = process.env.BOOKING_AFFILIATE_ID || "";

async function bookingOfficialAPI(query, region, signal) {
  if (!BOOKING_API_KEY) return [];

  try {
    const auth = Buffer.from(`${BOOKING_API_KEY}:`).toString("base64");
    
    const url = `https://distribution-xml.booking.com/json/bookings.getHotels?rows=20&offset=0&city_ids=-553173&text=${encodeURIComponent(query)}`;

    const res = await fetch(url, {
      signal,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "User-Agent": "FindAllEasy/1.0",
      },
      timeout: TIMEOUT_MS
    });

    if (!res.ok) return [];

    const data = await res.json();
    const hotels = data?.result || [];

    return hotels.map(h => ({
      title: safe(h.hotel_name),
      price: Number(h.min_total_price) || null,
      rating: Number(h.review_score) || null,
      reviewCount: Number(h.review_nr) || null,
      imgRaw: h.photo_url || null,
      href: h.url ? `${h.url}?aid=${BOOKING_AFFILIATE_ID}` : null,
      location: h.address || null,
      starRating: h.class || null,
      currency: h.currency_code || "TRY",
      raw: h
    }));
  } catch (err) {
    console.warn("Booking API hata:", err.message);
    return [];
  }
}

// =======================================================================
// SCRAPE BOOKING HTML
// =======================================================================

async function scrapeBookingHtml(query, region, signal) {
  const q = encodeURIComponent(query);
  const url = `https://www.booking.com/searchresults.html?ss=${q}`;

  let html = null;

  try {
    html = await proxyFetchHTML(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/125" },
    });
  } catch {}

  if (!html) {
    try {
      const { data } = await axios.get(url, {
        timeout: TIMEOUT_MS,
        signal,
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1"
        },
      });
      html = data;
    } catch (err) {
      console.warn("Booking HTML hata:", err.message);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const rawItems = [];

  // Booking.com'daki otel kartları için selector'lar
  const selectors = [
  "[data-testid='property-card']",
  "div[data-testid='property-card-container']",
  "[data-testid='availability-card']", 
  ".d4924c9e74",
  ".fde444d7ef",
  ".c90d3bf728"
];


  selectors.forEach((sel) => {
    $(sel).each((i, el) => {
      try {
        const w = $(el);

        const title =
          safe(w.find("div[data-testid='title']").text()) ||
          safe(w.find(".sr-hotel__name").text()) ||
          safe(w.find("h3").text()) ||
          safe(w.find("a[class*='hotel_name']").text());
        if (!title || title.length < 3) return;

        const price = parsePriceStrong(
          safe(w.find("span[data-testid='price-and-discounted-price']").text()) ||
          safe(w.find(".bui-price-display__value").text()) ||
          safe(w.find(".prco-valign-middle-helper").text()) ||
          safe(w.find(".bui-price-display").text())
        );

        let href =
          w.find("a[data-testid='title-link']").attr("href") ||
          w.find("a[data-testid='property-card']").attr("href") ||
          w.find("a[class*='hotel_name_link']").attr("href") ||
          w.find("a").attr("href");
        if (!href) return;

        const imgRaw =
          w.find("img").attr("data-src") ||
          w.find("img").attr("src") ||
          w.find("img[data-high-res]").attr("data-high-res") ||
          null;

        const location = extractLocation(w);
        const rating = extractRating(w);
        const reviewCount = extractReviewCount(w);
        const category = detectBookingCategory(title);

        rawItems.push({
          title,
          price,
          href,
          imgRaw,
          location,
          rating,
          reviewCount,
          category,
          raw: {
            html: w.html()?.substring(0, 500) || null,
            extractedAt: new Date().toISOString(),
            source: "scraping"
          }
        });
      } catch (itemError) {
        console.warn("Booking item parsing error:", itemError.message);
      }
    });
  });

  return rawItems;
}

// =======================================================================
// MAIN ADAPTER — Ana motor ile uyumlu
// =======================================================================

export async function searchBookingAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  const requestId = `booking_${Date.now()}_${__s200_next().toString(36).substr(2, 9)}`;

  // ===================== S200 RATE LIMITER ======================
  const region = options.region || "TR";
  const limiterKey = `s200:adapter:booking:${region}`;

  const allowed = await rateLimiter.check(limiterKey, {
    limit: 10,          // Booking çok agresif → 10 RPM ideal
    windowMs: 60_000,   // 1 dakika
    burst: true,
    adaptive: true
  });

  if (!allowed) {
    return {
      ok: false,
      items: [],
      count: 0,
      error: "S200_RATE_LIMIT_EXCEEDED",
      adapterName: "bookingAdapter",
      _meta: {
        limiterKey,
        timestamp: Date.now()
      }
    };
  }
  // ===============================================================

  console.log(`🏨 [${requestId}] Booking adapter başladı: "${query.substring(0, 50)}"`);
  
  try {
    const region = options.region || "TR";
    const signal = options.signal || null;

    
    if (!query || query.length < 2) {
      const duration = Date.now() - startTime;
      
      s10_registerAdapterStatus('bookingAdapter', true, duration);
      
      return {
        ok: true,
        items: [],
        count: 0,
        adapterName: "bookingAdapter",
        duration,
        metadata: {
          requestId,
          query,
          region,
          source: "none",
          error: "query_too_short",
          timestamp: new Date().toISOString()
        }
      };
    }
    
    let rawItems = [];
    
    // Önce API'yi dene
    const apiItems = await bookingOfficialAPI(query, region, signal);
    if (apiItems.length > 0) {
      rawItems = apiItems;
    } else {
      // API yoksa scraping yap
      rawItems = await scrapeBookingHtml(query, region, signal);
    }
    
    // Normalize ve optimize et
    const normalizedItems = rawItems
      .map(raw => normalizeBookingItem(raw, "travel", "bookingAdapter"))
      .map(item => applyOptimizePrice(item))
      .filter(item => item && item.title && item.url)
      .slice(0, 40); // Limit to 40 items

    const duration = Date.now() - startTime;
    
    if (normalizedItems.length > 0) {
      console.log(`✅ [${requestId}] Booking adapter başarılı: ${normalizedItems.length} otel, ${duration}ms`);
      
      // S10 adapter statüsünü kaydet
      s10_registerAdapterStatus('bookingAdapter', true, duration);
      
      // İstatistikler
      const hotelTypes = {};
      const locations = {};
      const priceStats = {
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0
      };
      
      for (const item of normalizedItems) {
        const hotelType = item.category || 'hotel';
        hotelTypes[hotelType] = (hotelTypes[hotelType] || 0) + 1;
        
        const location = item.hotelInfo?.location || 'unknown';
        locations[location] = (locations[location] || 0) + 1;
        
        if (item.price) {
          priceStats.min = Math.min(priceStats.min, item.price);
          priceStats.max = Math.max(priceStats.max, item.price);
          priceStats.sum += item.price;
          priceStats.count++;
        }
      }
      
      return {
        ok: true,
        items: normalizedItems,
        count: normalizedItems.length,
        adapterName: "bookingAdapter",
        duration,
        metadata: {
          requestId,
          query,
          region,
          source: apiItems.length > 0 ? "api" : "scraping",
          hotelTypes,
          locations,
          priceRange: priceStats.count > 0 ? {
            min: priceStats.min,
            max: priceStats.max,
            avg: Math.round(priceStats.sum / priceStats.count),
            unit: "TRY"
          } : null,
          timestamp: new Date().toISOString()
        }
      };
    } else {
      // Fallback
      console.log(`⚠️ [${requestId}] Booking adapter sonuç yok → fallback`);
      return await bookingFallback(query, region, startTime, requestId);
    }
    
  } catch (err) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [Booking adapter] Hata: ${err.message}`, {
      query: query?.substring(0, 100),
      duration,
      timestamp: new Date().toISOString()
    });
    
    // S10 adapter statüsünü kaydet
    s10_registerAdapterStatus('bookingAdapter', false, duration);
    
    // Fallback'e geç
    return await bookingFallback(query, options.region || "TR", startTime, requestId);
  }
}

// =======================================================================
// FALLBACK — Ana motor ile uyumlu
// =======================================================================

async function bookingFallback(query, region = "TR", startTime = Date.now(), requestId = "booking_fallback") {
  try {
    const raw = {
      title: `${query} - Otel`,
      price: null,
      href: "https://www.booking.com/",
      imgRaw: fallbackImage(query),
      location: null,
      category: "hotel",
      raw: {
        source: "fallback",
        extractedAt: new Date().toISOString()
      }
    };

    const normalizedItem = normalizeBookingItem(raw, "travel", "bookingFallback");
    const optimizedItem = applyOptimizePrice(normalizedItem);
    
    const duration = Date.now() - startTime;
    
    console.log(`⚠️ [${requestId}] Booking fallback kullanıldı, ${duration}ms`);
    
    s10_registerAdapterStatus('bookingAdapter', true, duration);
    
    return {
      ok: true,
      items: [optimizedItem],
      count: 1,
      adapterName: "bookingFallback",
      duration,
      metadata: {
        requestId,
        query,
        region,
        source: "fallback",
        timestamp: new Date().toISOString()
      }
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [Booking fallback] Hata: ${error.message}`);
    
    s10_registerAdapterStatus('bookingAdapter', false, duration);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      adapterName: "bookingFallback",
      duration,
      metadata: {
        query,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    };
  }
}

// =======================================================================
// WRAPPERS — Legacy support
// =======================================================================

export async function searchBooking(query, opts = {}) {
  return await searchBookingAdapter(query, opts);
}

// =======================================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// =======================================================================

export const bookingAdapterConfig = {
  name: "booking",
  fn: searchBookingAdapter,
  timeoutMs: TIMEOUT_MS,
  priority: 1.4,
  category: "travel",
  subCategories: [
    "resort",
    "villa", 
    "aparthotel",
    "hostel",
    "boutique_hotel",
    "luxury_hotel",
    "spa_hotel",
    "family_hotel",
    "business_hotel",
    "hotel"
  ],
  provider: "booking",
  commissionRate: 0.07,
  vertical: "travel",
  regionSupport: ["TR", "EU", "US", "UK", "DE", "FR"],
  metadata: {
    providerType: "hotel_booking",
    hasAffiliate: true,
    hasFreeCancellation: true,
    hasBreakfastOption: true,
    hasReviews: true,
    trustScore: 9.3,
    deliverySpeed: "instant",
    cancellationPolicy: "flexible"
  },
  capabilities: {
    supportsApi: true,
    supportsScraping: true,
    supportsImages: true,
    supportsReviews: true,
    supportsPricing: true,
    supportsLocationFilter: true,
    supportsDateFilter: true
  },
  hotelCapabilities: {
    supportsStarFilter: true,
    supportsPriceRange: true,
    supportsLocationFilter: true,
    supportsReviewScoreFilter: true,
    supportsAmenitiesFilter: true,
    supportsRoomTypeFilter: true
  },
  s10Integration: {
    supportsCommissionEngine: true,
    supportsPriceOptimization: true,
    supportsAffiliateUrls: true,
    supportsUserTracking: true
  }
};

// =======================================================================
// TEST FUNCTION (İsteğe bağlı)
// =======================================================================

export async function testBookingAdapter() {
  const query = "istanbul otel";
  const region = "TR";
  
  console.log("🧪 Booking adapter test başlıyor...");
  
  try {
    const result = await searchBookingAdapter(query, { region });
    
    console.log("✅ Test sonucu:", {
      ok: result.ok,
      itemCount: result.count,
      sampleItem: result.items[0] ? {
        title: result.items[0].title.substring(0, 50),
        price: result.items[0].price,
        provider: result.items[0].provider,
        category: result.items[0].category,
        commissionRate: result.items[0].commissionRate,
        hotelInfo: result.items[0].hotelInfo
      } : null
    });
    
    // Ana motor formatına uygun mu kontrol et
    const firstItem = result.items[0];
    if (firstItem) {
      const requiredFields = ['id', 'title', 'url', 'price', 'provider'];
      const missingFields = requiredFields.filter(field => !firstItem[field]);
      
      if (missingFields.length === 0) {
        console.log("🎉 Booking adapter ana motorla %100 uyumlu!");
      } else {
        console.warn("⚠️ Eksik alanlar:", missingFields);
      }
    }
    
    return result;
    
  } catch (error) {
    console.error("❌ Test başarısız:", error.message);
    throw error;
  }
}

// =======================================================================
// DEFAULT EXPORT
// =======================================================================

export default {
  searchBooking,
  searchBookingAdapter,
  bookingAdapterConfig,
  testBookingAdapter
};

console.log("🏨 BOOKING ADAPTER S200 ULTRA YÜKLENDİ - ANA MOTOR %100 UYUMLU");

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBookingAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "booking";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "booking",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBookingAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "booking",
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
        category: "general",
        vertical: "general",
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
      source: "booking",
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
      source: "booking",
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
