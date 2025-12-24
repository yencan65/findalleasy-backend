// server/adapters/yemeksepetiMarketAdapter.js
// ============================================================================
// YEMEKSEPETI MARKET (BANABI) — S200 STANDARDIZED + HARDENED (FINAL)
// Output: { ok, items, count, source, _meta }
// Contract lock via normalizeItemS200
// stableId via stableIdS200(providerKey,url,title)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // (kept) ZERO DELETE
import { proxyFetchHTML } from "../core/proxyEngine.js";

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  normalizeItemS200,
  stableIdS200,
} from "../core/s200AdapterKit.js";

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  const clean = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

// Legacy helper (kept)
function buildStableId(href, title) {
  try {
    if (href) return "ys_" + Buffer.from(href).toString("base64");
    return "ys_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

const BASE = "https://www.yemeksepeti.com";
const PROVIDER_KEY = "yemeksepeti_market";
const PROVIDER_FAMILY = "market";

function s200Ok(items, meta = {}) {
  return {
    ok: true,
    items,
    count: items.length,
    source: PROVIDER_KEY,
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    _meta: meta,
  };
}

function s200Fail({ stage, code, err, meta = {} }) {
  const isTimeout =
    err instanceof TimeoutError ||
    String(err?.name || "").toLowerCase().includes("timeout");

  return {
    ok: false,
    items: [],
    count: 0,
    source: PROVIDER_KEY,
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    _meta: {
      stage: stage || "unknown",
      code: code || "ERROR",
      error: err?.message || String(err || code || "ERROR"),
      timeout: Boolean(isTimeout),
      ...meta,
      timestamp: Date.now(),
    },
  };
}

async function fetchHTMLWithProxy(url, { signal, headers, timeoutMs }) {
  const ms = Math.max(1000, Number(timeoutMs || 12000));

  try {
    const res = await withTimeout(
      axios.get(url, {
        signal,
        timeout: Math.min(20000, ms + 1500),
        headers,
        validateStatus: () => true,
        maxRedirects: 3,
      }),
      ms,
      "yemeksepeti_market:axios.get"
    );

    if (res?.status >= 200 && res?.status < 400 && typeof res.data === "string") {
      return res.data;
    }

    throw new Error(res?.status ? `HTTP ${res.status}` : "DIRECT_FETCH_FAILED");
  } catch (e1) {
    try {
      const html = await withTimeout(proxyFetchHTML(url), ms, "yemeksepeti_market:proxyFetchHTML");
      if (typeof html === "string" && html.length) return html;
      throw new Error("PROXY_EMPTY");
    } catch (e2) {
      throw e2?.message ? e2 : e1;
    }
  }
}

// --------------------------------------------------------------
// MODE 1 — MARKET SEARCH
// --------------------------------------------------------------
export async function scrapeYemeksepetiMarket(query, options = {}) {
  const region = String(options.region || "TR").toUpperCase();
  const signal = options.signal;

  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs || options.fetchTimeoutMs || options.timeout || 12000)
  );

  const q = encodeURIComponent(String(query || ""));
  const url = `${BASE}/market/ara?q=${q}`;

  let html = "";
  try {
    html = await fetchHTMLWithProxy(url, {
      signal,
      timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/122 Safari/537.36" },
    });
  } catch (err) {
    return s200Fail({
      stage: "fetch",
      code: "FETCH_FAILED",
      err,
      meta: { query: String(query || ""), region, url, timeoutMs },
    });
  }

  try {
    const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url, log: options.log });
    const items = [];
    let scanned = 0;
    let dropped = 0;

    $(".product, .ys-product-card, .market-product-item, .product-card").each((i, el) => {
      scanned++;

      const name =
        safe($(el).find(".product-title").text()) ||
        safe($(el).find(".name").text()) ||
        safe($(el).find(".market-product-name").text()) ||
        safe($(el).find("h3").text());

      if (!name) {
        dropped++;
        return;
      }

      const lower = name.toLowerCase();
      if (
        lower.includes("kampanya") ||
        lower.includes("hediye") ||
        lower.includes("çekiliş") ||
        lower.includes("promosyon")
      ) {
        dropped++;
        return;
      }

      const priceTxt =
        safe($(el).find(".product-price").text()) ||
        safe($(el).find(".price").text()) ||
        safe($(el).find(".new-price").text());

      const rawPrice = parsePrice(priceTxt);
      const price = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "product" });

      let href = safe($(el).find("a").attr("href"));
      if (!href) {
        dropped++;
        return;
      }
      if (!href.startsWith("http")) href = BASE + href;

      const affiliateUrl = buildAffiliateUrlS10({ url: href, provider: PROVIDER_KEY });

      let imgRaw =
        safe($(el).find("img").attr("src")) ||
        safe($(el).find("img").attr("data-src"));

      if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;
      const images = buildImageVariants(imgRaw || null, "yemeksepeti");

      let item = {
        id: stableIdS200(PROVIDER_KEY, href, name),
        title: name,
        price,
        priceText: priceTxt,
        rating: null,

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,

        currency: "TRY",
        region,
        category: "product",

        url: href,
        affiliateUrl,

        image: images.image,
        imageOriginal: images.imageOriginal,
        imageProxy: images.imageProxy,
        hasProxy: images.hasProxy,

        raw: { name, priceTxt, href, imgRaw },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "product" });

      const norm = normalizeItemS200(item, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        baseUrl: BASE,
        region,
        currency: "TRY",
        vertical: PROVIDER_FAMILY,
        requireRealUrlCandidate: true,
      });

      if (!norm) {
        dropped++;
        return;
      }

      norm.imageOriginal = item.imageOriginal || null;
      norm.imageProxy = item.imageProxy || null;
      norm.hasProxy = Boolean(item.hasProxy);

      items.push(norm);
    });

    return s200Ok(items, {
      adapter: PROVIDER_KEY,
      stage: "search",
      query: String(query || ""),
      region,
      url,
      scanned,
      dropped,
      timeoutMs,
    });
  } catch (err) {
    return s200Fail({
      stage: "parse",
      code: "PARSE_FAILED",
      err,
      meta: { query: String(query || ""), region, url, timeoutMs },
    });
  }
}

