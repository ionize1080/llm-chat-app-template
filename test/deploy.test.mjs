import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
async function fixture(existing, args = []) {
  const dir = await fs.mkdtemp(join(tmpdir(), "veaix-deploy-test-"));
  const bin = join(dir, "node_modules", "wrangler", "bin");
  const log = join(dir, "result.json");
  await fs.mkdir(bin, { recursive: true });
  await fs.copyFile(new URL("../deploy.mjs", import.meta.url), join(dir, "deploy.mjs"));
  await fs.writeFile(join(bin, "wrangler.js"), `
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0]==='secret'&&args[1]==='list') {
  console.log(JSON.stringify(['AUTH_HASH','AUTH_SALT',...(process.env.VEAIX_TEST_EXISTING==='1'?['BYOK_ENCRYPTION_KEY']:[])].map(name=>({name,type:'secret_text'}))));
} else if(args[0]==='deploy') {
  const file = args[1]==='--secrets-file'?args[2]:null;
  const secret = file?JSON.parse(fs.readFileSync(file,'utf8')):null;
  fs.writeFileSync(process.env.VEAIX_TEST_LOG,JSON.stringify({file,keys:secret?Object.keys(secret):[],valid32:!!secret&&/^[a-f0-9]{64}$/.test(secret.BYOK_ENCRYPTION_KEY)}));
} else { console.error('Secret edit failed: latest Worker version is not deployed'); process.exit(1); }
`);
  try {
    const result = await execute(process.execPath, [join(dir, "deploy.mjs"), ...args], {
      env: { ...process.env, VEAIX_TEST_EXISTING: existing ? "1" : "0", VEAIX_TEST_LOG: log },
      windowsHide: true,
    });
    return { ...JSON.parse(await fs.readFile(log, "utf8")), output: result.stdout };
  } finally {
    for (const file of [log, join(bin, "wrangler.js"), join(dir, "deploy.mjs")]) await fs.unlink(file).catch(() => {});
    for (const folder of [bin, join(dir, "node_modules", "wrangler"), join(dir, "node_modules"), dir]) await fs.rmdir(folder).catch(() => {});
  }
}

test("first deployment uploads code and encryption secret atomically despite unpublished preview versions", async () => {
  const result = await fixture(false);
  assert.deepEqual(result.keys, ["BYOK_ENCRYPTION_KEY"]);
  assert.equal(result.valid32, true);
  assert(result.file);
  await assert.rejects(fs.access(result.file));
  assert(!/[a-f0-9]{64}/.test(result.output));
});

test("later deployments preserve the encryption secret and never upload a replacement", async () => {
  const result = await fixture(true);
  assert.equal(result.file, null);
  assert.deepEqual(result.keys, []);
});

test("production deployment rejects target overrides before touching secrets", async () => {
  await assert.rejects(fixture(false, ["--env", "staging"]), /production Worker only/);
});
