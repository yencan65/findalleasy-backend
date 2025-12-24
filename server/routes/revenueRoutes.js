// ======================================================================
//  S50 ABSOLUTE-STEEL REVENUE ENGINE ROUTER — FINAL OMEGA
//  • S16 / S40++ mantık %100 KORUNUR (ZERO BREAKING CHANGE)
//  • Body hardening + provider normalize + strict type hijyeni
//  • IP / UA hash / referer / userId sinyalleri genişletildi
//  • Mini-GC rate-limit (IP + provider) — memory şişmesini frenler
//  • Raw log helper → tek noktadan DB erişimi (failover shield)
//  • CorrelationId ile uçtan uca trace edilebilirlik
// ======================================================================

import express from "express";
import crypto from "crypto";
import {
  recordClick,
  recordConversion,
  getProviderRevenueStats,
  getAllProviderStats,
} from "../core/revenueMemoryEngine.js";
import { normalizeProviderKeyS9 } from "../core/providerMasterS9.js";

const router = express.Router();

// ======================================================================
//  S50 — SAFE HELPERS (XSS / Noisy Input / UA Hash / Body Guard)
// ======================================================================
function safeStr(v, max = 120) {
  try {
    if (v == null) return "";
    let s = String(v).trim();

    // Basit injection / XSS kırpma
    s = s.replace(/[<>$;{}]/g, "");

    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch {
    return "";
  }
}

function safeNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n;
}

function hashUA(req) {
  try {
    const ua = String(req.headers["user-agent"] || "");
    if (!ua) return null;
    return crypto.createHash("sha256").update(ua).digest("hex");
  } catch {
    return null;
  }
}

function getClientIp(req) {
  // Cloudflare & proxy zincirleri için genişletilmiş IP tespiti
  try {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();

    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.trim()) {
      const first = xf.split(",")[0].trim();
      if (first) return first;
    }

    return (
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      req.ip ||
      "0.0.0.0"
    );
  } catch {
    return "0.0.0.0";
  }
}

function getReferer(req) {
  try {
    const ref = req.headers.referer || req.headers.referrer;
    return safeStr(ref || "", 300);
  } catch {
    return "";
  }
}

function safeBody(req) {
  const b = (req && req.body) || {};
  if (!b || typeof b !== "object" || Array.isArray(b)) return {};

  // Yalnızca beklenen alanları shallow kopyala (noise azaltma)
  const out = {
    provider: b.provider,
    price: b.price,
    clickId: b.clickId,
    userToken: b.userToken,
    affId: b.affId,
    affiliateId: b.affiliateId,
    amount: b.amount,
    rate: b.rate,
    userId: b.userId,
    orderId: b.orderId,
  };

  // Eski sürümler için extra alanlar (şema genişletme ama bozmadan)
  if (b.correlationId) out.correlationId = b.correlationId;

  return out;
}

