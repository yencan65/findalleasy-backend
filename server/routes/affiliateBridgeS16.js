// ============================================================================
// AFFILIATE BRIDGE — S16 (Click-out + Postback-in + Dedup) — PAIDFIX FINAL
// ZERO DELETE discipline: existing behavior preserved, only hardened.
//
// ✅ /api/aff/out/:provider
//    - clickId üret, affiliateclicks16 yaz, 302 redirect
//    - provider contract'a göre click paramı ekle (trendyol=subid4, hb=clickref)
//    - ayrıca fae_click her zaman eklenir (debug + garanti)
//
// ✅ /api/aff/postback/:provider
//    - provider contract'a göre incoming paramları canonical alana map et
//    - conversion dedup (orderId+provider)
//    - clickId -> userId mapping
//    - paid hesabı: pb.paid yoksa status'tan türetilir  ✅ (THIS FIX)
//
// ✅ /api/aff/contract (+ /:provider) — DEV debug endpoint
//
// NOTE:
// - PROD’da contract endpoint’i kapalı/allowlist (env ile kontrol).
// - POSTBACK secret opsiyonel: FAE_POSTBACK_SECRET
// ============================================================================

import express from "express";
import crypto from "crypto";
import mongoose from "mongoose";

import { getDb } from "../db.js";
import { applyAffiliateRewardIfEligible } from "../core/rewardEngine.js";

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------
const router = express.Router();

// ----------------------------------------------------------------------------
// Env / Flags
// ----------------------------------------------------------------------------
const POSTBACK_SECRET = String(process.env.FAE_POSTBACK_SECRET || "").trim();

// Contract debug endpoint only in dev unless allowlisted
const CONTRACT_DEBUG_ENABLED =
  String(process.env.FAE_AFF_CONTRACT_DEBUG || "1").trim() !== "0";

