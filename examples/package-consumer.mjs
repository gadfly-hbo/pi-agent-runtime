import assert from 'node:assert/strict';
import {createRuntime, createMemoryBudgetStore} from 'pi-agent-runtime';
import {createRecorder, createReplay} from 'pi-agent-runtime/testing';
const model = {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192};
const limits = {modelCalls: 3, toolCalls: 1, outputTokens: 100, wallTimeMs: 1000};
const host = {model, budgets: createMemoryBudgetStore(), authorize: async () => true, audit: {append: async () => {}}};
const recorded = createRecorder(async () => ({content: [{kind: 'text', text: '{"answer":42}'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}}));
const worker = await createRuntime({...host, transport: recorded.transport}).runWorker({taskId: 'pack-worker', prompt: 'Synthetic', limits,
  validate: value => {assert.deepEqual(value, {answer: 42}); return value;}});
assert.equal(worker.status, 'succeeded');
const replay = createReplay(recorded.records());
assert.equal((await createRuntime({...host, transport: replay.transport}).runWorker({taskId: 'pack-replay', prompt: 'Synthetic', limits, validate: value => value})).status, 'succeeded');
replay.assertConsumed();
let turns = 0, effects = 0;
const agent = await createRuntime({...host, transport: async request => {
  if (++turns === 1) return {content: [{kind: 'tool', id: 'call', name: 'lookup', arguments: {}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};
  assert.equal(request.messages.at(-1).text, '42');
  return {content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}};
}}).runAgent({taskId: 'pack-agent', prompt: 'Synthetic', limits, tools: [{name: 'lookup', description: 'Synthetic', effect: 'read', resourceUnits: 1,
  parameters: {type: 'object', properties: {}, additionalProperties: false}, execute: async () => {effects++; return 42;}}]});
assert.equal(agent.status, 'succeeded'); assert.equal(turns, 2); assert.equal(effects, 1);
const text=await createRuntime({...host,transport:async()=>({content:[{kind:'text',text:'Natural text'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}})})
  .runText({taskId:'pack-text',prompt:'Synthetic',limits});
assert.equal(text.status,'succeeded');assert.equal(text.value,'Natural text');
let release;const barrier=new Promise(resolve=>{release=resolve;});let started=0,parallelTurns=0;
const parallelRuntime=createRuntime({...host,model:{...model,reasoning:true},transport:async request=>{
  assert.equal(request.thinkingLevel,'low');
  if(++parallelTurns===1)return {content:['a','b'].map(name=>({kind:'tool',id:name,name,arguments:{}})),stop:'tools',usage:{inputTokens:1,outputTokens:1}};
  assert.equal(request.messages.filter(message=>message.role==='tool').length,2);
  return {content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};
}});
let parallel;
try {parallel=await parallelRuntime.runAgent({taskId:'pack-parallel',prompt:'Synthetic',limits:{...limits,toolCalls:2},
  toolExecution:'parallel',thinkingLevel:'low',tools:['a','b'].map(name=>({name,description:'Synthetic',effect:'read',resourceUnits:1,
    parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{if(++started===2)release();await barrier;return name;}}))});}
finally {release();await parallelRuntime.waitForIdle('pack-parallel');}
assert.equal(started,2);assert.equal(parallel.status,'succeeded');
console.log(JSON.stringify({installedExports:true,worker:worker.status,replay:'consumed',agent:agent.status,text:text.status,parallel:parallel.status,thinking:'forwarded'}));
