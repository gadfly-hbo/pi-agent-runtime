import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,appendFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as sdk from '../src/index.ts';

const model:sdk.ModelConfig={provider:'synthetic',id:'first-loop',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:200000};
const limits={cumulative:'unlimited' as const,maxOutputTokens:32768,modelTimeoutMs:600000,toolTimeoutMs:300000,controlTimeoutMs:30000};
const answer=(text='done'):sdk.ModelReply=>({content:[{kind:'text',text}],stop:'complete',usage:{inputTokens:1,outputTokens:1}});
const call=(id:string,name:string,args:sdk.JsonObject):sdk.ModelReply=>({content:[{kind:'tool',id,name,arguments:args}],stop:'tools',usage:{inputTokens:1,outputTokens:1}});
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'pi-first-loop-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let held=false;
 const options:sdk.SessionRuntimeOptions={model,transport:async()=>answer(),budgets:sdk.createMemoryBudgetStore(),audit:{append:async()=>{}},authorize:async()=>true,bindOperation:async()=>{},reconcile:async()=> 'ready',storage:{directory:root,cwd:root,policyVersion:'synthetic-first-loop',authorize:async()=>true,acquireWriter:async()=>{if(held)throw new sdk.RuntimeFault('TASK_BUSY');held=true;return{release:async()=>{held=false;}};}}};
 return{options,root};
}

test('TA01 same trusted phase schema reaches model and native execution; approved native preparation returns actual values',async t=>{
 const {options}=await fixture(t);let stage=1,requests=0;const effects:sdk.JsonObject[]=[];
 const tool:sdk.Tool={name:'interpret_meaning',description:'synthetic identity',effect:'write',resourceUnits:1,argumentPolicy:'native',parameters:{type:'object',properties:{sheet_id:{type:'string'}},required:['sheet_id'],additionalProperties:false},execute:async(args)=>{effects.push(args);stage=2;return{saved:true};}};
 (options as any).toolAdmission={policyVersion:'approved-first-loop-v1',correctionLimit:1,view:async()=>({version:'phase-'+stage,tools:stage===1?[{name:tool.name,parameters:{...tool.parameters,properties:{sheet_id:{type:'string',enum:['1','2']}}}}]:[]})};
 options.transport=async request=>{requests++;const visible=request.messages.flatMap(m=>m.tools??[]);
  if(requests===1){assert.equal(visible.length,1);const phase=(visible[0]!.parameters.allOf as sdk.JsonObject[])[1]!;assert.deepEqual((phase.properties as any).sheet_id.enum,['1','2']);assert.deepEqual((visible[0]!.parameters.allOf as sdk.JsonObject[])[0],tool.parameters);return call('interpret-1',tool.name,{sheet_id:1});}
  assert.equal(visible.length,0);return answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'phase-task',prompt:'synthetic only',tools:[tool],limits});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.deepEqual(effects,[{sheet_id:'1'}]);assert.equal(requests,2);
});

test('TA02 invalid later tool defers the whole batch, safe native feedback permits one explicit correction',async t=>{
 const {options}=await fixture(t);let requests=0;const effects:string[]=[];
 const tools:sdk.Tool[]=[{name:'save',description:'synthetic save',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects.push('save');return{ok:true};}},
 {name:'read_analysis_evidence',description:'synthetic evidence contract',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{required_plans:{type:'array',items:{type:'object',properties:{version:{type:'string'},sheet_id:{type:'string'},group_by:{type:'array',items:{type:'string'}}},required:['version','sheet_id','group_by'],additionalProperties:false}}},required:['required_plans'],additionalProperties:false},execute:async()=>{effects.push('evidence');return{verified:true};}}];
 options.toolAdmission={policyVersion:'strict-evidence-v1',correctionLimit:1,view:async()=>({version:'phase-1',tools:tools.map(({name,parameters})=>({name,parameters}))})};
 options.transport=async request=>{
  if(++requests===1)return{...call('save-1','save',{}),content:[{kind:'tool',id:'save-1',name:'save',arguments:{}},{kind:'tool',id:'evidence-1',name:'read_analysis_evidence',arguments:{required_plans:[{version:1,sheet_id:1,PRIVATE_DYNAMIC_KEY:'SYNTHETIC_SECRET'}]}}]};
  if(requests===2){assert.deepEqual(effects,[]);const feedback=request.messages.filter(m=>m.role==='tool').map(m=>m.text).join('\n');assert.match(feedback,/STRUCTURE_MISMATCH/);assert.doesNotMatch(feedback,/SYNTHETIC_SECRET|PRIVATE_DYNAMIC_KEY|Received arguments/);return call('evidence-2','read_analysis_evidence',{required_plans:[{version:'1',sheet_id:'1',group_by:[]}]});}
  return answer();
 };
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'batch-task',prompt:'synthetic only',tools,limits});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.deepEqual(effects,['evidence']);assert.equal(result.usage.toolCalls,1);
});

