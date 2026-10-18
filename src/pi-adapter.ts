import {_iterSSEMessages} from 'openai/core/streaming';
// All Pi dependencies and representations stay in this module.
import {Agent, AgentHarness, MemorySessionRepo, BACKGROUND_CONTEXT, withAbortSignal,
  DEFAULT_COMPACTION_SETTINGS, estimateTokens, formatSkillsForSystemPrompt, streamProxy, loadSourcedSkills, loadSourcedPromptTemplates, createReadTool, createWriteTool, createEditTool, createBashTool, FileError, ExecutionError, truncateTail, type ExecutionEnv, type Context, type OperationRequest, type AgentLane, type AgentMessage} from '@earendil-works/pi-agent-core';
import {JsonlSessionRepo, laneState, operationMeta, operationResult, operationState, value, type Session, type JsonlSessionMetadata} from '@earendil-works/pi-agent-core/harness/session';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {isAbsolute,resolve,sep} from 'node:path';
import {isDeepStrictEqual, types as utilTypes} from 'node:util';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {randomUUID, createHash} from 'node:crypto';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {anthropicMessagesApi} from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import {
  createAssistantMessageEventStream,
  createModels,
  validateToolArguments,
  normalizeContext, isContextOverflow, isRecoverableLength,
  type DeferredHandle, type Api, type AssistantMessage, type Message, type Model, type TranscriptContext, type TSchema, type Provider,
} from '@earendil-works/pi-ai';
import type {AgentRequest, BaseRequest, ConversationCheckpoint, JsonObject, ModelConfig, ModelContent, ModelMessage, ModelReply, ModelTransport, PiTransportOptions, Tool, SessionRuntimeOptions, SessionRuntime, SessionRunRequest, SessionInfo, SessionBinding, HarnessSettings, HarnessControl, HarnessControlResult, ExecutionEnvironment, ResourceLoadOptions, LoadedResources, DeferredReference, ProxyTransportOptions, ModelRequest, ContextAdmissionPolicy, ContextAdmission, ModelOutcome, ToolFailureCategory} from './types.ts';
import {RuntimeFault, ProviderFailure, ContextAdmissionFailure, ModelFailure, ExecutionLimitFailure, safeAdmissionFact} from './errors.ts';
import {outputCap} from './policy.ts';
import {validateThinking, isJson, freeze} from './validation.ts';

/** Use Pi's native preparation and validation with the host's current trusted contract. No effects. */
export function prepareToolArguments(parameters:JsonObject,args:JsonObject):JsonObject {
  try {
    if (!isJson(parameters) || parameters.type!=='object' || !isJson(args) || !args || Array.isArray(args) || typeof args!=='object' ||
      Buffer.byteLength(JSON.stringify(parameters))>1_048_576 || Buffer.byteLength(JSON.stringify(args))>1_048_576) throw Error();
    const prepared=validateToolArguments({name:'tool',description:'',parameters:parameters as unknown as TSchema},
      {type:'toolCall',id:'prepare',name:'tool',arguments:args});
    if (!isJson(prepared) || !prepared || typeof prepared!=='object' || Array.isArray(prepared) || Buffer.byteLength(JSON.stringify(prepared))>1_048_576) throw Error();
    return prepared as JsonObject;
  } catch {throw new RuntimeFault('INVALID_TOOL');}
}

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

