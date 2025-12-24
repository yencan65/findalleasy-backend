import { Router } from 'express';

const r = Router();

// ======================================================
// KUPO SU MOTORU — H E R K Ü L   S T A B I L E   S U R U M
// ======================================================
r.post("/apply", (req, res) => {
  try {
    const body = req.body || {};

    const cart = Number(body.cartTotal);
    const comm = Number(body.commission);
    const coupon = body.coupon;

    const safeCart = Number.isFinite(cart) ? cart : 0;
    const safeComm = Number.isFinite(comm) ? comm : 0;

    // Kupon yok → hiçbir şey uygulanmaz
    if (!coupon) {
      return res.json({
        applied: false,
        discount: 0,
        finalTotal: safeCart,
        reason: "no_coupon",
      });
    }

    // Komisyon yoksa kupon yasağı
    if (safeComm <= 0) {
      return res.json({
        applied: false,
        discount: 0,
        finalTotal: safeCart,
        reason: "no_commission",
      });
    }

    // Gerçek indirim hesaplaması
    const rawDiscount = safeCart * 0.05;
    const maxByCommission = safeComm * 0.5;

    const discount = Math.min(rawDiscount, maxByCommission);

    return res.json({
      applied: discount > 0,
      discount,
      finalTotal: Math.max(0, safeCart - discount),
      reason: discount > 0 ? "ok" : "no_discount",
    });
  } catch (err) {
    return res.status(500).json({
      applied: false,
      discount: 0,
      finalTotal: 0,
      reason: "server_error",
      error: err?.message || String(err),
    });
  }
});

export default r;
