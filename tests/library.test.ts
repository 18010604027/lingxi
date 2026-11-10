import { describe, expect, it } from 'vitest';
import { checkLibrary, libraryFromFigure, applyLibrary } from '../core/behavior/library.ts';

describe('the action library is the person\'s data', () => {
  it('keeps good entries and drops bad ones with a reason', () => {
    const { entries, problems } = checkLibrary([
      { id: 'wave', clips: ['挥手'], looks: '抬手挥两下' },
      { id: 'bad id', clips: ['x'] },
      { id: 'noc', clips: [] },
      { id: 'wave', clips: ['again'] },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['wave']);
    expect(problems).toHaveLength(3);
  });

  it('treats an empty library as valid', () => {
    expect(checkLibrary([])).toEqual({ entries: [], problems: [] });
    expect(checkLibrary(undefined)).toEqual({ entries: [], problems: [] });
    expect(checkLibrary('nope').problems).toHaveLength(1);
  });

  it('seeds from the pack only as a starting point', () => {
    expect(libraryFromFigure({ words: { wave: ['w'] }, vocab: { wave: { about: '抬手', when: '见面' } } }))
      .toEqual([{ id: 'wave', clips: ['w'], looks: '抬手', when: '见面' }]);
  });

  it('lets avoid entries decide how the body crosses', () => {
    const figure = { words: { wave: ['w'] } as Record<string, string[]>, vocab: {}, moves: { teleport: false } as { teleport?: boolean; cross?: { clip: string; leadSec: number; tailSec: number; minDist: number; maxDist: number } } };
    applyLibrary(figure, [
      { id: 'wave', clips: ['w'] },
      { id: 'blink', clips: ['flash'], use: 'avoid', frequency: 'high', motion: { mode: 'instant' } },
      { id: 'dash', clips: ['run'], use: 'avoid', frequency: 'low', motion: { mode: 'continuous', clip: 'run', leadSec: 1, tailSec: 1, minDist: 10, maxDist: 900 } },
    ]);
    expect(figure.moves.teleport).toBe(true);
    expect(figure.moves.cross).toMatchObject({ clip: 'run', leadSec: 1, tailSec: 1, maxDist: 900 });
    expect(figure.words.wave).toEqual(['w']);
    expect(figure.words.blink).toEqual(['flash']);
  });
});
