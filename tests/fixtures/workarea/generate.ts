/** Deterministic grey strips with outer-box labels; no captured screen content. */
export interface Sample {
  id: string;
  width: number;
  height: number;
  gray: Uint8Array;
  span: [number, number] | null;
  uncertain?: boolean;
}

type Rect = [number, number, number, number];

function random(seed: number) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function canvas(w: number, h: number, bg: number, seed: number) {
  const gray = new Uint8Array(w * h).fill(bg), rng = random(seed);
  const rect = ([x0, y0, x1, y1]: Rect, color: number, radius = 0, border = color) => {
    const inside = (x: number, y: number, inset: number) => {
      if (x < x0 + inset || x >= x1 - inset || y < y0 + inset || y >= y1 - inset) return false;
      const r = Math.max(0, radius - inset);
      const dx = Math.max(x0 + inset + r - x - 0.5, 0, x + 0.5 - (x1 - inset - r));
      const dy = Math.max(y0 + inset + r - y - 0.5, 0, y + 0.5 - (y1 - inset - r));
      return dx * dx + dy * dy <= r * r;
    };
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        if (inside(x, y, 0)) gray[y * w + x] = inside(x, y, 1) ? color : border;
      }
    }
  };
  const text = (x: number, y: number, length: number, color: number) => {
    for (let c = 0; c < length; c++) {
      const bits = Math.floor(rng() * 65536);
      for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 4; dx++) {
        const xx = x + c * 7 + dx, yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && ((bits >>> ((dx + dy * 3) % 16)) & 1)) gray[yy * w + xx] = color;
      }
    }
  };
  return { gray, rect, text, rng };
}

