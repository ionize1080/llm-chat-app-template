import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, discoverModels, runProvider } from "../src/providers.mjs";

const response = (value, status = 200) => Response.json(value, { status });
function mockFetch(t, fn) { t.mock.method(globalThis, "fetch", fn); }
function chunks(text, size = 3) {
  const bytes = new TextEncoder().encode(text); let at = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (at >= bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(at, at + size)); at += size;
  } }), { headers: { "content-type": "text/event-stream" } });
}
const model = (provider, sourceModel = "test-model") => ({ provider, sourceModel });
const messages = [{ role: "system", content: "Be concise." }, { role: "user", content: "Hello" }];

test("public OpenRouter catalog derives exact current IDs, modalities and per-million prices", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, undefined);
    return response({ data: [
      { id: "vendor/new-model", name: "New Model", context_length: 200000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0.0000025", completion: "0.00001" } },
      { id: "vendor/free", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/negative", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "-1", completion: "" } },
      { id: "vendor/image", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
      { id: "vendor/chat:batch", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    ] });
  });
  const models = await discoverModels("openrouter");
  assert.equal(models.length, 3);
  const current = models.find((m) => m.sourceModel === "vendor/new-model");
  assert.equal(current.id, "openrouter:vendor/new-model");
  assert.equal(current.vision, true);
  assert.equal(current.contextLength, 200000);
  assert.deepEqual(current.pricing, { input: 2.5, output: 10, currency: "USD", unit: "1M tokens" });
  assert.equal(models.find((m) => m.sourceModel === "vendor/free").paid, true);
  assert.equal(models.find((m) => m.sourceModel === "vendor/free").requiresLogin, true);
  assert.equal(models.find((m) => m.sourceModel === "vendor/negative").pricing, null);
});

test("OpenRouter keys are authenticated independently of its public model listing", async (t) => {
  let called = 0;
  mockFetch(t, async (url, init) => {
    called++;
    assert.equal(url, "https://openrouter.ai/api/v1/key");
    assert.equal(init.headers.Authorization, "Bearer secret-test");
    return response({ error: "secret-test" }, 401);
  });
  await assert.rejects(discoverModels("openrouter", "secret-test"), (e) => e.status === 403 && !e.message.includes("secret-test"));
  assert.equal(called, 1);
});

test("chat discovery excludes mixed text/image generators while preserving vision input", async (t) => {
  mockFetch(t, async (url) => String(url).startsWith("https://openrouter.ai/")
    ? response({ data: [
      { id: "google/gemini-nano-banana-2.1", architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] } },
      { id: "vendor/voice", architecture: { input_modalities: ["text"], output_modalities: ["text", "audio"] } },
      { id: "vendor/vision-chat", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
    ] })
    : response({ models: [
      { name: "models/gemini-nano-banana-2.1", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-flash-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-pro", supportedGenerationMethods: ["generateContent"] },
    ] }));
  const routed = await discoverModels("openrouter");
  assert.deepEqual(routed.map((m) => m.sourceModel), ["vendor/vision-chat"]);
  assert.equal(routed[0].vision, true);
  const native = await discoverModels("google", "secret-test");
  assert.deepEqual(native.map((m) => m.sourceModel), ["gemini-pro"]);
  assert.equal(native[0].vision, true);
});

test("registry rejects custom targets and header injection before making any request", async (t) => {
  let called = false; mockFetch(t, async () => { called = true; });
  await assert.rejects(discoverModels("https://evil.example", "secret"), (e) => e.status === 400);
  await assert.rejects(discoverModels("openai", "secret\r\nx-test:bad"), (e) => e.status === 400);
  assert.equal(called, false);
  assert.equal(new Set(PROVIDERS.map((p) => new URL(p.endpoint).protocol)).size, 1);
  assert(PROVIDERS.every((p) => new URL(p.endpoint).protocol === "https:"));
});

test("Workers-compatible fetch rejects redirects without forwarding credentials", async (t) => {
  let calls = 0, cancelled = 0;
  mockFetch(t, async (url, init) => {
    calls++;
    assert.equal(new URL(url).origin, "https://api.openai.com");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, "Bearer secret-test");
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: 307, headers: { Location: "https://evil.example/secret-test" },
    });
  });
  const rejected = (e) => e.status === 502 && !e.message.includes("secret-test") && !e.message.includes("evil.example");
  await assert.rejects(discoverModels("openai", "secret-test"), rejected);
  await assert.rejects(runProvider(model("openai"), "secret-test", messages, { stream: false }), rejected);
  assert.equal(calls, 2);
  assert.equal(cancelled, 2);
});

test("Gemini catalog follows page tokens and only keeps generateContent models", async (t) => {
  let calls = 0;
  mockFetch(t, async (url, init) => {
    calls++;
    assert(!url.includes("secret-test"));
    assert.equal(init.headers["x-goog-api-key"], "secret-test");
    if (calls === 1) return response({ models: [{ name: "models/gemini-new", displayName: "Gemini New", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 100000, outputTokenLimit: 8000 }], nextPageToken: "page 2" });
    assert.equal(new URL(url).searchParams.get("pageToken"), "page 2");
    return response({ models: [{ name: "models/embedding-new", supportedGenerationMethods: ["embedContent"] }, { name: "models/gemini-live-audio", supportedGenerationMethods: ["generateContent"] }] });
  });
  const models = await discoverModels("google", "secret-test");
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "google:gemini-new");
  assert.equal(models[0].contextLength, 100000);
  assert.equal(calls, 2);
});

