import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { deferred } from './async.ts';
import type { OutputDevices, OutputEndpoint } from './types.ts';

/** Read-only default eConsole render endpoint and Core Audio notifications; never changes device configuration. */
export class WindowsOutputDevices implements OutputDevices {
  private child: ChildProcess | null = null;
  private endpoint: OutputEndpoint | null = null;
  private listeners = new Set<() => void>();
  private starting: Promise<void> | null = null;
  private revision: number | undefined;
  lastError: string | null = null;

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    if (process.platform !== 'win32') return Promise.reject(new Error('Core Audio probe requires Windows'));
    const ready = deferred<void>();
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../native/output-endpoints.ps1', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const timer = setTimeout(() => { this.lastError = 'Output endpoint probe timed out'; child.kill(); ready.resolve(); }, 15_000);
    const lines = createInterface({ input: child.stdout! });
    child.stderr!.on('data', (chunk: Buffer) => { this.lastError = (this.lastError ?? '') + chunk.toString().slice(0, 2000); });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line) as { endpoint: OutputEndpoint | null; revision: number };
        if (!Number.isSafeInteger(value.revision) || value.endpoint && (typeof value.endpoint.id !== 'string' || !Number.isInteger(value.endpoint.formFactor) || value.endpoint.revision !== value.revision)) throw new Error('Invalid endpoint snapshot');
        const changed = this.revision !== undefined && this.revision !== value.revision;
        this.endpoint = value.endpoint; this.revision = value.revision;
        if (changed) this.changed();
        clearTimeout(timer); ready.resolve();
      } catch { this.lastError = 'Invalid endpoint probe output'; child.kill(); }
    });
    const unavailable = () => {
      clearTimeout(timer); lines.close(); this.child = null; this.endpoint = null; this.revision = undefined;
      this.changed(); ready.resolve();
    };
    child.once('error', error => { this.lastError = error.message; unavailable(); });
    child.once('exit', unavailable);
    this.starting = ready.promise.finally(() => { this.starting = null; });
    return this.starting;
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
  }
  async current(): Promise<OutputEndpoint | null> { return this.endpoint; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
}
