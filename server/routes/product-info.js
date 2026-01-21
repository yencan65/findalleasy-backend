// server/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S22.11 LOCKDOWN (OFFER TRUST SPLIT + UNKNOWN OUTSIDE VITRINE) (MERCHANT-HUNT + CATALOG-VERIFY + GP OFFERS)
//  ZERO DELETE — Eski davranış korunur, sadece daha sağlam/akıllı hale gelir
//
//  Amaç:
//   - POST body (qr/code/data/text) + rawBody kurtarma (PowerShell/curl kaçışları)
//   - Barcode (8-18) için:
//        1) OpenFoodFacts (food)
//        2) Katalog siteleri (epey/cimri/akakce vb.) üzerinden GTIN doğrulama (HTML kanıt)
//        3) SerpAPI Google Shopping -> ürün kimliği + SerpAPI immersive -> merchant offer linkleri
//        4) Immersive boşsa SerpAPI google_product fallback (offers + GTIN kanıt)
//     ✅ verifiedBarcode: sadece "Google sayfası" değil, GTIN/spec güçlü kanıt ile true olur
//   - force=1 => mongo-cache bypass
//   - diag=1  => _diag adım adım debug
// ======================================================================

import express from "express";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import Product from "../models/Product.js";
import { searchWithSerpApi } from "../adapters/serpApi.js";
import { searchLocalBarcodeEngine } from "../core/localBarcodeEngine.js";
import { runVitrineS40 } from "../core/adapterEngine.js";

import { getHtml } from "../core/NetClient.js";

const router = express.Router();

// ============================================================================
// Free-only cache guard
// If allowPaid=0 and the cached doc clearly came from a paid provider (e.g., serpapi),
// we skip that cache hit (and optionally purge it) so "free-only" mode stays honest.
// ============================================================================
function isPaidProviderDoc(doc) {
  try {
    if (!doc || typeof doc !== "object") return false;
    const src = String(doc.source || "").toLowerCase();
    const raw = doc.raw || {};
    const pf = String(raw.providerFamily || raw.providerKey || raw.provider || "").toLowerCase();
    const rid = String(raw.id || "").toLowerCase();
    // Extend here if you add other paid providers later
    if (src.includes("serpapi")) return true;
    if (pf.includes("serpapi")) return true;
    if (rid.includes("serpapi")) return true;
    return false;
  } catch {
    return false;
  }
}

function sanitizePaidCacheProduct(p) {
  try {
    if (!p || typeof p !== "object") return p;
    const out = { ...p };
    // Remove paid-provider fingerprints from the payload in free-only mode.
    if (out.raw) delete out.raw;
    const src = String(out.source || "").toLowerCase();
    if (src.includes("serpapi")) out.source = "cache";
    return out;
  } catch {
    return p;
  }
}


// ============================================================================
// Mongo write helper — upsert (fixes duplicate qrCode create failures)
// Also stores full offers universe in Mongo (offers / offersAll) so cache can be re-split safely.
// ============================================================================
async function upsertProductDoc(product, diag, step = "mongo_upsert") {
  try {
    if (!product || typeof product !== "object") return;

    const qrCode = safeStr(product.qrCode || product.qr || "");
    if (!qrCode) return;

    const toSave = { ...product, qrCode };

    // Persist full offer universe (trusted + other) into `offers` for schema-compat,
    // and optionally into `offersAll` if schema allows it.
    const all = [];
    if (Array.isArray(product.offersAll)) {
      all.push(...product.offersAll);
    } else {
      if (Array.isArray(product.offersTrusted)) all.push(...product.offersTrusted);
      if (Array.isArray(product.offersOther)) all.push(...product.offersOther);
    }

    if (all.length) {
      toSave.offers = all;          // schema-safe primary storage
      toSave.offersAll = all;       // optional (if schema allows)
    }


// Don't pollute cache with unresolved placeholders that will block future enrichment.
// Example: title/name equals barcode and no offer signals.
try {
  const t = String(toSave.title || toSave.name || "").trim();
  const src = String(toSave.source || "").toLowerCase();
  const prov = String(toSave.provider || "").toLowerCase();
  const hasOffers = Array.isArray(toSave.offers) && toSave.offers.length;
  const hasBest = !!toSave.bestOffer;
  const looksUnresolved = t === qrCode && !hasOffers && !hasBest;

  if (looksUnresolved && (src === "barcode-unresolved" || src === "text" || src === "ocr" || prov === "text" || prov === "ocr")) {
    if (diag && Array.isArray(diag.tries)) diag.tries.push({ step: `${step}_skip_unresolved` });
    return;
  }
} catch {}
    await Product.updateOne({ qrCode }, { $set: toSave }, { upsert: true });

    if (diag && Array.isArray(diag.tries)) diag.tries.push({ step });
  } catch (e) {
    if (diag && Array.isArray(diag.tries)) {
      diag.tries.push({
        step: `${step}_error`,
        error: String(e?.message || e),
      });
    }
  }
}


// ======================================================================
// RATE LIMIT + micro-burst
// ======================================================================
const limiter = rateLimit({ windowMs: 5000, max: 40 });
router.use(limiter);

const burstMap = new Map();
function burst(ip, qr, ttl = 1500) {
  const key = ip + "::" + qr;
  const now = Date.now();
  const last = burstMap.get(key);
  if (last && now - last < ttl) return false;
  burstMap.set(key, now);
  // mini-prune (best effort)
  if (burstMap.size > 5000) {
    for (const [k, ts] of burstMap.entries()) {
      if (now - ts > 30_000) burstMap.delete(k);
    }
  }
  return true;
}

// ======================================================================
// Sanitization
// ======================================================================
function sanitizeQR(v) {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/[\0<>]/g, "");
  if (/^(javascript|data|vbscript|file):/i.test(s)) return "";
  return s.length > 500 ? s.slice(0, 500) : s;
}

function safeStr(v, max = 250) {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/[\0<>]/g, "");
  return s.slice(0, max);
}

function parseBoolish(v, def = false) {
  try {
    if (v == null) return def;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (!s) return def;
    return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
  } catch {
    return def;
  }
}

// ======================================================================
// Cache quality gate (avoid weak/unresolved docs blocking signals)
// ======================================================================
function isWeakCacheDoc(doc, qr) {
  try {
    const code = sanitizeQR(qr);
    const source = String(doc?.source || "").toLowerCase();
    const provider = String(doc?.provider || "").toLowerCase();

    const title = String(doc?.title || doc?.name || "").trim();
    const merchantUrl = String(doc?.merchantUrl || "").trim();

    const offers = Array.isArray(doc?.offers) ? doc.offers.length : 0;
    const offersAll = Array.isArray(doc?.offersAll) ? doc.offersAll.length : 0;
    const offersTrusted = Array.isArray(doc?.offersTrusted) ? doc.offersTrusted.length : 0;
    const hasAnyOffer = !!(offers || offersAll || offersTrusted || doc?.bestOffer);

    const isJustCode = !!code && title === code;
    const weakSource = source === "barcode-unresolved" || source === "text" || source === "ocr";
    const weakProvider = provider === "text" || provider === "ocr";

    // If there is no offer signal and it looks like an unresolved placeholder, treat as weak.
    if (!hasAnyOffer && !merchantUrl && isJustCode) return true;

    // Text/OCR placeholder docs are weak unless they actually contain offers.
    if ((weakSource || weakProvider) && !hasAnyOffer) return true;

    // Confidence low + no offers is also weak.
    const conf = String(doc?.confidence || "").toLowerCase();
    if (conf === "low" && !hasAnyOffer) return true;

    return false;
  } catch {
    return false;
  }
}


function safeJson(res, body, code = 200) {
  try {
    res.status(code).json(body);
  } catch (err) {
    console.error("❌ safeJson ERROR:", err);
    try {
      res.status(500).json({ ok: false, error: "JSON_FAIL" });
    } catch {}
  }
}

function getClientIp(req) {
  return (
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

// ======================================================================
// Body picker (robust) — req.body boşsa req.__rawBody'ye düş
//  - ayrıca PowerShell curl kaçışlarında gelen {\"qr\":\"...\"} gibi body'leri kurtarır
// ======================================================================
function _parseMaybeJson(raw) {
  if (!raw) return {};
  let s = String(raw).trim();
  if (!s) return {};

  // BOM temizle
  s = s.replace(/^\uFEFF/, "").trim();

  // bazen body "'{...}'" veya "\"{...}\"" gibi sarılı gelir
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    const inner = s.slice(1, -1).trim();
    if (inner.startsWith("{") && inner.endsWith("}")) s = inner;
  }

  // 1) normal parse
  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" ? j : {};
  } catch {}

  // 2) PowerShell/curl kaçışı: {\"qr\":\"...\"}
  if (s.includes('\\"')) {
    const s2 = s.replace(/\\"/g, '"');
    try {
      const j2 = JSON.parse(s2);
      return j2 && typeof j2 === "object" ? j2 : {};
    } catch {}
  }

  return {};
}

function pickBody(req) {
  const b = req?.body;

  // normal object body
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) {
    if (Object.keys(b).length) return b;
  }

  // buffer/string body
  if (Buffer.isBuffer(b)) return _parseMaybeJson(b.toString("utf8"));
  if (typeof b === "string") return _parseMaybeJson(b);

  // rawBody fallback (server.js verify yakalamış olmalı)
  const rb = req?.__rawBody;
  if (Buffer.isBuffer(rb)) return _parseMaybeJson(rb.toString("utf8"));
  if (typeof rb === "string") return _parseMaybeJson(rb);

  return {};
}

// ======================================================================
// Locale
// ======================================================================
function pickLocale(req, body) {
  try {
    const raw = String(body?.locale || req?.query?.locale || "").trim().toLowerCase();
    if (!raw) return "tr";
    return raw.split("-")[0] || "tr";
  } catch {
    return "tr";
  }
}

