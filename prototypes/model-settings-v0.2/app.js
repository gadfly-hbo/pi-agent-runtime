// Disposable presentation prototype: no Runtime imports, credentials, persistence or network.
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const blank = () => ({providers:[],primary:"",fallbacks:[]});
let draft=blank(), saved=null, nextId=1, editingModel=null, modelProvider=null;
const visibleKeys=new Set();
const id = () => "demo-"+nextId++;
const provider = (key) => draft.providers.find((p)=>p.id===key);
const models = () => draft.providers.flatMap((p)=>p.models.map((m)=>({...m,provider:p})));
const model = (key) => models().find((m)=>m.id===key);
const label = (m) => m ? m.modelId+" · "+m.provider.name : "请选择模型";
const eligible = (m) => m.enabled && m.provider.enabled;
const announce = (text) => {$("notice").textContent=text;};
const toggle = (action,key,enabled,name) => '<button class="toggle" role="switch" aria-label="'+esc(name)+'" aria-checked="'+enabled+'" data-action="'+action+'" data-id="'+key+'"><span></span></button>';
const paths={
  edit:'<path d="m13 4 7 7M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16z"/>',
  delete:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  check:'<path d="m5 12 4 4 10-10M6 4H3v17h17v-7"/>',
  eye:'<path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'
};
const icon=(kind,text,action,key)=>'<button class="icon-button" title="'+esc(text)+'" aria-label="'+esc(text)+'" data-action="'+action+'" data-id="'+key+'"><svg viewBox="0 0 24 24" aria-hidden="true">'+paths[kind]+'</svg></button>';
const cube='<svg class="cube" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10M7 4.8l9 5"/></svg>';
const options=(items,title,selected,disabled=[])=>'<option value="">'+title+'</option>'+items.map((m)=>'<option value="'+m.id+'"'+(selected===m.id?' selected':'')+(!eligible(m)||disabled.includes(m.id)?' disabled':'')+'>'+esc(label(m))+'</option>').join("");
function referenced(p,m) {
  if (!saved) return false;
  const used=[saved.primary,...saved.fallbacks];
  return m ? used.includes(m.id) : p.models.some((x)=>used.includes(x.id));
}
function protect(p,m) {
  if (!referenced(p,m)) return false;
  announce("请先更换主备模型并保存，再禁用或删除此项。"); return true;
}
function validateUrl(value) {
  try {
    const u=new URL(value);
    return !u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==="https:"||u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname));
  } catch { return false; }
}
function errors() {
  const messages=[];
  if (!draft.primary) messages.push("请选择主模型");
  if (!draft.fallbacks.length) messages.push("请添加至少一个备用模型");
  const used=[draft.primary,...draft.fallbacks].filter(Boolean);
  if (new Set(used).size!==used.length) messages.push("主备模型不能重复");
  used.forEach((key)=>{
    const m=model(key);
    if (!m||!eligible(m)) messages.push("主备模型包含已删除或禁用项");
    else if (!validateUrl(m.provider.url)) messages.push(m.provider.name+" 的 Base URL 不合法");
  });
  return [...new Set(messages)];
}
function providerCard(p) {
  return '<section class="provider" aria-label="'+esc(p.name)+'"><div class="provider-head"><div class="provider-name">'+cube+'<h3>'+esc(p.name)+'</h3></div><div class="head-actions">'+toggle("toggle-provider",p.id,p.enabled,p.name+" 启用状态")+'<details class="menu"><summary aria-label="'+esc(p.name)+' 更多操作">···</summary><div class="menu-panel"><button data-action="rename" data-id="'+p.id+'">修改名称</button><button class="danger" data-action="delete-provider" data-id="'+p.id+'">删除来源</button></div></details></div></div>'+
    '<div class="field"><label for="url-'+p.id+'">Base URL</label><input id="url-'+p.id+'" data-field="url" data-provider="'+p.id+'" value="'+esc(p.url)+'" type="url" required></div>'+
    '<div class="field"><label for="protocol-'+p.id+'">API 格式</label><select id="protocol-'+p.id+'" data-field="protocol" data-provider="'+p.id+'"><option value="anthropic-messages"'+(p.protocol==="anthropic-messages"?' selected':'')+'>Anthropic Messages (/v1/messages)</option><option value="openai-completions"'+(p.protocol==="openai-completions"?' selected':'')+'>Chat Completions (/chat/completions)</option><option disabled>Responses · 暂未接入</option></select></div>'+
    '<div class="field"><label for="key-'+p.id+'">API Key</label><div class="secret-wrap"><input id="key-'+p.id+'" type="'+(visibleKeys.has(p.id)?'text':'password')+'" value="example-key-not-real" readonly aria-describedby="key-note-'+p.id+'">'+icon("eye","切换示例密钥显示","key-visibility",p.id)+'</div><span id="key-note-'+p.id+'" hidden>固定虚构值，原型不接受真实密钥。</span></div>'+
    '<div class="model-head"><p>模型列表</p><button class="secondary" data-action="add-model" data-id="'+p.id+'">＋ 添加模型</button></div><div class="model-list">'+(p.models.length?p.models.map((m)=>'<div class="model-row"><div class="model-description"><span class="model-id">'+esc(m.modelId)+'</span><span class="model-badge">'+(m.context>=1000000?(m.context/1000000)+'M':Math.round(m.context/1000)+'K')+'</span></div><div class="model-actions">'+icon("check","模拟检查 "+m.modelId,"check",m.id)+icon("edit","编辑 "+m.modelId,"edit-model",m.id)+icon("delete","删除 "+m.modelId,"delete-model",m.id)+toggle("toggle-model",m.id,m.enabled,m.modelId+" 启用状态")+'</div></div>').join(""):'<p class="empty model-row">还没有模型</p>')+'</div></section>';
}
function render() {
  $("providers").innerHTML=draft.providers.length?draft.providers.map(providerCard).join(""):'<p class="empty">添加 Provider 后，填写连接信息并添加模型。</p>';
  const all=models();
  $("primary").innerHTML=options(all,"选择主模型",draft.primary,draft.fallbacks);
  $("backup-select").innerHTML=options(all.filter((m)=>eligible(m)&&m.id!==draft.primary&&!draft.fallbacks.includes(m.id)),"添加备用模型","");
  $("add-backup").disabled=!$("backup-select").options[1];
  $("fallbacks").innerHTML=draft.fallbacks.map((key,i)=>'<div class="fallback"><span class="fallback-index">'+(i+1)+'.</span><span class="fallback-name">'+esc(label(model(key)))+'</span><button class="icon-button" data-action="up" data-id="'+key+'" aria-label="上移备用 '+(i+1)+'"'+(i===0?' disabled':'')+'>↑</button><button class="icon-button" data-action="down" data-id="'+key+'" aria-label="下移备用 '+(i+1)+'"'+(i===draft.fallbacks.length-1?' disabled':'')+'>↓</button><button class="icon-button" data-action="remove-backup" data-id="'+key+'" aria-label="移除备用 '+(i+1)+'">✕</button></div>').join("");
}
function openModel(providerId,key=null) {
  modelProvider=providerId;editingModel=key;
  const m=model(key);
  $("model-form").reset();$("model-title").textContent=m?"编辑模型":"添加模型";
  $("model-id").value=m?.modelId||"";$("model-context").value=m?.context||"";$("model-output").value=m?.maxOutput||"";
  $("model-submit").textContent=m?"保存":"添加";$("model-error").textContent="";$("model-dialog").showModal();
}
document.addEventListener("change",(event)=>{
  const control=event.target;
  if (!control.dataset.provider) return;
  const p=provider(control.dataset.provider);
  p[control.dataset.field]=control.value;
  announce("");
});
document.addEventListener("click",(event)=>{
  const button=event.target.closest("button[data-action]");
  if (!button) return;
  const {action,id:key}=button.dataset,p=provider(key),m=model(key);
  switch(action) {
    case "add-model":openModel(key);return;
    case "edit-model":openModel(m.provider.id,key);return;
    case "key-visibility":visibleKeys.has(key)?visibleKeys.delete(key):visibleKeys.add(key);render();return;
    case "check":announce("模拟检查完成；未连接真实模型。");return;
    case "delete-provider":if(protect(p))return;draft.providers=draft.providers.filter((x)=>x.id!==key);break;
    case "toggle-provider":if(p.enabled&&protect(p))return;p.enabled=!p.enabled;break;
    case "delete-model":if(protect(m.provider,m))return;provider(m.provider.id).models=provider(m.provider.id).models.filter((x)=>x.id!==key);break;
    case "toggle-model":if(m.enabled&&protect(m.provider,m))return;provider(m.provider.id).models.find((x)=>x.id===key).enabled=!m.enabled;break;
    case "rename": {
      // Reuse the connection form; no additional settings surface.
      $("provider-form").reset();$("provider-title").textContent="编辑 Provider";$("provider-submit").textContent="保存";
      $("provider-form").dataset.edit=key;$("provider-name").value=p.name;$("provider-url").value=p.url;$("provider-protocol").value=p.protocol;
      $("provider-error").textContent="";$("provider-dialog").showModal();return;
    }
    case "remove-backup":draft.fallbacks=draft.fallbacks.filter((x)=>x!==key);break;
    case "up":
    case "down":{
      const i=draft.fallbacks.indexOf(key),j=i+(action==="up"?-1:1);
      if(j>=0&&j<draft.fallbacks.length)[draft.fallbacks[i],draft.fallbacks[j]]=[draft.fallbacks[j],draft.fallbacks[i]];
      break;
    }
    default:return;
  }
  render();announce("");
});
$("add-provider").addEventListener("click",()=>{
  $("provider-form").reset();delete $("provider-form").dataset.edit;
  $("provider-title").textContent="添加 Provider";$("provider-submit").textContent="添加";$("provider-error").textContent="";$("provider-dialog").showModal();
});
$("provider-form").addEventListener("submit",(event)=>{
  event.preventDefault();
  const name=$("provider-name").value.trim(),url=$("provider-url").value.trim(),protocol=$("provider-protocol").value;
  if(!name||!validateUrl(url)||!["anthropic-messages","openai-completions"].includes(protocol)){$("provider-error").textContent="填写名称、合法 HTTPS 地址及支持的 API 格式。";return;}
  const p=provider($("provider-form").dataset.edit);
  if(p)Object.assign(p,{name,url,protocol});else draft.providers.push({id:id(),name,url,protocol,enabled:true,models:[]});
  $("provider-dialog").close();render();announce("");
});
$("model-form").addEventListener("submit",(event)=>{
  event.preventDefault();
  const p=provider(modelProvider),modelId=$("model-id").value.trim(),context=Number($("model-context").value),maxOutput=Number($("model-output").value);
  if(!modelId||!Number.isSafeInteger(context)||context<=0||!Number.isSafeInteger(maxOutput)||maxOutput<=0||maxOutput>context){$("model-error").textContent="填写模型 ID 和正整数参数；最大输出不能超过上下文窗口。";return;}
  if(p.models.some((m)=>m.modelId===modelId&&m.id!==editingModel)){$("model-error").textContent="此模型 ID 已存在。";return;}
  const old=p.models.find((m)=>m.id===editingModel);
  if(old)Object.assign(old,{modelId,context,maxOutput});else p.models.push({id:id(),modelId,context,maxOutput,enabled:true});
  $("model-dialog").close();render();announce("");
});
document.querySelectorAll(".close").forEach((button)=>button.addEventListener("click",()=>button.closest("dialog").close()));
$("primary").addEventListener("change",()=>{draft.primary=$("primary").value;render();announce("");});
$("add-backup").addEventListener("click",()=>{
  const key=$("backup-select").value;if(!key)return;
  if(key===draft.primary||draft.fallbacks.includes(key)){announce("主备模型不能重复。");return;}
  draft.fallbacks.push(key);render();announce("");
});
$("save").addEventListener("click",()=>{
  const issues=errors();
  if(issues.length){announce(issues.join("；")+"。");return;}
  saved=JSON.parse(JSON.stringify(draft));announce("已在本页保存（模拟）。");
});
$("demo").addEventListener("click",()=>{
  if(draft.providers.length){announce("已有编辑内容，刷新后可重新查看示例。");return;}
  const p=id(),a=id(),b=id();
  draft={providers:[{id:p,name:"MiniMax（示例）",url:"https://api.minimax.cn/anthropic",protocol:"anthropic-messages",enabled:true,models:[
    {id:a,modelId:"M3.1-Flash-Preview",context:1000000,maxOutput:8192,enabled:true},
    {id:b,modelId:"MiniMax-M3",context:1000000,maxOutput:8192,enabled:true}
  ]}],primary:a,fallbacks:[b]};
  // Names/layout come from user screenshots; numeric example values are not verified provider capabilities.
  render();announce("");
});
$("model-dialog").querySelector(".info").addEventListener("click",()=>{$("model-error").textContent="智能配置尚未接入，当前请手动填写。";});
render();
