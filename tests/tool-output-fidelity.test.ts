import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionRuntime,createMemoryBudgetStore} from '../src/index.ts';
import type {ModelConfig,Tool,ModelRequest} from '../src/index.ts';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const model:ModelConfig={provider:'synthetic',id:'effects',protocol:'openai-completions',endpoint:'https://synthetic.invalid/v1',contextWindow:200000,maxOutputTokens:16};
const limits={cumulative:'unlimited' as const,maxOutputTokens:16,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000};
const complete={content:[{kind:'text' as const,text:'complete'}],stop:'complete' as const,usage:{inputTokens:3,outputTokens:1}};
function observed(reply:any){return{...reply,outcome:{model:{provider:model.provider,id:model.id,protocol:model.protocol},stop:reply.stop,physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:reply.usage.inputTokens},outputTokens:{kind:'known',value:reply.usage.outputTokens}},diagnostic:'COMPLETE'}};}
async function host(tool:Tool, transport?:any,audit?:any) {
 const root=await mkdtemp(join(tmpdir(),'r3-output-'));let physical=0;let projected='';
 const runtime=createSessionRuntime({model,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:audit??{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=>'ready',
  storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
  transport:async request=>observed(await (transport??(async (request:ModelRequest)=>{physical++;if(physical===1)return{content:[{kind:'tool',id:'once',name:tool.name,arguments:{}}],stop:'tools',usage:{inputTokens:3,outputTokens:1}};projected=request.messages.findLast(m=>m.role==='tool')?.text??'';return complete;}))(request))});
 const session=await runtime.create();const request={sessionId:session.id,taskId:'effect-fidelity',prompt:'synthetic',tools:[tool],limits,modelRecovery:{extraAttempts:1 as const}};
 return{root,runtime,request,getPhysical:()=>physical,getProjected:()=>projected};
}
test('S3/F04/R3/V10-V15: full tool effect/result stays local while native Session receives a bounded result and readable reference',async()=>{
 let effects=0;const retained=await mkdtemp(join(tmpdir(),'r3-full-result-'));
 const tool:Tool & {modelOutput:any}={name:'compute',description:'synthetic',parameters:{type:'object'},effect:'write',resourceUnits:7,replay:'never',
  execute:async()=>{effects++;return{full:'界'.repeat(400000)};},
  modelOutput:{policyVersion:'synthetic-output-v1',maxBytes:256,project:async({value}:any)=>{await writeFile(join(retained,'complete.json'),JSON.stringify(value));await writeFile(join(retained,'view.txt'),'synthetic authorized result');return{receiptId:'receipt-001',value:{status:'stored',read:{path:'view.txt',offset:1,limit:20}}};}}};
 const h=await host(tool);const result=await h.runtime.run(h.request);await h.runtime.waitForIdle(h.request.taskId);
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(effects,1);assert.equal(h.getPhysical(),2);
 assert.ok((await readFile(join(retained,'complete.json'))).byteLength>1048576);
 assert.ok(Buffer.byteLength(h.getProjected())<=256);assert.equal(JSON.parse(h.getProjected()).read.path,'view.txt');
 assert.equal((result as any).toolOutcomes?.[0]?.status,'completed');assert.equal((result as any).toolOutcomes?.[0].receiptId,'receipt-001');
 assert.equal(result.usage.toolCalls,1);assert.equal(result.usage.resourceUnits,9);
});

test('S3/R3/V10-V15: post-execution projected overflow preserves completed receipt and usage, fails closed and cannot resume replay',async()=>{
 let effects=0;const events:any[]=[];
 const tool:Tool={name:'overflow',description:'synthetic',effect:'write',resourceUnits:4,parameters:{type:'object'},replay:'never',
  execute:async()=>{effects++;return{executed:true};},modelOutput:{policyVersion:'bounded-v1',maxBytes:64,project:async()=>({receiptId:'stored-001',value:{oversized:'x'.repeat(1000)}})}};
 const h=await host(tool,undefined,{append:async(event:any)=>{events.push(event);}});
 const result=await h.runtime.run(h.request);await h.runtime.waitForIdle(h.request.taskId);
 assert.equal(result.status==='failed'&&result.reason,'TOOL_FAILED');assert.equal(effects,1);assert.equal(h.getPhysical(),1);
 assert.equal(result.toolOutcomes?.[0]?.status,'completed');assert.equal(result.toolOutcomes?.[0]?.modelOutput,'rejected');assert.equal(result.toolOutcomes?.[0]?.receiptId,'stored-001');
 assert.equal(result.usage.toolCalls,1);assert.equal(result.usage.resourceUnits,5);assert.equal(result.usage.inputTokens,3);assert.equal(result.usage.outputTokens,1);
 assert.equal(events.filter(e=>e.kind==='tool.finished').length,1);assert.equal(events.find(e=>e.kind==='tool.finished').toolOutcome.status,'completed');
 const resumed=await h.runtime.run({...h.request,prompt:'',operation:'resume'});await h.runtime.waitForIdle(h.request.taskId);
 assert.notEqual(resumed.status,'succeeded');assert.equal(effects,1);assert.equal(h.getPhysical(),1);
 assert.ok((await h.runtime.history(h.request.sessionId)).some(entry=>entry.message?.role==='tool'));
});

test('S3/R3/V10-V11: projection save failure and later model/audit failures preserve the executed tool without soft success',async()=>{
 for(const failure of ['save','model','audit'] as const) {
  let effects=0,physical=0;const events:any[]=[];
  const tool:Tool={name:'effect',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object'},
   execute:async()=>{effects++;return{executed:true};},modelOutput:{policyVersion:'bounded-v1',maxBytes:64,project:async()=>{if(failure==='save'){const {RuntimeFault}=await import('../src/index.ts');throw new RuntimeFault('STATE_FAILED');}return{receiptId:'stored-001',value:{stored:true}};}}};
  const h=await host(tool,async()=>{physical++;if(physical===1)return{content:[{kind:'tool',id:'one',name:'effect',arguments:{}}],stop:'tools',usage:{inputTokens:3,outputTokens:1}};throw new Error('SYNTHETIC_PRIVATE_MODEL_FAILURE');},
   {append:async(event:any)=>{events.push(event);if(failure==='audit'&&event.kind==='tool.finished')throw new Error('SYNTHETIC_PRIVATE_AUDIT_FAILURE');}});
  const result=await h.runtime.run(h.request);await h.runtime.waitForIdle(h.request.taskId);
  assert.notEqual(result.status,'succeeded');assert.equal(effects,1);assert.equal(result.toolOutcomes?.[0]?.status,'completed');assert.equal(result.usage.toolCalls,1);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);
  if(failure==='save')assert.equal(result.status==='failed'&&result.reason,'STATE_FAILED');
  if(failure==='audit')assert.equal(result.status==='failed'&&result.reason,'AUDIT_FAILED');
 }
});

