import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as sdk from '../src/index.ts';

const model:sdk.ModelConfig={provider:'synthetic',id:'simplification',protocol:'openai-completions',endpoint:'https://offline.invalid',contextWindow:200000};
const limits={modelCalls:8,toolCalls:8,outputTokens:200,wallTimeMs:10000};
const answer=():sdk.ModelReply=>({content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}});
const call=(id:string,name:string,args:sdk.JsonObject):sdk.ModelReply=>({content:[{kind:'tool',id,name,arguments:args}],stop:'tools',usage:{inputTokens:1,outputTokens:1}});
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'pi-simplification-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const events:sdk.AuditEvent[]=[];
 const options:sdk.SessionRuntimeOptions={model,transport:async()=>answer(),budgets:sdk.createMemoryBudgetStore(),audit:{append:async e=>{events.push(e);}},authorize:async()=>true,
  bindOperation:async()=>{},reconcile:async()=> 'ready',storage:{directory:root,cwd:root,policyVersion:'synthetic-simplification',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})}};
 return {options,events};
}

test('S2 ordinary off consumes native edit compatibility preparation once without mutating input',async()=>{
 let bytes='value = 41\n',preparations=0,requests=0;
 const tools=sdk.createExecutionTools({cwd:'/synthetic',policyVersion:'synthetic-edit',resolvePath:async p=>p,
  read:async()=>Buffer.from(bytes),write:async(_p,next)=>{bytes=Buffer.from(next).toString();},stat:async p=>({path:p,name:'program.py',kind:'file',size:bytes.length,modifiedAt:0}),exec:async()=>{throw new sdk.RuntimeFault('CAPABILITY_UNAVAILABLE');}},['edit']);
 const prepare=tools[0]!.prepareArguments!;
 tools[0]={...tools[0]!,prepareArguments:args=>{preparations++;return prepare(args);}};
 const original={path:'program.py',edits:JSON.stringify({oldText:'41',newText:'42'})},before=structuredClone(original);
 const runtime=sdk.createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>++requests===1?call('edit-1','edit',original):answer()});
 const result=await runtime.runAgent({taskId:'ordinary-edit',prompt:'synthetic edit',tools,limits});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(bytes,'value = 42\n');assert.equal(preparations,1);assert.deepEqual(original,before);
 assert.equal(result.usage.toolCalls,1);assert.equal(requests,2);
});

test('S1 explicit trusted no-effect read failure remains an error and permits a new normal model step',async t=>{
 const {options,events}=await fixture(t);let requests=0;const paths:string[]=[];
 const tool:sdk.Tool={name:'read',description:'Synthetic read only',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},effect:'read',resourceUnits:1,
  execute:async(args,_signal,invocation)=>{
   paths.push(String(args.path));
   if(args.path==='missing'){
    const failure=Reflect.construct(sdk.ToolOutputFailure,[{name:'read',effect:'read',status:'completed',modelOutput:'failed',resourceUnits:1,invocation},'TOOL_FAILED',{effect:'none',code:'not_found'}]);
    failure.message='PRIVATE_EXCEPTION_DETAIL';throw failure;
   }
   return {text:'synthetic content'};
  }};
 const runtime=sdk.createSessionRuntime({...options,...{toolFeedback:{policyVersion:'safe-read-v1',tools:['read']}},transport:async request=>{
  if(++requests===1)return call('missing-read','read',{path:'missing'});
  if(requests===2){const feedback=request.messages.find(m=>m.role==='tool');assert.equal(feedback?.toolFailed,true);assert.deepEqual(JSON.parse(feedback!.text),{status:'error',code:'not_found',executed:false});assert.doesNotMatch(JSON.stringify(request.messages),/PRIVATE_EXCEPTION_DETAIL/);return call('valid-read','read',{path:'valid'});}
  return answer();
 }}),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'trusted-read',prompt:'synthetic only',tools:[tool],limits,modelRecovery:{extraAttempts:0}});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.deepEqual(paths,['missing','valid']);assert.equal(requests,3);assert.equal(result.usage.modelCalls,3);assert.equal(result.usage.toolCalls,2);
 const first=events.find(e=>e.kind==='tool.finished');assert.equal(first?.toolFailed,true);assert.equal(first?.toolOutcome?.status,'completed');assert.equal(first?.toolOutcome?.modelOutput,'failed');
 assert.doesNotMatch(JSON.stringify(events),/PRIVATE_EXCEPTION_DETAIL|executed|feedback/);
 assert.equal((await runtime.history(session.id)).find(e=>e.message?.role==='tool')?.message?.toolFailed,true);
});

