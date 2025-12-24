// server/core/providerMasterS12.js
// ============================================================================
//   providerMasterS12.js — S15 ULTRA OMEGA EDITION (FINAL)
//   Zero-Failure Provider Brain
//   • Domain Intelligence
//   • Commission Shield
//   • Trust Engine
//   • RevenueMemory Fusion
//   • NeuroScore Boost
//   • DynamicProviderPriority (S11)
//   • S12 backward compatibility
//   • S15 Total Priority Brain
// ============================================================================

// Revenue Memory import — trendScore + neuroScore entegrasyonu
import { getProviderRevenueStats } from "./revenueMemoryEngine.js";

// S11 Dynamic Learning (kullanıcı tıklama tabanlı öğrenme)
import { getLearnedProviderPriority } from "./dynamicProviderPriority.js";

// ============================================================================
// PROVIDER DATABASE — S12 EXPANDED
// (Mevcut tablo SİLİNMİYOR — S15 brain yalnızca güçlendirir)
// ============================================================================
// NOT: "booking" double-definition bug'ı temizlendi. (JS'de alttaki üsttekini ezerdi.)
const PROVIDER_DB = {
  amazon: {
    key: "amazon",
    name: "Amazon",
    commission: true,
    trust: 0.98,
    family: "commerce",
    domains: ["amazon.com", "amazon.com.tr", "amzn.to"],
  },

  trendyol: {
    key: "trendyol",
    name: "Trendyol",
    commission: true,
    trust: 0.94,
    family: "commerce",
    domains: ["trendyol.com", "ty.gl"],
  },

  hepsiburada: {
    key: "hepsiburada",
    name: "Hepsiburada",
    commission: true,
    trust: 0.92,
    family: "commerce",
    domains: ["hepsiburada.com", "hb.gg"],
  },

  aliexpress: {
    key: "aliexpress",
    name: "Aliexpress",
    commission: true,
    trust: 0.85,
    family: "commerce",
    domains: ["aliexpress.com"],
  },

  n11: {
    key: "n11",
    name: "N11",
    commission: true,
    trust: 0.88,
    family: "commerce",
    domains: ["n11.com"],
  },

  ciceksepeti: {
    key: "ciceksepeti",
    name: "Çiçeksepeti",
    commission: true,
    trust: 0.89,
    family: "commerce",
    domains: ["ciceksepeti.com"],
  },

  // Travel
  booking: {
    key: "booking",
    name: "Booking",
    commission: true,
    trust: 0.9,
    family: "travel",
    domains: ["booking.com"],
  },

  skyscanner: {
    key: "skyscanner",
    name: "Skyscanner",
    commission: false,
    trust: 0.86,
    family: "travel",
    domains: ["skyscanner."],
  },

  tour: {
    key: "tour",
    name: "Tur",
    commission: false,
    trust: 0.72,
    family: "travel",
    domains: [],
  },

  // Quick commerce
  getir: {
    key: "getir",
    name: "Getir",
    commission: true,
    trust: 0.86,
    family: "commerce",
    domains: ["getir.com"],
  },

  // Fashion
  zalando: {
    key: "zalando",
    name: "Zalando",
    commission: true,
    trust: 0.82,
    family: "fashion",
    domains: ["zalando."],
  },
  shein: {
    key: "shein",
    name: "SHEIN",
    commission: true,
    trust: 0.78,
    family: "fashion",
    domains: ["shein."],
  },

  // Estate
  sahibinden: {
    key: "sahibinden",
    name: "Sahibinden",
    commission: false,
    trust: 0.84,
    family: "estate",
    domains: ["sahibinden.com"],
  },
  emlakjet: {
    key: "emlakjet",
    name: "Emlakjet",
    commission: false,
    trust: 0.82,
    family: "estate",
    domains: ["emlakjet.com"],
  },

  // Internal / fallback providers (S200)
  serpapi: {
    key: "serpapi",
    name: "SerpAPI",
    commission: false,
    trust: 0.72,
    family: "search",
    domains: [],
  },
  googleshopping: {
    key: "googleshopping",
    name: "Google Shopping",
    commission: false,
    trust: 0.76,
    family: "search",
    domains: ["shopping.google."],
  },
  googleplaces: {
    key: "googleplaces",
    name: "Google Places",
    commission: false,
    trust: 0.78,
    family: "maps",
    domains: ["google.com", "goo.gl", "maps.google."],
  },
  openstreetmap: {
    key: "openstreetmap",
    name: "OpenStreetMap",
    commission: false,
    trust: 0.74,
    family: "maps",
    domains: ["openstreetmap.org"],
  },
  barcode: {
    key: "barcode",
    name: "Barcode",
    commission: false,
    trust: 0.7,
    family: "utility",
    domains: [],
  },

  // Service / misc
  lawyer: {
    key: "lawyer",
    name: "Avukat",
    commission: false,
    trust: 0.7,
    family: "service",
    domains: [],
  },
  market: {
    key: "market",
    name: "Market",
    commission: false,
    trust: 0.7,
    family: "commerce",
    domains: [],
  },
  event: {
    key: "event",
    name: "Etkinlik",
    commission: false,
    trust: 0.72,
    family: "event",
    domains: [],
  },
  office: {
    key: "office",
    name: "Ofis",
    commission: false,
    trust: 0.72,
    family: "service",
    domains: [],
  },
  spa: {
    key: "spa",
    name: "Spa",
    commission: false,
    trust: 0.72,
    family: "service",
    domains: [],
  },
  vehiclesale: {
    key: "vehiclesale",
    name: "Araç İlan",
    commission: false,
    trust: 0.72,
    family: "vehicle",
    domains: [],
  },

  unknown: {
    key: "unknown",
    name: "Unknown",
    commission: false,
    trust: 0.4,
    family: "unknown",
    domains: [],
  },
};

