const DEFAULT_TZ = "UTC";
const HEB_FINALS = { "ך":"כ", "ם":"מ", "ן":"נ", "ף":"פ", "ץ":"צ" };

function headers() {
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"content-type, authorization, x-api-key",
    "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer"
  };
}

function json(status, body) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { ...headers(), ...(status === 204 ? {} : {"Content-Type":"application/json; charset=utf-8"}) }
  });
}

async function readJson(request, limit = 256 * 1024) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw Object.assign(new Error("request_too_large"), {status:413});
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw Object.assign(new Error("request_too_large"), {status:413});
  try { return JSON.parse(new TextDecoder().decode(bytes) || "{}"); }
  catch { throw Object.assign(new Error("invalid_json"), {status:400}); }
}

function normalizeHebrew(value) {
  return String(value || "")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[ךםןףץ]/g, c => HEB_FINALS[c] || c);
}

function normalizeWord(value, lang) {
  const text = String(value || "").trim();
  return lang === "he" ? normalizeHebrew(text) : text.toLowerCase();
}

function codePointLength(value) { return Array.from(String(value || "")).length; }

function validWord(value, lang, length) {
  const word = normalizeWord(value, lang);
  const letters = lang === "he" ? /^[\u05D0-\u05EA]+$/u : /^[a-z]+$/i;
  return codePointLength(word) === length && letters.test(word);
}

function tokenize(text) {
  return String(text || "").split(/[^A-Za-z\u0590-\u05FF]+/u).filter(Boolean);
}

async function wikipediaCandidates(lang, length, blocked) {
  const u = new URL("https://" + lang + ".wikipedia.org/w/api.php");
  u.search = new URLSearchParams({
    action:"query", generator:"random", grnlimit:"40", grnnamespace:"0",
    grnfilterredir:"nonredirects", prop:"extracts", exchars:"1000",
    explaintext:"1", redirects:"1", format:"json", formatversion:"2"
  }).toString();

  const response = await fetch(u.toString(), {
    headers: {"User-Agent":"WordZapCloudflare/1.0 (support@wordzap.app)", "Accept":"application/json"}
  });
  if (!response.ok) throw new Error("wikipedia_http_" + response.status);

  const payload = await response.json();
  const pages = Array.isArray(payload?.query?.pages) ? payload.query.pages : [];
  const out = new Map();

  for (const page of pages) {
    const title = tokenize(page.title || "");
    const extract = tokenize(page.extract || "");
    const freq = new Map();
    for (const token of extract) {
      const n = normalizeWord(token, lang);
      freq.set(n, (freq.get(n) || 0) + 1);
    }
    for (const raw of [...title, ...extract]) {
      const normalized = normalizeWord(raw, lang);
      if (!validWord(normalized, lang, length) || blocked.has(normalized)) continue;
      if ((freq.get(normalized) || 0) === 0) continue;
      if (lang === "en" && (/^[A-Z]{2,}$/.test(raw) || /^[A-Z][a-z]+$/.test(raw))) continue;
      if (lang === "he" && (/[\u05F3\u05F4\u05BE]/u.test(raw) || /[ךםןףץ](?=.)/u.test(raw))) continue;

      // Preserve natural Hebrew final letters for the player-visible answer.
      // Normalization is only for comparisons/deduplication, matching the
      // legacy server's behavior.
      const displayWord = lang === "he"
        ? String(raw).replace(/[\u0591-\u05C7]/g, "")
        : normalized;
      if (!validWord(displayWord, lang, length)) continue;

      const score = Math.min(5, 1 + (freq.get(normalized) || 0));
      const old = out.get(normalized);
      if (!old || old.score < score) out.set(normalized, {word:displayWord, score});
    }
  }
  return [...out.values()].sort((a,b) => b.score - a.score);
}

async function pickWord(lang, length, blockedValues = []) {
  const blocked = new Set(blockedValues.map(v => normalizeWord(v, lang)));
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidates = await wikipediaCandidates(lang, length, blocked).catch(() => []);
    if (candidates.length) {
      const top = candidates.slice(0, Math.min(12, candidates.length));
      return top[Math.floor(Math.random() * top.length)].word;
    }
  }
  throw new Error("no_word_available");
}

async function profileFor(db, uniqe) {
  return db.prepare("SELECT uniqe,email,name,gender,language FROM profiles WHERE uniqe=?").bind(uniqe).first();
}

async function login(db, body) {
  const uniqe = String(body.uniqe || "").trim();
  if (!uniqe) throw Object.assign(new Error("missing_uniqe"), {status:400});
  const old = await profileFor(db, uniqe);
  const now = Date.now();
  const email = String(body.email ?? old?.email ?? "");
  const name = String(body.name ?? old?.name ?? "");
  const gender = String(body.gender ?? old?.gender ?? "");
  const language = String(body.language ?? old?.language ?? "en").toLowerCase();
  await db.prepare(
    "INSERT INTO profiles(uniqe,email,name,gender,language,created_at,updated_at) VALUES(?,?,?,?,?,?,?) " +
    "ON CONFLICT(uniqe) DO UPDATE SET email=excluded.email,name=excluded.name,gender=excluded.gender,language=excluded.language,updated_at=excluded.updated_at"
  ).bind(uniqe,email,name,gender,language,now,now).run();
}


