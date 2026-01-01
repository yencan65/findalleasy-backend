// server/routes/vision.js
// ======================================================================
//   VISION ROUTER — S30 VISION-NEXUS FORTRESS
//   • S20 mantık %100 KORUNDU (extractSearchQuery, base64 akışı, Gemini call)
//   • Ekstra güvenlik:
//        - Body guard (sadece plain object kabul)
//        - IPv6-safe IP algılama
//        - Rate-limit + mini GC (RL Map şişmesini azaltır)
//        - Base64 flood koruması (imageTooLarge + minLength guard)
//        - JSON-safe response + hata kodu netleştirme
//   • Zero-breaking-change: /vision cevabının şeması aynı
// ======================================================================

import express from "express";
import fetch from "node-fetch";

const router = express.Router();

/* ============================================================
   S30 — SAFE HELPERS (XSS, BASE64, JSON, TIMEOUT, BODY GUARD)
   ============================================================ */
function safeStr(v, max = 500) {
  try {
    if (v == null) return "";
    let s = String(v)
      .trim()
      .normalize("NFKC")
      .replace(/[<>$;{}\[\]()]/g, ""); // XSS + basic injection
    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch {
    return "";
  }
}

function safeJson(res, obj, status = 200) {
  try {
    if (status === 200) return res.json(obj);
    return res.status(status).json(obj);
  } catch (err) {
    console.error("❌ [vision] safeJson ERROR:", err);
    try {
      return res.status(500).json({
        ok: false,
        error: "JSON_SERIALIZATION_ERROR",
      });
    } catch {
      return;
    }
  }
}

// Body guard: sadece düz obje kabul et
function safeBody(req) {
  const b = req && req.body;
  if (b && typeof b === "object" && !Array.isArray(b)) return b;
  return {};
}

// Sadece valid base64 karakterleri bırak
function safeBase64(str) {
  if (!str) return "";
  const s = String(str);
  return s.replace(/[^0-9A-Za-z+/=]/g, "");
}

// Base64 boyut kontrolü (approx): maxBytes üstüne çıkarsa null
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
   ⚡ RATE-LIMIT (S30) — IP bazlı + mini GC
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

  // Mini GC — arada bir eski entry'leri temizle
  if (Math.random() < 0.01) {
    for (const [key, e] of RL.entries()) {
      if (now > e.resetAt) RL.delete(key);
    }
  }

  return {
    allowed: entry.count <= limit,
    retryMs: entry.resetAt - now,
  };
}

/* ============================================================
   🔥 GÜÇLENDİRİLMİŞ ÜRÜN ADI EXTRACTOR — S20 → S30
   ============================================================ */
function extractSearchQuery(text = "") {
  if (!text) return "";

  let t = text.toLowerCase();

  // Türkçe + İngilizce doğal dil çöplüğü temizlik
  t = t
    .replace(
      /bu fotoğrafta|görünüyor|görünmektedir|olabilir|resimde|fotoğrafta/g,
      ""
    )
    .replace(/looks like|maybe|probably|appears to be/g, "")
    .replace(/bir\s+/g, "")
    .replace(/çok\s+/g, "")
    .replace(/sanırım|muhtemelen|gibi/g, "")
    .replace(/this is|it is|there is|object/g, "")
    .replace(/product|item|thing/g, "");

  // Karakter filtresi
  t = t.replace(/[^a-zA-Z0-9ğüşöçİıĞÜŞÖÇ\s]/g, "");
  t = t.replace(/\s\s+/g, " ").trim();

  if (!t) return "";

  const words = t.split(" ").filter(Boolean);

  // Çok uzun response'larda ilk 3–4 kelime iyidir
  if (words.length > 5) {
    t = words.slice(0, 4).join(" ");
  }

  return t.trim();
}

/* ============================================================
   🔍 MIME TESPİTİ — DATA URL'den veya fallback
   ============================================================ */
function detectMimeType(rawImage) {
  if (!rawImage) return "image/jpeg";
  const s = String(rawImage);

  if (s.startsWith("data:image/png")) return "image/png";
  if (s.startsWith("data:image/webp")) return "image/webp";
  if (s.startsWith("data:image/jpg")) return "image/jpeg";
  if (s.startsWith("data:image/jpeg")) return "image/jpeg";

  // data URL değilse: en güvenli default
  return "image/jpeg";
}

