// server/core/learningInfluence.js
// =============================================================
// S16 Learning Influence Layer
// Kullanıcı + Global öğrenme → Provider & Category Skorları
// ZERO breaking change — sadece puan ekler
// =============================================================

import { getDb } from "../db.js";

// ------------------------------
// Utility
// ------------------------------
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ------------------------------
// S16: Kullanıcı bazlı provider eğilimi
// ------------------------------
export async function getUserProviderBias(userId) {
  try {
    const db = await getDb();
    const col = db.collection("user_learning");

    const docs = await col
      .find({ userId })
      .project({ lastProvider: 1, clickCount: 1 })
      .toArray();

    const bias = {};

    for (const d of docs) {
      if (!d.lastProvider) continue;

      const p = String(d.lastProvider).toLowerCase();
      const weight = clamp(d.clickCount || 1, 1, 20);

      bias[p] = (bias[p] || 0) + weight;
    }

    return bias; // ör: { trendyol: 12, amazon: 5 }
  } catch {
    return {};
  }
}

// ------------------------------
// S16: Global provider trendi
// (Tüm kullanıcıların davranışına göre)
// ------------------------------
export async function getGlobalProviderTrend() {
  try {
    const db = await getDb();
    const events = db.collection("user_learning_events");

    const pipeline = [
      {
        $group: {
          _id: "$provider",
          clicks: { $sum: { $cond: [{ $eq: ["$eventType", "click"] }, 1, 0] } },
          impressions: {
            $sum: { $cond: [{ $eq: ["$eventType", "impression"] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          score: {
            $divide: ["$clicks", { $add: ["$impressions", 1] }], // CTR benzeri
          },
        },
      },
    ];

    const arr = await events.aggregate(pipeline).toArray();
    const result = {};

    for (const r of arr) {
      const p = String(r._id || "unknown").toLowerCase();
      result[p] = clamp(r.score || 0, 0, 1);
    }

    return result; // ör: { trendyol: 0.23, amazon: 0.11 }
  } catch {
    return {};
  }
}

// ------------------------------
// S16: Category preference
// ------------------------------
export async function getUserCategoryBias(userId) {
  try {
    const db = await getDb();
    const col = db.collection("user_learning");

    const docs = await col
      .find({ userId })
      .project({ category: 1, clickCount: 1 })
      .toArray();

    const bias = {};

    for (const d of docs) {
      const c = String(d.category || "").toLowerCase();
      if (!c) continue;

      const w = clamp(d.clickCount || 1, 1, 30); // kategori davranışı daha güçlü
      bias[c] = (bias[c] || 0) + w;
    }

    return bias;
  } catch {
    return {};
  }
}

// ------------------------------
// S16: Fusion skorlama — Provider + Category + Global Trend
// ------------------------------
export async function getLearningBoost({ userId, provider, category }) {
  const p = String(provider || "").toLowerCase();
  const c = String(category || "").toLowerCase();

  const [userProviders, userCats, globalTrend] = await Promise.all([
    getUserProviderBias(userId),
    getUserCategoryBias(userId),
    getGlobalProviderTrend(),
  ]);

  // kullanıcı geçmişi etkisi
  const userProviderScore = userProviders[p] || 0;
  const userCategoryScore = userCats[c] || 0;

  // global trend etkisi
  const globalScore = (globalTrend[p] || 0) * 5;

  // final boost
  const boost = userProviderScore * 0.4 + userCategoryScore * 0.3 + globalScore;

  return clamp(boost, 0, 40);
}
