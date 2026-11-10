'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClipState } = require('../clips.cjs');

test('idle loads quietly and never reports', () => {
  const state = createClipState({ facing: 'left' });
  const request = state.request({ id: null, clip: 'idle.webm', loop: true, source: 'idle' });
  assert.deepEqual(request.replaced, []);
  const commit = state.commit(request.gen);
  assert.equal(commit.replaced, null);
  assert.equal(state.markPlaying(request.gen), null);
  assert.equal(state.markEnded(request.gen), null);
  assert.equal(state.currentFacing(), 'left');
});

test('a brain clip reports playing, ended and replaced in order', () => {
  const state = createClipState();
  const a = state.request({ id: 'a', clip: 'a.webm', loop: false, facing: 'right' });
  assert.equal(a.side, 1);
  const ca = state.commit(a.gen);
  assert.equal(ca.replaced, null);
  assert.equal(ca.facing, 'right');
  assert.deepEqual(state.markPlaying(a.gen), { id: 'a', state: 'playing' });
  assert.equal(state.markPlaying(a.gen), null);
  assert.deepEqual(state.markEnded(a.gen), { id: 'a', state: 'ended' });
  assert.equal(state.markEnded(a.gen), null);

  const b = state.request({ id: 'b', clip: 'b.webm', loop: true });
  assert.equal(b.facing, 'right', 'omitted facing keeps the last facing');
  const cb = state.commit(b.gen);
  assert.equal(cb.side, 0);
  assert.equal(cb.replaced, null, 'a clip that already ended was not cut short');
  assert.equal(state.markEnded(b.gen), null, 'looping clips do not end');
  assert.deepEqual(state.markPlaying(b.gen), { id: 'b', state: 'playing' });
});

test('a clip replaced while still playing reports replaced', () => {
  const state = createClipState();
  const a = state.request({ id: 'a', clip: 'a.webm' });
  state.commit(a.gen);
  state.markPlaying(a.gen);

  const b = state.request({ id: 'b', clip: 'b.webm' });
  assert.equal(state.commit(b.gen).replaced.id, 'a');
  assert.equal(state.commit(b.gen), null);
});

test('a later request wins over a slow load', () => {
  const state = createClipState();
  const slow = state.request({ id: 'slow', clip: 'slow.webm' });
  const fast = state.request({ id: 'fast', clip: 'fast.webm' });
  assert.equal(slow.gen + 1, fast.gen);
  assert.equal(slow.side, fast.side, 'the same hidden element is reused');
  assert.deepEqual(fast.replaced, [{ id: 'slow', state: 'replaced' }]);

  assert.equal(state.commit(slow.gen), null, 'the stale load cannot commit');
  assert.equal(state.markPlaying(slow.gen), null);
  const commit = state.commit(fast.gen);
  assert.notEqual(commit, null);
  assert.equal(commit.replaced, null, 'no clip was playing yet');
  assert.deepEqual(state.markPlaying(fast.gen), { id: 'fast', state: 'playing' });
  assert.equal(state.current().clip, 'fast.webm');
});

test('a failed load leaves the old clip playing', () => {
  const state = createClipState();
  const a = state.request({ id: 'a', clip: 'a.webm' });
  state.commit(a.gen);
  state.markPlaying(a.gen);

  const bad = state.request({ id: 'bad', clip: 'missing.webm' });
  assert.deepEqual(state.fail(bad.gen, 'missing file'), {
    id: 'bad',
    state: 'failed',
    reason: 'missing file',
  });
  assert.equal(state.markPlaying(bad.gen), null);
  assert.equal(state.current().id, 'a');
  assert.equal(state.currentFacing(), 'left');

  const b = state.request({ id: 'b', clip: 'b.webm' });
  const committed = state.commit(b.gen);
  assert.deepEqual(committed.replaced, { id: 'a', state: 'replaced' });
  assert.equal(state.markPlaying(b.gen).state, 'playing');
});

test('a failure after commit but before playing is reported once', () => {
  const state = createClipState();
  const a = state.request({ id: 'a', clip: 'a.webm' });
  state.commit(a.gen);
  assert.deepEqual(state.fail(a.gen, 'decode error'), {
    id: 'a',
    state: 'failed',
    reason: 'decode error',
  });
  assert.equal(state.fail(a.gen, 'decode error'), null);
  assert.equal(state.markPlaying(a.gen), null);
  assert.deepEqual(state.markEnded(a.gen), null);
});

test('a media error after playing is reported failed, but not twice', () => {
  const state = createClipState();
  const a = state.request({ id: 'a', clip: 'a.webm' });
  state.commit(a.gen);
  assert.deepEqual(state.markPlaying(a.gen), { id: 'a', state: 'playing' });
  assert.deepEqual(state.fail(a.gen, 'decode error at 2s'), {
    id: 'a',
    state: 'failed',
    reason: 'decode error at 2s',
  });
  assert.equal(state.fail(a.gen, 'again'), null);
  assert.equal(state.markEnded(a.gen), null);
});

test('facing only changes when a clip actually commits', () => {
  const state = createClipState();
  const a = state.request({ id: 'a', clip: 'a.webm', facing: 'right' });
  assert.equal(state.currentFacing(), 'left');
  state.commit(a.gen);
  assert.equal(state.currentFacing(), 'right');

  const b = state.request({ id: 'b', clip: 'b.webm', facing: 'left' });
  state.fail(b.gen, 'nope');
  assert.equal(state.currentFacing(), 'right');

  const c = state.request({ id: 'c', clip: 'c.webm' });
  state.commit(c.gen);
  assert.equal(state.currentFacing(), 'right');
});

test('markPlaying from an old generation is ignored after a newer commit', () => {
  const state = createClipState();
  const a = state.request({ id: 'a', clip: 'a.webm' });
  state.commit(a.gen);
  const b = state.request({ id: 'b', clip: 'b.webm' });
  state.commit(b.gen);
  assert.deepEqual(state.markPlaying(b.gen), { id: 'b', state: 'playing' });
  assert.equal(state.markPlaying(a.gen), null);
  assert.equal(state.markEnded(a.gen), null);
});
