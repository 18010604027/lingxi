/**
 * Event memory, step three: once a block of conversation has gone quiet, one model call turns it
 * into topic cards (episodes), each with a title, what happened, how much it matters, and the facts, opinions and
 * plans in it with the lines they come from. A block of only touches or a line or two of talk is passed over without a
 * call. An answer cut off by the model's output limit is not thrown away: its complete cards are kept and the model is
 * asked to go on from the line after the last of them, until the whole block is covered; a very long block is taken in
 * windows. Every model answer is cached by prompt version and input, so a rebuild from the event log replays the same
 * cards without paying again; the cache is the only state besides the log, and losing it costs only calls.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Judgments } from '../learning/judgments.ts';
import type { EventMemory, Line } from './events.ts';

export const PROMPT_VERSION = 'cards@3';
/** A block with fewer lines of real talk than this is not worth a call. */
const MIN_TALK = 3;
/** Lines given to the model in one window; a longer block is taken window by window, all of it. */
const WINDOW = 120;
/** Continuations of one window at most, after which what is covered is kept and the rest marked uncovered. */
const MAX_ROUNDS = 8;

export type ItemKind = 'fact' | 'opinion' | 'plan';
export interface CardItem { kind: ItemKind; subject: string; text: string; when: string | null; lines: number[] }
export interface Card { title: string; summary: string; importance: number; from: number; to: number; items: CardItem[] }

const SYSTEM = [
  'You keep the memory of a desktop pet. You get one stretch of conversation between the person and the pet, its lines numbered.',
  'Split it into episodes, one per topic (a stretch that keeps to one matter; small talk with nothing in it is not an episode).',
  'For each episode write, in the language of the conversation:',
  '- title: a few words naming the matter, specific enough to tell it from other days (开题报告的实验部分, not 学习).',
  '- summary: two to four sentences of what happened, self-contained: who, what, and how it was left. Call the person 他 and the pet 我.',
  '- importance: 1 (passing chatter) to 5 (a decision, a plan, a feeling or fact about the person worth remembering for months).',
  '- items: the facts, opinions and plans in it about the person or their life, each one sentence, with the line numbers it comes from;',
  '  subject is the thing it is about (妈妈, 开题, 喝水); when is the date or time it refers to, made absolute (YYYY-MM-DD or',
  '  YYYY-MM-DD HH:MM) from the stamps when the talk says 明天, 周三 and the like, or null.',
  '- from, to: the first and last line numbers of the episode.',
  'Leave out what the pet said about itself unless the person cared. Do not invent anything the lines do not say.',
  'Small talk with nothing in it can share one episode. Write as much as the lines hold; nothing is too long.',
  'Answer with JSON only: {"episodes":[{"title":"","summary":"","importance":1,"from":1,"to":2,"items":[{"kind":"fact","subject":"","text":"","when":null,"lines":[1]}]}]}',
].join('\n');

/** The user message for lines of a block numbered from `first`, with day and time stamps. */
export function promptOf(lines: Line[], first = 1): string {
  const head = first > 1 ? `(Lines before ${first} are already done; cover the lines below.)\n` : '';
  return head + lines.map((l, i) => `${i + first}. [${l.ts.slice(5, 16).replace('T', ' ')}] ${l.who === 'pet' ? '我' : '他'}${l.kind === 'touch' ? '(动作)' : ''}: ${l.text}`).join('\n');
}

/**
 * The complete episode objects of an answer cut off partway (the model ran out of output), in order: each object of
 * the `episodes` array that closes before the cut.
 */
