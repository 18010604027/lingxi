/**
 * Calibrates the mode threshold (core/daily/scene.ts `SAME`) on kept bottom-band samples: for every part seen in more
 * than one sample, the structure distances between its looks in time order, and the structures themselves. Reads the samples where they are
 * (the data folder's workarea-samples); writes nothing.
 * Usage: npx tsx scripts/scene-calibrate.ts <workarea-samples dir>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PET_H, partKey, rowsOf, structure, structureDistance, type Gray, type Structure } from '../core/daily/scene.ts';

const jpeg = createRequire(import.meta.url)('jpeg-js') as { decode: (b: Buffer, o: object) => { width: number; height: number; data: Uint8Array } };
const dir = process.argv[2]!;

interface S { at: number; key: string; app: string; st: Structure }
const looks: S[] = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('-strip.json')).sort()) {
  const meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { display: { index: number; x: number; y?: number; width: number; height?: number }; stripTop: number;
    stretches: Array<{ from: number; to: number; app: string | null; rect: { y: number; height: number } }> };
  const img = jpeg.decode(readFileSync(join(dir, f.replace(/\.json$/, '.jpg'))), { useTArray: true });
  const gray: Gray = { width: img.width, height: img.height, data: new Uint8Array(img.width * img.height) };
  for (let i = 0; i < gray.data.length; i++) gray.data[i] = img.data[i * 4]!;
  const px = (x: number) => ((x - meta.display.x) / meta.display.width) * img.width;
  for (const s of meta.stretches) {
    const key = partKey(meta.display, s.app, s.from, s.to, s.rect);
    // only the strip the pet's body would cover: its height up from the window's bottom edge (the taskbar below is cut off)
    const k = img.width / meta.display.width, bottom = Math.min(img.height, Math.round((s.rect.y + s.rect.height - meta.stripTop) * k));
    const zone = rowsOf(gray, bottom - PET_H * k, PET_H * k);
    // older samples did not keep where the pet was, so its body is not masked here (it is at run time)
    looks.push({ at: Number(f.split('-')[0]), key, app: s.app ?? '?', st: structure(zone, px(s.from), px(s.to)) });
  }
}
const byPart = new Map<string, S[]>();
for (const l of looks) byPart.set(l.key, [...(byPart.get(l.key) ?? []), l]);
const all: number[] = [];
for (const [key, ls] of byPart) {
  if (ls.length < 2) continue;
  const consecutive = ls.slice(1).map((l, i) => structureDistance(ls[i]!.st, l.st));
  all.push(...consecutive);
  console.log(`${key} (${ls.length} looks) consecutive structure distances: ${consecutive.join(' ')}`);
  for (const l of ls.slice(0, 30)) console.log(`   ${l.at} cols ${l.st.cols.map((c) => (c * 100).toFixed(1)).join(',')} | rows ${l.st.rows.map((r) => `${(r.y * 100).toFixed(0)}[${(r.from * 100).toFixed(0)}-${(r.to * 100).toFixed(0)}]`).join(',')}`);
}
const cross: number[] = [];
const keys = [...byPart.keys()];
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) cross.push(structureDistance(byPart.get(keys[i]!)![0]!.st, byPart.get(keys[j]!)![0]!.st));
const hist = (xs: number[]) => { const h = new Map<number, number>(); for (const x of xs) h.set(x, (h.get(x) ?? 0) + 1); return [...h].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}:${n}`).join('  '); };
console.log(`\nwithin a part, consecutive: ${hist(all)}`);
console.log(`between different parts:   ${hist(cross)}`);