/** Pi already normalizes inclusive Provider totals into disjoint categories. */
function modelUsage(usage: AssistantMessage['usage'], outputCap: number): ModelReply['usage'] {
  const input = usage.input ?? 0, cacheReadTokens = usage.cacheRead ?? 0, cacheWriteTokens = usage.cacheWrite ?? 0;
  return {inputTokens: input + cacheReadTokens + cacheWriteTokens,
    outputTokens: usage.output || outputCap, cacheReadTokens, cacheWriteTokens};
}
function nativeUsage(usage: ModelReply['usage']): AssistantMessage['usage'] {
  const cacheRead = usage.cacheReadTokens ?? 0, cacheWrite = usage.cacheWriteTokens ?? 0;
  return {input: usage.inputTokens - cacheRead - cacheWrite, output: usage.outputTokens, cacheRead, cacheWrite,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
}

function providerModel(config: ModelConfig, maxTokens: number): Model<'openai-completions' | 'anthropic-messages'> {
  return {id: config.id, name: config.id, provider: config.provider, api: config.protocol, baseUrl: config.endpoint,
    contextWindow: config.contextWindow, maxTokens, reasoning: config.reasoning ?? false, input: [...(config.input ?? ['text'])],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    // Reuse Pi's binary thinking codec and exact reasoning_content continuation.
    ...(config.thinkingProtocol === 'mimo-chat' ? {compat: {thinkingFormat: 'deepseek',
      supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: true}} : {})};
}
interface ResponseEvidence {
  inputPresent: boolean; outputPresent: boolean; usageFinal: boolean;
  inputTokens?:number; outputTokens?:number; cacheRead?:number; cacheWrite?:number;
  stop?: ModelOutcome['stop']; category?: ModelOutcome['category']; invalidOutput?: boolean;
}
const contextCodes = ['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long'];
function responseCategory(body: any): ModelOutcome['category'] {
  const code = body?.error?.code ?? body?.error?.type ?? body?.code;
  return contextCodes.includes(code) ? 'context' : ['content_filter','safety','safety_error'].includes(code) ? 'safety' : undefined;
}
function observeUsage(event:any,evidence:ResponseEvidence,protocol:ModelConfig['protocol']) {
        const usage = protocol === 'openai-completions' ? event.usage ?? event.choices?.[0]?.usage : event.usage ?? event.message?.usage;
        if (usage && typeof usage === 'object') {
          const input = protocol === 'openai-completions' ? usage.prompt_tokens : usage.input_tokens;
          const output = protocol === 'openai-completions' ? usage.completion_tokens : usage.output_tokens;
          for (const count of [input,output]) if (count !== undefined && count !== null && (!Number.isSafeInteger(count) || count < 0)) {
            evidence.invalidOutput = true; throw new Error('Invalid Provider usage');
          }
          if(Number.isSafeInteger(input) && input>=0){evidence.inputPresent=true;evidence.inputTokens=input;}
          if(Number.isSafeInteger(output) && output>=0){evidence.outputPresent=true;evidence.outputTokens=output;}
          const read=protocol==='openai-completions'?usage.prompt_tokens_details?.cached_tokens:usage.cache_read_input_tokens;
          const write=protocol==='openai-completions'?usage.prompt_tokens_details?.cache_creation_tokens:usage.cache_creation_input_tokens;
          for(const count of [read,write])if(count!==undefined&&count!==null&&(!Number.isSafeInteger(count)||count<0)){evidence.invalidOutput=true;throw new Error('Invalid Provider cache usage');}
          if(protocol==='openai-completions'){
            if(input!==undefined && (read??0)+(write??0)>input){evidence.invalidOutput=true;throw new Error('Invalid Provider cache usage');}
          }else{
            if(read!==undefined)evidence.cacheRead=read;if(write!==undefined)evidence.cacheWrite=write;
            if(!Number.isSafeInteger((evidence.inputTokens??0)+(evidence.cacheRead??0)+(evidence.cacheWrite??0))){evidence.invalidOutput=true;throw new Error('Invalid Provider cache usage');}
          }
        }
}
/** Reuse the already pinned native SSE framing primitive. Pi alone decodes content/tools/reasoning.
 * Observe field presence before Pi normalizes missing fields to zero. No raw body enters observations.
 */
function observeResponse(response: Response, signal: AbortSignal, evidence: ResponseEvidence, protocol: ModelConfig['protocol']): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  let bytes = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > 8_388_608) {evidence.invalidOutput = true; throw new Error('Provider stream exceeds observation bound');}
    controller.enqueue(chunk);
  }}), {signal});
  const source = new Response(bounded, {status:response.status, headers:response.headers});
  const iterator = _iterSSEMessages(source, new AbortController());
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({async pull(controller) {
    try {
      const next = await iterator.next();
      if (next.done) {if (protocol === 'openai-completions' && evidence.stop) evidence.usageFinal = true; controller.close(); return;}
      const frame = next.value;
      if (frame.data.trim() === '[DONE]') evidence.usageFinal = true;
      else if (frame.data) {
        let event: any;
        try {event = JSON.parse(frame.data);} catch {evidence.invalidOutput = true; throw new Error('Invalid Provider stream');}
        evidence.category ??= responseCategory(event);
        observeUsage(event,evidence,protocol);
        const stop = protocol === 'openai-completions' ? event.choices?.[0]?.finish_reason : event.delta?.stop_reason;
        if (['stop','end_turn','stop_sequence'].includes(stop)) evidence.stop = 'complete';
        else if (['length','max_tokens','model_context_window_exceeded'].includes(stop)) evidence.stop = 'length';
        else if (['tool_calls','function_call','tool_use'].includes(stop)) evidence.stop = 'tools';
        else if (['content_filter','refusal','sensitive'].includes(stop)) {evidence.stop = 'error'; evidence.category = 'safety';}
        if (event.type === 'message_stop') evidence.usageFinal = true;
      }
      // Invalid JSON never reaches OpenAI's raw parse-error logger. Valid payload bytes stay unchanged.
      controller.enqueue(encoder.encode(frame.raw.join('\n') + '\n\n'));
    } catch (error) {
      evidence.category ??= evidence.invalidOutput ? 'invalid-output' : 'network';
      controller.error(new Error(signal.aborted ? 'CANCELLED' : 'Provider stream failed'));
    }
  }, async cancel() {await iterator.return(undefined);}});
  return new Response(body, {status:response.status, headers:response.headers});
}
export function createPiTransport(options: PiTransportOptions): ModelTransport {
  if (options.modelObservations !== undefined && options.modelObservations !== 'v1') throw new RuntimeFault('INVALID_REQUEST');
  if (!options.apiKey.trim()) throw new RuntimeFault('INVALID_REQUEST');
  const config = Object.freeze(structuredClone(options.model)), apiKey = options.apiKey, fetch = options.fetch;
  return async request => {
    try {
    if (!isDeepStrictEqual(config, request.model)) throw new RuntimeFault('CONFIGURATION_CHANGED');
    if (request.signal.aborted) throw new RuntimeFault('CANCELLED');
    if (request.deferred) throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
    validateThinking(config, request.thinkingLevel, request.maxOutputTokens);
    }catch(error){
      if(!options.modelObservations)throw error;
      const reason=error instanceof RuntimeFault?error.reason:'INVALID_REQUEST';
      throw new ModelFailure({model:{provider:request.model.provider,id:request.model.id,protocol:request.model.protocol},stop:reason==='CANCELLED'?'cancelled':'unknown',category:'invalid-request',physicalStatus:'not-sent',usageFinal:true,usage:{inputTokens:{kind:'known',value:0},outputTokens:{kind:'known',value:0}},diagnostic:reason==='CANCELLED'?'CANCELLED':'REQUEST_FAILED'},reason);
    }
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
    let observedCategory: ModelOutcome['category'];
    let httpStatus: number | undefined;
    let nativeReply: AssistantMessage | undefined;
    const evidence: ResponseEvidence = {inputPresent:false,outputPresent:false,usageFinal:false};
    const outcome = (stop: ModelOutcome['stop']): ModelOutcome => {
      const measured = {inputTokens:(evidence.inputTokens??0)+(evidence.cacheRead??0)+(evidence.cacheWrite??0),outputTokens:evidence.outputTokens??0};
      const known = (present: boolean, value: number) => present && Number.isSafeInteger(value) && value >= 0 ? {kind:'known' as const,value} : {kind:'unknown' as const,...(Number.isSafeInteger(value)&&value>0?{reported:value}:{})};
      const failure = evidence.invalidOutput?'invalid-output':observedCategory ?? evidence.category ?? category;
      const responseModel = nativeReply?.responseModel;
      return {model:{provider:config.provider,id:config.id,protocol:config.protocol},
        ...(responseModel && /^[A-Za-z0-9_.:/-]{1,256}$/.test(responseModel) && !responseModel.includes(apiKey) ? {responseModel} : {}),
        stop:evidence.stop ?? stop,
        ...(failure ? {category:failure} : stop === 'error' || stop === 'cancelled' ? {category:'unknown' as const} : {}),
        physicalStatus:httpStatus === undefined || (httpStatus < 400 && !evidence.usageFinal && (stop === 'error' || stop === 'cancelled')) ? 'unknown' : 'response-received',
        ...(httpStatus === undefined ? {} : {httpStatus}), usageFinal:evidence.usageFinal,
        usage:{inputTokens:known(evidence.inputPresent,measured.inputTokens),outputTokens:known(evidence.outputPresent,measured.outputTokens)},
        diagnostic:failure === 'context' ? 'CONTEXT_LIMIT' : stop === 'cancelled' ? 'CANCELLED' :
          stop === 'length' ? 'OUTPUT_LIMIT' : stop === 'complete' || stop === 'tools' ? 'COMPLETE' : 'REQUEST_FAILED'};
    };
    const guardedFetch: typeof globalThis.fetch = async (input, init) => {
      try {
        const response = await (fetch ?? globalThis.fetch)(input, {...init, redirect: 'error'});
        httpStatus = response.status;
        if (options.modelObservations && !response.ok) {
          if ([401,403].includes(response.status)) observedCategory = 'authentication';
          try {
            const clone = response.clone(), reader = clone.body?.getReader();
            if (reader) {
              const chunks: Uint8Array[] = []; let bytes = 0;
              try {for (;;) {const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 65536) break; chunks.push(part.value);}
                if (bytes <= 65536) {const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                  observedCategory ??= responseCategory(body);observeUsage(body,evidence,config.protocol); evidence.usageFinal = true;
                }
              } finally {void reader.cancel().catch(()=>{});}
            }
          } catch { /* Missing structured cause stays unknown; never persist raw body. */ }
        }
        category = response.status === 402 ? 'quota' : response.status === 429 ? 'rate-limit' :
          (options.modelObservations ? response.status>=500 && response.status<=599 : [500,502,503,504].includes(response.status)) ? 'unavailable' : undefined;
        return options.modelObservations && response.ok ? observeResponse(response, request.signal, evidence, config.protocol) : response;
      } catch (error) {category = 'network'; throw error;}
    };
    try {
      const api = config.protocol === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi();
      const stream = api.streamSimple(model, context, {apiKey, signal: request.signal, maxTokens: request.maxOutputTokens,
        ...(request.thinkingLevel && request.thinkingLevel !== 'off' ? {reasoning: request.thinkingLevel} : {}),
        maxRetries: 0, cacheRetention: 'none', transport: 'sse', fetch: guardedFetch});
      const reply = await stream.result(); nativeReply = reply;
      if (!['stop', 'toolUse', 'length'].includes(reply.stopReason) || (options.modelObservations && (evidence.category==='safety'||evidence.invalidOutput))) {
        if (options.modelObservations) {
          const observed = outcome(reply.stopReason === 'aborted' ? 'cancelled' : 'error');
          if (category && !['context','safety','invalid-output'].includes(observed.category??'')) throw new ProviderFailure(category, observed);
          throw new ModelFailure(observed, reply.stopReason === 'aborted' ? 'CANCELLED' : evidence.invalidOutput ? 'INVALID_OUTPUT' : 'MODEL_FAILED');
        }
        if (category) throw new ProviderFailure(category);
        throw new RuntimeFault('MODEL_FAILED');
      }
      if (reply.content.some(content => !['text', 'toolCall', 'thinking'].includes(content.type))) throw new RuntimeFault('INVALID_OUTPUT');
      return {content: reply.content.flatMap(fromPiContent),
        stop: reply.stopReason === 'stop' ? 'complete' : reply.stopReason === 'toolUse' ? 'tools' : 'length',
        usage: options.modelObservations ? {inputTokens:(evidence.inputTokens??0)+(evidence.cacheRead??0)+(evidence.cacheWrite??0),outputTokens:evidence.outputPresent?evidence.outputTokens!:request.maxOutputTokens} : modelUsage(reply.usage, request.maxOutputTokens),
        ...(options.modelObservations ? {outcome:outcome(reply.stopReason === 'stop' ? 'complete' : reply.stopReason === 'toolUse' ? 'tools' : 'length')} : {})};
    } catch (error) {if (error instanceof RuntimeFault) throw error; if (options.modelObservations) {const observed = outcome(request.signal.aborted ? 'cancelled' : 'error'); if (category && !['context','safety','invalid-output'].includes(observed.category??'')) throw new ProviderFailure(category, observed); throw new ModelFailure(observed, request.signal.aborted ? 'CANCELLED' : 'MODEL_FAILED');} if (category) throw new ProviderFailure(category); throw new RuntimeFault('MODEL_FAILED');}
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
/** Same synchronous guard for SDK candidates and the host's final trusted projection.
 * Byte weighting and host allowances are conservative admission policy, never a tokenizer guarantee.
 */
export function admitModelRequest(request: ModelRequest, policy: ContextAdmissionPolicy): Readonly<ContextAdmission> {
  const integer = (n: unknown, min = 0): n is number => Number.isSafeInteger(n) && (n as number) >= min;
  // Inspect data descriptors before reading any user projection property. Object.freeze does not freeze getters.
  const ancestors=new Set<object>();
  const dto=(value:unknown, root=false):void => {
    if(value===null || value===undefined || ['string','number','boolean'].includes(typeof value))return;
    if(typeof value!=='object' || utilTypes.isProxy(value) || ancestors.has(value))throw new RuntimeFault('INVALID_REQUEST');
    if(!Array.isArray(value) && Object.getPrototypeOf(value)!==Object.prototype)throw new RuntimeFault('INVALID_REQUEST');
    ancestors.add(value);
    for(const key of Reflect.ownKeys(value)){
      const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=='string' || !('value' in property))throw new RuntimeFault('INVALID_REQUEST');
      if(root && key==='signal'){if(!(property.value instanceof AbortSignal)||utilTypes.isProxy(property.value))throw new RuntimeFault('INVALID_REQUEST');}
      else dto(property.value);
    }
    ancestors.delete(value);
  };
  dto(request,true);dto(policy);
  if (request.signal.aborted) throw new RuntimeFault('CANCELLED');
  if (Object.getPrototypeOf(request) !== Object.prototype || Object.getPrototypeOf(request.model) !== Object.prototype ||
    !policy || typeof policy.policyVersion !== 'string' || !policy.policyVersion || policy.policyVersion.length > 256 ||
    /[\r\n\u0000]/.test(policy.policyVersion) || !integer(policy.protocolOverheadTokens) || !integer(policy.safetyMarginTokens) ||
    (policy.imageTokens !== undefined && !integer(policy.imageTokens, 1)) ||
    Object.keys(policy).some(key => !['policyVersion', 'protocolOverheadTokens', 'safetyMarginTokens', 'imageTokens'].includes(key)) ||
    !integer(request.model.contextWindow, 1) || !integer(request.maxOutputTokens, 1) ||
    (request.model.maxOutputTokens !== undefined && (!integer(request.model.maxOutputTokens, 1) || request.maxOutputTokens > request.model.maxOutputTokens)) ||
    !['openai-completions', 'anthropic-messages'].includes(request.model.protocol) || !Array.isArray(request.messages) ||
    !isJson(request.messages) || request.messages.some(m => !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.text !== 'string'))
    throw new RuntimeFault('INVALID_REQUEST');
  validateThinking(request.model, request.thinkingLevel, request.maxOutputTokens);
  let imageCount = 0;
  for (const message of request.messages) {
    if (message.images !== undefined && (!Array.isArray(message.images) || message.images.some(image =>
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType) || typeof image.data !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)))) throw new RuntimeFault('INVALID_REQUEST');
    imageCount += message.images?.length ?? 0;
  }
  if (imageCount && (!request.model.input?.includes('image') || policy.imageTokens === undefined))
    throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
  // Native system estimates are zero; count the actual system + tool declarations as text as well.
  const native = fromCheckpoint({version:'1.0', taskId:'admission', state:'ready', messages:request.messages}, request.model, request.maxOutputTokens);
  const piEstimateTokens = native.reduce((total, message) => total + estimateTokens(message.role === 'system' ?
    {role:'user', content:JSON.stringify({text:message.content, tools:message.toolsAdded ?? []}), timestamp:0} : message), 0);
  const envelopeBytes = Buffer.byteLength(JSON.stringify(request.messages));
  const imageTokens = imageCount * (policy.imageTokens ?? 0);
  const budgetedInputTokens = Math.max(piEstimateTokens, envelopeBytes) + imageTokens;
  const requiredTokens = budgetedInputTokens + policy.protocolOverheadTokens + policy.safetyMarginTokens + request.maxOutputTokens;
  if (!integer(requiredTokens) || !integer(piEstimateTokens)) throw new RuntimeFault('INVALID_REQUEST');
  const admission: ContextAdmission = {basis:'pi-estimate-with-byte-envelope', policyVersion:policy.policyVersion,
    model:{provider:request.model.provider, id:request.model.id, protocol:request.model.protocol}, contextWindow:request.model.contextWindow,
    piEstimateTokens, envelopeBytes, budgetedInputTokens, protocolOverheadTokens:policy.protocolOverheadTokens, imageTokens,
    safetyMarginTokens:policy.safetyMarginTokens, reservedOutputTokens:request.maxOutputTokens, requiredTokens};
  if (requiredTokens > request.model.contextWindow) throw new ContextAdmissionFailure(admission);
  // Caller must dispatch this exact projection; a fresh projection must be admitted again.
  freeze(request);
  return Object.freeze({...admission, model:Object.freeze(admission.model)});
}

