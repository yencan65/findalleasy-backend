// server/adapters/memorialCheckupAdapter.js
// ============================================================================
// MEMORIAL CHECK-UP — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S5/S22 tabanı korunur; S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
// withTimeout everywhere + global ctx set
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

const safe = (x) => safeStr(x, 1800).trim();

function parsePrice(v) {
  if (!v) return null;
  const n = Number(String(v).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: stableId adı korundu; random temizlendi
function stableId(url, i, title = "") {
  return stableIdS200("memorial_checkup", String(url || ""), String(title || `memorial_checkup_${i ?? 0}`));
}

function detectCategory(title = "") {
  const t = String(title || "").toLowerCase();
  if (/premium|advanced|genel|\s*kapsamlı|full/.test(t)) return "checkup_premium";
  if (/kadın|women/.test(t)) return "checkup_women";
  if (/erkek|men/.test(t)) return "checkup_men";
  if (/çocuk|cocuk|kids/.test(t)) return "checkup_kids";
  return "health_checkup";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.price) s += 0.45;
  if ((item.title || "").length > 6) s += 0.25;
  if (item.image) s += 0.25;
  return Number(s.toFixed(2));
}

function extractGeoSignal(title = "") {
  const t = String(title || "").toLowerCase();
  const cities = ["istanbul", "ankara", "antalya", "gaziantep", "diyarbakır"];
  return cities.find((c) => t.includes(c)) || null;
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
    source: "memorial_checkup",
    _meta: { ...meta },
  };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MEMORIAL_CHECKUP_TIMEOUT_MS || 12000);

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

async function fetchHTML(url, signal, timeoutMs) {
  try {
    return await withTimeout(proxyFetchHTML(url), timeoutMs, "memorial_checkup.proxyFetch");
  } catch {
    const { data } = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
      }),
      timeoutMs,
      "memorial_checkup.axiosFetch"
    );
    return data;
  }
}

async function runMemorialCheckupS200(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);

  const qClean = safe(query);
  if (!qClean) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs, ms: Date.now() - t0 });

  const q = encodeURIComponent(qClean);
  const url = `https://www.memorial.com.tr/check-up?search=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "memorial_checkup_adapter", providerKey: "memorial_checkup", url };

  try {
    const html = String(await fetchHTML(url, signal, timeoutMs) || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url, region, timeoutMs, ms: Date.now() - t0 });

    const $ = loadCheerioS200(html, { adapter: "memorial_checkup_adapter", providerKey: "memorial_checkup", url });
    const candidates = [];

    const selectors = [
      ".package-card",
      ".checkup-box",
      ".checkup-card",
      ".package",
      ".box",
      ".item",
      ".treatment-card",
      "[data-package-id]",
    ];

    $(selectors.join(",")).each((i, el) => {
      const w = $(el);

      const title = safe(w.find("h3").text()) || safe(w.find(".title").text());
      if (!title) return;

      const priceTxt =
        safe(w.find(".price").text()) ||
        safe(w.find(".package-price").text()) ||
        safe(w.find(".amount").text());

      const priceRaw = parsePrice(priceTxt);
      const price = sanitizePrice(priceRaw);
      const optimizedPrice = optimizePrice({ price }, { provider: "memorial_checkup" });

      let href =
        safe(w.find("a").attr("href")) ||
        safe(w.find(".card-link").attr("href"));
      if (!href) return;
      if (!href.startsWith("http")) href = `https://www.memorial.com.tr${href}`;

      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("data-original")) ||
        safe(w.find("img").attr("src")) ||
        safe(w.find("picture img").attr("src")) ||
        null;

      const imageVariants = buildImageVariants(imgRaw);

      const id = stableId(href, i, title);
      const categoryAI = detectCategory(title);
      const geoSignal = extractGeoSignal(title);
      const qualityScore = computeQualityScore({ title, price, image: imgRaw });

      candidates.push({
        id,
        title,
        price,
        optimizedPrice,
        rating: null,

        provider: "health",
        providerFamily: "health",
        providerKey: "memorial_checkup",
        providerType: "provider",

        currency: "TRY",
        region,
        vertical: "health",
        category: "health_checkup",
        categoryAI,
        qualityScore,

        url: href,
        originUrl: href,
        deeplink: href,

        image: imageVariants.image,
        imageOriginal: imageVariants.imageOriginal,
        imageProxy: imageVariants.imageProxy,
        hasProxy: imageVariants.hasProxy,

        geoSignal,
        raw: { title, priceTxt, href, imgRaw },
      });
    });

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, "memorial_checkup", {
        providerFamily: "health",
        vertical: "health",
        region,
        currency: "TRY",
        baseUrl: "https://www.memorial.com.tr",
        requireRealUrlCandidate: true,
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
      url,
      region,
      timeoutMs,
      ms: Date.now() - t0,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      url,
      region,
      timeoutMs,
      ms: Date.now() - t0,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// PUBLIC EXPORTS (ZERO DELETE)
// ============================================================================
export async function searchMemorialCheckup(query, regionOrOptions = "TR") {
  const r = await runMemorialCheckupS200(query, regionOrOptions);
  return r.items || [];
}

export async function searchMemorialCheckupAdapter(query, regionOrOptions = "TR") {
  return runMemorialCheckupS200(query, regionOrOptions);
}

export const searchMemorialCheckupScrape = searchMemorialCheckup;

export default {
  searchMemorialCheckup,
  searchMemorialCheckupAdapter,
  searchMemorialCheckupScrape,
};
