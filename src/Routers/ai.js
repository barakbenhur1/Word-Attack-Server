// src/Routers/ai.js
const express = require("express");
const router = express.Router();
const fs = require("fs");
const https = require("https");
const path = require("path");

// Prefer native ORT; fall back to WASM
let ort, ORT_BACKEND = "wasm";
try { ort = require("onnxruntime-web"); ORT_BACKEND = "wasm"; }
catch { ort = require("onnxruntime-node"); ORT_BACKEND = "node"; }

// ---------------- Env / paths ----------------
const MODEL_DIR = process.env.MODEL_DIR || "/tmp/models";
const MODEL_NAME = process.env.MODEL_NAME || "wordzap.onnx";
const TOKENIZER_NAME = process.env.TOKENIZER_NAME || "tokenizer.json";
const MODEL_PATH = process.env.MODEL_PATH || path.join(MODEL_DIR, MODEL_NAME);
const TOKENIZER_PATH = process.env.TOKENIZER_PATH || path.join(MODEL_DIR, TOKENIZER_NAME);
const MODEL_URL_MODEL = process.env.MODEL_URL_MODEL;
const MODEL_URL_TOKENIZER = process.env.MODEL_URL_TOKENIZER;
const MODEL_LOAD_MODE = (process.env.MODEL_LOAD_MODE || "auto").toLowerCase(); // "memory" | "auto"
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 84);

// Concurrency gate
const AI_MAX_CONCURRENCY = parseInt(process.env.AI_MAX_CONCURRENCY || "1", 10);
let _running = 0;
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function withGate(fn) {
  while (_running >= AI_MAX_CONCURRENCY) await _sleep(5);
  _running++;
  try { return await fn(); }
  finally { _running--; }
}

