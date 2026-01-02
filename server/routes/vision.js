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
const IMG_MAX_BYTES_TOTAL = Number(process.env.VISION_IMG_MAX_BYTES_TOTAL || 40 * 1024 * 1024);

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
  const xfProto = safeStr(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const cfVisitor = safeStr(req.headers["cf-visitor"] || "");
  let proto = xfProto || (cfVisitor.includes('"https"') ? "https" : req.protocol || "https");
  if (proto !== "https" && proto !== "http") proto = "https";

  const xfHost = safeStr(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = xfHost || safeStr(req.headers.host || "");
  const safeHost = host.replace(/[^a-zA-Z0-9\-\.:]/g, "");
  return `${proto}://${safeHost}`;
}

function pickHlGlFromLocale(locale) {
  const l = safeStr(locale || "tr").toLowerCase();
  const hl =
    l.startsWith("tr") ? "tr" :
    l.startsWith("ru") ? "ru" :
    l.startsWith("ar") ? "ar" :
    l.startsWith("fr") ? "fr" : "en";
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

    const t1 = safeStr(kg?.title || kg?.name || "");
    if (t1) return t1;

    const t2 = safeStr(vm?.[0]?.title || vm?.[0]?.snippet || "");
    if (t2) return t2;

    const t3 = safeStr(shop?.[0]?.title || shop?.[0]?.product_title || "");
    if (t3) return t3;

    const t4 = safeStr(org?.[0]?.title || org?.[0]?.snippet || "");
    if (t4) return t4;
  } catch {
    // ignore
  }
  return "";
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
      return res.status(500).json({ ok: false, error: "JSON_SERIALIZATION_ERROR" });
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

  t = t
    .replace(/bu fotoğrafta|görünüyor|görünmektedir|olabilir|resimde|fotoğrafta/g, "")
    .replace(/looks like|maybe|probably|appears to be/g, "")
    .replace(/bir\s+/g, "")
    .replace(/çok\s+/g, "")
    .replace(/sanırım|muhtemelen|gibi/g, "")
    .replace(/this is|it is|there is|object/g, "")
    .replace(/product|item|thing/g, "");

  t = t.replace(/[^a-zA-Z0-9ğüşöçİıĞÜŞÖÇ\s]/g, "");
  t = t.replace(/\s\s+/g, " ").trim();

  if (!t) return "";
  const words = t.split(" ").filter(Boolean);
  if (words.length > 5) t = words.slice(0, 4).join(" ");
  return t.trim();
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

/* ============================================================
   VISION HANDLER
   ============================================================ */

async function handleVision(req, res) {
  const startedAt = Date.now();
  const ip = getIP(req);
  const ua = getUA(req);
  const debug = String(process.env.VISION_DEBUG || "") === "1" || String(req.query?.diag || "") === "1";

  try {
    const rl = rateLimit(ip, 40, 60_000);
    if (!rl.allowed) {
      return safeJson(res, { ok: false, throttled: true, retryAfterMs: rl.retryMs }, 429);
    }

    const body = safeBody(req);

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
            parsedKeys: isPlainObject(body) ? Object.keys(body).slice(0, 20) : null,
          }
        : undefined;

      return safeJson(res, { ok: false, error: "imageBase64 eksik", ...(diag ? { diag } : {}) }, 400);
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
        meta: { ipHash: ip ? String(ip).slice(0, 8) : null, uaSnippet: ua, latencyMs, mock: true },
      });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    const serpKey = process.env.SERPAPI_KEY;

    if (!apiKey && !serpKey) {
      return safeJson(res, { ok: false, error: "VISION_DISABLED", detail: "GOOGLE_API_KEY & SERPAPI_KEY missing" }, 200);
    }

    const mimeType = detectMimeType(rawImage);
    const base64Part = String(rawImage).includes(",") ? String(rawImage).split(",")[1] : String(rawImage);
    let cleanBase64 = safeBase64(base64Part);

    if (!cleanBase64 || cleanBase64.length < 50) {
      return safeJson(res, { ok: false, error: "BASE64_INVALID" }, 400);
    }

    cleanBase64 = clampBase64Size(cleanBase64, 15 * 1024 * 1024);
    if (!cleanBase64) {
      return safeJson(res, { ok: false, error: "IMAGE_TOO_LARGE" }, 413);
    }

    const { hl, gl } = pickHlGlFromLocale(body.locale || body.localeHint || "tr");

    let rawText = "";
    let gemOut = null;
    let lensOut = null;
    let used = null;

    // 1) Gemini
    if (apiKey) {
      used = "gemini";
      try {
        const url =
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey;

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
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
          10_000
        );

        gemOut = await r.json().catch(() => null);
        if (!r.ok) throw new Error("VISION_HTTP_ERROR " + r.status);

        rawText =
          gemOut?.candidates?.[0]?.content?.parts?.[0]?.text ||
          gemOut?.candidates?.[0]?.content?.parts?.[0]?.content ||
          "";
      } catch (err) {
        console.warn("⚠️ [vision] Gemini fail, SerpApi Lens fallback denenecek:", err?.message || err);
        rawText = "";
        used = null;
      }
    }

    // 2) SerpApi google_lens fallback
    if ((!rawText || !String(rawText).trim()) && serpKey) {
      try {
        const buf = Buffer.from(cleanBase64, "base64");
        const id = putTempImage(buf, mimeType || "image/jpeg");
        const imageUrl = `${buildPublicOrigin(req)}/api/vision/i/${id}`;

        const lensUrl = new URL("https://serpapi.com/search.json");
        lensUrl.searchParams.set("engine", "google_lens");
        lensUrl.searchParams.set("url", imageUrl);
        lensUrl.searchParams.set("api_key", serpKey);
        lensUrl.searchParams.set("hl", hl);
        lensUrl.searchParams.set("gl", gl);

        const rr = await fetchWithTimeout(lensUrl.toString(), { method: "GET" }, 12_000);
        lensOut = await rr.json().catch(() => null);
        if (!rr.ok) throw new Error("SERPAPI_HTTP_ERROR " + rr.status);

        rawText = pickSerpLensText(lensOut);
        used = used ? used + "+serp_lens" : "serp_lens";
      } catch (err) {
        console.warn("❌ [vision] SerpApi Lens fail:", err?.message || err);
      }
    }

    const out = gemOut || lensOut;
    const text = String(rawText || "").trim();
    let query = extractSearchQuery(text);

    if (!query && text) {
      const words = text
        .toLowerCase()
        .replace(/[^a-zA-Z0-9ğüşöçİıĞÜŞÖÇ\s]/g, "")
        .split(/\s+/)
        .filter(Boolean);
      if (words.length > 0) query = words.slice(0, 3).join(" ");
    }

    if (!query) query = "ürün";

    const latencyMs = Date.now() - startedAt;

    return safeJson(res, {
      ok: true,
      query,
      rawText: safeStr(text, 2000),
      raw: { gemini: gemOut || null, serp_lens: lensOut || null, primary: out },
      meta: { ipHash: ip ? String(ip).slice(0, 8) : null, uaSnippet: ua, latencyMs, used: used || null },
    });
  } catch (e) {
    console.error("❌ [vision] genel hata:", e);
    return safeJson(res, { ok: false, error: "Vision API error", detail: e?.message }, 500);
  }
}

// Backward-compatible
router.post("/", handleVision);
router.post("/vision", handleVision);

export default router;
