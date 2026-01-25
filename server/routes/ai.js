// patched
//bunun düzeltilmiş eksik hatalrı giderilmiş komple zip olarak gönder // server/routes/ai.js
// ============================================================================
//   SONO AI — S50 ULTRA OMEGA ROUTE (FINAL FINAL FORM)
//   • Intent Engine v3 (S16 core + hijyen güçlendirme)
//   • Persona Memory v3 (in-memory, TTL + GC, zero-crash)
//   • Triple-Fallback Vitrin Beyni (runAdapters → normalize → kartlar)
//   • LLM Safe-Core (Timeout + Guard + persona aware + sanitize)
//   • Frontend / Vitrin ile %100 Geriye Dönük Uyum (response shape aynı)
//   • S16/S20’deki TÜM işlevler korunmuştur, sadece güçlendirilmiştir.
// ============================================================================

import express from "express";
import fetch from "node-fetch"; // S20: Node sürümünden bağımsız stabil fetch
import { runAdapters } from "../core/adapterEngine.js";

const router = express.Router();
const IS_PROD = process.env.NODE_ENV === "production";

// ============================================================================
// GLOBAL SABİTLER — S50
// ============================================================================
const MAX_MESSAGE_LENGTH = 2000; // kullanıcı mesajı sert limit
const MAX_LLM_ANSWER_LENGTH = 1200; // LLM cevabı sert limit
const MEMORY_MAX_KEYS = 5000;
const MEMORY_TTL_MS = 60 * 60 * 1000; // 1 saat
const MEMORY_GC_THRESHOLD = 6000;

// ============================================================================
// BASİT MEMORY (S50 Hardened — TTL + GC + ZERO DELETE)
// ============================================================================

const memory = new Map();

// S50 — internal GC
function gcMemory(now = Date.now()) {
  if (memory.size <= MEMORY_GC_THRESHOLD) return;

  for (const [key, value] of memory.entries()) {
    const ts = value && typeof value === "object" ? value._ts || 0 : 0;
    if (!ts || now - ts > MEMORY_TTL_MS) {
      memory.delete(key);
    }
  }

  // aşırı büyümeyi kes: en eski kalanları at
  if (memory.size > MEMORY_MAX_KEYS) {
    const entries = Array.from(memory.entries()).sort(
      (a, b) => (a[1]?._ts || 0) - (b[1]?._ts || 0)
    );
    const toDrop = entries.length - MEMORY_MAX_KEYS;
    for (let i = 0; i < toDrop; i++) {
      memory.delete(entries[i][0]);
    }
  }
}

// S16 — basit hijyen helper (KORUNDU, hafif güçlendirme)
function safeString(v, fallback = "") {
  if (v == null) return fallback;
  try {
    let s = String(v);
    // kontrol karakterlerini temizle
    s = s.replace(/[\x00-\x1F\x7F]/g, "");
    return s.trim();
  } catch {
    return fallback;
  }
}

