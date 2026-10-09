// Synthetic durable host, deliberately not a production database implementation.
// Parent waits for each child exit; an exclusive ledger lock still protects claims.
import {readFile,writeFile,rename,open,unlink,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createSessionRuntime,RuntimeFault} from '../../src/index.ts';
const [root,mode]=process.argv.slice(2), path=join(root,'ledger.json');
const load=async()=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}};
const save=async value=>{await writeFile(path+'.tmp',JSON.stringify(value));await rename(path+'.tmp',path);};
const budgets={claim:async()=>{throw Error('Finite path forbidden in this fixture');},claimUncapped:async(taskId,runId,configuration)=>{
 let lock;try{lock=await open(join(root,'budget.lock'),'wx');}catch{throw new RuntimeFault('TASK_BUSY');}
 const state=(await load())??{taskId,configuration,usage:{modelCalls:0,toolCalls:0,outputTokens:0,inputTokens:0,reservedOutputTokens:0,resourceUnits:0,activeMs:0}};
 if(state.taskId!==taskId||state.configuration!==configuration||state.owner){await lock.close();await unlink(join(root,'budget.lock'));throw new RuntimeFault(state.owner?'TASK_BUSY':'CONFIGURATION_CHANGED');}
 state.owner=runId;state.started=Date.now();await save(state);
 return{snapshot:()=>({...state.usage}),reserveModel:async()=>{throw Error('Explicit cap required');},reserveModelUpTo:async n=>{state.usage.modelCalls++;state.usage.resourceUnits++;state.usage.outputTokens+=n;state.usage.reservedOutputTokens+=n;await save(state);return n;},
 settleModel:async()=>{throw Error('Full usage required');},settleModelUsage:async(n,u)=>{state.usage.outputTokens+=u.outputTokens-n;state.usage.inputTokens+=u.inputTokens;state.usage.reservedOutputTokens-=n;await save(state);},
 reserveTool:async units=>{state.usage.toolCalls++;state.usage.resourceUnits+=units;await save(state);},
 release:async ms=>{state.usage.activeMs+=ms;delete state.owner;delete state.started;await save(state);await lock.close();await unlink(join(root,'budget.lock'));}};
}};
const answer=text=>({content:[{kind:'text',text}],stop:'complete',usage:{inputTokens:3,outputTokens:2}});
const options={model:{provider:'synthetic',id:'uncapped-process',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:8192},budgets,authorize:async()=>true,audit:{append:e=>appendFile(join(root,'audit.jsonl'),JSON.stringify(e)+'\n')},
 storage:{directory:join(root,'sessions'),cwd:root,policyVersion:'fixture-v1',authorize:async()=>true,acquireWriter:async()=>{const h=await open(join(root,'writer.lock'),'wx');return{release:async()=>{await h.close();await unlink(join(root,'writer.lock'));}};}},
 bindOperation:async b=>appendFile(join(root,'bindings.jsonl'),JSON.stringify(b)+'\n'),reconcile:async()=>mode==='recover'?'unknown':'ready',
 transport:async request=>{await appendFile(join(root,'physical.jsonl'),mode+'\n');if(mode==='crash')process.exit(81);
 const prior=request.messages.find(m=>m.role==='tool');if(!prior)return{content:[{kind:'tool',id:'lookup',name:'lookup',arguments:{}}],stop:'tools',usage:{inputTokens:3,outputTokens:2}};
 if(prior.text!=='73')throw Error('Stored context not consumed');return answer('consumed 73');}};
const runtime=createSessionRuntime(options);
let session=mode==='first'?await runtime.create():JSON.parse(await readFile(join(root,'session.json'),'utf8'));
if(mode==='fork')session=await runtime.fork(session.id);
await writeFile(join(root,'session.json'),JSON.stringify(session));
const result=await runtime.run({sessionId:session.id,taskId:'stable-process',prompt:mode==='recover'?'':'lookup',...(mode==='recover'?{operation:'resume'}:{}),limits:{cumulative:'unlimited',maxOutputTokens:4,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000},modelRecovery:{extraAttempts:1},
 tools:[{name:'lookup',description:'Synthetic read',effect:'read',resourceUnits:3,parameters:{type:'object',properties:{}},execute:async()=>{await appendFile(join(root,'effects.jsonl'),'73\n');return 73;}}]});
console.log(JSON.stringify(result));
