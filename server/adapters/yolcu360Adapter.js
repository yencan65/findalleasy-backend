// server/adapters/yolcu360Adapter.js
// ============================================================================
// YOLCU360 (CAR RENTAL) — S200 STANDARDIZED + HARDENED (FINAL)
// ZERO DELETE • SEO scrape first • API optional (observable "skipped")
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

// --------------------------------------------------
// SAFE HELPERS
// --------------------------------------------------
const safe = (v) => (v ? String(v).trim() : "");

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeAbsUrl(base, href) {
  const h = safe(href);
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return "https:" + h;
  if (h.startsWith("/")) return base.replace(/\/+$/, "") + h;
  return base.replace(/\/+$/, "") + "/" + h;
}

function slugifyTR(input) {
  const s = safe(input).toLowerCase();
  if (!s) return "";
  const map = { "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g", "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c" };
  const fixed = s.split("").map((ch) => map[ch] || ch).join("");
  return fixed
    .replace(/&/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s/g, "-")
    .replace(/-+/g, "-");
}

function uniqById(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const id = safe(it?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

const BASE = "https://yolcu360.com";
const PROVIDER_KEY = "yolcu360";
const PROVIDER_FAMILY = "car_rental";

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

// --------------------------------------------------
// HTML Fetch (Direct + Proxy fallback) — HARD TIMEOUT
// --------------------------------------------------
async function fetchHTMLWithProxy(url, config, timeoutMs = 12000) {
  const ms = Math.max(1000, Number(timeoutMs || 12000));
  try {
    const res = await withTimeout(
      axios.get(url, {
        ...config,
        timeout: Math.min(20000, ms + 1500),
        maxRedirects: 3,
        validateStatus: () => true,
      }),
      ms,
      "yolcu360:axios.get"
    );

    if (res && res.status >= 200 && res.status < 400 && typeof res.data === "string") {
      return res.data;
    }

    throw new Error(res?.status ? `HTTP ${res.status}` : "HTTP_FAIL");
  } catch (err) {
    try {
      const proxied = await withTimeout(proxyFetchHTML(url), ms, "yolcu360:proxyFetchHTML");
      if (typeof proxied === "string" && proxied.length) return proxied;
      throw new Error("PROXY_EMPTY");
    } catch (e2) {
      throw e2?.message ? e2 : err;
    }
  }
}

// ============================================================================
// INTERNAL SCRAPE EXTRACTORS (SEO-friendly pages)
// ============================================================================
function extractCarsFromAnchors($, baseUrl, region = "TR") {
  const items = [];
  const seen = new Set();

  $("a").each((i, a) => {
    const text = safe($(a).text());
    if (!text) return;

    const looksLikeCar =
      /TL/i.test(text) && /başlayan fiyatlarla/i.test(text) && /veya benzeri/i.test(text);

    if (!looksLikeCar) return;

    const href = safe($(a).attr("href"));
    if (!href || href.startsWith("#")) return;

    const url = normalizeAbsUrl(baseUrl, href);
    if (!url) return;

    const title = safe(text.split(/veya benzeri/i)[0]) || safe(text.split(/TL/i)[0]);
    if (!title) return;

    const price = sanitizePrice(parsePrice(text), { provider: PROVIDER_KEY, category: "car_rental" });
    const affiliateUrl = buildAffiliateUrlS10({ url, provider: PROVIDER_KEY });

    const img = safe($(a).find("img").attr("src")) || safe($(a).find("img").attr("data-src"));
    const images = buildImageVariants(img, PROVIDER_KEY);

    let item = {
      id: stableIdS200(PROVIDER_KEY, url, title),
      title,
      price,
      priceText: text,
      rating: null,
      reviewCount: 0,

      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerFamily: PROVIDER_FAMILY,

      currency: "TRY",
      category: "car_rental",
      region,

      url,
      affiliateUrl,

      image: images.image,
      imageOriginal: images.imageOriginal,
      imageProxy: images.imageProxy,
      hasProxy: images.hasProxy,

      raw: { source: "anchor", text, href, img },
    };

    item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "car_rental" });

    const norm = normalizeItemS200(item, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      baseUrl: BASE,
      region,
      currency: "TRY",
      vertical: PROVIDER_FAMILY,
      requireRealUrlCandidate: true,
    });

    if (!norm) return;

    norm.imageOriginal = item.imageOriginal || null;
    norm.imageProxy = item.imageProxy || null;
    norm.hasProxy = Boolean(item.hasProxy);

    if (seen.has(norm.id)) return;
    seen.add(norm.id);

    items.push(norm);
  });

  return items;
}

function extractCarsFromTables($, baseUrl, region = "TR") {
  const items = [];
  const seen = new Set();

  $("table tr").each((i, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 2) return;

    const title = safe($(tds[0]).text());
    const priceTxt = safe($(tds[1]).text());
    if (!title || !/TL/i.test(priceTxt)) return;

    const a = $(tds[1]).find("a").first();
    const href = safe(a.attr("href")) || safe($(tr).find("a").first().attr("href"));
    const url = href
      ? normalizeAbsUrl(baseUrl, href)
      : `${baseUrl.replace(/\/+$/, "")}/arac-kiralama`;

    const price = sanitizePrice(parsePrice(priceTxt), { provider: PROVIDER_KEY, category: "car_rental" });
    const affiliateUrl = buildAffiliateUrlS10({ url, provider: PROVIDER_KEY });

    let item = {
      id: stableIdS200(PROVIDER_KEY, url, title),
      title,
      price,
      priceText: priceTxt,
      rating: null,
      reviewCount: 0,

      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerFamily: PROVIDER_FAMILY,

      currency: "TRY",
      category: "car_rental",
      region,

      url,
      affiliateUrl,

      raw: { source: "table", title, priceTxt, href },
    };

    item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "car_rental" });

    const norm = normalizeItemS200(item, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      baseUrl: BASE,
      region,
      currency: "TRY",
      vertical: PROVIDER_FAMILY,
      requireRealUrlCandidate: true,
    });

    if (!norm) return;

    if (seen.has(norm.id)) return;
    seen.add(norm.id);

    items.push(norm);
  });

  return items;
}