// S50 — metin kısaltıcı (input/LLM guard)
function clampText(text, maxLen) {
  const s = safeString(text);
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

// IP helper (AI telemetri için ufak hijyen)
function getClientIp(req) {
  try {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.length > 0) {
      return xf.split(",")[0].trim();
    }
    return req.socket?.remoteAddress || req.ip || "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

// S16 — userKey (KORUNDU)
function getUserKey(userId, ip) {
  const uid = safeString(userId, "");
  const ipClean = safeString(ip, "");
  return uid || ipClean || "anonymous";
}

// S16 → S50 — getUserMemory (TTL + GC + _ts alanı)
async function getUserMemory(userId, ip) {
  const key = getUserKey(userId, ip);
  const now = Date.now();
  const existing = memory.get(key);

  if (existing && typeof existing === "object") {
    const ts = existing._ts || 0;
    if (!ts || now - ts > MEMORY_TTL_MS) {
      // süresi dolmuş
      memory.delete(key);
    } else {
      return {
        clicks: Number(existing.clicks || 0),
        lastQueries: Array.isArray(existing.lastQueries)
          ? existing.lastQueries
          : [],
        preferredSources: Array.isArray(existing.preferredSources)
          ? existing.preferredSources
          : [],
        lastRegion: existing.lastRegion || null,
        lastCity: existing.lastCity || null,
        personaHint: existing.personaHint || null,
      };
    }
  }

  const fresh = {
    clicks: 0,
    lastQueries: [],
    preferredSources: [],
    lastRegion: null,
    lastCity: null,
    personaHint: null,
    _ts: now,
  };

  memory.set(key, fresh);
  gcMemory(now);
  return fresh;
}

// S16 — updateUserMemory (KORUNDU, S50 limit + TTL)
async function updateUserMemory(userId, ip, payload = {}) {
  const key = getUserKey(userId, ip);
  const prev = await getUserMemory(userId, ip);
  const now = Date.now();

  const next = { ...prev };

  if (payload.lastQuery) {
    const arr = Array.isArray(prev.lastQueries) ? [...prev.lastQueries] : [];
    const cleanQ = clampText(payload.lastQuery, 200); // tek query için ekstra limit
    if (cleanQ) {
      arr.push(cleanQ);
      while (arr.length > 20) arr.shift();
      next.lastQueries = arr;
    }
  }

  if (payload.preferredSource) {
    const set = new Set(prev.preferredSources || []);
    const cleanSource = safeString(payload.preferredSource);
    if (cleanSource) set.add(cleanSource);
    next.preferredSources = [...set].slice(0, 20);
  }

  if (payload.lastRegion) {
    next.lastRegion = safeString(payload.lastRegion);
  }

  if (payload.lastCity) {
    next.lastCity = safeString(payload.lastCity);
  }

  if (payload.personaHint) {
    next.personaHint = safeString(payload.personaHint);
  }

  next.clicks = Number(prev.clicks || 0);
  if (typeof payload.clicks === "number") {
    next.clicks = payload.clicks;
  }

  next._ts = now;
  memory.set(key, next);
  gcMemory(now);
  return next;
}

// ============================================================================
// INTENT DETECT — S16 (KORUNDU, sadece hijyen)
// ============================================================================

function detectIntent(text, lang = "tr") {
  const raw = safeString(text);
  const low = raw.toLowerCase().trim();
  if (!low) return "mixed";

  // Evidence-first overrides: if we can answer with real-world evidence, treat as info.
  const eType = detectEvidenceType(raw, lang);
  if (eType && eType !== "none") return "info";

  // Product intent should be explicit (price / purchase / marketplace).
  const buyOrMarket =
    /(satın\s*al|sipariş|nereden\s*al|buy|purchase|order|where\s*to\s*buy|acheter|oÃ¹\s*acheter|ĞºÑƒĞ¿Ğ¸Ñ‚ÑŒ|Ğ³Ğ´Ğµ\s*ĞºÑƒĞ¿Ğ¸Ñ‚ÑŒ|Ø§Ø´ØªØ±|Ø´Ø±Ø§Ø¡|Ù…Ù†\s*Ø£ÙŠÙ†)/i.test(low) ||
    /(hepsiburada|trendyol|n11|amazon|akakçe|cimri|epey|booking|expedia)/i.test(low);

  const priceish =
    /(fiyat|kaç\s*para|ne\s*kadar|en\s*uygun|en\s*ucuz|ucuz|ekonomik|uygun\s*fiyat|indirim|kampanya|price|cost|how\s*much|cheapest|discount|deal|prix|combien|moins\s*cher|Ñ†ĞµĞ½Ğ°|ÑĞºĞ¾Ğ»ÑŒĞºĞ¾|Ğ´ĞµÑˆĞµĞ²Ğ»Ğµ|ÑĞºĞ¸Ğ´Ğº|Ø³Ø¹Ø±|ÙƒÙ…|Ø£Ø±Ø®Øµ|Ø®ØµÙ…)/i.test(low);

  const infoish =
    /[?ØŸ]/.test(raw) ||
    /(nedir|ne\s*demek|açıkla|anlat|bilgi|hakkında|tarih|kimdir|nasıl|neden|where|what|who|why|how|explain|information|guide|history|qu['’]est-ce|c['’]est\s*quoi|comment|pourquoi|oÃ¹|quand|expliquer|Ñ‡Ñ‚Ğ¾\s*Ñ‚Ğ°ĞºĞ¾Ğµ|ĞºÑ‚Ğ¾|Ğ³Ğ´Ğµ|ĞºĞ¾Ğ³Ğ´Ğ°|Ğ¿Ğ¾Ñ‡ĞµĞ¼Ñƒ|ĞºĞ°Ğº|Ğ¾Ğ±ÑŠÑÑĞ½Ğ¸|Ù…Ø§|Ù…Ø§Ø°Ø§|Ù…Ù†|Ø£ÙŠÙ†|Ù…ØªÙ‰|Ù„Ù…Ø§Ø°Ø§|ÙƒÙŠÙ|Ø§Ø´Ø±Ø­|Ù…Ø¹Ù„ÙˆÙ…Ø§Øª)/i.test(low);

  const hasProduct = buyOrMarket || priceish;
  const hasInfo = infoish;

  if (hasProduct && !hasInfo) return "product";
  if (hasInfo && !hasProduct) return "info";
  if (hasProduct && hasInfo) return "mixed";
  return "info";
}
// ============================================================================
function detectPersona(text = "", memorySnapshot = {}) {
  const low = safeString(text).toLowerCase();
  const score = { saver: 0, fast: 0, luxury: 0, explorer: 0 };

  const saverWords = ["ucuz", "fiyat", "indirim", "kampanya", "en uygun"];
  const fastWords = ["hemen", "şimdi", "bugün", "acil", "acelem var", "şipariş"];
  const luxuryWords = [
    "en iyi",
    "premium",
    "kaliteli",
    "üst seviye",
    "5 yıldız",
    "lüks",
  ];
  const explorerWords = [
    "başka",
    "alternatif",
    "diğerleri",
    "farklı",
    "çeşit",
  ];

  saverWords.forEach((w) => low.includes(w) && (score.saver += 2));
  fastWords.forEach((w) => low.includes(w) && (score.fast += 2));
  luxuryWords.forEach((w) => low.includes(w) && (score.luxury += 2));
  explorerWords.forEach((w) => low.includes(w) && (score.explorer += 2));

  if (Array.isArray(memorySnapshot.lastQueries)) {
    memorySnapshot.lastQueries.forEach((qRaw) => {
      const q = safeString(qRaw).toLowerCase();
      saverWords.forEach((w) => q.includes(w) && (score.saver += 1));
      luxuryWords.forEach((w) => q.includes(w) && (score.luxury += 1));
      fastWords.forEach((w) => q.includes(w) && (score.fast += 1));
      explorerWords.forEach((w) => q.includes(w) && (score.explorer += 1));
    });
  }

  if (memorySnapshot.personaHint && score[memorySnapshot.personaHint] != null) {
    score[memorySnapshot.personaHint] += 1;
  }

  const sorted = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const best = sorted[0];

  return best && best[1] > 0 ? best[0] : "neutral";
}

// ============================================================================
// VİTRİN KARTLARI — 3 Kart Sistemi (Best / Smart / Others) — KORUNDU
// ============================================================================
function normalizeNumberMaybe(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num : null;
}

function buildVitrineCards(query, rawResults) {
  const result = rawResults || [];
  const isArray = Array.isArray(result);

  if (isArray && result.length === 0) {
    return { best: null, aiSmart: [], others: [] };
  }

  let bestItems = [];
  let smartItems = [];
  let otherItems = [];

  if (!isArray && (result.best || result.smart || result.others)) {
    bestItems = Array.isArray(result.best) ? result.best : [];
    smartItems = Array.isArray(result.smart) ? result.smart : [];
    otherItems = Array.isArray(result.others) ? result.others : [];

    if (otherItems.length === 0 && Array.isArray(result.items)) {
      otherItems = result.items;
    }
  } else if (isArray) {
    const allItems = result.filter(Boolean);

    // S50: score'u varsa, küçük bir normalize ile sıralayalım
    const scored = [...allItems].sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );

    bestItems = scored
      .filter((item) => (item.score || 0) > 0.7)
      .slice(0, 3);

    smartItems = scored
      .filter(
        (item) => (item.score || 0) > 0.5 && (item.score || 0) <= 0.7
      )
      .slice(0, 4);

    otherItems = scored
      .filter((item) => (item.score || 0) <= 0.5)
      .slice(0, 10);
  } else if (result && Array.isArray(result.items)) {
    const allItems = result.items.filter(Boolean);
    bestItems = allItems.slice(0, 1);
    smartItems = allItems.slice(1, 5);
    otherItems = allItems.slice(5, 15);
  }

  const bestCard =
    bestItems.length > 0
      ? {
          slot: "best",
          title: bestItems[0].title || query,
          subtitle: "En uygun & güvenilir seçenek",
          source: bestItems[0].provider || bestItems[0].source || "unknown",
          price: normalizeNumberMaybe(
            bestItems[0].finalPrice ??
              bestItems[0].optimizedPrice ??
              bestItems[0].price
          ),
          currency: bestItems[0].currency || "TRY",
          isAffiliate: !!bestItems[0].isAffiliate,
          url: bestItems[0].url,
          raw: bestItems[0],
          score: bestItems[0].score || 0,
        }
      : null;

  const aiSmartCards = smartItems.map((x, index) => ({
    slot: "smart",
    title: x.title || query,
    subtitle: index === 0 ? "Tamamlayıcı öneriler" : "Alternatif seçenek",
    source: x.provider || x.source || "unknown",
    price: normalizeNumberMaybe(
      x.finalPrice ?? x.optimizedPrice ?? x.price
    ),
    currency: x.currency || "TRY",
    isAffiliate: !!x.isAffiliate,
    url: x.url,
    raw: x,
    score: x.score || 0,
  }));

  const othersCards = otherItems.map((x) => ({
    slot: "others",
    title: x.title || query,
    subtitle: "Diğer satıcılar",
    source: x.provider || x.source || "unknown",
    price: normalizeNumberMaybe(
      x.finalPrice ?? x.optimizedPrice ?? x.price
    ),
    currency: x.currency || "TRY",
    isAffiliate: !!x.isAffiliate,
    url: x.url,
    raw: x,
    score: x.score || 0,
  }));

  return {
    best: bestCard,
    aiSmart: aiSmartCards,
    others: othersCards,
  };
}

// ============================================================================
// LLM YARDIMCI: Timeout + Güvenli Fetch (S16 core + S20 + S50 guard)
// ============================================================================
async function fetchWithTimeout(resource, options = {}) {
  const timeoutMs = Number(options.timeout || 15000);
  const controller = new AbortController();

  // dış signal varsa controller'a bağla
  const extSignal = options.signal;
  if (extSignal) {
    if (extSignal.aborted) controller.abort();
    else extSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { timeout, signal, ...rest } = options;
    const res = await fetch(resource, {
      ...rest,
      signal: controller.signal, // <-- her zaman controller
    });
    return res;
  } catch (err) {
    if (err && (err.name === "AbortError" || String(err).includes("AbortError"))) {
      throw new Error("LLM timeout");
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}



// ============================================================================
// LIVE / RELIABLE INFO: Evidence fetch (FX, weather, travel, POI, recipe, news, wiki) -- S52
//   - Used for chat/info mode to provide source-backed answers
//   - Hard rules: topic-locked, no random drift; graceful fallback
const EVIDENCE_MAX_KEYS = 2500;
const EVIDENCE_GC_THRESHOLD = 3000;

function gcEvidenceCache(now = Date.now()) {
  if (evidenceCache.size <= EVIDENCE_GC_THRESHOLD) return;

  for (const [k, v] of evidenceCache.entries()) {
    if (!v || (v.exp && now > v.exp)) evidenceCache.delete(k);
  }

  if (evidenceCache.size > EVIDENCE_MAX_KEYS) {
    const entries = Array.from(evidenceCache.entries()).sort(
      (a, b) => (a[1]?.exp || 0) - (b[1]?.exp || 0)
    );
    const drop = entries.length - EVIDENCE_MAX_KEYS;
    for (let i = 0; i < drop; i++) evidenceCache.delete(entries[i][0]);
  }
}

const evidenceCache = new Map();
const EVIDENCE_DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

function cacheGet(key) {
  try {
    const v = evidenceCache.get(key);
    if (!v) return null;
    if (v.exp && Date.now() > v.exp) {
      evidenceCache.delete(key);
      return null;
    }
    return v.val;
  } catch {
    return null;
  }
}

function cacheSet(key, val, ttlMs = EVIDENCE_DEFAULT_TTL_MS) {
  try {
    evidenceCache.set(key, {
      val,
      exp: Date.now() + Number(ttlMs || EVIDENCE_DEFAULT_TTL_MS),
    });
    gcEvidenceCache();
  } catch {}
}


function decodeHtmlEntities(str = "") {
  const s = safeString(str);
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html = "") {
  const s = safeString(html);
  return decodeHtmlEntities(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

function compactWords(text, maxWords = 6) {
  const low = safeString(text).toLowerCase();
  const cleaned = low.replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\s-]/g, " ");
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 1);
  return words.slice(0, maxWords).join(" ");
}

function normalizeLang(localeOrLang = "tr") {
  const l = safeString(localeOrLang || "tr").toLowerCase();
    if (l.startsWith("en")) return "en";
  if (l.startsWith("fr")) return "fr";
  if (l.startsWith("ru")) return "ru";
  if (l.startsWith("ar")) return "ar";
  return "tr";
}

function extractLocationCandidate(text = "") {
  const raw = safeString(text);
  if (!raw) return "";

  const patterns = [
    // TR: "Van'da", "Van da"
    /([A-Za-z\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff][\w\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\s-]{1,40})\s*(?:'d[ae]|\s+d[ae])\b/i,
    // EN: in/at/near X
    /\b(?:in|at|near)\s+([A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f\s-]{1,40})\b/i,
    // FR: à/au/aux X
    /\b(?:à|au|aux|dans)\s+([A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f\s-]{1,40})\b/i,
    // RU: Ğ² X
    /\bĞ²\s+([A-Za-z\u00c0-\u024f\u0400-\u04ff][A-Za-z\u00c0-\u024f\u0400-\u04ff\s-]{1,40})\b/i,
    // AR: ÙÙŠ X
    /\bÙÙŠ\s+([\u0600-\u06ff\s-]{2,40})\b/i,
  ];

  for (const p of patterns) {
    const m = raw.match(p);
    if (m && m[1]) return safeString(m[1]);
  }

  return "";
}

function pickCity(text, cityHint) {
  const c = safeString(cityHint);
  if (c) return c;

  const candidate = extractLocationCandidate(text);
  if (candidate) return candidate;

  // fallback: remove obvious intent words, take first 1-3 tokens
  const low = safeString(text).toLowerCase();
  const stop = [
    "hava", "durumu", "forecast", "weather", "temperature",
    "gezilecek", "yerler", "things", "places", "visit",
    "yakınımda", "yakında", "near", "me", "nearby",
    "mekan", "kafe", "restoran", "kahvaltı",
    "tarif", "recipe", "recette",
  ];

  let cleaned = low;
  for (const w of stop) cleaned = cleaned.replace(new RegExp(`\\b${w}\\b`, "gi"), " ");
  cleaned = cleaned.replace(/[^a-z\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\s-]/gi, " ");
  const words = cleaned.split(/\s+/).filter(Boolean);
  return safeString(words.slice(0, 3).join(" "));
}

// Backward-compat shim: some code paths call inferCity(), but the original refactor kept pickCity().
function inferCity(text, lang) {
  // Be conservative: only return a city if the user explicitly mentions one.
  return pickCity(String(text || ""), "");
}


function pickWikiLang(lang) {
  const L = normalizeLang(lang);
  if (L === "tr") return "tr";
  if (L === "en") return "en";
  if (L === "fr") return "fr";
  if (L === "ru") return "ru";
  if (L === "ar") return "ar";
  return "en";
}

function detectEvidenceType(text, lang = "tr") {
  const low = safeString(text).toLowerCase().trim();
  if (!low) return "none";

  const L = normalizeLang(lang);

  // Weather
  if (/(hava\s*durumu|weather|météo|Ğ¿Ğ¾Ğ³Ğ¾Ğ´Ğ°|Ø·Ù‚Ø³)/i.test(low)) return "weather";

  // News
  if (/(haber|news|actualité|Ğ½Ğ¾Ğ²Ğ¾ÑÑ‚|Ø£Ø®Ø¨Ø§Ø±)/i.test(low)) return "news";

  // Travel / itinerary / plan
  if (/(gezi|rota|travel|itinerary|itin(é|e)raire|Ğ¿ÑƒÑ‚ĞµÑˆĞµÑÑ‚Ğ²|Ğ¼Ğ°Ñ€ÑˆÑ€ÑƒÑ‚|Ø³ÙØ±|Ø®Ø·Ø©)/i.test(low))
    return "travel";

  // Recipe
  if (/(tarif|recipe|recette|Ñ€ĞµÑ†ĞµĞ¿Ñ‚|ÙˆØµÙØ©)/i.test(low)) return "recipe";

  // POI / nearby / food / restaurants, etc.
  if (
    /(yakın(ımda)?|nearby|à\s*proximité|Ñ€ÑĞ´Ğ¾Ğ¼|Ø¨Ø§Ù„Ù‚Ø±Ø¨|nerede|where\s*(is|are)|restoran|restaurant|cafe|kafe|otel|hotel|müze|museum|park|kahvaltı)/i.test(
      low
    )
  )
    return "poi";

  // FX vs metals
  const fxish = /(d[öo]viz|kur|usd|eur|gbp|try|exchange\s*rate|taux|ĞºÑƒÑ€Ñ|Ø³Ø¹Ø±\s*Ø§Ù„ØµØ±Ù)/i.test(
    low
  );

  const metalish =
    /(gram\s*alt(ı|i)n|alt(ı|i)n|g[uü]m[uü]ş|gold|silver|xau|xag|platin|platinum|palladyum|palladium|xpt|xpd|ons|ounce|çeyrek|yarım|tam|cumhuriyet|ata)/i.test(
      low
    );

  if (metalish) return "metals";
  if (fxish) return "fx";

  // Firsts (curiosity / trivia)
  if (/(ilk\s*(uçuş|insan|kadın|erkek|robot|uydu)|first\s*(flight|human|woman|man|robot|satellite))/i.test(low))
    return "firsts";

  // Science-ish
  if (/(bilim|science|physics|kimya|chemistry|uzay|space|astronomy|astrofizik|astrophysics|nöro|neuro|yapay\s*zeka|ai|machine\s*learning)/i.test(low))
    return "science";

  // Econ / macro (non-FX, non-metals): GDP, inflation, unemployment etc.
  if (
    /(enflasyon|inflation|gdp|büyüme|growth|işsizlik|unemployment|faiz|interest\s*rate|cpi|ppi|market\s*cap|borsa|index|endeks|tüfe|üfe)/i.test(
      low
    )
  )
    return "econ";

  // Sports results, tables etc.
  if (/(maç|fikstür|puan\s*durumu|league\s*table|standings|score|Ñ€ĞµĞ·ÑƒĞ»ÑŒÑ‚Ğ°Ñ‚|Ø§Ù„Ù†ØªÙŠØ¬Ø©)/i.test(low))
    return "sports";

  // Scholar-style request
  if (/(makale|paper|journal|doi|arxiv|pubmed|akademik|scholar)/i.test(low))
    return "scholar";

  // Fact / quick lookup
  if (/(nüfus|population|alanı|area|başkent|capital|yükseklik|elevation|kuruluş|founded|kurucu)/i.test(low))
    return "fact";

  // Wiki-ish (only if question looks like it)
  const wikiish =
    /[?ØŸ]/.test(text) ||
    /(nedir|ne\s*demek|kimdir|hakkında|tarih(çe|i)?|nerede|nasıl|neden|what\s*is|who\s*is|where|when|why|how|explain|define|definition|guide|history|qu['’]est-ce|c['’]est\s*quoi|comment|pourquoi|oÃ¹|quand|Ñ‡Ñ‚Ğ¾\s*Ñ‚Ğ°ĞºĞ¾Ğµ|ĞºÑ‚Ğ¾|Ğ³Ğ´Ğµ|ĞºĞ¾Ğ³Ğ´Ğ°|Ğ¿Ğ¾Ñ‡ĞµĞ¼Ñƒ|ĞºĞ°Ğº|Ù…Ø§|Ù…Ø§Ø°Ø§|Ù…Ù†|Ø£ÙŠÙ†|Ù…ØªÙ‰|Ù„Ù…Ø§Ø°Ø§|ÙƒÙŠÙ)/i.test(
      low
    );

  if (wikiish) return "wiki";
  return "none";
}


async function fetchJsonCached(url, ttlMs = EVIDENCE_DEFAULT_TTL_MS) {
  const key = `json:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetchWithTimeout(url, {
    method: "GET",
    timeout: 9000,
    headers: {
      "User-Agent": "FindAllEasy-SonoAI/1.0",
      Accept: "application/json",
    },
  });
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (data) cacheSet(key, data, ttlMs);
  return data;
}

async function fetchTextCached(url, ttlMs = EVIDENCE_DEFAULT_TTL_MS) {
  const key = `text:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetchWithTimeout(url, {
    method: "GET",
    timeout: 9000,
    headers: {
      "User-Agent": "FindAllEasy-SonoAI/1.0",
      Accept: "application/xml,text/xml,text/plain,*/*",
    },
  });
  if (!res || !res.ok) return null;
  const txt = await res.text().catch(() => "");
  if (txt) cacheSet(key, txt, ttlMs);
  return txt || null;
}

function scoreCandidate(query, title, snippet = "") {
  const q = safeString(query).toLowerCase();
  const t = safeString(title).toLowerCase();
  const s = safeString(stripTags(snippet)).toLowerCase();
  const qWords = q.split(/\s+/).filter(Boolean).slice(0, 8);
  let score = 0;
  for (const w of qWords) {
    if (w.length < 2) continue;
    if (t.includes(w)) score += 3;
    if (s.includes(w)) score += 1;
  }
  // exact title match boost
  if (t === q) score += 6;
  return score;
}

function weatherCodeToText(code, lang) {
  const L = normalizeLang(lang);
  const c = Number(code);
  const tr = {
    clear: "A\u00e7\u0131k",
    partly: "Par\u00e7al\u0131 bulutlu",
    overcast: "Bulutlu",
    fog: "Sisli",
    drizzle: "\u00c7iseleme",
    rain: "Ya\u011fmurlu",
    snow: "Karla kar\u0131\u015f\u0131k / Kar",
    showers: "Sa\u011fanak",
    thunder: "G\u00f6k g\u00fcr\u00fclt\u00fcl\u00fc f\u0131rt\u0131na",
  };
  const en = {
    clear: "Clear",
    partly: "Partly cloudy",
    overcast: "Overcast",
    fog: "Fog",
    drizzle: "Drizzle",
    rain: "Rain",
    snow: "Snow",
    showers: "Showers",
    thunder: "Thunderstorm",
  };
  const fr = {
    clear: "D\u00e9gag\u00e9",
    partly: "Partiellement nuageux",
    overcast: "Couvert",
    fog: "Brouillard",
    drizzle: "Bruine",
    rain: "Pluie",
    snow: "Neige",
    showers: "Averses",
    thunder: "Orage",
  };
  const ru = {
    clear: "\u042f\u0441\u043d\u043e",
    partly: "\u041f\u0435\u0440\u0435\u043c\u0435\u043d\u043d\u0430\u044f \u043e\u0431\u043b\u0430\u0447\u043d\u043e\u0441\u0442\u044c",
    overcast: "\u041f\u0430\u0441\u043c\u0443\u0440\u043d\u043e",
    fog: "\u0422\u0443\u043c\u0430\u043d",
    drizzle: "\u041c\u043e\u0440\u043e\u0441\u044c",
    rain: "\u0414\u043e\u0436\u0434\u044c",
    snow: "\u0421\u043d\u0435\u0433",
    showers: "\u041b\u0438\u0432\u043d\u0438",
    thunder: "\u0413\u0440\u043e\u0437\u0430",
  };
  const ar = {
    clear: "\u0635\u0627\u0641\u064a",
    partly: "\u063a\u0627\u0626\u0645 \u062c\u0632\u0626\u064a\u064b\u0627",
    overcast: "\u063a\u0627\u0626\u0645",
    fog: "\u0636\u0628\u0627\u0628",
    drizzle: "\u0631\u0630\u0627\u0630",
    rain: "\u0645\u0637\u0631",
    snow: "\u062b\u0644\u062c",
    showers: "\u0632\u062e\u0627\u062a",
    thunder: "\u0639\u0627\u0635\u0641\u0629 \u0631\u0639\u062f\u064a\u0629",
  };
  const dict = { tr, en, fr, ru, ar }[L] || tr;

  if (c == 0) return dict.clear;
  if (c in {1:1,2:1,3:1}) return c === 3 ? dict.overcast : dict.partly;
  if (c in {45:1,48:1}) return dict.fog;
  if (c in {51:1,53:1,55:1,56:1,57:1}) return dict.drizzle;
  if (c in {61:1,63:1,65:1,66:1,67:1}) return dict.rain;
  if (c in {71:1,73:1,75:1,77:1,85:1,86:1}) return dict.snow;
  if (c in {80:1,81:1,82:1}) return dict.showers;
  if (c in {95:1,96:1,99:1}) return dict.thunder;
  return dict.overcast;
}

function buildEvidenceAnswer(e, lang) {
  const L = normalizeLang(lang);
  const tMap = {
    tr: {
      fx: "G\u00fcncel d\u00f6viz kurlar\u0131:",
      weather: "Hava durumu:",
      news: "G\u00fcncel haber ba\u015fl\u0131klar\u0131:",
      wiki: "K\u0131sa bilgi:",
      travel: "Gezi \u00f6nerileri:",
      poi: "Yak\u0131ndaki yerler:",
      recipe: "Tarif:",
      science: "Bilim bilgisi:",
      fact: "K\u0131sa ger\u00e7ek:",
      econ: "Ekonomi:",
      metals: "Güncel altın ve değerli maden fiyatları:",
      updated: "Güncelleme:",
      buy: "Alış",
      sell: "Satış",
      sports: "Spor:",
      scholar: "Bilimsel kaynaklar:",
      needCity: "Hangi \u015fehir/b\u00f6lge i\u00e7in? (\u00d6rn: Van hava durumu)",
      needCountry: "Hangi \u00fclke i\u00e7in? (\u00d6rn: T\u00fcrkiye enflasyon)",
      chooseOne: "Hangisini kastediyorsun?",
      noAnswer: "Bu konuda g\u00fcvenilir veri bulamad\u0131m. Daha net yazabilir misin?",
      lowConf: "Eminlik d\u00fc\u015f\u00fck (k\u0131s\u0131tl\u0131 kaynak)",
      sources: "Kaynaklar:",
      itinerary: "1 g\u00fcnl\u00fck \u00f6rnek rota",
      see: "G\u00f6r",
      do: "Yap",
      eat: "Yeme-\u0130\u00e7me",
      tips: "\u0130pu\u00e7lar\u0131",
      confidence: "G\u00fcven",
    },
    en: {
      fx: "Latest exchange rates:",
      weather: "Weather:",
      news: "Latest headlines:",
      wiki: "Quick info:",
      travel: "Travel suggestions:",
      poi: "Nearby places:",
      recipe: "Recipe:",
      science: "Science:",
      fact: "Fact:",
      econ: "Economy:",
      metals: "Gold & precious metals (TRY):",
      updated: "Updated:",
      buy: "Buy",
      sell: "Sell",
      sports: "Sports:",
      scholar: "Scholarly sources:",
      needCity: "Which city/area? (e.g., London weather)",
      needCountry: "Which country? (e.g., Turkey inflation)",
      chooseOne: "Which one do you mean?",
      noAnswer: "I couldn't find reliable data for this. Can you be more specific?",
      lowConf: "Low confidence (limited sources)",
      sources: "Sources:",
      itinerary: "Sample 1-day plan",
      see: "See",
      do: "Do",
      eat: "Eat & Drink",
      tips: "Tips",
      confidence: "Confidence",
    },
    fr: {
      fx: "Taux de change r\u00e9cents :",
      weather: "M\u00e9t\u00e9o :",
      news: "Derniers titres :",
      wiki: "Info rapide :",
      travel: "Suggestions de voyage :",
      poi: "Lieux \u00e0 proximit\u00e9 :",
      recipe: "Recette :",
      science: "Science :",
      fact: "Fait :",
      econ: "\u00c9conomie :",
      metals: "Or et m\u00e9taux pr\u00e9cieux :",
      updated: "Mise \u00e0 jour :",
      buy: "Achat",
      sell: "Vente",
      sports: "Sport :",
      scholar: "Sources scientifiques :",
      needCity: "Quelle ville / r\u00e9gion ? (ex. Paris m\u00e9t\u00e9o)",
      needCountry: "Quel pays ? (ex. Turquie inflation)",
      chooseOne: "Lequel voulez-vous dire ?",
      noAnswer: "Je n'ai pas trouv\u00e9 de donn\u00e9es fiables. Pouvez-vous pr\u00e9ciser ?",
      lowConf: "Confiance faible (sources limit\u00e9es)",
      sources: "Sources :",
      itinerary: "Exemple de plan sur 1 jour",
      see: "\u00c0 voir",
      do: "\u00c0 faire",
      eat: "Manger & Boire",
      tips: "Conseils",
      confidence: "Confiance",
    },
    ru: {
      fx: "\u0410\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u044b\u0435 \u043a\u0443\u0440\u0441\u044b \u0432\u0430\u043b\u044e\u0442:",
      weather: "\u041f\u043e\u0433\u043e\u0434\u0430:",
      news: "\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0435 \u043d\u043e\u0432\u043e\u0441\u0442\u0438:",
      wiki: "\u041a\u0440\u0430\u0442\u043a\u043e:",
      travel: "\u0421\u043e\u0432\u0435\u0442\u044b \u0434\u043b\u044f \u043f\u043e\u0435\u0437\u0434\u043a\u0438:",
      poi: "\u0420\u044f\u0434\u043e\u043c \u0441 \u0432\u0430\u043c\u0438:",
      recipe: "\u0420\u0435\u0446\u0435\u043f\u0442:",
      science: "\u041d\u0430\u0443\u043a\u0430:",
      fact: "\u0424\u0430\u043a\u0442:",
      econ: "\u042d\u043a\u043e\u043d\u043e\u043c\u0438\u043a\u0430:",
      metals: "\u0417\u043e\u043b\u043e\u0442\u043e \u0438 \u0434\u0440\u0430\u0433\u043e\u0446\u0435\u043d\u043d\u044b\u0435 \u043c\u0435\u0442\u0430\u043b\u043b\u044b:",
      updated: "\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e:",
      buy: "\u041f\u043e\u043a\u0443\u043f\u043a\u0430",
      sell: "\u041f\u0440\u043e\u0434\u0430\u0436\u0430",
      sports: "\u0421\u043f\u043e\u0440\u0442:",
      scholar: "\u041d\u0430\u0443\u0447\u043d\u044b\u0435 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438:",
      needCity: "\u041a\u0430\u043a\u043e\u0439 \u0433\u043e\u0440\u043e\u0434/\u0440\u0430\u0439\u043e\u043d? (\u043d\u0430\u043f\u0440\u0438\u043c\u0435\u0440, \u041c\u043e\u0441\u043a\u0432\u0430 \u043f\u043e\u0433\u043e\u0434\u0430)",
      needCountry: "\u0414\u043b\u044f \u043a\u0430\u043a\u043e\u0439 \u0441\u0442\u0440\u0430\u043d\u044b? (\u043d\u0430\u043f\u0440\u0438\u043c\u0435\u0440, \u0422\u0443\u0440\u0446\u0438\u044f \u0438\u043d\u0444\u043b\u044f\u0446\u0438\u044f)",
      chooseOne: "\u0427\u0442\u043e \u0438\u043c\u0435\u043d\u043d\u043e \u0432\u044b \u0438\u043c\u0435\u0435\u0442\u0435 \u0432 \u0432\u0438\u0434\u0443?",
      noAnswer: "\u042f \u043d\u0435 \u043d\u0430\u0448\u0451\u043b \u043d\u0430\u0434\u0451\u0436\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445. \u041c\u043e\u0436\u0435\u0442\u0435 \u0443\u0442\u043e\u0447\u043d\u0438\u0442\u044c \u0437\u0430\u043f\u0440\u043e\u0441?",
      lowConf: "\u041d\u0438\u0437\u043a\u0430\u044f \u0443\u0432\u0435\u0440\u0435\u043d\u043d\u043e\u0441\u0442\u044c (\u043c\u0430\u043b\u043e \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u043e\u0432)",
      sources: "\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438:",
      itinerary: "\u041f\u0440\u0438\u043c\u0435\u0440 \u043f\u043b\u0430\u043d\u0430 \u043d\u0430 1 \u0434\u0435\u043d\u044c",
      see: "\u0421\u043c\u043e\u0442\u0440\u0435\u0442\u044c",
      do: "\u0417\u0430\u043d\u044f\u0442\u0438\u044f",
      eat: "\u0415\u0434\u0430 \u0438 \u043d\u0430\u043f\u0438\u0442\u043a\u0438",
      tips: "\u0421\u043e\u0432\u0435\u0442\u044b",
      confidence: "\u0423\u0432\u0435\u0440\u0435\u043d\u043d\u043e\u0441\u0442\u044c",
    },
    ar: {
      fx: "\u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u0635\u0631\u0641 \u0627\u0644\u062d\u0627\u0644\u064a\u0629:",
      weather: "\u0627\u0644\u0637\u0642\u0633:",
      news: "\u0623\u062d\u062f\u062b \u0627\u0644\u0639\u0646\u0627\u0648\u064a\u0646:",
      wiki: "\u0645\u0639\u0644\u0648\u0645\u0629 \u0633\u0631\u064a\u0639\u0629:",
      travel: "\u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a \u0633\u0641\u0631:",
      poi: "\u0623\u0645\u0627\u0643\u0646 \u0642\u0631\u064a\u0628\u0629:",
      recipe: "\u0648\u0635\u0641\u0629:",
      science: "\u0645\u0639\u0644\u0648\u0645\u0629 \u0639\u0644\u0645\u064a\u0629:",
      fact: "\u062d\u0642\u064a\u0642\u0629:",
      econ: "\u0627\u0642\u062a\u0635\u0627\u062f:",
      metals: "\u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u0630\u0647\u0628 \u0648\u0627\u0644\u0645\u0639\u0627\u062f\u0646:",
      updated: "\u062a\u062d\u062f\u064a\u062b:",
      buy: "\u0634\u0631\u0627\u0621",
      sell: "\u0628\u064a\u0639",
      sports: "\u0631\u064a\u0627\u0636\u0629:",
      scholar: "\u0645\u0635\u0627\u062f\u0631 \u0639\u0644\u0645\u064a\u0629:",
      needCity: "\u0623\u064a \u0645\u062f\u064a\u0646\u0629/\u0645\u0646\u0637\u0642\u0629\u061f (\u0645\u062b\u0627\u0644: \u0637\u0642\u0633 \u0625\u0633\u0637\u0646\u0628\u0648\u0644)",
      needCountry: "\u0644\u0623\u064a \u062f\u0648\u0644\u0629\u061f (\u0645\u062b\u0627\u0644: \u062a\u0631\u0643\u064a\u0627 \u062a\u0636\u062e\u0645)",
      chooseOne: "\u0623\u064a \u0648\u0627\u062d\u062f \u062a\u0642\u0635\u062f\u061f",
      noAnswer: "\u0644\u0645 \u0623\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a \u0645\u0648\u062b\u0648\u0642\u0629. \u0647\u0644 \u064a\u0645\u0643\u0646\u0643 \u062a\u0648\u0636\u064a\u062d \u0627\u0644\u0633\u0624\u0627\u0644\u061f",
      lowConf: "\u062b\u0642\u0629 \u0645\u0646\u062e\u0641\u0636\u0629 (\u0645\u0635\u0627\u062f\u0631 \u0645\u062d\u062f\u0648\u062f\u0629)",
      sources: "\u0627\u0644\u0645\u0635\u0627\u062f\u0631:",
      itinerary: "\u062e\u0637\u0629 \u0645\u0642\u062a\u0631\u062d\u0629 \u0644\u064a\u0648\u0645 \u0648\u0627\u062d\u062f",
      see: "\u0645\u0634\u0627\u0647\u062f\u0629",
      do: "\u0623\u0646\u0634\u0637\u0629",
      eat: "\u0645\u0623\u0643\u0648\u0644\u0627\u062a \u0648\u0645\u0634\u0631\u0648\u0628\u0627\u062a",
      tips: "\u0646\u0635\u0627\u0626\u062d",
      confidence: "\u0627\u0644\u062b\u0642\u0629",
    },
  };
  const T = tMap[L] || tMap.tr;

  if (!e) return null;

  if (e.type === "need_city") {
    return {
      answer: T.needCity,
      suggestions:
        L === "tr"
          ? ["Van hava durumu", "İstanbul gezilecek yerler"]
          : L === "fr"
          ? ["météo Van", "Istanbul à visiter"]
          : L === "ru"
          ? ["Ğ¿Ğ¾Ğ³Ğ¾Ğ´Ğ° Ğ’Ğ°Ğ½", "Ñ‡Ñ‚Ğ¾ Ğ¿Ğ¾ÑĞ¼Ğ¾Ñ‚Ñ€ĞµÑ‚ÑŒ Ğ² Ğ¡Ñ‚Ğ°Ğ¼Ğ±ÑƒĞ»Ğµ"]
          : L === "ar"
          ? ["Ø·Ù‚Ø³ ÙØ§Ù†", "Ø£Ù…Ø§ÙƒÙ† Ù„Ù„Ø²ÙŠØ§Ø±Ø© ÙÙŠ Ø¥Ø³Ø·Ù†Ø¨ÙˆÙ„"]
          : ["London weather", "Paris things to do"],
      sources: [],
      trustScore: 40,
    };
  }
  

  // --- S52 HOTFIX: prevent "ReferenceError: trust is not defined"
  // Not: trustScore hic tanimli olmasa bile typeof guvenli.
  // e parametresi evidence objesidir.
  // trustScore sadece evidence objesinden gelsin. Başka yerden "hayalet değişken" istemiyorum.
const trust = (() => {
  const n = Number(e?.trustScore);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
})();

  const lowNote = trust != null && trust < 55 ? `\n(${T.lowConf})` : "";

  // Clarify / Disambiguation / No-answer (avoid confident nonsense)
  if (e.type === "disambiguation") {
    const opts = Array.isArray(e.options) ? e.options.slice(0, 4) : [];
    const lines = opts.map((o, i) => `${i + 1}) ${o.label}${o.desc ? ` — ${o.desc}` : ""}`);
    return {
      answer: `${T.chooseOne}\n${lines.join("\n")}`.trim(),
      suggestions: opts.map((o) => o.label).slice(0, 4),
      sources: e.sources || [],
      trustScore: trust ?? 45,
    };
  }

  if (e.type === "clarify") {
    const kind = safeString(e.kind);
    const prompt = kind === "country"
      ? T.needCountry
      : L === "tr"
      ? "Hangi kişi/ülke/şehir?"
      : L === "fr"
      ? "Quelle personne/pays/ville ?"
      : L === "ru"
      ? "ĞšĞ°ĞºĞ¾Ğ³Ğ¾ Ñ‡ĞµĞ»Ğ¾Ğ²ĞµĞºĞ°/ÑÑ‚Ñ€Ğ°Ğ½Ñƒ/Ğ³Ğ¾Ñ€Ğ¾Ğ´?"
      : L === "ar"
      ? "Ø£ÙŠ Ø´Ø®Øµ/Ø¯ÙˆÙ„Ø©/Ù…Ø¯ÙŠÙ†Ø©ØŸ"
      : "Which person/country/city?";

    const sugg = kind === "country"
      ? (L === "tr"
          ? ["Türkiye", "Almanya", "ABD"]
          : L === "fr"
          ? ["Turquie", "Allemagne", "États-Unis"]
          : L === "ru"
          ? ["Ğ¢ÑƒÑ€Ñ†Ğ¸Ñ", "Ğ“ĞµÑ€Ğ¼Ğ°Ğ½Ğ¸Ñ", "Ğ¡Ğ¨Ğ"]
          : L === "ar"
          ? ["ØªØ±ÙƒÙŠØ§", "Ø£Ù„Ù…Ø§Ù†ÙŠØ§", "Ø§Ù„ÙˆÙ„Ø§ÙŠØ§Øª Ø§Ù„Ù…ØªØ­Ø¯Ø©"]
          : ["Turkey", "Germany", "USA"])
      : (L === "tr"
          ? ["Türkiye", "İstanbul", "Albert Einstein"]
          : L === "fr"
          ? ["Turquie", "Istanbul", "Albert Einstein"]
          : L === "ru"
          ? ["Ğ¢ÑƒÑ€Ñ†Ğ¸Ñ", "Ğ¡Ñ‚Ğ°Ğ¼Ğ±ÑƒĞ»", "ĞĞ»ÑŒĞ±ĞµÑ€Ñ‚ Ğ­Ğ¹Ğ½ÑˆÑ‚ĞµĞ¹Ğ½"]
          : L === "ar"
          ? ["ØªØ±ÙƒÙŠØ§", "Ø¥Ø³Ø·Ù†Ø¨ÙˆÙ„", "Ø£Ù„Ø¨Ø±Øª Ø£ÙŠÙ†Ø´ØªØ§ÙŠÙ†"]
          : ["Turkey", "Istanbul", "Albert Einstein"]);
    return {
      answer: prompt,
      suggestions: sugg,
      sources: [],
      trustScore: trust ?? 40,
    };
  }

  if (e.type === "no_answer") {
    return {
      answer: `${T.noAnswer}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Daha net yaz", "Kaynak isteyen soru"]
          : L === "fr"
          ? ["Sois plus précis", "Ajoute du contexte"]
          : L === "ru"
          ? ["Ğ¡Ñ„Ğ¾Ñ€Ğ¼ÑƒĞ»Ğ¸Ñ€ÑƒĞ¹ Ñ‚Ğ¾Ñ‡Ğ½ĞµĞµ", "Ğ”Ğ¾Ğ±Ğ°Ğ²ÑŒ ĞºĞ¾Ğ½Ñ‚ĞµĞºÑÑ‚"]
          : L === "ar"
          ? ["Ø§ÙƒØªØ¨ Ø¨Ø´ÙƒÙ„ Ø£ÙˆØ¶Ø­", "Ø£Ø¶Ù Ø³ÙŠØ§Ù‚Ù‹Ø§"]
          : ["Be more specific", "Add context"],
      sources: e.sources || [],
      trustScore: trust ?? 40,
    };
  }


  if (e.type === "firsts") {
    const scope = safeString(e.scope || "");
    const mode = safeString(e.mode || "list");
    const title = safeString(e.title || "");
    const srcs = Array.isArray(e.sources) ? e.sources : [];
    const sugg = Array.isArray(e.suggestions) ? e.suggestions : [];

    if (mode === "menu") {
      const cats = Array.isArray(e.categories) ? e.categories.slice(0, 24) : [];
      const lines = cats.map((c, i) => `${i + 1}) ${safeString(c.title)}`).filter(Boolean);
      const head = L === "tr"
        ? `${scope ? scope + " — " : ""}İlkler (kategori seç):`
        : `${scope ? scope + " — " : ""}Firsts (pick a category):`;
      return {
        answer: `${head}\n${lines.join("\n")}`.trim(),

        suggestions: cats.map((c) => safeString(c.suggestion)).filter(Boolean).slice(0, 4),
        sources: srcs,
        trustScore: trust ?? 65,
      };
    }

    if (mode === "single") {
      const ans = safeString(e.answer) || safeString(e.extract) || "";
     const head = title ? `${title}:\n` : "";

      return {
        answer: `${head}${ans}${lowNote}`.trim(),
        suggestions: sugg.slice(0, 4),
        sources: srcs,
        trustScore: trust ?? 70,
      };
    }

    // mode === "list"
    const items = Array.isArray(e.items) ? e.items.slice(0, 10) : [];
    const top = `${scope ? scope + " — " : ""}${title ? title : (L === "tr" ? "İlkler" : "Firsts")}:`;
   const body = items.map((x) => `• ${safeString(x)}`).filter(Boolean).join("\n");

    return {
      answer: `${top}
${body}${lowNote}`.trim(),
      suggestions: sugg.slice(0, 4),
      sources: srcs,
      trustScore: trust ?? 68,
    };
  }

  if (e.type === "fact") {
    const ent = e.entity?.label || "";
    const prop = e.property?.label || "";
    const val = e.value || "";
    return {
      answer: `${T.fact} ${ent}\n${prop}: ${val}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? [`${ent} nüfus`, `${ent} para birimi`, `${ent} resmi dil`]
          : L === "fr"
          ? [`population ${ent}`, `monnaie ${ent}`, `langue officielle ${ent}`]
          : L === "ru"
          ? [`Ğ½Ğ°ÑĞµĞ»ĞµĞ½Ğ¸Ğµ ${ent}`, `Ğ²Ğ°Ğ»ÑÑ‚Ğ° ${ent}`, `Ğ¾Ñ„Ğ¸Ñ†Ğ¸Ğ°Ğ»ÑŒĞ½Ñ‹Ğ¹ ÑĞ·Ñ‹Ğº ${ent}`]
          : L === "ar"
          ? [`Ø¹Ø¯Ø¯ Ø³ÙƒØ§Ù† ${ent}`, `Ø¹Ù…Ù„Ø© ${ent}`, `Ø§Ù„Ù„ØºØ© Ø§Ù„Ø±Ø³Ù…ÙŠØ© ${ent}`]
          : [`${ent} population`, `${ent} currency`, `${ent} official language`],
      sources: e.sources || [],
      trustScore: trust ?? 88,
    };
  }

  if (e.type === "econ") {
    // Metals / spot prices
    if (e.kind === "metals") {
      const asOf = safeString(e.asOf || "");
      const head =
        L === "tr"
          ? `Emtia (spot) — ${safeString(e.metal)}`
          : L === "fr"
          ? `Matières premières (spot) — ${safeString(e.metal)}`
          : L === "ru"
          ? `Ğ¡Ñ‹Ñ€ÑŒÑ‘ (spot) — ${safeString(e.metal)}`
          : L === "ar"
          ? `Ø³Ù„Ø¹ (ÙÙˆØ±ÙŠ) — ${safeString(e.metal)}`
          : `Commodities (spot) — ${safeString(e.metal)}`;

      const lines = [];
      if (e.ounce?.text) lines.push(`1 oz: ${safeString(e.ounce.text)}${asOf ? ` (${asOf})` : ""}`);
      if (e.gram?.text) lines.push(`1 g: ${safeString(e.gram.text)}`);
      if (e.note) lines.push(`
${safeString(e.note)}`);

      return {
        answer: `${T.econ}
${head}
${lines.join("\n")}${lowNote}`.trim(),
        suggestions:
          L === "tr"
            ? ["Gram altın fiyatı", "Gümüş fiyatı", "USD/TRY"]
            : L === "fr"
            ? ["prix de l'or au gramme", "prix de l'argent", "USD vers TRY"]
            : L === "ru"
            ? ["Ñ†ĞµĞ½Ğ° Ğ·Ğ¾Ğ»Ğ¾Ñ‚Ğ° Ğ·Ğ° Ğ³Ñ€Ğ°Ğ¼Ğ¼", "Ñ†ĞµĞ½Ğ° ÑĞµÑ€ĞµĞ±Ñ€Ğ°", "USD Ğº TRY"]
            : L === "ar"
            ? ["Ø³Ø¹Ø± Ø§Ù„Ø°Ù‡Ø¨ Ù„Ù„ØºØ±Ø§Ù…", "Ø³Ø¹Ø± Ø§Ù„ÙØ¶Ø©", "USD Ø¥Ù„Ù‰ TRY"]
            : ["gold price per gram", "silver price", "USD to TRY"],
        sources: e.sources || [],
        trustScore: trust ?? 84,
      };
    }

    const line = `${e.country || ""} — ${e.indicator || ""}: ${e.value || ""}${e.year ? ` (${e.year})` : ""}`.trim();
    const country = safeString(e.country || (L === "tr" ? "Türkiye" : "Turkey"));
    return {
      answer: `${T.econ}
${line}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? [`${country} enflasyon`, `${country} işsizlik`, `${country} gsyih`]
          : L === "fr"
          ? [`inflation ${country}`, `chômage ${country}`, `PIB ${country}`]
          : L === "ru"
          ? [`Ğ¸Ğ½Ñ„Ğ»ÑÑ†Ğ¸Ñ ${country}`, `Ğ±ĞµĞ·Ñ€Ğ°Ğ±Ğ¾Ñ‚Ğ¸Ñ†Ğ° ${country}`, `Ğ’Ğ’ĞŸ ${country}`]
          : L === "ar"
          ? [`ØªØ¶Ø®Ù… ${country}`, `Ø¨Ø·Ø§Ù„Ø© ${country}`, `Ø§Ù„Ù†Ø§ØªØ¬ Ø§Ù„Ù…Ø­Ù„ÙŠ ${country}`]
          : [`${country} inflation`, `${country} unemployment`, `${country} gdp`],
      sources: e.sources || [],
      trustScore: trust ?? 78,
    };
  }

  if (e.type === "sports") {
    const lines = (e.items || []).slice(0, 5).map((x, i) => `${i + 1}) ${x.title}\n${x.url}`);
    return {
      answer: `${T.sports}\n${lines.join("\n\n")}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Galatasaray haber", "Fenerbahçe haber", "Süper Lig puan durumu"]
          : L === "fr"
          ? ["actu Ligue 1", "Ligue des champions", "actu NBA"]
          : L === "ru"
          ? ["Ğ½Ğ¾Ğ²Ğ¾ÑÑ‚Ğ¸ Ñ„ÑƒÑ‚Ğ±Ğ¾Ğ»Ğ°", "Ğ›Ğ¸Ğ³Ğ° Ñ‡ĞµĞ¼Ğ¿Ğ¸Ğ¾Ğ½Ğ¾Ğ²", "Ğ½Ğ¾Ğ²Ğ¾ÑÑ‚Ğ¸ ĞĞ‘Ğ"]
          : L === "ar"
          ? ["Ø£Ø®Ø¨Ø§Ø± ÙƒØ±Ø© Ø§Ù„Ù‚Ø¯Ù…", "Ø¯ÙˆØ±ÙŠ Ø£Ø¨Ø·Ø§Ù„ Ø£ÙˆØ±ÙˆØ¨Ø§", "Ø£Ø®Ø¨Ø§Ø± NBA"]
          : ["Premier League news", "UEFA Champions League", "NBA news"],
      sources: e.sources || [],
      trustScore: trust ?? 68,
    };
  }

  if (e.type === "scholar") {
    const lines = (e.items || []).slice(0, 5).map((x, i) => `${i + 1}) ${x.title}${x.year ? ` (${x.year})` : ""}${x.source ? ` — ${x.source}` : ""}\n${x.url}`);
    return {
      answer: `${T.scholar}\n${lines.join("\n\n")}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Bu konuda meta-analiz", "Randomized trial", "Yan etkiler"]
          : L === "fr"
          ? ["méta-analyse", "essai randomisé", "effets secondaires"]
          : L === "ru"
          ? ["Ğ¼ĞµÑ‚Ğ°-Ğ°Ğ½Ğ°Ğ»Ğ¸Ğ·", "Ñ€Ğ°Ğ½Ğ´Ğ¾Ğ¼Ğ¸Ğ·Ğ¸Ñ€Ğ¾Ğ²Ğ°Ğ½Ğ½Ğ¾Ğµ Ğ¸ÑÑĞ»ĞµĞ´Ğ¾Ğ²Ğ°Ğ½Ğ¸Ğµ", "Ğ¿Ğ¾Ğ±Ğ¾Ñ‡Ğ½Ñ‹Ğµ ÑÑ„Ñ„ĞµĞºÑ‚Ñ‹"]
          : L === "ar"
          ? ["ØªØ­Ù„ÙŠÙ„ ØªÙ„ÙˆÙŠ", "ØªØ¬Ø±Ø¨Ø© Ø¹Ø´ÙˆØ§Ø¦ÙŠØ©", "Ø¢Ø«Ø§Ø± Ø¬Ø§Ù†Ø¨ÙŠØ©"]
          : ["meta analysis", "randomized trial", "side effects"],
      sources: e.sources || [],
      trustScore: trust ?? 72,
    };
  }

  if (e.type === "fx") {
    const lines = [];
    for (const row of e.rates || []) lines.push(`${row.pair}: ${row.value}`);
    return {
      answer: `${T.fx}\n${lines.join("\n")}`.trim(),
      suggestions:
        L === "tr"
          ? ["USD/TRY", "EUR/TRY", "GBP/TRY"]
          : L === "fr"
          ? ["USD vers TRY", "EUR vers TRY", "GBP vers TRY"]
          : L === "ru"
          ? ["USD Ğº TRY", "EUR Ğº TRY", "GBP Ğº TRY"]
          : L === "ar"
          ? ["USD Ø¥Ù„Ù‰ TRY", "EUR Ø¥Ù„Ù‰ TRY", "GBP Ø¥Ù„Ù‰ TRY"]
          : ["USD to TRY", "EUR to TRY", "GBP to TRY"],
      sources: e.sources || [],
      trustScore: trust ?? 80,
    };
  }

  
  if (e.type === "metals") {
  const items = Array.isArray(e.items) ? e.items : [];
  const updatedAt = String(e.updatedAt || "").trim();

  const lines = items
    .slice(0, 10)
    .map((it) => {
      const buy = it.buyText || (typeof it.buy === "number" ? String(it.buy) : "");
      const sell = it.sellText || (typeof it.sell === "number" ? String(it.sell) : "");
      const ccy = String(it.ccy || "").trim();
      const label = String(it.name || "").trim() || "—";
      if (buy && sell) return `• ${label}: ${T.buy || "Buy"} ${buy} / ${T.sell || "Sell"} ${sell}${ccy ? " " + ccy : ""}`;
      if (sell) return `• ${label}: ${sell}${ccy ? " " + ccy : ""}`;
      if (buy) return `• ${label}: ${buy}${ccy ? " " + ccy : ""}`;
      return `• ${label}`;
    })
    .join("\n");

  const head = T.metals || (L === "tr" ? "Güncel altın/metal fiyatları:" : "Live precious metals prices:");
  const upd = updatedAt ? `\n${T.updated || "Updated:"} ${updatedAt}` : "";

  return {
    answer: `${head}${upd}\n${lines}${lowNote}`.trim(),
    suggestions: Array.isArray(e.suggestions) ? e.suggestions.slice(0, 4) : [],
    sources: Array.isArray(e.sources) ? e.sources.slice(0, 5) : [],
    trustScore: trust ?? 70, // <-- UYUM
  };
}


if (e.type === "weather") {
    const lines = [];
    if (e.now) lines.push(e.now);
    if (Array.isArray(e.forecast) && e.forecast.length) {
      lines.push("\n" + (L === "tr" ? "5 g\u00fcnl\u00fck tahmin:" : L === "fr" ? "Pr\u00e9visions 5 jours :" : L === "ru" ? "\u041f\u0440\u043e\u0433\u043d\u043e\u0437 \u043d\u0430 5 \u0434\u043d\u0435\u0439:" : L === "ar" ? "\u062a\u0648\u0642\u0639\u0627\u062a 5 \u0623\u064a\u0627\u0645:" : "5-day forecast:") );
      for (const f of e.forecast.slice(0, 5)) lines.push(`- ${f}`);
    }
    return {
      answer: `${T.weather} ${e.city}\n${lines.join("\n")}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? [`${e.city} yarın hava`, `${e.city} 5 günlük hava`]
          : L === "fr"
          ? [`météo ${e.city} demain`, `prévisions ${e.city} 5 jours`]
          : L === "ru"
          ? [`Ğ¿Ğ¾Ğ³Ğ¾Ğ´Ğ° ${e.city} Ğ·Ğ°Ğ²Ñ‚Ñ€Ğ°`, `Ğ¿Ñ€Ğ¾Ğ³Ğ½Ğ¾Ğ· ${e.city} Ğ½Ğ° 5 Ğ´Ğ½ĞµĞ¹`]
          : L === "ar"
          ? [`Ø·Ù‚Ø³ ${e.city} ØºØ¯Ù‹Ø§`, `ØªÙˆÙ‚Ø¹Ø§Øª ${e.city} Ù„Ù…Ø¯Ø© 5 Ø£ÙŠØ§Ù…`]
          : [`${e.city} weather tomorrow`, `${e.city} 5 day forecast`],
      sources: e.sources || [],
      trustScore: trust ?? 85,
    };
  }

  if (e.type === "poi") {
    const lines = (e.items || []).slice(0, 10).map((x, i) => `${i + 1}) ${x.name}${x.note ? ` — ${x.note}` : ""}\n${x.url}`);
    return {
      answer: `${T.poi} ${e.city}\n${lines.join("\n\n")}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Yakınımdaki kafe", "Yakınımdaki restoran"]
          : L === "fr"
          ? ["cafés à proximité", "restaurants à proximité"]
          : L === "ru"
          ? ["ĞºĞ°Ñ„Ğµ Ñ€ÑĞ´Ğ¾Ğ¼", "Ñ€ĞµÑÑ‚Ğ¾Ñ€Ğ°Ğ½Ñ‹ Ñ€ÑĞ´Ğ¾Ğ¼"]
          : L === "ar"
          ? ["Ù…Ù‚Ø§Ù‡ÙŠ Ù‚Ø±ÙŠØ¨Ø©", "Ù…Ø·Ø§Ø¹Ù… Ù‚Ø±ÙŠØ¨Ø©"]
          : ["nearby cafes", "nearby restaurants"],
      sources: e.sources || [],
      trustScore: trust ?? 80,
    };
  }

  if (e.type === "travel") {
    const blocks = [];
    if (e.sections) {
      const secOrder = ["see", "do", "eat", "tips"];
      const secLabel = { see: T.see, do: T.do, eat: T.eat, tips: T.tips };
      for (const k of secOrder) {
        const items = (e.sections[k] || []).slice(0, 6);
        if (!items.length) continue;
        blocks.push(`${secLabel[k]}:\n- ${items.join("\n- ")}`);
      }
    }
    if (Array.isArray(e.itinerary) && e.itinerary.length) {
      blocks.push(`${T.itinerary}:\n- ${e.itinerary.join("\n- ")}`);
    }
    const header = `${T.travel} ${e.city}`;
    return {
      answer: `${header}\n\n${blocks.join("\n\n")}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? [`${e.city} gezilecek yerler`, `${e.city} yeme içme`]
          : L === "fr"
          ? [`${e.city} à visiter`, `oÃ¹ manger à ${e.city}`]
          : L === "ru"
          ? [`Ñ‡Ñ‚Ğ¾ Ğ¿Ğ¾ÑĞ¼Ğ¾Ñ‚Ñ€ĞµÑ‚ÑŒ Ğ² ${e.city}`, `Ğ³Ğ´Ğµ Ğ¿Ğ¾ĞµÑÑ‚ÑŒ Ğ² ${e.city}`]
          : L === "ar"
          ? [`Ø£Ù…Ø§ÙƒÙ† Ù„Ù„Ø²ÙŠØ§Ø±Ø© ÙÙŠ ${e.city}`, `Ø£ÙŠÙ† ØªØ£ÙƒÙ„ ÙÙŠ ${e.city}`]
          : [`${e.city} things to do`, `${e.city} where to eat`],
      sources: e.sources || [],
      trustScore: trust ?? 78,
    };
  }

  if (e.type === "recipe") {
    const lines = [];
    if (e.ingredients && e.ingredients.length) {
    }
    const ingLabel = L === "tr" ? "Malzemeler" : L === "fr" ? "Ingr\u00e9dients" : L === "ru" ? "\u0418\u043d\u0433\u0440\u0435\u0434\u0438\u0435\u043d\u0442\u044b" : L === "ar" ? "\u0627\u0644\u0645\u0643\u0648\u0646\u0627\u062a" : "Ingredients";
    const stepsLabel = L === "tr" ? "Yap\u0131l\u0131\u015f" : L === "fr" ? "\u00c9tapes" : L === "ru" ? "\u0428\u0430\u0433\u0438" : L === "ar" ? "\u0627\u0644\u0637\u0631\u064a\u0642\u0629" : "Steps";

    const parts = [];
    if (Array.isArray(e.ingredients) && e.ingredients.length) {
      parts.push(`${ingLabel}:\n- ${e.ingredients.slice(0, 20).join("\n- ")}`);
    }
    if (Array.isArray(e.steps) && e.steps.length) {
      parts.push(`${stepsLabel}:\n- ${e.steps.slice(0, 15).join("\n- ")}`);
    }
    return {
      answer: `${T.recipe} ${e.title}\n\n${parts.join("\n\n")}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Tavuk tarifi", "Tatlı tarifi"]
          : L === "fr"
          ? ["recette de poulet", "recette de dessert"]
          : L === "ru"
          ? ["Ñ€ĞµÑ†ĞµĞ¿Ñ‚ ĞºÑƒÑ€Ğ¸Ñ†Ñ‹", "Ñ€ĞµÑ†ĞµĞ¿Ñ‚ Ğ´ĞµÑĞµÑ€Ñ‚Ğ°"]
          : L === "ar"
          ? ["ÙˆØµÙØ© Ø¯Ø¬Ø§Ø¬", "ÙˆØµÙØ© Ø­Ù„ÙˆÙ‰"]
          : ["chicken recipe", "dessert recipe"],
      sources: e.sources || [],
      trustScore: trust ?? 75,
    };
  }

  if (e.type === "news") {
    const items = (e.items || []).slice(0, 5);
    const lines = items.map((x, i) => `${i + 1}) ${x.title}`);
    return {
      answer: `${T.news}\n${lines.join("\n")}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Son dakika", "Ekonomi haberleri", "Spor haberleri"]
          : L === "fr"
          ? ["dernières infos", "actualités économiques", "actualités sportives"]
          : L === "ru"
          ? ["Ğ¿Ğ¾ÑĞ»ĞµĞ´Ğ½Ğ¸Ğµ Ğ½Ğ¾Ğ²Ğ¾ÑÑ‚Ğ¸", "ÑĞºĞ¾Ğ½Ğ¾Ğ¼Ğ¸Ñ‡ĞµÑĞºĞ¸Ğµ Ğ½Ğ¾Ğ²Ğ¾ÑÑ‚Ğ¸", "ÑĞ¿Ğ¾Ñ€Ñ‚ Ğ½Ğ¾Ğ²Ğ¾ÑÑ‚Ğ¸"]
          : L === "ar"
          ? ["Ø¢Ø®Ø± Ø§Ù„Ø£Ø®Ø¨Ø§Ø±", "Ø£Ø®Ø¨Ø§Ø± Ø§Ù„Ø§Ù‚ØªØµØ§Ø¯", "Ø£Ø®Ø¨Ø§Ø± Ø§Ù„Ø±ÙŠØ§Ø¶Ø©"]
          : ["latest news", "economy news", "sports news"],
      sources: e.sources || [],
      trustScore: trust ?? 70,
    };
  }



  if (e.type === "science") {
    return {
      answer: `${T.science} ${e.title}
${e.extract}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Su kaç derecede kaynar?", "Su kaç derecede donar?"]
          : L === "fr"
          ? ["température d’ébullition de l’eau", "température de congélation de l’eau"]
          : L === "ru"
          ? ["Ñ‚ĞµĞ¼Ğ¿ĞµÑ€Ğ°Ñ‚ÑƒÑ€Ğ° ĞºĞ¸Ğ¿ĞµĞ½Ğ¸Ñ Ğ²Ğ¾Ğ´Ñ‹", "Ñ‚ĞµĞ¼Ğ¿ĞµÑ€Ğ°Ñ‚ÑƒÑ€Ğ° Ğ·Ğ°Ğ¼ĞµÑ€Ğ·Ğ°Ğ½Ğ¸Ñ Ğ²Ğ¾Ğ´Ñ‹"]
          : L === "ar"
          ? ["Ø¯Ø±Ø¬Ø© ØºÙ„ÙŠØ§Ù† Ø§Ù„Ù…Ø§Ø¡", "Ø¯Ø±Ø¬Ø© ØªØ¬Ù…Ø¯ Ø§Ù„Ù…Ø§Ø¡"]
          : ["water boiling point", "water freezing point"],
      sources: e.sources || [],
      trustScore: trust ?? 90,
    };
  }

  // wiki
  if (e.type === "wiki") {
    return {
      answer: `${T.wiki} ${e.title}\n${e.extract}${lowNote}`.trim(),
      suggestions:
        L === "tr"
          ? ["Daha kısa özet", "Örnek ver", "Artısı eksisi"]
          : L === "fr"
          ? ["résumé plus court", "donne un exemple", "avantages / inconvénients"]
          : L === "ru"
          ? ["ĞºĞ¾Ñ€Ğ¾Ñ‡Ğµ", "Ğ¿Ñ€Ğ¸Ğ²ĞµĞ´Ğ¸ Ğ¿Ñ€Ğ¸Ğ¼ĞµÑ€", "Ğ¿Ğ»ÑÑÑ‹ Ğ¸ Ğ¼Ğ¸Ğ½ÑƒÑÑ‹"]
          : L === "ar"
          ? ["Ù…Ù„Ø®Øµ Ø£Ù‚ØµØ±", "Ø£Ø¹Ø·Ù Ù…Ø«Ø§Ù„Ù‹Ø§", "Ø¥ÙŠØ¬Ø§Ø¨ÙŠØ§Øª ÙˆØ³Ù„Ø¨ÙŠØ§Øª"]
          : ["shorter summary", "give an example", "pros and cons"],
      sources: e.sources || [],
      trustScore: trust ?? 65,
    };
  }

  return null;
}

async function getFxEvidence(text, lang) {
  const low = safeString(text).toLowerCase();

  const wantUsd = /(\busd\b|dolar)/i.test(low);
  const wantEur = /(\beur\b|euro)/i.test(low);
  const wantGbp = /(\bgbp\b|sterlin|pound)/i.test(low);

  const pairs = [];
  if (wantUsd) pairs.push({ from: "USD", to: "TRY" });
  if (wantEur) pairs.push({ from: "EUR", to: "TRY" });
  if (wantGbp) pairs.push({ from: "GBP", to: "TRY" });

  if (pairs.length === 0) {
    pairs.push({ from: "USD", to: "TRY" });
    pairs.push({ from: "EUR", to: "TRY" });
  }

  const results = [];
  for (const p of pairs.slice(0, 3)) {
    const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}`;
    const data = await fetchJsonCached(url, 2 * 60 * 1000);
    const rate = data?.rates?.[p.to];
    const date = data?.date || "";
    if (rate) {
      results.push({ pair: `${p.from}/${p.to}`, value: `${Number(rate).toFixed(4)} (${date})` });
    }
  }

  if (!results.length) return null;

  return {
    type: "fx",
    rates: results,
    trustScore: 80,
    sources: [{ title: "Frankfurter (ECB rates)", url: "https://www.frankfurter.app/" }],
  };
}

function parseTRNumber(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  // Example: "3.456,78" or "3,456.78" or "3456.78"
  // Strategy:
  // - remove spaces and currency symbols
  let x = s.replace(/\s+/g, "").replace(/[^\d,.\-]/g, "");
  // If both separators exist, assume the last one is decimal.
  const lastComma = x.lastIndexOf(",");
  const lastDot = x.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // comma decimal, dot thousands
      x = x.replace(/\./g, "").replace(",", ".");
    } else {
      // dot decimal, comma thousands
      x = x.replace(/,/g, "");
    }
  } else if (lastComma >= 0 && lastDot < 0) {
    // comma decimal (TR)
    x = x.replace(/\./g, "").replace(",", ".");
  } else {
    // dot decimal or integer
    x = x.replace(/,/g, "");
  }
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n, lang = "tr", digits = 2) {
  try {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    return n.toLocaleString(lang.startsWith("tr") ? "tr-TR" : "en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } catch {
    return String(n);
  }
}

async function getMetalsEvidence({ text, lang = "tr" }) {
  const L = normalizeLang(lang);
  const q = safeString(text);
  const low = q.toLowerCase();

  const wantGram = /(gram\s*alt(ı|i)n|\bgram\b)/i.test(low);
  const wantQuarter = /(çeyrek|ceyrek|quarter)/i.test(low);
  const wantHalf = /(yarım|yarim|half)/i.test(low);
  const wantFull = /\btam\b/i.test(low);
  const wantCumhuriyet = /(cumhuriyet)/i.test(low);
  const wantAta = /\bata\b/i.test(low);
  const wantSilver = /(gümüş|gumus|silver|xag)/i.test(low);
  const wantOunce = /(ons|ounce|xau)/i.test(low);

  const wantsSpecific =
    wantGram || wantQuarter || wantHalf || wantFull || wantCumhuriyet || wantAta || wantSilver || wantOunce;

  // 1) Try TR market feed (supports gram/coins) — if available.
  try {
    const url = "https://finans.truncgil.com/today.json";
    const j = await fetchJsonCached(url, 120000); // 2 min cache

    const keys = Object.keys(j || {});
    const findKey = (re) =>
      keys.find((k) => re.test(String(k).toLowerCase())) || null;

    const pick = (name, re, ccy = "TRY") => {
      const k = findKey(re);
      if (!k) return null;
      const obj = j[k];
      const buy = parseTRNumber(obj?.["Alış"] ?? obj?.["Alis"] ?? obj?.["Buying"] ?? obj?.["buying"] ?? obj?.["alis"]);
      const sell = parseTRNumber(obj?.["Satış"] ?? obj?.["Satis"] ?? obj?.["Selling"] ?? obj?.["selling"] ?? obj?.["satis"]);
      const chg = String(obj?.["Değişim"] ?? obj?.["Degisim"] ?? obj?.["Change"] ?? obj?.["change"] ?? "").trim();
      if (buy == null && sell == null) return null;
      return { name, buy, sell, ccy, change: chg || null };
    };

    const itemsAll = [
      pick("Gram Altın", /gram\s*alt[ıi]n|gram\s*gold|gram_altin|gr_altin/),
      pick("Çeyrek Altın", /çeyrek\s*alt[ıi]n|ceyrek\s*alt[ıi]n|quarter/),
      pick("Yarım Altın", /yar[ıi]m\s*alt[ıi]n|half/),
      pick("Tam Altın", /\btam\s*alt[ıi]n\b|\bfull\s*gold\b/),
      pick("Cumhuriyet Altını", /cumhuriyet/),
      pick("Ata Altın", /\bata\b/),
      pick("Ons Altın (XAU)", /ons|ounce|xau/ , "USD"),
      pick("Gümüş", /gümüş|gumus|silver|xag/ , "TRY"),
    ].filter(Boolean);

    // Filter if user asked specifically
    let items = itemsAll;
    if (wantsSpecific) {
      items = itemsAll.filter((it) => {
        const n = it.name.toLowerCase();
        if (wantGram && n.includes("gram")) return true;
        if (wantQuarter && n.includes("çeyrek")) return true;
        if (wantHalf && n.includes("yarım")) return true;
        if (wantFull && n.includes("tam")) return true;
        if (wantCumhuriyet && n.includes("cumhuriyet")) return true;
        if (wantAta && n.includes("ata")) return true;
        if (wantSilver && n.includes("gümüş")) return true;
        if (wantOunce && n.includes("ons")) return true;
        return false;
      });
      // If filter killed everything, fall back to all.
      if (!items.length) items = itemsAll;
    }

    const updatedAt = String(j?.Update_Date || j?.update_date || j?.updated || "").trim();

    // Simple suggestions
    const suggestions =
      L === "tr"
        ? ["Gram altın kaç para?", "Çeyrek altın fiyatı", "USD/TRY kuru", "Altın ons fiyatı"]
        : ["Gold price per gram", "Quarter gold coin price", "USD/TRY rate", "Gold ounce price"];

    return {
      type: "metals",
      query: q,
      updatedAt: updatedAt || null,
      items: items.map((it) => ({
        ...it,
        buyText: it.buy != null ? formatNumber(it.buy, L, it.ccy === "USD" ? 2 : 2) : null,
        sellText: it.sell != null ? formatNumber(it.sell, L, it.ccy === "USD" ? 2 : 2) : null,
      })),
      trustScore: 85,
      sources: [
        {
          title: "Truncgil Finans (today.json)",
          url,
        },
      ],
      suggestions,
    };
  } catch {
    // Ignore and fall back to global spot sources below
  }

  // 2) Fallback: global spot (Stooq) + FX (Frankfurter)
  const fetchStooqClose = async (symbol) => {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
    const csv = await fetchTextCached(url, 120000);
    const lines = String(csv || "").trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const cols = lines[1].split(",");
    // header: Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = parseTRNumber(cols?.[6] ?? "");
    const date = String(cols?.[1] ?? "");
    const time = String(cols?.[2] ?? "");
    return { close, date, time, url };
  };

  let usdtry = null;
  try {
    const fx = await fetchJsonCached("https://api.frankfurter.app/latest?from=USD&to=TRY", 120000);
    usdtry = typeof fx?.rates?.TRY === "number" ? fx.rates.TRY : parseTRNumber(fx?.rates?.TRY);
  } catch {}

  const xau = await fetchStooqClose("xauusd");
  const xag = await fetchStooqClose("xagusd");

  const items = [];
  const sources = [];

  if (xau?.close) {
    sources.push({ title: "Stooq XAUUSD", url: xau.url });
    const ounceUsd = xau.close;
    const gramUsd = ounceUsd / 31.1034768;
    const gramTry = usdtry ? gramUsd * usdtry : null;
    items.push({
      name: "Altın Ons (XAUUSD)",
      buy: ounceUsd,
      sell: ounceUsd,
      ccy: "USD",
      change: null,
      buyText: formatNumber(ounceUsd, L, 2),
      sellText: formatNumber(ounceUsd, L, 2),
    });
    if (gramTry) {
      items.push({
        name: "Gram Altın (spot, TRY)",
        buy: gramTry,
        sell: gramTry,
        ccy: "TRY",
        change: null,
        buyText: formatNumber(gramTry, L, 2),
        sellText: formatNumber(gramTry, L, 2),
      });
    }
  }

  if (xag?.close) {
    sources.push({ title: "Stooq XAGUSD", url: xag.url });
    const ounceUsd = xag.close;
    items.push({
      name: "Gümüş Ons (XAGUSD)",
      buy: ounceUsd,
      sell: ounceUsd,
      ccy: "USD",
      change: null,
      buyText: formatNumber(ounceUsd, L, 2),
      sellText: formatNumber(ounceUsd, L, 2),
    });
  }

  if (!items.length) {
    return {
      type: "no_answer",
      query: q,
      trustScore: 35,
      reason: "metals_fetch_failed",
      sources,
      suggestions: [],
    };
  }

  if (usdtry) {
    sources.push({ title: "Frankfurter USD→TRY", url: "https://api.frankfurter.app/latest?from=USD&to=TRY" });
  }

  const updatedAt = xau?.date ? `${xau.date}${xau.time ? " " + xau.time : ""}` : null;

  return {
    type: "metals",
    query: q,
    updatedAt,
    items,
    trustScore: 70,
    sources,
    suggestions: [],
  };
}



async function geocodeCity(city, lang) {
  const name = safeString(city);
  if (!name) return null;
  const L = normalizeLang(lang);
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=${encodeURIComponent(L)}&format=json`;
  const geo = await fetchJsonCached(geoUrl, 60 * 60 * 1000);
  const g = geo?.results?.[0];
  if (!g) return null;
  return {
    name: safeString(g.name || name),
    country: safeString(g.country || ""),
    lat: g.latitude,
    lon: g.longitude,
  };
}

async function getWeatherEvidence(text, lang, cityHint) {
  const city = pickCity(text, cityHint);
  if (!city) return { type: "need_city" };

  const g = await geocodeCity(city, lang);
  if (!g) return null;

  const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(g.lat)}&longitude=${encodeURIComponent(g.lon)}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=auto`;
  const w = await fetchJsonCached(wUrl, 5 * 60 * 1000);
  const cw = w?.current_weather;
  const daily = w?.daily;
  if (!cw) return null;

  const nowTxt = (() => {
    const cond = weatherCodeToText(cw.weathercode, lang);
    const wind = cw.windspeed;
    const temp = cw.temperature;
    const at = safeString(cw.time);
    const L = normalizeLang(lang);
    if (L === "tr") return `${cond}, ${temp}\u00b0C • r\u00fczgar ${wind} km/s (saat: ${at})`;
    if (L === "fr") return `${cond}, ${temp}\u00b0C • vent ${wind} km/h (\u00e0 ${at})`;
    if (L === "ru") return `${cond}, ${temp}\u00b0C • \u0432\u0435\u0442\u0435\u0440 ${wind} \u043a\u043c/\u0447 (\u0432 ${at})`;
    if (L === "ar") return `${cond}ØŒ ${temp}\u00b0C • \u0631\u064a\u0627\u062d ${wind} \u0643\u0645/\u0633 (\u0641\u064a ${at})`;
    return `${cond}, ${temp}\u00b0C • wind ${wind} km/h (at ${at})`;
  })();

  const forecast = [];
  try {
    const times = daily?.time || [];
    const tmax = daily?.temperature_2m_max || [];
    const tmin = daily?.temperature_2m_min || [];
    const pop = daily?.precipitation_probability_max || [];
    const code = daily?.weathercode || [];
    for (let i = 0; i < Math.min(5, times.length); i++) {
      const d = safeString(times[i]);
      const cond = weatherCodeToText(code[i], lang);
      const line = `${d}: ${cond} • ${tmin[i]}\u00b0 / ${tmax[i]}\u00b0 • ${pop[i] ?? "-"}%`;
      forecast.push(line);
    }
  } catch {}

  return {
    type: "weather",
    city: g.name,
    now: nowTxt,
    forecast,
    trustScore: forecast.length ? 88 : 82,
    sources: [{ title: "Open-Meteo", url: "https://open-meteo.com/" }],
  };
}

async function getNewsEvidence(text, lang) {
  const q = compactWords(text, 6) || safeString(text);
  if (!q) return null;

  const hl = lang === "tr" ? "tr" : lang;
  const gl = lang === "tr" ? "TR" : "US";
  const ceid = lang === "tr" ? "TR:tr" : "US:en";

  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
  const xml = await fetchTextCached(rssUrl, 2 * 60 * 1000);
  if (!xml) return null;

  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1] || "";
    const title = decodeHtmlEntities((block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = decodeHtmlEntities((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    const pubDate = decodeHtmlEntities((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    if (title && link) items.push({ title: safeString(title), url: safeString(link), date: safeString(pubDate) });
    if (items.length >= 5) break;
  }

  if (!items.length) return null;

  return {
    type: "news",
    query: q,
    items,
    trustScore: 70,
    sources: items.map((x) => ({ title: x.title, url: x.url })).slice(0, 5),
  };
}




// ============================================================================
// FIRSTS ENGINE (S60) — "İlkler" soruları için liste + disambiguation + kaynak
//   Problem: "ilkler" soruları tekil entity aramasıyla saçmalar.
//   Çözüm: (1) curated kategori index (10â€“50) (2) wiki list parsing (3) scope/person disambiguation
// ============================================================================

const CURATED_FIRSTS_INDEX_V1 = [
  // Genel / meta
  {
    key: "general",
    title: { tr: "Genel (karma)", en: "General (mixed)" },
    keywords: ["ilkler", "ilkleri", "pioneer", "firsts"],
    queries: {
      tr: ["Türkiye'de ilkler", "Türkiye'nin ilkleri"],
      en: ["Turkey firsts", "firsts in Turkey"],
    },
  },

  // Devlet / politika
  {
    key: "politics_state",
    title: { tr: "Siyaset & Devlet", en: "Politics & State" },
    keywords: ["cumhurbaşkanı", "cumhurbaskani", "başbakan", "bakan", "meclis", "anayasa", "seçim", "secim", "siyaset", "devlet", "tbmm"],
    queries: {
      tr: ["Türkiye'de ilk cumhurbaşkanı", "Türkiye'de ilk başbakan"],
      en: ["first president of Turkey", "first prime minister of Turkey"],
    },
  },
  {
    key: "law_rights",
    title: { tr: "Hukuk & Haklar", en: "Law & Rights" },
    keywords: ["hukuk", "yasa", "kanun", "mahkeme", "anayasa", "hak", "insan hakları", "insan haklari", "oy hakkı", "oy hakki"],
    queries: {
      tr: ["Türkiye'de ilk anayasa", "Türkiye'de ilk kadınlara oy hakkı"],
      en: ["first constitution of Turkey", "women's suffrage in Turkey first"],
    },
  },

  // Kadınların ilkleri (çok istenen)
  {
    key: "women_firsts",
    title: { tr: "Kadınların İlkleri", en: "Women Pioneers" },
    keywords: ["kadın", "kadin", "female", "woman", "hanım", "hanim"],
    queries: {
      tr: ["Türkiye'de ilk kadın", "Türkiye'nin ilk kadınları"],
      en: ["first woman in Turkey", "first Turkish woman"],
    },
  },

  // Askerî / savunma / havacılık
  {
    key: "military",
    title: { tr: "Askerî Tarih", en: "Military" },
    keywords: ["ordu", "asker", "komutan", "savaş", "savas", "genelkurmay", "harp", "deniz kuvvet", "hava kuvvet", "jandarma", "polis"],
    queries: {
      tr: ["Türkiye'de ilk askeri", "Türkiye'de ilk general"],
      en: ["first in Turkish military", "first Turkish general"],
    },
  },
  {
    key: "defense_industry",
    title: { tr: "Savunma Sanayii", en: "Defense Industry" },
    keywords: ["savunma", "sanayi", "saha", "iha", "siha", "tank", "silah", "mühimmat", "muhimmat", "roketsan", "tusaş", "tusas", "aselsan", "havelsan"],
    queries: {
      tr: ["Türkiye'de ilk yerli uçak", "Türkiye'de ilk yerli savunma sanayii"],
      en: ["first domestic aircraft Turkey", "first Turkish defense industry"],
    },
  },
  {
    key: "aviation_space",
    title: { tr: "Havacılık & Uzay", en: "Aviation & Space" },
    keywords: ["pilot", "uçak", "ucak", "havacılık", "havacilik", "hava", "savaş pilotu", "savas pilotu", "astronot", "uzay", "roket", "havaalanı", "havaalani"],
    queries: {
      tr: ["Türkiye'de ilk pilot", "Türkiye havacılık ilkleri"],
      en: ["first pilot in Turkey", "Turkey aviation firsts"],
    },
  },
  {
    key: "maritime",
    title: { tr: "Denizcilik", en: "Maritime" },
    keywords: ["gemi", "denizcilik", "liman", "donanma", "kaptan", "tersane", "feribot", "vapuru", "yolcu gemisi"],
    queries: {
      tr: ["Türkiye'de ilk gemi", "Türkiye'de ilk denizcilik"],
      en: ["first ship Turkey", "Turkey maritime firsts"],
    },
  },

  // Bilim / teknoloji / internet
  {
    key: "science_tech",
    title: { tr: "Bilim & Teknoloji", en: "Science & Technology" },
    keywords: ["bilim", "teknoloji", "mühendis", "muhendis", "buluş", "bulus", "laboratuvar", "ar-ge", "arge", "inovasyon", "patent"],
    queries: {
      tr: ["Türkiye'de ilk bilim", "Türkiye'de ilk teknoloji"],
      en: ["first science in Turkey", "Turkey technology firsts"],
    },
  },
  {
    key: "computing_internet",
    title: { tr: "Bilişim & İnternet", en: "Computing & Internet" },
    keywords: ["bilgisayar", "internet", "yazılım", "yazilim", "program", "kod", "web", "site", "e-posta", "email", "telekom", "gsm"],
    queries: {
      tr: ["Türkiye'de ilk bilgisayar", "Türkiye'de ilk internet"],
      en: ["first computer in Turkey", "first internet in Turkey"],
    },
  },

  // Sağlık
  {
    key: "medicine_health",
    title: { tr: "Tıp & Sağlık", en: "Medicine & Health" },
    keywords: ["tıp", "tip", "hastane", "ameliyat", "aşı", "asi", "sağlık", "saglik", "doktor", "eczane"],
    queries: {
      tr: ["Türkiye'de ilk hastane", "Türkiye'de ilk ameliyat"],
      en: ["first hospital in Turkey", "first surgery in Turkey"],
    },
  },

  // Eğitim
  {
    key: "education",
    title: { tr: "Eğitim", en: "Education" },
    keywords: ["okul", "üniversite", "universite", "lise", "eğitim", "egitim", "öğretmen", "ogretmen", "akademi", "fakülte", "fakulte"],
    queries: {
      tr: ["Türkiye'de ilk üniversite", "Türkiye'de ilk okul"],
      en: ["first university in Turkey", "first school in Turkey"],
    },
  },

  // Ekonomi / iş / sanayi / enerji
  {
    key: "economy_business",
    title: { tr: "Ekonomi & İş Dünyası", en: "Economy & Business" },
    keywords: ["ekonomi", "banka", "borsa", "şirket", "sirket", "sanayi", "fabrika", "ticaret", "ihracat", "ithalat", "girişim", "girisim"],
    queries: {
      tr: ["Türkiye'de ilk banka", "Türkiye'de ilk borsa"],
      en: ["first bank in Turkey", "first stock exchange in Turkey"],
    },
  },
  {
    key: "industry_transport",
    title: { tr: "Ulaşım & Altyapı", en: "Transport & Infrastructure" },
    keywords: ["tren", "demiryolu", "metro", "otoyol", "köprü", "kopru", "tünel", "tunel", "havaalanı", "havaalani", "liman", "tramvay"],
    queries: {
      tr: ["Türkiye'de ilk demiryolu", "Türkiye'de ilk metro"],
      en: ["first railway in Turkey", "first metro in Turkey"],
    },
  },
  {
    key: "energy",
    title: { tr: "Enerji", en: "Energy" },
    keywords: ["enerji", "elektrik", "baraj", "nükleer", "nukleer", "santral", "petrol", "doğalgaz", "dogalgaz", "yenilenebilir", "güneş", "gunes", "rüzgar", "ruzgar"],
    queries: {
      tr: ["Türkiye'de ilk elektrik", "Türkiye'de ilk baraj"],
      en: ["first electricity in Turkey", "first dam in Turkey"],
    },
  },

  // Medya / kültür-sanat
  {
    key: "press_media",
    title: { tr: "Basın & Medya", en: "Press & Media" },
    keywords: ["gazete", "dergi", "basın", "basin", "radyo", "televizyon", "tv", "yayın", "yayin", "haber"],
    queries: {
      tr: ["Türkiye'de ilk gazete", "Türkiye'de ilk radyo"],
      en: ["first newspaper in Turkey", "first radio in Turkey"],
    },
  },
  {
    key: "cinema_tv",
    title: { tr: "Sinema & TV", en: "Cinema & TV" },
    keywords: ["sinema", "film", "dizi", "televizyon", "tv", "yönetmen", "yonetmen", "oyuncu", "belgesel"],
    queries: {
      tr: ["Türkiye'de ilk film", "Türkiye'de ilk televizyon yayını"],
      en: ["first Turkish film", "first TV broadcast in Turkey"],
    },
  },
  {
    key: "music",
    title: { tr: "Müzik", en: "Music" },
    keywords: ["müzik", "muzik", "albüm", "album", "konser", "opera", "senfoni", "beste", "sanatçı", "sanatci"],
    queries: {
      tr: ["Türkiye'de ilk opera", "Türkiye'de ilk konser"],
      en: ["first opera in Turkey", "first concert in Turkey"],
    },
  },
  {
    key: "literature",
    title: { tr: "Edebiyat", en: "Literature" },
    keywords: ["edebiyat", "roman", "şiir", "siir", "yazar", "kitap", "derleme", "yayıncılık", "yayincilik"],
    queries: {
      tr: ["Türkiye'de ilk roman", "Türkiye'de ilk edebiyat"],
      en: ["first novel in Turkey", "Turkish literature firsts"],
    },
  },
  {
    key: "theatre",
    title: { tr: "Tiyatro", en: "Theatre" },
    keywords: ["tiyatro", "sahne", "oyun", "aktör", "aktor", "festival", "gösteri", "gosteri"],
    queries: {
      tr: ["Türkiye'de ilk tiyatro", "Türkiye'de ilk sahne"],
      en: ["first theatre in Turkey", "Turkey theatre firsts"],
    },
  },
  {
    key: "visual_arts",
    title: { tr: "Görsel Sanatlar", en: "Visual Arts" },
    keywords: ["resim", "heykel", "müze", "muze", "sergi", "fotoğraf", "fotograf", "sanat", "galeri"],
    queries: {
      tr: ["Türkiye'de ilk müze", "Türkiye'de ilk sergi"],
      en: ["first museum in Turkey", "first exhibition in Turkey"],
    },
  },
  {
    key: "architecture",
    title: { tr: "Mimari & Yapı", en: "Architecture & Buildings" },
    keywords: ["mimari", "yapı", "yapi", "bina", "gökdelen", "gokdelen", "cami", "kilise", "köprü", "kopru", "stadyum"],
    queries: {
      tr: ["Türkiye'de ilk gökdelen", "Türkiye'de ilk stadyum"],
      en: ["first skyscraper in Turkey", "first stadium in Turkey"],
    },
  },

  // Spor
  {
    key: "sports",
    title: { tr: "Spor", en: "Sports" },
    keywords: ["spor", "futbol", "basketbol", "voleybol", "olimpiyat", "şampiyon", "sampiyon", "rekor", "kulüp", "kulup"],
    queries: {
      tr: ["Türkiye'de ilk spor kulübü", "Türkiye olimpiyat ilkleri"],
      en: ["first sports club in Turkey", "Turkey Olympic firsts"],
    },
  },

  // Çevre / turizm / gastronomi
  {
    key: "environment",
    title: { tr: "Çevre & Doğa", en: "Environment & Nature" },
    keywords: ["çevre", "cevre", "doğa", "doga", "milli park", "koruma", "orman", "iklim", "deprem", "sel"],
    queries: {
      tr: ["Türkiye'de ilk milli park", "Türkiye'de ilk çevre"],
      en: ["first national park in Turkey", "environmental firsts in Turkey"],
    },
  },
  {
    key: "tourism_gastronomy",
    title: { tr: "Turizm & Gastronomi", en: "Tourism & Gastronomy" },
    keywords: ["turizm", "otel", "tatil", "gastronomi", "mutfak", "yemek", "restoran", "kebap", "kahve", "lokanta"],
    queries: {
      tr: ["Türkiye'de ilk otel", "Türkiye'de ilk restoran"],
      en: ["first hotel in Turkey", "first restaurant in Turkey"],
    },
  },
];

function normalizeLoose(s = "") {
  const low = safeString(s).toLowerCase();
  // remove diacritics (TR/FR/etc), punctuation
  const noDiac = low.normalize("NFD").replace(/\p{M}+/gu, "");
  return noDiac.replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function detectFirstsScope(text = "", lang = "tr") {
  const n = normalizeLoose(text);

  // global keywords
  if (/\b(dunya|world|global)\b/.test(n)) return { key: "world", label: lang === "tr" ? "Dünya" : "World" };

  // Turkey keywords
  if (/\b(turkiye|turk|turkiye nin|t c|turkiye de|turkiyede)\b/.test(n)) {
    return { key: "turkey", label: lang === "tr" ? "Türkiye" : "Turkey" };
  }

  // light country detection (keep small; disambiguate rather than guessing)
  const map = [
    ["abd", "USA"], ["usa", "USA"], ["united states", "USA"], ["amerika", "USA"],
    ["ingiltere", "UK"], ["uk", "UK"], ["england", "UK"], ["birlesik krallik", "UK"],
    ["almanya", "Germany"], ["germany", "Germany"],
    ["fransa", "France"], ["france", "France"],
    ["italya", "Italy"], ["italy", "Italy"],
    ["ispanya", "Spain"], ["spain", "Spain"],
    ["japonya", "Japan"], ["japan", "Japan"],
    ["cin", "China"], ["china", "China"],
    ["rusya", "Russia"], ["russia", "Russia"],
  ];
  for (const [k, label] of map) {
    if (n.includes(k)) return { key: k, label };
  }

  return null;
}

function isGenericTurkeyFirstsQuery(text = "") {
  const n = normalizeLoose(text).replace(/[?!.]+/g, "").trim();
  return (
    n === "turkiye ilkleri" ||
    n === "turkiyenin ilkleri" ||
    n === "turkiye nin ilkleri" ||
    n === "turkiye de ilkler" ||
    n === "turkiyede ilkler" ||
    n === "turkiye de ilkleri" ||
    n === "turkiyede ilkleri"
  );
}

function pickFirstsCategory(text = "", lang = "tr") {
  const n = normalizeLoose(text);
  let best = CURATED_FIRSTS_INDEX_V1[0];
  let bestScore = 0;

  for (const c of CURATED_FIRSTS_INDEX_V1) {
    let score = 0;
    for (const kw of (c.keywords || [])) {
      const k = normalizeLoose(kw);
      if (!k) continue;
      if (n.includes(k)) score += (k.length >= 6 ? 3 : 2);
    }
    // tiny boost when query contains "ilk kadın" etc.
    if (c.key === "women_firsts" && /\b(il kadin|ilk kadin|female|woman)\b/.test(n)) score += 4;
    if (score > bestScore) { bestScore = score; best = c; }
  }

  // if nothing matched, fallback general
  return bestScore > 0 ? best : CURATED_FIRSTS_INDEX_V1[0];
}

async function wikipediaSearchRaw(query, lang, limit = 6) {
  const wLang = pickWikiLang(lang);
  const q = safeString(query);
  if (!q) return [];
  const base = `https://${wLang}.wikipedia.org/w/api.php`;
  const url = `${base}?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=1&format=json&origin=*&srlimit=${encodeURIComponent(Math.max(3, Math.min(10, limit)))}`;
  const data = await fetchJsonCached(url, 24 * 60 * 60 * 1000);
  const arr = data?.query?.search || [];
  return Array.isArray(arr) ? arr.map((x) => ({
    title: safeString(x?.title || ""),
    snippet: safeString(stripTags(x?.snippet || "")),
    pageid: x?.pageid,
  })).filter((x) => x.title) : [];
}

function wikipediaPageUrl(title, lang) {
  const wLang = pickWikiLang(lang);
  const t = safeString(title).replace(/\s/g, "_");
  return t ? `https://${wLang}.wikipedia.org/wiki/${encodeURIComponent(t)}` : "";
}

async function wikipediaParseHtml(title, lang) {
  const wLang = pickWikiLang(lang);
  const t = safeString(title);
  if (!t) return "";
  const base = `https://${wLang}.wikipedia.org/w/api.php`;
  const url = `${base}?action=parse&page=${encodeURIComponent(t)}&prop=text&format=json&origin=*`;
  const data = await fetchJsonCached(url, 24 * 60 * 60 * 1000);
  return safeString(data?.parse?.text?.["*"] || "");
}

function looksLikeFirstsListCandidate(title = "", snippet = "", query = "") {
  const t = normalizeLoose(title);
  const s = normalizeLoose(snippet);
  const q = normalizeLoose(query);
  if (!t) return false;
  if (/\b(first aid|ilk yardim)\b/.test(t) || /\b(first aid|ilk yardim)\b/.test(s)) return false;

  // list-ish signals
  const hasFirst = /\b(ilk|ilkler|first|firsts)\b/.test(t) || /\b(ilk|ilkler|first|firsts)\b/.test(s);
  const hasList  = /\b(liste|list|kategori|category|chronology|timeline)\b/.test(t) || /\b(liste|list|kategori|category|chronology|timeline)\b/.test(s);

  // relevance signal
  const qWords = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const rel = qWords.some((w) => w.length >= 4 && (t.includes(w) || s.includes(w)));

  return (hasFirst || hasList) && rel;
}

function filterFirstsItems(items = [], lang = "tr") {
  const L = normalizeLang(lang);
  const out = [];
  for (const it of items) {
    const x = safeString(it);
    if (!x) continue;
    if (x.length < 5 || x.length > 220) continue;
    // drop obvious footnotes / nav fragments
    if (/\b(wikipedia|vikisözlük|vikisozluk|vikiveri|wikidata)\b/i.test(x)) continue;
    if (/^\[\d+\]$/.test(x)) continue;
    out.push(x);
    if (out.length >= 20) break;
  }

  // if many items, keep the most "first-ish" ones first
  const scored = out.map((x) => {
    const n = normalizeLoose(x);
    let sc = 0;
    if (/\b(ilk|first)\b/.test(n)) sc += 3;
    if (/\b(kadin|woman|female)\b/.test(n)) sc += 1;
    if (/\b(turkiye|turk|turkish)\b/.test(n)) sc += 1;
    return { x, sc };
  }).sort((a, b) => b.sc - a.sc);

  const uniq = [];
  for (const o of scored) {
    if (!uniq.includes(o.x)) uniq.push(o.x);
    if (uniq.length >= 12) break;
  }
  return uniq;
}

async function getFirstsEvidence(text, lang) {
  const L = normalizeLang(lang);
  const raw = safeString(text);
  if (!raw) return null;

  // If user clicked a disambiguation option like: "ilk ... → Page Title"
  const arrowMatch = raw.match(/(.*?)(?:->|→)\s*(.+)$/);
  if (arrowMatch && arrowMatch[2]) {
    const forcedTitle = safeString(arrowMatch[2]);
    const sum = await getWikiEvidence(forcedTitle, L).catch(() => null);
    if (sum && sum.extract) {
      return {
        type: "firsts",
        mode: "single",
        scope: detectFirstsScope(raw, L)?.label || "",
        title: forcedTitle,
        answer: sum.extract,
        trustScore: Math.max(60, Math.min(88, (sum.trustScore || 70) + 6)),
        sources: sum.sources || (forcedTitle ? [{ title: `Wikipedia: ${forcedTitle}`, url: wikipediaPageUrl(forcedTitle, L) }] : []),
        suggestions: [],
      };
    }
    // fallback: still return wiki
    if (sum) return sum;
  }

  const scope = detectFirstsScope(raw, L);
  const low = normalizeLoose(raw);

  const isFirstAid = /\b(first aid|ilk yardim)\b/.test(low);
  if (isFirstAid) {
    // Not a "firsts" question
    return await getWikiEvidence(raw, L);
  }

  const wantsList =
    /\b(ilkler|ilkleri|firsts)\b/.test(low) ||
    /\b(liste|list)\b/.test(low);

  const cleaned = stripQuestionNoise(raw) || raw;
  const category = pickFirstsCategory(cleaned, L);

  // If no scope is provided, do NOT guess. Ask with disambiguation.
  if (!scope) {
    if (wantsList) {
      const base = L === "tr" ? "ilkler" : "firsts";
      return {
        type: "disambiguation",
        options: [
          { label: L === "tr" ? "Türkiye'nin ilkleri" : "Turkey firsts", desc: L === "tr" ? "Türkiye odaklı liste" : "Turkey-focused list" },
          { label: L === "tr" ? "Dünyanın ilkleri" : "World firsts", desc: L === "tr" ? "Genel / dünya çapı" : "Global / world-wide" },
        ],
        sources: [],
        trustScore: 45,
      };
    }

    // single "ilk ..." question → ask country/scope
    const baseQ = stripQuestionNoise(cleaned) || cleaned;
    return {
      type: "disambiguation",
      options: [
        { label: (L === "tr" ? `Türkiye'de ${baseQ}` : `In Turkey: ${baseQ}`), desc: L === "tr" ? "Türkiye kapsamı" : "Turkey scope" },
        { label: (L === "tr" ? `Dünya'da ${baseQ}` : `Worldwide: ${baseQ}`), desc: L === "tr" ? "Dünya kapsamı" : "World scope" },
      ],
      sources: [],
      trustScore: 45,
    };
  }

  // "Türkiye'nin ilkleri" (genel) → kategori menüsü (curated index)
  if (scope.key === "turkey" && wantsList && isGenericTurkeyFirstsQuery(raw)) {
    const cats = CURATED_FIRSTS_INDEX_V1
      .filter((c) => c.key !== "general")
      .map((c) => {
        const t = (c.title && (c.title[L] || c.title.tr)) || c.key;
        const suggestion = L === "tr"
          ? `Türkiye'nin ilkleri ${t}`
          : `Turkey firsts ${t}`;
        return { title: t, suggestion };
      });

    return {
      type: "firsts",
      mode: "menu",
      scope: scope.label,
      title: "",
      categories: cats,
      trustScore: 72,
      sources: [],
      suggestions: cats.slice(0, 4).map((c) => c.suggestion),
    };
  }

  if (wantsList) {
    // List mode: use curated category queries + wiki list parsing
    const qList = (() => {
      const qArr = (category.queries && (category.queries[L] || category.queries.tr)) || [];
      if (qArr.length) return qArr[0];

      // fallback: synthesize
      const catTitle = (category.title && (category.title[L] || category.title.tr)) || "";
      if (L === "tr") return `${scope.label} ${catTitle} ilkleri`;
      return `${scope.label} ${catTitle} firsts`;
    })();

    const results = await wikipediaSearchRaw(qList, L, 8);
    const candidates = results
      .filter((r) => looksLikeFirstsListCandidate(r.title, r.snippet, qList))
      .sort((a, b) => scoreCandidate(qList, b.title, b.snippet) - scoreCandidate(qList, a.title, a.snippet))
      .slice(0, 3);

    const items = [];
    const sources = [];
    for (const c of candidates) {
      const html = await wikipediaParseHtml(c.title, L);
      if (!html) continue;
      const rawItems = extractListItems(html);
      const filtered = filterFirstsItems(rawItems, L);
      for (const it of filtered) items.push(it);

      const url = wikipediaPageUrl(c.title, L);
      if (url) sources.push({ title: `Wikipedia: ${c.title}`, url });
      if (items.length >= 12) break;
    }

    const uniq = [];
    for (const it of items) {
      if (!uniq.includes(it)) uniq.push(it);
      if (uniq.length >= 10) break;
    }

    // fallback: if parsing failed, try a normal wiki summary
    if (!uniq.length) {
      const sum = await getWikiEvidence(qList, L).catch(() => null);
      if (sum && sum.extract) {
        return {
          type: "firsts",
          mode: "single",
          scope: scope.label,
          title: (category.title && (category.title[L] || category.title.tr)) || "İlkler",
          answer: sum.extract,
          trustScore: Math.max(55, Math.min(82, (sum.trustScore || 68) + 4)),
          sources: sum.sources || [],
          suggestions: [],
        };
      }
    }

    const catTitle = (category.title && (category.title[L] || category.title.tr)) || "İlkler";
    const trustScore = Math.max(60, Math.min(88, 62 + (uniq.length >= 6 ? 10 : uniq.length >= 3 ? 6 : 2) + (sources.length ? 6 : 0)));

    return {
      type: "firsts",
      mode: "list",
      scope: scope.label,
      title: catTitle,
      items: uniq,
      trustScore,
      sources: sources.slice(0, 3),
      suggestions: [],
    };
  }

  // Single mode: "ilk X kim" → search, disambiguate by page candidates, answer via forced title click
  const baseQ = stripQuestionNoise(cleaned) || cleaned;
  const qSingle = (() => {
    if (L === "tr") return `${scope.label} ${baseQ}`;
    return `${scope.label} ${baseQ}`;
  })();

  const results = await wikipediaSearchRaw(qSingle, L, 6);
  if (!results.length) {
    // fallback to generic wiki
    const sum = await getWikiEvidence(qSingle, L).catch(() => null);
    return sum || { type: "no_answer", reason: "no_firsts", trustScore: 45 };
  }

  const scored = results
    .map((r) => ({ ...r, sc: scoreCandidate(qSingle, r.title, r.snippet) }))
    .sort((a, b) => b.sc - a.sc);

  const best = scored[0];
  const second = scored[1];

  // If ambiguous, offer disambiguation where clicking keeps context via arrow
  if (second && best && (best.sc - second.sc) <= 1) {
    const opts = scored.slice(0, 4).map((r) => ({
      label: `${baseQ} → ${r.title}`,
      desc: r.snippet ? r.snippet.slice(0, 90) : "",
    }));

    return {
      type: "disambiguation",
      options: opts,
      sources: opts.length ? [{ title: "Wikipedia search", url: `https://${pickWikiLang(L)}.wikipedia.org/w/index.php?search=${encodeURIComponent(qSingle)}` }] : [],
      trustScore: 50,
    };
  }

  // Not ambiguous: answer best page summary
  const sum = await getWikiEvidence(best.title, L).catch(() => null);
  if (sum && sum.extract) {
    return {
      type: "firsts",
      mode: "single",
      scope: scope.label,
      title: best.title,
      answer: sum.extract,
      trustScore: Math.max(60, Math.min(90, (sum.trustScore || 70) + 6)),
      sources: sum.sources || [{ title: `Wikipedia: ${best.title}`, url: wikipediaPageUrl(best.title, L) }],
      suggestions: [],
    };
  }

  // last resort
  return await getWikiEvidence(qSingle, L);
}



async function getWikiEvidence(text, lang) {
  const q0 = safeString(text);
  if (!q0) return null;
  const q = stripQuestionNoise(q0) || q0;
  const wLang = pickWikiLang(lang || "tr");

  const sUrl = `https://${wLang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=1&format=json&origin=*&srlimit=5`;
  const search = await fetchJsonCached(sUrl, 24 * 60 * 60 * 1000);
  const arr = (search?.query?.search || []).slice(0, 5);
  if (!arr.length) return null;

  let best = arr[0];
  let bestScore = -1;
  for (const cand of arr) {
    const sc = scoreCandidate(q, cand?.title, cand?.snippet);
    if (sc > bestScore) {
      bestScore = sc;
      best = cand;
    }
  }

  // Reject weak matches (avoid confident nonsense)
  if (!best || bestScore < 2) return null;

  const bestTitle = safeString(best?.title || "");
  const titleLow = bestTitle.toLowerCase();
  const stop = new Set(["nedir","ne","kim","kaç","kac","hangi","nasıl","nasil","mi","mı","mu","mü","ve","ile","ya","ya da","what","how","who","which","is","are"]);
  const sig = q.toLowerCase().split(/\s+/g).map((w) => w.trim()).filter((w) => w.length >= 4 && !stop.has(w));
  if (sig.length && !sig.some((w) => titleLow.includes(w))) {
    // If none of the significant query words appear in title, treat as mismatch.
    return null;
  }

  const title = safeString(bestTitle || q0);
  const sumUrl = `https://${wLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const sum = await fetchJsonCached(sumUrl, 24 * 60 * 60 * 1000);
  const extract = safeString(sum?.extract || "");
  const pageUrl = safeString(sum?.content_urls?.desktop?.page || "");
  if (!extract) return null;

  // trust score: higher when match score is higher
  const trustScore = Math.max(55, Math.min(80, 55 + (bestScore > 0 ? bestScore * 3 : 6)));

  return {
    type: "wiki",
    title,
    extract,
    trustScore,
    sources: pageUrl ? [{ title: `Wikipedia: ${title}`, url: pageUrl }] : [],
  };
}

// ============================================================================
// STRUCTURED FACTS (Wikidata) + DISAMBIGUATION  — S60
//   Goal: “başkent / nüfus / para birimi / resmi dil / lider / alan adı â€¦”
//   via Wikidata, with a safe “hangisi?” clarification flow.
// ============================================================================

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// Small deterministic overrides for very common entities (helps when search/disambiguation fails)
const ENTITY_OVERRIDES = new Map([
  ['turkiye', 'Q43'], ['türkiye', 'Q43'], ['turkey', 'Q43'],
  ['ankara', 'Q3640'], ['istanbul', 'Q406'], ['bodrum', 'Q130779'],
  ['fransa', 'Q142'], ['france', 'Q142'],
  ['almanya', 'Q183'], ['germany', 'Q183'],
  ['abd', 'Q30'], ['amerika', 'Q30'], ['united states', 'Q30'], ['usa', 'Q30'],
]);

function normalizeEntityKey(s='') {
  const low = safeString(s).toLowerCase();
  // remove diacritics and punctuation, keep letters/numbers/spaces
  const noDiac = low.normalize('NFD').replace(/\p{M}+/gu, '');
  return noDiac.replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function lookupEntityOverride(hint='') {
  const k = normalizeEntityKey(hint);
  return ENTITY_OVERRIDES.get(k) || null;
}

async function wikidataGetEntityByWikiTitle(title, lang) {
  const wLang = wikilangForWikidata(lang);
  const t = safeString(title).trim();
  if (!t) return null;
  const url = `${WIKIDATA_API}?action=wbgetentities&sites=${wLang}wiki&titles=${encodeURIComponent(t)}&format=json&origin=*`;
  const data = await fetchJsonCached(url, 30 * 24 * 60 * 60 * 1000);
  const entities = data?.entities || {};
  for (const [id, ent] of Object.entries(entities)) {
    if (!id || id === "-1" || !ent) continue;
    const label = safeString(ent?.labels?.[wLang]?.value || ent?.labels?.en?.value || "");
    const desc  = safeString(ent?.descriptions?.[wLang]?.value || ent?.descriptions?.en?.value || "");
    return { id, label: label || t, desc }; // ✅ description değil desc
  }
  return null;
}



// 30+ property map (country/city/person). Keep it small-but-useful.
const FACT_PROPERTIES = [
  // Geo / state facts
  { key: "capital", pid: "P36", valueType: "item", labels: { tr: "Başkenti", en: "Capital", fr: "Capitale", ru: "Ğ¡Ñ‚Ğ¾Ğ»Ğ¸Ñ†Ğ°", ar: "Ø§Ù„Ø¹Ø§ØµÙ…Ø©" },
    kw: ["başkent", "baskent", "capital", "capitale", "ÑÑ‚Ğ¾Ğ»Ğ¸Ñ†Ğ°", "Ø§Ù„Ø¹Ø§ØµÙ…Ø©"] },
  { key: "population", pid: "P1082", valueType: "quantity", labels: { tr: "Nüfus", en: "Population", fr: "Population", ru: "ĞĞ°ÑĞµĞ»ĞµĞ½Ğ¸Ğµ", ar: "Ø¹Ø¯Ø¯ Ø§Ù„Ø³ÙƒØ§Ù†" },
    kw: ["nüfus", "nufus", "population", "Ğ½Ğ°ÑĞµĞ»ĞµĞ½Ğ¸Ğµ", "Ø³ÙƒØ§Ù†", "Ø¹Ø¯Ø¯ Ø§Ù„Ø³ÙƒØ§Ù†"] },
  { key: "currency", pid: "P38", valueType: "item", labels: { tr: "Para birimi", en: "Currency", fr: "Monnaie", ru: "Ğ’Ğ°Ğ»ÑÑ‚Ğ°", ar: "Ø§Ù„Ø¹Ù…Ù„Ø©" },
    kw: ["para birimi", "para", "currency", "monnaie", "Ğ²Ğ°Ğ»ÑÑ‚Ğ°", "Ø§Ù„Ø¹Ù…Ù„Ø©"] },
  { key: "official_language", pid: "P37", valueType: "item", labels: { tr: "Resmi dil", en: "Official language", fr: "Langue officielle", ru: "ĞÑ„Ğ¸Ñ†Ğ¸Ğ°Ğ»ÑŒĞ½Ñ‹Ğ¹ ÑĞ·Ñ‹Ğº", ar: "Ø§Ù„Ù„ØºØ© Ø§Ù„Ø±Ø³Ù…ÙŠØ©" },
    kw: ["resmi dil", "official language", "langue officielle", "Ğ¾Ñ„Ğ¸Ñ†Ğ¸Ğ°Ğ»ÑŒĞ½Ñ‹Ğ¹ ÑĞ·Ñ‹Ğº", "Ø§Ù„Ù„ØºØ© Ø§Ù„Ø±Ø³Ù…ÙŠØ©"] },
  { key: "area", pid: "P2046", valueType: "quantity", labels: { tr: "Yüzölçümü", en: "Area", fr: "Superficie", ru: "ĞŸĞ»Ğ¾Ñ‰Ğ°Ğ´ÑŒ", ar: "Ø§Ù„Ù…Ø³Ø§Ø­Ø©" },
    kw: ["yüzölçümü", "yuzolcumu", "area", "superficie", "Ğ¿Ğ»Ğ¾Ñ‰Ğ°Ğ´ÑŒ", "Ø§Ù„Ù…Ø³Ø§Ø­Ø©", "km2", "km²"] },
  { key: "calling_code", pid: "P474", valueType: "string", labels: { tr: "Telefon kodu", en: "Calling code", fr: "Indicatif", ru: "Ğ¢ĞµĞ»ĞµÑ„Ğ¾Ğ½Ğ½Ñ‹Ğ¹ ĞºĞ¾Ğ´", ar: "Ø±Ù…Ø² Ø§Ù„Ø§ØªØµØ§Ù„" },
    kw: ["telefon kodu", "ülke kodu", "calling code", "indicatif", "ĞºĞ¾Ğ´", "Ø±Ù…Ø² Ø§Ù„Ø§ØªØµØ§Ù„", "dial code"] },
  { key: "tld", pid: "P78", valueType: "string", labels: { tr: "İnternet alan adı", en: "Internet TLD", fr: "Domaine Internet", ru: "Ğ”Ğ¾Ğ¼ĞµĞ½", ar: "Ù†Ø·Ø§Ù‚ Ø§Ù„Ø¥Ù†ØªØ±Ù†Øª" },
    kw: ["alan adı", "alan adi", "tld", "domain", "domaine", "Ğ´Ğ¾Ğ¼ĞµĞ½", "Ù†Ø·Ø§Ù‚"] },
  { key: "time_zone", pid: "P421", valueType: "item", labels: { tr: "Saat dilimi", en: "Time zone", fr: "Fuseau horaire", ru: "Ğ§Ğ°ÑĞ¾Ğ²Ğ¾Ğ¹ Ğ¿Ğ¾ÑÑ", ar: "Ø§Ù„Ù…Ù†Ø·Ù‚Ø© Ø§Ù„Ø²Ù…Ù†ÙŠØ©" },
    kw: ["saat dilimi", "time zone", "fuseau", "Ñ‡Ğ°ÑĞ¾Ğ²Ğ¾Ğ¹ Ğ¿Ğ¾ÑÑ", "Ø§Ù„Ù…Ù†Ø·Ù‚Ø© Ø§Ù„Ø²Ù…Ù†ÙŠØ©"] },
  { key: "continent", pid: "P30", valueType: "item", labels: { tr: "Kıta", en: "Continent", fr: "Continent", ru: "ĞšĞ¾Ğ½Ñ‚Ğ¸Ğ½ĞµĞ½Ñ‚", ar: "Ø§Ù„Ù‚Ø§Ø±Ø©" },
    kw: ["kıta", "kita", "continent", "ĞºĞ¾Ğ½Ñ‚Ğ¸Ğ½ĞµĞ½Ñ‚", "Ø§Ù„Ù‚Ø§Ø±Ø©"] },
  { key: "neighbors", pid: "P47", valueType: "item", labels: { tr: "Komşular", en: "Neighbors", fr: "Voisins", ru: "Ğ¡Ğ¾ÑĞµĞ´Ğ¸", ar: "Ø§Ù„Ø¯ÙˆÙ„ Ø§Ù„Ù…Ø¬Ø§ÙˆØ±Ø©" },
    kw: ["komşu", "komşuları", "neighbor", "neighbour", "voisin", "ÑĞ¾ÑĞµĞ´", "Ø§Ù„Ù…Ø¬Ø§ÙˆØ±Ø©"] },
  { key: "inception", pid: "P571", valueType: "time", labels: { tr: "Kuruluş", en: "Inception", fr: "Création", ru: "ĞÑĞ½Ğ¾Ğ²Ğ°Ğ½Ğ¸Ğµ", ar: "Ø§Ù„ØªØ£Ø³ÙŠØ³" },
    kw: ["kuruluş", "kurulus", "inception", "founded", "création", "Ğ¾ÑĞ½Ğ¾Ğ²Ğ°Ğ½", "ØªØ£Ø³Ø³Øª"] },
  { key: "anthem", pid: "P85", valueType: "item", labels: { tr: "Milli marş", en: "Anthem", fr: "Hymne", ru: "Ğ“Ğ¸Ğ¼Ğ½", ar: "Ø§Ù„Ù†Ø´ÙŠØ¯" },
    kw: ["milli marş", "marş", "anthem", "hymne", "Ğ³Ğ¸Ğ¼Ğ½", "Ø§Ù„Ù†Ø´ÙŠØ¯"] },
  { key: "motto", pid: "P1451", valueType: "monolingual", labels: { tr: "Slogan", en: "Motto", fr: "Devise", ru: "Ğ”ĞµĞ²Ğ¸Ğ·", ar: "Ø§Ù„Ø´Ø¹Ø§Ø±" },
    kw: ["motto", "slogan", "devise", "Ğ´ĞµĞ²Ğ¸Ğ·", "Ø§Ù„Ø´Ø¹Ø§Ø±"] },
  { key: "official_website", pid: "P856", valueType: "string", labels: { tr: "Resmi web", en: "Official website", fr: "Site officiel", ru: "ĞÑ„Ğ¸Ñ†. ÑĞ°Ğ¹Ñ‚", ar: "Ø§Ù„Ù…ÙˆÙ‚Ø¹ Ø§Ù„Ø±Ø³Ù…ÙŠ" },
    kw: ["resmi site", "resmi web", "official website", "site officiel", "Ğ¾Ñ„Ğ¸Ñ†Ğ¸Ğ°Ğ»ÑŒĞ½Ñ‹Ğ¹ ÑĞ°Ğ¹Ñ‚", "Ø§Ù„Ù…ÙˆÙ‚Ø¹ Ø§Ù„Ø±Ø³Ù…ÙŠ"] },

  // Leadership
  { key: "mayor", pid: "P6", valueType: "item", labels: { tr: "Belediye başkanı", en: "Mayor", fr: "Maire", ru: "ĞœÑÑ€", ar: "Ø±Ø¦ÙŠØ³ Ø§Ù„Ø¨Ù„Ø¯ÙŠØ©" },
    kw: ["belediye başkanı", "belediye baskani", "mayor", "maire", "Ğ¼ÑÑ€", "Ø±Ø¦ÙŠØ³ Ø§Ù„Ø¨Ù„Ø¯ÙŠØ©"] },
  { key: "head_of_state", pid: "P35", valueType: "item", labels: { tr: "Devlet başkanı", en: "Head of state", fr: "Chef d'État", ru: "Ğ“Ğ»Ğ°Ğ²Ğ° Ğ³Ğ¾ÑÑƒĞ´Ğ°Ñ€ÑÑ‚Ğ²Ğ°", ar: "Ø±Ø¦ÙŠØ³ Ø§Ù„Ø¯ÙˆÙ„Ø©" },
    kw: ["devlet başkanı", "cumhurbaşkanı", "head of state", "chef d'état", "Ğ³Ğ»Ğ°Ğ²Ğ° Ğ³Ğ¾ÑÑƒĞ´Ğ°Ñ€ÑÑ‚Ğ²Ğ°", "Ø±Ø¦ÙŠØ³ Ø§Ù„Ø¯ÙˆÙ„Ø©"] },
  { key: "head_of_government", pid: "P6", valueType: "item", labels: { tr: "Hükümet başkanı", en: "Head of government", fr: "Chef du gouvernement", ru: "Ğ“Ğ»Ğ°Ğ²Ğ° Ğ¿Ñ€Ğ°Ğ²Ğ¸Ñ‚ĞµĞ»ÑŒÑÑ‚Ğ²Ğ°", ar: "Ø±Ø¦ÙŠØ³ Ø§Ù„Ø­ÙƒÙˆÙ…Ø©" },
    kw: ["başbakan", "hükümet başkanı", "head of government", "Ğ³Ğ»Ğ°Ğ²Ğ° Ğ¿Ñ€Ğ°Ğ²Ğ¸Ñ‚ĞµĞ»ÑŒÑÑ‚Ğ²Ğ°", "Ø±Ø¦ÙŠØ³ Ø§Ù„Ø­ÙƒÙˆÙ…Ø©"] },

  // Person facts
  { key: "birth", pid: "P569", valueType: "time", labels: { tr: "Doğum tarihi", en: "Date of birth", fr: "Naissance", ru: "Ğ”Ğ°Ñ‚Ğ° Ñ€Ğ¾Ğ¶Ğ´ĞµĞ½Ğ¸Ñ", ar: "ØªØ§Ø±ÙŠØ® Ø§Ù„Ù…ÙŠÙ„Ø§Ø¯" },
    kw: ["doğum", "dogum", "born", "date of birth", "naissance", "Ñ€Ğ¾Ğ´Ğ¸Ğ»ÑÑ", "Ù…ÙŠÙ„Ø§Ø¯"] },
  { key: "death", pid: "P570", valueType: "time", labels: { tr: "Ölüm tarihi", en: "Date of death", fr: "Décès", ru: "Ğ”Ğ°Ñ‚Ğ° ÑĞ¼ĞµÑ€Ñ‚Ğ¸", ar: "ØªØ§Ø±ÙŠØ® Ø§Ù„ÙˆÙØ§Ø©" },
    kw: ["ölüm", "olum", "died", "death", "décès", "ÑƒĞ¼ĞµÑ€", "Ø§Ù„ÙˆÙØ§Ø©"] },
  { key: "occupation", pid: "P106", valueType: "item", labels: { tr: "Meslek", en: "Occupation", fr: "Profession", ru: "ĞŸÑ€Ğ¾Ñ„ĞµÑÑĞ¸Ñ", ar: "Ø§Ù„Ù…Ù‡Ù†Ø©" },
    kw: ["meslek", "occupation", "profession", "Ğ¿Ñ€Ğ¾Ñ„ĞµÑÑĞ¸Ñ", "Ø§Ù„Ù…Ù‡Ù†Ø©"] },
  { key: "citizenship", pid: "P27", valueType: "item", labels: { tr: "Vatandaşlık", en: "Citizenship", fr: "Nationalité", ru: "Ğ“Ñ€Ğ°Ğ¶Ğ´Ğ°Ğ½ÑÑ‚Ğ²Ğ¾", ar: "Ø§Ù„Ø¬Ù†Ø³ÙŠØ©" },
    kw: ["vatandaşlık", "citizenship", "nationalité", "Ğ³Ñ€Ğ°Ğ¶Ğ´Ğ°Ğ½ÑÑ‚Ğ²Ğ¾", "Ø§Ù„Ø¬Ù†Ø³ÙŠØ©"] },
  { key: "spouse", pid: "P26", valueType: "item", labels: { tr: "Eş", en: "Spouse", fr: "Conjoint", ru: "Ğ¡ÑƒĞ¿Ñ€ÑƒĞ³(Ğ°)", ar: "Ø§Ù„Ø²ÙˆØ¬/Ø§Ù„Ø²ÙˆØ¬Ø©" },
    kw: ["eşi", "eş", "spouse", "conjoint", "ÑÑƒĞ¿Ñ€ÑƒĞ³", "Ø§Ù„Ø²ÙˆØ¬"] },
  { key: "educated_at", pid: "P69", valueType: "item", labels: { tr: "Eğitim", en: "Education", fr: "Éducation", ru: "ĞĞ±Ñ€Ğ°Ğ·Ğ¾Ğ²Ğ°Ğ½Ğ¸Ğµ", ar: "Ø§Ù„ØªØ¹Ù„ÙŠÙ…" },
    kw: ["eğitim", "okudu", "education", "éducation", "Ğ¾Ğ±Ñ€Ğ°Ğ·Ğ¾Ğ²Ğ°Ğ½Ğ¸Ğµ", "Ø§Ù„ØªØ¹Ù„ÙŠÙ…"] },
];

function wikilangForWikidata(lang) {
  const L = normalizeLang(lang);
  return L === "tr" ? "tr" : L === "fr" ? "fr" : L === "ru" ? "ru" : L === "ar" ? "ar" : "en";
}

function firstNonEmpty(arr) {
  for (const x of arr || []) {
    const s = safeString(x);
    if (s) return s;
  }
  return "";
}

function stripQuestionNoise(text) {
  const s = safeString(text).toLowerCase();
  if (!s) return "";
  const noise = [
    "nedir", "ne", "kaç", "kim", "hangi", "nerede", "ne zaman", "nasıl",
    "what", "who", "which", "where", "when", "how", "tell me",
    "Ù…Ù†", "Ù…Ø§", "Ù…Ø§Ø°Ø§", "ÙƒÙ…", "Ø£ÙŠÙ†", "Ù…ØªÙ‰", "ÙƒÙŠÙ",
    "Ñ‡Ñ‚Ğ¾", "ĞºÑ‚Ğ¾", "Ğ³Ğ´Ğµ", "ĞºĞ¾Ğ³Ğ´Ğ°", "ĞºĞ°Ğº", "ÑĞºĞ¾Ğ»ÑŒĞºĞ¾",
    "quoi", "qui", "oÃ¹", "quand", "comment",
  ];
  let out = s;
  for (const w of noise) out = out.replace(new RegExp(`\\b${w}\\b`, "gi"), " ");
  return out.replace(/\s+/g, " ").trim();
}

function pickFactProperty(text) {
  const low = safeString(text).toLowerCase();
  if (!low) return null;
  for (const p of FACT_PROPERTIES) {
    for (const k of p.kw) {
      if (!k) continue;
      if (low.includes(k.toLowerCase())) return p;
    }
  }
  return null;
}


function guessEntityHint(text, prop) {
  const low0 = stripQuestionNoise(text);
  if (!low0) return "";

  const kill = [];
  if (prop?.kw) kill.push(...prop.kw);

  // Extra generic words that often pollute entity hints
  kill.push("ülke", "şehir", "belediye", "ilçe", "district", "municipality", "country", "city", "state", "devlet", "insan", "kişi", "person");

  let out = low0;
  const escapeRe = (s) => safeString(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const w0 of kill) {
    const w = safeString(w0).toLowerCase().trim();
    if (!w) continue;

    if (w.includes(" ")) {
      const parts = w.split(/\s+/g).filter(Boolean);
      if (!parts.length) continue;
      const last = parts.pop();
      const body = parts.map(escapeRe).join("\\s+");
      const lastEsc = escapeRe(last);
      const re = body
        ? new RegExp(`\\b${body}\\s+${lastEsc}\\p{L}*\\b`, "giu")
        : new RegExp(`\\b${lastEsc}\\p{L}*\\b`, "giu");
      out = out.replace(re, " ");
    } else {
      if (w.length < 3) continue;
      const re = new RegExp(`\\b${escapeRe(w)}\\p{L}*\\b`, "giu");
      out = out.replace(re, " ");
    }
  }

  out = out
    .replace(/[“”"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Turkish possessives: Türkiye'nin -> Türkiye
  out = out.replace(/\b(\p{L}+)(?:'nin|'nın|'nun|'nün|nin|nın|nun|nün)\b/giu, "$1");

  // Remove common question particles that sometimes survive stripQuestionNoise
  out = out.replace(/\b(nedir|ne|kim|kaç|kac|hangi|nasıl|nasil)\b/gi, " ").replace(/\s+/g, " ").trim();

  const words = out.split(/\s+/).filter(Boolean);
  return words.slice(0, 5).join(" ").trim();
}

const COUNTRY_LIKE_PROPS = new Set([
  "capital",
  "population",
  "currency",
  "official_language",
  "area",
  "calling_code",
  "tld",
  "time_zone",
  "continent",
  "neighbors",
  "anthem",
  "motto",
  "official_website",
  "religion",
  "demonym",
  "head_of_state",
  "head_of_government",
]);

function scoreWikidataCandidate(cand, questionText, prop) {
  const q = safeString(questionText).toLowerCase();
  const label = safeString(cand?.label).toLowerCase();
  const desc = safeString(cand?.desc).toLowerCase();
  if (!label) return -999;

  let s = 0;
  if (desc.includes("disambiguation")) s -= 25;

  const hint = safeString(guessEntityHint(questionText, prop)).toLowerCase();
  if (hint && label === hint) s += 12;
  if (hint && (label.startsWith(hint) || hint.startsWith(label))) s += 5;
  if (q.includes(label)) s += 6;

  // Municipality / district context
  if (/(belediye|ilçe|ilcesi|municipality|district)/i.test(q)) {
    if (/(municipality|district|belediye|ilçe|town|city|şehir)/i.test(desc)) s += 10;
  }

  // Country-ish facts should prefer country / sovereign state
  if (prop?.key && COUNTRY_LIKE_PROPS.has(prop.key)) {
    if (/(country|sovereign|state|republic|ülke|devlet|cumhuriyet)/i.test(desc)) s += 10;
  }

  // Prefer candidates whose label contains important words from hint
  const hWords = hint.split(/\s+/).filter((w) => w.length >= 4);
  if (hWords.length) {
    const matchCount = hWords.reduce((acc, w) => (label.includes(w) ? acc + 1 : acc), 0);
    s += Math.min(6, matchCount * 2);
  }

  // Small penalty for empty descriptions
  if (!desc) s -= 1;
  return s;
}


async function wikidataSearchEntities(search, lang) {
  const q = safeString(search);
  if (!q) return [];
  const wLang = wikilangForWikidata(lang);
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(q)}&language=${encodeURIComponent(wLang)}&format=json&limit=7&origin=*`;
  const data = await fetchJsonCached(url, 24 * 60 * 60 * 1000);
  const arr = Array.isArray(data?.search) ? data.search : [];
  return arr
    .map((x) => ({
      id: safeString(x.id),
      label: safeString(x.label),
      desc: safeString(x.description),
      matchText: safeString(x.match?.text),
    }))
    .filter((x) => x.id && x.label);
}

async function wikidataGetEntities(ids, lang) {
  const list = (ids || []).map((x) => safeString(x)).filter(Boolean);
  if (!list.length) return {};
  const wLang = wikilangForWikidata(lang);
  const url = `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(list.join("|"))}&props=labels|descriptions&languages=${encodeURIComponent(wLang)}&format=json&origin=*`;
  const data = await fetchJsonCached(url, 24 * 60 * 60 * 1000);
  return data?.entities || {};
}

async function wikidataGetEntityData(qid) {
  const id = safeString(qid);
  if (!id) return null;
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(id)}.json`;
  const data = await fetchJsonCached(url, 24 * 60 * 60 * 1000);
  return data?.entities?.[id] || null;
}

function formatWikidataTime(t, lang) {
  const L = normalizeLang(lang);
  const raw = safeString(t);
  if (!raw) return "";
  // raw like +1923-10-29T00:00:00Z
  const m = raw.match(/([+-]?\d{1,4})-(\d{2})-(\d{2})/);
  if (!m) return raw;
  const y = m[1].replace(/^\+/, "");
  const mo = m[2];
  const d = m[3];
  if (L === "tr") return `${d}.${mo}.${y}`;
  if (L === "en") return `${y}-${mo}-${d}`;
  if (L === "fr") return `${d}/${mo}/${y}`;
  if (L === "ru") return `${d}.${mo}.${y}`;
  return `${y}-${mo}-${d}`;
}

function formatQuantity(q) {
  const amount = safeString(q?.amount);
  if (!amount) return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  // wikidata amounts are like "+12345"
  const v = Math.abs(n);
  return v >= 1 ? Math.round(v).toLocaleString("en-US") : String(v);
}

function getLatestClaim(claims = []) {
  if (!Array.isArray(claims) || !claims.length) return null;
  let best = claims[0];
  let bestTime = 0;
  for (const c of claims) {
    const q = c?.qualifiers?.P585?.[0]?.datavalue?.value?.time;
    const m = safeString(q).match(/([+-]?\d{1,4})-(\d{2})-(\d{2})/);
    let t = 0;
    if (m) t = Number(m[1].replace(/^\+/, "")) * 10000 + Number(m[2]) * 100 + Number(m[3]);
    if (t >= bestTime) {
      bestTime = t;
      best = c;
    }
  }
  return best;
}

async function resolveItemLabels(itemIds, lang) {
  const ids = Array.from(new Set((itemIds || []).map((x) => safeString(x)).filter(Boolean))).slice(0, 25);
  if (!ids.length) return {};
  const ent = await wikidataGetEntities(ids, lang);
  const out = {};
  for (const id of ids) {
    const e = ent?.[id];
    const label = firstNonEmpty([e?.labels?.[wikilangForWikidata(lang)]?.value, e?.labels?.en?.value, e?.labels?.tr?.value]);
    out[id] = safeString(label || id);
  }
  return out;
}

async function getFactEvidence(text, lang) {
  const L = normalizeLang(lang);
  const prop = pickFactProperty(text);
  if (!prop) return null;

  const hint = guessEntityHint(text, prop) || compactWords(text, 4) || safeString(text);
  if (!hint) {
    return { type: "clarify", kind: "entity", trustScore: 35 };
  }
  let results = [];
  const overrideId = lookupEntityOverride(hint);
  if (overrideId) {
  results = [{ id: overrideId, label: hint, desc: "Known entity" }]; // ✅ description değil desc
} else {
    results = await wikidataSearchEntities(hint, L);
    if (!results.length) {
      // fallback: resolve by wiki title (trwiki/enwiki), sometimes more reliable than search
      const byTitle = await wikidataGetEntityByWikiTitle(hint, L);
      if (byTitle) results = [byTitle];
    }
  }

  if (!results.length) {
    return {
      type: "no_answer",
      reason: "no_wikidata_entity",
      trustScore: 35,
      hint,
    };
  }

  // Disambiguation heuristic: short hint + multiple reasonable candidates
  if (results.length >= 2) {
    const hWords = hint.split(/\s+/).filter(Boolean);
    const top = results[0];
    const second = results[1];
    const topLabel = safeString(top.label).toLowerCase();
    const secondLabel = safeString(second.label).toLowerCase();
    const ambiguous =
      hWords.length <= 3 &&
      (topLabel === secondLabel || (topLabel.includes(hint.toLowerCase()) && secondLabel.includes(hint.toLowerCase())));
    if (ambiguous) {
      return {
        type: "disambiguation",
        query: safeString(text),
        entityHint: hint,
        property: prop,
        options: results.slice(0, 4),
        trustScore: 45,
        sources: [{ title: "Wikidata Search", url: `https://www.wikidata.org/w/index.php?search=${encodeURIComponent(hint)}` }],
      };
    }
  }

  const chosen = results[0];
  const entity = await wikidataGetEntityData(chosen.id);
  if (!entity) {
    return { type: "no_answer", reason: "no_entity_data", trustScore: 35, hint };
  }

  const claims = entity?.claims?.[prop.pid];
  if (!Array.isArray(claims) || !claims.length) {
    return {
      type: "no_answer",
      reason: "property_missing",
      trustScore: 40,
      hint,
      entityId: chosen.id,
      property: prop,
      sources: [{ title: `Wikidata: ${chosen.label}`, url: `https://www.wikidata.org/wiki/${chosen.id}` }],
    };
  }

  const useClaim = prop.pid === "P1082" ? getLatestClaim(claims) : claims[0];
  const dv = useClaim?.mainsnak?.datavalue?.value;

  let valueText = "";
  let itemIds = [];

  if (prop.valueType === "item") {
    const id = dv?.id;
    if (id) itemIds = [id];
    const labels = await resolveItemLabels(itemIds, L);
    valueText = labels[id] || id || "";
  } else if (prop.valueType === "quantity") {
    valueText = formatQuantity(dv);
    // unit
    const unit = safeString(dv?.unit);
    if (unit && unit.includes("Q")) {
      const uQ = unit.split("/").pop();
      const labels = await resolveItemLabels([uQ], L);
      if (labels[uQ] && !/unit/i.test(labels[uQ])) valueText = `${valueText} ${labels[uQ]}`;
    }
  } else if (prop.valueType === "time") {
    valueText = formatWikidataTime(dv?.time, L);
  } else if (prop.valueType === "monolingual") {
    valueText = safeString(dv?.text || "");
  } else {
    valueText = safeString(dv);
  }

  if (!valueText) {
    return { type: "no_answer", reason: "empty_value", trustScore: 40, hint };
  }

  const label = chosen.label;
  const desc = chosen.desc;
  const propLabel = prop.labels?.[L] || prop.labels?.en || prop.key;

  return {
    type: "fact",
    entity: { id: chosen.id, label, desc },
    property: { key: prop.key, pid: prop.pid, label: propLabel },
    value: valueText,
    trustScore: 88,
    sources: [{ title: `Wikidata: ${label}`, url: `https://www.wikidata.org/wiki/${chosen.id}` }],
  };
}

// ============================================================================
// ECON (World Bank) — free macro indicators
// ============================================================================

const WB_INDICATORS = [
  { key: "inflation", id: "FP.CPI.TOTL.ZG", labels: { tr: "Enflasyon (TÜFE, yıllık %)", en: "Inflation (CPI, annual %)", fr: "Inflation (IPC, % annuel)", ru: "Ğ˜Ğ½Ñ„Ğ»ÑÑ†Ğ¸Ñ (Ğ˜ĞŸĞ¦, %/Ğ³Ğ¾Ğ´)", ar: "Ø§Ù„ØªØ¶Ø®Ù… (Ø³Ù†ÙˆÙŠ %)" },
    kw: ["enflasyon", "inflation", "tüfe", "cpi", "Ø§Ù„ØªØ¶Ø®Ù…", "Ğ¸Ğ½Ñ„Ğ»ÑÑ†"] },
  { key: "unemployment", id: "SL.UEM.TOTL.ZS", labels: { tr: "İşsizlik (%)", en: "Unemployment (%)", fr: "Chômage (%)", ru: "Ğ‘ĞµĞ·Ñ€Ğ°Ğ±Ğ¾Ñ‚Ğ¸Ñ†Ğ° (%)", ar: "Ø§Ù„Ø¨Ø·Ø§Ù„Ø© (%)" },
    kw: ["işsizlik", "unemployment", "chômage", "Ğ±ĞµĞ·Ñ€Ğ°Ğ±Ğ¾Ñ‚", "Ø§Ù„Ø¨Ø·Ø§Ù„Ø©"] },
  { key: "gdp", id: "NY.GDP.MKTP.CD", labels: { tr: "GSYİH (Cari $)", en: "GDP (current US$)", fr: "PIB (US$ courants)", ru: "Ğ’Ğ’ĞŸ (Ñ‚ĞµĞºÑƒÑ‰. Ğ´Ğ¾Ğ»Ğ». Ğ¡Ğ¨Ğ)", ar: "Ø§Ù„Ù†Ø§ØªØ¬ Ø§Ù„Ù…Ø­Ù„ÙŠ (Ø¯ÙˆÙ„Ø§Ø± Ø¬Ø§Ø±ÙŠ)" },
    kw: ["gsyih", "gdp", "gayri safi", "pib", "Ğ²Ğ²Ğ¿", "Ø§Ù„Ù†Ø§ØªØ¬"] },
  { key: "gdp_growth", id: "NY.GDP.MKTP.KD.ZG", labels: { tr: "GSYİH büyümesi (yıllık %)", en: "GDP growth (annual %)", fr: "Croissance du PIB (% annuel)", ru: "Ğ Ğ¾ÑÑ‚ Ğ’Ğ’ĞŸ (%/Ğ³Ğ¾Ğ´)", ar: "Ù†Ù…Ùˆ Ø§Ù„Ù†Ø§ØªØ¬ (%)" },
    kw: ["büyüme", "growth", "croissance", "Ñ€Ğ¾ÑÑ‚", "Ù†Ù…Ùˆ"] },
  { key: "population", id: "SP.POP.TOTL", labels: { tr: "Nüfus", en: "Population", fr: "Population", ru: "ĞĞ°ÑĞµĞ»ĞµĞ½Ğ¸Ğµ", ar: "Ø¹Ø¯Ø¯ Ø§Ù„Ø³ÙƒØ§Ù†" },
    kw: ["nüfus", "population", "Ğ½Ğ°ÑĞµĞ»ĞµĞ½Ğ¸Ğµ", "Ø³ÙƒØ§Ù†"] },
];

function pickWBIndicator(text, lang) {
  const low = safeString(text).toLowerCase();
  if (!low) return null;
  for (const it of WB_INDICATORS) {
    for (const k of it.kw) {
      if (k && low.includes(k.toLowerCase())) return it;
    }
  }
  return null;
}

async function getCountryIso3FromWikidata(text, lang) {
  const L = normalizeLang(lang);
  const hint = compactWords(stripQuestionNoise(text), 3) || compactWords(text, 3);
  if (!hint) return null;
  const results = await wikidataSearchEntities(hint, L);
  if (!results.length) return null;
  const chosen = results[0];
  const entity = await wikidataGetEntityData(chosen.id);
  const claims = entity?.claims?.P298;
  const iso3 = safeString(claims?.[0]?.mainsnak?.datavalue?.value);
  if (!iso3) return null;
  return { iso3, label: chosen.label, qid: chosen.id };
}

async function getWorldBankLatest(iso3, indicatorId) {
  const cc = safeString(iso3).toUpperCase();
  const ind = safeString(indicatorId);
  if (!cc || !ind) return null;
  const url = `https://api.worldbank.org/v2/country/${encodeURIComponent(cc)}/indicator/${encodeURIComponent(ind)}?format=json&per_page=10`;
  const data = await fetchJsonCached(url, 12 * 60 * 60 * 1000);
  const arr = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
  const latest = arr.find((x) => x && x.value != null);
  if (!latest) return null;
  return {
    value: latest.value,
    year: safeString(latest.date),
    indicator: safeString(latest.indicator?.value),
    country: safeString(latest.country?.value),
  };
}

async function getEconEvidence(text, lang) {
  const L = normalizeLang(lang);
  const raw = safeString(text);
  const low = raw.toLowerCase();

  // --- Precious metals spot (Stooq) + FX conversion (Frankfurter) ---
  const metal = (() => {
    if (/(\bxau\b|altın|altin|\bgold\b)/i.test(low)) return { key: "gold", stooq: "xauusd", tr: "Altın", en: "Gold", fr: "Or", ru: "Ğ—Ğ¾Ğ»Ğ¾Ñ‚Ğ¾", ar: "Ø§Ù„Ø°Ù‡Ø¨" };
    if (/(\bxag\b|gümüş|gumus|\bsilver\b)/i.test(low)) return { key: "silver", stooq: "xagusd", tr: "Gümüş", en: "Silver", fr: "Argent", ru: "Ğ¡ĞµÑ€ĞµĞ±Ñ€Ğ¾", ar: "Ø§Ù„ÙØ¶Ø©" };
    if (/(\bxpt\b|platin|\bplatinum\b)/i.test(low)) return { key: "platinum", stooq: "xptusd", tr: "Platin", en: "Platinum", fr: "Platine", ru: "ĞŸĞ»Ğ°Ñ‚Ğ¸Ğ½Ğ°", ar: "Ø§Ù„Ø¨Ù„Ø§ØªÙŠÙ†" };
    if (/(\bxpd\b|paladyum|\bpalladium\b)/i.test(low)) return { key: "palladium", stooq: "xpdusd", tr: "Paladyum", en: "Palladium", fr: "Palladium", ru: "ĞŸĞ°Ğ»Ğ»Ğ°Ğ´Ğ¸Ğ¹", ar: "Ø§Ù„Ø¨Ù„Ø§Ø¯ÙŠÙˆÙ…" };
    return null;
  })();

  const isJewelry = /(bilezik|kolye|yüzük|takı|mücevher|set|küpe|22\s*ayar|24\s*ayar|14\s*ayar)/i.test(low);
  const wantsPrice =
    /(fiyat|price|kaç|kac|ne\s*kadar|spot|anlık|live|today|bugün|rate|tl|try|usd|eur|gbp|dolar|euro|sterlin|â‚º|\$|â‚¬)/i.test(low);

  if (metal && wantsPrice && !isJewelry) {
    const TROY_OUNCE_G = 31.1034768;

    const pickTargetCurrency = () => {
      if (/(\btry\b|\btl\b|lira|â‚º)/i.test(raw)) return "TRY";
      if (/(\beur\b|â‚¬|euro)/i.test(raw)) return "EUR";
      if (/(\bgbp\b|sterlin|pound)/i.test(raw)) return "GBP";
      if (/(\busd\b|\$|dolar)/i.test(raw)) return "USD";
      return L === "tr" ? "TRY" : "USD";
    };

    const target = pickTargetCurrency();

    const stooqUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(metal.stooq)}&f=sd2t2ohlcv&h&e=csv`;
    const csv = await fetchTextCached(stooqUrl, 2 * 60 * 1000);

    const parseStooqQuote = (txt) => {
      const lines = String(txt || "").trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return null;
      const head = lines[0].split(",").map((x) => x.trim());
      const row = lines[1].split(",").map((x) => x.trim());
      const idxDate = head.findIndex((h) => h.toLowerCase() === "date");
      const idxTime = head.findIndex((h) => h.toLowerCase() === "time");
      const idxClose = head.findIndex((h) => h.toLowerCase() === "close");
      const closeStr = row[idxClose >= 0 ? idxClose : row.length - 1];
      const close = Number(String(closeStr || "").replace(",", "."));
      if (!Number.isFinite(close)) return null;
      return { close, date: row[idxDate] || "", time: row[idxTime] || "" };
    };

    const q = parseStooqQuote(csv);
    if (!q) {
      return {
        type: "no_answer",
        reason: "no_metal_quote",
        trustScore: 55,
        sources: [
          { title: "Stooq CSV quote", url: stooqUrl },
        ],
      };
    }

    const ounceUsd = q.close;
    const asOf = [q.date, q.time].filter(Boolean).join(" ").trim();

    let fxRate = 1;
    let fxUrl = null;
    if (target !== "USD") {
      fxUrl = `https://api.frankfurter.app/latest?from=USD&to=${encodeURIComponent(target)}`;
      const fx = await fetchJsonCached(fxUrl, 2 * 60 * 1000);
      const r = fx?.rates?.[target];
      if (Number.isFinite(Number(r))) fxRate = Number(r);
    }

    const ounce = ounceUsd * fxRate;
    const gram = ounce / TROY_OUNCE_G;

    const loc = L === "tr" ? "tr-TR" : L === "fr" ? "fr-FR" : L === "ru" ? "ru-RU" : L === "ar" ? "ar-EG" : "en-US";
    const fmt = (v) => {
      try {
        return new Intl.NumberFormat(loc, { style: "currency", currency: target, maximumFractionDigits: target === "JPY" ? 0 : 2 }).format(v);
      } catch {
        return `${Number(v).toFixed(2)} ${target}`;
      }
    };

    const metalLabel = metal[L] || metal.en || metal.tr;

    return {
      type: "econ",
      kind: "metals",
      metal: metalLabel,
      currency: target,
      ounce: { value: ounce, text: `${fmt(ounce)} / oz` },
      gram: { value: gram, text: `${fmt(gram)} / g` },
      asOf,
      note:
        L === "tr"
          ? "Not: Bu **global spot** fiyattır. Kuyumcu/banka fiyatlarında **prim, vergi, işçilik, spread** farkı olur."
          : L === "fr"
          ? "Note : prix **spot mondial**. Les prix bijoutiers/banques incluent **prime, taxes, frais, spread**."
          : L === "ru"
          ? "ĞŸÑ€Ğ¸Ğ¼ĞµÑ‡Ğ°Ğ½Ğ¸Ğµ: ÑÑ‚Ğ¾ **Ğ³Ğ»Ğ¾Ğ±Ğ°Ğ»ÑŒĞ½Ğ°Ñ ÑĞ¿Ğ¾Ñ‚-Ñ†ĞµĞ½Ğ°**. Ğ’ Ğ±Ğ°Ğ½ĞºĞ°Ñ…/ÑĞ²ĞµĞ»Ğ¸Ñ€Ğ°Ñ… ĞµÑÑ‚ÑŒ **Ğ¿Ñ€ĞµĞ¼Ğ¸Ñ, Ğ½Ğ°Ğ»Ğ¾Ğ³Ğ¸, Ğ½Ğ°Ñ†ĞµĞ½ĞºĞ°, ÑĞ¿Ñ€ĞµĞ´**."
          : L === "ar"
          ? "Ù…Ù„Ø§Ø­Ø¸Ø©: Ù‡Ø°Ø§ Ø³Ø¹Ø± **ÙÙˆØ±ÙŠ Ø¹Ø§Ù„Ù…ÙŠ**. Ø£Ø³Ø¹Ø§Ø± Ø§Ù„Ø¨Ù†ÙˆÙƒ/Ø§Ù„ØµØ§ØºØ© ØªØ´Ù…Ù„ **Ø¹Ù„Ø§ÙˆØ©ØŒ Ø¶Ø±Ø§Ø¦Ø¨ØŒ ØªÙƒØ§Ù„ÙŠÙØŒ ÙØ§Ø±Ù‚ Ø³Ø¹Ø±**."
          : "Note: this is the **global spot** price. Retail/bank quotes include **premium, taxes, fees, spread**.",
      trustScore: 84,
      sources: [
        { title: `Stooq: ${metal.stooq.toUpperCase()} quote (CSV)`, url: stooqUrl },
        ...(fxUrl ? [{ title: "Frankfurter (ECB rates)", url: fxUrl }] : []),
      ],
    };
  }

  // --- World Bank indicators (macro) ---
  const ind = pickWBIndicator(text, L);
  if (!ind) return null;

  const country = await getCountryIso3FromWikidata(text, L);
  if (!country) {
    return { type: "clarify", kind: "country", trustScore: 40 };
  }

  const wb = await getWorldBankLatest(country.iso3, ind.id);
  if (!wb) {
    return {
      type: "no_answer",
      reason: "no_worldbank_data",
      trustScore: 45,
      sources: [{ title: "World Bank API", url: "https://datahelpdesk.worldbank.org/knowledgebase/articles/889392" }],
    };
  }

  const label = ind.labels?.[L] || ind.labels?.en || ind.key;
  const valNum = Number(wb.value);
  const valText = Number.isFinite(valNum)
    ? (ind.key.includes("inflation") || ind.key.includes("unemployment") || ind.key.includes("growth")
        ? `${valNum.toFixed(2)}%`
        : Math.round(valNum).toLocaleString("en-US"))
    : safeString(wb.value);

  return {
    type: "econ",
    indicator: label,
    country: country.label,
    year: wb.year,
    value: valText,
    trustScore: 78,
    sources: [
      { title: `World Bank: ${country.label} — ${label}`, url: `https://data.worldbank.org/indicator/${encodeURIComponent(ind.id)}?locations=${encodeURIComponent(country.iso3)}` },
    ],
  };
}