test('TA03 reopening and forking preserve the task/tool correction allowance and close terminal dispatch',async t=>{
 const {options}=await fixture(t);let requests=0;
 const tool:sdk.Tool={name:'evidence',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{version:{type:'string'}},required:['version'],additionalProperties:false},execute:async()=>({ok:true})};
 options.toolAdmission={policyVersion:'durable-correction-v1',correctionLimit:1,view:async()=>({version:'phase-1',tools:[{name:tool.name,parameters:tool.parameters}]})};
 options.transport=async()=>{requests++;if(requests===1||requests>=4)return call('call-'+requests,tool.name,{version:1});if(requests===2)return call('call-2',tool.name,{version:'1'});return answer();};
 const first=sdk.createSessionRuntime(options),session=await first.create(),request={sessionId:session.id,taskId:'same-task',prompt:'synthetic',tools:[tool],limits};
 assert.equal((await first.run(request)).status,'succeeded');
 const restarted=sdk.createSessionRuntime(options),fork=await restarted.fork(session.id);
 const rejected=await restarted.run({...request,sessionId:fork.id});
 assert.equal(rejected.status,'failed');assert.equal(rejected.reason,'INVALID_TOOL');assert.equal(requests,4);
 const again=await sdk.createSessionRuntime(options).run(request);
 assert.equal(again.status,'failed');assert.equal(requests,4,'terminal task must not dispatch another request');
});

test('TA04 passive facts read native state without a writer, repair, model dispatch or file changes',async t=>{
 const {options,root}=await fixture(t);let requests=0,writers=0;
 const acquire=options.storage.acquireWriter;options.storage.acquireWriter=async signal=>{writers++;return acquire(signal);};
 options.transport=async()=>{requests++;return answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 await runtime.run({sessionId:session.id,taskId:'passive',prompt:'synthetic',tools:[],limits});
 const files=await readdir(root,{recursive:true}),file=join(root,files.find(f=>f.endsWith('.jsonl'))!);
 const before=await readFile(file),beforeWriters=writers;
 const inspect=Reflect.get(runtime,'inspectFacts');assert.equal(typeof inspect,'function');
 const facts=await inspect({sessionId:session.id,taskId:'passive'});
 assert.equal(facts.availability,'available');assert.equal(facts.queue.availability,'unknown');assert.equal(facts.admission.availability,'unknown');
 assert.equal(writers,beforeWriters);assert.equal(requests,1);assert.deepEqual(await readFile(file),before);
 await appendFile(file,'{"torn":');const torn=await readFile(file);
 assert.equal((await inspect({sessionId:session.id,taskId:'passive'})).availability,'corrupt');
 assert.deepEqual(await readFile(file),torn);assert.equal(writers,beforeWriters);assert.equal(requests,1);
});

test('TA05 native edit compatibility preparation is called once on a copy before the batch barrier',async t=>{
 const {options}=await fixture(t);const files=new Map<string,string>([['/synthetic/program.py','value = 41\n']]);let preparations=0,requests=0;
 const tools=sdk.createExecutionTools({cwd:'/synthetic',policyVersion:'draft-synthetic',resolvePath:async p=>p.startsWith('/')?p:'/synthetic/'+p,read:async p=>Buffer.from(files.get(p)!),write:async(p,b)=>{files.set(p,Buffer.from(b).toString());},stat:async p=>({path:p,name:'program.py',kind:'file',size:files.get(p)!.length,modifiedAt:0}),exec:async()=>{throw new sdk.RuntimeFault('CAPABILITY_UNAVAILABLE');}},['edit']);
 const nativePrepare=Reflect.get(tools[0]!,'prepareArguments');
 assert.equal(typeof nativePrepare,'function','factory must preserve the native tool preparation');
 tools[0]={...tools[0]!,prepareArguments:args=>{preparations++;return nativePrepare!(args);}};
 const original={path:'program.py',edits:JSON.stringify({oldText:'41',newText:'42'})};
 options.toolAdmission={policyVersion:'factory-prepare-v1',correctionLimit:1,view:async()=>({version:'draft',tools:tools.map(({name,parameters})=>({name,parameters}))})};
 options.transport=async()=>++requests===1?call('edit-1','edit',original):answer();
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 assert.equal((await runtime.run({sessionId:session.id,taskId:'native-edit',prompt:'synthetic',tools,limits})).status,'succeeded');
 assert.equal(files.get('/synthetic/program.py'),'value = 42\n');assert.equal(preparations,1);assert.equal(typeof original.edits,'string');
});

test('TA06 stale view rejects all effects and leaves a passive terminal fact without another dispatch',async t=>{
 const {options}=await fixture(t);let stage=1,requests=0,effects=0;
 const tool:sdk.Tool={name:'save',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return{};}};
 options.toolAdmission={policyVersion:'stale-view-v1',correctionLimit:1,view:async()=>({version:'phase-'+stage,tools:[{name:tool.name,parameters:tool.parameters}]})};
 options.transport=async()=>{requests++;stage=2;return call('stale-call',tool.name,{});};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create(),request={sessionId:session.id,taskId:'stale',prompt:'synthetic',tools:[tool],limits};
 const rejected=await runtime.run(request);assert.equal(rejected.status,'failed');assert.equal(effects,0);
 assert.equal(rejected.toolAdmissions?.[0]?.code,'STALE_VIEW');
 const facts=await runtime.inspectFacts({sessionId:session.id,taskId:'stale'});assert.equal(facts.availability,'available');
 if(facts.availability==='available'){assert.equal(facts.admission.availability,'known');if(facts.admission.availability==='known')assert.equal(facts.admission.terminal,true);}
 await sdk.createSessionRuntime(options).run(request);assert.equal(requests,1);
});

