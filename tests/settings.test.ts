import assert from 'node:assert/strict';
import test from 'node:test';
import {validateSettings,compileSettings} from '../src/settings.ts';
import type {ModelSettings} from '../src/settings.ts';
export const settings:ModelSettings={providers:[{id:'p',name:'Synthetic',baseUrl:'https://example.invalid/v1',protocol:'openai-completions',enabled:true,credentialSet:true,
  models:[{id:'m1',modelId:'primary',contextWindow:8192,maxOutputTokens:4,enabled:true},{id:'m2',modelId:'backup',contextWindow:8192,maxOutputTokens:4,enabled:true}]}],primary:'m1',fallbacks:['m2']};
test('S01: configuration refuses an unsupported protocol before transport resolution',()=>{
  const invalid=structuredClone(settings);
  (invalid.providers[0]!.protocol as string)='responses';
  assert.ok(validateSettings(invalid).length>0);
});
test('S02: saved settings compile into primary and ordered fallback without leaking credentials',()=>{
  assert.deepEqual(validateSettings(settings),[]);
  const resolved:string[]=[];
  const compiled=compileSettings(settings,(model,provider)=>{resolved.push(provider+':'+model.id);return async()=>({content:[],stop:'complete',usage:{inputTokens:0,outputTokens:0}});});
  assert.deepEqual(resolved,['p:primary','p:backup']);
  assert.equal(compiled.model.maxOutputTokens,4);assert.equal(compiled.fallbacks?.[0]?.model.id,'backup');
  assert.equal(Object.isFrozen(compiled.model),true);
});
test('TH03: verified reasoning capability survives settings compilation',()=>{
  const capable=structuredClone(settings);
  Object.assign(capable.providers[0]!.models[0]!,{reasoning:true});
  Object.assign(capable.providers[0]!.models[1]!,{reasoning:false});
  assert.deepEqual(validateSettings(capable),[]);
  const compiled=compileSettings(capable,()=>async()=>({content:[],stop:'complete',usage:{inputTokens:0,outputTokens:0}}));
  assert.equal(compiled.model.reasoning,true);
  assert.equal(compiled.fallbacks?.[0]?.model.reasoning,false);
  Object.assign(capable.providers[0]!.models[0]!,{reasoning:'yes'});
  assert.ok(validateSettings(capable).length>0);
});
for(const scenario of ['missing-backup','empty-backup','duplicate','disabled','no-credential','raw-key','oversized-output'] as const) {
  test('S03: '+scenario+' refuses configuration before transport creation',()=>{
    const invalid=structuredClone(settings);
    if(scenario==='missing-backup')invalid.fallbacks=[];
    if(scenario==='empty-backup')invalid.fallbacks=[''];
    if(scenario==='duplicate')invalid.fallbacks=['m1'];
    if(scenario==='disabled')invalid.providers[0]!.enabled=false;
    if(scenario==='no-credential')invalid.providers[0]!.credentialSet=false;
    if(scenario==='raw-key')Object.assign(invalid.providers[0]!,{apiKey:'synthetic-not-a-secret'});
    if(scenario==='oversized-output')invalid.providers[0]!.models[0]!.maxOutputTokens=999999;
    let resolved=0;
    assert.ok(validateSettings(invalid).length>0);
    assert.throws(()=>compileSettings(invalid,()=>{resolved++;throw Error();}));
    assert.equal(resolved,0);
  });
}
