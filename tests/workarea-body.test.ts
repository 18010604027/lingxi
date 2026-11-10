import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { HandMove } from '../core/daily/workarea.ts';
import { workareaBody } from '../core/behavior/workarea-body.ts';

function setup() {
  const link = Object.assign(new EventEmitter(), { x: 0.25, display: { x: 0, y: 0, width: 1000, height: 600, scale: 2 } });
  const zones: Array<Array<[number, number]>> = [];
  const behavior = Object.assign(new EventEmitter(), { setZones: (z: Array<[number, number]>) => zones.push(z) });
  let T = 0;
  const body = workareaBody(link as never, behavior as never, 462, () => T);
  const hands: HandMove[] = [];
  body.onHand((e) => hands.push(e));
  return { link, behavior, body, zones, hands, at: (t: number) => { T = t; } };
}

describe('the new body as the work area sees it', () => {
  it('gives where she stands in screen pixels, scaled', () => {
    const { body } = setup();
    expect(body.span()).toEqual({ x: 0, y: 0, w: 2000 });
    const box = body.box()!;
    expect(box.x + box.width / 2).toBeCloseTo(500);
  });

  it('hands the stretches to keep out of to the behaviour system as shares of the area', () => {
    const { body, zones } = setup();
    body.keepOut([[400, 800], [1900, 2400]], ['code', 'chat']);
    expect(zones.at(-1)).toEqual([[0.2, 0.4], [0.95, 1]]);
  });

  it('puts a move by hand together: from where, to where, whether she was walking, how long she had stood', () => {
    const { link, behavior, hands, at } = setup();
    link.emit('message', { t: 'pose', x: 0.25, facing: 'left' });
    at(30_000);
    behavior.emit('command', { id: 'walk', outcome: 'interrupted', x: 0.25, by: 'hand' });
    link.emit('message', { t: 'grab', x: 0.25, at: 0 });
    link.emit('message', { t: 'drop', x: 0.75, vx: 900, vy: 0 });
    expect(hands).toEqual([{ kind: 'throw', from: 500, to: 1500, moving: true, stillSec: 30, at: 30_000 }]);
  });
});
