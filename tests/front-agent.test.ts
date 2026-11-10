import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createFrontAgent } from '../core/runtime/front-agent.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';
import { TaskBus, type Runner } from '../core/agents/bus.ts';
import { runControl } from '../core/runtime/control-runner.ts';
import type { AppEvents } from '../core/runtime/app-events.ts';
import { createLocalFront } from '../core/runtime/local-app.ts';

const log = { warn() {} } as never;
describe('standard front agent', () => {
  it('applies a model update on the next turn while keeping the same conversation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-front-model-update-'));
    let release!: () => void;
    let started!: () => void;
    const busy = new Promise<void>((resolve) => { started = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const first = new ScriptedModel([async () => { started(); await waiting; return new AIMessage('first reply'); }]);
    const next = new ScriptedModel([new AIMessage('second reply')]);
    const front = createFrontAgent({ model: first, tools: [], log: console,
      checkpointPath: join(dir, 'front.sqlite'), readContext: () => ({system:'Lingxi',head:'',tail:''}) });
    try {
      const running = front.turn({sessionId:'front',text:'first input'});
      await busy;
      front.setModel(next);
      release();
      expect((await running).text).toBe('first reply');
      expect(next.requests).toHaveLength(0);
      expect((await front.turn({sessionId:'front',text:'second input'})).text).toBe('second reply');
      expect(JSON.stringify(next.requests[0])).toContain('first input');
      expect(JSON.stringify(next.requests[0])).toContain('first reply');
    } finally { release(); await front.close(); rmSync(dir,{recursive:true,force:true}); }
  });

  it('consumes an internal configuration change once as current-turn context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-front-config-event-'));
    const model = new ScriptedModel([new AIMessage('已知道。'), new AIMessage('继续。')]);
    const front = createLocalFront({ model, tools: [], log, eventFile: join(dir, 'events.sqlite'),
      checkpointPath: join(dir, 'front.sqlite'), sessionId: 'front', context: () => ({ system: 'Lingxi', head: '', tail: '' }) });
    try {
      await front.events.pushEvent({ type: 'app.config.changed', source: 'workbench', origin: 'internal',
        text: '[configuration changed] persona instructions updated', meta: { kind: 'configuration-change', fields: ['persona instructions updated'] } }, { trigger: 'preempt' });
      await front.drain();
      expect(JSON.stringify(model.requests[0])).toContain('persona instructions updated');
      expect(front.events.pending()).toHaveLength(0);
      await front.events.enqueue({ type: 'pet.message', text: '继续聊。' });
      await front.drain();
      expect(JSON.stringify(model.requests[1])).not.toContain('persona instructions updated');
    } finally { await front.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('runs business tools and refreshes transient context without saving it in conversation history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-standard-front-'));
    const output: string[] = [];
    const states: string[] = [];
    let tail = 'now: 2030-01-01T10:00:00Z; pending permission req-1';
    const model = new ScriptedModel([
      new AIMessage({ content: '', tool_calls: [{ id: 'ask-1', name: 'pet_ask', args: { question: '现在允许吗？', requestId: 'req-1' } }] }),
      new AIMessage({ content: '', tool_calls: [{ id: 'end-1', name: 'end_turn', args: {} }] }),
      new AIMessage({ content: '', tool_calls: [{ id: 'allow-1', name: 'answer_permission', args: { requestId: 'req-1' } }] }),
      new AIMessage('继续聊吧。'),
    ]);
    const agent = createFrontAgent({ model, log, checkpointPath: join(dir, 'graph.sqlite'),
      readContext: () => ({ system: 'You are Lingxi.', head: 'Identity: Lingxi', tail }),
      onState: (state) => states.push(state),
      tools: [
        { name: 'pet_ask', description: 'Ask the person.', parameters: { type: 'object', properties: {
          question: { type: 'string' }, requestId: { type: 'string' } }, required: ['question', 'requestId'] }, tags: ['speak'],
          handler: async ({ question, requestId }) => { output.push(`${requestId}:${question}`); tail = 'now: 2030-01-01T10:01:00Z; presented req-1'; return 'Question presented.'; } },
        { name: 'answer_permission', description: 'Resolve the request using the person\'s answer.',
          parameters: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] }, tags: ['write'],
          handler: async ({ requestId }) => { output.push(`answered:${requestId}`); return 'Permission answered.'; } },
      ] });
    try {
      await agent.turn({ sessionId: 'front', text: '[background notice] req-1 needs your judgment.' });
      expect(output).toEqual(['req-1:现在允许吗？']);
      expect(model.requests).toHaveLength(2);
      expect(model.requests[0].at(-1)?.content).toContain('pending permission req-1');
      expect(model.requests[1].at(-1)?.content).toContain('presented req-1');
      await agent.turn({ sessionId: 'front', text: '[pet.answer requestId=req-1] 可以，继续吧。' });
      expect(output).toEqual(['req-1:现在允许吗？', 'answered:req-1']);
      expect(states).toEqual(['processing', 'processing', 'idle', 'processing', 'processing', 'idle']);
      const history = await agent.history('front');
      expect(history.at(-1)?.text).toBe('继续聊吧。');
      expect(history.some((message) => message.text.includes('Identity:') || message.text.includes('now:'))).toBe(false);
    } finally { await agent.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps normal conversation across a close and reopen through the standard checkpointer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-standard-history-'));
    const checkpointPath = join(dir, 'graph.sqlite');
    const readContext = () => ({ system: 'Lingxi', head: '', tail: '' });
    const first = createFrontAgent({ model: new ScriptedModel([new AIMessage('记住了。')]), tools: [], log, checkpointPath, readContext });
    await first.turn({ sessionId: 'front', text: '我叫小鱼。' });
    await first.close();
    const model = new ScriptedModel([new AIMessage('小鱼，你好。')]);
    const second = createFrontAgent({ model, tools: [], log, checkpointPath, readContext });
    try {
      await second.turn({ sessionId: 'front', text: '我叫什么？' });
      expect(model.requests[0].map((message) => message.content)).toContain('我叫小鱼。');
      expect((await second.history('front')).at(-1)?.text).toBe('小鱼，你好。');
    } finally { await second.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads a background result arriving while chatting and leaves a later input for the next turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-standard-task-return-'));
    let events!: AppEvents;
    let local!: ReturnType<typeof createLocalFront>;
    const append = (text: string) => events.enqueue({ text, trigger: 'preempt',
      type: text.startsWith('[background.result') ? 'background.result' : 'pet.chat' });
    const output: string[] = [];
    let release!: () => void;
    const work = new Promise<void>((resolve) => { release = resolve; });
    let settled!: () => void;
    const returned = new Promise<void>((resolve) => { settled = resolve; });
    const background = new ScriptedModel([new AIMessage('三点整理好了。')]);
    const runner: Runner = async (task, control) => {
      await work;
      return (await runControl({ model: background, system: '整理材料。', task: task.body, log,
        tools: [], sessionId: `task-${task.id}`, signal: control.signal })).text;
    };
    const bus = new TaskBus(join(dir, 'tasks.sqlite'), { runners: { control: runner, coder: runner },
      defaultRunnerId: 'framework-v1', alternateRunners: { 'framework-v1': { control: runner } },
      onSettled: (task) => { append(`[background.result ${task.id}] ${task.result}`); settled(); } });
    bus.start();
    let taskId = '';
    const say = (id: string, text: string) => ({ id, name: 'pet_say', args: { text } });
    const end = (id: string) => ({ id, name: 'end_turn', args: {} });
    const model = new ScriptedModel([
      new AIMessage({ content: '', tool_calls: [
        { id: 'delegate-1', name: 'delegate_task', args: { task: '整理成三点' } }, say('say-1', '我交给后台整理。'),
      ] }),
      new AIMessage({ content: '', tool_calls: [end('end-1')] }),
      async () => {
        expect(bus.get(taskId)?.status).toBe('running');
        release();
        await returned;
        return new AIMessage({ content: '', tool_calls: [say('say-2', '猫喜欢暖和的地方。')] });
      },
      (messages) => {
        expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('[background.result'))).toBe(true);
        append('[person] 接着聊。');
        return new AIMessage({ content: '', tool_calls: [say('say-3', '后台已整理成三点。'), end('end-2')] });
      },
      () => {
        expect(events.pending().map((event) => event.cursor)).toEqual([4]);
        return new AIMessage({ content: '', tool_calls: [say('say-4', '好，接着聊。'), end('end-3')] });
      },
    ]);
    let wakeError: unknown;
    let prepared = 0;
    local = createLocalFront({ model, log, checkpointPath: join(dir, 'graph.sqlite'), eventFile: join(dir, 'events.sqlite'), sessionId: 'front',
      context: () => ({ system: 'Lingxi', head: '', tail: 'Current time: 2030-01-01T12:00:00Z' }),
      prepareMessages: (messages) => { prepared++; return messages; },
      onWake: () => { void local.drain().catch((error) => { wakeError = error; }); },
      tools: [
        { name: 'delegate_task', description: 'Give an ordinary task to the background.', tags: ['flow'],
          parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
          handler: async ({ task }) => { taskId = bus.submit({ to: 'control', from: 'front', body: String(task) }).id; return taskId; } },
        { name: 'pet_say', description: 'Speak through the body.', tags: ['speak'],
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          handler: async ({ text }) => { output.push(String(text)); return 'Spoken.'; } },
      ] });
    events = local.events;
    try {
      append('[person] 帮我整理成三点。');
      await local.drain();
      expect(events.pending()).toEqual([]);
      append('[person] 顺便聊聊猫。');
      const draining = local.drain();
      expect(local.drain()).toBe(draining);
      await draining;
      expect(events.pending()).toEqual([]);
      expect(wakeError).toBeUndefined();
      expect(prepared).toBe(5);
      expect(bus.get(taskId)).toMatchObject({ status: 'done', runnerId: 'framework-v1' });
      expect(output).toEqual(['我交给后台整理。', '猫喜欢暖和的地方。', '后台已整理成三点。', '好，接着聊。']);
      const history = await local.history();
      expect(history.filter((message) => message.text.includes('[background.result'))).toHaveLength(1);
    } finally { release(); await bus.closeAsync(); await local.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
