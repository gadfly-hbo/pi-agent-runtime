import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,readdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {installFixedConsumer} from './install-fixed-consumer.mjs';
const root=resolve('.'),directory=mkdtempSync(join(tmpdir(),'pi-harness-consumer-'));
const run=(command,args,cwd=root)=>{const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:60000,env:{...process.env,npm_config_cache:process.env.npm_config_cache??join(root,'.npm-cache'),npm_config_ignore_scripts:'true'}});assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
const supplied=process.argv[2]?resolve(process.argv[2]):undefined;
let packed;
if(supplied){
 copyFileSync(supplied,join(directory,basename(supplied)));
 const contents=run('/usr/bin/tar',['-tzf',supplied]);
 packed={filename:basename(supplied),files:contents.trim().split('\n')};
}else [packed]=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',directory]));
const selected=join(directory,packed.filename),fixedBytes=readFileSync(selected);
const modules=join(directory,'node_modules'),installed=join(modules,'pi-agent-runtime');
let installEvidence;
if(supplied){
 installEvidence=installFixedConsumer(root,directory,selected,(args,cwd)=>run('npm',args,cwd));
}else{
 mkdirSync(modules);mkdirSync(installed);run('/usr/bin/tar',['-xzf',selected,'-C',installed,'--strip-components=1']);
 // Legacy fast path remains explicit. A supplied fixed candidate always uses installation above.
 for(const name of readdirSync(join(root,'node_modules')))if(name!=='.bin')symlinkSync(join(root,'node_modules',name),join(modules,name));
}
for(const file of readdirSync(join(installed,'dist')).filter(f=>f.endsWith('.d.ts')))assert.ok(!readFileSync(join(installed,'dist',file),'utf8').includes('@earendil-works/'),file);
writeFileSync(join(directory,'consumer.mjs'),`
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createRuntime,createSessionRuntime,createMemoryBudgetStore,createLocalExecutionEnvironment,createExecutionTools,loadHarnessResources,createProxyTransport} from 'pi-agent-runtime';
const root=await mkdtemp(join(tmpdir(),'packed-session-'));
try {
 const budgets=createMemoryBudgetStore();let calls=0;
 const model={provider:'synthetic',id:'packed',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:8192};
 const env=await createLocalExecutionEnvironment({root,policyVersion:'test-v1',exclusiveWorkspace:true,maxFileBytes:1000,maxOutputBytes:1000,timeoutMs:1000});
 const tools=createExecutionTools(env,['write','read']);
 const transport=async request=>{calls++;if(calls===1)return{content:[{kind:'tool',id:'write-1',name:'write',arguments:{path:'evidence.txt',content:'PACKED-97'}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
 if(calls===2)return{content:[{kind:'tool',id:'read-1',name:'read',arguments:{path:'evidence.txt'}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
 assert.ok(request.messages.some(m=>m.role==='tool'&&m.text==='PACKED-97'));return{content:[{kind:'text',text:'consumed PACKED-97'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const options={model,transport,budgets,authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=> 'ready',storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'fixture',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})}};
 const runtime=createSessionRuntime(options),session=await runtime.create();const request={taskId:'stable-packed',sessionId:session.id,prompt:'write/read fixture',tools,limits:{modelCalls:10,toolCalls:3,outputTokens:100,wallTimeMs:5000}};
 assert.equal((await runtime.run(request)).status,'succeeded');const resumed=await createSessionRuntime(options).run({...request,prompt:'consume saved result'});
 assert.equal(resumed.status,'succeeded');assert.equal(resumed.value,'consumed PACKED-97');assert.equal(resumed.usage.modelCalls,4);assert.equal(resumed.usage.toolCalls,2);
 const limits={cumulative:'unlimited',maxOutputTokens:4,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000};
 const plain=createRuntime({...options,transport:async r=>{assert.equal(r.maxOutputTokens,4);return{content:[{kind:'text',text:'42'}],stop:'complete',usage:{inputTokens:3,outputTokens:2}};}});
 const common={taskId:'packed-uncapped',prompt:'go',limits,modelRecovery:{extraAttempts:1}};
 for(let i=0;i<6;i++)assert.equal((await plain.runText(common)).status,'succeeded');
 assert.equal((await plain.runWorker({...common,validate:v=>v})).status,'succeeded');
 const agent=await plain.runAgent({...common,tools:[]});assert.equal(agent.status,'succeeded');assert.equal(agent.usage.modelCalls,8);assert.equal(agent.usage.inputTokens,24);assert.equal(agent.usage.outputTokens,16);assert.equal(agent.usage.reservedOutputTokens,0);
 const native=await createSessionRuntime(options).run({...request,taskId:'packed-uncapped-session',limits,modelRecovery:{extraAttempts:1}});assert.equal(native.status,'succeeded');assert.equal(native.value,'consumed PACKED-97');
 console.log('PACKED_NATIVE_AND_UNCAPPED_CONSUMER_PASS');
} finally {await rm(root,{recursive:true,force:true});}
`);
writeFileSync(join(directory,'consumer.mts'),`import {createSessionRuntime,createExecutionTools,createLocalExecutionEnvironment,createProxyTransport,loadHarnessResources} from 'pi-agent-runtime';
import type {SessionRuntimeOptions,HarnessControl,ToolExecutionContext,ExecutionEnvironment,UncappedLimits,UncappedBudgetLease,BaseRequest,ToolAdmissionPolicy,SessionFacts,ToolAdmissionFact,Tool} from 'pi-agent-runtime';
const limits:UncappedLimits={cumulative:'unlimited',maxOutputTokens:4,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000};
const request:BaseRequest={taskId:'typed',prompt:'go',limits,modelRecovery:{extraAttempts:1}};
const ledger=(lease:UncappedBudgetLease)=>lease.settleModelUsage(4,{inputTokens:3,outputTokens:2});void [request,ledger];
const control:HarnessControl={kind:'snapshot',includeContent:true};
const make=(options:SessionRuntimeOptions)=>createSessionRuntime(options);void [control,make,createExecutionTools,createLocalExecutionEnvironment,createProxyTransport,loadHarnessResources];
const policy:ToolAdmissionPolicy={policyVersion:'typed-phase-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[]})};
const passive=(runtime:ReturnType<typeof make>):Promise<SessionFacts>=>runtime.inspectFacts({sessionId:'typed',taskId:'typed'});
const fact=(value:ToolAdmissionFact)=>value.disposition;
const tool:Tool={name:'typed',description:'typed',argumentPolicy:'strict',prepareArguments:args=>args,parameters:{type:'object'},effect:'read',resourceUnits:1,execute:async()=>({})};void [policy,passive,fact,tool];
`);
run(process.execPath,[join(modules,'typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--target','ES2023','--types','node','consumer.mts'],directory);
process.stdout.write(run(process.execPath,['consumer.mjs'],directory));
copyFileSync(join(root,'examples/package-consumer.mjs'),join(directory,'legacy-consumer.mjs'));
process.stdout.write(run(process.execPath,['legacy-consumer.mjs'],directory));
const bytes=readFileSync(join(directory,packed.filename));
if(supplied){
 const tests=['tool-admission.test.ts','first-loop-limits.test.ts','first-loop-program.test.ts'];
 for(const file of tests)writeFileSync(join(directory,file),readFileSync(join(root,'tests',file),'utf8').replaceAll("'../src/index.ts'","'pi-agent-runtime'"));
 process.stdout.write(run(process.execPath,['--experimental-strip-types','--test',...tests],directory));
 assert.deepEqual(readFileSync(supplied),fixedBytes,'Supplied fixed package changed');
}
assert.deepEqual(bytes,fixedBytes);
console.log(JSON.stringify({pack:packed.filename,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,files:packed.files.length,publicTypes:'neutral',consumer:supplied?'isolated offline installation':'independent extracted tgz',dependencies:supplied?'installed from selected fixed tgz and exact locked versions':'existing exact tree; no installation',candidate:join(directory,packed.filename),source:supplied??'new pack',sameBytes:true,installEvidence}));
