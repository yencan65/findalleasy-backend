// server/core/localBarcodeEngine.js
// ============================================================
//  LOCAL MARKETPLACE BARCODE ENGINE — S22 (FREE-FIRST)
//  - Site içi arama sayfalarından aday ürün linklerini bulur
//  - Ürün sayfalarında barkod kanıtı + fiyat parse eder
//  - ✅ Daha sağlam fiyat selector + JSON-LD + regex fallback
//  - ✅ Barkod doğrulama: HTML text + JSON-LD gtin + meta itemprop
//  - Cache: 15dk (in-memory)
// ============================================================

import * as cheerio from "cheerio";
import { cseSearchSite, resolveCseKey, resolveCseCxForGroup } from "./googleCseClient.js";
import { getHtml } from "./NetClient.js";

const CACHE_TTL_MS = Number(process.env.LOCAL_BARCODE_CACHE_TTL_MS || 15 * 60 * 1000);
const cache = new Map(); // key -> { ts, data }

function cacheGet(key) {
  const it = cache.get(key);
  if (!it) return null;
  if (Date.now() - it.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return it.data || null;
}

function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function cleanText(s, max = 4000) {
  try {
    let t = String(s || "");
    t = t.replace(/\s+/g, " ").trim();
    if (t.length > max) t = t.slice(0, max);
    return t;
  } catch {
    return "";
  }
}

function looksBlocked(html) {
  const s = String(html || "");
  if (!s) return true;
  // basit bot/anti-scrape sinyalleri
  const low = s.toLowerCase();
  if (low.includes("captcha") || low.includes("cloudflare") || low.includes("please enable javascript")) return true;
  // çok küçük sayfa genelde boş/redirect
  if (s.length < 1200) return true;
  return false;
}

function absUrl(base, href) {
  try {
    if (!href) return "";
    const u = new URL(href, base);
    return u.toString();
  } catch {
    return "";
  }
}

function normalizeDomain(d) {
  const s = String(d || "").trim().toLowerCase();
  if (!s) return "";
  return s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/g, "");
}

function safeJsonParse(maybeJson) {
  try {
    return JSON.parse(maybeJson);
  } catch {
    return null;
  }
}

function traverseJson(root, cb) {
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v) continue;
    cb(v);
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) stack.push(v[k]);
    }
  }
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

function coercePrice(priceLike) {
  const s = String(priceLike || "").replace(/[^0-9.,]/g, "").trim();
  if (!s) return null;
  // TR format: 1.234,56 -> 1234.56
  const normalized = s
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(/,/g, ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  // aşırı uç değerleri ele (regex çöpünü kesmek için)
  if (n < 0.5 || n > 5_000_000) return null;
  return n;
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    const s = cleanText(v, 120);
    if (s) return s;
  }
  return "";
}

function extractPriceFromJsonLd($) {
  try {
    const scripts = $("script[type='application/ld+json']");
    let best = null;

    scripts.each((_, el) => {
      const raw = $(el).contents().text();
      const parsed = safeJsonParse(raw);
      if (!parsed) return;

      traverseJson(parsed, (node) => {
        if (!node || typeof node !== "object") return;
        const offers = node.offers;
        if (!offers) return;

        const tryOffer = (off) => {
          if (!off || typeof off !== "object") return;
          const p = pickFirstNonEmpty(off.price, off.lowPrice, off.highPrice, off.priceSpecification?.price);
          const n = coercePrice(p);
          if (!n) return;
          if (best == null || n < best) best = n;
        };

        if (Array.isArray(offers)) {
          for (const off of offers) tryOffer(off);
        } else {
          tryOffer(offers);
        }
      });
    });

    return best;
  } catch {
    return null;
  }
}

