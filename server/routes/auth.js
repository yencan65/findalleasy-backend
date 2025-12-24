// server/routes/auth.js
// ===================================================================
//  AUTH ROUTER — S20 COSMIC SHIELD (HARDENED, ZERO-BREAKING-CHANGE)
//  Kayıt • Giriş • Aktivasyon • Şifre Sıfırlama • Profil
//  NOT: Hiçbir endpoint path'i ve response alanı değişmez.
//  Sadece güvenlik, istikrar ve loglama güçlendirilmiştir.
// ===================================================================

import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import User from "../models/User.js";
import { sendActivationEmail, sendPasswordResetCode } from "../utils/email.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "findalleasy_super_secret";
const JWT_ISSUER = process.env.JWT_ISSUER || "findalleasy_auth";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "findalleasy_frontend";

// ===================================================================
// S20 — GLOBAL IN-MEMORY RATE LIMIT STORE + MINI GC
// ===================================================================
// NOT: Prod’da Redis vs. ile desteklenebilir, bu çekirdek local
// memory ile de güvenlik katmanı sağlar.

const RATE_MAP = new Map();

function nowMs() {
  return Date.now();
}

/**
 * S18/S20 rate-limit
 * key: string
 * limit: max attempt
 * windowMs: ms
 * dönen: { allowed: boolean, remaining: number, retryAfterMs: number }
 */
function rateLimit(key, limit, windowMs) {
  if (!key) return { allowed: true, remaining: limit, retryAfterMs: 0 };

  const now = nowMs();
  const entry = RATE_MAP.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count += 1;
  RATE_MAP.set(key, entry);

  // Mini GC — arada bir süresi bitmiş anahtarları temizle
  if (Math.random() < 0.01) {
    for (const [k, v] of RATE_MAP.entries()) {
      if (now > v.resetAt) RATE_MAP.delete(k);
    }
  }

  const allowed = entry.count <= limit;
  const remaining = Math.max(0, limit - entry.count);
  const retryAfterMs = allowed ? 0 : entry.resetAt - now;

  return { allowed, remaining, retryAfterMs };
}

// ===================================================================
// Yardımcı – IP / Device bilgisi (Cloudflare + proxy aware)
// ===================================================================
function getClientInfo(req) {
  let ip =
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] &&
      String(req.headers["x-forwarded-for"]).split(",")[0].trim()) ||
    req.socket?.remoteAddress ||
    "0.0.0.0";

  // IPv4-mapped IPv6 adresi normalize et
  if (typeof ip === "string" && ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  const ua = typeof req.headers["user-agent"] === "string"
    ? req.headers["user-agent"]
    : "unknown";

  return {
    ip,
    ua,
  };
}

// ===================================================================
// S20 — Helper: UA kısaltma (rate-limit key için)
// ===================================================================
function shortUa(ua) {
  const s = typeof ua === "string" ? ua : "";
  return s.slice(0, 40); // rate-limit key için yeterli
}

// ===================================================================
// S18 — Input sanitize helpers (S20 hafif sıkılaştırma)
// ===================================================================
function sanitizeString(value, maxLen = 255) {
  if (value == null) return "";
  let s = String(value);

  // Temel trim
  s = s.trim();

  // Basit injection / XSS işaretlerini temizle
  s = s.replace(/[<>$;]/g, "");
  // Kontrol karakterlerini temizle
  s = s.replace(/[\x00-\x1F\x7F]/g, "");

  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function normalizeEmail(email) {
  const raw = String(email || "").toLowerCase();
  return sanitizeString(raw, 320);
}

function normalizeUsername(username) {
  return sanitizeString(username || "", 50);
}

// Body'nin gerçekten düz obje olduğundan emin ol
function safeBody(req) {
  const b = req && req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return {};
  return b;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Küçük yardımcı: kullanıcıyı frontend için normalize et
function buildUserPayload(user) {
  if (!user) return null;
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    activated: !!user.activated,
    walletBalance: user.walletBalance || 0,
    inviteCode: user.inviteCode || null,
    createdAt: user.createdAt,
  };
}

// ===================================================================
// S20 — Güvenli kod hash (aktivasyon & reset code için)
// ===================================================================
function hashCode(code) {
  const c = sanitizeString(code || "", 32);
  if (!c) return "";
  return crypto.createHash("sha256").update(c).digest("hex");
}

// ===================================================================
// Güvenli Token üretimi (S18 — iss/aud + exp) (S20 hafif ek veri için hazır)
// ===================================================================
function generateToken(user) {
  return jwt.sign(
    {
      userId: user._id,
      email: user.email,
      // İleride IP/UA hash vs. eklemek için yer var
    },
    JWT_SECRET,
    {
      expiresIn: "7d",
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

// ===================================================================
// 0) SAĞLIK KONTROLÜ - Yeni endpoint
// ===================================================================
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Auth API çalışıyor",
    timestamp: new Date().toISOString(),
  });
});

