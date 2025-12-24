// server/adapters/meetupAdapter.js
// ============================================================================
// MEETUP — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S22 tabanı korunur, sadece S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// NO FAKE RESULTS: fetch fail / no result => empty; never dummy listing in PROD
// Observable fail: ok:false + items:[] + _meta.code/error/timeout
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random yasak)
// withTimeout everywhere + global ctx set
// ============================================================================

import axios from "axios";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ---------------- HELPERS ----------------
const clean = (v) => safeStr(v, 2200).trim();

// ZERO DELETE: stableId adı korunur; random temizlendi
function stableId(url, i, title = "") {
  // index'i dahil etme: deterministik ve order-independent kalsın
  return stableIdS200("meetup", url || "", title || `meetup_${i ?? 0}`);
}

function detectCity(text = "") {
  const t = String(text || "").toLowerCase();
  const cities = [
    "istanbul","ankara","izmir","antalya","bursa","adana",
    "london","berlin","paris","new york",
  ];
  return cities.find((c) => t.includes(c)) || null;
}

function categoryAI(title = "") {
  const t = String(title || "").toLowerCase();
  if (/yazılım|developer|tech|ai|machine/.test(t)) return "event_tech";
  if (/network|topluluk|community/.test(t)) return "event_social";
  if (/workshop|eğitim|training/.test(t)) return "event_workshop";
  return "event";
}

function computeQualityScore({ title, image }) {
  let s = 0;
  if ((title || "").length > 4) s += 0.3;
  if (image) s += 0.4;
  return Number(s.toFixed(2));
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
    source: "meetup",
    _meta: { ...meta },
  };
}

function parseRegionOptions(regionOrOptions = "GLOBAL") {
  let region = "GLOBAL";
  let signal = null;
  let timeoutMs = Number(process.env.MEETUP_TIMEOUT_MS || 7000);

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "GLOBAL";
    signal = regionOrOptions.signal || null;
    if (Number.isFinite(Number(regionOrOptions.timeoutMs))) {
      timeoutMs = Math.max(1200, Math.min(20000, Number(regionOrOptions.timeoutMs)));
    }
  }
  return { region: String(region || "GLOBAL").toUpperCase(), signal, timeoutMs };
}

async function fetchMeetupHTML(url, signal, timeoutMs) {
  // proxy-first
  try {
    return await withTimeout(proxyFetchHTML(url), timeoutMs, "meetup.proxyFetch");
  } catch (e) {
    const res = await withTimeout(
      axios.get(url, {
        signal,
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200-Event)",
          Accept: "text/html,application/xhtml+xml",
        },
      }),
      timeoutMs,
      "meetup.axiosFetch"
    );
    return res?.data;
  }
}

