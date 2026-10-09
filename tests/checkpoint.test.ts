import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime,createMemoryBudgetStore} from '../src/index.ts';
import type {ModelConfig, ModelReply, Tool,ModelTransport,ConversationCheckpoint} from '../src/index.ts';
const model:ModelConfig={provider:'synthetic',id:'checkpoint',protocol:'openai-completions',endpoint:'https://invalid.invalid',contextWindow:8192};
const limits={modelCalls:4,toolCalls:4,outputTokens:100,wallTimeMs:10000};
const reply=(text:string):ModelReply=>({content:[{kind:'text',text}],stop:'complete',usage:{inputTokens:1,outputTokens:2}});
test('model checkpoint durable acknowledgement failure prevents proposed tool effect',async()=>{
 let effects=0,saves=0;
 const tool:Tool={name:'calculate',description:'Synthetic local sum',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{effects++;return {net:1050};}};
 const runtime=createRuntime({model,transport:async()=>({content:[{kind:'tool',id:'net-1',name:'calculate',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}}),authorize:async()=>true,audit:{append:async()=>{}}});
 const result=await runtime.runAgent({taskId:'checkpoint-model-failure',prompt:'Calculate synthetic net',limits,tools:[tool],saveCheckpoint:async()=>{saves++;throw Error('Synthetic durable write rejected');}});
 assert.equal(result.status!=='succeeded'&&result.reason,'STATE_FAILED');
 assert.equal(effects,0);assert.equal(saves,1);assert.equal(result.usage.modelCalls,1);assert.equal(result.usage.toolCalls,0);
});

test('tool checkpoint write failure keeps the actual effect but stops the dependent model and publish',async()=>{
 let effects=0,requests=0,published=0; const saved:unknown[]=[];
 const tool:Tool={name:'calculate',description:'Synthetic local sum',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{effects++;return {net:1050};}};
 const runtime=createRuntime({model,transport:async()=>{requests++;return requests===1?{content:[{kind:'tool',id:'net-1',name:'calculate',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}}:reply('1050');},authorize:async action=>{if(action.kind==='publish')published++;return true;},audit:{append:async()=>{}}});
 const result=await runtime.runAgent({taskId:'checkpoint-tool-failure',prompt:'Calculate',limits,tools:[tool],saveCheckpoint:async checkpoint=>{saved.push(checkpoint);if(checkpoint.messages.at(-1)?.role==='tool')throw Error('Synthetic storage rejection');}});
 assert.equal(result.status!=='succeeded'&&result.reason,'STATE_FAILED');assert.equal(effects,1);assert.equal(requests,1);assert.equal(published,0);assert.equal(saved.length,3);
});
test('both model and tool checkpoints are acknowledged before the next model consumes results',async()=>{
 let requests=0;const saved:import('../src/index.ts').ConversationCheckpoint[]=[];
 const tool:Tool={name:'calculate',description:'Synthetic local sum',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{assert.equal(saved.at(-1)?.messages.at(-1)?.calls?.[0]?.id,'net-1');return {net:1050};}};
 const runtime=createRuntime({model,transport:async request=>{if(++requests===1)return{content:[{kind:'tool',id:'net-1',name:'calculate',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}};assert.equal(saved.at(-1)?.messages.at(-1)?.text,'{"net":1050}');assert.equal(request.messages.find(m=>m.role==='tool')?.text,'{"net":1050}');return reply('1050');},authorize:async()=>true,audit:{append:async()=>{}}});
 const result=await runtime.runAgent({taskId:'checkpoint-complete',prompt:'Calculate',limits,tools:[tool],saveCheckpoint:async checkpoint=>{saved.push(structuredClone(checkpoint));checkpoint.messages.length=0;}});
 assert.equal(result.status,'succeeded');assert.equal(saved.length,4);assert.equal(saved.at(-1)?.messages.at(-1)?.text,'1050');
});
test('explicit stop while awaiting storage acknowledgement permits no proposed tool or late publication',async()=>{
 let acknowledge!:()=>void,ready!:()=>void,effects=0;const waiting=new Promise<void>(r=>{ready=r;});const signal=new AbortController();
 const tool:Tool={name:'calculate',description:'Synthetic local sum',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{effects++;return 1050;}};
 const runtime=createRuntime({model,transport:async()=>({content:[{kind:'tool',id:'net-1',name:'calculate',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}}),authorize:async()=>true,audit:{append:async()=>{}}});
 const pending=runtime.runAgent({taskId:'checkpoint-stop',prompt:'Calculate',limits,tools:[tool],signal:signal.signal,saveCheckpoint:()=>{ready();return new Promise<void>(r=>{acknowledge=r;});}});
 await waiting;signal.abort();assert.equal((await pending).status,'cancelled');acknowledge();await runtime.waitForIdle('checkpoint-stop');assert.equal(effects,0);
});

test('normal business waiting saves tool output and explicit continuation consumes it without repeating the tool',async()=>{
 const budgets=createMemoryBudgetStore();let effects=0,requests=0,waiting=false;let checkpoint:ConversationCheckpoint|undefined;
 const tool:Tool={name:'ask_user',description:'Persist a synthetic clarification',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{effects++;waiting=true;return {question:'What currency and unit?'};}};
 const transport:ModelTransport=async request=>{if(++requests===1)return {content:[{kind:'tool',id:'question-1',name:'ask_user',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}};
 assert.equal(request.messages.some(m=>m.role==='tool'&&m.text.includes('What currency and unit?')),true);
 assert.equal(request.messages.at(-1)?.text,'万，人民币');return reply('Understood: CNY, scale 10000');};
 const options={model,transport,authorize:async()=>true,audit:{append:async()=>{}},budgets};
 const first=await createRuntime(options).runAgent({taskId:'business-wait',prompt:'Calculate',limits,tools:[tool],shouldYield:()=>waiting,saveCheckpoint:async saved=>{checkpoint=structuredClone(saved);}});
 assert.equal(first.status,'waiting');assert.equal(requests,1);assert.equal(effects,1);assert.ok(checkpoint);assert.equal(checkpoint.messages.at(-1)?.role,'tool');
 const resumed=await createRuntime(options).runAgent({taskId:'business-wait',prompt:'万，人民币',limits,tools:[tool],checkpoint,saveCheckpoint:async saved=>{checkpoint=structuredClone(saved);}});
 assert.equal(resumed.status,'succeeded');assert.equal(effects,1);assert.equal(requests,2);assert.equal(resumed.usage.modelCalls,2);assert.equal(resumed.usage.toolCalls,1);
});

for(const scenario of ['foreign-task','unpaired-tool','duplicate-result','unsigned-conflict','effect-unknown'] as const)test(`checkpoint ${scenario} refuses before any model or tool effect`,async()=>{
 let effects=0;const checkpoint:ConversationCheckpoint={version:'1.0',taskId:'checked-history',state:'ready',messages:[{role:'user',text:'Calculate'}]};
 if(scenario==='foreign-task')checkpoint.taskId='other-business';
 if(scenario==='unpaired-tool')checkpoint.messages.push({role:'tool',text:'1050',toolId:'not-issued',toolName:'calculate'});
 if(scenario==='duplicate-result')checkpoint.messages.push({role:'assistant',text:'',calls:[{id:'c1',name:'calculate',arguments:{}}]}, {role:'tool',text:'1050',toolId:'c1',toolName:'calculate'},{role:'tool',text:'1050',toolId:'c1',toolName:'calculate'});
 if(scenario==='unsigned-conflict')checkpoint.messages.push({role:'assistant',text:'',calls:[{id:'c1',name:'calculate',arguments:{}}],blocks:[{kind:'tool',id:'different',name:'calculate',arguments:{}}]});
 if(scenario==='effect-unknown'){checkpoint.state='tool-admitted';checkpoint.inFlightToolId='c1';checkpoint.messages.push({role:'assistant',text:'',calls:[{id:'c1',name:'calculate',arguments:{}}]});}
 const runtime=createRuntime({model,transport:async()=>{effects++;return reply('unwanted');},authorize:async()=>true,audit:{append:async()=>{}}});
 const result=await runtime.runAgent({taskId:'checked-history',prompt:'Continue',limits,tools:[],checkpoint,saveCheckpoint:async()=>{}});
 assert.equal(result.status!=='succeeded'&&result.reason,scenario==='effect-unknown'?'STATE_FAILED':'INVALID_REQUEST');assert.equal(effects,0);
});

test('explicit resume executes only unadmitted tool calls and never replays an acknowledged result or model call',async()=>{
 let firstEffects=0,secondEffects=0,requests=0;let saved:ConversationCheckpoint|undefined;
 const budgets=createMemoryBudgetStore();
 const completed:Tool={name:'first',description:'Previously executed synthetic effect',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{firstEffects++;return 17;}};
 const pending:Tool={...completed,name:'second',execute:async()=>{secondEffects++;return 23;}};
 const options={model,budgets,transport:async(request:import('../src/index.ts').ModelRequest):Promise<ModelReply>=>{
   if(++requests===1)return{content:[{kind:'tool',id:'first-id',name:'first',arguments:{}},{kind:'tool',id:'second-id',name:'second',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}};
   assert.equal(request.messages.filter(m=>m.role==='tool').length,2);assert.equal(request.messages.find(m=>m.toolId==='first-id')?.text,'17');assert.equal(request.messages.find(m=>m.toolId==='second-id')?.text,'23');return reply('40');
 },authorize:async()=>true,audit:{append:async()=>{}}};
 const initial=await createRuntime(options).runAgent({taskId:'partial-batch',prompt:'Compute two synthetic values',limits,tools:[completed,pending],shouldYield:()=>firstEffects===1,saveCheckpoint:async c=>{saved=structuredClone(c);}});
 assert.equal(initial.status,'waiting');assert.equal(firstEffects,1);assert.equal(secondEffects,0);assert.ok(saved);assert.equal(saved.messages.at(-1)?.toolId,'first-id');
 const result=await createRuntime(options).runAgent({taskId:'partial-batch',prompt:'',limits,tools:[completed,pending],checkpoint:saved,saveCheckpoint:async c=>{saved=structuredClone(c);}});
 assert.equal(result.status,'succeeded');assert.equal(firstEffects,1);assert.equal(secondEffects,1);assert.equal(requests,2);assert.equal(result.usage.modelCalls,2);assert.equal(result.usage.toolCalls,2);assert.equal(saved?.messages.filter(m=>m.toolId==='first-id').length,1);
});
test('completed checkpoint can be read back without a new model request or tool effect',async()=>{
 let requests=0;const runtime=createRuntime({model,transport:async()=>{requests++;return reply('unwanted');},authorize:async()=>true,audit:{append:async()=>{}}});
 const result=await runtime.runAgent({taskId:'completed',prompt:'',limits,tools:[],checkpoint:{version:'1.0',taskId:'completed',state:'completed',messages:[{role:'user',text:'Synthetic'},{role:'assistant',text:'Saved answer'}]},saveCheckpoint:async()=>{}});
 assert.equal(result.status,'succeeded');assert.equal(result.status==='succeeded'&&result.value,'Saved answer');assert.equal(requests,0);assert.equal(result.usage.modelCalls,0);
});

test('a rejected tool-admission checkpoint prevents the effect and is not treated as tool success',async()=>{
 let effects=0;const tool:Tool={name:'calculate',description:'Synthetic effect',effect:'write',resourceUnits:1,parameters:{type:'object',properties:{}},execute:async()=>{effects++;return 1;}};
 const result=await createRuntime({model,transport:async()=>({content:[{kind:'tool',id:'c1',name:'calculate',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:2}}),authorize:async()=>true,audit:{append:async()=>{}}}).runAgent({taskId:'admission-save-failure',prompt:'Calculate',limits,tools:[tool],saveCheckpoint:async c=>{if(c.state==='tool-admitted')throw Error('Synthetic disk fault');}});
 assert.equal(result.status!=='succeeded'&&result.reason,'STATE_FAILED');assert.equal(effects,0);assert.equal(result.usage.toolCalls,0);
});
test('checkpointed runs cannot use a parallel tool policy or unacknowledged history',async()=>{
 let requests=0;const runtime=createRuntime({model,transport:async()=>{requests++;return reply('unwanted');},authorize:async()=>true,audit:{append:async()=>{}}});
 const parallel=await runtime.runAgent({taskId:'parallel-checkpoint',prompt:'Synthetic',limits,tools:[],toolExecution:'parallel',saveCheckpoint:async()=>{}});
 assert.equal(parallel.status!=='succeeded'&&parallel.reason,'INVALID_REQUEST');
 const unacknowledged=await runtime.runAgent({taskId:'no-checkpoint-writer',prompt:'Synthetic',limits,tools:[],checkpoint:{version:'1.0',taskId:'no-checkpoint-writer',state:'ready',messages:[{role:'user',text:'Synthetic'}]}});
 assert.equal(unacknowledged.status!=='succeeded'&&unacknowledged.reason,'INVALID_REQUEST');assert.equal(requests,0);
});
