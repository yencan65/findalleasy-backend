// server/adapters/hepsiburadaAdapter.js
// Hepsiburada – TITAN S33 → S200 NORMALIZED FINAL
// ZERO DELETE – scraping, selectors, filters, price logic aynen korunuyor.

import axios from "axios";
import * as cheerio from "cheerio";
import { proxyImage, buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================================
// S200 HARDENING HELPERS (KIT-LOCKED)
// ============================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _errStr(e) {
  return safeStr(e?.message || e || "error", 500);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(source, ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source, _meta: { ...meta } };
}
function _normalizeMany(rawItems, providerKey, normOpts = {}) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const x = it && typeof it === "object" ? { ...it } : it;
    if (x && typeof x === "object") {
      // NO RANDOM/DRIFT ID: force kit stableId
      delete x.id;
      delete x.listingId;
    }
    const n = normalizeItemS200(x, providerKey, normOpts);
    if (n) out.push(n);
  }
  // dedupe by id
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(it);
  }
  return deduped;
}


// ======================= ENV — AFFILIATE =======================
const AFF_ID = process.env.HB_AFFILIATE_ID || "";
const SUBKEY = process.env.HB_SUBID_KEY || "aff_id";
const REDIRECT = process.env.HB_REDIRECT || "";

// ======================= AFFILIATE URL BUILDER =======================
function buildAffiliateUrl(url) {
  if (!url) return url;
  if (!AFF_ID) return url;

  if (REDIRECT) {
    try {
      const base = REDIRECT.replace(/\/+$/, "");
      return `${base}?target=${encodeURIComponent(url)}&${SUBKEY}=${AFF_ID}`;
    } catch {
      return `${REDIRECT}${encodeURIComponent(url)}&${SUBKEY}=${AFF_ID}`;
    }
  }

  try {
    const u = new URL(url);
    u.searchParams.set(SUBKEY, AFF_ID);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${SUBKEY}=${AFF_ID}`;
  }
}

// ======================= HELPERS =======================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

// TITAN price parse
function parsePriceStrong(txt) {
  const raw = safe(txt);
  if (!raw) return null;

  try {
    const cleaned = raw
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ZERO DELETE eski parse
function parsePrice(txt) {
  const raw = safe(txt);
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const MAX_PAGES = 3;
const MAX_ITEMS = 80;

// stableId 2.0
function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return (
    "hb_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.45;
  if (item.price != null) s += 0.35;
  if (item.image) s += 0.15;
  s += 0.05;
  return Number(s.toFixed(2));
}

// ======================= HEADERS =======================
function buildAxiosConfig(signal) {
  return {
    timeout: 15000,
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: "https://www.hepsiburada.com/",
    },
  };
}

// ======================= PAGE SCRAPER =======================
async function scrapeHepsiburadaPage(query, page = 1, options = {}) {
  const { signal, region = "TR" } = options || {};
  const q = encodeURIComponent(query);

  const url = `https://www.hepsiburada.com/ara?q=${q}&pg=${page}`;

  try {
    const { data: html } = await axios.get(url, buildAxiosConfig(signal));
    const $ = loadCheerioS200(html);

    const items = [];

    const nodes = $(
      "li.productListContent-item, \
       div[data-test-id='product-card'], \
       div.product-card, \
       li[data-test-id='product-card'], \
       li[id*='i0'], \
       li"
    );

    nodes.each((i, el) => {
      const n = $(el);

      const title =
        safe(n.find("h3").text()) ||
        safe(n.find("h2").text()) ||
        safe(n.find(".product-name").text()) ||
        safe(n.find("[data-test-id='product-title']").text());

      if (!title) return;

      // ÇÖP temizleyici
      const lower = title.toLowerCase();
      if (
        lower.includes("tamir") ||
        lower.includes("onarım") ||
        lower.includes("servis") ||
        lower.includes("ekran değişimi") ||
        lower.includes("batarya") ||
        lower.includes("kamera") ||
        lower.includes("parça") ||
        lower.includes("montaj") ||
        lower.includes("sökme") ||
        lower.includes("teknik") ||
        lower.includes("gsm") ||
        lower.includes("cep iletişim") ||
        lower.includes("iletisim") ||
        lower.includes("fix")
      ) {
        return;
      }

      // Fiyat
      const priceTextRaw =
        safe(n.find(".price-value").text()) ||
        safe(n.find("[data-test-id='price-current-price']").text()) ||
        safe(n.find(".product-price").text()) ||
        safe(n.find("span[data-bind*='price']").text());

      const strong = parsePriceStrong(priceTextRaw);
      const price = sanitizePrice(strong);
      const priceText = priceTextRaw || null;

      // Link
      let href =
        safe(n.find("a[data-test-id='product-card-link']").attr("href")) ||
        safe(n.find("a").attr("href"));

      if (!href) return;
      if (!href.startsWith("http")) {
        href = "https://www.hepsiburada.com" + href;
      }

      const realUrl = href; // S200 için gerçek URL
      const affiliateUrl = buildAffiliateUrl(href); // S200 deeplink

      // Görsel
      let imgRaw =
        safe(n.find("img").attr("data-src")) ||
        safe(n.find("img").attr("data-original")) ||
        safe(n.find("img").attr("data-image-src")) ||
        safe(n.find("img").attr("src"));

      if (imgRaw && imgRaw.startsWith("//")) {
        imgRaw = "https:" + imgRaw;
      }

      const image = buildImageVariants(imgRaw, "hepsiburada");

      // Rating
      const ratingTxt =
        safe(n.find("[data-test-id='rating-score']").text()) ||
        safe(n.find(".rating-star").text());

      let rating = null;
      if (ratingTxt) {
        const r = Number(ratingTxt.replace(/[^\d.,]/g, "").replace(",", "."));
        if (Number.isFinite(r) && r > 0 && r <= 5) rating = r;
      }

      const id = stableId("hepsiburada", title, realUrl);

      // =========================
      //  S200 NORMALIZED OUTPUT
      // =========================
      const normalized = {
        id,
        provider: "hepsiburada",
        source: "hepsiburada",

        title,
        price: price ?? null,
        rating,

        url: realUrl,          // gerçek ürün linki
        deeplink: affiliateUrl, // affiliate URL → S200 için şart

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        currency: "TRY",
        region: region,
        category: "product",

        raw: {
          id,
          title,
          priceText,
          ratingTxt,
          realUrl,
          affiliateUrl,
          imgRaw,
        },

        // ZERO DELETE: eski alanlar korunur (motor görmezden gelir)
        qualityScore: computeQualityScore({ title, price, image: image.image }),
        finalPrice: price,
        optimizedPrice:
          price != null
            ? optimizePrice({ price }, { provider: "hepsiburada" })
            : null,
        stock: "var",
      };

      items.push(normalized);
    });

    return items;
  } catch (err) {
    const status = err?.response?.status || null;
    const code =
      status === 429 ? "HTTP_429" :
      status === 403 ? "HTTP_403" :
      status === 404 ? "HTTP_404" :
      status ? `HTTP_${status}` : "HB_SCRAPE_FAIL";

    console.warn("Hepsiburada scrape hata:", err?.message || String(err));
    const e = err instanceof Error ? err : new Error(String(err));
    try { e.status = status; e.code = code; } catch {}
    throw e;
  }
}

// ======================= MULTI PAGE SCRAPER =======================
export async function searchHepsiburadaScrape(query, regionOrOptions = "TR") {
  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  const qSafe = safe(query);
  if (!qSafe) return [];

  let all = [];
  let warn = null;

  for (let p = 1; p <= MAX_PAGES; p++) {
    try {
      const part = await scrapeHepsiburadaPage(qSafe, p, { ...options, region });
      if (!part.length) break;

      all = all.concat(part);
      if (all.length >= MAX_ITEMS) break;
    } catch (err) {
      const status = err?.status || err?.response?.status || null;
      const code =
        err?.code ||
        (status === 429 ? "HTTP_429" :
         status === 403 ? "HTTP_403" :
         status === 404 ? "HTTP_404" :
         status ? `HTTP_${status}` : "HB_SCRAPE_FAIL");

      if (all.length > 0) {
        warn = { page: p, status, code, error: err?.message || String(err) };
        break;
      }

      throw err;
    }
  }

  if (warn) {
    try {
      Object.defineProperty(all, "_meta", { value: { partialFail: true, warn }, enumerable: false });
    } catch {}
  }

  return all;
}

// ======================= UNIFIED ADAPTER =======================
export async function searchHepsiburadaAdapter(query, regionOrOptions = "TR") {
  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }
  const timeoutMs = Number(options.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "hepsiburadaAdapter", providerKey: "hepsiburada", url: "" };

  try {
    const raw = await withTimeout(
      searchHepsiburadaScrape(query, regionOrOptions),
      timeoutMs,
      "hepsiburada.scrape"
    );
    const items = _normalizeMany(raw, "hepsiburada", {
      providerFamily: "product",
      category: "product",
      currency: "TRY",
      region,
      baseUrl: "https://www.hepsiburada.com",
    });

    const rawMeta = (raw && typeof raw === "object") ? raw._meta : null;

    return _mkRes("hepsiburada", true, items, {
      code: items.length ? "OK" : "OK_EMPTY",
      region,
      timeoutMs,
      ...(rawMeta ? { upstream: rawMeta } : {}),
      ...(rawMeta?.partialFail ? { partialFail: true } : {}),
    });
  } catch (err) {
    return _mkRes("hepsiburada", false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      region,
      timeoutMs,
      status: err?.status || err?.response?.status || null,
      httpCode: err?.code || null,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}


export const searchHepsiburada = searchHepsiburadaAdapter;

export default {
  searchHepsiburada,
  searchHepsiburadaScrape,
  searchHepsiburadaAdapter,
};


// S200: legacy raw array access (ZERO DELETE)
export async function searchHepsiburadaLegacy(query, regionOrOptions = "TR") {
  return await searchHepsiburadaScrape(query, regionOrOptions);
}
