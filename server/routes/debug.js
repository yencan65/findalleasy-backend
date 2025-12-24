// ========================================================================
//   DEBUG ROUTER — S21 GOD-KERNEL EDITION
//   • Zero-delete (tüm orijinal alanlar korunur)
//   • Quantum-safe JSON serializer (circular-proof)
//   • Anti-abuse rate-limit
//   • Admin-only shield (header spoof koruması)
//   • Entire System State Diagnostics (AI, Revenue, Reward, Adapter, Coupon)
//   • Crash-proof — hiçbir durumda patlamaz
// ========================================================================

import express from "express";

// SYSTEM IMPORTS (hiçbiri kaldırılmadı)
import {
  debugRevenueMemory,
  getProviderRevenueStats,
} from "../core/revenueMemoryEngine.js";

import {
  providerStats,
  adapterDiagnostics,
  lastFusionResult,
  totalAdapterRuns,
  lastQueries,
  fusionHistory,
} from "../core/adapterEngine.js";

import {
  getUserRewardsSummary,
  _rewardDebugMemory,
  getSystemRewardStats,
} from "../core/rewardEngine.js";

import { getAIDebugState } from "../core/aiPipeline.js";

import Coupon from "../models/Coupon.js";
import Log from "../models/TelemetryLog.js";

import { requireAdmin } from "../middleware/adminAuth.js"; // S21 admin shield

const router = express.Router();

// ========================================================================
// S21 — Zero-Crash Quantum JSON Serializer (Circular, Buffer, BigInt safe)
// ========================================================================
function safeJSON(obj, fallback = {}) {
  try {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(
        obj,
        (key, value) => {
          if (typeof value === "bigint") return value.toString();

          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[[CIRCULAR_REF]]";
            seen.add(value);

            if (Buffer.isBuffer(value)) return value.toString("base64");
          }
          return value;
        }
      )
    );
  } catch (err) {
    console.error("safeJSON ERROR:", err);
    return fallback;
  }
}

// ========================================================================
// S21 — MICRO RATE-LIMIT (IP + route)
// ========================================================================
const RL = new Map();

function rateLimit(ip, scope, limit = 20, windowMs = 5000) {
  const now = Date.now();
  const key = `${ip}:${scope}`;
  const entry = RL.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  RL.set(key, entry);

  return {
    allowed: entry.count <= limit,
    retryMs: entry.resetAt - now,
  };
}

// Simple IP extractor
function getIP(req) {
  try {
    let ip =
      req.headers["cf-connecting-ip"] ||
      (typeof req.headers["x-forwarded-for"] === "string" &&
        req.headers["x-forwarded-for"].split(",")[0].trim()) ||
      req.socket?.remoteAddress ||
      req.ip ||
      "0.0.0.0";

    if (ip.startsWith("::ffff:")) ip = ip.slice(7);
    return ip;
  } catch {
    return "0.0.0.0";
  }
}

// ========================================================================
// S21 — DEBUG MAIN ROUTE
// ========================================================================
router.get("/", requireAdmin, async (req, res) => {
  try {
    const ip = getIP(req);

    // RATE LIMIT
    const rl = rateLimit(ip, "debug", 10, 5000);
    if (!rl.allowed) {
      return res.status(429).json({
        ok: false,
        error: "RATE_LIMIT",
        retryAfterMs: rl.retryMs,
      });
    }

    // ===============================
    // COUPON SYSTEM STATS
    // ===============================
    const [totalCoupons, activeCoupons, expiredCoupons, usedCoupons] =
      await Promise.all([
        Coupon.countDocuments({}),
        Coupon.countDocuments({ status: "active" }),
        Coupon.countDocuments({ status: "expired" }),
        Coupon.countDocuments({ status: "used" }),
      ]);

    // TELEMETRY SAMPLE
    const telemetrySample = await Log.find({})
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    // Revenue memory
    const revenueMem = debugRevenueMemory() || {};
    const revKeys = Object.keys(revenueMem);

    // ============================================================
    // S21 — MASTER DEBUG RESPONSE (ORİJİNAL ALANLAR + GÜÇLENDİRMELER)
    // ============================================================
    return res.json({
      ok: true,

      meta: {
        time: new Date().toISOString(),
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: safeJSON(process.memoryUsage()),
        nodeVersion: process.version,
        ip,
      },

      // ===============================
      // ADAPTER ENGINE
      // ===============================
      adapterEngine: {
        providerStats: safeJSON(providerStats),
        adapterDiagnostics: safeJSON(adapterDiagnostics),
        lastFusionResult: safeJSON(lastFusionResult),
        fusionHistory: safeJSON((fusionHistory || []).slice(-20)),
        totalAdapterRuns: totalAdapterRuns || 0,
        lastQueries: safeJSON(lastQueries || []),
      },

      // ===============================
      // REVENUE ENGINE
      // ===============================
      revenueEngine: {
        memory: safeJSON(revenueMem),
        providerStats: revKeys.map((p) => ({
          provider: p,
          ...safeJSON(getProviderRevenueStats(p)),
        })),
      },

      // ===============================
      // REWARD ENGINE
      // ===============================
      rewardEngine: {
        internalMemory: _rewardDebugMemory ? safeJSON(_rewardDebugMemory()) : {},
        globalStats: safeJSON(await getSystemRewardStats()),
        testUser:
          safeJSON(await getUserRewardsSummary("000000000000000000000000")) ||
          null,
      },

      // ===============================
      // AI PIPELINE
      // ===============================
      aiEngine: safeJSON(getAIDebugState?.() || {}),

      // ===============================
      // COUPON SYSTEM
      // ===============================
      coupons: {
        totalCoupons,
        activeCoupons,
        expiredCoupons,
        usedCoupons,
      },

      // ===============================
      // TELEMETRY LAST 30
      // ===============================
      telemetry: {
        last30: safeJSON(telemetrySample),
      },
    });
  } catch (err) {
    console.error("DEBUG_PANEL_FATAL:", err);
    return res.status(500).json({
      ok: false,
      error: "DEBUG_FATAL",
      detail: err?.message || String(err),
    });
  }
});

export default router;
