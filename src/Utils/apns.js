// src/Utils/apns.js
const fs = require("fs");
const http2 = require("http2");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// ---------- Mongoose model ----------
const DeviceSchema = new mongoose.Schema({
  email: { type: String, index: true },
  token: { type: String, unique: true },
  environment: { type: String, enum: ["sandbox", "prod"], required: true },
  bundleId: { type: String, default: process.env.APP_BUNDLE_ID || "com.barak.wordzap" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
DeviceSchema.index({ email: 1, environment: 1 });
const Device = mongoose.models.Device || mongoose.model("Device", DeviceSchema);

// ---------- Env ----------
const APNS_TEAM_ID   = process.env.APPLE_TEAM_ID;
const APNS_KEY_ID    = process.env.APPLE_KEY_ID;
const APNS_P8_PATH   = process.env.APPLE_P8_PATH;
const DEFAULT_TOPIC  = process.env.APP_BUNDLE_ID || "com.barak.wordzap";
const PUSH_API_KEY   = process.env.PUSH_API_KEY || "dev-local-key";

// ---------- Helpers ----------
function apnsEnvIsConfigured() {
  return !!(APNS_TEAM_ID && APNS_KEY_ID && APNS_P8_PATH && fs.existsSync(APNS_P8_PATH));
}
function hostFor(env) {
  return env === "prod" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
}
function makeApnsJwt() {
  const privateKey = fs.readFileSync(APNS_P8_PATH, "utf8");
  return jwt.sign(
    { iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) },
    privateKey,
    { algorithm: "ES256", header: { alg: "ES256", kid: APNS_KEY_ID } }
  );
}

/** Send a silent push to one device */
async function sendSilentPush({ token, environment, payload = {}, topic = DEFAULT_TOPIC }) {
  const client = http2.connect(`https://${hostFor(environment)}`);
  const headers = {
    ":method": "POST",
    ":path": `/3/device/${token}`,
    authorization: `bearer ${makeApnsJwt()}`,
    "apns-topic": topic,
    "apns-push-type": "background",
    "apns-priority": "5",
  };
  const body = JSON.stringify({
    aps: { "content-available": 1 },
    type: payload.type || "wordzap.refresh",
    args: payload.args || undefined,
  });

  return new Promise((resolve, reject) => {
    let status = 0, text = "";
    const req = client.request(headers);
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.setEncoding("utf8");
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      client.close();
      const ok = status >= 200 && status < 300;
      let reason;
      try { reason = text ? JSON.parse(text).reason : undefined; } catch {}
      resolve({ ok, status, reason, body: text || "OK" });
    });
    req.on("error", (err) => { client.close(); reject(err); });
    req.write(body);
    req.end();
  });
}

/** Send to every stored device for one email */
async function sendSilentPushToUser(email, payload = {}) {
  const devices = await Device.find({ email }).lean();
  const results = [];
  for (const d of devices) {
    try {
      const r = await sendSilentPush({
        token: d.token,
        environment: d.environment,
        payload,
        topic: d.bundleId || DEFAULT_TOPIC,
      });
      if (!r.ok && (r.reason === "BadDeviceToken" || r.reason === "Unregistered")) {
        await Device.deleteOne({ token: d.token }).catch(() => {});
      }
      results.push({ token: d.token, env: d.environment, ...r });
    } catch (e) {
      results.push({ token: d.token, env: d.environment, ok: false, error: String(e) });
    }
  }
  return results;
}

/** Utility: chunk an array */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Broadcast to ALL devices (both environments).
 * Options:
 *  - filterEnv: "sandbox"|"prod"|undefined    (optional filter)
 *  - batchSize: number (default 100)
 *  - concurrency: number of parallel requests per batch (default 10)
 */
async function sendSilentPushToAllUsers(payload = {}, { filterEnv, batchSize = 100, concurrency = 10 } = {}) {
  const query = filterEnv ? { environment: filterEnv } : {};
  const cursor = Device.find(query).lean().cursor();

  let total = 0, sent = 0, failed = 0, cleaned = 0;
  const summary = [];

  // Process in batches to avoid exploding memory
  let batch = [];
  for await (const d of cursor) {
    batch.push(d);
    if (batch.length >= batchSize) {
      const res = await sendBatch(batch, payload, concurrency);
      total += res.total; sent += res.sent; failed += res.failed; cleaned += res.cleaned;
      summary.push(...res.items);
      batch = [];
    }
  }
  if (batch.length) {
    const res = await sendBatch(batch, payload, concurrency);
    total += res.total; sent += res.sent; failed += res.failed; cleaned += res.cleaned;
    summary.push(...res.items);
  }

  return { total, sent, failed, cleaned, results: summary };
}