/* ============================================================
   🔥 VISION API — Fotoğraf Analizi (S30 VISION-NEXUS)
   ============================================================ */
const visionHandler = async (req, res) => {
  const startedAt = Date.now();
  const ip = getIP(req);
  const ua = getUA(req);

  try {
    // Rate-limit
    const rl = rateLimit(ip, 40, 60_000);
    if (!rl.allowed) {
      return safeJson(
        res,
        {
          ok: false,
          throttled: true,
          retryAfterMs: rl.retryMs,
        },
        429
      );
    }

    const body = safeBody(req);
    const rawImage = body.imageBase64;

    if (!rawImage) {
      return safeJson(
        res,
        { ok: false, error: "imageBase64 eksik" },
        400
      );
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      console.error("❌ [vision] GOOGLE_API_KEY tanımlı değil");
      return safeJson(
        res,
        { ok: false, error: "API_KEY_MISSING" },
        500
      );
    }

    // DATA URL → raw base64
    const mimeType = detectMimeType(rawImage);
    const base64Part = rawImage.includes(",")
      ? rawImage.split(",")[1]
      : rawImage;

    let cleanBase64 = safeBase64(base64Part);

    if (!cleanBase64 || cleanBase64.length < 50) {
      return safeJson(
        res,
        { ok: false, error: "BASE64_INVALID" },
        400
      );
    }

    // Boyut sınırı (örn. ~6MB)
    cleanBase64 = clampBase64Size(cleanBase64, 6 * 1024 * 1024);
    if (!cleanBase64) {
      return safeJson(
        res,
        { ok: false, error: "IMAGE_TOO_LARGE" },
        413
      );
    }

    // Doğru model (Gemini 1.5 Flash)
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
      apiKey;

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
            {
              inlineData: {
                mimeType,
                data: cleanBase64,
              },
            },
          ],
        },
      ],
    };

    // API çağrısı + timeout kalkanı
    const AbortCtor = globalThis.AbortController || null;
    let r;

    if (AbortCtor) {
      const controller = new AbortCtor();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        console.error("❌ [vision] fetch/timeout error:", err);
        return safeJson(
          res,
          { ok: false, error: "VISION_TIMEOUT_OR_NETWORK" },
          504
        );
      }

      clearTimeout(timeout);
    } else {
      // Eski Node sürümleri için: timeoutsuz fallback
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    let out;
    try {
      out = await r.json();
    } catch (err) {
      console.error("❌ [vision] JSON parse error:", err);
      return safeJson(
        res,
        { ok: false, error: "VISION_PARSE_ERROR" },
        502
      );
    }

    if (!r.ok) {
      console.error("❌ [vision] HTTP error:", r.status, out);
      return safeJson(
        res,
        {
          ok: false,
          error: "VISION_HTTP_ERROR",
          status: r.status,
          detail: out?.error || null,
        },
        502
      );
    }

    // Çıktıyı sağlamlaştır
    const rawText =
      out?.candidates?.[0]?.content?.parts?.[0]?.text ||
      out?.candidates?.[0]?.content?.parts?.[0]?.content ||
      "";

    let query = extractSearchQuery(rawText);

    // Eğer extractor hiçbir şey bulamazsa, kaba fallback
    if (!query && rawText) {
      const words = rawText
        .toLowerCase()
        .replace(/[^a-zA-Z0-9ğüşöçİıĞÜŞÖÇ\s]/g, "")
        .split(/\s+/)
        .filter(Boolean);

      if (words.length > 0) {
        query = words.slice(0, 3).join(" ");
      }
    }

    // Hâlâ yoksa: son çare
    if (!query) {
      query = "ürün";
    }

    const latencyMs = Date.now() - startedAt;

    return safeJson(res, {
      ok: true,
      query,
      rawText: safeStr(rawText, 2000),
      raw: out, // ZERO DELETE – debug için bırakıldı
      meta: {
        ipHash: ip ? String(ip).slice(0, 8) : null,
        uaSnippet: ua,
        latencyMs,
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
};

// Compatibility aliases:
// - Frontend currently calls POST /api/vision
// - Legacy clients may call POST /api/vision/vision
router.post("/vision", visionHandler);
router.post("/", visionHandler);

export default router;
