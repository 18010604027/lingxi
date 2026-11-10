// A stand-in for `dsh --profile acp`: answers initialize, session/new, session/prompt, session/cancel and
// session/close, and session/resume of a session it made. A prompt containing "ASK-PERMISSION" first announces a write and requests a permission for it by the call's id, as DSH
// does, and reports the chosen option; one
// containing "WAIT-CANCEL" runs until cancelled. A line of log text goes to stdout first, as a DSH plugin may write.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const say = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const prompts = new Map();
let n = 0;
const asked = new Map();
const known = new Set();
process.stdout.write('[plugin] a log line on stdout\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) { asked.get(m.id)?.(m.result); return; }
  const { id, method, params } = m;
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (method === 'session/new') { const sid = `s${++n}`; known.add(sid); return send({ id, result: { sessionId: sid } }); }
  if (method === 'session/resume') return known.has(params.sessionId) ? send({ id, result: {} }) : send({ id, error: { code: -32002, message: 'no such session' } });
  if (method === 'session/close') return send({ id, result: {} });
  if (method === 'session/cancel') { prompts.get(params.sessionId)?.('cancelled'); return; }
  if (method === 'session/prompt') {
    const text = params.prompt.map((b) => b.text).join('');
    const sessionId = params.sessionId;
    if (text.includes('WAIT-CANCEL')) {
      prompts.set(sessionId, (reason) => send({ id, result: { stopReason: reason } }));
      say(sessionId, 'started; ');
      return;
    }
    if (text.includes('ASK-PERMISSION')) {
      const rid = 1000 + n;
      const result = await new Promise((resolve) => {
        asked.set(rid, resolve);
        // as DSH does: the call is announced first, and the request names only its id
        say(sessionId, 'I need to write the notes outside my folder.');
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: `c${rid}`, title: 'write', rawInput: { path: 'D:/elsewhere/notes.md', justification: 'the notes live there', sandbox_permissions: 'danger-full-access' } } } });
        send({ id: rid, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: `c${rid}` },
          options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] } });
      });
      say(sessionId, `permission: ${result.outcome.optionId ?? result.outcome.outcome}`);
      return send({ id, result: { stopReason: 'end_turn' } });
    }
    // narration first, then the answer, each a committed message as DSH sends them
    say(sessionId, 'Looking at it.');
    say(sessionId, `got: ${text}`);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
