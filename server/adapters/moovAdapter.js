// server/adapters/moovAdapter.js
// ============================================================================
// MOOV — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: API yaklaşımı korunur; S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
// withTimeout everywhere + global ctx set
// ============================================================================

import axios from "axios";
import { proxyFetchHTML } from "../core/proxyEngine.js"; // used as proxy-first fetch for JSON too

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// HELPERS (kept)
// ---------------------------------------------------------------------------
const clean = (v) => safeStr(v, 1600).trim();

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source: "moov", _meta: { ...meta } };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MOOV_TIMEOUT_MS || 9000);

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

function detectCategory() {
  return "car_rental";
}

// Placeholder image for Moov vehicles (kept)
const DEFAULT_IMAGE = "https://cdn-icons-png.flaticon.com/512/2972/2972185.png";

// ---------------------------------------------------------------------------
// FETCH ENGINE — proxy-first (via proxyFetchHTML), then axios
// ---------------------------------------------------------------------------
async function fetchMoovJSON(url, signal, timeoutMs) {
  // 1) proxy-first: proxyFetchHTML may return JSON string
  try {
    const raw = await withTimeout(proxyFetchHTML(url), timeoutMs, "moov.proxyFetch");
    if (raw && typeof raw === "object") return raw; // in case proxy already parsed
    const txt = String(raw || "");
    if (!txt) throw new Error("EMPTY_PROXY");
    return JSON.parse(txt);
  } catch (e) {
    const { data } = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
      }),
      timeoutMs,
      "moov.axiosFetch"
    );
    return data;
  }
}

// ---------------------------------------------------------------------------
// MAIN ADAPTER — S200
// ---------------------------------------------------------------------------
export async function searchMoovAdapter(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);

  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  const url = `https://moov.com.tr/api/search?q=${encodeURIComponent(q)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "moov_adapter", providerKey: "moov", url };

  try {
    const json = await fetchMoovJSON(url, sig || signal, timeoutMs);

    if (!json || !Array.isArray(json.results)) {
      return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs, note: "NO_RESULTS_ARRAY" });
    }

    const candidates = [];
    let droppedNoUrl = 0;

    for (let i = 0; i < json.results.length; i++) {
      const x = json.results[i];
      const title = clean(x?.name || x?.title || "Araç Kiralama");
      const itemUrl = clean(x?.url || "");
      if (!itemUrl) {
        droppedNoUrl++;
        continue; // NO FAKE URL
      }

      const priceRaw = x?.price ?? null;
      const price = sanitizePrice(priceRaw);
      const optimizedPrice = optimizePrice({ price }, { provider: "moov" });

      const img = x?.image || DEFAULT_IMAGE;
      const image = buildImageVariants(img, "moov");

      candidates.push({
        id: stableIdS200("moov", itemUrl, title),
        title,
        price,
        optimizedPrice,
        rating: null,

        provider: "car_rental",
        providerFamily: "car_rental",
        providerKey: "moov",
        providerType: "provider",

        currency: "TRY",
        region,
        vertical: "car_rental",
        category: "car_rental",
        categoryAI: detectCategory(),

        url: itemUrl,
        originUrl: itemUrl,
        deeplink: itemUrl,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        raw: { title, priceRaw, image: img, original: x },
      });
    }

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, "moov", {
        providerFamily: "car_rental",
        vertical: "car_rental",
        category: "car_rental",
        region,
        currency: "TRY",
        baseUrl: "https://moov.com.tr",
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
      region,
      timeoutMs,
      droppedNoUrl: droppedNoUrl || undefined,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      region,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export default { searchMoovAdapter };
