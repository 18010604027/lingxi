import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const key = (dir: string) => `--${dir.replace(/[:\\/]+/g, '-')}--`;
const move = (from: string, to: string) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'move-data.mjs'), '--from', from, '--to', to], { encoding: 'utf8' });

function oldData() {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-move-'));
  const from = join(root, 'data');
  const deploy = join(from, 'home', 'companion');
  mkdirSync(join(deploy, 'data', 'dsh-sessions', key(join(deploy, 'workspace')), 'session-1'), { recursive: true });
  mkdirSync(join(deploy, 'workspace'), { recursive: true });
  mkdirSync(join(from, 'home', 'providers', 'deepseek'), { recursive: true });
  writeFileSync(join(deploy, 'config.json'), '{"displayName":"灵犀"}');
  writeFileSync(join(deploy, 'guide.json'), '{}');
  writeFileSync(join(deploy, 'data', 'memory.sqlite'), 'memories');
  writeFileSync(join(deploy, 'workspace', 'PARTNER.md'), 'about them');
  writeFileSync(join(from, 'home', 'providers', 'deepseek', 'config.json'), '{}');
  return { root, from, deploy, to: join(root, 'lingxi-pet') };
}

describe('moving her data to her own place', () => {
  it('copies what she needs, leaves out what only the old app used, and keeps the old place as it was', () => {
    const { from, deploy, to } = oldData();
    const r = move(from, to);
    expect(r.status, r.stderr).toBe(0);
    const next = join(to, 'home', 'lingxi');
    expect(readFileSync(join(next, 'data', 'memory.sqlite'), 'utf8')).toBe('memories');
    expect(readFileSync(join(next, 'workspace', 'PARTNER.md'), 'utf8')).toBe('about them');
    expect(existsSync(join(to, 'home', 'providers', 'deepseek', 'config.json'))).toBe(true);
    expect(existsSync(join(next, 'guide.json'))).toBe(false);
    expect(existsSync(join(deploy, 'guide.json'))).toBe(true);
    // the roles' DSH sessions follow the workspace
    expect(readdirSync(join(next, 'data', 'dsh-sessions'))).toEqual([key(join(next, 'workspace'))]);
  });

  it('can run again: the earlier copy is put aside, not lost', () => {
    const { root, from, to } = oldData();
    expect(move(from, to).status).toBe(0);
    writeFileSync(join(to, 'home', 'lingxi', 'data', 'new-since.txt'), 'x');
    expect(move(from, to).status).toBe(0);
    const aside = readdirSync(root).find((n) => n.startsWith('lingxi-pet.before-'))!;
    expect(existsSync(join(root, aside, 'home', 'lingxi', 'data', 'new-since.txt'))).toBe(true);
    expect(existsSync(join(to, 'home', 'lingxi', 'data', 'new-since.txt'))).toBe(false);
  });

  it('will not move while she is running', () => {
    const { from, deploy, to } = oldData();
    writeFileSync(join(deploy, 'data', 'instance.lock'), JSON.stringify({ pid: process.pid }));
    expect(move(from, to).status).toBe(1);
    expect(existsSync(to)).toBe(false);
  });
});
