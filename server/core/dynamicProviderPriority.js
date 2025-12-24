// server/core/dynamicProviderPriority.js
// ========================================================================
//  S10.Ω META–SINGULARITY PROVIDER PRIORITY ENGINE
//  (S10.3 → S10.9 → S10.Ω Final Form)
//  ZERO BREAKING CHANGE — hiçbir eski API bozulmaz
//
//  Katmanlar:
//  - TrustBase
//  - Decay
//  - Memory Boost
//  - Category Synergy
//  - Heatmap
//  - Graph Influence
//  - Global Reputation
//  - Momentum
//  - Semantic Signal
//  - Stabilizer
//  - Provider Economic Gravity (PEG)
//  - Cross-Provider Entropy Diffusion (CPED)
//  - Price–Category Gravity (PCG)
//  - Long-Term Affinity Drift (LTAD)
//  - ★ Provider Reliability Drift (PRD)
//  - ★ Multi-Category Cross-Entropy (MCCE)
//  - ★ Temporal Competitive Pressure (TCP)
//  - ★ Intent & Query Alignment Boost (IQAB)
// ========================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getTopProvider,
  getTopCategory,
  getUserMemory,
} from "./learningMemory.js";
import stringSimilarity from "string-similarity";

// ------------------------------------------------------------------
// PATH SETUP (ESM uyumlu)
// ------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JSON_PATH = path.join(__dirname, "dynamicProviderPriority.json");

// ------------------------------------------------------------------
// BASE PRIORITY (S200 ile uyumlu çekirdek map)
// ------------------------------------------------------------------
export const BASE_PROVIDER_PRIORITY = {
  trendyol: 0.90,
  hepsiburada: 0.92,
  n11: 0.88,
  amazon: 0.93,
  ciceksepeti: 0.87,
  migros: 0.86,
  metro: 0.86,
  macrocenter: 0.88,
  a101: 0.85,
  booking: 0.92,
  expedia: 0.89,
  mngtur: 0.85,
  akakce: 0.84,
  cimri: 0.82,
  googleplaces: 0.55,
  osm: 0.50,
  serpapi: 0.60,
};

// Provider ilişkileri
const PROVIDER_GRAPH = {
  trendyol: ["hepsiburada", "n11"],
  hepsiburada: ["trendyol", "amazon"],
  amazon: ["hepsiburada"],
  booking: ["expedia"],
  expedia: ["booking"],
  n11: ["trendyol", "ciceksepeti"],
  ciceksepeti: ["n11"],
};

// Provider segmentleri (ekstra sinyal)
const PROVIDER_SEGMENT = {
  trendyol: "marketplace",
  hepsiburada: "marketplace",
  n11: "marketplace",
  amazon: "marketplace",
  ciceksepeti: "gift",
  migros: "grocery",
  metro: "grocery",
  macrocenter: "grocery",
  a101: "grocery",
  booking: "hotel",
  expedia: "hotel",
  mngtur: "tour",
  akakce: "price_compare",
  cimri: "price_compare",
  googleplaces: "location",
  osm: "location",
  serpapi: "meta",
};

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------
function safe(x, fb = 0) {
  return Number.isFinite(x) ? x : fb;
}

function normalizeProviderKey(provider) {
  return String(provider || "").toLowerCase().trim();
}

