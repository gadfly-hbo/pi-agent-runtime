/** Synthetic fixtures only. This module intentionally records full test prompts/results. */
import {RuntimeFault} from './errors.ts';
import type {ModelReply, ModelRequest, ModelTransport} from './types.ts';
export interface ModelRecord {
  version: '1.0';
  request: Omit<ModelRequest, 'signal'>;
  reply: ModelReply;
}
const project = ({signal: _signal, ...request}: ModelRequest) => structuredClone(request);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
  return JSON.stringify(value);
}
export function createRecorder(transport: ModelTransport): {transport: ModelTransport; records(): ModelRecord[]} {
  const records: ModelRecord[] = [];
  return {transport: async request => {
    const input = project(request), reply = await transport(request);
    records.push({version: '1.0', request: input, reply: structuredClone(reply)});
    return reply;
  }, records: () => structuredClone(records)};
}
export function createReplay(source: readonly ModelRecord[]): {transport: ModelTransport; assertConsumed(): void} {
  const records = structuredClone(source); let position = 0;
  return {transport: async request => {
    const record = records[position];
    if (!record || record.version !== '1.0' || request.signal.aborted || canonical(record.request) !== canonical(project(request))) throw new RuntimeFault('MODEL_FAILED');
    position++; return structuredClone(record.reply);
  }, assertConsumed: () => {if (position !== records.length) throw new RuntimeFault('MODEL_FAILED');}};
}
