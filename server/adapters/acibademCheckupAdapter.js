// ======================================================================
// Acıbadem Check-Up Paketleri — S200 FINAL (STANDARDIZED + HARDENED)
// ZERO DELETE • ZERO DRIFT • S200 OUTPUT (LOCKED)
// Output: { ok, items, count, source, _meta }
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO-DELETE

import { buildAffiliateUrl } from "./affiliateEngine.js";     // ZERO-DELETE (unused)
import { buildImageVariants } from "../utils/imageFixer.js";  // ZERO-DELETE (unused)
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";   // ZERO-DELETE
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  normalizeItemS200,
  stableIdS200,
  fixKey,
} from "../core/s200AdapterKit.js";

// keep references so code is not tree-shaken (ZERO DELETE)
const __keep_aff = buildAffiliateUrl;
const __keep_var = buildImageVariants;
const __keep_san = sanitizePrice;
const __keep_cheerio = cheerio;

const PROVIDER_KEY = "acibadem_checkup";
const PROVIDER_FAMILY = "checkup";
const BASE = "https://www.acibadem.com.tr";

function safe(v) {
  return v ? String(v).trim() : "";
}

function setGlobalCtx(providerKey, url, at) {
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: providerKey || "unknown",
      providerKey: providerKey || "unknown",
      provider: providerKey || "unknown",
      url: safe(url || ""),
      at: at || "server/adapters/acibademCheckupAdapter.js",
    };
  } catch {}
}

function s200Fail({ query, region, url, stage, code, err, options }) {
  return {
    ok: false,
    items: [],
    count: 0,
    source: PROVIDER_KEY,
    _meta: {
      providerFamily: PROVIDER_FAMILY,
      query: safe(query),
      region: safe(region || "TR"),
      url: safe(url),
      stage: safe(stage),
      code: safe(code) || "FAIL",
      error: safe(err?.message || err),
      timeoutMs: Number(options?.timeoutMs || options?.fetchTimeoutMs || options?.timeout || 0) || undefined,
    },
  };
}

function buildUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return BASE + href;
}

function rawId(url, title) {
  return stableIdS200(PROVIDER_KEY, url || "", title || "");
}

function parsePriceRaw(txt) {
  const n = sanitizePrice(txt, { provider: "acibadem", category: "checkup" });
  return Number.isFinite(n) ? n : null;
}

async function fetchHTMLWithProxy(url, axiosCfg = {}) {
  try {
    const resp = await axios.get(url, axiosCfg);
    return resp?.data ?? "";
  } catch (e1) {
    try {
      return await proxyFetchHTML(url);
    } catch (e2) {
      throw e1?.message ? e1 : e2;
    }
  }
}

