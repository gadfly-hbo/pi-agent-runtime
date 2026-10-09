import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemoryBudgetStore, createSessionRuntime} from '../src/index.ts';
import type {SessionRuntimeOptions} from '../src/index.ts';
export async function fixture(t: test.TestContext) {
 const root = await mkdtemp(join(tmpdir(), 'harness-full-')); t.after(() => rm(root, {force:true, recursive:true}));
 const options: SessionRuntimeOptions = {model:{provider:'synthetic',id:'full',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:8192},
 transport:async()=>({content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}}),
 budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=> 'ready',
 storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'test',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})}};
 const request = {taskId:'task',prompt:'start',tools:[],limits:{modelCalls:20,toolCalls:10,outputTokens:1000,wallTimeMs:10000}};
 return {root,options,request};
}
test('HC01 native queues consume steering and follow-up; cancelled nextRun never reaches a model', async t => {
 const {options,request}=await fixture(t); let begin!:()=>void, finish!:()=>void,calls=0;
 const started=new Promise<void>(r=>begin=r),pending=new Promise<void>(r=>finish=r); const seen:string[]=[];
 options.transport=async r=>{calls++;seen.push(r.messages.map(m=>m.text).join('\n'));if(calls===1){begin();await pending;}return {content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const events:string[]=[];options.onHarnessEvent=e=>{events.push(e.kind);throw Error('observer not a gate');};
 const runtime=createSessionRuntime(options),session=await runtime.create();
 const run=runtime.run({...request,sessionId:session.id});await started;
 const control=(command:Parameters<typeof runtime.control>[0]['command'])=>runtime.control({taskId:request.taskId,sessionId:session.id,command});
 await control({kind:'steer',text:'STEER-42'});await control({kind:'followUp',text:'FOLLOW-19'});
 const queued=await control({kind:'nextRun',text:'NEVER-CONSUME'});
 assert.equal((await control({kind:'cancelQueued',entryId:queued.entryId!})).cancelled,true);
 const snapshot=await control({kind:'snapshot'});assert.equal(snapshot.snapshot?.queued.length,2);
 finish();assert.equal((await run).status,'succeeded');
 assert.ok(seen.some(s=>s.includes('STEER-42')));assert.ok(seen.some(s=>s.includes('FOLLOW-19')));assert.ok(seen.every(s=>!s.includes('NEVER-CONSUME')));
 assert.ok(events.includes('run_end'));assert.equal(calls,3);
});
test('HC02 control authorization cannot be bypassed by another task; abort is persisted natively',async t=>{
 const {options,request}=await fixture(t);let begin!:()=>void;
 const started=new Promise<void>(r=>begin=r);
 options.transport=async r=>{begin();await new Promise<void>(resolve=>r.signal.addEventListener('abort',()=>resolve(),{once:true}));return {content:[{kind:'text',text:'late'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();const run=runtime.run({...request,sessionId:session.id});await started;
 await assert.rejects(runtime.control({taskId:'foreign',sessionId:session.id,command:{kind:'steer',text:'bad'}}),/AUTHORITY_REQUIRED/);
 await runtime.control({taskId:request.taskId,sessionId:session.id,command:{kind:'abort'}});
 assert.equal((await run).status,'cancelled');
});

test('HC03 persistent nextRun belongs to its task and purpose after reopening, then consumes exactly once',async t=>{
 const {options,request}=await fixture(t);let begin!:()=>void,finish!:()=>void,calls=0;
 const started=new Promise<void>(r=>begin=r),pending=new Promise<void>(r=>finish=r);const seen:string[]=[];
 options.transport=async r=>{seen.push(r.messages.map(m=>m.text).join('\n'));if(++calls===1){begin();await pending;}return{content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 options.purposes=['original','other'].map(id=>({id,mode:'agent' as const,model:options.model,transport:options.transport}));
 const base={...request,purpose:'original'};
 const runtime=createSessionRuntime(options),session=await runtime.create();const run=runtime.run({...base,sessionId:session.id});await started;
 await runtime.control({taskId:request.taskId,sessionId:session.id,command:{kind:'nextRun',text:'OWNED-QUEUE-57'}});finish();assert.equal((await run).status,'succeeded');
 const reopened=createSessionRuntime(options);
 for(const change of [{taskId:'foreign'},{purpose:'other'}]){
  const result=await reopened.run({...base,...change,sessionId:session.id});assert.equal(result.status!=='succeeded'&&result.reason,'AUTHORITY_REQUIRED');assert.equal(calls,1);
 }
 assert.equal((await reopened.run({...base,sessionId:session.id})).status,'succeeded');assert.equal(calls,2);assert.ok(seen[1]!.includes('OWNED-QUEUE-57'));
});

test('HC04 idle/restarted queue can be inspected and cancelled with no model effects; owner and audit gate it',async t=>{
 const {options,request}=await fixture(t);let begin!:()=>void,finish!:()=>void,calls=0;
 const started=new Promise<void>(r=>begin=r),pending=new Promise<void>(r=>finish=r);
 options.transport=async()=>{if(++calls===1){begin();await pending;}return{content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();const run=runtime.run({...request,sessionId:session.id});await started;
 const queued=await runtime.control({taskId:request.taskId,sessionId:session.id,command:{kind:'nextRun',text:'DO-NOT-RUN'}});finish();assert.equal((await run).status,'succeeded');
 const reopened=createSessionRuntime(options),input={taskId:request.taskId,sessionId:session.id};
 const snapshot=await reopened.control({...input,command:{kind:'snapshot'}});assert.equal(snapshot.snapshot?.queued[0]?.entryId,queued.entryId);
 await assert.rejects(reopened.control({...input,taskId:'foreign',command:{kind:'cancelQueued',entryId:queued.entryId!}}),/AUTHORITY_REQUIRED/);
 const broken=createSessionRuntime({...options,audit:{append:async()=>{throw Error('offline');}}});await assert.rejects(broken.control({...input,command:{kind:'cancelQueued',entryId:queued.entryId!}}),/AUDIT_FAILED/);
 assert.equal((await reopened.control({...input,command:{kind:'cancelQueued',entryId:queued.entryId!}})).cancelled,true);
 assert.equal((await reopened.control({...input,command:{kind:'snapshot'}})).snapshot?.queued.length,0);assert.equal(calls,1);
});