// ============================================================================
// CLEAN DOMAIN HELPER — S12
// ============================================================================
function extractDomain(input) {
  if (!input) return "";

  let url = String(input).trim().toLowerCase();

  try {
    if (url.startsWith("http")) {
      const u = new URL(url);
      url = u.hostname;
    }
  } catch {
    // URL parse patlarsa raw string ile devam
  }

  return url.replace(/^www\./, "").trim();
}

// ============================================================================
// PROVIDER NORMALIZE (domain → provider key)
// ============================================================================
export function normalizeProviderKeyS12(input) {
  // direct key / object destekle (S200 wrapper bunu çok kullanıyor)
  try {
    if (input && typeof input === "object") {
      if (typeof input.provider === "string") input = input.provider;
      else if (typeof input.providerKey === "string") input = input.providerKey;
      else if (typeof input.url === "string") input = input.url;
      else if (typeof input.originUrl === "string") input = input.originUrl;
    }
  } catch {}

  const raw = String(input || "").trim().toLowerCase();
  if (raw && PROVIDER_DB[raw]) return raw;

  const dom = extractDomain(raw);
  if (!dom) return "unknown";

  for (const p of Object.values(PROVIDER_DB)) {
    const list = Array.isArray(p?.domains) ? p.domains : [];
    for (const d of list) {
      if (d && dom.includes(String(d).toLowerCase())) return p.key;
    }
  }

  return "unknown";
}

// Backward compatibility alias
export const normalizeProviderKeyS10 = normalizeProviderKeyS12;

// ============================================================================
// Provider Info (S12 enriched)
// ============================================================================
export function getProviderFamilyS12(provider) {
  const info = getProviderInfoS12(provider);
  return info?.family || "mixed";
}

export function getProviderDisplayNameS12(provider) {
  const info = getProviderInfoS12(provider);
  return info?.name || String(provider || "Unknown");
}

export function getProviderInfoS12(provider) {
  const key = normalizeProviderKeyS12(provider);
  return PROVIDER_DB[key] || PROVIDER_DB.unknown;
}

export const getProviderInfoS10 = getProviderInfoS12;

