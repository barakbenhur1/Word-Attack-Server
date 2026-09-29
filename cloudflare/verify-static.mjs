import fs from "node:fs";

const worker = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

const requiredWorkerFragments = [
  'export class WordZapPvp',
  '"/healthz"',
  '"/ready"',
  '"/login"',
  '"/words/word"',
  '"/words/getWord"',
  '"/words/addGuess"',
  '"/score/getScore"',
  '"/score/score"',
  '"/score/scoreboard"',
  '"/score/place"',
  '"/score/premiumScore"',
  '"/score/getPremiumScore"',
  '"/score/getAllPremiumScores"',
  '"/devices/register"',
  '"/devices"',
  '"/push/silent"',
  '"/push/user"',
  '"/push/broadcast"',
  '"/pvp/word"',
  '"/pvp/socket"',
  '"/ai/health"',
  '"/ai/aiGuess"'
];

const requiredTables = [
  "profiles",
  "daily_members",
  "difficulty_words",
  "member_words",
  "premium_scores",
  "device_tokens",
  "pvp_words"
];

for (const fragment of requiredWorkerFragments) {
  if (!worker.includes(fragment)) throw new Error("Missing worker fragment: " + fragment);
}
for (const table of requiredTables) {
  if (!schema.includes("CREATE TABLE IF NOT EXISTS " + table)) {
    throw new Error("Missing D1 table: " + table);
  }
}

console.log("WordZap Cloudflare static verification OK");
