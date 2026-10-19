import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemoryBudgetStore,createPiTransport,createSessionRuntime,prepareToolArguments} from '../src/index.ts';
import type {JsonObject,ModelConfig,ModelMessage} from '../src/index.ts';

const model:ModelConfig={provider:'synthetic',id:'schema',protocol:'anthropic-messages',endpoint:'https://offline.invalid',contextWindow:200000,maxOutputTokens:128};
function response(args?:JsonObject){
  const events=[{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',content:[],model:'schema',usage:{input_tokens:1,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:args?{type:'tool_use',id:'schema-call',name:'lookup',input:{}}:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:args?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text:'encoded'}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:args?'tool_use':'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
  return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
test('SF01 full stage intersection reaches the actual Anthropic DTO with required/enum/closed object intact',async()=>{
  const schema=(values:string[]):JsonObject=>({type:'object',properties:{name:{type:'string',enum:values}},required:['name'],additionalProperties:false});
  const upper=schema(['allowed','outside']),stage=schema(['allowed']);let calls=0,effects=0;let encoded:JsonObject|undefined;
  const transport=createPiTransport({model,apiKey:'synthetic-only',fetch:async(_input,init)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.tools[0].strict,undefined);encoded=body.tools[0].input_schema;return response();
  }});
  const cwd=await mkdtemp(join(tmpdir(),'sdk-schema-fidelity-'));
  const runtime=createSessionRuntime({model,transport,budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},
    storage:{cwd,directory:join(cwd,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
    reconcile:async()=> 'ready',bindOperation:async()=>{},toolAdmission:{policyVersion:'schema-v1',correctionLimit:1,view:async()=>({version:'phase',tools:[{name:'lookup',parameters:stage}]})}});
  const session=await runtime.create();const result=await runtime.run({taskId:'schema-fixture',sessionId:session.id,prompt:'Encode synthetic schema',
    tools:[{name:'lookup',description:'Synthetic lookup',parameters:upper,effect:'read',resourceUnits:1,execute:async()=>{effects++;return {};}}],
    limits:{modelCalls:2,toolCalls:1,outputTokens:256,wallTimeMs:5000}});
  assert.equal(result.status,'succeeded');assert.equal(calls,1);assert.equal(effects,0);
  assert.deepEqual(prepareToolArguments(encoded!,{name:'allowed'}),{name:'allowed'});
  for(const invalid of [{},{name:'outside'},{name:'allowed',extra:true}])assert.throws(()=>prepareToolArguments(encoded!,invalid));
});

const fullSchema:JsonObject={type:'object',properties:{name:{type:'string',enum:['allowed'],minLength:2,maxLength:12,pattern:'^[a-z]+$'},
  amount:{type:'integer',minimum:1,maximum:3},tags:{type:'array',items:{type:'string',pattern:'^t$'},minItems:1,maxItems:2,uniqueItems:true},
  selection:{anyOf:[{const:'x'},{type:'null'}]}},required:['name','amount','tags','selection'],additionalProperties:false,minProperties:4,maxProperties:4,
  oneOf:[{properties:{amount:{const:1}}},{properties:{amount:{const:2}}}],not:{properties:{amount:{const:2},selection:{const:null}},required:['amount','selection']}};
for(const protocol of ['anthropic-messages','openai-completions'] as const)test(`SF02 ${protocol} keeps full object/union/array constraints, without a strict opt-in`,async()=>{
  const config={...model,protocol};let calls=0;let encoded:JsonObject|undefined;
  const transport=createPiTransport({model:config,apiKey:'synthetic-only',fetch:async(_input,init)=>{
    calls++;const body=JSON.parse(String(init?.body));encoded=protocol==='anthropic-messages'?body.tools[0].input_schema:body.tools[0].function.parameters;
    if(protocol==='anthropic-messages'){assert.equal(body.tools[0].strict,undefined);return response();}
    return new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'encoded'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const before=structuredClone(fullSchema);
  await transport({model:config,messages:[{role:'system',text:'Synthetic',tools:[{name:'lookup',description:'Synthetic',parameters:fullSchema}]},{role:'user',text:'Encode'}],maxOutputTokens:128,signal:new AbortController().signal});
  assert.equal(calls,1);assert.deepEqual(fullSchema,before);assert.deepEqual(encoded,fullSchema);
  const valid:JsonObject={name:'allowed',amount:1,tags:['t'],selection:null};assert.deepEqual(prepareToolArguments(encoded!,valid),valid);
  assert.deepEqual(prepareToolArguments(encoded!,{...valid,amount:2,selection:'x'}),{...valid,amount:2,selection:'x'});
  const invalid:JsonObject[]=[{...valid,extra:true},{amount:1,tags:['t'],selection:null},{...valid,name:'outside'},
    {...valid,amount:3},{...valid,amount:4},{...valid,amount:2},{...valid,tags:[]},{...valid,tags:['t','t']},{...valid,selection:'outside'}];
  for(const args of invalid){assert.throws(()=>prepareToolArguments(fullSchema,args));assert.throws(()=>prepareToolArguments(encoded!,args));}
});

for(const [label,args,allowed] of [
  ['valid',{name:'allowed'},true],['missing',{},false],['outside',{name:'outside'},false],['extra',{name:'allowed',extra:true},false],
] as [string,JsonObject,boolean][])test(`SF03 actual Harness executor and encoded phase agree for ${label}`,async()=>{
  let effects=0,calls=0;const upper:JsonObject={type:'object',properties:{name:{type:'string',enum:['allowed','outside']}},required:['name'],additionalProperties:false};
  const stage:JsonObject={type:'object',properties:{name:{type:'string',enum:['allowed']}},required:['name'],additionalProperties:false};
  const transport=createPiTransport({model,apiKey:'synthetic-only',fetch:async(_input,init)=>{
    calls++;const body=JSON.parse(String(init?.body)),schema=body.tools[0].input_schema;
    if(allowed)assert.deepEqual(prepareToolArguments(schema,args),args);else assert.throws(()=>prepareToolArguments(schema,args));
    return calls===1?response(args):response();
  }});
  const cwd=await mkdtemp(join(tmpdir(),'sdk-schema-execution-'));
  const runtime=createSessionRuntime({model,transport,budgets:createMemoryBudgetStore(),authorize:async()=>true,audit:{append:async()=>{}},bindOperation:async()=>{},reconcile:async()=> 'ready',
    storage:{cwd,directory:join(cwd,'sessions'),policyVersion:'synthetic',authorize:async()=>true,acquireWriter:async()=>({release:async()=>{}})},
    toolAdmission:{policyVersion:'schema-v1',correctionLimit:0,view:async()=>({version:'stage',tools:[{name:'lookup',parameters:stage}]})}});
  const session=await runtime.create();const result=await runtime.run({taskId:'schema-'+label,sessionId:session.id,prompt:'Synthetic lookup',
    tools:[{name:'lookup',description:'Synthetic',parameters:upper,effect:'read',resourceUnits:1,execute:async value=>{effects++;assert.deepEqual(value,{name:'allowed'});return 42;}}],
    limits:{modelCalls:3,toolCalls:2,outputTokens:512,wallTimeMs:5000}});
  assert.equal(result.status,allowed?'succeeded':'failed');assert.equal(effects,allowed?1:0);assert.equal(calls,allowed?2:1);
  if(!allowed)assert.ok(result.toolAdmissions?.some(f=>f.disposition==='rejected'&&f.terminal));
});

for(const observations of [undefined,'v1'] as const)for(const [label,schema] of [
  ['non-object',{type:'array',items:{type:'string'}}],['non-JSON',{type:'object',properties:{value:{const:NaN}}}],
] as [string,JsonObject][])test(`SF04 ${label} schema rejects before physical IO (${observations??'legacy'})`,async()=>{
  let calls=0;const transport=createPiTransport({model,apiKey:'synthetic-only',...(observations?{modelObservations:observations}:{}),fetch:async()=>{calls++;return response();}});
  await assert.rejects(transport({model,messages:[{role:'system',text:'Synthetic',tools:[{name:'lookup',description:'private-schema-marker',parameters:schema}]},{role:'user',text:'Encode'}],maxOutputTokens:128,signal:new AbortController().signal}),error=>{
    const value=error as {reason:string;outcome?:{physicalStatus:string;usageFinal:boolean;usage:{inputTokens:unknown;outputTokens:unknown}}};
    assert.equal(value.reason,'INVALID_TOOL');assert.equal(JSON.stringify(error).includes('private-schema-marker'),false);
    if(observations){assert.equal(value.outcome?.physicalStatus,'not-sent');assert.equal(value.outcome?.usageFinal,true);
      assert.deepEqual(value.outcome?.usage.inputTokens,{kind:'known',value:0});assert.deepEqual(value.outcome?.usage.outputTokens,{kind:'known',value:0});}
    return true;
  });assert.equal(calls,0);
});

test('SF05 Pi resolves current same-name declarations and preserves multiple tool order',async()=>{
  const schema=(value:string):JsonObject=>({type:'object',properties:{name:{const:value}},required:['name'],additionalProperties:false});let calls=0;
  const messages:ModelMessage[]=[{role:'system',text:'Initial',tools:[{name:'first',description:'First',parameters:schema('first')},{name:'lookup',description:'Old',parameters:schema('old')}]},
    {role:'user',text:'History'},{role:'assistant',text:'Synthetic history'},
    {role:'system',text:'Current',tools:[{name:'lookup',description:'New',parameters:schema('current')},{name:'last',description:'Last',parameters:schema('last')}]},{role:'user',text:'Encode current'}];
  const transport=createPiTransport({model,apiKey:'synthetic-only',fetch:async(_input,init)=>{
    calls++;const tools=JSON.parse(String(init?.body)).tools;assert.deepEqual(tools.map((t:{name:string})=>t.name),['first','lookup','last']);
    assert.deepEqual(tools.map((t:{input_schema:JsonObject})=>t.input_schema),[schema('first'),schema('current'),schema('last')]);return response();
  }});await transport({model,messages,maxOutputTokens:128,signal:new AbortController().signal});assert.equal(calls,1);
});