// ============================================================================
// SPORTS — headlines via RSS (free)
// ============================================================================

async function getSportsEvidence(text, lang) {
  const L = normalizeLang(lang);
  const q = (compactWords(text, 6) || safeString(text)).trim();
  if (!q) return null;
  // Force sports context
  const query = L === "tr" ? `${q} spor` : `${q} sports`;
  const hl = L === "tr" ? "tr" : "en";
  const gl = L === "tr" ? "TR" : "US";
  const ceid = L === "tr" ? "TR:tr" : "US:en";

  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
  const xml = await fetchTextCached(rssUrl, 2 * 60 * 1000);
  if (!xml) return null;

  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1] || "";
    const title = decodeHtmlEntities((block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = decodeHtmlEntities((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    const pubDate = decodeHtmlEntities((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    if (title && link) items.push({ title: safeString(title), url: safeString(link), date: safeString(pubDate) });
    if (items.length >= 5) break;
  }
  if (!items.length) return null;

  return {
    type: "sports",
    query,
    items,
    trustScore: 68,
    sources: items.map((x) => ({ title: x.title, url: x.url })).slice(0, 5),
  };
}

// ============================================================================
// SCHOLAR — PubMed + Crossref (free)
// ============================================================================
async function getScholarEvidence(text, lang) {
  const L = normalizeLang(lang);
  const q = (compactWords(text, 10) || safeString(text)).trim();
  if (!q) return null;

  // 1) PubMed
  try {
    const term = encodeURIComponent(q);
    const esUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${term}&retmode=json&retmax=5&sort=relevance`;
    const es = await fetchJsonCached(esUrl, 6 * 60 * 60 * 1000);
    const ids = es?.esearchresult?.idlist || [];
    if (Array.isArray(ids) && ids.length) {
      const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(ids.join(","))}&retmode=json`;
      const sum = await fetchJsonCached(sumUrl, 6 * 60 * 60 * 1000);
      const uids = sum?.result?.uids || [];
      const items = [];

      for (const id of uids.slice(0, 5)) {
        const row = sum?.result?.[id];
        const title = safeString(row?.title || "");
        const source = safeString(row?.fulljournalname || row?.source || "");
        const pub = safeString(row?.pubdate || "");
        const year = (pub.match(/\b(19|20)\d{2}\b/) || [])[0] || "";
        if (!title) continue;
        items.push({
          title,
          year,
          source,
          url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        });
      }

      if (items.length) {
        return {
          type: "scholar",
          query: q,
          items,
          trustScore: 74,
          sources: [{ title: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/" }],
        };
      }
    }
  } catch {
    // fall through
  }

  // 2) Crossref fallback
   // 2) Crossref fallback
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=5`;
    const cr = await fetchJsonCached(url, 6 * 60 * 60 * 1000);
    const arr = cr?.message?.items || [];
    const items = [];

    for (const it of arr.slice(0, 5)) {
      const title = safeString(Array.isArray(it?.title) ? it.title[0] : it?.title);
      if (!title) continue;

      const year =
        safeString(it?.issued?.["date-parts"]?.[0]?.[0]) ||
        safeString(it?.created?.["date-parts"]?.[0]?.[0]) ||
        "";

      const source = safeString(Array.isArray(it?.["container-title"]) ? it["container-title"][0] : it?.["container-title"]);
      const doi = safeString(it?.DOI || "");
      const link = safeString(it?.URL || (doi ? `https://doi.org/${doi}` : ""));

      items.push({ title, year, source, url: link });
    }

    if (items.length) {
      return {
        type: "scholar",
        query: q,
        items,
        trustScore: 70,
        sources: [{ title: "Crossref", url: "https://api.crossref.org/" }],
      };
    }
  } catch {
    // ignore
  }

  return null;
}


// ============================================================================
// POI — OpenStreetMap (Overpass) + Open-Meteo geocode (free) — S60
// ============================================================================

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function hashStringDjb2(str = "") {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

async function fetchJsonPostCached(url, body, ttlMs = EVIDENCE_DEFAULT_TTL_MS) {
  const key = `post:${url}:${hashStringDjb2(String(body || ""))}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    timeout: 9000,
    headers: {
      "User-Agent": "FindAllEasy-SonoAI/1.0",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json",
    },
    body: String(body || ""),
  });
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (data) cacheSet(key, data, ttlMs);
  return data;
}

function inferPoiMode(text = "") {
  const low = safeString(text).toLowerCase();
  if (/(kahvaltı|breakfast|brunch)/i.test(low)) return "breakfast";
  if (/(restoran|restaurant|yemek|eat)/i.test(low)) return "food";
  if (/(kafe|cafe|coffee)/i.test(low)) return "cafe";
  if (/(otel|hotel)/i.test(low)) return "hotel";
  if (/(müze|muze|museum|tarihi|historic|antik)/i.test(low)) return "culture";
  return "mixed";
}

function osmMapUrl(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return "";
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
}

async function getPoiEvidence(text, lang, cityHint) {
  const L = normalizeLang(lang);
  const city = pickCity(text, cityHint);
  if (!city) return { type: "need_city" };

  const g = await geocodeCity(city, L);
  if (!g) return null;

  const mode = inferPoiMode(text);

  // Overpass query: pick a few tags, keep it light.
  const around = mode === "hotel" ? 6000 : 4000;

  const blocks = [];
  if (mode === "cafe" || mode === "mixed") blocks.push(`node["amenity"="cafe"](around:${around},${g.lat},${g.lon});`);
  if (mode === "food" || mode === "breakfast" || mode === "mixed")
    blocks.push(`node["amenity"="restaurant"](around:${around},${g.lat},${g.lon});`);
  if (mode === "breakfast")
    blocks.push(`node["amenity"="cafe"]["cuisine"~"breakfast|brunch"](around:${around},${g.lat},${g.lon});`);
  if (mode === "hotel" || mode === "mixed") blocks.push(`node["tourism"="hotel"](around:${around},${g.lat},${g.lon});`);
  if (mode === "culture" || mode === "mixed") {
    blocks.push(`node["tourism"="museum"](around:${around},${g.lat},${g.lon});`);
    blocks.push(`node["tourism"="attraction"](around:${around},${g.lat},${g.lon});`);
    blocks.push(`node["historic"](around:${around},${g.lat},${g.lon});`);
  }

  const query = `[out:json][timeout:8];(${blocks.join("\n")});out 25;`;
  const data = await fetchJsonPostCached(OVERPASS_URL, `data=${encodeURIComponent(query)}`, 5 * 60 * 1000);
  const els = Array.isArray(data?.elements) ? data.elements : [];
  const items = [];

  for (const el of els) {
    const name = safeString(el?.tags?.name || "");
    const lat = typeof el?.lat === "number" ? el.lat : null;
    const lon = typeof el?.lon === "number" ? el.lon : null;
    if (!name || lat == null || lon == null) continue;

    const noteParts = [];
    if (el?.tags?.amenity) noteParts.push(el.tags.amenity);
    if (el?.tags?.tourism) noteParts.push(el.tags.tourism);
    if (el?.tags?.historic) noteParts.push(el.tags.historic);

    items.push({
      name,
      note: noteParts.length ? noteParts.join(" • ") : "",
      url: osmMapUrl(lat, lon),
    });

    if (items.length >= 10) break;
  }

  if (!items.length) {
    return {
      type: "no_answer",
      reason: "poi_empty",
      trustScore: 50,
      sources: [{ title: "OpenStreetMap (Overpass)", url: "https://overpass-api.de/" }],
      suggestions: [],
    };
  }

  return {
    type: "poi",
    city: g.name,
    items,
    trustScore: 78,
    sources: [{ title: "OpenStreetMap (Overpass)", url: "https://overpass-api.de/" }],
  };
}

// ============================================================================
// TRAVEL — evidence-backed: Wiki summary + POI extraction — S60
// ============================================================================

async function getTravelEvidence(text, lang, cityHint) {
  const L = normalizeLang(lang);
  const city = pickCity(text, cityHint);
  if (!city) return { type: "need_city" };

  const g = await geocodeCity(city, L);
  if (!g) return null;

  const wiki = await getWikiEvidence(g.name, L).catch(() => null);
  const poiCulture = await getPoiEvidence(`${g.name} müze tarihi yer`, L, g.name).catch(() => null);
  const poiFood = await getPoiEvidence(`${g.name} restoran kafe`, L, g.name).catch(() => null);

  const see = Array.isArray(poiCulture?.items) ? poiCulture.items.map((x) => x.name).slice(0, 6) : [];
  const eat = Array.isArray(poiFood?.items) ? poiFood.items.map((x) => x.name).slice(0, 6) : [];

  const sections = {
    see,
    do: [],
    eat,
    tips: [],
  };

  // “tips” = kaynaklı, genel olmayan minik yönlendirme
  if (wiki?.sources?.[0]?.url) {
    sections.tips.push(L === "tr" ? "Şehir özeti ve arka plan için Wikipedia bağlantısına bak." : "See Wikipedia link for city overview.");
  }
  sections.tips.push(L === "tr" ? "Yerler listesi OpenStreetMap verisinden gelir; açılış saatleri için mekân sayfasını kontrol et." : "Places list is from OpenStreetMap; check each place page for hours.");

  const sources = [];
  if (wiki?.sources?.length) sources.push(...wiki.sources.slice(0, 1));
  sources.push({ title: "OpenStreetMap (Overpass)", url: "https://overpass-api.de/" });

  return {
    type: "travel",
    city: g.name,
    sections,
    itinerary: [],
    trustScore: 72,
    sources,
  };
}

// ============================================================================
// RECIPE — TheMealDB (free, best-effort) — S60
// ============================================================================

async function getRecipeEvidence(text, lang) {
  const L = normalizeLang(lang);
  const q = stripQuestionNoise(text) || compactWords(text, 5) || safeString(text);
  if (!q) return null;

  const url = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`;
  const data = await fetchJsonCached(url, 12 * 60 * 60 * 1000);
  const meal = Array.isArray(data?.meals) ? data.meals[0] : null;
  if (!meal) {
    return { type: "no_answer", reason: "recipe_empty", trustScore: 45, sources: [{ title: "TheMealDB", url: "https://www.themealdb.com/" }], suggestions: [] };
  }

  const title = safeString(meal?.strMeal || q);
  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const ing = safeString(meal?.[`strIngredient${i}`] || "");
    const mea = safeString(meal?.[`strMeasure${i}`] || "");
    if (!ing) continue;
    ingredients.push(mea ? `${mea} ${ing}`.trim() : ing);
  }

  const stepsRaw = safeString(meal?.strInstructions || "");
  const steps = stepsRaw
    .split(/\r?\n|\. +/g)
    .map((s) => safeString(s))
    .filter((s) => s.length >= 6)
    .slice(0, 15);

  const src = safeString(meal?.strSource || "");
  const ytb = safeString(meal?.strYoutube || "");

  const sources = [{ title: "TheMealDB", url: "https://www.themealdb.com/" }];
  if (src) sources.unshift({ title: "Recipe source", url: src });

  return {
    type: "recipe",
    title,
    ingredients,
    steps,
    trustScore: 70,
    sources: sources.slice(0, 5),
    suggestions:
      L === "tr" ? ["mercimek çorbası tarifi", "kek tarifi", "makarna tarifi", "tavuk tarifi"]
               : ["chicken recipe", "pasta recipe", "cake recipe", "soup recipe"],
  };
}

// ============================================================================
// Evidence dispatcher — tek kapı (info mode) — S60
// ============================================================================

async function getEvidence(text, lang, memorySnapshot = {}) {
  const t = detectEvidenceType(text, lang);
  if (!t || t === "none") return null;

  if (t === "weather") return await getWeatherEvidence(text, lang, memorySnapshot.lastCity);
  if (t === "news") return await getNewsEvidence(text, lang);
  if (t === "fx") return await getFxEvidence(text, lang);
  if (t === "metals") return await getMetalsEvidence({ text, lang });
  if (t === "poi") return await getPoiEvidence(text, lang, memorySnapshot.lastCity);
  if (t === "travel") return await getTravelEvidence(text, lang, memorySnapshot.lastCity);
  if (t === "recipe") return await getRecipeEvidence(text, lang);
  if (t === "firsts") return await getFirstsEvidence(text, lang);
  if (t === "fact") return await getFactEvidence(text, lang);
  if (t === "econ") return await getEconEvidence(text, lang);
  if (t === "sports") return await getSportsEvidence(text, lang);
  if (t === "scholar") return await getScholarEvidence(text, lang);
  if (t === "science") return await getWikiEvidence(text, lang); // “science” yoksa wiki’ye düş
  if (t === "wiki") return await getWikiEvidence(text, lang);

  return null;
}
async function getPubMedPapers(query) {
  const q = safeString(query);
  if (!q) return [];
  const sUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=5&term=${encodeURIComponent(q)}`;
  const s = await fetchJsonCached(sUrl, 6 * 60 * 60 * 1000);
  const ids = Array.isArray(s?.esearchresult?.idlist) ? s.esearchresult.idlist.slice(0, 5) : [];
  if (!ids.length) return [];
  const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${encodeURIComponent(ids.join(","))}`;
  const sum = await fetchJsonCached(sumUrl, 6 * 60 * 60 * 1000);
  const res = sum?.result || {};
  const out = [];
  for (const id of ids) {
    const it = res?.[id];
    if (!it) continue;
    out.push({
      title: safeString(it.title),
      year: safeString(it.pubdate).slice(0, 4),
      source: safeString(it.fulljournalname || it.source),
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    });
  }
  return out.filter((x) => x.title && x.url);
}

async function getCrossrefPapers(query) {
  const q = safeString(query);
  if (!q) return [];
  const url = `https://api.crossref.org/works?rows=5&query=${encodeURIComponent(q)}`;
  const data = await fetchJsonCached(url, 6 * 60 * 60 * 1000);
  const items = Array.isArray(data?.message?.items) ? data.message.items.slice(0, 5) : [];
  const out = [];
  for (const it of items) {
    const title = safeString(Array.isArray(it.title) ? it.title[0] : it.title);
    const doi = safeString(it.DOI);
    const year = safeString(it.created?.["date-time"]).slice(0, 4) || safeString(it.published?.["date-parts"]?.[0]?.[0]);
    const journal = safeString(Array.isArray(it["container-title"]) ? it["container-title"][0] : it["container-title"]);
    if (!title) continue;
    out.push({
      title,
      year: safeString(year),
      source: journal,
      url: doi ? `https://doi.org/${doi}` : safeString(it.URL),
    });
  }
  return out.filter((x) => x.title && x.url);
}

async function getScholarEvidence(text, lang) {
  const q = compactWords(text, 10) || safeString(text);
  if (!q) return null;
  const pub = await getPubMedPapers(q);
  const cr = pub.length ? [] : await getCrossrefPapers(q);
  const items = (pub.length ? pub : cr).slice(0, 5);
  if (!items.length) {
    return { type: "no_answer", reason: "no_scholar_hits", trustScore: 45 };
  }
  return {
    type: "scholar",
    query: q,
    items,
    trustScore: 72,
    sources: items.map((x) => ({ title: x.title, url: x.url })).slice(0, 5),
  };
}

function parseMealIngredients(meal) {
  const out = [];
  if (!meal || typeof meal !== "object") return out;
  for (let i = 1; i <= 20; i++) {
    const ing = safeString(meal[`strIngredient${i}`]);
    const meas = safeString(meal[`strMeasure${i}`]);
    if (ing) out.push(meas ? `${ing} (${meas})` : ing);
  }
  return out;
}

function splitSteps(instructions) {
  const txt = safeString(instructions);
  if (!txt) return [];
  const parts = txt
    .replace(/\r/g, "")
    .split(/\n+|\.(?=\s)/)
    .map((x) => safeString(x))
    .filter(Boolean)
    .map((x) => x.replace(/\s+/g, " "));
  // keep it readable
  const uniq = [];
  for (const p of parts) {
    if (p.length < 8) continue;
    if (uniq.includes(p)) continue;
    uniq.push(p);
    if (uniq.length >= 15) break;
  }
  return uniq;
}

async function getRecipeEvidence(text, lang) {
  const q = safeString(text);
  if (!q) return null;

  // Try a best-effort: use compact query
  const topic = compactWords(q, 5) || q;
  const url = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(topic)}`;
  const data = await fetchJsonCached(url, 12 * 60 * 60 * 1000);
  const meal = data?.meals?.[0];
  if (!meal) return null;

  const title = safeString(meal.strMeal || topic);
  const ingredients = parseMealIngredients(meal);
  const steps = splitSteps(meal.strInstructions);
  const srcUrl = safeString(meal.strSource || meal.strYoutube || "");

  return {
    type: "recipe",
    title,
    ingredients,
    steps,
    trustScore: srcUrl ? 78 : 70,
    sources: srcUrl ? [{ title: "Recipe source", url: srcUrl }] : [{ title: "TheMealDB", url: "https://www.themealdb.com/" }],
  };
}



// --- Simple science facts (deterministic, no-hallucination) ---
async function getScienceEvidence(text, lang) {
  const L = normalizeLang(lang);
  const q = safeString(text).toLowerCase();

  // 1) Water boiling point
  if (/(\bsu\b|water)/i.test(q) && /(kayn|boil)/i.test(q)) {
    const answerTr = "Su, deniz seviyesinde (1 atm basınçta) yaklaşık 100°C'de kaynar. Basınç azalınca (yüksek rakım) kaynama sıcaklığı düşer.";
    const answerEn = "Water boils at about 100°C at sea level (1 atm). As pressure decreases (higher altitude), the boiling point drops.";
    return {
      type: "science",
      title: L === "tr" ? "Su'nun kaynama noktası" : "Boiling point of water",
      extract: L === "tr" ? answerTr : answerEn,
      trustScore: 92,
      sources: [
        { title: "Wikipedia: Boiling point", url: "https://en.wikipedia.org/wiki/Boiling_point" },
        { title: "Wikipedia: Water", url: "https://en.wikipedia.org/wiki/Water" },
      ],
    };
  }

  // 2) Water freezing point
  if (/(\bsu\b|water)/i.test(q) && /(don|freez)/i.test(q)) {
    const answerTr = "Su, 1 atm basınçta yaklaşık 0°C'de donar (saf su). Çözeltiler/tuzluluk donma noktasını düşürür.";
    const answerEn = "Pure water freezes at about 0°C at 1 atm. Solutes/salinity lower the freezing point.";
    return {
      type: "science",
      title: L === "tr" ? "Su'nun donma noktası" : "Freezing point of water",
      extract: L === "tr" ? answerTr : answerEn,
      trustScore: 90,
      sources: [
        { title: "Wikipedia: Freezing", url: "https://en.wikipedia.org/wiki/Freezing" },
        { title: "Wikipedia: Water", url: "https://en.wikipedia.org/wiki/Water" },
      ],
    };
  }

  // Generic fallback (let wiki/LLM handle, but prefer null over wrong)
  return null;
}

function detectPoiCategory(text = "") {
  const low = safeString(text).toLowerCase();
  if (/(sahil|plaj|beach|\u0634\u0627\u0637\u0626)/i.test(low)) return "beach";
  if (/(tekne|boat|marina|iskele|pier|\u0642\u0627\u0631\u0628)/i.test(low)) return "marina";
  if (/(kahvalt\u0131|brunch)/i.test(low)) return "breakfast";
  if (/(kafe|cafe|coffee|\u0642\u0647\u0648\u0629)/i.test(low)) return "cafe";
  if (/(restoran|restaurant|\u0645\u0637\u0639\u0645)/i.test(low)) return "restaurant";
  return "food";
}

async function overpassQuery(query, ttlMs = 5 * 60 * 1000) {
  const key = `overpass:${query}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetchWithTimeout("https://overpass-api.de/api/interpreter", {
    method: "POST",
    timeout: 12000,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "FindAllEasy-SonoAI/1.0",
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (data) cacheSet(key, data, ttlMs);
  return data;
}

async function getPoiEvidence(text, lang, cityHint) {
  const city = pickCity(text, cityHint);
  if (!city) return { type: "need_city" };
  const g = await geocodeCity(city, lang);
  if (!g) return null;

  const cat = detectPoiCategory(text);
  const radius = 6000;

  const qParts = [];
  if (cat in {"cafe":1, "food":1, "breakfast":1, "restaurant":1}) {
  }
  // Compose Overpass filters
  let filters = [];
  if (cat === "beach") {
    filters = [
      '["natural"="beach"]',
      '["leisure"="beach_resort"]',
    ];
  } else if (cat === "marina") {
    filters = [
      '["leisure"="marina"]',
      '["man_made"="pier"]',
      '["harbour"="yes"]',
    ];
  } else {
    // food/cafe/restaurant/breakfast
    const wantsCafe = cat in {"cafe":1, "food":1, "breakfast":1};
    const wantsRest = cat in {"restaurant":1, "food":1, "breakfast":1};
    filters = [];
    if (wantsCafe) filters.push('["amenity"="cafe"]');
    if (wantsRest) filters.push('["amenity"="restaurant"]');
    if (cat === "breakfast") filters.push('["amenity"="fast_food"]');
  }

  const blocks = [];
  for (const f of filters) {
    blocks.push(`node(around:${radius},${g.lat},${g.lon})${f};`);
    blocks.push(`way(around:${radius},${g.lat},${g.lon})${f};`);
    blocks.push(`relation(around:${radius},${g.lat},${g.lon})${f};`);
  }

  const query = `[out:json][timeout:12];(\n${blocks.join("\n")}\n);out center 30;`;
  const data = await overpassQuery(query, 5 * 60 * 1000);
  const elements = (data?.elements || []).slice(0, 60);

  const items = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const name = safeString(tags.name || tags["name:en"] || tags["name:tr"] || "");
    if (!name) continue;
    const lat = el.lat || el.center?.lat;
    const lon = el.lon || el.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + ',' + lon)}`;
    const note = safeString(tags.amenity || tags.natural || tags.leisure || tags.man_made || tags.harbour || "");
    items.push({ name, note, url });
    if (items.length >= 10) break;
  }

  if (!items.length) return null;

  const trustScore = 82;

  return {
    type: "poi",
    city: g.name,
    category: cat,
    items,
    trustScore,
    sources: [
      { title: "OpenStreetMap (Overpass)", url: "https://www.openstreetmap.org/" },
      { title: "Overpass API", url: "https://overpass-api.de/" },
    ],
  };
}

function pickTravelTopic(text, lang, cityHint) {
  const city = pickCity(text, cityHint);
  if (city) return city;
  // fallback: compact topic
  const cleaned = compactWords(text, 4);
  return cleaned || safeString(text);
}

async function wikivoyageSearch(topic, lang) {
  const L = pickWikiLang(lang);
  const base = `https://${L}.wikivoyage.org/w/api.php`;
  const sUrl = `${base}?action=query&list=search&srsearch=${encodeURIComponent(topic)}&format=json&origin=*&srlimit=5`;
  const search = await fetchJsonCached(sUrl, 24 * 60 * 60 * 1000);
  const arr = (search?.query?.search || []).slice(0, 5);
  if (!arr.length) return null;
  let best = arr[0];
  let bestScore = -1;
  for (const cand of arr) {
    const sc = scoreCandidate(topic, cand?.title, cand?.snippet);
    if (sc > bestScore) {
      bestScore = sc;
      best = cand;
    }
  }
  return { title: safeString(best?.title || topic), score: bestScore };
}

async function wikivoyageSections(title, lang) {
  const L = pickWikiLang(lang);
  const base = `https://${L}.wikivoyage.org/w/api.php`;
  const secUrl = `${base}?action=parse&page=${encodeURIComponent(title)}&prop=sections&format=json&origin=*`;
  const sec = await fetchJsonCached(secUrl, 24 * 60 * 60 * 1000);
  const sections = sec?.parse?.sections || [];
  return Array.isArray(sections) ? sections : [];
}

async function wikivoyageSectionHtml(title, sectionIndex, lang) {
  const L = pickWikiLang(lang);
  const base = `https://${L}.wikivoyage.org/w/api.php`;
  const url = `${base}?action=parse&page=${encodeURIComponent(title)}&prop=text&section=${encodeURIComponent(sectionIndex)}&format=json&origin=*`;
  const data = await fetchJsonCached(url, 24 * 60 * 60 * 1000);
  const html = data?.parse?.text?.["*"] || "";
  return safeString(html);
}

function extractListItems(html) {
  const out = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const t = stripTags(m[1] || "");
    if (!t || t.length < 3) continue;
    // avoid nav/empty
    if (/^\^/i.test(t)) continue;
    out.push(t);
    if (out.length >= 20) break;
  }
  // dedupe
  const uniq = [];
  for (const x of out) {
    if (!uniq.includes(x)) uniq.push(x);
    if (uniq.length >= 12) break;
  }
  return uniq;
}

function mapTravelSections(sections, lang) {
  const L = normalizeLang(lang);
  const matches = {
    see: [],
    do: [],
    eat: [],
    tips: [],
  };

  const keys = {
    tr: {
      see: [/\bg\u00f6r\b/i, /\bg\u00f6r\u00fclecek\b/i],
      do: [/\byap\b/i, /\betkinlik\b/i],
      eat: [/yeme/i, /ye\s*\/?\s*i\u00e7/i, /\bi\u00e7\b/i],
      tips: [/ipu\u00e7/i, /\bpratik\b/i, /\bt\u00fcyo\b/i],
    },
    en: {
      see: [/\bsee\b/i],
      do: [/\bdo\b/i, /\bactivities\b/i],
      eat: [/\beat\b/i, /\bdrink\b/i, /\beat and drink\b/i],
      tips: [/\btips\b/i, /\bstay safe\b/i, /\bcope\b/i],
    },
    fr: {
      see: [/\bvoir\b/i, /\b\u00e0 voir\b/i],
      do: [/\bfaire\b/i, /\b\u00e0 faire\b/i],
      eat: [/manger/i, /boire/i],
      tips: [/conseil/i, /s\u00e9curit\u00e9/i],
    },
    ru: {
      see: [/\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c/i, /\u0447\u0442\u043e\s*\u043f\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c/i],
      do: [/\u0447\u0435\u043c\s*\u0437\u0430\u043d\u044f\u0442\u044c\u0441\u044f/i, /\u0434\u0435\u043b\u0430\u0442\u044c/i],
      eat: [/\u0435\u0434\u0430/i, /\u043f\u0438\u0442\u0430\u043d\u0438\u0435/i],
      tips: [/\u0441\u043e\u0432\u0435\u0442/i, /\u0431\u0435\u0437\u043e\u043f\u0430\u0441\u043d/i],
    },
    ar: {
      see: [/\u0645\u0634\u0627\u0647\u062f\u0629/i, /\u0627\u0646\u0638\u0631/i],
      do: [/\u0623\u0646\u0634\u0637\u0629/i, /\u0627\u0641\u0639\u0644/i],
      eat: [/\u0645\u0623\u0643\u0648\u0644\u0627\u062a/i, /\u0645\u0634\u0631\u0648\u0628\u0627\u062a/i, /\u0643\u0644/i],
      tips: [/\u0646\u0635\u0627\u0626\u062d/i, /\u0623\u0645\u0627\u0646/i],
    },
  };

  const K = keys[L] || keys.tr;

  for (const s of sections) {
    const heading = safeString(s?.line || s?.anchor || "");
    const idx = s?.index;
    if (!heading || idx == null) continue;

    const test = heading;
    if (K.see.some((r) => r.test(test))) matches.see.push({ idx, heading });
    else if (K.do.some((r) => r.test(test))) matches.do.push({ idx, heading });
    else if (K.eat.some((r) => r.test(test))) matches.eat.push({ idx, heading });
    else if (K.tips.some((r) => r.test(test))) matches.tips.push({ idx, heading });
  }

  return matches;
}

async function getTravelEvidence(text, lang, cityHint) {
  const topic = pickTravelTopic(text, lang, cityHint);
  if (!topic) return null;

  // Try user's language first; fallback to EN
  const primary = await wikivoyageSearch(topic, lang);
  let useLang = pickWikiLang(lang);
  let chosen = primary;
  if (!chosen) {
    useLang = "en";
    chosen = await wikivoyageSearch(topic, "en");
  }
  if (!chosen) return null;

  const title = chosen.title;
  const sections = await wikivoyageSections(title, useLang);
  const mapped = mapTravelSections(sections, useLang);

  const outSections = { see: [], do: [], eat: [], tips: [] };

  // fetch html for up to 1 section per category
  const tasks = [];
  for (const k of ["see", "do", "eat", "tips"]) {
    const s = (mapped[k] || [])[0];
    if (!s) continue;
    tasks.push((async () => {
      const html = await wikivoyageSectionHtml(title, s.idx, useLang);
      const items = extractListItems(html);
      if (items.length) outSections[k] = items;
    })());
  }
  await Promise.allSettled(tasks);

  // itinerary: simple mix
  const itinerary = [];
  const seeTop = (outSections.see || []).slice(0, 2);
  const doTop = (outSections.do || []).slice(0, 2);
  const eatTop = (outSections.eat || []).slice(0, 2);
  if (seeTop[0]) itinerary.push(seeTop[0]);
  if (doTop[0]) itinerary.push(doTop[0]);
  if (eatTop[0]) itinerary.push(eatTop[0]);
  if (seeTop[1]) itinerary.push(seeTop[1]);
  if (doTop[1]) itinerary.push(doTop[1]);
  if (eatTop[1]) itinerary.push(eatTop[1]);

  const pageUrl = `https://${useLang}.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/\s/g, "_"))}`;

  // Multi-source: try wikipedia summary for topic
  const wiki = await getWikiEvidence(topic, useLang).catch(() => null);

  const sources = [{ title: `Wikivoyage: ${title}`, url: pageUrl }];
  if (wiki?.sources?.[0]) sources.push(wiki.sources[0]);

  const itemCount = ["see","do","eat","tips"].reduce((acc,k)=>acc+(Array.isArray(outSections[k])?outSections[k].length:0),0);

  let trustScore = 72;
  if (itemCount >= 6) trustScore += 6;
  if (wiki) trustScore += 8;
  trustScore = Math.max(55, Math.min(92, trustScore));

  return {
    type: "travel",
    city: title,
    sections: outSections,
    itinerary: itinerary.slice(0, 6),
    trustScore,
    sources,
  };
}

async function gatherEvidence({ text, lang, city }) {
  const L = normalizeLang(lang);
  const type = detectEvidenceType(text, L);
  const safeCity = safeString(city) || inferCity(text, L);

  try {
    switch (type) {
      case "fx":
        return await getFxEvidence(text, L);
      case "weather":
        return await getWeatherEvidence(text, L, safeCity);
      case "news":
        return await getNewsEvidence(text, L);
      case "wiki":
        return await getWikiEvidence(text, L);
      case "travel":
        return await getTravelEvidence(text, L);
      case "poi":
        return await getPoiEvidence(text, L, safeCity);
      case "metals":
        return await getMetalsEvidence(text, L);
      case "recipe":
        return await getRecipeEvidence(text, L);
      case "firsts":
        return await getFirstsEvidence(text, L);
      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}


// S50 — LLM cevabı sanitize
function sanitizeLLMAnswer(answer, normLocale) {
  let txt = clampText(answer, MAX_LLM_ANSWER_LENGTH);
  if (!txt) {
    return {
      en: "I prepared suitable options for you.",
      fr: "J’ai préparé des options adaptées pour vous.",
      ru: "Ğ¯ Ğ¿Ğ¾Ğ´Ğ³Ğ¾Ñ‚Ğ¾Ğ²Ğ¸Ğ»(Ğ°) Ğ¿Ğ¾Ğ´Ñ…Ğ¾Ğ´ÑÑ‰Ğ¸Ğµ Ğ²Ğ°Ñ€Ğ¸Ğ°Ğ½Ñ‚Ñ‹ Ğ´Ğ»Ñ Ğ²Ğ°Ñ.",
      ar: "Ù„Ù‚Ø¯ Ø¬Ù‡Ù‘Ø²Øª Ù„Ùƒ Ø®ÙŠØ§Ø±Ø§Øª Ù…Ù†Ø§Ø³Ø¨Ø©.",
      tr: "Senin için uygun seçenekleri hazırladım.",
    }[normLocale] || "Senin için uygun seçenekleri hazırladım.";
  }

  // AI kimlik cümlelerini törpüle
  txt = txt.replace(/as an ai (language )?model/gi, "");
  txt = txt.replace(/i am an ai( assistant)?/gi, "");
  txt = txt.replace(/bir yapay zeka( modeli)?yim/gi, "");

  // Çok boş satır, gereksiz spacing temizliği
  txt = txt.replace(/\n{3,}/g, "\n\n");

  return txt.trim();
}

// ============================================================================
// LLM ÇAÄRISI — S16 (komisyon kelimesi yasak, persona aware) — S50 guard
// ============================================================================

async function callLLM({
  message,
  locale = "tr",
  intent = "chat",
  region = "",
  city = "",
  memorySnapshot = "",
  persona = "Sono",
  forceOpenAI = false,
  forceWorkersAI = false,
  personaNote = "",
}) {
  const normLocale = normalizeLang(locale);

  const T = {
    tr: {
      noKey: "LLM anahtar(lar)ı eksik. Şu an metin yanıtı üretemiyorum.",
      noAnswer: "Şu an cevap üretemedim. Daha net sorabilir misin?",
      workersFail: "Workers AI yanıt üretemedi. (Geçici)",
      openaiFail: "OpenAI yanıt üretemedi. (Geçici)",
    },
    en: {
      noKey: "LLM keys are missing. I can't generate a text answer right now.",
      noAnswer: "I couldn't generate an answer. Can you ask more clearly?",
      workersFail: "Workers AI failed to answer. (Temporary)",
      openaiFail: "OpenAI failed to answer. (Temporary)",
    },
  }[normLocale] || {
    noKey: "LLM keys are missing. I can't generate a text answer right now.",
    noAnswer: "I couldn't generate an answer. Can you ask more clearly?",
    workersFail: "Workers AI failed to answer. (Temporary)",
    openaiFail: "OpenAI failed to answer. (Temporary)",
  };

  const safeMessage = String(message || "").trim().slice(0, 4000);

  // --- Providers ---
 const workersAiBaseUrl = String(
  process.env.WORKERS_AI_BASE_URL ||
    process.env.CF_WORKER_AI_URL ||
    process.env.CLOUDFLARE_AI_URL ||
    ""
)
  .trim()
  .replace(/\/+$/, "");

const workersAiToken = String(
  process.env.WORKERS_AI_TOKEN || process.env.CF_WORKER_CHAT_TOKEN || process.env.CHAT_TOKEN || ""
).trim();

const hasWorkers = !!workersAiBaseUrl; // token opsiyonel; header sadece varsa eklenir

  const workersAiModel = String(process.env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct").trim();

  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const hasOpenAI = !!apiKey;
  const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
  const baseUrl = "https://api.openai.com/v1";

  if (!hasWorkers && !hasOpenAI) {
    return {
      provider: "none",
      answer: T.noKey,
      suggestions: [],
    };
  }

  function wantsHighQuality(text) {
    const s = String(text || "").toLowerCase();
    if (s.length >= 280) return true;
    if ((s.match(/\n/g) || []).length >= 2) return true;
    if ((s.match(/[?]/g) || []).length >= 2) return true;
    // TR + EN quality triggers
    return /uzun\s+analiz|kapsamlı|detaylı|derinlemesine|karmaşık|kibar|tutarlı|rapor|strateji|plan|iş\s+planı|hukuk|sözleşme|dilekçe|mail|e-?posta|sunum|proje\s+mimarisi|refactor|debug|karşılaştır/.test(s)
      || /long\s+analysis|in\s+depth|complex|polite|consistent|report|strategy|plan|legal|contract|refactor|debug|compare/.test(s);
  }

 const preferOpenAI = false; // workers-first policy


  const sys = `You are ${persona}. Reply ONLY as a JSON object with keys: "answer" (string) and "suggestions" (array of 0-3 short strings). No markdown. No code fences. Answer in the user's language (${normLocale}). If you are uncertain, say so briefly and ask one clarifying question. ${personaNote || ""}`;

  const prompt = [
    `Language: ${normLocale}`,
    `Intent: ${intent}`,
    region ? `Region: ${region}` : "",
    city ? `City: ${city}` : "",
    memorySnapshot ? `Context: ${memorySnapshot}` : "",
    "",
    `User: ${safeMessage}`,
  ].filter(Boolean).join("\n");

  function parseModelOutput(rawText, providerName = "llm") {
    const fallbackJson =
      ({
        en: '{"answer":"I prepared options for you.","suggestions":["Summarize this topic","Give key points","How does it work?"]}',
        fr: '{"answer":"J’ai préparé des options pour vous.","suggestions":["Résume ce sujet","Donne les points clés","Comment ça marche ?"]}',
        ru: '{"answer":"Я подготовил(а) варианты для вас.","suggestions":["Кратко о теме","Дай ключевые пункты","Как это работает?"]}',
        ar: '{"answer":"لقد جهزت لك خيارات.","suggestions":["لخّص الموضوع","أعطني النقاط الأساسية","كيف يعمل ذلك؟"]}',
        tr: '{"answer":"Senin için seçenekleri hazırladım.","suggestions":["Konuyu özetle","Ana maddeleri ver","Nasıl çalışır?"]}',
      }[normLocale] || '{"answer":"Senin için seçenekleri hazırladım.","suggestions":[]}');

    const raw = safeString(rawText) || fallbackJson;

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // salvage: extract first {...} block
      try {
        const s = String(raw || "");
        const i = s.indexOf("{");
        const j = s.lastIndexOf("}");
        if (i >= 0 && j > i) parsed = JSON.parse(s.slice(i, j + 1));
      } catch {
        parsed = null;
      }
    }

    const answer = sanitizeLLMAnswer(
      safeString(parsed?.answer) || safeString(raw),
      normLocale
    );

    const suggestions = Array.isArray(parsed?.suggestions)
      ? parsed.suggestions
          .map((x) => safeString(x))
          .filter(Boolean)
          .slice(0, 4)
      : [];

    return { provider: providerName, answer, suggestions };
  }

  async function runWorkers() {
  const base = workersAiBaseUrl;

  const headers = { "Content-Type": "application/json" };
  if (workersAiToken) {
    headers.Authorization = `Bearer ${workersAiToken}`;
    headers["cf-aig-authorization"] = workersAiToken;
    headers["x-chat-token"] = workersAiToken; // bazı custom worker’lar bunu kullanır
  }

  const bodyCompat = {
    model: String(process.env.WORKERS_AI_MODEL || "").trim() || undefined,
    temperature: 0.2,
    max_tokens: 700,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: prompt },
    ],
  };

  const tryJson = async (url, body) => {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return { r, j };
  };

  // 1) OpenAI-compatible (2 yaygın şekil)
  const urlsCompat = [`${base}/chat/completions`, `${base}/v1/chat/completions`];

  for (const url of urlsCompat) {
    try {
      const { r, j } = await tryJson(url, bodyCompat);
      const raw1 = String(j?.choices?.[0]?.message?.content || "").trim();
      const raw2 = String(
        j?.result?.response || j?.result?.answer || j?.result?.output_text || j?.response || ""
      ).trim();

      const raw = raw1 || raw2;
      if (r.ok && raw) {
        const parsed = parseModelOutput(raw, j?.model || "workers-ai");
        parsed.answer = sanitizeLLMAnswer(parsed.answer || "");
        if (!parsed.answer) parsed.answer = T.noAnswer;
        return { provider: parsed.provider, answer: parsed.answer, suggestions: parsed.suggestions || [] };
      }
    } catch {
      // diğer endpoint’e geç
    }
  }

  // 2) Legacy /chat
  const urlsLegacy = [`${base}/chat`, `${base}/v1/chat`];
  for (const url of urlsLegacy) {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt },
        ],
      }),
    });

    const j = await r.json().catch(() => null);
    if (r.ok && (j?.ok || j?.answer || j?.result)) {
      const raw = String(j?.answer || j?.result?.response || j?.result?.answer || "").trim();
      if (raw) {
        const parsed = parseModelOutput(raw, j?.model || "workers-ai");
        parsed.answer = sanitizeLLMAnswer(parsed.answer || "");
        if (!parsed.answer) parsed.answer = T.noAnswer;
        return { provider: parsed.provider, answer: parsed.answer, suggestions: parsed.suggestions || [] };
      }
    }
  }

  throw new Error("WORKERS_AI_UNREACHABLE");
}


  const raw = String(j?.answer || "").trim();
  const parsed = parseModelOutput(raw, j?.model || "workers-ai");
  parsed.answer = sanitizeLLMAnswer(parsed.answer || "");
  if (!parsed.answer) parsed.answer = T.noAnswer;
  return { provider: parsed.provider, answer: parsed.answer, suggestions: parsed.suggestions || [] };
}

