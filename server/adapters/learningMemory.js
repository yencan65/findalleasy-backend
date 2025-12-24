// BACKEND/BACKEND/core/learningMemory.js
// ============================================================================
//  S22 ULTRA-TITAN LEARNING MEMORY ENGINE
// ----------------------------------------------------------------------------
//  ZERO DELETE PRENSİBİ:
//    - Eski API korunur: getUserMemory, updateUserMemory,
//      getTopCategory, getTopProvider, getPriceSensitivity, memory
//    - S5 mantığı tamamen duruyor, üstüne S22 zekâ katmanı eklendi
// ----------------------------------------------------------------------------
//  S22 EKLEMELER:
//    • Time-decay güçlendirildi (saat bazlı, non-linear)
//    • Fiyat davranışı → rolling median + band modeli (low/mid/high)
//    • priceSensitivity → gerçek davranışa göre ayarlı skalar (0.7–1.3)
//    • trustScore → soft-sigmoid, 0.5–1.5 bandında güven modeli
//    • behaviorGraph → provider/category bazlı davranış ağı
//    • coldStart → ilk tıklamalarda özel mod
//    • queries → enriched kayıt (q, ts, source, category, priceBand)
//    • RAM oto-temizlik korundu, hafif güçlendirildi
// ============================================================================

// In-memory store (Node restart → reset olur, tasarım gereği)
const memory = new Map();

// ------------------------------------------------------------
// S22 SAFE HELPERS
// ------------------------------------------------------------
const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

function softSigmoid(x) {
  // y ≈ (1 / (1 + e^-x)) scaled to ~[0,1]
  const y = 1 / (1 + Math.exp(-x));
  return y;
}

function nowMs() {
  return Date.now();
}

// ============================================================
//   DEFAULT MEMORY (S22 SHAPE) — TÜM ANA ALANLAR BURADA
// ============================================================
function defaultMemory() {
  const ts = nowMs();
  return {
    // S5 çekirdek
    clicks: 0,
    favorites: [],           // {id, provider, ts}
    preferredSources: [],    // ["trendyol","hepsiburada",...]
    queries: [],             // {q, ts, source, category, priceBand}
    queryEmbeddings: [],     // ileride dış AI ile doldurulabilir
    categoryWeight: {},      // { "electronics": score }
    providerWeight: {},      // { "trendyol": score }
    priceSensitivity: 1.0,   // 1: nötr, <1 ucuz sever, >1 pahalı sever
    lastActive: ts,

    // S5-ULTRA ekleri (senin sürümünden korunuyor)
    decayBase: 0.985,
    trustScore: 0.8,         // normalize edilmiş skor (0.5–1.5 hedefleniyor)
    avgClickPrice: null,
    clickMeta: [],           // fiyat geçmişi (son 50)

    // S22 ULTRA FIELD’LER
    coldStart: true,         // ilk 5–10 click arası true kalır
    sessionId: null,         // istersen request tarafında doldur
    longTermScore: 0,        // toplam öğrenme puanı
    lastQuery: null,
    lastCategory: "general",
    lastProvider: null,

    // Fiyat bant modeli
    priceBands: {
      low: null,
      mid: null,
      high: null,
    },

    // Davranış grafı (ileride vitrin / explanation için kullanılabilir)
    behaviorGraph: {
      // nodes: { "provider:trendyol": { count, lastTs }, ... }
      nodes: {},
      // edges: { from, to, weight }
      edges: [],
    },
  };
}

// ============================================================
//   INTERNAL: MEMORY ŞEKLİNİ S22 İLE UYUMLU HALE GETİR
//   (Eski kayıtlarda eksik key varsa doldurur)
// ============================================================
function ensureMemoryShape(mem) {
  const base = defaultMemory();

  // primitive alanlar
  const out = {
    ...base,
    ...mem,
  };

  // nested objects güvenliği
  out.categoryWeight = { ...base.categoryWeight, ...(mem.categoryWeight || {}) };
  out.providerWeight = { ...base.providerWeight, ...(mem.providerWeight || {}) };
  out.priceBands = { ...base.priceBands, ...(mem.priceBands || {}) };

  // arrays
  out.favorites = Array.isArray(mem.favorites) ? mem.favorites : base.favorites;
  out.queries = Array.isArray(mem.queries) ? mem.queries : base.queries;
  out.queryEmbeddings = Array.isArray(mem.queryEmbeddings)
    ? mem.queryEmbeddings
    : base.queryEmbeddings;
  out.clickMeta = Array.isArray(mem.clickMeta) ? mem.clickMeta : base.clickMeta;

  if (!out.behaviorGraph || typeof out.behaviorGraph !== "object") {
    out.behaviorGraph = base.behaviorGraph;
  } else {
    out.behaviorGraph.nodes = {
      ...(base.behaviorGraph.nodes || {}),
      ...(out.behaviorGraph.nodes || {}),
    };
    out.behaviorGraph.edges = Array.isArray(out.behaviorGraph.edges)
      ? out.behaviorGraph.edges
      : base.behaviorGraph.edges;
  }

  // clamp & sanity
  out.priceSensitivity = clamp(
    Number.isFinite(out.priceSensitivity) ? out.priceSensitivity : 1.0,
    0.7,
    1.3
  );

  out.trustScore = clamp(
    Number.isFinite(out.trustScore) ? out.trustScore : 0.8,
    0.5,
    1.5
  );

  return out;
}

