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

const CN_SYSTEM_PROMPT = `System Prompt: Mainland China Directives` as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

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

    const country = (request as any).cf?.country as string | undefined;
    if (country && country.toUpperCase() === "CN") {
      systemPrompt = CN_SYSTEM_PROMPT;
    }

    const { messages = [], model } = (await request.json()) as {
      messages: ChatMessage[];
      model?: string;
    };

    const modelId = (model ?? DEFAULT_MODEL_ID) as keyof AiModels;

    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: systemPrompt });
    }

    const isGptOss = (modelId as string).includes("gpt-oss");

    let aiParams: AiRunParams | Record<string, unknown>;

    if (isGptOss) {
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

    const aiResponse = (await env.AI.run(
      modelId,
      aiParams as any,
      { returnRawResponse: true, stream: true },
    )) as Response;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
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
              const out = `data: ${JSON.stringify({ response: line })}\n\n`;
              controller.enqueue(new TextEncoder().encode(out));
            }
          } else {
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

// --- 修正部分：增强的文本提取和标准化 ---
function normalizeChunkToText(obj: any): string {
  if (typeof obj?.response === "string") return obj.response;

  // 新增对您日志中格式的支持
  if (typeof obj?.part?.text === 'string') return obj.part.text;
  if (typeof obj?.item?.content?.[0]?.text === 'string') return obj.item.content[0].text;

  const ch = obj?.choices?.[0];
  if (ch?.delta?.content !== undefined) {
    return extractTextFromDeltaContent(ch.delta.content);
  }
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
  return "";
}
