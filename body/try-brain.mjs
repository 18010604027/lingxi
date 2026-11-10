#!/usr/bin/env node
/**
 * ds-pet body — try-brain, a tiny stand-in for the real brain.
 *
 * Starts a WebSocket server on 127.0.0.1 with a random token, prints the
 * BODY_WS value to give the body, and reads commands from stdin.
 *
 * Node 22+ has a built-in WebSocket *client* but no server, so this file
 * carries a minimal RFC 6455 server: masked client frames, text frames,
 * fragmentation, ping/pong and close.  No dependencies.  The frame helpers
 * and startBrainServer() are exported so test/try-brain.test.cjs can exercise
 * them without opening a terminal.
 *
 * Commands:
 *   play <clip> [loop] [right|left]
 *   move <x> [line|spring|instant] [ms]
 *   say <text>
 *   stop
 *   help / quit
 */

import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024;
const MODES = new Set(['line', 'spring', 'instant']);

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(String(key) + WS_GUID)
    .digest('base64');
}

/**
 * Encode one WebSocket frame.  Server output is unmasked; `mask: true` builds
 * a client frame (used by the tests and by anyone poking the server).
 *
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @param {{mask?:boolean, maskKey?:Buffer|number[]}} [options]
 */
export function encodeFrame(opcode, payload, options = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload == null ? '' : String(payload));
  const mask = options.mask === true;
  const length = data.length;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) headerLength += 2;
  else if (length > 0xffff) headerLength += 8;
  if (mask) headerLength += 4;

  const header = Buffer.alloc(headerLength);
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode, no RSV
  let offset = 2;
  if (length < 126) {
    header[1] = length;
  } else if (length <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }

  if (!mask) return Buffer.concat([header, data]);

  header[1] |= 0x80;
  let key;
  if (options.maskKey) {
    key = Buffer.from(options.maskKey);
    if (key.length !== 4) throw new Error('maskKey must be 4 bytes');
  } else {
    key = crypto.randomBytes(4);
  }
  key.copy(header, offset);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, masked]);
}

export function encodeText(text, options) {
  return encodeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'), options);
}

export function encodeClose(code = 1000, reason = '') {
  const body = Buffer.from(String(reason), 'utf8');
  const payload = Buffer.alloc(2 + Math.min(body.length, 123));
  payload.writeUInt16BE(code, 0);
  body.copy(payload, 2, 0, Math.min(body.length, 123));
  return encodeFrame(OPCODE.CLOSE, payload);
}

/**
 * Incremental frame parser for frames sent *to* the server.  Keeps a byte
 * buffer across pushes and reassembles fragmented text/binary messages.
 */
