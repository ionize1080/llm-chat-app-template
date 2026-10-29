import { icon } from "./icons.mjs";

const $ = (s) => document.querySelector(s);
const names = {cloudflare:"Cloudflare",openrouter:"OpenRouter",openai:"OpenAI",anthropic:"Anthropic",google:"Google AI",deepseek:"DeepSeek",xai:"xAI",mistral:"Mistral",groq:"Groq",qwen:"Qwen · 国际站"};
const docs = {openrouter:"https://openrouter.ai/settings/keys",openai:"https://platform.openai.com/api-keys",anthropic:"https://console.anthropic.com/settings/keys",google:"https://aistudio.google.com/apikey",deepseek:"https://platform.deepseek.com/api_keys",xai:"https://console.x.ai/",mistral:"https://console.mistral.ai/api-keys/",groq:"https://console.groq.com/keys",qwen:"https://modelstudio.console.alibabacloud.com/"};
const purposes = {openrouter:"一个连接，访问多个模型家族",openai:"连接你的 OpenAI API 账户",anthropic:"使用单工作区 API 密钥连接 Claude",google:"连接 Google AI Studio 的 Gemini 模型",deepseek:"连接 DeepSeek 官方 API",xai:"通过 xAI API 使用 Grok",mistral:"连接 Mistral 官方模型服务",groq:"通过 Groq 运行高速推理",qwen:"使用阿里云国际站（新加坡）的 API 密钥"};
const marks = {cloudflare:"CF",openrouter:"OR",openai:"O",anthropic:"A",google:"G",deepseek:"D",xai:"x",mistral:"M",groq:"g",qwen:"Q"};
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const formatTime = (value) => {
  if (value === null || value === undefined || value === "") return "";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("zh-CN", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "";
};
const modelProvider = (m) => m.provider || "cloudflare";
const vendor = (m) => {
  if (modelProvider(m) !== "openrouter") return modelProvider(m);
  const v = String(m.sourceModel || m.id.split(":").slice(1).join(":")).split("/")[0];
  return ({"qwen":"qwen","x-ai":"xai","mistralai":"mistral"})[v] || v;
};
const symbol = (p) => `<span class="provider-symbol" data-provider="${escape(p)}">${escape(marks[p] || p.slice(0,2).toUpperCase())}</span>`;
const cost = (v) => Number.isFinite(Number(v)) && v !== null && v !== undefined ? "$" + new Intl.NumberFormat("en-US",{maximumFractionDigits:4}).format(Number(v)) : "—";

export function initModelHub({api, getUser, getModels, setModels, getBusy, toast, openSidebar}) {
  const select = $("#model");
  let providers = [], keys = [], catalog = null, scope = "all", keyProvider = "openrouter", keyBusy = false;
  let loading = false, storageAvailable = false, pendingKeys = null, authVersion = 0;
  let catalogRequest = 0;
  // The catalog remains accessible from the sidebar in image mode, where the
  // composer model control is hidden. The overlay owns its viewport position.
  document.body.append($("#model-picker"));
  const needsLogin = m => !!(m.paid || m.requiresLogin);
  const available = m => (!needsLogin(m) || !!getUser()) && m.available !== false;
  const login = () => { close(); $("#login-dialog").showModal(); };
  const feedback = (message = "", state = "info") => {
    $("#key-feedback").textContent = message;
    $("#key-feedback").dataset.state = state;
    $("#key-feedback").hidden = !message;
  };
  const currentKey = () => keys.find(k => k.provider === keyProvider);

  function position() {
    if ($("#model-picker").hidden) return;
    const picker = $("#model-picker");
    const modelAnchor = $("#model-trigger").getBoundingClientRect();
    const trigger = modelAnchor.width ? modelAnchor : $("#input").getBoundingClientRect();
    const width = Math.min(480, innerWidth - 24), left = Math.max(12, Math.min(trigger.left, innerWidth - width - 12));
    picker.style.width = width + "px";
    picker.style.left = left + "px";
    picker.style.bottom = Math.max(12, innerHeight - trigger.top + 10) + "px";
    picker.style.maxHeight = Math.min(660, Math.max(220, trigger.top - 22)) + "px";
    if (trigger.top < 260) {
      picker.style.bottom = "12px";
      picker.style.maxHeight = (innerHeight - 24) + "px";
    }
  }
  function open() {
    if (getBusy()) return;
    openSidebar(false);
    render();
    $("#model-picker").hidden = false;
    $("#model-trigger").setAttribute("aria-expanded", "true");
    position();
    $("#model-search").focus();
  }
  function close(focus = false) {
    $("#model-picker").hidden = true;
    $("#model-trigger").setAttribute("aria-expanded", "false");
    if (focus) {
      const trigger = $("#model-trigger");
      (trigger.getBoundingClientRect().width ? trigger : $("#input")).focus();
    }
  }
  function render() {
    const models = getModels();
    let selected = models.find(m => m.id === select.value);
    if (!selected || !available(selected)) {
      selected = models.find(available) || models[0];
      if (selected) select.value = selected.id;
    }
    $("#model-label").textContent = selected?.name || "选择模型";
    $("#model-trigger").title = selected ? `${selected.name} · ${selected.note || names[modelProvider(selected)] || ""}` : "选择模型";
    $("#model-count").textContent = String(models.length);
    $("#model-login").hidden = !!getUser();
    $("#model-keys").hidden = !getUser();
    $("#web-search").title = getUser() ? "联网搜索 · 消耗站点付费余额" : "登录后使用联网搜索";
    const filter = $("#provider-filter"), previous = filter.value;
    const allProviders = [...new Set(models.map(modelProvider))];
    const authors = [...new Set(models.filter(m=>modelProvider(m)!=="cloudflare").map(vendor))];
    const channels = document.createElement("optgroup"); channels.label = "连接渠道";
    channels.append(...allProviders.map(p=>new Option(names[p] || p,"route:"+p)));
    const families = document.createElement("optgroup"); families.label = "模型厂商";
    const priority = ["openai","anthropic","google","deepseek","xai","qwen","mistral","meta-llama","moonshotai"];
    authors.sort((a,b)=>{const rank=x=>priority.includes(x)?priority.indexOf(x):99;return rank(a)-rank(b)||a.localeCompare(b);});
    families.append(...authors.map(p=>new Option(names[p] || p,"vendor:"+p)));
    filter.replaceChildren(new Option("所有服务商", "all"),families,channels);
    const values = [...allProviders.map(p=>"route:"+p),...authors.map(p=>"vendor:"+p)];
    filter.value = values.includes(previous) ? previous : "all";
    const query = $("#model-search").value.trim().toLowerCase();
    const filtered = models.filter(m =>
      (scope !== "ready" || available(m)) && (scope !== "vision" || m.vision) &&
      (filter.value === "all" || "route:"+modelProvider(m) === filter.value || "vendor:"+vendor(m) === filter.value) &&
      (!query || [m.name,m.id,m.note,names[modelProvider(m)],vendor(m)].join(" ").toLowerCase().includes(query)));
    $("#model-results").textContent = `${filtered.length} 个模型${query ? "符合搜索" : ""} · ${getUser() ? "选择后开始对话" : "付费模型与 BYOK 需登录"}`;
    const root = $("#model-options"); root.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("div"); empty.className = "model-empty";
      empty.textContent = "没有找到匹配的模型。试试其他名称或切换筛选。"; root.append(empty);
    }
    let lastGroup;
    for (const m of filtered) {
      const provider = modelProvider(m), group = provider === "cloudflare" ? "站点模型" : names[provider] || provider;
      if (group !== lastGroup) {
        const h = document.createElement("div"); h.className = "model-group-label";
        h.innerHTML = `<span>${escape(group)}</span><span>${provider === "cloudflare" ? "无需自备密钥" : "使用你的 API 账户"}</span>`; root.append(h); lastGroup = group;
      }
      const option = document.createElement("button"); option.type = "button"; option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(m.id === selected?.id));
      const locked = needsLogin(m) && !getUser();
      const status = locked ? "登录使用" : !available(m) ? "连接密钥" : m.id === selected?.id ? "已选择" : provider !== "cloudflare" ? "已连接" : m.paid ? "站点付费" : "免费额度";
      const details = [];
      if (m.contextLength) details.push(`${new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}).format(m.contextLength)} 上下文`);
      if (m.pricing && (m.pricing.input != null || m.pricing.output != null)) details.push(`输入 ${cost(m.pricing.input)} · 输出 ${cost(m.pricing.output)}`);
      else if (provider !== "cloudflare") details.push("价格以服务商账单为准");
      option.innerHTML = `${symbol(vendor(m))}<span class="model-option-copy"><span class="model-option-title"><strong>${escape(m.name)}</strong>${m.vision ? '<span class="model-tag">视觉</span>' : ""}</span><small>${escape(provider === "cloudflare" ? (m.note || "").split(" · ")[0] : m.sourceModel || m.id)}</small>${details.length ? `<span class="model-option-details">${details.map(d => `<span>${escape(d)}</span>`).join("")}</span>` : ""}</span><span class="model-option-status ${available(m) ? "ready" : ""}">${locked ? icon("lock") : m.id === selected?.id ? icon("check") : ""}${status}</span>`;
      option.onclick = () => {
        if (locked) return login();
        if (!available(m)) return openKeys(provider);
        select.value = m.id; render(); close(true);
      };
      root.append(option);
    }
    paintStatus();
  }
  function paintStatus() {
    const status = $("#catalog-status");
    if (loading) status.textContent = "正在同步上游模型目录…";
    else if (!catalog) status.textContent = "目录暂不可用 · 仍可使用站点模型";
    else {
      const labels = {live:"已同步上游目录",cached:"上游目录缓存",stale:"上游暂不可用 · 使用缓存",unavailable:"上游目录暂不可用"};
      status.textContent = [labels[catalog.status] || "模型目录",formatTime(catalog.updatedAt)].filter(Boolean).join(" · ");
      status.title = catalog.error || (catalog.source ? `来源：${catalog.source}` : "");
    }
    $("#models-refresh").disabled = loading;
  }
  async function refresh(force = false) {
    if (loading && !force) return;
    const request = ++catalogRequest;
    loading = true; paintStatus();
    const epoch = authVersion;
    try {
      const data = await (await api("/api/models" + (force ? "?refresh=1" : ""))).json();
      if (epoch !== authVersion || request !== catalogRequest) return;
      if (!Array.isArray(data.models) || !data.models.length) throw new Error("模型目录为空，请稍后刷新。");
      const old = select.value;
      setModels(data.models); providers = data.providers || []; catalog = data.catalog;
      select.replaceChildren(...data.models.map(m => new Option(m.name,m.id)));
      select.value = data.models.some(m => m.id === old) ? old : data.models[0].id;
      render();
    } catch(e) {
      if (epoch !== authVersion || request !== catalogRequest) return;
      catalog = catalog ? {...catalog,status:"stale",error:e.message} : null;
      if (force) toast("模型目录刷新失败：" + e.message);
    } finally {
      if (request === catalogRequest) { loading = false; paintStatus(); }
    }
  }
  function keyControls() {
    $("#key-save").disabled = keyBusy || !storageAvailable;
    $("#key-verify").disabled = keyBusy;
    $("#key-delete").disabled = keyBusy;
    $("#key-delete-yes").disabled = keyBusy;
    $("#api-key").disabled = keyBusy;
    $("#key-providers").querySelectorAll("button").forEach(b => b.disabled = keyBusy);
  }
  function paintKeys() {
    const root = $("#key-providers"); root.replaceChildren();
    const list = providers.length ? providers.filter(p => p.id !== "cloudflare" && docs[p.id]) : Object.keys(docs).map(id => ({id,name:names[id]}));
    for (const p of list) {
      const b = document.createElement("button"); b.type = "button";
      b.setAttribute("aria-pressed",String(keyProvider === p.id));
      b.innerHTML = `${symbol(p.id)}<span>${escape(names[p.id] || p.name)}</span>${keys.some(k=>k.provider===p.id) ? `<span class="provider-connected" aria-label="已连接">${icon("check")}</span>` : ""}`;
      b.onclick = () => { if(keyBusy)return; keyProvider = p.id; clearKeyInput(); feedback(); paintKeys(); }; root.append(b);
    }
    const saved = currentKey();
    $("#key-provider-name").textContent = names[keyProvider] || keyProvider;
    $("#key-provider-purpose").textContent = purposes[keyProvider] || "连接你的模型服务商";
    $("#key-provider-symbol").textContent = marks[keyProvider] || keyProvider.slice(0,2).toUpperCase();
    $("#key-provider-symbol").dataset.provider = keyProvider;
    $("#key-provider-link").href = docs[keyProvider] || docs.openrouter;
    $("#key-saved").hidden = !saved;
    $("#key-delete-row").hidden = !saved;
    $("#key-delete-confirm").hidden = true;
    $("#key-delete").hidden = false;
    $("#key-mask").textContent = saved?.mask || "";
    $("#key-saved-time").textContent = saved ? `保存于 ${formatTime(saved.updatedAt)} · 下次登录自动连接` : "";
    $("#api-key").placeholder = saved ? "粘贴新密钥以替换，留空保留原密钥" : "粘贴你的 API 密钥";
    $("#key-save").textContent = saved ? "替换并保存" : "保存并连接";
    keyControls();
  }
  function clearKeyInput() {
    $("#api-key").value = ""; $("#api-key").type = "password";
    $("#key-reveal").setAttribute("aria-pressed","false"); $("#key-reveal").setAttribute("aria-label","显示密钥");
  }
  async function openKeys(provider = "openrouter") {
    if (keyBusy) { toast("正在完成密钥操作，请稍候。"); return; }
    if (!getUser()) { pendingKeys = provider; login(); return; }
    close(); openSidebar(false); $("#account-dialog").close();
    keyProvider = docs[provider] ? provider : "openrouter";
    clearKeyInput(); feedback("正在读取已保存的连接…"); keyBusy = true; paintKeys();
    if(!$("#keys-dialog").open) $("#keys-dialog").showModal();
    const epoch = authVersion;
    try {
      const data = await (await api("/api/keys")).json();
      if (epoch !== authVersion) return;
      keys = data.keys || []; storageAvailable = !!data.storageAvailable;
      feedback(storageAvailable ? "" : "加密存储暂未就绪，请联系站点管理员后再保存密钥。", storageAvailable ? "info" : "error");
    } catch(e) { if (epoch === authVersion) feedback(e.message,"error"); }
    finally {keyBusy=false;if(epoch===authVersion)paintKeys();}
  }
  async function keyAction(save = false) {
    if(keyBusy || !getUser()) return;
    const key = $("#api-key").value.trim();
    if (!key && (save || !currentKey())) {feedback("请先输入 API 密钥。","error");$("#api-key").focus();return;}
    keyBusy = true; keyControls(); feedback(save ? "正在验证并加密保存…" : "正在验证服务商连接…");
    const epoch = authVersion;
    try {
      const data = await (await api(save ? "/api/keys" : "/api/keys/verify",{method:save?"PUT":"POST",body:JSON.stringify({provider:keyProvider,...(key?{key}:{})})})).json();
      if(epoch !== authVersion) return;
      if(save) {
        keys = keys.filter(k=>k.provider!==keyProvider); if(data.key)keys.push(data.key);
        clearKeyInput(); paintKeys();
        feedback(`已加密保存，下次登录可继续使用。${data.modelCount != null ? `发现 ${data.modelCount} 个模型。` : ""}`,"success");
        await refresh(true);
      } else feedback(`连接验证成功${data.modelCount != null ? `，发现 ${data.modelCount} 个模型` : ""}。${key ? "点击保存后，下次登录即可继续使用。" : ""}`,"success");
    } catch(e) {if(epoch===authVersion)feedback(e.message,"error");}
    finally {keyBusy=false;keyControls();}
  }
  async function removeKey() {
    if(keyBusy || !getUser())return;
    keyBusy=true;keyControls();const epoch=authVersion;
    try {
      await api("/api/keys/"+encodeURIComponent(keyProvider),{method:"DELETE"});
      if(epoch!==authVersion)return;
      keys=keys.filter(k=>k.provider!==keyProvider);clearKeyInput();paintKeys();feedback("已移除已保存的密钥。","success");
      setModels(getModels().map(m=>modelProvider(m)===keyProvider?{...m,available:false}:m));render();
      await refresh(true);
    }catch(e){if(epoch===authVersion)feedback(e.message,"error");}
    finally{keyBusy=false;keyControls();}
  }
  async function authChanged() {
    authVersion++; keys=[];storageAvailable=false;clearKeyInput();
    if(!getUser()) {pendingKeys=null;$("#keys-dialog").close();}
    // Do not retain a private native-provider catalog after logout.
    if(!getUser()) setModels(getModels().filter(m=>modelProvider(m)==="cloudflare" || modelProvider(m)==="openrouter").map(m=>modelProvider(m)==="cloudflare"?m:{...m,available:false}));
    loading=false;await refresh();
    if(getUser() && pendingKeys) {const next=pendingKeys;pendingKeys=null;await openKeys(next);}
  }
  $("#model-trigger").onclick=()=>$("#model-picker").hidden?open():close();
  $("#browse-models").onclick=open;
  $("#models-close").onclick=()=>close(true);
  $("#models-refresh").onclick=()=>refresh(true);
  $("#model-search").oninput=render;
  $("#provider-filter").onchange=render;
  document.querySelectorAll("[data-model-scope]").forEach(b=>b.onclick=()=>{scope=b.dataset.modelScope;document.querySelectorAll("[data-model-scope]").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));render();});
  $("#model-login").onclick=login;
  $("#model-keys").onclick=()=>openKeys();
  $("#keys-open").onclick=()=>openKeys();
  $("#account-keys").onclick=()=>openKeys();
  $("#key-form").onsubmit=e=>{e.preventDefault();keyAction(true);};
  $("#key-verify").onclick=()=>keyAction(false);
  $("#key-reveal").onclick=()=>{const shown=$("#api-key").type==="password";$("#api-key").type=shown?"text":"password";$("#key-reveal").setAttribute("aria-pressed",String(shown));$("#key-reveal").setAttribute("aria-label",shown?"隐藏密钥":"显示密钥");};
  $("#key-delete").onclick=()=>{$("#key-delete-confirm").hidden=false;$("#key-delete").hidden=true;$("#key-delete-cancel").focus();};
  $("#key-delete-cancel").onclick=()=>{$("#key-delete-confirm").hidden=true;$("#key-delete").hidden=false;};
  $("#key-delete-yes").onclick=removeKey;
  $("#keys-dialog").addEventListener("close",clearKeyInput);
  $("#model-picker").addEventListener("keydown",e=>{
    if(e.key==="Escape"){e.preventDefault();close(true);return;}
    if(e.target.tagName==="SELECT")return;
    const options=[...document.querySelectorAll("#model-options [role=option]")],i=options.indexOf(document.activeElement);
    if((e.key==="Home"||e.key==="End")&&i<0)return;
    const n=e.key==="ArrowDown"?(i+1)%options.length:e.key==="ArrowUp"?(i-1+options.length)%options.length:e.key==="Home"?0:e.key==="End"?options.length-1:-1;
    if(n>=0&&options[n]){e.preventDefault();options[n].focus();}
  });
  document.addEventListener("pointerdown",e=>{if(!e.target.closest(".model-control,#model-picker,#browse-models"))close();});
  document.addEventListener("focusin",e=>{if(!e.target.closest(".model-control,#model-picker,#browse-models"))close();});
  window.addEventListener("resize",position);
  return {render,close,refresh,authChanged,openKeys};
}
