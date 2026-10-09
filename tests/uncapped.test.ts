import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,createSessionRuntime,createMemoryBudgetStore,ProviderFailure} from '../src/index.ts';
const model={provider:'synthetic',id:'uncapped',protocol:'openai-completions' as const,endpoint:'https://example.invalid',contextWindow:8192};
const limits={cumulative:'unlimited' as const,maxOutputTokens:4,modelTimeoutMs:100,toolTimeoutMs:100,controlTimeoutMs:100};
const answer=()=>({content:[{kind:'text' as const,text:'42'}],stop:'complete' as const,usage:{inputTokens:3,outputTokens:2}});
test('UB01 uncapped mode actually consumes beyond per-call caps across Worker/Text/Agent rounds',async()=>{
 let calls=0;const runtime=createRuntime({model,budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},transport:async r=>{assert.equal(r.maxOutputTokens,4);calls++;return answer();}});
 const base={taskId:'unlimited',prompt:'go',limits};
 for(let i=0;i<8;i++){const result=await runtime.runText(base);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.usage.modelCalls,i+1);assert.equal(result.usage.outputTokens,(i+1)*2);}
 assert.equal((await runtime.runWorker({...base,validate:v=>v})).status,'succeeded');assert.equal((await runtime.runAgent({...base,tools:[]})).status,'succeeded');assert.equal(calls,10);
});
test('UB02 one extra attempt is shared across ordered fallbacks and does not repeat each candidate',async()=>{
 let calls=0;const transport=async()=>{calls++;throw new ProviderFailure('unavailable');};
 const runtime=createRuntime({model:{...model,maxOutputTokens:4},transport,fallbacks:[{model:{...model,id:'b',maxOutputTokens:4},transport},{model:{...model,id:'c',maxOutputTokens:4},transport}],authorize:async()=>true,audit:{append:async()=>{}}});
 const result=await runtime.runText({taskId:'two',prompt:'go',limits,modelRecovery:{extraAttempts:1}});assert.equal(result.status,'failed');assert.equal(calls,2);assert.equal(result.usage.modelCalls,2);assert.equal(result.usage.outputTokens,8);
});

