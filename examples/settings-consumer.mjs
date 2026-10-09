import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {createRuntime,ProviderFailure} from 'pi-agent-runtime';
import {compileSettings} from 'pi-agent-runtime/settings';
import {ModelSettingsPanel} from 'pi-agent-runtime/ui';
const config={providers:[{id:'synthetic',name:'Synthetic',baseUrl:'https://example.invalid',protocol:'openai-completions',enabled:true,credentialSet:true,
  models:[{id:'a',modelId:'a',enabled:true,contextWindow:8192,maxOutputTokens:4},{id:'b',modelId:'b',enabled:true,contextWindow:8192,maxOutputTokens:4}]}],primary:'a',fallbacks:['b']};
const markup=renderToStaticMarkup(createElement(ModelSettingsPanel,{initialValue:config,onSave:async()=>{}}));
assert.ok(markup.includes('Base URL'));assert.ok(readFileSync(import.meta.resolve('pi-agent-runtime/ui.css').replace('file://',''),'utf8').includes('.pi-model-settings'));
const route=compileSettings(config,model=>async request=>{
  if(model.id==='a')throw new ProviderFailure('quota');
  if(request.messages.some(m=>m.role==='system'&&m.tools?.length)&&!request.messages.some(m=>m.role==='tool'))return {content:[{kind:'tool',id:'one',name:'lookup',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
  return {content:[{kind:'text',text:'42'}],stop:'complete',usage:{inputTokens:1,outputTokens:2}};
});
const runtime=createRuntime({...route,authorize:async()=>true,audit:{append:async()=>{}}}),limits={modelCalls:4,toolCalls:1,outputTokens:20,resourceUnits:8,wallTimeMs:1000};
assert.equal((await runtime.runWorker({taskId:'consumer-worker',prompt:'Synthetic',limits,validate:v=>v})).status,'succeeded');
let effects=0;
assert.equal((await runtime.runAgent({taskId:'consumer-agent',prompt:'Synthetic',limits,tools:[{name:'lookup',description:'Synthetic',effect:'read',resourceUnits:1,
  parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return 42;}}]})).status,'succeeded');
assert.equal(effects,1);
console.log(JSON.stringify({settings:'consumed',ui:'rendered',css:'exported',worker:'fallback-succeeded',agent:'fallback-succeeded',toolExecutions:effects}));
