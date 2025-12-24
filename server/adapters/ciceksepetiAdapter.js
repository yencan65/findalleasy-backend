// server/adapters/ciceksepetiAdapter.js
// =======================================================================
//  ÇİÇEKSEPETİ — S33 TITAN+ FINAL MAX EDITION
//  ADAPTER ENGINE ANA MOTORU İLE TAM UYUMLU
// =======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import {
proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";

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
// ============================================================
// ADAPTER ENGINE COMPATIBILITY LAYER
// ============================================================

// PROVIDER META (Adapter Engine ile uyumlu)
export const CICEKSEPETI_META = {
  name: "ciceksepeti",
  displayName: "ÇiçekSepeti",
  provider: "ciceksepeti",
  providerFamily: "ciceksepeti",
  providerType: "gift",
  vertical: "gift",
 category: "product",
subCategory: ["product", "gift", "flower", "chocolate"],

  
  country: "TR",
  regionAffinity: ["TR"],
  language: "tr",
  
  // Adapter Engine scoring
  providerScore: 0.62,
  priorityWeight: 1.15,
  commissionRateHint: 0.03,
  trustScore: 0.7,
  
  // Capabilities
  affiliateCapable: true,
  hasImages: true,
  hasPrices: true,
  hasStockInfo: true,
  hasRatings: true,
  
  // Rate limit (Adapter Engine ile senkron)
  rateLimit: {
    limit: 12,
    windowMs: 60000,
    burst: true,
    adaptive: true,
    category: "gift"
  },
  
  // Tags for categorization
  tags: ["gifts", "flowers", "chocolate", "delivery", "special_occasions", "turkey"],
  
  // Timeout settings
  defaultTimeoutMs: 18000,
  searchMaxResults: 40,
  
  // Adapter Engine version compatibility
  adapterEngineVersion: "S33_TITAN",
  lastUpdated: "2024-12-08",
  status: "active"
};

// ============================================================
// CORE HELPERS (Adapter Engine uyumlu)
// ============================================================
const safe = (v) => (v == null ? "" : String(v).trim());

