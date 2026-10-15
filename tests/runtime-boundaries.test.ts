import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createExecutionTools, createLocalExecutionEnvironment, RuntimeFault, createSessionRuntime, createRuntime, createMemoryBudgetStore, createPiTransport} from '../src/index.ts';
import type {ExecutionEnvironment, ModelConfig, SessionRuntimeOptions} from '../src/index.ts';

test('S3/F10/R1-R3/V17: native read preserves missing-file and authority errors without host error detail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r1-r4-errors-'));
  const env = await createLocalExecutionEnvironment({root, policyVersion:'synthetic', exclusiveWorkspace:true,
    maxFileBytes:100000, maxOutputBytes:1000, timeoutMs:1000});
  const [read] = createExecutionTools(env, ['read']);
  const signal = new AbortController().signal;
  await assert.rejects(read!.execute({path:'missing.txt'}, signal), {code:'not_found'});
  await assert.rejects(read!.execute({path:'../outside'}, signal), {code:'permission_denied'});
  await writeFile(join(root, 'fixture.txt'), 'synthetic');
  await symlink(join(root, 'fixture.txt'), join(root, 'link'));
  await assert.rejects(read!.execute({path:'link'}, signal), {code:'permission_denied'});
  const unsafe: ExecutionEnvironment = {...env, read:async () => {throw Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), {code:'EIO'});}};
  const [unknown] = createExecutionTools(unsafe, ['read']);
  await assert.rejects(unknown!.execute({path:'fixture.txt'}, signal), error => {
    assert.equal((error as {code:string}).code, 'unknown');
    assert.equal(String(error).includes('SYNTHETIC_PRIVATE_DETAIL'), false);
    assert.equal((error as Error).cause, undefined);
    return true;
  });
});

test('S3/F10/R2/V13: native file and process errors retain cancellation, timeout and unavailable classifications', async () => {
  const signal = new AbortController().signal;
  for (const [reason, fileCode, processCode] of [
    ['CANCELLED', 'aborted', 'aborted'],
    ['DEADLINE_EXCEEDED', 'aborted', 'timeout'],
    ['CAPABILITY_UNAVAILABLE', 'not_supported', 'shell_unavailable'],
  ] as const) {
    const host: ExecutionEnvironment = {cwd:tmpdir(), policyVersion:'synthetic', resolvePath:async path=>join(tmpdir(),path),
      stat:async()=>({path:'synthetic',name:'synthetic',kind:'file',size:1,modifiedAt:0}),
      read:async()=>{throw new RuntimeFault(reason);}, write:async()=>{}, exec:async()=>{throw new RuntimeFault(reason);}};
    const [read, bash] = createExecutionTools(host, ['read', 'bash']);
    await assert.rejects(read!.execute({path:'synthetic'},signal), {code:fileCode});
    await assert.rejects(bash!.execute({command:'synthetic'},signal), error => {
      assert.equal(((error as Error).cause as {code:string}).code, processCode);
      return true;
    });
  }
});

const nativeModel: ModelConfig = {provider:'synthetic', id:'length', protocol:'openai-completions', endpoint:'https://synthetic.invalid/v1', contextWindow:200000, maxOutputTokens:16};
const protections = {cumulative:'unlimited' as const, maxOutputTokens:16, modelTimeoutMs:2000, toolTimeoutMs:2000, controlTimeoutMs:2000};
function lengthSse(text:string, stop='stop', output=1) {
  return new Response([
    {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]},
    {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:stop}],usage:{prompt_tokens:9,completion_tokens:output,total_tokens:9+output}},
  ].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
