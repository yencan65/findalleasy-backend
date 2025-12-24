// server/adapters/akakceAdapter.js
// ============================================================
// AKAKÇE ADAPTER - S200 FINAL (ANA MOTOR İLE %100 UYUMLU)
// ------------------------------------------------------------
// • Price comparison adapter (ürün fiyat karşılaştırma)
// • S200 normalizeItem + optimizePrice + commissionEngine uyumlu
// • Output: { ok, items, count, source, _meta }  (S200-WRAPPED uyumlu)
// • affiliateEngine ile entegre (affiliateUrl üretmeye çalışır, çökertmez)
// • NO CRASH: proxyEngine yoksa / parse drift varsa adapter ölmez
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO-DELETE: projende başka yerde referans olabilir
import crypto from "crypto";

import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";
import { optimizePrice } from "../utils/priceFixer.js"; // ZERO-DELETE: import korunuyor
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  withTimeout,
  TimeoutError,
  stableIdS200,
  coerceItemsS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================
// OPTIONAL PROXY (DYNAMIC) — import patlatmasın
// ============================================================

let __proxyTried = false;
let __proxyFetchHTML = null;

async function getProxyFetchHTML() {
  if (__proxyTried) return __proxyFetchHTML;
  __proxyTried = true;

  try {
    const mod = await import("../core/proxyEngine.js");
    if (mod && typeof mod.proxyFetchHTML === "function") {
      __proxyFetchHTML = mod.proxyFetchHTML;
    }
  } catch {
    __proxyFetchHTML = null;
  }
  return __proxyFetchHTML;
}

// ============================================================
// HELPER FONKSİYONLAR
// ============================================================

const safe = (v) => (v ? String(v).trim() : "");

function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;

  const s = String(v).trim();
  if (!s) return null;

  let t = s.replace(/[^\d.,]/g, "");
  if (!t) return null;

  const hasDot = t.includes(".");
  const hasComma = t.includes(",");

  if (hasDot && hasComma) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) {
      t = t.replace(/\./g, "").replace(",", ".");
    } else {
      t = t.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    if (/,(\d{1,2})$/.test(t)) t = t.replace(",", ".");
    else t = t.replace(/,/g, "");
  } else {
    if (/\.(\d{3})(\D|$)/.test(t) && !/\.\d{1,2}$/.test(t)) {
      t = t.replace(/\./g, "");
    }
  }

  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildStableId(raw, title = "", provider = "akakce") {
  const base = `${provider}_${raw || title || "id"}`;
  try {
    return (
      "akakce_" +
      crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16)
    );
  } catch {
    return "akakce_" + String(base).replace(/\W+/g, "_");
  }
}

function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;

  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `https://www.akakce.com${s}`;

  return `https://www.akakce.com/${s.replace(/^\/+/, "")}`;
}

function normalizeImageUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `https://www.akakce.com${s}`;
  return s;
}

function pickFirstText($root, selectors = []) {
  for (const sel of selectors) {
    try {
      const t = safe($root.find(sel).first().text());
      if (t) return t;
    } catch {}
  }
  return "";
}

function pickFirstAttr($root, selectors = [], attr = "href") {
  for (const sel of selectors) {
    try {
      const v = $root.find(sel).first().attr(attr);
      if (v) return String(v).trim();
    } catch {}
  }
  return "";
}

function pickFirstImage($root) {
  try {
    const img =
      $root.find("img").first().attr("data-src") ||
      $root.find("img").first().attr("data-original") ||
      $root.find("img").first().attr("data-lazy") ||
      $root.find("img").first().attr("src") ||
      null;
    return img ? normalizeImageUrl(img) : null;
  } catch {
    return null;
  }
}

