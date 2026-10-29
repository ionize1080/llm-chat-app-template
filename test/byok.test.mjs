import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.mjs";
import { sealKey, openKey, saveKey, getKey, listKeys, deleteKey, ensureKeyStore, storageAvailable } from "../src/byok.mjs";
import { parseRemoteModel, getCatalog } from "../src/catalog.mjs";

const owner = "ionize@163.com";
const rate = { limit: async () => ({ success: true }) };
const secret = "f1".repeat(32);
function memoryDB() {
  const keys = new Map();
  return {
    keys,
    prepare(sql) {
      return { async run() { return { success: true }; }, bind(...args) {
        return {
          async first() {
            if (sql.includes("sessions")) return { hash: "valid" };
            if (sql.includes("daily_usage")) return { used: 1 };
            return keys.get(args[0] + ":" + args[1]) || null;
          },
          async all() {
            return { results: [...keys.values()].filter((r) => r.owner === args[0]) };
          },
          async run() {
            if (sql.startsWith("INSERT INTO byok_keys")) {
              const [owner, provider, ciphertext, iv, mask, updated] = args;
              keys.set(owner + ":" + provider, { owner, provider, ciphertext, iv, mask, updated });
            } else if (sql.startsWith("DELETE FROM byok_keys")) keys.delete(args[0] + ":" + args[1]);
            return { success: true };
          },
        };
      } };
    },
  };
}
const environment = () => ({ DB: memoryDB(), RATE: rate, LOGIN_RATE: rate, BYOK_ENCRYPTION_KEY: secret });
const request = (path, method = "GET", body, signed = true) => {
  const headers = { origin: "https://llm.veaix.com", "content-type": "application/json" };
  if (signed) headers.cookie = "__Host-veaix=" + "a".repeat(64);
  const value = new Request("https://llm.veaix.com" + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  Object.defineProperty(value, "cf", { value: { country: "US" } });
  return value;
};

test("AES-GCM encrypts with random IV and binds owner/provider", async () => {
  const env = environment();
  const raw = "sk-unit-test-only-123456789";
  const a = await sealKey(env, owner, "openai", raw);
  const b = await sealKey(env, owner, "openai", raw);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert(!JSON.stringify(a).includes(raw));
  assert.equal(await openKey(env, owner, "openai", a), raw);
  await assert.rejects(openKey(env, "other-user", "openai", a));
  await assert.rejects(openKey(env, owner, "anthropic", a));
  const tampered = { ...a, ciphertext: a.ciphertext.slice(0, -8) + "AAAAAAAA" };
  await assert.rejects(openKey(env, owner, "openai", tampered));
});

test("key persistence survives sessions but exposes only suffix and metadata", async () => {
  const env = environment(), raw = "sk-unit-persist-123456789";
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-test", owned_by: "openai" }] });
  try {
    const result = await saveKey(env, owner, "openai", raw);
    assert.equal(result.modelCount, 1);
    assert.equal((await getKey(env, owner, "openai")).key, raw);
    assert(!JSON.stringify([...env.DB.keys.values()]).includes(raw));
    const visible = await listKeys(env, owner);
    assert.deepEqual(Object.keys(visible[0]).sort(), ["mask", "provider", "updatedAt"]);
    assert.equal(visible[0].mask, "•••• 6789");
    assert.deepEqual(await listKeys(env, "other-user"), []);
    await assert.rejects(getKey(env, "other-user", "openai"), { status: 409 });
    await deleteKey(env, owner, "openai");
    await assert.rejects(getKey(env, owner, "openai"), { status: 409 });
  } finally { globalThis.fetch = original; }
});

test("failed key replacement preserves the existing encrypted credential", async () => {
  const env = environment();
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-test" }] });
  try {
    await saveKey(env, owner, "openai", "sk-existing-valid-key");
    globalThis.fetch = async () => Response.json({ error: { message: "LEAK_THIS_SECRET" } }, { status: 401 });
    await assert.rejects(saveKey(env, owner, "openai", "sk-rejected-secret-key"), (e) => !e.message.includes("LEAK_THIS_SECRET"));
    assert.equal((await getKey(env, owner, "openai")).key, "sk-existing-valid-key");
  } finally { globalThis.fetch = original; }
});

test("storage configuration fails closed before transmitting a key", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error("must not call"); };
  try {
    await assert.rejects(saveKey({ DB: memoryDB() }, owner, "openai", "sk-private-api-key"), { status: 503 });
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});

test("all key operations and every remote model require a real server session", async () => {
  for (const [path, method, body] of [
    ["/api/keys", "GET"],
    ["/api/keys", "PUT", { provider: "openai", key: "sk-test-secret-key" }],
    ["/api/keys/verify", "POST", { provider: "openai" }],
    ["/api/keys/openai", "DELETE"],
  ]) assert.equal((await worker.fetch(request(path, method, body, false), environment())).status, 401);
  for (const model of ["openai:gpt-test", "openrouter:openai/gpt-test", "google:gemini-test"]) {
    const result = await worker.fetch(request("/api/chat", "POST", {
      model, paid: false, messages: [{ role: "user", content: "hello" }],
    }, false), environment());
    assert.equal(result.status, 403);
  }
});

