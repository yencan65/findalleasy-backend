// server/adapters/watsonsAdapter.js
// ============================================================================
// WATSONS TURKIYE — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE)
// - Output: { ok, items, count, source, _meta }
// - Contract: title+url required, price<=0 => null
// - NO FAKE: fetch/parse fail => ok:false + items:[]
// - Deterministic id: stableIdS200(providerKey,url,title)
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// - withTimeout: all network calls
// ============================================================================
// ZERO DELETE: mevcut yardımcılar korunur; sadece S200 pipeline'a bağlandı.

import axios from "axios";
import * as cheerio from "cheerio"; // legacy import (kept)

import { proxyFetchHTML } from "../core/proxyEngine.js";

// S21 fiyat motoru (kept)
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

// Görsel motoru (kept)
import { buildImageVariants } from "../utils/imageFixer.js";

// Affiliate motoru (kept)
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  withTimeout,
  TimeoutError,
  fixKey,
} from "../core/s200AdapterKit.js";

const BASE = "https://www.watsons.com.tr";
const MAX_PAGES = 3;
const PROVIDER_KEY = fixKey("watsons") || "watsons";

// --------------------------------------------------------------
// HELPERS (kept)
// --------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Legacy stable id helper (kept) — S200 uses stableIdS200 via normalizeItemS200
function buildStableId(href, title) {
  try {
    if (href) return "watsons_" + Buffer.from(href).toString("base64");
    return "watsons_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

// --------------------------------------------------------------
// NETWORK — direct + proxy (S200 timeout/observable fail)
// --------------------------------------------------------------
async function fetchHTMLWithProxy(url, config = {}) {
  const timeoutMs = Math.max(800, Math.min(20000, Number(config.timeout) || 14000));
  const headers = config.headers || {};
  const signal = config.signal;

  // 1) direct first (fast)
  try {
    const res = await withTimeout(
      axios.get(url, {
        timeout: Math.min(timeoutMs + 800, 22000),
        headers,
        ...(signal ? { signal } : {}),
      }),
      timeoutMs,
      `${PROVIDER_KEY}_direct`
    );
    return res?.data || null;
  } catch (e1) {
    // 2) proxy fallback
    try {
      const html = await withTimeout(
        proxyFetchHTML(url),
        timeoutMs,
        `${PROVIDER_KEY}_proxy`
      );
      return html || null;
    } catch {
      return null;
    }
  }
}

// --------------------------------------------------------------
// Proxy destekli tek sayfa scrape (observable fail)
// --------------------------------------------------------------
async function scrapeWatsonsPage(query, page = 1, options = {}) {
  const { signal, region = "TR" } = options;

  const q = safe(query);
  const pageNo = Number(page) || 1;
  const url = `${BASE}/search?q=${encodeURIComponent(q)}&page=${pageNo}`;

  try {
    // ctx: kit logları "unknown" demesin
    try {
      globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, providerKey: PROVIDER_KEY, url, page: pageNo };
    } catch {}

    const html = await fetchHTMLWithProxy(url, {
      signal,
      timeout: Number(options.timeoutMs) || 14000,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
        ...(options.headers || {}),
      },
    });

    if (!html) {
      return {
        ok: false,
        items: [],
        count: 0,
        _meta: { page: pageNo, url, code: "FETCH_FAIL" },
      };
    }

    const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url });

    const items = [];
    const seen = new Set();

    // Watsons tile selectors
    const sel = ".product-tile, .product-tile__content, [data-product-code]";
    $(sel).each((i, el) => {
      try {
        const title =
          safe($(el).find(".product-tile__name, .product-tile__name span").first().text()) ||
          safe($(el).find("a").first().attr("title")) ||
          safe($(el).find("a").first().text());

        if (!title) return;

        const href =
          safe($(el).find("a.product-tile__image-wrapper").attr("href")) ||
          safe($(el).find("a").first().attr("href"));

        const fullUrl = href
          ? (href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`)
          : "";

        if (!fullUrl) return;

        const key = fullUrl + "|" + title;
        if (seen.has(key)) return;
        seen.add(key);

        const priceTxt =
          safe($(el).find(".product-sales-price").text()) ||
          safe($(el).find(".price, .product-price").text());

        const rawPrice = parsePrice(priceTxt);
        const sanitized = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "product" });

        const affiliateUrl = buildAffiliateUrlS10({ url: fullUrl, provider: PROVIDER_KEY });

        let imgRaw =
          safe($(el).find("img.product-tile__image").attr("src")) ||
          safe($(el).find("img.product-tile__image").attr("data-src")) ||
          safe($(el).find("img").first().attr("src")) ||
          safe($(el).find("img").first().attr("data-src"));

        if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;

        const imageVariants = buildImageVariants(imgRaw || null, PROVIDER_KEY);

        let item = {
          title,
          price: sanitized,
          priceText: priceTxt,

          currency: "TRY",
          region: String(region || "TR").toUpperCase(),

          url: fullUrl,
          originUrl: fullUrl,
          affiliateUrl,

          image: imageVariants.image,
          // ekstra varyantlar normalize sonrası eklenecek
          _imageVariants: imageVariants,

          rating: null,
          category: "product",
          raw: { title, priceTxt, url: fullUrl, imgRaw },
        };

        item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "product" });
        items.push(item);
      } catch {
        // ignore single item parse crash
      }
    });

    return {
      ok: true,
      items,
      count: items.length,
      _meta: { page: pageNo, url, code: "OK" },
    };
  } catch (err) {
    const isTimeout =
      err instanceof TimeoutError || /timed\s*out/i.test(String(err?.message || err || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      _meta: {
        page: pageNo,
        url,
        code: isTimeout ? "TIMEOUT" : "SCRAPE_FAIL",
        error: err?.message || String(err),
      },
    };
  }
}

// --------------------------------------------------------------
// Final Multi-page Adapter — S200
// --------------------------------------------------------------
export async function searchWatsonsAdapter(query, options = {}) {
  const t0 = Date.now();
  const q = safe(query);

  const providerKey = PROVIDER_KEY;
  const providerFamily = fixKey(options.providerFamily || options.family || "product") || "product";

  const region = safe(options.region || "TR") || "TR";
  const signal = options.signal;

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1200, Math.min(16000, options.timeoutMs)) : 6500;
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(1, Math.min(120, options.maxItems)) : 60;

  if (!q) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      provider: providerFamily,
      providerKey,
      providerFamily,
      _meta: { adapter: providerKey, code: "EMPTY_QUERY", ms: Date.now() - t0 },
    };
  }

  // ctx: kit logları "unknown" demesin
  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, providerKey, providerFamily, query: q };
  } catch {}

  const pageMeta = [];
  const pageErrors = [];

  const normalized = [];
  const seenIds = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await withTimeout(
      scrapeWatsonsPage(q, page, { region, signal, timeoutMs }),
      timeoutMs + 700,
      `${providerKey}_page_${page}`
    );

    pageMeta.push(r?._meta || { page });

    if (!r?.ok) {
      pageErrors.push(r?._meta || { page, code: "PAGE_FAIL" });
      if (!normalized.length) break; // ilk sayfa patladıysa boşuna devam etme
      continue; // partial success: page2 vs fail olabilir
    }

    const rawItems = Array.isArray(r.items) ? r.items : [];
    if (!rawItems.length) break;

    for (const it of rawItems) {
      const n = normalizeItemS200(it, providerKey, {
        providerFamily,
        vertical: "product",
        category: "product",
        baseUrl: BASE,
        region,
      });
      if (!n) continue;

      // image variants preserve (optional)
      if (it?._imageVariants && typeof it._imageVariants === "object") {
        n.imageOriginal = it._imageVariants.imageOriginal || null;
        n.imageProxy = it._imageVariants.imageProxy || null;
        n.hasProxy = !!it._imageVariants.hasProxy;
      }

      if (seenIds.has(n.id)) continue;
      seenIds.add(n.id);
      normalized.push(n);
      if (normalized.length >= maxItems) break;
    }

    if (normalized.length >= maxItems) break;
  }

  return {
    ok: normalized.length > 0,
    items: normalized,
    count: normalized.length,
    source: providerKey,
    provider: providerFamily,
    providerKey,
    providerFamily,
    _meta: {
      adapter: providerKey,
      query: q,
      region,
      timeoutMs,
      pagesTried: MAX_PAGES,
      pages: pageMeta,
      pageErrors: pageErrors.length ? pageErrors : undefined,
      ms: Date.now() - t0,
    },
  };
}

export default { searchWatsonsAdapter };