test('TA07 runtime captures the approved correction policy; caller mutation cannot grant an extra request',async t=>{
 const {options}=await fixture(t);let requests=0;
 const tool:sdk.Tool={name:'check',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async()=>({ok:true})};
 const policy:sdk.ToolAdmissionPolicy={policyVersion:'fixed-zero-corrections',correctionLimit:0,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};options.toolAdmission=policy;
 options.transport=async()=>{policy.correctionLimit=1;return call('call-'+(++requests),tool.name,{id:1});};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'fixed-policy',prompt:'synthetic',tools:[tool],limits});
 assert.equal(result.status,'failed');assert.equal(requests,1);
});

test('TA08 rejected duplicate batch never persists raw arguments in an ordinary native error',async t=>{
 const {options,root}=await fixture(t);let effects=0;
 const tool:sdk.Tool={name:'save',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{secret:{type:'string'}},required:['secret'],additionalProperties:false},execute:async()=>{effects++;return{};}};
 options.toolAdmission={policyVersion:'duplicate-safe-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};
 options.transport=async()=>({...call('duplicate','save',{}),content:[{kind:'tool',id:'duplicate',name:'save',arguments:{secret:'PRIVATE_REJECTED_VALUE'}},{kind:'tool',id:'duplicate',name:'save',arguments:{secret:'PRIVATE_REJECTED_VALUE'}}]});
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'duplicate',prompt:'synthetic',tools:[tool],limits});
 assert.equal(result.status,'failed');assert.equal(effects,0);
 for(const file of await readdir(root,{recursive:true}))if(file.endsWith('.jsonl'))assert.doesNotMatch(await readFile(join(root,file),'utf8'),/PRIVATE_REJECTED_VALUE/);
});

test('TA09 passive storage denial or exception returns bounded unavailable facts',async t=>{
 const {options}=await fixture(t);let denied=false;
 options.storage.authorize=async()=>{if(denied)throw Error('PRIVATE_STORAGE_MESSAGE');return true;};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();denied=true;
 assert.deepEqual(await runtime.inspectFacts({sessionId:session.id,taskId:'passive'}),{availability:'unavailable',reason:'AUTHORITY_REQUIRED'});
});

for(const mode of ['replace','block','throw'] as const)test('TA10 hook '+mode+' cannot bypass whole-batch validation',async t=>{
 const {options}=await fixture(t);let effects=0,requests=0;
 const tools:sdk.Tool[]=['first','second'].map(name=>({name,description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async()=>{effects++;return{};}}));
 options.toolAdmission={policyVersion:'hook-barrier-v1',correctionLimit:0,view:async()=>({version:'phase',tools:tools.map(({name,parameters})=>({name,parameters}))})};
 options.harness={extensionVersion:'synthetic-hook-v1'};
 options.extensions={beforeTool:async({name})=>{if(name==='first')return;if(mode==='replace')return{arguments:{id:2}};if(mode==='block')return{block:'PRIVATE_BLOCK_MESSAGE'};throw Error('PRIVATE_HOOK_MESSAGE');}};
 options.transport=async()=>{requests++;return{...call('one','first',{}),content:[{kind:'tool',id:'one',name:'first',arguments:{id:'1'}},{kind:'tool',id:'two',name:'second',arguments:{id:'2'}}]};};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'hook-'+mode,prompt:'synthetic',tools,limits});
 assert.equal(result.status,'failed');assert.equal(effects,0);assert.equal(requests,1);assert.equal(result.usage.toolCalls,0);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

