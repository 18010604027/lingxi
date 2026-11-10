import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadPack } from '../core/behavior/pack.ts';
import { validatePackResources } from '../core/behavior/pack-resources.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-setup-test-'));
  const pack = join(root, 'figure');
  mkdirSync(join(pack, 'clips'), { recursive: true });
  writeFileSync(join(pack, 'figure.json'), JSON.stringify({ name: 'Test', refWidth: 100, bodyWidth: 100, nativeFacing: 'left', idle: ['idle'], held: ['idle'], noMirror: [], moves: { walk: [{ clip: 'idle', leadSec: 0, tailSec: 0, minDist: 1, maxDist: 100 }], run: [] }, words: { wave: ['wave'] } }));
  writeFileSync(join(pack, 'clips', 'idle.webm'), 'fixture');
  writeFileSync(join(pack, 'clips', 'wave.webm'), 'fixture');
  writeFileSync(join(pack, 'motion.cjs'), 'module.exports = {createMove(){},travelX(){},estimateReleaseVelocity(){},fallStep(){}};');
  const note = join(root, 'config', 'pack');
  return { root, pack, note };
}
const run = (pack: string, note: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.LINGXI_CLIPS;
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/setup-app.ts', '--pack', pack, '--note-file', note, ...args], { cwd: process.cwd(), encoding: 'utf8', env });
};

describe('first-run pack setup without application startup', () => {
  it('validates every referenced clip and saves a selection the runtime can use', () => {
    const f = fixture();
    const before = process.env.LINGXI_CLIPS;
    delete process.env.LINGXI_CLIPS;
    try { expect(validatePackResources(loadPack(process.cwd(), f.pack)).clips).toEqual(['idle', 'wave']); }
    finally { if (before !== undefined) process.env.LINGXI_CLIPS = before; }
    const result = run(f.pack, f.note);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.note, 'utf8').trim()).toBe(f.pack);
  });
  it('leaves the old selection unchanged when an action clip is missing', () => {
    const f = fixture();
    const figure = JSON.parse(readFileSync(join(f.pack, 'figure.json'), 'utf8'));
    figure.words.wave = ['missing'];
    writeFileSync(join(f.pack, 'figure.json'), JSON.stringify(figure));
    mkdirSync(join(f.root, 'config'));
    writeFileSync(f.note, 'previous-pack');
    const result = run(f.pack, f.note);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing');
    expect(readFileSync(f.note, 'utf8')).toBe('previous-pack');
  });
  it('checks without writing a selection and rejects an incomplete motion contract', () => {
    const f = fixture();
    expect(run(f.pack, f.note, '--check').status).toBe(0);
    expect(existsSync(f.note)).toBe(false);
    writeFileSync(join(f.pack, 'motion.cjs'), 'module.exports = {};');
    const result = run(f.pack, f.note);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('createMove');
    expect(existsSync(f.note)).toBe(false);
  });
});
