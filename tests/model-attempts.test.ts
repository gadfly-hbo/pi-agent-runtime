import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import type {Authorization, AuditEvent, ModelConfig, ModelReply, SessionRuntimeOptions} from '../src/index.ts';

// The identical test can address the preserved .4 or the final extracted tgz.
const sdk:typeof import('../src/index.ts') = await import(process.env.PI_TEST_SDK_ENTRY
  ? pathToFileURL(process.env.PI_TEST_SDK_ENTRY).href : new URL('../src/index.ts',import.meta.url).href);
const model:ModelConfig={provider:'synthetic',id:'attempt-correlation',protocol:'openai-completions',endpoint:'https://synthetic.invalid/v1',contextWindow:200000,maxOutputTokens:16};
const limits={cumulative:'unlimited' as const,maxOutputTokens:16,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000};
const outcome=(stop:'complete'|'tools'='complete'):NonNullable<ModelReply['outcome']>=>({model,stop,physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:1},outputTokens:{kind:'known',value:1}},diagnostic:'COMPLETE'});
const answer=():ModelReply=>({stop:'complete',content:[{kind:'text',text:'synthetic complete'}],usage:{inputTokens:1,outputTokens:1},outcome:outcome()});

test('MA01 new requirement: physical authority and terminal facts correlate normal/recovery/next logical step',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sdk-model-attempt-red-'));
  const actions:Authorization[]=[],events:AuditEvent[]=[];
  let physical=0,effects=0;
  const runtime=sdk.createSessionRuntime(Object.assign({model,modelObservations:'v1' as const,budgets:sdk.createMemoryBudgetStore(),
    transport:async()=>{
      physical++;
      if(physical===1)throw new sdk.ProviderFailure('network',{...outcome(),stop:'error',category:'network',usage:{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}},diagnostic:'REQUEST_FAILED'});
      if(physical===2)return{stop:'tools' as const,content:[{kind:'tool' as const,id:'read-once',name:'read_evidence',arguments:{}}],usage:{inputTokens:1,outputTokens:1},outcome:outcome('tools')};
      return answer();
    },authorize:async(action:Authorization)=>{actions.push(action);return true;},audit:{append:async(event:AuditEvent)=>{events.push(event);}},
    storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
    reconcile:async()=>'ready' as const,bindOperation:async()=>{},
  },{modelAttempts:'v1' as const}));
  const session=await runtime.create();
  const result=await runtime.run({sessionId:session.id,taskId:'new-contract-red',prompt:'synthetic',limits,modelRecovery:{extraAttempts:1},tools:[{name:'read_evidence',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return{synthetic:true};}}]});
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.equal(physical,3);assert.equal(effects,1);
  const refs=actions.filter(a=>a.kind==='model').map(a=>(a as unknown as {modelAttempt?:{logicalRequestId:string;physicalAttemptId:string;kind:string;recovery?:{logicalRequestId:string;physicalAttemptId:string;reason:string}}}).modelAttempt);
  assert.ok(refs[0],'NEW_REQUIREMENT_MISSING: model authorization has no trustworthy attempt association');
  assert.equal(refs[0].kind,'initial');assert.equal(refs[1]!.kind,'recovery');assert.equal(refs[2]!.kind,'initial');
  assert.equal(refs[0].logicalRequestId,refs[1]!.logicalRequestId);assert.notEqual(refs[0].logicalRequestId,refs[2]!.logicalRequestId);
  assert.equal(new Set(refs.map(r=>r!.physicalAttemptId)).size,3);
  assert.equal(refs[1]!.recovery?.physicalAttemptId,refs[0].physicalAttemptId);assert.equal(refs[1]!.recovery?.logicalRequestId,refs[0].logicalRequestId);
  assert.equal(refs[1]!.recovery?.reason,'same-model');
  const facts=events.filter(e=>e.kind==='model.finished').map(e=>(e as unknown as {modelAttemptFact?:{attempt:{physicalAttemptId:string};terminal:boolean}}).modelAttemptFact);
  assert.equal(facts.length,3);assert.deepEqual(facts.map(f=>f?.attempt.physicalAttemptId),refs.map(r=>r!.physicalAttemptId));
  assert.ok(facts.every(f=>f?.terminal===true));
});

