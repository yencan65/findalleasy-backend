// server/adapters/avecAdapter.js
// ============================================================================
// AVEC Rent a Car – Şube (Lokasyon) Scraper (S200 friendly)
// - 404 veren belirsiz "search" endpointleri yerine resmi /tr/subeler sayfasını kullanır
// - Çıktı: { ok, items, count }  (title+url zorunlu, price null)
// ============================================================================

import axios from "axios";
import {
  loadCheerioS200,
  coerceItemsS200,
  normalizeItemS200,
  withTimeout,
  safeStr,
  stableIdS200,
} from "../core/s200AdapterKit.js";
// --------------------------- S200 STRICT OUTPUT ---------------------------
const S200_SOURCE = "avec";
const S200_PROVIDER_FAMILY = "car_rental";
const S200_AT = "server/adapters/avecAdapter.js";

function _s200Ok(items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: true, items: arr, count: arr.length, source: S200_SOURCE, _meta: meta || {} };
}

function _s200Fail(err, meta = {}) {
  const msg = safeStr(err?.message || err, 900) || "unknown_error";
  return { ok: false, items: [], count: 0, source: S200_SOURCE, _meta: { ...(meta || {}), error: msg } };
}

function _isTimeoutErr(e) {
  const msg = String(e?.message || "");
  return e?.name === "TimeoutError" || /timed out/i.test(msg) || /timeout/i.test(msg);
}

const BASE = "https://www.avecrentacar.com";
const BRANCHES_URL = `${BASE}/tr/subeler`;

function normTR(s) {
  const x = String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ç/g, "c")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u");
  return x;
}

function tokensTR(s) {
  return normTR(s)
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function absUrl(href) {
  const h = safeStr(href, 2000);
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("/")) return BASE + h;
  return BASE + "/" + h;
}

async function fetchHTML(url, { signal, timeout = 12000 } = {}) {
  try {
    const res = await axios.get(url, {
      signal,
      timeout,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
      validateStatus: (s) => s >= 200 && s < 500,
    });

    if (res.status >= 400) return null;
    return typeof res.data === "string" ? res.data : String(res.data || "");
  } catch {
    return null;
  }
}

function findInfoContainer($, $a) {
  // "Şube Detay" linki çevresinde e-mail/telefon/adres geçen konteyneri bul
  let $node = $a;
  for (let i = 0; i < 8; i++) {
    $node = $node.parent();
    if (!$node || !$node.length) break;

    const t = safeStr($node.text(), 4000);
    const tn = normTR(t);
    const hasMail = tn.includes("@");
    const hasPhone = /\d{2,}/.test(tn);
    const hasAddr = tn.includes("mah") || tn.includes("cad") || tn.includes("no") || tn.includes("havaliman");
    if ((hasMail || hasPhone) && hasAddr) return $node;
  }
  return $a.parent() || $a;
}

function textLines(s) {
  return String(s || "")
    .split(/\r?\n/g)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((x) => normTR(x) !== "sube detay");
}

function extractBranch(lines) {
  let name = safeStr(lines[0] || "AVEC Şube", 140);
  const email = safeStr(lines.find((l) => l.includes("@")) || "", 120);

  let phone = "";
  for (const l of lines) {
    const only = l.replace(/[^\d]/g, "");
    if (only.length >= 10 && only.length <= 13) {
      phone = l;
      break;
    }
  }

  let address = "";
  for (const l of lines) {
    const n = normTR(l);
    if (n.includes("@")) continue;
    if (l === name) continue;
    const digits = l.replace(/[^\d]/g, "");
    if (digits.length < 2) continue;
    if (l.length < 12) continue;
    if (
      n.startsWith("pazartesi") ||
      n.startsWith("sali") ||
      n.startsWith("carsamba") ||
      n.startsWith("persembe") ||
      n.startsWith("cuma") ||
      n.startsWith("cumartesi") ||
      n.startsWith("pazar")
    )
      continue;
    address = l;
    break;
  }

  const hoursLines = lines.filter((l) => {
    const n = normTR(l);
    return (
      n.startsWith("pazartesi") ||
      n.startsWith("sali") ||
      n.startsWith("carsamba") ||
      n.startsWith("persembe") ||
      n.startsWith("cuma") ||
      n.startsWith("cumartesi") ||
      n.startsWith("pazar")
    );
  });

  const hours = safeStr(hoursLines.slice(0, 7).join(" | "), 600);
  return { name, email, phone, address, hours };
}

