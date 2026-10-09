import {useId,useRef,useState} from 'react';
import {validateSettings,type ModelSettings,type ConfiguredProvider,type ConfiguredModel} from './settings.ts';
export interface CredentialUpdate {providerId:string; value:string}
export interface ModelSettingsPanelProps {
  initialValue:ModelSettings;
  onSave:(settings:ModelSettings,credentials:readonly CredentialUpdate[])=>Promise<void>;
  onTestModel?:(provider:ConfiguredProvider,model:ConfiguredModel)=>Promise<void>;
  credentialEditing?:boolean;
}
/** Mount with a new key when replacing externally changed configuration. No storage or network here. */
export function ModelSettingsPanel({initialValue,onSave,onTestModel,credentialEditing=true}:ModelSettingsPanelProps) {
  const [draft,setDraft]=useState(()=>structuredClone(initialValue));
  const [credentials,setCredentials]=useState<Record<string,string>>({});
  const [visibleKeys,setVisibleKeys]=useState<Record<string,boolean>>({});
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null);
  const dialogTitle=useId();
  const [editor,setEditor]=useState<{kind:'provider';id?:string;name:string;baseUrl:string;protocol:ConfiguredProvider['protocol']}|
    {kind:'model';providerId:string;id?:string;modelId:string;contextWindow:string;maxOutputTokens:string}|
    {kind:'test';providerId:string;id:string}|null>(null);
  const [editorError,setEditorError]=useState('');
  const update=(fn:(value:ModelSettings)=>void)=>{setDraft(value=>{const copy=structuredClone(value);fn(copy);return copy;});setNotice('');setError('');};
  const open=(value:NonNullable<typeof editor>)=>{setEditor(value);setEditorError('');dialog.current?.showModal();};
  const close=()=>{dialog.current?.close();setEditor(null);setEditorError('');};
  const models=draft.providers.flatMap(p=>p.models.map(m=>({p,m}))).filter(({p,m})=>p.enabled&&m.enabled);
  const options=(selected:string)=><><option value="">选择模型</option>{models.map(({p,m})=><option key={m.id} value={m.id} disabled={m.id!==selected&&[draft.primary,...draft.fallbacks].includes(m.id)}>{p.name} · {m.modelId}</option>)}</>;
  const selected=(id:string)=>draft.primary===id||draft.fallbacks.includes(id);
  const removeModel=(p:ConfiguredProvider,m:ConfiguredModel)=>{
    if(selected(m.id)){setError('请先更换主备模型并保存，再删除或停用该模型');return;}
    if(window.confirm(`删除模型 ${m.modelId}？`))update(v=>{v.providers.find(x=>x.id===p.id)!.models=v.providers.find(x=>x.id===p.id)!.models.filter(x=>x.id!==m.id);});
  };
  const save=async()=>{
    const value=structuredClone(draft),changes=Object.entries(credentials).filter(([,key])=>key.length>0).map(([providerId,value])=>({providerId,value}));
    for(const change of changes){const provider=value.providers.find(p=>p.id===change.providerId);if(provider)provider.credentialSet=true;}
    const issues=validateSettings(value);if(issues.length){setError(issues.join('；'));return;}
    setBusy(true);setError('');setNotice('');
    try{await onSave(value,changes);setDraft(structuredClone(value));setCredentials({});setVisibleKeys({});setNotice('已保存');}
    catch{setError('保存失败，请重试。当前运行配置未由此界面确认变更');}
    finally{setBusy(false);}
  };
  const commitEditor=async()=>{
    if(!editor)return;
    if(editor.kind==='test'){
      const p=draft.providers.find(p=>p.id===editor.providerId),m=p?.models.find(m=>m.id===editor.id);
      if(!p||!m||!onTestModel)return;
      if(credentials[p.id]){setEditorError('请先保存 API Key，再测试模型');return;}
      setBusy(true);setEditorError('');
      try{await onTestModel(structuredClone(p),structuredClone(m));close();setNotice('模型测试成功');}
      catch{setEditorError('模型测试失败，请检查配置或稍后重试');}
      finally{setBusy(false);}return;
    }
    if(editor.kind==='provider'){
      try{const url=new URL(editor.baseUrl);if(!editor.name.trim()||url.username||url.password||url.search||url.hash||
        !(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error();}
      catch{setEditorError('请输入名称和有效的 HTTPS Base URL（本机可用 HTTP）');return;}
      update(v=>{const existing=v.providers.find(p=>p.id===editor.id);
        if(existing){existing.name=editor.name.trim();existing.baseUrl=editor.baseUrl.trim();existing.protocol=editor.protocol;}
        else v.providers.push({id:crypto.randomUUID(),name:editor.name.trim(),baseUrl:editor.baseUrl.trim(),protocol:editor.protocol,enabled:true,credentialSet:false,models:[]});});
    } else {
      const contextWindow=Number(editor.contextWindow),maxOutputTokens=Number(editor.maxOutputTokens),modelId=editor.modelId.trim();
      const provider=draft.providers.find(p=>p.id===editor.providerId)!;
      if(!modelId||modelId.length>200||provider.models.some(m=>m.id!==editor.id&&m.modelId===modelId)||
        !Number.isSafeInteger(contextWindow)||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<=0||contextWindow<maxOutputTokens){
        setEditorError('请填写唯一模型 ID 和正整数参数；最大输出不能超过上下文窗口');return;
      }
      update(v=>{const p=v.providers.find(p=>p.id===editor.providerId)!,existing=p.models.find(m=>m.id===editor.id);
        if(existing)Object.assign(existing,{modelId,contextWindow,maxOutputTokens});
        else p.models.push({id:crypto.randomUUID(),modelId,contextWindow,maxOutputTokens,enabled:true});});
    }
    close();
  };
  const protocols=(value:ConfiguredProvider['protocol'],change:(value:ConfiguredProvider['protocol'])=>void)=><select aria-label="API 格式" value={value} onChange={e=>change(e.target.value as ConfiguredProvider['protocol'])}>
    <option value="anthropic-messages">Anthropic Messages (/v1/messages)</option><option value="openai-completions">Chat Completions (/chat/completions)</option><option disabled>Responses（暂不支持）</option></select>;
  return <section className="pi-model-settings" aria-label="模型设置">
    <fieldset disabled={busy}><div className="pi-heading"><h2>模型设置</h2><button type="button" onClick={()=>open({kind:'provider',name:'',baseUrl:'',protocol:'anthropic-messages'})}>＋ 添加 Provider</button></div>
    {draft.providers.map(p=><article className="pi-provider" key={p.id}>
      <header><h3><span aria-hidden="true">⬡</span> {p.name}</h3><div className="pi-actions">
        <input className="pi-switch" type="checkbox" role="switch" aria-label={`${p.name} 启用`} checked={p.enabled} onChange={e=>{
          if(!e.target.checked&&p.models.some(m=>selected(m.id))){setError('请先更换主备模型并保存，再停用该 Provider');return;}
          update(v=>{v.providers.find(x=>x.id===p.id)!.enabled=e.target.checked;});}}/>
        <details><summary aria-label={`${p.name} 更多操作`}>⋯</summary><div className="pi-menu"><button type="button" onClick={()=>open({kind:'provider',id:p.id,name:p.name,baseUrl:p.baseUrl,protocol:p.protocol})}>编辑 Provider</button>
        <button type="button" onClick={()=>{if(p.models.some(m=>selected(m.id))){setError('请先更换主备模型并保存，再删除该 Provider');return;}if(window.confirm(`删除 Provider ${p.name}？`)){update(v=>{v.providers=v.providers.filter(x=>x.id!==p.id);});setCredentials(v=>{const copy={...v};delete copy[p.id];return copy;});}}}>删除 Provider</button></div></details>
      </div></header>
      <label>Base URL<input value={p.baseUrl} onChange={e=>update(v=>{v.providers.find(x=>x.id===p.id)!.baseUrl=e.target.value;})}/></label>
      <label>API 格式{protocols(p.protocol,protocol=>update(v=>{v.providers.find(x=>x.id===p.id)!.protocol=protocol;}))}</label>
      <label>API Key<div className="pi-key"><input aria-label={`${p.name} API Key`} autoComplete="off" spellCheck={false} disabled={!credentialEditing} type={visibleKeys[p.id]?'text':'password'}
        value={credentials[p.id]??''} placeholder={credentialEditing?(p.credentialSet?'已设置，输入可替换':'输入 API Key'):'由宿主管理'}
        onChange={e=>setCredentials(v=>({...v,[p.id]:e.target.value}))}/><button type="button" disabled={!credentialEditing||!credentials[p.id]} aria-label={`${p.name} 显示或隐藏新密钥`} onClick={()=>setVisibleKeys(v=>({...v,[p.id]:!v[p.id]}))}>◉</button></div></label>
      <div className="pi-list-heading"><span>模型列表</span><button type="button" onClick={()=>open({kind:'model',providerId:p.id,modelId:'',contextWindow:'',maxOutputTokens:''})}>＋ 添加模型</button></div>
      <div className="pi-model-list">{p.models.length===0?<p className="pi-empty">尚未添加模型</p>:p.models.map(m=><div className="pi-model-row" key={m.id}>
        <span className="pi-model-name">{m.modelId}</span><span className="pi-badge" title={`上下文窗口 ${m.contextWindow}；最大输出 Token ${m.maxOutputTokens}`}>{m.contextWindow>=1000000?`${m.contextWindow/1000000}M`:m.contextWindow>=1000?`${m.contextWindow/1000}K`:m.contextWindow}</span>
        <div className="pi-actions"><button className="pi-icon" type="button" aria-label={`测试 ${m.modelId}`} disabled={!onTestModel} onClick={()=>open({kind:'test',providerId:p.id,id:m.id})}>♧</button>
        <button className="pi-icon" type="button" aria-label={`编辑 ${m.modelId}`} onClick={()=>open({kind:'model',providerId:p.id,id:m.id,modelId:m.modelId,contextWindow:String(m.contextWindow),maxOutputTokens:String(m.maxOutputTokens)})}>✎</button>
        <button className="pi-icon" type="button" aria-label={`删除 ${m.modelId}`} onClick={()=>removeModel(p,m)}>⌫</button>
        <input className="pi-switch" type="checkbox" role="switch" aria-label={`${m.modelId} 启用`} checked={m.enabled} onChange={e=>{
          if(!e.target.checked&&selected(m.id)){setError('请先更换主备模型并保存，再停用该模型');return;}update(v=>{v.providers.find(x=>x.id===p.id)!.models.find(x=>x.id===m.id)!.enabled=e.target.checked;});}}/></div>
      </div>)}</div>
    </article>)}
    <div className="pi-routing"><label>主模型<select aria-label="主模型" value={draft.primary} onChange={e=>update(v=>{v.primary=e.target.value;})}>{options(draft.primary)}</select></label>
      <div className="pi-list-heading"><span>备用模型</span><button type="button" onClick={()=>update(v=>{v.fallbacks.push('');})}>＋ 添加备用</button></div>
      {draft.fallbacks.map((id,i)=><div className="pi-fallback" key={i}><span>{i+1}</span><select aria-label={`备用模型 ${i+1}`} value={id} onChange={e=>update(v=>{v.fallbacks[i]=e.target.value;})}>{options(id)}</select>
        <button type="button" className="pi-icon" disabled={i===0} aria-label={`上移备用 ${i+1}`} onClick={()=>update(v=>{[v.fallbacks[i-1],v.fallbacks[i]]=[v.fallbacks[i]!,v.fallbacks[i-1]!];})}>↑</button>
        <button type="button" className="pi-icon" aria-label={`移除备用 ${i+1}`} onClick={()=>update(v=>{v.fallbacks.splice(i,1);})}>×</button></div>)}
    </div>
    {error&&<p role="alert" className="pi-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <footer><button type="button" className="pi-save" onClick={()=>void save()}>{busy?'保存中…':'保存'}</button></footer></fieldset>
    <dialog ref={dialog} aria-labelledby={dialogTitle} onCancel={e=>{if(busy)e.preventDefault();else close();}}><fieldset disabled={busy}>
      <header><h3 id={dialogTitle}>{editor?.kind==='provider'?(editor.id?'编辑 Provider':'添加 Provider'):editor?.kind==='test'?'测试模型':editor?.id?'编辑模型':'添加模型'}</h3><button className="pi-icon" type="button" aria-label="关闭" onClick={close}>×</button></header>
      {editor?.kind==='provider'&&<><label>名称<input value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></label><label>Base URL<input value={editor.baseUrl} onChange={e=>setEditor({...editor,baseUrl:e.target.value})}/></label><label>API 格式{protocols(editor.protocol,protocol=>setEditor({...editor,protocol}))}</label></>}
      {editor?.kind==='model'&&<><div className="pi-smart">智能配置 <input type="checkbox" role="switch" disabled aria-label="智能配置" title="暂不自动推断模型参数"/></div>
        <label>模型 ID<input value={editor.modelId} onChange={e=>setEditor({...editor,modelId:e.target.value})}/></label>
        <label>上下文窗口<input inputMode="numeric" type="number" min="1" value={editor.contextWindow} onChange={e=>setEditor({...editor,contextWindow:e.target.value})}/></label>
        <label>最大输出 Token<input inputMode="numeric" type="number" min="1" value={editor.maxOutputTokens} onChange={e=>setEditor({...editor,maxOutputTokens:e.target.value})}/></label></>}
      {editor?.kind==='test'&&<p>测试将由产品宿主向所选 Provider 发送测试请求，可能产生费用。确认继续？</p>}
      {editorError&&<p role="alert" className="pi-error">{editorError}</p>}<footer><button type="button" onClick={close}>取消</button><button type="button" className="pi-save" onClick={()=>void commitEditor()}>{busy?'处理中…':editor?.kind==='test'?'确认测试':'确定'}</button></footer>
    </fieldset></dialog>
  </section>;
}
