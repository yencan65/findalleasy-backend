// server/core/seedHydrator.js  (PATCHED TEMPLATE — S200)
// ============================================================================
// SEED HYDRATOR — S200 DIAG/ROBUST
// Goal: turn "HYDRATE_FAIL" (silent) into actionable signals:
//  - HTTP status / finalUrl / ms / bytes / contentType
//  - block/captcha hints
//  - conservative price extraction via JSON-LD + meta tags (+ tiny heuristics)
// ZERO-DELETE intent: keep export hydrateSeedUrl signature.
// ============================================================================

/* eslint-disable no-useless-catch */

function envNum(name, def, min, max) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return def;
  return Math.min(Math.max(v, min), max);
}

function envStr(name, def = "") {
  const v = process.env[name];
  return (v == null ? def : String(v)).trim();
}

const HYDRATE_TIMEOUT_MS = envNum("SEED_HYDRATE_TIMEOUT_MS", 6500, 800, 30000);
const HYDRATE_MAX_BYTES = envNum("SEED_HYDRATE_MAX_BYTES", 900_000, 50_000, 5_000_000); // ~0.9MB
const UA =
  envStr(
    "SEED_HYDRATE_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  ) || "Mozilla/5.0";

function safeStr(v) {
  return v == null ? "" : String(v);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizePriceNumber(s) {
  // "49.999,00" -> 49999.00 ; "49,999.00" -> 49999.00 ; "49999" -> 49999
  const raw = safeStr(s).trim();
  if (!raw) return null;

  // keep digits and separators
  const t = raw.replace(/[^\d.,]/g, "");
  if (!t) return null;

  // If both '.' and ',' exist, assume '.' is thousand, ',' is decimal for TR style
  if (t.includes(".") && t.includes(",")) {
    const a = t.replace(/\./g, "").replace(",", ".");
    const n = Number(a);
    return Number.isFinite(n) ? n : null;
  }

  // If only ',' exists, treat as decimal
  if (t.includes(",") && !t.includes(".")) {
    const n = Number(t.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  // If only '.' exists, could be decimal OR thousand separators.
  // Heuristic: if last group has exactly 3 digits => thousand sep.
  const parts = t.split(".");
  if (parts.length > 1 && parts[parts.length - 1].length === 3) {
    const n = Number(parts.join(""));
    return Number.isFinite(n) ? n : null;
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function sniffBlocked(html) {
  const h = (html || "").toLowerCase();
  if (!h) return "";
  const clues = [
    ["captcha", "CAPTCHA"],
    ["robot check", "ROBOT_CHECK"],
    ["automated access", "AUTOMATED_ACCESS"],
    ["unusual traffic", "UNUSUAL_TRAFFIC"],
    ["verify you are a human", "HUMAN_VERIFICATION"],
    ["access denied", "ACCESS_DENIED"],
    ["forbidden", "FORBIDDEN"],
    ["service unavailable", "SERVICE_UNAVAILABLE"],
    ["please enable cookies", "COOKIES_REQUIRED"],
    ["blocked", "BLOCKED"],
  ];
  for (const [k, tag] of clues) if (h.includes(k)) return tag;
  return "";
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = (m[1] || "").trim();
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      out.push(j);
    } catch {
      // some sites embed multiple json objects without strict json;
      // skip rather than guessing.
    }
    if (out.length >= 6) break;
  }
  return out;
}

function walkFindOffers(obj) {
  const hits = [];
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    // schema.org Product with offers
    if (cur.offers) hits.push(cur.offers);

    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return hits;
}

function extractPriceFromJsonLd(jsonLdArr) {
  for (const j of jsonLdArr) {
    const candidates = Array.isArray(j) ? j : [j];
    for (const c of candidates) {
      const offersList = walkFindOffers(c);
      for (const offers of offersList) {
        const arr = Array.isArray(offers) ? offers : [offers];
        for (const o of arr) {
          if (!o || typeof o !== "object") continue;

          const price =
            o.price ??
            o.lowPrice ??
            o.highPrice ??
            o?.priceSpecification?.price ??
            o?.priceSpecification?.value;

          const cur = o.priceCurrency ?? o?.priceSpecification?.priceCurrency;

          const n = normalizePriceNumber(price);
          if (n && n > 0) {
            return { price: n, currency: safeStr(cur || "") };
          }
        }
      }
    }
  }
  return null;
}

function extractMeta(html, name) {
  // matches: <meta name="x" content="..."> or property=
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = re.exec(html);
  return m ? safeStr(m[1]).trim() : "";
}

function extractItemprop(html, prop) {
  // <meta itemprop="price" content="...">
  const re = new RegExp(
    `<meta[^>]+itemprop=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = re.exec(html);
  return m ? safeStr(m[1]).trim() : "";
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? safeStr(m[1]).replace(/\s+/g, " ").trim() : "";
  return t.slice(0, 180);
}

function extractOgImage(html) {
  return (
    extractMeta(html, "og:image") ||
    extractMeta(html, "twitter:image") ||
    ""
  ).trim();
}

function extractPriceConservative(html) {
  // 1) JSON-LD
  const jsonLd = extractJsonLd(html);
  const j = extractPriceFromJsonLd(jsonLd);
  if (j) return { ...j, method: "jsonld" };

  // 2) itemprop / meta
  const ip = extractItemprop(html, "price");
  const cur =
    extractItemprop(html, "priceCurrency") ||
    extractMeta(html, "product:price:currency") ||
    extractMeta(html, "og:price:currency");

  const n = normalizePriceNumber(ip);
  if (n && n > 0) return { price: n, currency: safeStr(cur || ""), method: "meta_itemprop" };

  const mp = extractMeta(html, "product:price:amount") || extractMeta(html, "og:price:amount");
  const n2 = normalizePriceNumber(mp);
  if (n2 && n2 > 0) return { price: n2, currency: safeStr(cur || ""), method: "meta_property" };

  return null;
}

async function readBodyLimited(res, limitBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // Node sometimes provides a web stream reader; if not, fallback to text()
    const txt = await res.text();
    return txt.length > limitBytes ? txt.slice(0, limitBytes) : txt;
  }

  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    chunks.push(value);
    if (total >= limitBytes) break;
  }

  // concat Uint8Arrays
  const all = new Uint8Array(Math.min(total, limitBytes));
  let off = 0;
  for (const c of chunks) {
    const len = Math.min(c.length, all.length - off);
    if (len <= 0) break;
    all.set(c.subarray(0, len), off);
    off += len;
  }

  // decode utf-8
  try {
    const dec = new TextDecoder("utf-8", { fatal: false });
    return dec.decode(all);
  } catch {
    // fallback
    return Buffer.from(all).toString("utf8");
  }
}

export async function hydrateSeedUrl(url, opts = {}) {
  const u = safeStr(url).trim();
  const site = hostOf(u);

  const t0 = Date.now();
  const timeoutMs = Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : HYDRATE_TIMEOUT_MS;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("HYDRATE_TIMEOUT")), timeoutMs);

  try {
    const res = await fetch(u, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": UA,
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "upgrade-insecure-requests": "1",
      },
    });

    const status = res.status;
    const finalUrl = res.url || u;
    const contentType = safeStr(res.headers.get("content-type") || "");
    const ms = Date.now() - t0;

    const html = await readBodyLimited(res, HYDRATE_MAX_BYTES);
    const bytes = Buffer.byteLength(html || "", "utf8");

    if (!res.ok) {
      const hint = sniffBlocked(html);
      return {
        ok: false,
        url: finalUrl,
        host: site,
        status,
        code: null,
        error: hint ? `HTTP_${status}:${hint}` : `HTTP_${status}`,
        ms,
        diag: { status, finalUrl, contentType, bytes, hint },
      };
    }

    // Some sites redirect to login/consent even with 200
    const hint = sniffBlocked(html);
    if (hint) {
      return {
        ok: false,
        url: finalUrl,
        host: site,
        status,
        code: null,
        error: hint,
        ms,
        diag: { status, finalUrl, contentType, bytes, hint },
      };
    }

    const priceInfo = extractPriceConservative(html);
    if (!priceInfo) {
      return {
        ok: false,
        url: finalUrl,
        host: site,
        status,
        code: "NO_PRICE",
        error: "NO_PRICE",
        ms,
        diag: { status, finalUrl, contentType, bytes, hint: "" },
      };
    }

    const title = extractTitle(html) || safeStr(opts?.fallbackTitle || "");
    const image = extractOgImage(html);

    return {
      ok: true,
      url: finalUrl,
      host: site,
      title,
      image,
      price: priceInfo.price,
      currency: priceInfo.currency || "TRY",
      ms,
      diag: {
        status,
        finalUrl,
        contentType,
        bytes,
        method: priceInfo.method,
      },
    };
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = safeStr(e?.message || e) || "HYDRATE_ERROR";
    const err = msg.includes("HYDRATE_TIMEOUT") ? "TIMEOUT" : msg;
    return {
      ok: false,
      url: u,
      host: site,
      status: null,
      code: null,
      error: err,
      ms,
      diag: { status: null, finalUrl: u, contentType: "", bytes: 0, hint: "" },
    };
  } finally {
    clearTimeout(t);
  }
}