function extractPriceBySelectors($, provider) {
  try {
    const p = String(provider || "").toLowerCase();
    const candidates = [];

    const grab = (sel, attr = null) => {
      try {
        if (!sel) return;
        const el = $(sel).first();
        if (!el || !el.length) return;
        const raw = attr ? el.attr(attr) : el.text();
        const n = coercePrice(raw);
        if (n) candidates.push(n);
      } catch {
        // ignore
      }
    };

    // Genel meta
    grab("meta[property='product:price:amount']", "content");
    grab("meta[itemprop='price']", "content");
    grab("meta[property='og:price:amount']", "content");

    if (p === "trendyol") {
      grab("span.prc-dsc");
      grab("span.prc-slg");
      grab("[data-testid='price-current-price']");
      grab("div.pr-bx-w > span");
    } else if (p === "hepsiburada") {
      grab("[data-test-id='price-current-price']");
      grab("[data-test-id='default-price']");
      grab("span[data-bind*='currentPrice']");
      grab(".price__current-price");
      grab(".final-price");
    } else if (p === "n11") {
      grab(".newPrice ins");
      grab(".newPrice");
      grab(".unf-p-detail .price");
      grab(".productPrice");
    }

    if (!candidates.length) return null;
    // discount vs eski fiyat: en düşük genelde 'current' olur.
    candidates.sort((a, b) => a - b);
    return candidates[0] || null;
  } catch {
    return null;
  }
}

function extractPriceByRegex($) {
  try {
    const bodyText = cleanText($("body").text(), 120_000);
    if (!bodyText) return null;

    // TL / TRY fiyatlarını yakala
    const re = /(?:₺|TL|TRY)\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?|[0-9]+(?:,[0-9]{2})?)/gi;
    const nums = [];
    let m;
    while ((m = re.exec(bodyText)) && nums.length < 25) {
      const n = coercePrice(m[1]);
      if (n) nums.push(n);
    }

    if (!nums.length) {
      // bazı sayfalar "1.234,56 TL" diye yazar
      const re2 = /([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?)\s*(?:₺|TL|TRY)/gi;
      while ((m = re2.exec(bodyText)) && nums.length < 25) {
        const n = coercePrice(m[1]);
        if (n) nums.push(n);
      }
    }

    if (!nums.length) return null;
    nums.sort((a, b) => a - b);
    return nums[0] || null;
  } catch {
    return null;
  }
}

function extractPriceHeuristic($, provider) {
  // 1) JSON-LD (en temiz kaynak)
  const jld = extractPriceFromJsonLd($);
  if (jld) return jld;

  // 2) Site-specific selectors + meta
  const sel = extractPriceBySelectors($, provider);
  if (sel) return sel;

  // 3) Regex fallback (son çare)
  return extractPriceByRegex($);
}

function extractBarcodeEvidenceFromJsonLd($) {
  try {
    const scripts = $("script[type='application/ld+json']");
    const out = new Set();

    scripts.each((_, el) => {
      const raw = $(el).contents().text();
      const parsed = safeJsonParse(raw);
      if (!parsed) return;

      traverseJson(parsed, (node) => {
        if (!node || typeof node !== "object") return;
        for (const k of ["gtin13", "gtin12", "gtin", "barcode", "sku"]) {
          const v = node[k];
          if (v == null) continue;
          const s = String(v).replace(/\s+/g, "").trim();
          if (/^\d{8,18}$/.test(s)) out.add(s);
        }
      });
    });

    return Array.from(out);
  } catch {
    return [];
  }
}

function extractBarcodeEvidenceFromMeta($) {
  try {
    const out = new Set();
    const take = (sel, attr = "content") => {
      const v = $(sel).first().attr(attr);
      if (!v) return;
      const s = String(v).replace(/\s+/g, "").trim();
      if (/^\d{8,18}$/.test(s)) out.add(s);
    };

    take("meta[itemprop='gtin13']");
    take("meta[itemprop='gtin12']");
    take("meta[itemprop='gtin']");
    take("meta[itemprop='sku']");

    // bazı siteler JSON içinden değil, data-* içine gömer
    const body = cleanText($("body").attr("data-barcode") || "", 64);
    if (body) {
      const s = String(body).replace(/\s+/g, "").trim();
      if (/^\d{8,18}$/.test(s)) out.add(s);
    }

    return Array.from(out);
  } catch {
    return [];
  }
}

