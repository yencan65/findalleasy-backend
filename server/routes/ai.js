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

  // 1) High-priority utility intents
  // Note: In Turkish, "kur" is ambiguous (kurallar/kurulum/kur...) so FX detection must be strict.
  const hasRuleWord = /(kural|kurallar|kuralları|rules)/i.test(low);
  const hasSportWord = /(\bspor\b|futbol|basketbol|voleybol|uefa|fifa|şampiyonlar\s*ligi|champions\s*league|premier\s*league|la\s*liga|serie\s*a|bundesliga|\bnba\b|\bmaç\b|fikstür|puan\s*durumu|transfer)/i.test(low);

  // Sports rules questions should go to Wikipedia-style explanations, not FX or headlines.
  if (hasSportWord && hasRuleWord) return "wiki";

  if (
    !hasRuleWord &&
    /(doviz|döviz|exchange\s*rate|\bfx\b|\busd\b|\beur\b|\bgbp\b|\bdolar\b|\beuro\b|\bsterlin\b|usd\/try|eur\/try|gbp\/try|döviz\s*kuru|doviz\s*kuru|dolar\s*kuru|euro\s*kuru|sterlin\s*kuru|курс|الصرف)/i.test(low)
  ) return "fx";
  if (/(hava\s*durumu|hava\s*nasil|sicaklik|weather|temperature|forecast|погода|الطقس)/i.test(low)) return "weather";
  if (/(tarif|tarifi|malzeme|recipe|ingredients|recette|ingrédients|рецепт|ингредиент|وصفة|مكونات)/i.test(low)) return "recipe";



