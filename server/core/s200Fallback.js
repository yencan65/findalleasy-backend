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

// ✅ Key sızdırmasın: query param key=... maskele
function redactGoogleKey(s) {
  const x = safeStr(s);
  return x.replace(/([?&]key=)[^&]+/gi, "$1***");
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

// ✅ FIX: sağlam ve deterministik pickLangGeo (gl her koşulda tanımlı)
function pickLangGeo({ locale, region } = {}) {
  const loc = String(locale || "tr").trim();
  const parts = loc.split(/[-_]/).filter(Boolean);

  const hl = (parts[0] || "tr").toLowerCase(); // language
  const gl = String(region || parts[1] || "TR").toUpperCase(); // country

  // Custom Search opsiyonları
  const cr = `country${gl}`; // e.g. countryTR
  const lr = `lang_${hl}`; // e.g. lang_tr

  return { hl, gl, cr, lr };
}

function normalizeUrlForDedupe(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const kill = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "yclid",
      "mc_cid",
      "mc_eid",
      "ref",
      "ref_",
      "tag",
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


// ✅ Seed URL filtreleme (çöp URL’leri hydratelama)
//  - Hepsiburada: sadece -p- veya -pm- (ürün sayfası), yorumlar vb dışarıda
//  - n11: sadece /urun/
//  - Amazon TR: sadece /dp/ veya /gp/product/
//  - Trendyol: mümkünse ürün sayfası (-p-)
// Not: Filtre çok katı gelirse env ile kapatılabilir: GOOGLE_CSE_SEED_FILTER=0
function seedUrlAllowForSite(site, url) {
  const s = safeStr(site).toLowerCase();
  const u = safeStr(url);
  if (!u) return { ok: false, reason: "EMPTY_URL" };

  let pathname = "";
  let host = "";
  try {
    const x = new URL(u);
    host = x.hostname.replace(/^www\./, "").toLowerCase();
    pathname = (x.pathname || "").toLowerCase();
  } catch {
    pathname = u.toLowerCase();
  }

  // Normalize: some sites append "-yorumlari" etc.
  if ((s.includes("hepsiburada.com") || host.endsWith("hepsiburada.com"))) {
    if (pathname.includes("-yorumlari")) return { ok: false, reason: "HB_REVIEWS" };
    if (pathname.includes("-p-") || pathname.includes("-pm-")) return { ok: true, reason: "HB_PRODUCT" };
    return { ok: false, reason: "HB_NON_PRODUCT" };
  }

  if ((s === "n11.com" || s.endsWith(".n11.com") || host === "n11.com" || host.endsWith(".n11.com"))) {
    if (pathname.includes("/urun/")) return { ok: true, reason: "N11_PRODUCT" };
    return { ok: false, reason: "N11_NON_PRODUCT" };
  }

  if ((s.includes("amazon.com.tr") || host.endsWith("amazon.com.tr"))) {
    if (pathname.includes("/dp/") || pathname.includes("/gp/product/")) return { ok: true, reason: "AMZ_PRODUCT" };
    return { ok: false, reason: "AMZ_NON_PRODUCT" };
  }

  if ((s.includes("trendyol.com") || host.endsWith("trendyol.com"))) {
    if (pathname.includes("-p-")) return { ok: true, reason: "TRND_PRODUCT" };
    return { ok: false, reason: "TRND_NON_PRODUCT" };
  }

  // default: allow
  return { ok: true, reason: "ALLOW_DEFAULT" };
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
  trendyol: 0.9,
  hepsiburada: 0.9,
  n11: 0.85,
  sahibinden: 0.8,
  emlakjet: 0.78,
  hepsiemlak: 0.78,
  hurriyetemlak: 0.78,
  koctas: 0.82,
  bauhaus: 0.82,
  ikea: 0.85,
  getyourguide: 0.78,
  viator: 0.78,
  klook: 0.76,
  tripadvisor: 0.7,
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


// --------------------------------------------------------------------------
// Local fallbacks (defensive): some older branches referenced stableId / normalizeItemS200
// without importing them. Keep them here so seed-only mode never crashes.
// --------------------------------------------------------------------------
function stableId(s) {
  return `sid_${cryptoSafeHash(String(s || ""))}`;
}

function normalizeItemS200(it) {
  // Minimal normalization to keep callers resilient.
  // Do not over-normalize here; S200 consumers vary by route.
  return it && typeof it === "object" ? it : {};
}

function buildS200ItemFromSeed(seed, { group } = {}) {
  try {
    if (!seed) return null;

    // Seed shape can be { link, title, snippet, site } from CSE pipeline
    const uRaw = seed.url || seed.link || seed.href || seed.finalUrl || seed.originUrl;
    const u = String(uRaw || "").trim();
    if (!u) return null;

    // Title is optional; if missing, derive a readable one from URL
    let title = String(seed.title || seed.name || "").trim();
    if (!title) {
      try {
        const U = new URL(u);
        const last = (U.pathname || "")
          .split("/")
          .filter(Boolean)
          .pop() || "";
        title = decodeURIComponent(last)
          .replace(/[-_]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      } catch {}
    }
    if (!title) title = "Link";

    let host = "";
    try {
      host = new URL(u).hostname.replace(/^www\./, "");
    } catch {}

    const providerKey = `google_cse:${host || "web"}`;
    return normalizeItemS200({
      id: stableId(`cse_seed|${group || "unknown"}|${u}`),
      title,
      url: u,
      originUrl: u,
      finalUrl: u,
      deeplink: u,
      provider: providerKey,
      providerMeta: {
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
  const priceStr = safeStr(pick(obj, ["price", "extracted_price", "price_value", "price_num"]));

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

  const seedFilterEnabled = String(process.env.GOOGLE_CSE_SEED_FILTER || "1") !== "0";
  const seedFilterDropsBySite = Object.create(null);
  const CSE_DIAG_VERSION = 'cse_diag_v3_3_hybridpolicy_2026-01-08';

  const cacheKey = `s200:cse:${safeStr(group)}:${gl}:${hl}:${seedFilterEnabled ? 1 : 0}:${CSE_DIAG_VERSION}:${cryptoSafeHash(
    `${normalizeQForCache(q)}|${sites.join(",")}`
  )}:${target}`;

  const cached = await getCachedResult(cacheKey);
  if (cached?.ok && Array.isArray(cached?.items)) return cached;

  const itemsBySite = new Map();

// ✅ NEW: site bazında CSE hata toplama (empty_seeds maskesini kır)
  const siteErrors = [];
  const siteEmpty = [];

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

    // ✅ HATA VARSA KAYDET (yoksa empty_seeds diye maskeleniyor)
    if (!r?.ok) {
      siteErrors.push({
        site: domain,
        status: r?.status || r?.httpStatus || r?.http_status || null,
        code: r?.code || r?.errorCode || null,
        error: redactGoogleKey(r?.error || r?.message || "CSE_ERROR"),
      });
      itemsBySite.set(domain, []);
      continue;
    }

    let droppedByFilter = 0;
    const rawItems = Array.isArray(r?.items) ? r.items : [];
    const list = [];

    for (const it of rawItems) {
      const link = safeStr(it?.link);
      if (!link) continue;

      const norm = normalizeUrlForDedupe(link);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);

      if (seedFilterEnabled) {
        const allow = seedUrlAllowForSite(domain, norm);
        if (!allow?.ok) {
          droppedByFilter++;
          continue;
        }
      }

      list.push({
        title: safeStr(it?.title),
        link: norm,
        snippet: safeStr(it?.snippet),
        displayLink: safeStr(it?.displayLink) || domain,
        site: domain,
      });

      if (list.length >= perSiteNum) break;
    }

    seedFilterDropsBySite[domain] = droppedByFilter;
    itemsBySite.set(domain, list.slice(0, Math.max(1, maxPerSite)));

    if (list.length === 0) {
      const rawCount = Array.isArray(rawItems) ? rawItems.length : 0;
      const reason =
        rawCount === 0
          ? "NO_RESULTS"
          : (seedFilterEnabled && droppedByFilter > 0 ? "URL_FILTERED_ALL" : "FILTERED_OUT");

      siteEmpty.push({
        site: domain,
        reason,
        rawCount,
        droppedByFilter,
      });
    }
  }

  // 2) balance seeds
  const balancedSeeds = roundRobinBalance(
    sites.map((x) => safeStr(x).toLowerCase()),
    itemsBySite,
    Math.max(10, target * 4) // hydrate filtreleyecek
  );

  // ✅ Seed dağılımını görünür yap (hangi site kaç seed verdi?)
  const seedBySite = Object.create(null);
  const seedSampleBySite = Object.create(null);
  for (const s of balancedSeeds) {
    const sk = safeStr(s?.site) || hostOf(s?.link) || "unknown";
    seedBySite[sk] = (seedBySite[sk] || 0) + 1;

    // küçük örnek: her siteden en fazla 2 URL
    if (!seedSampleBySite[sk]) seedSampleBySite[sk] = [];
    if (seedSampleBySite[sk].length < 2) seedSampleBySite[sk].push(normalizeUrlForDedupe(s?.link || ""));
  }

  // ✅ empty_seeds yerine "cse_failed" + siteErrors
  if (!balancedSeeds.length) {
    const out = {
      ok: false,
      items: [],
      diag: {
        reason: siteErrors.length ? "cse_failed" : "empty_seeds",
        diagVersion: CSE_DIAG_VERSION,
        sites,
        group,
        seedBySite,
        seedSampleBySite,
        seedFilterEnabled,
        seedFilterDropsBySite,
        siteErrors: siteErrors.slice(0, 8),
        siteEmpty: siteEmpty.slice(0, 8),
      },
    };
    await setCachedResult(cacheKey, out, Number(process.env.GOOGLE_CSE_CACHE_TTL || 60));
    return out;
  }

  
// 2.9) Hydrate policy (prod gerçekliği: bazı domainler CAPTCHA/blocked)
const HYDRATE_POLICY = safeStr(process.env.GOOGLE_CSE_HYDRATE_POLICY || "auto").toLowerCase(); // auto | all | none
const HYDRATE_ALLOWLIST_RAW = safeStr(process.env.GOOGLE_CSE_HYDRATE_ALLOWLIST || "trendyol.com"); // csv; "*" = all
const HYDRATE_CAPTCHA_RAW = safeStr(process.env.GOOGLE_CSE_HYDRATE_CAPTCHA_DOMAINS || "hepsiburada.com,n11.com");
const HYDRATE_SKIP_AMAZON = ["1", "true", "yes", "on"].includes(
  safeStr(process.env.GOOGLE_CSE_HYDRATE_SKIP_AMAZON || "1").toLowerCase()
);

const parseDomainSet = (csv) => {
  const set = new Set();
  String(csv || "")
    .split(",")
    .map((x) => safeStr(x).toLowerCase())
    .filter(Boolean)
    .forEach((d) => set.add(d));
  return set;
};

const hydrateAllowlist = parseDomainSet(HYDRATE_ALLOWLIST_RAW);
const hydrateCaptchaDomains = parseDomainSet(HYDRATE_CAPTCHA_RAW);

const hydrateSkippedByPolicyBySite = Object.create(null);
const bumpHydSkip = (siteKey) => {
  const k = safeStr(siteKey).toLowerCase() || "unknown";
  hydrateSkippedByPolicyBySite[k] = (hydrateSkippedByPolicyBySite[k] || 0) + 1;
};

const shouldHydrateSite = (siteKey) => {
  const s = safeStr(siteKey).toLowerCase();
  if (!s) return false;

  if (HYDRATE_POLICY === "none") return false;

  // CAPTCHA / blocked domains: hydrate deneme -> time waste
  if (hydrateCaptchaDomains.has(s)) return false;

  // Amazon TR: çoğu zaman "blocked/no_price" (opsiyonel hydrate)
  if (HYDRATE_SKIP_AMAZON && s === "amazon.com.tr") return false;

  // allowlist: boş değilse ve "*" yoksa sadece listedekiler
  if (hydrateAllowlist.size > 0 && !hydrateAllowlist.has("*") && !hydrateAllowlist.has(s)) return false;

  return true;
};

const hydrateSeeds = balancedSeeds.filter((seed) => {
  const siteKey = safeStr(seed?.site) || hostOf(seed?.link || seed?.url || "");
  const ok = HYDRATE_POLICY === "all" ? true : shouldHydrateSite(siteKey);
  if (!ok) bumpHydSkip(siteKey);
  return ok;
});

// 3) hydrate seeds -> gerçek item (price zorunlu)
  const concurrency = Math.max(1, Math.min(8, Number(process.env.SEED_HYDRATE_CONCURRENCY || 4)));
  const hydrated = [];

  // ✅ Hydrate teşhisi: hangi sitede neden fiyat çıkmadı?
  const hydrateBySite = Object.create(null);
  const hydrateErrors = [];
  const HYD_ERR_LIMIT = Math.max(
    0,
    Math.min(50, Number(process.env.GOOGLE_CSE_HYDRATE_ERR_LIMIT || 12))
  );

  function bumpHyd(site, key, inc = 1) {
    const s = safeStr(site) || "unknown";
    if (!hydrateBySite[s]) {
      hydrateBySite[s] = { attempted: 0, ok: 0, priced: 0, noPrice: 0, failed: 0 };
    }
    hydrateBySite[s][key] = (hydrateBySite[s][key] || 0) + inc;
  }

  function pushHydErr(e) {
    if (HYD_ERR_LIMIT <= 0) return;
    if (hydrateErrors.length >= HYD_ERR_LIMIT) return;
    hydrateErrors.push(e);
  }
  let idx = 0;
  let active = 0;

  await new Promise((resolve) => {
    const kick = () => {
      if (hydrated.length >= target) return resolve();
      if (idx >= hydrateSeeds.length && active === 0) return resolve();

      while (active < concurrency && idx < hydrateSeeds.length && hydrated.length < target) {
        const seed = hydrateSeeds[idx++];
        active++;
        (async () => {
          const siteKey = safeStr(seed?.site) || hostOf(seed?.link) || "unknown";
          bumpHyd(siteKey, "attempted", 1);

          const h = await hydrateSeedUrl(seed.link, {});

          if (!h?.ok) {
            bumpHyd(siteKey, "failed", 1);
            pushHydErr({
              site: siteKey,
              url: normalizeUrlForDedupe(seed?.link || ""),
              reason: "HYDRATE_FAIL",
              status: h?.status || h?.httpStatus || h?.http_status || null,
              code: h?.code || h?.errorCode || null,
              error: safeStr(h?.error || h?.message || ""),
            });
            return;
          }

          bumpHyd(siteKey, "ok", 1);

          const priceNum = Number(h?.price);
          const hasPrice = Number.isFinite(priceNum) && priceNum > 0;

          if (!hasPrice) {
            bumpHyd(siteKey, "noPrice", 1);
            pushHydErr({
              site: siteKey,
              url: normalizeUrlForDedupe(seed?.link || ""),
              reason: "NO_PRICE",
              status: h?.status || h?.httpStatus || h?.http_status || null,
              code: h?.code || h?.errorCode || null,
              note: safeStr(h?.note || h?.reason || ""),
            });
            return;
          }

          bumpHyd(siteKey, "priced", 1);

          const item = buildS200ItemFromHydrate(
            {
              ...h,
              snippet: seed.snippet || h.snippet,
              title: h.title || seed.title,
            },
            { source: "google_cse_seed" }
          );
          if (item) hydrated.push(item);
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

  
  const hydrateTotals = { attempted: 0, ok: 0, priced: 0, noPrice: 0, failed: 0 };
  for (const k of Object.keys(hydrateBySite)) {
    const v = hydrateBySite[k] || {};
    hydrateTotals.attempted += Number(v.attempted || 0);
    hydrateTotals.ok += Number(v.ok || 0);
    hydrateTotals.priced += Number(v.priced || 0);
    hydrateTotals.noPrice += Number(v.noPrice || 0);
    hydrateTotals.failed += Number(v.failed || 0);
  }


const seedOnlyItems = balancedSeeds.map((s) => buildS200ItemFromSeed(s, { group })).filter(Boolean);

// Hybrid: priced (hydrated) + unpriced (seed-only). Dedup by normalized URL.
const finalItems = [];
const = new Set();

const pushFinal = (it) => {
  if (!it) return;
  const u = normalizeUrlForDedupe(it.url || it.finalUrl || it.originUrl || it.deeplink || "");
  if (!u) return;
  if (seen.has(u)) return;
  seen.add(u);
  finalItems.push(it);
};

// priced first
hydrated.forEach(pushFinal);

// then seed-only (diversity)
if (finalItems.length < target) {
  seedOnlyItems.forEach(pushFinal);
}

if (finalItems.length > target) finalItems.length = target;
const out = {
    ok: finalItems.length > 0,
    items: finalItems,
    diag: {
      kind: hydrated.length > 0 ? (finalItems.length > hydrated.length ? "google_cse_hybrid" : "google_cse_seed_hydrate") : "google_cse_seed_only",
      diagVersion: CSE_DIAG_VERSION,
      group,
      sites,
      seedCount: balancedSeeds.length,
      hydratePolicy: HYDRATE_POLICY,
      hydrateAllowlist: HYDRATE_ALLOWLIST_RAW,
      hydrateCaptchaDomains: HYDRATE_CAPTCHA_RAW,
      hydrateSkipAmazon: HYDRATE_SKIP_AMAZON,
      hydrateCandidates: hydrateSeeds.length,
      hydrateSkippedByPolicyBySite,
      seedBySite,
      seedSampleBySite,
      seedFilterEnabled,
      seedFilterDropsBySite,
      hydrateBySite,
      hydrateTotals,
      hydrateErrorsSample: hydrateErrors,
      hydratedCount: hydrated.length,
      finalCount: finalItems.length,
      hl,
      gl,
      cr,
      lr,
      timeoutMs: Number(process.env.GOOGLE_CSE_TIMEOUT_MS || 4500),
      siteErrors: siteErrors.slice(0, 8),
      siteEmpty: siteEmpty.slice(0, 8),
      siteErrorCount: siteErrors.length,
      siteEmptyCount: siteEmpty.length,
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
    if (hit && Date.now() - (hit.ts || 0) <= FB_CACHE_TTL_MS) {
      return {
        items: Array.isArray(hit.items) ? hit.items : [],
        diag: {
          ...diag,
          ms: Date.now() - t0,
          cached: true,
          cache: "L1",
          count: (hit.items || []).length,
        },
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
      const arr = Array.isArray(r?.shopping_results)
        ? r.shopping_results
        : Array.isArray(r?.results)
          ? r.results
          : [];

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

    const arr = Array.isArray(out?.items) ? out.items : [];

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
      const b = req?.method === "POST" ? req?.body || {} : {};
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

  const qSafe = safeStr(q || base?.q || base?.query);
  const q0 = qSafe;
  const loc0 = safeStr(locale || base?._meta?.locale || base?.locale || "tr");
  const reg0 = safeStr(region || base?._meta?.region || base?.region || "TR");

  // Try serpapi
  const fb = await serpFallback({
    q: q0,
    gl: safeStr(reg0 || "TR").toLowerCase(),
    hl: safeStr(loc0 || "tr").toLowerCase(),
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
      // ✅ FIX: gl/hl diye hayalet değişken yok. region/locale ile çağır.
      const cfb = await cseFallback({ q: q0, group: g, region: reg0, locale: loc0, limit });
      const cItems = Array.isArray(cfb?.items) ? cfb.items : [];
      attemptedStrategies.push("google_cse_seeds");
      if (diagCombined) diagCombined.google_cse = cfb?.diag;
      if (cItems.length > 0) {
        finalItems = cItems;
        strategyUsed = "google_cse_seeds";
      }
    } catch (e) {
      attemptedStrategies.push("google_cse_seeds");
      if (diagCombined) {
        diagCombined.google_cse = {
          provider: "google_cse",
          enabled: GOOGLE_CSE_ENABLED,
          error: String(e?.message || e),
        };
      }
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
  };

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