for(const argumentPolicy of ['strict','native'] as const)test('TA11 full schema matrix through actual Session '+argumentPolicy,async t=>{
 const {options}=await fixture(t);const schema:sdk.JsonObject={type:'object',properties:{sheet_id:{type:'string',enum:['01','1']},count:{type:'integer'},choice:{anyOf:[{type:'string'},{type:'null'}]},nested:{type:'object',properties:{group_by:{type:'array',items:{type:'string'}}},required:['group_by'],additionalProperties:false}},required:['sheet_id','count','choice','nested'],additionalProperties:false};
 const good={sheet_id:'01',count:2,choice:null,nested:{group_by:[]}};
 const samples=[{args:good,ok:true},{args:{...good,sheet_id:1,count:'2'},ok:argumentPolicy==='native'},
  {args:{...good,sheet_id:'001'},ok:false},{args:{...good,count:'NaN'},ok:false},{args:{...good,sheet_id:null},ok:false},
  {args:{sheet_id:'01',count:2,nested:{group_by:[]}},ok:false},{args:{...good,nested:{}},ok:false},{args:{...good,extra:'private'},ok:false}];
 for(const [index,sample]of samples.entries()){
  let requests=0,received:sdk.JsonObject|undefined;
  const tool:sdk.Tool={name:'evidence',description:'synthetic',argumentPolicy,effect:'read',resourceUnits:1,parameters:schema,execute:async args=>{received=args;return{};}};
  options.toolAdmission={policyVersion:'schema-matrix-v1',correctionLimit:0,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:schema}]})};
  options.transport=async()=>++requests===1?call('case-'+index,tool.name,sample.args as sdk.JsonObject):answer();
  const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
  const result=await runtime.run({sessionId:session.id,taskId:'matrix-'+index,prompt:'synthetic',tools:[tool],limits});
  assert.equal(result.status,sample.ok?'succeeded':'failed',JSON.stringify({argumentPolicy,index,result}));
  if(sample.ok)assert.deepEqual(received,index===1?{...good,sheet_id:'1'}:good);else assert.equal(received,undefined);
 }
});

test('TA12 passive busy is explicit; pre-cancel and tool denial produce no business draft',async t=>{
 const {options}=await fixture(t);let begin!:()=>void,finish!:()=>void,effects=0;
 const ready=new Promise<void>(r=>begin=r),pending=new Promise<void>(r=>finish=r);
 options.transport=async()=>{begin();await pending;return answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const request={sessionId:session.id,taskId:'busy-passive',prompt:'synthetic',tools:[],limits};
 const running=runtime.run(request);await ready;assert.deepEqual(await runtime.inspectFacts({sessionId:session.id,taskId:request.taskId}),{availability:'busy'});finish();await running;
 const cancelled=await runtime.run({...request,taskId:'pre-cancel',signal:AbortSignal.abort()});assert.equal(cancelled.status,'cancelled');
 const tool:sdk.Tool={name:'draft',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return{};}};
 options.authorize=async action=>action.kind!=='tool';options.transport=async()=>call('draft-call',tool.name,{});
 options.toolAdmission={policyVersion:'deny-effects-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};
 const denied=await sdk.createSessionRuntime(options).run({...request,taskId:'denied-draft',tools:[tool]});
 assert.equal(denied.status,'blocked');assert.equal(effects,0);assert.equal(denied.usage.toolCalls,0);
});

test('TA13 stage changes during preparation hooks invalidate the whole batch before effects',async t=>{
 const {options}=await fixture(t);let stage=1,effects=0;
 const tool:sdk.Tool={name:'save',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return{};}};
 options.toolAdmission={policyVersion:'hook-stage-v1',correctionLimit:0,view:async()=>({version:'phase-'+stage,tools:[{name:tool.name,parameters:tool.parameters}]})};
 options.harness={extensionVersion:'hook-stage-v1'};options.extensions={beforeTool:async()=>{stage=2;return undefined;}};
 options.transport=async()=>call('once',tool.name,{});
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'hook-stage',prompt:'synthetic',tools:[tool],limits});
 assert.equal(effects,0);assert.equal(result.toolAdmissions?.at(-1)?.code,'STALE_VIEW');assert.equal(result.status,'failed');
});

test('TA14 a fork made before a task first appears cannot reset later task correction counts',async t=>{
 const {options}=await fixture(t);let requests=0;
 const tool:sdk.Tool={name:'evidence',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async()=>({})};
 options.toolAdmission={policyVersion:'fork-lineage-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};
 options.transport=async()=>{requests++;return requests===2||requests===4?call('once-'+requests,tool.name,{id:1}):answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create(),request={sessionId:session.id,taskId:'seed',prompt:'synthetic',tools:[tool],limits};
 assert.equal((await runtime.run(request)).status,'succeeded');const fork=await runtime.fork(session.id);
 assert.equal((await runtime.run({...request,taskId:'later-task'})).status,'succeeded');
 const result=await runtime.run({...request,sessionId:fork.id,taskId:'later-task'});assert.equal(result.status,'failed');assert.equal(requests,4);
});

test('TA15 passive facts reject malformed native result values instead of exposing arbitrary stored fields',async t=>{
 const {options,root}=await fixture(t);let requests=0;
 const tool:sdk.Tool={name:'check',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>({})};
 options.toolAdmission={policyVersion:'corrupt-read-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};options.transport=async()=>++requests===1?call('checked',tool.name,{}):answer();
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();await runtime.run({sessionId:session.id,taskId:'corrupt',prompt:'synthetic',tools:[tool],limits});
 const file=join(root,(await readdir(root,{recursive:true})).find(f=>f.endsWith('.jsonl'))!);
 const corrupt=(await readFile(file,'utf8')).split('\n').map(line=>{if(!line)return line;const rows=JSON.parse(line);for(const row of Array.isArray(rows)?rows:[rows])if(row.namespace==='pi.result'&&row.op==='set')row.value.status={private:'PRIVATE_NATIVE_VALUE'};return JSON.stringify(rows);}).join('\n');await writeFile(file,corrupt);
 const facts=await runtime.inspectFacts({sessionId:session.id,taskId:'corrupt'});assert.equal(facts.availability,'corrupt');assert.doesNotMatch(JSON.stringify(facts),/PRIVATE_NATIVE_VALUE/);assert.equal(await readFile(file,'utf8'),corrupt);
});

test('TA16 stage schema cannot widen the fixed true Tool acceptance upper bound',async t=>{
 const {options}=await fixture(t);let effects=0;
 const tool:sdk.Tool={name:'read',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{path:{type:'string',enum:['allowed.txt']}},required:['path'],additionalProperties:false},execute:async()=>{effects++;return{};}};
 options.toolAdmission={policyVersion:'upper-bound-v1',correctionLimit:0,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]})};options.transport=async()=>call('once',tool.name,{path:'forbidden.txt'});
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();const result=await runtime.run({sessionId:session.id,taskId:'upper',prompt:'synthetic',tools:[tool],limits});assert.equal(effects,0);assert.equal(result.status,'failed');assert.equal(result.usage.toolCalls,0);
});

