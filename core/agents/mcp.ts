/**
 * The pet's tools as an MCP server on localhost, for the control center when it runs in DeepSeek Harness: each ACP
 * session is given this server with a path naming its task, so the tools act for that task's incident. Requests need
 * the bearer token made at start, so other programs on the machine cannot call in. Stateless Streamable HTTP: a fresh
 * MCP server per request, as the SDK documents for servers without sessions.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef } from '../contracts.ts';

/** The ACP `McpServer` entry of the HTTP kind. */
export interface AcpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

const quietLog = { emit: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

export class PetToolServer {
  private readonly token = randomBytes(24).toString('hex');
  private http: HttpServer | null = null;
  private port = 0;
  private readonly toolsFor: (key: string) => ToolDef[] | null;

  /** `toolsFor(key)` gives the tools for the task named by a request's path, or null for an unknown one. */
  constructor(toolsFor: (key: string) => ToolDef[] | null) {
    this.toolsFor = toolsFor;
  }

  async start(): Promise<void> {
    if (this.http) return;
    const http = createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => resolve());
    });
    http.unref();
    this.http = http;
    this.port = (http.address() as AddressInfo).port;
  }

  /** The entry to hand an ACP `session/new` for the task `key`. */
  entry(key: string): AcpMcpServer {
    if (!this.http) throw new Error('the tool server is not started');
    return {
      type: 'http', name: 'pet',
      url: `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(key)}`,
      headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }],
    };
  }

  async close(): Promise<void> {
    const http = this.http;
    this.http = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/mcp\/([^/?]+)/.exec(req.url ?? '');
    if (req.headers.authorization !== `Bearer ${this.token}`) return end(res, 401, 'unauthorized');
    const tools = m ? this.toolsFor(decodeURIComponent(m[1]!)) : null;
    if (!tools) return end(res, 404, 'unknown task');
    if (req.method !== 'POST') return end(res, 405, 'stateless server: POST only');
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { return end(res, 400, 'bad JSON'); }
    const server = mcpServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

function mcpServer(tools: ToolDef[]): Server {
  const server = new Server({ name: 'pet', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: 'object' } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) return { content: [{ type: 'text', text: `[unknown tool] ${request.params.name}` }], isError: true };
    try {
      const out = await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>, { role: 'control', log: quietLog as never });
      const text = typeof out === 'string' ? out : out.text;
      return { content: [{ type: 'text', text }], isError: typeof out !== 'string' && out.failed === true };
    } catch (error) {
      return { content: [{ type: 'text', text: `[failed] ${(error as Error).message}` }], isError: true };
    }
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { data += chunk; if (data.length > 1_000_000) req.destroy(new Error('too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function end(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(text);
}
