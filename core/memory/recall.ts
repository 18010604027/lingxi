/**
 * Recall in depths, each depth costing more and reaching further (the depths and where
 * each comes from):
 *
 * - 0, direct: the person's words against the index (BM25 and the formula of recall-score.ts; N.E.K.O.'s hybrid
 *   recall fuses a vector search in by RRF, to come once there are vectors).
 * - 1, association: HippoRAG's personalized PageRank over a graph of blocks and the content words they hold, restarting
 *   at the words said, damping 0.5 (HippoRAG 2's default). A word in many blocks passes little to each (degree
 *   normalisation, ACT-R's fan effect). The nodes are our own content words, not model-extracted entities: no cost.
 * - 2, digging: the model offers other cues (other wordings, people and things involved, rough time), and those are
 *   searched (MemGPT/Letta's agent-driven paging, the model choosing what to look for), within a daily budget.
 *
 * Deeper levels are tried only while shallower ones found nothing; how deep to start is the strength, from the words
 * (talk of the past starts at association). Every level's search goes to the record with its depth, so the record
 * shows when going deeper paid off.
 */
import type { EventMemory } from './events.ts';
import { coverage, words } from './terms.ts';

/** Words that point to the past: a sentence with one is worth recalling harder. */
export const PAST = /记得|记不记得|上次|上回|之前|以前|那天|那次|那时|当时|你说过|我说过|说过的|忘了|去年|上周|上个月|前几天|前天|昨天/;
export const DEPTH = {
  /** Personalized PageRank: restart weight on the cue words is 1 - damping. */
  damping: 0.5, iterations: 12,
  /** Blocks reached in each hop, and content words carried from each block into the second hop. */
  hopBlocks: 20, carried: 6,
  /** A block reached by association must have at least this share of the best association score. */
  assocShare: 0.15,
  /** Model calls for digging, a day. */
  digsPerDay: 20,
};

export type Found = ReturnType<EventMemory['search']>[number] & { depth: number };

export interface RecallOptions {
  /** Other cues for what was said, from the model; without it, depth 2 is not tried. */
  expand?: (said: string) => Promise<string[]>;
  now?: () => number;
}

export class Recall {
  private digs = { day: '', count: 0 };
  private readonly now: () => number;

