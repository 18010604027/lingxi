/** Starts the independent application, body, workbench and tray. All children exit through their own quit API. */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Behavior } from './behavior/behavior.ts';
import { BodyLink } from './behavior/body-link.ts';
import { Daily } from './behavior/daily.ts';
import { loadPack } from './behavior/pack.ts';
import { validatePackResources } from './behavior/pack-resources.ts';
import { buildCatalog } from './behavior/catalog.ts';
import { workareaBody } from './behavior/workarea-body.ts';
import { createWill } from './behavior/will.ts';
import { assertBodyUserDataWithinRoot, bodyUserDataArgs } from './body-profile.ts';

const APP = fileURLToPath(new URL('../', import.meta.url));

/** A body that crashes more often than this is left down, so a broken one does not spin. */
const RESTARTS = { max: 5, withinMs: 60_000 };

// the figure and its clips are a pack of data (core/behavior/pack.ts)
const pack = loadPack(APP);
// the movement maths is the pack's own; without it there is nothing to run
const MOTION = validatePackResources(pack).motion;
const CLIPS = pack.clips;
const OWN = join(APP, 'build', 'lingxi-pet');
const home = process.env.LINGXI_HOME ?? join(OWN, 'home');
const deployment = process.env.LINGXI_DEPLOYMENT ?? 'lingxi';
const modelsDir = process.env.LINGXI_MODELS_DIR ?? join(OWN, 'models');
const dataDir = join(home, deployment, 'data');

const figure = pack.figure;
const link = new BodyLink();
const url = await link.start();
const behavior = new Behavior(link, figure, figure.bodyWidth);
const daily = new Daily(behavior, link, createWill(), { actions: buildCatalog(figure) });
daily.start();

// the body: started now, and again when it exits unasked
let body: ChildProcess | null = null;
let workbench: ChildProcess | null = null;
let tray: ChildProcess | null = null;
let stopping = false;
let application: { close(): Promise<void> } | undefined;
let stopPromise: Promise<void> | undefined;
const exits: number[] = [];
const electron = join(APP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const startBody = () => {
  if (stopping) return;
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  if (env.BODY_BOOT_MARKER) assertBodyUserDataWithinRoot(env.BODY_USER_DATA, env.BODY_USER_DATA_EXPECTED_ROOT);
  const args = [join(APP, 'body'), ...bodyUserDataArgs(env.BODY_USER_DATA)];
  const child = spawn(electron, args, {
    env: { ...env, BODY_CLIPS: CLIPS, BODY_WS: url, BODY_WIDTH: String(figure.bodyWidth), ...(figure.hit?.box ? { BODY_HIT_BOX: JSON.stringify(figure.hit.box) } : {}),
      // Movement implementation is required and supplied by the selected pack.
      BODY_MOTION: MOTION },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  body = child;
  child.on('exit', (code, signal) => {
    if (body === child) body = null;
    if (stopping) return;
    const now = Date.now();
    exits.push(now);
    while (exits.length && now - exits[0]! > RESTARTS.withinMs) exits.shift();
    if (exits.length > RESTARTS.max) {
      console.error(`[body] exited ${exits.length} times within a minute (last: ${signal ?? code}); left down`);
      return;
    }
    console.warn(`[body] exited (${signal ?? code}); starting it again`);
    setTimeout(startBody, 1000);
  });
};
startBody();
const startWorkbench = () => {
  if (stopping) return;
  if (workbench && workbench.exitCode === null) { workbench.send({ type: 'show' }); return; }
  const args = [join(APP, 'workbench', 'main.cjs')];
  if (process.env.WORKBENCH_DEBUG_PORT) args.push(`--remote-debugging-port=${process.env.WORKBENCH_DEBUG_PORT}`);
  if (process.env.WORKBENCH_USER_DATA_DIR) args.push(`--user-data-dir=${process.env.WORKBENCH_USER_DATA_DIR}`);
  const { ELECTRON_RUN_AS_NODE: _, ...electronEnv } = process.env;
  const child = spawn(electron, args, {
    env: { ...electronEnv, LINGXI_DATA_DIR: dataDir },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  workbench = child;
  if (typeof process.send === 'function') process.send({ type: 'workbench-started', pid: child.pid });
  child.on('exit', () => {
    if (workbench === child) workbench = null;
    if (typeof process.send === 'function') process.send({ type: 'workbench-stopped', pid: child.pid });
  });
};
const startTray = () => {
  const args = [join(APP, 'tray', 'main.cjs')];
  if (process.env.TRAY_USER_DATA_DIR) args.push(`--user-data-dir=${process.env.TRAY_USER_DATA_DIR}`);
  const { ELECTRON_RUN_AS_NODE: _, ...electronEnv } = process.env;
  const child = spawn(electron, args, { env: electronEnv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  tray = child;
  child.on('message', (message: { type?: string }) => {
    if (message?.type === 'show-workbench') startWorkbench();
    else if (message?.type === 'show-body') body?.send({ type: 'show' });
    else if (message?.type === 'quit') void stop();
  });
  child.on('exit', () => { if (tray === child) tray = null; });
};
function stop(): Promise<void> {
  return stopPromise ??= (async () => {
    stopping = true;
    daily.stop();
    try { await application?.close(); }
    finally {
      await Promise.all([tray, workbench, body].filter((child): child is ChildProcess => !!child && child.exitCode === null && child.signalCode === null).map((child) => new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        if (child.connected) child.send({ type: 'quit' }, (error) => { if (error) console.error('[exit] child quit request failed', error); });
      })));
      link.close();
      if (process.connected) process.disconnect();
    }
  })();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop());
process.on('message', (message: { type?: string }) => {
  if (message?.type === 'quit') void stop();
  else if (message?.type === 'show-workbench' && application && !stopping) startWorkbench();
});

const { main } = await import('./application.ts');
const paused = process.argv.includes('--paused') || ['1', 'true'].includes(process.env.LINGXI_START_PAUSED ?? '');
try {
  application = await main({ home, deployment, modelsDir, paused, newBody: { pet: { link, behavior, daily, figure }, workarea: workareaBody(link, behavior, figure.bodyWidth) } });
  if (stopping) await application.close();
  else { startWorkbench(); startTray(); }
} catch (error) {
  console.error('[startup] application could not start', error);
  process.exitCode = 1;
  await stop();
}
