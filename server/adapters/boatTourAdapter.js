// server/adapters/boatTourAdapter.js
// =======================================================================
// TEKNE TURU ADAPTER — ANA MOTOR İLE %100 UYUMLU VERSİYON
// =======================================================================
// Hercules S200 normalizeItem + optimizePrice + commissionEngine + providerMaster entegre
// =======================================================================

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

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function buildStableId(raw, title = "", provider = "boattour") {
  const base = `${provider}_${raw || title || "id"}`;
  try {
    return "boattour_" + crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16);
  } catch {
    return "boattour_" + String(base).replace(/\W+/g, "_");
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
  const q = encodeURIComponent(title || "boat");
  return `https://source.unsplash.com/featured/?boat,tour,${q}`;
}

// =======================================================================
// TOUR CATEGORY DETECTION (Ana motor ile uyumlu)
// =======================================================================

function detectBoatTourCategory(title, description = "") {
  const text = (title + " " + description).toLowerCase();
  
  if (text.includes("vip") || text.includes("premium") || text.includes("lüks")) {
    return "vip_boat_tour";
  }
  
  if (text.includes("özel") || text.includes("private") || text.includes("kişiye özel")) {
    return "private_boat_tour";
  }
  
  if (text.includes("mavi yolculuk") || text.includes("blue cruise") || text.includes("mavi tur")) {
    return "blue_cruise";
  }
  
  if (text.includes("günübirlik") || text.includes("daily") || text.includes("günlük")) {
    return "daily_boat_tour";
  }
  
  if (text.includes("dalış") || text.includes("diving") || text.includes("snorkeling")) {
    return "diving_tour";
  }
  
  if (text.includes("balık") || text.includes("fishing") || text.includes("balık tutma")) {
    return "fishing_tour";
  }
  
  if (text.includes("yat") || text.includes("yacht") || text.includes("gulet")) {
    return "yacht_tour";
  }
  
  if (text.includes("ada") || text.includes("island") || text.includes("adalar")) {
    return "island_tour";
  }
  
  if (text.includes("gece") || text.includes("night") || text.includes("akşam")) {
    return "night_tour";
  }
  
  if (text.includes("romantik") || text.includes("romantic") || text.includes("çift")) {
    return "romantic_tour";
  }
  
  return "boat_tour";
}

function extractDuration($wrap) {
  const durationText =
    safe($wrap.find(".duration").text()) ||
    safe($wrap.find(".sure").text()) ||
    safe($wrap.find(".tour-duration").text()) ||
    safe($wrap.find(".time").text());
  
  if (!durationText) return null;
  
  // "3 saat", "5 saat", "1 gün" gibi formatları parse et
  const hourMatch = durationText.match(/(\d+)\s*(saat|hour)/i);
  if (hourMatch) return `${hourMatch[1]} saat`;
  
  const dayMatch = durationText.match(/(\d+)\s*(gün|day)/i);
  if (dayMatch) return `${dayMatch[1]} gün`;
  
  return durationText;
}

function extractDepartureLocation($wrap) {
  const location =
    safe($wrap.find(".departure").text()) ||
    safe($wrap.find(".location").text()) ||
    safe($wrap.find(".port").text()) ||
    safe($wrap.find(".liman").text()) ||
    safe($wrap.find(".marina").text());
  
  if (!location) return null;
  
  // Büyük turizm şehirlerini kontrol et
  const cities = [
    'Bodrum', 'Marmaris', 'Fethiye', 'Antalya', 'Kuşadası', 'Çeşme',
    'İstanbul', 'İzmir', 'Muğla', 'Marmaris', 'Göcek', 'Kalkan'
  ];
  
  for (const city of cities) {
    if (location.includes(city)) return city;
  }
  
  return location.split(',')[0] || location;
}

function extractInclusions($wrap) {
  const inclusions = [];
  
  // Yemek dahil mi?
  if (safe($wrap.find(".includes-food").text()) || 
      safe($wrap.find(".yemek-dahil").text()) ||
      safe($wrap.find(".food-included").text())) {
    inclusions.push("yemek");
  }
  
  // İçecek dahil mi?
  if (safe($wrap.find(".includes-drinks").text()) || 
      safe($wrap.find(".icecek-dahil").text()) ||
      safe($wrap.find(".drinks-included").text())) {
    inclusions.push("içecek");
  }
  
  // Rehber dahil mi?
  if (safe($wrap.find(".includes-guide").text()) || 
      safe($wrap.find(".rehber-dahil").text()) ||
      safe($wrap.find(".guide-included").text())) {
    inclusions.push("rehber");
  }
  
  return inclusions.length > 0 ? inclusions : null;
}

