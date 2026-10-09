import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionRuntime,createMemoryBudgetStore,loadHarnessResources} from '../src/index.ts';
import type {SessionRuntimeOptions} from '../src/index.ts';
async function fixture(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),'pi-ext-'));t.after(()=>rm(root,{recursive:true,force:true}));const options:SessionRuntimeOptions={model:{provider:'synthetic',id:'extensions',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:8192},transport:async()=>({content:[{kind:'text',text:'ok'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}}),budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=> 'ready',storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'test',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})}};return{root,options,request:{taskId:'extensions',prompt:'go',tools:[],limits:{modelCalls:10,toolCalls:10,outputTokens:100,wallTimeMs:2000}}};}
test('HE01 native source loaders read actual skill/template files and content changes alter identity',async t=>{
 const {root,options,request}=await fixture(t);const skills=join(root,'skills'),templates=join(root,'templates');await mkdir(skills);await mkdir(templates);
 await writeFile(join(skills,'SKILL.md'),'---\nname: analysis\ndescription: Synthetic analysis\n---\nUse threshold 32.');await writeFile(join(templates,'report.md'),'Compare $1 and $2.');
 const load=()=>loadHarnessResources({cwd:root,sources:[{kind:'skills',path:skills,version:'v1'},{kind:'templates',path:templates,version:'v1'}],authorize:async()=>true});
 const resources=await load();assert.equal(resources.skills.length,1);assert.equal(resources.templates.length,1);
 options.harness={skills:resources.skills,templates:resources.templates};options.transport=async r=>{assert.match(r.messages.map(m=>m.text).join('\n'),/threshold 32/);return{content:[{kind:'text',text:'32'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();assert.equal((await runtime.run({...request,sessionId:session.id,operation:'skill',resourceName:'analysis'})).status,'succeeded');
 await writeFile(join(skills,'SKILL.md'),'---\nname: analysis\ndescription: Synthetic analysis\n---\nUse threshold 33.');assert.notEqual((await load()).digest,resources.digest);
 await assert.rejects(loadHarnessResources({cwd:root,sources:[{kind:'skills',path:skills,version:'v1'}],authorize:async()=>false}),/AUTHORITY_REQUIRED/);
});
test('HE02 native hooks and custom projection change actual context but hook errors cannot bypass authorization',async t=>{
 const {options,request}=await fixture(t);options.harness={extensionVersion:'projection-v1'};
 options.extensions={customEntryTypes:['evidence'],projectEntry:e=>[{role:'user',text:JSON.stringify(e.data)}],transformContext:async e=>({messages:[...e.messages,{role:'user',text:'CONTEXT-EXTENSION'}]}),beforeRequest:async()=>{throw Error('hook failure');}};
 let calls=0;options.transport=async r=>{calls++;const text=r.messages.map(m=>m.text).join('\n');assert.match(text,/CONTEXT-EXTENSION/);if(calls>1)assert.match(text,/EVIDENCE-53/);return{content:[{kind:'text',text:'ok'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();assert.equal((await runtime.run({...request,sessionId:session.id})).status,'succeeded');
 await runtime.update(session.id,{kind:'custom',branch:'main',type:'evidence',data:{value:'EVIDENCE-53'}});
 assert.equal((await runtime.run({...request,sessionId:session.id})).status,'succeeded');
 const blocked=createSessionRuntime({...options,authorize:async a=>a.kind!=='model'});const r=await blocked.run({...request,sessionId:session.id});assert.equal(r.status!=='succeeded'&&r.reason,'AUTHORITY_REQUIRED');assert.equal(calls,2);
});
test('HE03 native navigation and branch history change subsequent model context without erasing ancestry',async t=>{
 const {options,request}=await fixture(t);const seen:string[]=[];options.transport=async r=>{seen.push(r.messages.map(m=>m.text).join('\n'));return{content:[{kind:'text',text:'answer'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();await runtime.run({...request,sessionId:session.id,prompt:'FIRST'});const first=await runtime.history(session.id);
 await runtime.run({...request,sessionId:session.id,prompt:'SECOND'});
 await runtime.update(session.id,{kind:'branch',name:'fork-branch',at:first.at(-1)!.id});
 assert.equal((await runtime.run({...request,sessionId:session.id,branch:'fork-branch',prompt:'BRANCHED'})).status,'succeeded');assert.ok(seen.at(-1)!.includes('FIRST'));assert.ok(!seen.at(-1)!.includes('SECOND'));
 const navigated=await runtime.run({...request,sessionId:session.id,operation:'navigate',targetEntryId:first.at(-1)!.id,prompt:''});assert.equal(navigated.status,'succeeded');
 await runtime.run({...request,sessionId:session.id,prompt:'AFTER-NAV'});assert.ok(!seen.at(-1)!.includes('SECOND'));
 await runtime.update(session.id,{kind:'name',name:'Synthetic session'});await runtime.update(session.id,{kind:'label',entryId:first[0]!.id,label:'First evidence'});
});
for(const policy of ['finite','uncapped'] as const) test(`HE04 native deferred suspension survives reopening, guarded polling and cancellation use the same task ledger (${policy})`,async t=>{
 const {options,request:base}=await fixture(t);const request={...base,limits:policy==='finite'?base.limits:{cumulative:'unlimited' as const,maxOutputTokens:10,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000}};options.model.deferred=true;options.model.maxOutputTokens=10;options.harness={deferred:true};const actions:string[]=[];
 options.transport=async r=>{actions.push(r.deferred?.action ?? 'none');if(r.deferred?.action==='start')return{content:[],stop:'deferred',deferred:{id:'synthetic-request'},usage:{inputTokens:0,outputTokens:0}};return{content:[{kind:'text',text:r.deferred?.action==='cancel'?'cancelled':'deferred result'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();const started=await runtime.run({...request,sessionId:session.id});assert.equal(started.status,'suspended',JSON.stringify(started));
 assert.ok((await runtime.inspect(session.id)).pending);
 const resumed=await createSessionRuntime(options).run({...request,sessionId:session.id,operation:'resume',prompt:''});assert.equal(resumed.status,'succeeded',JSON.stringify(resumed));assert.equal(resumed.usage.modelCalls,2);assert.equal(resumed.usage.outputTokens,11);assert.deepEqual(actions,['start','poll']);
 const next=await runtime.run({...request,sessionId:session.id});assert.equal(next.status,'suspended');
 const cancelled=await runtime.run({...request,sessionId:session.id,operation:'abort',prompt:''});assert.equal(cancelled.status,'cancelled',JSON.stringify(cancelled));assert.equal(actions.at(-1),'cancel');assert.equal(cancelled.usage.modelCalls,4);
});
test('HE05 image inputs reach the physical model and unsupported candidates fail before effects',async t=>{
 const {options,request}=await fixture(t);options.model.input=['text','image'];let calls=0;options.transport=async r=>{calls++;assert.equal(r.messages.find(m=>m.role==='user')?.images?.[0]?.data,'YWJj');return{content:[{kind:'text',text:'image seen'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();assert.equal((await runtime.run({...request,sessionId:session.id,images:[{data:'YWJj',mimeType:'image/png'}]})).status,'succeeded');
 const unsupported=createSessionRuntime({...options,model:{...options.model,input:['text']}});const result=await unsupported.run({...request,taskId:'text-only',sessionId:session.id,images:[{data:'YWJj',mimeType:'image/png'}]});assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_REQUEST');assert.equal(calls,1);
});
test('HE06 native durable tool progress/memo and storage failure preserve the actual effect and block dependent requests',async t=>{
 const {NodeExecutionEnv}=await import('@earendil-works/pi-agent-core/node');const {FileError}=await import('@earendil-works/pi-agent-core');
 const {options,request}=await fixture(t);let calls=0,effects=0,failWrite=false;
 const append=NodeExecutionEnv.prototype.appendFile;
 t.mock.method(NodeExecutionEnv.prototype,'appendFile',async function(this:InstanceType<typeof NodeExecutionEnv>,...args:Parameters<typeof append>){if(failWrite){failWrite=false;return{ok:false as const,error:new FileError('unknown','synthetic write fault')};}return append.apply(this,args);});
 options.transport=async()=>{calls++;return{content:[{kind:'tool',id:'one',name:'effect',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();
 const tools=[{name:'effect',description:'synthetic effect',effect:'write' as const,resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{effects++;failWrite=true;return 44;}}];
 const result=await runtime.run({...request,sessionId:session.id,tools});assert.equal(result.status,'failed');assert.equal(effects,1);assert.equal(calls,1);assert.equal(result.usage.toolCalls,1);
 options.reconcile=async()=> 'unknown';const recovery=await createSessionRuntime(options).run({...request,sessionId:session.id,tools,operation:'resume',prompt:''});assert.equal(recovery.status!=='succeeded'&&recovery.reason,'STATE_FAILED');assert.equal(effects,1);assert.equal(calls,1);
});
for(const policy of ['finite','uncapped'] as const) test(`HE07 native tool memo/update is durable and navigation summary reaches the next model (${policy})`,async t=>{
 const {options,request:base}=await fixture(t);const request={...base,limits:policy==='finite'?base.limits:{cumulative:'unlimited' as const,maxOutputTokens:10,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000}};let calls=0,summarized=false;
 options.transport=async r=>{const text=r.messages.map(m=>m.text).join('\n');calls++;if(calls===1)return{content:[{kind:'tool',id:'one',name:'memo',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
 if(text.includes('summar')){summarized=true;return{content:[{kind:'text',text:'BRANCH-SUMMARY-71'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};}
 return{content:[{kind:'text',text:'71'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 const runtime=createSessionRuntime(options),session=await runtime.create();
 const tools=[{name:'memo',description:'memo',effect:'read' as const,resourceUnits:1,parameters:{type:'object',properties:{}},execute:async(_a:unknown,_s:AbortSignal,ctx?:import('../src/index.ts').ToolExecutionContext)=>{await ctx!.setMemo('value',71);assert.equal(await ctx!.getMemo('value'),71);ctx!.update({value:71},true);return 71;}}];
 assert.equal((await runtime.run({...request,sessionId:session.id,tools})).status,'succeeded');const history=await runtime.history(session.id);
 await runtime.run({...request,sessionId:session.id,tools,prompt:'new route'});
 const result=await runtime.run({...request,sessionId:session.id,tools,operation:'navigate',targetEntryId:history.at(-1)!.id,summarize:true,prompt:'Retain 71'});
 assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(summarized,true);assert.ok((await runtime.history(session.id)).some(e=>e.kind==='branch_summary'&&e.summary?.includes('BRANCH-SUMMARY-71')));
 options.transport=async r=>{assert.ok(r.messages.some(m=>m.text.includes('BRANCH-SUMMARY-71')));return{content:[{kind:'text',text:'consumed summary'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};};
 assert.equal((await createSessionRuntime(options).run({...request,sessionId:session.id,tools,prompt:'continue'})).status,'succeeded');
});
