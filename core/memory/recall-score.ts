/**
 * How the event memory ranks what it finds, and the record that will teach a better ranking. Each block a search finds
 * gets a few numbers (how much of the query it covers, how well its lines and cards match, how many hits, how old, how
 * important its cards are, how accessible it is), and a score from a formula after ACT-R: what comes to mind is what
 * is most active, and activation is the memory's own accessibility (base level) plus what the cues spread to it:
 *
 *   score = 4 · (0.6 · coverage + 0.4 · relevance) + B + importance / 10
 *
 * coverage: the share of the query's terms the block contains (so one frequent word cannot carry it); relevance: the
 * BM25 match of its lines and cards, scaled to the best among the candidates; B: base-level activation. A small
 * network may replace the formula once the record holds enough labelled searches (not before: little data, poor
 * learning). Every search is written to the judgments (`recall`) with each candidate's numbers and what was shown; the
 * labels come afterwards on their own: which shown blocks the pet's next reply drew on, whether the person then
 * corrected or confirmed it, or nothing at all.
 *
 * Accessibility follows ACT-R's base-level activation: a trace when the block happened and one each time it was
 * actually used (drawn on in a reply), A = ln Σ (age in days)^-d. Being found is not being used: only use strengthens,
 * so a wrong memory is not made stronger by being searched for. Forgetting, as decided (2026-10-26), is this falling,
 * not deletion.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../sqlite.ts';
import type { Judgments } from '../learning/judgments.ts';
import { terms } from './terms.ts';

export const FEATURES = ['coverage', 'lineMatch', 'cardMatch', 'hitLines', 'hitCards', 'ageDays', 'importance', 'activation', 'usedBefore'] as const;
export type Feature = typeof FEATURES[number];
export type Features = Record<Feature, number>;

/** The formula's constants (see the header); `data/recall-weights.json` may override them. */
export const FORMULA = { cue: 4, coverage: 0.6, relevance: 0.4, base: 1, importance: 0.1 };
export type Formula = typeof FORMULA;
/** ACT-R's usual decay. */
const DECAY = 0.5;
/** A reply this soon after a search may draw on it; a correction this soon after the reply is about it. */
const WINDOW_MS = 3 * 60_000;
/** A search nobody drew on within this long is labelled unused. */
const EXPIRE_MS = 10 * 60_000;
/** Shown content and a reply sharing this many terms means the reply drew on it. */
const SHARED = 2;
const CORRECTED = /不对|不是这|记错|错了|没有啊|搞错|不是的|没说过/;
const CONFIRMED = /^(对|是的|没错|对对|嗯对|就是这个|是这样)/;

export interface Candidate { block: number; features: Features }
interface Pending { id: string; at: number; shown: Array<{ block: number; terms: Set<string> }>; repliedAt: number | null; used: number[] }

export class RecallScore {
  private readonly db: Db;
  private readonly formula: Formula;
  private pending: Pending[] = [];

  constructor(private readonly dataDir: string, private readonly judgments: Judgments | null, private readonly now: () => number = Date.now) {
    this.db = openDb(join(dataDir, 'recall.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS use (block INTEGER NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS use_block ON use (block);');
    this.formula = this.readFormula();
  }

  /** `data/recall-weights.json` overrides the formula's constants (a tuning from the record writes it). */
  private readFormula(): Formula {
    const file = join(this.dataDir, 'recall-weights.json');
    if (!existsSync(file)) return { ...FORMULA };
    try { return { ...FORMULA, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Formula>) }; } catch { return { ...FORMULA }; }
  }

  /** Accessibility of a block that happened at `at` (epoch ms): its trace and every use, as ACT-R's base level. */
  activation(block: number, at: number): { activation: number; usedBefore: number } {
    const uses = (this.db.prepare('SELECT at FROM use WHERE block = ?').all(block) as Array<{ at: number }>).map((u) => u.at);
    const now = this.now();
    const days = (t: number) => Math.max(1 / 24, (now - t) / 86_400_000);
    const sum = [at, ...uses].reduce((s, t) => s + days(t) ** -DECAY, 0);
    return { activation: Math.log(sum), usedBefore: uses.length };
  }

