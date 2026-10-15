import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime, admitModelRequest, ContextAdmissionFailure, ProviderFailure, createPiTransport, createSessionRuntime, createMemoryBudgetStore} from '../src/index.ts';
import type {RuntimeOptions,ModelConfig,ModelRequest,ModelReply} from '../src/index.ts';

const model:ModelConfig={provider:'synthetic',id:'context-200k',protocol:'openai-completions',endpoint:'https://synthetic.invalid/v1',contextWindow:200000,maxOutputTokens:4096};
const contextAdmission={policyVersion:'synthetic-final-001',protocolOverheadTokens:256,safetyMarginTokens:8192};
const limits={cumulative:'unlimited' as const,maxOutputTokens:4096,modelTimeoutMs:2000,toolTimeoutMs:2000,controlTimeoutMs:2000};

test('S1/F01/R1/V06: full system and prompt reject before physical request with fixed admission policy',async()=>{
  let physical=0,modelAuthorities=0;
  const options:RuntimeOptions & {contextAdmission:typeof contextAdmission}={model,contextAdmission,transport:async()=>{physical++;return{content:[{kind:'text',text:'MUST_NOT_SEND'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};},authorize:async action=>{if(action.kind==='model')modelAuthorities++;return true;},audit:{append:async()=>{}}};
  const result=await createRuntime(options).runText({taskId:'context-full',system:'s'.repeat(100000),prompt:'x'.repeat(750000),limits});
  assert.equal(physical,0,'unsafe complete request reached physical transport');
  assert.equal(modelAuthorities,0,'early guard should reject before model reservation/authority');
  assert.equal(result.status==='failed'&&result.reason,'INVALID_REQUEST');
  assert.equal(result.usage.modelCalls,0);
});

test('S1/R1/V06: admitted final projection remains immutable until physical dispatch',()=>{
  const request={model:{...model},messages:[{role:'system' as const,text:'synthetic',tools:[]}],maxOutputTokens:4096,signal:new AbortController().signal};
  const report=admitModelRequest(request,contextAdmission);
  assert.equal(report.model.id,model.id);
  assert.throws(()=>{request.messages[0]!.text='unapproved post-guard projection';},TypeError);
  assert.throws(()=>{request.maxOutputTokens=100000;},TypeError);
});

function requestFor(selected:ModelConfig,messages:ModelRequest['messages']):ModelRequest {
  return{model:selected,messages,maxOutputTokens:4096,signal:new AbortController().signal};
}
const complete:ModelReply={content:[{kind:'text',text:'synthetic complete'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};

test('S1/R1/V03-V06: actual Unicode, schemas, reasoning signatures, tool tail and output reserve count for each 200k/1M candidate',()=>{
  const messages:ModelRequest['messages']=[
    {role:'system',text:'trusted',tools:[{name:'inspect',description:'declared',parameters:{type:'object',description:'界'.repeat(65000)}}]},
    {role:'user',text:'synthetic'},
    {role:'assistant',text:'',blocks:[{kind:'reasoning',text:'synthetic thought',signature:'escaped\"\n'.repeat(500)}]},
    {role:'tool',text:JSON.stringify({bounded:false,tail:'retained\n'.repeat(1000)}),toolId:'done',toolName:'inspect'},
  ];
  assert.throws(()=>admitModelRequest(requestFor(model,messages),contextAdmission),error=>{
    assert.ok(error instanceof ContextAdmissionFailure);
    assert.equal(error.reason,'INVALID_REQUEST');assert.equal(error.admission.contextWindow,200000);
    assert.ok(error.admission.piEstimateTokens>16000);assert.ok(error.admission.requiredTokens>200000);
    assert.equal(JSON.stringify(error).includes('synthetic thought'),false);return true;
  });
  const report=admitModelRequest(requestFor({...model,id:'context-1m',contextWindow:1048576},messages),contextAdmission);
  assert.ok(report.requiredTokens>200000&&report.requiredTokens<1048576);
  assert.equal(report.reservedOutputTokens,4096);assert.equal(report.basis,'pi-estimate-with-byte-envelope');
});

test('S1/R1/C06/V06: host calls the actual guard after trusted schema projection and before ledger or real Pi SSE transport',async()=>{
  let physical=0,reservations=0,credentials=0;
  const http=createPiTransport({model,apiKey:'synthetic-placeholder',fetch:async()=>{physical++;throw new Error('must not dispatch');}});
  const runtime=createRuntime({model,contextAdmission,authorize:async()=>true,audit:{append:async()=>{}},transport:async initial=>{
    const final={...initial,messages:initial.messages.map(message=>message.role==='system'?{...message,tools:[{name:'inspect',description:'界'.repeat(900000),parameters:{type:'object'}}]}:message)};
    admitModelRequest(final,contextAdmission);
    reservations++;credentials++;return http(final);
  }});
  const result=await runtime.runText({taskId:'final-projection',prompt:'synthetic',system:'original small system',limits});
  assert.equal(result.status==='failed'&&result.reason,'INVALID_REQUEST');
  assert.equal(physical,0);assert.equal(reservations,0);assert.equal(credentials,0);
  assert.equal(result.usage.reservedOutputTokens,0,'final guard proves no physical dispatch; not a Provider UNKNOWN');
  assert.equal(result.usage.outputTokens,0);
});

test('S1/R4/V06-V09: admitted 1M primary failure cannot blindly dispatch identical history to a smaller fallback',async()=>{
  let primary=0,secondary=0;
  const runtime=createRuntime({model:{...model,id:'large-primary',contextWindow:1048576},contextAdmission,
    transport:async()=>{primary++;throw new ProviderFailure('quota');},
    fallbacks:[{model,transport:async()=>{secondary++;return complete;}}],authorize:async()=>true,audit:{append:async()=>{}}});
  const result=await runtime.runText({taskId:'smaller-fallback',prompt:'x'.repeat(250000),limits,modelRecovery:{extraAttempts:1}});
  assert.equal(result.status==='failed'&&result.reason,'INVALID_REQUEST');
  assert.equal(primary,1);assert.equal(secondary,0);assert.equal(result.usage.modelCalls,1);
  assert.equal(result.usage.reservedOutputTokens,4096,'original physical unknown reservation remains');
});

test('S1/R1-R4/V06: final candidate thinking/image capabilities and verified image allowance are mandatory',()=>{
  const image={data:'eA==',mimeType:'image/png' as const};
  assert.throws(()=>admitModelRequest(requestFor(model,[{role:'user',text:'synthetic',images:[image]}]),contextAdmission),{reason:'CAPABILITY_UNAVAILABLE'});
  const visual={...model,input:['text','image'] as const};
  assert.throws(()=>admitModelRequest(requestFor(visual,[{role:'user',text:'synthetic',images:[image]}]),contextAdmission),{reason:'CAPABILITY_UNAVAILABLE'});
  const report=admitModelRequest(requestFor(visual,[{role:'user',text:'synthetic',images:[image]}]),{...contextAdmission,imageTokens:8192});
  assert.equal(report.imageTokens,8192);assert.ok(report.budgetedInputTokens>=8192);
  assert.throws(()=>admitModelRequest({...requestFor(model,[{role:'user',text:'synthetic'}]),thinkingLevel:'high'},contextAdmission),{reason:'INVALID_REQUEST'});
  const thinking=admitModelRequest({...requestFor({...model,reasoning:true},[{role:'user',text:'synthetic'}]),thinkingLevel:'high'},contextAdmission);
  assert.equal(thinking.reservedOutputTokens,4096);
  const controller=new AbortController();controller.abort();
  assert.throws(()=>admitModelRequest({...requestFor(model,[]),signal:controller.signal},contextAdmission),{reason:'CANCELLED'});
});

test('S1/R1/V14: admission policy is pinned to the same Task without rewriting legacy configuration',async()=>{
  const budgets=createMemoryBudgetStore();
  const options={model,contextAdmission,budgets,transport:async()=>complete,authorize:async()=>true,audit:{append:async()=>{}}};
  const request={taskId:'pinned-admission',prompt:'synthetic',limits};
  assert.equal((await createRuntime(options).runText(request)).status,'succeeded');
  const result=await createRuntime({...options,contextAdmission:{...contextAdmission,policyVersion:'changed'}}).runText(request);
  assert.equal(result.status!=='succeeded'&&result.reason,'CONFIGURATION_CHANGED');
});

test('S1/F03/R1/V07-V10: native giant tail rejects safely while a bounded manual summary remains admitted and metered',async()=>{
  const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'r1-final-tail-'));
  let physical=0,effects=0,unsafe=0;
  const runtime=createSessionRuntime({model,contextAdmission,budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=>'ready',
    harness:{compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:8192},retry:{enabled:false,maxRetries:0,baseDelayMs:1}},
    storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
    transport:async request=>{physical++;if(request.messages.some(message=>message.role==='tool'&&message.text.length>800000))unsafe++;
      return physical===1?{content:[{kind:'tool',id:'completed',name:'large',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}}:complete;}});
  const session=await runtime.create();
  const common={sessionId:session.id,taskId:'giant-current-tool',tools:[{name:'large',description:'synthetic',parameters:{type:'object'},effect:'read' as const,resourceUnits:1,execute:async()=>{effects++;return{full:'x'.repeat(900000)};}}],limits,modelRecovery:{extraAttempts:1 as const}};
  const first=await runtime.run({...common,prompt:'synthetic'});await runtime.waitForIdle(common.taskId);
  assert.notEqual(first.status,'succeeded');assert.equal(effects,1);assert.equal(unsafe,0);
  assert.equal(first.usage.toolCalls,1);assert.equal(first.usage.modelCalls,physical);
  assert.ok((await runtime.history(session.id)).some(entry=>entry.message?.role==='tool'&&entry.message.text.length>800000));
  const before=physical;const compact=await runtime.run({...common,prompt:'',operation:'compact'});await runtime.waitForIdle(common.taskId);
  // Pi serializes a bounded summary input; compaction itself may safely complete.
  assert.equal(compact.status,'succeeded');assert.equal(effects,1);assert.equal(physical,before+1);assert.equal(unsafe,0);
  assert.equal(compact.usage.modelCalls,physical);
  assert.ok((await runtime.history(session.id)).some(entry=>entry.kind==='compaction'));
});

test('S1/R1/V06: non-data request or candidate instances cannot bypass admitted projection immutability',()=>{
  const inherited=Object.assign(Object.create({host:'synthetic'}),requestFor(model,[{role:'user',text:'synthetic'}])) as ModelRequest;
  assert.throws(()=>admitModelRequest(inherited,contextAdmission),{reason:'INVALID_REQUEST'});
  const candidate=Object.assign(Object.create({host:'synthetic'}),model) as ModelConfig;
  assert.throws(()=>admitModelRequest(requestFor(candidate,[{role:'user',text:'synthetic'}]),contextAdmission),{reason:'INVALID_REQUEST'});
});

test('S1/R1/C06-C07/V06-V08: approved final schema reaches real Pi codec unchanged with known nonzero usage',async()=>{
  let physical=0;let payload:any;
  const http=createPiTransport({model,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    physical++;payload=JSON.parse(String(init?.body));
    return new Response([
      {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'approved'},finish_reason:null}]},
      {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}},
    ].map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const runtime=createRuntime({model,contextAdmission,authorize:async()=>true,audit:{append:async()=>{}},transport:async request=>{
    const final={...request,messages:request.messages.map(message=>message.role==='system'?{...message,tools:[{name:'inspect',description:'approved host schema',parameters:{type:'object',properties:{selection:{type:'string',enum:['approved']}}}}]}:message)};
    const admitted=admitModelRequest(final,contextAdmission);assert.ok(admitted.requiredTokens<200000);return http(final);
  }});
  const result=await runtime.runText({taskId:'approved-final-codec',system:'trusted synthetic system',prompt:'synthetic',limits});
  assert.equal(result.status,'succeeded');assert.equal(physical,1);
  assert.equal(payload.tools[0].function.description,'approved host schema');
  assert.deepEqual(payload.tools[0].function.parameters.properties.selection.enum,['approved']);
  assert.equal(result.usage.inputTokens,5);assert.equal(result.usage.outputTokens,3);assert.equal(result.usage.reservedOutputTokens,0);
});

test('S1/R1/V06: final projection rejects accessors before invocation, avoiding mutable frozen payload',()=>{
 let accesses=0;const message:any={role:'user'};Object.defineProperty(message,'text',{enumerable:true,get(){accesses++;return'small';}});
 assert.throws(()=>admitModelRequest(requestFor(model,[message]),contextAdmission),{reason:'INVALID_REQUEST'});assert.equal(accesses,0);
 const candidate:any={...model};Object.defineProperty(candidate,'contextWindow',{enumerable:true,get(){accesses++;return 200000;}});
 assert.throws(()=>admitModelRequest(requestFor(candidate,[{role:'user',text:'synthetic'}]),contextAdmission),{reason:'INVALID_REQUEST'});assert.equal(accesses,0);
});
