import assert from 'node:assert/strict';
import test from 'node:test';
import {AgentHarness} from '@earendil-works/pi-agent-core';
import {createRuntime} from '../src/index.ts';
import type {ModelConfig, ModelReply, Tool} from '../src/index.ts';

const model: ModelConfig = {provider: 'synthetic', id: 'harness', protocol: 'openai-completions',
  endpoint: 'https://example.invalid', contextWindow: 8192};
const limits = {modelCalls: 8, toolCalls: 8, outputTokens: 100, wallTimeMs: 1000};
const answer = (): ModelReply => ({content: [{kind: 'text', text: '42'}], stop: 'complete',
  usage: {inputTokens: 1, outputTokens: 1}});

test('HN01: the public runtime consumes a real native Harness tool result', async t => {
  let attachments = 0, requests = 0, effects = 0;
  const create = AgentHarness.create;
  t.mock.method(AgentHarness, 'create', async (...args: Parameters<typeof create>) => {
    attachments++;
    return create(...args);
  });
  const result = await createRuntime({model, authorize: async () => true, audit: {append: async () => {}},
    transport: async request => {
      if (++requests === 1) return {content: [{kind: 'tool', id: 'lookup-1', name: 'lookup', arguments: {}}],
        stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};
      assert.equal(request.messages.find(m => m.role === 'tool')?.text, '42');
      return answer();
    },
  }).runAgent({taskId: 'native-harness', prompt: 'Synthetic lookup', limits,
    tools: [{name: 'lookup', description: 'Synthetic value', effect: 'read', resourceUnits: 1,
      parameters: {type: 'object', properties: {}}, execute: async () => {effects++; return 42;}}]});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.status === 'succeeded' && result.value, '42');
  assert.equal(attachments, 1);
  assert.equal(requests, 2);
  assert.equal(effects, 1);
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(result.usage.toolCalls, 1);
});

test('HN02: a sequential override affects only batches that actually call that tool', async () => {
  let requests = 0, active = 0;
  const peak = [0, 0, 0];
  const tools: Tool[] = ['a', 'b', 'serial'].map(name => ({name, description: name,
    effect: 'read', resourceUnits: 1, parameters: {type: 'object', properties: {}},
    ...(name === 'serial' ? {executionMode: 'sequential' as const} : {}),
    execute: async () => {
      const batch = requests - 1;
      peak[batch] = Math.max(peak[batch]!, ++active);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--;
      return name;
    }}));
  const result = await createRuntime({model, authorize: async () => true, audit: {append: async () => {}},
    transport: async request => {
      requests++;
      if (requests === 4) {
        assert.equal(request.messages.filter(m => m.role === 'tool').length, 6);
        return answer();
      }
      return {content: (requests === 2 ? ['serial', 'a'] : ['a', 'b']).map(name =>
        ({kind: 'tool', id: `${requests}-${name}`, name, arguments: {}})),
        stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};
    },
  }).runAgent({taskId: 'native-batch-policy', prompt: 'Synthetic batches', limits, tools, toolExecution: 'parallel'});
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(peak, [2, 1, 2]);
  assert.equal(result.usage.toolCalls, 6);
});
