// server/adapters/memorialAdapter.js
// ============================================================================
// MEMORIAL HEALTH — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S5/S22 tabanı korunur, S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
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

const safe = (v) => safeStr(v, 2000).trim();

// ---- S22 Pricer (kept) ----
function parsePrice(txt) {
  if (!txt) return null;
  try {
    const cleaned = String(txt)
      .replace(/[^\d.,]/g, "")
      .replace(/\./g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---- Stable ID (ZERO DELETE name preserved, random removed) ----
function stableId(url, i, title = "") {
  return stableIdS200("memorial", String(url || ""), String(title || `memorial_${i ?? 0}`));
}

// ---- Category AI (kept) ----
function detectCategory(title = "", type = "health") {
  const t = String(title || "").toLowerCase();

  if (type === "doctor") return "doctor";
  if (type === "treatment") {
    if (/ameliyat|cerrahi|surgery/.test(t)) return "treatment_surgery";
    if (/kontrol|muayene|check/.test(t)) return "treatment_consultation";
    return "treatment";
  }
  if (type === "package") {
    if (/premium|advanced/.test(t)) return "package_premium";
    return "health_package";
  }

  return "health";
}

function computeQualityScore({ title, price, image }) {
  let s = 0;
  if (price) s += 0.45;
  if (image) s += 0.25;
  if ((title || "").length > 6) s += 0.2;
  return Number(s.toFixed(2));
}

function extractGeoSignal(title = "") {
  const t = String(title || "").toLowerCase();
  const cities = ["istanbul", "ankara", "antalya", "gaziantep", "diyarbakır"];
  return cities.find((c) => t.includes(c)) || null;
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
    source: "memorial",
    _meta: { ...meta },
  };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MEMORIAL_TIMEOUT_MS || 12000);

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

async function fetchMemorialHTML(url, signal, timeoutMs) {
  try {
    return await withTimeout(proxyFetchHTML(url), timeoutMs, "memorial.proxyFetch");
  } catch {
    const { data } = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
      }),
      timeoutMs,
      "memorial.axiosFetch"
    );
    return data;
  }
}

// ============================================================================
// MAIN — S200 STRICT OUTPUT
// ============================================================================
async function runMemorialS200(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);

  const qClean = safe(query);
  if (!qClean) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs, ms: Date.now() - t0 });

  const q = encodeURIComponent(qClean);
  const url = `https://www.memorial.com.tr/arama?search=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "memorial_adapter", providerKey: "memorial", url };

  try {
    const html = String(await fetchMemorialHTML(url, signal, timeoutMs) || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url, region, timeoutMs, ms: Date.now() - t0 });

    const $ = loadCheerioS200(html, { adapter: "memorial_adapter", providerKey: "memorial", url });
    const candidates = [];

    // 1) DOKTORLAR
    const doctorSelectors = [
      ".doctor-card",
      ".doctor",
      ".arama-doktor",
      ".doctor-item",
      "[data-doctor-id]",
      ".col-md-4 .doctor-card",
    ];

    $(doctorSelectors.join(",")).each((i, el) => {
      const w = $(el);

      const name =
        safe(w.find(".doctor-name").text()) ||
        safe(w.find("h3").text()) ||
        safe(w.find(".name").text());
      if (!name) return;

      const hrefRaw = safe(w.find("a").attr("href"));
      if (!hrefRaw) return;

      const href = hrefRaw.startsWith("http")
        ? hrefRaw
        : `https://www.memorial.com.tr${hrefRaw}`;

      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("data-original")) ||
        safe(w.find("img").attr("src")) ||
        safe(w.find("picture img").attr("src")) ||
        null;

      const img = buildImageVariants(imgRaw);

      const id = stableId(href, i, name);
      const categoryAI = detectCategory(name, "doctor");
      const qualityScore = computeQualityScore({ title: name, price: null, image: imgRaw });
      const geoSignal = extractGeoSignal(name);

      candidates.push({
        id,
        title: name,
        price: null,
        optimizedPrice: null,
        rating: null,

        provider: "health",
        providerFamily: "health",
        providerKey: "memorial",
        providerType: "provider",

        currency: "TRY",
        region,
        vertical: "health",
        category: "doctor",
        categoryAI,
        qualityScore,

        url: href,
        originUrl: href,
        deeplink: href,

        image: img.image,
        imageProxy: img.imageProxy,
        imageOriginal: img.imageOriginal,
        hasProxy: img.hasProxy,

        geoSignal,
        raw: { name, href, imgRaw },
      });
    });

    // 2) PAKETLER / TEDAVİ
    const packageSelectors = [
      ".package-card",
      ".paket-item",
      ".treatment-card",
      ".treatment-item",
      ".health-package",
      ".checkup-card",
      "[data-package-id]",
    ];

    $(packageSelectors.join(",")).each((i, el) => {
      const w = $(el);

      const title =
        safe(w.find(".package-title").text()) ||
        safe(w.find("h3").text()) ||
        safe(w.find(".title").text());
      if (!title) return;

      const priceRaw = parsePrice(
        safe(w.find(".price").text()) ||
          safe(w.find(".package-price").text()) ||
          safe(w.find(".amount").text())
      );

      const price = sanitizePrice(priceRaw);
      const optimizedPrice = optimizePrice({ price }, { provider: "memorial" });

      const hrefRaw = safe(w.find("a").attr("href"));
      if (!hrefRaw) return;

      const href = hrefRaw.startsWith("http")
        ? hrefRaw
        : `https://www.memorial.com.tr${hrefRaw}`;

      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("data-original")) ||
        safe(w.find("img").attr("src")) ||
        safe(w.find("picture img").attr("src")) ||
        null;

      const img = buildImageVariants(imgRaw);

      const id = stableId(href, i, title);
      const categoryAI = detectCategory(title, "package");
      const geoSignal = extractGeoSignal(title);
      const qualityScore = computeQualityScore({ title, price, image: imgRaw });

      candidates.push({
        id,
        title,
        price,
        optimizedPrice,
        rating: null,

        provider: "health",
        providerFamily: "health",
        providerKey: "memorial",
        providerType: "provider",

        currency: "TRY",
        region,
        vertical: "health",
        category: "health_package",
        categoryAI,
        qualityScore,

        url: href,
        originUrl: href,
        deeplink: href,

        image: img.image,
        imageProxy: img.imageProxy,
        imageOriginal: img.imageOriginal,
        hasProxy: img.hasProxy,

        geoSignal,
        raw: { title, priceRaw, href, imgRaw },
      });
    });

    // normalize
    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, "memorial", {
        providerFamily: "health",
        vertical: "health",
        region,
        currency: "TRY",
        baseUrl: "https://www.memorial.com.tr",
        requireRealUrlCandidate: true,
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
export async function searchMemorial(query, regionOrOptions = "TR") {
  // legacy: array only
  const r = await runMemorialS200(query, regionOrOptions);
  return r.items || [];
}

export async function searchMemorialAdapter(query, regionOrOptions = "TR") {
  // S200 strict output
  return runMemorialS200(query, regionOrOptions);
}

export const searchMemorialScrape = searchMemorial;

export default {
  searchMemorial,
  searchMemorialAdapter,
  searchMemorialScrape,
};
