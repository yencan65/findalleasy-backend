
// server/referrals/index.js
// Additive referral & coupon routes (CommonJS to avoid ESM conflicts)
const { ObjectId } = require("mongodb");
const crypto = require("crypto");
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

function genCode(len=8){
  return crypto.randomBytes(Math.ceil(len/2)).toString("hex").slice(0,len).toUpperCase();
}

/**
 * Registers referral & coupon REST routes.
 * Assumes app.locals.db (native) OR Mongoose connection.
 * Prefer native driver via app.locals.mongoDb if available.
 */

// ---- Security middlewares ----
const limiterReferral = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false });
const limiterCoupon   = rateLimit({ windowMs: 15*60*1000, max: 50,  standardHeaders: true, legacyHeaders: false });

async function verifyCaptcha(token, provider='turnstile'){
  try{
    if(!token) return false;
    if(provider==='turnstile'){
      const secret = process.env.TURNSTILE_SECRET;
      if(!secret) return true; // if not set, don't block dev
      const fd = new URLSearchParams(); fd.append('secret', secret); fd.append('response', token);
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST', body:fd});
      const j = await r.json(); return !!j.success;
    }else{
      const secret = process.env.HCAPTCHA_SECRET;
      if(!secret) return true;
      const fd = new URLSearchParams(); fd.append('secret', secret); fd.append('response', token);
      const r = await fetch('https://hcaptcha.com/siteverify',{method:'POST', body:fd});
      const j = await r.json(); return !!j.success;
    }
  }catch(e){ return false; }
}

function captchaRequired(req,res,next){
  const token = req.headers['x-captcha'] || (req.body && (req.body.captcha||req.body.token));
  verifyCaptcha(token, process.env.CAPTCHA_PROVIDER||'turnstile').then(ok => {
    if(!ok) return res.status(403).json({ok:false, error:'captcha_failed'});
    next();
  });
}

function registerReferralRoutes(app, db){
  const Users = db.collection("users");
  const Coupons = db.collection("coupons");
  const Referrals = db.collection("referrals");

  // Ensure indexes (idempotent)
  Users.createIndex({ referralCode: 1 }, { unique: false }).catch(()=>{});
  Referrals.createIndex({ referrerId: 1 });
  Coupons.createIndex({ code: 1 }, { unique: true });

  // Get or create referral code for current user
  app.post("/api/referral/invite", limiterReferral, captchaRequired, async (req, res) => {
    try{
      const userId = req.body.userId;
      if(!userId) return res.status(400).json({ok:false, error:"missing userId"});
      const u = await Users.findOne({ id: userId });
      if(!u) return res.status(404).json({ok:false, error:"user not found"});
      let code = u.referralCode;
      if(!code){
        code = genCode(8);
        await Users.updateOne({ id: userId }, { $set: { referralCode: code } });
      }
      // Return a universal deep link; frontend will append ?ref=CODE to current origin
      res.json({ok:true, code});
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });

  // Referral attach on signup (called by auth flow once)
  app.post("/api/referral/attach", limiterReferral, captchaRequired, async (req,res) => {
    try{
      const { newUserId, ref } = req.body;
      if(!newUserId || !ref) return res.status(400).json({ok:false, error:"missing params"});
      const inviter = await Users.findOne({ referralCode: ref });
      const newbie  = await Users.findOne({ id: newUserId });
      if(!inviter || !newbie) return res.status(404).json({ok:false});
      if(newbie.referredBy) return res.json({ok:true, already:true});

      await Users.updateOne({ id: newUserId }, { $set: { referredBy: inviter.id } });
      await Referrals.insertOne({ referrerId: inviter.id, refereeId: newbie.id, createdAt: new Date() });
      res.json({ok:true});
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });

  // Referral tree for a user (flat for now)
  app.get("/api/referral/tree/:userId", async (req,res) => {
    try{
      const { userId } = req.params;
      const invited = await Referrals.find({ referrerId: userId }).toArray();
      // return minimal info
      const ids = invited.map(r => r.refereeId);
      const users = ids.length ? await Users.find({ id: { $in: ids } }).project({ id:1, email:1, name:1, totalSpent:1 }).toArray() : [];
      res.json({ok:true, invited: users });
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });

  // Create a single-use coupon that reduces platform commission equal to reward usage
    // Create a single-use coupon that reduces platform commission equal to reward usage
  app.post("/api/coupons/create", limiterCoupon, captchaRequired, async (req,res) => {
    try{
      const { userId, amount } = req.body; // amount in TL (commission-offset)
      const numericAmount = Number(amount);
      if(!userId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ok:false, error:"missing_or_invalid_params"});
      }
      const code = "FAE-" + genCode(6);
      const doc = {
        code,
        userId,
        amount: numericAmount,
        used: false,
        createdAt: new Date(),
        expiresAt: new Date(Date.now()+30*24*3600*1000)
      };
      await Coupons.insertOne(doc);
      res.json({ok:true, code, expiresAt: doc.expiresAt});
    }catch(e){
      res.status(500).json({ok:false, error:e.message});
    }
  });

  // Validate/redeem coupon (affiliate panel should call after order)
  app.post("/api/coupons/redeem", limiterCoupon, captchaRequired, async (req,res) => {
    try{
      const { code, orderId } = req.body;
      const c = await Coupons.findOne({ code });
      if(!c) return res.status(404).json({ok:false, error:"not found"});
      if(c.used) return res.status(409).json({ok:false, error:"already used"});
      if(c.expiresAt && c.expiresAt < new Date()) return res.status(410).json({ok:false, error:"expired"});
      await Coupons.updateOne({ _id: c._id }, { $set: { used:true, orderId } });
      // Optional: record on user wallet as deduction
      res.json({ok:true});
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });
}


  // Deep tree (multiple levels) via BFS
  app.get("/api/referral/tree/deep/:userId", async (req,res) => {
    try{
      const rootId = req.params.userId;
      const invited = await Referrals.find({ referrerId: rootId }).toArray();
      const queue = invited.map(r => r.refereeId);
      const nodes = {}; // id -> node
      // seed root
      const rootUser = await Users.findOne({ id: rootId });
      nodes[rootId] = { id: rootId, name: (rootUser && rootUser.name)||null, email: (rootUser && rootUser.email)||null, totalSpent: (rootUser && rootUser.totalSpent)||0, children: [] };
      while(queue.length){
        const id = queue.shift();
        const u = await Users.findOne({ id });
        nodes[id] = nodes[id] || { id, children: [] };
        Object.assign(nodes[id], { name: (u&&u.name)||null, email: (u&&u.email)||null, totalSpent: (u&&u.totalSpent)||0, children: nodes[id].children||[] });
        // parent link: who invited this user?
        const parentRel = await Referrals.findOne({ refereeId: id });
        if(parentRel){
          const pid = parentRel.referrerId;
          nodes[pid] = nodes[pid] || { id: pid, children: [] };
          nodes[pid].children.push(nodes[id]);
        }
        // children of this id
        const kids = await Referrals.find({ referrerId: id }).toArray();
        kids.forEach(k => queue.push(k.refereeId));
      }
      const firstLevelUsers = invited.length ? await Users.find({ id: { $in: invited.map(r=>r.refereeId) } }).project({ id:1, email:1, name:1, totalSpent:1 }).toArray() : [];
      res.json({ok:true, invited: firstLevelUsers, tree: nodes[rootId]});
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });

module.exports = { registerReferralRoutes };
