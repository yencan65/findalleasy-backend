// server/routes/ai.js
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
function detectIntent(text = "") {
  const low = safeString(text).toLowerCase();

  if (!low) return "mixed";

  const productWords = [
    "almak istiyorum",
    "fiyat",
    "uçak",
    "otel",
    "bilet",
    "kirala",
    "kira",
    "araba",
    "iphone",
    "telefon",
    "laptop",
    "ayakkabı",
    "uçuş",
    "rezervasyon",
    "satın al",
    "en ucuz",
    "kampanya",
    "uçuş bak",
    "konaklama",
  ];

  const infoWords = [
    "nedir",
    "nasıl yapılır",
    "how to",
    "açıkla",
    "neden",
    "bilgi ver",
    "detay",
    "açıklama",
    "anlat",
    "özellikleri",
  ];

  const exitWords = [
    "sonra bakarım",
    "vazgeçtim",
    "kapat",
    "çıkıyorum",
    "later",
    "maybe later",
    "sonra",
    "daha sonra",
  ];

  let scoreProduct = 0;
  let scoreInfo = 0;
  let scoreExit = 0;

  productWords.forEach((w) => {
    if (low.includes(w)) scoreProduct += 2;
  });

  infoWords.forEach((w) => {
    if (low.includes(w)) scoreInfo += 2;
  });

  exitWords.forEach((w) => {
    if (low.includes(w)) scoreExit += 3;
  });

  // S16 — fiyat ifadesi artı puan (KORUNDU)
  if (/[0-9]/.test(low) && /(₺|\$|€|tl|lira|usd|eur)/.test(low)) {
    scoreProduct += 2;
  }

  if (scoreExit > 0 && scoreExit >= scoreProduct && scoreExit >= scoreInfo) {
    return "exit";
  }
  if (scoreProduct > scoreInfo && scoreProduct >= 2) {
    return "product";
  }
  if (scoreInfo > scoreProduct && scoreInfo >= 2) {
    return "info";
  }

  return "mixed";
}

// ============================================================================
// PERSONA DETECT — S16 (hafif bellek destekli, KORUNDU)
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
  const timeout = Number(options.timeout || 15000);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("LLM timeout"));
    }, timeout);

    fetch(resource, options)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ============================================================================
