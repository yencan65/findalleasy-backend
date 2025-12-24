// server/adapters/biletinoAdapter.js
// ======================================================================
// BILETINO ADAPTER — ANA MOTOR İLE %100 UYUMLU VERSİYON
// ======================================================================
// Hercules S200 normalizeItem + optimizePrice + commissionEngine + providerMaster entegre
// ======================================================================

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
  } catch (err) {
    // Silent fail
  }
}

// ======================================================================
// HELPER FUNCTIONS
// ======================================================================

const TIMEOUT_MS = 9000;

function safe(v) {
  return v ? String(v).trim() : "";
}

function buildStableId(raw, title = "", provider = "biletino") {
  const base = `${provider}_${raw || title || "id"}`;
  try {
    return (
      "biletino_" +
      crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16)
    );
  } catch {
    return "biletino_" + String(base).replace(/\W+/g, "_");
  }
}

function slugify(t) {
  return safe(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

// ======================================================================
// EVENT CATEGORY DETECTION (Ana motor ile uyumlu)
// ======================================================================

function detectBiletinoCategory(title, description = "") {
  const text = (title + " " + description).toLowerCase();

  if (
    text.includes("konser") ||
    text.includes("concert") ||
    text.includes("dj") ||
    text.includes("müzik") ||
    text.includes("music")
  ) {
    return "concert";
  }

  if (text.includes("festival")) {
    return "festival";
  }

  if (
    text.includes("tiyatro") ||
    text.includes("theatre") ||
    text.includes("oyun") ||
    text.includes("opera") ||
    text.includes("bale")
  ) {
    return "theatre";
  }

  if (
    text.includes("stand") ||
    text.includes("komedi") ||
    text.includes("comedy")
  ) {
    return "standup";
  }

  if (
    text.includes("sinema") ||
    text.includes("film") ||
    text.includes("movie")
  ) {
    return "cinema";
  }

  if (
    text.includes("spor") ||
    text.includes("sport") ||
    text.includes("futbol") ||
    text.includes("basketbol") ||
    text.includes("maç")
  ) {
    return "sports";
  }

  if (
    text.includes("sergi") ||
    text.includes("exhibition") ||
    text.includes("müze")
  ) {
    return "exhibition";
  }

  if (
    text.includes("çocuk") ||
    text.includes("kids") ||
    text.includes("child")
  ) {
    return "kids";
  }

  return "event";
}

// ======================================================================
// EVENT DATE EXTRACTION
// ======================================================================

function extractEventDate($wrap) {
  const txt =
    safe($wrap.find(".event-date").text()) ||
    safe($wrap.find(".date").text()) ||
    safe($wrap.find(".event-info").text()) ||
    safe($wrap.find(".time").text()) ||
    safe($wrap.find(".tarih").text());

  if (!txt) return null;

  // Biletino'da genelde "12 Ocak 2025" formatı
  const months = {
    ocak: 0,
    şubat: 1,
    mart: 2,
    nisan: 3,
    mayıs: 4,
    haziran: 5,
    temmuz: 6,
    ağustos: 7,
    eylül: 8,
    ekim: 9,
    kasım: 10,
    aralık: 11,
  };

  const m = txt
    .toLowerCase()
    .match(
      /(\d{1,2})\s+(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)\s*(\d{4})?/i
    );

  if (!m) return null;

  const day = Number(m[1]);
  const month = months[m[2]];
  const year = m[3] ? Number(m[3]) : new Date().getFullYear();

  const d = new Date(year, month, day);
  return isNaN(d) ? null : d.toISOString();
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
    "İstanbul",
    "Ankara",
    "İzmir",
    "Bursa",
    "Adana",
    "Antalya",
    "Konya",
    "Gaziantep",
    "Kayseri",
    "Mersin",
    "Eskişehir",
    "Diyarbakır",
    "Samsun",
  ];

  for (const city of cities) {
    if (location.includes(city)) return city;
  }

  return location.split(",")[0] || location;
}

function extractPrice($wrap) {
  const priceText =
    safe($wrap.find(".event-price").text()) ||
    safe($wrap.find(".price").text()) ||
    safe($wrap.find(".bilet-fiyat").text()) ||
    safe($wrap.find(".ticket-price").text());

  if (!priceText) return null;

  // Fiyatı sayısal değere çevir
  const match = priceText.match(/(\d+[\.,]?\d*)/);
  if (!match) return null;

  const priceStr = match[1].replace(",", ".");
  const price = parseFloat(priceStr);

  return isNaN(price) ? null : price;
}

// ======================================================================
// NORMALIZE BILETINO ITEM (Ana motor normalizeItem ile uyumlu)
// ======================================================================

function normalizeBiletinoItem(
  rawItem,
  mainCategory = "event",
  adapterName = "biletinoAdapter"
) {
  // URL'i normalize et
  let url = rawItem.href || null;
  if (url && !url.startsWith("http") && url.startsWith("/")) {
    url = "https://biletino.com" + url;
  }

  // Fiyatı normalize et
  let price = rawItem.price ?? null;

  // Realistic price validation for events
  if (price != null) {
    if (price < 10) price = null; // Etkinlik fiyatı 10 TL'den az olamaz
    if (price > 5000) price = null; // Etkinlik fiyatı 5,000 TL'den fazla olamaz
  }

  // Kategoriyi belirle
  const category =
    detectBiletinoCategory(rawItem.title, rawItem.description) ||
    mainCategory;

  const commissionRate =
    typeof rawItem.commissionRate === "number" && rawItem.commissionRate > 0
      ? rawItem.commissionRate
      : 0.03;

  const item = {
    // ZORUNLU ALANLAR (ana motor için)
    id: rawItem.id || buildStableId(url, rawItem.title, "biletino"),
    title: safe(rawItem.title),
    url: url,
    price: price,

    // OPSİYONEL ALANLAR
    rating: rawItem.rating || null,
    provider: "biletino",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: category,
    adapterSource: adapterName,

    // S10 COMMISSION ENGINE ALANLARI
    commissionRate,
    commissionMeta: {
      platformRate: 0.03,
      categoryMultiplier:
        finalCategoryMultiplier[category] ||
        finalCategoryMultiplier["event"] ||
        1.0,
      providerTier: "standard",
      source: "biletino",
      isElectronicTicket:
        rawItem.isElectronicTicket !== undefined
          ? !!rawItem.isElectronicTicket
          : true,
      hasSeatSelection:
        rawItem.hasSeatSelection !== undefined
          ? !!rawItem.hasSeatSelection
          : false,
    },

    // S9 PROVIDER MASTER ALANLARI
    providerType: "event_ticketing",
    vertical: "event",
    marketplaceType: "biletino",

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
      isOnline: rawItem.isOnline || false,
      isCancelled: rawItem.isCancelled || false,
      isSoldOut: rawItem.isSoldOut || false,
      minAge: rawItem.minAge || null,
      duration: rawItem.duration || null,
      ticketType: rawItem.ticketType || "standard",
    },

    // IMAGE OPTIMIZATION
    image: rawItem.imgRaw || null,
    imageVariants: buildImageVariants(rawItem.imgRaw, "biletino"),

    // AVAILABILITY
    availability: price ? "available" : "unknown",
    stockStatus: price ? "in_stock" : "unknown",

    // PROVIDER TRUST SCORE
    providerTrust: 0.85,

    // RAW DATA (debug için)
    raw: rawItem.raw || rawItem,

    // S10 SCORE (başlangıç değeri)
    score: 0.01,
  };

  return item;
}

