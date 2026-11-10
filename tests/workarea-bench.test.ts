import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { findBox, findInputSpan } from '../core/screen/inputbox.ts';
import { ACCEPT_CONFIDENCE, generateSamples, matches, replay, type Sample } from './fixtures/workarea/generate.ts';
import { loadPrivateSamples, type PrivateLabel } from './fixtures/workarea/load-private.ts';

const training = generateSamples([1, 2, 3, 4]);
const variants = generateSamples([401, 997, 4093]);

describe('input-box replay', () => {
  for (const [name, samples] of [['development', training], ['template variants', variants]] as const) {
    it(`${name}: hits at least 95% of inputs with at most 3% false positives`, () => {
      for (const theme of ['light/', 'dark/']) {
        const result = replay(samples.filter(s => s.id.startsWith(theme)), findBox);
        const evidence = JSON.stringify(result);
        expect(result.hitRate, evidence).toBeGreaterThanOrEqual(0.95);
        expect(result.falsePositiveRate, evidence).toBeLessThanOrEqual(0.03);
        expect(result.overconfident, evidence).toBe(0);
      }
    });
  }

  it('keeps the outer composer around a stronger attachment card', () => {
    for (const sample of [...training, ...variants].filter(s => s.id.includes('/nested-compact/'))) {
      // At two desktop pixels per strip pixel: [1000,1840], with a card at [1080,1560].
      const box = findBox(sample);
      expect(matches(sample, box), sample.id).toBe(true);
      expect(box!.confidence, sample.id).toBeGreaterThanOrEqual(ACCEPT_CONFIDENCE);
      expect(findInputSpan(sample)).toEqual(box!.span);
    }
  });

  it('normalizes exposed columns locally, including input sides cut by another window', () => {
    for (const sample of variants.filter(s => s.id.includes('-cut/') && !s.uncertain)) {
      const box = findBox(sample);
      expect(matches(sample, box), sample.id).toBe(true);
      expect(box!.confidence, sample.id).toBeGreaterThanOrEqual(ACCEPT_CONFIDENCE);
    }
  });

  it('does not choose confidently between equal inputs or invent two missing sides', () => {
    for (const sample of variants.filter(s => s.uncertain)) {
      expect(findBox(sample)?.confidence ?? 0, sample.id).toBeLessThan(ACCEPT_CONFIDENCE);
    }
  });

  it('keeps the same boundaries when the strip is mirrored and its luminance inverted', () => {
    for (const sample of variants.filter(s => /\/(left|nested-compact|fill)\//.test(s.id) && !s.uncertain)) {
      const gray = new Uint8Array(sample.gray.length);
      for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
        gray[y * sample.width + x] = 255 - sample.gray[y * sample.width + sample.width - x - 1]!;
      }
      const mirrored: Sample = { ...sample, gray, span: [sample.width - sample.span![1], sample.width - sample.span![0]] };
      expect(matches(mirrored, findBox(mirrored)), sample.id).toBe(true);
    }
  });

  it('returns no box for a blank, undersized, or incomplete strip', () => {
    expect(findBox({ width: 1280, height: 250, gray: new Uint8Array(320000).fill(250) })).toBeNull();
    expect(findBox({ width: 10, height: 5, gray: new Uint8Array(50) })).toBeNull();
    expect(findBox({ width: 1280, height: 250, gray: new Uint8Array(100) })).toBeNull();
  });

  it('processes each warmed 1280×250 replay and dense edge strip within 20 ms', () => {
    const dense: Sample = { id: 'dense-edges', width: 1280, height: 250, gray: new Uint8Array(320000), span: null, uncertain: true };
    const crowded: Sample = { ...dense, id: 'staggered-edges', gray: new Uint8Array(320000).fill(240) };
    for (let y = 0; y < dense.height; y++) for (let x = 0; x < dense.width; x++) {
      dense.gray[y * dense.width + x] = ((Math.floor(y / 6) + Math.floor(x / 200)) % 2) * 160 + 40;
      const left = (y % 5) * 40;
      if (x >= left && x < left + 1000) crowded.gray[y * dense.width + x] = [30, 30, 200, 200, 100, 100][y % 6]!;
    }
    const samples = [...variants.filter(s => s.width === 1280), dense, crowded];
    expect(findBox(crowded)?.confidence ?? 0).toBeLessThan(ACCEPT_CONFIDENCE);
    for (let i = 0; i < 20; i++) findBox(samples[i % samples.length]!);
    let maximum = 0;
    for (const sample of samples) {
      const start = performance.now();
      findBox(sample);
      const ms = performance.now() - start;
      maximum = Math.max(maximum, ms);
      expect(ms, sample.id).toBeLessThan(20);
    }
    console.info(`workarea: ${samples.length} timed calls, max ${maximum.toFixed(2)} ms`);
  });
});

const privateDirectory = process.env.WORKAREA_SAMPLE_DIR;
const privateLabels = process.env.WORKAREA_LABELS;
describe.skipIf(!privateDirectory || !privateLabels)('explicitly supplied private offline replay', () => {
  it('hits at least 80% of manually labelled inputs with at most 5% false positives', () => {
    const labels = JSON.parse(readFileSync(privateLabels!, 'utf8')) as PrivateLabel[];
    const result = replay(loadPrivateSamples(privateDirectory!, labels), findBox);
    console.info(JSON.stringify(result));
    expect(result.positives).toBeGreaterThan(0);
    expect(result.negatives).toBeGreaterThan(0);
    expect(result.hitRate).toBeGreaterThanOrEqual(0.8);
    expect(result.falsePositiveRate).toBeLessThanOrEqual(0.05);
    expect(result.overconfident).toBe(0);
  });
});
