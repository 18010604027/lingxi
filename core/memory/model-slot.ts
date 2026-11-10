/**
 * A model's files, fetched into a directory and checked against their published SHA-256 (moved here from the old
 * pet package's runtime store). Only the memory embedder still downloads one (`embed.ts`); it asks for
 * a model, installs it once and loads it from `dir`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type Phase = 'absent' | 'working' | 'ready' | 'error';

export interface ArtifactState {
  phase: Phase;
  /** Where the artifact lives. */
  path: string;
  done: number;
  total: number | null;
  detail: string | null;
}

/** A model: its files with their sizes and SHA-256, and where to fetch them from, in order. */
export interface ModelSpec {
  id: string;
  /** `role` is what the embedder loads the file as. */
  files: ReadonlyArray<{ role: string; name: string; bytes: number; sha256: string }>;
  sources: ReadonlyArray<(file: string) => string>;
}

interface DownloadOptions {
  onProgress?: (done: number, total: number | null) => void;
}

/** Streams one URL to a file; the caller owns the partial-file protocol. */
async function downloadFile(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  let done = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      options.onProgress?.(done, total);
      callback(null, chunk);
    },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(dest));
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** What the download steps say while they run; nothing shows it, so it is plain English. */
const TEXT = {
  downloadingFrom: (file: string, host: string) => `Downloading ${file} (${host})`,
  verifying: (file: string) => `Verifying ${file}`,
  mismatch: (sum: string) => `Checksum mismatch: ${sum}…`,
  failed: (file: string, why: string) => `${file} failed to download (${why})`,
};

interface Job { state: ArtifactState; promise: Promise<void> | null }

/** A model: present when every file is there at its full size. */
export class ModelSlot {
  private job: Job;
  readonly bytes: number;

  constructor(private readonly root: () => string, private readonly spec: ModelSpec) {
    this.bytes = spec.files.reduce((n, f) => n + f.bytes, 0);
    this.job = { state: { phase: 'absent', path: '', done: 0, total: null, detail: null }, promise: null };
  }

  get dir(): string {
    return join(this.root(), this.spec.id);
  }

  file(name: string): string {
    return join(this.dir, name);
  }

  /** Where each file lives, by role. */
  paths(): Record<string, string> {
    return Object.fromEntries(this.spec.files.map((f) => [f.role, this.file(f.name)]));
  }

  private has(f: { name: string; bytes: number }): boolean {
    const path = this.file(f.name);
    return existsSync(path) && statSync(path).size === f.bytes;
  }

  state(): ArtifactState {
    if (this.job.promise) return { ...this.job.state };
    if (this.spec.files.every((f) => this.has(f))) return { phase: 'ready', path: this.dir, done: this.bytes, total: this.bytes, detail: null };
    return { ...this.job.state, phase: this.job.state.phase === 'error' ? 'error' : 'absent', path: this.dir };
  }

  install(): Promise<void> {
    if (this.job.promise) return this.job.promise;
    this.job.state = { phase: 'working', path: this.dir, done: 0, total: this.bytes, detail: null };
    const work = (async () => {
      mkdirSync(this.dir, { recursive: true });
      let before = 0;
      for (const f of this.spec.files) {
        if (this.has(f)) { before += f.bytes; this.job.state.done = before; continue; }
        const partial = `${this.file(f.name)}.partial`;
        const errors: string[] = [];
        for (const source of this.spec.sources) {
          const url = source(f.name);
          try {
            this.job.state.detail = TEXT.downloadingFrom(f.name, new URL(url).host);
            await downloadFile(url, partial, { onProgress: (done) => { this.job.state.done = before + done; } });
            this.job.state.detail = TEXT.verifying(f.name);
            const sum = await sha256File(partial);
            if (sum !== f.sha256) throw new Error(TEXT.mismatch(sum.slice(0, 12)));
            renameSync(partial, this.file(f.name));
            break;
          } catch (err) {
            rmSync(partial, { force: true });
            errors.push(`${new URL(url).host}: ${(err as Error).message}`);
          }
        }
        if (!this.has(f)) throw new Error(TEXT.failed(f.name, errors.join('; ')));
        before += f.bytes;
        this.job.state.done = before;
      }
      this.job.state = { phase: 'ready', path: this.dir, done: this.bytes, total: this.bytes, detail: null };
    })().catch((err: Error) => {
      this.job.state = { phase: 'error', path: this.dir, done: 0, total: null, detail: err.message };
    }).finally(() => { this.job.promise = null; });
    this.job.promise = work;
    return work;
  }
}
