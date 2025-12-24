// server/adapters/macfitAdapter.js
// ============================================================================
// MACFIT — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - NO FAKE RESULTS in PROD: fallback/stub only if FINDALLEASY_ALLOW_STUBS=1
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - withTimeout everywhere + global ctx set (kit loglarında "unknown" azalır)
// ZERO DELETE: mevcut işlevler korunur, sadece S200 standardına yükseltilir
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
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------
// HELPERS (kept / strengthened)
// ---------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

const safe = (v) => (v == null ? "" : String(v).trim());
const clean = (v) => safeStr(v, 1800).trim();

function stableId(seed, index = 0) {
  // ZERO DELETE: signature kept, but now S200-stable (NO index-based drift)
  return stableIdS200("macfit", String(seed || ""), String(seed || "macfit"));
}

function detectCategoryAI() {
  return "sport";
}

function extractGeoSignal(title = "", address = "") {
  const t = (title + " " + address).toLowerCase();
  const cities = ["istanbul", "ankara", "izmir", "antalya", "bursa", "adana", "konya"];
  return cities.find((c) => t.includes(c)) || null;
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title?.length > 3) s += 0.2;
  if (item.address) s += 0.2;
  if (item.image) s += 0.3;
  s += 0.3; // provider reliability boost
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
  return {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: "macfit",
    _meta: { ...meta },
  };
}

function parseRegionOptions(regionOrOptions = "TR", signal = null) {
  let region = "TR";
  let sig = signal;
  let timeoutMs = Number(process.env.MACFIT_TIMEOUT_MS || 12000);

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

// ============================================================================
//  SCRAPER — S200 (proxy + fallback)  (ZERO DELETE: intent preserved)
// ============================================================================
async function scrapeMACFit(region = "TR", query = "", signal = null) {
  const url = "https://www.macfit.com.tr/tr/spor-salonu-bul";
  const t0 = Date.now();

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "macfit_adapter", providerKey: "macfit", url };

  try {
    let html = null;

    // PROXY BYPASS (anti-bot)
    try {
      html = await withTimeout(proxyFetchHTML(url), Number(process.env.MACFIT_FETCH_MS || 15000), "macfit.proxyFetch");
    } catch {
      const res = await withTimeout(
        axios.get(url, {
          timeout: 15000,
          signal,
          headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
        }),
        Number(process.env.MACFIT_FETCH_MS || 15000),
        "macfit.axiosFetch"
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url, ms: Date.now() - t0 });

    const $ = loadCheerioS200(html, { adapter: "macfit_adapter", providerKey: "macfit", url });
    const results = [];

    const selectors = [
      ".club-item",
      ".club-card",
      ".gym-card",
      "[data-club]",
      ".salon-card",
    ];

    $(selectors.join(",")).each((i, el) => {
      const name =
        clean($(el).find(".club-name").text()) ||
        clean($(el).find(".name").text()) ||
        clean($(el).find("h3").text());

      if (!name) return;

      const address =
        clean($(el).find(".club-address").text()) ||
        clean($(el).find(".address").text());

      let href = clean($(el).find("a").attr("href"));
      if (href && !href.startsWith("http")) {
        href = "https://www.macfit.com.tr" + href;
      }

      // MACFit bazı kartlarda link vermeyebilir; gerçek (tıklanabilir) bir URL lazım.
      // Link yoksa listeleme sayfasını kullanırız (fake değil, gerçek sayfa).
      const realUrl = href || url;

      const imgRaw =
        clean($(el).find("img").attr("data-src")) ||
        clean($(el).find("img").attr("src")) ||
        null;

      const image = buildImageVariants(imgRaw);

      const categoryAI = detectCategoryAI();
      const geoSignal = extractGeoSignal(name, address);
      const qualityScore = computeQualityScore({ title: name, address, image: imgRaw });

      // MACFit fiyat listelemez → null
      const price = sanitizePrice(null);
      const optimizedPrice = optimizePrice({ price }, { provider: "macfit" });

      results.push({
        // id deterministik
        id: stableIdS200("macfit", realUrl, name),

        provider: "sport",
        providerFamily: "sport",
        providerKey: "macfit",
        providerType: "provider",

        title: name,
        address,

        price,
        optimizedPrice,

        category: "sport",
        categoryAI,
        geoSignal,
        qualityScore,

        currency: "TRY",
        region: region.toUpperCase(),

        url: realUrl,
        deeplink: realUrl,
        originUrl: realUrl,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        fallback: false,

        raw: { name, address, href, imgRaw },
      });
    });

    // normalize + dedupe
    const normalized = [];
    for (const it of coerceItemsS200(results)) {
      const n = normalizeItemS200(it, "macfit", {
        providerFamily: "sport",
        vertical: "sport",
        category: "sport",
        region,
        currency: "TRY",
        baseUrl: "https://www.macfit.com.tr",
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
      url,
      ms: Date.now() - t0,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      url,
      ms: Date.now() - t0,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
//  LEGACY MAIN SEARCH — ZERO DELETE (returns array)
// ============================================================================
export async function searchMACFit(query = "", regionOrOptions = "TR") {
  const { region, signal } = parseRegionOptions(regionOrOptions);

  const res = await searchMACFitAdapter(query, { region, signal });
  if (Array.isArray(res?.items) && res.items.length) return res.items;

  // NO FAKE RESULTS in PROD
  if (FINDALLEASY_ALLOW_STUBS) {
    return [
      {
        provider: "sport",
        providerKey: "macfit",
        title: "MACFit sonuç bulunamadı",
        price: null,
        optimizedPrice: null,
        category: "sport",
        region,
        fallback: true,
      },
    ];
  }

  return [];
}

// ============================================================================
//  S200 WRAPPER — unified output (strict)
// ============================================================================
export async function searchMACFitAdapter(query, regionOrOptions = "TR") {
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);

  const q = clean(query);
  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  // Note: query MACFit salon sayfasında birebir kullanılmıyor; future-proof metadata.
  try {
    const res = await scrapeMACFit(region, q, signal);
    return _mkRes(res.ok, res.items, {
      ...res._meta,
      region,
      timeoutMs,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      region,
      timeoutMs,
    });
  }
}

export const searchMACFitScrape = searchMACFit;

export default {
  searchMACFit,
  searchMACFitScrape,
  searchMACFitAdapter,
};
