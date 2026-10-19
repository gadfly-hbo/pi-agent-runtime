import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const execute=promisify(execFile),processFixture=new URL('./fixtures/model-attempt-process.mjs',import.meta.url);
const sdk:typeof import('../src/index.ts')=await import(process.env.PI_TEST_SDK_ENTRY?pathToFileURL(process.env.PI_TEST_SDK_ENTRY).href:new URL('../src/index.ts',import.meta.url).href);
async function child(root:string,mode:string,now?:number){
  const env={PATH:dirname(process.execPath)+':/usr/bin:/bin',TZ:'UTC',LANG:'C.UTF-8',NO_COLOR:'1',
    ...(process.env.PI_TEST_SDK_ENTRY?{PI_TEST_SDK_ENTRY:process.env.PI_TEST_SDK_ENTRY}:{}),...(now===undefined?{}:{PI_TEST_SYNTHETIC_NOW:String(now)})};
  const result=await execute(process.execPath,['--experimental-strip-types',processFixture.pathname,root,mode],{env,timeout:15000,maxBuffer:2_000_000});
  return JSON.parse(result.stdout.trim());
}
async function rootFor(name:string){const root=await mkdtemp(join(process.env.PI_TEST_EVIDENCE_DIR??tmpdir(),'sdk-attempt-'+name+'-'));console.log('Durable synthetic evidence: '+root);return root;}

test('MC01 public persistent native chain: one recovery, normal blocks, reopen/Fork/purpose, then second recovery denied',async()=>{
  const root=await rootFor('chain');
  const first=await child(root,'first');assert.equal(first.result.status,'succeeded',JSON.stringify(first.result));assert.equal(first.physical,2);assert.equal(first.state.work.recovery.state,'spent');
  const configuration=first.state.tasks['synthetic-business-task'].configuration,deadline=first.state.work.deadline;
  const continued=await child(root,'continue');assert.equal(continued.result.status,'succeeded');assert.equal(continued.physical,1);assert.equal(continued.result.usage.modelCalls,3);
  const forked=await child(root,'fork');assert.equal(forked.result.status,'succeeded',JSON.stringify(forked.result));assert.equal(forked.result.usage.modelCalls,4);
  const blocked=await child(root,'second-fault');assert.equal(blocked.result.reason,'AUTHORITY_REQUIRED');assert.equal(blocked.physical,1);assert.equal(blocked.result.usage.modelCalls,5);
  assert.equal(blocked.state.tasks['synthetic-business-task'].configuration,configuration);assert.equal(blocked.state.work.deadline,deadline);
  assert.equal(blocked.state.work.recovery.physicalAttemptId,first.state.work.recovery.physicalAttemptId);
  assert.deepEqual(Object.keys(blocked.state.tasks),['synthetic-business-task']);assert.equal(blocked.facts.availability,'available');
  const lines=(await readFile(join(root,'physical.jsonl'),'utf8')).trim().split('\n');assert.equal(lines.length,5);
});

test('MC02 one original business deadline survives purpose, process reopen and Fork without waiting 300 seconds',async()=>{
  const root=await rootFor('deadline');
  const first=await child(root,'normal',1_000_000);assert.equal(first.result.status,'succeeded');assert.equal(first.state.work.deadline,1_300_000);
  const expired=await child(root,'continue',1_300_001);assert.equal(expired.result.reason,'AUTHORITY_REQUIRED');assert.equal(expired.physical,0);
  const fork=await child(root,'fork',1_300_002);assert.equal(fork.result.reason,'AUTHORITY_REQUIRED');assert.equal(fork.physical,0);
  assert.equal(fork.result.usage.modelCalls,1);assert.equal(fork.state.work.deadline,first.state.work.deadline);
});

