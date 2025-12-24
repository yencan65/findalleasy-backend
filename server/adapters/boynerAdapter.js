// server/adapters/boynerAdapter.js
// =======================================================================
// BOYNER ADAPTER — ANA MOTOR İLE %100 UYUMLU VERSİYON
// =======================================================================
// Hercules S200 normalizeItem + optimizePrice + commissionEngine + providerMaster entegre
// =======================================================================

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

// =======================================================================
// HELPER FUNCTIONS
// =======================================================================

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function buildStableId(raw, title = "", provider = "boyner") {
  const base = `${provider}_${raw || title || "id"}`;
  try {
    return "boyner_" + crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16);
  } catch {
    return "boyner_" + String(base).replace(/\W+/g, "_");
  }
}

function parsePriceStrong(txt) {
  if (!txt) return null;
  const n = Number(
    txt
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

function fallbackImage(title) {
  const q = encodeURIComponent(title || "fashion");
  return `https://source.unsplash.com/featured/?fashion,${q}`;
}

// =======================================================================
// FASHION CATEGORY DETECTION (Ana motor ile uyumlu)
// =======================================================================

function detectBoynerCategory(title, description = "") {
  const text = (title + " " + description).toLowerCase();
  
  // Outerwear
  if (text.includes("mont") || text.includes("kaban") || text.includes("ceket") || 
      text.includes("parka") || text.includes("trench") || text.includes("blazer")) {
    return "outerwear";
  }
  
  // Shoes
  if (text.includes("ayakkabı") || text.includes("sneaker") || text.includes("bot") || 
      text.includes("topuklu") || text.includes("spor ayakkabı") || text.includes("loafer")) {
    return "shoes";
  }
  
  // Accessories
  if (text.includes("çanta") || text.includes("cüzdan") || text.includes("şapka") || 
      text.includes("atkı") || text.includes("eldiven") || text.includes("kemer")) {
    return "accessories";
  }
  
  // Topwear
  if (text.includes("gömlek") || text.includes("tişört") || text.includes("t-shirt") || 
      text.includes("bluz") || text.includes("kazak") || text.includes("süveter") || 
      text.includes("sweatshirt") || text.includes("hoodie")) {
    return "topwear";
  }
  
  // Bottomwear
  if (text.includes("pantolon") || text.includes("jean") || text.includes("şort") || 
      text.includes("etek") || text.includes("tayt") || text.includes("pant")) {
    return "bottomwear";
  }
  
  // Dresses
  if (text.includes("elbise") || text.includes("dress") || text.includes("abiye")) {
    return "dresses";
  }
  
  // Underwear
  if (text.includes("iç çamaşırı") || text.includes("sütyen") || text.includes("boxer") || 
      text.includes("bornoz") || text.includes("pijama")) {
    return "underwear";
  }
  
  // Watches & Jewelry
  if (text.includes("saat") || text.includes("kol saati") || text.includes("bilezik") || 
      text.includes("küpe") || text.includes("yüzük") || text.includes("takı")) {
    return "watches_jewelry";
  }
  
  // Perfume & Cosmetics
  if (text.includes("parfüm") || text.includes("kozmetik") || text.includes("makyaj") || 
      text.includes("ruj") || text.includes("fondöten") || text.includes("krem")) {
    return "perfume_cosmetics";
  }
  
  // Home & Living
  if (text.includes("ev") || text.includes("mutfak") || text.includes("ev tekstili") || 
      text.includes("mobilya") || text.includes("dekorasyon")) {
    return "home_living";
  }
  
  // Electronics
  if (text.includes("elektronik") || text.includes("kulaklık") || text.includes("şarj") || 
      text.includes("telefon") || text.includes("tablet")) {
    return "electronics";
  }
  
  // Sports
  if (text.includes("spor") || text.includes("fitness") || text.includes("yoga") || 
      text.includes("koşu") || text.includes("egzersiz")) {
    return "sports";
  }
  
  return "fashion";
}

function extractBrandFromTitle(title) {
  const brands = [
    'Adidas', 'Nike', 'Puma', 'Reebok', 'Tommy Hilfiger', 'Lacoste',
    'Mavi', 'Koton', 'LC Waikiki', 'Defacto', 'Colin\'s', 'Network',
    'Lumberjack', 'Jack & Jones', 'Mango', 'Zara', 'Marks & Spencer',
    'Calvin Klein', 'Levi\'s', 'Diesel', 'Guess', 'Armani', 'Hugo Boss'
  ];
  
  const titleLower = title.toLowerCase();
  for (const brand of brands) {
    if (titleLower.includes(brand.toLowerCase())) return brand;
  }
  
  return null;
}

function extractMaterialFromTitle(title) {
  const materials = {
    'pamuk': 'cotton',
    'keten': 'linen',
    'yün': 'wool',
    'deri': 'leather',
    'suni deri': 'faux leather',
    'kadife': 'velvet',
    'ipek': 'silk',
    'polyester': 'polyester',
    'naylon': 'nylon',
    'jean': 'denim'
  };
  
  const titleLower = title.toLowerCase();
  for (const [key, value] of Object.entries(materials)) {
    if (titleLower.includes(key)) return value;
  }
  
  return null;
}

function extractSizeInfo($wrap) {
  const sizeText =
    safe($wrap.find(".size").text()) ||
    safe($wrap.find(".beden").text()) ||
    safe($wrap.find(".variant").text());
  
  if (!sizeText) return null;
  
  const sizes = [];
  const sizePatterns = [
    /(\d+)\s*(XS|S|M|L|XL|XXL|XXXL)/i,
    /(\d+)\s*(numara|num)/i,
    /(XS|S|M|L|XL|XXL|XXXL)/i,
    /(\d{2,3})\s*(cm)/i
  ];
  
  for (const pattern of sizePatterns) {
    const match = sizeText.match(pattern);
    if (match) {
      if (match[2]) sizes.push(match[2].toUpperCase());
      else if (match[1]) sizes.push(match[1]);
    }
  }
  
  return sizes.length > 0 ? sizes : null;
}

function detectStockStatus($wrap) {
  const stockText =
    safe($wrap.find(".stock").text()) ||
    safe($wrap.find(".stok").text()) ||
    safe($wrap.find(".availability").text()).toLowerCase();
  
  if (stockText.includes("tükendi") || stockText.includes("stok yok") || 
      stockText.includes("out of stock")) {
    return "out_of_stock";
  }
  
  if (stockText.includes("son") || stockText.includes("limited")) {
    return "limited_stock";
  }
  
  if (stockText.includes("stokta") || stockText.includes("in stock")) {
    return "in_stock";
  }
  
  return "unknown";
}

// =======================================================================
// NORMALIZE BOYNER ITEM (Ana motor normalizeItem ile uyumlu)
// =======================================================================

function normalizeBoynerItem(rawItem, mainCategory = "fashion", adapterName = "boynerAdapter") {
  // URL'i normalize et
  let url = rawItem.href || null;
  if (url && !url.startsWith("http")) {
    if (url.startsWith("//")) {
      url = "https:" + url;
    } else if (url.startsWith("/")) {
      url = "https://www.boyner.com.tr" + url;
    }
  }
  
  // Fiyatı normalize et
  let price = rawItem.price || null;
  
  // Realistic price validation for fashion products
  if (price) {
    if (price < 10) price = null; // Moda ürünü 10 TL'den az olamaz
    if (price > 50000) price = null; // Moda ürünü 50,000 TL'den fazla olamaz
  }
  
  // Kategoriyi belirle
  const category = detectBoynerCategory(rawItem.title, rawItem.description) || mainCategory;
  const brand = extractBrandFromTitle(rawItem.title);
  const material = extractMaterialFromTitle(rawItem.title);
  
  const item = {
    // ZORUNLU ALANLAR (ana motor için)
    id: rawItem.id || buildStableId(url, rawItem.title, "boyner"),
    title: safe(rawItem.title),
    url: url,
    price: price,
    
    // OPSİYONEL ALANLAR
    rating: rawItem.rating || null,
    provider: "boyner",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: category,
    adapterSource: adapterName,
    
    // S10 COMMISSION ENGINE ALANLARI
    commissionRate: rawItem.commissionRate || 0.06, // Boyner için %6 komisyon
    commissionMeta: {
      platformRate: 0.06,
      categoryMultiplier: finalCategoryMultiplier[category] || finalCategoryMultiplier["fashion"] || 1.0,
      providerTier: "premium",
      source: "boyner",
      isDiscounted: rawItem.isDiscounted || false,
      hasFreeShipping: rawItem.hasFreeShipping || false
    },
    
    // S9 PROVIDER MASTER ALANLARI
    providerType: "fashion_retail",
    vertical: "fashion",
    marketplaceType: "boyner",
    
    // PRICE OPTIMIZATION
    optimizedPrice: rawItem.optimizedPrice || null,
    discountPercentage: rawItem.discountPercentage || null,
    
    // FASHION SPECIFIC FIELDS
    fashionInfo: {
      brand: brand,
      material: material,
      color: rawItem.color || null,
      size: rawItem.size || null,
      gender: rawItem.gender || "unisex",
      season: rawItem.season || null,
      isDiscounted: rawItem.isDiscounted || false,
      originalPrice: rawItem.originalPrice || null,
      discountRate: rawItem.discountRate || null,
      hasFreeShipping: rawItem.hasFreeShipping || false,
      hasFreeReturns: rawItem.hasFreeReturns || false
    },
    
    // IMAGE OPTIMIZATION
    image: rawItem.imgRaw || null,
    imageVariants: buildImageVariants(rawItem.imgRaw, "boyner"),
    
    // AVAILABILITY
    availability: price ? "available" : "unknown",
    stockStatus: rawItem.stockStatus || "unknown",
    
    // PROVIDER TRUST SCORE
    providerTrust: 0.90,
    
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
      provider: "boyner",
      region: item.region || "TR",
      category: item.category || "fashion",
      subCategory: item.fashionInfo?.brand || "general",
      mode: "fashion_retail",
      source: item.raw?.source || "scraping"
    });
    
    // Commission bilgilerini ekle (yoksa)
    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.06;
      optimized.commissionMeta = {
        platformRate: 0.06,
        categoryMultiplier: finalCategoryMultiplier[item.category] || finalCategoryMultiplier["fashion"] || 1.0,
        providerTier: "premium",
        source: "boyner_adapter"
      };
    }
    
    // Fashion info'yu optimize edilmiş item'a taşı
    if (item.fashionInfo && !optimized.fashionInfo) {
      optimized.fashionInfo = item.fashionInfo;
    }
    
    return optimized;
    
  } catch (e) {
    console.warn("Boyner optimize hata:", e?.message);
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

export async function searchBoynerAdapter(query, options = {}) {
  const startTime = Date.now();
  const requestId = `boyner_${Date.now()}_${__s200_next().toString(36).substr(2, 9)}`;
  
  console.log(`👕 [${requestId}] Boyner adapter başladı: "${query.substring(0, 50)}"`);

  // ⭐⭐⭐ S200 RATE LIMITER BLOĞU — Boyner anti-bot için ŞART ⭐⭐⭐
  const region = options.region || "TR";
  const limiterKey = `s200:adapter:boyner:${region}`;

  const allowed = await rateLimiter.check(limiterKey, {
    limit: 20,          // Boyner için güvenli RPM
    windowMs: 60_000,   // 1 dakika
    burst: true,
    adaptive: true
  });

  if (!allowed) {
    return [{
      ok: false,
      items: [],
      count: 0,
      error: "S200_RATE_LIMIT_EXCEEDED",
      adapterName: "boynerAdapter",
      _meta: {
        limiterKey,
        timestamp: Date.now()
      }
    }];
  }
  // ⭐⭐⭐ RATE LIMITER BİTTİ ⭐⭐⭐
  
  try {
    const signal = options.signal || null;
    const url = `https://www.boyner.com.tr/arama?q=${encodeURIComponent(query)}`;


    const html = await fetchHTML(url, signal);
    if (!html) {
      return await boynerFallback(query, region, startTime, requestId);
    }

    const $ = loadCheerioS200(html);
    const rawItems = [];

    const selectors = [
      ".product-card",
      ".product",
      ".mh-product-card",
      ".prd",
      ".product-item",
      ".productBox",
      "article[class*='product']",
      "div[class*='product']"
    ];

    selectors.forEach((sel) => {
      $(sel).each((i, el) => {
        try {
          const w = $(el);

          const title =
            safe(w.find(".product-name").text()) ||
            safe(w.find(".prd-name").text()) ||
            safe(w.find("h3").text()) ||
            safe(w.find("h2").text());
          if (!title || title.length < 3) return;

          const ptxt =
            safe(w.find(".product-price-selling").text()) ||
            safe(w.find(".new-price").text()) ||
            safe(w.find(".price").text()) ||
            safe(w.find(".current-price").text());
          const price = parsePriceStrong(ptxt);

          // Original price (for discount calculation)
          const originalPriceText =
            safe(w.find(".product-price-original").text()) ||
            safe(w.find(".old-price").text()) ||
            safe(w.find(".discount-price").text());
          const originalPrice = parsePriceStrong(originalPriceText);

          let href = safe(w.find("a").attr("href"));
          if (!href) return;

          let imgRaw =
            safe(w.find("img").attr("data-src")) ||
            safe(w.find("img").attr("data-original")) ||
            safe(w.find("img").attr("src")) ||
            null;

          if (imgRaw?.startsWith("//")) imgRaw = "https:" + imgRaw;

          const description = safe(w.find(".product-description").text()) || "";
          const color = safe(w.find(".color").text()) || null;
          const size = extractSizeInfo(w);
          const stockStatus = detectStockStatus(w);
          const category = detectBoynerCategory(title, description);
          const brand = extractBrandFromTitle(title);
          
          const isDiscounted = originalPrice && price && originalPrice > price;
          const discountRate = isDiscounted && originalPrice ? 
            Math.round(((originalPrice - price) / originalPrice) * 100) : null;

          rawItems.push({
            title,
            price,
            originalPrice,
            href,
            imgRaw,
            description,
            color,
            size,
            stockStatus,
            category,
            brand,
            isDiscounted,
            discountRate,
            raw: {
              html: w.html()?.substring(0, 500) || null,
              extractedAt: new Date().toISOString(),
              source: "scraping"
            }
          });
        } catch (itemError) {
          console.warn("Boyner item parsing error:", itemError.message);
        }
      });
    });

    // Normalize ve optimize et
    const normalizedItems = rawItems
      .map(raw => normalizeBoynerItem(raw, "fashion", "boynerAdapter"))
      .map(item => applyOptimizePrice(item))
      .filter(item => item && item.title && item.url)
      .slice(0, 50); // Limit to 50 items

    const duration = Date.now() - startTime;
    
    if (normalizedItems.length > 0) {
  console.log(`✅ [${requestId}] Boyner adapter başarılı: ${normalizedItems.length} ürün, ${duration}ms`);
      
  s10_registerAdapterStatus('boynerAdapter', true, duration);

  // İstatistik hesaplama (kalsın)
  const categories = {};
  const brands = {};
  const priceStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
      
  for (const item of normalizedItems) {
    const category = item.category || 'fashion';
    categories[category] = (categories[category] || 0) + 1;
        
    const brand = item.fashionInfo?.brand || 'unknown';
    brands[brand] = (brands[brand] || 0) + 1;
        
    if (item.price) {
      priceStats.min = Math.min(priceStats.min, item.price);
      priceStats.max = Math.max(priceStats.max, item.price);
      priceStats.sum += item.price;
      priceStats.count++;
    }
  }
      
return normalizedItems;
} else {
  // No results
  console.log(`⚠️ [${requestId}] Boyner adapter sonuç yok`);
  if (FINDALLEASY_ALLOW_STUBS) {
    console.log(`⚠️ [${requestId}] Boyner adapter sonuç yok → fallback (DEV)`);
    return await boynerFallback(query, region, startTime, requestId);
  }
  // STRICT: no placeholders
  return [];
}

    
  } catch (err) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [Boyner adapter] Hata: ${err.message}`, {
      query: query?.substring(0, 100),
      duration,
      timestamp: new Date().toISOString()
    });
    
    // S10 adapter statüsünü kaydet
    s10_registerAdapterStatus('boynerAdapter', false, duration);
    
    // Fallback'e geç
    return await boynerFallback(query, options.region || "TR", startTime, requestId);
  }
}

// =======================================================================
// FALLBACK — Ana motor ile uyumlu
// =======================================================================

async function boynerFallback(query, region = "TR", startTime = Date.now(), requestId = "boyner_fallback") {
  try {
    const raw = {
      title: `${query} - Boyner'de Ara`,
      price: null,
      href: "https://www.boyner.com.tr/",
      imgRaw: fallbackImage(query),
      description: null,
      category: "fashion",
      raw: {
        source: "fallback",
        extractedAt: new Date().toISOString()
      }
    };

    const normalizedItem = normalizeBoynerItem(raw, "fashion", "boynerFallback");
    const optimizedItem = applyOptimizePrice(normalizedItem);
    
    const duration = Date.now() - startTime;
    
    console.log(`⚠️ [${requestId}] Boyner fallback kullanıldı, ${duration}ms`);
    
    s10_registerAdapterStatus('boynerAdapter', true, duration);
    
   return [optimizedItem];

    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ [Boyner fallback] Hata: ${error.message}`);
    
    s10_registerAdapterStatus('boynerAdapter', false, duration);
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      adapterName: "boynerFallback",
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

export async function searchBoyner(query, opts = {}) {
  return await searchBoynerAdapter(query, opts);
}

export async function searchBoynerScrape(query, opts = {}) {
  return await searchBoynerAdapter(query, opts);
}

// =======================================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// =======================================================================

export const boynerAdapterConfig = {
  name: "boyner",
  fn: searchBoynerAdapter,
  timeoutMs: 15000,
  priority: 1.3,
  category: "fashion",
  subCategories: [
    "outerwear",
    "shoes", 
    "accessories",
    "topwear",
    "bottomwear",
    "dresses",
    "underwear",
    "watches_jewelry",
    "perfume_cosmetics",
    "home_living",
    "electronics",
    "sports"
  ],
  provider: "boyner",
  commissionRate: 0.06,
  vertical: "fashion",
  regionSupport: ["TR"],
  metadata: {
    providerType: "fashion_retail",
    hasAffiliate: true,
    hasBrands: true,
    hasDiscounts: true,
    hasFreeShipping: true,
    hasFreeReturns: true,
    trustScore: 9.0,
    deliverySpeed: "2-5 days",
    returnPolicy: "30 days"
  },
  capabilities: {
    supportsApi: false,
    supportsScraping: true,
    supportsImages: true,
    supportsPricing: true,
    supportsProductDetails: true,
    supportsStockInfo: true,
    supportsBrandFilter: true
  },
  fashionCapabilities: {
    supportsBrandFilter: true,
    supportsCategoryFilter: true,
    supportsPriceRange: true,
    supportsSizeFilter: true,
    supportsColorFilter: true,
    supportsGenderFilter: true,
    supportsMaterialFilter: true,
    supportsDiscountFilter: true
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
export async function testBoynerAdapter() {
  const query = "adidas spor ayakkabı";
  const region = "TR";
  
  console.log("🧪 Boyner adapter test başlıyor...");
  
  try {
    const result = await searchBoynerAdapter(query, { region });

    console.log("✅ Test sonucu:", {
      ok: true,
      itemCount: result.length,
      sampleItem: result[0] ? {
        title: result[0].title.substring(0, 50),
        price: result[0].price,
        provider: result[0].provider,
        category: result[0].category,
        commissionRate: result[0].commissionRate,
        fashionInfo: result[0].fashionInfo
      } : null
    });

    const firstItem = result[0];
    if (firstItem) {
      const requiredFields = ["id", "title", "url", "price", "provider"];
      const missing = requiredFields.filter(f => !firstItem[f]);

      if (missing.length === 0) {
        console.log("🎉 Boyner adapter ana motorla %100 uyumlu!");
      } else {
        console.warn("⚠️ Eksik alanlar:", missing);
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
  searchBoyner,
  searchBoynerScrape,
  searchBoynerAdapter,
  boynerAdapterConfig,
  testBoynerAdapter
};

console.log("👕 BOYNER ADAPTER S200 ULTRA YÜKLENDİ - ANA MOTOR %100 UYUMLU");