function buildCandidateUrls(query) {
  const q = safe(query);
  const slug = slugifyTR(q);

  const urls = [];
  if (slug) urls.push(`${BASE}/arac-kiralama/turkiye/${slug}`);

  const parts = slug ? slug.split("-").filter(Boolean) : [];
  if (parts.length >= 2) {
    const p0 = parts[0];
    const p1 = parts.slice(1).join("-");
    urls.push(`${BASE}/arac-kiralama/turkiye/${p0}/${p1}`);
    urls.push(`${BASE}/arac-kiralama/turkiye/${p1}/${p0}`);
  }

  urls.push(`${BASE}/arac-kiralama`);
  return Array.from(new Set(urls));
}

// ============================================================================
// API SEARCH (kept, but OFF by default — observable "skipped")
// ============================================================================
export async function searchYolcu360_API(query, options = {}) {
  const region = String(options.region || "TR").toUpperCase();
  const signal = options.signal;

  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs || options.fetchTimeoutMs || options.timeout || 12000)
  );

  const USE_API = String(process.env.YOLCU360_USE_API || "") === "1";
  if (!USE_API) {
    return s200Fail({
      stage: "api",
      code: "SKIPPED",
      err: new Error("YOLCU360_USE_API is disabled"),
      meta: { skipped: true, query: String(query || ""), region },
    });
  }

  try {
    const url = `https://api.yolcu360.com/search?query=${encodeURIComponent(String(query || ""))}`;

    const res = await withTimeout(
      axios.get(url, {
        signal,
        timeout: Math.min(20000, timeoutMs + 1500),
        headers: { "User-Agent": "Mozilla/5.0 Chrome/122" },
        validateStatus: () => true,
      }),
      timeoutMs,
      "yolcu360:api"
    );

    const data = res?.data;

    if (!Array.isArray(data?.results)) {
      return s200Ok([], { stage: "api", query: String(query || ""), region, url, note: "No results array" });
    }

    const items = [];
    for (const c of data.results) {
      const title = safe(c?.name);
      const u = safe(c?.url);
      if (!title || !u) continue;

      const rawPrice = parsePrice(c?.price);
      const price = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "car_rental" });
      const affiliateUrl = buildAffiliateUrlS10({ url: u, provider: PROVIDER_KEY });
      const images = buildImageVariants(c?.image, PROVIDER_KEY);

      let item = {
        id: stableIdS200(PROVIDER_KEY, u, title),
        title,
        price,
        priceText: safe(c?.price),
        rating: c?.rating ?? null,

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,

        currency: "TRY",
        category: "car_rental",
        region,

        url: u,
        affiliateUrl,

        image: images.image,
        imageOriginal: images.imageOriginal,
        imageProxy: images.imageProxy,
        hasProxy: images.hasProxy,

        raw: c,
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "car_rental" });

      const norm = normalizeItemS200(item, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        baseUrl: BASE,
        region,
        currency: "TRY",
        vertical: PROVIDER_FAMILY,
        requireRealUrlCandidate: true,
      });

      if (!norm) continue;

      norm.imageOriginal = item.imageOriginal || null;
      norm.imageProxy = item.imageProxy || null;
      norm.hasProxy = Boolean(item.hasProxy);

      items.push(norm);
    }

    return s200Ok(uniqById(items), {
      stage: "api",
      query: String(query || ""),
      region,
      url,
      timeoutMs,
    });
  } catch (err) {
    return s200Fail({
      stage: "api",
      code: "API_FAILED",
      err,
      meta: { query: String(query || ""), region, timeoutMs },
    });
  }
}

// ============================================================================
// SCRAPER FALLBACK (SEO pages first)
// ============================================================================
export async function searchYolcu360_SCRAPE(query, options = {}) {
  const region = String(options.region || "TR").toUpperCase();
  const signal = options.signal;

  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs || options.fetchTimeoutMs || options.timeout || 12000)
  );

  try {
    const candidates = buildCandidateUrls(query);

    for (const url of candidates) {
      const html = await fetchHTMLWithProxy(
        url,
        {
          signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
            "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        },
        timeoutMs
      );

      if (!html) continue;

      const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url, log: options.log });

      let items = [];
      items = items.concat(extractCarsFromAnchors($, BASE, region));
      items = items.concat(extractCarsFromTables($, BASE, region));
      items = uniqById(items);

      if (items.length) {
        return s200Ok(items, {
          stage: "scrape",
          query: String(query || ""),
          region,
          sourceUrl: url,
          timeoutMs,
        });
      }
    }

    return s200Ok([], { stage: "scrape", query: String(query || ""), region, timeoutMs });
  } catch (err) {
    return s200Fail({
      stage: "scrape",
      code: "SCRAPE_FAILED",
      err,
      meta: { query: String(query || ""), region, timeoutMs },
    });
  }
}

// ============================================================================
// FINAL EXPORTER – ENGINE ALWAYS CALLS THIS
// ============================================================================
export async function searchYolcu360Adapter(query, options = {}) {
  const api = await searchYolcu360_API(query, options);
  if (api.ok && api.count > 0) return api;

  const scrape = await searchYolcu360_SCRAPE(query, options);
  if (scrape.ok && scrape.count > 0) return scrape;

  // both empty/fail — keep observability
  if (!api.ok) return api;
  return scrape;
}

export default searchYolcu360Adapter;
