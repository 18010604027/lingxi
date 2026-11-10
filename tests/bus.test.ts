import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskBus, UncertainTaskError, type RunControl, type Runner, type Task, type Worker } from '../core/agents/bus.ts';
import { Ledger } from '../core/ledger/ledger.ts';
import { openDb } from '../core/sqlite.ts';
import { emitCodeAgentActivity } from '../core/agents/code-agent.ts';

/** A runner whose tasks finish only when the test says so, polling `shouldStop` like a fork between tool calls. */
class Gate {
  readonly started: string[] = [];
  private readonly open = new Map<string, (result: string) => void>();
  private readonly controls = new Map<string, RunControl>();

  readonly run: Runner = (task: Task, control: RunControl) => {
    this.started.push(task.body);
    this.controls.set(task.body, control);
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (control.shouldStop()) { clearInterval(poll); resolve(`stopped ${task.body}`); }
      }, 5);
      this.open.set(task.body, (r) => { clearInterval(poll); resolve(r); });
    });
  };

  finish(body: string, result = `did ${body}`): void { this.open.get(body)?.(result); }
  control(body: string): RunControl | undefined { return this.controls.get(body); }
}

const tick = () => new Promise((r) => setTimeout(r, 30));

let dir: string;
let buses: TaskBus[];
let ledgers: Ledger[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bus-')); buses = []; ledgers = []; });
afterEach(async () => {
  for (const b of buses) b.close();
  for (const l of ledgers) l.close();
  await tick();
  // a bus keeps its file open while a task still runs, and some tests leave one running on purpose
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left in the temp directory */ }
});

function make(runners: Partial<Record<Worker, Runner>>, opts: { limits?: Partial<Record<Worker, number>>; settled?: Task[] } = {}) {
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), { flushMs: 60_000 });
  const fail: Runner = () => Promise.reject(new Error('no runner'));
  const bus = new TaskBus(join(dir, 'bus.sqlite'), {
    runners: { control: runners.control ?? fail, coder: runners.coder ?? fail },
    limits: opts.limits, ledger, onSettled: (t) => opts.settled?.push(t),
  });
  bus.start();
  buses.push(bus);
  ledgers.push(ledger);
  return { bus, ledger };
}