// ----------------------------------------------------------------------
// MAIN SEARCH
// ----------------------------------------------------------------------
export async function searchAcibademCheckup(query, regionOrOptions = "TR") {
  const startedAt = Date.now();

  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  // rate limiter (observable fail)
  const limiterKey = `s200:adapter:${PROVIDER_KEY}:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 14,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });

  if (!allowed) {
    return s200Fail({
      query,
      region,
      url: BASE,
      stage: "rate_limit",
      code: "RATE_LIMIT",
      err: "rate_limited",
      options,
    });
  }

  const q = safe(query);
  if (!q || q.length < 2) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: PROVIDER_KEY,
      _meta: {
        providerFamily: PROVIDER_FAMILY,
        region,
        query: q,
        code: "EMPTY_QUERY",
        tookMs: Date.now() - startedAt,
      },
    };
  }

  const url = `${BASE}/arama/?q=${encodeURIComponent(q)}&type=checkup`;
  setGlobalCtx(PROVIDER_KEY, url, "server/adapters/acibademCheckupAdapter.js:search");

  const fetchTimeoutMs = Math.max(
    1200,
    Number(options.fetchTimeoutMs || options.timeoutMs || options.timeout || 12000)
  );

  const axiosCfg = {
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: Math.min(20000, fetchTimeoutMs + 1500),
    headers: {
      "User-Agent": "Mozilla/5.0 Chrome (FindAllEasy-S200)",
      "Accept-Language": "tr-TR,en;q=0.9",
    },
  };

  let html = "";
  try {
    html = await withTimeout(fetchHTMLWithProxy(url, axiosCfg), fetchTimeoutMs, "acibadem_checkup:fetch");
  } catch (e) {
    const isTimeout =
      e instanceof TimeoutError || String(e?.message || e).toLowerCase().includes("timeout");
    return s200Fail({
      query: q,
      region,
      url,
      stage: "fetch",
      code: isTimeout ? "TIMEOUT" : "FETCH_FAIL",
      err: e,
      options,
    });
  }

  const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url, log: options.log });

  const out = [];
  const parseErrors = [];

  // JSON-ish blocks (site değişirse bozulabilir, o yüzden try/catch)
  try {
    const jsonMatch = html.match(/window\.__CHECKUP__\s*=\s*(\{[\s\S]*?\});/);
    if (jsonMatch && jsonMatch[1]) {
      const js = JSON.parse(jsonMatch[1]);
      if (Array.isArray(js.packages)) {
        js.packages.forEach((p) => {
          const title = safe(p?.title || p?.name);
          const href = buildUrl(safe(p?.url || p?.link));
          if (!title || !href) return;

          const price = parsePriceRaw(p?.priceText || p?.price || "");
          const img = safe(p?.image || p?.img) || null;

          const rawItem = {
            id: rawId(href, title),
            title,
            price: price ?? null,
            url: href,
            provider: PROVIDER_FAMILY,
            currency: "TRY",
            region,
            category: "checkup",
            image: img,
            raw: {
              source: "acibadem_checkup_json",
              pkgId: safe(p?.id),
            },
          };

          const normalized = normalizeItemS200(rawItem, PROVIDER_KEY, {
            providerFamily: PROVIDER_FAMILY,
            baseUrl: BASE,
            region,
            currency: "TRY",
            at: "server/adapters/acibademCheckupAdapter.js",
          });

          if (normalized?.title && normalized?.url) out.push(normalized);
        });
      }
    }
  } catch (e) {
    parseErrors.push({ stage: "json", error: safe(e?.message || e) });
  }

  // DOM fallback
  if (!out.length) {
    try {
      $(".checkup-card, .package-card, .product-card, article, li")
        .each((_, el) => {
          const w = $(el);

          const title = safe(w.find("h3").text()) || safe(w.find(".title").text());
          if (!title) return;

          const priceText = safe(w.find(".price").text()) || safe(w.find(".amount").text());
          const price = parsePriceRaw(priceText);

          const href = buildUrl(safe(w.find("a").attr("href")));
          if (!href) return;

          const imgRaw = safe(w.find("img").attr("src"));

          const rawItem = {
            id: rawId(href, title),
            title,
            price: price ?? null,
            url: href,
            provider: PROVIDER_FAMILY,
            currency: "TRY",
            region,
            category: "checkup",
            image: imgRaw || null,
            raw: {
              source: "acibadem_checkup_dom",
              html: w.html()?.slice(0, 500),
              extractedAt: new Date().toISOString(),
            },
          };

          const normalized = normalizeItemS200(rawItem, PROVIDER_KEY, {
            providerFamily: PROVIDER_FAMILY,
            baseUrl: BASE,
            region,
            currency: "TRY",
            at: "server/adapters/acibademCheckupAdapter.js",
          });

          if (normalized?.title && normalized?.url) out.push(normalized);
        });
    } catch (e) {
      parseErrors.push({ stage: "dom", error: safe(e?.message || e) });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const it of out) {
    const k = safe(it?.id) || rawId(it?.url, it?.title);
    if (k && !seen.has(k)) {
      seen.add(k);
      unique.push(it);
    }
  }

  // item yok + parse error => observable fail
  if (!unique.length && parseErrors.length) {
    return s200Fail({
      query: q,
      region,
      url,
      stage: "parse",
      code: "PARSE_FAIL",
      err: JSON.stringify(parseErrors),
      options,
    });
  }

  const items = unique.slice(0, 120);

  return {
    ok: true,
    items,
    count: items.length,
    source: PROVIDER_KEY,
    _meta: {
      providerFamily: PROVIDER_FAMILY,
      region,
      query: q,
      partial: Boolean(parseErrors.length),
      parseErrors: parseErrors.length ? parseErrors : undefined,
      tookMs: Date.now() - startedAt,
    },
  };
}

// ======================================================================
export const searchAcibademCheckupScrape = searchAcibademCheckup;
export const searchAcibademCheckupAdapter = searchAcibademCheckup;

export default { searchAcibademCheckup };

console.log("🏥 Acıbadem Checkup Adapter — S200 FINAL (standardized) loaded.");
