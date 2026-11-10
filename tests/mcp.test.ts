import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDef } from '../core/contracts.ts';
import { PetToolServer } from '../core/agents/mcp.ts';

const echo: ToolDef = {
  name: 'echo', description: 'Echo the text.', tags: ['read'],
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: async (args) => `echo ${String(args.text)}`,
};
const broken: ToolDef = { ...echo, name: 'broken', handler: async () => ({ text: 'nope', failed: true }) };

let servers: PetToolServer[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => s.close())); servers = []; });

async function connect(server: PetToolServer, key: string, token?: string) {
  const entry = server.entry(key);
  const headers = Object.fromEntries(entry.headers.map((h) => [h.name, token ?? h.value]));
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } }));
  return client;
}

describe('PetToolServer', () => {
  it('serves the tools of the task named in the path to a client with the token', async () => {
    const server = new PetToolServer((key) => (key === 'task-1' ? [echo, broken] : null));
    servers.push(server);
    await server.start();
    const client = await connect(server, 'task-1');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo', 'broken']);
    expect(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).toMatchObject({ content: [{ type: 'text', text: 'echo hi' }] });
    expect(await client.callTool({ name: 'broken', arguments: {} })).toMatchObject({ isError: true });
    await client.close();
  });

  it('turns away a wrong token and an unknown task', async () => {
    const server = new PetToolServer(() => null);
    servers.push(server);
    await server.start();
    const entry = server.entry('nobody');
    const post = (auth: string) => fetch(entry.url, { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect((await post('Bearer wrong')).status).toBe(401);
    expect((await post(entry.headers[0]!.value)).status).toBe(404);
  });
});
