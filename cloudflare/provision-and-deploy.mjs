import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(root, "wrangler.toml.example");
const generatedPath = path.join(root, "wrangler.generated.toml");
const schemaPath = path.join(root, "schema.sql");
const deploymentManifestPath = path.join(root, "deployment-manifest.json");

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error("CLOUDFLARE_API_TOKEN is required.");
}

function run(args, {capture=false, tee=false} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--yes", "wrangler@latest", ...args], {
      cwd: root,
      env: process.env,
      stdio: capture ? ["ignore","pipe","pipe"] : "inherit"
    });

    let stdout = "", stderr = "";
    if (capture) {
      child.stdout.on("data", chunk => {
        const value = String(chunk);
        stdout += value;
        if (tee) process.stdout.write(value);
      });
      child.stderr.on("data", chunk => {
        const value = String(chunk);
        stderr += value;
        if (tee) process.stderr.write(value);
      });
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

  let baseUrl = null;
  if (process.env.CLOUDFLARE_DEPLOY_DRY_RUN === "1") {
    await run(["deploy","--dry-run","--config",generatedPath]);
    console.log("[cloudflare] dry-run complete; no Worker deployed.");
  } else {
    const deployed = await run(["deploy","--config",generatedPath], {capture:true,tee:true});
    const deploymentText = deployed.stdout + "\n" + deployed.stderr;
    const match = deploymentText.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev\/?/);
    baseUrl = match ? match[0].replace(/\/$/,"") : null;
    console.log("[cloudflare] Worker deployment completed.");
    if (baseUrl) console.log("[cloudflare] Worker URL:", baseUrl);
  }

  const {stdout} = await run(["d1","info","wordzap","--json"], {capture:true});
  console.log("[cloudflare] D1 info:", stdout.trim());

  await fs.writeFile(deploymentManifestPath, JSON.stringify({
    version:1,
    workerName:"wordzap-api",
    databaseName:"wordzap",
    databaseId:id,
    baseUrl,
    deployed:process.env.CLOUDFLARE_DEPLOY_DRY_RUN !== "1",
    generatedAt:new Date().toISOString()
  }, null, 2) + "\n", {mode:0o600});
  console.log("[cloudflare] Deployment manifest:", deploymentManifestPath);
} finally {
  if (process.env.KEEP_GENERATED_WRANGLER !== "1") {
    await fs.rm(generatedPath, {force:true});
  }
}
