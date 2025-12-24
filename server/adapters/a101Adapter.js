// server/adapters/a101Adapter.js
// ============================================================================
// A101 — S200 FINAL ADAPTER (STANDARDIZED + HARDENED)
// - ZERO DELETE: export isimleri korunur, sadece güçlendirme
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url zorunlu; price<=0 => null
// - NO RANDOM ID: stableIdS200(providerKey,url,title) (Math_random yasak)
// - Observable fail: import/fetch/timeout/crash => ok:false + items:[]
// - URL priority: affiliateUrl > url (normalizeItemS200)
// - withTimeout: her provider call
// - Kit log ctx: globalThis.__S200_ADAPTER_CTX set (unknown bitir)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE (legacy ref)
import {
buildImageVariants } from "../utils/imageFixer.js";

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {



  loadCheerioS200,
  withTimeout,
  TimeoutError,
  normalizeItemS200,
  stableIdS200,
  fixKey,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// S200: deterministic request/trace ids (NO RANDOM)
// ---------------------------------------------------------------------------
let __s200_seq = 0;
const __s200_next = () => {
  __s200_seq = (__s200_seq + 1) % 1000000000;
  return __s200_seq;
};
// --------------------------------------------------
const BASE = "https://www.a101.com.tr";
const PROVIDER_KEY = "a101";

function safe(v) {
  return v ? String(v).trim() : "";
}

function resolveProviderFamily(options = {}, fallback = "market") {
  const hint = fixKey(
    options.providerFamily || options.family || options.group || options.vertical || ""
  );
  return hint || fallback;
}

function setGlobalCtx(providerKey, url, at) {
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: providerKey || "unknown",
      providerKey: providerKey || "unknown",
      provider: providerKey || "unknown",
      url: safe(url || ""),
      at: at || "server/adapters/a101Adapter.js",
    };
  } catch {}
}

function s200Fail({ providerKey, providerFamily, query, region, url, stage, code, err, options }) {
  return {
    ok: false,
    items: [],
    count: 0,
    source: providerKey || "unknown",
    _meta: {
      providerKey,
      providerFamily,
      query: safe(query),
      region: safe(region || "TR"),
      url: safe(url),
      stage: safe(stage),
      code: safe(code) || "FAIL",
      error: safe(err?.message || err),
      timeoutMs:
        Number(options?.timeoutMs || options?.fetchTimeoutMs || options?.timeout || 0) || undefined,
    },
  };
}

function buildUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return BASE + href;
}

function fixRawImage(img) {
  if (!img) return null;
  if (img.startsWith("//")) return "https:" + img;
  return img;
}

// ZERO DELETE: isim kalsın, ama artık RANDOM YOK
function buildStableId(href, title) {
  return stableIdS200(PROVIDER_KEY, href || "", title || "");
}

function parsePrice(txt) {
  const n = sanitizePrice(txt, { provider: "a101", category: "product" });
  return Number.isFinite(n) ? n : null;
}

async function fetchHTMLWithProxy(url, axiosCfg = {}) {
  // direct first, then proxy fallback
  try {
    const resp = await axios.get(url, axiosCfg);
    return resp?.data ?? "";
  } catch (e1) {
    try {
      return await proxyFetchHTML(url);
    } catch (e2) {
      // keep best error surface
      throw e1?.message ? e1 : e2;
    }
  }
}