// ===================================================================
// 1) KAYIT OL — username + email + password + referral
// ===================================================================
router.post("/register", async (req, res) => {
  try {
    const body = safeBody(req);

    console.log("REGISTER BODY:", {
      // Şifreyi loglama yok
      email: body?.email,
      username: body?.username,
      referral: body?.referral ? "[REF]" : null,
    });

    let { username, email, password, referral } = body;

    // S18 — temel sanitize (orijinal mantık korunuyor)
    email = normalizeEmail(email);
    username = normalizeUsername(username);
    password = typeof password === "string" ? password : "";

    // S18 — rate-limit: IP + email + ua bazlı
    const client = getClientInfo(req);
    const rlKey = `reg:${client.ip}:${shortUa(client.ua)}:${email || "no-email"}`;
    const rl = rateLimit(rlKey, 10, 15 * 60 * 1000); // 15 dk / 10 deneme

    if (!rl.allowed) {
      return res.status(429).json({
        error: "Çok fazla deneme",
        details:
          "Kısa süre içinde çok fazla kayıt denemesi yapıldı. Lütfen biraz sonra tekrar deneyin.",
        retryAfterMs: rl.retryAfterMs,
      });
    }

    // Eksik alan kontrolü
    if (!email || !password || !username) {
      return res.status(400).json({
        error: "Eksik bilgi",
        details: "E-posta, şifre ve kullanıcı adı zorunludur",
      });
    }

    // Email formatı kontrolü
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({
        error: "Geçersiz e-posta formatı",
        details: "Lütfen geçerli bir e-posta adresi giriniz",
      });
    }

    // Şifre güvenlik kontrolü
    if (password.length < 6) {
      return res.status(400).json({
        error: "Şifre en az 6 karakter olmalıdır",
        details: "Lütfen daha güçlü bir şifre seçin",
      });
    }
    if (password.length > 256) {
      return res.status(400).json({
        error: "Şifre çok uzun",
        details: "Şifre makul bir uzunlukta olmalıdır",
      });
    }

    // Kullanıcı adı uzunluk kontrolü
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({
        error: "Kullanıcı adı 3-20 karakter arasında olmalıdır",
      });
    }

    // E-posta ve kullanıcı adı kontrolü
    const [emailExists, usernameExists] = await Promise.all([
      User.findOne({ email }),
      User.findOne({ username }),
    ]);

    if (emailExists) {
      return res.status(409).json({
        error: "Bu e-posta zaten kayıtlı.",
        details: "Farklı bir e-posta adresi deneyin veya giriş yapın",
      });
    }

    if (usernameExists) {
      return res.status(409).json({
        error: "Bu kullanıcı adı zaten alınmış.",
        details: "Lütfen farklı bir kullanıcı adı seçin",
      });
    }

    // Şifre hash
    const hash = await bcrypt.hash(password, 12);

    // Aktivasyon kodu
    const activationCode = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
    const activationCodeHash = hashCode(activationCode);

    // Davet eden varsa
    // Davet eden kullanıcıyı bul
    let referredBy = null;

    if (referral) {
      // referral bir inviteCode olacak
      const sanitizedReferral = sanitizeString(referral.trim(), 64);
      const refUser = await User.findOne({
        inviteCode: sanitizedReferral,
      });

      if (refUser) {
        // Güvenlik: Kendini davet etme blok (aynı email vs.)
        if (refUser.email?.toLowerCase() !== email.toLowerCase()) {
          referredBy = refUser._id; // ObjectId olarak sakla
        }
      }
    }

    // **KRİTİK: UNIQUE inviteCode garanti**
    let inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    while (await User.findOne({ inviteCode })) {
      inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    }

    // Kullanıcı oluştur (aktive edilmemiş olarak)
    const user = await User.create({
      username,
      email,
      password: hash,
      passwordHash: hash,
      referredBy,
      inviteCode,
      rewards: [],
      walletBalance: 0,
      activated: false,
      activationCode, // backward compatible
      activationCodeHash, // S20 — hash alanı
      activationCodeExpires: Date.now() + 24 * 60 * 60 * 1000, // 24 saat
      createdAt: new Date(),
    });

    // Aktivasyon maili gönder
    try {
      await sendActivationEmail(email, activationCode, username);
      console.log(`Aktivasyon maili gönderildi: ${email}`);
    } catch (emailError) {
      console.error("Mail gönderme hatası:", emailError);
      // Kullanıcıyı silmek yerine hesabı pasif bırakıyoruz
      // Frontend davranışı değişmesin diye yine hata dönüyoruz
      return res.status(500).json({
        error: "Aktivasyon maili gönderilemedi.",
        details:
          "Lütfen daha sonra tekrar deneyin veya e-posta adresinizi kontrol edin",
      });
    }

    return res.status(201).json({
      ok: true,
      message: "Kayıt başarılı! Aktivasyon kodu e-posta adresinize gönderildi.",
      requiresActivation: true,
      email: email,
      username: username,
    });
  } catch (err) {
    console.log("REGISTER ERROR:", err);

    // MongoDB duplicate key error
    if (err && err.code === 11000) {
      const field = Object.keys(err.keyPattern || { email: 1 })[0];
      const fieldName = field === "email" ? "e-posta" : "kullanıcı adı";
      return res.status(409).json({
        error: `Bu ${fieldName} zaten kayıtlı.`,
        details: `Lütfen farklı bir ${fieldName} deneyin`,
      });
    }

    return res.status(500).json({
      error: "Sunucu hatası",
      details: "Lütfen daha sonra tekrar deneyin",
    });
  }
});