async function fixture(change:Partial<SessionRuntimeOptions>={},omit:readonly ('modelAttempts'|'modelObservations')[]=[]){
  const root=await mkdtemp(join(tmpdir(),'sdk-attempt-'));
  const actions:Authorization[]=[],events:AuditEvent[]=[];
  const options:SessionRuntimeOptions={model,transport:async()=>answer(),modelObservations:'v1',modelAttempts:'v1',budgets:sdk.createMemoryBudgetStore(),
    storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
    reconcile:async()=>'ready',bindOperation:async()=>{},...change,
    authorize:async(a,s)=>{actions.push(a);return change.authorize?change.authorize(a,s):true;},
    audit:{append:async(e,s)=>{events.push(e);await change.audit?.append(e,s);}}};
  for(const key of omit)delete options[key];
  const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
  const run=(taskId:string,extra:Partial<Parameters<typeof runtime.run>[0]>={})=>runtime.run({sessionId:session.id,taskId,prompt:'synthetic',tools:[],limits,modelRecovery:{extraAttempts:1},...extra});
  return{root,options,runtime,session,run,actions,events};
}
const network=()=>new sdk.ProviderFailure('network',{...outcome(),stop:'error',category:'network',usage:{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}},diagnostic:'REQUEST_FAILED'});
const finished=(events:AuditEvent[])=>events.filter(e=>e.kind==='model.finished').map(e=>e.modelAttemptFact!);

test('MA02 SDK fallback preserves logical identity, links actual parent, and does not expose content',async()=>{
  const backup={...model,id:'backup'};let primary=0,secondary=0;
  const f=await fixture({transport:async()=>{primary++;throw network();},fallbacks:[{model:backup,transport:async()=>{secondary++;return{...answer(),outcome:{...outcome(),model:backup}};}}]});
  const result=await f.run('fallback');assert.equal(result.status,'succeeded');assert.equal(primary,1);assert.equal(secondary,1);
  const refs=f.actions.filter(a=>a.kind==='model').map(a=>a.modelAttempt!);
  assert.equal(refs[1]!.kind,'recovery');assert.equal(refs[1]!.recovery?.reason,'fallback');
  assert.equal(refs[1]!.logicalRequestId,refs[0]!.logicalRequestId);assert.equal(refs[1]!.recovery?.physicalAttemptId,refs[0]!.physicalAttemptId);
  assert.deepEqual(result.modelAttempts,finished(f.events));assert.equal(JSON.stringify(f.events).includes('https://synthetic.invalid'),false);
});

test('MA03 native retry is classified from durable native attempt, not total audit attempt',async()=>{
  let physical=0;
  const f=await fixture({harness:{retry:{enabled:true,maxRetries:2,baseDelayMs:0}},transport:async()=>{if(++physical===1)throw network();return answer();}});
  const result=await f.runtime.run({sessionId:f.session.id,taskId:'native',prompt:'synthetic',tools:[],limits});assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(physical,2);
  const facts=finished(f.events);assert.equal(facts.length,2);assert.equal(facts[1]!.attempt.recovery?.reason,'native-retry');
  assert.equal(facts[0]!.attempt.logicalRequestId,facts[1]!.attempt.logicalRequestId);
});

test('MA04 normal manual and threshold compaction remain initial and usable',async()=>{
  for(const automatic of [false,true]){
    let summaries=0,consumed=false;
    const selected={...model,contextWindow:512};
    const f=await fixture({model:selected,harness:{compaction:{enabled:automatic,reserveTokens:128,keepRecentTokens:1}},transport:async request=>{
      const text=request.messages.map(m=>m.text).join('\n');
      if(text.includes('context summarization assistant')){summaries++;return{...answer(),content:[{kind:'text',text:'AUTO-SUMMARY: number 83'}],outcome:{...outcome(),model:selected}};}
      if(text.includes('AUTO-SUMMARY: number 83'))consumed=true;
      const input=summaries?10:450;
      return{...answer(),usage:{inputTokens:input,outputTokens:1},outcome:{...outcome(),model:selected,usage:{inputTokens:{kind:'known',value:input},outputTokens:{kind:'known',value:1}}}};
    }});
    assert.equal((await f.run('normal-summary')).status,'succeeded');
    if(!automatic)assert.equal((await f.run('normal-summary',{operation:'compact'})).status,'succeeded');
    const next=await f.run('normal-summary');assert.equal(next.status,'succeeded',JSON.stringify(next));
    assert.ok(summaries>0);assert.equal(consumed,true);
    assert.ok(finished(f.events).some(f=>f.attempt.source==='compaction'));
    assert.ok(finished(f.events).every(f=>f.attempt.kind==='initial'));
  }
});

