import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as immediate} from 'node:timers/promises';
import * as sdk from '../src/index.ts';

const model:sdk.ModelConfig={provider:'synthetic',id:'fixed-limits',protocol:'openai-completions',endpoint:'https://synthetic.invalid/v1',contextWindow:200000,maxOutputTokens:32768};
const limits={cumulative:'unlimited' as const,maxOutputTokens:32768,modelTimeoutMs:600000,toolTimeoutMs:300000,controlTimeoutMs:30000};
const answer=():sdk.ModelReply=>({content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:3,outputTokens:2}});
const base=()=>({model,budgets:sdk.createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}}});
const latch=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return{promise,release};};
const entered=async(start:Promise<void>,running:Promise<sdk.RunResult<unknown>>)=>Promise.race([start,running.then(result=>assert.fail('Run finished before expected entry: '+JSON.stringify(result)))]);
function streamFixture(){
 const started=latch();let controller!:ReadableStreamDefaultController<Uint8Array>,requestBody:any;
 const send=(delta:object,finish:string|null=null,usage?:object)=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:model.id,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n'));
 const transport=sdk.createPiTransport({model,modelObservations:'v1',apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
  requestBody=JSON.parse(String(init?.body));
  const body=new ReadableStream<Uint8Array>({start(c){controller=c;}});
  init?.signal?.addEventListener('abort',()=>controller.error(new Error('synthetic abort')),{once:true});
  started.release();return new Response(body,{headers:{'content-type':'text/event-stream'}});
 }});
 return{transport,started,send,finish:()=>{controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();},body:()=>requestBody};
}

test('FL01 actual native SSE and persistent Harness consume 32768 cap, >4096 output and >60s without an old wall',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 const root=await mkdtemp(join(tmpdir(),'pi-limits-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stream=streamFixture();
 const runtime=sdk.createSessionRuntime({...base(),transport:stream.transport,modelObservations:'v1',toolAdmission:{policyVersion:'fixed-limits-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[]})},
  storage:{cwd:root,directory:root,policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},bindOperation:async()=>{},reconcile:async()=> 'ready'});
 const session=await runtime.create(),running=runtime.run({sessionId:session.id,taskId:'long-stream',prompt:'synthetic',tools:[],limits});
 await stream.started.promise;stream.send({role:'assistant',content:'x'.repeat(20000)});await immediate();
 t.mock.timers.tick(90000);await immediate();
 stream.send({},'stop',{prompt_tokens:3,completion_tokens:5000,total_tokens:5003});stream.finish();
 const result=await running;assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.usage.outputTokens,5000);assert.equal(result.usage.reservedOutputTokens,0);
 assert.equal(stream.body().max_tokens??stream.body().max_completion_tokens,32768);
});

test('FL02 streaming progress does not reset the physical 600s model clock',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const stream=streamFixture();
 const runtime=sdk.createRuntime({...base(),transport:stream.transport,modelObservations:'v1'});
 const running=runtime.runText({taskId:'stream-clock',prompt:'synthetic',limits});await stream.started.promise;
 stream.send({role:'assistant',content:'first'});await immediate();t.mock.timers.tick(590000);
 stream.send({content:'progress at 590s'});await immediate();t.mock.timers.tick(10000);await immediate();
 const result=await running;await runtime.waitForIdle('stream-clock');
 assert.equal(result.status==='failed'&&result.reason,'DEADLINE_EXCEEDED');assert.equal(result.usage.modelCalls,1);assert.equal(result.modelOutcome?.usageFinal,false);
 assert.equal(result.usage.reservedOutputTokens,32768);
});

test('FL03 backup cap stays 16384 with one shared physical extra allowance',async()=>{
 const seen:number[]=[];const runtime=sdk.createRuntime({...base(),transport:async r=>{seen.push(r.maxOutputTokens);throw new sdk.ProviderFailure('network');},
  fallbacks:[{model:{...model,id:'backup',maxOutputTokens:16384},transport:async r=>{seen.push(r.maxOutputTokens);return answer();}}]});
 const result=await runtime.runText({taskId:'backup-cap',prompt:'synthetic',limits,modelRecovery:{extraAttempts:1}});
 assert.equal(result.status,'succeeded');assert.deepEqual(seen,[32768,16384]);assert.equal(result.usage.modelCalls,2);assert.equal(result.usage.reservedOutputTokens,32768);
});