// ======================================================================
// OPTIMIZE PRICE WRAPPER (Ana motor ile uyumlu)
// ======================================================================

function applyOptimizePrice(item) {
  try {
    const optimized = optimizePrice(item, {
      provider: "biletino",
      region: item.region || "TR",
      category: item.category || "event",
      subCategory: item.eventInfo?.ticketType || "standard",
      mode: "event_ticketing",
      source: item.raw?.source || "scraping",
    });

    // Commission bilgilerini ekle (yoksa)
    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.03;
    }

    optimized.commissionMeta = {
      ...(optimized.commissionMeta || {}),
      platformRate:
        optimized.commissionMeta?.platformRate != null
          ? optimized.commissionMeta.platformRate
          : 0.03,
      categoryMultiplier:
        finalCategoryMultiplier[item.category] ||
        finalCategoryMultiplier["event"] ||
        1.0,
      providerTier: optimized.commissionMeta?.providerTier || "standard",
      source: optimized.commissionMeta?.source || "biletino_adapter",
    };

    // Event info'yu optimize edilmiş item'a taşı
    if (item.eventInfo && !optimized.eventInfo) {
      optimized.eventInfo = item.eventInfo;
    }

    return optimized;
  } catch (e) {
    console.warn("Biletino optimize hata:", e?.message || e);
    return item;
  }
}

// ======================================================================
// PROXY-FIRST HTML GETTER
// ======================================================================

