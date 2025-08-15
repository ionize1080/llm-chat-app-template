/**
 * LLM Chat App Frontend (Raw SSE mode supported)
 * - 兼容 Workers 原生 / OpenAI Chat Completions / OpenAI Responses
 * - 过滤 reasoning 事件（仅用于展示；原始SSE捕获不受影响）
 * - completed：若完整文本更长则替换此前增量
 * - 仅渲染 <final>…</final> 内文本（如存在），否则渲染原文
 * - 新增：源SSE模式（直接走 /api/chat/raw） + 原始SSE捕获与复制
 */

// DOM
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const modelSelect = document.getElementById("model-select");
const rawToggleBtn = document.getElementById("raw-toggle");
const sourceToggleBtn = document.getElementById("source-toggle");

let isProcessing = false;
const chatHistory = [];

// --- 持久化的两个开关 ---
let captureRawSSE = (localStorage.getItem("captureRawSSE") === "1");
let useRawEndpoint = (localStorage.getItem("useRawEndpoint") === "1");
updateRawToggleUI();
updateSourceToggleUI();

if (rawToggleBtn) {
    rawToggleBtn.addEventListener("click", () => {
        captureRawSSE = !captureRawSSE;
        localStorage.setItem("captureRawSSE", captureRawSSE ? "1" : "0");
        updateRawToggleUI();
    });
}
if (sourceToggleBtn) {
    sourceToggleBtn.addEventListener("click", () => {
        useRawEndpoint = !useRawEndpoint;
        localStorage.setItem("useRawEndpoint", useRawEndpoint ? "1" : "0");
        updateSourceToggleUI();
    });
}

function updateRawToggleUI() {
    if (!rawToggleBtn) return;
    rawToggleBtn.classList.toggle("active", captureRawSSE);
    rawToggleBtn.textContent = captureRawSSE ? "📋 原始SSE：开启" : "📋 原始SSE：关闭";
    rawToggleBtn.title = captureRawSSE ? "当前将记录并可复制每次回答的原始SSE流" : "点击开启原始SSE捕获";
}
function updateSourceToggleUI() {
    if (!sourceToggleBtn) return;
    sourceToggleBtn.classList.toggle("active", useRawEndpoint);
    sourceToggleBtn.textContent = useRawEndpoint ? "🌊 源SSE模式：开启" : "🌊 源SSE模式：关闭";
    sourceToggleBtn.title = useRawEndpoint ? "使用 /api/chat/raw，直接消费上游原始SSE" : "使用 /api/chat（规范化SSE）";
}

// 输入框行为
if (userInput) {
    userInput.addEventListener("input", () => {
        userInput.style.height = "auto";
        userInput.style.height = Math.min(userInput.scrollHeight, 200) + "px";
    });
    userInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}
if (sendButton) sendButton.addEventListener("click", () => sendMessage());

async function sendMessage() {
    const message = (userInput?.value || "").trim();
    if (message === "" || isProcessing) return;

    isProcessing = true;
    if (userInput) userInput.disabled = true;
    if (sendButton) sendButton.disabled = true;

    addMessageToChat("user", message);
    if (userInput) { userInput.value = ""; userInput.style.height = "auto"; }
    if (typingIndicator) typingIndicator.classList.add("visible");

    chatHistory.push({ role: "user", content: message });

    try {
        // 助手气泡
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.textContent = "正在生成…";
        chatMessages.appendChild(assistantMessageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        const apiPath = useRawEndpoint ? "/api/chat/raw" : "/api/chat";

        const response = await fetch(apiPath, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: chatHistory,
                model: modelSelect ? modelSelect.value : undefined,
            }),
        });

        if (response.status === 403) {
            const data = await response.json().catch(() => ({}));
            assistantMessageEl.textContent = "";
            assistantMessageEl.innerHTML = renderMarkdown(data.error || "网站正在建设中");
            return;
        }
        if (!response.ok || !response.body) throw new Error("Network error");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let responseText = "";
        let sseBuffer = "";
        let hasFirstPiece = false;
        const rawBlocks = []; // 收集原始SSE文本块（evt+\n\n）

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkStr = decoder.decode(value, { stream: true });
            sseBuffer += chunkStr;

            // —— 捕获原始（按原样） ——（开启时）
            // 不能直接 push chunk，因为可能截断；等按块拆完再收
            const events = sseBuffer.split("\n\n");
            sseBuffer = events.pop() || "";

            for (const evt of events) {
                if (captureRawSSE) rawBlocks.push(evt + "\n\n");

                // 解析 data: 行（event: 行仅用于辅助理解，不参与展示）
                const lines = evt.split("\n");
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line || !line.startsWith("data:")) continue;

                    const jsonStr = line.replace(/^data:\s*/, "").trim();
                    if (!jsonStr || jsonStr === "[DONE]") continue;

                    let jsonData;
                    try { jsonData = JSON.parse(jsonStr); } catch { continue; }

                    // —— 展示时忽略 reasoning 事件，但原始SSE依然完整记录
                    if (jsonData?.type && String(jsonData.type).startsWith("response.reasoning")) continue;

                    const piece = pickChunkText(jsonData);
                    if (!piece) continue;

                    if (!hasFirstPiece) {
                        assistantMessageEl.textContent = "";
                        hasFirstPiece = true;
                    }

                    if (jsonData?.type === "response.completed") {
                        if (piece.length > responseText.length + 8) {
                            responseText = piece; // 更长则替换
                        }
                    } else {
                        responseText += piece; // 增量累积
                    }

                    assistantMessageEl.innerHTML = renderMarkdown(visibleTextFrom(responseText));
                    highlightCode(assistantMessageEl);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
            }
        }

        // 结束：追加复制条
        if (captureRawSSE && rawBlocks.length) {
            appendRawCopyBar(assistantMessageEl, rawBlocks.join(""));
        }

        chatHistory.push({ role: "assistant", content: visibleTextFrom(responseText) });
    } catch (err) {
        console.error(err);
        addMessageToChat("assistant", "Sorry, there was an error processing your request.");
    } finally {
        if (typingIndicator) typingIndicator.classList.remove("visible");
        isProcessing = false;
        if (userInput) { userInput.disabled = false; userInput.focus(); }
        if (sendButton) sendButton.disabled = false;
    }
}