export function salvageEpisodes(answer: string): unknown[] {
  const at = answer.indexOf('"episodes"');
  const open = at < 0 ? -1 : answer.indexOf('[', at);
  if (open < 0) return [];
  const out: unknown[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = open + 1; i < answer.length; i++) {
    const ch = answer[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}') {
      if (--depth === 0 && start >= 0) {
        try { out.push(JSON.parse(answer.slice(start, i + 1))); } catch { /* a damaged object is left out */ }
        start = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return out;
}

/**
 * The cards in a model answer, checked and clamped to the block. An answer cut off partway keeps its complete cards;
 * throws when nothing usable is in it.
 */
export function parseCards(answer: string, count: number): { cards: Card[]; complete: boolean } {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in the answer');
  let raw: { episodes?: unknown };
  let complete = true;
  try { raw = JSON.parse(answer.slice(start, end + 1)) as { episodes?: unknown }; }
  catch (error) {
    const episodes = salvageEpisodes(answer);
    if (!episodes.length) throw error;
    raw = { episodes };
    complete = false;
  }
  if (!Array.isArray(raw.episodes)) throw new Error('no episodes array');
  const line = (n: unknown) => Math.min(count, Math.max(1, Math.round(Number(n) || 1)));
  const cards = raw.episodes.flatMap((e): Card[] => {
    if (!e || typeof e !== 'object') return [];
    const o = e as Record<string, unknown>;
    const title = String(o.title ?? '').trim();
    const summary = String(o.summary ?? '').trim();
    if (!title || !summary) return [];
    const from = line(o.from), to = Math.max(line(o.from), line(o.to));
    const items = (Array.isArray(o.items) ? o.items : []).flatMap((it): CardItem[] => {
      if (!it || typeof it !== 'object') return [];
      const x = it as Record<string, unknown>;
      const kind = x.kind === 'opinion' || x.kind === 'plan' ? x.kind : 'fact';
      const text = String(x.text ?? '').trim();
      if (!text) return [];
      return [{ kind, subject: String(x.subject ?? '').trim(), text, when: typeof x.when === 'string' && x.when.trim() ? x.when.trim() : null,
        lines: (Array.isArray(x.lines) ? x.lines : []).map(line) }];
    });
    return [{ title, summary, importance: Math.min(5, Math.max(1, Math.round(Number(o.importance) || 1))), from, to, items }];
  });
  return { cards, complete };
}

export interface ConsolidatorOptions {
  memory: EventMemory;
  /** Asks the model: system text and user text in, its answer out. */
  ask: (system: string, user: string) => Promise<string>;
  /** The answer cache, JSONL, append-only. */
  cacheFile: string;
  judgments?: Judgments;
  /** Who answers, for the judgment record. */
  judge?: string;
  /** Model calls a day at most: a guard against a runaway loop, not a saving; a block cut short by it resumes the next day. */
  dailyCalls?: number;
  now?: () => Date;
}

export class Consolidator {
  private readonly opts: ConsolidatorOptions;
  private cache: Map<string, string> | null = null;
  private running = false;
  private day = '';
  private calls = 0;

  constructor(opts: ConsolidatorOptions) {
    this.opts = opts;
  }

  /**
   * Turns every closed block not done yet into cards, oldest first, within the day's call budget. Returns how many
   * blocks were done (passed over, from the cache, or by a call).
   */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = (this.opts.now ?? (() => new Date()))();
      const day = now.toISOString().slice(0, 10);
      if (day !== this.day) { this.day = day; this.calls = 0; }
      let done = 0;
      // what an older prompt made, or failed to make, is made again under this one
      this.opts.memory.forgetOtherVersions(PROMPT_VERSION);
      blocks: for (const block of this.opts.memory.closedBlocks(now.getTime())) {
        const all = this.opts.memory.blockLines(block);
        if (all.filter((l) => l.kind !== 'touch').length < MIN_TALK) {
          this.opts.memory.putCards(block, [], 'passed', null);
          done++;
          continue;
        }
        const cards: Array<Card & { lineRefs: Line[] }> = [];
        const notes: string[] = [];
        for (let w = 0; w < all.length; w += WINDOW) {
          const lines = all.slice(w, w + WINDOW);
          let first = 1;
          for (let round = 0; first <= lines.length; round++) {
            if (round >= MAX_ROUNDS) { notes.push(`lines ${w + first}-${w + lines.length} left uncovered after ${MAX_ROUNDS} rounds`); break; }
            const answer = await this.answer(promptOf(lines.slice(first - 1), first));
            // the day's guard was reached: leave the block for the next run, whose cache keeps what was done
            if (answer === null) break blocks;
            let parsed: { cards: Card[]; complete: boolean };
            try { parsed = parseCards(answer, lines.length); }
            catch (error) { notes.push((error as Error).message); break; }
            const fresh = parsed.cards.filter((c) => c.to >= first);
            cards.push(...fresh.map((c) => ({ ...c, from: Math.max(c.from, first), lineRefs: lines })));
            if (parsed.complete) break;
            const reached = Math.max(first - 1, ...fresh.map((c) => c.to));
            // cut off before finishing even one card: there is nothing to go on from
            if (reached < first) { notes.push('cut off before a card was complete'); break; }
            first = reached + 1;
          }
        }
        // the detail starts with the prompt version, so a later version knows to make this block again
        const detail = `${PROMPT_VERSION}${notes.length ? `: ${notes.join('; ')}` : ''}`;
        if (!cards.length && notes.length) this.opts.memory.putCards(block, [], 'failed', detail);
        else this.opts.memory.putCards(block, cards, 'done', detail);
        done++;
      }
      return done;
    } finally {
      this.running = false;
    }
  }

  /** The model's answer to `user`, from the cache or by a call that is then cached and recorded; null past the day's guard. */
  private async answer(user: string): Promise<string | null> {
    const key = createHash('sha256').update(`${PROMPT_VERSION}\n${user}`).digest('hex');
    const hit = this.cached(key);
    if (hit !== undefined) return hit;
    if (this.calls >= (this.opts.dailyCalls ?? 200)) return null;
    this.calls++;
    const answer = await this.opts.ask(SYSTEM, user);
    appendFileSync(this.opts.cacheFile, `${JSON.stringify({ key, prompt: PROMPT_VERSION, answer })}\n`);
    this.cache!.set(key, answer);
    this.opts.judgments?.record({
      kind: 'episode-cards', judge: this.opts.judge ?? 'model', promptVersion: PROMPT_VERSION, input: { lines: user }, output: { answer },
    });
    return answer;
  }

  private cached(key: string): string | undefined {
    if (!this.cache) {
      this.cache = new Map();
      if (existsSync(this.opts.cacheFile)) {
        for (const raw of readFileSync(this.opts.cacheFile, 'utf8').split('\n')) {
          if (!raw.trim()) continue;
          try { const r = JSON.parse(raw) as { key: string; answer: string }; this.cache.set(r.key, r.answer); } catch { /* a cut line */ }
        }
      }
    }
    return this.cache.get(key);
  }
}
