// Real SDK/native Session/Harness with a disposable durable host; all model IO is synthetic.
import {readFile,writeFile,appendFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAttemptHost} from './model-attempt-host.mjs';
const [root,mode]=process.argv.slice(2);
const sdk=await import(process.env.PI_TEST_SDK_ENTRY?pathToFileURL(process.env.PI_TEST_SDK_ENTRY).href:new URL('../../src/index.ts',import.meta.url).href);
const now=()=>process.env.PI_TEST_SYNTHETIC_NOW===undefined?Date.now():Number(process.env.PI_TEST_SYNTHETIC_NOW);
const race=mode.startsWith('race-');
const sessionRoot=race||mode==='bypass-unknown'?join(root,mode):root;
const host=await createAttemptHost(root,sdk,{now,sessionRoot});
async function waitFor(path){for(let i=0;i<2000;i++){try{await access(path);return;}catch{}await new Promise(r=>setTimeout(r,2));}throw Error('Synthetic barrier not reached');}
const model={provider:'synthetic',id:'work-model',protocol:'openai-completions',endpoint:'https://synthetic.invalid/v1',contextWindow:200000,maxOutputTokens:16};
const outcome=(stop='complete')=>({model,stop,physicalStatus:'response-received',usageFinal:true,usage:{inputTokens:{kind:'known',value:1},outputTokens:{kind:'known',value:1}},diagnostic:'COMPLETE'});
const answer=()=>({stop:'complete',content:[{kind:'text',text:'synthetic block complete'}],usage:{inputTokens:1,outputTokens:1},outcome:outcome()});
let physical=0;
const transport=async()=>{
  physical++;await host.physical({mode,physical});
  if(mode==='crash'||mode==='crash-recovery'&&physical===2)process.exit(86);
  if((race||['first','second-fault','notsent','again-after-release','crash-recovery'].includes(mode))&&physical===1)
    throw new sdk.ProviderFailure('network',{...outcome('error'),category:'network',diagnostic:'REQUEST_FAILED'});
  return answer();
};
let changed=false;
const runtime=sdk.createSessionRuntime({model,transport,modelObservations:'v1',modelAttempts:'v1',budgets:host.budgets,authorize:async(action,signal)=>{
  if(race && action.kind==='model' && action.modelAttempt.kind==='recovery'){
    await writeFile(join(root,mode+'-ready'),'ready',{flag:'wx'});
    await waitFor(join(root,mode==='race-a'?'race-b-ready':'race-a-ready'));
  }
  const granted=await host.authorize(action,signal);
  if(race && granted && action.kind==='model'){
    if(!await host.authorize(action,signal))throw Error('Duplicate same-attempt grant changed');
  }
  return granted;
},
  audit:{append:async event=>{await host.audit.append(event);if(mode==='notsent' && event.kind==='model.admitted' && event.modelAttempt?.kind==='recovery')changed=true;}},
  toolAdmission:{policyVersion:'synthetic-view',correctionLimit:0,view:async()=>({version:changed?'changed':'fixed',tools:[]})},
  purposes:['analysis','report','review'].map(id=>({id,mode:'agent',model,transport,tools:[]})),
  storage:host.storage,reconcile:async()=>'ready',bindOperation:async binding=>appendFile(join(root,'bindings.jsonl'),JSON.stringify(binding)+'\n')});
let session;
try{session=JSON.parse(await readFile(join(sessionRoot,'session.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;session=await runtime.create();await writeFile(join(sessionRoot,'session.json'),JSON.stringify(session),{flag:'wx'});}
if(mode==='fork')session=await runtime.fork(session.id);
if(mode==='revoke')await host.atomic(s=>{s.work.revoked=true;});
if(mode==='race-b')await waitFor(join(root,'race-a-ready'));
const request={sessionId:session.id,taskId:race?'synthetic-'+mode:mode==='bypass-unknown'?'must-not-bypass-unknown':'synthetic-business-task',purpose:['second-fault','fork','again-after-release'].includes(mode)?'report':mode==='continue'?'review':'analysis',prompt:'synthetic block',tools:[],
  limits:{cumulative:'unlimited',maxOutputTokens:16,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000},modelRecovery:{extraAttempts:1}};
const result=await runtime.run(request);
await runtime.waitForIdle(request.taskId);
const facts=await runtime.inspectFacts({sessionId:session.id,taskId:request.taskId,purpose:request.purpose});
const state=await host.read();
const receipt={mode,result,physical,facts,state,realProviderCalls:0};
await writeFile(join(root,'receipt-'+mode+'.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
