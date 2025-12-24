// ============================================================================
// FAE EMAIL ENGINE — S100 ULTRA
// Güvenli + Retry + UTF-8 + HTML/TXT uyumlu
// ============================================================================

import nodemailer from "nodemailer";

const {
  EMAIL_USER,
  EMAIL_PASS,
  EMAIL_HOST = "smtp.gmail.com",
  EMAIL_PORT = 587,
} = process.env;

// ENV kontrolü
if (!EMAIL_USER || !EMAIL_PASS) {
  console.warn("⚠️ EMAIL_USER veya EMAIL_PASS tanımlı değil. E-mail gönderilemez.");
}

// ---------------------------------------------------------------------------
// Transporter — TLS SAFE
// ---------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: EMAIL_PORT,
  secure: EMAIL_PORT === 465, // SSL ise secure:true, 587 ise true olması gerekmez
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
  tls: {
    // Artık rejectUnauthorized:false kullanmıyoruz (çok tehlikeli)
    minVersion: "TLSv1.2",
  },
});

// ---------------------------------------------------------------------------
// SAFE SEND — Retry + Error Type Detection
// ---------------------------------------------------------------------------
async function safeSend(mailOptions, retry = 1) {
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("📧 Mail gönderildi:", info.messageId);
    return true;
  } catch (err) {
    console.error("❌ sendEmail ERROR:", err.code, err.response || "");

    // Gmail rate-limit / timeout / connection reset → retry
    if (
      retry > 0 &&
      ["ETIMEDOUT", "ECONNRESET", "EAUTH", "EENVELOPE", "EADDRINUSE"].includes(
        err.code
      )
    ) {
      console.warn("🔁 Retry e-mail...");
      await new Promise((res) => setTimeout(res, 800));
      return safeSend(mailOptions, retry - 1);
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// Genel gönderim fonksiyonu
// ---------------------------------------------------------------------------
export async function sendEmail(to, subject, text, html = null) {
  const mailOptions = {
    from: {
      name: "FindAllEasy",
      address: EMAIL_USER,
    },
    to,
    subject: `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    text: text || "",
    html: html || `<p>${text}</p>`,
  };

  return safeSend(mailOptions, 1);
}

// ---------------------------------------------------------------------------
// Aktivasyon
// ---------------------------------------------------------------------------
export async function sendActivationEmail(to, code) {
  const subject = "FindAllEasy Hesap Aktivasyonu";

  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      <p>Hesabınızı aktifleştirmek için aşağıdaki kodu kullanın:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">
        ${code}
      </div>
    </div>
  `;

  return sendEmail(to, subject, `Aktivasyon kodunuz: ${code}`, html);
}

// ---------------------------------------------------------------------------
// Şifre sıfırlama
// ---------------------------------------------------------------------------
export async function sendPasswordResetCode(to, code) {
  const subject = "FindAllEasy Şifre Sıfırlama";

  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      <p>Şifre sıfırlamak için gerekli kod:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">
        ${code}
      </div>
    </div>
  `;

  return sendEmail(to, subject, `Şifre sıfırlama kodunuz: ${code}`, html);
}
