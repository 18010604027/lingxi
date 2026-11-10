/**
 * Provider-neutral contracts for external code agents.
 *
 * The control center should deal in these values only. Provider-specific
 * sessions, command lines and wire formats stay inside an adapter.
 */

export type CodeAgentId = 'builtin' | 'dsh' | 'codex' | 'claude' | (string & {});

export interface CodeAgentCapabilities {
  streaming: boolean;
  thoughts: boolean;
  resume: boolean;
  cancel: boolean;
  permissions: boolean;
  usage: boolean;
  structuredOutput: boolean;
  sandbox: boolean;
  networkPolicy: boolean;
}

export interface CodeAgentAvailability {
  id: CodeAgentId;
  available: boolean;
  command?: string;
  authenticated?: boolean;
  reason?: string;
}

export interface CodeRunRef {
  provider: CodeAgentId;
  runId: string;
  /** Provider session id, when it has one and it can be resumed. */
  sessionId?: string;
}

export interface CodeTask {
  id: string;
  incidentId: string;
  prompt: string;
  cwd: string;
  writableRoot: string;
  readRoots: string[];
  network: 'deny' | 'allow';
  acceptance: string[];
  preferredAgent?: CodeAgentId;
  /** Host attempt number used to make activity idempotency keys stable across retries. */
  attempt?: number;
  /** Host-registered tool names eligible for a name-only activity record. */
  activityTools?: readonly string[];
  resume?: CodeRunRef;
  /** A small provider-owned extension bag; never copied into the prompt. */
  metadata?: Record<string, unknown>;
}

export interface CodePermissionRequest {
  run: CodeRunRef;
  title: string;
  detail: string;
  input?: unknown;
  said?: string;
}

export type CodeAgentEvent =
  | { type: 'started'; run: CodeRunRef }
  | { type: 'text'; text: string; channel: 'thought' | 'message' | 'stderr' }
  | { type: 'tool'; phase: 'started' | 'updated' | 'finished'; id: string; title: string; input?: unknown; output?: unknown }
  | { type: 'permission'; request: CodePermissionRequest }
  | { type: 'file'; action: 'created' | 'changed' | 'deleted'; path: string }
  | { type: 'test'; command: string; status: 'started' | 'passed' | 'failed'; output?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedTokens?: number; cost?: number }
  | { type: 'finished'; status: CodeRunStatus; summary?: string; exitCode?: number }
  | { type: 'error'; code: string; message: string; retryable: boolean };

