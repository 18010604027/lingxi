import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FrontEpochCoordinator, FrontEpochStore } from '../core/runtime/front-epoch.ts';

describe('front epoch ownership', () => {
  it('rejects a second owner and releases the lock on close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'front-epoch-'));
    const first = await FrontEpochStore.acquire(root);
    await expect(FrontEpochStore.acquire(root)).rejects.toThrow(/owner/);
    await first.close();
    const second = await FrontEpochStore.acquire(root);
    await second.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('CAS activates a prepared epoch only after freeze and drain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'front-epoch-'));
    const store = await FrontEpochStore.acquire(root);
    const pointer = store.ensureInitial('thread-a', 'checkpoint-a', 'material-a');
    await expect(store.prepare({ id: 'bad-checkpoint', threadId: 'thread-a', predecessor: pointer.epochId, checkpointRef: 'missing', materialFingerprint: 'material-x', disposition: [] }, async () => false)).rejects.toThrow(/read back/);
    expect(store.get('bad-checkpoint')).toBeNull();
    const next = await store.prepare({ id: 'epoch-b', threadId: 'thread-a', predecessor: pointer.epochId, checkpointRef: 'checkpoint-b', materialFingerprint: 'material-b', disposition: [] }, async () => true);
    const coordinator = new FrontEpochCoordinator(store);
    const release = await coordinator.enter(pointer);
    const drain = coordinator.freezeAndDrain();
    let activated = false;
    void drain.then(() => { activated = true; });
    await Promise.resolve();
    expect(activated).toBe(false);
    release();
    await drain;
    expect((await coordinator.activate(next.id, pointer, async () => true)).version).toBe(1);
    expect(store.pointer()?.epochId).toBe(next.id);
    coordinator.unfreeze();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the old pointer when CAS or unresolved disposition blocks activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'front-epoch-'));
    const store = await FrontEpochStore.acquire(root);
    const pointer = store.ensureInitial('thread-a', 'checkpoint-a', 'material-a');
    const next = await store.prepare({ id: 'epoch-b', threadId: 'thread-a', predecessor: pointer.epochId, checkpointRef: 'checkpoint-b', materialFingerprint: 'material-b', disposition: [{ kind:'action',identity:'call-1',status:'pending',destination:null }] }, async () => true);
    const coordinator = new FrontEpochCoordinator(store);
    void coordinator.freezeAndDrain();
    await expect(coordinator.activate(next.id, pointer, async () => true)).rejects.toThrow(/unresolved/);
    await expect(coordinator.activate(next.id, { ...pointer, version: 9 }, async () => true)).rejects.toThrow(/pointer/);
    expect(store.pointer()).toEqual(pointer);
    coordinator.unfreeze(); await store.close(); rmSync(root, { recursive: true, force: true });
  });

  it('excludes another process and releases ownership after an owner process is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'front-epoch-process-'));
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'front-epoch-process.ts');
    const owner = spawn(process.execPath, ['--import', 'tsx', fixture, root, 'hold'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ''; owner.stdout.on('data', (part: Buffer) => { stdout += part.toString(); if (stdout.includes('READY')) resolve(); });
        owner.once('exit', (code) => reject(new Error(`owner exited before lock ready: ${code}`)));
      });
      const second = spawnSync(process.execPath, ['--import', 'tsx', fixture, root, 'hold'], { input: 'close\n', encoding: 'utf8', timeout: 10000 });
      expect(second.status).not.toBe(0);
      owner.kill('SIGKILL');
      await new Promise<void>((resolve) => owner.once('exit', () => resolve()));
      const recovered = spawnSync(process.execPath, ['--import', 'tsx', fixture, root, 'close'], { encoding: 'utf8', timeout: 10000 });
      expect(recovered.status, recovered.stderr).toBe(0);
    } finally { owner.kill(); rmSync(root, { recursive: true, force: true }); }
  });

});
