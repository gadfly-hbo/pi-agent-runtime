/* Disposable UI prototype. No persistence, credentials, provider calls or Runtime imports. */
"use strict";
const $ = (id) => document.getElementById(id);
const blank = () => ({ providers: [], primary: "", fallbacks: [], mode: "worker" });
let draft = blank(), active = null, activeVersion = 0, saved = JSON.stringify(draft);
let nextId = 1, editingProvider = null, editingModel = null, modelProvider = null;
const observations = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const id = () => "prototype-" + nextId++;
const provider = (key) => draft.providers.find((p) => p.id === key);
const allModels = () => draft.providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p })));
const model = (key) => allModels().find((m) => m.id === key);
const label = (m) => m ? (m.name || m.modelId) + " · " + m.provider.name : "模型不可用";
const activeModels = () => active ? [active.primary, ...active.fallbacks] : [];
const referenced = (p, m) => m ? activeModels().includes(m.id) : p.models.some((x) => activeModels().includes(x.id));
const announce = (message) => { $("notice").textContent = message; };
const eligible = (m) => m.enabled && m.provider.enabled;
const options = (items, placeholder, selected, disabled = []) => '<option value="">'+placeholder+'</option>' + items.map((m) => '<option value="'+m.id+'"'+(m.id===selected?' selected':'')+(!eligible(m)||disabled.includes(m.id)?' disabled':'')+'>'+escapeHtml(label(m))+(!eligible(m)?'（已禁用）':'')+'</option>').join("");
const switchButton = (kind, key, enabled, text) => '<button class="quiet small switch" role="switch" aria-checked="'+enabled+'" aria-label="'+escapeHtml(text)+'" data-action="'+kind+'" data-id="'+key+'"><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span><span>'+(enabled?'启用':'停用')+'</span></button>';
function problems() {
  const result = [];
  if (!draft.primary) result.push("选择一个主模型。");
  if (!draft.fallbacks.length) result.push("添加至少一个备用模型。");
  const chosen = [draft.primary, ...draft.fallbacks].filter(Boolean);
  if (new Set(chosen).size !== chosen.length) result.push("主备模型不可重复。");
  chosen.forEach((key) => {
    const m = model(key);
    if (!m || !eligible(m)) result.push(label(m)+"不可用，请重新配置。");
    else {
      if (!m.provider.credential) result.push(m.provider.name+"未设置模拟凭据。");
      if (draft.mode === "agent" && !m.tools) result.push(label(m)+"未声明工具调用能力。");
    }
  });
  return [...new Set(result)];
}
function invalidate(p) { p.models.forEach((m) => observations.delete(m.id)); }
function render() {
  const models = allModels();
  $("mode").value = draft.mode;
  $("primary").innerHTML = options(models, "选择主模型", draft.primary, draft.fallbacks);
  $("backup-select").innerHTML = options(models.filter((m) => eligible(m) && m.id!==draft.primary && !draft.fallbacks.includes(m.id)), "选择备用模型", "");
  $("add-backup").disabled = !$("backup-select").options[1];
  $("fallbacks").innerHTML = draft.fallbacks.length ? draft.fallbacks.map((key, i) => '<div class="fallback"><span class="order">'+(i+1)+'</span><span class="fallback-name">'+escapeHtml(label(model(key)))+'</span><div class="fallback-actions"><button class="quiet small" data-action="up" data-id="'+key+'" aria-label="上移备用 '+(i+1)+'"'+(i===0?' disabled':'')+'>↑</button><button class="quiet small" data-action="down" data-id="'+key+'" aria-label="下移备用 '+(i+1)+'"'+(i===draft.fallbacks.length-1?' disabled':'')+'>↓</button><button class="quiet small" data-action="remove-backup" data-id="'+key+'" aria-label="移除备用 '+(i+1)+'">✕</button></div></div>').join("") : '<div class="empty-backup">还没有备用模型</div>';
  const issues = problems();
  $("route-errors").innerHTML = issues.length ? '<ul>'+issues.map((x)=>'<li>'+escapeHtml(x)+'</li>').join("")+'</ul>' : "";
  const changed = !active || JSON.stringify(active)!==JSON.stringify(draft);
  $("draft-status").textContent = !draft.providers.length ? "未配置" : changed ? "待生效" : "已生效（模拟）";
  $("active").textContent = active ? "生效 v"+activeVersion+"（模拟） · "+labelFromSnapshot(active,active.primary)+" → "+active.fallbacks.map((key)=>labelFromSnapshot(active,key)).join(" → ") : "尚无生效配置。保存草稿不会启动 Agent。";
  $("save-status").textContent = JSON.stringify(draft)!==saved ? "有未保存更改 · 草稿仅存在本页内存中" : "草稿仅存在本页内存中。";
  $("providers").innerHTML = draft.providers.length ? draft.providers.map(providerCard).join("") : '<div class="empty"><h3>添加你的第一个模型来源</h3><p class="muted">填写服务地址和协议，再添加模型。没有预设供应商。</p><button class="secondary" data-action="add-provider">＋ 添加 Provider</button></div>';
}
function labelFromSnapshot(snapshot, key) {
  for (const p of snapshot.providers) {
    const m = p.models.find((x) => x.id === key);
    if (m) return (m.name || m.modelId)+" · "+p.name;
  }
  return "模型不可用";
}
function providerCard(p) {
  return '<article class="card provider-card"><div class="provider-header"><div class="provider-title"><span class="provider-icon" aria-hidden="true">⬡</span><h3>'+escapeHtml(p.name)+'</h3></div><div class="provider-actions"><button class="quiet small" data-action="edit-provider" data-id="'+p.id+'">编辑连接</button><button class="quiet small danger" data-action="delete-provider" data-id="'+p.id+'">删除</button>'+switchButton("toggle-provider",p.id,p.enabled,p.name+" 启用状态")+'</div></div><div class="connection-grid"><div><p class="field-title">Base URL</p><div class="field-value">'+escapeHtml(p.url)+'</div></div><div><p class="field-title">API 格式</p><div class="field-value">'+(p.protocol==="anthropic-messages"?"Anthropic Messages":"Chat Completions")+'</div></div></div><div class="credential"><p class="helper">API Key · '+(p.credential?"模拟已设置（没有真实密钥）":"未设置")+'</p><button class="secondary small" data-action="credential" data-id="'+p.id+'">'+(p.credential?"清除模拟凭据":"模拟设置凭据")+'</button></div><div class="model-heading"><p class="field-title">模型列表</p><button class="quiet small" data-action="add-model" data-id="'+p.id+'">＋ 添加模型</button></div><div class="model-list">'+(p.models.length?p.models.map((m)=>'<div class="model-row"><div class="model-info"><p class="model-name">'+escapeHtml(m.name||m.modelId)+'</p><p class="model-meta">'+escapeHtml(m.modelId)+' · '+m.context.toLocaleString()+' tokens · '+(m.tools?"工具能力：声明支持":"工具能力：未声明")+'</p></div><div class="model-actions"><span class="check-label">'+(observations.has(m.id)?"模拟通过 · 非真实检查":"未检查")+'</span><button class="quiet small" data-action="check" data-id="'+m.id+'" aria-label="模拟检查 '+escapeHtml(m.name||m.modelId)+'">模拟检查</button><button class="quiet small" data-action="edit-model" data-id="'+m.id+'" aria-label="编辑模型 '+escapeHtml(m.name||m.modelId)+'">编辑</button><button class="quiet small danger" data-action="delete-model" data-id="'+m.id+'" aria-label="删除模型 '+escapeHtml(m.name||m.modelId)+'">删除</button>'+switchButton("toggle-model",m.id,m.enabled,(m.name||m.modelId)+" 启用状态")+'</div></div>').join(""):'<div class="model-row"><p class="helper">尚无模型。按 Provider 说明手动添加。</p></div>')+'</div></article>';
}
function openProvider(key = null) {
  editingProvider = key;
  const p = provider(key);
  $("provider-form").reset();
  $("provider-dialog-title").textContent = p ? "编辑 Provider" : "添加 Provider";
  $("provider-name").value = p?.name || "";
  $("provider-url").value = p?.url || "";
  $("provider-protocol").value = p?.protocol || "openai-completions";
  $("provider-error").textContent = "";
  $("provider-dialog").showModal();
}
function openModel(providerKey, key = null) {
  editingModel = key; modelProvider = providerKey;
  const m = model(key);
  $("model-form").reset();
  $("model-dialog-title").textContent = m ? "编辑模型" : "添加模型";
  $("model-id").value = m?.modelId || "";
  $("model-name").value = m?.name || "";
  $("model-context").value = m?.context || "";
  $("model-tools").checked = m?.tools || false;
  $("model-error").textContent = "";
  $("model-dialog").showModal();
}
function protectReferenced(p,m) {
  if (!referenced(p,m)) return false;
  announce("此对象被生效配置引用。请先重新选择主备模型并生效，再删除、禁用或清除凭据。");
  return true;
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id:key } = button.dataset;
  const p = provider(key), m = model(key);
  switch (action) {
    case "add-provider": openProvider(); return;
    case "edit-provider": openProvider(key); return;
    case "add-model": openModel(key); return;
    case "edit-model": openModel(m.provider.id,key); return;
    case "delete-provider":
      if (protectReferenced(p)) return;
      draft.providers = draft.providers.filter((x)=>x.id!==key); invalidate(p); break;
    case "toggle-provider":
      if (p.enabled && protectReferenced(p)) return;
      p.enabled = !p.enabled; invalidate(p); break;
    case "credential":
      if (p.credential && protectReferenced(p)) return;
      p.credential = !p.credential; invalidate(p); break;
    case "delete-model":
      if (protectReferenced(m.provider,m)) return;
      provider(m.provider.id).models = provider(m.provider.id).models.filter((x)=>x.id!==key);
      observations.delete(key); break;
    case "toggle-model":
      if (m.enabled && protectReferenced(m.provider,m)) return;
      provider(m.provider.id).models.find((x)=>x.id===key).enabled = !m.enabled;
      observations.delete(key); break;
    case "check":
      if (!eligible(m) || !m.provider.credential) { announce("先启用来源/模型并设置模拟凭据；没有执行真实请求。"); return; }
      observations.set(key,true); announce("仅模拟检查通过。没有连接 Provider，也没有验证工具能力。"); render(); return;
    case "remove-backup": draft.fallbacks = draft.fallbacks.filter((x)=>x!==key); break;
    case "up":
    case "down": {
      const i = draft.fallbacks.indexOf(key), j = i + (action==="up"?-1:1);
      if (j>=0 && j<draft.fallbacks.length) [draft.fallbacks[i],draft.fallbacks[j]]=[draft.fallbacks[j],draft.fallbacks[i]];
      break;
    }
    default: return;
  }
  announce("已更新草稿，尚未生效。"); render();
});
$("provider-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("provider-name").value.trim(), url = $("provider-url").value.trim();
  let endpoint;
  try { endpoint = new URL(url); } catch { $("provider-error").textContent="请输入合法 Base URL。"; return; }
  const loopback = ["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname);
  if (!name || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol==="https:" || endpoint.protocol==="http:"&&loopback)) {
    $("provider-error").textContent="需要名称与 HTTPS 地址（本地回环可用 HTTP），地址不能包含凭据、查询参数或片段。"; return;
  }
  const previous = provider(editingProvider);
  if (previous) { Object.assign(previous,{name,url,protocol:$("provider-protocol").value}); invalidate(previous); }
  else draft.providers.push({id:id(),name,url,protocol:$("provider-protocol").value,enabled:true,credential:false,models:[]});
  $("provider-dialog").close(); announce("连接信息已写入本页草稿。"); render();
});
$("model-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const p = provider(modelProvider), modelId=$("model-id").value.trim(), name=$("model-name").value.trim(), context=Number($("model-context").value);
  if (!modelId || !Number.isSafeInteger(context) || context<1 || context>100000000) { $("model-error").textContent="请填写模型 ID 和正整数上下文上限。"; return; }
  if (p.models.some((m)=>m.modelId===modelId && m.id!==editingModel)) { $("model-error").textContent="此 Provider 已有相同模型 ID。"; return; }
  const values={modelId,name,context,tools:$("model-tools").checked};
  const previous=p.models.find((m)=>m.id===editingModel);
  if (previous) { Object.assign(previous,values); observations.delete(previous.id); }
  else p.models.push({id:id(),...values,enabled:true});
  $("model-dialog").close(); announce("模型已写入本页草稿。"); render();
});
document.querySelectorAll(".close-dialog").forEach((button)=>button.addEventListener("click",()=>button.closest("dialog").close()));
$("primary").addEventListener("change",()=>{draft.primary=$("primary").value;announce("主模型已更新，尚未生效。");render();});
$("mode").addEventListener("change",()=>{draft.mode=$("mode").value;render();});
$("add-backup").addEventListener("click",()=>{
  const key=$("backup-select").value;
  if (!key || key===draft.primary || draft.fallbacks.includes(key)) {announce("请选择一个未使用的备用模型。");return;}
  draft.fallbacks.push(key);render();announce("备用模型已加入草稿。");
});
$("save").addEventListener("click",()=>{saved=JSON.stringify(draft);render();announce("草稿保存在本页内存中，未生效；刷新后消失。");});
$("apply").addEventListener("click",()=>{
  if (problems().length) {announce("未生效：请修正上方配置问题。原生效配置保持不变。");$("route-errors").scrollIntoView({block:"nearest"});return;}
  active=clone(draft);activeVersion++;saved=JSON.stringify(draft);render();announce("已模拟生效 v"+activeVersion+"。没有启动 Agent，也没有调用模型。");
});
$("discard").addEventListener("click",()=>{draft=active?clone(active):blank();saved=JSON.stringify(draft);observations.clear();render();announce("已放弃草稿更改，恢复生效快照（没有生效配置时恢复空态）。");});
$("theme").addEventListener("click",()=>{const dark=document.documentElement.classList.toggle("dark");$("theme").setAttribute("aria-label",dark?"切换浅色模式":"切换深色模式");});
$("add-provider").addEventListener("click",()=>openProvider());
$("demo").addEventListener("click",()=>{
  if (draft.providers.length || active) {announce("演示仅从空态载入；为保护当前编辑，请刷新重置后再载入。");return;}
  const a=id(),b=id(),one=id(),two=id(),three=id();
  draft={providers:[
    {id:a,name:"示例供应商 A",url:"https://provider-a.example.com/v1",protocol:"openai-completions",enabled:true,credential:true,models:[{id:one,modelId:"demo-reasoner",name:"推理模型（合成）",context:128000,tools:true,enabled:true},{id:three,modelId:"demo-text",name:"文本模型（合成）",context:64000,tools:false,enabled:true}]},
    {id:b,name:"示例供应商 B",url:"https://provider-b.example.com",protocol:"anthropic-messages",enabled:true,credential:true,models:[{id:two,modelId:"demo-assistant",name:"通用模型（合成）",context:200000,tools:true,enabled:true}]}
  ],primary:one,fallbacks:[two],mode:"worker"};
  render();announce("已载入虚构 Provider 和模型。它们不是产品默认值，也不可用于真实调用。");
});
render();