// Internal native-generation identity; never passed to host transports or public schemas.
export type DriverTransport = (request: import('./types.ts').ModelRequest, call?: {id:string; recovered:boolean; nativeAttempt?:number; recoveryParentId?:string}, beforeAttempt?:()=>Promise<void>) => Promise<ModelReply>;
export interface DriverPolicy {mode:'worker' | 'text' | 'agent'; runId:string; hasConsumption():boolean; toolAdmission?: import('./types.ts').ToolAdmissionPolicy; recordAdmission?(fact:import('./types.ts').ToolAdmissionFact):Promise<void>; claimRecovery(id:string):boolean}
type ControlGuard = <T>(operation: () => Promise<T>) => Promise<T>;
const directControl: ControlGuard = operation => operation();
interface AdmissionLedger {
  version:'1'; taskId:string; purpose?:string; policyVersion:string; authoritySessionId:string;
  consumptionBound:boolean;counts:{name:string;used:number}[]; terminal:boolean; facts:import('./types.ts').ToolAdmissionFact[];
}
const admissionAddress = (taskId:string,purpose?:string)=>value<AdmissionLedger>('sdk.tool-admission.v1',createHash('sha256').update(JSON.stringify([taskId,purpose??null])).digest('hex'));
function safeAdmissionLedger(ledger:AdmissionLedger,taskId:string,purpose?:string):AdmissionLedger{
  const label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\r\n\u0000]/.test(v);
  if(!ledger||ledger.version!=='1'||ledger.taskId!==taskId||ledger.purpose!==purpose||!label(ledger.policyVersion)||
    typeof ledger.authoritySessionId!=='string'||!/^[a-zA-Z0-9_.-]{1,128}$/.test(ledger.authoritySessionId)||typeof ledger.terminal!=='boolean'||typeof ledger.consumptionBound!=='boolean'||
    !Array.isArray(ledger.counts)||!Array.isArray(ledger.facts)||ledger.facts.length>128||
    ledger.counts.some(c=>!c||!label(c.name)||!Number.isSafeInteger(c.used)||c.used<0||c.used>2)||new Set(ledger.counts.map(c=>c.name)).size!==ledger.counts.length)throw new RuntimeFault('STATE_FAILED');
  const facts=ledger.facts.map(safeAdmissionFact);
  if(facts.some(f=>f.taskId!==taskId||f.purpose!==purpose||f.policyVersion!==ledger.policyVersion))throw new RuntimeFault('STATE_FAILED');
  return{version:'1',taskId,...(purpose===undefined?{}:{purpose}),policyVersion:ledger.policyVersion,authoritySessionId:ledger.authoritySessionId,
    terminal:ledger.terminal,consumptionBound:ledger.consumptionBound,counts:ledger.counts.map(c=>({name:c.name,used:c.used})),facts};
}

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

export async function drive(config: ModelConfig, request: BaseRequest, transport: DriverTransport, signal: AbortSignal, tools: readonly Tool[] = [], activeModel: () => ModelConfig = () => config, _bind?: (binding: SessionBinding) => void, _control?: (command: HarnessControl) => Promise<void>, guard: ControlGuard = directControl, policy?:DriverPolicy): Promise<string | {waiting: ConversationCheckpoint} | {suspended: SessionBinding}> {
  if(policy?.toolAdmission)throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
  const legacy = request as AgentRequest;
  // Existing durable checkpoints retain their versioned semantics until migration.
  // Ordinary runs use the native harness without inventing a persistent contract.
  return legacy.checkpoint || legacy.saveCheckpoint || legacy.shouldYield
    ? driveCheckpoint(config, request, transport, signal, tools, activeModel, guard)
    : driveHarness(config, request, transport, signal, tools, activeModel, undefined, guard, policy);
}

