// server/core/s200Fallback.js
// ============================================================================
// S200 FALLBACK — reviewer-bandaj + diag gate
// - applyS200FallbackIfEmpty: product empty ise serpapi/google_shopping fallback
// - shouldExposeDiagnostics: prod'da token, dev'de serbest (veya header ile)
// ============================================================================

import { serpSearch } from "../services/serpapi.js";
import { getCachedResult, setCachedResult } from "./cacheEngine.js";

const SERPAPI_ENABLED = !!(
  process.env.SERPAPI_KEY ||
  process.env.SERPAPI_API_KEY ||
  process.env.SERP_API_KEY
);

// ============================================================================
//  CREDIT-SAVING DISCIPLINE (SerpApi fallback)
//   (1) Empty query guard
//   (2) Submit-only is FE-side, but BE still guards empty/short
//   (3) No pagination: fallback only for offset==0
//   (4) Double cache: our cache (L1 memory + L2 NodeCache) + SerpApi's own cache
// ============================================================================

const FB_CACHE_TTL_MS = (() => {
  const v = Number(process.env.SERP_FALLBACK_CACHE_MS || 6 * 60 * 60 * 1000);
  if (!Number.isFinite(v) || v <= 0) return 6 * 60 * 60 * 1000;
  return Math.min(Math.max(v, 60 * 1000), 24 * 60 * 60 * 1000);
})();

const FB_CACHE_MAX_KEYS = (() => {
  const v = Number(process.env.SERP_FALLBACK_CACHE_MAX_KEYS || 400);
  if (!Number.isFinite(v) || v <= 0) return 400;
  return Math.min(Math.max(v, 50), 3000);
})();

function _getFbCache() {
  const k = "__FAE_S200_SERP_FALLBACK_CACHE";
  if (!globalThis[k]) globalThis[k] = new Map();
  return globalThis[k];
}

function _getFbInflight() {
  const k = "__FAE_S200_SERP_FALLBACK_INFLIGHT";
  if (!globalThis[k]) globalThis[k] = new Map();
  return globalThis[k];
}

function _fbCachePrune(cache) {
  try {
    if (!cache || typeof cache.size !== "number") return;
    // Soft prune: oldest-first eviction
    while (cache.size > FB_CACHE_MAX_KEYS) {
      const firstKey = cache.keys().next()?.value;
      if (!firstKey) break;
      cache.delete(firstKey);
    }
  } catch {
    // ignore
  }
}

function normalizeQForCache(q) {
  const s = safeStr(q)
    .toLowerCase()
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // avoid pathological keys
  return s.slice(0, 140);
}

function getReqOffset(req, base) {
  // Route is drift-safe: read from req first, then base meta
  try {
    const o =
      req?.method === "POST"
        ? (req?.body?.offset ?? req?.body?.skip)
        : (req?.query?.offset ?? req?.query?.skip);

    const n = Number.parseInt(String(o ?? "0"), 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}

  try {
    const n2 = Number.parseInt(String(base?._meta?.offset ?? "0"), 10);
    if (Number.isFinite(n2) && n2 > 0) return n2;
  } catch {}

  return 0;
}

export function shouldExposeDiagnostics(req) {
  try {
    const q = String(req?.query?.diag || "").trim().toLowerCase();
    const diagQuery = q === "1" || q === "true" || q === "yes";

    const h = String(req?.headers?.["x-fae-diag"] || "").trim();
    const token = String(
      process.env.FINDALLEASY_DIAG_TOKEN || process.env.FAE_DIAG_TOKEN || ""
    ).trim();
    const isProd =
      String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

    // Query ile diag istendi:
    // - non-prod: her zaman aç
    // - prod: token varsa header token match şart, token yoksa aç
    if (diagQuery) {
      if (isProd && token) return h === token;
      return true;
    }

    // Header-based diag (token opsiyonel)
    if (!h) return false;
    if (!token) return true;
    return h === token;
  } catch {
    return false;
  }
}

function safeStr(v) {
  return v == null ? "" : String(v).trim();
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

function normalizeSerpItem(it) {
  const obj = it && typeof it === "object" ? it : {};
  const title = safeStr(obj.title || obj.name || obj.product_title);
  const link = safeStr(obj.link || obj.product_link || obj.url);
  const img = safeStr(obj.thumbnail || obj.image || obj.img);
  const priceStr = safeStr(
    pick(obj, ["price", "extracted_price", "price_value", "price_num"])
  );

  // extracted_price might already be a number
  const priceNum =
    typeof obj.extracted_price === "number"
      ? obj.extracted_price
      : Number(String(priceStr || "").replace(",", ".").replace(/[^\d.]/g, ""));

  const price = Number.isFinite(priceNum) ? priceNum : 0;

  return {
    id: `serpapi:${cryptoSafeHash(title + "|" + link)}`,
    provider: "serpapi",
    providerKey: "serpapi",
    title,
    price,
    finalPrice: price,
    currency: safeStr(obj.currency || obj.price_currency || "TRY"),
    image: img,
    url: link,
    finalUrl: link,
    originUrl: link,
  };
}

function cryptoSafeHash(s) {
  try {
    // lazy import to avoid bundlers
    // eslint-disable-next-line global-require
    const crypto = require("crypto");
    return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 16);
  } catch {
    // fallback
    const x = String(s || "");
    let h = 0;
    for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16);
  }
}