async function runOpenAI() {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt },
        ],
      }),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = data?.error?.message || `HTTP_${r.status}`;
      throw new Error(msg);
    }

    const raw = String(data?.choices?.[0]?.message?.content || "").trim();
    const parsed = parseModelOutput(raw, data?.model || "openai");
    parsed.answer = sanitizeLLMAnswer(parsed.answer || "");
    if (!parsed.answer) parsed.answer = T.noAnswer;
    return { provider: parsed.provider, answer: parsed.answer, suggestions: parsed.suggestions || [] };
  }

  // --- Orchestration ---
if (forceWorkersAI && hasWorkers) {
  try {
    return await runWorkers();
  } catch {}
  if (hasOpenAI) {
    try {
      return await runOpenAI();
    } catch {}
  }
  return { provider: "workers-ai", answer: T.workersFail, suggestions: [] };
}

if (forceOpenAI && hasOpenAI) {
  try {
    return await runOpenAI();
  } catch {}
  if (hasWorkers) {
    try {
      return await runWorkers();
    } catch {}
  }
  return { provider: "openai", answer: T.openaiFail, suggestions: [] };
}

const looksFailish = (s) =>
  /yanıt\s*üretemedi|cevap\s*üretemedim|erişimim\s*yok|temporary|i failed to answer/i.test(
    String(s || "").toLowerCase()
  );

