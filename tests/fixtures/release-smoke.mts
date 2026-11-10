/** Ordinary release entry check with a local provider and isolated Electron profiles. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { seed } from '../../core/seed.ts';

const root = mkdtempSync(join(tmpdir(), 'lingxi-release-smoke-'));
const home = join(root, 'home');
const data = join(home, 'lingxi', 'data');
mkdirSync(data, { recursive: true });
seed(home, 'zh');
const wait = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
async function until<T>(get: () => Promise<T | undefined>, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await get();
    if (value !== undefined && value !== false) return value;
    await wait(100);
  }
  throw new Error(`Ordinary sample did not complete: ${label}; root=${root}`);
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  return value;
}
const requests: unknown[] = [];
let releaseReply: () => void = () => {};
const replyGate = new Promise<void>(ready => { releaseReply = ready; });
const provider = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ model: body.model, messages: body.messages, tools: body.tools?.map((tool: any) => tool.function?.name) });
  const previous = body.messages?.findLast((message: any) => message.role === 'assistant');
  const say = raw.includes('发布验收问候') && previous?.tool_calls?.[0]?.function?.name !== 'pet_say';
  const name = say ? 'pet_say' : 'end_turn';
  if (say) await replyGate;
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: `sample-${requests.length}`, object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(say ? { script: '你好，发布版。' } : {}) } }] } }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  }));
});
await new Promise<void>(ready => provider.listen(0, '127.0.0.1', ready));
const apiPort = await port();
const debugPort = await port();
const workbenchPort = await port();
const token = randomBytes(24).toString('hex');
const endpoint = join(home, 'providers', 'local');
mkdirSync(endpoint, { recursive: true });
writeFileSync(join(home, 'lingxi', 'config.json'), JSON.stringify({ displayName: '灵犀', language: 'zh', activeProvider: 'local',
  worlds: { 'desktop-pet': { user: '伙伴' } }, codeAgents: { default: 'builtin', providers: {} } }));
writeFileSync(join(endpoint, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
  secret: 'LINGXI_RELEASE_SAMPLE_KEY', options: { protocol: 'chat' }, spec: { model: 'local-release-sample', thinking: false } }));
writeFileSync(join(data, 'lingxi-api.json'), JSON.stringify({ port: apiPort, token }));
const env = { ...process.env, LINGXI_HOME: home, LINGXI_MODELS_DIR: join(root, 'models'), LINGXI_PACK: process.env.LINGXI_PACK ?? resolve('tests/fixtures/pack'), LINGXI_CLIPS: process.env.LINGXI_CLIPS ?? resolve('tests/fixtures/pack/clips'),
  LINGXI_DEPLOYMENT: 'lingxi', LINGXI_RELEASE_SAMPLE_KEY: 'temporary-not-a-secret', LINGXI_SCREEN_ACCESS: 'off', LINGXI_RHYTHM: 'off',
  BODY_USER_DATA: join(root, 'body-profile'), BODY_USER_DATA_EXPECTED_ROOT: root, BODY_BOOT_MARKER: join(root, 'body-boot.jsonl'),
  BODY_DEBUG_PORT: String(debugPort), WORKBENCH_DEBUG_PORT: String(workbenchPort), WORKBENCH_USER_DATA_DIR: join(root, 'workbench-profile'), TRAY_USER_DATA_DIR: join(root, 'tray-profile') };
delete env.ELECTRON_RUN_AS_NODE;
let child: ChildProcess | undefined;
let socket: WebSocket | undefined;
const output: string[] = [];
async function api(path: string, method = 'GET', value?: unknown): Promise<any> {
  const result = await fetch(`http://127.0.0.1:${apiPort}/lingxi/${path}`, { method,
    headers: { 'X-Lingxi-Token': token, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
  const body = await result.json(); if (!result.ok) throw new Error(`API ${path}: ${JSON.stringify(body)}`); return body;
}
async function launch() {
  child = spawn(process.execPath, ['--import', 'tsx', resolve('core/start.ts')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const log = (chunk: Buffer) => { output.push(String(chunk)); appendFileSync(join(root, 'entry.log'), chunk); };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);
  writeFileSync(join(root, 'owned-process.json'), JSON.stringify({ pid: child.pid, parentPid: process.pid, root, entry: resolve('core/start.ts') }));
  await until(async () => {
    if (child!.exitCode !== null) throw new Error(`Entry exited ${child!.exitCode}: ${output.join('')}`);
    try { const state = await api('status'); return state.body?.connected ? state : undefined; } catch { return undefined; }
  }, 'independent entry and body connection');
}
async function quit() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  current.send({ type: 'quit' });
  await until(async () => current.exitCode !== null ? { code: current.exitCode } : undefined, 'normal application quit');
  if (current.exitCode !== 0) throw new Error(`Entry exited ${current.exitCode}: ${output.join('').slice(-6000)}`);
}
async function workbenchEvaluate(expression: string): Promise<any> {
  const pages = await fetch(`http://127.0.0.1:${workbenchPort}/json/list`).then(result => result.json()) as any[];
  const page = pages.find(row => row.type === 'page' && row.url.endsWith('/index.html'));
  if (!page) throw new Error('Workbench page not ready');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((ready, reject) => { ws.once('open', ready); ws.once('error', reject); });
  try {
    return await new Promise((ready, reject) => {
      ws.once('error', reject);
      ws.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else ready(message.result?.result?.value);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally { ws.close(); }
}
try {
  console.log(`RELEASE_SAMPLE_ROOT=${root}`);
  await launch();
  await until(async () => { try { return await workbenchEvaluate('!!window.lingxi'); } catch { return undefined; } }, 'workbench ready');
  for (const action of ['close', 'minimize']) {
    await workbenchEvaluate(`window.lingxi.window(${JSON.stringify(action)})`);
    child!.send({ type: 'show-workbench' });
    await until(async () => await workbenchEvaluate('(async () => (await window.lingxi.visible()) && document.hasFocus())()') || undefined,
      `normal workbench show after ${action}`);
  }
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(result => result.json()) as any[];
  const target = targets.find(row => row.url?.endsWith('/body.html'));
  if (!target) throw new Error('Body renderer missing');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((ready, reject) => { socket!.once('open', ready); socket!.once('error', reject); });
  let id = 0; const pending = new Map<number, (value: any) => void>();
  socket.on('message', chunk => { const row = JSON.parse(String(chunk)); if (row.id) { pending.get(row.id)?.(row); pending.delete(row.id); } });
  const cdp = (method: string, params: object = {}) => new Promise<any>(ready => { const key = ++id; pending.set(key, ready); socket!.send(JSON.stringify({ id: key, method, params })); });
  const evaluate = async (expression: string) => { const row = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (row.error || row.result?.exceptionDetails) throw new Error(JSON.stringify(row)); return row.result?.result?.value; };
  await evaluate('window.body.openTalk()');
  const talkTarget = await until(async () => {
    const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(result => result.json()) as any[];
    return pages.find(row => row.url?.endsWith('/talk.html'));
  }, 'floating input');
  const talk = new WebSocket(talkTarget.webSocketDebuggerUrl);
  await new Promise<void>(ready => talk.once('open', ready));
  talk.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.talk.send("发布验收问候，今天也一起好好工作吧。")' } }));
  talk.on('error', () => {}); talk.on('close', () => {});
  const layout = await until(async () => {
    const measured = await evaluate(`(() => {
    const input = document.querySelector('.bubble-line:not(.is-fading)');
    const thinking = document.querySelector('.bubble-thinking');
    if (!input || !thinking) return undefined;
    const a = input.getBoundingClientRect(), b = thinking.getBoundingClientRect();
    if (!input.style.top || !thinking.style.top) return undefined;
    const stage = document.querySelector('#stage').getBoundingClientRect();
    return { input: a.toJSON(), thinking: b.toJSON(), centre: stage.left + stage.width / 2, viewportWidth: innerWidth };
  })()`);
    if (measured) writeFileSync(join(root, 'bubble-layout.json'), JSON.stringify(measured, null, 2));
    // Native window growth and the existing stack easing settle over frames.
    return measured && Math.abs(measured.thinking.top - measured.input.bottom - 8) < 1 ? measured : undefined;
  }, 'input and thinking layout');
  for (const rect of [layout.input, layout.thinking]) {
    if (Math.abs(rect.left + rect.width / 2 - layout.centre) > 1 || rect.left < 7 || rect.right > layout.viewportWidth - 7) {
      throw new Error('Bubble is off-centre or outside the window');
    }
  }
  if (Math.abs(layout.thinking.top - layout.input.bottom - 8) > 1) throw new Error('Input and thinking gap is not 8px');
  writeFileSync(join(root, 'bubble-layout.json'), JSON.stringify(layout, null, 2));
  const waitingPicture = await cdp('Page.captureScreenshot');
  writeFileSync(join(root, 'body-thinking.png'), Buffer.from(waitingPicture.result.data, 'base64'));
  releaseReply();
  await until(async () => await evaluate('document.body.innerText.includes("你好，发布版。")') || undefined, 'visible body reply');
  const picture = await cdp('Page.captureScreenshot');
  if (!picture.result?.data) throw new Error('Body screenshot unavailable');
  writeFileSync(join(root, 'body-reply.png'), Buffer.from(picture.result.data, 'base64'));
  const delivered = await until(async () => {
    const shared = await api('outputs');
    return shared.receipts?.some((row: any) => row.channel === 'body' && row.state === 'completed') ? shared : undefined;
  }, 'actual body reply receipt');
  const state = await api('status');
  const settings = await api('runtime-settings');
  const memory = await api('history');
  const profile = readFileSync(join(root, 'body-boot.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
  if (!profile.every(row => row.userData === join(root, 'body-profile'))) throw new Error('Unexpected Electron profile');
  socket.close(); socket = undefined; talk.close();
  await quit();
  const beforeReopen = requests.length;
  await launch();
  const reopened = await api('outputs');
  if (reopened.outputs?.length !== delivered.outputs?.length) throw new Error('Normal reopen lost shared output');
  await quit();
  writeFileSync(join(root, 'evidence.json'), JSON.stringify({ root, standardProviderStub: true, realElectron: true, realPaidModel: false,
    state, settings, historyLines: memory.lines?.length, delivered, reopened, beforeReopen, requestsAfterReopen: requests.length, profile, normalExit: true }, null, 2));
  console.log(`RELEASE_SAMPLE_PASS=${join(root, 'evidence.json')}`);
} catch (error) {
  console.error('RELEASE_SAMPLE_FAILURE', error);
  throw error;
} finally {
  releaseReply();
  socket?.close();
  try { await quit(); } finally {
    writeFileSync(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
    provider.closeAllConnections();
    await new Promise<void>(done => provider.close(() => done()));
  }
}