// 1a) "İlkler / firsts" (liste mantığı) — avoid "ilk yardım / first aid"
const isFirstAid = /(ilk\s*yardım|first\s*aid)/i.test(low);
if (
  !isFirstAid &&
  (
    /\b(ilkler|ilkleri)\b/i.test(low) ||
    /\bfirsts\b/i.test(low) ||
    (/\bilk\b/i.test(low) && /(kadın|erkek|female|woman|man|male|kez|defa|ever)\b/i.test(low)) ||
    (/\bilk\b/i.test(low) && /(türkiye|turkiye|türk|dünya|world|abd|amerika|united\s*states|usa|uk|ingiltere|england|fransa|france|almanya|germany|italya|italy|ispanya|spain|japonya|japan|çin|china|rusya|russia)\b/i.test(low))
  )
) return "firsts";

  // 1b) Simple science / constants (avoid wrong Wikipedia hits)
  if (/(kaynar|donar|erir|kaynama\s*noktası|donma\s*noktası|erime\s*noktası|boiling\s*point|freezing\s*point|melting\s*point|kaç\s*derece|\b°\s*c\b|\bdeg(?:ree)?\b)/i.test(low)) return "science";

  // 2) Economy / macro indicators (also common commodities keywords)
  if (/(gdp|gayri\s*safi|milli\s*gelir|\bgsyih\b|enflasyon|inflation|tüfe|cpi|işsizlik|unemployment|faiz|interest\s*rate|borç|debt|bütçe|budget|\bimf\b|world\s*bank|\becb\b|altın|gold|xau|ons\s*altın|gram\s*altın)/i.test(low)) return "econ";

  // 3) Sports (headlines / fixtures)
  if (hasSportWord) return "sports";

  // 4) Scholarly / evidence-based / medical-ish requests
  if (/(pubmed|\bdoi\b|crossref|randomi[sz]ed|meta[-\s]*analiz|systematic\s*review|peer\s*reviewed|hakemli|makale|araştırma|çalışma|clinical\s*trial|psikoloji|psikiyatr|hastalık|tedavi|belirti|ilaç|tıp|medical)/i.test(low)) return "scholar";

  // 5) Structured facts (Wikidata)
  const factHint = /(başkent|capital|nüfus|population|para\s*birimi|currency|resmi\s*dil|official\s*language|yüzölçümü|area|\bkm\s*2\b|\bkm2\b|başkan|başbakan|lider|head\s*of\s*state|head\s*of\s*government|telefon\s*kodu|calling\s*code|alan\s*adı|tld|domain|saat\s*dilimi|time\s*zone|kıta|continent|komşu|neighbor|kuruluş|inception|milli\s*marş|anthem|motto|resmi\s*site|official\s*website|doğum|ölüm|meslek|occupation|vatandaşlık|citizenship)/i.test(low);
  const qWord = /(nedir|ne|kaç|kim|hangi|what|who|which|how\s*many|tell\s*me|list|give\s*me)/i.test(low);
  if (factHint && (qWord || /\?$/.test(low) || low.split(/\s+/).filter(Boolean).length <= 6)) return "fact";

  // 6) Nearby / travel / news (existing)
  const nearby = /(yakınımda|yakında|near\s*me|nearby|рядом|поблизости|قريب\s*مني)/i.test(low);
  const place  = /(mekan|kafe|cafe|restaurant|restoran|kahvaltı|brunch|where\s*to\s*eat|où\s*manger|где\s*поесть|مطعم|قهوة)/i.test(low);
  const travel = /(gezilecek|rota|itinerary|things\s*to\s*do|places\s*to\s*visit|travel|sahil|beach|plaj|tekne|boat|marina|маршрут|что\s*посмотреть|رحلة|شاطئ|قارب)/i.test(low);
  if (nearby || place) return "poi";
  if (travel) return "travel";

  if (/(haber|gündem|son\s*haber|news|headline|latest|новости|الأخبار)/i.test(low)) return "news";

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
      science: "Bilim bilgisi:",
      fact: "K\u0131sa ger\u00e7ek:",
      econ: "Ekonomi:",
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
    const prompt = kind === "country" ? T.needCountry : (L === "tr" ? "Hangi kişi/ülke/şehir?" : "Which person/country/city?");
    const sugg = kind === "country"
      ? (L === "tr" ? ["Türkiye", "Almanya", "ABD"] : ["Turkey", "Germany", "USA"])
      : (L === "tr" ? ["Türkiye", "Istanbul", "Albert Einstein"] : ["Turkey", "Istanbul", "Albert Einstein"]);
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
      suggestions: L === "tr" ? ["Daha net yaz", "Kaynak isteyen soru"] : ["Be more specific", "Add context"],
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
      suggestions: L === "tr" ? [`${ent} nüfus`, `${ent} para birimi`, `${ent} resmi dil`] : [`${ent} population`, `${ent} currency`, `${ent} official language`],
      sources: e.sources || [],
      trustScore: trust ?? 88,
    };
  }

  if (e.type === "econ") {
    const line = `${e.country || ""} — ${e.indicator || ""}: ${e.value || ""}${e.year ? ` (${e.year})` : ""}`.trim();
    return {
      answer: `${T.econ}\n${line}${lowNote}`.trim(),
      suggestions: L === "tr" ? [`${e.country || "Türkiye"} enflasyon`, `${e.country || "Türkiye"} işsizlik`, `${e.country || "Türkiye"} gsyih`] : [`${e.country || "Turkey"} inflation`, `${e.country || "Turkey"} unemployment`, `${e.country || "Turkey"} gdp`],
      sources: e.sources || [],
      trustScore: trust ?? 78,
    };
  }

  if (e.type === "sports") {
    const lines = (e.items || []).slice(0, 5).map((x, i) => `${i + 1}) ${x.title}\n${x.url}`);
    return {
      answer: `${T.sports}\n${lines.join("\n\n")}${lowNote}`.trim(),
      suggestions: L === "tr" ? ["Galatasaray haber", "Fenerbahçe haber", "Süper Lig puan durumu"] : ["Premier League news", "UEFA Champions League", "NBA news"],
      sources: e.sources || [],
      trustScore: trust ?? 68,
    };
  }

  if (e.type === "scholar") {
    const lines = (e.items || []).slice(0, 5).map((x, i) => `${i + 1}) ${x.title}${x.year ? ` (${x.year})` : ""}${x.source ? ` — ${x.source}` : ""}\n${x.url}`);
    return {
      answer: `${T.scholar}\n${lines.join("\n\n")}${lowNote}`.trim(),
      suggestions: L === "tr" ? ["Bu konuda meta-analiz", "Randomized trial", "Yan etkiler"] : ["meta analysis", "randomized trial", "side effects"],
      sources: e.sources || [],
      trustScore: trust ?? 72,
    };
  }

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



  if (e.type === "science") {
    return {
      answer: `${T.science} ${e.title}
${e.extract}${lowNote}`.trim(),
      suggestions: L === "tr" ? ["Su kaç derecede kaynar?", "Su kaç derecede donar?"] : ["water boiling point", "water freezing point"],
      sources: e.sources || [],
      trustScore: trust ?? 90,
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




// ============================================================================
// FIRSTS ENGINE (S60) — "İlkler" soruları için liste + disambiguation + kaynak
//   Problem: "ilkler" soruları tekil entity aramasıyla saçmalar.
//   Çözüm: (1) curated kategori index (10–50) (2) wiki list parsing (3) scope/person disambiguation
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
        suggestions: L === "tr" ? ["Türkiye'nin ilkleri havacılık", "Türkiye'nin ilkleri kadınlar", "Türkiye'nin ilkleri spor"] : ["Turkey firsts aviation", "Turkey firsts women", "Turkey firsts sports"],
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
          suggestions: L === "tr"
            ? [`${scope.label} ilkleri ${((category.title && category.title.tr) || "")}`.trim(), "Türkiye'nin ilkleri kadınlar", "Türkiye'nin ilkleri havacılık"]
            : [`${scope.label} firsts ${((category.title && category.title.en) || "")}`.trim(), "Turkey firsts women", "Turkey firsts aviation"],
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
      suggestions: L === "tr"
        ? [`${scope.label} ilkleri ${catTitle}`.trim(), `${scope.label} ilk kadın`, `${scope.label} ilk bilim`, `${scope.label} ilk spor`]
        : [`${scope.label} firsts ${catTitle}`.trim(), `${scope.label} first woman`, `${scope.label} first science`, `${scope.label} first sports`],
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
      suggestions: L === "tr" ? ["Türkiye'nin ilkleri", "Türkiye'nin ilkleri kadınlar", "Türkiye'nin ilkleri havacılık"] : ["Turkey firsts", "Turkey firsts women", "Turkey firsts aviation"],
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
//   Goal: “başkent / nüfus / para birimi / resmi dil / lider / alan adı …”
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
    if (!id || id === '-1' || !ent) continue;
    const label = safeString(ent?.labels?.[wLang]?.value || ent?.labels?.en?.value || '');
    const desc = safeString(ent?.descriptions?.[wLang]?.value || ent?.descriptions?.en?.value || '');
    return { id, label: label || t, description: desc };
  }
  return null;
}