test('TA17 a consumed Task cannot reset terminal admission by creating another independent Session',async t=>{
 const {options}=await fixture(t);let requests=0;
 const tool:sdk.Tool={name:'check',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async()=>({})};
 options.toolAdmission={policyVersion:'task-binding-v1',correctionLimit:0,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};options.transport=async()=>call('call-'+(++requests),tool.name,{id:1});
 const runtime=sdk.createSessionRuntime(options),first=await runtime.create(),request={sessionId:first.id,taskId:'bound-task',prompt:'synthetic',tools:[tool],limits};assert.equal((await runtime.run(request)).status,'failed');
 const independent=await runtime.create(),result=await runtime.run({...request,sessionId:independent.id});assert.equal(result.status==='failed'&&result.reason,'STATE_FAILED');assert.equal(requests,1);
});

for(const mode of ['false-current','missing-result'] as const)test('TA18 corrupt native lane is never known empty '+mode,async t=>{
 const {options,root}=await fixture(t);const runtime=sdk.createSessionRuntime(options),session=await runtime.create();await runtime.run({sessionId:session.id,taskId:'native-state',prompt:'synthetic',tools:[],limits});
 const file=join(root,(await readdir(root,{recursive:true})).find(f=>f.endsWith('.jsonl'))!);
 const corrupt=(await readFile(file,'utf8')).split('\n').map(line=>{if(!line)return line;const input=JSON.parse(line);const rows=(Array.isArray(input)?input:[input]).filter(row=>mode!=='missing-result'||row.namespace!=='pi.result');for(const row of rows)if(mode==='false-current'&&row.namespace==='pi.lane.state'&&row.op==='set')row.value.currentOperationId=false;return JSON.stringify(Array.isArray(input)?rows:rows[0]??[]);}).join('\n');await writeFile(file,corrupt);
 assert.equal((await runtime.inspectFacts({sessionId:session.id,taskId:'native-state'})).availability,'corrupt');assert.equal(await readFile(file,'utf8'),corrupt);
});

