// server/core/commissionEngine.js
// ======================================================================
//  FAE COMMISSION ENGINE — S16 → S200 SUPRACONDUCTOR EDITION
//  S200 AdapterEngine ile tamamen uyumlu FINAL sürüm
//  - Zero-Delete: Tüm eski fonksiyon isimleri duruyor
//  - S200 BEST pipeline ile birebir uyumlu
//  - providerPriority → S200 scoring formatı ile eşleşti
//  - decorateResultsWithCommission → idempotent, null-safe
//  - price'a dokunmaz, sadece meta yazar
// ======================================================================

import {
  platformCommission,
  categoryMultiplier,
  finalPlatformCommission,
  finalCategoryMultiplier,
  timeFactor as timeFactorS12,
  seasonalFactor as seasonalFactorS12,
  behaviorFactor as behaviorFactorS12,
  computeCommissionRate,
} from "./commissionRates.js";

import crypto from "crypto";

import { getProviderRevenueStats } from "./revenueMemoryEngine.js";
import {
  getProviderCommissionRateS9,
  getProviderTrustScoreS9,
  getProviderRankingWeightS9,
} from "./providerMasterS9.js";

import {
  computeDynamicProviderPriority,
  getAllProviderPriorities,
} from "./dynamicProviderPriority.js";

// ================================================================
// MICRO-CACHE — S200 SAFE
// ================================================================
const cache = new WeakMap();

