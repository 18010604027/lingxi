import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Behavior, type ActionReceipt, type CommandEnd } from '../core/behavior/behavior.ts';
import { Daily } from '../core/behavior/daily.ts';
import type { BodyCommand, BodyMessage } from '../core/behavior/body-link.ts';
import type { Figure } from '../core/behavior/plan.ts';
import { createWill } from '../core/behavior/will.ts';
import { workareaBody } from '../core/behavior/workarea-body.ts';

const figure: Figure = {
  name: 't', source: 't', refWidth: 462, bodyWidth: 462, nativeFacing: 'left', idle: ['idle'], held: ['held'], noMirror: [],
  canvas: { width: 640, height: 360 },
  hit: { box: { x0: 200, y0: 50, x1: 440, y1: 335 } },
  moves: {
    walk: [
      { clip: 'walk', leadSec: 0, tailSec: 0, minDist: 60, maxDist: 240 },
      { id: 'float', clip: 'float', leadSec: 0, tailSec: 0, minDist: 40, maxDist: 120, default: false, zh: ['飘'], about: '漂着挪', when: '只挪一点点' },
    ],
    run: [{ id: 'dash', clip: 'run', leadSec: 0, tailSec: 0, minDist: 120, maxDist: 320 }],
  },
  words: { wave: ['wave'], sleep: ['sleep'] },
};

/** A body that does at once what it is told and says so, as the real one does when a clip ends. */
class FakeBody extends EventEmitter {
  connected = true;
  x = 0.2; facing: 'left' | 'right' = 'left'; areaWidth = 2000;
  pointer: { x: number; y: number } | null = null;
  display = { x: 0, y: 0, width: 2000, height: 1000, scale: 1 };
  finishClips = true;
  sent: Array<BodyCommand & { id: number }> = [];
  private next = 1;
  send(c: BodyCommand): number {
    const id = this.next++;
    this.sent.push({ ...c, id });
    setImmediate(() => {
      if (c.t === 'move') { this.x = c.x; this.message({ t: 'move', id, state: 'arrived', x: c.x }); }
      if (c.t === 'play' && !c.loop && this.finishClips) {
        if (c.travel) {
          this.x = Math.max(462 / this.areaWidth / 2, Math.min(1 - 462 / this.areaWidth / 2, c.travel.x));
          this.message({ t: 'move', id, state: 'arrived', x: this.x });
        }
        this.message({ t: 'clip', id, state: 'ended' });
      }
    });
    return id;
  }
  message(m: BodyMessage): void { this.emit('message', m); }
  waitFor(match: (m: BodyMessage) => boolean): Promise<BodyMessage> {
    if (!this.connected) return Promise.reject(new Error('body disconnected'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.off('message', on); this.off('gone', gone); };
      const on = (m: BodyMessage) => { if (match(m)) { cleanup(); resolve(m); } };
      const gone = () => { cleanup(); reject(new Error('body disconnected')); };
      this.on('message', on); this.once('gone', gone);
    });
  }
  disconnect(): void { this.connected = false; this.emit('gone'); }
}

function setup(customFigure = figure) {
  const body = new FakeBody();
  const behavior = new Behavior(body as never, customFigure, 462, () => 0.5, 50);
  const ends: CommandEnd[] = [];
  behavior.on('command', (e: CommandEnd) => ends.push(e));
  return { body, behavior, ends };
}

