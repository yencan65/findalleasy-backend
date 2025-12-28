// server/routes/search.js
// ============================================================================
// SEARCH ROUTE — S40 AUTO GROUP + INTENT TELEMETRY (DRIFT-SAFE)
// - GET  /api/search?q=...&group=auto|product|office|...
// - POST /api/search { q, group, limit, offset, region }
// - POST /api/search/feedback  (intent accuracy signal)
// - GET  /api/search/health
// - GET  /api/search/intent-metrics
//
// Goals:
// ✅ "Kullanıcı ne yazarsa yazsın" → group=auto ile S40 intent-detection
// ✅ NO CRASH: engine/import fail → observable ok:false + empty
// ✅ Telemetry: _meta.auto + JSONL log (brain_logs/intent_accuracy.jsonl)
// ✅ Keyword override: TR coverage boşluklarını üretimde kapat (ölçülebilir)
// ============================================================================

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fixQueryTyposTR } from "../utils/queryTypoFixer.js";
import { getDb } from "../db.js";

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
        _meta: { fatal: true, error: safeStr(e?.message || e) },
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

// ---------------------------------------------------------------------------
// Catalog fallback (feed-based)
// - /api/search (group=product) will also query MongoDB catalog_items so we see
//   real products immediately after a feed ingest, even if live adapters return 0.
// - Controlled by env: SEARCH_INCLUDE_CATALOG (default: 1, set 0 to disable).
// - Optional query param: currency=TRY (or env SEARCH_CATALOG_CURRENCY=TRY)
// ---------------------------------------------------------------------------
async function fetchCatalogFallback({ q, limit, engineLimit, currency }) {
  const query = safeStr(q).trim();
  if (!query) {
    return { items: [], meta: { ok: true, used: false, reason: "empty_q" } };
  }

  const take = Math.min(Math.max(1, safeInt(limit, 20)), 200);
  const capA = take * 6;
  const capB = Math.max(50, safeInt(engineLimit, 10) * 10);
  const cap = Math.min(Math.max(capA, take), capB, 600);

  const t0 = Date.now();
  try {
    // getDb() is async (Mongo driver connect + db select)
    // If we don't await here, db is a Promise -> db.collection is not a function
    const db = await getDb();
    // Prefer CATALOG_COLLECTION; keep FEED_COLLECTION for backward compat
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

    const filter = and.length
      ? { $and: and }
      : { title: { $regex: escapeRegExp(query), $options: "i" } };

    const cur = safeStr(currency).trim().toUpperCase();
    if (cur) filter.currency = cur;

    const docs = await col
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

    const items = docs
      .map((d) => {
        const providerKey = safeStr(d.providerKey) || "catalog";
        const campaignId = safeInt(d.campaignId, 0);
        const offerId = safeStr(d.offerId) || safeStr(d._id);
        const title = safeStr(d.title);
        const url = safeStr(d.finalUrl) || safeStr(d.originUrl);
        if (!title || !url) return null;

        const p = Number.isFinite(d.price) ? d.price : safeInt(d.price, 0);
        const fp = Number.isFinite(d.finalPrice)
          ? d.finalPrice
          : safeInt(d.finalPrice, 0);

        return {
          id: `${providerKey}:${campaignId}:${offerId}`,
          provider: providerKey,
          providerKey,
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

    return {
      items,
      meta: {
        ok: true,
        used: true,
        count: items.length,
        ms: Date.now() - t0,
        collection: colName,
        currency: cur,
      },
    };
  } catch (e) {
    return {
      items: [],
      meta: {
        ok: false,
        used: true,
        count: 0,
        ms: Date.now() - t0,
        error: safeStr(e?.message || e),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Result normalization (DRIFT-SAFE)
// - provider/providerKey may be missing (or "unknown") depending on engine branch
// - url may be missing while finalUrl/originUrl exists
// - we normalize here so API contract stays stable
// ---------------------------------------------------------------------------
function inferProviderKeyFromId(id) {
  const s = safeStr(id);
  const m = s.match(/^([a-z0-9_\-]+):/i);
  return m?.[1] ? safeStr(m[1]).toLowerCase() : "";
}

function normalizeProviderKeyLoose(k) {
  const s = safeStr(k).toLowerCase();
  if (!s) return "";
  if (s === "unknown" || s === "unknown_provider" || s === "unknownprovider") return "";
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

  // URL: prefer explicit url, otherwise fall back to affiliate/final links.
  const url =
    safeStr(obj.url) ||
    safeStr(obj.finalUrl) ||
    safeStr(obj.originUrl) ||
    safeStr(obj.deeplink) ||
    safeStr(obj.link);

  const provider =
    normalizeProviderKeyLoose(obj.provider) ||
    providerKey ||
    "unknown";

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
  // Strong signals only (avoid “her şeyi override eden” saçmalık)
  const tokens = new Set(qNorm.split(/\s+/).filter(Boolean));
  const has = (...ws) => ws.some((w) => tokens.has(w));
  const hasAnyInText = (...ws) => ws.some((w) => qNorm.includes(w));

  // --- PSYCHOLOGY ---
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

  // --- LAW ---
  if (has("avukat", "hukuk", "dava", "icra", "bosanma", "arabulucu") || hasAnyInText("avukat")) {
    return { group: "lawyer", reason: "keyword_law", keyword: "law" };
  }

  // --- CAR RENTAL (needs car+rent signal) ---
  const carSig = has("araba", "arac", "oto", "rent", "rental", "kiralik");
  const rentSig = has("kirala", "kiralama", "rent", "rental") || hasAnyInText("rent a car");
  if (carSig && rentSig) {
    return { group: "car_rental", reason: "keyword_car_rental", keyword: "car_rental" };
  }


  // --- HOTEL / FLIGHT / TRAVEL / TOUR ---
  const hotelSig = has("otel", "hotel", "pansiyon", "konaklama") || hasAnyInText("konaklama", "otel rezervasyon", "hotel booking");
  if (hotelSig) {
    return { group: "hotel", reason: "keyword_hotel", keyword: "hotel" };
  }

  const flightSig = has("ucak", "bilet") || hasAnyInText("ucak bileti", "uçak bileti", "flight ticket");
  if (flightSig) {
    return { group: "flight", reason: "keyword_flight", keyword: "flight" };
  }

  const tourSig = has("tur", "turu", "tour") || hasAnyInText("tur", "turu");
  if (tourSig) {
    return { group: "tour", reason: "keyword_tour", keyword: "tour" };
  }

  if (has("rezervasyon", "tatil", "transfer") || hasAnyInText("tatil", "transfer")) {
    return { group: "travel", reason: "keyword_travel", keyword: "travel" };
  }

  // --- ESTATE ---
  if (has("emlak", "daire", "arsa", "satilik", "kiralik", "ev", "konut") || hasAnyInText("satilik daire")) {
    // NOTE: “kiralik” tek başına car_rental ile çakışır; car+rent yukarıda daha güçlü.
    return { group: "estate", reason: "keyword_estate", keyword: "estate" };
  }

  // --- REPAIR / SERVICE ---
  if (has("tamir", "servis", "usta", "onarim", "beyazesya", "kombiservis", "klimaservis") || hasAnyInText("servis")) {
    return { group: "repair", reason: "keyword_repair", keyword: "repair" };
  }

  // --- SPA ---
  if (has("spa", "masaj", "hamam", "wellness") || hasAnyInText("spa")) {
    return { group: "spa", reason: "keyword_spa", keyword: "spa" };
  }

  // --- OFFICE ---
  if (has("ofis", "office", "kirtasiye", "kirtasiye") || hasAnyInText("ofis")) {
    return { group: "office", reason: "keyword_office", keyword: "office" };
  }

  // --- VEHICLE SALE ---
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

    // S40 side (what the model/mapper says)
    predictedIntent: null,
    intent: null, // alias for backward compatibility
    confidence: null,
    candidates: null,
    predictedGroup: DEFAULT_GROUP,

    // final routing decision
    resolvedGroup: DEFAULT_GROUP,

    // override details (keyword/router/heuristic)
    overrideSource: null,
    overrideReason: null,
    overrideKeyword: null,

    method: "fallback",
    ms: 0,
    routerOverride: null,
  };

  const fx =
    typeof engine?.fixKey === "function" ? engine.fixKey : fallbackFixKey;

  // 1) Router override (hard route correction hook)
  if (typeof engine?.s40_routerOverride === "function") {
    try {
      const r = await engine.s40_routerOverride(q, { region });
      const g =
        typeof r === "string"
          ? r
          : pick(r, ["group", "category", "route", "targetGroup"]);
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

  // 2) Intent detection
  if (typeof engine?.s40_safeDetectIntent === "function") {
    try {
      const r = await engine.s40_safeDetectIntent(q, { region });
      if (typeof r === "string") {
        auto.predictedIntent = r;
        auto.intent = r;
      } else if (r && typeof r === "object") {
        const it = pick(r, ["intent", "label", "topic", "route", "category"]);
        auto.predictedIntent = it || null;
        auto.intent = auto.predictedIntent; // alias
        auto.confidence = pick(r, ["confidence", "score", "prob", "p"]);
        auto.candidates = pick(r, ["candidates", "top", "alts", "alternatives"]);
      }
      auto.method = "s40_safeDetectIntent";
    } catch {
      // ignore
    }
  }

  // 3) Map intent -> group/category (this becomes predictedGroup)
  if (auto.predictedIntent && typeof engine?.s40_mapIntentToCategory === "function") {
    try {
      const mapped = await engine.s40_mapIntentToCategory(auto.predictedIntent, {
        region,
      });
      if (mapped) {
        auto.predictedGroup = fx(mapped) || DEFAULT_GROUP;
        auto.resolvedGroup = auto.predictedGroup;
        auto.method = `${auto.method}+map`;
      }
    } catch {
      // ignore
    }
  } else {
    // no intent/map => baseline
    auto.predictedGroup = DEFAULT_GROUP;
    auto.resolvedGroup = DEFAULT_GROUP;
  }

  // 4) Keyword override (q-based, TR-friendly)
  // This is the production-grade “don’t embarrass me” layer.
  const kw = keywordOverride(normQForMatch(q));
  if (kw?.group) {
    const g2 = fx(kw.group) || DEFAULT_GROUP;

    // Apply only if it actually changes routing (signal, not noise)
    if (g2 && g2 !== auto.resolvedGroup) {
      auto.overrideSource = "keyword";
      auto.overrideReason = kw.reason || "keyword_override";
      auto.overrideKeyword = kw.keyword || null;
      auto.resolvedGroup = g2;
      auto.method = `${auto.method}+kw`;
    }
  }

  // 5) Heuristic fallback based on predictedIntent (ONLY if still default)
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
  // Canonical call:
  //   runAdapters(query, region, { forceCategory/category/group, ...opts })
  // ZERO-CRASH: try fallbacks for old signatures.
  const g = String(group || "").trim().toLowerCase();
  const reg = String(region || "TR").trim() || "TR";
  const baseOpts = { ...(opts || {}), region: reg };

  const force = g && g !== "auto";
  const engineOpts = force
    ? { ...baseOpts, forceCategory: g, category: g, group: g }
    : { ...baseOpts };

  // 1) Preferred signature: (q, region, opts)
  try {
    return await runAdapters(q, reg, engineOpts);
  } catch {
    // fall through
  }

  // 2) Legacy: (q, opts)
  try {
    return await runAdapters(q, engineOpts);
  } catch {
    // fall through
  }

  // 3) Object payload: ({q, query, region, ...})
  try {
    return await runAdapters({ q, query: q, region: reg, ...engineOpts });
  } catch {
    // fall through
  }

  // Last resort: query only
  return await runAdapters(q);
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const reqId = mkReqId();

  // Prevent any proxy/browser caching from causing limit/offset confusion
  try {
    res.set("Cache-Control", "no-store");
    res.set("X-FAE-ReqId", reqId);
  } catch {}

  const t0 = Date.now();

  const qRaw = safeStr(req.method === "POST" ? req.body?.q : req.query?.q);
  const typo = fixQueryTyposTR(qRaw);
  const q = typo?.query || qRaw;
  const groupIn = safeStr(
    req.method === "POST" ? req.body?.group : req.query?.group
  );
  const region =
    safeStr(
      (req.method === "POST" ? req.body?.region : req.query?.region) ||
        REGION_DEFAULT
    ) || REGION_DEFAULT;
  const currencyParam = safeStr(req.method === "POST" ? req.body?.currency : req.query?.currency);

  // Provider filter (request-level OR env allowlist)
  const providerIn = req.method === "POST"
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

  // NOTE: Engine branches drift on paging. We enforce paging at the route layer so
  // /api/search never lies.
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

  // Ask the engine for "at least enough" to slice reliably.
  // (If engine ignores limit, we still slice; if it respects limit, we asked for more.)
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
      _meta: { reqId, ms: Date.now() - t0 },
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
      _meta: { reqId, ms: Date.now() - t0 },
    });
  }

  const fx =
    typeof engine?.fixKey === "function" ? engine.fixKey : fallbackFixKey;

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
  // - Merchant onayı gelene kadar: catalog-only (adapter scrape yok)
  //   SEARCH_PRODUCT_MODE=adapters_first  -> eski davranış
  //   SEARCH_PRODUCT_MODE=catalog_first   -> önce catalog, sonra adapter
  // ---------------------------------------------------------------------------
  const requestedGroupParam = safeStr(req.query.group || "").toLowerCase();
  const isProductRequest = requestedGroupParam === "product" || resolvedGroup === "product";
  const productMode = String(process.env.SEARCH_PRODUCT_MODE || "catalog_only").toLowerCase();

  if (isProductRequest && productMode === "catalog_only") {
    try {
      // IMPORTANT: keep a stable timestamp for this request branch.
      // (Previously this referenced an undefined `ts` and crashed catalog_only,
      //  forcing a fall-through into adapters.)
      const ts = nowIso();

      const catProviderKey = safeStr(process.env.CATALOG_PROVIDER_KEY || process.env.FEED_PROVIDER_KEY || "admitad");
      const catCampaignId = safeInt(process.env.CATALOG_CAMPAIGN_ID, 0);
      const catCurrency = safeStr(process.env.CATALOG_CURRENCY || process.env.FEED_DEFAULT_CURRENCY || "");
      const cat = await fetchCatalogFallback({
        q,
        limit: reqLimit,
        offset: reqOffset,
        providerKey: catProviderKey,
        campaignId: catCampaignId,
        currency: catCurrency,
      });
      const items = Array.isArray(cat?.items) ? cat.items : [];

      const payload = {
        type: "search",
        ts,
        reqId,
        q,
        requestedGroup: requestedGroupRaw,
        resolvedGroup: "product",
        mode: "catalog_only",
        count: items.length,
        total: safeInt(cat?.total, items.length),
      };
      appendJsonl(INTENT_LOG_PATH, payload);
      emitTelemetry("intent.search.catalog_only", payload, req);

      return res.status(200).json({
        ok: true,
        reqId,
        ts,
        q,
        group: "product",
        usedGroup: "product",
        intent: safeStr(autoMeta?.intent) || safeStr(autoMeta?.category) || "product",
        results: items,
        items,
        count: items.length,
        total: safeInt(cat?.total, items.length),
        nextOffset: safeInt(cat?.nextOffset, 0),
        hasMore: Boolean(cat?.hasMore),
        cards: [],
        _meta: {
          engineVariant: "CATALOG_ONLY",
          providerKey: catProviderKey,
          campaignId: catCampaignId,
          currency: catCurrency || null,
          offset: reqOffset,
          limit: reqLimit,
          ms: Date.now() - t0,
          // fetchCatalogFallback returns { items, meta }, not { _meta }.
          catalog: cat?.meta || cat?._meta || null,
          ...(autoMeta ? { auto: autoMeta } : {}),
        },
      });
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
      _meta: {
        reqId,
        q,
        group: resolvedGroup,
        requestedGroup: requestedGroupRaw,
        engine: "../core/adapterEngine.js",
        exports: Object.keys(engine || {}),
      },
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
      // keep original request in meta for debugging / telemetry
      reqLimit,
      reqOffset,
    });
    upstreamOk = upstream?.ok !== false; // treat undefined as ok
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

  // -----------------------------------------------------------------------
  // FEED CATALOG FALLBACK (MongoDB)
  // - /api/catalog/search already works, but the main /api/search (product)
  //   should also return results from the ingested feed so the UI is alive.
  // - Disable with SEARCH_INCLUDE_CATALOG=0
  // -----------------------------------------------------------------------
  let rawItems = rawItems0;
  let catalogMeta = null;

  const includeCatalog =
    resolvedGroup === "product" &&
    String(process.env.SEARCH_INCLUDE_CATALOG ?? "1") !== "0";

  if (includeCatalog) {
    const curHint = safeStr(currencyParam || process.env.SEARCH_CATALOG_CURRENCY || "");
    // NOTE: "limit" is not a symbol in this scope. Use reqLimit (validated above).
    // This prevents: ReferenceError: limit is not defined
    const cat = await fetchCatalogFallback({
      q,
      limit: reqLimit,
      engineLimit,
      currency: curHint,
    });
    if (cat?.items?.length) rawItems = rawItems0.concat(cat.items);
    catalogMeta = cat?.meta || null;
  }

  const normalizedItems = rawItems
    .map(normalizeSearchItem)
    .filter(Boolean);

  const filteredItems = providerAllow
    ? normalizedItems.filter((it) => {
        const pk = String(it?.providerKey || it?.provider || "").toLowerCase();
        if (pk && providerAllow.includes(pk)) return true;
        const idp = String(it?.id || "").toLowerCase();
        return providerAllow.some((p) => idp.startsWith(p + ':'));
      })
    : normalizedItems;

  const total = filteredItems.length;
  const items = filteredItems.slice(reqOffset, reqOffset + reqLimit);
  const count = items.length;

  const candidateSource = filteredItems;

  // Cards — ONLY "best" is active (Smart/Others are parked for future)
  const pickPrice = (it) => {
    const v = it?.optimizedPrice ?? it?.finalPrice ?? it?.price;
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const trustOf = (it) => {
    const t = it?.commissionMeta?.providerTrust ?? it?.providerTrust ?? null;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  };

  const candidates = candidateSource.filter((it) => {
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

  // Telemetry log (only AUTO by default)
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

  // Response (dual-compat: results + items)
  return res.json({
    ok: true,
    q,
    group: resolvedGroup,
    results: items,
    items,
    count,
    total,
    nextOffset: reqOffset + count,
    hasMore: reqOffset + count < total,
    cards,
    _meta: {
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
      ...(catalogMeta ? { catalog: catalogMeta, catalogCount: safeInt(catalogMeta.count, 0) } : {}),
      ...(usedAuto ? { auto: autoMeta } : {}),
      ...(typo?.fixed ? { qOriginal: qRaw, typoFix: typo.changes } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Feedback endpoint (intent accuracy)
// ---------------------------------------------------------------------------
async function feedback(req, res) {
  const reqId = mkReqId();
  const ts = nowIso();

  const q = safeStr(req.body?.q);
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

  if (!q) {
    return res.status(400).json({ ok: false, error: "MISSING_Q", reqId });
  }
  if (!predictedGroup || !correctGroup) {
    return res.status(400).json({ ok: false, error: "MISSING_GROUPS", reqId });
  }

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

// health check
router.get("/health", (req, res) => {
  res.json({ ok: true, service: "search", ts: nowIso() });
});

// intent metrics (quick view)
router.get("/intent-metrics", (req, res) => {
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