function cleanText(input) {
  return String(input || "")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function difficultyKey(input) { return cleanText(input); }
function difficultySlug(input) { return difficultyKey(input).toLowerCase(); }
function difficultyLength(input) {
  const key = difficultySlug(input);
  if (key.includes("easy")) return 4;
  if (key.includes("medium")) return 5;
  return 6;
}

function dayKey(timeZone = DEFAULT_TZ, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, day:"2-digit", month:"2-digit", year:"numeric"
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "";
  return get("day") + "/" + get("month") + "/" + get("year");
}

function safeArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function ensureMember(db, profile, difficulty, day) {
  const now = Date.now();
  await db.prepare(
    "INSERT INTO daily_members(day_key,language,difficulty,uniqe,name,total_score,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?) " +
    "ON CONFLICT(day_key,language,difficulty,uniqe) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at"
  ).bind(day,profile.language,difficulty,profile.uniqe,profile.name || "",now,now).run();
}

async function gameWord(db, profile, difficulty, timeZone) {
  const day = dayKey(timeZone);
  await ensureMember(db,profile,difficulty,day);

  const memberRows = await db.prepare(
    "SELECT word_index,value,guesswork_json,done FROM member_words WHERE day_key=? AND language=? AND difficulty=? AND uniqe=? ORDER BY word_index ASC"
  ).bind(day,profile.language,difficulty,profile.uniqe).all();
  const words = memberRows.results || [];
  const last = words.length ? words[words.length - 1] : null;

  if (!last || Number(last.done) === 1) {
    const nextIndex = words.length;
    let shared = await db.prepare(
      "SELECT value FROM difficulty_words WHERE day_key=? AND language=? AND difficulty=? AND word_index=?"
    ).bind(day,profile.language,difficulty,nextIndex).first();

    if (!shared) {
      const existing = await db.prepare(
        "SELECT value FROM difficulty_words WHERE day_key=? AND language=? AND difficulty=? ORDER BY word_index ASC"
      ).bind(day,profile.language,difficulty).all();
      const blocked = (existing.results || []).map(x => x.value);
      const value = await pickWord(profile.language,difficultyLength(difficulty),blocked);
      await db.prepare(
        "INSERT OR IGNORE INTO difficulty_words(day_key,language,difficulty,word_index,value,created_at) VALUES(?,?,?,?,?,?)"
      ).bind(day,profile.language,difficulty,nextIndex,value,Date.now()).run();
      shared = await db.prepare(
        "SELECT value FROM difficulty_words WHERE day_key=? AND language=? AND difficulty=? AND word_index=?"
      ).bind(day,profile.language,difficulty,nextIndex).first();
    }

    if (shared) {
      const now = Date.now();
      await db.prepare(
        "INSERT OR IGNORE INTO member_words(day_key,language,difficulty,uniqe,word_index,value,guesswork_json,done,created_at,updated_at) VALUES(?,?,?,?,?,?,'[]',0,?,?)"
      ).bind(day,profile.language,difficulty,profile.uniqe,nextIndex,shared.value,now,now).run();
    }
  }

  const row = await db.prepare(
    "SELECT word_index,value,guesswork_json,done FROM member_words WHERE day_key=? AND language=? AND difficulty=? AND uniqe=? ORDER BY word_index DESC LIMIT 1"
  ).bind(day,profile.language,difficulty,profile.uniqe).first();
  const count = await db.prepare(
    "SELECT COUNT(*) AS c FROM member_words WHERE day_key=? AND language=? AND difficulty=? AND uniqe=?"
  ).bind(day,profile.language,difficulty,profile.uniqe).first();

  return {day,row,count:Number(count?.c || 0)};
}

async function scoreboardFor(db, language) {
  const [membersResult, wordsResult, memberWordsResult] = await Promise.all([
    db.prepare("SELECT day_key,difficulty,uniqe,name,total_score,created_at FROM daily_members WHERE language=? ORDER BY created_at ASC,total_score DESC").bind(language).all(),
    db.prepare("SELECT day_key,difficulty,word_index,value,created_at FROM difficulty_words WHERE language=? ORDER BY created_at ASC,word_index ASC").bind(language).all(),
    db.prepare("SELECT day_key,difficulty,uniqe,word_index,value,guesswork_json,done,created_at FROM member_words WHERE language=? ORDER BY created_at ASC,word_index ASC").bind(language).all()
  ]);

  const days = new Map();
  const diff = (day,difficulty) => {
    if (!days.has(day)) days.set(day,{value:day,difficulties:new Map()});
    const map = days.get(day).difficulties;
    if (!map.has(difficulty)) map.set(difficulty,{value:difficulty,words:[],members:new Map()});
    return map.get(difficulty);
  };

  for (const row of wordsResult.results || []) diff(row.day_key,row.difficulty).words.push(row.value);
  for (const row of membersResult.results || []) {
    diff(row.day_key,row.difficulty).members.set(row.uniqe,{
      uniqe:row.uniqe,name:row.name || "",totalScore:Number(row.total_score || 0),words:[]
    });
  }
  for (const row of memberWordsResult.results || []) {
    const d = diff(row.day_key,row.difficulty);
    if (!d.members.has(row.uniqe)) d.members.set(row.uniqe,{uniqe:row.uniqe,name:"",totalScore:0,words:[]});
    d.members.get(row.uniqe).words.push({
      value:row.value,guesswork:safeArray(row.guesswork_json),done:Number(row.done) === 1
    });
  }

  return [...days.values()].map(day => ({
    value:day.value,
    difficulties:[...day.difficulties.values()].map(d => ({
      value:d.value,words:d.words,members:[...d.members.values()]
    }))
  })).slice(-30);
}

function wordleFeedback(guess, target) {
  const g = Array.from(guess), t = Array.from(target);
  const out = Array(g.length).fill("-");
  const remaining = new Map();
  for (let i=0; i<t.length; i++) {
    if (g[i] === t[i]) out[i] = "G";
    else remaining.set(t[i], (remaining.get(t[i]) || 0) + 1);
  }
  for (let i=0; i<g.length; i++) {
    if (out[i] === "G") continue;
    const count = remaining.get(g[i]) || 0;
    if (count > 0) { out[i] = "Y"; remaining.set(g[i], count - 1); }
  }
  return out.join("");
}

function historyAllows(candidate, history, lang) {
  const target = normalizeWord(candidate, lang);
  return history.every(row => {
    const guess = normalizeWord(row.word, lang);
    return validWord(guess, lang, 5) && wordleFeedback(guess, target) === String(row.feedback || "");
  });
}

function modelWord(text, lang) {
  const match = String(text || "").match(lang === "he" ? /[\u05D0-\u05EA]{5}/u : /[A-Za-z]{5}/);
  return match ? normalizeWord(match[0], lang) : null;
}

async function aiGuess(env, body) {
  const lang = body.lang === "he" ? "he" : "en";
  const difficulty = ["easy","medium","hard","boss"].includes(body.difficulty) ? body.difficulty : "medium";
  const history = Array.isArray(body.history) ? body.history.slice(-5) : [];
  const last = history[history.length - 1];

  if (last && String(last.feedback || "") === "GGGGG" && validWord(last.word, lang, 5)) {
    return {guess:normalizeWord(last.word, lang), mode:"history"};
  }
  if (difficulty === "boss" && validWord(body.cheat, lang, 5)) {
    return {guess:normalizeWord(body.cheat, lang), mode:"boss-cheat"};
  }

  if (env.AI) {
    try {
      const system = "You are a strict Wordle solver. Return exactly one five-letter " +
        (lang === "he" ? "Hebrew" : "English") +
        " word and nothing else. G means correct position, Y means present wrong position, - means absent. Respect duplicate letters exactly and never repeat a previous guess.";
      const user = "Difficulty: " + difficulty + "\nHistory:\n" +
        history.map(x => String(x.word || "") + " " + String(x.feedback || "")).join("\n");
      const result = await env.AI.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.2-1b-instruct", {
        messages:[{role:"system",content:system},{role:"user",content:user}],
        max_tokens:16,
        temperature:difficulty === "easy" ? 0.7 : difficulty === "medium" ? 0.4 : 0.1
      });
      const candidate = modelWord(result?.response || result?.result?.response || "", lang);
      if (candidate && !history.some(x => normalizeWord(x.word, lang) === candidate) && historyAllows(candidate, history, lang)) {
        return {guess:candidate, mode:"workers-ai"};
      }
    } catch {}
  }

  const blocked = history.map(x => x.word);
  for (let attempt=0; attempt<6; attempt++) {
    const candidate = await pickWord(lang, 5, blocked);
    if (historyAllows(candidate, history, lang)) {
      return {guess:candidate, mode:env.AI ? "workers-ai-fallback" : "wikipedia-fallback"};
    }
    blocked.push(candidate);
  }
  throw new Error("ai_guess_unavailable");
}


