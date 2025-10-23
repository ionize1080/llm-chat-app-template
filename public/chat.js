/**
 * LLM Chat App Frontend (Raw SSE mode + final-only rendering + gate + download)
 * - 兼容 Workers 原生 / OpenAI Chat Completions / OpenAI Responses
 * - 展示侧忽略 reasoning* 事件
 * - completed：若完整文本更长则替换此前增量
 * - 仅渲染“最后一个” <final>…</final>；若仅有 … 则兜底回退
 * - Raw 模式门控：在看到 <final> 前不渲染正文（防止推理/自述闪现）
 * - 支持：源SSE模式（/api/chat/raw）与 原始SSE捕获 + 复制 + 下载
 */

// DOM
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const modelSelect = document.getElementById("model-select");
const rawToggleBtn = document.getElementById("raw-toggle");
const sourceToggleBtn = document.getElementById("source-toggle");
// Inject a demo button if missing (to verify math rendering quickly)
const headerRightEl = document.querySelector('.header-right');
let demoInsertBtn = document.getElementById('demo-insert');
if (headerRightEl && !demoInsertBtn) {
    demoInsertBtn = document.createElement('button');
    demoInsertBtn.id = 'demo-insert';
    demoInsertBtn.className = 'ghost-btn';
    demoInsertBtn.title = '插入示例内容作为助手消息进行渲染验证';
    demoInsertBtn.textContent = '🧪 插入示例';
    headerRightEl.appendChild(demoInsertBtn);
}

let isProcessing = false;
const chatHistory = [];

// 两个开关（持久化）
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
    rawToggleBtn.title = captureRawSSE ? "当前将记录并可复制/下载每次回答的原始SSE流" : "点击开启原始SSE捕获";
}
function updateSourceToggleUI() {
    if (!sourceToggleBtn) return;
    sourceToggleBtn.classList.toggle("active", useRawEndpoint);
    sourceToggleBtn.textContent = useRawEndpoint ? "🌊 源SSE模式：开启" : "🌊 源SSE模式：关闭";
    sourceToggleBtn.title = useRawEndpoint ? "使用 /api/chat/raw，直接消费上游原始SSE" : "使用 /api/chat（规范化SSE）";
}

