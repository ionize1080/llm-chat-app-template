import { icon } from "./icons.mjs";
import { marked } from "marked";
import DOMPurify from "dompurify";
import renderMath from "katex/contrib/auto-render";
import { MODELS, cleanAnswer, extractText } from "./shared.mjs";
import { publicURL } from "./search.mjs";
const $ = (s) => document.querySelector(s);
let user = null,
  models = MODELS,
  mode = "chat",
  messages = [],
  id = crypto.randomUUID(),
  busy = false,
  attachment = null,
  controller = null,
  history = [],
  loadingFile = false;
let useSearch = false;
const input = $("#input"),
  send = $("#send"),
  modelSelect = $("#model"),
  scroll = $("#scroll-area");
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!r.ok) {
    const b = await r
      .json()
      .catch(() => ({ error: "网络连接异常，请稍后重试。" }));
    throw new Error(b.error || "请求失败");
  }
  return r;
}
function showNotice(s = "") {
  $("#notice").textContent = s;
  $("#notice").hidden = !s;
}
function enable() {
  send.disabled = loadingFile || (!busy && !input.value.trim() && !attachment);
  send.innerHTML = icon(busy ? "stop" : "send");
  send.setAttribute("aria-label", busy ? "停止生成" : "发送消息");
  $("#upload").disabled = busy || mode === "image" || loadingFile;
  modelSelect.disabled = busy;
  $("#model-trigger").disabled = busy;
  $("#web-search").disabled = busy;
  document
    .querySelectorAll("[data-mode],#new-chat")
    .forEach((e) => (e.disabled = busy));
}
function scrollEnd() {
  scroll.scrollTop = scroll.scrollHeight;
}
function sidebar(open) {
  document.body.classList.toggle("sidebar-open", open);
  $("#shade").hidden = !open;
  $("#sidebar").inert = !open && matchMedia("(max-width:760px)").matches;
  $("#menu").setAttribute("aria-expanded", String(open));
}
function setMode(next) {
  if (busy) return;
  mode = next;
  document
    .querySelectorAll("[data-mode]")
    .forEach((e) => e.classList.toggle("active", e.dataset.mode === mode));
  $("#workspace-label").textContent = mode === "chat" ? "自由对话" : "图片创作";
  $(".model-control").hidden = mode === "image";
  $("#image-model").hidden = mode !== "image";
  $("#upload").hidden = mode === "image";
  $(".tool-divider").hidden = mode === "image";
  $("#web-search").hidden = mode === "image";
  closePicker();
  paintModel();
  input.placeholder =
    mode === "image"
      ? "描述你想看见的画面，英文提示词效果更稳定…"
      : "有什么想一起探索的？";
  $("#welcome h1").innerHTML =
    mode === "image"
      ? "让想象，<span>有一幅模样。</span>"
      : "想法，<span>从这里开始。</span>";
  $("#welcome-description").textContent =
    mode === "image"
      ? "写下光线、色彩与场景，让灵感成为画面。"
      : "一起探索问题、梳理灵感，把好奇变成下一步。";
  const cards = document.querySelectorAll("[data-prompt]");
  const prompts =
    mode === "image"
      ? [
          "A quiet Japanese garden after rain, soft morning light, film photography, muted green tones",
          "A tiny bookstore floating among clouds, warm lights, detailed watercolor illustration",
          "Minimal abstract poster, sage green and cream, organic geometric shapes, editorial design",
        ]
      : [
          "请帮我把下面的想法整理成清晰、可执行的计划：",
          "请用通俗的语言解释下面这个概念，并给出生活中的例子：",
          "请帮我检查下面的代码，解释问题并给出改进建议：",
        ];
  cards.forEach((c, i) => {
    c.dataset.prompt = prompts[i];
    c.querySelector("strong").textContent = (
      mode === "image"
        ? ["雨后的庭院", "云端书店", "极简海报"]
        : ["梳理一个想法", "学懂一个概念", "一起写点代码"]
    )[i];
    c.querySelector("small").textContent = (
      mode === "image"
        ? [
            "自然光影 · 摄影风格",
            "温暖治愈 · 水彩插画",
            "留白与形状 · 平面设计",
          ]
        : ["让灵感落到纸面上", "复杂的事，简单说", "从思路到实现"]
    )[i];
  });
  $("#document-card").hidden = mode === "image";
  $("#welcome .welcome-note").textContent =
    mode === "image"
      ? "↳ 图片与聊天共享免费额度，生成后可以下载。"
      : "↳ 可以聊文字，也可以带上一张图片或一份文件。";
  enable();
}
function reset(next = mode) {
  if (busy) return;
  messages = [];
  id = crypto.randomUUID();
  attachment = null;
  input.value = "";
  renderAttachment();
  showNotice();
  setMode(next);
  render();
  sidebar(false);
  input.focus();
}
function renderAttachment() {
  const el = $("#attachments");
  el.replaceChildren();
  if (!attachment) return;
  const chip = document.createElement("div");
  chip.className = "attachment";
  if (attachment.image) {
    const img = document.createElement("img");
    img.src = attachment.image;
    img.alt = "附件预览";
    chip.append(img);
  }
  const text = document.createElement("span");
  text.textContent =
    attachment.name +
    (attachment.text ? " · " + attachment.text.length + " 字" : "");
  const remove = document.createElement("button");
  remove.textContent = "×";
  remove.ariaLabel = "移除附件";
  remove.onclick = () => {
    attachment = null;
    renderAttachment();
    enable();
  };
  chip.append(text, remove);
  el.append(chip);
}
function render() {
  $("#welcome").hidden = messages.length > 0;
  const root = $("#messages");
  root.replaceChildren();
  for (const [index, m] of messages.entries()) {
    const node = document.createElement("article");
    node.className = "message " + m.role;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML =
      m.role === "user"
        ? "你"
        : `<span class="badge">VEAIX</span> ${escape(m.model || "")}`;
    const body = document.createElement("div");
    body.className = "body";
    if (m.role === "user") {
      body.textContent = m.display || m.content;
      if (m.image) {
        const img = document.createElement("img");
        img.src = m.image;
        img.className = "uploaded";
        img.alt = "上传的图片";
        body.prepend(img);
      }
      if (m.file) {
        const file = document.createElement("small");
        file.textContent = "\n▤ " + m.file;
        body.append(file);
      }
    } else if (m.picture) {
      if (
        /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(m.picture) ||
        /^\/api\/media\/[a-f0-9-]{36}$/.test(m.picture)
      ) {
        const img = document.createElement("img");
        img.src = m.picture;
        img.className = "generated";
        img.alt = "AI 生成的图片";
        body.append(img);
      }
    } else if (!m.content && busy && index === messages.length - 1) {
      body.innerHTML =
        '<span class="loading">' +
        (m.search
          ? "正在查找来源并整理回答…"
          : mode === "image"
            ? "正在创作画面，稍等片刻…"
            : "正在思考，稍等片刻…") +
        "</span>";
    } else {
      body.innerHTML = DOMPurify.sanitize(
        marked.parse(cleanAnswer(m.content)),
        {
          FORBID_TAGS: ["img", "iframe", "style", "form", "input", "button"],
          FORBID_ATTR: ["style"],
        },
      );
      body.querySelectorAll("a").forEach((a) => {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      });
      try {
        renderMath(body, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "\\(", right: "\\)", display: false },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
          trust: false,
        });
      } catch {}
    }
    if (m.error) {
      const err = document.createElement("p");
      err.className = "error-text";
      err.textContent = m.error;
      body.append(err);
    }
    node.append(meta, body);
    if (m.sources?.length) {
      const sources = document.createElement("details");
      sources.className = "sources";
      const summary = document.createElement("summary");
      summary.textContent = "参考来源 · " + m.sources.length;
      sources.append(summary);
      for (const [i, source] of m.sources.slice(0, 5).entries()) {
        const url = publicURL(source.url);
        if (!url) continue;
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const title = document.createElement("strong"),
          host = document.createElement("small");
        title.textContent = `${i + 1}. ${String(source.title).slice(0, 180)}`;
        host.textContent = new URL(url).hostname;
        link.append(title, host);
        sources.append(link);
      }
      node.append(sources);
    }
    if (m.role === "assistant" && (m.content || m.picture || m.error)) {
      const actions = document.createElement("div");
      actions.className = "message-actions";
      if (m.content) {
        const copy = document.createElement("button");
        copy.innerHTML = icon("copy") + "<span>复制</span>";
        copy.onclick = () =>
          navigator.clipboard
            .writeText(cleanAnswer(m.content))
            .then(() => toast("已复制"))
            .catch(() => toast("复制失败，请手动选择文字"));
        actions.append(copy);
      }
      if (m.picture) {
        const download = document.createElement("a");
        download.href = m.picture;
        download.download = "veaix-" + Date.now() + ".jpg";
        download.innerHTML = icon("download") + "<span>下载图片</span>";
        actions.append(download);
      }
      if (index === messages.length - 1 && !busy) {
        const retry = document.createElement("button");
        retry.innerHTML = icon("refresh") + "<span>重新生成</span>";
        retry.onclick = () => {
          messages.pop();
          generate(true);
        };
        actions.append(retry);
      }
      node.append(actions);
    }
    root.append(node);
  }
}
function paintHistory() {
  const root = $("#history");
  root.replaceChildren();
  if (!user || !history.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = user
      ? "还没有保存的对话，开始聊聊吧。"
      : "给想法一个归处。登录后，在这里继续之前的对话。";
    root.append(empty);
    return;
  }
  for (const h of history) {
    const row = document.createElement("div");
    row.className = "history-row" + (h.id === id ? " selected" : "");
    const open = document.createElement("button");
    open.textContent = h.title;
    open.title = h.title;
    open.onclick = async () => {
      if (busy) return;
      try {
        const b = await (await api("/api/history/" + h.id)).json();
        id = h.id;
        messages = b.messages;
        modelSelect.value = b.model;
        setMode(b.mode);
        attachment = null;
        renderAttachment();
        render();
        paintHistory();
        sidebar(false);
        scrollEnd();
      } catch (e) {
        toast(e.message);
      }
    };
    const del = document.createElement("button");
    del.className = "history-delete";
    del.textContent = "×";
    del.ariaLabel = "删除 " + h.title;
    del.onclick = async () => {
      if (busy || !confirm("删除这段对话？此操作无法撤销。")) return;
      try {
        await api("/api/history/" + h.id, { method: "DELETE" });
        if (id === h.id) reset();
        await refreshHistory();
      } catch (e) {
        toast(e.message);
      }
    };
    row.append(open, del);
    root.append(row);
  }
}
async function refreshHistory() {
  if (!user) {
    history = [];
    paintHistory();
    return;
  }
  try {
    history = await (await api("/api/history")).json();
    paintHistory();
  } catch (e) {
    toast(e.message);
  }
}
async function save() {
  if (!user || !messages.length) return;
  const title = (messages[0].display || messages[0].content).slice(0, 36);
  try {
    await api("/api/history/" + id, {
      method: "PUT",
      body: JSON.stringify({ title, messages, mode, model: modelSelect.value }),
    });
    await refreshHistory();
  } catch (e) {
    showNotice("历史记录未保存：" + e.message);
  }
}
function account() {
  $("#account-label").replaceChildren();
  const label = document.createElement("span");
  label.textContent = user ? "Ionize 的空间" : "登录保存对话";
  const small = document.createElement("small");
  small.textContent = user ? "历史记录已开启" : "游客模式 · 不保留历史";
  $("#account-label").append(label, small);
  $("#privacy-note").textContent = user
    ? "对话自动保存到你的账户。"
    : "游客对话不会保存，刷新即清空。";
}
async function generate(retry = false) {
  if (busy || loadingFile) return;
  const text = input.value.trim();
  if (!retry && !text && !attachment) return;
  showNotice();
  if (!retry) {
    let content = text || "请总结这份文件的内容。";
    const m = { role: "user", content, display: content };
    if (attachment) {
      m.file = attachment.name;
      if (attachment.image) m.image = attachment.image;
      if (attachment.text)
        m.content +=
          '\n\n<uploaded_document name="' +
          attachment.name.replace(/[<>"&]/g, "_") +
          '">\n' +
          attachment.text +
          "\n</uploaded_document>";
    }
    messages.push(m);
    input.value = "";
    input.style.height = "auto";
    attachment = null;
    renderAttachment();
  }
  const selected = models.find((m) => m.id === modelSelect.value) || models[0];
  const response = {
    role: "assistant",
    content: "",
    model: mode === "image" ? "FLUX.1 Schnell" : selected.name,
    search: mode === "chat" && useSearch,
  };
  messages.push(response);
  busy = true;
  controller = new AbortController();
  enable();
  render();
  scrollEnd();
  const timeout = setTimeout(() => controller.abort("timeout"), 180000);
  try {
    if (mode === "image") {
      const r = await api("/api/image", {
        method: "POST",
        body: JSON.stringify({ prompt: messages.at(-2).content }),
        signal: controller.signal,
      });
      const b = await r.json();
      response.picture = b.url;
      if (b.temporary && user)
        showNotice("这张图片较大，只在当前页面保留，请及时下载。");
    } else {
      let context = messages
        .slice(0, -1)
        .filter((m) => !m.error && !m.picture && m.content)
        .slice(-24);
      while (context.length > 1 && context[0].role !== "user") context.shift();
      if (context.some((m) => m.image) && !selected.vision)
        throw new Error("这段对话包含图片，请切换 Gemma 4 或 Qwen 3.8。");
      const r = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          model: selected.id,
          search: useSearch,
          messages: context.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.image ? { image: m.image } : {}),
          })),
        }),
        signal: controller.signal,
      });
      const reader = r.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        ended = false,
        lastPaint = 0;
      const parse = (event) => {
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) return;
        if (data === "[DONE]") {
          ended = true;
          return;
        }
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          return;
        }
        if (obj.error || obj.errors?.length)
          throw new Error(
            obj.error?.message || obj.error || "模型生成中断，请重试。",
          );
        response.content += extractText(obj);
        if (Array.isArray(obj.sources)) response.sources = obj.sources;
        if (obj.choices?.[0]?.finish_reason) {
          ended = true;
          if (obj.choices[0].finish_reason === "length")
            response.error = "已达到单次输出上限，可以继续追问。";
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let pos;
        while ((pos = buffer.indexOf("\n\n")) >= 0) {
          parse(buffer.slice(0, pos));
          buffer = buffer.slice(pos + 2);
        }
        if (done) {
          if (buffer.trim()) parse(buffer);
          break;
        }
        if (Date.now() - lastPaint > 100) {
          const near =
            scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 150;
          render();
          if (near) scrollEnd();
          lastPaint = Date.now();
        }
      }
      response.content = cleanAnswer(response.content);
      if (!response.content)
        throw new Error("模型没有返回有效内容，请重试或切换模型。");
      if (!ended) response.error = "连接提前结束，回答可能不完整。";
    }
  } catch (e) {
    if (controller.signal.aborted) {
      response.error =
        controller.signal.reason === "timeout"
          ? "等待超时，请重试或切换模型。"
          : "已停止生成。";
    } else response.error = e.message;
  } finally {
    clearTimeout(timeout);
    busy = false;
    controller = null;
    enable();
    render();
    scrollEnd();
    await save();
  }
}
async function readFile(file) {
  if (!file) return;
  if (busy) return;
  if (file.size > 10 * 1024 * 1024) {
    toast("文件不能超过 10 MB");
    return;
  }
  loadingFile = true;
  enable();
  showNotice("正在读取文件…");
  try {
    const name = file.name;
    const ext = name.split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const c = canvas.getContext("2d");
      c.fillStyle = "#fff";
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      attachment = { name, image: canvas.toDataURL("image/jpeg", 0.8) };
      if (!models.find((m) => m.id === modelSelect.value)?.vision) {
        modelSelect.value = "@cf/google/gemma-4-26b-a4b-it";
        paintModel();
        toast("已切换到 Gemma 4 以读取图片");
      }
    } else {
      let text = "",
        truncated = false;
      if (ext === "pdf") {
        const pdfjs = await import("/vendor/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
        const pdf = await pdfjs.getDocument({
          data: await file.arrayBuffer(),
          cMapUrl: "/vendor/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/vendor/standard_fonts/",
          isEvalSupported: false,
        }).promise;
        try {
          for (let i = 1; i <= Math.min(pdf.numPages, 40); i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text +=
              "\n[第 " +
              i +
              " 页]\n" +
              content.items.map((v) => v.str).join(" ");
            if (text.length > 24000) {
              truncated = true;
              break;
            }
          }
          if (pdf.numPages > 40) truncated = true;
        } finally {
          await pdf.destroy();
        }
        if (text.replace(/\[第 \d+ 页\]/g, "").trim().length < 10)
          throw new Error(
            "这份 PDF 没有可提取的文字。请上传页面截图进行识别。",
          );
      } else if (
        [
          "txt",
          "md",
          "csv",
          "json",
          "js",
          "ts",
          "py",
          "html",
          "css",
          "xml",
          "yaml",
          "yml",
          "log",
        ].includes(ext)
      ) {
        text = await file.text();
        if (text.includes("\u0000"))
          throw new Error("不支持二进制文件，请上传文本或 PDF。");
      } else
        throw new Error("支持图片、PDF、TXT、Markdown、CSV 和常见代码文件。");
      if (text.length > 24000) truncated = true;
      attachment = { name, text: text.slice(0, 24000) };
      if (truncated)
        toast("已截取前 24,000 字／最多 40 页，其余内容不会发送。");
    }
    showNotice();
    renderAttachment();
    input.focus();
  } catch (e) {
    showNotice(e.message);
  } finally {
    loadingFile = false;
    let useSearch = false;
    $("#file").value = "";
    enable();
  }
}
$("#file").onchange = (e) => readFile(e.target.files[0]);
$("#upload").onclick = () => $("#file").click();
$("#document-card").onclick = () => $("#file").click();
$("#send").onclick = () => (busy ? controller.abort() : generate());
input.oninput = () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
  enable();
};
input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) generate();
  }
};
document.querySelectorAll("[data-prompt]").forEach(
  (e) =>
    (e.onclick = () => {
      input.value = e.dataset.prompt;
      input.focus();
      enable();
    }),
);
document
  .querySelectorAll("[data-mode]")
  .forEach((e) => (e.onclick = () => reset(e.dataset.mode)));