async function driveHarness(config: ModelConfig, request: BaseRequest, transport: DriverTransport,
  signal: AbortSignal, tools: readonly Tool[], activeModel: () => ModelConfig,
  persistent?: {session: Session; reconcile: SessionRuntimeOptions['reconcile']; bindOperation: SessionRuntimeOptions['bindOperation']; bind: (binding: SessionBinding) => void; settings: HarnessSettings; extensions?: SessionRuntimeOptions['extensions']; admissionStore:{read():Promise<AdmissionLedger|undefined>;hasTaskBinding():Promise<boolean>;authorityId():string;write(state:AdmissionLedger):Promise<void>}; activate(lane: AgentLane, harness: Awaited<ReturnType<typeof AgentHarness.create>>['harness'], binding: SessionBinding): void; deactivate(): Promise<void>}, guard: ControlGuard = directControl, policy?:DriverPolicy): Promise<string | {suspended: SessionBinding}> {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const repo = new MemorySessionRepo();
  const model = providerModel(config, outputCap(request.limits));
  let failure: unknown;
  let harness: Awaited<ReturnType<typeof AgentHarness.create>>['harness'] | undefined;
  const callIds = new Set<string>();
  let serializeBatch = false;
  let modelCall: Parameters<DriverTransport>[1];
  let toolTail: Promise<void> = Promise.resolve();
  let phaseTools: readonly Tool[] = tools;
  let activeOperationId='';
  const correctionCounts = new Map<string,number>();
  let admissionLedger:AdmissionLedger|undefined;
  type PreparedCall = {args:JsonObject; fact:import('./types.ts').ToolAdmissionFact};
  const batchPrepared = new Map<string,PreparedCall>();
  const digest = (input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const recordFacts=async(facts:import('./types.ts').ToolAdmissionFact[],terminal:boolean)=>{
    const safe=facts.map(safeAdmissionFact);
    if(admissionLedger){
      admissionLedger={...admissionLedger,counts:[...correctionCounts].map(([name,used])=>({name,used})),terminal:admissionLedger.terminal||terminal,facts:[...admissionLedger.facts,...safe].slice(-128)};
      await guard(()=>persistent!.admissionStore.write(admissionLedger!));
    }
    for(const fact of safe)await policy!.recordAdmission!(fact);
  };
  const rejectCalls=async(calls:Extract<ModelContent,{kind:'tool'}>[],selected:import('./types.ts').ToolView,code:NonNullable<import('./types.ts').ToolAdmissionFact['code']>)=>{
    await recordFacts(calls.map(call=>({version:'1',taskId:request.taskId,runId:policy!.runId,...(request.purpose===undefined?{}:{purpose:request.purpose}),
      ...(persistent?{session:{sessionId:persistent.session.metadata.id,branch:(request as SessionRunRequest).branch??'main',operationId:activeOperationId}}:{}),
      callId:call.id,name:tools.some(t=>t.name===call.name)?call.name:'unavailable',policyVersion:policy!.toolAdmission!.policyVersion,viewVersion:selected.version,viewDigest:digest(selected),
      rawArgumentsDigest:digest(call.arguments),disposition:'rejected',code,correctionsUsed:correctionCounts.get(call.name)??0,terminal:true})),true);
  };
  const view = async () => {
    const admission = policy?.toolAdmission;
    if (!admission) return undefined;
    if (typeof admission.policyVersion!=='string'||!admission.policyVersion||admission.policyVersion.length>256||/[\r\n\u0000]/.test(admission.policyVersion)||![0,1].includes(admission.correctionLimit) || typeof admission.view !== 'function') throw new RuntimeFault('INVALID_REQUEST');
    const selected = await guard(() => admission.view({taskId:request.taskId,runId:policy.runId,...(request.purpose===undefined?{}:{purpose:request.purpose}),signal}));
    if (!isJson(selected) || typeof selected.version!=='string'||!selected.version || selected.version.length>256||/[\r\n\u0000]/.test(selected.version)||Object.keys(selected).some(k=>!['version','tools'].includes(k)) || !Array.isArray(selected.tools) || Buffer.byteLength(JSON.stringify(selected))>1_048_576) throw new RuntimeFault('INVALID_TOOL');
    const names = new Set<string>();
    for (const item of selected.tools) {
      if (!item || !tools.some(t=>t.name===item.name) || names.has(item.name) || !isJson(item.parameters) || !item.parameters || item.parameters.type!=='object' ||
        (item.description!==undefined&&typeof item.description!=='string') ||
        Object.keys(item).some(k=>!['name','parameters','description'].includes(k))) throw new RuntimeFault('INVALID_TOOL');
      names.add(item.name);
    }
    return freeze(structuredClone(selected));
  };
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
      let reply: ModelReply | undefined;
      try {
        assertOpen();
        const selected = await view();
        if (selected) {
          phaseTools = tools.map(tool=>{const item=selected.tools.find(item=>item.name===tool.name);return item?{...tool,
            parameters:isDeepStrictEqual(tool.parameters,item.parameters)?item.parameters:{type:'object',allOf:[tool.parameters,item.parameters]},description:item.description??tool.description}:tool;});
          await guard(()=>harness!.setTools(nativeTools(),context));
        }
        const projected = messages(transcript);
        if (selected) {
          for (const message of projected) if (message.role==='system') message.tools=[];
          let system=projected.find(m=>m.role==='system');
          if(!system){system={role:'system',text:''};projected.unshift(system);}
          system.tools=selected.tools.map(item=>{const tool=phaseTools.find(t=>t.name===item.name)!;return{name:tool.name,description:tool.description,parameters:tool.parameters};});
        }
        try{reply = await transport({model: config, messages: projected,
          maxOutputTokens: Math.min(outputCap(request.limits), maxTokens ?? outputCap(request.limits)),
          signal: nativeSignal ? AbortSignal.any([signal, nativeSignal]) : signal,
          ...(request.thinkingLevel === undefined ? {} : {thinkingLevel: request.thinkingLevel}),
          ...(deferred ? {deferred} : startDeferred ? {deferred:{action:'start' as const}} : {})}, modelCall, selected ? async()=>{
            assertOpen();
            if(!isDeepStrictEqual(selected,await view())){await rejectCalls([],selected,'STALE_VIEW');throw new RuntimeFault('INVALID_TOOL');}
            assertOpen();
          } : undefined);}
        finally{
          // Empty records left by pre-dispatch denial do not establish another
          // authority after this Task has consumed elsewhere. Budget ownership
          // remains held until this native drive (and physical IO) settles.
          if(admissionLedger&&!admissionLedger.consumptionBound&&policy!.hasConsumption()){
            admissionLedger={...admissionLedger,consumptionBound:true};
            await guard(()=>persistent!.admissionStore.write(admissionLedger!));
          }
        }
        assertOpen();
        const calls = reply.content.filter(c => c.kind === 'tool');
        if(selected && !isDeepStrictEqual(selected,await view())){await rejectCalls(calls,selected,'STALE_VIEW');throw new RuntimeFault('INVALID_TOOL');}
        if ((calls.length > 0) !== (reply.stop === 'tools')) {if(selected)await rejectCalls(calls,selected,'INVALID_CALL');throw new RuntimeFault('INVALID_OUTPUT');}
        // Keep whole-batch admission before any native tool can take effect.
        batchPrepared.clear();
        const invalid=new Map<string,'STRUCTURE_MISMATCH'|'HOOK_REJECTED'>();
        for (const call of calls) {
          if (callIds.has(call.id)) {if(selected)await rejectCalls(calls,selected,'INVALID_CALL');throw new RuntimeFault('INVALID_TOOL');}
          const tool = phaseTools.find(tool => tool.name === call.name);
          if (!tool || selected&&!selected.tools.some(t=>t.name===call.name)){if(selected)await rejectCalls(calls,selected,'TOOL_UNAVAILABLE');throw new RuntimeFault('INVALID_TOOL');}
          try {
            if(selected){
              const raw=structuredClone(call.arguments),compatible=tool.prepareArguments?tool.prepareArguments(raw):raw;
              let prepared=prepareToolArguments(tool.parameters,compatible);
              if(tool.argumentPolicy!=='native' && !isDeepStrictEqual(compatible,prepared))throw new RuntimeFault('INVALID_TOOL');
              if(persistent?.extensions?.beforeTool){
                let decision:Awaited<ReturnType<NonNullable<NonNullable<SessionRuntimeOptions['extensions']>['beforeTool']>>>;
                try{decision=await guard(()=>persistent.extensions!.beforeTool!({name:tool.name,arguments:structuredClone(prepared)}));}
                catch{invalid.set(call.id,'HOOK_REJECTED');throw new RuntimeFault('INVALID_TOOL');}
                if(decision?.block){invalid.set(call.id,'HOOK_REJECTED');throw new RuntimeFault('INVALID_TOOL');}
                if(decision?.arguments){const next=prepareToolArguments(tool.parameters,decision.arguments);if(tool.argumentPolicy!=='native'&&!isDeepStrictEqual(decision.arguments,next))throw new RuntimeFault('INVALID_TOOL');prepared=next;}
              }
              batchPrepared.set(call.id,{args:prepared,fact:{version:'1',taskId:request.taskId,runId:policy!.runId,...(request.purpose===undefined?{}:{purpose:request.purpose}),
                ...(persistent?{session:{sessionId:persistent.session.metadata.id,branch:(request as SessionRunRequest).branch??'main',operationId:activeOperationId}}:{}),
                callId:call.id,name:call.name,policyVersion:policy!.toolAdmission!.policyVersion,viewVersion:selected.version,viewDigest:digest(selected),rawArgumentsDigest:digest(call.arguments),disposition:'ready',correctionsUsed:correctionCounts.get(call.name)??0,terminal:false}});
            }else validateToolArguments({...tool, parameters: tool.parameters as unknown as TSchema},
              {type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments});
          }
          catch {if(!selected)throw new RuntimeFault('INVALID_TOOL');invalid.set(call.id,invalid.get(call.id)??'STRUCTURE_MISMATCH');}
          callIds.add(call.id);
        }
        if(selected){
          // Hooks may await trusted product state; their replacements cannot keep
          // an otherwise stale phase alive while the batch is being prepared.
          if(!isDeepStrictEqual(selected,await view())){await rejectCalls(calls,selected,'STALE_VIEW');throw new RuntimeFault('INVALID_TOOL');}
          const names=new Set(calls.filter(c=>invalid.has(c.id)).map(c=>c.name));
          const terminal=[...invalid.values()].includes('HOOK_REJECTED')||[...names].some(name=>(correctionCounts.get(name)??0)>=policy!.toolAdmission!.correctionLimit);
          for(const name of names)correctionCounts.set(name,(correctionCounts.get(name)??0)+1);
          for(const call of calls){
            if(invalid.size){
              const fact:import('./types.ts').ToolAdmissionFact={version:'1',taskId:request.taskId,runId:policy!.runId,...(request.purpose===undefined?{}:{purpose:request.purpose}),
                ...(persistent?{session:{sessionId:persistent.session.metadata.id,branch:(request as SessionRunRequest).branch??'main',operationId:activeOperationId}}:{}),
                callId:call.id,name:call.name,policyVersion:policy!.toolAdmission!.policyVersion,viewVersion:selected.version,viewDigest:digest(selected),rawArgumentsDigest:digest(call.arguments),
                disposition:invalid.has(call.id)?'rejected':'deferred',code:invalid.has(call.id)?terminal?'CORRECTION_EXHAUSTED':invalid.get(call.id)!:'BATCH_DEFERRED',correctionsUsed:correctionCounts.get(call.name)??0,terminal};
              batchPrepared.set(call.id,{args:{},fact});
            }
          }
          await recordFacts([...batchPrepared.values()].map(c=>c.fact),terminal);
          reply={...reply,content:reply.content.map(c=>c.kind==='tool'?{...c,arguments:batchPrepared.get(c.id)!.args}:c)};
          await guard(()=>harness!.setTools(nativeTools(),context));
        }
        // Harness 0.86.1 uses only run.settings.toolExecution; unlike Agent,
        // it does not honor a called tool's sequential override. Preserve the
        // SDK batch contract at the effect boundary, without another tool loop.
        serializeBatch = calls.some(call => tools.find(tool => tool.name === call.name)?.executionMode === 'sequential');
        const chosen = providerModel(activeModel(), outputCap(request.limits));
        if (reply.stop === 'deferred' && (!config.deferred || !reply.deferred)) throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
        const stopReason = reply.stop === 'deferred' ? 'deferred' : reply.stop === 'complete' ? 'stop' : reply.stop === 'length' ? 'length' : 'toolUse';
        const message: AssistantMessage = {role: 'assistant', api: chosen.api, provider: chosen.provider, model: chosen.id,
          content: reply.content.map(toPiContent), timestamp: Date.now(),
          stopReason, ...(reply.deferred ? {deferred:{...reply.deferred,provider:model.provider,modelId:model.id,api:model.api}} : {}),
          usage: nativeUsage(reply.usage)};
        const actualModel = providerModel(activeModel(),Math.min(outputCap(request.limits),activeModel().maxOutputTokens??outputCap(request.limits)));
        const recoverable = isContextOverflow(message, actualModel.contextWindow) || isRecoverableLength(message, actualModel.maxTokens);
        if (reply.stop === 'length' && policy?.mode !== 'agent') failure ??= new RuntimeFault('INVALID_OUTPUT');
        else if (recoverable && (!modelCall || modelCall.recovered || !policy?.claimRecovery(modelCall.id)))
          failure ??= new RuntimeFault(reply.stop === 'length' ? 'INVALID_OUTPUT' : 'MODEL_FAILED');
        result.push({type: 'start', partial: message});
        result.push({type: 'done', reason: stopReason, message});
      } catch (error) {
        const observed = error instanceof ModelFailure || error instanceof ProviderFailure ? error.outcome : undefined;
        const overflow = error instanceof ModelFailure && error.reason==='MODEL_FAILED' && observed?.category==='context' && observed.physicalStatus==='response-received' &&
          policy?.mode==='agent' && modelCall && !modelCall.recovered && policy.claimRecovery(modelCall.id);
        const retryable = persistent?.settings.retry?.enabled && !modelCall?.recovered && error instanceof ProviderFailure && error.category !== 'quota' && observed?.physicalStatus!=='unknown';
        if (!retryable && !overflow) failure ??= error;
        const chosen = providerModel(activeModel(), outputCap(request.limits));
        const message: AssistantMessage = {role: 'assistant', api: chosen.api, provider: chosen.provider, model: chosen.id,
          content: policy?.toolAdmission ? [] : reply?.content.map(toPiContent) ?? [], timestamp: Date.now(), stopReason: 'error',
          errorMessage: observed?.category === 'context' ? 'context_length_exceeded' : error instanceof ProviderFailure ?
            ({quota:'quota exceeded', 'rate-limit':'rate limit', unavailable:'service unavailable', network:'network error'} as const)[error.category] :
            error instanceof RuntimeFault ? error.reason : 'MODEL_FAILED',
          usage: reply ? nativeUsage(reply.usage) : observed ? nativeUsage({inputTokens:observed.usage.inputTokens.kind==='known'?observed.usage.inputTokens.value:0,outputTokens:observed.usage.outputTokens.kind==='known'?observed.usage.outputTokens.value:0}) : {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
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
  const nativeTools = (): import('@earendil-works/pi-agent-core').AgentHarnessTool<object | undefined>[] => phaseTools.map(tool => ({name: tool.name, label: tool.name, description: tool.description,
        parameters: ([...batchPrepared.values()].some(c=>c.fact.name===tool.name&&c.fact.disposition!=='ready')?{type:'object',properties:{},additionalProperties:false}:tool.parameters) as unknown as TSchema, replay: tool.replay ?? 'never' as const,
        ...(tool.executionMode === undefined ? {} : {executionMode: tool.executionMode}),
        execute: async (id, args, _update, _toolContext, invocation, toolContext) => {
          const prepared=batchPrepared.get(id);
          if(policy?.toolAdmission){
            if(!prepared || !isDeepStrictEqual(args,prepared.args))throw new RuntimeFault('INVALID_TOOL');
            if(prepared.fact.disposition!=='ready')return{content:[{type:'text',text:JSON.stringify({status:prepared.fact.disposition,code:prepared.fact.code,executed:false,terminal:prepared.fact.terminal})}],details:null,terminate:prepared.fact.terminal};
          }
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
              return nativeToolResult(tool, value);
            } catch (error) {failure ??= error; throw error;}
          };
          if (!serializeBatch) return perform();
          const pending = toolTail.then(perform);
          toolTail = pending.then(() => {}, () => {});
          return pending;
        },
      }));
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
      tools: nativeTools(),
    }, context));
    harness = attached.harness;
    harness.hooks.on('before_request', async event => {
      try {
        const state = (await guard(() => session.getValue(operationState(event.runId), context)))?.value;
        const recoveryParentId = state && 'task' in state && state.task.reason === 'overflow' &&
          state.task.boundary.kind === 'resume_checkpoint' ? `${event.runId}:${state.task.boundary.resumeAfter.triggerEntryId}` : undefined;
        modelCall = event.step === 'assistant' && state?.at === 'assistant.ready' ?
          {id: `${event.runId}:${state.generationContext.triggerEntryId}`, recovered: state.generationContext.overflowRecoveryUsed, nativeAttempt:event.attempt} :
          {id: randomUUID(), recovered:false, ...(recoveryParentId ? {recoveryParentId} : {})};
      } catch (error) {failure ??= error;}
      return undefined;
    });
    const extensions = persistent?.extensions;
    if (extensions?.transformContext) harness.hooks.on('transform_context', async e => {
      const result = await guard(async () => extensions.transformContext!({messages: messages(e), system:e.systemPrompt}));
      return result ? {...(result.messages ? {messages:fromCheckpoint({version:'1.0',taskId:'',state:'ready',messages:result.messages},config,outputCap(request.limits))} : {}), ...(result.system === undefined ? {} : {systemPrompt:result.system})} : undefined;
    });
    if (extensions?.beforeRequest) harness.hooks.on('before_request', async e => {await guard(async () => extensions.beforeRequest!({step:e.step,attempt:e.attempt}));return undefined;});
    if (extensions?.beforeTool && !policy?.toolAdmission) harness.hooks.on('before_tool', async e => {const result = await guard(async () => extensions.beforeTool!({name:e.toolName,arguments:e.args as JsonObject}));return result ? {...(result.arguments ? {args:result.arguments} : {}),...(result.block ? {block:{reason:result.block,terminate:true}} : {})} : undefined;});
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
      if(policy?.toolAdmission){
        const saved=await guard(()=>persistent.admissionStore.read());
        if(!saved?.consumptionBound&&policy.hasConsumption()&&!await guard(()=>persistent.admissionStore.hasTaskBinding()))throw new RuntimeFault('STATE_FAILED');
        if(saved && (saved.version!=='1'||saved.taskId!==request.taskId||saved.purpose!==request.purpose||saved.policyVersion!==policy.toolAdmission.policyVersion||
          typeof saved.terminal!=='boolean'||!Array.isArray(saved.counts)||saved.counts.some(c=>!tools.some(t=>t.name===c.name)||!Number.isSafeInteger(c.used)||c.used<0||c.used>2)||!Array.isArray(saved.facts)))throw new RuntimeFault('STATE_FAILED');
        admissionLedger=saved??{version:'1',taskId:request.taskId,...(request.purpose===undefined?{}:{purpose:request.purpose}),policyVersion:policy.toolAdmission.policyVersion,authoritySessionId:persistent.admissionStore.authorityId(),consumptionBound:false,counts:[],terminal:false,facts:[]};
        for(const counter of admissionLedger.counts)correctionCounts.set(counter.name,counter.used);
        if(admissionLedger.terminal)throw new RuntimeFault('INVALID_TOOL');
        if(!saved)await guard(()=>persistent.admissionStore.write(admissionLedger!));
      }
    }
    harness.hooks.on('after_tool', event => {
      const admission=batchPrepared.get(event.toolCallId)?.fact;
      if(admission && admission.disposition!=='ready'){
        if(admission.terminal)failure??=new RuntimeFault('INVALID_TOOL');
        return{isError:true,terminate:admission.terminal};
      }
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
      activeOperationId=operationId;
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

export function createSessionBackend(options: SessionRuntimeOptions): {sessions: Pick<SessionRuntime, 'create' | 'list' | 'history' | 'inspect' | 'inspectFacts' | 'fork' | 'delete' | 'control' | 'update' | 'result'>; drive: typeof drive} {
  const storage = {...options.storage}, reconcile = options.reconcile, bindOperation = options.bindOperation, settings = options.harness ?? {};
  if (!options.budgets || !isAbsolute(storage.directory) || !isAbsolute(storage.cwd) ||
    !storage.policyVersion?.trim() || typeof storage.authorize !== 'function' ||
    typeof storage.acquireWriter !== 'function' || typeof reconcile !== 'function' || typeof bindOperation !== 'function' || (options.extensions && !settings.extensionVersion)) throw new RuntimeFault('INVALID_REQUEST');
  let busy = false;
  let live: {taskId: string; sessionId: string; branch: string; purpose?: string; control(command: HarnessControl): Promise<HarnessControlResult>} | undefined;
  let controlTail: Promise<unknown> = Promise.resolve();
  const info = (m: JsonlSessionMetadata): SessionInfo => ({id: m.id, createdAt: m.createdAt,
    ...(m.parentSessionId === undefined ? {} : {parentSessionId: m.parentSessionId})});
  async function lineageAuthority(metadata:{id:string;parentSessionId?:string},all:JsonlSessionMetadata[],signal:AbortSignal,guard:ControlGuard=directControl){
    const seen=new Set<string>();let selected=metadata;
    while(selected.parentSessionId){
      if(seen.has(selected.id))throw new RuntimeFault('STATE_FAILED');seen.add(selected.id);
      const parent=all.find(m=>m.id===selected.parentSessionId);
      if(!parent)throw new RuntimeFault('STATE_FAILED');
      try{if(!await guard(()=>storage.authorize({kind:'read',sessionId:parent.id},signal)))throw new RuntimeFault('AUTHORITY_REQUIRED');}
      catch{throw new RuntimeFault('AUTHORITY_REQUIRED');}
      selected=parent;
    }
    return selected.id;
  }
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
  function admissionStore(repo:JsonlSessionRepo,session:Session,request:BaseRequest,signal:AbortSignal,guard:ControlGuard){
    const address=admissionAddress(request.taskId,request.purpose),ctx=withAbortSignal(signal,BACKGROUND_CONTEXT);
    let authority=session.metadata.id;
    const atAuthority=async <T>(kind:'read'|'update',operation:(target:Session)=>Promise<T>):Promise<T>=>{
      if(authority===session.metadata.id)return operation(session);
      if(!/^[a-zA-Z0-9_.-]{1,128}$/.test(authority)||!await guard(()=>storage.authorize({kind,sessionId:authority},signal)))throw new RuntimeFault('AUTHORITY_REQUIRED');
      const target=(await guard(()=>repo.list({cwd:storage.cwd},ctx))).find(m=>m.id===authority);
      if(!target)throw new RuntimeFault('STATE_FAILED');
      return opened(repo,target,signal,operation,guard);
    };
    return{
      authorityId:()=>authority,
      hasTaskBinding:()=>atAuthority('read',async target=>{
        const records=await guard(()=>target.scanValues(value<AdmissionLedger>('sdk.tool-admission.v1'),ctx));
        return records.some(record=>{if(record.value?.taskId!==request.taskId)return false;return safeAdmissionLedger(record.value,request.taskId,record.value.purpose).consumptionBound;});
      }),
      read:async()=>{
        const stored=(await guard(()=>session.getValue(address,ctx)))?.value;
        authority=stored===undefined?await lineageAuthority(session.metadata,await guard(()=>repo.list({cwd:storage.cwd},ctx)),signal,guard):safeAdmissionLedger(stored,request.taskId,request.purpose).authoritySessionId;
        const canonical=await atAuthority('read',async target=>(await guard(()=>target.getValue(address,ctx)))?.value);
        if(canonical===undefined&&stored===undefined)return undefined;
        if(!canonical||canonical.authoritySessionId!==authority)throw new RuntimeFault('STATE_FAILED');
        return safeAdmissionLedger(canonical,request.taskId,request.purpose);
      },
      write:async(state:AdmissionLedger)=>{
        if(state.authoritySessionId!==authority)throw new RuntimeFault('STATE_FAILED');
        await atAuthority('update',target=>guard(()=>target.setValue(address,state,ctx)));
        if(authority!==session.metadata.id)await guard(()=>session.setValue(address,state,ctx));
      },
    };
  }
  return {
    sessions: {
      inspectFacts:async input=>{
        const signal=input.signal??new AbortController().signal,ctx=withAbortSignal(signal,BACKGROUND_CONTEXT),branch=input.branch??'main';
        const label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\r\n\u0000]/.test(v);
        if(!/^[a-zA-Z0-9_.-]{1,128}$/.test(input.sessionId)||!label(input.taskId)||!label(branch)||(input.purpose!==undefined&&!label(input.purpose))||signal.aborted)return{availability:'unavailable',reason:signal.aborted?'CANCELLED':'INVALID_REQUEST'};
        try{if(!await storage.authorize({kind:'read',sessionId:input.sessionId},signal))return{availability:'unavailable',reason:'AUTHORITY_REQUIRED'};}
        catch{return{availability:'unavailable',reason:'AUTHORITY_REQUIRED'};}
        if(busy)return{availability:'busy'};
        const env=new NodeExecutionEnv({cwd:storage.cwd}),root=resolve(storage.directory),observed=new Map<string,string>();
        const canonicalRoot=await env.canonicalPath(root,ctx);
        if(!canonicalRoot.ok)return{availability:'unavailable'};
        const readMethods=new Set(['readTextFile','openTextLineReader','readTextLines','readBinaryFile','fileInfo','listDir','canonicalPath','exists']);
        let blockedWrite=false,deniedRead=false;
        const readOnly=new Proxy(env,{get(target,key){
          if(key==='absolutePath'||key==='joinPath'){const method=Reflect.get(target,key);return method.bind(target);}
          if(key==='cleanup')return async()=>{};
          if(typeof key!=='string'||!readMethods.has(key))return async()=>{blockedWrite=true;return{ok:false,error:new FileError('not_supported','Passive snapshot cannot write')};};
          return async(...args:unknown[])=>{
            const path=resolve(String(args[0]));
            if(path!==root&&!path.startsWith(root+sep)){deniedRead=true;return{ok:false,error:new FileError('permission_denied','Passive snapshot scope')};}
            const canonical=await target.canonicalPath(path,ctx);
            if(!canonical.ok){if(key==='exists')return target.exists(path,ctx);return canonical;}
            const info=await target.fileInfo(path,ctx);
            if(!info.ok)return info;
            const expected=canonicalRoot.value+path.slice(root.length);
            if(canonical.value!==expected||info.value.kind==='symlink'||info.value.size>16_777_216){deniedRead=true;return{ok:false,error:new FileError('not_supported','Passive snapshot unavailable')};}
            const result=await Reflect.get(target,key).apply(target,args);
            if(key==='readTextFile'&&result.ok)observed.set(path,createHash('sha256').update(result.value).digest('hex'));
            return result;
          };
        }});
        const repo=new JsonlSessionRepo({fileSystem:readOnly,sessionsRoot:storage.directory});
        const openedSessions:Session[]=[];
        try{
          const all=await repo.list({cwd:storage.cwd},ctx),meta=all.find(m=>m.id===input.sessionId);
          if(!meta)return{availability:'unavailable'};
          const session=await repo.open(meta,ctx);openedSessions.push(session);
          const lane=await session.getValue(laneState(branch),ctx),current=lane?.value.currentOperationId;
          if(lane&&(!lane.value||!Array.isArray(lane.value.inbox)||lane.value.inbox.some(q=>!q||!label(q.entryId)||!['steer','followUp','nextRun','write'].includes(q.kind))))return{availability:'corrupt'};
          if(lane&&((current!==null&&!label(current))||(lane.value.lastOperationId!==null&&!label(lane.value.lastOperationId))))return{availability:'corrupt'};
          if(current)return{availability:'busy'};
          const pending=null;
          const resultId=lane?.value.lastOperationId,result=resultId?(await session.getValue(operationResult(resultId),ctx))?.value:undefined;
          if(resultId&&!result||result&&(!label(result.operationId)||result.operationId!==resultId||!['completed','declined','aborted','failed'].includes(result.status)))return{availability:'corrupt'};
          const queueOwner=(await session.getValue(value<{taskId:string;purpose?:string;operationId:string}>('sdk.queue-authority.v1',branch),ctx))?.value;
          let ledger=(await session.getValue(admissionAddress(input.taskId,input.purpose),ctx))?.value;
          if(ledger!==undefined)ledger=safeAdmissionLedger(ledger,input.taskId,input.purpose);
          const authorityId=ledger?.authoritySessionId??await lineageAuthority(meta,all,signal);
          if(authorityId!==session.metadata.id){
            try{if(!await storage.authorize({kind:'read',sessionId:authorityId},signal))return{availability:'unavailable',reason:'AUTHORITY_REQUIRED'};}
            catch{return{availability:'unavailable',reason:'AUTHORITY_REQUIRED'};}
            const authority=all.find(m=>m.id===authorityId);if(!authority)return{availability:'unavailable'};
            const canonical=await repo.open(authority,ctx);openedSessions.push(canonical);
            const saved=(await canonical.getValue(admissionAddress(input.taskId,input.purpose),ctx))?.value;
            if(saved===undefined){if(ledger)return{availability:'corrupt'};}
            else{const selected=safeAdmissionLedger(saved,input.taskId,input.purpose);if(selected.authoritySessionId!==authorityId)return{availability:'corrupt'};ledger=selected;}
          }
          if(ledger&&(ledger.version!=='1'||ledger.taskId!==input.taskId||ledger.purpose!==input.purpose||typeof ledger.terminal!=='boolean'||!Array.isArray(ledger.counts)||!Array.isArray(ledger.facts)))return{availability:'corrupt'};
          const facts=ledger?.facts.map(safeAdmissionFact);
          if(ledger?.counts.some(c=>typeof c.name!=='string'||c.name.length>256||!Number.isSafeInteger(c.used)||c.used<0||c.used>2))return{availability:'corrupt'};
          const tipId=await (await session.branch(branch,ctx))?.getTipId(ctx)??null;
          if(tipId!==null&&!label(tipId))return{availability:'corrupt'};
          for(const [path,hash]of [...observed]){const actual=await readOnly.readTextFile(path,ctx);if(!actual.ok||createHash('sha256').update(actual.value).digest('hex')!==hash)return{availability:'busy'};}
          if(signal.aborted)return{availability:'unavailable',reason:'CANCELLED'};
          const knownQueue=queueOwner?.taskId===input.taskId&&queueOwner.purpose===input.purpose;
          const knownTerminal=result&&(knownQueue&&queueOwner.operationId===result.operationId||facts?.some(f=>f.session?.sessionId===input.sessionId&&f.session.operationId===result.operationId));
          return{availability:'available',sessionId:input.sessionId,branch,tipId,pending,
            ...(knownTerminal?{terminal:{operationId:result.operationId,status:result.status}}:{}),
            queue:knownQueue&&lane?{availability:'known',entries:lane.value.inbox.map(q=>({entryId:q.entryId,kind:q.kind}))}:{availability:'unknown'},
            admission:ledger?{availability:'known',policyVersion:ledger.policyVersion,terminal:ledger.terminal,corrections:ledger.counts.map(c=>({name:c.name,used:c.used})),facts:facts!}:{availability:'unknown'}};
        }catch(error){return error instanceof RuntimeFault&&error.reason==='AUTHORITY_REQUIRED'?{availability:'unavailable',reason:'AUTHORITY_REQUIRED'}:{availability:blockedWrite?'corrupt':deniedRead?'unavailable':'corrupt'};}
        finally{for(const session of openedSessions.reverse())await session.close(BACKGROUND_CONTEXT);await repo.close(BACKGROUND_CONTEXT);}
      },
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
        let admissions:Awaited<ReturnType<Session['scanValues']>>=[];
        await opened(repo, metadata!, signal, async session => {
          const state = await session.getValue(laneState(branch), BACKGROUND_CONTEXT);
          // Native fork discards operation state. Never use it to erase unsettled effects or queues.
          if (!state || state.value.currentOperationId || state.value.inbox.length) throw new RuntimeFault('STATE_FAILED');
          admissions=await session.scanValues(value('sdk.tool-admission.v1'),BACKGROUND_CONTEXT);
        });
        const forked = await repo.fork(metadata!, {scope: 'branch', branch}, withAbortSignal(signal, BACKGROUND_CONTEXT));
        try {
          for(const stored of admissions)await forked.setValue(stored.address,stored.value,withAbortSignal(signal,BACKGROUND_CONTEXT));
          return info(forked.metadata);
        } finally {await forked.close(BACKGROUND_CONTEXT);}
      }),
      delete: (id, signal) => access('delete', id, signal, async (repo, metadata, signal) => {
        await repo.delete(metadata!, withAbortSignal(signal, BACKGROUND_CONTEXT));
      }),
    },
    drive: (config, request, transport, signal, tools = [], activeModel = () => config, bind = () => {}, control = async () => {}, guard = directControl, policy) => {
      const r = request as SessionRunRequest & AgentRequest;
      if (r.modelRecovery && settings.retry?.enabled) throw new RuntimeFault('INVALID_REQUEST');
      if (settings.deferred && !config.deferred) throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
      if (!r.sessionId || r.checkpoint || r.saveCheckpoint || r.shouldYield ||
        (r.operation !== undefined && !['prompt', 'resume', 'skill', 'template', 'compact', 'navigate', 'abort'].includes(r.operation)) ||
        (['resume','abort'].includes(r.operation ?? '') && r.prompt) ||
        (['skill', 'template'].includes(r.operation ?? '') && !r.resourceName) ||
        (r.operation === 'navigate' && r.targetEntryId === undefined)) throw new RuntimeFault('INVALID_REQUEST');
      return access('run', r.sessionId, signal, (repo, metadata, signal) => opened(repo, metadata!, signal,
        session => driveHarness(config, request, transport, signal, tools, activeModel, {session, reconcile, bindOperation, bind, settings, admissionStore:admissionStore(repo,session,request,signal,guard), ...(options.extensions ? {extensions: options.extensions} : {}),
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
        }, guard, policy), guard), guard);
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
      execute: async (_id: string, args: unknown, toolSignal?: AbortSignal) => restoredResults.has(_id) ? {content:[{type:'text' as const,text:restoredResults.get(_id)!.text}],details:null} :
        nativeToolResult(tool, await tool.execute(args as JsonObject, toolSignal ? AbortSignal.any([signal, toolSignal]) : signal))}))}, toolExecution: request.toolExecution ?? 'sequential',
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
          usage: nativeUsage(reply.usage)};
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

