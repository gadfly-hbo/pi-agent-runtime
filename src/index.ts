import {createHash, randomUUID} from 'node:crypto';
import {drive, createSessionBackend} from './pi-adapter.ts';
import {reasonOf, RuntimeFault, ProviderFailure} from './errors.ts';
import {uncapped,outputCap} from './policy.ts';
import {createMemoryBudgetStore} from './budget.ts';
import {freeze, isJson, validateReply, validateRequest, validateCheckpoint} from './validation.ts';
import type {AgentRequest, AuditEvent, BaseRequest, BudgetLease, JsonValue, ModelReply, RunResult, Runtime, RuntimeOptions, Tool, Usage, PurposeConfig, SessionRuntimeOptions, SessionRuntime, SessionBinding, UncappedBudgetLease} from './types.ts';
export type * from './types.ts';
export {createMemoryBudgetStore};
export {createPiTransport, createProxyTransport, createExecutionTools, loadHarnessResources} from './pi-adapter.ts';
export {createLocalExecutionEnvironment} from './execution.ts';
export {RuntimeFault, ProviderFailure} from './errors.ts';

export function createRuntime(options: RuntimeOptions): Runtime {
  return guardedRuntime(options, drive);
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  options = {...options, harness: freeze(structuredClone(options.harness ?? {})), ...(options.extensions ? {extensions:{...options.extensions, ...(options.extensions.customEntryTypes ? {customEntryTypes:[...options.extensions.customEntryTypes]} : {})}} : {})};
  const backend = createSessionBackend(options);
  const runtime = guardedRuntime(options, (...args) => 'sessionId' in args[1] ? backend.drive(...args) : drive(...args),
    {sessionPolicy: options.storage.policyVersion, harness: options.harness});
  return {...runtime, ...backend.sessions, run: request => {const input = {...request, sessionId: request.sessionId}; return runtime.runAgent(input);}};
}

