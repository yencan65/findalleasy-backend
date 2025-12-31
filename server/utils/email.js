// ============================================================================
// FAE EMAIL ENGINE — S110 RELIABLE MAIL PIPE
// Goal: Aktivasyon & Şifre Sıfırlama mailleri "bazen geliyor" seviyesinden
//       "tutarlı" seviyeye çekmek.
//
//  Fixes:
//  - ENV isim karmaşası (EMAIL_* vs SMTP_* vs MAIL_*) → tek noktadan topla
//  - EMAIL_PORT string ise secure yanlış oluyordu ("465" !== 465) → Number()
//  - Önceki sürüm hata yutuyordu (false dönüp route'lar başarılı sanıyordu)
//    → artık retry + en sonda throw (route'lar doğru şekilde hata yakalar)
//  - Pool + timeout ile SMTP stabilitesi artırıldı
// ============================================================================

import nodemailer from "nodemailer";

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

const MAIL_DEBUG = pickEnv("MAIL_DEBUG") === "1";

// Çok isimli ENV desteği (Render'da bazen farklı adla set ediliyor)
const SMTP_USER = pickEnv("EMAIL_USER", "SMTP_USER", "MAIL_USER");
const SMTP_PASS = pickEnv("EMAIL_PASS", "SMTP_PASS", "MAIL_PASS");
const SMTP_HOST = pickEnv("EMAIL_HOST", "SMTP_HOST", "MAIL_HOST") || "smtp.gmail.com";
const SMTP_PORT = Number(pickEnv("EMAIL_PORT", "SMTP_PORT", "MAIL_PORT") || 587);
const SMTP_SECURE =
  pickEnv("EMAIL_SECURE", "SMTP_SECURE", "MAIL_SECURE").toLowerCase() === "true" ||
  pickEnv("EMAIL_SECURE", "SMTP_SECURE", "MAIL_SECURE") === "1" ||
  SMTP_PORT === 465;

const MAIL_FROM_NAME = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME") || "FindAllEasy";
const MAIL_FROM = pickEnv("EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || SMTP_USER;
const MAIL_REPLY_TO = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || "";

// ---------------------------------------------------------------------------
// Transporter — pool + timeouts (stabilite)
// ---------------------------------------------------------------------------
let transporter = null;
let verifiedOnce = false;
let verifyPromise = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!SMTP_USER || !SMTP_PASS) {
    // Bu bir "ayar yok" durumudur; mail gönderimi kesinlikle yapılamaz.
    const e = new Error("MAIL_NOT_CONFIGURED");
    e.code = "MAIL_NOT_CONFIGURED";
    throw e;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },

    // ✅ Stabilite
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 12_000,
    socketTimeout: 25_000,
    greetingTimeout: 12_000,

    // TLS güvenliği
    tls: {
      minVersion: "TLSv1.2",
    },
  });

  return transporter;
}

async function verifyTransporterOnce() {
  if (verifiedOnce) return true;
  if (verifyPromise) return verifyPromise;

  const tx = getTransporter();
  verifyPromise = tx
    .verify()
    .then(() => {
      verifiedOnce = true;
      if (MAIL_DEBUG) {
        console.log("[mail] transporter verified", {
          host: SMTP_HOST,
          port: SMTP_PORT,
          secure: SMTP_SECURE,
          from: MAIL_FROM,
        });
      }
      return true;
    })
    .catch((err) => {
      // verify başarısızsa, sonraki denemede tekrar verify edebilelim
      verifyPromise = null;
      if (MAIL_DEBUG) {
        console.warn("[mail] transporter verify failed", {
          code: err?.code,
          message: err?.message,
        });
      }
      throw err;
    });

  return verifyPromise;
}