export async function searchAvecAdapterLegacy(query, opts = {}) {
  const q = safeStr(query, 220);
  if (!q) return _s200Ok([], { emptyQuery: true });

  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: S200_SOURCE, providerKey: S200_SOURCE, at: S200_AT };
  } catch {}

  const startTime = Date.now();
  const timeoutMs = Number(opts?.timeoutMs || 3500);

  try {
    const html = await withTimeout(fetchHTML(BRANCHES_URL, opts), timeoutMs, "avec_fetch");

    if (!html || typeof html !== "string") {
      const duration = Date.now() - startTime;
      return _s200Fail("NO_HTML", { tookMs: duration });
    }

    const $ = loadCheerioS200(html);

    const itemsRaw = [];
    const qTokens = tokensTR(q);

    // AVEC şubeler sayfasındaki linklerden yakalama
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      const text = safeStr($(a).text(), 180);

      if (!href || !text) return;

      // şube linkleri genelde "/tr/subeler/<slug>" gibi
      if (!String(href).includes("/tr/subeler")) return;

      const abs = href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;

      // query filtresi: token intersection
      const tTokens = tokensTR(text);
      if (qTokens.length && !qTokens.some((t) => tTokens.includes(t))) return;

      itemsRaw.push({
        title: text,
        url: abs,
        price: null,
        currency: "TRY",
        category: "car_rental",
        region: "TR",
        raw: { href, text },
      });
    });

    // dedupe by url
    const seenUrl = new Set();
    const coerced = coerceItemsS200(itemsRaw);
    const normalized = [];

    for (const it of coerced) {
      if (!it?.url) continue;
      const key = String(it.url);
      if (seenUrl.has(key)) continue;
      seenUrl.add(key);

      const n = normalizeItemS200(it, S200_SOURCE, {
        providerFamily: S200_PROVIDER_FAMILY,
        vertical: "car_rental",
        category: "car_rental",
        region: "TR",
        requireRealUrlCandidate: true,
      });

      if (n) normalized.push(n);
    }

    const duration = Date.now() - startTime;
    return _s200Ok(normalized, { tookMs: duration, rawCount: coerced.length });
  } catch (err) {
    const duration = Date.now() - startTime;
    return _s200Fail(err, { tookMs: duration, timeout: _isTimeoutErr(err) });
  }
}


// Back-compat aliases
export const searchAvec = searchAvecAdapter;
export const search = searchAvecAdapter;
export default searchAvecAdapter;

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchAvecAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "avec";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "avecAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchAvecAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "avec",
        _meta: {
          startedAt: started,
          durationMs: Date.now() - started,
          timeoutMs,
          error: errMsg,
          legacyOk: false,
        },
      };
    }

    const itemsIn = coerceItemsS200(raw);
    const out = [];
    let bad = 0;

    for (const it of itemsIn) {
      if (!it || typeof it !== "object") continue;

      const x = { ...it };

      // NO RANDOM ID — wipe any legacy/random ids and rebuild deterministically.
      x.id = null;
      x.listingId = null;
      x.listing_id = null;
      x.itemId = null;

      // Discovery sources: price forced null, affiliate injection OFF.
      if (false) {
        x.price = null;
        x.finalPrice = null;
        x.optimizedPrice = null;
        x.originalPrice = null;
        x.affiliateUrl = null;
        x.deeplink = null;
        x.deepLink = null;
        x.finalUrl = null;
      }

      const ni = normalizeItemS200(x, providerKey, {
        category: "car_rental",
        vertical: "car_rental",
        query: String(query || ""),
        region: String(options?.region || "TR").toUpperCase(),
      });

      if (!ni) {
        bad++;
        continue;
      }

      // Hard enforce stable id.
      ni.id = stableIdS200(providerKey, ni.url, ni.title);

      out.push(ni);
    }

    return {
      ok: true,
      items: out,
      count: out.length,
      source: "avec",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        bad,
        legacyOk: true,
      },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e, 900) || "unknown_error";
    const isTimeout = e?.name === "TimeoutError" || /timed out|timeout/i.test(String(e?.message || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      source: "avec",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        timeout: isTimeout,
        error: msg,
      },
    };
  }
}
