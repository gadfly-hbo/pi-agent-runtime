import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime, createMemoryBudgetStore} from '../src/index.ts';
import type {ModelReply, RuntimeOptions, Tool} from '../src/index.ts';
const model = {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions' as const, endpoint: 'https://invalid.invalid', contextWindow: 8192};
const limits = {modelCalls: 3, toolCalls: 2, outputTokens: 100, wallTimeMs: 1000};
const final = (): ModelReply => ({content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}});
const setup = (patch: Partial<RuntimeOptions> = {}) => createRuntime({model, transport: async () => final(), authorize: async () => true, audit: {append: async () => {}}, ...patch});
const tool = (execute: Tool['execute']): Tool => ({name: 'lookup', description: 'Synthetic lookup', effect: 'read', resourceUnits: 1,
  parameters: {type: 'object', properties: {id: {type: 'integer'}}, required: ['id'], additionalProperties: false}, execute});

test('R05: a cancelled physical tool retains the task lease and cannot publish late', async () => {
  let settle!: (value: number) => void, begun!: () => void; const started = new Promise<void>(resolve => {begun = resolve;});
  const controller = new AbortController(); const events: string[] = [];
  const runtime = setup({transport: async () => ({content: [{kind: 'tool', id: 'call', name: 'lookup', arguments: {id: 1}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}}),
    audit: {append: async event => {events.push(event.kind);}}});
  const request = {taskId: 'pending-tool', prompt: 'Synthetic', limits, tools: [tool(() => new Promise<number>(resolve => {settle = resolve; begun();}))]};
  const running = runtime.runAgent({...request, signal: controller.signal}); await started; controller.abort();
  const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(Object.hasOwn(result, 'value'), false);
  const competing = await runtime.runAgent(request); assert.equal(competing.status !== 'succeeded' && competing.reason, 'TASK_BUSY');
  settle(42); await runtime.waitForIdle(request.taskId);
  assert.equal(events.includes('tool.finished'), false); assert.equal(events.includes('run.finished'), false);
});

test('R05: unknown model execution retains its full token reservation after cancellation', async () => {
  let settle!: (value: ModelReply) => void, begun!: () => void; const started = new Promise<void>(resolve => {begun = resolve;});
  const controller = new AbortController();
  const runtime = setup({transport: () => new Promise(resolve => {settle = resolve; begun();})});
  const request = {taskId: 'unknown-model', prompt: 'Synthetic', limits, validate: (value: unknown) => value};
  const running = runtime.runWorker({...request, signal: controller.signal}); await started; controller.abort();
  const cancelled = await running; assert.equal(cancelled.usage.outputTokens, limits.outputTokens);
  settle(final()); await runtime.waitForIdle(request.taskId);
  const next = await runtime.runWorker(request); assert.equal(next.status !== 'succeeded' && next.reason, 'BUDGET_EXHAUSTED');
});

test('R06: final audit failure discards a valid answer and observers cannot act as gates', async () => {
  const result = await setup({audit: {append: async event => {if (event.kind === 'run.finished') throw Error('Synthetic');}},
    onEvent: async () => {throw Error('Observer is not a gate');}}).runWorker({taskId: 'terminal-audit', prompt: 'Synthetic', limits, validate: value => value});
  assert.equal(result.status !== 'succeeded' && result.reason, 'AUDIT_FAILED'); assert.equal(Object.hasOwn(result, 'value'), false);
  const good = await setup({onEvent: () => new Promise(() => {})}).runWorker({taskId: 'hung-observer', prompt: 'Synthetic', limits, validate: value => value});
  assert.equal(good.status, 'succeeded');
});

test('R06: runtime audit records no raw prompt, arguments, or result', async () => {
  const events: unknown[] = []; let turn = 0;
  const runtime = setup({audit: {append: async event => {events.push(event);}}, transport: async () => ++turn === 1 ?
    {content: [{kind: 'tool', id: 'secret-call', name: 'lookup', arguments: {id: 456789}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}} : final()});
  const result = await runtime.runAgent({taskId: 'safe-label', prompt: 'SYNTHETIC_PRIVATE_PROMPT', limits, tools: [tool(async () => 'SYNTHETIC_PRIVATE_RESULT')]});
  assert.equal(result.status, 'succeeded');
  const text = JSON.stringify(events);
  for (const raw of ['SYNTHETIC_PRIVATE_PROMPT', '456789', 'SYNTHETIC_PRIVATE_RESULT']) assert.equal(text.includes(raw), false);
});

test('R07: the consumed tool result matches its captured audit boundary despite host mutation', async () => {
  const shared = {amount: 42}; let turn = 0;
  const runtime = setup({audit: {append: async event => {if (event.kind === 'tool.finished') shared.amount = 99;}}, transport: async request => {
    if (++turn === 1) return {content: [{kind: 'tool', id: 'call', name: 'lookup', arguments: {id: 1}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};
    assert.equal(request.messages.find(message => message.role === 'tool')?.text, '{"amount":42}'); return final();
  }});
  const result = await runtime.runAgent({taskId: 'result-snapshot', prompt: 'Synthetic', limits, tools: [tool(async () => shared)]});
  assert.equal(result.status, 'succeeded'); assert.equal(shared.amount, 99);
});

for (const [label, patch] of [['modelCalls', {modelCalls: 1}], ['toolCalls', {toolCalls: 0}], ['resourceUnits', {resourceUnits: 1}], ['outputTokens', {outputTokens: 1}]] as const) {
  test(`R04: ${label} independently bounds the tool loop`, async () => {
    let calls = 0, effects = 0;
    const runtime = setup({transport: async () => {calls++; return {content: [{kind: 'tool', id: `call-${calls}`, name: 'lookup', arguments: {id: 1}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};}});
    const result = await runtime.runAgent({taskId: label, prompt: 'Synthetic', limits: {...limits, ...patch}, tools: [tool(async () => {effects++; return 42;})]});
    assert.equal(result.status !== 'succeeded' && result.reason, 'BUDGET_EXHAUSTED'); assert.equal(calls, 1);
    assert.equal(effects, label === 'modelCalls' || label === 'outputTokens' ? 1 : 0);
  });
}

test('R01: worker rejects invalid JSON and provider truncation', async () => {
  for (const reply of [{...final(), content: [{kind: 'text' as const, text: 'not-json'}]}, {...final(), stop: 'length' as const}]) {
    const result = await setup({transport: async () => reply}).runWorker({taskId: 'invalid-output', prompt: 'Synthetic', limits, validate: value => value});
    assert.equal(result.status !== 'succeeded' && result.reason, 'INVALID_OUTPUT'); assert.equal(Object.hasOwn(result, 'value'), false);
  }
});

test('R03: denied write in a mixed batch prevents subsequent reads too', async () => {
  let effects = 0, calls = 0;
  const runtime = setup({authorize: async action => action.kind !== 'tool', transport: async () => {calls++; return {
    content: [{kind: 'tool', id: 'a', name: 'lookup', arguments: {id: 1}}, {kind: 'tool', id: 'b', name: 'lookup', arguments: {id: 2}}],
    stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};}});
  const result = await runtime.runAgent({taskId: 'mixed-denial', prompt: 'Synthetic', limits, tools: [{...tool(async () => {effects++; return 42;}), effect: 'write'}]});
  assert.equal(result.status !== 'succeeded' && result.reason, 'AUTHORITY_REQUIRED'); assert.equal(effects, 0); assert.equal(calls, 1);
});

test('R02: repeated tool call identity cannot repeat a side effect', async () => {
  let effects = 0;
  const runtime = setup({transport: async () => ({content: [{kind: 'tool', id: 'same-id', name: 'lookup', arguments: {id: 1}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}})});
  const result = await runtime.runAgent({taskId: 'duplicate', prompt: 'Synthetic', limits, tools: [tool(async () => {effects++; return 42;})]});
  assert.equal(result.status !== 'succeeded' && result.reason, 'INVALID_TOOL'); assert.equal(effects, 1);
});

for (const [label, name, args] of [['unknown', 'missing', {id: 1}], ['invalid-args', 'lookup', {id: 'wrong'}]] as const) {
  test(`R02: ${label} stops the entire batch, not merely one tool`, async () => {
    let calls = 0, effects = 0;
    const runtime = setup({transport: async () => ++calls === 1 ? {content: [
      {kind: 'tool', id: 'bad', name, arguments: args},
      {kind: 'tool', id: 'good', name: 'lookup', arguments: {id: 1}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}} : final()});
    const result = await runtime.runAgent({taskId: label, prompt: 'Synthetic', limits, tools: [tool(async () => {effects++; return 42;})]});
    assert.equal(effects, 0); assert.equal(calls, 1);
    assert.equal(result.status !== 'succeeded' && result.reason, 'INVALID_TOOL');
  });
}

test('R07: invalid budgets are rejected before model or tool admission', async () => {
  let calls = 0;
  const runtime = setup({transport: async () => {calls++; return final();}});
  const result = await runtime.runWorker({taskId: 'invalid-limits', prompt: 'Synthetic', limits: {...limits, modelCalls: NaN}, validate: value => value});
  assert.equal(calls, 0); assert.equal(result.status !== 'succeeded' && result.reason, 'INVALID_REQUEST');
});

test('R07: policy cannot mutate the already-approved model request', async () => {
  let received = '';
  const runtime = setup({authorize: async action => {
    if (action.kind === 'model') {try {action.request.messages[0]!.text = 'changed';} catch {}}
    return true;
  }, transport: async request => {received = request.messages.find(message => message.role === 'user')!.text; return final();}});
  const result = await runtime.runWorker({taskId: 'immutable', prompt: 'original', limits, validate: value => value});
  assert.equal(result.status, 'succeeded'); assert.equal(received, 'original');
});

test('R06: audit failure before model admission produces no external effect', async () => {
  let calls = 0;
  const result = await setup({transport: async () => {calls++; return final();}, audit: {append: async () => {throw Error('Synthetic failure');}}})
    .runWorker({taskId: 'audit-failure', prompt: 'Synthetic', limits, validate: value => value});
  assert.equal(calls, 0); assert.equal(result.status !== 'succeeded' && result.reason, 'AUDIT_FAILED');
});

test('R04: shared stores block concurrent runtimes and reject changed limits', async () => {
  const budgets = createMemoryBudgetStore(); let settle!: (reply: ModelReply) => void;
  const runtime = setup({budgets, transport: () => new Promise(resolve => {settle = resolve;})});
  const request = {taskId: 'shared', prompt: 'Synthetic', limits, validate: (value: unknown) => value};
  const running = runtime.runWorker(request);
  await new Promise(resolve => setImmediate(resolve));
  const second = await setup({budgets}).runWorker(request);
  assert.equal(second.status !== 'succeeded' && second.reason, 'TASK_BUSY');
  settle(final()); await running;
  const changed = await setup({budgets}).runWorker({...request, limits: {...limits, modelCalls: 4}});
  assert.equal(changed.status !== 'succeeded' && changed.reason, 'CONFIGURATION_CHANGED');
});

test('R04: host ledger release failure never leaks a successful value or rejects the result promise', async () => {
  const memory = createMemoryBudgetStore();
  const runtime = setup({budgets: {claim: async (...args) => {
    const lease = await memory.claim(...args);
    return {...lease, release: async () => {throw Error('Synthetic ledger outage');}};
  }}});
  const result = await runtime.runWorker({taskId: 'ledger-failure', prompt: 'Synthetic', limits, validate: value => value});
  assert.equal(result.status !== 'succeeded' && result.reason, 'STATE_FAILED'); assert.equal(Object.hasOwn(result, 'value'), false);
});