async function fetchHTML(url, signal) {
  try {
    const html = await proxyFetchHTML(url, { signal });
    if (html) return html;
  } catch {}

  const { data } = await axios.get(url, {
    timeout: TIMEOUT_MS,
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  return data;
}

// ======================================================================
// MAIN ADAPTER — Ana motor ile uyumlu
// ======================================================================

export async function searchBiletinoAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  const requestId = `biletino_${Date.now()}_${__s200_next()
    .toString(36)
    .substr(2, 9)}`;
	// ===================== S200 RATE LIMITER ======================
const region = options.region || "TR";
const limiterKey = `s200:adapter:biletino:${region}`;

const allowed = await rateLimiter.check(limiterKey, {
  limit: 25,        // Biletino için ideal RPM
  windowMs: 60_000, // 1 dakika penceresi
  burst: true,
  adaptive: true
});

if (!allowed) {
  return {
    ok: false,
    items: [],
    count: 0,
    error: "S200_RATE_LIMIT_EXCEEDED",
    adapterName: "biletinoAdapter",
    _meta: {
      limiterKey,
      timestamp: Date.now()
    }
  };
}


  const safeQueryLog = String(query || "");
  console.log(
    `🎫 [${requestId}] Biletino adapter başladı: "${safeQueryLog.substring(
      0,
      50
    )}"`
  );

  try {
    
    const signal = options.signal || null;

    const q = encodeURIComponent(String(query || ""));
    const url = `https://biletino.com/tr/e/${q}`;

    const html = await fetchHTML(url, signal);
    const $ = loadCheerioS200(html);

    const rawItems = [];

    $(".event-item, .event-card, .event-list-item").each((i, el) => {
      try {
        const w = $(el);

        const title =
          safe(w.find(".event-title").text()) ||
          safe(w.find("h3").text()) ||
          safe(w.find("h4").text()) ||
          safe(w.find(".title").text());
        if (!title || title.length < 3) return;

        const description =
          safe(w.find(".event-description").text()) ||
          safe(w.find(".description").text()) ||
          safe(w.find(".summary").text()) ||
          "";

        let href = w.find("a").attr("href");
        if (!href) return;

        const imgRaw =
          safe(w.find("img").attr("data-src")) ||
          safe(w.find("img").attr("src")) ||
          null;

        const eventDate = extractEventDate(w);
        const location = extractLocation(w);
        const price = extractPrice(w);
        const category = detectBiletinoCategory(title, description);

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
            source: "scraping",
          },
        });
      } catch (itemError) {
        console.warn(
          "Biletino item parsing error:",
          itemError?.message || String(itemError)
        );
      }
    });

    // Normalize ve optimize et
    const normalizedItems = rawItems
      .map((raw) => normalizeBiletinoItem(raw, "event", "biletinoAdapter"))
      .map((item) => applyOptimizePrice(item))
      .filter((item) => item && item.title && item.url)
      .slice(0, 40); // Limit to 40 items

    const duration = Date.now() - startTime;

    if (normalizedItems.length > 0) {
      console.log(
        `✅ [${requestId}] Biletino adapter başarılı: ${normalizedItems.length} etkinlik, ${duration}ms`
      );

      // S10 adapter statüsünü kaydet
      s10_registerAdapterStatus("biletinoAdapter", true, duration);

      // İstatistikler
      const eventTypes = {};
      const locations = {};

      for (const item of normalizedItems) {
        const eventType = item.category || "event";
        eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

        const loc = item.eventInfo?.location || "unknown";
        locations[loc] = (locations[loc] || 0) + 1;
      }

      const prices = normalizedItems
        .map((i) => (typeof i.price === "number" ? i.price : null))
        .filter((p) => p != null);

      let priceRange = null;
      if (prices.length > 0) {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const avg =
          prices.reduce((sum, p) => sum + p, 0) / (prices.length || 1);
        priceRange = {
          min,
          max,
          avg: Math.round(avg),
        };
      }

      return {
        ok: true,
        items: normalizedItems,
        count: normalizedItems.length,
        adapterName: "biletinoAdapter",
        duration,
        metadata: {
          requestId,
          query: String(query || ""),
          region,
          source: "scraping",
          eventTypes,
          locations,
          priceRange,
          timestamp: new Date().toISOString(),
        },
      };
    } else {
      // Fallback
      console.log(
        `⚠️ [${requestId}] Biletino adapter sonuç yok → fallback (query="${safeQueryLog}")`
      );
      return await biletinoFallback(
        String(query || ""),
        region,
        startTime,
        requestId
      );
    }
  } catch (err) {
    const duration = Date.now() - startTime;

    console.error(`❌ [Biletino adapter] Hata: ${err?.message || err}`, {
      query: String(query || "").substring(0, 100),
      duration,
      timestamp: new Date().toISOString(),
    });

    // S10 adapter statüsünü kaydet
    s10_registerAdapterStatus("biletinoAdapter", false, duration);

    // Fallback'e geç
    return await biletinoFallback(
      String(query || ""),
      options.region || "TR",
      startTime,
      requestId
    );
  }
}

// ======================================================================
// FALLBACK — Ana motor ile uyumlu
// ======================================================================

