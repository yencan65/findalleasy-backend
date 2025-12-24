// server/core/proxyEngine.js
// ========================================================================
//  FAE PROXY ENGINE — S15 ULTRA OMEGA (H	triggered v3)
//  ZERO-CRASH • ZERO-DUPLICATE • ANTI-BOT • MULTI-PROXY • SMART FALLBACK
//
//  PATCH v3 (S200 honesty patch):
//  ✅ axios direct fetch yerine NetClient.getHtml kullanımı (cache/retry/proxy rotator ile uyumlu)
//  ✅ 403/404/429/timeout artık "yutulmaz": tryFetch THROW eder
//  ✅ proxyFetchHTML fallback dener, en sonda hala yoksa THROW eder (S200 ok=false zinciri için)
//  ✅ Legacy proxiedGet korunur (hata yutmak isteyen eski çağrılar için safe)
//
//  - Eski fonksiyonların HEPSİ korunmuştur (sadece güçlendirildi)
// ========================================================================

import axios from "axios";
import { getHtml } from "./NetClient.js";

// MAIN WORKER
const PROXY_URL = process.env.FAE_PROXY_URL || "";

// FALLBACK PROXIES (priority-weighted)
const FALLBACK_PROXIES = [
  { url: process.env.FAE_PROXY_ALT1 || "", weight: 3 },
  { url: process.env.FAE_PROXY_ALT2 || "", weight: 2 },
  { url: process.env.FAE_PROXY_ALT3 || "", weight: 1 },
]
  .filter((p) => p.url)
  .sort((a, b) => b.weight - a.weight);

const PROXY_DEBUG = process.env.FAE_PROXY_DEBUG === "1";
const DEFAULT_TIMEOUT = Number(process.env.FAE_PROXY_TIMEOUT || 15000);
const DEFAULT_MAX_REDIRECTS = 3;

// Header profile (0=low, 1=default, 2=chromium-like)
const HEADER_PROFILE = Number(process.env.FAE_PROXY_HEADER_PROFILE || 1) || 1;

// Proxy worker auth header (opsiyonel)
const PROXY_TOKEN = process.env.FAE_PROXY_TOKEN || "";
const PROXY_TOKEN_HEADER =
  process.env.FAE_PROXY_TOKEN_HEADER || "Authorization"; // "Authorization" or "x-api-key"
const PROXY_TOKEN_PREFIX = process.env.FAE_PROXY_TOKEN_PREFIX || "Bearer"; // empty allowed

// NEW: strict fail default ON (S200 honesty)
// FAE_PROXY_SOFT_FAIL=1 => eski davranışa yakın: finalde null döner (önerilmez)
const SOFT_FAIL = process.env.FAE_PROXY_SOFT_FAIL === "1";

// -----------------------------------------------------------------------
// LOGGING
// -----------------------------------------------------------------------
function logProxy(...args) {
  if (!PROXY_DEBUG) return;
  console.warn("[FAE-PROXY]", ...args);
}

// -----------------------------------------------------------------------
// USER-AGENTS
// -----------------------------------------------------------------------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// -----------------------------------------------------------------------
// REFERER + ORIGIN
// -----------------------------------------------------------------------
function safeOriginAndReferer(targetUrl) {
  let origin = "https://www.google.com";
  let referer = "https://www.google.com/";
  try {
    const u = new URL(targetUrl);
    origin = `${u.protocol}//${u.hostname}`;
    referer = `${origin}/`;
  } catch {}
  return { origin, referer };
}

