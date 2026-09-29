import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = String(
  process.env.D1_MIGRATION_MANIFEST || path.join(root, "migration-manifest.json")
);
const base = String(process.env.WORDZAP_BASE_URL || "").replace(/\/+$/,"");
const token = String(process.env.MIGRATION_ADMIN_TOKEN || "");

if (!base) throw new Error("WORDZAP_BASE_URL is required.");
if (token.length < 24) throw new Error("MIGRATION_ADMIN_TOKEN is required.");

const manifest = JSON.parse(await fs.readFile(manifestPath,"utf8"));
if (!manifest?.counts || typeof manifest.counts !== "object") {
  throw new Error("Migration manifest is missing counts.");
}

const response = await fetch(base + "/internal/migration/counts", {
  headers:{authorization:"Bearer " + token}
});
const text = await response.text();
if (!response.ok) {
  throw new Error("Migration counts endpoint returned " + response.status + ": " + text);
}
const remote = JSON.parse(text);
const mismatches = [];

for (const [table,expectedRaw] of Object.entries(manifest.counts)) {
  const expected = Number(expectedRaw || 0);
  const actual = Number(remote?.counts?.[table] ?? -1);
  if (actual !== expected) mismatches.push({table,expected,actual});
}

if (mismatches.length) {
  console.error(JSON.stringify({ok:false,mismatches,expected:manifest.counts,actual:remote.counts},null,2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok:true,
  sourceDatabase:manifest.sourceDatabase,
  generatedAt:manifest.generatedAt,
  counts:remote.counts
},null,2));
