import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuiltinCodeAgentAdapter } from '../core/agents/builtin-adapter.ts';
import { normalizeCodeAgents } from '../core/agents/code-agent-config.ts';
import { DshAcpAdapter, codeStatusOfDshStopReason } from '../core/agents/dsh-adapter.ts';
import { DshBackend, mxcRunner, overlay } from '../core/agents/dsh.ts';
import { CodeAgentKeeper } from '../core/agents/code-agent-keeper.ts';
import type { CodeAgentAdapter } from '../core/agents/code-agent.ts';
import { ClaudeCodeAdapter, CliCodeAgentAdapter, CodexCliAdapter, codexArgs } from '../core/agents/cli-adapter.ts';
import { CodeAgentRegistry } from '../core/agents/code-agent-registry.ts';
import { AcpConnection } from '../core/agents/acp.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-code-agent.mjs', import.meta.url));
let backends: DshBackend[] = [];
afterEach(async () => { await Promise.all(backends.map((backend) => backend.close())); backends = []; });

function task(prompt: string) {
  return {
    id: 'task-1', incidentId: 'incident-1', prompt, cwd: 'D:/workspace', writableRoot: 'D:/workspace/drafts',
    readRoots: ['D:/workspace'], network: 'deny' as const, acceptance: ['pnpm test'],
  };
}