// ---------------- Helpers (HTTP + loading) ----------------
function httpsGetFollow(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      headers: { "User-Agent": "wordzap/1.0", ...headers },
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code)) {
        if (maxRedirects <= 0) { res.resume(); return reject(new Error("Too many redirects")); }
        const loc = res.headers.location; res.resume();
        if (!loc) return reject(new Error("Redirect with no Location"));
        const next = new URL(loc, url).toString();
        return resolve(httpsGetFollow(next, headers, maxRedirects - 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code} for ${url}`)); }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
  });
}

async function downloadToFile(url, outPath, headers = {}) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      headers: { "User-Agent": "wordzap/1.0", ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadToFile(new URL(res.headers.location, url).toString(), outPath, headers)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function ensureModelLocal() {
  const hdr = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const wantDisk = MODEL_LOAD_MODE !== "memory";

  const haveDisk = fs.existsSync(MODEL_PATH) && fs.existsSync(TOKENIZER_PATH);
  if (wantDisk && haveDisk) {
    return { storage: "disk", modelPath: MODEL_PATH, tokenizerPath: TOKENIZER_PATH };
  }

  if (wantDisk) {
    if (!MODEL_URL_MODEL || !MODEL_URL_TOKENIZER) throw new Error("Set MODEL_URL_MODEL and MODEL_URL_TOKENIZER");
    await downloadToFile(MODEL_URL_MODEL, MODEL_PATH, hdr);
    await downloadToFile(MODEL_URL_TOKENIZER, TOKENIZER_PATH, hdr);
    return { storage: "disk", modelPath: MODEL_PATH, tokenizerPath: TOKENIZER_PATH };
  }

  // memory mode
  if (!MODEL_URL_MODEL || !MODEL_URL_TOKENIZER) {
    throw new Error("MODEL_URL_MODEL and MODEL_URL_TOKENIZER required for memory mode");
  }
  const [modelBytes, tokBuf] = await Promise.all([
    httpsGetFollow(MODEL_URL_MODEL, hdr),
    httpsGetFollow(MODEL_URL_TOKENIZER, hdr),
  ]);
  return { storage: "memory", modelBytes, tokenizerJSON: tokBuf.toString("utf8") };
}

// ---------------- Tokenizer (lite) ----------------
class TokenizerLite {
  constructor(cfg) {
    this.id2tok = [];
    this.tok2id = new Map();
    this.ranks = new Map();
    this.special = new Set();
    this.bosId = null;
    this.eosId = null;
    this.unkId = 0;

    const model = cfg.model || {};
    const added = cfg.added_tokens || [];
    const vocab = model.vocab;

    // vocab: object or array
    if (vocab && !Array.isArray(vocab) && typeof vocab === "object") {
      for (const [tok, id] of Object.entries(vocab)) {
        const i = Number(id); if (!Number.isFinite(i)) continue;
        this.id2tok[i] = tok; this.tok2id.set(tok, i);
      }
    } else if (Array.isArray(vocab)) {
      for (let i = 0; i < vocab.length; i++) {
        const entry = vocab[i];
        const tok = Array.isArray(entry) ? String(entry[0]) : String(entry);
        this.id2tok[i] = tok; this.tok2id.set(tok, i);
      }
    }
    for (const a of added) {
      if (a && typeof a.id === "number" && typeof a.content === "string") {
        this.id2tok[a.id] = a.content; this.tok2id.set(a.content, a.id);
        if (a.special) this.special.add(a.content);
      }
    }
    // specials
    this.special.add("<s>"); this.special.add("</s>"); this.special.add("<unk>");
    this.bosId = this.tok2id.get("<s>") ?? null;
    this.eosId = this.tok2id.get("</s>") ?? null;
    this.unkId = this.tok2id.get("<unk>") ?? 0;

    // merges (optional; we don't fully use them in this lite shim)
    const merges = model.merges || [];
    for (let rank = 0; rank < merges.length; rank++) {
      const m = merges[rank]; let a, b;
      if (typeof m === "string") {
        const parts = m.split(" "); if (parts.length >= 2) { a = parts[0]; b = parts[1]; }
      } else if (Array.isArray(m) && m.length >= 2) {
        a = String(m[0]); b = String(m[1]);
      }
      if (a && b) this.ranks.set(a + "\u0000" + b, rank);
    }

    this.hasMetaSpace = this.id2tok.some((t) => t && (t.includes("▁") || t.startsWith("Ġ")));
  }
  static async fromJSON(jsonString) { return new TokenizerLite(JSON.parse(jsonString)); }

  decode(ids, skipSpecial = true) {
    let s = "";
    for (const id of ids) {
      const tok = this.id2tok[id];
      if (!tok) continue;
      if (skipSpecial && this.special.has(tok)) continue;
      s += tok;
    }
    return s.replace(/▁/g, " ").replace(/Ġ/g, " ");
  }
  decodeOne(id) { return this.decode([id], true); }
  get vocabSize() { return this.id2tok.length; }
  tokenString(id) { return this.id2tok[id] || ""; }
  bos() { return this.bosId; }

  encode(text, addBOS = true) {
    const ids = [];
    if (addBOS && this.bosId != null) ids.push(this.bosId);
    const nfkc = text.normalize("NFKC");
    const pre = this.hasMetaSpace ? "▁" + nfkc.replace(/ /g, " ▁") : nfkc.replace(/(^| )/g, "Ġ");
    // Minimal mapping: try whole chunks; if missing => unk
    for (const chunk of pre.split(" ")) {
      ids.push(this.tok2id.get(chunk) ?? this.unkId);
    }
    return ids;
  }
}

// ---------------- Inference + game helpers ----------------
const Difficulty = {
  easy: { temperature: 0.7, topK: 32 },
  medium: { temperature: 0.4, topK: 12 },
  hard: { temperature: 0.0, topK: 1 },
  boss: { temperature: 0.0, topK: 1 },
};

const ALPHA_EN = new Set("abcdefghijklmnopqrstuvwxyz".split(""));
const ALPHA_HE = new Set("אבגדהוזחטיכלמנסעפצקרשתךםןףץ".split(""));

let session = null, tokenizer = null, vocabSize = 0;
let id2charEN = new Map(), id2charHE = new Map();
let wordTokenIdsEN = [], wordTokenIdsHE = [];
let STORAGE_KIND = "memory";

// sanitize helpers to ensure valid 5-letter outputs
const stripDiacritics = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const onlyAlphaEN = (s) => [...s].every((c) => ALPHA_EN.has(c));
const onlyAlphaHE = (s) => [...s].every((c) => ALPHA_HE.has(c));
const isAscii5 = (s) => s.length === 5 && onlyAlphaEN(s);
const isHeb5   = (s) => s.length === 5 && onlyAlphaHE(s);
function sanitizeFinal(word, lang) {
  const t = stripDiacritics(String(word || "").toLowerCase());
  if (lang === "en") return isAscii5(t) ? t : null;
  if (lang === "he") return isHeb5(t)   ? t : null;
  return null;
}

function fallbackWord(lang) {
  return lang === "he" ? "מגניב" : "stare";
}

function tokenStartsWithSpace(id) {
  const raw = tokenizer.tokenString(id) || "";
  return raw.startsWith("▁") || raw.startsWith("Ġ") || raw.startsWith(" ");
}
function trimmedLower(s) {
  let t = s.trim().toLowerCase();
  if (t.startsWith(" ")) t = t.slice(1);
  return t;
}

function pickLogits(output, expectVocab) {
  let best = null, bestScore = -1;
  for (const [name, t] of Object.entries(output)) {
    const dims = t.dims || [];
    const size = t.size || (t.data?.length ?? 0);
    let score = 0;
    if (String(name).toLowerCase().includes("logit")) score += 10;
    if (dims.at(-1) === expectVocab) score += 5;
    if (expectVocab > 0 && (size === expectVocab || size % expectVocab === 0)) score += 3;
    if (dims.length <= 2) score += 1;
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return best;
}
function makeIntTensor(ortLib, arr) {
  try { return new ortLib.Tensor("int64", BigInt64Array.from(arr.map(BigInt)), [1, arr.length]); }
  catch { return new ortLib.Tensor("int32", Int32Array.from(arr), [1, arr.length]); }
}
async function runLogits(ids, mask) {
  const inputIds = makeIntTensor(ort, ids);
  const attnMask = makeIntTensor(ort, mask);
  const out = await session.run({ input_ids: inputIds, attention_mask: attnMask, ids: inputIds, mask: attnMask });
  const logitsName = pickLogits(out, vocabSize);
  if (!logitsName) throw new Error("No logits-like output");
  const t = out[logitsName];
  const { data, dims } = t;
  if (dims.length === 3 && dims[2] === vocabSize) {
    const T = dims[1]; const start = (T - 1) * vocabSize;
    return data.slice(start, start + vocabSize);
  }
  if (dims.length === 2 && dims[1] === vocabSize) {
    const T = dims[0]; const start = (T - 1) * vocabSize;
    return data.slice(start, start + vocabSize);
  }
  if (data.length % vocabSize === 0) return data.slice(data.length - vocabSize);
  return data;
}
function normalizeFeedback(feedback, count = 5) {
  const f = [...(feedback || "")], out = [];
  for (let i = 0; i < count; i++) {
    const ch = f[i] || "";
    out.push(["🟩", "🟢", "G", "g"].includes(ch) ? "green" : (["🟨", "Y", "y"].includes(ch) ? "yellow" : "gray"));
  }
  return out;
}
function buildPrompt(history, lang) {
  const body = (history || []).map((r) => `${r.word} ${r.feedback}`).join("\n");
  const tag = lang === "en" ? "<|en|>\n" : "<|he|>\n";
  return tag + (body ? body + "\n" : "");
}
function encodePrompt(text) {
  const base = tokenizer.encode(text, true);
  let ids = base.slice();
  if (ids.length > MAX_TOKENS) ids = ids.slice(ids.length - MAX_TOKENS);
  if (ids.length < MAX_TOKENS) {
    const padId = tokenizer.bos() ?? 0;
    ids = new Array(MAX_TOKENS - ids.length).fill(padId).concat(ids);
  }
  return { ids, mask: new Array(MAX_TOKENS).fill(1) };
}
function sampleRestricted({ logits, candidates, temperature, topK }) {
  const idxs = candidates.filter((id) => id >= 0 && id < logits.length);
  if (idxs.length === 0) return 0;
  if (temperature <= 0) {
    let best = idxs[0], bestVal = logits[best];
    for (const id of idxs) if (logits[id] > bestVal) { best = id; bestVal = logits[id]; }
    return best;
  }
  const k = Math.max(1, Math.min(topK, idxs.length));
  idxs.sort((a, b) => logits[b] - logits[a]);
  const top = idxs.slice(0, k);
  const invT = 1 / Math.max(temperature, 1e-6);
  let mx = -Infinity;
  for (const id of top) mx = Math.max(mx, logits[id] * invT);
  const exps = new Float32Array(top.length);
  let sum = 0;
  for (let j = 0; j < top.length; j++) { const v = Math.exp(logits[top[j]] * invT - mx); exps[j] = v; sum += v; }
  let r = Math.random();
  for (let j = 0; j < top.length; j++) { r -= exps[j] / sum; if (r <= 0) return top[j]; }
  return top[top.length - 1];
}
function buildConstraints(history) {
  const L = 5;
  const fixed = Array(L).fill(null);
  const bannedAt = Array(L).fill(0).map(() => new Set());
  const disallow = new Set();
  const minCount = new Map();
  const maxCount = new Map();
  for (const row of history) {
    const w = (row.word || "").toLowerCase();
    const fb = normalizeFeedback(row.feedback || "", L);
    if (w.length !== L) continue;
    const ws = [...w];
    const rowCount = new Map();
    const rowReq = new Map();
    for (let i = 0; i < L; i++) {
      const c = ws[i];
      rowCount.set(c, (rowCount.get(c) || 0) + 1);
      if (fb[i] !== "gray") rowReq.set(c, (rowReq.get(c) || 0) + 1);
      if (fb[i] === "green") fixed[i] = c;
      else bannedAt[i].add(c);
    }
    for (const [c, need] of rowReq) minCount.set(c, Math.max(minCount.get(c) || 0, need));
    for (const [c, k] of rowCount) {
      const r = rowReq.get(c) || 0;
      if (r < k) maxCount.set(c, Math.min(maxCount.get(c) ?? r, r));
      if (k > 0 && r === 0) { maxCount.set(c, 0); disallow.add(c); }
    }
  }
  return { fixed, bannedAt, disallow, minCount, maxCount, length: L };
}
function isAllowedAt(c, pos, used, C) {
  if (C.disallow.has(c)) return false;
  if (C.bannedAt[pos].has(c)) return false;
  if (C.fixed[pos] && C.fixed[pos] !== c) return false;
  const mx = C.maxCount.get(c);
  if (mx != null && (used.get(c) || 0) >= mx) return false;
  return true;
}
function fallbackOrder(lang) {
  return lang === "en"
    ? [..."etaoinshrdlcumwfgypbvkjxqz"]
    : [..."יוהרלמאשתנכבדסגפצחעקטז"];
}
function pickFallbackChar(pos, used, C, lang) {
  for (const [ch, need] of C.minCount.entries()) {
    const have = used.get(ch) || 0;
    if (need > have && isAllowedAt(ch, pos, used, C)) return ch;
  }
  for (const ch of fallbackOrder(lang)) {
    if ((used.get(ch) || 0) === 0 && isAllowedAt(ch, pos, used, C)) return ch;
  }
  for (const ch of fallbackOrder(lang)) if (isAllowedAt(ch, pos, used, C)) return ch;
  return lang === "en" ? "e" : "י";
}
function isGoodFirstOpener(w, lang) {
  const s = String(w || "").toLowerCase();
  if (s.length !== 5) return false;
  const cnt = {}; for (const c of s) cnt[c] = (cnt[c] || 0) + 1;
  if (Object.values(cnt).some((v) => v >= 3)) return false;
  if (Object.values(cnt).filter((v) => v === 2).length > 1) return false;
  if (Object.keys(cnt).length < 4) return false;
  if (lang === "en") for (const h of ["q","j","x","z"]) if ((cnt[h] || 0) >= 2) return false;
  return true;
}
function openerBias(w, lang) {
  const s = String(w || "").toLowerCase();
  if (s.length !== 5) return 0;
  const cnt = {}; for (const c of s) cnt[c] = (cnt[c] || 0) + 1;
  const maxDup = Math.max(...Object.values(cnt));
  const distinct = Object.keys(cnt).length;
  let dupPenalty = 0;
  if (maxDup >= 3) dupPenalty -= 10;
  if (Object.values(cnt).filter((v) => v === 2).length >= 2) dupPenalty -= 2;
  if (["q","j","x","z"].some((h) => (cnt[h] || 0) >= 2)) dupPenalty -= 6;
  const vowels = [...s].filter((c) => "aeiouy".includes(c)).length;
  const vowelNudge = vowels >= 2 ? 0.7 : vowels === 1 ? -0.4 : -0.8;
  // cheap entropy-ish proxy
  const entropyBoost = (distinct / 5) * 2.0;
  return entropyBoost + vowelNudge + (distinct - 3) * 0.3 + dupPenalty;
}

function emptyConstraints(len = 5) {
  return {
    length: len,
    fixed: Array(len).fill(null),
    bannedAt: Array(len).fill(0).map(() => new Set()),
    disallow: new Set(),
    minCount: new Map(),
    maxCount: new Map(),
  };
}

// Choose a first guess: try single-token 5-letter words, else compose letters
async function chooseOpener({ ids, mask, lang }) {
  const pool = lang === "en" ? wordTokenIdsEN.slice() : wordTokenIdsHE.slice();

  if (pool.length > 0) {
    const logits = await runLogits(ids, mask);
    const adjusted = logits.slice();
    for (const tid of pool) {
      if (tid >= 0 && tid < adjusted.length) {
        const w = tokenizer.decode([tid], true).trim().toLowerCase();
        if (w.length === 5) adjusted[tid] = adjusted[tid] + openerBias(w, lang);
      }
    }
    pool.sort((a, b) => adjusted[b] - adjusted[a]);
    for (const id of pool) {
      const w = tokenizer.decode([id], true).trim().toLowerCase();
      if (isGoodFirstOpener(w, lang)) return w;
    }
    return fallbackWord(lang);
  }

  // Compose letter-by-letter
  const id2char = lang === "en" ? id2charEN : id2charHE;
  const cleanPool = new Set([...id2char.keys()].filter((id) => id >= 0 && id < vocabSize));

  let logits = await runLogits(ids, mask);
  const used = new Map();
  const out = [];
  const C = emptyConstraints(5);
  const temperature = 0.85, topK = 256;

  for (let pos = 0; pos < 5; pos++) {
    const NEG = -1e30;
    const masked = logits.slice();
    for (let i = 0; i < masked.length; i++) if (!cleanPool.has(i)) masked[i] = NEG;

    for (const [tid, ch] of id2char.entries()) {
      if (tid < masked.length && (used.get(ch) || 0) >= 1) masked[tid] -= 0.6;
    }

    let nextId = sampleRestricted({ logits: masked, candidates: [...cleanPool], temperature, topK });
    let ch = id2char.get(nextId);

    if (!ch) {
      ch = pickFallbackChar(pos, used, C, lang);
      for (const [tid, tch] of id2char.entries()) if (tch === ch) { nextId = tid; break; }
    }

    out.push(ch);
    used.set(ch, (used.get(ch) || 0) + 1);
    ids = ids.slice(1).concat([nextId]);
    mask = mask.slice(1).concat([1]);
    logits = await runLogits(ids, mask);
  }

  let word = out.join("");
  if (!isGoodFirstOpener(word, lang)) word = fallbackWord(lang);
  return word;
}

async function guessWithModel({ history = [], lang = "en", difficulty = "medium" }) {
  const { temperature, topK } = Difficulty[difficulty];
  const prompt = buildPrompt(history, lang);
  let { ids, mask } = encodePrompt(prompt);

  const C = buildConstraints(history);
  const id2char = lang === "en" ? id2charEN : id2charHE;
  const cleanPool = new Set([...id2char.keys()].filter((id) => id >= 0 && id < vocabSize));

  let logits = await runLogits(ids, mask);
  const used = new Map();
  const out = [];
  for (let pos = 0; pos < 5; pos++) {
    const NEG = -1e30;
    const masked = logits.slice();
    for (let tid = 0; tid < masked.length; tid++) if (!cleanPool.has(tid)) masked[tid] = NEG;

    // ensure minCount feasibility
    const remaining = 5 - pos;
    let deficit = 0; const keep = new Set();
    for (const [ch, need] of C.minCount.entries()) {
      const have = used.get(ch) || 0;
      const gap = Math.max(0, need - have);
      deficit += gap;
      if (gap > 0) for (const [tid, tch] of id2char.entries()) if (tch === ch) keep.add(tid);
    }
    if (deficit > 0 && deficit >= remaining) {
      for (let i = 0; i < masked.length; i++) if (!keep.has(i)) masked[i] = NEG;
    }

    // positional filtering
    for (const [tid, ch] of id2char.entries()) {
      if (!isAllowedAt(ch, pos, used, C)) masked[tid] = NEG;
    }

    let nextId = sampleRestricted({ logits: masked, candidates: [...cleanPool], temperature, topK });
    let ch = id2char.get(nextId);
    if (!ch || !isAllowedAt(ch, pos, used, C)) {
      ch = pickFallbackChar(pos, used, C, lang);
      for (const [tid, tch] of id2char.entries()) if (tch === ch) { nextId = tid; break; }
    }

    out.push(ch);
    used.set(ch, (used.get(ch) || 0) + 1);
    ids = ids.slice(1).concat([nextId]);
    mask = mask.slice(1).concat([1]);
    logits = await runLogits(ids, mask);
  }
  return out.join("");
}

// ---------------- Build vocab maps ----------------
function buildMaps() {
  vocabSize = tokenizer.vocabSize;
  id2charEN = new Map(); id2charHE = new Map();
  wordTokenIdsEN = []; wordTokenIdsHE = [];
  for (let id = 0; id < vocabSize; id++) {
    let s;
    try { s = tokenizer.decodeOne(id); } catch { continue; }
    if (!s) continue;

    if (/^ ?[a-z]$/i.test(s)) id2charEN.set(id, s.trim().toLowerCase());
    if (/^ ?[אבגדהוזחטיכלמנסעפצקרשתךםןףץ]$/.test(s)) id2charHE.set(id, s.trim());

    const clean = trimmedLower(s);
    if (clean.length === 5 && !clean.includes(" ")) {
      const allEn = [...clean].every((c) => ALPHA_EN.has(c));
      const allHe = [...clean].every((c) => ALPHA_HE.has(c));
      const allowLeading = tokenizer.hasMetaSpace === true;
      if (allEn && (allowLeading || !tokenStartsWithSpace(id))) wordTokenIdsEN.push(id);
      if (allHe && (allowLeading || !tokenStartsWithSpace(id))) wordTokenIdsHE.push(id);
    }
  }
  wordTokenIdsEN = Array.from(new Set(wordTokenIdsEN)).sort((a, b) => a - b);
  wordTokenIdsHE = Array.from(new Set(wordTokenIdsHE)).sort((a, b) => a - b);
}

// ---------------- Boot ----------------
const sessionOptsNode = {
  graphOptimizationLevel: "basic",
  executionMode: "sequential",
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  enableMemPattern: false,
  enableCpuMemArena: false,
};
const sessionOptsWasm = {
  graphOptimizationLevel: "basic",
  executionProviders: ["wasm"],
};

const aiReady = (async () => {
  const local = await ensureModelLocal();
  STORAGE_KIND = local.storage;

  // tokenizer
  let tokenizerJSON;
  if (local.storage === "disk") {
    tokenizerJSON = await fs.promises.readFile(local.tokenizerPath, "utf8");
  } else {
    tokenizerJSON = local.tokenizerJSON;
  }
  tokenizer = await TokenizerLite.fromJSON(tokenizerJSON);

  // session
  if (ORT_BACKEND === "node" && local.storage === "disk") {
    // ✅ memory-mapped file load
    session = await ort.InferenceSession.create(local.modelPath, sessionOptsNode);
    console.log("[AI] onnxruntime-node path OK");
  } else if (ORT_BACKEND === "node" && local.storage === "memory") {
    session = await ort.InferenceSession.create(local.modelBytes, sessionOptsNode);
    console.log("[AI] onnxruntime-node bytes OK");
  } else {
    if (ort.env && ort.env.wasm) {
      ort.env.wasm.numThreads = Number(process.env.ORT_WASM_THREADS || 1);
      ort.env.wasm.simd = true;
    }
    const bytes = local.storage === "disk"
      ? await fs.promises.readFile(local.modelPath) // WASM needs bytes
      : local.modelBytes;
    session = await ort.InferenceSession.create(bytes, sessionOptsWasm);
    console.log("[AI] onnxruntime-web (WASM) OK");
  }

  buildMaps();
  console.log("[AI] ready:", { backend: ORT_BACKEND, storage: STORAGE_KIND, vocabSize });
})();

// ---------------- Routes ----------------

// Lightweight ping (no model await)
router.get("/_ping", (_req, res) => {
  res.json({ ok: true, backend: ORT_BACKEND, warmed: !!session, storage: STORAGE_KIND });
});

// Full health (awaits model); alias: /aiHealth
async function respondHealth(res) {
  await aiReady;
  res.json({
    ok: true,
    backend: ORT_BACKEND,
    storage: STORAGE_KIND,
    modelPath: STORAGE_KIND === "disk" ? MODEL_PATH : null,
    tokenizerPath: STORAGE_KIND === "disk" ? TOKENIZER_PATH : null,
    vocabSize,
    lettersEN: id2charEN.size,
    lettersHE: id2charHE.size,
    wordsEN: wordTokenIdsEN.length,
    wordsHE: wordTokenIdsHE.length,
  });
}
router.get("/health", (_req, res) => withGate(() => respondHealth(res)).catch(e => res.status(500).json({ ok:false, error:String(e.message||e) })));
router.get("/aiHealth", (_req, res) => withGate(() => respondHealth(res)).catch(e => res.status(500).json({ ok:false, error:String(e.message||e) })));

// Unified guess handler with strict sanitization
router.post("/aiGuess", async (req, res) => {
  try {
    const result = await withGate(async () => {
      await aiReady;

      const body = req.body || {};
      const history = Array.isArray(body.history) ? body.history : [];
      const lang = body.lang === "he" ? "he" : "en";
      const difficulty = ["easy","medium","hard","boss"].includes(body.difficulty) ? body.difficulty : "medium";

      // If last guess is all green, just echo it back (sanitized)
      if (history.length) {
        const last = history[history.length - 1];
        const greens = normalizeFeedback(last.feedback || "", 5);
        if (greens.every((x) => x === "green")) {
          const safeDone = sanitizeFinal(String(last.word || "").toLowerCase(), lang);
          return { guess: safeDone || fallbackWord(lang), mode: "history" };
        }
      }

      let guess;
      if (history.length === 0) {
        const { ids, mask } = encodePrompt(lang === "en" ? "<|en|>\n" : "<|he|>\n");
        guess = await chooseOpener({ ids, mask, lang });
      } else {
        guess = await guessWithModel({ history, lang, difficulty });
      }

      // Hard sanitize (blocks things like "autorité" for EN)
      const safe = sanitizeFinal(guess, lang) || fallbackWord(lang);
      return { guess: safe, mode: ORT_BACKEND };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "ai_error", detail: String(e.message || e) });
  }
});

// Compatibility alias (legacy)
router.post("/guess", (req, res) => {
  req.url = "/aiGuess";
  router.handle(req, res);
});

module.exports = router;