// Default: Workers first, OpenAI only if needed
if (hasWorkers) {
  try {
    const w = await runWorkers();
    const low =
      !w?.answer ||
      looksFailish(w.answer) ||
      (String(w.answer || "").length < 140 && wantsHighQuality(safeMessage));
    if (low && hasOpenAI) {
      try {
        return await runOpenAI();
      } catch {
        return w;
      }
    }
    return w;
  } catch {
    // fall through to OpenAI
  }
}

if (hasOpenAI) {
  try {
    return await runOpenAI();
  } catch {
    return { provider: "openai", answer: T.openaiFail, suggestions: [] };
  }
}

return { provider: "workers-ai", answer: T.workersFail, suggestions: [] };


// ============================================================================
// GET RESULTS — S16 (runAdapters triple-safe) — KORUNDU
// ============================================================================

async function getResults(query, region = "TR") {
  const cleanQuery = safeString(query);
  const normRegion = safeString(region || "TR").toUpperCase();

  console.log("ğŸ” getResults çağrıldı:", { query: cleanQuery, region: normRegion });

  if (!cleanQuery) return [];

  // 1) Ana deneme
  try {
    const result = await runAdapters(cleanQuery, normRegion);

    if (result && (result.best || result.smart || result.others)) {
      return result;
    }

    if (Array.isArray(result)) return result;

    if (result && Array.isArray(result.items)) return result.items;
    if (result && Array.isArray(result.results)) return result.results;

    return [];
  } catch (error) {
    console.error("âŒ getResults ana hata:", error);
  }

  // 2) Hafif fallback
  try {
    const adapted = await runAdapters(cleanQuery, normRegion);
    if (Array.isArray(adapted)) return adapted;
    if (adapted && Array.isArray(adapted.items)) return adapted.items;
    if (adapted && Array.isArray(adapted.results)) return adapted.results;
  } catch (fallbackErr) {
    console.error("âŒ getResults fallback hata:", fallbackErr);
  }

  // 3) En kötü ihtimalle boş
  return [];
}

