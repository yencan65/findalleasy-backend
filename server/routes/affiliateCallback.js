// ============================================================================
//   AFFILIATE CALLBACK ROUTER — S50++ ABSOLUTE FINAL OMEGA (HARDENED)
//   Zero-crash • Zero-duplication • Anti-fraud • Poison-proof
//   Multi-provider callback (Amazon / Trendyol / HB / AliExpress / Booking)
//   Atomic-ish order creation • Immutable click chain (S50)
//   Full sync with RewardEngine S16 Omega — ZERO BREAKING CHANGE
// ============================================================================

import express from "express";
import crypto from "crypto";
import Click from "../models/Click.js";
import Order from "../models/Order.js";
import { applyRewardsForOrder } from "../core/rewardEngine.js";

const router = express.Router();
const IS_PROD = process.env.NODE_ENV === "production" || false;

// ============================================================================
// SAFE JSON RESPONSE (S50 hardened)
// ============================================================================
function safeJson(res, body, code = 200) {
  try {
    if (res.headersSent) {
      // Artık yapacak bir şey yok, en azından process çökmesin
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(code).json(body);
  } catch (err) {
    console.error("[AFFILIATE_CALLBACK] safeJson ERROR:", err);
    try {
      if (res.headersSent) return;
      return res.status(500).json({
        ok: false,
        error: "JSON_SERIALIZATION_ERROR",
        detail: err?.message || String(err),
      });
    } catch {
      // En kötü senaryoda bile process patlamasın
      return;
    }
  }
}

// ============================================================================
// INPUT SANITIZATION (S50)
// ============================================================================
function clean(v) {
  if (v == null) return null;
  try {
    let s = String(v).trim();
    // Kontrol karakterlerini temizle (log / JSON çöpünü azaltır)
    s = s.replace(/[\x00-\x1F\x7F]/g, "");
    if (s.length > 300) s = s.slice(0, 300);
    return s || null;
  } catch {
    return null;
  }
}

function normalizeStatus(st) {
  if (!st) return "pending";
  const s = String(st).toLowerCase().trim();

  if (
    [
      "paid",
      "approved",
      "confirmed",
      "completed",
      "finished",
      "success",
      "successful",
      "completed_paid",
      "successfully_paid",
    ].includes(s)
  )
    return "paid";

  if (["pending", "waiting", "processing", "in_progress"].includes(s))
    return "pending";

  if (
    [
      "rejected",
      "declined",
      "cancelled",
      "canceled",
      "failed",
      "refunded",
      "chargeback",
    ].includes(s)
  )
    return "rejected";

  return "pending";
}

function safeAmount(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n < 0) return 0;
  // çok uçuk değerleri kırp (mantıklı üst sınır)
  const clamped = n > 1_000_000_000 ? 1_000_000_000 : n;
  return Math.round(clamped * 100) / 100; // 2 decimal
}

// ============================================================================
// S50 FIREWALL — IP-BASED ANTI-FLOOD (multi-callback safe + GC)
// ============================================================================
const floodMap = new Map(); // ip → lastTs
const FLOOD_GAP_MS = 70;
const FLOOD_GC_THRESHOLD = 5000;
const FLOOD_ENTRY_TTL_MS = 5 * 60 * 1000; // 5 dakika

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "0.0.0.0";
}

function gcFloodMap(now) {
  if (floodMap.size <= FLOOD_GC_THRESHOLD) return;
  for (const [ip, ts] of floodMap.entries()) {
    if (now - ts > FLOOD_ENTRY_TTL_MS) {
      floodMap.delete(ip);
    }
  }
}

function firewall(req, res, next) {
  const ip = getIP(req);
  const now = Date.now();

  // DEV ortamında fazla agresif olma
  if (!IS_PROD) {
    return next();
  }

  const last = floodMap.get(ip) || 0;

  if (now - last < FLOOD_GAP_MS) {
    return safeJson(
      res,
      {
        ok: false,
        reason: "ANTI_FLOOD_PROTECTION",
      },
      429
    );
  }

  floodMap.set(ip, now);
  gcFloodMap(now);
  next();
}

