// server/core/s200Fallback.js
// ============================================================================
// S200 FALLBACK + DIAGNOSTICS HELPERS — ZERO DELETE
// - Primary S200 empty/deadline -> fallback to SerpApi (google_shopping)
// - Adds minimal, safe meta flags for reviewers and debugging
// ============================================================================

import crypto from "crypto";

// Var olan serpapi servisini kullanıyoruz (senin projende bu dosya zaten vardı)
import { serpSearch } from "../services/serpapi.js";

// Var olan cacheEngine (vitrine tarafında kullanıyordun)
import { getCachedResult, setCachedResult } from "./cacheEngine.js";

const FALLBACK_ENABLE = String(process.env.FINDALLEASY_FALLBACK_ENABLE ?? "1") !== "0";
const FALLBACK_TIMEOUT_MS = Number(process.env.FINDALLEASY_FALLBACK_TIMEOUT_MS ?? 5200);
const FALLBACK_CACHE_TTL_MS = Number(process.env.FINDALLEASY_FALLBACK_CACHE_TTL_MS ?? 10 * 60 * 1000);
const FALLBACK_CACHE_TTL_SEC = Math.max(1, Math.round(FALLBACK_CACHE_TTL_MS / 1000));

// SerpApi: ENV’de key yoksa fallback çalışamaz (bilerek)
const SERPAPI_ENABLED = !!process.env.SERPAPI_KEY;

// Diagnostics exposure: prod’da herkese açık diag istemiyoruz.
export function shouldExposeDiagnostics(req) {
  const diagQuery = String(req?.query?.diag ?? "") === "1";
  const tokenHeader = String(req?.headers?.["x-fae-diag"] ?? "");
  const tokenEnv = String(process.env.FAE_DIAG_TOKEN ?? "");
  const isProd = String(process.env.NODE_ENV ?? "").toLowerCase() === "production";

  // Prod: token şart. Non-prod: ?diag=1 yeter.
  if (isProd) return tokenEnv && tokenHeader && tokenHeader === tokenEnv;
  return diagQuery || (tokenEnv && tokenHeader === tokenEnv);
}

function sha1_16(input) {
  return crypto.createHash("sha1").update(String(input || "")).digest("hex").slice(0, 16);
}

function normQ(q) {
  const s = String(q ?? "").trim();
  return s.length ? s : "";
}

function parseCurrencyFromPriceString(priceStr) {
  const s = String(priceStr || "");
  if (s.includes("₺")) return "TRY";
  if (s.includes("€")) return "EUR";
  if (s.includes("$")) return "USD";
  if (s.toLowerCase().includes("gbp") || s.includes("£")) return "GBP";
  return "TRY"; // TR default (gl=tr)
}

function parseExtractedPrice(item) {
  if (typeof item?.extracted_price === "number" && Number.isFinite(item.extracted_price)) {
    return item.extracted_price;
  }
  // price string -> number (best-effort)
  const s = String(item?.price || "").replace(/\s/g, "");
  // örn: "₺12.999,00" / "12.999₺"
  const cleaned = s
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "") // binlik noktaları sil
    .replace(",", "."); // virgül -> nokta
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function mapSerpItemToS200(raw, { locale = "tr", region = "TR" } = {}) {
  const originUrl = raw?.link || raw?.product_link || raw?.link_href || "";
  const id = `disc_${sha1_16(originUrl || raw?.title || JSON.stringify(raw).slice(0, 200))}`;

  const priceNum = parseExtractedPrice(raw);
  const currency = parseCurrencyFromPriceString(raw?.price);

  return {
    // S200 minimal item schema (senin sistemde alanlar daha zengin olabilir; eklemeye açık)
    id,
    title: String(raw?.title || raw?.name || "Ürün"),
    price: priceNum ?? null,
    finalPrice: priceNum ?? null,
    currency,
    image: raw?.thumbnail || raw?.thumbnail_url || raw?.image || null,
    provider: "serpapi",
    providerKey: "discovery_serpapi",
    region,
    locale,
    originUrl: originUrl || null,
    finalUrl: originUrl || null,
    url: originUrl || null,
    ratingValue: raw?.rating ?? null,
    reviewCount: raw?.reviews ?? null,

    // Debug için ham data (prod’da diag kapalıysa zaten dönmeyecek)
    _raw: raw,
  };
}

