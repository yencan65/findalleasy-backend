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
// LIVE / RELIABLE INFO: Evidence fetch (FX, weather, news, wiki) -- S51
//   - Used for chat/info mode to provide up-to-date, source-backed answers
//   - Keeps system stable: timeouts + cache + graceful fallback
// ============================================================================

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

function compactWords(text, maxWords = 6) {
  const low = safeString(text).toLowerCase();
  const cleaned = low.replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\s-]/g, " ");
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 1);
  return words.slice(0, maxWords).join(" ");
}

function detectEvidenceType(text, lang = "tr") {
  const low = safeString(text).toLowerCase();

  const isFx = /(doviz|d\u00f6viz|kur|exchange rate|fx\b|usd\b|eur\b|gbp\b|try\b|dolar|euro|sterlin|kurs\b|\u043a\u0443\u0440\u0441|\u0627\u0644\u0635\u0631\u0641|\u0633\u0639\u0631\s*\u0627\u0644\u0635\u0631\u0641)/i.test(low);
  if (isFx) return "fx";

  const isWeather = /(hava\s*durumu|hava\s*nasil|sicaklik|weather|temperature|forecast|\u043f\u043e\u0433\u043e\u0434\u0430|\u0644\u0644\u0637\u0642\u0633|\u0627\u0644\u0637\u0642\u0633)/i.test(low);
  if (isWeather) return "weather";

  const isNews = /(haber|g\u00fcndem|son\s*haber|news|headline|latest|\u043d\u043e\u0432\u043e\u0441\u0442|\u0627\u0644\u0623\u062e\u0628\u0627\u0631)/i.test(low);
  if (isNews) return "news";

  // default: wiki for general knowledge
  return "wiki";
}

async function fetchJsonCached(url, ttlMs = EVIDENCE_DEFAULT_TTL_MS) {
  const key = `json:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetchWithTimeout(url, {
    method: "GET",
    timeout: 8000,
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
    timeout: 8000,
    headers: {
      "User-Agent": "FindAllEasy-SonoAI/1.0",
      Accept: "application/xml,text/xml,text/plain,*/*",
    },
  });
  if (!res || !res.ok) return null;
  const text = await res.text().catch(() => "");
  if (text) cacheSet(key, text, ttlMs);
  return text || null;
}



function pickCity(text, cityHint) {
  const c = safeString(cityHint);
  if (c) return c;
  const low = safeString(text).toLowerCase();
  // small heuristic for TR cities (common)
  const known = ["istanbul", "ankara", "izmir", "antalya", "bursa", "adana", "konya", "gaziantep", "kayseri"]; 
  for (const k of known) {
    if (low.includes(k)) return k;
  }
  return "";
}

function pickWikiLang(lang) {
  if (lang === "en") return "en";
  if (lang === "fr") return "fr";
  if (lang === "ru") return "ru";
  if (lang === "ar") return "ar";
  return "tr";
}

function buildEvidenceAnswer(e, lang) {
  const L = lang || "tr";
  const tMap = {
    tr: {
      fx: "Guncel doviz kurlari:",
      weather: "Guncel hava durumu:",
      news: "Guncel haber basliklari:",
      wiki: "Kisa bilgi:",
      needCity: "Hangi sehir icin? (Ornek: Istanbul hava durumu)",
    },
    en: {
      fx: "Latest exchange rates:",
      weather: "Current weather:",
      news: "Latest headlines:",
      wiki: "Quick info:",
      needCity: "Which city? (e.g., London weather)",
    },
    fr: {
      fx: "Taux de change recents :",
      weather: "Meteo actuelle :",
      news: "Derniers titres :",
      wiki: "Info rapide :",
      needCity: "Quelle ville ? (ex. Paris meteo)",
    },
    ru: {
      fx: "Aktualnye kursy valyut:",
      weather: "Tekushchaya pogoda:",
      news: "Poslednie novosti:",
      wiki: "Kratko:",
      needCity: "Kakoy gorod? (naprimer, Moskva pogoda)",
    },
    ar: {
      fx: "اسعار الصرف الحالية:",
      weather: "الطقس الحالي:",
      news: "احدث العناوين:",
      wiki: "معلومة سريعة:",
      needCity: "اي مدينة؟ (مثال: طقس اسطنبول)",
    },
  };
  const T = tMap[L] || tMap.tr;

  if (!e) return null;

  if (e.type === "need_city") {
    return {
      answer: T.needCity,
      suggestions: ["Istanbul hava durumu", "Ankara hava durumu"].slice(0, 2),
      sources: [],
    };
  }

  if (e.type === "fx") {
    const lines = [];
    for (const row of e.rates || []) {
      lines.push(`${row.pair}: ${row.value}`);
    }
    const answer = `${T.fx}\n${lines.join("\n")}`.trim();
    return {
      answer,
      suggestions: L === "tr" ? ["EUR/TRY", "USD/TRY", "GBP/TRY"] : ["USD to TRY", "EUR to TRY"],
      sources: e.sources || [],
    };
  }

  if (e.type === "weather") {
    const a = `${T.weather} ${e.city}: ${e.summary}`;
    return {
      answer: a,
      suggestions: [
        L === "tr" ? `${e.city} yarin hava` : `${e.city} weather tomorrow`,
        L === "tr" ? "5 gunluk hava" : "5 day forecast",
      ],
      sources: e.sources || [],
    };
  }

  if (e.type === "news") {
    const items = (e.items || []).slice(0, 5);
    const lines = items.map((x, i) => `${i + 1}) ${x.title}`);
    const answer = `${T.news}\n${lines.join("\n")}`.trim();
    return {
      answer,
      suggestions: [
        L === "tr" ? "Son dakika" : "latest news",
        L === "tr" ? "Ekonomi haberleri" : "economy news",
        L === "tr" ? "Spor haberleri" : "sports news",
      ],
      sources: e.sources || [],
    };
  }

  if (e.type === "wiki") {
    const answer = `${T.wiki} ${e.title}\n${e.extract}`.trim();
    return {
      answer,
      suggestions: [
        L === "tr" ? "Daha kisa ozet" : "shorter summary",
        L === "tr" ? "Ornek ver" : "give an example",
        L === "tr" ? "Artisi eksisi" : "pros and cons",
      ],
      sources: e.sources || [],
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

  // If generic 'kur/doviz' -- show USD + EUR to TRY
  if (pairs.length === 0) {
    pairs.push({ from: "USD", to: "TRY" });
    pairs.push({ from: "EUR", to: "TRY" });
  }

  const results = [];
  for (const p of pairs.slice(0, 3)) {
    const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}`;
    const data = await fetchJsonCached(url, 2 * 60 * 1000); // 2 min
    const rate = data?.rates?.[p.to];
    const date = data?.date || "";
    if (rate) {
      results.push({ pair: `${p.from}/${p.to}`, value: `${Number(rate).toFixed(4)} (${date})` });
    }
  }

  if (results.length === 0) return null;

  return {
    type: "fx",
    rates: results,
    sources: [
      { title: "Frankfurter (ECB rates)", url: "https://www.frankfurter.app/" },
    ],
  };
}

