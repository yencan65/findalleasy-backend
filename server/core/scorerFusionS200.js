// server/core/scorerFusionS200.js
// ===============================================================
// FindAllEasy — S200 Scorer + Fusion (Provider Priority + Relevance)
// Goal: kaliteyi yukarı it, çöpü cilalama, boş ekranı engelle
// - Zero-crash (tüm parse'lar try/catch)
// - Deterministic ranking (same input -> same order)
// - Provider priority + trust + relevance + price (group-aware)
// - Light fusion (URL canonical + title similarity fallback)
// ===============================================================

import crypto from "crypto";

// -----------------------------
// Small utils
// -----------------------------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const safeStr = (v) => (v == null ? "" : String(v)).trim();

function normText(s) {
  return safeStr(s)
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  const t = normText(s);
  if (!t) return [];
  return t.split(" ").filter((w) => w.length >= 2);
}

function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

function hash8(s) {
  try {
    return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
  } catch {
    return "00000000";
  }
}

function getPriceNumber(item) {
  const raw = item?.optimizedPrice ?? item?.finalPrice ?? item?.price ?? null;
  if (raw == null) return null;
  if (typeof raw === "number") return raw > 0 ? raw : null;
  const n = Number(String(raw).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function canonicalizeUrl(url) {
  const u = safeStr(url);
  if (!u) return "";
  try {
    const x = new URL(u);
    // tracking param temizliği (utm, aff, ref vs.)
    const kill = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "yclid",
      "ref",
      "refid",
      "ref_id",
      "affiliate",
      "affid",
      "aff_id",
      "subid",
      "sub_id",
      "clickid",
      "click_id",
      "tag",
    ];
    for (const k of kill) x.searchParams.delete(k);
    // canonical form: origin + pathname + (az param)
    x.hash = "";
    // bazı sitelerde ?sku= gibi önemli olabilir: 3’ten fazla param bırakma
    const keys = Array.from(x.searchParams.keys());
    if (keys.length > 3) {
      for (const k of keys.slice(3)) x.searchParams.delete(k);
    }
    // normalize order
    const sorted = new URL(x.origin + x.pathname);
    const pairs = Array.from(x.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [k, v] of pairs) sorted.searchParams.append(k, v);
    return sorted.toString();
  } catch {
    // URL parse edilemezse yine de strip fragment
    return u.split("#")[0];
  }
}

function providerKeyOf(item) {
  const raw =
    safeStr(item?.providerFamily) ||
    safeStr(item?.provider) ||
    safeStr(item?.providerKey) ||
    safeStr(item?.provider_key);
  if (!raw) return "unknown";
  const k = raw.toLowerCase().replace(/\s+/g, "");
  return k === "unknown" ? "unknown" : k;
}

// -----------------------------
// Provider priority config (group-aware)
// Not: burada “tartışmalı” şey yok; sadece kalite için deterministic bias.
// -----------------------------
const PRIORITY_BY_GROUP = {
  product: [
    "amazontr",
    "amazon",
    "hepsiburada",
    "trendyol",
    "n11",
    "ciceksepeti",
    "google",
    "googleshopping",
    "serpapi",
  ],
  vehicle_sale: [
    "sahibinden",
    "arabam",
    "otoplus",
    "vasita",
    "serpapi",
    "google",
  ],
  real_estate: ["sahibinden", "hepsiemlak", "zingat", "serpapi", "google"],
  travel: ["booking", "airbnb", "enuygun", "skyscanner", "serpapi", "google"],
  legal: ["baro", "avukat", "googleplaces", "serpapi", "google"],
  health: ["doctor", "hospital", "googleplaces", "serpapi", "google"],
  service: ["googleplaces", "serpapi", "google"],
};

function providerPriorityScore(providerKey, group) {
  const list = PRIORITY_BY_GROUP[group] || PRIORITY_BY_GROUP.product;
  const idx = list.indexOf(providerKey);
  if (idx < 0) return 0.15; // bilinmeyen ama var → küçük skor
  // 0..1 arasında azalan
  return clamp(1 - idx / Math.max(1, list.length - 1), 0.15, 1);
}

// -----------------------------
// Optional: providerMaster entegrasyonu (varsa kullan, yoksa çökme)
// -----------------------------
let _provApi = null;
async function getProviderApi() {
  if (_provApi) return _provApi;
  try {
    _provApi = await import("./providerMasterS10.js");
  } catch {
    _provApi = {};
  }
  return _provApi;
}

async function computeProviderScore(item) {
  const api = await getProviderApi();
  try {
    if (typeof api.computeProviderTotalScoreS15 === "function") {
      const v = await api.computeProviderTotalScoreS15(item);
      if (Number.isFinite(v)) return clamp(v, 0, 1);
    }
  } catch {}
  try {
    if (typeof api.computeProviderPriorityScore === "function") {
      const v = await api.computeProviderPriorityScore(item);
      if (Number.isFinite(v)) return clamp(v, 0, 1);
    }
  } catch {}
  try {
    if (typeof api.getProviderInfoS10 === "function") {
      const info = api.getProviderInfoS10(item?.provider);
      const trust = Number(info?.trust ?? 0.5);
      const comm = info?.commission ? 0.08 : 0;
      return clamp(trust + comm, 0, 1);
    }
  } catch {}
  return 0.5;
}

// -----------------------------
// Relevance score (light lexical)
// -----------------------------
function computeRelevance(query, title) {
  const q = tokenize(query);
  const t = tokenize(title);
  if (!q.length || !t.length) return 0.05;

  const jac = jaccard(q, t);

  // substring bonus (query title içinde)
  const nq = normText(query);
  const nt = normText(title);
  const substr = nq && nt.includes(nq) ? 0.25 : 0;

  // early-token bonus (ilk 3 token eşleşirse)
  let early = 0;
  const head = t.slice(0, 6);
  const qs = new Set(q);
  let hit = 0;
  for (const w of head) if (qs.has(w)) hit++;
  early = clamp(hit / 6, 0, 1) * 0.15;

  return clamp(jac * 0.6 + substr + early + 0.05, 0, 1);
}

// -----------------------------
// Price normalization
// -----------------------------
function computePriceScore(price, stats) {
  if (price == null || !stats) return 0.25; // hizmetlerde vs daha nötr
  const { min, p50, max } = stats;
  if (!(min > 0) || !(max > 0)) return 0.25;
  // median'a yakınlık (outlier'ı cezalandır)
  const denom = Math.max(1, max - min);
  const dist = Math.abs(price - (p50 || min)) / denom; // 0..?
  return clamp(1 - dist, 0, 1);
}

function buildPriceStats(items) {
  const prices = items.map(getPriceNumber).filter((x) => x != null);
  if (prices.length < 3) return null;
  prices.sort((a, b) => a - b);
  const min = prices[0];
  const max = prices[prices.length - 1];
  const p50 = prices[Math.floor(prices.length * 0.5)];
  return { min, max, p50 };
}

// -----------------------------
// Main scorer
// -----------------------------
function weightsForGroup(group) {
  // ürün: relevance + provider + price
  // hizmet: relevance + provider (price daha düşük)
  switch (group) {
    case "legal":
    case "health":
    case "service":
      return { wRel: 0.55, wProv: 0.40, wPrice: 0.05 };
    case "vehicle_sale":
    case "real_estate":
      return { wRel: 0.45, wProv: 0.45, wPrice: 0.10 };
    default:
      return { wRel: 0.45, wProv: 0.35, wPrice: 0.20 };
  }
}

async function scoreItems(items, ctx) {
  const group = safeStr(ctx?.group) || "product";
  const query = safeStr(ctx?.query);
  const priceStats = buildPriceStats(items);

  const { wRel, wProv, wPrice } = weightsForGroup(group);

  const scored = [];
  for (const it of items) {
    try {
      const title = safeStr(it?.title);
      const rel = computeRelevance(query, title);
      const pKey = providerKeyOf(it);
      const pBoost = providerPriorityScore(pKey, group);
      const pScore = await computeProviderScore({ ...it, provider: it?.provider || pKey });

      const price = getPriceNumber(it);
      const prScore = computePriceScore(price, priceStats);

      // provider boost küçük ama deterministik "tie-breaker" gibi
      const total = clamp(rel * wRel + pScore * wProv + prScore * wPrice + pBoost * 0.05, 0, 1);

      scored.push({
        ...it,
        _score: Number(total.toFixed(6)),
        _rel: Number(rel.toFixed(6)),
        _prov: Number(pScore.toFixed(6)),
        _pboost: Number(pBoost.toFixed(6)),
        _ps: Number(prScore.toFixed(6)),
        _canon: canonicalizeUrl(it?.url),
      });
    } catch {
      scored.push({ ...it, _score: 0.01, _canon: canonicalizeUrl(it?.url) });
    }
  }

  scored.sort((a, b) => {
    if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
    const ap = getPriceNumber(a);
    const bp = getPriceNumber(b);
    if (ap != null && bp != null && ap !== bp) return ap - bp; // eşitse ucuz öne
    return safeStr(a?.title).localeCompare(safeStr(b?.title));
  });

  return scored;
}

// -----------------------------
// Fusion: URL canonical match → else title-similarity + price band
// -----------------------------
function titleSimilarity(a, b) {
  const at = tokenize(a);
  const bt = tokenize(b);
  const jac = jaccard(at, bt);
  return jac;
}

function fuseScored(scored, ctx) {
  const keepOffers = !!ctx?.keepOffers;
  const keepSignals = !!ctx?.keepSignals;

  const byCanon = new Map();
  const loose = [];

  for (const it of scored) {
    const key = it._canon || "";
    if (key) {
      const bucket = byCanon.get(key);
      if (!bucket) byCanon.set(key, [it]);
      else bucket.push(it);
    } else {
      loose.push(it);
    }
  }

  const fused = [];

  // 1) Canonical URL buckets
  for (const [, bucket] of byCanon.entries()) {
    bucket.sort((a, b) => (b._score || 0) - (a._score || 0));
    const best = bucket[0];
    if (keepOffers && bucket.length > 1) best.offers = bucket.slice(1);
    fused.push(best);
  }

  // 2) Loose fusion (title similarity)
  const used = new Array(loose.length).fill(false);
  for (let i = 0; i < loose.length; i++) {
    if (used[i]) continue;
    const base = loose[i];
    const cluster = [base];
    used[i] = true;

    for (let j = i + 1; j < loose.length; j++) {
      if (used[j]) continue;
      const cand = loose[j];

      const sim = titleSimilarity(base?.title, cand?.title);
      if (sim < 0.92) continue;

      const p1 = getPriceNumber(base);
      const p2 = getPriceNumber(cand);
      if (p1 != null && p2 != null) {
        const ratio = p1 > p2 ? p1 / p2 : p2 / p1;
        if (ratio > 1.25) continue; // fiyat çok uzak → aynı ürün olma ihtimali düşük
      }

      cluster.push(cand);
      used[j] = true;
    }

    cluster.sort((a, b) => (b._score || 0) - (a._score || 0));
    const best = cluster[0];
    if (keepOffers && cluster.length > 1) best.offers = cluster.slice(1);
    fused.push(best);
  }

  // final sort again
  fused.sort((a, b) => (b._score || 0) - (a._score || 0));

  // Signals cleanup (prod güvenliği)
  if (!keepSignals) {
    for (const it of fused) {
      delete it._rel;
      delete it._prov;
      delete it._pboost;
      delete it._ps;
      delete it._canon;
      // _score'u debug için bazen tutmak istersin; default: sil
      delete it._score;
      if (it.offers && Array.isArray(it.offers)) {
        for (const o of it.offers) {
          delete o._rel;
          delete o._prov;
          delete o._pboost;
          delete o._ps;
          delete o._canon;
          delete o._score;
        }
      }
    }
  }

  // stable IDs: yoksa üret (UI dedupe için)
  for (const it of fused) {
    if (!safeStr(it?.id)) {
      const k = `${providerKeyOf(it)}|${canonicalizeUrl(it?.url)}|${normText(it?.title)}`;
      it.id = `s200_${hash8(k)}`;
    }
  }

  return fused;
}

// ===============================================================
// Public API
// ===============================================================
export async function scoreAndFuseS200(items, ctx = {}) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return [];
  const scored = await scoreItems(arr, ctx);
  return fuseScored(scored, ctx);
}
