// server/routes/searchRoute.js
// ============================================================================
// S200 API SEARCH ROUTE — NO CRASH • NO FAKE • ENGINE-DETECT
// - GET  /api/search?q=iphone&group=product&limit=20&offset=0
// - POST /api/search  { q, group, limit, offset, opts? }
// - Tries to call your existing adapter engine (whatever it is named).
// - If engine is missing/misnamed -> observable ok:false (never hard-crash).
// ============================================================================

import express from "express";

const router = express.Router();

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------
const toInt = (v, def) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
};

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const safeStr = (v) => (v == null ? "" : String(v)).trim();

const normKey = (s) => safeStr(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

const GROUP_ALIASES = {
  product: "product",
  market: "market",
  fashion: "fashion",
  food: "food",
  office: "office",
  travel: "travel",
  tour: "tour",
  rental: "rental",
  carrental: "carRental",
  car_rental: "carRental",
  repair: "repair",
  spa: "spa",
  spawellness: "spaWellness",
  wellness: "spaWellness",
  health: "health",
  insurance: "insurance",
  estate: "estate",
  craft: "craft",
  education: "education",
  lawyer: "lawyer",
  vehicle: "vehicleSale",
  vehiclesale: "vehicleSale",
  vehicle_sale: "vehicleSale",

  // psychology aliases
  psychology: "psychologist",
  psychologist: "psychologist",
  psikolog: "psychologist",
  psikoloji: "psychologist",
};

const normalizeGroup = (g) => {
  const k = normKey(g);
  if (!k) return "";
  return GROUP_ALIASES[k] || g; // fallback to raw (engine might accept it)
};

// ---------------------------------------------------------------------------
// Engine loader (tries multiple common filenames)
// Adjust/extend this list if your engine lives elsewhere.
// ---------------------------------------------------------------------------
const ENGINE_MODULE_CANDIDATES = [
  "../core/adapterEngine.js",
  "../core/adapterEngine.mjs",
  "../core/adapterEngineS200.js",
  "../core/adapterEngineS200.mjs",
  "../core/adapterEngine/index.js",
  "../core/adapterEngine/index.mjs",
  "../core/s200AdapterEngine.js",
  "../core/s200AdapterEngine.mjs",
];

let _engineModPromise = null;

async function loadEngineModule() {
  if (_engineModPromise) return _engineModPromise;

  _engineModPromise = (async () => {
    for (const p of ENGINE_MODULE_CANDIDATES) {
      try {
        const mod = await import(p);
        return { ok: true, mod, path: p };
      } catch (e) {
        // try next
      }
    }
    return { ok: false, mod: null, path: null };
  })();

  return _engineModPromise;
}

function pickSearchFn(mod) {
  if (!mod) return null;

  const candidates = [
    mod.searchS200,
    mod.searchAdaptersS200,
    mod.searchAdapters,
    mod.searchByGroup,
    mod.searchGroup,
    mod.search,
    mod.runSearch,
    mod.adapterSearch,

    // some projects export default engine object
    mod.default?.searchS200,
    mod.default?.searchAdaptersS200,
    mod.default?.searchAdapters,
    mod.default?.searchByGroup,
    mod.default?.searchGroup,
    mod.default?.search,
    mod.default?.runSearch,
    mod.default?.adapterSearch,
    typeof mod.default === "function" ? mod.default : null,
  ].filter((f) => typeof f === "function");

  return candidates[0] || null;
}

async function callEngineSearch(fn, payload) {
  // Try a few common calling conventions, in order.
  const { q, group, limit, offset, opts } = payload;

  const attempts = [
    () => fn(q, { group, limit, offset, ...(opts || {}) }),
    () => fn({ q, group, limit, offset, ...(opts || {}) }),
    () => fn(q, group, { limit, offset, ...(opts || {}) }),
    () => fn({ query: q, group, limit, offset, ...(opts || {}) }),
  ];

  let lastErr = null;
  for (const run of attempts) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("ENGINE_CALL_FAILED");
}

function normalizeResultToS200(raw, meta) {
  // If engine already returns S200 wrapper, keep it.
  if (raw && typeof raw === "object" && Array.isArray(raw.items) && typeof raw.ok === "boolean") {
    const count = typeof raw.count === "number" ? raw.count : raw.items.length;
    return { ...raw, count, _meta: { ...(raw._meta || {}), ...(meta || {}) } };
  }

  // If engine returns array of items
  if (Array.isArray(raw)) {
    return {
      ok: true,
      items: raw,
      count: raw.length,
      source: meta?.group || "api",
      _meta: meta || {},
    };
  }

  // Unknown shape -> observable fail (no crash)
  return {
    ok: false,
    items: [],
    count: 0,
    source: meta?.group || "api",
    _meta: { ...(meta || {}), error: "ENGINE_RETURN_SHAPE_UNKNOWN" },
  };
}

async function handleSearch(req, res) {
  const q = safeStr(req.method === "GET" ? req.query.q : req.body?.q);
  const groupIn = safeStr(req.method === "GET" ? req.query.group : req.body?.group);
  const group = normalizeGroup(groupIn);

  const limit = clamp(toInt(req.method === "GET" ? req.query.limit : req.body?.limit, 20), 1, 50);
  const offset = clamp(toInt(req.method === "GET" ? req.query.offset : req.body?.offset, 0), 0, 500);

  // extra opts passthrough (optional)
  const opts = (req.method === "GET" ? null : (req.body?.opts || null)) || null;

  if (!q) {
    return res.status(400).json({
      ok: false,
      items: [],
      count: 0,
      source: "api",
      _meta: { error: "MISSING_QUERY", hint: "Use ?q=...&group=product" },
    });
  }

  const meta = {
    q,
    group: group || groupIn || "",
    limit,
    offset,
    engine: null,
  };

  const loaded = await loadEngineModule();
  if (!loaded.ok) {
    return res.status(501).json({
      ok: false,
      items: [],
      count: 0,
      source: meta.group || "api",
      _meta: { ...meta, error: "ENGINE_MODULE_NOT_FOUND", tried: ENGINE_MODULE_CANDIDATES },
    });
  }

  const fn = pickSearchFn(loaded.mod);
  if (!fn) {
    return res.status(501).json({
      ok: false,
      items: [],
      count: 0,
      source: meta.group || "api",
      _meta: { ...meta, engine: loaded.path, error: "ENGINE_SEARCH_FN_NOT_FOUND" },
    });
  }

  try {
    const raw = await callEngineSearch(fn, { q, group: meta.group, limit, offset, opts });
    const out = normalizeResultToS200(raw, { ...meta, engine: loaded.path });
    return res.json(out);
  } catch (e) {
    const msg = (e && (e.message || String(e))) || "ENGINE_ERROR";
    return res.status(200).json({
      ok: false,
      items: [],
      count: 0,
      source: meta.group || "api",
      _meta: { ...meta, engine: loaded.path, error: "ENGINE_CALL_ERROR", message: msg },
    });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.get("/search", handleSearch);
router.post("/search", express.json({ limit: "1mb" }), handleSearch);

export { default } from "./search.js";