// ============================================================================
// S50 — AI FIREWALL (Hafif Anti-Flood, dev’de kapalı)
// ============================================================================

const aiFloodMap = new Map();
const AI_FLOOD_GAP_MS = 120;
const AI_FLOOD_TTL_MS = 60 * 1000;
const AI_FLOOD_GC_THRESHOLD = 5000;

function gcAiFlood(now = Date.now()) {
  if (aiFloodMap.size <= AI_FLOOD_GC_THRESHOLD) return;
  for (const [ip, ts] of aiFloodMap.entries()) {
    if (now - ts > AI_FLOOD_TTL_MS) {
      aiFloodMap.delete(ip);
    }
  }
}

function aiFirewall(req, res, next) {
  if (!IS_PROD) return next(); // dev’de sıkma

  const ip = getClientIp(req);
  const now = Date.now();
  const last = aiFloodMap.get(ip) || 0;

  if (now - last < AI_FLOOD_GAP_MS) {
    return res.status(429).json({
      ok: false,
      error: "AI_RATE_LIMIT",
      detail: "Too many AI requests, please slow down.",
    });
  }

  aiFloodMap.set(ip, now);
  gcAiFlood(now);
  next();
}
function isExplicitPriceQuery(text) {
  const low = safeString(text).toLowerCase();
  return /(bu\s*ne\s*kadar|kaç\s*para|ne\s*kadar|fiyat(ı|i)?(\s*(nedir|ne))?|en\s*ucuz|en\s*uygun|daha\s*ucuz|ucuz|ekonomik|hesaplı|bütçe\s*dostu|pahalı\s*olmayan|indirim|kampanya|satın\s*al|satınal)/i.test(
    low
  );
}

