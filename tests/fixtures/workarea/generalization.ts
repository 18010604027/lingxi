/** Independent scanline renderer and continuous layout sweep. Labels do not depend on detector rules. */
import jpeg from 'jpeg-js';
import type { Sample } from './generate.ts';

export interface AuditSample extends Sample {
  family: string;
  codec: 'raw' | 'jpeg';
  geometry: [number, number, number, number] | null;
}

function rng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

/** A shuffled stratum per sample, independently permuted for every parameter. */
function strata(n: number, random: () => number) {
  const values = Array.from({ length: n }, (_, i) => (i + random()) / n);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values;
}

type Bounds = [number, number, number, number];

function renderer(width: number, height: number, background: number, random: () => number) {
  const gray = new Uint8Array(width * height), coverage = new Float32Array(width);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    gray[y * width + x] = Math.max(0, Math.min(255, background + y / height * 2 + Math.round(random() * 2) - 1));
  }
  // Integrate four subpixel scanlines; this renderer shares no drawing helpers with generate.ts.
  const paint = ([left, top, right, bottom]: Bounds, shade: number, radius = 0, opacity = 1) => {
    const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y++) {
      coverage.fill(0);
      for (const offset of [0.125, 0.375, 0.625, 0.875]) {
        const yy = y + offset;
        if (yy < top || yy >= bottom) continue;
        const dy = Math.max(top + r - yy, 0, yy - bottom + r);
        const inset = r ? r - Math.sqrt(Math.max(0, r * r - dy * dy)) : 0;
        const a = left + inset, b = right - inset;
        for (let x = Math.max(0, Math.floor(a)); x < Math.min(width, Math.ceil(b)); x++) {
          coverage[x] += Math.max(0, Math.min(x + 1, b) - Math.max(x, a)) / 4;
        }
      }
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(right)); x++) {
        const alpha = coverage[x]! * opacity, i = y * width + x;
        gray[i] = Math.round(gray[i]! * (1 - alpha) + shade * alpha);
      }
    }
  };
  const words = (left: number, top: number, available: number, shade: number, size: number) => {
    let x = left;
    while (x + size * 2 < left + available) {
      const length = Math.min(size * (2 + random() * 6), left + available - x);
      // Upright and horizontal strokes with variable spacing, rather than random glyph bitmaps.
      for (let xx = x; xx < x + length - size * 0.4; xx += size * 0.65) {
        paint([xx, top, xx + size * 0.15, top + size], shade);
        paint([xx, top + size * 0.45, Math.min(xx + size * 0.5, x + length), top + size * 0.6], shade);
      }
      x += length + size * (0.8 + random() * 1.8);
    }
  };
  return { gray, paint, words };
}

function compress(gray: Uint8Array, width: number, height: number, quality: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray[i]!;
    rgba[i * 4 + 3] = 255;
  }
  const image = jpeg.decode(jpeg.encode({ data: rgba, width, height }, quality).data, { useTArray: true, formatAsRGBA: false });
  return Uint8Array.from({ length: width * height }, (_, i) => image.data[i * 3]!);
}

