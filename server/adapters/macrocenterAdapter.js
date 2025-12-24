// server/adapters/macrocenterAdapter.js
// ============================================================================
// MACROCENTER — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - NO FAKE RESULTS in PROD: fallback/stub only if FINDALLEASY_ALLOW_STUBS=1
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - URL priority handled by kit normalizer
// - withTimeout everywhere + global ctx set
// ZERO DELETE: mevcut exports korunur (searchMacroCenter alias dahil)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
  parsePriceS200,
} from "../core/s200AdapterKit.js";

// Clean helper
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";
const clean = (v) => safeStr(v, 1800).trim();

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source: "macrocenter", _meta: { ...meta } };
}

function parseRegionOptions(regionOrOptions = "TR", signal = null) {
  let region = "TR";
  let sig = signal;
  let timeoutMs = Number(process.env.MACROCENTER_TIMEOUT_MS || 12000);

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    sig = regionOrOptions.signal || sig;
    if (Number.isFinite(Number(regionOrOptions.timeoutMs))) {
      timeoutMs = Math.max(1200, Math.min(20000, Number(regionOrOptions.timeoutMs)));
    }
  }

  return { region: String(region || "TR").toUpperCase(), signal: sig, timeoutMs };
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// ============================================================================
// RAW SCRAPER (returns array) — kept for legacy use
// ============================================================================
async function scrapeMacrocenterRaw(query, region = "TR", signal = null, timeoutMs = 12000) {
  const q = encodeURIComponent(query);
  const url = `https://www.macrocenter.com.tr/arama?q=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "macrocenter_adapter", providerKey: "macrocenter", url };

  try {
    await wait(120);

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Accept: "text/html,application/xhtml+xml",
    };

    let html = null;

    // proxy-first (anti-bot)
    try {
      html = await withTimeout(proxyFetchHTML(url), timeoutMs, "macrocenter.proxyFetch");
    } catch {
      const res = await withTimeout(
        axios.get(url, {
          headers,
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          signal,
        }),
        timeoutMs,
        "macrocenter.axiosFetch"
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) return [];

    const $ = loadCheerioS200(html, { adapter: "macrocenter_adapter", providerKey: "macrocenter", url });
    const results = [];

    $(".product-item, .product, .product-card, .product-list-item").each((i, el) => {
      const root = $(el);

      const title =
        clean(root.find(".product-title, .title, .product-name").first().text()) || null;

      let href =
        root.find("a").attr("href") ||
        root.find("a.product-link").attr("href") ||
        null;

      if (!title) return;
      if (!href) return;

      const finalUrl = href.startsWith("http")
        ? href
        : `https://www.macrocenter.com.tr${href}`;

      const priceText =
        clean(
          root
            .find(".product-price, .price, .current-price, .product-price-area")
            .first()
            .text()
        ) || null;

      const parsed = parsePriceS200(priceText);
      const price = sanitizePrice(parsed);
      const optimizedPrice = optimizePrice({ price }, { provider: "macrocenter" });

      const imageRaw =
        root.find("img").attr("src") ||
        root.find("img").attr("data-src") ||
        null;

      const image = buildImageVariants(imageRaw);

      results.push({
        id: stableIdS200("macrocenter", finalUrl, title),
        title,
        price,
        optimizedPrice,

        provider: "market",
        providerFamily: "market",
        providerKey: "macrocenter",
        providerType: "retailer",

        currency: "TRY",
        region,

        vertical: "market",
        category: "product",
        categoryAI: "product",

        url: finalUrl,
        deeplink: finalUrl,
        originUrl: finalUrl,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        fallback: false,
        raw: { title, priceText, href: finalUrl, imageRaw },
      });
    });

    return results.slice(0, 50);
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// S200 MAIN — unified output
// ============================================================================
export async function searchMacrocenterAdapter(query, regionOrOptions = "TR", signal = null) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions, signal);
  const q = clean(query);

  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  const url = `https://www.macrocenter.com.tr/arama?q=${encodeURIComponent(q)}`;

  try {
    const raw = await scrapeMacrocenterRaw(q, region, sig, timeoutMs);

    const normalized = [];
    for (const it of coerceItemsS200(raw)) {
      const n = normalizeItemS200(it, "macrocenter", {
        providerFamily: "market",
        vertical: "market",
        category: "product",
        region,
        currency: "TRY",
        baseUrl: "https://www.macrocenter.com.tr",
        requireRealUrlCandidate: true,
      });
      if (n) normalized.push(n);
    }

    const seen = new Set();
    const items = [];
    for (const it of normalized) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(it);
    }

    return _mkRes(true, items, {
      code: items.length ? "OK" : "OK_EMPTY",
      region,
      timeoutMs,
      url,
    });
  } catch (err) {
    // NO FAKE RESULTS in PROD
    if (FINDALLEASY_ALLOW_STUBS) {
      return _mkRes(true, [
        normalizeItemS200({
          title: `MacroCenter erişilemedi (${q})`,
          url,
          price: null,
          region,
          providerKey: "macrocenter",
          providerFamily: "market",
          provider: "market",
          fallback: true,
        }, "macrocenter", {
          providerFamily: "market",
          vertical: "market",
          category: "product",
          region,
          currency: "TRY",
          baseUrl: "https://www.macrocenter.com.tr",
        })
      ].filter(Boolean), {
        code: _isTimeout(err) ? "TIMEOUT_STUB" : "ERROR_STUB",
        error: _errStr(err),
        region,
        timeoutMs,
        url,
      });
    }

    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      region,
      timeoutMs,
      url,
    });
  }
}

// Alias (ZERO DELETE)
export const searchMacroCenter = async (query, opts = {}) =>
  await searchMacrocenterAdapter(query, opts);

// Default export (ZERO DELETE)
export default {
  searchMacrocenterAdapter,
  searchMacroCenter,
};
