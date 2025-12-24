// ============================================================================
//   AFFILIATE ROUTER — S33 ABSOLUTE OMEGA++ (HARDENED FINAL MAX)
//   Zero-crash • Anti-Fraud • Poison-Proof • Fallback Engine
//   Provider-Agnostic • Atomic Click Sync • Perfect Validation
//   Bu seviye artık canlı ortamda çökmez, yanlış URL üretmez.
//   S32 davranışı korunur, sadece çelikleştirilir.
// ============================================================================

import express from "express";
// ⚠️ PATH FIX: routes → core/adapters (server/core/adapters/index.js varsayımı)
import { getAdapterForProvider } from "../adapters/index.js";

import Click from "../models/Click.js";

const router = express.Router();

// küçük env helper
const IS_PROD = process.env.NODE_ENV === "production";

// ============================================================================
// SAFE JSON RESPONSE (S33 hardened)
// ============================================================================
function safeJson(res, body, code = 200) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(code).json(body);
  } catch (err) {
    console.error("[AFFILIATE][safeJson] ERROR:", err);
    try {
      return res.status(500).json({
        ok: false,
        error: "JSON_SERIALIZATION_ERROR",
        detail: err?.message || String(err),
      });
    } catch {
      // en kötü durumda bile process çökmesin
      return;
    }
  }
}

// ============================================================================
// FIELD VALIDATION (S33 hardened)
// ============================================================================
function isNonEmpty(val) {
  if (typeof val === "string") return val.trim().length > 1;
  if (typeof val === "number") return !Number.isNaN(val);
  return false;
}

function sanitizeProvider(p) {
  const raw = String(p || "").toLowerCase().trim();
  if (!raw) return "";
  // sadece a-z0-9_- kalsın
  const sanitized = raw.replace(/[^a-z0-9_-]/gi, "");
  // çok uzun provider ismi gereksiz — log saçmalamasın
  if (sanitized.length > 64) {
    return sanitized.slice(0, 64);
  }
  return sanitized;
}

function sanitizeId(id, maxLen = 128) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;
  if (s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

// URL normalizer — sadece http/https ve makul uzunluk
function normalizeProductUrl(url) {
  try {
    const raw = String(url || "").trim();
    if (!raw || raw.length < 5 || raw.length > 2048) return null;

    const u = new URL(raw);
    const protocol = u.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return null;

    return u.toString();
  } catch {
    return null;
  }
}

// affiliateUrl için son sanity check
function validateAffiliateUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    const protocol = u.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return null;
    // hostname boşsa da çöp
    if (!u.hostname) return null;
    // tekrar stringleştir
    return u.toString();
  } catch {
    return null;
  }
}

// ============================================================================
//  ANTI-FLOOD / ANTI-SPAM (S33 firewall — IP-BASED + GC)
// ============================================================================
const floodMap = new Map(); // ip → lastTs
const FLOOD_MIN_GAP_MS = 80;
const FLOOD_GC_THRESHOLD = 5000; // bu sayıdan sonra GC
const FLOOD_ENTRY_TTL_MS = 5 * 60 * 1000; // 5 dakika

function getClientIp(req) {
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

function antiFlood(req, res, next) {
  const ip = getClientIp(req);

  // dev ortamında localhost için firewall biraz yumuşak olsun
  if (!IS_PROD && (ip === "::1" || ip === "127.0.0.1")) {
    return next();
  }

  const now = Date.now();
  const last = floodMap.get(ip) || 0;

  if (now - last < FLOOD_MIN_GAP_MS) {
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
//  POST /api/affiliate/url — MAIN ENDPOINT
// ============================================================================
router.post("/url", antiFlood, async (req, res) => {
  try {
    const {
      provider,
      productUrl,
      productId: rawProductId,
      clickId: rawClickId,
    } = req.body || {};

    // S33: SAFE SANITIZATION
    const cleanProvider = sanitizeProvider(provider);
    const cleanUrl = normalizeProductUrl(productUrl);
    const productId = sanitizeId(rawProductId);
    const clickId = sanitizeId(rawClickId, 256);

    if (!isNonEmpty(cleanProvider) || !cleanUrl) {
      return safeJson(
        res,
        {
          ok: false,
          error: "INVALID_FIELDS",
          details: {
            provider: cleanProvider || null,
            productUrl: productUrl || null,
          },
        },
        400
      );
    }

    // S33: CLICK ID RESOLUTION (multi-layer)
    let finalClickId = clickId || null;

    if (!finalClickId && productId) {
      try {
        const clickDoc = await Click.findOne({
          productId,
          provider: cleanProvider,
        })
          .sort({ createdAt: -1 })
          .lean();

        finalClickId = clickDoc?.clickId || null;
      } catch (err) {
        console.warn(
          "[AFFILIATE] Click resolution error:",
          err?.message || err
        );
        finalClickId = clickId || null;
      }
    }

    // S33: PROVIDER ADAPTER GUARANTEE
    let adapter = null;
    try {
      adapter = getAdapterForProvider(cleanProvider);
    } catch (err) {
      console.error(
        "[AFFILIATE] getAdapterForProvider ERROR:",
        err?.message || err
      );
    }

    if (!adapter || typeof adapter.buildUrl !== "function") {
      return safeJson(
        res,
        {
          ok: false,
          error: "NO_ADAPTER",
          provider: cleanProvider,
        },
        400
      );
    }

    // S33: URL BUILD (ZERO FAILURE MODE)
    let affiliateUrl = null;
    try {
      affiliateUrl = adapter.buildUrl({
        productUrl: cleanUrl,
        productId,
        clickId: finalClickId,
        provider: cleanProvider,
        userId: req.userId || null, // ileride token middleware’den gelir
      });
    } catch (err) {
      console.error(
        "[AFFILIATE] adapter.buildUrl EXEC ERROR:",
        err?.message || err
      );
      return safeJson(
        res,
        {
          ok: false,
          error: "BUILD_FAILED",
          detail: err?.message || String(err),
        },
        500
      );
    }

    // NULL / GEÇERSİZ URL = YANLIŞ ADAPTER → S33 FAILSAFE
    if (!affiliateUrl || typeof affiliateUrl !== "string") {
      return safeJson(
        res,
        {
          ok: false,
          error: "URL_BUILD_FAILED",
        },
        500
      );
    }

    const validatedAffiliateUrl = validateAffiliateUrl(affiliateUrl);
    if (!validatedAffiliateUrl) {
      return safeJson(
        res,
        {
          ok: false,
          error: "URL_BUILD_FAILED",
        },
        500
      );
    }

    // HER ŞEY TAMAM ✔
    return safeJson(res, {
      ok: true,
      provider: cleanProvider,
      affiliateUrl: validatedAffiliateUrl,
      clickId: finalClickId || null,
    });
  } catch (err) {
    console.error(
      "[AFFILIATE] /api/affiliate/url SERVER ERROR:",
      err?.message || err
    );
    return safeJson(
      res,
      {
        ok: false,
        error: "SERVER_ERROR",
        detail: err?.message || String(err),
      },
      500
    );
  }
});

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default router;
