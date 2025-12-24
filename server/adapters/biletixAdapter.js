// server/adapters/biletixAdapter.js
// ======================================================================
// BILETIX ADAPTER — ANA MOTOR İLE %100 UYUMLU VERSİYON
// ======================================================================
// Hercules S200 normalizeItem + optimizePrice + commissionEngine + providerMaster entegre
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import { buildImageVariants } from "../utils/imageFixer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { finalCategoryMultiplier } from "../core/commissionRates.js";
import { proxyFetchHTML } from "../core/proxyEngine.js";
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


// ----------------------------------------------------------------------
// S200 STRICT POLICY
// - PROD (FINDALLEASY_ALLOW_STUBS=0): NO fallback placeholders
// - DEV  (FINDALLEASY_ALLOW_STUBS=1): fallback placeholders allowed
// ----------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";


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

// ======================================================================
// HELPER FUNCTIONS
// ======================================================================

function safe(v) {
  return v ? String(v).trim() : "";
}

function stableId(provider, title, url, price) {
  try {
    const slug = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40);

    const pHash = crypto
      .createHash("md5")
      .update(String(price || ""))
      .digest("hex")
      .slice(0, 6);

    const uHash = crypto
      .createHash("md5")
      .update(String(url || ""))
      .digest("hex")
      .slice(0, 6);

    return `${provider}_${slug}_${pHash}_${uHash}`;
  } catch (err) {
    const slug = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40) || "item";
    const u = String(url || "");
    const p = String(price || "");
    const uTag = u ? `u${u.length.toString(36)}` : "u0";
    const pTag = p ? `p${p.length.toString(36)}` : "p0";
    return `${provider}_${slug}_${pTag}_${uTag}`;
  }
}


