// server/core/s200Fallback.js
// ============================================================================
// S200 FALLBACK — reviewer-bandaj + diag gate
// - applyS200FallbackIfEmpty: product empty ise serpapi/google_shopping fallback
// - shouldExposeDiagnostics: prod'da token, dev'de serbest (veya header ile)
// ============================================================================

import { serpSearch } from "../services/serpapi.js";

const SERPAPI_ENABLED = !!(
  process.env.SERPAPI_KEY ||
  process.env.SERPAPI_API_KEY ||
  process.env.SERP_API_KEY
);

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
    _raw: obj,
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

  try {
    const r = await serpSearch({ q, engine: "google_shopping", gl, hl });
    const arr =
      Array.isArray(r?.shopping_results) ? r.shopping_results : Array.isArray(r?.results) ? r.results : [];

    const items = arr.map(normalizeSerpItem).filter((x) => x?.title && x?.url);
    return {
      items: items.slice(0, Math.max(1, Math.min(50, Number(limit) || 8))),
      diag: { ...diag, ms: Date.now() - t0, count: items.length },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e);
    return {
      items: [],
      diag: { ...diag, error: msg, ms: Date.now() - t0 },
    };
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