// LIVE / RELIABLE INFO: Evidence fetch (FX, weather, travel, POI, recipe, news, wiki) -- S52
//   - Used for chat/info mode to provide source-backed answers
//   - Hard rules: topic-locked, no random drift; graceful fallback

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
    // RU: в X
    /\bв\s+([A-Za-z\u00c0-\u024f\u0400-\u04ff][A-Za-z\u00c0-\u024f\u0400-\u04ff\s-]{1,40})\b/i,
    // AR: في X
    /\bفي\s+([\u0600-\u06ff\s-]{2,40})\b/i,
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
  const low = safeString(text).toLowerCase();
  if (!low) return "wiki";

  if (/(doviz|d\u00f6viz|kur|exchange rate|\bfx\b|\busd\b|\beur\b|\bgbp\b|\bdolar\b|\beuro\b|\bsterlin\b|\u043a\u0443\u0440\u0441|\u0627\u0644\u0635\u0631\u0641)/i.test(low)) return "fx";
  if (/(hava\s*durumu|hava\s*nasil|sicaklik|weather|temperature|forecast|\u043f\u043e\u0433\u043e\u0434\u0430|\u0627\u0644\u0637\u0642\u0633)/i.test(low)) return "weather";
  if (/(tarif|tarifi|malzeme|recipe|ingredients|recette|ingr\u00e9dients|\u0440\u0435\u0446\u0435\u043f\u0442|\u0438\u043d\u0433\u0440\u0435\u0434\u0438\u0435\u043d\u0442|\u0648\u0635\u0641\u0629|\u0645\u0643\u0648\u0646\u0627\u062a)/i.test(low)) return "recipe";

  const nearby = /(yak\u0131n\u0131mda|yak\u0131nda|near\s*me|nearby|\u0440\u044f\u0434\u043e\u043c|\u043f\u043e\u0431\u043b\u0438\u0437\u043e\u0441\u0442\u0438|\u0642\u0631\u064a\u0628\s*\u0645\u0646\u064a)/i.test(low);
  const place  = /(mekan|kafe|cafe|restaurant|restoran|kahvalt\u0131|brunch|where\s*to\s*eat|o\u00f9\s*manger|\u0433\u0434\u0435\s*\u043f\u043e\u0435\u0441\u0442\u044c|\u0645\u0637\u0639\u0645|\u0642\u0647\u0648\u0629)/i.test(low);
  const travel = /(gezilecek|rota|itinerary|things\s*to\s*do|places\s*to\s*visit|travel|sahil|beach|plaj|tekne|boat|marina|\u043c\u0430\u0440\u0448\u0440\u0443\u0442|\u0447\u0442\u043e\s*\u043f\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c|\u0631\u062d\u0644\u0629|\u0634\u0627\u0637\u0626|\u0642\u0627\u0631\u0628)/i.test(low);
  if (nearby || place) return "poi";
  if (travel) return "travel";

  if (/(haber|g\u00fcndem|son\s*haber|news|headline|latest|\u043d\u043e\u0432\u043e\u0441\u0442\u0438|\u0627\u0644\u0623\u062e\u0628\u0627\u0631)/i.test(low)) return "news";

  return "wiki";
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
      needCity: "Hangi \u015fehir/b\u00f6lge i\u00e7in? (\u00d6rn: Van hava durumu)",
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
      needCity: "Which city/area? (e.g., London weather)",
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
      needCity: "Quelle ville / r\u00e9gion ? (ex. Paris m\u00e9t\u00e9o)",
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
      needCity: "\u041a\u0430\u043a\u043e\u0439 \u0433\u043e\u0440\u043e\u0434/\u0440\u0430\u0439\u043e\u043d? (\u043d\u0430\u043f\u0440\u0438\u043c\u0435\u0440, \u041c\u043e\u0441\u043a\u0432\u0430 \u043f\u043e\u0433\u043e\u0434\u0430)",
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
      needCity: "\u0623\u064a \u0645\u062f\u064a\u0646\u0629/\u0645\u0646\u0637\u0642\u0629\u061f (\u0645\u062b\u0627\u0644: \u0637\u0642\u0633 \u0625\u0633\u0637\u0646\u0628\u0648\u0644)",
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
      suggestions: L === "tr" ? ["Van hava durumu", "Istanbul gezilecek yerler"] : ["London weather", "Paris things to do"],
      sources: [],
      trustScore: 40,
    };
  }
  

  // --- S52 HOTFIX: prevent "ReferenceError: trust is not defined"
  // Not: trustScore hic tanimli olmasa bile typeof guvenli.
  // e parametresi evidence objesidir.
  const trust = (() => {
    const v = (typeof trustScore === "number"
      ? trustScore
      : (typeof e?.trustScore === "number" ? e.trustScore : undefined));

    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  })();
