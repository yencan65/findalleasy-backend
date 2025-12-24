// server/adapters/terappinAdapter.js
// ============================================================================
// TERAPPIN — S200 FINAL (KIT-LOCKED, DRIFT-SAFE, OBSERVABLE)
// - Output: { ok, items, count, source, _meta } ✅
// - Contract lock: title + url required; price<=0 => null ✅
// - NO RANDOM ID: stableIdS200(providerKey,url,title) ✅
// - Observable fail: fetch/timeout/parse => ok:false + items:[] (+ _meta.error/code) ✅
// - withTimeout wrapped ✅
// - NO FAKE RESULTS: PROD’da stub yok; DEV’de FINDALLEASY_ALLOW_STUBS=1 ile ✅
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "terappin";
const PROVIDER_FAMILY = "terappin";

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

const BASE = String(process.env.TERAPPIN_BASE_URL || "https://terappin.com").replace(/\/+$/, "");
const LIST_URL = String(process.env.TERAPPIN_LIST_URL || `${BASE}/psikolog/`);
const DEFAULT_TIMEOUT_MS = Number(process.env.TERAPPIN_TIMEOUT_MS || 9000);

function safeStrLocal(v, max = 500) {
  const s = v == null ? "" : String(v);
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}
function normSpace(s) {
  return safeStrLocal(s, 2500).replace(/\s+/g, " ").trim();
}
function absUrl(href) {
  const h = safeStrLocal(href, 1500);
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return `https:${h}`;
  if (h.startsWith("/")) return `${BASE}${h}`;
  return `${BASE}/${h}`;
}
function addUtm(url, provider = PROVIDER_KEY) {
  const u = safeStrLocal(url, 2000);
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (!parsed.searchParams.get("utm_source")) parsed.searchParams.set("utm_source", "findalleasy");
    if (!parsed.searchParams.get("utm_medium")) parsed.searchParams.set("utm_medium", "ref");
    if (!parsed.searchParams.get("utm_campaign")) parsed.searchParams.set("utm_campaign", "psychology");
    if (!parsed.searchParams.get("utm_content")) parsed.searchParams.set("utm_content", provider);
    return parsed.toString();
  } catch {
    return u;
  }
}

function tokensFromQuery(q) {
  const s = normSpace(q).toLowerCase();
  if (!s) return [];
  return s.split(" ").map(x => x.trim()).filter(x => x.length >= 3).slice(0, 8);
}

function extractNameAndRole(line) {
  const t = normSpace(line);
  if (!t) return { name: "", role: "" };

  const m = t.match(/^(.+?)\s+(Uzman|Klinik|Prof\.|Dr\.|Psikolog|Psikolojik)\b/i);
  if (m) {
    const name = normSpace(m[1]);
    const role = normSpace(t.slice(m[1].length));
    return { name, role };
  }
  return { name: t, role: "" };
}

function parseReviewCount(text) {
  const t = normSpace(text);
  const m = t.match(/(\d+)\s*Yorum/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseTryPriceFromText(text) {
  const t = String(text || "");
  const nums = [];
  const re = /(\d{2,6})\s*(₺|TL)/gi;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  if (!nums.length) return null;
  return Math.min(...nums);
}

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    _meta: { ...meta },
  };
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

function _errStr(e) {
  return safeStr(e?.message || e || "error");
}

async function fetchHtml(url, timeoutMs, signal) {
  const tms = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const res = await axios.get(url, {
    signal,
    timeout: Math.max(1500, Math.min(15000, tms)),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
    },
  });
  return String(res?.data || "");
}

function parseList(html, query) {
  const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url: LIST_URL });
  const qTokens = tokensFromQuery(query);

  const map = new Map(); // url -> data

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const h = String(href);
    if (!h.startsWith("/psikolog/")) return;
    if (h === "/psikolog/" || h === "/psikolog") return;

    const originUrl = absUrl(h);
    if (!originUrl) return;

    const cardText = normSpace($(el).closest("section,article,div,li").text());
    const blob = cardText.toLowerCase();

    if (qTokens.length) {
      const hit = qTokens.some(t => blob.includes(t));
      if (!hit) return;
    }

    const line = normSpace($(el).text()) || cardText;
    const { name, role } = extractNameAndRole(line);
    const reviewCount = parseReviewCount(cardText);

    const prev = map.get(originUrl) || {};
    map.set(originUrl, {
      originUrl,
      name: name || prev.name || "",
      role: role || prev.role || "",
      reviewCount: reviewCount ?? prev.reviewCount ?? null,
      cardText: prev.cardText || cardText,
    });
  });

  const items = [];
  for (const v of map.values()) {
    const title = v.name || "Terappin Psikolog Profili";

    const url = addUtm(v.originUrl, PROVIDER_KEY);
    const id = stableIdS200(PROVIDER_KEY, url, title);

    items.push({
      id,
      title: safeStrLocal(title, 160),
      url,
      originUrl: v.originUrl,
      affiliateUrl: null,
      deeplink: null,

      price: null, // optional detail fetch
      currency: "TRY",
      category: "psychology",
      vertical: "health",

      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerFamily: PROVIDER_FAMILY,

      raw: {
        role: safeStrLocal(v.role, 160),
        reviewCount: v.reviewCount,
        context: safeStrLocal(v.cardText, 900),
        source: "terappin_list",
      },
    });
  }

  items.sort((a, b) => String(a.title).localeCompare(String(b.title), "tr"));
  return items;
}

