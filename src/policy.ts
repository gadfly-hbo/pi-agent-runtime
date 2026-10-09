import type {Limits,UncappedLimits} from './types.ts';
import {RuntimeFault} from './errors.ts';
export const uncapped = (limits: Limits | UncappedLimits): limits is UncappedLimits => 'cumulative' in limits;
export const outputCap = (limits: Limits | UncappedLimits): number => uncapped(limits) ? limits.maxOutputTokens : limits.outputTokens;
export function validateLimits(limits: Limits | UncappedLimits): void {
  const integer=(n:unknown,min=0)=>Number.isSafeInteger(n) && (n as number)>=min;
  const timeout=(n:unknown)=>integer(n,1)&&(n as number)<=2_147_483_647;
  if (uncapped(limits)) {
    if(limits.cumulative!=='unlimited'||!integer(limits.maxOutputTokens,1)||
      !timeout(limits.modelTimeoutMs)||!timeout(limits.toolTimeoutMs)||!timeout(limits.controlTimeoutMs)||
      Object.keys(limits).some(k=>!['cumulative','maxOutputTokens','modelTimeoutMs','toolTimeoutMs','controlTimeoutMs'].includes(k)))throw new RuntimeFault('INVALID_REQUEST');
  } else if(!integer(limits.modelCalls,1)||!integer(limits.toolCalls)||!integer(limits.outputTokens,1)||!timeout(limits.wallTimeMs)||
    (limits.resourceUnits!==undefined&&!integer(limits.resourceUnits)))throw new RuntimeFault('INVALID_REQUEST');
}
/** Accounting precision failure is never interpreted as a budget ceiling or a reset. */
export function counted(n:number):number {if(!Number.isSafeInteger(n)||n<0)throw new RuntimeFault('STATE_FAILED');return n;}
