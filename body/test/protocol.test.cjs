'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../protocol.cjs');

test('contact reports retain real phases and body-relative positions', () => {
  for (const phase of ['started', 'completed', 'cancelled']) assert.equal(protocol.validateOutgoing({ t: 'pet', interactionId: 'stroke-1', at: 123, phase, x: 0.5, position: { x: 0.2, y: 0.6 } }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'click', x: 0.5, startedAt: 120, at: 123, position: { x: 0.2, y: 0.6 } }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'pet', interactionId: 'stroke-1', at: 123, phase: 'started', x: 0.5, position: { x: 2, y: 0.6 } }).ok, false);
});

test('play accepts the documented shape and fills defaults', () => {
  const result = protocol.validateMessage({ t: 'play', id: 7, clip: '待机呼吸休闲.webm' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    t: 'play',
    id: 7,
    clip: '待机呼吸休闲.webm',
    loop: false,
    facing: null,
  });
});

test('play accepts loop and facing', () => {
  const result = protocol.validateMessage({
    t: 'play',
    id: 'a',
    clip: '跑.webm',
    loop: true,
    facing: 'right',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.loop, true);
  assert.equal(result.value.facing, 'right');
});

test('play accepts an optional media end time', () => {
  const result = protocol.validateMessage({ t: 'play', id: 4, clip: '跑.webm', endSec: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.value.endSec, 4);
  assert.equal(protocol.validateMessage({ t: 'play', id: 4, clip: '跑.webm', endSec: -1 }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'play', id: 4, clip: '跑.webm', endSec: Infinity }).ok, false);
});

test('play accepts one continuous segment only with zero-lead travel', () => {
  const message = {
    t: 'play', id: 'run-segment', clip: '跑.webm',
    travel: { x: 0.9, leadSec: 0, tailSec: 0 },
    segment: { startSec: 3.2, endSec: 4.1, durationSec: 8.5 },
  };
  const result = protocol.validateMessage(message);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.segment, message.segment);
  assert.deepEqual(result.value.travel, message.travel);
  assert.equal(result.value.loop, false);

  for (const segment of [
    null,
    [],
    { startSec: -1, endSec: 4, durationSec: 2 },
    { startSec: 4, endSec: 4, durationSec: 2 },
    { startSec: 3, endSec: 4, durationSec: 0 },
    { startSec: 3, endSec: 4, durationSec: Infinity },
  ]) {
    assert.equal(protocol.validateMessage({ ...message, segment }).ok, false);
  }
  assert.equal(protocol.validateMessage({ ...message, endSec: 4 }).ok, false);
  assert.equal(protocol.validateMessage({ ...message, travel: { ...message.travel, leadSec: 0.1 } }).ok, false);
  assert.equal(protocol.validateMessage({ ...message, travel: undefined }).ok, false);
});

test('play accepts travel and makes the clip one-shot', () => {
  const result = protocol.validateMessage({
    t: 'play',
    id: 'walk',
    clip: '走.webm',
    loop: true,
    travel: { x: 0.75, leadSec: 0.8, tailSec: 1.1 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.loop, false, 'a travel clip never loops');
  assert.deepEqual(result.value.travel, { x: 0.75, leadSec: 0.8, tailSec: 1.1 });
  assert.equal('travel' in protocol.validateMessage({ t: 'play', id: 1, clip: 'x.webm' }).value, false);
});

test('play rejects malformed travel', () => {
  const good = { t: 'play', id: 1, clip: 'x.webm', travel: { x: 0.5, leadSec: 0, tailSec: 0 } };
  assert.equal(protocol.validateMessage(good).ok, true);
  for (const travel of [
    null,
    1,
    [],
    { x: 0.5, leadSec: 0 },
    { x: '0.5', leadSec: 0, tailSec: 0 },
    { x: 0.5, leadSec: -1, tailSec: 0 },
    { x: 0.5, leadSec: 0, tailSec: Infinity },
    { x: Number.NaN, leadSec: 0, tailSec: 0 },
  ]) {
    assert.equal(
      protocol.validateMessage({ ...good, travel }).ok,
      false,
      JSON.stringify(travel, (_key, value) => (Number.isNaN(value) ? 'NaN' : value)),
    );
  }
});

test('play rejects path separators and bad fields', () => {
  for (const clip of ['../x.webm', 'a/b.webm', 'a\\\\b.webm', '', '.', '..', 42, 'x\n.webm']) {
    assert.equal(protocol.validateMessage({ t: 'play', id: 1, clip }).ok, false, String(clip));
  }
  assert.equal(protocol.validateMessage({ t: 'play', clip: 'x.webm' }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'play', id: 1, clip: 'x.webm', loop: 'yes' }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'play', id: 1, clip: 'x.webm', facing: 'up' }).ok, false);
});

