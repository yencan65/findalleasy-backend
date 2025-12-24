// ============================================================================
// FAE METRICS ENGINE — S100 ULTRA
// Global Registry + Core Metrics + Latency Tracking
// ============================================================================

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from "prom-client";

// ------------------------------------------------------------
// GLOBAL REGISTRY
// ------------------------------------------------------------
export const register = new Registry();
collectDefaultMetrics({ register });

// ------------------------------------------------------------
// METRICS DEFINITIONS (S100)
// ------------------------------------------------------------

// Adapter latency (ms)
export const adapterLatency = new Histogram({
  name: "fae_adapter_latency_ms",
  help: "Adapter çalışma süresi (ms)",
  buckets: [20, 50, 100, 200, 500, 1000, 3000],
});

// Vitrin latency
export const vitrinLatency = new Histogram({
  name: "fae_vitrin_latency_ms",
  help: "Vitrin motoru toplam çalışma süresi (ms)",
  buckets: [50, 100, 200, 300, 500, 1000, 5000],
});

// Hata sayaçları
export const adapterErrors = new Counter({
  name: "fae_adapter_errors_total",
  help: "Adapter motoru hata sayısı",
});

export const vitrinErrors = new Counter({
  name: "fae_vitrin_errors_total",
  help: "Vitrin motoru hata sayısı",
});

// AI istek sayısı
export const aiRequests = new Counter({
  name: "fae_ai_requests_total",
  help: "AI pipeline istek adedi",
});

// Cache hit/miss
export const cacheHit = new Counter({
  name: "fae_cache_hit_total",
  help: "Cache HIT",
});
export const cacheMiss = new Counter({
  name: "fae_cache_miss_total",
  help: "Cache MISS",
});

// ------------------------------------------------------------
// Metrics endpoint
// ------------------------------------------------------------
export async function getMetrics(req, res) {
  try {
    res.setHeader("Content-Type", register.contentType);
    res.setHeader("Cache-Control", "no-cache");

    const metrics = await register.metrics();
    res.end(metrics);
  } catch (err) {
    console.error("Metrics error:", err);
    res.statusCode = 500;
    res.end("metrics_error");
  }
}
