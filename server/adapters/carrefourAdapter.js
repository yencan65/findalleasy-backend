// server/adapters/carrefourAdapter.js
// =======================================================================
//  CARREFOURSA — S33 TITAN+ FINAL MAX EDITION + RATE LIMITER ENTEGRASYONU
// =======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  loadCheerioS200,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================
// DEFAULT HEADERS (Anti-bot için)
// ============================================================
const DEFAULT_HEADERS_CARREFOUR = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Referer": "https://www.carrefoursa.com/",
  "Connection": "keep-alive",
};

// ============================================================
// RATE LIMIT HELPER
// ============================================================
async function checkRateLimit(region = "TR") {
  try {
    const key = rateLimiter.createAdapterKey("carrefoursa", region, "market");

    const allowed = await rateLimiter.check(key, {
      provider: "carrefoursa",
      limit: 15,
      windowMs: 60000,
      burst: true,
      adaptive: true,
      priority: 2,
    });

    if (!allowed) {
      rateLimiter.registerError(key, 1);
      console.warn(`⛔ Carrefour Rate Limit Aşıldı [${region}]`);
    }

    return allowed;
  } catch (error) {
    console.warn(
      `⚠️ Rate limit kontrol hatası (carrefour):`,
      error.message
    );
    return true;
  }
}

// ============================================================
// ADAPTER METRICS
// ============================================================
const adapterMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  lastRequestTime: null,
  averageResponseTime: 0,
};

function updateMetrics(success = true, responseTime = 0) {
  adapterMetrics.totalRequests++;

  if (success) adapterMetrics.successfulRequests++;
  else adapterMetrics.failedRequests++;

  adapterMetrics.lastRequestTime = Date.now();

  if (responseTime > 0) {
    adapterMetrics.averageResponseTime =
      (adapterMetrics.averageResponseTime *
        (adapterMetrics.successfulRequests - 1) +
        responseTime) /
      adapterMetrics.successfulRequests;
  }
}

// ============================================================
// HELPERS
// ============================================================
const safe = (v) => (v == null ? "" : String(v).trim());

function parsePriceStrong(txt) {
  if (!txt) return null;
  let t = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
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
  const q = encodeURIComponent(title || "market");
  return `https://source.unsplash.com/featured/?grocery,${q}`;
}

function inferCategoryAI(title) {
  const t = safe(title).toLowerCase();
  if (t.includes("süt") || t.includes("yoğurt") || t.includes("peynir"))
    return "dairy";
  if (t.includes("et") || t.includes("tavuk") || t.includes("köfte"))
    return "fresh-food";
  if (t.includes("meyve") || t.includes("sebze")) return "produce";
  if (t.includes("çamaşır") || t.includes("temizlik")) return "household";
  if (t.includes("snack") || t.includes("atıştırmalık")) return "snack";
  if (t.includes("içecek") || t.includes("su")) return "beverages";
  if (t.includes("kahve") || t.includes("çay")) return "hot-drinks";
  if (t.includes("makarna") || t.includes("pirinç") || t.includes("un"))
    return "pantry";
  if (t.includes("bebek") || t.includes("çocuk")) return "baby";
  if (t.includes("evcil") || t.includes("pet")) return "pet";
  return "market";
}

function detectStock(root) {
  const txt = root.text().toLowerCase();
  if (txt.includes("tükendi") || txt.includes("stok yok")) return "out";
  if (txt.includes("sınırlı") || txt.includes("az kaldı")) return "limited";
  return "in_stock";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title?.length > 3) s += 0.25;
  if (item.price != null) s += 0.25;
  if (item.image) s += 0.15;
  if (item.stock !== "out") s += 0.1;
  if (item.categoryAI !== "market") s += 0.1;
  if (item.imageProxy) s += 0.05;
  if (item.optimizedPrice < item.price) s += 0.1;
  return Number(s.toFixed(2));
}

