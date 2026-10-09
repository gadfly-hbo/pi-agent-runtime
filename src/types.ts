export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export type JsonObject = {[key: string]: JsonValue};
export type ToolExecutionMode = 'sequential' | 'parallel';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelConfig {
  provider: string;
  id: string;
  protocol: 'openai-completions' | 'anthropic-messages';
  endpoint: string;
  contextWindow: number;
  /** Per-attempt output cap. Required on each candidate when fallbacks are configured. */
  maxOutputTokens?: number;
  /** Host-declared, verified model capability; not inferred from model names. */
  reasoning?: boolean;
  input?: readonly ('text' | 'image')[];
  deferred?: boolean;
  proxyEndpoint?: string;
}
export interface InputImage {data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'}
export interface Limits {
  modelCalls: number;
  toolCalls: number;
  outputTokens: number;
  wallTimeMs: number;
  resourceUnits?: number;
}
export interface Usage {
  modelCalls: number;
  toolCalls: number;
  outputTokens: number;
  resourceUnits: number;
  activeMs: number;
}
export interface ModelCall {
  id: string;
  name: string;
  arguments: JsonObject;
}
/** Ordered protocol-continuation content. Reasoning is not a user-facing answer or audit payload. */
export type ModelContent = {kind: 'text'; text: string} |
  {kind: 'tool'; id: string; name: string; arguments: JsonObject} |
  {kind: 'reasoning'; text: string; signature?: string; redacted?: boolean};
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  images?: InputImage[];
  /** Actual source of an assistant turn; keeps cross-provider history conversion truthful. */
  origin?: Pick<ModelConfig,'provider'|'id'|'protocol'>;
  calls?: ModelCall[];
  /** Present when signed reasoning must preserve exact block order for continuation. */
  blocks?: ModelContent[];
  toolId?: string;
  toolName?: string;
  toolFailed?: boolean;
  tools?: {name: string; description: string; parameters: JsonObject}[];
}
export interface ModelRequest {
  model: Readonly<ModelConfig>;
  messages: ModelMessage[];
  maxOutputTokens: number;
  signal: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  deferred?: {action: 'start'} | {action: 'poll' | 'cancel'; handle: DeferredReference};
}
export interface DeferredReference {id: string; data?: JsonValue; pollAfterMs?: number; expiresAt?: number}
export interface ModelReply {
  content: ModelContent[];
  stop: 'complete' | 'tools' | 'length' | 'deferred';
  deferred?: DeferredReference;
  usage: {inputTokens: number; outputTokens: number};
}
export type ModelTransport = (request: ModelRequest) => Promise<ModelReply>;
export interface PiTransportOptions {
  model: ModelConfig;
  /** Explicit credential only. Never discovers environment variables or local auth files. */
  apiKey: string;
  /** For host-controlled transport or fully offline HTTP fixtures. */
  fetch?: typeof globalThis.fetch;
}
export interface ProxyTransportOptions {model: ModelConfig; authToken: string}
export type Reason = 'INVALID_REQUEST' | 'AUTHORITY_REQUIRED' | 'BUDGET_EXHAUSTED' | 'TASK_BUSY' |
  'CONFIGURATION_CHANGED' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'AUDIT_FAILED' | 'MODEL_FAILED' |
  'INVALID_OUTPUT' | 'TOOL_FAILED' | 'INVALID_TOOL' | 'STATE_FAILED' | 'BUSINESS_WAIT' | 'CAPABILITY_UNAVAILABLE' | 'DEFERRED';
