import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (!argv.includes('--patch')) {
  send({ type: 'result', result: JSON.stringify({ argv }) });
} else {
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    const { id, method, params } = message;
    if (method === 'initialize') reply(id, { protocolVersion: 1, agentCapabilities: {} });
    else if (method === 'session/new') reply(id, { sessionId: 'controlled-dsh-session' });
    else if (method === 'session/resume') reply(id, {});
    else if (method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ argv, dshHome: process.env.DSH_HOME }) } } } });
      reply(id, { stopReason: 'end_turn' });
    } else if (method === 'session/close') reply(id, {});
  });
}