function isRetryableError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");

  // Ağ/SMTP dalgalanmaları
  const retryCodes = new Set([
    "ETIMEDOUT",
    "ESOCKET",
    "ECONNRESET",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "EADDRINUSE",
  ]);

  if (retryCodes.has(code)) return true;
  if (/timeout/i.test(msg)) return true;
  if (/socket/i.test(msg)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// SAFE SEND — Retry + Throw (hata yutma yok)
// ---------------------------------------------------------------------------
async function safeSend(mailOptions, { attempts = 3 } = {}) {
  const tx = getTransporter();

  // İlk denemede verify (ayar gerçekten düzgün mü?)
  await verifyTransporterOnce();

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const info = await tx.sendMail(mailOptions);
      if (MAIL_DEBUG) {
        console.log("[mail] sent", {
          messageId: info?.messageId,
          to: mailOptions?.to,
          subject: mailOptions?.subject,
        });
      }
      return info;
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableError(err);

      console.error("[mail] send failed", {
        attempt: i + 1,
        attempts,
        retryable,
        code: err?.code,
        message: err?.message,
        response: err?.response,
      });

      // Retry edilebilecek hataysa backoff ile tekrar dene
      if (retryable && i < attempts - 1) {
        await sleep(500 * Math.pow(2, i)); // 0.5s, 1s, 2s
        continue;
      }

      // verify bir kere başarısız olduysa, sonraki request'te tekrar verify edebilelim
      verifiedOnce = false;
      verifyPromise = null;
      throw err;
    }
  }

  // teorik olarak buraya düşmez ama garanti olsun
  throw lastErr || new Error("MAIL_SEND_FAILED");
}

// ---------------------------------------------------------------------------
// Genel gönderim fonksiyonu
// ---------------------------------------------------------------------------
export async function sendEmail(to, subject, text, html = null) {
  const fromAddress = MAIL_FROM || SMTP_USER;
  const subj = String(subject || "");
  const safeText = String(text || "");

  const mailOptions = {
    from: {
      name: MAIL_FROM_NAME,
      address: fromAddress,
    },
    to,
    subject: subj,
    text: safeText,
    html: html || `<p>${safeText}</p>`,
    headers: {
      "X-FindAllEasy": "mailer-s110",
    },
  };

  if (MAIL_REPLY_TO) mailOptions.replyTo = MAIL_REPLY_TO;

  return safeSend(mailOptions, { attempts: 3 });
}

// ---------------------------------------------------------------------------
// Aktivasyon
// ---------------------------------------------------------------------------
export async function sendActivationEmail(to, code, username = "") {
  const subject = "FindAllEasy Hesap Aktivasyonu";
  const uname = String(username || "").trim();

  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2 style="margin:0 0 8px 0;">FindAllEasy</h2>
      ${uname ? `<p style="margin:0 0 8px 0;">Merhaba <b>${uname}</b>,</p>` : ""}
      <p style="margin:0 0 8px 0;">Hesabınızı aktifleştirmek için aşağıdaki kodu kullanın:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0; letter-spacing:2px;">
        ${code}
      </div>
      <p style="color:#888; font-size:12px; margin-top:10px;">Bu kodu siz istemediyseniz bu e-postayı yok sayabilirsiniz.</p>
    </div>
  `;

  return sendEmail(to, subject, `Aktivasyon kodunuz: ${code}`, html);
}

// ---------------------------------------------------------------------------
// Şifre sıfırlama
// ---------------------------------------------------------------------------
export async function sendPasswordResetCode(to, code, username = "") {
  const subject = "FindAllEasy Şifre Sıfırlama";
  const uname = String(username || "").trim();

  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2 style="margin:0 0 8px 0;">FindAllEasy</h2>
      ${uname ? `<p style="margin:0 0 8px 0;">Merhaba <b>${uname}</b>,</p>` : ""}
      <p style="margin:0 0 8px 0;">Şifrenizi sıfırlamak için aşağıdaki kodu kullanın:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0; letter-spacing:2px;">
        ${code}
      </div>
      <p style="color:#888; font-size:12px; margin-top:10px;">Bu kodu siz istemediyseniz hesabınız güvende olabilir; yine de şifrenizi değiştirmeyi düşünebilirsiniz.</p>
    </div>
  `;

  return sendEmail(to, subject, `Şifre sıfırlama kodunuz: ${code}`, html);
}
