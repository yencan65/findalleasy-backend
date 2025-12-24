// BACKEND/server/core/aiPipeline.js
// ======================================================================
//  SONO AI PIPELINE — S14 → S200 ULTRA-COMPAT
//  Memory → Intent → Category → Extraction → LLM → Cards → Memory-Enhanced
//  Mevcut ai.js yapısını BOZMADAN araya girebilen, SDK bağımsız, çelik çekirdek.
//  S200 ANA MOTOR UYUMU:
//   - intentEngine.detectIntent ile ortak beyin
//   - source / visionLabels / qrPayload / embedding / userProfile desteği
// ======================================================================

// ===================================================
// MEMORY IMPORT (güçlendirme eklentisi)
// ===================================================
import {
  getUserMemory,
  getTopCategory,
  getTopProvider,
  getPriceSensitivity,
} from "./learningMemory.js";

// Kategori beyni (S5 dinamik)
// Varsa kullanılır, yoksa sistem yine çalışır.
import { inferCategoryS5 } from "./categoryBrainDynamic.js";

// S200 ANA INTENT BEYNİ (adapterEngine ile aynı)
// detectIntent burada alias ile alınıyor ki local inferIntent ile çakışmasın
import { detectIntent as coreDetectIntent } from "./intentEngine.js";

