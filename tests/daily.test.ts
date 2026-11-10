import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Command, CommandEnd } from '../core/behavior/behavior.ts';
import { Daily } from '../core/behavior/daily.ts';
import { createWill } from '../core/behavior/will.ts';

function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** A behaviour system that does each command at once and remembers it. */
class FakeBehavior extends EventEmitter {
  busy = false;
  doing: string | null = null;
  place = { x: 0.5, facing: 'left' as 'left' | 'right', areaWidth: 2000 };
  keptOut: Array<[number, number]> = [];
  done: Command[] = [];
  reacted: string[][] = [];
  react(words: string[], _interactionId: string): void { this.reacted.push(words); }
  async command(c: Command): Promise<CommandEnd> {
    this.done.push(c);
    if (typeof c.to === 'number') this.place.x = c.to;
    return { id: c.id, outcome: c.to !== undefined ? 'arrived' : 'done', x: this.place.x };
  }
}

function setup(seed = 3, hour = 15, extra: Record<string, unknown> = {}) {
  let T = 0;
  const behavior = new FakeBehavior();
  const link = new EventEmitter();
  const will = createWill({ rnd: seeded(seed) });
  const { clickActions, ...rest } = extra as { clickActions?: string[] };
  const daily = new Daily(behavior as never, link, will, { random: seeded(seed + 100), now: () => T, hour: () => hour, ...rest });
  if (clickActions) daily.setClickActions(clickActions);
  const run = async (seconds: number) => { for (let i = 0; i < seconds; i++) { T += 1; daily.tick(); await new Promise((r) => setImmediate(r)); } };
  return { behavior, link, will, daily, run };
}

describe('what she does on her own', () => {
  it('does things of her own every few seconds, varied, with the figure\'s words', async () => {
    const { behavior, run } = setup();
    await run(600);
    const ids = new Set(behavior.done.map((c) => c.id));
    expect(behavior.done.length).toBeGreaterThan(20);
    expect(ids.size).toBeGreaterThanOrEqual(4);
    expect(ids.has('walk')).toBe(true);
    expect(ids.has('run')).toBe(false);
  });

  it('waits while a command is under way or a hand holds her', async () => {
    const { behavior, run } = setup();
    behavior.busy = true;
    await run(60);
    expect(behavior.done).toHaveLength(0);
  });

  it('never walks to where the person works', async () => {
    const { behavior, run } = setup(5);
    behavior.keptOut = [[0.3, 0.7]];
    behavior.place.x = 0.2;
    await run(600);
    for (const c of behavior.done) if (typeof c.to === 'number') expect(c.to <= 0.3 || c.to >= 0.7).toBe(true);
  });

  it('is wary after a throw and the will hears of it', async () => {
    const { link, will } = setup();
    link.emit('message', { t: 'drop', x: 0.5, vx: 900, vy: -200 });
    expect(will.drives.unease).toBeGreaterThan(0.4);
  });

  it('carries out a wish to go somewhere and lets it go when there', async () => {
    const { behavior, daily, will, run } = setup();
    daily.wish({ kind: 'go', x: 0.9, ttl: 60 });
    await run(5);
    expect(behavior.done.some((c) => c.to === 0.9)).toBe(true);
    expect(will.wishes).toHaveLength(0);
  });

  it('roaming off: nothing of her own', async () => {
    const { behavior, daily, run } = setup();
    daily.roam = 'off';
    await run(120);
    expect(behavior.done).toHaveLength(0);
  });

  it('a click plays one of the library actions marked as a click response', () => {
    const { behavior, link } = setup(3, 15, { clickActions: ['wave', 'spin'] });
    link.emit('message', { t: 'click', x: 0.5, at: 1 });
    expect(behavior.reacted).toHaveLength(1);
    expect(['wave', 'spin']).toContain(behavior.reacted[0]![0]);
  });

  it('a click with no library entry falls back to the instinct', () => {
    const { behavior, link } = setup(3, 15, { clickActions: [] });
    link.emit('message', { t: 'click', x: 0.5, at: 1 });
    expect(behavior.reacted).toHaveLength(1);
    expect(behavior.reacted[0]!.length).toBeGreaterThan(0);
  });
});