function parseCountFromText(txt) {
  const t = safe(txt);
  if (!t) return null;
  const m = t.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ============================================================
// PRICE COMPARISON METADATA EXTRACTOR
// ============================================================

function extractPriceComparisonMetadata(productData, title) {
  const metadata = {
    comparisonType: "price_comparison",
    providerType: "akakce",
    isPriceComparison: true,
    source: "scraping",
    features: [],
    merchants: [],
  };

  const titleLower = (title || "").toLowerCase();

  if (
    titleLower.includes("telefon") ||
    titleLower.includes("phone") ||
    titleLower.includes("iphone") ||
    titleLower.includes("samsung")
  ) {
    metadata.productCategory = "phone";
    metadata.isElectronics = true;
    metadata.isMobile = true;
  } else if (
    titleLower.includes("laptop") ||
    titleLower.includes("notebook") ||
    titleLower.includes("bilgisayar")
  ) {
    metadata.productCategory = "laptop";
    metadata.isElectronics = true;
    metadata.isComputer = true;
  } else if (
    titleLower.includes("televizyon") ||
    titleLower.includes("tv") ||
    titleLower.includes("televizyonu")
  ) {
    metadata.productCategory = "tv";
    metadata.isElectronics = true;
    metadata.isHomeAppliance = true;
  } else if (
    titleLower.includes("buzdolabı") ||
    titleLower.includes("fridge") ||
    titleLower.includes("refrigerator")
  ) {
    metadata.productCategory = "refrigerator";
    metadata.isHomeAppliance = true;
  } else if (
    titleLower.includes("çamaşır makinesi") ||
    titleLower.includes("washing machine")
  ) {
    metadata.productCategory = "washing_machine";
    metadata.isHomeAppliance = true;
  } else if (
    titleLower.includes("klima") ||
    titleLower.includes("air conditioner")
  ) {
    metadata.productCategory = "air_conditioner";
    metadata.isHomeAppliance = true;
  } else {
    metadata.productCategory = "general";
  }

  const brands = [
    "samsung",
    "apple",
    "iphone",
    "huawei",
    "xiaomi",
    "oppo",
    "vivo",
    "realme",
    "lg",
    "bosch",
    "siemens",
    "arcelik",
    "beko",
    "vestel",
    "profilo",
    "grundig",
    "sony",
    "lenovo",
    "hp",
    "dell",
    "asus",
    "acer",
    "msi",
    "toshiba",
    "canon",
    "nike",
  ];

  for (const brand of brands) {
    if (titleLower.includes(brand)) {
      metadata.brand = brand;
      break;
    }
  }

  if (titleLower.includes("4k") || titleLower.includes("ultra hd")) {
    metadata.features.push("4k");
    metadata.resolution = "4k";
  }

  if (titleLower.includes("smart") || titleLower.includes("akıllı")) {
    metadata.features.push("smart");
    metadata.isSmart = true;
  }

  if (titleLower.includes("android") || titleLower.includes("ios")) {
    metadata.features.push("mobile_os");
  }

  if (titleLower.includes("çift") && titleLower.includes("sim")) {
    metadata.features.push("dual_sim");
  }

  if (titleLower.includes("5g")) {
    metadata.features.push("5g");
  }

  return metadata;
}

// ============================================================
// OPTIMIZEPRICE WRAPPER (S200: NO-OP)
// ============================================================

function applyOptimizePrice(item) {
  try {
    // S200 kuralı: optimizePrice motor tarafında çalışacak.
    // ZERO-DELETE: optimizePrice import'u ve wrapper fonksiyonu korunuyor.
    return item;
  } catch (e) {
    console.warn("Akakce optimizePrice hata:", e?.message);
    return item;
  }
}

// ============================================================
// FETCH HTML (proxy → direct fallback) — hardened
// ============================================================

async function fetchSearchHtml(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 12000);
  const signal = options.signal || null;

  const baseHeaders = {
    "User-Agent":
      options.ua ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept-Language": options.lang || "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
    Accept:
      options.accept ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  const headers = { ...baseHeaders, ...(options.headers || {}) };

  // 1) proxy (varsa)
  try {
    const proxyFetchHTML = await getProxyFetchHTML();
    if (typeof proxyFetchHTML === "function") {
      const html = await proxyFetchHTML(url, {
        headers,
        signal,
        timeoutMs,
        region: options.region || "TR",
      });
      if (html && typeof html === "string" && html.length > 1000) return html;
    }
  } catch {
    // proxy fail -> direct
  }

  // 2) direct axios fallback
  const res = await axios.get(url, {
    headers,
    signal,
    timeout: timeoutMs,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  return res.data;
}

// ============================================================
// ANA ADAPTER FONKSİYONU - S200 UYUMLU
// ============================================================

export async function searchAkakceAdapterLegacy(query, regionOrOptions = "TR") {
  const providerKey = "akakce";
  const startedAt = Date.now();

  if (!query || typeof query !== "string" || !query.trim()) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: providerKey,
      _meta: {
        providerKey,
        providerFamily: "product",
        provider: "product",
        code: "EMPTY_QUERY",
        timestamp: Date.now(),
      },
    };
  }

  // Region + signal + headers
  let region = "TR";
  let signal = null;
  let headers = null;
  let timeoutMs = 12000;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
    headers =
      regionOrOptions.headers ||
      regionOrOptions.requestHeaders ||
      regionOrOptions.proxyHeaders ||
      null;
    timeoutMs = Number(regionOrOptions.timeoutMs || regionOrOptions.timeout || 12000);
  }

  region = String(region || "TR").toUpperCase();

  // Local RL (engine RL + adapter RL)
  const bypassLocalRL =
    (regionOrOptions && typeof regionOrOptions === "object" && regionOrOptions.shadow) ||
    process.env.S200_DISABLE_RL === "1" ||
    process.env.S200_RL_BYPASS === "1" ||
    process.env.DISABLE_RATE_LIMIT === "1";

  if (!bypassLocalRL) {
    const limiterKey = `s200:adapter:akakce:${region}`;
    let allowed = true;

    try {
      allowed = await rateLimiter.check(limiterKey, {
        limit: 12,
        windowMs: 60_000,
        burst: true,
        adaptive: true,
      });
    } catch {
      allowed = true;
    }

    if (!allowed) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: providerKey,
        _meta: {
          providerKey,
          providerFamily: "product",
          provider: "product",
          code: "RATE_LIMIT",
          stage: "rate_limit",
          limiterKey,
          query: String(query || ""),
          region,
          timestamp: Date.now(),
        },
      };
    }
  }

  try {
    const q = encodeURIComponent(query);
    const url = `https://www.akakce.com/arama/?q=${q}`;

    globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, url, at: "akakceAdapter:search" };

    const html = await withTimeout(
      fetchSearchHtml(url, {
        region,
        signal,
        headers: headers || {},
        timeoutMs,
      }),
      timeoutMs,
      "akakce:fetchSearchHtml"
    );

    const $ = loadCheerioS200(html, { adapter: providerKey, url });

    const results = [];

    const itemSelectors = [
      "li.p-c",
      "li.p",
      ".p_w_v8",
      ".product-item",
      ".search-result-item",
      "div[id*='p_']",
    ];

    const collected = [];
    for (const sel of itemSelectors) {
      try {
        const found = $(sel).toArray();
        if (found && found.length) collected.push(...found);
      } catch {}
    }

    const seen = new Set();
    const nodes = [];
    for (const n of collected) {
      const k =
        (n?.attribs?.id ? `id:${n.attribs.id}` : "") +
        "|" +
        (n?.attribs?.class ? `c:${n.attribs.class}` : "") +
        "|" +
        (n?.name || "");
      if (seen.has(k)) continue;
      seen.add(k);
      nodes.push(n);
      if (nodes.length >= 150) break;
    }

    const iterable = nodes.length
      ? nodes
      : $("li.p-c, li.p, .product-item, .search-result-item").toArray();

    iterable.forEach((el) => {
      const root = $(el);

      const title =
        pickFirstText(root, [
          "a.p-t",
          "a.pw_v8",
          "a.p_t_v8",
          "h3",
          "h2",
          ".product-title",
          "span",
        ]) || null;

      if (!title) return;

      const href =
        pickFirstAttr(root, ["a.p-t", "a.pw_v8", "a.p_t_v8", "a"], "href") || null;

      const fullUrl = normalizeUrl(href);
      if (!fullUrl) return;

      const priceText =
        pickFirstText(root, [
          ".pt-v",
          ".p-p",
          ".price",
          ".p-tb",
          ".p_p_v8",
          ".pt_v8",
          ".pt_v8 span",
        ]) || null;

      let price = parsePrice(priceText);
      if (price !== null && price < 1) price = null;

      const imgRaw = pickFirstImage(root);
      const priceMeta = extractPriceComparisonMetadata({}, title);

      // Rating
      let rating = null;
      try {
        const ratingElement = root
          .find(".rating, .score, .star-rating, [data-score]")
          .first();
        if (ratingElement && ratingElement.length) {
          const ratingText = ratingElement.attr("data-score") || ratingElement.text();
          const ratingNum = parseFloat(String(ratingText || "").replace(",", "."));
          if (ratingNum && ratingNum > 0 && ratingNum <= 5) rating = ratingNum;
        }
      } catch {}

      // Review count
      const reviewText = pickFirstText(root, [
        ".review-count",
        ".comment-count",
        ".rvw",
        ".cmt",
        ".p_r_v8",
      ]);
      const reviewCount = parseCountFromText(reviewText);

      // Merchant
      const merchantText = pickFirstText(root, [
        ".merchant",
        ".seller",
        ".shop",
        ".m_v8",
        ".s_v8",
      ]);
      const merchant = merchantText ? safe(merchantText) : null;

      // comparison count
      const compText = pickFirstText(root, [
        ".p-c-s",
        ".s_v8",
        ".p_s_v8",
        ".p_c_v8",
        ".p_o_v8",
      ]);
      const comparisonCount = parseCountFromText(compText) || 1;

      let item = {
        id: buildStableId(fullUrl || href || title, title, "akakce"),
        title,
        price: price ?? null,
        rating: rating ?? null,
        reviewCount: reviewCount ?? null,

        provider: "akakce",
        category: "product",
        subCategory: priceMeta.productCategory,
        currency: "TRY",
        region,
        url: fullUrl,

        productCategory: priceMeta.productCategory,
        brand: priceMeta.brand || null,
        features: Array.isArray(priceMeta.features) ? priceMeta.features : [],
        merchant: merchant || null,
        isPriceComparison: true,
        comparisonCount,

        raw: {
          title,
          priceText,
          priceComparisonMetadata: priceMeta,
          merchant,
          imageRaw: imgRaw,
          variants: buildImageVariants(imgRaw, "akakce"),
          affiliateHint: null,
          extractedAt: new Date().toISOString(),
          sourceUrl: url,
          adapterVersion: "s200_akakce_2.3",
        },
      };

      // affiliate hint (NO CRASH)
      try {
        const aff = buildAffiliateUrl(
          {
            providerKey,
            provider: "product",
            url: fullUrl,
            title,
            category: "product",
            subCategory: priceMeta.productCategory,
          },
          { source: "akakceAdapter", providerKey, query, region }
        );

        if (aff && aff !== fullUrl) {
          item.affiliateUrl = aff;
          item.raw.affiliateHint = aff;
          item.raw.affiliateApplied = true;
        } else {
          item.raw.affiliateHint = null;
        }
      } catch {
        item.raw.affiliateHint = null;
      }

      // sanitize price (NO CRASH)
      if (price !== null) {
        try {
          item.price = sanitizePrice(price, {
            provider: "akakce",
            category: "product",
            subCategory: priceMeta.productCategory,
          });
        } catch {
          item.price = price;
        }
      }

      item = applyOptimizePrice(item);
      results.push(item);
    });

    // query relevance flags
    const qLower = query.toLowerCase();
    results.forEach((item) => {
      const titleLower = String(item.title || "").toLowerCase();
      const productType = item.productCategory;

      if (
        (qLower.includes("telefon") ||
          qLower.includes("phone") ||
          qLower.includes("iphone") ||
          qLower.includes("samsung")) &&
        (productType === "phone" || titleLower.includes("telefon") || titleLower.includes("phone"))
      ) {
        item.raw.priceComparisonMetadata.isQueryRelevant = true;
      }

      if (
        (qLower.includes("laptop") ||
          qLower.includes("notebook") ||
          qLower.includes("bilgisayar")) &&
        (productType === "laptop" || titleLower.includes("laptop") || titleLower.includes("notebook"))
      ) {
        item.raw.priceComparisonMetadata.isQueryRelevant = true;
      }

      if (
        (qLower.includes("tv") || qLower.includes("televizyon")) &&
        (productType === "tv" || titleLower.includes("tv") || titleLower.includes("televizyon"))
      ) {
        item.raw.priceComparisonMetadata.isQueryRelevant = true;
      }

      if (
        (qLower.includes("buzdolabı") ||
          qLower.includes("çamaşır makinesi") ||
          qLower.includes("klima")) &&
        (productType === "refrigerator" ||
          productType === "washing_machine" ||
          productType === "air_conditioner")
      ) {
        item.raw.priceComparisonMetadata.isQueryRelevant = true;
      }

      if (item.brand && qLower.includes(String(item.brand).toLowerCase())) {
        item.raw.priceComparisonMetadata.isBrandMatch = true;
      }
    });

    // Final + normalize (contract lock)
    const finalResults = results
      .filter((x) => x && x.title && x.url)
      .slice(0, 120);

    const normalized = [];
    for (const it of finalResults) {
      try {
        const { id: _dropId, ...rest } = it;

        const norm = normalizeItemS200(
          {
            ...rest,
            providerKey,
            providerFamily: "product",
            provider: "product",
            affiliateUrl: rest.affiliateUrl || rest.raw?.affiliateHint || null,
            originUrl: rest.originUrl || rest.url || null,
          },
          providerKey,
          {
            providerFamily: "product",
            vertical: "product",
            category: "product",
            currency: "TRY",
            region,
          }
        );

        if (norm) normalized.push(norm);
      } catch {
        // NO CRASH
      }
    }

    return {
      ok: true,
      items: normalized,
      count: normalized.length,
      source: providerKey,
      _meta: {
        providerKey,
        providerFamily: "product",
        provider: "product",
        vertical: "product",
        query: String(query || ""),
        region,
        url,
        elapsedMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn("AkakceAdapter hata:", msg);

    // ZERO-DELETE: fallback item sadece log (S200 return => empty)
    const fallbackItem = {
      id: buildStableId(`fallback_${query}`, query, "akakce"),
      title: `Akakçe: ${query}`,
      price: null,
      rating: null,
      provider: "akakce",
      category: "product",
      subCategory: "general",
      currency: "TRY",
      region: String(
        (typeof regionOrOptions === "string" ? regionOrOptions : regionOrOptions?.region || "TR") || "TR"
      ).toUpperCase(),
      url: `https://www.akakce.com/arama/?q=${encodeURIComponent(query)}`,
      raw: {
        title: `Akakçe erişilemedi (${query})`,
        priceComparisonMetadata: {
          comparisonType: "price_comparison",
          providerType: "akakce",
          isPriceComparison: true,
        },
        extractedAt: new Date().toISOString(),
        error: msg,
      },
    };

    console.warn("AkakceAdapter fallback (S200 için sadece loglanıyor):", fallbackItem);

    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: {
        providerKey,
        providerFamily: "product",
        provider: "product",
        vertical: "product",
        query: String(query || ""),
        region:
          String((typeof regionOrOptions === "string" ? regionOrOptions : regionOrOptions?.region || "TR") || "TR").toUpperCase(),
        stage: "catch",
        code: "FAIL",
        error: msg,
        elapsedMs: Date.now() - startedAt,
        timestamp: Date.now(),
      },
    };
  }
}