// ===================================================
// HELPER — Güvenli sayı & clamp
// ===================================================
function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ===================================================
// Basit + güçlendirilmiş intent tahmini (S14 legacy)
//  - S200 öncesi yapıyı KORURUZ, fallback olarak kullanırız.
// ===================================================
function inferIntent(message = "") {
  const t = String(message || "").toLowerCase().trim();
  if (!t) return "chat";

  // Arama / ürün / fiyat odaklı
  if (
    /(ara|search|bul|fiyat|price|nereden al|nereden alırım|satın|kaç para|karşılaştır|compare)/.test(
      t
    )
  ) {
    return "search";
  }

  // Seyahat / otel / uçuş
  if (/(otel|hotel|rezervasyon|uçuş|uçak bileti|flight|bilet al)/.test(t)) {
    return "travel";
  }

  // Soru/özellik odaklı ürün analizi
  if (/(ürün|product|model|özellik|spec|özellikleri)/.test(t)) {
    return "product";
  }

  // Tavsiye ve karar verme
  if (/(öner|tavsiye|hangisi|hangi|recommend|suggest)/.test(t)) {
    return "advice";
  }

  // Lokasyon / yer sorma
  if (/(nerede|yakınında|yakındaki|near me|çevremde)/.test(t)) {
    return "location";
  }

  // Küçük sohbet, selam vb.
  if (/(merhaba|selam|hi|hello|nasılsın|what's up|napıyorsun)/.test(t)) {
    return "chat";
  }

  return "chat";
}

// ===================================================
// Basit + temiz search-term extractor
// ===================================================
function extractSearchTerm(message = "") {
  let t = String(message || "").toLowerCase().trim();
  if (!t) return "";

  // Soru ekleri, dolgu kelimeler
  const junk = [
    "en ucuz",
    "en iyi",
    "fiyatı",
    "fiyat",
    "ne kadar",
    "kaç para",
    "nereden alırım",
    "nereden al",
    "satın almak istiyorum",
    "satın al",
    "ara",
    "arama yap",
    "bul",
    "bakar mısın",
    "istiyorum",
    "lütfen",
    "yardımcı olur musun",
    "?",
  ];

  junk.forEach((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    t = t.replace(re, " ");
  });

  // Tırnak içi varsa, onu önceliklendirelim
  const quoted = t.match(/"(.*?)"/);
  if (quoted && quoted[1]) {
    return quoted[1].trim();
  }

  return t.replace(/\s+/g, " ").trim();
}

// ===================================================
// Hafıza normalize edici
// ===================================================
function normalizeMemory(memory) {
  try {
    if (!memory) return [];

    if (Array.isArray(memory)) return memory.slice(-6);
    if (Array.isArray(memory.conversations))
      return memory.conversations.slice(-6);
    if (Array.isArray(memory.lastMessages))
      return memory.lastMessages.slice(-6);

    return [];
  } catch (err) {
    console.warn("normalizeMemory error:", err);
    return [];
  }
}

// ===================================================
// HAFIZA PROFİLİ CORE — memory objesinden profil üretir
// ===================================================
async function buildMemoryProfileFromMemory(mem) {
  if (!mem) return null;

  // Hafif analiz: click sayısı / event uzunluğu tahmini
  let clickCount = 0;
  try {
    const arr = Array.isArray(mem)
      ? mem
      : Array.isArray(mem.events)
      ? mem.events
      : Array.isArray(mem.conversations)
      ? mem.conversations
      : [];

    clickCount = arr.length || 0;
  } catch {
    clickCount = 0;
  }

  return {
    raw: mem,
    topCategory: getTopCategory(mem), // product / hotel / flight …
    topProvider: getTopProvider(mem), // trendyol / hb / booking …
    priceSensitivity: getPriceSensitivity(mem), // 0.7–1.3 gibi
    clickCount,
  };
}

// ===================================================
// HAFIZA PROFİLİ — ESNEK API (userId VEYA memory)
// ===================================================
export async function buildMemoryProfile(input) {
  try {
    if (!input) return null;

    // 1) input = userId (string / number) ise → DB'den çek
    if (typeof input === "string" || typeof input === "number") {
      const mem = await getUserMemory(input);
      if (!mem) return null;
      return await buildMemoryProfileFromMemory(mem);
    }

    // 2) input zaten memory objesi ise → direkt kullan
    if (typeof input === "object" && input !== null) {
      return await buildMemoryProfileFromMemory(input);
    }

    // başka tip gelirse profil yok
    return null;
  } catch (err) {
    console.warn("buildMemoryProfile error:", err);
    return null;
  }
}

// ===================================================
// KİŞİSEL SKOR — vitrinEngine için personalization helper
// ===================================================
export function applyPersonalizationScore(item, memoryProfile) {
  if (!item || !memoryProfile) return item;

  // Eski taban skoru korunuyor
  let qualityBase =
    typeof item.qualityScore === "number" ? item.qualityScore : 0.6;
  let bonus = 0;

  const category = (item.category || "").toString().toLowerCase();
  const provider = (item.provider || "").toString().toLowerCase();

  // Komisyon / provider önceliği sinyali (varsa)
  const cm = item.commissionMeta || {};
  const providerPriorityScore = safeNumber(
    cm.providerPriorityScore,
    0
  ); // 0–5 civarı
  const commissionRate = safeNumber(
    cm.finalRate ?? cm.platformRate ?? 0,
    0
  ); // 0–0.45

  // 1) Kullanıcının en çok tercih ettiği kategoriyle eşleşiyorsa
  if (
    memoryProfile.topCategory &&
    category &&
    category === String(memoryProfile.topCategory).toLowerCase()
  ) {
    bonus += 0.12;
  }

  // 2) Kullanıcının en çok tercih ettiği provider ile eşleşiyorsa
  if (
    memoryProfile.topProvider &&
    provider &&
    provider.includes(String(memoryProfile.topProvider).toLowerCase())
  ) {
    bonus += 0.1;
  }

  // 3) Fiyat hassasiyeti — ucuzcu / premium davranış
  const price = typeof item.price === "number" ? item.price : null;
  const sens = memoryProfile.priceSensitivity;

  if (price != null && typeof sens === "number") {
    // sens < 1 → daha fiyat odaklı
    if (sens < 1 && price < 1500) {
      bonus += 0.08;
    }
    // sens > 1.1 → daha premium odaklı
    if (sens > 1.1 && price > 5000) {
      bonus += 0.08;
    }
  }

  // 4) Provider priority / komisyon sinyali (çok hafif bias)
  if (providerPriorityScore > 0) {
    bonus += Math.min(0.06, providerPriorityScore / 80); // 5 → +0.0625 max
  }

  if (commissionRate > 0.18) {
    // yüksek komisyon ama kullanıcı davranışına göre çok küçük itme
    bonus += 0.02;
  }

  // 5) Kullanıcının etkileşim yoğunluğu (clickCount) → data-backed
  if (memoryProfile.clickCount > 40 && price != null) {
    // çok etkileşimli kullanıcıda, yüksek ratingli ürünlere mikro buff
    if (typeof item.rating === "number" && item.rating >= 4.5) {
      bonus += 0.03;
    }
  }

  const qualityScorePersonal = clamp01(qualityBase + bonus);

  return {
    ...item,
    qualityScorePersonal,
  };
}

// ===================================================
// ANA PIPELINE (mevcut yapı korunuyor + S200 uyumluluk)
// ===================================================
export async function runAIPipeline({
  llmFn,
  userMessage,
  locale = "tr",
  userId = null,
  memory,
  pricingContext,
  cardsContext,

  // S200 INTENT / ROUTER UYUMLULUK PARAMETRELERİ
  source = "text",
  visionLabels = [],
  qrPayload = null,
  embedding = null,
  userProfile = null,
} = {}) {
  try {
    const safeMsg = String(userMessage || "").trim().slice(0, 2000);

    // Eski memory snapshot TUTULDU
    const memorySnapshot = normalizeMemory(memory);

    // Yeni: kullanıcı hafıza profili
    const memoryProfile = userId ? await buildMemoryProfile(userId) : null;

    // ---------------------------------------------------
    // 1) LEGACY intent (eski davranış) → fallback
    // ---------------------------------------------------
    let intent = inferIntent(safeMsg);

    // ---------------------------------------------------
    // 2) S200 INTENT ENGINE — intentEngine.detectIntent
    //    adapterEngine S200 ile AYNI formatta çağırıyoruz.
    //    Hata alırsak, legacy intent olduğu gibi kalıyor.
    // ---------------------------------------------------
    let intentInfo = null;
    let mainCategoryFromIntent = null;

    try {
      if (typeof coreDetectIntent === "function" && safeMsg) {
        const cleanVision =
          Array.isArray(visionLabels) && visionLabels.length
            ? visionLabels.map((v) => String(v).toLowerCase().trim())
            : [];

        intentInfo = await coreDetectIntent({
          query: safeMsg,
          source: source || "text",
          visionLabels: cleanVision,
          qrPayload,
          embedding,
          userProfile: userProfile || null,
        });

        const detectedIntentText = String(
          intentInfo?.finalIntent || intentInfo?.type || ""
        )
          .toLowerCase()
          .trim();

        if (detectedIntentText) {
          // intent alanını S200 beyninden gelen sinyale güncelliyoruz
          intent = detectedIntentText;
        }

        // S200 tarafında kullanılan kategori map’ine uyumlu küçük parser
        let cat = detectedIntentText;
        if (cat.includes("hotel")) cat = "hotel";
        else if (cat.includes("flight")) cat = "flight";
        else if (cat.includes("car")) cat = "car_rental";
        else if (cat.includes("tour")) cat = "tour";
        else if (cat.includes("health")) cat = "health";
        else if (cat.includes("spa")) cat = "spa";
        else if (cat.includes("estate")) cat = "estate";
        else if (cat.includes("travel")) cat = "travel";

        mainCategoryFromIntent = cat || null;
      }
    } catch (err) {
      console.warn("runAIPipeline detectIntent (S200) error:", err?.message || err);
      // intent legacy olarak kalır, sistem bozulmaz
    }

    const extracted =
      intent === "search" ||
      intent === "product" ||
      intent === "travel" ||
      intent === "location"
        ? extractSearchTerm(safeMsg)
        : "";

    // ===================================================
    // ANA KATEGORİ (S5 categoryBrainDynamic + S200 sinyali)
    // ===================================================
    let mainCategory = "product";

    // 1) S200 intent sonucu varsa, önce onu dikkate al
    if (mainCategoryFromIntent) {
      mainCategory = mainCategoryFromIntent;
    }

    // 2) S5 categoryBrainDynamic → S200 ile uyumlu ama override edebilir
    try {
      const catInput = {
        query: extracted || safeMsg,
        providers:
          cardsContext?.providers ||
          cardsContext?.adapterNames ||
          cardsContext?.adapters ||
          [],
        vision:
          cardsContext?.visionLabels ||
          cardsContext?.vision ||
          cardsContext?.imageLabels ||
          [],
      };

      if (typeof inferCategoryS5 === "function") {
        const c = inferCategoryS5(catInput);
        if (c) mainCategory = c;
      }
    } catch (err) {
      console.warn("runAIPipeline category inference error:", err);
      if (!mainCategory) mainCategory = "product";
    }

    // Küçük normalize — adapterEngine S200 ile aynı mantıkta
    if (mainCategory === "electronics") mainCategory = "product";
    if (mainCategory === "tech") mainCategory = "product";
    if (mainCategory === "grocery") mainCategory = "market";
    if (mainCategory === "fashion_product") mainCategory = "fashion";
    if (!mainCategory) mainCategory = "product";

    // Varsayılan açıklama
    const defaultExplanation =
      locale === "en"
        ? "I analyzed your request and prepared the most relevant options in the cards below. You can refine the search using the bar."
        : "İsteğini çözümlendirdim, aşağıdaki kartlarda en uygun seçenekleri hazırladım. Aramayı üstteki çubuktan detaylandırabilirsin.";

    let explanation = defaultExplanation;

    // ===================================================
    // LLM ÇAĞRISI (eski sistem korunuyor + context genişledi)
    //  S200 parametreleri de LLM'e aktarılıyor ki aynı beyni kullansın
    // ===================================================
    if (typeof llmFn === "function" && safeMsg) {
      try {
        const llmRes = await llmFn({
          message: safeMsg,
          locale,
          intent,
          mainCategory, // yeni: kategori sinyali
          memorySnapshot,
          pricingContext,
          cardsContext,
          userId,
          memoryProfile, // yeni hafıza sinyali

          // S200 CONTEXT
          source,
          visionLabels,
          qrPayload,
          embedding,
          userProfile,
          intentInfo,
        });

        const answer =
          (llmRes && (llmRes.answer || llmRes.text || llmRes.output)) ||
          "";

        if (answer && String(answer).trim()) {
          explanation = String(answer).trim();
        }
      } catch (err) {
        console.error("runAIPipeline llmFn error:", err);
      }
    }

    // ===================================================
    // HAFIZAYA GÖRE EK AÇIKLAMA BOOSTER
    // ===================================================
    if (memoryProfile) {
      let hint = "";

      if (memoryProfile.topProvider) {
        hint += ` • Bu zamana kadar en çok ${String(
          memoryProfile.topProvider
        ).toUpperCase()} kaynaklarını tercih ettin.`;
      }

      if (typeof memoryProfile.priceSensitivity === "number") {
        if (memoryProfile.priceSensitivity < 1) {
          hint += " • Uygun fiyatlı seçenekleri sık tercih ediyorsun.";
        } else if (memoryProfile.priceSensitivity > 1.15) {
          hint += " • Premium ürünlere daha yatkınsın.";
        }
      }

      if (memoryProfile.clickCount > 40) {
        hint += " • Sistem senin tercihlerinle oldukça iyi eğitildi.";
      }

      if (hint.trim()) {
        explanation +=
          "\n\n" +
          (locale === "en"
            ? "Based on your previous choices:" + hint
            : "Önceki seçimlerine göre:" + hint);
      }
    }

    // ===================================================
    // Cards — (eski davranış korunuyor + kategori/tag eklemesi)
    // ===================================================
    const cards = [];
    if (extracted) {
      cards.push({
        title: extracted,
        desc:
          locale === "en"
            ? "Tap to start a smart search with the best deals."
            : "En iyi tekliflerle akıllı aramayı başlatmak için dokun.",
        query: extracted,
        provider: "sono-ai",
        source: "pipeline",
        mainCategory, // yeni
        memoryBoost: memoryProfile || null, // debugging için
      });
    }

    // ===================================================
    // ÇIKTI
    //  - intent: S200 + legacy karışımı ama tek string
    //  - mainCategory: S200 categoryBrain + S5 beyni ile uyumlu
    //  - memoryProfile: vitrinEngine / adapterEngine S200 ile ortak kullanılabilir
    // ===================================================
    return {
      ok: true,
      intent,
      mainCategory, // yeni alan
      extracted,
      explanation,
      cards,
      memoryProfile, // vitrinEngine + unified search için
      intentInfo, // S200 intent ham datası (dilersen debug panelinde kullanırsın)
    };
  } catch (err) {
    console.error("runAIPipeline fatal error:", err);
    return {
      ok: false,
      intent: "chat",
      mainCategory: "product",
      extracted: "",
      explanation:
        locale === "en"
          ? "AI is having a temporary issue, but your offers are still available in the cards."
          : "AI tarafında geçici bir sorun var ama seçeneklerin kartlarda hazır.",
      cards: [],
      memoryProfile: null,
    };
  }
}

// ===================================================================
// S6–S7 Legacy Debug placeholder (S10 uyumluluk)
// ===================================================================
export function getAIDebugState() {
  return {
    ok: true,
    note: "S10+ sürümünde getAIDebugState eski kullanımdır (placeholder).",
    time: Date.now(),
    memoryPreview: {},
  };
}

export { inferIntent, extractSearchTerm };
