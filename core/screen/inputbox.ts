/**
 * Input-box geometry in a grey bottom strip (moved from the old pet package's cua/workarea.ts). strip.ts
 * supplies each exposed window segment independently.
 */
/** A window this wide on its display, or wider, is looked into rather than kept out of whole. */
export const WIDE = 0.8;

type Strip = { width: number; height: number; gray: Uint8Array };
type Run = { y: number; x0: number; x1: number; strength: number };
type Box = { x0: number; x1: number; y0: number; y1: number; confidence: number; score: number };

/** A small separable blur preserves faint borders while suppressing glyph and compression noise. */
function smooth(strip: Strip): Float32Array {
  const { width: w, height: h, gray } = strip;
  const horizontal = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = gray[row]! * 3 + gray[row + 1]! + gray[row + 2]!;
    for (let x = 0; x < w; x++) {
      horizontal[row + x] = sum / 5;
      sum += gray[row + Math.min(w - 1, x + 3)]! - gray[row + Math.max(0, x - 2)]!;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = (horizontal[Math.max(0, y - 1) * w + x]! + horizontal[y * w + x]! + horizontal[Math.min(h - 1, y + 1) * w + x]!) / 3;
  }
  return out;
}

/** All sufficiently long edges, merging adjacent rows of the same border. */
function rowRuns(gray: Float32Array, w: number, h: number): Run[] {
  const runs: Run[] = [], min = Math.max(24, w * 0.12);
  for (let y = 0; y < h - 1; y++) {
    const above = Math.max(0, y - 1) * w, below = Math.min(h - 1, y + 1) * w;
    let start = -1, last = -1, count = 0, strength = 0;
    const finish = () => {
      if (last - start + 1 >= min && count / (last - start + 1) >= 0.75) {
        const run = { y, x0: start, x1: last + 1, strength: strength / count };
        let previous: Run | undefined;
        for (let i = runs.length - 1; i >= 0; i--) {
          const r = runs[i]!;
          if (y - r.y <= 4 && Math.abs(r.x0 - run.x0) <= 10 && Math.abs(r.x1 - run.x1) <= 10) { previous = r; break; }
        }
        if (previous) {
          if (run.strength > previous.strength) Object.assign(previous, run);
        } else runs.push(run);
      }
      start = -1; count = 0; strength = 0;
    };
    for (let x = 0; x <= w; x++) {
      const v = x < w ? Math.abs(gray[below + x]! - gray[above + x]!) : 0;
      if (start >= 0 && (x - last > 6 || x === w)) finish();
      if (v >= 1.1) {
        if (start < 0) start = x;
        last = x; count++; strength += v;
      }
    }
  }
  return runs;
}

/** Prefix counts make side checks independent of the candidate's height. */
function sideCounts(gray: Float32Array, w: number, h: number) {
  const rising = new Uint16Array(w * (h + 1)), falling = new Uint16Array(w * (h + 1));
  for (let x = 0; x < w; x++) {
    const column = x * (h + 1), left = Math.max(0, x - 2), right = Math.min(w - 1, x + 2);
    for (let y = 0; y < h; y++) {
      const delta = gray[y * w + right]! - gray[y * w + left]!;
      rising[column + y + 1] = rising[column + y]! + (delta >= 0.7 ? 1 : 0);
      falling[column + y + 1] = falling[column + y]! + (delta <= -0.7 ? 1 : 0);
    }
  }
  return { rising, falling };
}

/** Sides of rounded boxes stand outside their horizontal edges. A cut at the strip boundary supplies no side evidence. */
function side(counts: ReturnType<typeof sideCounts>, w: number, h: number, guess: number, y0: number, y1: number, direction: -1 | 1) {
  if ((direction < 0 && guess <= 3) || (direction > 0 && guess >= w - 3)) return { x: direction < 0 ? 0 : w, quality: 1, clipped: true };
  const inset = Math.min(20, Math.floor((y1 - y0) * 0.25)), top = y0 + inset + 1, bottom = y1 - inset;
  const slack = Math.min(30, Math.ceil((y1 - y0) * 0.5));
  let best = { x: guess, quality: 0, clipped: false }, score = -1;
  for (let d = -3; d <= slack; d++) {
    const x = guess + direction * d;
    if (x < 2 || x >= w - 2) continue;
    const column = x * (h + 1);
    const quality = Math.max(counts.rising[column + bottom]! - counts.rising[column + top]!, counts.falling[column + bottom]! - counts.falling[column + top]!) / Math.max(1, bottom - top);
    const s = quality - Math.abs(d) * 0.001;
    if (s > score) { score = s; best = { x, quality, clipped: false }; }
  }
  return best;
}

/** A control row needs some writing space; dense icon bars and glyph rows supply weaker evidence. */
function quietSpan(gray: Float32Array, w: number, x0: number, x1: number, y: number): number {
  let longest = 0, length = 0;
  for (let x = Math.max(2, x0 + 4); x < Math.min(w - 2, x1 - 4); x++) {
    if (Math.abs(gray[y * w + x + 2]! - gray[y * w + x - 2]!) < 2) { length++; longest = Math.max(longest, length); }
    else length = 0;
  }
  return longest / Math.max(1, x1 - x0);
}

