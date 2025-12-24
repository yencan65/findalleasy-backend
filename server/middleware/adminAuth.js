// server/middleware/adminAuth.js
import jwt from "jsonwebtoken";

export function requireAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ ok: false, msg: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || decoded.role !== "admin")
      return res.status(403).json({ ok: false, msg: "Not admin" });

    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, msg: "Invalid token" });
  }
}