for(const admission of [false,true])test(`S2 persistent ${admission?'on':'off'} prepares compatible edits once before executing`,async t=>{
 const {options}=await fixture(t);let bytes='value = 41\n',preparations=0,requests=0;
 const tools=sdk.createExecutionTools({cwd:'/synthetic',policyVersion:'synthetic-edit',resolvePath:async p=>p,
  read:async()=>Buffer.from(bytes),write:async(_p,next)=>{bytes=Buffer.from(next).toString();},stat:async p=>({path:p,name:'program.py',kind:'file',size:bytes.length,modifiedAt:0}),exec:async()=>{throw new sdk.RuntimeFault('CAPABILITY_UNAVAILABLE');}},['edit']);
 const prepare=tools[0]!.prepareArguments!;tools[0]={...tools[0]!,prepareArguments:args=>{preparations++;return prepare(args);}};
 if(admission)options.toolAdmission={policyVersion:'synthetic-on',correctionLimit:1,view:async()=>({version:'one',tools:tools.map(({name,parameters})=>({name,parameters}))})};
 const original={path:'program.py',oldText:'41',newText:'42'};
 options.transport=async()=>++requests===1?call('edit-1','edit',original):answer();
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create(),result=await runtime.run({sessionId:session.id,taskId:'edit-'+admission,prompt:'synthetic',tools,limits});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(bytes,'value = 42\n');assert.equal(preparations,1);assert.deepEqual(original,{path:'program.py',oldText:'41',newText:'42'});
});

test('S2 ordinary off preserves coercion and rejects a later malformed call before any batch effect',async()=>{
 let effects=0,requests=0;
 const tool:sdk.Tool={name:'lookup',description:'synthetic',effect:'read',argumentPolicy:'strict',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async args=>{assert.deepEqual(args,{id:'7'});effects++;return{};}};
 const runtime=sdk.createRuntime({model,audit:{append:async()=>{}},authorize:async()=>true,transport:async()=>++requests===1?call('one','lookup',{id:7}):answer()});
 assert.equal((await runtime.runAgent({taskId:'old-coercion',prompt:'synthetic',tools:[tool],limits})).status,'succeeded');assert.equal(effects,1);
 const batch=sdk.createRuntime({model,audit:{append:async()=>{}},authorize:async()=>true,transport:async()=>({...call('first','lookup',{}),content:[{kind:'tool',id:'first',name:'lookup',arguments:{id:7}},{kind:'tool',id:'second',name:'lookup',arguments:{id:'8',extra:true}}]})});
 const rejected=await batch.runAgent({taskId:'invalid-batch',prompt:'synthetic',tools:[tool],limits});
 assert.equal(rejected.status!=='succeeded'&&rejected.reason,'INVALID_TOOL');assert.equal(effects,1);assert.equal(rejected.usage.toolCalls,0);
});

for(const invalid of [false,true])test(`S2 persistent off preserves native hook replacement and revalidation (${invalid?'invalid':'valid'})`,async t=>{
 const {options}=await fixture(t);let requests=0,effects=0;
 options.harness={extensionVersion:'synthetic-hooks-v1'};
 options.extensions={beforeTool:async input=>{assert.deepEqual(input.arguments,{id:'7'});return{arguments:invalid?{extra:true}:{id:8}};}};
 options.transport=async request=>{if(++requests===1)return call('lookup-1','lookup',{id:7});if(invalid)assert.equal(request.messages.find(m=>m.role==='tool')?.toolFailed,true);return answer();};
 const tool:sdk.Tool={name:'lookup',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async args=>{assert.deepEqual(args,{id:'8'});effects++;return{};}};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create(),result=await runtime.run({sessionId:session.id,taskId:'hook-'+invalid,prompt:'synthetic',tools:[tool],limits});
 assert.equal(result.status,'succeeded');assert.equal(effects,invalid?0:1);assert.equal(result.usage.toolCalls,invalid?0:1);assert.equal(requests,2);
});

