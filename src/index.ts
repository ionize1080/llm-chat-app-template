/**
 * LLM Chat Application Worker (fixed)
 * - 自动识别 GPT-OSS 模型，使用 {input, max_output_tokens}
 * - 其他模型使用 {messages, max_tokens}
 * - 统一把后端流转成 SSE，并尽可能输出 {response:"..."} 片段
 */

import type { Env, ChatMessage, AiRunParams } from "./types";

const DEFAULT_MODEL_ID = "@cf/openai/gpt-oss-120b";
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

// 如需特殊系统提示可保留/修改
const CN_SYSTEM_PROMPT = `System Prompt: Mainland China Directives - Abridged ...` as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 静态资源
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API
    if (url.pathname === "/api/chat") {
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;

    // 可选：按地区切换系统提示
    const country = (request as any).cf?.country as string | undefined;
    if (country && country.toUpperCase() === "CN") {
      systemPrompt = CN_SYSTEM_PROMPT;
    }

    const { messages = [], model } = (await request.json()) as {
      messages: ChatMessage[];
      model?: string;
    };

    const modelId = (model ?? DEFAULT_MODEL_ID) as keyof AiModels;

    // 注入 system
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: systemPrompt });
    }

    const isGptOss = (modelId as string).includes("gpt-oss");

    // —— 构造参数 —— //
    let aiParams: AiRunParams | Record<string, unknown>;

    if (isGptOss) {
      // GPT-OSS：取最后一次 user 内容作为 input
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      aiParams = {
        instructions: systemPrompt,
        input: lastUser?.content ?? "Hello",
        max_output_tokens: 1024,
        stream: true,
      };
    } else {
      aiParams = {
        messages,
        max_tokens: 1024,
        stream: true,
      } as AiRunParams;
    }

    // 调用 Workers AI（保持原始 Response 以便转流）
    const aiResponse = (await env.AI.run(
      modelId,
      aiParams as any,
      { returnRawResponse: true, stream: true },
    )) as Response;

    // —— 统一转为 SSE —— //
    // 把各种返回统一成 data: {"response":"..."}\n\n
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);

        // 若本身就是 SSE（含 data:），直接按行处理，提取/转换
        const lines = text.split("\n");
        for (let rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (
            line.startsWith("event:") ||
            line.startsWith("id:") ||
            line.startsWith("retry:")
          ) {
            continue;
          }

          if (line.startsWith("data:")) {
            const jsonStr = line.replace(/^data:\s*/, "").trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            try {
              const obj = JSON.parse(jsonStr);
              const piece = normalizeChunkToText(obj);
              if (piece) {
                const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                controller.enqueue(new TextEncoder().encode(out));
              }
            } catch {
              // 不是 JSON，就按纯文本包装
              const out = `data: ${JSON.stringify({ response: line })}\n\n`;
              controller.enqueue(new TextEncoder().encode(out));
            }
          } else {
            // 非 SSE 行：可能是原始 JSON/纯文本
            try {
              const obj = JSON.parse(line);
              const piece = normalizeChunkToText(obj);
              if (piece) {
                const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                controller.enqueue(new TextEncoder().encode(out));
              }
            } catch {
              const out = `data: ${JSON.stringify({ response: line })}\n\n`;
              controller.enqueue(new TextEncoder().encode(out));
            }
          }
        }
      },
    });

    aiResponse.body?.pipeTo(writable);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        // 需要跨域时可放开
        // "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(JSON.stringify({ error: "Failed to process request" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

/** 把不同返回结构统一提取为文本 */
function normalizeChunkToText(obj: any): string {
  // Workers AI / 常规模型
  if (typeof obj?.response === "string") return obj.response;

  // OpenAI 兼容 / GPT-OSS
  const ch = obj?.choices?.[0];

  // 新式增量
  if (ch?.delta?.content !== undefined) {
    return extractTextFromDeltaContent(ch.delta.content);
  }

  // 兜底
  if (typeof ch?.text === "string") return ch.text;
  if (typeof ch?.message?.content === "string") return ch.message.content;

  return "";
}

function extractTextFromDeltaContent(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;

  if (typeof content.value === "string") return content.value;
  if (typeof content.text === "string")  return content.text;
  if (typeof content.content === "string") return content.content;

  if (Array.isArray(content)) {
    return content.map(extractTextFromDeltaContent).join("");
  }

  // 避免输出 [object Object]，不做 JSON.stringify
  return "";
}