test('UB03 cumulative tool/token/time grows beyond single-call protection without a hidden run deadline',async()=>{
 let calls=0,effects=0;const runtime=createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>{
  await new Promise(r=>setTimeout(r,25));if(++calls<=5)return{content:[{kind:'tool' as const,id:String(calls),name:'read',arguments:{}}],stop:'tools' as const,usage:{inputTokens:3,outputTokens:2}};return answer();}});
 const result=await runtime.runAgent({taskId:'loop',prompt:'loop',limits,tools:[{name:'read',description:'read',effect:'read',resourceUnits:3,parameters:{type:'object',properties:{}},execute:async()=>++effects}]});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(effects,5);assert.equal(result.usage.modelCalls,6);assert.equal(result.usage.outputTokens,12);assert.equal(result.usage.inputTokens,18);assert.equal(result.usage.resourceUnits,21);assert.ok(result.usage.activeMs>limits.modelTimeoutMs);assert.equal(result.usage.reservedOutputTokens,0);
});
test('UB04 settled request timeout permits only one retry; failed reservation remains uncertain',async()=>{
 let calls=0;const runtime=createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},transport:async r=>{if(++calls===1)await new Promise((_resolve,reject)=>r.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));return answer();}});
 const result=await runtime.runText({taskId:'timeout-retry',prompt:'go',limits:{...limits,modelTimeoutMs:20},modelRecovery:{extraAttempts:1}});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(calls,2);assert.equal(result.usage.outputTokens,6);assert.equal(result.usage.reservedOutputTokens,4);
});
test('UB05 hung physical request times out without parallel retry and retains ownership until truly idle',async()=>{
 let finish!:()=>void,calls=0;const runtime=createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>{calls++;await new Promise<void>(r=>finish=r);return answer();}});
 const request={taskId:'hung',prompt:'go',limits:{...limits,modelTimeoutMs:20},modelRecovery:{extraAttempts:1 as const}};
 const result=await runtime.runText(request);assert.equal(result.status!=='succeeded'&&result.reason,'DEADLINE_EXCEEDED');assert.equal(calls,1);assert.equal(result.usage.reservedOutputTokens,4);
 const busy=await runtime.runText(request);assert.equal(busy.status!=='succeeded'&&busy.reason,'TASK_BUSY');finish();await runtime.waitForIdle(request.taskId);assert.equal(calls,1);
});
test('UB06 uncapped policy is explicit; old stores and implicit migration do not silently drop limits/history',async()=>{
 const store=createMemoryBudgetStore();const options={model,budgets:store,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>answer()};const runtime=createRuntime(options);
 const first=await runtime.runText({taskId:'migration',prompt:'go',limits:{modelCalls:2,toolCalls:0,outputTokens:8,wallTimeMs:1000}});assert.equal(first.status,'succeeded');
 const migrated=await runtime.runText({taskId:'migration',prompt:'go',limits});assert.equal(migrated.status!=='succeeded'&&migrated.reason,'CONFIGURATION_CHANGED');
 const unsupported=await createRuntime({...options,budgets:{claim:store.claim}}).runText({taskId:'old-store',prompt:'go',limits});assert.equal(unsupported.status!=='succeeded'&&unsupported.reason,'CAPABILITY_UNAVAILABLE');
 for(const bad of [{...limits,cumulative:undefined},{...limits,modelCalls:999999},{...limits,modelTimeoutMs:undefined},{...limits,maxOutputTokens:Infinity},{...limits,maxOutputTokens:NaN}]) {
  const r=await runtime.runText({taskId:'invalid',prompt:'go',limits:bad as unknown as typeof limits});assert.equal(r.status!=='succeeded'&&r.reason,'INVALID_REQUEST');
 }
});
test('UB07 single output limit, revoked authority, audit failure and ledger failure still close admission',async()=>{
 for(const mode of ['output','auth','audit','ledger'] as const){let calls=0;const memory=createMemoryBudgetStore();
  const runtime=createRuntime({model,transport:async()=>{calls++;return{...answer(),usage:{inputTokens:3,outputTokens:5}};},budgets:mode==='ledger'?{claim:memory.claim,claimUncapped:async()=>{throw Error('offline');}}:memory,authorize:async()=>mode!=='auth',audit:{append:async()=>{if(mode==='audit')throw Error('offline');}}});
  const r=await runtime.runText({taskId:mode,prompt:'go',limits});assert.equal(r.status!=='succeeded'&&r.reason,{output:'BUDGET_EXHAUSTED',auth:'AUTHORITY_REQUIRED',audit:'AUDIT_FAILED',ledger:'STATE_FAILED'}[mode]);assert.equal(calls,mode==='output'?1:0);if(mode==='output'){assert.equal(r.usage.inputTokens,3);assert.equal(r.usage.outputTokens,5);assert.equal(r.usage.reservedOutputTokens,0);}
 }
});
test('UB08 tools and control IO have independent deadlines; late tool values cannot publish',async()=>{
 for(const mode of ['tool','audit','claim'] as const){let finish!:()=>void;const wait=new Promise<void>(r=>finish=r);const memory=createMemoryBudgetStore();let models=0;
 const runtime=createRuntime({model,transport:async()=>{models++;return{content:[{kind:'tool' as const,id:'one',name:'read',arguments:{}}],stop:'tools' as const,usage:{inputTokens:1,outputTokens:1}};},authorize:async()=>true,
 budgets:mode==='claim'?{claim:memory.claim,claimUncapped:async(...a)=>{await wait;return memory.claimUncapped!(...a);}}:memory,audit:{append:async()=>{if(mode==='audit')await wait;}}});
 const r=await runtime.runAgent({taskId:mode,prompt:'go',limits:{...limits,toolTimeoutMs:20,controlTimeoutMs:20},tools:[{name:'read',description:'read',effect:'read',parameters:{type:'object',properties:{}},resourceUnits:1,execute:async()=>{await wait;return 1;}}]});
 assert.equal(r.status!=='succeeded'&&r.reason,'DEADLINE_EXCEEDED',JSON.stringify(r));assert.equal(models,mode==='tool'?1:0);finish();await runtime.waitForIdle(mode);
 }
});
test('UB09 cancellation is independent of uncapped accounting',async()=>{
 const controller=new AbortController();let begin!:()=>void,finish!:()=>void;const started=new Promise<void>(r=>begin=r),wait=new Promise<void>(r=>finish=r);
 const runtime=createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>{begin();await wait;return answer();}});
 const running=runtime.runText({taskId:'cancel',prompt:'go',limits,signal:controller.signal});await started;controller.abort();const r=await running;assert.equal(r.status,'cancelled');assert.equal(r.usage.reservedOutputTokens,4);finish();await runtime.waitForIdle('cancel');
});


test('UB10 checkpoint control IO times out while retaining task ownership',async()=>{
 let finish!:()=>void;const wait=new Promise<void>(r=>finish=r);
 const runtime=createRuntime({model,transport:async()=>answer(),authorize:async()=>true,audit:{append:async()=>{}}});
 const request={taskId:'checkpoint-timeout',prompt:'go',limits:{...limits,controlTimeoutMs:20},tools:[],saveCheckpoint:async()=>{await wait;}};
 const r=await runtime.runAgent(request);assert.equal(r.status!=='succeeded'&&r.reason,'DEADLINE_EXCEEDED');
 const busy=await runtime.runAgent(request);assert.equal(busy.status!=='succeeded'&&busy.reason,'TASK_BUSY');finish();await runtime.waitForIdle(request.taskId);
});

