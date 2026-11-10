import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LingxiPersona, NOW_REMINDER, PARTNER_NOTE, PREFIX_COPY_NOTE, gapNote, speakingStyle } from '../core/persona.ts';
import { AppEvents } from '../core/runtime/app-events.ts';
import type { EventEnvelope } from '../core/contracts.ts';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const call = { role: 'front', log };
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-independent-persona-'));
  const memoryDir = join(root, 'workspace');
  const dataDir = join(root, 'data');
  mkdirSync(memoryDir); mkdirSync(dataDir);
  return { root, memoryDir, dataDir };
}

describe('independent persona and workspace memory', () => {
  it('keeps file memory, live character/partner context and Git history without a base persona', async () => {
    const { root, memoryDir } = setup();
    const persona = new LingxiPersona({ memoryDir, log });
    const tool = (name: string) => persona.fileTools().find((entry) => entry.name === name)!;
    try {
      await tool('write_file').handler({ path: 'CONSTITUTION.md', content: '# 我是谁\n小鱼的伙伴\n## 说话方式\n简短自然。' }, call);
      await tool('write_file').handler({ path: 'PARTNER.md', content: '喜欢猫和薄荷茶。' }, call);
      await tool('write_file').handler({ path: 'partner/drinks.md', content: '薄荷茶\n温水' }, call);
      await tool('append_file').handler({ path: 'partner/drinks.md', content: '\n咖啡' }, call);
      expect(await tool('read_file').handler({ path: 'PARTNER.md' }, call)).toContain(PREFIX_COPY_NOTE);
      expect(await tool('glob_files').handler({ pattern: 'partner/*.md' }, call)).toContain('partner/drinks.md');
      expect(await tool('grep_files').handler({ query: '薄荷' }, call)).toContain('partner/drinks.md:1: 薄荷茶');
      expect(await tool('list_files').handler({ dir: 'partner' }, call)).toBe('drinks.md');
      const context = await persona.context();
      expect(context.system).toContain(PARTNER_NOTE);
      expect(context.system).toContain('喜欢猫和薄荷茶。');
      expect(context.tail).toContain(`${NOW_REMINDER}\n简短自然。`);
      persona.snapshot('test-1');
      if (persona.gitAvailable()) {
        expect(existsSync(join(memoryDir, '.git', 'refs', 'tags', 'start-test-1'))).toBe(true);
        expect(readFileSync(join(memoryDir, '.git', 'logs', 'HEAD'), 'utf8')).toContain('Lingxi wrote partner/drinks.md');
      }
      await persona.saveConstitution('## 说话方式\n轻松一点。');
      expect((await persona.context()).tail).toContain('轻松一点。');
    } finally { await persona.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps filesystem reads/writes inside the workspace and background writes inside their own roots', async () => {
    const { root, memoryDir } = setup();
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.txt'), 'outside');
    const persona = new LingxiPersona({ memoryDir, log });
    const tool = (name: string) => persona.fileTools().find((entry) => entry.name === name)!;
    try {
      symlinkSync(outside, join(memoryDir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(await tool('read_file').handler({ path: '../outside/private.txt' }, call)).toMatchObject({ failed: true });
      expect(await tool('read_file').handler({ path: 'alias/private.txt' }, call)).toMatchObject({ failed: true });
      expect(await tool('write_file').handler({ path: 'PARTNER.md', content: 'x' }, { ...call, role: 'control' })).toMatchObject({ failed: true });
      expect(await tool('write_file').handler({ path: 'control/drafts/note.md', content: '草稿' }, { ...call, role: 'coder' })).toBe('[written] control/drafts/note.md');
      expect(existsSync(join(memoryDir, 'PARTNER.md'))).toBe(false);
      await tool('write_file').handler({ path: 'partner/portrait.md', content: 'Original portrait.' }, call);
      symlinkSync(join(memoryDir, 'partner'), join(memoryDir, 'control', 'drafts', 'portrait'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(await tool('write_file').handler({ path: 'control/drafts/portrait/portrait.md', content: 'x' }, { ...call, role: 'coder' })).toMatchObject({ failed: true });
      expect(readFileSync(join(memoryDir, 'partner', 'portrait.md'), 'utf8')).toBe('Original portrait.');
      expect(readFileSync(join(outside, 'private.txt'), 'utf8')).toBe('outside');
    } finally { await persona.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('feeds old archives and new app events into the original index, cards, graph and used feedback', async () => {
    const { root, memoryDir, dataDir } = setup();
    const run = join(dataDir, 'runs', 'old'); mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'events.jsonl'), JSON.stringify({ cursor: 1, ts: '2026-01-01T10:00:00Z', type: 'pet.message',
      origin: 'external', text: '我喜欢薄荷茶。', source: 'pet' }) + '\n');
    const persona = new LingxiPersona({ memoryDir, dataDir, log });
    const events = new AppEvents(join(dataDir, 'events.sqlite')); persona.setStore(events);
    try {
      const next = events.push({ type: 'pet.message', origin: 'external', source: 'pet', ts: new Date().toISOString(), text: '薄荷茶怎么样？' });
      await persona.onEvents([next]);
      expect(persona.eventMemory!.recentLines().map((line) => line.text)).toEqual(['我喜欢薄荷茶。', '薄荷茶怎么样？']);
      expect(persona.memoryGraph!.ticks).toBe(2);
      expect(persona.memoryVectors).not.toBeNull();
      expect((await persona.context()).tail).toContain('comes to mind');
      const lines = persona.eventMemory!.blockLines(1);
      persona.eventMemory!.putCards(1, [{ title: '茶的偏好', summary: '喜欢薄荷茶。', importance: 0.7, from: 1, to: 1,
        lineRefs: lines, items: [{ kind: 'fact', subject: '小鱼', text: '喜欢薄荷茶。', when: null, lines: [1] }] }], 'done', null);
      expect(persona.memoryGraph!.nodeByRef('card:1')).not.toBeNull();
      const recalled = await persona.graphRecall!.recall('薄荷茶');
      const mark = recalled.match(/#m\d+/)?.[0]; expect(mark).toBeTruthy();
      const strengthen = vi.spyOn(persona.memoryGraph!, 'coRecalled');
      let spoken = '';
      const say = persona.frontTools([{ name: 'pet_say', description: 'Speak.', tags: ['speak'], parameters: { type: 'object', properties: {} },
        handler: async (args) => { spoken = String(args.script); expect(args).not.toHaveProperty('used'); return 'spoken'; } }]).find((tool) => tool.name === 'pet_say')!;
      await say.handler({ script: '我记得你喜欢薄荷茶。', used: [mark] }, call);
      expect(spoken).toContain('薄荷茶'); expect(strengthen).toHaveBeenCalled();
      const last = events.push({ type: 'pet.message', origin: 'external', source: 'pet', ts: new Date().toISOString(), text: '对，薄荷茶。' });
      await persona.onEvents([last]);
      expect(persona.memoryGraph!.ticks).toBe(3);
      expect(strengthen.mock.calls.length).toBeGreaterThan(1);
    } finally { await persona.close(); events.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps quiet action and interaction times in current context without waking a conversation', async () => {
    const { root, memoryDir, dataDir } = setup();
    const persona = new LingxiPersona({ memoryDir });
    const events = new AppEvents(join(dataDir, 'events.sqlite')); persona.setStore(events);
    persona.setLiveContext(() => 'Your name: 小鱼; body feeling: rested; front processing: processing');
    try {
      const push = (type: string, ts: string, meta: Record<string, unknown>) => events.push({ type, ts, meta, origin: 'external', source: 'pet', text: '', contextDelivery: 'archive-only' });
      push('pet.action', '2030-01-01T10:00:00Z', { actionId: 'a1', action: 'wave', state: 'started' });
      push('pet.action', '2030-01-01T10:00:02Z', { actionId: 'a1', action: 'wave', state: 'completed' });
      push('pet.interaction', '2030-01-01T10:01:00Z', { interactionId: 'click-1', kind: 'click', state: 'clicked' });
      push('pet.interaction', '2030-01-01T10:02:00Z', { interactionId: 'drag-1', kind: 'drag-end', state: 'dropped', from: 0.1, x: 0.5 });
      const context = await persona.context();
      expect(context.tail).toContain('started=2030-01-01T10:00:00Z; ended=2030-01-01T10:00:02Z');
      expect(context.tail).toContain('interactionId=click-1; state=clicked; at=2030-01-01T10:01:00Z');
      expect(context.tail).toContain('interactionId=drag-1');
      expect(context.tail).toContain('current time:');
      expect(context.tail).toContain('front processing: processing');
    } finally { await persona.close(); events.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

it('retains the existing style and gap helpers', () => {
  expect(speakingStyle('## 说话方式\n自然。\n## 其他\n不要混入')).toBe('自然。');
  expect(gapNote(1000, Date.now())).toBeNull();
  expect(gapNote(2 * 3600000, Date.now())).toContain('2 h');
});
