import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime, createPiTransport, ProviderFailure} from '../src/index.ts';
import type {ModelConfig, ModelReply, Tool} from '../src/index.ts';

const model: ModelConfig = {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions',
  endpoint: 'https://example.invalid/v1', contextWindow: 16384};
const final = (): ModelReply => ({content: [{kind: 'text', text: '42'}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}});
const limits = {modelCalls: 3, toolCalls: 2, outputTokens: 4096, wallTimeMs: 150};
const tool = (name: string, execute: Tool['execute']): Tool => ({name, description: 'Synthetic read',
  effect: 'read', resourceUnits: 1, parameters: {type: 'object', properties: {}, additionalProperties: false}, execute});
const sse = (events: unknown[], anthropic = false) => new Response(events.map(value =>
  (anthropic ? `event: ${(value as {type: string}).type}\n` : '') + `data: ${JSON.stringify(value)}\n\n`).join('') +
  (anthropic ? '' : 'data: [DONE]\n\n'), {headers: {'content-type': 'text/event-stream'}});
const answer = (anthropic = false) => anthropic ? sse([
  {type: 'message_start', message: {id: 'synthetic', type: 'message', role: 'assistant', model: 'fixture', content: [],
    stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1}}},
  {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: '42'}},
  {type: 'content_block_stop', index: 0},
  {type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 1}},
  {type: 'message_stop'},
], true) : sse([
  {id: 'synthetic', object: 'chat.completion.chunk', choices: [{index: 0, delta: {role: 'assistant', content: '42'}, finish_reason: null}]},
  {id: 'synthetic', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}},
]);

test('PT01: parallel tools must both start before either completes and results retain call order', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  let started = 0, calls = 0;
  const runtime = createRuntime({model, authorize: async () => true, audit: {append: async () => {}},
    transport: async request => {
      if (++calls === 1) return {content: ['a', 'b'].map(name => ({kind: 'tool', id: name, name, arguments: {}})),
        stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};
      assert.deepEqual(request.messages.filter(message => message.role === 'tool').map(message => [message.toolId, message.text]),
        [['a', '"a"'], ['b', '"b"']]);
      return final();
    }});
  let result;
  try {result = await runtime.runAgent({taskId: 'parallel-barrier', prompt: 'Synthetic', limits, toolExecution: 'parallel',
    tools: ['a', 'b'].map(name => tool(name, async () => {started++; if (started === 2) release(); await barrier; return name;}))});}
  finally {release(); await runtime.waitForIdle('parallel-barrier');}
  assert.equal(started, 2);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.usage.toolCalls, 2);
});

for (const protocol of ['openai-completions', 'anthropic-messages'] as const) {
  test(`TH01: ${protocol} actually sends configured thinking without enlarging the output cap`, async () => {
    const config = {...model, protocol, reasoning: true, maxOutputTokens: 4096};
    let body: Record<string, any> = {};
    const transport = createPiTransport({model: config, apiKey: 'synthetic-not-a-secret', fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body)); return answer(protocol === 'anthropic-messages');
    }});
    const result = await createRuntime({model: config, transport, authorize: async () => true, audit: {append: async () => {}}})
      .runWorker({taskId: 'thinking-' + protocol, prompt: 'Synthetic', limits: {...limits, wallTimeMs: 1000},
        thinkingLevel: 'low', validate: value => {assert.equal(value, 42); return value;}});
    assert.equal(result.status, 'succeeded');
    if (protocol === 'openai-completions') {assert.equal(body.reasoning_effort, 'low'); assert.equal(body.max_completion_tokens, 4096);}
    else {assert.equal(body.thinking?.type, 'enabled'); assert.equal(body.thinking.budget_tokens, 2048); assert.equal(body.max_tokens, 4096);}
  });
}