function isChatInfoMode(modeNorm) {
  const m = safeString(modeNorm).toLowerCase();
  return m === "chat" || m === "info" || m === "assistant_chat" || m === "nocredit";
}

// ============================================================================
// POST /api/ai — Ana Sono AI endpoint’i — S16 → S50 güçlendirilmiş
// ============================================================================

async function handleAiChat(req, res) {
  const startedAt = Date.now();

  try {
    const {
      message,
      locale = "tr",
      region = "TR",
      city = "",
      userId = null,
      mode = "",
    } = req.body || {};

    const textOriginal = safeString(message);
    const text = clampText(textOriginal, MAX_MESSAGE_LENGTH);
    const normLocale = safeString(locale || "tr").toLowerCase();
    const lang = (() => {
      const l = normLocale;
      if (l.startsWith("en")) return "en";
      if (l.startsWith("fr")) return "fr";
      if (l.startsWith("ru")) return "ru";
      if (l.startsWith("ar")) return "ar";
      return "tr";
    })();
    const normRegion = safeString(region || "TR").toUpperCase();
    const normCity = safeString(city);
    const ip = getClientIp(req);
    const diagOn = safeString(req.query && req.query.diag) === "1";

    // Boş mesaj için hızlı cevap (frontend için) — KORUNDU
    if (!text) {
      return res.json({
        ok: true,
        provider: "local",
        persona: "neutral",
        answer:
          ({
            en: "Tell me what you need — I can search products/services or answer questions.",
            fr: "Dites-moi ce dont vous avez besoin — je peux chercher des produits/services ou répondre à vos questions.",
            ru: "Ğ¡ĞºĞ°Ğ¶Ğ¸Ñ‚Ğµ, Ñ‡Ñ‚Ğ¾ Ğ²Ğ°Ğ¼ Ğ½ÑƒĞ¶Ğ½Ğ¾ — Ñ Ğ¼Ğ¾Ğ³Ñƒ Ğ¸ÑĞºĞ°Ñ‚ÑŒ Ñ‚Ğ¾Ğ²Ğ°Ñ€Ñ‹/ÑƒÑĞ»ÑƒĞ³Ğ¸ Ğ¸Ğ»Ğ¸ Ğ¾Ñ‚Ğ²ĞµÑ‡Ğ°Ñ‚ÑŒ Ğ½Ğ° Ğ²Ğ¾Ğ¿Ñ€Ğ¾ÑÑ‹.",
            ar: "Ù‚Ù„ Ù„ÙŠ Ù…Ø§ Ø§Ù„Ø°ÙŠ ØªØ­ØªØ§Ø¬Ù‡ — ÙŠÙ…ÙƒÙ†Ù†ÙŠ Ø§Ù„Ø¨Ø­Ø« Ø¹Ù† Ù…Ù†ØªØ¬/Ø®Ø¯Ù…Ø© Ø£Ùˆ Ø§Ù„Ø¥Ø¬Ø§Ø¨Ø© Ø¹Ù† Ø§Ù„Ø£Ø³Ø¦Ù„Ø©.",
            tr: "Ne aradığını yaz — ürün/hizmet arayabilir ya da sorularını cevaplayabilirim.",
          }[lang] || "Ne aradığını yaz — ürün/hizmet arayabilir ya da sorularını cevaplayabilirim."),
        suggestions:
          ({
            en: ["Find the cheapest option", "Tell me about a place", "Explain a concept"],
            fr: ["Trouve l’option la moins chère", "Parle-moi d’un lieu", "Explique un concept"],
            ru: ["ĞĞ°Ğ¹Ğ´Ğ¸ ÑĞ°Ğ¼Ñ‹Ğ¹ Ğ´ĞµÑˆĞµĞ²Ñ‹Ğ¹ Ğ²Ğ°Ñ€Ğ¸Ğ°Ğ½Ñ‚", "Ğ Ğ°ÑÑĞºĞ°Ğ¶Ğ¸ Ğ¾ Ğ¼ĞµÑÑ‚Ğµ", "ĞĞ±ÑŠÑÑĞ½Ğ¸ Ğ¿Ğ¾Ğ½ÑÑ‚Ğ¸Ğµ"],
            ar: ["Ø§Ø¹Ø«Ø± Ø¹Ù„Ù‰ Ø§Ù„Ø£Ø±Ø®Øµ", "Ø­Ø¯Ø«Ù†ÙŠ Ø¹Ù† Ù…ÙƒØ§Ù†", "Ø§Ø´Ø±Ø­ ÙÙƒØ±Ø©"],
            tr: ["En ucuzunu bul", "Bir yer hakkında bilgi ver", "Bir şeyi açıkla"],
          }[lang] || []),
        intent: "mixed",
        cards: { best: null, aiSmart: [], others: [] },
      });
    }

   const intent = detectIntent(text, lang);

const modeNorm = safeString(mode).toLowerCase();
const inChat = isChatInfoMode(modeNorm);

// Metals her zaman evidence (vitrin ASLA)
const eType0 = detectEvidenceType(text, lang);
const isMetals = eType0 === "metals";

// chat/info modunda sadece açık fiyat/ucuzluk soruları vitrin açar (metaller hariç)
const explicitPrice = !isMetals && isExplicitPriceQuery(text);

const allowSearch = !inChat || explicitPrice;

// Evidence: arama izni yoksa evet; metallerde her zaman evet; info niyetinde explicit değilse evet
const shouldEvidence = !allowSearch || isMetals || (intent === "info" && !explicitPrice);

// Vitrin: chat’te sadece explicitPrice ile; diğer modlarda product/service/mixed ile
const didSearch =
  allowSearch &&
  !shouldEvidence &&
  (explicitPrice || intent === "product" || intent === "service" || intent === "mixed");

    const userMem = await getUserMemory(userId, ip);
    const persona = detectPersona(text, userMem);


let rawResults = [];
if (didSearch) {
  try {
    rawResults = await getResults(text, normRegion);
  } catch (err) {
    console.error("getResults error:", err);
    rawResults = [];
  }
}

const cardsObj = didSearch
  ? buildVitrineCards(text, rawResults)
  : { best: null, aiSmart: [], others: [] };

let evidence = null;
let evidenceReply = null;

if (shouldEvidence) {
  evidence = await gatherEvidence({ text, lang, city: normCity });
  evidenceReply = buildEvidenceAnswer(evidence, lang);
}


    await updateUserMemory(userId, ip, {
      clicks: (userMem.clicks || 0) + (didSearch ? 1 : 0),
      lastQuery: text,
      lastRegion: normRegion,
      lastCity: normCity || userMem.lastCity,
      preferredSource: cardsObj.best?.source || null,
      personaHint: persona,
    });

    const memorySnapshot = await getUserMemory(userId, ip);

    let llm;

    if (shouldEvidence && evidenceReply && evidenceReply.answer) {
      llm = {
        provider: "evidence",
        answer: evidenceReply.answer,
        suggestions: evidenceReply.suggestions || [],
        sources: evidenceReply.sources || [],
        trustScore: typeof evidenceReply.trustScore === 'number' ? evidenceReply.trustScore : null,
      };
    } else {
      llm = await callLLM({
        message: text,
        locale: normLocale,
        intent,
        region: normRegion,
        city: normCity,
        persona,
        memorySnapshot,
      });
    }

    const latencyMs = Date.now() - startedAt;

    // S50 — tek satır JSON telemetri
    console.log(
      "ğŸ¤– SonoAI S50:",
      JSON.stringify({
        userId: userId || null,
        ip,
        mode: modeNorm || null,
        didSearch,
        intent,
        persona,
        region: normRegion,
        city: normCity,
        queryLength: text.length,
        bestSource: cardsObj.best?.source || null,
        latencyMs,
      })
    );

    // Response shape → FRONTEND ile %100 uyumlu (S16 ile aynı alanlar)
    return res.json({
      ok: true,
      provider: llm.provider,
      persona,
      answer: llm.answer,
      suggestions: llm.suggestions || [],
      sources: llm.sources || [],
      trustScore: typeof llm.trustScore === 'number' ? llm.trustScore : null,
      intent,
      cards: cardsObj,
      meta: {
        latencyMs,
        region: normRegion,
        locale: normLocale,
        mode: modeNorm,
        didSearch,
        trustScore: typeof llm.trustScore === 'number' ? llm.trustScore : null,
      },
      ...(diagOn ? { diag: { ip, intent, mode: modeNorm, noSearchMode, shouldEvidence, didSearch, evidenceType: evidence && evidence.type ? evidence.type : null, evidenceConfidence: evidence && typeof evidence.confidence === 'number' ? evidence.confidence : null, resultsCount: Array.isArray(rawResults) ? rawResults.length : (rawResults && Array.isArray(rawResults.items) ? rawResults.items.length : 0), openaiKey: !!process.env.OPENAI_API_KEY } } : {}),
    });
  } catch (err) {
    console.error("AI ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "AI endpoint error",
    });
  }
}

router.post("/", aiFirewall, handleAiChat);
router.post("/chat", aiFirewall, handleAiChat);

export default router;    eksik hata varsa düzelt gönder bana tek parça halinde 

// === PATCH: intent & vitrin guards ===
const PRICE_INTENT_RE = /(ucuz|fiyat|kaç\s*para|ne\s*kadar|indirim|kampanya|ekonomik|uygun|bütçe\s*dostu|hesaplı|pahalı\s*olmayan)/i;
const METALS_RE = /(altın|gümüş|platin|paladyum|ons|gram\s*altın|çeyrek|yarım)/i;

function shouldTriggerVitrinChatMode(q){
  if(!q) return false;
  if(METALS_RE.test(q)) return false; // metals are info-only
  return PRICE_INTENT_RE.test(q);
}
