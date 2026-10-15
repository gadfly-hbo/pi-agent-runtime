import test from 'node:test';
import assert from 'node:assert/strict';
import {admitModelRequest,createPiTransport,createRuntime,createMemoryBudgetStore,createSessionRuntime} from '../src/index.ts';
import type {ModelConfig,PiTransportOptions,SessionRuntimeOptions} from '../src/index.ts';
const model:ModelConfig={provider:'synthetic',id:'fidelity',protocol:'openai-completions',endpoint:'https://synthetic.invalid/v1',contextWindow:200000,maxOutputTokens:16};
const call={model,messages:[{role:'user' as const,text:'synthetic'}],maxOutputTokens:16,signal:new AbortController().signal};

test('S2/F02-F06/R2/V08: real Pi HTTP400 context cause keeps safe explicit category and response state',async()=>{
  const options:PiTransportOptions & {modelObservations:'v1'}={model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>new Response(JSON.stringify({error:{code:'context_length_exceeded',message:'SYNTHETIC_PRIVATE_CONTEXT_BODY'}}),{status:400,headers:{'content-type':'application/json'}})};
  const transport=createPiTransport(options);
  await assert.rejects(transport(call),error=>{
    const observed=error as Error & {outcome?:{category:string;physicalStatus:string;httpStatus:number;usage:{outputTokens:{kind:string}}}};
    assert.equal(observed.outcome?.category,'context');
    assert.equal(observed.outcome?.physicalStatus,'response-received');assert.equal(observed.outcome?.httpStatus,400);
    assert.equal(observed.outcome?.usage.outputTokens.kind,'unknown');
    assert.equal(JSON.stringify(observed).includes('SYNTHETIC_PRIVATE_CONTEXT_BODY'),false);assert.equal(observed.cause,undefined);
    return true;
  });
});

function openaiReply(usage?:Record<string,unknown>,stop='stop') {
  return new Response([
    {id:'synthetic',model:'reported-fidelity',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'synthetic'},finish_reason:null}]},
    {id:'synthetic',model:'reported-fidelity',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:stop}],...(usage ? {usage} : {})},
  ].map(part=>`data: ${JSON.stringify(part)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
test('S2/R2/V08: actual reported zero remains zero while missing usage remains UNKNOWN',async()=>{
  const transport=createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>openaiReply({prompt_tokens:0,completion_tokens:0,total_tokens:0})});
  const result=await transport(call);
  assert.equal(result.usage.outputTokens,0,'known actual zero was replaced by output cap');
  assert.deepEqual(result.outcome?.usage,{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}});
  assert.equal(result.outcome?.responseModel,'reported-fidelity');
  const missing=await createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>openaiReply()})(call);
  assert.deepEqual(missing.outcome?.usage,{inputTokens:{kind:'unknown'},outputTokens:{kind:'unknown'}});
  assert.equal(missing.usage.outputTokens,16,'unknown keeps conservative numeric reservation');
});

const limits={cumulative:'unlimited' as const,maxOutputTokens:16,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000};
test('S2/R2/V08-V10: a real interrupted SSE records reported input while preserving unknown output reservation and stops recovery',async()=>{
  let physical=0;
  const transport=createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>{
    physical++;
    let sent=false;return new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',usage:{prompt_tokens:9},choices:[{index:0,delta:{role:'assistant',content:'partial'},finish_reason:null}]})+'\n\n'));}else controller.error(new Error('SYNTHETIC_PRIVATE_DISCONNECT'));}}),{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await createRuntime({model,transport,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}} as any).runText({taskId:'partial-input',prompt:'synthetic',limits,modelRecovery:{extraAttempts:1}});
  assert.equal(result.usage.inputTokens,9,'known input disappeared on failure');
  assert.equal(result.usage.reservedOutputTokens,16);assert.equal(physical,1,'unconfirmed physical result must stop extra attempts');
  assert.equal((result as any).modelOutcome?.physicalStatus,'unknown');assert.equal((result as any).modelOutcome?.usageFinal,false);
  assert.equal((result as any).modelOutcome?.usage.inputTokens.value,9);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DISCONNECT'),false);
});

async function persistent(transport:SessionRuntimeOptions['transport'],extra:Partial<SessionRuntimeOptions>={}) {
  const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'r2-fidelity-'));
  return createSessionRuntime({model,transport,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=>'ready',
    harness:{retry:{enabled:false,maxRetries:0,baseDelayMs:1},compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:1}},
    storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},...extra});
}
test('S2/R2/V08-V10: confirmed HTTP context overflow recovers through native Session without replaying a completed tool',async()=>{
  let physical=0,tools=0,summaries=0;
  const transport=createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    physical++;
    if(String(init?.body).includes('context summarization assistant')){summaries++;return openaiReply({prompt_tokens:5,completion_tokens:3,total_tokens:8});}
    if(physical===1)return new Response([
      {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'completed',type:'function',function:{name:'receipt',arguments:'{}'}}]},finish_reason:null}]},
      {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}},
    ].map(v=>`data: ${JSON.stringify(v)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    if(physical===2)return new Response('{"error":{"code":"context_length_exceeded","message":"SYNTHETIC_PRIVATE_OVERFLOW"}}',{status:400,headers:{'content-type':'application/json'}});
    return openaiReply({prompt_tokens:5,completion_tokens:3,total_tokens:8});
  }});
  const runtime=await persistent(transport),session=await runtime.create();
  const result=await runtime.run({sessionId:session.id,taskId:'confirmed-overflow',prompt:'synthetic',limits,modelRecovery:{extraAttempts:1},tools:[{name:'receipt',description:'synthetic',effect:'write',resourceUnits:2,parameters:{type:'object'},execute:async()=>{tools++;return{receipt:'completed-1'};}}]});
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(tools,1);assert.equal(summaries,1);assert.equal(physical,4);
  assert.equal(result.usage.modelCalls,4);assert.equal(result.usage.inputTokens,15);assert.equal(result.usage.outputTokens,25);assert.equal(result.usage.reservedOutputTokens,16);
});

