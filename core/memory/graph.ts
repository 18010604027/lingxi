/**
 * The relation graph over memory.
 *
 * Nodes are kept and never fade: a line said (`piece`), a person or thing (`entity`), a fact, a summary, a reflection.
 * Relations carry a kind and a strength in 0..1. The associative kinds fade with interaction, not with days: a counter
 * moves one tick per turn of the person, and a relation's strength is read as the strength last written times
 * DECAY^(ticks since). The structural kinds (`mentions`, `source`) say what is in what and do not fade.
 *
 * Unlike events.ts this file is not derived from the log: how often things were recalled together happens only in
 * use. So it lives in its own file and survives a rebuild of the event memory; nodes point back by stable refs.
 *
 * Sources: HeLa-Mem (temporal edge 0.5, co-recall +0.02 capped at 1, multiplicative decay 0.995, prune under 0.01),
 * HippoRAG (mentions and co-occurrence edges), RAPTOR / N.E.K.O. (source links).
 *
 * The slow path's first ring (`addCard`): a topic card of consolidate.ts becomes a `summary`, each of its items a
 * `fact`, each item's subject an `entity`; `source` ties them to the lines they came from, `mentions` ties facts and
 * summaries to their entities, and the entities of one card co-occur (HippoRAG's fact edges, here capped like the rest).
 */
import { join } from 'node:path';
import { openDb, transaction, type Db } from '../sqlite.ts';
import { indexText, matchQuery } from './terms.ts';

export type NodeKind = 'piece' | 'entity' | 'fact' | 'summary' | 'reflection';
export type EdgeKind = 'next' | 'corecall' | 'similar' | 'cooccur' | 'linked' | 'mentions' | 'source';

/** Kinds that say what is in what: true or not, they do not fade with disuse. */
export const STRUCTURAL: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['mentions', 'source']);
/** Strength kept per tick by the associative kinds (HeLa-Mem `global_decay`); about 138 ticks to half. */
export const DECAY = 0.995;
/** Below this an associative relation is dropped by a sweep; its nodes stay, findable by text (C7). */
export const PRUNE = 0.01;
/** A line linked to the one before it in the same block (HeLa-Mem temporal edge). */
export const NEXT_WEIGHT = 0.5;
/** Added between every pair recalled together (HeLa-Mem learning rate in its scripts). */
export const CORECALL_STEP = 0.02;
/** Added between two entities each time a card holds both (HippoRAG counts them; capped at 1 here). To tune with C9. */
export const COOCCUR_STEP = 0.2;

