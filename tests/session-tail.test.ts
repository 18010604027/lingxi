import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { LingxiPersona } from '../core/persona.ts';
import { createFrontAgent } from '../core/runtime/front-agent.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';

describe('persona context in the standard conversation', () => {
  it('reads updated speaking style on the next request and keeps it out of persisted history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-session-context-'));
    const persona = new LingxiPersona({ memoryDir: dir });
    const model = new ScriptedModel([new AIMessage('你好'), new AIMessage('继续')]);
    const front = createFrontAgent({ model, tools: [], log: console,
      checkpointPath: join(dir, 'checkpoint.sqlite'), readContext: () => persona.context() });
    try {
      writeFileSync(join(dir, 'CONSTITUTION.md'), '# Self\n\n## 说话方式\n自然简短。\n');
      await front.turn({sessionId:'front',text:'你好'});
      writeFileSync(join(dir, 'CONSTITUTION.md'), '# Self\n\n## 说话方式\n语气平静。\n');
      await front.turn({sessionId:'front',text:'继续'});
      expect(JSON.stringify(model.requests[0])).toContain('自然简短。');
      expect(JSON.stringify(model.requests[1])).toContain('语气平静。');
      expect(JSON.stringify(model.requests[1])).not.toContain('自然简短。');
      expect(JSON.stringify(await front.history('front'))).not.toMatch(/自然简短|语气平静/);
    } finally { await front.close(); persona.close(); rmSync(dir,{recursive:true,force:true}); }
  });
});
