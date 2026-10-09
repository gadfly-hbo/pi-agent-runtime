// All Pi dependencies and representations stay in this module.
import {Agent, AgentHarness, MemorySessionRepo, BACKGROUND_CONTEXT, withAbortSignal,
  DEFAULT_COMPACTION_SETTINGS, formatSkillsForSystemPrompt, streamProxy, loadSourcedSkills, loadSourcedPromptTemplates, createReadTool, createWriteTool, createEditTool, createBashTool, FileError, ExecutionError, truncateTail, type ExecutionEnv, type Context, type OperationRequest, type AgentLane, type AgentMessage} from '@earendil-works/pi-agent-core';
import {JsonlSessionRepo, laneState, operationMeta, operationResult, operationState, value, type Session, type JsonlSessionMetadata} from '@earendil-works/pi-agent-core/harness/session';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {randomUUID, createHash} from 'node:crypto';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {anthropicMessagesApi} from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import {
  createAssistantMessageEventStream,
  createModels,
  validateToolArguments,
  normalizeContext,
  type DeferredHandle, type Api, type AssistantMessage, type Message, type Model, type TranscriptContext, type TSchema, type Provider,
} from '@earendil-works/pi-ai';
import type {AgentRequest, BaseRequest, ConversationCheckpoint, JsonObject, ModelConfig, ModelContent, ModelMessage, ModelReply, ModelTransport, PiTransportOptions, Tool, SessionRuntimeOptions, SessionRuntime, SessionRunRequest, SessionInfo, SessionBinding, HarnessSettings, HarnessControl, HarnessControlResult, ExecutionEnvironment, ResourceLoadOptions, LoadedResources, DeferredReference, ProxyTransportOptions} from './types.ts';
import {RuntimeFault, ProviderFailure} from './errors.ts';
import {outputCap} from './policy.ts';
import {validateThinking} from './validation.ts';

function toPiContent(content: ModelContent): AssistantMessage['content'][number] {
  if (content.kind === 'text') return {type: 'text', text: content.text};
  if (content.kind === 'tool') return {type: 'toolCall', id: content.id, name: content.name, arguments: content.arguments};
  return {type: 'thinking', thinking: content.text,
    ...(content.signature === undefined ? {} : {thinkingSignature: content.signature}),
    ...(content.redacted === undefined ? {} : {redacted: content.redacted})};
}
function fromPiContent(content: AssistantMessage['content'][number]): ModelContent[] {
  if (content.type === 'text') return [{kind: 'text', text: content.text}];
  if (content.type === 'toolCall') return [{kind: 'tool', id: content.id, name: content.name, arguments: content.arguments as JsonObject}];
  if (content.type === 'thinking') return [{kind: 'reasoning', text: content.thinking,
    ...(content.thinkingSignature === undefined ? {} : {signature: content.thinkingSignature}),
    ...(content.redacted === undefined ? {} : {redacted: content.redacted})}];
  return [];
}

