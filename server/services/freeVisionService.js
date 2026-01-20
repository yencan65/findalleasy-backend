// server/services/freeVisionService.js (ESM)
// =====================================================================
// FREE VISION SERVICE
// - Goal: "no paid credits" image -> query hints.
// - Tier 1: Tesseract OCR (CPU heavy; guarded with timeout)
// - Tier 2: Google Cloud Vision (if GOOGLE_VISION_API_KEY exists)
//
// NOTE (acı ama gerçek): OpenCV bindings (opencv4nodejs) Render gibi ortamlarda
// derleme/calisma kabusu. Bu yüzden burada BILEREK yok.
// Barkod icin frontend BarcodeDetector + ZXing zaten daha saglam.
// =====================================================================

import fetch from "node-fetch";
import crypto from "crypto";

const DEFAULT_LANG = "tur+eng";
const DEFAULT_TIMEOUT_MS = 9_000;

function safeStr(v, max = 2000) {
  try {
    if (v == null) return "";
    let s = String(v);
    s = s.replace(/\s+/g, " ").trim();
    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch {
    return "";
  }
}

function cleanOcrText(text) {
  if (!text) return "";
  return safeStr(text, 5000)
    .replace(/\r\n/g, "\n")
    .replace(/[^0-9A-Za-z\s.,!?:;\-_/()%+&@#'\"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKeywords(text) {
  const t = safeStr(text, 4000).toLowerCase();
  if (!t) return [];

  const stop = new Set([
    "ve",
    "ile",
    "icin",
    "için",
    "bir",
    "bu",
    "su",
    "şu",
    "o",
    "en",
    "cok",
    "çok",
    "fiyat",
    "urun",
    "ürün",
    "hizmet",
    "satın",
    "satin",
    "al",
    "bul",
    "nerede",
    "nedir",
    "kg",
    "gr",
    "ml",
    "lt",
  ]);

  const words = t
    .split(/\s+/)
    .map((w) => w.replace(/[^0-9a-zA-Z]/g, ""))
    .filter((w) => w && w.length > 2)
    .filter((w) => !stop.has(w))
    .filter((w) => !/^\d+$/.test(w));

  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map((x) => x[0]);
}

function md5(buf) {
  try {
    return crypto.createHash("md5").update(buf).digest("hex");
  } catch {
    return "";
  }
}

export default class FreeVisionService {
  constructor(opts = {}) {
    this.lang = String(opts.lang || process.env.TESSERACT_LANG || DEFAULT_LANG);
    this.timeoutMs = Number(opts.timeoutMs || process.env.VISION_FREE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.cacheTtlMs = Number(opts.cacheTtlMs || process.env.VISION_FREE_CACHE_TTL_MS || 60 * 60_000);
    this.cacheMax = Number(opts.cacheMax || process.env.VISION_FREE_CACHE_MAX || 400);
    this._cache = new Map(); // key -> { ts, val }
  }

  _cacheGet(key) {
    const it = this._cache.get(key);
    if (!it) return null;
    if (Date.now() - it.ts > this.cacheTtlMs) {
      this._cache.delete(key);
      return null;
    }
    return it.val || null;
  }

  _cacheSet(key, val) {
    try {
      this._cache.set(key, { ts: Date.now(), val });
      // small GC
      if (this._cache.size > this.cacheMax) {
        const keys = Array.from(this._cache.keys());
        for (let i = 0; i < Math.min(80, keys.length); i++) this._cache.delete(keys[i]);
      }
    } catch {}
  }

  async tesseractOcr(imageBuffer) {
    const lang = this.lang || DEFAULT_LANG;
    try {
      const mod = await import("tesseract.js");
      const createWorker = mod?.createWorker || mod?.default?.createWorker;
      if (!createWorker) throw new Error("TESSERACT_IMPORT_FAILED");

      // Lang data: allow overriding (cdn/local)
      const langPath = process.env.TESSERACT_LANG_PATH || undefined;
      const worker = await createWorker({
        logger: () => {},
        ...(langPath ? { langPath } : {}),
      });

      await worker.loadLanguage(lang);
      await worker.initialize(lang);

      const res = await worker.recognize(imageBuffer);
      await worker.terminate();

      const raw = safeStr(res?.data?.text || "", 8000);
      const text = cleanOcrText(raw);
      const conf = Number(res?.data?.confidence ?? 0) / 100;
      return {
        success: true,
        service: "tesseract",
        text,
        keywords: extractKeywords(text),
        confidence: Number.isFinite(conf) ? conf : 0,
        raw: null,
      };
    } catch (err) {
      return {
        success: false,
        service: "tesseract",
        error: safeStr(err?.message || err, 200),
      };
    }
  }

  async googleVision(imageBuffer, apiKey) {
    try {
      const b64 = Buffer.from(imageBuffer).toString("base64");
      const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
      const payload = {
        requests: [
          {
            image: { content: b64 },
            features: [
              { type: "TEXT_DETECTION", maxResults: 3 },
              { type: "WEB_DETECTION", maxResults: 6 },
              { type: "LOGO_DETECTION", maxResults: 3 },
              { type: "LABEL_DETECTION", maxResults: 6 },
            ],
          },
        ],
      };

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const to = controller ? setTimeout(() => controller.abort(), 9_000) : null;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
      if (to) clearTimeout(to);
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`CLOUD_VISION_HTTP_${r.status}`);

      const ann = j?.responses?.[0] || {};

      // OCR (sometimes empty even when the image has logos)
      const ocrRaw = safeStr(ann?.textAnnotations?.[0]?.description || "", 8000);
      const ocrFirstLine = safeStr(String(ocrRaw || "").split(/\r?\n/)[0] || "", 160);

      // Web "best guess" (very strong when present)
      const bestGuess = Array.isArray(ann?.webDetection?.bestGuessLabels)
        ? ann.webDetection.bestGuessLabels
        : [];
      const guess = safeStr(bestGuess?.[0]?.label || "", 160);
      const guessMore = bestGuess
        .slice(1, 3)
        .map((x) => safeStr(x?.label || "", 120))
        .filter(Boolean);

      // Logos (brand) + labels (object type)
      const logoNames = (Array.isArray(ann?.logoAnnotations) ? ann.logoAnnotations : [])
        .map((x) => safeStr(x?.description || "", 120))
        .filter(Boolean);
      const labelNames = (Array.isArray(ann?.labelAnnotations) ? ann.labelAnnotations : [])
        .map((x) => safeStr(x?.description || "", 120))
        .filter(Boolean);

      // Web entities can carry model/brand terms even if OCR fails
      const webNames = (Array.isArray(ann?.webDetection?.webEntities)
        ? ann.webDetection.webEntities
        : [])
        .map((e) => ({ d: safeStr(e?.description || "", 120), s: Number(e?.score || 0) }))
        .filter((x) => x.d)
        .sort((a, b) => (b.s || 0) - (a.s || 0))
        .filter((x) => (x.s || 0) >= 0.35)
        .slice(0, 4)
        .map((x) => x.d);

      const hasHelmetHint = (s) => /helmet|kask/i.test(String(s || ""));

      // Pick a primary query line
      let primary = guess || ocrFirstLine;
      if (!primary) {
        const logo = logoNames?.[0] || "";
        const labelHelmet = labelNames.find(hasHelmetHint) || labelNames?.[0] || "";
        primary = [logo, labelHelmet].filter(Boolean).join(" ").trim();
      }
      if (!primary) {
        primary = webNames?.[0] || guessMore?.[0] || labelNames?.[0] || "";
      }
      // If primary is only a brand and we have a "helmet" signal, enrich it
      if (primary && !hasHelmetHint(primary)) {
        const helmet = labelNames.find(hasHelmetHint);
        if (helmet && logoNames?.[0] && primary.toLowerCase() === logoNames[0].toLowerCase()) {
          primary = `${primary} ${helmet}`;
        }
      }

      // Dedupe lines (case-insensitive)
      const uniq = (arr) => {
        const seen = new Set();
        const out = [];
        for (const it of arr || []) {
          const k = String(it || "").trim();
          if (!k) continue;
          const lk = k.toLowerCase();
          if (seen.has(lk)) continue;
          seen.add(lk);
          out.push(k);
        }
        return out;
      };

      const lines = uniq([
        primary,
        ocrFirstLine,
        ...logoNames,
        ...webNames,
        ...guessMore,
        ...labelNames,
      ]);

      const text = cleanOcrText(lines.join("\n"));

      const confidence = 0.8; // Cloud Vision icin tek skor yok; "useful" sinyali.
      return {
        success: true,
        service: "google_vision",
        text,
        keywords: extractKeywords(text),
        confidence,
        raw: j,
      };
    } catch (err) {
      return {
        success: false,
        service: "google_vision",
        error: safeStr(err?.message || err, 200),
      };
    }
  }

  mergeResults(results) {
    const merged = {
      text: "",
      keywords: [],
      confidence: 0,
      services: [],
      raw: {},
    };

    for (const r of results || []) {
      if (!r) continue;
      merged.services.push(r.service);
      if (r.text && r.text.length > merged.text.length) merged.text = r.text;
      if (Array.isArray(r.keywords)) merged.keywords.push(...r.keywords);
      if (typeof r.confidence === "number") merged.confidence = Math.max(merged.confidence, r.confidence);
      if (r.raw) merged.raw[r.service] = r.raw;
    }

    merged.keywords = Array.from(new Set(merged.keywords)).slice(0, 10);
    return merged;
  }

  async processImage(imageBuffer, options = {}) {
    const buf = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer);
    const key = md5(buf);
    const cached = key ? this._cacheGet(key) : null;
    if (cached) return { ...cached, cache: "hit" };

    // Accept both env names (historical compatibility) and allow explicit override.
    const visionKey = String(
      options.visionKey || process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY || ""
    ).trim();

    const useGoogleVision = options.useGoogleVision !== false && !!visionKey;
    const started = Date.now();

    // Run OCR and Cloud Vision in parallel (bounded by per-service timeouts).
    const tesseractP = Promise.race([
      this.tesseractOcr(buf),
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ success: false, service: "tesseract", error: "TIMEOUT" }),
          this.timeoutMs
        )
      ),
    ]);

    const googleP = useGoogleVision
      ? this.googleVision(buf, visionKey)
      : Promise.resolve(null);

    const [tesseract, g] = await Promise.all([tesseractP, googleP]);

    const results = [];
    if (tesseract?.success) results.push(tesseract);
    if (g?.success) results.push(g);

    const attempts = [];
    if (tesseract) {
      attempts.push({
        service: tesseract.service || 'tesseract',
        success: !!tesseract.success,
        error: tesseract.success ? undefined : (tesseract.error || 'FAILED'),
      });
    }
    if (useGoogleVision) {
      attempts.push({
        service: 'google_vision',
        success: !!(g && g.success),
        error: g && g.success ? undefined : (g?.error || 'FAILED'),
      });
    }

    const merged = this.mergeResults(results);
    const out = {
      ...merged,
      attempts,
      meta: {
        latencyMs: Date.now() - started,
      },
    };

    if (key) this._cacheSet(key, out);
    return out;
  }

}

