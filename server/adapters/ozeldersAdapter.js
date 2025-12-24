// server/adapters/ozeldersAdapter.js
// ============================================================================
// OZELDERS — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// withTimeout everywhere + global ctx set
// ZERO DELETE: export isimleri korunur
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

const PROVIDER_KEY = "ozelders";
const ADAPTER_KEY = "ozelders_education";
const PROVIDER_FAMILY = "education";
const BASE = "https://www.ozelders.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.OZELDERS_TIMEOUT_MS || 9000);

const clean = (v, max = 1200) => safeStr(v, max).trim();

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

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

function parsePrice(txt) {
  const n = sanitizePrice(txt, { provider: PROVIDER_KEY });
  return Number.isFinite(n) ? n : null;
}

function detectDeepBranchCategory(title, detail, city) {
  const t = `${title || ""} ${detail || ""} ${city || ""}`.toLowerCase();

  if (/matematik|geometri|ayt|tyt/.test(t)) return "education_math";
  if (/fizik|kimya|biyoloji|fen/.test(t)) return "education_science";
  if (/ingilizce|almanca|fransızca|rusça|italyanca|yabancı/.test(t)) return "education_language";
  if (/piyano|gitar|keman|müzik|vokal/.test(t)) return "education_music";
  if (/yüzme|spor|fitness|tenis/.test(t)) return "education_sports";
  if (/yazılım|coding|programlama|python|javascript|cs|developer/.test(t)) return "education_software";

  return "education";
}

function extractImage($, el) {
  const raw =
    clean($(el).find("img").attr("data-src"), 2000) ||
    clean($(el).find("img").attr("src"), 2000) ||
    "";
  return buildImageVariants(raw || null);
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
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

async function scrapeOzelDersInternal(query, region, signal, timeoutMs) {
  const q = encodeURIComponent(query);
  const url = `${BASE}/arama?kelime=${q}`;

  let html = "";
  try {
    html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${ADAPTER_KEY}.proxyFetch`);
    html = String(html || "");
  } catch (e) {
    const res = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
      }),
      timeoutMs,
      `${ADAPTER_KEY}.axiosFetch`
    );
    html = String(res?.data || "");
  }

  if (!html) {
    const ex = new Error("FETCH_FAIL");
    ex.code = "FETCH_FAIL";
    ex.url = url;
    throw ex;
  }

  const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
  const out = [];

  const selectors = [
    ".searchResultBox",
    ".resultBox",
    ".teacher-card",
    ".card",
    ".profil",
    ".teacher",
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      clean(wrap.find(".ogretmenIsim").text()) ||
      clean(wrap.find(".teacherName").text()) ||
      clean(wrap.find("h3").text());
    if (!title) return;

    let href =
      clean(wrap.find("a").attr("href"), 2000) ||
      clean(wrap.find(".teacher-link").attr("href"), 2000);
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + href;

    const priceTxt =
      clean(wrap.find(".price").text()) ||
      clean(wrap.find(".teacherPrice").text()) ||
      "";

    // Site fiyat stabil vermiyor → null acceptable
    const price = parsePrice(priceTxt) || null;

    const branchTxt =
      clean(wrap.find(".ogretmenBrans").text()) ||
      clean(wrap.find(".branch").text()) ||
      clean(wrap.find(".title").text());

    const city =
      clean(wrap.find(".ogretmenAdres").text()) ||
      clean(wrap.find(".teacherCity").text()) ||
      "";

    const img = extractImage($, el);
    const category = detectDeepBranchCategory(title, branchTxt, city);

    let item = {
      id: stableIdS200(PROVIDER_KEY, href, title),
      title,
      price,
      provider: PROVIDER_FAMILY,
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerType: "provider",

      vertical: "education",
      category,

      url: href,
      originUrl: href,
      deeplink: href,

      currency: "TRY",
      region,
      rating: null,

      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,

      branch: branchTxt,
      city,

      raw: {
        title,
        priceTxt,
        href,
        branchTxt,
        city,
      },
    };

    item = optimizePrice(item, { provider: PROVIDER_KEY });
    out.push(item);
  });

  return out;
}

// PUBLIC API (ZERO DELETE) — Artık S200 formatında döner
export async function searchOzelDers(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const q = clean(query, 240);
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);

  if (!q) {
    return _mkRes(true, [], {
      code: "OK_EMPTY",
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  }

  const ctxUrl = `${BASE}/arama?kelime=${encodeURIComponent(q)}`;
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: ctxUrl };

  try {
    const raw = await scrapeOzelDersInternal(q, region, signal, timeoutMs);

    const normalized = [];
    for (const it of coerceItemsS200(raw)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: "education",
        category: it?.category || "education",
        region,
        currency: "TRY",
        baseUrl: BASE,
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
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : (e?.code || "ERROR"),
      error: _errStr(e?.cause || e),
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// Aliases (silinmeden korunuyor)
export const searchOzelDersScrape = searchOzelDers;
export const searchOzelDersAdapter = searchOzelDers;

export default {
  searchOzelDers,
  searchOzelDersScrape,
  searchOzelDersAdapter,
};