function localePack(localeShort) {
  const l = String(localeShort || "tr").toLowerCase();
  if (l === "tr") return { hl: "tr", gl: "tr", region: "TR" };
  if (l === "fr") return { hl: "fr", gl: "fr", region: "TR" };
  if (l === "ru") return { hl: "ru", gl: "ru", region: "TR" };
  if (l === "ar") return { hl: "ar", gl: "sa", region: "TR" };
  return { hl: "en", gl: "us", region: "TR" };
}

function providerProductWord(localeShort) {
  const l = String(localeShort || "tr").toLowerCase();
  if (l === "en") return "product";
  if (l === "fr") return "produit";
  if (l === "ru") return "товар";
  if (l === "ar") return "منتج";
  return "ürünü";
}

// ======================================================================
// Unresolved barcode UX helpers (NO-JUNK policy)
//  - If barcode cannot be resolved to a product identity (name/title),
//    we explicitly ask the client to upload a front photo.
//  - This prevents the UI from doing a generic search for the raw barcode
//    which often produces irrelevant "çer-çöp" results.
// ======================================================================
function needsImageMsg(localeShort) {
  const l = String(localeShort || "tr").toLowerCase();
  if (l === "en") return "No data found for this barcode. Please upload a clear front photo of the product.";
  if (l === "fr") return "Aucune donnée trouvée pour ce code-barres. Veuillez téléverser une photo nette de la face avant du produit.";
  if (l === "ru") return "По этому штрихкоду данных не найдено. Пожалуйста, загрузите четкое фото лицевой стороны товара.";
  if (l === "ar") return "لم يتم العثور على بيانات لهذا الرمز الشريطي. يرجى رفع صورة واضحة لواجهة المنتج.";
  return "Bu barkod için veri bulunamadı. Lütfen ürünün ön yüz fotoğrafını net şekilde yükleyin.";
}

function makeUnresolvedResponseProduct(qr, suggestedQuery = "") {
  const sq = String(suggestedQuery || "").trim();
  // UI'da sadece barkod numarası yerine (varsa) anlamlı başlık göster.
  // Barkod yine qrCode alanında saklanır.
  const display = sq && !/^\d{8,18}$/.test(sq) ? sq.slice(0, 180) : String(qr || "");
  return {
    name: display,
    title: display,
    qrCode: qr,
    provider: "barcode",
    source: "barcode-unresolved",
    verifiedBarcode: false,
    verifiedBy: "",
    offersTrusted: [],
    offersOther: [],
    offers: [],
    bestOffer: null,
    merchantUrl: "",
    confidence: "low",
    suggestedQuery: sq || "",
  };
}

// ======================================================================
// Provider detector + URL title
// ======================================================================
function detectProviderFromUrl(url) {
  const s = String(url).toLowerCase();
  if (s.includes("trendyol")) return "trendyol";
  if (s.includes("hepsiburada")) return "hepsiburada";
  if (s.includes("amazon.")) return "amazon";
  if (s.includes("n11.com")) return "n11";
  if (s.includes("ciceksepeti")) return "ciceksepeti";
  if (s.includes("aliexpress")) return "aliexpress";
  return "unknown";
}

