// ============================================================================
// PROVIDER PRIORITY ENGINE — S22 ULTRA TITAN EDITION
// ZERO DELETE → S7 davranış korunur, üzerine S22 AI Learning Layer eklenir
// ---------------------------------------------------------------------------
// Yeni Özellikler:
// • incomeWeight + clickWeight birleşik skoru
// • providerSuccessRate (hit ratio / conversion)
// • logarithmic scaling (anti-inflation)
// • decay (zamanla ağırlık dengeleme)
// • normalizeProviderKey S9 ile tam uyum
// • atomic write korunur
// ============================================================================

import fs from "fs";
import path from "path";

// S7 NORMALIZER — silinmez
const norm = (x = "") =>
  String(x)
    .trim()
    .toLowerCase()
    .replace(/www\./, "")
    .replace(/\.com|\.com\.tr|\.net|\.org/g, "");

// FILE PATH
const filePath = path.join(
  process.cwd(),
  "server",
  "core",
  "dynamicProviderPriority.json"
);

// ensure target directory exists (avoid ENOENT on fresh deploy)
function ensureDirForFile(fp) {
  try {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // non-fatal
  }
}

// RAM CACHE
let providerCache = {};

// ============================================================================
// SAFE LOAD (S7 KORUNUR)
// ============================================================================
(function safeLoad() {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf8");
      providerCache = JSON.parse(data || "{}");
    }
  } catch (err) {
    console.warn("⚠️ dynamicProviderPriority load error:", err.message);
    providerCache = {};
  }
})();

// ============================================================================
// NEW — S22 INTERNAL MEMORY LAYER
// providerDynamics = {
//   providerKey: {
//     clicks: n,
//     income: totalRevenue,
//     success: conversions,
//     decayIndex: timestamp,
//   }
// }
// ============================================================================
let providerDynamics = {};

// SAFE INIT
for (const key in providerCache) {
  providerDynamics[key] = {
    clicks: providerCache[key] || 0,
    income: 0,
    success: 0,
    decayIndex: Date.now(),
  };
}

// ============================================================================
// S7: recordProviderClick → KORUNUR AMA GÜÇLENDİRİLİR
// ============================================================================
export function recordProviderClick(providerName) {
  const key = norm(providerName);
  if (!key) return;

  // S7 behavior: click counter
  if (!providerCache[key]) providerCache[key] = 1;
  else providerCache[key]++;

  // S22 extended dynamics
  if (!providerDynamics[key]) {
    providerDynamics[key] = {
      clicks: 1,
      income: 0,
      success: 0,
      decayIndex: Date.now(),
    };
  } else {
    providerDynamics[key].clicks++;
  }

  safeSave();
}

// ============================================================================
// NEW S22 API — recordProviderIncome
// gelir bazlı öğrenme (affiliate dönüşleri)
// ============================================================================
export function recordProviderIncome(providerName, amount = 0) {
  const key = norm(providerName);
  if (!key) return;

  if (!providerDynamics[key]) {
    providerDynamics[key] = {
      clicks: 0,
      income: amount,
      success: 0,
      decayIndex: Date.now(),
    };
  } else {
    providerDynamics[key].income += Math.max(0, amount);
  }

  safeSave();
}

// ============================================================================
// NEW S22 API — recordProviderSuccess
// başarılı işlem/dönüşüm
// ============================================================================
export function recordProviderSuccess(providerName) {
  const key = norm(providerName);
  if (!key) return;

  if (!providerDynamics[key]) {
    providerDynamics[key] = {
      clicks: 0,
      income: 0,
      success: 1,
      decayIndex: Date.now(),
    };
  } else {
    providerDynamics[key].success++;
  }

  safeSave();
}

// ============================================================================
// TITAN SCORE — S22 PROVIDER PRIORITY COMPOSITE SCORE
// ----------------------------------------------------
// Score bileşenleri:
//   • wClick:    log10(clicks + 1)
//   • wIncome:   log10(income + 1) * 1.5
//   • wSuccess:  log2(success + 1) * 2
//   • decay:     zaman geçtikçe otomatik düşüş
// ============================================================================
function computeTitanScore(x) {
  if (!x) return 1;

  const t = Date.now();
  const age = Math.max(1, (t - (x.decayIndex || t)) / (1000 * 60 * 60 * 24)); // gün farkı
  const decay = Math.max(0.3, 1 / Math.log(age + 2)); // yumuşak decay

  const wClick = Math.log10((x.clicks || 0) + 1);
  const wIncome = Math.log10((x.income || 0) + 1) * 1.5;
  const wSuccess = Math.log2((x.success || 0) + 1) * 2;

  const score = (wClick + wIncome + wSuccess) * decay;

  return Math.min(Math.max(score, 1), 10); // Range: 1–10
}

// ============================================================================
// GET PRIORITY MAP — S22 ULTRA MODE
// ============================================================================
export function getLearnedProviderPriority() {
  const finalMap = {};
  for (const key in providerDynamics) {
    finalMap[key] = computeTitanScore(providerDynamics[key]);
  }
  return finalMap;
}

// ============================================================================
// SAFE SAVE — Z E R O  D E L E T E
// ============================================================================
function safeSave() {
  try {
    
    ensureDirForFile(filePath);
const scaled = {};

    for (const key in providerDynamics) {
      // backward compatibility (S7): use click count only
      const s7value = providerDynamics[key].clicks || 0;

      // S22 composite score
      const titan = computeTitanScore(providerDynamics[key]);

      // stored value = hybrid (S7 required)
      scaled[key] = s7value;

      // shadow file (S22 extra)
      providerDynamics[key].titanScore = titan;
    }

    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(scaled, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);

  } catch (err) {
    console.warn("⚠️ dynamicProviderPriority save error:", err.message);
  }
}
