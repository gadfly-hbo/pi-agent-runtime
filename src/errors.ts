import type {Reason, ContextAdmission, ModelOutcome, ToolOutcome, ToolErrorFeedback} from './types.ts';
export class RuntimeFault extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {super(reason); this.name = 'RuntimeFault'; this.reason = reason;}
}
/** Explicit transport classification, never derived from arbitrary error text. */
export class ProviderFailure extends RuntimeFault {
  readonly category: 'quota' | 'rate-limit' | 'unavailable' | 'network';
  readonly outcome?: Readonly<ModelOutcome>;
  constructor(category: ProviderFailure['category'], outcome?: ModelOutcome) {
    super('MODEL_FAILED'); this.name = 'ProviderFailure'; this.category = category;
    if (outcome) this.outcome = safeOutcome(outcome);
  }
}
export function reasonOf(error: unknown, fallback: Reason = 'MODEL_FAILED'): Reason {
  return error instanceof RuntimeFault ? error.reason : fallback;
}

/** Safe admission report only; no prompt, schema, credentials or raw Provider body. */
export class ContextAdmissionFailure extends RuntimeFault {
  readonly admission: Readonly<ContextAdmission>;
  constructor(admission: ContextAdmission) {
    super('INVALID_REQUEST'); this.name = 'ContextAdmissionFailure';
    this.admission = Object.freeze({...admission, model: Object.freeze({...admission.model})});
  }
}

/** A confirmed neutral classification, never arbitrary Provider text. */
export class ModelFailure extends RuntimeFault {
  readonly outcome: Readonly<ModelOutcome>;
  constructor(outcome: ModelOutcome, reason: Reason = 'MODEL_FAILED') {
    super(reason); this.name = 'ModelFailure'; this.outcome = safeOutcome(outcome);
  }
}
export function safeOutcome(outcome: ModelOutcome): Readonly<ModelOutcome> {
  const label = (value:unknown) => typeof value==='string' && value.length>0 && value.length<=256 && !/[\r\n\u0000]/.test(value);
  if (!outcome || !label(outcome.model?.provider) || !label(outcome.model?.id) ||
    !['openai-completions','anthropic-messages'].includes(outcome.model.protocol) ||
    (outcome.responseModel!==undefined && !/^[A-Za-z0-9_.:/-]{1,256}$/.test(outcome.responseModel)) ||
    !['complete','tools','length','deferred','error','cancelled','unknown'].includes(outcome.stop) ||
    (outcome.category!==undefined && !['context','quota','rate-limit','unavailable','network','authentication','invalid-request','invalid-output','safety','unknown'].includes(outcome.category)) ||
    !['not-sent','response-received','unknown'].includes(outcome.physicalStatus) || typeof outcome.usageFinal!=='boolean' ||
    (outcome.httpStatus!==undefined && (!Number.isSafeInteger(outcome.httpStatus)||outcome.httpStatus<100||outcome.httpStatus>599)) ||
    !['COMPLETE','OUTPUT_LIMIT','CONTEXT_LIMIT','REQUEST_FAILED','CANCELLED','UNKNOWN'].includes(outcome.diagnostic))throw new RuntimeFault('INVALID_OUTPUT');
  const token = (value: ModelOutcome['usage']['inputTokens']) => {
    if (value.kind === 'unknown') {
      if(value.reported!==undefined && (!Number.isSafeInteger(value.reported)||value.reported<0))throw new RuntimeFault('INVALID_OUTPUT');
      return Object.freeze({kind:'unknown' as const,...(value.reported===undefined?{}:{reported:value.reported})});
    }
    if (value.kind !== 'known' || !Number.isSafeInteger(value.value) || value.value < 0) throw new RuntimeFault('INVALID_OUTPUT');
    return Object.freeze({kind:'known' as const, value:value.value});
  };
  return Object.freeze({model:Object.freeze({provider:outcome.model.provider, id:outcome.model.id, protocol:outcome.model.protocol}),
    ...(outcome.responseModel === undefined ? {} : {responseModel:outcome.responseModel}), stop:outcome.stop,
    ...(outcome.category === undefined ? {} : {category:outcome.category}), physicalStatus:outcome.physicalStatus,
    ...(outcome.httpStatus === undefined ? {} : {httpStatus:outcome.httpStatus}),
    usageFinal:outcome.usageFinal, usage:Object.freeze({inputTokens:token(outcome.usage.inputTokens), outputTokens:token(outcome.usage.outputTokens)}), diagnostic:outcome.diagnostic});
}