// ============================================================
//   INTERNAL: DECAY UYGULA (S22)
// ============================================================
function applyDecay(mem) {
  const now = nowMs();
  const diff = now - (mem.lastActive || now);
  if (diff <= 0) return mem;

  const hours = diff / (60 * 60 * 1000);
  if (hours <= 0.5) return mem; // 30 dakikanın altı → boş ver

  const base = mem.decayBase || 0.985;
  const factor = Math.pow(base, hours);

  // category ve provider ağırlıkları
  for (const k of Object.keys(mem.categoryWeight)) {
    mem.categoryWeight[k] *= factor;
    if (mem.categoryWeight[k] < 0.001) delete mem.categoryWeight[k];
  }
  for (const k of Object.keys(mem.providerWeight)) {
    mem.providerWeight[k] *= factor;
    if (mem.providerWeight[k] < 0.001) delete mem.providerWeight[k];
  }

  // trust & longTermScore biraz zayıflasın
  mem.trustScore = clamp(mem.trustScore * (0.99 + factor * 0.01), 0.5, 1.5);
  mem.longTermScore *= factor;

  return mem;
}

// ============================================================
//   INTERNAL: FİYAT MODELİ (MEDIAN + BANDS)
// ============================================================
function recomputePriceModel(mem) {
  const arr = mem.clickMeta || [];
  if (!arr.length) {
    mem.avgClickPrice = null;
    mem.priceBands = { low: null, mid: null, high: null };
    mem.priceSensitivity = 1.0;
    return mem;
  }

  const sorted = [...arr].sort((a, b) => a - b);
  const midIdx = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[midIdx]
    : (sorted[midIdx - 1] + sorted[midIdx]) / 2;

  const q1Idx = Math.floor(sorted.length * 0.25);
  const q3Idx = Math.floor(sorted.length * 0.75);
  const q1 = sorted[q1Idx];
  const q3 = sorted[q3Idx];

  mem.avgClickPrice = median;
  mem.priceBands = {
    low: q1,
    mid: median,
    high: q3,
  };

  // Fiyat hassasiyeti → median’a göre normalize
  // median düşükse → ucuz seven (0.7–1)
  // median yüksekse → pahalı seven (1–1.3)
  const minRef = sorted[0];
  const maxRef = sorted[sorted.length - 1] || median || 1;

  if (!maxRef || !median) {
    mem.priceSensitivity = 1.0;
    return mem;
  }

  const norm = (median - minRef) / (maxRef - minRef || 1);
  // norm 0 → ucuz, 1 → pahalı
  const ps = 0.7 + norm * 0.6; // 0.7–1.3 aralığı
  mem.priceSensitivity = clamp(ps, 0.7, 1.3);

  return mem;
}

// ============================================================
//   INTERNAL: BEHAVIOR GRAPH UPDATE
// ============================================================
function touchNode(graph, key) {
  if (!graph.nodes[key]) {
    graph.nodes[key] = { count: 0, lastTs: nowMs() };
  }
  graph.nodes[key].count += 1;
  graph.nodes[key].lastTs = nowMs();
}

function addEdge(graph, from, to, weight = 1) {
  if (!from || !to || from === to) return;
  const edgeKey = `${from}→${to}`;
  const existing = graph.edges.find((e) => e.key === edgeKey);
  if (existing) {
    existing.weight += weight;
    existing.lastTs = nowMs();
  } else {
    graph.edges.push({
      key: edgeKey,
      from,
      to,
      weight,
      lastTs: nowMs(),
    });
  }

  // hafif temizlik: çok büyürse en eski 200 kenarı tut
  if (graph.edges.length > 200) {
    graph.edges.sort((a, b) => a.lastTs - b.lastTs);
    graph.edges = graph.edges.slice(-200);
  }
}

