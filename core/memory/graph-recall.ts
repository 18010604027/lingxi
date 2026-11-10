/**
 * Searching memory through the relation graph.
 *
 * 1. Starting points: every kind of node is searched together (RAPTOR / MemTree search the flattened tree), by its
 *    words and, once the model is there, by its vector; the two rankings are fused by RRF, k 60 (N.E.K.O.'s hybrid
 *    recall). An entity's weight is divided by how many things name it, so a telling name counts more (HippoRAG).
 * 2. Spreading: the neighbourhood of the starting points, `depth` hops out at the relations' current strengths, gets a
 *    personalized PageRank from them (HippoRAG, damping 0.5).
 * 3. Two ways in (HeLa-Mem): the best direct matches are kept as they are, and what the spreading brings up besides is
 *    added after them, marked as come to mind by association; it never pushes a direct match out. Digging deeper
 *    widens both the neighbourhood and how much association may add.
 * 4. Only what is used is drawn closer (step 5). Each thing shown carries a mark (#m12); the pet's reply names, in a
 *    hidden argument, the marks it drew on (the person's idea: a hidden output while replying), and those, with what the
 *    person just said, are drawn closer (`coRecalled`, HeLa-Mem). If the person then carries on, they are drawn closer
 *    once more; if what they say hits N.E.K.O.'s avoid-the-topic words, not.
 * 5. On its own, when the person speaks, at most two things come to mind (`comesToMind`): direct matches only, never
 *    the talk going on now, and not the same thing again within two hours (N.E.K.O.'s mention suppression).
 *
 * Entities are bridges and starting points, not answers: they are never shown themselves.
 */
import type { ToolDef } from '../contracts.ts';
import type { EventMemory } from './events.ts';
import { stamp } from './events.ts';
import type { GraphNode, MemoryGraph } from './graph.ts';
import { coverage, words } from './terms.ts';
import { cosine } from './embed.ts';
import type { MemoryVectors } from './vectors.ts';

/** Direct matches kept, and most association may add, at depth 1; deeper digs add more. */
export const DIRECT = 6;
export const ASSOCIATED = 3;
/** Share of the walk that goes on along the relations rather than back to the starting points (HippoRAG `damping`). */
export const DAMPING = 0.5;
const ITERATIONS = 30;
/** Most nodes a neighbourhood holds, so a dig into a dense part stays quick. */
const MAX_NODES = 600;
const MAX_CHARS = 2400;
/** RRF's k (N.E.K.O.), and the floor under which a vector match is not a starting point (HeLa-Mem's similarity floor). */
const RRF_K = 60;
const VECTOR_FLOOR = 0.5;
/** A mark can be named as used this long after it was shown; the person carrying on counts this long after the reply. */
const MARK_MS = 10 * 60_000;
const CARRY_MS = 3 * 60_000;

/**
 * What comes to mind on its own: lines at most, characters at most, how like what was said a thing must be (its
 * vector's cosine; without the model, the share of the words it covers), what counts as the talk going on now, and
 * how soon the same may come again.
 */
export const COMES = { lines: 2, chars: 200, coverage: 0.3, similarity: 0.5, freshMs: 30 * 60_000, againMs: 2 * 60 * 60_000 };

/** N.E.K.O.'s words for wanting a topic dropped (NEGATIVE_KEYWORDS_I18N, zh); a hit stops the carry-on strengthening. */
const AVOID = ['别说了', '别再说', '不要再说', '不要说', '别提了', '别提', '别再提', '不要再提', '不想提', '不想再提', '不想说', '不想再说', '别讲', '别再讲', '不要讲', '不要再讲',
  '别聊', '不要聊', '不想聊', '换个话题', '换话题', '聊点别的', '说点别的', '这个不用说了', '闭嘴', '别问了', '不要问了',
  '烦死', '烦人', '好烦', '真烦', '烦透', '心烦', '讨厌', '受不了', '无语'];

export interface Recalled { node: GraphNode; score: number; via: 'direct' | 'association' }

export class GraphRecall {
  /** Marks shown lately: mark → node and when. */
  private readonly marks = new Map<string, { node: number; at: number }>();
  private nextMark = 1;
  /** What the last reply drew on, waiting for the person to carry on. */
  private pending: { ids: number[]; at: number } | null = null;
  /** When each node last came to mind on its own. */
  private readonly told = new Map<number, number>();

  constructor(
    private readonly graph: MemoryGraph,
    private readonly events: EventMemory | null = null,
    private readonly now: () => number = Date.now,
    private readonly vectors: MemoryVectors | null = null,
  ) {}