// 30+ property map (country/city/person). Keep it small-but-useful.
const FACT_PROPERTIES = [
  // Geo / state facts
  { key: "capital", pid: "P36", valueType: "item", labels: { tr: "Başkenti", en: "Capital", fr: "Capitale", ru: "Столица", ar: "العاصمة" },
    kw: ["başkent", "baskent", "capital", "capitale", "столица", "العاصمة"] },
  { key: "population", pid: "P1082", valueType: "quantity", labels: { tr: "Nüfus", en: "Population", fr: "Population", ru: "Население", ar: "عدد السكان" },
    kw: ["nüfus", "nufus", "population", "население", "سكان", "عدد السكان"] },
  { key: "currency", pid: "P38", valueType: "item", labels: { tr: "Para birimi", en: "Currency", fr: "Monnaie", ru: "Валюта", ar: "العملة" },
    kw: ["para birimi", "para", "currency", "monnaie", "валюта", "العملة"] },
  { key: "official_language", pid: "P37", valueType: "item", labels: { tr: "Resmi dil", en: "Official language", fr: "Langue officielle", ru: "Официальный язык", ar: "اللغة الرسمية" },
    kw: ["resmi dil", "official language", "langue officielle", "официальный язык", "اللغة الرسمية"] },
  { key: "area", pid: "P2046", valueType: "quantity", labels: { tr: "Yüzölçümü", en: "Area", fr: "Superficie", ru: "Площадь", ar: "المساحة" },
    kw: ["yüzölçümü", "yuzolcumu", "area", "superficie", "площадь", "المساحة", "km2", "km²"] },
  { key: "calling_code", pid: "P474", valueType: "string", labels: { tr: "Telefon kodu", en: "Calling code", fr: "Indicatif", ru: "Телефонный код", ar: "رمز الاتصال" },
    kw: ["telefon kodu", "ülke kodu", "calling code", "indicatif", "код", "رمز الاتصال", "dial code"] },
  { key: "tld", pid: "P78", valueType: "string", labels: { tr: "İnternet alan adı", en: "Internet TLD", fr: "Domaine Internet", ru: "Домен", ar: "نطاق الإنترنت" },
    kw: ["alan adı", "alan adi", "tld", "domain", "domaine", "домен", "نطاق"] },
  { key: "time_zone", pid: "P421", valueType: "item", labels: { tr: "Saat dilimi", en: "Time zone", fr: "Fuseau horaire", ru: "Часовой пояс", ar: "المنطقة الزمنية" },
    kw: ["saat dilimi", "time zone", "fuseau", "часовой пояс", "المنطقة الزمنية"] },
  { key: "continent", pid: "P30", valueType: "item", labels: { tr: "Kıta", en: "Continent", fr: "Continent", ru: "Континент", ar: "القارة" },
    kw: ["kıta", "kita", "continent", "континент", "القارة"] },
  { key: "neighbors", pid: "P47", valueType: "item", labels: { tr: "Komşular", en: "Neighbors", fr: "Voisins", ru: "Соседи", ar: "الدول المجاورة" },
    kw: ["komşu", "komşuları", "neighbor", "neighbour", "voisin", "сосед", "المجاورة"] },
  { key: "inception", pid: "P571", valueType: "time", labels: { tr: "Kuruluş", en: "Inception", fr: "Création", ru: "Основание", ar: "التأسيس" },
    kw: ["kuruluş", "kurulus", "inception", "founded", "création", "основан", "تأسست"] },
  { key: "anthem", pid: "P85", valueType: "item", labels: { tr: "Milli marş", en: "Anthem", fr: "Hymne", ru: "Гимн", ar: "النشيد" },
    kw: ["milli marş", "marş", "anthem", "hymne", "гимн", "النشيد"] },
  { key: "motto", pid: "P1451", valueType: "monolingual", labels: { tr: "Slogan", en: "Motto", fr: "Devise", ru: "Девиз", ar: "الشعار" },
    kw: ["motto", "slogan", "devise", "девиз", "الشعار"] },
  { key: "official_website", pid: "P856", valueType: "string", labels: { tr: "Resmi web", en: "Official website", fr: "Site officiel", ru: "Офиц. сайт", ar: "الموقع الرسمي" },
    kw: ["resmi site", "resmi web", "official website", "site officiel", "официальный сайт", "الموقع الرسمي"] },

  // Leadership
  { key: "mayor", pid: "P6", valueType: "item", labels: { tr: "Belediye başkanı", en: "Mayor", fr: "Maire", ru: "Мэр", ar: "رئيس البلدية" },
    kw: ["belediye başkanı", "belediye baskani", "mayor", "maire", "мэр", "رئيس البلدية"] },
  { key: "head_of_state", pid: "P35", valueType: "item", labels: { tr: "Devlet başkanı", en: "Head of state", fr: "Chef d'État", ru: "Глава государства", ar: "رئيس الدولة" },
    kw: ["devlet başkanı", "cumhurbaşkanı", "head of state", "chef d'état", "глава государства", "رئيس الدولة"] },
  { key: "head_of_government", pid: "P6", valueType: "item", labels: { tr: "Hükümet başkanı", en: "Head of government", fr: "Chef du gouvernement", ru: "Глава правительства", ar: "رئيس الحكومة" },
    kw: ["başbakan", "hükümet başkanı", "head of government", "глава правительства", "رئيس الحكومة"] },

  // Person facts
  { key: "birth", pid: "P569", valueType: "time", labels: { tr: "Doğum tarihi", en: "Date of birth", fr: "Naissance", ru: "Дата рождения", ar: "تاريخ الميلاد" },
    kw: ["doğum", "dogum", "born", "date of birth", "naissance", "родился", "ميلاد"] },
  { key: "death", pid: "P570", valueType: "time", labels: { tr: "Ölüm tarihi", en: "Date of death", fr: "Décès", ru: "Дата смерти", ar: "تاريخ الوفاة" },
    kw: ["ölüm", "olum", "died", "death", "décès", "умер", "الوفاة"] },
  { key: "occupation", pid: "P106", valueType: "item", labels: { tr: "Meslek", en: "Occupation", fr: "Profession", ru: "Профессия", ar: "المهنة" },
    kw: ["meslek", "occupation", "profession", "профессия", "المهنة"] },
  { key: "citizenship", pid: "P27", valueType: "item", labels: { tr: "Vatandaşlık", en: "Citizenship", fr: "Nationalité", ru: "Гражданство", ar: "الجنسية" },
    kw: ["vatandaşlık", "citizenship", "nationalité", "гражданство", "الجنسية"] },
  { key: "spouse", pid: "P26", valueType: "item", labels: { tr: "Eş", en: "Spouse", fr: "Conjoint", ru: "Супруг(а)", ar: "الزوج/الزوجة" },
    kw: ["eşi", "eş", "spouse", "conjoint", "супруг", "الزوج"] },
  { key: "educated_at", pid: "P69", valueType: "item", labels: { tr: "Eğitim", en: "Education", fr: "Éducation", ru: "Образование", ar: "التعليم" },
    kw: ["eğitim", "okudu", "education", "éducation", "образование", "التعليم"] },
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
    "من", "ما", "ماذا", "كم", "أين", "متى", "كيف",
    "что", "кто", "где", "когда", "как", "сколько",
    "quoi", "qui", "où", "quand", "comment",
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
    results = [{ id: overrideId, label: hint, description: "Known entity" }];
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
  { key: "inflation", id: "FP.CPI.TOTL.ZG", labels: { tr: "Enflasyon (TÜFE, yıllık %)", en: "Inflation (CPI, annual %)", fr: "Inflation (IPC, % annuel)", ru: "Инфляция (ИПЦ, %/год)", ar: "التضخم (سنوي %)" },
    kw: ["enflasyon", "inflation", "tüfe", "cpi", "التضخم", "инфляц"] },
  { key: "unemployment", id: "SL.UEM.TOTL.ZS", labels: { tr: "İşsizlik (%)", en: "Unemployment (%)", fr: "Chômage (%)", ru: "Безработица (%)", ar: "البطالة (%)" },
    kw: ["işsizlik", "unemployment", "chômage", "безработ", "البطالة"] },
  { key: "gdp", id: "NY.GDP.MKTP.CD", labels: { tr: "GSYİH (Cari $)", en: "GDP (current US$)", fr: "PIB (US$ courants)", ru: "ВВП (текущ. долл. США)", ar: "الناتج المحلي (دولار جاري)" },
    kw: ["gsyih", "gdp", "gayri safi", "pib", "ввп", "الناتج"] },
  { key: "gdp_growth", id: "NY.GDP.MKTP.KD.ZG", labels: { tr: "GSYİH büyümesi (yıllık %)", en: "GDP growth (annual %)", fr: "Croissance du PIB (% annuel)", ru: "Рост ВВП (%/год)", ar: "نمو الناتج (%)" },
    kw: ["büyüme", "growth", "croissance", "рост", "نمو"] },
  { key: "population", id: "SP.POP.TOTL", labels: { tr: "Nüfus", en: "Population", fr: "Population", ru: "Население", ar: "عدد السكان" },
    kw: ["nüfus", "population", "население", "سكان"] },
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
  const low = safeString(text).toLowerCase();

  // Gold/precious metals prices need live market data; avoid wrong Wikipedia definitions.
  if (/(altın|altin|\bgold\b|\bxau\b)/i.test(low) && /(fiyat|price|kaç|kac|ne kadar|tl|try)/i.test(low)) {
    return {
      type: "econ",
      indicator: L === "tr" ? "Gram altın fiyatı (anlık)" : "Gold price (live)",
      country: L === "tr" ? "Türkiye" : "Turkey",
      year: L === "tr" ? "anlık" : "live",
      value: L === "tr"
        ? "Bu bilgi canlı piyasa verisi gerektirir. Güvenilir fiyat için Borsa İstanbul / bankalar / lisanslı veri sağlayıcı kaynağı gerekir."
        : "This requires live market data (exchange/authorized data provider).",
      trustScore: 45,
      sources: [
        { title: "Borsa İstanbul", url: "https://www.borsaistanbul.com" },
      ],
    };
  }
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

  try {
    if (type === "fx") return await getFxEvidence(text, L);
    if (type === "weather") return await getWeatherEvidence(text, L, city);
    if (type === "recipe") return await getRecipeEvidence(text, L);

    if (type === "firsts") return await getFirstsEvidence(text, L);

    if (type === "science") {
      const se = await getScienceEvidence(text, L);
      if (se) return se;
      // fallthrough to wiki if not covered by deterministic facts
    }
    if (type === "poi") return await getPoiEvidence(text, L, city);
    if (type === "travel") return await getTravelEvidence(text, L, city);
    if (type === "news") return await getNewsEvidence(text, L);
    if (type === "fact") return await getFactEvidence(text, L);
    if (type === "econ") return await getEconEvidence(text, L);
    if (type === "sports") return await getSportsEvidence(text, L);
    if (type === "scholar") return await getScholarEvidence(text, L);

    const wiki = await getWikiEvidence(text, L);
    if (wiki) return wiki;
    return { type: "no_answer", reason: "no_wiki", trustScore: 40 };
  } catch (err) {
    console.error("evidence error:", err?.message || err);
    return { type: "no_answer", reason: "evidence_error", trustScore: 35 };
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
