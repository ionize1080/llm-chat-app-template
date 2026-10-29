// Explicit opt-in smoke test; never part of npm test. Uses small paid requests.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { MODELS, extractText } from "../src/shared.mjs";
const base = process.argv[2];
if (!base?.startsWith("https://")) throw new Error("Pass the test origin");
const credentials = JSON.parse(
  await fs.readFile(new URL("../.credentials.json", import.meta.url)),
);
const post = (path, body, cookie = "") =>
  fetch(base + path, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
const messages = [{ role: "user", content: "请只回复：测试成功" }];
for (const body of [
  { search: true },
  { model: MODELS.find((m) => m.paid).id },
]) {
  assert.equal((await post("/api/chat", { ...body, messages })).status, 403);
}
console.log("Guest search + paid model denied: OK");
const login = await post("/api/login", credentials);
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
try {
  for (const model of MODELS.filter((m) => m.paid)) {
    const r = await post("/api/chat", { model: model.id, messages }, cookie);
    const raw = await r.text();
    const events = raw
      .split("\n")
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .flatMap((l) => {
        try {
          return [JSON.parse(l.slice(5))];
        } catch {
          return [];
        }
      });
    const text = events.map(extractText).join("");
    console.log(
      JSON.stringify({
        model: model.name,
        status: r.status,
        answer: text,
        error: events.find((e) => e.error)?.error || (!r.ok ? raw : undefined),
      }),
    );
    assert.equal(r.status, 200);
    assert(text.length > 0);
  }
  const r = await post(
    "/api/chat",
    {
      search: true,
      messages: [
        {
          role: "user",
          content:
            "查找 Cloudflare Workers 官方文档，简要介绍它的用途并引用来源。",
        },
      ],
    },
    cookie,
  );
  const raw = await r.text();
  const events = raw
    .split("\n")
    .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l.slice(5))];
      } catch {
        return [];
      }
    });
  const sources = events.flatMap((e) => e.sources || []),
    answer = events.map(extractText).join("");
  console.log(
    JSON.stringify({
      searchStatus: r.status,
      sources: sources.map((s) => s.url),
      answer: answer.slice(0, 400),
      error: !r.ok ? raw : undefined,
    }),
  );
  assert.equal(r.status, 200);
  assert(sources.length > 0);
  assert(answer.length > 0);
} finally {
  await post("/api/logout", {}, cookie);
}
