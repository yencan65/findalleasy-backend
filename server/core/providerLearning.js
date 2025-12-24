// server/core/dynamicProviderPriority.js
// ==============================================================
//   H E R K Ü L   S 1 5 . 9   T I T A N   U L T R A +
// ==============================================================
//   Provider Learning Engine — Final Form
//
//   ✔ Eski fonksiyonların TAMAMI korunmuştur (isim/usage bozulmadı)
//   ✔ Logarithmic öğrenme + recency-weighted decay
//   ✔ Deep normalization (URL / domain / isim varyantları tek key)
//   ✔ Atomic write (tmp → main) + crash recovery
//   ✔ Cold-start optimizer (yeni provider'lar ezilmiyor)
//   ✔ Auto-repair & format-merge (old number → new object şeması)
//   ✔ Priority output 0..5 ama arka planda continuous score tutar
// ==============================================================

import fs from "fs";
import path from "path";

const filePath = path.join(
  process.cwd(),
  "server",
  "core",
  "dynamicProviderPriority.json"
);

const tmpPath = filePath + ".tmp";

// ============================================================
// INTERNAL CACHE (S15 şeması)
//
// providerCache[key] = {
//   clicks: number,        // decay uygulanmış efektif click
//   totalClicks: number,   // ham toplam (istatistik)
//   last: number,          // timestamp (ms)
//   firstSeen: number,     // ilk kayıt
//   lastUpdated: number,   // son update
//   score: number,         // 0..1 continuous priority (S15)
// }
// ============================================================
let providerCache = Object.create(null);

// ============================================================
// CRASH RECOVERY (S11 → S15 güçlendirilmiş)
// ============================================================
function recoverIfBroken() {
  try {
    const hasTmp = fs.existsSync(tmpPath);
    const hasMain = fs.existsSync(filePath);

    // tmp varsa ama main yoksa: tmp → main
    if (hasTmp && !hasMain) {
      const raw = fs.readFileSync(tmpPath, "utf8");
      fs.writeFileSync(filePath, raw, "utf8");
      fs.unlinkSync(tmpPath);
      console.log("🛠  dynamicProviderPriority: TMP recovered → MAIN.");
    }

    // ikisi de varsa ve tmp daha yeniyse: tmp → main
    if (hasTmp && hasMain) {
      const tsTmp = fs.statSync(tmpPath).mtimeMs;
      const tsMain = fs.statSync(filePath).mtimeMs;

      if (tsTmp > tsMain) {
        const raw = fs.readFileSync(tmpPath, "utf8");
        fs.writeFileSync(filePath, raw, "utf8");
        fs.unlinkSync(tmpPath);
        console.log("🛠  dynamicProviderPriority: Latest TMP merged → MAIN");
      }
    }
  } catch (err) {
    console.warn("⚠️ dynamicProviderPriority recovery error:", err.message);
  }
}

// CALL ON START
recoverIfBroken();

