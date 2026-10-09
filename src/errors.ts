import type {Reason} from './types.ts';
export class RuntimeFault extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {super(reason); this.name = 'RuntimeFault'; this.reason = reason;}
}
/** Explicit transport classification, never derived from arbitrary error text. */
export class ProviderFailure extends RuntimeFault {
  readonly category: 'quota' | 'rate-limit' | 'unavailable' | 'network';
  constructor(category: ProviderFailure['category']) {
    super('MODEL_FAILED'); this.name = 'ProviderFailure'; this.category = category;
  }
}
export function reasonOf(error: unknown, fallback: Reason = 'MODEL_FAILED'): Reason {
  return error instanceof RuntimeFault ? error.reason : fallback;
}
