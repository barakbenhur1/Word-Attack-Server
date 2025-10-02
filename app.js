// app.js (top of file)
// npm run start:dev - to run
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
console.log("[APNs] PATH exists:", fs.existsSync(process.env.APPLE_P8_PATH));
console.log("[APNs] TOPIC", process.env.APP_BUNDLE_ID);

console.log("[ENV] NODE_ENV =", process.env.NODE_ENV || "production");
console.log("[ENV] loaded file =", envFile);

const express = require("express");
const bodyparser = require("body-parser");
const { auth } = require("express-openid-connect");
const https = require("https");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// ---- App & server bootstrap
const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`listening on *:${PORT}`);
});
server.timeout = 40000;

// ---- Optional TLS sanity check (remove in prod if you want)
const tlsOptions = {
  hostname: "www.howsmyssl.com",
  port: 443,
  path: "/a/check",
  method: "GET",
  secureProtocol: "TLSv1_2_method",
};
https
  .request(tlsOptions, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => {
      try {
        const data = JSON.parse(body);
        console.log("SSL Version:", data.tls_version);
      } catch {}
    });
  })
  .on("error", (err) => console.warn("[TLS check]", err?.message || err))
  .end();

// ---- Middleware
app.use(express.json({ limit: "1mb" }));
app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());
app.use(express.static(__dirname + "/public"));
app.use("/uploads", express.static("uploads"));

// ---- MongoDB
mongoose.set("strictQuery", true);
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error("Missing MONGO_URI env");
}

mongoose
  .connect(MONGO_URI, { dbName: "wordzap" })
  .then(() => console.log("db connected"))
  .catch((err) => console.error("db error:", err));

mongoose.connection.on(
  "connected",
  () => console.log("[mongo] db =", mongoose.connection.name) // should print 'wordzap'
);

const user = "wordzap-bbh";
const pass = encodeURIComponent("xjnH3ibSeXKKv4gL");
console.log(`mongodb+srv://${user}:${pass}@cluster0.jr0ty.mongodb.net/wordzap`);

// ---- Auth0
// IMPORTANT: In production use a FIXED SESSION_SECRET from env (not uuid each boot).
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();
app.use(
  auth({
    issuerBaseURL:
      process.env.AUTH0_ISSUER_BASE_URL ||
      "https://dev-8mxg4wjifqipa4jd.us.auth0.com",
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    clientID: process.env.AUTH0_CLIENT_ID || "FvfmF4iT9SOC58fpKkAZYdKgZKj6b8wO",
    secret: SESSION_SECRET,
    authRequired: false,
    auth0Logout: true,
  })
);

app.use((req, res, next) => {
  res.locals.isAuthenticated = req.oidc.isAuthenticated();
  next();
});

// ---- Your existing routers
const login = require("./src/Routers/login");
const words = require("./src/Routers/words");
const score = require("./src/Routers/score");
app.use("/login", login);
app.use("/words", words);
app.use("/score", score);

// ---- Devices router (token register/list) — optional but recommended
try {
  const devices = require("./src/Routers/devices");
  app.use("/devices", devices);
  console.log("(/devices) routes mounted");
} catch (e) {
  console.warn("(/devices) router not found, skipping. ", e.message);
}

// ---- APNs silent-push routes
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

// ---- Health / root
app.get("/", (_req, res) => res.send("hello world 2"));

// ---- 404 fallback
app.use((req, res) => res.status(404).json({ error: "not_found" }));

// ---- Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "server_error" });
});