describe('the behaviour system with a body', () => {
  it('contact does not wait for an ordinary one-shot daily clip to end', async () => {
    const { body, behavior } = setup();
    body.finishClips = false;
    new Daily(behavior, body, createWill());
    const sleeping = behavior.command({ id: 'sleep' }, 'daily');
    const old = body.sent.at(-1)!;
    body.message({ t: 'clip', id: old.id, state: 'playing' });
    body.message({ t: 'click', x: 0.2, interactionId: 'touch-now' });
    await new Promise(resolve => setImmediate(resolve));
    const reaction = body.sent.at(-1)!;
    expect(reaction).toMatchObject({ t: 'play', clip: 'wave.webm' });
    expect((await sleeping).outcome).toBe('interrupted');
    body.message({ t: 'clip', id: old.id, state: 'replaced' });
    body.message({ t: 'clip', id: reaction.id, state: 'playing' });
    body.message({ t: 'clip', id: reaction.id, state: 'ended' });
    await new Promise(resolve => setImmediate(resolve));
  });

  it('reacts immediately without queuing repeated contacts and records only real playback receipts', async () => {
    const { body, behavior } = setup();
    body.finishClips = false;
    const receipts: ActionReceipt[] = [];
    behavior.on('action', (receipt: ActionReceipt) => receipts.push(receipt));
    const daily = new Daily(behavior, body, createWill());
    body.message({ t: 'click', x: 0.2, interactionId: 'touch-1' });
    const play = body.sent.at(-1)!;
    expect(play).toMatchObject({ t: 'play', clip: 'wave.webm' });
    expect(receipts).toHaveLength(0);
    body.message({ t: 'clip', id: play.id, state: 'playing' });
    body.message({ t: 'click', x: 0.2, interactionId: 'touch-2' });
    body.message({ t: 'click', x: 0.2, interactionId: 'touch-3' });
    expect(body.sent).toHaveLength(1);
    body.message({ t: 'clip', id: play.id, state: 'ended' });
    await new Promise(resolve => setImmediate(resolve));
    expect(receipts.map(r => r.state)).toEqual(['started', 'completed']);
    expect(receipts[0].actionId).toBe(receipts[1].actionId);
    expect(receipts[0].interactionId).toBe('touch-1');
    expect(body.sent.filter(c => c.t === 'play' && c.clip === 'wave.webm')).toHaveLength(1);
    expect(daily.interactionPolicy.voice).toBe('quiet');
  });

  it('respects a front-selected contact word and clears the old destination on pickup', async () => {
    const { body, behavior } = setup();
    const will = createWill();
    const daily = new Daily(behavior, body, will);
    daily.setInteractionPolicy({ click: 'wave', landed: 'wave', voice: 'consider' });
    will.wish({ kind: 'go', x: 0.9 }, 0);
    body.message({ t: 'grab', x: 0.2, at: 1, interactionId: 'drag-1' });
    expect(will.wishes).toHaveLength(0);
    body.message({ t: 'drop', x: 0.4, vx: 0, vy: 0, interactionId: 'drag-1' });
    body.message({ t: 'landed', x: 0.4, interactionId: 'drag-1' });
    expect(body.sent.at(-1)).toMatchObject({ t: 'play', clip: 'wave.webm' });
    expect(body.sent.some(c => c.t === 'play' && c.travel?.x === 0.9)).toBe(false);
    expect(() => daily.setInteractionPolicy({ click: 'missing' })).toThrow('Unknown interaction action');
    await new Promise(resolve => setImmediate(resolve));
  });

  it('maps hand moves through the pet display origin and scale', () => {
    const { body, behavior } = setup();
    body.display = { x: -1920, y: 0, width: 2560, height: 1440, scale: 1.5 };
    body.x = 0.25;
    let move: { from: number | null; to: number | null } | undefined;
    workareaBody(body as never, behavior, 462).onHand((e) => { move = e; });
    body.message({ t: 'grab', x: 0.25, at: Date.now() });
    body.message({ t: 'drop', x: 0.5, vx: 0, vy: 0 });
    expect(move).toMatchObject({ from: -1920, to: -960 });
  });

  it('uses an explicitly chosen teleport to cross a work area', async () => {
    const { body, behavior } = setup();
    behavior.setZones([[0.4, 0.6]]);
    behavior.setCrossPolicy(() => 'teleport');
    const end = await behavior.command({ id: 'walk', to: 0.8 });
    expect(end).toMatchObject({ id: 'walk', outcome: 'arrived', crossed: 1 });
    expect(body.x).toBeCloseTo(0.8);
    // the stretch is crossed in one clip: the pack's cross when it names one, a walk otherwise — never the run,
    // whose clip trips over itself (user, 10-29)
    const crossed = body.sent.filter((c) => c.t === 'play' && c.travel && c.clip !== 'run.webm');
    expect(crossed.length).toBeGreaterThan(0);
    expect(body.sent.some((c) => c.t === 'move' && c.mode === 'instant')).toBe(true);
  });

  it('uses instant movement for daily obstacle avoidance and never substitutes a run', async () => {
    const { body, behavior } = setup();
    new Daily(behavior as never, new EventEmitter(), createWill({ rnd: () => 0.5 }), { now: () => 10 });
    behavior.setZones([[0.4, 0.6]]);
    const end = await behavior.command({ id: 'walk', to: 0.9 });
    expect(end.outcome).toBe('arrived');
    expect(body.sent.some((c) => c.t === 'move' && c.mode === 'instant')).toBe(true);
    expect(body.sent.some((c) => c.t === 'play' && c.clip === 'run.webm')).toBe(false);
  });

  it('uses only the configured fast crossing move when the figure has no teleport', async () => {
    const fallback: Figure = { ...figure, moves: { ...figure.moves, teleport: false,
      cross: { clip: 'fast-cross', leadSec: 0, tailSec: 0, minDist: 1, maxDist: 2000 } } };
    const { body, behavior } = setup(fallback);
    new Daily(behavior as never, new EventEmitter(), createWill({ rnd: () => 0.5 }), { now: () => 10, random: () => 0 });
    behavior.setZones([[0.4, 0.6]]);
    const end = await behavior.command({ id: 'walk', to: 0.9 });
    expect(end.outcome).toBe('arrived');
    const travelClips = body.sent.flatMap((c) => c.t === 'play' && c.travel ? [c.clip] : []);
    expect(travelClips.filter((clip) => clip !== 'walk.webm')).toEqual(['fast-cross.webm']);
    expect(body.sent.some((c) => c.t === 'move' && c.mode === 'instant')).toBe(false);
  });

  it('only runs across now and then when the figure has no teleport', async () => {
    const fallback: Figure = { ...figure, moves: { ...figure.moves, teleport: false,
      cross: { clip: 'fast-cross', leadSec: 0, tailSec: 0, minDist: 1, maxDist: 2000 } } };
    const { body, behavior } = setup(fallback);
    new Daily(behavior as never, new EventEmitter(), createWill({ rnd: () => 0.5 }), { now: () => 10, random: () => 0.5 });
    behavior.setZones([[0.4, 0.6]]);
    const end = await behavior.command({ id: 'walk', to: 0.9 });
    expect(end.outcome).toBe('wall');
    expect(body.sent.some((c) => c.t === 'play' && c.clip === 'fast-cross.webm')).toBe(false);
  });

  it.each(['front', 'daily'] as const)('keeps a %s route outside the drawn work area without a crossing policy', async (urgency) => {
    const { body, behavior } = setup();
    // The production bridge receives screen pixels and maps them to centre
    // shares before Behavior adds half of the drawn body width.
    workareaBody(body as never, behavior, 462).keepOut([[800, 1200]], []);
    const end = await behavior.command({ id: 'walk', to: 0.8 }, urgency);
    expect(end).toMatchObject({ id: 'walk', outcome: 'wall' });
    const half = (0.375 * 462) / 2000 / 2;
    const travels = body.sent.filter((c) => c.t === 'play' && c.travel);
    expect(travels.every((c) => c.t === 'play' && c.travel!.x < 0.4 - half)).toBe(true);
    expect(body.x).toBeLessThan(0.4 - half);
    expect(body.sent.some((c) => c.t === 'move' && c.mode === 'instant')).toBe(false);
  });

  it('does not invent a walking crossing when teleport and an explicit fast crossing are unavailable', async () => {
    const { body, behavior } = setup({ ...figure, moves: { ...figure.moves, teleport: false } });
    behavior.setCrossPolicy(() => 'teleport'); behavior.setZones([[0.4, 0.6]]);
    const end = await behavior.command({ id: 'walk', to: 0.9 });
    expect(end.outcome).toBe('wall');
    expect(body.x).toBeLessThan(0.4);
    expect(body.sent.some((c) => c.t === 'play' && c.travel && c.travel.x > 0.6)).toBe(false);
  });

  it('preserves the configured moving segment for escape and crossing without playing the stopping tail', async () => {
    const actual = JSON.parse(readFileSync(new URL('./fixtures/pack/figure.json', import.meta.url), 'utf8')) as Figure;
    const fallback = { ...actual, moves: { ...actual.moves, teleport: false } };
    const { body, behavior } = setup(fallback);
    body.x = 0.42; behavior.setZones([[0.4, 0.6]]);
    expect((await behavior.command({ id: 'run', to: 0.9 })).outcome).toBe('arrived');
    const escape = body.sent.find((c) => c.t === 'play' && c.travel);
    expect(escape).toMatchObject({ clip: actual.moves.cross!.clip + '.webm', travel: { leadSec: 0, tailSec: 0 },
      segment: { startSec: 2, endSec: 4, durationSec: expect.any(Number) } });
    expect(escape).not.toHaveProperty('endSec');
    const count = body.sent.length;
    behavior.setCrossPolicy(() => 'teleport');
    const end = await behavior.command({ id: 'walk', to: 0.9 });
    expect(end.outcome).toBe('arrived'); expect(body.x).toBeCloseTo(0.8845);
    const crossClips = body.sent.slice(count).filter((c) => c.t === 'play' && c.clip === actual.moves.cross!.clip + '.webm');
    expect(crossClips).toHaveLength(1);
    const crossing = crossClips[0];
    expect(crossing).toMatchObject({ travel: { leadSec: 0, tailSec: 0 }, segment: { startSec: 2, endSec: 4 } });
  });

  it('leaves an occupied work area through its nearest legal edge and does not resume the old target', async () => {
    const { body, behavior } = setup();
    body.x = 0.42;
    workareaBody(body as never, behavior, 462).keepOut([[800, 1200]], []);
    const end = await behavior.command({ id: 'run', to: 0.9 });
    const left = 0.4 - (0.375 * 462) / 2000 / 2;
    expect(end.outcome).toBe('arrived');
    expect(body.x).toBeLessThanOrEqual(left);
    const travelTargets = body.sent.flatMap((c) => c.t === 'move' ? [c.x] : c.t === 'play' && c.travel ? [c.travel.x] : []);
    expect(travelTargets.length).toBeGreaterThan(0);
    expect(travelTargets.every((x) => x < 0.42)).toBe(true);
  });

  it('checks a changed work area before the next movement segment', async () => {
    const { body, behavior } = setup();
    let first = true;
    body.on('message', (m: BodyMessage) => {
      if (m.t === 'move' && first) { first = false; behavior.setZones([[0.35, 0.6]]); }
    });
    const end = await behavior.command({ id: 'walk', to: 0.9 });
    expect(end.outcome).toBe('wall');
    const targets = body.sent.flatMap((c) => c.t === 'move' ? [c.x] : c.t === 'play' && c.travel ? [c.travel.x] : []);
    expect(targets.length).toBeGreaterThan(1);
    expect(body.x).toBeLessThanOrEqual(0.35 - (0.375 * 462) / 2000 / 2);
  });

  it('retries a short exit from the actual reported position until it is legal', async () => {
    const { body, behavior } = setup();
    body.x = 0.36;
    behavior.setZones([[0.4, 0.6]]);
    let reports = 0;
    body.on('message', (m: BodyMessage) => {
      if (m.t === 'move' && ++reports === 1) body.x = 0.357;
    });
    await behavior.command({ id: 'walk', to: 0.9 });
    expect(reports).toBe(2);
    expect(body.x).toBeLessThanOrEqual(0.4 - (0.375 * 462) / 2000 / 2);
  });

  it('chooses an escape edge the body can actually place its centre at', async () => {
    const { body, behavior } = setup();
    body.x = 0.12;
    behavior.setZones([[0.15, 0.30]]);
    const end = await behavior.command({ id: 'walk', to: 0.8 });
    expect(end.outcome).toBe('arrived');
    expect(body.x).toBeGreaterThanOrEqual(0.30 + (0.375 * 462) / 2000 / 2);
  });

  it('converts a screen cursor position to the work-area share before moving', async () => {
    const { body, behavior } = setup();
    body.pointer = { x: 1500, y: 100 };
    const end = await behavior.command({ id: 'walk', to: 'cursor' });
    expect(end.outcome).toBe('arrived');
    expect(body.x).toBeCloseTo(0.75);
  });

  it('cuts a long movement when the work area changes during its active clip', async () => {
    const actualFigure = JSON.parse(readFileSync(new URL('./fixtures/pack/figure.json', import.meta.url), 'utf8')) as Figure;
    const { body, behavior } = setup(actualFigure);
    body.finishClips = false;
    const running = behavior.command({ id: 'run', to: 0.9 });
    await new Promise((resolve) => setImmediate(resolve));
    behavior.setZones([[0.4, 0.6]]);
    expect(body.sent.at(-1)).toMatchObject({ t: 'play', clip: '待机呼吸休闲.webm', loop: true });
    const clip = body.sent.find((c) => c.t === 'play' && c.travel)!;
    body.message({ t: 'clip', id: clip.id, state: 'replaced' });
    await expect(running).resolves.toMatchObject({ outcome: 'wall' });
  });

  it('sends one continuous native-speed run for a long legal leg', async () => {
    const actualFigure = JSON.parse(readFileSync(new URL('./fixtures/pack/figure.json', import.meta.url), 'utf8')) as Figure;
    const { body, behavior } = setup(actualFigure);
    body.x = 0.1;
    const end = await behavior.command({ id: 'run', to: 0.9 });
    const travels = body.sent.filter((c) => c.t === 'play' && c.travel);
    expect(travels).toHaveLength(1);
    expect(travels[0]).toMatchObject({ clip: '原地左转奔跑.webm', travel: { x: 0.8845, leadSec: 0, tailSec: 0 },
      segment: { startSec: 2, endSec: 4, durationSec: expect.closeTo(11.03203125, 8) } });
    expect(travels[0]).not.toHaveProperty('endSec');
    expect(end).toMatchObject({ outcome: 'arrived', x: 0.8845 });
  });

  it('uses a short walk when a run target is below the running stride', async () => {
    const { body, behavior } = setup();
    body.x = 0.5;
    const end = await behavior.command({ id: 'run', to: 0.51 });
    expect(end.outcome).toBe('arrived');
    expect(body.x).toBeCloseTo(0.51);
    expect(body.sent.filter((c) => c.t === 'play').map((c) => c.t === 'play' ? { clip: c.clip, travel: c.travel } : null)).toContainEqual(
      expect.objectContaining({ clip: 'walk.webm', travel: expect.any(Object) }));
    expect(body.sent.some((c) => c.t === 'play' && c.travel && c.clip === 'run.webm')).toBe(false);
  });

  it('keeps the slow float style out of default movement while preserving an explicit request', async () => {
    const actualFigure = JSON.parse(readFileSync(new URL('./fixtures/pack/figure.json', import.meta.url), 'utf8')) as Figure;
    const { body, behavior } = setup(actualFigure);
    await behavior.command({ id: 'walk', to: 0.3 });
    const first = body.sent.filter((c) => c.t === 'play' && c.travel);
    expect(first.every((c) => c.t === 'play' && c.clip === '螃蟹走路.webm')).toBe(true);
    await behavior.command({ id: 'float', to: 0.35 });
    expect(body.sent.some((c) => c.t === 'play' && c.travel && c.clip === '原地漂浮踏步.webm')).toBe(true);
  });

  it('goes by the way of moving the front named, rather than a random one', async () => {
    const { body, behavior } = setup();
    expect(behavior.knows('float')).toBe(true);
    expect(behavior.knows('dash')).toBe(true);
    const end = await behavior.command({ id: 'float', to: 0.25 });
    expect(end).toMatchObject({ id: 'float', outcome: 'arrived' });
    // every step played her float clip, never the plain walk one
    const travels = body.sent.filter((c) => c.t === 'play' && c.travel) as Array<{ clip: string }>;
    expect(travels.length).toBeGreaterThan(0);
    expect(travels.every((c) => c.clip === 'float.webm')).toBe(true);
  });

  it('runs the words of one run one after another, in order', async () => {
    const { body, behavior } = setup();
    const ends = await behavior.plan([{ id: 'wave' }, { id: 'sleep', seconds: 0.05 }], 'front');
    expect(ends.map((e) => e.id)).toEqual(['wave', 'sleep']);
    const clips = body.sent.filter((c) => c.t === 'play').map((c) => (c.t === 'play' ? c.clip : ''));
    expect(clips.indexOf('wave.webm')).toBeGreaterThanOrEqual(0);
    expect(clips.indexOf('wave.webm')).toBeLessThan(clips.indexOf('sleep.webm'));
  });

  it('ends an in-flight clip command on body disconnect and drains again after reconnect', async () => {
    const { body, behavior, ends } = setup();
    body.finishClips = false;
    const running = behavior.command({ id: 'wave' });
    await new Promise((resolve) => setImmediate(resolve));
    body.disconnect();
    expect(await running).toMatchObject({ id: 'wave', outcome: 'unknown', by: 'disconnect' });
    expect(ends.at(-1)).toMatchObject({ id: 'wave', outcome: 'unknown', by: 'disconnect' });

    body.connected = true;
    body.finishClips = true;
    body.emit('hello');
    expect(body.sent.filter((command) => command.t === 'play' && command.clip === 'wave.webm')).toHaveLength(1);
    expect(await behavior.command({ id: 'wave' })).toMatchObject({ id: 'wave', outcome: 'done' });
  });

  it('a newer run from her session drops what her daily script had waiting', async () => {
    const { behavior } = setup();
    const running = behavior.command({ id: 'wave', seconds: 0.8 });
    await new Promise((r) => setTimeout(r, 40));
    const waiting = behavior.command({ id: 'sleep' }, 'daily'); // queued behind the one under way
    await new Promise((r) => setTimeout(r, 20));
    const front = behavior.command({ id: 'jump' });
    const [first, daily, last] = await Promise.all([running, waiting, front]);
    expect(first.outcome).toBe('interrupted');
    expect(daily.outcome).toBe('replaced');
    expect(last).toMatchObject({ id: 'jump', outcome: 'done' });
  });

  it('a front enqueue cuts a daily action and removes stale queued daily work', async () => {
    const { behavior } = setup();
    const running = behavior.command({ id: 'wave', seconds: 0.8 });
    await new Promise((r) => setTimeout(r, 40));
    const stale = behavior.command({ id: 'sleep' }, 'daily');
    await new Promise((r) => setTimeout(r, 20));
    const reply = behavior.enqueue([{ id: 'jump' }], 'front');
    const [first, dropped, inserted] = await Promise.all([running, stale, reply]);
    expect(first.outcome).toBe('interrupted');
    expect(dropped.outcome).toBe('replaced');
    expect(inserted).toMatchObject([{ id: 'jump', outcome: 'done' }]);
  });

  it('her own daily script waits its turn instead of cutting the run short', async () => {
    const { behavior } = setup();
    const running = behavior.command({ id: 'wave', seconds: 0.3 });
    await new Promise((r) => setTimeout(r, 40));
    const daily = behavior.command({ id: 'jump' }, 'daily');
    const [first, second] = await Promise.all([running, daily]);
    expect(first.outcome).toBe('done');
    expect(second).toMatchObject({ id: 'jump', outcome: 'done' });
  });

  it('a hand picking her up clears what was waiting too', async () => {
    const { body, behavior } = setup();
    const running = behavior.command({ id: 'wave', seconds: 0.8 });
    await new Promise((r) => setTimeout(r, 40));
    const waiting = behavior.command({ id: 'jump' }, 'daily');
    await new Promise((r) => setTimeout(r, 20));
    body.message({ t: 'grab', x: 0.2, at: 0 });
    const [first, dropped] = await Promise.all([running, waiting]);
    expect(first.outcome).toBe('interrupted');
    expect(dropped.outcome).toBe('replaced');
  });

  it('goes to the nearest spot it may stand on when the place is in a stretch, and says so', async () => {
    const { behavior } = setup();
    behavior.setZones([[0.4, 0.6]]);
    const end = await behavior.command({ id: 'walk', to: 0.45 });
    expect(end.outcome).toBe('arrived');
    // the stretch is widened by half her drawn width (462 px of a 2000 px work area, 0.375 of the canvas)
    expect(end.adjusted).toBeCloseTo(0.4 - (0.375 * 462) / 2000 / 2, 2);
  });

  it('idles and says there is a wall when there is nowhere it may stand', async () => {
    const { body, behavior, ends } = setup();
    behavior.setZones([[0, 1]]);
    const end = await behavior.command({ id: 'run', to: 0.8 });
    expect(end.outcome).toBe('wall');
    expect(ends.at(-1)?.outcome).toBe('wall');
    expect(body.sent.some((c) => c.t === 'play' && c.clip === 'idle.webm' && c.loop)).toBe(true);
    expect(body.sent.some((c) => c.t === 'play' && c.clip === 'run.webm')).toBe(false);
  });

  it('keeps a gesture up as long as asked, then idles', async () => {
    const { body, behavior } = setup();
    const started = Date.now();
    const end = await behavior.command({ id: 'sleep', seconds: 0.3 });
    expect(end.outcome).toBe('done');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(body.sent.find((c) => c.t === 'play' && c.clip === 'sleep.webm')).toMatchObject({ loop: true });
    expect(body.sent.at(-1)).toMatchObject({ t: 'play', clip: 'idle.webm', loop: true });
  });

  it('a hand picking her up cuts the command short and says so', async () => {
    const { body, behavior, ends } = setup();
    const going = behavior.command({ id: 'wave', seconds: 5 });
    await new Promise((r) => setTimeout(r, 30));
    body.message({ t: 'grab', x: 0.2, at: 0 });
    await going;
    expect(ends).toEqual([expect.objectContaining({ id: 'wave', outcome: 'interrupted', by: 'hand' })]);
    expect(body.sent.at(-1)).toMatchObject({ t: 'play', clip: 'held.webm' });
  });
});
