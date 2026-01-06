// server/core/localBarcodeEngine.js
// ============================================================================
// LOCAL BARCODE ENGINE — S22 (TR MARKETPLACES)
//
// Goal:
//  - Barcode çözülmezse TR marketplace'lerde "site içi arama" yap
//  - Aday ürün sayfalarını GET ile çek
//  - ✅ SADECE barcode string'i sayfada gerçekten geçiyorsa kabul et
//
// Notes:
//  - Bu engine "best-effort": captcha / blok / JS-only sayfa durumlarında boş dönebilir.
//  - Ama boş dönmesi, yanlış ürün döndürmekten iyidir.
// ============================================================================

import * as cheerio from "cheerio";
import { getHtml } from "./NetClient.js";

// ---------------------------------------------------------------------------
// Tiny TTL cache (in-memory)
// ---------------------------------------------------------------------------
const CACHE = new Map(); // key -> { ts, data }
const TTL_MS = Number(process.env.FAE_LOCAL_BARCODE_TTL_MS || 10 * 60 * 1000);

function cacheGet(key) {
  try {
    const hit = CACHE.get(key);
    if (!hit) return null;
    const age = Date.now() - (hit.ts || 0);
    if (age > TTL_MS) return null;
    return hit.data || null;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    CACHE.set(key, { ts: Date.now(), data });
  } catch {}
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const s = String(x || "");
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function absUrl(base, href) {
  try {
    if (!href) return null;
    const h = String(href).trim();
    if (!h) return null;
    if (h.startsWith("http://") || h.startsWith("https://")) return h;
    return new URL(h, base).toString();
  } catch {
    return null;
  }
}

function cleanText(s, max = 220) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) : t;
}

function pageIncludesBarcode(html, code) {
  if (!html || !code) return false;
  const h = String(html);
  // strict string match; still robust because barcode is digits
  return h.includes(String(code));
}

function extractMeta($, prop) {
  try {
    const v = $(`meta[property='${prop}']`).attr("content") || $(`meta[name='${prop}']`).attr("content");
    return cleanText(v, 2000);
  } catch {
    return "";
  }
}

function extractTitle($) {
  const og = extractMeta($, "og:title");
  if (og) return cleanText(og, 240);
  const h1 = cleanText($("h1").first().text(), 240);
  if (h1) return h1;
  const t = cleanText($("title").first().text(), 240);
  return t;
}

function extractImage($) {
  const og = extractMeta($, "og:image");
  if (og) return og;
  const tw = extractMeta($, "twitter:image");
  if (tw) return tw;
  return "";
}

function extractPriceHeuristic($) {
  // Best-effort meta patterns (some sites expose product:price)
  const p1 = extractMeta($, "product:price:amount");
  if (p1) return p1;
  const p2 = $("meta[itemprop='price']").attr("content");
  if (p2) return cleanText(p2, 60);
  return "";
}

function coercePrice(priceLike) {
  const s = String(priceLike || "").replace(/[^0-9.,]/g, "").trim();
  if (!s) return null;
  // TR format: 1.234,56 -> 1234.56
  const normalized = s
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(/,/g, ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function fetchHtml(url, signal, adapterName) {
  const r = await getHtml(url, {
    signal,
    timeoutMs: 9000,
    retries: 1,
    maxRedirects: 3,
    adapterName,
  });
  return r.ok ? r.html : null;
}

// ---------------------------------------------------------------------------
// Provider-specific search URL builders
// ---------------------------------------------------------------------------
function providerSearchUrl(provider, barcode) {
  const q = encodeURIComponent(String(barcode));
  if (provider === "hepsiburada") return `https://www.hepsiburada.com/ara?q=${q}`;
  if (provider === "trendyol") return `https://www.trendyol.com/sr?q=${q}`;
  if (provider === "n11") return `https://www.n11.com/arama?q=${q}`;
  return null;
}

function isLikelyProductUrl(provider, url) {
  const u = String(url || "");
  const low = u.toLowerCase();
  if (provider === "hepsiburada") {
    // common pattern: -p-HB...
    return /-p-(hb[\w\d]+)/i.test(low) && low.includes("hepsiburada.com");
  }
  if (provider === "trendyol") {
    // pattern: -p-<digits>
    return /-p-\d+/.test(low) && low.includes("trendyol.com");
  }
  if (provider === "n11") {
    // pattern: /urun/...
    return low.includes("n11.com") && (low.includes("/urun/") || /-p-\d+/.test(low));
  }
  return false;
}

function extractCandidateLinks(provider, baseUrl, html) {
  try {
    const $ = cheerio.load(html);
    const links = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const abs = absUrl(baseUrl, href);
      if (!abs) return;
      if (!isLikelyProductUrl(provider, abs)) return;
      links.push(abs.split("#")[0]);
    });
    return uniq(links);
  } catch {
    return [];
  }
}

async function resolveOneProvider(provider, barcode, signal, opts = {}) {
  const maxCandidates = Number.isFinite(opts?.maxCandidates) ? Number(opts.maxCandidates) : 7;
  const maxMatches = Number.isFinite(opts?.maxMatches) ? Number(opts.maxMatches) : 2;

  const searchUrl = providerSearchUrl(provider, barcode);
  if (!searchUrl) return [];

  const searchHtml = await fetchHtml(searchUrl, signal, `barcode-search:${provider}`);
  if (!searchHtml) return [];

  const candidates = extractCandidateLinks(provider, searchUrl, searchHtml).slice(0, maxCandidates);
  if (!candidates.length) return [];

  const matches = [];
  for (const url of candidates) {
    const html = await fetchHtml(url, signal, `barcode-page:${provider}`);
    if (!html) continue;
    if (!pageIncludesBarcode(html, barcode)) continue; // ✅ strict

    try {
      const $ = cheerio.load(html);
      const title = extractTitle($);
      if (!title || title.length < 5) continue;

      const image = extractImage($);
      const priceNum = coercePrice(extractPriceHeuristic($));

      matches.push({
        provider,
        url,
        title,
        image,
        price: priceNum,
        currency: priceNum ? "TRY" : null,
        verifiedBarcode: true,
      });
      if (matches.length >= maxMatches) break;
    } catch {
      // ignore parse errors
    }
  }

  return matches;
}

/**
 * searchLocalBarcodeEngine(barcode, opts)
 *
 * Returns: Array<{ provider, url, title, image, price, currency, verifiedBarcode }>
 */
export async function searchLocalBarcodeEngine(barcode, opts = {}) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return [];

  const region = String(opts?.region || "TR").toUpperCase();
  const cacheKey = `${region}:${code}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const signal = opts?.signal;
  const providers = Array.isArray(opts?.providers)
    ? opts.providers
    : ["trendyol", "hepsiburada", "n11"];

  // Parallel but controlled: Promise.allSettled across 3 providers is ok.
  const settled = await Promise.allSettled(
    providers.map((p) => resolveOneProvider(String(p), code, signal, opts))
  );

  const out = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && Array.isArray(s.value)) out.push(...s.value);
  }

  // Keep deterministic ordering (providers order) but still dedupe urls
  const byUrl = new Map();
  for (const it of out) {
    if (!it?.url) continue;
    if (!byUrl.has(it.url)) byUrl.set(it.url, it);
  }
  const finalList = Array.from(byUrl.values());

  cacheSet(cacheKey, finalList);
  return finalList;
}

export default { searchLocalBarcodeEngine };