function pageMatchesBarcode(html, $, barcode) {
  try {
    const code = String(barcode || "").replace(/\s+/g, "").trim();
    if (!/^\d{8,18}$/.test(code)) return false;

    // hızlı: ham HTML içinde geçiyorsa
    if (String(html || "").includes(code)) return true;

    // JSON-LD evidence
    const jld = extractBarcodeEvidenceFromJsonLd($);
    if (jld.includes(code)) return true;

    // Meta evidence
    const meta = extractBarcodeEvidenceFromMeta($);
    if (meta.includes(code)) return true;

    return false;
  } catch {
    return false;
  }
}

async function fetchHtml(url, signal, adapterName) {
  const r = await getHtml(url, {
    signal,
    timeoutMs: 9000,
    retries: 1,
    maxRedirects: 3,
    adapterName,
    // Barcode search is often blocked by Cloudflare/JS rendering.
    // We allow the opt-in Jina proxy fallback at NetClient level.
    allowJinaProxy: true,
  });
  return r.ok ? r.html : null;
}

// ---------------------------------------------------------------------------
// Provider-specific search URL builders
// ---------------------------------------------------------------------------
function providerSearchUrls(provider, barcode) {
  const q = encodeURIComponent(String(barcode));
  if (provider === "hepsiburada") return [`https://www.hepsiburada.com/ara?q=${q}`];
  if (provider === "trendyol") return [`https://www.trendyol.com/sr?q=${q}`];
  if (provider === "n11") return [`https://www.n11.com/arama?q=${q}`];

  // TR fiyat karsilastirma / katalog siteleri (free HTML)
  // URL formatlari zamanla degisebiliyor; birkac alternatif deneriz.
  if (provider === "akakce") {
    return [
      `https://www.akakce.com/arama/?q=${q}`,
      `https://www.akakce.com/arama/?keyword=${q}`,
    ];
  }
  if (provider === "cimri") {
    return [
      `https://www.cimri.com/arama?q=${q}`,
      `https://www.cimri.com/arama?query=${q}`,
      `https://www.cimri.com/arama?search=${q}`,
    ];
  }
  if (provider === "epey") {
    const raw = String(barcode);
    return [
      `https://www.epey.com/ara/${raw}/`,
      `https://www.epey.com/ara/?q=${q}`,
      `https://www.epey.com/ara/?search=${q}`,
    ];
  }

  return [];
}

function providerDomain(provider) {
  if (provider === "hepsiburada") return "hepsiburada.com";
  if (provider === "trendyol") return "trendyol.com";
  if (provider === "n11") return "n11.com";
  if (provider === "akakce") return "akakce.com";
  if (provider === "cimri") return "cimri.com";
  if (provider === "epey") return "epey.com";
  return "";
}

