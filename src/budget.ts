import {RuntimeFault} from './errors.ts';
import {uncapped,validateLimits,counted} from './policy.ts';
import type {BudgetStore, Limits, UncappedLimits, Usage, UncappedBudgetLease} from './types.ts';

/** Same-process reference only; no durability, automatic reset, or cross-process lock. */
export function createMemoryBudgetStore(): BudgetStore {
  const tasks = new Map<string, {configuration: string; limits: Limits | UncappedLimits; usage: Usage; owner?: string}>();
  async function claim(taskId:string, runId:string, configuration:string, limits:Limits | UncappedLimits) {
    validateLimits(limits);
    let task = tasks.get(taskId);
    if (!task) {
      task = {configuration, limits: {...limits}, usage: {modelCalls: 0, toolCalls: 0, outputTokens: 0, resourceUnits: 0, activeMs: 0,
        ...(uncapped(limits)?{inputTokens:0,reservedOutputTokens:0}:{})}};
      tasks.set(taskId, task);
    }
    if (task.configuration !== configuration) throw new RuntimeFault('CONFIGURATION_CHANGED');
    if (task.owner) throw new RuntimeFault('TASK_BUSY');
    if (!uncapped(task.limits) && task.usage.activeMs >= task.limits.wallTimeMs) throw new RuntimeFault('BUDGET_EXHAUSTED');
    task.owner = runId;
    const state = task;
    const assertOwner = () => {if (state.owner !== runId) throw new RuntimeFault('TASK_BUSY');};
    const reserve = (maximum?:number) => {
      assertOwner();
      const free=uncapped(state.limits);
      if(maximum===undefined){if(free)throw new RuntimeFault('INVALID_REQUEST');maximum=(state.limits as Limits).outputTokens-state.usage.outputTokens;}
      if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RuntimeFault(free?'INVALID_REQUEST':'BUDGET_EXHAUSTED');
      const tokens = free ? maximum : Math.min(maximum, (state.limits as Limits).outputTokens - state.usage.outputTokens);
      if (!uncapped(state.limits) && (state.usage.modelCalls >= state.limits.modelCalls || tokens <= 0 ||
        (state.limits.resourceUnits!==undefined && state.usage.resourceUnits + 1 > state.limits.resourceUnits))) throw new RuntimeFault('BUDGET_EXHAUSTED');
      const next={...state.usage,modelCalls:counted(state.usage.modelCalls+1),resourceUnits:counted(state.usage.resourceUnits+1),outputTokens:counted(state.usage.outputTokens+tokens),
        ...(free?{reservedOutputTokens:counted(state.usage.reservedOutputTokens!+tokens)}:{})};
      Object.assign(state.usage,next);return tokens;
    };
    const settle=async(reserved:number,actual:number,input=0)=>{
      assertOwner();
      if(!Number.isSafeInteger(reserved)||reserved<1||!Number.isSafeInteger(actual)||actual<0||(!uncapped(state.limits)&&actual>reserved))throw new RuntimeFault('BUDGET_EXHAUSTED');
      const next={...state.usage,outputTokens:counted(state.usage.outputTokens-reserved+actual),...(uncapped(state.limits)?{
        inputTokens:counted(state.usage.inputTokens!+counted(input)),reservedOutputTokens:counted(state.usage.reservedOutputTokens!-reserved)}:{})};
      Object.assign(state.usage,next);
    };
    return {
      snapshot: () => ({...state.usage}),
      async reserveModel() {return reserve();},
      async reserveModelUpTo(maximum:number) {return reserve(maximum);},
      settleModel:settle,
      async settleModelUsage(reserved:number,usage:{inputTokens:number;outputTokens:number}) {await settle(reserved,usage.outputTokens,usage.inputTokens);},
      async reserveTool(units:number) {
        assertOwner();counted(units);
        if (!uncapped(state.limits) && (state.usage.toolCalls >= state.limits.toolCalls || (state.limits.resourceUnits!==undefined && state.usage.resourceUnits + units > state.limits.resourceUnits))) throw new RuntimeFault('BUDGET_EXHAUSTED');
        const calls=counted(state.usage.toolCalls+1),resources=counted(state.usage.resourceUnits+units);state.usage.toolCalls=calls;state.usage.resourceUnits=resources;
      },
      async release(activeMs:number) {assertOwner();state.usage.activeMs=counted(state.usage.activeMs+counted(activeMs));delete state.owner;},
    };
  }
  return {claim,async claimUncapped(...args){return await claim(...args) as UncappedBudgetLease;}};
}
