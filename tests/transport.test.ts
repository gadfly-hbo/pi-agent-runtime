import assert from 'node:assert/strict';
import test from 'node:test';
import {createPiTransport, createRuntime} from '../src/index.ts';
import type {ModelConfig} from '../src/index.ts';
const model: ModelConfig = {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid/v1', contextWindow: 8192};
const sse = (events: unknown[], anthropic: boolean) => new Response(events.map(value =>
  (anthropic ? `event: ${(value as {type: string}).type}\n` : '') + `data: ${JSON.stringify(value)}\n\n`).join('') + (anthropic ? '' : 'data: [DONE]\n\n'),
  {headers: {'content-type': 'text/event-stream'}});
for (const protocol of ['openai-completions', 'anthropic-messages'] as const) {
  test(`R07: ${protocol} consumes real Pi tool messages across two offline HTTP turns`, async () => {
    let calls = 0, effects = 0; const config = {...model, protocol};
    const transport = createPiTransport({model: config, apiKey: 'synthetic-not-a-secret', fetch: async (_input, init) => {
      calls++; const body = JSON.parse(String(init?.body));
      if (calls === 2) {
        const last = body.messages.at(-1);
        if (protocol === 'openai-completions') {assert.equal(last.role, 'tool'); assert.equal(last.tool_call_id, 'call-1'); assert.equal(last.content, '42');}
        else {assert.equal(last.role, 'user'); assert.equal(last.content[0].type, 'tool_result'); assert.equal(last.content[0].tool_use_id, 'call-1');}
      }
      if (protocol === 'openai-completions') return sse([
        {id: 'fixture', object: 'chat.completion.chunk', choices: [{index: 0, delta: calls === 1 ?
          {role: 'assistant', tool_calls: [{index: 0, id: 'call-1', type: 'function', function: {name: 'lookup', arguments: '{"id":1}'}}]} : {role: 'assistant', content: '42'}, finish_reason: null}]},
        {id: 'fixture', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop'}],
          usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}], false);
      return sse([
        {type: 'message_start', message: {id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1}}},
        {type: 'content_block_start', index: 0, content_block: calls === 1 ? {type: 'tool_use', id: 'call-1', name: 'lookup', input: {}} : {type: 'text', text: ''}},
        {type: 'content_block_delta', index: 0, delta: calls === 1 ? {type: 'input_json_delta', partial_json: '{"id":1}'} : {type: 'text_delta', text: '42'}},
        {type: 'content_block_stop', index: 0},
        {type: 'message_delta', delta: {stop_reason: calls === 1 ? 'tool_use' : 'end_turn', stop_sequence: null}, usage: {output_tokens: 1}},
        {type: 'message_stop'}], true);
    }});
    const result = await createRuntime({model: config, transport, authorize: async () => true, audit: {append: async () => {}}}).runAgent({
      taskId: protocol, prompt: 'Synthetic', limits: {modelCalls: 3, toolCalls: 1, outputTokens: 100, wallTimeMs: 1000},
      tools: [{name: 'lookup', description: 'Synthetic', effect: 'read', resourceUnits: 1,
        parameters: {type: 'object', properties: {id: {type: 'integer'}}, required: ['id'], additionalProperties: false},
        execute: async args => {assert.deepEqual(args, {id: 1}); effects++; return 42;}}]});
    assert.equal(result.status, 'succeeded'); assert.equal(result.status === 'succeeded' && result.value, '42'); assert.equal(calls, 2); assert.equal(effects, 1);
  });
}
test('R07: the shared Pi transport encodes a request and decodes SSE without network access', async () => {
  let calls = 0;
  const transport = createPiTransport({model, apiKey: 'synthetic-not-a-secret', fetch: async (input, init) => {
    calls++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, 'https://invalid.invalid/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'fixture'); assert.equal(body.max_completion_tokens, 10);
    const events = [{id: 'fixture', object: 'chat.completion.chunk', choices: [{index: 0, delta: {role: 'assistant', content: '42'}, finish_reason: null}]},
      {id: 'fixture', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}];
    return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  }});
  const runtime = createRuntime({model, transport, authorize: async () => true, audit: {append: async () => {}}});
  const result = await runtime.runWorker({taskId: 'http-fixture', prompt: 'Synthetic', limits: {modelCalls: 1, toolCalls: 0, outputTokens: 10, wallTimeMs: 1000}, validate: value => value});
  assert.equal(result.status, 'succeeded'); assert.equal(result.status === 'succeeded' && result.value, 42); assert.equal(calls, 1);
});

test('R07: hidden HTTP retries are disabled and errors remain sanitized', async () => {
  let calls = 0;
  const transport = createPiTransport({model, apiKey: 'synthetic-not-a-secret', fetch: async () => {
    calls++; return new Response(JSON.stringify({error: {message: 'synthetic-private-error'}}), {status: 500, headers: {'content-type': 'application/json'}});
  }});
  const result = await createRuntime({model, transport, authorize: async () => true, audit: {append: async () => {}}}).runWorker({taskId: 'no-retry', prompt: 'Synthetic',
    limits: {modelCalls: 1, toolCalls: 0, outputTokens: 10, wallTimeMs: 1000}, validate: value => value});
  assert.equal(calls, 1); assert.equal(result.status !== 'succeeded' && result.reason, 'MODEL_FAILED');
  assert.equal(JSON.stringify(result).includes('synthetic-private-error'), false);
});
test('R07: direct SDK rejects endpoint query before authorization, audit or model effects',async()=>{
  let effects=0;
  const result=await createRuntime({model:{...model,endpoint:model.endpoint+'?api_key=synthetic-placeholder'},
    transport:async()=>{effects++;return {content:[{kind:'text',text:'42'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};},
    authorize:async()=>{effects++;return true;},audit:{append:async()=>{effects++;}}}).runWorker({taskId:'query-rejected',prompt:'Synthetic',
      limits:{modelCalls:1,toolCalls:0,outputTokens:10,wallTimeMs:1000},validate:value=>value});
  assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_REQUEST');assert.equal(effects,0);
});

test('R07 image capability config survives runtime cloning and Pi consumes image input',async()=>{
 const config:ModelConfig={...model,input:['text','image']};let calls=0;
 const transport=createPiTransport({model:config,apiKey:'synthetic',fetch:async(_input,init)=>{
  calls++;const body=JSON.parse(String(init?.body));assert.ok(body.messages.some((m:{content:unknown})=>Array.isArray(m.content)&&m.content.some((c:{type:string})=>c.type==='image_url')));
  return sse([{id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'42'},finish_reason:null}]},
   {id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}],false);
 }});
 const result=await createRuntime({model:config,transport,authorize:async()=>true,audit:{append:async()=>{}}}).runText({taskId:'image',prompt:'inspect',images:[{mimeType:'image/png',data:'iVBORw0KGgo='}],limits:{modelCalls:1,toolCalls:0,outputTokens:10,wallTimeMs:1000}});
 assert.equal(result.status,'succeeded');assert.equal(calls,1);
});