// ============================================================
// URL NORMALIZE
// ============================================================
function normalizeUrl(h) {
  if (!h) return null;
  let url = h.split("?")[0].split("#")[0].trim();

  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return "https://www.carrefoursa.com" + url;

  return "https://www.carrefoursa.com/tr/" + url;
}

// ============================================================
// RETRY MECHANISM
// ============================================================
async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`↻ Retry ${attempt}/${maxRetries} (${delay}ms)`);
        await new Promise((res) => setTimeout(res, delay));
      }

      const response = await proxyFetchHTML(url, {
        ...options,
        timeout: options.timeout || 16000,
        headers: {
          ...DEFAULT_HEADERS_CARREFOUR,
          ...options.headers,
        },
      });

      updateMetrics(true, Date.now() - startTime);
      return response;
    } catch (err) {
      if (attempt === maxRetries) {
        updateMetrics(false, Date.now() - startTime);
        throw err;
      }
    }
  }
}

// ============================================================
// PAGE SCRAPER
// ============================================================
async function scrapePage(query, region = "TR", signal) {
  const start = Date.now();
  const url = `https://www.carrefoursa.com/tr/search?q=${encodeURIComponent(
    query
  )}`;

  let html = null;

  try {
    const allowed = await checkRateLimit(region);
    if (!allowed) throw new Error("Rate limit exceeded");

    html = await fetchWithRetry(url, {
      timeout: 20000,
      signal,
      proxyRotation: true,
      headers: {
        ...DEFAULT_HEADERS_CARREFOUR,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
    });
  } catch (err) {
    console.log("↻ Proxy fail → direct fallback");

    try {
      const { data } = await axios.get(url, { headers: DEFAULT_HEADERS_CARREFOUR });
      html = data;
    } catch (fallbackErr) {
      console.warn("Carrefour tamamen erişilemedi:", fallbackErr.message);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const out = [];

  const selectors = [
    ".product-item",
    ".product-card",
    ".product-list-item",
    ".js-product-item",
    "[data-product-id]",
    ".col-6.col-lg-4",
    ".col-12.col-md-6.col-lg-3",
    ".product-component",
    ".item-box",
    ".vitrin-card",
    ".p-card-mini",
  ];

  $(selectors.join(",")).each((i, el) => {
    try {
      const root = $(el);

      const title =
        safe(
          root.find(".product-name, .pdp-title, .product-title").text()
        ) ||
        safe(root.find("h3, h2, .title").text()) ||
        safe(root.attr("data-product-name"));

      if (!title) return;

      const ptxt =
        safe(
          root
            .find(
              ".product-price, .price, .amount, .new-price, .current-price"
            )
            .text()
        ) ||
        safe(root.find(".value, .money, [data-price]").text());

      const parsed = parsePriceStrong(ptxt);
      const price = sanitizePrice(parsed);

      const href =
        safe(root.find("a").attr("href")) ||
        safe(root.attr("data-url")) ||
        safe(root.attr("href"));

      const urlNorm = normalizeUrl(href);
      if (!urlNorm) return;

      const imgRaw =
        root.find("img").attr("data-src") ||
        root.find("img").attr("src") ||
        root.find("img").attr("data-original") ||
        root.attr("data-image");

      let img = imgRaw || fallbackImage(title);
      if (img.startsWith("//")) img = "https:" + img;
      if (img.startsWith("/"))
        img = "https://www.carrefoursa.com" + img;

      const imageData = buildImageVariants(img, "carrefoursa");

      const categoryAI = inferCategoryAI(title);
      const stock = detectStock(root);

      const optimizedPrice =
        price != null
          ? optimizePrice(
              { price, provider: "carrefoursa", category: categoryAI },
              { provider: "carrefoursa", region, category: "market" }
            )
          : null;

      const id = stableId("carrefoursa", title, urlNorm, price);

      const discountText = safe(
        root.find(".discount, .sale, .promo, .campaign").text()
      );
      let discountPercent = null;
      const m = discountText.match(/(\d+)%/);
      if (m) discountPercent = parseInt(m[1]);

      const base = {
        id,
        provider: "carrefoursa",
        providerFamily: "carrefoursa",
        providerType: "market",
        vertical: "market",

        title,
        price,
        finalPrice: price,
        optimizedPrice,
        priceText: ptxt,
        discountPercent,
        hasDiscount: discountPercent != null,

        url: urlNorm,
        deeplink: buildAffiliateUrl(
          {
            url: urlNorm,
            provider: "carrefoursa",
            title,
            price,
          },
          {
            source: "adapter",
            campaign: "carrefoursa",
          }
        ),

        image: imageData.image,
        imageOriginal: imageData.imageOriginal,
        imageProxy: imageData.imageProxy,
        imageVariants: imageData.variants,
        hasProxy: imageData.hasProxy,

        stock,
        stockStatus: stock,
        currency: "TRY",
        region,

        category: "market",
        categoryAI,
        subCategory: categoryAI,
        tags: ["market", "grocery", "carrefour"],

        raw: {
          href,
          ptxt,
          img,
          discountText,
          elementIndex: i,
        },
      };

      const qualityScore = computeQualityScore(base);

      out.push({
        ...base,
        qualityScore,
        adapterVersion: "S33_TITAN_RATE_LIMITED",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("Parse error:", err.message);
    }
  });

  out.sort((a, b) => b.qualityScore - a.qualityScore);
  return out.slice(0, 40);
}

// ============================================================
// ADAPTER API
// ============================================================
export async function searchCarrefourAdapterLegacy(query, opts = "TR") {
  const start = Date.now();

  let region = "TR";
  let signal;
  let forceBypass = false;

  if (typeof opts === "string") region = opts;
  else {
    region = opts.region || "TR";
    signal = opts.signal;
    forceBypass = opts.forceBypass || false;
  }

  if (forceBypass && process.env.NODE_ENV === "development") {
    console.log("⚠ Rate-limit bypass aktif");
  }

  try {
    const results = await scrapePage(query, region, signal);
    const duration = Date.now() - start;

    console.log(`✅ Carrefour OK (${results.length} ürün, ${duration}ms)`);

    if (!forceBypass) {
      const key = rateLimiter.createAdapterKey("carrefoursa", region, "market");
      rateLimiter.registerSuccess(key, 1);
    }

    return results;
  } catch (err) {
    console.warn("❌ Carrefour hata:", err.message);

    if (!forceBypass) {
      const key = rateLimiter.createAdapterKey("carrefoursa", region, "market");
      rateLimiter.registerError(key, 1);
    }

    return [
      {
        provider: "carrefoursa",
        title: `CarrefourSA: "${query}" araması yapılamadı`,
        fallback: true,
        region,
        error: err.message,
        adapterVersion: "S33_TITAN_RATE_LIMITED",
      },
    ];
  }
}

export const searchCarrefour = searchCarrefourAdapter;

export function getCarrefourAdapterStats() {
  return {
    ...adapterMetrics,
    successRate:
      adapterMetrics.totalRequests > 0
        ? (adapterMetrics.successfulRequests / adapterMetrics.totalRequests) *
          100
        : 0,
    rateLimitInfo: rateLimiter.getAdapterStats("carrefoursa"),
    timestamp: new Date().toISOString(),
    version: "S33_TITAN_RATE_LIMITED",
  };
}

export function resetCarrefourRateLimit(region = "TR") {
  return rateLimiter.resetAdapter("carrefoursa", region);
}

export default {
  searchCarrefourAdapter,
  searchCarrefour,
  getCarrefourAdapterStats,
  resetCarrefourRateLimit,
  name: "carrefoursa",
  category: "market",
  priority: 2,
  rateLimit: {
    limit: 15,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  },
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchCarrefourAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "carrefour";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "carrefourAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchCarrefourAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "carrefour",
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
      source: "carrefour",
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
      source: "carrefour",
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
