// server/adapters/medicalparkAdapter.js
// ============================================================================
// MEDICAL PARK — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - NO FAKE RESULTS in PROD: fallback/stub only if FINDALLEASY_ALLOW_STUBS=1
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - withTimeout everywhere + global ctx set
// ZERO DELETE: eski array-search davranışı LEGACY export ile korunur
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
  return { ok: !!ok, items: arr, count: arr.length, source: "medicalpark", _meta: { ...meta } };
}

function parseRegionOptions(regionOrOptions = "TR", signal = null) {
  let region = "TR";
  let sig = signal;
  let timeoutMs = Number(process.env.MEDICALPARK_TIMEOUT_MS || 13000);

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

// ----------------------------------------------------------------------
// CORE SEARCH (internal) — returns raw items array
// ----------------------------------------------------------------------
async function scrapeMedicalparkRaw(query, region = "TR", signal = null, timeoutMs = 13000) {
  const q = clean(query);
  if (!q) return [];

  const url = `https://www.medicalpark.com.tr/arama?search=${encodeURIComponent(q)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "medicalpark_adapter", providerKey: "medicalpark", url };

  try {
    let html = null;

    // ProxyFetch → bypass
    try {
      html = await withTimeout(proxyFetchHTML(url), timeoutMs, "medicalpark.proxyFetch");
    } catch {
      const res = await withTimeout(
        axios.get(url, {
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            "Accept-Language": "tr-TR,tr;q=0.9",
          },
        }),
        timeoutMs,
        "medicalpark.axiosFetch"
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) return [];

    const $ = loadCheerioS200(html, { adapter: "medicalpark_adapter", providerKey: "medicalpark", url });
    const itemsRaw = [];

    const selectors = [
      ".search-item",
      ".result-item",
      ".list-item",
      ".package-item",
      ".treatment-item",
      "[data-id]",
    ];

    $(selectors.join(",")).each((i, el) => {
      const root = $(el);

      const title =
        clean(root.find(".title, .search-title, .item-title, h2, h3").first().text()) || null;
      if (!title) return;

      const desc =
        clean(root.find(".desc, .text, .summary, .content, p").first().text()) || null;

      let href =
        root.find("a").attr("href") ||
        root.find(".title a").attr("href") ||
        null;

      if (href && !href.startsWith("http")) {
        href = `https://www.medicalpark.com.tr${href}`;
      }
      if (!href) return;

      const priceTxt =
        clean(root.find(".price, .package-price, .value, .fee").first().text()) || null;

      const parsed = parsePriceS200(priceTxt);
      const price = sanitizePrice(parsed);
      const optimizedPrice = optimizePrice({ price }, { provider: "medicalpark" });

      const imageRaw =
        root.find("img").attr("src") ||
        root.find("img").attr("data-src") ||
        root.find("img").attr("data-original") ||
        null;

      const image = buildImageVariants(imageRaw);

      itemsRaw.push({
        id: stableIdS200("medicalpark", href, title),
        title,
        description: desc,
        price,
        optimizedPrice,

        provider: "health",
        providerFamily: "health",
        providerKey: "medicalpark",
        providerType: "provider",

        category: "service",
        categoryAI: "health",

        currency: "TRY",
        region: String(region || "TR").toUpperCase(),

        url: href,
        deeplink: href,
        originUrl: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        fallback: false,
        raw: { title, desc, priceTxt, href, imageRaw },
      });
    });

    return itemsRaw;
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ----------------------------------------------------------------------
// LEGACY ARRAY EXPORT — ZERO DELETE (old behavior preserved, but PROD-safe)
// ----------------------------------------------------------------------
export async function searchMedicalparkAdapterLegacy(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions, signal);

  try {
    const raw = await scrapeMedicalparkRaw(query, region, sig, timeoutMs);
    const normalized = [];
    for (const it of coerceItemsS200(raw)) {
      const n = normalizeItemS200(it, "medicalpark", {
        providerFamily: "health",
        vertical: "health",
        category: "service",
        region,
        currency: "TRY",
        baseUrl: "https://www.medicalpark.com.tr",
        requireRealUrlCandidate: true,
      });
      if (n) normalized.push(n);
    }
    return normalized;
  } catch (err) {
    if (FINDALLEASY_ALLOW_STUBS) {
      return [
        {
          provider: "health",
          providerKey: "medicalpark",
          title: `Medical Park erişilemedi (${clean(query)})`,
          price: null,
          optimizedPrice: null,
          category: "health",
          region,
          fallback: true,
        },
      ];
    }
    return [];
  }
}

// ----------------------------------------------------------------------
// S200 WRAPPER — strict output (PRIMARY)
// ----------------------------------------------------------------------
export async function searchMedicalparkAdapter(query, regionOrOptions = "TR") {
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);

  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  const url = `https://www.medicalpark.com.tr/arama?search=${encodeURIComponent(q)}`;

  try {
    const raw = await scrapeMedicalparkRaw(q, region, signal, timeoutMs);

    const normalized = [];
    for (const it of coerceItemsS200(raw)) {
      const n = normalizeItemS200(it, "medicalpark", {
        providerFamily: "health",
        vertical: "health",
        category: "service",
        region,
        currency: "TRY",
        baseUrl: "https://www.medicalpark.com.tr",
        requireRealUrlCandidate: true,
      });
      if (n) normalized.push(n);
    }

    // dedupe
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
      const stub = normalizeItemS200({
        title: `Medical Park erişilemedi (${q})`,
        url,
        price: null,
        provider: "health",
        providerFamily: "health",
        providerKey: "medicalpark",
        region,
        fallback: true,
      }, "medicalpark", {
        providerFamily: "health",
        vertical: "health",
        category: "service",
        region,
        currency: "TRY",
        baseUrl: "https://www.medicalpark.com.tr",
      });
      return _mkRes(true, [stub].filter(Boolean), {
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

export default {
  searchMedicalparkAdapter,        // S200 wrapper (primary)
  searchMedicalparkAdapterLegacy,  // legacy array
};
