import {createHash, randomUUID} from 'node:crypto';
import {drive, createSessionBackend, admitModelRequest, executionFailureCategory} from './pi-adapter.ts';
import {reasonOf, RuntimeFault, ProviderFailure, ContextAdmissionFailure, ModelFailure, safeOutcome, ToolOutputFailure, AcceptedToolFeedback, trustedToolFeedback, safeToolOutcome, safeAdmissionFact} from './errors.ts';
import {uncapped,outputCap} from './policy.ts';
import {createMemoryBudgetStore} from './budget.ts';
import {freeze, isJson, validateReply, validateRequest, validateCheckpoint} from './validation.ts';
import type {AgentRequest, AuditEvent, BaseRequest, BudgetLease, JsonValue, ModelReply, RunResult, Runtime, RuntimeOptions, Tool, Usage, PurposeConfig, SessionRuntimeOptions, SessionRuntime, SessionBinding, UncappedBudgetLease, ModelOutcome, ToolOutcome, ModelAttempt, ModelAttemptFact} from './types.ts';
export type * from './types.ts';
export {createMemoryBudgetStore};
export {createPiTransport, createProxyTransport, createExecutionTools, loadHarnessResources, admitModelRequest, prepareToolArguments} from './pi-adapter.ts';
export {createLocalExecutionEnvironment} from './execution.ts';
export {RuntimeFault, ProviderFailure, ContextAdmissionFailure, ModelFailure, ToolOutputFailure, ExecutionLimitFailure} from './errors.ts';

export function createRuntime(options: RuntimeOptions): Runtime {
  return guardedRuntime(options, drive);
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  options = {...options, ...(options.toolFeedback?{toolFeedback:freeze(structuredClone(options.toolFeedback))}:{}), ...(options.toolAdmission?{toolAdmission:Object.freeze({...options.toolAdmission})}:{}), harness: freeze(structuredClone(options.harness ?? {})), ...(options.extensions ? {extensions:{...options.extensions, ...(options.extensions.customEntryTypes ? {customEntryTypes:[...options.extensions.customEntryTypes]} : {})}} : {})};
  const backend = createSessionBackend(options);
  const runtime = guardedRuntime(options, (...args) => 'sessionId' in args[1] ? backend.drive(...args) : drive(...args),
    {sessionPolicy: options.storage.policyVersion, harness: options.harness});
  return {...runtime, ...backend.sessions, run: request => {const input = {...request, sessionId: request.sessionId}; return runtime.runAgent(input);}};
}

