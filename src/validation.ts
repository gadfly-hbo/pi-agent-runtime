import {outputCap,validateLimits} from './policy.ts';
import {RuntimeFault} from './errors.ts';
import type {AgentRequest, BaseRequest, ModelConfig, ModelReply, ThinkingLevel, Tool} from './types.ts';

export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isJson);
}
const integer = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min;
const label = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\u0000]/.test(value);
export function validateThinking(model: ModelConfig, level: ThinkingLevel | undefined, ceiling: number) {
  if ((model.reasoning !== undefined && typeof model.reasoning !== 'boolean') ||
    (level !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) ||
    (level !== undefined && level !== 'off' && (model.reasoning !== true ||
      (model.protocol === 'anthropic-messages' && ceiling < 2048)))) throw new RuntimeFault('INVALID_REQUEST');
}
export function validateReply(reply: ModelReply) {
  try {
    if (!isJson(reply) || !Array.isArray(reply.content) || Buffer.byteLength(JSON.stringify(reply)) > 1_048_576 ||
      !['complete', 'tools', 'length', 'deferred'].includes(reply.stop) || !reply.usage ||
      !integer(reply.usage.inputTokens) || !integer(reply.usage.outputTokens) || reply.content.some(content =>
        content.kind === 'text' ? typeof content.text !== 'string' : content.kind === 'reasoning' ?
        typeof content.text !== 'string' || (content.signature !== undefined && typeof content.signature !== 'string') ||
        (content.redacted !== undefined && typeof content.redacted !== 'boolean') ||
        (content.redacted === true && !content.signature) : content.kind !== 'tool' || !label(content.id) || !label(content.name) ||
        !content.arguments || Array.isArray(content.arguments) || typeof content.arguments !== 'object')) throw Error();
    if (reply.stop === 'deferred' && (!reply.deferred || !label(reply.deferred.id) || reply.content.length)) throw Error();
    if (reply.stop !== 'deferred' && reply.deferred) throw Error();
  } catch {throw new RuntimeFault('INVALID_OUTPUT');}
}
export function validateRequest(model: ModelConfig, request: BaseRequest, tools: readonly Tool[]) {
  try {
    const url = new URL(model.endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!['openai-completions', 'anthropic-messages'].includes(model.protocol) ||
      !label(model.provider) || !label(model.id) || !integer(model.contextWindow, 1) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw Error();
    const limits = request.limits;
    validateLimits(limits);
    if(request.modelRecovery && (![0,1].includes(request.modelRecovery.extraAttempts)||Object.keys(request.modelRecovery).some(k=>k!=='extraAttempts')))throw Error();
    if (request.images !== undefined && (!model.input?.includes('image') || !Array.isArray(request.images) || request.images.some(i =>
      !['image/png','image/jpeg','image/gif','image/webp'].includes(i.mimeType) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(i.data) || i.data.length > 4_194_304))) throw Error();
    validateThinking(model, request.thinkingLevel, Math.min(model.maxOutputTokens ?? outputCap(limits), outputCap(limits)));
    if (!label(request.taskId) || typeof request.prompt !== 'string' ||
      (request.system !== undefined && typeof request.system !== 'string') ||
      Buffer.byteLength(request.prompt + (request.system ?? '')) > 1_048_576 ||
      (request.toolExecution !== undefined && !['sequential', 'parallel'].includes(request.toolExecution)) ||
      Object.entries(request.contextVersions ?? {}).some(([key, value]) => !label(key) || !label(value))) throw Error();
    const names = new Set<string>();
    for (const tool of tools) {
      if (!label(tool.name) || names.has(tool.name) || !['read', 'write', 'external'].includes(tool.effect) ||
        typeof tool.description !== 'string' || !integer(tool.resourceUnits) || typeof tool.execute !== 'function' ||
        (tool.executionMode !== undefined && !['sequential', 'parallel'].includes(tool.executionMode)) ||
        !isJson(tool.parameters) || tool.parameters.type !== 'object' || Buffer.byteLength(JSON.stringify(tool.parameters)) > 1_048_576) throw Error();
      names.add(tool.name);
    }
  } catch {throw new RuntimeFault('INVALID_REQUEST');}
}

/** Validates structure and tool-result pairing. Content authority remains the host's responsibility. */
export function validateCheckpoint(request: AgentRequest) {
  if ((request.saveCheckpoint !== undefined && typeof request.saveCheckpoint !== 'function') ||
      (request.shouldYield !== undefined && typeof request.shouldYield !== 'function') ||
      ((request.checkpoint || request.shouldYield) && !request.saveCheckpoint) ||
      ((request.checkpoint || request.saveCheckpoint || request.shouldYield) && request.toolExecution === 'parallel')) throw new RuntimeFault('INVALID_REQUEST');
  const checkpoint = request.checkpoint;
  if (!checkpoint) return;
  try {
    if (!isJson(checkpoint) || checkpoint.version !== '1.0' || checkpoint.taskId !== request.taskId || checkpoint.purpose !== request.purpose ||
        !['ready','waiting','completed','tool-admitted'].includes(checkpoint.state) || !Array.isArray(checkpoint.messages) || !checkpoint.messages.length ||
        Buffer.byteLength(JSON.stringify(checkpoint)) > 2_097_152 ||
        Object.keys(checkpoint).some(k=>!['version','taskId','purpose','state','messages','inFlightToolId'].includes(k))) throw Error();
    const calls = new Map<string,string>(), pending = new Set<string>();
    for (const m of checkpoint.messages) {
      if (!['system','user','assistant','tool'].includes(m.role) || typeof m.text !== 'string' ||
          Object.keys(m).some(k=>!['role','text','origin','calls','blocks','toolId','toolName','toolFailed','tools'].includes(k))) throw Error();
      if (m.role === 'assistant') {
        if (pending.size || m.tools || m.toolId || m.toolName || m.toolFailed !== undefined) throw Error();
        if (m.origin && (!label(m.origin.provider) || !label(m.origin.id) || !['anthropic-messages','openai-completions'].includes(m.origin.protocol))) throw Error();
        if (m.calls !== undefined && !Array.isArray(m.calls)) throw Error();
        for (const call of m.calls ?? []) {
          if (!label(call.id) || !label(call.name) || calls.has(call.id) || !call.arguments || Array.isArray(call.arguments) || typeof call.arguments !== 'object') throw Error();
          calls.set(call.id,call.name);pending.add(call.id);
        }
        if (m.blocks) {
          validateReply({content:m.blocks,stop:pending.size?'tools':'complete',usage:{inputTokens:0,outputTokens:0}});
          if (JSON.stringify(m.blocks.filter(c=>c.kind==='tool').map(({kind:_kind,...c})=>c)) !== JSON.stringify(m.calls ?? []) ||
              m.blocks.filter(c=>c.kind==='text').map(c=>c.text).join('') !== m.text) throw Error();
        }
      } else if (m.role === 'tool') {
        if (!m.toolId || !pending.has(m.toolId) || calls.get(m.toolId) !== m.toolName || m.origin || m.calls || m.blocks || m.tools ||
            (m.toolFailed !== undefined && typeof m.toolFailed !== 'boolean')) throw Error();
        pending.delete(m.toolId);
      } else if (pending.size || m.origin || m.calls || m.blocks || m.toolId || m.toolName || m.toolFailed !== undefined ||
          (m.role === 'user' && m.tools)) throw Error();
      if (m.tools && (!Array.isArray(m.tools) || m.tools.some(t=>!label(t.name) || typeof t.description !== 'string' || !t.parameters ||
          Array.isArray(t.parameters) || t.parameters.type !== 'object' || Object.keys(t).some(k=>!['name','description','parameters'].includes(k))))) throw Error();
    }
    if (checkpoint.state === 'completed' && (pending.size || checkpoint.messages.at(-1)?.role !== 'assistant')) throw Error();
    if (checkpoint.state === 'tool-admitted') {
      if (!checkpoint.inFlightToolId || !pending.has(checkpoint.inFlightToolId)) throw Error();
    } else if (checkpoint.inFlightToolId !== undefined) throw Error();
  } catch {throw new RuntimeFault('INVALID_REQUEST');}
  if (checkpoint.state === 'tool-admitted') throw new RuntimeFault('STATE_FAILED');
}
