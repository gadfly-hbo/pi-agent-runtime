import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime, createPiTransport} from '../src/index.ts';
import * as sdk from '../src/index.ts';
import type {ModelConfig, ModelReply, AuditEvent} from '../src/index.ts';
const model: ModelConfig = {provider:'synthetic-a',id:'primary',protocol:'openai-completions',endpoint:'https://a.invalid/v1',contextWindow:8192};
const reply: ModelReply = {content:[{kind:'text',text:'42'}],stop:'complete',usage:{inputTokens:1,outputTokens:2}};
test('F01: quota failure invokes ordered fallback within the same task ledger',async()=>{
  const called:string[]=[],events:AuditEvent[]=[];
  const runtime=createRuntime({
    model:{...model,maxOutputTokens:4},transport:async request=>{
      called.push(request.model.id);
      throw new sdk.ProviderFailure('quota');
    },
    fallbacks:[{model:{...model,provider:'synthetic-b',id:'backup',maxOutputTokens:4},transport:async request=>{
      called.push(request.model.id);return reply;
    }}],
    authorize:async()=>true,audit:{append:async event=>{events.push(event);}}
  });
  const result=await runtime.runWorker({taskId:'fallback',prompt:'Synthetic',limits:{modelCalls:2,toolCalls:0,outputTokens:8,wallTimeMs:1000},validate:v=>v});
  assert.deepEqual(called,['primary','backup']);
  assert.equal(result.status,'succeeded');
  assert.equal(result.status==='succeeded'&&result.value,42);
  assert.equal(result.usage.outputTokens,6); // Failed unknown attempt keeps four; successful backup uses two.
  assert.equal(result.usage.modelCalls,2);
  assert.ok(events.some(e=>e.kind==='model.admitted'&&e.provider==='synthetic-b'&&e.model==='backup'));
  assert.ok(events.every(e=>e.runId===result.runId&&e.taskId==='fallback'));
});
test('F03: switching after a tool result preserves the result and never executes the tool twice',async()=>{
  let turns=0,effects=0;const modelIds:string[]=[];
  const runtime=createRuntime({model:{...model,maxOutputTokens:4},transport:async request=>{
    modelIds.push(request.model.id);
    if(++turns===1)return {content:[{kind:'tool',id:'once',name:'lookup',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
    throw new sdk.ProviderFailure('unavailable');
  },fallbacks:[{model:{...model,id:'backup',provider:'synthetic-b',maxOutputTokens:4},transport:async request=>{
    modelIds.push(request.model.id);
    assert.equal(request.messages.find(m=>m.role==='tool')?.text,'{"amount":42}');
    assert.equal(request.messages.find(m=>m.role==='tool')?.toolId,'once');
    return reply;
  }}],authorize:async()=>true,audit:{append:async()=>{}}});
  const result=await runtime.runAgent({taskId:'tool-fallback',prompt:'Synthetic',limits:{modelCalls:3,toolCalls:1,outputTokens:12,wallTimeMs:1000},
    tools:[{name:'lookup',description:'Synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},
      execute:async()=>{effects++;return {amount:42};}}]});
  assert.equal(result.status,'succeeded');assert.equal(effects,1);assert.deepEqual(modelIds,['primary','primary','backup']);
});
for(const scenario of ['budget','denial','cancel','invalid-output','unknown-error','tool-failure'] as const) {
  test('F04: '+scenario+' never bypasses its stop by using fallback',async()=>{
    let backups=0;const cancel=new AbortController();
    const runtime=createRuntime({model:{...model,maxOutputTokens:4},transport:async()=>{
      if(scenario==='cancel'){cancel.abort();throw new sdk.ProviderFailure('quota');}
      if(scenario==='invalid-output')return {...reply,content:[{kind:'text',text:'not json'}]};
      if(scenario==='unknown-error')throw new Error('private-error');
      if(scenario==='tool-failure')return {content:[{kind:'tool',id:'one',name:'save',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
      throw new sdk.ProviderFailure('quota');
    },fallbacks:[{model:{...model,id:'backup',maxOutputTokens:4},transport:async()=>{backups++;return reply;}}],
    authorize:async action=>!(scenario==='denial'&&action.kind==='model'&&action.request.model.id==='backup'),audit:{append:async()=>{}}});
    const base={taskId:scenario,prompt:'Synthetic',signal:cancel.signal,limits:{modelCalls:scenario==='budget'?1:3,toolCalls:1,outputTokens:12,wallTimeMs:1000}};
    const result=scenario==='tool-failure'?await runtime.runAgent({...base,tools:[{name:'save',description:'Synthetic',effect:'write',resourceUnits:1,
      parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{throw new Error('unknown side effect');}}]}):
      await runtime.runWorker({...base,validate:v=>v});
    assert.equal(backups,0);assert.notEqual(result.status,'succeeded');
    const expected={budget:'BUDGET_EXHAUSTED',denial:'AUTHORITY_REQUIRED',cancel:'CANCELLED','invalid-output':'INVALID_OUTPUT','unknown-error':'MODEL_FAILED','tool-failure':'TOOL_FAILED'};
    assert.equal(result.status!=='succeeded'&&result.reason,expected[scenario]);
  });
}
test('F05: output reservations cannot be reset by fallback or another run of the same task',async()=>{
  let calls=0;
  const failed=async()=>{calls++;throw new sdk.ProviderFailure('quota');};
  const runtime=createRuntime({model:{...model,maxOutputTokens:4},transport:failed,
    fallbacks:[{model:{...model,id:'backup',maxOutputTokens:4},transport:failed}],authorize:async()=>true,audit:{append:async()=>{}}});
  const request={taskId:'no-reset',prompt:'Synthetic',limits:{modelCalls:10,toolCalls:0,outputTokens:4,wallTimeMs:1000},validate:(v:unknown)=>v};
  const first=await runtime.runWorker(request),second=await runtime.runWorker(request);
  assert.equal(first.status!=='succeeded'&&first.reason,'BUDGET_EXHAUSTED');
  assert.equal(second.status!=='succeeded'&&second.reason,'BUDGET_EXHAUSTED');assert.equal(calls,1);
});
test('F02: actual Pi HTTP 429 switches to another configured transport without hidden retries',async()=>{
  const calls:string[]=[];
  const primary={...model,maxOutputTokens:4};
  const backup={...primary,provider:'synthetic-b',id:'backup'};
  const primaryTransport=createPiTransport({model:primary,apiKey:'synthetic-key',fetch:async()=>{
    calls.push('primary');return new Response('{"error":{"message":"private-provider-detail"}}',{status:429,headers:{'content-type':'application/json'}});
  }});
  const backupTransport=createPiTransport({model:backup,apiKey:'synthetic-key',fetch:async()=>{
    calls.push('backup');return new Response(
      'data: '+JSON.stringify({id:'b',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'42'},finish_reason:null}]})+'\n\n'+
      'data: '+JSON.stringify({id:'b',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}})+'\n\ndata: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
  }});
  const result=await createRuntime({model:primary,transport:primaryTransport,fallbacks:[{model:backup,transport:backupTransport}],
    authorize:async()=>true,audit:{append:async()=>{}}}).runWorker({taskId:'http-fallback',prompt:'Synthetic',
    limits:{modelCalls:2,toolCalls:0,outputTokens:8,wallTimeMs:1000},validate:v=>v});
  assert.deepEqual(calls,['primary','backup']);assert.equal(result.status,'succeeded');
  assert.equal(JSON.stringify(result).includes('private-provider-detail'),false);
});
test('F06: multiple fallback failures consume the configured order and one cumulative ledger',async()=>{
  const seen:string[]=[];
  const candidate=(id:string,fail:boolean)=>({model:{...model,id,maxOutputTokens:4},transport:async()=>{seen.push(id);if(fail)throw new sdk.ProviderFailure('network');return reply;}});
  const runtime=createRuntime({...candidate('primary',true),fallbacks:[candidate('backup-1',true),candidate('backup-2',false)],authorize:async()=>true,audit:{append:async()=>{}}});
  const result=await runtime.runWorker({taskId:'ordered',prompt:'Synthetic',limits:{modelCalls:3,toolCalls:0,outputTokens:12,wallTimeMs:1000},validate:v=>v});
  assert.equal(result.status,'succeeded');assert.deepEqual(seen,['primary','backup-1','backup-2']);assert.equal(result.usage.outputTokens,10);
});
for(const status of [400,401,403])test(`F07: HTTP ${status} does not route around invalid configuration or authentication`,async()=>{
  let backups=0;
  const primary={...model,maxOutputTokens:4};
  const runtime=createRuntime({model:primary,transport:createPiTransport({model:primary,apiKey:'synthetic-only',fetch:async()=>new Response('{"error":{"message":"quota exceeded private detail"}}',{status,headers:{'content-type':'application/json'}})}),
    fallbacks:[{model:{...primary,id:'backup'},transport:async()=>{backups++;return reply;}}],authorize:async()=>true,audit:{append:async()=>{}}});
  const result=await runtime.runWorker({taskId:`auth-${status}`,prompt:'Synthetic',limits:{modelCalls:2,toolCalls:0,outputTokens:8,wallTimeMs:1000},validate:v=>v});
  assert.equal(result.status!=='succeeded'&&result.reason,'MODEL_FAILED');assert.equal(backups,0);assert.ok(!JSON.stringify(result).includes('private detail'));
});
test('F08: exhausted route records every classified failure on the same run without raw details',async()=>{
  const events:AuditEvent[]=[];
  const failed=async()=>{throw new sdk.ProviderFailure('quota');};
  const result=await createRuntime({model:{...model,maxOutputTokens:4},transport:failed,fallbacks:[{model:{...model,id:'backup',maxOutputTokens:4},transport:failed}],
    authorize:async()=>true,audit:{append:async e=>{events.push(e);}}}).runWorker({taskId:'exhausted',prompt:'Synthetic',limits:{modelCalls:2,toolCalls:0,outputTokens:8,wallTimeMs:1000},validate:v=>v});
  assert.equal(result.status!=='succeeded'&&result.reason,'MODEL_FAILED');
  assert.deepEqual(events.filter(e=>e.kind==='model.finished').map(e=>[e.model,e.failureCategory,e.attempt]),[['primary','quota',1],['backup','quota',2]]);
  assert.ok(events.every(e=>e.taskId===result.taskId&&e.runId===result.runId));
});
test('F09: cross-protocol fallback normalizes tool identities and consumes the existing result exactly once',async()=>{
  let turn=0,effects=0;let body:any;
  const backup={...model,provider:'synthetic-anthropic',protocol:'anthropic-messages' as const,id:'backup',maxOutputTokens:4};
  const backupTransport=createPiTransport({model:backup,apiKey:'synthetic-only',fetch:async(_input,init)=>{
    body=JSON.parse(String(init?.body));
    const events=[{type:'message_start',message:{id:'reply',type:'message',role:'assistant',model:'backup',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'42'}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}];
    return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await createRuntime({model:{...model,maxOutputTokens:4},transport:async()=>{
    if(++turn===1)return {content:[{kind:'tool',id:'call.with.dot',name:'lookup',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
    throw new sdk.ProviderFailure('unavailable');
  },fallbacks:[{model:backup,transport:backupTransport}],authorize:async()=>true,audit:{append:async()=>{}}}).runAgent({taskId:'cross-protocol',prompt:'Synthetic',
    limits:{modelCalls:3,toolCalls:1,outputTokens:12,wallTimeMs:1000},tools:[{name:'lookup',description:'Synthetic',effect:'read',resourceUnits:1,
      parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return 42;}}]});
  assert.equal(result.status,'succeeded');assert.equal(effects,1);
  const history=body.messages.find((m:any)=>m.role==='assistant').content.find((c:any)=>c.type==='tool_use');
  const toolResult=body.messages.at(-1).content.find((c:any)=>c.type==='tool_result');
  assert.equal(history.id,'call_with_dot');assert.equal(toolResult.tool_use_id,'call_with_dot');assert.equal(toolResult.content,'42');
});