for(const variant of ['default','plain','forged','unproven','name','units','invocation','unknown','receipt','write','category','unsafe','not-listed','projection','revoked','audit','ledger','bind','cancel'] as const)
test(`S1 ${variant} retains hard stop without exposing private errors or another model dispatch`,async t=>{
 const {options,events}=await fixture(t);let requests=0,effects=0,allowed=true;const controller=new AbortController();
 options.authorize=async()=>allowed;
 if(variant==='audit')options.audit={append:async e=>{if(e.kind==='tool.finished')throw Error('PRIVATE_AUDIT');events.push(e);}};
 if(variant==='ledger'){const budgets=options.budgets;options.budgets={claim:async(...args)=>{const lease=await budgets.claim(...args);return{...lease,reserveTool:async()=>{throw Error('PRIVATE_LEDGER');}};}};}
 if(variant==='bind')options.bindOperation=async()=>{throw new sdk.RuntimeFault('STATE_FAILED');};
 const failure=(invocation:sdk.ToolExecutionContext|undefined):Error=>{
  const outcome:sdk.ToolOutcome={name:variant==='name'?'other':'read',effect:variant==='write'?'write':'read',status:variant==='unknown'?'unknown':'completed',modelOutput:'failed',resourceUnits:variant==='units'?2:1,
   ...(invocation?{invocation:{...invocation,invocationId:variant==='invocation'?'other':invocation.invocationId}}:{}),...(variant==='receipt'?{receiptId:'real-receipt'}:{}),...(variant==='category'?{failureCategory:'permission_denied' as const}:{})};
  const feedback={effect:'none',code:'not_found',...(variant==='unsafe'?{text:'PRIVATE_CONTENT'}:{})};
  if(variant==='plain')return Object.assign(Error('PRIVATE_EXCEPTION'),{outcome,feedback});
  if(variant==='forged')return Object.assign(new sdk.ToolOutputFailure(outcome),{feedback});
  if(variant==='unproven')return new sdk.ToolOutputFailure(outcome);
  const error:Error=Reflect.construct(sdk.ToolOutputFailure,[outcome,'TOOL_FAILED',feedback]);error.message='PRIVATE_EXCEPTION';return error;
 };
 const tool:sdk.Tool={name:'read',description:'synthetic',effect:variant==='write'?'write':'read',resourceUnits:1,parameters:{type:'object'},
  ...(variant==='projection'?{modelOutput:{policyVersion:'synthetic-projection',maxBytes:100,project:async input=>{throw failure(input.invocation);}}}:{}),
  execute:async(_args,_signal,invocation)=>{effects++;if(variant==='projection')return{};if(variant==='revoked')allowed=false;if(variant==='cancel')controller.abort();throw failure(invocation);}};
 const policy=variant==='default'?{}:{toolFeedback:{policyVersion:'safe-v1',tools:[variant==='not-listed'?'other':'read']}};
 const runtime=sdk.createSessionRuntime({...options,...policy,transport:async()=>++requests===1?call('one','read',{}):answer()}),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'stop-'+variant,prompt:'synthetic',tools:[tool],limits,signal:controller.signal});
 assert.notEqual(result.status,'succeeded',JSON.stringify(result));assert.equal(requests,variant==='bind'?0:1);assert.equal(effects,['bind','ledger'].includes(variant)?0:1);
 const expected:Partial<Record<typeof variant,sdk.Reason>>={audit:'AUDIT_FAILED',ledger:'STATE_FAILED',bind:'STATE_FAILED',cancel:'CANCELLED',revoked:'AUTHORITY_REQUIRED'};
 if(expected[variant])assert.equal(result.status!=='succeeded'&&result.reason,expected[variant]);
 assert.doesNotMatch(JSON.stringify(events),/PRIVATE_/);
 if(variant==='default'){assert.equal('toolOutcomes' in result,false);assert.equal(events.some(e=>e.toolOutcome),false);}
 if(variant==='projection'){assert.equal(result.toolOutcomes?.[0]?.status,'completed');assert.equal(result.toolOutcomes?.[0]?.modelOutput,'failed');}
 if(variant==='plain'||variant==='forged')assert.equal(result.toolOutcomes?.[0]?.status,variant==='plain'?'unknown':'completed');
});

