// backend/routes/learn.js
// ======================================================================
//  LEARN ROUTER — S21 GOD-KERNEL EDITION
//  • ZERO DELETE — Eski S16 davranışı aynen korunur
//  • Rate limit: express-rate-limit + deep RL (IP + userId + UA)
//  • NoSQL / XSS sanitize
//  • Dedupe shield (ms içinde aynı event spam'ini engeller)
//  • Full backward compatibility (şema, koleksiyon, field isimleri aynı)
// ======================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { getDb } from "../db.js";

const router = express.Router();

// ----------------------------------------------------
// S16: Rate limit – bot / script spam koruması (KORUNDU)
// ----------------------------------------------------
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90, // dakikada 90 learn olayı yeter
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(limiter);

// ----------------------------------------------------
// S21: Derin yardımcilar — sanitize + IP + RL + dedupe
// ----------------------------------------------------
function safeStr(v, maxLen = 250) {
  if (v == null) return "";
  try {
    let s = String(v).trim();

    // Basit NoSQL / XSS kırpma
    if (s.startsWith("$")) s = "_" + s;
    s = s.replace(/[<>]/g, "");
    s = s.replace(/[\x00-\x1F\x7F]/g, "");

    if (s.length > maxLen) s = s.slice(0, maxLen);
    return s;
  } catch {
    return "";
  }
}

function safeNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 1_000_000_000) return 1_000_000_000;
  return num;
}

function getClientIp(req) {
  try {
    let ip =
      req.headers["cf-connecting-ip"] ||
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      "unknown";

    if (ip.startsWith("::ffff:")) ip = ip.slice(7);
    return ip || "unknown";
  } catch {
    return "unknown";
  }
}

// Deep RL (IP + userId + UA)
const RL = new Map();

function rlKey(ip, userId, uaHash) {
  return `${ip}:${userId || "anon"}:${uaHash || "noua"}`;
}

function rateLimitDeep(ip, userId, uaHash, limit = 220, windowMs = 60_000) {
  const key = rlKey(ip, userId, uaHash);
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

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RL.entries()) {
    if (now > v.resetAt + 30_000) RL.delete(k);
  }
}, 30_000).unref?.();

// Dedupe shield — aynı olayı 200ms içinde tekrar yazma
const DEDUPE = new Map();

function dedupeSignature(payload) {
  const raw = JSON.stringify(payload);
  return crypto.createHash("md5").update(raw).digest("hex");
}

function dedupeCheck(sig, ttl = 200) {
  const now = Date.now();
  const last = DEDUPE.get(sig) || 0;
  if (now - last < ttl) return false;
  DEDUPE.set(sig, now);
  return true;
}

// ----------------------------------------------------
// S16: Allowed card / event types (data integrity shield)
// ----------------------------------------------------
const ALLOWED_CARD_TYPES = [
  "best",
  "smart",
  "others",
  "primary",
  "secondary",
];

const ALLOWED_EVENT_TYPES = [
  "impression", // kart gösterildi
  "hover",
  "click", // tıklama
  "reserve",
  "purchase",
];

function normalizeCardType(t) {
  if (!t) return "unknown";
  const clean = String(t).trim().toLowerCase();
  return ALLOWED_CARD_TYPES.includes(clean) ? clean : "unknown";
}

function normalizeEventType(t) {
  if (!t) return "click"; // eski kodlar için default
  const clean = String(t).trim().toLowerCase();
  return ALLOWED_EVENT_TYPES.includes(clean) ? clean : "click";
}

// ----------------------------------------------------
// S16: Minimal sanitization (KORUNDU + güçlendirildi)
// ----------------------------------------------------
function sanitizeQuery(q) {
  if (!q) return "";
  const s = safeStr(q, 250);
  return s;
}

function sanitizeString(v, maxLen = 120) {
  if (!v) return "";
  return safeStr(v, maxLen);
}

/**
 * S21 — Learn Engine (S16 üstüne zırh)
 * POST /api/learn
 *
 * Body (hepsi opsiyonel ama eski şema ile uyumlu):
 * {
 *   userId: string,          // ZORUNLU (veya backend userId)
 *   query: string,
 *   cardType: "best" | "smart" | "others" | ...,
 *   category: string,
 *   region: string,
 *   provider: string,
 *   productId: string,
 *   itemId: string,
 *   price: number,
 *   position: number,
 *   eventType: "click" | "impression" | ...
 * }
 */
