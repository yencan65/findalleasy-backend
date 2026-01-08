// server/core/s200Fallback.js
// ============================================================================
// S200 FALLBACK — reviewer-bandaj + diag gate
// - applyS200FallbackIfEmpty: product empty ise serpapi/google_shopping fallback
// - shouldExposeDiagnostics: prod'da token, dev'de serbest (veya header ile)
// ============================================================================

import { serpSearch } from "../services/serpapi.js";
import {
  cseSearchSite,
  resolveCseCxForGroup,
  resolveCseKey,
  resolveCseSitesForGroup,
} from "./googleCseClient.js";
import { hydrateSeedUrl } from "./seedHydrator.js";

import { getCachedResult, setCachedResult } from "./cacheEngine.js";

const SERPAPI_ENABLED = !!(
  process.env.SERPAPI_KEY ||
  process.env.SERPAPI_API_KEY ||
  process.env.SERP_API_KEY
);

const GOOGLE_CSE_ENABLED = (process.env.GOOGLE_CSE_FALLBACK || "1") === "1";

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


function pickLangGeo({ locale, region }) {
  const loc = safeStr(locale).toLowerCase();
  const reg = safeStr(region).toLowerCase();

  const hl = (loc.split("-")[0] || "tr").replace(/[^a-z]/g, "") || "tr";
  // region genelde "TR" geliyor
  const gl = (reg || (hl === "tr" ? "tr" : "us")).replace(/[^a-z]/g, "") || "tr";
  const cr = `country${gl.toUpperCase()}`;
  const lr = hl ? `lang_${hl}` : "";
  return { hl, gl, cr, lr };
}

