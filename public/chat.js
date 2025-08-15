/**
 * LLM Chat App Frontend (fixed v4)
 * - 兼容 Workers 原生 / OpenAI Chat Completions / OpenAI Responses
 * - 过滤 reasoning 事件（response.reasoning*）
 * - 不再跳过 completed；若 completed 文本更长，则替换此前增量，避免“只有 …”
 * - 仅渲染 <final>…</final> 内文本（如存在），否则渲染原文
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const modelSelect = document.getElementById("model-select");

let isProcessing = false;
const chatHistory = [];

// Auto-resize textarea
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

if (sendButton) {
    sendButton.addEventListener("click", () => sendMessage());
}

async function sendMessage() {
    const message = (userInput?.value || "").trim();
    if (message === "" || isProcessing) return;

    isProcessing = true;
    if (userInput) userInput.disabled = true;
    if (sendButton) sendButton.disabled = true;

    addMessageToChat("user", message);
    if (userInput) {
        userInput.value = "";
        userInput.style.height = "auto";
    }
    if (typingIndicator) typingIndicator.classList.add("visible");

    chatHistory.push({ role: "user", content: message });

    try {
        // 先创建一个空的 assistant 气泡
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.textContent = "正在生成…";
        chatMessages.appendChild(assistantMessageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        const response = await fetch("/api/chat", {
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
        if (!response.ok || !response.body) {
            throw new Error("Network error");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";
        let sseBuffer = "";
        let hasFirstPiece = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });

            // 按 SSE 事件块分割（以空行结尾）
            const events = sseBuffer.split("\n\n");
            sseBuffer = events.pop() || ""; // 半包留到下次

            for (const evt of events) {
                const lines = evt.split("\n");
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line || !line.startsWith("data:")) continue;

                    const jsonStr = line.replace(/^data:\s*/, "").trim();
                    if (!jsonStr || jsonStr === "[DONE]") continue;

                    let jsonData;
                    try {
                        jsonData = JSON.parse(jsonStr);
                    } catch {
                        continue;
                    }

                    // —— 丢弃 reasoning 事件 —— 
                    if (jsonData?.type && String(jsonData.type).startsWith("response.reasoning")) {
                        continue;
                    }

                    const piece = pickChunkText(jsonData);
                    if (!piece) continue;

                    // 第一次拿到内容，清掉“正在生成…”
                    if (!hasFirstPiece) {
                        assistantMessageEl.textContent = "";
                        hasFirstPiece = true;
                    }

                    // ★ 核心：如果是 completed 的完整文本，且更长，则替换此前增量
                    if (jsonData?.type === "response.completed") {
                        if (piece.length > responseText.length + 8) {
                            responseText = piece;
                        } else {
                            // 太短或已包含，忽略以避免重复
                        }
                    } else {
                        // 普通增量：直接累加
                        responseText += piece;
                    }

                    assistantMessageEl.innerHTML = renderMarkdown(visibleTextFrom(responseText));
                    highlightCode(assistantMessageEl);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
            }
        }

        chatHistory.push({ role: "assistant", content: visibleTextFrom(responseText) });
    } catch (err) {
        console.error(err);
        addMessageToChat("assistant", "Sorry, there was an error processing your request.");
    } finally {
        if (typingIndicator) typingIndicator.classList.remove("visible");
        isProcessing = false;
        if (userInput) {
            userInput.disabled = false;
            userInput.focus();
        }
        if (sendButton) sendButton.disabled = false;
    }
}

function pickChunkText(jsonData) {
    // 1) Workers AI 原生统一输出 {response:"..."}
    if (typeof jsonData?.response === "string") {
        return jsonData.response;
    }

    // 2) OpenAI Responses API 事件流
    if (jsonData?.type === "response.output_text.delta" && typeof jsonData?.delta === "string") {
        return jsonData.delta;
    }
    if (jsonData?.type === "response.completed") {
        // 兜底：从 response.output[*] 提取文本
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

    // 3) OpenAI Chat Completions 兼容
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

    // 4) 其它见过的形态
    if (typeof jsonData?.part?.text === "string") return jsonData.part.text;
    if (typeof jsonData?.item?.content?.[0]?.text === "string") return jsonData.item.content[0].text;

    return "";
}

// 只渲染 <final>…</final> 中的内容（若存在）；否则原样返回
function visibleTextFrom(raw) {
    if (!raw) return "";
    const m = raw.match(/<final>([\s\S]*?)<\/final>/i);
    return m ? m[1] : raw;
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
    if (window.marked) {
        return window.marked.parse(safe);
    }
    const div = document.createElement("div");
    div.textContent = safe;
    return div.innerHTML;
}

function highlightCode(el) {
    if (window.hljs) {
        el.querySelectorAll("pre code").forEach((block) => {
            window.hljs.highlightElement(block);
        });
    }
    addCopyButtons(el);
}

function addCopyButtons(el) {
    el.querySelectorAll("pre").forEach((pre) => {
        if (pre.querySelector(".copy-btn")) return;
        const btn = document.createElement("button");
        btn.textContent = "Copy";
        btn.className = "copy-btn";
        btn.addEventListener("click", () => {
            const code = pre.querySelector("code")?.innerText || pre.innerText || "";
            navigator.clipboard.writeText(code).then(() => {
                btn.textContent = "Copied!";
                setTimeout(() => (btn.textContent = "Copy"), 1200);
            });
        });
        pre.style.position = "relative";
        btn.style.position = "absolute";
        btn.style.top = "6px";
        btn.style.right = "6px";
        pre.appendChild(btn);
    });
}
