/**
 * Vectors in the relation graph, on the slow path: nodes get a vector a batch at a
 * time, and each new one is linked to the nodes it is like.
 *
 * - Lines, facts, summaries and reflections: the 5 most similar over 0.5 get a `similar` relation of similarity × 0.3,
 *   when they have none yet (HeLa-Mem's consolidation step 0).
 * - Entities: other entities at 0.8 or more are the same thing under another name, `similar` at the similarity
 *   (HippoRAG's synonymy edges; its rule that skips names without Latin letters or digits is left out, so Chinese
 *   names count).
 *
 * The model is fetched once from ModelScope into the models folder (embed.ts) and loaded on first use; without it,
 * memory works by words alone, as before.
 */
import type { NodeKind, MemoryGraph } from './graph.ts';
import type { Embedder } from './embed.ts';

const CONTENT: NodeKind[] = ['piece', 'fact', 'summary', 'reflection'];
export const SIMILAR = { k: 5, floor: 0.5, scale: 0.3 };
export const SYNONYM = { k: 10, floor: 0.8 };

export class MemoryVectors {
  /**
   * `embedder` may fetch and load the model (the background pass waits for it); `loaded` gives it only when it is
   * already loaded, so a reply never waits on a download.
   */
  constructor(private readonly graph: MemoryGraph, private readonly embedder: () => Promise<Embedder | null>, private readonly loaded: () => Embedder | null = () => null) {}

  /** Gives up to `limit` nodes their vectors and their likeness relations; returns how many. */
  async pass(limit = 200): Promise<number> {
    const nodes = this.graph.withoutVector(limit);
    if (!nodes.length) return 0;
    const e = await this.embedder();
    if (!e) return 0;
    const vs = await e.embed(nodes.map((n) => n.text));
    nodes.forEach((n, i) => {
      const v = vs[i]!;
      this.graph.setVector(n.id, v);
      if (n.kind === 'entity') {
        for (const m of this.graph.nearest(v, { kinds: ['entity'], k: SYNONYM.k, floor: SYNONYM.floor, except: n.id })) {
          if (!this.graph.weight(n.id, m.id, 'similar')) this.graph.link(n.id, m.id, 'similar', m.sim);
        }
      } else {
        for (const m of this.graph.nearest(v, { kinds: CONTENT, k: SIMILAR.k, floor: SIMILAR.floor, except: n.id })) {
          if (!this.graph.weight(n.id, m.id, 'similar')) this.graph.link(n.id, m.id, 'similar', m.sim * SIMILAR.scale);
        }
      }
    });
    return nodes.length;
  }

  /** The vector of a query, or null while the model is not loaded. */
  async query(text: string): Promise<Float32Array | null> {
    const e = this.loaded();
    return e ? (await e.embed([text]))[0]! : null;
  }
}