test('S2/R2/V08: reported cache input is retained even when total input and output remain UNKNOWN',async()=>{
  const selected={...model,protocol:'anthropic-messages' as const};
  const transport=createPiTransport({model:selected,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>{
    const events=[
      {type:'message_start',message:{id:'synthetic',role:'assistant',model:selected.id,content:[],usage:{cache_read_input_tokens:70}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{}},
      {type:'message_stop'},
    ];return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await createRuntime({model:selected,transport,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'partial-cached',prompt:'synthetic',limits});
  assert.equal(result.status,'succeeded');assert.equal(result.usage.inputTokens,70);assert.equal(result.usage.reservedOutputTokens,16);
  assert.equal(result.modelOutcome?.usage.inputTokens.kind,'unknown');assert.equal((result.modelOutcome?.usage.inputTokens as any).reported,70);
});

test('S1-S2/R1-R2/V06-V08: final trusted guard denial returns known not-sent state without Provider UNKNOWN',async()=>{
 const contextAdmission={policyVersion:'guard-v1',protocolOverheadTokens:256,safetyMarginTokens:8192};let physical=0;
 const transport=async(request:any)=>{const final={...request,messages:[...request.messages,{role:'system',text:'x'.repeat(900000)}]};admitModelRequest(final,contextAdmission);physical++;return{content:[{kind:'text' as const,text:'must not send'}],stop:'complete' as const,usage:{inputTokens:1,outputTokens:1}};};
 const result=await createRuntime({model,transport,contextAdmission,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'context-not-sent',prompt:'synthetic',limits});
 assert.equal(physical,0);assert.equal(result.usage.reservedOutputTokens,0);assert.equal(result.modelOutcome?.physicalStatus,'not-sent');
 assert.equal(result.modelOutcome?.category,'context');assert.deepEqual(result.modelOutcome?.usage.outputTokens,{kind:'known',value:0});
});

test('S2/R2/V10: cancelled late physical success records known counters without refunding UNKNOWN or publishing',async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>release=r);
 const events:any[]=[];const budgets=createMemoryBudgetStore();let lease:any;const claim=budgets.claimUncapped!.bind(budgets);budgets.claimUncapped=async(...args)=>{lease=await claim(...args);return lease;};const abort=new AbortController();let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const runtime=createRuntime({model,modelObservations:'v1',budgets,authorize:async()=>true,audit:{append:async e=>{events.push(e);}},transport:async()=>{entered();await pending;return{content:[{kind:'text',text:'late'}],stop:'complete',usage:{inputTokens:11,outputTokens:2},outcome:{model:{provider:model.provider,id:model.id,protocol:model.protocol},stop:'complete',physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:11},outputTokens:{kind:'known',value:2}},diagnostic:'COMPLETE'}};}});
 const running=runtime.runText({taskId:'late-model',prompt:'synthetic',limits,signal:abort.signal});await ready;abort.abort();const result=await running;
 assert.equal(result.status,'cancelled');assert.equal(result.modelOutcome?.physicalStatus,'unknown');assert.equal(result.usage.inputTokens,0);
 release();await runtime.waitForIdle('late-model');const terminal=events.find(e=>e.kind==='model.finished');
 assert.equal(terminal?.modelOutcome?.usage.inputTokens.value,11);assert.equal(terminal?.modelOutcome?.usage.outputTokens.value,2);
 assert.equal(result.modelOutcome?.physicalStatus,'unknown','the original UNKNOWN snapshot must stay immutable');
 const usage=lease.snapshot();assert.equal(usage.inputTokens,11);assert.equal(usage.reservedOutputTokens,16);assert.equal(usage.outputTokens,16);
 assert.equal(events.some(e=>e.kind==='run.finished'&&!e.reason),false);
});