// ===================================================================
// 2) AKTİVASYON - Geliştirilmiş versiyon (S20: hash aware)
// ===================================================================
router.post("/activate", async (req, res) => {
  try {
    const body = safeBody(req);
    let { email, code } = body || {};
    email = normalizeEmail(email);
    code = sanitizeString(code, 10);

    // S18 rate-limit (IP + email + ua)
    const client = getClientInfo(req);
    const rlKey = `activate:${client.ip}:${shortUa(client.ua)}:${email || "no-email"}`;
    const rl = rateLimit(rlKey, 15, 15 * 60 * 1000); // 15dk / 15 attempt
    if (!rl.allowed) {
      return res.status(429).json({
        error: "Çok fazla deneme",
        details:
          "Aktivasyon için çok fazla deneme yaptınız. Lütfen kısa bir süre bekleyin.",
        retryAfterMs: rl.retryAfterMs,
      });
    }

    if (!email || !code) {
      return res.status(400).json({
        error: "Eksik bilgi",
        details: "E-posta ve aktivasyon kodu gereklidir",
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        error: "Kullanıcı bulunamadı",
        details: "Lütfen kayıt işlemini tekrar deneyin",
      });
    }

    // Zaten aktif mi?
    if (user.activated) {
      return res.status(400).json({
        error: "Hesap zaten aktif",
        details: "Bu hesap daha önceden aktif edilmiş, giriş yapabilirsiniz",
      });
    }

    // Aktivasyon kodu kontrolü (S20: hash varsa hash, yoksa plain)
    const providedHash = hashCode(code);
    const hasHash = !!user.activationCodeHash;

    const codeMatches = hasHash
      ? user.activationCodeHash === providedHash
      : user.activationCode === code;

    if (!codeMatches) {
      return res.status(401).json({
        error: "Geçersiz aktivasyon kodu",
        details: "Lütfen e-posta adresinize gelen doğru kodu girin",
      });
    }

    // Kod süresi dolmuş mu kontrol et
    if (user.activationCodeExpires && Date.now() > user.activationCodeExpires) {
      // Yeni kod oluştur
      const newActivationCode = Math.floor(
        100000 + Math.random() * 900000
      ).toString();
      user.activationCode = newActivationCode;
      user.activationCodeHash = hashCode(newActivationCode);
      user.activationCodeExpires = Date.now() + 24 * 60 * 60 * 1000;
      await user.save();

      // Yeni kod gönder
      try {
        await sendActivationEmail(user.email, newActivationCode, user.username);
        return res.status(410).json({
          error: "Aktivasyon kodunun süresi dolmuş",
          details: "Yeni bir aktivasyon kodu e-posta adresinize gönderildi",
          requiresNewCode: true,
        });
      } catch (emailError) {
        return res.status(500).json({
          error: "Yeni kod gönderilemedi",
          details: "Lütfen yeniden kod talep edin",
        });
      }
    }

    // Hesabı aktif et
    user.activated = true;
    user.activationCode = null;
    user.activationCodeHash = null;
    user.activationCodeExpires = null;
    user.activatedAt = new Date();
    await user.save();

    // Otomatik giriş token'ı oluştur
    const token = generateToken(user);

    return res.json({
      ok: true,
      message: "Hesabınız başarıyla aktif edildi!",
      token,
      userId: user._id,
      username: user.username,
      email: user.email,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.log("ACTIVATE ERROR:", err);
    return res.status(500).json({
      error: "Aktivasyon işlemi başarısız",
      details: "Lütfen daha sonra tekrar deneyin",
    });
  }
});

// ===================================================================
// 3) GİRİŞ — Aktivasyon kontrolü + Token (S20: timing guard)
// ===================================================================
router.post("/login", async (req, res) => {
  try {
    const body = safeBody(req);
    let { email, password } = body || {};
    const client = getClientInfo(req);

    email = normalizeEmail(email);
    password = typeof password === "string" ? password : "";

    // S18 rate-limit (IP + email + ua)
    const rlKey = `login:${client.ip}:${shortUa(client.ua)}:${email || "no-email"}`;
    const rl = rateLimit(rlKey, 20, 15 * 60 * 1000); // 15dk / 20 login attempt

    if (!rl.allowed) {
      return res.status(429).json({
        error: "Çok fazla deneme",
        details:
          "Kısa sürede çok fazla giriş denemesi yaptınız. Lütfen biraz sonra tekrar deneyin.",
        retryAfterMs: rl.retryAfterMs,
      });
    }

    if (!email || !password) {
      return res.status(400).json({
        error: "Eksik bilgi",
        details: "E-posta ve şifre gereklidir",
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Timing guard: kullanıcı yoksa bile sabit gecikme
    if (!user) {
      await new Promise((resolve) =>
        setTimeout(resolve, 200 + Math.floor(Math.random() * 200))
      );
      return res.status(401).json({
        error: "Giriş başarısız",
        details: "E-posta veya şifre hatalı",
      });
    }

    // Aktivasyon yapılmadan giriş YASAK
    if (!user.activated) {
      // Eğer aktivasyon kodu süresi dolmuşsa yeni kod gönder
      if (user.activationCodeExpires && Date.now() > user.activationCodeExpires) {
        const newActivationCode = Math.floor(
          100000 + Math.random() * 900000
        ).toString();
        user.activationCode = newActivationCode;
        user.activationCodeHash = hashCode(newActivationCode);
        user.activationCodeExpires = Date.now() + 24 * 60 * 60 * 1000;
        await user.save();

        try {
          await sendActivationEmail(user.email, newActivationCode, user.username);
        } catch (emailError) {
          console.error("Yeni aktivasyon kodu gönderme hatası:", emailError);
        }
      }

      return res.status(403).json({
        error: "Hesap aktif değil",
        details: "Lütfen e-posta adresinizdeki aktivasyon kodunu kullanın",
        requiresActivation: true,
        email: user.email,
      });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({
        error: "Giriş başarısız",
        details: "E-posta veya şifre hatalı",
      });
    }

    const token = generateToken(user);
    const userPayload = buildUserPayload(user);
    const points = user.walletBalance || 0;

    console.log("LOGIN OK:", {
      userId: String(user._id),
      email: user.email,
      ip: client.ip,
      ua: client.ua,
    });

    return res.json({
      ok: true,
      message: "Giriş başarılı",
      token,
      userId: user._id,
      username: user.username,
      email: user.email,
      user: userPayload, // FRONTEND için normalize edilmiş user
      rewards: {
        total: points,
      },
      points, // Eski / yeni frontend için ortak alan
    });
  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).json({
      error: "Giriş işlemi başarısız",
      details: "Lütfen daha sonra tekrar deneyin",
    });
  }
});

// ===================================================================
// 4) AKTİVASYON KODU YENİDEN GÖNDER (S20: hash aware)
// ===================================================================
router.post("/resend-activation", async (req, res) => {
  try {
    const body = safeBody(req);
    let { email } = body || {};
    email = normalizeEmail(email);

    if (!email) {
      return res.status(400).json({
        error: "E-posta gereklidir",
        details: "Lütfen e-posta adresinizi girin",
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({
        error: "Kullanıcı bulunamadı",
        details: "Bu e-posta adresi ile kayıtlı kullanıcı bulunamadı",
      });
    }

    if (user.activated) {
      return res.status(400).json({
        error: "Hesap zaten aktif",
        details: "Bu hesap zaten aktif durumda, giriş yapabilirsiniz",
      });
    }

    // Yeni aktivasyon kodu oluştur
    const newActivationCode = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
    user.activationCode = newActivationCode;
    user.activationCodeHash = hashCode(newActivationCode);
    user.activationCodeExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 saat
    await user.save();

    // Yeni kod gönder
    try {
      await sendActivationEmail(user.email, newActivationCode, user.username);
      return res.json({
        ok: true,
        message: "Yeni aktivasyon kodu gönderildi",
        details: "Lütfen e-posta adresinizi kontrol edin",
      });
    } catch (emailError) {
      console.error("Yeni aktivasyon kodu gönderme hatası:", emailError);
      return res.status(500).json({
        error: "Kod gönderilemedi",
        details: "Lütfen daha sonra tekrar deneyin",
      });
    }
  } catch (err) {
    console.log("RESEND ACTIVATION ERROR:", err);
    return res.status(500).json({
      error: "İşlem başarısız",
      details: "Lütfen daha sonra tekrar deneyin",
    });
  }
});

// ===================================================================
// 5) ŞİFREMİ UNUTTUM (S20: hash aware)
// ===================================================================
router.post("/forgot-password", async (req, res) => {
  try {
    const body = safeBody(req);
    let { email } = body || {};
    email = normalizeEmail(email);

    if (!email) {
      return res.status(400).json({
        error: "E-posta gereklidir",
        details: "Lütfen e-posta adresinizi girin",
      });
    }

    // Rate-limit: email + ip + ua bazlı
    const client = getClientInfo(req);
    const rlKey = `forgot:${client.ip}:${shortUa(client.ua)}:${email}`;
    const rl = rateLimit(rlKey, 10, 30 * 60 * 1000); // 30dk / 10 istek

    if (!rl.allowed) {
      return res.status(429).json({
        error: "Çok fazla deneme",
        details:
          "Bu e-posta için çok fazla şifre sıfırlama isteği yapıldı. Lütfen daha sonra tekrar deneyin.",
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Güvenlik için: E-posta olmasa bile başarılı mesajı dön
      return res.json({
        ok: true,
        message: "Şifre sıfırlama talimatları gönderildi",
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetCode = code; // backward compatible
    user.resetCodeHash = hashCode(code); // S20 — hash alanı
    user.resetCodeExpires = Date.now() + 1000 * 60 * 15; // 15 dakika
    await user.save();

    try {
      await sendPasswordResetCode(email, code, user.username);
      return res.json({
        ok: true,
        message: "Şifre sıfırlama kodu gönderildi",
        details: "Lütfen e-posta adresinizi kontrol edin",
      });
    } catch (emailError) {
      console.error("Şifre sıfırlama kodu gönderme hatası:", emailError);
      return res.status(500).json({
        error: "Kod gönderilemedi",
        details: "Lütfen daha sonra tekrar deneyin",
      });
    }
  } catch (err) {
    console.log("FORGOT PASSWORD ERROR:", err);
    return res.status(500).json({
      error: "İşlem başarısız",
      details: "Lütfen daha sonra tekrar deneyin",
    });
  }
});

// ===================================================================
// 6) Şifre Sıfırlama (S20: hash aware)
// ===================================================================
router.post("/reset-password", async (req, res) => {
  try {
    const body = safeBody(req);
    let { email, code, newPassword } = body || {};
    email = normalizeEmail(email);
    code = sanitizeString(code, 10);
    newPassword = typeof newPassword === "string" ? newPassword : "";

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        error: "Eksik bilgi",
        details: "Tüm alanlar gereklidir",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Şifre çok kısa",
        details: "Şifre en az 6 karakter olmalıdır",
      });
    }

    if (newPassword.length > 256) {
      return res.status(400).json({
        error: "Şifre çok uzun",
        details: "Şifre makul bir uzunlukta olmalıdır",
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({
        error: "Kullanıcı bulunamadı",
        details: "Lütfen e-posta adresinizi kontrol edin",
      });
    }

    const providedHash = hashCode(code);
    const hasHash = !!user.resetCodeHash;

    const codeMatches = hasHash
      ? user.resetCodeHash === providedHash
      : user.resetCode === code;

    if (
      !codeMatches ||
      !user.resetCodeExpires ||
      Date.now() > user.resetCodeExpires
    ) {
      return res.status(401).json({
        error: "Geçersiz kod",
        details:
          "Kod hatalı veya süresi dolmuş. Lütfen yeni kod talep edin.",
      });
    }

    // Yeni şifreyi hashle
    const newHash = await bcrypt.hash(newPassword, 12);
    user.password = newHash;
    user.passwordHash = newHash;
    user.resetCode = null;
    user.resetCodeHash = null;
    user.resetCodeExpires = null;
    user.lastPasswordChange = new Date();

    await user.save();

    return res.json({
      ok: true,
      message: "Şifre başarıyla güncellendi",
      details: "Yeni şifrenizle giriş yapabilirsiniz",
    });
  } catch (err) {
    console.log("RESET PASSWORD ERROR:", err);
    return res.status(500).json({
      error: "Şifre sıfırlama başarısız",
      details: "Lütfen daha sonra tekrar deneyin",
    });
  }
});

// ===================================================================
// 7) PROFİL BİLGİLERİ - Token ile
// ===================================================================
router.get("/profile", async (req, res) => {
  try {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.replace("Bearer ", "") : raw;

    if (!token) {
      return res.status(401).json({ error: "Yetkilendirme gerekiyor" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch (err) {
      console.log("PROFILE TOKEN VERIFY ERROR:", err?.message);
      return res.status(401).json({ error: "Geçersiz token" });
    }

    const user = await User.findById(decoded.userId).select(
      "-password -passwordHash -activationCode -resetCode"
    );

    if (!user) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    }

    return res.json({
      ok: true,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.log("PROFILE ERROR:", err);
    return res.status(500).json({ error: "Sunucu hatası" });
  }
});

// ===================================================================
// 7b) PROFİL BİLGİLERİ - /profile/:id alias (id ile çağrı için)
// ===================================================================
router.get("/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select(
      "-password -passwordHash -activationCode -resetCode"
    );

    if (!user) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    }

    return res.json({
      ok: true,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.log("PROFILE BY ID ERROR:", err);
    return res.status(500).json({ error: "Sunucu hatası" });
  }
});

export default router;
