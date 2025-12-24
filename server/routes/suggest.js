// ===================================================================
//  S30 — SONO AI SUGGESTION ROUTER (QUANTUM ULTRA)
//  S31 — Vitrin Synergy (S10+ vitrinEngine entegrasyonu)
//  S32 — AI Pipeline Bridge (runAIPipeline + LLM fallback)
//  S33 — QUANTUM-NEURAL RESILIENCE (timeout + type-guard + drift guard)
//  ZERO BREAKING CHANGE — Tam uyumlu, sadece güçlendirilmiş
// ===================================================================

import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import fetch from "node-fetch";

import { runAdapters } from "../core/adapterEngine.js";
import {
  buildDynamicVitrin,
  buildDynamicVitrinSafe,
} from "../core/vitrinEngine.js";

import { inferIntent, runAIPipeline } from "../core/aiPipeline.js";
import { getUserMemory, updateUserMemory } from "../core/learningMemory.js";

// ===============================================================
// SAFE HELPERS — S33 seviyesine çıkarıldı
// ===============================================================
function safeString(v, max = 400) {
  try {
    if (!v) return "";
    let s = String(v).trim();
    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch {
    return "";
  }
}

function safeLocale(locale) {
  try {
    const l = String(locale || "tr").toLowerCase().slice(0, 5);
    if (l.startsWith("en")) return "en";
    if (l.startsWith("tr")) return "tr";
    return "tr";
  } catch {
    return "tr";
  }
}

function safeRegion(raw) {
  try {
    const r = String(raw || "TR").toUpperCase().replace(/[^A-Z]/g, "");
    if (!r) return "TR";
    return r.slice(0, 5);
  } catch {
    return "TR";
  }
}

function getClientIp(req) {
  try {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string") return xf.split(",")[0].trim();
    return req.socket?.remoteAddress || req.ip || "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

function safeJson(res, obj, code = 200) {
  try {
    return code === 200 ? res.json(obj) : res.status(code).json(obj);
  } catch (err) {
    console.error("safeJson ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "JSON_SERIALIZATION_ERROR",
      detail: err?.message,
    });
  }
}

// ===============================================================
//  IPv6 SAFE KEY GENERATOR — S33 hardened
// ===============================================================
const ipv6Key = (req) => {
  try {
    return ipKeyGenerator(req);
  } catch {
    return getClientIp(req);
  }
};

// ===============================================================
//  Rate Limit — S33 burst-protect
// ===============================================================
const suggestLimiter = rateLimit({
  windowMs: 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipv6Key,
});

// ===============================================================
// ROUTER
// ===============================================================
const router = express.Router();
router.use(suggestLimiter);

// ===============================================================
// S34 — CORE VİTRİN CARD BUILDER (ai.js ile uyumlu)
// ===============================================================
function normalizeNumberMaybe(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num : null;
}

// Bu fonksiyon ai.js içindeki buildVitrineCards ile aynı davranışı korur.
function buildVitrineCards(query, rawResults) {
  const result = rawResults || [];
  const isArray = Array.isArray(result);

  if (isArray && result.length === 0) {
    return { best: null, aiSmart: [], others: [] };
  }

  let bestItems = [];
  let smartItems = [];
  let otherItems = [];

  // Eğer adapterEngine/vitrinEngine zaten best/smart/others döndürdüyse
  if (!isArray && (result.best || result.smart || result.others)) {
    bestItems = Array.isArray(result.best) ? result.best : [];
    smartItems = Array.isArray(result.smart) ? result.smart : [];
    otherItems = Array.isArray(result.others) ? result.others : [];

    if (otherItems.length === 0 && Array.isArray(result.items)) {
      otherItems = result.items;
    }
  } else if (isArray) {
    const allItems = result;

    bestItems = allItems
      .filter((item) => (item.score || 0) > 0.7)
      .slice(0, 3);

    smartItems = allItems
      .filter(
        (item) => (item.score || 0) > 0.5 && (item.score || 0) <= 0.7
      )
      .slice(0, 4);

    otherItems = allItems
      .filter((item) => (item.score || 0) <= 0.5)
      .slice(0, 10);
  } else if (result && Array.isArray(result.items)) {
    const allItems = result.items;
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

// ===============================================================
// S33 — Safe runAdapters wrapper (no drift, no undefined crash)
// ===============================================================
async function safeRunAdapters(term, region) {
  try {
    const result = await runAdapters(term, region);

    if (!result) return [];

    // Eğer adapterEngine zaten yapılandırılmış obje döndürüyorsa
    if (
      (result && (result.best || result.smart || result.others)) ||
      (result && Array.isArray(result.items)) ||
      (result && Array.isArray(result.results))
    ) {
      return result;
    }

    if (Array.isArray(result)) return result;

    return [];
  } catch (err) {
    console.error("safeRunAdapters ERROR:", err);
    return [];
  }
}

// ===============================================================
// S33 — Safe vitrin cards fallback (ZERO DELETE)
// ===============================================================
function safeBuildVitrineCards(query, rawResults) {
  try {
    if (typeof buildVitrineCards === "function") {
      return buildVitrineCards(query, rawResults);
    }
  } catch (err) {
    console.error("buildVitrineCards core error:", err);
  }

  const list = Array.isArray(rawResults) ? rawResults : [];
  if (list.length === 0) {
    return { best: null, aiSmart: [], others: [] };
  }

  const bestItems = list.filter((x) => (x.score || 0) > 0.7).slice(0, 3);
  const smartItems = list
    .filter((x) => (x.score || 0) > 0.5 && (x.score || 0) <= 0.7)
    .slice(0, 4);
  const otherItems = list.filter((x) => (x.score || 0) <= 0.5).slice(0, 10);

  return {
    best:
      bestItems.length > 0
        ? {
            slot: "best",
            title: bestItems[0].title || query,
            subtitle: "En uygun & güvenilir seçenek",
            source: bestItems[0].provider || bestItems[0].source || "unknown",
            price: Number.isFinite(bestItems[0].price)
              ? bestItems[0].price
              : null,
            currency: bestItems[0].currency || "TRY",
            isAffiliate: !!bestItems[0].isAffiliate,
            url: bestItems[0].url,
            raw: bestItems[0],
            score: bestItems[0].score || 0,
          }
        : null,

    aiSmart: smartItems.map((x, i) => ({
      slot: "smart",
      title: x.title || query,
      subtitle: i === 0 ? "Tamamlayıcı öneriler" : "Alternatif seçenek",
      source: x.provider || x.source || "unknown",
      price: Number.isFinite(x.price) ? x.price : null,
      currency: x.currency || "TRY",
      isAffiliate: !!x.isAffiliate,
      url: x.url,
      raw: x,
      score: x.score || 0,
    })),

    others: otherItems.map((x) => ({
      slot: "others",
      title: x.title || query,
      subtitle: "Diğer satıcılar",
      source: x.provider || x.source || "unknown",
      price: Number.isFinite(x.price) ? x.price : null,
      currency: x.currency || "TRY",
      isAffiliate: !!x.isAffiliate,
      url: x.url,
      raw: x,
      score: x.score || 0,
    })),
  };
}

// ===============================================================
// S34 — LLM çekirdeği (ai.js ile uyumlu, local copy)
// ===============================================================
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

async function callLLM({
  message,
  locale,
  intent,
  region,
  city,
  memorySnapshot,
}) {
  const apiKey = safeString(process.env.OPENAI_API_KEY);
  const baseUrl =
    safeString(process.env.OPENAI_BASE_URL) || "https://api.openai.com/v1";

  const normLocale = safeLocale(locale || "tr");

  if (!apiKey) {
    return {
      provider: "fallback",
      answer:
        normLocale === "en"
          ? "Sono AI şu an sınırlı modda, yine de seçeneklerini hazırlıyorum."
          : "Sono AI şu an sınırlı modda çalışıyor ama senin için seçenekleri hazırlamaya devam ediyorum.",
    };
  }

  const persona = "neutral"; // Suggest route tarafında persona hesaplanmıyor, dengeli mod

  const personaNote =
    "Kullanıcının niyeti karışık. Dengeli, rahat okunur kısa yanıtlar ver.";

  const systemPrompt = `
Sen Sono isimli akıllı fiyat & fırsat danışmanısın.
"Komisyon" kelimesini asla kullanma; bunun yerine:
- "avantaj sağlanan teklif"
- "daha uygun hale getirdim"
- "sana göre optimize ettim"
gibi ifadeler kullan.

Kullanıcı hangi dilde yazarsa o dilde yanıt ver.

Kullanıcı Persona:
${persona} → ${personaNote}

Kontekst:
- Intent: ${intent}
- Bölge: ${region}
- Şehir: ${city}
- Geçmiş Aramalar: ${(memorySnapshot?.lastQueries || []).join(" • ")}

YANIT MODU:
- 3 net madde ile öneri ver, kısa ve okunur tut.
- Link üretme; kullanıcı tıklama işlemini vitrin kartlarından yapacak.
- Fiyat kıyaslaması yapabilirsin ama markaları kötüleme veya itham etme.
`.trim();

  const requestBody = {
    model: safeString(process.env.OPENAI_MODEL) || "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: safeString(message) },
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
          normLocale === "en"
            ? "Metin yanıtı şu an alınamıyor fakat seçenekleri hazırladım."
            : "Şu an metin yanıtı veremiyorum ama senin için vitrini hazırladım.",
      };
    }

    const data = await res.json().catch(() => null);
    const answer =
      data?.choices?.[0]?.message?.content ||
      (normLocale === "en"
        ? "I prepared the options for you."
        : "İsteklerin için uygun seçenekleri hazırladım.");

    return { provider: data?.model || "openai", answer };
  } catch (err) {
    console.error("LLM çağrı hatası:", err);

    return {
      provider: "exception",
      answer:
        normLocale === "en"
          ? "Metin yanıtı alınamadı ama öneriler hazır."
          : "Şu an metin yanıtında sorun oluştu ama vitrin çalışmaya devam ediyor.",
    };
  }
}

// ===============================================================
// S33 — Safe LLM wrapper (legacy + pipeline-combine)
// ===============================================================
async function safeCallLLM({
  message,
  locale,
  region,
  city,
  intent,
  memorySnapshot,
}) {
  const loc = safeLocale(locale);

  try {
    const res = await callLLM({
      message,
      locale: loc,
      region,
      city,
      intent,
      memorySnapshot,
    });

    if (res && typeof res.answer === "string") {
      return { provider: res.provider || "openai", answer: res.answer };
    }
  } catch (err) {
    console.error("safeCallLLM ERROR:", err);
  }

  return {
    provider: "fallback",
    answer:
      loc === "en"
        ? "I prepared options based on your search."
        : "Aramana göre seçenekleri hazırladım.",
  };
}

// ===================================================================
//  POST /api/suggest — S30/S31/S32/S33 full synergy
// ===================================================================
router.post("/", async (req, res) => {
  const startedAt = Date.now();

  try {
    // ------------------------------------------------------------
    // SAFE INPUTS
    // ------------------------------------------------------------
    const body = req.body || {};
    const clean = safeString(body.query, 400);
    const userId = safeString(body.userId, 200);
    const region = safeRegion(body.region);
    const locale = safeLocale(body.locale);
    const city = safeString(body.city, 120);
    const source = safeString(body.source, 120) || "suggest";
    const sessionId = safeString(body.sessionId, 200);
    const ip = getClientIp(req);

    if (!clean) {
      return safeJson(res, {
        ok: false,
        answer:
          locale === "en" ? "Type something." : "Ne aradığını yaz.",
        intent: "empty",
        query: "",
        cards: { best: null, aiSmart: [], others: [] },
        meta: {
          latencyMs: Date.now() - startedAt,
          region,
          locale,
          resultCount: 0,
        },
      });
    }

    // ------------------------------------------------------------
    // 1) MEMORY SNAPSHOT
    // ------------------------------------------------------------
    const memorySnapshot = await getUserMemory(userId, ip);

    // ------------------------------------------------------------
    // 2) INTENT
    // ------------------------------------------------------------
    const intent =
      typeof inferIntent === "function" ? inferIntent(clean) : "mixed";

    // ------------------------------------------------------------
    // 3) ADAPTERS — S10
    // ------------------------------------------------------------
    const rawResults = await safeRunAdapters(clean, region);

    let resultCount = 0;
    if (Array.isArray(rawResults)) {
      resultCount = rawResults.length;
    } else if (rawResults && Array.isArray(rawResults.items)) {
      resultCount = rawResults.items.length;
    } else if (rawResults && Array.isArray(rawResults.results)) {
      resultCount = rawResults.results.length;
    } else if (
      rawResults &&
      (Array.isArray(rawResults.best) ||
        Array.isArray(rawResults.smart) ||
        Array.isArray(rawResults.others))
    ) {
      resultCount =
        (rawResults.best?.length || 0) +
        (rawResults.smart?.length || 0) +
        (rawResults.others?.length || 0);
    }

    const providersSet = new Set();
    const collectProvider = (item) => {
      if (!item) return;
      const p = item.provider || item.source;
      if (p) providersSet.add(String(p));
    };

    if (Array.isArray(rawResults)) {
      rawResults.forEach(collectProvider);
    } else if (rawResults && Array.isArray(rawResults.items)) {
      rawResults.items.forEach(collectProvider);
    } else if (rawResults && Array.isArray(rawResults.results)) {
      rawResults.results.forEach(collectProvider);
    } else if (rawResults) {
      rawResults.best?.forEach?.(collectProvider);
      rawResults.smart?.forEach?.(collectProvider);
      rawResults.others?.forEach?.(collectProvider);
    }

    // ------------------------------------------------------------
    // 4) S31 — FULL VİTRİN ENGINE
    // ------------------------------------------------------------
    let vitrinRaw = null;

    try {
      vitrinRaw = await buildDynamicVitrinSafe(clean, region, userId, null);
    } catch (err) {
      console.error("buildDynamicVitrinSafe ERROR:", err);
    }

    const fallbackCards = safeBuildVitrineCards(clean, rawResults);

    const cards = {
      best: vitrinRaw?.best ?? fallbackCards.best,
      aiSmart:
        vitrinRaw?.smart ??
        vitrinRaw?.aiSmart ??
        fallbackCards.aiSmart ??
        [],
      others: vitrinRaw?.others ?? fallbackCards.others ?? [],
    };

    // ------------------------------------------------------------
    // 5) MEMORY UPDATE
    // ------------------------------------------------------------
    await updateUserMemory(userId, ip, {
      lastQuery: clean,
      lastRegion: region,
      preferredSource: cards?.best?.source || null,
      lastSource: source,
      lastSessionId: sessionId || null,
    });

    const mem2 = await getUserMemory(userId, ip);

    // ------------------------------------------------------------
    // 6) AI METNİ — Safe LLM + S32 Pipeline
    // ------------------------------------------------------------
    let llm = await safeCallLLM({
      message: clean,
      locale,
      region,
      city,
      intent,
      memorySnapshot: mem2,
    });

    try {
      if (typeof runAIPipeline === "function") {
        const pipelineRes = await runAIPipeline({
          userMessage: clean,
          locale,
          userId,
          memory: mem2,
          cardsContext: {
            providers: Array.from(providersSet),
            adapters: [],
            visionLabels: [],
          },
        });

        const explanation =
          pipelineRes?.explanation ||
          pipelineRes?.text ||
          pipelineRes?.answer ||
          "";

        if (explanation && typeof explanation === "string") {
          llm = {
            provider: (llm.provider || "fallback") + "+S32",
            answer: explanation.trim(),
          };
        }
      }
    } catch (err) {
      console.error("runAIPipeline ERROR:", err);
    }

    const latencyMs = Date.now() - startedAt;

    // ------------------------------------------------------------
    // FINAL RESPONSE — ZERO BREAKING CHANGE
    // ------------------------------------------------------------
    return safeJson(res, {
      ok: true,
      query: clean,
      intent,
      answer: llm.answer,
      memory: mem2,
      cards,
      text: llm.answer,
      meta: {
        latencyMs,
        resultCount,
        providers: Array.from(providersSet),
        region,
        locale,
        source,
        sessionId: sessionId || null,
        ipHash: ip ? String(ip).slice(0, 7) : null,
        llmProvider: llm.provider || "unknown",
      },
    });
  } catch (e) {
    console.error("SUGGEST INTERNAL ERROR:", e);
    return safeJson(
      res,
      {
        ok: false,
        error: "SUGGEST_INTERNAL_ERROR",
        detail: e?.message,
      },
      500
    );
  }
});

export default router;
