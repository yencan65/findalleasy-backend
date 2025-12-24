// server/adapters/arabamAdapter.js
// ======================================================================
// ARABAM.COM ADAPTER - S200 RAW CLEAN EDITION
// ======================================================================
// • Hercules S200 ana motor ile %100 uyumlu
// • Adapter SADECE RAW ARRAY döner
// • normalizeItem / optimizePrice / commission vs. sadece LEGACY / TEST için
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import {
buildImageVariants } from "../utils/imageFixer.js";
import { optimizePrice } from "../utils/priceFixer.js";           // ZERO DELETE (legacy)
import { finalCategoryMultiplier } from "../core/commissionRates.js"; // ZERO DELETE (legacy)
import { rateLimiter } from "../utils/rateLimiter.js";

import {



  loadCheerioS200,
  coerceItemsS200,
  normalizeItemS200,
  withTimeout,
  safeStr,
  stableIdS200,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// S200: deterministic request/trace ids (NO RANDOM)
// ---------------------------------------------------------------------------
let __s200_seq = 0;
const __s200_next = () => {
  __s200_seq = (__s200_seq + 1) % 1000000000;
  return __s200_seq;
};
// --------------------------- S200 STRICT OUTPUT ---------------------------
const S200_SOURCE = "arabam";
const S200_PROVIDER_FAMILY = "vehicle_sale";
const S200_AT = "server/adapters/arabamAdapter.js";

// PROD: stubs/placeholder/fallback OFF (NO FAKE RESULTS)
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _s200Ok(items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: true, items: arr, count: arr.length, source: S200_SOURCE, _meta: meta || {} };
}

function _s200Fail(err, meta = {}) {
  const msg = safeStr(err?.message || err, 900) || "unknown_error";
  return { ok: false, items: [], count: 0, source: S200_SOURCE, _meta: { ...(meta || {}), error: msg } };
}

function _isTimeoutErr(e) {
  const msg = String(e?.message || "");
  return e?.name === "TimeoutError" || /timed out/i.test(msg) || /timeout/i.test(msg);
}

// ======================================================================
// S10 ADAPTER STATS REGISTRY (Ana motor uyumlu) — ZERO DELETE
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

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePriceRaw(t) {
  if (!t) return null;
  const sanitized = t
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(sanitized);
  return Number.isFinite(n) ? n : null;
}

function buildStableId(raw, title = "", provider = "arabam") {
  const base = `${provider}_${raw || title || "id"}`;
  try {
    return (
      "arabam_" +
      crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 16)
    );
  } catch {
    return "arabam_" + String(base).replace(/\W+/g, "_");
  }
}

function normalizeUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return "https://www.arabam.com" + href;
}

function extractBrandFromTitle(title) {
  const brands = [
    "Toyota",
    "Honda",
    "Ford",
    "BMW",
    "Mercedes",
    "Audi",
    "Volkswagen",
    "Renault",
    "Fiat",
    "Opel",
    "Peugeot",
    "Citroen",
    "Hyundai",
    "Kia",
    "Nissan",
    "Mazda",
    "Volvo",
    "Skoda",
    "Chevrolet",
    "Dacia",
    "Seat",
    "Mini",
    "Jeep",
    "Land Rover",
    "Mitsubishi",
    "Suzuki",
    "Subaru",
    "Porsche",
    "Lexus",
    "Infiniti",
    "Alfa Romeo",
    "DS Automobiles",
    "Tesla",
    "Togg",
    "Anadol",
  ];

  const titleLower = (title || "").toLowerCase();
  for (const brand of brands) {
    if (titleLower.includes(brand.toLowerCase())) return brand;
  }

  const turkishBrands = {
    mercedes: "Mercedes",
    bmw: "BMW",
    volkswagen: "Volkswagen",
    audi: "Audi",
    ford: "Ford",
    toyota: "Toyota",
    honda: "Honda",
    renault: "Renault",
    fiat: "Fiat",
    opel: "Opel",
    peugeot: "Peugeot",
    citroen: "Citroen",
    hyundai: "Hyundai",
    kia: "Kia",
    nissan: "Nissan",
    mazda: "Mazda",
    volvo: "Volvo",
    skoda: "Skoda",
  };

  for (const [key, value] of Object.entries(turkishBrands)) {
    if (titleLower.includes(key)) return value;
  }

  return null;
}

