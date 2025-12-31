// server/routes/search.js
// ============================================================================
// SEARCH ROUTE — S40 AUTO GROUP + INTENT TELEMETRY (DRIFT-SAFE)
// - GET  /api/search?q=...&group=auto|product|office|...
// - POST /api/search { q|query, group|category, limit, offset, region, locale }
// - POST /api/search/feedback  (intent accuracy signal)
// - GET  /api/search/health
// - GET  /api/search/intent-metrics
//
// Fixes in this version:
// ✅ POST body accepts BOTH {q} and {query} (FE drift-proof)
// ✅ group accepts BOTH {group} and {category}
// ✅ _meta always exposes: engineVariant, deadlineHit, rateLimit, fallback, adapterDiagnosticsSummary
// ✅ catalog_only supports proper paging (offset/limit/total/hasMore)
// ✅ CATALOG_ONLY diag summary is NOT blank anymore (adapterDiagnosticsSummary filled)
// ✅ _meta.deadlineHit + _meta.fallback determinism hardened
// ✅ no-crash discipline preserved
// ============================================================================

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fixQueryTyposTR } from "../utils/queryTypoFixer.js";
import { getDb } from "../db.js";
import {
  applyS200FallbackIfEmpty,
  shouldExposeDiagnostics,
} from "../core/s200Fallback.js";

const router = express.Router();

// Express 4: async handler rejection -> unhandled. Wrap to keep server alive.
const safeRoute = (fn) => async (req, res, next) => {
  try {
    await Promise.resolve(fn(req, res));
  } catch (e) {
    console.error("SEARCH_ROUTE_FATAL", e);
    if (!res.headersSent) {
      res.status(200).json({
        ok: true,
        ts: nowIso(),
        q: safeStr(req?.query?.q) || "",
        group: safeStr(req?.query?.group) || "",
        results: [],
        items: [],
        count: 0,
        total: 0,
        nextOffset: 0,
        hasMore: false,
        cards: [],
        _meta: {
          fatal: true,
          error: safeStr(e?.message || e),
          engineVariant: "ROUTE_FATAL",
          deadlineHit: false,
          rateLimit: null,
          fallback: { used: false, strategy: "none" },
          adapterDiagnosticsSummary: null,
        },
      });
    } else {
      next?.(e);
    }
  }
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_GROUP =
  String(process.env.FINDALLEASY_DEFAULT_GROUP || "product").trim() || "product";
const REGION_DEFAULT =
  String(process.env.FINDALLEASY_DEFAULT_REGION || "TR").trim() || "TR";

const INTENT_LOG_PATH = String(
  process.env.FINDALLEASY_INTENT_LOG ||
    path.resolve(process.cwd(), "brain_logs", "intent_accuracy.jsonl")
);

try {
  fs.mkdirSync(path.dirname(INTENT_LOG_PATH), { recursive: true });
} catch {
  // ignore
}

// ---------------------------------------------------------------------------
// In-memory intent stats (for quick inspection)
// ---------------------------------------------------------------------------
const intentStats =
  globalThis.__faeIntentStats ||
  (globalThis.__faeIntentStats = {
    autoRequests: 0,
    feedback: 0,
    correct: 0,
    wrong: 0,
    overrides: 0,
    overrideCorrected: 0, // predicted != resolved + override applied
    byOverrideSource: {},
    byOverrideReason: {},
    byPredicted: {},
    byCorrect: {},
    confusion: {}, // "pred->correct": count
    last: [],
  });

function bump(obj, key, n = 1) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + n;
}