test('UB11 each normal model turn gets its own one-extra allowance; denial/invalid output never retry',async()=>{
 let calls=0;const runtime=createRuntime({model,transport:async()=>{calls++;if(calls%2===1)throw new ProviderFailure('network');if(calls===2)return{content:[{kind:'tool' as const,id:'one',name:'read',arguments:{}}],stop:'tools' as const,usage:{inputTokens:1,outputTokens:1}};return answer();},authorize:async()=>true,audit:{append:async()=>{}}});
 const r=await runtime.runAgent({taskId:'per-step',prompt:'go',limits,modelRecovery:{extraAttempts:1},tools:[{name:'read',description:'read',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>1}]});
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(calls,4);assert.equal(r.usage.reservedOutputTokens,8);
 for(const mode of ['denied','invalid','quota','disabled'] as const){let calls=0;const runtime=createRuntime({model,transport:async()=>{calls++;if(mode==='quota')throw new ProviderFailure('quota');if(mode==='disabled')throw new ProviderFailure('network');return {...answer(),content:[]};},authorize:async()=>mode!=='denied',audit:{append:async()=>{}}});
 const r=await runtime.runText({taskId:mode,prompt:'go',limits,modelRecovery:{extraAttempts:mode==='disabled'?0:1}});assert.notEqual(r.status,'succeeded');assert.equal(calls,mode==='denied'?0:1);}
});

test('UB12 native callbacks time out without releasing pending writer or starting model effects',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 for(const mode of ['authorize','writer','reconcile','bind','hook'] as const){
 const root=await mkdtemp(join(tmpdir(),'uncapped-control-'));t.after(()=>rm(root,{recursive:true,force:true}));let finish!:()=>void,armed=false,calls=0,released=0;
 const wait=new Promise<void>(r=>finish=r);const block=async()=>{if(armed)await wait;};
 const runtime=createSessionRuntime({model,budgets:createMemoryBudgetStore(),transport:async()=>{calls++;return answer();},authorize:async()=>true,audit:{append:async()=>{}},
 storage:{directory:root,cwd:root,policyVersion:'test',authorize:async()=>{if(mode==='authorize')await block();return true;},acquireWriter:async()=>{if(mode==='writer')await block();return{release:async()=>{released++;}};}},
 reconcile:async()=>{if(mode==='reconcile')await block();return 'ready';},bindOperation:async()=>{if(mode==='bind')await block();},harness:{extensionVersion:'test'},extensions:{beforeRequest:async()=>{if(mode==='hook')await block();}}});
 const session=await runtime.create();armed=true;const previous=released;
 const request={taskId:mode,sessionId:session.id,prompt:'go',tools:[],limits:{...limits,controlTimeoutMs:20}};
 const r=await runtime.run(request);assert.equal(r.status!=='succeeded'&&r.reason,'DEADLINE_EXCEEDED',JSON.stringify(r));assert.equal(calls,0);assert.equal(released,previous);
 finish();await runtime.waitForIdle(mode);assert.equal(calls,0);
 }
});

test('UB13 explicit retry allowance cannot stack native retry',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'uncapped-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const runtime=createSessionRuntime({model,transport:async()=>{calls++;return answer();},budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},storage:{directory:root,cwd:root,policyVersion:'test',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},reconcile:async()=> 'ready',bindOperation:async()=>{},harness:{retry:{enabled:true,maxRetries:1,baseDelayMs:0}}});
 const session=await runtime.create();const r=await runtime.run({sessionId:session.id,taskId:'retry-stack',prompt:'go',tools:[],limits,modelRecovery:{extraAttempts:1}});assert.equal(r.status!=='succeeded'&&r.reason,'INVALID_REQUEST');assert.equal(calls,0);
});