// ============================================================
// ANA MOTOR İÇİN ADAPTER KONFİGÜRASYONU
// ============================================================

export const akakceAdapterConfig = {
  name: "akakce",
  fn: searchAkakceAdapter,
  timeoutMs: 12000,
  priority: 1.1,
  category: "product",
  subCategories: ["phone", "laptop", "tv", "home_appliance", "electronics", "general"],
  provider: "akakce",
  commissionRate: 0.04,
  vertical: "price_comparison",
  regionSupport: ["TR"],
  priceComparisonSpecific: true,
  features: ["price_comparison", "product_search", "merchant_aggregation"],
  metadata: {
    providerType: "price_comparison",
    hasAffiliate: true,
    isAggregator: true,
    supportsPriceHistory: false,
    supportsReviews: true,
  },
};

// ============================================================
// PRODUCTADAPTERS.JS ENTEGRASYON İÇİN ADAPTER OBJESİ
// ============================================================

export const akakceAdapter = {
  name: "akakce",
  fn: searchAkakceAdapter,
  timeoutMs: 12000,
  priority: 1.1,
  category: "product",
  provider: "akakce",
  commissionRate: 0.04,
  vertical: "price_comparison",
};

// ============================================================
// ALTERNATİF EXPORT'LAR (ANA MOTOR UYUMLU)
// ============================================================