// 输入框交互
if (userInput) {
    userInput.addEventListener("input", () => {
        userInput.style.height = "auto";
        userInput.style.height = Math.min(userInput.scrollHeight, 200) + "px";
    });
    userInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
}
if (sendButton) sendButton.addEventListener("click", () => sendMessage());
if (demoInsertBtn) {
    demoInsertBtn.addEventListener('click', () => {
        const sample = String.raw`里叶变换（Fourier Transform） 是一种把时间（或空间）域的信号转换到频率域的数学工具。它揭示了信号中各个不同频率成分的幅度和相位分布。

1. 连续时间傅里叶变换（CTFT）
正向变换（从时域到频域）
[ \\boxed{X(\\omega)=\\mathcal{F}{x(t)}=\\int_{-\\infty}^{\\infty} x(t),e^{-j\\omega t},dt} ]

(x(t))：时域信号（实数或复数）。
(X(\\omega))：频域函数，频率变量 (\\omega)（弧度/秒）。
(j=\\sqrt{-1})。
负指数 (e^{-j\\omega t}) 表示把信号投影到复指数基 (\\exp(j\\omega t)) 上。
逆变换（从频域回到时域）
[ \\boxed{x(t)=\\mathcal{F}^{-1}{X(\\omega)}=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty} X(\\omega),e^{j\\omega t},d\\omega} ]

用 (2\\pi) 归一化因子保证变换是可逆的。
2. 连续时间傅里叶级数（周期信号）
对周期为 (T)（基本频率 (\\omega_0=2\\pi/T)）的信号 (x(t))，可以用离散频谱表示：

[ x(t)=\\sum_{k=-\\infty}^{\\infty} C_k,e^{j k\\omega_0 t},\\qquad C_k=\\frac{1}{T}\\int_{t_0}^{t_0+T} x(t),e^{-j k\\omega_0 t},dt ]

3. 离散时间傅里叶变换（DTFT）
对离散时间序列 (x[n])（(n\\in\\mathbb{Z})）：

[ \\boxed{X(e^{j\\omega})=\\sum_{n=-\\infty}^{\\infty} x[n],e^{-j\\omega n}} ]

(\\omega) 为归一化角频率（弧度/样本），周期为 (2\\pi)。
逆变换：
[ x[n]=\\frac{1}{2\\pi}\\int_{-\\pi}^{\\pi} X(e^{j\\omega}),e^{j\\omega n},d\\omega ]

4. 快速傅里叶变换（FFT）
FFT 并不是新公式，而是一种 O(N log N) 计算离散傅里叶变换（DFT）的高效算法。

离散傅里叶变换（DFT）定义（长度为 (N)）：

[ X[k]=\\sum_{n=0}^{N-1} x[n];e^{-j\\frac{2\\pi}{N}kn},\\qquad k=0,1,\\dots,N-1 ]

逆变换：

[ x[n]=\\frac{1}{N}\\sum_{k=0}^{N-1} X[k];e^{j\\frac{2\\pi}{N}kn} ]

5. 核心概念解释
概念\t含义
频率 (\\omega)\t信号随时间变化的快慢，单位为弧度/秒（连续）或弧度/样本（离散）。
复指数基 (\\mathrm{e}^{j\\omega t})\t复数正弦波，等价于 (\\cos(\\omega t)+j\\sin(\\omega t))。傅里叶变换把信号拆分成这些基函数的线性组合。
**幅度谱** ( |X(\\omega)| )\t各频率分量的幅值分布。
相位谱 (\\arg{X(\\omega)})\t各频率分量相对于参考时刻的相位偏移，决定信号在时域的形状。
时频互补性\t时间分辨率好 ↔ 频率分辨率差，反之亦然（不确定性原理）。
线性与时移属性 (\\mathcal{F}{a,x_1(t)+b,x_2(t)}=aX_1(\\omega)+bX_2(\\omega))；(\\mathcal{F}{x(t-t_0)}=X(\\omega)e^{-j\\omega t_0})。
6. 示例
例 1：单位冲击（Dirac delta）
(x(t)=\\delta(t))

[ X(\\omega)=\\int_{-\\infty}^{\\infty}\\delta(t)e^{-j\\omega t}dt = 1 ]

→ 所有频率幅度相同，表示冲击在频域是“白噪声”。

例 2：单频正弦波
(x(t)=\\cos(\\omega_0 t)=\\frac{1}{2}\\big(e^{j\\omega_0 t}+e^{-j\\omega_0 t}\\big))

[ X(\\omega)=\\pi\\big[\\delta(\\omega-\\omega_0)+\\delta(\\omega+\\omega_0)\\big] ]

→ 频谱只在 (\\pm\\omega_0) 处出现两条冲击，说明信号只含单一频率。

7. 常用应用
信号分析：识别音频、通信、振动等信号中的频率成分。
滤波：在频域设计低通/高通/带通滤波器，再转回时域实现。
图像处理：二维傅里叶变换用于频谱分析、去噪、特征提取。
谱估计：功率谱密度（PSD）是 (|X(\\omega)|^2) 的期望，描述随机信号的能量分布。
小结
傅里叶变换把一个随时间（或空间）变化的函数表示为不同正弦（余弦）成分的叠加。其核心公式为

[ X(\\omega)=\\int_{-\\infty}^{\\infty} x(t)e^{-j\\omega t}dt,\\qquad x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty} X(\\omega)e^{j\\omega t}d\\omega, ]

并通过离散、周期、快速等不同形式在实际工程中广泛使用。希望以上公式与解释能帮助你理解傅里叶变换的本质与用途。`;
        addMessageToChat('assistant', sample);
    });
}

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
        let seenFinalOpen = false;       // ★ 门控：出现 <final> 才渲染
        const rawBlocks = [];            // 原始事件块文本

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkStr = decoder.decode(value, { stream: true });
            sseBuffer += chunkStr;

            // 按事件块切分（空行）
            const events = sseBuffer.split("\n\n");
            sseBuffer = events.pop() || "";

            for (const evt of events) {
                if (captureRawSSE) rawBlocks.push(evt + "\n\n");

                const lines = evt.split("\n");
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line || !line.startsWith("data:")) continue;

                    const jsonStr = line.replace(/^data:\s*/, "").trim();
                    if (!jsonStr || jsonStr === "[DONE]") continue;

                    let jsonData;
                    try { jsonData = JSON.parse(jsonStr); } catch { continue; }

                    // 展示时忽略 reasoning 事件（原始捕获不受影响）
                    if (jsonData?.type && String(jsonData.type).startsWith("response.reasoning")) continue;

                    const piece = pickChunkText(jsonData);
                    if (!piece) continue;

                    if (!hasFirstPiece) { assistantMessageEl.textContent = ""; hasFirstPiece = true; }

                    // 记录是否见到 <final>
                    if (piece.includes("<final>")) seenFinalOpen = true;

                    // 累积文本 / 替换 completed
                    if (jsonData?.type === "response.completed") {
                        if (piece.length > responseText.length + 8) responseText = piece; // 更长则替换
                    } else {
                        responseText += piece; // 增量累积
                    }

                    // ★ 门控渲染：未见 <final> 前不展示正文，保持“正在生成…”
                    if (!seenFinalOpen) {
                        assistantMessageEl.textContent = "正在生成…";
                    } else {
                        assistantMessageEl.innerHTML = renderMarkdown(visibleTextFrom(responseText));
                        highlightCode(assistantMessageEl);
                        typesetMath(assistantMessageEl);
                    }
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
            }
        }

        // —— 完成后：无论是否见到 <final>，都进行一次最终渲染 —— //
        let finalToShow = seenFinalOpen ? visibleTextFrom(responseText) : (responseText || "");
        finalToShow = (finalToShow || "").trim();

        if (!finalToShow || finalToShow === "..." || finalToShow === "…") {
            finalToShow = "这次生成出了点问题，请重试或换个问法。";
        }

        assistantMessageEl.innerHTML = renderMarkdown(finalToShow);
        highlightCode(assistantMessageEl);
        typesetMath(assistantMessageEl);

        // 原始SSE复制/下载条
        if (captureRawSSE && rawBlocks.length) {
            appendRawCopyBar(assistantMessageEl, rawBlocks.join(""));
        }

        chatHistory.push({ role: "assistant", content: finalToShow || visibleTextFrom(responseText) });
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