async function scrapeA101Page(query, page = 1, options = {}) {
  const providerFamily = resolveProviderFamily(options, "market");
  const region = options.region || "TR";

  const q = encodeURIComponent(String(query || ""));
  const url = `${BASE}/list/?search_text=${q}&page=${page}`;

  setGlobalCtx(PROVIDER_KEY, url, `server/adapters/a101Adapter.js:scrape(page=${page})`);

  const fetchTimeoutMs = Math.max(
    1000,
    Number(options.fetchTimeoutMs || options.timeoutMs || options.timeout || 12000)
  );

  const axiosCfg = {
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: Math.min(20000, fetchTimeoutMs + 1500),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36 (FindAllEasy-S200)",
      "Accept-Language": "tr-TR,en;q=0.9",
      Referer: BASE + "/",
    },
  };

  // withTimeout LOCK
  const html = await withTimeout(fetchHTMLWithProxy(url, axiosCfg), fetchTimeoutMs, "a101:fetch");

  const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url, log: options.log });
  const items = [];

  const nodes = $(
    ".product-list .product-card, \
     .product-card-wrapper, \
     li.product-card, \
     .products li, \
     .products .card"
  );

  nodes.each((i, el) => {
    const n = $(el);

    const title =
      safe(n.find(".product-title").text()) ||
      safe(n.find(".name").text()) ||
      safe(n.find("h3").text());

    if (!title) return;

    // baseline junk filters
    const lower = title.toLowerCase();
    if (
      lower.includes("kampanya") ||
      lower.includes("kupon") ||
      lower.includes("indirim") ||
      lower.includes("ödül") ||
      lower.includes("hediye")
    ) {
      return;
    }

    // PRICE
    const rawPriceTxt =
      safe(n.find(".current-price").text()) ||
      safe(n.find(".price").text()) ||
      safe(n.find(".amount").text());

    const price = parsePrice(rawPriceTxt);

    // URL
    let href =
      safe(n.find("a").attr("href")) ||
      safe(n.find(".product-card a").attr("href")) ||
      safe(n.find("a.product-card").attr("href"));

    href = buildUrl(href);
    if (!href) return;

    // IMAGE
    let imgRaw =
      safe(n.find("img").attr("src")) ||
      safe(n.find("img").attr("data-src"));

    imgRaw = fixRawImage(imgRaw);
    const variants = buildImageVariants(imgRaw, "a101");

    const id = buildStableId(href, title);

    let affiliateUrl = null;
    try {
      affiliateUrl = buildAffiliateUrl({ url: href, provider: PROVIDER_KEY }, { source: "adapter" });
    } catch {
      affiliateUrl = null;
    }

    // RAW ITEM
    const rawItem = {
      id,
      title,
      price: price ?? null,
      rating: null,
      url: href,
      affiliateUrl: affiliateUrl || null,
      provider: providerFamily, // provider = family (S200 canonical)
      currency: "TRY",
      region,
      category: "product",
      image: variants?.image || null,
      imageOriginal: variants?.imageOriginal || null,
      imageLarge: variants?.imageLarge || null,
      imageMedium: variants?.imageMedium || null,
      imageSmall: variants?.imageSmall || null,
      raw: {
        source: "a101",
        page,
      },
    };

    const normalized = normalizeItemS200(rawItem, PROVIDER_KEY, {
      providerFamily,
      baseUrl: BASE,
      region,
      currency: "TRY",
      at: "server/adapters/a101Adapter.js",
    });

    if (normalized && normalized.title && normalized.url) items.push(normalized);
  });

  return items;
}

// --------------------------------------------------
// S200 MAIN EXPORT (NO FAKE)
// --------------------------------------------------
export async function searchA101Adapter(query, regionOrOptions = "TR") {
  const startedAt = Date.now();

  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  const providerFamily = resolveProviderFamily(options, "market");

  // RATE LIMITER — observable fail (empty[] değil)
  const limiterKey = `s200:adapter:a101:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 20,
    windowMs: 60000,
    burst: true,
  });

  if (!allowed) {
    return s200Fail({
      providerFamily,
      query,
      region,
      url: BASE,
      stage: "rate_limit",
      code: "RATE_LIMIT",
      err: "rate_limited",
      options,
    });
  }

  if (!query || String(query).trim().length < 2) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: PROVIDER_KEY,
      _meta: {
        providerFamily,
        region,
        query: safe(query),
        code: "EMPTY_QUERY",
        tookMs: Date.now() - startedAt,
      },
    };
  }

  const q = String(query || "").trim();

  const pageErrors = [];
  let all = [];
  let pagesOk = 0;

  // multi-page (up to 3)
  for (let p = 1; p <= 3; p++) {
    try {
      const part = await scrapeA101Page(q, p, { ...options, region });
      pagesOk++;
      if (!part.length) break;

      all = all.concat(part);
      if (all.length >= 80) break;
    } catch (e) {
      const isTimeout =
        e instanceof TimeoutError ||
        String(e?.message || e).toLowerCase().includes("timeout");
      pageErrors.push({
        page: p,
        code: isTimeout ? "TIMEOUT" : "FETCH_PARSE_FAIL",
        error: safe(e?.message || e),
      });

      // ilk sayfa da patladıysa: observable fail
      if (p === 1 && !all.length) {
        return s200Fail({
          providerFamily,
          query: q,
          region,
          url: `${BASE}/list/?search_text=${encodeURIComponent(q)}&page=${p}`,
          stage: "page_1",
          code: isTimeout ? "TIMEOUT" : "FETCH_PARSE_FAIL",
          err: e,
          options,
        });
      }

      // diğer sayfa patlarsa: partial ok (items varsa)
      break;
    }
  }

  all = all.slice(0, 150);

  return {
    ok: true,
    items: all,
    count: all.length,
    source: PROVIDER_KEY,
    _meta: {
      providerFamily,
      region,
      query: q,
      pagesOk,
      partial: Boolean(pageErrors.length),
      pageErrors: pageErrors.length ? pageErrors : undefined,
      tookMs: Date.now() - startedAt,
    },
  };
}

export const searchA101 = searchA101Adapter;
export default { searchA101, searchA101Adapter };
