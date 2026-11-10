/**
 * The task bus between the pet's roles. Nobody waits on anybody: `submit` stores a task and returns its id at
 * once, a worker pool per role runs tasks as slots free up, and the outcome is pushed to `onSettled`. Why it
 * exists and what it borrows are noted with its code.
 *
 * - Tasks live in SQLite, so a restart loses none: a task found running at start is queued again. Nothing runs
 *   before `start`, so the owner can open the bus before the runners' dependencies are ready.
 * - Urgent tasks are taken before normal ones. When an urgent task finds its role full of normal tasks, the
 *   newest normal one is asked to stop at its next safe point (`shouldStop`) and goes back to the queue, marked
 *   resumed; whoever runs it again reads its history from the ledger.
 * - The operations are the five of LangChain Deep Agents' async subagents: submit, get, update (a note for the
 *   task, read by the runner through `notes`), cancel and list. Results are pushed instead of polled.
 * - Every transition is written to the ledger under the task's incident.
 */
import { randomUUID } from 'node:crypto';
import type { Ledger, Role } from '../ledger/ledger.ts';
import { openDb, transaction, type Db } from '../sqlite.ts';
import type { CodeAgentActivityCandidate, CodeRunRef } from './code-agent.ts';

/** Roles that take tasks from the bus; the front gets results through `onSettled`. */
export type Worker = Exclude<Role, 'front' | 'daily'>;
export type Priority = 'urgent' | 'normal';
export type Status = 'queued' | 'running' | 'unknown' | 'done' | 'failed' | 'cancelled';
/** Labels prefixed this way identify control work that should not be presented as a person's ordinary task. */
export const INTERNAL_TASK_PREFIX = 'internal:';
export const isInternalTask = (task: Pick<Task, 'label'>): boolean => task.label?.startsWith(INTERNAL_TASK_PREFIX) === true;

/** Runner completed with an outcome that may have caused an external side effect. */
export class UncertainTaskError extends Error {
  readonly uncertain = true;
  constructor(message: string) { super(message); this.name = 'UncertainTaskError'; }
}

export interface Task {
  id: string;
  to: Worker;
  from: Role;
  priority: Priority;
  body: string;
  incidentId: string;
  /** The task this one was split from, if any. */
  parentId: string | null;
  status: Status;
  /** How many times the task was started; more than one means it was stopped or crashed before. */
  attempts: number;
  notes: string[];
  result: string | null;
  createdAt: string;
  settledAt: string | null;
  /** How the front thinks of the task, in its own words; null when it gave none. */
  label: string | null;
  /** What the worker last said it was doing, in plain words; null before it said. */
  progress: string | null;
  /** Stable execution-path label retained across process restarts. */
  runnerId: string;
  /** Provider pinned before a code task starts; null for older or unstarted records. */
  codeProvider: string | null;
  /** Latest provider reference durably reported by the adapter. */
  codeRunRef: CodeRunRef | null;
}

export interface SubmitInput {
  to: Worker;
  from: Role;
  body: string;
  priority?: Priority;
  /** Defaults to a new incident; pass the parent's to keep a chain of work under one incident. */
  incidentId?: string;
  parentId?: string;
  label?: string;
  runnerId?: string;
}

export interface RunControl {
  /** True once the task must stop at its next safe point: it was cancelled or preempted. */
  shouldStop(): boolean;
  /** Aborts framework/model calls when cancellation or preemption is requested. */
  signal: AbortSignal;
  /** Notes added through `update` since the task was submitted, oldest first. */
  notes(): string[];
}

/** Explicitly completed runner work survives a cancellation request racing its settlement. */
export type ConfirmedTaskSuccess = { kind: 'confirmed-success'; result: string };
/** A plain string retains the existing cooperative cancellation semantics. */
export type Runner = (task: Task, control: RunControl) => Promise<string | ConfirmedTaskSuccess>;

