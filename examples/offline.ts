import assert from 'node:assert/strict';
import {createRuntime, createMemoryBudgetStore} from '../src/index.ts';
import {createRecorder, createReplay} from '../src/testing.ts';
import type {ModelReply} from '../src/index.ts';

// Entire example is synthetic. These permissive hooks are NOT production policy/storage.
const model = {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions' as const, endpoint: 'https://invalid.invalid', contextWindow: 8192};
const limits = {modelCalls: 3, toolCalls: 1, outputTokens: 100, resourceUnits: 4, wallTimeMs: 1000};
const host = {model, authorize: async () => true, audit: {append: async () => {}}};
const recording = createRecorder(async (): Promise<ModelReply> => ({content: [{kind: 'text', text: '{"answer":42}'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 2}}));
const worker = await createRuntime({...host, transport: recording.transport}).runWorker({taskId: 'worker-example', prompt: 'Synthetic only', limits,
  contextVersions: {fixture: '1'}, validate: value => {assert.deepEqual(value, {answer: 42}); return value;}});
assert.equal(worker.status, 'succeeded');
const replay = createReplay(recording.records());
assert.equal((await createRuntime({...host, transport: replay.transport}).runWorker({taskId: 'worker-replay', prompt: 'Synthetic only', limits, validate: value => value})).status, 'succeeded');
replay.assertConsumed();
let turn = 0;
const agent = await createRuntime({...host, budgets: createMemoryBudgetStore(), transport: async request => {
  if (++turn === 1) return {content: [{kind: 'tool', id: 'call-1', name: 'lookup', arguments: {id: 7}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 2}};
  assert.equal(request.messages.find(message => message.role === 'tool')?.text, '{"amount":42}');
  return {content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 2, outputTokens: 1}};
}}).runAgent({taskId: 'agent-example', prompt: 'Synthetic only', limits, tools: [{name: 'lookup', description: 'Synthetic lookup', effect: 'read', resourceUnits: 1,
  parameters: {type: 'object', properties: {id: {type: 'integer'}}, required: ['id'], additionalProperties: false}, execute: async () => ({amount: 42})}]});
assert.equal(agent.status, 'succeeded');
console.log(JSON.stringify({worker: worker.status, replay: 'consumed', agent: agent.status, turns: turn}));
