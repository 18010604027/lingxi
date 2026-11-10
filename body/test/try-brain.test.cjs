'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let brainModule;

test('try-brain exports frame helpers', async () => {
  brainModule = await import('../try-brain.mjs');
  assert.equal(typeof brainModule.startBrainServer, 'function');
  assert.equal(typeof brainModule.createFrameParser, 'function');
  assert.equal(typeof brainModule.parseLine, 'function');
});

test('Sec-WebSocket-Accept matches the RFC 6455 example', async () => {
  const { acceptKey } = await import('../try-brain.mjs');
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('frame encoder handles 7-, 16- and 64-bit lengths', async () => {
  const { encodeFrame, OPCODE } = await import('../try-brain.mjs');

  const short = encodeFrame(OPCODE.TEXT, 'hi');
  assert.equal(short[0], 0x81);
  assert.equal(short[1], 2);
  assert.equal(short.subarray(2).toString(), 'hi');

  const medium = encodeFrame(OPCODE.TEXT, Buffer.alloc(126, 0x61));
  assert.equal(medium[0], 0x81);
  assert.equal(medium[1], 126);
  assert.equal(medium.readUInt16BE(2), 126);

  const long = encodeFrame(OPCODE.TEXT, Buffer.alloc(70000, 0x62));
  assert.equal(long[1], 127);
  assert.equal(long.readBigUInt64BE(2), 70000n);

  const masked = encodeFrame(OPCODE.TEXT, 'abc', { mask: true, maskKey: [1, 2, 3, 4] });
  assert.equal(masked[1] & 0x80, 0x80);
  assert.deepEqual([...masked.subarray(2, 6)], [1, 2, 3, 4]);
  assert.deepEqual([...masked.subarray(6)], [0x61 ^ 1, 0x62 ^ 2, 0x63 ^ 3]);
});

test('parser reads masked text, fragmented text and interleaved ping', async () => {
  const { createFrameParser, encodeFrame, OPCODE } = await import('../try-brain.mjs');
  const parser = createFrameParser();
  const key = [9, 8, 7, 6];

  let result = parser.push(encodeFrame(OPCODE.TEXT, 'hello', { mask: true, maskKey: key }));
  assert.equal(result.error, undefined);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].opcode, OPCODE.TEXT);
  assert.equal(result.frames[0].payload.toString(), 'hello');

  const first = encodeFrame(OPCODE.TEXT, 'hel', { mask: true, maskKey: key });
  first[0] &= 0x7f; // FIN = 0
  result = parser.push(first);
  assert.equal(result.frames.length, 0);

  result = parser.push(encodeFrame(OPCODE.PING, 'p', { mask: true, maskKey: key }));
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].opcode, OPCODE.PING);
  assert.equal(result.frames[0].payload.toString(), 'p');

  result = parser.push(encodeFrame(OPCODE.CONTINUATION, 'lo', { mask: true, maskKey: key }));
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].opcode, OPCODE.TEXT);
  assert.equal(result.frames[0].payload.toString(), 'hello');
});

test('parser buffers a frame split across pushes', async () => {
  const { createFrameParser, encodeFrame, OPCODE } = await import('../try-brain.mjs');
  const parser = createFrameParser();
  const frame = encodeFrame(OPCODE.TEXT, 'split works', { mask: true, maskKey: [4, 3, 2, 1] });
  assert.equal(parser.push(frame.subarray(0, 3)).frames.length, 0);
  assert.equal(parser.push(frame.subarray(3, 9)).frames.length, 0);
  const result = parser.push(frame.subarray(9));
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].payload.toString(), 'split works');
});

test('parser reads 16-bit lengths and close frames', async () => {
  const { createFrameParser, encodeFrame, encodeClose, OPCODE } = await import('../try-brain.mjs');
  const parser = createFrameParser();
  const medium = encodeFrame(OPCODE.TEXT, Buffer.alloc(300, 0x61), { mask: true, maskKey: [1, 1, 1, 1] });
  const result = parser.push(medium);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].payload.length, 300);

  const close = parser.push(
    encodeFrame(OPCODE.CLOSE, Buffer.from([0x03, 0xe8]), { mask: true, maskKey: [2, 2, 2, 2] }),
  );
  assert.equal(close.frames[0].opcode, OPCODE.CLOSE);
  assert.equal(close.frames[0].payload.readUInt16BE(0), 1000);
});

test('parser rejects unmasked, oversized and malformed control frames', async () => {
  const { createFrameParser, encodeFrame, OPCODE } = await import('../try-brain.mjs');

  let parser = createFrameParser();
  assert.match(parser.push(encodeFrame(OPCODE.TEXT, 'nope')).error, /not masked/);

  parser = createFrameParser({ maxPayload: 4 });
  assert.match(
    parser.push(encodeFrame(OPCODE.TEXT, '12345', { mask: true, maskKey: [1, 1, 1, 1] })).error,
    /too large/,
  );

  parser = createFrameParser();
  const control = encodeFrame(OPCODE.CLOSE, Buffer.alloc(126), { mask: true, maskKey: [1, 1, 1, 1] });
  assert.match(parser.push(control).error, /control frame too large/);

  parser = createFrameParser();
  const fragmentedPing = encodeFrame(OPCODE.PING, 'x', { mask: true, maskKey: [1, 1, 1, 1] });
  fragmentedPing[0] &= 0x7f;
  assert.match(parser.push(fragmentedPing).error, /fragmented/);

  parser = createFrameParser();
  assert.match(
    parser.push(encodeFrame(OPCODE.CONTINUATION, 'x', { mask: true, maskKey: [1, 1, 1, 1] })).error,
    /unexpected continuation/,
  );
});

