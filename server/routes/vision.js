// server/routes/vision.js
// ======================================================================
//   VISION ROUTER — S31 VISION-NEXUS FORTRESS (RAW-BODY SAFE)
//   - server.js /api/vision altında bodyParser.raw("*/*") kullandığı için
//     req.body çoğu zaman Buffer / Uint8Array gelir.
//   - safeBody(): Buffer/String/UTF-16LE/BOM/null-byte toleranslı JSON parse.
//   - GOOGLE_API_KEY varsa Gemini -> yoksa / fail olursa SERPAPI google_lens.
//   - SerpApi google_lens public URL ister: /api/vision/i/:id temp image.
//   - ZERO-BREAK: /api/vision response şeması korunur.
// ======================================================================

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const router = express.Router();

/* ============================================================
   S31 — SERPAPI LENS FALLBACK + TEMP IMAGE URL
   ============================================================ */

const IMG_TTL_MS = Number(process.env.VISION_IMG_TTL_MS || 5 * 60_000);
const IMG_MAX_ITEMS = Number(process.env.VISION_IMG_MAX_ITEMS || 64);
const IMG_MAX_BYTES_TOTAL = Number(
  process.env.VISION_IMG_MAX_BYTES_TOTAL || 40 * 1024 * 1024
);

const imgStore = new Map(); // id -> { buf: Buffer, mime: string, ts: number, bytes: number }

function gcImgStore() {
  try {
    const now = Date.now();

    for (const [id, it] of imgStore.entries()) {
      if (!it || !it.ts || now - it.ts > IMG_TTL_MS) imgStore.delete(id);
    }

    let total = 0;
    const arr = [];
    for (const [id, it] of imgStore.entries()) {
      const bytes = Number(it?.bytes || 0);
      total += bytes;
      arr.push([id, it?.ts || 0, bytes]);
    }

    arr.sort((a, b) => a[1] - b[1]);

    while (imgStore.size > IMG_MAX_ITEMS || total > IMG_MAX_BYTES_TOTAL) {
      const oldest = arr.shift();
      if (!oldest) break;
      const [id, _ts, bytes] = oldest;
      if (imgStore.has(id)) {
        imgStore.delete(id);
        total -= Number(bytes || 0);
      }
    }
  } catch {
    // ignore
  }
}

function putTempImage(buf, mime) {
  gcImgStore();
  const id = crypto.randomBytes(16).toString("hex");
  imgStore.set(id, { buf, mime, ts: Date.now(), bytes: buf?.length || 0 });
  gcImgStore();
  return id;
}

function getTempImage(id) {
  gcImgStore();
  const it = imgStore.get(id);
  if (!it) return null;
  if (Date.now() - it.ts > IMG_TTL_MS) {
    imgStore.delete(id);
    return null;
  }
  return it;
}