function guardedRuntime(options: RuntimeOptions, driver: typeof drive, configurationExtension?: unknown): Runtime {
  options = {...options, ...(options.toolFeedback?{toolFeedback:freeze(structuredClone(options.toolFeedback))}:{}), ...(options.toolAdmission?{toolAdmission:Object.freeze({...options.toolAdmission})}:{}), ...(options.contextAdmission ? {contextAdmission:freeze(structuredClone(options.contextAdmission))} : {})};
  const budgets = options.budgets ?? createMemoryBudgetStore();
  const model = Object.freeze(structuredClone(options.model));
  const legacyCandidates = [{model, transport: options.transport}, ...(options.fallbacks ?? []).map(candidate =>
    ({model: Object.freeze(structuredClone(candidate.model)), transport: candidate.transport}))];
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const definitions = (tools: readonly Tool[]) => tools.map(({execute: _execute, ...definition}) => definition);
  const purposes = options.purposes?.map(p => ({...p, model: freeze(structuredClone(p.model)),
    fallbacks: p.fallbacks?.map(c => ({model: freeze(structuredClone(c.model)), transport: c.transport})),
    tools: (p.tools ?? []).map(t => freeze({...t, parameters: structuredClone(t.parameters)}))}));
  const purposePlan = purposes?.map(({id, mode, model, fallbacks, tools, toolExecution, thinkingLevel}) => ({id, mode, model,
    ...(fallbacks?.length ? {fallbacks: fallbacks.map(c => c.model)} : {}), tools: definitions(tools),
    ...(toolExecution === undefined ? {} : {toolExecution}), ...(thinkingLevel === undefined ? {} : {thinkingLevel})}));
  const idle = new Map<string, Promise<void>>();
  async function run<T>(mode: PurposeConfig['mode'], input: BaseRequest, inputTools: readonly Tool[], convert: (text: string) => T): Promise<RunResult<T>> {
    const purpose = purposes?.find(p => p.id === input.purpose);
    const candidates = purpose ? [{model: purpose.model, transport: purpose.transport}, ...(purpose.fallbacks ?? [])] :
      legacyCandidates;
    const routed = candidates.length > 1;
    const request: BaseRequest = freeze({...input,
      ...((input as AgentRequest).checkpoint ? {checkpoint: structuredClone((input as AgentRequest).checkpoint)} : {}),
      ...(purpose?.toolExecution === undefined ? {} : {toolExecution: purpose.toolExecution}),
      ...(purpose?.thinkingLevel === undefined ? {} : {thinkingLevel: purpose.thinkingLevel}), limits: {...input.limits}, ...(input.modelRecovery ? {modelRecovery:{...input.modelRecovery}} : {}), contextVersions: {...input.contextVersions}});
    const protection = uncapped(request.limits) ? request.limits : undefined;
    const tools = (purpose?.tools ?? inputTools).map(tool => ({...tool, parameters: structuredClone(tool.parameters),...(tool.modelOutput?{modelOutput:freeze({...tool.modelOutput})}:{})}));
    const runId = randomUUID(), started = Date.now(), controller = new AbortController();
    const zero: Usage = {modelCalls: 0, toolCalls: 0, outputTokens: 0, resourceUnits: 0, activeMs: 0};
    let lease: BudgetLease | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const physical = new Set<Promise<unknown>>();
    let sessionBinding: SessionBinding | undefined;
    let lastOutcome: Readonly<ModelOutcome> | undefined;
    const toolOutcomes: ToolOutcome[] = [];
    const toolAdmissions: Readonly<import('./types.ts').ToolAdmissionFact>[] = [];
    const attemptFacts = new Map<string,Readonly<ModelAttemptFact>>();
    const outcomeFields = () => ({...(options.modelObservations && lastOutcome ? {modelOutcome:lastOutcome} : {}),...(options.modelAttempts?{modelAttempts:Object.freeze([...attemptFacts.values()])}:{}),...(toolOutcomes.length?{toolOutcomes:Object.freeze(toolOutcomes.map(safeToolOutcome))}:{}),...(toolAdmissions.length?{toolAdmissions:Object.freeze([...toolAdmissions])}:{})});
    let sequence = 0, fault: RuntimeFault | undefined;
    let auditTail: Promise<void> = Promise.resolve();
    let candidateIndex = 0, attempt = 0;
    const current = () => candidates[candidateIndex]!;
    const assertOpen = () => {if (fault) throw fault; if (controller.signal.aborted) throw new RuntimeFault('CANCELLED');};
    const stop = (reason: 'CANCELLED' | 'DEADLINE_EXCEEDED') => {fault ??= new RuntimeFault(reason); controller.abort();};
    const cancel = () => stop('CANCELLED');
    input.signal?.addEventListener('abort', cancel, {once: true});
    if (input.signal?.aborted) cancel();
    const snapshot = (): Usage => {
      try {
        if (!lease) throw new RuntimeFault('STATE_FAILED');
        const value = {...lease.snapshot()};
        for (const key of ['modelCalls','toolCalls','outputTokens','resourceUnits','activeMs'] as const)
          if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new RuntimeFault('STATE_FAILED');
        if (protection && (!Number.isSafeInteger(value.inputTokens) || value.inputTokens! < 0 ||
          !Number.isSafeInteger(value.reservedOutputTokens) || value.reservedOutputTokens! < 0 ||
          value.reservedOutputTokens! > value.outputTokens)) throw new RuntimeFault('STATE_FAILED');
        return value;
      } catch {throw new RuntimeFault('STATE_FAILED');}
    };
    const usage = () => {const value = snapshot(); return {...value, activeMs: value.activeMs + Date.now() - started};};
    const notSentOutcome = (error:ContextAdmissionFailure):Readonly<ModelOutcome> => safeOutcome({model:error.admission.model,stop:'unknown',category:'context',physicalStatus:'not-sent',usageFinal:true,usage:{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}},diagnostic:'CONTEXT_LIMIT'});
    const failed = (error: unknown): RunResult<T> => {
      if(options.modelObservations && error instanceof ContextAdmissionFailure)lastOutcome=notSentOutcome(error);
      const reason = fault?.reason ?? reasonOf(error);
      let observed = {...zero}, known = false;
      try {observed = usage(); known = true;} catch { /* Unavailable history is not zero consumption. */ }
      return {taskId: request.taskId, runId, status: reason === 'CANCELLED' ? 'cancelled' :
        ['AUTHORITY_REQUIRED', 'TASK_BUSY', 'CONFIGURATION_CHANGED', 'BUDGET_EXHAUSTED'].includes(reason) ? 'blocked' : 'failed', reason, usage: observed, usageKnown: known, ...outcomeFields()};
    };
    async function controlled<V>(operation:()=>Promise<V>):Promise<V> {
      const deadline=protection ? setTimeout(()=>stop('DEADLINE_EXCEEDED'),protection.controlTimeoutMs) : undefined;
      try{return await operation();}finally{clearTimeout(deadline);}
    }
    async function append(kind: AuditEvent['kind'], extra: Partial<AuditEvent> = {}, terminal = false) {
      if (!terminal) assertOpen();
      const event: AuditEvent = Object.freeze({version: '1.0', taskId: request.taskId, runId, sequence: ++sequence, kind, at: new Date().toISOString(),
        provider: current().model.provider, model: current().model.id, contextVersions: Object.freeze({...request.contextVersions}),
        ...(routed || request.modelRecovery ? {attempt} : {}), ...(sessionBinding ? {session: sessionBinding} : {}), ...extra});
      // Parallel tools still present one ordered append stream to the host sink.
      const pending = auditTail.then(async () => {
        if (!terminal) assertOpen();
        try {await controlled(()=>options.audit.append(event, controller.signal));} catch {fault ??= new RuntimeFault('AUDIT_FAILED'); throw fault;}
      });
      auditTail = pending.catch(() => {});
      await pending;
      if (!terminal) assertOpen();
      try {Promise.resolve(options.onEvent?.(event)).catch(() => {});} catch {/* Observation cannot grant authority or block execution. */}
    }
    async function authorize(action: Parameters<RuntimeOptions['authorize']>[0]) {
      assertOpen();
      try {if (!await controlled(()=>options.authorize({...action, ...(sessionBinding ? {session: sessionBinding} : {})}, controller.signal))) throw new RuntimeFault('AUTHORITY_REQUIRED');}
      catch {fault ??= new RuntimeFault('AUTHORITY_REQUIRED'); throw fault;}
      assertOpen();
    }
    async function effect<V>(operation: () => Promise<V>): Promise<V> {
      assertOpen();
      const pending = Promise.resolve().then(() => {assertOpen(); return operation();});
      physical.add(pending);
      try {const value = await pending; assertOpen(); return value;} finally {physical.delete(pending);}
    }
    async function state<V>(operation: () => Promise<V>, checkSnapshot = true): Promise<V> {
      try {const result = await controlled(operation); if (lease && checkSnapshot) snapshot(); return result;} catch (error) {throw error instanceof RuntimeFault ? error : new RuntimeFault('STATE_FAILED');}
    }
    const work = (async (): Promise<RunResult<T>> => {try {
      assertOpen();
      if (options.modelObservations !== undefined && options.modelObservations !== 'v1') throw new RuntimeFault('INVALID_REQUEST');
      if(options.modelAttempts!==undefined && (options.modelAttempts!=='v1'||options.modelObservations!=='v1'))throw new RuntimeFault('INVALID_REQUEST');
      if(options.toolFeedback!==undefined){
        if(!('sessionId' in request))throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
        const policy=options.toolFeedback,label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\r\n\u0000]/.test(v);
        if(!isJson(policy)||!policy||!label(policy.policyVersion)||!Array.isArray(policy.tools)||!policy.tools.length||
          policy.tools.some(name=>!label(name))||new Set(policy.tools).size!==policy.tools.length||Object.keys(policy).some(k=>!['policyVersion','tools'].includes(k))||
          Buffer.byteLength(JSON.stringify(policy))>1_048_576)throw new RuntimeFault('INVALID_REQUEST');
      }
      if (mode === 'agent') validateCheckpoint(request as AgentRequest);
      else if ((input as AgentRequest).checkpoint || (input as AgentRequest).saveCheckpoint || (input as AgentRequest).shouldYield) throw new RuntimeFault('INVALID_REQUEST');
      if (purposes) {
        const ids = new Set<string>();
        if (!purpose || purpose.mode !== mode || !purposes.length ||
          (input.toolExecution !== undefined && input.toolExecution !== purpose.toolExecution) ||
          (input.thinkingLevel !== undefined && input.thinkingLevel !== purpose.thinkingLevel) ||
          digest(definitions(inputTools)) !== digest(definitions(purpose.tools))) throw new RuntimeFault('INVALID_REQUEST');
        for (const declared of purposes) {
          if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(declared.id) || ids.has(declared.id) ||
            !['worker','text','agent'].includes(declared.mode) || (declared.mode !== 'agent' && declared.tools.length)) throw new RuntimeFault('INVALID_REQUEST');
          ids.add(declared.id);
          const routeIds = new Set<string>();
          for (const c of [{model: declared.model, transport: declared.transport}, ...(declared.fallbacks ?? [])]) {
            const {toolExecution: _execution, thinkingLevel: _thinking, ...base} = request;
            validateRequest(c.model, {...base,
              ...(declared.toolExecution === undefined ? {} : {toolExecution: declared.toolExecution}),
              ...(declared.thinkingLevel === undefined ? {} : {thinkingLevel: declared.thinkingLevel})}, declared.tools);
            const cap = c.model.maxOutputTokens;
            if (typeof c.transport !== 'function' || ((declared.fallbacks?.length ?? 0) > 0 && cap === undefined) ||
              (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1 || cap > c.model.contextWindow)) || routeIds.has(digest(c.model))) throw new RuntimeFault('INVALID_REQUEST');
            routeIds.add(digest(c.model));
          }
        }
      } else if (input.purpose !== undefined) throw new RuntimeFault('INVALID_REQUEST');
      const identities = new Set<string>();
      for (const candidate of candidates) {
        validateRequest(candidate.model, request, tools);
        const cap = candidate.model.maxOutputTokens;
        if ((routed && cap === undefined) || (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1 || cap > candidate.model.contextWindow)) ||
          typeof candidate.transport !== 'function') throw new RuntimeFault('INVALID_REQUEST');
        const identity = digest(candidate.model);
        if (identities.has(identity)) throw new RuntimeFault('INVALID_REQUEST');
        identities.add(identity);
      }
      if (!uncapped(request.limits)) timer = setTimeout(() => stop('DEADLINE_EXCEEDED'), request.limits.wallTimeMs);
      const configuration = purposePlan ? {purposes: purposePlan, limits: request.limits} : {...(routed ? {route: candidates.map(c => c.model)} : {model}), limits: request.limits,
        ...(request.toolExecution === undefined ? {} : {toolExecution: request.toolExecution}),
        ...(request.thinkingLevel === undefined ? {} : {thinkingLevel: request.thinkingLevel}),
        tools: tools.map(({execute: _execute, ...definition}) => definition)};
      const protectedConfiguration = {...configuration, ...(options.contextAdmission ? {contextAdmission:options.contextAdmission} : {}), ...(options.modelObservations ? {modelObservations:options.modelObservations} : {}),
        ...(options.modelAttempts?{modelAttempts:options.modelAttempts}:{}), ...(options.toolFeedback?{toolFeedback:options.toolFeedback}:{}),
        ...(options.toolAdmission ? {toolAdmission:{policyVersion:options.toolAdmission.policyVersion,correctionLimit:options.toolAdmission.correctionLimit}} : {})};
      const signature=digest({...protectedConfiguration,...(request.modelRecovery ? {modelRecovery:request.modelRecovery} : {})});
      const configurationId=configurationExtension===undefined ? signature : digest({configuration:{...protectedConfiguration,...(request.modelRecovery ? {modelRecovery:request.modelRecovery} : {})},extension:configurationExtension});
      if(uncapped(request.limits)) {
        if(!budgets.claimUncapped)throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
        const limits=request.limits;
        lease=await state(()=>budgets.claimUncapped!(request.taskId,runId,configurationId,limits));
        if(!lease.reserveModelUpTo || typeof (lease as UncappedBudgetLease).settleModelUsage!=='function')throw new RuntimeFault('STATE_FAILED');
        snapshot();
      } else {const limits=request.limits;lease = await state(() => budgets.claim(request.taskId, runId, configurationId, limits));}
      if (options.modelObservations && typeof lease!.recordModelUsage !== 'function') throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
      assertOpen();
      clearTimeout(timer);
      if(!uncapped(request.limits)) timer = setTimeout(() => stop('DEADLINE_EXCEEDED'), Math.max(0, request.limits.wallTimeMs - snapshot().activeMs - (Date.now() - started)));
      await append('run.started');
      const recoveryAttempts = new Map<string, {extraAttempts:number; nativeRecovery:boolean; physicalRecoveries?:number}>();
      const failedAttempts = new Map<string,Readonly<ModelAttempt>>();
      const text = await driver(current().model, request, async (initialRequest, call, beforeAttempt) => {
        if ((call?.recovered && !recoveryAttempts.get(call.id)?.nativeRecovery) ||
          (call?.recoveryParentId && !recoveryAttempts.get(call.recoveryParentId)?.nativeRecovery)) throw new RuntimeFault('STATE_FAILED');
        const allowance = call ? recoveryAttempts.get(call.id) ?? {extraAttempts:0,nativeRecovery:false} : {extraAttempts:0,nativeRecovery:false};
        if ((call?.nativeAttempt ?? 1) > 1) {
          if (allowance.nativeRecovery) throw new RuntimeFault('MODEL_FAILED');
          allowance.extraAttempts++;
        }
        if (call) recoveryAttempts.set(call.id, allowance);
        let fallback: {parent:Readonly<ModelAttempt>; reason:'same-model'|'fallback'}|undefined;
        for (;;) {
          const candidate = current();
          const correlation=call?.correlation;
          let reference:Readonly<ModelAttempt>|undefined;
          if(options.modelAttempts){
            if(!correlation)throw new RuntimeFault('STATE_FAILED');
            const parent=fallback?.parent??(correlation.recovery?failedAttempts.get(correlation.parentId??correlation.scopeId):undefined);
            if(correlation.recovery&&!parent)throw new RuntimeFault('STATE_FAILED');
            const identity={version:'1' as const,logicalRequestId:correlation.logicalId,physicalAttemptId:randomUUID(),source:correlation.source};
            reference=freeze(parent?{...identity,kind:'recovery',recovery:{logicalRequestId:parent.logicalRequestId,physicalAttemptId:parent.physicalAttemptId,reason:fallback?.reason??correlation.recovery!}}:{...identity,kind:'initial'});
          }
          let dispatched=false,reservation:number|undefined,outcomeRecorded=false,finished=false;
          const unknownOutcome=()=>safeOutcome({model:candidate.model,stop:'unknown',physicalStatus:'unknown',usageFinal:false,usage:{inputTokens:{kind:'unknown'},outputTokens:{kind:'unknown'}},diagnostic:'UNKNOWN'});
          if(reference)lastOutcome=unknownOutcome();
          const appendAttempt=async(kind:'model.admitted'|'model.finished',extra:Partial<AuditEvent>={},terminal=false,late=false)=>{
            if(!reference)return append(kind,extra,terminal);
            if(kind==='model.finished' && finished && !late)return;
            const observed=safeOutcome(extra.modelOutcome??lastOutcome??unknownOutcome());
            const fact:Readonly<ModelAttemptFact>=freeze({version:'1',attempt:reference,outcome:observed,terminal:kind==='model.finished',late,...(extra.reason?{reason:extra.reason}:{})});
            await append(kind,{...extra,modelAttempt:reference,modelAttemptFact:fact,modelOutcome:observed},terminal);
            attemptFacts.set(reference.physicalAttemptId,fact);
            if(kind==='model.finished'){
              finished=true;
              if(extra.reason || ['error','length','cancelled','unknown'].includes(observed.stop)){
                failedAttempts.set(correlation!.scopeId,reference);
                if(call)failedAttempts.set(call.id,reference);
              }
            }
          };
          try {
          assertOpen();
          snapshot();
          if(reference?.kind==='recovery'){
            const scope=correlation!.parentId??correlation!.scopeId;
            const original=recoveryAttempts.get(scope)??{extraAttempts:0,nativeRecovery:false};
            const used=original.physicalRecoveries??0;
            if(used>=1)throw new RuntimeFault('MODEL_FAILED');
            original.physicalRecoveries=used+1;recoveryAttempts.set(scope,original);
          }
          const maximum = Math.min(initialRequest.maxOutputTokens, candidate.model.maxOutputTokens ?? outputCap(request.limits),
            uncapped(request.limits) ? outputCap(request.limits) : request.limits.outputTokens - snapshot().outputTokens);
          if (maximum < 1) throw new RuntimeFault('BUDGET_EXHAUSTED');
          if (request.thinkingLevel && request.thinkingLevel !== 'off' && candidate.model.protocol === 'anthropic-messages' && maximum < 2048)
            throw new RuntimeFault('BUDGET_EXHAUSTED');
          if (initialRequest.messages.some(m => m.images?.length) && !candidate.model.input?.includes('image')) throw new RuntimeFault('INVALID_REQUEST');
          const modelRequest = freeze({...initialRequest, model: candidate.model, maxOutputTokens: maximum});
          if (options.contextAdmission) admitModelRequest(modelRequest, options.contextAdmission);
          await authorize({kind: 'model', taskId: request.taskId, runId, request: modelRequest,...(reference?{modelAttempt:reference}:{})});
          // The native step also covers SDK fallback/retry attempts. Reconfirm
          // its view after authorization and before another reservation/dispatch.
          if(beforeAttempt)await beforeAttempt();
          const capped = uncapped(request.limits) || routed || candidate.model.maxOutputTokens !== undefined || maximum < request.limits.outputTokens - snapshot().outputTokens;
          if (capped && !lease!.reserveModelUpTo) throw new RuntimeFault('INVALID_REQUEST');
          const reserved = await state(() => capped ? lease!.reserveModelUpTo!(maximum) : lease!.reserveModel());
          reservation=reserved;
          if (reserved !== maximum) throw new RuntimeFault('STATE_FAILED');
          attempt++;
          await appendAttempt('model.admitted', {digest: digest(modelRequest.messages)});
          let reply: ModelReply;
          if (options.modelObservations) lastOutcome=safeOutcome({model:{provider:candidate.model.provider,id:candidate.model.id,protocol:candidate.model.protocol},stop:'unknown',physicalStatus:'unknown',usageFinal:false,usage:{inputTokens:{kind:'unknown'},outputTokens:{kind:'unknown'}},diagnostic:'UNKNOWN'});
          const recordOutcome = async (outcome:Readonly<ModelOutcome>, late=false) => {
            if(outcomeRecorded)return;outcomeRecorded=true;
            if(reference && outcome.physicalStatus==='not-sent' && (!outcome.usageFinal ||
              outcome.usage.inputTokens.kind!=='known' || outcome.usage.inputTokens.value!==0 ||
              outcome.usage.outputTokens.kind!=='known' || outcome.usage.outputTokens.value!==0)){
              // Contradictory/partial zero proof cannot refund or authorize another attempt.
              outcome={...outcome,stop:'error',category:'unknown',physicalStatus:'unknown',usageFinal:false,diagnostic:'UNKNOWN'};
            }
            lastOutcome=safeOutcome(outcome);
            await state(()=>lease!.recordModelUsage!(reserved,{
              ...(outcome.usage.inputTokens.kind==='known'?{inputTokens:outcome.usage.inputTokens.value}:outcome.usage.inputTokens.reported===undefined?{}:{inputTokens:outcome.usage.inputTokens.reported}),
              ...(outcome.usage.outputTokens.kind==='known'?{outputTokens:outcome.usage.outputTokens.value}:outcome.usage.outputTokens.reported===undefined?{}:{outputTokens:outcome.usage.outputTokens.reported}),
              final:!late && outcome.usageFinal && outcome.physicalStatus!=='unknown' && outcome.usage.outputTokens.kind==='known',
            }));
          };
          const replyOutcome = (reply:ModelReply):Readonly<ModelOutcome> => safeOutcome(reply.outcome ?? lastOutcome!);
          const lateOutcome = async (outcome:Readonly<ModelOutcome>) => {
            await recordOutcome(outcome,true);
            await appendAttempt('model.finished',{reason:fault?.reason??'DEADLINE_EXCEEDED',modelOutcome:lastOutcome!},true,true);
          };
          // Reservation/audit IO can yield to host state changes. A rejection
          // here is proven not sent; settle zero without inventing UNKNOWN or retry.
          if(beforeAttempt)try {await beforeAttempt();}
          catch (error) {
            if(options.modelObservations)await recordOutcome(safeOutcome({model:candidate.model,stop:'error',category:'invalid-request',physicalStatus:'not-sent',usageFinal:true,usage:{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}},diagnostic:'REQUEST_FAILED'}));
            else await state(()=>protection ? (lease as UncappedBudgetLease).settleModelUsage(reserved,{inputTokens:0,outputTokens:0}) : lease!.settleModel(reserved,0));
            await appendAttempt('model.finished',{reason:reasonOf(error),...(options.modelObservations?{modelOutcome:lastOutcome!}:{})},controller.signal.aborted);
            throw error;
          }
          try {
            reply = freeze(structuredClone(await effect(async () => {
              const attemptController=new AbortController();let expired=false,settled=false;
              const deadline=protection ? setTimeout(()=>{expired=true;attemptController.abort();setImmediate(()=>{if(!settled)stop('DEADLINE_EXCEEDED');});},protection.modelTimeoutMs) : undefined;
              try {
                if(reference){
                  if(modelRequest.signal.aborted || attemptController.signal.aborted)throw new RuntimeFault('CANCELLED');
                }
                dispatched=true;const result=await candidate.transport({...modelRequest,maxOutputTokens:reserved,signal:AbortSignal.any([modelRequest.signal,controller.signal,attemptController.signal])});
                if(options.modelObservations && (expired||fault||controller.signal.aborted))await lateOutcome(replyOutcome(result));
                if(expired)throw new RuntimeFault('DEADLINE_EXCEEDED');return result;
              } catch(error){
                if(options.modelObservations && !outcomeRecorded && (expired||fault||controller.signal.aborted)){
                  const observed=(error instanceof ModelFailure||error instanceof ProviderFailure)?error.outcome:undefined;
                  await lateOutcome(observed??lastOutcome!);
                }
                if(expired)throw new RuntimeFault('DEADLINE_EXCEEDED');throw error;}
              finally{settled=true;clearTimeout(deadline);}
            })));
          } catch (error) {
            assertOpen();
            if(reference && !dispatched)throw error;
            const observed = (error instanceof ModelFailure || error instanceof ProviderFailure) ? error.outcome : undefined;
            if (options.modelObservations && observed) {
              await recordOutcome(observed);
              await appendAttempt('model.finished', {reason:reasonOf(error),...(error instanceof ProviderFailure?{failureCategory:error.category}:{}),...(options.modelObservations && lastOutcome?{modelOutcome:lastOutcome}:{})});
              if (observed.physicalStatus === 'unknown' || reference && lastOutcome!.physicalStatus==='unknown') throw error;
            }
            if (error instanceof ContextAdmissionFailure) {
              // The trusted final guard must run before host physical dispatch.
              // A denied projection is known not sent; it is not an unknown Provider failure.
              if(options.modelObservations)await recordOutcome(notSentOutcome(error));
              else await state(() => protection ? (lease as UncappedBudgetLease).settleModelUsage(reserved, {inputTokens:0,outputTokens:0}) : lease!.settleModel(reserved, 0));
              await appendAttempt('model.finished', {reason:'INVALID_REQUEST',...(options.modelObservations && lastOutcome?{modelOutcome:lastOutcome}:{})});
              throw error;
            }
            if(options.modelObservations && !observed){
              await appendAttempt('model.finished',{reason:reasonOf(error),modelOutcome:lastOutcome!});
              throw new ModelFailure(lastOutcome!,reasonOf(error)); // No confirmed physical state: stop native retry as well as fallback.
            }
            const timedOut=error instanceof RuntimeFault && error.reason==='DEADLINE_EXCEEDED';
            if (!timedOut && (!(error instanceof ProviderFailure) || !['quota','rate-limit','unavailable','network'].includes(error.category))) {
              if(options.modelObservations && !observed)await appendAttempt('model.finished',{reason:reasonOf(error),modelOutcome:lastOutcome!});
              throw error;
            }
            if (!(options.modelObservations && observed)) await appendAttempt('model.finished', {reason: timedOut?'DEADLINE_EXCEEDED':'MODEL_FAILED', ...(!timedOut ? {failureCategory:(error as ProviderFailure).category}: {}),...(options.modelObservations && lastOutcome?{modelOutcome:lastOutcome}:{})});
            const beforeFallback=candidateIndex;
            if(request.modelRecovery) {
              if(allowance.extraAttempts>=request.modelRecovery.extraAttempts)throw error;
              if(candidateIndex+1<candidates.length)candidateIndex++;
              else if(error instanceof ProviderFailure && error.category==='quota')throw error;
              allowance.extraAttempts++;
            } else {if(timedOut || allowance.nativeRecovery || candidateIndex+1>=candidates.length)throw error;candidateIndex++;allowance.extraAttempts++;}
            if(reference)fallback={parent:reference,reason:candidateIndex===beforeFallback?'same-model':'fallback'};
            continue; // Failed unknown usage keeps its reservation; tools are not restarted.
          }
          if (options.modelObservations) {
            if(!reply.outcome){await recordOutcome(lastOutcome!);await appendAttempt('model.finished',{reason:'INVALID_OUTPUT',modelOutcome:lastOutcome!});throw new ModelFailure(lastOutcome!,'INVALID_OUTPUT');}
            if (reply.outcome) {
              const observed=safeOutcome(reply.outcome);
              if ((observed.usage.inputTokens.kind==='known' && observed.usage.inputTokens.value!==reply.usage.inputTokens) ||
                (observed.usage.outputTokens.kind==='known' && observed.usage.outputTokens.value!==reply.usage.outputTokens)) throw new RuntimeFault('INVALID_OUTPUT');
            }
            const observed = replyOutcome(reply);
            // Preserve confirmed consumption even when the returned content is invalid.
            await recordOutcome(observed);
            if(reference && lastOutcome!.physicalStatus==='unknown'){
              await appendAttempt('model.finished',{reason:'MODEL_FAILED',modelOutcome:lastOutcome!});
              throw new ModelFailure(lastOutcome!);
            }
          }
          try{validateReply(reply);}catch(error){
            if(options.modelObservations)await appendAttempt('model.finished',{reason:'INVALID_OUTPUT',modelOutcome:lastOutcome!});
            throw error;
          }
          if (reply.stop === 'deferred') {if (!candidate.model.deferred || routed || reference) throw new RuntimeFault('CAPABILITY_UNAVAILABLE'); await appendAttempt('model.finished'); return reply;}
          if (!options.modelObservations) await state(() => protection ? (lease as UncappedBudgetLease).settleModelUsage(reserved,reply.usage) : lease!.settleModel(reserved, reply.usage.outputTokens));
          assertOpen(); await appendAttempt('model.finished', options.modelObservations && lastOutcome?{modelOutcome:lastOutcome}:{});
          if (reply.usage.outputTokens > reserved) throw new RuntimeFault('BUDGET_EXHAUSTED');
          return reply;
          }catch(error){
            if(reference && !finished){
              if(!dispatched){
                lastOutcome=error instanceof ContextAdmissionFailure?notSentOutcome(error):safeOutcome({model:candidate.model,stop:controller.signal.aborted?'cancelled':'error',physicalStatus:'not-sent',usageFinal:true,
                  usage:{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}},diagnostic:controller.signal.aborted?'CANCELLED':'REQUEST_FAILED'});
                if(reservation!==undefined && !outcomeRecorded){
                  await state(()=>lease!.recordModelUsage!(reservation!,{inputTokens:0,outputTokens:0,final:true}));outcomeRecorded=true;
                }
              }
              await appendAttempt('model.finished',{reason:reasonOf(error),modelOutcome:lastOutcome??unknownOutcome()},true);
            }
            throw error;
          }
        }
      }, controller.signal, tools.map(tool => ({...tool, execute: async (args, signal, invocation): Promise<JsonValue> => {
        try {
        freeze(args);
        freeze(invocation);
        const identity = invocation ? {sessionId:invocation.sessionId,branch:invocation.branch,operationId:invocation.operationId,invocationId:invocation.invocationId,toolCallId:invocation.toolCallId} : undefined;
        snapshot();
        await authorize({kind: 'tool', taskId: request.taskId, runId, name: tool.name, effect: tool.effect, arguments: args, ...(identity ? {invocation:identity} : {})});
        await state(() => lease!.reserveTool(tool.resourceUnits));
        await append('tool.admitted', {toolName: tool.name, digest: digest(args), ...(identity ? {invocation:identity} : {})});
        const observe = !!(options.modelObservations || tool.modelOutput || options.toolFeedback);
        const outcome: ToolOutcome={name:tool.name,effect:tool.effect,status:'unknown',modelOutput:'pending',resourceUnits:tool.resourceUnits,...(identity?{invocation:identity}:{})};
        if(observe)toolOutcomes.push(outcome);
        let value: JsonValue;
        try {value = await effect(async () => {
          const deadline=protection ? setTimeout(()=>stop('DEADLINE_EXCEEDED'),protection.toolTimeoutMs) : undefined;
          try{const result=await tool.execute(args,signal,invocation);outcome.status='completed';return result;}finally{clearTimeout(deadline);}
        });} catch (error) {
          const matched=error instanceof ToolOutputFailure && error.outcome.name===tool.name && error.outcome.effect===tool.effect && error.outcome.resourceUnits===tool.resourceUnits && digest(error.outcome.invocation??null)===digest(identity??null);
          if(matched)Object.assign(outcome,error.outcome);
          const category = executionFailureCategory(error);
          if(category!==undefined)outcome.failureCategory=category;
          outcome.modelOutput='failed';outcome.reason=fault?.reason??reasonOf(error,'TOOL_FAILED');
          if(observe && fault?.reason!=='AUDIT_FAILED')await append('tool.finished',{toolName:tool.name,toolFailed:true,toolOutcome:safeToolOutcome(outcome),...(identity?{invocation:identity}:{})},controller.signal.aborted);
          const feedback=matched?trustedToolFeedback(error):undefined;
          if(feedback && invocation && options.toolFeedback?.tools.includes(tool.name) && tool.effect==='read'){
            assertOpen();throw new AcceptedToolFeedback(feedback);
          }
          fault ??= new RuntimeFault(reasonOf(error,'TOOL_FAILED')); throw fault;
        }
        try {
          assertOpen();
          if(!isJson(value))throw new RuntimeFault('TOOL_FAILED');
          if(tool.modelOutput?.project) {
            const projected=await effect(async()=>{const result=await controlled(()=>tool.modelOutput!.project!({value,signal,...(invocation?{invocation}:{})}));
              if(result.receiptId!==undefined){safeToolOutcome({...outcome,receiptId:result.receiptId});outcome.receiptId=result.receiptId;}return result;});
            value=projected.value;
          }
          if (!isJson(value) || Buffer.byteLength(JSON.stringify(value)) > (tool.modelOutput?.maxBytes ?? 1_048_576)) {
            outcome.modelOutput='rejected';throw new RuntimeFault('TOOL_FAILED');
          }
          const captured = freeze(structuredClone(value));outcome.modelOutput='ready';
          await append('tool.finished', {toolName: tool.name, digest: digest(captured), ...(identity ? {invocation:identity} : {}),...(observe?{toolOutcome:safeToolOutcome(outcome)}:{})}); return captured;
        } catch(error) {
          if(error instanceof ToolOutputFailure && error.outcome.name===tool.name && error.outcome.effect===tool.effect && error.outcome.resourceUnits===tool.resourceUnits && digest(error.outcome.invocation??null)===digest(identity??null))Object.assign(outcome,error.outcome,{status:outcome.status==='completed'?'completed':error.outcome.status});
          if(outcome.modelOutput!=='rejected')outcome.modelOutput='failed';
          outcome.reason=reasonOf(error,'TOOL_FAILED');
          if(observe && fault?.reason!=='AUDIT_FAILED')await append('tool.finished',{toolName:tool.name,toolFailed:true,toolOutcome:safeToolOutcome(outcome),...(identity?{invocation:identity}:{})},controller.signal.aborted);
          throw observe ? new ToolOutputFailure(outcome,outcome.reason) : new RuntimeFault(outcome.reason);
        }
        } catch (error) {if(error instanceof AcceptedToolFeedback)throw error;fault ??= error instanceof RuntimeFault ? error : new RuntimeFault('TOOL_FAILED'); throw fault;}
      }})), () => current().model, binding => {sessionBinding = Object.freeze({...binding});}, async command => {
        await authorize({kind: 'control', taskId: request.taskId, runId, command});
        await append('session.control', {digest: digest(command)});
      }, controlled, {mode, runId,...(options.toolFeedback?{toolFeedback:true}:{}),...(options.modelAttempts?{modelAttempts:options.modelAttempts}:{}),hasConsumption:()=>{const value=snapshot();return value.modelCalls>0||value.toolCalls>0;}, ...(options.toolAdmission ? {toolAdmission:options.toolAdmission,recordAdmission:async (fact:import('./types.ts').ToolAdmissionFact)=>{
        const captured=safeAdmissionFact(fact);toolAdmissions.push(captured);
        await append('tool.prepared',{toolName:captured.name,toolAdmission:captured});
      }} : {}), claimRecovery: id => {
        const allowance = recoveryAttempts.get(id);
        if (!allowance || allowance.extraAttempts >= (request.modelRecovery?.extraAttempts ?? 1)) return false;
        allowance.extraAttempts++;
        allowance.nativeRecovery = true;
        return true;
      }});
      assertOpen();
      if (typeof text !== 'string' && 'suspended' in text) {
        await authorize({kind:'publish',taskId:request.taskId,runId});
        await append('run.finished',{reason:'DEFERRED'});
        return {taskId:request.taskId,runId,status:'suspended',reason:'DEFERRED',session:text.suspended,usage:usage(),usageKnown:true,...outcomeFields()};
      }
      if (typeof text !== 'string') {
        await authorize({kind: 'publish', taskId: request.taskId, runId});
        await append('run.finished', {reason: 'BUSINESS_WAIT'});
        assertOpen();
        return {taskId: request.taskId, runId, status: 'waiting', reason: 'BUSINESS_WAIT', checkpoint: structuredClone(text.waiting), usage: usage(), usageKnown: true, ...outcomeFields()};
      }
      let value: T;
      try {value = convert(text);} catch {throw new RuntimeFault('INVALID_OUTPUT');}
      await authorize({kind: 'publish', taskId: request.taskId, runId});
      await append('run.finished');
      assertOpen();
      return {taskId: request.taskId, runId, status: 'succeeded', value, usage: usage(), usageKnown: true, ...outcomeFields()};
    } catch (error) {
      const result = failed(error);
      if (lease && !controller.signal.aborted && result.status !== 'succeeded' && result.reason !== 'AUDIT_FAILED') {
        try {await append('run.finished', {reason: result.reason}, true);} catch {return failed(error);}
      }
      return result;
    } finally {
      await Promise.allSettled([...physical]);
      if (lease) await state(() => lease!.release(Date.now() - started), false);
    }})();
    const completion = work.then(() => {}, () => {});
    // Never replace the owner's pending handle with a competing rejected claim.
    if (!idle.has(request.taskId)) {
      idle.set(request.taskId, completion);
      void completion.then(() => {if (idle.get(request.taskId) === completion) idle.delete(request.taskId);});
    }
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<RunResult<T>>(resolve => {
      abortListener = () => resolve(failed(fault));
      controller.signal.addEventListener('abort', abortListener, {once: true});
      if (controller.signal.aborted) abortListener();
    });
    try {return await Promise.race([work, aborted]);} catch (error) {return failed(error);}
    finally {clearTimeout(timer); input.signal?.removeEventListener('abort', cancel); if (abortListener) controller.signal.removeEventListener('abort', abortListener);}
  }
  return {
    runWorker: request => run('worker', request, [], text => request.validate(JSON.parse(text))),
    runText: request => run('text', request, [], text => {
      const value = request.validate ? request.validate(text) : text;
      if (typeof value !== 'string') throw new RuntimeFault('INVALID_OUTPUT');
      return value;
    }),
    runAgent: (request: AgentRequest) => run('agent', request, request.tools, text => text),
    waitForIdle: async taskId => {await idle.get(taskId);},
  };
}