test('MA05 overflow summary is recovery; one physical allowance cannot also resend the original',async()=>{
  let physical=0,summaries=0;
  const f=await fixture({harness:{compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:1}},transport:async request=>{
    physical++;
    if(request.messages.some(m=>m.text.includes('context summarization assistant'))){summaries++;return answer();}
    if(physical===1)return answer();
    return{...answer(),stop:'length',content:[{kind:'text',text:'PARTIAL'}],outcome:{...outcome(),stop:'length',diagnostic:'OUTPUT_LIMIT'}};
  }});
  assert.equal((await f.run('overflow')).status,'succeeded');
  const result=await f.run('overflow');assert.notEqual(result.status,'succeeded',JSON.stringify(result));
  assert.equal(physical,3);assert.equal(summaries,1);
  const facts=finished(f.events),summary=facts.find(f=>f.attempt.source==='compaction')!;
  assert.equal(summary.attempt.kind,'recovery');assert.equal(summary.attempt.recovery?.reason,'overflow-summary');
  const parent=facts.find(f=>f.attempt.physicalAttemptId===summary.attempt.recovery?.physicalAttemptId)!;
  assert.equal(parent.outcome.stop,'length');
  const denied=facts.at(-1)!;assert.equal(denied.attempt.recovery?.reason,'overflow');assert.equal(denied.outcome.physicalStatus,'not-sent');
  assert.equal(result.usage.modelCalls,3);assert.equal(denied.attempt.logicalRequestId,parent.attempt.logicalRequestId);
});

test('MA06 view rejection after recovery reservation emits exact terminal not-sent with known zero',async()=>{
  let physical=0,revision='one';
  const f=await fixture({toolAdmission:{policyVersion:'synthetic',correctionLimit:0,view:async()=>({version:revision,tools:[]})},
    audit:{append:async event=>{if(event.kind==='model.admitted' && event.modelAttempt?.kind==='recovery')revision='two';}},
    transport:async()=>{physical++;throw network();}});
  const result=await f.run('view-notsent');assert.notEqual(result.status,'succeeded');assert.equal(physical,1);
  const facts=finished(f.events);assert.equal(facts.length,2);
  const last=facts[1]!;assert.equal(last.attempt.kind,'recovery');assert.equal(last.outcome.physicalStatus,'not-sent');assert.equal(last.terminal,true);assert.equal(last.late,false);
  assert.deepEqual(last.outcome.usage,{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}});
  assert.equal(result.usage.outputTokens,0);assert.equal(result.usage.reservedOutputTokens,0);assert.equal(result.usage.modelCalls,2);
});

test('MA07 denied model authorization has zero physical/budget effect and a correlated rejection',async()=>{
  let physical=0;
  const f=await fixture({authorize:async a=>a.kind!=='model',transport:async()=>{physical++;return answer();}});
  const result=await f.run('denied');assert.equal(result.status,'blocked');assert.equal(physical,0);assert.equal(result.usage.modelCalls,0);
  const [fact]=finished(f.events);assert.equal(fact!.outcome.physicalStatus,'not-sent');assert.equal(fact!.reason,'AUTHORITY_REQUIRED');
  assert.equal(fact!.attempt.physicalAttemptId,f.actions.find(a=>a.kind==='model')!.modelAttempt!.physicalAttemptId);
});

test('MA08 cancellation in authorization never dispatches; terminal proof uses the same attempt',async()=>{
  const controller=new AbortController();let physical=0;
  const f=await fixture({authorize:async a=>{if(a.kind==='model')controller.abort();return true;},transport:async()=>{physical++;return answer();}});
  const result=await f.run('cancel-before',{signal:controller.signal});assert.equal(result.status,'cancelled');
  await f.runtime.waitForIdle('cancel-before');assert.equal(physical,0);assert.equal(finished(f.events).at(-1)!.outcome.physicalStatus,'not-sent');
});

