// server/adapters/index.js
// ======================================================================
//  CORE INDEX — S40 ULTRA CLEAN TITAN VERSION
//  ZERO-CONFLICT · ZERO-DUPLICATE · ESM SAFE
// ======================================================================

// ------------------------------------------------------------
// ADAPTER IMPORTS
// ------------------------------------------------------------
import { searchWithSerpApi } from "./serpApi.js";
import { searchBarcode } from "./barcode.js";

import { searchGoogleShopping } from "./googleShopping.js";
import { searchGooglePlaces } from "./googlePlaces.js";
import { searchGooglePlacesDetails } from "./googlePlacesDetails.js";
import { searchWithOpenStreetMap } from "./openStreetMap.js";

import {
  searchOpenFoodFacts,
  searchWithOpenFoodFacts,
} from "./openFoodFacts.js";

import { searchTrendyol } from "./trendyol.js";
import {
  searchTrendyolScrape,
  searchTrendyolAdapter,
} from "./trendyolScraper.js";

import { searchHepsiburada } from "./hepsiburada.js";
import {
  searchHepsiScrape,
  searchHepsiburadaAdapter,
} from "./hepsiburadaScraper.js";

import { searchBooking } from "./booking.js";
import { searchSkyscanner } from "./skyscanner.js";

// S33+ yeni adapterler (fashion, travel, education vb.)
import { searchInStreetAdapter } from "./instreetAdapter.js";
import { searchKoton } from "./kotonAdapter.js";
import { searchJollyTur } from "./jollyAdapter.js";
import { searchKariyerEgitim } from "./kariyerEgitimAdapter.js";

// ------------------------------------------------------------
// CORE IMPORTS
// ------------------------------------------------------------
import { runAdapters } from "../core/adapterEngine.js";
import { detectIntent } from "../core/intentEngine.js";
import { computeDynamicProviderPriority } from "../core/dynamicProviderPriority.js";
import { safeComputeFinalUserPrice } from "../core/priceEngine.js";
import { decorateWithBadges } from "../core/badgeEngine.js";
import { buildMemoryProfile } from "../core/aiPipeline.js";
import { relatedMap } from "../core/relatedMap.js";