async function nativeLengthRuntime(transport:SessionRuntimeOptions['transport'], fallbacks:SessionRuntimeOptions['fallbacks']=[], harness:SessionRuntimeOptions['harness']={}, selectedModel:ModelConfig=nativeModel) {
  const root=await mkdtemp(join(tmpdir(),'r2-length-'));
  return createSessionRuntime({model:selectedModel,transport,fallbacks,budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=>'ready',
    harness:{compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:1},...harness},storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})}});
}
test('S2/F02/R2/V08: persistent Agent preserves length and known usage through one native compact-and-recover',async()=>{
  let calls=0,summaries=0;
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    calls++;if(String(init?.body).includes('context summarization assistant')){summaries++;return lengthSse('SUMMARY');}
    return calls===1 ? lengthSse('PREVIOUS') : calls===2 ? lengthSse('PARTIAL','length',3) : lengthSse('RECOVERED');
  }});
  const runtime=await nativeLengthRuntime(transport),session=await runtime.create();
  const common={sessionId:session.id,taskId:'length-native',tools:[],limits:protections,modelRecovery:{extraAttempts:1 as const}};
  assert.equal((await runtime.run({...common,prompt:'seed'})).status,'succeeded');
  const result=await runtime.run({...common,prompt:'continue'});
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.status==='succeeded'&&result.value,'RECOVERED');
  assert.equal(calls,4);assert.equal(summaries,1);assert.equal(result.usage.modelCalls,4);assert.equal(result.usage.inputTokens,36);assert.equal(result.usage.outputTokens,6);
  assert.ok((await runtime.history(session.id)).some(e=>e.message?.text.includes('PARTIAL')));
});
test('S2/R2-R4/V08-V09: SDK fallback consumed allowance cannot stack native length recovery',async()=>{
  let calls=0,summaries=0;
  const primary=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async()=>{
    calls++;return calls===1 ? lengthSse('PREVIOUS') : new Response('{"error":{"message":"synthetic"}}',{status:503,headers:{'content-type':'application/json'}});
  }});
  const backup={...nativeModel,id:'backup',provider:'synthetic-backup'};
  const secondary=createPiTransport({model:backup,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    calls++;if(String(init?.body).includes('context summarization assistant')){summaries++;return lengthSse('SUMMARY');}
    return lengthSse('PARTIAL','length',3);
  }});
  const runtime=await nativeLengthRuntime(primary,[{model:backup,transport:secondary}]),session=await runtime.create();
  const common={sessionId:session.id,taskId:'shared-extra',tools:[],limits:protections,modelRecovery:{extraAttempts:1 as const}};
  assert.equal((await runtime.run({...common,prompt:'seed'})).status,'succeeded');
  const result=await runtime.run({...common,prompt:'continue'});
  assert.notEqual(result.status,'succeeded');assert.equal(calls,3);assert.equal(summaries,0);
  assert.equal(result.usage.modelCalls,3);assert.equal(result.usage.inputTokens,18);assert.equal(result.usage.outputTokens,20);assert.equal(result.usage.reservedOutputTokens,16);
  assert.ok((await runtime.history(session.id)).some(e=>e.message?.text.includes('PARTIAL')));
});
test('S2/R2/V08: Worker rejects length without paid recovery while retaining known accounting',async()=>{
  let calls=0;
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async()=>{calls++;return lengthSse('{"partial":','length',3);}});
  const result=await createRuntime({model:nativeModel,transport,authorize:async()=>true,audit:{append:async()=>{}}}).runWorker({taskId:'worker-length',prompt:'synthetic',limits:protections,modelRecovery:{extraAttempts:1},validate:value=>value});
  assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_OUTPUT');assert.equal(calls,1);assert.equal(result.usage.inputTokens,9);assert.equal(result.usage.outputTokens,3);
});

