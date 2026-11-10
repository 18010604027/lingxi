import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { FrontInputEvent, FrontEventSource, Logger } from '../core/contracts.ts';
import { Agents, type AgentsOptions } from '../core/agents/roles.ts';
import type { CodeAgentAdapter } from '../core/agents/code-agent.ts';
import { DshBackend } from '../core/agents/dsh.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const call = (name: string, args: Record<string, unknown>) => new AIMessage({ content: '',
  tool_calls: [{ name, args, id: 'call-1' }] });
let dir: string;
let agents: Agents | undefined;
let received: FrontInputEvent[];
let source: FrontEventSource;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lingxi-agents-'));
  received = [];
  source = { log, enqueue: (event) => { received.push(event); return true; } };
});
afterEach(async () => {
  await agents?.closeAsync(); agents = undefined;
  rmSync(dir, { recursive: true, force: true });
});
function open(model: ScriptedModel, options: Partial<AgentsOptions> = {}) {
  agents = new Agents({ dataDir: dir, log, model: () => model, front: () => source,
    fileTools: () => [], frameworkControl: true, ...options });
  return agents;
}
function front(name: string, args: Record<string, unknown>) {
  return agents!.frontTools().find((tool) => tool.name === name)!.handler(args, { role: 'main', log });
}

