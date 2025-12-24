// server/adapters/bimAdapter.js
// ======================================================================
// BİM ADAPTER — ANA MOTOR İLE %100 UYUMLU VERSİYON
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
  return v == null ? "" : String(v).trim();
}

function buildStableId(raw, title = "", provider = "bim") {
  const base = `${provider}_${raw || title || "id"}`;


  try {
    return "bim_" + crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16);
  } catch {
    return "bim_" + String(base).replace(/\W+/g, "_");
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

// ======================================================================
// CATEGORY DETECTION (Ana motor ile uyumlu)
// ======================================================================

function detectBimCategory(title) {
  const t = safe(title).toLowerCase();
  
  if (t.includes("çikolata") || t.includes("bisküvi") || t.includes("cips") || 
      t.includes("kraker") || t.includes("kek") || t.includes("go fırın")) {
    return "snack";
  }
  
  if (t.includes("temizlik") || t.includes("deterjan") || t.includes("çamaşır suyu") ||
      t.includes("sabun") || t.includes("şampuan") || t.includes("dezenfektan")) {
    return "cleaning";
  }
  
  if (t.includes("kişisel bakım") || t.includes("krem") || t.includes("diş macunu") ||
      t.includes("jilet") || t.includes("deodorant") || t.includes("parfüm")) {
    return "personal_care";
  }
  
  if (t.includes("gıda") || t.includes("makarna") || t.includes("pilav") || 
      t.includes("salça") || t.includes("yağ") || t.includes("un")) {
    return "food";
  }
  
  if (t.includes("içecek") || t.includes("su") || t.includes("meyve suyu") || 
      t.includes("kola") || t.includes("çay") || t.includes("kahve")) {
    return "beverage";
  }
  
  if (t.includes("dondurulmuş") || t.includes("donmuş") || t.includes("buzluk")) {
    return "frozen";
  }
  
  if (t.includes("süt") || t.includes("yoğurt") || t.includes("peynir") || 
      t.includes("tereyağ") || t.includes("krema")) {
    return "dairy";
  }
  
  if (t.includes("et") || t.includes("tavuk") || t.includes("balık") || 
      t.includes("sosis") || t.includes("salam")) {
    return "meat";
  }
  
  if (t.includes("meyve") || t.includes("sebze") || t.includes("salatalık") || 
      t.includes("domates") || t.includes("patates")) {
    return "fresh";
  }
  
  if (t.includes("bebek") || t.includes("çocuk") || t.includes("bebek bezi")) {
    return "baby";
  }
  
  if (t.includes("ev") || t.includes("mutfak") || t.includes("bardak") || 
      t.includes("tabak") || t.includes("tencere") || t.includes("tava")) {
    return "home";
  }
  
  if (t.includes("tekstil") || t.includes("giyim") || t.includes("tişört") || 
      t.includes("pantolon") || t.includes("çorap") || t.includes("havlu")) {
    return "textile";
  }
  
  return "market";
}

// ======================================================================
// NORMALIZE BİM ITEM (Ana motor normalizeItem ile uyumlu)
// ======================================================================

function normalizeBimItem(rawItem, mainCategory = "market", adapterName = "bimAdapter") {
  // URL'i normalize et
  let url = rawItem.href || null;
  if (url && !url.startsWith("http")) {
    if (url.startsWith("//")) {
      url = "https:" + url;
    } else if (url.startsWith("/")) {
      url = "https://www.bim.com.tr" + url;
    }
  }
  
  // Fiyatı normalize et
  let price = rawItem.price || null;
  
  // Realistic price validation for market products
  if (price) {
    if (price < 0.1) price = null; // Çok düşük fiyat
    if (price > 5000) price = null; // Çok yüksek fiyat
  }
  
  // Kategoriyi belirle
  const category = detectBimCategory(rawItem.title) || mainCategory;
  
  const item = {
    // ZORUNLU ALANLAR (ana motor için)
    id: rawItem.id || buildStableId(url, rawItem.title, "bim"),
    title: safe(rawItem.title),
    url: url,
    price: price,
    
    // OPSİYONEL ALANLAR
    rating: rawItem.rating || null,
    provider: "bim",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: category,
    adapterSource: adapterName,
    
    // S10 COMMISSION ENGINE ALANLARI
    commissionRate: rawItem.commissionRate || 0.03, // Market ürünleri için %3 komisyon
    commissionMeta: {
      platformRate: 0.03,
      categoryMultiplier: finalCategoryMultiplier[category] || finalCategoryMultiplier["market"] || 1.0,
      providerTier: "standard",
      source: "bim",
      isDiscounted: rawItem.isDiscounted || false,
      hasCampaign: rawItem.hasCampaign || false
    },
    
    // S9 PROVIDER MASTER ALANLARI
    providerType: "supermarket",
    vertical: "market",
    marketplaceType: "bim",
    
    // PRICE OPTIMIZATION
    optimizedPrice: rawItem.optimizedPrice || null,
    discountPercentage: rawItem.discountPercentage || null,
    
    // PRODUCT SPECIFIC FIELDS
    productInfo: {
      brand: rawItem.brand || "BİM",
      weight: rawItem.weight || null,
      volume: rawItem.volume || null,
      unit: rawItem.unit || null,
      isDiscounted: rawItem.isDiscounted || false,
      campaignText: rawItem.campaignText || null,
      expirationDate: rawItem.expirationDate || null,
      isFresh: category === "fresh" || category === "dairy" || category === "meat",
      isFrozen: category === "frozen",
      isNonFood: ["cleaning", "personal_care", "home", "textile"].includes(category)
    },
    
    // IMAGE OPTIMIZATION
    image: rawItem.imgRaw || null,
    imageVariants: rawItem.imgRaw ? buildImageVariants(rawItem.imgRaw, "bim") : [],

    
    // AVAILABILITY
    availability: price ? "available" : "unknown",
    stockStatus: price ? "in_stock" : "unknown",
    
   
    // PROVIDER TRUST SCORE
trustScore: 9.2,

    
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
      provider: "bim",
      region: item.region || "TR",
      category: item.category || "market",
      subCategory: item.productInfo?.isNonFood ? "non_food" : "food",
      mode: "supermarket",
      source: item.raw?.source || "scraping"
    });
    
    // Commission bilgilerini ekle (yoksa)
    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.03;
      optimized.commissionMeta = {
        platformRate: 0.03,
        categoryMultiplier: finalCategoryMultiplier[item.category] || finalCategoryMultiplier["market"] || 1.0,
        providerTier: "standard",
        source: "bim_adapter"
      };
    }
    
    // Product info'yu optimize edilmiş item'a taşı
    if (item.productInfo && !optimized.productInfo) {
      optimized.productInfo = item.productInfo;
    }
    
    return optimized;
    
  } catch (e) {
    console.warn("BİM optimize hata:", e?.message);
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

// ======================================================================
// MAIN ADAPTER — Ana motor ile uyumlu
// ======================================================================

export async function searchBimAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  const requestId = `bim_${Date.now()}_${__s200_next().toString(36).substr(2, 9)}`;

  // ===================== S200 RATE LIMITER ======================
  const region = options.region || "TR";
  const limiterKey = `s200:adapter:bim:${region}`;

  const allowed = await rateLimiter.check(limiterKey, {
    limit: 20,          // BIM için ideal RPM
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
      adapterName: "bimAdapter",
      _meta: {
        limiterKey,
        timestamp: Date.now()
      }
    };
  }
  // ===============================================================

  console.log(`🛒 [${requestId}] BİM adapter başladı: "${query.substring(0, 50)}"`);

  try {
    const signal = options.signal || null;

    
    // BİM için genellikle güncel ürünler sayfası
    const url = "https://www.bim.com.tr/aktuel-urunler";

    const html = await fetchHTML(url, signal);
    if (!html) {
      return await bimFallback(query, region, startTime, requestId);
    }

    const $ = loadCheerioS200(html);
    const rawItems = [];

const selectors = [
  "li[class*='urun']",       // BIM'in ana ürün kutuları
  "li.card-item",            // Aktüel ürün grid kartları
  "li.card"                  // Alternatif ürün kartları
];





    selectors.forEach((sel) => {
      $(sel).each((i, el) => {
        try {
          const w = $(el);

const title =
  safe(w.find(".product-name").text()) ||
  safe(w.find(".title").text()) ||
  safe(w.find(".productTitle").text()) ||
  safe(w.find("h3").text()) ||
  safe(w.find("h4").text());

if (!title || title.length < 2) return;

const priceTxt =
  safe(w.find(".price-new").text()) ||
  safe(w.find(".price").text()) ||
  safe(w.find(".productPrice").text()) ||
  safe(w.find("span[class*='price']").text()) ||
  safe(w.find(".fiyat").text());
const price = parsePriceStrong(priceTxt);

let imgRaw =
  safe(w.find("img").attr("data-src")) ||
  safe(w.find("img").attr("src")) ||
  safe(w.find(".product-image img").attr("src")) ||
  null;

if (imgRaw?.startsWith("//")) imgRaw = "https:" + imgRaw;
if (imgRaw?.startsWith("/")) imgRaw = "https://www.bim.com.tr" + imgRaw;

let href =
  safe(w.find("a").attr("href")) ||
  safe(w.find("a[class*='product']").attr("href")) ||
  safe(w.find("[onclick*='open']").attr("onclick")) ||
  null;

// onclick yakalandıysa -> URL üret
if (href && href.includes("open")) {
  const idMatch = href.match(/'(\d+)'/);
  if (idMatch) {
    href = `https://www.bim.com.tr/aktuel-urunler/${idMatch[1]}`;
  }
}

if (!href) return;


const brand = "BİM";
const weight = extractWeightFromTitle(title);

const cardText = safe(w.text()).toLowerCase();
const isDiscounted =
  cardText.includes("indirim") ||
  cardText.includes("kampanya") ||
  cardText.includes("aktüel");

const category = detectBimCategory(title);


          rawItems.push({
            title,
            price,
            href,
            imgRaw,
            brand,
            weight,
            isDiscounted,
            category,
            raw: {
              html: w.html()?.substring(0, 500) || null,
              extractedAt: new Date().toISOString(),
              source: "scraping"
            }
          });
        } catch (itemError) {
          console.warn("BİM item parsing error:", itemError.message);
        }
      });
    });

  const normalizedItems = rawItems
  .map(raw => normalizeBimItem(raw, "market", "bimAdapter"))
  .map(item => applyOptimizePrice(item))
  .filter(item => item && item.title && item.price != null)

  .slice(0, 50);


    const duration = Date.now() - startTime;
    
    if (normalizedItems.length > 0) {
      console.log(`✅ [${requestId}] BİM adapter başarılı: ${normalizedItems.length} ürün, ${duration}ms`);
      
      // S10 adapter statüsünü kaydet
      s10_registerAdapterStatus('bimAdapter', true, duration);
      
      // İstatistikler
      const categories = {};
      const priceStats = {
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0
      };
      
      for (const item of normalizedItems) {
        const category = item.category || 'market';
        categories[category] = (categories[category] || 0) + 1;
        
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
        adapterName: "bimAdapter",
        duration,
        metadata: {
          requestId,
          query,
          region,
          source: "scraping",
          categories,
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
      console.log(`⚠️ [${requestId}] BİM adapter sonuç yok → fallback`);
      return await bimFallback(query, region, startTime, requestId);
    }
    
  } catch (err) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [BİM adapter] Hata: ${err.message}`, {
      query: query?.substring(0, 100),
      duration,
      timestamp: new Date().toISOString()
    });
    
    // S10 adapter statüsünü kaydet
    s10_registerAdapterStatus('bimAdapter', false, duration);
    
    // Fallback'e geç
    return await bimFallback(query, options.region || "TR", startTime, requestId);
  }
}

// ======================================================================
// HELPER: Extract weight from title
// ======================================================================

function extractWeightFromTitle(title) {
  const weightPatterns = [
    /(\d+)\s*(gr|g|gram)/i,
    /(\d+)\s*(kg|kilo)/i,
    /(\d+)\s*(ml|mililitre)/i,
    /(\d+)\s*(lt|l|litre)/i,
    /(\d+)\s*(adet)/i,
    /(\d+)\s*(paket)/i
  ];
  
  for (const pattern of weightPatterns) {
    const match = title.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      return { value, unit };
    }
  }
  
  return null;
}

// ======================================================================
// FALLBACK — Ana motor ile uyumlu
// ======================================================================

async function bimFallback(query, region = "TR", startTime = Date.now(), requestId = "bim_fallback") {
  try {
    const raw = {
      title: `${query} - BİM'de Bul`,
      price: null,
      href: "https://www.bim.com.tr/",
      imgRaw: null,
      brand: "BİM",
      category: "market",
      raw: {
        source: "fallback",
        extractedAt: new Date().toISOString()
      }
    };

    const normalizedItem = normalizeBimItem(raw, "market", "bimFallback");
    const optimizedItem = applyOptimizePrice(normalizedItem);
    
    const duration = Date.now() - startTime;
    
    console.log(`⚠️ [${requestId}] BİM fallback kullanıldı, ${duration}ms`);
    
    s10_registerAdapterStatus('bimAdapter', true, duration);
    
    return {
      ok: true,
      items: [optimizedItem],
      count: 1,
      adapterName: "bimFallback",
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
    
    console.error(`❌ [BİM fallback] Hata: ${error.message}`);
    
    s10_registerAdapterStatus('bimAdapter', false, duration);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      adapterName: "bimFallback",
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

export async function searchBim(query, opts = {}) {
  return await searchBimAdapter(query, opts);
}

// ======================================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// ======================================================================

export const bimAdapterConfig = {
  name: "bim",
  fn: searchBimAdapter,
  timeoutMs: 15000,
  priority: 1.2,
  category: "market",
  subCategories: [
    "snack",
    "cleaning", 
    "personal_care",
    "food",
    "beverage",
    "frozen",
    "dairy",
    "meat",
    "fresh",
    "baby",
    "home",
    "textile"
  ],
  provider: "bim",
  commissionRate: 0.03,
  vertical: "market",
  regionSupport: ["TR"],
  metadata: {
    providerType: "supermarket",
    hasAffiliate: true,
    hasDiscounts: true,
    hasCampaigns: true,
    hasFreshProducts: true,
    trustScore: 9.2,
    deliverySpeed: "varies",
    storeCount: 10000
  },
  capabilities: {
    supportsApi: false,
    supportsScraping: true,
    supportsImages: true,
    supportsPricing: true,
    supportsProductDetails: true,
    supportsStockInfo: true
  },
  marketCapabilities: {
    supportsCategoryFilter: true,
    supportsPriceRange: true,
    supportsBrandFilter: false,
    supportsWeightFilter: true,
    supportsFreshFilter: true,
    supportsDiscountFilter: true
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

export async function testBimAdapter() {
  const query = "çikolata";
  const region = "TR";
  
  console.log("🧪 BİM adapter test başlıyor...");
  
  try {
    const result = await searchBimAdapter(query, { region });
    
    console.log("✅ Test sonucu:", {
      ok: result.ok,
      itemCount: result.count,
      sampleItem: result.items[0] ? {
        title: result.items[0].title.substring(0, 50),
        price: result.items[0].price,
        provider: result.items[0].provider,
        category: result.items[0].category,
        commissionRate: result.items[0].commissionRate,
        productInfo: result.items[0].productInfo
      } : null
    });
    
    // Ana motor formatına uygun mu kontrol et
    const firstItem = result.items[0];
    if (firstItem) {
      const requiredFields = ['id', 'title', 'url', 'price', 'provider'];
      const missingFields = requiredFields.filter(field => !firstItem[field]);
      
      if (missingFields.length === 0) {
        console.log("🎉 BİM adapter ana motorla %100 uyumlu!");
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
  searchBim,
  searchBimAdapter,
  bimAdapterConfig,
  testBimAdapter
};

console.log("🛒 BİM ADAPTER S200 ULTRA YÜKLENDİ - ANA MOTOR %100 UYUMLU");

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBimAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "bim";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "bimAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 15000) || 15000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBimAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "bim",
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
      source: "bim",
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
      source: "bim",
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