describe('code agent adapters', () => {
  it('encodes the DSH model route as YAML string data', () => {
    const patch = overlay({ provider: 'route: one', model: 'model\n- id: unexpected' }, 'C:/sessions', 'C:/workspace');
    expect(patch).toContain('provider: "route: one"');
    expect(patch).toContain('model: "model\\n- id: unexpected"');
    expect(patch).not.toContain('\n- id: unexpected');
  });
  it('finishes ACP close when the executable fails to spawn', async () => {
    const conn = new AcpConnection({ command: join(tmpdir(), `missing-acp-${crypto.randomUUID()}`), args: [] });
    let closed = false;
    void conn.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(conn.closed).toBe(true);
  });

  it('rejects an ACP request immediately after stdin is closed', async () => {
    const conn = new AcpConnection({ command: process.execPath, args: [FAKE_CLI, 'WAIT-CANCEL'] });
    const closing = conn.close(10);
    await expect(conn.request('session/new', {})).rejects.toThrow('ACP stdin is closed');
    await closing;
  });
  it('derives DSH isolation declarations from its actual code profile configuration', () => {
    const base = { install: { exe: 'unused', cli: 'unused' }, dataDir: 'D:/data', cwd: 'D:/drafts' };
    expect(new DshAcpAdapter(new DshBackend(base)).capabilities).toMatchObject({ sandbox: false, networkPolicy: false });
    const fenced = { ...base, role: 'code' as const, writableRoot: base.cwd, sandboxMode: 'workspace-write' as const,
      readFence: { only: [base.cwd] }, runner: mxcRunner('deny') };
    expect(new DshAcpAdapter(new DshBackend(fenced)).capabilities).toMatchObject({ sandbox: true, networkPolicy: true });
    expect(new DshAcpAdapter(new DshBackend({ ...fenced, runner: mxcRunner('allow') })).capabilities)
      .toMatchObject({ sandbox: true, networkPolicy: false });
    expect(new DshAcpAdapter(new DshBackend({ ...fenced, readFence: { only: ['D:/other'] } })).capabilities)
      .toMatchObject({ sandbox: false, networkPolicy: false });
  });
  it('rejects a task with paths different from the DSH profile before starting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-workspace-binding-'));
    const backend = new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
      role: 'code', writableRoot: dir, sandboxMode: 'workspace-write', readFence: { only: [dir] }, runner: mxcRunner('deny') });
    const adapter = new DshAcpAdapter(backend);
    const start = vi.spyOn(adapter, 'start');
    const keeper = new CodeAgentKeeper({ backend: () => adapter });
    const opts = { shouldStop: () => false, onPermission: async () => false };
    try {
      adapter.validateTask({ ...task('ok'), cwd: dir, writableRoot: dir, readRoots: [dir] });
      await expect(keeper.run({ ...task('wrong'), cwd: dir, writableRoot: dir, readRoots: [join(dir, 'other')] }, opts))
        .rejects.toThrow('workspace does not match');
      expect(start).not.toHaveBeenCalled();
    } finally { await keeper.stop(); }
  });
  it('places Codex approval policy before exec and treats the prompt as data', () => {
    expect(codexArgs(task('--help'), { command: 'codex' })).toEqual([
      '--ask-for-approval', 'never', '--config', 'sandbox_workspace_write.network_access=false',
      'exec', '--skip-git-repo-check', '--json', '--sandbox', 'workspace-write', '--', '--help',
    ]);
  });

  it('maps Codex sandbox settings to the generated command', () => {
    const taskValue = task('read settings');
    const readonly = codexArgs(taskValue, { command: 'codex', sandboxMode: 'read-only', networkAccess: 'deny' });
    const writable = codexArgs(taskValue, { command: 'codex', sandboxMode: 'workspace-write', networkAccess: 'allow' });
    expect(readonly).toContain('read-only');
    expect(readonly).toContain('sandbox_workspace_write.network_access=false');
    expect(writable).toContain('workspace-write');
    expect(writable).toContain('sandbox_workspace_write.network_access=true');
    expect(new CodexCliAdapter({ command: 'codex', networkAccess: 'allow' }).taskNetworkPolicy).toBe('allow');
    expect(new CodexCliAdapter({ command: 'codex', networkAccess: 'deny' }).taskNetworkPolicy).toBe('deny');
    expect(() => new CodexCliAdapter({ command: 'codex', sandboxMode: 'read-only', networkAccess: 'allow' }))
      .toThrow('does not support enabling workspace network access');
  });
  it('does not turn an unfamiliar ACP stop reason into success', () => {
    expect(codeStatusOfDshStopReason('end_turn')).toBe('succeeded');
    expect(codeStatusOfDshStopReason('cancelled')).toBe('cancelled');
    expect(codeStatusOfDshStopReason('max_tokens')).toBe('failed');
    expect(codeStatusOfDshStopReason('refusal')).toBe('failed');
    expect(codeStatusOfDshStopReason('server_lost')).toBe('unknown');
  });

  it('keeps a disconnect after a session starts as unknown', async () => {
    const backend = { run: async (...args: unknown[]) => { (args[6] as (id: string) => void)('session-1'); throw new Error('connection lost'); } };
    const adapter = new DshAcpAdapter(backend as unknown as DshBackend);
    const result = await adapter.run(task('do work'), { shouldStop: () => false, onPermission: async () => false });
    expect(result).toMatchObject({ status: 'unknown', ref: { sessionId: 'session-1' }, summary: 'connection lost' });
  });
  it('normalizes provider settings without losing built-in defaults', () => {
    const config = normalizeCodeAgents({ preferredExternal: 'dsh', providers: { dsh: { kind: 'dsh-acp', profile: 'custom' } } });
    expect(config.default).toBe('auto');
    expect(config.providers.dsh).toMatchObject({ kind: 'dsh-acp', command: 'DeepSeek Harness.exe', profile: 'custom' });
    expect(config.providers.codex).toMatchObject({ kind: 'codex-cli', command: 'codex' });
  });

  it('does not silently select an installed external CLI in auto mode', () => {
    const builtin = new BuiltinCodeAgentAdapter({ run: async () => ({ ref: { provider: 'builtin', runId: 'x' }, status: 'succeeded', summary: '', resumed: false }) });
    const registry = new CodeAgentRegistry({ builtin });
    expect(registry.select()?.id).toBe('builtin');
    expect(registry.select('codex')).toBeTruthy();
  });

  it('does not select a disabled configured provider, including an injected backend', () => {
    const builtin = new BuiltinCodeAgentAdapter({ run: async () => ({ ref: { provider: 'builtin', runId: 'x' }, status: 'succeeded', summary: '', resumed: false }) });
    const config = normalizeCodeAgents({ default: 'builtin', providers: { builtin: { kind: 'builtin', enabled: false } } });
    const registry = new CodeAgentRegistry({ config, builtin });
    expect(registry.get('builtin')).toBeNull();
    expect(registry.select()).toBeNull();
  });

  it('declares only the configured Codex workspace and network restrictions', () => {
    expect(new CodexCliAdapter({ command: 'codex' }).capabilities).toMatchObject({ sandbox: true, networkPolicy: true });
    expect(new ClaudeCodeAdapter({ command: 'claude' }).capabilities).toMatchObject({ sandbox: false, networkPolicy: false });
  });

  it('does not start a provider without the task isolation capabilities', async () => {
    const adapter = new ClaudeCodeAdapter({ command: 'claude' });
    const start = vi.spyOn(adapter, 'start');
    const run = vi.spyOn(adapter, 'run');
    const keeper = new CodeAgentKeeper({ backend: () => adapter });
    try {
      await expect(keeper.run({ ...task('do work'), metadata: { requireIsolation: true } }, { shouldStop: () => false, onPermission: async () => false }))
        .rejects.toThrow('does not provide a verified sandbox');
      expect(start).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally { await keeper.stop(); }
  });

  it('reports an unconfigured built-in agent instead of pretending it is usable', async () => {
    const adapter = new BuiltinCodeAgentAdapter();
    expect(await adapter.detect()).toMatchObject({ id: 'builtin', available: false });
    await expect(adapter.start()).rejects.toThrow('not configured');
  });

  it('does not infer model authentication from an injected builtin executor', async () => {
    const adapter = new BuiltinCodeAgentAdapter({ run: async () => ({ ref: { provider: 'builtin', runId: 'fixture' }, status: 'succeeded', summary: '', resumed: false }) });
    const availability = await adapter.detect();
    expect(availability.available).toBe(true);
    expect(availability.authenticated).toBeUndefined();
  });

  it('maps DSH ACP sessions, permissions and cancellation to the common contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-agent-'));
    const backend = new DshBackend({
      install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
      launch: () => ({ command: process.execPath, args: [FAKE] }),
    });
    backends.push(backend);
    const adapter = new DshAcpAdapter(backend);
    const started: string[] = [];
    const refs: string[] = [];
    const events: string[] = [];
    const result = await adapter.run(task('ASK-PERMISSION'), {
      shouldStop: () => false,
      onStarted: (ref) => started.push(ref.sessionId ?? ref.runId),
      onRunRef: (ref) => refs.push(ref.sessionId ?? ref.runId),
      onPermission: async (request) => request.title === 'write',
      onEvent: (event) => events.push(event.type),
    });
    expect(result).toMatchObject({ status: 'succeeded', ref: { provider: 'dsh', sessionId: 's1' }, resumed: false });
    expect(started).toEqual(['s1']);
    expect(refs).toEqual(['s1']);
    expect(events).toEqual(expect.arrayContaining(['started', 'text', 'tool', 'permission', 'finished']));
    const resumed = await adapter.run({ ...task('again'), resume: result.ref }, { shouldStop: () => false, onPermission: async () => false });
    expect(resumed).toMatchObject({ ref: { provider: 'dsh', sessionId: 's1' }, resumed: true });
    let stop = false;
    setTimeout(() => { stop = true; }, 300);
    const cancelled = await adapter.run(task('WAIT-CANCEL'), { shouldStop: () => stop, onPermission: async () => false });
    expect(cancelled.status).toBe('cancelled');
  });

  it('keeps an observer failure from crashing the ACP reader or changing the task result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-agent-observer-'));
    const backend = new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
      launch: () => ({ command: process.execPath, args: [FAKE] }) });
    backends.push(backend);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = new DshAcpAdapter(backend);
      const result = await adapter.run(task('observer fixture'), { shouldStop: () => false, onPermission: async () => false,
        onEvent: () => { throw new Error('observer unavailable'); } });
      expect(result).toMatchObject({ status: 'succeeded', summary: 'got: observer fixture' });
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('closes the created DSH session if its host start callback fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-agent-start-callback-'));
    const backend = new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
      launch: () => ({ command: process.execPath, args: [FAKE] }) });
    backends.push(backend);
    const requests = vi.spyOn(AcpConnection.prototype, 'request');
    try {
      const result = await new DshAcpAdapter(backend).run(task('start'), { shouldStop: () => false, onPermission: async () => false,
        onStarted: () => { throw new Error('cannot record start'); } });
      expect(result).toMatchObject({ status: 'unknown', summary: 'cannot record start' });
      expect(requests).toHaveBeenCalledWith('session/close', { sessionId: 's1' });
      expect(requests.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
    } finally { requests.mockRestore(); }
  });

  it('does not prompt DSH when its resume reference cannot be persisted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-agent-run-ref-'));
    const backend = new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
      launch: () => ({ command: process.execPath, args: [FAKE] }) });
    backends.push(backend);
    const requests = vi.spyOn(AcpConnection.prototype, 'request');
    try {
      const result = await new DshAcpAdapter(backend).run(task('must not run'), { shouldStop: () => false, onPermission: async () => false,
        onRunRef: () => { throw new Error('task row unavailable'); } });
      expect(result).toMatchObject({ status: 'unknown', summary: 'task row unavailable' });
      expect(requests).toHaveBeenCalledWith('session/close', { sessionId: 's1' });
      expect(requests.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
    } finally { requests.mockRestore(); }
  });

  it('keeps provider lifecycle and queue policy outside the adapter', async () => {
    let starts = 0;
    let active = false;
    const persistedRefs: string[] = [];
    const adapter: CodeAgentAdapter = {
      id: 'codex', label: 'fake codex', running: false, takesImages: false,
      capabilities: { streaming: true, thoughts: true, resume: false, cancel: true, permissions: true, usage: true, structuredOutput: true, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'codex', available: true }),
      start: async () => { starts++; active = true; },
      onExit: () => () => {},
      run: async (current, options) => {
        options.onRunRef?.({ provider: 'codex', runId: current.id });
        options.onStarted?.({ provider: 'codex', runId: current.id });
        return { ref: { provider: 'codex', runId: current.id }, status: 'succeeded', summary: current.prompt, resumed: false };
      },
      close: async () => { active = false; },
    };
    Object.defineProperty(adapter, 'running', { get: () => active });
    const keeper = new CodeAgentKeeper({ backend: () => adapter, idleMs: 20 });
    const first = keeper.run(task('one'), { shouldStop: () => false, onPermission: async () => false,
      onRunRef: ref => persistedRefs.push(ref.runId) });
    const second = keeper.run(task('two'), { shouldStop: () => false, onPermission: async () => false,
      onRunRef: ref => persistedRefs.push(ref.runId) });
    await expect(first).resolves.toMatchObject({ ref: { provider: 'codex', runId: 'task-1' } });
    await expect(second).resolves.toMatchObject({ ref: { provider: 'codex', runId: 'task-1' } });
    expect(starts).toBe(1);
    expect(persistedRefs).toEqual(['task-1', 'task-1']);
    await keeper.stop();
  });

  it('propagates cancellation through Keeper to an active provider and settles once', async () => {
    let activeTask: string | null = null;
    let stopRequested = false;
    let runs = 0;
    let closes = 0;
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'cancellable fixture', running: true, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: true, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => {}, onExit: () => () => {},
      run: async (current, options) => {
        runs++;
        activeTask = current.id;
        while (!options.shouldStop()) await new Promise(resolve => setTimeout(resolve, 5));
        activeTask = null;
        return { ref: { provider: 'fixture', runId: current.id }, status: 'cancelled', summary: 'cancelled by keeper', resumed: false };
      },
      close: async () => { closes++; },
    };
    const keeper = new CodeAgentKeeper({ backend: () => adapter, idleMs: 10 });
    const pending = keeper.run({ ...task('cancel-me'), preferredAgent: 'fixture' }, { shouldStop: () => stopRequested, onPermission: async () => false });
    await vi.waitFor(() => expect(runs).toBe(1));
    expect(activeTask).toBe('task-1');
    stopRequested = true;
    const result = await pending;
    expect(result).toMatchObject({ status: 'cancelled', summary: 'cancelled by keeper' });
    expect(runs).toBe(1);
    await keeper.stop();
    expect(closes).toBeGreaterThanOrEqual(1);
  });

  it('removes a cancelled queued task without interrupting the active task', async () => {
    let release: (() => void) | undefined;
    let cancelQueued = false;
    const calls: string[] = [];
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'queue fixture', running: true, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => {}, onExit: () => () => {}, close: async () => {},
      run: async current => {
        calls.push(current.id);
        await new Promise<void>(resolve => { release = resolve; });
        return { ref: { provider: 'fixture', runId: current.id }, status: 'succeeded', summary: 'completed', resumed: false };
      },
    };
    const keeper = new CodeAgentKeeper({ backend: () => adapter, cancellationPollMs: 5 });
    try {
      const first = keeper.run({ ...task('first'), id: 'first' }, { shouldStop: () => false, onPermission: async () => false });
      await vi.waitFor(() => expect(calls).toEqual(['first']));
      const second = keeper.run({ ...task('second'), id: 'second' }, { shouldStop: () => cancelQueued, onPermission: async () => false });
      const cancelled = expect(second).rejects.toThrow('cancelled before execution');
      cancelQueued = true;
      await cancelled;
      expect(calls).toEqual(['first']);
      release!();
      await expect(first).resolves.toMatchObject({ status: 'succeeded', summary: 'completed' });
    } finally { release?.(); await keeper.stop(); }
  });

  it('marks an in-flight provider exit uncertain and never replays its task', async () => {
    let alive = true;
    let onExit: ((error: Error) => void) | undefined;
    let attempts = 0;
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'exiting fixture', get running() { return alive; }, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => {},
      onExit: listener => { onExit = listener; return () => { onExit = undefined; }; }, close: async () => {},
      run: async (current, options) => {
        attempts++;
        options.onStarted?.({ provider: 'fixture', runId: current.id });
        alive = false;
        const error = new Error('provider disconnected');
        onExit?.(error);
        throw error;
      },
    };
    const keeper = new CodeAgentKeeper({ backend: () => adapter, initialBackoffMs: 10, maxBackoffMs: 10 });
    try {
      await expect(keeper.run(task('work'), { shouldStop: () => false, onPermission: async () => false }))
        .rejects.toMatchObject({ uncertain: true, message: expect.stringContaining('task was not replayed') });
      expect(attempts).toBe(1);
    } finally { await keeper.stop(); }
  });

  it('records idle close failure and reports it on orderly shutdown', async () => {
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'closing fixture', running: true, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => {}, onExit: () => () => {},
      run: async current => ({ ref: { provider: 'fixture', runId: current.id }, status: 'succeeded', summary: 'completed', resumed: false }),
      close: async () => { throw new Error('close fixture failed'); },
    };
    const keeper = new CodeAgentKeeper({ backend: () => adapter, idleMs: 5 });
    await expect(keeper.run(task('finish'), { shouldStop: () => false, onPermission: async () => false })).resolves.toMatchObject({ status: 'succeeded' });
    await vi.waitFor(() => expect(keeper.status().reason).toContain('close fixture failed'));
    await expect(keeper.stop()).rejects.toThrow('could not close cleanly');
  });

  it('retains a startup close failure without leaving a rejected pump unhandled', async () => {
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'startup fixture', running: false, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => { throw new Error('startup failed'); },
      onExit: () => () => {}, run: async () => { throw new Error('must not run'); },
      close: async () => { throw new Error('startup cleanup failed'); },
    };
    const keeper = new CodeAgentKeeper({ backend: () => adapter, maxFailures: 1 });
    const run = keeper.run(task('work'), { shouldStop: () => false, onPermission: async () => false });
    const outcome = expect(run).rejects.toThrow('keeper stopped');
    await vi.waitFor(() => expect(keeper.status().reason).toContain('startup cleanup failed'));
    await expect(keeper.stop()).rejects.toThrow('could not close cleanly');
    await outcome;
  });

  it('waits for the active task to settle even when shutdown close fails', async () => {
    let release: (() => void) | undefined;
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'closing fixture', running: true, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => {}, onExit: () => () => {},
      run: async current => {
        await new Promise<void>(resolve => { release = resolve; });
        return { ref: { provider: 'fixture', runId: current.id }, status: 'succeeded', summary: '', resumed: false };
      },
      close: async () => { throw new Error('close fixture failed'); },
    };
    const keeper = new CodeAgentKeeper({ backend: () => adapter });
    const run = keeper.run(task('work'), { shouldStop: () => false, onPermission: async () => false });
    await vi.waitFor(() => expect(release).toBeDefined());
    let settled = false;
    const stopping = keeper.stop().finally(() => { settled = true; });
    const outcome = expect(stopping).rejects.toThrow('could not close cleanly');
    await Promise.resolve();
    expect(settled).toBe(false);
    release!();
    await expect(run).resolves.toMatchObject({ status: 'succeeded' });
    await outcome;
  });

  it('shares one shutdown across concurrent stop callers', async () => {
    let finishClose: (() => void) | undefined;
    const close = vi.fn(() => new Promise<void>(resolve => { finishClose = resolve; }));
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'closing fixture', running: true, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => {}, onExit: () => () => {}, close,
      run: async current => ({ ref: { provider: 'fixture', runId: current.id }, status: 'succeeded', summary: '', resumed: false }),
    };
    const keeper = new CodeAgentKeeper({ backend: () => adapter });
    await keeper.run(task('work'), { shouldStop: () => false, onPermission: async () => false });
    const first = keeper.stop();
    const second = keeper.stop();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(finishClose).toBeDefined());
    expect(close).toHaveBeenCalledOnce();
    finishClose!();
    await Promise.all([first, second]);
  });

  it('rejects a task whose chosen or resumed provider differs from the available backend', async () => {
    let starts = 0;
    let runs = 0;
    const backend: CodeAgentAdapter = {
      id: 'dsh', label: 'fixture', running: true, takesImages: false,
      capabilities: { streaming: false, thoughts: false, resume: true, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'dsh', available: true }), start: async () => { starts++; }, onExit: () => () => {}, close: async () => {},
      run: async (current) => { runs++; return { ref: { provider: 'dsh', runId: current.id }, status: 'succeeded', summary: '', resumed: false }; },
    };
    const keeper = new CodeAgentKeeper({ backend: () => backend });
    const opts = { shouldStop: () => false, onPermission: async () => false };
    try {
      await expect(keeper.run({ ...task('chosen'), preferredAgent: 'codex' }, opts)).rejects.toThrow('code agent mismatch');
      await expect(keeper.run({ ...task('resume'), resume: { provider: 'codex', runId: 'old' } }, opts)).rejects.toThrow('code agent mismatch');
      expect(starts).toBe(0);
      expect(runs).toBe(0);
      await expect(keeper.run({ ...task('valid'), preferredAgent: 'dsh' }, opts)).resolves.toMatchObject({ status: 'succeeded' });
      expect(starts).toBe(1);
      expect(runs).toBe(1);
    } finally { await keeper.stop(); }
  });

  it('parses a machine-readable CLI stream and cancels the process without parsing terminal decoration', async () => {
    const adapter = new CliCodeAgentAdapter({
      id: 'fake-cli', label: 'fake CLI', command: process.execPath, prefixArgs: [FAKE_CLI],
      detect: async () => true, buildArgs: (current) => [current.prompt],
      capabilities: { streaming: true, thoughts: true, resume: false, cancel: true, permissions: false, usage: true, structuredOutput: true, sandbox: true, networkPolicy: true },
    });
    const events: string[] = [];
    const result = await adapter.run({ ...task('hello'), cwd: process.cwd() }, {
      shouldStop: () => false, onPermission: async () => false,
      onEvent: (event) => events.push(event.type),
    });
    expect(result).toMatchObject({ status: 'succeeded', summary: 'finished hello' });
    expect(events).toEqual(expect.arrayContaining(['started', 'text', 'tool', 'usage', 'finished']));
    let stop = false;
    setTimeout(() => { stop = true; }, 100);
    const cancelled = await adapter.run({ ...task('WAIT-CANCEL'), cwd: process.cwd() }, { shouldStop: () => stop, onPermission: async () => false });
    expect(cancelled).toMatchObject({ status: 'unknown', stopReason: 'cancellation_unconfirmed' });
  });

  it('waits for output streams to close after exit and preserves split UTF-8', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const adapter = new CliCodeAgentAdapter({
      id: 'fake-cli', label: 'fake CLI', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never,
      capabilities: { streaming: true, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: true, sandbox: false, networkPolicy: false },
    });
    const pending = adapter.run(task('hello'), { shouldStop: () => false, onPermission: async () => false });
    const bytes = Buffer.from(JSON.stringify({ type: 'result', result: '完成' }) + '\n');
    const split = bytes.indexOf(Buffer.from('完')) + 1;
    child.emit('exit', 0);
    child.stdout.write(bytes.subarray(0, split));
    child.stdout.write(bytes.subarray(split));
    child.emit('close', 0);
    expect(await pending).toMatchObject({ status: 'succeeded', summary: '完成' });
  });

  it('does not finish closing an active CLI until its process and streams close', async () => {
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill });
    const adapter = new CliCodeAgentAdapter({
      id: 'fake-cli', label: 'fake CLI', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never,
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: false, networkPolicy: false },
    });
    const run = adapter.run(task('work'), { shouldStop: () => false, onPermission: async () => false });
    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(kill).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    expect(adapter.running).toBe(true);
    child.emit('close', null);
    await closing;
    await run;
    expect(adapter.running).toBe(false);
  });

  it('preserves a successful terminal result that races with a stop request', async () => {
    const kill = vi.fn(() => false);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill });
    const adapter = new CliCodeAgentAdapter({ id: 'fixture', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new CodexCliAdapter().capabilities });
    let stop = false;
    const pending = adapter.run(task('finish'), { shouldStop: () => stop, onPermission: async () => false });
    child.emit('spawn');
    stop = true;
    await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'finished before stop' }) + '\n');
    child.emit('close', 0);
    expect(await pending).toMatchObject({ status: 'succeeded', summary: 'finished before stop' });
  });

  it('keeps a stopped CLI unknown when process termination is not confirmed', async () => {
    const kill = vi.fn(() => false);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill });
    const adapter = new CliCodeAgentAdapter({ id: 'fixture', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new CodexCliAdapter().capabilities });
    let stop = false;
    const pending = adapter.run(task('stop'), { shouldStop: () => stop, onPermission: async () => false });
    child.emit('spawn');
    stop = true;
    await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
    child.emit('close', null);
    expect(await pending).toMatchObject({ status: 'unknown', stopReason: 'cancellation_unconfirmed' });
  });

  it('does not treat a crashed CLI without a machine failure result as a confirmed task failure', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const adapter = new CliCodeAgentAdapter({ id: 'fixture', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new CodexCliAdapter().capabilities });
    const pending = adapter.run(task('crash'), { shouldStop: () => false, onPermission: async () => false });
    child.emit('spawn');
    child.stderr.write('process failed after starting');
    child.emit('close', 1);
    expect(await pending).toMatchObject({ status: 'unknown', exitCode: 1, summary: 'process failed after starting' });
  });

  it('keeps a start callback failure from escaping the child spawn event', async () => {
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill });
    const adapter = new CliCodeAgentAdapter({ id: 'fixture', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new CodexCliAdapter().capabilities });
    const pending = adapter.run(task('work'), { shouldStop: () => false, onPermission: async () => false,
      onStarted: () => { throw new Error('start record unavailable'); } });
    expect(() => child.emit('spawn')).not.toThrow();
    expect(kill).toHaveBeenCalledOnce();
    child.emit('close', null);
    expect(await pending).toMatchObject({ status: 'unknown', stopReason: 'start_callback_failed', summary: expect.stringContaining('start record unavailable') });
  });

  it('does not spawn a task that was cancelled before execution', async () => {
    let spawned = false;
    const adapter = new CliCodeAgentAdapter({
      id: 'fake-cli', label: 'fake CLI', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => { spawned = true; throw new Error('must not start'); },
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: false, networkPolicy: false },
    });
    expect(await adapter.run(task('cancelled'), { shouldStop: () => true, onPermission: async () => false })).toMatchObject({ status: 'cancelled' });
    expect(spawned).toBe(false);
  });

  it('serializes asynchronous CLI resolution and cancels it on close before spawning', async () => {
    const adapter = new CliCodeAgentAdapter({ id: 'fixture', label: 'fixture', command: process.execPath, prefixArgs: [FAKE_CLI],
      buildArgs: current => [current.prompt], capabilities: new CodexCliAdapter().capabilities });
    const options = { shouldStop: () => false, onPermission: async () => false };
    const first = adapter.run({ ...task('must-not-start'), cwd: process.cwd() }, options);
    const second = adapter.run({ ...task('second'), cwd: process.cwd() }, options);
    const closing = adapter.close();
    await expect(second).rejects.toThrow('already running');
    await closing;
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    expect(adapter.running).toBe(false);
  });

  it('reports a missing executable as failed before announcing task start', async () => {
    const adapter = new CliCodeAgentAdapter({
      id: 'fake-cli', label: 'missing CLI', command: join(tmpdir(), `missing-lingxi-cli-${crypto.randomUUID()}`), buildArgs: () => [],
      capabilities: { streaming: false, thoughts: false, resume: false, cancel: true, permissions: false, usage: false, structuredOutput: false, sandbox: false, networkPolicy: false },
    });
    const started = vi.fn();
    const result = await adapter.run({ ...task('test'), cwd: process.cwd() }, { shouldStop: () => false, onPermission: async () => false, onStarted: started });
    expect(result).toMatchObject({ status: 'failed', stopReason: 'spawn_failed' });
    expect(started).not.toHaveBeenCalled();
  });

  it('reads official Codex item events, thread ids and cached usage from JSONL', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const events: unknown[] = [];
    const refs: Array<{ provider: string; runId: string; sessionId?: string }> = [];
    const adapter = new CliCodeAgentAdapter({ id: 'codex', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => { expect(refs).toHaveLength(1); return child as never; }, capabilities: new CodexCliAdapter().capabilities });
    const pending = adapter.run(task('controlled'), { shouldStop: () => false, onPermission: async () => false, onEvent: event => events.push(event), onRunRef: ref => refs.push({ ...ref }) });
    child.stdout.write([
      { type: 'thread.started', thread_id: 'official-session' },
      { type: 'item.started', item: { type: 'command_execution', id: 'cmd', command: 'read fixture', status: 'in_progress' } },
      { type: 'item.completed', item: { type: 'command_execution', id: 'cmd', command: 'read fixture', aggregated_output: 'fixture', exit_code: 0 } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'controlled result' } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 8 } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    child.emit('close', 0);
    expect(await pending).toMatchObject({ status: 'succeeded', summary: 'controlled result', ref: { provider: 'codex', sessionId: 'official-session' } });
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ provider: 'codex', runId: expect.any(String) });
    expect(refs[1]).toMatchObject({ ...refs[0], sessionId: 'official-session' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', phase: 'finished', id: 'cmd', output: 'fixture' }),
      expect.objectContaining({ type: 'usage', cachedTokens: 8 }),
    ]));
    expect(child.stdin.writableEnded).toBe(true);
  });

  it('publishes only lifecycle enums and exact registered tool names to safe activity hooks', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const adapter = new CliCodeAgentAdapter({ id: 'claude', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new ClaudeCodeAdapter().capabilities });
    const activities: unknown[] = [];
    const pending = adapter.run({ ...task('secret prompt'), attempt: 2, activityTools: ['pet_act'], cwd: process.cwd() },
      { shouldStop: () => false, onPermission: async () => false, onActivity: activity => activities.push(activity) });
    child.emit('spawn');
    child.stdout.write([
      { type: 'assistant_message', text: 'private assistant content' },
      { type: 'thought', text: 'private reasoning' },
      { type: 'mcp_tool_call', id: 'call-1', tool: 'pet_act', arguments: { token: 'fake-secret', text: 'private tool arguments' } },
      { type: 'result', result: 'private final answer' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    child.emit('close', 0);
    expect(await pending).toMatchObject({ status: 'succeeded' });
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 2, role: 'coder', kind: 'state', state: 'started' }),
      expect.objectContaining({ attempt: 2, role: 'coder', kind: 'tool', state: 'started', toolName: 'pet_act', callId: 'call-1' }),
      expect.objectContaining({ attempt: 2, role: 'coder', kind: 'state', state: 'succeeded' }),
    ]));
    expect(JSON.stringify(activities)).not.toContain('private');
    expect(JSON.stringify(activities)).not.toContain('fake-secret');
  });

  it('does not change a successful CLI result when activity persistence throws', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const adapter = new CliCodeAgentAdapter({ id: 'claude', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new ClaudeCodeAdapter().capabilities });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = adapter.run({ ...task('safe'), attempt: 1, cwd: process.cwd() }, { shouldStop: () => false,
      onPermission: async () => false, onActivity: () => { throw new Error('sqlite unavailable'); } });
    child.emit('spawn');
    child.stdout.write(`${JSON.stringify({ type: 'result', result: 'success' })}\n`);
    child.emit('close', 0);
    try {
      expect(await pending).toMatchObject({ status: 'succeeded', summary: 'success' });
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('reports unknown and stops when an updated CLI resume reference cannot be persisted', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) });
    const adapter = new CliCodeAgentAdapter({ id: 'codex', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new CodexCliAdapter().capabilities });
    const refs: Array<{ sessionId?: string }> = [];
    const pending = adapter.run(task('controlled'), { shouldStop: () => false, onPermission: async () => false,
      onRunRef: ref => { refs.push({ sessionId: ref.sessionId }); if (ref.sessionId) throw new Error('task row unavailable'); } });
    child.emit('spawn');
    child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'started-session' })}\n`);
    child.emit('close', 0);
    expect(await pending).toMatchObject({ status: 'unknown', stopReason: 'run_ref_persist_failed' });
    expect(refs).toEqual([{ sessionId: undefined }, { sessionId: 'started-session' }]);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('preserves the provider session id when preparing a resumed CLI run', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    let resumeArg = '';
    const persisted: Array<{ provider: string; runId: string; sessionId?: string }> = [];
    const adapter = new CliCodeAgentAdapter({ id: 'claude', label: 'fixture', command: 'fixture',
      buildArgs: current => { resumeArg = current.resume?.sessionId ?? ''; return []; }, spawnProcess: () => child as never,
      capabilities: new ClaudeCodeAdapter().capabilities });
    const pending = adapter.run({ ...task('resume'), resume: { provider: 'claude', runId: 'local-run', sessionId: 'provider-session' } },
      { shouldStop: () => false, onPermission: async () => false, onRunRef: ref => persisted.push({ ...ref }) });
    expect(resumeArg).toBe('provider-session');
    expect(persisted).toEqual([{ provider: 'claude', runId: 'local-run', sessionId: 'provider-session' }]);
    child.emit('spawn');
    child.emit('close', 0);
    expect(await pending).toMatchObject({ ref: { provider: 'claude', runId: 'local-run', sessionId: 'provider-session' }, resumed: true });
  });

  it('keeps a resumed CLI task unknown if the provider returns a different session', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) });
    const adapter = new CliCodeAgentAdapter({ id: 'claude', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new ClaudeCodeAdapter().capabilities });
    const updates: string[] = [];
    const pending = adapter.run({ ...task('resume'), resume: { provider: 'claude', runId: 'run-7', sessionId: 'original-session' } },
      { shouldStop: () => false, onPermission: async () => false, onRunRef: ref => updates.push(ref.sessionId ?? '') });
    child.emit('spawn');
    child.stdout.write(`${JSON.stringify({ type: 'session.started', session_id: 'different-session' })}\n`);
    child.emit('close', 0);
    expect(await pending).toMatchObject({ status: 'unknown', stopReason: 'resume_ref_mismatch',
      ref: { provider: 'claude', runId: 'run-7', sessionId: 'original-session' } });
    expect(updates).toEqual(['original-session']);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each([
    [{ type: 'turn.failed', error: { message: 'provider unavailable' } }, 'failed'],
    [{ type: 'result', is_error: true, result: 'denied' }, 'failed'],
    [{ type: 'result', subtype: 'error_during_execution', result: 'failed' }, 'failed'],
    [{ type: 'assistant', text: 'partial answer' }, 'unknown'],
  ])('does not treat an exit zero without successful machine completion as success', async (line, status) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const adapter = new CliCodeAgentAdapter({ id: 'fixture', label: 'fixture', command: 'fixture', buildArgs: () => [],
      spawnProcess: () => child as never, capabilities: new CodexCliAdapter().capabilities });
    const pending = adapter.run(task('controlled'), { shouldStop: () => false, onPermission: async () => false });
    child.stdout.write(JSON.stringify(line) + '\n');
    child.emit('close', 0);
    expect(await pending).toMatchObject({ status });
  });

  it('does not silently turn a failed DSH resume into a fresh provider-neutral run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-agent-strict-resume-'));
    const backend = new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
      launch: () => ({ command: process.execPath, args: [FAKE] }) });
    backends.push(backend);
    const adapter = new DshAcpAdapter(backend);
    const onStarted = vi.fn();
    const result = await adapter.run({ ...task('resume'), resume: { provider: 'dsh', runId: 'missing-session' } },
      { shouldStop: () => false, onPermission: async () => false, onStarted });
    expect(result).toMatchObject({ status: 'failed', resumed: false, summary: expect.stringContaining('could not resume session') });
    expect(onStarted).not.toHaveBeenCalled();
  });
});
