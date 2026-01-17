// server/core/NetClient.js
// ============================================================================
// NET CLIENT — S200 HONEST TRANSPORT (HTML/TEXT)
// - Tek iş: metin (HTML/JSON text) getir, retry yap, block/403/404/429'ı YUTMA.
// - ESM uyumlu. Circular import yok.
// ============================================================================

import axios from "axios";

const DEBUG = process.env.FAE_NETCLIENT_DEBUG === "1";
const DEFAULT_TIMEOUT = Number(process.env.FAE_NETCLIENT_TIMEOUT || 12000);
const DEFAULT_RETRIES = Number(process.env.FAE_NETCLIENT_RETRIES || 2);
const DEFAULT_MAX_REDIRECTS = Number(process.env.FAE_NETCLIENT_MAX_REDIRECTS || 3);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

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

function buildHeaders(url, extra = {}) {
  const { origin, referer } = safeOriginAndReferer(url);
  return {
    "User-Agent": pickUA(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: referer,
    Origin: origin,
    DNT: "1",
    ...extra,
  };
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(1500, 150 * 2 ** attempt) + Math.floor(Math.random() * 120);

function errShape({ url, status, code, message, attempt }) {
  return { url, status, code, message, attempt };
}

export async function requestText(url, opts = {}) {
  const adapterName = String(opts.adapterName || "netclient");
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT);
  const retries = Number.isFinite(opts.retries) ? Number(opts.retries) : DEFAULT_RETRIES;
  const maxRedirects =
    Number.isFinite(opts.maxRedirects) ? Number(opts.maxRedirects) : DEFAULT_MAX_REDIRECTS;

  const method = String(opts.method || "GET").toUpperCase();
  const data = opts.data;

  let last = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = buildHeaders(url, opts.headers || {});

      const res = await axios({
        url,
        method,
        data,
        timeout: timeoutMs,
        maxRedirects,
        responseType: "text",
        headers,
        signal: opts.signal,
        validateStatus: () => true,
      });

      const status = res?.status ?? 0;
      const text = typeof res?.data === "string" ? res.data : String(res?.data ?? "");

      if (!text) {
        last = errShape({ url, status, code: "EMPTY_BODY", message: "empty body", attempt });
        throw new Error(last.message);
      }

      // Kural: 403/404/429/5xx = FAIL (yutma yok)
      if (status === 403 || status === 404 || status === 429 || status >= 500) {
        last = errShape({ url, status, code: "HTTP_NON_2XX", message: `HTTP ${status}`, attempt });
        throw new Error(last.message);
      }

      // 200 dönüp captcha/block HTML gelmesi
      if (looksLikeBlockPage(text)) {
        last = errShape({
          url,
          status: 200,
          code: "BLOCK_HTML",
          message: "block/captcha html detected",
          attempt,
        });
        throw new Error(last.message);
      }

      if (DEBUG) console.warn("[NETCLIENT]", { adapterName, ok: true, status, attempt, url });
      return { ok: true, text, status, adapterName };
    } catch (e) {
      const code = e?.code || last?.code || "NET_FAIL";
      const msg = last?.message || e?.message || "request failed";
      const status = last?.status;

      last = errShape({ url, status, code, message: msg, attempt });

      if (DEBUG) console.warn("[NETCLIENT]", { adapterName, ok: false, ...last });

      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }

      return { ok: false, text: null, status, error: last, adapterName };
    }
  }

  return { ok: false, text: null, status: last?.status, error: last, adapterName: "netclient" };
}

export async function getHtml(url, opts = {}) {
  const r = await requestText(url, { ...opts, method: "GET" });
  if (r.ok) return { ...r, html: r.text };

  // Optional: Jina AI proxy fallback (helps with Cloudflare/JS-heavy pages)
  // Enable via:
  //   - opts.allowJinaProxy=true (per-call)
  //   - or env FAE_ENABLE_JINA_PROXY=1 (global)
  const allowJina = opts?.allowJinaProxy === true || String(process.env.FAE_ENABLE_JINA_PROXY || "").trim() === "1";
  if (!allowJina) return { ...r, html: null };

  try {
    const s = String(url || "").trim();
    if (!s) return { ...r, html: null };

    // r.jina.ai expects: https://r.jina.ai/http(s)://...
    const proxyUrl = s.startsWith("https://")
      ? `https://r.jina.ai/https://${s.slice("https://".length)}`
      : s.startsWith("http://")
        ? `https://r.jina.ai/http://${s.slice("http://".length)}`
        : `https://r.jina.ai/${s}`;

    const r2 = await requestText(proxyUrl, {
      ...opts,
      method: "GET",
      // proxy tarafinda daha kisa timeout iyi (donmezse burada yakma)
      timeoutMs: Number(opts.timeoutMs || DEFAULT_TIMEOUT),
      retries: 0,
      headers: {
        ...(opts.headers || {}),
        // Jina text proxy HTML degil plain text de donebilir; her turlu aliyoruz.
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
      },
      adapterName: `${String(opts.adapterName || "netclient")}:jina`,
    });

    if (r2.ok) return { ...r2, html: r2.text, meta: { via: "jina" } };
  } catch {
    // ignore
  }

  return { ...r, html: null };
}

export default { requestText, getHtml };
