// server/utils/httpClient.js
// ============================================================
//  FAE HTTP CLIENT — S1 → S3 (Proxy + Timeout + Retry)
//  - Tek merkezden GET isteği
//  - Proxy desteği (HTTP_PROXY / HTTPS_PROXY)
//  - Timeout + basit retry
//  - ZERO DELETE: Eski adapter mantığı üstüne oturur
// ============================================================

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 3500);
const DEFAULT_RETRIES = Number(process.env.HTTP_MAX_RETRIES || 1);
const DEFAULT_UA =
  process.env.HTTP_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36";

const PROXY_URL =
  process.env.HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.https_proxy ||
  "";

function buildAgent(targetUrl) {
  if (!PROXY_URL) return undefined;
  try {
    return new HttpsProxyAgent(PROXY_URL);
  } catch (err) {
    console.warn("HTTPCLIENT: proxy agent init failed:", err.message);
    return undefined;
  }
}

function buildHeaders(extra = {}) {
  const base = {
    "User-Agent": DEFAULT_UA,
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  };

  // Extra ile birleştir (adapter kendi header'ını override edebilir)
  return {
    ...base,
    ...(extra || {}),
  };
}

/**
 * options:
 *  - headers
 *  - timeoutMs
 *  - retries
 *  - responseType: "text" | "json" | "buffer"
 *  - signal: dışarıdan gelen AbortSignal (varsa kendi timeout’u kurmayız)
 *  - adapterName: log için
 */
export async function httpGet(url, options = {}) {
  const {
    headers,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    responseType = "text",
    signal,
    adapterName = "unknown",
  } = options;

  const finalHeaders = buildHeaders(headers);
  const agent = buildAgent(url);

  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    attempt += 1;
    const started = Date.now();

    // Dışarıdan signal gelmişse onu kullan, yoksa kendi timeout controller'ımızı kur.
    let controller = null;
    let finalSignal = signal || null;
    let timeoutId = null;

    if (!finalSignal) {
      controller = new AbortController();
      finalSignal = controller.signal;

      timeoutId = setTimeout(() => {
        controller.abort(new Error("HTTPCLIENT_TIMEOUT"));
      }, timeoutMs);
    }

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: finalHeaders,
        agent,
        signal: finalSignal,
      });

      if (timeoutId) clearTimeout(timeoutId);

      const duration = Date.now() - started;

      if (!res.ok) {
        const err = new Error(
          `HTTPCLIENT_NON_2XX ${res.status} for ${url} (${adapterName})`
        );
        err.status = res.status;
        err.duration = duration;
        throw err;
      }

      let data;
      if (responseType === "json") {
        data = await res.json();
      } else if (responseType === "buffer") {
        data = await res.buffer();
      } else {
        data = await res.text();
      }

      return {
        ok: true,
        status: res.status,
        duration,
        data,
        headers: res.headers,
        url: res.url || url,
      };
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      lastError = err;

      const isAbort =
        err.name === "AbortError" ||
        err.message === "HTTPCLIENT_TIMEOUT" ||
        err.code === "ECONNABORTED";

      console.warn("HTTPCLIENT:GET_FAIL", {
        url,
        adapterName,
        attempt,
        retries,
        isAbort,
        message: err.message,
      });



      // HTTPCLIENT_NO_RETRY_4XX: 4xx (özellikle 429) tekrar denenmez — kota/log spam yakma
      try {
        const st = Number(lastError?.status || err?.status || 0);
        if (st >= 400 && st < 500 && st !== 408) {
          break;
        }
      } catch {
        // ignore
      }
      // Son denemeyse artık tekrar deneme
      if (attempt > retries) break;
    }
  }

  return {
    ok: false,
    status: lastError?.status || 0,
    error: lastError,
  };
}

/**
 * JSON helper — çoğu adapter bunu kullanacak
 */
export async function httpGetJson(url, options = {}) {
  return httpGet(url, {
    ...options,
    responseType: "json",
  });
}