test('S2/R2/V08: faux HTTP errors keep neutral categories, physical status and unknown usage with no private body',async()=>{
 for(const [status,code,category] of [[402,undefined,'quota'],[429,undefined,'rate-limit'],[503,undefined,'unavailable'],[501,undefined,'unavailable'],[401,undefined,'authentication'],[403,undefined,'authentication'],[400,undefined,'unknown'],[503,'context_length_exceeded','context'],[429,'safety_error','safety']] as const){
  const transport=createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>new Response(JSON.stringify({error:{code,message:'SYNTHETIC_PRIVATE_HTTP'}}),{status,headers:{'content-type':'application/json'}})});
  await assert.rejects(transport(call),(e:any)=>{assert.equal(e.outcome.category,category);assert.equal(e.outcome.httpStatus,status);assert.equal(e.outcome.physicalStatus,'response-received');assert.equal(e.outcome.usage.inputTokens.kind,'unknown');assert.equal(JSON.stringify(e).includes('SYNTHETIC_PRIVATE'),false);if(category==='safety'||category==='context')assert.equal(e.name,'ModelFailure');return true;});
 }
});

test('S2/R2/V08: safety SSE and invalid cached usage cannot be softened or refunded as successful content',async()=>{
 for(const [usage,stop,category] of [[{prompt_tokens:3,completion_tokens:1},'content_filter','safety'],[{prompt_tokens:3,completion_tokens:1,prompt_tokens_details:{cached_tokens:9}},'stop','invalid-output']] as const){
  const transport=createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>openaiReply(usage,stop)});
  const result=await createRuntime({model,transport,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'safety-'+category,prompt:'synthetic',limits,modelRecovery:{extraAttempts:1}});
  assert.equal(result.status,'failed');assert.equal(result.modelOutcome?.category,category);assert.equal(result.usage.modelCalls,1);
 }
});