const lowNote = trust != null && trust < 55 ? `\n(${T.lowConf})` : "";

  if (e.type === "fx") {
    const lines = [];
    for (const row of e.rates || []) lines.push(`${row.pair}: ${row.value}`);
    return {
      answer: `${T.fx}\n${lines.join("\n")}`.trim(),
      suggestions: L === "tr" ? ["USD/TRY", "EUR/TRY", "GBP/TRY"] : ["USD to TRY", "EUR to TRY"],
      sources: e.sources || [],
      trustScore: trust ?? 80,
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
      suggestions: L === "tr" ? [`${e.city} yar\u0131n hava`, `${e.city} 5 g\u00fcnl\u00fck hava`] : [`${e.city} weather tomorrow`, `${e.city} 5 day forecast`],
      sources: e.sources || [],
      trustScore: trust ?? 85,
    };
  }

  if (e.type === "poi") {
    const lines = (e.items || []).slice(0, 10).map((x, i) => `${i + 1}) ${x.name}${x.note ? ` — ${x.note}` : ""}\n${x.url}`);
    return {
      answer: `${T.poi} ${e.city}\n${lines.join("\n\n")}${lowNote}`.trim(),
      suggestions: L === "tr" ? ["Yak\u0131n\u0131mdaki kafe", "Yak\u0131n\u0131mdaki restoran"] : ["nearby cafes", "nearby restaurants"],
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
      suggestions: L === "tr" ? [`${e.city} gezilecek yerler`, `${e.city} yeme i\u00e7me`] : [`${e.city} things to do`, `${e.city} where to eat`],
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
      suggestions: L === "tr" ? ["Tavuk tarifi", "Tatli tarifi"] : ["chicken recipe", "dessert recipe"],
      sources: e.sources || [],
      trustScore: trust ?? 75,
    };
  }

  if (e.type === "news") {
    const items = (e.items || []).slice(0, 5);
    const lines = items.map((x, i) => `${i + 1}) ${x.title}`);
    return {
      answer: `${T.news}\n${lines.join("\n")}${lowNote}`.trim(),
      suggestions: L === "tr" ? ["Son dakika", "Ekonomi haberleri", "Spor haberleri"] : ["latest news", "economy news", "sports news"],
      sources: e.sources || [],
      trustScore: trust ?? 70,
    };
  }

  // wiki
  if (e.type === "wiki") {
    return {
      answer: `${T.wiki} ${e.title}\n${e.extract}${lowNote}`.trim(),
      suggestions: L === "tr" ? ["Daha k\u0131sa \u00f6zet", "\u00d6rnek ver", "Art\u0131s\u0131 eksisi"] : ["shorter summary", "give an example", "pros and cons"],
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
    if (L === "ar") return `${cond}، ${temp}\u00b0C • \u0631\u064a\u0627\u062d ${wind} \u0643\u0645/\u0633 (\u0641\u064a ${at})`;
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

async function getWikiEvidence(text, lang) {
  const q = safeString(text);
  if (!q) return null;
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

  const title = safeString(best?.title || q);
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

  try {
    if (type === "fx") return await getFxEvidence(text, L);
    if (type === "weather") return await getWeatherEvidence(text, L, city);
    if (type === "recipe") return await getRecipeEvidence(text, L);
    if (type === "poi") return await getPoiEvidence(text, L, city);
    if (type === "travel") return await getTravelEvidence(text, L, city);
    if (type === "news") return await getNewsEvidence(text, L);
    return await getWikiEvidence(text, L);
  } catch (err) {
    console.error("evidence error:", err?.message || err);
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
      ru: "Я подготовил(а) подходящие варианты для вас.",
      ar: "لقد جهّزت لك خيارات مناسبة.",
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
// LLM ÇAĞRISI — S16 (komisyon kelimesi yasak, persona aware) — S50 guard
// ============================================================================

async function callLLM({
  message,
  locale,
  intent,
  region,
  city,
  memorySnapshot,
  persona,
}) {
  const apiKey = safeString(process.env.OPENAI_API_KEY);
  const baseUrl =
    safeString(process.env.OPENAI_BASE_URL) || "https://api.openai.com/v1";

  const normLocale = (() => {
  const l = safeString(locale || "tr").toLowerCase();
  if (l.startsWith("en")) return "en";
  if (l.startsWith("fr")) return "fr";
  if (l.startsWith("ru")) return "ru";
  if (l.startsWith("ar")) return "ar";
  return "tr";
})();

  // Mesajı sert limit ile kısalt
  const safeMessage = clampText(message, MAX_MESSAGE_LENGTH);

  if (!apiKey) {
    return {
      provider: "fallback",
      answer:
        ({
          en: "Sono is in limited mode right now, but I can still help with quick information.",
          fr: "Sono est en mode limité pour le moment, mais je peux quand même aider avec des infos rapides.",
          ru: "Сейчас Sono работает в ограниченном режиме, но я всё равно могу помочь с быстрыми справками.",
          ar: "Sono يعمل الآن بوضع محدود، لكن يمكنني مساعدتك بمعلومات سريعة.",
          tr: "Sono şu an sınırlı modda çalışıyor ama yine de hızlı bilgi verebilirim.",
        }[normLocale] || "Sono şu an sınırlı modda çalışıyor ama yine de hızlı bilgi verebilirim."),
      suggestions:
        ({
          en: ["Tell me about a place", "Explain a concept", "Compare two things"],
          fr: ["Parle-moi d’un lieu", "Explique un concept", "Compare deux choses"],
          ru: ["Расскажи о месте", "Объясни понятие", "Сравни два варианта"],
          ar: ["حدثني عن مكان", "اشرح فكرة", "قارن بين خيارين"],
          tr: ["Bir yer hakkında bilgi ver", "Bir şeyi açıkla", "İki şeyi karşılaştır"],
        }[normLocale] || []),
    };
  }

  const personaNote = {
    saver:
      "Kullanıcı fiyat odaklı. Ekonomik, avantaj yaratılmış, uygun fiyatlı seçenekler öner.",
    fast: "Kullanıcı hız odaklı. Hızlı adımlar ve pratik yönlendirmeler yap.",
    luxury:
      "Kullanıcı premium kalite istiyor. En yüksek rating'li, güvenilir seçenekleri öne çıkar.",
    explorer:
      "Kullanıcı alternatif görmek istiyor. En az 2 farklı yolu kısa anlat.",
    neutral:
      "Kullanıcının niyeti karışık. Dengeli, rahat okunur kısa yanıtlar ver.",
  }[persona];

  const systemPrompt = `
You are Sono, a smart assistant. The user may ask for general information or guidance.
Rules:
- Reply in the user's language. Target language is based on locale: ${normLocale}.
  • tr = Turkish, en = English, fr = French, ru = Russian, ar = Arabic.
- Keep it short, clear, and helpful. No fluff.
- Do NOT mention "affiliate", "commission", or "sponsor". Never produce links.

Output format (VERY IMPORTANT):
Return ONLY valid JSON with this exact shape:
{"answer":"...","suggestions":["...","...","..."]}
- answer: a short, direct answer (2–6 short sentences or 3 bullets).
- suggestions: 2–4 short follow-up prompts the user can click.
No markdown. No code fences. No extra keys.

Context:
- Intent: ${intent}
- Region: ${region}
- City: ${city}
- Recent Queries: ${(memorySnapshot?.lastQueries || []).slice(0, 10).join(" • ")}
Persona hint: ${persona} → ${personaNote || "balanced"}
`.trim();

  const requestBody = {
    model: safeString(process.env.OPENAI_MODEL) || "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: safeMessage },
    ],
    max_tokens: 250,
    temperature: 0.7,
  };

  try {
    const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: "POST",
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res || !res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        // yut
      }
      console.error("LLM HTTP error:", res?.status, text);

      return {
        provider: "error",
        answer:
          ({
            en: "I can’t generate a text answer right now, but I can still help if you rephrase briefly.",
            fr: "Je ne peux pas générer de réponse texte pour le moment, mais je peux aider si vous reformulez brièvement.",
            ru: "Сейчас не получается выдать текстовый ответ, но я смогу помочь, если вы переформулируете короче.",
            ar: "لا أستطيع إنشاء إجابة نصية الآن، لكن يمكنني المساعدة إذا أعدت صياغة السؤال باختصار.",
            tr: "Şu an metin yanıtı üretemiyorum; soruyu daha kısa yazarsan yardımcı olabilirim.",
          }[normLocale] || "Şu an metin yanıtı üretemiyorum; soruyu daha kısa yazarsan yardımcı olabilirim."),
        suggestions:
          ({
            en: ["Summarize this topic", "Give key points", "How does it work?"],
            fr: ["Résume ce sujet", "Donne les points clés", "Comment ça marche ?"],
            ru: ["Кратко о теме", "Дай ключевые пункты", "Как это работает?"],
            ar: ["لخّص الموضوع", "أعطني النقاط الأساسية", "كيف يعمل ذلك؟"],
            tr: ["Konuyu özetle", "Ana maddeleri ver", "Nasıl çalışır?"],
          }[normLocale] || []),
      };
    }

    const data = await res.json().catch(() => null);
    const rawAnswer =
      data?.choices?.[0]?.message?.content ||
      ({
        en: '{"answer":"I prepared options for you.","suggestions":["Summarize this topic","Give key points","How does it work?"]}',
        fr: '{"answer":"J’ai préparé des options pour vous.","suggestions":["Résume ce sujet","Donne les points clés","Comment ça marche ?"]}',
        ru: '{"answer":"Я подготовил(а) варианты для вас.","suggestions":["Кратко о теме","Дай ключевые пункты","Как это работает?"]}',
        ar: '{"answer":"لقد جهّزت لك خيارات.","suggestions":["لخّص الموضوع","أعطني النقاط الأساسية","كيف يعمل ذلك؟"]}',
        tr: '{"answer":"Senin için seçenekleri hazırladım.","suggestions":["Konuyu özetle","Ana maddeleri ver","Nasıl çalışır?"]}',
      }[normLocale] || '{"answer":"Senin için seçenekleri hazırladım.","suggestions":[]}');

    // Try to parse JSON output {answer, suggestions}
    let parsed = null;
    try {
      parsed = JSON.parse(rawAnswer);
    } catch {
      // salvage: extract first {...} block
      try {
        const s = String(rawAnswer || "");
        const i = s.indexOf("{");
        const j = s.lastIndexOf("}");
        if (i >= 0 && j > i) parsed = JSON.parse(s.slice(i, j + 1));
      } catch {
        parsed = null;
      }
    }

    const answer = sanitizeLLMAnswer(
      safeString(parsed?.answer) || safeString(rawAnswer),
      normLocale
    );

    const suggestions = Array.isArray(parsed?.suggestions)
      ? parsed.suggestions
          .map((x) => safeString(x))
          .filter(Boolean)
          .slice(0, 4)
      : [];

    return { provider: data?.model || "openai", answer, suggestions };
  } catch (err) {
    console.error("LLM çağrı hatası:", err);

    return {
      provider: "exception",
      answer:
        ({
          en: "I couldn’t retrieve a text answer right now. Try again in a moment.",
          fr: "Je n’ai pas pu récupérer une réponse texte. Réessayez dans un instant.",
          ru: "Не удалось получить текстовый ответ. Попробуйте ещё раз чуть позже.",
          ar: "تعذّر الحصول على إجابة نصية الآن. جرّب مرة أخرى بعد قليل.",
          tr: "Şu an metin yanıtında sorun oluştu. Biraz sonra tekrar deneyin.",
        }[normLocale] || "Şu an metin yanıtında sorun oluştu. Biraz sonra tekrar deneyin."),
      suggestions:
        ({
          en: ["Ask in one sentence", "Give context", "What exactly do you want to know?"],
          fr: ["Pose une seule phrase", "Donne un peu de contexte", "Qu’est-ce que tu veux savoir exactement ?"],
          ru: ["Спроси одним предложением", "Дай контекст", "Что именно ты хочешь узнать?"],
          ar: ["اسأل بجملة واحدة", "أضف بعض السياق", "ما الذي تريد معرفته تحديدًا؟"],
          tr: ["Tek cümleyle sor", "Biraz bağlam ver", "Tam olarak neyi öğrenmek istiyorsun?"],
        }[normLocale] || []),
    };
  }
}

// ============================================================================
// GET RESULTS — S16 (runAdapters triple-safe) — KORUNDU
// ============================================================================

async function getResults(query, region = "TR") {
  const cleanQuery = safeString(query);
  const normRegion = safeString(region || "TR").toUpperCase();

  console.log("🔍 getResults çağrıldı:", { query: cleanQuery, region: normRegion });

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
    console.error("❌ getResults ana hata:", error);
  }

  // 2) Hafif fallback
  try {
    const adapted = await runAdapters(cleanQuery, normRegion);
    if (Array.isArray(adapted)) return adapted;
    if (adapted && Array.isArray(adapted.items)) return adapted.items;
    if (adapted && Array.isArray(adapted.results)) return adapted.results;
  } catch (fallbackErr) {
    console.error("❌ getResults fallback hata:", fallbackErr);
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

// ============================================================================
// POST /api/ai — Ana Sono AI endpoint’i — S16 → S50 güçlendirilmiş
// ============================================================================

router.post("/", aiFirewall, async (req, res) => {
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
            ru: "Скажите, что вам нужно — я могу искать товары/услуги или отвечать на вопросы.",
            ar: "قل لي ما الذي تحتاجه — يمكنني البحث عن منتج/خدمة أو الإجابة عن الأسئلة.",
            tr: "Ne aradığını yaz — ürün/hizmet arayabilir ya da sorularını cevaplayabilirim.",
          }[lang] || "Ne aradığını yaz — ürün/hizmet arayabilir ya da sorularını cevaplayabilirim."),
        suggestions:
          ({
            en: ["Find the cheapest option", "Tell me about a place", "Explain a concept"],
            fr: ["Trouve l’option la moins chère", "Parle-moi d’un lieu", "Explique un concept"],
            ru: ["Найди самый дешевый вариант", "Расскажи о месте", "Объясни понятие"],
            ar: ["اعثر على الأرخص", "حدثني عن مكان", "اشرح فكرة"],
            tr: ["En ucuzunu bul", "Bir yer hakkında bilgi ver", "Bir şeyi açıkla"],
          }[lang] || []),
        intent: "mixed",
        cards: { best: null, aiSmart: [], others: [] },
      });
    }

    const intent = detectIntent(text);

const modeNorm = safeString(mode).toLowerCase();
// mode=chat → sadece sohbet/info; adapter çalıştırma (kredi yakma) YASAK
const noSearchMode =
  modeNorm === "chat" || modeNorm === "info" || modeNorm === "assistant_chat" || modeNorm === "nocredit";
const didSearch = !noSearchMode && (intent === "product" || intent === "mixed");
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

if (noSearchMode) {
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

    if (noSearchMode && evidenceReply && evidenceReply.answer) {
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
      "🤖 SonoAI S50:",
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
    });
  } catch (err) {
    console.error("AI ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "AI endpoint error",
    });
  }
});

export default router;