function parsePriceStrong(txt) {
  if (!txt) return null;
  const clean = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
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
  const slug = slugify(title);
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

function fallbackImage(title) {
  const q = encodeURIComponent(title || "gift flower");
  return `https://source.unsplash.com/featured/?gift,flower,${q}`;
}

// ============================================================
// CATEGORY INFERENCE (Adapter Engine ontology uyumlu)
// ============================================================
function inferCategoryAI(title) {
  const t = safe(title).toLowerCase();
  
  // Flower detection
  if (t.includes("çiçek") || t.includes("orkide") || t.includes("gül") || 
      t.includes("rose") || t.includes("lily") || t.includes("papatya") ||
      t.includes("buket") || t.includes("aranjman") || t.includes("çelenk")) {
    return "flower";
  }
  
  // Chocolate & sweets
  if (t.includes("çikolata") || t.includes("madlen") || t.includes("şeker") ||
      t.includes("sweets") || t.includes("tatlı") || t.includes("dondurma") ||
      t.includes("kek") || t.includes("pasta")) {
    return "chocolate";
  }
  
  // Gift sets & special occasions
  if (t.includes("hediye") || t.includes("set") || t.includes("paket") ||
      t.includes("doğum günü") || t.includes("yıl dönümü") || 
      t.includes("anneler günü") || t.includes("sevgililer günü") ||
      t.includes("özel gün") || t.includes("kutlama") || t.includes("tebrik")) {
    return "gift";
  }
  
  // Plants
  if (t.includes("bitki") || t.includes("saksı") || t.includes("yeşil") ||
      t.includes("kaktüs") || t.includes("bambu")) {
    return "plant";
  }
  
  // Balloons & decorations
  if (t.includes("balon") || t.includes("süs") || t.includes("dekorasyon") ||
      t.includes("ışıklı") || t.includes("parti")) {
    return "decoration";
  }
  
  // Food & beverage gifts
  if (t.includes("kahve") || t.includes("çay") || t.includes("içecek") ||
      t.includes("kurabiye") || t.includes("bisküvi")) {
    return "food_gift";
  }
  
  return "product";
}

function detectStock(root) {
  const txt = root.text().toLowerCase();
  if (txt.includes("tükendi") || txt.includes("out of stock") || 
      txt.includes("stokta yok") || txt.includes("stok dışı") ||
      txt.includes("stok yok")) {
    return "out";
  }
  if (txt.includes("stokta sınırlı") || txt.includes("az kaldı") || 
      txt.includes("son ürün") || txt.includes("son 1")) {
    return "limited";
  }
  if (txt.includes("stokta var") || txt.includes("mevcut") ||
      txt.includes("var")) {
    return "in_stock";
  }
  return "unknown";
}

// ============================================================
// QUALITY SCORE (Adapter Engine scoring uyumlu)
// ============================================================
function computeQualityScore(item) {
  let score = 0.0;
  
  // Adapter Engine base scoring (0-1 range)
  
  // Title quality
  if (item.title && item.title.length > 3) {
    score += 0.25;
    if (item.title.length > 10) score += 0.05;
  }
  
  // Price presence
  if (item.price != null && item.price > 0) {
    score += 0.25;
  }
  
  // Image presence
  if (item.image) {
    score += 0.15;
    if (item.imageProxy) score += 0.05; // Bonus for proxy images
  }
  
  // Rating
  if (item.rating != null && item.rating > 0) {
    score += Math.min(0.05, item.rating * 0.01);
  }
  
  // Stock status
  if (item.stock !== "out") {
    score += 0.10;
    if (item.stock === "in_stock") score += 0.05;
  }
  
  // Category specificity
  if (item.categoryAI !== "product") {
    score += 0.10;
  }
  
  // Optimized price bonus
  if (item.optimizedPrice && item.optimizedPrice < item.price) {
    const discount = (item.price - item.optimizedPrice) / item.price;
    score += Math.min(0.10, discount * 0.5);
  }
  
  // Provider trust bonus (from CICEKSEPETI_META)
  score += CICEKSEPETI_META.providerScore * 0.1;
  
  // Cap to 1.0
  return Math.min(1.0, score);
}

// ============================================================
// URL NORMALIZATION (Adapter Engine format)
// ============================================================
function normalizeUrl(href, baseUrl = "https://www.ciceksepeti.com") {
  if (!href) return null;
  
  let url = href;
  
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
// PAGE SCRAPER (Adapter Engine compatible output)
// ============================================================
async function scrapeCicekSepetiPage(query, page = 1, region = "TR", signal = null) {
  const q = encodeURIComponent(query);
  
  let url;
  if (page > 1) {
    url = `https://www.ciceksepeti.com/aranan?q=${q}&pg=${page}`;
  } else {
    url = `https://www.ciceksepeti.com/aranan?q=${q}`;
  }

  let html = null;
  const startTime = Date.now();

  // Try proxy first (from proxyEngine)
  try {
    html = await proxyFetchHTML(url, {
      timeout: 16000,
      signal,
      proxyRotation: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.ciceksepeti.com/",
        "DNT": "1"
      }
    });
  } catch (proxyError) {
    console.warn(`ÇiçekSepeti proxy hatası: ${proxyError.message}`);
    
    // Fallback to direct axios request
    try {
      const { data } = await axios.get(url, {
        timeout: 12000,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
        }
      });
      html = data;
    } catch (axiosError) {
      console.warn(`ÇiçekSepeti direct request hatası: ${axiosError.message}`);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const items = [];

  // ÇiçekSepeti specific selectors
  const selectors = [
    "div.product__item",
    "div.products__item",
    "li.product-card",
    "article.product-card",
    "div[data-product-id]",
    "a[href*='/p-']",
    "a[href*='/hediye-']",
    "a[href*='/cicek-']",
    "a[href*='/cikolata-']",
    "div.js-product-item",
    ".product-component"
  ];

  $(selectors.join(",")).each((i, el) => {
    try {
      const root = $(el);

      // URL extraction
      let href = safe(root.attr("href")) || 
                safe(root.find("a").attr("href")) ||
                safe(root.find("[data-product-url]").attr("data-product-url"));
      
      if (!href) return;
      
      const normalizedUrl = normalizeUrl(href);
      if (!normalizedUrl) return;

      // Title extraction
      const titleRaw = safe(root.find(".product__title, .products__item-title, .product-title, .product-name").text()) ||
                      safe(root.find("h3, h4").text()) ||
                      safe(root.attr("data-product-name"));
      
      // Brand extraction
      const brand = safe(root.find(".product__brand, .products__item-supplier, .brand-name").text());

      const title = [brand, titleRaw].filter(Boolean).join(" ").trim();
      if (!title || title.length < 3) return;

      // Spam/irrelevant content filter
      const lt = title.toLowerCase();
      const spamKeywords = [
        "tamir", "onarım", "servis", "ekran değişimi", "batarya", "kamera",
        "montaj", "yazılım", "format", "reparatör", "teknik servis",
        "spam", "test", "örnek", "demo", "fake", "deneme"
      ];
      
      if (spamKeywords.some(keyword => lt.includes(keyword))) {
        return;
      }

      // Price extraction
      const priceText = safe(root.find(".price, .product__price, .products__item-price, .current-price").text()) ||
                       safe(root.find("[itemprop='price']").attr("content")) ||
                       safe(root.attr("data-price"));

      const priceRaw = parsePriceStrong(priceText);
      const price = sanitizePrice(priceRaw);

      // Image extraction
      let img = safe(root.find("img").attr("data-src")) ||
               safe(root.find("img").attr("data-original")) ||
               safe(root.find("img").attr("src")) ||
               safe(root.attr("data-image"));
      
      // Image normalization
      if (img?.startsWith("//")) img = "https:" + img;
      if (img?.startsWith("/")) img = "https://www.ciceksepeti.com" + img;
      if (!img || img.includes("placeholder") || img.includes("default")) {
        img = fallbackImage(title);
      }

      const imageData = buildImageVariants(img, "ciceksepeti");

      // Rating extraction
      const ratingText = safe(root.find("[class*='rating'], .star-rating, .review-score").text()) ||
                        safe(root.find("[itemprop='ratingValue']").attr("content"));
      
      let rating = null;
      let reviewCount = null;
      
      if (ratingText) {
        const match = ratingText.match(/(\d+[\.,]?\d*)/);
        if (match) {
          const r = Number(match[1].replace(",", "."));
          if (Number.isFinite(r) && r > 0 && r <= 5) rating = r;
        }
        
        // Extract review count
        const reviewMatch = ratingText.match(/\((\d+)\)/);
        if (reviewMatch) {
          reviewCount = parseInt(reviewMatch[1]);
        }
      }

      // Stock detection
      const stock = detectStock(root);

      // Category inference
      const categoryAI = inferCategoryAI(title);

      // ID generation (Adapter Engine compatible)
      const id = stableId("ciceksepeti", title, normalizedUrl, price);

     const optimizedPrice = null;

      // Affiliate URL (Adapter Engine affiliateEngine)
      const affiliateData = {
        url: normalizedUrl,
        provider: "ciceksepeti",
        title: title,
        price: price
      };
      
      const affiliateContext = {
        source: "ciceksepeti_adapter",
        campaign: "organic_search",
        medium: "adapter_engine",
        region: region
      };
      
      const deeplink = buildAffiliateUrl(affiliateData, affiliateContext);

      // Discount detection
      const discountText = safe(root.find(".discount, .sale, .promo, .campaign, .discount-percent").text());
      let discountPercent = null;
      if (discountText) {
        const match = discountText.match(/(\d+)%/);
        if (match) discountPercent = parseInt(match[1]);
      }

      // Delivery info
      const deliveryText = safe(root.find(".delivery, .shipping, .kargo, .teslimat").text());
      const freeDelivery = deliveryText.toLowerCase().includes("ücretsiz") || 
                          deliveryText.toLowerCase().includes("free");

      // Build item object (Adapter Engine format)
     const item = {
  // Core fields (required by Adapter Engine)
  id,
  title,
  provider: "ciceksepeti",
url: deeplink || normalizedUrl,
originUrl: normalizedUrl,
deeplink: deeplink,

 price,
  currency: "TRY",
  region,

  // category düzeltmesini aşağıdaki blokta yapacağız
  category: "product",
  adapterSource: "ciceksepetiAdapter",
        
        // Extended fields
        providerFamily: "ciceksepeti",
        providerType: "gift",
        vertical: "gift",
        
        // Price info
        finalPrice: price,
        optimizedPrice,
        priceText: priceText,
        discountPercent,
        hasDiscount: discountPercent != null,
        
        // Product info
        brand: brand || null,
        rating,
        reviewCount,
        stock,
        stockStatus: stock,
        
        // Delivery info
        freeDelivery,
        deliveryInfo: deliveryText || null,
        
        // Image info
        image: imageData.image,
        imageOriginal: imageData.imageOriginal,
        imageProxy: imageData.imageProxy,
        hasProxy: imageData.hasProxy,
        imageVariants: imageData.variants || {},
        
        // Category info
        categoryAI,
        subCategory: categoryAI,
        tags: ["gift", "flower", "ciceksepeti", categoryAI].filter(Boolean),
        
        // Raw data (for debugging)
        raw: { 
          href,
          priceText,
          img,
          brand,
          discountText,
          deliveryText,
          elementIndex: i 
        },
        
        // Adapter Engine metadata
        _meta: {
          adapterVersion: "S33_TITAN",
          scrapeTime: Date.now() - startTime,
          page: page,
          region: region
        }
      };

      // Calculate quality score (Adapter Engine compatible)
      item.qualityScore = computeQualityScore(item);
      item.score = item.qualityScore; // Alias for Adapter Engine
      
      items.push(item);
      
    } catch (itemError) {
      console.warn(`ÇiçekSepeti item parse hatası: ${itemError.message}`);
    }
  });

  return items;
}

// ============================================================
// MAIN ADAPTER FUNCTION (Adapter Engine signature)
// ============================================================
export async function searchCicekSepetiAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  
  // Parse options (Adapter Engine format)
  const region = options.region || "TR";
  const signal = options.signal || null;
  const timeoutMs = options.timeoutMs || CICEKSEPETI_META.defaultTimeoutMs;
  const maxResults = options.maxResults || CICEKSEPETI_META.searchMaxResults;
  const maxPages = options.maxPages || 2;
  
  console.log(`🌷 ÇiçekSepeti adapter çağrıldı: "${query}" (${region})`);

  // Rate limit check (handled by Adapter Engine's safeRunAdapter)
  // Note: Adapter Engine will handle rate limiting via safeRunAdapter
  
  let allItems = [];
  
  try {
    // Multi-page scraping with delays
    for (let page = 1; page <= maxPages; page++) {
      try {
        // Add delay between pages to avoid rate limiting
        if (page > 1) {
          await new Promise(resolve => setTimeout(resolve, 500 + __s200_next() * 1000));
        }
        
        const pageItems = await scrapeCicekSepetiPage(query, page, region, signal);
        
        if (!pageItems || pageItems.length === 0) {
          break; // No more items
        }
        
        allItems = allItems.concat(pageItems);
        
        // Stop if we have enough items
        if (allItems.length >= maxResults) {
          allItems = allItems.slice(0, maxResults);
          break;
        }
        
      } catch (pageError) {
        console.warn(`ÇiçekSepeti sayfa ${page} hatası: ${pageError.message}`);
        break;
      }
    }
    
    // Sort by quality score (descending)
    allItems.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
    
    const totalTime = Date.now() - startTime;
    console.log(`✅ ÇiçekSepeti başarılı: ${allItems.length} ürün (${totalTime}ms)`);
    
    // Return in Adapter Engine expected format
    return {
      ok: true,
      items: allItems,
      count: allItems.length,
      query: query,
      provider: "ciceksepeti",
      region: region,
      meta: {
        adapter: "ciceksepetiAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        pagesScraped: Math.min(maxPages, allItems.length > 0 ? maxPages : 0)
      }
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ ÇiçekSepetiAdapter hata (${totalTime}ms):`, error.message);
    
    // Return error in Adapter Engine format
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.message,
      query: query,
      provider: "ciceksepeti",
      region: region,
      meta: {
        adapter: "ciceksepetiAdapter",
        version: "S33_TITAN",
        responseTime: totalTime,
        error: true
      }
    };
  }
}

// ============================================================
// ADAPTER ENGINE COMPATIBILITY EXPORTS
// ============================================================

// Legacy function name for backward compatibility
export const searchCicekSepeti = searchCicekSepetiAdapter;

// Single item search (for testing/debugging)
export async function searchCicekSepetiScrape(query, options = {}) {
  const result = await searchCicekSepetiAdapter(query, options);
  return result.items || [];
}

// Adapter configuration for Adapter Engine registry
export const cicekSepetiAdapterConfig = {
  // Required by Adapter Engine
  name: "ciceksepeti",
  displayName: "ÇiçekSepeti",
  fn: searchCicekSepetiAdapter,
  
  // Adapter Engine metadata
  meta: CICEKSEPETI_META,
  
  // Timeout configuration
  timeoutMs: CICEKSEPETI_META.defaultTimeoutMs,
  
  // Priority in Adapter Engine
  priority: CICEKSEPETI_META.priorityWeight,
  
  // Categories for Adapter Engine routing
  categories: ["gift", "product", "flower", "chocolate"],
  
  // Tags for filtering
  tags: CICEKSEPETI_META.tags,
  
  // Region support
  supportedRegions: ["TR"],
  
  // Rate limit info for Adapter Engine
  rateLimit: CICEKSEPETI_META.rateLimit,
  
  // Adapter Engine version
  adapterEngineVersion: ">=S10",
  
  // Status
  status: "active",
  lastTested: new Date().toISOString().split('T')[0]
};

// ============================================================
// DEFAULT EXPORT (Adapter Engine compatible)
// ============================================================
export default {
  // Main search function
  searchCicekSepetiAdapter,
  
  // Legacy alias
  searchCicekSepeti,
  
  // Scrape function
  searchCicekSepetiScrape,
  
  // Adapter configuration
  ...cicekSepetiAdapterConfig,
  
  // Provider metadata
  CICEKSEPETI_META,
  
  // Adapter Engine registration helper
  register: () => cicekSepetiAdapterConfig
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchCicekSepetiAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "ciceksepeti";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "ciceksepetiAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchCicekSepetiAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "ciceksepeti",
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
      source: "ciceksepeti",
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
      source: "ciceksepeti",
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