async function getWeatherEvidence(text, lang, cityHint) {
  const city = pickCity(text, cityHint);
  if (!city) return { type: "need_city" };

  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=${encodeURIComponent(lang || "tr")}&format=json`;
  const geo = await fetchJsonCached(geoUrl, 60 * 60 * 1000); // 1 hour
  const g = geo?.results?.[0];
  if (!g) return null;

  const lat = g.latitude;
  const lon = g.longitude;
  const placeName = safeString(g.name || city);

  const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true&timezone=auto`;
  const w = await fetchJsonCached(wUrl, 5 * 60 * 1000);
  const cw = w?.current_weather;
  if (!cw) return null;

  const temp = cw.temperature;
  const wind = cw.windspeed;
  const time = cw.time;

  const summary = `${temp}C, wind ${wind} km/h (at ${time})`;

  return {
    type: "weather",
    city: placeName,
    summary,
    sources: [
      { title: "Open-Meteo", url: "https://open-meteo.com/" },
    ],
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

  // parse items
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

  if (items.length === 0) return null;

  return {
    type: "news",
    query: q,
    items,
    sources: items.map((x) => ({ title: x.title, url: x.url })).slice(0, 5),
  };
}

async function getWikiEvidence(text, lang) {
  const q = safeString(text);
  if (!q) return null;
  const wLang = pickWikiLang(lang || "tr");

  // Wikipedia search
  const sUrl = `https://${wLang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=1&format=json&origin=*`;
  const search = await fetchJsonCached(sUrl, 24 * 60 * 60 * 1000); // cache 1 day
  const top = search?.query?.search?.[0];
  const title = safeString(top?.title || q);

  const sumUrl = `https://${wLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const sum = await fetchJsonCached(sumUrl, 24 * 60 * 60 * 1000);
  const extract = safeString(sum?.extract || "");
  const pageUrl = safeString(sum?.content_urls?.desktop?.page || "");

  if (!extract) return null;

  return {
    type: "wiki",
    title,
    extract,
    sources: pageUrl ? [{ title: `Wikipedia: ${title}`, url: pageUrl }] : [],
  };
}

async function gatherEvidence({ text, lang, city }) {
  const type = detectEvidenceType(text, lang);

  try {
    if (type === "fx") return await getFxEvidence(text, lang);
    if (type === "weather") return await getWeatherEvidence(text, lang, city);
    if (type === "news") return await getNewsEvidence(text, lang);
    // default
    return await getWikiEvidence(text, lang);
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
      intent,
      cards: cardsObj,
      meta: {
        latencyMs,
        region: normRegion,
        locale: normLocale,
        mode: modeNorm,
        didSearch,
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
