/**
 * What comes to mind on its own: when the person says something, the event memory is searched with their words and at
 * most two short lines from earlier talk ride in with the turn, so the front can draw on the past without being asked
 * to look it up. How hard it tries is the strength (recall.ts): direct matching first (at least a third of their
 * content words); when the words speak of the past, association too; and when that finds nothing either, digging with
 * the model's help in the background, whose find comes in later as "just came to mind" (a delayed recall). Never the
 * talk going on now (it is in the context already), and not the same thing again soon (N.E.K.O.'s mention
 * suppression). Each search is written to the record with its depth, so how it is taken up teaches the ranking
 * (recall-score.ts).
 */
import type { EventMemory } from './events.ts';
import { Recall, type Found } from './recall.ts';
import { words } from './terms.ts';

export const HINTS = {
  /** Lines at most, and characters at most across them. */
  lines: 2, chars: 200,
  /** The share of the words' content words a block must contain to come to mind directly. */
  coverage: 0.3,
  /** Words with fewer content words than this bring nothing to mind (「嗯」「好的」 have none). */
  minTerms: 1,
  /** Talk this recent is the conversation going on, already in the context. */
  freshMs: 30 * 60_000,
  /** The same block does not come to mind again within this long. */
  againMs: 2 * 60 * 60_000,
};

/** Month-day and time of an ISO stamp, as the front reads it. */
const when = (ts: string) => ts.slice(5, 16).replace('T', ' ');

export interface HintOptions {
  now?: () => number;
  /** Other cues from the model, for digging; without it nothing is dug for. */
  expand?: (said: string) => Promise<string[]>;
  /** Receives what digging found after the turn went on. */
  late?: (text: string) => void;
}

export class Hints {
  private readonly told = new Map<number, number>();
  private readonly now: () => number;
  private readonly late: ((text: string) => void) | null;
  readonly recall: Recall;

  constructor(memory: EventMemory, opts: HintOptions | (() => number) = {}) {
    const o: HintOptions = typeof opts === 'function' ? { now: opts } : opts;
    this.now = o.now ?? Date.now;
    this.late = o.late ?? null;
    this.recall = new Recall(memory, { now: this.now, ...(o.expand ? { expand: o.expand } : {}) });
  }

  /** The lines that come to mind for what the person said, or null when nothing does now. */
  for(said: string): string | null {
    if (words(said).length < HINTS.minTerms) return null;
    const strength = this.recall.strength(said);
    let found = this.fresh(this.recall.direct(said, HINTS.coverage, 'hint'));
    if (!found.length && strength >= 1) found = this.fresh(this.recall.associate(said, 'hint'));
    if (!found.length && strength >= 1 && this.late) {
      // worth trying harder, but not worth keeping the reply waiting: dig in the background, and say it when it comes
      void this.recall.dig(said, 'hint').then((dug) => {
        const lines = dug ? this.pick(this.fresh(dug)) : [];
        if (lines.length) this.late?.(`[just came to mind, about what they said a moment ago (「${said.slice(0, 30)}」); use it only if it still fits]\n${lines.map((l) => `- ${l}`).join('\n')}`);
      }).catch(() => {});
    }
    const lines = this.pick(found);
    return lines.length ? `[comes to mind, from earlier talk; use it only if it fits, never read it out]\n${lines.map((l) => `- ${l}`).join('\n')}` : null;
  }

  /** Leaves out the talk going on now and what came to mind lately. */
  private fresh(found: Found[]): Found[] {
    const now = this.now();
    return found.filter((b) => now - (Date.parse(b.end) || 0) >= HINTS.freshMs && now - (this.told.get(b.block) ?? -Infinity) >= HINTS.againMs);
  }

  /** At most two lines within the length, each a card's gist or the line that matched; marks them told. */
  private pick(found: Found[]): string[] {
    const out: string[] = [];
    let chars = 0;
    for (const b of found) {
      if (out.length >= HINTS.lines) break;
      const card = b.episodes[0];
      const hit = b.lines.find((l) => l.hit) ?? b.lines[0];
      const body = card ? `${card.title}：${card.summary}` : hit ? `${hit.who === 'pet' ? 'you said' : 'they said'}「${hit.text}」` : '';
      if (!body) continue;
      const line = `${when(b.start)} ${body}`.slice(0, HINTS.chars - chars);
      if (line.length < 12) break;
      out.push(line);
      chars += line.length;
      this.told.set(b.block, this.now());
    }
    return out;
  }
}
