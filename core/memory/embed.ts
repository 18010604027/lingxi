/**
 * Sentence vectors for memory: BAAI's bge-small-zh-v1.5, the int8 ONNX export by
 * Xenova (24 MB), fetched from ModelScope with size and SHA-256 checked (model-slot.ts), run with
 * onnxruntime-web's WASM in this process: no native module, nothing rebuilt for Electron.
 *
 * The tokenizer is BERT's, as the model's tokenizer.json sets it: clean the text, put spaces around CJK characters, no
 * lowercasing, split on whitespace and punctuation, then WordPiece over vocab.txt ("##" continues a word, [UNK] for a
 * word it cannot cover, words over 100 characters are [UNK]). The vector is the [CLS] state, L2-normalized, as bge
 * pools; so a dot product is the cosine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSpec } from './model-slot.ts';

export const EMBED_MODEL: ModelSpec = {
  id: 'bge-small-zh-v1.5',
  files: [
    { role: 'model', name: 'model_quantized.onnx', bytes: 24_010_842, sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
    { role: 'vocab', name: 'vocab.txt', bytes: 109_540, sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c' },
  ],
  sources: [(file: string) => `https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/${file.endsWith('.onnx') ? `onnx/${file}` : file}`],
};
/** Vector size of the model. */
export const DIM = 512;
/** Tokens at most per text, [CLS] and [SEP] included; memory texts are short, and shorter is quicker. */
const MAX_TOKENS = 256;

export class BertTokenizer {
  private readonly ids = new Map<string, number>();
  readonly cls: number; readonly sep: number; readonly unk: number;

  constructor(vocab: string) {
    vocab.split(/\r?\n/).forEach((t, i) => { if (t && !this.ids.has(t)) this.ids.set(t, i); });
    this.cls = this.ids.get('[CLS]')!; this.sep = this.ids.get('[SEP]')!; this.unk = this.ids.get('[UNK]')!;
  }

  /** Token ids of `text` with [CLS] and [SEP], at most `max` of them. */
  encode(text: string, max = MAX_TOKENS): number[] {
    const out = [this.cls];
    for (const word of preTokenize(normalize(text))) {
      for (const id of this.wordPiece(word)) {
        if (out.length >= max - 1) break;
        out.push(id);
      }
    }
    out.push(this.sep);
    return out;
  }

  private wordPiece(word: string): number[] {
    const chars = [...word];
    if (chars.length > 100) return [this.unk];
    const pieces: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length, found: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        found = this.ids.get(sub);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [this.unk];
      pieces.push(found);
      start = end;
    }
    return pieces;
  }
}

/** BertNormalizer with clean_text and handle_chinese_chars, no lowercasing, accents kept. */
function normalize(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || (/\p{Cc}|\p{Cf}/u.test(ch) && !/[\t\n\r]/.test(ch))) continue;
    if (/\s/u.test(ch)) { out += ' '; continue; }
    out += isCjk(cp) ? ` ${ch} ` : ch;
  }
  return out;
}

/** BertPreTokenizer: whitespace splits, and every punctuation character is a word of its own. */
function preTokenize(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    let word = '';
    for (const ch of chunk) {
      if (isPunct(ch)) { if (word) out.push(word); out.push(ch); word = ''; } else word += ch;
    }
    if (word) out.push(word);
  }
  return out;
}

function isCjk(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

function isPunct(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(ch);
}

type Ort = typeof import('onnxruntime-web');

/** The model loaded and ready: `embed` turns texts into unit vectors. */
export class Embedder {
  private constructor(private readonly ort: Ort, private readonly session: import('onnxruntime-web').InferenceSession, readonly tokenizer: BertTokenizer) {}

  /** Loads the model files from `dir` (where the model slot put them). */
  static async load(dir: string): Promise<Embedder> {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(readFileSync(join(dir, 'model_quantized.onnx')));
    return new Embedder(ort, session, new BertTokenizer(readFileSync(join(dir, 'vocab.txt'), 'utf8')));
  }

  /** One unit vector per text, in order; texts are taken one at a time (no padding to think about). */
  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) {
      const ids = this.tokenizer.encode(text);
      const n = ids.length;
      const tensor = (data: number[]) => new this.ort.Tensor('int64', BigInt64Array.from(data.map(BigInt)), [1, n]);
      const feeds: Record<string, import('onnxruntime-web').Tensor> = { input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)) };
      if (this.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
      const result = await this.session.run(feeds);
      const hidden = (result.last_hidden_state ?? result[this.session.outputNames[0]!]!).data as Float32Array;
      out.push(unit(hidden.slice(0, DIM)));
    }
    return out;
  }
}

function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

/** Cosine of two unit vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