// —— 只渲染“最后一个” <final>…</final>；过滤占位 … —— //
function visibleTextFrom(raw) {
    if (!raw) return "";
    const matches = [...raw.matchAll(/<final>([\s\S]*?)<\/final>/gi)];
    if (matches.length) {
        const last = (matches[matches.length - 1][1] || "").trim();
        if (last && last !== "..." && last !== "…") return last;
    }
    return raw;
}

// 生成下载文件名（模型名 + 时间戳）
function makeSSEFileName() {
    const rawModel = (modelSelect && modelSelect.value) || "model";
    const model = rawModel.replace(/[^a-zA-Z0-9._-]/g, "-"); // 简易清洗
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `sse_${model}_${stamp}.txt`;
}

// 原始SSE复制/下载条
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

    // 复制按钮
    const copyBtn = document.createElement("button");
    copyBtn.className = "sse-copy-btn";
    copyBtn.textContent = "复制原始SSE流";
    copyBtn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(rawText);
            const old = copyBtn.textContent;
            copyBtn.textContent = "已复制 ✓";
            setTimeout(() => (copyBtn.textContent = old), 1200);
        } catch {
            copyBtn.textContent = "复制失败";
            setTimeout(() => (copyBtn.textContent = "复制原始SSE流"), 1200);
        }
    });

    // 下载按钮
    const downloadBtn = document.createElement("button");
    downloadBtn.className = "sse-download-btn";
    downloadBtn.textContent = "下载原始SSE(.txt)";
    downloadBtn.addEventListener("click", () => {
        try {
            const blob = new Blob([rawText], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = makeSSEFileName();
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch {
            downloadBtn.textContent = "下载失败";
            setTimeout(() => (downloadBtn.textContent = "下载原始SSE(.txt)"), 1200);
        }
    });

    right.appendChild(copyBtn);
    right.appendChild(downloadBtn);

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
        typesetMath(messageEl);
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
    const pre = preprocessMath(safe);
    if (window.marked) return window.marked.parse(pre);
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

// MathJax typesetting helper
function typesetMath(el) {
    try {
        if (window.MathJax && window.MathJax.typesetPromise) {
            window.MathJax.typesetPromise([el]).catch((e) => console.error(e));
        }
    } catch (e) {
        console.error(e);
    }
}

// Heuristic math preprocessor: support `[ ... ]` blocks and parentheses with TeX commands.
function preprocessMath(input) {
    let out = input;

    // Strip stray meta tags like <final> that may leak into content
    out = out.replace(/<\/?final>/gi, "");

    // 0) Normalize explicit TeX delimiters that Marked may eat (\\( ... \\) and \\[ ... \\])
    //    Convert to $...$ and $$...$$ so Markdown parser won't strip backslashes.
    out = out.replace(/\\\(([\s\S]*?)\\\)/g, (m, inner) => `$${inner}$`);
    out = out.replace(/\\\[([\s\S]*?)\\\]/g, (m, inner) => `$$ ${inner} $$`);

    // 1) Block-level: a line that is just `[ ... ]` -> `$$ ... $$`
    //    Skip Markdown links like `[text](url)` or references `[id]: url`.
    out = out.replace(/^\s*\[\s*([\s\S]*?)\s*\]\s*$/gm, (m, inner) => {
        if (/\]\s*\(/.test(m)) return m;     // looks like a link
        if (/^\s*\[[^\]]+\]:/m.test(m)) return m; // reference-style link
        return `$$ ${inner} $$`;
    });

    // 2) Inline: wrap parentheses containing TeX commands into `\( ... \)`
    //    e.g. `(\omega)` -> `\(\omega\)`; avoid already-escaped `\(`.
    out = out.replace(/(^|[^\\])\(([^()\n]{0,200}\\[a-zA-Z][^()\n]{0,200})\)/g, (m, pre, inner) => `${pre}\\(${inner}\\)`);

    return out;
}