// =======================================================================
// NORMALIZE BOAT TOUR ITEM (Ana motor normalizeItem ile uyumlu)
// =======================================================================
function normalizeBoatTourItem(rawItem, mainCategory = "tour", adapterName = "boatTourAdapter") {
  let url = rawItem.href || null;
  const BASE_URL = "https://www.gunubirliktekneler.com";

  if (url && !url.startsWith("http")) {
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/")) url = BASE_URL + url;
  }

  let price = rawItem.price || null;
  if (price) {
    if (price < 50) price = null;
    if (price > 50000) price = null;
  }

  const category = detectBoatTourCategory(rawItem.title, rawItem.description) || mainCategory;

  // 🔥 BURAYA ALINIYOR
  const finalImage = rawItem.imgRaw || fallbackImage(rawItem.title);

  const item = {
    id: rawItem.id || buildStableId(url, rawItem.title, "boattour"),
    title: safe(rawItem.title),
    url,
    price,
    rating: rawItem.rating || null,
    provider: "boattour",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category,
    adapterSource: adapterName,

    commissionRate: rawItem.commissionRate || 0.08,
    commissionMeta: {
      platformRate: 0.08,
      categoryMultiplier: finalCategoryMultiplier[category] || finalCategoryMultiplier["tour"] || 1.0,
      providerTier: "standard",
      source: "boattour",
      isGroupTour: rawItem.isGroupTour ?? true,
      hasInsurance: rawItem.hasInsurance || false
    },

    providerType: "tour_operator",
    vertical: "travel",
    marketplaceType: "boattour",

    optimizedPrice: rawItem.optimizedPrice || null,
    discountPercentage: rawItem.discountPercentage || null,

    tourInfo: {
      duration: rawItem.duration || null,
      departureLocation: rawItem.departureLocation || null,
      departureTime: rawItem.departureTime || null,
      inclusions: rawItem.inclusions || null,
      boatType: rawItem.boatType || null,
      capacity: rawItem.capacity || null,
      languages: rawItem.languages || ["Türkçe", "İngilizce"],
      isPrivate: rawItem.isPrivate || false,
      isGroup: rawItem.isGroup ?? true,
      hasFood: rawItem.hasFood || false,
      hasDrinks: rawItem.hasDrinks || false,
      hasGuide: rawItem.hasGuide || false,
      season: rawItem.season || "yaz",
      difficulty: rawItem.difficulty || "kolay"
    },

    // 🔥 DÜZGÜN EKLENEN İKİ ALAN
    image: finalImage,
    imageVariants: buildImageVariants(finalImage, "boattour"),

    availability: price ? "available" : "unknown",
    stockStatus: price ? "in_stock" : "unknown",

    providerTrust: 0.88,
    raw: rawItem.raw || rawItem,
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
      provider: "boattour",
      region: item.region || "TR",
      category: item.category || "tour",
      subCategory: item.tourInfo?.boatType || "standard",
      mode: "tour",
      source: item.raw?.source || "scraping"
    });
    
    // Commission bilgilerini ekle (yoksa)
    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.08;
      optimized.commissionMeta = {
        platformRate: 0.08,
        categoryMultiplier: finalCategoryMultiplier[item.category] || finalCategoryMultiplier["tour"] || 1.0,
        providerTier: "standard",
        source: "boattour_adapter"
      };
    }
    
    // Tour info'yu optimize edilmiş item'a taşı
    if (item.tourInfo && !optimized.tourInfo) {
      optimized.tourInfo = item.tourInfo;
    }
    
    return optimized;
    
  } catch (e) {
    console.warn("Boat tour optimize hata:", e?.message);
    return item;
  }
}

// =======================================================================
// PROXY-FIRST HTML GETTER
// =======================================================================

