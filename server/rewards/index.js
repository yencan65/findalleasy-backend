/**
 * Rewards System for FindAllEasy – Sono AI
 * Additive module: plug into existing Express app WITHOUT deleting current code.
 * Requires: MONGODB connection (db), ENV: MAIL_USER, MAIL_PASS, MAIL_FROM (optional)
 */

const { ObjectId } = require("mongodb");
const cron = require("node-cron");
const nodemailer = require("nodemailer");

function makeMailer() {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    console.warn("[rewards] MAIL_USER/MAIL_PASS not set; email reminders disabled.");
    return null;
  }
  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });
  return { transporter, from };
}

function daysBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Register REST routes
 * @param {Express} app
 * @param {Db} db
 */
const SEASON_DAYS = 90; // 3 ay
function seasonWindow(){ const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate() - (start.getDate()%SEASON_DAYS)); const end = new Date(start); end.setDate(start.getDate()+SEASON_DAYS); return { start, end }; }

function registerRewardRoutes(app, db) {
  const Users = db.collection("users");
  const Rewards = db.collection("rewards");
  const Orders = db.collection("orders");

  const toId = (x) => {
    try { return new ObjectId(x); } catch { return null; }
  };

  // Create or return invite code
  app.post("/api/invite/code", async (req, res) => {
    try {
      const { userId } = req.body || {};
      const _id = toId(userId);
      if (!_id) return res.status(400).json({ error: "userId invalid" });
      const u = await Users.findOne({ _id });
      if (!u) return res.status(404).json({ error: "User not found" });
      if (u.inviteCode) return res.json({ ok: true, inviteCode: u.inviteCode });

      const code = ("SONO" + Math.random().toString(36).substring(2, 8)).toUpperCase();
      await Users.updateOne({ _id }, { $set: { inviteCode: code } });
      res.json({ ok: true, inviteCode: code });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "invite code error" });
    }
  });

  // Apply referral at signup
  app.post("/api/invite/use", async (req, res) => {
    try {
      const { userId, inviteCode } = req.body || {};
      const _id = toId(userId);
      if (!_id || !inviteCode) return res.status(400).json({ error: "invalid payload" });
      const me = await Users.findOne({ _id });
      if (!me) return res.status(404).json({ error: "User not found" });
      if (me.referredBy) return res.json({ ok: true, note: "already referred" });

      const inviter = await Users.findOne({ inviteCode: inviteCode.trim().toUpperCase() });
      if (!inviter || String(inviter._id) === String(_id)) {
        return res.status(400).json({ error: "invalid code" });
      }
      await Users.updateOne({ _id }, { $set: { referredBy: inviteCode.trim().toUpperCase() } });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "invite use error" });
    }
  });

  // Record order + compute rewards
  app.post("/api/rewards/apply", async (req, res) => {
    try {
      const { userId, orderTotal } = req.body || {};
      const _id = toId(userId);
      if (!_id || !orderTotal || orderTotal <= 0) return res.status(400).json({ error: "invalid payload" });

      const user = await Users.findOne({ _id });
      if (!user) return res.status(404).json({ error: "user not found" });

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const hasOrder = await Orders.findOne({ userId: String(_id) });

      await Orders.insertOne({
        userId: String(_id),
        totalAmount: orderTotal,
        commission: orderTotal * 0.05,
        createdAt: now,
      });

      if (!hasOrder) {
        await db.collection("rewards").insertOne({
          userId: String(_id),
          amount: orderTotal * 0.01,
          reason: "İlk alışveriş",
          used: false,
          createdAt: now,
          expiresAt,
        });
      }

      if (user.referredBy) {
        const inviter = await Users.findOne({ inviteCode: user.referredBy });
        if (inviter) {
          const amount = hasOrder ? orderTotal * 0.001 : orderTotal * 0.005;
          await db.collection("rewards").insertOne({
            userId: String(inviter._id),
            amount,
            reason: hasOrder ? "Arkadaş sonraki alışverişi" : "Arkadaş ilk alışveriş",
            used: false,
            createdAt: now,
            expiresAt,
          });
        }
      }

      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "apply error" });
    }
  });

  // Get rewards & near expiry hint
  app.get("/api/rewards/:userId", async (req, res) => {
    try {
      const _id = toId(req.params.userId);
      if (!_id) return res.status(400).json({ error: "invalid userId" });
      const now = new Date();
      const list = await db.collection("rewards").find({ userId: String(_id), used: false }).sort({ createdAt: -1 }).toArray();
      let nearExpiry = false;
      let message = null;
      for (const r of list) {
        const diff = daysBetween(new Date(r.expiresAt), now);
        if (diff === 3) {
          nearExpiry = true;
          message = `🎁 ${Number(r.amount).toFixed(2)}₺ ödülün 3 gün içinde sona eriyor`;
          break;
        }
      }
      res.json({ ok: true, rewards: list, nearExpiry, message });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "fetch error" });
    }
  });
}

/**
 * Start daily cron for reminders and expiry
 * @param {Db} db
 * @param {{transporter, from}|null} mail
 */
function startRewardsCron(db, mail) {
  if (!db) return;
  const Rewards = db.collection("rewards");
  const Users = db.collection("users");

  cron.schedule("10 3 * * *", async () => {
    try {
      const now = new Date();
      const list = await Rewards.find({ used: false }).toArray();
      if (!list.length) return;

      for (const r of list) {
        const exp = new Date(r.expiresAt);
        const diff = Math.floor((exp - now) / (1000 * 60 * 60 * 24));
        if (diff === 3 && mail?.transporter) {
          const user = await Users.findOne({ _id: new ObjectId(r.userId) });
          if (user?.email) {
            await mail.transporter.sendMail({
              from: mail.from,
              to: user.email,
              subject: "🎁 FindAllEasy – Ödülün bitmek üzere!",
              text: `Merhaba ${user.name || ""}, kazandığın ${Number(r.amount).toFixed(2)}₺ ödülünü 3 gün içinde kullanmazsan silinecek. Hemen alışveriş yap!`
            });
          }
        }
        if (diff <= 0) {
          await Rewards.updateOne({ _id: r._id }, { $set: { used: true } });
        }
      }
      console.log("[rewards] cron sweep done");
    } catch (e) {
      console.error("[rewards] cron error", e);
    }
  });
}

module.exports = { registerRewardRoutes, startRewardsCron, makeMailer };
