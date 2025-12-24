// ===================================================================
//  CLICK ROUTER — S21 GOD-KERNEL (ABSOLUTE FINAL FORM)
//  • S16.3 / S20'deki TÜM işlevler KORUNDU (ZERO DELETE, ZERO DRIFT)
//  • Poison-proof sanitize (input hijyeni güçlendirildi)
//  • Quantum dedupe v2 (provider + product + device + referral + price)
//  • Multi-key rate limit (IP + deviceId + userId + fingerprint)
//  • Provider canonical normalizer (providerMasterS9)
//  • UA dual fingerprint (raw UA + SHA256 + deviceHash)
//  • IPv6 / Proxy chain real-client extractor (CF-aware)
//  • JSON quantum-safe wrapper (double-try shield)
//  • Future-ready async rewardHook (yorum satırında hazır)
// ===================================================================

import express from "express";
import Click from "../models/Click.js";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

import {
  normalizeProviderKeyS9 as normalizeProviderKey,
} from "../core/providerMasterS9.js";

const router = express.Router();

// ===================================================================
//  SAFE HELPERS (S21 Hardened)
// ===================================================================
function safeStr(v, max = 500) {
  if (v == null) return "";
  try {
    let s = String(v);

    // Temel trim
    s = s.trim();

    // Basit injection / XSS karakter temizliği
    s = s.replace(/[<>;$\0]/g, "");
    // Kontrol karakterleri
    s = s.replace(/[\x00-\x1F\x7F]/g, "");

    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch {
    return "";
  }
}

function safeNumber(n, fallback = 0) {
  const num = Number(n);
  if (!Number.isFinite(num) || Number.isNaN(num)) return fallback;
  if (num < 0) return 0;
  if (num > 1e9) return 1e9; // uçuk fiyatları kırp
  return num;
}

function safeProvider(p) {
  if (!p) return "";
  const raw = String(p).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, "");
  try {
    if (typeof normalizeProviderKey === "function") {
      const n = normalizeProviderKey(raw);
      return n || raw;
    }
  } catch {
    // provider master patlasa bile çökmesin
  }
  return raw;
}

// IPv6 / Proxy-aware Real IP (S21 hardened, CF aware)
function getRealIP(req) {
  try {
    let ip =
      req.headers["cf-connecting-ip"] ||
      (typeof req.headers["x-forwarded-for"] === "string" &&
        req.headers["x-forwarded-for"].split(",")[0].trim()) ||
      req.socket?.remoteAddress ||
      req.ip ||
      "0.0.0.0";

    if (typeof ip === "string" && ip.startsWith("::ffff:")) {
      ip = ip.slice(7);
    }

    return ip || "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

// UA hash (S20 → S21 aynı mantık, yorum güçlendirme)
function hashUA(ua = "") {
  try {
    return crypto.createHash("sha256").update(String(ua)).digest("hex");
  } catch {
    return null;
  }
}

// SECOND fingerprint: UA + IP hash (anti-spoof)
function hashDevice(uaHash, ip) {
  try {
    return crypto
      .createHash("sha256")
      .update((uaHash || "") + "|" + (ip || ""))
      .digest("hex");
  } catch {
    return null;
  }
}

// Ek fingerprint: UA + lang + ip (future-proof)
function buildFingerprint(uaRaw, ip, acceptLang = "") {
  try {
    return crypto
      .createHash("sha256")
      .update(
        [
          String(uaRaw || ""),
          String(acceptLang || ""),
          String(ip || ""),
        ].join("|")
      )
      .digest("hex");
  } catch {
    return null;
  }
}

// JSON-safe wrapper (S21 shield v2)
function safeJson(res, data, status = 200) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // İlk deneme
    return res.status(status).json(data);
  } catch (err) {
    console.error("❌ safeJson primary ERROR:", err);
    try {
      // İkinci deneme → sadeleştirilmiş payload
      return res.status(500).json({
        ok: false,
        error: "JSON_SERIALIZATION_ERROR",
      });
    } catch (err2) {
      console.error("❌ safeJson secondary ERROR:", err2);
      // En kötü durumda process çökmesin
    }
  }
}

// ===================================================================
//  RATE LIMIT MAP (IP + deviceId + userId + fingerprint) — S21
// ===================================================================
const CLICK_RATE = new Map();

function rateKey(ip, userId, deviceId, fp) {
  return `${ip}:${userId || "u0"}:${deviceId || "d0"}:${fp || "fp0"}`;
}

function rateLimitClick(
  ip,
  userId,
  deviceId,
  fp,
  limit = 160,
  windowMs = 60000
) {
  const key = rateKey(ip, userId, deviceId, fp);
  const now = Date.now();
  const entry = CLICK_RATE.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  CLICK_RATE.set(key, entry);

  return {
    allowed: entry.count <= limit,
    count: entry.count,
    retryMs: entry.resetAt - now,
  };
}

// ===================================================================
//  QUANTUM DEDUPE SHIELD (S21) — micro double-click engelleyici
// ===================================================================
const DEDUPE_MAP = new Map(); // hash → lastTs

