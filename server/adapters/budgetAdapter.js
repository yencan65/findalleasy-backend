// server/adapters/budgetAdapter.js
// =======================================================================
//  BUDGET RENT A CAR — S33 TITAN+ FINAL MAX + ENGINE UYUMLULUK KATMANI
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

// ================== REQUIRED CORE HELPERS (MISSING FIX) ==================

const safe = (v) => (v == null ? "" : String(v).trim());

function parsePriceStrong(txt) {
  if (!txt) return null;
  let v = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Bu fonksiyon artık motor tarafından değil, sadece geçmiş uyumluluk
// veya debug amaçlı kullanılabilir. ÇAĞRISI kaldırıldı, kendisi duruyor.
function normalizeS33(raw, region = "TR") {
  const imageFixed =
    raw.image ||
    `https://source.unsplash.com/featured/?car,rental,${encodeURIComponent(
      raw.title
    )}`;
  const variants = buildImageVariants(imageFixed, "budget");

  const affiliateUrl = buildAffiliateUrl(
    { url: raw.url, provider: "budget" },
    { source: "adapter" }
  );

  const id = crypto
    .createHash("md5")
    .update(raw.title + raw.url + raw.price)
    .digest("hex")
    .slice(0, 16);

  const optimized =
    raw.price != null
      ? optimizePrice(
          { price: raw.price, provider: "budget" },
          { provider: "budget", region }
        )
      : null;

  return {
    id,
    provider: "budget",
    providerFamily: "budget",
    vertical: "car_rental",

    title: raw.title,
    price: raw.price,
    finalPrice: raw.price,
    optimizedPrice: optimized,
    priceText: raw.price ? `${raw.price} TL` : null,

    url: raw.url,
    deeplink: affiliateUrl,

    image: variants.image,
    imageUrl: variants.image,
    imageOriginal: variants.imageOriginal,
    imageProxy: variants.imageProxy,
    hasProxy: variants.hasProxy,

    rating: raw.rating || null,
    stock: "available",
    currency: "TRY",
    region,

    category: "car_rental",
    categoryAI: "car_rental",

    qualityScore: 0.85,

    raw,
  };
}

// ------------------------------------------------------------
// S10 MOTOR UYUMLULUK KATMANI
// ------------------------------------------------------------
const ADAPTER_METADATA = {
  name: "budgetAdapter",
  displayName: "Budget Rent A Car",
  provider: "budget",
  providerFamily: "budget",
  category: "car_rental",
  subcategory: "rental_car",
  vertical: "mobility",
  priority: 0.85,
  commissionRate: 0.08, // %8 komisyon
  supportedRegions: ["TR"],
  timeout: 12000,
  rateLimit: 15, // dakikada 15 istek
  capabilities: {
    affiliate: true,
    realtime: true,
    stockInfo: false,
    categories: false,
    filters: true,
  },
  engineVersion: "S33_TitanPlus",
  lastUpdated: "2024",
};

// ------------------------------------------------------------
// MOTOR İÇİN ZORUNLU FORMAT — S200 RAW OUTPUT
// ------------------------------------------------------------
export async function searchBudgetAdapterLegacy(query, options = {}) {
  const {
    region = "TR",
    limit = 30,
    signal = null,
    // category, timeout vs. motor zaten yönetiyor, burada kullanmıyoruz
  } = options || {};

  // 1. Query validation (motor standardı)
  if (!query || typeof query !== "string" || query.trim().length < 1) {
    return {
      ok: false,
      items: [],
      count: 0,
      error: "Geçersiz sorgu",
      provider: ADAPTER_METADATA.provider,
      timestamp: Date.now(),
    };
  }

  // 2. Rate limiting (motor standardı)
  try {
    const limiterKey = `budget_${region}`;
    const canProceed = await rateLimiter.check(
      limiterKey,
      ADAPTER_METADATA.rateLimit
    );
    if (!canProceed) {
      console.warn("⚠️ Rate limit: budgetAdapter");
      return {
        ok: false,
        items: [],
        count: 0,
        error: "Rate limit aşıldı",
        provider: ADAPTER_METADATA.provider,
        timestamp: Date.now(),
        _meta: { rateLimited: true },
      };
    }
  } catch (err) {
    console.warn("rateLimiter budgetAdapter hata:", err?.message || err);
    // rateLimiter patlarsa, yine de devam edebiliriz → fail-open
  }

  try {
    // 3. Ana scraping işlemi — sadece RAW nesneler
    const scraped = await scrapeBudgetPage(query, region, signal);
    const arr = Array.isArray(scraped) ? scraped.slice(0, limit) : [];

    // ❗ S200: normalizeItem/priceFixer/commission motor tarafından yapılacak.
    // Burada sadece minimum raw alanları sağlıyoruz.
    const items = arr.map((r) => ({
      title: safe(r.title),
      price: typeof r.price === "number" ? r.price : null,
      url: r.url,
      image: r.image || null,

      // Motorun provider resolver / normalizeProviderS9 için temel anahtar
      provider: "budget",

      // Motor region/currency/category'yi kendi mantığıyla da güncelleyebilir
      region,
      category: "car_rental",
      vertical: "car_rental",

      // Debug / geçmiş uyumluluk için RAW payload
      raw: r,
    }));

    return {
      ok: true,
      items,
      count: items.length,
    };
  } catch (error) {
    console.error("❌ budgetAdapter hata:", error?.message || error);

    const errorType = classifyError(error || {});

    return {
      ok: false,
      items: [],
      count: 0,
      error: errorType.message,
      errorCode: errorType.code,
      query,
      provider: ADAPTER_METADATA.provider,
      category: ADAPTER_METADATA.category,
      region,
      timestamp: Date.now(),
      _meta: {
        adapter: ADAPTER_METADATA.name,
        errorType: errorType.type,
        retryable: errorType.retryable,
      },
    };
  }
}

// ------------------------------------------------------------
// HELPER FUNCTIONS (motor uyumluluğu için)
// ------------------------------------------------------------
function generateId(provider, title, url) {
  const slug = slugify(title);
  const pHash = crypto
    .createHash("md5")
    .update(String(Date.now()))
    .digest("hex")
    .slice(0, 6);
  const uHash = crypto
    .createHash("md5")
    .update(String(url || ""))
    .digest("hex")
    .slice(0, 6);
  return `${provider}_${slug}_${pHash}_${uHash}`;
}

function slugify(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function calculateBaseScore(item) {
  let score = 0.5; // base score

  if (item.price && item.price > 0) {
    const priceScore = Math.max(0.1, 1 - item.price / 1000);
    score += priceScore * 0.3;
  }

  if (item.qualityScore) {
    score += item.qualityScore * 0.2;
  }

  score += 0.1;

  return Math.min(1, Math.max(0.1, score));
}

function extractLocation(query) {
  const locations = ["istanbul", "ankara", "izmir", "antalya", "bursa"];
  const q = query.toLowerCase();

  for (const loc of locations) {
    if (q.includes(loc)) return loc.charAt(0).toUpperCase() + loc.slice(1);
  }

  return null;
}

function extractVehicleType(title) {
  const t = String(title).toLowerCase();

  if (t.includes("suv") || t.includes("4x4")) return "SUV";
  if (t.includes("sedan")) return "Sedan";
  if (t.includes("hatchback")) return "Hatchback";
  if (t.includes("station") || t.includes("station wagon"))
    return "Station Wagon";
  if (t.includes("minibüs") || t.includes("van")) return "Minivan";
  if (t.includes("convertible") || t.includes("cabrio")) return "Convertible";

  return "Economy";
}

function extractTransmission(title) {
  const t = String(title).toLowerCase();

  if (t.includes("otomatik") || t.includes("automatic")) return "automatic";
  if (t.includes("manuel") || t.includes("manual")) return "manual";

  return "automatic";
}

function extractFuelType(title) {
  const t = String(title).toLowerCase();

  if (t.includes("dizel") || t.includes("diesel")) return "diesel";
  if (
    t.includes("benzin") ||
    t.includes("petrol") ||
    t.includes("gasoline")
  )
    return "petrol";
  if (t.includes("elektrik") || t.includes("electric")) return "electric";
  if (t.includes("hibrit") || t.includes("hybrid")) return "hybrid";

  return "petrol";
}

function extractSeats(title) {
  const t = String(title).toLowerCase();

  if (t.includes("7 kişi") || t.includes("7 seater")) return 7;
  if (t.includes("5 kişi") || t.includes("5 seater")) return 5;
  if (t.includes("4 kişi") || t.includes("4 seater")) return 4;

  return 5;
}

function classifyError(error) {
  const msg = String(error?.message || "").toLowerCase();

  if (error.name === "AbortError" || msg.includes("timeout")) {
    return {
      type: "timeout",
      code: "TIMEOUT",
      message: "İstek zaman aşımına uğradı",
      retryable: true,
    };
  }

  if (msg.includes("network") || msg.includes("fetch")) {
    return {
      type: "network",
      code: "NETWORK_ERROR",
      message: "Ağ hatası oluştu",
      retryable: true,
    };
  }

  if (msg.includes("404") || msg.includes("not found")) {
    return {
      type: "not_found",
      code: "NOT_FOUND",
      message: "Sayfa bulunamadı",
      retryable: false,
    };
  }

  if (msg.includes("403") || msg.includes("ban")) {
    return {
      type: "blocked",
      code: "BLOCKED",
      message: "Erişim engellendi",
      retryable: false,
    };
  }

  return {
    type: "unknown",
    code: "UNKNOWN_ERROR",
    message: "Beklenmeyen bir hata oluştu",
    retryable: false,
  };
}

async function scrapeBudgetPage(query, region, signal) {
  const url = `https://www.budget.com.tr/arac-kiralama?search=${encodeURIComponent(
    query
  )}`;

  let html = null;

  try {
    html = await proxyFetchHTML(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/124",
      },
    });
  } catch {}

  if (!html) {
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/124",
        },
      });
      html = data;
    } catch (err) {
      console.warn("Budget anti-ban fail:", err.message);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const raw = [];

  const selectors = [
    ".carItem",
    ".car-card",
    ".result-card",
    ".listing-card",
    ".car-item",
    ".carBox",
    ".vehicle-card",
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find(".car-name").text()) ||
      safe(wrap.find(".title").text()) ||
      safe(wrap.find(".carTitle").text()) ||
      safe(wrap.find(".model").text()) ||
      safe(wrap.find(".carModel").text()) ||
      safe(wrap.find("h3").text()) ||
      safe(wrap.find("h2").text());
    if (!title) return;

    const ptxt =
      safe(wrap.find(".price").text()) ||
      safe(wrap.find(".amount").text()) ||
      safe(wrap.find(".price-value").text()) ||
      safe(wrap.find(".dailyPrice").text()) ||
      safe(wrap.find(".total-price").text());

    const pRaw = parsePriceStrong(ptxt);
    const price = sanitizePrice(pRaw);

    let href =
      safe(wrap.find("a").attr("href")) ||
      safe(wrap.attr("data-hhref")) ||
      safe(wrap.attr("data-url"));
    if (!href) return;

    if (!href.startsWith("http")) href = "https://www.budget.com.tr" + href;
    href = href.split("?")[0];

    let img =
      safe(wrap.find("img").attr("data-src")) ||
      safe(wrap.find("img").attr("data-original")) ||
      safe(wrap.find("img").attr("data-lazy")) ||
      safe(wrap.find("img").attr("src"));
    if (img?.startsWith("//")) img = "https:" + img;

    raw.push({
      title,
      price,
      url: href,
      image: img,
      rating: null,
      region,
    });
  });

  // ❗ Artık normalizeS33 ÇAĞRILMIYOR, motorun normalizeItem zinciri çalışacak.
  return raw;
}

// ------------------------------------------------------------
// ALIAS FONKSİYONLAR (geriye uyumluluk için)
// ------------------------------------------------------------
export async function searchBudget(query, options = {}) {
  return searchBudgetAdapter(query, options);
}

export async function searchBudgetScrape(query, options = {}) {
  return searchBudgetAdapter(query, options);
}

// ------------------------------------------------------------
// METADATA EXPORT (motor için)
// ------------------------------------------------------------
searchBudgetAdapter.metadata = ADAPTER_METADATA;
searchBudget.metadata = ADAPTER_METADATA;
searchBudgetScrape.metadata = ADAPTER_METADATA;

export default {
  searchBudget,
  searchBudgetAdapter,
  searchBudgetScrape,
  metadata: ADAPTER_METADATA,
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBudgetAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "budget";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "budgetAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBudgetAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "budget",
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
      source: "budget",
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
      source: "budget",
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
