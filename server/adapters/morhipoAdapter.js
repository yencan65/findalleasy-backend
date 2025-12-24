// server/adapters/morhipoAdapter.js
// ============================================================================
// MORHIPO — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S5/S22 tabanı korunur; sayfalama + selector set korunur
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
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

// ============================================================================
// HELPERS (kept)
// ============================================================================
const clean = (v) => safeStr(v, 1600).trim();

function parsePrice(txt) {
  if (!txt) return null;
  const n = Number(
    String(txt).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

function detectCategory(title) {
  const t = String(title || "").toLowerCase();
  if (/elbise|ayakkabı|tshirt|kazak|çanta|gömlek|pantolon/.test(t)) return "fashion";
  return "product";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.price) s += 0.35;
  if ((item.title || "").length > 10) s += 0.25;
  if (item.image) s += 0.35;
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
  return { ok: !!ok, items: arr, count: arr.length, source: "morhipo", _meta: { ...meta } };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MORHIPO_TIMEOUT_MS || 12000);

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

// SELECTORS — kept
const SELECTORS = [
  ".product-item",
  ".product",
  ".product-card",
  ".mh-product-card",
  ".product-box",
  ".product-wrapper",
  ".grid-item",
  ".col-6",
  ".col-4",
  ".col-3",
  ".product-list-item",
  "[data-product-id]",
];

const MAX_PAGES = 3;

// HTML FETCH — proxy-first + withTimeout
async function fetchMorhipoHTML(url, signal, timeoutMs) {
  try {
    return await withTimeout(proxyFetchHTML(url), timeoutMs, "morhipo.proxyFetch");
  } catch (e) {
    const { data } = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          Accept: "text/html",
        },
      }),
      timeoutMs,
      "morhipo.axiosFetch"
    );
    return data;
  }
}

// SINGLE PAGE SCRAPER — returns {ok, items, _meta}
async function scrapeMorhipoPage(query, page = 1, region = "TR", signal, timeoutMs = 12000) {
  const q = encodeURIComponent(query);
  const url = `https://www.morhipo.com/arama?q=${q}&page=${page}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "morhipo_adapter", providerKey: "morhipo", url };

  try {
    const htmlRaw = await fetchMorhipoHTML(url, signal, timeoutMs);
    const html = String(htmlRaw || "");
    if (!html) return { ok: false, items: [], _meta: { code: "FETCH_FAIL", url, page } };

    const $ = loadCheerioS200(html, { adapter: "morhipo_adapter", providerKey: "morhipo", url });
    const candidates = [];

    const strictMatch = String(process.env.MORHIPO_STRICT_MATCH || "0") === "1";
    const q2 = String(query || "").toLowerCase();

    $(SELECTORS.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        clean(wrap.find(".product-title").text()) ||
        clean(wrap.find(".name").text()) ||
        clean(wrap.find(".productName").text()) ||
        clean(wrap.find("h3").text()) ||
        clean(wrap.find("h2").text());

      if (!title) return;

      // S22 filter preserved, but now optional (default OFF)
      if (strictMatch && q2.length >= 2) {
        if (!String(title).toLowerCase().includes(q2.slice(0, 2))) return;
      }

      const priceTxt =
        clean(wrap.find(".new-price").text()) ||
        clean(wrap.find(".product-price").text()) ||
        clean(wrap.find("[data-price]").attr("data-price")) ||
        clean(wrap.find(".price").text());

      const parsedPrice = parsePrice(priceTxt);
      const price = sanitizePrice(parsedPrice);
      const optimizedPrice = optimizePrice({ price }, { provider: "morhipo" });

      let href =
        clean(wrap.find("a").attr("href")) ||
        clean(wrap.find(".product-link").attr("href"));

      if (!href) return;
      if (!href.startsWith("http")) href = "https://www.morhipo.com" + href;

      const imgRaw =
        wrap.find("img").attr("data-src") ||
        wrap.find("img").attr("data-original") ||
        wrap.find("img").attr("data-image") ||
        wrap.find("picture img").attr("src") ||
        wrap.find("img").attr("src") ||
        null;

      const image = buildImageVariants(imgRaw, "morhipo");

      const categoryAI = detectCategory(title);
      const qualityScore = computeQualityScore({ title, price, image: imgRaw });

      candidates.push({
        id: stableIdS200("morhipo", href, title),
        title,
        price,
        optimizedPrice,
        rating: null,

        provider: "fashion",
        providerFamily: "fashion",
        providerKey: "morhipo",
        providerType: "provider",

        currency: "TRY",
        region,
        vertical: "fashion",
        category: "product",
        categoryAI,
        qualityScore,

        url: href,
        originUrl: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        raw: { title, priceTxt, href, imgRaw, page },
      });
    });

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, "morhipo", {
        providerFamily: "fashion",
        vertical: "fashion",
        category: "product",
        region,
        currency: "TRY",
        baseUrl: "https://www.morhipo.com",
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

    return { ok: true, items, _meta: { code: items.length ? "OK" : "OK_EMPTY", url, page } };
  } catch (err) {
    return { ok: false, items: [], _meta: { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), url, page } };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// UNIFIED ADAPTER — S200 output (strict)
export async function searchMorhipo(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);
  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  let all = [];
  const partialErrors = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const part = await scrapeMorhipoPage(q, page, region, sig || signal, timeoutMs);

    if (!part.ok) {
      // first page failure => hard fail
      if (page === 1) {
        return _mkRes(false, [], { ...part._meta, region, timeoutMs });
      }
      // later page failure => partial ok
      partialErrors.push(part._meta);
      break;
    }

    if (!part.items.length) break;

    all = all.concat(part.items);
    if (all.length >= 90) break;
  }

  // de-dupe again
  const seen = new Set();
  const items = [];
  for (const it of all) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(it);
  }

  return _mkRes(true, items, {
    code: items.length ? "OK" : "OK_EMPTY",
    region,
    timeoutMs,
    partial: partialErrors.length ? true : undefined,
    errors: partialErrors.length ? partialErrors : undefined,
  });
}

export const searchMorhipoScrape = searchMorhipo;
export const searchMorhipoAdapter = searchMorhipo;

export default { searchMorhipo };