function extractModelFromTitle(title) {
  const models = [
    "Corolla",
    "Civic",
    "Focus",
    "Passat",
    "Golf",
    "Clio",
    "Megane",
    "Accord",
    "Camry",
    "Egea",
    "Tipo",
    "Tucson",
    "Sportage",
    "Astra",
    "Insignia",
    "A3",
    "A4",
    "A6",
    "3 Serisi",
    "5 Serisi",
    "C Serisi",
    "E Serisi",
    "Octavia",
    "Superb",
    "Fabia",
    "3008",
    "208",
    "308",
    "Captur",
    "Kadjar",
    "Qashqai",
    "X-Trail",
    "CX-5",
    "CX-30",
    "S60",
    "S90",
    "XC60",
    "XC90",
    "Ceed",
    "Rio",
    "Picanto",
    "i20",
    "i30",
    "Elantra",
    "Accent",
    "Getz",
  ];

  const titleLower = (title || "").toLowerCase();
  for (const model of models) {
    if (titleLower.includes(model.toLowerCase())) return model;
  }

  const modelPatterns = [
    /\b(\d{3})\s*seri(si)?\b/i,
    /\b([abcde])\s*seri(si)?\b/i,
    /\b([abcde])\s*class\b/i,
    /\bm(\d{1,2})\b/i,
    /\bxc(\d{2,3})\b/i,
    /\bq(\d{1,2})\b/i,
  ];

  for (const pattern of modelPatterns) {
    const match = title.match(pattern);
    if (match) return match[0].toUpperCase();
  }

  return null;
}

function extractTransmission(title) {
  const titleLower = (title || "").toLowerCase();
  if (
    titleLower.includes("otomatik") ||
    titleLower.includes("automatic") ||
    titleLower.includes("dsg") ||
    titleLower.includes("cvt")
  )
    return "automatic";
  if (titleLower.includes("manuel") || titleLower.includes("manual"))
    return "manual";
  if (
    titleLower.includes("yarı otomatik") ||
    titleLower.includes("semi-automatic")
  )
    return "semi-automatic";
  if (titleLower.includes("triptonik")) return "triptronic";
  return null;
}

function extractFuelType(title) {
  const titleLower = (title || "").toLowerCase();
  if (titleLower.includes("dizel") || titleLower.includes("diesel"))
    return "diesel";
  if (
    titleLower.includes("benzin") ||
    titleLower.includes("petrol") ||
    titleLower.includes("gasoline")
  )
    return "gasoline";
  if (titleLower.includes("elektrik") || titleLower.includes("electric"))
    return "electric";
  if (titleLower.includes("hibrit") || titleLower.includes("hybrid"))
    return "hybrid";
  if (titleLower.includes("lpg")) return "lpg";
  if (titleLower.includes("cng")) return "cng";
  return null;
}

function extractVehicleType(title) {
  const titleLower = (title || "").toLowerCase();
  if (titleLower.includes("sedan")) return "sedan";
  if (titleLower.includes("hatchback") || titleLower.includes("hatçbek"))
    return "hatchback";
  if (titleLower.includes("suv")) return "suv";
  if (
    titleLower.includes("station") ||
    titleLower.includes("station wagon") ||
    titleLower.includes("sw")
  )
    return "station_wagon";
  if (titleLower.includes("coupe") || titleLower.includes("kupa"))
    return "coupe";
  if (
    titleLower.includes("cabrio") ||
    titleLower.includes("cabriyole") ||
    titleLower.includes("convertible")
  )
    return "cabrio";
  if (titleLower.includes("pickup") || titleLower.includes("kamyonet"))
    return "pickup";
  if (
    titleLower.includes("minibüs") ||
    titleLower.includes("minivan") ||
    titleLower.includes("minibus")
  )
    return "minibus";
  if (titleLower.includes("panelvan") || titleLower.includes("van")) return "van";
  return "other";
}

