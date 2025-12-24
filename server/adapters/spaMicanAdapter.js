// server/adapters/spaMicanAdapter.js
// ============================================================================
// MICAN SPA — S200 TITAN ADAPTER (HARDENED)
// Spa / Wellness
//
// - Wrapper output: { ok, items, count, source, _meta }
// - ZERO CRASH: network/parse/import fail => ok:false + items:[] (observable)
// - Contract lock: title + url required; price<=0 => null
// - NO RANDOM ID: deterministic stableIdS200
// - URL priority (when present): affiliateUrl/deeplink/finalUrl > originUrl > url
// ============================================================================

import axios from "axios";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  fixKey,
  normalizeUrlS200,
  isBadUrlS200,
  priceOrNullS200,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "mican";
const PROVIDER_FAMILY = "spa";
const ADAPTER_KEY = "mican_spa";

const BASE_URL = "https://mican.com.tr";
const LIST_URL = `${BASE_URL}/kategoriler/spa`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function normSpace(s) {
  return safe(s).replace(/\s+/g, " ").trim();
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function toTokens(q) {
  return normSpace(q)
    .toLowerCase()
    .split(/[\s/|,.;:()\[\]{}<>\"'`~!@#$%^&*+=?-]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function titleMatches(title, qTokens) {
  if (!qTokens?.length) return true;
  const t = safe(title).toLowerCase();
  return qTokens.every((tok) => t.includes(tok));
}

function errToMeta(err) {
  const msg = safe(err?.message || err);
  const name = safe(err?.name);
  const code = safe(err?.code);
  const status = err?.response?.status;
  return {
    name: name || "Error",
    message: msg || "Unknown error",
    code: code || undefined,
    status: Number.isFinite(status) ? status : undefined,
  };
}

function mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    _meta: {
      adapterKey: ADAPTER_KEY,
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      ...meta,
    },
  };
}

async function fetchHTML(url, timeoutMs) {
  const headers = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  // 1) Direct fetch
  try {
    const resp = await withTimeout(
      axios.get(url, {
        headers,
        timeout: clamp(timeoutMs, 1000, 15000),
        maxRedirects: 5,
        validateStatus: () => true,
      }),
      clamp(timeoutMs, 1000, 15000) + 250,
      PROVIDER_KEY
    );

    if (
      resp?.status === 200 &&
      typeof resp?.data === "string" &&
      resp.data.length > 200
    ) {
      return resp.data;
    }
  } catch {
    // fallthrough
  }

  // 2) Proxy fetch (if available/working in your infra)
  try {
    const html = await withTimeout(
      proxyFetchHTML(url, { headers }),
      clamp(timeoutMs, 1000, 15000) + 750,
      `${PROVIDER_KEY}:proxy`
    );
    if (typeof html === "string" && html.length > 200) return html;
  } catch {
    // fallthrough
  }

  return null;
}

function extractPriceText($card) {
  const candidates = [
    $card.find(".price").first().text(),
    $card.find(".special-price .price").first().text(),
    $card.find(".price-final_price .price").first().text(),
    $card.find("[data-price-amount]").first().attr("data-price-amount"),
    $card.find(".price-wrapper").first().attr("data-price-amount"),
  ];
  return candidates.map((x) => safe(x)).find((x) => x) || "";
}

function extractHref($card) {
  const a =
    $card.find(".product-item-title a").first() ||
    $card.find("a.product-item-link").first() ||
    $card.find("a").first();
  const href = a?.attr ? a.attr("href") : "";
  return safe(href);
}

function extractTitle($card) {
  const candidates = [
    $card.find(".product-item-title a").first().text(),
    $card.find("a.product-item-link").first().text(),
    $card.find(".product-item-name").first().text(),
    $card.find("a").first().text(),
  ];
  return normSpace(candidates.map((x) => safe(x)).find((x) => x) || "");
}

function extractImage($card) {
  const img = $card.find("img").first();
  const src =
    safe(img.attr("data-src")) ||
    safe(img.attr("data-original")) ||
    safe(img.attr("src")) ||
    safe(img.attr("data-lazy")) ||
    "";
  return src;
}

export async function searchSpaMicanScrape(q, opts = {}) {
  const query = normSpace(q);
  const qTokens = toTokens(query);

  const limit = clamp(opts?.limit ?? 20, 1, 60);
  const timeoutMs = clamp(opts?.timeoutMs ?? 6500, 1500, 15000);

  const html = await fetchHTML(LIST_URL, timeoutMs);
  if (!html) return [];

  const $ = loadCheerioS200(html);

  const cards = $(
    ".products-grid .item, .product-item, li.item.product"
  ).toArray();

  const out = [];

  for (const el of cards) {
    if (out.length >= limit) break;

    const $card = $(el);

    const title = extractTitle($card);
    if (!title) continue;

    if (!titleMatches(title, qTokens)) continue;

    const href = extractHref($card);
    const url = normalizeUrlS200(BASE_URL, href);
    if (!url || isBadUrlS200(url)) continue;

    const img = extractImage($card);
    const image = normalizeUrlS200(BASE_URL, img);

    const rawPriceText = extractPriceText($card);
    const parsed = sanitizePrice(rawPriceText);
    const opt =
      parsed != null
        ? optimizePrice({ price: parsed }, { provider: PROVIDER_KEY })
        : null;

    const optimized =
      typeof opt === "number"
        ? opt
        : opt?.optimizedPrice ?? opt?.finalPrice ?? opt?.price ?? parsed ?? null;

    const p = priceOrNullS200(optimized);

    const raw = {
      providerKey: PROVIDER_KEY,
      adapterKey: ADAPTER_KEY,
      listUrl: LIST_URL,
      rawPriceText: rawPriceText || null,
    };

    const candidate = {
      id: stableIdS200(PROVIDER_KEY, title, url),
      title,
      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      url,
      originUrl: url,
      finalUrl: url,
      image: image || null,
      images: image ? buildImageVariants(image) : undefined,
      price: p,
      finalPrice: p,
      optimizedPrice: p,
      raw,
    };

    const normalized = normalizeItemS200(candidate, {
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      category: "spa",
    });

    if (!normalized) continue;
    if (!safe(normalized?.title) || !safe(normalized?.url)) continue;

    normalized.providerKey = fixKey(PROVIDER_KEY);
    normalized.provider = PROVIDER_FAMILY;

    out.push(normalized);
  }

  return out;
}

export async function searchSpaMican(q, opts = {}) {
  const query = normSpace(q);
  const timeoutMs = clamp(opts?.timeoutMs ?? 6500, 1500, 15000);

  try {
    const items = await withTimeout(
      searchSpaMicanScrape(query, opts),
      timeoutMs + 750,
      PROVIDER_KEY
    );

    return mkRes(true, items, {
      query,
      listUrl: LIST_URL,
      mode: "category_list",
      empty: items.length === 0,
    });
  } catch (err) {
    const isTimeout =
      err instanceof TimeoutError || safe(err?.name) === "TimeoutError";

    return mkRes(false, [], {
      query,
      listUrl: LIST_URL,
      error: errToMeta(err),
      timeout: isTimeout || undefined,
    });
  }
}

export async function searchSpaMicanAdapter(q, opts = {}) {
  return searchSpaMican(q, opts);
}

export default {
  key: ADAPTER_KEY,
  name: "Mican SPA",
  type: PROVIDER_FAMILY,
  providerKey: PROVIDER_KEY,
  search: searchSpaMicanAdapter,
};
