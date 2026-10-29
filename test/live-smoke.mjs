import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { MODELS } from "../src/shared.mjs";
const base = process.argv[2];
if (!base) throw new Error("Pass test deployment URL");
const credentials = JSON.parse(await fs.readFile(".credentials.json", "utf8"));
let cookie = "";
async function call(path, method = "GET", body, auth = false) {
  return fetch(base + path, {
    method,
    headers: {
      origin: base,
      "content-type": "application/json",
      ...(auth ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120000),
  });
}
assert.equal((await call("/api/history")).status, 401);
const bad = await call("/api/login", "POST", {
  email: "other@example.com",
  password: credentials.password,
});
assert.equal(bad.status, 401);
const login = await call("/api/login", "POST", credentials);
assert.equal(login.status, 200, await login.clone().text());
cookie = login.headers.get("set-cookie").split(";")[0];
assert.match(login.headers.get("set-cookie"), /HttpOnly/);
assert.match(login.headers.get("set-cookie"), /Secure/);
console.log(
  "PASS login, restricted email, secure cookie, guest history isolation",
);
const id = crypto.randomUUID();
const record = {
  title: "自动化验证（临时）",
  messages: [
    { role: "user", content: "测试记录" },
    { role: "assistant", content: "保存成功" },
  ],
  model: MODELS[0].id,
};
assert.equal(
  (await call("/api/history/" + id, "PUT", record, true)).status,
  200,
);
const stored = await (
  await call("/api/history/" + id, "GET", null, true)
).json();
assert.deepEqual(stored.messages, record.messages);
assert.equal(
  (await call("/api/history/" + id, "DELETE", null, true)).status,
  200,
);
console.log("PASS history save/read/delete");
for (const m of MODELS) {
  const r = await call("/api/chat", "POST", {
    model: m.id,
    messages: [{ role: "user", content: "只回复一句中文问候，不要思考过程。" }],
  });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.match(text, /data:/);
  await fs.mkdir("test-output", { recursive: true });
  await fs.writeFile("test-output/" + m.id.split("/").pop() + ".sse", text);
  console.log("MODEL", m.name, r.status, text.slice(0, 180));
}
const image = await call("/api/image", "POST", {
  prompt: "A single green leaf on a white background, minimal photograph",
});
const imageBody = await image.json();
assert.equal(image.status, 200, JSON.stringify(imageBody));
assert.match(imageBody.url, /^data:image\/jpeg/);
await fs.writeFile(
  "test-output/generated.jpg",
  Buffer.from(imageBody.url.split(",")[1], "base64"),
);
console.log("PASS image generation", imageBody.url.length);
const vision = await call("/api/chat", "POST", {
  model: MODELS[1].id,
  messages: [
    { role: "user", content: "用一句话描述这张图片。", image: imageBody.url },
  ],
});
const visionText = await vision.text();
assert.equal(vision.status, 200, visionText);
await fs.writeFile("test-output/vision.sse", visionText);
console.log("PASS image understanding", visionText.slice(0, 180));
assert.equal((await call("/api/logout", "POST", {}, true)).status, 200);
assert.equal((await call("/api/history", "GET", null, true)).status, 401);
console.log("PASS logout invalidates session");
