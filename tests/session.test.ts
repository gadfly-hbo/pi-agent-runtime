import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, readFile, appendFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionRuntime, createMemoryBudgetStore, RuntimeFault} from '../src/index.ts';
import type {SessionRuntimeOptions, ModelReply} from '../src/index.ts';

const answer = (text: string): ModelReply => ({content: [{kind: 'text', text}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}});
const limits = {modelCalls: 10, toolCalls: 5, outputTokens: 100, wallTimeMs: 10000};
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-jsonl-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  let held = false;
  const options: SessionRuntimeOptions = {
    model: {provider: 'synthetic', id: 'jsonl', protocol: 'openai-completions', endpoint: 'https://example.invalid', contextWindow: 8192},
    budgets: createMemoryBudgetStore(), transport: async () => answer('initial'), authorize: async () => true,
    audit: {append: async () => {}}, bindOperation: async () => {}, reconcile: async () => 'ready',
    storage: {directory, cwd: directory, policyVersion: 'synthetic-only-v1', authorize: async () => true,
      acquireWriter: async () => {if (held) throw new RuntimeFault('TASK_BUSY'); held = true; return {release: async () => {held = false;}};}},
  };
  return {options, directory};
}

test('NS01 disk continuation consumes the prior tool result; fork keeps task consumption', async t => {
  const {options} = await fixture(t);
  let calls = 0, effects = 0;
  const tools = [{name: 'lookup', description: 'Synthetic lookup', effect: 'read' as const, resourceUnits: 1,
    parameters: {type: 'object', properties: {}}, execute: async () => {effects++; return 47;}}];
  options.transport = async request => {
    if (++calls === 1) return {content: [{kind: 'tool', id: 'a', name: 'lookup', arguments: {}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};
    assert.equal(request.messages.find(m => m.role === 'tool')?.text, '47');
    return answer(calls === 2 ? 'saved' : 'consumed 47');
  };
  const first = createSessionRuntime(options), session = await first.create();
  const request = {sessionId: session.id, taskId: 'stable-task', prompt: 'lookup', tools, limits};
  assert.equal((await first.run(request)).status, 'succeeded');
  const restarted = createSessionRuntime(options);
  const result = await restarted.run({...request, prompt: 'use previous result'});
  assert.equal(result.status === 'succeeded' && result.value, 'consumed 47');
  assert.equal(result.usage.modelCalls, 3);
  assert.equal(effects, 1);
  const fork = await restarted.fork(session.id);
  const forkResult = await restarted.run({...request, sessionId: fork.id, prompt: 'continue fork'});
  assert.equal(forkResult.status, 'succeeded');
  assert.equal(forkResult.usage.modelCalls, 4);
  assert.equal(effects, 1);
  assert.equal(fork.parentSessionId, session.id);
  const history = await restarted.history(session.id);
  assert.ok(history.some(e => e.message?.role === 'tool' && e.message.text === '47'));
  assert.equal((await restarted.list()).length, 2);
  await restarted.delete(fork.id);
  assert.equal((await restarted.list()).length, 1);
});

test('NS02 recovery unknown and access denial stop before effects; no fallback storage policy', async t => {
  const {options} = await fixture(t);
  let effects = 0;
  options.transport = async () => {effects++; return answer('not allowed');};
  const session = await createSessionRuntime(options).create();
  options.reconcile = async () => 'unknown';
  const r = await createSessionRuntime(options).run({sessionId: session.id, taskId: 'unknown', prompt: 'next', tools: [], limits});
  assert.equal(r.status !== 'succeeded' && r.reason, 'STATE_FAILED');
  assert.equal(effects, 0);
  options.storage.authorize = async () => false;
  await assert.rejects(createSessionRuntime(options).history(session.id), /AUTHORITY_REQUIRED/);
  assert.throws(() => createSessionRuntime({...options, storage: {...options.storage, directory: 'relative'}}), /INVALID_REQUEST/);
});

test('NS03 host writer lease blocks another runtime while a physical request remains active', async t => {
  const {options} = await fixture(t);
  let started!: () => void, finish!: () => void;
  const start = new Promise<void>(r => {started = r;}), wait = new Promise<void>(r => {finish = r;});
  options.transport = async () => {started(); await wait; return answer('done');};
  const one = createSessionRuntime(options), two = createSessionRuntime(options);
  const session = await one.create();
  const run = one.run({sessionId: session.id, taskId: 'writer', prompt: 'run', tools: [], limits});
  await start;
  await assert.rejects(two.history(session.id), /TASK_BUSY/);
  finish();
  assert.equal((await run).status, 'succeeded');
  assert.ok((await two.history(session.id)).length);
});

test('NS04 native JSONL repairs torn tail, rejects complete corrupt transaction', async t => {
  const {options, directory} = await fixture(t);
  const runtime = createSessionRuntime(options), session = await runtime.create();
  await runtime.run({sessionId: session.id, taskId: 'corruption', prompt: 'hello', tools: [], limits});
  const files = await readdir(directory, {recursive: true});
  const file = join(directory, files.find(f => f.endsWith('.jsonl'))!);
  const original = await readFile(file, 'utf8');
  await appendFile(file, '{"torn":');
  assert.ok((await runtime.history(session.id)).length);
  assert.equal(await readFile(file, 'utf8'), original);
  await appendFile(file, '{"invalid":"complete"}\n');
  await assert.rejects(runtime.history(session.id), /STATE_FAILED/);
});

test('NS05 separate processes consume disk history with persistent host budgets and operation correlation', async t => {
  const {directory} = await fixture(t);
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const execute = promisify(execFile);
  const child = async (mode: string) => JSON.parse((await execute(process.execPath,
    ['--experimental-strip-types', 'tests/fixtures/session-process.mjs', directory, mode])).stdout);
  const first = await child('first'), second = await child('second');
  assert.equal(first.status, 'succeeded');
  assert.equal(second.value, 'consumed 73');
  assert.equal(second.usage.modelCalls, 3);
  assert.equal(second.usage.toolCalls, 1);
  assert.equal(await readFile(join(directory, 'effects.jsonl'), 'utf8'), '73\n');
  const audit = (await readFile(join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  for (const event of audit.filter(e => ['model.admitted', 'tool.admitted'].includes(e.kind))) {
    assert.ok(event.session.operationId);
    assert.equal(event.taskId, 'stable-process-task');
  }
});

test('NS06 hard exit after effect preserves unknown and refuses replay after explicit host lease reconciliation', async t => {
  const {directory} = await fixture(t);
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const {writeFile, unlink} = await import('node:fs/promises');
  const execute = promisify(execFile);
  const args = ['--experimental-strip-types', 'tests/fixtures/session-process.mjs', directory];
  await assert.rejects(execute(process.execPath, [...args, 'crash']), (error: unknown) => (error as {code: number}).code === 77);
  const file = join(directory, 'host-ledger.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(ledger.owner);
  assert.equal(ledger.usage.toolCalls, 1);
  // Test host has observed the child exit. Release ownership only, never consumption or unknown effects.
  delete ledger.owner;
  await writeFile(file, JSON.stringify(ledger));
  await unlink(join(directory, 'writer.lock'));
  const result = JSON.parse((await execute(process.execPath, [...args, 'recover'])).stdout);
  assert.equal(result.reason, 'STATE_FAILED');
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(await readFile(join(directory, 'effects.jsonl'), 'utf8'), '73\n');
  const reconciliations = (await readFile(join(directory, 'reconciliation.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  assert.equal(reconciliations.at(-1).open.length, 1);
  assert.equal((await readFile(join(directory, 'physical-models.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('NS07 native Skill and template contents reach the model; resource changes cannot reset a task', async t => {
  const {options} = await fixture(t);
  options.harness = {skills: [{name: 'analysis', description: 'Synthetic professional analysis', content: 'Use the synthetic threshold 29.', filePath: '/synthetic/analysis/SKILL.md'}],
    templates: [{name: 'decision', content: 'Evaluate $1 against $2.'}]};
  let calls = 0;
  options.transport = async request => {
    const text = request.messages.map(m => m.text).join('\n');
    if (++calls === 1) assert.match(text, /threshold 29/);
    else assert.match(text, /Evaluate A against B/);
    return answer(calls === 1 ? 'threshold 29 applied' : 'A vs B');
  };
  const runtime = createSessionRuntime(options), session = await runtime.create();
  const request = {sessionId: session.id, taskId: 'resources', prompt: '', tools: [], limits};
  assert.equal((await runtime.run({...request, operation: 'skill', resourceName: 'analysis'})).status, 'succeeded');
  assert.equal((await runtime.run({...request, operation: 'template', resourceName: 'decision', templateArguments: ['A', 'B']})).status, 'succeeded');
  const changed = createSessionRuntime({...options, harness: {skills: [{...options.harness.skills![0]!, content: 'different'}]}});
  const result = await changed.run({...request, prompt: 'next'});
  assert.equal(result.status !== 'succeeded' && result.reason, 'CONFIGURATION_CHANGED');
  assert.equal(calls, 2);
});

test('NS08 manual compaction uses the guarded model and its native summary is consumed next', async t => {
  const {options} = await fixture(t);
  options.harness = {compaction: {enabled: false, reserveTokens: 256, keepRecentTokens: 1}};
  let summaries = 0, calls = 0;
  options.transport = async request => {
    calls++;
    const text = request.messages.map(m => m.text).join('\n');
    if (text.includes('context summarization assistant')) {summaries++; return answer('SYNTHETIC-SUMMARY: retain number 61');}
    if (summaries) assert.match(text, /SYNTHETIC-SUMMARY: retain number 61/);
    return answer('61');
  };
  const runtime = createSessionRuntime(options), session = await runtime.create();
  const request = {sessionId: session.id, taskId: 'summary', prompt: 'remember 61', tools: [], limits};
  assert.equal((await runtime.run(request)).status, 'succeeded');
  const compacted = await runtime.run({...request, operation: 'compact', prompt: 'Retain the number'});
  assert.equal(compacted.status, 'succeeded', JSON.stringify(compacted));
  assert.ok(summaries > 0);
  assert.ok((await runtime.history(session.id)).some(e => e.kind === 'compaction' && e.summary?.includes('61')));
  const next = await runtime.run({...request, prompt: 'what number?'});
  assert.equal(next.status, 'succeeded');
  assert.equal(next.usage.modelCalls, calls);
});

test('NS09 automatic native compaction runs during a sustained task and shares the ledger', async t => {
  const {options} = await fixture(t);
  options.model.contextWindow = 512;
  options.harness = {compaction: {enabled: true, reserveTokens: 128, keepRecentTokens: 1}};
  let summaries = 0, consumed = false, calls = 0;
  options.transport = async request => {
    calls++;
    const text = request.messages.map(m => m.text).join('\n');
    if (text.includes('context summarization assistant')) {summaries++; return answer('AUTO-SUMMARY: number 83');}
    if (text.includes('AUTO-SUMMARY: number 83')) consumed = true;
    return {...answer('83'), usage: {inputTokens: summaries ? 10 : 450, outputTokens: 1}};
  };
  const runtime = createSessionRuntime(options), session = await runtime.create();
  const request = {sessionId: session.id, taskId: 'auto', prompt: 'remember 83', tools: [], limits};
  const first = await runtime.run(request);
  assert.equal(first.status, 'succeeded');
  const second = await runtime.run({...request, prompt: 'continue'});
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  assert.ok(summaries > 0);
  assert.equal(consumed, true);
  assert.equal(second.usage.modelCalls, calls);
});

test('NS10 auxiliary requests cannot bypass exhausted budgets, revoked authority or audit failures', async t => {
  for (const failure of ['budget', 'authority', 'audit'] as const) {
    const {options} = await fixture(t);
    options.harness = {compaction: {enabled: false, reserveTokens: 16, keepRecentTokens: 1}};
    let calls = 0, blocked = false;
    options.transport = async request => {calls++; assert.ok(request.maxOutputTokens <= 100); return answer('synthetic');};
    options.authorize = async a => !(blocked && failure === 'authority' && a.kind === 'model');
    options.audit.append = async e => {if (blocked && failure === 'audit' && e.kind === 'model.admitted') throw Error('fixture audit unavailable');};
    const runtime = createSessionRuntime(options), session = await runtime.create();
    const request = {sessionId: session.id, taskId: `guard-${failure}`, prompt: 'hello', tools: [], limits: {...limits, modelCalls: failure === 'budget' ? 1 : 10}};
    assert.equal((await runtime.run(request)).status, 'succeeded');
    blocked = true;
    const result = await runtime.run({...request, operation: 'compact', prompt: ''});
    assert.equal(result.status !== 'succeeded' && result.reason, {budget: 'BUDGET_EXHAUSTED', authority: 'AUTHORITY_REQUIRED', audit: 'AUDIT_FAILED'}[failure]);
    assert.equal(calls, 1);
  }
});

test('NS11 binding acknowledgement fails closed before admission; cancelled IO retains writer until physically idle', async t => {
  const {options} = await fixture(t);
  let calls = 0;
  options.transport = async () => {calls++; return answer('unused');};
  const session = await createSessionRuntime(options).create();
  options.bindOperation = async () => {throw Error('cannot persist binding');};
  const result = await createSessionRuntime(options).run({sessionId: session.id, taskId: 'binding-fail', prompt: 'go', tools: [], limits});
  assert.equal(result.status !== 'succeeded' && result.reason, 'STATE_FAILED');
  assert.equal(calls, 0);
  assert.deepEqual(await createSessionRuntime(options).history(session.id), []);
  options.bindOperation = async () => {};
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>(r => {start = r;}), pending = new Promise<void>(r => {finish = r;});
  options.transport = async () => {start(); await pending; return answer('late');};
  const runtime = createSessionRuntime(options), second = createSessionRuntime(options), controller = new AbortController();
  const run = runtime.run({sessionId: session.id, taskId: 'cancel-writer', prompt: 'go', tools: [], limits, signal: controller.signal});
  await started;
  controller.abort();
  assert.equal((await run).status, 'cancelled');
  await assert.rejects(second.history(session.id), /TASK_BUSY/);
  finish();
  await runtime.waitForIdle('cancel-writer');
  await second.history(session.id);
});

test('NS12 native retries count physical attempts and retain unknown reservations; quota never retries', async t => {
  const {ProviderFailure} = await import('../src/index.ts');
  for (const category of ['unavailable', 'quota'] as const) {
    const {options} = await fixture(t);
    options.model.maxOutputTokens = 10;
    options.harness = {retry: {enabled: true, maxRetries: 2, baseDelayMs: 0}};
    let calls = 0;
    options.transport = async () => {if (++calls === 1) throw new ProviderFailure(category); return answer('recovered');};
    const runtime = createSessionRuntime(options), session = await runtime.create();
    const result = await runtime.run({sessionId: session.id, taskId: `retry-${category}`, prompt: 'go', tools: [], limits});
    if (category === 'quota') {
      assert.equal(result.status, 'failed');
      assert.equal(calls, 1);
    } else {
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(calls, 2);
      assert.equal(result.usage.outputTokens, 11);
    }
    assert.equal(result.usage.modelCalls, calls);
  }
});

test('NS13 session Agent, Worker and text purposes share one immutable task ledger', async t => {
  const {options} = await fixture(t);
  const transport = async () => answer('1');
  options.purposes = ['agent', 'worker', 'text'].map(mode => ({id: mode, mode: mode as 'agent' | 'worker' | 'text', model: options.model, transport}));
  const runtime = createSessionRuntime(options), session = await runtime.create();
  const base = {taskId: 'mixed-purposes', prompt: 'go', limits};
  const agent = await runtime.run({...base, purpose: 'agent', sessionId: session.id, tools: []});
  const worker = await runtime.runWorker({...base, purpose: 'worker', validate: value => value});
  const text = await runtime.runText({...base, purpose: 'text'});
  assert.equal(agent.status, 'succeeded');
  assert.equal(worker.status, 'succeeded');
  assert.equal(text.status, 'succeeded');
  assert.equal(text.usage.modelCalls, 3);
  assert.equal((await runtime.inspect(session.id)).pending, null);
});

test('NS14 native invocation identity reaches the host tool and reliable audit', async t => {
  const {options} = await fixture(t);
  let calls = 0;
  const ids: string[] = [];
  options.transport = async () => ++calls === 1
    ? {content: [{kind: 'tool', id: 'one', name: 'read', arguments: {}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}}
    : answer('done');
  options.audit.append = async e => {if (e.kind === 'tool.admitted' || e.kind === 'tool.finished') ids.push(e.invocation!.invocationId);};
  const runtime = createSessionRuntime(options), session = await runtime.create();
  const result = await runtime.run({sessionId: session.id, taskId: 'invocation', prompt: 'read', limits,
    tools: [{name: 'read', description: 'Read fixture', parameters: {type: 'object', properties: {}}, effect: 'read', resourceUnits: 1,
      execute: async (_args, _signal, invocation) => {assert.equal(invocation?.sessionId, session.id); assert.equal(invocation?.toolCallId, 'one'); ids.push(invocation!.invocationId); return 1;}}]});
  assert.equal(result.status, 'succeeded');
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1);
});

test('NS15 native safe recovery reuses durable invocation memo after host reconciliation, without repeating the effect', async t => {
 const {directory}=await fixture(t);const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile,unlink}=await import('node:fs/promises');const execute=promisify(execFile);
 const args=['--experimental-strip-types','tests/fixtures/session-process.mjs',directory];await assert.rejects(execute(process.execPath,[...args,'safe-crash']),(e:unknown)=>(e as {code:number}).code===78);
 const file=join(directory,'host-ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));delete ledger.owner;await writeFile(file,JSON.stringify(ledger));await unlink(join(directory,'writer.lock'));
 const result=JSON.parse((await execute(process.execPath,[...args,'safe-resume'])).stdout);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.value,'consumed 73');assert.equal(result.usage.toolCalls,2);assert.equal(await readFile(join(directory,'effects.jsonl'),'utf8'),'73\n');
});

test('NS16 SDK exclusive admission rejects overlapping native creates before the native race', async t => {
 const {options}=await fixture(t);const runtime=createSessionRuntime(options);
 const results=await Promise.allSettled([runtime.create(),runtime.create()]);
 assert.equal(results[0]!.status,'fulfilled');assert.equal(results[1]!.status,'rejected');assert.equal((await runtime.list()).length,1);
});

test('NS17 native mixed parallel batch preserves sequential override after process crash and resume',async t=>{
 const {directory}=await fixture(t);const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile,unlink}=await import('node:fs/promises');const execute=promisify(execFile);
 const args=['--experimental-strip-types','tests/fixtures/session-process.mjs',directory];await assert.rejects(execute(process.execPath,[...args,'batch-crash']),(e:unknown)=>(e as {code:number}).code===83);
 const file=join(directory,'host-ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));delete ledger.owner;await writeFile(file,JSON.stringify(ledger));await unlink(join(directory,'writer.lock'));
 const result=JSON.parse((await execute(process.execPath,[...args,'batch-resume'])).stdout);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.value,'batch consumed');assert.equal(result.usage.toolCalls,3);assert.deepEqual(JSON.parse(await readFile(join(directory,'concurrency.json'),'utf8')),{maxActive:1});
});

for(const kind of ['compact','navigate'])test(`NS18 ${kind} result after hard exit following admission returns the native summary`,async t=>{
 const {directory}=await fixture(t);const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile,unlink}=await import('node:fs/promises');const execute=promisify(execFile);
 const args=['--experimental-strip-types','tests/fixtures/session-process.mjs',directory];
 assert.equal(JSON.parse((await execute(process.execPath,[...args,'summary-setup'])).stdout).status,'succeeded');
 await assert.rejects(execute(process.execPath,[...args,`summary-${kind}-crash`]),(e:unknown)=>(e as {code:number}).code===84);
 const file=join(directory,'host-ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));delete ledger.owner;await writeFile(file,JSON.stringify(ledger));await unlink(join(directory,'writer.lock'));
 const result=JSON.parse((await execute(process.execPath,[...args,`summary-${kind}-resume`])).stdout);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.value,kind==='compact'?'RECOVERED-SUMMARY-81':'The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\nRECOVERED-SUMMARY-81');
});