test('S2/R2-R4/V08-V09: native recovery consumed allowance cannot stack SDK retry or fallback',async()=>{
  let calls=0,summaries=0,backups=0;
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    calls++;if(String(init?.body).includes('context summarization assistant')){summaries++;return lengthSse('SUMMARY');}
    if(calls===1)return lengthSse('PREVIOUS');if(calls===2)return lengthSse('PARTIAL','length',3);
    return new Response('{"error":{"message":"synthetic-service-failure"}}',{status:503,headers:{'content-type':'application/json'}});
  }});
  const backup={...nativeModel,id:'backup',provider:'synthetic-backup'};
  const secondary=createPiTransport({model:backup,apiKey:'synthetic-placeholder',fetch:async()=>{backups++;return lengthSse('MUST_NOT_RUN');}});
  const runtime=await nativeLengthRuntime(transport,[{model:backup,transport:secondary}]),session=await runtime.create();
  const common={sessionId:session.id,taskId:'native-extra-first',tools:[],limits:protections,modelRecovery:{extraAttempts:1 as const}};
  assert.equal((await runtime.run({...common,prompt:'seed'})).status,'succeeded');
  const result=await runtime.run({...common,prompt:'continue'});
  assert.notEqual(result.status,'succeeded');assert.equal(calls,4);assert.equal(summaries,1);assert.equal(backups,0);
  assert.equal(result.usage.modelCalls,4);assert.equal(result.usage.inputTokens,27);assert.equal(result.usage.outputTokens,21);assert.equal(result.usage.reservedOutputTokens,16);
});
test('S2/R2/V08: explicit zero extra attempts preserves length but admits no summary or recovery',async()=>{
  let calls=0,summaries=0;
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    calls++;if(String(init?.body).includes('context summarization assistant'))summaries++;
    return calls===1?lengthSse('PREVIOUS'):lengthSse('PARTIAL','length',3);
  }});
  const runtime=await nativeLengthRuntime(transport),session=await runtime.create();
  const common={sessionId:session.id,taskId:'zero-extra',tools:[],limits:protections,modelRecovery:{extraAttempts:0 as const}};
  assert.equal((await runtime.run({...common,prompt:'seed'})).status,'succeeded');
  const result=await runtime.run({...common,prompt:'continue'});
  assert.notEqual(result.status,'succeeded');assert.equal(calls,2);assert.equal(summaries,0);
  assert.ok((await runtime.history(session.id)).some(e=>e.message?.text.includes('PARTIAL')));
});

test('S2/F02/R2/V08: sanitized network classification preserves the existing native retry contract',async()=>{
  let calls=0;
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async()=>{
    if(++calls===1)throw new Error('SYNTHETIC_PRIVATE_NETWORK_DETAIL');
    return lengthSse('RECOVERED');
  }});
  const root=await mkdtemp(join(tmpdir(),'r2-native-network-'));
  const events:unknown[]=[];
  const runtime=createSessionRuntime({model:nativeModel,transport,budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async e=>{events.push(e);}},bindOperation:async()=>{},reconcile:async()=>'ready',
    harness:{retry:{enabled:true,maxRetries:1,baseDelayMs:1}},storage:{cwd:root,directory:join(root,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})}});
  const session=await runtime.create();const result=await runtime.run({sessionId:session.id,taskId:'native-network',prompt:'synthetic',tools:[],limits:protections});
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(calls,2);
  assert.equal(result.usage.modelCalls,2);assert.equal(result.usage.reservedOutputTokens,16);
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_PRIVATE_NETWORK_DETAIL'),false);
});

