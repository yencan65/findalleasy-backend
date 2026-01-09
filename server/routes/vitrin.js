// server/routes/vitrin.js
import express from "express";
import { buildDynamicVitrinSafe, buildDynamicVitrin } from "../core/vitrinEngine.js";
import { applyS200FallbackIfEmpty } from "../core/s200Fallback.js";
import { scoreAndFuseS200 } from "../core/scorerFusionS200.js";
import { detectIntent } from "../core/intentEngine.js";

const router = express.Router();

// Back-compat alias: route eski adla "runVitrineS40" mantığıyla çalışsın.
// core artık buildDynamicVitrin* export ediyor.
const runVitrineS40 = buildDynamicVitrinSafe || buildDynamicVitrin;

const VITRIN_ENGINE_TIMEOUT_MS = (() => {
  const n = Number(process.env.VITRIN_ENGINE_TIMEOUT_MS || 6500);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 6500;
})();

function getQ(req) {
  return (
    (req.query.q != null ? String(req.query.q) : "") ||
    (req.query.query != null ? String(req.query.query) : "") ||
    (req.query.text != null ? String(req.query.text) : "")
  ).trim();
}

function flattenVitrinItems(out) {
  if (!out) return [];
  if (Array.isArray(out.items)) return out.items;

  const bestList = Array.isArray(out.best_list) ? out.best_list : [];
  const smart = Array.isArray(out.smart) ? out.smart : [];
  const others = Array.isArray(out.others) ? out.others : [];
  const best = out.best && typeof out.best === "object" ? [out.best] : [];

  const merged = bestList.length ? [...bestList, ...smart, ...others] : [...best, ...smart, ...others];

  // uniq by (id || url || title)
  const seen = new Set();
  const uniq = [];
  for (const it of merged) {
    if (!it || typeof it !== "object") continue;
    const key = String(it.id || it.url || it.title || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }
  return uniq;
}

function pickDailyDiscoveryQuery(region = "TR") {
  const seedsTR = [
    "indirim",
    "en çok satan",
    "iphone 15",
    "airpods",
    "spor ayakkabı",
    "parfüm",
    "laptop",
  ];
  const seeds = region === "TR" ? seedsTR : seedsTR;
  const day = Math.floor(Date.now() / 86400000);
  return seeds[day % seeds.length];
}

// ---------------------------
// /api/vitrin/dynamic?q=...
// ---------------------------
const fixMojibakeTR = (s) => {
  const str = String(s || "");
  if (!str) return "";
  const looksBroken = /�|Ã|Â/.test(str);
  if (!looksBroken) return str;
  try {
    const repaired = Buffer.from(str, "latin1").toString("utf8");
    if (/[ğüşöçıİĞÜŞÖÇ]/.test(repaired) && !/�/.test(repaired)) return repaired;
    return repaired || str;
  } catch {
    return str;
  }
};

async function handleDynamic(req, res) {
  const reply = (payload) => res.status(200).json(payload);

  try {
    const body = req.body || {};
    const qRaw = String(body.query ?? body.q ?? req.query?.q ?? req.query?.query ?? "").trim();
    const q = fixMojibakeTR(qRaw).trim();

    const region = String(body.region ?? req.query?.region ?? "TR");
    const locale = String(body.locale ?? body.lang ?? req.query?.locale ?? req.query?.lang ?? "tr");
    const userId = String(body.userId ?? req.query?.userId ?? "anon");

    if (!q) {
      return reply({
        ok: false,
        query: "",
        q: "",
        region,
        locale,
        best: null,
        best_list: [],
        smart: [],
        others: [],
        items: [],
        count: 0,
        total: 0,
        _meta: { error: "MISSING_QUERY" },
      });
    }

    
// Vitrin Engine (S40) güvenli çağrı — hard timeout (FE 25s'de abort ediyor)
let out = null;
try {
  const enginePromise = (async () => {
    if (typeof runVitrineS40 === "function") {
      return await runVitrineS40(q, region, userId, {
        locale,
        clientIp: req.ip,
        sessionId: String(body.sessionId ?? body.sid ?? ""),
      });
    }
    return await buildDynamicVitrin(q, region, userId, { locale, clientIp: req.ip });
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("vitrinEngine timeout")), VITRIN_ENGINE_TIMEOUT_MS)
  );

  out = await Promise.race([enginePromise, timeoutPromise]);
} catch {}

// her türlü shape'e tolerans: item listesi çıkart
const flatItems = flattenVitrinItems(out || {});
const items = Array.isArray(flatItems) ? flatItems : [];

const bestFromOut =
      out && typeof out === "object" && out.best && typeof out.best === "object" ? out.best : null;

    const bestFromList =
      Array.isArray(out?.best_list) && out.best_list.length ? out.best_list[0] : null;

    
let best = bestFromOut || bestFromList || items[0] || null;
let best_list = best ? [best] : [];
let meta = out?._meta || out?.meta || { source: "vitrin" };

// ✅ Empty/timeout guard: asla eli boş dönme → S200 fallback (CSE → SerpApi)
if (!best) {
  try {
    let intent = null;
    try {
      intent = await detectIntent({ query: q, source: "text" });
    } catch {}

    let cat = String(intent?.type || intent?.category || intent?.group || "product");
    cat = cat && cat !== "general" && cat !== "mixed" ? cat : "product";

    const base = {
      ok: true,
      query: q,
      q,
      region,
      locale,
      group: cat,
      category: cat,
      items: [],
      _meta: { source: "vitrin_dynamic_route", region, locale, group: cat },
    };

    const fb = await applyS200FallbackIfEmpty({
      req,
      result: base,
      q,
      group: cat,
      region,
      locale,
      limit: 20,
      reason: "VITRIN_DYNAMIC_EMPTY_OR_TIMEOUT",
    });

    let fitems = Array.isArray(fb?.items)
      ? fb.items
      : Array.isArray(fb?.results)
      ? fb.results
      : [];

    try {
      fitems = await scoreAndFuseS200(fitems, { query: q, group: cat, region });
    } catch {}

    best = fitems[0] || null;
    best_list = best ? [best] : [];

    meta = {
      ...(fb?._meta || fb?.meta || {}),
      source: "vitrin_dynamic_s200_fallback",
      fallbackUsed: true,
      region,
      locale,
      group: cat,
    };
  } catch {}
}

    return reply({
      ok: true,
      query: q,
      q,
      region,
      locale,
      // 🔒 SADECE BEST
      best,
      best_list,
      smart: [],
      others: [],
      items: best_list,
      count: best_list.length,
      total: best_list.length,
      cards: {
        best,
        best_list,
        smart: [],
        others: [],
      },
      _meta: meta,
    });
  } catch (err) {
    return reply({
      ok: false,
      query: String(req?.body?.query ?? req?.body?.q ?? req?.query?.q ?? "").trim(),
      q: String(req?.body?.query ?? req?.body?.q ?? req?.query?.q ?? "").trim(),
      region: String(req?.body?.region ?? req?.query?.region ?? "TR"),
      locale: String(req?.body?.locale ?? req?.body?.lang ?? req?.query?.locale ?? "tr"),
      best: null,
      best_list: [],
      smart: [],
      others: [],
      items: [],
      count: 0,
      total: 0,
      _meta: { error: "VITRIN_DYNAMIC_FAIL", msg: String(err?.message || err) },
    });
  }
}

router.get("/dynamic", handleDynamic);
router.post("/dynamic", handleDynamic);
router.get("/discover", async (req, res) => {
  const region = String(req.query.region || "TR").toUpperCase();
  const userId = req.query.userId ? String(req.query.userId) : null;

  const seedRaw = req.query.seed != null ? String(req.query.seed) : "";
  const seed = seedRaw.trim() || pickDailyDiscoveryQuery(region);

  try {
    if (typeof runVitrineS40 !== "function") throw new Error("runVitrineS40 is not a function");

    const out = await runVitrineS40(seed, region, userId, null);
    const items = flattenVitrinItems(out);

    return res.status(200).json({
      ok: items.length > 0,
      items,
      count: items.length,
      source: out?.source || "vitrin_discover",
      _meta: { ...(out?._meta || {}), discovery: true, seed, region, userId },
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      items: [],
      count: 0,
      source: "vitrin_discover",
      _meta: { error: e?.message || String(e), seed, region, userId },
    });
  }
});

export default router;
