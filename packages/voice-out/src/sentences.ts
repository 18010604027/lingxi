import type { Sentence } from './types.ts';

export const MAX_SENTENCE_CHARACTERS = 2000;

/** Keeps source text and offsets intact, including separators; character offsets count Unicode code points. */
export function splitSentences(text: string, maxCharacters = MAX_SENTENCE_CHARACTERS): Sentence[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new RangeError('maxCharacters must be positive');
  if (!text.trim()) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const result: Sentence[] = [];
  let position = 0, leading = '';
  for (const paragraph of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    for (const { segment } of segmenter.segment(paragraph)) {
      const characters = Array.from(segment);
      for (let i = 0; i < characters.length; i += maxCharacters) {
        const chunk = characters.slice(i, i + maxCharacters).join('');
        const end = position + Array.from(chunk).length;
        if (!chunk.trim()) {
          if (result.length) { result.at(-1)!.text += chunk; result.at(-1)!.endCharacter = end; }
          else leading += chunk;
        } else {
          result.push({ text: leading + chunk, startCharacter: position - Array.from(leading).length, endCharacter: end });
          leading = '';
        }
        position = end;
      }
    }
  }
  return result;
}
