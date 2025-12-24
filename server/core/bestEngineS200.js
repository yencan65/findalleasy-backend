// server/core/bestEngineS200.js
// ============================================================================
// BEST ENGINE — S200 (DETERMINISTIC, DRIFT-SAFE) — HARDENED
// - Best != cheapest: price + trust + data quality + advantage + relevance
// - price=null is NOT "free"
// - No fake fields: image/summary only from existing item/raw
// - Deterministic sorting: stable tie-breakers
// - NO CRASH: defensive guards everywhere
// ============================================================================

import {
  safeStr,
  fixKey,
  isBadUrlS200,
  normalizeUrlS200,
} from "./s200AdapterKit.js";

// ---------------------------
// Helpers
// ---------------------------
function clamp(n, a, b) {
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function toNumberBestEffort(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  const s = safeStr(v);
  if (!s) return null;

  // Keep digits, separators, sign
  let cleaned = s
    .replace(/\s+/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!cleaned) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  // Heuristic:
  // - if both "," and "." exist => treat "." as thousands and "," as decimal (TR style)
  // - if only "," exists => treat "," as decimal
  // - if only "." exists => treat "." as decimal
  if (hasComma && hasDot) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    cleaned = cleaned.replace(",", ".");
  } else {
    // keep as-is
  }

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function numOrNull(v) {
  const n = toNumberBestEffort(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function intOrNull(v) {
  const n = toNumberBestEffort(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}

function normalizeProviderKey(it) {
  return fixKey(
    it?.raw?.providerKey ||
      it?.providerKey ||
      it?.adapterSource ||
      it?.source ||
      it?.provider ||
      it?.raw?.provider ||
      ""
  );
}

export function effectivePriceS200(it) {
  return numOrNull(it?.optimizedPrice ?? it?.finalPrice ?? it?.price);
}

// ---------------------------
// URL picker (NO FAKE)
// ---------------------------
function pickBestUrlS200(it) {
  const raw = it?.raw || {};
  const candidates = [
    it?.affiliateUrl,
    it?.deeplink,
    it?.finalUrl,
    it?.originUrl,
    it?.url,
    raw?.affiliateUrl,
    raw?.deeplink,
    raw?.finalUrl,
    raw?.originUrl,
    raw?.url,
    raw?.link,
    raw?.href,
  ];

  for (const u of candidates) {
    const nu = normalizeUrlS200(u);
    if (!nu) continue;
    if (isBadUrlS200(nu)) continue;
    return nu;
  }
  return null;
}

function isValidCandidateS200(it) {
  const title = safeStr(it?.title);
  if (!title) return false;
  const url = pickBestUrlS200(it);
  if (!url) return false;
  return true;
}

// ---------------------------
// Image picker (NO FAKE)
// ---------------------------
function collectImageCandidates(it) {
  const raw = it?.raw || {};
  const candidates = [];

  const push = (u) => {
    const s = safeStr(u);
    if (!s) return;
    candidates.push(s);
  };

  // common top-level fields
  push(it?.image);
  push(it?.imageUrl);
  push(it?.imageURL);
  push(it?.thumbnail);
  push(it?.thumb);
  push(it?.photo);

  // arrays
  if (Array.isArray(it?.images)) it.images.forEach(push);
  if (Array.isArray(it?.photos)) it.photos.forEach(push);

  // variants (array or object)
  const vars =
    it?.imageVariants ||
    raw?.imageVariants ||
    raw?.images ||
    raw?.photos;

  if (Array.isArray(vars)) vars.forEach(push);
  if (vars && typeof vars === "object" && !Array.isArray(vars)) {
    Object.values(vars).forEach((v) => {
      if (typeof v === "string") push(v);
      else if (v && typeof v === "object") {
        push(v.url);
        push(v.src);
        push(v.href);
      }
    });
  }

  // nested raw hints
  push(raw?.image);
  push(raw?.imageUrl);
  push(raw?.thumbnail);

  return candidates;
}

export function pickBestImageS200(it) {
  try {
    const cands = collectImageCandidates(it);
    if (!cands.length) return null;

    const good = [];
    for (const u of cands) {
      const nu = normalizeUrlS200(u);
      if (!nu) continue;
      if (isBadUrlS200(nu)) continue;
      good.push(nu);
    }
    if (!good.length) return null;

    // Deterministic: longer URL first, tie-break lexicographic
    good.sort((a, b) => (b.length - a.length) || a.localeCompare(b));
    return good[0] || null;
  } catch {
    return null;
  }
}

// ---------------------------
// Short summary (NO FAKE)
// ---------------------------
function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safeStr(v);
    if (s) return s;
  }
  return "";
}

function formatRating(rating, reviews) {
  const r = numOrNull(rating);
  const rc = intOrNull(reviews);
  if (r === null && rc === null) return "";
  if (r !== null && rc !== null) return `${r.toFixed(1)} (${rc} yorum)`;
  if (r !== null) return `${r.toFixed(1)} puan`;
  return `${rc} yorum`;
}

function tokensFromQuery(q) {
  const s = safeStr(q).toLowerCase();
  if (!s) return [];
  return s
    .split(/[\s,.;:/\\|()\[\]{}"+-]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function relevanceScoreS200(it, query) {
  const title = safeStr(it?.title).toLowerCase();
  const toks = tokensFromQuery(query);
  if (!toks.length) return 0.5; // neutral
  let hit = 0;
  for (const t of toks) if (title.includes(t)) hit++;
  return clamp(hit / toks.length, 0, 1);
}

function advantageScoreS200(it) {
  const raw = it?.raw || {};
  const discount =
    numOrNull(it?.discountPercent ?? raw?.discountPercent ?? raw?.discount) ?? null;

  const coupon = !!pickFirstNonEmpty(it?.couponCode, raw?.couponCode, raw?.coupon);
  const cashback = numOrNull(it?.cashback ?? raw?.cashback ?? raw?.cashBack) ?? null;
  const commission =
    numOrNull(it?.commissionRate ?? raw?.commissionRate ?? raw?.commission) ?? null;

  const bonus = !!pickFirstNonEmpty(raw?.bonus, raw?.promo, raw?.promotion);

  let a = 0;
  if (discount !== null) a += 0.45;
  if (coupon) a += 0.20;
  if (cashback !== null) a += 0.20;
  if (commission !== null) a += 0.10;
  if (bonus) a += 0.05;

  return clamp(a, 0, 1);
}

function qualityScoreS200(it, group) {
  const raw = it?.raw || {};

  const img = pickBestImageS200(it);
  const rating = numOrNull(it?.rating ?? raw?.rating ?? raw?.stars);
  const reviews = intOrNull(it?.reviewCount ?? raw?.reviewCount ?? raw?.reviews);

  const desc = pickFirstNonEmpty(
    raw?.description,
    raw?.desc,
    raw?.snippet,
    raw?.summary,
    it?.summary,
    it?.shortSummary
  );
  const hasDesc = desc.length >= 40;

  const location = pickFirstNonEmpty(
    it?.location,
    raw?.location,
    raw?.city,
    raw?.district,
    raw?.region
  );

  const g = safeStr(group).toLowerCase();
  const isPsy = g.includes("psych") || g.includes("psik") || g.includes("therap");

  const specialty = pickFirstNonEmpty(
    raw?.specialty,
    raw?.specialities,
    raw?.expertise,
    raw?.therapyType,
    raw?.therapyTypes
  );

  const mode = pickFirstNonEmpty(
    raw?.mode,
    raw?.online,
    raw?.sessionType,
    raw?.meetingType
  );

  let q = 0;
  if (img) q += 0.18;
  if (rating !== null) q += 0.15;
  if (reviews !== null) q += 0.07;
  if (hasDesc) q += 0.20;
  if (location) q += 0.10;
  if (safeStr(it?.providerName || raw?.providerName || raw?.brand)) q += 0.05;

  if (isPsy) {
    if (specialty) q += 0.15;
    if (mode) q += 0.10;
  } else {
    if (safeStr(raw?.category || it?.category)) q += 0.10;
    if (safeStr(raw?.tags || it?.tags)) q += 0.05;
  }

  const bare =
    !img &&
    rating === null &&
    reviews === null &&
    !hasDesc &&
    !location &&
    !specialty;

  if (bare) q -= 0.12;

  return clamp(q, 0, 1);
}

export function shortSummaryS200(it, ctx = {}) {
  try {
    const raw = it?.raw || {};
    const group = safeStr(ctx.group).toLowerCase();

    const ratingTxt = formatRating(
      it?.rating ?? raw?.rating ?? raw?.stars,
      it?.reviewCount ?? raw?.reviewCount ?? raw?.reviews
    );

    const location = pickFirstNonEmpty(
      it?.location,
      raw?.location,
      raw?.city,
      raw?.district,
      raw?.region
    );

    const isPsy = group.includes("psych") || group.includes("psik") || group.includes("therap");

    if (isPsy) {
      const specialty = pickFirstNonEmpty(
        raw?.specialty,
        raw?.specialities,
        raw?.expertise,
        raw?.therapyType,
        raw?.therapyTypes
      );

      const modeRaw = raw?.online;
      const mode =
        typeof modeRaw === "boolean"
          ? (modeRaw ? "Online" : "")
          : pickFirstNonEmpty(raw?.mode, raw?.sessionType, raw?.meetingType);

      const duration =
        intOrNull(raw?.durationMinutes ?? raw?.sessionMinutes ?? raw?.duration) ?? null;

      const bits = [];
      if (specialty) bits.push(specialty);
      if (mode) bits.push(mode);
      if (duration) bits.push(`${duration} dk`);
      if (location) bits.push(location);
      if (ratingTxt) bits.push(ratingTxt);

      const line = bits.join(" • ").trim();
      return line || pickFirstNonEmpty(raw?.snippet, raw?.summary, raw?.description);
    }

    const bits = [];
    if (location) bits.push(location);
    if (ratingTxt) bits.push(ratingTxt);
    const snippet = pickFirstNonEmpty(raw?.snippet, raw?.summary);

    const line = bits.join(" • ").trim();
    if (line && snippet) return `${line} — ${snippet.slice(0, 120)}`;
    return line || snippet || pickFirstNonEmpty(raw?.description);
  } catch {
    return "";
  }
}

// ---------------------------
// Scoring & ranking (deterministic)
// ---------------------------
function priceRankScores(items) {
  // cheapest => 1 ... most expensive => 0
  const priced = [];
  for (let i = 0; i < items.length; i++) {
    const p = effectivePriceS200(items[i]);
    if (p !== null) priced.push({ i, p });
  }
  priced.sort((a, b) => (a.p - b.p) || (a.i - b.i));

  const n = priced.length;
  const scoreByIndex = new Map();

  if (n === 1) {
    scoreByIndex.set(priced[0].i, 1);
    return scoreByIndex;
  }

  for (let r = 0; r < n; r++) {
    const s = 1 - r / (n - 1);
    scoreByIndex.set(priced[r].i, clamp(s, 0, 1));
  }
  return scoreByIndex;
}

function trustScoreS200(it, providerTrustMap) {
  const k = normalizeProviderKey(it);
  const v = providerTrustMap && typeof providerTrustMap === "object" ? providerTrustMap[k] : null;

  const t = numOrNull(v);
  // default neutral = 1.0 ; clamp to avoid nuking everything
  return clamp(t ?? 1.0, 0.2, 2.0);
}

export function scoreItemS200(it, ctx = {}) {
  const providerTrustMap = ctx.providerTrustMap || {};
  const trust = trustScoreS200(it, providerTrustMap);

  const rel = relevanceScoreS200(it, ctx.query);
  const qual = qualityScoreS200(it, ctx.group);
  const adv = advantageScoreS200(it);

  return { trust, rel, qual, adv };
}

export function rankItemsS200(items, ctx = {}) {
  const input = Array.isArray(items) ? items : [];

  // Contract lock (defensive): only rank valid title+url items
  const arr = input.filter(isValidCandidateS200);
  if (arr.length <= 1) return arr;

  const pRank = priceRankScores(arr);

  // Precompute components and store by object reference (NO indexOf garbage)
  const compMap = new Map();
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    const eff = effectivePriceS200(it); // null if missing
    const c = scoreItemS200(it, ctx);
    const priceScore = pRank.has(i) ? pRank.get(i) : null;

    let base;
    if (eff !== null && priceScore !== null) {
      base = 0.62 * priceScore + 0.23 * c.qual + 0.10 * c.adv + 0.05 * c.rel;
    } else {
      // price-missing mode: NOT free
      base = 0.50 * c.qual + 0.30 * c.rel + 0.20 * c.adv;
    }

    const score = c.trust * clamp(base, 0, 1);

    compMap.set(it, {
      score,
      eff,
      trust: c.trust,
      qual: c.qual,
      rel: c.rel,
      adv: c.adv,
      providerKey: normalizeProviderKey(it),
      id: safeStr(it?.id),
      title: safeStr(it?.title).toLowerCase(),
      url: pickBestUrlS200(it) || "",
    });
  }

  // Stable, deterministic sort with explicit tie-breakers
  arr.sort((a, b) => {
    const A = compMap.get(a);
    const B = compMap.get(b);

    // 1) score desc
    if (B.score !== A.score) return B.score - A.score;

    // 2) prefer priced over unpriced (only when scores equal)
    const ap = A.eff !== null ? 1 : 0;
    const bp = B.eff !== null ? 1 : 0;
    if (bp !== ap) return bp - ap;

    // 3) effective price asc (nulls at end)
    if (A.eff !== null && B.eff !== null && A.eff !== B.eff) return A.eff - B.eff;

    // 4) trust desc
    if (B.trust !== A.trust) return B.trust - A.trust;

    // 5) quality desc
    if (B.qual !== A.qual) return B.qual - A.qual;

    // 6) relevance desc
    if (B.rel !== A.rel) return B.rel - A.rel;

    // 7) advantage desc
    if (B.adv !== A.adv) return B.adv - A.adv;

    // 8) providerKey asc
    if (A.providerKey !== B.providerKey) return A.providerKey.localeCompare(B.providerKey);

    // 9) id asc
    if (A.id && B.id && A.id !== B.id) return A.id.localeCompare(B.id);

    // 10) url asc (extra determinism)
    if (A.url !== B.url) return A.url.localeCompare(B.url);

    // 11) title asc
    if (A.title !== B.title) return A.title.localeCompare(B.title);

    return 0;
  });

  return arr;
}

export function computeBestCardS200(items, ctx = {}) {
  const ranked = rankItemsS200(items, ctx);
  const best = ranked[0] || null;

  if (!best) return { bestItem: null, _meta: { bestCard: null } };

  const url = pickBestUrlS200(best);
  const title = safeStr(best?.title);

  // Contract lock (again): if something slipped, don't fabricate
  if (!title || !url) return { bestItem: null, _meta: { bestCard: null } };

  const eff = effectivePriceS200(best);
  const providerKey = normalizeProviderKey(best);
  const comps = scoreItemS200(best, ctx);
  const image = pickBestImageS200(best);
  const summary = shortSummaryS200(best, ctx);

  const bestCard = {
    id: safeStr(best?.id) || null,
    title: title || null,
    url,
    providerKey: providerKey || null,
    effectivePrice: eff,
    trustScore: comps.trust,
    qualityScore: comps.qual,
    relevanceScore: comps.rel,
    advantageScore: comps.adv,
    image: image,
    shortSummary: summary ? summary.slice(0, 220) : null,
  };

  return { bestItem: best, _meta: { bestCard } };
}

export default { computeBestCardS200, rankItemsS200, scoreItemS200 };