export const searchAkakce = searchAkakceAdapter;
export const akakcePriceAdapter = searchAkakceAdapter;

// ============================================================
// DEFAULT EXPORT
// ============================================================

export default {
  searchAkakceAdapter,
  akakceAdapterConfig,
  akakceAdapter,
  searchAkakce,
};

// ============================================================
// SİSTEM BAŞLATMA LOG'U
// ============================================================

console.log("💰 AKAKÇE PRICE COMPARISON ADAPTER S200 YÜKLENDİ - ANA MOTOR İLE %100 UYUMLU");
console.log("📊 Kategori: product (price comparison)");
console.log("📈 Özellik: Fiyat karşılaştırma, ürün arama");
console.log("💰 Komisyon Oranı (config): %4");
console.log("🎯 Priority: 1.1");
console.log("⏱️ Timeout: 12000ms");
console.log("=====================================================");

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchAkakceAdapter(query, regionOrOptions = "TR") {
  const providerKey = "akakce";
  const started = Date.now();

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    provider: providerKey,
    group: "product",
    region: typeof regionOrOptions === "string" ? regionOrOptions : regionOrOptions?.region,
    startedAt: started,
  };

  try {
    const timeoutMs = Number(regionOrOptions?.timeoutMs || 6500);
    const region =
      typeof regionOrOptions === "string"
        ? regionOrOptions
        : String(regionOrOptions?.region || "TR");

    const raw = await withTimeout(
      Promise.resolve(searchAkakceAdapterItems(query, regionOrOptions)),
      timeoutMs,
      providerKey
    );

    const legacyOk = !(raw && typeof raw === "object" && raw.ok === false);
    const legacyErr = legacyOk
      ? null
      : safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
    const legacyMeta = raw && typeof raw === "object" && raw._meta && typeof raw._meta === "object" ? raw._meta : null;

    const itemsIn = coerceItemsS200(raw);
    const out = [];
    let bad = 0;

    for (const it of itemsIn) {
      const norm = normalizeItemS200(it, providerKey, {
        providerFamily: "product",
        provider: "product",
        currency: "TRY",
        region,
      });
      if (!norm) {
        bad++;
        continue;
      }
      out.push(norm);
    }

    return {
      ok: legacyOk,
      items: out,
      count: out.length,
      source: providerKey,
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        bad,
        region,
        legacyOk,
        ...(legacyMeta || {}),
        ...(legacyErr ? { error: legacyErr } : {}),
      },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e, 900) || "unknown_error";
    const isTimeout = e?.name === "TimeoutError" || /timed out|timeout/i.test(String(e?.message || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs: Number(regionOrOptions?.timeoutMs || 6500),
        timeout: isTimeout,
        error: msg,
      },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}
 