function normalizeUrlForDedupe(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const kill = [
      "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
      "gclid","fbclid","yclid","mc_cid","mc_eid","ref","ref_","tag"
    ];
    for (const k of kill) url.searchParams.delete(k);
    return url.toString();
  } catch {
    return safeStr(u);
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function providerKeyFromHost(host) {
  const h = safeStr(host).toLowerCase();
  if (h.endsWith("trendyol.com")) return "trendyol";
  if (h.endsWith("hepsiburada.com")) return "hepsiburada";
  if (h === "n11.com" || h.endsWith(".n11.com")) return "n11";
  if (h.endsWith("amazon.com.tr")) return "amazon_tr";
  if (h.endsWith("sahibinden.com")) return "sahibinden";
  if (h.endsWith("emlakjet.com")) return "emlakjet";
  if (h.endsWith("hepsiemlak.com")) return "hepsiemlak";
  if (h.endsWith("hurriyetemlak.com")) return "hurriyetemlak";
  if (h.endsWith("koctas.com.tr")) return "koctas";
  if (h.endsWith("bauhaus.com.tr")) return "bauhaus";
  if (h.endsWith("ikea.com.tr")) return "ikea";
  if (h.endsWith("getyourguide.com")) return "getyourguide";
  if (h.endsWith("viator.com")) return "viator";
  if (h.endsWith("klook.com")) return "klook";
  if (h.endsWith("tripadvisor.com")) return "tripadvisor";
  const p = h.split(".").filter(Boolean);
  return p.length >= 2 ? p[p.length - 2] : h || "seed";
}

const PROVIDER_TRUST = {
  amazon_tr: 0.92,
  trendyol: 0.90,
  hepsiburada: 0.90,
  n11: 0.85,
  sahibinden: 0.80,
  emlakjet: 0.78,
  hepsiemlak: 0.78,
  hurriyetemlak: 0.78,
  koctas: 0.82,
  bauhaus: 0.82,
  ikea: 0.85,
  getyourguide: 0.78,
  viator: 0.78,
  klook: 0.76,
  tripadvisor: 0.70,
};

function trustForProviderKey(k) {
  const key = safeStr(k).toLowerCase();
  return PROVIDER_TRUST[key] != null ? PROVIDER_TRUST[key] : 0.45;
}

function buildS200ItemFromHydrate(h, { source } = {}) {
  const url = normalizeUrlForDedupe(h.url);
  const host = h.host || hostOf(url);
  const providerKey = providerKeyFromHost(host);

  const price = Number(h.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    id: `seed_${cryptoSafeHash(url)}`,
    provider: providerKey,
    providerKey,
    title: safeStr(h.title) || host || "Item",
    price,
    finalPrice: price,
    optimizedPrice: price,
    currency: safeStr(h.currency) || safeStr(process.env.DEFAULT_CURRENCY || "TRY"),
    image: safeStr(h.image) || "",
    url,
    originUrl: url,
    finalUrl: url,
    description: safeStr(h.snippet) || "",
    commissionMeta: {
      providerTrust: trustForProviderKey(providerKey),
      source: source || "google_cse_seed",
    },
    raw: {
      seedHydrator: true,
      host,
    },
  };
}


function buildS200ItemFromSeed(seed, { group } = {}) {
  try {
    if (!seed || !seed.url) return null;
    const u = String(seed.url);
    const title = String(seed.title || "").trim();
    if (!title) return null;

    let host = "";
    try { host = new URL(u).hostname.replace(/^www\./, ""); } catch {}

    const providerKey = `google_cse:${host || "web"}`;
    return normalizeItemS200({
      id: stableId(`cse_seed|${group || "unknown"}|${u}`),
      title,
      url: u,
      originUrl: u,
      finalUrl: u,
      deeplink: u,
      provider: {
        key: providerKey,
        name: host || "Google CSE",
        type: "cse_seed",
        origin: "google_cse",
        trustScore: 0.35,
      },
      price: null,
      finalPrice: null,
      optimizedPrice: null,
      currency: "",
      image: seed.image || "",
      location: seed.location || "",
      raw: { seed },
      meta: { source: "google_cse_seed", group: group || "" },
    });
  } catch {
    return null;
  }
}

function roundRobinBalance(sites, itemsBySite, limit) {
  const buckets = sites.map((s) => (itemsBySite.get(s) || []).slice());
  const out = [];
  let guard = 0;
  while (out.length < limit && guard < 5000) {
    guard++;
    let progressed = false;
    for (let i = 0; i < buckets.length && out.length < limit; i++) {
      const b = buckets[i];
      if (b.length) {
        out.push(b.shift());
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
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


async function cseFallback({ q, group, region, locale, limit }) {
  const key = resolveCseKey();
  const cx = resolveCseCxForGroup(group);
  const sites = resolveCseSitesForGroup(group);

  if (!key || !cx || !sites.length) return null;

 const { hl, gl, cr, lr } = pickLangGeo({ locale, region });

  const maxPerSite = Number(process.env.GOOGLE_CSE_MAX_PER_SITE || 5);
  const perSiteNum = Math.min(10, Math.max(3, maxPerSite + 3));
  const target = Math.max(3, Number(limit || 6));

  const cacheKey = `s200:cse:${safeStr(group)}:${gl}:${hl}:${cryptoSafeHash(
    `${normalizeQForCache(q)}|${sites.join(",")}`
  )}:${target}`;
  const cached = await getCachedResult(cacheKey);
  if (cached?.ok && Array.isArray(cached?.items)) return cached;

  const itemsBySite = new Map();
  const seen = new Set();

  // 1) site-by-site CSE query
  for (const s of sites) {
    const domain = safeStr(s).toLowerCase();
    const r = await cseSearchSite({
      key,
      cx,
      q,
      site: domain,
      hl,
      gl,
      cr,
      lr,
      num: perSiteNum,
      start: 1,
      safe: "off",
      timeoutMs: Number(process.env.GOOGLE_CSE_TIMEOUT_MS || 4500),
    });

    const rawItems = Array.isArray(r?.items) ? r.items : [];
    const list = [];

    for (const it of rawItems) {
      const link = safeStr(it?.link);
      if (!link) continue;

      const norm = normalizeUrlForDedupe(link);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);

      list.push({
        title: safeStr(it?.title),
        link: norm,
        snippet: safeStr(it?.snippet),
        displayLink: safeStr(it?.displayLink) || domain,
        site: domain,
      });

      if (list.length >= perSiteNum) break;
    }

    itemsBySite.set(domain, list.slice(0, Math.max(1, maxPerSite)));
  }

  // 2) balance seeds
  const balancedSeeds = roundRobinBalance(
    sites.map((x) => safeStr(x).toLowerCase()),
    itemsBySite,
    Math.max(10, target * 4) // hydrate filtreleyecek
  );

  if (!balancedSeeds.length) {
    const out = { ok: false, items: [], diag: { reason: "empty_seeds", sites, group } };
    await setCachedResult(cacheKey, out, Number(process.env.GOOGLE_CSE_CACHE_TTL || 60));
    return out;
  }

  // 3) hydrate seeds -> gerçek item (price zorunlu)
  const concurrency = Math.max(1, Math.min(8, Number(process.env.SEED_HYDRATE_CONCURRENCY || 4)));
  const hydrated = [];
  let idx = 0;
  let active = 0;

  await new Promise((resolve) => {
    const kick = () => {
      if (hydrated.length >= target) return resolve();
      if (idx >= balancedSeeds.length && active === 0) return resolve();

      while (active < concurrency && idx < balancedSeeds.length && hydrated.length < target) {
        const seed = balancedSeeds[idx++];
        active++;
        (async () => {
          const h = await hydrateSeedUrl(seed.link, {});
          if (h?.ok && h.price != null && h.price > 0) {
            const item = buildS200ItemFromHydrate({
              ...h,
              snippet: seed.snippet || h.snippet,
              title: h.title || seed.title,
            }, { source: "google_cse_seed" });
            if (item) hydrated.push(item);
          }
        })()
          .catch(() => {})
          .finally(() => {
            active--;
            kick();
          });
      }
    };
    kick();
  });

  const seedOnlyItems = balancedSeeds
    .map((s) => buildS200ItemFromSeed(s, { group }))
    .filter(Boolean);

  const finalItems = hydrated.length > 0 ? hydrated : seedOnlyItems;

  const out = {
    ok: finalItems.length > 0,
    items: finalItems,
    diag: {
      kind: hydrated.length > 0 ? "google_cse_seed_hydrate" : "google_cse_seed_only",
      group,
      sites,
      seedCount: balancedSeeds.length,
      hydratedCount: hydrated.length,
      finalCount: finalItems.length,
      hl,
      gl,
      cr,
      lr,
    },
  };
  await setCachedResult(cacheKey, out, Number(process.env.GOOGLE_CSE_CACHE_TTL || 120));
  return out;
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


async function hydrateCseSeedsToItems(seeds, { limit } = {}) {
  const target = Math.max(1, Number(limit || 6));
  const concurrency = Math.max(1, Math.min(8, Number(process.env.SEED_HYDRATE_CONCURRENCY || 4)));

  const out = [];
  let idx = 0;
  let active = 0;

  return await new Promise((resolve) => {
    const kick = () => {
      if (out.length >= target) return resolve(out);
      if (idx >= seeds.length && active === 0) return resolve(out);

      while (active < concurrency && idx < seeds.length && out.length < target) {
        const seed = seeds[idx++];
        active++;

        (async () => {
          const h = await hydrateSeedUrl(seed.link, {});
          if (h?.ok && h.price != null && h.price > 0) {
            const item = buildS200ItemFromHydrate(h, { providerKeyHint: providerKeyFromHost(hostOf(h.url)) });
            // Özet/snippet’i CSE seed’den daha iyi ise taşı
            if (seed?.snippet && !item.description) item.description = String(seed.snippet);
            out.push(item);
          }
        })()
          .catch(() => {})
          .finally(() => {
            active--;
            kick();
          });
      }
    };
    kick();
  });
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
  // If serpapi yielded nothing and Google CSE fallback is enabled, try CSE seed+hydrate pipeline
  let attemptedStrategies = ["serpapi_google_shopping"];
  let finalItems = fbItems;
  let strategyUsed = fbItems.length > 0 ? "serpapi_google_shopping" : "none";
  const diagCombined = exposeDiag ? { serpapi: fb.diag } : undefined;

  if (finalItems.length === 0 && GOOGLE_CSE_ENABLED) {
    try {
      const cfb = await cseFallback({ q, group, gl, hl, limit });
      const cItems = Array.isArray(cfb?.items) ? cfb.items : [];
      attemptedStrategies.push("google_cse_seeds");
      if (diagCombined) diagCombined.google_cse = cfb?.diag;
      if (cItems.length > 0) {
        finalItems = cItems;
        strategyUsed = "google_cse_seeds";
      }
    } catch (e) {
      attemptedStrategies.push("google_cse_seeds");
      if (diagCombined) diagCombined.google_cse = { provider: "google_cse", enabled: GOOGLE_CSE_ENABLED, error: String(e?.message || e) };
    }
  }


  // Merge into response (never crash)
  const next = { ...base };
  next.items = finalItems;
  next.results = finalItems;
  next.count = finalItems.length;
  next.total = finalItems.length;
  next.hasMore = false;
  next.nextOffset = 0;

  next._meta = next._meta && typeof next._meta === "object" ? next._meta : {};
  next._meta.engineVariant = next._meta.engineVariant || "S200_FALLBACK";
  if (typeof next._meta.deadlineHit !== "boolean") next._meta.deadlineHit = false;

  next._meta.fallback = {
    attempted: true,
    used: finalItems.length > 0,
    strategy: strategyUsed,
    attemptedStrategy: attemptedStrategies[attemptedStrategies.length - 1],
    attemptedStrategies,
    reason,
    serpapiEnabled: SERPAPI_ENABLED,
    cseEnabled: GOOGLE_CSE_ENABLED,
    count: finalItems.length,
    diag: diagCombined,
  };;

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
