const debug = process.env.RELEASE_BODY_DEBUG_URL;
if (!debug) throw new Error('Set RELEASE_BODY_DEBUG_URL to the temporary candidate port printed at startup.');
const text = process.argv.slice(2).join(' ');
if (!text) throw new Error('Pass the line to submit through the temporary body input.');
type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
const targets = async (): Promise<Target[]> => await (await fetch(`${debug}/json/list`)).json() as Target[];
const send = async (url: string, commands: Array<{ method: string; params?: Record<string, unknown> }>): Promise<unknown[]> => {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, reject) => { socket.addEventListener('open', () => resolveOpen(), { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  socket.addEventListener('message', (event) => {
    const row = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (row.id) { pending.get(row.id)?.(row.error ?? row.result); pending.delete(row.id); }
  });
  const results: unknown[] = [];
  for (const command of commands) {
    const current = ++id;
    const result = new Promise<unknown>((resolveResult) => pending.set(current, resolveResult));
    socket.send(JSON.stringify({ id: current, ...command }));
    results.push(await Promise.race([result, new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 1000))]));
  }
  socket.close();
  return results;
};
const until = async (predicate: (rows: Target[]) => Target | undefined): Promise<Target> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = predicate(await targets());
    if (found) return found;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Temporary body target did not appear.');
};
const body = await until((rows) => rows.find((row) => row.type === 'page' && row.url.includes('/body/body.html')));
await send(body.webSocketDebuggerUrl, [{ method: 'Runtime.enable' }, { method: 'Runtime.evaluate', params: { expression: 'window.body.openTalk()', awaitPromise: true } }]);
const talk = await until((rows) => rows.find((row) => row.type === 'page' && row.url.includes('/talk.html')));
await send(talk.webSocketDebuggerUrl, [{ method: 'Runtime.enable' }]);
let inputReady = false;
const readyDeadline = Date.now() + 5000;
while (Date.now() < readyDeadline) {
  const [result] = await send(talk.webSocketDebuggerUrl, [{ method: 'Runtime.evaluate', params: { expression: "document.readyState === 'complete' && !!document.querySelector('#text')", returnByValue: true } }]);
  if ((result as { result?: { value?: unknown } } | undefined)?.result?.value === true) { inputReady = true; break; }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
}
if (!inputReady) throw new Error('temporary Talk input did not become ready');
const [evaluation] = await send(talk.webSocketDebuggerUrl, [{ method: 'Runtime.evaluate', params: {
  expression: "(()=>{const input=document.querySelector('#text');if(!input)throw Error('talk input is missing');input.value=" + JSON.stringify(text) + ";document.querySelector('#bar').requestSubmit();return true})()",
  awaitPromise: true,
} }]) as Array<{ result?: { value?: unknown }; exceptionDetails?: unknown } | undefined>;
if (evaluation?.exceptionDetails || (evaluation && evaluation.result?.value !== true)) throw new Error(`body input submission failed: ${JSON.stringify(evaluation)}`);
// The Talk window closes immediately after send, so Chromium may close the CDP socket before returning evaluate's reply.
// The host's body-typed event and persisted evidence are the delivery oracle.
process.stdout.write(`${JSON.stringify({ submitted: true, rendererAcknowledged: Boolean(evaluation), textLength: text.length, persistentBodyWindow: true })}\n`);