for(const saved of [false,true])for(const thrown of [false,true])test('TA19 ancestor read auth '+(saved?'saved authority ':'early fork ')+(thrown?'throws':'denies'),async t=>{
 const {options}=await fixture(t);let deniedId='';options.storage.authorize=async action=>{if(action.kind==='read'&&action.sessionId===deniedId){if(thrown)throw Error('PRIVATE_ANCESTOR_AUTH');return false;}return true;};
 options.toolAdmission={policyVersion:'ancestor-auth-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[]})};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();await runtime.run({sessionId:session.id,taskId:'seed',prompt:'synthetic',tools:[],limits});const fork=await runtime.fork(session.id);deniedId=session.id;
 assert.deepEqual(await runtime.inspectFacts({sessionId:fork.id,taskId:saved?'seed':'not-yet-seen'}),{availability:'unavailable',reason:'AUTHORITY_REQUIRED'});
});

test('TA20 Task binding preserves declared purpose transitions in the same native lineage',async t=>{
 const {options}=await fixture(t);options.toolAdmission={policyVersion:'purpose-binding-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[]})};
 options.purposes=['analysis','report'].map(id=>({id,mode:'agent',model,transport:options.transport,tools:[]}));
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const request={sessionId:session.id,taskId:'purpose-bound-task',prompt:'synthetic',tools:[],limits};
 assert.equal((await runtime.run({...request,purpose:'analysis'})).status,'succeeded');assert.equal((await runtime.run({...request,purpose:'report'})).status,'succeeded');
 assert.equal((await sdk.createSessionRuntime(options).run({...request,purpose:'report'})).status,'succeeded');
});

test('TA21 R1 authorization sees the same final phase-and-upper DTO sent to transport',async t=>{
 const {options}=await fixture(t);let authorized='',requests=0;
 const tool:sdk.Tool={name:'check',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async()=>({})};
 options.contextAdmission={policyVersion:'final-phase-dto-v1',protocolOverheadTokens:8,safetyMarginTokens:16};
 options.toolAdmission={policyVersion:'final-dto-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:{...tool.parameters,properties:{id:{type:'string',enum:['allowed']}}}}]})};
 options.authorize=async action=>{if(action.kind==='model')authorized=JSON.stringify(action.request.messages);return true;};
 options.transport=async request=>{assert.equal(JSON.stringify(request.messages),authorized);if(++requests===1){const schema=request.messages.flatMap(m=>m.tools??[])[0]!.parameters;assert.equal((schema.allOf as unknown[]).length,2);return call('same-dto',tool.name,{id:'allowed'});}return answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();assert.equal((await runtime.run({sessionId:session.id,taskId:'final-dto',prompt:'synthetic',tools:[tool],limits})).status,'succeeded');assert.equal(requests,2);
});

test('TA22 a pre-dispatch denied Session cannot become a second Task counter authority later',async t=>{
 const {options}=await fixture(t);let allowed=false,requests=0;
 const tool:sdk.Tool={name:'check',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async()=>({})};
 options.authorize=async action=>action.kind!=='model'||allowed;options.toolAdmission={policyVersion:'denied-bind-v1',correctionLimit:0,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};options.transport=async()=>call('once-'+(++requests),tool.name,{id:1});
 const runtime=sdk.createSessionRuntime(options),first=await runtime.create(),request={sessionId:first.id,taskId:'denied-bound-task',prompt:'synthetic',tools:[tool],limits};assert.equal((await runtime.run(request)).status,'blocked');assert.equal(requests,0);
 allowed=true;const second=await runtime.create();assert.equal((await runtime.run({...request,sessionId:second.id})).status,'failed');assert.equal(requests,1);
 const result=await runtime.run(request);assert.equal(result.status==='failed'&&result.reason,'STATE_FAILED');assert.equal(requests,1);
});

test('TA23 changed view blocks fallback before its reservation and dispatch, preserving the settled primary and durable stop',async t=>{
 const {options}=await fixture(t);let stage=1,effects=0;const sent:string[]=[],events:sdk.AuditEvent[]=[];
 const tool:sdk.Tool={name:'save',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return{};}};
 options.model={...model,maxOutputTokens:32768};options.modelObservations='v1';options.audit={append:async event=>{events.push(event);}};
 options.toolAdmission={policyVersion:'physical-view-v1',correctionLimit:1,view:async()=>({version:'phase-'+stage,tools:stage===1?[{name:tool.name,parameters:tool.parameters}]:[]})};
 options.transport=async request=>{sent.push(request.model.id);stage=2;throw new sdk.ProviderFailure('unavailable',{model:request.model,stop:'error',category:'unavailable',physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:3},outputTokens:{kind:'known',value:1}},diagnostic:'REQUEST_FAILED'});};
 options.fallbacks=[{model:{...model,id:'backup',maxOutputTokens:16384},transport:async request=>{sent.push(request.model.id);return {...call('stale-save',tool.name,{}),outcome:{model:request.model,stop:'tools',physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:1},outputTokens:{kind:'known',value:1}},diagnostic:'COMPLETE'}};}}];
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create(),request={sessionId:session.id,taskId:'physical-stale',prompt:'synthetic',tools:[tool],limits,modelRecovery:{extraAttempts:1 as const}};
 const result=await runtime.run(request);
 assert.deepEqual(sent,[model.id],'a changed stage must never be sent to the fallback with its old declaration');
 assert.equal(result.status,'failed');assert.equal(result.reason,'INVALID_TOOL');assert.equal(effects,0);
 assert.equal(result.usage.modelCalls,1);assert.equal(result.usage.inputTokens,3);assert.equal(result.usage.outputTokens,1);assert.equal(result.usage.reservedOutputTokens,0);
 assert.equal(events.filter(e=>e.kind==='model.admitted').length,1);assert.equal(result.modelOutcome?.physicalStatus,'response-received');
 const facts=await runtime.inspectFacts({sessionId:session.id,taskId:request.taskId});assert.equal(facts.availability,'available');
 if(facts.availability==='available'){assert.equal(facts.admission.availability,'known');if(facts.admission.availability==='known')assert.equal(facts.admission.terminal,true);}
 await sdk.createSessionRuntime(options).run(request);assert.deepEqual(sent,[model.id]);
});

