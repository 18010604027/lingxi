import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Command, CommandEnd } from '../core/behavior/behavior.ts';
import type { Figure } from '../core/behavior/plan.ts';
import { createWill } from '../core/behavior/will.ts';
import { PetWorld } from '../core/pet/world.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppEvents } from '../core/runtime/app-events.ts';
import { EventMemory, lineOf } from '../core/memory/events.ts';

const figure: Figure = {
  name: '灵犀', source: 't', refWidth: 462, bodyWidth: 462, nativeFacing: 'left', idle: ['idle'], held: ['held'], noMirror: [],
  moves: { walk: [], run: [] },
  words: { wave: ['w'], jump: ['j'] },
  vocab: { walk: { kind: 'motion', zh: ['走'], about: '' }, run: { kind: 'motion', zh: ['跑'], about: '' }, wave: { kind: 'expression', zh: ['挥手'], about: '' }, jump: { kind: 'motion', zh: ['跳'], about: '' } },
};

function setup(onQuestion?: (question: import('../core/pet/world.ts').Ask) => void) {
  const link = Object.assign(new EventEmitter(), { connected: true, x: 0.5, said: [] as string[], sent: [] as Array<{ text: string; replyId?: string; beats?: unknown[] }>, send(c: { text: string; replyId?: string; beats?: unknown[] }) { this.sent.push(c); this.said.push(c.text); return 1; } });
  const behavior = Object.assign(new EventEmitter(), {
    keptOut: [[0.4, 0.6]] as Array<[number, number]>,
    done: [] as Command[],
    async command(c: Command): Promise<CommandEnd> { this.done.push(c); return { id: c.id, outcome: 'done', x: 0.5 }; },
    async enqueue(commands: Command[]): Promise<CommandEnd[]> { return Promise.all(commands.map((c) => this.command(c))); },
  });
  const events: Array<{ type: string; text: string; trigger?: string; meta?: Record<string, unknown> }> = [];
  const world = new PetWorld({
    link: link as never, behavior: behavior as never, figure, timezone: 'Asia/Shanghai', userName: () => '小王',
    daily: (() => {
      let interactionPolicy: Record<string, unknown> = { voice: 'quiet' };
      return { will: { describe: () => 'rested' }, feel: () => {}, get interactionPolicy() { return interactionPolicy; },
        setInteractionPolicy(next: Record<string, unknown>) { interactionPolicy = { ...interactionPolicy, ...next }; return interactionPolicy; } };
    })() as never,
    sleep: async () => {},
    ...(onQuestion ? { onQuestion } : {}),
  });
  void world.start({ pushEvent: async (e: { type: string; text: string; meta?: Record<string, unknown> }, o?: { trigger?: string }) => { events.push({ type: e.type, text: e.text, trigger: o?.trigger, meta: e.meta }); return e; } } as never);
  const tool = (name: string) => world.tools().find((t) => t.name === name)!;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tool(name).handler(args, {} as never);
    return typeof r === 'string' ? { text: r, failed: false } : r;
  };
  return { link, behavior, events, world, call };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('the pet World on the new body', () => {
  it('projects the same drive state as model text and a Chinese UI summary', async () => {
    const will = createWill();
    will.drives.boredom = .8;
    const { link, behavior } = setup();
    const world = new PetWorld({ link, behavior: behavior as never, figure, timezone: 'UTC', userName: () => '朋友', daily: { will } as never });
    expect(world.state()).toMatchObject({ feeling: will.describe(), feelingState: {
      codes: ['rested', 'restless'], text: 'rested; restless', summary: '精力充足；有点无聊，想活动',
    } });
    await world.stop();
  });
  it('keeps a permission request id on the shared question and answer event', async () => {
    const linked: Array<{ requestId?: string; id: string }> = [];
    const { world, call, events } = setup((q) => linked.push(q));
    await call('pet_ask', { question: '要继续吗？', options: ['继续', '停下'], requestId: 'perm-test' });
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ requestId: 'perm-test' });
    expect(world.pendingAsks()[0]).toMatchObject({ requestId: 'perm-test', options: ['继续', '停下'] });
    await Promise.all([world.answered('要继续吗？', '继续', linked[0]!.id), world.answered('要继续吗？', '继续', linked[0]!.id)]);
    expect(events.filter((event) => event.type === 'pet.answer')).toHaveLength(1);
    expect(events.find((event) => event.type === 'pet.answer')?.meta).toMatchObject({ questionId: linked[0]!.id, requestId: 'perm-test', text: '继续' });
    await world.stop();
  });

  it('archives speech only after its matching body receipt and only once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-speech-'));
    const store = new AppEvents(join(dir, 'events.sqlite'));
    const memory = new EventMemory(dir); memory.attachStore(store);
    const { world, link, call } = setup();
    const options: unknown[] = [];
    await world.start({ pushEvent: async (event: Record<string, unknown>, opts: unknown) => {
      options.push(opts);
      return store.push(event as never);
    } } as never);
    await call('pet_say', { script: '你好呀' });
    await settle();
    expect(memory.sync()).toBe(0);
    link.emit('message', { t: 'speech', id: 99, state: 'completed' });
    link.emit('message', { t: 'speech', id: 1, state: 'completed' });
    link.emit('message', { t: 'speech', id: 1, state: 'completed' });
    await settle();
    expect(options).toHaveLength(3);
    expect(options.every((option) => (option as { deliver: boolean }).deliver === false)).toBe(true);
    expect(memory.sync()).toBe(1);
    expect(memory.recentLines()).toMatchObject([{ who: 'pet', kind: 'say', text: '你好呀' }]);
    expect(memory.sync()).toBe(0);
    await world.stop();
    memory.close(); store.close();
  });
  it('does not archive interrupted speech or a late completion after disconnect', async () => {
    const { world, link, call } = setup();
    const events: unknown[] = [];
    await world.start({ pushEvent: async (event: unknown) => { events.push(event); return event; } } as never);
    await call('pet_say', { script: '第一句' });
    await settle();
    link.emit('message', { t: 'speech', id: 1, state: 'interrupted' });
    link.emit('message', { t: 'speech', id: 1, state: 'completed' });
    await call('pet_say', { script: '第二句' });
    await settle();
    link.emit('gone');
    link.emit('message', { t: 'speech', id: 1, state: 'completed' });
    await settle();
    expect(events.flatMap((event) => lineOf(event as Record<string, unknown>) ?? [])).toEqual([]);
    await world.stop();
  });
  it('projects real world input and touch events through the event log into memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-events-'));
    const store = new AppEvents(join(dir, 'events.sqlite'));
    const memory = new EventMemory(dir); memory.attachStore(store);
    const { world, link } = setup();
    const delivered: Record<string, unknown>[] = [];
    await world.start({ pushEvent: async (event: Record<string, unknown>) => {
      const saved = store.push({ ...event, origin: 'external' } as never);
      delivered.push(saved as unknown as Record<string, unknown>);
      return saved;
    } } as never);
    await world.typed('周末想去猫咖');
    await world.answered('喝什么', '茶');
    link.emit('message', { t: 'drop', x: 0.7, vx: 900, vy: 0 });
    link.emit('message', { t: 'landed', x: 0.8 });
    await settle();
    expect(delivered.map((e) => lineOf(e)?.kind)).toEqual(['said', 'answered', 'touch']);
    expect(delivered[0]!.text).toContain('[how you feel]');
    expect(memory.sync()).toBe(3);
    expect(memory.search('猫咖')[0]!.lines.map((line) => line.text)).toEqual([
      '周末想去猫咖', '喝什么 → 茶', expect.stringContaining('拎起来甩了出去'),
    ]);
    expect(memory.search('喝什么')[0]!.lines.some((line) => line.text === '喝什么 → 茶')).toBe(true);
    expect(memory.sync()).toBe(0);
    await world.stop();
    memory.close(); store.close();
  });
  it('has the front body tools', () => {
    expect(setup().world.tools().map((t) => t.name).sort()).toEqual(['pet_act', 'pet_ask', 'pet_interaction', 'pet_say', 'pet_where']);
  });

  it('says a script in bubbles and hands its markers to the behaviour system', async () => {
    const { link, behavior, world, events, call } = setup();
    const r = await call('pet_say', { script: '【挥手】你好呀!<跳>今天也加油。【咕噜】' });
    expect(r.failed).toBeFalsy();
    expect(r.text).toContain('咕噜');
    await settle();
    expect(link.said).toEqual(['你好呀!']);
    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]!.replyId).toBeTruthy();
    expect(link.sent[0]!.beats).toEqual([
      expect.objectContaining({ text: '你好呀!', actions: ['wave'] }),
      expect.objectContaining({ text: '今天也加油。', actions: ['jump'] }),
    ]);
    expect(behavior.done).toEqual([]);
    const outputIds = (link.sent[0]!.beats as Array<{ outputId: string }>).map((beat) => beat.outputId);
    link.emit('message', { t: 'speech', id: 1, outputId: outputIds[0], state: 'completed' });
    await settle();
    expect(events.filter((event) => event.type === 'pet.output.receipt').map((event) => event.meta)).toContainEqual(expect.objectContaining({ channel: 'body', outputId: outputIds[0], state: 'completed' }));
    expect(await world.typed('这期间我也能输入')).toBe(true);
    link.emit('message', { t: 'speech', id: 1, outputId: outputIds[1], state: 'completed' });
    await settle();
    expect(events.filter((event) => event.type === 'pet.output.receipt').map((event) => event.meta)).toContainEqual(expect.objectContaining({ channel: 'body', outputId: outputIds[1], state: 'completed' }));
  });

  it('acts without speaking, with where to and how long', async () => {
    const { behavior, call } = setup();
    const r = await call('pet_act', { actions: ['走 30%', '跑 2分钟', '跳 x2'] });
    expect(r.failed).toBeFalsy();
    await settle();
    expect(behavior.done).toEqual([{ id: 'walk', to: 0.3 }, { id: 'run', seconds: 120 }, { id: 'jump' }, { id: 'jump' }]);
  });

  it('accepts a body action without holding the next chat turn and records real playback receipts', async () => {
    const { behavior, events, world, call } = setup();
    let finish!: (ends: CommandEnd[]) => void;
    behavior.enqueue = async (commands: Command[]) => {
      return new Promise((resolve) => { finish = resolve; });
    };
    const accepted = await call('pet_act', { actions: ['挥手'] });
    expect(accepted.text).toContain('已受理动作');
    expect((events as unknown as Array<{ type: string }>).map((e) => e.type)).not.toContain('pet.message');

    expect(await world.typed('1')).toBe(true);
    await call('pet_say', { script: '收到' });
    await settle();
    expect((events as unknown as Array<{ type: string }>).map((e) => e.type)).toContain('pet.message');

    const action = { actionId: 'body-action-1', id: 'wave', clip: 'wave.webm', playbackId: 7, at: Date.now() };
    behavior.emit('action', { ...action, state: 'started' });
    behavior.emit('action', { ...action, state: 'completed' });
    finish([{ id: 'wave', outcome: 'done', x: 0.5 }]);
    behavior.emit('command', { id: 'wave', outcome: 'done', x: 0.5 });
    await settle();
    const actionEvents = (events as unknown as Array<{ type: string; meta?: { state?: string; actionId?: string } }>)
      .filter((e) => e.type === 'pet.action');
    expect(actionEvents.map((e) => e.meta?.state)).toEqual(['started', 'completed']);
    expect(new Set(actionEvents.map((e) => e.meta?.actionId)).size).toBe(1);
  });

  it('says where she stands and where she may go', async () => {
    const { call } = setup();
    expect((await call('pet_where', {})).text).toBe('你站在屏幕横向 50% 处。能去:0–40%、60–100%。不能去(有人在用的地方):40–60%。');
  });

  it('asks in the bubble for now', async () => {
    const { link, call } = setup();
    await call('pet_ask', { question: '喝什么?', options: ['茶', '咖啡'] });
    await settle();
    expect(link.said).toEqual(['喝什么? 1. 茶 2. 咖啡']);
  });

  it('keeps a question until it is answered, and holds it once even when asked again', async () => {
    const { call, world } = setup();
    await call('pet_ask', { question: '喝什么?', options: ['茶', '咖啡'] });
    expect(world.pendingAsks()).toMatchObject([{ question: '喝什么?', options: ['茶', '咖啡'] }]);
    // asked again with another option: still one question, the latest
    await call('pet_ask', { question: '喝什么?', options: ['茶'] });
    expect(world.pendingAsks()).toHaveLength(1);
    expect(world.pendingAsks()[0]!.options).toEqual(['茶']);
    // answered: it is gone
    await world.answered('喝什么?', '茶');
    expect(world.pendingAsks()).toEqual([]);
  });

  it('routes a body reply to the only pending question with its stable question id', async () => {
    const { call, world } = setup();
    const events: Array<Record<string, unknown>> = [];
    await world.start({ pushEvent: async (event: Record<string, unknown>) => { events.push(event); return event; } } as never);
    await call('pet_ask', { question: '喝什么?', options: ['茶', '咖啡'] });

    expect(await world.typedFromBody('茶')).toBe(true);
    expect(events.find((event) => event.type === 'pet.answer')).toMatchObject({
      meta: { question: '喝什么?', text: '茶', questionId: expect.any(String) },
    });
    expect(world.pendingAsks()).toEqual([]);
  });

  it('routes a body reply to the newest pending question and preserves older questions', async () => {
    const { call, world } = setup();
    const events: Array<Record<string, unknown>> = [];
    await world.start({ pushEvent: async (event: Record<string, unknown>) => { events.push(event); return event; } } as never);
    await call('pet_ask', { question: '喝什么?', options: ['茶'] });
    await call('pet_ask', { question: '吃什么?', options: ['面'] });

    expect(await world.typedFromBody('面')).toBe(true);
    expect(events.find((event) => event.type === 'pet.answer')).toMatchObject({
      meta: { question: '吃什么?', text: '面', questionId: expect.any(String) },
    });
    expect(world.pendingAsks()).toMatchObject([{ question: '喝什么?' }]);
  });

  it('keeps body text as ordinary chat when there is no pending question', async () => {
    const { world } = setup();
    const events: Array<Record<string, unknown>> = [];
    await world.start({ pushEvent: async (event: Record<string, unknown>) => { events.push(event); return event; } } as never);

    expect(await world.typedFromBody('你好')).toBe(true);
    expect(events.some((event) => event.type === 'pet.message' && (event.meta as { text?: string })?.text === '你好')).toBe(true);
  });

  it('keeps text for the workbench when the body is not there', async () => {
    const { link, call } = setup();
    link.connected = false;
    expect(await call('pet_say', { script: '在吗' })).toMatchObject({ text: expect.stringContaining('presentation is unconfirmed') });
    expect(link.said).toEqual([]);
  });

  it('keeps independently answerable questions when the body is offline', async () => {
    const { link, call, world } = setup();
    await call('pet_ask', { question: '喝什么?', options: ['茶'] });
    link.connected = false;
    expect((await call('pet_ask', { question: '喝什么?', options: ['咖啡'] })).failed).toBeFalsy();
    expect((await call('pet_ask', { question: '吃什么?' })).failed).toBeFalsy();
    expect(world.pendingAsks()).toMatchObject([{ question: '喝什么?', options: ['咖啡'] }, { question: '吃什么?' }]);
  });

  it('retains a question when answer delivery fails and removes it after a retry succeeds', async () => {
    const { call, world } = setup();
    await call('pet_ask', { question: '喝什么?', options: ['茶'] });
    await world.start({ pushEvent: async () => { throw new Error('offline'); } } as never);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await world.answered('喝什么?', '茶')).toBe(false);
      expect(world.pendingAsks()).toMatchObject([{ question: '喝什么?' }]);
      await world.start({ pushEvent: async (event: unknown) => event } as never);
      expect(await world.answered('喝什么?', '茶')).toBe(true);
      expect(world.pendingAsks()).toEqual([]);
    } finally { warning.mockRestore(); }
  });

  it('does not report archive-only input or answers as delivered to the front', async () => {
    const { call, world } = setup();
    await call('pet_ask', { question: '喝什么?', options: ['茶'] });
    await world.start({ pushEvent: async (event: Record<string, unknown>) => ({ ...event, contextDelivery: 'archive-only' }) } as never);
    expect(await world.typed('你好')).toBe(false);
    expect(await world.answered('喝什么?', '茶')).toBe(false);
    expect(world.pendingAsks()).toMatchObject([{ question: '喝什么?' }]);
  });

  it('does not clear a question asked again while the earlier answer is being delivered', async () => {
    const { call, world } = setup();
    await call('pet_ask', { question: '喝什么?', options: ['茶'] });
    let finish!: () => void;
    await world.start({ pushEvent: (event: { type: string }) => event.type === 'pet.answer'
      ? new Promise((resolve) => { finish = () => resolve(event); }) : Promise.resolve(event) } as never);
    const delivering = world.answered('喝什么?', '茶');
    await call('pet_ask', { question: '喝什么?', options: ['咖啡'] });
    finish();
    expect(await delivering).toBe(true);
    expect(world.pendingAsks()).toMatchObject([{ question: '喝什么?', options: ['咖啡'] }]);
  });

  it('tells the front how a command ended and what a hand did, with how she feels', async () => {
    const { link, behavior, events, call } = setup();
    behavior.command = async () => new Promise<never>(() => {});
    await call('pet_act', { actions: ['走 30%'] });
    await settle();
    behavior.emit('command', { id: 'walk', outcome: 'interrupted', x: 0.3, by: 'hand' });
    link.emit('message', { t: 'drop', x: 0.7, vx: 900, vy: 0 });
    link.emit('message', { t: 'landed', x: 0.8 });
    // a plain gesture, and a walk of her own: not told
    behavior.emit('command', { id: 'wave', outcome: 'done', x: 0.8 });
    behavior.emit('command', { id: 'walk', outcome: 'arrived', x: 0.6 });
    await settle();
    const delivered = events.filter((event) => event.type === 'pet.moved' || event.type === 'pet.touch');
    expect(delivered.map((e) => e.type)).toEqual(['pet.moved', 'pet.touch']);
    expect(delivered[0]!.text).toMatch(/\[how you feel\] rested\n\[moved\] 走到一半被小王拎走了,现在在 30% 处。$/);
    expect(delivered[1]!.text).toMatch(/\[touch\] 小王把你拎起来甩了出去,你落在屏幕横向 80% 处$/);
  });

  it('reports a front gesture interrupted by a hand', async () => {
    const { behavior, events, call } = setup();
    behavior.command = async () => new Promise<never>(() => {});
    await call('pet_act', { actions: ['挥手'] });
    await settle();
    behavior.emit('command', { id: 'wave', outcome: 'interrupted', x: 0.5, by: 'hand' });
    await settle();

    expect(events.filter((event) => event.type === 'pet.moved').at(-1)?.text).toContain('挥手到一半被小王拎走了');
  });

  it('reports a front gesture as unknown when the body disconnects mid-action', async () => {
    const { behavior, events, call } = setup();
    behavior.command = async () => new Promise<never>(() => {});
    await call('pet_act', { actions: ['挥手'] });
    await settle();
    behavior.emit('command', { id: 'wave', outcome: 'unknown', x: 0.5, by: 'disconnect' });
    await settle();

    expect(events.filter((event) => event.type === 'pet.moved').at(-1)?.text).toContain('挥手进行时身体断开了,无法确认有没有做完');
  });

  it('archives clicks quietly by default, while voice policy can wake the front', async () => {
    vi.useFakeTimers();
    try {
      const { link, events, world } = setup();
      for (let i = 0; i < 3; i++) link.emit('message', { t: 'click', x: 0.5 });
      await vi.advanceTimersByTimeAsync(3000);
      const interactions = events.filter((event) => event.type === 'pet.interaction');
      expect(interactions).toHaveLength(2);
      expect(interactions[0]).toMatchObject({ meta: { kind: 'click', state: 'started' } });
      expect(interactions[1]).toMatchObject({ meta: { kind: 'click', state: 'completed', count: 3 } });
      expect(interactions[1]!.meta!.interactionId).toBe(interactions[0]!.meta!.interactionId);
      expect(events.filter((event) => event.type === 'pet.touch')).toHaveLength(0);
      const daily = (world as unknown as { opts: { daily: { setInteractionPolicy(policy: { voice: 'consider' }): unknown } } }).opts.daily;
      daily.setInteractionPolicy({ voice: 'consider' });
      link.emit('message', { t: 'click', x: 0.5, interactionId: 'voice-click' });
      await vi.advanceTimersByTimeAsync(3000);
      const touches = events.filter((event) => event.type === 'pet.touch');
      expect(touches).toHaveLength(1);
      expect(touches[0]).toMatchObject({ type: 'pet.touch', trigger: 'debounce', meta: { interactionId: 'voice-click' } });
    } finally { vi.useRealTimers(); }
  });

  it('archives one drag interaction from grab through landing without move events', async () => {
    const { link, events } = setup();
    link.emit('message', { t: 'grab', x: 0.2 });
    link.emit('message', { t: 'drop', x: 0.65, vx: 120, vy: 0 });
    link.emit('message', { t: 'landed', x: 0.7 });
    await settle();
    const interactions = events.filter((event) => event.type === 'pet.interaction');
    expect(interactions).toHaveLength(3);
    expect(interactions.map((event) => [event.meta?.kind, event.meta?.state])).toEqual([
      ['drag-start', 'started'], ['drag-end', 'released'], ['drag-end', 'completed'],
    ]);
    expect(new Set(interactions.map((event) => event.meta?.interactionId)).size).toBe(1);
    expect(interactions[0]!.meta).toMatchObject({ x: 0.2 });
    expect(interactions.at(-1)!.meta).toMatchObject({ from: 0.2, x: 0.7 });
    expect(events.some((event) => event.type === 'pet.interaction' && event.meta?.kind === 'drag-move')).toBe(false);
  });
});
