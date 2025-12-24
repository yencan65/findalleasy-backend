// ============================================================================
// unifiedAIEngine.js — S12 OMEGA UNIFIED BRAIN
// Zero-Noise • Zero-Leak • Deep Intent Fusion • Multi-Input AI Mapper
// Tüm input çeşitlerini tek bir “anlamlı teknik aramaya” dönüştürür.
// ============================================================================

import { detectIntent } from "./intentEngine.js";
import { detectAdvancedIntent } from "./intentEngineAdvanced.js";
import { mapQueryForAdapters } from "./queryMapper.js";

// ---------------------------------------------------------------------------
// CLEANER — S12 (Noise Killer)
// ---------------------------------------------------------------------------
function cleanInput(raw) {
  if (!raw) return "";
  const t = String(raw).trim().toLowerCase();

  // Gürültü temizleme
  return t
    .replace(/\s+/g, " ")          // double space fix
    .replace(/[^\p{L}\p{N}\s.,-]/gu, "") // emoji, ikon, kontrol karakteri temizle
    .trim();
}

// ---------------------------------------------------------------------------
// INPUT CLASSIFIER (S12)
// text / voice / camera / barcode / qr / vision
// ---------------------------------------------------------------------------
function classifySource(source) {
  const s = String(source || "").toLowerCase();

  if (s.includes("voice")) return "voice";
  if (s.includes("audio")) return "voice";
  if (s.includes("mic")) return "voice";

  if (s.includes("cam")) return "camera";
  if (s.includes("photo")) return "camera";
  if (s.includes("img")) return "camera";
  if (s.includes("vision")) return "vision";

  if (s.includes("qr")) return "qr";
  if (s.includes("barcode")) return "barcode";
  if (s.includes("code")) return "barcode";

  return "text";
}

// ---------------------------------------------------------------------------
// FAILSAFE WRAPPER — motor asla çökmez
// ---------------------------------------------------------------------------
function safeReturn(rawInput, source, intent, adv, mapped) {
  return {
    ok: true,
    source,
    raw: rawInput,
    intent: intent || "search",
    advancedIntent: adv || {},
    mappedQuery: mapped || rawInput,
  };
}

// ---------------------------------------------------------------------------
// S12 — UNIFIED QUERY BUILDER
// ---------------------------------------------------------------------------
export async function buildUnifiedAIQuery(rawInput, source = "text") {
  try {
    const clean = cleanInput(rawInput);
    const src = classifySource(source);

    if (!clean) {
      return safeReturn("", src, "search", {}, "");
    }

    // 1 — Basit niyet
    const intent = detectIntent(clean);

    // 2 — Derin niyet (bütçe, bölge, marka, model, kategori vb.)
    const advancedIntent = detectAdvancedIntent(clean, intent);

    // 3 — Adapter dili
    const mappedQuery = await mapQueryForAdapters(
      clean,
      intent,
      advancedIntent,
      src
    );

    return safeReturn(clean, src, intent, advancedIntent, mappedQuery);
  } catch (err) {
    console.log("❌ UnifiedAIEngine S12 ERROR:", err.message);

    return {
      ok: false,
      raw: rawInput,
      source,
      intent: null,
      advancedIntent: null,
      mappedQuery: rawInput,
    };
  }
}
