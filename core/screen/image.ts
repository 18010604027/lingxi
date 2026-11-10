/**
 * Screenshot post-processing (moved from the old pet package): area-average downscale, a cursor arrow drawn
 * at the pointer (screen captures do not contain the cursor), and JPEG encoding. JPEG keeps a
 * 1280×800 desktop around 100–250 KB, which matters because every screenshot stays in the
 * model's context and is re-sent with each request.
 */
import jpeg from 'jpeg-js';

export interface Scaled { width: number; height: number; scale: number }

/** Output size that fits `maxWidth`×`maxHeight` without upscaling. */
export function fit(width: number, height: number, maxWidth: number, maxHeight: number): Scaled {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** Area-average downscale of top-down RGBA (node-screenshots' raw output). */
export function downscale(rgba: Uint8Array, width: number, height: number, out: Scaled): Uint8Array {
  const small = new Uint8Array(out.width * out.height * 4);
  const fx = width / out.width, fy = height / out.height;
  for (let oy = 0; oy < out.height; oy++) {
    const y0 = Math.floor(oy * fy), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * fy));
    for (let ox = 0; ox < out.width; ox++) {
      const x0 = Math.floor(ox * fx), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1 && x < width; x++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
      }
      const o = (oy * out.width + ox) * 4;
      small[o] = r / n; small[o + 1] = g / n; small[o + 2] = b / n; small[o + 3] = 255;
    }
  }
  return small;
}

// Standard arrow pointer, 12×19: '#' outline, '.' fill.
const ARROW = [
  '#', '##', '#.#', '#..#', '#...#', '#....#', '#.....#', '#......#', '#.......#', '#........#',
  '#.........#', '#......####', '#...#..#', '#..##..#', '#.#  #..#', '##   #..#', '#     #..#', '      #..#', '       ##',
];

export function drawCursor(rgba: Uint8Array, width: number, height: number, cx: number, cy: number): void {
  ARROW.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx];
      if (ch !== '#' && ch !== '.') continue;
      const x = Math.round(cx) + dx, y = Math.round(cy) + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const o = (y * width + x) * 4, v = ch === '#' ? 0 : 255;
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v;
    }
  });
}

export function encodeJpeg(rgba: Uint8Array, width: number, height: number, quality: number): Uint8Array {
  return jpeg.encode({ data: rgba, width, height }, quality).data;
}

/** What to mark on a picture of the bottom band, in its own pixels (`drawMarks`). */
export interface Marks {
  /** Stretches kept out of: a red bar along the top and red edges. */
  zones?: Array<[number, number]>;
  /** Single spots: a vertical line in a colour (picked up, put down, the pet now, the caret). */
  points?: Array<{ x: number; color: 'blue' | 'green' | 'yellow' | 'magenta' }>;
}

const COLORS = { red: [230, 30, 30], blue: [30, 90, 240], green: [20, 190, 60], yellow: [250, 210, 0], magenta: [220, 40, 220] } as const;

/**
 * Marks a picture of the bottom band for the model to read positions off: a tick every 10% of the width along the
 * bottom edge (longer at 50%), kept-out stretches, and spots as coloured lines.
 */
export function drawMarks(rgba: Uint8Array, width: number, height: number, marks: Marks): void {
  const put = (x: number, y: number, c: readonly number[], a = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(rgba[o + k]! * (1 - a) + c[k]! * a);
  };
  for (const [a, b] of marks.zones ?? []) {
    const x0 = Math.max(0, Math.round(a)), x1 = Math.min(width - 1, Math.round(b));
    for (let x = x0; x <= x1; x++) for (let y = 0; y < 8; y++) put(x, y, COLORS.red, 0.85);
    for (let y = 0; y < height; y++) for (const x of [x0, x0 + 1, x1 - 1, x1]) put(x, y, COLORS.red, 0.9);
  }
  for (const p of marks.points ?? []) {
    const x = Math.round(p.x);
    for (let y = 0; y < height; y++) for (let d = -1; d <= 1; d++) put(x + d, y, COLORS[p.color], 0.9);
  }
  for (let t = 1; t < 10; t++) {
    const x = Math.round((t / 10) * width), len = t === 5 ? 18 : 10;
    for (let y = height - len; y < height; y++) { put(x - 1, y, [255, 255, 255]); put(x, y, [0, 0, 0]); put(x + 1, y, [255, 255, 255]); }
  }
}
