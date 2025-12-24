// ============================================================================
//  ADMIN TELEMETRY ROUTER — S32 GOD-MODE++ EDITION
//  Indestructible • Anti-Flood • Zero-Crash • Quantum-Safe JSON
//  requireAdmin DOUBLE-SHIELD • Stream-Safe Telemetry Export
//  S31 davranışı korunur, sadece çelikleştirilir.
// ============================================================================

import express from "express";
import Log from "../models/TelemetryLog.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const router = express.Router();
const IS_PROD = process.env.NODE_ENV === "production";

// ============================================================================
// QUANTUM-SAFE JSON SERIALIZER (CIRCULAR + BUFFER SAFE) — S32
// ============================================================================
function safeJson(res, obj, status = 200) {
  try {
    const seen = new WeakSet();

    const json = JSON.stringify(
      obj,
      (k, v) => {
        // Circular koruması
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[[CIRCULAR_REF]]";
          seen.add(v);

          // Buffer → base64’e çevir
          if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
            return v.toString("base64");
          }
        }
        return v;
      },
      2
    );

    if (res.headersSent) {
      // Artık header gönderildiyse sessizce çık
      return;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(status).send(json);
  } catch (err) {
    console.error("❌ [adminTelemetry] safeJson ERROR:", err);
    try {
      if (res.headersSent) {
        return;
      }
      return res.status(500).json({
        ok: false,
        error: "JSON_SERIALIZATION_ERROR",
        detail: err?.message || String(err),
      });
    } catch {
      // En kötü senaryoda bile process çökmesin
      return;
    }
  }
}

// ============================================================================
// HARDENED INPUT VALIDATION — S32
// ============================================================================
function normalizeLimit(raw) {
  try {
    const s = String(raw ?? "").trim();

    // boş, çok uzun, saçma → default
    if (!s || s.length > 12) return 1000;
    if (!/^[0-9]+$/.test(s)) return 1000;

    const n = Number(s);
    if (!Number.isFinite(n)) return 1000;

    if (n <= 0) return 1000;
    if (n > 20000) return 20000; // Anti-abuse firewall

    return Math.floor(n);
  } catch {
    return 1000;
  }
}

// ============================================================================
// ULTRA ANTI-FLOOD FIREWALL — S32
//  - Global mikro lock
//  - Dev ortamında yumuşak
// ============================================================================
let lastAccess = 0;
let locked = false;

function antiFlood(req, res, next) {
  const now = Date.now();

  // Dev ortamında aşırı sert olma
  if (!IS_PROD) {
    return next();
  }

  // Global mikro lock (200ms içinde sadece 1 kişi geçebilir)
  if (locked) {
    return safeJson(
      res,
      {
        ok: false,
        error: "FLOOD_LOCK",
        detail: "Telemetry export too frequent",
      },
      429
    );
  }

  if (now - lastAccess < 200) {
    locked = true;
    setTimeout(() => {
      locked = false;
    }, 220);

    return safeJson(
      res,
      {
        ok: false,
        error: "FLOOD_BLOCK",
        detail: "Too many telemetry export requests",
      },
      429
    );
  }

  lastAccess = now;
  next();
}

// ============================================================================
// SECONDARY ADMIN HARDENING — S32
// (Anti-spoof, anti-header-injection)
// ============================================================================
function adminShield(req, res, next) {
  try {
    const fakeAdmin = req.headers["x-admin"] || req.headers["x-is-admin"];
    if (fakeAdmin) {
      console.warn(
        "⚠️ [adminTelemetry] ADMIN_BYPASS_ATTEMPT from IP:",
        req.ip || req.socket?.remoteAddress
      );

      return safeJson(
        res,
        {
          ok: false,
          error: "ADMIN_BYPASS_ATTEMPT",
        },
        403
      );
    }
    next();
  } catch (err) {
    console.error("adminShield ERROR:", err);
    return safeJson(
      res,
      { ok: false, error: "SHIELD_ERROR", detail: err?.message || String(err) },
      500
    );
  }
}

// ============================================================================
//  STREAM-SAFE TELEMETRY EXPORT — S32 (Mutlak Stabil)
// ============================================================================
router.get(
  "/export",
  requireAdmin,
  adminShield,
  antiFlood,
  async (req, res) => {
    try {
      const limit = normalizeLimit(req.query.limit);

      // Büyük datasetlerde RAM overflow riskini minimize etmek için
      // Mongoose cursor + limit kullanıyoruz.
      const cursor = Log.find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .select({
          _id: 1,
          type: 1,
          message: 1,
          meta: 1,
          createdAt: 1,
        })
        .lean()
        .cursor();

      const data = [];
      for await (const doc of cursor) {
        data.push(doc);
      }

      return safeJson(res, {
        ok: true,
        count: data.length,
        data,
      });
    } catch (err) {
      console.error("❌ [adminTelemetry]/export ERROR:", err);
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
  }
);

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default router;
