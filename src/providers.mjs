// Official provider endpoints only. API keys never enter URLs or error messages.
export const PROVIDERS = Object.freeze([
  { id: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", help: "https://openrouter.ai/settings/keys" },
  { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1", help: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", endpoint: "https://api.anthropic.com/v1", help: "https://console.anthropic.com/settings/keys" },
  { id: "google", name: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta", help: "https://aistudio.google.com/apikey" },
  { id: "deepseek", name: "DeepSeek", endpoint: "https://api.deepseek.com", help: "https://platform.deepseek.com/api_keys" },
  { id: "xai", name: "xAI", endpoint: "https://api.x.ai/v1", help: "https://console.x.ai" },
  { id: "mistral", name: "Mistral", endpoint: "https://api.mistral.ai/v1", help: "https://console.mistral.ai/api-keys" },
  { id: "groq", name: "Groq", endpoint: "https://api.groq.com/openai/v1", help: "https://console.groq.com/keys" },
  { id: "qwen", name: "Qwen · 新加坡", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", help: "https://modelstudio.console.alibabacloud.com" },
]);
const registry = new Map(PROVIDERS.map((p) => [p.id, p]));
const encoder = new TextEncoder();
const issue = (message, status = 502) => Object.assign(new Error(message), { status });
function providerInfo(id) {
  const p = registry.get(id);
  if (!p) throw issue("不支持的模型服务商。", 400);
  return p;
}
function headersFor(provider, key) {
  if (key !== undefined && (typeof key !== "string" || !key.trim() || /[\r\n\x00-\x1f\x7f]/.test(key) || key.length > 4096))
    throw issue("API Key 格式不正确。", 400);
  if (!key && provider !== "openrouter") throw issue("请先配置此服务商的 API Key。", 400);
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (provider === "anthropic") {
    headers["anthropic-version"] = "2026-10-21";
    headers["x-api-key"] = key;
  } else if (provider === "google") headers["x-goog-api-key"] = key;
  else if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}
function upstreamError(status) {
  if (status === 401 || status === 403) return issue("服务商拒绝了此密钥，请检查 API Key 和模型访问权限。", 403);
  if (status === 402) return issue("服务商账户余额不足，请前往服务商控制台充值。", 402);
  if (status === 429) return issue("服务商请求额度已用尽或请求过于频繁，请稍后重试。", 429);
  if (status === 404) return issue("服务商暂未开放此模型，请刷新模型目录后重试。", 404);
  return issue("服务商暂时无法完成请求，请稍后重试或切换模型。", 502);
}
function requestScope(signal, timeout = 120000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  return {
    signal: controller.signal,
    cancel: abort,
    cleanup() { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
  };
}
async function fetchSafe(url, options) {
  let response;
  try { response = await fetch(url, { ...options, redirect: "error" }); }
  catch { throw issue(options.signal?.aborted ? "服务商请求已取消或超时，请重试。" : "无法连接服务商，请稍后重试。", 503); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw upstreamError(response.status);
  }
  return response;
}
async function boundedJSON(response, max = 8000000) {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel().catch(() => {});
    throw issue("服务商返回的数据过大。", 502);
  }
  if (!response.body) throw issue("服务商没有返回有效数据。", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw issue("服务商返回的数据过大。", 502);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e.status) throw e;
    throw issue("服务商返回了无法读取的数据。", 502);
  } finally { reader.releaseLock(); }
}
const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const positive = (v) => finite(v) > 0 ? Number(v) : null;
const price = (v, multiplier) => finite(v) === null ? null : Number(v) * multiplier;
const textParts = (v) => typeof v === "string" ? v : Array.isArray(v) ? v.filter((p) => p?.type === "text" || p?.type === "output_text").map((p) => p.text || "").join("") : "";
const excluded = /(?:embedding|embed-|moderation|whisper|tts|transcrib|realtime|audio|dall-e|sora|image-generation|image-preview|computer-use|deep-research|prompt-guard|safeguard|orpheus)/i;
function modelCard(provider, raw) {
  let id = raw.id || raw.model || raw.name;
  if (provider === "google") id = typeof raw.name === "string" ? raw.name.replace(/^models\//, "") : "";
  if (typeof id !== "string" || !id || id.length > 200 || /[\s\x00-\x1f?#\\]/.test(id) || id.includes("..")) return null;
  if (raw.archived || raw.active === false || raw.lifecycle === "retired" || /:batch$/.test(id)) return null;
  // This workspace renders text replies only. Some image generators also advertise
  // text output; including them would silently discard their generated image parts.
  // Image input remains supported independently for ordinary vision chat models.
  const outputModalities = raw.architecture?.output_modalities || raw.output_modalities || raw.inference_metadata?.response_modality;
  if (Array.isArray(outputModalities) && outputModalities.some((m) => /^(?:image|video|audio)$/i.test(m))) return null;
  let vision = false, context = raw.context_length || raw.context_window || raw.max_context_length || raw.max_input_tokens;
  let input = null, output = null;
  let maxOutput = raw.max_output_tokens || raw.max_tokens || raw.max_completion_tokens;
  if (provider === "openrouter") {
    if (!raw.architecture?.output_modalities?.includes("text") || !raw.architecture?.input_modalities?.includes("text")) return null;
    if (raw.expiration_date && Date.parse(raw.expiration_date) < Date.now()) return null;
    vision = raw.architecture.input_modalities.includes("image");
    input = price(raw.pricing?.prompt, 1e6); output = price(raw.pricing?.completion, 1e6);
    maxOutput = raw.top_provider?.max_completion_tokens;
  } else if (provider === "google") {
    if (!raw.supportedGenerationMethods?.includes("generateContent") || excluded.test(id) || /(?:^|[-/])(?:image|imagen|veo|lyria)(?:[-/]|$)|nano-banana/i.test(id)) return null;
    vision = /^gemini-/i.test(id);
    context = raw.inputTokenLimit; maxOutput = raw.outputTokenLimit;
  } else if (provider === "anthropic") {
    vision = raw.capabilities?.image_input?.supported === true;
  } else if (provider === "xai") {
    if (!raw.output_modalities?.includes("text")) return null;
    vision = raw.input_modalities?.includes("image") === true;
    input = price(raw.prompt_text_token_price, 1 / 10000); output = price(raw.completion_text_token_price, 1 / 10000);
  } else if (provider === "mistral") {
    if (raw.capabilities?.completion_chat !== true) return null;
    vision = raw.capabilities?.vision === true;
  } else if (provider === "qwen") {
    const modalities = raw.inference_metadata;
    if (modalities?.response_modality && !modalities.response_modality.some((m) => /^text$/i.test(m))) return null;
    if (excluded.test(id)) return null;
    vision = modalities?.request_modality?.some((m) => /^image$/i.test(m)) === true;
    context = raw.model_info?.context_window || raw.model_info?.max_input_tokens;
    maxOutput = raw.model_info?.max_output_tokens;
    // Model Studio exposes tiered prices without a currency field; never label those USD.
  } else {
    if (excluded.test(id) || /(?:^|[-/])(?:image|guard)(?:-|$)/i.test(id)) return null;
    if (provider === "openai" && !/^(?:gpt-|chatgpt-|o[134](?:-|$)|ft:(?:gpt-|o[134]))/.test(id)) return null;
    if (provider === "openai") vision = /^(?:gpt-(?:4o|4\.1|[5-9]|[1-9]\d)|o[34])/.test(id);
    else vision = raw.input_modalities?.includes("image") === true;
    if (raw.output_modalities && !raw.output_modalities.includes("text")) return null;
  }
  return {
    id: `${provider}:${id}`, sourceModel: id, provider,
    name: String(raw.display_name || raw.displayName || (provider === "google" ? id : raw.name) || id).slice(0, 140),
    note: providerInfo(provider).name + " · 自备密钥",
    // A zero token rate does not imply zero image/request/tool charges.
    // Remote routes always require a signed-in account and its own provider key.
    vision, paid: true, requiresLogin: true,
    contextLength: positive(context), maxOutputTokens: positive(maxOutput),
    pricing: input === null && output === null ? null : { input, output, currency: "USD", unit: "1M tokens" },
    created: finite(raw.created) || (raw.created_at ? Date.parse(raw.created_at) / 1000 : null),
  };
}

export async function discoverModels(provider, key, signal) {
  const info = providerInfo(provider);
  const headers = headersFor(provider, key);
  const scope = requestScope(signal, 30000);
  const results = new Map();
  let cursor = "", page = 1, seen = 0;
  try {
    // The public model endpoint accepts invalid tokens. Validate an entered key
    // against the authenticated key endpoint before calling it a saved connection.
    if (provider === "openrouter" && key) {
      const validation = await boundedJSON(await fetchSafe("https://openrouter.ai/api/v1/key", { headers, signal: scope.signal }), 100000);
      if (!validation.data || validation.error) throw issue("服务商拒绝了此密钥，请检查 API Key。", 403);
    }
    for (; page <= 12; page++) {
      const url = new URL(provider === "qwen" ? "https://dashscope-intl.aliyuncs.com/api/v1/models" : `${info.endpoint}/${provider === "xai" ? "language-models" : "models"}`);
      if (provider === "anthropic") { url.searchParams.set("limit", "1000"); if (cursor) url.searchParams.set("after_id", cursor); }
      if (provider === "google") { url.searchParams.set("pageSize", "1000"); if (cursor) url.searchParams.set("pageToken", cursor); }
      if (provider === "qwen") { url.searchParams.set("capabilities", "TG"); url.searchParams.set("page_size", "100"); url.searchParams.set("page_no", String(page)); }
      const data = await boundedJSON(await fetchSafe(url.href, { headers, signal: scope.signal }));
      if (data.error || data.success === false) throw issue("服务商无法读取模型目录，请检查密钥权限。", 403);
      const models = provider === "qwen" ? data.output?.models : data.data || data.models || (Array.isArray(data) ? data : null);
      if (!Array.isArray(models)) throw issue("服务商模型目录格式暂不兼容。", 502);
      seen += models.length;
      for (const m of models) { const card = modelCard(provider, m); if (card) results.set(card.id, card); }
      let next = "";
      if (provider === "anthropic" && data.has_more) next = data.last_id;
      if (provider === "google") next = data.nextPageToken;
      if (provider === "qwen" && seen < Number(data.output?.total) && models.length) next = String(page + 1);
      if (!next) break;
      if (typeof next !== "string" || next.length > 2048 || next === cursor) throw issue("服务商模型目录分页异常，请稍后重试。", 502);
      cursor = next;
      if (page === 12) throw issue("服务商模型目录过大，请稍后重试。", 502);
    }
    return [...results.values()].sort((a, b) => (b.created || 0) - (a.created || 0) || a.name.localeCompare(b.name));
  } finally { scope.cleanup(); }
}

function imageParts(content, target, role) {
  if (typeof content === "string") return target === "google" ? [{ text: content }] : target === "anthropic" ? [{ type: "text", text: content }] : [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return target === "google" ? { text: part.text } : target === "anthropic" ? part : { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
    if (part.type !== "image_url" || typeof part.image_url?.url !== "string") throw issue("图片消息格式不正确。", 400);
    if (target === "openai") return { type: "input_image", image_url: part.image_url.url };
    const match = part.image_url.url.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw issue("只支持已上传的图片。", 400);
    return target === "google" ? { inlineData: { mimeType: match[1], data: match[2] } } : { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  });
}
function payloadFor(model, messages, stream) {
  const provider = model.provider;
  const cap = Math.min(4096, positive(model.maxOutputTokens) || 4096);
  const info = providerInfo(provider);
  const system = messages.filter((m) => m.role === "system").map((m) => textParts(m.content)).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  if (provider === "openai" && !/^gpt-(?:3\.5|4(?:-|$))|^chatgpt-4o/.test(model.sourceModel)) {
    return { endpoint: `${info.endpoint}/responses`, type: "responses", body: {
      model: model.sourceModel, instructions: system, stream, store: false, max_output_tokens: cap,
      input: turns.map((m) => ({ role: m.role, content: imageParts(m.content, "openai", m.role) })),
    } };
  }
  if (provider === "anthropic") return { endpoint: `${info.endpoint}/messages`, type: "anthropic", body: {
    model: model.sourceModel, system, stream, max_tokens: cap,
    messages: turns.map((m) => ({ role: m.role, content: imageParts(m.content, "anthropic", m.role) })),
  } };
  if (provider === "google") return { endpoint: `${info.endpoint}/models/${encodeURIComponent(model.sourceModel)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, type: "google", body: {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: imageParts(m.content, "google", m.role) })),
    generationConfig: { maxOutputTokens: cap },
  } };
  const body = { model: model.sourceModel, messages, stream };
  body[provider === "groq" ? "max_completion_tokens" : "max_tokens"] = cap;
  return { endpoint: `${info.endpoint}/chat/completions`, type: "compatible", body };
}
function parsedText(data, type, streaming) {
  if (data.error || data.type === "error" || data.type === "response.failed") throw issue("服务商返回错误，回答未完成。请检查余额与模型权限后重试。", 502);
  if (type === "responses") {
    if (streaming) return data.type === "response.output_text.delta" || data.type === "response.refusal.delta" ? data.delta || "" : "";
    return data.output_text || (data.output || []).filter((p) => p.type === "message").map((p) => (p.content || []).map((c) => c.type === "refusal" ? c.refusal || "" : c.type === "output_text" ? c.text || "" : "").join("")).join("");
  }
  if (type === "anthropic") return streaming ? (data.type === "content_block_delta" && data.delta?.type === "text_delta" ? data.delta.text || "" : "") : textParts(data.content);
  if (type === "google") return (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  return textParts(streaming ? data.choices?.[0]?.delta?.content : data.choices?.[0]?.message?.content);
}
function isTruncated(data, type) {
  if (type === "responses") return data.type === "response.incomplete" || data.status === "incomplete";
  if (type === "anthropic") return (data.delta?.stop_reason || data.stop_reason) === "max_tokens";
  if (type === "google") return data.candidates?.[0]?.finishReason === "MAX_TOKENS";
  return data.choices?.[0]?.finish_reason === "length";
}
async function* sseEvents(body, onReader) {
  const reader = body.getReader();
  onReader(reader);
  const decoder = new TextDecoder();
  let pending = "", lines = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 1000000) throw issue("服务商流式数据异常。", 502);
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1);
        if (line === "") {
          if (lines.length) { yield lines.join("\n"); lines = []; }
        } else if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
        if (lines.join("").length > 1000000) throw issue("服务商流式数据异常。", 502);
      }
      if (done) {
        if (pending.startsWith("data:")) lines.push(pending.slice(5).replace(/^ /, "").replace(/\r$/, ""));
        if (lines.length) yield lines.join("\n");
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function normalizedStream(body, type, scope) {
  let upstreamReader;
  const iterator = sseEvents(body, (reader) => { upstreamReader = reader; })[Symbol.asyncIterator]();
  let finished = false, anyText = false, terminal = false, length = 0;
  const packet = (v) => encoder.encode(`data: ${JSON.stringify(v)}\n\n`);
  return new ReadableStream({
    async pull(controller) {
      try {
        while (!finished) {
          const { value, done } = await iterator.next();
          if (finished) return;
          if (done || value === "[DONE]") {
            finished = true;
            if (!anyText) controller.enqueue(packet({ error: "模型未返回文本，请重试或切换模型。" }));
            else if (done && !terminal) controller.enqueue(packet({ error: "服务商连接提前结束，回答可能不完整。请重试。" }));
            controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close();
            scope.cleanup(); await iterator.return(); return;
          }
          let data;
          try { data = JSON.parse(value); } catch { throw issue("服务商流式数据无法读取。", 502); }
          terminal ||= type === "responses" ? ["response.completed", "response.incomplete"].includes(data.type)
            : type === "anthropic" ? data.type === "message_stop"
            : type === "google" ? Boolean(data.candidates?.[0]?.finishReason)
            : Boolean(data.choices?.[0]?.finish_reason);
          const text = parsedText(data, type, true);
          if (text) { length += text.length; if (length > 300000) throw issue("回答超过长度限制。", 502); anyText = true; controller.enqueue(packet({ response: text })); }
          if (isTruncated(data, type)) controller.enqueue(packet({ warning: "回答已达到本次输出长度上限，可继续追问。" }));
          if (text || isTruncated(data, type)) return;
        }
      } catch {
        if (finished) return;
        finished = true;
        controller.enqueue(packet({ error: "服务商连接中断或返回错误，回答未完成。请重试。" }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close();
        scope.cancel(); scope.cleanup(); await upstreamReader?.cancel().catch(() => {}); await iterator.return().catch(() => {});
      }
    },
    async cancel() { finished = true; scope.cancel(); scope.cleanup(); await upstreamReader?.cancel().catch(() => {}); await iterator.return().catch(() => {}); },
  });
}
export async function runProvider(model, key, messages, { stream = true, signal } = {}) {
  providerInfo(model.provider);
  if (typeof key !== "string" || !key) throw issue("请先配置此服务商的 API Key。", 400);
  if (typeof model.sourceModel !== "string" || /[\x00-\x1f?#\\]/.test(model.sourceModel) || model.sourceModel.includes("..")) throw issue("模型标识无效。", 400);
  const headers = headersFor(model.provider, key);
  const { endpoint, type, body } = payloadFor(model, messages, stream);
  const scope = requestScope(signal);
  try {
    const response = await fetchSafe(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: scope.signal });
    if (stream && response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
      return new Response(normalizedStream(response.body, type, scope), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const data = await boundedJSON(response, 2000000);
    const text = parsedText(data, type, false);
    if (!text) throw issue("模型未返回文本，请重试或切换模型。", 502);
    const result = { response: text, ...(isTruncated(data, type) ? { warning: "回答已达到本次输出长度上限，可继续追问。" } : {}) };
    scope.cleanup();
    return stream ? new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } }) : result;
  } catch (e) {
    scope.cancel(); scope.cleanup();
    if (e.status) throw e;
    throw issue("服务商请求未完成，请重试。", 502);
  }
}
