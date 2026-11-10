import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { openDb, transaction, type Db } from '../sqlite.ts';
import koffi from 'koffi';

export interface FrontEpoch {
  id: string; threadId: string; predecessor: string | null; checkpointRef: string; materialFingerprint: string;
  disposition: FrontDisposition[]; seedRecords: unknown[]; state: 'prepared' | 'active' | 'superseded';
}
export interface FrontPointer { epochId: string; version: number; }
export interface FrontDisposition {
  kind: 'input' | 'action' | 'output'; identity: string; status: 'transferred' | 'resolved' | 'pending';
  destination: string | null; decisionRef?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS front_epoch (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, predecessor TEXT, checkpoint_ref TEXT NOT NULL,
  material_fingerprint TEXT NOT NULL, disposition TEXT NOT NULL, seed_records TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS front_pointer (id INTEGER PRIMARY KEY CHECK (id = 1), epoch_id TEXT NOT NULL, version INTEGER NOT NULL);
`;

/** Temporary host ownership and epoch pointer store. */
export class FrontEpochStore {
  private static readonly heldRoots = new Set<string>();
  private db!: Db;
  private mutex: unknown;
  private readonly rootKey: string;
  private releaseMutex!: (handle: unknown) => boolean;
  private closeHandle!: (handle: unknown) => boolean;
  private closed = false;

  private constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    if (process.platform !== 'win32') throw new Error('front owner lock is unavailable on this platform');
    this.rootKey = realpathSync(dataRoot).toLowerCase();
    if (FrontEpochStore.heldRoots.has(this.rootKey)) throw new Error('front owner is already active in this process');
    const name = `Global\\LingxiFront-${createHash('sha256').update(this.rootKey).digest('hex')}`;
    const kernel32 = koffi.load('kernel32.dll');
    const CreateMutexW = kernel32.func('void * __stdcall CreateMutexW(void *attributes, bool initialOwner, uint16_t *name)');
    const WaitForSingleObject = kernel32.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)');
    const ReleaseMutex = kernel32.func('bool __stdcall ReleaseMutex(void *handle)');
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)');
    const handle = CreateMutexW(null, false, Buffer.from(`${name}\0`, 'utf16le'));
    if (!handle) throw new Error('front owner mutex could not be created');
    const wait = WaitForSingleObject(handle, 0);
    if (wait === 0x102) { CloseHandle(handle); throw new Error('front owner is already active for this data root'); }
    if (wait !== 0 && wait !== 0x80) { CloseHandle(handle); throw new Error(`front owner mutex wait failed: ${wait}`); }
    FrontEpochStore.heldRoots.add(this.rootKey);
    this.mutex = handle;
    this.releaseMutex = ReleaseMutex;
    this.closeHandle = CloseHandle;
  }

  static async acquire(dataRoot: string): Promise<FrontEpochStore> { return FrontEpochStore.acquireSync(dataRoot); }

  static acquireSync(dataRoot: string): FrontEpochStore {
    const store = new FrontEpochStore(dataRoot);
    try {
      store.db = openDb(join(dataRoot, 'front-epoch.sqlite')); store.db.exec(SCHEMA);
      const columns = store.db.prepare('PRAGMA table_info(front_epoch)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'seed_records')) store.db.exec("ALTER TABLE front_epoch ADD COLUMN seed_records TEXT NOT NULL DEFAULT '[]'");
      const integrity = store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrity.integrity_check !== 'ok') throw new Error(`front epoch store integrity failed: ${integrity.integrity_check}`);
      return store;
    } catch (error) {
      store.closeSync();
      throw error;
    }
  }

  private closeSync(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } catch { /* already closed */ }
    if (this.mutex) { try { this.releaseMutex(this.mutex); } finally { this.closeHandle(this.mutex); this.mutex = null; FrontEpochStore.heldRoots.delete(this.rootKey); } }
  }

  ensureInitial(threadId: string, checkpointRef: string, materialFingerprint: string): FrontPointer {
    const current = this.pointer();
    if (current) return current;
    const epoch: FrontEpoch = { id: randomUUID(), threadId, predecessor: null, checkpointRef, materialFingerprint, disposition: [], seedRecords: [], state: 'active' };
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO front_epoch (id,thread_id,predecessor,checkpoint_ref,material_fingerprint,disposition,seed_records,state) VALUES (?,?,?,?,?,?,?,?)')
        .run(epoch.id, epoch.threadId, null, epoch.checkpointRef, epoch.materialFingerprint, '[]', '[]', epoch.state);
      this.db.prepare('INSERT INTO front_pointer (id,epoch_id,version) VALUES (1,?,0)').run(epoch.id);
    });
    return { epochId: epoch.id, version: 0 };
  }

  pointer(): FrontPointer | null {
    const row = this.db.prepare('SELECT epoch_id, version FROM front_pointer WHERE id = 1').get() as { epoch_id: string; version: number } | undefined;
    return row ? { epochId: row.epoch_id, version: row.version } : null;
  }

  async prepare(input: Omit<FrontEpoch, 'state' | 'seedRecords'> & { seedRecords?: unknown[] }, verifyCheckpoint: (ref: string) => Promise<boolean>): Promise<FrontEpoch> {
    if (!input.checkpointRef.trim() || !input.materialFingerprint.trim()) throw new Error('front epoch checkpoint and material identity are required');
    if (!await verifyCheckpoint(input.checkpointRef)) throw new Error('front epoch checkpoint could not be read back');
    for (const item of input.disposition) {
      if (!item.identity.trim() || (item.status === 'transferred' && !item.destination?.trim())
        || (item.status === 'resolved' && !item.decisionRef?.trim())) throw new Error('invalid front epoch disposition');
    }
    const epoch: FrontEpoch = { ...input, seedRecords: structuredClone(input.seedRecords ?? []), state: 'prepared', disposition: structuredClone(input.disposition) };
    const seedPayload = JSON.stringify(epoch.seedRecords, (_key, value: unknown) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('front epoch seed is not JSON-safe');
      return value;
    });
    transaction(this.db, () => this.db.prepare('INSERT INTO front_epoch (id,thread_id,predecessor,checkpoint_ref,material_fingerprint,disposition,seed_records,state) VALUES (?,?,?,?,?,?,?,?)')
      .run(epoch.id, epoch.threadId, epoch.predecessor, epoch.checkpointRef, epoch.materialFingerprint, JSON.stringify(epoch.disposition), seedPayload, epoch.state));
    return epoch;
  }

  async activate(candidateId: string, expected: FrontPointer, verifyCheckpoint: (candidate: FrontEpoch) => Promise<boolean>): Promise<FrontPointer> {
    const prepared = this.get(candidateId);
    if (!prepared || prepared.state !== 'prepared' || prepared.predecessor !== expected.epochId) throw new Error('front epoch candidate is not prepared from current epoch');
    if (!await verifyCheckpoint(structuredClone(prepared))) throw new Error('front epoch checkpoint changed after preparation');
    let result!: FrontPointer;
    transaction(this.db, () => {
      const pointer = this.pointer();
      if (!pointer || pointer.epochId !== expected.epochId || pointer.version !== expected.version) throw new Error('front epoch pointer changed');
      const candidate = this.get(candidateId);
      if (!candidate || candidate.state !== 'prepared' || candidate.predecessor !== expected.epochId) throw new Error('front epoch candidate is not prepared from current epoch');
      if (candidate.disposition.some((item) => item.status === 'pending')) throw new Error('front epoch has unresolved dispositions');
      const version = expected.version + 1;
      this.db.prepare("UPDATE front_epoch SET state = 'superseded' WHERE id = ?").run(expected.epochId);
      this.db.prepare("UPDATE front_epoch SET state = 'active' WHERE id = ? AND state = 'prepared'").run(candidateId);
      this.db.prepare('UPDATE front_pointer SET epoch_id = ?, version = ? WHERE id = 1 AND epoch_id = ? AND version = ?')
        .run(candidateId, version, expected.epochId, expected.version);
      result = { epochId: candidateId, version };
    });
    return result;
  }

  get(id: string): FrontEpoch | null {
    const row = this.db.prepare('SELECT * FROM front_epoch WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, threadId: row.thread_id as string, predecessor: row.predecessor as string | null,
      checkpointRef: row.checkpoint_ref as string, materialFingerprint: row.material_fingerprint as string,
      disposition: JSON.parse(row.disposition as string) as FrontDisposition[], seedRecords: JSON.parse((row.seed_records as string | undefined) ?? '[]') as unknown[],
      state: row.state as FrontEpoch['state'] } : null;
  }

  async close(): Promise<void> {
    this.closeSync();
  }
}

/** Serializes model/tool entry against an epoch switch within one host process. */
export class FrontEpochCoordinator {
  private frozen = false;
  private active = 0;
  private drained: Array<() => void> = [];
  constructor(readonly store: FrontEpochStore) {}

  async enter(expected: FrontPointer): Promise<() => void> {
    if (this.frozen) throw new Error('front is frozen for epoch transition');
    const current = this.store.pointer();
    if (!current || current.epochId !== expected.epochId || current.version !== expected.version) throw new Error('front epoch is no longer active');
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (this.frozen && this.active === 0) for (const resolve of this.drained.splice(0)) resolve();
    };
  }

  async freezeAndDrain(): Promise<void> {
    if (this.frozen) throw new Error('front epoch transition already in progress');
    this.frozen = true;
    if (this.active) await new Promise<void>((resolve) => this.drained.push(resolve));
  }

  async activate(candidateId: string, expected: FrontPointer, verifyCheckpoint: (candidate: FrontEpoch) => Promise<boolean>): Promise<FrontPointer> {
    if (!this.frozen || this.active !== 0) throw new Error('front must be frozen and drained before epoch activation');
    return this.store.activate(candidateId, expected, verifyCheckpoint);
  }

  unfreeze(): void { this.frozen = false; }
  get isFrozen(): boolean { return this.frozen; }
}