const textEncoder = new TextEncoder();
let apnsKeyPromise = null;
let apnsJwtCache = { token:"", expiresAt:0 };

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

function pemBytes(pem) {
  const body = String(pem || "")
    .replace(/-----BEGIN PRIVATE KEY-----/g,"")
    .replace(/-----END PRIVATE KEY-----/g,"")
    .replace(/\s+/g,"");
  if (!body) throw new Error("APPLE_P8 is missing");
  const binary = atob(body);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function apnsConfigured(env) {
  return Boolean(env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_P8 && env.APP_BUNDLE_ID);
}

async function apnsKey(env) {
  if (!apnsKeyPromise) {
    apnsKeyPromise = crypto.subtle.importKey(
      "pkcs8",
      pemBytes(env.APPLE_P8),
      {name:"ECDSA",namedCurve:"P-256"},
      false,
      ["sign"]
    );
  }
  return apnsKeyPromise;
}

async function apnsJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache.token && apnsJwtCache.expiresAt > now + 300) return apnsJwtCache.token;

  const header = base64url(textEncoder.encode(JSON.stringify({alg:"ES256",kid:String(env.APPLE_KEY_ID)})));
  const payload = base64url(textEncoder.encode(JSON.stringify({iss:String(env.APPLE_TEAM_ID),iat:now})));
  const unsigned = header + "." + payload;
  const signature = new Uint8Array(await crypto.subtle.sign(
    {name:"ECDSA",hash:"SHA-256"},
    await apnsKey(env),
    textEncoder.encode(unsigned)
  ));
  const token = unsigned + "." + base64url(signature);
  apnsJwtCache = {token,expiresAt:now + 50 * 60};
  return token;
}