function pickChunkText(jsonData) {
    // 1) Workers 原生统一输出
    if (typeof jsonData?.response === "string") return jsonData.response;

    // 2) Responses API
    if (jsonData?.type === "response.output_text.delta" && typeof jsonData?.delta === "string")
        return jsonData.delta;

    if (jsonData?.type === "response.completed") {
        const out = jsonData?.response?.output;
        if (Array.isArray(out)) {
            const texts = [];
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

    // 3) Chat Completions
    const ch = jsonData?.choices?.[0];
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

    // 4) 其它兼容
    if (typeof jsonData?.part?.text === "string") return jsonData.part.text;
    if (typeof jsonData?.item?.content?.[0]?.text === "string") return jsonData.item.content[0].text;

    return "";
}

// 只渲染 <final>…</final>（若存在）；否则原样
function visibleTextFrom(raw) {
    if (!raw) return "";
    const m = raw.match(/<final>([\s\S]*?)<\/final>/i);
    return m ? m[1] : raw;
}

function appendRawCopyBar(assistantEl, rawText) {
    const bar = document.createElement("div");
    bar.className = "sse-copy-bar";

    const left = document.createElement("div");
    left.className = "left";
    const size = new Blob([rawText]).size;
    const lines = (rawText.match(/\n/g) || []).length;
    left.textContent = `原始SSE流（${size} 字节 / ${lines} 行）`;

    const right = document.createElement("div");
    right.className = "right";
    const btn = document.createElement("button");
    btn.className = "sse-copy-btn";
    btn.textContent = "复制原始SSE流";
    btn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(rawText);
            const old = btn.textContent;
            btn.textContent = "已复制 ✓";
            setTimeout(() => (btn.textContent = old), 1200);
        } catch {
            btn.textContent = "复制失败";
            setTimeout(() => (btn.textContent = "复制原始SSE流"), 1200);
        }
    });
    right.appendChild(btn);

    bar.appendChild(left);
    bar.appendChild(right);
    assistantEl.appendChild(bar);
}

// ========== UI helpers ==========
function addMessageToChat(role, content) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message`;
    if (role === "assistant") {
        messageEl.innerHTML = renderMarkdown(content);
    } else {
        const p = document.createElement("p");
        p.textContent = content;
        messageEl.appendChild(p);
    }
    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    highlightCode(messageEl);
}
function renderMarkdown(md) {
    const safe = md || "";
    if (window.marked) return window.marked.parse(safe);
    const div = document.createElement("div"); div.textContent = safe; return div.innerHTML;
}
function highlightCode(el) {
    if (window.hljs) el.querySelectorAll("pre code").forEach((b) => window.hljs.highlightElement(b));
    addCopyButtons(el);
}
function addCopyButtons(el) {
    el.querySelectorAll("pre").forEach((pre) => {
        if (pre.querySelector(".copy-btn")) return;
        const btn = document.createElement("button");
        btn.textContent = "Copy"; btn.className = "copy-btn";
        btn.addEventListener("click", () => {
            const code = pre.querySelector("code")?.innerText || pre.innerText || "";
            navigator.clipboard.writeText(code).then(() => {
                btn.textContent = "Copied!"; setTimeout(() => (btn.textContent = "Copy"), 1200);
            });
        });
        pre.style.position = "relative";
        btn.style.position = "absolute"; btn.style.top = "6px"; btn.style.right = "6px";
        pre.appendChild(btn);
    });
}
