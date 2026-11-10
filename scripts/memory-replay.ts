/**
 * Replays a copy of the pet's memory into the relation graph and runs searches on it, to look at what comes up.
 * Point it at a COPY of home/companion/data (memory.sqlite), never the live one: the graph file is written there.
 * Usage: npx tsx scripts/memory-replay.ts <dir> <query>...
 */
import { EventMemory } from '../core/memory/events.ts';
import { MemoryGraph } from '../core/memory/graph.ts';
import { GraphRecall } from '../core/memory/graph-recall.ts';
const dir = process.argv[2]!;
const mem = new EventMemory(dir);
const g = new MemoryGraph(dir);
for (let b = mem.linesAfter(g.fedLine); b.length; b = mem.linesAfter(g.fedLine)) for (const l of b) g.addLine(l);
for (let b = mem.cardsAfter(g.fedCard); b.length; b = mem.cardsAfter(g.fedCard)) for (const c of b) g.addCard(c);
console.log('counts', g.counts(), 'ticks', g.ticks);
const r = new GraphRecall(g, mem);
for (const q of process.argv.slice(3)) {
  console.log(`\n===== ${q}`);
  for (const x of r.search(q, 1)) console.log(x.via === 'direct' ? 'D' : 'A', x.node.kind, x.score.toFixed(3), x.node.text.slice(0, 60));
}