// ============================================================================
// S12 PRIORITY SCORE (5 Katmanlı)
// trust + rating + commission + price + neuroScore
// ============================================================================
export async function computeProviderPriorityScore(item) {
  const pInfo = getProviderInfoS12(item?.provider);
  const baseTrust = pInfo.trust ?? 0.5;

  // 1 — Rating Score
  const ratingScore = Number(item?.rating || 0) / 5;

  // 2 — Commission Bonus
  const commissionBonus = pInfo.commission ? 0.5 : 0;

  // 3 — Price Score (S12 normalize)
  const priceBase = item?.finalPrice ?? item?.optimizedPrice ?? item?.price ?? null;
  const priceScore = priceBase ? 1 / Math.max(1, Number(priceBase)) : 0;

  // 4 — RevenueMemory Neuro Score (trend + conversion + freshness)
  let neuroScore = 0;
  try {
    const stats = await getProviderRevenueStats(pInfo.key);
    neuroScore = stats?.neuroScore || 0;
  } catch {
    neuroScore = 0;
  }

  // 5 — Fraud Shield
  const fraudPenalty = pInfo.key === "unknown" ? -0.2 : 0;

  const score =
    baseTrust * 0.35 +
    ratingScore * 0.15 +
    commissionBonus * 0.25 +
    priceScore * 0.10 +
    neuroScore * 0.15 +
    fraudPenalty;

  return score;
}

export const computeProviderPriorityScoreS10 = computeProviderPriorityScore;

// ============================================================================
// Sort by Priority — S12 async (neuroScore fetch required)
// ============================================================================
export async function sortByProviderPriority(items) {
  if (!Array.isArray(items)) return [];

  const scored = await Promise.all(
    items.map(async (i) => ({
      ...i,
      __score: await computeProviderPriorityScore(i),
    }))
  );

  return scored.sort((a, b) => (b.__score || 0) - (a.__score || 0));
}

export const sortByProviderPriorityS10 = sortByProviderPriority;

// ============================================================================
// S15 UPGRADE — TOTAL PROVIDER SCORE (FINAL)
// ============================================================================
export async function computeProviderTotalScoreS15(item) {
  const pInfo = getProviderInfoS12(item?.provider);
  const baseScore = await computeProviderPriorityScore(item);

  // S11 Dynamic Click Learning
  let dynamicBoost = 0;
  try {
    const learned = getLearnedProviderPriority() || {};
    const level = learned[pInfo.key] ?? 0; // 0..5
    dynamicBoost = Math.min(1, Math.max(0, level / 5));
  } catch {
    dynamicBoost = 0;
  }

  const trustBonus = (pInfo.trust || 0) * 0.05;
  const commissionBoost = pInfo.commission ? 0.08 : 0;

  const final =
    baseScore * 0.65 +
    dynamicBoost * 0.20 +
    trustBonus * 0.10 +
    commissionBoost * 0.05;

  return Math.min(1, Math.max(0, Number(final.toFixed(6))));
}

// ============================================================================
// S15 Sorting (FINAL)
// ============================================================================
export async function sortByProviderPriorityS15(items) {
  if (!Array.isArray(items)) return [];

  const scored = await Promise.all(
    items.map(async (i) => ({
      ...i,
      __providerScoreS15: await computeProviderTotalScoreS15(i),
    }))
  );

  return scored.sort((a, b) => (b.__providerScoreS15 || 0) - (a.__providerScoreS15 || 0));
}

// ============================================================================
// DEFAULT EXPORT — Full S10/S12/S15 Compatibility
// ============================================================================
export default {
  normalizeProviderKeyS12,
  normalizeProviderKeyS10,
  getProviderInfoS12,
  getProviderInfoS10,
  getProviderFamilyS12,
  getProviderDisplayNameS12,
  computeProviderPriorityScore,
  computeProviderPriorityScoreS10,
  sortByProviderPriority,
  sortByProviderPriorityS10,
  computeProviderTotalScoreS15,
  sortByProviderPriorityS15,
};
