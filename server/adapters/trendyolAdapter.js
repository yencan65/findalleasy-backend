// server/adapters/trendyolAdapter.js
// ======================================================================
// Trendyol Adapter — S21 → S40 → S100 → S200 FINAL (HARDENED)
// ZERO DELETE: scraping/mantık korunur, sadece S200 wrapper + kit-lock eklenir.
// Mutlak S200:
// - Output: { ok, items, count, source, _meta }
// - title+url required; price<=0 => null (normalizeItemS200)
// - NO FAKE in PROD: stub/mock/fallback yasak (FINDALLEASY_ALLOW_STUBS=1 ile DEV)
// - Observable fail: timeout/fetch/parse => ok:false + items:[] + _meta.error/code
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - withTimeout everywhere; S200 ctx set
// ======================================================================

import * as cheerio from "cheerio"; // ZERO DELETE (legacy)
import { httpGet } from "../utils/httpClient.js";
import { proxyFetchHTML } from "../core/proxyEngine.js";

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
  fixKey,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = fixKey("trendyol");
const PROVIDER_FAMILY = "trendyol";
const BASE = "https://www.trendyol.com";

const MAX_PAGES = 3; // ZERO DELETE (same semantic)
const MAX_ITEMS = 80;
const DEFAULT_TIMEOUT_MS = 7500;

const ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePriceLoose(txt) {
  if (!txt) return null;

  const cleaned = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: legacy id helper (artık ana id üretimi stableIdS200)
function stableId(href, title) {
  try {
    return "trendyol_" + Buffer.from(href || title).toString("base64");
  } catch {
    return href || title;
  }
}

function mkS200(ok, items, meta = {}, extra = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    _meta: { ...meta },
    ...extra,
  };

  // Migration safety: allow `for..of res` to iterate items
  try {
    Object.defineProperty(res, Symbol.iterator, {
      enumerable: false,
      value: function* () {
        yield* res.items;
      },
    });
    Object.defineProperty(res, "length", {
      enumerable: false,
      get: () => res.items.length,
    });
  } catch {}

  return res;
}

function mkFail(code, err, meta = {}, extra = {}) {
  const msg = safeStr(err?.message || err || code);
  return mkS200(false, [], { ...meta, code, error: msg }, { ...extra, error: code });
}

// ------------------------------------------------------------
// ÇÖP ÜRÜN FİLTRESİ (ZERO DELETE → Senin filtre korunuyor)
// ------------------------------------------------------------
function isGarbage(fullTitle, brand) {
  const t = safe(fullTitle).toLowerCase();
  const b = safe(brand).toLowerCase();

  const bannedWords = [
    "tamir",
    "onarım",
    "onarim",
    "servis",
    "ekran değişimi",
    "ekran degisimi",
    "batarya",
    "kamera",
    "parça",
    "parca",
    "montaj",
    "sökme",
    "sokme",
  ];

  const bannedBrands = [
    "cep teknik",
    "gsm iletişim",
    "gsm iletisim",
    "cep iletisim",
    "telefoncu",
    "teknik store",
  ];

  return bannedWords.some((w) => t.includes(w)) || bannedBrands.some((w) => b.includes(w));
}

