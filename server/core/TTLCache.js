// server/adapters/core/ProxyRotator.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBlockedStatus(status) {
  return status === 403 || status === 429;
}

export class ProxyRotator {
  constructor({
    proxyFile = path.join(__dirname, "../config/proxy-list.json"),
    cooldownMs = 10 * 60 * 1000, // 10 dk
    enabledEnv = "FINDALLEASY_PROXY_ENABLED",
  } = {}) {
    this.proxyFile = proxyFile;
    this.cooldownMs = cooldownMs;
    this.enabledEnv = enabledEnv;

    this._idx = 0;
    this._badUntil = new Map(); // key => ts
    this._proxies = this._loadProxies();
  }

  isEnabled() {
    const v = String(process.env[this.enabledEnv] ?? "").trim();
    if (!v) return false;
    return v === "1" || v.toLowerCase() === "true";
  }

  _loadProxies() {
    // 1) ENV JSON
    const envJson = process.env.FINDALLEASY_PROXY_LIST_JSON;
    if (envJson) {
      const parsed = safeJsonParse(envJson);
      if (Array.isArray(parsed)) return parsed;
      if (parsed?.proxies && Array.isArray(parsed.proxies)) return parsed.proxies;
    }

    // 2) file
    try {
      if (fs.existsSync(this.proxyFile)) {
        const raw = fs.readFileSync(this.proxyFile, "utf-8");
        const parsed = safeJsonParse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (parsed?.proxies && Array.isArray(parsed.proxies)) return parsed.proxies;
      }
    } catch {
      // sessiz
    }
    return [];
  }

  reload() {
    this._proxies = this._loadProxies();
  }

  _proxyKey(p) {
    const base = `${p?.protocol ?? "http"}://${p?.host}:${p?.port}:${p?.username ?? ""}`;
    return crypto.createHash("sha1").update(base).digest("hex");
  }

  markBad(proxy, reason = "bad") {
    if (!proxy) return;
    const key = this._proxyKey(proxy);
    this._badUntil.set(key, Date.now() + this.cooldownMs);
    // reason log’u network layer basacak
  }

  _isGood(proxy) {
    const key = this._proxyKey(proxy);
    const until = this._badUntil.get(key);
    if (!until) return true;
    if (Date.now() > until) {
      this._badUntil.delete(key);
      return true;
    }
    return false;
  }

  pick() {
    if (!this.isEnabled()) return null;
    if (!this._proxies.length) return null;

    // round-robin + bad skip
    for (let i = 0; i < this._proxies.length; i++) {
      const p = this._proxies[this._idx % this._proxies.length];
      this._idx++;
      if (this._isGood(p)) return p;
    }

    // hepsi bad ise “reset” yapma; cooldown bitene kadar null (direct) dön
    return null;
  }

  toAgent(proxy) {
    if (!proxy) return null;
    const protocol = proxy.protocol ?? "http";
    const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? "")}@` : "";
    const url = `${protocol}://${auth}${proxy.host}:${proxy.port}`;
    return new HttpsProxyAgent(url);
  }

  static classifyAxiosError(err) {
    const status = err?.response?.status;
    const code = err?.code;

    if (status) {
      if (isBlockedStatus(status)) return { type: "BLOCKED", status };
      if (status === 404) return { type: "NOT_FOUND", status };
      if (status >= 500) return { type: "UPSTREAM_5XX", status };
      if (status >= 400) return { type: "UPSTREAM_4XX", status };
    }

    if (code === "ECONNABORTED") return { type: "TIMEOUT" };
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { type: "DNS" };
    if (code === "ECONNRESET" || code === "ETIMEDOUT") return { type: "NET" };

    const msg = String(err?.message ?? "");
    if (msg.toLowerCase().includes("timeout")) return { type: "TIMEOUT" };

    return { type: "UNKNOWN" };
  }

  async backoff(attempt) {
    // jitter’lı exponential
    const base = Math.min(5000, 400 * Math.pow(2, attempt - 1));
    const jitter = Math.floor(Math.random() * 200);
    await sleep(base + jitter);
  }
}

export default new ProxyRotator();