test("cross-origin BYOK writes and arbitrary provider endpoints are rejected", async () => {
  const req = request("/api/keys", "PUT", { provider: "openai", key: "sk-test-secret-key" });
  req.headers.set("origin", "https://evil.example");
  assert.equal((await worker.fetch(req, environment())).status, 403);
  await assert.rejects(saveKey(environment(), owner, "http://127.0.0.1", "sk-test-secret-key"), { status: 400 });
  assert.equal(parseRemoteModel("http://127.0.0.1"), null);
  assert.equal(parseRemoteModel("openai:gpt-test?secret=123"), null);
});

test("GET keys never returns ciphertext or original API Key", async () => {
  const env = environment();
  const sealed = await sealKey(env, owner, "openai", "sk-do-not-expose-1234");
  env.DB.keys.set(owner + ":openai", { owner, provider: "openai", ...sealed, mask: "•••• 1234", updated: 10 });
  const result = await worker.fetch(request("/api/keys"), env);
  const body = await result.text();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(body, /ciphertext|sk-do-not-expose|iv/);
  assert.match(body, /1234/);
});

test("catalog uses live upstream entries and does not claim unconfigured models available", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{
    id: "openai/test-live", name: "Live test model", context_length: 120000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000002", completion: "0.000010" },
  }] });
  try {
    const result = await getCatalog(environment(), null, true);
    const model = result.models.find((m) => m.id === "openrouter:openai/test-live");
    assert.equal(model.available, false);
    assert.equal(model.requiresLogin, true);
    assert.equal(model.pricing.input, 2);
    assert.equal(model.pricing.output, 10);
    assert.equal(result.catalog.status, "live");
    assert.equal(result.models[0].provider, "cloudflare");
  } finally { globalThis.fetch = original; }
});

test("lazy table initialization is single-flight and retries transient failures", async () => {
  let calls = 0;
  const env = { DB: { prepare(sql) {
    assert.match(sql, /^CREATE TABLE IF NOT EXISTS byok_keys/);
    return { async run() { if (++calls === 1) throw new Error("temporary D1 outage"); return { success: true }; } };
  } } };
  await assert.rejects(ensureKeyStore(env), { status: 503 });
  await Promise.all([ensureKeyStore(env), ensureKeyStore(env), ensureKeyStore(env)]);
  assert.equal(calls, 2);
});

test("aborting the first visitor cannot cancel a shared public catalog refresh", async () => {
  const original = globalThis.fetch;
  const visitor = new AbortController();
  let upstreamSignal, release, started, calls = 0;
  const began = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = async (_url, options) => {
    calls++;
    upstreamSignal = options.signal;
    started();
    return new Promise((resolve, reject) => {
      release = resolve;
      upstreamSignal.addEventListener("abort", () => reject(new Error("upstream cancelled")), { once: true });
    });
  };
  let first, second;
  try {
    first = getCatalog(environment(), null, true, visitor.signal);
    await began;
    second = getCatalog(environment(), null, true, new AbortController().signal);
    visitor.abort();
    assert.equal(upstreamSignal.aborted, false);
    release(Response.json({ data: [{
      id: "vendor/shared-public-model", name: "Shared public model",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    }] }));
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1);
    for (const result of results) {
      assert.equal(result.catalog.status, "live");
      assert(result.models.some((m) => m.id === "openrouter:vendor/shared-public-model"));
    }
  } finally {
    release?.(Response.json({ data: [] }));
    await Promise.allSettled([first, second].filter(Boolean));
    globalThis.fetch = original;
  }
});

test("catalog retains built-in models if BYOK storage is unavailable", async () => {
  const env = { BYOK_ENCRYPTION_KEY: secret, DB: { prepare() { return { async run() { throw new Error("DB down"); } }; } } };
  const result = await getCatalog(env, owner);
  assert(result.models.some((m) => m.provider === "cloudflare" && m.available));
  assert.equal(result.storageAvailable, false);
  assert(result.providers.every((p) => p.error));
  assert.equal(storageAvailable({ BYOK_ENCRYPTION_KEY: "invalid" }), false);
  assert.equal(storageAvailable({ BYOK_ENCRYPTION_KEY: secret }), true);
});

test("chat routes saved credentials only to their provider and preserves CN checks", async () => {
  const env = environment(), raw = "sk-saved-provider-key";
  const sealed = await sealKey(env, owner, "openai", raw);
  env.DB.keys.set(owner + ":openai", { owner, provider: "openai", ...sealed, mask: "•••• -key", updated: 99 });
  const original = globalThis.fetch;
  let generations = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer " + raw);
    assert.equal(options.redirect, "manual");
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "gpt-test" }] });
    generations++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.input[0].content[0].text, "hello");
    return new Response('data: {"type":"response.output_text.delta","delta":"hello back"}\n\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const body = { model: "openai:gpt-test", key: "sk-injected-key", endpoint: "http://127.0.0.1", messages: [{ role: "user", content: "hello" }] };
    const response = await worker.fetch(request("/api/chat", "POST", body), env);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hello back/);
    assert.equal(generations, 1);
    const cn = new Request("https://llm.veaix.com/api/chat", {
      method: "POST", headers: { origin: "https://llm.veaix.com", "content-type": "application/json", cookie: "__Host-veaix=" + "a".repeat(64) },
      body: JSON.stringify({ ...body, messages: [{ role: "user", content: "赌博" }] }),
    });
    Object.defineProperty(cn, "cf", { value: { country: "CN" } });
    const blocked = await worker.fetch(cn, env);
    assert.match(await blocked.text(), /无法/);
    assert.equal(generations, 1);
  } finally { globalThis.fetch = original; }
});