// -----------------------------------------------------------------------
// BASE HEADERS (DEFAULT)
// -----------------------------------------------------------------------
function buildBaseHeaders(targetUrl) {
  const { origin, referer } = safeOriginAndReferer(targetUrl);

  return {
    "User-Agent": pickUserAgent(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: referer,
    Origin: origin,
    DNT: "1",
  };
}

// -----------------------------------------------------------------------
// CHROMIUM-LIKE HEADERS (OPSİYONEL)
// -----------------------------------------------------------------------
function buildChromiumHeaders(targetUrl) {
  const { origin, referer } = safeOriginAndReferer(targetUrl);
  const ua = pickUserAgent();

  const looksChrome = /Chrome\/\d+/i.test(ua);

  const base = {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: referer,
    Origin: origin,
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
  };

  if (!looksChrome) return base;

  return {
    ...base,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "sec-ch-ua":
      '"Chromium";v="123", "Not:A-Brand";v="8", "Google Chrome";v="123"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

// -----------------------------------------------------------------------
// HEADER PROFILE SWITCH
// -----------------------------------------------------------------------
function buildHeaders(targetUrl, profile = HEADER_PROFILE) {
  if (profile <= 0) return { "User-Agent": "Mozilla/5.0" };
  if (profile >= 2) return buildChromiumHeaders(targetUrl);
  return buildBaseHeaders(targetUrl);
}

// -----------------------------------------------------------------------
// RESPONSE NORMALIZATION
// -----------------------------------------------------------------------
function normalizeResponse(data, contentType) {
  if (!contentType) {
    if (typeof data === "object" && data !== null) return data;
    if (typeof data === "string") {
      const t = data.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          return JSON.parse(t);
        } catch {}
      }
      return t;
    }
    return data;
  }

  const ct = String(contentType || "").toLowerCase();

  if (ct.includes("application/json")) {
    try {
      return typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      return data;
    }
  }

  if (
    ct.includes("text/html") ||
    ct.includes("application/xhtml+xml") ||
    ct.includes("xml") ||
    ct.includes("text/plain")
  ) {
    return typeof data === "string" ? data : String(data ?? "");
  }

  return data;
}

// -----------------------------------------------------------------------
// UTILS
// -----------------------------------------------------------------------
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

function isHardBlockedStatus(status) {
  // ✅ 404 eklendi (v3 hedefi)
  return status === 403 || status === 404 || status === 429 || status >= 500;
}

// 200 dönse bile captcha/block sayfası olabilir → tespit et
function looksLikeBlockPage(body) {
  if (!body || typeof body !== "string") return false;

  const t = body.slice(0, 8000).toLowerCase();

  const patterns = [
    "access denied",
    "request blocked",
    "unusual traffic",
    "our systems have detected",
    "verify you are a human",
    "captcha",
    "cloudflare",
    "attention required",
    "ddos protection",
    "bot detection",
    "forbidden",
    "geçici olarak engellendi",
    "erişiminiz kısıtlandı",
    "robot olmadığınızı doğrulayın",
  ];

  return patterns.some((p) => t.includes(p));
}

function makeProxyErr(tag, { status, url, msg, code } = {}) {
  const e = new Error(
    `${tag}${status ? ` status=${status}` : ""}${code ? ` code=${code}` : ""}${
      msg ? ` msg=${msg}` : ""
    } url=${url}`
  );
  e._fae = { tag, status, url, code, msg };
  return e;
}

// -----------------------------------------------------------------------
// LOW-LEVEL FETCH (S200 HONEST)
// - Başarısızlıkta NULL dönmek yok.
// - Başarısızlıkta THROW var.
// - proxyFetchHTML zinciri bu throw'ları yakalayıp fallback dener.
// -----------------------------------------------------------------------
async function tryFetch(url, config = {}, lowHeaders = false, targetUrl = "") {
  const method = String(config.method || "GET").toUpperCase();
  const respType = String(config.responseType || "text"); // "text" bekleniyor

  const hdrProfile = Number(config.headerProfile ?? HEADER_PROFILE);
  const baseHeaders = lowHeaders
    ? { "User-Agent": "Mozilla/5.0" }
    : buildHeaders(targetUrl || url, hdrProfile);

  const timeoutMs = config.timeout || DEFAULT_TIMEOUT;
  const adapterName = String(config.adapterName || "proxyFetchHTML");
  const retries = typeof config.retries === "number" ? config.retries : 2;

  // ✅ NetClient'e HEADER/SIGNAL/MAX_REDIRECTS taşı
  const mergedHeaders = { ...baseHeaders, ...(config.headers || {}) };
  const maxRedirects =
    typeof config.maxRedirects === "number"
      ? config.maxRedirects
      : DEFAULT_MAX_REDIRECTS;

  // 1) GET + text ise: NetClient.getHtml ile git (cache/retry/proxy rotator)
  if (method === "GET" && respType === "text") {
    const r = await getHtml(url, {
      adapterName,
      timeoutMs,
      retries,
      headers: mergedHeaders,
      signal: config.signal,
      maxRedirects,
    });

    if (!r?.ok) {
      const status = r?.error?.status;
      const code = r?.error?.code;
      const msg = r?.error?.message || "NETCLIENT_FAIL";
      logProxy("tryFetch-getHtml-fail", { status, code, url });
      throw makeProxyErr("PROXY_HTML_FAIL", { status, url, msg, code });
    }

    const html = String(r?.html ?? "");
    if (!html) throw makeProxyErr("PROXY_EMPTY_BODY", { url, msg: "empty body" });

    // 200 olsa bile block/captcha
    if (looksLikeBlockPage(html)) {
      logProxy("blocked-html", { url });
      throw makeProxyErr("PROXY_BLOCK_HTML", {
        status: 200,
        url,
        msg: "block page",
      });
    }

    return html;
  }

  // 2) POST / JSON / custom: legacy axios path (ama yutma yok → THROW)
  const cfg = {
    timeout: timeoutMs,
    signal: config.signal,
    maxRedirects,
    responseType: config.responseType || "text",
    headers: mergedHeaders,
    validateStatus: () => true, // status'ü kendimiz kontrol edeceğiz
  };

  const axiosFn = method === "POST" ? axios.post : axios.get;

  try {
    const res =
      method === "POST"
        ? await axiosFn(url, config.data || {}, cfg)
        : await axiosFn(url, cfg);

    const status = res?.status ?? 0;
    const ct = res?.headers?.["content-type"] || "";
    const body = res?.data;

    if (body == null) throw makeProxyErr("PROXY_NULL_BODY", { status, url });

    // ✅ 403/404/429/5xx → fallback için THROW
    if (isHardBlockedStatus(status)) {
      logProxy("blocked-status", { status, url });
      throw makeProxyErr("PROXY_BLOCK_STATUS", { status, url });
    }

    const normalized = normalizeResponse(body, ct);

    // HTML block/captcha detection (200'de bile)
    if (typeof normalized === "string" && looksLikeBlockPage(normalized)) {
      logProxy("blocked-html", { url });
      throw makeProxyErr("PROXY_BLOCK_HTML", {
        status: 200,
        url,
        msg: "block page",
      });
    }

    return normalized;
  } catch (e) {
    logProxy("tryFetch-error", e?.message || e);
    throw e;
  }
}

// -----------------------------------------------------------------------
// PROXY WRAPPER
// -----------------------------------------------------------------------
function buildProxyAuthHeaders() {
  const headers = {};

  // Token varsa ekle
  if (PROXY_TOKEN) {
    if (String(PROXY_TOKEN_HEADER || "").toLowerCase() === "authorization") {
      headers["Authorization"] = PROXY_TOKEN_PREFIX
        ? `${PROXY_TOKEN_PREFIX} ${PROXY_TOKEN}`.trim()
        : PROXY_TOKEN;
    } else {
      headers[PROXY_TOKEN_HEADER] = PROXY_TOKEN;
    }
  }

  // İsteğe bağlı ekstra headerlar: FAE_PROXY_HEADER_X_FOO=bar
  for (const [k, v] of Object.entries(process.env || {})) {
    if (!k || !k.startsWith("FAE_PROXY_HEADER_")) continue;
    const name = k.replace("FAE_PROXY_HEADER_", "").replace(/__/g, "-");
    if (!name) continue;
    headers[name] = String(v);
  }

  return headers;
}

async function fetchViaProxy(proxyUrl, targetUrl, config = {}) {
  if (!proxyUrl) return null;

  const finalUrl = `${proxyUrl}?url=${encodeURIComponent(targetUrl)}`;
  const proxyHeaders = {
    ...buildProxyAuthHeaders(),
    ...(config.proxyHeaders || {}),
  };

  // Proxy çağrısında target headerlarıyla karışmasın diye ayrı taşıyoruz
  // Not: tryFetch artık throw edebilir.
  return await tryFetch(
    finalUrl,
    {
      ...config,
      headers: { ...(config.headers || {}), ...proxyHeaders }, // ✅ proxy auth header artık NetClient'e taşınır
      adapterName: config.adapterName || "proxyFetchHTML",
    },
    false,
    targetUrl
  );
}

// -----------------------------------------------------------------------
// PUBLIC: proxyFetchHTML (MASTER ENGINE)
// - Fallback dener.
// - Hiçbiri başarı vermezse: default THROW (S200 honesty)
// - FAE_PROXY_SOFT_FAIL=1 => finalde null döner (eski davranışa yakın)
// -----------------------------------------------------------------------
async function proxyFetchHTML(targetUrl, config = {}) {
  const mode = config.mode || "auto";
  const forceProxy = config.forceProxy === true;
  const forceDirect = config.forceDirect === true;

  // min jitter (ban riskini azaltır)
  await wait(Math.random() * 35);

  let lastErr = null;

  const runAttempt = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      return null;
    }
  };

  // DIRECT ONLY
  if (!forceProxy && (forceDirect || mode === "direct-only")) {
    const d1 = await runAttempt(() => tryFetch(targetUrl, config, false, targetUrl));
    if (d1) return d1;

    const d2 = await runAttempt(() => tryFetch(targetUrl, config, true, targetUrl));
    if (d2) return d2;

    if (SOFT_FAIL) return null;
    throw (
      lastErr ||
      makeProxyErr("PROXY_ALL_FAIL", { url: targetUrl, msg: "direct-only failed" })
    );
  }

  // PROXY ONLY
  if (!forceDirect && mode === "proxy-only") {
    if (PROXY_URL) {
      const r1 = await runAttempt(() => fetchViaProxy(PROXY_URL, targetUrl, config));
      if (r1) return r1;
    }
    for (const p of FALLBACK_PROXIES) {
      await wait(25 + Math.random() * 40);
      const r2 = await runAttempt(() => fetchViaProxy(p.url, targetUrl, config));
      if (r2) return r2;
    }

    if (SOFT_FAIL) return null;
    throw (
      lastErr ||
      makeProxyErr("PROXY_ALL_FAIL", { url: targetUrl, msg: "proxy-only failed" })
    );
  }

  // DIRECT-FIRST
  if (!forceProxy && mode === "direct-first") {
    const d1 = await runAttempt(() => tryFetch(targetUrl, config, false, targetUrl));
    if (d1) return d1;

    const d2 = await runAttempt(() => tryFetch(targetUrl, config, true, targetUrl));
    if (d2) return d2;

    if (PROXY_URL) {
      const p1 = await runAttempt(() => fetchViaProxy(PROXY_URL, targetUrl, config));
      if (p1) return p1;
    }

    for (const p of FALLBACK_PROXIES) {
      await wait(25 + Math.random() * 40);
      const r2 = await runAttempt(() => fetchViaProxy(p.url, targetUrl, config));
      if (r2) return r2;
    }

    if (SOFT_FAIL) return null;
    throw (
      lastErr ||
      makeProxyErr("PROXY_ALL_FAIL", { url: targetUrl, msg: "direct-first failed" })
    );
  }

  // AUTO (Proxy-first)
  if (!forceDirect && PROXY_URL) {
    const p1 = await runAttempt(() => fetchViaProxy(PROXY_URL, targetUrl, config));
    if (p1) return p1;
  }

  if (!forceDirect) {
    for (const p of FALLBACK_PROXIES) {
      await wait(25 + Math.random() * 40);
      const r2 = await runAttempt(() => fetchViaProxy(p.url, targetUrl, config));
      if (r2) return r2;
    }
  }

  if (!forceProxy) {
    const d1 = await runAttempt(() => tryFetch(targetUrl, config, false, targetUrl));
    if (d1) return d1;

    const d2 = await runAttempt(() => tryFetch(targetUrl, config, true, targetUrl));
    if (d2) return d2;
  }

  if (SOFT_FAIL) return null;
  throw lastErr || makeProxyErr("PROXY_ALL_FAIL", { url: targetUrl, msg: "auto failed" });
}