for(const reason of ['AUTHORITY_REQUIRED','AUDIT_FAILED','STATE_FAILED','CANCELLED','DEADLINE_EXCEEDED','BUDGET_EXHAUSTED'] as const)
test(`S1 conflicting structured ${reason} cannot authorize feedback continuation`,async t=>{
 const {options}=await fixture(t);let requests=0,executions=0;
 const tool:sdk.Tool={name:'read',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object'},execute:async(_args,_signal,invocation)=>{
  executions++;throw new sdk.ToolOutputFailure({name:'read',effect:'read',status:'completed',modelOutput:'failed',resourceUnits:1,reason,...(invocation?{invocation}:{})},undefined,{effect:'none',code:'invalid'});
 }};
 const runtime=sdk.createSessionRuntime({...options,toolFeedback:{policyVersion:'safe-v1',tools:['read']},transport:async()=>++requests===1?call('read-one','read',{}):answer()}),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'conflict-'+reason,prompt:'synthetic',tools:[tool],limits});
 assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.reason,'INVALID_OUTPUT');
 assert.equal(requests,1);assert.equal(executions,1);assert.equal(result.usage.toolCalls,1);
});

test('S1 cancelled physical read retains returned UNKNOWN and rejects late trusted feedback',async t=>{
 const {options,events}=await fixture(t);const controller=new AbortController();let requests=0,entered!:()=>void,release!:()=>void;
 const began=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const tool:sdk.Tool={name:'read',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object'},execute:async(_args,_signal,invocation)=>{entered();await gate;throw new sdk.ToolOutputFailure({name:'read',effect:'read',status:'completed',modelOutput:'failed',resourceUnits:1,...(invocation?{invocation}:{})},'TOOL_FAILED',{effect:'none',code:'not_found'});}};
 const runtime=sdk.createSessionRuntime({...options,toolFeedback:{policyVersion:'safe-v1',tools:['read']},transport:async()=>{requests++;return call('read-one','read',{});}}),session=await runtime.create();
 const pending=runtime.run({sessionId:session.id,taskId:'late-feedback',prompt:'synthetic',tools:[tool],limits,signal:controller.signal});await began;controller.abort();
 const result=await pending,before=JSON.stringify(result);assert.equal(result.status,'cancelled');assert.equal(result.toolOutcomes?.[0]?.status,'unknown');
 release();await runtime.waitForIdle('late-feedback');assert.equal(JSON.stringify(result),before);assert.equal(requests,1);assert.equal(events.filter(e=>e.kind==='tool.finished').length,1);
});

for(const entry of ['plain','inherited','checkpoint','deferred'] as const)test(`S1 ${entry} unsupported combination rejects before model effects`,async t=>{
 const {options}=await fixture(t);let requests=0;const policy:sdk.ToolFeedbackPolicy={policyVersion:'safe-v1',tools:['read']};
 const host={...options,toolFeedback:policy,transport:async()=>{requests++;return answer();}};
 let result:sdk.RunResult<string>;
 if(entry==='plain')result=await sdk.createRuntime(host).runAgent({taskId:entry,prompt:'synthetic',tools:[],limits});
 else {const runtime=sdk.createSessionRuntime({...host,...(entry==='deferred'?{harness:{deferred:true},model:{...model,deferred:true}}:{})}),session=await runtime.create();
  result=entry==='inherited'?await runtime.runAgent({taskId:entry,prompt:'synthetic',tools:[],limits}):entry==='checkpoint'?await runtime.runAgent({taskId:entry,prompt:'synthetic',tools:[],limits,saveCheckpoint:async()=>{}}):await runtime.run({sessionId:session.id,taskId:entry,prompt:'synthetic',tools:[],limits});}
 assert.equal(result.status!=='succeeded'&&result.reason,'CAPABILITY_UNAVAILABLE');assert.equal(requests,0);
});

test('S1 feedback policy has a new pinned configuration and cannot change after construction',async t=>{
 const {options}=await fixture(t);const policy={policyVersion:'safe-v1',tools:['read']},ids:string[]=[];const budgets=options.budgets;
 options.budgets={claim:async(task,owner,id,limits)=>{ids.push(id);return budgets.claim(task,owner,id,limits);}};
 const runtime=sdk.createSessionRuntime({...options,toolFeedback:policy}),session=await runtime.create();policy.tools.push('other');policy.policyVersion='changed';
 const request={sessionId:session.id,taskId:'pinned-feedback',prompt:'synthetic',tools:[],limits};assert.equal((await runtime.run(request)).status,'succeeded');
 const same=sdk.createSessionRuntime({...options,toolFeedback:{policyVersion:'safe-v1',tools:['read']}});assert.equal((await same.run(request)).status,'succeeded');assert.equal(ids[0],ids[1]);
 const changed=await sdk.createSessionRuntime({...options,toolFeedback:{policyVersion:'safe-v2',tools:['read']}}).run(request);assert.equal(changed.status!=='succeeded'&&changed.reason,'CONFIGURATION_CHANGED');
 const removed=await sdk.createSessionRuntime(options).run(request);assert.equal(removed.status!=='succeeded'&&removed.reason,'CONFIGURATION_CHANGED');
});

test('S2 ordinary toolAdmission remains unavailable',async()=>{
 let requests=0;const runtime=sdk.createRuntime({model,transport:async()=>{requests++;return answer();},authorize:async()=>true,audit:{append:async()=>{}},toolAdmission:{policyVersion:'synthetic',correctionLimit:1,view:async()=>({version:'one',tools:[]})}});
 const result=await runtime.runAgent({taskId:'ordinary-on',prompt:'synthetic',tools:[],limits});assert.equal(result.status!=='succeeded'&&result.reason,'CAPABILITY_UNAVAILABLE');assert.equal(requests,0);
});

test('S1 trusted feedback composes with current tool admission and preserves its accounting',async t=>{
 const {options}=await fixture(t);let requests=0,executions=0;
 const tool:sdk.Tool={name:'read',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},execute:async(args,_signal,invocation)=>{
  executions++;if(args.path==='missing')throw new sdk.ToolOutputFailure({name:'read',effect:'read',status:'completed',modelOutput:'failed',resourceUnits:1,...(invocation?{invocation}:{})},'TOOL_FAILED',{effect:'none',code:'not_found'});return{};
 }};
 options.toolAdmission={policyVersion:'synthetic-admission',correctionLimit:1,view:async()=>({version:'one',tools:[{name:'read',parameters:tool.parameters}]})};
 const runtime=sdk.createSessionRuntime({...options,toolFeedback:{policyVersion:'safe-v1',tools:['read']},transport:async request=>{
  if(++requests===1)return call('invalid','read',{});
  if(requests===2){assert.equal(executions,0);return call('missing','read',{path:'missing'});}
  if(requests===3){assert.equal(request.messages.findLast(m=>m.role==='tool')?.toolFailed,true);return call('valid','read',{path:'valid'});}
  return answer();
 }}),session=await runtime.create(),result=await runtime.run({sessionId:session.id,taskId:'feedback-admission',prompt:'synthetic',tools:[tool],limits,modelRecovery:{extraAttempts:0}});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.usage.modelCalls,4);assert.equal(result.usage.toolCalls,2);assert.equal(executions,2);
 assert.deepEqual(result.toolAdmissions?.map(f=>f.disposition),['rejected','ready','ready']);
});

