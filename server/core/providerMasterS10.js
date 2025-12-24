// server/core/providerMasterS10.js
// ============================================================
// FindAllEasy — Provider Master S10 (compat layer)
// Purpose: keep older imports working while the REAL master lives in providerMasterS9.js
//
// Why this exists:
// - Codebase'in bazı yerleri S10/S12 isimleriyle import ediyor.
// - Senin projende "gerçek master" S9 dosyasında (meta: displayName, family, key).
// - Named export mismatch yüzünden ESM import patlamasın diye burada alias'lar var.
// ============================================================

export {
  // S9 core (orijinal)
  PROVIDER_MASTER_S9,
  normalizeProviderKeyS9,
  getProviderMetaS9,
  getProviderAffiliateCapabilitiesS9,

  // S12/S15 fonksiyonları S9 içinde yaşıyor (bu codebase'de)
  extractDomainS12,
  normalizeProviderKeyS12,
  getProviderMetaS12,
  computeProviderRiskScoreS12,
  computeProviderNeuroScoreS12,
  computeProviderPriorityS12,
  sortByProviderPriorityS12,
  computeProviderTotalScoreS15,
  sortByProviderPriorityS15,

  // ek yardımcılar
  providerPriority,
  providerPolicyBoost,
  resolveProviderFromLinkS9,
} from "./providerMasterS9.js";

import {
  normalizeProviderKeyS12 as _normalizeProviderKeyS12,
  getProviderMetaS12 as _getProviderMetaS12,
  computeProviderPriorityS12 as _computeProviderPriorityS12,
  sortByProviderPriorityS12 as _sortByProviderPriorityS12,
} from "./providerMasterS9.js";

// ---------------------------------------------------------------------------
// Legacy name used in some modules: getProviderInfoS12
// S9'da "meta" dönüyor; S12 info diye bunu kullanıyoruz.
// ---------------------------------------------------------------------------
export function getProviderInfoS12(providerKey) {
  return _getProviderMetaS12(providerKey);
}

// S10 backward alias
export const getProviderInfoS10 = getProviderInfoS12;

// S10 normalize alias
export const normalizeProviderKeyS10 = _normalizeProviderKeyS12;

// ---------------------------------------------------------------------------
// Display helpers (S12 naming)
// ---------------------------------------------------------------------------
export function getProviderFamilyS12(providerKey) {
  const p = _getProviderMetaS12(providerKey) || {};
  return p.family || p.displayName || p.key || String(providerKey || "unknown");
}

export function getProviderDisplayNameS12(providerKey) {
  const p = _getProviderMetaS12(providerKey) || {};
  return p.displayName || p.key || String(providerKey || "Unknown");
}

// ---------------------------------------------------------------------------
// Compatibility wrappers (bazı modüller "score" isimlerini bekliyor)
// Burada score, provider bazlı priority'yi item üstünden hesaplar.
// ---------------------------------------------------------------------------
export async function computeProviderPriorityScore(item, region = "TR") {
  const provider =
    (item && typeof item === "object" && (item.provider || item.providerKey)) ? (item.provider || item.providerKey) : item;
  return _computeProviderPriorityS12(provider, region);
}

export const computeProviderPriorityScoreS10 = computeProviderPriorityScore;

export async function sortByProviderPriority(items, region = "TR") {
  return _sortByProviderPriorityS12(items, region);
}

export const sortByProviderPriorityS10 = sortByProviderPriority;

// ---------------------------------------------------------------------------
// Default export — tek kapı
// ---------------------------------------------------------------------------
export default {
  // S9
  PROVIDER_MASTER_S9: undefined, // re-export edildi
  normalizeProviderKeyS9: undefined,
  getProviderMetaS9: undefined,
  getProviderAffiliateCapabilitiesS9: undefined,

  // S12/S10
  normalizeProviderKeyS12: undefined,
  normalizeProviderKeyS10,
  getProviderMetaS12: undefined,
  getProviderInfoS12,
  getProviderInfoS10,
  getProviderFamilyS12,
  getProviderDisplayNameS12,
  computeProviderPriorityScore,
  computeProviderPriorityScoreS10,
  sortByProviderPriority,
  sortByProviderPriorityS10,

  // S15 (re-export edildi)
  computeProviderTotalScoreS15: undefined,
  sortByProviderPriorityS15: undefined,
};