// ============================================================
// SAFE LOAD (S11 — format merge → S15 şemasına yükseltme)
// ============================================================
(function safeLoad() {
  try {
    if (!fs.existsSync(filePath)) {
      providerCache = Object.create(null);
      return;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    let json = {};

    try {
      json = JSON.parse(raw || "{}");
    } catch (e) {
      console.warn("⚠️ dynamicProviderPriority: JSON parse hata, reset:", e.message);
      providerCache = Object.create(null);
      return;
    }

    const now = Date.now();
    const out = Object.create(null);

    for (const k in json) {
      const v = json[k];

      // Eski format: sadece sayı
      if (typeof v === "number") {
        out[k] = {
          clicks: Number(v) || 0,
          totalClicks: Number(v) || 0,
          last: now,
          firstSeen: now,
          lastUpdated: now,
          score: 0,
        };
      }

      // Yeni/karma format: obje
      else if (v && typeof v === "object") {
        const clicks = Number(v.clicks || v.score || 0) || 0;
        const total = Number(v.totalClicks || clicks) || clicks;
        const last = Number(v.last || v.lastSeen || now) || now;
        const firstSeen = Number(v.firstSeen || now) || now;
        const lastUpdated = Number(v.lastUpdated || last) || last;
        const score = typeof v.score === "number" ? v.score : 0;

        out[k] = {
          clicks,
          totalClicks: total,
          last,
          firstSeen,
          lastUpdated,
          score,
        };
      }
    }

    providerCache = out;
  } catch (err) {
    console.warn("⚠️ dynamicProviderPriority load error:", err.message);
    providerCache = Object.create(null);
  }
})();

// ============================================================
// S11 NORMALIZER — sektör standardı (S15 küçük iyileştirme)
// ============================================================
const norm = (input = "") => {
  try {
    let s = String(input || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^\/\//, "")
      .replace(/^www\./, "")
      .replace(/^m\./, "")
      .replace(/\?.*$/, "")
      .replace(/#.*/, "")
      .trim();

    if (!s) return "unknown";

    // path’i at
    const slashIndex = s.indexOf("/");
    if (slashIndex !== -1) {
      s = s.slice(0, slashIndex);
    }

    // son TLD kırpma (com, com.tr, net, org, io, co, app, shop vs.)
    s = s.replace(
      /\.(com\.tr|com|net|org|io|co|de|uk|fr|ru|tr|app|shop|store)$/g,
      ""
    );

    s = s
      .replace(/adapter|scraper|engine|client|api/gi, "")
      .trim();

    return s || "unknown";
  } catch {
    return "unknown";
  }
};

// ============================================================
// DECAY FACTOR — S15 log-smooth
// (7 günden önce decay yok, sonrası log tabanlı yumuşak azalma)
// ============================================================
function applyDecay(item, now) {
  if (!item || typeof item !== "object") return 0;

  const last = Number(item.last || item.lastUpdated || now) || now;
  const diffDays = (now - last) / 86400000;

  if (diffDays <= 0) return item.clicks || 0;
  if (diffDays <= 7) return item.clicks || 0;

  // 7 günden sonra log-smooth decay
  const daysOver = Math.max(0, diffDays - 7);

  // 0 günde factor ~1, 30+ günde ~0.25 civarı
  const factor = 1 / (1 + Math.log2(1 + daysOver));

  const decayed = (item.clicks || 0) * factor;

  item.clicks = decayed;
  item.last = last; // last değişmiyor, sadece clicks düşüyor

  return decayed;
}

// ============================================================
// CLICK KAYIT — S15 ULTRA
// ============================================================
export function recordProviderClick(providerName) {
  const key = norm(providerName);
  if (!key) return;

  const now = Date.now();

  if (!providerCache[key]) {
    // cold-start optimizasyonu
    providerCache[key] = {
      clicks: 1,
      totalClicks: 1,
      last: now,
      firstSeen: now,
      lastUpdated: now,
      score: 0,
    };
  } else {
    const item = providerCache[key];

    // 1) zaman bazlı decay
    applyDecay(item, now);

    // 2) logarithmic increment (doyuma giden model)
    //    düşük click → büyük artış, yüksek click → az artış
    const base = item.clicks || 0;
    const inc = Math.max(0.35, Math.log2(base + 4) / 5); // ~0.35–1 arası

    item.clicks = base + inc;
    item.totalClicks = (item.totalClicks || base) + 1;
    item.last = now;
    item.lastUpdated = now;
  }

  // 3) continuous score hesapla (0..1)
  try {
    const it = providerCache[key];
    const effective = it.clicks || 0;

    // log tabanlı normalizasyon
    const score = Math.min(1, Math.log2(effective + 2) / 8); // 0..1 aralığı

    it.score = +score.toFixed(4);
  } catch {
    // skor hesaplanmasa da motor devam eder
  }

  safeSave();
}

// ============================================================
// PRIORITY LEVEL OUTPUT — 0..5 (S15 continuous → discrete)
// ============================================================
export function getLearnedProviderPriority() {
  const result = {};

  const now = Date.now();

  for (const key in providerCache) {
    const item = providerCache[key];
    if (!item) continue;

    // her çağrıda hafif decay uygulayarak eski veriyi yumuşat
    const effectiveClicks = applyDecay(item, now);
    const score = item.score || (Math.log2(effectiveClicks + 2) / 8);

    // 0..1 skoru 0..5 bandına map et
    let level = 0;

    if (score > 0.80) level = 5;
    else if (score > 0.60) level = 4;
    else if (score > 0.40) level = 3;
    else if (score > 0.20) level = 2;
    else if (score > 0.05) level = 1;
    else level = 0;

    result[key] = level;
  }

  return result;
}

// ============================================================
// SAFE SAVE — atomic + repair
// ============================================================
function safeSave() {
  try {
    const raw = JSON.stringify(providerCache, null, 2);

    // önce tmp'ye yaz, sonra rename → atomic
    fs.writeFileSync(tmpPath, raw, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn("⚠️ dynamicProviderPriority save error:", err.message);
  }
}

// ============================================================
// INTERNAL — RESET (silinmedi, dışarıya açılmadı)
// ============================================================
function __resetAll() {
  providerCache = Object.create(null);
  safeSave();
}

// ============================================================
// EXPORT
// ============================================================
export default {
  recordProviderClick,
  getLearnedProviderPriority,
};
