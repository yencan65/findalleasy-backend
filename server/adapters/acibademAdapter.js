// ============================================================
//  Acıbadem Health Adapter — S200 FINAL (STANDARDIZED + HARDENED)
//  ZERO-DELETE • ZERO-DRIFT • S200 OUTPUT (LOCKED)
//  Output: { ok, items, count, source, _meta }
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO-DELETE (legacy ref)

import { buildImageVariants } from "../utils/imageFixer.js";      // ZERO-DELETE
import { buildAffiliateUrl } from "./affiliateEngine.js";         // ZERO-DELETE (affiliate yok)
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { optimizePrice } from "../utils/priceFixer.js";            // ZERO-DELETE
import { sanitizePrice } from "../utils/priceSanitizer.js";        // ZERO-DELETE
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  normalizeItemS200,
  stableIdS200,
  fixKey,
} from "../core/s200AdapterKit.js";

// keep refs (tree-shake olmasın)
const __keep_cheerio = cheerio;
const __keep_vars = buildImageVariants;
const __keep_aff = buildAffiliateUrl;
const __keep_opt = optimizePrice;
const __keep_san = sanitizePrice;

const PROVIDER_KEY = "acibadem";
const PROVIDER_FAMILY = "health";
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
      at: at || "server/adapters/acibademAdapter.js",
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

function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, url || "", title || "");
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

// ------------------------------------------------------------
// MAIN SEARCH
// ------------------------------------------------------------
export async function searchAcibadem(query, regionOrOptions = "TR") {
  const startedAt = Date.now();

  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  // rate limit (observable fail)
  const limiterKey = `s200:adapter:${PROVIDER_KEY}:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 18,
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

  const url = `${BASE}/arama/?q=${encodeURIComponent(q)}`;
  setGlobalCtx(PROVIDER_KEY, url, "server/adapters/acibademAdapter.js:searchAcibadem");

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
    html = await withTimeout(fetchHTMLWithProxy(url, axiosCfg), fetchTimeoutMs, "acibadem:fetch");
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

  // ============================================================
  // 1) JSON SCRAPER (RAW MODE) — prefer
  // ============================================================
  try {
    const m = html.match(/window\.__ACIBADEM_SEARCH__\s*=\s*(\{[\s\S]*?\});/);
    if (m && m[1]) {
      const js = JSON.parse(m[1]);
      const blocks = []
        .concat(js?.doctors || [])
        .concat(js?.hospitals || [])
        .concat(js?.services || []);

      for (const it of blocks) {
        const title = safe(it?.title || it?.name);
        const href = safe(it?.url || it?.link);
        const fullUrl = href ? (href.startsWith("http") ? href : BASE + href) : "";
        if (!title || !fullUrl) continue;

        const rawItem = {
          id: stableId(fullUrl, title),
          title,
          url: fullUrl,
          price: null, // discovery-like => price yok
          provider: PROVIDER_FAMILY,
          region,
          currency: "TRY",
          category: "health",
          image: safe(it?.image || it?.img) || null,
          raw: {
            source: "acibadem_json",
            type: safe(it?.type || ""),
          },
        };

        const normalized = normalizeItemS200(rawItem, PROVIDER_KEY, {
          providerFamily: PROVIDER_FAMILY,
          baseUrl: BASE,
          region,
          currency: "TRY",
          at: "server/adapters/acibademAdapter.js",
        });

        if (normalized?.title && normalized?.url) out.push(normalized);
      }
    }
  } catch (e) {
    parseErrors.push({ stage: "json", error: safe(e?.message || e) });
  }

  // ============================================================
  // 2) DOM fallback (RAW MODE)
  // ============================================================
  if (!out.length) {
    try {
      const nodes = $(".search-result-item, .result-item, .search-item, article, li");
      nodes.each((i, el) => {
        const w = $(el);

        const title =
          safe(w.find("h3").text()) ||
          safe(w.find("h2").text()) ||
          safe(w.find("a").first().text());

        if (!title) return;

        let href = safe(w.find("a").attr("href"));
        if (!href) return;

        if (!href.startsWith("http")) href = BASE + href;

        const imgRaw = safe(w.find("img").attr("src"));

        const rawItem = {
          id: stableId(href, title),
          title,
          url: href,
          price: null,
          provider: PROVIDER_FAMILY,
          region,
          currency: "TRY",
          category: "health",
          image: imgRaw || null,
          raw: {
            source: "acibadem_dom",
          },
        };

        const normalized = normalizeItemS200(rawItem, PROVIDER_KEY, {
          providerFamily: PROVIDER_FAMILY,
          baseUrl: BASE,
          region,
          currency: "TRY",
          at: "server/adapters/acibademAdapter.js",
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
    const k = safe(it?.id) || stableId(it?.url, it?.title);
    if (k && !seen.has(k)) {
      seen.add(k);
      unique.push(it);
    }
  }

  // Eğer hem json hem dom fail ve hiç item yoksa: observable fail
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

  return {
    ok: true,
    items: unique.slice(0, 60),
    count: Math.min(unique.length, 60),
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

// ------------------------------------------------------------
// Config / aliases (ZERO DELETE)
// ------------------------------------------------------------
export const acibademAdapterConfig = {
  name: "acibadem",
  family: PROVIDER_FAMILY,
  provider: PROVIDER_KEY,
  priority: 1.4,
  category: "health",
};

export const searchAcibademScrape = searchAcibadem;
export const searchAcibademAdapter = searchAcibadem;

export default {
  searchAcibadem,
  acibademAdapterConfig,
};

console.log("🏥 Acıbadem Adapter — S200 FINAL (standardized) loaded.");
