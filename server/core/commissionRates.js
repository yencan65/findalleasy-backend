// server/core/commissionRates.js
// ======================================================================
// FAE — S14.9 OMEGA–SINGULARITY COMMISSION ENGINE (S200 ADAPTER ENGINE READY)
// ZERO-DELETE · ZERO-DRIFT · ZERO-CRASH · FULL S10–S16 Compatible
// ======================================================================

// ============================================================
// 1) STATIC PLATFORM COMMISSION (BASE)
// ============================================================
export const platformCommission = {
  trendyol: 0.06,
  hepsiburada: 0.05,
  n11: 0.04,
  amazon: 0.03,
  aliexpress: 0.03,
  etsy: 0.04,
  zalando: 0.06,
  mediamarkt: 0.05,
  ubisoft: 0.13,

  ciceksepeti: 0.04,
  gittigidiyor: 0.03,

  booking: 0.12,
  skyscanner: 0.07,
  tatilbudur: 0.10,
  otelz: 0.09,

  google_shopping: 0.03,
  serpapi: 0.03,

  unknown: 0.04,
};

// ============================================================
// 2) CATEGORY MULTIPLIERS
// ============================================================
export const categoryMultiplier = {
  electronics: 1.30,
  grocery: 0.75,
  fashion: 1.15,
  cosmetics: 1.10,
  home: 1.00,
  hotel: 1.05,
  flight: 1.05,
  car_rental: 0.95,
  food: 0.90,
  books: 0.90,
  gaming: 1.40,
  pet: 1.10,
  unknown: 0.90,
};

// ============================================================
// 3) DYNAMIC OVERRIDES (SAFE JSON IMPORT)
// ============================================================
let dynamicOverrides = {};

try {
  const mod = await import("./dynamicCommissionRates.json", {
    assert: { type: "json" },
  });
  if (mod?.default && typeof mod.default === "object") {
    dynamicOverrides = mod.default;
  }
} catch {
  dynamicOverrides = {};
}

export const finalPlatformCommission = {
  ...platformCommission,
  ...(dynamicOverrides.platformCommission || {}),
};

export const finalCategoryMultiplier = {
  ...categoryMultiplier,
  ...(dynamicOverrides.categoryMultiplier || {}),
};

// ======================================================================
// 4) TIME FACTOR
// ======================================================================
export function timeFactor(date = new Date()) {
  const h = date.getHours();
  if (h >= 18 && h <= 23) return 1.20;
  if (h >= 12 && h <= 17) return 1.05;
  if (h >= 0 && h <= 6) return 1.15;
  return 1.00;
}

// ======================================================================
// 5) SEASONAL FACTOR
// ======================================================================
export function seasonalFactor(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m === 11 || m === 12) return 1.25;
  if (m === 6 || m === 7 || m === 8) return 1.12;
  return 1.00;
}

// ======================================================================
// 6) BEHAVIOR FACTOR
// ======================================================================
export function behaviorFactor(userClicks = 0, memoryProfile = null) {
  let base = 1.0;

  if (userClicks > 50) base = 1.40;
  else if (userClicks > 30) base = 1.25;
  else if (userClicks > 20) base = 1.15;
  else if (userClicks > 10) base = 1.07;

  try {
    if (memoryProfile) {
      const ps = memoryProfile.priceSensitivity;
      const pa = memoryProfile.providerAffinityScore || 1;
      const ca = memoryProfile.categoryAffinityScore || 1;

      if (ps < 0.95) base *= 0.96;
      if (ps > 1.15) base *= 1.06;

      base *= pa ** 0.15;
      base *= ca ** 0.12;
    }
  } catch {}

  return base;
}

// ======================================================================
// 7) TRUST FACTOR
// ======================================================================
export function trustFactor(memoryProfile = null) {
  try {
    const t = memoryProfile?.trustScore;
    if (!t) return 1.0;
    return Math.max(0.55, Math.min(t, 1.25));
  } catch {
    return 1.0;
  }
}

// ======================================================================
// 8) COMPETITIVENESS FACTOR
// ======================================================================
function competitivenessFactor(provider, category) {
  try {
    const rivals = {
      electronics: ["amazon", "hepsiburada", "trendyol", "n11"],
      hotel: ["booking", "otelz", "tatilbudur"],
      fashion: ["trendyol", "zalando", "ciceksepeti"],
    };

    const set = rivals[category] || [];
    if (!set.includes(provider)) return 1.00;

    return 1.00 + Math.min(0.12, set.length * 0.03);
  } catch {
    return 1.00;
  }
}

// ======================================================================
// 9) EVENT BOOST
// ======================================================================
function eventBoostLayer() {
  const d = new Date().getDate();
  if (d === 1 || d === 15) return 1.10;
  if (d >= 27 && d <= 31) return 1.05;
  return 1.00;
}

// ======================================================================
// 10) PRICE ELASTICITY
// ======================================================================
function priceElasticity(price) {
  if (!price || price <= 0) return 1.00;
  if (price < 100) return 1.12;
  if (price > 5000) return 0.92;
  return 1.00;
}

// ======================================================================
// 11) HARMONY STABILIZER
// ======================================================================
function harmonyStabilize(x) {
  try {
    return x * 0.88 + Math.sqrt(x) * 0.12;
  } catch {
    return x;
  }
}

// ======================================================================
// 12) QUANTUM NORMALIZE
// ======================================================================
function quantumNormalize(x, min = 0.01, max = 0.50) {
  try {
    const logN = Math.log1p(x * 12) / 5.5;
    return Math.min(max, Math.max(min, logN));
  } catch {
    return min;
  }
}

// ======================================================================
// 13) MASTER COMPUTE RATE (MAIN ENTRY FOR S200)
// ======================================================================
export function computeCommissionRate(
  provider,
  category,
  userClicks = 0,
  memoryProfile = null,
  price = 0
) {
  const pKey = (provider || "").toLowerCase();
  const cKey = (category || "unknown").toLowerCase();

  const baseP =
    finalPlatformCommission[pKey] ?? finalPlatformCommission.unknown;
  const baseC =
    finalCategoryMultiplier[cKey] ?? finalCategoryMultiplier.unknown;

  const tf = timeFactor();
  const sf = seasonalFactor();
  const bf = behaviorFactor(userClicks, memoryProfile);
  const trf = trustFactor(memoryProfile);
  const cmp = competitivenessFactor(pKey, cKey);
  const eb = eventBoostLayer();
  const pel = priceElasticity(price);

  const raw =
    baseP * baseC * tf * sf * bf * trf * cmp * eb * pel;

  const harmonized = harmonyStabilize(raw);
  return quantumNormalize(harmonized, 0.01, 0.50);
}

// ======================================================================
// DEFAULT EXPORT — required by S200 adapterEngine
// ======================================================================
export default {
  platformCommission: finalPlatformCommission,
  categoryMultiplier: finalCategoryMultiplier,
  timeFactor,
  seasonalFactor,
  behaviorFactor,
  trustFactor,
  computeCommissionRate,
};