// ============================================================================
// S42 — PROVIDER SIGNATURE VALIDATION (HMAC-SHA256, best-effort)
//  - Secret varsa imza zorunlu
//  - Secret yoksa eski davranış korunur (sadece log / bypass)
//  - Gerçek prod için provider dökümanlarına göre netleştirmen gerekir
// ============================================================================

const PROVIDER_SIGNATURE_SECRETS = {
  amazon: process.env.AMAZON_WEBHOOK_SECRET,
  trendyol: process.env.TRENDYOL_WEBHOOK_SECRET,
  hepsiburada: process.env.HEPSIBURADA_WEBHOOK_SECRET,
  aliexpress: process.env.ALIEXPRESS_WEBHOOK_SECRET,
  booking: process.env.BOOKING_WEBHOOK_SECRET,
};

const DEFAULT_AFFILIATE_SECRET = process.env.AFFILIATE_WEBHOOK_SECRET || null;

function getSignatureFromHeaders(req) {
  const candidates = [
    req.headers["x-signature"],
    req.headers["x-webhook-signature"],
    req.headers["x-hmac-signature"],
    req.headers["x-amz-sns-signature"],
    req.headers["x-affiliate-signature"],
  ].filter(Boolean);

  return candidates.length ? String(candidates[0]).trim() : null;
}