test('S2/R2/V13-V14: explicit cross-process overflow resume rejects before auxiliary physical requests',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {readFile,unlink}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'r2-overflow-resume-'));
  const fixture=new URL('./fixtures/overflow-recovery-process.mjs',import.meta.url);
  const crashed=spawnSync(process.execPath,['--experimental-strip-types',fixture.pathname,root,'crash'],{encoding:'utf8',timeout:10000});
  assert.equal(crashed.status,85,crashed.stdout+crashed.stderr);
  const before=JSON.parse(await readFile(join(root,'ledger.json'),'utf8'));
  assert.equal(before.usage.modelCalls,2);assert.equal(before.usage.outputTokens,4);assert.equal(before.usage.toolCalls,0);
  // The child has exited; two successful settle/audit receipts account for every model request.
  // Synthetic host reconciliation releases only the dead owner, retaining identity and all usage.
  const audit=(await readFile(join(root,'audit.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.equal(audit.filter(e=>e.kind==='model.finished').length,2);
  delete before.owner;await writeFile(join(root,'ledger.json'),JSON.stringify(before));await unlink(join(root,'writer.lock'));
  const resumed=spawnSync(process.execPath,['--experimental-strip-types',fixture.pathname,root,'resume'],{encoding:'utf8',timeout:10000});
  assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);const result=JSON.parse(resumed.stdout.trim());
  assert.equal(result.reason,'STATE_FAILED');
  assert.equal((await readFile(join(root,'physical.jsonl'),'utf8')).split('\n').filter(Boolean).length,2);
  const after=JSON.parse(await readFile(join(root,'ledger.json'),'utf8'));
  assert.equal(after.configuration,before.configuration);assert.equal(after.usage.modelCalls,2);assert.equal(after.usage.outputTokens,4);
});

for(const variant of ['fallback','native-retry'] as const)test('S2/R2-R4/V08: omitted modelRecovery cannot stack '+variant+' after native recovery',async()=>{
  let calls=0,backups=0,summaries=0;
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    calls++;if(String(init?.body).includes('context summarization assistant')){summaries++;return lengthSse('SUMMARY');}
    if(calls===1)return lengthSse('PREVIOUS');if(calls===2)return lengthSse('PARTIAL','length',3);
    if(calls===4)return new Response('{"error":{"message":"synthetic"}}',{status:503,headers:{'content-type':'application/json'}});
    return lengthSse('MUST_NOT_RECOVER_TWICE');
  }});
  const backup={...nativeModel,id:'backup',provider:'synthetic-backup'};
  const secondary=createPiTransport({model:backup,apiKey:'synthetic-placeholder',fetch:async()=>{backups++;return lengthSse('MUST_NOT_FALLBACK');}});
  const runtime=await nativeLengthRuntime(transport,variant==='fallback'?[{model:backup,transport:secondary}]:[],variant==='native-retry'?{retry:{enabled:true,maxRetries:1,baseDelayMs:1}}:{});
  const session=await runtime.create(),common={sessionId:session.id,taskId:'legacy-extra',tools:[],limits:protections};
  assert.equal((await runtime.run({...common,prompt:'seed'})).status,'succeeded');
  const result=await runtime.run({...common,prompt:'continue'});
  assert.notEqual(result.status,'succeeded');assert.equal(calls,4);assert.equal(backups,0);assert.equal(summaries,1);
});
test('S2/R2/V08: existing native retry consumes allowance before any length recovery',async()=>{
  let calls=0,summaries=0;
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    calls++;if(String(init?.body).includes('context summarization assistant')){summaries++;return lengthSse('MUST_NOT_SUMMARIZE');}
    if(calls===1)return lengthSse('PREVIOUS');if(calls===2)return new Response('{"error":{"message":"synthetic"}}',{status:503,headers:{'content-type':'application/json'}});
    return lengthSse('PARTIAL','length',3);
  }});
  const runtime=await nativeLengthRuntime(transport,[],{retry:{enabled:true,maxRetries:1,baseDelayMs:1}}),session=await runtime.create();
  const common={sessionId:session.id,taskId:'native-retry-first',tools:[],limits:protections};
  assert.equal((await runtime.run({...common,prompt:'seed'})).status,'succeeded');
  const result=await runtime.run({...common,prompt:'continue'});
  assert.notEqual(result.status,'succeeded');assert.equal(calls,3);assert.equal(summaries,0);
  assert.equal(result.usage.modelCalls,3);assert.equal(result.usage.outputTokens,20);assert.equal(result.usage.reservedOutputTokens,16);
});
test('S3/R1/V05-V14: legacy checkpoint consumes native read content and preserves old history',async()=>{
  const root=await mkdtemp(join(tmpdir(),'r3-checkpoint-read-'));await writeFile(join(root,'page.txt'),'alpha\nbeta\ngamma');
  const env=await createLocalExecutionEnvironment({root,policyVersion:'synthetic',exclusiveWorkspace:true,maxFileBytes:100000,maxOutputBytes:4096,timeoutMs:1000});
  let calls=0,toolText='';
  const transport=createPiTransport({model:nativeModel,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{
    if(++calls===1)return new Response([
      {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'read-page',type:'function',function:{name:'read',arguments:'{"path":"page.txt","offset":2,"limit":1}'}}]},finish_reason:null}]},
      {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:9,completion_tokens:1,total_tokens:10}},
    ].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    toolText=JSON.parse(String(init?.body)).messages.filter((m:{role:string})=>m.role==='tool').at(-1).content;return lengthSse('READ_COMPLETE');
  }});
  const checkpoints:import('../src/index.ts').ConversationCheckpoint[]=[];
  const runtime=createRuntime({model:nativeModel,transport,authorize:async()=>true,audit:{append:async()=>{}}});
  const result=await runtime.runAgent({taskId:'legacy-content',prompt:'synthetic',tools:createExecutionTools(env,['read']),limits:protections,saveCheckpoint:async saved=>{checkpoints.push(structuredClone(saved));}});
  assert.equal(result.status,'succeeded');assert.equal(calls,2);assert.equal(toolText,'beta\n\n[1 more lines in file. Use offset=3 to continue.]');
  assert.ok(checkpoints.some(checkpoint=>checkpoint.messages.some(message=>message.role==='tool'&&message.text===toolText)));
});