function safeStr(v, max = 500) {
  try {
    if (v == null) return "";
    let s = String(v)
      .trim()
      .normalize("NFKC")
      .replace(/[<>$;{}\[\]()]/g, "");
    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch {
    return "";
  }
}

function buildPublicOrigin(req) {
  // SerpApi Lens temp image URL'i dışarıdan çekiyor.
  // Eğer host yanlış/kapalı bir origin'e giderse Lens resmi indiremez ve 'NO_MATCH' olur.
  // Bu yüzden ENV override destekliyoruz.
  const envOriginRaw = safeStr(process.env.VISION_PUBLIC_ORIGIN || process.env.PUBLIC_ORIGIN || "");
  if (envOriginRaw) {
    const cleaned = String(envOriginRaw).trim().replace(/\/$/, "");
    // 'api.findalleasy.com' gibi şemasız gelirse https varsay.
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
    return `https://${cleaned}`;
  }

  // Default: HTTPS. Sadece x-forwarded-proto açıkça http ise http kullan.
  const xfProto = safeStr(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  let proto = "https";
  if (xfProto === "http" || xfProto === "https") proto = xfProto;

  const xfHost = safeStr(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = xfHost || safeStr(req.headers.host || "");
  const safeHost = host.replace(/[^a-zA-Z0-9\-\.:]/g, "");
  return `${proto}://${safeHost}`;
}

function pickHlGlFromLocale(locale) {
  const l = safeStr(locale || "tr").toLowerCase();
  const hl =
    l.startsWith("tr")
      ? "tr"
      : l.startsWith("ru")
      ? "ru"
      : l.startsWith("ar")
      ? "ar"
      : l.startsWith("fr")
      ? "fr"
      : "en";
  const gl = l.startsWith("tr") ? "tr" : "us";
  return { hl, gl };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const AbortCtor = globalThis.AbortController || null;
  if (!AbortCtor) return fetch(url, options);

  const controller = new AbortCtor();
  const t = setTimeout(() => controller.abort(), Number(timeoutMs || 10_000));
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function pickSerpLensText(out) {
  try {
    const kg = out?.knowledge_graph;
    const vm = Array.isArray(out?.visual_matches) ? out.visual_matches : [];
    const shop = Array.isArray(out?.shopping_results) ? out.shopping_results : [];
    const org = Array.isArray(out?.organic_results) ? out.organic_results : [];

    const candidates = [];
    const push = (val, base) => {
      const s = safeStr(val || "");
      if (!s) return;
      candidates.push({ s, base });
    };

    // Adayları topla (ilkler daha değerli)
    push(kg?.title || kg?.name, 12);
    for (let i = 0; i < Math.min(vm.length, 3); i++) {
      push(vm[i]?.title || vm[i]?.snippet, 10 - i);
    }
    for (let i = 0; i < Math.min(shop.length, 3); i++) {
      push(shop[i]?.title || shop[i]?.product_title || shop[i]?.product, 11 - i);
    }
    for (let i = 0; i < Math.min(org.length, 2); i++) {
      push(org[i]?.title || org[i]?.snippet, 8 - i);
    }

    if (candidates.length === 0) return "";

    const veryGeneric = new Set([
      "ürün",
      "product",
      "item",
      "object",
      "thing",
      "unknown",
    ]);
    const scoreText = (s, base) => {
      const t = String(s || "").trim();
      if (!t) return -1e9;
      const lower = t.toLowerCase();
      const words = t.split(/\s+/).filter(Boolean);

      let sc = Number(base || 0);
      sc += Math.min(words.length, 6) * 2; // daha çok kelime → daha spesifik
      sc += Math.min(t.length, 50) / 10;
      if (words.length <= 1) sc -= 1.5; // tek kelime bazen olur, ama çoğu zaman fazla genel
      if (veryGeneric.has(lower)) sc -= 12;
      return sc;
    };

    let best = { s: "", sc: -1e9 };
    for (const c of candidates) {
      const sc = scoreText(c.s, c.base);
      if (sc > best.sc) best = { s: c.s, sc };
    }
    return best.s || "";
  } catch {
    return "";
  }
}

// Temp image endpoint
router.get("/i/:id", (req, res) => {
  try {
    const id = safeStr(req.params.id || "");
    const it = getTempImage(id);
    res.set("Cache-Control", "no-store");
    if (!it) return res.status(404).end("not_found");
    res.set("Content-Type", it.mime || "image/jpeg");
    return res.status(200).send(it.buf);
  } catch {
    res.set("Cache-Control", "no-store");
    return res.status(500).end("error");
  }
});

/* ============================================================
   SAFE HELPERS (JSON, BODY, BASE64, IP, UA)
   ============================================================ */

function safeJson(res, obj, status = 200) {
  try {
    if (status === 200) return res.json(obj);
    return res.status(status).json(obj);
  } catch (err) {
    console.error("❌ [vision] safeJson ERROR:", err);
    try {
      return res
        .status(500)
        .json({ ok: false, error: "JSON_SERIALIZATION_ERROR" });
    } catch {
      return;
    }
  }
}

function isPlainObject(v) {
  if (!v) return false;
  if (Array.isArray(v)) return false;
  if (typeof v !== "object") return false;
  if (Buffer.isBuffer?.(v)) return false;
  if (v instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function stripBomAndNulls(s) {
  if (!s) return "";
  let t = String(s);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // BOM
  if (t.includes("\u0000")) t = t.replace(/\u0000/g, "");
  return t;
}

function parseJsonMaybe(s) {
  const t = stripBomAndNulls(String(s || "")).trim();
  if (!t) return null;

  // Bazı client'lar gövdeyi "{...}" şeklinde (string içinde JSON) yollayabiliyor.
  // Önce outer JSON.parse dene, sonra içeriği tekrar parse et.
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      const outer = JSON.parse(t);
      if (isPlainObject(outer)) return outer;
      if (typeof outer === "string") {
        const inner = parseJsonMaybe(outer);
        if (inner) return inner;
      }
    } catch {
      // ignore
    }
  }

  const startsOk = t.startsWith("{") || t.startsWith("[");
  if (!startsOk) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ✅ Body guard (RAW Buffer JSON parse dahil)
function safeBody(req) {
  const b = req && req.body;

  if (isPlainObject(b)) return b;

  // Buffer / Uint8Array -> UTF-8 ve UTF-16LE dene
  try {
    if (Buffer.isBuffer?.(b) || b instanceof Uint8Array) {
      const buf = Buffer.isBuffer?.(b) ? b : Buffer.from(b);

      // 1) UTF-8 dene
      const j1 = parseJsonMaybe(buf.toString("utf8"));
      if (isPlainObject(j1)) return j1;

      // 2) UTF-16LE dene (PowerShell bazen böyle saçmalar)
      const j2 = parseJsonMaybe(buf.toString("utf16le"));
      if (isPlainObject(j2)) return j2;

      // 3) Null byte temizleyip UTF-8 tekrar dene
      const s3 = stripBomAndNulls(buf.toString("utf8"));
      const j3 = parseJsonMaybe(s3);
      if (isPlainObject(j3)) return j3;
    }
  } catch {
    // ignore
  }

  // String -> parse dene
  try {
    if (typeof b === "string") {
      const j = parseJsonMaybe(b);
      if (isPlainObject(j)) return j;
    }
  } catch {
    // ignore
  }

  return {};
}

function safeBase64(str) {
  if (!str) return "";
  const s = String(str);
  return s.replace(/[^0-9A-Za-z+/=]/g, "");
}

function clampBase64Size(b64, maxBytes = 6 * 1024 * 1024) {
  const len = b64.length;
  const approxBytes = Math.floor((len * 3) / 4);
  if (approxBytes > maxBytes) return null;
  return b64;
}

function getIP(req) {
  try {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    const xf = req.headers["x-forwarded-for"];
    if (xf) return xf.split(",")[0].trim();
    return req.socket?.remoteAddress || req.ip || "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

function getUA(req) {
  try {
    return String(req.headers["user-agent"] || "").slice(0, 200);
  } catch {
    return "";
  }
}

/* ============================================================
   RATE LIMIT
   ============================================================ */

const RL = new Map();
function rateLimit(ip, limit = 40, windowMs = 60_000) {
  const now = Date.now();
  const entry = RL.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  RL.set(ip, entry);

  if (Math.random() < 0.01) {
    for (const [key, e] of RL.entries()) {
      if (now > e.resetAt) RL.delete(key);
    }
  }

  return { allowed: entry.count <= limit, retryMs: entry.resetAt - now };
}

/* ============================================================
   QUERY EXTRACTOR
   ============================================================ */

function extractSearchQuery(text = "") {
  if (!text) return "";
  let t = String(text).toLowerCase();

  // dil bağımsız temizlik + "boş konuşma" kırpma
  t = t
    .replace(/bu fotoğrafta|görünüyor|görünmektedir|olabilir|resimde|fotoğrafta|nesne|obje/g, "")
    .replace(/looks like|maybe|probably|appears to be|this is|it is|there is/g, "")
    .replace(/product|item|thing|object|unknown/g, "")
    .replace(/sanırım|muhtemelen|gibi|bir\s+/g, "")
    .replace(/çok\s+/g, "")
    .trim();

  // harf/rakam boşluğu dışında her şeyi at
  t = t.replace(/[^a-zA-Z0-9ğüşöçİıĞÜŞÖÇ\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "";

  const STOP = new Set([
    "ve","ile","icin","için","en","cok","çok","uygun","ucuz","fiyat","kampanya","indirim",
    "orijinal","resmi","satıcı","satici","satın","satin","al","alma","almak","bul","bulun",
    "lütfen","lutfen","fotoğraf","fotograf","resim","urun","ürün","hizmet","service"
  ]);

  const words = t.split(" ").filter(Boolean).filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return "";

  // çok kısaltma yapma: model/seri bilgisi genelde 5+ kelimede çıkıyor
  const sliced = words.slice(0, 8);
  return sliced.join(" ").trim();
}

function detectMimeType(rawImage) {
  if (!rawImage) return "image/jpeg";
  const s = String(rawImage);
  if (s.startsWith("data:image/png")) return "image/png";
  if (s.startsWith("data:image/webp")) return "image/webp";
  if (s.startsWith("data:image/jpg")) return "image/jpeg";
  if (s.startsWith("data:image/jpeg")) return "image/jpeg";
  return "image/jpeg";
}

const VISION_GENERIC = new Set([
  "urun",
  "ürün",
  "product",
  "item",
  "object",
  "thing",
  "unknown",
  "bilinmiyor",
  "nesne",
  "obje",
]);

function isGenericVisionQuery(q) {
  try {
    const s = String(q || "").trim();
    if (!s) return true;
    const lower = s.toLowerCase();
    if (VISION_GENERIC.has(lower)) return true;
    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length === 1 && VISION_GENERIC.has(words[0])) return true;
    // tek kelime ve çok kısa ise riskli
    if (words.length === 1 && words[0].length <= 3) return true;
    return false;
  } catch {
    return true;
  }
}

function buildVisionQuery(primaryText, lensOut) {
  // 1) önce primaryText
  let q = extractSearchQuery(primaryText || "");

  // 2) Lens shopping başlıkları genelde en spesifik — oradan destekle
  try {
    const shop = Array.isArray(lensOut?.shopping_results) ? lensOut.shopping_results : [];
    const vm = Array.isArray(lensOut?.visual_matches) ? lensOut.visual_matches : [];
    const kg = lensOut?.knowledge_graph || null;

    const pick = (s) => extractSearchQuery(String(s || ""));
    const candidates = [];

    if (kg?.title || kg?.name) candidates.push(pick(kg?.title || kg?.name));
    if (shop[0]?.title || shop[0]?.product_title) candidates.push(pick(shop[0]?.title || shop[0]?.product_title));
    if (vm[0]?.title) candidates.push(pick(vm[0]?.title));
    if (shop[1]?.title || shop[1]?.product_title) candidates.push(pick(shop[1]?.title || shop[1]?.product_title));

    // en uzun / en spesifik olanı seç
    for (const c of candidates) {
      if (!c) continue;
      if (!q || c.split(/\s+/).length > q.split(/\s+/).length) q = c;
    }
  } catch {
    // ignore
  }

  return String(q || "").trim();
}

// ------------------------------------------------------------
// Barcode extraction from OCR text (EAN/UPC)
// ------------------------------------------------------------
function eanChecksumOK(code) {
  try {
    const s = String(code || '').replace(/\D/g, '');
    if (s.length === 13) {
      let sum = 0;
      for (let i = 0; i < 12; i++) {
        const d = Number(s[i]);
        sum += (i % 2 === 0) ? d : d * 3;
      }
      const check = (10 - (sum % 10)) % 10;
      return check === Number(s[12]);
    }
    if (s.length === 8) {
      let sum = 0;
      for (let i = 0; i < 7; i++) {
        const d = Number(s[i]);
        sum += (i % 2 === 0) ? d * 3 : d;
      }
      const check = (10 - (sum % 10)) % 10;
      return check === Number(s[7]);
    }
    return true; // diğer uzunluklar: checksum zorunlu değil
  } catch {
    return false;
  }
}

function extractBarcodesFromText(text) {
  try {
    const t = String(text || '');
    const found = new Set();
    // Word boundary ile EAN/UPC yakala (\b). Önceki sürümde yanlışlıkla backspace (\u0008) karakteri vardı.
    const re = /\b(\d{8,18})\b/g;
    let m;
    while ((m = re.exec(t)) && found.size < 10) {
      const code = String(m[1] || '');
      if (!/^(?:0+)$/g.test(code) && eanChecksumOK(code)) found.add(code);
    }
    // Öncelik: 13 -> 12 -> 8 -> diğerleri
    const arr = Array.from(found);
    arr.sort((a, b) => {
      const wa = a.length === 13 ? 0 : a.length === 12 ? 1 : a.length === 8 ? 2 : 3;
      const wb = b.length === 13 ? 0 : b.length === 12 ? 1 : b.length === 8 ? 2 : 3;
      if (wa != wb) return wa - wb;
      return b.length - a.length;
    });
    return arr;
  } catch {
    return [];
  }
}




// ------------------------------------------------------------
// Free OCR fallback (Tesseract.js) — ZERO-DELETE, only used when needed
// ------------------------------------------------------------
async function freeOcrTesseract(imageBuffer, opts = {}) {
  const lang = String(opts.lang || process.env.TESSERACT_LANG || "eng").trim() || "eng";
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 9000;

  // Very large images can choke OCR; skip gracefully.
  try {
    if (imageBuffer && imageBuffer.length > 6 * 1024 * 1024) {
      return { ok: false, error: "IMAGE_TOO_LARGE_FOR_OCR" };
    }
  } catch {}

  let worker = null;
  const started = Date.now();
  try {
    const mod = await import("tesseract.js");
    const createWorker = mod?.createWorker || mod?.default?.createWorker;
    if (!createWorker) return { ok: false, error: "TESSERACT_IMPORT_FAILED" };

    // Run OCR with a hard timeout.
    const run = async () => {
      worker = await createWorker();
      await worker.loadLanguage(lang);
      await worker.initialize(lang);
      // Conservative params: stable on labels/packaging
      try {
        await worker.setParameters({
          preserve_interword_spaces: "1",
        });
      } catch {}

      const out = await worker.recognize(imageBuffer);
      return out?.data || {};
    };

    const data = await Promise.race([
      run(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("OCR_TIMEOUT")), timeoutMs)),
    ]);

    const rawText = String(data?.text || "").trim();
    if (!rawText || rawText.length < 3) {
      return { ok: false, error: "OCR_EMPTY", latencyMs: Date.now() - started };
    }

    const barcodes = extractBarcodesFromText(rawText);
    const query = barcodes?.length ? String(barcodes[0] || "") : extractSearchQuery(rawText);

    return {
      ok: true,
      query: String(query || "").trim(),
      barcodes: Array.isArray(barcodes) ? barcodes : [],
      rawText,
      confidence: Number.isFinite(data?.confidence) ? (Number(data.confidence) / 100) : null,
      latencyMs: Date.now() - started,
      used: `tesseract:${lang}`,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), latencyMs: Date.now() - started };
  } finally {
    try {
      if (worker) await worker.terminate();
    } catch {}
  }
}

/* ============================================================
   VISION HANDLER
   ============================================================ */

async function handleVision(req, res) {
  const startedAt = Date.now();
  const ip = getIP(req);
  const ua = getUA(req);
  const debug =
    String(process.env.VISION_DEBUG || "") === "1" ||
    String(req.query?.diag || "") === "1";

  // diag=1 ise hangi katman denendi / nerede patladı net görünsün diye.
  const tries = [];
  const tpush = (step, extra) => {
    if (!debug) return;
    try {
      tries.push({ step, ...(extra || {}) });
    } catch {
      // ignore
    }
  };

  try {
    const rl = rateLimit(ip, 40, 60_000);
    if (!rl.allowed) {
      return safeJson(
        res,
        { ok: false, throttled: true, retryAfterMs: rl.retryMs },
        429
      );
    }

    const body = safeBody(req);

    tpush("body_parsed", {
      contentType: safeStr(req.headers["content-type"] || "", 200),
      bodyType: Buffer.isBuffer?.(req.body)
        ? "Buffer"
        : req.body instanceof Uint8Array
        ? "Uint8Array"
        : typeof req.body,
      parsedKeys: isPlainObject(body) ? Object.keys(body).slice(0, 25) : null,
    });

    // Tolerans: bazı client alan adını farklı yollayabilir
    const rawImage = body.imageBase64 || body.image || body.base64 || "";

    if (!rawImage) {
      const diag = debug
        ? {
            contentType: safeStr(req.headers["content-type"] || "", 200),
            bodyType: Buffer.isBuffer?.(req.body)
              ? "Buffer"
              : req.body instanceof Uint8Array
              ? "Uint8Array"
              : typeof req.body,
            bodyLen: Buffer.isBuffer?.(req.body)
              ? req.body.length
              : req.body instanceof Uint8Array
              ? req.body.byteLength
              : typeof req.body === "string"
              ? req.body.length
              : null,
            parsedKeys: isPlainObject(body)
              ? Object.keys(body).slice(0, 20)
              : null,
          }
        : undefined;

      return safeJson(
        res,
        { ok: false, error: "imageBase64 eksik", ...(diag ? { diag } : {}) },
        400
      );
    }

    // ✅ TEST MODE (kredi yakmayan)
    const mockQuery = String(process.env.VISION_MOCK_QUERY || "").trim();
    if (mockQuery) {
      const latencyMs = Date.now() - startedAt;
      return safeJson(res, {
        ok: true,
        query: safeStr(mockQuery, 120),
        rawText: "VISION_MOCK_QUERY",
        raw: null,
        meta: {
          ipHash: ip ? String(ip).slice(0, 8) : null,
          uaSnippet: ua,
          latencyMs,
          mock: true,
        },
      });
    }

    // Cloud Vision key (Render): GOOGLE_VISION_API_KEY
    // Back-compat: GOOGLE_API_KEY de kullanılabilir (Vision API açık olmalı)
    const visionKey = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY;

    // Gemini ayrı tutulur; default OFF (kredi/usage yakmasın)
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    // Align env lookup with serp adapter (people configure different names on Render)
    const serpKey =
      process.env.SERPAPI_KEY ||
      process.env.SERPAPI_API_KEY ||
      process.env.SERPAPI_APIKEY ||
      process.env.SERP_API_KEY ||
      process.env.SERPAPIKEY ||
      "";

    const allowGemini = (() => {
      // Default: OFF. Opt-in via env or request.
      try {
        const v = String(process.env.VISION_ALLOW_GEMINI || "").trim().toLowerCase();
        if (v === "1" || v === "true" || v === "yes") return true;
      } catch {}

      try {
        const h = String(req?.headers?.["x-fae-allow-gemini"] || "").trim().toLowerCase();
        if (h === "1" || h === "true" || h === "yes") return true;
      } catch {}

      try {
        const qv = String(req?.query?.allowGemini || req?.query?.allow_gemini || "")
          .trim()
          .toLowerCase();
        if (qv === "1" || qv === "true" || qv === "yes") return true;
      } catch {}

      try {
        if (body?.allowGemini === true || body?.allow_gemini === true) return true;
        const b = String(body?.allowGemini || body?.allow_gemini || "").trim().toLowerCase();
        if (b === "1" || b === "true" || b === "yes") return true;
      } catch {}

      return false;
    })();

    const allowSerpLens = (() => {
      // Default: OFF (burns credits). Opt-in via env or request.
      try {
        const v = String(process.env.VISION_ALLOW_SERP_LENS || "").trim().toLowerCase();
        if (v === "1" || v === "true" || v === "yes") return true;
      } catch {}

      try {
        const h = String(req?.headers?.["x-fae-allow-serp-lens"] || "").trim().toLowerCase();
        if (h === "1" || h === "true" || h === "yes") return true;
      } catch {}

      try {
        const qv = String(req?.query?.allowSerpLens || req?.query?.allow_serp_lens || "")
          .trim()
          .toLowerCase();
        if (qv === "1" || qv === "true" || qv === "yes") return true;
      } catch {}

      try {
        if (body?.allowSerpLens === true || body?.allow_serp_lens === true) return true;
        const b = String(body?.allowSerpLens || body?.allow_serp_lens || "").trim().toLowerCase();
        if (b === "1" || b === "true" || b === "yes") return true;
      } catch {}

      return false;
    })();

    tpush("providers", {
      hasVisionKey: Boolean(visionKey),
      allowGemini,
      hasGeminiKey: Boolean(geminiKey),
      allowSerpLens,
      hasSerpKey: Boolean(serpKey),
      publicOrigin: buildPublicOrigin(req),
    });


    
    if (!visionKey && !(geminiKey && allowGemini) && !(serpKey && allowSerpLens)) {
      // ✅ Free OCR fallback (server-side) — only when paid/official providers are unavailable.
      // This prevents the UX from collapsing into "VISION_DISABLED".
      try {
        const base64Part0 = String(rawImage).includes(",")
          ? String(rawImage).split(",")[1]
          : String(rawImage);
        let clean0 = safeBase64(base64Part0);
        if (clean0 && clean0.length >= 50) {
          clean0 = clampBase64Size(clean0, 10 * 1024 * 1024);
          const buf0 = Buffer.from(clean0, "base64");

          const freeOk = String(process.env.USE_FREE_VISION || "true").toLowerCase() !== "false";
          if (freeOk) {
            tpush("free_ocr_fallback_try", { bytes: buf0?.length || null });
            const ocr = await freeOcrTesseract(buf0, { timeoutMs: 9000 });
            if (ocr?.ok && (ocr.query || (Array.isArray(ocr.barcodes) && ocr.barcodes.length))) {
              const q = String(ocr.query || "").trim();
              const b = Array.isArray(ocr.barcodes) && ocr.barcodes.length ? String(ocr.barcodes[0]) : "";
              return safeJson(
                res,
                {
                  ok: true,
                  query: q || b || "",
                  barcode: b || "",
                  barcodes: Array.isArray(ocr.barcodes) ? ocr.barcodes : [],
                  rawText: safeStr(ocr.rawText || "", 2000),
                  ...(debug ? { _diag: { tries: [...tries, { step: "free_ocr_fallback_ok", used: ocr.used || null }] } } : {}),
                  meta: {
                    source: "free_ocr_fallback",
                    used: ocr.used || null,
                    latencyMs: Date.now() - startedAt,
                  },
                },
                200
              );
            }
          }
        }
      } catch (e0) {
        tpush("free_ocr_fallback_error", { error: String(e0?.message || e0) });
      }

      return safeJson(
        res,
        {
          ok: false,
          error: "VISION_DISABLED",
          detail: "GOOGLE_VISION_API_KEY (or GOOGLE_API_KEY) missing",
        },
        200
      );
    }

    const mimeType = detectMimeType(rawImage);
    const base64Part = String(rawImage).includes(",")
      ? String(rawImage).split(",")[1]
      : String(rawImage);
    let cleanBase64 = safeBase64(base64Part);

    if (!cleanBase64 || cleanBase64.length < 50) {
      return safeJson(res, { ok: false, error: "BASE64_INVALID" }, 400);
    }

    cleanBase64 = clampBase64Size(cleanBase64, 15 * 1024 * 1024);
    if (!cleanBase64) {
      return safeJson(res, { ok: false, error: "IMAGE_TOO_LARGE" }, 413);
    }

    tpush("image", {
      mimeType,
      base64Len: cleanBase64.length,
      approxBytes: Math.floor((cleanBase64.length * 3) / 4),
    });

    const { hl, gl } = pickHlGlFromLocale(body.locale || body.localeHint || "tr");

    let rawText = "";
	    let cvOut = null;
    let gemOut = null;
    let lensOut = null;
    let used = null;

	    // 0) Cloud Vision (LABEL/TEXT) — önce dene.
	    // Not: Cloud Vision API fiyatlandırması tier'lı; ilk 1000 unit/ay ücretsiz kota olabilir.
	    // Bu katman: "Cloud API key" ile çalışır. Gemini anahtarı yanlışsa bile kurtarır.
	    if (visionKey) {
	      try {
	        tpush("cloud_vision_start", { enabled: true });
	        const cvUrl =
	          "https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(visionKey);
	
	        const cvPayload = {
	          requests: [
	            {
	              image: { content: cleanBase64 },
	              features: [
                { type: "TEXT_DETECTION", maxResults: 3 },
                { type: "WEB_DETECTION", maxResults: 6 },
                { type: "LOGO_DETECTION", maxResults: 3 },
                { type: "LABEL_DETECTION", maxResults: 6 },
              ],
	            },
	          ],
	        };
	
	        tpush("cloud_vision_request", { endpoint: "images:annotate", timeoutMs: 8000 });
	        const rr = await fetchWithTimeout(
	          cvUrl,
	          {
	            method: "POST",
	            headers: { "Content-Type": "application/json" },
	            body: JSON.stringify(cvPayload),
	          },
	          8_000
	        );

	        tpush("cloud_vision_http", { status: rr?.status });
	
	        cvOut = await rr.json().catch(() => null);
	        if (!rr.ok) throw new Error("CLOUD_VISION_HTTP_ERROR " + rr.status);

	        const ann = cvOut?.responses?.[0] || {};
	        tpush("cloud_vision_parsed", {
	          hasText: Boolean(ann?.textAnnotations?.[0]?.description),
	          labelCount: Array.isArray(ann?.labelAnnotations) ? ann.labelAnnotations.length : 0,
	          webEntityCount: Array.isArray(ann?.webDetection?.webEntities) ? ann.webDetection.webEntities.length : 0,
	          bestGuessCount: Array.isArray(ann?.webDetection?.bestGuessLabels) ? ann.webDetection.bestGuessLabels.length : 0,
	          logoCount: Array.isArray(ann?.logoAnnotations) ? ann.logoAnnotations.length : 0,
	        });
	
	        // 1) OCR text (tam metin)
	        let q = "";
	        const ocr = String(ann?.textAnnotations?.[0]?.description || "").trim();
	        if (ocr) {
	          // barcode yakalama için tam OCR'ı koru
	          rawText = ocr;
	          used = used ? used + "+cloud_vision" : "cloud_vision";
	          // query builder için kısa bir satır da seç
	          const firstLine = ocr
	            .split(/\r?\n/)
	            .map((s) => String(s || "").trim())
	            .filter(Boolean)[0];
	          if (firstLine && firstLine.length >= 3 && firstLine.length <= 80) q = firstLine;
	        }


	        // 2) Web detection + logo detection (ürün/marka/model için en iyi sinyal)
	        try {
	          const web = ann?.webDetection || {};
	          const bestGuess = Array.isArray(web?.bestGuessLabels) ? web.bestGuessLabels : [];
	          const webEntities = Array.isArray(web?.webEntities) ? web.webEntities : [];
	          const logos = Array.isArray(ann?.logoAnnotations) ? ann.logoAnnotations : [];

	          const parts = [];
	          if (bestGuess?.[0]?.label) parts.push(String(bestGuess[0].label || "").trim());
	          for (const w of webEntities) {
	            if (parts.length >= 3) break;
	            if ((w?.score ?? 0) < 0.45) continue;
	            const d = String(w?.description || "").trim();
	            if (d) parts.push(d);
	          }
	          for (const lg of logos) {
	            if (parts.length >= 4) break;
	            if ((lg?.score ?? 0) < 0.4) continue;
	            const d = String(lg?.description || "").trim();
	            if (d) parts.push(d);
	          }

	          const webHint = parts.filter(Boolean).join(" ").trim();
	          if (webHint) {
	            // rawText'ı zenginleştir; buildVisionQuery daha iyi arama sorgusu çıkarır
	            rawText = rawText ? `${webHint}
${rawText}` : webHint;
	            if (!q) q = webHint;
	          }
	        } catch {}

	        // 2) Label fallback (ilk 2-3 etiket)
	        if (!q) {
	          const labels = Array.isArray(ann?.labelAnnotations) ? ann.labelAnnotations : [];
	          const parts = labels
	            .filter((l) => (l?.score ?? 0) >= 0.45)
	            .map((l) => String(l?.description || "").trim())
	            .filter(Boolean)
	            .slice(0, 3);
	          if (parts.length) q = parts.join(" ");
	        }

	        if (q && (!rawText || !String(rawText).trim())) {
	          rawText = q;
	          used = used ? used + "+cloud_vision" : "cloud_vision";
	        }
	      } catch (err) {
	        // Cloud Vision başarısızsa sessizce sonraki katmana geç
	        tpush("cloud_vision_error", { message: safeStr(err?.message || err, 250) });
	        cvOut = null;
	      }
	    }

    // 1) Gemini
	    if (allowGemini && geminiKey && (!rawText || !String(rawText).trim())) {
      used = "gemini";
      try {
        const url =
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
          encodeURIComponent(geminiKey);

        const payload = {
          contents: [
            {
              parts: [
                {
                  text:
                    "Fotoğrafta hangi ürün veya nesne var? " +
                    "Sadece nesnenin/ürünün adını kısa ve net şekilde söyle. " +
                    "Gereksiz cümle kurma, sadece 'Marka Model Tür' formatında yaz. " +
                    "Örn: 'iPhone 14 Pro', 'Nike koşu ayakkabısı', 'gaming laptop'.",
                },
                { inlineData: { mimeType, data: cleanBase64 } },
              ],
            },
          ],
        };

        const r = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
          10_000
        );

        gemOut = await r.json().catch(() => null);
        if (!r.ok) throw new Error("VISION_HTTP_ERROR " + r.status);

        rawText =
          gemOut?.candidates?.[0]?.content?.parts?.[0]?.text ||
          gemOut?.candidates?.[0]?.content?.parts?.[0]?.content ||
          "";
      } catch (err) {
        console.warn(
          "⚠️ [vision] Gemini fail, SerpApi Lens fallback denenecek:",
          err?.message || err
        );
        rawText = "";
        used = null;
      }
    }

    // 2) SerpApi google_lens fallback
    if ((!rawText || !String(rawText).trim()) && serpKey && allowSerpLens) {
      try {
        const buf = Buffer.from(cleanBase64, "base64");
        const id = putTempImage(buf, mimeType || "image/jpeg");
        const imageUrl = `${buildPublicOrigin(req)}/api/vision/i/${id}`;

        tpush("serp_lens_start", { imageUrl, hl, gl, timeoutMs: 12000 });

        const lensUrl = new URL("https://serpapi.com/search.json");
        lensUrl.searchParams.set("engine", "google_lens");
        lensUrl.searchParams.set("url", imageUrl);
        lensUrl.searchParams.set("api_key", serpKey);
        lensUrl.searchParams.set("hl", hl);
        lensUrl.searchParams.set("gl", gl);

        const rr = await fetchWithTimeout(
          lensUrl.toString(),
          { method: "GET" },
          12_000
        );

        tpush("serp_lens_http", { status: rr?.status });
        lensOut = await rr.json().catch(() => null);
        if (!rr.ok) throw new Error("SERPAPI_HTTP_ERROR " + rr.status);

        rawText = pickSerpLensText(lensOut);
        used = used ? used + "+serp_lens" : "serp_lens";
      } catch (err) {
        console.warn("❌ [vision] SerpApi Lens fail:", err?.message || err);
        tpush("serp_lens_error", { message: safeStr(err?.message || err, 250) });
      }
    }

	        const out = cvOut || gemOut || lensOut;
    const text = String(rawText || "").trim();

    // ✅ Daha doğru query: Lens shopping başlıklarını da kullan
    let query = buildVisionQuery(text, lensOut);
    // ✅ Barkod varsa öncelik barkod (QR/barcode fotoğraflarında en doğru sinyal)
    let barcodes = extractBarcodesFromText(text);
    let barcode = barcodes?.[0] || "";
    if (barcode) query = barcode;

    // Son çare: çok hafif fallback (ama "ürün" gibi saçma geneli ASLA dönme)
    if (!query && text) {
      const words = text
        .toLowerCase()
        .replace(/[^a-zA-Z0-9ğüşöçİıĞÜŞÖÇ\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      if (words.length > 0) query = words.slice(0, 6).join(" ");
    }

    

    // ✅ Son çare (OPT-IN): Cloud Vision/Gemini sonucu boş veya çok generic ise SerpApi Lens dene
    // Not: SerpApi Lens ücretli olabilir; default OFF. Sadece allowSerpLens ile açılır.
    if ((!query || isGenericVisionQuery(query)) && serpKey && allowSerpLens && !lensOut) {
      try {
        const buf = Buffer.from(cleanBase64, "base64");
        const id = putTempImage(buf, mimeType || "image/jpeg");
        const imageUrl = `${buildPublicOrigin(req)}/api/vision/i/${id}`;

        tpush("serp_lens_retry_start", { imageUrl, hl, gl, timeoutMs: 12000 });

        const lensUrl = new URL("https://serpapi.com/search.json");
        lensUrl.searchParams.set("engine", "google_lens");
        lensUrl.searchParams.set("url", imageUrl);
        lensUrl.searchParams.set("api_key", serpKey);
        lensUrl.searchParams.set("hl", hl);
        lensUrl.searchParams.set("gl", gl);

        const rr = await fetchWithTimeout(lensUrl.toString(), { method: "GET" }, 12_000);
        tpush("serp_lens_retry_http", { status: rr?.status });
        lensOut = await rr.json().catch(() => null);
        if (!rr.ok) throw new Error("SERPAPI_HTTP_ERROR " + rr.status);

        const lensText = pickSerpLensText(lensOut);
        if (lensText) {
          const prev = String(rawText || "").trim();
          rawText = prev ? prev + "\n" + lensText : lensText;
        }

        used = used ? used + "+serp_lens" : "serp_lens";

        // Query'yi lens sinyaliyle yeniden kur
        const text2 = String(rawText || "").trim();
        query = buildVisionQuery(text2, lensOut);

        const barcodes2 = extractBarcodesFromText(text2);
        const barcode2 = (Array.isArray(barcodes2) ? barcodes2 : [])[0] || barcode;
        if (barcode2) {
          barcode = barcode2;
          barcodes = Array.isArray(barcodes2) ? barcodes2 : barcodes;
          query = barcode2;
        }
      } catch (err) {
        // Lens fail: aşağıdaki NO_MATCH guard devreye girer
        tpush("serp_lens_retry_error", { message: safeStr(err?.message || err, 250) });
      }
    }
// Eğer hala boş / generic ise: yanlış sonuç göstermek yerine NO_MATCH
    if (!query || isGenericVisionQuery(query)) {
      const latencyMs = Date.now() - startedAt;
      return safeJson(res, {
        ok: false,
        error: "NO_MATCH",
        query: "",
        barcode: barcode || "",
        barcodes: Array.isArray(barcodes) ? barcodes : [],
        rawText: safeStr(text, 2000),
	        raw: { cloud_vision: cvOut || null, gemini: gemOut || null, serp_lens: lensOut || null, primary: out },
        ...(debug ? { _diag: { tries } } : {}),
        meta: {
          ipHash: ip ? String(ip).slice(0, 8) : null,
          uaSnippet: ua,
          latencyMs,
          used: used || null,
        },
      }, 200);
    }

    const latencyMs = Date.now() - startedAt;

    return safeJson(res, {
      ok: true,
      query,
      barcode: barcode || "",
      barcodes: Array.isArray(barcodes) ? barcodes : [],
      rawText: safeStr(text, 2000),
	      raw: { cloud_vision: cvOut || null, gemini: gemOut || null, serp_lens: lensOut || null, primary: out },
      ...(debug ? { _diag: { tries } } : {}),
      meta: {
        ipHash: ip ? String(ip).slice(0, 8) : null,
        uaSnippet: ua,
        latencyMs,
        used: used || null,
      },
    });
  } catch (e) {
    console.error("❌ [vision] genel hata:", e);
    return safeJson(
      res,
      { ok: false, error: "Vision API error", detail: e?.message },
      500
    );
  }
}



// ✅ Free vision endpoint (server-side OCR) — /api/vision/free
router.post("/free", async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = safeBody(req);
    const rawImage = body?.imageBase64 || body?.image || body?.img || "";

    const base64Part = String(rawImage).includes(",")
      ? String(rawImage).split(",")[1]
      : String(rawImage);

    let cleanBase64 = safeBase64(base64Part);
    if (!cleanBase64 || cleanBase64.length < 50) {
      return safeJson(res, { ok: false, error: "BASE64_INVALID" }, 400);
    }

    cleanBase64 = clampBase64Size(cleanBase64, 10 * 1024 * 1024);
    if (!cleanBase64) {
      return safeJson(res, { ok: false, error: "IMAGE_TOO_LARGE" }, 413);
    }

    const buf = Buffer.from(cleanBase64, "base64");
    const ocr = await freeOcrTesseract(buf, { timeoutMs: 9000 });

    if (!ocr?.ok) {
      return safeJson(
        res,
        {
          ok: false,
          error: "NO_MATCH",
          detail: ocr?.error || "OCR_FAILED",
          meta: { latencyMs: Date.now() - startedAt, used: ocr?.used || null },
        },
        200
      );
    }

    const q = String(ocr.query || "").trim();
    const b = Array.isArray(ocr.barcodes) && ocr.barcodes.length ? String(ocr.barcodes[0]) : "";

    return safeJson(
      res,
      {
        ok: true,
        query: q || b || "",
        barcode: b || "",
        barcodes: Array.isArray(ocr.barcodes) ? ocr.barcodes : [],
        rawText: safeStr(ocr.rawText || "", 2000),
        meta: {
          source: "free_vision",
          used: ocr.used || null,
          latencyMs: Date.now() - startedAt,
          freeTier: true,
        },
      },
      200
    );
  } catch (e) {
    return safeJson(res, { ok: false, error: "PROCESSING_ERROR", detail: e?.message || String(e) }, 500);
  }
});
// Backward-compatible
router.post("/", handleVision);
router.post("/vision", handleVision);

export default router;
