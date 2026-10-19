// Disposable synthetic host, NOT an SDK business store or migration. Every path is supplied by the test.
import {open,readFile,rename,unlink,mkdir,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export async function createAttemptHost(root,sdk,{now=()=>Date.now(),sessionRoot=root}={}){
  await mkdir(root,{recursive:true});
  await mkdir(sessionRoot,{recursive:true});
  const path=join(root,'host.json'),lock=join(root,'host.lock');
  async function atomic(change){
    let handle;
    for(let i=0;i<200;i++){
      try{handle=await open(lock,'wx');break;}
      catch(error){if(error.code!=='EEXIST')throw error;await new Promise(r=>setTimeout(r,2));}
    }
    if(!handle)throw new sdk.RuntimeFault('STATE_FAILED');
    try{
      let state;try{state=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      state??={version:1,work:{deadline:now()+300000,revoked:false,blocked:false,recovery:null},tasks:{},attempts:{},events:[],releases:[]};
      const value=change(state);
      const temporary=path+'.'+randomUUID();const file=await open(temporary,'wx');
      try{await file.writeFile(JSON.stringify(state));await file.sync();}finally{await file.close();}
      await rename(temporary,path);return{state,value};
    }finally{await handle.close();await unlink(lock);}
  }
  await atomic(()=>{});
  const read=async()=>JSON.parse(await readFile(path,'utf8'));
  const blocked=s=>s.work.revoked||s.work.blocked||now()>=s.work.deadline;
  async function authorize(action){
    return(await atomic(s=>{
      if(action.kind!=='model')return !blocked(s);
      const ref=action.modelAttempt;
      if(!ref || ref.version!=='1' || !ref.physicalAttemptId || !ref.logicalRequestId)return false;
      const key=ref.physicalAttemptId,previous=s.attempts[key];
      if(blocked(s))return false;
      if(previous){
        if(!isDeepStrictEqual(previous.ref,ref)){s.work.blocked=true;return false;}
        return previous.allowed===true && previous.phase==='authorized';
      }
      // This fixture hosts a serial business work. Unfinished admission after a crash stays UNKNOWN.
      if(Object.values(s.attempts).some(a=>['authorized','unknown','conflict'].includes(a.phase)))return false;
      if(ref.kind==='recovery'){
        const parent=s.attempts[ref.recovery?.physicalAttemptId];
        if(!parent || parent.ref.logicalRequestId!==ref.recovery.logicalRequestId || parent.phase!=='finished' || s.work.recovery)return false;
        s.work.recovery={physicalAttemptId:key,state:'reserved'};
      }
      s.attempts[key]={ref,taskId:action.taskId,runId:action.runId,allowed:true,phase:'authorized'};
      return true;
    })).value;
  }
  const audit={append:async event=>{
    await atomic(s=>{
      s.events.push(event);
      const fact=event.modelAttemptFact;if(!fact?.terminal)return;
      const key=fact.attempt.physicalAttemptId,previous=s.attempts[key];
      if(previous && !isDeepStrictEqual(previous.ref,fact.attempt)){s.work.blocked=true;previous.phase='conflict';return;}
      const row=previous??(s.attempts[key]={ref:fact.attempt,taskId:event.taskId,runId:event.runId,allowed:false});
      if(row.phase==='not-sent' && fact.outcome.physicalStatus!=='not-sent'){
        row.phase='conflict';s.work.blocked=true;row.conflict=fact;return;
      }
      const old=row.fact;
      if(old && isDeepStrictEqual(old,fact))return;
      row.fact=fact;
      const result=fact.outcome;
      const zero=result.usageFinal && result.usage.inputTokens.kind==='known'&&result.usage.inputTokens.value===0&&result.usage.outputTokens.kind==='known'&&result.usage.outputTokens.value===0;
      if(result.physicalStatus==='not-sent' && zero && !fact.late){
        row.phase='not-sent';
        if(s.work.recovery?.physicalAttemptId===key && s.work.recovery.state==='reserved'){
          s.releases.push({physicalAttemptId:key,reason:'terminal-not-sent'});s.work.recovery=null;
        }
      }else if(result.physicalStatus==='response-received' && !fact.late){
        row.phase='finished';if(s.work.recovery?.physicalAttemptId===key)s.work.recovery.state='spent';
      }else{
        row.phase='unknown';s.work.blocked=true; // No refund, including a late result.
      }
    });
  }};
  const budgets={claimUncapped:async(taskId,runId,configuration)=>{
    let current;
    await atomic(s=>{
      const old=s.tasks[taskId];
      if(old && old.configuration!==configuration)throw new sdk.RuntimeFault('CONFIGURATION_CHANGED');
      current=old??{configuration,usage:{modelCalls:0,toolCalls:0,inputTokens:0,outputTokens:0,reservedOutputTokens:0,resourceUnits:0,activeMs:0},reservations:{}};
      if(current.owner)throw new sdk.RuntimeFault('TASK_BUSY');
      current.owner=runId;s.tasks[taskId]=current;
    });
    let active;
    const update=async change=>{const result=await atomic(s=>{const t=s.tasks[taskId];if(t.owner!==runId)throw new sdk.RuntimeFault('STATE_FAILED');const value=change(t,s);return{task:t,value};});current=result.value.task;return result.value.value;};
    return{snapshot:()=>({...current.usage}),reserveModel:async()=>{throw new sdk.RuntimeFault('INVALID_REQUEST');},
      reserveModelUpTo:async n=>update((t,s)=>{
        const admitted=Object.values(s.attempts).find(a=>a.allowed && a.runId===runId&&a.phase==='authorized'&&!t.reservations[a.ref.physicalAttemptId]);
        if(!admitted)throw new sdk.RuntimeFault('STATE_FAILED');
        active=admitted.ref.physicalAttemptId;t.reservations[active]={tokens:n,final:false};
        t.usage.modelCalls++;t.usage.resourceUnits++;t.usage.outputTokens+=n;t.usage.reservedOutputTokens+=n;return n;
      }),
      recordModelUsage:async(n,usage)=>update(t=>{
        const reservation=t.reservations[active];if(!reservation||reservation.tokens!==n)throw new sdk.RuntimeFault('STATE_FAILED');
        if(reservation.final)return;
        if(usage.inputTokens!==undefined)t.usage.inputTokens+=usage.inputTokens;
        if(usage.final && usage.outputTokens!==undefined){t.usage.outputTokens+=usage.outputTokens-n;t.usage.reservedOutputTokens-=n;reservation.final=true;}
      }),
      settleModel:async()=>{throw new sdk.RuntimeFault('INVALID_REQUEST');},settleModelUsage:async()=>{throw new sdk.RuntimeFault('INVALID_REQUEST');},
      reserveTool:async units=>update(t=>{t.usage.toolCalls++;t.usage.resourceUnits+=units;}),
      release:async ms=>update(t=>{t.usage.activeMs+=ms;delete t.owner;}),
    };
  },claim:async()=>{throw new sdk.RuntimeFault('INVALID_REQUEST');}};
  const storage={cwd:sessionRoot,directory:join(sessionRoot,'sessions'),policyVersion:'synthetic-attempt-host-v1',authorize:async()=>true,
    acquireWriter:async()=>{const handle=await open(join(sessionRoot,'writer.lock'),'wx');return{release:async()=>{await handle.close();await unlink(join(sessionRoot,'writer.lock'));}};}};
  const physical=async record=>appendFile(join(root,'physical.jsonl'),JSON.stringify(record)+'\n');
  return{authorize,audit,budgets,storage,read,atomic,physical};
}