/** Seeds vary placement and content within the same regression templates. */
export function generateSamples(seeds: number[] = [1, 2, 3, 4]): Sample[] {
  const samples: Sample[] = [];
  for (const seed of seeds) for (const dark of [false, true]) {
    const bg = dark ? 26 : 248, ink = dark ? 170 : 80, fill = dark ? 38 : 255, edge = dark ? 55 : 216;
    const theme = dark ? 'dark' : 'light';
    const make = (kind: string, negative = false) => {
      const width = 1280, height = 250, c = canvas(width, height, bg, seed);
      const jitter = Math.round(c.rng() * 28), x0 = 380 + jitter, x1 = 1040 + jitter;
      const y0 = kind === 'multiline' || kind === 'nested' ? 124 : kind === 'tall' ? 54 : 192;
      const y1 = kind === 'floor' ? height : 236;
      if (negative) {
        if (kind === 'video') {
          c.rect([80, -20, 1200, 190], dark ? 12 : 34);
          c.rect([110, 164, 1130, 168], 120);
          c.rect([115, 204, 145, 224], ink, 8);
        } else if (kind === 'game') {
          for (let i = 0; i < 110; i++) {
            const x = Math.floor(c.rng() * width), y = Math.floor(c.rng() * height);
            c.rect([x, y, x + 4 + Math.floor(c.rng() * 60), y + 3 + Math.floor(c.rng() * 25)], Math.floor(c.rng() * 256));
          }
        } else if (kind === 'document') {
          c.rect([310, -5, 970, 260], fill, 0, edge);
          for (let y = 12; y < 240; y += 18) c.text(350, y, 65, ink);
        } else if (kind === 'toolbar') {
          c.rect([0, 207, width, 250], fill, 0, edge);
          for (let x = 10; x < width; x += 40) c.rect([x, 217, x + 20, 239], bg, 3, edge);
        } else if (kind === 'floating-toolbar') {
          c.rect([870, 213, 1300, 242], fill, 8, edge);
          for (let x = 882; x < width; x += 28) c.rect([x, 222, x + 12, 234], bg, 2, ink);
        } else if (kind === 'card') {
          c.rect([x0, 25, x1, 140], fill, 12, edge);
          for (let y = 42; y < 120; y += 18) c.text(x0 + 18, y, 55, ink);
        } else if (kind === 'rules') {
          for (let y = 20; y < height; y += 30) c.rect([90, y, 1170, y + 1], edge);
        }
        samples.push({ id: `${theme}/${kind}/${seed}`, width, height, gray: c.gray, span: null });
        return;
      }
      // Competing edges and glyphs above the composer.
      if (seed % 3 === 0) c.rect([x0 - 20, -20, x1 + 20, 101], fill, 4, edge);
      for (let y = 8; y < 92; y += 19) c.text(x0 + 12, y, 44 + seed % 8, ink);
      if (kind === 'toolbar-above') c.rect([x0, 103, x1, 130], fill, 3, edge);
      let bounds: Rect = [kind === 'left' ? 18 : x0, y0, kind === 'left' ? 610 : x1, y1];
      if (kind === 'center') bounds = [310, y0, 970, y1];
      if (kind === 'compact') bounds = [520 + jitter, 209, 904 + jitter, 233];
      if (kind === 'nested-compact') bounds = [500, 104, 920, 239];
      if (kind === 'pill') bounds = [250 + jitter, 208, 1110 + jitter, 240];
      if (kind === 'raised') bounds = [x0, 135, x1, 180];
      if (kind === 'raised-thin') bounds = [x0, 135, x1, 159];
      const [a, t, b, d] = bounds;
      const rounded = !['border', 'left'].includes(kind);
      const faint = kind === 'faint' || kind === 'nested' || kind === 'nested-compact' || kind === 'low-contrast';
      const color = kind === 'fill' ? (dark ? 42 : 237) : faint || kind === 'shadow-only' ? bg : fill;
      const border = kind === 'fill' || kind === 'shadow-only' ? color : faint ? bg + (dark ? 1 : -1) * (kind === 'low-contrast' ? 1 : 4) : edge;
      if (kind === 'shadow' || kind === 'shadow-only' || kind === 'nested' || kind === 'nested-compact') {
        for (let n = 4; n >= 1; n--) c.rect([a - n, t - n + 2, b + n, d + n + 2], dark ? bg + 7 - n : bg - 7 + n, 14 + n);
      }
      c.rect(bounds, color, rounded ? 13 : 0, border);
      if (kind === 'multiline') for (let y = t + 15; y < d - 28; y += 18) c.text(a + 18, y, 65, ink);
      else c.text(a + 18, t + 12, 24, ink);
      if (kind === 'nested' || kind === 'nested-compact') {
        c.rect([a + 40, t + 12, a + 280, d - 27], fill, 5, edge);
        c.rect([a + 50, t + 22, a + 130, d - 37], dark ? 80 : 150, 3);
      }
      c.rect([b - 31, d - 26, b - 13, d - 8], ink, 8);
      c.rect([a + 14, d - 23, a + 24, d - 13], ink, 3);
      if (kind === 'noise') for (let i = 0; i < c.gray.length; i++) c.gray[i] = Math.max(0, Math.min(255, c.gray[i]! + Math.floor(c.rng() * 3) - 1));
      if (kind === 'rivals') {
        c.gray.fill(bg);
        c.rect([120, 189, 480, 238], fill, 12, edge);
        c.rect([800, 189, 1160, 238], fill, 12, edge);
      }
      samples.push({ id: `${theme}/${kind}/${seed}`, width, height, gray: c.gray, span: kind === 'rivals' ? null : [a, b], uncertain: ['low-contrast', 'rivals'].includes(kind) });
      // Partial window exposure: one or both sides of the same box are outside the strip.
      if (kind === 'nested' || kind === 'fill') for (const [from, to, tag] of [[a + 90, 1280, 'left-cut'], [0, b - 90, 'right-cut'], [a + 100, b - 100, 'both-cut']] as const) {
        const w = to - from, gray = new Uint8Array(w * height);
        for (let y = 0; y < height; y++) gray.set(c.gray.subarray(y * width + from, y * width + to), y * w);
        samples.push({ id: `${theme}/${kind}/${tag}/${seed}`, width: w, height, gray, span: [Math.max(0, a - from), Math.min(w, b - from)], uncertain: tag === 'both-cut' });
      }
    };
    for (const kind of ['border', 'fill', 'faint', 'shadow', 'shadow-only', 'multiline', 'nested', 'nested-compact', 'compact', 'pill', 'tall', 'left', 'center', 'floor', 'raised', 'toolbar-above', 'noise', 'low-contrast', 'rivals', 'raised-thin']) make(kind);
    for (const kind of ['blank', 'video', 'game', 'document', 'toolbar', 'floating-toolbar', 'card', 'rules']) make(kind, true);
  }
  return samples;
}

export const ACCEPT_CONFIDENCE = 0.6;

/** Endpoint tolerance prevents an inner attachment from counting as the outer composer. */
export function matches(sample: Sample, box: { span: [number, number]; confidence: number } | null): boolean {
  return !!sample.span && !!box && sample.span.every((x, i) => Math.abs(x - box.span[i]! * sample.width) <= Math.max(6, sample.width * 0.015));
}

export function replay(samples: Sample[], detect: (sample: Sample) => { span: [number, number]; confidence: number } | null) {
  let positives = 0, hits = 0, negatives = 0, falsePositives = 0, uncertain = 0, overconfident = 0;
  const failures: string[] = [];
  for (const sample of samples) {
    const box = detect(sample), accepted = !!box && box.confidence >= ACCEPT_CONFIDENCE;
    if (sample.uncertain) {
      uncertain++;
      if (accepted) { overconfident++; failures.push(sample.id); }
    } else if (sample.span) {
      positives++;
      if (accepted && matches(sample, box)) hits++;
      else failures.push(sample.id);
    } else {
      negatives++;
      if (accepted) { falsePositives++; failures.push(sample.id); }
    }
  }
  return { positives, hits, negatives, falsePositives, uncertain, overconfident, hitRate: hits / positives, falsePositiveRate: falsePositives / negatives, failures };
}