function parseYear(yearText) {
  if (!yearText) return null;
  const match = yearText.match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

function parseKilometer(kmText) {
  if (!kmText) return null;
  const match = kmText.match(/([\d,\.]+)\s*(km|KM|Km)/);
  if (!match) return null;
  const num = match[1].replace(/[^\d]/g, "");
  return parseInt(num, 10);
}

function parseLocation(locationText) {
  if (!locationText) return null;
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
    "Kocaeli",
    "Manisa",
    "Hatay",
    "Balıkesir",
    "Van",
    "Malatya",
    "Elazığ",
    "Sakarya",
    "Trabzon",
    "Erzurum",
    "Denizli",
    "Kahramanmaraş",
    "Ordu",
    "Aydın",
    "Tekirdağ",
    "Edirne",
    "Kırıkkale",
  ];

  for (const city of cities) {
    if (locationText.includes(city)) return city;
  }

  return locationText.split(" ")[0] || null;
}

// ======================================================================
// LEGACY NORMALIZE (ANA MOTOR ARTIĞI) — KULLANMIYORUZ AMA SİLMİYORUZ
// ======================================================================

function normalizeArabamItem(
  rawItem,
  mainCategory = "vehicle_sale",
  adapterName = "arabamAdapter"
) {
  // URL'i normalize et
  let url = normalizeUrl(rawItem.href);

  // Fiyatı normalize et
  let price = rawItem.price || null;
  if (!price && rawItem.priceText) {
    price = parsePriceRaw(rawItem.priceText);
  }

  if (price) {
    if (price < 5000) price = null;
    if (price > 50000000) price = null;
  }

  const brand = rawItem.brand || extractBrandFromTitle(rawItem.title);
  const model = rawItem.model || extractModelFromTitle(rawItem.title);
  const year = rawItem.year ? parseYear(rawItem.year) : null;
  const kilometer = rawItem.km ? parseKilometer(rawItem.km) : null;
  const location = rawItem.location ? parseLocation(rawItem.location) : null;
  const transmission = extractTransmission(rawItem.title);
  const fuelType = extractFuelType(rawItem.title);
  const vehicleType = extractVehicleType(rawItem.title);

  const category = "vehicle_sale";

  const item = {
    id: rawItem.id || buildStableId(url, rawItem.title, "arabam"),
    title: safe(rawItem.title),
    url: url,
    price: price,
    rating: rawItem.rating || null,
    provider: "arabam",
    currency: rawItem.currency || "TRY",
    region: rawItem.region || "TR",
    category: category,
    adapterSource: adapterName,

    commissionRate: rawItem.commissionRate || 0.015,
    commissionMeta: {
      platformRate: 0.015,
      categoryMultiplier:
        finalCategoryMultiplier[category] ||
        finalCategoryMultiplier["vehicle_sale"] ||
        1.0,
      providerTier: "premium",
      source: "arabam",
      isCertified: rawItem.isCertified || false,
      hasWarranty: rawItem.hasWarranty || false,
    },

    providerType: "vehicle_marketplace",
    vertical: "vehicle_sale",
    marketplaceType: "arabam",

    optimizedPrice: rawItem.optimizedPrice || null,
    discountPercentage: rawItem.discountPercentage || null,

    vehicleInfo: {
      brand: brand,
      model: model,
      year: year,
      kilometer: kilometer,
      location: location,
      transmission: transmission,
      fuelType: fuelType,
      vehicleType: vehicleType,
      engine: rawItem.engine || null,
      color: rawItem.color || null,
      horsepower: rawItem.horsepower || null,
      seats: rawItem.seats || null,
      doors: rawItem.doors || null,
      isUsed: year ? new Date().getFullYear() - year > 0 : true,
      isNew: year ? new Date().getFullYear() - year <= 1 : false,
      sellerType: rawItem.sellerType || "private",
      hasServiceHistory: rawItem.hasServiceHistory || false,
      isAccidentFree: rawItem.isAccidentFree || false,
    },

    image: rawItem.imgRaw || null,
    imageVariants: buildImageVariants(rawItem.imgRaw, "arabam"),

    availability: price ? "available" : "unknown",
    stockStatus: price ? "in_stock" : "unknown",

    providerTrust: 0.85,

    raw: rawItem.raw || rawItem,

    score: 0.01,
  };

  return item;
}