function providerModel(config: ModelConfig, maxTokens: number): Model<'openai-completions' | 'anthropic-messages'> {
  return {id: config.id, name: config.id, provider: config.provider, api: config.protocol, baseUrl: config.endpoint,
    contextWindow: config.contextWindow, maxTokens, reasoning: config.reasoning ?? false, input: [...(config.input ?? ['text'])],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
}
export function createPiTransport(options: PiTransportOptions): ModelTransport {
  if (!options.apiKey.trim()) throw new RuntimeFault('INVALID_REQUEST');
  const config = Object.freeze(structuredClone(options.model)), apiKey = options.apiKey, fetch = options.fetch;
  return async request => {
    if (!isDeepStrictEqual(config, request.model)) throw new RuntimeFault('CONFIGURATION_CHANGED');
    if (request.signal.aborted) throw new RuntimeFault('CANCELLED');
    if (request.deferred) throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
    validateThinking(config, request.thinkingLevel, request.maxOutputTokens);
    const model = providerModel(config, request.maxOutputTokens);
    const context = normalizeContext({messages: request.messages.map((message): Message => {
      const timestamp = Date.now();
      if (message.role === 'system') return {role: 'system', content: message.text, timestamp,
        toolsAdded: (message.tools ?? []).map(tool => ({...tool, parameters: tool.parameters as unknown as TSchema}))};
      if (message.role === 'user') return {role: 'user', content: message.images?.length ? [{type: 'text', text: message.text}, ...message.images.map(image => ({type: 'image' as const, ...image}))] : message.text, timestamp};
      if (message.role === 'tool') return {role: 'toolResult', toolCallId: message.toolId!, toolName: message.toolName!,
        content: [{type: 'text', text: message.text}, ...(message.images ?? []).map(image => ({type: 'image' as const, ...image}))], isError: message.toolFailed ?? false, timestamp};
      return {role: 'assistant', api: message.origin?.protocol ?? model.api, provider: message.origin?.provider ?? model.provider, model: message.origin?.id ?? model.id, timestamp,
        content: message.blocks?.map(toPiContent) ?? [...(message.text ? [{type: 'text' as const, text: message.text}] : []),
          ...(message.calls ?? []).map(call => ({type: 'toolCall' as const, ...call}))],
        stopReason: message.calls?.length ? 'toolUse' : 'stop',
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    })});
    let category: ProviderFailure['category'] | undefined;
    const guardedFetch: typeof globalThis.fetch = async (input, init) => {
      try {
        const response = await (fetch ?? globalThis.fetch)(input, {...init, redirect: 'error'});
        category = response.status === 402 ? 'quota' : response.status === 429 ? 'rate-limit' :
          [500, 502, 503, 504].includes(response.status) ? 'unavailable' : undefined;
        return response;
      } catch (error) {category = 'network'; throw error;}
    };
    try {
      const api = config.protocol === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi();
      const stream = api.streamSimple(model, context, {apiKey, signal: request.signal, maxTokens: request.maxOutputTokens,
        ...(request.thinkingLevel && request.thinkingLevel !== 'off' ? {reasoning: request.thinkingLevel} : {}),
        maxRetries: 0, cacheRetention: 'none', transport: 'sse', fetch: guardedFetch});
      const reply = await stream.result();
      if (!['stop', 'toolUse', 'length'].includes(reply.stopReason)) {
        if (category) throw new ProviderFailure(category);
        throw new RuntimeFault('MODEL_FAILED');
      }
      if (reply.content.some(content => !['text', 'toolCall', 'thinking'].includes(content.type))) throw new RuntimeFault('INVALID_OUTPUT');
      return {content: reply.content.flatMap(fromPiContent),
        stop: reply.stopReason === 'stop' ? 'complete' : reply.stopReason === 'toolUse' ? 'tools' : 'length',
        usage: {inputTokens: reply.usage.input, outputTokens: reply.usage.output || request.maxOutputTokens}};
    } catch (error) {if (error instanceof RuntimeFault) throw error; if (category) throw new ProviderFailure(category); throw new RuntimeFault('MODEL_FAILED');}
  };
}
function messages(context: {messages: readonly AgentMessage[]}): ModelMessage[] {
  return context.messages.map((m): ModelMessage => {
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant' && m.role !== 'toolResult') throw new RuntimeFault('INVALID_REQUEST');
    const images = typeof m.content === 'string' ? [] : m.content.filter(c => c.type === 'image').map(c => ({data:c.data,mimeType:c.mimeType as import('./types.ts').InputImage['mimeType']}));
    const text = typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('');
    if (m.role === 'assistant') return {role: 'assistant', text,origin:{provider:m.provider,id:m.model,protocol:m.api as ModelConfig['protocol']},
      ...(m.content.some(content => content.type === 'thinking') ? {blocks: m.content.flatMap(fromPiContent)} : {}),
      calls: m.content.filter(c => c.type === 'toolCall').map(c => ({id: c.id, name: c.name, arguments: c.arguments as JsonObject}))};
    if (m.role === 'toolResult') return {role: 'tool', text, ...(images.length ? {images} : {}), toolId: m.toolCallId, toolName: m.toolName, toolFailed: m.isError};
    if (m.role === 'system') return {role: 'system', text,
      tools: m.toolsAdded?.map(t => ({name: t.name, description: t.description, parameters: t.parameters as unknown as JsonObject})) ?? []};
    return {role: 'user', text, ...(images.length ? {images} : {})};
  });
}
function fromCheckpoint(checkpoint: ConversationCheckpoint, config: ModelConfig, cap: number): Message[] {
  const model = providerModel(config, cap);
  return checkpoint.messages.map((message): Message => {
    const timestamp = Date.now();
    if (message.role === 'system') return {role:'system',content:message.text,timestamp,
      toolsAdded:(message.tools ?? []).map(t=>({...t,parameters:t.parameters as unknown as TSchema}))};
    if (message.role === 'user') return {role:'user',content:message.images?.length ? [{type:'text',text:message.text},...message.images.map(image=>({type:'image' as const,...image}))] : message.text,timestamp};
    if (message.role === 'tool') return {role:'toolResult',toolCallId:message.toolId!,toolName:message.toolName!,content:[{type:'text',text:message.text},...(message.images ?? []).map(image=>({type:'image' as const,...image}))],isError:message.toolFailed ?? false,timestamp};
    return {role:'assistant',api:message.origin?.protocol ?? model.api,provider:message.origin?.provider ?? model.provider,model:message.origin?.id ?? model.id,
      content:message.blocks?.map(toPiContent) ?? [...(message.text?[{type:'text' as const,text:message.text}]:[]),...(message.calls ?? []).map(call=>({type:'toolCall' as const,...call}))],
      stopReason:message.calls?.length?'toolUse':'stop',timestamp,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  });
}
type ControlGuard = <T>(operation: () => Promise<T>) => Promise<T>;
const directControl: ControlGuard = operation => operation();

// Each storage operation has its own control deadline; never time the whole native lane.
function guardedSessionFiles(env: NodeExecutionEnv, guard: ControlGuard): NodeExecutionEnv {
  return new Proxy(env, {get(target, property) {
    if (property === 'openTextLineReader') return async (...args: Parameters<NodeExecutionEnv['openTextLineReader']>) => {
      const result = await guard(() => target.openTextLineReader(...args));
      if (!result.ok) return result;
      const reader = result.value;
      return {ok: true as const, value: {
        readLine: (context: Context) => guard(() => reader.readLine(context)),
        close: (context: Context) => guard(() => reader.close(context)),
      }};
    };
    const method = Reflect.get(target, property);
    return typeof method === 'function' ? (...args: unknown[]) => guard(() => method.apply(target, args)) : method;
  }});
}

export async function drive(config: ModelConfig, request: BaseRequest, transport: ModelTransport, signal: AbortSignal, tools: readonly Tool[] = [], activeModel: () => ModelConfig = () => config, _bind?: (binding: SessionBinding) => void, _control?: (command: HarnessControl) => Promise<void>, guard: ControlGuard = directControl): Promise<string | {waiting: ConversationCheckpoint} | {suspended: SessionBinding}> {
  const legacy = request as AgentRequest;
  // Existing durable checkpoints retain their versioned semantics until migration.
  // Ordinary runs use the native harness without inventing a persistent contract.
  return legacy.checkpoint || legacy.saveCheckpoint || legacy.shouldYield
    ? driveCheckpoint(config, request, transport, signal, tools, activeModel, guard)
    : driveHarness(config, request, transport, signal, tools, activeModel, undefined, guard);
}

async function driveHarness(config: ModelConfig, request: BaseRequest, transport: ModelTransport,
  signal: AbortSignal, tools: readonly Tool[], activeModel: () => ModelConfig,
  persistent?: {session: Session; reconcile: SessionRuntimeOptions['reconcile']; bindOperation: SessionRuntimeOptions['bindOperation']; bind: (binding: SessionBinding) => void; settings: HarnessSettings; extensions?: SessionRuntimeOptions['extensions']; activate(lane: AgentLane, harness: Awaited<ReturnType<typeof AgentHarness.create>>['harness'], binding: SessionBinding): void; deactivate(): Promise<void>}, guard: ControlGuard = directControl): Promise<string | {suspended: SessionBinding}> {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const repo = new MemorySessionRepo();
  const model = providerModel(config, outputCap(request.limits));
  let failure: unknown;
  let harness: Awaited<ReturnType<typeof AgentHarness.create>>['harness'] | undefined;
  const callIds = new Set<string>();
  let serializeBatch = false;
  let toolTail: Promise<void> = Promise.resolve();
  const assertOpen = () => {
    if (failure) throw failure;
    if (signal.aborted) throw new RuntimeFault('CANCELLED');
  };
  // Models supplies native transcript handling and complete/stream semantics.
  // Credentials and actual IO remain solely in the explicitly supplied transport.
  const models = createModels({authContext: {env: async () => undefined, fileExists: async () => false}});
  const stream = (transcript: TranscriptContext, nativeSignal?: AbortSignal, maxTokens?: number, deferred?: {action:'poll' | 'cancel';handle:DeferredReference}, startDeferred = false) => {
    const result = createAssistantMessageEventStream();
    void (async () => {
      try {
        assertOpen();
        const reply = await transport({model: config, messages: messages(transcript),
          maxOutputTokens: Math.min(outputCap(request.limits), maxTokens ?? outputCap(request.limits)),
          signal: nativeSignal ? AbortSignal.any([signal, nativeSignal]) : signal,
          ...(request.thinkingLevel === undefined ? {} : {thinkingLevel: request.thinkingLevel}),
          ...(deferred ? {deferred} : startDeferred ? {deferred:{action:'start' as const}} : {})});
        assertOpen();
        if (reply.stop === 'length') throw new RuntimeFault('INVALID_OUTPUT');
        const calls = reply.content.filter(c => c.kind === 'tool');
        if ((calls.length > 0) !== (reply.stop === 'tools')) throw new RuntimeFault('INVALID_OUTPUT');
        // Keep whole-batch admission before any native tool can take effect.
        for (const call of calls) {
          if (callIds.has(call.id)) throw new RuntimeFault('INVALID_TOOL');
          const tool = tools.find(tool => tool.name === call.name);
          if (!tool) throw new RuntimeFault('INVALID_TOOL');
          try {validateToolArguments({...tool, parameters: tool.parameters as unknown as TSchema},
            {type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments});}
          catch {throw new RuntimeFault('INVALID_TOOL');}
          callIds.add(call.id);
        }
        // Harness 0.86.1 uses only run.settings.toolExecution; unlike Agent,
        // it does not honor a called tool's sequential override. Preserve the
        // SDK batch contract at the effect boundary, without another tool loop.
        serializeBatch = calls.some(call => tools.find(tool => tool.name === call.name)?.executionMode === 'sequential');
        const chosen = providerModel(activeModel(), outputCap(request.limits));
        if (reply.stop === 'deferred' && (!config.deferred || !reply.deferred)) throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
        const stopReason = reply.stop === 'deferred' ? 'deferred' : reply.stop === 'complete' ? 'stop' : 'toolUse';
        const message: AssistantMessage = {role: 'assistant', api: chosen.api, provider: chosen.provider, model: chosen.id,
          content: reply.content.map(toPiContent), timestamp: Date.now(),
          stopReason, ...(reply.deferred ? {deferred:{...reply.deferred,provider:model.provider,modelId:model.id,api:model.api}} : {}),
          usage: {input: reply.usage.inputTokens, output: reply.usage.outputTokens, cacheRead: 0, cacheWrite: 0,
            totalTokens: reply.usage.inputTokens + reply.usage.outputTokens,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
        result.push({type: 'start', partial: message});
        result.push({type: 'done', reason: stopReason, message});
      } catch (error) {
        const retryable = persistent?.settings.retry?.enabled && error instanceof ProviderFailure && error.category !== 'quota';
        if (!retryable) failure ??= error;
        const message: AssistantMessage = {role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [], timestamp: Date.now(), stopReason: 'error', errorMessage: retryable ? 'service unavailable' : 'Model request failed',
          usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
        result.push({type: 'error', reason: 'error', error: message});
      }
    })();
    return result;
  };
  const provider: Provider = {
    id: model.provider, name: model.provider,
    auth: {apiKey: {name: 'Explicit host transport', resolve: async () => ({auth: {apiKey: 'host-transport'}})}},
    getModels: () => [model],
    stream: (_model, transcript, options) => stream(transcript, options?.signal, options?.maxTokens, undefined, !!(options && 'deferred' in options && options.deferred)),
    streamSimple: (_model, transcript, options) => stream(transcript, options?.signal, options?.maxTokens, undefined, !!(options && 'deferred' in options && options.deferred)),
    ...(config.deferred ? {fetchDeferred: (_model: Model<Api>, handle: DeferredHandle, options?: {signal?:AbortSignal}) => stream(normalizeContext({messages:[]}),options?.signal,undefined,{action:'poll',handle:JSON.parse(JSON.stringify({id:handle.id,data:handle.data,pollAfterMs:handle.pollAfterMs,expiresAt:handle.expiresAt}))}),
      cancelDeferred: async (_model: Model<Api>, handle: DeferredHandle, options?: {signal?:AbortSignal}) => {await stream(normalizeContext({messages:[]}),options?.signal,undefined,{action:'cancel',handle:JSON.parse(JSON.stringify({id:handle.id,data:handle.data}))}).result();assertOpen();}} : {}),
  };
  models.setProvider(provider);
  try {
    const session = persistent?.session ?? await guard(() => repo.create({}, context));
    const attached = await guard(() => AgentHarness.create({session, models, model,
      systemPrompt: (request.system ?? '') + (persistent?.settings.skills?.length ? '\n' + formatSkillsForSystemPrompt([...persistent.settings.skills]) : ''), thinkingLevel: request.thinkingLevel ?? 'off',
      toolExecution: request.toolExecution ?? 'sequential',
      steeringMode: persistent?.settings.steeringMode ?? 'all', followUpMode: persistent?.settings.followUpMode ?? 'all',
      // Preserve current single-run policy. Sustained-session settings are separate.
      streamOptions: {deferred: persistent?.settings.deferred ?? false},
      retry: persistent?.settings.retry ?? {enabled: false, maxRetries: 0, baseDelayMs: 0},
      compaction: persistent?.settings.compaction ?? {...DEFAULT_COMPACTION_SETTINGS, enabled: false},
      entryProjectors: Object.fromEntries((persistent?.extensions?.customEntryTypes ?? []).map(type => [type, entry =>
        fromCheckpoint({version:'1.0',taskId:'',state:'ready',messages:persistent?.extensions?.projectEntry?.({type:entry.customType,...(entry.data === undefined ? {} : {data:entry.data})}) ?? []}, config, outputCap(request.limits))])),
      resources: {skills: [...(persistent?.settings.skills ?? [])], promptTemplates: [...(persistent?.settings.templates ?? [])]},
      tools: tools.map(tool => ({name: tool.name, label: tool.name, description: tool.description,
        parameters: tool.parameters as unknown as TSchema, replay: tool.replay ?? 'never' as const,
        ...(tool.executionMode === undefined ? {} : {executionMode: tool.executionMode}),
        execute: async (id, args, _update, _toolContext, invocation, toolContext) => {
          const perform = async () => {
            try {
              assertOpen();
              const value = await tool.execute(args as JsonObject,
                toolContext.abortSignal ? AbortSignal.any([signal, toolContext.abortSignal]) : signal,
                persistent ? {sessionId: persistent.session.metadata.id, branch: (request as SessionRunRequest).branch ?? 'main',
                  operationId: invocation.operationId, invocationId: invocation.invocationId, toolCallId: id,
                  getMemo: name => invocation.getMemo(name), setMemo: (name, value) => invocation.setMemo(name, value),
                  update: (value, durable = false) => {if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw new RuntimeFault('INVALID_REQUEST'); _update({content:[{type:'text',text:JSON.stringify(value)}],details:null},durable ? {checkpoint:true} : undefined);}} : undefined);
              assertOpen();
              if (tool.output === 'content') {
                const result = value as {content: ({kind: 'text'; text: string} | {kind: 'image'; data: string; mimeType: string})[]; details?: import('./types.ts').JsonValue};
                if (!Array.isArray(result.content) || result.content.some(c => !['text','image'].includes(c.kind))) throw new RuntimeFault('TOOL_FAILED');
                return {content: result.content.map(c => c.kind === 'text' ? {type:'text' as const,text:c.text} : {type:'image' as const,data:c.data,mimeType:c.mimeType}), details:result.details ?? null};
              }
              return {content: [{type: 'text' as const, text: JSON.stringify(value)}], details: null};
            } catch (error) {failure ??= error; throw error;}
          };
          if (!serializeBatch) return perform();
          const pending = toolTail.then(perform);
          toolTail = pending.then(() => {}, () => {});
          return pending;
        },
      })),
    }, context));
    harness = attached.harness;
    const extensions = persistent?.extensions;
    if (extensions?.transformContext) harness.hooks.on('transform_context', async e => {
      const result = await guard(async () => extensions.transformContext!({messages: messages(e), system:e.systemPrompt}));
      return result ? {...(result.messages ? {messages:fromCheckpoint({version:'1.0',taskId:'',state:'ready',messages:result.messages},config,outputCap(request.limits))} : {}), ...(result.system === undefined ? {} : {systemPrompt:result.system})} : undefined;
    });
    if (extensions?.beforeRequest) harness.hooks.on('before_request', async e => {await guard(async () => extensions.beforeRequest!({step:e.step,attempt:e.attempt}));return undefined;});
    if (extensions?.beforeTool) harness.hooks.on('before_tool', async e => {const result = await guard(async () => extensions.beforeTool!({name:e.toolName,arguments:e.args as JsonObject}));return result ? {...(result.arguments ? {args:result.arguments} : {}),...(result.block ? {block:{reason:result.block,terminate:true}} : {})} : undefined;});
    if (extensions?.beforeEnd) harness.hooks.on('before_run_end', () => guard(async () => extensions.beforeEnd!()));
    const sessionRequest = request as SessionRunRequest;
    const branch = persistent ? sessionRequest.branch ?? 'main' : 'main';
    if (persistent) {
      const state = await guard(() => session.getValue(laneState(branch), context));
      if (state?.value.inbox.length) {
        const owner = (await guard(() => session.getValue(value<{taskId:string;purpose?:string}>('sdk.queue-authority.v1', branch), context)))?.value;
        if (!owner || owner.taskId !== request.taskId || owner.purpose !== request.purpose) throw new RuntimeFault('AUTHORITY_REQUIRED');
      }
      const decision = await guard(() => persistent.reconcile({taskId: request.taskId, sessionId: session.metadata.id, branch,
        open: attached.open.map(o => ({operationId: o.operationId, branch: o.lane, kind: o.kind}))}, signal));
      assertOpen();
      if (decision !== 'ready') throw new RuntimeFault(decision === 'denied' ? 'AUTHORITY_REQUIRED' : 'STATE_FAILED');
      if (attached.open.length && (!['resume','abort'].includes(sessionRequest.operation ?? '') || attached.open.some(o => o.lane !== branch)))
        throw new RuntimeFault('STATE_FAILED');
    }
    harness.hooks.on('after_tool', event => {
      if (event.isError) failure ??= new RuntimeFault('TOOL_FAILED');
      return failure ? {terminate: true} : undefined;
    });
    const lane = await guard(() => harness!.lane(branch, context));
    if (persistent && !attached.open.length) {
      await guard(() => lane.setModel({provider: model.provider, modelId: model.id}, context));
      await guard(() => lane.setThinkingLevel(request.thinkingLevel ?? 'off', context));
      await guard(() => lane.setActiveTools(tools.map(t => t.name), context));
    }
    let result;
    if (persistent) {
      const current = attached.open.find(o => o.lane === branch);
      if (['resume','abort'].includes(sessionRequest.operation ?? '') && !current) throw new RuntimeFault('INVALID_REQUEST');
      const operationId = current?.operationId ?? randomUUID();
      if (current) {
        const state = (await guard(() => session.getValue(operationState(operationId), context)))?.value;
        if (state?.at === 'tools') {
          const entry = await guard(() => session.getEntry(state.batch.assistantEntryId, context));
          if (entry?.type !== 'message' || entry.message.role !== 'assistant') throw new RuntimeFault('STATE_FAILED');
          serializeBatch = entry.message.content.some(c => c.type === 'toolCall' && tools.find(t => t.name === c.name)?.executionMode === 'sequential');
        }
      }
      const binding = {sessionId: session.metadata.id, branch, operationId};
      await guard(() => persistent.bindOperation({...binding, taskId: request.taskId,
        ...(request.purpose === undefined ? {} : {purpose: request.purpose})}, signal));
      assertOpen();
      persistent.bind(binding);
      if (!current) {
        let operation: OperationRequest;
        switch (sessionRequest.operation) {
          case 'skill': operation = {kind: 'skill', operationId, name: sessionRequest.resourceName!, additionalInstructions: request.prompt}; break;
          case 'template': operation = {kind: 'prompt_template', operationId, name: sessionRequest.resourceName!, args: [...(sessionRequest.templateArguments ?? [])]}; break;
          case 'compact': operation = {kind: 'compaction', operationId, customInstructions: request.prompt}; break;
          case 'navigate': operation = {kind: 'navigation', operationId, targetId: sessionRequest.targetEntryId!, options: {summarize: sessionRequest.summarize ?? false, customInstructions: request.prompt}}; break;
          default: operation = {kind: 'prompt', operationId, prompt: request.prompt, ...(request.images ? {images: request.images.map(image => ({type:'image' as const,...image}))} : {})};
        }
        const admission = await guard(() => lane.accept(operation, context));
        if (!admission.ok) throw new RuntimeFault('INVALID_REQUEST');
      }
      persistent.activate(lane, harness, binding);
      if (sessionRequest.operation === 'abort') await guard(() => lane.requestAbort(operationId,context));
      const driven = await lane.drive({operationId, waitForRetry: true, pollDeferred: sessionRequest.operation === 'resume'}, context);
      if (!driven.ok) throw new RuntimeFault('STATE_FAILED');
      if (driven.value.kind === 'waiting') {assertOpen();return {suspended:binding};}
      result = {ok: true as const, value: driven.value.outcome};
    } else result = await lane.prompt(request.prompt, request.images?.map(image => ({type:'image' as const,...image})), context);
    assertOpen();
    if (result.ok && result.value.status === 'aborted') throw new RuntimeFault('CANCELLED');
    if (!result.ok || result.value.status !== 'completed') throw new RuntimeFault('MODEL_FAILED');
    if (persistent && ['compaction', 'navigation'].includes(result.value.kind)) {
      const type = result.value.kind === 'compaction' ? 'compaction' : 'branch_summary';
      const summary = await guard(() => lane.findEntry({type, order: 'newestFirst'}, context));
      return summary && 'summary' in summary ? summary.summary : '';
    }
    const entries = await guard(() => lane.findEntries({type: 'message', order: 'newestFirst', limit: 1}, context));
    const entry = entries[0];
    const last = entry?.type === 'message' ? entry.message : undefined;
    if (!last || last.role !== 'assistant' || last.stopReason !== 'stop' ||
      !last.content.some(c => c.type === 'text') || last.content.some(c => !['text', 'thinking'].includes(c.type)))
      throw new RuntimeFault('INVALID_OUTPUT');
    return last.content.filter(c => c.type === 'text').map(c => c.text).join('');
  } finally {
    await persistent?.deactivate();
    try {await guard(async () => harness?.close(BACKGROUND_CONTEXT));} finally {await guard(() => repo.close(BACKGROUND_CONTEXT));}
  }
}

/** Repository handles never escape the adapter. Host ownership surrounds every native open,
 * including reads (native open may repair an incomplete trailing transaction). */
async function snapshotLane(lane: AgentLane, ctx: Context, includeContent = false): Promise<HarnessControlResult> {
                const watch = await lane.watch(ctx);
                try {const s = watch.snapshot; return {snapshot: {branch: s.lane, tipId: s.tipId,
                  operationId: s.operation?.id ?? null, queued: s.queues.map(q => ({entryId: q.entryId, kind: q.kind})),
                  activeTools: s.configuration.activeToolNames, thinkingLevel: s.configuration.thinkingLevel,
                  model: {provider: s.configuration.model.provider, id: s.configuration.model.modelId}, faulted: s.faulted,
                  runningTools:s.operation?.runningTools.map(t=>({name:t.toolName,callId:t.toolCallId,status:t.status})) ?? [],
                  ...(includeContent ? {transcript:s.transcript.map(e=>({id:e.id,parentId:e.parentId,kind:e.type,...(e.type==='message'?{message:messages({messages:[e.message]})[0]!}:{}),...('summary' in e?{summary:e.summary}:{})}))} : {})}};} finally {watch.unsubscribe();}
}

export function createSessionBackend(options: SessionRuntimeOptions): {sessions: Pick<SessionRuntime, 'create' | 'list' | 'history' | 'inspect' | 'fork' | 'delete' | 'control' | 'update' | 'result'>; drive: typeof drive} {
  const storage = {...options.storage}, reconcile = options.reconcile, bindOperation = options.bindOperation, settings = options.harness ?? {};
  if (!options.budgets || !isAbsolute(storage.directory) || !isAbsolute(storage.cwd) ||
    !storage.policyVersion?.trim() || typeof storage.authorize !== 'function' ||
    typeof storage.acquireWriter !== 'function' || typeof reconcile !== 'function' || typeof bindOperation !== 'function' || (options.extensions && !settings.extensionVersion)) throw new RuntimeFault('INVALID_REQUEST');
  let busy = false;
  let live: {taskId: string; sessionId: string; branch: string; purpose?: string; control(command: HarnessControl): Promise<HarnessControlResult>} | undefined;
  let controlTail: Promise<unknown> = Promise.resolve();
  const info = (m: JsonlSessionMetadata): SessionInfo => ({id: m.id, createdAt: m.createdAt,
    ...(m.parentSessionId === undefined ? {} : {parentSessionId: m.parentSessionId})});
  async function access<T>(kind: Parameters<typeof storage.authorize>[0]['kind'], sessionId: string | undefined,
    signal: AbortSignal | undefined, action: (repo: JsonlSessionRepo, metadata: JsonlSessionMetadata | undefined, signal: AbortSignal) => Promise<T>, guard: ControlGuard = directControl): Promise<T> {
    signal ??= new AbortController().signal;
    if (signal.aborted) throw new RuntimeFault('CANCELLED');
    if (sessionId !== undefined && !/^[a-zA-Z0-9_.-]{1,128}$/.test(sessionId)) throw new RuntimeFault('INVALID_REQUEST');
    try {
      if (!await guard(() => storage.authorize({kind, ...(sessionId === undefined ? {} : {sessionId})}, signal!))) throw new RuntimeFault('AUTHORITY_REQUIRED');
    } catch {throw new RuntimeFault('AUTHORITY_REQUIRED');}
    if (signal.aborted) throw new RuntimeFault('CANCELLED');
    if (busy) throw new RuntimeFault('TASK_BUSY');
    busy = true;
    let writer: Awaited<ReturnType<typeof storage.acquireWriter>> | undefined;
    let repo: JsonlSessionRepo | undefined;
    try {
      writer = await guard(() => storage.acquireWriter(signal!));
      if (!writer || typeof writer.release !== 'function') throw new RuntimeFault('STATE_FAILED');
      if (signal.aborted) throw new RuntimeFault('CANCELLED');
      repo = new JsonlSessionRepo({fileSystem: guardedSessionFiles(new NodeExecutionEnv({cwd: storage.cwd}), guard), sessionsRoot: storage.directory});
      const metadata = sessionId === undefined ? undefined : (await guard(() => repo!.list({cwd: storage.cwd}, BACKGROUND_CONTEXT))).find(m => m.id === sessionId);
      if (sessionId !== undefined && !metadata) throw new RuntimeFault('INVALID_REQUEST');
      return await action(repo, metadata, signal);
    } catch (error) {throw error instanceof RuntimeFault ? error : new RuntimeFault('STATE_FAILED');}
    finally {
      try {await guard(async () => repo?.close(BACKGROUND_CONTEXT));} finally {
        try {await guard(async () => writer?.release());} catch {throw new RuntimeFault('STATE_FAILED');} finally {busy = false;}
      }
    }
  }
  async function opened<T>(repo: JsonlSessionRepo, metadata: JsonlSessionMetadata, signal: AbortSignal,
    action: (session: Session<JsonlSessionMetadata>) => Promise<T>, guard: ControlGuard = directControl): Promise<T> {
    const session = await guard(() => repo.open(metadata, withAbortSignal(signal, BACKGROUND_CONTEXT)));
    try {return await action(session);} finally {await guard(() => session.close(BACKGROUND_CONTEXT));}
  }
  return {
    sessions: {
      control: async input => {
        const selected = live;
        if (!selected) {
          if (!['snapshot','cancelQueued'].includes(input.command.kind)) throw new RuntimeFault('INVALID_REQUEST');
          const command = structuredClone(input.command), branch = input.branch ?? 'main';
          return access(command.kind === 'snapshot' ? 'read' : 'update', input.sessionId, input.signal, (repo, metadata, signal) => opened(repo, metadata!, signal, async session => {
            const ctx = withAbortSignal(signal, BACKGROUND_CONTEXT);
            const owner = (await session.getValue(value<{taskId:string;purpose?:string;operationId:string}>('sdk.queue-authority.v1', branch), ctx))?.value;
            if (!owner || owner.taskId !== input.taskId || owner.purpose !== input.purpose || !owner.operationId) throw new RuntimeFault('AUTHORITY_REQUIRED');
            const binding = {sessionId:input.sessionId,branch,operationId:owner.operationId};
            const runId = randomUUID();
            if (!await options.authorize({kind:'control',taskId:input.taskId,runId,session:binding,command},signal)) throw new RuntimeFault('AUTHORITY_REQUIRED');
            if (signal.aborted) throw new RuntimeFault('CANCELLED');
            try {await options.audit.append({version:'1.0',kind:'session.control',taskId:input.taskId,runId,sequence:1,at:new Date().toISOString(),provider:options.model.provider,model:options.model.id,contextVersions:{},session:binding,digest:createHash('sha256').update(JSON.stringify(command)).digest('hex')},signal);} catch {throw new RuntimeFault('AUDIT_FAILED');}
            if (signal.aborted) throw new RuntimeFault('CANCELLED');
            const models = createModels({authContext:{env:async()=>undefined,fileExists:async()=>false}});
            const attached = await AgentHarness.create({session,models,model:providerModel(options.model,1)},ctx);
            try {
              const lane = await attached.harness.lane(branch,ctx);
              if(command.kind==='snapshot')return await snapshotLane(lane,ctx,command.includeContent);
              if(command.kind!=='cancelQueued')throw new RuntimeFault('INVALID_REQUEST');
              const result = await lane.cancelQueued(command.entryId,ctx);
              if(!result.ok)throw new RuntimeFault('STATE_FAILED');return {cancelled:result.value.kind==='cancelled'};
            } finally {await attached.harness.close(BACKGROUND_CONTEXT);}
          }));
        }
        if (selected.taskId !== input.taskId || selected.sessionId !== input.sessionId || selected.branch !== (input.branch ?? 'main') || (input.purpose !== undefined && selected.purpose !== input.purpose)) throw new RuntimeFault('AUTHORITY_REQUIRED');
        const command = structuredClone(input.command);
        const pending = controlTail.then(() => {if (selected !== live) throw new RuntimeFault('STATE_FAILED'); return selected.control(command);});
        controlTail = pending.catch(() => {});
        return pending;
      },
      update: (id, change, signal) => access('update', id, signal, (repo, metadata, signal) => opened(repo, metadata!, signal, async session => {
        const ctx = withAbortSignal(signal, BACKGROUND_CONTEXT);
        if (change.kind === 'name') return session.setName(change.name, ctx);
        if (change.kind === 'label') return session.setLabel(change.entryId, change.label, ctx);
        if (change.kind === 'branch') {await session.createBranch(change.name, change.at, ctx); return;}
        const branch = await session.branch(change.branch, ctx);
        if (!branch) throw new RuntimeFault('INVALID_REQUEST');
        const state = await session.getValue(laneState(change.branch), ctx);
        if (state?.value.currentOperationId) throw new RuntimeFault('TASK_BUSY');
        if (change.kind === 'custom') await branch.appendCustomEntry(change.type, change.data, ctx);
        else await branch.appendMessage(fromCheckpoint({version: '1.0', taskId: '', state: 'ready', messages: [change.message]}, options.model, 1)[0]!, ctx);
      })),
      create: signal => access('create', undefined, signal, async (repo, _metadata, signal) => {
        const session = await repo.create({cwd: storage.cwd}, withAbortSignal(signal, BACKGROUND_CONTEXT));
        try {return info(session.metadata);} finally {await session.close(BACKGROUND_CONTEXT);}
      }),
      list: signal => access('list', undefined, signal, async repo => {
        const visible: SessionInfo[] = [];
        for (const metadata of await repo.list({cwd: storage.cwd}, BACKGROUND_CONTEXT)) {
          if (await storage.authorize({kind: 'read', sessionId: metadata.id}, signal ?? new AbortController().signal)) visible.push(info(metadata));
        }
        return visible;
      }),
      history: (id, branch = 'main', signal) => access('read', id, signal, (repo, metadata, signal) =>
        opened(repo, metadata!, signal, async session => {
          const lane = await session.branch(branch, BACKGROUND_CONTEXT);
          const entries = await lane?.findEntries({order: 'oldestFirst'}, BACKGROUND_CONTEXT) ?? [];
          return Promise.all(entries.map(async entry => ({...(await session.getLabel(entry.id, BACKGROUND_CONTEXT) ? {label:(await session.getLabel(entry.id, BACKGROUND_CONTEXT))!} : {}), id: entry.id, parentId: entry.parentId, kind: entry.type,
            ...(entry.type === 'message' ? {message: messages({messages: [entry.message]})[0]!} : {}),
            ...('summary' in entry ? {summary: entry.summary} : {})})));
        })),
      inspect: (id, branch = 'main', signal) => access('read', id, signal, (repo, metadata, signal) =>
        opened(repo, metadata!, signal, async session => {
          const lane = await session.branch(branch, BACKGROUND_CONTEXT);
          const state = await session.getValue(laneState(branch), BACKGROUND_CONTEXT);
          const current = state?.value.currentOperationId;
          const meta = current ? await session.getValue(operationMeta(current), BACKGROUND_CONTEXT) : undefined;
          if (current && !meta) throw new RuntimeFault('STATE_FAILED');
          return {session: {...info(session.metadata), ...(await session.getName(BACKGROUND_CONTEXT) ? {name:(await session.getName(BACKGROUND_CONTEXT))!} : {})}, branch, tipId: await lane?.getTipId(BACKGROUND_CONTEXT) ?? null,
            pending: meta ? {operationId: meta.value.operationId, kind: meta.value.intent.kind} : null};
        })),
      result: (id, operationId, signal) => access('read', id, signal, (repo, metadata, signal) => opened(repo,metadata!,signal,async session => {
        const value = (await session.getValue(operationResult(operationId),BACKGROUND_CONTEXT))?.value;
        return value ? {operationId:value.operationId,status:value.status,kind:value.kind,tipId:value.tipId} : undefined;
      })),
      fork: (id, branch = 'main', signal) => access('fork', id, signal, async (repo, metadata, signal) => {
        await opened(repo, metadata!, signal, async session => {
          const state = await session.getValue(laneState(branch), BACKGROUND_CONTEXT);
          // Native fork discards operation state. Never use it to erase unsettled effects or queues.
          if (!state || state.value.currentOperationId || state.value.inbox.length) throw new RuntimeFault('STATE_FAILED');
        });
        const forked = await repo.fork(metadata!, {scope: 'branch', branch}, withAbortSignal(signal, BACKGROUND_CONTEXT));
        try {return info(forked.metadata);} finally {await forked.close(BACKGROUND_CONTEXT);}
      }),
      delete: (id, signal) => access('delete', id, signal, async (repo, metadata, signal) => {
        await repo.delete(metadata!, withAbortSignal(signal, BACKGROUND_CONTEXT));
      }),
    },
    drive: (config, request, transport, signal, tools = [], activeModel = () => config, bind = () => {}, control = async () => {}, guard = directControl) => {
      const r = request as SessionRunRequest & AgentRequest;
      if (r.modelRecovery && settings.retry?.enabled) throw new RuntimeFault('INVALID_REQUEST');
      if (settings.deferred && !config.deferred) throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
      if (!r.sessionId || r.checkpoint || r.saveCheckpoint || r.shouldYield ||
        (r.operation !== undefined && !['prompt', 'resume', 'skill', 'template', 'compact', 'navigate', 'abort'].includes(r.operation)) ||
        (['resume','abort'].includes(r.operation ?? '') && r.prompt) ||
        (['skill', 'template'].includes(r.operation ?? '') && !r.resourceName) ||
        (r.operation === 'navigate' && r.targetEntryId === undefined)) throw new RuntimeFault('INVALID_REQUEST');
      return access('run', r.sessionId, signal, (repo, metadata, signal) => opened(repo, metadata!, signal,
        session => driveHarness(config, request, transport, signal, tools, activeModel, {session, reconcile, bindOperation, bind, settings, ...(options.extensions ? {extensions: options.extensions} : {}),
          activate(lane, harness, binding) {
            live = {taskId: request.taskId, ...(request.purpose === undefined ? {} : {purpose:request.purpose}), sessionId: r.sessionId, branch: r.branch ?? 'main', control: async command => {
              await control(command);
              const ctx = withAbortSignal(signal, BACKGROUND_CONTEXT);
              if (command.kind === 'snapshot') {
                return guard(() => snapshotLane(lane, ctx, command.includeContent));
              }
              if (command.kind === 'abort') {const result = await guard(() => lane.requestAbort(binding.operationId, ctx)); if (!result.ok) throw new RuntimeFault('STATE_FAILED'); return {};}
              if (command.kind === 'cancelQueued') {const result = await guard(() => lane.cancelQueued(command.entryId, ctx)); if (!result.ok) throw new RuntimeFault('STATE_FAILED'); return {cancelled: result.value.kind === 'cancelled'};}
              if (typeof command.text !== 'string' || !command.text || Buffer.byteLength(command.text) > 1_048_576) throw new RuntimeFault('INVALID_REQUEST');
              // Persist authority first. A crash here leaves no queue; a crash after enqueue
              // leaves a queue with a durable owner. Never infer ownership on recovery.
              await guard(() => session.setValue(value<{taskId:string;purpose?:string;operationId:string}>('sdk.queue-authority.v1', r.branch ?? 'main'),
                {taskId:request.taskId,operationId:binding.operationId,...(request.purpose === undefined ? {} : {purpose:request.purpose})}, ctx));
              const result = await guard(() => lane[command.kind](command.text, undefined, ctx));
              if (!result.ok) throw new RuntimeFault('STATE_FAILED');
              return {entryId: result.value.entryId};
            }};
            for (const kind of ['run_start', 'run_end', 'turn_start', 'turn_end', 'tool_start', 'tool_end', 'tool_update', 'queue_update', 'compaction_start', 'compaction_end', 'navigation_start', 'navigation_end', 'retry_start', 'retry_end', 'handler_error'] as const) {
              harness.events.on(kind, () => {try {Promise.resolve(options.onHarnessEvent?.({...binding, taskId: request.taskId, kind})).catch(() => {});} catch {}});
            }
          },
          async deactivate() {live = undefined; await controlTail;},
        }, guard), guard), guard);
    },
  };
}

async function driveCheckpoint(config: ModelConfig, request: BaseRequest, transport: ModelTransport, signal: AbortSignal, tools: readonly Tool[], activeModel: () => ModelConfig, guard: ControlGuard): Promise<string | {waiting: ConversationCheckpoint}> {
  let failure: unknown;
  const checkpointRequest = request as AgentRequest;
  let latest: ConversationCheckpoint | undefined;
  let yielded = false;
  const observedTools = new Map<string, ModelMessage>();
  const initialHistory = checkpointRequest.checkpoint?.messages ?? [];
  const assistantIndex = initialHistory.findLastIndex(m=>m.role === 'assistant');
  const assistant = initialHistory[assistantIndex];
  const acknowledged = initialHistory.slice(assistantIndex + 1).filter(m=>m.role === 'tool');
  const pending = assistant?.calls?.some(c=>!acknowledged.some(m=>m.toolId === c.id)) === true;
  let replay = pending ? assistant : undefined;
  if (pending && request.prompt) throw new RuntimeFault('INVALID_REQUEST');
  if (pending && acknowledged.some(m=>m.toolFailed)) throw new RuntimeFault('STATE_FAILED');
  const restoreHistory = pending ? initialHistory.slice(0,assistantIndex) : initialHistory;
  if (pending) for (const m of acknowledged) observedTools.set(m.toolId!, m);
  const restoredResults = new Map(observedTools);
  latest = checkpointRequest.checkpoint;
  if (checkpointRequest.checkpoint?.state === 'completed' && !request.prompt) return assistant?.text ?? '';

  async function save(history: ModelMessage[], state: ConversationCheckpoint['state'] = 'ready', inFlightToolId?: string) {
    latest = {version: '1.0', taskId: request.taskId, ...(request.purpose === undefined ? {} : {purpose: request.purpose}), messages: history, state, ...(inFlightToolId === undefined ? {} : {inFlightToolId})};
    if (!checkpointRequest.saveCheckpoint) return;
    if (signal.aborted) throw new RuntimeFault('CANCELLED');
    try {await guard(() => checkpointRequest.saveCheckpoint!(structuredClone(latest!), signal));}
    catch {throw new RuntimeFault('STATE_FAILED');}
    if (signal.aborted) throw new RuntimeFault('CANCELLED');
  }
  const callIds = new Set(restoreHistory.flatMap(m=>(m.calls ?? []).map(c=>c.id))); 
  const model = providerModel(config, outputCap(request.limits));
  const agent = new Agent({initialState: {model, ...(checkpointRequest.checkpoint ? {messages: fromCheckpoint({...checkpointRequest.checkpoint, messages: restoreHistory}, config, outputCap(request.limits))} : {}), systemPrompt: request.system ?? '', thinkingLevel: request.thinkingLevel ?? 'off',
    tools: tools.map(tool => ({name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters as unknown as TSchema,
      ...(tool.executionMode === undefined ? {} : {executionMode: tool.executionMode}),
      execute: async (_id: string, args: unknown, toolSignal?: AbortSignal) => restoredResults.has(_id) ? {content:[{type:'text' as const,text:restoredResults.get(_id)!.text}],details:null} : ({
        content: [{type: 'text' as const, text: JSON.stringify(await tool.execute(args as JsonObject, toolSignal ? AbortSignal.any([signal, toolSignal]) : signal))}],
        details: null,
      })}))}, toolExecution: request.toolExecution ?? 'sequential',
    beforeToolCall: async context => {
      if (restoredResults.has(context.toolCall.id)) return undefined;
      if (failure || yielded) return {block: true, terminate: true, reason: 'Run stopped'};
      try {
        const history = messages(context.context);
        await save([...history, ...[...observedTools.values()].filter(t => !history.some(m=>m.role === 'tool' && m.toolId === t.toolId))], 'tool-admitted', context.toolCall.id);
      } catch (error) {failure ??= error; return {block: true, terminate: true, reason: 'Checkpoint not acknowledged'};}
      return undefined;
    },
    afterToolCall: async context => {
      if (restoredResults.has(context.toolCall.id)) return undefined;
      try {
        yielded = checkpointRequest.shouldYield?.() === true;
        const result: ModelMessage = {role: 'tool',
          text: context.result.content.filter(c => c.type === 'text').map(c => c.text).join(''),
          toolId: context.toolCall.id, toolName: context.toolCall.name, toolFailed: context.isError};
        observedTools.set(context.toolCall.id, result);
        const history = messages(context.context);
        await save([...history, ...[...observedTools.values()].filter(t=>!history.some(m=>m.role === 'tool' && m.toolId === t.toolId))], yielded ? 'waiting' : 'ready');
      } catch (error) {failure ??= error;}
      if (context.isError) failure ??= new RuntimeFault('TOOL_FAILED');
      return failure || yielded ? {terminate: true} : undefined;
    },
    shouldStopAfterTurn: () => tools.length === 0 || !!failure || yielded,
    streamFn: async (_model, context) => {
      const stream = createAssistantMessageEventStream();
      try {
        if (failure) throw failure;
        const replaying = replay;
        const reply: ModelReply = replaying ? {content: replaying.blocks ?? [...(replaying.text ? [{kind:'text' as const,text:replaying.text}] : []),
          ...(replaying.calls ?? []).map(call=>({kind:'tool' as const,...call}))],stop:'tools',usage:{inputTokens:0,outputTokens:0}} :
          await transport({model: config, messages: messages(context), maxOutputTokens: outputCap(request.limits), signal,
            ...(request.thinkingLevel === undefined ? {} : {thinkingLevel: request.thinkingLevel})});
        replay = undefined;
        const calls = reply.content.filter(c => c.kind === 'tool');
        if ((calls.length > 0) !== (reply.stop === 'tools')) throw new RuntimeFault('INVALID_OUTPUT');
        // Validate the entire proposed batch before Pi can execute any member.
        for (const content of reply.content) {
          if (content.kind === 'text') {if (typeof content.text !== 'string') throw new RuntimeFault('INVALID_OUTPUT'); continue;}
          if (content.kind === 'reasoning') continue;
          if (content.kind !== 'tool' || typeof content.id !== 'string' || !content.id || callIds.has(content.id)) throw new RuntimeFault('INVALID_TOOL');
          const tool = tools.find(t => t.name === content.name);
          if (!tool) throw new RuntimeFault('INVALID_TOOL');
          try {validateToolArguments({name: tool.name, description: tool.description, parameters: tool.parameters as unknown as TSchema},
            {type: 'toolCall', id: content.id, name: content.name, arguments: content.arguments});}
          catch {throw new RuntimeFault('INVALID_TOOL');}
          callIds.add(content.id);
        }
        const chosen = providerModel(replaying?.origin ? {...activeModel(), ...replaying.origin} : activeModel(), outputCap(request.limits));
        const message: AssistantMessage = {role: 'assistant', api: chosen.api, provider: chosen.provider, model: chosen.id,
          content: reply.content.map(toPiContent),
          stopReason: reply.stop === 'complete' ? 'stop' : reply.stop === 'tools' ? 'toolUse' : 'length', timestamp: Date.now(),
          usage: {input: reply.usage.inputTokens, output: reply.usage.outputTokens, cacheRead: 0, cacheWrite: 0,
            totalTokens: reply.usage.inputTokens + reply.usage.outputTokens, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
        if (!replaying) await save(messages({...context, messages: [...context.messages, message]}), reply.stop === 'complete' ? 'completed' : 'ready');
        stream.push({type: 'start', partial: message});
        stream.push({type: 'done', reason: reply.stop === 'complete' ? 'stop' : reply.stop === 'tools' ? 'toolUse' : 'length', message});
      } catch (error) {
        failure = error;
        const message: AssistantMessage = {role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: 'error', errorMessage: 'Model request failed',
          usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
        stream.push({type: 'error', reason: 'error', error: message});
      }
      return stream;
    }});
  const abort = () => agent.abort(); signal.addEventListener('abort', abort, {once: true});
  try {
    if (checkpointRequest.checkpoint && !request.prompt) await agent.continue();
    else await agent.prompt(request.prompt);
    if (yielded && latest && !failure) return {waiting: latest};
    if (failure) throw failure;
    const final = agent.state.messages.at(-1);
    if (!final || final.role !== 'assistant' || final.stopReason !== 'stop' || !final.content.some(c => c.type === 'text') ||
      final.content.some(c => !['text', 'thinking'].includes(c.type))) throw new RuntimeFault('INVALID_OUTPUT');
    return final.content.filter(c => c.type === 'text').map(c => c.text).join('');
  } finally {signal.removeEventListener('abort', abort);}
}

/** Native tool factories over explicit host capabilities, never NodeExecutionEnv for model tools. */
export function createExecutionTools(host: ExecutionEnvironment, names: readonly ('read' | 'write' | 'edit' | 'bash')[]): Tool[] {
  host = {...host};
  if (!host.policyVersion || !isAbsolute(host.cwd)) throw new RuntimeFault('INVALID_REQUEST');
  const contextSignal = (context: Context) => context.abortSignal ?? new AbortController().signal;
  const attempt = async <T>(operation: () => Promise<T>) => {try {return {ok: true as const, value: await operation()};} catch (e) {return {ok: false as const, error: new FileError('permission_denied', 'Host file operation failed', undefined, e instanceof Error ? e : undefined)};}};
  const unsupported = async () => ({ok: false as const, error: new FileError('not_supported', 'Capability not provided')});
  const env: ExecutionEnv = {
    cwd: host.cwd, absolutePath: path => attempt(() => host.resolvePath(path)),
    joinPath: parts => attempt(() => host.resolvePath(parts.join('/'))),
    readTextFile: (path, ctx) => attempt(async () => new TextDecoder().decode(await host.read(path, contextSignal(ctx)))),
    readBinaryFile: (path, ctx) => attempt(() => host.read(path, contextSignal(ctx))),
    writeFile: (path, content, ctx) => attempt(() => host.write(path, typeof content === 'string' ? new TextEncoder().encode(content) : content, contextSignal(ctx))),
    fileInfo: (path, ctx) => attempt(async () => {const {modifiedAt, ...rest} = await host.stat(path, contextSignal(ctx));return {...rest, mtimeMs: modifiedAt};}),
    exists: (path, ctx) => attempt(async () => {try {await host.stat(path, contextSignal(ctx));return true;} catch(e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;throw e;}}),
    openTextLineReader: unsupported, readTextLines: unsupported, appendFile: unsupported, renameFile: unsupported,
    listDir: unsupported, canonicalPath: unsupported, createDir: unsupported, remove: unsupported, createTempDir: unsupported, createTempFile: unsupported,
    cleanup: async () => {},
    exec: async (command, options, ctx) => {
      try {
        const signal = options?.timeout ? AbortSignal.any([contextSignal(ctx), AbortSignal.timeout(Math.ceil(options.timeout * 1000))]) : contextSignal(ctx);
        const result = await host.exec(command, signal);
        const {content, ...truncation} = truncateTail(result.output, options?.capture?.limits);
        // Host output is bounded; never advertise a spill file that was not actually retained.
        options?.onUpdate?.({kind: 'replace', output: {text: content, truncation}}, ctx);
        return {ok: true, value: {exitCode: result.exitCode, truncation}};
      } catch(e) {return {ok:false,error:new ExecutionError('unknown','Host process operation failed',e instanceof Error?e:undefined)};}
    },
  };
  const factories = {read: createReadTool, write: createWriteTool, edit: createEditTool, bash: createBashTool};
  return names.map(name => {
    if (!(name in factories)) throw new RuntimeFault('INVALID_REQUEST');
    const native = factories[name]();
    return {name, description: native.description, parameters: native.parameters as unknown as JsonObject,
      effect: name === 'read' ? 'read' : name === 'bash' ? 'external' : 'write', executionMode: 'sequential',
      resourceUnits: 1, policyVersion: host.policyVersion, output: 'content',
      execute: async (args, signal, invocation) => {
        const tool = native as ReturnType<typeof createReadTool>;
        const result = await tool.execute(invocation?.toolCallId ?? randomUUID(), args as never, () => {}, {env},
          {invocationId: invocation?.invocationId ?? randomUUID(), operationId: invocation?.operationId ?? '', turnId: '', getMemo: async () => undefined, setMemo: async () => {throw new RuntimeFault('CAPABILITY_UNAVAILABLE');}}, withAbortSignal(signal, BACKGROUND_CONTEXT));
        return JSON.parse(JSON.stringify({content: result.content.map(c => c.type === 'text' ? {kind:'text',text:c.text} : {kind:'image',data:c.data,mimeType:c.mimeType}), details: result.details}));
      }};
  });
}

export async function loadHarnessResources(options: ResourceLoadOptions): Promise<LoadedResources> {
  const signal = options.signal ?? new AbortController().signal;
  const sources = structuredClone(options.sources);
  if (!isAbsolute(options.cwd) || sources.some(s => !isAbsolute(s.path) || !s.version)) throw new RuntimeFault('INVALID_REQUEST');
  for (const source of sources) if (!await options.authorize(Object.freeze(source), signal)) throw new RuntimeFault('AUTHORITY_REQUIRED');
  if (signal.aborted) throw new RuntimeFault('CANCELLED');
  const env = new NodeExecutionEnv({cwd:options.cwd}), context = withAbortSignal(signal,BACKGROUND_CONTEXT);
  const skills = await loadSourcedSkills(env,sources.filter(s=>s.kind==='skills').map(source=>({path:source.path,source})),undefined,context);
  const templates = await loadSourcedPromptTemplates(env,sources.filter(s=>s.kind==='templates').map(source=>({path:source.path,source})),undefined,context);
  const loaded = {skills:skills.skills.map(s=>s.skill),templates:templates.promptTemplates.map(t=>t.promptTemplate),
    diagnostics:[...skills.diagnostics,...templates.diagnostics].map(d=>({kind:d.code,path:d.path,sourceVersion:d.source.version}))};
  if (new Set(loaded.skills.map(s=>s.name)).size !== loaded.skills.length || new Set(loaded.templates.map(s=>s.name)).size !== loaded.templates.length) throw new RuntimeFault('INVALID_REQUEST');
  return {...loaded,digest:createHash('sha256').update(JSON.stringify({sources,loaded})).digest('hex')};
}

/** Native proxy runs in an isolated worker because Pi 0.86.1 has no per-call fetch override.
 * The worker's fetch refuses redirects; no mutation of the application's global fetch. */
export function createProxyTransport(options: ProxyTransportOptions): ModelTransport {
  const model = structuredClone(options.model), token = options.authToken;
  const endpoint = model.proxyEndpoint ? new URL(model.proxyEndpoint) : undefined;
  if (!endpoint || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token) throw new RuntimeFault('INVALID_REQUEST');
  return request => new Promise((resolveReply,reject) => {
    if (request.signal.aborted) {reject(new RuntimeFault('CANCELLED'));return;}
    if (JSON.stringify(request.model) !== JSON.stringify(model) || request.deferred) {reject(new RuntimeFault('CAPABILITY_UNAVAILABLE'));return;}
    const worker = new Worker(new URL(import.meta.url),{workerData:{piRuntimeProxy:true,model,messages:request.messages,cap:request.maxOutputTokens,thinking:request.thinkingLevel,token}});
    let settled=false;
    const finish=(reply?:ModelReply,error?:RuntimeFault)=>{if(settled)return;settled=true;request.signal.removeEventListener('abort',cancel);void worker.terminate().then(()=>{if(error)reject(error);else resolveReply(reply!);},()=>reject(new RuntimeFault('MODEL_FAILED')));};
    const cancel=()=>finish(undefined,new RuntimeFault('CANCELLED'));
    request.signal.addEventListener('abort',cancel,{once:true});
    worker.on('message',reply=>reply?.error ? finish(undefined,new RuntimeFault('MODEL_FAILED')) : finish(reply));
    worker.on('error',()=>finish(undefined,new RuntimeFault('MODEL_FAILED')));
    worker.on('exit',()=>{if(!settled)finish(undefined,new RuntimeFault('MODEL_FAILED'));});
    if(request.signal.aborted)cancel();
  });
}
if (!isMainThread && workerData?.piRuntimeProxy === true) {
  const fetch = globalThis.fetch;
  globalThis.fetch = (input,init) => fetch(input,{...init,redirect:'error'});
  void (async()=>{try {
    const {model,messages:history,cap,token,thinking}=workerData;
    const reply=await streamProxy(providerModel(model,cap),normalizeContext({messages:fromCheckpoint({version:'1.0',taskId:'',state:'ready',messages:history},model,cap)}),
      {proxyUrl:model.proxyEndpoint,authToken:token,maxTokens:cap,...(thinking && thinking!=='off'?{reasoning:thinking}:{})}).result();
    if(!['stop','toolUse','length'].includes(reply.stopReason))throw Error();
    parentPort?.postMessage({content:reply.content.flatMap(fromPiContent),stop:reply.stopReason==='stop'?'complete':reply.stopReason==='toolUse'?'tools':'length',usage:{inputTokens:reply.usage.input,outputTokens:reply.usage.output || cap}});
  }catch{parentPort?.postMessage({error:true});}})();
}
