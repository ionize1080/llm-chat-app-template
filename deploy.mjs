import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrangler = fileURLToPath(new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url));
if (process.argv.length > 2)
  throw new Error("This deployment script targets the production Worker only and accepts no arguments.");

function run(args, { input, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"],
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Wrangler ${args[0]} failed (${code}). Deployment stopped.`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

// Workers Builds already holds its deployment token. Only create the encryption
// secret on first installation; subsequent builds MUST preserve its exact value.
// Never print it, include its value in an argument, or put it in the repository.
const secrets = JSON.parse(await run(["secret", "list", "--format", "json"], { capture: true }));
if (!Array.isArray(secrets)) throw new Error("Could not verify existing Worker secrets.");
for (const name of ["AUTH_HASH", "AUTH_SALT"]) {
  if (!secrets.some((secret) => secret.name === name))
    throw new Error(`Existing authentication secret ${name} is missing. Deployment stopped.`);
}
if (!secrets.some((secret) => secret.name === "BYOK_ENCRYPTION_KEY")) {
  // secret put cannot run when the newest Worker version is an unpublished
  // preview. Upload the new code and its encryption secret as one version.
  // Cloudflare preserves all secrets not included in this file.
  console.log("Deploying code and the initial BYOK encryption secret together.");
  const directory = await mkdtemp(join(tmpdir(), "veaix-deploy-"));
  const secretFile = join(directory, "secrets.json");
  try {
    await writeFile(secretFile, JSON.stringify({ BYOK_ENCRYPTION_KEY: randomBytes(32).toString("hex") }), { mode: 0o600 });
    await run(["deploy", "--secrets-file", secretFile]);
  } finally {
    await unlink(secretFile).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
} else {
  console.log("Preserving the existing BYOK encryption secret.");
  await run(["deploy"]);
}
