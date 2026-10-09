import type {ModelConfig, ModelTransport, RuntimeOptions} from './types.ts';
import {RuntimeFault} from './errors.ts';
/** In-memory UI/application values, not a database schema or credential store. */
export interface ConfiguredModel {id:string; modelId:string; contextWindow:number; maxOutputTokens:number; enabled:boolean; reasoning?:boolean}
export interface ConfiguredProvider {
  id:string; name:string; baseUrl:string; protocol:ModelConfig['protocol']; enabled:boolean;
  credentialSet:boolean; models:ConfiguredModel[];
}
export interface ModelSettings {providers:ConfiguredProvider[]; primary:string; fallbacks:string[]}
const nonempty=(s:unknown):s is string=>typeof s==='string'&&s.trim().length>0&&s.length<=200;
const integer=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const keys=(value:object,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
export function validateSettings(settings:ModelSettings):string[] {
  try {
    const errors:string[]=[], ids=new Set<string>(), models=new Map<string,{model:ConfiguredModel;provider:ConfiguredProvider}>();
    if(!keys(settings,['providers','primary','fallbacks'])||!Array.isArray(settings.providers)||!Array.isArray(settings.fallbacks)||
      JSON.stringify(settings).length>1048576)return ['配置格式不合法'];
    for(const provider of settings.providers) {
      if(!keys(provider,['id','name','baseUrl','protocol','enabled','credentialSet','models'])||!nonempty(provider.id)||!nonempty(provider.name)||
        typeof provider.enabled!=='boolean'||typeof provider.credentialSet!=='boolean'||!Array.isArray(provider.models)||ids.has(provider.id))return ['Provider 配置不合法或重复'];
      ids.add(provider.id);
      const url=new URL(provider.baseUrl),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
      if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&local)||
        !['anthropic-messages','openai-completions'].includes(provider.protocol))errors.push('Base URL 或 API 格式不支持');
      const modelIds=new Set<string>();
      for(const model of provider.models) {
        if(!keys(model,['id','modelId','contextWindow','maxOutputTokens','enabled','reasoning'])||!nonempty(model.id)||!nonempty(model.modelId)||
          models.has(model.id)||modelIds.has(model.modelId)||typeof model.enabled!=='boolean'||
          (model.reasoning!==undefined&&typeof model.reasoning!=='boolean')||
          !integer(model.contextWindow)||!integer(model.maxOutputTokens)||model.maxOutputTokens>model.contextWindow)return ['模型 ID 或参数不合法'];
        modelIds.add(model.modelId);models.set(model.id,{model,provider});
      }
    }
    if(!settings.primary)errors.push('请选择主模型');
    if(!settings.fallbacks.length||settings.fallbacks.some(key=>!nonempty(key)))errors.push('请选择至少一个有效备用模型');
    const selected=[settings.primary,...settings.fallbacks].filter(Boolean);
    if(new Set(selected).size!==selected.length)errors.push('主备模型不能重复');
    for(const key of selected) {
      const item=models.get(key);
      if(!item||!item.model.enabled||!item.provider.enabled)errors.push('主备模型包含不可用项');
      else if(!item.provider.credentialSet)errors.push('请设置所选 Provider 的 API Key');
    }
    return [...new Set(errors)];
  } catch {return ['配置格式不合法'];}
}
export function compileSettings(settings:ModelSettings,resolve:(model:ModelConfig,providerId:string)=>ModelTransport):Pick<RuntimeOptions,'model'|'transport'|'fallbacks'> {
  const captured=structuredClone(settings);
  if(validateSettings(captured).length)throw new RuntimeFault('INVALID_REQUEST');
  const convert=(key:string)=>{
    const provider=captured.providers.find(p=>p.models.some(m=>m.id===key))!;
    const m=provider.models.find(m=>m.id===key)!;
    const model=Object.freeze({provider:provider.id,id:m.modelId,protocol:provider.protocol,endpoint:provider.baseUrl,
      contextWindow:m.contextWindow,maxOutputTokens:m.maxOutputTokens,...(m.reasoning===undefined?{}:{reasoning:m.reasoning})});
    return {model,transport:resolve(model,provider.id)};
  };
  const primary=convert(captured.primary);
  return {...primary,fallbacks:captured.fallbacks.map(convert)};
}
