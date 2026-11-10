'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const geometry = require('../geometry.cjs');
const { loadMotion } = require('../motion-loader.cjs');

const scratch = () => mkdtempSync(join(tmpdir(), 'lingxi-motion-'));

test('there is no built-in movement maths: a run without a pack module fails and says why', () => {
  assert.throws(() => loadMotion({}), /no movement algorithm/);
  const missing = join(scratch(), 'nope.cjs');
  assert.throws(() => loadMotion({ BODY_MOTION: missing }), /not found/);
});

test('the pack module provides the movement and inherits the body geometry', () => {
  const dir = scratch();
  const file = join(dir, 'motion.cjs');
  writeFileSync(file, `module.exports = {
  createMove: () => ({ done: true, x: 42, step: () => 42 }),
  travelX: () => 7,
  estimateReleaseVelocity: () => ({ vx: 0, vy: 0, speed: 0, throw: false }),
  fallStep: (s) => ({ ...s, bounced: false, speed: 0, atRest: true }),
};
`);
  const loaded = loadMotion({ BODY_MOTION: file });
  assert.equal(loaded.source, file);
  assert.equal(loaded.motion.createMove().x, 42);
  assert.equal(loaded.motion.travelX(), 7);
  // geometry is not movement: it stays with the body and is handed to the algorithm
  assert.equal(loaded.motion.targetLeft, geometry.targetLeft);
  rmSync(dir, { recursive: true, force: true });
});

test('a module missing one of the four functions is refused', () => {
  const dir = scratch();
  const file = join(dir, 'motion.cjs');
  writeFileSync(file, 'module.exports = { createMove: () => ({ step: () => 0 }) };');
  assert.throws(() => loadMotion({ BODY_MOTION: file }), /must export travelX, estimateReleaseVelocity, fallStep/);
  rmSync(dir, { recursive: true, force: true });
});

test('a module that throws while loading is refused with its message', () => {
  const dir = scratch();
  const file = join(dir, 'motion.cjs');
  writeFileSync(file, 'throw new Error("no");');
  assert.throws(() => loadMotion({ BODY_MOTION: file }), /could not be loaded/);
  rmSync(dir, { recursive: true, force: true });
});
