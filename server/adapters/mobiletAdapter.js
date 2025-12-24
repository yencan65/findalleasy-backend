// server/adapters/mobiletAdapter.js
// ============================================================================
// MOBILET — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: DOM+Regex hybrid yaklaşım korunur
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

const clean = (v) => safeStr(v, 1600).trim();

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source: "mobilet", _meta: { ...meta } };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MOBILET_TIMEOUT_MS || 10000);

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

// PRICE SANITIZER (regex detection) — kept
function extractPrice(str = "") {
  const m = String(str || "").match(/([\d.,]+)/);
  if (!m) return null;
  return Number(m[1].replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", "."));
}

// DOM scraper — kept, but S200 item format
function scrapeWithDOM(html, region, query) {
  const $ = loadCheerioS200(html, { adapter: "mobilet_adapter", providerKey: "mobilet", url: "" });
  const items = [];

  $(".event-card, .event, a.event, .card-event").each((i, el) => {
    const title = clean($(el).find("h3").text()) || clean($(el).find(".title").text()) || null;
    if (!title) return;

    let href =
      clean($(el).attr("href")) ||
      clean($(el).find("a").attr("href")) ||
      "";
    if (!href) return;
    if (href && !href.startsWith("http")) href = "https://mobilet.com" + href;

    const img = clean($(el).find("img").attr("src")) || clean($(el).find("img").attr("data-src")) || "";

    const priceTxt = clean($(el).find(".price").text()) || clean($(el).find(".event-price").text()) || "";
    const price = sanitizePrice(extractPrice(priceTxt));
    const image = buildImageVariants(img);

    items.push({
      id: stableIdS200("mobilet", href, title),
      title,
      price,
      optimizedPrice: optimizePrice({ price }, { provider: "mobilet" }),
      rating: null,

      provider: "event",
      providerFamily: "event",
      providerKey: "mobilet",
      providerType: "provider",

      currency: "TRY",
      region,
      vertical: "event",
      category: "event",
      categoryAI: "event",

      url: href,
      originUrl: href,
      deeplink: href,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      raw: { title, href, img, priceTxt, htmlBlock: $(el).html(), query },
    });
  });

  return items;
}

// Regex fallback — kept, but strict url requirement (no fake url)
function scrapeWithRegex(html, region, query) {
  const items = [];
  const rgx = /<a[^>]*class="[^"]*event[^"]*"[\s\S]*?<\/a>/gi;

  let m, index = 0;
  while ((m = rgx.exec(html))) {
    const block = m[0];

    const urlMatch = block.match(/href="(.*?)"/i);
    let href = urlMatch ? clean(urlMatch[1]) : "";
    if (!href) continue;
    if (href && !href.startsWith("http")) href = "https://mobilet.com" + href;

    const titleMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/i);
    const title = titleMatch ? clean(titleMatch[1]) : null;
    if (!title) continue;

    const imgMatch = block.match(/<img[^>]*src="(.*?)"/i);
    const img = imgMatch ? clean(imgMatch[1]) : "";

    const priceMatch = block.match(/<div[^>]*price[^>]*>(.*?)<\/div>/i);
    const priceRaw = priceMatch ? extractPrice(priceMatch[1]) : null;
    const price = sanitizePrice(priceRaw);

    const image = buildImageVariants(img);

    items.push({
      id: stableIdS200("mobilet", href, title),
      title,
      price,
      optimizedPrice: optimizePrice({ price }, { provider: "mobilet" }),
      rating: null,

      provider: "event",
      providerFamily: "event",
      providerKey: "mobilet",
      providerType: "provider",

      currency: "TRY",
      region,
      vertical: "event",
      category: "event",
      categoryAI: "event",

      url: href,
      originUrl: href,
      deeplink: href,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      raw: { block, index: index++, query },
    });
  }

  return items;
}

// MAIN — S200 strict output
export async function searchMobiletAdapter(query = "", regionOrOptions = "TR") {
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);
  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  const url = `https://mobilet.com/search?q=${encodeURIComponent(q)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "mobilet_adapter", providerKey: "mobilet", url };

  try {
    let html = null;

    // proxy-first
    try {
      html = await withTimeout(proxyFetchHTML(url), timeoutMs, "mobilet.proxyFetch");
    } catch (e) {
      const res = await withTimeout(
        axios.get(url, {
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            Accept: "text/html",
          },
        }),
        timeoutMs,
        "mobilet.axiosFetch"
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url, region, timeoutMs });

    // 1) DOM parse
    let rawItems = scrapeWithDOM(html, region, q);

    // 2) Regex fallback (DOM sonuç yoksa)
    if (rawItems.length === 0) {
      rawItems = scrapeWithRegex(html, region, q);
    }

    const normalized = [];
    for (const it of coerceItemsS200(rawItems)) {
      const n = normalizeItemS200(it, "mobilet", {
        providerFamily: "event",
        vertical: "event",
        category: "event",
        region,
        currency: "TRY",
        baseUrl: "https://mobilet.com",
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

    return _mkRes(true, items, { code: items.length ? "OK" : "OK_EMPTY", url, region, timeoutMs });
  } catch (err) {
    return _mkRes(false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), url, region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export default { searchMobiletAdapter };