function updateBehaviorGraph(mem, { provider, category }) {
  const graph = mem.behaviorGraph || { nodes: {}, edges: [] };
  const providerNode = provider ? `provider:${provider}` : null;
  const categoryNode = category ? `category:${category}` : null;

  if (providerNode) touchNode(graph, providerNode);
  if (categoryNode) touchNode(graph, categoryNode);

  if (providerNode && categoryNode) {
    addEdge(graph, providerNode, categoryNode, 1);
    addEdge(graph, categoryNode, providerNode, 0.5);
  }

  mem.behaviorGraph = graph;
  return mem;
}

// ============================================================
//   PUBLIC: GET USER MEMORY (S22 UYUMLU)
// ============================================================
export async function getUserMemory(userId) {
  if (!userId) {
    // anon kullanıcı için yeni default döndür (ama Map'e yazma)
    return defaultMemory();
  }

  const existing = memory.get(userId);
  const mem = ensureMemoryShape(existing || defaultMemory());

  // decay uygulayalım
  applyDecay(mem);

  // hafif coldStart tespiti
  if (mem.clicks > 10 || mem.queries.length > 15) {
    mem.coldStart = false;
  }

  // güncellenmiş mem'i geri yaz
  memory.set(userId, mem);
  return mem;
}

// ============================================================
//   PUBLIC: UPDATE USER MEMORY — S22 ULTRA
//   Eski imza korunur:
//   updateUserMemory(userId, query, source, category = "general", pricedItem = null)
//   • S22’de ekstra parametreler isteğe bağlı eklenebilir
// ============================================================
export async function updateUserMemory(
  userId,
  query,
  source,
  category = "general",
  pricedItem = null,
  eventType = "click",      // "click" | "favorite" | "purchase" | "view" ...
  extra = {}                // { sessionId, embedding, isFavorite, ... }
) {
  try {
    if (!userId) return;

    const q = typeof query === "string" ? query.trim() : String(query || "");
    const src = typeof source === "string" ? source.trim() : "";
    const cat = typeof category === "string" ? category.trim() : "general";

    // Mevcut hafızayı al, S22 shape'e zorla
    let mem = memory.get(userId) || defaultMemory();
    mem = ensureMemoryShape(mem);

    const now = nowMs();

    // --------------------------------------------------------
    // 1) Tıklama / Etkinlik sayısı
    // --------------------------------------------------------
    if (eventType === "click" || eventType === "purchase" || eventType === "view") {
      mem.clicks += 1;
      mem.longTermScore += eventType === "purchase" ? 3 : 1;
    }

    // --------------------------------------------------------
    // 2) Query geçmişi (enriched)
    // --------------------------------------------------------
    if (q.length > 1) {
      // priceBand tahmini: mevcut bandlara göre
      let priceBand = null;
      if (mem.priceBands && pricedItem && pricedItem.price != null) {
        const p = Number(pricedItem.price);
        const { low, mid, high } = mem.priceBands;
        if (low != null && high != null) {
          if (p <= low) priceBand = "low";
          else if (p >= high) priceBand = "high";
          else priceBand = "mid";
        }
      }

      mem.queries.push({
        q,
        ts: now,
        source: src || null,
        category: cat || "general",
        priceBand,
      });

      if (mem.queries.length > 60) mem.queries.shift();
    }

    // --------------------------------------------------------
    // 3) Provider öğrenme
    // --------------------------------------------------------
    if (src) {
      if (!mem.preferredSources.includes(src)) {
        mem.preferredSources.push(src);
        if (mem.preferredSources.length > 40) {
          mem.preferredSources = mem.preferredSources.slice(-40);
        }
      }
      const inc =
        eventType === "purchase" ? 2.0 :
        eventType === "favorite" ? 1.5 :
        1.0;
      mem.providerWeight[src] = (mem.providerWeight[src] || 0) + inc;
    }

    // --------------------------------------------------------
    // 4) Kategori öğrenme
    // --------------------------------------------------------
    const catKey = cat || "general";
    const catInc =
      eventType === "purchase" ? 2.0 :
      eventType === "favorite" ? 1.5 :
      1.0;
    mem.categoryWeight[catKey] = (mem.categoryWeight[catKey] || 0) + catInc;

    mem.lastCategory = catKey;
    mem.lastProvider = src || mem.lastProvider;

    // --------------------------------------------------------
    // 5) Fiyat davranışı (S22)
    // --------------------------------------------------------
    if (pricedItem && pricedItem.price != null) {
      const p = Number(pricedItem.price);
      if (Number.isFinite(p) && p > 0) {
        mem.clickMeta.push(p);
        if (mem.clickMeta.length > 50) mem.clickMeta.shift();

        // fiyat modelini yeniden hesapla (median + band + sensitivity)
        recomputePriceModel(mem);
      }
    }

    // --------------------------------------------------------
    // 6) Trust modeli (S22) — provider + category uyumu
    // --------------------------------------------------------
    let trustDelta = 0;
    if (src && mem.preferredSources.includes(src)) {
      trustDelta += 0.02;
    }
    if (catKey && mem.categoryWeight[catKey] > 3) {
      trustDelta += 0.01;
    }
    if (eventType === "purchase") trustDelta += 0.05;
    if (eventType === "view") trustDelta -= 0.002; // sadece bakıp geçme

    // Raw trust skorunu logistic şekilde normalize et
    const rawTrust = (mem.trustScore || 0.8) + trustDelta;
    const sig = softSigmoid(rawTrust - 1.0); // merkez 1.0 etrafında
    const normalizedTrust = 0.5 + sig; // ~[0.5,1.5] bandına sıkıştır
    mem.trustScore = clamp(normalizedTrust, 0.5, 1.5);

    // --------------------------------------------------------
    // 7) Favorites (eventType = "favorite" veya extra.isFavorite)
    // --------------------------------------------------------
    const isFav = eventType === "favorite" || extra.isFavorite;
    if (isFav && extra.itemId) {
      mem.favorites.push({
        id: extra.itemId,
        provider: src || null,
        ts: now,
      });
      if (mem.favorites.length > 100) {
        mem.favorites = mem.favorites.slice(-100);
      }
    }

    // --------------------------------------------------------
    // 8) Davranış grafı (provider/category)
    // --------------------------------------------------------
    updateBehaviorGraph(mem, {
      provider: src || null,
      category: catKey || null,
    });

    // --------------------------------------------------------
    // 9) Cold-start tespiti
    // --------------------------------------------------------
    if (mem.clicks > 10 || mem.queries.length > 15) {
      mem.coldStart = false;
    }

    // --------------------------------------------------------
    // 10) sessionId ve embedding (isteğe bağlı, dış AI ile)
    // --------------------------------------------------------
    if (extra.sessionId) {
      mem.sessionId = String(extra.sessionId);
    }
    if (extra.embedding && Array.isArray(extra.embedding)) {
      // minimal: sadece son embedding’i tut
      mem.queryEmbeddings.push({
        ts: now,
        source: src || null,
        category: catKey || null,
        embedding: extra.embedding,
      });
      if (mem.queryEmbeddings.length > 30) {
        mem.queryEmbeddings.shift();
      }
    }

    // --------------------------------------------------------
    // 11) aktiflik & cleanup
    // --------------------------------------------------------
    mem.lastActive = now;
    mem.lastQuery = q || mem.lastQuery;

    // Global RAM koruması
    if (memory.size > 5000) {
      const oldest = [...memory.entries()].sort(
        (a, b) => (a[1].lastActive || 0) - (b[1].lastActive || 0)
      )[0];
      if (oldest) memory.delete(oldest[0]);
    }

    // Son hali Map’e yaz
    memory.set(userId, mem);
  } catch (err) {
    console.error("⚠️ updateUserMemory hatası:", err.message);
  }
}

