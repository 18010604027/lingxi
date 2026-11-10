import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { acceptsImages, createModel, endpointName, locate, OFF_PEAK, plainRemote, prepareMessages, protocolOf, regionsOf, siteOf, validateEntry, VENDORS, vendorEntry, vendorOf, vendorPrices, type ProviderEntry } from '../src/index.ts';

const entry = (patch: Partial<ProviderEntry> = {}): ProviderEntry => ({ baseUrl: 'https://api.deepseek.com', spec: { model: 'deepseek-flash', thinking: true, reasoningEffort: 'high' }, multimodal: true, ...patch });
const textResponse = () => ({ id: 'resp_local', object: 'response', model: 'deepseek-flash', status: 'completed', created_at: 1,
  output: [{ type: 'message', id: 'msg_local', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好', annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 } } });
let server: Server | undefined;
afterEach(async () => { if (server) { const current = server; server = undefined; current.closeAllConnections(); await new Promise<void>((resolve) => current.close(() => resolve())); } });
async function stub(reply?: (path: string, body: Record<string, any>) => object) {
  const seen: Array<{ path: string; auth?: string; body: Record<string, any> }> = [];
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const path = req.url ?? '';
    seen.push({ path, auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply?.(path, body) ?? textResponse()));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const image = { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,anBlZw==' } };
const toolCall = () => new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'clock', args: {} }] });

describe('the independent LangChain provider', () => {
  it('keeps the existing HTTP address rule and validates before model creation', () => {
    for (const url of ['http://127.0.0.1:8080', 'http://localhost:11434/v1', 'http://192.168.1.20:8000', 'http://10.0.0.5', 'http://172.20.1.1', 'http://100.101.102.103', 'http://nas.local', 'http://[fd12::1]', 'https://relay.example.com']) expect(() => validateEntry(entry({ baseUrl: url }))).not.toThrow();
    for (const url of ['http://relay.example.com/v1', 'http://8.8.8.8', 'http://172.32.0.1']) { expect(plainRemote(url)).toBe(true); expect(() => createModel(entry({ baseUrl: url }))).toThrow('https'); }
  });
  it('uses the actual standard model and preserves configured effort/limits', () => {
    const model = createModel(entry({ spec: { model: 'm', thinking: false, temperature: 0.3, maxTokens: 123 } }), { apiKey: 'test' });
    expect(model).toBeInstanceOf(ChatOpenAI); expect(model.useResponsesApi).toBe(true); expect(model.reasoning).toEqual({ effort: 'none' }); expect(model.temperature).toBe(0.3); expect(model.maxTokens).toBe(123);
  });
  it('posts to Responses with the supplied key and stateless thinking-off request', async () => {
    const { url, seen } = await stub(); const model = createModel(entry({ baseUrl: url, spec: { model: 'deepseek-flash', thinking: false } }), { apiKey: 'sk-test' });
    const out = await model.invoke([new HumanMessage('在吗')]);
    expect(seen[0]).toMatchObject({ path: '/responses', auth: 'Bearer sk-test', body: { store: false, reasoning: { effort: 'none' } } });
    expect(seen[0].body.include).toBeUndefined(); expect(out.text).toBe('你好'); expect(out.usage_metadata).toMatchObject({ input_tokens: 10, output_tokens: 2, input_token_details: { cache_read: 4 } });
  });
  it('does not send an unrelated credential to a keyless endpoint', async () => {
    const { url, seen } = await stub(); await createModel(entry({ baseUrl: url })).invoke([new HumanMessage('在吗')]); expect(seen[0].auth).toBe('Bearer not-required');
  });
  it('keeps protocol choice and endpoint table without a provider registry', () => {
    expect(protocolOf(entry())).toBe('responses'); expect(protocolOf(entry({ options: { protocol: 'chat' } }))).toBe('chat'); expect(protocolOf(entry({ options: { protocol: '' } }))).toBe('responses');
    const vendor = VENDORS[0]!; expect(locate(`${siteOf(vendor, 'cn').baseUrl}/`)?.vendor.id).toBe(vendor.id); expect(vendorEntry(vendor)).toMatchObject({ kind: 'lingxi', secret: vendor.secret }); expect(regionsOf(vendor)).toEqual([]); expect(endpointName(vendor, 'intl')).toBe('deepseek'); expect(vendorOf('http://127.0.0.1:1234')).toBeNull();
  });
  it('uses the real Chat adapter for text and tool calls', async () => {
    const { url, seen } = await stub(() => ({ id: 'chat_local', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'clock', arguments: '{"zone":"UTC"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    const model = createModel(entry({ baseUrl: url, options: { protocol: 'chat' }, spec: { model: 'm', thinking: false } }), { apiKey: 'sk-test' });
    const out = await model.bindTools([{ name: 'clock', description: 'Time', schema: { type: 'object', properties: { zone: { type: 'string' } } } }]).invoke([new HumanMessage('几点')]);
    expect(seen[0]).toMatchObject({ path: '/chat/completions', auth: 'Bearer sk-test', body: { reasoning_effort: 'none' } }); expect(out.tool_calls).toMatchObject([{ id: 'c1', name: 'clock', args: { zone: 'UTC' } }]);
  });
  it('keeps endpoint image policy and only the newest delivered image batch', () => {
    expect(acceptsImages(entry())).toBe(true); expect(acceptsImages(entry({ spec: { model: 'deepseek-v4-pro' } }))).toBe(false);
    const history = [new HumanMessage({ content: [{ type: 'text', text: 'old' }, image] }), new HumanMessage('new'), new ToolMessage({ content: [image], tool_call_id: 'c' })];
    const prepared = prepareMessages(history, entry()); expect(prepared[0].content).toEqual([{ type: 'text', text: 'old' }]); expect(prepared[2].content).toEqual([image]); expect(history[0].content).toHaveLength(2);
    expect(prepareMessages(history, entry({ multimodal: false }))[2].content).toEqual([]);
  });
  it('moves Chat tool result images after the complete result group', () => {
    const history = [new HumanMessage('look'), new ToolMessage({ content: [image], tool_call_id: 'a' }), new ToolMessage({ content: 'ok', tool_call_id: 'b' })];
    const prepared = prepareMessages(history, entry({ options: { protocol: 'chat' } })); expect(prepared.map(x => x.type)).toEqual(['human', 'tool', 'tool', 'human']); expect(prepared[1].content).toBe('[image]'); expect(prepared[3].content).toEqual([image]);
  });
  it('preserves DeepSeek plaintext placeholder through the actual Responses adapter', async () => {
    const { url, seen } = await stub(); const policy = entry(); const history = [new HumanMessage('几点'), toolCall(), new ToolMessage({ content: '12:00', tool_call_id: 'call_1' })];
    const prepared = prepareMessages(history, policy); await createModel(entry({ baseUrl: url })).invoke(prepared);
    expect(seen[0].body.reasoning).toEqual({ effort: 'high' });
    const input = seen[0].body.input; expect(input.map((x: any) => x.type)).toContain('reasoning'); expect(input.find((x: any) => x.type === 'reasoning').content).toEqual([{ type: 'reasoning_text', text: '-' }]); expect(history[1].additional_kwargs.reasoning).toBeUndefined();
  });
  it('drops past reasoning on request while retaining the active round', () => {
    const old = new AIMessage({ content: '', additional_kwargs: { reasoning_content: 'old thought' } }); const current = new AIMessage({ content: '', additional_kwargs: { reasoning_content: 'new thought' } });
    const messages = [old, new HumanMessage('next'), current]; const prepared = prepareMessages(messages, entry(), { keepThinking: false }); expect(prepared[0].additional_kwargs.reasoning).toBeUndefined(); expect(prepared[2].additional_kwargs.reasoning).toMatchObject({ content: [{ text: 'new thought' }] }); expect(prepareMessages(messages, entry({ spec: { model: 'm', thinking: false } }))[2].additional_kwargs.reasoning).toBeUndefined();
  });
  it('retains the existing dated price table as standalone data', () => {
    const [price] = vendorPrices('deepseek', '2026-10-08'); expect(price.rules[1].perMillion).toBe(OFF_PEAK['deepseek-flash'].uncachedInput); expect(price.timeWindows?.[0].rules[1].perMillion).toBe(OFF_PEAK['deepseek-flash'].uncachedInput * 2); expect(vendorPrices(undefined, '')).toEqual([]);
  });
  it.each(['chat', 'responses'] as const)('uses the standard %s stream for incremental tool arguments', async (protocol) => {
    server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (protocol === 'chat') {
        emit({ id: 's', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'clock', arguments: '{"zone":' } }] }, finish_reason: null }] });
        emit({ id: 's', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] }, finish_reason: 'tool_calls' }] }); res.end('data: [DONE]\n\n');
      } else {
        const base = { ...textResponse(), id: 's', model: 'm', output: [] }; const call = { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'clock', arguments: '', status: 'in_progress' };
        emit({ type: 'response.created', sequence_number: 0, response: { ...base, status: 'in_progress' } }); emit({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: call });
        emit({ type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: 'fc1', output_index: 0, delta: '{"zone":' }); emit({ type: 'response.function_call_arguments.delta', sequence_number: 3, item_id: 'fc1', output_index: 0, delta: '"UTC"}' });
        const done = { ...call, arguments: '{"zone":"UTC"}', status: 'completed' }; emit({ type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: done }); emit({ type: 'response.completed', sequence_number: 5, response: { ...base, output: [done] } }); res.end();
      }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const model = createModel(entry({ baseUrl: url, options: { protocol }, spec: { model: 'm', thinking: false } })); let result: AIMessageChunk | undefined;
    for await (const chunk of await model.stream([new HumanMessage('time')])) result = result ? result.concat(chunk) : chunk;
    expect(result?.tool_calls).toMatchObject([{ id: 'c1', name: 'clock', args: { zone: 'UTC' } }]);
  });
});
