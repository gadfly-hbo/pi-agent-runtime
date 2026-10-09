import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime,createExecutionTools,createLocalExecutionEnvironment} from '../src/index.ts';
async function setup(t:test.TestContext) {
 const root=await mkdtemp(join(tmpdir(),'pi-exec-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const env=await createLocalExecutionEnvironment({root,policyVersion:'isolated-v1',exclusiveWorkspace:true,maxFileBytes:65536,maxOutputBytes:4096,timeoutMs:300,processes:true});
 return {root,env};
}
test('EX01 real native read/write/edit tools consume a bounded workspace and reject traversal/symlinks',async t=>{
 const {root,env}=await setup(t);const tools=createExecutionTools(env,['read','write','edit']);
 let calls=0;const plans=[{name:'write',arguments:{path:'value.txt',content:'answer 41'}},{name:'edit',arguments:{path:'value.txt',edits:[{oldText:'41',newText:'42'}]}},{name:'read',arguments:{path:'value.txt'}}];
 const runtime=createRuntime({model:{provider:'synthetic',id:'files',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:8192},authorize:async()=>true,audit:{append:async()=>{}},transport:async request=>{
 const plan=plans[calls++];if(plan)return {content:[{kind:'tool',id:String(calls),...plan}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
 assert.ok(request.messages.some(m=>m.role==='tool'&&m.text==='answer 42'));return {content:[{kind:'text',text:'42'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};}});
 const result=await runtime.runAgent({taskId:'files',prompt:'write edit read',tools,limits:{modelCalls:5,toolCalls:4,outputTokens:100,wallTimeMs:2000}});
 assert.equal(result.status,'succeeded');assert.equal(await readFile(join(root,'value.txt'),'utf8'),'answer 42');
 await assert.rejects(env.read('../outside',new AbortController().signal),/AUTHORITY_REQUIRED/);
 await symlink('/etc/passwd',join(root,'link'));await assert.rejects(env.read('link',new AbortController().signal),/AUTHORITY_REQUIRED/);
 await assert.rejects(env.write('link',new Uint8Array([1]),new AbortController().signal),/AUTHORITY_REQUIRED/);
});
// Explicit separate command: OS sandbox tests require the host to allow creating a sandbox.
test('EX02 OS sandbox: real shell, denied network/outside writes, bounded output and cancellation',{skip:process.env.PI_RUN_OS_SANDBOX_TESTS!=='1'},async t=>{
 const {root,env}=await setup(t),signal=new AbortController().signal;
 assert.equal((await env.exec('printf sandbox-ok',signal)).output,'sandbox-ok');
 const tools=createExecutionTools(env,['bash']);let turns=0;
 const runtime=createRuntime({model:{provider:'synthetic',id:'shell',protocol:'openai-completions',endpoint:'https://example.invalid',contextWindow:8192},authorize:async()=>true,audit:{append:async()=>{}},transport:async r=>{
  if(++turns===1)return{content:[{kind:'tool',id:'shell',name:'bash',arguments:{command:'printf native-shell-84'}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
  assert.equal(r.messages.find(m=>m.role==='tool')?.text,'native-shell-84');return{content:[{kind:'text',text:'84'}],stop:'complete',usage:{inputTokens:1,outputTokens:1}};}});
 assert.equal((await runtime.runAgent({taskId:'shell',prompt:'execute',tools,limits:{modelCalls:3,toolCalls:1,outputTokens:100,wallTimeMs:1000}})).status,'succeeded');
 const outside=join(tmpdir(),`pi-denied-${process.pid}`);t.after(()=>rm(outside,{force:true}));
 assert.notEqual((await env.exec(`echo bad > '${outside}'`,signal)).exitCode,0);
 const {createServer}=await import('node:http');let accepted=0;
 const server=createServer((_req,res)=>{accepted++;res.end('reachable');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;
 assert.equal(await (await fetch(url)).text(),'reachable');assert.equal(accepted,1);
 const network=await env.exec(`exec /usr/bin/curl --noproxy '*' --max-time 1 ${url}`,signal);assert.notEqual(network.exitCode,0);assert.equal(accepted,1);
 await assert.rejects(env.exec('while :; do printf 1234567890; done',signal),/BUDGET_EXHAUSTED/);
 // Fork denial prevents setsid/background escape before a child can exist.
 const fork=await env.exec('/bin/sleep 30 &',signal);assert.notEqual(fork.exitCode,0);
 const detached=await env.exec("exec /usr/bin/perl -e 'defined(my $p = fork()) or exit 73; exit 0;'",signal);assert.equal(detached.exitCode,73);
 await assert.rejects(env.exec('echo $$ > child.pid; exec /bin/sleep 30',signal),/DEADLINE_EXCEEDED/);
 const childPid=Number(await readFile(join(root,'child.pid'),'utf8'));assert.throws(()=>process.kill(childPid,0));
 const controller=new AbortController();const pending=env.exec('exec /bin/sleep 30',controller.signal);setTimeout(()=>controller.abort(),20);
 await assert.rejects(pending,/CANCELLED/);
 assert.equal((await env.exec('echo safe > local.txt; exec /bin/cat local.txt',signal)).output,'safe\n');
 assert.equal(await readFile(join(root,'local.txt'),'utf8'),'safe\n');
});

 test('EX03 special files and hardlinks reject without blocking subsequent file IO',async t=>{
 const {root,env}=await setup(t),signal=new AbortController().signal;
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 await promisify(execFile)('/usr/bin/mkfifo',[join(root,'fifo')]);
 for(const path of ['fifo']){await assert.rejects(env.read(path,signal),/AUTHORITY_REQUIRED/);await assert.rejects(env.write(path,new Uint8Array([1]),signal),/AUTHORITY_REQUIRED/);await assert.rejects(env.stat(path,signal),/AUTHORITY_REQUIRED/);}
 await writeFile(join(root,'original'),'preserved');await link(join(root,'original'),join(root,'alias'));
 await assert.rejects(env.write('alias',new Uint8Array([1]),signal),/AUTHORITY_REQUIRED/);assert.equal(await readFile(join(root,'original'),'utf8'),'preserved');
 await env.write('normal',new TextEncoder().encode('works'),signal);assert.equal(new TextDecoder().decode(await env.read('normal',signal)),'works');
 });
