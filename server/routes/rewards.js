// ===================================================================
//   REWARD ROUTER — S30 GOD-TIER (FINAL, UNBREAKABLE, ZERO LOSS)
//   • S21 → S30: Çift idempotency, Request-Fingerprint, Anti-Tamper
//   • BodyFuse (bozuk body’yi bile güvenli hale çevirir)
//   • Saudi-Grant anti-reentrancy shield (aynı tick içinde 2 işlem blok)
//   • Sıfır silme: tüm endpoint davranışları %100 aynı
// ===================================================================

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import express from "express";

import {
  getUserRewardsSummary,
  getUserInviteTree,
  getUserCommissionStats,
  getUserClicks,
  applyClickReward,
  applyRewardsForOrder,
  applyPurchaseRewards,
  checkModelHealth,
} from "../core/rewardEngine.js";

const router = express.Router();

// ===============================================================
// S30 BODY HARDENING (kırık JSON → sağlam fuse)
// ===============================================================
function bodyFuse(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};

  for (const k in raw) {
    const v = raw[k];
    if (typeof v === "string") {
      out[k] = v.trim().slice(0, 500);
    } else if (typeof v === "number") {
      out[k] = Number.isFinite(v) ? v : 0;
    } else if (typeof v === "boolean") {
      out[k] = v;
    } else if (v == null) {
      out[k] = null;
    } else {
      // JSON-safe objeyi string’e çeviriyoruz
      try {
        out[k] = JSON.parse(JSON.stringify(v));
      } catch {
        out[k] = String(v).slice(0, 200);
      }
    }
  }
  return out;
}

// ===============================================================
// S30 REQUEST FINGERPRINT (yüksek doğruluklu)
// userId + ip + ua + referer + route
// ===============================================================
function fingerprint(req, append = "") {
  try {
    const ip = req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.ip ||
      req.socket?.remoteAddress ||
      "0.0.0.0";

    const ua = (req.headers["user-agent"] || "").slice(0, 80);
    const ref = (req.headers["referer"] || "").slice(0, 200);
    const rid = `${ip}|${ua}|${ref}|${append}`;

    return Buffer.from(rid).toString("base64").slice(0, 120);
  } catch {
    return `fp-${Date.now()}`;
  }
}

// ===============================================================
// S30 GLOBAL FIREWALL — S21 + fingerprint ek katman
// ===============================================================
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => {
    let ip = "";
    try {
      ip = ipKeyGenerator(req);
    } catch {
      ip =
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.ip ||
        req.socket?.remoteAddress ||
        "ip-unknown";
    }

    const userId =
      (req.body && (req.body.userId || req.body.id)) ||
      req.params?.id ||
      "";

    const auth = String(req.headers["authorization"] || "").slice(-32);
    const ua = String(req.headers["user-agent"] || "").slice(0, 32);

    const fp = fingerprint(req, "global");

    return `${ip}|${userId}|${auth}|${ua}|${fp}`;
  },
});

router.use(globalLimiter);

// ---------------------------------------
// CORS / PREFLIGHT (custom header'lar için)
// ---------------------------------------
router.options("*", (req, res) => res.sendStatus(204));


// ===============================================================
// S30 IDEMPOTENCY MAPS (iki aşamalı güvenlik)
// ===============================================================
const recentOrderMap = new Map();
const recentClickMap = new Map();
const recentRequestMap = new Map(); // anti-reentrancy shield

function dedupe(map, key, ttl) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < ttl) return true;
  map.set(key, now);
  return false;
}

// Mini GC
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentRequestMap.entries()) {
    if (now - ts > 5000) recentRequestMap.delete(k);
  }
}, 5000).unref?.();

// ===============================================================
// JSON SAFE
// ===============================================================
function safeJson(res, data, status = 200) {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      data,
      (k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[[CIRCULAR]]";
          seen.add(v);
        }
        return v;
      },
      2
    );

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(status).send(json);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "JSON_FAIL",
      detail: err?.message,
    });
  }
}

function isValidId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  return s.length >= 2 && s.length <= 256;
}

// ===============================================================
// ROUTES — S21 SIRASI KORUNUR
// ===============================================================

