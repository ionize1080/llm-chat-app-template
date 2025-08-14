/**
 * LLM Chat Application Worker (streaming fixed)
 * - 自动识别 GPT‑OSS 模型，使用 {input,max_output_tokens}
 * - 其他模型使用 {messages,max_tokens}
 * - 统一把后台返回转换为 SSE，并尽可能输出 {response:"..."} 片段
 */

import type { Env, ChatMessage, AiRunParams } from "./types";

const DEFAULT_MODEL_ID = "@cf/openai/gpt-oss-120b";
const DEFAULT_SYSTEM_PROMPT =
    "You are a helpful, friendly assistant. Provide concise and accurate responses.";

const CN_SYSTEM_PROMPT = `System Prompt: Mainland China Directives` as const;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        // 静态文件直接交给 ASSETS 处理
        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }
        // API 请求
        if (url.pathname === "/api/chat") {
            if (request.method === "POST") {
                return handleChatRequest(request, env);
            }
            return new Response("Method not allowed", { status: 405 });
        }
        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;

async function handleChatRequest(
    request: Request,
    env: Env,
): Promise<Response> {
    try {
        // 按地区切换系统提示
        let systemPrompt = DEFAULT_SYSTEM_PROMPT;
        const country = (request as any).cf?.country as string | undefined;
        if (country && country.toUpperCase() === "CN") {
            systemPrompt = CN_SYSTEM_PROMPT;
        }

        // 解析请求体
        const { messages = [], model } = (await request.json()) as {
            messages: ChatMessage[];
            model?: string;
        };
        const modelId = (model ?? DEFAULT_MODEL_ID) as keyof AiModels;

        // 注入 system 消息
        if (!messages.some((m) => m.role === "system")) {
            messages.unshift({ role: "system", content: systemPrompt });
        }

        // 构造参数：GPT‑OSS 只取最后一条 user 内容，其他模型发送 messages
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

        // 调用 Workers AI，保持原始 Response 用于转流
        const aiResponse = (await env.AI.run(
            modelId,
            aiParams as any,
            { returnRawResponse: true, stream: true },
        )) as Response;

        /**
         * =====================================================
         * 下面是修改的核心：重新组装 SSE 事件，避免多行 JSON 被拆碎
         * =====================================================
         */
        const decoder = new TextDecoder();
        // 缓冲区用于跨 chunk 存储未处理的文本
        let buffer = "";

        const { readable, writable } = new TransformStream({
            async transform(chunk, controller) {
                // 将当前块追加到 buffer
                buffer += decoder.decode(chunk, { stream: true });

                // 查找完整的 SSE 事件（以两个换行分隔）
                let idx;
                while ((idx = buffer.indexOf("\n\n")) !== -1) {
                    // 取出一个完整事件并从缓冲区中移除
                    const event = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 2);

                    // 忽略非 data 事件
                    if (!event.startsWith("data:")) continue;

                    // 一个事件可能包含多行 data:，拼接成一个 JSON 字符串
                    const jsonStr = event
                        .split("\n")
                        .filter((l) => l.startsWith("data:"))
                        .map((l) => l.replace(/^data:\s*/, "").trim())
                        .join("");

                    // 忽略完成标记
                    if (!jsonStr || jsonStr === "[DONE]") continue;

                    try {
                        const obj = JSON.parse(jsonStr);
                        const piece = normalizeChunkToText(obj);
                        if (piece) {
                            // 将统一的片段包装成 SSE 数据发送到前端
                            const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                            controller.enqueue(new TextEncoder().encode(out));
                        }
                    } catch {
                        // 解析失败则跳过该事件，避免将原始文本发送给前端
                        continue;
                    }
                }
            },
        });

        // 将 AI 返回的流接入我们自定义的 TransformStream
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

/**
 * 以下两个函数保持不变，用于从不同返回格式中提取文本。
 */
function normalizeChunkToText(obj: any): string {
    // Workers AI / 常规模型
    if (typeof obj?.response === "string") return obj.response;
    // PaLM/Vertex AI
    if (typeof obj?.part?.text === "string") return obj.part.text;
    if (typeof obj?.item?.content?.[0]?.text === "string") {
        return obj.item.content[0].text;
    }
    // OpenAI 兼容 / GPT‑OSS
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
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (Array.isArray(content)) {
        return content.map(extractTextFromDeltaContent).join("");
    }
    return "";
}