test('TH02: signed and redacted reasoning survives the tool turn without entering answer or audit', async () => {
  const config = {...model, protocol: 'anthropic-messages' as const, reasoning: true, maxOutputTokens: 4096};
  let calls = 0, effects = 0, continuation: any;
  const events: unknown[] = [];
  const transport = createPiTransport({model: config, apiKey: 'synthetic-not-a-secret', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (++calls === 2) {continuation = body; return answer(true);}
    return sse([
      {type: 'message_start', message: {id: 'synthetic', type: 'message', role: 'assistant', model: 'fixture', content: [],
        stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 0}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'SYNTHETIC_PRIVATE_THINKING'}},
      {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'synthetic-signature'}},
      {type: 'content_block_stop', index: 0},
      {type: 'content_block_start', index: 1, content_block: {type: 'redacted_thinking', data: 'synthetic-encrypted'}},
      {type: 'content_block_stop', index: 1},
      {type: 'content_block_start', index: 2, content_block: {type: 'tool_use', id: 'lookup-1', name: 'lookup', input: {}}},
      {type: 'content_block_delta', index: 2, delta: {type: 'input_json_delta', partial_json: '{}'}},
      {type: 'content_block_stop', index: 2},
      {type: 'message_delta', delta: {stop_reason: 'tool_use', stop_sequence: null}, usage: {output_tokens: 8}},
      {type: 'message_stop'},
    ], true);
  }});
  const result = await createRuntime({model: config, transport, authorize: async () => true,
    audit: {append: async event => {events.push(event);}}}).runAgent({taskId: 'signed-thinking', prompt: 'Synthetic',
      thinkingLevel: 'low', limits: {...limits, wallTimeMs: 1000},
      tools: [tool('lookup', async () => {effects++; return 42;})]});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.status === 'succeeded' && result.value, '42');
  assert.equal(effects, 1);
  assert.deepEqual(continuation.messages.find((message: any) => message.role === 'assistant').content.slice(0, 2), [
    {type: 'thinking', thinking: 'SYNTHETIC_PRIVATE_THINKING', signature: 'synthetic-signature'},
    {type: 'redacted_thinking', data: 'synthetic-encrypted'},
  ]);
  assert.equal(result.usage.outputTokens, 9);
  for (const privateValue of ['SYNTHETIC_PRIVATE_THINKING', 'synthetic-signature', 'synthetic-encrypted']) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.equal(JSON.stringify(events).includes(privateValue), false);
  }
});

test('TX01: a no-tool text task accepts natural language and still applies host validation', async () => {
  let effects = 0;
  const runtime = createRuntime({model, transport: async () => {effects++; return {...final(), content: [{kind: 'text', text: '自然语言答案'}]};},
    authorize: async () => true, audit: {append: async () => {}}});
  const result = await runtime.runText({taskId: 'natural-text', prompt: 'Synthetic', limits,
    validate: text => {assert.equal(text, '自然语言答案'); return text;}});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.status === 'succeeded' && result.value, '自然语言答案');
  const rejected = await runtime.runText({taskId: 'text-validator', prompt: 'Synthetic', limits,
    validate: () => {throw Error('Synthetic invalid text');}});
  assert.equal(rejected.status !== 'succeeded' && rejected.reason, 'INVALID_OUTPUT');
  assert.equal(effects, 2);
});

for (const override of [false, true]) {
  test(`PT01: ${override ? 'a sequential tool overrides parallel batch' : 'omitted mode keeps serial execution'}`, async () => {
    let active = 0, peak = 0, calls = 0;
    const runtime = createRuntime({model, authorize: async () => true, audit: {append: async () => {}},
      transport: async () => ++calls === 1 ? {content: ['a','b'].map(name => ({kind:'tool',id:name,name,arguments:{}})),
        stop:'tools',usage:{inputTokens:1,outputTokens:1}} : final()});
    const tools = ['a','b'].map(name => tool(name, async () => {
      peak = Math.max(peak, ++active); await new Promise<void>(resolve => setImmediate(resolve)); active--; return name;
    }));
    if (override) tools[0]!.executionMode = 'sequential';
    const result = await runtime.runAgent({taskId:'serial-'+override,prompt:'Synthetic',limits:{...limits,wallTimeMs:1000},tools,
      ...(override ? {toolExecution:'parallel' as const} : {})});
    assert.equal(result.status,'succeeded'); assert.equal(peak,1);
  });
}

for (const scenario of ['authorization','budget','invalid-batch'] as const) {
  test(`PT02: parallel ${scenario} cannot bypass admission or publish a result`, async () => {
    let effects = 0, deniedEffects = 0, calls = 0, publications = 0;
    const runtime = createRuntime({model,
      authorize: async action => {if(action.kind==='publish')publications++; return !(scenario==='authorization'&&action.kind==='tool'&&action.name==='b');},
      audit:{append:async()=>{}}, transport:async()=>{calls++;return {content:['a',scenario==='invalid-batch'?'unknown':'b'].map(name=>
        ({kind:'tool',id:name,name,arguments:{}})),stop:'tools',usage:{inputTokens:1,outputTokens:1}};}});
    const result = await runtime.runAgent({taskId:'guard-'+scenario,prompt:'Synthetic',toolExecution:'parallel',
      limits:{...limits,toolCalls:scenario==='budget'?1:2,wallTimeMs:1000},
      tools:[tool('a',async()=>{effects++;return null;}),{...tool('b',async()=>{deniedEffects++;effects++;return null;}),effect:'write'}]});
    assert.equal(result.status!=='succeeded'&&result.reason,
      scenario==='authorization'?'AUTHORITY_REQUIRED':scenario==='budget'?'BUDGET_EXHAUSTED':'INVALID_TOOL');
    assert.equal(calls,1);assert.equal(publications,0);
    if(scenario==='authorization')assert.equal(deniedEffects,0);
    if(scenario==='invalid-batch')assert.equal(effects,0);
    if(scenario==='budget')assert.ok(effects<=1);
  });
}

