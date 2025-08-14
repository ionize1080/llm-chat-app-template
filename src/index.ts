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

        let sseBuffer = "";

        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                const text = new TextDecoder().decode(chunk);
                sseBuffer += text;

                const events = sseBuffer.split("\n\n");
                sseBuffer = events.pop() || "";

                for (const evt of events) {
                    const lines = evt.split("\n");
                    for (let rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line) continue;

                        // 只处理 data: 行；忽略 event:/id:/retry:
                        if (!line.startsWith("data:")) continue;

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
                            // 保底直接透传该行的 data
                            const out = `data: ${JSON.stringify({ response: jsonStr })}\n\n`;
                            controller.enqueue(new TextEncoder().encode(out));
                        }
                    }
                }
            },
            flush(controller) {
                // 处理尾包：有时最后一个事件没有以空行结尾
                if (sseBuffer) {
                    const lines = sseBuffer.split("\n");
                    for (let rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line || !line.startsWith("data:")) continue;
                        const jsonStr = line.replace(/^data:\s*/, "").trim();
                        if (!jsonStr || jsonStr === "[DONE]") continue;
                        try {
                            const obj = JSON.parse(jsonStr);
                            const piece = normalizeChunkToText(obj);
                            if (piece) {
                                const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                                controller.enqueue(new TextEncoder().encode(out));
                            }
                        } catch { }
                    }
                    sseBuffer = "";
                }
            }
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

function normalizeChunkToText(obj: any): string {
    // Workers 原生统一流：{response:"..."}
    if (typeof obj?.response === "string") return obj.response;

    // OpenAI Responses 增量事件
    if (obj?.type === "response.output_text.delta" && typeof obj?.delta === "string") {
        return obj.delta;
    }

    // OpenAI Responses 完成事件：从 response.output[*] 提取文本
    if (obj?.type === "response.completed") {
        const out = obj?.response?.output;
        if (Array.isArray(out)) {
            const texts: string[] = [];
            for (const item of out) {
                if (typeof item?.text === "string") texts.push(item.text);
                if (Array.isArray(item?.content)) {
                    for (const c of item.content) {
                        if (typeof c?.text === "string") texts.push(c.text);
                        else if (typeof c?.data?.text === "string") texts.push(c.data.text);
                    }
                }
            }
            if (texts.length) return texts.join("");
        }
    }

    // OpenAI Chat Completions 流
    const ch = obj?.choices?.[0];
    if (ch?.delta?.content !== undefined) {
        const content = ch.delta.content;
        if (typeof content === "string") return content;
        if (content && typeof content === "object") {
            if (typeof content?.text === "string") return content.text;
            if (typeof content?.data?.text === "string") return content.data.text;
        }
        return "";
    }
    if (typeof ch?.text === "string") return ch.text;
    if (typeof ch?.message?.content === "string") return ch.message.content;

    // 其它兼容
    if (typeof obj?.part?.text === 'string') return obj.part.text;
    if (typeof obj?.item?.content?.[0]?.text === 'string') return obj.item.content[0].text;

    return "";
}

// Remove recursion and only extract string content
function extractTextFromDeltaContent(content: any): string {
    if (typeof content === "string") return content;
    return "";
}