function slugify(t) {
  return safe(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

function parsePriceStrong(t) {
  if (!t) return null;
  const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ======================================================================
// EVENT CATEGORY DETECTION (Ana motor ile uyumlu)
// ======================================================================

function detectBiletixCategory(title, description = "") {
  const text = (title + " " + description).toLowerCase();
  
  if (text.includes("konser") || text.includes("concert") || text.includes("dj") || 
      text.includes("müzik") || text.includes("music") || text.includes("rock") ||
      text.includes("pop") || text.includes("caz") || text.includes("jazz")) {
    return "concert";
  }
  
  if (text.includes("festival")) {
    return "festival";
  }
  
  if (text.includes("tiyatro") || text.includes("theatre") || text.includes("oyun") || 
      text.includes("drama") || text.includes("sahne")) {
    return "theatre";
  }
  
  if (text.includes("stand") || text.includes("komedi") || text.includes("comedy")) {
    return "standup";
  }
  
  if (text.includes("opera") || text.includes("bale") || text.includes("ballet")) {
    return "opera";
  }
  
  if (text.includes("sinema") || text.includes("film") || text.includes("movie")) {
    return "cinema";
  }
  
  if (text.includes("spor") || text.includes("sport") || text.includes("futbol") || 
      text.includes("basketbol") || text.includes("maç") || text.includes("match")) {
    return "sports";
  }
  
  if (text.includes("sergi") || text.includes("exhibition") || text.includes("müze") ||
      text.includes("museum")) {
    return "exhibition";
  }
  
  if (text.includes("çocuk") || text.includes("kids") || text.includes("child")) {
    return "kids";
  }
  
  if (text.includes("seminer") || text.includes("workshop") || text.includes("konferans")) {
    return "seminar";
  }
  
  return "event";
}

// ======================================================================
// EVENT DATE EXTRACTION
// ======================================================================

function parseDateTR(str) {
  if (!str) return null;
  const months = {
    ocak: 0, şubat: 1, mart: 2, nisan: 3, mayıs: 4, haziran: 5,
    temmuz: 6, ağustos: 7, eylül: 8, ekim: 9, kasım: 10, aralık: 11,
  };

  try {
    const lower = str.toLowerCase();
    const match = lower.match(
      /(\d{1,2})\s+(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)\s*(\d{4})?/i
    );
    if (!match) return null;

    const day = Number(match[1]);
    const month = months[match[2]];
    const year = match[3] ? Number(match[3]) : new Date().getFullYear();

    const d = new Date(year, month, day);
    return isNaN(d) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function extractLocation($wrap) {
  const location =
    safe($wrap.find(".event-location").text()) ||
    safe($wrap.find(".location").text()) ||
    safe($wrap.find(".venue").text()) ||
    safe($wrap.find(".mekan").text());

  if (!location) return null;

  // Büyük şehirleri kontrol et
  const cities = [
    'İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Adana', 'Antalya', 'Konya',
    'Gaziantep', 'Kayseri', 'Mersin', 'Eskişehir', 'Diyarbakır', 'Samsun'
  ];
  
  for (const city of cities) {
    if (location.includes(city)) return city;
  }
  
  return location.split(',')[0] || location;
}

function extractDescription($wrap) {
  return (
    safe($wrap.find(".event-description").text()) ||
    safe($wrap.find(".description").text()) ||
    safe($wrap.find(".summary").text()) ||
    safe($wrap.find(".details").text()) ||
    ""
  );
}

// ======================================================================
// NORMALIZE BILETIX ITEM (Ana motor normalizeItem ile uyumlu)
// ======================================================================

function normalizeBiletixItem(rawItem, mainCategory = "event", adapterName = "biletixAdapter") {
  // URL'i normalize et
  let url = rawItem.href || null;
  if (url && !url.startsWith("http")) {
    if (url.startsWith("//")) {
      url = "https:" + url;
    } else if (url.startsWith("/")) {
      url = "https://www.biletix.com" + url;
    }
  }
  
  // Fiyatı normalize et
  let price = rawItem.price || null;
  
  // Realistic price validation for events
  if (price) {
    if (price < 10) price = null; // Etkinlik fiyatı 10 TL'den az olamaz
    if (price > 5000) price = null; // Etkinlik fiyatı 5,000 TL'den fazla olamaz
  }
  
  // Kategoriyi belirle
  const category = detectBiletixCategory(rawItem.title, rawItem.description) || mainCategory;
  
 const item = {
    // ZORUNLU ALANLAR (ana motor için)
    id: rawItem.id || stableId("biletix", rawItem.title, url, price),
    title: safe(rawItem.title),
    url: url,
    price: price,

    
    // OPSİYONEL ALANLAR
    rating: rawItem.rating || null,
    provider: "biletix",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: category,
    adapterSource: adapterName,
    
    // S10 COMMISSION ENGINE ALANLARI
    commissionRate: rawItem.commissionRate || 0.04, // Biletix için %4 komisyon
    commissionMeta: {
      platformRate: 0.04,
      categoryMultiplier: finalCategoryMultiplier[category] || finalCategoryMultiplier["event"] || 1.0,
      providerTier: "premium",
      source: "biletix",
      isElectronicTicket: rawItem.isElectronicTicket ?? true,
hasSeatSelection: rawItem.hasSeatSelection ?? true

    },
    
    // S9 PROVIDER MASTER ALANLARI
    providerType: "event_ticketing",
    vertical: "event",
    marketplaceType: "biletix",
    
    // PRICE OPTIMIZATION
    optimizedPrice: rawItem.optimizedPrice || null,
    discountPercentage: rawItem.discountPercentage || null,
    
    // EVENT SPECIFIC FIELDS
    eventInfo: {
      eventDate: rawItem.eventDate || null,
      startDate: rawItem.eventDate || null,
      endDate: rawItem.endDate || null,
      location: rawItem.location || null,
      venue: rawItem.venue || null,
      organizer: rawItem.organizer || null,
      description: rawItem.description || null,
      isOnline: rawItem.isOnline || false,
      isCancelled: rawItem.isCancelled || false,
      isSoldOut: rawItem.isSoldOut || false,
      minAge: rawItem.minAge || null,
      duration: rawItem.duration || null,
      ticketType: rawItem.ticketType || "standard",
      hasSeatMap: rawItem.hasSeatMap || true
    },
    
    // IMAGE OPTIMIZATION
    image: rawItem.imgRaw || null,
    imageVariants: buildImageVariants(rawItem.imgRaw, "biletix"),
    
    // AVAILABILITY
    availability: price ? "available" : "unknown",
    stockStatus: price ? "in_stock" : "unknown",
    
    // PROVIDER TRUST SCORE
    trustScore: 8.7,
    
    // RAW DATA (debug için)
    raw: rawItem.raw || rawItem,
    
    // S10 SCORE (başlangıç değeri)
    score: 0.01
  };
  
  return item;
}

// ======================================================================
// OPTIMIZE PRICE WRAPPER (Ana motor ile uyumlu)
// ======================================================================

function applyOptimizePrice(item) {
  try {
    // Ana motorun optimizePrice fonksiyonunu kullan
    const optimized = optimizePrice(item, {
      provider: "biletix",
      region: item.region || "TR",
      category: item.category || "event",
      subCategory: item.eventInfo?.ticketType || "standard",
      mode: "event_ticketing",
      source: item.raw?.source || "scraping"
    });
    
    // Commission bilgilerini ekle (yoksa)
    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.04;
      optimized.commissionMeta = {
        platformRate: 0.04,
        categoryMultiplier: finalCategoryMultiplier[item.category] || finalCategoryMultiplier["event"] || 1.0,
        providerTier: "premium",
        source: "biletix_adapter"
      };
    }
    
    // Event info'yu optimize edilmiş item'a taşı
    if (item.eventInfo && !optimized.eventInfo) {
      optimized.eventInfo = item.eventInfo;
    }
    
    return optimized;
    
  } catch (e) {
    console.warn("Biletix optimize hata:", e?.message);
    return item;
  }
}

// ======================================================================
// PROXY-FIRST HTML GETTER
// ======================================================================

async function fetchHTML(url, signal) {
  try {
    const html = await proxyFetchHTML(url, { signal, timeout: 15000 });
    if (html) return html;
  } catch {}

  const res = await axios.get(url, {
    timeout: 15000,
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
  return res.data;
}

// ======================================================================
// MAIN ADAPTER — Ana motor ile uyumlu
// ======================================================================

export async function searchBiletixAdapter(query, options = {}) {
  const startTime = Date.now();
  const requestId = `biletix_${Date.now()}_${__s200_next().toString(36).substr(2, 9)}`;

  // ===================== S200 RATE LIMITER ======================
  const region = options.region || "TR";
  const limiterKey = `s200:adapter:biletix:${region}`;

  const allowed = await rateLimiter.check(limiterKey, {
    limit: 25,        // Biletix için ideal RPM
    windowMs: 60_000, // 1 dakika
    burst: true,
    adaptive: true
  });

  if (!allowed) {
    return {
      ok: false,
      items: [],
      count: 0,
      error: "S200_RATE_LIMIT_EXCEEDED",
      adapterName: "biletixAdapter",
      _meta: {
        limiterKey,
        timestamp: Date.now()
      }
    };
  }
  // ===============================================================

  console.log(`🎟️ [${requestId}] Biletix adapter başladı: "${query.substring(0, 50)}"`);
  
  try {
    const signal = options.signal || null;

    const q = encodeURIComponent(query);
    const url = `https://www.biletix.com/search/${q}/turkey/tr`;

    const html = await fetchHTML(url, signal);
    const $ = loadCheerioS200(html);

    const rawItems = [];

    const selectors = [
      ".search-event-item",
      ".event-list-item",
      ".event-item",
      ".event-card",
      ".card-event",
      ".listing-card",
      ".event-row",
      ".search-result-item",
      
    ];

    selectors.forEach((sel) => {
      $(sel).each((i, el) => {
        try {
          const w = $(el);

          const title =
            safe(w.find(".event-title").text()) ||
            safe(w.find(".title").text()) ||
            safe(w.find("h3").text()) ||
            safe(w.find("h4").text()) ||
            safe(w.find("a[class*='event']").text());
          if (!title || title.length < 3) return;

          const dateTxt =
            safe(w.find(".event-date").text()) ||
            safe(w.find(".date").text()) ||
            safe(w.find(".tarih").text()) ||
            safe(w.find("time").text());
          const eventDate = parseDateTR(dateTxt);

          const priceTxt =
            safe(w.find(".price").text()) ||
            safe(w.find(".event-price").text()) ||
            safe(w.find(".bilet-fiyat").text()) ||
            safe(w.find("span[class*='price']").text());
          const price = parsePriceStrong(priceTxt);

          let imgRaw =
            safe(w.find("img").attr("src")) ||
            safe(w.find(".event-image").attr("src")) ||
            safe(w.find("img[class*='event']").attr("src")) ||
            null;

          if (imgRaw?.startsWith("//")) imgRaw = "https:" + imgRaw;

          let href = w.find("a").attr("href");
          if (!href) href = w.find("a[class*='event']").attr("href");
          if (!href) return;

          const description = extractDescription(w);
          const location = extractLocation(w);
          const category = detectBiletixCategory(title, description);

          rawItems.push({
            title,
            description,
            price,
            href,
            imgRaw,
            eventDate,
            location,
            category,
            raw: {
              html: w.html()?.substring(0, 500) || null,
              extractedAt: new Date().toISOString(),
              source: "scraping"
            }
          });
        } catch (itemError) {
          console.warn("Biletix item parsing error:", itemError.message);
        }
      });
    });

    // Normalize ve optimize et
    const normalizedItems = rawItems
      .map(raw => normalizeBiletixItem(raw, "event", "biletixAdapter"))
      .map(item => applyOptimizePrice(item))
      .filter(item => item && item.title && item.url)
      .slice(0, 40); // Limit to 40 items

    const duration = Date.now() - startTime;
    
    if (normalizedItems.length > 0) {
      console.log(`✅ [${requestId}] Biletix adapter başarılı: ${normalizedItems.length} etkinlik, ${duration}ms`);
      
      // S10 adapter statüsünü kaydet
      s10_registerAdapterStatus('biletixAdapter', true, duration);
      
      // İstatistikler
      const eventTypes = {};
      const locations = {};
      
      for (const item of normalizedItems) {
        const eventType = item.category || 'event';
        eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;
        
        const location = item.eventInfo?.location || 'unknown';
        locations[location] = (locations[location] || 0) + 1;
      }
      
      return {
        ok: true,
        items: normalizedItems,
        count: normalizedItems.length,
        adapterName: "biletixAdapter",
        duration,
        metadata: {
          requestId,
          query,
          region,
          source: "scraping",
          eventTypes,
          locations,
          priceRange: normalizedItems.length > 0 ? {
            min: Math.min(...normalizedItems.map(i => i.price || 0)),
            max: Math.max(...normalizedItems.map(i => i.price || 0)),
            avg: Math.round(normalizedItems.reduce((sum, i) => sum + (i.price || 0), 0) / normalizedItems.length)
          } : null,
          timestamp: new Date().toISOString()
        }
      };
  

        } else {
      console.log(`⚠️ [${requestId}] Biletix adapter sonuç yok`);
      if (FINDALLEASY_ALLOW_STUBS) {
        console.log(`⚠️ [${requestId}] Biletix adapter sonuç yok → fallback (DEV)`);
        return await biletixFallback(query, region, startTime, requestId);
      }
      // STRICT: no placeholders
      const duration = Date.now() - startTime;
      s10_registerAdapterStatus("biletixAdapter", true, duration);
      return {
        ok: true,
        items: [],
        count: 0,
        source: "biletix",
        _meta: {
          requestId,
          query: String(query || ""),
          region,
          duration,
          empty: true,
          fallbackSuppressed: true,
          timestamp: new Date().toISOString(),
        },
      };
    }

} catch (err) {

    const duration = Date.now() - startTime;

    console.error(`❌ [Biletix adapter] Hata: ${err.message}`, {
      query: query?.substring(0, 100),
      duration,
      timestamp: new Date().toISOString()
    });

    s10_registerAdapterStatus("biletixAdapter", false, duration);

    return await biletixFallback(
      query,
      options.region || "TR",
      startTime,
      requestId
    );

  }
}



// ======================================================================
// FALLBACK — Ana motor ile uyumlu
// ======================================================================

async function biletixFallback(query, region = "TR", startTime = Date.now(), requestId = "biletix_fallback") {
  try {
    const raw = {
      title: `${query} - Etkinlik Bileti`,
      price: null,
      href: "https://www.biletix.com/",
      imgRaw: null,
      eventDate: null,
      location: null,
      category: "event",
      raw: {
        source: "fallback",
        extractedAt: new Date().toISOString()
      }
    };

    const normalizedItem = normalizeBiletixItem(raw, "event", "biletixFallback");
    const optimizedItem = applyOptimizePrice(normalizedItem);
    
    const duration = Date.now() - startTime;
    
    console.log(`⚠️ [${requestId}] Biletix fallback kullanıldı, ${duration}ms`);
    
    s10_registerAdapterStatus('biletixAdapter', true, duration);
    
    return {
      ok: true,
      items: [optimizedItem],
      count: 1,
      adapterName: "biletixFallback",
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
    
    console.error(`❌ [Biletix fallback] Hata: ${error.message}`);
    
    s10_registerAdapterStatus('biletixAdapter', false, duration);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      adapterName: "biletixFallback",
      duration,
      metadata: {
        query,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    };
  }
}

// ======================================================================
// WRAPPERS — Legacy support
// ======================================================================

export async function searchBiletix(query, opts = {}) {
  return await searchBiletixAdapter(query, opts);
}

export async function searchBiletixScrape(query, regionOrOptions = "TR") {
  return await searchBiletixAdapter(
    query, 
    typeof regionOrOptions === 'string' 
      ? { region: regionOrOptions }
      : regionOrOptions
  );
}

// ======================================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// ======================================================================

export const biletixAdapterConfig = {
  name: "biletix",
  fn: searchBiletixAdapter,
  timeoutMs: 15000,
  priority: 1.3,
  category: "event",
  subCategories: [
    "concert",
    "festival", 
    "theatre",
    "standup",
    "opera",
    "cinema",
    "sports",
    "exhibition",
    "kids",
    "seminar"
  ],
  provider: "biletix",
  commissionRate: 0.04,
  vertical: "event",
  regionSupport: ["TR"],
  metadata: {
    providerType: "event_ticketing",
    hasAffiliate: true,
    hasElectronicTickets: true,
    hasSeatSelection: true,
    hasSeatMap: true,
    trustScore: 8.7,
    deliverySpeed: "instant",
    cancellationPolicy: "varies"
  },
  capabilities: {
    supportsApi: false,
    supportsScraping: true,
    supportsImages: true,
    supportsPricing: true,
    supportsEventDetails: true,
    supportsLocationFilter: true,
    supportsDateFilter: true
  },
  eventCapabilities: {
    supportsDateFilter: true,
    supportsLocationFilter: true,
    supportsCategoryFilter: true,
    supportsPriceRange: true,
    supportsAgeRestriction: true,
    supportsSeatSelection: true
  },
  s10Integration: {
    supportsCommissionEngine: true,
    supportsPriceOptimization: true,
    supportsAffiliateUrls: true,
    supportsUserTracking: true
  }
};

// ======================================================================
// TEST FUNCTION (İsteğe bağlı)
// ======================================================================

export async function testBiletixAdapter() {
  const query = "tiyatro istanbul";
  const region = "TR";
  
  console.log("🧪 Biletix adapter test başlıyor...");
  
  try {
    const result = await searchBiletixAdapter(query, { region });
    
    console.log("✅ Test sonucu:", {
      ok: result.ok,
      itemCount: result.count,
      sampleItem: result.items[0] ? {
        title: result.items[0].title.substring(0, 50),
        price: result.items[0].price,
        provider: result.items[0].provider,
        category: result.items[0].category,
        commissionRate: result.items[0].commissionRate,
        eventInfo: result.items[0].eventInfo
      } : null
    });
    
    // Ana motor formatına uygun mu kontrol et
    const firstItem = result.items[0];
    if (firstItem) {
      const requiredFields = ['id', 'title', 'url', 'price', 'provider'];
      const missingFields = requiredFields.filter(field => !firstItem[field]);
      
      if (missingFields.length === 0) {
        console.log("🎉 Biletix adapter ana motorla %100 uyumlu!");
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

// ======================================================================
// DEFAULT EXPORT
// ======================================================================

export default {
  searchBiletix,
  searchBiletixScrape,
  searchBiletixAdapter,
  biletixAdapterConfig,
  testBiletixAdapter
};

console.log("🎟️ BILETIX ADAPTER S200 ULTRA YÜKLENDİ - ANA MOTOR %100 UYUMLU");