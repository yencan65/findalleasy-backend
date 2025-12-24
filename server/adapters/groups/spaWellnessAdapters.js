// server/adapters/groups/spaWellnessAdapters.js
// ============================================================================
// BRIDGE / ALIAS GROUP — spaWellnessAdapters -> spaAdapters (S200)
// Amaç: _allGroups.js eski importlarını KIRMADAN yeni spaAdapters.js'e bağlamak.
// ZERO DELETE • DRIFT KILLER
// ============================================================================

export * from "./spaAdapters.js";

import spaWellnessAdaptersDefault, {
  spaAdapters,
  spaWellnessAdapters,
  spaAdapterFns,
  spaWellnessFns,
  searchSpa,
  spaAdapterStats,
  SPA_ADAPTER_REGISTRY,
  spaTypes,
  detectSpaType,
} from "./spaAdapters.js";

export {
  spaAdapters,
  spaWellnessAdapters,
  spaAdapterFns,
  spaWellnessFns,
  searchSpa,
  spaAdapterStats,
  SPA_ADAPTER_REGISTRY,
  spaTypes,
  detectSpaType,
};

export default spaWellnessAdaptersDefault;