export function safeToolOutcome(outcome: ToolOutcome): Readonly<ToolOutcome> {
  if (!outcome.name || outcome.name.length>256 || /[\r\n\u0000]/.test(outcome.name) ||
    !['read','write','external'].includes(outcome.effect) || !['completed','unknown'].includes(outcome.status) ||
    !['pending','ready','rejected','failed'].includes(outcome.modelOutput) ||
    !Number.isSafeInteger(outcome.resourceUnits) || outcome.resourceUnits<0 ||
    (outcome.receiptId!==undefined && !/^[A-Za-z0-9_.:-]{1,256}$/.test(outcome.receiptId)) ||
    (outcome.failureCategory!==undefined && !['not_found','not_directory','is_directory','permission_denied','invalid','not_supported','cancelled','timeout','limit_exceeded','unknown'].includes(outcome.failureCategory)))throw new RuntimeFault('INVALID_OUTPUT');
  const invocation=outcome.invocation;
  return Object.freeze({name:outcome.name,effect:outcome.effect,status:outcome.status,modelOutput:outcome.modelOutput,resourceUnits:outcome.resourceUnits,
    ...(outcome.receiptId===undefined?{}:{receiptId:outcome.receiptId}),...(outcome.reason===undefined?{}:{reason:outcome.reason}),
    ...(outcome.failureCategory===undefined?{}:{failureCategory:outcome.failureCategory}),
    ...(invocation?{invocation:Object.freeze({sessionId:invocation.sessionId,branch:invocation.branch,operationId:invocation.operationId,invocationId:invocation.invocationId,toolCallId:invocation.toolCallId})}:{})});
}
const toolFeedbackProofs=new WeakMap<ToolOutputFailure,{outcome:Readonly<ToolOutcome>;feedback:Readonly<ToolErrorFeedback>}>();
/** Host tool/delivery failure. Optional no-effect proof never changes completion/receipt semantics. */
export class ToolOutputFailure extends RuntimeFault {
  readonly outcome: Readonly<ToolOutcome>;
  declare readonly feedback?: Readonly<ToolErrorFeedback>;
  constructor(outcome: ToolOutcome, reason: Reason = 'TOOL_FAILED', feedback?: ToolErrorFeedback) {
    super(reason); this.name='ToolOutputFailure'; this.outcome=safeToolOutcome(outcome);
    if(feedback!==undefined){
      if(!feedback || feedback.effect!=='none' || !['not_found','not_directory','is_directory','invalid','not_supported'].includes(feedback.code) ||
        Object.keys(feedback).some(k=>!['effect','code'].includes(k)) || reason!=='TOOL_FAILED' || outcome.effect!=='read' || outcome.status!=='completed' ||
        outcome.modelOutput!=='failed' || outcome.receiptId!==undefined || outcome.reason!==undefined&&outcome.reason!=='TOOL_FAILED' ||
        outcome.failureCategory!==undefined&&outcome.failureCategory!==feedback.code)throw new RuntimeFault('INVALID_OUTPUT');
      this.feedback=Object.freeze({effect:'none',code:feedback.code});
      toolFeedbackProofs.set(this,{outcome:this.outcome,feedback:this.feedback});
    }
  }
}

export function trustedToolFeedback(error:ToolOutputFailure):Readonly<ToolErrorFeedback>|undefined{
  const proof=toolFeedbackProofs.get(error);
  return proof?.outcome===error.outcome&&error.reason==='TOOL_FAILED'?proof?.feedback:undefined;
}

/** Internal cleared feedback. Neither the public error message nor its cause crosses into Pi. */
export class AcceptedToolFeedback extends RuntimeFault {
  constructor(feedback:Readonly<ToolErrorFeedback>){super('TOOL_FAILED');this.message=JSON.stringify({status:'error',code:feedback.code,executed:false});}
}

/** Neutral host limit distinct from native missing/authority/unsupported failures. */
export class ExecutionLimitFailure extends RuntimeFault {
  readonly code = 'limit_exceeded';
  constructor() {super('BUDGET_EXHAUSTED');this.name='ExecutionLimitFailure';}
}

/** Decode only the bounded admission metadata; never forward arbitrary stored properties. */
export function safeAdmissionFact(fact:import('./types.ts').ToolAdmissionFact):Readonly<import('./types.ts').ToolAdmissionFact>{
  const label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\r\n\u0000]/.test(v);
  if(fact.version!=='1'||![fact.taskId,fact.runId,fact.callId,fact.name,fact.policyVersion,fact.viewVersion].every(label)||
    (fact.purpose!==undefined&&!label(fact.purpose))||![fact.viewDigest,fact.rawArgumentsDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||
    !['ready','rejected','deferred'].includes(fact.disposition)||!Number.isSafeInteger(fact.correctionsUsed)||fact.correctionsUsed<0||fact.correctionsUsed>2||typeof fact.terminal!=='boolean'||
    (fact.code!==undefined&&!['STRUCTURE_MISMATCH','BATCH_DEFERRED','CORRECTION_EXHAUSTED','HOOK_REJECTED','STALE_VIEW','TOOL_UNAVAILABLE','INVALID_CALL'].includes(fact.code))||
    (fact.session&&![fact.session.sessionId,fact.session.branch,fact.session.operationId].every(label)))throw new RuntimeFault('STATE_FAILED');
  return Object.freeze({version:'1',taskId:fact.taskId,runId:fact.runId,...(fact.purpose===undefined?{}:{purpose:fact.purpose}),callId:fact.callId,name:fact.name,
    policyVersion:fact.policyVersion,viewVersion:fact.viewVersion,viewDigest:fact.viewDigest,rawArgumentsDigest:fact.rawArgumentsDigest,disposition:fact.disposition,
    ...(fact.code===undefined?{}:{code:fact.code}),correctionsUsed:fact.correctionsUsed,terminal:fact.terminal,
    ...(fact.session?{session:Object.freeze({sessionId:fact.session.sessionId,branch:fact.session.branch,operationId:fact.session.operationId})}:{})});
}
