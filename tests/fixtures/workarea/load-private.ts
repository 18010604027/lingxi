/** Opt-in offline replay. Captured images and their labels stay outside tracked fixtures. */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import jpeg from 'jpeg-js';
import type { Sample } from './generate.ts';

export interface PrivateLabel {
  file: string;
  /** Visible input boundaries in decoded-image pixels, or no input. */
  span: [number, number] | null;
  uncertain?: boolean;
  /** Optional exposed columns [from, to), in decoded-image pixels. */
  columns?: [number, number];
}

export function loadPrivateSamples(directory: string, labels: PrivateLabel[]): Sample[] {
  return labels.map(label => {
    if (basename(label.file) !== label.file || !label.file.endsWith('.jpg')) throw new Error('Expected a JPEG basename');
    // Require the paired capture metadata. Never treat its previous detection as ground truth.
    JSON.parse(readFileSync(join(directory, label.file.replace(/\.jpg$/, '.json')), 'utf8'));
    const decoded = jpeg.decode(readFileSync(join(directory, label.file)), { useTArray: true, formatAsRGBA: false });
    const [from, to] = label.columns ?? [0, decoded.width];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > decoded.width || to <= from) throw new Error('Invalid exposed columns');
    const width = to - from, height = decoded.height, gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * decoded.width + x + from) * 3;
      gray[y * width + x] = Math.round(0.299 * decoded.data[i]! + 0.587 * decoded.data[i + 1]! + 0.114 * decoded.data[i + 2]!);
    }
    return { id: label.file, width, height, gray, span: label.span && [Math.max(0, label.span[0] - from), Math.min(width, label.span[1] - from)], uncertain: label.uncertain };
  });
}