// ======================================================================
// PROVIDER KEY NORMALIZER
// ======================================================================
function normalizeProviderKey(p) {
  return String(p || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

// ======================================================================
// BASE ADAPTER MAP (S40) — S12.9 uyumlu, genişletilmiş
// ======================================================================
const BASE_ADAPTER_MAP = {
  product: [
    searchBarcode,
    searchOpenFoodFacts,
    searchWithOpenFoodFacts,
    searchGoogleShopping,
    searchTrendyol,
    searchTrendyolScrape,
    searchTrendyolAdapter,
    searchHepsiburada,
    searchHepsiScrape,
    searchHepsiburadaAdapter,
    searchKoton,
    searchInStreetAdapter,
  ],

  hotel: [
    searchBooking,
    searchWithSerpApi,
    searchGooglePlaces,
    searchGooglePlacesDetails,
    searchWithOpenStreetMap,
    searchSkyscanner,
    searchJollyTur,
  ],

  flight: [searchSkyscanner, searchWithSerpApi, searchGoogleShopping],

  location: [
    searchGooglePlaces,
    searchGooglePlacesDetails,
    searchWithOpenStreetMap,
  ],

  food: [
    searchOpenFoodFacts,
    searchWithOpenFoodFacts,
    searchGoogleShopping,
    searchHepsiburada,
    searchTrendyol,
  ],

  tour: [
    searchGooglePlaces,
    searchGooglePlacesDetails,
    searchWithOpenStreetMap,
    searchWithSerpApi,
    searchJollyTur,
  ],

  // fashion vertical — intentEngine desteklerse hazır
  fashion: [
    searchTrendyolAdapter ?? searchTrendyolScrape ?? searchTrendyol,
    searchHepsiburadaAdapter ?? searchHepsiScrape ?? searchHepsiburada,
    searchKoton,
    searchInStreetAdapter,
  ],

  // education vertical — Kariyer Eğitim
  education: [searchKariyerEgitim],

  general: [
    searchWithSerpApi,
    searchGoogleShopping,
    searchGooglePlaces,
    searchWithOpenStreetMap,
    searchTrendyol,
    searchHepsiburada,
  ],
};

// ======================================================================
// PROVIDER → ADAPTER MAP (S40 Affiliate Engine uyumlu)
// ======================================================================
const PROVIDER_ADAPTER_MAP = {
  // product / fashion
  trendyol: searchTrendyolAdapter ?? searchTrendyolScrape ?? searchTrendyol,
  ty: searchTrendyolAdapter ?? searchTrendyolScrape ?? searchTrendyol,

  hepsiburada:
    searchHepsiburadaAdapter ?? searchHepsiScrape ?? searchHepsiburada,
  hb: searchHepsiburadaAdapter ?? searchHepsiScrape ?? searchHepsiburada,

  koton: searchKoton,
  instreet: searchInStreetAdapter,

  // travel
  jolly: searchJollyTur,
  jollytur: searchJollyTur,
  booking: searchBooking,

  // education
  kariyer: searchKariyerEgitim,
  "kariyer-egitim": searchKariyerEgitim,
};

export function getAdapterForProvider(providerKey = "") {
  const key = normalizeProviderKey(providerKey);
  return PROVIDER_ADAPTER_MAP[key] || null;
}

// ======================================================================
// DETECTORS (S12.9 KEEP)
// ======================================================================
function isBarcode(q) {
  return /^\d{8,14}$/.test(String(q || "").trim());
}

function isProductLink(q) {
  if (!q) return false;
  const s = q.toLowerCase();
  return (
    s.includes("trendyol.com") ||
    s.includes("hepsiburada.com") ||
    s.includes("instreet.com.tr") ||
    s.includes("koton.com") ||
    s.includes("amazon.") ||
    s.includes("n11.com") ||
    s.includes("ciceksepeti.com")
  );
}

// ======================================================================
// PRODUCT LINK → DOĞRU ADAPTER (S40 SAFE ROUTER)
// ======================================================================
function getAdaptersForProductLink(query) {
  const s = String(query || "").toLowerCase();

  if (s.includes("trendyol.com")) {
    return [
      searchTrendyolAdapter ?? searchTrendyolScrape ?? searchTrendyol,
    ];
  }

  if (s.includes("hepsiburada.com")) {
    return [
      searchHepsiburadaAdapter ?? searchHepsiScrape ?? searchHepsiburada,
    ];
  }

  if (s.includes("instreet.com.tr")) {
    return [searchInStreetAdapter];
  }

  if (s.includes("koton.com")) {
    return [searchKoton];
  }

  // Diğer domainler için eski davranış — tüm product adapter seti
  return BASE_ADAPTER_MAP.product;
}

// ======================================================================
// QUERY VECTOR SIMILARITY (S40 tuned)
// ======================================================================
function semanticMatch(query, adapterName) {
  try {
    const q = String(query || "").toLowerCase();
    const a = String(adapterName || "").toLowerCase();
    if (!q) return 0;

    let score = 0;

    // hotel / travel
    if (q.includes("otel") || q.includes("hotel") || q.includes("resort")) {
      if (a.includes("booking")) score += 0.30;
      if (a.includes("jolly")) score += 0.20;
      if (a.includes("skyscanner")) score += 0.10;
    }

    // uçak / bilet
    if (q.includes("uçak") || q.includes("flight") || q.includes("bilet")) {
      if (a.includes("skyscanner")) score += 0.35;
    }

    // telefon / elektronik
    if (
      q.includes("telefon") ||
      q.includes("iphone") ||
      q.includes("samsung") ||
      q.includes("xiaomi")
    ) {
      if (a.includes("trendyol") || a.includes("hepsi")) score += 0.25;
    }

    // gıda / market
    if (q.includes("market") || q.includes("gıda") || q.includes("yemek")) {
      if (a.includes("openfood") || a.includes("googleplaces")) score += 0.20;
    }

    // moda / ayakkabı / giyim
    if (
      q.includes("ayakkabı") ||
      q.includes("sneaker") ||
      q.includes("bot") ||
      q.includes("kaban") ||
      q.includes("mont") ||
      q.includes("elbise") ||
      q.includes("tshirt") ||
      q.includes("t-shirt")
    ) {
      if (a.includes("koton") || a.includes("instreet")) score += 0.30;
      if (a.includes("trendyol") || a.includes("hepsi")) score += 0.20;
    }

    // eğitim / kurs
    if (q.includes("kurs") || q.includes("eğitim") || q.includes("sertifika")) {
      if (a.includes("kariyer")) score += 0.35;
    }

    return score;
  } catch {
    return 0;
  }
}

// ======================================================================
// COMMISSION SHIFT (S40 genişletilmiş)
// ======================================================================
function commissionShift(name) {
  const s = name.toLowerCase();

  if (s.includes("trendyol")) return 0.08;
  if (s.includes("hepsi")) return 0.08;

  if (s.includes("koton")) return 0.06;
  if (s.includes("instreet")) return 0.06;

  if (s.includes("booking")) return 0.05;
  if (s.includes("jolly")) return 0.05;

  if (s.includes("amazon")) return 0.04;
  if (s.includes("n11")) return 0.04;

  return 0;
}

// ======================================================================
// PROVIDER AFFINITY
// ======================================================================
function providerAffinity(name, memoryProfile = {}) {
  try {
    const t = (memoryProfile.topProvider || "").toLowerCase();
    if (!t) return 0;
    return name.toLowerCase().includes(t) ? 0.12 : 0;
  } catch {
    return 0;
  }
}

// ======================================================================
// PROVIDER PRIORITY BOOST
// ======================================================================
function providerPriorityBoost(adapterName, userMemory = null) {
  try {
    const key = adapterName
      .replace("search", "")
      .replace("adapter", "")
      .replace("scrape", "")
      .replace(/[^\w]/g, "")
      .toLowerCase();

    const score = computeDynamicProviderPriority(key, userMemory);
    return score ? score * 0.15 : 0;
  } catch {
    return 0;
  }
}

// ======================================================================
// CATEGORY BOOST (intent + adapterName bazlı)
// ======================================================================
function categoryBoost(intent, adapterName) {
  const a = adapterName.toLowerCase();

  const map = {
    product: ["trendyol", "hepsi", "n11", "google-shopping", "koton", "instreet"],
    hotel: ["booking", "googleplaces", "jolly"],
    flight: ["skyscanner"],
    food: ["openfood", "googleplaces"],
    tour: ["googleplaces", "osm", "serp", "jolly"],
    location: ["googleplaces", "osm"],

    fashion: ["koton", "instreet", "trendyol", "hepsi"],
    education: ["kariyer"],
  };

  const arr = map[intent] || [];
  return arr.some((x) => a.includes(x)) ? 0.12 : 0;
}

// ======================================================================
// S12.9 → S40 — SMART ROUTER (GÜÇLENDİRİLMİŞ)
// ======================================================================
export function searchAdapters(intent = "general", opts = {}) {
  const {
    query = "",
    memoryProfile = {},
    confidence = 0.5,
    userMemory = null,
  } = opts;

  if (isBarcode(query)) return [searchBarcode];

  if (isProductLink(query)) {
    return getAdaptersForProductLink(query);
  }

  let adapters = BASE_ADAPTER_MAP[intent] || BASE_ADAPTER_MAP.general;

  const confFactor = confidence < 0.6 ? 0.85 : 1.15;

  adapters = [...adapters].sort((a, b) => {
    const A = a.name.toLowerCase();
    const B = b.name.toLowerCase();

    let sa = 1,
      sb = 1;

    sa += commissionShift(A);
    sb += commissionShift(B);

    sa += providerAffinity(A, memoryProfile);
    sb += providerAffinity(B, memoryProfile);

    sa += providerPriorityBoost(A, userMemory);
    sb += providerPriorityBoost(B, userMemory);

    sa += categoryBoost(intent, A);
    sb += categoryBoost(intent, B);

    sa += semanticMatch(query, A);
    sb += semanticMatch(query, B);

    sa *= confFactor;
    sb *= confFactor;

    return sb - sa;
  });

  return adapters;
}

// ======================================================================
// EXPORTS
// ======================================================================
export {
  searchWithSerpApi,
  searchBarcode,
  searchGoogleShopping,
  searchGooglePlaces,
  searchGooglePlacesDetails,
  searchWithOpenStreetMap,
  searchOpenFoodFacts,
  searchWithOpenFoodFacts,
  searchTrendyol,
  searchTrendyolScrape,
  searchTrendyolAdapter,
  searchHepsiburada,
  searchHepsiScrape,
  searchHepsiburadaAdapter,
  searchBooking,
  searchSkyscanner,

  // yeni adapter exports
  searchInStreetAdapter,
  searchKoton,
  searchJollyTur,
  searchKariyerEgitim,

  runAdapters,
  detectIntent,
  computeDynamicProviderPriority,
  safeComputeFinalUserPrice,
  decorateWithBadges,
  buildMemoryProfile,
  relatedMap,
  
};
// ======================================================================
// DEFAULT EXPORT (HUB)
// ======================================================================
const AdaptersHubS40 = {
  searchWithSerpApi,
  searchBarcode,
  searchGoogleShopping,
  searchGooglePlaces,
  searchGooglePlacesDetails,
  searchWithOpenStreetMap,
  searchOpenFoodFacts,
  searchWithOpenFoodFacts,
  searchTrendyol,
  searchTrendyolScrape,
  searchTrendyolAdapter,
  searchHepsiburada,
  searchHepsiScrape,
  searchHepsiburadaAdapter,
  searchBooking,
  searchSkyscanner,

  // S33+ adapterler
  searchInStreetAdapter,
  searchKoton,
  searchJollyTur,
  searchKariyerEgitim,

  runAdapters,
  detectIntent,
  computeDynamicProviderPriority,
  safeComputeFinalUserPrice,
  decorateWithBadges,
  buildMemoryProfile,
  relatedMap,
 
};

export default AdaptersHubS40;