// JSON LOAD (read-only; save için ayrı helper yazıyoruz)
function loadJSON() {
  try {
    const raw = fs.readFileSync(JSON_PATH, "utf8");
    const data = JSON.parse(raw || "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    console.warn("dynamicProviderPriority.json okunamadı → fallback boş obje");
    return {};
  }
}

function saveJSON(data) {
  try {
    const tmpPath = JSON_PATH + ".tmp";
    const raw = JSON.stringify(data || {}, null, 2);
    fs.writeFileSync(tmpPath, raw, "utf8");
    fs.renameSync(tmpPath, JSON_PATH);
  } catch (err) {
    console.warn("dynamicProviderPriority.json kaydedilemedi:", err?.message || err);
  }
}

// User memory güvenli erişim — S200 ile uyumlu
function safeGetUserMemory(userMemory) {
  if (userMemory && typeof userMemory === "object") return userMemory;
  try {
    if (typeof getUserMemory === "function") {
      const mem = getUserMemory();
      return mem || null;
    }
  } catch {
    // sessiz
  }
  return null;
}

// ------------------------------------------------------------------
// 1) AGE DECAY
// ------------------------------------------------------------------
function computeDecay(ts) {
  if (!ts) return 1;
  const days = (Date.now() - Number(ts)) / (1000 * 60 * 60 * 24);
  if (days <= 7) return 1;
  if (days >= 120) return 0.08;
  return Number((1 - days / 140).toFixed(3));
}

// ------------------------------------------------------------------
// 2) CATEGORY SYNERGY
// ------------------------------------------------------------------
function computeCategorySynergy(provider, mem, json) {
  try {
    const topCat = getTopCategory(mem);
    if (!topCat?.category) return 0;

    const cls = json[provider]?.class;
    if (!cls) return 0;

    if (cls === topCat.category) {
      return safe(topCat.score * 0.15);
    }

    const seg = PROVIDER_SEGMENT[provider] || "";
    if (seg && topCat.category && seg === topCat.category) {
      return safe(topCat.score * 0.08);
    }

    return 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// 3) USER PROVIDER BOOST
// ------------------------------------------------------------------
function computeUserBoost(provider, mem) {
  try {
    const top = getTopProvider(mem);
    if (!top?.provider) return 0;
    return top.provider === provider ? safe(top.score * 0.18) : 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// 4) HEATMAP BOOST
// ------------------------------------------------------------------
function computeHeatmapBoost(rec) {
  try {
    if (!rec?.clicks) return 0;
    const decay = computeDecay(rec.last);
    const clicks = safe(rec.clicks, 0);

    const scale = Math.log1p(clicks) / 6; // 0–~0.3
    return safe(scale * decay * 0.5); // max ~0.15 civarı
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// 5) GLOBAL REPUTATION
// ------------------------------------------------------------------
function computeGlobalReputation(provider) {
  const rep = {
    amazon: 1.0,
    booking: 0.98,
    expedia: 0.97,
    trendyol: 0.95,
    hepsiburada: 0.94,
    n11: 0.92,
    ciceksepeti: 0.91,
  };
  return rep[provider] || 0.85;
}

// ------------------------------------------------------------------
// 6) GRAPH RELATIONSHIP
// ------------------------------------------------------------------
function computeGraphInfluence(provider, mem) {
  try {
    const top = getTopProvider(mem);
    if (!top?.provider) return 0;

    const neighbors = PROVIDER_GRAPH[top.provider] || [];
    return neighbors.includes(provider) ? safe(top.score * 0.10) : 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// 7) MOMENTUM
// ------------------------------------------------------------------
function computeMomentum(provider, mem) {
  try {
    const history = mem?.searchHistory || [];
    if (!history.length) return 0;

    const lastProviders = history.slice(-10).map((x) => x.provider);
    const count = lastProviders.filter((p) => p === provider).length;

    return safe(count * 0.025);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// 8) SEMANTIC SIGNAL
// ------------------------------------------------------------------
function computeSemanticSignal(provider, mem, json) {
  try {
    const q = mem?.lastQuery || "";
    if (!q.trim()) return 0;

    const cls = json[provider]?.class || "";
    const seg = PROVIDER_SEGMENT[provider] || "";

    const target = [cls, seg].filter(Boolean).join(" ");
    if (!target) return 0;

    const sim = stringSimilarity.compareTwoStrings(
      target.toLowerCase(),
      q.toLowerCase()
    );

    return safe(sim * 0.12);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// ★ 9) PROVIDER ECONOMIC GRAVITY (PEG)
// ------------------------------------------------------------------
function computeEconomicGravity(provider, json) {
  try {
    const base = BASE_PROVIDER_PRIORITY[provider] || 0.40;
    const tb = json[provider]?.trustBase || base;
    const gravity = (tb ** 1.2) * 0.08;
    return safe(gravity);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// ★ 10) CROSS-PROVIDER ENTROPY DIFFUSION (CPED)
// ------------------------------------------------------------------
function computeEntropyDiffusion(provider) {
  const base = BASE_PROVIDER_PRIORITY[provider] || 0.40;
  const drift = 1 - base;
  return safe(drift * 0.03);
}

// ------------------------------------------------------------------
// ★ 11) PRICE–CATEGORY GRAVITY (PCG)
// ------------------------------------------------------------------
function computePriceCategoryGravity(provider, mem, json) {
  try {
    const avg = mem?.recentPriceAvg;
    if (!avg) return 0;

    const pClass = json[provider]?.class || "";

    if (pClass === "electronics" && avg > 5000) return 0.06;
    if (pClass === "market" && avg < 300) return 0.04;

    return 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// ★ 12) LONG-TERM AFFINITY DRIFT (LTAD)
// ------------------------------------------------------------------
function computeAffinityDrift(provider, mem) {
  try {
    const affin = mem?.longTermAffinity?.[provider] || 0;
    return safe(affin * 0.02);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// ★ 13) PROVIDER RELIABILITY DRIFT (PRD)
// ------------------------------------------------------------------
function computeReliabilityDrift(provider, mem) {
  try {
    const rel = mem?.providerReliability?.[provider] ?? 0.5;
    return safe((rel - 0.5) * 0.12); // 0–1 → -0.06..+0.06
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// ★ 14) MULTI-CATEGORY CROSS-ENTROPY (MCCE)
// ------------------------------------------------------------------
function computeCategoryCrossEntropy(provider, mem, json) {
  try {
    const distrib = mem?.categoryDistribution || {};
    const pClass = json[provider]?.class || "";

    if (!pClass) return 0;

    const freq = safe(distrib[pClass], 0);
    return safe(freq * 0.08); // 0–1
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// ★ 15) TEMPORAL COMPETITIVE PRESSURE (TCP)
// ------------------------------------------------------------------
function computeCompetitivePressure(provider) {
  const p = normalizeProviderKey(provider);
  const group = (() => {
    if (["trendyol", "hepsiburada", "n11", "amazon"].includes(p))
      return "marketplace";
    if (["booking", "expedia", "mngtur"].includes(p)) return "travel";
    if (["migros", "metro", "macrocenter", "a101"].includes(p)) return "grocery";
    return "other";
  })();

  switch (group) {
    case "marketplace":
      return 0.04;
    case "travel":
      return 0.03;
    case "grocery":
      return 0.02;
    default:
      return 0.01;
  }
}

// ------------------------------------------------------------------
// ★ 16) INTENT & QUERY ALIGNMENT BOOST (IQAB)
// ------------------------------------------------------------------
function computeIntentQueryBoost(provider, mem, json) {
  try {
    const intent = mem?.lastIntent || "";
    const q = (mem?.lastQuery || "").toLowerCase();
    const cls = (json[provider]?.class || "").toLowerCase();
    const seg = (PROVIDER_SEGMENT[provider] || "").toLowerCase();

    let boost = 0;

    if (intent === "hotel" && (cls === "hotel" || seg === "hotel")) {
      boost += 0.07;
    } else if (intent === "market" && (cls === "market" || seg === "grocery")) {
      boost += 0.05;
    } else if (intent === "electronics" && cls === "electronics") {
      boost += 0.05;
    }

    if (q.includes("ucuz") && ["akakce", "cimri"].includes(provider)) {
      boost += 0.04;
    }

    return safe(boost);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------
// STABILIZER
// ------------------------------------------------------------------
function stabilizer(score) {
  return Number((score * 0.80 + 0.20 * Math.sqrt(score)).toFixed(3));
}

// ------------------------------------------------------------------
// MASTER FUSION ENGINE — S10.Ω FINAL FORM (S200 uyumlu)
// ------------------------------------------------------------------
export function computeDynamicProviderPriority(providerKey, userMemory = null) {
  const key = normalizeProviderKey(providerKey);
  if (!key) return 0.5;

  const json = loadJSON();
  const rec = json[key];
  const mem = safeGetUserMemory(userMemory);

  const trustBase = rec?.trustBase;
  const fallback = BASE_PROVIDER_PRIORITY[key] || 0.40;

  let score = safe(trustBase, fallback);

  // Çekirdek katlar
  score += computeCategorySynergy(key, mem, json);
  score += computeUserBoost(key, mem);
  score += computeHeatmapBoost(rec);
  score += computeGraphInfluence(key, mem);
  score += computeGlobalReputation(key) * 0.05;
  score += computeMomentum(key, mem);
  score += computeSemanticSignal(key, mem, json);

  // Cosmic katlar
  score += computeEconomicGravity(key, json);
  score += computeEntropyDiffusion(key);
  score += computePriceCategoryGravity(key, mem, json);
  score += computeAffinityDrift(key, mem);

  // Omega katlar
  score += computeReliabilityDrift(key, mem);
  score += computeCategoryCrossEntropy(key, mem, json);
  score += computeCompetitivePressure(key);
  score += computeIntentQueryBoost(key, mem, json);

  score = stabilizer(score);
  score = Math.min(1, Math.max(0, score));

  return Number(score.toFixed(3));
}

// ------------------------------------------------------------------
// TÜM PROVIDER PRIORITY MAP (S200 BEST MOTORU İÇİN)
// ------------------------------------------------------------------
export function getAllProviderPriorities(userMemory = null) {
  const mem = safeGetUserMemory(userMemory);
  const out = {};

  const json = loadJSON();

  // Base listeden başla
  for (const p in BASE_PROVIDER_PRIORITY) {
    out[p] = computeDynamicProviderPriority(p, mem);
  }

  // JSON içindeki ek provider’lar
  for (const p in json) {
    const k = normalizeProviderKey(p);
    if (!k || out[k] != null) continue;
    out[k] = computeDynamicProviderPriority(k, mem);
  }

  return out;
}

// ------------------------------------------------------------------
// GERİYE DÖNÜK UYUMLU getLearnedProviderPriority
//  - Argüman STRING ise → tek provider puanı
//  - Argüman YOK / falsy ise → { provider: score, ... } map
// ------------------------------------------------------------------
export function getLearnedProviderPriority(providerKey, userMemory = null) {
  try {
    if (providerKey && typeof providerKey === "string") {
      const key = normalizeProviderKey(providerKey);
      return computeDynamicProviderPriority(key, userMemory);
    }

    // Eski kodun beklediği şekil: full map
    return getAllProviderPriorities(userMemory);
  } catch (err) {
    console.warn("getLearnedProviderPriority hata → fallback:", err?.message);
    return providerKey ? 0.5 : {};
  }
}

// ------------------------------------------------------------------
// CLICK LEARNING — S200 ile uyumlu hafif öğrenme katmanı
//  (Eski S15 tarzı recordProviderClick çağrılarını kırmamak için)
// ------------------------------------------------------------------
export function recordProviderClick(providerName, delta = 1) {
  const key = normalizeProviderKey(providerName);
  if (!key) return;

  try {
    const json = loadJSON();
    const now = Date.now();

    const rec = json[key] && typeof json[key] === "object" ? json[key] : {};

    const clicksPrev = Number(rec.clicks || 0) || 0;
    const totalPrev = Number(rec.totalClicks || 0) || 0;

    json[key] = {
      ...rec,
      clicks: clicksPrev + Math.max(0, delta || 1),
      totalClicks: totalPrev + Math.max(0, delta || 1),
      lastClick: now,
      last: now,
    };

    saveJSON(json);
  } catch (err) {
    console.warn("recordProviderClick hata verdi:", err?.message || err);
  }
}

// ------------------------------------------------------------------
// DEFAULT EXPORT — eski import dinamikleri ile uyum
// ------------------------------------------------------------------
export default {
  computeDynamicProviderPriority,
  getAllProviderPriorities,
  getLearnedProviderPriority,
  recordProviderClick,
  BASE_PROVIDER_PRIORITY,
};
