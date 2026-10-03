const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

function authorized(req) {
  const expected = String(process.env.MIGRATION_ADMIN_TOKEN || "");
  const auth = String(req.get("authorization") || "");
  return expected.length >= 24 && auth === "Bearer " + expected;
}

function targetBase() {
  return String(
    process.env.CLOUDFLARE_MIGRATION_BASE_URL ||
      "https://wordzap-api.yamora-training-collector.workers.dev"
  ).replace(/\/+$/,"");
}

async function cloudflareRequest(path, options = {}) {
  const token = String(process.env.MIGRATION_ADMIN_TOKEN || "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(targetBase() + path, {
      ...options,
      signal: controller.signal,
      headers: {
        "authorization": "Bearer " + token,
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      throw new Error(
        "Cloudflare " + path + " returned " + response.status + ": " +
        (body?.error || text.slice(0,200))
      );
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function emptyExpected() {
  return {
    profiles: 0,
    daily_members: 0,
    difficulty_words: 0,
    member_words: 0,
    premium_scores: 0,
    device_tokens: 0
  };
}

function countLanguageDocument(doc, expected) {
  for (const premium of Array.isArray(doc?.premium) ? doc.premium : []) {
    if (String(premium?.uniqe || "").trim()) expected.premium_scores += 1;
  }

  for (const day of Array.isArray(doc?.days) ? doc.days : []) {
    if (!String(day?.value || "").trim()) continue;
    for (const difficulty of Array.isArray(day?.difficulties) ? day.difficulties : []) {
      if (!String(difficulty?.value || "").trim()) continue;

      for (const word of Array.isArray(difficulty?.words) ? difficulty.words : []) {
        if (String(word || "").trim()) expected.difficulty_words += 1;
      }

      for (const member of Array.isArray(difficulty?.members) ? difficulty.members : []) {
        if (!String(member?.uniqe || "").trim()) continue;
        expected.daily_members += 1;
        for (const word of Array.isArray(member?.words) ? member.words : []) {
          if (String(word?.value || "").trim()) expected.member_words += 1;
        }
      }
    }
  }
}

async function postItems(kind, items) {
  if (!items.length) return;
  await cloudflareRequest("/internal/migration/import", {
    method: "POST",
    body: JSON.stringify({kind,items})
  });
}

async function migrateCollection(collection, kind, onItem, batchSize = 50) {
  let batch = [];
  const cursor = collection.find({}, {projection:{_id:0}}).batchSize(batchSize);

  for await (const doc of cursor) {
    onItem(doc);
    batch.push(doc);
    if (batch.length >= batchSize) {
      await postItems(kind,batch);
      batch = [];
    }
  }

  if (batch.length) await postItems(kind,batch);
}

router.get("/source-counts", async (req,res) => {
  if (!authorized(req)) return res.status(401).json({error:"unauthorized"});
  try {
    await mongoose.connection.asPromise();
    const db = mongoose.connection.db;
    const [profiles,languages,devices] = await Promise.all([
      db.collection("profileschemas").countDocuments({}),
      db.collection("languagesschemas").countDocuments({}),
      db.collection("devices").countDocuments({}).catch(() => 0)
    ]);
    res.json({ok:true,source:{profiles,languages,devices}});
  } catch (error) {
    res.status(500).json({ok:false,error:"source_count_failed"});
  }
});

async function runMigration({allowNonEmpty=false} = {}) {
  await mongoose.connection.asPromise();
  const db = mongoose.connection.db;

  const before = await cloudflareRequest("/internal/migration/counts", {method:"GET"});
  const beforeCounts = before?.counts || {};
  const nonEmpty = Object.entries(beforeCounts).filter(([,value]) => Number(value || 0) !== 0);

  if (nonEmpty.length && !allowNonEmpty) {
    const error = new Error("target_not_empty");
    error.code = "target_not_empty";
    error.counts = beforeCounts;
    throw error;
  }

  const expected = emptyExpected();

  await migrateCollection(
    db.collection("profileschemas"),
    "profiles",
    profile => {
      if (String(profile?.uniqe || "").trim()) expected.profiles += 1;
    },
    50
  );

  await migrateCollection(
    db.collection("languagesschemas"),
    "languages",
    language => countLanguageDocument(language,expected),
    1
  );

  await migrateCollection(
    db.collection("devices"),
    "devices",
    device => {
      if (String(device?.token || "").trim() && String(device?.uniqe || "").trim()) {
        expected.device_tokens += 1;
      }
    },
    50
  ).catch(async error => {
    if (!/ns not found|namespace/i.test(String(error?.message || error))) throw error;
  });

  const after = await cloudflareRequest("/internal/migration/counts", {method:"GET"});
  const actual = after?.counts || {};
  const mismatches = Object.keys(expected)
    .filter(key => Number(actual[key] || 0) !== Number(expected[key] || 0))
    .map(key => ({table:key,expected:expected[key],actual:Number(actual[key] || 0)}));

  if (mismatches.length) {
    const error = new Error("reconciliation_failed");
    error.code = "reconciliation_failed";
    error.expected = expected;
    error.actual = actual;
    error.mismatches = mismatches;
    throw error;
  }

  return {
    ok:true,
    migrated:true,
    target:targetBase(),
    expected,
    actual
  };
}

router.post("/run", async (req,res) => {
  if (!authorized(req)) return res.status(401).json({error:"unauthorized"});
  try {
    res.json(await runMigration({allowNonEmpty:req.query.resume === "1"}));
  } catch (error) {
    if (error?.code === "target_not_empty") {
      return res.status(409).json({
        ok:false,
        error:"target_not_empty",
        counts:error.counts,
        hint:"Retry with ?resume=1 only after reviewing the existing D1 state."
      });
    }
    if (error?.code === "reconciliation_failed") {
      return res.status(409).json({
        ok:false,
        error:"reconciliation_failed",
        expected:error.expected,
        actual:error.actual,
        mismatches:error.mismatches
      });
    }
    console.error("[migration] failed:", error?.message || error);
    res.status(500).json({ok:false,error:"migration_failed"});
  }
});

if (process.env.MIGRATION_AUTORUN === "1") {
  mongoose.connection.once("connected", () => {
    setTimeout(() => {
      runMigration({allowNonEmpty:true})
        .then(result => {
          console.log("[migration] autorun complete", JSON.stringify({
            ok:result.ok,
            expected:result.expected,
            actual:result.actual
          }));
        })
        .catch(error => {
          console.error("[migration] autorun failed", JSON.stringify({
            code:error?.code || "migration_failed",
            message:String(error?.message || error),
            expected:error?.expected,
            actual:error?.actual,
            mismatches:error?.mismatches
          }));
        });
    }, 1500);
  });
}

module.exports = router;
module.exports.runMigration = runMigration;