export interface BusOptions {
  runners: Record<Worker, Runner>;
  /** Additional execution paths selected by a task's persisted runnerId. */
  alternateRunners?: Record<string, Partial<Record<Worker, Runner>>>;
  defaultRunnerId?: string;
  defaultRunnerIds?: Partial<Record<Worker, string>>;
  /** Tasks each role runs at once. */
  limits?: Partial<Record<Worker, number>>;
  ledger?: Ledger;
  /** Called once a task is done, failed or cancelled. */
  onSettled?: (task: Task) => void;
  now?: () => Date;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  to_role TEXT NOT NULL,
  from_role TEXT NOT NULL,
  priority TEXT NOT NULL,
  body TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS task_queue ON task (to_role, status, priority, seq);
CREATE TABLE IF NOT EXISTS code_result_delivery (
  task_id TEXT PRIMARY KEY,
  followup_id TEXT
);
CREATE TABLE IF NOT EXISTS front_result_delivery (
  task_id TEXT PRIMARY KEY,
  retryable INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT
);
CREATE TABLE IF NOT EXISTS permission_request (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS code_agent_activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  provider TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  call_id TEXT,
  tool_name TEXT,
  created_at TEXT NOT NULL
);
`;

const DEFAULT_LIMITS: Record<Worker, number> = { control: 1, coder: 2 };
const OPEN: ReadonlySet<Status> = new Set(['queued', 'running']);

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    to: r.to_role as Worker,
    from: r.from_role as Role,
    priority: r.priority as Priority,
    body: r.body as string,
    incidentId: r.incident_id as string,
    parentId: r.parent_id as string | null,
    status: r.status as Status,
    attempts: r.attempts as number,
    notes: JSON.parse(r.notes as string) as string[],
    result: r.result as string | null,
    createdAt: r.created_at as string,
    settledAt: r.settled_at as string | null,
    label: (r.label as string | null | undefined) ?? null,
    progress: (r.progress as string | null | undefined) ?? null,
    runnerId: (r.runner_id as string | null | undefined) ?? 'legacy-v1',
    codeProvider: (r.code_provider as string | null | undefined) ?? null,
    codeRunRef: typeof r.code_provider === 'string' && typeof r.code_run_id === 'string'
      ? { provider: r.code_provider, runId: r.code_run_id, ...(typeof r.code_session_id === 'string' ? { sessionId: r.code_session_id } : {}) }
      : null,
  };
}

interface Running { to: Worker; priority: Priority; stop: 'cancel' | 'preempt' | null; startedSeq: number; abort: AbortController }

function validateCodeAgentActivity(value: CodeAgentActivityCandidate): void {
  const item = value as unknown as Record<string, unknown>;
  const fail = () => { throw new Error('invalid code agent activity'); };
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail();
  const short = (field: string, max: number, pattern: RegExp) => typeof item[field] === 'string'
    && (item[field] as string).length > 0 && (item[field] as string).length <= max && pattern.test(item[field] as string);
  if (!short('taskId', 160, /^[\w:-]+$/) || !Number.isSafeInteger(item.attempt) || (item.attempt as number) < 1
    || !short('provider', 64, /^[a-z][a-z0-9_-]*$/) || !short('runId', 200, /^[^\x00-\x1f\x7f]+$/)
    || !['coder', 'control'].includes(String(item.role)) || !short('idempotencyKey', 300, /^[\w:.-]+$/)) fail();
  if (item.sessionId !== undefined && !short('sessionId', 200, /^[^\x00-\x1f\x7f]+$/)) fail();
  if (item.kind === 'state') {
    if (!['started', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(String(item.state))
      || !['state:started', 'state:finished'].includes(String(item.idempotencyKey))
      || 'callId' in item || 'toolName' in item) fail();
  } else if (item.kind === 'tool') {
    if (!['started', 'updated', 'finished'].includes(String(item.state))
      || !short('callId', 160, /^[\w:-]+$/) || !short('toolName', 200, /^[^\x00-\x1f\x7f]+$/)
      || item.idempotencyKey !== `tool:${String(item.callId)}:${String(item.state)}`) fail();
  } else fail();
}

export class TaskBus {
  private readonly db: Db;
  private readonly runners: Record<Worker, Runner>;
  private readonly alternateRunners: Record<string, Partial<Record<Worker, Runner>>>;
  private readonly defaultRunnerId: string;
  private readonly defaultRunnerIds: Partial<Record<Worker, string>>;
  private readonly limits: Record<Worker, number>;
  private readonly ledger?: Ledger;
  private readonly onSettled?: (task: Task) => void;
  private readonly now: () => Date;
  private readonly running = new Map<string, Running>();
  private readonly idle = new Set<() => void>();
  private startSeq = 0;
  private started = false;
  private closed = false;
  private dbClosed = false;

  constructor(file: string, opts: BusOptions) {
    this.runners = opts.runners;
    this.alternateRunners = opts.alternateRunners ?? {};
    this.defaultRunnerId = opts.defaultRunnerId ?? 'legacy-v1';
    this.defaultRunnerIds = opts.defaultRunnerIds ?? {};
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.ledger = opts.ledger;
    this.onSettled = opts.onSettled;
    this.now = opts.now ?? (() => new Date());
    this.db = openDb(file);
    this.db.exec(SCHEMA);
    // columns added after the first version: a file made before them gains them here
    const cols = new Set((this.db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('label')) this.db.exec('ALTER TABLE task ADD COLUMN label TEXT');
    if (!cols.has('progress')) this.db.exec('ALTER TABLE task ADD COLUMN progress TEXT');
    if (!cols.has('runner_id')) this.db.exec("ALTER TABLE task ADD COLUMN runner_id TEXT NOT NULL DEFAULT 'legacy-v1'");
    if (!cols.has('code_provider')) this.db.exec('ALTER TABLE task ADD COLUMN code_provider TEXT');
    if (!cols.has('code_run_id')) this.db.exec('ALTER TABLE task ADD COLUMN code_run_id TEXT');
    if (!cols.has('code_session_id')) this.db.exec('ALTER TABLE task ADD COLUMN code_session_id TEXT');
    const deliveryCols = new Set((this.db.prepare('PRAGMA table_info(front_result_delivery)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!deliveryCols.has('retryable')) this.db.exec('ALTER TABLE front_result_delivery ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0');
    if (!deliveryCols.has('accepted_at')) this.db.exec('ALTER TABLE front_result_delivery ADD COLUMN accepted_at TEXT');
    // An interrupted process may already have caused an external side effect. Never replay it silently.
    this.db.prepare("UPDATE task SET status = 'unknown' WHERE status = 'running'").run();
    this.db.prepare("UPDATE permission_request SET state = 'interrupted', ended_at = ? WHERE state = 'pending'").run(this.now().toISOString());
  }

  /** Starts running tasks, those left from before included. Until then `submit` only stores. */
  start(): void {
    this.started = true;
    try { for (const task of this.pendingCodeResults()) this.onSettled?.(task); }
    catch (error) {
      // The owner retries pending delivery; do not leave the scheduler half-started
      // solely because the initial delivery scan failed.
      console.warn(`[agents] initial code result scan failed: ${(error as Error).message}`);
    }
    this.pump();
  }

  /** Stores a task and returns at once; the task starts when its role has a free slot. */
  submit(input: SubmitInput): Task {
    if (this.closed) throw new Error('task bus is closing');
    const task: Task = {
      id: randomUUID(), to: input.to, from: input.from, priority: input.priority ?? 'normal', body: input.body,
      incidentId: input.incidentId ?? randomUUID(), parentId: input.parentId ?? null, status: 'queued', attempts: 0,
      notes: [], result: null, createdAt: this.now().toISOString(), settledAt: null, label: input.label?.trim() || null, progress: null,
      runnerId: input.runnerId?.trim() || this.defaultRunnerIds[input.to] || this.defaultRunnerId,
      codeProvider: null,
      codeRunRef: null,
    };
    this.db.prepare(`INSERT INTO task (id, to_role, from_role, priority, body, incident_id, parent_id, status, created_at, label, runner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(task.id, task.to, task.from, task.priority, task.body, task.incidentId, task.parentId, task.createdAt, task.label, task.runnerId);
    try {
      this.ledger?.append({
        role: task.from, actor: task.from, op: task.priority === 'urgent' ? 'escalate' : 'dispatch',
        summary: `task for ${task.to}: ${task.body}`, incidentId: task.incidentId, spanId: task.id, parentSpanId: task.parentId ?? undefined,
      });
    } catch (error) {
      // The task is already committed. Returning an error here could cause a
      // duplicate submission, and must not prevent the committed task running.
      console.warn(`[agents] task dispatch audit could not be recorded: ${(error as Error).message}`);
    }
    if (task.priority === 'urgent') this.preemptFor(task.to);
    this.pump();
    return task;
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM task WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
  }