describe('TaskBus', () => {
  it('persists distinct activity once and detects a cursor beyond a reopened source', () => {
    const { bus } = make({});
    const candidate = { taskId: 'task', attempt: 1, provider: 'dsh', runId: 'run', role: 'coder', kind: 'state', state: 'started', idempotencyKey: 'state:started' } as const;
    const first = bus.appendCodeAgentActivity(candidate);
    expect(bus.appendCodeAgentActivity(candidate)).toEqual({ ...first, inserted: false });
    const second = bus.appendCodeAgentActivity({ ...candidate, taskId: 'other' });
    expect(second.sequence).toBeGreaterThan(first.sequence);
    bus.close();
    const reopened = new TaskBus(join(dir, 'bus.sqlite'), { runners: { control: async () => '', coder: async () => '' } });
    buses.push(reopened);
    expect(reopened.listCodeAgentActivity(first.sequence, 1)).toMatchObject({ items: [{ task_id: 'other' }], sequence: second.sequence, coverage: 'partial', hasMore: false });
    expect(reopened.listCodeAgentActivity(second.sequence + 1)).toMatchObject({ reset: true, coverage: 'partial' });
  });
  it('rejects malformed activity candidates without writing a row', () => {
    const { bus } = make({});
    const valid = { taskId: 'task', attempt: 1, provider: 'dsh', runId: 'run', role: 'coder', kind: 'state', state: 'started', idempotencyKey: 'state:started' } as const;
    expect(() => bus.appendCodeAgentActivity({ ...valid, state: 'private payload' } as never)).toThrow('invalid code agent activity');
    expect(bus.listCodeAgentActivity()).toMatchObject({ items: [], sequence: 0, hasMore: false });
    expect(bus.appendCodeAgentActivity(valid)).toMatchObject({ sequence: 1, inserted: true });
  });
  it('keeps the task result when activity persistence fails', async () => {
    const { bus } = make({ coder: async (task) => {
      emitCodeAgentActivity({ shouldStop: () => false, onPermission: async () => false,
        onActivity: (activity) => { bus.appendCodeAgentActivity(activity); } }, {
        taskId: task.id, attempt: task.attempts, provider: 'dsh', runId: 'run', role: 'coder', kind: 'state', state: 'succeeded', idempotencyKey: 'state:finished',
      });
      return 'provider result';
    } });
    const faultDb = openDb(join(dir, 'bus.sqlite'));
    faultDb.exec(`CREATE TRIGGER reject_code_agent_activity BEFORE INSERT ON code_agent_activity
      BEGIN SELECT RAISE(FAIL, 'temporary SQLite write error'); END`);
    const task = bus.submit({ to: 'coder', from: 'control', body: 'work' });
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'done', result: 'provider result' });
    expect(bus.listCodeAgentActivity()).toMatchObject({ items: [], sequence: 0 });
    faultDb.close();
  });
  it('retains a provider-confirmed success when cancellation races completion', async () => {
    let finish!: (value: { kind: 'confirmed-success'; result: string }) => void;
    const settled: Task[] = [];
    const { bus } = make({ coder: () => new Promise((resolve) => { finish = resolve; }) }, { settled });
    const task = bus.submit({ to: 'coder', from: 'control', body: 'work' });
    await expect.poll(() => bus.get(task.id)?.status).toBe('running');
    expect(bus.cancel(task.id)).toBe(true);
    finish({ kind: 'confirmed-success', result: 'provider completed' });
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'done', result: 'provider completed' });
    expect(settled).toEqual([expect.objectContaining({ id: task.id, status: 'done' })]);
  });
  it('persists adapter run references and requires a session before explicit code resume', async () => {
    let bus!: TaskBus;
    const { ledger } = make({ coder: async (task) => {
      bus.bindCodeRunRef(task.id, { provider: 'codex', runId: 'local-run' });
      throw new UncertainTaskError('interrupted');
    } });
    bus = buses[0]!;
    const task = bus.submit({ to: 'coder', from: 'control', body: 'work' });
    await bus.whenIdle();
    expect(bus.get(task.id)?.codeRunRef).toEqual({ provider: 'codex', runId: 'local-run' });
    expect(() => bus.recover(task.id, 'resume')).toThrow(/no resumable session reference/);
    expect(bus.get(task.id)?.status).toBe('unknown');
    const db = (bus as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare("UPDATE task SET status = 'running' WHERE id = ?").run(task.id);
    bus.bindCodeRunRef(task.id, { provider: 'codex', runId: 'local-run', sessionId: 'provider-session' });
    db.prepare("UPDATE task SET status = 'unknown' WHERE id = ?").run(task.id);
    expect(bus.get(task.id)?.codeRunRef).toEqual({ provider: 'codex', runId: 'local-run', sessionId: 'provider-session' });
    buses.splice(buses.indexOf(bus), 1);
    bus.close();
    await tick();
    let resumedRef: Task['codeRunRef'] | undefined;
    const reopened = new TaskBus(join(dir, 'bus.sqlite'), { runners: {
      control: async () => '', coder: async (resumed) => { resumedRef = resumed.codeRunRef; throw new UncertainTaskError('test stop'); },
    } });
    buses.push(reopened);
    reopened.start();
    expect(reopened.recover(task.id, 'resume')).toBe(true);
    await reopened.whenIdle();
    expect(resumedRef).toEqual({ provider: 'codex', runId: 'local-run', sessionId: 'provider-session' });
  });
  it('returns and schedules a committed task when dispatch audit fails', async () => {
    const { bus, ledger } = make({ control: async () => 'done' });
    const original = ledger.append.bind(ledger);
    const append = vi.spyOn(ledger, 'append').mockImplementation((entry) => {
      if (entry.op === 'dispatch') throw new Error('audit unavailable');
      return original(entry);
    });
    const task = bus.submit({ to: 'control', from: 'front', body: 'work' });
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'done', result: 'done' });
    expect(bus.list()).toHaveLength(1);
    append.mockRestore();
  });
  it('settles a task and delivers its receipt when start audit fails', async () => {
    const { bus, ledger } = make({ control: async () => 'done' });
    const original = ledger.append.bind(ledger);
    const append = vi.spyOn(ledger, 'append').mockImplementation((entry) => {
      if (entry.summary.includes('task started')) throw new Error('audit unavailable');
      return original(entry);
    });
    const task = bus.submit({ to: 'control', from: 'front', body: 'work' });
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'done', result: 'done' });
    expect(append).toHaveBeenCalled();
    append.mockRestore();
  });
  it('delivers a committed result even when settlement audit fails', async () => {
    const settled: Task[] = [];
    const { bus, ledger } = make({ control: async () => 'done' }, { settled });
    const original = ledger.append.bind(ledger);
    const append = vi.spyOn(ledger, 'append').mockImplementation((entry) => {
      if (entry.summary === 'task done') throw new Error('audit unavailable');
      return original(entry);
    });
    const task = bus.submit({ to: 'control', from: 'front', body: 'work' });
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'done', result: 'done' });
    expect(settled).toMatchObject([{ id: task.id, status: 'done', result: 'done' }]);
    expect(bus.retryableFrontResults().map((item) => item.id)).toContain(task.id);
    append.mockRestore();
  });
  it('does not make a recovered task look unrecovered when its audit append fails', async () => {
    const gate = new Gate();
    const { bus, ledger } = make({ control: gate.run });
    const task = bus.submit({ to: 'control', from: 'front', body: 'interrupted' });
    await tick();
    bus.cancel(task.id);
    await bus.whenIdle();
    const original = ledger.append.bind(ledger);
    const append = vi.spyOn(ledger, 'append').mockImplementation((entry) => {
      if (entry.summary === 'unknown task explicitly resumed') throw new Error('audit unavailable');
      return original(entry);
    });
    // Force the durable state used by the recovery endpoint.
    (bus as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db.prepare("UPDATE task SET status = 'unknown' WHERE id = ?").run(task.id);
    expect(bus.recover(task.id, 'resume')).toBe(true);
    expect(bus.get(task.id)?.status).toBe('running');
    gate.finish('interrupted');
    await bus.whenIdle();
    expect(bus.get(task.id)?.status).toBe('done');
    append.mockRestore();
  });
  it('marks unanswered permission requests interrupted on restart and rejects late answers', () => {
    const { bus } = make({});
    bus.recordPermission('perm-test', 'task-test');
    expect(bus.permissionState('perm-test')).toEqual({ taskId: 'task-test', state: 'pending' });
    expect(bus.pendingPermissions()).toEqual([expect.objectContaining({ id: 'perm-test', taskId: 'task-test', state: 'pending' })]);
    buses.splice(buses.indexOf(bus), 1);
    bus.close();
    const reopened = new TaskBus(join(dir, 'bus.sqlite'), { runners: { control: async () => '', coder: async () => '' } });
    buses.push(reopened);
    expect(reopened.permissionState('perm-test')).toEqual({ taskId: 'task-test', state: 'interrupted' });
    expect(reopened.pendingPermissions()).toEqual([]);
    expect(reopened.finishPermission('perm-test', 'allowed')).toBe(false);
    expect(reopened.permissionState('perm-test')?.state).toBe('interrupted');
  });
  it('returns from submit before the task runs and pushes the result when it settles', async () => {
    const gate = new Gate();
    const settled: Task[] = [];
    const { bus } = make({ control: gate.run }, { settled });
    const task = bus.submit({ to: 'control', from: 'front', body: 'a' });
    expect(task.status).toBe('queued');
    await tick();
    expect(bus.get(task.id)?.status).toBe('running');
    gate.finish('a');
    await bus.whenIdle();
    expect(settled.map((t) => [t.body, t.status, t.result])).toEqual([['a', 'done', 'did a']]);
  });

  it('waits for running work before closing its database', async () => {
    const gate = new Gate();
    const { bus } = make({ control: gate.run });
    bus.submit({ to: 'control', from: 'front', body: 'close-me' });
    await tick();
    const closing = bus.closeAsync();
    let done = false; void closing.then(() => { done = true; });
    await tick();
    expect(done).toBe(false);
    gate.finish('close-me');
    await closing;
    expect(done).toBe(true);
  });

  it('keeps a task runner id when the bus database is reopened', async () => {
    const first = make({ control: async () => 'ok' });
    const task = first.bus.submit({ to: 'control', from: 'front', body: 'framework candidate', runnerId: 'framework-v1' });
    await first.bus.whenIdle();
    expect(first.bus.get(task.id)?.runnerId).toBe('framework-v1');
    buses.splice(buses.indexOf(first.bus), 1);
    first.bus.close();
    const ledger = new Ledger(join(dir, 'ledger-reopened.sqlite'), { flushMs: 60_000 });
    const reopened = new TaskBus(join(dir, 'bus.sqlite'), { runners: { control: async () => 'ok', coder: async () => 'no' }, ledger });
    buses.push(reopened); ledgers.push(ledger);
    expect(reopened.get(task.id)?.runnerId).toBe('framework-v1');
  });

  it('selects the persisted alternate runner without changing legacy tasks', async () => {
    const seen: string[] = [];
    const { bus } = make({ control: async (task) => { seen.push(`legacy:${task.body}`); return 'legacy'; } });
    const framework = async (task: Task) => { seen.push(`framework:${task.body}`); return 'framework'; };
    (bus as unknown as { alternateRunners: Record<string, unknown> }).alternateRunners['framework-v1'] = { control: framework };
    const task = bus.submit({ to: 'control', from: 'front', body: 'new', runnerId: 'framework-v1' });
    const old = bus.submit({ to: 'control', from: 'front', body: 'old' });
    await bus.whenIdle();
    expect(bus.get(task.id)?.result).toBe('framework');
    expect(bus.get(old.id)?.result).toBe('legacy');
    expect(seen).toEqual(['framework:new', 'legacy:old']);
  });

  it('does not silently run a persisted task on a different runner', async () => {
    const seen: string[] = [];
    const { bus } = make({ control: async (task) => { seen.push(task.body); return 'legacy'; } });
    const task = bus.submit({ to: 'control', from: 'front', body: 'framework task', runnerId: 'framework-v1' });
    await bus.whenIdle();
    expect(seen).toEqual([]);
    expect(bus.get(task.id)?.status).toBe('failed');
    expect(bus.get(task.id)?.result).toBe('runner unavailable: framework-v1');
  });

  it('keeps an earlier unknown outcome when its recorded runner is unavailable during recovery', async () => {
    const { bus } = make({ control: async () => 'legacy' });
    const paths = (bus as unknown as { alternateRunners: Record<string, unknown> }).alternateRunners;
    paths['framework-v1'] = { control: async () => { throw new UncertainTaskError('previous side effect unknown'); } };
    const task = bus.submit({ to: 'control', from: 'front', body: 'work', runnerId: 'framework-v1' });
    await bus.whenIdle();
    expect(bus.get(task.id)?.status).toBe('unknown');
    delete paths['framework-v1'];
    expect(bus.recover(task.id, 'resume')).toBe(true);
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'unknown', result: expect.stringContaining('runner unavailable: framework-v1') });
    expect(bus.get(task.id)?.result).toContain('previous side effect unknown');
  });
  it('keeps the unknown outcome visible when the owner declines a replay', async () => {
    const settled: Task[] = [];
    const { bus } = make({ coder: async () => { throw new UncertainTaskError('connection lost after file write'); } }, { settled });
    const task = bus.submit({ to: 'coder', from: 'control', body: 'work' });
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'unknown', result: 'connection lost after file write' });
    expect(bus.recover(task.id, 'cancel')).toBe(true);
    expect(bus.get(task.id)).toMatchObject({ status: 'cancelled', result: expect.stringContaining('connection lost after file write') });
    expect(settled.at(-1)?.result).toContain('Previous outcome remains unknown');
    expect(bus.pendingCodeResults().map((item) => item.id)).toContain(task.id);
  });

  it('can choose defaults per worker', async () => {
    const ledger = new Ledger(join(dir, 'ledger-worker-defaults.sqlite'), { flushMs: 60_000 });
    const bus = new TaskBus(join(dir, 'worker-defaults.sqlite'), {
      runners: { control: async () => 'control', coder: async () => 'coder' }, ledger,
      alternateRunners: { 'framework-v1': { control: async () => 'framework' } },
      defaultRunnerIds: { control: 'framework-v1' },
    });
    buses.push(bus); ledgers.push(ledger); bus.start();
    const control = bus.submit({ to: 'control', from: 'front', body: 'control' });
    const coder = bus.submit({ to: 'coder', from: 'front', body: 'coder' });
    expect(bus.get(control.id)?.runnerId).toBe('framework-v1');
    expect(bus.get(coder.id)?.runnerId).toBe('legacy-v1');
  });


  it('runs each role up to its limit and queues the rest', async () => {
    const gate = new Gate();
    const { bus } = make({ coder: gate.run }, { limits: { coder: 2 } });
    for (const body of ['a', 'b', 'c']) bus.submit({ to: 'coder', from: 'control', body });
    await tick();
    expect(gate.started).toEqual(['a', 'b']);
    gate.finish('a');
    await tick();
    expect(gate.started).toEqual(['a', 'b', 'c']);
  });

  it('takes urgent tasks before normal ones already queued', async () => {
    const gate = new Gate();
    const { bus } = make({ control: gate.run });
    bus.submit({ to: 'control', from: 'front', body: 'running' });
    await tick();
    bus.submit({ to: 'control', from: 'front', body: 'normal' });
    gate.finish('running');
    bus.submit({ to: 'control', from: 'front', body: 'urgent', priority: 'urgent' });
    await tick();
    expect(gate.started).toEqual(['running', 'urgent']);
  });

  it('marks a preempted task unknown instead of replaying possible side effects', async () => {
    const gate = new Gate();
    const { bus, ledger } = make({ control: gate.run });
    const normal = bus.submit({ to: 'control', from: 'front', body: 'normal' });
    await tick();
    bus.submit({ to: 'control', from: 'front', body: 'urgent', priority: 'urgent' });
    expect(gate.control('normal')?.signal.aborted).toBe(true);
    await tick();
    expect(gate.started).toEqual(['normal', 'urgent']);
    expect(bus.get(normal.id)?.status).toBe('unknown');
    gate.finish('urgent');
    await tick();
    expect(gate.started).toEqual(['normal', 'urgent']);
    expect(bus.get(normal.id)?.attempts).toBe(1);
    expect(ledger.byIncident(normal.incidentId).entries.map((e) => e.summary))
      .toEqual(['task for control: normal', 'task started', 'task interrupted for an urgent one']);
  });

  it('keeps a preempted runner rejection for review without settling or replaying it', async () => {
    const started: string[] = [];
    const settled: Task[] = [];
    const runner: Runner = (task, control) => {
      started.push(task.body);
      if (task.priority === 'urgent') return Promise.resolve('urgent done');
      return new Promise((_resolve, reject) => control.signal.addEventListener('abort', () => reject(new Error('interrupted after action'))));
    };
    const { bus } = make({ control: runner }, { settled });
    const normal = bus.submit({ to: 'control', from: 'front', body: 'normal' });
    await tick();
    bus.submit({ to: 'control', from: 'front', body: 'urgent', priority: 'urgent' });
    await bus.whenIdle();
    expect(started).toEqual(['normal', 'urgent']);
    expect(bus.get(normal.id)).toMatchObject({ status: 'unknown', result: 'interrupted after action', attempts: 1 });
    expect(settled.map((task) => task.body)).toEqual(['urgent']);
  });

  it('cancels a queued task at once and a running one at its next check', async () => {
    const gate = new Gate();
    const settled: Task[] = [];
    const { bus } = make({ control: gate.run }, { settled });
    const running = bus.submit({ to: 'control', from: 'front', body: 'running' });
    const queued = bus.submit({ to: 'control', from: 'front', body: 'queued' });
    await tick();
    expect(bus.cancel(queued.id)).toBe(true);
    expect(bus.cancel(running.id)).toBe(true);
    expect(gate.control('running')?.signal.aborted).toBe(true);
    expect(bus.get(running.id)?.status).toBe('running');
    await bus.whenIdle();
    expect(settled.map((t) => [t.body, t.status])).toEqual([['queued', 'cancelled'], ['running', 'cancelled']]);
    expect(gate.started).toEqual(['running']);
    expect(bus.cancel(running.id)).toBe(false);
  });

  it('does not claim cancellation succeeded when the runner reports an unknown outcome', async () => {
    const settled: Task[] = [];
    const runner: Runner = (_task, control) => new Promise((_resolve, reject) => {
      control.signal.addEventListener('abort', () => reject(new UncertainTaskError('connection lost during cancellation')));
    });
    const { bus } = make({ coder: runner }, { settled });
    const task = bus.submit({ to: 'coder', from: 'front', body: 'cancel safely' });
    await tick();
    expect(bus.cancel(task.id)).toBe(true);
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'unknown', result: 'connection lost during cancellation' });
    expect(settled).toEqual([]);
  });

  it('only stores tasks until started', async () => {
    const gate = new Gate();
    const ledger = new Ledger(join(dir, 'ledger.sqlite'), { flushMs: 60_000 });
    const bus = new TaskBus(join(dir, 'bus.sqlite'), { runners: { control: gate.run, coder: gate.run }, ledger });
    buses.push(bus);
    ledgers.push(ledger);
    bus.submit({ to: 'control', from: 'front', body: 'early' });
    await tick();
    expect(gate.started).toEqual([]);
    bus.start();
    await tick();
    expect(gate.started).toEqual(['early']);
  });

  it('records a runner failure as a failed task', async () => {
    const settled: Task[] = [];
    const { bus } = make({ coder: async () => { throw new Error('tests did not pass'); } }, { settled });
    bus.submit({ to: 'coder', from: 'control', body: 'x' });
    await bus.whenIdle();
    expect(settled.map((t) => [t.status, t.result])).toEqual([['failed', 'tests did not pass']]);
  });

  it('keeps a settled front result visible as unconfirmed across restart', async () => {
    const first = make({ control: async () => 'done' });
    const task = first.bus.submit({ to: 'control', from: 'front', body: 'tell the front' });
    await first.bus.whenIdle();
    expect(first.bus.unconfirmedFrontResults().map((item) => item.id)).toEqual([task.id]);
    first.bus.close(); buses.splice(buses.indexOf(first.bus), 1);
    const ledger = new Ledger(join(dir, 'ledger-front-reopened.sqlite'), { flushMs: 60_000 });
    const reopened = new TaskBus(join(dir, 'bus.sqlite'), { runners: { control: async () => 'unused', coder: async () => 'unused' }, ledger });
    buses.push(reopened); ledgers.push(ledger);
    expect(reopened.unconfirmedFrontResults().map((item) => item.id)).toEqual([task.id]);
  });

  it('does not automatically retry a pre-existing unconfirmed result without an idempotent receipt', async () => {
    const first = make({ control: async () => 'old result' });
    const task = first.bus.submit({ to: 'control', from: 'front', body: 'older task' });
    await first.bus.whenIdle();
    first.bus.close(); buses.splice(buses.indexOf(first.bus), 1);
    const db = openDb(join(dir, 'bus.sqlite'));
    db.prepare('UPDATE front_result_delivery SET retryable = 0 WHERE task_id = ?').run(task.id);
    db.close();
    const ledger = new Ledger(join(dir, 'ledger-old-result.sqlite'), { flushMs: 60_000 });
    const reopened = new TaskBus(join(dir, 'bus.sqlite'), { runners: { control: async () => 'unused', coder: async () => 'unused' }, ledger });
    buses.push(reopened); ledgers.push(ledger);
    expect(reopened.unconfirmedFrontResults().map((item) => item.id)).toEqual([task.id]);
    expect(reopened.retryableFrontResults()).toEqual([]);
    reopened.ackFrontResult(task.id);
    expect(reopened.unconfirmedFrontResults()).toHaveLength(1);
  });

  it('creates one durable control follow-up for a settled code task after a restart', async () => {
    const first = make({ control: async () => 'control', coder: async () => 'code result' });
    const code = first.bus.submit({ to: 'coder', from: 'control', body: 'write the change' });
    await first.bus.whenIdle();
    expect(first.bus.pendingCodeResults()).toHaveLength(1);
    first.bus.close(); buses.splice(buses.indexOf(first.bus), 1);
    const followups: string[] = [];
    const ledger = new Ledger(join(dir, 'ledger-followup.sqlite'), { flushMs: 60_000 });
    const reopened = new TaskBus(join(dir, 'bus.sqlite'), {
      runners: { control: async (task) => { followups.push(task.body); return 'ack'; }, coder: async () => 'unexpected' }, ledger,
      onSettled: (task) => { if (task.to === 'coder' && task.from === 'control') reopened.deliverCodeResult(task); },
    });
    buses.push(reopened); ledgers.push(ledger); reopened.start();
    await reopened.whenIdle();
    expect(followups).toHaveLength(1);
    expect(reopened.pendingCodeResults()).toEqual([]);
    expect(reopened.list().filter((task) => task.parentId === code.id)).toHaveLength(1);
    const settledCode = reopened.get(code.id)!;
    const firstId = reopened.deliverCodeResult(settledCode);
    expect(reopened.deliverCodeResult(settledCode)).toBe(firstId);
    expect(reopened.list().filter((task) => task.parentId === code.id)).toHaveLength(1);
  });

  it('hands notes added through update to the running task', async () => {
    const gate = new Gate();
    const { bus } = make({ control: gate.run });
    const task = bus.submit({ to: 'control', from: 'front', body: 'a' });
    await tick();
    expect(bus.update(task.id, 'the user means the 9am alarm')).toBe(true);
    expect(gate.control('a')?.notes()).toEqual(['the user means the 9am alarm']);
  });

  it('acknowledges a durable note when the audit append fails', () => {
    const { bus, ledger } = make({ control: async () => 'done' });
    const task = bus.submit({ to: 'control', from: 'front', body: 'a' });
    const append = vi.spyOn(ledger, 'append').mockImplementation(() => { throw new Error('audit unavailable'); });
    expect(bus.update(task.id, 'same note')).toBe(true);
    expect(bus.get(task.id)?.notes).toEqual(['same note']);
    expect(append).toHaveBeenCalledTimes(1);
    append.mockRestore();
  });

  it('marks an interrupted task unknown and only resumes it explicitly', async () => {
    const first = make({ control: () => new Promise(() => {}) });
    const task = first.bus.submit({ to: 'control', from: 'front', body: 'interrupted' });
    await tick();
    expect(first.bus.get(task.id)?.status).toBe('running');
    // a crash: the old instance never settles its task and is not closed
    buses.length = 0;
    const gate = new Gate();
    const { bus } = make({ control: gate.run });
    await tick();
    expect(gate.started).toEqual([]);
    expect(bus.get(task.id)?.status).toBe('unknown');
    expect(bus.recover(task.id, 'resume')).toBe(true);
    await tick();
    expect(gate.started).toEqual(['interrupted']);
    expect(bus.get(task.id)?.attempts).toBe(2);
  });
});
