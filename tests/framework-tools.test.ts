import { describe, expect, it } from 'vitest';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { ToolDef } from '../core/contracts.ts';
import { adaptTool, SerialToolGate } from '../core/runtime/tools.ts';
const log = console;
const declaration: ToolDef = {
  name: 'read_material', description: 'Read a supplied fragment', tags: ['read'],
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  handler: async ({ text }, ctx) => `${ctx.role}:${ctx.callId}:${text}`,
};
describe('standard framework tool adapter', () => {
  it('passes validated tool calls and their identity to the existing handler', async () => {
    const tool = adaptTool(declaration, { role: 'control', log });
    const out = await tool.invoke({ type: 'tool_call', id: 'call-1', name: 'read_material', args: { text: 'sample' } });
    expect(out.content).toBe('control:call-1:sample');
    await expect(tool.invoke({ text: 3 })).rejects.toThrow();
  });

  it('does not silently discard failures, attachments or execution barriers', async () => {

    const failed = adaptTool({ ...declaration, handler: async () => ({ text: 'not available', failed: true }) }, { role: 'control', log });
    await expect(failed.invoke({ text: 'x' })).rejects.toThrow('not available');
    const attachment = adaptTool({ ...declaration, handler: async () => ({ text: 'image', blobs: [{ handle: 'mem:test', fallbackText: 'image' }] }) }, { role: 'control', log });
    await expect(attachment.invoke({ text: 'x' })).rejects.toThrow('cannot preserve');
  });

  it('passes the cancellation signal to the existing tool', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const tool = adaptTool({ ...declaration, handler: async (_args, context) => { signal = context.signal; return 'done'; } }, { role: 'control', log });
    await tool.invoke({ text: 'x' }, { signal: controller.signal });
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('serializes tools that the framework presents in parallel', async () => {
    const gate = new SerialToolGate();
    const active: string[] = [];
    const order: string[] = [];
    const make = (name: string) => adaptTool({ ...declaration, name, handler: async () => {
      active.push(name); expect(active).toHaveLength(1); order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${name}:end`); active.pop(); return name;
    } }, { role: 'control', log }, { gate });
    await Promise.all([make('one').invoke({ text: 'x' }), make('two').invoke({ text: 'x' })]);
    expect(order).toEqual(['one:start', 'one:end', 'two:start', 'two:end']);
  });

  it('does not start a queued tool after its signal was cancelled', async () => {
    const gate = new SerialToolGate();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let began = false;
    const first = adaptTool({ ...declaration, name: 'first', handler: async () => { await waiting; return 'done'; } }, { role: 'control', log }, { gate });
    const second = adaptTool({ ...declaration, name: 'second', handler: async () => { began = true; return 'done'; } }, { role: 'control', log }, { gate });
    const controller = new AbortController();
    const a = first.invoke({ text: 'x' });
    const b = second.invoke({ text: 'x' }, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    release();
    await a;
    await expect(b).rejects.toThrow();
    expect(began).toBe(false);
  });

  it('runs past the framework default step cutoff when explicitly disabled', async () => {
    const state = Annotation.Root({ n: Annotation<number>({ reducer: (_old, next) => next, default: () => 0 }) });
    const graph = new StateGraph(state).addNode('step', (s) => ({ n: s.n + 1 }))
      .addEdge(START, 'step').addConditionalEdges('step', (s) => s.n === 30 ? END : 'step').compile();
    expect(await graph.invoke({ n: 0 }, { recursionLimit: Infinity })).toEqual({ n: 30 });
  });
});
