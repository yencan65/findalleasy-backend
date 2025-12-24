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

const router = express.Router();

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

  const limit = Math.min(
    100,
    Math.max(1, toInt(req.method === "POST" ? req.body?.limit : req.query?.limit, 20))
  );
  const offset = Math.max(
    0,
    toInt(req.method === "POST" ? req.body?.offset : req.query?.offset, 0)
  );

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
      limit,
      offset,
      region,
    });
    upstreamOk = upstream?.ok !== false; // treat undefined as ok
    upstreamMeta = upstream?._meta || null;
  } catch (e) {
    upstreamOk = false;
    upstreamMeta = { error: "RUN_ADAPTERS_THROW", message: safeStr(e?.message) };
    upstream = { ok: false, items: [], count: 0, source: resolvedGroup, _meta: upstreamMeta };
  }

  const items = Array.isArray(upstream?.items) ? upstream.items : [];
  const count = Number.isFinite(upstream?.count) ? upstream.count : items.length;

  // Cards (placeholder)
  const cards = [
    { title: "En uygun & güvenilir", desc: "Öneriler hazırlanıyor...", cta: "Tıkla", region: "TR" },
    { title: "Konumuna göre öneri", desc: "", cta: "Tıkla", region: "TR" },
    { title: "Diğer satıcılar", desc: "Karşılaştırmalı alternatifler", cta: "Tıkla", region: "TR" },
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

      limit,
      offset,
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
    total: count,
    nextOffset: offset + count,
    hasMore: false,
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
      rawCount: items.length,
      upstreamOk,
      upstreamMeta,
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
router.get("/", handle);
router.post("/", handle);

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
