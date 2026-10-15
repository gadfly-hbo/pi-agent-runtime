import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createExecutionTools, createSessionRuntime, createMemoryBudgetStore, RuntimeFault, ExecutionLimitFailure, ToolOutputFailure, createPiTransport, createLocalExecutionEnvironment} from '../src/index.ts';
import type {AuditEvent, ExecutionEnvironment, ModelConfig, Tool, ToolFailureCategory} from '../src/index.ts';

const model:ModelConfig={provider:'synthetic',id:'read-carrier',protocol:'openai-completions',endpoint:'https://offline.invalid',contextWindow:200000,maxOutputTokens:64};
const limits={cumulative:'unlimited' as const,maxOutputTokens:64,modelTimeoutMs:2000,toolTimeoutMs:2000,controlTimeoutMs:2000};
async function failedRead(error:unknown, options:{tool?:Tool; observe?:boolean; auditFailure?:boolean; codec?:boolean; delayMs?:number; cancel?:boolean; toolTimeoutMs?:number}={}) {
 const controller=new AbortController();
 const directory=await mkdtemp(join(tmpdir(),'read-carrier-'));let calls=0,reads=0;const audit:AuditEvent[]=[];
 const host:ExecutionEnvironment={cwd:directory,policyVersion:'read-test',resolvePath:async p=>join(directory,p),read:async()=>{reads++;if(options.cancel)setTimeout(()=>controller.abort(),5);if(options.delayMs)await new Promise(r=>setTimeout(r,options.delayMs));throw error;},stat:async()=>({path:'synthetic',name:'synthetic',kind:'file',size:1,modifiedAt:0}),write:async()=>assert.fail('WRITE_FORBIDDEN'),exec:async()=>assert.fail('EXEC_FORBIDDEN')};
 const tools=options.tool?[options.tool]:createExecutionTools(host,['read']);
 const runtime=createSessionRuntime({model,...(options.observe===false?{}:{modelObservations:'v1' as const}),budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async e=>{audit.push(e);if(options.auditFailure&&e.kind==='tool.finished')throw new Error('SYNTHETIC_PRIVATE_AUDIT');}},bindOperation:async()=>{},reconcile:async()=>'ready',
 storage:{cwd:directory,directory:join(directory,'sessions'),policyVersion:'read-test',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
 transport:options.codec?createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async()=>{calls++;return new Response('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:model.id,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'read-once',type:'function',function:{name:tools[0]!.name,arguments:'{"path":"synthetic"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}}):async()=>{calls++;assert.equal(calls,1,'failed read must not trigger another model request');return{content:[{kind:'tool',id:'read-once',name:tools[0]!.name,arguments:{path:'synthetic'}}],stop:'tools',usage:{inputTokens:7,outputTokens:3},outcome:{model,stop:'tools',physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:7},outputTokens:{kind:'known',value:3}},diagnostic:'COMPLETE'}};}});
 const session=await runtime.create();const request={sessionId:session.id,taskId:'read-failure',prompt:'synthetic',tools,signal:controller.signal,limits:{...limits,...(options.toolTimeoutMs?{toolTimeoutMs:options.toolTimeoutMs}:{})},modelRecovery:{extraAttempts:1 as const}};
 const result=await runtime.run(request);await runtime.waitForIdle(request.taskId);
 return{result,audit,runtime,request,calls,reads};
}
test('S3/F10/V12-V17: native missing read retains safe category through public persistent Session and audit',async()=>{
 const h=await failedRead(Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'ENOENT'}));
 assert.equal(h.result.status==='failed'&&h.result.reason,'TOOL_FAILED');
 assert.equal(h.result.toolOutcomes?.[0]?.failureCategory,'not_found');
 assert.equal(h.audit.find(e=>e.kind==='tool.finished')?.toolOutcome?.failureCategory,'not_found');
 assert.deepEqual(h.result.toolOutcomes?.[0]?.invocation,h.audit.find(e=>e.kind==='tool.admitted')?.invocation);
 assert.equal(h.result.toolOutcomes?.[0]?.status,'unknown');assert.equal(h.result.toolOutcomes?.[0]?.effect,'read');
 assert.equal(h.calls,1);assert.equal(h.reads,1);assert.equal(h.result.usage.inputTokens,7);assert.equal(h.result.usage.outputTokens,3);assert.equal(h.result.usage.resourceUnits,2);
 assert.ok(!JSON.stringify({result:h.result,audit:h.audit}).includes('SYNTHETIC_PRIVATE_DETAIL'));
 const resumed=await h.runtime.run({...h.request,prompt:'',operation:'resume'});await h.runtime.waitForIdle(h.request.taskId);assert.notEqual(resumed.status,'succeeded');
});

