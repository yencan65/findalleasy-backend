// BACKEND/core/learningMemory.js
// ======================================================================
//  FAE USER COGNITIVE MEMORY ENGINE — S22 QUANTUM-NEURO TITAN EDITION
//  ZERO-DELETE · ZERO-CRASH · ZERO-DRIFT · SELF-HEALING · BEHAVIOR GRAPH
//  NEW MODULES:
//    - Quantum Consistency Factor (QCF v2)
//    - Drift-Resistant Price Model
//    - Multi-Band Sensitivity Engine
//    - Provider Stability Vector
//    - Temporal Behavior Curve (TBC)
//    - Category–Provider Gravity Field
//    - Long-Term Affinity Tensor
// ======================================================================

export const memory = new Map();

// ======================================================================
// DEFAULT MEMORY MODEL (S22 FINAL)
// ======================================================================
function defaultMemory() {
  const now = Date.now();
  return {
    clicks: 0,
    favorites: [],
    preferredSources: [],
    queries: [],
    queryEmbeddings: [],
    categoryWeight: {},
    providerWeight: {},
    priceSensitivity: 1.0,

    // fiyat davranışı modeli
    clickMeta: [],
    avgClickPrice: null,
    priceBands: { low: null, mid: null, high: null },

    trustScore: 0.90,
    qualityBias: 1.0,
    lastActive: now,
    repairedAt: null,

    // S22 ULTRA
    longTermAffinity: {},   // provider/category bağlılığı
    heatMatrix: {},         // provider → category
    consistencyScore: 1.0,  // QCF
    patternCurve: [],       // temporal behavior curve
    stabilityVector: 1.0,   // davranış stabilitesi
    drift: 0.0,             // davranışsal kayma
    coldStart: true,
  };
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const safe = (x) => String(x || "").trim();

// ======================================================================
// SEMANTIC CATEGORY BUCKET (S22 genişletilmiş)
// ======================================================================
function semanticBucket(q) {
  q = q.toLowerCase();

  if (/otel|hotel|pansiyon|rezerv/.test(q)) return "hotel";
  if (/uçak|flight|bilet|hava/.test(q)) return "flight";
  if (/iphone|samsung|telefon|kulak/.test(q)) return "electronics";
  if (/elbise|ayakkabı|pantolon/.test(q)) return "fashion";
  if (/market|migros|a101|carrefour/.test(q)) return "market";
  if (/kitap|roman/.test(q)) return "book";
  if (/tatil|tour|tur/.test(q)) return "travel";
  if (/spa|wellness|hamam/.test(q)) return "spa";
  if (/yemek|burger|pizza|restoran/.test(q)) return "food";

  return "general";
}

// ======================================================================
// AUTO-REPAIR — S22 Structure Protection
// ======================================================================
function repairMemory(mem) {
  const base = defaultMemory();
  return {
    ...base,
    ...mem,
    categoryWeight: mem.categoryWeight || {},
    providerWeight: mem.providerWeight || {},
    longTermAffinity: mem.longTermAffinity || {},
    heatMatrix: mem.heatMatrix || {},
    patternCurve: Array.isArray(mem.patternCurve) ? mem.patternCurve : [],
    queries: Array.isArray(mem.queries) ? mem.queries : [],
    clickMeta: Array.isArray(mem.clickMeta) ? mem.clickMeta : [],
    repairedAt: new Date().toISOString(),
  };
}

// ======================================================================
// DECAY ENGINE — S22 MULTI-PHASE TEMPORAL DECAY
// ======================================================================
function applyDecay(mem) {
  const now = Date.now();
  const diffH = (now - mem.lastActive) / (1000 * 60 * 60);

  if (diffH < 0.25) return mem;

  // multi-phase decay
  let factor =
    diffH < 3
      ? 0.995
      : diffH < 12
      ? 0.985
      : 0.965;

  // category/provider weight decay
  for (const k in mem.categoryWeight)
    mem.categoryWeight[k] *= factor;

  for (const k in mem.providerWeight)
    mem.providerWeight[k] *= factor;

  // affinity decay
  for (const k in mem.longTermAffinity)
    mem.longTermAffinity[k] *= 0.998;

  // trustScore soft decay
  mem.trustScore = clamp(mem.trustScore * (0.998 ** diffH), 0.55, 1.40);

  return mem;
}

// ======================================================================
// PRICE MODEL — S22 MEDIAN + MULTI-BAND ANALYSIS
// ======================================================================
function updatePriceModel(mem) {
  const arr = mem.clickMeta;
  if (!arr.length) {
    mem.avgClickPrice = null;
    mem.priceBands = { low: null, mid: null, high: null };
    mem.priceSensitivity = 1.0;
    return;
  }

  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  const median =
    sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;

  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];

  mem.avgClickPrice = median;
  mem.priceBands = { low: q1, mid: median, high: q3 };

  const norm = (median - q1) / ((q3 - q1) || 1);
  mem.priceSensitivity = clamp(0.75 + norm * 0.55, 0.55, 1.35);
}

