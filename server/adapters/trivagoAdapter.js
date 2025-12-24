// server/adapters/trivagoAdapter.js
// ======================================================================
// TRIVAGO — S200 FINAL (OBSERVABLE, DRIFT-SAFE, KIT-LOCKED)
// - Output: { ok, items, count, source, _meta } (+diag fields)
// - Contract lock: title+url required; price<=0 => null (normalizeItemS200)
// - Observable fail: fetch/proxy/timeout/parse => ok:false + items:[]
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// - withTimeout everywhere
// ZERO DELETE: var olan fonksiyonlar durur, sadece güçlendirilir
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE (legacy)
import { proxyFetchHTML } from "../core/proxyEngine.js";

// S21 fiyat motoru
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

// Görsel motoru
import { buildImageVariants } from "../utils/imageFixer.js";

// Affiliate motoru
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

// --------------------------------------------------------------
// CONSTS
// --------------------------------------------------------------
const PROVIDER_KEY = "trivago";
const PROVIDER_FAMILY = "trivago";
const BASE = "https://www.trivago.com";
const DEFAULT_TIMEOUT_MS = 6500;

// --------------------------------------------------------------
// HELPERS (legacy korunur)
// --------------------------------------------------------------
function safe(v) {
  return v ? String(v).trim() : "";
}

function parsePrice(t) {
  if (!t) return null;
  const n = Number(t.replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: legacy stable id helper (artık ana id burada üretilmez)
function buildStableId(href, title) {
  try {
    if (href) return "trivago_" + Buffer.from(href).toString("base64");
    return "trivago_" + Buffer.from(title).toString("base64");
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
    // diag (mevcut chain/log uyumu için)
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

async function fetchHTMLWithProxyS200(url, config = {}, meta = {}) {
  try {
    const direct = await axios.get(url, config);
    return { ok: true, html: direct?.data || "", via: "direct", ...meta };
  } catch (err) {
    try {
      const html = await proxyFetchHTML(url);
      return { ok: true, html: html || "", via: "proxy", warn: _errStr(err), ...meta };
    } catch (e) {
      return { ok: false, html: "", via: "fail", error: _errStr(e), warn: _errStr(err), ...meta };
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
        category: it?.category || "hotel",
        vertical: "travel",
      },
      PROVIDER_KEY,
      {
        providerFamily: PROVIDER_FAMILY,
        baseUrl: BASE,
        currency: "TRY",
        region: String(region || "TR").toUpperCase(),
        category: "hotel",
        vertical: "travel",
      }
    );
    if (n) out.push(n);
  }

  // dedupe by id (stable)
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

// ======================================================================
// MAIN ADAPTER — S200
// ======================================================================
export async function searchTrivago(query, opts = "TR") {
  const started = _now();
  const region = typeof opts === "string" ? opts : opts?.region || "TR";
  const options = typeof opts === "object" && opts ? opts : {};

  const q = safe(query);
  if (!q) {
    return _mkS200(false, [], { error: "empty_query", region, ms: 0 }, { error: "empty_query" });
  }

  const url = `${BASE}/?sHotelSearch=1&q=${encodeURIComponent(q)}`;
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, url };

  try {
    const raw = await withTimeout(
      (async () => {
        const fetched = await fetchHTMLWithProxyS200(
          url,
          {
            signal: options.signal,
            timeout: Math.max(2000, Math.min(20000, timeoutMs + 2000)),
            headers: {
              "User-Agent": "Mozilla/5.0 Chrome/122 Safari/537.36",
              "Accept-Language": "en-US,en;q=0.9",
            },
          },
          { region }
        );
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

        const selectors = [".hotel-item", ".deal-item", ".item", ".result", ".hotel-card"];
        $(selectors.join(",")).each((_, el) => {
          const w = $(el);

          const title =
            safe(w.find(".name").text()) ||
            safe(w.find(".item__name").text()) ||
            safe(w.find("h2").text()) ||
            safe(w.find("h3").text());

          if (!title) return;

          const priceTxt =
            safe(w.find(".price").text()) ||
            safe(w.find(".deal__price").text()) ||
            safe(w.find(".item__best-price").text());

          const rawPrice = parsePrice(priceTxt);
          const price = sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "hotel" });

          let href = safe(w.find("a").attr("href"));
          if (!href) return;
          if (!href.startsWith("http")) href = href.startsWith("/") ? `${BASE}${href}` : `${BASE}/${href}`;

          const affiliateUrl = buildAffiliateUrlS10({ url: href, provider: PROVIDER_KEY });

          let imgRaw = safe(w.find("img").attr("src")) || safe(w.find("img").attr("data-src"));
          if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;
          const imageVariants = buildImageVariants(imgRaw || null, PROVIDER_KEY);

          let item = {
            // id burada legacy idi; artık normalizeItemS200 stableIdS200 üretiyor.
            // Yine de ZERO DELETE için "id" alanı deterministik olsun:
            id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, title),

            title,
            price,
            priceText: priceTxt || null,

            provider: PROVIDER_FAMILY,
            providerKey: PROVIDER_KEY,
            category: "hotel",
            vertical: "travel",
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

          item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "hotel" });
          items.push(item);
        });

        const normalized = _normalizeItems(items, region);

        return _mkS200(true, normalized, {
          via: fetched.via,
          warn: fetched.warn || null,
          region,
          ms: _now() - started,
        });
      })(),
      timeoutMs,
      PROVIDER_KEY
    );

    return raw;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return _mkS200(
      false,
      [],
      { error: _errStr(e), timeout: isTimeout, region, ms: _now() - started },
      { error: isTimeout ? "timeout" : _errStr(e) }
    );
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchTrivagoScrape = searchTrivago;
export const searchTrivagoAdapter = searchTrivago;

export default {
  searchTrivago,
  searchTrivagoScrape,
  searchTrivagoAdapter,
};
