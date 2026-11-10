'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const geometry = require('../geometry.cjs');

const AREA = { x: 100, y: 50, width: 1000, height: 800 };

test('targetLeft clamps the window fully into the work area', () => {
  assert.equal(geometry.targetLeft(AREA, 300, 0), 100);
  assert.equal(geometry.targetLeft(AREA, 300, 1), 800);
  assert.equal(geometry.targetLeft(AREA, 300, 0.5), 450);
  // A window wider than the area aligns left.
  assert.equal(geometry.targetLeft({ x: 0, y: 0, width: 200, height: 200 }, 300, 0.5), 0);
});

test('centreShare is the window centre relative to the work area', () => {
  assert.equal(geometry.centreShare(AREA, 300, 450), 0.5);
  assert.equal(geometry.centreShare(AREA, 300, 100), 0.15);
  assert.equal(geometry.centreShare(AREA, 300, 800), 0.85);
  assert.equal(geometry.centreShare(null, 300, 100), 0);
});

test('bottomTop sits on the work-area bottom, and fallBounds agrees', () => {
  assert.equal(geometry.bottomTop(AREA, 169), 681);
  assert.equal(geometry.bottomTop(AREA, 169, 10), 691);
  assert.equal(geometry.fallBounds(AREA, 300, 169).maxY, 681);
});

test('clampWindow keeps the whole window inside the area', () => {
  assert.deepEqual(geometry.clampWindow(AREA, 300, 169, -50, 0), { x: 100, y: 50 });
  assert.deepEqual(geometry.clampWindow(AREA, 300, 169, 5000, 5000), { x: 800, y: 681 });
});
