// Synthetic host fixture, not a production BudgetStore or recovery implementation.
import {readFile, writeFile, rename, open, unlink, appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createSessionRuntime, RuntimeFault} from '../../src/index.ts';
const [root, mode] = process.argv.slice(2);
const ledgerFile = join(root, 'host-ledger.json');
const save = async value => {await writeFile(`${ledgerFile}.tmp`, JSON.stringify(value)); await rename(`${ledgerFile}.tmp`, ledgerFile);};
const load = async () => {try {return JSON.parse(await readFile(ledgerFile, 'utf8'));} catch (e) {if (e.code !== 'ENOENT') throw e; return undefined;}};
const budgets = {async claim(taskId, runId, configuration, limits) {
  const previous = await load();
  const state = previous ?? {taskId, configuration, usage: {modelCalls: 0, toolCalls: 0, outputTokens: 0, resourceUnits: 0, activeMs: 0}};
  if (state.taskId !== taskId || state.configuration !== configuration) throw new RuntimeFault('CONFIGURATION_CHANGED');
  if (state.owner) throw new RuntimeFault('TASK_BUSY');
  state.owner = runId; await save(state);
  const reserve = async (maximum = limits.outputTokens) => {
    const n = Math.min(maximum, limits.outputTokens - state.usage.outputTokens);
    if (n < 1 || state.usage.modelCalls >= limits.modelCalls) throw new RuntimeFault('BUDGET_EXHAUSTED');
    state.usage.modelCalls++; state.usage.resourceUnits++; state.usage.outputTokens += n; await save(state); return n;
  };
  return {snapshot: () => ({...state.usage}), reserveModel: reserve, reserveModelUpTo: reserve,
    settleModel: async (reserved, actual) => {state.usage.outputTokens -= reserved - actual; await save(state);},
    reserveTool: async units => {if (state.usage.toolCalls >= limits.toolCalls) throw new RuntimeFault('BUDGET_EXHAUSTED'); state.usage.toolCalls++; state.usage.resourceUnits += units; await save(state);},
    release: async ms => {state.usage.activeMs += ms; delete state.owner; await save(state);}};
}};
const answer = text => ({content: [{kind: 'text', text}], stop: 'complete', usage: {inputTokens: 1, outputTokens: 1}});
const options = {model: {provider: 'synthetic', id: 'process', protocol: 'openai-completions', endpoint: 'https://example.invalid', contextWindow: 8192},
  budgets, authorize: async () => true, audit: {append: e => appendFile(join(root, 'audit.jsonl'), JSON.stringify(e) + '\n')},
  storage: {directory: join(root, 'sessions'), cwd: root, policyVersion: 'fixture-v1', authorize: async () => true,
    acquireWriter: async () => {const handle = await open(join(root, 'writer.lock'), 'wx'); return {release: async () => {await handle.close(); await unlink(join(root, 'writer.lock'));}};}},
  bindOperation: async binding => appendFile(join(root, 'bindings.jsonl'), JSON.stringify(binding) + '\n'),
  reconcile: async input => {
    await appendFile(join(root, 'reconciliation.jsonl'), JSON.stringify(input) + '\n');
    return mode === 'recover' ? 'unknown' : 'ready';
  },
  transport: async request => {
    await appendFile(join(root, 'physical-models.jsonl'), JSON.stringify({mode}) + '\n');
    const prior = request.messages.find(m => m.role === 'tool');
    if (!prior) return {content: [{kind: 'tool', id: 'lookup', name: 'lookup', arguments: {}}], stop: 'tools', usage: {inputTokens: 1, outputTokens: 1}};
    if (prior.text !== '73') throw Error('Previous result not consumed');
    return answer('consumed 73');
  }};
let active=0,maxActive=0;
if(mode.startsWith('batch-')) options.transport=async request=>{
 await appendFile(join(root,'physical-models.jsonl'),JSON.stringify({mode})+'\n');
 if(!request.messages.some(m=>m.role==='tool'))return{content:[{kind:'tool',id:'one',name:'one',arguments:{}},{kind:'tool',id:'two',name:'two',arguments:{}}],stop:'tools',usage:{inputTokens:1,outputTokens:1}};
 return answer('batch consumed');
};
if(mode.startsWith('summary-')){options.model.maxOutputTokens=10;options.transport=async()=>{return answer('RECOVERED-SUMMARY-81');};}
if(mode.startsWith('summary-') && mode.endsWith('crash')) {
 const {AgentHarness}=await import('@earendil-works/pi-agent-core');const create=AgentHarness.create;
 AgentHarness.create=async(...args)=>{const attached=await create(...args);const lane=attached.harness.lane.bind(attached.harness);
 attached.harness.lane=async(...args)=>{const result=await lane(...args);const accept=result.accept.bind(result);result.accept=async(...args)=>{const admitted=await accept(...args);if(admitted.ok)process.exit(84);return admitted;};return result;};return attached;};
}
const runtime = createSessionRuntime(options);
const session = mode === 'first' || mode === 'crash' || mode === 'safe-crash' || mode === 'batch-crash' || mode === 'summary-setup' ? await runtime.create() : JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
await writeFile(join(root, 'session.json'), JSON.stringify(session));
const result = await runtime.run({sessionId: session.id, taskId: 'stable-process-task', prompt: ['recover','safe-resume','batch-resume','summary-compact-resume','summary-navigate-resume'].includes(mode) ? '' : 'lookup',
  ...(['recover','safe-resume','batch-resume','summary-compact-resume','summary-navigate-resume'].includes(mode) ? {operation: 'resume'} : {}),
  ...(mode==='summary-setup'?{prompt:'Synthetic history. '.repeat(800)}:{}),
  ...(mode==='summary-compact-crash'?{operation:'compact',prompt:'Retain the evidence'}:{}),
  ...(mode==='summary-navigate-crash'?{operation:'navigate',targetEntryId:(await runtime.history(session.id))[0].id,summarize:true,prompt:'Retain the evidence'}:{}),
  ...(mode.startsWith('batch-') ? {toolExecution:'parallel'} : {}),
  limits: {modelCalls: 10, toolCalls: 5, outputTokens: 100, wallTimeMs: 10000},
  tools: mode.startsWith('batch-') ? ['one','two'].map(name=>({name,description:'Mixed batch',effect:'read',resourceUnits:1,parameters:{type:'object',properties:{}},replay:'safe',...(name==='one'?{executionMode:'sequential'}:{}),execute:async()=>{if(mode==='batch-crash')process.exit(83);active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,30));active--;await writeFile(join(root,'concurrency.json'),JSON.stringify({maxActive}));return 73;}})) : [{...(mode.startsWith('safe-') ? {replay:'safe'} : {}),name: 'lookup', description: 'Synthetic read', effect: 'read', resourceUnits: 1, parameters: {type: 'object', properties: {}},
    execute: async (_args,_signal,invocation) => {if(mode==='safe-resume'){const saved=await invocation.getMemo('receipt');if(saved!==73)throw Error('missing native memo');return saved;} await appendFile(join(root, 'effects.jsonl'), '73\n'); if (mode === 'crash') process.exit(77); if(mode==='safe-crash'){await invocation.setMemo('receipt',73);process.exit(78);} return 73;}}]});
console.log(JSON.stringify(result));
