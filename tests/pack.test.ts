import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPack, packDir, applyActionOverrides, isRedundantOverride } from '../core/behavior/pack.ts';

const fixture = join(import.meta.dirname, 'fixtures', 'pack');
const cleanup: string[] = [];

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lingxi-pack-'));
  cleanup.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a figure pack is the person\'s own data', () => {
  it('loads the folder it is given and keeps its clips folder', () => {
    const pack = loadPack(process.cwd(), fixture);
    expect(pack.dir).toBe(fixture);
    expect(pack.figure.name).toBe('fixture');
    expect(pack.clips).toBe(join(fixture, 'clips'));
  });

  it('takes a bare id from packs/ and a path from anywhere else', () => {
    expect(packDir('/repo', 'mine')).toBe(join('/repo', 'packs', 'mine'));
    expect(packDir('/repo', fixture)).toBe(fixture);
  });

  it('says how to name a pack when nothing is configured', () => {
    const before = process.env.LINGXI_PACK;
    delete process.env.LINGXI_PACK;
    try {
      // A noted path that cannot exist, so the test does not depend on this machine's ~/.lingxi/pack.
      expect(() => packDir(process.cwd(), '', join(tmpdir(), `lingxi-no-pack-${process.pid}-${Date.now()}`))).toThrow(/LINGXI_PACK/);
    } finally {
      if (before !== undefined) process.env.LINGXI_PACK = before;
    }
  });

  it('names the field that is wrong instead of failing later', () => {
    const dir = scratch();
    const figure = JSON.parse(readFileSync(join(fixture, 'figure.json'), 'utf8'));
    delete figure.name;
    writeFileSync(join(dir, 'figure.json'), JSON.stringify(figure));
    expect(() => loadPack(process.cwd(), dir)).toThrow(/name must be a non-empty string/);
  });

  it('accepts an empty noMirror list', () => {
    const dir = scratch();
    const figure = JSON.parse(readFileSync(join(fixture, 'figure.json'), 'utf8'));
    figure.noMirror = [];
    writeFileSync(join(dir, 'figure.json'), JSON.stringify(figure));
    expect(loadPack(process.cwd(), dir).figure.noMirror).toEqual([]);
  });

  it('names a move that has no clip', () => {
    const dir = scratch();
    const figure = JSON.parse(readFileSync(join(fixture, 'figure.json'), 'utf8'));
    figure.moves.walk[0].clip = '';
    writeFileSync(join(dir, 'figure.json'), JSON.stringify(figure));
    expect(() => loadPack(process.cwd(), dir)).toThrow(/moves\.walk\[0\]\.clip/);
  });

  it('fails on a folder without figure.json', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'clips'));
    expect(() => loadPack(process.cwd(), dir)).toThrow(/no figure\.json/);
  });

  it('knows when a saved change only repeats the pack', () => {
    const figure = loadPack(process.cwd(), fixture).figure;
    expect(isRedundantOverride(figure, 'wave', { clips: figure.words.wave, zh: figure.vocab?.wave?.zh, about: figure.vocab?.wave?.about })).toBe(true);
    expect(isRedundantOverride(figure, 'wave', { clips: ['my-wave'] })).toBe(false);
    expect(isRedundantOverride(figure, 'wave', { mood: ['shy'] })).toBe(false);
  });

  it('puts the person\'s action changes on top of the pack, leaving the pack file alone', () => {
    const onDisk = readFileSync(join(fixture, 'figure.json'), 'utf8');
    const figure = loadPack(process.cwd(), fixture).figure;
    const packSleep = [...figure.words.sleep];
    applyActionOverrides(figure, { wave: { clips: ['my-wave'], about: '抬手打招呼', when: '见面时' } });
    expect(figure.words.wave).toEqual(['my-wave']);
    expect(figure.vocab?.wave).toMatchObject({ about: '抬手打招呼', when: '见面时' });
    expect(readFileSync(join(fixture, 'figure.json'), 'utf8')).toBe(onDisk);
    // A field nobody set keeps the pack's value.
    applyActionOverrides(figure, { sleep: { zh: ['睡了'] }, wave: { mood: ['shy'] } });
    expect(figure.words.sleep).toEqual(packSleep);
    expect(figure.vocab?.sleep?.zh).toEqual(['睡了']);
    expect(figure.vocab?.wave?.mood).toEqual(['shy']);
  });
});
