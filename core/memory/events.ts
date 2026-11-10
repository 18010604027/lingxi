/**
 * The front's event memory: a projection of the append-only event log into lines of
 * interaction, cut into blocks at silences, with Chinese full-text search over them and over the topic cards the
 * consolidator makes of closed blocks (consolidate.ts), and the `recall` tool that searches both. No model call here. The log stays the only source of truth: `rebuild` drops this file's tables and
 * reads the log again, and `sync` reads only what came after the last cursor it saw in each run.
 *
 * A line is something the person did or said to the pet (typed, spoke, answered, touched) or something the pet said.
 * The pet's internal notices, its tool activity and its look are left out.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStoreReader, ToolDef } from '../contracts.ts';
import { openDb, transaction, type Db } from '../sqlite.ts';
import { coverage, indexText, matchQuery } from './terms.ts';
import type { Candidate, RecallScore } from './recall-score.ts';
import type { CardIn, LineIn } from './graph.ts';

export type Who = 'person' | 'pet';
export interface Line { run: string; cursor: number; ts: string; who: Who; kind: string; text: string; id?: number; outputId?: string }
/** A topic card made from a block (consolidate.ts), as stored. */
export interface Episode {
  id: number; block: number; title: string; summary: string; importance: number; start: string; end: string;
  items: Array<{ kind: string; subject: string; text: string; when: string | null }>;
}
/** A card as the consolidator hands it in: line numbers counted from 1 within `lineRefs`. */
export interface CardInput {
  title: string; summary: string; importance: number; from: number; to: number;
  items: Array<{ kind: string; subject: string; text: string; when: string | null; lines: number[] }>;
  lineRefs: Line[];
}

/** A silence this long between two lines starts a new block. */
export const BLOCK_GAP_MS = 30 * 60_000;
/** Lines of context shown around each hit inside its block. */
const CONTEXT = 2;
/** Most blocks one recall returns, and most characters of its answer. */
const MAX_BLOCKS = 5;
const MAX_CHARS = 2400;

/**
 * Bumped when the tables change. Everything here is derived from the event log, so an older file is dropped and
 * rebuilt, not migrated. Ids are plain rowids, so a rebuild from scratch numbers everything the same again.
 */
