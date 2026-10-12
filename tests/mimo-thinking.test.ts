import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime, createPiTransport, createMemoryBudgetStore} from '../src/index.ts';
import {compileSettings, validateSettings} from '../src/settings.ts';
import type {ModelConfig} from '../src/index.ts';
import type {ModelSettings} from '../src/settings.ts';

const settings:ModelSettings={providers:[{id:'p',name:'Synthetic',baseUrl:'https://example.invalid/v1',protocol:'openai-completions',enabled:true,credentialSet:true,
  models:[{id:'m1',modelId:'primary',contextWindow:8192,maxOutputTokens:4,enabled:true},{id:'m2',modelId:'backup',contextWindow:8192,maxOutputTokens:4,enabled:true}]}],primary:'m1',fallbacks:['m2']};

const base:ModelConfig={provider:'xiaomi-token-plan-cn',id:'mimo-v2.6-flash',
  protocol:'openai-completions',endpoint:'https://example.invalid/v1',contextWindow:8192,maxOutputTokens:4096};
const mapped={...base,reasoning:true,thinkingProtocol:'mimo-chat' as const};
const limits={modelCalls:3,toolCalls:1,outputTokens:8192,wallTimeMs:2000};
function reply(tool=false){
  const delta=tool?{role:'assistant',reasoning_content:'SYNTHETIC_REASONING',tool_calls:[{index:0,id:'lookup-1',type:'function',function:{name:'lookup',arguments:'{}'}}]}:{role:'assistant',content:'42'};
  const events=[{id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]},
    {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}];
  return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
for(const level of [undefined,'off','low','high'] as const){
  test(`MT01/02: explicit MiMo mapping encodes ${level??'omitted'} thinking without changing provider or cap`,async()=>{
    let body:any;
    const transport=createPiTransport({model:mapped,apiKey:'synthetic',fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return reply();}});
    const result=await createRuntime({model:mapped,transport,authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'mimo-'+level,prompt:'Synthetic',limits,
      ...(level===undefined?{}:{thinkingLevel:level})});
    assert.deepEqual(body.thinking,{type:level===undefined||level==='off'?'disabled':'enabled'});
    assert.equal(body.reasoning_effort,undefined);
    assert.equal(body.model,base.id);
    // Native context budgeting may narrow the ceiling (4093 for this tiny window), never enlarge it.
    assert.ok(body.max_completion_tokens>0&&body.max_completion_tokens<=4096);
    assert.equal(result.status,'succeeded');assert.equal(result.usage.outputTokens,3);
  });
}
test('MT02: old standard mapping is unchanged even for a MiMo-named model',async()=>{
  let body:any;
  const config={...base,reasoning:true};
  const transport=createPiTransport({model:config,apiKey:'synthetic',fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return reply();}});
  const result=await createRuntime({model:config,transport,authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'legacy-mimo',prompt:'Synthetic',limits,thinkingLevel:'off'});
  assert.equal(result.status,'succeeded');assert.equal(body.thinking,undefined);
});
test('MT03: native MiMo tool continuation consumes exact reasoning and tool result without exposing reasoning in audit or final answer',async()=>{
  let calls=0,effects=0,continuation:any;const audit:unknown[]=[];
  const transport=createPiTransport({model:mapped,apiKey:'synthetic',fetch:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));if(++calls===2)continuation=body;return reply(calls===1);
  }});
  const result=await createRuntime({model:mapped,transport,authorize:async()=>true,audit:{append:async e=>{audit.push(e);}}}).runAgent({taskId:'mimo-tools',prompt:'Synthetic',limits,thinkingLevel:'low',
    tools:[{name:'lookup',description:'Synthetic read',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return 42;}}]});
  assert.equal(result.status,'succeeded');assert.equal(calls,2);assert.equal(effects,1);
  assert.deepEqual(continuation.thinking,{type:'enabled'});
  assert.equal(continuation.messages.find((m:any)=>m.role==='assistant').reasoning_content,'SYNTHETIC_REASONING');
  assert.equal(continuation.messages.at(-1).role,'tool');assert.equal(continuation.messages.at(-1).content,'42');
  assert.equal(result.status==='succeeded'&&result.value,'42');assert.equal(result.usage.outputTokens,6);
  assert.equal(JSON.stringify(audit).includes('SYNTHETIC_REASONING'),false);assert.equal(JSON.stringify(result).includes('SYNTHETIC_REASONING'),false);
});
for(const override of [{thinkingProtocol:'unknown'},{protocol:'anthropic-messages'},{reasoning:false}]){
  test('MT04: invalid explicit protocol '+JSON.stringify(override)+' refuses before effects',async()=>{
    let effects=0;const config={...mapped,...override} as ModelConfig;
    const result=await createRuntime({model:config,transport:async()=>{effects++;return {content:[{kind:'text',text:'42'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};},
      authorize:async()=>{effects++;return true;},audit:{append:async()=>{effects++;}}}).runText({taskId:'invalid-mimo',prompt:'Synthetic',limits});
    assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_REQUEST');assert.equal(effects,0);
  });
}
test('MT04: changing the explicit mapping cannot rebind an existing Task or reset usage',async()=>{
  const budgets=createMemoryBudgetStore();let calls=0;
  const transport=async()=>{calls++;return {content:[{kind:'text' as const,text:'42'}],stop:'complete' as const,usage:{inputTokens:1,outputTokens:1}};};
  const options={budgets,transport,authorize:async()=>true,audit:{append:async()=>{}}};
  const first=await createRuntime({...options,model:base}).runText({taskId:'stable-mimo',prompt:'Synthetic',limits});
  assert.equal(first.status,'succeeded');
  const second=await createRuntime({...options,model:mapped}).runText({taskId:'stable-mimo',prompt:'Synthetic',limits});
  assert.equal(second.status!=='succeeded'&&second.reason,'CONFIGURATION_CHANGED');assert.equal(calls,1);
});
test('MT05: settings validate and preserve explicit protocol in the immutable compiled model',()=>{
  const configured=structuredClone(settings);Object.assign(configured.providers[0]!.models[0]!,{reasoning:true,thinkingProtocol:'mimo-chat'});
  assert.deepEqual(validateSettings(configured),[]);
  const compiled=compileSettings(configured,()=>async()=>({content:[],stop:'complete',usage:{inputTokens:0,outputTokens:0}}));
  assert.equal((compiled.model as typeof mapped).thinkingProtocol,'mimo-chat');assert.equal(Object.isFrozen(compiled.model),true);
  Object.assign(configured.providers[0]!.models[0]!,{thinkingProtocol:'unknown'});assert.ok(validateSettings(configured).length);
  Object.assign(configured.providers[0]!.models[0]!,{thinkingProtocol:'mimo-chat',reasoning:false});assert.ok(validateSettings(configured).length);
});
