// server/adapters/udemyAdapter.js
// ======================================================================
// UDEMY — S200 FINAL (OBSERVABLE, DRIFT-SAFE, KIT-LOCKED)
// - Observable fail: !html / fetch / timeout => ok:false
// - normalizeItemS200 contract lock + stableIdS200
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE (legacy)
import { proxyFetchHTML } from "../core/proxyEngine.js";

// S21 fiyat motoru
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

// Görsel motoru
import { buildImageVariants } from "../utils/imageFixer.js";

// Affiliate motoru (Udemy’de çoğu zaman pasif kalır ama url priority kuralı için dursun)
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "udemy";
const PROVIDER_FAMILY = "udemy";
const BASE = "https://www.udemy.com";
const DEFAULT_TIMEOUT_MS = 6500;

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: legacy stable id helper
function buildStableId(href, title) {
  try {
    if (href) return "udemy_" + Buffer.from(href).toString("base64");
    return "udemy_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

function _now() {
  return Date.now();
}

function _mkS200(ok, items, meta = {}, extra = {}) {
  const arr = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    adapterKey: PROVIDER_KEY,
    _meta: { ...meta },
    ...extra,
  };
}

function _errStr(e) {
  return safeStr(e?.message || e || "error");
}

async function fetchHTMLWithProxyS200(url, config) {
  try {
    const direct = await axios.get(url, config);
    return { ok: true, html: direct?.data || "", via: "direct" };
  } catch (err) {
    try {
      const html = await proxyFetchHTML(url);
      return { ok: true, html: html || "", via: "proxy", warn: _errStr(err) };
    } catch (e) {
      return { ok: false, html: "", via: "fail", error: _errStr(e), warn: _errStr(err) };
    }
  }
}

function _normalizeItems(rawItems, region = "TR") {
  const arr = coerceItemsS200(rawItems);
  const out = [];
  for (const it of arr) {
    const n = normalizeItemS200(
      {
        ...it,
        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        region: String(region || "TR").toUpperCase(),
        currency: it?.currency || "TRY",
        category: it?.category || "course",
        vertical: "education",
      },
      PROVIDER_KEY,
      {
        providerFamily: PROVIDER_FAMILY,
        baseUrl: BASE,
        currency: "TRY",
        region: String(region || "TR").toUpperCase(),
        category: "course",
        vertical: "education",
      }
    );
    if (n) out.push(n);
  }

  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const k = String(it?.id || "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }
  return deduped;
}

export async function searchUdemy(query, options = {}) {
  const started = _now();
  const region = options?.region || "TR";
  const signal = options?.signal;

  const q = safe(query);
  if (!q) return _mkS200(false, [], { error: "empty_query", region, ms: 0 }, { error: "empty_query" });

  const url = `${BASE}/courses/search/?q=${encodeURIComponent(q)}`;
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, url };

  try {
    const res = await withTimeout(
      (async () => {
        const fetched = await fetchHTMLWithProxyS200(url, {
          signal,
          timeout: Math.max(2000, Math.min(20000, timeoutMs + 2000)),
          headers: { "User-Agent": "Mozilla/5.0 Chrome/122 Safari/537.36" },
        });

        if (!fetched.ok || !fetched.html) {
          return _mkS200(false, [], {
            error: fetched.error || "fetch_failed",
            via: fetched.via,
            warn: fetched.warn || null,
            region,
            ms: _now() - started,
          }, { error: fetched.error || "fetch_failed" });
        }

        const $ = loadCheerioS200(fetched.html, { adapter: PROVIDER_KEY, url });
        const items = [];

        $(".course-card--container--3w8Zm, .course-list--container--3zXPS, .course-card").each((i, el) => {
          const title =
            safe($(el).find(".course-card--course-title--2f7tE").text()) ||
            safe($(el).find("h3").text()) ||
            safe($(el).find(".course-card--title").text());
          if (!title) return;

          const priceTxt =
            safe($(el).find(".price-text--price-part--2npPm").text()) ||
            safe($(el).find(".price-text--current-price--2v8By").text()) ||
            safe($(el).find(".price").text());

          const rawPrice = parsePrice(priceTxt);
          const price = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "course" });

          let href = safe($(el).find("a").attr("href"));
          if (href && !href.startsWith("http")) href = href.startsWith("/") ? `${BASE}${href}` : `${BASE}/${href}`;
          if (!href) return;

          // Udemy affiliate çoğu projede yok; yine de url priority standardı için dursun
          const affiliateUrl = buildAffiliateUrlS10({ url: href, provider: PROVIDER_KEY });

          let imgRaw = safe($(el).find("img").attr("src")) || safe($(el).find("img").attr("data-src"));
          if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;

          const imageVariants = buildImageVariants(imgRaw || null, PROVIDER_KEY);

          let item = {
            id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, title),
            title,
            price,
            priceText: priceTxt || null,
            provider: PROVIDER_FAMILY,
            providerKey: PROVIDER_KEY,
            vertical: "education",
            category: "course",
            region: String(region).toUpperCase(),
            currency: "TRY",
            url: href,
            originUrl: href,
            affiliateUrl,
            rating: null,
            image: imageVariants.image,
            imageOriginal: imageVariants.imageOriginal,
            imageProxy: imageVariants.imageProxy,
            hasProxy: imageVariants.hasProxy,
            raw: { title, priceTxt, href, imgRaw },
          };

          item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "course" });
          items.push(item);
        });

        const normalized = _normalizeItems(items, region);
        return _mkS200(true, normalized, { via: fetched.via, warn: fetched.warn || null, region, ms: _now() - started });
      })(),
      timeoutMs,
      PROVIDER_KEY
    );

    return res;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return _mkS200(false, [], { error: _errStr(e), timeout: isTimeout, region, ms: _now() - started }, { error: isTimeout ? "timeout" : _errStr(e) });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchUdemyScrape = searchUdemy;
export const searchUdemyAdapter = searchUdemy;

export default {
  searchUdemy,
  searchUdemyScrape,
  searchUdemyAdapter,
};