/** Structured facts safe for a host to persist and project. Provider payloads never belong here. */
interface CodeAgentActivityBase {
  taskId: string;
  attempt: number;
  provider: CodeAgentId;
  runId: string;
  sessionId?: string;
  role: 'coder' | 'control';
  idempotencyKey: string;
}
export type CodeAgentActivityCandidate = CodeAgentActivityBase & (
  | { kind: 'state'; state: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' }
  | { kind: 'tool'; callId: string; toolName: string; state: 'started' | 'updated' | 'finished' }
);

export interface CodeAgentRunOptions {
  shouldStop: () => boolean;
  onPermission: (request: CodePermissionRequest) => Promise<boolean>;
  /** Persist every newly available or updated provider resume reference before the adapter continues. */
  onRunRef?: (run: CodeRunRef) => void;
  /** Best-effort structured activity hook; observation failure must not change the run result. */
  onActivity?: (activity: CodeAgentActivityCandidate) => void;
  onStarted?: (run: CodeRunRef) => void;
  onEvent?: (event: CodeAgentEvent) => void;
  images?: Uint8Array[];
}

/** Notify the host without allowing an observation failure to alter execution. */
export function emitCodeAgentActivity(options: CodeAgentRunOptions, activity: CodeAgentActivityCandidate): void {
  try { options.onActivity?.(activity); }
  catch { console.warn('[code-agent] activity observer failed'); }
}

export function emitCodeAgentStateActivity(task: CodeTask, options: CodeAgentRunOptions, ref: CodeRunRef,
  state: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'): void {
  if (!Number.isSafeInteger(task.attempt) || (task.attempt ?? 0) < 1) return;
  emitCodeAgentActivity(options, { taskId: task.id, attempt: task.attempt!, provider: ref.provider, runId: ref.runId,
    ...(ref.sessionId ? { sessionId: ref.sessionId } : {}), role: 'coder', kind: 'state', state,
    idempotencyKey: state === 'started' ? 'state:started' : 'state:finished' });
}

/** Report a registered tool name only; provider titles, commands, inputs and outputs are intentionally omitted. */
export function emitRegisteredCodeToolActivity(task: CodeTask, options: CodeAgentRunOptions, ref: CodeRunRef,
  callId: string | undefined, toolName: string | undefined, state: 'started' | 'updated' | 'finished'): void {
  if (!Number.isSafeInteger(task.attempt) || (task.attempt ?? 0) < 1 || !toolName || !task.activityTools?.includes(toolName)) return;
  if (!callId || !/^[\w:-]{1,160}$/.test(callId)) return;
  emitCodeAgentActivity(options, { taskId: task.id, attempt: task.attempt!, provider: ref.provider, runId: ref.runId,
    ...(ref.sessionId ? { sessionId: ref.sessionId } : {}), role: 'coder', callId, kind: 'tool', state,
    toolName, idempotencyKey: `tool:${callId}:${state}` });
}

export type CodeRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface CodeRunResult {
  ref: CodeRunRef;
  status: CodeRunStatus;
  summary: string;
  stopReason?: string;
  exitCode?: number;
  resumed: boolean;
}

export interface CodeAgentBackend {
  readonly id: CodeAgentId;
  readonly label: string;
  readonly capabilities: CodeAgentCapabilities;
  readonly running: boolean;
  readonly takesImages: boolean;

  start(): Promise<void>;
  onExit(listener: (error: Error) => void): () => void;
  run(task: CodeTask, options: CodeAgentRunOptions): Promise<CodeRunResult>;
  close(): Promise<void>;
}

/**
 * A configured provider. Detection is deliberately separate from starting a
 * task so the settings page can show availability without consuming a task.
 */
export interface CodeAgentAdapter extends CodeAgentBackend {
  detect(): Promise<CodeAgentAvailability>;
  /** Reject a task that cannot be represented by the provider's configured isolation. */
  validateTask?(task: CodeTask): void;
  /** Configured provider network policy, when it overrides the Host default. */
  taskNetworkPolicy?: 'deny' | 'allow';
}

/** Configuration/host declarations and real verification are separate facts. */
export interface CodeAgentIsolationEvidence {
  provider: CodeAgentId;
  reported: { sandbox: boolean; networkPolicy: boolean };
  source: 'dsh-configuration' | 'host-declaration' | 'unclaimed';
  verification: { sandbox: 'unverified'; networkPolicy: 'unverified' };
  detail: string;
}

/** Read-only status: existing capability flags do not prove OS isolation. */
export function codeAgentIsolationEvidence(adapter: CodeAgentAdapter | null | undefined): CodeAgentIsolationEvidence | null {
  if (!adapter) return null;
  const source = adapter.id === 'dsh' ? 'dsh-configuration' : adapter.id === 'builtin' ? 'host-declaration' : 'unclaimed';
  return {
    provider: adapter.id,
    reported: { sandbox: adapter.capabilities.sandbox, networkPolicy: adapter.capabilities.networkPolicy },
    source,
    verification: { sandbox: 'unverified', networkPolicy: 'unverified' },
    detail: source === 'dsh-configuration' ? 'Isolation flags describe DSH configuration only; end-to-end enforcement has not been verified.'
      : source === 'host-declaration' ? 'Isolation flags reflect any Host declaration; end-to-end enforcement has not been verified.'
        : 'Isolation enforcement has not been verified for this provider.',
  };
}
