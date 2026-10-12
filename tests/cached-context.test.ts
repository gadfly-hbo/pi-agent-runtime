import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPiTransport, createSessionRuntime, createRuntime, createMemoryBudgetStore} from '../src/index.ts';
import type {ModelConfig, SessionRuntimeOptions} from '../src/index.ts';

const model: ModelConfig = {provider:'synthetic', id:'cache', protocol:'anthropic-messages',
  endpoint:'https://example.invalid', contextWindow:8192};
const signal = new AbortController().signal;
function anthropic(text:string, usage:Record<string,number>) {
  const events = [
    {type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',model:'cache',content:[],stop_reason:null,stop_sequence:null,usage}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage},
    {type:'message_stop'},
  ];
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    {headers:{'content-type':'text/event-stream'}});
}
for (const [read,write] of [[297849,0],[100,30],[0,120]]) {
  test(`UC100-1: native Anthropic cache read ${read}/write ${write} counts once in total input`,async()=>{
    const transport = createPiTransport({model,apiKey:'synthetic',fetch:async()=>anthropic('42',
      {input_tokens:26399,output_tokens:1,cache_read_input_tokens:read!,cache_creation_input_tokens:write!})});
    const reply = await transport({model,messages:[{role:'user',text:'synthetic'}],maxOutputTokens:4096,signal});
    assert.equal(reply.usage.inputTokens,26399+read!+write!);
    assert.equal(reply.usage.cacheReadTokens,read);
    assert.equal(reply.usage.cacheWriteTokens,write);
    assert.equal(reply.usage.outputTokens,1);
  });
}
test('UC100-1: OpenAI prompt total already includes cache, never double counts it',async()=>{
  const config = {...model,protocol:'openai-completions' as const};
  const transport = createPiTransport({model:config,apiKey:'synthetic',fetch:async()=>new Response([
    {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'42'},finish_reason:null}]},
    {id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],
      usage:{prompt_tokens:500,completion_tokens:3,total_tokens:503,prompt_tokens_details:{cached_tokens:450}}},
  ].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
  const reply = await transport({model:config,messages:[{role:'user',text:'synthetic'}],maxOutputTokens:4096,signal});
  assert.equal(reply.usage.inputTokens,500);
  assert.equal(reply.usage.cacheReadTokens,450);
  assert.equal(reply.usage.outputTokens,3);
});
test('UC100-3: partial/missing usage keeps conservative output reservation and only reported input',async()=>{
  for (const usage of [{}, {cache_read_input_tokens:70}, {input_tokens:20,output_tokens:0}]) {
    const transport = createPiTransport({model,apiKey:'synthetic',fetch:async()=>anthropic('42',usage)});
    const reply = await transport({model,messages:[{role:'user',text:'synthetic'}],maxOutputTokens:4096,signal});
    assert.equal(reply.usage.inputTokens,usage.cache_read_input_tokens??usage.input_tokens??0);
    assert.equal(reply.usage.outputTokens,4096);
  }
});
test('UC100-4: invalid cache classification is refused before tool effects or refund',async()=>{
  for (const cacheReadTokens of [-1,1.5,21,Number.MAX_SAFE_INTEGER+1]) {
    let effects=0;
    const result = await createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},
      transport:async()=>({content:[{kind:'tool',id:'t',name:'lookup',arguments:{}}],stop:'tools',
        usage:{inputTokens:20,outputTokens:1,cacheReadTokens}})}).runAgent({taskId:'bad-'+cacheReadTokens,prompt:'synthetic',
      limits:{modelCalls:1,toolCalls:1,outputTokens:10,wallTimeMs:1000},tools:[{name:'lookup',description:'synthetic',effect:'read',
        resourceUnits:1,parameters:{type:'object'},execute:async()=>{effects++;return 42;}}]});
    assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_OUTPUT');
    assert.equal(effects,0);assert.equal(result.usage.outputTokens,10);
  }
});
test('UC100-4: malformed optional categories and combined overflow are refused',async()=>{
  for (const extra of [{cacheReadTokens:null},{cacheWriteTokens:'1'},{cacheReadTokens:12,cacheWriteTokens:9}]) {
    const result=await createRuntime({model,authorize:async()=>true,audit:{append:async()=>{}},
      transport:async()=>JSON.parse(JSON.stringify({content:[{kind:'text',text:'42'}],stop:'complete',
        usage:{inputTokens:20,outputTokens:1,...extra}}))}).runText({taskId:'malformed-'+JSON.stringify(extra),prompt:'synthetic',
          limits:{modelCalls:1,toolCalls:0,outputTokens:10,wallTimeMs:1000}});
    assert.equal(result.status!=='succeeded'&&result.reason,'INVALID_OUTPUT');assert.equal(result.usage.outputTokens,10);
  }
});
test('UC100-2/5: cached HTTP context triggers native automatic compaction and next request consumes summary on the same ledger',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pi-cache-context-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const config={...model,contextWindow:512};let held=false,calls=0,summaries=0,consumed=false;
  const transport=createPiTransport({model:config,apiKey:'synthetic',fetch:async(_url,init)=>{
    calls++;const text=String(init?.body);
    const summary=text.includes('context summarization assistant');
    if(summary)summaries++;else if(text.includes('CACHE-SUMMARY: retain 83'))consumed=true;
    return anthropic(summary?'CACHE-SUMMARY: retain 83':'83',
      {input_tokens:10,output_tokens:1,cache_read_input_tokens:summaries?0:440,cache_creation_input_tokens:0});
  }});
  const options:SessionRuntimeOptions={model:config,transport,budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},
    bindOperation:async()=>{},reconcile:async()=> 'ready',harness:{compaction:{enabled:true,reserveTokens:128,keepRecentTokens:1}},
    storage:{directory,cwd:directory,policyVersion:'synthetic-only',authorize:async()=>true,
      acquireWriter:async()=>{assert.equal(held,false);held=true;return{release:async()=>{held=false;}};}}};
  const runtime=createSessionRuntime(options),session=await runtime.create();
  const request={sessionId:session.id,taskId:'cache-context',prompt:'remember83',tools:[],
    limits:{cumulative:'unlimited' as const,maxOutputTokens:10,modelTimeoutMs:1000,toolTimeoutMs:1000,controlTimeoutMs:1000}};
  const first=await runtime.run(request);assert.equal(first.status,'succeeded');
  const second=await createSessionRuntime(options).run({...request,prompt:'continue'});
  assert.equal(second.status,'succeeded',JSON.stringify(second));assert.ok(summaries>0);assert.equal(consumed,true);
  assert.equal(second.usage.modelCalls,calls);assert.equal(second.usage.inputTokens,450+(calls-1)*10);
  const history=await runtime.history(session.id);
  assert.ok(history.some(e=>e.kind==='compaction'&&e.summary?.includes('CACHE-SUMMARY')));
});
