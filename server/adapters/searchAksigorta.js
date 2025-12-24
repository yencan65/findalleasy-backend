// server/adapters/searchAksigorta.js
// ============================================================================
// AKSIGORTA — S200 STANDARD FINAL (NO-FAKE • NO-CRASH • DRIFT-SAFE)
// - Output: { ok, items, count, source, _meta }  ✅
// - Contract lock: title + url required; price<=0 => null (insurance pages: price=null)
// - Observable fail: timeout / fetch / parse => ok:false + items:[]
// - NO RANDOM ID: stableIdS200(providerKey, url, title)
// - withTimeout: proxy + direct fetch
// - S200 global ctx set
//
// ZERO DELETE: export isimleri korunur (main + aliases + default)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  fixKey,
} from "../core/s200AdapterKit.js";

function clean(v) {
  return String(v || "").trim();
}

function abs(base, href) {
  const h = clean(href);
  if (!h) return "";
  if (h.startsWith("http://") || h.startsWith("https://")) return h;
  if (h.startsWith("//")) return "https:" + h;
  if (h.startsWith("/")) return base + h;
  return base + "/" + h.replace(/^\/+/, "");
}

// ZERO-DELETE: signature aynı kalsın (url, i)
// S200 için asıl id stableIdS200 ile üretilir.
function stableId(url, i) {
  try {
    return (
      "aksigorta_" +
      Buffer.from(String(url || "") + "_" + String(i ?? "")).toString("base64").replace(/=+/g, "")
    );
  } catch {
    // deterministik fallback (NO random)
    return stableIdS200(fixKey("aksigorta"), String(url || ""), String(url || ""));
  }
}

function failResponse(providerKey, query, region, opt = {}, code = "FETCH_FAIL", err = null) {
  const providerFamily = fixKey(opt.providerFamily || opt.family || "insurance");
  return {
    ok: false,
    items: [],
    count: 0,
    source: providerKey,
    _meta: {
      adapter: providerKey,
      providerKey,
      providerFamily,
      query: clean(query),
      region: clean(region) || "tr",
      code,
      error: err?.message || (err ? String(err) : code),
      timeoutMs: opt.timeoutMs,
      usedProxy: !!opt.usedProxy,
      url: opt.url || null,
      ts: Date.now(),
    },
  };
}

export async function searchAksigorta(query = "", regionOrOptions = "TR") {
  const t0 = Date.now();
  const providerKey = fixKey("aksigorta");
  const entryUrl = "https://www.aksigorta.com.tr/urunler";

  const options =
    regionOrOptions && typeof regionOrOptions === "object" && !Array.isArray(regionOrOptions)
      ? regionOrOptions
      : {};
  const region = typeof regionOrOptions === "string" ? regionOrOptions : clean(options.region) || "TR";
  const providerFamily = fixKey(options.providerFamily || options.family || "insurance");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1200, Math.min(15000, options.timeoutMs)) : 6200;

  // S200 global ctx
  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, providerKey, providerFamily, url: entryUrl };
  } catch {}

  let html = "";
  let usedProxy = false;
  let fetchErr = null;

  const useProxy =
    String(options.useProxy ?? process.env.FINDALLEASY_AKSIGORTA_USE_PROXY ?? "1") !== "0" &&
    String(options.forceDirect ?? "0") !== "1";

  if (useProxy) {
    try {
      usedProxy = true;
      html = await withTimeout(proxyFetchHTML(entryUrl), timeoutMs, `${providerKey}_proxy`);
    } catch (e) {
      fetchErr = e;
      html = "";
    }
  }

  if (!html) {
    try {
      usedProxy = false;
      const res = await withTimeout(
        axios.get(entryUrl, {
          timeout: Math.min(timeoutMs + 800, 16000),
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
          },
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        timeoutMs,
        `${providerKey}_direct`
      );
      html = res?.data || "";
    } catch (e) {
      fetchErr = e;
      html = "";
    }
  }

  if (!html) {
    const isTimeout =
      fetchErr instanceof TimeoutError || /timed\s*out/i.test(String(fetchErr?.message || fetchErr || ""));
    return failResponse(
      providerKey,
      query,
      region,
      { ...options, timeoutMs, usedProxy, url: entryUrl },
      isTimeout ? "TIMEOUT" : "FETCH_FAIL",
      fetchErr || new Error("FETCH_FAIL")
    );
  }

  let $;
  try {
    $ = loadCheerioS200(html, { adapter: providerKey, url: entryUrl });
  } catch (e) {
    return failResponse(providerKey, query, region, { ...options, timeoutMs, usedProxy, url: entryUrl }, "HTML_PARSE_FAIL", e);
  }

  const out = [];
  const seen = new Set();
  const q = clean(query).toLowerCase();

  const selectors = [
    ".product-card",
    ".product",
    ".productBox",
    ".insurance-card",
    ".package-card",
    ".product-card-item",
    ".product-item",
    ".teaser-card",
    ".card",
    ".col-md-4",
  ];

  $(selectors.join(",")).each((i, el) => {
    try {
      const title =
        clean($(el).find(".product-title, .title, h3, h2").first().text()) ||
        clean($(el).find("a").first().attr("title")) ||
        clean($(el).find("a").first().text());

      if (!title) return;

      const desc = clean(
        $(el)
          .find(".product-description, .description, .summary, .desc")
          .first()
          .text()
      );

      // Query filter (query boşsa tüm ürünleri dön)
      if (q) {
        const hay = (title + " " + desc).toLowerCase();
        if (!hay.includes(q)) return;
      }

      let href =
        clean($(el).find("a").attr("href")) ||
        clean($(el).find("a.product-link").attr("href")) ||
        clean($(el).find(".card-link").attr("href"));

      if (!href) return;
      const fullUrl = abs("https://www.aksigorta.com.tr", href);

      const dedupeKey = fullUrl + "|" + title;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const img =
        clean($(el).find("img").attr("data-src")) ||
        clean($(el).find("img").attr("src")) ||
        "";
      const variants = img ? buildImageVariants(img) : {};

      const candidate = {
        id: stableIdS200(providerKey, fullUrl, title),
        title,
        description: desc || null,
        url: fullUrl,
        originUrl: fullUrl,
        deeplink: fullUrl,
        price: null, // insurance discovery-ish: fiyat yok → null
        rating: null,
        currency: "TRY",
        region: String(region || "TR").toUpperCase(),
        category: "insurance",
        image: variants.image || null,
        imageOriginal: variants.imageOriginal || null,
        imageProxy: variants.imageProxy || null,
        hasProxy: variants.hasProxy || false,
        raw: { title, desc, href: fullUrl, img },
      };

      const n = normalizeItemS200(candidate, providerKey, {
        providerFamily,
        vertical: providerFamily,
        baseUrl: "https://www.aksigorta.com.tr",
        region: String(region || "TR").toUpperCase(),
        requireRealUrlCandidate: true,
      });
      if (!n) return;

      out.push(n);
    } catch {}
  });

  return {
    ok: true,
    items: out,
    count: out.length,
    source: providerKey,
    _meta: {
      adapter: providerKey,
      providerKey,
      providerFamily,
      query: clean(query),
      region: String(region || "TR").toUpperCase(),
      url: entryUrl,
      usedProxy,
      timeoutMs,
      returned: out.length,
      ms: Date.now() - t0,
    },
  };
}

export const searchAksigortaScrape = searchAksigorta;
export const searchAksigortaAdapter = searchAksigorta;

export default { searchAksigorta };
