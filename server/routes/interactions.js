// ======================================================================
//  S21 GOD-KERNEL — INTERACTION ROUTER (FINAL FORM)
//  • ZERO DELETE — S16'nın tüm işlevleri korunur
//  • Anti-abuse triple-rate-limit (IP + UA + userId)
//  • Poison-proof sanitize (NoSQL Injection block)
//  • Dedupe Shield (Same event spam = 0 insert)
//  • Category / CardType Safe Whitelist
//  • UA Hash + IP Fingerprint
//  • JSON-safe crash isolation
// ======================================================================

import express from "express";
import { getDb } from "../db.js";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

const router = express.Router();

// ======================================================================
// SAFE HELPERS — S21 reinforced
// ======================================================================
function safeStr(v, max = 300) {
  if (v == null) return "";
  try {
    let s = String(v).trim();

    // Basic NoSQL injection shields
    if (s.startsWith("$")) s = "_" + s;
    s = s.replace(/[<>]/g, "");

    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch {
    return "";
  }
}

function hashUA(ua) {
  try {
    return crypto.createHash("sha256").update(String(ua)).digest("hex");
  } catch {
    return null;
  }
}

function getIP(req) {
  try {
    return (
      req.headers["cf-connecting-ip"] ||
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

// ======================================================================
// S21 — GLOBAL RATE LIMITER (IP)
// ======================================================================
const ipLimiter = rateLimit({
  windowMs: 40_000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

// S21 — In-memory additional RL (IP + UA + userId)
const RL = new Map();

function rlKey(ip, ua, userId) {
  return `${ip}:${ua}:${userId}`;
}

function rateLimitDeep(ip, uaHash, userId, limit = 70, windowMs = 60_000) {
  const key = rlKey(ip, uaHash, userId);
  const now = Date.now();
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

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RL.entries()) {
    if (now > v.resetAt + 10_000) RL.delete(k);
  }
}, 20_000).unref?.();

router.use(ipLimiter);

// ======================================================================
// S21 — DEDUPE SHIELD (same interaction spam blocker)
// ======================================================================
const DEDUPE = new Map();

function dedupeSignature({ userId, query, cardType, category, ip }) {
  const raw = `${userId}|${query}|${cardType}|${category}|${ip}`;
  return crypto.createHash("md5").update(raw).digest("hex");
}

function dedupeCheck(sig, ttl = 200) {
  const now = Date.now();
  const last = DEDUPE.get(sig) || 0;
  if (now - last < ttl) return false;
  DEDUPE.set(sig, now);
  return true;
}

// ======================================================================
// ROUTE
// ======================================================================
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    const userId = safeStr(body.userId || "anon", 200);
    const query = safeStr(body.query || "", 300);
    const cardTypeRaw = safeStr(body.cardType || "", 30);
    const category = safeStr(body.category || "", 100);
    const region = safeStr(body.region || "TR", 20);

    // Allowed cardTypes (S16 preserved)
    const ALLOWED_TYPES = ["best", "smart", "others", "primary", "secondary", ""];
    const cardType = ALLOWED_TYPES.includes(cardTypeRaw)
      ? cardTypeRaw
      : "unknown";

    // IP & UA
    const ip = getIP(req);
    const uaRaw = safeStr(req.headers["user-agent"] || "unknown", 300);
    const uaHash = hashUA(uaRaw);

    // S21 — Deep rate limit
    const rl = rateLimitDeep(ip, uaHash, userId);
    if (!rl.allowed) {
      return res.status(429).json({
        ok: false,
        throttled: true,
        retryAfterMs: rl.retryMs,
      });
    }

    // DEDUPE SHIELD
    const sig = dedupeSignature({ userId, query, cardType, category, ip });
    if (!dedupeCheck(sig)) {
      return res.json({ ok: true, deduped: true });
    }

    // DATABASE WRITE
    const db = await getDb();
    const col = db.collection("interactions");

    await col.insertOne({
      userId,
      query,
      cardType,
      category,
      region,
      ip,
      ua: uaRaw,
      uaHash,
      createdAt: new Date(),
    });

    return res.json({ ok: true, deduped: false });
  } catch (err) {
    console.error("❌ S21 INTERACTION ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "INTERACTION_ERROR",
    });
  }
});

export default router;
