import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime, createMemoryBudgetStore} from '../src/index.ts';
import type {ModelConfig, ModelReply, ModelTransport, Tool} from '../src/index.ts';
const main:ModelConfig={provider:'synthetic-main',id:'analysis',protocol:'openai-completions',endpoint:'https://invalid.invalid',contextWindow:8192,maxOutputTokens:20};
const report:ModelConfig={...main,provider:'synthetic-report',id:'report'};
const limits={modelCalls:3,toolCalls:2,outputTokens:100,wallTimeMs:10000};
const reply=(text:string):ModelReply=>({content:[{kind:'text',text}],stop:'complete',usage:{inputTokens:1,outputTokens:2}});
const tool:Tool={name:'net',description:'Synthetic local calculation',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>({net:1050})};

for(const policy of ['finite','uncapped'] as const)test(`purpose plan allows same-task analysis tools then report without resetting consumption (${policy})`,async()=>{
 const limits=policy==='finite'?{modelCalls:3,toolCalls:2,outputTokens:100,wallTimeMs:10000}:{cumulative:'unlimited' as const,maxOutputTokens:4,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000};
 let turn=0; const seen:string[]=[];
 const analysis:ModelTransport=async request=>{seen.push(request.model.provider);if(++turn===1)return{content:[{kind:'tool',id:'net-1',name:'net',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}};
 assert.equal(request.messages.find(m=>m.role==='tool')?.text,'{"net":1050}');return reply('1050');};
 const writing:ModelTransport=async request=>{seen.push(request.model.provider);assert.equal(request.messages.some(m=>m.tools?.length),false);return reply('Net sales 1050');};
 const budgets=createMemoryBudgetStore();
 const options={model:main,transport:analysis,authorize:async()=>true,audit:{append:async()=>{}},budgets,
 purposes:[{id:'analysis',mode:'agent' as const,model:main,transport:analysis,tools:[tool]},{id:'report',mode:'text' as const,model:report,transport:writing}]};
 const runtime=createRuntime(options);
 const first=await runtime.runAgent({taskId:'business-1',purpose:'analysis',prompt:'Calculate',limits,tools:[tool]});
 assert.equal(first.status,'succeeded');
 const second=await createRuntime(options).runText({taskId:'business-1',purpose:'report',prompt:'Explain verified 1050',limits});
 assert.equal(second.status,'succeeded'); assert.equal(second.usage.modelCalls,3);assert.equal(second.usage.toolCalls,1);assert.equal(second.usage.outputTokens,6);
 assert.deepEqual(seen,['synthetic-main','synthetic-main','synthetic-report']);
 const exhausted=await runtime.runText({taskId:'business-1',purpose:'report',prompt:'Again',limits});
 if(policy==='finite'){assert.equal(exhausted.status!=='succeeded'&&exhausted.reason,'BUDGET_EXHAUSTED');assert.equal(seen.length,3);}else{assert.equal(exhausted.status,'succeeded');assert.equal(exhausted.usage.modelCalls,4);assert.equal(exhausted.usage.outputTokens,8);assert.equal(seen.length,4);}
});

const plan=(budgets=createMemoryBudgetStore(), transport:ModelTransport=async()=>reply('ok'))=>({model:main,transport,budgets,authorize:async()=>true,audit:{append:async()=>{}},purposes:[
 {id:'analysis',mode:'agent' as const,model:main,transport,tools:[tool]},
 {id:'report',mode:'text' as const,model:report,transport}
]});
for(const [name,request] of [
 ['undeclared',{purpose:'other'}],['missing',{}],['wrong mode',{purpose:'analysis'}],
 ['tool policy override',{purpose:'report',toolExecution:'parallel' as const}],
 ['thinking override',{purpose:'report',thinkingLevel:'high' as const}]
] as const)test(`purpose ${name} blocks before model effect`,async()=>{
 let calls=0;const runtime=createRuntime(plan(undefined,async()=>{calls++;return reply('wrong');}));
 const result=await runtime.runText({taskId:'guard',prompt:'Synthetic',limits,...request});
 assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_REQUEST');assert.equal(calls,0);
});

test('changing any declared purpose cannot reset or alter an existing task',async()=>{
 let calls=0;const budgets=createMemoryBudgetStore(); const options=plan(budgets,async()=>{calls++;return reply('ok');});
 assert.equal((await createRuntime(options).runText({taskId:'pinned',purpose:'report',prompt:'Synthetic',limits})).status,'succeeded');
 options.purposes[0]!.model={...main,id:'altered-analysis'};
 const result=await createRuntime(options).runText({taskId:'pinned',purpose:'report',prompt:'Synthetic',limits});
 assert.equal(result.status!=='succeeded'&&result.reason,'CONFIGURATION_CHANGED');assert.equal(calls,1);
});

test('caller cannot replace the declared tool executor or grant report tools',async()=>{
 let declared=0,substituted=0,turn=0;
 const fixed={...tool,execute:async()=>{declared++;return {net:1050};}};
 const options=plan(undefined,async()=>++turn===1?{content:[{kind:'tool',id:'fixed',name:'net',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}}:reply('done'));
 options.purposes[0]!.tools=[fixed];const runtime=createRuntime(options);
 const result=await runtime.runAgent({taskId:'executor',purpose:'analysis',prompt:'Synthetic',limits,tools:[{...fixed,execute:async()=>{substituted++;return null;}}]});
 assert.equal(result.status,'succeeded');assert.equal(declared,1);assert.equal(substituted,0);
 const denied=await runtime.runAgent({taskId:'executor',purpose:'report',prompt:'Synthetic',limits,tools:[fixed]});
 assert.equal(denied.status!=='succeeded'&&denied.reason,'INVALID_REQUEST');
});

test('mutating input plan after construction does not change a captured purpose',async()=>{
 let provider='';const options=plan(undefined,async request=>{provider=request.model.provider;return reply('done');});
 const runtime=createRuntime(options);options.purposes[1]!.model={...report,provider:'unapproved'};
 const result=await runtime.runText({taskId:'snapshot',purpose:'report',prompt:'Synthetic',limits});
 assert.equal(result.status,'succeeded');assert.equal(provider,'synthetic-report');
});

test('cancelled purpose retains physical ownership and rejects late success or another purpose',async()=>{
 let resolve!: (reply:ModelReply)=>void;let admitted!:()=>void;const ready=new Promise<void>(r=>{admitted=r;});
 const options=plan(undefined,()=>{admitted();return new Promise<ModelReply>(r=>{resolve=r;});});
 const runtime=createRuntime(options);const stop=new AbortController();
 const pending=runtime.runText({taskId:'late',purpose:'report',prompt:'Synthetic',limits,signal:stop.signal});await ready;stop.abort();
 assert.equal((await pending).status,'cancelled');
 const competing=await runtime.runAgent({taskId:'late',purpose:'analysis',prompt:'Synthetic',limits,tools:[tool]});
 assert.equal(competing.status!=='succeeded'&&competing.reason,'TASK_BUSY');
 resolve(reply('late'));await runtime.waitForIdle('late');
 const resumed=await createRuntime({...options, purposes:options.purposes.map(p=>({...p,transport:async()=>reply('settled')}))}).runText({taskId:'late',purpose:'report',prompt:'Again',limits});
 assert.equal(resumed.status,'succeeded');assert.equal(resumed.usage.modelCalls,2);
 assert.equal(resumed.usage.outputTokens,22,'unknown cancelled reservation remains charged');
});

test('purpose audit acknowledgement failure admits no model',async()=>{
 let calls=0;const options=plan(undefined,async()=>{calls++;return reply('wrong');});
 options.audit={append:async()=>{throw Error('offline storage fault');}};
 const result=await createRuntime(options).runText({taskId:'audit-purpose',purpose:'report',prompt:'Synthetic',limits});
 assert.equal(result.status!=='succeeded'&&result.reason,'AUDIT_FAILED');assert.equal(calls,0);
});
