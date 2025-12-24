// server/routes/orderCallback.js
// ======================================================================
//  ORDER CALLBACK — S21 GOD-KERNEL FINAL OMEGA
//  ZERO DELETE • ZERO BREAKING CHANGE
//  - S10.2 + S16 davranışları %100 korunur
//  - S20 Fraud Shield • S21 Idempotent Reward • S50 ClickChain
//  - HMAC Signature (opsiyonel, secret varsa zorunlu)
//  - Multi-rate-limit: IP + provider + orderId
//  - JSON-safe response, poison-proof sanitize
// ======================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

import {
  applyRewardsForOrder,
  applyRewardsForOrderLegacyBalance,
} from "../core/rewardEngine.js";

import { normalizeProviderKeyS9 } from "../core/providerMasterS9.js";

import Order from "../models/Order.js";
import Click from "../models/Click.js";

const router = express.Router();

// ======================================================================
// S21 — Hardened Sanitizers
// ======================================================================
function safeStr(v, max = 200) {
  if (v == null) return "";
  let s = String(v).trim();
  if (s.startsWith("$")) s = "_" + s;          // NoSQL injection guard
  s = s.replace(/[<>]/g, "");                   // XSS kırpma
  s = s.replace(/[\x00-\x1F\x7F]/g, "");        // kontrol karakteri sil
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function safeNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, 1_000_000_000));
}

function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function safeJson(res, body, status = 200) {
  try {
    return res.status(status).json(body);
  } catch {
    return res.status(500).json({ ok: false, error: "JSON_FAIL" });
  }
}

// ======================================================================
// S21 — Rate Limit (IP + provider)
// ======================================================================
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(limiter);

// Deep RL — abuse riskine karşı
const RL = new Map();
function deepRL(ip, provider, orderId) {
  const key = `${ip}:${provider}:${orderId}`;
  const now = Date.now();
  const ent = RL.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > ent.resetAt) {
    ent.count = 0;
    ent.resetAt = now + 60000;
  }
  ent.count++;
  RL.set(key, ent);
  return ent.count <= 100;
}

// ======================================================================
// S21 — Signature Validation (opsiyonel → secret tanımlıysa zorunlu)
// ======================================================================
const CALLBACK_SECRET = process.env.FAE_CALLBACK_SECRET || null;

function getHeaderSignature(req) {
  return (
    req.headers["x-signature"] ||
    req.headers["x-webhook-signature"] ||
    req.headers["x-hmac-signature"] ||
    null
  );
}

function verifySignature(payload, incoming) {
  if (!CALLBACK_SECRET) return true; // secret yok → validation off

  if (!incoming) return false;

  const json = JSON.stringify(payload || {});
  const expected = crypto
    .createHmac("sha256", CALLBACK_SECRET)
    .update(json)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(incoming),
    Buffer.from(expected)
  );
}

// ======================================================================
//  COMMISSION / PROVIDER RULES
// ======================================================================
const COMMISSIONABLE_PROVIDERS = [
  "amazon",
  "trendyol",
  "hepsiburada",
  "aliexpress",
  "booking",
];

const SELF_BLOCK_LIST = ["trendyol"];