test('MC03 terminal not-sent releases only that reservation, duplicate receipts cannot release another recovery',async()=>{
  const root=await rootFor('notsent');
  const rejected=await child(root,'notsent');assert.equal(rejected.result.reason,'INVALID_TOOL');assert.equal(rejected.physical,1);
  assert.equal(rejected.result.usage.modelCalls,2);assert.equal(rejected.result.usage.reservedOutputTokens,0);assert.equal(rejected.state.releases.length,1);assert.equal(rejected.state.work.recovery,null);
  const {createAttemptHost}=await import(new URL('./fixtures/model-attempt-host.mjs',import.meta.url).href);
  const host=await createAttemptHost(root,sdk);
  const event=rejected.state.events.find((e:{kind:string;modelAttemptFact?:{attempt:{kind:string};outcome:{physicalStatus:string}}})=>e.kind==='model.finished'&&e.modelAttemptFact?.attempt.kind==='recovery'&&e.modelAttemptFact.outcome.physicalStatus==='not-sent');
  assert.ok(event);await host.audit.append(event);await host.audit.append(event);assert.equal((await host.read()).releases.length,1);
  // A separately explicit NEW logical command may use the released host credit. The stopped chain is not resumed.
  const later=await child(root,'again-after-release');assert.equal(later.result.status,'succeeded',JSON.stringify(later.result));assert.equal(later.physical,2);assert.equal(later.state.work.recovery.state,'spent');
  assert.notEqual(later.state.work.recovery.physicalAttemptId,rejected.state.releases[0].physicalAttemptId);
  await host.audit.append(event);const after=await host.read();assert.equal(after.releases.length,1);assert.deepEqual(after.work.recovery,later.state.work.recovery);
});

test('MC04 a real hard exit during recovery retains original owner/UNKNOWN/reservation and a new Task cannot bypass work',async()=>{
  const root=await rootFor('crash');
  await assert.rejects(child(root,'crash-recovery'),error=>(error as {code:number}).code===86);
  const before=JSON.parse(await readFile(join(root,'host.json'),'utf8')),physical=await readFile(join(root,'physical.jsonl'),'utf8');
  const original=before.tasks['synthetic-business-task'];assert.equal(original.usage.modelCalls,2);assert.equal(original.usage.reservedOutputTokens,16);assert.ok(original.owner);
  assert.equal(before.work.recovery.state,'reserved');
  const pending=before.attempts[before.work.recovery.physicalAttemptId];assert.equal(pending.phase,'authorized');assert.equal(pending.fact,undefined);
  const blocked=await child(root,'bypass-unknown');assert.equal(blocked.result.reason,'AUTHORITY_REQUIRED');assert.equal(blocked.physical,0);
  assert.deepEqual(blocked.state.tasks['synthetic-business-task'],original);assert.deepEqual(blocked.state.work.recovery,before.work.recovery);
  assert.equal(await readFile(join(root,'physical.jsonl'),'utf8'),physical);assert.equal(blocked.state.attempts[before.work.recovery.physicalAttemptId].phase,'authorized');
});

test('MC05 two real processes compete at public recovery authorization; at most one extra effect, duplicate grants are idempotent',async()=>{
  const root=await rootFor('race');
  const [a,b]=await Promise.all([child(root,'race-a'),child(root,'race-b')]);
  assert.deepEqual([a.result.status,b.result.status].sort(),['blocked','succeeded']);
  assert.equal(a.physical+b.physical,3);
  const state=JSON.parse(await readFile(join(root,'host.json'),'utf8'));
  const recoveries=Object.values(state.attempts).filter((a:unknown)=>(a as {allowed:boolean;ref:{kind:string}}).allowed&&(a as {ref:{kind:string}}).ref.kind==='recovery');
  assert.equal(recoveries.length,1);assert.equal(state.work.recovery.state,'spent');
  assert.equal(state.tasks['synthetic-race-a'].usage.modelCalls+state.tasks['synthetic-race-b'].usage.modelCalls,3);
});

test('MC06 released not-sent later contradicted by sent evidence closes the host gate without erasing history',async()=>{
  const root=await rootFor('conflict'),rejected=await child(root,'notsent');
  const {createAttemptHost}=await import(new URL('./fixtures/model-attempt-host.mjs',import.meta.url).href),host=await createAttemptHost(root,sdk);
  const event=rejected.state.events.find((e:{kind:string;modelAttemptFact?:{attempt:{kind:string};outcome:{physicalStatus:string}}})=>e.kind==='model.finished'&&e.modelAttemptFact?.attempt.kind==='recovery'&&e.modelAttemptFact.outcome.physicalStatus==='not-sent');
  // Deliberate contradictory synthetic receipt, not a claimed SDK/Provider execution.
  const contradictory=structuredClone(event);contradictory.modelAttemptFact.late=true;contradictory.modelAttemptFact.outcome.physicalStatus='response-received';
  await host.audit.append(contradictory);
  const conflict=await host.read();assert.equal(conflict.work.blocked,true);assert.equal(conflict.releases.length,1);
  assert.equal(conflict.attempts[event.modelAttemptFact.attempt.physicalAttemptId].phase,'conflict');
  const blocked=await child(root,'continue');assert.equal(blocked.result.reason,'AUTHORITY_REQUIRED');assert.equal(blocked.physical,0);
});