export interface AuditEvent {
  version: '1.0';
  taskId: string;
  runId: string;
  sequence: number;
  kind: 'run.started' | 'model.admitted' | 'model.finished' | 'tool.admitted' | 'tool.finished' | 'run.finished' | 'session.control';
  at: string;
  provider: string;
  model: string;
  contextVersions: Readonly<Record<string, string>>;
  digest?: string;
  toolName?: string;
  toolFailed?: boolean;
  reason?: Reason;
  attempt?: number;
  failureCategory?: 'quota' | 'rate-limit' | 'unavailable' | 'network';
  session?: SessionBinding;
  invocation?: ToolInvocation;
}
export interface AuditSink {append(event: Readonly<AuditEvent>, signal: AbortSignal): Promise<void>}
export type Authorization = {
  taskId: string; runId: string;
  session?: SessionBinding;
} & ({kind: 'model'; request: ModelRequest} | {kind: 'tool'; name: string; effect: Tool['effect']; arguments: JsonObject; invocation?: ToolInvocation} | {kind: 'publish'} | {kind: 'control'; command: HarnessControl});
/** Immutable per-task purpose configuration. Transport/execute remain explicit host capabilities. */
export interface PurposeConfig {
  id: string;
  mode: 'worker' | 'text' | 'agent';
  model: ModelConfig;
  transport: ModelTransport;
  fallbacks?: readonly {model: ModelConfig; transport: ModelTransport}[];
  tools?: readonly Tool[];
  toolExecution?: ToolExecutionMode;
  thinkingLevel?: ThinkingLevel;
}
export interface RuntimeOptions {
  /** When supplied every run must select a declared purpose; the entire plan is pinned. */
  purposes?: readonly PurposeConfig[];
  model: ModelConfig;
  transport: ModelTransport;
  /** Ordered candidates; no automatic credentials, retries or task-budget reset. */
  fallbacks?: readonly {model: ModelConfig; transport: ModelTransport}[];
  authorize: (action: Authorization, signal: AbortSignal) => Promise<boolean>;
  audit: AuditSink;
  budgets?: BudgetStore;
  onEvent?: (event: Readonly<AuditEvent>) => void | Promise<void>;
}
/** Implementations must make claim/reserve/settle/release atomic per task. */
export interface BudgetStore {
  claim(taskId: string, runId: string, configuration: string, limits: Limits): Promise<BudgetLease>;
}
export interface BudgetLease {
  snapshot(): Usage;
  reserveModel(): Promise<number>;
  /** Optional extension. Routed execution requires atomic capped reservation. */
  reserveModelUpTo?(maximumTokens: number): Promise<number>;
  settleModel(reservedTokens: number, actualTokens: number): Promise<void>;
  reserveTool(units: number): Promise<void>;
  release(activeMs: number): Promise<void>;
}
/** Host-owned durable conversation checkpoint; contains authorized content, not audit metadata. */
export interface ConversationCheckpoint {
  version: '1.0';
  taskId: string;
  purpose?: string;
  messages: ModelMessage[];
  state: 'ready' | 'waiting' | 'completed' | 'tool-admitted';
  /** A crash after admission requires host reconciliation, never automatic effect replay. */
  inFlightToolId?: string;
}
export interface BaseRequest {
  purpose?: string;
  taskId: string;
  prompt: string;
  images?: readonly InputImage[];
  system?: string;
  contextVersions?: Readonly<Record<string, string>>;
  limits: Limits;
  signal?: AbortSignal;
  /** Defaults to sequential; Pi may force a batch to sequential for a tool override. */
  toolExecution?: ToolExecutionMode;
  thinkingLevel?: ThinkingLevel;
}
export interface WorkerRequest<T> extends BaseRequest {validate(value: unknown): T}
export interface TextRequest extends BaseRequest {validate?(text: string): string}
export interface Tool {
  /** Structured text/image output; ordinary tools retain JSON serialization. */
  output?: 'content';
  /** Stable host environment/policy identity included in task configuration. */
  policyVersion?: string;
  name: string;
  description: string;
  effect: 'read' | 'write' | 'external';
  parameters: JsonObject;
  resourceUnits: number;
  executionMode?: ToolExecutionMode;
  replay?: 'never' | 'safe';
  execute(args: JsonObject, signal: AbortSignal, invocation?: ToolExecutionContext): Promise<JsonValue>;
}
export interface ExecutionEnvironment {
  cwd: string;
  policyVersion: string;
  resolvePath(path: string): Promise<string>;
  read(path: string, signal: AbortSignal): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  stat(path: string, signal: AbortSignal): Promise<{path: string; name: string; kind: 'file' | 'directory'; size: number; modifiedAt: number}>;
  /** Must enforce filesystem/network isolation, bounded output/time and descendant cleanup. */
  exec(command: string, signal: AbortSignal): Promise<{output: string; exitCode: number}>;
}
export interface LocalEnvironmentOptions {
  root: string; policyVersion: string; exclusiveWorkspace: true;
  maxFileBytes: number; maxOutputBytes: number; timeoutMs: number;
  /** Optional macOS single-process sandbox. Fork/pipelines/background children and network are denied; use exec for external commands. No unrestricted fallback. */
  processes?: boolean;
}
export interface AgentRequest extends BaseRequest {
  tools: readonly Tool[];
  /** Awaited durable host acknowledgement before dependent effects; no observer fallback. */
  checkpoint?: ConversationCheckpoint;
  /** Normal business waiting, never cancellation or authority. */
  shouldYield?: () => boolean;
  saveCheckpoint?: (checkpoint: Readonly<ConversationCheckpoint>, signal: AbortSignal) => Promise<void>;
}
export type RunResult<T> = {
  taskId: string; runId: string; usage: Usage; usageKnown: boolean;
} & ({status: 'succeeded'; value: T} | {status: 'waiting'; reason: 'BUSINESS_WAIT'; checkpoint: ConversationCheckpoint} | {status: 'suspended'; reason: 'DEFERRED'; session: SessionBinding} | {status: 'failed' | 'cancelled' | 'blocked'; reason: Reason});
export interface Runtime {
  runWorker<T>(request: WorkerRequest<T>): Promise<RunResult<T>>;
  runText(request: TextRequest): Promise<RunResult<string>>;
  runAgent(request: AgentRequest): Promise<RunResult<string>>;
  /** Wait for physical operations to settle; can remain pending for an uncooperative host tool. */
  waitForIdle(taskId: string): Promise<void>;
}