describe('Agents through the standard model and application event source', () => {
  it('opens a fresh directory and delegates a task with its result and usage', async () => {
    const usages: number[] = [];
    const model = new ScriptedModel([new AIMessage({ content: '资料整理好了。',
      usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } })]);
    const a = open(model, { dataDir: join(dir, 'new'), onUsage: (usage) => usages.push(usage.totalTokens) });
    expect(a.bus.list()).toEqual([]);
    a.start();
    expect(await front('delegate_task', { their_words: '帮我整理资料', as_i_see_it: '整理资料' })).toContain('[delegated]');
    await a.bus.whenIdle();
    expect(a.bus.list()).toEqual([expect.objectContaining({ status: 'done', result: '资料整理好了。', runnerId: 'framework-v1' })]);
    expect(JSON.stringify(model.requests[0])).toContain('帮我整理资料');
    expect(received).toEqual([expect.objectContaining({ type: 'background.result', trigger: 'preempt',
      text: expect.stringContaining('Result: 资料整理好了。') })]);
    expect(a.bus.retryableFrontResults()).toEqual([]);
    expect(usages).toEqual([10]);
  });

  it('shows progress from standard tool calls while background work is running', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const model = new ScriptedModel([
      call('report_progress', { text: '正在整理材料' }),
      async () => { await waiting; return new AIMessage('整理完了。'); },
    ]);
    const a = open(model); a.start();
    await front('delegate_task', { their_words: '整理材料', as_i_see_it: '归类材料' });
    await expect.poll(() => a.behind()).toContain('正在整理材料');
    expect(await front('task_status', {})).toContain('running');
    finish(); await a.bus.whenIdle();
    expect(a.behind()).toBe('');
    expect(received.at(-1)?.text).toContain('整理完了。');
  });

  it('passes stored case pictures to the standard model in evidence order', async () => {
    const model = new ScriptedModel([new AIMessage('看过两张证据了。')]);
    const a = open(model); a.start();
    a.submitCase({ kind: 'fixture', key: 'screens', question: '比较两张图', sections: [], images: [
      { label: 'first', legend: '第一张', jpeg: new Uint8Array([1, 2]) },
      { label: 'second', legend: '第二张', jpeg: new Uint8Array([3, 4]) },
    ] }, { from: 'front' });
    await a.bus.whenIdle();
    const text = JSON.stringify(model.requests[0]);
    expect(text).toContain('AQI='); expect(text).toContain('AwQ=');
    expect(text.indexOf('AQI=')).toBeLessThan(text.indexOf('AwQ='));
    expect(a.bus.list()[0]?.status).toBe('done');
  });

  it('runs code through the configured isolated adapter and returns its actual result', async () => {
    let running = false;
    const adapter: CodeAgentAdapter = {
      id: 'fixture', label: 'fixture', get running() { return running; }, takesImages: false,
      capabilities: { streaming: true, thoughts: false, resume: false, cancel: true, permissions: true,
        usage: false, structuredOutput: true, sandbox: true, networkPolicy: true },
      detect: async () => ({ id: 'fixture', available: true }), start: async () => { running = true; },
      onExit: () => () => {}, close: async () => { running = false; },
      run: async (task, options) => {
        options.onStarted?.({ provider: 'fixture', runId: task.id });
        return { ref: { provider: 'fixture', runId: task.id }, status: 'succeeded', summary: 'script and checks ready', resumed: false };
      },
    };
    const model = new ScriptedModel([]);
    const a = open(model, { codeAgent: adapter }); a.start();
    const task = a.bus.submit({ to: 'coder', from: 'front', body: 'write a script' });
    await a.bus.whenIdle();
    expect(a.bus.get(task.id)).toMatchObject({ status: 'done', codeProvider: 'fixture', result: 'script and checks ready' });
    expect(model.requests).toEqual([]);
    expect(received[0]?.text).toContain('script and checks ready');
  });

  it('creates a simple reminder and leaves engaged wording to the front without another model call', async () => {
    const said: string[] = [];
    let last: number | null = null;
    const model = new ScriptedModel([
      call('wake_create', { title: 'drink water', kind: 'simple', why: 'hourly nudge',
        schedule: { every_minutes: 60 }, lines: ['喝口水吧', '该喝水啦', '水杯空了吗'] }),
      new AIMessage('提醒设好了。'),
    ]);
    const a = open(model, { workspaceDir: dir, say: async (line) => { said.push(line); return true; }, lastInteraction: () => last });
    a.start(); a.bus.submit({ to: 'control', from: 'front', body: 'remind me to drink water' });
    await a.bus.whenIdle();
    expect(await front('wake_list', {})).toContain('drink water');
    const due = () => {
      const reminder = a.reminders.store.list().find((item) => item.kind !== 'rhythm')!;
      reminder.nextAt = new Date(Date.now() - 1000).toISOString(); a.reminders.store.put(reminder);
    };
    due(); await a.reminders.tick();
    expect(said).toHaveLength(1); expect(a.drainQuiet()[0]).toContain(said[0]);
    last = Date.now(); due(); await a.reminders.tick();
    expect(said).toHaveLength(1);
    expect(received.at(-1)).toMatchObject({ type: 'reminder.due', text: expect.stringContaining('The person is with you right now') });
    expect(model.requests).toHaveLength(2);
  });

  it('records the reminder choice and later changed judgment', async () => {
    const model = new ScriptedModel([
      call('wake_create', { title: 'stretch', kind: 'simple', why: 'regular nudge',
        schedule: { every_minutes: 90 }, lines: ['伸个懒腰', '动动肩膀', '站一下吧'] }), new AIMessage('设好了。'),
      () => call('wake_update', { id: agents!.reminders.store.list().find((r) => r.kind !== 'rhythm')!.id,
        kind: 'smart', guide: 'when seated for long', why: 'the person prefers context' }), new AIMessage('调整好了。'),
    ]);
    const a = open(model); a.start();
    a.bus.submit({ to: 'control', from: 'front', body: 'remind me to stretch' }); await a.bus.whenIdle();
    expect(a.judgments.cases('reminder-kind')[0]).toMatchObject({ output: { kind: 'simple' }, latest: null });
    a.bus.submit({ to: 'control', from: 'front', body: 'only when useful' }); await a.bus.whenIdle();
    expect(a.judgments.cases('reminder-kind')[0]?.latest).toMatchObject({ label: { kind: 'smart' }, agrees: false });
  });

  it('keeps daily workarea maintenance out of front summaries and delivery', async () => {
    const a = open(new ScriptedModel([new AIMessage('已记录。')]));
    const record = a.cases.open({ kind: 'workarea', key: 'window#mode-1', question: 'Where may it walk?', sections: [], images: [] });
    a.bus.submit({ to: 'control', from: 'daily', body: a.cases.render(record), label: 'where the pet may walk' });
    expect(a.behind()).toBe('');
    a.start(); await a.bus.whenIdle();
    expect(received).toEqual([]);
  });

  it('takes up notes received during a normal task under the same incident', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const model = new ScriptedModel([
      async () => { await waiting; return new AIMessage('初稿完成。'); }, new AIMessage('已按补充要求调整。'),
    ]);
    const a = open(model); a.start();
    const original = a.bus.submit({ to: 'control', from: 'front', body: '整理本月材料' });
    await expect.poll(() => model.requests.length).toBe(1);
    expect(await front('task_note', { id: original.id, note: '只保留本周的' })).toBe('[noted]');
    finish(); await a.bus.whenIdle();
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).toContain('只保留本周的');
    expect(JSON.stringify(model.requests[1])).toContain('初稿完成。');
    expect(new Set(a.bus.list().map((task) => task.incidentId))).toEqual(new Set([original.incidentId]));
    expect(a.bus.list().find((task) => task.parentId === original.id)).toMatchObject({ status: 'done', result: '已按补充要求调整。' });
  });

  it('relays an external permission to the front and settles the person’s answer once', async () => {
    const dsh = new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
      launch: () => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))] }) });
    const a = open(new ScriptedModel([]), { dsh, frameworkControl: false });
    a.start(); a.bus.submit({ to: 'control', from: 'front', body: 'ASK-PERMISSION before writing notes' });
    await expect.poll(() => received.some((e) => e.type === 'permission.ask')).toBe(true);
    const request = received.find((e) => e.type === 'permission.ask')!;
    expect(request.text).toContain('requestId="' + request.id + '"');
    a.markPermissionQuestion({ id: 'question-1', requestId: request.id });
    expect(a.permissionContext()).toContain('relay=asked');
    expect(await front('answer_permission', { id: request.id, allow: true })).toBe('[allowed this once]');
    await a.bus.whenIdle();
    expect(a.permissionContext()).toBe('');
    expect(received.at(-1)?.text).toContain('permission: yes');
    expect(await front('answer_permission', { id: request.id, allow: true })).toContain('[not waiting]');
  });
});
