/**
 * The figure's words as the front writes them (script.ts `VocabWord`): `walk`, `run` and the action words, with the
 * names and looks the figure gives them (the pack's `vocab`). A word the figure has clips for but no entry is still
 * known by its id.
 */
import type { Figure } from '../behavior/plan.ts';
import type { VocabWord } from './script.ts';

export function figureVocab(figure: Figure): VocabWord[] {
  // every way of moving the pack names is a word of its own, so the front can pick one on purpose
  const moves = [...figure.moves.walk, ...figure.moves.run].filter((m) => m.id);
  const ids = ['walk', 'run', ...moves.map((m) => m.id!), ...Object.keys(figure.words)];
  return ids.map((id) => {
    const v = figure.vocab?.[id];
    const move = moves.find((m) => m.id === id);
    const mood = v?.mood ?? move?.mood ?? [];
    const about = v?.about ?? move?.about ?? '';
    return {
      id,
      kind: v?.kind ?? 'motion',
      names: { zh: v?.zh ?? move?.zh ?? [], ...((v?.en ?? move?.en) ? { en: (v?.en ?? move?.en)! } : {}) },
      // the moods travel with the look the front reads, so it can choose by how the action feels
      about: { zh: mood.length ? `${about}（心情：${mood.join('、')}）` : about },
      // when the front should reach for it; the pack says it, the table shows it
      ...((v?.when ?? move?.when) ? { when: { zh: (v?.when ?? move?.when)!, en: v?.whenEn ?? move?.when ?? '' } } : {}),
      seconds: 0,
    };
  });
}