test('move validates mode/x/ms and defaults a line duration', () => {
  const line = protocol.validateMessage({ t: 'move', id: 1, x: 0.25, mode: 'line' });
  assert.equal(line.ok, true);
  assert.equal(line.value.ms, 1000);

  const instant = protocol.validateMessage({ t: 'move', id: 1, x: 0, mode: 'instant' });
  assert.equal(instant.ok, true);
  assert.equal(instant.value.ms, null);

  assert.equal(protocol.validateMessage({ t: 'move', id: 1, x: 0.5, mode: 'run' }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'move', id: 1, x: '0.5', mode: 'line' }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'move', id: 1, x: 0.5, mode: 'line', ms: -1 }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'move', id: 1, x: 0.5, mode: 'line', ms: Infinity }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'move', id: 1, x: 0.5, mode: 'spring', ms: 250 }).value.ms, 250);
});

test('say accepts empty text and stop accepts an optional id', () => {
  assert.deepEqual(protocol.validateMessage({ t: 'say', text: '' }).value, { t: 'say', text: '', ms: null });
  assert.deepEqual(protocol.validateMessage({ t: 'say', text: 'hi', ms: 0 }).value, {
    t: 'say',
    text: 'hi',
    ms: 0,
  });
  assert.equal(protocol.validateMessage({ t: 'say', text: 3 }).ok, false);
  assert.equal(protocol.validateMessage({ t: 'say', id: 42, text: 'hi' }).value.id, 42);
  assert.equal(protocol.validateMessage({ t: 'say', id: {}, text: 'hi' }).ok, false);
  assert.deepEqual(protocol.validateMessage({ t: 'say', id: 8, replyId: 'reply', text: 'hi', beats: [{ text: 'hi', outputId: 'reply:0', hold: 2.5 }] }).value,
    { t: 'say', id: 8, replyId: 'reply', text: 'hi', ms: null, beats: [{ text: 'hi', outputId: 'reply:0', hold: 2.5, actions: [], anchors: [] }] });
  assert.equal(protocol.validateMessage({ t: 'say', replyId: {}, text: 'hi' }).ok, false);
  assert.deepEqual(protocol.validateMessage({ t: 'stop' }).value, { t: 'stop', id: null });
  assert.deepEqual(protocol.validateMessage({ t: 'stop', id: 2 }).value, { t: 'stop', id: 2 });
  assert.equal(protocol.validateMessage({ t: 'stop', id: {} }).ok, false);
});

test('parseMessage reports invalid JSON and unknown types', () => {
  assert.match(protocol.parseMessage('{').error, /invalid JSON/);
  assert.match(protocol.parseMessage('{"t":"dance"}').error, /unknown command/);
  assert.equal(protocol.parseMessage('null').ok, false);
  assert.equal(protocol.parseMessage(new Uint8Array([1, 2, 3])).ok, false);
  assert.equal(protocol.parseMessage(Buffer.from('{"t":"stop"}')).ok, true);
});

test('outgoing messages are checked too', () => {
  assert.equal(protocol.validateOutgoing({ t: 'speech', id: 42, state: 'completed' }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'speech', id: 42, state: 'interrupted' }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'speech', id: 42, outputId: 'reply:0', state: 'paused' }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'speech', id: 42, outputId: 'reply:0', state: 'resumed' }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'speech', id: 42, outputId: 'reply:0', state: 'completed' }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'speech', id: 42, outputId: {}, state: 'completed' }).ok, false);
  assert.equal(protocol.validateOutgoing({ t: 'speech', id: 42, state: 'started' }).ok, false);
  assert.equal(
    protocol.validateOutgoing({
      t: 'hello',
      display: { x: 0, y: 0, width: 1920, height: 1040, scale: 1 },
      x: 0.5,
      facing: 'left',
    }).ok,
    true,
  );
  assert.equal(protocol.validateOutgoing({ t: 'busy', for: 'say', id: null }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'busy', for: 'nope', id: null }).ok, false);
  assert.equal(protocol.validateOutgoing({ t: 'clip', id: 1, state: 'playing' }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'clip', id: 1, state: 'exploded' }).ok, false);
  assert.equal(protocol.validateOutgoing({ t: 'landed', x: Number.NaN }).ok, false);
  assert.equal(protocol.validateOutgoing({ t: 'drop', x: 1, vx: 2, vy: 3 }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'move', id: 1, state: 'arrived', x: 0.2 }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'pose', x: 0.2, facing: 'right' }).ok, true);
  // what the person typed into her input window (talk.html -> main.cjs -> brain)
  assert.equal(protocol.validateOutgoing({ t: 'typed', text: '在吗' }).ok, true);
  assert.equal(protocol.validateOutgoing({ t: 'typed', text: '' }).ok, false);
  assert.equal(protocol.validateOutgoing({ t: 'typed', text: 'x'.repeat(2001) }).ok, false);
});