async function sendBatch(devices, payload, concurrency) {
  const items = devices.map(d => ({
    token: d.token, environment: d.environment, topic: d.bundleId || DEFAULT_TOPIC
  }));
  let sent = 0, failed = 0, cleaned = 0;

  // Concurrency control
  const groups = chunk(items, concurrency);
  const out = [];
  for (const g of groups) {
    const promises = g.map(async (i) => {
      try {
        const r = await sendSilentPush({
          token: i.token,
          environment: i.environment,
          payload,
          topic: i.topic,
        });
        if (r.ok) sent++; else failed++;
        if (!r.ok && (r.reason === "BadDeviceToken" || r.reason === "Unregistered")) {
          await Device.deleteOne({ token: i.token }).catch(() => {});
          cleaned++;
        }
        return { ...i, ...r };
      } catch (e) {
        failed++;
        return { ...i, ok: false, error: String(e) };
      }
    });
    const res = await Promise.all(promises);
    out.push(...res);
  }

  return { total: items.length, sent, failed, cleaned, items: out };
}

// ---------- Routes ----------
function bindApnsRoutes(app) {
  if (!apnsEnvIsConfigured()) {
    console.warn("[APNs] Missing env configuration — silent pushes will fail until you set APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_P8_PATH / APP_BUNDLE_ID.");
  }

  // Register/update a device
  // POST /device/register { email, token, environment: "sandbox"|"prod", bundleId? }
  app.post("/device/register", async (req, res) => {
    try {
      const { email, token, environment, bundleId } = req.body || {};
      if (!email || !token || !environment) {
        return res.status(400).json({ error: "missing email|token|environment" });
      }
      const now = new Date();
      await Device.updateOne(
        { token },
        {
          $set: {
            email, token, environment,
            bundleId: bundleId || DEFAULT_TOPIC,
            updatedAt: now
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "register_failed", detail: String(e) });
    }
  });

  // Send to a single token
  // POST /push/silent { token, environment, type?, args? }
  app.post("/push/silent", async (req, res) => {
    try {
      if (req.get("X-API-Key") !== PUSH_API_KEY) return res.status(401).json({ error: "unauthorized" });
      const { token, environment, type, args } = req.body || {};
      if (!token || !environment) return res.status(400).json({ error: "missing token|environment" });
      const r = await sendSilentPush({ token, environment, payload: { type, args } });
      if (!r.ok && (r.reason === "BadDeviceToken" || r.reason === "Unregistered")) {
        await Device.deleteOne({ token }).catch(() => {});
      }
      return res.json({ status: r.ok ? "sent" : "failed", apns: r });
    } catch (err) {
      console.error("APNs error:", err);
      return res.status(500).json({ error: "apns_failed", detail: String(err) });
    }
  });

  // Send to all devices for one user
  // POST /push/user { email, type?, args? }
  app.post("/push/user", async (req, res) => {
    try {
      if (req.get("X-API-Key") !== PUSH_API_KEY) return res.status(401).json({ error: "unauthorized" });
      const { email, type, args } = req.body || {};
      if (!email) return res.status(400).json({ error: "missing email" });
      const results = await sendSilentPushToUser(email, { type, args });
      return res.json({ status: "done", count: results.length, results });
    } catch (err) {
      console.error("APNs error:", err);
      return res.status(500).json({ error: "apns_failed", detail: String(err) });
    }
  });

  // 🔥 Broadcast to all users (be careful!)
  // POST /push/broadcast { type?, args?, filterEnv?: "sandbox"|"prod", batchSize?, concurrency? }
  app.post("/push/broadcast", async (req, res) => {
    try {
      if (req.get("X-API-Key") !== PUSH_API_KEY) return res.status(401).json({ error: "unauthorized" });
      const { type, args, filterEnv, batchSize, concurrency } = req.body || {};
      const payload = { type, args };
      const summary = await sendSilentPushToAllUsers(payload, { filterEnv, batchSize, concurrency });
      return res.json({ status: "done", ...summary });
    } catch (err) {
      console.error("APNs broadcast error:", err);
      return res.status(500).json({ error: "apns_broadcast_failed", detail: String(err) });
    }
  });

  // Debug: list devices (optionally by email/env)
  app.get("/devices", async (req, res) => {
    if (req.get("X-API-Key") !== PUSH_API_KEY) return res.status(401).json({ error: "unauthorized" });
    const q = {};
    if (req.query.email) q.email = req.query.email;
    if (req.query.environment) q.environment = req.query.environment;
    const docs = await Device.find(q).lean();
    res.json(docs);
  });
}

module.exports = {
  bindApnsRoutes,
  apnsEnvIsConfigured,
  sendSilentPush,
  sendSilentPushToUser,
  sendSilentPushToAllUsers,
  Device,
};