test("xAI metadata uses language models and its documented pricing units", async (t) => {
  mockFetch(t, async (url) => {
    assert.equal(url, "https://api.x.ai/v1/language-models");
    return response({ models: [{ id: "grok-new", input_modalities: ["text", "image"], output_modalities: ["text"], prompt_text_token_price: 20000, completion_text_token_price: 60000 }] });
  });
  const [m] = await discoverModels("xai", "secret-test");
  assert.equal(m.vision, true);
  assert.deepEqual(m.pricing, { input: 2, output: 6, currency: "USD", unit: "1M tokens" });
});

test("Qwen discovery uses Singapore catalog endpoint and does not assume price currency", async (t) => {
  mockFetch(t, async (url) => {
    assert.equal(new URL(url).origin + new URL(url).pathname, "https://dashscope-intl.aliyuncs.com/api/v1/models");
    assert.equal(new URL(url).searchParams.get("capabilities"), "TG");
    return response({ success: true, output: { total: 1, models: [{ model: "qwen-new", name: "Qwen New", model_info: { context_window: 131072, max_output_tokens: 8192 }, inference_metadata: { request_modality: ["Text", "Image"], response_modality: ["Text"] }, prices: [{ prices: [{ type: "input_token", price: "2" }] }] }] } });
  });
  const [m] = await discoverModels("qwen", "secret-test");
  assert.equal(m.vision, true); assert.equal(m.contextLength, 131072); assert.equal(m.pricing, null);
});

test("OpenAI Responses conversion disables storage and preserves images/history", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init.redirect, "manual");
    const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.max_output_tokens, 4096);
    assert.equal(body.instructions, "Be concise.");
    assert.equal(body.temperature, undefined);
    assert.equal(body.input[0].content[1].type, "input_image");
    assert.equal(body.input[1].content[0].type, "output_text");
    return response({ output: [{ type: "reasoning", summary: [{ text: "Hidden" }] }, { type: "message", content: [{ type: "output_text", text: "Visible" }] }] });
  });
  const result = await runProvider(model("openai", "gpt-new"), "secret-test", [messages[0], { role: "user", content: [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }, { role: "assistant", content: "Previous" }, messages[1]], { stream: false });
  assert.deepEqual(result, { response: "Visible" });
});

test("Responses SSE handles split UTF8, CRLF, comments, multiline data, and truncation", async (t) => {
  mockFetch(t, async () => chunks(': heartbeat\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"你好"}\r\n\r\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Hidden"}\r\n\r\ndata: {"type":"response.incomplete"}\r\n\r\ndata: [DONE]\r\n\r\n', 1));
  const r = await runProvider(model("openai", "gpt-new"), "secret-test", messages);
  const text = await r.text();
  assert.match(text, /你好/); assert(!text.includes("Hidden")); assert.match(text, /warning/); assert.match(text, /\[DONE\]/);
});

test("Anthropic text deltas exclude thinking and provider errors never reflect secrets", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init.headers["x-api-key"], "secret-test");
    return chunks('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Hidden"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Visible"}}\n\ndata: {"type":"error","error":{"message":"secret-test sensitive upstream details"}}\n\n');
  });
  const result = await runProvider(model("anthropic"), "secret-test", messages);
  const text = await result.text();
  assert.match(text, /Visible/); assert.match(text, /error/); assert(!text.includes("secret-test")); assert(!text.includes("Hidden"));
});

test("Gemini streaming omits thought parts, authenticates in a header, and converts image data", async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-new:streamGenerateContent?alt=sse");
    assert.equal(init.headers["x-goog-api-key"], "secret-test");
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/png");
    return chunks('data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Hidden"},{"text":"Visible"}]},"finishReason":"STOP"}]}\n\n');
  });
  const r = await runProvider(model("google", "gemini-new"), "secret-test", [messages[0], { role: "user", content: [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }]);
  const text = await r.text(); assert.match(text, /Visible/); assert(!text.includes("Hidden"));
});

test("compatible streams accept text-part arrays but never reasoning_content", async (t) => {
  mockFetch(t, async () => chunks('data: {"choices":[{"delta":{"reasoning_content":"Hidden","content":[{"type":"text","text":"Visible"}]}}]}\n\ndata: [DONE]\n\n'));
  const r = await runProvider(model("mistral"), "secret-test", messages);
  const text = await r.text(); assert.match(text, /Visible/); assert(!text.includes("Hidden"));
});

test("HTTP errors, malformed streams, and empty text fail with sanitized actionable messages", async (t) => {
  let call = 0;
  mockFetch(t, async () => ++call === 1 ? response({ error: "secret-test private error" }, 402) : call === 2 ? chunks("data: secret-test malformed\n\n") : response({ choices: [{ message: { content: "" } }] }));
  await assert.rejects(runProvider(model("deepseek"), "secret-test", messages), (e) => e.status === 402 && !e.message.includes("secret-test"));
  const malformed = await runProvider(model("deepseek"), "secret-test", messages);
  const text = await malformed.text(); assert.match(text, /error/); assert(!text.includes("secret-test"));
  await assert.rejects(runProvider(model("deepseek"), "secret-test", messages, { stream: false }), (e) => e.status === 502);
});

test("cancelling normalized output aborts the upstream reader without leaking or hanging", async (t) => {
  let cancelled = false, fetchSignal;
  mockFetch(t, async (_url, init) => {
    fetchSignal = init.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  });
  const r = await runProvider(model("mistral"), "secret-test", messages);
  const reader = r.body.getReader();
  const pending = reader.read();
  await reader.cancel();
  assert.equal((await pending).done, true);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(cancelled, true);
});

test("an interrupted stream after partial text is explicitly marked incomplete", async (t) => {
  mockFetch(t, async () => chunks('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'));
  const r = await runProvider(model("mistral"), "secret-test", messages);
  const text = await r.text(); assert.match(text, /Partial/); assert.match(text, /error/);
});