  /** What comes up for `query`: direct matches first, then what association adds. `depth` 1 to 3; `qv` the query's vector. */
  search(query: string, depth = 1, qv: Float32Array | null = null): Recalled[] {
    const d = Math.max(1, Math.min(3, Math.round(depth)));
    const fused = new Map<number, number>();
    this.graph.match(query, 30 * d).forEach((m, rank) => fused.set(m.id, 1 / (RRF_K + rank + 1)));
    if (qv) {
      this.graph.nearest(qv, { kinds: ['piece', 'fact', 'summary', 'reflection', 'entity'], k: 30 * d, floor: VECTOR_FLOOR })
        .forEach((m, rank) => fused.set(m.id, (fused.get(m.id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    if (!fused.size) return [];
    const best = Math.max(...fused.values());
    const seeds = new Map<number, number>();
    for (const [id, f] of fused) {
      const node = this.graph.getNode(id);
      if (!node) continue;
      const score = f / best;
      seeds.set(id, node.kind === 'entity' ? score / Math.max(1, this.graph.mentionCount(id)) : score);
    }

    // the neighbourhood, hop by hop
    const adj = new Map<number, Array<{ id: number; weight: number }>>();
    let frontier = [...seeds.keys()];
    const seen = new Set(frontier);
    for (let hop = 0; hop < d && frontier.length; hop++) {
      const next: number[] = [];
      for (const id of frontier) {
        const ns = this.graph.neighbors(id);
        adj.set(id, ns.map((n) => ({ id: n.id, weight: n.weight })));
        for (const n of ns) if (!seen.has(n.id) && seen.size < MAX_NODES) { seen.add(n.id); next.push(n.id); }
      }
      frontier = next;
    }
    const ranked = pageRank(seeds, adj);

    const shown = (id: number) => this.graph.getNode(id);
    const direct: Recalled[] = [];
    for (const [id, score] of [...seeds.entries()].sort((a, b) => b[1] - a[1])) {
      const node = shown(id);
      if (!node || node.kind === 'entity') continue;
      direct.push({ node, score, via: 'direct' });
      if (direct.length >= DIRECT) break;
    }
    const taken = new Set(direct.map((r) => r.node.id));
    const associated: Recalled[] = [];
    // association only adds from the top of the spread ranking, as HeLa-Mem looks only inside its natural top-k
    const reach = (DIRECT + ASSOCIATED) * d;
    let looked = 0;
    for (const [id, score] of ranked) {
      const node = shown(id);
      if (!node || node.kind === 'entity') continue;
      if (++looked > reach) break;
      if (taken.has(id)) continue;
      associated.push({ node, score, via: 'association' });
      if (associated.length >= ASSOCIATED * d) break;
    }
    return [...direct, ...associated];
  }

  /** Searches and writes out what came up for the model, each with a mark it can name when its reply draws on it. */
  async recall(query: string, depth = 1): Promise<string> {
    this.events?.sync();
    const found = this.search(query, depth, await this.queryVector(query));
    if (!found.length) return '[none] nothing found';
    let out = '';
    let assocHeader = false;
    for (const r of found) {
      if (r.via === 'association' && !assocHeader) {
        const head = '— also comes to mind (by association):';
        if (out.length + head.length > MAX_CHARS) break;
        out += `\n\n${head}`;
        assocHeader = true;
      }
      const part = `${this.mark(r.node.id)} ${this.describe(r.node)}`;
      if (out.length + part.length > MAX_CHARS) { out += '\n(more not shown)'; break; }
      out += (out ? '\n' : '') + part;
    }
    return out;
  }

  /**
   * The reply drew on these marks: they and what the person last said (`cue`, a node) are drawn closer. Unknown or
   * stale marks are passed over. Returns the nodes taken as used.
   */
  used(marks: string[], cue: number | null = null): number[] {
    const now = this.now();
    const ids = [...new Set(marks.map((m) => this.marks.get(String(m).trim().replace(/^#/, '')))
      .filter((m): m is { node: number; at: number } => !!m && now - m.at <= MARK_MS).map((m) => m.node))];
    if (!ids.length) return [];
    const all = cue !== null && !ids.includes(cue) ? [...ids, cue] : ids;
    this.graph.coRecalled(all);
    this.pending = { ids: all, at: now };
    return ids;
  }

  /** The person spoke: carrying on after a reply that drew on memory draws it closer once more, unless they want the topic dropped. */
  heard(text: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (this.now() - p.at > CARRY_MS) return;
    if (AVOID.some((w) => text.includes(w))) return;
    this.graph.coRecalled(p.ids);
  }

  /** At most two short lines that come to mind on their own for what the person said, or null. Each carries its mark. */
  async comesToMind(said: string): Promise<string | null> {
    if (!words(said).length) return null;
    const qv = await this.queryVector(said);
    const now = this.now();
    const out: string[] = [];
    let chars = 0;
    for (const r of this.search(said, 1, qv)) {
      if (r.via !== 'direct' || out.length >= COMES.lines) continue;
      const at = Date.parse(r.node.at) || 0;
      if (now - at < COMES.freshMs || now - (this.told.get(r.node.id) ?? -Infinity) < COMES.againMs) continue;
      const v = qv ? this.graph.vectors().get(r.node.id) : undefined;
      if (v ? cosine(qv!, v) < COMES.similarity : coverage(said, r.node.text) < COMES.coverage) continue;
      const body = r.node.kind === 'piece' ? `「${r.node.text}」` : r.node.text;
      const line = `${this.mark(r.node.id)} ${stamp(r.node.at)} ${body}`.slice(0, COMES.chars - chars);
      if (line.length < 12) break;
      out.push(line);
      chars += line.length;
      this.told.set(r.node.id, now);
    }
    return out.length ? `[comes to mind, from earlier; use it only if it fits, never read it out; name its mark in pet_say's \`used\` if your line draws on it]\n${out.map((l) => `- ${l}`).join('\n')}` : null;
  }

  private async queryVector(text: string): Promise<Float32Array | null> {
    try { return (await this.vectors?.query(text)) ?? null; } catch (err) { console.warn('[memory] query vector failed', err); return null; }
  }

  private mark(node: number): string {
    const now = this.now();
    for (const [m, v] of this.marks) if (now - v.at > MARK_MS) this.marks.delete(m);
    const m = `m${this.nextMark++}`;
    this.marks.set(m, { node, at: now });
    return `#${m}`;
  }

  /** The `recall` tool over the graph. */
  tool(): ToolDef {
    return {
      ...GRAPH_RECALL_DECL,
      handler: async (args) => await this.recall(String(args.query ?? ''), Number(args.depth ?? 1) || 1),
    };
  }

  private describe(node: GraphNode): string {
    const when = stamp(node.at);
    if (node.kind === 'piece' && this.events) {
      const id = Number(node.ref.slice('line:'.length));
      const at = this.events.line(id);
      if (at) {
        const around = [this.events.line(id - 1), at, this.events.line(id + 1)].filter((l) => l && l.block === at.block);
        return around.map((l) => `${l!.id === at.id ? '»' : ' '} ${stamp(l!.ts)} ${l!.who === 'pet' ? 'you' : 'person'}${l!.kind === 'touch' ? ' (touch)' : ''}: ${l!.text}`).join('\n');
      }
    }
    const label = node.kind === 'summary' ? 'topic' : node.kind;
    return `[${label} ${when}] ${node.text}`;
  }
}

/** Personalized PageRank from the starting points over the neighbourhood, highest first. */
export function pageRank(seeds: Map<number, number>, adj: Map<number, Array<{ id: number; weight: number }>>): Array<[number, number]> {
  const total = [...seeds.values()].reduce((s, v) => s + v, 0) || 1;
  const reset = new Map([...seeds].map(([id, v]) => [id, v / total]));
  let p = new Map(reset);
  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map<number, number>();
    for (const [id, v] of reset) next.set(id, (1 - DAMPING) * v);
    for (const [id, mass] of p) {
      const out = adj.get(id);
      const sum = out?.reduce((s, n) => s + n.weight, 0) ?? 0;
      // mass with nowhere to go returns to the starting points
      if (!out || !sum) { for (const [s, v] of reset) next.set(s, (next.get(s) ?? 0) + DAMPING * mass * v); continue; }
      for (const n of out) next.set(n.id, (next.get(n.id) ?? 0) + DAMPING * mass * n.weight / sum);
    }
    p = next;
  }
  return [...p.entries()].sort((a, b) => b[1] - a[1]);
}

export const GRAPH_RECALL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'recall',
  description: 'Search everything the person and you said and did before, beyond what is in your context. Give words that would '
    + 'appear in it (names, things, places). You get the best matches first (topics, facts, and lines with the ones around '
    + 'them, the matching one marked »), then what comes to mind by association. If it is not there, dig deeper with depth 2 '
    + 'or 3: more association, further out. Use it when the person refers to something from before, or a topic comes back. '
    + "Each thing found starts with a mark (#m12): when what you then say draws on it, name the marks in pet_say's `used`.",
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to look for, Chinese or not.' },
      depth: { type: 'number', description: '1 (default) to 3: how far to follow associations.' },
    },
    required: ['query'],
  },
};