test('S3/R3/V10-V15: invalid host receipt metadata cannot escape guarded RunResult or leak while completion remains known',async()=>{
 const tool:Tool={name:'bad-receipt',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object'},execute:async()=>({executed:true}),
  modelOutput:{policyVersion:'bad-receipt-v1',maxBytes:256,project:async()=>({receiptId:'SYNTHETIC_PRIVATE/receipt',value:{stored:true}})}};
 const h=await host(tool);let result:any;
 await assert.doesNotReject(async()=>{result=await h.runtime.run(h.request);});await h.runtime.waitForIdle(h.request.taskId);
 assert.equal(result.status,'failed');assert.equal(result.toolOutcomes[0]?.status,'completed');assert.equal(result.toolOutcomes[0].receiptId,undefined);
 assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);assert.equal(h.getPhysical(),1);
});

test('S3/R3/V10: late tool completion after cancellation appends facts without changing returned UNKNOWN or replaying',async()=>{
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),pending=new Promise<void>(r=>release=r);const events:any[]=[];let effects=0;
 const tool:Tool={name:'late-effect',description:'synthetic',effect:'write',parameters:{type:'object'},resourceUnits:2,execute:async()=>{entered();await pending;effects++;return{completed:true};}};
 const h=await host(tool,undefined,{append:async(e:any)=>{events.push(e);}});const abort=new AbortController();
 const running=h.runtime.run({...h.request,signal:abort.signal});await ready;abort.abort();const result=await running;
 assert.equal(result.status,'cancelled');assert.equal(result.toolOutcomes?.[0]?.status,'unknown');release();await h.runtime.waitForIdle(h.request.taskId);
 assert.equal(effects,1);assert.equal(h.getPhysical(),1);assert.equal(result.toolOutcomes?.[0]?.status,'unknown');
 assert.equal(events.find(e=>e.kind==='tool.finished')?.toolOutcome?.status,'completed');
});