test('FL04 hard 300s tool wall preserves UNKNOWN, ownership and late completed fact',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const started=latch(),finish=latch();let calls=0,effects=0;const events:sdk.AuditEvent[]=[];
 const tool:sdk.Tool={name:'draft',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object'},execute:async()=>{started.release();await finish.promise;effects++;return{};}};
 const runtime=sdk.createRuntime({...base(),modelObservations:'v1',audit:{append:async e=>{events.push(e);}},transport:async()=>{calls++;return{content:[{kind:'tool',id:'once',name:tool.name,arguments:{}}],stop:'tools',usage:{inputTokens:3,outputTokens:2},outcome:{model,stop:'tools',physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:3},outputTokens:{kind:'known',value:2}},diagnostic:'COMPLETE'}};}});
 const request={taskId:'hard-tool',prompt:'synthetic',tools:[tool],limits};const running=runtime.runAgent(request);await entered(started.promise,running);
 t.mock.timers.tick(300000);await immediate();const result=await running;
 assert.equal(result.status==='failed'&&result.reason,'DEADLINE_EXCEEDED');assert.equal(result.toolOutcomes?.[0]?.status,'unknown');assert.equal(effects,0);
 assert.equal((await runtime.runAgent(request)).status,'blocked');finish.release();await runtime.waitForIdle(request.taskId);
 assert.equal(effects,1);assert.equal(calls,1);assert.equal(result.toolOutcomes?.[0]?.status,'unknown');assert.equal(events.find(e=>e.kind==='tool.finished')?.toolOutcome?.status,'completed');
});

test('FL05 existing 30s control wall remains independent from the 600s model clock',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const started=latch(),finish=latch();let calls=0;
 const runtime=sdk.createRuntime({...base(),audit:{append:async()=>{started.release();await finish.promise;}},transport:async()=>{calls++;return answer();}});
 const running=runtime.runText({taskId:'control-wall',prompt:'synthetic',limits});await started.promise;
 t.mock.timers.tick(30000);await immediate();const result=await running;assert.equal(result.status==='failed'&&result.reason,'DEADLINE_EXCEEDED');assert.equal(calls,0);
 finish.release();await runtime.waitForIdle('control-wall');
});

test('FL06 an existing host 300s business deadline rejects a cumulative 310s flow before draft effects',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const started=[latch(),latch()],finish=[latch(),latch()];let calls=0,effects=0;
 const deadline=Date.now()+300000;
 const tool:sdk.Tool={name:'draft',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object'},execute:async()=>{effects++;return{};}};
 const runtime=sdk.createRuntime({...base(),authorize:async action=>action.kind!=='tool'||Date.now()<deadline,transport:async()=>{const n=calls++;started[n]!.release();await finish[n]!.promise;return n===0?answer():{content:[{kind:'tool',id:'draft',name:tool.name,arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};}});
 const first=runtime.runAgent({taskId:'host-deadline',prompt:'phase 1',tools:[tool],limits});await entered(started[0]!.promise,first);t.mock.timers.tick(160000);finish[0]!.release();assert.equal((await first).status,'succeeded');
 const second=runtime.runAgent({taskId:'host-deadline',prompt:'phase 2',tools:[tool],limits});await entered(started[1]!.promise,second);t.mock.timers.tick(150000);finish[1]!.release();
 const result=await second;assert.equal(result.status,'blocked');assert.equal(effects,0);assert.equal(calls,2);
});

test('FL07 native bash uses the existing host 120s soft wall and retains safe timeout facts',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const started=latch();let executions=0,requests=0;
 const env:sdk.ExecutionEnvironment={cwd:'/synthetic',policyVersion:'host-soft-wall',resolvePath:async p=>'/synthetic/'+p,
  read:async()=>assert.fail('read forbidden'),write:async()=>assert.fail('write forbidden'),stat:async()=>assert.fail('stat forbidden'),
  exec:async()=>{executions++;started.release();await new Promise((_,reject)=>setTimeout(()=>reject(new sdk.RuntimeFault('DEADLINE_EXCEEDED')),120000));return{output:'unreachable',exitCode:0};}};
 const tools=sdk.createExecutionTools(env,['bash']);
 const runtime=sdk.createRuntime({...base(),modelObservations:'v1',transport:async()=>{requests++;return{content:[{kind:'tool',id:'command',name:'bash',arguments:{command:'synthetic-only'}}],stop:'tools',usage:{inputTokens:3,outputTokens:2},outcome:{model,stop:'tools',physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:3},outputTokens:{kind:'known',value:2}},diagnostic:'COMPLETE'}};}});
 const running=runtime.runAgent({taskId:'soft-command',prompt:'synthetic',tools,limits});await entered(started.promise,running);t.mock.timers.tick(120000);await immediate();
 const result=await running;assert.equal(result.status,'failed');assert.equal(result.toolOutcomes?.[0]?.failureCategory,'timeout');assert.equal(result.toolOutcomes?.[0]?.status,'unknown');assert.equal(executions,1);assert.equal(requests,1);
});
