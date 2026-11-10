import { FrontEpochStore } from '../../core/runtime/front-epoch.ts';
const [root, mode] = process.argv.slice(2);
const store = await FrontEpochStore.acquire(root!);
if (mode === 'hold') {
  console.log('READY');
  await new Promise<void>((resolve) => process.stdin.once('data', resolve));
}
if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
await store.close();