test('TA24 schema content change blocks the same-model extra attempt even when the view version is unchanged',async t=>{
 const {options}=await fixture(t);let stage=1,requests=0;const events:sdk.AuditEvent[]=[];
 const tool:sdk.Tool={name:'read',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async()=>({})};
 options.audit={append:async event=>{events.push(event);}};
 options.toolAdmission={policyVersion:'physical-content-v1',correctionLimit:1,view:async()=>({version:'same-version',tools:[{name:tool.name,parameters:{...tool.parameters,properties:{id:{type:'string',enum:[stage===1?'PRIVATE_OLD_SCOPE':'PRIVATE_NEW_SCOPE']}}}}]})};
 options.transport=async()=>{requests++;stage=2;throw new sdk.ProviderFailure('unavailable');};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'physical-schema',prompt:'synthetic',tools:[tool],limits,modelRecovery:{extraAttempts:1}});
 assert.equal(requests,1);assert.equal(result.status,'failed');assert.equal(result.reason,'INVALID_TOOL');assert.equal(result.usage.modelCalls,1);
 assert.equal(result.usage.reservedOutputTokens,32768,'the first unconfirmed request keeps its reservation');
 assert.doesNotMatch(JSON.stringify({result,events}),/PRIVATE_OLD_SCOPE|PRIVATE_NEW_SCOPE/);
});

for(const route of ['fallback','same-model'] as const)test('TA25 stable view permits the bounded '+route+' attempt with the authorized DTO and one prepared tool effect',async t=>{
 const {options}=await fixture(t);let requests=0,effects=0,prepares=0;const sent:sdk.ModelRequest[]=[],authorized:string[]=[];
 const tool:sdk.Tool={name:'save',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},prepareArguments:args=>{prepares++;return args;},execute:async args=>{effects++;assert.deepEqual(args,{id:'allowed'});return{saved:true};}};
 options.model={...model,maxOutputTokens:32768};options.modelObservations='v1';options.contextAdmission={policyVersion:'physical-dto-v1',protocolOverheadTokens:8,safetyMarginTokens:16};
 options.toolAdmission={policyVersion:'physical-stable-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[{name:tool.name,parameters:tool.parameters}]})};
 options.authorize=async action=>{if(action.kind==='model')authorized.push(JSON.stringify(action.request.messages));return true;};
 const transport:sdk.ModelTransport=async request=>{
  sent.push(request);assert.equal(JSON.stringify(request.messages),authorized.at(-1));
  if(++requests===1)throw new sdk.ProviderFailure('unavailable',{model:request.model,stop:'error',category:'unavailable',physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}},diagnostic:'REQUEST_FAILED'});
  const reply=requests===2?call('stable-save',tool.name,{id:'allowed'}):answer();
  return {...reply,outcome:{model:request.model,stop:reply.stop,physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:1},outputTokens:{kind:'known',value:1}},diagnostic:'COMPLETE'}};
 };
 options.transport=transport;if(route==='fallback')options.fallbacks=[{model:{...model,id:'backup',maxOutputTokens:16384},transport}];
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'physical-stable-'+route,prompt:'synthetic',tools:[tool],limits,modelRecovery:{extraAttempts:1}});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(requests,3);assert.equal(effects,1);assert.equal(prepares,1);
 assert.deepEqual(sent[0]!.messages,sent[1]!.messages);assert.equal(sent[1]!.maxOutputTokens,route==='fallback'?16384:32768);
 assert.equal(result.usage.modelCalls,3);assert.equal(result.usage.reservedOutputTokens,0);
});

test('TA26 view changed during initial model authorization is rejected before any reservation or send',async t=>{
 const {options}=await fixture(t);let stage=1,requests=0;const events:sdk.AuditEvent[]=[];
 options.audit={append:async event=>{events.push(event);}};
 options.toolAdmission={policyVersion:'initial-physical-v1',correctionLimit:1,view:async()=>({version:'phase-'+stage,tools:[]})};
 options.authorize=async action=>{if(action.kind==='model')stage=2;return true;};options.transport=async()=>{requests++;return answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'initial-physical',prompt:'synthetic',tools:[],limits});
 assert.equal(result.status,'failed');assert.equal(result.reason,'INVALID_TOOL');assert.equal(requests,0);assert.equal(result.usage.modelCalls,0);assert.equal(result.usage.reservedOutputTokens,0);
 assert.equal(events.filter(e=>e.kind==='model.admitted').length,0);assert.equal(result.modelOutcome,undefined,'no Provider outcome is fabricated for an unadmitted attempt');
});

for(const stop of ['deny','cancel'] as const)test('TA27 '+stop+' blocks the extra physical attempt without another reservation',async t=>{
 const {options}=await fixture(t);const controller=new AbortController();let requests=0,authorizations=0;
 options.toolAdmission={policyVersion:'physical-stop-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[]})};
 options.authorize=async action=>{if(action.kind==='model'&&++authorizations===2){if(stop==='cancel')controller.abort();else return false;}return true;};
 options.transport=async()=>{requests++;throw new sdk.ProviderFailure('unavailable');};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'physical-'+stop,prompt:'synthetic',tools:[],limits,signal:controller.signal,modelRecovery:{extraAttempts:1}});
 assert.equal(requests,1);assert.ok(result.status==='blocked'||result.status==='cancelled');assert.equal(result.reason,stop==='deny'?'AUTHORITY_REQUIRED':'CANCELLED');assert.equal(result.usage.modelCalls,1);assert.equal(result.usage.reservedOutputTokens,32768);
});