// ------------------------------------------------------------
// S200 NORMALIZE-COMPATIBLE ITEM BUILDER (kept, hardened)
// ------------------------------------------------------------
function buildTrendyolItem(meta) {
  let {
    idCandidate,
    title,
    brand,
    href,
    priceRaw,
    priceText,
    imgRaw,
    rating,
    region = "TR",
  } = meta;

  let url = safe(href);
  if (url && !url.startsWith("http")) {
    url = BASE + url;
  }

  // -------- PRICE --------
  const price = sanitizePrice(priceRaw, {
    provider: PROVIDER_KEY,
    category: "product",
  });

  // -------- IMAGE FIX --------
  if (imgRaw && String(imgRaw).startsWith("//")) imgRaw = "https:" + imgRaw;
  const imgs = buildImageVariants(imgRaw || null, PROVIDER_KEY);

  // -------- DEEPLINK / AFFILIATE --------
  let deeplink = null;
  try {
    deeplink = url ? buildAffiliateUrlS10({ url, provider: PROVIDER_KEY }) : null;
  } catch {
    deeplink = url || null;
  }

  // -------- BASE ITEM (pre-normalize) --------
  const item = {
    id: stableIdS200(PROVIDER_KEY, deeplink || url || idCandidate, title),
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    source: PROVIDER_KEY,

    category: "product",
    vertical: "product",
    region: String(region).toUpperCase(),
    currency: "TRY",

    title,
    price,
    rating: rating ?? null,

    url,
    originUrl: url,
    deeplink,
    affiliateUrl: deeplink,

    image: imgs.image,
    imageOriginal: imgs.imageOriginal,
    imageProxy: imgs.imageProxy,
    hasProxy: imgs.hasProxy,

    raw: {
      idCandidate,
      title,
      brand,
      href: url,
      priceRaw,
      priceText,
      imgRaw,
      rating,
    },
  };

  // -------- PRICE OPTIMIZER (zero-crash) --------
  try {
    return optimizePrice(item, {
      provider: PROVIDER_KEY,
      category: "product",
      region: item.region,
    });
  } catch {
    return item;
  }
}

// ------------------------------------------------------------
// S200 SAFE HTML FETCH (direct -> proxy)
// ------------------------------------------------------------
async function fetchTrendyolHTML(url, signal) {
  // 1) Ana HTTP client
  const direct = await httpGet(url, {
    adapterName: PROVIDER_KEY,
    timeoutMs: 9000,
    retries: 1,
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (FindAllEasy-S200) Chrome/123 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9",
      "Cache-Control": "no-cache",
    },
  });

  if (direct?.ok && direct?.data) return { ok: true, html: direct.data, via: "direct" };

  // 2) Proxy fallback
  try {
    const html = await proxyFetchHTML(url);
    return { ok: true, html: html || "", via: "proxy", warn: safeStr(direct?.error || "direct_failed") };
  } catch (e) {
    return { ok: false, html: "", via: "fail", error: safeStr(e?.message || e || "proxy_failed") };
  }
}

// ------------------------------------------------------------
// SCRAPE SINGLE PAGE (returns raw items array; exported wrapper uses it)
// ------------------------------------------------------------
async function scrapeTrendyolPageRaw(query, page = 1, opts = {}) {
  const { signal, region = "TR" } = opts;

  const url = `${BASE}/sr?q=${encodeURIComponent(query)}&pi=${page}`;

  const fetched = await fetchTrendyolHTML(url, signal);
  if (!fetched.ok || !fetched.html) return { ok: false, items: [], via: fetched.via, error: fetched.error, warn: fetched.warn, url };

  const $ = loadCheerioS200(fetched.html, { adapter: PROVIDER_KEY, url });
  const out = [];

  const nodes = $(
    "div.p-card-wrppr, \
     div.product-card, \
     article[data-testid='product-card'], \
     div[data-id][data-prd-id]"
  );

  nodes.each((_, el) => {
    const node = $(el);

    const brand =
      safe(node.find(".prdct-desc-cntnr-ttl").text()) ||
      safe(node.find(".product-brand").text());

    const name =
      safe(node.find(".prdct-desc-cntnr-name").text()) ||
      safe(node.find(".product-name").text());

    const title = [brand, name].filter(Boolean).join(" ").trim();
    if (!title) return;
    if (isGarbage(title, brand)) return;

    // ------- PRICE COLLECTOR --------
    let priceText =
      safe(node.find(".prc-box-dscntd").text()) ||
      safe(node.find(".prc-box-sllng").text()) ||
      safe(node.find(".prc-box-orgnl").text()) ||
      safe(node.find(".price").text()) ||
      safe(node.find("[data-testid='price-current-price']").text()) ||
      safe(node.find("[class*='price']").first().text());

    if (!priceText) {
      const priceAttr =
        safe(node.find("[itemprop='price']").attr("content")) ||
        safe(node.find("meta[itemprop='price']").attr("content")) ||
        safe(node.attr("data-price")) ||
        safe(node.find("[data-price]").attr("data-price"));

      if (priceAttr) priceText = priceAttr;
    }

    const priceRaw = parsePriceLoose(priceText);
    if (priceRaw == null) return;

    // ------- URL / IMAGE --------
    let href =
      node.find("a").attr("href") ||
      node.find("a[href*='/urun/']").attr("href");
    if (!href) return;

    let img =
      node.find("img").attr("data-src") ||
      node.find("img").attr("src") ||
      node.find("img").attr("data-original");

    // ------- RATING --------
    const ratingTxt = safe(node.find("[class*='ratingScore'], [data-testid='rating-score']").text());
    const rVal = Number(String(ratingTxt).replace(",", "."));
    const rating = Number.isFinite(rVal) ? rVal : null;

    // ------- ID --------
    const idAttr =
      safe(node.attr("data-id")) ||
      safe(node.attr("data-prd-id")) ||
      href;

    out.push(
      buildTrendyolItem({
        idCandidate: idAttr,
        title,
        brand,
        href,
        priceRaw,
        priceText,
        imgRaw: img,
        rating,
        region,
      })
    );
  });

  return { ok: true, items: out, via: fetched.via, warn: fetched.warn, url };
}

