const DEFAULT_TZ = "Asia/Jerusalem";
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
      const word = normalizeWord(raw, lang);
      if (!validWord(word, lang, length) || blocked.has(word)) continue;
      if ((freq.get(word) || 0) === 0) continue;
      if (lang === "en" && (/^[A-Z]{2,}$/.test(raw) || /^[A-Z][a-z]+$/.test(raw))) continue;
      if (lang === "he" && (/[\u05F3\u05F4\u05BE]/u.test(raw) || /[ךםןףץ](?=.)/u.test(raw))) continue;
      const score = Math.min(5, 1 + (freq.get(word) || 0));
      const old = out.get(word);
      if (!old || old.score < score) out.set(word, {word, score});
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
  return history.every(row => {
    const guess = normalizeWord(row.word, lang);
    return validWord(guess, lang, 5) && wordleFeedback(guess, candidate) === String(row.feedback || "");
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

async function api(request, env) {
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
    return json(200,{value:await pickWord(p.language,5,[])});
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
