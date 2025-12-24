// server/core/commissionEngineS10.js
// ===================================================================
//   FAE S10.5 → S200 FUSION COMMISSION ENGINE (FULLY COMPATIBLE)
//   - Hiçbir API kırılmadı
//   - Tüm fonksiyon isimleri KORUNDU
//   - S200 adapterEngine ile %100 uyumlu
//   - providerNormalized + priceCandidate uyumu
//   - S200 BEST sıralama kurallarına tam uyum
// ===================================================================

import {
  normalizeProviderKeyS10,
  getProviderInfoS10,
  computeProviderPriorityScore,
  sortByProviderPriority,
} from "./providerMasterS10.js";

import {
  computeCommissionRate,
  platformCommission as BASE_PLATFORM_COMMISSION,
} from "./commissionRates.js";

// ===================================================================
// Statik komisyon oranları (API, isimler, davranış bozulmadı)
// ===================================================================
const STATIC_COMMISSION_RATES = {
  amazon: 0.03,
  trendyol: 0.06,
  hepsiburada: 0.05,
  aliexpress: 0.03,
  booking: 0.12,
  n11: 0.04,
  ciceksepeti: 0.04,
};

// ===================================================================
// Commissionable Providers
// ===================================================================
export const COMMISSIONABLE_PROVIDERS_S10 = [
  "amazon",
  "trendyol",
  "hepsiburada",
  "aliexpress",
  "booking",
  "n11",
  "ciceksepeti",
];

const COMMISSIONABLE_SET = (() => {
  const base = new Set(COMMISSIONABLE_PROVIDERS_S10);
  try {
    Object.entries(BASE_PLATFORM_COMMISSION || {}).forEach(([key, rate]) => {
      if (typeof rate === "number" && rate > 0) base.add(String(key).toLowerCase());
    });
  } catch {}
  return base;
})();

// ===================================================================
// S200 FUSION BOOST LAYER #1 – Micro behavior
// ===================================================================
function fuseMicroBehavior(providerKey, categoryKey, userClicks, memoryProfile) {
  try {
    const ps = memoryProfile?.priceSensitivity;
    const pa = memoryProfile?.providerAffinity?.[providerKey] || 0;
    const momentum = Math.min(userClicks / 5, 0.10);

    let score = 0;

    if (typeof ps === "number" && ps < 1.0) score += 0.015;
    if (typeof ps === "number" && ps > 1.15) score -= 0.008;

    score += pa * 0.05;
    score += momentum;

    return score;
  } catch {
    return 0;
  }
}

// ===================================================================
// Trust Resonance (CTR)
// ===================================================================
function commissionTrustResonance(providerKey, baseRate) {
  try {
    const info = getProviderInfoS10(providerKey) || {};
    const trust = info.trust ?? 0.5;
    const res = baseRate * trust * 0.6;
    return Math.min(res, 0.04);
  } catch {
    return 0;
  }
}

// ===================================================================
// Price-to-Rate Harmony
// ===================================================================
function priceRateHarmony(basePrice, rate) {
  try {
    if (!basePrice || basePrice <= 0) return 0;

    if (basePrice < 150 && rate > 0.08) return 0.01;
    if (basePrice > 5000 && rate > 0.10) return -0.015;

    return 0;
  } catch {
    return 0;
  }
}

// ===================================================================
// S200 UYUMLU COMMISSION RATE
// ===================================================================
export function getCommissionRateS10(rawProvider, options = {}) {
  const key = normalizeProviderKeyS10(rawProvider);
  if (!key || key === "unknown") return 0;

  const providerKey = key;
  const categoryKey = (options.category || options.categoryKey || "unknown").toLowerCase();
  const priceCandidate = options._priceCandidate || 0;

  const userClicks = Number(options.userClicks || 0);
  const memoryProfile = options.memoryProfile || null;

  // Dynamic commission (S13)
  let dynamic = 0;
  try {
    dynamic = computeCommissionRate(providerKey, categoryKey, userClicks, memoryProfile);
  } catch {}

  // Static fallback
  const staticRate =
    STATIC_COMMISSION_RATES[providerKey] ??
    BASE_PLATFORM_COMMISSION?.[providerKey] ??
    (getProviderInfoS10(providerKey)?.commissionable ? 0.01 : 0);

  let finalRate = dynamic > 0 ? dynamic : staticRate;

  // Fusion Layers
  finalRate += fuseMicroBehavior(providerKey, categoryKey, userClicks, memoryProfile);
  finalRate += commissionTrustResonance(providerKey, finalRate);
  finalRate += priceRateHarmony(priceCandidate, finalRate);

  if (!Number.isFinite(finalRate) || finalRate <= 0) return 0;
  return Math.min(finalRate, 0.45);
}