// ======================================================================
//  MAIN CALLBACK — S21 GOD-KERNEL
// ======================================================================
router.post("/", async (req, res) => {
  try {
    const rawBody = req.body || {};
    console.log("📦 CALLBACK RAW (S21) →", rawBody);

    const incomingSig = getHeaderSignature(req);

    // Signature varsa doğrula
    if (CALLBACK_SECRET && !verifySignature(rawBody, incomingSig)) {
      return safeJson(res, {
        ok: false,
        error: "INVALID_SIGNATURE",
      }, 401);
    }

    // Extract
    const orderId = safeStr(rawBody.orderId);
    const provider = safeStr(rawBody.provider);
    const providerKey = normalizeProviderKeyS9(provider);

    if (!orderId || !providerKey) {
      return safeJson(res, {
        ok: false,
        error: "INVALID_DATA",
      }, 400);
    }

    if (!deepRL(getClientIp(req), providerKey, orderId)) {
      return safeJson(res, { ok: false, error: "RL_BLOCK" }, 429);
    }

    // Provider whitelist
    if (!COMMISSIONABLE_PROVIDERS.includes(providerKey)) {
      return safeJson(res, {
        ok: false,
        error: "NOT_COMMISSIONABLE",
      });
    }

    // Affiliate ID doğrulama
    const SYSTEM_AFF =
      process.env.FAE_AFFILIATE_ID || process.env.AFF_ID || null;

    if (SYSTEM_AFF && safeStr(rawBody.affiliateId) !== SYSTEM_AFF) {
      return safeJson(res, {
        ok: false,
        error: "AFFILIATE_NOT_MATCHED",
      });
    }

    if (rawBody.commissionPaid !== true) {
      return safeJson(res, {
        ok: false,
        error: "COMMISSION_NOT_PAID",
      });
    }

    // CLICK → USER resolve
    let userId = null;
    const clickId = safeStr(rawBody.clickId);

    if (clickId) {
      const click = await Click.findOne({ clickId }).lean();
      if (click?.userId) userId = click.userId;
    }

    // Token fallback
    if (!userId && rawBody.userToken) {
      const token = String(rawBody.userToken);
      const pos = token.indexOf("-");
      if (pos > 0) userId = token.slice(0, pos);
    }

    if (!userId) {
      return safeJson(res, {
        ok: false,
        error: "USER_NOT_FOUND",
      });
    }

    // FRAUD SHIELD
    if (SELF_BLOCK_LIST.includes(providerKey)) {
      const count = await Click.countDocuments({ userId, provider: providerKey });
      if (count > 20) {
        return safeJson(res, { ok: false, error: "SELF_AFFILIATE_RISK" });
      }
    }

    // ==================================================================
    // ORDER UPSERT + S50 CLICK-CHAIN
    // ==================================================================

    const order = await Order.findOne({ orderId });

    const update = {
      provider: providerKey,
      orderId,
      userId,
      amount: safeNum(rawBody.amount),
      commission: safeNum(rawBody.commission),
      commissionRate: safeNum(rawBody.commissionRate),
      currency: safeStr(rawBody.currency || "TRY", 10),
      affiliateId: safeStr(rawBody.affiliateId),
      commissionPaid: true,
      clickId,
      ip: getClientIp(req),
      ua: req.headers["user-agent"] || "",
      updatedAt: new Date(),
    };

    // Yeni order
    if (!order) {
      update.firstClickId = clickId || null;
      update.lastClickId = clickId || null;
      update.clickChain = clickId ? [clickId] : [];
      update.paidAt = new Date();

      const savedOrder = await Order.create(update);

      // REWARD (idempotent → rewardedAt yok)
      const reward = await applyRewardsForOrder(savedOrder);

      await rawLog(update, reward);

      return safeJson(res, {
        ok: true,
        provider: providerKey,
        order: savedOrder,
        reward,
      });
    }

    // EXISTING ORDER → update
    if (clickId) {
      if (!order.firstClickId) order.firstClickId = clickId;
      order.lastClickId = clickId;

      if (!Array.isArray(order.clickChain)) order.clickChain = [];
      if (!order.clickChain.includes(clickId)) order.clickChain.push(clickId);
    }

    order.amount = update.amount;
    order.commission = update.commission;
    order.commissionRate = update.commissionRate;
    order.currency = update.currency;
    order.commissionPaid = true;
    order.updatedAt = update.updatedAt;
    order.ua = update.ua;
    order.ip = update.ip;

    if (!order.paidAt) order.paidAt = new Date();

    await order.save();

    // Reward idempotency
    let reward = null;
    if (!order.rewardedAt) {
      reward = await applyRewardsForOrder(order);
      order.rewardedAt = new Date();
      await order.save();
    }

    await rawLog(update, reward);

    return safeJson(res, {
      ok: true,
      provider: providerKey,
      order,
      reward,
    });

  } catch (err) {
    console.error("❌ CALLBACK ERROR S21:", err);
    return safeJson(res, { ok: false, error: err?.message }, 500);
  }
});

// ======================================================================
// RAW LOG (S21): DB'ye gönder
// ======================================================================
async function rawLog(payload, reward) {
  try {
    const { getDb } = await import("../db.js");
    const db = await getDb();
    const col = db.collection("order_callbacks");
    await col.insertOne({
      ...payload,
      reward,
      createdAt: new Date(),
    });
  } catch (err) {
    console.warn("⚠ RAW LOG ERROR:", err);
  }
}

export default router;