test('TA28 reported UNKNOWN stops before any extra attempt and keeps the original reservation',async t=>{
 const {options}=await fixture(t);let requests=0,stage=1;
 options.modelObservations='v1';options.toolAdmission={policyVersion:'physical-unknown-v1',correctionLimit:1,view:async()=>({version:'phase-'+stage,tools:[]})};
 options.transport=async request=>{requests++;stage=2;throw new sdk.ProviderFailure('network',{model:request.model,stop:'unknown',category:'network',physicalStatus:'unknown',usageFinal:false,usage:{inputTokens:{kind:'unknown'},outputTokens:{kind:'unknown'}},diagnostic:'UNKNOWN'});};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'physical-unknown',prompt:'synthetic',tools:[],limits,modelRecovery:{extraAttempts:1}});
 assert.equal(result.status,'failed');assert.equal(requests,1);assert.equal(result.usage.modelCalls,1);assert.equal(result.usage.reservedOutputTokens,32768);assert.equal(result.modelOutcome?.physicalStatus,'unknown');
});

for(const failure of ['throw','invalid'] as const)test('TA29 unavailable view ('+failure+') prevents an extra send and never exposes native messages',async t=>{
 const {options}=await fixture(t);let stage=1,requests=0;const events:sdk.AuditEvent[]=[];
 options.audit={append:async event=>{events.push(event);}};
 options.toolAdmission={policyVersion:'physical-unavailable-v1',correctionLimit:1,view:async()=>{
  if(stage===2){if(failure==='throw')throw Error('PRIVATE_VIEW_MESSAGE');return{version:'phase',tools:[{name:'unregistered',parameters:{type:'object'}}]};}
  return{version:'phase',tools:[]};
 }};
 options.transport=async()=>{requests++;stage=2;throw new sdk.ProviderFailure('unavailable');};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'physical-unavailable-'+failure,prompt:'synthetic',tools:[],limits,modelRecovery:{extraAttempts:1}});
 assert.equal(result.status,'failed');assert.equal(requests,1);assert.equal(result.usage.modelCalls,1);assert.doesNotMatch(JSON.stringify({result,events}),/PRIVATE_VIEW_MESSAGE|unregistered/);
});

test('TA30 view change during admission IO blocks physical send and settles the unissued reservation as known zero',async t=>{
 const {options}=await fixture(t);let stage=1,requests=0;const events:sdk.AuditEvent[]=[];
 options.modelObservations='v1';options.audit={append:async event=>{events.push(event);if(event.kind==='model.admitted')stage=2;}};
 options.toolAdmission={policyVersion:'physical-send-v1',correctionLimit:1,view:async()=>({version:'phase-'+stage,tools:[]})};
 options.transport=async()=>{requests++;return answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'physical-send',prompt:'synthetic',tools:[],limits,modelRecovery:{extraAttempts:1}});
 assert.equal(requests,0,'a view changed during reservation/audit IO must not reach transport');
 assert.equal(result.status,'failed');assert.equal(result.reason,'INVALID_TOOL');assert.equal(result.usage.modelCalls,1);assert.equal(result.usage.reservedOutputTokens,0);assert.equal(result.usage.outputTokens,0);
 assert.equal(result.modelOutcome?.physicalStatus,'not-sent');assert.equal(result.modelOutcome?.usageFinal,true);
 assert.equal(events.filter(e=>e.kind==='model.finished'&&e.modelOutcome?.physicalStatus==='not-sent').length,1);
});

for(const cumulative of ['unlimited','finite'] as const)test('TA31 send-boundary rejection settles '+cumulative+' accounting without model observations',async t=>{
 const {options}=await fixture(t);let stage=1,requests=0;const events:sdk.AuditEvent[]=[];
 options.audit={append:async event=>{events.push(event);if(event.kind==='model.admitted')stage=2;}};
 options.toolAdmission={policyVersion:'physical-send-legacy-usage-v1',correctionLimit:1,view:async()=>({version:'phase-'+stage,tools:[]})};options.transport=async()=>{requests++;return answer();};
 const runtime=sdk.createSessionRuntime(options),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'physical-send-'+cumulative,prompt:'synthetic',tools:[],limits:cumulative==='unlimited'?limits:{modelCalls:4,toolCalls:2,outputTokens:16,wallTimeMs:5000}});
 assert.equal(result.status,'failed');assert.equal(result.reason,'INVALID_TOOL');assert.equal(requests,0);assert.equal(result.usage.modelCalls,1);assert.equal(result.usage.outputTokens,0);assert.equal(result.usage.reservedOutputTokens??0,0);
 assert.equal(result.modelOutcome,undefined);assert.equal(events.filter(e=>e.kind==='model.finished').length,1);
});
