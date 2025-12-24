// server/adapters/mngTurAdapter.js
// ============================================================================
// MNG TUR — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S8/S22 tabanı korunur; S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// withTimeout everywhere + global ctx set
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

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
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// HELPERS (kept)
// ---------------------------------------------------------------------------
const clean = (v) => safeStr(v, 1600).trim();

function parsePrice(v) {
  if (!v) return null;
  return Number(
    String(v).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")
  );
}

function detectTourCategory(title = "") {
  const t = String(title || "").toLowerCase();
  if (/yurt.d..|europe|italya|balkan|thai|japon|asya|amerika/.test(t))
    return "international_tour";
  if (/kapadokya|karadeniz|antalya|ege|akdeniz/.test(t))
    return "domestic_tour";
  return "tour";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.price) s += 0.35;
  if (item.title?.length > 8) s += 0.25;
  if (item.image) s += 0.25;
  return Number(s.toFixed(2));
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source: "mngtur", _meta: { ...meta } };
}

// ---------------------------------------------------------------------------
// ENV + Affiliate (kept)
// ---------------------------------------------------------------------------
const BASE = process.env.MNG_BASE_URL || "https://www.mngtur.com.tr";
const AFF_ID = process.env.MNG_AFFILIATE_ID || "";
const SUBKEY = process.env.MNG_SUBID_KEY || "aff_id";
const REDIRECT = process.env.MNG_REDIRECT || "";

function buildAffiliateUrl(url) {
  if (!url) return url;

  if (REDIRECT) {
    return `${REDIRECT}${encodeURIComponent(url)}&${SUBKEY}=${AFF_ID}`;
  }

  try {
    const u = new URL(url);
    if (AFF_ID) u.searchParams.set(SUBKEY, AFF_ID);
    return u.toString();
  } catch {
    return url;
  }
}

// Absolute URL fix (kept)
function abs(base, href) {
  return href?.startsWith("http") ? href : base + href;
}

// ---------------------------------------------------------------------------
// SELECTORS (kept)
// ---------------------------------------------------------------------------
const SELECTORS = [
  ".tour-item",
  ".package-item",
  ".result-card",
  ".tourBox",
  ".item-tur",
  ".tour-card",
  ".tour",
];

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MNGTUR_TIMEOUT_MS || 12000);

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
    if (Number.isFinite(Number(regionOrOptions.timeoutMs))) {
      timeoutMs = Math.max(1200, Math.min(20000, Number(regionOrOptions.timeoutMs)));
    }
  }
  return { region: String(region || "TR").toUpperCase(), signal, timeoutMs };
}

// ============================================================================
// MAIN — S200 SEARCH (strict)
// ============================================================================
export async function searchMNGTur(query, regionOrOptions = "TR") {
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);

  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  const searchUrl = `${BASE}/arama?q=${encodeURIComponent(q)}`;
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "mngtur_adapter", providerKey: "mngtur", url: searchUrl };

  try {
    let html = null;

    // proxy-first
    try {
      html = await withTimeout(proxyFetchHTML(searchUrl), timeoutMs, "mngtur.proxyFetch");
    } catch (e) {
      const res = await withTimeout(
        axios.get(searchUrl, {
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            Accept: "text/html",
          },
        }),
        timeoutMs,
        "mngtur.axiosFetch"
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url: searchUrl, region, timeoutMs });

    const $ = loadCheerioS200(html, { adapter: "mngtur_adapter", providerKey: "mngtur", url: searchUrl });
    const candidates = [];

    $(SELECTORS.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        clean(wrap.find(".tour-title").text()) ||
        clean(wrap.find(".package-title").text()) ||
        clean(wrap.find("h3").text()) ||
        clean(wrap.find("h2").text()) ||
        null;

      if (!title) return;

      const priceTxt =
        clean(wrap.find(".price").text()) ||
        clean(wrap.find(".amount").text()) ||
        clean(wrap.find(".tour-price").text()) ||
        "";

      const priceRaw = parsePrice(priceTxt);
      const price = sanitizePrice(priceRaw);
      const optimizedPrice = optimizePrice({ price }, { provider: "mngtur" });

      let href =
        clean(wrap.find("a").attr("href")) ||
        clean(wrap.find(".tour-link").attr("href"));

      if (!href) return;

      const absUrl = abs(BASE, href);
      const affiliateUrl = buildAffiliateUrl(absUrl);

      let img =
        clean(wrap.find("img").attr("data-src")) ||
        clean(wrap.find("img").attr("src")) ||
        null;

      const image = buildImageVariants(img);

      const categoryAI = detectTourCategory(title);
      const qScore = computeQualityScore({ title, price, image: img });

      const id = stableIdS200("mngtur", affiliateUrl || absUrl, title);

      candidates.push({
        id,
        title,
        price,
        optimizedPrice,
        provider: "travel",
        providerFamily: "travel",
        providerKey: "mngtur",
        providerType: "provider",

        currency: "TRY",
        region: region.toUpperCase(),
        vertical: "travel",
        category: "tour",
        categoryAI,
        qualityScore: qScore,

        url: affiliateUrl || absUrl,
        deeplink: affiliateUrl || absUrl,
        originUrl: absUrl,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        raw: { title, priceTxt, href: absUrl, affiliateUrl, img },
      });
    });

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, "mngtur", {
        providerFamily: "travel",
        vertical: "travel",
        category: "tour",
        region,
        currency: "TRY",
        baseUrl: BASE,
      });
      if (n) normalized.push(n);
    }

    // de-dupe
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
      url: searchUrl,
      region,
      ms: Date.now(),
      timeoutMs,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      region,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// EXPORT SET — names preserved (ZERO DELETE)
// ============================================================================
export const searchMNGTurAdapter = searchMNGTur;
export const searchMngTurScrape = searchMNGTur;
export const searchMngTurAdapter = searchMNGTur;

export default {
  searchMNGTur,
  searchMNGTurAdapter,
  searchMngTurScrape,
  searchMngTurAdapter,
};