function buildCorrelationId() {
  try {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  try {
    return crypto.randomBytes(16).toString("hex");
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

// ======================================================================
//  S50 — RATE LIMIT (per-IP + per-provider) + Mini GC
// ======================================================================
const RL = new Map();

function rateLimit(ip, provider, limit = 120, windowMs = 60_000) {
  const key = `${ip}:${provider || "unknown"}`;
  const now = Date.now();
  const entry = RL.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  RL.set(key, entry);

  // Mini GC – %1 ihtimalle süresi dolanları temizle
  if (Math.random() < 0.01) {
    for (const [k, v] of RL.entries()) {
      if (now > v.resetAt) RL.delete(k);
    }
  }

  return {
    allowed: entry.count <= limit,
    retryMs: entry.resetAt - now,
  };
}

// ======================================================================
//  S50 — DB RAW LOG HELPER (Failover Shield)
// ======================================================================
async function safeInsertLog(collectionName, doc) {
  try {
    const { getDb } = await import("../db.js");
    const db = await getDb();
    await db.collection(collectionName).insertOne(doc);
  } catch (err) {
    console.warn(`Revenue ${collectionName} rawlog error:`, err?.message);
  }
}

// ======================================================================
//  S50 — Provider normalize helper (S9 ile tam uyumlu)
// ======================================================================
function normalizeProvider(rawProvider) {
  if (!rawProvider) return null;
  try {
    const key = normalizeProviderKeyS9(rawProvider);
    if (key) return key;
    return safeStr(rawProvider, 80).toLowerCase() || null;
  } catch {
    return null;
  }
}

// ======================================================================
//  POST /api/revenue/click
//  • S40++ response shape korunur: { ok, stats, correlationId, ... }
// ======================================================================
router.post("/click", async (req, res) => {
  const correlationId = buildCorrelationId();

  try {
    const body = safeBody(req);
    const ip = getClientIp(req);

    // provider hem provider hem de providerKey / source gibi alanlardan gelebilir
    const rawProvider =
      body.provider || body.providerKey || body.source || body.p;
    const providerKey = normalizeProvider(rawProvider);

    if (!providerKey) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PROVIDER",
        correlationId,
      });
    }

    // Rate-limit (IP + provider)
    const rl = rateLimit(ip, providerKey, 200, 60_000);
    if (!rl.allowed) {
      return res.status(429).json({
        ok: false,
        throttled: true,
        retryAfterMs: rl.retryMs,
        correlationId,
      });
    }

    const uaHash = hashUA(req);
    const userTokenRaw = body.userToken;
    const userToken = safeStr(userTokenRaw || "", 160);

    // Eski şemayı bozmadan, payload’ı genişletiyoruz
    const payload = {
      provider: providerKey,
      price: safeNum(body.price),
      clickId: safeStr(body.clickId, 120),
      userToken,
      affId: safeStr(body.affId || body.affiliateId, 120),
      ip,
      uaHash,
      meta: {
        from: "revenueRoutes/click",
        timestamp: Date.now(),
        version: "S50",
        correlationId,
        referer: getReferer(req),
        // userId optional sinyal – token içinden kaba çıkarım
        hintedUserId: userToken ? safeStr(userToken.split("-")[0], 64) : null,
      },
    };

    // S40++ mantık: recordClick SENKRON, in-memory engine
    const stats = recordClick(payload);

    // Raw log — request’i bloke ETMEDEN fire-and-forget
    queueMicrotask(() => {
      safeInsertLog("revenue_click_logs", {
        ...payload,
        stats,
        userAgent: req.headers["user-agent"] || "",
        createdAt: new Date(),
      }).catch(() => {});
    });

    return res.json({ ok: true, stats, correlationId });
  } catch (err) {
    console.error("POST /api/revenue/click error:", correlationId, err);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      correlationId,
    });
  }
});

// ======================================================================
//  POST /api/revenue/conversion
//  • S40++ response shape korunur
// ======================================================================
router.post("/conversion", async (req, res) => {
  const correlationId = buildCorrelationId();

  try {
    const body = safeBody(req);
    const ip = getClientIp(req);

    const rawProvider =
      body.provider || body.providerKey || body.source || body.p;
    const providerKey = normalizeProvider(rawProvider);

    if (!providerKey) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PROVIDER",
        correlationId,
      });
    }

    // Rate-limit (IP + provider) — conversion için biraz daha sıkı
    const rl = rateLimit(ip, providerKey, 80, 60_000);
    if (!rl.allowed) {
      return res.status(429).json({
        ok: false,
        throttled: true,
        retryAfterMs: rl.retryMs,
        correlationId,
      });
    }

    const uaHash = hashUA(req);

    const payload = {
      provider: providerKey,
      amount: safeNum(body.amount),
      rate: safeNum(body.rate),
      userId: safeStr(body.userId, 120),
      orderId: safeStr(body.orderId, 120),
      clickId: safeStr(body.clickId, 120),
      affId: safeStr(body.affId || body.affiliateId, 120),
      ip,
      uaHash,
      meta: {
        from: "revenueRoutes/conversion",
        timestamp: Date.now(),
        version: "S50",
        correlationId,
        referer: getReferer(req),
      },
    };

    const stats = recordConversion(payload);

    queueMicrotask(() => {
      safeInsertLog("revenue_conversion_logs", {
        ...payload,
        stats,
        userAgent: req.headers["user-agent"] || "",
        createdAt: new Date(),
      }).catch(() => {});
    });

    return res.json({ ok: true, stats, correlationId });
  } catch (err) {
    console.error("POST /api/revenue/conversion error:", correlationId, err);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      correlationId,
    });
  }
});

// ======================================================================
//  GET /api/revenue/stats/:provider
//  • Eski davranış aynen korunur
// ======================================================================
router.get("/stats/:provider", async (req, res) => {
  try {
    const providerKey = normalizeProvider(req.params.provider);
    const stats = getProviderRevenueStats(providerKey);
    return res.json({ ok: true, stats });
  } catch (err) {
    console.error("GET /api/revenue/stats/:provider error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

// ======================================================================
//  GET /api/revenue/stats
//  • Global provider bazlı gelir istatistikleri
// ======================================================================
router.get("/stats", async (_req, res) => {
  try {
    const stats = getAllProviderStats();
    return res.json({ ok: true, stats });
  } catch (err) {
    console.error("GET /api/revenue/stats error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

export default router;
