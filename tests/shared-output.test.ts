import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PetWorld } from '../core/pet/world.ts';
import { startApi } from '../core/pet/api.ts';
import { EventMemory, historySince, lineOf } from '../core/memory/events.ts';
import { AppEvents } from '../core/runtime/app-events.ts';

const { call } = createRequire(import.meta.url)('../workbench/bridge.cjs');
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const waitFor = async (check: () => boolean) => {
  for (let n = 0; n < 150; n++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('shared output did not settle');
};
async function fixture(connected = false) {
  const dir = mkdtempSync(join(tmpdir(), 'lingxi-output-'));
  const store = new AppEvents(join(dir, 'events.sqlite'));
  const memory = new EventMemory(dir); memory.attachStore(store);
  let next = 0;
  const commands: unknown[] = [];
  const link = Object.assign(new EventEmitter(), { connected, x: 0.5, send(command: unknown) { commands.push(command); return ++next; } });
  const actions: unknown[] = [];
  const behavior = Object.assign(new EventEmitter(), { keptOut: [], command: async (action: { id: string }) => {
    actions.push(action);
    const receipt = { actionId: 'fixture-action', id: action.id, clip: 'w', playbackId: 1, at: Date.now() };
    behavior.emit('action', { ...receipt, state: 'started' });
    const ended = { id: action.id, outcome: 'done', x: 0.5 };
    behavior.emit('action', { ...receipt, state: 'completed', at: Date.now() });
    behavior.emit('command', ended);
    return ended;
  } });
  const options = { link: link as never, behavior: behavior as never, timezone: 'Asia/Shanghai', userName: () => '朋友', sleep: async () => {},
    figure: { moves: { walk: [], run: [] }, words: { wave: ['w'] }, vocab: { wave: { kind: 'expression', zh: ['挥手'], about: '' } } } as never };
  const host = { store, pushEvent: async (event: object) => store.push({ origin: 'external', ...event } as never) };
  const world = new PetWorld(options);
  await world.start(host as never);
  const invoke = (name: string, args: Record<string, unknown>) => world.tools().find((tool) => tool.name === name)!.handler(args, {} as never);
  return { dir, store, memory, link, actions, commands, options, host, world, invoke,
    async close() { await world.stop(); memory.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('shared output and independent presentation', () => {
  it('renders offline text and asks through the real API; a lost receipt response and a fresh renderer do not duplicate memory or answers', async () => {
    const f = await fixture();
    await f.invoke('pet_say', { script: '身体离线也能收到' });
    await f.invoke('pet_ask', { question: '选什么？', options: ['茶'] });
    expect(f.memory.sync()).toBe(0);
    const access = { port: 0, token: 's'.repeat(48) };
    const server = await startApi(access, {
      status: () => ({ name: '灵犀', paused: false, body: { connected: false, x: 0.5 }, feeling: '' }),
      settings: () => ({ name: '灵犀', user: '朋友' }), asks: () => f.world.pendingAsks(), behind: () => null,
      outputs: (after) => f.world.outputs(after), outputReceipt: (id) => f.world.outputReceipt(id),
      history: () => { const cursor = f.store.latestCursor(); f.memory.sync(); return { available: true, cursor, lines: f.memory.recentLines() }; },
      historySince: (after) => historySince(f.store, after), memory: () => ({ available: true, episodes: [] }),
      tasks: () => null, noteTask: () => false, cancelTask: () => false, recoverTask: () => false,
      say: (text) => f.world.typed(text), answer: (question, text, id) => f.world.answered(question, text, id),
      revoke: () => ({ revoked: false, behind: null }), save: () => ({ name: '灵犀', user: '朋友' }),
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const local = { ...access, port: address.port };
    const windows: Array<InstanceType<typeof JSDOM>> = [];
    const render = (loseResponse: 'before' | 'after' | false) => {
      const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
      windows.push(dom);
      Object.assign(dom.window, { lingxi: { call: async (operation: string, body: unknown) => {
        if (operation === 'outputReceipt' && loseResponse === 'before') throw new Error('closed before receipt committed');
        const result = await call(local, operation, body);
        if (operation === 'outputReceipt' && loseResponse === 'after') throw new Error('response lost after commit');
        return result;
      } } });
      dom.window.eval(readFileSync(join(process.cwd(), 'workbench/renderer.js'), 'utf8'));
      return dom;
    };
    try {
      const unconfirmed = render('before');
      await waitFor(() => unconfirmed.window.document.querySelector('#conversation')?.textContent.includes('身体离线也能收到'));
      expect(f.memory.sync()).toBe(0);
      unconfirmed.window.close();
      const first = render('after');
      await waitFor(() => first.window.document.querySelector('#conversation')?.textContent.includes('身体离线也能收到'));
      await waitFor(() => f.world.outputs().receipts?.filter((receipt) => receipt.channel === 'workbench').length === 2);
      f.memory.sync();
      expect(f.memory.recentLines().map((line) => line.text)).toEqual(['身体离线也能收到', '选什么？ 1. 茶']);
      first.window.close(); // The renderer forgot its acknowledgements after the durable receipt committed.
      const second = render(false);
      await waitFor(() => second.window.document.querySelector('[data-answer]'));
      expect(second.window.document.querySelector('#conversation').textContent.match(/身体离线也能收到/g)).toHaveLength(1);
      const ask = f.world.pendingAsks()[0]!;
      const request = { question: ask.question, text: '茶', questionId: ask.id };
      expect(await Promise.all([call(local, 'answer', request), call(local, 'answer', request)])).toEqual([{ delivered: true }, { delivered: true }]);
      expect(f.store.range({}).filter((event) => event.type === 'pet.answer')).toHaveLength(1);
      f.memory.sync();
      expect(f.memory.recentLines()).toHaveLength(3);
      expect(f.commands).toEqual([]);
      expect(f.actions).toEqual([]);
      const restarted = new PetWorld(f.options);
      await restarted.start(f.host as never);
      expect(restarted.pendingAsks()).toEqual([]);
      expect(await restarted.answered(ask.question, '茶', ask.id)).toBe(true);
      await restarted.stop();
      expect(f.store.range({}).filter((event) => event.type === 'pet.answer')).toHaveLength(1);
    } finally {
      windows.forEach((dom) => dom.window.close());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    }
  });

  it('keeps channel results separate across interruption, disconnect, duplicate receipts, and restart without replaying actions', async () => {
    const f = await fixture(true);
    try {
      await f.invoke('pet_say', { script: '【挥手】第一句' });
      await waitFor(() => f.commands.length === 1);
      const first = f.world.outputs().outputs[0]!;
      f.link.emit('message', { t: 'speech', id: 1, outputId: first.id, state: 'interrupted' });
      f.link.emit('message', { t: 'speech', id: 1, outputId: first.id, state: 'completed' });
      await f.world.outputReceipt(first.id);
      await Promise.all([f.world.outputReceipt(first.id), f.world.outputReceipt(first.id)]);
      await f.invoke('pet_say', { script: '第二句' });
      await waitFor(() => f.commands.length === 2);
      f.link.connected = false;
      f.link.emit('gone');
      f.link.connected = true;
      f.link.emit('message', { t: 'speech', id: 2, outputId: f.world.outputs().outputs[1]!.id, state: 'completed' });
      await f.world.stop();
      const restarted = new PetWorld(f.options);
      await restarted.start(f.host as never);
      const second = restarted.outputs().outputs[1]!;
      await restarted.outputReceipt(second.id);
      await restarted.outputReceipt(first.id);
      expect(restarted.outputs().receipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ outputId: first.id, channel: 'body', state: 'interrupted' }),
        expect.objectContaining({ outputId: second.id, channel: 'body', state: 'unknown' }),
      ]));
      f.memory.sync();
      expect(f.memory.recentLines().map((line) => line.text)).toEqual(['第一句', '第二句']);
      expect(f.actions).toHaveLength(0);
      expect((f.commands[0] as { beats: Array<{ actions?: unknown[] }> }).beats.some((beat) => beat.actions?.length)).toBe(true);
      expect(f.commands).toHaveLength(2);
      await restarted.stop();
    } finally { await f.close(); }
  });

  it('projects one memory line whichever real channel reports presentation first', async () => {
    const f = await fixture(true);
    try {
      await f.invoke('pet_say', { script: '身体先展示' });
      await waitFor(() => f.commands.length === 1);
      const first = f.world.outputs().outputs[0]!;
      f.link.emit('message', { t: 'speech', id: 1, state: 'completed' });
      await f.world.outputReceipt(first.id);
      await f.invoke('pet_say', { script: '工作台先展示' });
      await waitFor(() => f.commands.length === 2);
      const second = f.world.outputs().outputs[1]!;
      await f.world.outputReceipt(second.id);
      f.link.emit('message', { t: 'speech', id: 2, state: 'completed' });
      await f.world.outputReceipt(second.id);
      f.memory.sync();
      expect(f.memory.recentLines().map((line) => line.text)).toEqual(['身体先展示', '工作台先展示']);
      expect(f.store.range({}).filter((event) => event.type === 'pet.output.receipt' && event.meta?.firstPresentation)).toHaveLength(2);
      expect(f.commands).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('records action submission and its actual result with the same id without creating memory', async () => {
    const f = await fixture(true);
    try {
      await f.invoke('pet_act', { actions: ['挥手'] });
      await waitFor(() => f.store.range({}).filter((event) => event.type === 'pet.action').length === 2);
      const actionEvents = f.store.range({}).filter((event) => event.type === 'pet.action');
      expect(actionEvents.map((event) => event.meta?.state)).toEqual(['started', 'completed']);
      expect(actionEvents[0]!.meta?.actionId).toBe(actionEvents[1]!.meta?.actionId);
      expect(actionEvents[0]!.meta?.action).toBe('wave');
      expect(f.actions).toHaveLength(1);
      expect(f.memory.sync()).toBe(0);
    } finally { await f.close(); }
  });

  it('does not dispatch a body action when the shared text cannot be stored', async () => {
    const f = await fixture(true);
    try {
      await f.world.start({ pushEvent: async () => { throw new Error('disk unavailable'); } } as never);
      expect(await f.invoke('pet_say', { script: '【挥手】不能丢的文字' })).toMatchObject({ failed: true, text: expect.stringContaining('nothing was dispatched') });
      expect(f.actions).toEqual([]);
      expect(f.commands).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not dispatch an old script if the body reconnects while its text is being committed', async () => {
    const f = await fixture(true);
    let commit!: () => void;
    try {
      await f.world.start({ store: f.store, pushEvent: (event: object) => new Promise((resolve) => {
        commit = () => resolve(f.store.push({ origin: 'external', ...event } as never));
      }) } as never);
      const pending = f.invoke('pet_say', { script: '【挥手】连接变了' });
      await waitFor(() => !!commit);
      f.link.connected = false; f.link.emit('gone'); f.link.connected = true;
      commit();
      expect(await pending).toMatchObject({ failed: true, text: expect.stringContaining('Text saved') });
      expect(f.actions).toEqual([]);
      expect(f.commands).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not run later anchors or beats after the body interrupts speech', async () => {
    const f = await fixture(true);
    let release!: () => void;
    const world = new PetWorld({ ...f.options, sleep: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await world.start(f.host as never);
      const say = world.tools().find((tool) => tool.name === 'pet_say')!;
      await say.handler({ script: '先说一点<挥手>再继续。【挥手】第二段' }, {} as never);
      await waitFor(() => f.commands.length === 1);
      const reply = f.commands[0] as { replyId: string; beats: Array<{ outputId?: string; hold?: number; actions?: unknown[]; anchors?: unknown[] }> };
      const parts = world.outputs().outputs;
      expect(reply.replyId).toBe(parts[0]!.messageId);
      expect(reply.beats.map((beat) => beat.outputId).filter(Boolean)).toEqual(parts.map((part) => part.id));
      expect(reply.beats.filter((beat) => beat.outputId).map((beat) => beat.hold)).toEqual(parts.map(() => expect.any(Number)));
      expect(reply.beats.some((beat) => beat.anchors?.length)).toBe(true);
      expect(reply.beats.some((beat) => beat.actions?.length)).toBe(true);
      for (const state of ['paused', 'resumed'] as const) {
        for (const part of parts) f.link.emit('message', { t: 'speech', id: 1, outputId: part.id, state });
        await waitFor(() => parts.every((part) => world.outputs().receipts?.some((receipt) => receipt.outputId === part.id && receipt.state === state)));
      }
      f.link.emit('message', { t: 'speech', id: 1, outputId: parts[0]!.id, state: 'interrupted' });
      await waitFor(() => parts.every((part) => world.outputs().receipts?.some((receipt) => receipt.outputId === part.id && receipt.state === 'interrupted')));
      expect(f.actions).toEqual([]);
      expect(f.commands).toHaveLength(1);
      expect(world.outputs().outputs.map((part) => part.text)).toEqual(['先说一点再继续。', '第二段']);
      expect(world.outputs().receipts).toEqual(expect.arrayContaining(parts.map((part) => expect.objectContaining({ outputId: part.id, channel: 'body', state: 'interrupted' }))));
    } finally { await world.stop(); await f.close(); }
  });

  it('marks dispatched speech unknown after host restart, without replaying it or accepting stale completions', async () => {
    const f = await fixture(true);
    try {
      await f.invoke('pet_say', { script: '重启前的文字' });
      await waitFor(() => f.world.outputs().receipts?.some((receipt) => receipt.state === 'dispatched') === true);
      const beforeRestart = f.world.outputs().outputs[0]!;
      f.link.emit('message', { t: 'speech', id: 1, outputId: beforeRestart.id, state: 'paused' });
      await waitFor(() => f.world.outputs().receipts?.some((receipt) => receipt.outputId === beforeRestart.id && receipt.state === 'paused') === true);
      const resumed = new PetWorld(f.options);
      // Simulate process loss: the replacement has no pending command-id map.
      await resumed.start(f.host as never);
      const part = resumed.outputs().outputs[0]!;
      expect(resumed.outputs().receipts).toContainEqual({ outputId: part.id, channel: 'body', state: 'unknown' });
      expect(f.commands).toHaveLength(1);
      await resumed.outputReceipt(part.id);
      expect(f.memory.sync()).toBe(1);
      await resumed.stop();
    } finally { await f.close(); }
  });

  it('retains old speech projections without fabricating a workbench receipt', () => {
    expect(lineOf({ type: 'pet.speech', origin: 'internal', text: '旧身体', ts: 't' })).toMatchObject({ who: 'pet', kind: 'say', text: '旧身体' });
    expect(lineOf({ type: 'desktop-pet.self', origin: 'internal', text: '旧提问', meta: { kind: 'ask' }, ts: 't' })).toMatchObject({ who: 'pet', kind: 'ask', text: '旧提问' });
    expect(lineOf({ type: 'pet.output', origin: 'internal', text: '只生成未展示', ts: 't' })).toBeNull();
  });

  it('reopens durable output in a new run and rebuilds mixed old/new memory once', async () => {
    const f = await fixture();
    let resumed: PetWorld | undefined;
    try {
      f.store.push({ type: 'pet.speech', source: 'pet', origin: 'internal', ts: new Date().toISOString(), text: '旧版身体文字' });
      await f.invoke('pet_say', { script: '新版共享文字' });
      const part = f.world.outputs().outputs[0]!;
      await f.world.outputReceipt(part.id);
      await f.world.stop();
      const reopened = new AppEvents(join(f.dir, 'events.sqlite'));
      resumed = new PetWorld(f.options);
      await resumed.start({ store: reopened, pushEvent: async (event: object) => reopened.push({ origin: 'external', ...event } as never) } as never);
      expect(resumed.outputs().outputs).toMatchObject([{ id: part.id, text: '新版共享文字' }]);
      await resumed.outputReceipt(part.id);
      expect(f.memory.rebuild()).toBe(2);
      expect(f.memory.recentLines().map((line) => line.text)).toEqual(['旧版身体文字', '新版共享文字']);
      expect(reopened.range({}).filter((event) => event.type === 'pet.output.receipt')).toHaveLength(1); reopened.close();
      expect(f.commands).toEqual([]);
    } finally { await resumed?.stop(); await f.close(); }
  });
});