function dedupeShield(key, ttl = 350) {
  const now = Date.now();
  const last = DEDUPE_MAP.get(key) || 0;

  if (now - last < ttl) {
    return false; // duplicate
  }
  DEDUPE_MAP.set(key, now);
  return true;
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of DEDUPE_MAP.entries()) {
    if (now - ts > 7000) DEDUPE_MAP.delete(k);
  }
}, 4000).unref?.();

// ===================================================================
//  CLICK REGISTER — S21 GOD-KERNEL
// ===================================================================
router.post("/click", async (req, res) => {
  try {
    const ip = getRealIP(req);
    const uaRaw = safeStr(req.headers["user-agent"] || "", 400);
    const acceptLang = safeStr(req.headers["accept-language"] || "", 100);

    const uaHash = hashUA(uaRaw);
    const deviceHash = hashDevice(uaHash, ip);
    const fingerprint = buildFingerprint(uaRaw, ip, acceptLang);

    // ORIGINAL INPUTS — ZERO DELETE
    // S21: userId önceliği backend (auth middleware) → sonra body fallback
    const backendUserId = safeStr(req.userId || req.user?.id || "", 200);
    const bodyUserId = safeStr(req.body?.userId || "", 200);
    const userId = backendUserId || bodyUserId || "";

    const provider = safeProvider(req.body?.provider);
    const productId = safeStr(req.body?.productId || "", 200);
    const productName = safeStr(req.body?.productName || "", 300);
    const price = safeNumber(req.body?.price, 0);
    const referralCode = safeStr(req.body?.referralCode || "", 200);
    const appliedCouponCode = safeStr(req.body?.appliedCouponCode || "", 200);

    // deviceId: client gönderirse onu kullan, yoksa deviceHash fallback
    const deviceIdRaw = req.body?.deviceId || deviceHash || "";
    const deviceId = safeStr(deviceIdRaw, 200);

    if (!provider) {
      return safeJson(res, { ok: false, error: "Provider missing" }, 400);
    }

    // ===================================================================
    //  QUANTUM DEDUPE (S21) — 350ms double-click engelle
    //  Key → provider + productId + deviceId + referral + price
    // ===================================================================
    const dedupeKey = [
      userId || "u0",
      provider || "p0",
      productId || "pid0",
      deviceId || "dev0",
      referralCode || "ref0",
      String(price || 0),
    ].join("|");

    if (!dedupeShield(dedupeKey, 350)) {
      return safeJson(res, {
        ok: true,
        deduped: true,
        throttled: false,
        message: "Double-click blocked (S21 dedupe).",
      });
    }

    // ===================================================================
    //  RATE LIMIT (S21) — IP + deviceId + userId + fingerprint
    // ===================================================================
    const rl = rateLimitClick(ip, userId, deviceId, fingerprint, 160, 60000);
    if (!rl.allowed) {
      return safeJson(res, {
        ok: true,
        throttled: true,
        deduped: false,
        retryAfterMs: rl.retryMs,
        message: "Click rate throttled (S21 shield).",
      });
    }

    // UUID v4 — güvenli
    const clickId = uuidv4();

    // ===================================================================
    //  ORİJİNAL CLICK KAYDI — ZERO DELETE (alanlar korunuyor)
    // ===================================================================
    const click = await Click.create({
      userId: userId || null,
      provider,
      productId: productId || null,
      productName: productName || "",
      price: price || 0,
      referralCode: referralCode || null,
      appliedCouponCode: appliedCouponCode || null,
      clickId,
      deviceId: deviceId || null,
      ip,
      ua: uaRaw,
      uaHash,
      // S21 ek alanlar (modelde varsa kullanılır, yoksa sessizce yok sayılır)
      fingerprint: fingerprint || null,
      acceptLanguage: acceptLang || null,
    });

    // ===================================================================
    //  BACKGROUND LOG (S16.3 logic KORUNDU + S21 telemetry enhance)
    // ===================================================================
    const logPayload = {
      clickId,
      userId: userId || null,
      provider,
      productId: productId || null,
      ip,
      uaHash,
      deviceHash,
      fingerprint,
      price,
      referralCode: referralCode || null,
      coupon: appliedCouponCode || null,
      throttled: false,
      deduped: false,
      ts: Date.now(),
    };

    // queueMicrotask destek yoksa fallback
    const logTask = () => {
      try {
        console.log("🎯 CLICK_LOG S21:", logPayload);

        // S21: future reward engine integration hook (isteğe bağlı)
        // rewardEngine?.clickHook?.(click);
      } catch {
        // log patlasa bile akış bozulmasın
      }
    };

    if (typeof queueMicrotask === "function") {
      queueMicrotask(logTask);
    } else {
      setImmediate(logTask);
    }

    return safeJson(res, {
      ok: true,
      clickId,
      throttled: false,
      deduped: false,
      message: "Click registered successfully (S21 God-Kernel).",
      // Eski frontend umursamaz ama yeni sistem için meta
      meta: {
        ip,
        hasBackendUser: !!backendUserId,
        fingerprintPresent: !!fingerprint,
      },
    });
  } catch (err) {
    console.error("CLICK ERROR (S21):", err);
    return safeJson(res, { ok: false, error: "Click failed" }, 500);
  }
});

export default router;