export interface GraphNode { id: number; kind: NodeKind; ref: string; text: string; at: string; importance: number | null }
export interface Neighbor { id: number; kind: EdgeKind; weight: number }
/** A topic card as the graph takes it in: its items' `lines` are line ids of the event memory. */
export interface CardIn {
  id: number; block: number; title: string; summary: string; importance: number; fromLine: number; toLine: number; start: string;
  items: Array<{ kind: string; subject: string; text: string; when: string | null; lines: number[] }>;
}
/** A line of the event memory as the graph takes it in. */
export interface LineIn { id: number; block: number; who: 'person' | 'pet'; kind: string; text: string; ts: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  importance INTEGER
);
CREATE TABLE IF NOT EXISTS edge (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  kind TEXT NOT NULL,
  w REAL NOT NULL,
  tick INTEGER NOT NULL,
  PRIMARY KEY (a, b, kind)
);
CREATE INDEX IF NOT EXISTS edge_b ON edge (b);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(terms, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS vec (node INTEGER PRIMARY KEY, v BLOB NOT NULL);
`;

export class MemoryGraph {
  private readonly db: Db;
  /** Every node's vector, read once and kept up to date (vectors.ts); null until first asked for. */
  private vecs: Map<number, Float32Array> | null = null;

  constructor(dataDir: string, file = join(dataDir, 'memory-graph.sqlite')) {
    this.db = openDb(file);
    this.db.exec(SCHEMA);
  }

  /** Turns of interaction so far: the clock the associative relations fade by. */
  get ticks(): number {
    return Number(this.meta('ticks') ?? 0);
  }

  /** The last line of the event memory taken in; lines after it are caught up with `addLine`. */
  get fedLine(): number {
    return Number(this.meta('fedLine') ?? 0);
  }

  /** The last topic card taken in; cards after it are caught up with `addCard`. */
  get fedCard(): number {
    return Number(this.meta('fedCard') ?? 0);
  }

  /** One turn of the person went by. */
  tick(): void {
    this.setMeta('ticks', String(this.ticks + 1));
  }

  /** The node for `ref`, made when new; returns its id. */
  node(kind: NodeKind, ref: string, text: string, at: string, importance: number | null = null): number {
    const found = this.db.prepare('SELECT id FROM node WHERE ref = ?').get(ref) as { id: number } | undefined;
    if (found) return found.id;
    const id = Number(this.db.prepare('INSERT INTO node (kind, ref, text, at, importance) VALUES (?, ?, ?, ?, ?)').run(kind, ref, text, at, importance).lastInsertRowid);
    this.db.prepare('INSERT INTO node_fts (rowid, terms) VALUES (?, ?)').run(id, indexText(text));
    return id;
  }

  /** Nodes whose text matches any term of `query`, best first, with a match score in 0..1 (bm25, min-max as HippoRAG does). */
  match(query: string, limit = 30): Array<{ id: number; score: number }> {
    const q = matchQuery(query);
    if (!q) return [];
    const rows = this.db.prepare('SELECT rowid AS id, bm25(node_fts) AS s FROM node_fts WHERE node_fts MATCH ? ORDER BY s LIMIT ?').all(q, limit) as Array<{ id: number; s: number }>;
    if (!rows.length) return [];
    // bm25 is negative, lower is better
    const best = -rows[0]!.s, worst = -rows.at(-1)!.s;
    return rows.map((r) => ({ id: r.id, score: best === worst ? 1 : (-r.s - worst) / (best - worst) * 0.9 + 0.1 }));
  }

  /** How many facts, summaries and lines name an entity: the fewer, the more telling it is (HippoRAG's node specificity). */
  mentionCount(id: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM edge WHERE kind = 'mentions' AND (a = ? OR b = ?)`).get(id, id) as { c: number }).c;
  }

  nodeByRef(ref: string): GraphNode | null {
    return (this.db.prepare('SELECT id, kind, ref, text, at, importance FROM node WHERE ref = ?').get(ref) as GraphNode | undefined) ?? null;
  }

  getNode(id: number): GraphNode | null {
    return (this.db.prepare('SELECT id, kind, ref, text, at, importance FROM node WHERE id = ?').get(id) as GraphNode | undefined) ?? null;
  }

  /** Strengthens the relation of `kind` between two nodes by `step`, from its faded strength, capped at 1. */
  link(x: number, y: number, kind: EdgeKind, step: number): void {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const now = this.ticks;
    const row = this.db.prepare('SELECT w, tick FROM edge WHERE a = ? AND b = ? AND kind = ?').get(a, b, kind) as { w: number; tick: number } | undefined;
    const w = Math.min(1, (row ? faded(row.w, kind, now - row.tick) : 0) + step);
    this.db.prepare(`INSERT INTO edge (a, b, kind, w, tick) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (a, b, kind) DO UPDATE SET w = excluded.w, tick = excluded.tick`).run(a, b, kind, w, now);
  }

  /** The current strength of the relation of `kind` between two nodes; 0 when there is none. */
  weight(x: number, y: number, kind: EdgeKind): number {
    const [a, b] = x < y ? [x, y] : [y, x];
    const row = this.db.prepare('SELECT w, tick FROM edge WHERE a = ? AND b = ? AND kind = ?').get(a, b, kind) as { w: number; tick: number } | undefined;
    return row ? faded(row.w, kind, this.ticks - row.tick) : 0;
  }

  /** Every relation of a node at its current strength, strongest first. */
  neighbors(id: number): Neighbor[] {
    const now = this.ticks;
    const rows = this.db.prepare(`SELECT CASE WHEN a = ? THEN b ELSE a END AS other, kind, w, tick FROM edge WHERE a = ? OR b = ?`)
      .all(id, id, id) as Array<{ other: number; kind: EdgeKind; w: number; tick: number }>;
    return rows.map((r) => ({ id: r.other, kind: r.kind, weight: faded(r.w, r.kind, now - r.tick) }))
      .filter((n) => n.weight >= PRUNE)
      .sort((p, q) => q.weight - p.weight);
  }

  /** How much holds a node up: the sum of its relations' current strengths (HeLa-Mem's total edge weight). */
  strength(id: number): number {
    return this.neighbors(id).reduce((s, n) => s + n.weight, 0);
  }

  /** Nodes recalled together: every pair gets a little closer (HeLa-Mem `reinforce_memory_cluster`). */
  coRecalled(ids: number[]): void {
    const unique = [...new Set(ids)];
    transaction(this.db, () => {
      for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) this.link(unique[i]!, unique[j]!, 'corecall', CORECALL_STEP);
    });
  }

  /**
   * The fast path: a line of the event memory becomes a `piece`, linked to the line before it in the same block; a
   * turn of the person (said, answered, touched) moves the clock.
   */
  addLine(l: LineIn): number {
    let id = 0;
    transaction(this.db, () => {
      const known = this.nodeByRef(`line:${l.id}`);
      if (l.id > this.fedLine) this.setMeta('fedLine', String(l.id));
      if (known) { id = known.id; return; }
      id = this.node('piece', `line:${l.id}`, l.text, l.ts);
      if (l.who === 'person') this.tick();
      const prev = this.meta('lastLine');
      if (prev) {
        const [block, node] = prev.split(':').map(Number);
        if (block === l.block && node) this.link(node, id, 'next', NEXT_WEIGHT);
      }
      this.setMeta('lastLine', `${l.block}:${id}`);
    });
    return id;
  }

  /**
   * The slow path's first ring: a card becomes a summary, its items facts, their subjects entities, tied to the lines
   * they came from. Lines the graph does not hold are skipped. Taking in the same card again changes nothing.
   */
  addCard(c: CardIn): number {
    let id = 0;
    transaction(this.db, () => {
      if (c.id > this.fedCard) this.setMeta('fedCard', String(c.id));
      const known = this.nodeByRef(`card:${c.id}`);
      if (known) { id = known.id; return; }
      id = this.node('summary', `card:${c.id}`, `${c.title}：${c.summary}`, c.start, c.importance);
      const piece = (line: number) => this.nodeByRef(`line:${line}`)?.id ?? null;
      for (let line = c.fromLine; line <= c.toLine; line++) {
        const p = piece(line);
        if (p) this.link(id, p, 'source', 1);
      }
      const entities = new Set<number>();
      c.items.forEach((it, i) => {
        const text = it.when ? `${it.text}（${it.when}）` : it.text;
        const fact = this.node('fact', `card:${c.id}:item:${i}`, text, c.start, c.importance);
        this.link(fact, id, 'source', 1);
        for (const line of it.lines) {
          const p = piece(line);
          if (p) this.link(fact, p, 'source', 1);
        }
        const name = it.subject.trim();
        if (!name) return;
        const entity = this.node('entity', `entity:${name}`, name, c.start);
        this.link(fact, entity, 'mentions', 1);
        this.link(id, entity, 'mentions', 1);
        entities.add(entity);
      });
      const list = [...entities];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) this.link(list[i]!, list[j]!, 'cooccur', COOCCUR_STEP);
    });
    return id;
  }

  /**
   * A card the consolidator made again under a new prompt: its summary and facts go, with their relations. The
   * entities stay; they may hold other cards, and the card made anew finds them again.
   */
  dropCard(cardId: number): void {
    transaction(this.db, () => {
      const ids = (this.db.prepare("SELECT id FROM node WHERE ref = ? OR ref LIKE ?").all(`card:${cardId}`, `card:${cardId}:%`) as Array<{ id: number }>).map((r) => r.id);
      for (const n of ids) {
        this.db.prepare('DELETE FROM edge WHERE a = ? OR b = ?').run(n, n);
        this.db.prepare('DELETE FROM node WHERE id = ?').run(n);
        this.db.prepare('DELETE FROM node_fts WHERE rowid = ?').run(n);
        this.db.prepare('DELETE FROM vec WHERE node = ?').run(n);
        this.vecs?.delete(n);
      }
    });
  }

  /** Nodes with no vector yet, oldest first. */
  withoutVector(limit = 200): GraphNode[] {
    return this.db.prepare('SELECT id, kind, ref, text, at, importance FROM node WHERE id NOT IN (SELECT node FROM vec) ORDER BY id LIMIT ?').all(limit) as unknown as GraphNode[];
  }

  setVector(id: number, v: Float32Array): void {
    this.db.prepare('INSERT INTO vec (node, v) VALUES (?, ?) ON CONFLICT (node) DO UPDATE SET v = excluded.v').run(id, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    this.vectors().set(id, v);
  }

  /** Every node's vector by id. */
  vectors(): Map<number, Float32Array> {
    if (!this.vecs) {
      this.vecs = new Map();
      for (const r of this.db.prepare('SELECT node, v FROM vec').all() as Array<{ node: number; v: Uint8Array }>) {
        this.vecs.set(r.node, new Float32Array(r.v.buffer.slice(r.v.byteOffset, r.v.byteOffset + r.v.byteLength)));
      }
    }
    return this.vecs;
  }

  /** The nodes nearest `v` (cosine of unit vectors), of the given kinds, at least `floor`, best first. */
  nearest(v: Float32Array, opts: { kinds: NodeKind[]; k: number; floor: number; except?: number }): Array<{ id: number; sim: number }> {
    const kinds = new Set(opts.kinds);
    const kindOf = new Map((this.db.prepare('SELECT id, kind FROM node').all() as Array<{ id: number; kind: NodeKind }>).map((r) => [r.id, r.kind]));
    const out: Array<{ id: number; sim: number }> = [];
    for (const [id, w] of this.vectors()) {
      if (id === opts.except || !kinds.has(kindOf.get(id)!)) continue;
      let sim = 0;
      for (let i = 0; i < v.length; i++) sim += v[i]! * w[i]!;
      if (sim >= opts.floor) out.push({ id, sim });
    }
    return out.sort((a, b) => b.sim - a.sim).slice(0, opts.k);
  }

  /** Writes faded strengths back and drops associative relations that fell under PRUNE; returns how many went. */
  sweep(): number {
    const now = this.ticks;
    let dropped = 0;
    transaction(this.db, () => {
      const rows = this.db.prepare('SELECT a, b, kind, w, tick FROM edge').all() as Array<{ a: number; b: number; kind: EdgeKind; w: number; tick: number }>;
      for (const r of rows) {
        if (STRUCTURAL.has(r.kind)) continue;
        const w = faded(r.w, r.kind, now - r.tick);
        if (w < PRUNE) { this.db.prepare('DELETE FROM edge WHERE a = ? AND b = ? AND kind = ?').run(r.a, r.b, r.kind); dropped++; }
        else this.db.prepare('UPDATE edge SET w = ?, tick = ? WHERE a = ? AND b = ? AND kind = ?').run(w, now, r.a, r.b, r.kind);
      }
    });
    return dropped;
  }

  counts(): { nodes: number; edges: number } {
    const n = (this.db.prepare('SELECT COUNT(*) AS c FROM node').get() as { c: number }).c;
    const e = (this.db.prepare('SELECT COUNT(*) AS c FROM edge').get() as { c: number }).c;
    return { nodes: n, edges: e };
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

/** A strength `ticks` turns after it was written. */
function faded(w: number, kind: EdgeKind, ticks: number): number {
  return STRUCTURAL.has(kind) ? w : w * DECAY ** Math.max(0, ticks);
}
