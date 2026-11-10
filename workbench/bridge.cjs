'use strict';

// Renderer requests are mapped to this fixed set; it cannot choose a host, port, or token.
const ROUTES = Object.freeze({
  status: ['GET', '/lingxi/status'],
  settings: ['GET', '/lingxi/settings'],
  workbenchSettings: ['GET', '/lingxi/workbench-settings'],
  saveWorkbenchSettings: ['POST', '/lingxi/workbench-settings'],
  runtimeSettings: ['GET', '/lingxi/runtime-settings'],
  saveRuntimeSettings: ['POST', '/lingxi/runtime-settings'],
  tasks: ['GET', '/lingxi/tasks'],
  history: ['GET', '/lingxi/history'],
  historySince: ['GET', '/lingxi/history-since'],
  outputs: ['GET', '/lingxi/outputs'],
  activity: ['GET', '/lingxi/activity'],
  outputReceipt: ['POST', '/lingxi/output-receipt'],
  memory: ['GET', '/lingxi/memory'],
  asks: ['GET', '/lingxi/asks'],
  say: ['POST', '/lingxi/say'],
  answer: ['POST', '/lingxi/answer'],
  noteTask: ['POST', '/lingxi/task-note'],
  cancelTask: ['POST', '/lingxi/task-cancel'],
  recoverTask: ['POST', '/lingxi/task-recover'],
});

async function call(access, operation, body, fetcher = fetch) {
  if (!Object.hasOwn(ROUTES, operation)) throw new Error('Unknown operation');
  if (!Number.isInteger(access.port) || access.port < 1 || access.port > 65535 || typeof access.token !== 'string' || access.token.length < 32) {
    throw new Error('Invalid local API access');
  }
  const [method, basePath] = ROUTES[operation];
  if (['historySince', 'outputs'].includes(operation) && (!Number.isSafeInteger(body?.after) || body.after < 0)) throw new Error('Invalid cursor');
  if (operation === 'activity' && ((body?.cursor !== undefined && typeof body.cursor !== 'string') || (body?.limit !== undefined && (!Number.isSafeInteger(body.limit) || body.limit < 1)))) throw new Error('Invalid activity cursor or page size');
  const query = operation === 'activity' ? new URLSearchParams({ ...(body?.cursor !== undefined ? { cursor: body.cursor } : {}), ...(body?.limit !== undefined ? { limit: String(body.limit) } : {}) }).toString() : '';
  const path = ['historySince', 'outputs'].includes(operation) ? `${basePath}?after=${body.after}` : query ? `${basePath}?${query}` : basePath;
  const res = await fetcher(`http://127.0.0.1:${access.port}${path}`, {
    method,
    redirect: 'error',
    headers: { 'x-lingxi-token': access.token, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
  return data;
}

module.exports = { call };