test('S3/R1/V17: native read distinguishes a host file limit from permission or missing file',async()=>{
  const root=await mkdtemp(join(tmpdir(),'r1-read-limit-'));await writeFile(join(root,'large.txt'),'x'.repeat(2000));
  const env=await createLocalExecutionEnvironment({root,policyVersion:'synthetic',exclusiveWorkspace:true,maxFileBytes:1000,maxOutputBytes:4096,timeoutMs:1000});
  const [read]=createExecutionTools(env,['read']);
  await assert.rejects(read!.execute({path:'large.txt'},new AbortController().signal),{reason:'BUDGET_EXHAUSTED',code:'limit_exceeded'});
});

test('S2-R4/R2/V09: a smaller fallback length at its own output cap cannot trigger unclaimed native recovery',async()=>{
 let calls=0,backups=0,summaries=0,effects=0;
 const primaryModel={...nativeModel,maxOutputTokens:64},backupModel={...nativeModel,id:'smaller-output',maxOutputTokens:16};
 const primary=createPiTransport({model:primaryModel,apiKey:'synthetic-placeholder',fetch:async()=>{
  calls++;if(calls===1)return new Response([{id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'once',type:'function',function:{name:'receipt',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:1}}].map(v=>`data: ${JSON.stringify(v)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  return new Response('{}',{status:503,headers:{'content-type':'application/json'}});
 }});
 const secondary=createPiTransport({model:backupModel,apiKey:'synthetic-placeholder',fetch:async(_url,init)=>{backups++;if(String(init?.body).includes('context summarization assistant')){summaries++;return lengthSse('SUMMARY');}return backups===1?lengthSse('truncated','length',16):lengthSse('MUST_NOT_RECOVER');}});
 const runtime=await nativeLengthRuntime(primary,[{model:backupModel,transport:secondary}],{},primaryModel),session=await runtime.create();
 const result=await runtime.run({sessionId:session.id,taskId:'different-output-caps',prompt:'synthetic',limits:{...protections,maxOutputTokens:64},modelRecovery:{extraAttempts:1},tools:[{name:'receipt',description:'synthetic',effect:'write',resourceUnits:1,parameters:{type:'object'},execute:async()=>{effects++;return{receipt:'once'};}}]});
 assert.notEqual(result.status,'succeeded');assert.equal(calls,2);assert.equal(backups,1);assert.equal(summaries,0);assert.equal(effects,1);
});
