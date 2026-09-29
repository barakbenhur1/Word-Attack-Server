import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = path.join(root, "wrangler.generated.toml");

const keys = [
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_P8",
  "PUSH_API_KEY",
  "MIGRATION_ADMIN_TOKEN"
];

function putSecret(key, value) {
  return new Promise((resolve,reject) => {
    const child = spawn(
      "npx",
      ["--yes","wrangler@latest","secret","put",key,"--config",config],
      {cwd:root,env:process.env,stdio:["pipe","inherit","inherit"]}
    );
    child.on("error",reject);
    child.on("close",code => {
      if (code === 0) resolve();
      else reject(new Error("wrangler secret put " + key + " failed with code " + code));
    });
    child.stdin.end(String(value));
  });
}

let configured = 0;
for (const key of keys) {
  const value = String(process.env[key] || "");
  if (!value) {
    console.log("[cloudflare] secret not provided; skipping " + key);
    continue;
  }
  await putSecret(key,value);
  configured += 1;
  console.log("[cloudflare] configured secret " + key);
}

console.log(JSON.stringify({ok:true,configured,totalSupported:keys.length}));