// --------------------------------------------------------------
// MODE 2 — FALLBACK
// --------------------------------------------------------------
export async function scrapeYemeksepetiMarketFallback(query, options = {}) {
  const region = String(options.region || "TR").toUpperCase();
  const signal = options.signal;

  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs || options.fetchTimeoutMs || options.timeout || 12000)
  );

  const sample = `${BASE}/market`;

  let html = "";
  try {
    html = await fetchHTMLWithProxy(sample, {
      signal,
      timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/122 Safari/537.36" },
    });
  } catch (err) {
    return s200Fail({
      stage: "fetch",
      code: "FETCH_FAILED",
      err,
      meta: { query: String(query || ""), region, url: sample, timeoutMs },
    });
  }

  try {
    const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url: sample, log: options.log });
    const items = [];
    const q = String(query || "").toLowerCase();

    let scanned = 0;
    let dropped = 0;

    $(".product, .market-product-item").each((i, el) => {
      scanned++;

      const name = safe($(el).find(".product-title").text());
      if (!name) {
        dropped++;
        return;
      }
      if (!name.toLowerCase().includes(q)) {
        dropped++;
        return;
      }

      const priceTxt = safe($(el).find(".product-price").text());
      const rawPrice = parsePrice(priceTxt);
      const price = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "product" });

      const affiliateUrl = buildAffiliateUrlS10({ url: sample, provider: PROVIDER_KEY });
      const images = buildImageVariants(null, "yemeksepeti");

      let item = {
        id: stableIdS200(PROVIDER_KEY, sample, name),
        title: name,
        price,
        priceText: priceTxt,
        rating: null,

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,

        currency: "TRY",
        region,
        category: "product",

        url: sample,
        affiliateUrl,

        image: images.image,
        imageOriginal: images.imageOriginal,
        imageProxy: images.imageProxy,
        hasProxy: images.hasProxy,

        raw: { name, priceTxt },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "product" });

      const norm = normalizeItemS200(item, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        baseUrl: BASE,
        region,
        currency: "TRY",
        vertical: PROVIDER_FAMILY,
        requireRealUrlCandidate: true,
      });

      if (!norm) {
        dropped++;
        return;
      }

      items.push(norm);
    });

    return s200Ok(items, {
      adapter: PROVIDER_KEY,
      stage: "fallback",
      query: String(query || ""),
      region,
      url: sample,
      scanned,
      dropped,
      timeoutMs,
    });
  } catch (err) {
    return s200Fail({
      stage: "parse",
      code: "PARSE_FAILED",
      err,
      meta: { query: String(query || ""), region, url: sample, timeoutMs },
    });
  }
}

// --------------------------------------------------------------
// UNIFIED ADAPTER — ENGINE ENTRY
// --------------------------------------------------------------
export async function searchYemeksepetiMarketAdapter(query, options = {}) {
  const r1 = await scrapeYemeksepetiMarket(query, options);
  if (r1.ok && r1.count > 0) return r1;

  const r2 = await scrapeYemeksepetiMarketFallback(query, options);
  if (r2.ok && r2.count > 0) {
    r2._meta = { ...(r2._meta || {}), prior: r1.ok ? "search_empty" : "search_failed" };
    return r2;
  }

  if (!r1.ok) return r1;
  if (!r2.ok) return r2;

  return s200Ok([], {
    adapter: PROVIDER_KEY,
    stage: "unified",
    query: String(query || ""),
    region: String(options.region || "TR").toUpperCase(),
    note: "Both modes returned empty",
  });
}

export default {
  searchYemeksepetiMarketAdapter,
  scrapeYemeksepetiMarket,
  scrapeYemeksepetiMarketFallback,
};
