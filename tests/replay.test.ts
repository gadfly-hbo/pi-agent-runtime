import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime} from '../src/index.ts';
import {createRecorder, createReplay} from '../src/testing.ts';
const model = {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions' as const, endpoint: 'https://invalid.invalid', contextWindow: 8192};
test('R08: synthetic recording replays exactly, and changed requests are refused', async () => {
  let physical = 0;
  const recording = createRecorder(async () => {physical++; return {content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}};});
  const host = {model, authorize: async () => true, audit: {append: async () => {}}};
  const request = {taskId: 'record', prompt: 'Synthetic', limits: {modelCalls: 1, toolCalls: 0, outputTokens: 10, wallTimeMs: 1000}, validate: (value: unknown) => value};
  assert.equal((await createRuntime({...host, transport: recording.transport}).runWorker(request)).status, 'succeeded');
  const replay = createReplay(recording.records());
  const result = await createRuntime({...host, transport: replay.transport}).runWorker(request);
  assert.equal(result.status, 'succeeded'); replay.assertConsumed(); assert.equal(physical, 1);
  const mismatch = createReplay(recording.records());
  const rejected = await createRuntime({...host, transport: mismatch.transport}).runWorker({...request, prompt: 'changed'});
  assert.equal(rejected.status !== 'succeeded' && rejected.reason, 'MODEL_FAILED');
  assert.throws(() => mismatch.assertConsumed());
});
