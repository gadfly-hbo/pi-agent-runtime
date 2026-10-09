import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime} from '../src/index.ts';
import type {ModelReply} from '../src/index.ts';

test('R05: a hung transport cannot defeat the independent deadline', async () => {
  let settle!: (value: ModelReply) => void;
  const runtime = createRuntime({model: {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192},
    transport: () => new Promise(resolve => {settle = resolve;}), authorize: async () => true, audit: {append: async () => {}}});
  const request = {taskId: 'deadline', prompt: 'Synthetic', limits: {modelCalls: 3, toolCalls: 0, outputTokens: 10, wallTimeMs: 30}, validate: (value: unknown) => value};
  const running = runtime.runWorker(request);
  const result = await Promise.race([running, new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 150))]);
  settle({content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}});
  assert.notEqual(result, 'hung');
  assert.equal(typeof result === 'object' && result.status !== 'succeeded' && result.reason, 'DEADLINE_EXCEEDED');
});

test('R05: cancellation before admission prevents every model effect', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const runtime = createRuntime({model: {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192},
    transport: async () => {calls++; return {content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}};},
    authorize: async () => true, audit: {append: async () => {}}});
  const result = await runtime.runWorker({taskId: 'cancel-before', prompt: 'Synthetic', signal: controller.signal,
    limits: {modelCalls: 1, toolCalls: 0, outputTokens: 10, wallTimeMs: 1000}, validate: value => value});
  assert.equal(calls, 0);
  assert.equal(result.status, 'cancelled');
});

test('R04: repeated requests for one task cannot reset the model budget', async () => {
  let calls = 0;
  const runtime = createRuntime({model: {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192},
    transport: async () => {calls++; return {content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}};},
    authorize: async () => true, audit: {append: async () => {}}});
  const request = {taskId: 'bounded', prompt: 'Synthetic', limits: {modelCalls: 1, toolCalls: 0, outputTokens: 10, wallTimeMs: 1000}, validate: (value: unknown) => value};
  assert.equal((await runtime.runWorker(request)).status, 'succeeded');
  const second = await runtime.runWorker(request);
  assert.equal(second.status !== 'succeeded' && second.reason, 'BUDGET_EXHAUSTED');
  assert.equal(calls, 1);
});

test('R01: an admitted worker returns a validated result through the public interface', async () => {
  const events: unknown[] = [];
  const runtime = createRuntime({
    model: {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192},
    transport: async () => ({content: [{kind: 'text', text: '{"answer":42}'}], stop: 'complete', usage: {inputTokens: 5, outputTokens: 3}}),
    authorize: async () => true,
    audit: {append: async (event: unknown) => {events.push(event);}},
  });
  const result = await runtime.runWorker({
    taskId: 'task-1', prompt: 'Synthetic fixture only',
    limits: {modelCalls: 2, toolCalls: 0, outputTokens: 100, wallTimeMs: 1000},
    validate: (value: unknown) => {assert.deepEqual(value, {answer: 42}); return value;},
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.value, {answer: 42});
  assert.equal(result.usage.modelCalls, 1);
  assert.ok(events.length > 0);
});

test('R03: refusing a write tool blocks its effect and further model requests', async () => {
  let effects = 0, calls = 0;
  const runtime = createRuntime({
    model: {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192},
    transport: async (): Promise<ModelReply> => ++calls === 1
      ? {content: [{kind: 'tool', id: 'write-1', name: 'save', arguments: {}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}}
      : {content: [{kind: 'text', text: 'done'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}},
    authorize: async action => action.kind !== 'tool', audit: {append: async () => {}},
  });
  const result = await runtime.runAgent({taskId: 'task-denied', prompt: 'Synthetic write attempt',
    limits: {modelCalls: 3, toolCalls: 2, outputTokens: 100, wallTimeMs: 1000},
    tools: [{name: 'save', description: 'Save synthetic value', effect: 'write', resourceUnits: 1,
      parameters: {type: 'object', properties: {}, additionalProperties: false}, execute: async () => {effects++; return null;}}],
  });
  assert.equal(effects, 0);
  assert.equal(calls, 1);
  assert.equal(result.status !== 'succeeded' && result.reason, 'AUTHORITY_REQUIRED');
});

test('R03: refusing publication discards a model result rather than declaring success', async () => {
  const runtime = createRuntime({
    model: {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192},
    transport: async () => ({content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}}),
    authorize: async action => action.kind !== 'publish', audit: {append: async () => {}},
  });
  const result = await runtime.runWorker({taskId: 'task-publish', prompt: 'Synthetic',
    limits: {modelCalls: 1, toolCalls: 0, outputTokens: 10, wallTimeMs: 1000}, validate: value => value});
  assert.equal(result.status !== 'succeeded' && result.reason, 'AUTHORITY_REQUIRED');
  assert.equal(Object.hasOwn(result, 'value'), false);
});

test('R02: the model receives a real business tool result before producing its final answer', async () => {
  const effects: unknown[] = [];
  let turn = 0;
  const runtime = createRuntime({
    model: {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192},
    transport: async (request): Promise<ModelReply> => {
      if (++turn === 1) return {content: [{kind: 'tool', id: 'call-1', name: 'lookup', arguments: {id: 7}}], stop: 'tools', usage: {inputTokens: 5, outputTokens: 3}};
      assert.equal(request.messages.find(m => m.role === 'tool')?.text, '{"amount":42}');
      return {content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 8, outputTokens: 2}};
    },
    authorize: async () => true, audit: {append: async () => {}},
  });
  const result = await runtime.runAgent({taskId: 'task-tools', prompt: 'Read synthetic amount',
    limits: {modelCalls: 3, toolCalls: 2, outputTokens: 100, wallTimeMs: 1000},
    tools: [{name: 'lookup', description: 'Read synthetic amount', effect: 'read', resourceUnits: 1,
      parameters: {type: 'object', properties: {id: {type: 'integer'}}, required: ['id'], additionalProperties: false},
      execute: async (args) => {effects.push(args); return {amount: 42};}}],
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.status === 'succeeded' && result.value, '42');
  assert.deepEqual(effects, [{id: 7}]);
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(result.usage.toolCalls, 1);
});
