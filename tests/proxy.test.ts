import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRuntime,createProxyTransport} from '../src/index.ts';
import type {ModelConfig} from '../src/index.ts';
test('PX01 native proxy worker consumes actual SSE and rejects redirects',{skip:process.env.PI_RUN_LOCAL_PROXY_TESTS!=='1'},async t=>{
 let calls=0,redirect=false,targetCalls=0;
 const server=createServer(async(req,res)=>{
   if(req.url==='/redirect-target'){targetCalls++;res.end('unexpected');return;}
   calls++;let body='';for await(const chunk of req)body+=chunk;
   assert.equal(req.headers.authorization,'Bearer synthetic-token');assert.equal(JSON.parse(body).context.messages.at(-1).content,'proxy fixture');
   if(redirect){res.writeHead(307,{location:'/redirect-target'});res.end();return;}
   res.writeHead(200,{'content-type':'text/event-stream'});
   const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
   for(const event of [{type:'start'},{type:'text_start',contentIndex:0},{type:'text_delta',contentIndex:0,delta:'native proxy reply'},{type:'text_end',contentIndex:0},{type:'done',reason:'stop',usage}])res.write(`data: ${JSON.stringify(event)}\n\n`);res.end();
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const model:ModelConfig={provider:'synthetic',id:'proxy',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:8192,proxyEndpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}`};
 const transport=createProxyTransport({model,authToken:'synthetic-token'});
 const runtime=createRuntime({model,transport,authorize:async a=>a.kind!=='model'||a.request.model.proxyEndpoint===model.proxyEndpoint,audit:{append:async()=>{}}});
 const request={taskId:'proxy',prompt:'proxy fixture',limits:{modelCalls:3,toolCalls:0,outputTokens:100,wallTimeMs:5000}};
 const result=await runtime.runText(request);assert.equal(result.status==='succeeded'&&result.value,'native proxy reply');
 redirect=true;assert.equal((await runtime.runText({...request,taskId:'redirect'})).status,'failed');assert.equal(targetCalls,0);assert.equal(calls,2);
});
