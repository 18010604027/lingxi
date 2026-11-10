import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { runMemory } from '../core/runtime/memory-runner.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';

describe('standard memory calls', () => {
  it('makes one standard model call with supplied system and memory content', async () => {
    const model = new ScriptedModel([new AIMessage('整理结果')]);
    await expect(runMemory({ model, system: '整理', text: '材料', sessionId: 'memory' })).resolves.toBe('整理结果');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].map((message) => [message.getType(), message.content])).toEqual([['system', '整理'], ['human', '材料']]);
  });

  it('passes an image as a standard multimodal message without saving another history', async () => {
    const model = new ScriptedModel([new AIMessage('看到了')]);
    await runMemory({ model, system: '看', text: '窗口', image: new Uint8Array([1, 2, 3]), sessionId: 'memory-image' });
    expect(model.requests[0][1].content).toEqual([
      { type: 'text', text: '窗口' }, { type: 'image_url', image_url: 'data:image/jpeg;base64,AQID' },
    ]);
  });

  it('rejects an empty model response', async () => {
    const model = new ScriptedModel([new AIMessage('')]);
    await expect(runMemory({ model, system: 's', text: 'u', sessionId: 'memory' })).rejects.toThrow('Memory model returned no text');
  });
});
