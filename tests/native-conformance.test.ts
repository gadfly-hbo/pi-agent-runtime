import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonlSessionRepo,BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {createSessionRepoConformance} from '@earendil-works/pi-agent-core/harness/session/testing';
import type {SessionRepo,JsonlSessionMetadata} from '@earendil-works/pi-agent-core/harness/session';
const cleanup:(()=>Promise<void>)[]=[];
const cases=createSessionRepoConformance<JsonlSessionMetadata>(async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-conformance-'));
 const repo=new JsonlSessionRepo({fileSystem:new NodeExecutionEnv({cwd:root}),sessionsRoot:root});
 cleanup.push(async()=>{await repo.close(BACKGROUND_CONTEXT);await rm(root,{recursive:true,force:true});});
 // Apply the SDK's approved exclusive repository ownership before native async admission.
 // Raw 0.86.1 concurrent create/fork evidence is retained in native-001.log.
 let busy=false;
 const exclusive=async <T>(fn:()=>Promise<T>):Promise<T>=>{if(busy)throw Error('TASK_BUSY');busy=true;try{return await fn();}finally{busy=false;}};
 const backend:SessionRepo<JsonlSessionMetadata>={create:(options,context)=>exclusive(()=>repo.create({...options,cwd:root},context)),
 open:(m,c)=>repo.open(m,c),list:(_o,c)=>repo.list({cwd:root},c),delete:(m,c)=>repo.delete(m,c),fork:(m,o,c)=>exclusive(()=>repo.fork(m,o,c))};
 return backend;
},async()=>{for(const fn of cleanup.splice(0))await fn();});
for(const scenario of cases)test(`NC ${scenario.group}: ${scenario.name}`,()=>scenario.run());