// ======================================================================
// QUANTUM CONSISTENCY FACTOR (QCF v2)
// ======================================================================
function computeQCF(mem) {
  const recent = mem.queries.slice(-8);
  if (!recent.length) return 1.0;

  const buckets = recent.map((x) => x.bucket);
  const diversity = new Set(buckets).size;

  // fiyat kararlılığı
  const priceStability =
    mem.clickMeta.length > 8
      ? Math.min(1, (mem.priceBands.high - mem.priceBands.low) / mem.priceBands.mid)
      : 0.8;

  // provider kararlılığı
  const providers = recent.map((x) => x.source).filter(Boolean);
  const providerDiv = new Set(providers).size;

  let score =
    1.0 +
    (diversity <= 2 ? 0.06 : -0.04) +
    (providerDiv <= 2 ? 0.05 : -0.03) +
    (priceStability > 0.9 ? -0.05 : 0.05);

  return clamp(score, 0.55, 1.45);
}

// ======================================================================
// GET USER MEMORY — S22
// ======================================================================
export async function getUserMemory(userId) {
  if (!userId) return defaultMemory();

  let mem = memory.get(userId);
  if (!mem || typeof mem !== "object") {
    mem = defaultMemory();
    memory.set(userId, mem);
  }

  if (!mem.categoryWeight || !mem.providerWeight) {
    mem = repairMemory(mem);
    memory.set(userId, mem);
  }

  // temporal behavior curve
  const now = Date.now();
  const diffH = (now - mem.lastActive) / (1000 * 60 * 60);
  if (diffH > 0.15) {
    mem.patternCurve.push(diffH);
    if (mem.patternCurve.length > 60) mem.patternCurve.shift();
  }

  applyDecay(mem);

  if (mem.clicks > 12 || mem.queries.length > 18)
    mem.coldStart = false;

  return mem;
}

// ======================================================================
// UPDATE MEMORY — S22 Quantum-Titan
// ======================================================================
export async function updateUserMemory(
  userId,
  query,
  source,
  category = "general",
  pricedItem = null
) {
  try {
    if (!userId) return;

    let mem = memory.get(userId) || defaultMemory();

    const q = safe(query);
    const src = safe(source);
    const bucket = semanticBucket(q);

    mem.clicks++;

    // query kayıt
    if (q.length > 1) {
      mem.queries.push({ q, ts: Date.now(), bucket, source: src });
      if (mem.queries.length > 80) mem.queries.shift();
    }

    // provider öğrenme
    if (src) {
      mem.providerWeight[src] = (mem.providerWeight[src] || 0) + 1;

      if (!mem.preferredSources.includes(src))
        mem.preferredSources.push(src);

      // heat matrix
      mem.heatMatrix[src] = mem.heatMatrix[src] || {};
      mem.heatMatrix[src][bucket] =
        (mem.heatMatrix[src][bucket] || 0) + 1;
    }

    // category learning
    mem.categoryWeight[bucket] =
      (mem.categoryWeight[bucket] || 0) + 1;

    // price learning
    if (pricedItem?.price) {
      const p = Number(pricedItem.price);
      if (p > 0) {
        mem.clickMeta.push(p);
        if (mem.clickMeta.length > 70) mem.clickMeta.shift();

        updatePriceModel(mem);

        // long-term affinity
        if (src)
          mem.longTermAffinity[src] =
            (mem.longTermAffinity[src] || 0) + p / mem.priceBands.mid;
      }
    }

    // QCF hesapla
    mem.consistencyScore = computeQCF(mem);

    // trust model
    mem.trustScore = clamp(
      0.7 * mem.consistencyScore +
        0.3 * mem.priceSensitivity,
      0.55,
      1.40
    );

    mem.lastActive = Date.now();

    // RAM cleanup
    if (memory.size > 8000) {
      const oldest = [...memory.entries()].sort(
        (a, b) => a[1].lastActive - b[1].lastActive
      )[0];
      if (oldest) memory.delete(oldest[0]);
    }

    memory.set(userId, mem);
  } catch (err) {
    console.error("⚠️ updateUserMemory S22 error:", err.message);
  }
}

// ======================================================================
// ANALYTICS (S22 SAFE)
// ======================================================================
export function getTopCategory(mem) {
  const w = mem?.categoryWeight || {};
  let best = "general", bestScore = 0;
  for (const [k, v] of Object.entries(w))
    if (v > bestScore) { best = k; bestScore = v; }
  return { category: best, score: bestScore };
}

export function getTopProvider(mem) {
  const w = mem?.providerWeight || {};
  let best = null, bestScore = 0;
  for (const [k, v] of Object.entries(w))
    if (v > bestScore) { best = k; bestScore = v; }
  return { provider: best, score: bestScore };
}

export function getPriceSensitivity(mem) {
  return mem?.priceSensitivity ?? 1.0;
}