async function serpFallbackSearch({ q, limit = 10, region = "TR", locale = "tr" }) {
  if (!SERPAPI_ENABLED) {
    return { items: [], diag: { provider: "serpapi", enabled: false, reason: "SERPAPI_KEY_MISSING" } };
  }

  const gl = region?.toLowerCase?.() === "tr" ? "tr" : "tr";
  const hl = locale?.toLowerCase?.().startsWith("tr") ? "tr" : "tr";

  const cacheKey = `S200_FALLBACK_SERP:${gl}:${hl}:${normQ(q)}:${limit}`;
  const cached = await getCachedResult(cacheKey).catch(() => null);
  if (cached?.ok && Array.isArray(cached?.items)) {
    return {
      items: cached.items,
      diag: { provider: "serpapi", enabled: true, cached: true, count: cached.items.length },
    };
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("FALLBACK_TIMEOUT")), FALLBACK_TIMEOUT_MS);

  const t0 = Date.now();
  try {
    const data = await serpSearch({ q, engine: "google_shopping", gl, hl, signal: ac.signal });
    const rawList = Array.isArray(data?.shopping_results) ? data.shopping_results : [];
    const sliced = rawList.slice(0, Math.max(1, Number(limit) || 10));
    const items = sliced.map((r) => mapSerpItemToS200(r, { region, locale }));

    // cache (best-effort)
        const cacheItems = items.map(({ _raw, ...rest }) => rest);
    await setCachedResult(cacheKey, { ok: true, items: cacheItems }, FALLBACK_CACHE_TTL_SEC).catch(() => null);

    return {
      items,
      diag: {
        provider: "serpapi",
        enabled: true,
        cached: false,
        ms: Date.now() - t0,
        rawCount: rawList.length,
        count: items.length,
      },
    };
  } catch (err) {
    const e = err?.name === "AbortError" ? "ABORT" : (err?.message || "ERROR").slice(0, 120);
    return {
      items: [],
      diag: { provider: "serpapi", enabled: true, error: e, ms: Date.now() - t0 },
    };
  } finally {
    clearTimeout(t);
  }
}

export async function applyS200FallbackIfEmpty({
  req,
  result,
  q,
  group = "product",
  region = "TR",
  locale = "tr",
  limit = 10,
  reason = "EMPTY_PRIMARY",
}) {
  if (!FALLBACK_ENABLE) return result;

  const qq = normQ(q);
  if (qq.length < 2) return result;

  const itemsArr =
    Array.isArray(result?.items) ? result.items :
    Array.isArray(result?.results) ? result.results :
    [];

  if (itemsArr.length > 0) return result; // primary zaten dolu

  const fb = await serpFallbackSearch({ q: qq, limit, region, locale });

  const exposeDiag = shouldExposeDiagnostics(req);

  // meta alanlarını güçlendir (ZERO-DELETE: sadece ekliyoruz)
  const meta = result?._meta && typeof result._meta === "object" ? result._meta : {};
  const next = { ...result, _meta: meta };

  const fbItems = (Array.isArray(fb.items) ? fb.items : []).map((it) => {
    if (exposeDiag) return it;
    const { _raw, ...rest } = it || {};
    return rest;
  });

  next._meta.fallback = {
    used: fbItems.length > 0,
    strategy: "serpapi_google_shopping",
    reason,
    serpapiEnabled: SERPAPI_ENABLED,
    count: fbItems.length,
    diag: fb.diag,
  };

  if (fbItems.length === 0) {
    // boş kaldıysa yine boş dön; ama artık “neden” meta’da var.
    return next;
  }

  // Fallback ürünleri “asıl result” gibi koyuyoruz (reviewer ürünü görsün)
  next.items = fbItems;
  next.results = fbItems;
  next.count = fbItems.length;
  next.total = fbItems.length;
  next.hasMore = false;
  next.nextOffset = 0;

  // ok flag: primary ok:true bile olsa aynı; ama primary ok:false ise fallback ile true yapmak tartışmalı.
  // Burada mevcut ok değerini koruyoruz; sadece ürünleri sağlıyoruz.
  // İstersen ok:true zorlayabilirsin ama ben “dürüst meta” tarafındayım.

  return next;
}