function bumpConfusion(pred, corr) {
  const k = `${pred || "?"}->${corr || "?"}`;
  bump(intentStats.confusion, k, 1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeStr(v) {
  return v == null ? "" : String(v).trim();
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(v, fallback = 0) {
  return toInt(v, fallback);
}

function clampInt(v, fallback, min = 1, max = 100) {
  const n = toInt(v, fallback);
  return Math.min(max, Math.max(min, n));
}

function parseList(v) {
  if (Array.isArray(v)) return v.map(safeStr).filter(Boolean);
  const s = safeStr(v);
  if (!s) return [];
  return s
    .split(/[;,\s]+/g)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function mkReqId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
}

function appendJsonl(filePath, obj) {
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf-8");
  } catch {
    // ignore (telemetry should never crash prod flow)
  }
}

function emitTelemetry(event, payload, req) {
  const emit =
    (req?.app?.locals && req.app.locals.telemetryEmit) ||
    globalThis.__faeTelemetryEmit ||
    null;

  try {
    if (typeof emit === "function") emit(event, payload);
  } catch {
    // ignore
  }
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

function fallbackFixKey(s) {
  return safeStr(s)
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// TR-friendly normalization for keyword match (çğıöşü / ıİ)
// - not for ids, only for routing heuristics
function normQForMatch(q) {
  const s = safeStr(q).toLowerCase();
  const folded = s
    .replace(/[ç]/g, "c")
    .replace(/[ğ]/g, "g")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ş]/g, "s")
    .replace(/[ü]/g, "u")
    .replace(/[âàáä]/g, "a")
    .replace(/[îìíï]/g, "i")
    .replace(/[ûùúü]/g, "u");
  return folded.replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRegExp(s) {
  return safeStr(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureDiagKeys(meta, { engineVariant } = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  if (engineVariant && !m.engineVariant) m.engineVariant = engineVariant;

  // Common keys your PowerShell expects at top-level:
  if (typeof m.deadlineHit !== "boolean")
    m.deadlineHit = !!m.upstreamMeta?.deadlineHit;
  if (m.rateLimit == null) m.rateLimit = m.upstreamMeta?.rateLimit || null;
  if (m.adapterDiagnosticsSummary == null)
    m.adapterDiagnosticsSummary =
      m.upstreamMeta?.adapterDiagnosticsSummary || null;

  if (m.fallback == null) m.fallback = { used: false, strategy: "none" };
  if (m.fallback && typeof m.fallback === "object") {
    if (m.fallback.used == null) m.fallback.used = false;
    if (m.fallback.strategy == null) m.fallback.strategy = "none";
  }
  return m;
}

// ---------------------------------------------------------------------------
// Catalog fallback (feed-based)
// - Queries MongoDB collection to surface ingested feed items.
// ---------------------------------------------------------------------------
async function fetchCatalogFallback({
  q,
  limit,
  offset = 0,
  engineLimit,
  currency,
  providerKey,
  campaignId,
}) {
  const query = safeStr(q).trim();
  if (!query) {
    return {
      items: [],
      total: 0,
      nextOffset: 0,
      hasMore: false,
      meta: { ok: true, used: false, reason: "empty_q" },
    };
  }

  const reqOff = Math.max(0, safeInt(offset, 0));
  const reqTake = Math.min(Math.max(1, safeInt(limit, 20)), 200);

  // Ask DB for enough to page reliably (cap hard to avoid killing prod)
  const capA = (reqTake + reqOff) * 6;
  const capB = Math.max(50, safeInt(engineLimit, 10) * 10);
  const cap = Math.min(Math.max(capA, reqTake), capB, 800);

  const t0 = Date.now();
  try {
    const db = await getDb();
    const colName =
      safeStr(process.env.CATALOG_COLLECTION) ||
      safeStr(process.env.FEED_COLLECTION) ||
      "catalog_items";
    const col = db.collection(colName);

    const tokens = query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 6);

    const and = tokens.map((t) => ({
      title: { $regex: escapeRegExp(t), $options: "i" },
    }));

    const baseFilter = and.length
      ? { $and: and }
      : { title: { $regex: escapeRegExp(query), $options: "i" } };

    const filter = { ...baseFilter };

    const cur = safeStr(currency).trim().toUpperCase();
    if (cur) filter.currency = cur;

    const pk = safeStr(providerKey).toLowerCase();
    if (pk) filter.providerKey = pk;

    const cid = safeInt(campaignId, 0);
    if (cid > 0) filter.campaignId = cid;

    // Pull docs (best effort)
    let docs = await col
      .find(filter, {
        projection: {
          _id: 1,
          providerKey: 1,
          providerName: 1,
          campaignId: 1,
          offerId: 1,
          title: 1,
          price: 1,
          finalPrice: 1,
          currency: 1,
          image: 1,
          finalUrl: 1,
          originUrl: 1,
          updatedAt: 1,
        },
      })
      .sort({ finalPrice: 1, price: 1, updatedAt: -1 })
      .limit(cap)
      .toArray();

    // If token-AND is too strict, fall back to whole-query regex once.
    if (!docs?.length && and.length >= 2) {
      const looser = { ...filter };
      delete looser.$and;
      looser.title = { $regex: escapeRegExp(query), $options: "i" };
      docs = await col
        .find(looser, {
          projection: {
            _id: 1,
            providerKey: 1,
            providerName: 1,
            campaignId: 1,
            offerId: 1,
            title: 1,
            price: 1,
            finalPrice: 1,
            currency: 1,
            image: 1,
            finalUrl: 1,
            originUrl: 1,
            updatedAt: 1,
          },
        })
        .sort({ finalPrice: 1, price: 1, updatedAt: -1 })
        .limit(cap)
        .toArray();
    }

    // Total (best effort; can be heavy with regex, so guard)
    let total = docs.length;
    try {
      // Keep it bounded in time
      total = await col.countDocuments(filter, { maxTimeMS: 1500 });
    } catch {
      // ignore, keep docs.length
    }

    const mapped = (docs || [])
      .map((d) => {
        const pk2 = safeStr(d.providerKey) || "catalog";
        const cid2 = safeInt(d.campaignId, 0);
        const offerId = safeStr(d.offerId) || safeStr(d._id);
        const title = safeStr(d.title);
        const url = safeStr(d.finalUrl) || safeStr(d.originUrl);
        if (!title || !url) return null;

        const p = typeof d.price === "number" ? d.price : safeInt(d.price, 0);
        const fp =
          typeof d.finalPrice === "number"
            ? d.finalPrice
            : safeInt(d.finalPrice, 0);

        return {
          id: `${pk2}:${cid2}:${offerId}`,
          provider: pk2,
          providerKey: pk2,
          campaignId: cid2,
          offerId,
          title,
          price: p,
          finalPrice: fp,
          currency: safeStr(d.currency),
          image: safeStr(d.image),
          finalUrl: safeStr(d.finalUrl) || url,
          originUrl: safeStr(d.originUrl) || url,
        };
      })
      .filter(Boolean);

    const items = mapped.slice(reqOff, reqOff + reqTake);
    const nextOffset = reqOff + items.length;
    const hasMore = total > nextOffset;

    return {
      items,
      total,
      nextOffset,
      hasMore,
      meta: {
        ok: true,
        used: true,
        count: items.length,
        total,
        ms: Date.now() - t0,
        collection: colName,
        currency: cur || null,
        providerKey: pk || null,
        campaignId: cid > 0 ? cid : null,
        cap,
      },
    };
  } catch (e) {
    return {
      items: [],
      total: 0,
      nextOffset: 0,
      hasMore: false,
      meta: {
        ok: false,
        used: true,
        count: 0,
        total: 0,
        ms: Date.now() - t0,
        error: safeStr(e?.message || e),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Result normalization (DRIFT-SAFE)
// ---------------------------------------------------------------------------
function inferProviderKeyFromId(id) {
  const s = safeStr(id);
  const m = s.match(/^([a-z0-9_\-]+):/i);
  return m?.[1] ? safeStr(m[1]).toLowerCase() : "";
}

function normalizeProviderKeyLoose(k) {
  const s = safeStr(k).toLowerCase();
  if (!s) return "";
  if (s === "unknown" || s === "unknown_provider" || s === "unknownprovider")
    return "";
  return s;
}

function normalizeSearchItem(it) {
  const obj = it && typeof it === "object" ? it : {};

  const providerKey =
    normalizeProviderKeyLoose(obj.providerKey) ||
    normalizeProviderKeyLoose(obj.provider) ||
    normalizeProviderKeyLoose(obj.networkKey) ||
    normalizeProviderKeyLoose(obj.sourceProvider) ||
    normalizeProviderKeyLoose(inferProviderKeyFromId(obj.id)) ||
    (Number.isFinite(obj.campaignId) ? "admitad" : "");

  const url =
    safeStr(obj.url) ||
    safeStr(obj.finalUrl) ||
    safeStr(obj.originUrl) ||
    safeStr(obj.deeplink) ||
    safeStr(obj.link);

  const provider = normalizeProviderKeyLoose(obj.provider) || providerKey || "unknown";

  return {
    ...obj,
    providerKey: providerKey || "unknown",
    provider,
    url: url || obj.url || "",
    finalUrl: safeStr(obj.finalUrl) || url || "",
    originUrl: safeStr(obj.originUrl) || url || "",
  };
}

function keywordOverride(qNorm) {
  const tokens = new Set(qNorm.split(/\s+/).filter(Boolean));
  const has = (...ws) => ws.some((w) => tokens.has(w));
  const hasAnyInText = (...ws) => ws.some((w) => qNorm.includes(w));

  if (
    has(
      "psikolog",
      "psikiyatrist",
      "psikiyatri",
      "terapi",
      "terapist",
      "psikoterapi",
      "psikoloji",
      "danisman",
      "danismanlik"
    ) ||
    hasAnyInText("online terapi", "psikolojik destek")
  ) {
    return { group: "psychologist", reason: "keyword_psychology", keyword: "psychology" };
  }

  if (has("avukat", "hukuk", "dava", "icra", "bosanma", "arabulucu") || hasAnyInText("avukat")) {
    return { group: "lawyer", reason: "keyword_law", keyword: "law" };
  }

  const carSig = has("araba", "arac", "oto", "rent", "rental", "kiralik");
  const rentSig = has("kirala", "kiralama", "rent", "rental") || hasAnyInText("rent a car");
  if (carSig && rentSig) {
    return { group: "car_rental", reason: "keyword_car_rental", keyword: "car_rental" };
  }

  const hotelSig =
    has("otel", "hotel", "pansiyon", "konaklama") ||
    hasAnyInText("konaklama", "otel rezervasyon", "hotel booking");
  if (hotelSig) return { group: "hotel", reason: "keyword_hotel", keyword: "hotel" };

  const flightSig =
    has("ucak", "bilet") || hasAnyInText("ucak bileti", "uçak bileti", "flight ticket");
  if (flightSig) return { group: "flight", reason: "keyword_flight", keyword: "flight" };

  const tourSig = has("tur", "turu", "tour") || hasAnyInText("tur", "turu");
  if (tourSig) return { group: "tour", reason: "keyword_tour", keyword: "tour" };

  if (has("rezervasyon", "tatil", "transfer") || hasAnyInText("tatil", "transfer")) {
    return { group: "travel", reason: "keyword_travel", keyword: "travel" };
  }

  if (
    has("emlak", "daire", "arsa", "satilik", "kiralik", "ev", "konut") ||
    hasAnyInText("satilik daire")
  ) {
    return { group: "estate", reason: "keyword_estate", keyword: "estate" };
  }

  if (
    has("tamir", "servis", "usta", "onarim", "beyazesya", "kombiservis", "klimaservis") ||
    hasAnyInText("servis")
  ) {
    return { group: "repair", reason: "keyword_repair", keyword: "repair" };
  }

  if (has("spa", "masaj", "hamam", "wellness") || hasAnyInText("spa")) {
    return { group: "spa", reason: "keyword_spa", keyword: "spa" };
  }

  if (has("ofis", "office", "kirtasiye") || hasAnyInText("ofis")) {
    return { group: "office", reason: "keyword_office", keyword: "office" };
  }

  if (has("sahibinden", "arabam", "vasita", "arac", "araba") && has("satilik", "ilan")) {
    return { group: "vehicle_sale", reason: "keyword_vehicle_sale", keyword: "vehicle_sale" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Engine loader (cached)
// ---------------------------------------------------------------------------
let _engineP = null;
async function loadEngine() {
  if (_engineP) return _engineP;
  _engineP = (async () => {
    const engineMod = await import("../core/adapterEngine.js");
    return engineMod;
  })();
  return _engineP;
}

// ---------------------------------------------------------------------------
// S40 AUTO GROUP DETECTION (+ keyword override)
// ---------------------------------------------------------------------------
async function detectAuto(engine, q, region, req) {
  const t0 = Date.now();
  const auto = {
    requestedGroup: "auto",
    predictedIntent: null,
    intent: null,
    confidence: null,
    candidates: null,
    predictedGroup: DEFAULT_GROUP,
    resolvedGroup: DEFAULT_GROUP,
    overrideSource: null,
    overrideReason: null,
    overrideKeyword: null,
    method: "fallback",
    ms: 0,
    routerOverride: null,
  };

  const fx = typeof engine?.fixKey === "function" ? engine.fixKey : fallbackFixKey;

  if (typeof engine?.s40_routerOverride === "function") {
    try {
      const r = await engine.s40_routerOverride(q, { region });
      const g = typeof r === "string" ? r : pick(r, ["group", "category", "route", "targetGroup"]);
      if (g) {
        auto.routerOverride = g;
        const gg = fx(g) || DEFAULT_GROUP;
        auto.predictedGroup = gg;
        auto.resolvedGroup = gg;
        auto.overrideSource = "router";
        auto.overrideReason = "router_override";
        auto.method = "s40_routerOverride";
        auto.ms = Date.now() - t0;
        return auto;
      }
    } catch {
      // ignore
    }
  }

  if (typeof engine?.s40_safeDetectIntent === "function") {
    try {
      const r = await engine.s40_safeDetectIntent(q, { region });
      if (typeof r === "string") {
        auto.predictedIntent = r;
        auto.intent = r;
      } else if (r && typeof r === "object") {
        const it = pick(r, ["intent", "label", "topic", "route", "category"]);
        auto.predictedIntent = it || null;
        auto.intent = auto.predictedIntent;
        auto.confidence = pick(r, ["confidence", "score", "prob", "p"]);
        auto.candidates = pick(r, ["candidates", "top", "alts", "alternatives"]);
      }
      auto.method = "s40_safeDetectIntent";
    } catch {
      // ignore
    }
  }

  if (auto.predictedIntent && typeof engine?.s40_mapIntentToCategory === "function") {
    try {
      const mapped = await engine.s40_mapIntentToCategory(auto.predictedIntent, { region });
      if (mapped) {
        auto.predictedGroup = fx(mapped) || DEFAULT_GROUP;
        auto.resolvedGroup = auto.predictedGroup;
        auto.method = `${auto.method}+map`;
      }
    } catch {
      // ignore
    }
  } else {
    auto.predictedGroup = DEFAULT_GROUP;
    auto.resolvedGroup = DEFAULT_GROUP;
  }

  const kw = keywordOverride(normQForMatch(q));
  if (kw?.group) {
    const g2 = fx(kw.group) || DEFAULT_GROUP;
    if (g2 && g2 !== auto.resolvedGroup) {
      auto.overrideSource = "keyword";
      auto.overrideReason = kw.reason || "keyword_override";
      auto.overrideKeyword = kw.keyword || null;
      auto.resolvedGroup = g2;
      auto.method = `${auto.method}+kw`;
    }
  }

  if (!auto.overrideSource && auto.resolvedGroup === DEFAULT_GROUP) {
    const intentKey = fx(auto.predictedIntent || "");
    const heur = {
      psychologist: "psychologist",
      psychology: "psychologist",
      psikolog: "psychologist",
      psikoloji: "psychologist",
      therapist: "psychologist",
      lawyer: "lawyer",
      avukat: "lawyer",
      hukuk: "lawyer",
      rent: "rental",
      kirala: "rental",
      arac_kirala: "car_rental",
      araba_kirala: "car_rental",
      car_rental: "car_rental",
      hotel: "hotel",
      ucak: "flight",
      otel: "hotel",
      bilet: "flight",
      booking: "hotel",
      sahibinden: "vehicle_sale",
      emlak: "estate",
      satilik: "estate",
      kiralik: "estate",
      ev: "estate",
      usta: "repair",
      tamir: "repair",
      servis: "repair",
      beyaz_esya: "repair",
      spa: "spa",
      masaj: "spa",
      office: "office",
      ofis: "office",
    };

    const g = heur[intentKey];
    if (g) {
      auto.overrideSource = "heuristic";
      auto.overrideReason = "intent_heuristic_map";
      auto.resolvedGroup = fx(g) || DEFAULT_GROUP;
      auto.method = `${auto.method}+heur`;
    }
  }

  auto.ms = Date.now() - t0;
  return auto;
}

// ---------------------------------------------------------------------------
// runAdapters call (signature-safe)
// ---------------------------------------------------------------------------
async function callRunAdapters(runAdapters, q, group, region, opts) {
  const g = String(group || "").trim().toLowerCase();
  const reg = String(region || "TR").trim() || "TR";
  const baseOpts = { ...(opts || {}), region: reg };

  const force = g && g !== "auto";
  const engineOpts = force ? { ...baseOpts, forceCategory: g, category: g, group: g } : { ...baseOpts };

  try {
    return await runAdapters(q, reg, engineOpts);
  } catch {}
  try {
    return await runAdapters(q, engineOpts);
  } catch {}
  try {
    return await runAdapters({ q, query: q, region: reg, ...engineOpts });
  } catch {}
  return await runAdapters(q);
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const reqId = mkReqId();
  try {
    res.set("Cache-Control", "no-store");
    res.set("X-FAE-ReqId", reqId);
  } catch {}

  const t0 = Date.now();

  // ✅ Accept both q and query (POST + GET)
  const qRaw = safeStr(
    req.method === "POST"
      ? (req.body?.q ?? req.body?.query)
      : (req.query?.q ?? req.query?.query)
  );

  const typo = fixQueryTyposTR(qRaw);
  const q = (typo?.query || qRaw) || "";

  // ✅ Accept both group and category (POST + GET)
  const groupIn = safeStr(
    req.method === "POST"
      ? (req.body?.group ?? req.body?.category)
      : (req.query?.group ?? req.query?.category)
  );

  const region =
    safeStr(
      (req.method === "POST" ? req.body?.region : req.query?.region) || REGION_DEFAULT
    ) || REGION_DEFAULT;

  const locale =
    safeStr(
      (req.method === "POST" ? req.body?.locale : req.query?.locale) || "tr"
    ) || "tr";

  const currencyParam = safeStr(req.method === "POST" ? req.body?.currency : req.query?.currency);

  const providerIn =
    req.method === "POST"
      ? (req.body?.provider ?? req.body?.providers)
      : (req.query?.provider ?? req.query?.providers);

  const requestedProviders = parseList(providerIn)
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);

  const envProviderAllow = parseList(process.env.FINDALLEASY_SEARCH_PROVIDER_ALLOWLIST)
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);

  const providerAllow = requestedProviders.length
    ? requestedProviders
    : (envProviderAllow.length ? envProviderAllow : null);

  const reqLimit = clampInt(
    req.method === "POST" ? req.body?.limit : req.query?.limit,
    20,
    1,
    100
  );
  const reqOffset = Math.max(
    0,
    toInt(req.method === "POST" ? req.body?.offset : req.query?.offset, 0)
  );

  const engineLimit = clampInt(reqLimit + reqOffset, reqLimit, 1, 200);
  const requestedGroupRaw = groupIn || "auto";

  if (!q) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_Q",
      q: "",
      group: requestedGroupRaw,
      results: [],
      items: [],
      count: 0,
      total: 0,
      nextOffset: 0,
      hasMore: false,
      cards: [],
      _meta: ensureDiagKeys(
        { reqId, ms: Date.now() - t0, engineVariant: "MISSING_Q" },
        { engineVariant: "MISSING_Q" }
      ),
    });
  }

  // Engine load
  let engine;
  try {
    engine = await loadEngine();
  } catch (e) {
    const payload = {
      type: "search",
      ts: nowIso(),
      reqId,
      q,
      requestedGroup: requestedGroupRaw,
      error: "ENGINE_LOAD_FAIL",
      message: safeStr(e?.message),
    };
    appendJsonl(INTENT_LOG_PATH, payload);
    emitTelemetry("intent.search.error", payload, req);

    return res.status(500).json({
      ok: false,
      error: "ENGINE_LOAD_FAIL",
      message: safeStr(e?.message) || "adapterEngine import failed",
      q,
      group: requestedGroupRaw,
      results: [],
      items: [],
      count: 0,
      total: 0,
      nextOffset: 0,
      hasMore: false,
      cards: [],
      _meta: ensureDiagKeys(
        { reqId, ms: Date.now() - t0, engineVariant: "ENGINE_LOAD_FAIL" },
        { engineVariant: "ENGINE_LOAD_FAIL" }
      ),
    });
  }

  const fx = typeof engine?.fixKey === "function" ? engine.fixKey : fallbackFixKey;

  // AUTO group resolve
  let autoMeta = null;
  let resolvedGroup = fx(requestedGroupRaw) || DEFAULT_GROUP;
  if (!requestedGroupRaw || fx(requestedGroupRaw) === "auto") {
    autoMeta = await detectAuto(engine, q, region, req);
    resolvedGroup = autoMeta.resolvedGroup || DEFAULT_GROUP;
  }
  if (!resolvedGroup) resolvedGroup = DEFAULT_GROUP;

  // ---------------------------------------------------------------------------
  // PRODUCT MODE: catalog-only (default) / catalog-first / adapters-first
  // ---------------------------------------------------------------------------
  const bodyOrQueryGroup = safeStr(
    req.method === "POST"
      ? (req.body?.group ?? req.body?.category)
      : (req.query?.group ?? req.query?.category)
  ).toLowerCase();

  const isProductRequest = bodyOrQueryGroup === "product" || resolvedGroup === "product";
  const productMode = String(process.env.SEARCH_PRODUCT_MODE || "catalog_only").toLowerCase();

  if (isProductRequest && productMode === "catalog_only") {
    try {
      const ts = nowIso();

      const catProviderKey = safeStr(
        process.env.CATALOG_PROVIDER_KEY ||
          process.env.FEED_PROVIDER_KEY ||
          "admitad"
      );
      const catCampaignId = safeInt(process.env.CATALOG_CAMPAIGN_ID, 0);
      const catCurrency = safeStr(
        currencyParam ||
          process.env.CATALOG_CURRENCY ||
          process.env.FEED_DEFAULT_CURRENCY ||
          ""
      );

      const cat = await fetchCatalogFallback({
        q,
        limit: reqLimit,
        offset: reqOffset,
        engineLimit,
        currency: catCurrency,
        providerKey: catProviderKey,
        campaignId: catCampaignId,
      });

      const items = Array.isArray(cat?.items) ? cat.items : [];
      const baseCount = items.length; // ✅ patch: keep pre-fallback count

      const total = safeInt(cat?.total, items.length);
      const nextOffset = safeInt(cat?.nextOffset, reqOffset + items.length);
      const hasMore = Boolean(cat?.hasMore);

      const payload = {
        type: "search",
        ts,
        reqId,
        q,
        requestedGroup: requestedGroupRaw,
        resolvedGroup: "product",
        mode: "catalog_only",
        count: items.length,
        total,
      };
      appendJsonl(INTENT_LOG_PATH, payload);
      emitTelemetry("intent.search.catalog_only", payload, req);

      let response = {
        ok: true,
        reqId,
        ts,
        q,
        query: q,
        category: "product",
        group: "product",
        region,
        locale,
        usedGroup: "product",
        intent: safeStr(autoMeta?.intent) || safeStr(autoMeta?.category) || "product",
        results: items,
        items,
        count: items.length,
        total,
        nextOffset,
        hasMore,
        cards: [],
        _meta: ensureDiagKeys(
          {
            engineVariant: "CATALOG_ONLY",
            deadlineHit: false, // ✅ deterministic
            rateLimit: null,
            adapterDiagnosticsSummary: null,
            fallback: { used: false, strategy: "none" }, // ✅ deterministic

            offset: reqOffset,
            limit: reqLimit,
            ms: Date.now() - t0,

            catalog: cat?.meta || null,
            ...(autoMeta ? { auto: autoMeta } : {}),
          },
          { engineVariant: "CATALOG_ONLY" }
        ),
      };

      // Fallback if catalog is empty: reviewer-facing bandaj (SerpApi, etc.)
      try {
        response = await applyS200FallbackIfEmpty({
          req,
          result: response,
          q: response?.q ?? q,
          group: "product",
          region,
          locale,
          limit: reqLimit,
          reason: items.length ? "CATALOG_OK" : "CATALOG_EMPTY",
        });
      } catch {
        // ignore
      }

      // Ensure diag keys survive fallback merge
      response._meta = ensureDiagKeys(response._meta, {
        engineVariant: response?._meta?.engineVariant || "CATALOG_ONLY",
      });

      // ✅ patch: Fill diagnostics summary even for catalog-only (so diag=1 isn't blank)
      try {
        response._meta = response._meta || {};
        if (typeof response._meta.deadlineHit !== "boolean")
          response._meta.deadlineHit = false;
        if (!response._meta.fallback)
          response._meta.fallback = { used: false, strategy: "none" };
        if (response._meta.fallback && typeof response._meta.fallback === "object") {
          if (response._meta.fallback.used == null) response._meta.fallback.used = false;
          if (response._meta.fallback.strategy == null)
            response._meta.fallback.strategy = "none";
        }

        const exposeDiag = shouldExposeDiagnostics(req);
        if (exposeDiag && !response._meta.adapterDiagnosticsSummary) {
          const finalCount = Array.isArray(response.items) ? response.items.length : 0;

          const cmeta = response._meta.catalog || {};
          const pk = safeStr(cmeta?.providerKey || catProviderKey || "");
          const cid = Number(cmeta?.campaignId ?? catCampaignId ?? 0) || 0;

          response._meta.adapterDiagnosticsSummary = {
            variant: String(response._meta.engineVariant || "CATALOG_ONLY"),
            primary: {
              variant: "CATALOG_ONLY",
              used: true,
              count: Number(baseCount || 0),
              ms: Number(cmeta?.ms || response._meta.ms || 0),
              providerKey: pk,
              campaignId: cid,
            },
            final: {
              variant: String(response._meta.engineVariant || "CATALOG_ONLY"),
              usedGroup: String(response.usedGroup || "product"),
              count: Number(finalCount || 0),
            },
            fallback: response._meta.fallback || { used: false, strategy: "none" },
            adapters: { used: false, count: 0 },
          };
        }
      } catch {}

      const exposeDiag = shouldExposeDiagnostics(req);
      if (!exposeDiag) {
        try {
          if (Array.isArray(response?.items)) {
            response.items = response.items.map((it) => {
              const { _raw, ...rest } = it || {};
              return rest;
            });
          }
          if (Array.isArray(response?.results)) response.results = response.items;
        } catch {}
      }

      return res.status(200).json(response);
    } catch (e) {
      const msg = safeStr(e?.message || e);
      console.warn(`[${reqId}] catalog_only failed -> adapters`, msg);
      // fall through to adapter engine
    }
  }

  // Run adapters
  if (typeof engine?.runAdapters !== "function") {
    const payload = {
      type: "search",
      ts: nowIso(),
      reqId,
      q,
      requestedGroup: requestedGroupRaw,
      resolvedGroup,
      error: "NO_SEARCH_FN",
      exports: Object.keys(engine || {}),
    };
    appendJsonl(INTENT_LOG_PATH, payload);
    emitTelemetry("intent.search.error", payload, req);

    return res.status(500).json({
      ok: false,
      error: "NO_SEARCH_FN",
      q,
      group: resolvedGroup,
      results: [],
      items: [],
      count: 0,
      total: 0,
      nextOffset: 0,
      hasMore: false,
      cards: [],
      _meta: ensureDiagKeys(
        {
          reqId,
          q,
          group: resolvedGroup,
          requestedGroup: requestedGroupRaw,
          engine: "../core/adapterEngine.js",
          exports: Object.keys(engine || {}),
          engineVariant: "NO_SEARCH_FN",
        },
        { engineVariant: "NO_SEARCH_FN" }
      ),
    });
  }

  let upstream = null;
  let upstreamOk = true;
  let upstreamMeta = null;

  try {
    upstream = await callRunAdapters(engine.runAdapters, q, resolvedGroup, region, {
      limit: engineLimit,
      offset: 0,
      region,
      reqLimit,
      reqOffset,
    });
    upstreamOk = upstream?.ok !== false;
    upstreamMeta = upstream?._meta || null;
  } catch (e) {
    upstreamOk = false;
    upstreamMeta = { error: "RUN_ADAPTERS_THROW", message: safeStr(e?.message) };
    upstream = { ok: false, items: [], count: 0, source: resolvedGroup, _meta: upstreamMeta };
  }

  const rawItems0 = Array.isArray(upstream?.items)
    ? upstream.items
    : Array.isArray(upstream?.results)
      ? upstream.results
      : [];

  // FEED CATALOG FALLBACK (MongoDB) in adapters mode too
  let rawItems = rawItems0;
  let catalogMeta = null;

  const includeCatalog =
    resolvedGroup === "product" &&
    String(process.env.SEARCH_INCLUDE_CATALOG ?? "1") !== "0";

  if (includeCatalog) {
    const curHint = safeStr(currencyParam || process.env.SEARCH_CATALOG_CURRENCY || "");
    const catProviderKey = safeStr(process.env.CATALOG_PROVIDER_KEY || process.env.FEED_PROVIDER_KEY || "");
    const catCampaignId = safeInt(process.env.CATALOG_CAMPAIGN_ID, 0);

    const cat = await fetchCatalogFallback({
      q,
      limit: reqLimit,
      offset: 0,
      engineLimit,
      currency: curHint,
      providerKey: catProviderKey,
      campaignId: catCampaignId,
    });

    if (cat?.items?.length) rawItems = rawItems0.concat(cat.items);
    catalogMeta = cat?.meta || null;
  }

  const normalizedItems = rawItems.map(normalizeSearchItem).filter(Boolean);

  const filteredItems = providerAllow
    ? normalizedItems.filter((it) => {
        const pk = String(it?.providerKey || it?.provider || "").toLowerCase();
        if (pk && providerAllow.includes(pk)) return true;
        const idp = String(it?.id || "").toLowerCase();
        return providerAllow.some((p) => idp.startsWith(p + ":"));
      })
    : normalizedItems;

  const total = filteredItems.length;
  const items = filteredItems.slice(reqOffset, reqOffset + reqLimit);
  const count = items.length;

  // Cards — ONLY "best" active
  const pickPrice = (it) => {
    const v = it?.optimizedPrice ?? it?.finalPrice ?? it?.price;
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const trustOf = (it) => {
    const t = it?.commissionMeta?.providerTrust ?? it?.providerTrust ?? null;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  };

  const candidates = filteredItems.filter((it) => {
    const p = pickPrice(it);
    return !!it?.title && !!it?.url && p != null;
  });

  const trusted = candidates.filter((it) => {
    const t = trustOf(it);
    return t == null ? true : t >= 0.45;
  });

  const pool = trusted.length ? trusted : candidates;
  const best = pool.reduce((acc, cur) => {
    if (!acc) return cur;
    const ap = pickPrice(acc);
    const cp = pickPrice(cur);
    return ap == null ? cur : cp == null ? acc : cp < ap ? cur : acc;
  }, null);

  const cards = [
    {
      key: "best",
      title: "En uygun & güvenilir",
      desc: best ? String(best.title || "") : "Öneriler hazırlanıyor...",
      cta: "Tıkla",
      region: String(region || "TR"),
    },
  ];

  // Telemetry (AUTO)
  const usedAuto = !!autoMeta;
  if (usedAuto) {
    intentStats.autoRequests += 1;

    const predictedGroup = fx(autoMeta.predictedGroup || DEFAULT_GROUP) || DEFAULT_GROUP;
    const resolved = fx(resolvedGroup) || DEFAULT_GROUP;
    const correctedByOverride =
      !!autoMeta.overrideSource && predictedGroup && resolved && predictedGroup !== resolved;

    if (autoMeta.overrideSource) {
      intentStats.overrides += 1;
      bump(intentStats.byOverrideSource, autoMeta.overrideSource, 1);
      bump(intentStats.byOverrideReason, autoMeta.overrideReason || "unknown", 1);
      if (correctedByOverride) intentStats.overrideCorrected += 1;
    }

    const payload = {
      type: "search",
      ts: nowIso(),
      reqId,
      q,
      requestedGroup: requestedGroupRaw,
      predictedGroup,
      resolvedGroup: resolved,
      intent: autoMeta.intent,
      predictedIntent: autoMeta.predictedIntent,
      confidence: autoMeta.confidence,
      method: autoMeta.method,
      msDetect: autoMeta.ms,
      routerOverride: autoMeta.routerOverride,
      overrideSource: autoMeta.overrideSource,
      overrideReason: autoMeta.overrideReason,
      overrideKeyword: autoMeta.overrideKeyword,
      correctedByOverride,
      limit: reqLimit,
      offset: reqOffset,
      region,
      upstreamOk,
      upstream: {
        adapterCount: pick(upstreamMeta, ["adapterCount", "totalRawAdapters", "completedRawAdapters"]),
        adaptersWithItems: pick(upstreamMeta, ["adaptersWithItems"]),
        deadlineHit: pick(upstreamMeta, ["deadlineHit"]),
        engineVariant: pick(upstreamMeta, ["engineVariant"]),
      },
      ua: safeStr(req.headers["user-agent"]),
      ip: safeStr(req.headers["x-forwarded-for"] || req.socket?.remoteAddress),
    };

    appendJsonl(INTENT_LOG_PATH, payload);
    emitTelemetry("intent.search", payload, req);

    intentStats.last.unshift(payload);
    if (intentStats.last.length > 50) intentStats.last.length = 50;
  }

  const msTotal = Date.now() - t0;

  const upstreamVariant = safeStr(pick(upstreamMeta, ["engineVariant"])) || "S200";

  let response = {
    ok: true,
    q,
    query: q,
    category: resolvedGroup,
    group: resolvedGroup,
    region,
    locale,
    results: items,
    items,
    count,
    total,
    nextOffset: reqOffset + count,
    hasMore: reqOffset + count < total,
    cards,
    _meta: ensureDiagKeys(
      {
        reqId,
        ms: msTotal,
        q,
        group: resolvedGroup,
        requestedGroup: requestedGroupRaw,
        region,
        engine: "../core/adapterEngine.js",
        exports: Object.keys(engine || {}),
        source: resolvedGroup,
        limit: reqLimit,
        offset: reqOffset,
        engineLimit,
        upstreamCount: rawItems0.length,
        rawCount: normalizedItems.length,
        filteredCount: total,
        returnedCount: count,
        ...(providerAllow ? { providerAllow } : {}),
        upstreamOk,
        upstreamMeta,
        engineVariant: upstreamVariant,
        deadlineHit: !!pick(upstreamMeta, ["deadlineHit"]),
        rateLimit: pick(upstreamMeta, ["rateLimit"]) || null,
        adapterDiagnosticsSummary: pick(upstreamMeta, ["adapterDiagnosticsSummary"]) || null,
        ...(catalogMeta ? { catalog: catalogMeta, catalogCount: safeInt(catalogMeta.count, 0) } : {}),
        ...(usedAuto ? { auto: autoMeta } : {}),
        ...(typo?.fixed ? { qOriginal: qRaw, typoFix: typo.changes } : {}),
      },
      { engineVariant: upstreamVariant }
    ),
  };

  // Empty => fallback bandaj
  try {
    const reason =
      response?._meta?.upstreamMeta?.deadlineHit ? "DEADLINE_HIT" : "EMPTY_PRIMARY";

    response = await applyS200FallbackIfEmpty({
      req,
      result: response,
      q: response?.q ?? response?.query ?? q,
      group: response?.group ?? resolvedGroup,
      region: response?.region ?? region,
      locale: response?.locale ?? locale,
      limit: reqLimit,
      reason,
    });
  } catch {
    // do not crash the route
  }

  // Ensure diag keys survive fallback merge
  response._meta = ensureDiagKeys(response._meta, {
    engineVariant: response?._meta?.engineVariant || upstreamVariant,
  });

  // Diagnostics gate
  const exposeDiag = shouldExposeDiagnostics(req);
  if (!exposeDiag) {
    try {
      const um = response?._meta?.upstreamMeta;
      if (um && typeof um === "object") {
        if (Array.isArray(um.adapterDiagnostics)) um.adapterDiagnostics = [];
      }
    } catch {}

    try {
      if (Array.isArray(response?.items)) {
        response.items = response.items.map((it) => {
          const { _raw, ...rest } = it || {};
          return rest;
        });
      }
      if (Array.isArray(response?.results)) response.results = response.items;
    } catch {}
  }

  return res.json(response);
}

// ---------------------------------------------------------------------------
// Feedback endpoint (intent accuracy)
// ---------------------------------------------------------------------------
async function feedback(req, res) {
  const reqId = mkReqId();
  const ts = nowIso();

  const q = safeStr(req.body?.q ?? req.body?.query);
  const predictedGroup = safeStr(
    req.body?.predictedGroup || req.body?.predicted || req.body?.groupPred
  );
  const correctGroup = safeStr(
    req.body?.correctGroup || req.body?.correct || req.body?.groupTrue
  );
  const intent = safeStr(req.body?.intent);
  const confidence = req.body?.confidence ?? null;

  const action = safeStr(req.body?.action || "feedback");
  const note = safeStr(req.body?.note || "");

  if (!q) return res.status(400).json({ ok: false, error: "MISSING_Q", reqId });
  if (!predictedGroup || !correctGroup)
    return res.status(400).json({ ok: false, error: "MISSING_GROUPS", reqId });

  intentStats.feedback += 1;
  bump(intentStats.byPredicted, predictedGroup, 1);
  bump(intentStats.byCorrect, correctGroup, 1);
  bumpConfusion(predictedGroup, correctGroup);

  const isCorrect = predictedGroup === correctGroup;
  if (isCorrect) intentStats.correct += 1;
  else intentStats.wrong += 1;

  const payload = {
    type: "feedback",
    ts,
    reqId,
    q,
    predictedGroup,
    correctGroup,
    correct: isCorrect,
    intent: intent || null,
    confidence,
    action,
    note,
    ua: safeStr(req.headers["user-agent"]),
    ip: safeStr(req.headers["x-forwarded-for"] || req.socket?.remoteAddress),
  };

  appendJsonl(INTENT_LOG_PATH, payload);
  emitTelemetry("intent.feedback", payload, req);

  return res.json({ ok: true, reqId, correct: isCorrect });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.get("/", safeRoute(handle));
router.post("/", safeRoute(handle));

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "search", ts: nowIso() });
});

router.get("/intent-metrics", (_req, res) => {
  const denom = intentStats.correct + intentStats.wrong;
  const acc = denom > 0 ? intentStats.correct / denom : null;
  const overrideAccDenom = intentStats.overrides;
  const overrideCorrectRate =
    overrideAccDenom > 0 ? intentStats.overrideCorrected / overrideAccDenom : null;

  res.json({
    ok: true,
    autoRequests: intentStats.autoRequests,
    feedback: intentStats.feedback,
    correct: intentStats.correct,
    wrong: intentStats.wrong,
    accuracy: acc,
    overrides: intentStats.overrides,
    overrideCorrected: intentStats.overrideCorrected,
    overrideCorrectRate,
    byOverrideSource: intentStats.byOverrideSource,
    byOverrideReason: intentStats.byOverrideReason,
    byPredicted: intentStats.byPredicted,
    byCorrect: intentStats.byCorrect,
    confusion: intentStats.confusion,
    last: intentStats.last.slice(0, 10),
  });
});

router.post("/feedback", feedback);

export default router;
