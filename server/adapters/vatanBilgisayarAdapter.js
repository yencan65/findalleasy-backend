// server/adapters/vatanBilgisayarAdapter.js
// ============================================================================
// VATAN BILGISAYAR — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE)
// - Output: { ok, items, count, source, _meta }
// - Contract: title+url required, price<=0 => null
// - Deterministic id: stableIdS200(providerKey,url,title) via normalizeItemS200
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// - NO FAKE: fetch/parse fail => ok:false + items:[]
// - withTimeout: all network calls
// ============================================================================
// ZERO DELETE: scraper mantığı korunur; sadece S200 pipeline'a bağlandı.

import axios from "axios";
import * as cheerio from "cheerio"; // legacy import (kept)

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  withTimeout,
  TimeoutError,
  fixKey,
} from "../core/s200AdapterKit.js";

const BASE = "https://www.vatanbilgisayar.com";
const PROVIDER_KEY = fixKey("vatan") || "vatan";

// --------------------------------------------------------------
// HELPERS (kept)
// --------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(t) {
  if (!t) return null;
  const cleaned = String(t).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Legacy stable id helper (kept) — S200 uses stableIdS200 via normalizeItemS200
function buildStableId(href, title) {
  try {
    if (href) return "vatan_" + Buffer.from(href).toString("base64");
    return "vatan_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

// DIRECT + PROXY fetch (hardened)
async function fetchHTMLWithProxy(url, config = {}) {
  const timeoutMs = Math.max(800, Math.min(20000, Number(config.timeout) || 15000));
  const signal = config.signal;

  try {
    const direct = await withTimeout(
      axios.get(url, {
        timeout: Math.min(timeoutMs + 800, 22000),
        ...(config.headers ? { headers: config.headers } : {}),
        ...(signal ? { signal } : {}),
      }),
      timeoutMs,
      `${PROVIDER_KEY}_direct`
    );
    return direct?.data || null;
  } catch (err) {
    try {
      const html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${PROVIDER_KEY}_proxy`);
      return html || null;
    } catch {
      return null;
    }
  }
}

// Normalize helper (kept name) — now KIT-LOCKED S200
function normalizeS200(raw, region = "TR") {
  if (!raw) return null;

  const title = safe(raw.title);
  const href = safe(raw.href);

  const url = href && href.startsWith("http") ? href : (href ? BASE + (href.startsWith("/") ? "" : "/") + href : "");
  if (!title || !url) return null;

  const imgRaw = safe(raw.imgRaw);
  const priceText = safe(raw.priceText);

  const deeplink = buildAffiliateUrlS10({ url, provider: PROVIDER_KEY });

  const imageVariants = buildImageVariants(imgRaw || null, PROVIDER_KEY);

  let item = {
    title,
    price: raw.price ?? null,
    priceText,

    currency: "TRY",
    region: String(region || "TR").toUpperCase(),

    url,
    originUrl: url,
    deeplink,
    affiliateUrl: deeplink,

    image: imageVariants.image,
    _imageVariants: imageVariants,

    category: raw.category || "product",
    raw: {
      title,
      priceText,
      href: url,
      imgRaw,
      source: raw,
    },
  };

  // S21 optimize — kept
  item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: item.category });

  const providerFamily = fixKey(raw.providerFamily || "product") || "product";
  const n = normalizeItemS200(item, PROVIDER_KEY, {
    providerFamily,
    vertical: "product",
    category: item.category || "product",
    baseUrl: BASE,
    region,
  });

  if (!n) return null;

  // image variants preserve (optional)
  if (item?._imageVariants && typeof item._imageVariants === "object") {
    n.imageOriginal = item._imageVariants.imageOriginal || null;
    n.imageProxy = item._imageVariants.imageProxy || null;
    n.hasProxy = !!item._imageVariants.hasProxy;
  }

  return n;
}

// --------------------------------------------------------------
// MAIN — signature preserved (legacy callers) but output is S200 wrapper
// --------------------------------------------------------------
export async function searchVatanBilgisayarAdapter(query, regionOrOptions = "TR", _signal = null) {
  const t0 = Date.now();

  let region = "TR";
  let options = {};
  let signal = _signal;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (typeof regionOrOptions === "object" && regionOrOptions) {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
    signal = regionOrOptions.signal || _signal;
  }

  const q = safe(query);
  const providerKey = PROVIDER_KEY;
  const providerFamily = fixKey(options.providerFamily || options.family || "product") || "product";
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

  const searchUrl = `${BASE}/arama/?q=${encodeURIComponent(q)}`;

  const headers = {
    "User-Agent":
      options.userAgent ||
      "Mozilla/5.0 (FindAllEasy-S200)",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  // S8 delay — ZERO DELETE
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(150);

  // ctx: kit logları "unknown" demesin
  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, providerKey, providerFamily, url: searchUrl, query: q };
  } catch {}

  let html = null;
  try {
    html = await withTimeout(
      fetchHTMLWithProxy(searchUrl, { signal, timeout: timeoutMs, headers }),
      timeoutMs + 700,
      `${providerKey}_fetch`
    );
  } catch (e) {
    const isTimeout =
      e instanceof TimeoutError || /timed\s*out/i.test(String(e?.message || e || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      provider: providerFamily,
      providerKey,
      providerFamily,
      _meta: {
        adapter: providerKey,
        code: isTimeout ? "TIMEOUT" : "FETCH_FAIL",
        url: searchUrl,
        error: e?.message || String(e),
        timeoutMs,
        ms: Date.now() - t0,
      },
    };
  }

  if (!html) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      provider: providerFamily,
      providerKey,
      providerFamily,
      _meta: { adapter: providerKey, code: "FETCH_EMPTY", url: searchUrl, timeoutMs, ms: Date.now() - t0 },
    };
  }

  let $;
  try {
    $ = loadCheerioS200(html, { adapter: providerKey, url: searchUrl });
  } catch (e) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      provider: providerFamily,
      providerKey,
      providerFamily,
      _meta: { adapter: providerKey, code: "HTML_PARSE_FAIL", error: e?.message || String(e), ms: Date.now() - t0 },
    };
  }

  const out = [];
  const seenIds = new Set();

  const selectors = [
    ".product-list .product-list__product",
    ".plp-product",
    ".product-wrapper",
    ".product-list__item",
  ];

  $(selectors.join(",")).each((i, el) => {
    const root = $(el);

    const title = safe(
      root
        .find(".product-list__product-name, .plp-product-name")
        .first()
        .text()
    );

    if (!title) return;

    const priceText = safe(
      root
        .find(".product-list__product-price, .plp-product-price, .price")
        .first()
        .text()
    );

    const rawPrice = parsePrice(priceText);
    const sanitized = sanitizePrice(rawPrice, { provider: providerKey, category: "product" });

    let href = safe(root.find("a").attr("href"));
    if (href && !href.startsWith("http")) href = BASE + href;

    if (!href) return;

    let imgRaw =
      safe(root.find("img").attr("src")) ||
      safe(root.find("img").attr("data-src"));

    if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;

    const optimized = optimizePrice({ price: sanitized }, { provider: providerKey, region });

    const n = normalizeS200(
      {
        title,
        price: optimized?.price ?? sanitized,
        priceText,
        href,
        imgRaw,
        category: "product",
        providerFamily,
      },
      region
    );

    if (!n) return;

    if (seenIds.has(n.id)) return;
    seenIds.add(n.id);
    out.push(n);
  });

  const items = out.slice(0, maxItems);

  return {
    ok: items.length > 0,
    items,
    count: items.length,
    source: providerKey,
    provider: providerFamily,
    providerKey,
    providerFamily,
    _meta: {
      adapter: providerKey,
      query: q,
      url: searchUrl,
      region,
      timeoutMs,
      parsed: out.length,
      returned: items.length,
      ms: Date.now() - t0,
    },
  };
}

export default { searchVatanBilgisayarAdapter };