test('S2-R4/R2/V09-V10: opt-in reporting without a physical carrier stops legacy classified errors instead of blind fallback',async()=>{
 const {ProviderFailure}=await import('../src/index.ts');let primary=0,backup=0;
 const runtime=await persistent(async()=>{primary++;throw new ProviderFailure('network');},{fallbacks:[{model:{...model,id:'backup'},transport:async()=>{backup++;return{content:[{kind:'text',text:'must not run'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};} }]});
 const s=await runtime.create();const result=await runtime.run({sessionId:s.id,taskId:'unknown-carrier',prompt:'synthetic',tools:[],limits,modelRecovery:{extraAttempts:1}});await runtime.waitForIdle('unknown-carrier');
 assert.equal(result.status,'failed');assert.equal(primary,1);assert.equal(backup,0);assert.equal(result.modelOutcome?.physicalStatus,'unknown');assert.equal(result.usage.reservedOutputTokens,16);
});

test('S2/R2/V08: structured HTTP failure retains explicitly reported actual usage without inspecting private cause',async()=>{
 const transport=createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>new Response(JSON.stringify({error:{code:'safety_error',message:'SYNTHETIC_PRIVATE'},usage:{prompt_tokens:9,completion_tokens:2}}),{status:400,headers:{'content-type':'application/json'}})});
 const result=await createRuntime({model,transport,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'http-known-usage',prompt:'synthetic',limits});
 assert.equal(result.status,'failed');assert.equal(result.usage.inputTokens,9);assert.equal(result.usage.outputTokens,2);assert.equal(result.usage.reservedOutputTokens,0);assert.equal(result.modelOutcome?.category,'safety');assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);
});

test('S2/R2/V08: transport preflight denial is known not-sent and needs no output reservation',async()=>{
 let calls=0;const transport=createPiTransport({model:{...model,id:'other-fixed-candidate'},modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>{calls++;return openaiReply();}});
 const result=await createRuntime({model,transport,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'preflight-fixed',prompt:'synthetic',limits});
 assert.equal(calls,0);assert.equal(result.status,'blocked');assert.equal(result.reason,'CONFIGURATION_CHANGED');assert.equal(result.modelOutcome?.physicalStatus,'not-sent');assert.equal(result.usage.reservedOutputTokens,0);
});

test('S2/R2/V08: v1 runtime cannot promote legacy Pi missing usage/output reserve into confirmed Provider usage',async()=>{
 let calls=0;const transport=createPiTransport({model,apiKey:'synthetic-placeholder',fetch:async()=>{calls++;return openaiReply();}});
 const result=await createRuntime({model,transport,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'paired-observation',prompt:'synthetic',limits});
 assert.equal(result.status,'failed');assert.equal(calls,1);assert.equal(result.modelOutcome?.usage.inputTokens.kind,'unknown');assert.equal(result.usage.reservedOutputTokens,16);
});

test('S2/R2/V08-V11: invalid HTTP usage with a context code cannot enter native overflow recovery or soft success',async()=>{
 let calls=0,summaries=0,effects=0;const transport=createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
  calls++;if(String(init?.body).includes('context summarization assistant')){summaries++;return openaiReply({prompt_tokens:3,completion_tokens:1});}
  if(calls===1)return new Response('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'one',type:'function',function:{name:'effect',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:1}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  if(calls===2)return new Response(JSON.stringify({error:{code:'context_length_exceeded'},usage:{prompt_tokens:3,completion_tokens:1,prompt_tokens_details:{cached_tokens:9}}}),{status:400,headers:{'content-type':'application/json'}});
  return openaiReply({prompt_tokens:3,completion_tokens:1});
 }});const runtime=await persistent(transport),s=await runtime.create();const result=await runtime.run({sessionId:s.id,taskId:'invalid-context-usage',prompt:'synthetic',tools:[{name:'effect',description:'synthetic',effect:'write',parameters:{type:'object'},resourceUnits:1,execute:async()=>{effects++;return{done:true};}}],limits,modelRecovery:{extraAttempts:1}});await runtime.waitForIdle('invalid-context-usage');
 assert.equal(result.status==='failed'&&result.reason,'INVALID_OUTPUT');assert.equal(calls,2);assert.equal(summaries,0);assert.equal(effects,1);assert.equal(result.modelOutcome?.category,'invalid-output');assert.equal(result.usage.inputTokens,6);assert.equal(result.usage.reservedOutputTokens,16);
});