function timingSafeEqualStr(a, b) {
  if (a == null || b == null) return false;
  const aStr = String(a);
  const bStr = String(b);
  const aBuf = Buffer.from(aStr);
  const bBuf = Buffer.from(bStr);
  if (aBuf.length !== bBuf.length) return false;
  try {
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function resolveProviderKeyForSignature(rawProvider) {
  if (!rawProvider) return null;
  return String(rawProvider).trim().toLowerCase();
}

// S42 core helper
function buildSignaturePayload(req, body) {
  // Eğer body-parser raw-body’i bir yerde saklıyorsa onu tercih ederiz.
  // (ör: req.rawBody, req.bodyRaw vs.)
  if (req.rawBody && typeof req.rawBody === "string") {
    return req.rawBody;
  }
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody.toString("utf8");
  }

  // Elinde raw yoksa → deterministik JSON.stringify fallback
  try {
    return JSON.stringify(body || {});
  } catch {
    return "";
  }
}

function verifyProviderSignature(providerKey, body, req) {
  const key = resolveProviderKeyForSignature(providerKey);
  const providerSecret = (key && PROVIDER_SIGNATURE_SECRETS[key]) || null;
  const secret = providerSecret || DEFAULT_AFFILIATE_SECRET;

  // Secret tanımlı değilse → signature validation devre dışı, S41 davranışı korunur
  if (!secret) {
    return {
      ok: true,
      mode: "NO_SECRET_CONFIGURED",
    };
  }

  const incomingSig = getSignatureFromHeaders(req);
  if (!incomingSig) {
    return {
      ok: false,
      reason: "MISSING_SIGNATURE_HEADER",
    };
  }

  const payload = buildSignaturePayload(req, body);
  const computed = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  const ok = timingSafeEqualStr(incomingSig, computed);

  if (!ok) {
    return {
      ok: false,
      reason: "INVALID_SIGNATURE",
    };
  }

  return {
    ok: true,
    mode: providerSecret ? "PROVIDER_SECRET" : "DEFAULT_SECRET",
  };
}

// ============================================================================
// 🔥 MAIN CALLBACK ENDPOINT (atomic order + reward sync, S50 hardened)
//   S43 — Reconciliation (late paid callbacks, idempotent reward denemesi)
//   S50 — Multi-click attribution (touchpoint chain)
// ============================================================================
router.post("/callback", firewall, async (req, res) => {
  try {
    const body = req.body || {};

    const clickId = clean(body.clickId);
    const providerOrderId = clean(body.orderId) || clean(body.providerOrderId);
    const status = normalizeStatus(body.status);
    const currency = clean(body.currency) || "TRY";
    const commissionRate =
      body.commissionRate != null ? Number(body.commissionRate) : null;

    const amount = safeAmount(body.amount);

    // ========================================================================
    // 1) CLICK ID ZORUNLU — ÇEKİRDEK KURAL (ZERO BREAKING CHANGE)
    // ========================================================================
    if (!clickId) {
      return safeJson(
        res,
        {
          ok: false,
          error: "MISSING_CLICK_ID",
        },
        400
      );
    }

    // ========================================================================
    // 2) CLICK KAYDI (anti-fraud)
    // ========================================================================
    const click = await Click.findOne({ clickId }).lean();

    if (!click) {
      return safeJson(
        res,
        {
          ok: false,
          error: "CLICK_NOT_FOUND",
          clickId,
        },
        404
      );
    }

    // ========================================================================
    // 3) S42 — SIGNATURE VALIDATION (provider-aware)
    // ========================================================================
    const providerKeyForSig = resolveProviderKeyForSignature(click.provider);
    const sigCheck = verifyProviderSignature(providerKeyForSig, body, req);

    if (!sigCheck.ok) {
      console.warn(
        "[AFFILIATE_CALLBACK] Signature check failed:",
        sigCheck.reason,
        "provider=",
        providerKeyForSig
      );
      return safeJson(
        res,
        {
          ok: false,
          error: "INVALID_SIGNATURE",
          detail: sigCheck.reason || "SIGNATURE_CHECK_FAILED",
        },
        401
      );
    }

    // ========================================================================
    // 4) ORDER ATOMIC LOGIC (davranış korunur)
    //    providerOrderId yoksa bile order yaratılabilir (Amazon senaryosu)
// ========================================================================
    const key = providerOrderId || `auto-${clickId}`;
    let order = await Order.findOne({ providerOrderId: key });

    if (!order) {
      // YENİ ORDER — S50 multi-click alanları ile birlikte
      order = await Order.create({
        userId: click.userId,
        provider: clean(click.provider),
        providerOrderId: key,
        amount,
        currency,
        referredBy: click.referralCode || null,
        commissionRate,
        status,
        paidAt: status === "paid" ? new Date() : null,
        // S50 — Touchpoint chain
        clickId: clickId,
        firstClickId: clickId,
        lastClickId: clickId,
        clickChain: [clickId],
      });
    } else {
      // EXISTING ORDER → UPDATE MODE (S43 + S50)
      order.status = status;
      order.amount = amount || order.amount;
      order.currency = currency || order.currency;

      if (commissionRate != null && Number.isFinite(commissionRate)) {
        order.commissionRate = commissionRate;
      }

      // S50 — Click chain güncelle
      if (clickId) {
        if (!order.firstClickId) {
          order.firstClickId = clickId;
        }
        order.lastClickId = clickId;

        if (!Array.isArray(order.clickChain)) {
          order.clickChain = [];
        }
        if (!order.clickChain.includes(clickId)) {
          order.clickChain.push(clickId);
        }

        // Tekil clickId alanını da güncel tut (backward compatible)
        order.clickId = clickId;
      }

      // S43 — Late paid callback & idempotency pre-mark
      if (status === "paid" && !order.paidAt) {
        order.paidAt = new Date();
      }

      await order.save();
    }

    // ========================================================================
    // 5) S43 — REWARD ENGINE SYNCHRONIZATION (idempotent deneme)
    // ========================================================================
    let rewardApplied = false;
    if (status === "paid") {
      const alreadyRewarded = !!order.rewardedAt;

      if (!alreadyRewarded) {
        try {
          await applyRewardsForOrder(order);
          order.rewardedAt = new Date();
          await order.save();
          rewardApplied = true;
        } catch (err) {
          console.error("[AFFILIATE_CALLBACK] RewardEngine ERROR:", err);
          // Burada fail olsa bile callback JSON olarak dönüyor, process ölmez.
        }
      }
    }

    // ========================================================================
    // 6) RESPONSE
    // ========================================================================
    return safeJson(res, {
      ok: true,
      message: "Order processed",
      orderId: order._id,
      providerOrderId: order.providerOrderId,
      status,
      meta: {
        rewardApplied,
        hasRewardedAt: !!order.rewardedAt,
        clickChainLength: Array.isArray(order.clickChain)
          ? order.clickChain.length
          : 0,
        sigMode: sigCheck.mode || null,
      },
    });
  } catch (err) {
    console.error("[AFFILIATE_CALLBACK] ERROR:", err);
    return safeJson(
      res,
      {
        ok: false,
        error: "CALLBACK_FAILED",
        detail: err?.message || String(err),
      },
      500
    );
  }
});

// ============================================================================
// EXPORT
// ============================================================================
export default router;