test('S3/R3/V10: explicit host post-effect failure carries completed receipt without inferring failure as non-execution',async()=>{
 const {ToolOutputFailure}=await import('../src/index.ts');
 const tool:Tool={name:'host-effect',description:'synthetic',effect:'write',parameters:{type:'object'},resourceUnits:2,
 execute:async(_args,_signal,invocation)=>{throw new ToolOutputFailure({name:'host-effect',effect:'write',status:'completed',modelOutput:'failed',receiptId:'durable-effect-001',resourceUnits:2,...(invocation?{invocation}:{})},'STATE_FAILED');}};
 const h=await host(tool);const result=await h.runtime.run(h.request);await h.runtime.waitForIdle(h.request.taskId);
 assert.equal(result.status==='failed'&&result.reason,'STATE_FAILED');assert.equal(result.toolOutcomes?.[0]?.status,'completed');assert.equal(result.toolOutcomes?.[0].receiptId,'durable-effect-001');assert.equal(h.getPhysical(),1);
});

test('S3/R3/V10: projection failure can retain an explicit durable receipt with matching invocation',async()=>{
 const {ToolOutputFailure}=await import('../src/index.ts');
 const tool:Tool={name:'project-receipt',description:'synthetic',effect:'write',resourceUnits:2,parameters:{type:'object'},execute:async()=>({done:true}),
 modelOutput:{policyVersion:'failed-save-v1',maxBytes:64,project:async({invocation})=>{throw new ToolOutputFailure({name:'project-receipt',effect:'write',status:'completed',modelOutput:'failed',resourceUnits:2,receiptId:'durable-project-001',...(invocation?{invocation}:{})},'STATE_FAILED');}}};
 const h=await host(tool);const result=await h.runtime.run(h.request);await h.runtime.waitForIdle(h.request.taskId);
 assert.equal(result.status==='failed'&&result.reason,'STATE_FAILED');assert.equal(result.toolOutcomes?.[0]?.receiptId,'durable-project-001');assert.equal(h.getPhysical(),1);
});

test('S3/R3/V14: old checkpoint without native invocation retains explicit post-effect failure receipt',async()=>{
 const {createRuntime,ToolOutputFailure}=await import('../src/index.ts');const events:any[]=[];
 const tool:Tool={name:'legacy-effect',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object'},execute:async()=>{throw new ToolOutputFailure({name:'legacy-effect',effect:'write',status:'completed',modelOutput:'failed',resourceUnits:1,receiptId:'legacy-receipt-001'},'STATE_FAILED');}};
 const rt=createRuntime({model,modelObservations:'v1',budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async e=>{events.push(e);}},transport:async()=>observed({content:[{kind:'tool',id:'old',name:tool.name,arguments:{}}],stop:'tools',usage:{inputTokens:3,outputTokens:1}})});
 const result=await rt.runAgent({taskId:'old-effect',prompt:'synthetic',limits,tools:[tool],saveCheckpoint:async()=>{}});await rt.waitForIdle('old-effect');
 assert.equal(result.status==='failed'&&result.reason,'STATE_FAILED');assert.equal(result.toolOutcomes?.[0]?.receiptId,'legacy-receipt-001');assert.equal(events.find(e=>e.kind==='tool.finished')?.toolOutcome.receiptId,'legacy-receipt-001');
});

test('S3/R3/V10: UNKNOWN save acknowledgement cannot erase already confirmed execution completion',async()=>{
 const {ToolOutputFailure}=await import('../src/index.ts');
 const tool:Tool={name:'monotonic',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object'},execute:async()=>({executed:true}),modelOutput:{policyVersion:'unknown-save-v1',maxBytes:64,project:async({invocation})=>{throw new ToolOutputFailure({name:'monotonic',effect:'write',status:'unknown',modelOutput:'failed',resourceUnits:1,receiptId:'unknown-save-001',...(invocation?{invocation}:{})},'STATE_FAILED');}}};
 const h=await host(tool);const result=await h.runtime.run(h.request);await h.runtime.waitForIdle(h.request.taskId);
 assert.equal(result.status==='failed'&&result.reason,'STATE_FAILED');assert.equal(result.toolOutcomes?.[0]?.status,'completed');assert.equal(result.toolOutcomes?.[0]?.receiptId,'unknown-save-001');
});
