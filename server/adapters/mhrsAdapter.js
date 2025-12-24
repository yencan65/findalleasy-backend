// server/adapters/mhrsAdapter.js
// ============================================================================
// MHRS — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S22 tabanı korunur; S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// NO FAKE: url yoksa drop (generic link üretme yok)
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

// ============================================================================
// HELPERS
// ============================================================================
const clean = (v) => safeStr(v, 1800).trim();

function pick(...vals) {
  for (const v of vals) {
    if (v && String(v).trim().length > 1) return String(v).trim();
  }
  return "";
}

// ZERO DELETE: stableId adı korunur; random temizlendi
function stableId(url, title, i) {
  return stableIdS200("mhrs", String(url || ""), String(title || `mhrs_${i ?? 0}`));
}

function detectHealthCategory(branch) {
  if (!branch) return "health";
  const b = String(branch || "").toLowerCase();

  if (/diş|odont|implant/.test(b)) return "dentist";
  if (/göz|oftalmoloji/.test(b)) return "ophthalmology";
  if (/kardiyoloji|kalp/.test(b)) return "cardiology";
  if (/ortopedi|travma/.test(b)) return "orthopedics";
  if (/psikiyatri|psikoloji/.test(b)) return "psychiatry";
  if (/dahiliye|iç hast/.test(b)) return "internal_medicine";

  return "health";
}

function computeQualityScore(item) {
  let s = 0;
  if ((item.title || "").length > 5) s += 0.35;
  if (item.branch) s += 0.25;
  if (item.hospital) s += 0.25;
  return Number(s.toFixed(2));
}

function extractGeo(text) {
  if (!text) return null;
  const t = String(text || "").toLowerCase();
  if (/ankara|istanbul|izmir|antalya|bursa|adana|konya/.test(t)) return t;
  return null;
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
    source: "mhrs",
    _meta: { ...meta },
  };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MHRS_TIMEOUT_MS || 12000);

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
    return await withTimeout(proxyFetchHTML(url), timeoutMs, "mhrs.proxyFetch");
  } catch {
    const { data } = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          "Accept-Language": "tr-TR,tr;q=0.9",
        },
      }),
      timeoutMs,
      "mhrs.axiosFetch"
    );
    return data;
  }
}

async function runMHRSS200(query, regionOrOptions = "TR", signalOverride = null) {
  const t0 = Date.now();
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);
  const sig = signalOverride || signal;

  const qClean = clean(query);
  if (!qClean) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs, ms: Date.now() - t0 });

  const q = encodeURIComponent(qClean);
  const url = `https://mhrs.gov.tr/YS.Doktor/Arama?searchText=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "mhrs_adapter", providerKey: "mhrs", url };

  try {
    const html = String(await fetchHTML(url, sig, timeoutMs) || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url, region, timeoutMs, ms: Date.now() - t0 });

    const $ = loadCheerioS200(html, { adapter: "mhrs_adapter", providerKey: "mhrs", url });
    const candidates = [];

    const selectors = [
      ".doctor-list-item",
      ".doktor-card",
      ".search-item",
      ".doctor-item",
      ".list-item",
      "[data-doctor-id]",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title = pick(
        clean(wrap.find(".doktor-ad").text()),
        clean(wrap.find(".doctor-name").text()),
        clean(wrap.find("h3").text()),
        clean(wrap.find(".name").text())
      );
      if (!title) return;

      const branch = pick(
        clean(wrap.find(".brans").text()),
        clean(wrap.find(".specialty").text()),
        clean(wrap.find(".branch").text())
      );

      const hospital = pick(
        clean(wrap.find(".hastane-ad").text()),
        clean(wrap.find(".clinic-name").text()),
        clean(wrap.find(".hospital").text())
      );

      let href = clean(wrap.find("a").attr("href") || "");
      if (!href) return; // NO FAKE URL
      if (!href.startsWith("http")) href = "https://mhrs.gov.tr" + href;

      const id = stableId(href, title, i);

      const price = sanitizePrice(null);
      const optimizedPrice = optimizePrice({ price }, { provider: "mhrs" });

      const imageVariants = buildImageVariants(null);

      const categoryAI = detectHealthCategory(branch);
      const qualityScore = computeQualityScore({ title, branch, hospital });
      const geo = extractGeo(hospital);

      candidates.push({
        id,
        title,
        branch,
        hospital,
        price: null,
        optimizedPrice,
        rating: null,

        provider: "health",
        providerFamily: "health",
        providerKey: "mhrs",
        providerType: "provider",

        currency: "TRY",
        region: region.toUpperCase(),
        vertical: "health",
        category: "health",
        categoryAI,
        qualityScore,
        geoSignal: geo,

        url: href,
        originUrl: href,
        deeplink: href,

        image: imageVariants.image,
        imageOriginal: imageVariants.imageOriginal,
        imageProxy: imageVariants.imageProxy,
        hasProxy: imageVariants.hasProxy,

        raw: { title, branch, hospital, href },
      });
    });

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, "mhrs", {
        providerFamily: "health",
        vertical: "health",
        region,
        currency: "TRY",
        baseUrl: "https://mhrs.gov.tr",
        requireRealUrlCandidate: true,
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
export async function searchMHRS(query, regionOrOptions = "TR", signal) {
  const r = await runMHRSS200(query, regionOrOptions, signal);
  return r.items || [];
}

export async function searchMHRSAdapter(query, regionOrOptions = "TR") {
  return runMHRSS200(query, regionOrOptions);
}

export const searchMHRSScrape = searchMHRS;

export default {
  searchMHRS,
  searchMHRSAdapter,
  searchMHRSScrape,
};