async function sendSilentPush(env, device, payload = {}) {
  if (!apnsConfigured(env)) return {ok:false,status:503,reason:"apns_not_configured"};

  const host = device.environment === "sandbox"
    ? "api.sandbox.push.apple.com"
    : "api.push.apple.com";
  const topic = String(device.bundle_id || env.APP_BUNDLE_ID);
  const response = await fetch("https://" + host + "/3/device/" + encodeURIComponent(device.token), {
    method:"POST",
    headers:{
      "authorization":"bearer " + await apnsJwt(env),
      "apns-topic":topic,
      "apns-push-type":"background",
      "apns-priority":"5",
      "content-type":"application/json"
    },
    body:JSON.stringify({
      aps:{"content-available":1},
      type:payload.type || "wordzap.refresh",
      args:payload.args || undefined
    })
  });

  let detail = {};
  try { detail = await response.json(); } catch {}
  const reason = detail?.reason || null;
  const ok = response.ok;

  if (!ok && (reason === "BadDeviceToken" || reason === "Unregistered")) {
    await env.DB.prepare("DELETE FROM device_tokens WHERE token=?").bind(device.token).run().catch(() => {});
  }
  return {ok,status:response.status,reason};
}

async function pushDevices(env, devices, payload) {
  let sent = 0, failed = 0, cleaned = 0;
  const results = [];
  for (let i=0; i<devices.length; i+=20) {
    const batch = devices.slice(i,i+20);
    const rows = await Promise.all(batch.map(async device => {
      try {
        const result = await sendSilentPush(env,device,payload);
        if (result.ok) sent += 1; else failed += 1;
        if (result.reason === "BadDeviceToken" || result.reason === "Unregistered") cleaned += 1;
        return {token:device.token,environment:device.environment,...result};
      } catch (error) {
        failed += 1;
        return {token:device.token,environment:device.environment,ok:false,error:String(error?.message || error)};
      }
    }));
    results.push(...rows);
  }
  return {total:devices.length,sent,failed,cleaned,results};
}

async function pushAllDevices(env, payload, filterEnvironment = null) {
  const result = filterEnvironment
    ? await env.DB.prepare("SELECT token,uniqe,environment,bundle_id FROM device_tokens WHERE environment=? ORDER BY updated_at DESC LIMIT 5000").bind(filterEnvironment).all()
    : await env.DB.prepare("SELECT token,uniqe,environment,bundle_id FROM device_tokens ORDER BY updated_at DESC LIMIT 5000").all();
  return pushDevices(env,result.results || [],payload);
}

function authorizedPushRequest(request, env) {
  const expected = String(env.PUSH_API_KEY || "");
  return expected.length >= 16 && request.headers.get("X-API-Key") === expected;
}