async function runMeetupS200(query = "", opts = {}) {
  const t0 = Date.now();
  const qRaw = clean(query);
  const { region, signal, timeoutMs } = parseRegionOptions(opts?.regionOrOptions || opts?.region || opts || "GLOBAL");

  if (!qRaw) return _mkRes(true, [], { code: "OK_EMPTY", region, ms: Date.now() - t0, timeoutMs });

  const q = encodeURIComponent(qRaw);
  const url = `https://www.meetup.com/find/?keywords=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "meetup_adapter", providerKey: "meetup", url };

  try {
    const html = String(await fetchMeetupHTML(url, signal, timeoutMs) || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url, region, ms: Date.now() - t0, timeoutMs });

    const $ = loadCheerioS200(html, { adapter: "meetup_adapter", providerKey: "meetup", url });
    const results = [];

    // Meetup event-card pattern (kept, but safer: DOM + regex hybrid)
    // 1) try DOM-ish list items
    $("li.event-card, li[class*=\"event-card\"]").each((i, el) => {
      const wrap = $(el);
      const title = clean(wrap.find("h3").first().text()) || clean(wrap.find("[data-testid*=\"event-card\"] h3").text());
      if (!title) return;

      let href = clean(wrap.find("a").first().attr("href"));
      if (!href) return;
      if (!href.startsWith("http")) href = "https://www.meetup.com" + href;

      const rawImg =
        clean(wrap.find("img").first().attr("src")) ||
        clean(wrap.find("img").first().attr("data-src")) ||
        null;

      const img = buildImageVariants(rawImg);

      const price = sanitizePrice(null);
      const optimizedPrice = optimizePrice({ price }, { provider: "meetup" });

      const id = stableId(href, i, title);
      const geoSignal = detectCity(title);
      const cat = categoryAI(title);
      const qualityScore = computeQualityScore({ title, image: rawImg });

      results.push({
        id,
        title,
        price: null,
        optimizedPrice,
        rating: null,

        provider: "event",
        providerFamily: "event",
        providerKey: "meetup",
        providerType: "provider",

        currency: "TRY",
        region: region || "GLOBAL",
        vertical: "event",
        category: "event",
        categoryAI: cat,

        image: img.image,
        imageProxy: img.imageProxy,
        imageOriginal: img.imageOriginal,
        hasProxy: img.hasProxy,

        url: href,
        originUrl: href,
        deeplink: href,

        geoSignal,
        qualityScore,
        fallback: false,

        raw: { title, href, rawImg },
      });
    });

    // 2) fallback: regex (kept)
    if (results.length === 0) {
      const cardRegex = /<li class="[^"]*event-card[^"]*"[\s\S]*?<\/li>/gi;
      let match;
      let i = 0;

      while ((match = cardRegex.exec(html))) {
        const block = match[0];

        const urlMatch = block.match(/href="(.*?)"/i);
        const titleMatch = block.match(/<h3.*?>(.*?)<\/h3>/i);
        const imgMatch = block.match(/<img.*?src="(.*?)"/i);

        const title = titleMatch ? clean(titleMatch[1]) : "";
        if (!title) continue;

        let href = urlMatch ? clean(urlMatch[1]) : "";
        if (!href) continue;
        if (!href.startsWith("http")) href = "https://www.meetup.com" + href;

        const rawImg = imgMatch ? clean(imgMatch[1]) : null;
        const img = buildImageVariants(rawImg);

        const price = sanitizePrice(null);
        const optimizedPrice = optimizePrice({ price }, { provider: "meetup" });

        results.push({
          id: stableId(href, i++, title),
          title,
          price: null,
          optimizedPrice,
          rating: null,

          provider: "event",
          providerFamily: "event",
          providerKey: "meetup",
          providerType: "provider",

          currency: "TRY",
          region: region || "GLOBAL",
          vertical: "event",
          category: "event",
          categoryAI: categoryAI(title),

          image: img.image,
          imageProxy: img.imageProxy,
          imageOriginal: img.imageOriginal,
          hasProxy: img.hasProxy,

          url: href,
          originUrl: href,
          deeplink: href,

          geoSignal: detectCity(title),
          qualityScore: computeQualityScore({ title, image: rawImg }),
          fallback: false,

          raw: { title, href, rawImg },
        });
      }
    }

    // normalize + contract lock + url priority
    const normalized = [];
    for (const it of coerceItemsS200(results)) {
      const n = normalizeItemS200(it, "meetup", {
        providerFamily: "event",
        vertical: "event",
        region,
        currency: "TRY",
        baseUrl: "https://www.meetup.com",
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
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      url,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// PUBLIC EXPORTS (ZERO DELETE)
// - searchMeetupAdapter: S200 strict output
// - searchMeetupScrape: legacy array output (items only)
// ============================================================================
export async function searchMeetupAdapter(query = "", opts = {}) {
  return runMeetupS200(query, opts);
}

export async function searchMeetupScrape(query = "", opts = {}) {
  const r = await runMeetupS200(query, opts);
  return r.items || [];
}

export default {
  searchMeetupAdapter,
  searchMeetupScrape,
};
