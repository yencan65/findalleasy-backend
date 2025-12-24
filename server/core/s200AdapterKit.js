// server/core/s200AdapterKit.js
// ============================================================================
// S200 ADAPTER KIT — SINGLE SOURCE OF TRUTH
// - makeSafeImport(callerMetaUrl): caller-relative safe import (+ optional dev stubs)
// - withTimeout(taskOrPromise, ms, label?): hard timeout (TimeoutError)
// - normalizeItemS200: contract lock (title+url mandatory, price<=0 => null, url priority)
// - coerceItemsS200: array/object/items coercion (supports common shapes)
// - ensureHtmlStringS200 + loadCheerioS200: cheerio.load() input guard (ZERO-CRASH)
// ============================================================================

import * as cheerio from "cheerio";
import crypto from "crypto";

export const S200_KIT_VERSION = "1.1.1";

// ----------------------------
// tiny utils
// ----------------------------
export function safeStr(v, maxLen = 800) {
  try {
    let s = String(v ?? "").trim();
    if (!s || /^(undefined|null)$/i.test(s)) return "";
    if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
    return s;
  } catch {
    return "";
  }
}

export function fixKey(v) {
  const s = String(v ?? "").toLowerCase().trim();
  if (!s) return "";
  return s
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function nonEmptyTitleS200(v, fallback = "") {
  const t = String(v ?? "").trim();
  if (t && !/^(undefined|null)$/i.test(t)) return t;
  const fb = String(fallback ?? "").trim();
  return fb || "";
}

export function isBadUrlS200(u) {
  const s = String(u ?? "").trim();
  if (!s) return true;
  if (s === "#" || s === "/#" || s === "#/" || s === "/") return true;
  const low = s.toLowerCase();
  if (low.startsWith("javascript:")) return true;
  if (low.startsWith("data:")) return true;
  return false;
}

// URL normalize: absolute + // + relative (/... or "p/123" or "?q=1") with baseUrl
export function normalizeUrlS200(candidate, baseUrl = "") {
  let u = String(candidate ?? "").trim();
  const b = String(baseUrl ?? "").trim();

  if (isBadUrlS200(u)) u = "";

  // protocol-relative
  if (u && u.startsWith("//")) u = "https:" + u;

  // already absolute
  if (u && /^https?:\/\//i.test(u)) {
    return isBadUrlS200(u) ? "" : u;
  }

  // relative → absolute
  if (u && b && /^https?:\/\//i.test(b)) {
    try {
      u = new URL(u, b).href;
    } catch {
      const bb = b.replace(/\/+$/g, "");
      if (u.startsWith("/")) u = bb + u;
      else u = bb + "/" + u.replace(/^\/+/g, "");
    }
  } else if (u && u.startsWith("/")) {
    // base missing → leave empty; do NOT fabricate domain
    u = "";
  }

  if (isBadUrlS200(u)) u = "";

  // fallback: normalized url or baseUrl or empty
  return u || (isBadUrlS200(b) ? "" : b) || "";
}

// ----------------------------
// price
// ----------------------------
export function normalizePriceS200(value) {
  if (value == null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  try {
    let s = String(value).trim();
    if (!s) return null;

    s = s
      .replace(/(₺|TRY|TL|USD|EUR|GBP|₤|€|\$)/gi, "")
      .replace(/\s+/g, "")
      .replace(/[^\d.,-]/g, "");

    s = s.replace(/^-+/, "");
    if (!s) return null;

    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");
      if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasComma) {
      const parts = s.split(",");
      if (parts[1] && parts[1].length === 2) s = s.replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasDot) {
      const parts = s.split(".");
      if (!parts[1] || parts[1].length !== 2) s = s.replace(/\./g, "");
    }

    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * ✅ Backward-compat exports (ZERO-DELETE)
 * - parsePriceS200 / parsePrice
 */
export function parsePriceS200(value) {
  return normalizePriceS200(value);
}
export function parsePrice(value) {
  return normalizePriceS200(value);
}

export function priceOrNullS200(v) {
  return normalizePriceS200(v);
}

// ----------------------------
// coercion (stronger)
// ----------------------------
export function coerceItemsS200(out) {
  if (Array.isArray(out)) return out;
  if (!out || typeof out !== "object") return [];

  if (Array.isArray(out.items)) return out.items;
  if (Array.isArray(out.results)) return out.results;
  if (Array.isArray(out.data)) return out.data;
  if (Array.isArray(out?.data?.items)) return out.data.items;
  if (Array.isArray(out?.data?.results)) return out.data.results;

  if (out.ok === false) return [];
  return [out];
}

// ----------------------------
// stable id
// ----------------------------
export function stableIdS200(providerKey, url, title) {
  const pk = fixKey(providerKey) || "s200";
  const base = `${pk}|${String(url || "")}|${String(title || "")}`;
  try {
    return pk + "_" + crypto.createHash("sha256").update(base).digest("hex").slice(0, 18);
  } catch {
    // deterministic djb2 fallback (NO random)
    let h = 5381;
    for (let i = 0; i < base.length; i++) h = ((h << 5) + h) ^ base.charCodeAt(i);
    return pk + "_" + (h >>> 0).toString(16).slice(0, 18);
  }
}

// ----------------------------
// url priority (commission-safe)
// ----------------------------
export function pickUrlPriorityS200(item) {
  if (!item || typeof item !== "object") return "";
  return (
    item.affiliateUrl ??
    item.deeplink ??
    item.deepLink ??
    item.finalUrl ??
    item.originUrl ??
    item.url ??
    item.link ??
    item.href ??
    item.website ??
    item.raw?.affiliateUrl ??
    item.raw?.deeplink ??
    item.raw?.deepLink ??
    item.raw?.finalUrl ??
    item.raw?.originUrl ??
    item.raw?.url ??
    item.raw?.link ??
    item.raw?.href ??
    ""
  );
}

// ✅ Backward/forward compatible alias
export function pickUrlS200(item) {
  return pickUrlPriorityS200(item);
}

// ----------------------------
// normalize core item
// ----------------------------

// primary URL normalizer for item.url: DO NOT fall back to baseUrl
function _normalizePrimaryUrlS200(candidate, baseUrl = "") {
  const c = String(candidate ?? "").trim();
  if (isBadUrlS200(c)) return "";
  const u = normalizeUrlS200(c, baseUrl);
  // normalizeUrlS200 may fallback to baseUrl; for primary URL we refuse that.
  if (u && baseUrl && u === String(baseUrl).trim()) return "";
  return u || "";
}

function _toOriginSlash(u) {
  try {
    const U = new URL(String(u || ""));
    return U.origin.replace(/\/+$/g, "") + "/";
  } catch {
    return "";
  }
}

function _deriveBaseUrlS200(item, opts = {}, urlCandidate = "") {
  const picks = [
    opts.baseUrl,
    opts.fallbackUrl,
    item?.baseUrl,
    item?.siteUrl,
    item?.origin,
    item?.raw?.baseUrl,
    item?.raw?.siteUrl,
    item?.raw?.origin,
    item?.raw?.originUrl,
  ];

  for (const p of picks) {
    const s = String(p ?? "").trim();
    if (/^https?:\/\//i.test(s) && !isBadUrlS200(s)) {
      const o = _toOriginSlash(s);
      if (o) return o;
      return s.replace(/\/+$/g, "") + "/";
    }
  }

  // derive from any absolute candidate (safe, no fabrication)
  const candAbs = String(urlCandidate ?? "").trim();
  if (/^https?:\/\//i.test(candAbs)) {
    const o = _toOriginSlash(candAbs);
    if (o) return o;
  }

  const itemAbs = String(item?.url ?? "").trim();
  if (/^https?:\/\//i.test(itemAbs)) {
    const o = _toOriginSlash(itemAbs);
    if (o) return o;
  }

  return "";
}

export function normalizeItemS200(item, providerKey, opts = {}) {
  if (!item) return null;

  const vertical = String(opts.vertical || item.vertical || item.category || "").trim() || "general";
  const category = String(opts.category || item.category || vertical).trim() || vertical;

  let providerKeyNorm =
    fixKey(providerKey || item.providerKey || item.provider || "unknown") || "unknown";

  let providerFamily =
    fixKey(opts.providerFamily || providerKeyNorm.split("_")[0] || providerKeyNorm) ||
    providerKeyNorm;

  // --- S200 PROVIDER HARDENING (ZERO-DRIFT) ---
  try {
    const bad = (v) => {
      const s = String(v || "").trim().toLowerCase();
      return !s || s === "unknown" || s === "unknown_adapter" || s === "na" || s === "n/a";
    };

    if (bad(providerKeyNorm) || bad(providerFamily)) {
      const cand =
        item.providerKey ||
        item.provider ||
        item.source ||
        item._meta?.provider ||
        item._meta?.key ||
        item._meta?.adapterName ||
        item.raw?.provider ||
        item.raw?.providerType ||
        "";

      const fixed = typeof fixKey === "function" ? fixKey(cand) : String(cand || "").trim();
      if (!bad(fixed)) {
        providerKeyNorm = fixed;
        providerFamily = fixKey(opts.providerFamily || fixed.split("_")[0] || fixed) || fixed;
      }
    }

    if (bad(providerKeyNorm)) providerKeyNorm = "unknown";
    if (bad(providerFamily)) providerFamily = providerKeyNorm;
  } catch {
    // asla crash etme
  }

  const urlCandidate = pickUrlPriorityS200(item);

  // ✅ Base URL only from explicit opts or real absolute candidates (NO domain fabrication)
  const baseUrl = _deriveBaseUrlS200(item, opts, urlCandidate);

  const url = _normalizePrimaryUrlS200(urlCandidate, baseUrl);

  // “fake baseUrl” ile çöp geçişi engelle (candidate yoksa asla baseUrl'a düşme)
  if (opts.requireRealUrlCandidate && !url && !item.fallback) return null;

  const title = nonEmptyTitleS200(
    item.title ?? item.name ?? item.raw?.title ?? item.raw?.name,
    opts.titleFallback || `${providerFamily} sonucu`
  );

  // ✅ S200 HARD RULE: title + url
  if (!title) return null;
  if (!url || isBadUrlS200(url)) return null;

  // price picking
  const keys = Array.isArray(opts.priceKeys) ? opts.priceKeys : [];
  const standard = [
    "optimizedPrice",
    "finalPrice",
    "price",
    "amount",
    "rate",
    "minPrice",
    "maxPrice",
    "totalPrice",
    "total_price",
  ];
  const allKeys = [...new Set([...standard, ...keys])];

  let price = null;
  for (const k of allKeys) {
    const v = item?.[k] ?? item?.raw?.[k] ?? null;
    const n = priceOrNullS200(v);
    if (n) {
      price = n;
      break;
    }
  }

  const currency = String(opts.currency || item.currency || item.raw?.currency || "TRY")
    .toUpperCase()
    .trim()
    .slice(0, 3);

  const region = String(opts.region || item.region || "TR").toUpperCase().trim();

  const rating =
    typeof item.rating === "number" && Number.isFinite(item.rating)
      ? item.rating
      : typeof item.score === "number" && Number.isFinite(item.score)
        ? item.score
        : null;

  const reviewCountRaw =
    item.reviewCount ??
    item.reviews ??
    item.userRatingsTotal ??
    item.raw?.reviewCount ??
    null;

  const reviewCount =
    typeof reviewCountRaw === "number" && Number.isFinite(reviewCountRaw)
      ? Math.max(0, Math.floor(reviewCountRaw))
      : 0;

  const imageCandidate =
    item.image ||
    item.thumbnail ||
    item.photo ||
    (Array.isArray(item.images) ? item.images[0] : "") ||
    item.raw?.image ||
    "";

  let image = "";
  if (imageCandidate) {
    const n = normalizeUrlS200(imageCandidate, baseUrl);
    // normalizeUrlS200 may fall back to baseUrl; reject that for images
    if (n && (!baseUrl || n !== baseUrl)) image = n;
  }

  const deeplink =
    normalizeUrlS200(item.deeplink || item.deepLink || item.finalUrl || url, baseUrl) || url;

  const affiliateUrl = !isBadUrlS200(item.affiliateUrl)
    ? normalizeUrlS200(item.affiliateUrl, baseUrl) || null
    : null;

  return {
    id: item.id || item.listingId || stableIdS200(providerKeyNorm, url, title),

    title,
    url,

    price,
    finalPrice: price,
    optimizedPrice: price,
    currency,

    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,

    vertical,
    category,

    region,

    rating,
    reviewCount,

    image,

    deeplink,
    affiliateUrl,

    fallback: Boolean(item.fallback),
    raw: item.raw || item._raw || item,
  };
}

// ----------------------------
// timeout
// ----------------------------
export class TimeoutError extends Error {
  constructor(message = "Timeout") {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout(taskOrPromise, ms, label = "task") {
  const t = Math.max(0, Number(ms || 0));
  if (!t) {
    try {
      if (typeof taskOrPromise === "function") return Promise.resolve().then(() => taskOrPromise());
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve(taskOrPromise);
  }

  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out (${t}ms)`));
    }, t);
  });

  const p = (() => {
    try {
      return typeof taskOrPromise === "function"
        ? Promise.resolve().then(() => taskOrPromise())
        : Promise.resolve(taskOrPromise);
    } catch (e) {
      return Promise.reject(e);
    }
  })();

  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ----------------------------
// safe import (caller-relative)
// ----------------------------
function guessProviderKeyFromPath(modulePath) {
  const s = String(modulePath || "");
  const last = s.split(/[\\/]/g).pop() || s;
  return (
    fixKey(last.replace(/\.js$/i, "").replace(/adapter$/i, "").replace(/Adapter$/i, "")) ||
    "unknown"
  );
}

function pickFnFromObj(obj) {
  if (!obj) return null;
  if (typeof obj === "function") return obj;
  if (typeof obj !== "object") return null;

  const keys = Object.keys(obj);

  for (const k of keys) {
    if (typeof obj[k] === "function" && /^search/i.test(k)) return obj[k];
  }
  for (const k of keys) {
    if (typeof obj[k] === "function") return obj[k];
  }
  return null;
}

export function makeSafeImport(callerMetaUrl, options = {}) {
  const allowStubs = Boolean(options.allowStubs);
  const stubFactory = typeof options.stubFactory === "function" ? options.stubFactory : null;
  const defaultFn =
    typeof options.defaultFn === "function"
      ? options.defaultFn
      : async () => {
          const arr = [];
          arr.ok = false;
          arr._meta = { notImplemented: true, reason: "SAFE_IMPORT_DEFAULT" };
          return arr;
        };

  return async function safeImport(modulePath, exportName = null) {
    try {
      const href =
        String(modulePath || "").startsWith("file:") || String(modulePath || "").startsWith("http")
          ? String(modulePath)
          : new URL(String(modulePath || ""), callerMetaUrl).href;

      const mod = await import(href);

      if (exportName) {
        if (typeof mod?.[exportName] === "function") return mod[exportName];
        if (mod?.default && typeof mod.default?.[exportName] === "function")
          return mod.default[exportName];

        const named = pickFnFromObj(mod?.[exportName]) || pickFnFromObj(mod?.default?.[exportName]);
        if (named) return named;
      }

      const f0 = pickFnFromObj(mod?.default);
      if (f0) return f0;

      const f1 = pickFnFromObj(mod);
      if (f1) return f1;

      return defaultFn;
    } catch (err) {
      const providerGuess = guessProviderKeyFromPath(modulePath);
      console.warn(`⚠️ S200 safeImport failed: ${modulePath}`, err?.message || err);

      if (allowStubs && stubFactory) return stubFactory(providerGuess);

      // Observable fail (NO FAKE): missing module/export => ok:false + meta
      return async (...args) => {
        try {
          const out = await defaultFn(...args);
          if (Array.isArray(out)) {
            out.ok = false;
            out._meta = {
              ...(out._meta || {}),
              error: "SAFE_IMPORT_FAIL",
              providerKey: providerGuess,
              modulePath,
            };
          }
          return out;
        } catch {
          const arr = [];
          arr.ok = false;
          arr._meta = { error: "SAFE_IMPORT_FAIL", providerKey: providerGuess, modulePath };
          return arr;
        }
      };
    }
  };

}

// ============================================================================
// S200 — HTML GUARANTEE + SAFE CHEERIO LOADER (ZERO-DELETE ADD-ON)
// Fixes: "cheerio.load() expects a string" (undefined / axios resp obj / JSON / Buffer)
// ============================================================================

function _s200BriefType(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  try {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return `Buffer(${v.length})`;
  } catch {}
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
  if (ArrayBuffer.isView(v)) return `View(${v.byteLength})`;
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function _s200SafeStr(v, max = 200) {
  try {
    const s = String(v ?? "");
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return "";
  }
}

function _s200StackHint() {
  try {
    const st = String(new Error().stack || "");
    const lines = st.split("\n").slice(1);
    for (const line of lines) {
      const low = String(line || "").toLowerCase();
      if (!low) continue;
      if (low.includes("s200adapterkit")) continue;
      if (!(low.includes("server/adapters") || low.includes("server\\adapters"))) continue;

      const mm = line.match(/\(([^)]+)\)/) || line.match(/at\s+([^\s]+)/);
      const loc = mm && mm[1] ? String(mm[1]) : "";
      if (!loc) continue;

      const clean = loc.replace(/:\d+:\d+$/, "");
      const norm = clean.replace(/\\/g, "/").replace(/^file:\/\//, "");
      const idx = norm.toLowerCase().lastIndexOf("/server/");
      const tail = idx >= 0 ? norm.slice(idx + 1) : norm;
      return tail.length > 160 ? tail.slice(-160) : tail;
    }
  } catch {}
  return "";
}

// ✅ WARN DEDUP (smoke test log spam stopper)
const __S200_WARN_CACHE = new Map(); // key -> lastSeenMs
function _s200WarnOnce(key, ttlMs = 60_000, maxSize = 400) {
  try {
    const now = Date.now();
    const last = __S200_WARN_CACHE.get(key);
    if (last && now - last < ttlMs) return false;
    __S200_WARN_CACHE.set(key, now);

    if (__S200_WARN_CACHE.size > maxSize) {
      const entries = Array.from(__S200_WARN_CACHE.entries()).sort((a, b) => a[1] - b[1]);
      const drop = Math.max(50, Math.floor(maxSize * 0.2));
      for (let i = 0; i < drop && i < entries.length; i++) __S200_WARN_CACHE.delete(entries[i][0]);
    }
    return true;
  } catch {
    return true; // fail-open
  }
}

// ✅ NULL/UNDEFINED log'u default kapalı (grep temiz). Açmak istersen: set S200_WARN_NULL=1
const __S200_WARN_NULL = String(process.env.S200_WARN_NULL || "") === "1";

// ✅ Adapter name inference from `at` (when ctx.adapter is missing)
function _inferAdapterFromAt(at) {
  const raw = String(at || "").trim();
  if (!raw) return "";
  const file = raw.split(/[\\/]/).pop() || "";
  if (!file) return "";
  const base = file.replace(/\.(mjs|cjs|js)$/i, "").replace(/adapter$/i, "");
  if (!base) return "";

  let s = base
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/__+/g, "_")
    .toLowerCase();

  s = s.replace(/^medical_park/, "medicalpark");
  s = s.replace(/^cicek_sepeti/, "ciceksepeti");
  s = s.replace(/^hepsi_burada/, "hepsiburada");
  s = s.replace(/^trendy_ol/, "trendyol");

  try {
    return fixKey(s);
  } catch {
    return s.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  }
}

// ✅ GLOBAL CTX FALLBACK (adapter adı/url kit’e globalden akar)
function _s200Ctx(ctx = {}) {
  const g = globalThis.__S200_ADAPTER_CTX || {};

  const pick = (...vals) => {
    for (const v of vals) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return "";
  };

  const meta =
    ctx && typeof ctx === "object" && ctx.meta && typeof ctx.meta === "object" ? ctx.meta : null;
  const _meta =
    ctx && typeof ctx === "object" && ctx._meta && typeof ctx._meta === "object" ? ctx._meta : null;

  const atRaw = pick(
    ctx.at,
    ctx.stackAt,
    ctx.file,
    meta && (meta.at || meta.stackAt || meta.file),
    _meta && (_meta.at || _meta.stackAt || _meta.file),
    g.at,
    g.stackAt,
    g.file
  );

  const adapterRaw = pick(
    ctx.adapter,
    ctx.adapterName,
    ctx.providerKey,
    ctx.provider,
    ctx.source,
    meta && (meta.adapter || meta.adapterName || meta.providerKey || meta.provider || meta.source),
    _meta && (_meta.adapter || _meta.adapterName || _meta.providerKey || _meta.provider || _meta.source),
    g.adapter,
    g.provider,
    g.providerKey,
    atRaw && _inferAdapterFromAt(atRaw)
  );

  const urlRaw = pick(
    ctx.url,
    ctx.requestUrl,
    ctx.pageUrl,
    meta && (meta.url || meta.requestUrl || meta.pageUrl),
    _meta && (_meta.url || _meta.requestUrl || _meta.pageUrl),
    g.url
  );

  const logRaw =
    ctx && typeof ctx === "object" && "log" in ctx
      ? ctx.log
      : meta && typeof meta === "object" && "log" in meta
        ? meta.log
        : _meta && typeof _meta === "object" && "log" in _meta
          ? _meta.log
          : g && typeof g === "object" && "log" in g
            ? g.log
            : undefined;

  let adapter = fixKey(adapterRaw) || "unknown";

  if (adapter === "unknown" && atRaw) {
    const inferred = _inferAdapterFromAt(atRaw);
    if (inferred) adapter = inferred;
  }

  if (adapter === "unknown" && urlRaw) {
    const hostGuess = String(urlRaw || "").toLowerCase();
    if (hostGuess.includes("sahibinden.")) adapter = "sahibinden";
    else if (hostGuess.includes("arabam.")) adapter = "arabam";
    else if (hostGuess.includes("vavacars.")) adapter = "vavacars";
    else if (hostGuess.includes("letgo.")) adapter = "letgo";
    else if (hostGuess.includes("trendyol.")) adapter = "trendyol";
    else if (hostGuess.includes("hepsiburada.")) adapter = "hepsiburada";
    else if (hostGuess.includes("ciceksepeti.")) adapter = "ciceksepeti";
    else if (hostGuess.includes("medicalpark.")) adapter = "medicalpark";
    else if (hostGuess.includes("memorial.")) adapter = "memorial";
    else if (hostGuess.includes("livhospital.")) adapter = "liv";
    else if (hostGuess.includes("acibadem.")) adapter = "acibadem";
    else if (hostGuess.includes("n11.")) adapter = "n11";
    else if (hostGuess.includes("amazon.")) adapter = "amazon";
    else if (hostGuess.includes("cimri.")) adapter = "cimri";
    else if (hostGuess.includes("akakce.")) adapter = "akakce";
    else if (hostGuess.includes("getir.")) adapter = "getir";
    else if (hostGuess.includes("koctas.")) adapter = "koctas";
    else if (hostGuess.includes("migros.")) adapter = "migros";
    else if (hostGuess.includes("bim.")) adapter = "bim";
    else if (hostGuess.includes("yolcu360.")) adapter = "yolcu360";
  }

  return {
    adapter: String(adapter || "unknown").slice(0, 80),
    url: String(urlRaw || "").slice(0, 500),
    at: String(atRaw || "").slice(0, 220),
    log: logRaw,
  };
}

/**
 * ensureHtmlStringS200(valueOrAxiosResponse, ctx?)
 * - Accepts: string | Buffer | ArrayBuffer | Uint8Array | axios response | anything
 * - Returns: guaranteed string ("" on failure) — ZERO-CRASH
 */
export function ensureHtmlStringS200(input, ctx = {}) {
  // ✅ NULL/UNDEFINED: default sessiz (log sadece S200_WARN_NULL=1 iken)
  if (input == null) {
    if (__S200_WARN_NULL) {
      const C = _s200Ctx(ctx);
      const adapter = C?.adapter || "unknown";
      const urlStr = _s200SafeStr(C?.url || "", 320);
      const atStr = _s200SafeStr(C?.at || _s200StackHint(), 220);

      const t = input === null ? "null" : "undefined";
      const warnKey = `${adapter}|${t}|${urlStr}|${atStr}`;

      if (C?.log !== false && _s200WarnOnce(warnKey, 60_000)) {
        console.warn(
          `⚠️ [S200][${adapter}] HTML not string -> coerced to "" | type=${t}` +
            (urlStr ? ` | url=${urlStr}` : "") +
            (atStr ? ` | at=${atStr}` : "")
        );
      }
    }
    return "";
  }

  if (typeof input === "string") return input;

  // Buffer → utf8
  try {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) return input.toString("utf8");
  } catch {}

  // ArrayBuffer / TypedArray
  try {
    if (input instanceof ArrayBuffer) return Buffer.from(input).toString("utf8");
    if (ArrayBuffer.isView(input) && input?.buffer) return Buffer.from(input.buffer).toString("utf8");
  } catch {}

  // Axios-like response { data: ... } (string / buffer / arraybuffer)
  try {
    if (input && typeof input === "object" && "data" in input) {
      const d = input.data;

      if (typeof d === "string") return d;

      try {
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(d)) return d.toString("utf8");
      } catch {}

      try {
        if (d instanceof ArrayBuffer) return Buffer.from(d).toString("utf8");
        if (ArrayBuffer.isView(d) && d?.buffer) return Buffer.from(d.buffer).toString("utf8");
      } catch {}
    }
  } catch {}

  // Common wrappers { html: "..." }
  try {
    if (input && typeof input === "object" && typeof input.html === "string") return input.html;
  } catch {}

  const C = _s200Ctx(ctx);

  let adapter = C?.adapter || "unknown";
  const adapterBefore = adapter;

  const urlStr = _s200SafeStr(C?.url || "", 320);

  let atStr = _s200SafeStr(ctx?.at || ctx?.meta?.at || ctx?._meta?.at || C?.at || "", 220);
  if (!atStr) atStr = _s200SafeStr(_s200StackHint(), 220);

  if ((adapter === "unknown" || !adapter) && atStr) {
    const inferred = _inferAdapterFromAt(atStr);
    if (inferred) adapter = inferred;
  }

  const t = _s200BriefType(input);
  let hint = "";
  try {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      hint = Object.keys(input).slice(0, 12).join(",");
    }
  } catch {}

  const warnKey = `${adapter}|${t}|${urlStr}|${atStr}`;
  const showAt = Boolean(atStr && (adapterBefore === "unknown" || !urlStr));
  const showUrl = Boolean(urlStr);

  if (C?.log !== false && _s200WarnOnce(warnKey, 60_000)) {
    console.warn(
      `⚠️ [S200][${adapter}] HTML not string -> coerced to "" | type=${t}` +
        (hint ? ` | keys=${hint}` : "") +
        (showUrl ? ` | url=${urlStr}` : "") +
        (showAt ? ` | at=${atStr}` : "")
    );
  }

  return "";
}

/**
 * loadCheerioS200(input, options?, ctx?)
 * - Drop-in replacement for cheerio.load(...) but safer.
 * - Supports either:
 *   loadCheerioS200(input, { xmlMode: true }, { adapter, url })
 *   loadCheerioS200(input, { adapter, url })            // ctx-only
 */
export function loadCheerioS200(input, optionsOrCtx = {}, maybeCtx = null) {
  let options = undefined;
  let ctx = {};

  const looksLikeCheerioOptions =
    optionsOrCtx &&
    typeof optionsOrCtx === "object" &&
    ("xmlMode" in optionsOrCtx ||
      "decodeEntities" in optionsOrCtx ||
      "lowerCaseTags" in optionsOrCtx ||
      "lowerCaseAttributeNames" in optionsOrCtx ||
      "recognizeSelfClosing" in optionsOrCtx);

  if (maybeCtx && typeof maybeCtx === "object") {
    options = optionsOrCtx && typeof optionsOrCtx === "object" ? optionsOrCtx : undefined;
    ctx = maybeCtx;
  } else if (looksLikeCheerioOptions) {
    options = optionsOrCtx;
    ctx = {};
  } else {
    options = undefined;
    ctx = optionsOrCtx && typeof optionsOrCtx === "object" ? optionsOrCtx : {};
  }

  // ctx normalize (global fallback dahil)
  ctx = _s200Ctx(ctx);

  const html = ensureHtmlStringS200(input, ctx);

  try {
    return cheerio.load(html || "", options);
  } catch (e) {
    if (ctx?.log !== false) {
      console.warn(
        `⚠️ [S200][${_s200SafeStr(ctx.adapter || "unknown", 60)}] cheerio.load crash -> empty fallback:`,
        e?.message || e
      );
    }
    return cheerio.load("", options);
  }
}

// ============================================================================
// ============================================================================
// S200 STUB DETECTION — NO FAKE IN STRICT MODE (ADDITIVE)
// - Strict mode: FINDALLEASY_ALLOW_STUBS=0 (default) => stub items are dropped.
// - Dev mode:     FINDALLEASY_ALLOW_STUBS=1 => stub items can pass through.
// ============================================================================
export function isStubItemS200(it = {}, opts = {}) {
  const title = String(it?.title || "").toLowerCase();
  const desc = String(it?.description || it?.desc || "").toLowerCase();

  const adapter = String(
    it?.adapterName ||
      it?.adapter ||
      it?.providerKey ||
      it?.raw?.providerKey ||
      it?.raw?.provider ||
      it?.adapterSource ||
      ""
  ).toLowerCase();

  const url = String(
    it?.affiliateUrl ||
      it?.deeplink ||
      it?.finalUrl ||
      it?.originUrl ||
      it?.url ||
      ""
  ).toLowerCase();

  // Explicit flags (some placeholder builders mark this)
  if (it?.stub === true || it?._meta?.stub === true) return true;

  // Hard textual patterns — these are almost always "navigation / search" placeholders
  const hard = [
    "üzerinde ara",
    "üzerinden ara",
    "aramak için",
    "burada ara",
    "search for",
    "search on",
    "here to search",
    "click to search",
    "event bulunamadı",
    "etkinlik bulunamadı",
    "sonuç bulunamadı",
    "sonuc bulunamadı",
    "no results found",
    "0 results",
  ];
  if (hard.some((p) => title.includes(p) || desc.includes(p))) return true;

  // "provider — ... ara:" pattern (garenta — araç kiralama üzerinde ara: ...)
  if ((title.includes("—") || title.includes("-")) && title.includes("ara:")) return true;

  // Placeholder / stub adapter fingerprints
  if (
    adapter.includes("_placeholder") ||
    adapter.includes("placeholder") ||
    adapter.includes("stub")
  ) return true;

  // Failure-as-item style titles (keep conservative: only if URL looks empty/bad)
  if (title.includes("erişilemedi") || title.includes("ulaşılamadı") || title.includes("hata") || title.includes("bulunamad") || title.includes("sonuç yok") || title.includes("sonuc yok") || title.includes("no results") || title.includes("not found")) {
    if (!url || url === "#" || url.startsWith("about:")) return true;
  }

  // Maps-search "fallback" cards (conservative)
  if (url.includes("google.com/maps") && (title.includes("ara") || desc.includes("ara"))) return true;

  return false;
}

export function filterStubItemsS200(items = [], opts = {}) {
  const arr = Array.isArray(items) ? items : [];
  const allowStubs =
    String(opts?.allowStubs ?? process.env.FINDALLEASY_ALLOW_STUBS ?? "0") === "1";
  if (allowStubs) return arr;
  return arr.filter((it) => !isStubItemS200(it, opts));
}

// S200 RESILIENCE KIT EXPORTS (COOLDOWN + COVERAGE FLOOR) — ADDITIVE
// ============================================================================
export {
  isProviderCoolingDownS200,
  reportProviderStatusS200,
  reportProviderErrorS200,
  noteProviderSuccessS200,
  runWithCooldownS200,
  ensureCoverageFloorS200,
} from "./s200ResilienceKit.js";
