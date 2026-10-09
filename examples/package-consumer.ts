import {createRuntime, createMemoryBudgetStore, RuntimeFault} from 'pi-agent-runtime';
import type {ModelConfig, BudgetStore, RunResult, TextRequest, ToolExecutionMode, ModelContent} from 'pi-agent-runtime';
import {createReplay} from 'pi-agent-runtime/testing';
const model: ModelConfig = {provider: 'synthetic', id: 'fixture', protocol: 'openai-completions', endpoint: 'https://invalid.invalid', contextWindow: 8192};
const budgets: BudgetStore = createMemoryBudgetStore();
const replay = createReplay([]);
const runtime = createRuntime({model, budgets, transport: replay.transport, authorize: async () => false, audit: {append: async () => {}}});
const result: RunResult<number> = await runtime.runWorker({taskId: 'type-only', prompt: 'Synthetic',
  limits: {modelCalls: 1, toolCalls: 0, outputTokens: 10, wallTimeMs: 1000},
  validate: value => {if (typeof value !== 'number') throw new RuntimeFault('INVALID_OUTPUT'); return value;}});
if (result.status === 'succeeded') {const value: number = result.value; void value;}
const mode:ToolExecutionMode='parallel';
const request:TextRequest={taskId:'text-type-only',prompt:'Synthetic',limits:{modelCalls:1,toolCalls:0,outputTokens:2048,wallTimeMs:1000},
  toolExecution:mode,thinkingLevel:'off',validate:text=>text};
const text:RunResult<string>=await runtime.runText(request);void text;
const continuation:ModelContent={kind:'reasoning',text:'Synthetic',signature:'synthetic-signature'};void continuation;
