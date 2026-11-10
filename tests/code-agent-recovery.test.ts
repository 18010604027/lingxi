import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { CliCodeAgentAdapter } from '../core/agents/cli-adapter.ts';
import { TaskBus, UncertainTaskError, type Runner, type Worker } from '../core/agents/bus.ts';

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('code agent durable resume reference', () => {
  let root = '';
  const buses: TaskBus[] = [];

  afterEach(async () => {
    for (const bus of buses.splice(0)) bus.close();
    await pause();
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('reopens the task with the provider session and resumes the same CLI session', async () => {
    root = mkdtempSync(join(tmpdir(), 'code-agent-recovery-'));
    let cliRuns = 0;
    const resumedFrom: Array<{ provider: string; runId: string; sessionId?: string } | undefined> = [];
    const adapter = new CliCodeAgentAdapter({
      id: 'claude', label: 'fixture Claude', command: 'fixture',
      capabilities: { streaming: true, thoughts: true, resume: true, cancel: true, permissions: false,
        usage: true, structuredOutput: true, sandbox: false, networkPolicy: false },
      buildArgs: (task) => {
        resumedFrom.push(task.resume ? { ...task.resume } : undefined);
        return task.resume ? ['--resume', task.resume.sessionId ?? task.resume.runId] : [];
      },
      spawnProcess: () => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true,
        });
        const run = ++cliRuns;
        queueMicrotask(() => {
          child.emit('spawn');
          child.stdout.write(`${JSON.stringify({ type: 'session.started', session_id: 'provider-session-42' })}\n`);
          if (run > 1) child.stdout.write(`${JSON.stringify({ type: 'turn.completed', result: 'resumed original session' })}\n`);
          child.emit('close', run > 1 ? 0 : null);
        });
        return child as never;
      },
    });

    let bus!: TaskBus;
    const runner: Runner = async (task) => {
      bus.bindCodeProvider(task.id, 'claude');
      const result = await adapter.run({
        id: task.id, incidentId: task.incidentId, prompt: task.body, cwd: root,
        writableRoot: root, readRoots: [root], network: 'deny', acceptance: [],
        ...(task.codeRunRef?.sessionId ? { resume: task.codeRunRef } : {}),
      }, {
        shouldStop: () => false,
        onPermission: async () => false,
        onRunRef: (ref) => bus.bindCodeRunRef(task.id, ref),
      });
      if (result.status === 'unknown') throw new UncertainTaskError(result.summary || 'provider outcome unknown');
      if (result.status !== 'succeeded') throw new Error(result.summary || `provider ${result.status}`);
      return result.summary;
    };
    const runners: Record<Worker, Runner> = { control: async () => '', coder: runner };
    bus = new TaskBus(join(root, 'tasks.sqlite'), { runners });
    buses.push(bus);
    bus.start();
    const task = bus.submit({ to: 'coder', from: 'control', body: 'resume-me' });
    await bus.whenIdle();
    expect(bus.get(task.id)).toMatchObject({ status: 'unknown', codeProvider: 'claude',
      codeRunRef: { provider: 'claude', sessionId: 'provider-session-42' } });

    buses.splice(buses.indexOf(bus), 1);
    bus.close();
    await pause();
    bus = new TaskBus(join(root, 'tasks.sqlite'), { runners });
    buses.push(bus);
    bus.start();
    expect(bus.get(task.id)?.status).toBe('unknown');
    expect(bus.recover(task.id, 'resume')).toBe(true);
    await bus.whenIdle();

    expect(resumedFrom).toHaveLength(2);
    expect(resumedFrom[0]).toBeUndefined();
    expect(resumedFrom[1]).toEqual({ provider: 'claude', runId: expect.any(String), sessionId: 'provider-session-42' });
    expect(bus.get(task.id)).toMatchObject({ status: 'done', result: 'resumed original session', codeProvider: 'claude',
      codeRunRef: { provider: 'claude', sessionId: 'provider-session-42' } });
  });
});
