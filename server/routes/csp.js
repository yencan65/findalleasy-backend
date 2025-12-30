import express from "express";
const r = express.Router();

r.post(
  "/report",
  express.json({ type: ["application/csp-report", "application/json"], limit: "64kb" }),
  (req, res) => {
    const payload = req.body?.["csp-report"] ?? req.body ?? {};
    console.log("[CSP-REPORT]", JSON.stringify({
      ts: Date.now(),
      ua: req.get("user-agent"),
      ref: req.get("referer"),
      ip: req.ip,
      payload,
    }));
    return res.status(204).end();
  }
);

export default r;
