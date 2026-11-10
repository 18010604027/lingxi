import { describe, expect, it } from 'vitest';
import { planTravel, type MoveClip } from '../core/behavior/plan.ts';

const crab: MoveClip = { clip: '螃蟹走路', leadSec: 2, tailSec: 2, minDist: 60, maxDist: 240 };

describe('going somewhere, as the behaviour system plans it', () => {
  it("walks a way the clip's range covers in one move, facing the way it goes", () => {
    // body 462 px wide (the figure's reference), area 2000 px: 0.5 → 0.6 is 200 px, inside 60–240
    expect(planTravel(0.5, 0.6, 2000, 462, 462, crab)).toEqual({ facing: 'right', steps: [{ clip: '螃蟹走路', x: 0.6, leadSec: 2, tailSec: 2 }] });
    expect(planTravel(0.5, 0.4, 2000, 462, 462, crab)?.facing).toBe('left');
  });

  it('goes farther in as few equal moves as the way needs, each inside the range, ending where asked', () => {
    const plan = planTravel(0.1, 0.9, 2000, 462, 462, crab)!;
    // 1600 px, at most 240 a move: 7 moves of about 229
    expect(plan.steps).toHaveLength(7);
    expect(plan.steps.at(-1)!.x).toBeCloseTo(0.9);
    const xs = [0.1, ...plan.steps.map((s) => s.x)];
    for (let i = 1; i < xs.length; i++) expect((xs[i]! - xs[i - 1]!) * 2000).toBeLessThanOrEqual(240);
  });

  it("scales the range to the body's size", () => {
    // a body 231 px wide (half the reference) moves at most 120 px: 400 px is 4 moves
    expect(planTravel(0.2, 0.4, 2000, 231, 462, crab)!.steps).toHaveLength(4);
  });

  it('does not walk a way shorter than half the least stride', () => {
    expect(planTravel(0.5, 0.51, 2000, 462, 462, crab)).toBeNull();
  });

  it('aligns a media-cut travel arrival with the clip cutoff without changing the declared tail', () => {
    const run: MoveClip = { clip: 'run', leadSec: 1.75, tailSec: 4.8, durationSec: 10.042, endSec: 4,
      minDist: 120, maxDist: 320 };
    const step = planTravel(0.5, 0.6, 2000, 462, 462, run)!.steps[0]!;
    expect(step).toMatchObject({ endSec: 4, tailSec: 6.042, x: 0.6 });
    expect(run.tailSec).toBe(4.8);
  });

  it('keeps a long native-speed run in one segmented play', () => {
    const run: MoveClip = { clip: 'run', leadSec: 1.75, tailSec: 4.8, minDist: 120, maxDist: 320,
      durationSec: 10.042, endSec: 4, segment: { startSec: 2, endSec: 4 } };
    const plan = planTravel(0.1, 0.9, 2000, 462, 462, run)!;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ x: 0.9, leadSec: 0, tailSec: 0,
      segment: { startSec: 2, endSec: 4, durationSec: 11.25 } });
    expect(plan.steps[0]).not.toHaveProperty('endSec');
  });
});

describe('where she may stand and how she gets past where she may not', () => {
  it('stands outside the stretches, and finds the nearest spot outside them', async () => {
    const { allowed, nearestAllowed } = await import('../core/behavior/plan.ts');
    expect(allowed(0.5, [[0.4, 0.6]])).toBe(false);
    expect(allowed(0.3, [[0.4, 0.6]])).toBe(true);
    expect(nearestAllowed(0.45, [[0.4, 0.6]])).toBeCloseTo(0.4, 2);
    expect(nearestAllowed(0.58, [[0.4, 0.6]])).toBeCloseTo(0.6, 2);
    expect(nearestAllowed(0.5, [[0, 1]])).toBeNull();
  });

  it('walks up to a stretch, crosses it in one run, and walks on', async () => {
    const { route } = await import('../core/behavior/plan.ts');
    expect(route(0.2, 0.8, [[0.4, 0.6]], 0.01)).toEqual([{ kind: 'walk', to: 0.39 }, { kind: 'cross', to: 0.61 }, { kind: 'walk', to: 0.8 }]);
    expect(route(0.8, 0.2, [[0.4, 0.6]], 0.01)).toEqual([{ kind: 'walk', to: 0.61 }, { kind: 'cross', to: 0.39 }, { kind: 'walk', to: 0.2 }]);
    expect(route(0.2, 0.3, [[0.4, 0.6]])).toEqual([{ kind: 'walk', to: 0.3 }]);
  });

  it('finds the exact closest reachable edge through overlapping zones and a narrow legal gap', async () => {
    const { nearestAllowed } = await import('../core/behavior/plan.ts');
    expect(nearestAllowed(0.5, [[0.3, 0.6], [0.55, 0.8]], 0.1, 0.9)).toBe(0.3);
    expect(nearestAllowed(0.5005, [[0.2, 0.501], [0.502, 0.8]], 0.1, 0.9)).toBe(0.501);
    expect(nearestAllowed(0.12, [[0.05, 0.30]], 0.1155, 0.8845)).toBe(0.30);
  });

  it('crosses overlapping keep-outs as one obstacle and preserves one continuous target', async () => {
    const { route, crossTravel } = await import('../core/behavior/plan.ts');
    expect(route(0.1, 0.9, [[0.3, 0.6], [0.55, 0.8]])).toEqual([
      { kind: 'walk', to: 0.29 }, { kind: 'cross', to: 0.81 }, { kind: 'walk', to: 0.9 },
    ]);
    const move = { ...crab, durationSec: 10.042, endSec: 4, segment: { startSec: 2, endSec: 4 } };
    const plan = crossTravel(0.1, 0.9, move, 2000, 462, 462)!;
    expect(plan.steps).toHaveLength(1); expect(plan.steps[0]!.x).toBe(0.9);
    expect(plan.steps[0]!.segment).toMatchObject({ startSec: 2, endSec: 4 });
  });
});