async function serpFallback({ q, gl = "tr", hl = "tr", limit = 8 }) {
  const diag = { provider: "serpapi", enabled: SERPAPI_ENABLED };
  const t0 = Date.now();

  if (!SERPAPI_ENABLED) {
    return { items: [], diag: { ...diag, error: "SERPAPI_DISABLED", ms: Date.now() - t0 } };
  }

  // (1) Empty query guard (do not burn credits)
  const q0 = safeStr(q);
  if (!q0) {
    return { items: [], diag: { ...diag, error: "EMPTY_QUERY", ms: Date.now() - t0 } };
  }

  const gl0 = safeStr(gl || "tr").toLowerCase() || "tr";
  const hl0 = safeStr(hl || "tr").toLowerCase() || "tr";
  const qKey = normalizeQForCache(q0);
  const cacheKey = `s200:fb:serpapi:google_shopping:${gl0}:${hl0}:${qKey}`;

  // (4) OUR CACHE — L1 memory (longer TTL) + L2 NodeCache (shorter, async-safe)
  // L1
  try {
    const mem = _getFbCache();
    const hit = mem.get(cacheKey);
    if (hit && (Date.now() - (hit.ts || 0)) <= FB_CACHE_TTL_MS) {
      return {
        items: Array.isArray(hit.items) ? hit.items : [],
        diag: { ...diag, ms: Date.now() - t0, cached: true, cache: "L1", count: (hit.items || []).length },
      };
    }
  } catch {}

  // L2
  try {
    const hit2 = await getCachedResult(cacheKey);
    if (hit2 && Array.isArray(hit2.items)) {
      try {
        const mem = _getFbCache();
        mem.set(cacheKey, { ts: Date.now(), items: hit2.items });
        _fbCachePrune(mem);
      } catch {}
      return {
        items: hit2.items,
        diag: { ...diag, ms: Date.now() - t0, cached: true, cache: "L2", count: hit2.items.length },
      };
    }
  } catch {}

  // Inflight de-dupe (prevents double billing on concurrent requests)
  try {
    const inflight = _getFbInflight();
    const p = inflight.get(cacheKey);
    if (p && typeof p.then === "function") {
      const got = await p;
      const gotItems = Array.isArray(got?.items) ? got.items : [];
      return {
        items: gotItems,
        diag: { ...diag, ms: Date.now() - t0, cached: true, cache: "INFLIGHT", count: gotItems.length },
      };
    }
  } catch {}

  try {
    const inflight = _getFbInflight();
    const job = (async () => {
      const r = await serpSearch({ q: q0, engine: "google_shopping", gl: gl0, hl: hl0 });
      const arr =
        Array.isArray(r?.shopping_results) ? r.shopping_results : Array.isArray(r?.results) ? r.results : [];

      const itemsAll = arr.map(normalizeSerpItem).filter((x) => x?.title && x?.url);
      const items = itemsAll.slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));

      // Store caches
      try {
        const mem = _getFbCache();
        mem.set(cacheKey, { ts: Date.now(), items });
        _fbCachePrune(mem);
      } catch {}

      try {
        // CacheEngine TTL is capped internally; still useful.
        await setCachedResult(cacheKey, { items }, 3600);
      } catch {}

      return { items };
    })();

    try {
      inflight.set(cacheKey, job);
    } catch {}

    const out = await job;
    try {
      inflight.delete(cacheKey);
    } catch {}

    const arr =
      Array.isArray(out?.items) ? out.items : [];

    return {
      items: arr,
      diag: { ...diag, ms: Date.now() - t0, count: arr.length },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e);
    return {
      items: [],
      diag: { ...diag, error: msg, ms: Date.now() - t0 },
    };
  } finally {
    try {
      const inflight = _getFbInflight();
      inflight.delete(cacheKey);
    } catch {}
  }
}