test('MA09 cancellation while in-flight retains UNKNOWN reservation and late fact cannot publish/refund',async()=>{
  const controller=new AbortController();let start!:()=>void,finish!:()=>void;
  const started=new Promise<void>(r=>start=r),pending=new Promise<void>(r=>finish=r);
  const f=await fixture({transport:async()=>{start();await pending;return answer();}});
  const run=f.run('cancel-late',{signal:controller.signal});await started;controller.abort();
  const result=await run;assert.equal(result.status,'cancelled');assert.equal(result.usage.reservedOutputTokens,16);
  const pendingFact=result.modelAttempts![0]!;assert.equal(pendingFact.terminal,false);assert.equal(pendingFact.outcome.physicalStatus,'unknown');
  finish();await f.runtime.waitForIdle('cancel-late');
  const late=finished(f.events).at(-1)!;assert.equal(late.late,true);assert.equal(late.attempt.physicalAttemptId,pendingFact.attempt.physicalAttemptId);
  assert.equal(result.modelAttempts![0],pendingFact);assert.equal(pendingFact.terminal,false);
  assert.equal(f.events.some(e=>e.kind==='run.finished'&&!e.reason),false);
});

test('MA10 unknown Provider state never gets an automatic extra attempt',async()=>{
  let physical=0;
  const f=await fixture({transport:async()=>{physical++;throw new sdk.ProviderFailure('network');}});
  const result=await f.run('unknown');assert.notEqual(result.status,'succeeded');assert.equal(physical,1);
  assert.equal(result.usage.reservedOutputTokens,16);assert.equal(finished(f.events)[0]!.outcome.physicalStatus,'unknown');
});

test('MA11 explicit opt-in changes identity; missing version/unsupported native sources do not guess',async()=>{
  let physical=0;
  const f=await fixture({transport:async()=>{physical++;return answer();}},['modelAttempts']);
  const before=await f.run('legacy-identity');assert.equal(before.status,'succeeded');assert.equal('modelAttempts' in before,false);
  assert.equal(f.events.some(e=>e.modelAttempt||e.modelAttemptFact),false);
  const changed=sdk.createSessionRuntime({...f.options,modelAttempts:'v1'});
  const after=await changed.run({sessionId:f.session.id,taskId:'legacy-identity',prompt:'synthetic',tools:[],limits,modelRecovery:{extraAttempts:1}});
  assert.equal(after.status!=='succeeded'&&after.reason,'CONFIGURATION_CHANGED');assert.equal(physical,1);
  const invalid=await fixture({},['modelObservations']);assert.equal((await invalid.run('invalid-optin')).status,'failed');
  const deferred=await fixture({harness:{deferred:true}});const rejected=await deferred.run('deferred-unselected');
  assert.equal(rejected.status!=='succeeded'&&rejected.reason,'CAPABILITY_UNAVAILABLE');assert.equal(rejected.usage.modelCalls,0);
});

test('MA12 native structural retry and ordinary branch summary have trustworthy distinct causes',async()=>{
  let summaries=0;
  const f=await fixture({harness:{retry:{enabled:true,maxRetries:1,baseDelayMs:0},compaction:{enabled:false,reserveTokens:128,keepRecentTokens:1}},transport:async request=>{
    if(request.messages.some(m=>m.text.includes('context summarization assistant')) && ++summaries===1)throw network();
    return answer();
  }});
  const run=(extra:Partial<Parameters<typeof f.runtime.run>[0]>={})=>f.runtime.run({sessionId:f.session.id,taskId:'structural-retry',prompt:'synthetic',tools:[],limits,...extra});
  assert.equal((await run()).status,'succeeded');
  const compact=await run({operation:'compact'});assert.equal(compact.status,'succeeded',JSON.stringify(compact));assert.equal(summaries,2);
  const structural=finished(f.events).filter(f=>f.attempt.source==='compaction');
  assert.equal(structural[0]!.attempt.kind,'initial');assert.equal(structural[1]!.attempt.recovery?.reason,'native-retry');
  assert.equal(structural[1]!.attempt.recovery?.physicalAttemptId,structural[0]!.attempt.physicalAttemptId);
  const g=await fixture();assert.equal((await g.run('navigation')).status,'succeeded');
  const history=await g.runtime.history(g.session.id);const target=history.at(-1)!.id;
  assert.equal((await g.run('navigation')).status,'succeeded');
  const navigation=await g.run('navigation',{operation:'navigate',targetEntryId:target,summarize:true});
  assert.equal(navigation.status,'succeeded',JSON.stringify(navigation));
  assert.ok(finished(g.events).some(f=>f.attempt.source==='branch_summary'&&f.attempt.kind==='initial'));
});