function nativeToolResult(tool: Tool, value: import('./types.ts').JsonValue) {
  if (tool.output === 'content') {
    const result = value as {content: ({kind:'text';text:string} | {kind:'image';data:string;mimeType:string})[]; details?:import('./types.ts').JsonValue};
    if (!Array.isArray(result.content) || result.content.some(c => !['text','image'].includes(c.kind))) throw new RuntimeFault('TOOL_FAILED');
    return {content:result.content.map(c => c.kind === 'text' ? {type:'text' as const,text:c.text} : {type:'image' as const,data:c.data,mimeType:c.mimeType}), details:result.details ?? null};
  }
  return {content:[{type:'text' as const,text:JSON.stringify(value)}],details:null};
}

// Keep native FileError/code compatibility while retaining the host's typed abort cause.
// The public boundary is ToolOutcome.failureCategory; no Pi error type is exported.
class ClassifiedFileError extends FileError {
  readonly failureCategory: ToolFailureCategory;
  constructor(code: ConstructorParameters<typeof FileError>[0], message: string, category: ToolFailureCategory) {
    super(code, message); this.failureCategory = category;
  }
}
class ClassifiedExecutionError extends ExecutionError {
  readonly failureCategory:ToolFailureCategory;
  constructor(code:ConstructorParameters<typeof ExecutionError>[0],category:ToolFailureCategory){
    super(code,'Host process operation failed');this.failureCategory=category;
  }
}
export function executionFailureCategory(error: unknown): ToolFailureCategory | undefined {
  if (error instanceof ClassifiedFileError) return error.failureCategory;
  // The native bash tool wraps our trusted process carrier in Error.cause.
  // Never infer a category from arbitrary exception text or a plain cause object.
  if(error instanceof ClassifiedExecutionError)return error.failureCategory;
  if(utilTypes.isNativeError(error)&&error.cause instanceof ClassifiedExecutionError)return error.cause.failureCategory;
  if (error instanceof ExecutionLimitFailure) return 'limit_exceeded';
  if (error instanceof RuntimeFault && error.reason === 'CANCELLED') return 'cancelled';
  if (error instanceof RuntimeFault && error.reason === 'DEADLINE_EXCEEDED') return 'timeout';
  return undefined;
}