test('PT02: parallel tools keep host audit writes serial and ordered', async () => {
  let calls=0,active=0,peak=0;const sequences:number[]=[];
  const runtime=createRuntime({model,authorize:async()=>true,
    audit:{append:async event=>{peak=Math.max(peak,++active);await new Promise<void>(resolve=>setImmediate(resolve));sequences.push(event.sequence);active--;}},
    transport:async()=>++calls===1?{content:['a','b'].map(name=>({kind:'tool',id:name,name,arguments:{}})),
      stop:'tools',usage:{inputTokens:1,outputTokens:1}}:final()});
  const result=await runtime.runAgent({taskId:'parallel-audit',prompt:'Synthetic',toolExecution:'parallel',
    limits:{...limits,wallTimeMs:1000},tools:['a','b'].map(name=>tool(name,async()=>null))});
  assert.equal(result.status,'succeeded');assert.equal(peak,1);
  assert.deepEqual(sequences,sequences.map((_,index)=>index+1));
});

test('PT02: cancellation retains the task lease until all already-started parallel effects settle', async () => {
  let release!:()=>void,started!:()=>void, count=0;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const bothStarted=new Promise<void>(resolve=>{started=resolve;});
  const controller=new AbortController();
  const runtime=createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},
    transport:async()=>({content:['a','b'].map(name=>({kind:'tool',id:name,name,arguments:{}})),stop:'tools',usage:{inputTokens:1,outputTokens:1}})});
  const request={taskId:'parallel-cancel',prompt:'Synthetic',toolExecution:'parallel' as const,limits:{...limits,wallTimeMs:1000},
    tools:['a','b'].map(name=>tool(name,async()=>{if(++count===2)started();await barrier;return null;}))};
  const running=runtime.runAgent({...request,signal:controller.signal});
  try {
    await Promise.race([bothStarted,running.then(()=>{throw Error('Parallel tools did not both start');})]);
    controller.abort();assert.equal((await running).status,'cancelled');
    const competing=await runtime.runAgent(request);
    assert.equal(competing.status!=='succeeded'&&competing.reason,'TASK_BUSY');assert.equal(count,2);
  } finally {release();await runtime.waitForIdle(request.taskId);}
});

for (const scenario of ['invalid-level','missing-capability','unsupported-backup','insufficient-anthropic-cap'] as const) {
  test(`TH03: ${scenario} is rejected before authorization, audit or model effects`, async () => {
    let touched=0;
    const config={...model,reasoning:scenario!=='missing-capability',maxOutputTokens:4096,
      ...(scenario==='insufficient-anthropic-cap'?{protocol:'anthropic-messages' as const,maxOutputTokens:1024}:{})};
    const transport=async()=>{touched++;return final();};
    const runtime=createRuntime({model:config,transport,authorize:async()=>{touched++;return true;},audit:{append:async()=>{touched++;}},
      ...(scenario==='unsupported-backup'?{fallbacks:[{model:{...model,id:'backup',maxOutputTokens:4096},transport}]}:{})});
    const result=await runtime.runText({taskId:scenario,prompt:'Synthetic',limits,
      thinkingLevel:scenario==='invalid-level'?'invalid' as 'low':'low'});
    assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_REQUEST');assert.equal(touched,0);
  });
}

for (const option of ['thinkingLevel','toolExecution'] as const) {
  test(`TH03: changing ${option} cannot reset the same task identity`, async () => {
    let effects=0;
    const runtime=createRuntime({model:{...model,reasoning:true},transport:async()=>{effects++;return final();},
      authorize:async()=>true,audit:{append:async()=>{}}});
    const request={taskId:'identity-'+option,prompt:'Synthetic',limits};
    assert.equal((await runtime.runText(request)).status,'succeeded');
    const changed=await runtime.runText({...request,...(option==='thinkingLevel'?{thinkingLevel:'low' as const}:{toolExecution:'parallel' as const})});
    assert.equal(changed.status!=='succeeded'&&changed.reason,'CONFIGURATION_CHANGED');assert.equal(effects,1);
  });
}

test('TX01: text needs no validator, rejects tool calls, and never exposes reasoning-only output', async () => {
  for(const scenario of ['natural','tool','reasoning'] as const) {
    const runtime=createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>({...final(),
      content:scenario==='natural'?[{kind:'text',text:'自然语言'}]:scenario==='tool'?[{kind:'tool',id:'x',name:'unknown',arguments:{}}]:[{kind:'reasoning',text:'internal'}],
      stop:scenario==='tool'?'tools':'complete'})});
    const result=await runtime.runText({taskId:'text-'+scenario,prompt:'Synthetic',limits});
    if(scenario==='natural')assert.equal(result.status==='succeeded'&&result.value,'自然语言');
    else assert.equal(result.status!=='succeeded'&&result.reason,scenario==='tool'?'INVALID_TOOL':'INVALID_OUTPUT');
  }
});

