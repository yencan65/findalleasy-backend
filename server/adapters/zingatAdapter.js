// server/adapters/zingatAdapter.js
// ============================================================================
// ZINGAT (ESTATE) — S200 STANDARDIZED + HARDENED (FINAL)
// Output: { ok, items, count, source, _meta }
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

function pick(...vals) {
  for (const v of vals) {
    if (v && String(v).trim().length > 1) return String(v).trim();
  }
  return "";
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Legacy stable id (kept)
function buildStableId(href, title) {
  try {
    if (href) return "zingat_" + Buffer.from(href).toString("base64");
    return "zingat_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

const BASE = "https://www.zingat.com";
const PROVIDER_KEY = "zingat";
const PROVIDER_FAMILY = "estate";

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
      "zingat:axios.get"
    );

    if (res?.status >= 200 && res?.status < 400 && typeof res.data === "string") {
      return res.data;
    }

    throw new Error(res?.status ? `HTTP ${res.status}` : "DIRECT_FETCH_FAILED");
  } catch (e1) {
    try {
      const html = await withTimeout(proxyFetchHTML(url), ms, "zingat:proxyFetchHTML");
      if (typeof html === "string" && html.length) return html;
      throw new Error("PROXY_EMPTY");
    } catch (e2) {
      throw e2?.message ? e2 : e1;
    }
  }
}

export async function searchZingat(query, options = {}) {
  const region = String(options.region || "TR").toUpperCase();
  const signal = options.signal;

  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs || options.fetchTimeoutMs || options.timeout || 12000)
  );

  const q = encodeURIComponent(String(query || ""));
  const url = `${BASE}/arama?query=${q}`;

  let html = "";
  try {
    html = await fetchHTMLWithProxy(url, {
      signal,
      timeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 Safari/537.36",
        "Accept-Language": "tr-TR,tr;q=0.9",
        Referer: BASE + "/",
      },
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

    $(
      "div.card, div.listingCard, li[data-listing-id], div[data-testid='listing-item']"
    ).each((i, el) => {
      scanned++;

      const wrap = $(el);

      const title = pick(
        safe(wrap.find(".card-title").text()),
        safe(wrap.find(".title").text()),
        safe(wrap.find("h2").text()),
        safe(wrap.find("[data-testid='listing-title']").text())
      );
      if (!title) {
        dropped++;
        return;
      }

      const lower = title.toLowerCase();
      if (lower.includes("kampanya") || lower.includes("çekiliş") || lower.includes("promosyon")) {
        dropped++;
        return;
      }

      const priceText = pick(
        safe(wrap.find(".price").text()),
        safe(wrap.find(".listing-price").text()),
        safe(wrap.find("[data-testid='price']").text()),
        safe(wrap.find(".card-price").text())
      );

      const rawPrice = parsePrice(priceText);
      const price = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "listing" });

      let href = pick(
        safe(wrap.find("a").attr("href")),
        safe(wrap.find("[data-testid='listing-link']").attr("href"))
      );
      if (!href) {
        dropped++;
        return;
      }
      if (!href.startsWith("http")) href = BASE + href;

      const affiliateUrl = buildAffiliateUrlS10({ url: href, provider: PROVIDER_KEY });

      let imgRaw = pick(
        safe(wrap.find("img").attr("src")),
        safe(wrap.find("img").attr("data-src"))
      );
      if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;

      const images = buildImageVariants(imgRaw || null, PROVIDER_KEY);

      const catText = pick(
        safe(wrap.find(".listing-type").text()),
        safe(wrap.find(".type").text()),
        safe(wrap.find("[data-testid='listing-type']").text())
      );

      let item = {
        id: stableIdS200(PROVIDER_KEY, href, title),
        title,
        price: price ?? null,
        priceText,
        rating: null,

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,

        currency: "TRY",
        region,
        category: "listing",

        url: href,
        affiliateUrl,

        image: images.image,
        imageOriginal: images.imageOriginal,
        imageProxy: images.imageProxy,
        hasProxy: images.hasProxy,

        raw: { title, priceText, url: href, categoryText: catText, imgRaw },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "listing" });

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

// BACKWARD COMPAT (names kept)
export const searchZingatScrape = searchZingat;
export const searchZingatAdapter = searchZingat;
export default { searchZingat };
