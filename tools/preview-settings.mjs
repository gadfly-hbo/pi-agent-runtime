import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';
import {createRuntime,ProviderFailure} from '../dist/index.js';
import {compileSettings,validateSettings} from '../dist/settings.js';
const directory=new URL('../artifacts/runtime-ui-v0.2/preview/',import.meta.url);
await mkdir(directory,{recursive:true});
await build({entryPoints:[new URL('../examples/settings-ui.tsx',import.meta.url).pathname],bundle:true,format:'esm',platform:'browser',outfile:new URL('app.js',directory).pathname});
const html='<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>共享模型设置</title><link rel="stylesheet" href="/app.css"><style>body{margin:0;padding:28px;background:white}.preview-note,.preview-results{max-width:960px;margin:0 auto 22px;color:#777;font:13px/1.5 sans-serif}.preview-results{margin-top:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:540px){body{padding:16px}}</style><div id="root"></div><script type="module" src="/app.js"></script></html>';
async function consume(settings){
  const events=[],route=compileSettings(settings,(model)=>async request=>{
    if(model.id===settings.providers.flatMap(p=>p.models).find(m=>m.id===settings.primary)?.modelId)throw new ProviderFailure('quota');
    if(request.messages.some(m=>m.role==='system'&&m.tools?.length)&&!request.messages.some(m=>m.role==='tool'))return {content:[{kind:'tool',id:'demo-once',name:'lookup',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
    return {content:[{kind:'text',text:'42'}],stop:'complete',usage:{inputTokens:1,outputTokens:2}};
  });
  const runtime=createRuntime({...route,authorize:async()=>true,audit:{append:async event=>{events.push(event);}}});
  const limits={modelCalls:4,toolCalls:1,outputTokens:32,resourceUnits:8,wallTimeMs:2000};
  const worker=await runtime.runWorker({taskId:randomUUID(),prompt:'Synthetic only',limits,validate:value=>value});
  let toolExecutions=0;
  const agent=await runtime.runAgent({taskId:randomUUID(),prompt:'Synthetic only',limits,tools:[{name:'lookup',description:'Synthetic lookup',effect:'read',resourceUnits:1,
    parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{toolExecutions++;return {answer:42};}}]});
  return {worker:worker.status,agent:agent.status,toolExecutions,modelsUsed:events.filter(e=>e.kind==='model.admitted').map(e=>e.model),workerUsage:worker.usage,agentUsage:agent.usage};
}
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  res.setHeader('Cache-Control','no-store');
  try{
    if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    if(req.method==='GET'&&['/app.js','/app.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(new URL(req.url.slice(1),directory)));return;}
    if(req.method==='POST'&&req.url==='/configuration'){
      if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:48175')throw new Error();
      if(!req.headers['content-type']?.startsWith('application/json'))throw new Error();
      const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>1048576)throw new Error();chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString());if(validateSettings(value).length)throw new Error();
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await consume(value)));return;
    }
    res.writeHead(404);res.end();
  }catch{res.writeHead(400);res.end('Configuration rejected');}
});
server.listen(48175,'127.0.0.1',()=>console.log('Synthetic shared UI: http://127.0.0.1:48175/ — no Provider calls, no credential storage'));