// -----------------------------------------------------------------------
// LEGACY: proxiedGet
// - Eski davranış korunur: hata olursa data:null döner (yutma isteyenler için)
// -----------------------------------------------------------------------
async function proxiedGet(targetUrl, config = {}) {
  try {
    const data = await proxyFetchHTML(targetUrl, {
      ...config,
      mode: config.mode || "auto",
    });
    return { data };
  } catch (e) {
    // legacy: crash yok
    return { data: null, _error: e?.message || String(e) };
  }
}

// -----------------------------------------------------------------------
// NEW: S10 JSON MODE (booking, agoda, expedia vb için)
// - default strict: finalde throw (SOFT_FAIL=1 değilse)
// -----------------------------------------------------------------------
export async function proxyFetchJSON(targetUrl, config = {}) {
  // 1) Direct JSON attempt
  try {
    const direct = await tryFetch(
      targetUrl,
      {
        ...config,
        responseType: "text",
        headers: {
          ...(config.headers || {}),
          Accept: "application/json,text/plain,*/*",
        },
      },
      false,
      targetUrl
    );

    if (direct) {
      try {
        return typeof direct === "string" ? JSON.parse(direct) : direct;
      } catch {}
    }
  } catch (e) {
    // continue to proxy attempt
  }

  // 2) Proxy-first JSON
  try {
    const proxied = await proxyFetchHTML(targetUrl, {
      ...config,
      mode: "auto",
      responseType: "text",
      headers: {
        ...(config.headers || {}),
        Accept: "application/json,text/plain,*/*",
      },
    });

    if (!proxied) {
      if (SOFT_FAIL) return null;
      throw makeProxyErr("PROXY_JSON_FAIL", { url: targetUrl, msg: "no body" });
    }

    try {
      return typeof proxied === "string" ? JSON.parse(proxied) : proxied;
    } catch {
      if (SOFT_FAIL) return null;
      throw makeProxyErr("PROXY_JSON_PARSE_FAIL", {
        url: targetUrl,
        msg: "json parse fail",
      });
    }
  } catch (e) {
    if (SOFT_FAIL) return null;
    throw e;
  }
}

// -----------------------------------------------------------------------
// EXPORTS
// -----------------------------------------------------------------------
export { proxyFetchHTML, proxiedGet };

export default {
  proxyFetchHTML,
  proxiedGet,
  proxyFetchJSON,
};
