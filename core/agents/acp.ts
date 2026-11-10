/**
 * A minimal Agent Client Protocol client over a child process's stdio: newline-delimited JSON-RPC 2.0. It sends
 * requests, routes `session/update` notifications to a listener, and answers the agent's requests through a
 * handler (`session/request_permission` is the one DSH sends). Lines on stdout that are not JSON are passed to
 * `onStray` and skipped: a DSH plugin may log there although stdout belongs to the protocol.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface AcpLaunch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface AcpHandlers {
  /** A notification from the agent, `session/update` above all. */
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  /** A request from the agent; the returned value is the result, a throw is the error reply. */
  onRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onStray?: (line: string) => void;
  /** The process ended; pending requests are rejected with the same error. */
  onExit?: (error: Error) => void;
}

export class AcpError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = '';
  private stderr = '';
  private ended: Error | null = null;

  constructor(launch: AcpLaunch, private readonly handlers: AcpHandlers = {}) {
    this.child = spawn(launch.command, launch.args, { env: launch.env, cwd: launch.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.on('error', (error) => this.end(error));
    this.child.on('exit', (code) => this.end(new AcpError(`the agent process exited with code ${code}; stderr: ${this.stderr.slice(-800)}`)));
  }

  get closed(): boolean {
    return this.ended !== null;
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return Promise.reject(new AcpError('ACP stdin is closed'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.ended) this.write({ jsonrpc: '2.0', method, params });
  }

  /** Ends stdin, which DSH takes as the signal to drain and exit, and kills the process if it is still there after `graceMs`. */
  close(graceMs = 5000): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.child.kill(), graceMs);
      timer.unref();
      // `exit` is not emitted when spawn fails; `close` follows both a spawn
      // error and a normal exit after the stdio streams have closed.
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }

  private write(message: Record<string, unknown>): void {
    if (this.ended || this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { this.handlers.onStray?.(line); continue; }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const { id, method } = message;
    if (typeof method === 'string') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (id === undefined) { this.handlers.onNotification?.(method, params); return; }
      const reply = this.handlers.onRequest?.(method, params) ?? Promise.reject(new AcpError(`method not handled: ${method}`, -32601));
      reply.then(
        (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
        (error: unknown) => this.write({ jsonrpc: '2.0', id, error: { code: error instanceof AcpError ? error.code ?? -32603 : -32603, message: String(error instanceof Error ? error.message : error) } }),
      );
      return;
    }
    const pending = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id as number);
    const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (error) pending.reject(new AcpError(error.message ?? 'error', error.code, error.data));
    else pending.resolve(message.result);
  }

  private end(error: Error): void {
    if (this.ended) return;
    this.ended = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.handlers.onExit?.(error);
  }
}