/** A side continuing beyond the horizontal borders may belong to a page edge or an overlapping object. */
function outsideSide(counts: ReturnType<typeof sideCounts>, h: number, x: number, y0: number, y1: number): number {
  const column = x * (h + 1), top = Math.max(0, y0 - 8), bottom = Math.min(h, y1 + 8);
  const rising = counts.rising[column + y0]! - counts.rising[column + top]! + counts.rising[column + bottom]! - counts.rising[column + y1]!;
  const falling = counts.falling[column + y0]! - counts.falling[column + top]! + counts.falling[column + bottom]! - counts.falling[column + y1]!;
  return Math.max(rising, falling) / Math.max(1, y0 - top + bottom - y1);
}

/** Visible outer span, normalized to this strip, including strips cut from a wider window. */
export function findInputSpan(strip: Strip): [number, number] | null {
  return findBox(strip)?.span ?? null;
}

/**
 * Geometric input-box fallback. Confidence describes border evidence and proximity to the floor, not semantic
 * recognition: a panel with identical pixels is indistinguishable. Missing sides and competing boxes lower it.
 */
export function findBox(strip: Strip): { span: [number, number]; confidence: number } | null {
  const { width: w, height: h } = strip;
  if (w < 20 || h < 6 || strip.gray.length !== w * h) return null;
  const gray = smooth(strip), all = rowRuns(gray, w, h);
  // Bound pairing work on textured screens. Truncation cannot produce a confident reading.
  const crowded = all.length > 160;
  const runs = (crowded ? all.sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0)).slice(0, 160) : all).sort((a, b) => a.y - b.y);
  if (runs.length < 2) return null;
  const counts = sideCounts(gray, w, h), boxes: Box[] = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i]!, b = runs[j]!, dy = b.y - a.y;
    if (dy < 10 || dy > h * 0.8) continue;
    const drift = Math.max(12, Math.min(24, dy * 0.6));
    if (Math.abs(a.x0 - b.x0) > drift || Math.abs(a.x1 - b.x1) > drift) continue;
    const lo = Math.max(a.x0, b.x0), hi = Math.min(a.x1, b.x1), width = Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0);
    if (hi - lo < width * 0.78) continue;
    const left = side(counts, w, h, Math.min(a.x0, b.x0), a.y, b.y, -1);
    const right = side(counts, w, h, Math.max(a.x1, b.x1), a.y, b.y, 1);
    const quality = Math.min(left.quality, right.quality);
    if (quality < 0.85) continue;
    if (!left.clipped && !right.clipped && width < dy * 1.6) continue;
    let confidence = 0.5 * quality + 0.3 * ((hi - lo) / width) + 0.2;
    const cut = Number(left.clipped) + Number(right.clipped);
    if (cut === 2) confidence = Math.min(confidence, 0.45);
    else if (cut === 1) confidence = Math.min(confidence, 0.72);
    if (h - b.y > Math.max(32, h * 0.33)) confidence = Math.min(confidence, 0.45);
    if (h - b.y > Math.max(32, dy * 2)) confidence = Math.min(confidence, 0.45);
    const quiet = Math.min(quietSpan(gray, w, left.x, right.x, Math.round((a.y + b.y) / 2)), quietSpan(gray, w, left.x, right.x, b.y - Math.max(4, Math.min(8, Math.round(dy * 0.2)))));
    if (quiet < 0.22) confidence = Math.min(confidence, 0.5);
    if ((!left.clipped && outsideSide(counts, h, left.x, a.y, b.y) > 0.6) || (!right.clipped && outsideSide(counts, h, right.x, a.y, b.y) > 0.6)) confidence = Math.min(confidence, 0.5);
    if (crowded) confidence = Math.min(confidence, 0.5);
    const score = confidence + 0.2 * (right.x - left.x) / w + 0.2 * b.y / h + 0.1 * dy / h;
    boxes.push({ x0: left.x, x1: right.x, y0: a.y, y1: b.y, confidence, score });
  }
  if (!boxes.length) return null;
  boxes.sort((a, b) => b.score - a.score);
  let best = boxes[0]!;
  // A validated enclosure owns its attachments even when an inner card has a darker border.
  for (const outer of boxes) {
    if (outer.x0 <= best.x0 + 3 && outer.x1 >= best.x1 - 3 && outer.y0 <= best.y0 + 3 && outer.y1 >= best.y1 - 3
      && outer.x1 - outer.x0 > (best.x1 - best.x0) * 1.08 && (outer.confidence >= 0.6 || (outer.x0 === 0 && outer.x1 === w)) && h - outer.y1 <= Math.max(32, h * 0.33)) best = outer;
  }
  const rival = boxes.find(b => b.confidence >= 0.6 && (b.x1 < best.x0 - 6 || b.x0 > best.x1 + 6));
  if (rival && Math.abs(rival.score - best.score) < 0.12) best = { ...best, confidence: Math.min(best.confidence, 0.5) };
  return { span: [Math.max(0, best.x0 / w), Math.min(1, best.x1 / w)], confidence: best.confidence };
}