  /** Whether this in-process run has already been asked to stop. */
  stopRequested(id: string): boolean {
    return this.running.get(id)?.stop != null;
  }

  recordPermission(id: string, taskId: string): void {
    this.db.prepare("INSERT INTO permission_request (id, task_id, state, created_at) VALUES (?, ?, 'pending', ?)")
      .run(id, taskId, this.now().toISOString());
  }

  finishPermission(id: string, state: 'allowed' | 'refused' | 'timed_out' | 'interrupted'): boolean {
    return this.db.prepare("UPDATE permission_request SET state = ?, ended_at = ? WHERE id = ? AND state = 'pending'")
      .run(state, this.now().toISOString(), id).changes === 1;
  }

  permissionState(id: string): { taskId: string; state: string } | null {
    const row = this.db.prepare('SELECT task_id, state FROM permission_request WHERE id = ?').get(id) as { task_id: string; state: string } | undefined;
    return row ? { taskId: row.task_id, state: row.state } : null;
  }

  pendingPermissions(): Array<{ id: string; taskId: string; state: string; createdAt: string }> {
    return (this.db.prepare("SELECT id, task_id, state, created_at FROM permission_request WHERE state = 'pending' ORDER BY created_at")
      .all() as Array<{ id: string; task_id: string; state: string; created_at: string }>).map((row) => ({ id: row.id, taskId: row.task_id, state: row.state, createdAt: row.created_at }));
  }

