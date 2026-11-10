import { describe, expect, it } from 'vitest';
import { buildCatalog, crossAction, dailyChoices } from '../core/behavior/catalog.ts';
import { figureVocab } from '../core/pet/vocab.ts';
import type { Figure } from '../core/behavior/plan.ts';

const figure: Figure = {
  name: 't', refWidth: 462, bodyWidth: 462, nativeFacing: 'left', idle: ['idle-a'], held: ['held-a'], noMirror: [],
  moves: {
    walk: [{ id: 'sidle', clip: 'walk', leadSec: 2, tailSec: 2, minDist: 60, maxDist: 240 }],
    run: [{ id: 'dash', clip: 'run', leadSec: 0, tailSec: 0, minDist: 120, maxDist: 320, segment: { startSec: 2, endSec: 4 } }],
    teleport: false,
    cross: { id: 'hop', clip: 'run', leadSec: 0, tailSec: 0, minDist: 120, maxDist: 320, segment: { startSec: 2, endSec: 4 } },
  },
  words: { wave: ['wave'], sleep: ['sleep'], think: ['think'] },
  vocab: {
    wave: { kind: 'expression', zh: ['挥手'], about: '挥手', when: '打招呼', mood: ['happy'] },
    sleep: { kind: 'motion', zh: ['睡'], about: '睡觉', when: '夜里', mood: ['tired'] },
    think: { kind: 'motion', zh: ['想'], about: '思考', when: '被问住', mood: ['curious'] },
  },
};

describe('the action catalogue the selectors choose from', () => {
  it('maps the pack: idle, held, step walk, continuous run and the cross role', () => {
    const catalog = buildCatalog(figure);
    const by = (id: string) => catalog.find((action) => action.id === id);
    expect(by('idle:idle-a')).toMatchObject({ kind: 'idle', roles: ['idle'] });
    expect(by('held:held-a')).toMatchObject({ kind: 'held', roles: ['held'] });
    expect(by('sidle')).toMatchObject({ kind: 'move', motion: { mode: 'step', clip: 'walk' } });
    expect(by('dash')).toMatchObject({ kind: 'move', motion: { mode: 'continuous', clip: 'run' } });
    expect(by('hop')).toMatchObject({ roles: ['cross'], motion: { mode: 'continuous' } });
    expect(by('wave')).toMatchObject({ kind: 'gesture', mood: ['happy'] });
  });

  it('turns the cross into a teleport when the pack supports instant crossings', () => {
    const catalog = buildCatalog({ ...figure, moves: { ...figure.moves, teleport: true } });
    expect(catalog.find((action) => action.id === 'hop')).toMatchObject({ kind: 'teleport', motion: { mode: 'instant' } });
  });

  it('marks click and daily actions the caller names', () => {
    const catalog = buildCatalog(figure, { click: ['wave'], daily: ['sleep'] });
    expect(catalog.find((action) => action.id === 'wave')).toMatchObject({ kind: 'click', roles: ['click'] });
    expect(catalog.find((action) => action.id === 'sleep')).toMatchObject({ kind: 'daily' });
  });

  it('uses the teleport whenever it is needed and the continuous run only sometimes', () => {
    const teleport = buildCatalog({ ...figure, moves: { ...figure.moves, teleport: true } });
    expect(crossAction(teleport, 0.99)).toMatchObject({ kind: 'teleport' });
    const run = buildCatalog(figure);
    expect(crossAction(run, 0.05)).toMatchObject({ kind: 'move' });
    expect(crossAction(run, 0.5)).toBeNull();
  });

  it('offers daily choices by mood, and everything when no mood is asked for', () => {
    const catalog = buildCatalog(figure);
    expect(dailyChoices(catalog).map((action) => action.id).sort()).toEqual(['sleep', 'think', 'wave']);
    expect(dailyChoices(catalog, ['tired']).map((action) => action.id)).toEqual(['sleep']);
  });

  it('names a move without an id after its clip, and never repeats an id', () => {    const catalog = buildCatalog({ ...figure, moves: { ...figure.moves, walk: [{ clip: 'w', leadSec: 0, tailSec: 0, minDist: 10, maxDist: 20 }] } });
    expect(catalog.filter((action) => action.kind === 'move').map((action) => action.id)).toContain('w');
    const ids = catalog.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows each action\'s mood to the front in its description', () => {
    const vocab = figureVocab(figure);
    expect(vocab.find((word) => word.id === 'sleep')?.about.zh).toContain('心情：tired');
    expect(vocab.find((word) => word.id === 'sidle')?.about.zh ?? '').not.toContain('心情');
  });
});