function computeHash(obj) {
  try {
    return crypto
      .createHash("md5")
      .update(JSON.stringify(obj))
      .digest("hex");
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

// ================================================================
// SAFE HELPERS
// ================================================================
function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(v, fallback = "") {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  return String(v);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function normalizeProviderKey(providerRaw) {
  const p = safeString(providerRaw, "unknown")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/^www\./, "")
    .replace(/scraper|adapter|client|engine/g, "")
    .replace(/\.com(\.tr)?|\.net|\.org|\.io|\.co/g, "")
    .trim();
  return p || "unknown";
}

function normalizeCategoryKey(catRaw) {
  const c = safeString(catRaw, "unknown").toLowerCase().trim();
  return c || "unknown";
}

// ================================================================
// S9 unified score (legacy — S200 BEST bunu hâlâ okuyor)
// ================================================================
function getCommissionScoreS9(provider, price) {
  const rate = getProviderCommissionRateS9(provider);
  const trust = getProviderTrustScoreS9(provider);
  const weight = getProviderRankingWeightS9(provider);
  return Math.round(rate * trust * weight * 10000) / 100;
}

// ================================================================
// BASE + CATEGORY
// ================================================================
function computeBasePlatformRate(providerKeyRaw) {
  const key = normalizeProviderKey(providerKeyRaw);
  let rate = finalPlatformCommission?.[key];

  if (typeof rate !== "number") rate = platformCommission?.[key];
  if (typeof rate !== "number")
    rate =
      finalPlatformCommission?.unknown ??
      platformCommission?.unknown ??
      0.04;

  return clamp(safeNumber(rate, 0.04), 0, 0.25);
}

function computeCategoryMultiplier(catKeyRaw) {
  const key = normalizeCategoryKey(catKeyRaw);

  let mul = finalCategoryMultiplier?.[key];
  if (typeof mul !== "number") mul = categoryMultiplier?.[key];
  if (typeof mul !== "number")
    mul =
      finalCategoryMultiplier?.unknown ??
      categoryMultiplier?.unknown ??
      1;

  return clamp(safeNumber(mul, 1), 0.4, 1.8);
}

// ================================================================
// POLICY BOOST — S200 için optimize edildi
// ================================================================
export function providerPolicyBoost(provider) {
  try {
    const p = normalizeProviderKey(provider);
    const stats = getProviderRevenueStats(p);
    if (!stats) return 0;

    const conv = stats.conversionRate || 0;
    const revenue = stats.totalRevenue || 0;
    const risk = stats.riskScore || 0;
    const orders = stats.totalOrders || 0;
    const volatility = stats.volatility || 0;
    const daysActive = stats.daysActive || 0;

    const convBoost = Math.min(0.05, conv * 0.55);
    const revenueBoost = Math.min(0.07, revenue / 7000);
    const ltvBoost = Math.min(0.05, orders / 350);
    const drift =
      daysActive > 0 ? Math.min(0.04, (revenue / (daysActive + 5)) / 2000) : 0;

    const volPenalty = Math.min(0.1, volatility * 0.12);
    const riskPenalty = Math.min(0.1, risk * 0.13);

    return convBoost + revenueBoost + ltvBoost + drift - volPenalty - riskPenalty;
  } catch {
    return 0;
  }
}

function volatilityDampingFactor(provider) {
  try {
    const p = normalizeProviderKey(provider);
    const stats = getProviderRevenueStats(p);
    if (!stats) return 1;

    const vol = safeNumber(stats.volatility, 0);
    const risk = safeNumber(stats.riskScore, 0);

    const penalty = clamp(vol * 0.12 + risk * 0.10, 0, 0.25);
    return clamp(1 - penalty, 0.7, 1);
  } catch {
    return 1;
  }
}

function providerKarmaFusion(providerKey, categoryKey) {
  try {
    const p = normalizeProviderKey(providerKey);
    const c = normalizeCategoryKey(categoryKey);
    const stats = getProviderRevenueStats(p);
    if (!stats) return 0;

    const catStats = stats.byCategory?.[c];
    if (!catStats) return 0;

    const catRevenue = safeNumber(catStats.revenue, 0);
    const catConv = safeNumber(catStats.conversionRate, 0);

    const base = Math.min(0.06, catRevenue / 6000);
    const conv = Math.min(0.05, catConv * 0.5);

    return base + conv;
  } catch {
    return 0;
  }
}

function commissionGradientAdjust(finalRate, providerPriorityScore) {
  const rate = safeNumber(finalRate, 0);
  const pp = safeNumber(providerPriorityScore, 1);

  const center = 2.0;
  const diff = pp - center;
  const factor = 1 + clamp(diff * 0.015, -0.05, 0.06);

  const adjusted = rate * factor;
  return clamp(adjusted, 0, 0.5);
}

// ================================================================
// PROVIDER PRIORITY — S200 formatında
// ================================================================
export function providerPriority(providerRaw, userMemory = null) {
  const key = normalizeProviderKey(providerRaw);

  const baseRate = computeBasePlatformRate(key);
  const rankWeight = getProviderRankingWeightS9(key) || 1;
  const trustScore = getProviderTrustScoreS9(key) || 0.5;
  const policyBoost = providerPolicyBoost(key);

  let dynScore = 0.75;
  try {
    dynScore = computeDynamicProviderPriority(key, userMemory);
  } catch {
    try {
      const all = getAllProviderPriorities(userMemory || null);
      const vals = Object.values(all || {});
      if (vals.length) {
        dynScore =
          vals.reduce((a, b) => a + safeNumber(b, 0), 0) / vals.length;
      }
    } catch {
      dynScore = 0.75;
    }
  }

  const learnedLvl = clamp(1 + dynScore * 4, 1, 5);

  let baseWeight;
  if (baseRate <= 0.03) baseWeight = 1.0;
  else if (baseRate <= 0.06) baseWeight = 1.55;
  else if (baseRate <= 0.10) baseWeight = 2.1;
  else if (baseRate <= 0.15) baseWeight = 2.75;
  else baseWeight = 3.4;

  const trustFactor = 1 + (trustScore - 0.5) * 0.45;
  const dynFactor = 1 + (learnedLvl - 1) * 0.13;
  const revenueFactor = 1 + policyBoost;
  const volatilityFactor = volatilityDampingFactor(key);
  const stabilityFactor = policyBoost < -0.05 ? 0.9 : 1.0;

  let finalWeight =
    baseWeight *
    rankWeight *
    trustFactor *
    dynFactor *
    revenueFactor *
    volatilityFactor *
    stabilityFactor;

  return clamp(finalWeight, 0.5, 5.0);
}

// ================================================================
// MASTER COMMISSION CONTEXT — S200 SAFE FORMAT
// ================================================================
export function buildCommissionContext(item, extra = {}) {
  if (!item || typeof item !== "object") {
    return {
      providerKey: "unknown",
      categoryKey: "unknown",
      finalRate: 0,
      commissionAmount: 0,
      price: null,
      commissionScoreS9: 0,
      providerPriorityScore: 0,
      optimizedPrice: null,
      fusionResonance: 0,
      providerKarmaBoost: 0,
      version: "S200-SUPRACONDUCTOR",
      source: "commissionEngine",
      ...extra,
    };
  }

  const hashKey = computeHash(item);
  if (cache.has(item)) {
    const stored = cache.get(item);
    if (
      stored.hash === hashKey &&
      stored.meta?.version === "S200-SUPRACONDUCTOR"
    ) {
      return stored.meta;
    }
  }

  const providerKey = normalizeProviderKey(
    item.provider || item.raw?.provider
  );

  const categoryKey = normalizeCategoryKey(
    item.category || item.raw?.category
  );

  const baseRate = computeBasePlatformRate(providerKey);
  const catMul = computeCategoryMultiplier(categoryKey);

  const userClicks = safeNumber(extra.userClicks ?? extra.clicks, 0);
  const memoryProfile = extra.memoryProfile || null;

  let finalRate = 0;
  try {
    finalRate = computeCommissionRate(
      providerKey,
      categoryKey,
      userClicks,
      memoryProfile
    );
  } catch {
    const tf = timeFactorS12();
    const sf = seasonalFactorS12();
    const bf = behaviorFactorS12(userClicks, memoryProfile);
    finalRate = baseRate * catMul * tf * sf * bf;
  }

  finalRate = safeNumber(finalRate, 0);
  finalRate = clamp(finalRate, 0, 0.4875);

  const price = safeNumber(item.price, null);
  const commissionAmount =
    price && price > 0 ? price * finalRate : 0;

  const s9Score = getCommissionScoreS9(providerKey, price);
  const providerPriorityScore = providerPriority(providerKey, extra.userMemory || null);

  const fusedRate = commissionGradientAdjust(finalRate, providerPriorityScore);
  const fusedCommissionAmount =
    price && price > 0 ? price * fusedRate : commissionAmount;

  const fusionResonance = clamp(
    Math.abs(fusedRate - finalRate) * 100,
    0,
    15
  );

  let optimizedPrice = null;
  try {
    if (price && price > 0) {
      const ps = memoryProfile?.priceSensitivity;
      let bias = 1.0;

      if (typeof ps === "number") {
        if (ps < 0.95) bias *= 0.989;
        else if (ps > 1.18) bias *= 1.011;
      }

      if (fusedRate > 0.18) bias *= 1.006;

      bias = clamp(bias, 0.97, 1.03);

      optimizedPrice = Math.round(price * bias * 100) / 100;
    }
  } catch {
    optimizedPrice = null;
  }

  const meta = {
    providerKey,
    categoryKey,
    finalRate: fusedRate,
    commissionAmount: fusedCommissionAmount,
    price,
    commissionScoreS9: s9Score,
    providerPriorityScore,
    optimizedPrice,
    fusionResonance,
    providerKarmaBoost: providerKarmaFusion(providerKey, categoryKey),
    version: "S200-SUPRACONDUCTOR",
    metaHash: hashKey,
    source: "commissionEngine",
    ...extra,
  };

  cache.set(item, { hash: hashKey, meta });

  return meta;
}

// ================================================================
// DECORATE — S200 safe, idempotent
// ================================================================
export function decorateResultsWithCommission(items, ctx = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const out = [];

  for (const original of items) {
    if (!original) continue;

    const item = { ...original };

    if (
      item._commissionDecorated === true &&
      item.commissionMeta?.version === "S200-SUPRACONDUCTOR" &&
      item.commissionMeta?.metaHash
    ) {
      out.push(item);
      continue;
    }

    const commissionMeta = buildCommissionContext(item, ctx);

    item.commissionMeta = {
      ...(item.commissionMeta || {}),
      ...commissionMeta,
    };

    item._commissionDecorated = true;

    out.push(item);
  }

  return out;
}

export function safeDecorateResultsWithCommission(items, ctx = {}) {
  try {
    return decorateResultsWithCommission(items, ctx);
  } catch {
    return Array.isArray(items) ? items : [];
  }
}

export default {
  providerPriority,
  buildCommissionContext,
  decorateResultsWithCommission,
  safeDecorateResultsWithCommission,
  optimizePriceForItem: buildCommissionContext, // S200 uyumlu
  providerPolicyBoost,
};
