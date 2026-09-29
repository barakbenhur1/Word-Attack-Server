import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const root = path.resolve(process.cwd(), "cloudflare");
const templatePath = path.join(root, "wrangler.toml.example");
const generatedPath = path.join(root, "wrangler.generated.toml");
const schemaPath = path.join(root, "schema.sql");

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error("CLOUDFLARE_API_TOKEN is required.");
}

function run(args, {capture=false} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--yes", "wrangler@latest", ...args], {
      cwd: root,
      env: process.env,
      stdio: capture ? ["ignore","pipe","pipe"] : "inherit"
    });

    let stdout = "", stderr = "";
    if (capture) {
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
    }

    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({stdout,stderr});
      reject(new Error(
        "wrangler " + args.join(" ") + " failed with code " + code +
        (capture && stderr ? "\n" + stderr : "")
      ));
    });
  });
}

async function databaseId() {
  const {stdout} = await run(["d1","list","--json"], {capture:true});
  const rows = JSON.parse(stdout || "[]");
  const database = rows.find(row => row.name === "wordzap");
  return database?.uuid || database?.id || null;
}

let id = await databaseId();
if (!id) {
  console.log("[cloudflare] D1 wordzap not found; creating it.");
  await run(["d1","create","wordzap"]);
  id = await databaseId();
}

if (!id) throw new Error("Unable to resolve the wordzap D1 database id.");

const template = await fs.readFile(templatePath, "utf8");
if (!template.includes("REPLACE_WITH_D1_DATABASE_ID")) {
  throw new Error("wrangler.toml.example is missing the D1 placeholder.");
}

const generated = template.replace("REPLACE_WITH_D1_DATABASE_ID", id);
await fs.writeFile(generatedPath, generated, {mode:0o600});

try {
  console.log("[cloudflare] D1 database id resolved:", id);
  await run([
    "d1","execute","wordzap","--remote",
    "--file",schemaPath,
    "--yes",
    "--config",generatedPath
  ]);

  if (process.env.CLOUDFLARE_DEPLOY_DRY_RUN === "1") {
    await run(["deploy","--dry-run","--config",generatedPath]);
    console.log("[cloudflare] dry-run complete; no Worker deployed.");
  } else {
    await run(["deploy","--config",generatedPath]);
    console.log("[cloudflare] Worker deployment completed.");
  }

  const {stdout} = await run(["d1","info","wordzap","--json"], {capture:true});
  console.log("[cloudflare] D1 info:", stdout.trim());
} finally {
  await fs.rm(generatedPath, {force:true});
}
