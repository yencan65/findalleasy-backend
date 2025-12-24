// server/utils/queryTypoFixer.js
// ============================================================================
// QUERY TYPO FIXER (TR) — conservative typo correction for user input
// - Goal: "tlfon" -> "telefon", "tkne" -> "tekne" etc.
// - Safety: ONLY high-confidence corrections (small edit distance, same-ish length)
// - ZERO DELETE: can be adopted by routes without breaking the contract.
// ============================================================================

function normalizeTokenForMatch(t) {
  return String(t || "")
    .toLowerCase()
    // Turkish-friendly fold (keep it simple)
    .replaceAll("ı", "i")
    .replaceAll("İ", "i")
    .replaceAll("ş", "s")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c");
}

// Fast Levenshtein with early cutoff (returns cutoff+1 if exceeds)
function levenshteinCut(a, b, cutoff = 2) {
  a = normalizeTokenForMatch(a);
  b = normalizeTokenForMatch(b);
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la || !lb) return Math.max(la, lb);
  if (Math.abs(la - lb) > cutoff) return cutoff + 1;

  // Ensure a is shorter
  if (la > lb) { const tmp = a; a = b; b = tmp; }

  const v0 = new Array(b.length + 1);
  const v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;

  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    let rowMin = v1[0];

    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      const m = Math.min(
        v1[j] + 1,       // insertion
        v0[j + 1] + 1,   // deletion
        v0[j] + cost     // substitution
      );
      v1[j + 1] = m;
      if (m < rowMin) rowMin = m;
    }

    if (rowMin > cutoff) return cutoff + 1;

    // swap
    for (let k = 0; k <= b.length; k++) v0[k] = v1[k];
  }
  return v0[b.length];
}

// Core vocab: keep it small + high-value. Expand gradually with telemetry.
const CORE_VOCAB = [
  // commerce
  "telefon","iphone","samsung","kulaklik","laptop","bilgisayar","tablet","sarj","kablo","powerbank",
  // travel / rentals
  "otel","ucak","bilet","arac","araba","kiralama","kiralik","rent","tekne","yat","tur","gezi",
  // services
  "psikolog","psikiyatri","doktor","dis","disci","klima","kombi","tesisatci","elektrikci","marangoz",
  // food / market
  "pizza","sut","peynir","ekmek","kahve","restoran",
  // misc
  "sigorta","avukat","kurs","egitim","checkup",
];

export function fixQueryTyposTR(input) {
  const q = String(input || "").trim();
  if (!q) return { query: "", fixed: false, changes: [] };

  // Split on spaces, keep simple; do not touch URLs
  const parts = q.split(/\s+/g).filter(Boolean);

  const changes = [];
  const fixedParts = parts.map((tok) => {
    // Skip tokens that are URLs/emails or too short
    const t = String(tok);
    if (t.length < 4) return t;
    if (/[\/:@.]/.test(t)) return t;
    if (/^\d+$/.test(t)) return t;

    const norm = normalizeTokenForMatch(t);
    let best = null;
    let bestDist = 3;

    // Allow 1 edit for short, 2 for longer
    const cutoff = t.length <= 6 ? 1 : 2;

    for (const cand of CORE_VOCAB) {
      // Quick length guard
      if (Math.abs(cand.length - norm.length) > cutoff) continue;
      const d = levenshteinCut(norm, cand, cutoff);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
        if (d === 0) break;
      }
    }

    if (best && bestDist > 0 && bestDist <= cutoff) {
      // Extra safety: avoid wild replacements for longer tokens
      if (t.length >= 8 && bestDist === 2) return t;
      changes.push({ from: t, to: best, dist: bestDist });
      return best;
    }

    return t;
  });

  const out = fixedParts.join(" ");
  return { query: out, fixed: out !== q, changes };
}