$("#new-chat").onclick = () => reset();
$("#menu").onclick = () => sidebar(true);
$("#shade").onclick = () => sidebar(false);
$("#refresh-history").onclick = refreshHistory;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    reset();
  }
  if (e.key === "Escape") sidebar(false);
});
document
  .querySelectorAll(".dialog-close")
  .forEach((e) => (e.onclick = () => e.closest("dialog").close()));
$("#account").onclick = () => {
  if (busy) return;
  if (user) {
    $("#user-email").textContent = user;
    $("#account-dialog").showModal();
  } else $("#login-dialog").showModal();
};
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector("[type=submit]");
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    const data = Object.fromEntries(new FormData(form));
    const b = await (
      await api("/api/login", { method: "POST", body: JSON.stringify(data) })
    ).json();
    user = b.email;
    form.reset();
    $("#login-dialog").close();
    reset();
    account();
    paintModel();
    await refreshHistory();
    toast("登录成功");
  } catch (err) {
    $("#login-error").textContent = err.message;
  } finally {
    button.disabled = false;
  }
};
$("#logout").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    user = null;
    useSearch = false;
    $("#web-search").setAttribute("aria-pressed", "false");
    modelSelect.value = MODELS[0].id;
    history = [];
    $("#account-dialog").close();
    reset();
    account();
    paintModel();
    paintHistory();
  } catch (e) {
    toast(e.message);
  }
};
$("#export").onclick = () => {
  if (!messages.length) {
    toast("当前还没有对话");
    return;
  }
  const text = messages
    .map(
      (m) =>
        "## " +
        (m.role === "user" ? "你" : "VEAIX · " + m.model) +
        "\n\n" +
        (m.display || cleanAnswer(m.content)) +
        (m.file ? "\n\n附件：" + m.file : "") +
        (m.picture ? "\n\n[生成的图片请在网页中单独下载]" : ""),
    )
    .join("\n\n---\n\n");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "veaix-conversation.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
try {
  document.body.classList.toggle(
    "dark",
    localStorage.getItem("veaix-theme") === "dark",
  );
} catch {}
$("#theme").onclick = () => {
  document.body.classList.toggle("dark");
  try {
    localStorage.setItem(
      "veaix-theme",
      document.body.classList.contains("dark") ? "dark" : "light",
    );
  } catch {}
};
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (mode === "chat") readFile(e.dataTransfer.files[0]);
});
async function init() {
  try {
    const b = await (await api("/api/me")).json();
    user = b.email;
    models = b.models;
    $("#region-note").hidden = !b.restricted;
  } catch {
    showNotice("暂时无法连接服务，请刷新重试。");
  }
  modelSelect.replaceChildren(
    ...models.map((m) => {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.name + " · " + m.note.split(" · ")[0];
      return o;
    }),
  );
  account();
  await refreshHistory();
  setMode("chat");
  enable();
}
for (const [selector, name] of [
  ["#new-chat>span", "plus"],
  ["[data-mode=chat]>span", "chat"],
  ["[data-mode=image]>span", "image"],
  ["#menu", "menu"],
  ["#theme", "theme"],
  ["#upload", "plus"],
  ["#refresh-history", "refresh"],
  ["#account .avatar", "user"],
  ["#document-card>span", "file"],
]) {
  document.querySelector(selector).innerHTML = icon(name);
}
document
  .querySelectorAll("[data-prompt]>span")
  .forEach((el, i) => (el.innerHTML = icon(["idea", "book", "code"][i])));

