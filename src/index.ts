/**
 * Cloudflare Worker backend (fixed v3)
 * - 统一将上游 SSE 解析并转为 {response:"..."} 的 SSE 片段
 * - 忽略 reasoning 事件（response.reasoning*）
 * - 若已收到增量 delta，则不在 completed 时重复输出全文
 * - 强系统提示：鼓励仅返回最终答案，并用 <final>…</final> 包住
 */

interface Env {
    AI: any;
    ASSETS: { fetch: (r: Request) => Promise<Response> };
}

const DEFAULT_MODEL_ID = "@cf/openai/gpt-oss-120b";
const DEFAULT_SYSTEM_PROMPT =
    "You are a helpful assistant. Return ONLY the final answer for the user. " +
    "Do not include analysis, self-talk, or reasoning. " +
    "If you need to think, do it silently. " +
    "Wrap the final answer inside <final>...</final> when possible.";

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
};

async function handleChatRequest(request: Request, env: Env): Promise<Response> {
    try {
        let systemPrompt = DEFAULT_SYSTEM_PROMPT;

        const { messages = [], model } = (await request.json()) as {
            messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
            model?: string;
        };

        const modelId = (model ?? DEFAULT_MODEL_ID);

        // 注入 system 提示（若未提供）
        if (!messages.some((m) => m.role === "system")) {
            messages.unshift({ role: "system", content: systemPrompt });
        }

        const isGptOss = String(modelId).includes("gpt-oss");

        let aiParams: any;

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
            };
        }

        const aiResponse = await env.AI.run(
            modelId,
            aiParams,
            { returnRawResponse: true, stream: true },
        ) as Response;

        let sseBuffer = "";
        let sawOutputTextDelta = false;

        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                const text = new TextDecoder().decode(chunk);
                sseBuffer += text;

                // 以空行分割上游 SSE 事件
                const events = sseBuffer.split("\n\n");
                sseBuffer = events.pop() || "";

                for (const evt of events) {
                    const lines = evt.split("\n");
                    for (const rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line) continue;
                        if (!line.startsWith("data:")) continue;

                        const jsonStr = line.replace(/^data:\s*/, "").trim();
                        if (!jsonStr || jsonStr === "[DONE]") continue;

                        let obj: any;
                        try {
                            obj = JSON.parse(jsonStr);
                        } catch {
                            continue;
                        }

                        // 1) 丢弃 reasoning 事件（如存在）
                        if (obj?.type && String(obj.type).startsWith("response.reasoning")) {
                            continue;
                        }

                        // 2) 标记是否收到过增量文本
                        if (obj?.type === "response.output_text.delta" && typeof obj?.delta === "string" && obj.delta.length) {
                            sawOutputTextDelta = true;
                        }

                        // 3) 已经收到过增量文本，则不要在 completed 再次抽取完整文本（避免重复）
                        if (obj?.type === "response.completed" && sawOutputTextDelta) {
                            continue;
                        }

                        const piece = normalizeChunkToText(obj);
                        if (piece) {
                            const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                            controller.enqueue(new TextEncoder().encode(out));
                        }
                    }
                }
            },
            flush(controller) {
                // 处理尾包：有时最后一个事件没有以空行结尾
                if (!sseBuffer) return;
                const lines = sseBuffer.split("\n");
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line || !line.startsWith("data:")) continue;
                    const jsonStr = line.replace(/^data:\s*/, "").trim();
                    if (!jsonStr || jsonStr === "[DONE]") continue;
                    try {
                        const obj = JSON.parse(jsonStr);
                        if (obj?.type && String(obj.type).startsWith("response.reasoning")) continue;
                        if (obj?.type === "response.completed" && sawOutputTextDelta) continue;
                        const piece = normalizeChunkToText(obj);
                        if (piece) {
                            const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                            controller.enqueue(new TextEncoder().encode(out));
                        }
                    } catch { }
                }
                sseBuffer = "";
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

    // OpenAI Responses 完成事件：从 response.output[*] 提取文本（仅在没见过 delta 时才会走到这里）
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
    if (typeof obj?.part?.text === "string") return obj.part.text;
    if (typeof obj?.item?.content?.[0]?.text === "string") return obj.item.content[0].text;

    return "";
}