  /** Persist a public, provider-neutral execution fact exactly once. */
  appendCodeAgentActivity(activity: CodeAgentActivityCandidate): { sequence: number; inserted: boolean; at: string } {
    validateCodeAgentActivity(activity);
    const at = this.now().toISOString();
    const key = JSON.stringify([activity.taskId, activity.attempt, activity.provider, activity.runId, activity.idempotencyKey]);
    let result!: { sequence: number; inserted: boolean; at: string };
    transaction(this.db, () => {
      const existing = this.db.prepare('SELECT sequence, created_at FROM code_agent_activity WHERE idempotency_key = ?')
        .get(key) as { sequence: number; created_at: string } | undefined;
      if (existing) { result = { sequence: existing.sequence, inserted: false, at: existing.created_at }; return; }
      const info = this.db.prepare(`INSERT INTO code_agent_activity
        (idempotency_key, task_id, attempt, provider, run_id, session_id, role, kind, state, call_id, tool_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, activity.taskId, activity.attempt, activity.provider, activity.runId,
          activity.sessionId ?? null, activity.role, activity.kind, activity.state,
          activity.kind === 'tool' ? activity.callId : null, activity.kind === 'tool' ? activity.toolName : null, at);
      result = { sequence: Number(info.lastInsertRowid), inserted: true, at };
    });
    return result;
  }

  listCodeAgentActivity(afterSequence = 0, limit = 50): { items: Array<Record<string, unknown>>; sequence: number; hasMore: boolean; coverage: 'partial'; reset?: boolean } {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid code activity cursor');
    const latest = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM code_agent_activity').get() as { sequence: number }).sequence;
    if (afterSequence > latest) return { items: [], sequence: afterSequence, hasMore: false, coverage: 'partial', reset: true };
    const rows = this.db.prepare(`SELECT sequence, task_id, attempt, provider, run_id, session_id, role, kind, state, call_id, tool_name, created_at
      FROM code_agent_activity WHERE sequence > ? ORDER BY sequence LIMIT ?`).all(afterSequence, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const sequence = rows.length ? Number(rows[rows.length - 1]!.sequence) : afterSequence;
    return { items: rows, sequence, hasMore, coverage: 'partial' };
  }

  /** Pin a provider before any code side effect; do not guess an older started task's provider. */
  bindCodeProvider(id: string, provider: string): void {
    const task = this.get(id);
    if (!task || task.to !== 'coder' || task.status !== 'running' || !provider.trim()) throw new Error('cannot bind code provider to this task');
    if (task.codeProvider && task.codeProvider !== provider) {
      const detail = `code agent mismatch: task requires ${task.codeProvider}, available provider is ${provider}`;
      throw task.attempts > 1 ? new UncertainTaskError(`${detail}; previous outcome: ${task.result ?? 'unknown'}`) : new Error(detail);
    }
    if (!task.codeProvider && task.attempts > 1) throw new UncertainTaskError(`code agent unknown: older started task has no recorded provider; previous outcome: ${task.result ?? 'unknown'}`);
    if (!task.codeProvider) this.db.prepare('UPDATE task SET code_provider = ? WHERE id = ? AND code_provider IS NULL').run(provider, id);
  }

  /** Persist each adapter run-reference update before the provider continues. */
  bindCodeRunRef(id: string, ref: CodeRunRef): void {
    if (!ref.provider.trim() || !ref.runId.trim() || (ref.sessionId !== undefined && !ref.sessionId.trim())) throw new Error('invalid code run reference');
    transaction(this.db, () => {
      const task = this.get(id);
      if (!task || task.to !== 'coder' || task.status !== 'running') throw new Error('cannot bind code run reference to this task');
      if (task.codeProvider && task.codeProvider !== ref.provider) throw new UncertainTaskError(`code agent mismatch: task requires ${task.codeProvider}, received ${ref.provider}`);
      if (task.attempts > 1 && !task.codeProvider) throw new UncertainTaskError('code agent unknown: resumed task has no pinned provider');
      if (task.codeRunRef && task.codeRunRef.provider !== ref.provider) throw new UncertainTaskError('code agent mismatch: run reference provider changed');
      this.db.prepare("UPDATE task SET code_provider = ?, code_run_id = ?, code_session_id = ? WHERE id = ? AND status = 'running'")
        .run(ref.provider, ref.runId, ref.sessionId ?? null, id);
    });
  }

  /** Code results committed before a crash but not yet converted into a control task. */
  pendingCodeResults(): Task[] {
    return (this.db.prepare(`SELECT task.* FROM task JOIN code_result_delivery d ON d.task_id = task.id
      WHERE d.followup_id IS NULL ORDER BY task.seq`).all() as Record<string, unknown>[]).map(rowToTask);
  }

  /** Results whose front delivery has no durable receipt, including legacy unclassified results. */
  unconfirmedFrontResults(): Task[] {
    return (this.db.prepare(`SELECT task.* FROM task JOIN front_result_delivery d ON d.task_id = task.id
      WHERE d.accepted_at IS NULL ORDER BY task.seq`).all() as Record<string, unknown>[]).map(rowToTask);
  }

  /** Only results created with a durable receiver may be retried automatically. */
  retryableFrontResults(): Task[] {
    return (this.db.prepare(`SELECT task.* FROM task JOIN front_result_delivery d ON d.task_id = task.id
      WHERE d.retryable = 1 AND d.accepted_at IS NULL ORDER BY task.seq`).all() as Record<string, unknown>[]).map(rowToTask);
  }

  ackFrontResult(id: string): void {
    this.db.prepare('UPDATE front_result_delivery SET accepted_at = ? WHERE task_id = ? AND retryable = 1 AND accepted_at IS NULL').run(this.now().toISOString(), id);
  }

  /** Atomically records the single control follow-up for a settled code task. */
  deliverCodeResult(task: Task): string {
    let id = '';
    let inserted = false;
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT followup_id FROM code_result_delivery WHERE task_id = ?').get(task.id) as { followup_id: string | null } | undefined;
      if (!row) throw new Error(`No pending code result for ${task.id}`);
      if (row.followup_id) { id = row.followup_id; return; }
      id = randomUUID();
      const body = `Code task ${task.id} ${task.status}. Its task was: ${task.body}\nResult: ${task.result ?? '(none)'}`;
      this.db.prepare(`INSERT INTO task (id, to_role, from_role, priority, body, incident_id, parent_id, status, created_at, runner_id)
        VALUES (?, 'control', 'coder', 'normal', ?, ?, ?, 'queued', ?, ?)`)
        .run(id, body, task.incidentId, task.id, this.now().toISOString(), this.defaultRunnerIds.control || this.defaultRunnerId);
      this.db.prepare('UPDATE code_result_delivery SET followup_id = ? WHERE task_id = ?').run(id, task.id);
      inserted = true;
    });
    if (inserted) {
      try {
        this.ledger?.append({ role: 'coder', actor: 'coder', op: 'dispatch', summary: `code result follow-up for ${task.id}`,
          incidentId: task.incidentId, spanId: id, parentSpanId: task.id });
      } finally {
        // The follow-up is committed even if the audit write fails. Do not leave
        // the committed queued task waiting for an unrelated future pump.
        this.pump();
      }
    }
    return id;
  }

  /** Explicitly resolves an interrupted task after the owner decides whether replay is safe. */
  recover(id: string, action: 'resume' | 'cancel'): boolean {
    const task = this.get(id);
    if (!task || task.status !== 'unknown') return false;
    if (action === 'resume' && task.to === 'coder' && task.codeProvider && !task.codeRunRef?.sessionId) {
      throw new UncertainTaskError(`code agent run ${task.codeRunRef?.runId ?? '(unknown)'} has no resumable session reference; keep the task unknown`);
    }
    if (action === 'cancel') {
      const previous = task.result ? `\nPrevious outcome remains unknown: ${task.result}` : '\nPrevious outcome remains unknown.';
      this.settle(task, 'cancelled', `Not resumed after an interrupted run.${previous}`);
      return true;
    }
    this.db.prepare("UPDATE task SET status = 'queued', settled_at = NULL WHERE id = ?").run(id);
    this.audit({ role: task.to, actor: task.to, op: 'action', summary: 'unknown task explicitly resumed', result: 'uncertain', incidentId: task.incidentId, parentSpanId: id });
    this.pump();
    return true;
  }


  /** Records what the worker says it is doing now; false when the task is not open. */
  setProgress(id: string, progress: string): boolean {
    const task = this.get(id);
    if (!task || !OPEN.has(task.status)) return false;
    this.db.prepare('UPDATE task SET progress = ? WHERE id = ?').run(progress.trim(), id);
    return true;
  }

  /** Adds a note to an open task; false when the task is missing or already settled. */
  update(id: string, note: string): boolean {
    const task = this.get(id);
    if (!task || !OPEN.has(task.status)) return false;
    this.db.prepare('UPDATE task SET notes = ? WHERE id = ?').run(JSON.stringify([...task.notes, note]), id);
    try {
      this.ledger?.append({ role: task.from, actor: task.from, op: 'note', summary: `note for task: ${note}`, incidentId: task.incidentId, parentSpanId: id });
    } catch (error) {
      // The task row is the acceptance receipt. Do not make the caller retry
      // an already durable note just because the audit append failed.
      console.warn(`[agents] note audit could not be recorded: ${(error as Error).message}`);
    }
    return true;
  }

  /**
   * Cancels an open task: a queued one at once, a running one when its runner next checks `shouldStop`.
   * False when the task is missing or already settled.
   */
  cancel(id: string): boolean {
    const task = this.get(id);
    if (!task || !OPEN.has(task.status)) return false;
    const run = this.running.get(id);
    if (run) { run.stop = 'cancel'; run.abort.abort(); }
    else this.settle(task, 'cancelled', null);
    return true;
  }

  /** Tasks for one role or all, open ones first, each group oldest first. */
  list(filter: { to?: Worker; open?: boolean } = {}): Task[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.to) { where.push('to_role = ?'); args.push(filter.to); }
    if (filter.open) where.push("status IN ('queued', 'running')");
    const sql = `SELECT * FROM task ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY status NOT IN ('queued', 'running'), seq`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToTask);
  }

  /** Resolves once nothing is running and nothing that can start is queued. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  /** Stops taking tasks; running ones keep their slots until their runners return. */
  close(): void {
    void this.closeAsync();
  }

  async closeAsync(): Promise<void> {
    if (this.dbClosed) return;
    this.closed = true;
    await this.whenIdle();
    if (!this.dbClosed) { this.dbClosed = true; this.db.close(); }
  }

  private next(to: Worker): Task | null {
    const row = this.db.prepare(`SELECT * FROM task WHERE to_role = ? AND status = 'queued'
      ORDER BY priority = 'urgent' DESC, seq LIMIT 1`).get(to) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
  }

  private load(to: Worker): number {
    let n = 0;
    for (const run of this.running.values()) if (run.to === to) n++;
    return n;
  }

  private pump(): void {
    if (this.closed || !this.started) return;
    for (const to of Object.keys(this.limits) as Worker[]) {
      while (this.load(to) < this.limits[to]) {
        const task = this.next(to);
        if (!task) break;
        this.launch(task);
      }
    }
    this.checkIdle();
  }

  private launch(task: Task): void {
    const runner = this.alternateRunners[task.runnerId]?.[task.to]
      ?? (task.runnerId === 'legacy-v1' ? this.runners[task.to] : undefined);
    if (!runner) {
      // A persisted task must never silently switch execution paths when configuration changes.
      if (task.attempts > 0) this.markUnknown(task, `runner unavailable: ${task.runnerId}; previous outcome: ${task.result ?? 'unknown'}`, 'task outcome unknown');
      else this.settle(task, 'failed', `runner unavailable: ${task.runnerId}`);
      return;
    }
    const attempts = task.attempts + 1;
    this.db.prepare("UPDATE task SET status = 'running', attempts = ? WHERE id = ?").run(attempts, task.id);
    const run: Running = { to: task.to, priority: task.priority, stop: null, startedSeq: ++this.startSeq, abort: new AbortController() };
    this.running.set(task.id, run);
    const started = { ...task, status: 'running' as const, attempts };
    this.audit({
      role: task.to, actor: task.to, op: 'action', summary: attempts > 1 ? 'task resumed' : 'task started',
      incidentId: task.incidentId, parentSpanId: task.id,
    });
    const control: RunControl = {
      shouldStop: () => run.stop !== null,
      signal: run.abort.signal,
      notes: () => this.get(task.id)?.notes ?? [],
    };
    let outcome: Promise<string | ConfirmedTaskSuccess>;
    try { outcome = runner(started, control); }
    catch (error) { outcome = Promise.reject(error); }
    outcome.then(
      (result) => this.finish(task.id, run, { result }),
      (error: unknown) => this.finish(task.id, run, { error: error instanceof Error ? error : new Error(String(error)) }),
    );
  }

  private finish(id: string, run: Running, outcome: { result?: string | ConfirmedTaskSuccess; error?: Error }): void {
    this.running.delete(id);
    const task = this.get(id);
    const result = typeof outcome.result === 'string' ? outcome.result : undefined;
    if (task) {
      if (typeof outcome.result === 'object' && outcome.result.kind === 'confirmed-success') {
        this.settle(task, 'done', outcome.result.result);
      } else if (run.stop === 'cancel' && outcome.error instanceof UncertainTaskError) {
        this.markUnknown(task, outcome.error.message, 'cancellation outcome unknown');
      } else if (run.stop === 'cancel') this.settle(task, 'cancelled', result ?? null);
      else if (run.stop === 'preempt') this.markUnknown(task, outcome.error?.message ?? result ?? 'preempted before result was known');
      else if (outcome.error !== undefined) {
        const error = outcome.error;
        if (error instanceof UncertainTaskError) this.markUnknown(task, error.message, 'task outcome unknown');
        else this.settle(task, 'failed', error.message);
      }
      else this.settle(task, 'done', result ?? '');
    }
    if (this.closed) { this.checkIdle(); return; }
    this.pump();
  }

  private settle(task: Task, status: 'done' | 'failed' | 'cancelled', result: string | null): void {
    const settledAt = this.now().toISOString();
    transaction(this.db, () => {
      this.db.prepare('UPDATE task SET status = ?, result = ?, settled_at = ? WHERE id = ?').run(status, result, settledAt, task.id);
      if (task.from === 'control' && task.to === 'coder') this.db.prepare('INSERT OR IGNORE INTO code_result_delivery (task_id) VALUES (?)').run(task.id);
      else if (task.from !== 'daily' && !(task.from === 'front' && status === 'cancelled')) {
        this.db.prepare('INSERT OR IGNORE INTO front_result_delivery (task_id, retryable) VALUES (?, 1)').run(task.id);
      }
    });
    this.audit({
      role: task.to, actor: task.to, op: 'action', summary: `task ${status}`,
      result: status === 'done' ? 'ok' : status === 'failed' ? 'fail' : 'uncertain',
      incidentId: task.incidentId, parentSpanId: task.id, ...(result ? { why: result.slice(0, 500) } : {}),
    });
    this.onSettled?.({ ...task, status, result, settledAt });
  }

  private markUnknown(task: Task, detail: string, summary = 'task interrupted for an urgent one'): void {
    transaction(this.db, () => {
      this.db.prepare("UPDATE task SET status = 'unknown', result = ?, settled_at = NULL WHERE id = ?").run(detail, task.id);
    });
    this.audit({ role: task.to, actor: task.to, op: 'action', summary,
      result: 'uncertain', incidentId: task.incidentId, parentSpanId: task.id, why: detail.slice(0, 500) });
  }

  /** Asks the newest running normal task of a full role to stop, so an urgent one can take its slot. */
  private preemptFor(to: Worker): void {
    if (this.load(to) < this.limits[to]) return;
    let victim: [string, Running] | null = null;
    for (const entry of this.running) {
      const [, run] = entry;
      if (run.to === to && run.priority === 'normal' && run.stop === null && (!victim || run.startedSeq > victim[1].startedSeq)) victim = entry;
    }
    if (victim) { victim[1].stop = 'preempt'; victim[1].abort.abort(); }
  }

  private isIdle(): boolean {
    if (this.running.size) return false;
    if (this.closed) return true;
    return (Object.keys(this.limits) as Worker[]).every((to) => this.limits[to] === 0 || !this.next(to));
  }

  private checkIdle(): void {
    if (!this.idle.size || !this.isIdle()) return;
    for (const resolve of this.idle) resolve();
    this.idle.clear();
  }

  /** The task database remains the operational receipt when audit storage is unavailable. */
  private audit(entry: Parameters<NonNullable<Ledger['append']>>[0]): void {
    try { this.ledger?.append(entry); }
    catch (error) { console.warn(`[agents] task audit could not be recorded: ${(error as Error).message}`); }
  }
}