// ------------------------------------------------------------
// MULTI PAGE RUNNER — S200 WRAPPER
// ------------------------------------------------------------
export async function searchTrendyolScrape(query, opts = {}) {
  const t0 = Date.now();
  const region = typeof opts === "string" ? opts : opts?.region || "TR";
  const options = typeof opts === "object" && opts ? opts : { region };
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const q = safe(query);
  if (!q) return mkFail("EMPTY_QUERY", "empty_query", { region, ms: 0 });

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, query: q, region };

  try {
    const res = await withTimeout(
      (async () => {
        let all = [];
        const seen = new Set();

        let lastVia = "direct";
        let lastWarn = null;

        for (let p = 1; p <= MAX_PAGES; p++) {
          const part = await scrapeTrendyolPageRaw(q, p, { ...options, region });
          if (!part.ok) {
            // if first page fails, observable fail; otherwise partial success is fine
            if (p === 1) {
              return mkFail("FETCH_FAIL", part.error || "fetch_failed", {
                region: String(region).toUpperCase(),
                page: p,
                url: part.url,
                via: part.via,
                warn: part.warn || null,
                ms: Date.now() - t0,
              });
            }
            break;
          }

          lastVia = part.via;
          lastWarn = part.warn || null;

          const items = coerceItemsS200(part.items);
          if (!items.length) break;

          for (const it of items) {
            const k = it?.url || it?.id;
            if (!k) continue;
            if (seen.has(k)) continue;
            seen.add(k);

            const n = normalizeItemS200(it, PROVIDER_KEY, {
              providerFamily: PROVIDER_FAMILY,
              baseUrl: BASE,
              currency: "TRY",
              region: String(region).toUpperCase(),
              category: "product",
              vertical: "product",
            });

            if (!n) continue;
            all.push(n);
            if (all.length >= MAX_ITEMS) break;
          }

          if (all.length >= MAX_ITEMS) break;
        }

        return mkS200(true, all, {
          region: String(region).toUpperCase(),
          via: lastVia,
          warn: lastWarn,
          ms: Date.now() - t0,
        });
      })(),
      timeoutMs,
      PROVIDER_KEY
    );

    return res;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return mkFail(isTimeout ? "TIMEOUT" : "ERROR", e, {
      region: String(region).toUpperCase(),
      timeout: isTimeout,
      ms: Date.now() - t0,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ------------------------------------------------------------
// FINAL EXPORT — adapterEngine bunu çağırır
// ------------------------------------------------------------
export async function searchTrendyolAdapter(query, opts = {}) {
  // S200: always wrapper
  return searchTrendyolScrape(query, opts);
}

export const searchTrendyol = searchTrendyolAdapter;

export default {
  searchTrendyol,
  searchTrendyolScrape,
  searchTrendyolAdapter,
};
