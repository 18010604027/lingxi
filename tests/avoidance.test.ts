import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Behavior } from '../core/behavior/behavior.ts';
import type { BodyCommand } from '../core/behavior/body-link.ts';
import type { Figure } from '../core/behavior/plan.ts';

const figure: Figure = {
  name: 't', refWidth: 462, bodyWidth: 462, nativeFacing: 'left', idle: ['idle'], held: ['held'], noMirror: [],
  moves: { walk: [{ clip: 'walk', leadSec: 0, tailSec: 0, minDist: 60, maxDist: 240 }], run: [] },
  words: { wave: ['wave'] },
};

class Body extends EventEmitter {
  x = 0.5;
  facing: 'left' | 'right' = 'left';
  areaWidth = 2000;
  display = { x: 0, y: 0, width: 2000, height: 1000, scale: 1 };
  send(_command: BodyCommand): number { return 1; }
}

describe('obstacle avoidance is the person\'s switch', () => {
  it('keeps out of the stretches the work area reports while it is on', () => {
    const behavior = new Behavior(new Body() as never, figure, 462, () => 0.5, 50);
    behavior.setZones([[0.4, 0.6]]);
    expect(behavior.keptOut).toHaveLength(1);
  });

  it('forgets every stretch when it is turned off, and ignores new ones', () => {
    const behavior = new Behavior(new Body() as never, figure, 462, () => 0.5, 50);
    behavior.setZones([[0.4, 0.6]]);
    behavior.setAvoidance(false);
    expect(behavior.keptOut).toEqual([]);
    behavior.setZones([[0.4, 0.6]]);
    expect(behavior.keptOut).toEqual([]);
  });

  it('takes the work area\'s stretches again when it is turned back on', () => {
    const behavior = new Behavior(new Body() as never, figure, 462, () => 0.5, 50);
    behavior.setAvoidance(false);
    behavior.setZones([[0.4, 0.6]]);
    expect(behavior.keptOut).toEqual([]);
    behavior.setAvoidance(true);
    behavior.setZones([[0.4, 0.6]]);
    expect(behavior.keptOut).toHaveLength(1);
  });
});