/** Host-owned access and retention policy; no global directory or automatic expiry. */
export interface SessionStorage {
  directory: string;
  cwd: string;
  policyVersion: string;
  authorize(action: {kind: 'create' | 'list' | 'read' | 'run' | 'fork' | 'delete' | 'update'; sessionId?: string}, signal: AbortSignal): Promise<boolean>;
  /** Exclusive across processes for this dedicated root, held until native handles close.
   * Reject contention; do not steal a live or unreconciled owner's lease. */
  acquireWriter(signal: AbortSignal): Promise<{release(): Promise<void>}>;
}
export interface SessionInfo {
  id: string;
  createdAt: number;
  parentSessionId?: string;
  name?: string;
}
export interface SessionEntry {
  id: string;
  parentId: string | null;
  kind: 'message' | 'compaction' | 'branch_summary' | 'custom';
  message?: ModelMessage;
  summary?: string;
  label?: string;
}
export interface SessionStatus {
  session: SessionInfo;
  branch: string;
  tipId: string | null;
  pending: {operationId: string; kind: 'run' | 'compaction' | 'navigation'} | null;
}
export interface SessionRunRequest extends BaseRequest {
  sessionId: string;
  branch?: string;
  tools: readonly Tool[];
  operation?: 'prompt' | 'resume' | 'skill' | 'template' | 'compact' | 'navigate' | 'abort';
  resourceName?: string;
  templateArguments?: readonly string[];
  targetEntryId?: string | null;
  summarize?: boolean;
}
export interface SessionBinding {sessionId: string; branch: string; operationId: string}
/** Native stable identity mapped to neutral values for host idempotency/receipt lookup. */
export interface ToolInvocation extends SessionBinding {invocationId: string; toolCallId: string}
export interface ToolExecutionContext extends ToolInvocation {
  getMemo(name: string): Promise<JsonValue | undefined>;
  setMemo(name: string, value: JsonValue | undefined): Promise<void>;
  update(value: JsonValue, durable?: boolean): void;
}
export interface HarnessSettings {
  deferred?: boolean;
  extensionVersion?: string;
  steeringMode?: 'all' | 'one-at-a-time';
  followUpMode?: 'all' | 'one-at-a-time';
  /** Native bounded retry after the declared fallback route is exhausted. */
  retry?: {enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs?: number};
  compaction?: {enabled: boolean; reserveTokens: number; keepRecentTokens: number};
  /** Trusted host-provided content; no automatic home-directory discovery. */
  skills?: readonly {name: string; description: string; content: string; filePath: string; disableModelInvocation?: boolean}[];
  templates?: readonly {name: string; description?: string; content: string}[];
}
export interface SessionRuntimeOptions extends RuntimeOptions {
  /** Required authoritative store; production hosts must persist it. */
  budgets: BudgetStore;
  storage: SessionStorage;
  /** Fixed when the runtime is created; included in the task configuration identity. */
  harness?: HarnessSettings;
  /** Observation only: no raw prompts, content, credentials, or native events. */
  onHarnessEvent?(event: HarnessObservation): void | Promise<void>;
  /** Native hooks are extensions, never authority gates. Errors are observed and Pi continues. */
  extensions?: {
    transformContext?(input: {messages: ModelMessage[]; system: string}): Promise<{messages?: ModelMessage[]; system?: string} | undefined>;
    beforeRequest?(input: {step: string; attempt: number}): Promise<void>;
    beforeTool?(input: {name: string; arguments: JsonObject}): Promise<{arguments?: JsonObject; block?: string} | undefined>;
    beforeEnd?(): Promise<{followUp?: string} | undefined>;
    projectEntry?(input: {type: string; data?: JsonValue}): ModelMessage[];
    customEntryTypes?: readonly string[];
  };
  /** Durable host acknowledgement before native admission. Repeated acknowledgement must
   * be idempotent for the same operation and reject a different task or purpose.
   * BudgetStore independently verifies the immutable configuration. */
  bindOperation(input: SessionBinding & {taskId: string; purpose?: string}, signal: AbortSignal): Promise<void>;
  /** Called before every advance, including idle sessions. Verify task/session ownership,
   * historical budget, authorization and external receipts. Unknown effects MUST reject.
   * Forks are history copies, never new task authority or refunded consumption. */
  reconcile(input: {taskId: string; sessionId: string; branch: string;
    open: readonly {operationId: string; branch: string; kind: 'run' | 'compaction' | 'navigation'}[]},
    signal: AbortSignal): Promise<'ready' | 'unknown' | 'denied'>;
}
export interface ResourceSource {kind: 'skills' | 'templates'; path: string; version: string}
export interface ResourceLoadOptions {
  cwd: string; sources: readonly ResourceSource[];
  authorize(source: Readonly<ResourceSource>, signal: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
}
export interface LoadedResources {
  skills: NonNullable<HarnessSettings['skills']>;
  templates: NonNullable<HarnessSettings['templates']>;
  diagnostics: {kind: string; path: string; sourceVersion: string}[];
  digest: string;
}
export interface SessionRuntime extends Runtime {
  create(signal?: AbortSignal): Promise<SessionInfo>;
  list(signal?: AbortSignal): Promise<SessionInfo[]>;
  history(sessionId: string, branch?: string, signal?: AbortSignal): Promise<SessionEntry[]>;
  /** Opens native storage for inspection only; never drives an operation. */
  inspect(sessionId: string, branch?: string, signal?: AbortSignal): Promise<SessionStatus>;
  result(sessionId: string, operationId: string, signal?: AbortSignal): Promise<{operationId: string; status: 'completed' | 'declined' | 'aborted' | 'failed'; kind: 'run' | 'compaction' | 'navigation'; tipId: string | null} | undefined>;
  /** Copies a settled branch through the native repository. No task ledger is copied. */
  fork(sessionId: string, branch?: string, signal?: AbortSignal): Promise<SessionInfo>;
  delete(sessionId: string, signal?: AbortSignal): Promise<void>;
  control(input: {taskId: string; purpose?: string; sessionId: string; branch?: string; signal?: AbortSignal; command: HarnessControl}): Promise<HarnessControlResult>;
  update(sessionId: string, change: SessionChange, signal?: AbortSignal): Promise<void>;
  run(request: SessionRunRequest): Promise<RunResult<string>>;
  waitForIdle(taskId: string): Promise<void>;
}
export type HarnessControl = {kind: 'steer' | 'followUp' | 'nextRun'; text: string} |
  {kind: 'cancelQueued'; entryId: string} | {kind: 'abort'} | {kind: 'snapshot'; includeContent?: boolean};
export interface HarnessSnapshot {
  branch: string; tipId: string | null; operationId: string | null;
  queued: {entryId: string; kind: string}[];
  activeTools: string[]; thinkingLevel: ThinkingLevel;
  model: {provider: string; id: string}; faulted: boolean;
  transcript?: SessionEntry[];
  runningTools?: {name: string; callId: string; status: string}[];
}
export interface HarnessControlResult {entryId?: string; cancelled?: boolean; snapshot?: HarnessSnapshot}
export interface HarnessObservation extends SessionBinding {taskId: string; kind: string}
export type SessionChange = {kind: 'name'; name?: string} | {kind: 'label'; entryId: string; label?: string} |
  {kind: 'branch'; name: string; at: string | null} |
  {kind: 'message'; branch: string; message: ModelMessage} |
  {kind: 'custom'; branch: string; type: string; data: JsonValue};
