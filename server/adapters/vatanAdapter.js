// server/adapters/vatanAdapter.js
// ======================================================================
// VATAN — S200 FINAL (OBSERVABLE, DRIFT-SAFE, KIT-LOCKED)
// - NOT_IMPLEMENTED => ok:false + _meta.notImplemented
// - fetch fail => ok:false (sessiz ok:true empty yok)
// - normalizeItemS200 + stableIdS200 + URL priority
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

// Proxy
import { proxyFetchHTML } from "../core/proxyEngine.js";

// S21 fiyat motoru
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

// Görsel motoru
import { buildImageVariants } from "../utils/imageFixer.js";

// Affiliate motoru
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "vatan";
const PROVIDER_FAMILY = "vatan";
const BASE = "https://www.vatanbilgisayar.com";
const DEFAULT_TIMEOUT_MS = 6500;

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: legacy stable id helper
function buildStableId(href, title) {
  try {
    if (href) return "vatan_" + Buffer.from(href).toString("base64");
    return "vatan_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

function _now() {
  return Date.now();
}

function _mkS200(ok, items, meta = {}, extra = {}) {
  const arr = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    adapterKey: PROVIDER_KEY,
    _meta: { ...meta },
    ...extra,
  };
}

function _errStr(e) {
  return safeStr(e?.message || e || "error");
}

async function fetchHTMLWithProxyS200(url, config) {
  try {
    const direct = await axios.get(url, config);
    return { ok: true, html: direct?.data || "", via: "direct" };
  } catch (err) {
    try {
      const proxied = await proxyFetchHTML(url);
      return { ok: true, html: proxied || "", via: "proxy", warn: _errStr(err) };
    } catch (e) {
      return { ok: false, html: "", via: "fail", error: _errStr(e), warn: _errStr(err) };
    }
  }
}

// ======================================================================
// 🔥 NORMALIZER — legacy fonksiyon adı korunur ama artık kit’e bağlı
// ======================================================================
function normalizeVatanS200(item, region = "TR") {
  const n = normalizeItemS200(
    {
      ...(item || {}),
      providerKey: PROVIDER_KEY,
      provider: PROVIDER_FAMILY,
      vertical: "product",
      category: (item?.category || "product"),
      region: String(region || item?.region || "TR").toUpperCase(),
      currency: item?.currency || "TRY",
    },
    PROVIDER_KEY,
    {
      providerFamily: PROVIDER_FAMILY,
      baseUrl: BASE,
      currency: "TRY",
      region: String(region || item?.region || "TR").toUpperCase(),
      category: (item?.category || "product"),
      vertical: "product",
    }
  );

  return n;
}

function _normalizeItems(rawItems, region = "TR") {
  const arr = coerceItemsS200(rawItems);
  const out = [];
  for (const it of arr) {
    const n = normalizeVatanS200(it, region);
    if (n) out.push(n);
  }
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const k = String(it?.id || "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }
  return deduped;
}

// ======================================================================
// API MODE — (Şimdilik yok) => OBSERVABLE notImplemented
// ======================================================================
export async function searchVatanAPI(query, options = {}) {
  const region = options?.region || "TR";
  return _mkS200(
    false,
    [],
    { notImplemented: true, error: "NOT_IMPLEMENTED", mode: "api", region, ms: 0 },
    { error: "NOT_IMPLEMENTED" }
  );
}

// ======================================================================
// SCRAPE MODE — S200
// ======================================================================
export async function searchVatanScrape(query, options = {}) {
  const started = _now();
  const region = options?.region || "TR";
  const signal = options?.signal;

  const q = safe(query);
  if (!q) return _mkS200(false, [], { error: "empty_query", region, ms: 0 }, { error: "empty_query" });

  const url = `${BASE}/arama/${encodeURIComponent(q)}/`;
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, url };

  try {
    const res = await withTimeout(
      (async () => {
        const fetched = await fetchHTMLWithProxyS200(url, {
          signal,
          timeout: Math.max(2000, Math.min(20000, timeoutMs + 2000)),
          headers: { "User-Agent": "Mozilla/5.0 Chrome/122 Safari/537.36" },
        });

        if (!fetched.ok || !fetched.html) {
          return _mkS200(false, [], {
            error: fetched.error || "fetch_failed",
            via: fetched.via,
            warn: fetched.warn || null,
            mode: "scrape",
            region,
            ms: _now() - started,
          }, { error: fetched.error || "fetch_failed" });
        }

        const $ = loadCheerioS200(fetched.html, { adapter: PROVIDER_KEY, url });
        const items = [];

        $(".product-list__product, .product-list__item, .product-card, .product").each((i, el) => {
          const title =
            safe($(el).find(".product-list__product-name").text()) ||
            safe($(el).find(".product-name").text()) ||
            safe($(el).find("h3").text());
          if (!title) return;

          const priceTxt =
            safe($(el).find(".product-list__price").text()) ||
            safe($(el).find(".price").text()) ||
            safe($(el).find(".product-price").text());

          const rawPrice = parsePrice(priceTxt);
          const price = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "product" });

          let href =
            safe($(el).find("a").attr("href")) ||
            safe($(el).find("a.product-list__product-link").attr("href"));
          if (href && !href.startsWith("http")) href = href.startsWith("/") ? `${BASE}${href}` : `${BASE}/${href}`;
          if (!href) return;

          const affiliateUrl = buildAffiliateUrlS10({ provider: PROVIDER_KEY, url: href });

          let imgRaw = safe($(el).find("img").attr("src")) || safe($(el).find("img").attr("data-src"));
          if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;

          const imageVariants = buildImageVariants(imgRaw || null, PROVIDER_KEY);

          let item = {
            id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, title),
            title,
            price,
            priceText: priceTxt || null,
            rating: null,

            provider: PROVIDER_FAMILY,
            providerKey: PROVIDER_KEY,
            vertical: "product",
            category: "product",
            region: String(region).toUpperCase(),
            currency: "TRY",

            url: href,
            originUrl: href,
            affiliateUrl,

            image: imageVariants.image,
            imageOriginal: imageVariants.imageOriginal,
            imageProxy: imageVariants.imageProxy,
            hasProxy: imageVariants.hasProxy,

            raw: { title, priceText: priceTxt, href, imgRaw },
          };

          item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "product" });
          items.push(item);
        });

        const normalized = _normalizeItems(items, region);
        return _mkS200(true, normalized, {
          mode: "scrape",
          via: fetched.via,
          warn: fetched.warn || null,
          region,
          ms: _now() - started,
        });
      })(),
      timeoutMs,
      PROVIDER_KEY
    );

    return res;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return _mkS200(false, [], { error: _errStr(e), timeout: isTimeout, region, mode: "scrape", ms: _now() - started }, { error: isTimeout ? "timeout" : _errStr(e) });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ======================================================================
// UNIFIED ADAPTER — API first, then scrape
// ======================================================================
export async function searchVatanAdapter(query, options = {}) {
  const api = await searchVatanAPI(query, options);
  if (api?.ok && Array.isArray(api?.items) && api.items.length) return api;
  return searchVatanScrape(query, options);
}

export default {
  searchVatanAPI,
  searchVatanScrape,
  searchVatanAdapter,
};
