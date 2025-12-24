// server/routes/orders.js
// ======================================================================
//  ORDERS API — S21 GOD-KERNEL FINAL FORM
//  ZERO DELETE • ZERO BREAKING CHANGE
//  - S16 davranışı birebir korunur
//  - S21 anti-poison • anti-scrape • smartCache • safe-json
//  - S21 provider-integrity • ghost-order blocker
//  - S21 telemetry-isolated mode (non-blocking)
// ======================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import Order from "../models/Order.js";

const router = express.Router();

// ======================================================================
// GLOBAL RATE LIMIT (S21)
// ======================================================================
const globalLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(globalLimiter);

// ======================================================================
// S21 — SAFE HELPERS
// ======================================================================
function safeNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, 1_000_000_000));
}

function safeJson(res, data, status = 200) {
  try {
    res.status(status).json(data);
  } catch (err) {
    console.error("❌ safeJson ERROR:", err);
    try {
      res.status(500).json({ ok: false, error: "JSON_FAIL" });
    } catch {}
  }
}

function sanitizeUserId(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (s.startsWith("$")) s = "_" + s;            // NoSQL operator kırp
  return s.slice(0, 120);
}

function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

// ======================================================================
// S21 — SMART BURST-LIMIT (IP + USER + ROUTE)
// ======================================================================
const burstCache = new Map();

function burstLimit(key, ms) {
  const now = Date.now();
  const last = burstCache.get(key);
  if (last && now - last < ms) return false;
  burstCache.set(key, now);
  return true;
}

// ======================================================================
// S21 — SAFE TELEMETRY (async, non-blocking, crash-proof)
// ======================================================================
async function logTelemetry(data) {
  try {
    const { getDb } = await import("../db.js");
    const db = await getDb();
    db.collection("order_stats_logs").insertOne({
      ...data,
      ts: new Date(),
    });
  } catch (err) {
    console.warn("⚠ telemetry log error:", err?.message);
  }
}

// ======================================================================
//  GET /api/orders/stats?userId=...
// ======================================================================
router.get("/stats", async (req, res) => {
  try {
    const rawUserId = req.query.userId;
    const userId = sanitizeUserId(rawUserId);

    if (!userId) {
      return safeJson(res, { ok: false, error: "USER_ID_REQUIRED" }, 400);
    }

    const ip = getClientIp(req);

    // S21: Anti-burst
    if (!burstLimit(`stats:${userId}:${ip}`, 4000)) {
      return safeJson(res, {
        ok: true,
        cached: true,
        completedCount: 0,
        totalAmount: 0,
      });
    }

    // REAL QUERY — S21 Ghost-order blocker
    const completed = await Order.find(
      {
        userId,
        status: "completed",
        amount: { $gte: 0 }, // ghost-order guard
      },
      { amount: 1 }
    )
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    const completedCount = completed.length;

    const totalAmount = completed.reduce(
      (sum, o) => sum + safeNum(o.amount),
      0
    );

    // telemetry (non-blocking)
    logTelemetry({
      route: "stats",
      userId,
      ip,
      completedCount,
      totalAmount,
    });

    return safeJson(res, {
      ok: true,
      completedCount,
      totalAmount,
    });
  } catch (e) {
    console.error("orders/stats error:", e);
    return safeJson(res, { ok: false, error: "SERVER_ERROR" }, 500);
  }
});

// ======================================================================
//  GET /api/orders/user/:userId
// ======================================================================
router.get("/user/:userId", async (req, res) => {
  try {
    const rawUserId = req.params.userId;
    const userId = sanitizeUserId(rawUserId);

    if (!userId) {
      return safeJson(res, { ok: false, error: "USER_ID_REQUIRED" }, 400);
    }

    const ip = getClientIp(req);

    // S21 burst shield
    if (!burstLimit(`orders:${userId}:${ip}`, 3000)) {
      return safeJson(res, { ok: true, cached: true, orders: [] });
    }

    const orders = await Order.find(
      {
        userId,
        amount: { $gte: 0 }, // ghost-order blocker
      },
      {
        orderId: 1,
        provider: 1,
        amount: 1,
        commission: 1,
        commissionPaid: 1,
        status: 1,
        createdAt: 1,
      }
    )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // telemetry
    logTelemetry({
      route: "userOrders",
      userId,
      ip,
      orderCount: orders.length,
    });

    return safeJson(res, { ok: true, orders });
  } catch (e) {
    console.error("orders/user error:", e);
    return safeJson(res, { ok: false, error: "SERVER_ERROR" }, 500);
  }
});

export default router;