/** Native tool factories over explicit host capabilities, never NodeExecutionEnv for model tools. */
export function createExecutionTools(host: ExecutionEnvironment, names: readonly ('read' | 'write' | 'edit' | 'bash')[]): Tool[] {
  host = {...host};
  if (!host.policyVersion || !isAbsolute(host.cwd)) throw new RuntimeFault('INVALID_REQUEST');
  const contextSignal = (context: Context) => context.abortSignal ?? new AbortController().signal;
  const fileFailure = (error: unknown) => {
    const reason = error instanceof RuntimeFault ? error.reason : undefined;
    if (reason === 'BUDGET_EXHAUSTED') throw new ExecutionLimitFailure();
    const codes: Record<string, ConstructorParameters<typeof FileError>[0]> = {ENOENT:'not_found', ENOTDIR:'not_directory', EISDIR:'is_directory', EACCES:'permission_denied',
      EPERM:'permission_denied', EINVAL:'invalid', ENOTSUP:'not_supported', ECANCELED:'aborted', ABORT_ERR:'aborted', ETIMEDOUT:'aborted'};
    const errno = (error as NodeJS.ErrnoException)?.code ?? '';
    const code = reason === 'AUTHORITY_REQUIRED' ? 'permission_denied' :
      reason === 'CANCELLED' || reason === 'DEADLINE_EXCEEDED' ? 'aborted' :
      reason === 'CAPABILITY_UNAVAILABLE' ? 'not_supported' : reason === 'INVALID_REQUEST' ? 'invalid' :
      Object.hasOwn(codes, errno) ? codes[errno]! : 'unknown';
    const category = code === 'aborted' ? reason === 'CANCELLED' ? 'cancelled' :
      reason === 'DEADLINE_EXCEEDED' || errno === 'ETIMEDOUT' ? 'timeout' : 'cancelled' : code;
    return new ClassifiedFileError(code, reason === 'DEADLINE_EXCEEDED' ? 'Host file operation timed out' : 'Host file operation failed', category);
  };
  const attempt = async <T>(operation: () => Promise<T>) => {try {return {ok: true as const, value: await operation()};} catch (error) {return {ok: false as const, error: fileFailure(error)};}};
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
      } catch(error) {
        const reason = error instanceof RuntimeFault ? error.reason : undefined;
        const code = reason === 'CANCELLED' ? 'aborted' : reason === 'DEADLINE_EXCEEDED' ? 'timeout' :
          reason === 'CAPABILITY_UNAVAILABLE' ? 'shell_unavailable' : 'unknown';
        return {ok:false,error:new ClassifiedExecutionError(code,code==='timeout'?'timeout':code==='aborted'?'cancelled':code==='shell_unavailable'?'not_supported':'unknown')};
      }
    },
  };
  const factories = {read: createReadTool, write: createWriteTool, edit: createEditTool, bash: createBashTool};
  return names.map(name => {
    if (!(name in factories)) throw new RuntimeFault('INVALID_REQUEST');
    const native = factories[name]();
    return {name, description: native.description, parameters: native.parameters as unknown as JsonObject,
      ...(native.prepareArguments?{prepareArguments:(args:JsonObject)=>native.prepareArguments!(args) as JsonObject}:{}),
      effect: name === 'read' ? 'read' : name === 'bash' ? 'external' : 'write', executionMode: 'sequential',
      resourceUnits: 1, policyVersion: host.policyVersion, output: 'content',
      execute: async (args, signal, invocation) => {
        const tool = native as ReturnType<typeof createReadTool>;
        const result = await tool.execute(invocation?.toolCallId ?? randomUUID(), args as never, (partial,options)=>{
          invocation?.update(JSON.parse(JSON.stringify({content:partial.content,details:partial.details})),options?.checkpoint===true);
        }, {env},
          {invocationId: invocation?.invocationId ?? randomUUID(), operationId: invocation?.operationId ?? '', turnId: '',
            getMemo: async name => invocation?.getMemo(name), setMemo: async (name,next) => {if(!invocation)throw new RuntimeFault('CAPABILITY_UNAVAILABLE');await invocation.setMemo(name,next);}}, withAbortSignal(signal, BACKGROUND_CONTEXT));
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
    parentPort?.postMessage({content:reply.content.flatMap(fromPiContent),stop:reply.stopReason==='stop'?'complete':reply.stopReason==='toolUse'?'tools':'length',usage:modelUsage(reply.usage,cap)});
  }catch{parentPort?.postMessage({error:true});}})();
}
