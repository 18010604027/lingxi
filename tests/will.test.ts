import { describe, expect, it } from 'vitest';
import { createWill } from '../core/behavior/will.ts';

/** A seeded 0..1 source, so a run is the same each time. */
function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const tick = (w: ReturnType<typeof createWill>, seconds: number, s: Record<string, unknown> = {}, from = 0) => {
  for (let t = 0; t < seconds; t += 0.5) w.tick({ dt: 0.5, T: from + t, moving: false, running: false, seated: false, asleep: false, still: t, pointerBusy: false, hour: 15, ...s });
};

describe('the will', () => {
  it('chooses its own way, varied, and never only one thing', () => {
    const w = createWill({ rnd: seeded(7) });
    const seen = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const c = w.next({ T: i * 5, free: true, roam: 'calm' });
      if (c) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect(seen.has('face')).toBe(false); // faces belong to what it says, not to the will
    expect(Math.max(...seen.values())).toBeLessThan(400 * 0.5);
  });

  it('acts on its own only when free, but carries out a wish to go anyway', () => {
    const w = createWill({ rnd: seeded(3) });
    expect(w.next({ T: 0, free: false, roam: 'calm' })).toBeNull();
    w.wish({ kind: 'go', x: 0.2, walkId: 'w1', ttl: 30 }, 1);
    expect(w.next({ T: 1, free: false, roam: 'calm' })).toMatchObject({ name: 'go', wish: { x: 0.2, walkId: 'w1' } });
    w.settle('go');
    expect(w.wishes).toHaveLength(0);
  });

  it('wishes fade', () => {
    const w = createWill({ rnd: seeded(5) });
    w.wish({ kind: 'roam', strength: 1, ttl: 5 }, 0);
    tick(w, 10);
    expect(w.wishes).toHaveLength(0);
  });

  it('always chooses teleport for an obstacle crossing, independent of urgency or drives', () => {
    const w = createWill({ rnd: seeded(11) });
    for (let i = 0; i < 60; i++) {
      expect(w.cross({ T: i * 10, width: i % 2 ? 0.3 : 0.8, urgent: !!(i % 2), pointerBusy: !!(i % 3), policy: i % 2 ? 'turn' : 'stop' })).toBe('teleport');
    }
  });

  it('is wary after being thrown, and the choice just before becomes less its habit', () => {
    const w = createWill({ rnd: seeded(2) });
    const c = w.next({ T: 0, free: true, roam: 'calm' })!;
    w.feel('thrown', 5);
    expect(w.drives.unease).toBeGreaterThan(0.4);
    expect(w.habits[c.name]).toBeLessThan(1);
    expect(w.describe()).toContain('wary');
    tick(w, 120, {}, 10);
    expect(w.describe()).not.toContain('wary');
  });

  it('gets tired walking and rests it off, and says so', () => {
    const w = createWill({ rnd: seeded(4) });
    tick(w, 120, { moving: true, running: true });
    expect(w.describe()).toMatch(/tired/);
    tick(w, 200, { seated: true }, 200);
    expect(w.describe()).toMatch(/^rested/);
  });

  it('the faces it is given to wear feed the same state', () => {
    const w = createWill({ rnd: seeded(9) });
    for (let i = 0; i < 4; i++) w.feel('face:happy', i);
    expect(w.describe()).toContain('cheerful');
  });

  it('roaming off: nothing of its own, but a wish to go is still carried out', () => {
    const w = createWill({ rnd: seeded(6) });
    for (let i = 0; i < 100; i++) expect(w.next({ T: i * 5, free: true, roam: 'off' })).toBeNull();
    w.wish({ kind: 'go', x: 0.3, ttl: 30 }, 600);
    expect(w.next({ T: 600, free: true, roam: 'off' })?.name).toBe('go');
  });
});
