/**
 * LLM Chat App Frontend (fixed)
 * 兼容三类流式返回：
 * 1) Workers AI/常规模型：{ "response": "..." }
 * 2) OpenAI Chat Completions：data: {"choices":[{"delta":{"content": "..."}}]}
 * 3) OpenAI Responses：data: {"type":"response.output_text.delta","delta":"..."} ... "response.completed"
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
userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 200) + "px";
});

// Send with Enter (Shift+Enter for newline)
userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

sendButton.addEventListener("click", () => {
    sendMessage();
});

async function sendMessage() {
    const message = userInput.value.trim();
    if (message === "" || isProcessing) return;

    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;

    addMessageToChat("user", message);
    userInput.value = "";
    userInput.style.height = "auto";
    typingIndicator.classList.add("visible");

    chatHistory.push({ role: "user", content: message });

    try {
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "";
        chatMessages.appendChild(assistantMessageEl);
        highlightCode(assistantMessageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: chatHistory,
                model: modelSelect.value,
            }),
        });

        if (response.status === 403) {
            const data = await response.json().catch(() => ({}));
            addMessageToChat("assistant", data.error || "网站正在建设中");
            return;
        }
        if (!response.ok || !response.body) {
            throw new Error("Network error");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";
        let sseBuffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });

            // 按 SSE 事件块分割（以空行结尾）
            const events = sseBuffer.split("\n\n");
            sseBuffer = events.pop() || ""; // 半包留到下次

            for (const evt of events) {
                // 一个事件内部可能有多行：event:/id:/retry:/data:
                const lines = evt.split("\n");
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (!trimmed.startsWith("data:")) continue;
                    const jsonStr = trimmed.replace(/^data:\s*/, "").trim();
                    if (!jsonStr || jsonStr === "[DONE]") continue;
                    try {
                        const jsonData = JSON.parse(jsonStr);
                        const piece = pickChunkText(jsonData);
                        if (piece) {
                            responseText += piece;
                            assistantMessageEl.innerHTML = renderMarkdown(responseText);
                            highlightCode(assistantMessageEl);
                            chatMessages.scrollTop = chatMessages.scrollHeight;
                        }
                    } catch {
                        // 忽略解析失败的 data 行
                    }
                }
            }
        }

        chatHistory.push({ role: "assistant", content: responseText });
    } catch (err) {
        console.error(err);
        addMessageToChat("assistant", "Sorry, there was an error processing your request.");
    } finally {
        typingIndicator.classList.remove("visible");
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        userInput.focus();
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
        // 有些实现把对象塞进 content，尝试提取常见字段
        if (content && typeof content === "object") {
            if (typeof content?.text === "string") return content.text;
            if (typeof content?.data?.text === "string") return content.data.text;
        }
        return "";
    }
    if (typeof ch?.text === "string") return ch.text;
    if (typeof ch?.message?.content === "string") return ch.message.content;

    // 4) 其它见过的形态
    if (typeof jsonData?.part?.text === 'string') return jsonData.part.text;
    if (typeof jsonData?.item?.content?.[0]?.text === 'string') return jsonData.item.content[0].text;

    return "";
}

// ========== 辅助 UI ==========

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