async function enrichWithProfilePrice(item, timeoutMs, signal) {
  // Optional enrichment: fail here should NOT flip ok=false; just leave price null.
  try {
    const html = await withTimeout(fetchHtml(item.url, timeoutMs, signal), timeoutMs, `${PROVIDER_KEY}_detail`);
    const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url: item.url });
    const text = normSpace($.text());

    const price = parseTryPriceFromText(text);
    if (price && price > 0) {
      item.price = price;
      item.raw = item.raw || {};
      item.raw.priceDetected = true;
    }
  } catch {
    // swallow (zero-crash)
  }
  return item;
}

export async function searchTerappinAdapter(query, opts = {}) {
  const t0 = Date.now();
  const q = safeStrLocal(query, 300);
  const limit = Math.max(1, Math.min(25, Number(opts.limit || 12)));
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const signal = opts.signal;

  const includePrice = String(opts.includePrice ?? "1") !== "0";
  const detailLimit = Math.max(0, Math.min(10, Number(opts.detailLimit || 6)));

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, providerKey: PROVIDER_KEY, url: LIST_URL };

  try {
    const html = await withTimeout(fetchHtml(LIST_URL, timeoutMs, signal), timeoutMs, `${PROVIDER_KEY}_list`);
    let items = parseList(html, q);

    // dedupe by url
    const seen = new Set();
    items = items.filter(it => {
      const key = safeStrLocal(it.url, 2000);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    items = items.slice(0, limit);

    if (includePrice && detailLimit > 0) {
      const head = items.slice(0, Math.min(detailLimit, items.length));
      const tail = items.slice(head.length);

      const enriched = [];
      for (const it of head) enriched.push(await enrichWithProfilePrice(it, timeoutMs, signal));
      items = [...enriched, ...tail];
    }

    // normalize + contract lock
    const normalized = [];
    for (const it of coerceItemsS200(items)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        baseUrl: BASE,
        currency: "TRY",
        category: "psychology",
        vertical: "health",
        requireRealUrlCandidate: true,
      });
      if (n) normalized.push(n);
    }

    // final dedupe by id
    const seenId = new Set();
    const deduped = [];
    for (const it of normalized) {
      const k = String(it?.id || "");
      if (!k || seenId.has(k)) continue;
      seenId.add(k);
      deduped.push(it);
    }

    return _mkRes(deduped.length > 0, deduped, {
      provider: PROVIDER_KEY,
      base: BASE,
      list: LIST_URL,
      query: q,
      includePrice,
      detailLimit,
      ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = _errStr(e);
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";

    if (ALLOW_STUBS) {
      // DEV stub (never in prod)
      const stubUrl = addUtm(LIST_URL, PROVIDER_KEY);
      const stubTitle = "Terappin — Psikologlar";
      const stubItem = {
        id: stableIdS200(PROVIDER_KEY, stubUrl, stubTitle),
        title: stubTitle,
        url: stubUrl,
        originUrl: LIST_URL,
        price: null,
        currency: "TRY",
        category: "psychology",
        vertical: "health",
        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,
        raw: { stub: true, reason: msg },
      };

      const n = normalizeItemS200(stubItem, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        baseUrl: BASE,
        currency: "TRY",
        category: "psychology",
        vertical: "health",
        requireRealUrlCandidate: true,
      });

      return _mkRes(true, n ? [n] : [], { stub: true, error: msg, timeout: !!isTimeout, ms: Date.now() - t0 });
    }

    return _mkRes(false, [], { code: isTimeout ? "TIMEOUT" : "ERROR", error: msg, timeout: !!isTimeout, ms: Date.now() - t0 });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export default searchTerappinAdapter;