async function api(request, env, ctx) {
  if (!env.DB) return json(503, {ok:false,error:"d1_not_configured"});
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return json(204, {});
  if (method === "GET" && (path === "/" || path === "/health" || path === "/healthz")) {
    return json(200, {
      ok:true, service:"wordzap-api", hosting:"cloudflare-workers", storage:"d1",
      pvp:"durable-object-websocket", workersAI:Boolean(env.AI), version:"cloudflare-px1", ts:Date.now()
    });
  }
  if (method === "GET" && path === "/ready") {
    try { await env.DB.prepare("SELECT 1 AS ok").first(); return json(200,{ok:true,storage:"ready"}); }
    catch { return json(503,{ok:false,storage:"unavailable"}); }
  }
  if (path === "/pvp/socket" && request.headers.get("Upgrade") === "websocket") {
    const id = env.PVP.idFromName("global");
    return env.PVP.get(id).fetch(request);
  }

  if (method === "POST" && path === "/login") {
    await login(env.DB, await readJson(request));
    return json(200,{});
  }
  if (method === "POST" && path === "/login/isLoggedin") {
    const body = await readJson(request);
    return json(200, (await profileFor(env.DB, String(body.uniqe || ""))) ? {} : null);
  }
  if (method === "POST" && path === "/login/changeLanguage") {
    const body = await readJson(request);
    const uniqe = String(body.uniqe || "");
    if (!await profileFor(env.DB, uniqe)) return json(200,null);
    await env.DB.prepare("UPDATE profiles SET language=?,updated_at=? WHERE uniqe=?")
      .bind(String(body.language || "en").toLowerCase(), Date.now(), uniqe).run();
    return json(200,{});
  }
  if (method === "POST" && path === "/login/gender") {
    const body = await readJson(request);
    const p = await profileFor(env.DB, String(body.uniqe || ""));
    return json(200,{gender:p?.gender || null});
  }
  if (method === "POST" && path === "/words/word") {
    const body = await readJson(request);
    const p = await profileFor(env.DB, String(body.uniqe || ""));
    if (!p) return json(404,{error:"profile_not_found"});
    const value = await pickWord(p.language,5,[]);
    if (ctx && apnsConfigured(env)) {
      ctx.waitUntil(pushAllDevices(env,{
        type:"wordzap.refresh",
        args:{reason:"leaderboard_update"}
      }).catch(() => null));
    }
    return json(200,{value});
  }

  if (method === "POST" && path === "/words/getWord") {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    if (!profile) return json(404,{error:"profile_not_found"});
    const difficulty = difficultyKey(body.diffculty);
    const game = await gameWord(env.DB,profile,difficulty,env.APP_TIME_ZONE || DEFAULT_TZ);
    if (!game.row) return json(500,{error:"word_unavailable"});
    return json(200,{
      isTimeAttack:game.count % 5 === 0,
      number:Math.max(0,game.count - 1),
      word:{value:game.row.value,guesswork:safeArray(game.row.guesswork_json)}
    });
  }

  if (method === "POST" && path === "/words/addGuess") {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    if (!profile) return json(404,{error:"profile_not_found"});
    const difficulty = difficultyKey(body.diffculty);
    const day = dayKey(env.APP_TIME_ZONE || DEFAULT_TZ);
    const row = await env.DB.prepare(
      "SELECT word_index,value,guesswork_json FROM member_words WHERE day_key=? AND language=? AND difficulty=? AND uniqe=? ORDER BY word_index DESC LIMIT 1"
    ).bind(day,profile.language,difficulty,profile.uniqe).first();
    if (!row) return json(404,{error:"word_not_found"});
    const guess = normalizeWord(body.guess,profile.language);
    const guesses = safeArray(row.guesswork_json);
    guesses.push(guess);
    const done = guesses.length >= 5 || guess === normalizeWord(row.value,profile.language);
    await env.DB.prepare(
      "UPDATE member_words SET guesswork_json=?,done=?,updated_at=? WHERE day_key=? AND language=? AND difficulty=? AND uniqe=? AND word_index=?"
    ).bind(JSON.stringify(guesses),done ? 1 : 0,Date.now(),day,profile.language,difficulty,profile.uniqe,row.word_index).run();
    return json(200,{});
  }

  if (method === "POST" && path === "/score/getScore") {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    if (!profile) return json(200,{score:0});
    const row = await env.DB.prepare(
      "SELECT total_score FROM daily_members WHERE day_key=? AND language=? AND difficulty=? AND uniqe=?"
    ).bind(dayKey(env.APP_TIME_ZONE || DEFAULT_TZ),profile.language,difficultyKey(body.diffculty),profile.uniqe).first();
    return json(200,{score:Number(row?.total_score || 0)});
  }

  if (method === "POST" && path === "/score/score") {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    if (!profile) return json(404,{error:"profile_not_found"});
    const difficulty = difficultyKey(body.diffculty);
    const day = dayKey(env.APP_TIME_ZONE || DEFAULT_TZ);
    await ensureMember(env.DB,profile,difficulty,day);
    const row = await env.DB.prepare(
      "SELECT word_index,guesswork_json FROM member_words WHERE day_key=? AND language=? AND difficulty=? AND uniqe=? ORDER BY word_index DESC LIMIT 1"
    ).bind(day,profile.language,difficulty,profile.uniqe).first();
    if (!row) return json(404,{error:"word_not_found"});
    const guesses = safeArray(row.guesswork_json);
    const points = ((Number(row.word_index) + 1) % 5 === 0) ? 40 : 20;
    const delta = Math.max(0,5 * points - Math.max(0,guesses.length - 1) * points);
    await env.DB.prepare(
      "UPDATE daily_members SET total_score=total_score+?,updated_at=? WHERE day_key=? AND language=? AND difficulty=? AND uniqe=?"
    ).bind(delta,Date.now(),day,profile.language,difficulty,profile.uniqe).run();
    return json(200,{});
  }

  if (method === "POST" && path === "/score/scoreboard") {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    return json(200,profile ? await scoreboardFor(env.DB,profile.language) : []);
  }

  if (method === "POST" && path === "/score/place") {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    const out = {easy:null,medium:null,hard:null};
    if (!profile) return json(200,out);
    const rows = await env.DB.prepare(
      "SELECT difficulty,uniqe,total_score,created_at FROM daily_members WHERE day_key=? AND language=? ORDER BY difficulty ASC,total_score DESC,created_at ASC"
    ).bind(dayKey(env.APP_TIME_ZONE || DEFAULT_TZ),profile.language).all();
    const groups = new Map();
    for (const row of rows.results || []) {
      if (!groups.has(row.difficulty)) groups.set(row.difficulty,[]);
      groups.get(row.difficulty).push(row);
    }
    for (const [difficulty,members] of groups) {
      const index = members.findIndex(x => String(x.uniqe).toLowerCase() === profile.uniqe.toLowerCase());
      const key = difficultySlug(difficulty);
      if (index >= 0 && Object.prototype.hasOwnProperty.call(out,key)) out[key] = index + 1;
    }
    return json(200,out);
  }

  if (method === "POST" && path === "/score/premiumScore") {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    if (!profile) return json(404,{ok:false,error:"Member not found"});
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO premium_scores(language,uniqe,name,premium_score,created_at,updated_at) VALUES(?,?,?,1,?,?) " +
      "ON CONFLICT(language,uniqe) DO UPDATE SET name=excluded.name,premium_score=premium_score+1,updated_at=excluded.updated_at"
    ).bind(profile.language,profile.uniqe,profile.name || "",now,now).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && (path === "/score/getPremiumScore" || path === "/score/getAllPremiumScores")) {
    const body = await readJson(request);
    const profile = await profileFor(env.DB,String(body.uniqe || ""));
    if (!profile) {
      if (path.endsWith("getAllPremiumScores")) return json(200,[]);
      return json(200,{name:"unknowen",uniqe:String(body.uniqe || ""),value:0,rank:Number.MAX_SAFE_INTEGER});
    }
    const rows = await env.DB.prepare(
      "SELECT name,uniqe,premium_score,updated_at FROM premium_scores WHERE language=? ORDER BY premium_score DESC,updated_at ASC"
    ).bind(profile.language).all();
    const mapped = (rows.results || []).map((x,i) => ({
      name:x.name || "",uniqe:x.uniqe,value:Number(x.premium_score || 0),rank:i + 1
    }));
    if (path.endsWith("getAllPremiumScores")) return json(200,mapped);
    return json(200,mapped.find(x => x.uniqe === profile.uniqe) || {
      name:profile.name || "unknowen",uniqe:profile.uniqe,value:0,rank:Number.MAX_SAFE_INTEGER
    });
  }

  if (method === "POST" && path === "/devices/register") {
    const body = await readJson(request, 32 * 1024);
    const uniqe = String(body.uniqe || "").trim(), token = String(body.token || "").trim();
    if (!uniqe || !token) return json(400,{error:"missing uniqe or token"});
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO device_tokens(token,uniqe,environment,bundle_id,created_at,updated_at) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(token) DO UPDATE SET uniqe=excluded.uniqe,environment=excluded.environment,bundle_id=excluded.bundle_id,updated_at=excluded.updated_at"
    ).bind(token,uniqe,String(body.environment || "prod"),String(body.bundleId || env.APP_BUNDLE_ID || "com.barak.wordzap"),now,now).run();
    return json(200,{ok:true});
  }

  if (method === "GET" && path === "/devices") {
    if (!authorizedPushRequest(request,env)) return json(401,{error:"unauthorized"});
    const uniqe = String(url.searchParams.get("uniqe") || "").trim();
    const environment = String(url.searchParams.get("environment") || "").trim();
    let query = "SELECT token,uniqe,environment,bundle_id,created_at,updated_at FROM device_tokens";
    const filters = [], values = [];
    if (uniqe) { filters.push("uniqe=?"); values.push(uniqe); }
    if (environment) { filters.push("environment=?"); values.push(environment); }
    if (filters.length) query += " WHERE " + filters.join(" AND ");
    query += " ORDER BY updated_at DESC LIMIT 5000";
    const stmt = env.DB.prepare(query);
    const rows = values.length ? await stmt.bind(...values).all() : await stmt.all();
    return json(200,rows.results || []);
  }

  if (method === "POST" && path === "/push/silent") {
    if (!authorizedPushRequest(request,env)) return json(401,{error:"unauthorized"});
    const body = await readJson(request,32*1024);
    const token = String(body.token || "").trim();
    const environment = body.environment === "sandbox" ? "sandbox" : "prod";
    if (!token) return json(400,{error:"missing token"});
    const result = await sendSilentPush(env,{
      token,
      environment,
      bundle_id:String(body.bundleId || env.APP_BUNDLE_ID || "com.barak.wordzap")
    },{type:body.type,args:body.args});
    return json(200,{status:result.ok ? "sent" : "failed",apns:result});
  }

  if (method === "POST" && path === "/push/user") {
    if (!authorizedPushRequest(request,env)) return json(401,{error:"unauthorized"});
    const body = await readJson(request,32*1024);
    const uniqe = String(body.uniqe || "").trim();
    if (!uniqe) return json(400,{error:"missing uniqe"});
    const rows = await env.DB.prepare(
      "SELECT token,uniqe,environment,bundle_id FROM device_tokens WHERE uniqe=? ORDER BY updated_at DESC LIMIT 100"
    ).bind(uniqe).all();
    const result = await pushDevices(env,rows.results || [],{type:body.type,args:body.args});
    return json(200,{status:"done",count:result.total,...result});
  }

  if (method === "POST" && path === "/push/broadcast") {
    if (!authorizedPushRequest(request,env)) return json(401,{error:"unauthorized"});
    const body = await readJson(request,32*1024);
    const filterEnv = ["sandbox","prod"].includes(body.filterEnv) ? body.filterEnv : null;
    const result = await pushAllDevices(env,{type:body.type,args:body.args},filterEnv);
    return json(200,{status:"done",...result});
  }

  if (method === "GET" && path === "/pvp/word") {
    const matchId = String(url.searchParams.get("matchId") || "").trim();
    const length = Number.parseInt(url.searchParams.get("length") || "0",10);
    const lang = url.searchParams.get("lang") === "he" ? "he" : "en";
    if (!matchId || !Number.isFinite(length) || length <= 0) return json(400,{error:"matchId and length query params are required"});
    const old = await env.DB.prepare("SELECT language,word_length,value FROM pvp_words WHERE match_id=?").bind(matchId).first();
    if (old) {
      if (old.language !== lang || Number(old.word_length) !== length) return json(409,{error:"Word for this matchId was already created with a different lang/length"});
      return json(200,{value:old.value});
    }
    const value = await pickWord(lang,length,[]);
    await env.DB.prepare("INSERT OR IGNORE INTO pvp_words(match_id,language,word_length,value,created_at) VALUES(?,?,?,?,?)")
      .bind(matchId,lang,length,value,Date.now()).run();
    const stored = await env.DB.prepare("SELECT value FROM pvp_words WHERE match_id=?").bind(matchId).first();
    return json(200,{value:stored?.value || value});
  }
  if (method === "GET" && path === "/ai/health") {
    return json(200,{ok:true,warmed:true,backend:env.AI ? "workers-ai" : "wikipedia-fallback",storage:"cloudflare",modelLoadMode:"managed",modelOnDisk:false,tokenizerOnDisk:false});
  }
  if (method === "POST" && (path === "/ai/aiGuess" || path === "/ai/guess")) {
    return json(200, await aiGuess(env, await readJson(request,64*1024)));
  }

  return json(404,{error:"not_found"});
}