export async function applyS200FallbackIfEmpty({
  req,
  result,
  q,
  group,
  region,
  locale,
  limit = 10,
  reason = "EMPTY_PRIMARY",
}) {
  const base = result && typeof result === "object" ? result : {};
  const items = Array.isArray(base?.items) ? base.items : Array.isArray(base?.results) ? base.results : [];
  const exposeDiag = shouldExposeDiagnostics(req);

  // If already has items, do nothing
  if (items.length > 0) {
    try {
      if (base?._meta && typeof base._meta === "object") {
        if (!base._meta.fallback) base._meta.fallback = { attempted: false, used: false, strategy: "none" };
      }
    } catch {}
    return base;
  }

  // Only for product group
  const g = safeStr(group || base?.group || base?.category).toLowerCase();
  if (g !== "product") return base;

  // Optional: caller can explicitly skip fallback (telemetry, smoke-tests, etc.)
  // This must NEVER break existing callers: flag is opt-in only.
  const skipFallback = (() => {
    try {
      const h = String(req?.headers?.["x-fae-skip-fallback"] || req?.headers?.["x-skip-fallback"] || "")
        .trim()
        .toLowerCase();
      if (h === "1" || h === "true" || h === "yes") return true;
    } catch {}

    try {
      const b = req?.method === "POST" ? (req?.body || {}) : {};
      if (b?.skipFallback === true || b?.telemetryOnly === true) return true;
      const s = String(b?.skipFallback || b?.telemetryOnly || "").trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes") return true;
    } catch {}

    try {
      const qv = String(req?.query?.skipFallback || req?.query?.telemetryOnly || "").trim().toLowerCase();
      if (qv === "1" || qv === "true" || qv === "yes") return true;
    } catch {}

    return false;
  })();

  if (skipFallback) {
    try {
      if (base?._meta && typeof base._meta === "object") {
        base._meta.fallback = base._meta.fallback || { attempted: false, used: false, strategy: "none" };
        base._meta.fallback.attempted = false;
        base._meta.fallback.used = false;
        base._meta.fallback.strategy = "none";
        base._meta.fallback.reason = "SKIP_FLAG";
      }
    } catch {}
    return base;
  }

  // (3) No pagination: only allow fallback on first page
  // If FE requests offset>0 (infinite scroll), DO NOT call SerpApi again.
  const reqOffset = getReqOffset(req, base);
  if (reqOffset > 0) {
    try {
      if (base?._meta && typeof base._meta === "object") {
        base._meta.fallback = base._meta.fallback || { attempted: false, used: false, strategy: "none" };
        base._meta.fallback.attempted = false;
        base._meta.fallback.used = false;
        base._meta.fallback.strategy = "none";
        base._meta.fallback.reason = "PAGINATION_SKIP";
      }
    } catch {}
    return base;
  }

  // Try serpapi
  const fb = await serpFallback({
    q: safeStr(q || base?.q || base?.query),
    gl: safeStr(region || "TR").toLowerCase(),
    hl: safeStr(locale || "tr").toLowerCase(),
    limit,
  });

  const fbItems = Array.isArray(fb?.items) ? fb.items : [];

  // Merge into response (never crash)
  const next = { ...base };
  next.items = fbItems;
  next.results = fbItems;
  next.count = fbItems.length;
  next.total = fbItems.length;
  next.hasMore = false;
  next.nextOffset = 0;

  next._meta = next._meta && typeof next._meta === "object" ? next._meta : {};
  next._meta.engineVariant = next._meta.engineVariant || "S200_FALLBACK";
  if (typeof next._meta.deadlineHit !== "boolean") next._meta.deadlineHit = false;

  next._meta.fallback = (() => {
    const attemptedStrategy = "serpapi_google_shopping";
    const used = fbItems.length > 0;

    // Semantics:
    // - attempted: fallback denendi
    // - used: fallback usable item üretti
    // - strategy: sadece used=true ise "none" dışı
    return {
      attempted: true,
      used,
      strategy: used ? attemptedStrategy : "none",
      attemptedStrategy,
      reason,
      serpapiEnabled: SERPAPI_ENABLED,
      count: fbItems.length,
      ...(exposeDiag ? { diag: fb.diag } : {}),
    };
  })();

  // Strip _raw if diag not exposed
  if (!exposeDiag) {
    try {
      next.items = Array.isArray(next.items)
        ? next.items.map((it) => {
            const { _raw, ...rest } = it || {};
            return rest;
          })
        : [];
      next.results = next.items;
    } catch {}
  }

  return next;
}