document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
$("#export").innerHTML = icon("download") + "<span>导出</span>";
$("#model-trigger").onclick = () => {
  if (!$("#model-picker").hidden) return closePicker();
  paintModel();
  $("#model-picker").hidden = false;
  $("#model-trigger").setAttribute("aria-expanded", "true");
  (
    $("#model-options [aria-selected=true]") ||
    $("#model-options button:not(:disabled)")
  )?.focus();
};
function closePicker(focus = false) {
  $("#model-picker").hidden = true;
  $("#model-trigger").setAttribute("aria-expanded", "false");
  if (focus) $("#model-trigger").focus();
}
function paintModel() {
  let selected = models.find((m) => m.id === modelSelect.value) || models[0];
  if (selected.paid && !user) {
    selected = models[0];
    modelSelect.value = selected.id;
  }
  $("#model-label").textContent = selected.name;
  $("#model-trigger").title = selected.name + " · " + selected.note;
  const root = $("#model-options");
  root.replaceChildren();
  for (const paid of [false, true]) {
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    group.setAttribute(
      "aria-label",
      paid ? "登录专属 · 付费" : "普通模型 · 免费额度",
    );
    const heading = document.createElement("div");
    heading.className = "model-group-label";
    heading.textContent = group.getAttribute("aria-label");
    group.append(heading);
    for (const m of models.filter((m) => !!m.paid === paid)) {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(m.id === selected.id));
      option.disabled = paid && !user;
      option.innerHTML = `<span class="model-option-copy"><strong>${escape(m.name)}</strong><small>${escape(m.note.split(" · ")[0])}${m.vision ? " · 可看图" : ""}</small></span><span class="model-option-status">${paid && !user ? icon("lock") : m.id === selected.id ? icon("check") : paid ? "付费" : ""}</span>`;
      option.onclick = () => {
        modelSelect.value = m.id;
        paintModel();
        closePicker(true);
      };
      group.append(option);
    }
    root.append(group);
  }
  $("#model-login").hidden = !!user;
  $("#web-search").title = user
    ? "联网搜索 · 消耗站点付费余额"
    : "登录后使用联网搜索";
}
$("#model-login").onclick = () => {
  closePicker();
  $("#login-dialog").showModal();
};
$("#web-search").onclick = () => {
  if (!user) {
    $("#login-dialog").showModal();
    return;
  }
  useSearch = !useSearch;
  $("#web-search").setAttribute("aria-pressed", String(useSearch));
  toast(useSearch ? "已开启联网搜索 · 使用站点付费余额" : "已关闭联网搜索");
};
$("#model-picker").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closePicker(true);
    return;
  }
  const options = [
    ...document.querySelectorAll("#model-options button:not(:disabled)"),
  ];
  const i = options.indexOf(document.activeElement);
  const next =
    e.key === "ArrowDown"
      ? (i + 1) % options.length
      : e.key === "ArrowUp"
        ? (i - 1 + options.length) % options.length
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? options.length - 1
            : -1;
  if (next >= 0) {
    e.preventDefault();
    options[next].focus();
  }
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".model-control")) closePicker();
});
document.addEventListener("focusin", (e) => {
  if (!e.target.closest(".model-control")) closePicker();
});
matchMedia("(max-width:760px)").addEventListener("change", () =>
  sidebar(false),
);
sidebar(false);
init();