// ======================================================================
// LEGACY OPTIMIZE WRAPPER — ARTIK ANA AKIŞTA KULLANMIYORUZ
// ======================================================================

function applyOptimizePrice(item) {
  try {
    const optimized = optimizePrice(item, {
      provider: "arabam",
      region: item.region || "TR",
      category: item.category || "vehicle_sale",
      subCategory: item.vehicleInfo?.vehicleType || "other",
      mode: "vehicle_sale",
      source: item.raw?.source || "scraping",
    });

    if (!optimized.commissionRate) {
      optimized.commissionRate = 0.015;
      optimized.commissionMeta = {
        platformRate: 0.015,
        categoryMultiplier:
          finalCategoryMultiplier[item.category] ||
          finalCategoryMultiplier["vehicle_sale"] ||
          1.0,
        providerTier: "premium",
        source: "arabam_adapter",
      };
    }

    if (item.vehicleInfo && !optimized.vehicleInfo) {
      optimized.vehicleInfo = item.vehicleInfo;
    }

    return optimized;
  } catch (e) {
    console.warn("Arabam optimize hata:", e?.message);
    return item;
  }
}

// ======================================================================
// SCRAPER — S200 RAW PIPELINE İÇİN HAM ITEM’LER
// ======================================================================

async function scrapeArabamPage(query, page = 1, options = {}) {
  const { signal, region = "TR" } = options;
  const limiterKey = `s200:adapter:arabam:page:${page}:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 8,
    windowMs: 60_000,
    burst: false,
    adaptive: true,
  });

  if (!allowed) {
    console.warn("⛔ Arabam PAGE RATE LIMIT tetiklendi:", limiterKey);
    return [];
  }

  try {
    const q = encodeURIComponent(query);
    const url = `https://www.arabam.com/ikinci-el/otomobil?query_text=${q}&take=50&page=${page}`;

    const { data: html } = await axios.get(url, {
      signal,
      timeout: 15000,
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

    const $ = loadCheerioS200(html);
    const rawItems = [];

    const selectors = [
      ".listing-list-item",
      ".searchResultsItem",
      ".vehicle-list-item",
      ".classified-item",
      ".car-listing",
      "tr[data-id]",
      ".table-row",
    ];

    for (const sel of selectors) {
      $(sel).each((i, el) => {
        try {
          const w = $(el);

          const title =
            safe(w.find(".listing-text a").text()) ||
            safe(w.find("h3 a").text()) ||
            safe(w.find(".prdName").text()) ||
            safe(w.find(".vehicle-title").text());

          if (!title || title.length < 5) return;

          const priceText =
            safe(w.find(".listing-price").text()) ||
            safe(w.find(".price").text()) ||
            safe(w.find(".prdPrice").text()) ||
            safe(w.find(".vehicle-price").text());

          const price = parsePriceRaw(priceText);

          let href =
            safe(w.find(".listing-text a").attr("href")) ||
            safe(w.find("h3 a").attr("href")) ||
            safe(w.find("a").attr("href"));
          if (!href) return;

          const imgRaw =
            safe(w.find("img").attr("data-src")) ||
            safe(w.find("img").attr("src")) ||
            safe(w.find(".listing-image img").attr("src")) ||
            null;

          let year = null,
            km = null,
            location = null;

          const detailsContainer = w.find(
            ".listing-info-container, .searchResultsDetail"
          );
          if (detailsContainer.length) {
            const details = [];
            detailsContainer.find(".info, td").each((j, detailEl) => {
              details.push(safe($(detailEl).text()));
            });

            if (details.length >= 3) {
              year = details[0];
              km = details[1];
              location = details[2];
            }
          } else {
            const allText = w.text();
            const yearMatch = allText.match(/(\d{4})\s*model/);
            if (yearMatch) year = yearMatch[1];

            const kmMatch = allText.match(/([\d.,]+)\s*km/);
            if (kmMatch) km = kmMatch[1] + " km";

            const cityMatch = allText.match(
              /(İstanbul|Ankara|İzmir|Bursa|Adana|Antalya|Konya)/
            );
            if (cityMatch) location = cityMatch[1];
          }

          rawItems.push({
            title,
            price,
            priceText,
            href,
            imgRaw,
            km,
            year,
            location,
            raw: {
              html: w.html()?.substring(0, 500) || null,
              extractedAt: new Date().toISOString(),
              source: "scraping",
            },
          });
        } catch (itemError) {
          console.warn("Item parsing error:", itemError.message);
        }
      });

      if (rawItems.length > 0) break;
    }

    return rawItems;
  } catch (err) {
    console.warn("Arabam scrape error:", err.message);
    return [];
  }
}

// ======================================================================
// S200 RAW ADAPTER — ANA FONKSİYON
// ======================================================================

export async function searchArabamAdapterLegacy(query, regionOrOptions = {}) {
  const q = safeStr(query, 220);

  if (!q) return _s200Ok([], { emptyQuery: true });

  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: S200_SOURCE, providerKey: S200_SOURCE, at: S200_AT };
  } catch {}

  const startTime = Date.now();
  const requestId = `arabam_${Date.now()}_${__s200_next().toString(36).slice(2, 9)}`;

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else options = regionOrOptions || {};

  const timeoutMs = Number(options?.timeoutMs || 6500);

  // only vehicle-ish queries (avoid trash)
  if (!isVehicleQuery(q)) {
    return _s200Ok([], { requestId, region, skipped: "not_vehicle_query" });
  }

  // RATE LIMIT (observable)
  const limiterKey = `s200:adapter:arabam:query:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 12,
    windowMs: 60_000,
    burst: true,
    adaptive: true,
  });

  if (!allowed) {
    return _s200Fail("RATE_LIMITED", { requestId, region, rateLimited: true });
  }

  try {
    const rawItems = await withTimeout(
      scrapeArabam(q, { ...options, region }),
      timeoutMs,
      "arabam_scrape"
    );

    const arr = coerceItemsS200(rawItems);

    const seen = new Set();
    const normalized = [];

    for (const it of arr) {
      // ensure contract via kit normalizer
      const n = normalizeItemS200(it, S200_SOURCE, {
        providerFamily: S200_PROVIDER_FAMILY,
        vertical: "vehicle_sale",
        category: "vehicle_sale",
        region,
        requireRealUrlCandidate: true,
      });

      if (!n || !n.id) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      normalized.push(n);
    }

    const duration = Date.now() - startTime;

    // ✅ NO FAKE: no automatic placeholder if empty
    return _s200Ok(normalized, {
      requestId,
      region,
      tookMs: duration,
      rawCount: arr.length,
      empty: normalized.length === 0,
    });
  } catch (err) {
    const duration = Date.now() - startTime;

    // PROD => ok:false empty, DEV => fallback allowed
    if (!FINDALLEASY_ALLOW_STUBS) {
      return _s200Fail(err, { requestId, region, tookMs: duration, timeout: _isTimeoutErr(err) });
    }
    return await arabamFallback(q, "error", { requestId, region, tookMs: duration, timeout: _isTimeoutErr(err) });
  }
}


// ======================================================================
// FALLBACK — S200 için RAW ARRAY
// ======================================================================

async async function arabamFallback(query, reason = "fallback", meta = {}) {
  // ✅ NO FAKE in PROD
  if (!FINDALLEASY_ALLOW_STUBS) {
    return _s200Fail(`FALLBACK_BLOCKED:${reason}`, { stubBlocked: true, ...meta });
  }

  const q = safeStr(query, 120) || "";
  const url = "https://www.arabam.com/";

  const item = normalizeItemS200(
    {
      title: q ? `Arabam — "${q}" için arama` : "Arabam — Araç Arama",
      url,
      price: null,
      currency: "TRY",
      category: "vehicle_sale",
      region: "TR",
      fallback: true,
      raw: { reason },
    },
    S200_SOURCE,
    {
      providerFamily: S200_PROVIDER_FAMILY,
      vertical: "vehicle_sale",
      category: "vehicle_sale",
      region: "TR",
      allowFallbackUrl: true,
      requireRealUrlCandidate: false,
    }
  );

  return _s200Ok(item ? [item] : [], { fallback: true, reason, ...meta });
}


// ======================================================================
// WRAPPERS — Legacy support
// ======================================================================

export async function searchArabam(query, opts = {}) {
  return await searchArabamAdapter(query, opts);
}

export async function searchArabamScrape(query, opts = {}) {
  return await searchArabamAdapter(query, opts);
}

// ======================================================================
// CONFIG EXPORT - ADAPTER REGISTRY İÇİN
// ======================================================================

export const arabamAdapterConfig = {
  name: "arabam",
  fn: searchArabamAdapter,
  timeoutMs: 15000,
  priority: 1.2,
  category: "vehicle_sale",
  subCategories: [
    "used_car",
    "new_car",
    "motorcycle",
    "commercial_vehicle",
    "tractor",
    "construction_vehicle",
  ],
  provider: "arabam",
  commissionRate: 0.015,
  vertical: "vehicle_sale",
  regionSupport: ["TR"],
  metadata: {
    providerType: "vehicle_marketplace",
    hasAffiliate: true,
    hasCertifiedListings: true,
    hasDealerListings: true,
    hasPrivateListings: true,
    trustScore: 8.5,
    marketCoverage: "national",
    listingFreshness: "daily",
  },
  capabilities: {
    supportsApi: false,
    supportsScraping: true,
    supportsImages: true,
    supportsPricing: true,
    supportsVehicleDetails: true,
    supportsLocationFilter: true,
  },
  vehicleCapabilities: {
    supportsBrandFilter: true,
    supportsModelFilter: true,
    supportsYearFilter: true,
    supportsKmFilter: true,
    supportsLocationFilter: true,
    supportsPriceRange: true,
    supportsTransmissionFilter: true,
    supportsFuelFilter: true,
    supportsVehicleTypeFilter: true,
  },
  s10Integration: {
    supportsCommissionEngine: true,
    supportsPriceOptimization: true,
    supportsAffiliateUrls: true,
    supportsUserTracking: true,
  },
};

// ======================================================================
// TEST FUNCTION — Artık S200 RAW FORMAT KONTROLÜ
// ======================================================================

export async function testArabamAdapter() {
  const query = "2015 toyota corolla";
  const region = "TR";

  console.log("🧪 Arabam adapter test başlıyor...");

  try {
    const result = await searchArabamAdapter(query, { region });
    const items = Array.isArray(result)
      ? result
      : result && result.items
      ? result.items
      : [];

    console.log("✅ Test sonucu:", {
      itemCount: items.length,
      sampleItem: items[0]
        ? {
            title: items[0].title?.substring(0, 50),
            price: items[0].price,
            provider: items[0].provider,
            url: items[0].url,
            km: items[0].km,
            year: items[0].year,
            location: items[0].location,
          }
        : null,
    });

    const firstItem = items[0];
    if (firstItem) {
      const requiredFields = ["title", "url", "provider"];
      const missingFields = requiredFields.filter((field) => !firstItem[field]);

      if (missingFields.length === 0) {
        console.log("🎉 Arabam adapter S200 RAW spec ile uyumlu!");
      } else {
        console.warn("⚠️ Eksik alanlar:", missingFields);
      }
    }

    return items;
  } catch (error) {
    console.error("❌ Test başarısız:", error.message);
    throw error;
  }
}

// ======================================================================
// DEFAULT EXPORT
// ======================================================================

export default {
  searchArabam,
  searchArabamAdapter,
  searchArabamScrape,
  arabamAdapterConfig,
  testArabamAdapter,
};

console.log(
  "🚗 ARABAM ADAPTER S200 RAW CLEAN YÜKLENDİ — ANA MOTOR %100 UYUMLU (RAW ARRAY)"
);

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchArabamAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "arabam";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "arabamAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 15000) || 15000;

  try {
    const raw = await withTimeout(Promise.resolve(searchArabamAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "arabam",
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
        category: "vehicle_sale",
        vertical: "vehicle_sale",
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
      source: "arabam",
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
      source: "arabam",
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