for(const [name,error,expected] of [
 ['permission',Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'EACCES'}),'permission_denied'],
 ['unsupported',Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'ENOTSUP'}),'not_supported'],
 ['cancelled',Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'ECANCELED'}),'cancelled'],
 ['runtime-cancelled',new RuntimeFault('CANCELLED'),'cancelled'],
 ['host-timeout',Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'ETIMEDOUT'}),'timeout'],
 ['timeout',new RuntimeFault('DEADLINE_EXCEEDED'),'timeout'],
 ['limit',new ExecutionLimitFailure(),'limit_exceeded'],
 ['unclassified',Object.assign(new Error('ENOENT permission_denied timeout SYNTHETIC_PRIVATE_DETAIL'),{code:'OTHER'}),'unknown'],
 ['not-directory',Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'ENOTDIR'}),'not_directory'],
 ['is-directory',Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'EISDIR'}),'is_directory'],
 ['invalid',Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'EINVAL'}),'invalid'],
] as const) test(`S3/V12-V17: ${name} category survives native Session without text inference or replay`,async()=>{
 const h=await failedRead(error);
 assert.equal(h.result.toolOutcomes?.[0]?.failureCategory,expected);
 assert.equal(h.audit.find(e=>e.kind==='tool.finished')?.toolOutcome?.failureCategory,expected);
 assert.equal(h.result.toolOutcomes?.[0]?.status,'unknown');assert.equal(h.result.toolOutcomes?.[0]?.modelOutput,'failed');
 assert.equal(h.result.status==='succeeded'?undefined:h.result.reason,expected==='limit_exceeded'?'BUDGET_EXHAUSTED':'TOOL_FAILED');
 assert.equal(h.calls,1);assert.equal(h.reads,1);assert.equal(h.result.usage.inputTokens,7);assert.equal(h.result.usage.outputTokens,3);assert.equal(h.result.usage.resourceUnits,2);
 assert.equal(h.result.modelOutcome?.usageFinal,true);assert.equal(h.result.modelOutcome?.physicalStatus,'response-received');
 assert.ok(!JSON.stringify({result:h.result,audit:h.audit}).includes('SYNTHETIC_PRIVATE_DETAIL'));
});

test('S3/V12: real Pi SSE codec tool request retains read carrier and known usage',async()=>{
 const h=await failedRead(Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'ENOENT'}),{codec:true});
 assert.equal(h.result.toolOutcomes?.[0]?.failureCategory,'not_found');assert.equal(h.calls,1);assert.equal(h.reads,1);assert.equal(h.result.usage.inputTokens,7);assert.equal(h.result.usage.outputTokens,3);
});

test('S3/V14: omission of observation policies preserves legacy public shape',async()=>{
 const h=await failedRead(Object.assign(new Error('synthetic'),{code:'ENOENT'}),{observe:false});
 assert.equal(h.result.status==='failed'&&h.result.reason,'TOOL_FAILED');assert.equal(h.result.toolOutcomes,undefined);assert.equal(h.result.modelOutcome,undefined);
 assert.ok(h.audit.every(e=>e.toolOutcome===undefined));
});

test('S3/V10-V12: safe category is validated and explicit completed receipt retains matching invocation',async()=>{
 const base={name:'read',effect:'read' as const,status:'completed' as const,modelOutput:'failed' as const,resourceUnits:1,receiptId:'receipt-001'};
 assert.throws(()=>new ToolOutputFailure({...base,failureCategory:'SYNTHETIC_PRIVATE_DETAIL' as ToolFailureCategory}),{reason:'INVALID_OUTPUT'});
 const tool:Tool={name:'read',effect:'read',description:'synthetic',parameters:{type:'object'},resourceUnits:1,execute:async(_args,_signal,invocation)=>{throw new ToolOutputFailure({...base,...(invocation?{invocation}:{}),failureCategory:'permission_denied',...{unsafe:'SYNTHETIC_PRIVATE_DETAIL'}});}};
 const h=await failedRead(undefined,{tool});assert.equal(h.result.toolOutcomes?.[0]?.failureCategory,'permission_denied');assert.equal(h.result.toolOutcomes?.[0]?.status,'completed');assert.equal(h.result.toolOutcomes?.[0]?.receiptId,'receipt-001');assert.equal(h.calls,1);
 assert.deepEqual(h.result.toolOutcomes?.[0]?.invocation,h.audit.find(e=>e.kind==='tool.admitted')?.invocation);
 assert.ok(!JSON.stringify({result:h.result,audit:h.audit}).includes('SYNTHETIC_PRIVATE_DETAIL'));
});