export function createFrameParser(options = {}) {
  const maxPayload = Number(options.maxPayload) || MAX_PAYLOAD;
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let fragmented = false;
  let failed = null;

  function protocolError(message) {
    failed = message;
    buffer = Buffer.alloc(0);
    fragments = [];
    fragmented = false;
    return message;
  }

  return {
    push(chunk) {
      const frames = [];
      if (failed) return { frames, error: failed };
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);

      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let length = b1 & 0x7f;
        let offset = 2;

        if (rsv !== 0) return { frames, error: protocolError('RSV bits are not zero') };
        if (!masked) return { frames, error: protocolError('client frame is not masked') };

        if (length === 126) {
          if (buffer.length < 4) break;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) break;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(Number.MAX_SAFE_INTEGER) || big > BigInt(maxPayload)) {
            return { frames, error: protocolError('frame too large') };
          }
          length = Number(big);
          offset = 10;
        }

        const control = (opcode & 0x8) !== 0;
        if (length > maxPayload) return { frames, error: protocolError('frame too large') };
        if (control) {
          if (!fin) return { frames, error: protocolError('control frame is fragmented') };
          if (length > 125) return { frames, error: protocolError('control frame too large') };
        }

        if (buffer.length < offset + 4 + length) break; // wait for the rest
        const maskKey = buffer.subarray(offset, offset + 4);
        const data = Buffer.alloc(length);
        const start = offset + 4;
        for (let i = 0; i < length; i++) data[i] = buffer[start + i] ^ maskKey[i & 3];
        buffer = buffer.subarray(start + length);

        if (control) {
          if (opcode === OPCODE.CLOSE) {
            if (length === 1) return { frames, error: protocolError('close frame has 1-byte payload') };
            frames.push({ opcode, payload: data });
          } else if (opcode === OPCODE.PING || opcode === OPCODE.PONG) {
            frames.push({ opcode, payload: data });
          } else {
            return { frames, error: protocolError(`unsupported control opcode ${opcode}`) };
          }
          continue;
        }

        if (opcode !== OPCODE.CONTINUATION && opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
          return { frames, error: protocolError(`unsupported opcode ${opcode}`) };
        }

        if (opcode === OPCODE.CONTINUATION) {
          if (!fragmented) return { frames, error: protocolError('unexpected continuation frame') };
          fragments.push(data);
          const total = fragments.reduce((sum, part) => sum + part.length, 0);
          if (total > maxPayload) return { frames, error: protocolError('fragmented message too large') };
          if (fin) {
            const payload = Buffer.concat(fragments);
            const messageOpcode = fragmentOpcode;
            fragments = [];
            fragmentOpcode = 0;
            fragmented = false;
            frames.push({ opcode: messageOpcode, payload });
          }
          continue;
        }

        if (fragmented) return { frames, error: protocolError('new data frame while fragmented') };
        if (fin) {
          frames.push({ opcode, payload: data });
        } else {
          fragments = [data];
          fragmentOpcode = opcode;
          fragmented = true;
        }
      }

      return { frames };
    },
  };
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function httpFailure(socket, status, text) {
  try {
    const body = Buffer.from(`${text}\n`);
    socket.write(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${body.length}\r\n\r\n`,
    );
    socket.write(body);
  } catch {
    /* ignore */
  } finally {
    socket.destroy();
  }
}

/**
 * Start the stand-in brain.  Resolves once the server is listening.
 *
 * @param {{token?:string, host?:string, port?:number,
 *          onMessage?:(text:string, client:object)=>void,
 *          onConnect?:(client:object)=>void,
 *          onDisconnect?:(client:object)=>void,
 *          onLog?:(message:string)=>void}} [options]
 */
export async function startBrainServer(options = {}) {
  const token = options.token || crypto.randomBytes(18).toString('hex');
  const host = options.host || '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 0;
  const onMessage = options.onMessage;
  const onConnect = options.onConnect;
  const onDisconnect = options.onDisconnect;
  const log = options.onLog || (() => {});
  const clients = new Set();

  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('WebSocket only\n');
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', `http://${host}`);
    } catch {
      httpFailure(socket, 400, 'bad URL');
      return;
    }
    if (url.pathname !== '/body' || url.searchParams.get('token') !== token) {
      httpFailure(socket, 401, 'bad token');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') {
      httpFailure(socket, 400, 'not a websocket upgrade');
      return;
    }

    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
    } catch {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);

    let closed = false;
    const client = {
      socket,
      send(text) {
        if (closed || socket.destroyed) return false;
        try {
          socket.write(encodeText(text));
          return true;
        } catch {
          return false;
        }
      },
      close(code = 1000, reason = '') {
        if (closed) return;
        closed = true;
        try {
          socket.write(encodeClose(code, reason));
        } catch {
          /* ignore */
        }
        try {
          socket.end();
        } catch {
          socket.destroy();
        }
      },
      terminate() {
        closed = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      },
    };
    clients.add(client);

    const parser = createFrameParser();
    const consume = (chunk) => {
      if (closed || chunk.length === 0) return;
      const result = parser.push(chunk);
      for (const frame of result.frames) {
        if (frame.opcode === OPCODE.TEXT) {
          const text = decodeUtf8(frame.payload);
          if (text === null) {
            client.close(1007, 'invalid UTF-8');
            return;
          }
          try {
            if (onMessage) onMessage(text, client);
          } catch (error) {
            log(`onMessage threw: ${error && error.message ? error.message : String(error)}`);
          }
        } else if (frame.opcode === OPCODE.BINARY) {
          // The body protocol is JSON text; ignore binary as recommended by
          // RFC 6455 for extensions we do not understand.
        } else if (frame.opcode === OPCODE.PING) {
          if (!closed && !socket.destroyed) socket.write(encodeFrame(OPCODE.PONG, frame.payload));
        } else if (frame.opcode === OPCODE.CLOSE) {
          client.close(1000, '');
          return;
        }
      }
      if (result.error) {
        log(`protocol error: ${result.error}`);
        client.close(1002, result.error);
      }
    };

    socket.on('data', (chunk) => consume(chunk));
    socket.on('error', () => {
      /* the close handler below does the bookkeeping */
    });
    socket.on('close', () => {
      closed = true;
      clients.delete(client);
      try {
        if (onDisconnect) onDisconnect(client);
      } catch (error) {
        log(`onDisconnect threw: ${error && error.message ? error.message : String(error)}`);
      }
    });

    try {
      if (onConnect) onConnect(client);
    } catch (error) {
      log(`onConnect threw: ${error && error.message ? error.message : String(error)}`);
    }
    if (head && head.length) consume(head);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const url = `ws://${host}:${actualPort}/body?token=${encodeURIComponent(token)}`;

  return {
    server,
    token,
    port: actualPort,
    url,
    get clientCount() {
      return clients.size;
    },
    send(text) {
      let sent = 0;
      for (const client of clients) if (client.send(text)) sent++;
      return sent;
    },
    async close() {
      for (const client of clients) client.terminate();
      clients.clear();
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

/** Parse one stdin line into a protocol message (exported for tests). */
export function parseLine(line, id) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return { kind: 'empty' };
  const space = text.indexOf(' ');
  const command = (space < 0 ? text : text.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : text.slice(space + 1).trim();

  if (command === 'help' || command === '?') return { kind: 'help' };
  if (command === 'quit' || command === 'exit') return { kind: 'quit' };

  if (command === 'play') {
    const parts = rest.split(/\s+/).filter(Boolean);
    const clip = parts.shift();
    if (!clip) return { kind: 'error', error: 'usage: play <clip> [loop] [right|left]' };
    let loop = false;
    let facing = null;
    for (const part of parts) {
      if (part === 'loop') loop = true;
      else if (part === 'right' || part === 'left') facing = part;
      else return { kind: 'error', error: `play: unknown option ${part}` };
    }
    const message = { t: 'play', id, clip, loop };
    if (facing) message.facing = facing;
    return { kind: 'message', message };
  }

  if (command === 'move') {
    const parts = rest.split(/\s+/).filter(Boolean);
    const x = Number(parts[0]);
    if (!parts.length || !Number.isFinite(x)) {
      return { kind: 'error', error: 'usage: move <x> [line|spring|instant] [ms]' };
    }
    let mode = 'line';
    let index = 1;
    if (MODES.has(parts[index])) {
      mode = parts[index];
      index += 1;
    }
    let ms;
    if (parts[index] !== undefined) {
      ms = Number(parts[index]);
      if (!Number.isFinite(ms) || ms < 0) {
        return { kind: 'error', error: 'move: ms must be a number >= 0' };
      }
      index += 1;
    }
    if (index < parts.length) {
      return { kind: 'error', error: `move: unexpected ${parts[index]}` };
    }
    const message = { t: 'move', id, x, mode };
    if (ms !== undefined) message.ms = ms;
    return { kind: 'message', message };
  }

  if (command === 'say') {
    return { kind: 'message', message: { t: 'say', text: rest } };
  }

  if (command === 'stop') {
    return { kind: 'message', message: { t: 'stop' } };
  }

  return { kind: 'error', error: `unknown command: ${command}` };
}

function usage() {
  console.log('commands:');
  console.log('  play <clip> [loop] [right|left]');
  console.log('  move <x> [line|spring|instant] [ms]');
  console.log('  say <text>');
  console.log('  stop');
  console.log('  help / quit');
}

async function main() {
  const token = crypto.randomBytes(18).toString('hex');
  let nextId = 1;
  const brain = await startBrainServer({
    token,
    onMessage(text) {
      console.log(`[body] ${text}`);
    },
    onConnect() {
      console.log('[brain] body connected');
    },
    onDisconnect() {
      console.log('[brain] body disconnected');
    },
    onLog(message) {
      console.error(`[brain] ${message}`);
    },
  });

  console.log(`BODY_WS=${brain.url}`);
  console.log(`run: BODY_CLIPS=<absolute clips dir> BODY_WS='${brain.url}' electron main.cjs`);
  usage();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => {
    const parsed = parseLine(line, nextId);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'help') {
      usage();
      return;
    }
    if (parsed.kind === 'quit') {
      rl.close();
      return;
    }
    if (parsed.kind === 'error') {
      console.error(parsed.error);
      return;
    }
    if (parsed.message.t === 'play' || parsed.message.t === 'move') nextId += 1;
    const sent = brain.send(JSON.stringify(parsed.message));
    if (!sent) console.error('[brain] no body connected');
  });
  rl.on('close', () => {
    brain.close().then(() => process.exit(0));
  });

  const shutdown = () => {
    brain.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}