test('UB14 independent process reopen and fork consume history; hard-exit UNKNOWN cannot replay free',async t=>{
 const {mkdtemp,rm,readFile,writeFile,unlink}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const root=await mkdtemp(join(tmpdir(),'uncapped-process-'));t.after(()=>rm(root,{recursive:true,force:true}));const execute=promisify(execFile);
 const child=async(mode:string)=>JSON.parse((await execute(process.execPath,['--experimental-strip-types','tests/fixtures/uncapped-process.mjs',root,mode],{timeout:10000})).stdout);
 const first=await child('first'),second=await child('second'),fork=await child('fork');assert.equal(first.status,'succeeded');assert.equal(second.value,'consumed 73');assert.equal(fork.value,'consumed 73');assert.equal(fork.usage.modelCalls,4);assert.equal(fork.usage.toolCalls,1);assert.equal(fork.usage.outputTokens,8);assert.equal(fork.usage.inputTokens,12);assert.ok(fork.usage.activeMs>=second.usage.activeMs);
 await assert.rejects(child('crash'),e=>(e as {code:number}).code===81);
 const before=JSON.parse(await readFile(join(root,'ledger.json'),'utf8'));assert.equal(before.usage.modelCalls,5);assert.equal(before.usage.reservedOutputTokens,4);assert.equal(before.usage.outputTokens,12);
 const busy=await child('recover');assert.equal(busy.reason,'TASK_BUSY');assert.equal(busy.usageKnown,false);
 // Explicit synthetic host reconciliation AFTER execFile confirms the crashed process exited.
 // Preserve usage/UNKNOWN, account crashed active time, and only clear its known-dead ownership.
 before.usage.activeMs+=Date.now()-before.started;delete before.owner;delete before.started;
 await writeFile(join(root,'ledger.json'),JSON.stringify(before));await unlink(join(root,'budget.lock'));await unlink(join(root,'writer.lock'));
 const physical=await readFile(join(root,'physical.jsonl'),'utf8'),effects=await readFile(join(root,'effects.jsonl'),'utf8');
 const recovered=await child('recover');assert.equal(recovered.reason,'STATE_FAILED');assert.equal(recovered.usage.modelCalls,5);assert.equal(recovered.usage.reservedOutputTokens,4);assert.equal(recovered.usage.inputTokens,12);assert.ok(recovered.usage.activeMs>=before.usage.activeMs);
 assert.equal(await readFile(join(root,'physical.jsonl'),'utf8'),physical);assert.equal(await readFile(join(root,'effects.jsonl'),'utf8'),effects);
});

test('UB15 native JSONL commit is individually timed and late completion cannot publish',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {NodeExecutionEnv}=await import('@earendil-works/pi-agent-core/node');
 const root=await mkdtemp(join(tmpdir(),'uncapped-jsonl-'));t.after(()=>rm(root,{recursive:true,force:true}));let finish!:()=>void,armed=false,calls=0,released=0;const wait=new Promise<void>(r=>finish=r);const original=NodeExecutionEnv.prototype.appendFile;
 t.mock.method(NodeExecutionEnv.prototype,'appendFile',async function(this:InstanceType<typeof NodeExecutionEnv>,...args:Parameters<typeof original>){if(armed)await wait;return original.apply(this,args);});
 const runtime=createSessionRuntime({model,transport:async()=>{calls++;armed=true;return answer();},budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},storage:{directory:root,cwd:root,policyVersion:'test',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{released++;}})},reconcile:async()=> 'ready',bindOperation:async()=>{}});
 const session=await runtime.create(),previous=released;const r=await runtime.run({taskId:'commit-timeout',sessionId:session.id,prompt:'go',tools:[],limits:{...limits,controlTimeoutMs:20}});assert.equal(r.status!=='succeeded'&&r.reason,'DEADLINE_EXCEEDED');assert.equal(calls,1);assert.equal(released,previous);finish();await runtime.waitForIdle('commit-timeout');assert.equal(released,previous+1);
});

test('UB16 unreadable or invalid ledger snapshots close admission/publication and never claim known zero usage',async()=>{
 for(const mode of ['initial','after-model','invalid'] as const){let bad=mode==='initial',calls=0;const memory=createMemoryBudgetStore();
 const budgets={claim:memory.claim,claimUncapped:async(...args:Parameters<NonNullable<typeof memory.claimUncapped>>)=>{const lease=await memory.claimUncapped!(...args);return{...lease,snapshot:()=>{if(bad){if(mode==='invalid')return{...lease.snapshot(),reservedOutputTokens:-1};throw Error('read outage');}return lease.snapshot();}};}};
 const runtime=createRuntime({model,budgets,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>{calls++;bad=true;return answer();}});
 const r=await runtime.runText({taskId:mode,prompt:'go',limits});assert.equal(r.status!=='succeeded'&&r.reason,'STATE_FAILED',JSON.stringify(r));assert.equal(r.usageKnown,false);assert.equal(calls,mode==='initial'?0:1);
 }
});

test('UB17 finite host leases may invalidate snapshots after successful release',async()=>{
 const memory=createMemoryBudgetStore();let released=false;
 const budgets={claim:async(...args:Parameters<typeof memory.claim>)=>{const lease=await memory.claim(...args);return{...lease,snapshot:()=>{if(released)throw Error('lease released');return lease.snapshot();},release:async(ms:number)=>{await lease.release(ms);released=true;}};}};
 const runtime=createRuntime({model,budgets,transport:async()=>answer(),authorize:async()=>true,audit:{append:async()=>{}}});
 const r=await runtime.runText({taskId:'legacy-lease',prompt:'go',limits:{modelCalls:2,toolCalls:0,outputTokens:10,wallTimeMs:1000}});assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.usageKnown,true);assert.equal(r.usage.outputTokens,2);assert.equal(released,true);
});