const CONTRACT_DEBUG_ALLOWLIST = String(
  process.env.FAE_AFF_CONTRACT_ALLOWLIST || ""
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Paid status list (global)
const PAID_STATUSES = new Set(
  String(process.env.FAE_PAID_STATUSES || "approved,paid,confirmed,success,successful,completed,complete")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function safeStr(v) {
  return v == null ? "" : String(v);
}
function nowMs() {
  return Date.now();
}
function genClickId() {
  // short, URL-safe
  return crypto.randomBytes(16).toString("base64url");
}
function normalizeProvider(p) {
  return safeStr(p).trim().toLowerCase();
}
function isLikelyUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}
function addQuery(url, k, v) {
  const u = new URL(url);
  u.searchParams.set(k, v);
  return u.toString();
}
function pickFirst(src, keys) {
  for (const k of keys) {
    const v = src?.[k];
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return "";
}

// ✅ paid fix helper
function isPaidStatus(status) {
  const s = safeStr(status).trim().toLowerCase();
  if (!s) return false;
  return PAID_STATUSES.has(s);
}

// ----------------------------------------------------------------------------
// Provider Contracts (param map “sözleşme tablosu”)
// ----------------------------------------------------------------------------
const DEFAULT_CONTRACT = {
  out: {
    subIdKey: "subid",
    also: [{ key: "fae_click", valueFrom: "clickId" }],
  },
  in: {
    clickIdKeys: ["clickId", "subid", "sub_id", "sid", "click_id", "fae_click"],
    orderIdKeys: ["orderId", "order_id", "oid", "transactionId"],
    amountKeys: ["amount", "sum", "order_sum", "transactionAmount", "orderAmount"],
    currencyKeys: ["currency", "curr", "transactionCurrency"],
    statusKeys: ["status", "payment_status", "commissionStatus"],
    tokenKeys: ["token", "secret", "x-postback-token"],
    paidKeys: ["paid", "is_paid"],
  },
};

const PROVIDER_CONTRACTS = {
  test: {
    out: { subIdKey: "subid", also: [{ key: "fae_click", valueFrom: "clickId" }] },
    in: {
      clickIdKeys: ["clickId", "subid", "sub_id", "sid", "click_id", "fae_click"],
      orderIdKeys: ["orderId", "order_id", "oid", "transactionId"],
      amountKeys: ["amount", "sum", "order_sum", "transactionAmount", "orderAmount"],
      currencyKeys: ["currency", "curr", "transactionCurrency"],
      statusKeys: ["status", "payment_status", "commissionStatus"],
      tokenKeys: ["token", "secret", "x-postback-token"],
      paidKeys: ["paid", "is_paid"],
    },
  },

  // SENİN simülasyonda kullandığın param seti:
  // OUT: subid4
  // IN : subid4 + order_id + order_sum + payment_status
  trendyol: {
    out: { subIdKey: "subid4", also: [{ key: "fae_click", valueFrom: "clickId" }] },
    in: {
      clickIdKeys: ["clickId", "subid", "sub_id", "sid", "click_id", "fae_click", "subid4"],
      orderIdKeys: ["orderId", "order_id", "oid", "transactionId"],
      amountKeys: ["amount", "sum", "order_sum", "transactionAmount", "orderAmount"],
      currencyKeys: ["currency", "curr", "transactionCurrency"],
      statusKeys: ["status", "payment_status", "commissionStatus"],
      tokenKeys: ["token", "secret", "x-postback-token"],
      paidKeys: ["paid", "is_paid"],
    },
  },

  // SENİN simülasyonda kullandığın param seti:
  // OUT: clickref
  // IN : clickref + transactionId + transactionAmount + commissionStatus
  hepsiburada: {
    out: { subIdKey: "clickref", also: [{ key: "fae_click", valueFrom: "clickId" }] },
    in: {
      clickIdKeys: ["clickId", "subid", "sub_id", "sid", "click_id", "fae_click", "clickref"],
      orderIdKeys: ["orderId", "order_id", "oid", "transactionId"],
      amountKeys: ["amount", "sum", "order_sum", "transactionAmount", "orderAmount"],
      currencyKeys: ["currency", "curr", "transactionCurrency"],
      statusKeys: ["status", "payment_status", "commissionStatus"],
      tokenKeys: ["token", "secret", "x-postback-token"],
      paidKeys: ["paid", "is_paid"],
    },
  },
};

function getContract(provider) {
  const p = normalizeProvider(provider);
  const c = PROVIDER_CONTRACTS[p] || {};
  return {
    out: { ...DEFAULT_CONTRACT.out, ...(c.out || {}) },
    in: { ...DEFAULT_CONTRACT.in, ...(c.in || {}) },
  };
}

function contractIsAllowed(req) {
  if (!CONTRACT_DEBUG_ENABLED) return false;
  if (CONTRACT_DEBUG_ALLOWLIST.length === 0) return true; // dev default açık
  const ip =
    safeStr(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
  return CONTRACT_DEBUG_ALLOWLIST.includes(ip);
}

// ----------------------------------------------------------------------------
// Mongoose Models (S16 collections)
// ----------------------------------------------------------------------------
function getOrCreateModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

const ClickSchema = new mongoose.Schema(
  {
    clickId: { type: String, index: true },
    provider: { type: String, index: true },
    userId: { type: String, index: true },
    sid: { type: String, index: true }, // session-ish id
    itemId: String,
    title: String,
    targetUrl: String,
    finalUrl: String,
    ts: { type: Number, index: true },
    ua: String,
    ip: String,
  },
  { collection: "affiliateclicks16" }
);

const ConversionSchema = new mongoose.Schema(
  {
    provider: { type: String, index: true },
    clickId: { type: String, index: true },
    orderId: { type: String, index: true },
    userId: { type: String, index: true },
    amount: Number,
    currency: String,
    status: String,
    paid: { type: Boolean, index: true },
    ts: { type: Number, index: true },
    raw: Object,
  },
  { collection: "affiliateconversions16" }
);

// Unique-ish: provider+orderId dedup
ConversionSchema.index({ provider: 1, orderId: 1 }, { unique: true, sparse: true });

const ClickModel = getOrCreateModel("AffiliateClickS16", ClickSchema);
const ConvModel = getOrCreateModel("AffiliateConversionS16", ConversionSchema);

// ----------------------------------------------------------------------------
// DB readiness guard (postback kaybı para kaybıdır)
// ----------------------------------------------------------------------------
async function waitForDbReady(ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      // getDb() is async; we must await to avoid returning a Promise (false-positive "ready")
      const d = await getDb();
      // Hard readiness: ping the server so postbacks don't silently vanish.
      if (d && typeof d.command === "function") {
        await d.command({ ping: 1 });
      }
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ----------------------------------------------------------------------------
// Contract endpoints
// ----------------------------------------------------------------------------
router.get("/contract", (req, res) => {
  if (!contractIsAllowed(req)) {
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }
  return res.json({
    ok: true,
    contracts: Object.keys(PROVIDER_CONTRACTS),
    note: "Use /api/aff/contract/:provider (dev only unless allowlisted).",
  });
});

router.get("/contract/:provider", (req, res) => {
  if (!contractIsAllowed(req)) {
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }
  const provider = normalizeProvider(req.params.provider);
  const c = getContract(provider);
  return res.json({
    ok: true,
    provider,
    out: {
      subIdKey: c.out.subIdKey,
      also: c.out.also || [],
      example: `GET /api/aff/out/${provider}?url=https%3A%2F%2Fmerchant.com%2Fitem&itemId=...&title=... (redirect adds ${c.out.subIdKey}=<clickId>)`,
    },
    in: {
      ...c.in,
      example: `GET /api/aff/postback/${provider}?clickId=<clickId>&orderId=<orderId>&amount=100&currency=TRY&status=approved`,
    },
    debug: { enabled: CONTRACT_DEBUG_ENABLED, allowlist: CONTRACT_DEBUG_ALLOWLIST },
  });
});

// ----------------------------------------------------------------------------
// OUT: /api/aff/out/:provider
// ----------------------------------------------------------------------------
router.get("/out/:provider", async (req, res) => {
  const provider = normalizeProvider(req.params.provider);
  const c = getContract(provider);

  // accept aliases
  const url = safeStr(req.query.url || req.query.u || "").trim();
  const itemId = safeStr(req.query.itemId || req.query.pid || "").trim();
  const title = safeStr(req.query.title || "").trim();
  const userId = safeStr(req.query.userId || "").trim();

  if (!url || !isLikelyUrl(url)) {
    return res.status(400).json({
      ok: false,
      error: "BAD_URL",
      provider,
      hint: "Use ?url=https://example.com (do NOT pre-escape in query manually; use curl -G --data-urlencode)",
    });
  }

  const clickId = genClickId();
  const sid = genClickId().slice(0, 22);

  const ip =
    safeStr(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
      .split(",")[0]
      .trim();
  const ua = safeStr(req.headers["user-agent"] || "").trim();

  // Build redirect URL
  let finalUrl = url;

  // provider's primary subId key
  finalUrl = addQuery(finalUrl, c.out.subIdKey, clickId);

  // also keys (fae_click, etc.)
  for (const a of c.out.also || []) {
    if (!a?.key) continue;
    if (a.valueFrom === "clickId") {
      finalUrl = addQuery(finalUrl, a.key, clickId);
    }
  }

  // store click
  try {
    await ClickModel.create({
      clickId,
      provider,
      userId: userId || undefined,
      sid,
      itemId: itemId || undefined,
      title: title || undefined,
      targetUrl: url,
      finalUrl,
      ts: nowMs(),
      ua,
      ip,
    });
  } catch (e) {
    // don't block redirect in dev; but log
    console.error("[AFF] click create fail:", e?.message || e);
  }

  res.set("Cache-Control", "no-store");
  return res.redirect(302, finalUrl);
});

// ----------------------------------------------------------------------------
// Extract postback (canonicalize)
// ----------------------------------------------------------------------------
async function extractPostback(req, contract) {
  const src = { ...(req.query || {}), ...(req.body || {}) };

  const clickId = pickFirst(src, contract.in.clickIdKeys);
  const orderId = pickFirst(src, contract.in.orderIdKeys);
  const amountRaw = pickFirst(src, contract.in.amountKeys);
  const currency = pickFirst(src, contract.in.currencyKeys);
  const status = pickFirst(src, contract.in.statusKeys);
  const token = pickFirst(src, contract.in.tokenKeys);
  const paidRaw = pickFirst(src, contract.in.paidKeys);

  let amount = null;
  if (amountRaw) {
    const n = Number(String(amountRaw).replace(",", "."));
    amount = Number.isFinite(n) ? n : null;
  }

  // paid: accept explicit paid param if present (rare)
  let paid = null;
  if (paidRaw !== "") {
    const s = String(paidRaw).trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(s)) paid = true;
    else if (["0", "false", "no", "n"].includes(s)) paid = false;
  }

  return {
    provider: normalizeProvider(req.params.provider || src.provider || ""),
    clickId: clickId || null,
    orderId: orderId || null,
    amount,
    currency: currency || null,
    status: status || null,
    token: token || null,
    paid, // may be null
    raw: src,
  };
}

// ----------------------------------------------------------------------------
// POSTBACK: /api/aff/postback/:provider  (GET/POST)
// ----------------------------------------------------------------------------
router.all("/postback/:provider", async (req, res) => {
  const provider = normalizeProvider(req.params.provider);

  // DB yoksa postback'i kaybetmek ölümcül: kısa bekle, yine yoksa 503
  try {
    const ok = await waitForDbReady(Number(process.env.FAE_POSTBACK_DB_WAIT_MS || 8000));
    if (!ok) {
      return res.status(503).json({
        ok: false,
        error: "DB_NOT_READY",
        note: "Postback DB olmadan işlenemez. Bu para kaybıdır.",
      });
    }
  } catch {}

  const contract = getContract(provider);
  const pb = await extractPostback(req, contract);

  // ✅ PAIDFIX: pb.paid yoksa status’tan türet
  const paid = typeof pb.paid === "boolean" ? pb.paid : isPaidStatus(pb.status);

  // postback token check (optional)
  if (POSTBACK_SECRET) {
    if (!pb.token || pb.token !== POSTBACK_SECRET) {
      return res.status(403).json({ ok: false, error: "POSTBACK_FORBIDDEN" });
    }
  }

  if (!pb.clickId || !pb.orderId) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_CLICK_OR_ORDER_ID",
      provider,
      need: { clickId: contract.in.clickIdKeys, orderId: contract.in.orderIdKeys },
    });
  }

  // find click for mapping userId
  let click = null;
  try {
    click = await ClickModel.findOne({ clickId: pb.clickId, provider }).lean();
    if (!click) {
      // fallback: maybe provider mismatch; try any provider
      click = await ClickModel.findOne({ clickId: pb.clickId }).lean();
    }
  } catch (e) {
    console.error("[AFF] click lookup fail:", e?.message || e);
  }

  const userId = click?.userId || null;

  // upsert conversion (dedup by provider+orderId)
  try {
    await ConvModel.updateOne(
      { provider, orderId: pb.orderId },
      {
        $set: {
          provider,
          clickId: pb.clickId,
          orderId: pb.orderId,
          userId: userId || undefined,
          amount: pb.amount ?? undefined,
          currency: pb.currency ?? undefined,
          status: pb.status ?? undefined,
          paid: paid, // ✅ fixed
          ts: nowMs(),
          raw: pb.raw,
        },
      },
      { upsert: true }
    );
  } catch (e) {
    // duplicate key => fine (already processed)
    const msg = safeStr(e?.message || "");
    if (!msg.toLowerCase().includes("duplicate")) {
      console.error("[AFF] conv upsert fail:", e);
      return res.status(500).json({ ok: false, error: "CONV_UPSERT_FAIL" });
    }
  }

  // If not paid yet, just acknowledge
  if (!paid) {
    return res.json({
      ok: true,
      provider,
      status: pb.status,
      paid: false,
      note: "Conversion kaydedildi. Paid olunca reward tetiklenecek.",
    });
  }

  // Paid => try reward
  let rewardApplied = false;
  let rewardResult = null;

  try {
    rewardResult = await applyAffiliateRewardIfEligible({
      provider,
      clickId: pb.clickId,
      orderId: pb.orderId,
      amount: pb.amount,
      currency: pb.currency,
      userId,
      status: pb.status,
      raw: pb.raw,
    });
    rewardApplied = Boolean(rewardResult?.ok);
  } catch (e) {
    rewardResult = { ok: false, error: "REWARD_FAIL", detail: safeStr(e?.message || e) };
  }

  return res.json({
    ok: true,
    provider,
    status: pb.status,
    paid: true,
    clickId: pb.clickId,
    orderId: pb.orderId,
    userId,
    rewardApplied,
    rewardResult,
  });
});

// Alias: /postback?provider=... (kanonik: /postback/:provider)
router.all("/postback", (req, res) => {
  try {
    const provider = normalizeProvider(req.query.provider || req.body?.provider || "");
    if (!provider) return res.status(400).json({ ok: false, error: "MISSING_PROVIDER" });
    const target = `/api/aff/postback/${encodeURIComponent(provider)}`;
    return res.redirect(307, target);
  } catch {
    return res.status(500).json({ ok: false, error: "POSTBACK_ALIAS_FAIL" });
  }
});

export default router;
