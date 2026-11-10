import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PetWorld } from '../../core/pet/world.ts';
import { startApi } from '../../core/pet/api.ts';
import { EventMemory, historySince } from '../../core/memory/events.ts';
import { AppEvents } from '../../core/runtime/app-events.ts';

const dir = mkdtempSync(join(tmpdir(), 'lingxi-output-electron-'));
const profile = join(dir, 'electron-profile');
mkdirSync(profile);
const store = new AppEvents(join(dir, 'events.sqlite'));
const memory = new EventMemory(dir); memory.attachStore(store);
const world = new PetWorld({
  link: Object.assign(new EventEmitter(), { connected: false, x: 0.5, send: () => { throw new Error('offline body must not receive commands'); } }) as never,
  behavior: Object.assign(new EventEmitter(), { keptOut: [] }) as never,
  figure: { moves: { walk: [], run: [] }, words: {}, vocab: {} } as never,
  timezone: 'Asia/Shanghai', userName: () => '测试者',
});
await world.start({ store, pushEvent: async (event: object) => store.push({ origin: 'external', ...event } as never) } as never);
await world.tools().find((tool) => tool.name === 'pet_say')!.handler({ script: '离线窗口文字' }, {} as never);
await world.tools().find((tool) => tool.name === 'pet_ask')!.handler({ question: '独立问题', options: ['可以'] }, {} as never);
const server = await startApi({ port: 0, token: 'e'.repeat(48) }, {
  status: () => ({ name: '灵犀', paused: false, body: { connected: false, x: 0.5 }, feeling: '测试状态' }),
  settings: () => ({ name: '灵犀', user: '测试者' }), asks: () => world.pendingAsks(), behind: () => null,
  outputs: (after) => world.outputs(after), outputReceipt: (id) => world.outputReceipt(id),
  history: () => { memory.sync(); return { available: true, cursor: store.latestCursor(), lines: memory.recentLines() }; },
  historySince: (after) => historySince(store, after), memory: () => ({ available: true, episodes: [] }),
  tasks: () => null, noteTask: () => false, cancelTask: () => false, recoverTask: () => false,
  say: (text) => world.typed(text), answer: (question, text, id) => world.answered(question, text, id),
  revoke: () => ({ revoked: false, behind: null }), save: () => ({ name: '灵犀', user: '测试者' }),
});
try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing API address');
  const env = { ...process.env, WORKBENCH_TEST_PORT: String(address.port), WORKBENCH_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve('tests/fixtures/diagnose-visible-output.cjs')], { env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
  const receipts = world.outputs().receipts;
  memory.sync();
  process.stdout.write(`${JSON.stringify({ code, receipts: receipts.length, memoryLines: memory.recentLines().length, personalData: false })}\n`);
  process.exitCode = code || (receipts.length !== 2 || memory.recentLines().length !== 2 ? 1 : 0);
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await world.stop(); memory.close(); store.close(); rmSync(dir, { recursive: true, force: true });
}
