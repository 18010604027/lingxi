import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Playbook, PLAYBOOK } from '../core/agents/playbook.ts';

const ws = () => mkdtempSync(join(tmpdir(), 'playbook-'));

describe('Playbook', () => {
  it('seeds its shelves once and never overwrites an edited entry', () => {
    const dir = ws();
    const p = new Playbook(dir);
    p.seed();
    const file = join(dir, PLAYBOOK.catalog, 'wakeups.md');
    expect(readFileSync(file, 'utf8')).toContain('title: The wake table');
    writeFileSync(file, '---\ntitle: Wakes (edited)\nwhen: x\nstatus: active\n---\n');
    p.seed();
    expect(readFileSync(file, 'utf8')).toContain('(edited)');
  });

  it('indexes active entries one line each and leaves retired ones out', () => {
    const dir = ws();
    const p = new Playbook(dir);
    p.seed();
    writeFileSync(join(dir, PLAYBOOK.rules, 'old-way.md'), '---\ntitle: Old way\nwhen: never\nstatus: retired\n---\n');
    writeFileSync(join(dir, PLAYBOOK.rules, 'ask-first.md'), '---\ntitle: Ask first\nwhen: before anything irreversible  # note\nstatus: active\n---\nbody');
    expect(p.index('rules').split('\n')).toEqual([
      '- control/rules/ask-first.md — Ask first: before anything irreversible',
      '- control/rules/reminder-kind.md — Simple or smart reminder: setting up or changing a reminder',
      '- control/rules/rhythm-tuning.md — Tuning the pet\'s own rhythm: the person reacts to the pet speaking on its own, or asks it to talk more or less',
    ]);
  });

  it('briefs the control center with the catalog first and a code agent with the standards first', () => {
    const p = new Playbook(ws());
    p.seed();
    const control = p.brief('control');
    expect(control.indexOf('Catalog')).toBeLessThan(control.indexOf('Your rules'));
    expect(control).toContain('daily/catalog/wakeups.md — The wake table');
    const coder = p.brief('coder');
    expect(coder.indexOf('Standards:')).toBeLessThan(coder.indexOf('Catalog:'));
    expect(coder).toContain('control/standards/daily-layer-piece.md');
  });

  it('says when a shelf has outgrown its index', () => {
    const dir = ws();
    const p = new Playbook(dir);
    p.seed();
    for (let i = 0; i < 105; i++) writeFileSync(join(dir, PLAYBOOK.rules, `r${String(i).padStart(3, '0')}.md`), `---\ntitle: r${i}\nstatus: active\n---\n`);
    const lines = p.index('rules').split('\n');
    expect(lines).toHaveLength(101);
    expect(lines.at(-1)).toBe('(7 more not listed: this shelf needs merging)');
  });

  it('retires the old reminders entry the wake table replaced, keeping it for the record', () => {
    const dir = ws();
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(dir, PLAYBOOK.catalog), { recursive: true });
    writeFileSync(join(dir, PLAYBOOK.catalog, 'reminders.md'), '---\ntitle: Reminders\nwhen: x\nstatus: active\n---\nold');
    new Playbook(dir).seed();
    const text = readFileSync(join(dir, PLAYBOOK.catalog, 'reminders.md'), 'utf8');
    expect(text).toContain('status: retired');
    expect(text).toContain('supersededBy: wakeups.md');
    expect(new Playbook(dir).index('catalog')).not.toContain('reminders.md');
  });
});

