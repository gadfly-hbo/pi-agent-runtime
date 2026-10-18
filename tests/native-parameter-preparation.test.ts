import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../src/index.ts';
import {validateToolArguments} from '@earendil-works/pi-ai';
import type {JsonObject} from '../src/index.ts';

const schema:JsonObject={type:'object',properties:{interpretations:{type:'array',minItems:1,maxItems:4,items:{type:'object',properties:{evidence:{type:'array',minItems:1,items:{anyOf:[{type:'object',properties:{message_id:{type:'string'}},required:['message_id'],additionalProperties:false},{type:'object',properties:{source:{type:'object',properties:{source_id:{type:'string',enum:['source-a']},sheet_id:{type:'string',enum:['1','2']},row:{type:'integer',minimum:1}},required:['source_id','sheet_id','row'],additionalProperties:false}},required:['source'],additionalProperties:false}]}}},required:['evidence'],additionalProperties:false}}},required:['interpretations'],additionalProperties:false};
const input=():JsonObject=>({interpretations:[{evidence:[{source:{source_id:'source-a',sheet_id:1,row:'2'}}]}]});
function prepare(parameters:JsonObject,args:JsonObject):JsonObject{
 const entry=Reflect.get(sdk,'prepareToolArguments');
 assert.equal(typeof entry,'function','NP-01: missing shared native preparation entry');
 return entry(parameters,args);
}

test('NP-01: SDK returns native prepared values with the full current nested schema',()=>{
 const args=input(),before=structuredClone(args),contract=structuredClone(schema),result=prepare(schema,args);
 assert.deepEqual(result,{interpretations:[{evidence:[{source:{source_id:'source-a',sheet_id:'1',row:2}}]}]});
 assert.deepEqual(result,validateToolArguments({name:'synthetic',description:'',parameters:schema},{type:'toolCall',id:'synthetic',name:'synthetic',arguments:args}));
 assert.deepEqual(args,before);assert.deepEqual(schema,contract);assert.notEqual(result,args);
});

test('NP-02: invalid references and structure never become admitted arguments',()=>{
 const invalid=[{source_id:'source-other',sheet_id:1,row:2},{source_id:'source-a',sheet_id:3,row:2},{source_id:'source-a',sheet_id:'01',row:2},{source_id:'source-a',sheet_id:1,row:0},{source_id:'source-a',sheet_id:1,row:2,extra:'SYNTHETIC_PRIVATE_VALUE'},{sheet_id:1,row:2}];
 for(const source of invalid){const args={interpretations:[{evidence:[{source}]}]} as JsonObject,before=structuredClone(args);
  assert.throws(()=>prepare(schema,args),error=>{assert.equal(error instanceof sdk.RuntimeFault,true);assert.equal((error as sdk.RuntimeFault).reason,'INVALID_TOOL');assert.equal((error as Error).cause,undefined);assert.doesNotMatch(String(error),/SYNTHETIC_PRIVATE|source-other|source-a/);return true;});assert.deepEqual(args,before);
 }
 for(const args of [{interpretations:[]},{interpretations:Array.from({length:5},()=>({evidence:[{message_id:'synthetic'}]}))},{interpretations:[{evidence:[]}]},{interpretations:[{evidence:[{message_id:'synthetic',source:{source_id:'source-a',sheet_id:1,row:2}}]}]}] as JsonObject[])assert.throws(()=>prepare(schema,args),{reason:'INVALID_TOOL'});
});

test('NP-02: leading-zero IDs are not guessed; exact declared strings stay exact',()=>{
 const contract:JsonObject={type:'object',properties:{sheet_id:{type:'string',enum:['01']}},required:['sheet_id'],additionalProperties:false};
 assert.throws(()=>prepare(contract,{sheet_id:1}),{reason:'INVALID_TOOL'});
 assert.deepEqual(prepare(contract,{sheet_id:'01'}),{sheet_id:'01'});
 const values:JsonObject={type:'object',properties:{amount:{type:'number'},unit:{type:'string'},scale:{type:'string',enum:['100']}},required:['amount','unit','scale'],additionalProperties:false};
 assert.deepEqual(prepare(values,{amount:1.25,unit:'元',scale:'100'}),{amount:1.25,unit:'元',scale:'100'});
});

test('NP-03: unsafe input/contracts fail closed without logging raw content',()=>{
 for(const [parameters,args]of [[{type:'array'},{}],[schema,[]],[schema,{interpretations:undefined}],[schema,{interpretations:Infinity}],[{type:'object',description:'x'.repeat(1_048_577)},{}]] as unknown as [JsonObject,JsonObject][])
  assert.throws(()=>prepare(parameters,args),{reason:'INVALID_TOOL'});
});

test('NP-04: native preparation stays inside authorization and existing usage/audit boundaries',async()=>{
 for(const allowed of [true,false]){
  let calls=0,effects=0;const events:sdk.AuditEvent[]=[],original=input();
  const runtime=sdk.createRuntime({model:{provider:'synthetic',id:'native-parameters',protocol:'openai-completions',endpoint:'https://synthetic.invalid',contextWindow:8192},
   transport:async()=>++calls===1?{content:[{kind:'tool',id:'synthetic-call',name:'meaning',arguments:original}],stop:'tools',usage:{inputTokens:1,outputTokens:1}}:{content:[{kind:'text',text:'done'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}},
   authorize:async action=>action.kind!=='tool'||allowed,audit:{append:async event=>{events.push(event);}}});
  const result=await runtime.runAgent({taskId:'np-04-'+allowed,prompt:'Synthetic only',limits:{modelCalls:3,toolCalls:2,outputTokens:100,wallTimeMs:2000},tools:[{name:'meaning',description:'Synthetic changing host contract',parameters:{type:'object',additionalProperties:true},effect:'write',resourceUnits:1,execute:async args=>{const prepared=prepare(schema,args);assert.deepEqual(prepared,{interpretations:[{evidence:[{source:{source_id:'source-a',sheet_id:'1',row:2}}]}]});effects++;return {saved:true};}}]});
  assert.equal(effects,allowed?1:0);assert.equal(calls,allowed?2:1);assert.equal(result.status,allowed?'succeeded':'blocked');
  if(!allowed)assert.equal(result.status!=='succeeded'&&result.reason,'AUTHORITY_REQUIRED');
  assert.equal(result.usage.modelCalls,calls);assert.equal(events.filter(e=>e.kind==='tool.finished').length,allowed?1:0);assert.deepEqual(original,input());
 }
});