// ===================================================================
// Order commission check
// ===================================================================
export function isCommissionableOrderS10(order, options = {}) {
  if (!order) return false;

  const key = normalizeProviderKeyS10(order.provider || order.shop);
  if (!key) return false;

  const providerKey = key.toLowerCase();
  if (!COMMISSIONABLE_SET.has(providerKey)) return false;
  if (order.isCommissioned === false) return false;

  const rate = getCommissionRateS10(providerKey, {
    category: order.category || order.intentType || "unknown",
    userClicks: options.userClicks || 0,
    memoryProfile: options.memoryProfile || null,
  });

  return rate > 0;
}

// ===================================================================
// Ürüne commissionMeta ekle – S200 FULL SUPPORT
// ===================================================================
export function attachCommissionMetaS10(item, options = {}) {
  if (!item) return item;

  const providerKey =
    item.providerNormalized ||
    normalizeProviderKeyS10(item.provider || item.source);

  const categoryKey =
    item.category ||
    item.intentType ||
    options.category ||
    "unknown";

  const priceCandidate =
    Number(item.finalUserPrice) ||
    Number(item.optimizedPrice) ||
    Number(item.price) ||
    0;

  const rate = getCommissionRateS10(providerKey, {
    category: categoryKey,
    userClicks: options.userClicks || 0,
    memoryProfile: options.memoryProfile || null,
    _priceCandidate: priceCandidate,
  });

  const info = getProviderInfoS10(providerKey) || {};

  const potentialReward =
    priceCandidate > 0 && rate > 0
      ? Math.round(priceCandidate * rate * 100) / 100
      : 0;

  return {
    ...item,
    commissionMeta: {
      ...(item.commissionMeta || {}),
      providerKey,
      commissionRate: rate,
      commissionable: rate > 0,
      potentialReward,
      providerTrust: info.trust ?? 0.5,
      providerName: info.name || providerKey,
      platformBaseRate: BASE_PLATFORM_COMMISSION?.[providerKey] ?? 0,
    },
  };
}

// ===================================================================
// S200 BEST motoru sıralama uyumu
// ===================================================================
export function rankItemsByCommissionAndProviderS10(items, options = {}) {
  if (!Array.isArray(items)) return [];

  const enriched = items.map((x) => attachCommissionMetaS10(x, options));

  return enriched.sort((a, b) => {
    const A = a.commissionMeta || {};
    const B = b.commissionMeta || {};

    // Önce commissionable
    if (A.commissionable !== B.commissionable)
      return Number(B.commissionable) - Number(A.commissionable);

    // Sonra rate
    if (A.commissionRate !== B.commissionRate)
      return Number(B.commissionRate) - Number(A.commissionRate);

    // Provider priority
    const pa = computeProviderPriorityScore(a);
    const pb = computeProviderPriorityScore(b);
    if (pa !== pb) return pb - pa;

    // Son olarak fiyat
    const priceA =
      Number(a.finalUserPrice) ||
      Number(a.optimizedPrice) ||
      Number(a.price) ||
      Infinity;

    const priceB =
      Number(b.finalUserPrice) ||
      Number(b.optimizedPrice) ||
      Number(b.price) ||
      Infinity;

    return priceA - priceB;
  });
}

// ===================================================================
// Provider Priority
// ===================================================================
export const providerPriorityS10 = (() => {
  const all = new Set([
    ...Object.keys(STATIC_COMMISSION_RATES),
    ...Object.keys(BASE_PLATFORM_COMMISSION || {}),
  ]);

  const scored = Array.from(all).map((key) => {
    const k = key.toLowerCase();
    const rate =
      STATIC_COMMISSION_RATES[k] ?? BASE_PLATFORM_COMMISSION?.[k] ?? 0;

    const info = getProviderInfoS10(k) || {};
    const trust = info.trust ?? 0.5;

    return {
      key: k,
      score: rate * 0.7 + trust * 0.3,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.map((x) => x.key);
})();

export default {
  COMMISSIONABLE_PROVIDERS_S10,
  getCommissionRateS10,
  isCommissionableOrderS10,
  attachCommissionMetaS10,
  rankItemsByCommissionAndProviderS10,
  providerPriorityS10,
  normalizeProviderKeyS10,
  getProviderInfoS10,
  sortByProviderPriority,
  computeProviderPriorityScore,
};
