import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
let next = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    if (process.argv.includes('fail-start')) process.exit(23);
    if (process.argv.includes('hang-start')) return;
    send({ id, result: { protocolVersion: 1 } }); return;
  }
  if (method === 'session/new') { send({ id, result: { sessionId: `s${++next}` } }); return; }
  if (method === 'session/prompt') {
    const text = params.prompt.map(p => p.text).join('');
    if (text.includes('EXIT-PROCESS')) process.exit(24);
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${process.pid}: ${text}` } } } });
    send({ id, result: { stopReason: 'end_turn' } }); return;
  }
  if (id !== undefined) send({ id, result: {} });
});
