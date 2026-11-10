/**
 * Owns demand, idle shutdown and crash recovery for a DSH ACP backend. Waiting jobs stay in this queue; the task bus
 * owns durable task records. An in-flight crash has an unknown side-effect outcome and is never replayed here.
 */
import type { AcpMcpServer } from './mcp.ts';
import { DshBackend, type DshRunResult, type PermissionAsk } from './dsh.ts';

export const KEEPER_DEFAULTS = {
  idleMs: 5 * 60_000, initialBackoffMs: 750, maxBackoffMs: 30_000,
  maxFailures: 12, stableMs: 3 * 60_000, availabilityPollMs: 30_000,
  startupTimeoutMs: 30_000, cancellationPollMs: 100,
} as const;
export function retryDelay(failures: number, initialMs: number = KEEPER_DEFAULTS.initialBackoffMs, capMs: number = KEEPER_DEFAULTS.maxBackoffMs): number {
  return Math.min(capMs, initialMs * 2 ** Math.max(0, failures - 1));
}
export interface KeeperStatus {
  kind: 'idle' | 'starting' | 'running' | 'waiting' | 'fused' | 'stopped';
  queued: number; active: boolean; failures: number; retryAtMs: number | null; reason: string | null;
}
export interface DshKeeperOptions {
  /** Re-evaluated on demand and while unavailable; null means no installation/backend is currently available. */
  backend: () => DshBackend | null;
  idleMs?: number; initialBackoffMs?: number; maxBackoffMs?: number; maxFailures?: number;
  stableMs?: number; availabilityPollMs?: number; startupTimeoutMs?: number; cancellationPollMs?: number;
}
interface Job {
  text: string; shouldStop: () => boolean; onPermission: (ask: PermissionAsk) => Promise<boolean>;
  resume: string | null; mcpServers: AcpMcpServer[]; onStarted?: (sessionId: string) => void; images?: Uint8Array[]; strictResume?: boolean;
  resolve: (result: DshRunResult) => void; reject: (error: Error) => void;
}

export class DshKeeper {
  private readonly options: Required<DshKeeperOptions>;
  private queue: Job[] = [];
  private backend: DshBackend | null = null;
  /** Whether the running DSH takes pictures in a prompt (false until it started). */
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
  private retryTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private cancelTimer: NodeJS.Timeout | null = null;

  constructor(options: DshKeeperOptions) {
    this.options = { ...KEEPER_DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.options)) if (key !== 'backend' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new RangeError(`Invalid keeper limit: ${key}`);
    if (!Number.isInteger(this.options.maxFailures)) throw new RangeError('maxFailures must be an integer');
  }
  status(): KeeperStatus { return { kind: this.kind, queued: this.queue.length, active: this.active, failures: this.failures, retryAtMs: this.retryAtMs, reason: this.reason }; }

  run(text: string, shouldStop: () => boolean, onPermission: Job['onPermission'], resume: string | null = null, mcpServers: AcpMcpServer[] = [], onStarted?: (sessionId: string) => void, images: Uint8Array[] = [], strictResume = false): Promise<DshRunResult> {
    if (this.kind === 'stopped') return Promise.reject(new Error('DSH keeper stopped'));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const promise = new Promise<DshRunResult>((resolve, reject) => { this.queue.push({ text, shouldStop, onPermission, resume, mcpServers, onStarted, images, strictResume, resolve, reject }); });
    this.cancelTimer ??= setInterval(() => this.cancelWaiting(), this.options.cancellationPollMs);
    this.wake();
    return promise;
  }
  /** Explicit recovery from a fuse; does not replay an earlier in-flight task. */
  reset(): void {
    if (this.kind === 'stopped') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null; this.retryAtMs = null; this.failures = 0; this.reason = null;
    this.kind = this.backend ? 'running' : 'idle'; this.wake();
  }
  async stop(): Promise<void> {
    this.kind = 'stopped';
    for (const timer of [this.retryTimer, this.idleTimer, this.stableTimer]) if (timer) clearTimeout(timer);
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    this.retryTimer = null; this.retryAtMs = null; this.cancelTimer = null;
    for (const job of this.queue.splice(0)) job.reject(new Error('DSH keeper stopped'));
    await this.closeBackend();
    await this.closing;
    await this.pumping;
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
        let backend: DshBackend | null;
        try { backend = this.options.backend(); }
        catch (error) { this.failed(++this.attempt, error instanceof Error ? error : new Error(String(error))); return; }
        if (!backend) { this.wait(this.options.availabilityPollMs, 'not-installed'); return; }
        const attempt = ++this.attempt;
        this.backend = backend; this.kind = 'starting'; this.reason = null;
        this.unsubscribe = backend.onExit(error => this.failed(attempt, error));
        let startupTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([backend.start(), new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('DSH startup timed out')), this.options.startupTimeoutMs); })]);
        } catch (error) {
          this.failed(attempt, error instanceof Error ? error : new Error(String(error)));
          await backend.close(); return;
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
      this.active = true;
      try {
        job.resolve(await backend.run(job.text, () => this.kind === 'stopped' || job.shouldStop(), job.onPermission,
          job.resume, job.mcpServers, job.images ?? [], job.onStarted, undefined, job.strictResume));
      } catch (error) {
        if (!backend.running && !this.isStopped()) {
          this.failed(this.attempt, error instanceof Error ? error : new Error(String(error)));
          job.reject(new Error('DSH exited during a task; execution outcome is unknown; task was not replayed'));
        } else job.reject(error instanceof Error ? error : new Error(String(error)));
      } finally { this.active = false; }
    }
    this.cancelWaiting();
    if (!this.queue.length && this.backend && this.kind === 'running') {
      this.idleTimer = setTimeout(() => {
        if (this.queue.length || this.active) return;
        this.closing = this.closeBackend().finally(() => {
          this.closing = null;
          if (this.kind !== 'stopped') this.kind = 'idle';
          this.wake();
        });
      }, this.options.idleMs);
    }
  }
  private failed(attempt: number, error: Error) {
    if (this.kind === 'stopped' || this.closing || attempt !== this.attempt || this.failedAttempt === attempt) return;
    this.failedAttempt = attempt; this.failures++; this.reason = error.message;
    this.unsubscribe?.(); this.unsubscribe = null; this.backend = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.failures >= this.options.maxFailures) { this.kind = 'fused'; return; }
    this.wait(retryDelay(this.failures, this.options.initialBackoffMs, this.options.maxBackoffMs), 'process-exit');
  }
  private wait(ms: number, reason: string) {
    if (this.kind === 'stopped') return;
    this.kind = 'waiting'; this.reason = reason; this.retryAtMs = Date.now() + ms;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null; this.retryAtMs = null;
      if (this.kind !== 'stopped') { this.kind = 'idle'; this.wake(); }
    }, ms);
  }
  private cancelWaiting() {
    this.queue = this.queue.filter(job => {
      if (!job.shouldStop()) return true;
      job.reject(new Error('DSH task cancelled before execution')); return false;
    });
    if (!this.queue.length && this.cancelTimer) { clearInterval(this.cancelTimer); this.cancelTimer = null; }
  }
  private async closeBackend() {
    const backend = this.backend;
    this.unsubscribe?.(); this.unsubscribe = null; this.backend = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    await backend?.close();
  }
  private isStopped(): boolean { return this.kind === 'stopped'; }
}
