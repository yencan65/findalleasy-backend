// server/routes/vitrin.js
import express from "express";
import { buildDynamicVitrinSafe, buildDynamicVitrin } from "../core/vitrinEngine.js";

const router = express.Router();

// Back-compat alias: route eski adla "runVitrineS40" mantığıyla çalışsın.
// core artık buildDynamicVitrin* export ediyor.
const runVitrineS40 = buildDynamicVitrinSafe || buildDynamicVitrin;

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

    // Vitrin Engine (S40) güvenli çağrı
    const out = await buildDynamicVitrinSafe(q, region, userId, null);

    // her türlü shape'e tolerans: item listesi çıkart
    const flat = flattenVitrinItems(out || {});
    const items = Array.isArray(flat?.items) ? flat.items : [];

    const bestFromOut =
      out && typeof out === "object" && out.best && typeof out.best === "object" ? out.best : null;

    const bestFromList =
      Array.isArray(out?.best_list) && out.best_list.length ? out.best_list[0] : null;

    const best = bestFromOut || bestFromList || items[0] || null;

    const best_list = best ? [best] : [];

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
      _meta: out?._meta || out?.meta || { source: "vitrin" },
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
