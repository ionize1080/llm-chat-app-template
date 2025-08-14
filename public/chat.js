/**
 * LLM Chat App Frontend (fixed)
 * 兼容两类流式返回：
 * 1) Workers AI/常规模型：{ "response": "..." }
 * 2) OpenAI 兼容/GPT-OSS：{ "choices":[{"delta":{"content": "...或对象"}}] }
 * 注意：delta.content 可能是对象，需要提取字符串字段。
 */

// DOM elements
const chatMessages   = document.getElementById("chat-messages");
const userInput      = document.getElementById("user-input");
const sendButton     = document.getElementById("send-button");
const typingIndicator= document.getElementById("typing-indicator");
const modelSelect    = document.getElementById("model-select");

// Markdown 渲染
let markedConfigured = false;
function renderMarkdown(text) {
  const safe = typeof text === "string" ? text : String(text ?? "");
  if (window.marked) {
    if (window.hljs && !markedConfigured) {
      window.marked.setOptions({
        highlight(code, lang) {
          if (lang && window.hljs.getLanguage(lang)) {
            return window.hljs.highlight(code, { language: lang }).value;
          }
          return window.hljs.highlightAuto(code).value;
        },
      });
      markedConfigured = true;
    }
    return window.marked.parse(safe);
  }
  const div = document.createElement("div");
  div.textContent = safe;
  return div.innerHTML;
}

function addCopyButtons(el) {
  el.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      const text = code ? code.innerText : pre.innerText;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 2000);
      }).catch(() => {
        btn.textContent = "Failed";
        setTimeout(() => (btn.textContent = "Copy"), 2000);
      });
    });
    pre.appendChild(btn);
  });
}

function highlightCode(el) {
  if (window.hljs) {
    el.querySelectorAll("pre code").forEach((block) => {
      window.hljs.highlightElement(block);
    });
  }
  addCopyButtons(el);
}

// Chat state
let chatHistory = [
  {
    role: "assistant",
    content:
      "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
  },
];
let isProcessing = false;

// 自动高度
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Enter 发送
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendButton.addEventListener("click", sendMessage);

// --- 修正部分：增强的文本提取工具 ---
function extractTextFromDeltaContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;

  // 常见字段
  if (typeof content.value === "string") return content.value;
  if (typeof content.text === "string")  return content.text;
  if (typeof content.content === "string") return content.content;

  if (Array.isArray(content)) {
    return content.map(extractTextFromDeltaContent).join("");
  }
  
  const maybe = [];
  for (const k of ["value","text","content"]) {
    if (typeof content[k] === "string") maybe.push(content[k]);
  }
  if (maybe.length) return maybe.join("");

  return "";
}

function pickChunkText(jsonData) {
  if (typeof jsonData?.response === "string") {
    return jsonData.response;
  }
  
  const ch = jsonData?.choices?.[0];
  if (ch?.delta?.content !== undefined) {
    return extractTextFromDeltaContent(ch.delta.content);
  }
  if (typeof ch?.text === "string") return ch.text;
  if (typeof ch?.message?.content === "string") return ch.message.content;

  // 新增对您提供日志中格式的支持
  if (typeof jsonData?.part?.text === 'string') {
    return jsonData.part.text;
  }
  if (typeof jsonData?.item?.content?.[0]?.text === 'string') {
    return jsonData.item.content[0].text;
  }

  return "";
}

/**
 * 发送并解析流
 */
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
      throw new Error("Failed to get response");
    }

    const reader   = response.body.getReader();
    const decoder  = new TextDecoder();
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const raw of lines) {
        if (!raw) continue;
        if (!raw.trim().startsWith("data:")) continue;

        const jsonStr = raw.replace(/^data:\s*/, "").trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const jsonData = JSON.parse(jsonStr);
          const content  = pickChunkText(jsonData);
          if (content) {
            responseText += content;
            assistantMessageEl.innerHTML = renderMarkdown(responseText);
            highlightCode(assistantMessageEl);
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch (e) {
          console.warn("SSE JSON parse skipped:", jsonStr);
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