// ============================================================
//   ANALYTICS — VİTRİN / AI PIPELINE YARDIMCI FONKSİYONLARI
//   (İSİMLERİ DEĞİŞMEDİ, SADECE S22 UYUMLU)
// ============================================================
export function getTopCategory(mem) {
  const m = ensureMemoryShape(mem || defaultMemory());
  const weights = m.categoryWeight || {};
  let best = "general";
  let bestScore = 0;

  for (const [cat, w] of Object.entries(weights)) {
    if (w > bestScore) {
      bestScore = w;
      best = cat;
    }
  }

  return best || "general";
}

export function getTopProvider(mem) {
  const m = ensureMemoryShape(mem || defaultMemory());
  const weights = m.providerWeight || {};
  let best = null;
  let bestScore = 0;

  for (const [pv, w] of Object.entries(weights)) {
    if (w > bestScore) {
      bestScore = w;
      best = pv;
    }
  }

  return best;
}

export function getPriceSensitivity(mem) {
  const m = ensureMemoryShape(mem || defaultMemory());
  if (m.coldStart) {
    // cold-start kullanıcıları için hafif nötre yaklaştır
    return 0.85 + (m.priceSensitivity - 0.85) * 0.4;
  }
  return m.priceSensitivity ?? 1.0;
}

// ============================================================
//   EXPORT RAW MEMORY MAP (debug / external usage)
// ============================================================
export { memory };
