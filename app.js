// app.js

const path = require("path");
const envFile =
  process.env.NODE_ENV && process.env.NODE_ENV !== "production"
    ? `.env.${process.env.NODE_ENV}`
    : ".env.production";
require("dotenv").config({
  path: path.resolve(process.cwd(), envFile),
  override: true,
});

const fs = require("fs");
console.log("[APNs] TEAM", !!process.env.APPLE_TEAM_ID);
console.log("[APNs] KEY ", !!process.env.APPLE_KEY_ID);
console.log("[APNs] PATH", process.env.APPLE_P8_PATH);
console.log(
  "[APNs] PATH exists:",
  !!process.env.APPLE_P8_PATH && fs.existsSync(process.env.APPLE_P8_PATH)
);
console.log("[APNs] TOPIC", process.env.APP_BUNDLE_ID);
console.log("[ENV] NODE_ENV =", process.env.NODE_ENV || "production");
console.log("[ENV] loaded file =", envFile);

const express = require("express");
const bodyparser = require("body-parser");
const { auth } = require("express-openid-connect");
const https = require("https");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1);

// ---------- Server ----------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`listening on *:${PORT}`);
});
server.timeout = 40000;

// ---------- TLS sanity check (non-blocking) ----------
https
  .request(
    {
      hostname: "www.howsmyssl.com",
      port: 443,
      path: "/a/check",
      method: "GET",
      secureProtocol: "TLSv1_2_method",
    },
    (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          console.log("SSL Version:", data.tls_version);
        } catch {}
      });
    }
  )
  .on("error", (err) => console.warn("[TLS check]", err?.message || err))
  .end();

// ---------- Parsers & static ----------
app.use(express.json({ limit: "1mb" }));
app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static("uploads"));

// ---------- CORS ----------
const CORS_ORIGINS = process.env.CORS_ORIGINS || "*"; // e.g. "https://your.app,https://admin.your.app"
const corsOrigins = CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin || corsOrigins.includes("*") || corsOrigins.includes(origin))
      return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization",
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions)); // avoid path-to-regexp "*" issue

// ---------- Rate limiting ----------
const generalLimiter = rateLimit({
  windowMs: Number(process.env.RL_WINDOW_MS || 60_000),
  max: Number(process.env.RL_MAX || 600),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "rate_limited" }),
});
app.use(generalLimiter);

const aiLimiter = rateLimit({
  windowMs: Number(
    process.env.RL_AI_WINDOW_MS || process.env.RL_WINDOW_MS || 60_000
  ),
  max: Number(process.env.RL_AI_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "rate_limited" }),
});

// ---------- Mongo ----------
mongoose.set("strictQuery", true);
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  throw new Error("Missing MONGO_URI env");
}
mongoose
  .connect(MONGO_URI, { dbName: "wordzap" })
  .then(() => console.log("db connected"))
  .catch((err) => console.error("db error:", err));
mongoose.connection.on("connected", () =>
  console.log("[mongo] db =", mongoose.connection.name)
);

// ---------- Auth0 ----------
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();
app.use(
  auth({
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
    baseURL: process.env.BASE_URL,
    clientID: process.env.AUTH0_CLIENT_ID,
    secret: SESSION_SECRET,
    authRequired: false,
    auth0Logout: true,
  })
);

app.use((req, res, next) => {
  res.locals.isAuthenticated = req.oidc.isAuthenticated();
  next();
});

// ---------- Routers ----------
const login = require("./src/Routers/login");
const words = require("./src/Routers/words");
const score = require("./src/Routers/score");

// Mount /ai with probe + ping to ensure mount works even if model fails
try {
  const ai = require("./src/Routers/ai");

  // Request probe (logs any hit under /ai)
  app.use("/ai", (req, _res, next) => {
    console.log("[/ai PROBE]", req.method, req.url);
    next();
  });

  // Ping endpoint from app.js (bypasses AI router internals)
  app.get("/ai/_ping", (_req, res) => res.json({ ok: true, where: "app.js" }));

  app.use("/ai", aiLimiter, ai);
  console.log("(/ai) routes mounted");
} catch (e) {
  console.error("Failed to load /ai router:", e?.message || e);
}

app.use("/login", login);
app.use("/words", words);
app.use("/score", score);

try {
  const devices = require("./src/Routers/devices");
  app.use("/devices", devices);
  console.log("(/devices) routes mounted");
} catch (e) {
  console.warn("(/devices) router not found, skipping. ", e.message);
}

try {
  const { bindApnsRoutes, apnsEnvIsConfigured } = require("./src/Utils/apns");
  bindApnsRoutes(app);
  console.log("APNs routes bound");
  if (!apnsEnvIsConfigured()) {
    console.warn(
      "[APNs] Missing env configuration — set APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_P8_PATH / APP_BUNDLE_ID"
    );
  }
} catch (e) {
  console.warn("APNs utils not found, skipping. ", e.message);
}

// ---------- Misc ----------
app.get("/ai/_ping", (_req, res) => {
  res.json({ ok: true, where: "app.js" });
});
app.get("/", (_req, res) => res.send("hello world 2"));
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, ts: Date.now(), uptime: process.uptime() })
);

// ---------- 404 + error handler (keep last) ----------
app.use((req, res) => res.status(404).json({ error: "not_found" }));

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "server_error" });
});
