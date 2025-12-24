// ======================================================================
//  VERIFY ROUTER — S30 TITAN-IAM FORTRESS EDITION
//  Email Verify + JWT + Session Binding + Anti-Replay + Zero Delete
// ======================================================================

import express from "express";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import VerificationCode from "../models/VerificationCode.js";

const router = express.Router();

// ======================================================================
//  🔐 S30 IAM — SESSION STORE (Memory, küçük & hızlı)
// ======================================================================
const SESSION_MAP = new Map(); 
const NONCE_MAP = new Map();  

function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

function generateNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function bindSession(userEmail, ip, ua) {
  const sessionId = generateSessionId();
  SESSION_MAP.set(sessionId, {
    userEmail,
    ip,
    ua,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000, // 30 dk session
  });
  return sessionId;
}

function validateSession(sessionId, ip, ua) {
  const s = SESSION_MAP.get(sessionId);
  if (!s) return false;

  if (Date.now() > s.expiresAt) {
    SESSION_MAP.delete(sessionId);
    return false;
  }

  if (s.ip !== ip) return false;
  if ((ua || "").slice(0, 40) !== (s.ua || "").slice(0, 40)) return false;

  return true;
}

// GC Task
setInterval(() => {
  const now = Date.now();
  for (const [sid, obj] of SESSION_MAP.entries()) {
    if (now > obj.expiresAt) SESSION_MAP.delete(sid);
  }
}, 300_000).unref?.();

// ======================================================================
//  🔐 S30 IAM — JWT HELPERS
// ======================================================================
const JWT_SECRET = process.env.JWT_SECRET || "FAE_SUPER_SECRET_DEV";

function issueJWT(email, sessionId) {
  const nonce = generateNonce();
  NONCE_MAP.set(nonce, Date.now()); // replay engeli

  return jwt.sign(
    {
      email,
      sid: sessionId,
      nonce,
    },
    JWT_SECRET,
    { expiresIn: "20m" }
  );
}

function validateJWT(token, ip, ua) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Nonce replay shield (tek kullanım)
    if (!NONCE_MAP.has(decoded.nonce)) return false;
    NONCE_MAP.delete(decoded.nonce);

    // Session bağlı mı?
    if (!validateSession(decoded.sid, ip, ua)) return false;

    return decoded;
  } catch {
    return false;
  }
}

// ======================================================================
//  S26 SAFE HELPERS (TAMAMI KORUNDU — ZERO DELETE)
// ======================================================================
function safeStr(v, max = 300) {
  if (!v) return "";
  let s = String(v).trim().normalize("NFKC").replace(/[<>{}]/g, "");
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function validEmail(email) {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  if (/[\u0080-\uFFFF]/.test(e)) return false;
  const re = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  return re.test(e);
}

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || "0.0.0.0";
}

function safeJson(res, obj, status = 200) {
  try {
    return status === 200 ? res.json(obj) : res.status(status).json(obj);
  } catch {
    return res.status(500).json({
      success: false,
      error: "JSON_SERIALIZATION_ERROR",
    });
  }
}

// ======================================================================
//  RATE LIMIT S26 — KORUNDU
// ======================================================================
const RL = new Map();
function rateLimit(ip, email, limit = 8, windowMs = 60_000) {
  const key = `${ip}:${email}`;
  const now = Date.now();
  const entry = RL.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  RL.set(key, entry);

  return {
    allowed: entry.count <= limit,
    retryMs: entry.resetAt - now,
  };
}

// ======================================================================
//  SMTP — KORUNDU
// ======================================================================
function makeTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[verify] ⚠ SMTP yapılandırılmamış — TEST MODE");
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
}
const transporter = makeTransporter();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ======================================================================
//  📩 1) SEND-CODE — Eski davranış + IAM session başlangıcı
// ======================================================================
router.post("/send-code", async (req, res) => {
  try {
    const ip = getIP(req);
    const ua = req.headers["user-agent"] || "";
    const rawEmail = safeStr(req.body?.email);
    const email = rawEmail.toLowerCase();

    if (!validEmail(email)) {
      return safeJson(res, { success: false, message: "Geçersiz e-posta" }, 400);
    }

    const rl = rateLimit(ip, email, 5, 60_000);
    if (!rl.allowed) {
      return safeJson(
        res,
        {
          success: false,
          throttled: true,
          retryAfterMs: rl.retryMs,
        },
        429
      );
    }

    const previous = await VerificationCode.findOne({ email });
    if (previous && previous.resendAt > Date.now()) {
      const waitSec = Math.ceil((previous.resendAt - Date.now()) / 1000);
      return safeJson(
        res,
        { success: false, message: `Lütfen ${waitSec} saniye bekleyin` },
        429
      );
    }

    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    const resendAt = Date.now() + 60 * 1000;

    await VerificationCode.findOneAndUpdate(
      { email },
      { code, expires, resendAt, type: "signup" },
      { upsert: true, new: true }
    );

    // IAM: Session başlat
    const sessionId = bindSession(email, ip, ua);

    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: "FindAllEasy Doğrulama Kodu",
        text: `Kodunuz: ${code}`,
      });
    }

    return safeJson(res, {
      success: true,
      sessionId, // frontend bunu saklar
    });
  } catch (err) {
    return safeJson(
      res,
      { success: false, message: "Server error" },
      500
    );
  }
});

// ======================================================================
//  🔑 2) VERIFY-CODE — Kod doğrula + JWT üret (IAM tamamlanır)
// ======================================================================
router.post("/verify-code", async (req, res) => {
  try {
    const ip = getIP(req);
    const ua = req.headers["user-agent"] || "";

    const rawEmail = safeStr(req.body?.email);
    const email = rawEmail.toLowerCase();
    const rawCode = safeStr(req.body?.code, 20);
    const code = rawCode;

    const sessionId = safeStr(req.body?.sessionId, 200);

    if (!validEmail(email) || !code || !sessionId) {
      return safeJson(res, {
        verified: false,
        message: "Eksik bilgi",
      }, 400);
    }

    // IAM Session doğruluğu
    if (!validateSession(sessionId, ip, ua)) {
      return safeJson(res, {
        verified: false,
        message: "Geçersiz oturum",
        iam: false,
      }, 400);
    }

    const rl = rateLimit(ip, email, 10, 180_000);
    if (!rl.allowed) {
      return safeJson(
        res,
        {
          verified: false,
          throttled: true,
          retryAfterMs: rl.retryMs,
        },
        429
      );
    }

    const record = await VerificationCode.findOne({ email });
    if (!record) {
      return safeJson(res, {
        verified: false,
        message: "Kod bulunamadı",
      }, 400);
    }

    if (record.expires < new Date()) {
      await VerificationCode.deleteOne({ email });
      return safeJson(res, { verified: false, message: "Kodun süresi dolmuş" }, 400);
    }

    if (record.code !== code) {
      return safeJson(res, { verified: false, message: "Kod yanlış" }, 400);
    }

    await VerificationCode.deleteOne({ email });

    // IAM — JWT ver
    const jwtToken = issueJWT(email, sessionId);

    return safeJson(res, {
      verified: true,
      token: jwtToken,
      sessionId,
    });
  } catch (err) {
    return safeJson(
      res,
      { verified: false, message: "Server error" },
      500
    );
  }
});

export default router;