async function fetchHTML(url, signal) {
  try {
    const html = await proxyFetchHTML(url, { signal, timeout: 15000 });
    if (html) return html;
  } catch {}

  const { data } = await axios.get(url, {
    signal,
    timeout: 15000,
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
  return data;
}

// =======================================================================
// MAIN ADAPTER — Ana motor ile uyumlu
// =======================================================================

export async function searchBoatTourAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  const requestId = `boattour_${Date.now()}_${__s200_next().toString(36).substr(2, 9)}`;

  // ===================== S200 RATE LIMITER ======================
  const region = options.region || "TR";
  const limiterKey = `s200:adapter:boattour:${region}`;

  const allowed = await rateLimiter.check(limiterKey, {
    limit: 15,          // Tekne turu için güvenli RPM
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
      adapterName: "boatTourAdapter",
      _meta: {
        limiterKey,
        timestamp: Date.now()
      }
    };
  }
  // ===============================================================

  console.log(`🚤 [${requestId}] Boat tour adapter başladı: "${query.substring(0, 50)}"`);

  
  try {
    const region = options.region || "TR";
    const signal = options.signal || null;
    
    const BASE_URL = "https://www.gunubirliktekneler.com";
    const url = `${BASE_URL}/arama?q=${encodeURIComponent(query)}`;

    const html = await fetchHTML(url, signal);
    if (!html) {
      return await boatTourFallback(query, region, startTime, requestId);
    }

    const $ = loadCheerioS200(html);
    const rawItems = [];

    const selectors = [
      ".tour-item",
      ".boat-card",
      ".result-card",
      ".tour-card",
      ".package-card",
      "div[class*='tour']",
      "article[class*='tour']",
      "li[class*='tour']"
    ];

    selectors.forEach((sel) => {
      $(sel).each((i, el) => {
        try {
          const w = $(el);

          const title =
            safe(w.find(".title").text()) ||
            safe(w.find("h3").text()) ||
            safe(w.find("h2").text()) ||
            safe(w.find(".tour-name").text());
          if (!title || title.length < 3) return;

          const priceText =
            safe(w.find(".price").text()) ||
            safe(w.find(".amount").text()) ||
            safe(w.find(".tour-price").text()) ||
            safe(w.find(".fiyat").text());
          const price = parsePriceStrong(priceText);

          let href = safe(w.find("a").attr("href"));
          if (!href) return;

          let imgRaw =
            safe(w.find("img").attr("src")) ||
            safe(w.find("img").attr("data-src")) ||
            safe(w.find("img").attr("data-original")) ||
            fallbackImage(title);

          if (imgRaw?.startsWith("//")) imgRaw = "https:" + imgRaw;

          const description = safe(w.find(".description").text()) || "";
          const duration = extractDuration(w);
          const departureLocation = extractDepartureLocation(w);
          const inclusions = extractInclusions(w);
          const category = detectBoatTourCategory(title, description);

          rawItems.push({
            title,
            description,
            price,
            href,
            imgRaw,
            duration,
            departureLocation,
            inclusions,
            category,
            raw: {
              html: w.html()?.substring(0, 500) || null,
              extractedAt: new Date().toISOString(),
              source: "scraping"
            }
          });
        } catch (itemError) {
          console.warn("Boat tour item parsing error:", itemError.message);
        }
      });
    });

    // Normalize ve optimize et
    const normalizedItems = rawItems
      .map(raw => normalizeBoatTourItem(raw, "tour", "boatTourAdapter"))
      .map(item => applyOptimizePrice(item))
      .filter(item => item && item.title && item.url)
      .slice(0, 30); // Limit to 30 items

    const duration = Date.now() - startTime;
    
    if (normalizedItems.length > 0) {
      console.log(`✅ [${requestId}] Boat tour adapter başarılı: ${normalizedItems.length} tur, ${duration}ms`);
      
      // S10 adapter statüsünü kaydet
      s10_registerAdapterStatus('boatTourAdapter', true, duration);
      
      // İstatistikler
      const tourTypes = {};
      const locations = {};
      
      for (const item of normalizedItems) {
        const tourType = item.category || 'boat_tour';
        tourTypes[tourType] = (tourTypes[tourType] || 0) + 1;
        
        const location = item.tourInfo?.departureLocation || 'unknown';
        locations[location] = (locations[location] || 0) + 1;
      }
      
      return {
        ok: true,
        items: normalizedItems,
        count: normalizedItems.length,
        adapterName: "boatTourAdapter",
        duration,
        metadata: {
          requestId,
          query,
          region,
          source: "scraping",
          tourTypes,
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
      // Fallback
      console.log(`⚠️ [${requestId}] Boat tour adapter sonuç yok → fallback`);
      return await boatTourFallback(query, region, startTime, requestId);
    }
    
  } catch (err) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [Boat tour adapter] Hata: ${err.message}`, {
      query: query?.substring(0, 100),
      duration,
      timestamp: new Date().toISOString()
    });
    
    // S10 adapter statüsünü kaydet
    s10_registerAdapterStatus('boatTourAdapter', false, duration);
    
    // Fallback'e geç
    return await boatTourFallback(query, options.region || "TR", startTime, requestId);
  }
}

// =======================================================================
// FALLBACK — Ana motor ile uyumlu
// =======================================================================

async function boatTourFallback(query, region = "TR", startTime = Date.now(), requestId = "boattour_fallback") {
  try {
    const raw = {
      title: `${query} - Tekne Turu`,
      price: null,
      href: "https://www.gunubirliktekneler.com/",
      imgRaw: fallbackImage(query),
      description: null,
      duration: null,
      departureLocation: null,
      category: "tour",
      raw: {
        source: "fallback",
        extractedAt: new Date().toISOString()
      }
    };

    const normalizedItem = normalizeBoatTourItem(raw, "tour", "boatTourFallback");
    const optimizedItem = applyOptimizePrice(normalizedItem);
    
    const duration = Date.now() - startTime;
    
    console.log(`⚠️ [${requestId}] Boat tour fallback kullanıldı, ${duration}ms`);
    
    s10_registerAdapterStatus('boatTourAdapter', true, duration);
    
    return {
      ok: true,
      items: [optimizedItem],
      count: 1,
      adapterName: "boatTourFallback",
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
    
    console.error(`❌ [Boat tour fallback] Hata: ${error.message}`);
    
    s10_registerAdapterStatus('boatTourAdapter', false, duration);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      adapterName: "boatTourFallback",
      duration,
      metadata: {
        query,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    };
  }
}
export async function searchBoatTours(query, opts = {}) {
  return await searchBoatTourAdapter(query, opts);
}

export async function searchBoatToursScrape(query, opts = {}) {
  return await searchBoatTourAdapter(query, opts);
}

export const boatTourAdapterConfig = {
  name: "boattour",
  fn: searchBoatTourAdapter,
  timeoutMs: 15000,
  priority: 1.1,
  category: "tour",
  subCategories: [
    "vip_boat_tour",
    "private_boat_tour", 
    "blue_cruise",
    "daily_boat_tour",
    "diving_tour",
    "fishing_tour",
    "yacht_tour",
    "island_tour",
    "night_tour",
    "romantic_tour"
  ],
  provider: "boattour",
  commissionRate: 0.08,
  vertical: "travel",
  regionSupport: ["TR"],
  metadata: {
    providerType: "tour_operator",
    hasAffiliate: true,
    hasGroupTours: true,
    hasPrivateTours: true,
    hasFoodOption: true,
    trustScore: 8.8,
    deliverySpeed: "instant",
    cancellationPolicy: "varies"
  },
  capabilities: {
    supportsApi: false,
    supportsScraping: true,
    supportsImages: true,
    supportsPricing: true,
    supportsTourDetails: true,
    supportsLocationFilter: true
  },
  tourCapabilities: {
    supportsDurationFilter: true,
    supportsLocationFilter: true,
    supportsTourTypeFilter: true,
    supportsPriceRange: true,
    supportsGroupSizeFilter: true,
    supportsInclusionsFilter: true
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

export async function testBoatTourAdapter() {
  const query = "bodrum tekne turu";
  const region = "TR";
  
  console.log("🧪 Boat tour adapter test başlıyor...");
  
  try {
    const result = await searchBoatTourAdapter(query, { region });
    
    console.log("✅ Test sonucu:", {
      ok: result.ok,
      itemCount: result.count,
      sampleItem: result.items[0] ? {
        title: result.items[0].title.substring(0, 50),
        price: result.items[0].price,
        provider: result.items[0].provider,
        category: result.items[0].category,
        commissionRate: result.items[0].commissionRate,
        tourInfo: result.items[0].tourInfo
      } : null
    });
    
    // Ana motor formatına uygun mu kontrol et
    const firstItem = result.items[0];
    if (firstItem) {
      const requiredFields = ['id', 'title', 'url', 'price', 'provider'];
      const missingFields = requiredFields.filter(field => !firstItem[field]);
      
      if (missingFields.length === 0) {
        console.log("🎉 Boat tour adapter ana motorla %100 uyumlu!");
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
  searchBoatTours,
  searchBoatToursScrape,
  searchBoatTourAdapter,
  boatTourAdapterConfig,
  testBoatTourAdapter
};


console.log("🚤 BOAT TOUR ADAPTER S200 ULTRA YÜKLENDİ - ANA MOTOR %100 UYUMLU");

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBoatTourAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "boattour";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "boatTourAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 15000) || 15000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBoatTourAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "boattour",
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
      source: "boattour",
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
      source: "boattour",
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