function isLikelyProductUrl(provider, url) {
  const u = String(url || "");
  const low = u.toLowerCase();
  if (provider === "hepsiburada") {
    return /-p-(hb[\w\d]+)/i.test(low) && low.includes("hepsiburada.com");
  }
  if (provider === "trendyol") {
    return /-p-\d+/.test(low) && low.includes("trendyol.com");
  }
  if (provider === "n11") {
    return low.includes("n11.com") && (low.includes("/urun/") || /-p-\d+/.test(low));
  }
  // Katalog siteleri: arama URL'lerini ele, domain icinde kalan urun sayfalarini kabul et
  if (provider === "akakce") {
    return low.includes("akakce.com") && !low.includes("/arama") && (low.includes(".html") || low.includes("-"));
  }
  if (provider === "cimri") {
    return low.includes("cimri.com") && !low.includes("/arama") && !low.includes("?q=");
  }
  if (provider === "epey") {
    return low.includes("epey.com") && !low.includes("/ara/") && !low.includes("?q=");
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

  const searchUrls = providerSearchUrls(provider, barcode);
  if (!Array.isArray(searchUrls) || searchUrls.length === 0) return [];

  let candidates = [];
  let gotAnySearchHtml = false;

  // 1) Provider arama sayfasından çekmeyi dene (birkaç alternatif URL ile)
  for (const searchUrl of searchUrls) {
    const searchHtml = await fetchHtml(searchUrl, signal, `barcode-search:${provider}`);
    if (!searchHtml) continue;
    gotAnySearchHtml = true;
    if (!looksBlocked(searchHtml)) {
      candidates = extractCandidateLinks(provider, searchUrl, searchHtml).slice(0, maxCandidates);
      if (candidates.length) break;
    }
  }

  // 2) Anti-bot / boş sayfa ise CSE ile ücretsiz yedek
  // Default: OFF (Google CSE masrafını kilitlemek için)
  const enableCse = String(process.env.FAE_ENABLE_BARCODE_CSE || "").trim() === "1";
  if (enableCse && !candidates.length) {
    const domain = providerDomain(provider);
    if (domain) {
      try {
        const key = resolveCseKey();
        const cx = resolveCseCxForGroup("PRODUCT");
        if (!key || !cx) throw new Error("CSE_KEY_OR_CX_MISSING");

        const cse = await cseSearchSite({
          key,
          cx,
          q: barcode,
          site: domain,
          num: maxCandidates,
          hl: "tr",
          gl: "TR",
          cr: "countryTR",
          lr: "lang_tr",
        });
        if (cse?.ok && Array.isArray(cse.items)) {
          candidates = cse.items
            .map((it) => String(it?.link || "").trim())
            .filter(Boolean)
            .filter((u) => isLikelyProductUrl(provider, u))
            .map((u) => u.split("#")[0])
            .slice(0, maxCandidates);
        }
      } catch {
        // sessiz
      }
    }
  }

  // Eğer hiç HTML bile alamadıysak (aşırı blok), erken çık.
  if (!gotAnySearchHtml && !candidates.length) return [];

  if (!candidates.length) return [];

  const matches = [];
  for (const url of candidates) {
    const html = await fetchHtml(url, signal, `barcode-page:${provider}`);
    if (!html) continue;

    try {
      const $ = cheerio.load(html);
      if (!pageMatchesBarcode(html, $, barcode)) continue; // ✅ strict but smarter

      const title = extractTitle($);
      if (!title || title.length < 5) continue;

      const image = extractImage($);
      const priceNum = extractPriceHeuristic($, provider);

      // fiyat zorunlu (ürün)
      if (!priceNum) continue;

      matches.push({
        provider,
        url,
        title,
        image,
        price: priceNum,
        currency: "TRY",
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
  // Provider list override: opts.providers > env > default
  const envProviders = String(process.env.FAE_LOCAL_BARCODE_PROVIDERS || "")
    .split(",")
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);

  const providers = Array.isArray(opts?.providers)
    ? opts.providers
    : (envProviders.length ? envProviders : ["trendyol", "hepsiburada", "n11", "akakce", "cimri", "epey"]);
  const maxMatchesGlobal = Number.isFinite(opts?.maxMatches) ? Number(opts.maxMatches) : 1;

  const out = [];
  for (const p of providers) {
    try {
      const matches = await resolveOneProvider(String(p), code, signal, opts);
      if (Array.isArray(matches)) out.push(...matches);
    } catch {
      // ignore
    }

    // early stop: yeterli match bulunduysa diğer provider'lara gitme
    if (out.length >= Math.max(1, maxMatchesGlobal)) break;
  }

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
