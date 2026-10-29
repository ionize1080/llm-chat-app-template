export const MODELS = [
  {
    id: "@cf/zai-org/glm-4.7-flash",
    name: "GLM 4.7 Flash",
    note: "日常对话 · 轻快省额",
    vision: false,
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    name: "Gemma 4",
    note: "看图理解 · 多语言",
    vision: true,
  },
  {
    id: "@cf/qwen/qwen3.8-27b",
    name: "Qwen 3.8",
    note: "中文创作 · 复杂问题",
    vision: true,
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    name: "Qwen 3 30B",
    note: "轻量推理 · 高效对话",
    vision: false,
  },
];
export const REFUSAL =
  "抱歉，我无法就该话题提供帮助。我们可以讨论编程实践、通用文学鉴赏或旅行计划等话题。";
export function extractText(x) {
  return (
    x?.choices?.[0]?.message?.content ??
    x?.choices?.[0]?.delta?.content ??
    x?.choices?.[0]?.text ??
    x?.response ??
    ""
  );
}
export function cleanAnswer(s) {
  return s
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/<\/?final>/gi, "")
    .trim();
}
export function isCN(request) {
  return request.cf?.country === "CN";
}
export async function readJSON(request, max = 2000000) {
  if (Number(request.headers.get("content-length")) > max)
    throw new Error("请求过大");
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new Error("需要 JSON 请求");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("缺少请求内容");
  let n = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new Error("请求过大");
    }
    chunks.push(value);
  }
  const data = new Uint8Array(n);
  let p = 0;
  for (const c of chunks) {
    data.set(c, p);
    p += c.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
