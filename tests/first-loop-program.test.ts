import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as sdk from '../src/index.ts';

const limits={cumulative:'unlimited' as const,maxOutputTokens:1024,modelTimeoutMs:600000,toolTimeoutMs:300000,controlTimeoutMs:30000};
const model:sdk.ModelConfig={provider:'synthetic',id:'long-program',protocol:'openai-completions',endpoint:'https://synthetic.invalid',contextWindow:200000,maxOutputTokens:1024};
const chunk='  sum += 1;\n'.repeat(100),marker='# APPEND_NEXT\n';
const program='BEGIN {\n'+chunk.repeat(4)+'  print sum;\n}\n';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');

for(const os of [false,true])test('FP01 complete native write/edit/read program reaches final verifier '+(os?'OS sandbox':'synthetic host'),{skip:os&&process.env.PI_RUN_OS_SANDBOX_TESTS!=='1'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'pi-program-'));t.after(()=>rm(root,{recursive:true,force:true}));const work=join(root,'work');await mkdir(work);
 const local=await sdk.createLocalExecutionEnvironment({root:work,policyVersion:'existing-restricted-v1',exclusiveWorkspace:true,maxFileBytes:65536,maxOutputBytes:4096,timeoutMs:120000,processes:os});
 let finalExecutions=0,requests=0;const supplied:string[]=[];
 const host:sdk.ExecutionEnvironment={...local,exec:async(command,signal)=>{
  const source=new TextDecoder().decode(await local.read('program.awk',signal));assert.equal(source,program);assert.ok(Buffer.byteLength(source)<=65536);supplied.push(source);finalExecutions++;
  if(os)return local.exec(command,signal);assert.equal(command,'exec /usr/bin/awk -f program.awk');return{output:'400\n',exitCode:0};
 }};
 const tools=sdk.createExecutionTools(host,['write','edit','read']);
 tools.push({name:'verify_final',description:'synthetic final-only verifier',effect:'external',resourceUnits:1,parameters:{type:'object',properties:{sha256:{type:'string',enum:[hash(program)]}},required:['sha256'],additionalProperties:false},execute:async(args,signal)=>{
  const source=new TextDecoder().decode(await host.read('program.awk',signal));if(hash(source)!==args.sha256)throw new sdk.RuntimeFault('INVALID_TOOL');
  const result=await host.exec('exec /usr/bin/awk -f program.awk',signal);assert.equal(result.exitCode,0);assert.equal(result.output,'400\n');return{verified:true,sha256:hash(source)};
 }});
 const plans=[{name:'write',arguments:{path:'program.awk',content:'BEGIN {\n'+chunk+marker}},
  ...[1,2,3].map(n=>({name:'edit',arguments:{path:'program.awk',edits:[{oldText:marker,newText:chunk+(n===3?'  print sum;\n}\n':marker)}]}})),
  {name:'read',arguments:{path:'program.awk'}},{name:'verify_final',arguments:{sha256:hash(program)}}];
 const runtime=sdk.createSessionRuntime({model,budgets:sdk.createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=> 'ready',
  storage:{cwd:work,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
  toolAdmission:{policyVersion:'program-phase-v1',correctionLimit:1,view:async()=>({version:'draft-and-verify',tools:tools.map(({name,parameters})=>({name,parameters}))})},
  transport:async request=>{const plan=plans[requests++];if(plan){if(plan.name==='verify_final')assert.ok(request.messages.some(m=>m.role==='tool'&&m.toolName==='read'&&m.text.includes('print sum')));return{content:[{kind:'tool',id:'program-'+requests,name:plan.name,arguments:plan.arguments}],stop:'tools',usage:{inputTokens:3,outputTokens:500}};}
   return{content:[{kind:'text',text:'verified'}],stop:'complete',usage:{inputTokens:3,outputTokens:2}};}});
 const session=await runtime.create(),result=await runtime.run({sessionId:session.id,taskId:'program',prompt:'synthetic only',tools,limits});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(await readFile(join(work,'program.awk'),'utf8'),program);assert.equal(finalExecutions,1);assert.deepEqual(supplied,[program]);
 assert.ok(Buffer.byteLength(program)>Math.max(...plans.map(p=>Buffer.byteLength(JSON.stringify(p)))));assert.equal(result.usage.toolCalls,6);
});

test('FP02 a truncated tool response cannot execute even the first business draft',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pi-truncated-'));t.after(()=>rm(root,{recursive:true,force:true}));let effects=0;
 const tool:sdk.Tool={name:'write_draft',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{content:{type:'string'}},required:['content'],additionalProperties:false},execute:async()=>{effects++;return{};}};
 const runtime=sdk.createSessionRuntime({model,budgets:sdk.createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=> 'ready',storage:{cwd:root,directory:root,policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},toolAdmission:{policyVersion:'truncated-v1',correctionLimit:0,view:async()=>({version:'draft',tools:[{name:tool.name,parameters:tool.parameters}]})},transport:async()=>({content:[{kind:'tool',id:'partial',name:tool.name,arguments:{content:'BEGIN {'}}],stop:'length',usage:{inputTokens:3,outputTokens:1024}})});
 const session=await runtime.create(),result=await runtime.run({sessionId:session.id,taskId:'truncated',prompt:'synthetic',tools:[tool],limits});assert.equal(result.status,'failed');assert.equal(effects,0);assert.equal(result.usage.toolCalls,0);
});

test('FP03 native factory progress and invocation memo use the same persistent Harness',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pi-factory-progress-'));t.after(()=>rm(root,{recursive:true,force:true}));let progress=0,requests=0,memoRead=false;
 const env:sdk.ExecutionEnvironment={cwd:root,policyVersion:'no-process-synthetic',resolvePath:async p=>join(root,p),read:async()=>assert.fail('read forbidden'),write:async()=>assert.fail('write forbidden'),stat:async()=>assert.fail('stat forbidden'),exec:async()=>({output:'synthetic progress result',exitCode:0})};
 const tools=sdk.createExecutionTools(env,['bash']);
 tools.push({name:'memo',description:'synthetic',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{},additionalProperties:false},execute:async(_args,_signal,context)=>{
  assert.ok(context);await context.setMemo('synthetic-memo',{complete:true});assert.deepEqual(await context.getMemo('synthetic-memo'),{complete:true});context.update({saved:true},true);memoRead=true;return{complete:true};
 }});
 const runtime=sdk.createSessionRuntime({model,budgets:sdk.createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=> 'ready',onHarnessEvent:event=>{if(event.kind==='tool_update')progress++;},storage:{cwd:root,directory:root,policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},toolAdmission:{policyVersion:'factory-progress-v1',correctionLimit:1,view:async()=>({version:'phase',tools:tools.map(({name,parameters})=>({name,parameters}))})},transport:async()=>{
  const name=++requests===1?'bash':requests===2?'memo':undefined;return name?{content:[{kind:'tool',id:'progress-'+requests,name,arguments:name==='bash'?{command:'synthetic-only'}:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}}:{content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};
 }});
 const session=await runtime.create(),result=await runtime.run({sessionId:session.id,taskId:'progress',prompt:'synthetic',tools,limits});assert.equal(result.status,'succeeded',JSON.stringify(result));assert.ok(progress>=2);assert.equal(memoRead,true);
});
