// server/adapters/barcode.js
// ======================================================================
// BARKOD ADAPTER — ANA MOTOR İLE %100 UYUMLU VERSİYON
// ======================================================================
// Hercules S200 normalizeItem + optimizePrice + commissionEngine + providerMaster entegre
// ======================================================================

import {
searchWithSerpApi } from "./serpApi.js";
import fetch from "node-fetch";
import { searchOpenFoodFacts } from "./openFoodFacts.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { finalCategoryMultiplier } from "../core/commissionRates.js";

import {



  withTimeout, coerceItemsS200, normalizeItemS200, stableIdS200, safeStr,
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
  return v ? String(v).trim() : "";
}

function normalizeRegion(input) {
  const r = String(input || "TR").toUpperCase();
  const map = {
    TR: "TR",
    TURKEY: "TR",
    EU: "EU",
    EUROPE: "EU",
    US: "US",
    USA: "US",
    UK: "UK",
    GB: "UK",
    DE: "DE",
    FR: "FR",
  };
  return map[r] || "TR";
}

function isValidBarcodeFormat(code) {
  return /^\d{8,14}$/.test(code);
}

function isValidGtinChecksum(code) {
  const digits = String(code || "").trim();
  if (!/^\d{8,14}$/.test(digits)) return false;

  const len = digits.length;
  if (![8, 12, 13, 14].includes(len)) return false;

  let sum = 0;
  const parity = len % 2 === 0 ? 0 : 1;

  for (let i = 0; i < len - 1; i++) {
    const d = Number(digits[i]);
    const isOddFromRight = ((len - i) % 2) === parity;
    sum += d * (isOddFromRight ? 3 : 1);
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(digits[len - 1]);
}

function sanitizeUrl(u = "") {
  try {
    const url = new URL(u);
    if (!["http:", "https:"].includes(url.protocol)) return null;

    if (url.href.startsWith("data:")) return null;
    if (url.href.startsWith("javascript:")) return null;

    const badHosts = ["localhost", "127.0.0.1", "0.0.0.0"];
    if (badHosts.includes(url.hostname)) return null;

    if (
      url.hostname.includes("webcache.googleusercontent.com") ||
      url.hostname.includes("translate.google") ||
      url.hostname.includes("translate.goog")
    ) {
      return null;
    }

    const params = url.searchParams;
    const toDelete = [];

    params.forEach((_, key) => {
      const k = key.toLowerCase();
      if (k.startsWith("utm_") || k === "gclid" || k === "fbclid" || k === "mc_eid") {
        toDelete.push(key);
      }
    });

    toDelete.forEach((k) => params.delete(k));
    return url.toString();
  } catch {
    return null;
  }
}

function nutriToRating(letter) {
  const l = String(letter || "").toLowerCase();
  return { a: 4.8, b: 4.3, c: 3.8, d: 3.2, e: 2.5 }[l] ?? null;
}

// ======================================================================
// OPEN FACTS (FREE) — Direct barcode resolve (food + beauty + general)
// ======================================================================
async function lookupOpenFactsByBarcode(code, { signal } = {}) {
  const barcode = String(code || "").trim();
  if (!/^\d{8,14}$/.test(barcode)) return null;

  const endpoints = [
    {
      key: "openfoodfacts",
      api: `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`,
      page: `https://world.openfoodfacts.org/product/${barcode}`,
    },
    {
      key: "openbeautyfacts",
      api: `https://world.openbeautyfacts.org/api/v2/product/${barcode}`,
      page: `https://world.openbeautyfacts.org/product/${barcode}`,
    },
    {
      key: "openproductsfacts",
      api: `https://world.openproductsfacts.org/api/v2/product/${barcode}.json`,
      page: `https://world.openproductsfacts.org/product/${barcode}`,
    },
  ];

  for (const ep of endpoints) {
    try {
      const r = await withTimeout(
        fetch(ep.api, {
          method: "GET",
          headers: {
            "User-Agent": "FindAllEasy/1.0 (+https://findalleasy.com)",
            "Accept": "application/json",
          },
          signal,
        }),
        4500,
        `openfacts:${ep.key}`
      );

      if (!r || !r.ok) continue;

      const txt = await r.text();
      let j;
      try {
        j = JSON.parse(txt);
      } catch {
        continue;
      }

      const p = j?.product;
      const title =
        safe(p?.product_name) ||
        safe(p?.product_name_en) ||
        safe(p?.generic_name) ||
        safe(p?.generic_name_en) ||
        safe(p?.abbreviated_product_name) ||
        "";

      if (!title) continue;

      const imageRaw =
        safe(p?.image_url) ||
        safe(p?.image_front_url) ||
        safe(p?.image_small_url) ||
        "";

      return {
        provider: ep.key,
        title,
        url: ep.page,
        image: imageRaw,
        brand: safe(p?.brands),
        raw: p,
      };
    } catch {
      // ignore and try next endpoint
    }
  }

  return null;
}

// ======================================================================
// NORMALIZE BARCODE ITEM (Ana motor normalizeItem ile uyumlu)
// ======================================================================

function normalizeBarcodeItem(rawItem, mainCategory = "product", adapterName = "barcodeAdapter") {
  // URL'i normalize et
  let url = sanitizeUrl(rawItem.url);
  
  // Fiyatı normalize et
  let price = rawItem.price || null;
  
  // Realistic price validation
  if (price) {
    if (price < 0.01) price = null; // Çok düşük fiyat
    if (price > 1000000) price = null; // Çok yüksek fiyat
  }
  
  // Kategoriyi belirle
  const titleLower = (rawItem.title || "").toLowerCase();
  let category = mainCategory;
  
  if (titleLower.includes("gıda") || titleLower.includes("yiyecek") || 
      titleLower.includes("içecek") || titleLower.includes("su") ||
      titleLower.includes("çikolata") || titleLower.includes("bisküvi")) {
    category = "food";
  } else if (titleLower.includes("kozmetik") || titleLower.includes("parfüm") ||
             titleLower.includes("şampuan") || titleLower.includes("sabun")) {
    category = "cosmetics";
  } else if (titleLower.includes("temizlik") || titleLower.includes("deterjan")) {
    category = "cleaning";
  } else if (titleLower.includes("ilaç") || titleLower.includes("vitamin")) {
    category = "health";
  } else if (titleLower.includes("elektronik") || titleLower.includes("pil") ||
             titleLower.includes("batarya")) {
    category = "electronics";
  }
  
  const item = {
    // ZORUNLU ALANLAR (ana motor için)
    id: rawItem.id || stableIdS200('barcode', String(rawItem?.originUrl || rawItem?.url || url || rawItem?.barcode || rawItem?.qrCode || ''), String(rawItem?.title || rawItem?.barcode || rawItem?.qrCode || 'barcode')),
    title: safe(rawItem.title),
    url: url,
    price: price,
	affiliateUrl: url
  ? (url.includes("?")
      ? `${url}&aff_id=findalleasy_barcode`
      : `${url}?aff_id=findalleasy_barcode`)
  : url,

    
    // OPSİYONEL ALANLAR
    rating: rawItem.rating || null,
    provider: rawItem.provider || "unknown",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: category,
    adapterSource: adapterName,
    
    // S10 COMMISSION ENGINE ALANLARI
    commissionRate: rawItem.commissionRate || 0.05, // Barkod ürünleri için %5 komisyon
    commissionMeta: {
      platformRate: 0.05,
      categoryMultiplier: finalCategoryMultiplier[category] || finalCategoryMultiplier["product"] || 1.0,
      providerTier: "standard",
      source: rawItem.provider || "barcode",
      isVerified: rawItem.isVerified || false,
      hasNutritionInfo: rawItem.hasNutritionInfo || false
    },
    
    // S9 PROVIDER MASTER ALANLARI
    providerType: "product_search",
    vertical: "product",
    marketplaceType: "mixed",
    
    // PRICE OPTIMIZATION
    optimizedPrice: rawItem.optimizedPrice || null,
    discountPercentage: rawItem.discountPercentage || null,
    
    // PRODUCT SPECIFIC FIELDS
    productInfo: {
      barcode: rawItem.barcode || rawItem.code || null,
      brand: rawItem.brand || null,
      weight: rawItem.weight || null,
      volume: rawItem.volume || null,
      ingredients: rawItem.ingredients || null,
      nutritionScore: rawItem.nutritionScore || null,
      isFood: category === "food",
      isCosmetic: category === "cosmetics",
      isMedicine: category === "health"
    },
    
    // IMAGE OPTIMIZATION
    image: rawItem.imageRaw || null,
    imageVariants: buildImageVariants(rawItem.imageRaw, rawItem.provider || "barcode"),
    
    // AVAILABILITY
    availability: price ? "available" : "unknown",
    stockStatus: price ? "in_stock" : "unknown",
    
    // PROVIDER TRUST SCORE
    providerTrust: calculateProviderTrust(rawItem.provider),
    
    // RAW DATA (debug için)
    raw: rawItem.raw || rawItem,
    
    // S10 SCORE (başlangıç değeri)
    score: 0.01
  };
  
  return item;
}

// ======================================================================
// PROVIDER TRUST CALCULATION
// ======================================================================

function calculateProviderTrust(provider) {
  const providerLower = (provider || "").toLowerCase();
  
  const trustScores = {
    'openfoodfacts': 0.92,
    'serpapi': 0.85,
    'trendyol': 0.88,
    'hepsiburada': 0.87,
    'amazon': 0.89,
    'n11': 0.82,
    'ciceksepeti': 0.83,
    'local': 0.75,
    'unknown': 0.70
  };
  
  for (const [key, score] of Object.entries(trustScores)) {
    if (providerLower.includes(key)) return score;
  }
  
  return 0.75;
}

// ======================================================================
// OPTIMIZE PRICE WRAPPER (Ana motor ile uyumlu)
// ======================================================================

function applyOptimizePrice(item) {
  try {
    // Ana motorun optimizePrice fonksiyonunu kullan
    const optimized = optimizePrice(item, {
      provider: item.provider || "barcode",
      region: item.region || "TR",
      category: item.category || "product",
      subCategory: item.productInfo?.isFood ? "food" : "general",
      mode: "ecommerce",
      source: item.raw?.source || "barcode"
    });
    
    // Commission bilgilerini ekle (yoksa)
    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.05;
      optimized.commissionMeta = {
        platformRate: 0.05,
        categoryMultiplier: finalCategoryMultiplier[item.category] || finalCategoryMultiplier["product"] || 1.0,
        providerTier: "standard",
        source: "barcode_adapter"
      };
    }
    
    // Product info'yu optimize edilmiş item'a taşı
    if (item.productInfo && !optimized.productInfo) {
      optimized.productInfo = item.productInfo;
    }
    
    return optimized;
    
  } catch (e) {
    console.warn("Barcode optimize hata:", e?.message);
    return item;
  }
}

