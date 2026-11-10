/** Quality audit with a fixed gate; failing the gate leaves the detector unchanged and exits nonzero. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findBox } from '../../../core/screen/inputbox.ts';
import { ACCEPT_CONFIDENCE, matches, replay } from './generate.ts';
import { generateGeneralization } from './generalization.ts';

// Seeds and quality gates are fixed independently of detector results.
const seeds = [805306457, 1600000007];
const goals = { hitRate: 0.8, falsePositiveRate: 0.05, overconfident: 0 };
const samples = seeds.flatMap(generateGeneralization);
const results = samples.map(sample => ({ sample, box: findBox(sample) }));
const boxes = new Map(results.map(r => [r.sample.id, r.box]));
const detect = (sample: { id: string }) => boxes.get(sample.id) ?? null;
const metrics = replay(samples, detect);
const groups = Object.fromEntries([...new Set(samples.map(s => s.family))].map(family => [family, replay(samples.filter(s => s.family === family), detect)]));
const mistakes = results.filter(({ sample, box }) => !sample.uncertain && box && box.confidence >= ACCEPT_CONFIDENCE && (!sample.span || !matches(sample, box)));
const sourceHash = createHash('sha256').update(readFileSync(new URL('../../../src/cua/workarea.ts', import.meta.url))).digest('hex');
const passed = metrics.hitRate >= goals.hitRate && metrics.falsePositiveRate <= goals.falsePositiveRate && metrics.overconfident <= goals.overconfident;
const report = {
  protocol: 2, sourceHash, seeds, goals, passed,
  parameters: { width: [480, 1600], height: [140, 340], widthFraction: [0.22, 0.88], heightFraction: [0.08, 0.5], footerFraction: [0.01, 0.38], borderPx: [0.8, 3], contrast: [4, 52], jpegQuality: [65, 95] },
  metrics, groups,
  highConfidenceMistakes: mistakes.map(({ sample, box }) => ({ id: sample.id, codec: sample.codec, width: sample.width, height: sample.height, span: sample.span, predicted: box })),
};
const output = process.argv[2];
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2));
console.info(JSON.stringify({ ...report, highConfidenceMistakes: mistakes.length, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { ...v, failures: undefined }])), metrics: { ...metrics, failures: undefined } }, null, 2));
if (!passed) process.exitCode = 1;