test('parseLine maps stdin commands to protocol messages', async () => {
  const { parseLine } = await import('../try-brain.mjs');
  assert.equal(parseLine('', 1).kind, 'empty');
  assert.equal(parseLine('help', 1).kind, 'help');
  assert.equal(parseLine('quit', 1).kind, 'quit');

  assert.deepEqual(parseLine('play 跑.webm', 7), {
    kind: 'message',
    message: { t: 'play', id: 7, clip: '跑.webm', loop: false },
  });
  assert.deepEqual(parseLine('play 跑.webm loop right', 8), {
    kind: 'message',
    message: { t: 'play', id: 8, clip: '跑.webm', loop: true, facing: 'right' },
  });
  assert.equal(parseLine('play', 1).kind, 'error');
  assert.equal(parseLine('play x sideways', 1).kind, 'error');

  assert.deepEqual(parseLine('move 0.25', 9), {
    kind: 'message',
    message: { t: 'move', id: 9, x: 0.25, mode: 'line' },
  });
  assert.deepEqual(parseLine('move 0.25 spring 400', 10), {
    kind: 'message',
    message: { t: 'move', id: 10, x: 0.25, mode: 'spring', ms: 400 },
  });
  assert.deepEqual(parseLine('move 0 500', 11), {
    kind: 'message',
    message: { t: 'move', id: 11, x: 0, mode: 'line', ms: 500 },
  });
  assert.equal(parseLine('move', 1).kind, 'error');
  assert.equal(parseLine('move nope', 1).kind, 'error');

  assert.deepEqual(parseLine('say  hello world  ', 12), {
    kind: 'message',
    message: { t: 'say', text: 'hello world' },
  });
  assert.deepEqual(parseLine('say', 12), { kind: 'message', message: { t: 'say', text: '' } });
  assert.deepEqual(parseLine('stop', 12), { kind: 'message', message: { t: 'stop' } });
  assert.equal(parseLine('dance', 1).kind, 'error');
});

test('WebSocket server handshake, text, ping and close over a socket double', { timeout: 8000 }, async () => {
  const { EventEmitter } = require('node:events');
  const {
    startBrainServer,
    encodeFrame,
    OPCODE,
  } = await import('../try-brain.mjs');

  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.writes = [];
      this.destroyed = false;
      this.ended = false;
    }
    write(data) {
      this.writes.push(Buffer.from(data));
      return true;
    }
    end() {
      this.ended = true;
    }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit('close');
      }
    }
    setNoDelay() {}
  }

  const received = [];
  let connects = 0;
  let disconnects = 0;
  const brain = await startBrainServer({
    token: 'test-token',
    onMessage(text, client) {
      received.push(text);
      client.send(JSON.stringify({ t: 'echo', text }));
    },
    onConnect() {
      connects += 1;
    },
    onDisconnect() {
      disconnects += 1;
    },
  });

  try {
    const socket = new FakeSocket();
    const req = {
      url: '/body?token=test-token',
      headers: {
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        upgrade: 'websocket',
      },
    };
    brain.server.emit('upgrade', req, socket, Buffer.alloc(0));
    const handshake = socket.writes.map((part) => part.toString('utf8')).join('');
    assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.equal(connects, 1);
    assert.equal(brain.clientCount, 1);

    const key = [1, 2, 3, 4];
    socket.emit('data', encodeFrame(OPCODE.TEXT, 'hello body', { mask: true, maskKey: key }));
    assert.deepEqual(received, ['hello body']);
    const echo = socket.writes[socket.writes.length - 1];
    assert.equal(echo[0], 0x81);
    assert.equal(JSON.parse(echo.subarray(2).toString('utf8')).text, 'hello body');

    socket.emit('data', encodeFrame(OPCODE.PING, 'p', { mask: true, maskKey: key }));
    const pong = socket.writes[socket.writes.length - 1];
    assert.equal(pong[0], 0x8a);
    assert.equal(pong.subarray(2).toString('utf8'), 'p');

    socket.emit('data', encodeFrame(OPCODE.CLOSE, Buffer.from([0x03, 0xe8]), { mask: true, maskKey: key }));
    const close = socket.writes[socket.writes.length - 1];
    assert.equal(close[0], 0x88);
    assert.equal(close.subarray(2).readUInt16BE(0), 1000);
    assert.equal(socket.ended, true);

    assert.equal(disconnects, 0);
    socket.destroy();
    assert.equal(disconnects, 1);
    assert.equal(brain.clientCount, 0);
  } finally {
    await brain.close();
  }
});

test('WebSocket server rejects a bad token during upgrade', { timeout: 8000 }, async () => {
  const { EventEmitter } = require('node:events');
  const { startBrainServer } = await import('../try-brain.mjs');
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.writes = [];
      this.destroyed = false;
    }
    write(data) {
      this.writes.push(Buffer.from(data));
      return true;
    }
    destroy() {
      this.destroyed = true;
    }
    end() {}
    setNoDelay() {}
  }

  const brain = await startBrainServer({ token: 'right-token' });
  try {
    const socket = new FakeSocket();
    brain.server.emit(
      'upgrade',
      {
        url: '/body?token=wrong-token',
        headers: {
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          upgrade: 'websocket',
        },
      },
      socket,
      Buffer.alloc(0),
    );
    const response = socket.writes.map((part) => part.toString('utf8')).join('');
    assert.match(response, /^HTTP\/1\.1 401 Unauthorized/);
    assert.equal(socket.destroyed, true);
    assert.equal(brain.clientCount, 0);
  } finally {
    await brain.close();
  }
});