test('MA13 cancellation/audit failure after reservation cannot dispatch and settles only proven zero',async()=>{
  for(const variant of ['cancel','audit'] as const){
    let physical=0;const controller=new AbortController();
    const f=await fixture({audit:{append:async e=>{if(e.kind==='model.admitted'){if(variant==='cancel')controller.abort();else throw Error('SYNTHETIC_AUDIT_FAILURE');}}},transport:async()=>{physical++;return answer();}});
    const result=await f.run('pre-dispatch-'+variant,{signal:controller.signal});await f.runtime.waitForIdle('pre-dispatch-'+variant);
    assert.equal(physical,0);assert.equal(result.status==='succeeded',false);
    const fact=finished(f.events).at(-1)!;assert.equal(fact.outcome.physicalStatus,'not-sent');assert.equal(fact.terminal,true);
    assert.equal(JSON.stringify(f.events).includes('SYNTHETIC_AUDIT_FAILURE'),false);
  }
});

for(const variant of ['contradictory-not-sent','unknown-success'] as const)test('MA14 new opt-in cannot turn '+variant+' into refund, retry or publication',async()=>{
  let physical=0;
  const f=await fixture({transport:async()=>{
    physical++;
    if(variant==='contradictory-not-sent')throw new sdk.ProviderFailure('network',{...outcome(),stop:'error',category:'network',physicalStatus:'not-sent',diagnostic:'REQUEST_FAILED'});
    return{...answer(),outcome:{...outcome(),physicalStatus:'unknown',usageFinal:false,usage:{inputTokens:{kind:'unknown'},outputTokens:{kind:'unknown'}},diagnostic:'UNKNOWN'}};
  }});
  const result=await f.run(variant);assert.notEqual(result.status,'succeeded');assert.equal(physical,1);
  assert.equal(result.usage.reservedOutputTokens,16);assert.equal(finished(f.events)[0]!.outcome.physicalStatus,'unknown');
  assert.equal(f.events.some(e=>e.kind==='run.finished'&&!e.reason),false);
});

test('MA15 tool correction and batch barrier do not spend or masquerade as physical fault recovery',async()=>{
  let physical=0,effects=0;
  const parameters={type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false};
  const tools=['one','two'].map(name=>({name,description:'synthetic',effect:'write' as const,resourceUnits:1,parameters,execute:async()=>{effects++;return{synthetic:true};}}));
  const f=await fixture({toolAdmission:{policyVersion:'synthetic-batch',correctionLimit:1,view:async()=>({version:'fixed',tools:tools.map(({name,parameters})=>({name,parameters}))})},transport:async()=>{
    physical++;
    if(physical<=2){assert.equal(effects,0);return{stop:'tools',content:tools.map((t,i)=>({kind:'tool',id:t.name+physical,name:t.name,arguments:physical===1&&i===0?{}:{value:1}})),usage:{inputTokens:1,outputTokens:1},outcome:outcome('tools')};}
    assert.equal(effects,2);return answer();
  }});
  const result=await f.run('tool-correction',{tools});assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(effects,2);assert.equal(physical,3);
  assert.ok(finished(f.events).every(f=>f.attempt.kind==='initial'));assert.equal(new Set(finished(f.events).map(f=>f.attempt.logicalRequestId)).size,3);
  assert.ok(result.toolAdmissions?.some(f=>f.disposition==='deferred'));assert.ok(result.toolAdmissions?.some(f=>f.correctionsUsed===1));
});

test('MA16 one host absolute 300s deadline cancels a later block before its independent 240s model clock',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  const controller=new AbortController(),deadline=Date.now()+300000;
  setTimeout(()=>controller.abort(),deadline-Date.now());
  let physical=0,start!:()=>void,finish!:()=>void;
  const started=new Promise<void>(r=>start=r),pending=new Promise<void>(r=>finish=r);
  const f=await fixture({transport:async()=>{if(++physical===1){t.mock.timers.tick(230000);return answer();}start();await pending;return answer();}});
  const selected={...limits,modelTimeoutMs:240000};
  assert.equal((await f.run('absolute-work',{limits:selected,signal:controller.signal})).status,'succeeded');
  const next=f.run('absolute-work',{limits:selected,signal:controller.signal});await started;
  t.mock.timers.tick(70001);const result=await next;assert.equal(result.status,'cancelled');assert.equal(physical,2);
  finish();await f.runtime.waitForIdle('absolute-work');assert.equal(finished(f.events).at(-1)!.late,true);
  assert.equal(Date.now(),deadline+1);assert.equal(f.events.some(e=>e.kind==='model.admitted'&&e.modelAttempt?.kind==='recovery'),false);
});