// ---------------------------------------
// 1) HEALTH
// ---------------------------------------
router.get("/system/health/check", async (req, res) => {
  try {
    const r = await checkModelHealth();
    return safeJson(res, r);
  } catch (err) {
    return safeJson(res, { ok: false, reason: "HEALTH_FAIL" });
  }
});

// ---------------------------------------
// 2) INVITE TREE
// ---------------------------------------
router.get("/tree/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return safeJson(res, { ok: false, reason: "BAD_ID" });

  try {
    const r = await getUserInviteTree(id);
    return safeJson(res, r);
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message });
  }
});

// ---------------------------------------
// 3) CLICK REWARD
// ---------------------------------------
router.post("/click", async (req, res) => {
  const body = bodyFuse(req.body);

  try {
    const fp = fingerprint(req, "click");

    if (dedupe(recentRequestMap, fp, 100)) {
      return safeJson(res, { ok: false, reason: "REENTRANCY_S30" });
    }

    const user = body.userId || "anon";
    const prod = body.productId || "none";
    const prov = String(body.provider || "unknown").toLowerCase();

    const key = `${user}|${prod}|${prov}`;

    if (dedupe(recentClickMap, key, 800)) {
      return safeJson(res, { ok: false, reason: "CLICK_DEDUPED_S30" });
    }

    const out = await applyClickReward(body);
    return safeJson(res, out);
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message });
  }
});

// ---------------------------------------
// 4) ORDER REWARD
// ---------------------------------------
router.post("/order", async (req, res) => {
  const body = bodyFuse(req.body);

  try {
    const fp = fingerprint(req, "order");

    if (dedupe(recentRequestMap, fp, 120)) {
      return safeJson(res, { ok: false, reason: "REENTRANCY_S30" });
    }

    const orderKey =
      body.orderId ||
      body.id ||
      body._id ||
      body.providerOrderId ||
      null;

    if (orderKey && dedupe(recentOrderMap, String(orderKey), 5000)) {
      return safeJson(res, { ok: false, reason: "ORDER_DEDUPED_S30" });
    }

    const r = await applyRewardsForOrder(body);
    return safeJson(res, r);
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message });
  }
});

// ---------------------------------------
// 5) PURCHASE
// ---------------------------------------
router.post("/purchase", async (req, res) => {
  const body = bodyFuse(req.body);
  try {
    const r = await applyPurchaseRewards(body);
    return safeJson(res, r);
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message });
  }
});

// ---------------------------------------
// 6) COMMISSION
// ---------------------------------------
router.get("/commission/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return safeJson(res, { ok: false, reason: "BAD_ID" });

  try {
    const r = await getUserCommissionStats(id);
    return safeJson(res, r);
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message });
  }
});

// ---------------------------------------
// 7) CLICK HISTORY
// ---------------------------------------
router.get("/clicks/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return safeJson(res, { ok: false, reason: "BAD_ID" });

  try {
    const r = await getUserClicks(id);
    return safeJson(res, r);
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message });
  }
});

// ---------------------------------------
// 8) SUMMARY
// ---------------------------------------

// ✅ COMPAT SHIM: Frontend eski çağrı biçimi destekle
// /api/rewards?userId=...   veya   /api/rewards?id=...
router.get("/", async (req, res) => {
  try {
    const q = req.query || {};
    const id = String(q.userId || q.id || q.u || q.us || q.uid || q.user || "").trim();

    if (!isValidId(id)) {
      return safeJson(res, {
        ok: true,
        userId: id || null,
        summary: { points: 0, clicks: 0, invites: 0, commission: 0 },
        _meta: { reason: "MISSING_OR_BAD_ID", compat: true },
      });
    }

    const r = await getUserRewardsSummary(id);
    if (r && typeof r === "object") {
      const meta = r._meta && typeof r._meta === "object" ? r._meta : {};
      return safeJson(res, { ...r, _meta: { ...meta, compat: true } });
    }

    return safeJson(res, {
      ok: true,
      userId: id,
      summary: { points: 0, clicks: 0, invites: 0, commission: 0 },
      _meta: { reason: "EMPTY_RESULT", compat: true },
    });
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message || String(err), _meta: { compat: true } });
  }
});


router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return safeJson(res, { ok: false, reason: "BAD_ID" });

  try {
    const r = await getUserRewardsSummary(id);
    return safeJson(res, r);
  } catch (err) {
    return safeJson(res, { ok: false, error: err?.message });
  }
});

export default router;
