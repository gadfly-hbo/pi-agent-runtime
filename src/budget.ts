import {RuntimeFault} from './errors.ts';
import type {BudgetStore, Limits, Usage} from './types.ts';

/** Same-process reference only; no durability, automatic reset, or cross-process lock. */
export function createMemoryBudgetStore(): BudgetStore {
  const tasks = new Map<string, {configuration: string; limits: Limits; usage: Usage; owner?: string}>();
  return {async claim(taskId, runId, configuration, limits) {
    let task = tasks.get(taskId);
    if (!task) {
      task = {configuration, limits: {...limits}, usage: {modelCalls: 0, toolCalls: 0, outputTokens: 0, resourceUnits: 0, activeMs: 0}};
      tasks.set(taskId, task);
    }
    if (task.configuration !== configuration) throw new RuntimeFault('CONFIGURATION_CHANGED');
    if (task.owner) throw new RuntimeFault('TASK_BUSY');
    if (task.usage.activeMs >= task.limits.wallTimeMs) throw new RuntimeFault('BUDGET_EXHAUSTED');
    task.owner = runId;
    const state = task;
    const assertOwner = () => {if (state.owner !== runId) throw new RuntimeFault('TASK_BUSY');};
    const reserve = (maximum = Number.MAX_SAFE_INTEGER) => {
      assertOwner();
      if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RuntimeFault('INVALID_REQUEST');
      const tokens = Math.min(maximum, state.limits.outputTokens - state.usage.outputTokens);
      if (state.usage.modelCalls >= state.limits.modelCalls || tokens <= 0 ||
        state.usage.resourceUnits + 1 > (state.limits.resourceUnits ?? Number.MAX_SAFE_INTEGER)) throw new RuntimeFault('BUDGET_EXHAUSTED');
      state.usage.modelCalls++; state.usage.resourceUnits++; state.usage.outputTokens += tokens;
      return tokens;
    };
    return {
      snapshot: () => ({...state.usage}),
      async reserveModel() {
        return reserve();
      },
      async reserveModelUpTo(maximum) {return reserve(maximum);},
      async settleModel(reserved, actual) {
        assertOwner();
        if (!Number.isSafeInteger(actual) || actual < 0 || actual > reserved) throw new RuntimeFault('BUDGET_EXHAUSTED');
        state.usage.outputTokens -= reserved - actual;
      },
      async reserveTool(units) {
        assertOwner();
        if (state.usage.toolCalls >= state.limits.toolCalls || state.usage.resourceUnits + units > (state.limits.resourceUnits ?? Number.MAX_SAFE_INTEGER)) throw new RuntimeFault('BUDGET_EXHAUSTED');
        state.usage.toolCalls++; state.usage.resourceUnits += units;
      },
      async release(activeMs) {assertOwner(); state.usage.activeMs += activeMs; delete state.owner;},
    };
  }};
}