test('TH02: fallback transforms reasoning and tool history using actual source identity without repeating tools', async () => {
  const primary={...model,provider:'source',protocol:'anthropic-messages' as const,reasoning:true,maxOutputTokens:4096};
  const backup={...model,provider:'backup',id:'backup-model',reasoning:true,maxOutputTokens:4096};
  let primaryCalls=0,effects=0,body:any,backupAuthorized=false;
  const transport=createPiTransport({model:backup,apiKey:'synthetic-not-a-secret',fetch:async(_url,init)=>{
    assert.equal(backupAuthorized,true);body=JSON.parse(String(init?.body));return answer();}});
  const result=await createRuntime({model:primary,transport:async()=>{
    if(++primaryCalls===2)throw new ProviderFailure('rate-limit');
    return {content:[{kind:'reasoning',text:'SYNTHETIC_CONTINUATION',signature:'source-signature'},
      {kind:'reasoning',text:'',signature:'source-encrypted',redacted:true},
      {kind:'tool',id:'lookup|source',name:'lookup',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:4}};
  },fallbacks:[{model:backup,transport}],audit:{append:async()=>{}},authorize:async action=>{
    if(action.kind==='model'&&action.request.model.provider==='backup') {
      assert.equal(action.request.messages.find(message=>message.role==='assistant')?.origin?.provider,'source');
      assert.equal(action.request.messages.find(message=>message.role==='assistant')?.blocks?.[0]?.kind,'reasoning');
      backupAuthorized=true;
    }return true;
  }}).runAgent({taskId:'thinking-fallback',prompt:'Synthetic',thinkingLevel:'low',
    limits:{...limits,outputTokens:16384,wallTimeMs:1000},tools:[tool('lookup',async()=>{effects++;return 42;})]});
  assert.equal(result.status,'succeeded');assert.equal(effects,1);assert.equal(primaryCalls,2);
  const assistant=body.messages.find((message:any)=>message.role==='assistant');
  const returned=body.messages.find((message:any)=>message.role==='tool');
  assert.ok(JSON.stringify(assistant.content).includes('SYNTHETIC_CONTINUATION'));
  assert.equal(assistant.tool_calls.length,1);assert.equal(returned.tool_call_id,assistant.tool_calls[0].id);
  assert.equal(returned.content,'42');
  assert.equal(JSON.stringify(body).includes('source-signature'),false);
  assert.equal(JSON.stringify(body).includes('source-encrypted'),false);
});

test('TH03: depleted thinking allowance stops before a second physical request', async()=>{
  let calls=0;
  const result=await createRuntime({model:{...model,protocol:'anthropic-messages',reasoning:true},authorize:async()=>true,
    audit:{append:async()=>{}},transport:async()=>{calls++;return {content:[{kind:'tool',id:'t',name:'lookup',arguments:{}}],
      stop:'tools',usage:{inputTokens:1,outputTokens:10}};}}).runAgent({taskId:'thinking-depleted',prompt:'Synthetic',thinkingLevel:'low',
      limits:{...limits,outputTokens:2050,wallTimeMs:1000},tools:[tool('lookup',async()=>42)]});
  assert.equal(result.status!=='succeeded'&&result.reason,'BUDGET_EXHAUSTED');assert.equal(calls,1);
});

test('PT02: parallel audit failure blocks every tool effect in the batch',async()=>{
  let effects=0;
  const result=await createRuntime({model,authorize:async()=>true,audit:{append:async event=>{if(event.kind==='tool.admitted')throw Error('Synthetic audit failure');}},
    transport:async()=>({content:['a','b'].map(name=>({kind:'tool',id:name,name,arguments:{}})),stop:'tools',usage:{inputTokens:1,outputTokens:1}})})
    .runAgent({taskId:'parallel-audit-failure',prompt:'Synthetic',toolExecution:'parallel',limits:{...limits,wallTimeMs:1000},
      tools:['a','b'].map(name=>tool(name,async()=>{effects++;return null;}))});
  assert.equal(result.status!=='succeeded'&&result.reason,'AUDIT_FAILED');assert.equal(effects,0);
});

test('TH02: malformed redacted reasoning is rejected before its proposed tool executes',async()=>{
  let effects=0;
  const result=await createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},transport:async()=>({...final(),stop:'tools',
    content:[{kind:'reasoning',text:'',redacted:true},{kind:'tool',id:'t',name:'lookup',arguments:{}}]})})
    .runAgent({taskId:'malformed-thinking',prompt:'Synthetic',limits,tools:[tool('lookup',async()=>{effects++;return null;})]});
  assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_OUTPUT');assert.equal(effects,0);
});