  /** Scores candidates found together: relevance is scaled to the best of them. */
  rank(candidates: Candidate[]): Array<Candidate & { score: number }> {
    const match = (f: Features) => f.lineMatch + f.cardMatch;
    const best = Math.max(1e-9, ...candidates.map((c) => match(c.features)));
    const k = this.formula;
    return candidates
      .map((c) => ({ ...c, score: k.cue * (k.coverage * c.features.coverage + k.relevance * match(c.features) / best) + k.base * c.features.activation + k.importance * c.features.importance }))
      .sort((a, b) => b.score - a.score || b.block - a.block);
  }

  /** Writes a search to the record; `shown` are the blocks handed on, best first, with the text that was shown of each. */
  recorded(query: string, source: string, candidates: Array<Candidate & { score?: number }>, shown: Array<{ block: number; text: string }>): string | null {
    if (!this.judgments) return null;
    const id = this.judgments.record({
      kind: 'recall', judge: 'rule:recall-score@1', promptVersion: 'recall-score@1',
      input: { query, source, formula: this.formula, candidates: candidates.slice(0, 20) },
      output: { shown: shown.map((s) => s.block) },
    });
    this.expire();
    this.pending.push({ id, at: this.now(), shown: shown.map((s) => ({ block: s.block, terms: new Set(terms(s.text).filter((t) => t.length >= 2)) })), repliedAt: null, used: [] });
    return id;
  }

  /** The pet said `text`: what of a recent search it drew on is used, and stronger from now on. */
  onPetSaid(text: string): void {
    this.expire();
    const said = new Set(terms(text).filter((t) => t.length >= 2));
    for (const p of this.pending) {
      if (this.now() - p.at > WINDOW_MS || p.repliedAt !== null) continue;
      const used = p.shown.filter((s) => [...s.terms].filter((t) => said.has(t)).length >= SHARED).map((s) => s.block);
      p.repliedAt = this.now();
      p.used = used;
      for (const block of used) this.db.prepare('INSERT INTO use (block, at) VALUES (?, ?)').run(block, this.now());
      this.judgments?.label('recall', p.id, { label: { used, notUsed: p.shown.map((s) => s.block).filter((b) => !used.includes(b)) }, agrees: used.length > 0, source: 'rule', note: 'reply drew on' });
    }
  }

  /** The person said `text`: right after a reply drawn from a search, a correction or a confirmation labels it. */
  onPersonSaid(text: string): void {
    const t = text.trim();
    for (const p of this.pending) {
      if (p.repliedAt === null || !p.used.length || this.now() - p.repliedAt > WINDOW_MS) continue;
      if (CORRECTED.test(t)) this.judgments?.label('recall', p.id, { label: { corrected: true, said: t.slice(0, 200) }, agrees: false, source: 'person' });
      else if (CONFIRMED.test(t)) this.judgments?.label('recall', p.id, { label: { confirmed: true, said: t.slice(0, 200) }, agrees: true, source: 'person' });
      else continue;
      p.repliedAt = -1;
    }
  }

  /** Searches nobody drew on in time are labelled so; done searches are dropped. */
  private expire(): void {
    const now = this.now();
    for (const p of this.pending) {
      if (p.repliedAt === null && now - p.at > EXPIRE_MS) {
        this.judgments?.label('recall', p.id, { label: { used: [] }, agrees: false, source: 'rule', note: 'not drawn on' });
        p.repliedAt = -1;
      }
    }
    this.pending = this.pending.filter((p) => p.repliedAt === null || (p.repliedAt > 0 && now - p.repliedAt <= WINDOW_MS));
  }

  close(): void {
    this.db.close();
  }
}
