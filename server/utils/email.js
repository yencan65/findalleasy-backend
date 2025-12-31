// ============================================================================
// FAE EMAIL ENGINE — S114 RELIABLE (ENV CHAOS PROOF)
// Goal: Aktivasyon / Şifre sıfırlama mailleri "bazen geliyor" değil, tutarlı.
//
// Fixes:
//  - Render ENV'te EMAIL_* / SMTP_* / MAIL_* karışmış olabiliyor → profil seçimi
//  - Port string gelince secure hatası ("465" !== 465) → Number()
//  - Gmail'de FROM adresi user ile uyuşmazsa EENVELOPE/550 → Gmail'de from=user
//  - Stabilite: pool + timeout + retry + net hata logu (ops için)
//
// ZERO-DELETE: Export imzaları korunur: sendEmail, sendActivationEmail, sendPasswordResetCode
// ============================================================================

import nodemailer from "nodemailer";

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function boolish(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const MAIL_DEBUG = pickEnv("MAIL_DEBUG") === "1";
// Bazı SMTP'ler verify() çağrısını sevmez. Default: kapalı.
const MAIL_VERIFY = pickEnv("MAIL_VERIFY") === "1";

// ---------------------------------------------------------------------------
// Profiles: EMAIL_* / SMTP_* / MAIL_* (karışık env'e dayanıklı)
// ---------------------------------------------------------------------------
function buildProfile(prefix) {
  const user =
    prefix === "EMAIL"
      ? pickEnv("EMAIL_USER")
      : prefix === "SMTP"
      ? pickEnv("SMTP_USER")
      : pickEnv("MAIL_USER");

  const pass =
    prefix === "EMAIL"
      ? pickEnv("EMAIL_PASS")
      : prefix === "SMTP"
      ? pickEnv("SMTP_PASS")
      : pickEnv("MAIL_PASS");

  if (!user || !pass) return null;

  const host =
    (prefix === "EMAIL"
      ? pickEnv("EMAIL_HOST")
      : prefix === "SMTP"
      ? pickEnv("SMTP_HOST")
      : pickEnv("MAIL_HOST")) || "smtp.gmail.com";

  const port = Number(
    (prefix === "EMAIL"
      ? pickEnv("EMAIL_PORT")
      : prefix === "SMTP"
      ? pickEnv("SMTP_PORT")
      : pickEnv("MAIL_PORT")) || 587
  );

  const secure =
    boolish(
      prefix === "EMAIL"
        ? pickEnv("EMAIL_SECURE")
        : prefix === "SMTP"
        ? pickEnv("SMTP_SECURE")
        : pickEnv("MAIL_SECURE")
    ) || port === 465;

  const fromName = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
  let from = pickEnv("FROM_EMAIL", "EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;
  const replyTo = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO", "REPLY_TO") || "";

  // Gmail SMTP: envelope/from farklı olunca patlar. Gmail ise from=user yap.
  if (String(host).toLowerCase().includes("gmail")) {
    from = user;
  }

  return { prefix, user, pass, host, port, secure, from, fromName, replyTo };
}

const profileEmail = buildProfile("EMAIL");
const profileSmtp = buildProfile("SMTP");
const profileMail = buildProfile("MAIL");

// Manuel seçim (Render env karmaşasında en sağlam yol)
// MAIL_PROFILE=EMAIL | SMTP | MAIL
const forcedProfile = pickEnv("MAIL_PROFILE").toUpperCase();
const candidatesByName = {
  EMAIL: profileEmail,
  SMTP: profileSmtp,
  MAIL: profileMail,
};

// Default: EMAIL > SMTP > MAIL (senin env ekranında hepsi var; EMAIL daha deterministik)
const profiles = [
  forcedProfile && candidatesByName[forcedProfile] ? candidatesByName[forcedProfile] : null,
  !forcedProfile ? profileEmail : null,
  !forcedProfile ? profileSmtp : null,
  !forcedProfile ? profileMail : null,
].filter(Boolean);

if (profiles.length === 0) {
  // Fail fast: env yok → route'lar net hata döndürsün
  throw new Error(
    "MAIL_NOT_CONFIGURED: set EMAIL_USER/EMAIL_PASS (recommended) or SMTP_USER/SMTP_PASS or MAIL_USER/MAIL_PASS"
  );
}

// ---------------------------------------------------------------------------
// Transporter cache
// ---------------------------------------------------------------------------
let activeIdx = 0;
let transporter = null;
let verifiedOnce = false;
let verifyPromise = null;

function createTransporter(p) {
  return nodemailer.createTransport({
    host: p.host,
    port: p.port,
    secure: p.secure,
    auth: { user: p.user, pass: p.pass },

    // Stabilite
    pool: true,
    maxConnections: 3,
    maxMessages: 200,
    connectionTimeout: 12_000,
    socketTimeout: 25_000,

    tls: { minVersion: "TLSv1.2" },

    logger: MAIL_DEBUG,
    debug: MAIL_DEBUG,
  });
}

function useProfile(idx) {
  activeIdx = idx;
  transporter = createTransporter(profiles[activeIdx]);
  verifiedOnce = false;
  verifyPromise = null;

  if (MAIL_DEBUG) {
    const p = profiles[activeIdx];
    console.log("[mail] using profile", {
      prefix: p.prefix,
      host: p.host,
      port: p.port,
      secure: p.secure,
      user: p.user,
      from: p.from,
    });
  }
}

useProfile(0);

async function verifyTransporterOnce() {
  if (verifiedOnce) return true;
  if (verifyPromise) return verifyPromise;

  verifyPromise = transporter
    .verify()
    .then(() => {
      verifiedOnce = true;
      return true;
    })
    .catch((e) => {
      if (MAIL_DEBUG) console.error("[mail] verify failed", e?.code, e?.message || e);
      throw e;
    });

  return verifyPromise;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransient(err) {
  return ["ETIMEDOUT", "ECONNRESET", "ESOCKET", "EADDRINUSE"].includes(err?.code);
}

function isAuthOrEnvelope(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "");
  if (code === "EAUTH" || code === "EENVELOPE") return true;
  if (msg.includes("535") || msg.toLowerCase().includes("username and password")) return true;
  return false;
}

async function sendMailCore({ to, subject, text, html }, { attempts = 3 } = {}) {
  const makeOptions = (p) => ({
    from: { name: p.fromName, address: p.from },
    to,
    subject,
    text: text || "",
    html: html || (text ? `<p>${text}</p>` : undefined),
    ...(p.replyTo ? { replyTo: p.replyTo } : {}),
  });

  let lastErr = null;

  for (let pi = 0; pi < profiles.length; pi++) {
    if (pi !== activeIdx) useProfile(pi);
    const p = profiles[activeIdx];
    const mailOptions = makeOptions(p);

    if (MAIL_VERIFY) {
      await verifyTransporterOnce();
    }

    for (let i = 0; i < attempts; i++) {
      try {
        const info = await transporter.sendMail(mailOptions);
        if (MAIL_DEBUG) {
          console.log("[mail] sent", { prefix: p.prefix, to, messageId: info?.messageId });
        }
        return info;
      } catch (e) {
        lastErr = e;

        if (MAIL_DEBUG) {
          console.error("[mail] send failed", {
            prefix: p.prefix,
            code: e?.code,
            message: e?.message,
            response: e?.response,
          });
        }

        // auth/envelope → diğer profile'a geç
        if (isAuthOrEnvelope(e)) break;

        // transient → retry
        if (isTransient(e) && i < attempts - 1) {
          await sleep(400 * Math.pow(2, i));
          continue;
        }

        // başka hata → retry yok
        break;
      }
    }
  }

  throw lastErr || new Error("MAIL_SEND_FAILED");
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export async function sendEmail(to, subject, text, html = null) {
  // UTF-8 subject safe (base64)
  const safeSubject = `=?UTF-8?B?${Buffer.from(String(subject || "")).toString("base64")}?=`;
  return sendMailCore({ to, subject: safeSubject, text, html }, { attempts: 3 });
}

export async function sendActivationEmail(to, code, username = "") {
  const subject = "FindAllEasy Hesap Aktivasyonu";
  const hello = username ? `<p>Merhaba <b>${username}</b>,</p>` : "";
  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      ${hello}
      <p>Hesabınızı aktifleştirmek için aşağıdaki kodu kullanın:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">${code}</div>
      <p style="color:#666;font-size:12px;">Bu kod 24 saat geçerlidir.</p>
    </div>
  `;
  return sendEmail(to, subject, `Aktivasyon kodunuz: ${code}`, html);
}

export async function sendPasswordResetCode(to, code, username = "") {
  const subject = "FindAllEasy Şifre Sıfırlama";
  const hello = username ? `<p>Merhaba <b>${username}</b>,</p>` : "";
  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      ${hello}
      <p>Şifre sıfırlamak için gerekli kod:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">${code}</div>
      <p style="color:#666;font-size:12px;">Eğer bu isteği siz yapmadıysanız, bu e-postayı yok sayın.</p>
    </div>
  `;
  return sendEmail(to, subject, `Şifre sıfırlama kodunuz: ${code}`, html);
}
