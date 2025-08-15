/**
 * Cloudflare Worker backend
 * - /api/chat      ：规范化 SSE（过滤推理事件；在见到 <final> 前过滤常见自述/占位）
 * - /api/chat/raw  ：上游原始 SSE 直通（保留 event:/data:/[DONE]）
 */

interface Env {
    AI: any;
    ASSETS: { fetch: (r: Request) => Promise<Response> };
}

const DEFAULT_MODEL_ID = "@cf/openai/gpt-oss-120b";
const DEFAULT_SYSTEM_PROMPT =
    "You are a helpful assistant. Return ONLY the final answer for the user. " +
    "Do not include analysis, self-talk, or reasoning. " +
    "When you are fully ready, output exactly once: <final> + the final answer + </final>. " +
    "Never output <final> more than once. Never output ... inside <final>.";

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        if (request.method === "POST" && url.pathname === "/api/chat") {
            return handleChatNormalized(request, env);
        }
        if (request.method === "POST" && url.pathname === "/api/chat/raw") {
            return handleChatRaw(request, env);
        }

        return new Response("Not found", { status: 404 });
    },
};

// ---------- 构造参数 ----------
async function buildParamsFromRequest(request: Request) {
    const { messages = [], model } = (await request.json()) as {
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        model?: string;
    };
    const modelId = (model ?? DEFAULT_MODEL_ID);
    const finalMessages = [...messages];

    if (!finalMessages.some((m) => m.role === "system")) {
        finalMessages.unshift({ role: "system", content: DEFAULT_SYSTEM_PROMPT });
    }

    const isGptOss = String(modelId).includes("gpt-oss");

    let aiParams: any;
    if (isGptOss) {
        const lastUser = [...finalMessages].reverse().find((m) => m.role === "user");
        aiParams = {
            instructions: DEFAULT_SYSTEM_PROMPT,
            input: lastUser?.content ?? "Hello",
            max_output_tokens: 2048,
            stream: true,
        };
    } else {
        aiParams = {
            messages: finalMessages,
            max_tokens: 2048,
            stream: true,
        };
    }
    return { modelId, aiParams };
}

// ---------- 规范化 SSE：/api/chat ----------
async function handleChatNormalized(request: Request, env: Env): Promise<Response> {
    try {
        const { modelId, aiParams } = await buildParamsFromRequest(request);
        const aiResponse = await env.AI.run(modelId, aiParams, { returnRawResponse: true, stream: true }) as Response;

        let sseBuffer = "";
        let seenFinalOpen = false;         // 是否已见到 <final>
        let preFinalTail = "";            // <final> 检测窗口（累积最近片段）
        const MAX_TAIL = 128;

        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                const text = new TextDecoder().decode(chunk);
                sseBuffer += text;

                const events = sseBuffer.split("\n\n");
                sseBuffer = events.pop() || "";

                for (const evt of events) {
                    const lines = evt.split("\n");
                    for (const rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line || !line.startsWith("data:")) continue;

                        const jsonStr = line.replace(/^data:\s*/, "").trim();
                        if (!jsonStr || jsonStr === "[DONE]") continue;

                        let obj: any;
                        try { obj = JSON.parse(jsonStr); } catch { continue; }

                        // 展示友好：丢弃 reasoning 事件
                        if (obj?.type && String(obj.type).startsWith("response.reasoning")) continue;

                        const piece = normalizeChunkToText(obj);
                        if (!piece) continue;

                        // —— <final> 之前的轻量过滤：自述/占位 —— //
                        preFinalTail = (preFinalTail + piece).slice(-MAX_TAIL);
                        if (!seenFinalOpen && preFinalTail.includes("<final>")) {
                            seenFinalOpen = true;
                        }
                        if (!seenFinalOpen) {
                            const p = piece.trim();
                            // 丢弃明显自述/角色行/占位
                            if (/^(the user asks|user:|assistant:|system:|plan:)/i.test(p)) continue;
                            if (p === "..." || p === "…") continue;
                        }

                        const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                        controller.enqueue(new TextEncoder().encode(out));
                    }
                }
            },
            flush(controller) {
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
                        const piece = normalizeChunkToText(obj);
                        if (!piece) continue;

                        preFinalTail = (preFinalTail + piece).slice(-MAX_TAIL);
                        if (!seenFinalOpen && preFinalTail.includes("<final>")) {
                            seenFinalOpen = true;
                        }
                        if (!seenFinalOpen) {
                            const p = piece.trim();
                            if (/^(the user asks|user:|assistant:|system:|plan:)/i.test(p)) continue;
                            if (p === "..." || p === "…") continue;
                        }

                        const out = `data: ${JSON.stringify({ response: piece })}\n\n`;
                        controller.enqueue(new TextEncoder().encode(out));
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
        console.error("Error /api/chat:", error);
        return new Response(JSON.stringify({ error: "Failed to process request" }), {
            status: 500,
            headers: { "content-type": "application/json" },
        });
    }
}

// ---------- 原始 SSE 直通：/api/chat/raw ----------
async function handleChatRaw(request: Request, env: Env): Promise<Response> {
    try {
        const { modelId, aiParams } = await buildParamsFromRequest(request);
        const aiResponse = await env.AI.run(modelId, aiParams, { returnRawResponse: true, stream: true }) as Response;
        return aiResponse; // 原样透传
    } catch (error) {
        console.error("Error /api/chat/raw:", error);
        return new Response(JSON.stringify({ error: "Failed to process request" }), {
            status: 500,
            headers: { "content-type": "application/json" },
        });
    }
}

// ---------- 事件文本提取 ----------
function normalizeChunkToText(obj: any): string {
    // Workers 原生统一流：{response:"..."}
    if (typeof obj?.response === "string") return obj.response;

    // OpenAI Responses：增量
    if (obj?.type === "response.output_text.delta" && typeof obj?.delta === "string") {
        return obj.delta;
    }

    // OpenAI Responses：完成
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

    // Chat Completions
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
