import axios from "axios";
import { getCachedResult, setCachedResult } from "../core/cacheEngine.js";
import { normalizeItemS200, normalizeUrlS200, safeString, compactWords } from "../core/s200AdapterKit.js";

const BASE_URL = process.env.COLLECTAPI_BASE_URL || "https://api.collectapi.com/shopping/search";

function getApiKey() {
  return (
    process.env.COLLECTAPI_APIKEY ||
    process.env.COLLECTAPI_KEY ||
    process.env.COLLECTAPI_TOKEN ||
    ""
  ).trim();
}

function mkS200(ok, items = [], meta = {}) {
  return {
    ok: !!ok,
    items: Array.isArray(items) ? items : [],
    count: Array.isArray(items) ? items.length : 0,
    source: meta?.source || "collectapi",
    providerKey: meta?.providerKey || "collectapi",
    meta,
  };
}

function parsePrice(raw) {
  const s = String(raw ?? "").replace(/[^0-9.,]/g, "").trim();
  if (!s) return null;
  // Try TR style: 1.234,56
  let t = s;
  const hasComma = t.includes(",");
  const hasDot = t.includes(".");
  if (hasComma && hasDot) {
    // assume dot thousands, comma decimals
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    t = t.replace(",", ".");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function normalizeCollectItem(it, { providerFamily, providerKey, providerName, currency }) {
  const title = safeString(it?.title || it?.name || it?.productName || it?.product_title || it?.product || it?.desc);
  const url = normalizeUrlS200(it?.url || it?.link || it?.productLink || it?.product_url || it?.href);
  const image = normalizeUrlS200(it?.image || it?.img || it?.imageUrl || it?.image_url || it?.thumbnail || it?.thumb);
  const price = parsePrice(it?.price || it?.currentPrice || it?.newPrice || it?.salePrice || it?.amount);

  if (!title || !url) return null;

  return normalizeItemS200(
    {
      title,
      url,
      image,
      price,
      currency: currency || it?.currency || it?.currencyCode || "TRY",
      providerFamily,
      providerKey,
      providerName,
      source: providerKey,
      raw: it,
    },
    { providerFamily, providerKey }
  );
}

async function fetchCollect(q, source, timeoutMs) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const qq = compactWords(q, 14) || safeString(q);
  if (!qq) return null;

  const cacheKey = `collectapi:${source}:${qq.toLowerCase()}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const url = `${BASE_URL}?data.query=${encodeURIComponent(qq)}&data.source=${encodeURIComponent(source)}`;

  try {
    const res = await axios.get(url, {
      headers: {
        authorization: `apikey ${apiKey}`,
        "content-type": "application/json",
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (res?.status !== 200) return null;

    const data = res?.data;
    const list = Array.isArray(data?.result)
      ? data.result
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data)
          ? data
          : [];

    const out = { ok: true, list };
    setCachedResult(cacheKey, out, 90); // 90s TTL
    return out;
  } catch {
    return null;
  }
}

async function searchCollect(q, source, lang = "tr", limit = 8, ctx = {}) {
  const timeoutMs = Number(process.env.COLLECTAPI_TIMEOUT_MS || 4800);
  const resp = await fetchCollect(q, source, timeoutMs);
  if (!resp?.ok) return mkS200(false, [], { source: "collectapi", providerKey: source });

  const providerFamily = source; // show as marketplace name
  const providerKey = source;
  const providerName = source;
  const currency = "TRY";

  const items = [];
  for (const it of resp.list || []) {
    const norm = normalizeCollectItem(it, { providerFamily, providerKey, providerName, currency });
    if (norm) items.push(norm);
    if (items.length >= limit) break;
  }

  return mkS200(true, items, { source: "collectapi", providerKey: source, lang });
}

// ---- Public adapters (one per source) ----
export async function searchCollectApiTrendyol(q, lang = "tr", limit = 8, ctx = {}) {
  return searchCollect(q, "trendyol", lang, limit, ctx);
}

export async function searchCollectApiHepsiburada(q, lang = "tr", limit = 8, ctx = {}) {
  return searchCollect(q, "hepsiburada", lang, limit, ctx);
}

export async function searchCollectApiAkakce(q, lang = "tr", limit = 8, ctx = {}) {
  return searchCollect(q, "akakce", lang, limit, ctx);
}

export async function searchCollectApiTeknosa(q, lang = "tr", limit = 8, ctx = {}) {
  return searchCollect(q, "teknosa", lang, limit, ctx);
}