  constructor(private readonly memory: EventMemory, private readonly opts: RecallOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** How deep to start for what was said: 1 when it speaks of the past, else 0. */
  strength(said: string): 0 | 1 {
    return PAST.test(said) ? 1 : 0;
  }

  /** Depth 0: the words against the index, ranked by the formula; `gate` is the least share of the words a block must cover. */
  direct(said: string, gate: number, source: string): Found[] {
    const found = this.memory.search(said, 6);
    const cov = new Map(this.memory.candidates().map((c) => [c.block, c.features.coverage]));
    const out = found.filter((b) => (cov.get(b.block) ?? coverage(said, blockText(b))) >= gate).map((b) => ({ ...b, depth: 0 }));
    this.memory.scorer?.recorded(said, `${source}@0`, this.memory.candidates(), out.map((b) => ({ block: b.block, text: blockText(b) })));
    return out;
  }

  /** Depth 1: association by personalized PageRank from the words said, over the blocks two hops out. */
  associate(said: string, source: string): Found[] {
    const cues = words(said);
    if (!cues.length) return [];
    // hop 1: blocks holding the words; hop 2: blocks holding what those blocks are most about
    const first = this.memory.search(said, DEPTH.hopBlocks);
    const carried = new Map<string, number>();
    for (const b of first) for (const w of words(blockText(b))) if (!cues.includes(w)) carried.set(w, (carried.get(w) ?? 0) + 1);
    const next = [...carried.entries()].sort((a, b) => b[1] - a[1]).slice(0, DEPTH.carried * 3).map(([w]) => w);
    const second = next.length ? this.memory.search(next.join(' '), DEPTH.hopBlocks) : [];
    const blocks = new Map<number, ReturnType<EventMemory['search']>[number]>();
    for (const b of [...first, ...second]) if (!blocks.has(b.block)) blocks.set(b.block, b);
    if (!blocks.size) return [];
    // the graph: block -- word, words as each block holds them
    const holds = new Map<number, string[]>();
    const holders = new Map<string, number[]>();
    for (const [id, b] of blocks) {
      const ws = words(blockText(b));
      holds.set(id, ws);
      for (const w of ws) holders.set(w, [...(holders.get(w) ?? []), id]);
    }
    const restart = new Map(cues.filter((w) => holders.has(w)).map((w) => [w, 1]));
    if (!restart.size) return [];
    for (const w of restart.keys()) restart.set(w, 1 / restart.size);
    let onWords = new Map(restart);
    let onBlocks = new Map<number, number>();
    for (let i = 0; i < DEPTH.iterations; i++) {
      onBlocks = new Map();
      for (const [w, mass] of onWords) {
        const hs = holders.get(w) ?? [];
        for (const b of hs) onBlocks.set(b, (onBlocks.get(b) ?? 0) + mass / hs.length);
      }
      const back = new Map<string, number>();
      for (const [b, mass] of onBlocks) {
        const ws = holds.get(b) ?? [];
        for (const w of ws) back.set(w, (back.get(w) ?? 0) + mass / ws.length);
      }
      onWords = new Map();
      for (const w of holders.keys()) onWords.set(w, (1 - DEPTH.damping) * (restart.get(w) ?? 0) + DEPTH.damping * (back.get(w) ?? 0));
    }
    const ranked = [...onBlocks.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0]?.[1] ?? 0;
    const out = ranked.filter(([, s]) => s >= best * DEPTH.assocShare).slice(0, 6).map(([id]) => ({ ...blocks.get(id)!, depth: 1 }));
    this.memory.scorer?.recorded(said, `${source}@1`, ranked.slice(0, 20).map(([block, s]) => ({ block, features: { coverage: coverage(said, blockText(blocks.get(block)!)), lineMatch: 0, cardMatch: 0, hitLines: 0, hitCards: 0, ageDays: 0, importance: 0, activation: 0, usedBefore: 0 }, score: s })),
      out.map((b) => ({ block: b.block, text: blockText(b) })));
    return out;
  }

  /** Depth 2: the model's other cues, searched; null when there is no model or the day's budget is spent. */
  async dig(said: string, source: string): Promise<Found[] | null> {
    if (!this.opts.expand) return null;
    const day = new Date(this.now()).toDateString();
    if (this.digs.day !== day) this.digs = { day, count: 0 };
    if (this.digs.count >= DEPTH.digsPerDay) return null;
    this.digs.count++;
    const cues = (await this.opts.expand(said)).filter((c) => c.trim()).slice(0, 8);
    if (!cues.length) return [];
    const query = cues.join(' ');
    const found = this.memory.search(query, 6);
    const cov = new Map(this.memory.candidates().map((c) => [c.block, c.features.coverage]));
    const out = found.filter((b) => (cov.get(b.block) ?? 0) >= 0.3).map((b) => ({ ...b, depth: 2 }));
    this.memory.scorer?.recorded(`${said} ⇒ ${query}`, `${source}@2`, this.memory.candidates(), out.map((b) => ({ block: b.block, text: blockText(b) })));
    return out;
  }
}

/** What a found block says: its cards and the lines shown of it. */
export function blockText(b: { episodes: Array<{ title: string; summary: string }>; lines: Array<{ text: string }> }): string {
  return [...b.episodes.map((e) => `${e.title} ${e.summary}`), ...b.lines.map((l) => l.text)].join(' ');
}

/** The instruction for the model's other cues: short, in the person's language, one per line. */
export const DIG_PROMPT = [
  'Someone said the line below to a desktop pet that keeps company with them. Earlier talk may hold what it refers to,',
  'but in other words. Give up to 8 short search cues, one per line, in the language of the line: other wordings of',
  'what it is about, the people, things and places likely involved, and rough times. Only the cues, nothing else.',
].join('\n');
