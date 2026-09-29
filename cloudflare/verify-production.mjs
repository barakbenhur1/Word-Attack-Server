import process from "node:process";

const base = String(process.env.WORDZAP_BASE_URL || "").replace(/\/+$/,"");
if (!base) throw new Error("WORDZAP_BASE_URL is required.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getJson(path, init) {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) {
    throw new Error(path + " returned " + response.status + ": " + text);
  }
  return body;
}

const health = await getJson("/healthz");
assert(health.ok === true, "healthz did not return ok=true");
assert(health.storage === "d1", "healthz is not using D1");
assert(health.pvp === "durable-object-websocket", "healthz is not using Durable Object PVP");

const ready = await getJson("/ready");
assert(ready.ok === true && ready.storage === "ready", "D1 readiness failed");

const aiHealth = await getJson("/ai/health");
assert(aiHealth.ok === true, "AI health failed");

if (process.env.WORDZAP_VERIFY_AI !== "0") {
  const ai = await getJson("/ai/aiGuess", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({lang:"en",difficulty:"medium",history:[]})
  });
  assert(typeof ai.guess === "string" && /^[a-zA-Z]{5}$/.test(ai.guess), "AI guess is not a five-letter English word");
}


if (process.env.WORDZAP_VERIFY_STATE === "1") {
  const uniqe = "smoke-state-" + Date.now().toString(36);
  const post = (path, body) => getJson(path, {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body)
  });

  await post("/login", {
    uniqe,
    email:"smoke@example.invalid",
    name:"Smoke",
    gender:"other",
    language:"en"
  });

  const loggedIn = await post("/login/isLoggedin", {uniqe});
  assert(loggedIn && typeof loggedIn === "object", "login/isLoggedin did not find smoke profile");

  const gender = await post("/login/gender", {uniqe});
  assert(gender.gender === "other", "login/gender did not preserve profile data");

  const game = await post("/words/getWord", {uniqe,diffculty:"Easy"});
  assert(game?.word?.value && /^[a-zA-Z]{4}$/.test(game.word.value), "words/getWord did not return a four-letter Easy word");
  assert(Array.isArray(game.word.guesswork), "words/getWord guesswork is not an array");

  await post("/words/addGuess", {
    uniqe,
    diffculty:"Easy",
    guess:game.word.value
  });

  await post("/score/score", {uniqe,diffculty:"Easy"});
  const score = await post("/score/getScore", {uniqe,diffculty:"Easy"});
  assert(Number(score.score) > 0, "score/getScore was not incremented");

  const board = await post("/score/scoreboard", {uniqe});
  assert(Array.isArray(board) && board.length > 0, "score/scoreboard returned no day data");

  const place = await post("/score/place", {uniqe});
  assert(place.easy === 1, "score/place did not rank the only smoke player first");

  await post("/score/premiumScore", {uniqe});
  const premium = await post("/score/getPremiumScore", {uniqe});
  assert(premium.value === 1 && premium.rank === 1, "premium score state mismatch");

  const premiumAll = await post("/score/getAllPremiumScores", {uniqe});
  assert(Array.isArray(premiumAll) && premiumAll.some(x => x.uniqe === uniqe && x.value === 1), "premium leaderboard missing smoke player");
}


if (process.env.WORDZAP_VERIFY_HEBREW === "1") {
  const matchId = "smoke-he-" + Date.now().toString(36);
  const word = await getJson(
    "/pvp/word?matchId=" + encodeURIComponent(matchId) + "&length=5&lang=he"
  );
  assert(
    typeof word.value === "string" && /^[\u05D0-\u05EA]{5}$/u.test(word.value),
    "Hebrew PVP word is not exactly five Hebrew letters"
  );
}

const wsBase = new URL(base);
wsBase.protocol = wsBase.protocol === "http:" ? "ws:" : "wss:";
wsBase.pathname = "/pvp/socket";
wsBase.search = "";
wsBase.hash = "";

function socketHarness(name) {
  const ws = new WebSocket(wsBase.toString());
  const waiters = [];
  const backlog = [];

  ws.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const index = waiters.findIndex(waiter =>
      waiter.event === message.event && (!waiter.predicate || waiter.predicate(message.data || {}))
    );
    if (index >= 0) {
      const [waiter] = waiters.splice(index,1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.data || {});
    } else {
      backlog.push(message);
    }
  });

  function waitOpen(timeoutMs=10000) {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error(name+" WebSocket open timeout")),timeoutMs);
      ws.addEventListener("open",()=>{clearTimeout(timer);resolve();},{once:true});
      ws.addEventListener("error",()=>{clearTimeout(timer);reject(new Error(name+" WebSocket error"));},{once:true});
    });
  }

  function waitFor(event, predicate=null, timeoutMs=10000) {
    const index = backlog.findIndex(message =>
      message.event === event && (!predicate || predicate(message.data || {}))
    );
    if (index >= 0) return Promise.resolve(backlog.splice(index,1)[0].data || {});

    return new Promise((resolve,reject) => {
      const waiter = {event,predicate,resolve,reject,timer:null};
      waiter.timer=setTimeout(()=>{
        const i=waiters.indexOf(waiter);
        if(i>=0) waiters.splice(i,1);
        reject(new Error(name+" timeout waiting for "+event));
      },timeoutMs);
      waiters.push(waiter);
    });
  }

  function send(event,data={}) {
    ws.send(JSON.stringify({event,data}));
  }

  return {ws,waitOpen,waitFor,send};
}

