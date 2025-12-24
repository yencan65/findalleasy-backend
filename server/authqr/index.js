
// server/authqr/index.js
const crypto = require("crypto");

function genToken() {
  return crypto.randomBytes(18).toString("hex"); // ~36 chars
}

/**
 * Registers QR magic login endpoints
 * Collections: qr_tokens { token, userId, createdAt, expiresAt, used }
 */
function registerQrAuthRoutes(app, db){
  const Tokens = db.collection("qr_tokens");

  // Step 1: Create QR login token (user must be logged in on source device)
  app.post("/api/auth/qr/create", async (req, res) => {
    try{
      const { userId } = req.body;
      if(!userId) return res.status(400).json({ok:false, error:"missing userId"});
      const token = genToken();
      const doc = {
        token,
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 2*60*1000), // 2 minutes
        used: false
      };
      await Tokens.insertOne(doc);
      res.json({ok:true, token});
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });

  // Step 2: Poll token state (mobile scans QR -> claims)
  app.get("/api/auth/qr/status/:token", async (req, res) => {
    try{
      const t = await Tokens.findOne({ token: req.params.token });
      if(!t) return res.status(404).json({ok:false, error:"not_found"});
      if(t.expiresAt < new Date()) return res.json({ok:true, status:"expired"});
      res.json({ok:true, status: t.used ? "used" : "pending", userId: t.userId });
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });

  // Step 3: Claim token on target device (mobile/web after scanning QR)
  app.post("/api/auth/qr/claim", async (req, res) => {
    try{
      const { token } = req.body;
      const t = await Tokens.findOne({ token });
      if(!t) return res.status(404).json({ok:false, error:"not_found"});
      if(t.used) return res.status(409).json({ok:false, error:"already_used"});
      if(t.expiresAt < new Date()) return res.status(410).json({ok:false, error:"expired"});
      await Tokens.updateOne({ _id: t._id }, { $set: { used: true, usedAt: new Date() } });
      // return the user identity so frontend can set session
      res.json({ok:true, userId: t.userId});
    }catch(e){ res.status(500).json({ok:false, error:e.message}); }
  });
}

module.exports = { registerQrAuthRoutes };