const SCHEMA_VERSION = 2;
const TABLES = ['line', 'seen', 'line_fts', 'block_state', 'episode', 'episode_fts'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS line (
  id INTEGER PRIMARY KEY,
  run TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  ts TEXT NOT NULL,
  who TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  block INTEGER NOT NULL,
  UNIQUE (run, cursor)
);
CREATE INDEX IF NOT EXISTS line_block ON line (block, id);
CREATE TABLE IF NOT EXISTS seen (run TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS line_fts USING fts5(terms, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS block_state (block INTEGER PRIMARY KEY, status TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS episode (
  id INTEGER PRIMARY KEY,
  block INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance INTEGER NOT NULL,
  from_line INTEGER NOT NULL,
  to_line INTEGER NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  items TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS episode_block ON episode (block);
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(terms, tokenize = 'unicode61');
`;

/** The person's words, excluding the pet's feeling and the display label on older events. */
export function personMessageText(e: Record<string, unknown>): string {
  const meta = (e.meta ?? {}) as Record<string, unknown>;
  if (typeof meta.text === 'string') return meta.text.trim();
  const text = String(e.text ?? '');
  const typed = text.match(/(?:^|\n|\]\s*)\[typed\]\s*[^:：\n]{1,80}[:：]\s*([\s\S]*)/);
  if (typed) return typed[1]!.trim();
  return text.replace(/^(\[[^\]]*\]\s*)+/, '').replace(/^[^:：]{1,12}[:：]/, '').trim();
}

/** The line an event makes, or null when the event is not an interaction. */
export function lineOf(e: Record<string, unknown>): Omit<Line, 'run' | 'cursor'> | null {
  const type = String(e.type ?? '');
  const meta = (e.meta ?? {}) as Record<string, unknown>;
  const ts = String(e.ts ?? '');
  const clean = (t: unknown) => String(t ?? '').replace(/^(\[[^\]]*\]\s*)+/, '').trim();
  if (type === 'desktop-pet.self') {
    if (meta.kind !== 'say' && meta.kind !== 'ask') return null;
    const text = clean(e.text);
    return text ? { ts, who: 'pet', kind: String(meta.kind), text } : null;
  }
  if (type === 'pet.speech' && e.origin === 'internal') {
    const text = String(e.text ?? '').trim();
    return text ? { ts, who: 'pet', kind: 'say', text } : null;
  }
  if (type === 'pet.output.receipt' && e.origin === 'internal' && meta.firstPresentation === true) {
    const text = String(e.text ?? '').trim();
    return text ? { ts, who: 'pet', kind: meta.kind === 'ask' ? 'ask' : 'say', text, outputId: String(meta.outputId) } : null;
  }
  // a glance at the screen on the pet's own rhythm (rhythm.ts): what it saw, in a sentence
  if (type === 'glance') {
    const text = clean(e.text).replace(/^\[glance[^\]]*\]\s*/, '');
    return text ? { ts, who: 'pet', kind: 'glance', text } : null;
  }
  if (e.origin !== 'external') return null;
  if (type === 'pet.message' || type === 'desktop-pet.message' || type.endsWith('.typed') || type.includes('voice') || type.includes('speech')) {
    const text = personMessageText(e);
    return text ? { ts, who: 'person', kind: 'said', text } : null;
  }
  if (type === 'pet.answer' || type === 'desktop-pet.answer') {
    const raw = String(e.text ?? '');
    const answer = type === 'pet.answer' && typeof meta.text === 'string'
      ? [typeof meta.question === 'string' ? meta.question.trim() : '', meta.text.trim()].filter(Boolean).join(' → ')
      : clean(raw.replace(/^[\s\S]*?\[answer\]\s*/, ''));
    return answer ? { ts, who: 'person', kind: 'answered', text: answer } : null;
  }
  if (type === 'pet.touch' || type === 'desktop-pet.touch') return { ts, who: 'person', kind: 'touch', text: clean(String(e.text ?? '').replace(/^[\s\S]*?\[touch\]\s*/, '')) };
  return null;
}

/** Project events after a cursor without rescanning the memory index. */
export function historySince(store: EventStoreReader, after: number) {
  const cursor = store.latestCursor();
  if (after > cursor) return { available: true, reset: true, cursor, lines: [] };
  const lines = store.range({ fromCursor: after + 1, toCursor: cursor }).flatMap((event) => {
    const line = lineOf(event as unknown as Record<string, unknown>);
    return line ? [{ ...line, cursor: event.cursor, run: event.run }] : [];
  });
  return { available: true, cursor, lines };
}

export class EventMemory {
  private readonly db: Db;
  private readonly runsDir: string;
  private liveStore: EventStoreReader | null = null;
  /** Ranks what a search finds and keeps the record that teaches it (recall-score.ts); null ranks by text match only. */
  scorer: RecallScore | null = null;
  /** Told of every line added, after it is stored: the relation graph's fast path (graph.ts). */
  onLine: ((l: LineIn) => void) | null = null;
  /** Told of every card stored, and of every card dropped to be made again (graph.ts). */
  onCard: ((c: CardIn) => void) | null = null;
  onCardDropped: ((id: number) => void) | null = null;
  /** The candidates of the last search, with their numbers and scores. */
  private lastCandidates: Array<Candidate & { score: number }> = [];

  constructor(dataDir: string, file = join(dataDir, 'memory.sqlite')) {
    this.runsDir = join(dataDir, 'runs');
    this.db = openDb(file);
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) {
      for (const t of TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    this.db.exec(SCHEMA);
    // Add the channel correlation without dropping existing cards or changing historical row ids.
    if (!(this.db.prepare('PRAGMA table_info(line)').all() as Array<{ name: string }>).some((column) => column.name === 'output_id')) {
      this.db.exec('ALTER TABLE line ADD COLUMN output_id TEXT');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS line_output ON line(output_id) WHERE output_id IS NOT NULL');
  }

  /** Reads what the log gained since the last sync; returns how many lines were added. */
  sync(): number {
    let added = 0;
    if (!existsSync(this.runsDir)) return this.syncLiveStore();
    const runs = readdirSync(this.runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const run of runs) {
      const file = join(this.runsDir, run, 'events.jsonl');
      if (!existsSync(file)) continue;
      const seen = (this.db.prepare('SELECT cursor FROM seen WHERE run = ?').get(run) as { cursor: number } | undefined)?.cursor ?? -1;
      const fresh: Line[] = [];
      let last = seen;
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        let e: Record<string, unknown>;
        // a line cut short by a crash is skipped; the next start repairs the file
        try { e = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
        const cursor = Number(e.cursor);
        if (!Number.isFinite(cursor) || cursor <= seen) continue;
        last = Math.max(last, cursor);
        const l = lineOf(e);
        if (l) fresh.push({ run, cursor, ...l });
      }
      if (last === seen) continue;
      const stored: LineIn[] = [];
      transaction(this.db, () => {
        for (const l of fresh) { const s = this.add(l); if (s) { stored.push(s); added++; } }
        this.db.prepare('INSERT INTO seen (run, cursor) VALUES (?, ?) ON CONFLICT (run) DO UPDATE SET cursor = excluded.cursor').run(run, last);
      });
      if (this.onLine) for (const l of stored) {
        try { this.onLine(l); } catch (err) { console.warn('[memory] graph line failed', err); }
      }
    }
    return added + this.syncLiveStore();
  }

  /** The app's event database joins the existing index without replacing legacy run archives. */
  attachStore(store: EventStoreReader): void { this.liveStore = store; }

  private syncLiveStore(): number {
    if (!this.liveStore) return 0;
    const run = 'lingxi-app-events';
    const seen = (this.db.prepare('SELECT cursor FROM seen WHERE run=?').get(run) as { cursor: number } | undefined)?.cursor ?? 0;
    const latest = this.liveStore.latestCursor();
    if (latest <= seen) return 0;
    const stored: LineIn[] = [];
    transaction(this.db, () => {
      for (const event of this.liveStore!.range({ fromCursor: seen + 1, toCursor: latest })) {
        const line = lineOf(event as unknown as Record<string, unknown>);
        if (!line) continue;
        const saved = this.add({ run, cursor: event.cursor, ...line });
        if (saved) stored.push(saved);
      }
      this.db.prepare('INSERT INTO seen(run,cursor) VALUES(?,?) ON CONFLICT(run) DO UPDATE SET cursor=excluded.cursor').run(run, latest);
    });
    if (this.onLine) for (const line of stored) {
      try { this.onLine(line); } catch (error) { console.warn('[memory] graph line failed', error); }
    }
    return stored.length;
  }

  /** Drops everything derived and reads the whole log again. */
  rebuild(): number {
    transaction(this.db, () => {
      this.db.exec('DELETE FROM line; DELETE FROM seen; DELETE FROM line_fts; DELETE FROM block_state; DELETE FROM episode; DELETE FROM episode_fts;');
    });
    return this.sync();
  }

  /**
   * The blocks whose lines or cards best match `query`, each with its matching cards, its hits and the lines around
   * them, newest block first among equals. A card hit counts double: a card names the matter even when the talk did not.
   */
  search(query: string, limit = MAX_BLOCKS): Array<{ block: number; start: string; end: string; episodes: Episode[]; lines: Array<Line & { hit: boolean }> }> {
    const match = matchQuery(query);
    if (!match) return [];
    const hits = this.db.prepare(`SELECT line.id, line.block, bm25(line_fts) AS score FROM line_fts JOIN line ON line.id = line_fts.rowid
      WHERE line_fts MATCH ? ORDER BY score LIMIT 200`).all(match) as Array<{ id: number; block: number; score: number }>;
    const cardHits = this.db.prepare(`SELECT episode.id, episode.block, bm25(episode_fts) AS score FROM episode_fts JOIN episode ON episode.id = episode_fts.rowid
      WHERE episode_fts MATCH ? ORDER BY score LIMIT 50`).all(match) as Array<{ id: number; block: number; score: number }>;
    const byBlock = new Map<number, { score: number; line: number; card: number; ids: Set<number>; cards: Set<number> }>();
    const entry = (block: number) => { const b = byBlock.get(block) ?? { score: 0, line: 0, card: 0, ids: new Set<number>(), cards: new Set<number>() }; byBlock.set(block, b); return b; };
    // bm25 is negative, lower is better: a block's score sums its hits, so a block that keeps returning to the query ranks up
    for (const h of hits) { const b = entry(h.block); b.score += h.score; b.line -= h.score; b.ids.add(h.id); }
    for (const h of cardHits) { const b = entry(h.block); b.score += 2 * h.score; b.card -= h.score; b.cards.add(h.id); }
    let blocks = [...byBlock.entries()].sort((a, b) => a[1].score - b[1].score || b[0] - a[0]);
    // with a scorer, the formula ranks them (recall-score.ts) and the candidates are kept for the record
    this.lastCandidates = [];
    if (this.scorer) {
      const candidates = blocks.slice(0, 40).map(([block, b]) => {
        const lines = this.blockLines(block), episodes = this.episodes(block);
        const end = Date.parse(lines.at(-1)?.ts ?? '') || Date.now();
        const text = [...lines.map((l) => l.text), ...episodes.map((e) => `${e.title} ${e.summary}`)].join(' ');
        const { activation, usedBefore } = this.scorer!.activation(block, end);
        return {
          block,
          features: {
            coverage: coverage(query, text),
            lineMatch: b.line, cardMatch: b.card, hitLines: b.ids.size, hitCards: b.cards.size,
            ageDays: (Date.now() - end) / 86_400_000, importance: Math.max(0, ...episodes.map((e) => e.importance)), activation, usedBefore,
          },
        };
      });
      const ranked = this.scorer.rank(candidates);
      this.lastCandidates = ranked;
      const at = new Map(ranked.map((c, i) => [c.block, i]));
      blocks = blocks.filter(([block]) => at.has(block)).sort((a, b) => at.get(a[0])! - at.get(b[0])!);
    }
    blocks = blocks.slice(0, limit);
    return blocks.map(([block, { ids, cards }]) => {
      const all = this.blockLines(block) as Array<Line & { id: number }>;
      const episodes = this.episodes(block);
      // the cards that matched, and the cards around the matching lines
      const shown = episodes.filter((e) => cards.has(e.id) || all.some((l) => ids.has(l.id) && l.id >= this.lineOfEpisode(e.id, 'from') && l.id <= this.lineOfEpisode(e.id, 'to')));
      const keep = new Set<number>();
      all.forEach((l, i) => { if (ids.has(l.id)) for (let j = Math.max(0, i - CONTEXT); j <= Math.min(all.length - 1, i + CONTEXT); j++) keep.add(j); });
      const lines = all.filter((_, i) => keep.has(i)).map(({ id, ...l }) => ({ ...l, hit: ids.has(id) }));
      return { block, start: all[0]!.ts, end: all.at(-1)!.ts, episodes: shown, lines };
    });
  }

  /** The candidates of the last search, with their numbers and scores (empty without a scorer). */
  candidates(): Array<Candidate & { score: number }> {
    return this.lastCandidates;
  }

  /** Lines stored after line `id`, oldest first, as the relation graph takes them in (graph.ts). */
  linesAfter(id: number, limit = 5000): LineIn[] {
    return this.db.prepare('SELECT id, block, who, kind, text, ts FROM line WHERE id > ? ORDER BY id LIMIT ?').all(id, limit) as unknown as LineIn[];
  }

  /** Recent interaction lines, oldest first, for a read-only UI projection. */
  recentLines(limit = 50): Line[] {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    return (this.db.prepare('SELECT id, run, cursor, ts, who, kind, text, output_id AS outputId FROM line ORDER BY id DESC LIMIT ?').all(n) as unknown as Line[]).reverse();
  }

  /** The latest line of the person or of the pet, or null. */
  lastLine(who: Who): (Line & { block: number }) | null {
    return (this.db.prepare('SELECT id, run, cursor, ts, who, kind, text, block FROM line WHERE who = ? ORDER BY id DESC LIMIT 1').get(who) as unknown as (Line & { block: number }) | undefined) ?? null;
  }

  /** One line by its id, or null. */
  line(id: number): (Line & { block: number }) | null {
    return (this.db.prepare('SELECT id, run, cursor, ts, who, kind, text, block FROM line WHERE id = ?').get(id) as unknown as (Line & { block: number }) | undefined) ?? null;
  }

  /** The lines of a block, oldest first, with their ids. */
  blockLines(block: number): Line[] {
    return this.db.prepare('SELECT id, run, cursor, ts, who, kind, text FROM line WHERE block = ? ORDER BY id').all(block) as unknown as Line[];
  }

  /** Blocks quiet for the block gap by `now` (epoch ms) and not yet turned into cards, oldest first. */
  closedBlocks(now: number): number[] {
    const rows = this.db.prepare(`SELECT block, MAX(ts) AS last FROM line WHERE block NOT IN (SELECT block FROM block_state)
      GROUP BY block ORDER BY block`).all() as Array<{ block: number; last: string }>;
    return rows.filter((r) => now - Date.parse(r.last) >= BLOCK_GAP_MS).map((r) => r.block);
  }

  /** Stores the cards of a block and marks it handled: `done`, `passed` (not worth a call) or `failed`. */
  putCards(block: number, cards: CardInput[], status: 'done' | 'passed' | 'failed', detail: string | null): void {
    const stored: number[] = [];
    transaction(this.db, () => {
      for (const c of cards) {
        const from = c.lineRefs[c.from - 1] ?? c.lineRefs[0]!;
        const to = c.lineRefs[c.to - 1] ?? c.lineRefs.at(-1)!;
        const items = c.items.map(({ lines, ...it }) => ({ ...it, lines: lines.map((n) => c.lineRefs[n - 1]?.id).filter((x) => x !== undefined) }));
        const r = this.db.prepare(`INSERT INTO episode (block, title, summary, importance, from_line, to_line, start, end, items)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(block, c.title, c.summary, c.importance, from.id!, to.id!, from.ts, to.ts, JSON.stringify(items));
        stored.push(Number(r.lastInsertRowid));
        const text = [c.title, c.summary, ...c.items.map((i) => `${i.subject} ${i.text}`)].join(' ');
        this.db.prepare('INSERT INTO episode_fts (rowid, terms) VALUES (?, ?)').run(r.lastInsertRowid, indexText(text));
      }
      this.db.prepare('INSERT INTO block_state (block, status, detail, at) VALUES (?, ?, ?, ?) ON CONFLICT (block) DO UPDATE SET status = excluded.status, detail = excluded.detail, at = excluded.at')
        .run(block, status, detail, new Date().toISOString());
    });
    if (this.onCard) for (const id of stored) {
      const card = this.cardsAfter(id - 1, 1)[0];
      try { if (card) this.onCard(card); } catch (err) { console.warn('[memory] graph card failed', err); }
    }
  }

  /** Cards stored after card `id`, oldest first, as the relation graph takes them in (graph.ts). */
  cardsAfter(id: number, limit = 1000): CardIn[] {
    return (this.db.prepare('SELECT id, block, title, summary, importance, from_line, to_line, start, items FROM episode WHERE id > ? ORDER BY id LIMIT ?')
      .all(id, limit) as Array<Record<string, unknown>>)
      .map((r) => ({
        id: Number(r.id), block: Number(r.block), title: String(r.title), summary: String(r.summary), importance: Number(r.importance),
        fromLine: Number(r.from_line), toLine: Number(r.to_line), start: String(r.start), items: JSON.parse(String(r.items)) as CardIn['items'],
      }));
  }

  /**
   * Lets every block made into cards or failed under another prompt version than `version` be done again: their cards
   * go and their state is cleared. Blocks passed over without a call stay as they are.
   */
  forgetOtherVersions(version: string): number {
    let n = 0;
    let dropped: number[] = [];
    transaction(this.db, () => {
      dropped = [];
      const stale = (this.db.prepare("SELECT block FROM block_state WHERE status <> 'passed' AND (detail IS NULL OR substr(detail, 1, ?) <> ?)")
        .all(version.length, version) as Array<{ block: number }>).map((r) => r.block);
      for (const block of stale) {
        for (const e of this.db.prepare('SELECT id FROM episode WHERE block = ?').all(block) as Array<{ id: number }>) {
          this.db.prepare('DELETE FROM episode_fts WHERE rowid = ?').run(e.id);
          dropped.push(e.id);
        }
        this.db.prepare('DELETE FROM episode WHERE block = ?').run(block);
        this.db.prepare('DELETE FROM block_state WHERE block = ?').run(block);
      }
      n = stale.length;
    });
    if (this.onCardDropped) for (const id of dropped) {
      try { this.onCardDropped(id); } catch (err) { console.warn('[memory] graph card drop failed', err); }
    }
    return n;
  }

  /** Cards that began at or after `since` (epoch ms), oldest first. */
  episodesSince(since: number): Episode[] {
    return (this.db.prepare('SELECT id, block, title, summary, importance, start, end, items FROM episode ORDER BY from_line').all() as Array<Record<string, unknown>>)
      .filter((r) => Date.parse(String(r.start)) >= since)
      .map((r) => ({ ...(r as unknown as Episode), items: JSON.parse(String(r.items)) as Episode['items'] }));
  }

  /** The cards of a block, in order. */
  episodes(block: number): Episode[] {
    return (this.db.prepare('SELECT id, block, title, summary, importance, start, end, items FROM episode WHERE block = ? ORDER BY from_line').all(block) as Array<Record<string, unknown>>)
      .map((r) => ({ ...(r as unknown as Episode), items: JSON.parse(String(r.items)) as Episode['items'] }));
  }

  private lineOfEpisode(id: number, end: 'from' | 'to'): number {
    return (this.db.prepare(`SELECT ${end}_line AS n FROM episode WHERE id = ?`).get(id) as { n: number }).n;
  }

  /** The front's tool for searching what was said and done before. */
  recallTool(): ToolDef {
    return {
      ...RECALL_DECL,
      handler: async (args) => {
        this.sync();
        const query = String(args.query ?? '');
        const found = this.search(query);
        if (!found.length) {
          this.scorer?.recorded(query, 'recall-tool', [], []);
          return '[none] nothing found';
        }
        let out = '';
        const shown: Array<{ block: number; text: string }> = [];
        for (const b of found) {
          const cards = b.episodes.map((e) => `[${e.title}] ${e.summary}${e.items.length ? `\n  ${e.items.map((i) => `${i.kind}: ${i.text}${i.when ? ` (${i.when})` : ''}`).join('\n  ')}` : ''}`);
          const part = [`— ${stamp(b.start)} to ${stamp(b.end)}`, ...cards, ...b.lines.map((l) => `${l.hit ? '»' : ' '} ${stamp(l.ts).slice(-5)} ${l.who === 'pet' ? 'you' : 'person'}${l.kind === 'touch' ? ' (touch)' : ''}: ${l.text}`)].join('\n');
          if (out.length + part.length > MAX_CHARS) { out += `\n(more matches not shown)`; break; }
          out += (out ? '\n\n' : '') + part;
          shown.push({ block: b.block, text: part });
        }
        // the search, its candidates and what was shown, for the record the ranking learns from
        this.scorer?.recorded(query, 'recall-tool', this.lastCandidates, shown);
        return out;
      },
    };
  }

  /** When the latest line written before `before` (epoch ms) happened, epoch ms; null when there is none. */
  lastLineBefore(before: number): number | null {
    let latest: number | null = null;
    for (const r of this.db.prepare('SELECT ts FROM line ORDER BY id DESC LIMIT 50').all() as Array<{ ts: string }>) {
      const t = Date.parse(r.ts);
      if (t < before && (latest === null || t > latest)) latest = t;
    }
    return latest;
  }

  close(): void {
    this.scorer?.close();
    this.db.close();
  }

  private add(l: Line): LineIn | null {
    const prev = this.db.prepare('SELECT ts, block FROM line ORDER BY ts DESC, id DESC LIMIT 1').get() as { ts: string; block: number } | undefined;
    const gap = prev ? Date.parse(l.ts) - Date.parse(prev.ts) : Infinity;
    const block = prev && gap < BLOCK_GAP_MS ? prev.block : (prev?.block ?? 0) + 1;
    const r = this.db.prepare('INSERT OR IGNORE INTO line (run, cursor, ts, who, kind, text, block, output_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(l.run, l.cursor, l.ts, l.who, l.kind, l.text, block, l.outputId ?? null);
    if (!r.changes) return null;
    this.db.prepare('INSERT INTO line_fts (rowid, terms) VALUES (?, ?)').run(r.lastInsertRowid, indexText(l.text));
    return { id: Number(r.lastInsertRowid), block, who: l.who, kind: l.kind, text: l.text, ts: l.ts };
  }
}

export const RECALL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'recall',
  description: 'Search everything the person and you said and did before, beyond what is in your context. Give words that would '
    + 'appear in it (names, things, places); you get the stretches of conversation that match: the topic cards made of them '
    + '([title] summary, with facts, opinions and plans) when there are any, then the lines, oldest first, the matching ones '
    + 'marked ». Use it when the person refers to something from before, or a topic comes back.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words to look for, Chinese or not.' } },
    required: ['query'],
  },
};
export const RECALL_SUMMARY = { zh: '在以前所有聊过、做过的事里搜索。', en: 'Searches everything said and done before.' };

/** `2026-10-26T10:14:12+08:00` as `10-26 10:14`, in the time the event was written. */
export function stamp(ts: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ts);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : ts;
}