// ======================================================================
// SEARCH LOCAL BARCODE PROVIDERS
// ======================================================================

async function searchLocalBarcodeProviders(code, { region, signal }) {
  try {
    const mod = await import("../core/localBarcodeEngine.js").catch(() => null);
    if (!mod || typeof mod.searchLocalBarcodeEngine !== "function") return [];
    const res = await mod.searchLocalBarcodeEngine(code, { region, signal });
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  }
}

// ======================================================================
// MAIN ADAPTER — Ana motor ile uyumlu
// ======================================================================

export async function searchBarcode(query, regionOrOptions = "TR") {
  const startTime = Date.now();
  const requestId = `barcode_${Date.now()}_${__s200_next().toString(36).substr(2, 9)}`;
  
  console.log(`📦 [${requestId}] Barcode adapter başladı: "${query.substring(0, 20)}"`);
  
  try {
    let region = "TR";
    let signal;

    if (typeof regionOrOptions === "string") {
      region = normalizeRegion(regionOrOptions);
    } else if (regionOrOptions && typeof regionOrOptions === "object") {
      region = normalizeRegion(regionOrOptions.region || "TR");
      signal = regionOrOptions.signal;
    }

    const code = String(query || "").trim();

    if (!isValidBarcodeFormat(code)) {
      const duration = Date.now() - startTime;
      
      console.log(`⚠️ [${requestId}] Geçersiz barkod formatı: "${code}"`);
      
      s10_registerAdapterStatus('barcodeAdapter', true, duration);
      
      return {
        ok: true,
        items: [],
        count: 0,
        adapterName: "barcodeAdapter",
        duration,
        metadata: {
          requestId,
          query: code,
          region,
          source: "barcode",
          error: "invalid_barcode_format",
          timestamp: new Date().toISOString()
        }
      };
    }

    const gtinOk = isValidGtinChecksum(code);
    
    let finalList = [];

    // 1) OPENFOODFACTS
    try {
      // (FREE) Barkoddan isim/ görsel çöz (food + beauty + general)
      const offDirect = await lookupOpenFactsByBarcode(code, { signal });
      if (offDirect && offDirect.title) {
        const directUrl = sanitizeUrl(offDirect.url || "") || sanitizeUrl(`https://world.openfoodfacts.org/product/${code}`);
        if (directUrl) {
          finalList.push({
            id: stableIdS200(offDirect.provider || "openfacts", directUrl, offDirect.title),
            title: safe(offDirect.title),
            price: null,
            rating: null,
            url: directUrl,
            imageRaw: offDirect.image || null,
            provider: offDirect.provider || "openfacts",
            region,
            currency: "TRY",
            category: "product",
            barcode: code,
            brand: offDirect.brand || null,
            raw: offDirect.raw || offDirect
          });
        }
      }

      const offRaw = await searchOpenFoodFacts(code, { region, signal });

      if (Array.isArray(offRaw) && offRaw.length > 0) {
        offRaw.forEach((x, i) => {
          const title = safe(x.title || x.product_name || x.product || x.label);
          const imageRaw = x.image || x.image_url || x.front_image || null;
          const urlRaw = x.url || x.link || `https://world.openfoodfacts.org/product/${code}`;

          finalList.push({
            id: x.id || `${code}-off-${i}`,
            title,
            price: x.price ?? null,
            rating: x.nutriscore_grade ? nutriToRating(x.nutriscore_grade) : null,
            url: sanitizeUrl(urlRaw),
            imageRaw,
            provider: "openfoodfacts",
            region,
            currency: x.currency || "TRY",
            category: "product",
            barcode: code,
            brand: x.brand || null,
            weight: x.quantity || null,
            ingredients: x.ingredients_text || null,
            nutritionScore: x.nutriscore_grade || null,
            hasNutritionInfo: !!x.nutriscore_grade,
            raw: x
          });
        });
      }
    } catch (offError) {
      console.warn(`OpenFoodFacts error: ${offError.message}`);
    }

    // 2) LOCAL PROVIDERS
    try {
      const localRaw = await searchLocalBarcodeProviders(code, { region, signal });
      if (Array.isArray(localRaw) && localRaw.length > 0) {
        localRaw.forEach((x, i) => {
          const safeUrl = sanitizeUrl(x.url);
          if (!safeUrl) return;

          finalList.push({
            id: x.id || `${code}-local-${i}`,
            title: safe(x.title),
            price: x.price ?? null,
            rating: x.rating ?? null,
            url: safeUrl,
            imageRaw: x.image || null,
            provider: x.provider || "local",
            region,
            currency: x.currency || "TRY",
            category: x.category || "product",
            barcode: code,
            brand: x.brand || null,
            raw: x
          });
        });
      }
    } catch (localError) {
      console.warn(`Local providers error: ${localError.message}`);
    }
    // 3) SERPAPI
    try {
      // NOTE: searchWithSerpApi() returns an object { ok, items, ... } (array-like but not Array.isArray).
      // Old code never consumed Serp items => barcode resolution often degraded into random/irrelevant matches elsewhere.
      const serpRes1 = await searchWithSerpApi(`ean ${code}`, {
        region,
        signal,
        barcode: true,
        mode: "shopping",
        num: 12,
        intent: { type: "barcode" },
      });

      let serpItems = Array.isArray(serpRes1?.items)
        ? serpRes1.items
        : Array.isArray(serpRes1)
        ? serpRes1
        : [];

      // 2nd try: Turkish marketplaces (best-effort)
      // Not: Local resolver (site içi arama + barcode doğrulama) zaten yukarıda.
      // Buradaki amaç: Serp tarafında da TR marketlerden ek aday yakalamak.
      if (!serpItems.length) {
        const siteTries = [
          `site:trendyol.com ${code}`,
          `site:hepsiburada.com ${code}`,
          `site:n11.com ${code}`,
        ];
        for (const q of siteTries) {
          const serpRes2 = await searchWithSerpApi(q, {
            region,
            signal,
            barcode: true,
            num: 10,
            intent: { type: "barcode" },
          });

          const maybe = Array.isArray(serpRes2?.items)
            ? serpRes2.items
            : Array.isArray(serpRes2)
            ? serpRes2
            : [];
          if (maybe.length) {
            serpItems = maybe;
            break;
          }
        }
      }

      if (Array.isArray(serpItems) && serpItems.length > 0) {
        serpItems.forEach((x, i) => {
          const safeUrl = sanitizeUrl(x.url || x.finalUrl || x.originUrl || x.link);
          if (!safeUrl) return;

          finalList.push({
            id: x.id || x.url || `${code}-serp-${i}`,
            title: safe(x.title),
            price: null, // DISCOVERY SOURCE RULE (NO-FAKE)
            rating: x.rating ?? null,
            url: safeUrl,
            imageRaw: x.image || null,
            provider: "serpapi",
            region,
            currency: x.currency || "TRY",
            category: "product",
            barcode: code,
            raw: x,
          });
        });
      }
    } catch (serpError) {
      console.warn(`SerpAPI error: ${serpError.message}`);
    }

    // Normalize ve optimize et
    const normalizedItems = finalList
      .map(raw => normalizeBarcodeItem(raw, "product", "barcodeAdapter"))
      .map(item => applyOptimizePrice(item))
      .filter(item => item && item.title && item.url)
      .slice(0, 50); // Limit to 50 items

    const duration = Date.now() - startTime;
    
    if (normalizedItems.length > 0) {
      console.log(`✅ [${requestId}] Barcode adapter başarılı: ${normalizedItems.length} ürün, ${duration}ms`);
      
      // S10 adapter statüsünü kaydet
      s10_registerAdapterStatus('barcodeAdapter', true, duration);
      
      // İstatistikler
      const providers = {};
      const categories = {};
      
      for (const item of normalizedItems) {
        const provider = item.provider || 'unknown';
        providers[provider] = (providers[provider] || 0) + 1;
        
        const category = item.category || 'product';
        categories[category] = (categories[category] || 0) + 1;
      }
      
      return {
        ok: true,
        items: normalizedItems,
        count: normalizedItems.length,
        adapterName: "barcodeAdapter",
        duration,
        metadata: {
          requestId,
          query: code,
          region,
          source: "mixed",
          gtinValid: gtinOk,
          providers,
          categories,
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
      console.log(`⚠️ [${requestId}] Barcode adapter sonuç yok → fallback`);
      return await barcodeFallback(code, region, startTime, requestId);
    }
    
  } catch (err) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [Barcode adapter] Hata: ${err.message}`, {
      query: query?.substring(0, 20),
      duration,
      timestamp: new Date().toISOString()
    });
    
    // S10 adapter statüsünü kaydet
    s10_registerAdapterStatus('barcodeAdapter', false, duration);
    
    // Fallback'e geç
    return await barcodeFallback(query, regionOrOptions.region || "TR", startTime, requestId);
  }
}

// ======================================================================
// FALLBACK — Ana motor ile uyumlu
// ======================================================================

async function barcodeFallback(code, region = "TR", startTime = Date.now(), requestId = "barcode_fallback") {
  try {
    const raw = {
      title: `Barkod ${code}`,
      price: null,
      url: `https://world.openfoodfacts.org/product/${code}`,
      imageRaw: null,
      provider: "barcode_fallback",
      region: region,
      barcode: code,
      raw: {
        source: "fallback",
        extractedAt: new Date().toISOString()
      }
    };

    const normalizedItem = normalizeBarcodeItem(raw, "product", "barcodeFallback");
    const optimizedItem = applyOptimizePrice(normalizedItem);
    
    const duration = Date.now() - startTime;
    
    console.log(`⚠️ [${requestId}] Barcode fallback kullanıldı, ${duration}ms`);
    
    s10_registerAdapterStatus('barcodeAdapter', true, duration);
    
    return {
      ok: true,
      items: [optimizedItem],
      count: 1,
      adapterName: "barcodeFallback",
      duration,
      metadata: {
        requestId,
        query: code,
        region,
        source: "fallback",
        timestamp: new Date().toISOString()
      }
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [Barcode fallback] Hata: ${error.message}`);
    
    s10_registerAdapterStatus('barcodeAdapter', false, duration);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      adapterName: "barcodeFallback",
      duration,
      metadata: {
        query: code,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    };
  }
}

// ======================================================================
// WRAPPERS — Legacy support
// ======================================================================

export async function searchBarcodeAdapterLegacy(query, opts = {}) {
  return await searchBarcode(query, opts);
}

// ======================================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// ======================================================================

export const barcodeAdapterConfig = {
  name: "barcode",
  fn: searchBarcode,
  timeoutMs: 12000,
  priority: 1.1,
  category: "product",
  subCategories: ["food", "cosmetics", "cleaning", "health", "electronics", "general"],
  provider: "mixed",
  commissionRate: 0.05,
  vertical: "product",
  regionSupport: ["TR", "EU", "US", "UK", "DE", "FR"],
  metadata: {
    providerType: "product_search",
    hasAffiliate: true,
    hasNutritionInfo: true,
    hasPriceInfo: true,
    hasImageInfo: true,
    trustScore: 0.85,
    dataSource: "mixed",
    freshness: "realtime"
  },
  capabilities: {
    supportsApi: true,
    supportsScraping: false,
    supportsImages: true,
    supportsNutritionInfo: true,
    supportsPricing: true,
    supportsBarcodeValidation: true
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

export async function testBarcodeAdapter() {
  const query = "5901234123457"; // Örnek barkod
  const region = "TR";
  
  console.log("🧪 Barcode adapter test başlıyor...");
  
  try {
    const result = await searchBarcode(query, { region });
    
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
        console.log("🎉 Barcode adapter ana motorla %100 uyumlu!");
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
  searchBarcode,
  searchBarcodeAdapter,
  barcodeAdapterConfig,
  testBarcodeAdapter
};

console.log("📦 BARCODE ADAPTER S200 ULTRA YÜKLENDİ - ANA MOTOR %100 UYUMLU");

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBarcodeAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "barcode";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "barcode",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 12000) || 12000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBarcodeAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "barcode",
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
      if (true) {
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
      source: "barcode",
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
      source: "barcode",
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