function extractTitleFromUrl(url) {
  try {
    const cleanUrl = url.split("?")[0].split("&")[0];
    const parts = cleanUrl.split("/");
    for (const p of parts) {
      if (p.includes("-")) {
        const t = decodeURIComponent(p)
          .replace(/-/g, " ")
          .replace(/[^\w\sğüşöçıİĞÜŞÖÇ]/gi, "")
          .trim();
        if (t.length > 2) return t;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ======================================================================
// In-memory cache (barcode)
// ======================================================================
const barcodeCache = new Map(); // key -> {ts, product}
const BARCODE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// Negative cache (barcode unresolved) — avoids repeated paid fallbacks on the same code
const unresolvedCache = new Map(); // key -> ts
const UNRESOLVED_TTL_MS = Number(process.env.BARCODE_UNRESOLVED_TTL_MS || 10 * 60 * 1000);

function unresolvedHit(key) {
  try {
    const ts = unresolvedCache.get(key);
    if (!ts) return false;
    if (Date.now() - ts > UNRESOLVED_TTL_MS) {
      unresolvedCache.delete(key);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function markUnresolved(key) {
  try {
    unresolvedCache.set(key, Date.now());
  } catch {}
}


function cacheGetBarcode(key) {
  const hit = barcodeCache.get(key);
  if (!hit) return null;
  const age = Date.now() - (hit.ts || 0);
  if (age > BARCODE_CACHE_MS) return null;
  return hit.product || null;
}

function cacheSetBarcode(key, product) {
  try {
    barcodeCache.set(key, { ts: Date.now(), product });
  } catch {}
}

function cleanTitle(t) {
  const s = safeStr(t, 240);
  if (!s) return "";
  return s.replace(/\s+[\|\-–]\s+.+$/, "").trim();
}

function isGoogleHostedUrl(url) {
  const s = String(url || "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("://www.google.") ||
    s.includes("://google.") ||
    s.includes("://shopping.google.") ||
    s.includes("://www.google.com") ||
    s.includes("gstatic.") ||
    s.includes("googleusercontent.") ||
    s.includes("ggpht.com")
  );
}

function pickDomain(url) {
  try {
    const u = new URL(String(url || ""));
    return (u.hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

// ======================================================================
// Google redirect unwrap (aclk/url) => gerçek merchant url
// ======================================================================
function unwrapGoogleRedirect(u) {
  try {
    const url = new URL(String(u || ""));
    const host = (url.hostname || "").toLowerCase();
    if (!host.includes("google.")) return "";

    const p = (url.pathname || "").toLowerCase();
    if (!(p.includes("/aclk") || p.includes("/url") || p.includes("/shopping") || p.includes("/pagead"))) {
      return "";
    }

    const keys = ["adurl", "url", "q", "u"];
    for (const k of keys) {
      const v = url.searchParams.get(k);
      if (!v) continue;
      let decoded = "";
      try {
        decoded = decodeURIComponent(v);
      } catch {
        decoded = v;
      }
      if (/^https?:\/\//i.test(decoded) && !isGoogleHostedUrl(decoded)) return decoded;
    }
    return "";
  } catch {
    return "";
  }
}

function normalizeOutboundUrl(u) {
  const s = safeStr(u, 2000);
  if (!s) return "";
  const unwrapped = unwrapGoogleRedirect(s);
  return unwrapped || s;
}

// ======================================================================
// Barcode evidence helpers (anti-wrong-product)
//  - Amaç: "alakasız ürün" döndürmemek. Emin değilsek NULL.
// ======================================================================
function hasBarcodeEvidenceInText(text, code) {
  try {
    if (!text || !code) return false;
    const t = String(text);
    if (t.includes(code)) return true;

    const re = new RegExp(
      String.raw`(?:gtin(?:13|14)?|ean(?:13)?|barcode|barkod|upc|product\s*id|product_id)\s*["'\s:=\-]{0,20}` +
        code,
      "i"
    );
    return re.test(t);
  } catch {
    return false;
  }
}

async function probeUrlForBarcode(url, code, diag) {
  const u0 = safeStr(url, 2000);
  if (!u0 || !/^https?:\/\//i.test(u0)) return false;

  const u = normalizeOutboundUrl(u0);
  if (!u || !/^https?:\/\//i.test(u)) return false;

  // Google hosted sayfalarda "evidence" üretmek çoğu zaman sahte güven.
  if (isGoogleHostedUrl(u)) return false;

  try {
    diag?.tries?.push?.({ step: "probe_url", url: safeStr(u, 500) });
    const r = await getHtml(u, { timeoutMs: 9000, maxBytes: 1_500_000, allow3xx: true });
    if (!r?.ok || !r?.html) {
      diag?.tries?.push?.({ step: "probe_url_fail", url: safeStr(u, 500), status: r?.status || null });
      return false;
    }
    const ok = hasBarcodeEvidenceInText(r.html, code);
    diag?.tries?.push?.({ step: ok ? "probe_url_ok" : "probe_url_no_evidence", url: safeStr(u, 500) });
    return ok;
  } catch (e) {
    diag?.tries?.push?.({ step: "probe_url_error", url: safeStr(u, 500), error: String(e?.message || e) });
    return false;
  }
}

// ======================================================================
// Timeout helper
// ======================================================================
function withTimeout(promise, timeoutMs, label = "timeout") {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(label), Math.max(100, timeoutMs || 10_000));
  return {
    signal: ctrl.signal,
    run: (async () => {
      try {
        return await promise(ctrl.signal);
      } finally {
        clearTimeout(id);
      }
    })(),
  };
}

function appendQuery(u, params) {
  try {
    const url = new URL(String(u));
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === "") continue;
      if (!url.searchParams.has(k)) url.searchParams.set(k, String(v));
    }
    return url.toString();
  } catch {
    return String(u || "");
  }
}

function parsePriceAny(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s0 = String(v);
  if (!s0) return null;

  let s = s0.replace(/[^\d.,]/g, "");
  if (!s) return null;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    s = s.replace(/\./g, "").replace(/,/g, ".");
  } else if (hasComma && !hasDot) {
    s = s.replace(/,/g, ".");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeMerchant(m) {
  // Noktalama/emoji vb. -> boşluk: name matching daha sağlam olur
  return safeStr(m, 120)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ======================================================================
// Offer safety: blacklist/whitelist + trust (rank) based on known providers
//  - Amaç: "ucuz ama çöp" linklerin en üste zıplamasını engellemek
//  - NOT: whitelist "hard block" değil; unknown yine görünür ama rank düşük kalır.
//         STRICT_OFFER_ALLOWLIST=true yaparsan unknown offer'ları tamamen düşürür.
// ======================================================================
const STRICT_OFFER_ALLOWLIST = false;

// Tamamen drop edeceğimiz domainler (redirect / tracking / sosyal vb.)
const OFFER_DOMAIN_BLACKLIST = new Set([
  "google.com",
  "www.google.com",
  "shopping.google.com",
  "googleusercontent.com",
  "gstatic.com",
  "ggpht.com",
  "doubleclick.net",
  "googleadservices.com",
  "t.co",
  "bit.ly",
  "linktr.ee",
  "l.facebook.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "pinterest.com",
  "youtube.com",
  "youtu.be",
]);

// Türkiye ağırlıklı "bilinen" satıcılar / pazaryerleri (rank = trustScore)
const PROVIDER_TRUST = [
  { domain: "hepsiburada.com", score: 100, names: ["hepsiburada"] },
  { domain: "trendyol.com", score: 95, names: ["trendyol"] },
  { domain: "n11.com", score: 85, names: ["n11"] },
  { domain: "amazon.com.tr", score: 82, names: ["amazon", "amazon.com.tr", "amazon tr"] },
  { domain: "pazarama.com", score: 75, names: ["pazarama"] },
  { domain: "ciceksepeti.com", score: 68, names: ["ciceksepeti", "çiçeksepeti"] },
  { domain: "teknosa.com", score: 70, names: ["teknosa"] },
  { domain: "vatanbilgisayar.com", score: 70, names: ["vatan", "vatan bilgisayar"] },
  { domain: "mediamarkt.com.tr", score: 70, names: ["media markt", "mediamarkt"] },
  { domain: "migros.com.tr", score: 65, names: ["migros"] },
  { domain: "carrefoursa.com", score: 60, names: ["carrefoursa", "carrefour"] },
];

const OFFER_DOMAIN_ALLOWLIST = new Set(PROVIDER_TRUST.map((x) => x.domain));

function canonicalHost(host) {
  let h = String(host || "").toLowerCase().trim();
  if (!h) return "";
  // strip common prefixes
  h = h.replace(/^https?:\/\//, "");
  h = h.split("/")[0];
  h = h.replace(/^www\./, "").replace(/^m\./, "");
  return h;
}

function domainMatches(host, baseDomain) {
  const h = canonicalHost(host);
  const b = canonicalHost(baseDomain);
  if (!h || !b) return false;
  return h === b || h.endsWith("." + b);
}

function isBlacklistedDomain(domainOrHost) {
  const h = canonicalHost(domainOrHost);
  if (!h) return false;
  for (const b of OFFER_DOMAIN_BLACKLIST) {
    if (domainMatches(h, b)) return true;
  }
  return false;
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findProviderByDomain(domain) {
  const d = canonicalHost(domain);
  if (!d) return null;
  for (const p of PROVIDER_TRUST) {
    if (domainMatches(d, p.domain)) return p;
  }
  return null;
}

// Back-compat: signature korunur ama merchantName artık trust için kullanılmaz (spoof kapandı)
function findProvider(domain, _merchantName = "") {
  return findProviderByDomain(domain);
}

// Yeni merchantRank imzası: (domain, merchantName)
function merchantRank(domain) {
  const d = canonicalHost(domain);
  if (isBlacklistedDomain(d)) return 0;
  const p = findProviderByDomain(d);
  return p ? p.score : 10;
}

// ======================================================================
// pickBestOffer — trusted-first + price-min, yoksa rank fallback
// ======================================================================
function pickBestOffer(offers) {
  const arr = Array.isArray(offers) ? offers : [];
  if (!arr.length) return null;

  // 1) Önce güvenilirleri dene (rank >= 60) + blacklist/google hariç
  const trusted = arr.filter((o) => {
    const url = o?.url || "";
    const domain = o?.domain || pickDomain(url);
    if (!url || isGoogleHostedUrl(url)) return false;
    if (isBlacklistedDomain(domain)) return false;
    return (o.rank || 0) >= 60;
  });

  const pool = trusted.length ? trusted : arr.filter((o) => {
    const url = o?.url || "";
    const domain = o?.domain || pickDomain(url);
    if (!url || isGoogleHostedUrl(url)) return false;
    if (isBlacklistedDomain(domain)) return false;
    return true;
  });

  if (!pool.length) return null;

  // 2) Pool içinde en ucuzu bul
  let best = null;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (const o of pool) {
    const p = o && o.price != null ? Number(o.price) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(p) && p < bestPrice) {
      bestPrice = p;
      best = o;
    }
  }

  // 3) Fiyat yoksa rank'e göre seç
  if (!best) {
    return pool.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0))[0] || null;
  }

  // 4) “Aşırı ucuz ama güvensiz” senaryosu: trusted varsa zaten engellendi.
  return best;
}

// ======================================================================
// Offer split: trusted vs other (unknown domains) — vitrine safety gate
//  - offersTrusted: ana vitrine girer (bilinen provider listesi + min trust)
//  - offersOther: sadece "daha fazla göster" altında (debug'da görünür)
// ======================================================================
const OFFER_TRUST_MIN_RANK = (() => {
  const n = Number(process.env.OFFER_TRUST_MIN_RANK ?? 60);
  return Number.isFinite(n) ? n : 60;
})();

const OFFERS_TRUSTED_LIMIT = (() => {
  const n = Number(process.env.OFFERS_TRUSTED_LIMIT ?? 12);
  return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 12;
})();

const OFFERS_OTHER_LIMIT = (() => {
  const n = Number(process.env.OFFERS_OTHER_LIMIT ?? 12);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 12;
})();

function offerPriceNum(o) {
  const p = o?.price;
  const n = p == null ? Number.POSITIVE_INFINITY : Number(p);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function offerKey(o) {
  const u = safeStr(o?.url || "", 2000);
  if (u) return u;
  const d = canonicalHost(o?.domain || "");
  const m = normalizeMerchant(o?.merchant || "");
  return d || m ? `${d}::${m}` : "";
}

function dedupeOffers(arr) {
  const out = [];
  const seen = new Set();
  for (const o of Array.isArray(arr) ? arr : []) {
    const k = offerKey(o);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

function offerIsTrusted(o) {
  const url = o?.url || "";
  if (!url || isGoogleHostedUrl(url)) return false;

  const domain = canonicalHost(o?.domain || pickDomain(url));
  if (!domain || isBlacklistedDomain(domain)) return false;

  const p = findProviderByDomain(domain);
  if (!p) return false;

  return (p.score || 0) >= OFFER_TRUST_MIN_RANK;
}

function sortOffersTrusted(arr) {
  arr.sort((a, b) => {
    const ap = offerPriceNum(a);
    const bp = offerPriceNum(b);
    if (ap !== bp) return ap - bp;

    const ar = a?.rank || 0;
    const br = b?.rank || 0;
    if (ar !== br) return br - ar;

    return String(a?.merchantKey || "").localeCompare(String(b?.merchantKey || ""));
  });
}

function sortOffersOther(arr) {
  arr.sort((a, b) => {
    const ar = a?.rank || 0;
    const br = b?.rank || 0;
    if (ar !== br) return br - ar;

    const ap = offerPriceNum(a);
    const bp = offerPriceNum(b);
    if (ap !== bp) return ap - bp;

    return String(a?.merchantKey || "").localeCompare(String(b?.merchantKey || ""));
  });
}

function mergeOffersUnique(a, b) {
  const out = [];
  const seen = new Set();
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const k = offerKey(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function splitOffersForVitrine(offers) {
  const arr = dedupeOffers(Array.isArray(offers) ? offers : []);
  if (!arr.length) return { offersTrusted: [], offersOther: [] };

  const offersTrusted = [];
  const offersOther = [];

  for (const o of arr) {
    if (offerIsTrusted(o)) offersTrusted.push(o);
    else offersOther.push(o);
  }

  sortOffersTrusted(offersTrusted);
  sortOffersOther(offersOther);

  return {
    offersTrusted: offersTrusted.slice(0, OFFERS_TRUSTED_LIMIT),
    offersOther: offersOther.slice(0, OFFERS_OTHER_LIMIT),
  };
}
// Normalize cached product objects before sending to the UI.
// Goal: keep "vitrine" clean (trusted-only), even if Mongo has legacy records.
function normalizeProductForVitrine(p) {
  if (!p || typeof p !== "object") return p;

  // Only enforce strict vitrine rules for barcode products.
  const provider = String(p.provider || "");
  const qrCode = String(p.qrCode || "");
  const isBarcode = provider === "barcode" || /^\d{8,18}$/.test(qrCode);

  // If this isn't a barcode flow, don't break expected deep-link behavior (e.g. direct URL scans).
  if (!isBarcode) {
    return {
      ...p,
      offersTrusted: Array.isArray(p.offersTrusted) ? p.offersTrusted : [],
      offersOther: Array.isArray(p.offersOther) ? p.offersOther : [],
      offers: Array.isArray(p.offers) ? p.offers : [],
      merchantUrl: String(p.merchantUrl || ""),
      bestOffer: p.bestOffer || null,
    };
  }

  const offersAll = Array.isArray(p.offersAll) ? p.offersAll : Array.isArray(p.offers) ? p.offers : [];

  // Sanitize legacy offers: canonicalize domain, recompute rank from domain, kill junk links.
  const cleanedAll = [];
  for (const o of offersAll) {
    const url0 = safeStr(o?.url || o?.link || "", 2000);
    const url = normalizeOutboundUrl(url0);
    if (!url) continue;
    if (isGoogleHostedUrl(url)) continue;

    const domain = canonicalHost(o?.domain || pickDomain(url));
    if (!domain) continue;
    if (isBlacklistedDomain(domain)) continue;

    const providerObj = findProviderByDomain(domain);
    const merchantLabel = providerObj ? (providerObj.names?.[0] || domain) : safeStr(o?.merchant || domain, 120) || domain;

    cleanedAll.push({
      merchant: merchantLabel,
      merchantKey: domain,
      url,
      price: parsePriceAny(o?.price) ?? null,
      delivery: safeStr(o?.delivery || "", 160),
      domain,
      rank: providerObj ? providerObj.score : merchantRank(domain),
    });
  }

  const { offersTrusted, offersOther } = splitOffersForVitrine(cleanedAll);

  const trusted = offersTrusted.slice(0, OFFERS_TRUSTED_LIMIT);
  const other = offersOther.slice(0, OFFERS_OTHER_LIMIT);

  const best = pickBestOffer(trusted);
  const merchantUrl = best?.url || "";

  return {
    ...p,
    offersAll: cleanedAll,
    offersTrusted: trusted,
    offersOther: other,
    offers: trusted, // legacy: vitrine uses trusted only
    bestOffer: best
      ? {
          merchant: best.merchant,
          url: best.url,
          price: best.price ?? null,
          delivery: best.delivery || "",
        }
      : null,
    merchantUrl,
  };
}


// ======================================================================
// Evidence collection (strong GTIN paths)
// ======================================================================
function collectEvidenceCodes(obj) {
  const out = [];
  const seen = new Set();

  function walk(x, path, depth) {
    if (!x || depth > 10) return;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) walk(x[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof x !== "object") return;

    for (const [k, v] of Object.entries(x)) {
      const key = String(k);
      const low = key.toLowerCase();
      const p = path ? `${path}.${key}` : key;

      if (low === "gtin" || low === "gtin13" || low === "gtin14" || low === "ean" || low === "ean13" || low === "upc") {
        const s = String(v || "").replace(/[^\d]/g, "");
        if (s && /^\d{8,18}$/.test(s)) {
          const uniq = `${s}|${p}`;
          if (!seen.has(uniq)) {
            seen.add(uniq);
            out.push({ code: s, path: p });
          }
        }
      } else {
        walk(v, p, depth + 1);
      }
    }
  }

  walk(obj, "", 0);
  return out;
}

function isStrongGtinPath(path) {
  const p = String(path || "").toLowerCase();

  // seller/offer/store altından gelen kodlar “kanıt” sayılmasın (çok kirli)
  if (p.includes("stores") || p.includes("sellers") || p.includes("offers")) return false;

  // product_results/specifications/details gibi "ürün gövdesi" alanlarını kabul
  if (p.startsWith("product_results.")) return true;
  if (p.includes(".product_results.")) return true;
  if (p.includes("spec") || p.includes("specification") || p.includes("details") || p.includes("attributes")) return true;

  return false;
}

// ======================================================================
// SerpAPI low-level JSON fetch (google_product fallback için)
// ======================================================================
function getSerpApiKey() {
  return (
    process.env.SERPAPI_KEY ||
    process.env.SERP_API_KEY ||
    process.env.SERPAPI ||
    process.env.SERPAPIKEY ||
    ""
  );
}

async function fetchSerpApiJson(params, diag, stepName = "serpapi_json") {
  const key = getSerpApiKey();
  if (!key) {
    diag?.tries?.push?.({ step: `${stepName}_no_key` });
    return null;
  }

  try {
    const base = "https://serpapi.com/search.json";
    const u = new URL(base);
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    u.searchParams.set("api_key", key);

    diag?.tries?.push?.({
      step: `${stepName}_fetch`,
      engine: safeStr(params?.engine || "", 40),
      hasProductId: Boolean(params?.product_id),
    });

    const { run } = withTimeout(
      async (sig) => {
        const r = await fetch(u.toString(), { method: "GET", signal: sig });
        const txt = await r.text();
        if (!r.ok) throw new Error(`SERPAPI_HTTP_${r.status}`);
        try {
          return JSON.parse(txt);
        } catch {
          throw new Error("SERPAPI_JSON_FAIL");
        }
      },
      12_000,
      `${stepName}_timeout`
    );

    const j = await run;
    diag?.tries?.push?.({ step: `${stepName}_ok` });
    return j;
  } catch (e) {
    diag?.tries?.push?.({ step: `${stepName}_error`, error: String(e?.message || e) });
    return null;
  }
}

// ======================================================================
// Immersive offers extraction
// NOTE: Immersive response'da mağazalar genelde product_results.stores altında gelir.
// ======================================================================
function extractOffersFromImmersive(j) {
  const candidates =
    j?.product_results?.stores ||
    j?.product_results?.online_sellers ||
    j?.product_results?.sellers_results ||
    j?.stores ||
    j?.sellers_results ||
    j?.online_sellers ||
    j?.online_sellers_results ||
    j?.sellers ||
    j?.seller_results ||
    j?.offers ||
    [];

  const arr = Array.isArray(candidates) ? candidates : [];
  const out = [];

  for (const x of arr) {
    const merchant =
      safeStr(x?.name || x?.seller || x?.source || x?.merchant || x?.store_name || "", 120) || "";

    const link0 =
      safeStr(x?.link || x?.url || x?.merchant_link || x?.product_link || x?.store_link || "", 2000) || "";

    const link = normalizeOutboundUrl(link0);

    const price =
      parsePriceAny(x?.extracted_price) ??
      parsePriceAny(x?.price) ??
      parsePriceAny(x?.total_price) ??
      parsePriceAny(x?.price_value) ??
      parsePriceAny(x?.value);

    const delivery = safeStr(x?.delivery || x?.shipping || x?.shipping_cost || x?.shipping_price || "", 120) || "";

    if (!link || isGoogleHostedUrl(link)) continue;

    const domain = canonicalHost(pickDomain(link));
    if (!domain) continue;
    if (isBlacklistedDomain(domain)) continue;

    const provider = findProviderByDomain(domain);
    if (STRICT_OFFER_ALLOWLIST && !provider) continue;

    out.push({
      merchant: provider ? (provider.names?.[0] || domain) : (merchant || domain),
      merchantKey: domain,
      url: link,
      price: price ?? null,
      delivery,
      domain,
      rank: provider ? provider.score : merchantRank(domain),
    });
  }

  out.sort((a, b) => {
    const ar = a.rank || 0;
    const br = b.rank || 0;
    if (ar !== br) return br - ar;

    const ap = a.price != null ? a.price : Number.POSITIVE_INFINITY;
    const bp = b.price != null ? b.price : Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;

    const ak = a.merchantKey || "";
    const bk = b.merchantKey || "";
    return ak.localeCompare(bk);
  });

  return out;
}

async function fetchImmersiveOffers(raw, code, diag) {
  const apiUrl = raw?.serpapi_immersive_product_api || raw?.serpapi_product_api || "";
  if (!apiUrl) return { offers: [], gtinMatch: false, gtinsFound: 0 };

  const key = getSerpApiKey();
  if (!key) {
    diag?.tries?.push?.({ step: "immersive_no_key" });
    return { offers: [], gtinMatch: false, gtinsFound: 0 };
  }

  const finalUrl = appendQuery(apiUrl, { api_key: key });

  try {
    diag?.tries?.push?.({ step: "immersive_fetch", url: safeStr(finalUrl, 220) });

    const { run } = withTimeout(
      async (sig) => {
        const r = await fetch(finalUrl, { method: "GET", signal: sig });
        const txt = await r.text();
        if (!r.ok) throw new Error(`IMMERSIVE_HTTP_${r.status}`);
        try {
          return JSON.parse(txt);
        } catch {
          throw new Error("IMMERSIVE_JSON_FAIL");
        }
      },
      12_000,
      "IMMERSIVE_TIMEOUT"
    );

    const j = await run;

    const offers = extractOffersFromImmersive(j);

    // Strong GTIN match
    const ev = collectEvidenceCodes(j);
    const strong = ev.filter((x) => isStrongGtinPath(x.path)).map((x) => x.code);
    const strongSet = new Set(strong);
    const gtinMatch = strongSet.has(String(code || "").trim());
    const gtinsFound = strongSet.size;

    diag?.tries?.push?.({
      step: "immersive_ok",
      offers: offers.length,
      gtinMatch,
      gtinsFound: Math.min(gtinsFound, 5),
    });

    return { offers, gtinMatch, gtinsFound };
  } catch (e) {
    diag?.tries?.push?.({ step: "immersive_error", error: String(e?.message || e) });
    return { offers: [], gtinMatch: false, gtinsFound: 0 };
  }
}

// ======================================================================
// Google Product offers extraction (fallback)
// ======================================================================
function extractOffersFromGoogleProduct(gp) {
  const candidates =
    gp?.product_results?.stores ||
    gp?.product_results?.online_sellers ||
    gp?.product_results?.sellers_results ||
    gp?.stores ||
    gp?.online_sellers ||
    gp?.sellers_results ||
    gp?.offers ||
    [];

  const arr = Array.isArray(candidates) ? candidates : [];
  const out = [];

  for (const x of arr) {
    const merchant =
      safeStr(x?.name || x?.seller || x?.source || x?.merchant || x?.store_name || "", 120) || "";

    const link0 =
      safeStr(x?.link || x?.url || x?.merchant_link || x?.product_link || x?.store_link || "", 2000) || "";

    const link = normalizeOutboundUrl(link0);

    const price =
      parsePriceAny(x?.extracted_price) ??
      parsePriceAny(x?.price) ??
      parsePriceAny(x?.total_price) ??
      parsePriceAny(x?.price_value) ??
      parsePriceAny(x?.value);

    const delivery = safeStr(x?.delivery || x?.shipping || x?.shipping_cost || x?.shipping_price || "", 120) || "";

    if (!link || isGoogleHostedUrl(link)) continue;

    const domain = canonicalHost(pickDomain(link));
    if (!domain) continue;
    if (isBlacklistedDomain(domain)) continue;

    const provider = findProviderByDomain(domain);
    if (STRICT_OFFER_ALLOWLIST && !provider) continue;

    out.push({
      merchant: provider ? (provider.names?.[0] || domain) : (merchant || domain),
      merchantKey: domain,
      url: link,
      price: price ?? null,
      delivery,
      domain,
      rank: provider ? provider.score : merchantRank(domain),
    });
  }

  out.sort((a, b) => {
    const ar = a.rank || 0;
    const br = b.rank || 0;
    if (ar !== br) return br - ar;

    const ap = a.price != null ? a.price : Number.POSITIVE_INFINITY;
    const bp = b.price != null ? b.price : Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;

    const ak = a.merchantKey || "";
    const bk = b.merchantKey || "";
    return ak.localeCompare(bk);
  });

  return out;
}

async function fetchGoogleProduct(barcode, picked, localeShort, diag) {
  const productId = picked?.raw?.product_id || picked?.raw?.productId || picked?.raw?.raw?.product_id || "";
  if (!productId) {
    diag?.tries?.push?.({ step: "google_product_skip_no_product_id" });
    return { offersTrusted: [], offersOther: [], offers: [], bestOffer: null, merchantUrl: "", verifiedBarcode: false, verifiedBy: "", confidence: "medium" };
  }

  const { hl, gl } = localePack(localeShort);

  // IMPORTANT: google_product engine param set'ini minimal tut (aksi halde 400 yiyebiliyor)
  const gp = await fetchSerpApiJson(
    { engine: "google_product", product_id: productId, hl, gl },
    diag,
    "google_product"
  );

  if (!gp) {
    diag?.tries?.push?.({ step: "google_product_null" });
    return { offersTrusted: [], offersOther: [], offers: [], bestOffer: null, merchantUrl: "", verifiedBarcode: false, verifiedBy: "", confidence: "medium" };
  }

  const offersAll = extractOffersFromGoogleProduct(gp);
  const { offersTrusted, offersOther } = splitOffersForVitrine(offersAll);
  const bestOffer = pickBestOffer(offersTrusted);
  const merchantUrl = bestOffer?.url || "";

  // Strong GTIN evidence
  const ev = collectEvidenceCodes(gp);
  const strong = ev.filter((x) => isStrongGtinPath(x.path)).map((x) => x.code);
  const strongSet = new Set(strong);

  const gtinMatch = strongSet.has(String(barcode || "").trim());
  const gtinsFound = strongSet.size;

  diag?.tries?.push?.({ step: "google_product_ok", offersAll: offersAll.length, offersTrusted: offersTrusted.length, offersOther: offersOther.length, gtinMatch, gtinsFound: Math.min(gtinsFound, 5) });

  let verifiedBarcode = false;
  let verifiedBy = "";
  let confidence = (offersTrusted.length || offersOther.length) ? "medium" : "low";

  if (gtinMatch) {
    verifiedBarcode = true;
    verifiedBy = "serpapi:google_product";
    confidence = "high";
  }

  return { offersTrusted, offersOther, offers: offersTrusted, bestOffer, merchantUrl, verifiedBarcode, verifiedBy, confidence };
}

// ======================================================================
// Catalog verification (TR) — epey/cimri/akakce vb.
// ======================================================================
function isCatalogDomain(host) {
  const h = String(host || "").toLowerCase();
  return (
    h.includes("epey.com") ||
    h.includes("cimri.com") ||
    h.includes("akakce.com") ||
    h.includes("upcindex.com") ||
    h.includes("barcodelookup.com") ||
    h.includes("opengtindb.org") ||
    h.includes("gtincheck.org") ||
    h.includes("ean-search.org")
  );
}

async function resolveBarcodeViaCatalogSites(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:catalog:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  const queries = [
    `site:epey.com ${code} barkod`,
    `site:cimri.com ${code}`,
    `site:akakce.com ${code}`,
    `site:upcindex.com ${code}`,
    `site:barcodelookup.com ${code}`,
  ];

  for (const q of queries) {
    try {
      diag?.tries?.push?.({ step: "catalog_search", q });

      const r = await searchWithSerpApi(q, {
        mode: "google",
        region,
        hl,
        gl,
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
        barcode: true,
        intent: { type: "barcode" },
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) {
        diag?.tries?.push?.({ step: "catalog_empty", q });
        continue;
      }

      for (const it of items.slice(0, 5)) {
        const title = cleanTitle(it?.title || "");
        const url0 = safeStr(it?.url || it?.deeplink || it?.originUrl || it?.finalUrl || "", 2000);
        const url = normalizeOutboundUrl(url0);
        if (!url) continue;

        const host = pickDomain(url);
        if (!isCatalogDomain(host)) continue;

        const ok = await probeUrlForBarcode(url, code, diag);
        if (!ok) continue;

        const raw = it?.raw || {};
        const desc = safeStr(raw?.snippet || raw?.description || raw?.summary || "", 260) || "";
        const img = safeStr(it?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

        const product = {
          name: title || code,
          title: title || code,
          description: desc,
          image: img,
          brand: safeStr(raw?.brand || raw?.brands || "", 120),
          category: "product",
          region,
          qrCode: code,
          provider: "barcode",
          source: `catalog:${host || "unknown"}`,
          verifiedBarcode: true,
          verifiedBy: host || "catalog",
          verifiedUrl: url,
          offersTrusted: [],

          offersOther: [],

          offers: [],
          bestOffer: null,
          merchantUrl: "",
          confidence: "high",
          raw: it,
        };

        cacheSetBarcode(cacheKey, product);
        diag?.tries?.push?.({ step: "catalog_pick", q, host, url: safeStr(url, 160) });
        return product;
      }
    } catch (e) {
      diag?.tries?.push?.({ step: "catalog_error", q, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// Local marketplaces resolver (TR) — eskisi korunur
// ======================================================================
async function resolveBarcodeViaLocalMarketplaces(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:local:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  diag?.tries?.push?.({ step: "local_marketplaces_start", barcode: code });

  let hits = [];
  try {
    hits = await searchLocalBarcodeEngine(code, {
      region: "TR",
      maxCandidates: 6,
      maxMatches: 1,
    });
  } catch (e) {
    diag?.tries?.push?.({ step: "local_marketplaces_error", error: String(e?.message || e) });
    hits = [];
  }

  if (Array.isArray(hits) && hits.length > 0) {
    const h = hits[0] || {};
    const name = cleanTitle(h?.title || h?.name || "") || code;
    const url0 = safeStr(h?.url || h?.link || "", 2000) || "";
    const url = normalizeOutboundUrl(url0);

    const domain0 = pickDomain(url);
    const rawOffers = url
      ? [
          {
            merchant: domain0 || "local",
            merchantKey: domain0,
            url,
            title: name,
            image: safeStr(h?.image || "", 2000) || "",
            price: typeof h?.price === "number" ? h.price : null,
            currency:
              typeof h?.price === "number" && h.price > 0 ? safeStr(h?.currency || "TRY", 10) : null,
            verifiedBarcode: !!h?.verifiedBarcode,
            delivery: "",
            domain: domain0,
            rank: merchantRank(domain0),
          },
        ]
      : [];

    const { offersTrusted, offersOther } = splitOffersForVitrine(rawOffers);
    const bestOfferPick = pickBestOffer(offersTrusted);

    const isVerified = !!h?.verifiedBarcode;
    const product = {

      name,
      title: name,
      description: "",
      image: safeStr(h?.image || "", 2000) || "",
      brand: "",
      category: "product",
      region: "TR",
      qrCode: code,
      provider: "barcode",
      source: "local-marketplace-engine",
      verifiedBarcode: isVerified,
      verifiedBy: pickDomain(url) || "local",
      verifiedUrl: url || "",
      offersTrusted,
      offersOther,
      offers: offersTrusted,
      bestOffer: bestOfferPick
        ? { merchant: bestOfferPick.merchant, url: bestOfferPick.url, price: bestOfferPick.price ?? null, delivery: bestOfferPick.delivery || "" }
        : null,
      merchantUrl: bestOfferPick?.url || "",
      confidence: isVerified ? "high" : "medium",
      raw: h,
    };

    cacheSetBarcode(cacheKey, product);
    diag?.tries?.push?.({ step: "local_marketplaces_pick", url: url ? safeStr(url, 160) : null });
    return product;
  }

  diag?.tries?.push?.({ step: "local_marketplaces_empty" });
  return null;
}



// ======================================================================
// OFFICIAL (AFFILIATE / ADAPTER ENGINE) BARCODE RESOLVE — FREE-ONLY
//  - Uses textual identity (from OpenFoodFacts or local identity) then runs S40
//  - Paid adapters (Serp/GoogleShopping) and coverage-floor are disabled here.
//  - Strict relevance filter to avoid unrelated junk results.
// ======================================================================
function hasLetters(s) {
  return /[a-zA-ZÀ-ɏЀ-ӿ؀-ۿışğüöçİŞĞÜÖÇ]/.test(String(s || ""));
}

function tokenizeLoose(s) {
  const raw = String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9À-ɏЀ-ӿ؀-ۿışğüöçİŞĞÜÖÇ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) return [];

  const stop = new Set([
    "ve","ile","icin","için","the","and","for","with","de","da","la","le","un","une","des","du","et","en","of"
  ]);

  return raw
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && t.length >= 2 && !stop.has(t));
}

function overlapScoreTokens(aTokens, bTokens) {
  try {
    if (!aTokens?.length || !bTokens?.length) return 0;
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    let hit = 0;
    for (const t of a) if (b.has(t)) hit++;
    const denom = Math.max(1, Math.min(a.size, b.size));
    return hit / denom;
  } catch {
    return 0;
  }
}

function pickItemOriginDomain(it) {
  try {
    const originUrl = it?.originUrl || it?.raw?.originUrl || it?.raw?.origin || "";
    const u0 = originUrl || it?.url || it?.affiliateUrl || "";
    const u = normalizeOutboundUrl(String(u0 || ""));
    const d = pickDomain(u);
    return d || "";
  } catch {
    return "";
  }
}

function offersFromVitrineItems(items, titleHint) {
  const qTokens = tokenizeLoose(titleHint);
  const strict = qTokens.length >= 2;

  const out = [];

  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;

    const title = cleanTitle(it?.title || it?.name || "");
    const url0 = it?.affiliateUrl || it?.url || "";
    const url = normalizeOutboundUrl(String(url0 || ""));
    if (!url) continue;

    const originDomain = pickItemOriginDomain(it);
    const domain = originDomain || pickDomain(url);

    const price = parsePriceAny(it?.finalUserPrice ?? it?.price ?? it?.finalPrice ?? it?.raw?.price ?? null);
    if (!(typeof price === "number" && price > 0)) continue;

    // strict relevance: drop unrelated results
    if (strict && title) {
      const tTokens = tokenizeLoose(title);
      const sc = overlapScoreTokens(qTokens, tTokens);
      if (sc < 0.34) continue;
    }

    const provider = findProviderByDomain(domain);
    const merchant = provider?.names?.[0] || domain || it?.providerKey || it?.provider || "shop";

    out.push({
      merchant,
      merchantKey: provider?.key || domain || merchant,
      url,
      title: title || cleanTitle(titleHint) || "",
      image: safeStr(it?.image || it?.img || it?.thumbnail || it?.raw?.image || "", 2000) || "",
      price,
      currency: safeStr(it?.currency || it?.raw?.currency || "TRY", 10),
      delivery: "",
      domain,
      rank: merchantRank(domain),
      raw: it,
    });
  }

  return out;
}

async function resolveBarcodeIdentityViaLocalMarketplaces(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  diag?.tries?.push?.({ step: "local_identity_start", barcode: code });

  try {
    const hits = await searchLocalBarcodeEngine(code, {
      region: "TR",
      maxCandidates: 5,
      maxMatches: 1,
      allowNoPrice: true,
    });

    const h = Array.isArray(hits) ? hits[0] : null;
    if (!h) {
      diag?.tries?.push?.({ step: "local_identity_empty" });
      return null;
    }

    const name = cleanTitle(h?.title || h?.name || "") || code;
    const url = normalizeOutboundUrl(safeStr(h?.url || h?.link || "", 2000) || "");

    diag?.tries?.push?.({ step: "local_identity_pick", url: url ? safeStr(url, 160) : null });

    return {
      name,
      title: name,
      image: safeStr(h?.image || "", 2000) || "",
      qrCode: code,
      provider: "barcode",
      source: "local-marketplace-identity",
      verifiedBarcode: !!h?.verifiedBarcode,
      verifiedBy: pickDomain(url) || "local",
      verifiedUrl: url || "",
      raw: h,
    };
  } catch (e) {
    diag?.tries?.push?.({ step: "local_identity_error", error: String(e?.message || e) });
    return null;
  }
}

async function resolveBarcodeViaOfficialVitrine(titleHint, barcode, localeShort = "tr", diag, verifiedHint = false) {
  const code = String(barcode || "").trim();
  const hint = cleanTitle(titleHint || "");

  if (!/^\d{8,18}$/.test(code)) return null;
  if (!hint) return null;
  // In strict-free mode, we sometimes only have the barcode itself. Many marketplaces accept barcode search.
  // Allow a pure-numeric hint, otherwise require letters to avoid junk queries.
  const numericOnly = /^\d{8,18}$/.test(hint);
  if (!numericOnly && !hasLetters(hint)) return null;

  const cacheKey = `${localeShort}:official:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  diag?.tries?.push?.({ step: "official_s40_start", q: safeStr(hint, 140) });

  let data = null;
  try {
    data = await runVitrineS40(hint, {
      region: "TR",
      categoryHint: "product",
      source: "barcode",
      disablePaidAdapters: true,
      skipCoverageFloor: true,
    });
  } catch (e) {
    diag?.tries?.push?.({ step: "official_s40_error", error: String(e?.message || e) });
    data = null;
  }

  const items = Array.isArray(data?.items)
    ? data.items
    : [
        ...(Array.isArray(data?.best) ? data.best : []),
        ...(Array.isArray(data?.smart) ? data.smart : []),
        ...(Array.isArray(data?.others) ? data.others : []),
      ];

  const offersAll = offersFromVitrineItems(items, hint);
  const { offersTrusted, offersOther } = splitOffersForVitrine(offersAll);

  diag?.tries?.push?.({ step: "official_s40_done", offersAll: offersAll.length, offersTrusted: offersTrusted.length, offersOther: offersOther.length });

  if (!offersTrusted.length) return null;

  const bestOfferPick = pickBestOffer(offersTrusted);

  const product = {
      name: hint,
      title: hint,
      description: "",
      image: safeStr(items?.[0]?.image || items?.[0]?.img || items?.[0]?.thumbnail || "", 2000) || "",
      brand: "",
      category: "product",
      region: "TR",
      qrCode: code,
      provider: "barcode",
      source: "official-affiliate-s40",
      verifiedBarcode: !!verifiedHint,
      verifiedBy: verifiedHint ? "barcode-identity" : "",
      verifiedUrl: "",
      offersTrusted,
      offersOther,
      offers: offersTrusted,
      bestOffer: bestOfferPick
        ? { merchant: bestOfferPick.merchant, url: bestOfferPick.url, price: bestOfferPick.price ?? null, delivery: bestOfferPick.delivery || "" }
        : null,
      merchantUrl: bestOfferPick?.url || "",
      confidence: verifiedHint ? "high" : "medium",
      raw: { adapter: data, hint },
  };

  cacheSetBarcode(cacheKey, product);
  return product;
}

// ======================================================================
// Catalog snippet verify fallback (STRICT MODE)
//  - Snippet tek başına “verified” yapmaz. Sadece URL bulup probe ile kanıt arar.
// ======================================================================
async function verifyViaCatalogSnippet(barcode, diag, titleHint = "") {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const baseQueries = [
    `site:epey.com "${code}"`,
    `site:cimri.com "${code}"`,
    `site:akakce.com "${code}"`,
  ];

  const title = safeStr(titleHint, 120);
  const queries = title ? [...baseQueries, ...baseQueries.map((q) => `${q} "${title}"`)] : baseQueries;

  for (const q of queries) {
    try {
      diag?.tries?.push?.({ step: "catalog_snippet_search", q });

      const r = await searchWithSerpApi(q, {
        mode: "google",
        region: "TR",
        hl: "tr",
        gl: "tr",
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
        barcode: true,
        intent: { type: "barcode" },
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) {
        diag?.tries?.push?.({ step: "catalog_snippet_empty", q });
        continue;
      }

      for (const it of items.slice(0, 6)) {
        const url0 = safeStr(it?.url || it?.deeplink || it?.originUrl || it?.finalUrl || "", 2000);
        const url = normalizeOutboundUrl(url0);
        if (!url) continue;

        const host = pickDomain(url);
        if (!isCatalogDomain(host)) continue;

        const raw = it?.raw || {};
        const text = `${it?.title || ""}\n${raw?.snippet || raw?.description || raw?.summary || ""}`;
        if (!hasBarcodeEvidenceInText(text, code)) continue;

        // STRICT: HTML'de kanıt arıyoruz.
        const ok = await probeUrlForBarcode(url, code, diag);
        if (!ok) continue;

        diag?.tries?.push?.({ step: "catalog_snippet_verified", host, url: safeStr(url, 160) });
        return { verifiedBy: host, url };
      }
    } catch (e) {
      diag?.tries?.push?.({ step: "catalog_snippet_error", q, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// SerpAPI Shopping resolver (barcode -> product identity + offers)
// ======================================================================
async function resolveBarcodeViaSerpShopping(barcode, localeShort = "tr", diag, titleHint = "") {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:shopping:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  // ✅ Tek request disiplini: tek query + tek Serp çağrısı (noRetry) + immersive yok.
  // Barkod tek başına Shopping'de sık boş dönebiliyor. (GTIN/EAN olarak aratmak daha iyi.)
  // Eğer elimizde isim ipucu varsa (OpenFoodFacts vb.) tek sorguda birleştir.
  const hint = String(titleHint || "").trim();
  const q = hint ? `${hint} ${code}` : `EAN ${code}`;

  try {
    diag?.tries?.push?.({ step: "shopping_serpapi_single", q });

    const r = await searchWithSerpApi(q, {
      region,
      hl,
      gl,
      num: 12,
      timeoutMs: 12000,
      barcode: true,
      intent: { type: "barcode" },
      noRetry: true,
    });

    const items = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
    if (!items.length) {
      diag?.tries?.push?.({ step: "shopping_empty", q });
      return null;
    }

    // Basit ama sağlam skor: barkod aramasında başlık en kritik sinyal.
    const scoreTitleForBarcode = (title, codeStr) => {
      const t = String(title || "").toLowerCase();
      const c = String(codeStr || "");
      let s = 0;
      if (c && t.includes(c)) s += 40;
      if (t.includes("ean") || t.includes("gtin") || t.includes("barkod")) s += 10;
      if (t.length >= 12) s += 5;
      if (t.length >= 20) s += 5;
      return s;
    };
    const scored = [];
    for (const it of items) {
      const title = cleanTitle(it?.title || it?.name || "");
      if (!title || title.length < 6) continue;
      const raw = it?.raw || {};
      const url0 = safeStr(it?.url || it?.link || it?.product_link || raw?.link || raw?.product_link || "");
      const host = urlHost(url0);
      const score = scoreTitleForBarcode(title, code) + (host ? 5 : 0);
      scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0]?.it || items[0] || {};
    const raw = best?.raw || {};
    const title = cleanTitle(best?.title || best?.name || "") || safeStr(best?.title || best?.name || code);
    const url = safeStr(best?.url || best?.link || best?.product_link || raw?.link || raw?.product_link || "");
    const image = safeStr(best?.image || best?.thumbnail || raw?.thumbnail || "");
    const currency = safeStr(best?.currency || raw?.currency || "");
    const priceRaw = best?.price ?? raw?.price ?? null;
    const price = parsePriceAny(priceRaw);

    const urlNorm = normalizeOutboundUrl(url);
    const domain0 = urlNorm ? canonicalHost(pickDomain(urlNorm)) : "";
    const provider0 = domain0 ? findProviderByDomain(domain0) : null;
    const merchantName = provider0 ? (provider0.names?.[0] || domain0) : (domain0 || "shopping");
    const offer0 = urlNorm
      ? {
          merchant: merchantName,
          merchantKey: domain0 || merchantName,
          url: urlNorm,
          title: title || code,
          image: image || "",
          price,
          currency: currency || (price ? "TRY" : null),
          delivery: "",
          domain: domain0 || undefined,
          rank: provider0 ? provider0.score : merchantRank(domain0),
          provider: "serpapi",
          providerKey: "serpapi",
        }
      : null;

    const offersAll = offer0 ? [offer0] : [];
    const { offersTrusted, offersOther } = splitOffersForVitrine(offersAll);

    const bestOffer = pickBestOffer(offersTrusted);
    const merchantUrl = bestOffer?.url || offer0?.url || "";

    // NOTE: This resolver MUST return a product-like object (same shape as other resolvers),
    // because the main handler expects `.name` / `.title` at the top-level.
    const product = {
      name: title || code,
      title: title || code,
      description: "",
      image: image || "",
      brand: "",
      category: "product",
      region,
      qrCode: code,
      provider: "barcode",
      source: "serpapi-shopping-single",
      verifiedBarcode: false,
      verifiedBy: "serpapi:shopping_single",
      verifiedUrl: merchantUrl || "",
      offersTrusted,
      offersOther,
      offers: offersTrusted,
      bestOffer: bestOffer
        ? { merchant: bestOffer.merchant, url: bestOffer.url, price: bestOffer.price ?? null, delivery: bestOffer.delivery || "" }
        : null,
      merchantUrl: merchantUrl || "",
      confidence: (offersTrusted.length || offersOther.length) ? "medium" : "low",
      raw: best,
    };

    cacheSetBarcode(cacheKey, product, 60_000);
    return product;
  } catch (e) {
    diag?.tries?.push?.({ step: "shopping_error", q, err: String(e?.message || e) });
    return null;
  }
}

// ======================================================================
// MAIN HANDLER
// ======================================================================


// ============================================================
//  OpenFoodFacts helper (FREE) — identity/name/image only
//  IMPORTANT: must NEVER crash the route (no 500).
// ============================================================
async function fetchJsonWithTimeout(url, timeoutMs = 6500) {
  const controller = typeof AbortController !== "undefined" ? AbortController : null;
  const c = controller ? new controller() : null;
  const timer = setTimeout(() => {
    try { c?.abort?.(); } catch {}
  }, timeoutMs);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "findalleasy/1.0 (+https://findalleasy.com)",
        "accept": "application/json,text/plain,*/*",
      },
      signal: c?.signal,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j
  } catch {
    return null;
  } finally {
    try { clearTimeout(timer); } catch {}
  }
}

async function fetchOpenFoodFacts(qr, diag) {
  const code = sanitizeQR(qr);
  if (!code) return null;

  const urls = [
    `https://tr.openfoodfacts.org/api/v0/product/${code}.json`,
    `https://world.openfoodfacts.org/api/v0/product/${code}.json`,
    `https://world.openproductsfacts.org/api/v0/product/${code}.json`,
    `https://world.openbeautyfacts.org/api/v0/product/${code}.json`,
  ];

  for (const url of urls) {
    try {
      diag?.tries?.push?.({ step: "openfoodfacts_fetch", url });
      const j = await fetchJsonWithTimeout(url, 6500);
      const ok = j && (j.status === 1 || j.status === "1") && j.product;
      if (!ok) continue;

      const pr = j.product || {};
      const title = (
        safeStr(pr.product_name_tr, 200) ||
        safeStr(pr.product_name, 200) ||
        safeStr(pr.abbreviated_product_name, 200) ||
        safeStr(pr.generic_name_tr, 200) ||
        safeStr(pr.generic_name, 200) ||
        safeStr(pr.brands, 200) ||
        code
      ).trim();

      const image =
        safeStr(pr.image_front_url, 400) ||
        safeStr(pr.image_url, 400) ||
        safeStr(pr.image_front_small_url, 400) ||
        "";

      const baseProduct = {
        name: title,
        title,
        qrCode: code,
        provider: "barcode",
        source: "openfoodfacts",
        identitySource: "openfoodfacts",
        verifiedBarcode: true,
        verifiedBy: "openfoodfacts",
        verifiedUrl: url,
        image,
        offersTrusted: [],
        offersOther: [],
        offers: [],
        bestOffer: null,
        merchantUrl: "",
        confidence: "medium",
        suggestedQuery: title && title !== code ? title : "",
      };

      diag?.tries?.push?.({ step: "openfoodfacts_hit", title });
      return baseProduct;
    } catch (e) {
      // never throw
      diag?.tries?.push?.({ step: "openfoodfacts_error", error: String(e?.message || e) });
    }
  }

  diag?.tries?.push?.({ step: "openfoodfacts_miss" });
  return null;
}

// ============================================================
//  Wikidata GTIN helper (FREE) — identity/name/image only
//  Uses Wikidata SPARQL endpoint (no API key).
//  Coverage is not universal, but it helps for many products.
//  IMPORTANT: must NEVER crash the route (no 500).
// ============================================================
async function fetchWikidataByGTIN(qr, localeShort, diag) {
  const code = sanitizeQR(qr);
  if (!/^[0-9]{8,18}$/.test(code)) return null;

  const lang = String(localeShort || "tr").toLowerCase();
  const ua = process.env.WIKIDATA_UA || process.env.OFF_USER_AGENT || "FindAllEasy/1.0 (findalleasy@gmail.com)";

  // Wikidata GTIN property is typically P3962 (Global Trade Item Number).
  // We keep the query tiny and cache-friendly.
  const sparql = `
SELECT ?item ?itemLabel ?brandLabel ?image WHERE {
  ?item wdt:P3962 "${code}" .
  OPTIONAL { ?item wdt:P1716 ?brand . }
  OPTIONAL { ?item wdt:P18 ?image . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en". }
} LIMIT 1
`.trim();

  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  try {
    diag?.tries?.push?.({ step: "wikidata_gtin_fetch" });
    const j = await fetchJsonWithTimeout(url, Number(process.env.WIKIDATA_TIMEOUT_MS || 6500));
    const b = j?.results?.bindings?.[0];
    if (!b?.item?.value) {
      diag?.tries?.push?.({ step: "wikidata_gtin_miss" });
      return null;
    }

    const title = safeStr(b?.itemLabel?.value || "", 200).trim();
    const brand = safeStr(b?.brandLabel?.value || "", 120).trim();
    const image = safeStr(b?.image?.value || "", 2000).trim();
    const itemUrl = safeStr(b?.item?.value || "", 400).trim();

    const bestTitle = cleanTitle(`${brand ? brand + " " : ""}${title}`.trim()) || cleanTitle(title) || code;

    diag?.tries?.push?.({ step: "wikidata_gtin_hit", title: safeStr(bestTitle, 160) });
    return {
      name: bestTitle,
      title: bestTitle,
      qrCode: code,
      provider: "barcode",
      source: "wikidata",
      identitySource: "wikidata",
      verifiedBarcode: true,
      verifiedBy: "wikidata",
      verifiedUrl: itemUrl || "",
      image: image || "",
      offersTrusted: [],
      offersOther: [],
      offers: [],
      bestOffer: null,
      merchantUrl: "",
      confidence: "medium",
      suggestedQuery: bestTitle && bestTitle !== code ? bestTitle : "",
    };
  } catch (e) {
    // never throw
    diag?.tries?.push?.({ step: "wikidata_gtin_error", error: String(e?.message || e) });
    return null;
  }
}

function buildMarketplaceSearchLinks(q, localeShort = "tr") {
  const query = String(q || "").trim();
  if (!query) return [];
  const enc = encodeURIComponent(query);
  // These are simple outbound search links (no scraping).
  return [
    { merchant: "hepsiburada", url: `https://www.hepsiburada.com/ara?q=${enc}` },
    { merchant: "trendyol", url: `https://www.trendyol.com/sr?q=${enc}` },
    { merchant: "n11", url: `https://www.n11.com/arama?q=${enc}` },
    { merchant: "akakce", url: `https://www.akakce.com/arama/?q=${enc}` },
    { merchant: "cimri", url: `https://www.cimri.com/arama?q=${enc}` },
    { merchant: "google", url: `https://www.google.com/search?q=${enc}` },
  ];
}
async function handleProduct(req, res) {
  try {
    const body = pickBody(req);

    const force = String(req.query?.force || body?.force || "0") === "1";
    const diagOn = String(req.query?.diag || body?.diag || "0") === "1";

    const raw =
      body?.qr ??
      body?.code ??
      body?.data ??
      body?.text ??
      req.query?.qr ??
      req.query?.code;

    let qr = sanitizeQR(raw);
    const localeShort = pickLocale(req, body);

    const diag = diagOn
      ? {
          force,
          locale: localeShort,
          parseError: req.__jsonParseError ? true : false,
          tries: [],
        }
      : null;

    // paid fallback gating: default OFF (barcode/camera should be free-first)
    const allowPaid = parseBoolish(
      req?.query?.paid ??
        req?.query?.allowPaid ??
        req?.query?.allow_paid ??
        body?.paid ??
        body?.allowPaid ??
        body?.allow_paid ??
        process.env.PRODUCT_INFO_ALLOW_PAID_DEFAULT ??
        '0',
      false
    );

    if (diag) diag.allowPaid = allowPaid;

    try {
      res.setHeader("x-product-info-ver", "S22.11");
      res.setHeader("x-json-parse-error", req.__jsonParseError ? "1" : "0");
    } catch {}

    if (!qr) return safeJson(res, { ok: false, error: "Geçersiz QR" }, 400);

    const ip = getClientIp(req);

    if (!burst(ip, qr)) {
      const out = { ok: true, cached: true, product: null, source: "burst-limit" };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // only for suspicious tiny text
    if (qr.length < 3 && isBadQR(qr)) {
      const out = { ok: false, error: "QR bulunamadı", cached: true };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // 1) Mongo cache (force=1 ise atla)
    if (!force) {
      try {
        diag?.tries?.push?.({ step: "mongo_cache_lookup" });
        const cached = await Product.findOne({ qrCode: qr }).lean();
        if (cached) {
          const paidCache = isPaidProviderDoc(cached);

          // Free-only mode: don't *depend* on a paid provider. If the cache entry is from a paid provider,
          // we either (a) sanitize + serve it (no new paid calls), or (b) skip/purge it in strict mode.
          if (!allowPaid && paidCache) {
            const strictFree = parseBoolish(
              req?.query?.strictFree ??
                req?.query?.strict_free ??
                process.env.STRICT_FREE_ONLY ??
                "0",
              false
            );

            const purgePaidCache = parseBoolish(
              req?.query?.purgePaid ?? req?.query?.purge_paid ?? "0",
              false
            );

            if (purgePaidCache) {
              try {
                await Product.deleteOne({ qrCode: qr });
                diag?.tries?.push?.({ step: "mongo_cache_purged_paid" });
              } catch {}
            }

            if (strictFree || purgePaidCache) {
              diag?.tries?.push?.({ step: "mongo_cache_skip_paid" });
              // continue to free pipeline
            } else {
              diag?.tries?.push?.({ step: "mongo_cache_hit_paid_sanitized" });
              if (diag) diag.paidCache = true;

              const normalized = normalizeProductForVitrine(cached);
              const sanitized = sanitizePaidCacheProduct(normalized);

              const out = { ok: true, product: sanitized, source: "mongo-cache" };
              if (diag) out._diag = diag;
              return safeJson(res, out);
            }

} else {
  // Non-paid cache hit. If it's a weak/unresolved placeholder, skip it and continue enrichment.
  const purgeWeakCache = parseBoolish(
    req?.query?.purgeWeak ?? req?.query?.purge_weak ?? req?.query?.purgeweak ?? "0",
    false
  );
  const weak = isWeakCacheDoc(cached, qr);

  if (weak) {
    diag?.tries?.push?.({
      step: "mongo_cache_hit_weak",
      provider: String(cached?.provider || ""),
      source: String(cached?.source || ""),
    });

    if (purgeWeakCache) {
      try {
        await Product.deleteOne({ _id: cached._id });
        diag?.tries?.push?.({ step: "mongo_cache_purged_weak" });
      } catch {}
    }

    diag?.tries?.push?.({ step: "mongo_cache_skip_weak" });
    // continue to free pipeline (OFF/Wikidata/Official adapters, etc.)
  } else {
    diag?.tries?.push?.({ step: "mongo_cache_hit" });
    const normalized = normalizeProductForVitrine(cached);
    const out = { ok: true, product: normalized, source: "mongo-cache" };
    if (diag) out._diag = diag;
    return safeJson(res, out);
  }
}
        }
      } catch (e) {
        diag?.tries?.push?.({ step: "mongo_cache_error", error: String(e?.message || e) });
      }
    } else {
      diag?.tries?.push?.({ step: "mongo_cache_skipped_force" });
    }

    // 2) Barcode (8-18)
    if (/^\d{8,18}$/.test(qr)) {
      const unresolvedKey = `${localeShort}:unresolved:${qr}`;
      if (allowPaid && !force && unresolvedHit(unresolvedKey)) {
        diag?.tries?.push?.({ step: 'barcode_unresolved_cache_hit' });
        const product = makeUnresolvedResponseProduct(qr, "");
        const out = {
          ok: true,
          product,
          source: 'barcode-unresolved',
          cached: true,
          needsImage: true,
          message: needsImageMsg(localeShort),
        };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.1) OpenFoodFacts (food) — isim/gorsel yardimci olur ama tek basina fiyat getirmez
      let baseProduct = null;
      const off = await fetchOpenFoodFacts(qr, diag);
      if (off) {
        baseProduct = off;
        try {
          await upsertProductDoc(off, diag, "mongo_upsert_openfoodfacts");
        } catch {}
      }

      // 2.12) Wikidata GTIN (FREE) — many non-food items are not in OFF; try Wikidata for identity
      if (!baseProduct) {
        const wd = await fetchWikidataByGTIN(qr, localeShort, diag);
        if (wd) {
          baseProduct = wd;
          try {
            await upsertProductDoc(wd, diag, "mongo_upsert_wikidata");
          } catch {}
        }
      }

      // 2.15) Official affiliate/adapters (FREE-only) — önce bunu dene
      //     (Serp/GoogleShopping yok, coverage-floor yok)
      let identity = null;
      try {
        const hinted = cleanTitle(baseProduct?.suggestedQuery || baseProduct?.title || baseProduct?.name || "");
        if (hinted) identity = { name: hinted, title: hinted, image: baseProduct?.image || "", verifiedBarcode: !!baseProduct?.verifiedBarcode };
      } catch {}

      if (!identity?.name) {
        const idLocal = await resolveBarcodeIdentityViaLocalMarketplaces(qr, localeShort, diag);
        if (idLocal?.name) identity = idLocal;
      }

      // Extra identity fallback: even if OFF/locals miss, Wikidata can still give a usable title.
      if (!identity?.name) {
        const wdId = await fetchWikidataByGTIN(qr, localeShort, diag);
        if (wdId?.name) identity = wdId;
      }

      const hintName = cleanTitle(identity?.title || identity?.name || "");
      const verifiedHint = !!(identity?.verifiedBarcode);
      // If we have no identity title, try a pure barcode query; many marketplaces accept it.
      const hintForOfficial = hintName || qr;
      const official = await resolveBarcodeViaOfficialVitrine(hintForOfficial, qr, localeShort, diag, verifiedHint);
      if (official?.offersTrusted?.length) {
        const merged = {
          ...official,
          // if the query was just the barcode, prefer a human title when available
          name: (hintName || baseProduct?.suggestedQuery || baseProduct?.title || baseProduct?.name || official.name),
          title: (hintName || baseProduct?.suggestedQuery || baseProduct?.title || baseProduct?.name || official.title),
          // prefer identity image when official lacks
          image: official.image || identity?.image || baseProduct?.image || "",
          verifiedBarcode: !!verifiedHint,
          verifiedBy: verifiedHint ? (identity?.verifiedBy || identity?.identitySource || "barcode-identity") : "",
        };
        await upsertProductDoc(merged, diag, "mongo_upsert_official_s40");
        const out = { ok: true, product: merged, source: "official-affiliate-s40" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.2) Local marketplaces engine (FREE, strict evidence + price required)
      const local = await resolveBarcodeViaLocalMarketplaces(qr, localeShort, diag);
      if (local?.name) {
        const merged = baseProduct ? { ...local, name: local.name || baseProduct.name, title: local.title || baseProduct.title, image: local.image || baseProduct.image } : local;
        await upsertProductDoc(merged, diag, "mongo_upsert_local_marketplaces");
        const out = { ok: true, product: merged, source: "local-marketplace-verified" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.3) Paid fallbacks (ONLY if allowPaid=1)
      if (allowPaid) {
        // Catalog verification (epey/cimri/akakce)
        const catalog = await resolveBarcodeViaCatalogSites(qr, localeShort, diag);
        if (catalog?.name) {
          const merged = baseProduct ? { ...catalog, name: catalog.name || baseProduct.name, title: catalog.title || baseProduct.title, image: catalog.image || baseProduct.image } : catalog;
          await upsertProductDoc(merged, diag, "mongo_upsert_catalog");
          const out = { ok: true, product: merged, source: "catalog-verified" };
          if (diag) out._diag = diag;
          return safeJson(res, out);
        }

        // Google Shopping + immersive offers (+ google_product fallback)
        const shopping = await resolveBarcodeViaSerpShopping(qr, localeShort, diag, hintName);
        if (shopping?.name) {
          const merged = baseProduct ? { ...shopping, name: shopping.name || baseProduct.name, title: shopping.title || baseProduct.title, image: shopping.image || baseProduct.image } : shopping;
          await upsertProductDoc(merged, diag, "mongo_upsert_shopping");
          const out = { ok: true, product: merged, source: "serpapi-shopping" };
          if (diag) out._diag = diag;
          return safeJson(res, out);
        }
      } else {
        diag?.tries?.push?.({ step: "paid_fallbacks_skipped", reason: "allowPaid=0" });
      }

      // Barcode çözülemedi: fallback dön
      if (allowPaid) markUnresolved(unresolvedKey);
      const suggestedQuery = (() => {
        try {
          const t = cleanTitle(baseProduct?.title || baseProduct?.name || "");
          if (!t) return "";
          if (/^\d{8,18}$/.test(t)) return "";
          if (t.length < 4) return "";
          return t;
        } catch {
          return "";
        }
      })();

      const product = makeUnresolvedResponseProduct(qr, suggestedQuery);
      const needsImage = !String(suggestedQuery || "").trim();

      // Free UX helper: provide outbound search links without scraping.
      // (Frontend can show these when strictFree/identity miss.)
      try {
        const qLink = suggestedQuery || qr;
        product.searchLinks = buildMarketplaceSearchLinks(qLink, localeShort);
      } catch {}

      const out = {
        ok: true,
        product,
        source: "barcode-unresolved",
        needsImage,
        message: needsImage ? needsImageMsg(localeShort) : "",
      };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // 3) URL
    if (qr.startsWith("http")) {
      const provider = detectProviderFromUrl(qr);
      const title = extractTitleFromUrl(qr) || `${provider} ${providerProductWord(localeShort)}`;

      const product = {
        name: safeStr(title, 200),
        title: safeStr(title, 200),
        provider,
        qrCode: qr,
        source: "url",
        verifiedBarcode: false,
        verifiedBy: "",
        offersTrusted: [],

        offersOther: [],

        offers: [],
        bestOffer: null,
        merchantUrl: normalizeOutboundUrl(qr) || "",
        confidence: "medium",
      };

      await upsertProductDoc(product, diag, "mongo_upsert_product_generic");

      const out = { ok: true, product, source: `${provider}-link` };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // 4) RAW TEXT
    if (qr.length < 3) {
      markBad(qr);
      const out = { ok: false, error: "Geçersiz içerik" };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    const product = {
      name: qr,
      title: qr,
      qrCode: qr,
      provider: "text",
      source: "text",
      verifiedBarcode: false,
      verifiedBy: "",
      offersTrusted: [],

      offersOther: [],

      offers: [],
      bestOffer: null,
      merchantUrl: "",
      confidence: "medium",
    };

    await upsertProductDoc(product, diag, "mongo_upsert_product_generic");

    const out = { ok: true, product, source: "raw-text" };
    if (diag) out._diag = diag;
    return safeJson(res, out);
  } catch (err) {
    console.error("🚨 product-info ERROR:", err);
    // IMPORTANT: do not return 500 here. Keep frontend stable.
    return safeJson(res, { ok: false, error: "SERVER_ERROR", detail: String(err?.message || err) }, 200);
  }
}

// ======================================================================
// ROUTES (legacy destek)
// ======================================================================
router.post("/product", handleProduct);
router.post("/product-info", handleProduct);
router.get("/product", handleProduct);
router.get("/product-info", handleProduct);

export default router;
