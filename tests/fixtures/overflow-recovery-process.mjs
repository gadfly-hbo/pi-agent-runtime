// Synthetic durable host and deliberate pre-summary process exit, not a migration tool.
import {readFile,writeFile,rename,open,unlink,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createSessionRuntime,createPiTransport,RuntimeFault} from '../../src/index.ts';
const [root,mode]=process.argv.slice(2),ledgerPath=join(root,'ledger.json');
const save=async value=>{await writeFile(ledgerPath+'.tmp',JSON.stringify(value));await rename(ledgerPath+'.tmp',ledgerPath);};
const budgets={claim:async(taskId,runId,configuration)=>{
 let previous;try{previous=JSON.parse(await readFile(ledgerPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const state=previous??{taskId,configuration,usage:{modelCalls:0,toolCalls:0,outputTokens:0,resourceUnits:0,activeMs:0}};
 if(state.taskId!==taskId||state.configuration!==configuration)throw new RuntimeFault('CONFIGURATION_CHANGED');
 if(state.owner)throw new RuntimeFault('TASK_BUSY');state.owner=runId;await save(state);
 return {snapshot:()=>({...state.usage}),reserveModel:async()=>{throw Error('Explicit cap required');},reserveModelUpTo:async n=>{state.usage.modelCalls++;state.usage.outputTokens+=n;state.usage.resourceUnits++;await save(state);return n;},
 settleModel:async(n,actual)=>{state.usage.outputTokens+=actual-n;await save(state);},reserveTool:async()=>{throw Error('No tools in this fixture');},release:async ms=>{state.usage.activeMs+=ms;delete state.owner;await save(state);}};
}};
const model={provider:'synthetic',id:'overflow-process',protocol:'openai-completions',endpoint:'https://synthetic.invalid/v1',contextWindow:200000,maxOutputTokens:16};
let calls=0;
const sse=(text,stop='stop',output=1)=>new Response([
{id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]},
{id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:stop}],usage:{prompt_tokens:9,completion_tokens:output,total_tokens:9+output}}
].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
if(mode==='crash'){
 const {AgentHarness}=await import('@earendil-works/pi-agent-core');const create=AgentHarness.create;
 AgentHarness.create=async(...args)=>{const attached=await create(...args);attached.harness.hooks.on('before_compaction',event=>{if(event.reason==='overflow')process.exit(85);});return attached;};
}
const transport=createPiTransport({model,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
 calls++;await appendFile(join(root,'physical.jsonl'),JSON.stringify({mode})+'\n');
 if(String(init?.body).includes('context summarization assistant'))return sse('SUMMARY');
 return calls===1?sse('PREVIOUS'):sse('PARTIAL','length',3);
}});
const runtime=createSessionRuntime({model,transport,budgets,authorize:async()=>true,audit:{append:e=>appendFile(join(root,'audit.jsonl'),JSON.stringify(e)+'\n')},bindOperation:async b=>appendFile(join(root,'bindings.jsonl'),JSON.stringify(b)+'\n'),reconcile:async()=>'ready',
 harness:{compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:1}},storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>{const file=await open(join(root,'writer.lock'),'wx');return{release:async()=>{await file.close();await unlink(join(root,'writer.lock'));}};}}});
const session=mode==='crash'?await runtime.create():JSON.parse(await readFile(join(root,'session.json'),'utf8'));
await writeFile(join(root,'session.json'),JSON.stringify(session));
const request={sessionId:session.id,taskId:'overflow-process-task',prompt:mode==='crash'?'seed':'',tools:[],limits:{modelCalls:10,toolCalls:0,outputTokens:100,wallTimeMs:10000},modelRecovery:{extraAttempts:1}};
if(mode==='crash'){const seed=await runtime.run(request);if(seed.status!=='succeeded')throw Error('Seed must succeed');console.log(JSON.stringify(await runtime.run({...request,prompt:'continue'})));}
else console.log(JSON.stringify(await runtime.run({...request,operation:'resume'})));