test('S3/V10-V12: forged or mismatched carriers cannot claim a category or completion',async()=>{
 for(const mode of ['plain','invocation','name','effect','resource'] as const){
 const tool:Tool={name:'read',effect:'read',description:'synthetic',parameters:{type:'object'},resourceUnits:1,execute:async(_args,_signal,invocation)=>{
  if(mode==='plain')throw Object.assign(new Error('not_found'),{code:'not_found',failureCategory:'not_found',outcome:{status:'completed'}});
  throw new ToolOutputFailure({name:mode==='name'?'other':'read',effect:mode==='effect'?'write':'read',status:'completed',modelOutput:'failed',resourceUnits:mode==='resource'?3:1,failureCategory:'not_found',receiptId:'wrong-receipt',...(invocation?{invocation:{...invocation,invocationId:mode==='invocation'?'other':invocation.invocationId}}:{})});}};
 const h=await failedRead(undefined,{tool});assert.equal(h.result.toolOutcomes?.[0]?.failureCategory,undefined);assert.equal(h.result.toolOutcomes?.[0]?.status,'unknown');assert.equal(h.result.toolOutcomes?.[0]?.receiptId,undefined);assert.equal(h.calls,1);
 }
});

test('S3/V11: audit write failure stays failed with original safe category and known consumption',async()=>{
 const h=await failedRead(Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'),{code:'EACCES'}),{auditFailure:true});
 assert.equal(h.result.status==='failed'&&h.result.reason,'AUDIT_FAILED');assert.equal(h.result.toolOutcomes?.[0]?.failureCategory,'permission_denied');assert.equal(h.result.toolOutcomes?.[0]?.status,'unknown');assert.equal(h.result.usage.outputTokens,3);assert.equal(h.calls,1);
});

for(const mode of ['cancel','timeout'] as const)test(`S3/V13: ${mode} returns frozen UNKNOWN then retains a separate late native read failure`,async()=>{
 const h=await failedRead(new RuntimeFault(mode==='cancel'?'CANCELLED':'DEADLINE_EXCEEDED'),{delayMs:80,...(mode==='cancel'?{cancel:true}:{toolTimeoutMs:5})});
 assert.equal(h.result.status==='succeeded'?undefined:h.result.reason,mode==='cancel'?'CANCELLED':'DEADLINE_EXCEEDED');
 const original=h.result.toolOutcomes?.[0];assert.equal(original?.status,'unknown');assert.equal(original?.modelOutput,'pending');assert.equal(original?.failureCategory,undefined);
 const late=h.audit.find(e=>e.kind==='tool.finished')?.toolOutcome;assert.equal(late?.failureCategory,mode==='cancel'?'cancelled':'timeout');assert.equal(late?.status,'unknown');assert.equal(late?.modelOutput,'failed');assert.deepEqual(original?.invocation,late?.invocation);
 assert.equal(h.calls,1);assert.equal(h.reads,1);assert.equal(h.result.usage.inputTokens,7);assert.equal(h.result.usage.outputTokens,3);assert.equal(h.result.usage.toolCalls,1);
});

test('S3/V17: native truncation and continuation are successful read content, distinct from host file limit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'read-pages-'));const text=Array.from({length:2100},(_,i)=>`line-${i+1}`).join('\n');await writeFile(join(root,'pages.txt'),text);await writeFile(join(root,'long.txt'),'界'.repeat(20000));
 const env=await createLocalExecutionEnvironment({root,policyVersion:'pages-test',exclusiveWorkspace:true,maxFileBytes:100000,maxOutputBytes:1000,timeoutMs:2000});const [read]=createExecutionTools(env,['read']);const signal=new AbortController().signal;
 const first=await read!.execute({path:'pages.txt'},signal) as any;assert.equal(first.details.truncation.truncated,true);assert.match(first.content[0].text,/offset=2001/);
 const next=await read!.execute({path:'pages.txt',offset:2001,limit:100},signal) as any;assert.match(next.content[0].text,/line-2100/);assert.doesNotMatch(next.content[0].text,/more lines/);
 const long=await read!.execute({path:'long.txt'},signal) as any;assert.equal(long.details.truncation.firstLineExceedsLimit,true);assert.equal(long.details.truncation.truncated,true);
 const limited=await createLocalExecutionEnvironment({root,policyVersion:'small-host-test',exclusiveWorkspace:true,maxFileBytes:10,maxOutputBytes:1000,timeoutMs:2000});await assert.rejects(createExecutionTools(limited,['read'])[0]!.execute({path:'pages.txt'},signal),{code:'limit_exceeded',reason:'BUDGET_EXHAUSTED'});
});

test('S3/V13: explicit RuntimeFault cancellation wins over conflicting incidental errno',async()=>{
 const h=await failedRead(Object.assign(new RuntimeFault('CANCELLED'),{code:'ETIMEDOUT'}));
 assert.equal(h.result.toolOutcomes?.[0]?.failureCategory,'cancelled');
});