export function generateGeneralization(seed: number): AuditSample[] {
  const random = rng(seed), count = 192;
  const parameters = Array.from({ length: 9 }, () => strata(count, random));
  const parameter = (axis: number, i: number) => parameters[axis]![i]!;
  const samples: AuditSample[] = [];
  const inputFamilies = ['outline', 'fill', 'shadow', 'multiline', 'attachment', 'wide-attachment'];
  const negativeFamilies = ['document', 'control-bar', 'information-panel', 'game-hud'];
  for (let i = 0; i < count; i++) {
    const positive = i < count / 2;
    const family = positive ? inputFamilies[i % inputFamilies.length]! : negativeFamilies[i % negativeFamilies.length]!;
    const width = Math.round(480 + parameter(0, i) * 1120), height = Math.round(140 + parameter(1, i) * 200);
    const variant = Math.floor((positive ? i : i - count / 2) / (positive ? inputFamilies.length : negativeFamilies.length));
    const dark = variant % 2 === 0, direction = dark ? 1 : -1;
    const background = Math.round(dark ? 16 + random() * 48 : 205 + random() * 44), ink = dark ? 220 : 38;
    const c = renderer(width, height, background, random);
    const bw = width * (0.22 + parameter(2, i) * 0.66), bh = height * (0.08 + parameter(3, i) * 0.42);
    const left = 2 + parameter(4, i) * (width - bw - 4), bottom = height * (0.99 - parameter(5, i) * 0.37);
    const top = bottom - bh, right = left + bw, radius = Math.min(bw, bh) * parameter(6, i) * 0.48;
    const border = 0.8 + parameter(7, i) * 2.2, contrast = 4 + parameter(8, i) * 48;
    const field: Bounds = [left, top, right, bottom];
    const inset = (d: number): Bounds => [left + d, top + d, right - d, bottom - d];
    const font = Math.min(5 + random() * 6, bh * 0.3);
    if (positive) {
      for (let y = 8; y + font < top - 12; y += font * 2.4) c.words(left, y, bw * (0.5 + random() * 0.4), ink, font);
      if (family === 'shadow') {
        for (const spread of [7, 4, 2]) c.paint([left - spread, top - spread + 2, right + spread, bottom + spread + 2], background + direction * contrast, radius + spread, 0.16);
        c.paint(field, background, radius);
      } else {
        c.paint(field, background + direction * contrast, radius);
        if (family !== 'fill') c.paint(inset(border), background, Math.max(0, radius - border));
      }
      if (family === 'multiline') {
        for (let y = top + font; y + font < bottom - font * 2; y += font * 1.8) c.words(left + font, y, bw - font * 3, ink, font);
      } else c.words(left + font, top + font, Math.min(bw - font * 4, bw * 0.5), ink, font);
      if (family.includes('attachment')) {
        const pad = family === 'wide-attachment' ? Math.max(4, bw * 0.025) : bw * 0.13;
        const attachment: Bounds = [left + pad, top + bh * 0.18, family === 'wide-attachment' ? right - pad : left + bw * 0.72, bottom - bh * 0.23];
        c.paint(attachment, background + direction * Math.min(90, contrast + 30), radius * 0.3);
        c.words(attachment[0] + 4, attachment[1] + 4, (attachment[2] - attachment[0]) * 0.7, ink, Math.min(font, bh * 0.1));
      }
      const button = Math.min(font * 1.7, bh * 0.24);
      c.paint([right - button * 2, bottom - button * 1.7, right - button, bottom - button * 0.7], ink, button / 2);
      if (i % 4 === 0) {
        const footerTop = height - Math.min(18, (height - bottom) * 0.45);
        c.paint([0, footerTop, width, height], background + direction * 5);
        for (let x = width * 0.3; x < width * 0.7; x += font * 3) c.paint([x, footerTop + 3, x + font, height - 2], ink, 1);
      }
    } else if (family === 'document') {
      c.paint([width * 0.14, -4, width * 0.87, height + 4], background + direction * 12);
      for (let y = 5; y < height; y += font * 2.2) c.words(width * 0.18, y, width * 0.63, ink, font);
    } else if (family === 'control-bar') {
      const bar: Bounds = [left, height - Math.min(55, bh) - 7, right, height - 7];
      c.paint(bar, background + direction * contrast, radius * 0.5);
      for (let x = left + font; x < right - font; x += font * (2 + random() * 3)) {
        c.paint([x, bar[1] + font, Math.min(right - 4, x + font), bar[3] - font], ink, 2);
      }
    } else if (family === 'information-panel') {
      c.paint(field, background + direction * contrast, radius);
      c.words(left + font, top + font, bw * 0.7, ink, font);
      if (bh > font * 4) c.paint([left + font, top + font * 2.5, left + bw * 0.4, bottom - font], ink, radius * 0.2, 0.6);
    } else {
      for (let j = 0; j < 65; j++) {
        const x = random() * width, y = random() * height, v = 25 + random() * 200;
        c.paint([x, y, x + width * random() * 0.13, y + height * random() * 0.09], v, 1);
      }
      c.paint(field, background + direction * contrast, radius, 0.85);
      c.words(left + font, top + font, bw * 0.6, ink, font);
    }
    // Every family contains all four theme/codec combinations equally often.
    const codec = Math.floor(variant / 2) % 2 === 0 ? 'jpeg' : 'raw';
    const gray = codec === 'jpeg' ? compress(c.gray, width, height, 65 + Math.round(random() * 30)) : c.gray;
    const sample: AuditSample = { id: `${seed}/${positive ? 'input' : 'negative'}/${family}/${i}`, family: `${positive ? 'input' : 'negative'}/${family}`, width, height, gray, span: positive ? [left, right] : null, codec, geometry: positive ? field : null };
    samples.push(sample);
    if (positive && i % 12 === 0) {
      for (const both of [false, true]) {
        const from = Math.floor(left + bw * 0.2), to = both ? Math.ceil(right - bw * 0.2) : width;
        const cut = new Uint8Array((to - from) * height);
        for (let y = 0; y < height; y++) cut.set(gray.subarray(y * width + from, y * width + to), y * (to - from));
        samples.push({ ...sample, id: `${sample.id}/${both ? 'two-cuts' : 'one-cut'}`, family: both ? 'exposure/two-cuts' : 'exposure/one-cut', gray: cut, width: to - from, span: [0, Math.min(to - from, right - from)], uncertain: both });
      }
    }
  }
  return samples;
}