function guardedRuntime(options: RuntimeOptions, driver: typeof drive, configurationExtension?: unknown): Runtime {
  options = {...options};
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
    const tools = (purpose?.tools ?? inputTools).map(tool => ({...tool, parameters: structuredClone(tool.parameters)}));
    const runId = randomUUID(), started = Date.now(), controller = new AbortController();
    const zero: Usage = {modelCalls: 0, toolCalls: 0, outputTokens: 0, resourceUnits: 0, activeMs: 0};
    let lease: BudgetLease | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const physical = new Set<Promise<unknown>>();
    let sessionBinding: SessionBinding | undefined;
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
    const failed = (error: unknown): RunResult<T> => {
      const reason = fault?.reason ?? reasonOf(error);
      let observed = {...zero}, known = false;
      try {observed = usage(); known = true;} catch { /* Unavailable history is not zero consumption. */ }
      return {taskId: request.taskId, runId, status: reason === 'CANCELLED' ? 'cancelled' :
        ['AUTHORITY_REQUIRED', 'TASK_BUSY', 'CONFIGURATION_CHANGED', 'BUDGET_EXHAUSTED'].includes(reason) ? 'blocked' : 'failed', reason, usage: observed, usageKnown: known};
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
      const signature=digest({...configuration,...(request.modelRecovery ? {modelRecovery:request.modelRecovery} : {})});
      const configurationId=configurationExtension===undefined ? signature : digest({configuration:{...configuration,...(request.modelRecovery ? {modelRecovery:request.modelRecovery} : {})},extension:configurationExtension});
      if(uncapped(request.limits)) {
        if(!budgets.claimUncapped)throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
        const limits=request.limits;
        lease=await state(()=>budgets.claimUncapped!(request.taskId,runId,configurationId,limits));
        if(!lease.reserveModelUpTo || typeof (lease as UncappedBudgetLease).settleModelUsage!=='function')throw new RuntimeFault('STATE_FAILED');
        snapshot();
      } else {const limits=request.limits;lease = await state(() => budgets.claim(request.taskId, runId, configurationId, limits));}
      assertOpen();
      clearTimeout(timer);
      if(!uncapped(request.limits)) timer = setTimeout(() => stop('DEADLINE_EXCEEDED'), Math.max(0, request.limits.wallTimeMs - snapshot().activeMs - (Date.now() - started)));
      await append('run.started');
      const text = await driver(current().model, request, async initialRequest => {
        let extraAttempts=0;
        for (;;) {
          assertOpen();
          snapshot();
          const candidate = current();
          const maximum = Math.min(initialRequest.maxOutputTokens, candidate.model.maxOutputTokens ?? outputCap(request.limits),
            uncapped(request.limits) ? outputCap(request.limits) : request.limits.outputTokens - snapshot().outputTokens);
          if (maximum < 1) throw new RuntimeFault('BUDGET_EXHAUSTED');
          if (request.thinkingLevel && request.thinkingLevel !== 'off' && candidate.model.protocol === 'anthropic-messages' && maximum < 2048)
            throw new RuntimeFault('BUDGET_EXHAUSTED');
          if (initialRequest.messages.some(m => m.images?.length) && !candidate.model.input?.includes('image')) throw new RuntimeFault('INVALID_REQUEST');
          const modelRequest = freeze({...initialRequest, model: candidate.model, maxOutputTokens: maximum});
          await authorize({kind: 'model', taskId: request.taskId, runId, request: modelRequest});
          const capped = uncapped(request.limits) || routed || candidate.model.maxOutputTokens !== undefined || maximum < request.limits.outputTokens - snapshot().outputTokens;
          if (capped && !lease!.reserveModelUpTo) throw new RuntimeFault('INVALID_REQUEST');
          const reserved = await state(() => capped ? lease!.reserveModelUpTo!(maximum) : lease!.reserveModel());
          if (reserved !== maximum) throw new RuntimeFault('STATE_FAILED');
          attempt++;
          await append('model.admitted', {digest: digest(modelRequest.messages)});
          let reply: ModelReply;
          try {
            reply = freeze(structuredClone(await effect(async () => {
              const attemptController=new AbortController();let expired=false,settled=false;
              const deadline=protection ? setTimeout(()=>{expired=true;attemptController.abort();setImmediate(()=>{if(!settled)stop('DEADLINE_EXCEEDED');});},protection.modelTimeoutMs) : undefined;
              try {const result=await candidate.transport({...modelRequest,maxOutputTokens:reserved,signal:AbortSignal.any([modelRequest.signal,controller.signal,attemptController.signal])});
                if(expired)throw new RuntimeFault('DEADLINE_EXCEEDED');return result;
              } catch(error){if(expired)throw new RuntimeFault('DEADLINE_EXCEEDED');throw error;}
              finally{settled=true;clearTimeout(deadline);}
            })));
          } catch (error) {
            assertOpen();
            const timedOut=error instanceof RuntimeFault && error.reason==='DEADLINE_EXCEEDED';
            if (!timedOut && (!(error instanceof ProviderFailure) || !['quota','rate-limit','unavailable','network'].includes(error.category))) throw error;
            await append('model.finished', {reason: timedOut?'DEADLINE_EXCEEDED':'MODEL_FAILED', ...(!timedOut ? {failureCategory:(error as ProviderFailure).category}: {})});
            if(request.modelRecovery) {
              if(extraAttempts>=request.modelRecovery.extraAttempts)throw error;
              if(candidateIndex+1<candidates.length)candidateIndex++;
              else if(error instanceof ProviderFailure && error.category==='quota')throw error;
              extraAttempts++;
            } else {if(timedOut || candidateIndex+1>=candidates.length)throw error;candidateIndex++;}
            continue; // Failed unknown usage keeps its reservation; tools are not restarted.
          }
          validateReply(reply);
          if (reply.stop === 'deferred') {if (!candidate.model.deferred || routed) throw new RuntimeFault('CAPABILITY_UNAVAILABLE'); await append('model.finished'); return reply;}
          await state(() => protection ? (lease as UncappedBudgetLease).settleModelUsage(reserved,reply.usage) : lease!.settleModel(reserved, reply.usage.outputTokens));
          assertOpen(); await append('model.finished');
          if (reply.usage.outputTokens > reserved) throw new RuntimeFault('BUDGET_EXHAUSTED');
          return reply;
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
        let value: JsonValue;
        try {value = await effect(async () => {
          const deadline=protection ? setTimeout(()=>stop('DEADLINE_EXCEEDED'),protection.toolTimeoutMs) : undefined;
          try{return await tool.execute(args,signal,invocation);}finally{clearTimeout(deadline);}
        });} catch {fault ??= new RuntimeFault('TOOL_FAILED'); throw fault;}
        assertOpen();
        if (!isJson(value) || Buffer.byteLength(JSON.stringify(value)) > 1_048_576) {fault = new RuntimeFault('TOOL_FAILED'); throw fault;}
        const captured = freeze(structuredClone(value));
        await append('tool.finished', {toolName: tool.name, digest: digest(captured), ...(identity ? {invocation:identity} : {})}); return captured;
        } catch (error) {fault ??= error instanceof RuntimeFault ? error : new RuntimeFault('TOOL_FAILED'); throw fault;}
      }})), () => current().model, binding => {sessionBinding = Object.freeze({...binding});}, async command => {
        await authorize({kind: 'control', taskId: request.taskId, runId, command});
        await append('session.control', {digest: digest(command)});
      }, controlled);
      assertOpen();
      if (typeof text !== 'string' && 'suspended' in text) {
        await authorize({kind:'publish',taskId:request.taskId,runId});
        await append('run.finished',{reason:'DEFERRED'});
        return {taskId:request.taskId,runId,status:'suspended',reason:'DEFERRED',session:text.suspended,usage:usage(),usageKnown:true};
      }
      if (typeof text !== 'string') {
        await authorize({kind: 'publish', taskId: request.taskId, runId});
        await append('run.finished', {reason: 'BUSINESS_WAIT'});
        assertOpen();
        return {taskId: request.taskId, runId, status: 'waiting', reason: 'BUSINESS_WAIT', checkpoint: structuredClone(text.waiting), usage: usage(), usageKnown: true};
      }
      let value: T;
      try {value = convert(text);} catch {throw new RuntimeFault('INVALID_OUTPUT');}
      await authorize({kind: 'publish', taskId: request.taskId, runId});
      await append('run.finished');
      assertOpen();
      return {taskId: request.taskId, runId, status: 'succeeded', value, usage: usage(), usageKnown: true};
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