test('S1 tool deadline keeps physical UNKNOWN and refuses late feedback',async t=>{
 const {options}=await fixture(t);let requests=0;
 const tool:sdk.Tool={name:'read',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object'},execute:async(_args,_signal,invocation)=>{
  await new Promise(r=>setTimeout(r,60));throw new sdk.ToolOutputFailure({name:'read',effect:'read',status:'completed',modelOutput:'failed',resourceUnits:1,...(invocation?{invocation}:{})},'TOOL_FAILED',{effect:'none',code:'not_found'});
 }};
 const runtime=sdk.createSessionRuntime({...options,toolFeedback:{policyVersion:'safe-v1',tools:['read']},transport:async()=>{requests++;return call('read-one','read',{});}}),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'deadline-feedback',prompt:'synthetic',tools:[tool],limits:{cumulative:'unlimited',maxOutputTokens:20,modelTimeoutMs:1000,toolTimeoutMs:15,controlTimeoutMs:1000}}),before=JSON.stringify(result);
 assert.equal(result.status!=='succeeded'&&result.reason,'DEADLINE_EXCEEDED');assert.equal(result.toolOutcomes?.[0]?.status,'unknown');await runtime.waitForIdle('deadline-feedback');assert.equal(requests,1);assert.equal(JSON.stringify(result),before);
});
