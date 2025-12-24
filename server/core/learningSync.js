// server/core/learningSyncEngine.js
// ======================================================================
//  FAE LEARNING SYNC — S14.2 QUANTUM SYNC ENGINE
//  ZERO-DELETE · ZERO-DATA-LOSS · DIFF-BASED · ATOMIC BULK PIPELINE
//  Compatible with S14.2 Memory Engine (longTermAffinity, heatMatrix,
//  patternCurve, recentPriceAvg, trustScore quantum drift, etc.)
// ======================================================================

import { memory } from "./learningMemory.js";
import { getDb } from "../db.js";

// ===============================================================
// HELPERS — S14 EXPANDED
// ===============================================================

// Minimal profile validator
function isValidProfile(p) {
  if (!p || typeof p !== "object") return false;

  // Core S11 keys
  const baseKeys = ["queries", "providerWeight", "categoryWeight"];
  for (const key of baseKeys) {
    if (!p[key]) return false;
  }

  // S14 extended keys (optional but validated)
  if (!p.longTermAffinity) return false;
  if (!p.heatMatrix) return false;
  if (!Array.isArray(p.patternCurve)) return false;

  return true;
}

// S14 Repairer
function repairProfile(p) {
  const repaired = {
    queries: p.queries || [],
    providerWeight: p.providerWeight || {},
    categoryWeight: p.categoryWeight || {},
    priceSensitivity: p.priceSensitivity ?? 1.0,
    longTermAffinity: p.longTermAffinity || {},
    heatMatrix: p.heatMatrix || {},
    patternCurve: Array.isArray(p.patternCurve) ? p.patternCurve : [],
    avgClickPrice: p.avgClickPrice ?? null,
    recentPriceAvg: p.recentPriceAvg ?? null,
    trustScore: p.trustScore ?? 0.88,
    preferredSources: p.preferredSources || [],
    clickMeta: Array.isArray(p.clickMeta) ? p.clickMeta : [],
    clicks: p.clicks ?? 0,
    meta: {
      ...(p.meta || {}),
      repairedAt: new Date().toISOString(),
    },
  };

  return repaired;
}

// Deep diff
function computeDiff(local, remote) {
  const changes = {};
  let hasChanges = false;

  for (const key of Object.keys(local)) {
    const l = local[key];
    const r = remote ? remote[key] : undefined;

    const eq =
      typeof l === "object"
        ? JSON.stringify(l) === JSON.stringify(r)
        : l === r;

    if (!eq) {
      changes[key] = l;
      hasChanges = true;
    }
  }
  return hasChanges ? changes : null;
}

// ===============================================================
// MAIN SYNC ENGINE — S14 DIFF-BASED SYNC
// ===============================================================
export async function syncLearningToMongo() {
  let db, col;

  try {
    db = await getDb();
    col = db.collection("user_learning");
  } catch (err) {
    console.error("❌ MongoDB bağlantı hatası:", err.message);
    return;
  }

  const ops = [];
  let total = 0;
  let changed = 0;

  for (const [userId, localProfile] of memory.entries()) {
    total++;
    if (!userId || typeof userId !== "string") continue;

    if (!localProfile || typeof localProfile !== "object") continue;

    // Validasyon / tamir
    let profile = localProfile;
    if (!isValidProfile(profile)) {
      profile = repairProfile(profile);
      console.warn(`⚠️ Profil tamir edildi → ${userId}`);
    }

    // Remote fetch (for diff-based sync)
    let remote = null;
    try {
      remote = await col.findOne({ userId });
    } catch {
      remote = null;
    }

    const diff = computeDiff(profile, remote);

    // Sync gerekmez
    if (!diff) continue;

    changed++;

    diff.meta = {
      ...(profile.meta || {}),
      lastLocalUpdate: new Date().toISOString(),
      quantumStamp: "S14.2-QM",
    };

    ops.push({
      updateOne: {
        filter: { userId },
        update: {
          $set: diff,
          $currentDate: { lastSync: true },
        },
        upsert: true,
      },
    });
  }

  if (ops.length === 0) {
    console.log("ℹ️ Learning Sync: Gönderilecek değişiklik yok.");
    return;
  }

  // BULK SAFE WRITE
  try {
    const t0 = Date.now();
    const result = await col.bulkWrite(ops, {
      ordered: false,
      bypassDocumentValidation: true,
    });
    const ms = Date.now() - t0;

    console.log(
      `✅ S14 Learning Sync OK → ${changed} / ${total} kullanıcı güncellendi (${ms}ms)`
    );

    // Slow-sync detection
    if (ms > 1500) {
      console.warn("⚠️ SYNC YAVAŞ → Mongo index veya load kontrolü önerilir.");
    }
  } catch (err) {
    console.error("❌ Bulk sync error:", err.message);
  }
}
