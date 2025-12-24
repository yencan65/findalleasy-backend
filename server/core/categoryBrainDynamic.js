// server/core/categoryBrainDynamic.js
// ======================================================================
//  CATEGORY BRAIN — S9.9 NEURO-FUSION (S100 SAFE MODE)
//  - ZERO DELETE
//  - ÜRÜN GÜVENLİ MODU (default always product)
//  - Softmax sonrası güvenlik
//  - Yalancı sinyal bastırıcı
// ======================================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { inferCategory as inferBase, inferAllCategories } from "./categoryBrain.js";

// ------------------------------------------------------------
// LOG DIRECTORY
// ------------------------------------------------------------
const LOG_DIR = path.join(process.cwd(), "brain_logs");

try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}

// Weight file
const WEIGHT_FILE = path.join(LOG_DIR, "dynamicWeights.json");

// Default weights (start point)
let dynamicWeights = {
  vision: 2.2,       // düşürüldü
  query: 1.6,        // düşürüldü
  provider: 1.2,     // düşürüldü
  drift: 0.8,        // düşürüldü
  stability: 1,
  lastUpdated: Date.now(),
};

// ------------------------------------------------------------
// LOAD SAVED WEIGHTS (self-healing)
// ------------------------------------------------------------
try {
  if (fs.existsSync(WEIGHT_FILE)) {
    const saved = JSON.parse(fs.readFileSync(WEIGHT_FILE, "utf8"));
    if (saved && typeof saved === "object") {
      dynamicWeights = { ...dynamicWeights, ...saved };
    }
  }
} catch {
  dynamicWeights = { ...dynamicWeights, lastUpdated: Date.now() };
}

// ============================================================
// LOG FUNCTION
// ============================================================
export function logCategorySignal({ query, providers, vision, chosen }) {
  try {
    const entry = {
      query,
      providers,
      vision,
      chosen,
      timestamp: Date.now(),
    };

    const file = path.join(
      LOG_DIR,
      crypto.randomBytes(6).toString("hex") + ".json"
    );
    fs.writeFile(file, JSON.stringify(entry, null, 2), () => {});
  } catch {}
}

// ============================================================
// EMBEDDING SIMILARITY (S6 normalized)
// ============================================================
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length || a.length === 0) return 0;

  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const ma = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const mb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));

  if (ma * mb === 0) return 0;

  return dot / (ma * mb);
}

export function getEmbeddingCategoryBoost(queryEmbedding, categoryEmbeddings) {
  let bestCat = null;
  let bestScore = 0;

  for (const cat in categoryEmbeddings) {
    const sim = cosineSim(queryEmbedding, categoryEmbeddings[cat]) || 0;
    if (sim > bestScore) {
      bestScore = sim;
      bestCat = cat;
    }
  }

  const score = Math.min(Math.max(bestScore, 0), 1);

  return { bestCat, score };
}

// ============================================================
// UPDATE WEIGHTS — S9 dynamic learning
// ============================================================
export function updateDynamicWeights() {
  let files = [];
  try {
    files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  if (files.length < 60) return;

  let visionHits = 0, visionTotal = 0;
  let queryHits = 0, queryTotal = 0;

  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(LOG_DIR, f)));
      const all = inferAllCategories(entry);
      const chosen = entry.chosen;
      if (!chosen) continue;

      if (entry.vision?.length > 0) {
        visionTotal++;
        if (all[chosen]) visionHits++;
      }

      if (entry.query && entry.query.length > 1) {
        queryTotal++;
        if (all[chosen]) queryHits++;
      }
    } catch {}
  }

  const vRate = visionTotal ? visionHits / visionTotal : 0.5;
  const qRate = queryTotal ? queryHits / queryTotal : 0.5;

  const sigmoid = (x) => 1 / (1 + Math.exp(-x));

  dynamicWeights.vision += (sigmoid(vRate * 2 - 1) - 0.5) * 0.15;
  dynamicWeights.query += (sigmoid(qRate * 2 - 1) - 0.5) * 0.12;

  for (const k of ["vision", "query"]) {
    dynamicWeights[k] = Math.min(Math.max(dynamicWeights[k], 0.5), 4);
  }

  dynamicWeights.lastUpdated = Date.now();

  try {
    fs.writeFileSync(WEIGHT_FILE, JSON.stringify(dynamicWeights, null, 2));
  } catch {}
}

// ============================================================
// SOFTMAX (S7)
// ============================================================
function softmax(scores) {
  const vals = Object.values(scores);
  const max = Math.max(...vals);

  const exp = {};
  let sum = 0;

  for (const k in scores) {
    const v = Math.exp(scores[k] - max);
    exp[k] = v;
    sum += v;
  }

  const out = {};
  for (const k in exp) out[k] = exp[k] / sum;
  return out;
}

// ============================================================
// MAIN — S9.9 Neuro-Fusion Category Inference
// ============================================================
export function inferCategoryS5({ query, providers = [], vision = [] }) {
  const base = inferBase({ query, providers, vision });

  const scores = inferAllCategories({ query, providers, vision }) || {};

  if (Object.keys(scores).length === 0) {
    return base || "product";
  }

  const weighted = {};
  for (const cat in scores) {
    const baseScore = scores[cat];

    // ÜRÜN GÜVENLİ MODU: product & electronics ağırlığı hafif artırıldı
    const productBoost = cat === "product" ? 1 : 0;
    const electronicsBoost = cat === "electronics" ? 0.6 : 0;

    weighted[cat] =
      baseScore * 1
      + dynamicWeights.query
      + (vision.length > 0 ? dynamicWeights.vision : 0)
      + productBoost
      + electronicsBoost;
  }

  const probs = softmax(weighted);

  const winner = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];

  // S100 GÜVENLİK:
  const maxProb = Math.max(...Object.values(probs));

  // Eğer model aşırı kararsızsa → product
  if (maxProb < 0.35) return "product";

  // Eğer winner travel / lawyer / estate değilse → product ağırlığı tekrar kontrol et
  const STRONG = ["flight", "hotel", "car_rental", "tour", "estate", "lawyer", "health", "checkup"];

  if (!STRONG.includes(winner)) {
    return "product";
  }

  // Her şey netse → winner'ı döndür
  return winner || "product";
}
