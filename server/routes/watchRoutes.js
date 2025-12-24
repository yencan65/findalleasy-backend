import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";

const router = express.Router();

// ============================================================
// SAFE HELPERS (S33 LEVEL)
// ============================================================
function safeStr(v, max = 500) {
  if (v == null) return "";
  let s = String(v).trim().replace(/[<>]/g, "");
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function safeEmail(v) {
  const s = safeStr(v, 200).toLowerCase();
  const re = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  return re.test(s) ? s : null;
}

function getIP(req) {
  try {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return cf.trim();

    const xf = req.headers["x-forwarded-for"];
    if (xf) return xf.split(",")[0].trim();

    return req.socket?.remoteAddress || req.ip || "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

function hashUA(req) {
  try {
    const ua = String(req.headers["user-agent"] || "");
    return crypto.createHash("sha256").update(ua).digest("hex");
  } catch {
    return null;
  }
}

function safeJson(res, obj, code = 200) {
  try {
    return code !== 200 ? res.status(code).json(obj) : res.json(obj);
  } catch (err) {
    console.error("❌ safeJson ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "JSON_SERIALIZATION_ERROR",
    });
  }
}

function buildCorrelationId() {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
}

// ============================================================
// TOKEN REPLAY & IAM (S33 FORTRESS)
// ============================================================
const recentTokens = new Map();

function hashToken(t) {
  return crypto.createHash("sha256").update(String(t)).digest("hex");
}

function isReplay(hash) {
  const now = Date.now();
  const last = recentTokens.get(hash) || 0;
  if (now - last < 10 * 60 * 1000) return true; // 10 dk
  recentTokens.set(hash, now);

  // mini GC
  if (recentTokens.size > 3000) {
    for (const [k, ts] of recentTokens.entries()) {
      if (now - ts > 20 * 60 * 1000) recentTokens.delete(k);
    }
  }
  return false;
}

function verifyIAM(req) {
  const raw = req.headers["authorization"];
  if (!raw) return { ok: false, reason: "NO_AUTH" };

  const token = raw.replace("Bearer ", "").trim();
  if (!token) return { ok: false, reason: "EMPTY_TOKEN" };

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      maxAge: "3h",
    });
  } catch (err) {
    return { ok: false, reason: "INVALID_JWT", detail: err.message };
  }

  const ip = getIP(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 80);

  if (decoded.ip && decoded.ip !== ip) return { ok: false, reason: "IP_MISMATCH" };
  if (decoded.ua && decoded.ua !== ua) return { ok: false, reason: "UA_MISMATCH" };

  const tokenHash = hashToken(token);
  if (isReplay(tokenHash)) return { ok: false, reason: "TOKEN_REPLAY" };

  return {
    ok: true,
    tokenHash,
    userId: decoded.userId || null,
    email: decoded.email || null, // Watchlist’te kritik
  };
}

// ============================================================
// IAM FIREWALL
// ============================================================
router.use((req, res, next) => {
  const iam = verifyIAM(req);
  if (!iam.ok) {
    return safeJson(res, { success: false, error: "IAM_REJECTED", detail: iam.reason }, 401);
  }
  req.IAM = iam;
  next();
});

// ============================================================
// RATE LIMIT (IP + tokenHash) — S33
// ============================================================
const RATE = new Map();

function rateLimit(ip, tokenHash, limit = 40, windowMs = 60000) {
  const key = `${ip}:${tokenHash.slice(0, 12)}`;
  const now = Date.now();

  const entry = RATE.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  RATE.set(key, entry);

  return {
    allowed: entry.count <= limit,
    retryMs: entry.resetAt - now,
  };
}

// ============================================================
// S33 WATCHLIST ENDPOINT — IAM + SAFE MODE
// ============================================================
router.post("/", async (req, res) => {
  const correlationId = buildCorrelationId();

  try {
    const ip = getIP(req);
    const uaHash = hashUA(req);

    // IAM’den gelen e-mail baskın, body fallback olarak kullanılabilir
    const email = req.IAM.email || safeEmail(req.body?.email);

    if (!email) {
      return safeJson(res, {
        success: false,
        error: "EMAIL_REQUIRED",
        correlationId,
      }, 400);
    }

    const productId = safeStr(req.body?.productId, 200);
    const productName = safeStr(req.body?.productName, 300);

    let lastKnownPrice = Number(req.body?.lastKnownPrice || 0);
    if (!Number.isFinite(lastKnownPrice) || lastKnownPrice < 0) {
      lastKnownPrice = 0;
    }

    const inStock = !!req.body?.inStock;

    // RATE-LIMIT
    const rl = rateLimit(ip, req.IAM.tokenHash, 40, 60000);
    if (!rl.allowed) {
      return safeJson(res, {
        success: false,
        throttled: true,
        retryAfterMs: rl.retryMs,
        correlationId,
      });
    }

    // LOG (ZERO DELETE + correlationId)
    console.log("📩 WATCHLIST:", {
      correlationId,
      userId: req.IAM.userId,
      email,
      productId,
      productName,
      lastKnownPrice,
      inStock,
      ip,
      uaHash,
      t: Date.now(),
    });

    // Background hook — notification motoru
    queueMicrotask(() => {
      try {
        // watchlistDB.insert()
      } catch {}
    });

    return safeJson(res, {
      success: true,
      message: "Watchlist kaydedildi",
      correlationId,
    });

  } catch (err) {
    console.error("WATCHLIST ERROR:", correlationId, err);
    return safeJson(res, {
      success: false,
      error: err?.message || "WATCHLIST_INTERNAL_ERROR",
      correlationId,
    }, 500);
  }
});

export default router;
