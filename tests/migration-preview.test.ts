import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('migration preview', () => {
  it('does not follow a linked data directory when checking WAL and lock hints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-migration-link-'));
    try {
      const source = join(dir, 'source');
      const outside = join(dir, 'outside');
      mkdirSync(source); mkdirSync(outside);
      writeFileSync(join(outside, 'bus.sqlite-wal'), 'outside');
      writeFileSync(join(outside, 'instance.lock'), 'outside');
      symlinkSync(outside, join(source, 'data'), 'junction');
      const script = join(process.cwd(), 'tools', 'migration-preview.mjs');
      const report = JSON.parse(execFileSync(process.execPath, [script, '--from', source], { encoding: 'utf8' }));
      expect(report.entries.find((entry: any) => entry.category === 'data')).toMatchObject({ files: 0, omitted: 1 });
      expect(report.hints).toEqual({ taskWalPresent: null, instanceLockPresent: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a missing deployment instead of reporting an empty inventory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-migration-missing-'));
    try {
      const script = join(process.cwd(), 'tools', 'migration-preview.mjs');
      expect(() => execFileSync(process.execPath, [script, '--from', join(dir, 'missing')], { stdio: 'pipe' })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reports only structure and omits provider and secret-looking files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-migration-'));
    try {
      mkdirSync(join(dir, 'workspace'), { recursive: true });
      mkdirSync(join(dir, 'data'), { recursive: true });
      mkdirSync(join(dir, 'workspace', 'providers', 'deepseek'), { recursive: true });
      writeFileSync(join(dir, 'workspace', 'CONSTITUTION.md'), 'private text');
      writeFileSync(join(dir, 'data', 'bus.sqlite'), 'fixture');
      writeFileSync(join(dir, 'data', 'bus.sqlite-wal'), 'unmerged transaction');
      writeFileSync(join(dir, 'data', 'instance.lock'), '{"secret":"do not report"}');
      writeFileSync(join(dir, 'workspace', 'providers', 'deepseek', 'config.json'), '{"secret":"do not report"}');
      const script = join(process.cwd(), 'tools', 'migration-preview.mjs');
      const run = () => JSON.parse(execFileSync(process.execPath, [script, '--from', dir], { encoding: 'utf8' }));
      const first = run(); const second = run();
      expect(first).toEqual(second);
      expect(first.readOnly).toBe(true);
      expect(first.entries.find((entry: any) => entry.category === 'workspace')).toMatchObject({ files: 1, omitted: 1 });
      expect(first.uninspected).toEqual(['providers', 'extensions']);
      expect(first.entries.find((entry: any) => entry.category === 'data')).toMatchObject({ files: 3 });
      expect(first.hints).toEqual({ taskWalPresent: true, instanceLockPresent: true });
      expect(JSON.stringify(first)).not.toContain('do not report');
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  });


});
