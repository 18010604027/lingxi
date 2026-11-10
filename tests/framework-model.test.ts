import { describe, expect, it } from 'vitest';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { runControl } from '../core/runtime/control-runner.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';

const log = { warn() {} } as never;
describe('standard control runner', () => {
  it('lets the standard agent call a business tool and deliver its final result', async () => {
    const seen: string[] = [];
    const model = new ScriptedModel([
      new AIMessage({ content: '', tool_calls: [{ id: 'read-1', name: 'read_material', args: { text: '材料' } }] }),
      new AIMessage('整理完成。'),
    ]);
    const result = await runControl({ model, system: '整理后台任务。', task: '帮我整理材料。', sessionId: 'task-1',
      log, signal: new AbortController().signal, tools: [{
        name: 'read_material', description: 'Read supplied material.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, tags: ['read'],
        handler: async ({ text }, context) => { seen.push(`${context.role}:${context.callId}:${text}`); return '已读材料。'; },
      }] });
    expect(result).toEqual({ text: '整理完成。', toolErrors: [] });
    expect(seen).toEqual(['control:read-1:材料']);
    expect(model.requests[1].some((message) => ToolMessage.isInstance(message) && message.content === '已读材料。')).toBe(true);
  });

  it('reports tool failure to the model and keeps its resulting decision', async () => {
    const model = new ScriptedModel([
      new AIMessage({ content: '', tool_calls: [{ id: 'fail-1', name: 'read_material', args: {} }] }),
      new AIMessage('这个来源没有读到，请提供材料。'),
    ]);
    const result = await runControl({ model, system: '整理。', task: '读材料。', sessionId: 'task-2', log,
      signal: new AbortController().signal, tools: [{ name: 'read_material', description: 'Read.', tags: ['read'], parameters: { type: 'object', properties: {} },
        handler: async () => ({ text: 'Source unavailable.', failed: true }) }] });
    expect(result.text).toBe('这个来源没有读到，请提供材料。');
    expect(result.toolErrors).toEqual([expect.objectContaining({ name: 'read_material', callId: 'fail-1', detail: expect.stringContaining('Source unavailable.') })]);
  });

  it('passes supplied case images to the standard model', async () => {
    const model = new ScriptedModel([new AIMessage('看到了。')]);
    await runControl({ model, system: '看图。', task: '这是什么？', images: [new Uint8Array([1, 2, 3])], sessionId: 'task-3',
      log, signal: new AbortController().signal, tools: [] });
    expect(model.requests[0][1].content).toEqual([{ type: 'text', text: '这是什么？' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID', detail: 'high' } }]);
  });
});