router.post("/", async (req, res) => {
  try {
    const db = await getDb();
    const aggCol = db.collection("user_learning"); // aggregate
    const eventsCol = db.collection("user_learning_events"); // raw log

    const body = req.body || {};

    // Backend userId (auth middleware) > body.userId
    const backendUserId =
      typeof req.userId === "string" && req.userId.trim()
        ? req.userId.trim()
        : typeof req.user?.id === "string" && req.user.id.trim()
        ? req.user.id.trim()
        : null;

    const bodyUserId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId.trim()
        : null;

    const userId = sanitizeString(backendUserId || bodyUserId || "", 120) || null;

    let cardType = normalizeCardType(body.cardType);
    const category =
      typeof body.category === "string" ? sanitizeString(body.category, 80) : "";
    const regionRaw =
      typeof body.region === "string" && body.region.trim()
        ? body.region.trim()
        : "TR";
    const region = sanitizeString(regionRaw, 20) || "TR";

    const query = sanitizeQuery(body.query);
    const provider = sanitizeString(body.provider || body.source || "", 80);
    const productId = sanitizeString(body.productId || "", 120);
    const itemId = sanitizeString(body.itemId || "", 120);
    const sessionId = sanitizeString(body.sessionId || "", 120);

    const price =
      typeof body.price === "number" && Number.isFinite(body.price)
        ? safeNumber(body.price)
        : null;

    const position =
      typeof body.position === "number" && Number.isFinite(body.position)
        ? safeNumber(body.position)
        : null;

    const eventType = normalizeEventType(body.eventType);

    // Required check (S16 mantığı korunuyor, sadece sanitize ile)
    if (!userId || !cardType) {
      return res.status(400).json({ ok: false, error: "Eksik parametre" });
    }

    const ip = getClientIp(req);
    const ua = sanitizeString(req.headers["user-agent"] || "", 250);
    const uaHash = crypto
      .createHash("sha256")
      .update(ua || "noua")
      .digest("hex");

    // Deep rate limit
    const rl = rateLimitDeep(ip, userId, uaHash);
    if (!rl.allowed) {
      return res.status(429).json({
        ok: false,
        error: "RATE_LIMIT",
        retryAfterMs: rl.retryMs,
      });
    }

    const now = new Date();

    // DEDUPE SHIELD → aynı learn event'i 200ms içinde tekrar yazma
    const sig = dedupeSignature({
      userId,
      query,
      cardType,
      category: category || "uncategorized",
      region,
      provider,
      productId,
      itemId,
      position,
      eventType,
      ip,
    });

    if (!dedupeCheck(sig, 200)) {
      return res.json({ ok: true, deduped: true });
    }

    // --------------------------------------------------------
    // 1) Aggregate kayıt (ESKİ DAVRANIŞ) — override etmeden
    // --------------------------------------------------------
    const filter = {
      userId,
      cardType,
      category: category || "uncategorized",
    };

    const incFields = { clickCount: 1 };

    if (eventType === "impression") incFields.impressionCount = 1;
    else if (eventType === "hover") incFields.hoverCount = 1;
    else if (eventType === "click") incFields.clickCount = 1;
    else if (eventType === "reserve") incFields.reserveCount = 1;
    else if (eventType === "purchase") incFields.purchaseCount = 1;

    const update = {
      $set: {
        lastQuery: query,
        lastRegion: region,
        lastSeen: now,
        lastProvider: provider || null,
        lastPrice: price != null ? price : null,
        lastEventType: eventType,
        ip,
        ua,
      },
      $inc: incFields,
      $setOnInsert: {
        createdAt: now,
        firstQuery: query,
        firstRegion: region,
      },
    };

    await aggCol.updateOne(filter, update, { upsert: true });

    // --------------------------------------------------------
    // 2) Raw event log — gerçek öğrenme yakıtı
    // --------------------------------------------------------
    await eventsCol.insertOne({
      userId,
      sessionId: sessionId || null,
      query,
      cardType,
      category: category || "uncategorized",
      region,
      provider: provider || null,
      productId: productId || null,
      itemId: itemId || null,
      price,
      position,
      eventType,
      ip,
      ua,
      createdAt: now,
    });

    res.json({ ok: true, deduped: false });
  } catch (err) {
    console.error("Learn route error (S21):", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

export default router;
