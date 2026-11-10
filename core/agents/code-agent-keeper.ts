import type {
  CodeAgentAdapter,
  CodeAgentRunOptions,
  CodeRunResult,
  CodeTask,
} from './code-agent.ts';
import { KEEPER_DEFAULTS, retryDelay, type KeeperStatus } from './dsh-keeper.ts';
import { UncertainTaskError } from './bus.ts';

export interface CodeAgentKeeperOptions {
  /** Re-evaluated on demand and while unavailable; null means no provider is currently available. */
  backend: () => CodeAgentAdapter | null;
  idleMs?: number; initialBackoffMs?: number; maxBackoffMs?: number; maxFailures?: number;
  stableMs?: number; availabilityPollMs?: number; startupTimeoutMs?: number; cancellationPollMs?: number;
}

interface Job {
  task: CodeTask;
  run: CodeAgentRunOptions;
  resolve: (result: CodeRunResult) => void;
  reject: (error: Error) => void;
}

export function unsupportedPolicy(task: CodeTask, backend: CodeAgentAdapter): string | null {
  if (task.resume && !backend.capabilities.resume) return `${backend.label} does not support resuming a previous run`;
  try { backend.validateTask?.(task); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  if (!backend.capabilities.sandbox) return `${backend.label} does not provide a verified sandbox`;
  if (task.network === 'deny' && !backend.capabilities.networkPolicy) return `${backend.label} cannot enforce the required network policy`;
  return null;
}

/** Owns one provider process for queued code tasks, without knowing its wire protocol. */
export class CodeAgentKeeper {
  private readonly options: Required<CodeAgentKeeperOptions>;
  private queue: Job[] = [];
  private backend: CodeAgentAdapter | null = null;
  get takesImages(): boolean { return this.backend?.takesImages === true; }
  private unsubscribe: (() => void) | null = null;
  private kind: KeeperStatus['kind'] = 'idle';
  private failures = 0;
  private reason: string | null = null;
  private retryAtMs: number | null = null;
  private attempt = 0;
  private failedAttempt = -1;
  private active = false;
  private pumping: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private closeFailure: Error | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private cancelTimer: NodeJS.Timeout | null = null;

  constructor(options: CodeAgentKeeperOptions) {
    this.options = { ...KEEPER_DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.options)) if (key !== 'backend' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new RangeError(`Invalid keeper limit: ${key}`);
    if (!Number.isInteger(this.options.maxFailures)) throw new RangeError('maxFailures must be an integer');
  }

  status(): KeeperStatus {
    return { kind: this.kind, queued: this.queue.length, active: this.active, failures: this.failures, retryAtMs: this.retryAtMs, reason: this.reason };
  }

  run(task: CodeTask, run: CodeAgentRunOptions): Promise<CodeRunResult> {
    if (this.kind === 'stopped') return Promise.reject(new Error('code agent keeper stopped'));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const promise = new Promise<CodeRunResult>((resolve, reject) => { this.queue.push({ task, run, resolve, reject }); });
    this.cancelTimer ??= setInterval(() => this.cancelWaiting(), this.options.cancellationPollMs);
    this.wake();
    return promise;
  }

  reset(): void {
    if (this.kind === 'stopped') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null; this.retryAtMs = null; this.failures = 0; this.reason = null;
    this.kind = this.backend ? 'running' : 'idle'; this.wake();
  }

  stop(): Promise<void> { return this.stopping ??= this.shutdown(); }

  private async shutdown(): Promise<void> {
    this.kind = 'stopped';
    for (const timer of [this.retryTimer, this.idleTimer, this.stableTimer]) if (timer) clearTimeout(timer);
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    this.retryTimer = null; this.retryAtMs = null; this.cancelTimer = null;
    for (const job of this.queue.splice(0)) job.reject(new Error('code agent keeper stopped'));
    const results = await Promise.allSettled([this.closeBackend(), this.closing, this.pumping]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (this.closeFailure) { errors.push(this.closeFailure); this.closeFailure = null; }
    if (errors.length) throw new AggregateError(errors, 'code agent keeper could not close cleanly');
  }

  private wake(): void {
    if (this.pumping || this.retryTimer || this.kind === 'fused' || this.kind === 'stopped' || !this.queue.length) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      if (this.queue.length && !this.retryTimer && this.kind !== 'fused' && this.kind !== 'stopped') this.wake();
    });
  }

  private async pump(): Promise<void> {
    if (this.closing) await this.closing;
    this.cancelWaiting();
    while (this.queue.length && this.kind !== 'stopped' && this.kind !== 'fused' && !this.retryTimer) {
      if (!this.backend) {
        let backend: CodeAgentAdapter | null;
        try { backend = this.options.backend(); }
        catch (error) { this.failed(++this.attempt, error instanceof Error ? error : new Error(String(error))); return; }
        if (!backend) { this.wait(this.options.availabilityPollMs, 'not-available'); return; }
        const next = this.queue[0]!;
        const requested = next.task.preferredAgent;
        const resumed = next.task.resume?.provider;
        if ((requested && requested !== backend.id) || (resumed && resumed !== backend.id)) {
          this.queue.shift();
          next.reject(new Error(`code agent mismatch: task requires ${resumed ?? requested}, available provider is ${backend.id}`));
          continue;
        }
        const policyError = unsupportedPolicy(next.task, backend);
        if (policyError) { this.queue.shift(); next.reject(new Error(policyError)); continue; }
        const attempt = ++this.attempt;
        this.backend = backend; this.kind = 'starting'; this.reason = null;
        this.unsubscribe = backend.onExit(error => this.failed(attempt, error));
        let startupTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([backend.start(), new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error(`${backend.label} startup timed out`)), this.options.startupTimeoutMs); })]);
        } catch (error) {
          this.failed(attempt, error instanceof Error ? error : new Error(String(error)));
          try { await backend.close(); }
          catch (closeError) {
            this.closeFailure = closeError instanceof Error ? closeError : new Error(String(closeError));
            this.reason = `startup close failed: ${this.closeFailure.message}`;
          }
          return;
        } finally { if (startupTimer) clearTimeout(startupTimer); }
        if (this.isStopped()) { await backend.close(); return; }
        if (attempt !== this.attempt || this.failedAttempt === attempt) return;
        this.kind = 'running';
        this.stableTimer = setTimeout(() => { if (this.backend === backend && backend.running) this.failures = 0; }, this.options.stableMs);
      }
      const backend = this.backend!;
      this.cancelWaiting();
      const job = this.queue.shift();
      if (!job) break;
      const requested = job.task.preferredAgent;
      const resumed = job.task.resume?.provider;
      if ((requested && requested !== backend.id) || (resumed && resumed !== backend.id)) {
        job.reject(new Error(`code agent mismatch: task requires ${resumed ?? requested}, available provider is ${backend.id}`));
        continue;
      }
      const policyError = unsupportedPolicy(job.task, backend);
      if (policyError) { job.reject(new Error(policyError)); continue; }
      this.active = true;
      let started = false;
      try {
        job.resolve(await backend.run(job.task, { ...job.run, onStarted: (ref) => {
          started = true;
          job.run.onStarted?.(ref);
        } }));
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (!backend.running && !this.isStopped()) {
          this.failed(this.attempt, cause);
          job.reject(new UncertainTaskError(`${backend.label} exited during a task; execution outcome is unknown; task was not replayed: ${cause.message}`));
        } else if (started) {
          job.reject(new UncertainTaskError(`${backend.label} failed after the task started; execution outcome is unknown; task was not replayed: ${cause.message}`));
        } else job.reject(cause);
      } finally { this.active = false; }
    }
    this.cancelWaiting();
    if (!this.queue.length && this.backend && this.kind === 'running') {
      this.idleTimer = setTimeout(() => {
        if (this.queue.length || this.active) return;
        this.closing = this.closeBackend().catch(error => {
          this.closeFailure = error instanceof Error ? error : new Error(String(error));
          this.reason = `idle close failed: ${this.closeFailure.message}`;
        }).finally(() => {
          this.closing = null;
          if (this.kind !== 'stopped') this.kind = 'idle';
          this.wake();
        });
      }, this.options.idleMs);
    }
  }

  private failed(attempt: number, error: Error): void {
    if (this.kind === 'stopped' || this.closing || attempt !== this.attempt || this.failedAttempt === attempt) return;
    this.failedAttempt = attempt; this.failures++; this.reason = error.message;
    this.unsubscribe?.(); this.unsubscribe = null; this.backend = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.failures >= this.options.maxFailures) { this.kind = 'fused'; return; }
    this.wait(retryDelay(this.failures, this.options.initialBackoffMs, this.options.maxBackoffMs), 'process-exit');
  }

  private wait(ms: number, reason: string): void {
    if (this.kind === 'stopped') return;
    this.kind = 'waiting'; this.reason = reason; this.retryAtMs = Date.now() + ms;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null; this.retryAtMs = null;
      if (this.kind !== 'stopped') { this.kind = 'idle'; this.wake(); }
    }, ms);
  }

  private cancelWaiting(): void {
    this.queue = this.queue.filter(job => {
      if (!job.run.shouldStop()) return true;
      job.reject(new Error('code agent task cancelled before execution')); return false;
    });
    if (!this.queue.length && this.cancelTimer) { clearInterval(this.cancelTimer); this.cancelTimer = null; }
  }

  private async closeBackend(): Promise<void> {
    const backend = this.backend;
    this.unsubscribe?.(); this.unsubscribe = null; this.backend = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    await backend?.close();
  }

  private isStopped(): boolean { return this.kind === 'stopped'; }
}