const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const p1 = socketHarness("p1");
const p2 = socketHarness("p2");
let p2Reconnect = null;

try {
  await Promise.all([p1.waitOpen(),p2.waitOpen()]);
  await Promise.all([p1.waitFor("welcome"),p2.waitFor("welcome")]);

  const p1Id = "smoke-a-" + id;
  const p2Id = "smoke-b-" + id;

  p1.send("pvp:queue:join",{playerId:p1Id,lang:"en"});
  await p1.waitFor("pvp:queue:waiting");

  p2.send("pvp:queue:join",{playerId:p2Id,lang:"en"});
  const [m1,m2] = await Promise.all([
    p1.waitFor("pvp:matchFound"),
    p2.waitFor("pvp:matchFound")
  ]);

  assert(m1.matchId && m1.matchId === m2.matchId, "PVP peers received different match ids");
  assert(m1.opponentId === p2Id && m2.opponentId === p1Id, "PVP opponent ids are incorrect");
  const matchId = m1.matchId;

  p1.send("pvp:join",{matchId,playerId:p1Id});
  p2.send("pvp:join",{matchId,playerId:p2Id});

  p1.send("pvp:coinflip",{matchId,playerId:p1Id,ticket:1});
  p2.send("pvp:coinflip",{matchId,playerId:p2Id,ticket:2});
  const [coin1,coin2] = await Promise.all([
    p1.waitFor("pvp:coinflipResult",x=>x.matchId===matchId),
    p2.waitFor("pvp:coinflipResult",x=>x.matchId===matchId)
  ]);
  assert(Boolean(coin1.youStart) !== Boolean(coin2.youStart), "Coin flip did not produce exactly one starter");

  const [word1,word2] = await Promise.all([
    getJson("/pvp/word?matchId="+encodeURIComponent(matchId)+"&length=5&lang=en"),
    getJson("/pvp/word?matchId="+encodeURIComponent(matchId)+"&length=5&lang=en")
  ]);
  assert(word1.value && word1.value === word2.value, "PVP shared word is not stable");
  assert(/^[a-zA-Z]{5}$/.test(word1.value), "PVP shared word is invalid");

  p1.send("pvp:typing",{matchId,playerId:p1Id,row:0,guess:"apple"});
  const typing = await p2.waitFor("pvp:typing",x=>x.matchId===matchId && x.playerId===p1Id);
  assert(typing.row === 0 && typing.guess === "apple", "Typing relay payload mismatch");

  const starter = coin1.youStart ? {socket:p1,id:p1Id,otherId:p2Id} : {socket:p2,id:p2Id,otherId:p1Id};
  const turn1 = p1.waitFor("pvp:turn",x=>x.matchId===matchId);
  const turn2 = p2.waitFor("pvp:turn",x=>x.matchId===matchId);
  starter.socket.send("pvp:rowDone",{matchId,playerId:starter.id,row:0});
  const [t1,t2] = await Promise.all([turn1,turn2]);
  console.log("[smoke] turn relay", JSON.stringify({
    starter:starter.id,
    expectedNext:starter.otherId,
    p1:t1,
    p2:t2
  }));
  assert(t1.nextPlayerId === starter.otherId && t2.nextPlayerId === starter.otherId, "Turn relay did not advance to opponent");

  // Simulate a transient network loss after matchmaking. The Durable Object
  // must preserve the match for its reconnect grace window and let a new
  // WebSocket reclaim the same stable player identity.
  const reconnectNotice = p1.waitFor(
    "pvp:peerReconnecting",
    x => x.matchId === matchId && x.playerId === p2Id
  );
  p2.ws.close(4001,"reconnect smoke");
  const notice = await reconnectNotice;
  assert(Number(notice.graceMs || 0) >= 10000, "Reconnect grace was not advertised");

  p2Reconnect = socketHarness("p2-reconnect");
  await p2Reconnect.waitOpen();
  await p2Reconnect.waitFor("welcome");
  p2Reconnect.send("pvp:join",{matchId,playerId:p2Id});
  const reconnected = await p2Reconnect.waitFor(
    "pvp:reconnected",
    x => x.matchId === matchId && x.playerId === p2Id
  );
  assert(reconnected.matchId === matchId, "Reconnected peer did not reclaim its match");

  p2Reconnect.send("pvp:typing",{matchId,playerId:p2Id,row:0,guess:"crane"});
  const typingAfterReconnect = await p1.waitFor(
    "pvp:typing",
    x => x.matchId === matchId && x.playerId === p2Id
  );
  assert(typingAfterReconnect.guess === "crane", "PVP relay failed after reconnect");

  p1.send("pvp:queue:leave",{});
  p2Reconnect.send("pvp:queue:leave",{});
  await new Promise(resolve=>setTimeout(resolve,250));

  console.log(JSON.stringify({
    ok:true,
    service:health.service,
    backend:health.hosting,
    workersAI:health.workersAI,
    pvpMatchId:matchId,
    pvpWord:word1.value
  },null,2));
} finally {
  try { p1.ws.close(1000,"smoke complete"); } catch {}
  try { p2.ws.close(1000,"smoke complete"); } catch {}
  try { p2Reconnect?.ws.close(1000,"smoke complete"); } catch {}
}
