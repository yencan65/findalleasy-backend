// server/adapters/ruhunaIyiBakAdapter.js
// ============================================================================
// RUHUNA İYİ BAK ADAPTER — S200 HARDENED (ZERO-CRASH, NO-FAKE)
// - Output: { ok, items, count, source, _meta }
// - Deterministic id via stableIdS200 (NO RANDOM)
// - Observable fail: ok:false + items:[] (+ _meta.error)
// - DEV stub only when FINDALLEASY_ALLOW_STUBS=1 and NODE_ENV!=production
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

import {
  loadCheerioS200,
  normalizeItemS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

const DEFAULT_TIMEOUT_MS = Number(process.env.RUHUNA_IYI_BAK_TIMEOUT_MS || 9000);

const PROVIDER_KEY = "ruhuna_iyi_bak";
const ADAPTER_KEY = "ruhuna_iyi_bak_support";
const PROVIDER_FAMILY = "ruhuna";

// Page commonly used for the initiative (can be overridden)
const PAGE_URL = String(process.env.RUHUNA_IYI_BAK_URL || "https://ituogrenci.org.tr/psikolojik-destek");

function safeStrLocal(v, max = 600) {
  const s = v == null ? "" : String(v);
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}
function normSpace(s) {
  return safeStrLocal(s, 3000).replace(/\s+/g, " ").trim();
}
function addUtm(url) {
  const u = safeStrLocal(url, 2000);
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (!parsed.searchParams.get("utm_source")) parsed.searchParams.set("utm_source", "findalleasy");
    if (!parsed.searchParams.get("utm_medium")) parsed.searchParams.set("utm_medium", "ref");
    if (!parsed.searchParams.get("utm_campaign")) parsed.searchParams.set("utm_campaign", "psychology");
    if (!parsed.searchParams.get("utm_content")) parsed.searchParams.set("utm_content", "ruhuna_iyi_bak");
    return parsed.toString();
  } catch {
    return u;
  }
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 350);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}

async function fetchHtml(url, timeoutMs, signal) {
  const tms = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const res = await axios.get(url, {
    timeout: Math.max(1500, Math.min(15000, tms)),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
    },
    ...(signal ? { signal } : {}),
  });
  return String(res?.data || "");
}

function pickFormLink($) {
  let best = "";

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const txt = normSpace($(el).text()).toLowerCase();
    if (!href) return;

    const h = String(href);
    const isFormish =
      txt.includes("form") ||
      txt.includes("başvur") ||
      txt.includes("doldur") ||
      h.includes("forms") ||
      h.includes("form");

    if (!isFormish) return;

    let url = h;
    if (url.startsWith("//")) url = `https:${url}`;
    if (url.startsWith("/")) {
      try {
        const u = new URL(PAGE_URL);
        url = `${u.origin}${url}`;
      } catch {}
    }

    if (!best) best = url;
    if (/forms\.g(le|oo)gle\.com/i.test(url)) best = url;
  });

  return best;
}

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = { ok: !!ok, items: arr, count: arr.length, source: PROVIDER_KEY, _meta: { ...meta } };
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

export async function searchRuhunaIyiBakAdapter(query, opts = {}) {
  const t0 = Date.now();
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: PAGE_URL };

  try {
    const html = await withTimeout(fetchHtml(PAGE_URL, timeoutMs, opts.signal), timeoutMs, `${ADAPTER_KEY}.fetch`);
    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: PAGE_URL });

    const formUrl = pickFormLink($);
    const pageText = normSpace($.text());

    const finalUrl = addUtm(formUrl || PAGE_URL);

    const candidate = {
      id: stableIdS200(PROVIDER_KEY, finalUrl, "Ruhuna İyi Bak — Psikolojik Destek Başvurusu"),
      title: "Ruhuna İyi Bak — Psikolojik Destek Başvurusu",
      url: finalUrl,
      originUrl: finalUrl,
      deeplink: finalUrl,
      price: null,

      provider: PROVIDER_FAMILY,
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerType: "discovery",

      category: "psychology",
      vertical: "psychology",
      region: "TR",
      currency: "TRY",

      rating: null,

      raw: {
        hasFormLink: !!formUrl,
        snippet: safeStrLocal(pageText, 700),
        source: "page_scrape",
      },
    };

    const item = normalizeItemS200(candidate, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: "psychology",
      category: "psychology",
      region: "TR",
      currency: "TRY",
      baseUrl: "https://ituogrenci.org.tr",
    });

    if (!item) {
      return _mkRes(false, [], {
        code: "NORMALIZE_DROP",
        error: "normalizeItemS200 returned null",
        page: PAGE_URL,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }

    return _mkRes(true, [item], {
      code: "OK",
      page: PAGE_URL,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (e) {
    const msg = _errStr(e);
    const code = _isTimeout(e) ? "TIMEOUT" : "ERROR";
    console.warn("❌ ruhunaIyiBakAdapter error:", msg);

    if (ALLOW_STUBS) {
      const finalUrl = addUtm(PAGE_URL);
      const stubCandidate = {
        id: stableIdS200(PROVIDER_KEY, finalUrl, "Ruhuna İyi Bak — Psikolojik Destek"),
        title: "Ruhuna İyi Bak — Psikolojik Destek",
        url: finalUrl,
        originUrl: finalUrl,
        deeplink: finalUrl,
        price: null,

        provider: PROVIDER_FAMILY,
        providerFamily: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerType: "discovery",

        category: "psychology",
        vertical: "psychology",
        region: "TR",
        currency: "TRY",

        raw: { stub: true, reason: msg },
      };

      const stubItem = normalizeItemS200(stubCandidate, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: "psychology",
        category: "psychology",
        region: "TR",
        currency: "TRY",
        baseUrl: "https://ituogrenci.org.tr",
      });

      return _mkRes(true, stubItem ? [stubItem] : [], {
        code: "STUB_OK_ON_FAIL",
        stub: true,
        page: PAGE_URL,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }

    return _mkRes(false, [], {
      code,
      error: msg,
      page: PAGE_URL,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export default searchRuhunaIyiBakAdapter;