export class WordZapPvp {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  sockets() { return this.ctx.getWebSockets(); }
  meta(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  save(ws, meta) { ws.serializeAttachment(meta); }
  send(ws, event, data={}) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({event,data})); } catch {}
  }
  socket(peerId) {
    for (const ws of this.sockets()) if (this.meta(ws).peerId === peerId) return ws;
    return null;
  }
  async queue() { return (await this.ctx.storage.get("queue")) || []; }
  async setQueue(queue) { await this.ctx.storage.put("queue", queue.slice(0,10000)); }
  async getMatch(id) { return id ? await this.ctx.storage.get("match:" + id) : null; }
  async setMatch(match) { await this.ctx.storage.put("match:" + match.matchId, match); }
  async deleteMatch(id) { if (id) await this.ctx.storage.delete("match:" + id); }

  async leave(ws, notify=true) {
    const meta = this.meta(ws);
    let queue = await this.queue();
    queue = queue.filter(x => x.peerId !== meta.peerId && x.playerId !== meta.playerId);
    await this.setQueue(queue);
    if (meta.matchId) {
      const match = await this.getMatch(meta.matchId);
      if (match) {
        const other = match.players.find(x => x.peerId !== meta.peerId);
        if (notify && other) {
          const otherWs = this.socket(other.peerId);
          if (otherWs) this.send(otherWs,"pvp:opponentLeft",{matchId:meta.matchId,playerId:meta.playerId,reason:"disconnect"});
        }
        await this.deleteMatch(meta.matchId);
        if (this.env.DB) {
          await this.env.DB.prepare("DELETE FROM pvp_words WHERE match_id=?")
            .bind(meta.matchId).run().catch(() => {});
        }
        for (const player of match.players) {
          const pws = this.socket(player.peerId);
          if (pws) { const pm = this.meta(pws); pm.matchId = null; this.save(pws,pm); }
        }
      }
    }
    meta.matchId = null;
    this.save(ws,meta);
  }

  async joinQueue(ws, data) {
    const playerId = String(data.playerId || "").trim();
    const lang = data.lang === "he" ? "he" : "en";
    if (!playerId) return this.send(ws,"pvp:error",{message:"Missing playerId"});

    const meta = this.meta(ws);
    meta.playerId = playerId; meta.lang = lang; this.save(ws,meta);

    let queue = await this.queue();
    queue = queue.filter(x => x.peerId !== meta.peerId && x.playerId !== playerId);
    const index = queue.findIndex(x => x.lang === lang && x.playerId !== playerId && this.socket(x.peerId));

    if (index < 0) {
      queue.push({peerId:meta.peerId,playerId,lang,joinedAt:Date.now()});
      await this.setQueue(queue);
      return this.send(ws,"pvp:queue:waiting",{waiting:true,lang});
    }

    const opponent = queue.splice(index,1)[0];
    await this.setQueue(queue);
    const otherWs = this.socket(opponent.peerId);
    if (!otherWs) return this.joinQueue(ws,data);

    const matchId = crypto.randomUUID();
    const match = {
      matchId,lang,
      players:[{peerId:meta.peerId,playerId},{peerId:opponent.peerId,playerId:opponent.playerId}],
      rows:{[playerId]:0,[opponent.playerId]:0},
      coinflipResolved:false,starterPlayerId:null,currentTurnPlayerId:null,createdAt:Date.now()
    };
    await this.setMatch(match);

    meta.matchId = matchId; this.save(ws,meta);
    const om = this.meta(otherWs); om.matchId = matchId; this.save(otherWs,om);

    this.send(ws,"pvp:matchFound",{matchId,you:playerId,opponentId:opponent.playerId,lang});
    this.send(otherWs,"pvp:matchFound",{matchId,you:opponent.playerId,opponentId:playerId,lang});
  }

  async event(ws, msg) {
    const event = String(msg.event || msg.type || "");
    const data = msg.data && typeof msg.data === "object" ? msg.data : msg;

    if (event === "pvp:queue:join" || event === "queue.join") return this.joinQueue(ws,data);
    if (event === "pvp:queue:leave" || event === "queue.leave") {
      await this.leave(ws,true); return this.send(ws,"pvp:queue:left",{ok:true});
    }

    const meta = this.meta(ws);
    if (event === "pvp:join" || event === "join") {
      const match = await this.getMatch(String(data.matchId || ""));
      if (!match || !match.players.some(x => x.playerId === String(data.playerId || ""))) {
        return this.send(ws,"pvp:error",{message:"Match not found for given matchId"});
      }
      meta.playerId = String(data.playerId || meta.playerId || "");
      meta.matchId = match.matchId; meta.lang = match.lang; this.save(ws,meta); return;
    }

    const matchId = String(data.matchId || meta.matchId || "");
    const match = await this.getMatch(matchId);
    if (!match) return this.send(ws,"pvp:error",{message:"Match not found for given matchId"});
    const playerId = String(data.playerId || meta.playerId || "");
    if (!match.players.some(x => x.playerId === playerId)) return this.send(ws,"pvp:error",{message:"Player not registered in this match"});

    if (event === "pvp:coinflip" || event === "coinflip") {
      if (!match.coinflipResolved) {
        const starter = match.players[Math.floor(Math.random() * match.players.length)]?.playerId || playerId;
        match.coinflipResolved = true; match.starterPlayerId = starter; match.currentTurnPlayerId = starter;
        for (const p of match.players) match.rows[p.playerId] = 0;
        await this.setMatch(match);
      }
      return this.send(ws,"pvp:coinflipResult",{matchId,youStart:playerId === match.starterPlayerId,tie:false});
    }

    if (event === "pvp:typing" || event === "typing") {
      for (const p of match.players) {
        const pws = this.socket(p.peerId);
        if (pws) this.send(pws,"pvp:typing",{matchId,playerId,row:Number(data.row || 0),guess:String(data.guess || "")});
      }
      return;
    }

    if (event === "pvp:rowDone" || event === "rowDone") {
      if (match.currentTurnPlayerId && match.currentTurnPlayerId !== playerId) return this.send(ws,"pvp:error",{message:"Turn mismatch"});
      match.rows[playerId] = Number(match.rows[playerId] || 0) + 1;
      const other = match.players.find(x => x.playerId !== playerId);
      match.currentTurnPlayerId = other?.playerId || null;
      await this.setMatch(match);
      const payload = {matchId,nextPlayerId:other?.playerId || null,nextRow:other ? Number(match.rows[other.playerId] || 0) : 0};
      for (const p of match.players) {
        const pws = this.socket(p.peerId);
        if (pws) this.send(pws,"pvp:turn",payload);
      }
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return json(426,{ok:false,error:"websocket_required"});
    const pair = new WebSocketPair();
    const [client,server] = Object.values(pair);
    const meta = {peerId:crypto.randomUUID(),playerId:"",lang:"en",matchId:null};
    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    this.send(server,"welcome",{peerId:meta.peerId});
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 64 * 1024) {
      try { ws.close(1009,"payload too large"); } catch {}
      return;
    }
    let msg;
    try { msg = JSON.parse(message); }
    catch { return this.send(ws,"pvp:error",{message:"Invalid JSON"}); }
    try { await this.event(ws,msg); }
    catch (error) { this.send(ws,"pvp:error",{message:String(error?.message || error)}); }
  }

  async webSocketClose(ws) {
    await this.leave(ws,true).catch(() => {});
    try { ws.close(); } catch {}
  }

  async webSocketError(ws) { await this.leave(ws,true).catch(() => {}); }
}

export default {
  async fetch(request, env, ctx) {
    try { return await api(request,env,ctx); }
    catch (error) {
      const status = Number(error?.status || 500);
      return json(status,{
        ok:false,
        error:status >= 500 ? "server_error" : String(error?.message || error),
        detail:status >= 500 ? String(error?.message || error) : undefined
      });
    }
  }
};