async function biletinoFallback(
  query,
  region = "TR",
  startTime = Date.now(),
  requestId = "biletino_fallback"
) {
  try {
    const raw = {
      title: `${query} - Etkinlik Bileti`,
      price: null,
      href: "https://biletino.com/",
      imgRaw: null,
      description: null,
      eventDate: null,
      location: null,
      category: "event",
      raw: {
        source: "fallback",
        extractedAt: new Date().toISOString(),
      },
    };

    const normalizedItem = normalizeBiletinoItem(
      raw,
      "event",
      "biletinoFallback"
    );
    const optimizedItem = applyOptimizePrice(normalizedItem);

    const duration = Date.now() - startTime;

    console.log(
      `⚠️ [${requestId}] Biletino fallback kullanıldı, ${duration}ms`
    );

    s10_registerAdapterStatus("biletinoAdapter", true, duration);

    return {
      ok: true,
      items: [optimizedItem],
      count: 1,
      adapterName: "biletinoFallback",
      duration,
      metadata: {
        requestId,
        query,
        region,
        source: "fallback",
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    console.error(
      `❌ [Biletino fallback] Hata: ${error?.message || error}`
    );

    s10_registerAdapterStatus("biletinoAdapter", false, duration);

    return {
      ok: false,
      items: [],
      count: 0,
      error: error?.message || String(error),
      adapterName: "biletinoFallback",
      duration,
      metadata: {
        query,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      },
    };
  }
}

// ======================================================================
// WRAPPERS — Legacy support
// ======================================================================

export async function searchBiletino(query, opts = {}) {
  return await searchBiletinoAdapter(query, opts);
}

// ======================================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// ======================================================================

export const biletinoAdapterConfig = {
  name: "biletino",
  fn: searchBiletinoAdapter,
  timeoutMs: TIMEOUT_MS,
  priority: 1.2,
  category: "event",
  subCategories: [
    "concert",
    "festival",
    "theatre",
    "standup",
    "cinema",
    "sports",
    "exhibition",
    "kids",
  ],
  provider: "biletino",
  commissionRate: 0.03,
  vertical: "event",
  regionSupport: ["TR"],
  metadata: {
    providerType: "event_ticketing",
    hasAffiliate: true,
    hasElectronicTickets: true,
    hasSeatSelection: true,
    trustScore: 8.5,
    deliverySpeed: "instant",
    cancellationPolicy: "varies",
  },
  capabilities: {
    supportsApi: false,
    supportsScraping: true,
    supportsImages: true,
    supportsPricing: true,
    supportsEventDetails: true,
    supportsLocationFilter: true,
  },
  eventCapabilities: {
    supportsDateFilter: true,
    supportsLocationFilter: true,
    supportsCategoryFilter: true,
    supportsPriceRange: true,
    supportsAgeRestriction: true,
  },
  s10Integration: {
    supportsCommissionEngine: true,
    supportsPriceOptimization: true,
    supportsAffiliateUrls: true,
    supportsUserTracking: true,
  },
};

// ======================================================================
// TEST FUNCTION (İsteğe bağlı)
// ======================================================================

export async function testBiletinoAdapter() {
  const query = "konser istanbul";
  const region = "TR";

  console.log("🧪 Biletino adapter test başlıyor...");

  try {
    const result = await searchBiletinoAdapter(query, { region });

    console.log("✅ Test sonucu:", {
      ok: result.ok,
      itemCount: result.count,
      sampleItem: result.items[0]
        ? {
            title: result.items[0].title.substring(0, 50),
            price: result.items[0].price,
            provider: result.items[0].provider,
            category: result.items[0].category,
            commissionRate: result.items[0].commissionRate,
            eventInfo: result.items[0].eventInfo,
          }
        : null,
    });

    // Ana motor formatına uygun mu kontrol et
    const firstItem = result.items[0];
    if (firstItem) {
      const requiredFields = ["id", "title", "url", "price", "provider"];
      const missingFields = requiredFields.filter((field) => !firstItem[field]);

      if (missingFields.length === 0) {
        console.log("🎉 Biletino adapter ana motorla %100 uyumlu!");
      } else {
        console.warn("⚠️ Eksik alanlar:", missingFields);
      }
    }

    return result;
  } catch (error) {
    console.error("❌ Test başarısız:", error?.message || error);
    throw error;
  }
}

// ======================================================================
// DEFAULT EXPORT
// ======================================================================

export default {
  searchBiletino,
  searchBiletinoAdapter,
  biletinoAdapterConfig,
  testBiletinoAdapter,
};

console.log("🎫 BILETINO ADAPTER S200 ULTRA YÜKLENDİ - ANA MOTOR %100 UYUMLU");

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBiletinoAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "biletino";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "biletinoAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBiletinoAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "biletino",
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
      source: "biletino",
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
      source: "biletino",
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
