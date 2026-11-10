'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Clips = require('../clips.cjs');

test('play endSec is applied after the clip commits and ends once at media time', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="bubble" role="status"></div>
    <div id="stage"><video id="video-a"></video><video id="video-b"></video>
      <div id="hit"><button id="talk" type="button">说</button></div>
    </div>
  </body></html>`, { runScripts: 'outside-only', url: 'file:///body.html' });
  const reports = [];
  const travelTimes = [];
  const errors = [];
  const frames = [];
  let onPlay;
  const bridge = {
    config: { width: 300, idle: 'idle.webm', idleUrl: 'file:///idle.webm', hitBox: { left: 0.3, right: 0.7, top: 0.2, bottom: 1 } },
    onPlay(callback) { onPlay = callback; }, onSay() {}, onThink() {}, onSaid() {}, onTalkState() {},
    reportClip(id, state, reason) { reports.push({ id, state, reason }); },
    travelTime(id, t, duration) { travelTimes.push({ id, t, duration }); },
    reportError(message) { errors.push(new Error(message)); },
    facing() {}, setInteractive() {}, pressed() {}, grab() {}, drop() {}, click() {}, openTalk() {},
    typing() {}, sendText() {}, resizeBubble() { return Promise.resolve(); }, acts() {}, reportSpeech() {},
  };
  dom.window.body = bridge;
  dom.window.BodyMotion = { trimTrail: (trail) => trail, estimateReleaseVelocity: () => ({ vx: 0, vy: 0 }) };
  dom.window.BodyClips = Clips;
  dom.window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  dom.window.addEventListener('error', (event) => { errors.push(event.error ?? new Error(event.message)); event.preventDefault(); });

  for (const video of dom.window.document.querySelectorAll('video')) {
    let currentTime = 0;
    let paused = true;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 10.042 },
      currentTime: { configurable: true, get: () => currentTime, set: (value) => { currentTime = value; } },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, value: false },
    });
    video.load = () => queueMicrotask(() => {
      video.dispatchEvent(new dom.window.Event('loadeddata'));
      video.dispatchEvent(new dom.window.Event('canplay'));
    });
    video.play = () => { paused = false; queueMicrotask(() => video.dispatchEvent(new dom.window.Event('playing'))); return Promise.resolve(); };
    video.pause = () => { paused = true; };
  }

  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'body.js'), 'utf8'));
  try {
    onPlay({ id: 'run-cut', clip: 'run.webm', loop: false, facing: 'left', endSec: 4,
      travel: { x: 0.4, leadSec: 1.75, tailSec: 6.042 }, url: 'file:///run.webm' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reports.filter((report) => report.id === 'run-cut').map((report) => report.state), ['playing']);
    assert.equal(errors.length, 0);

    const video = [...dom.window.document.querySelectorAll('video')].find((item) => item.classList.contains('is-front'));
    assert.ok(video);
    video.currentTime = 4.08;
    for (const frame of frames.splice(0)) frame();

    assert.equal(video.currentTime, 4);
    assert.equal(video.paused, true);
    assert.deepEqual(reports.filter((report) => report.id === 'run-cut').map((report) => report.state), ['playing', 'ended']);
    assert.deepEqual(travelTimes, [{ id: 'run-cut', t: 4, duration: 10.042 }]);
    assert.equal(errors.length, 0);
  } finally { dom.window.close(); }
});

test('play segment seeks before commit, repeats only its moving frames, and ends once at accumulated travel time', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="bubble" role="status"></div>
    <div id="stage"><video id="video-a"></video><video id="video-b"></video>
      <div id="hit"><button id="talk" type="button">说</button></div>
    </div>
  </body></html>`, { runScripts: 'outside-only', url: 'file:///body.html' });
  const reports = [];
  const travelTimes = [];
  const errors = [];
  const frames = [];
  let onPlay;
  const bridge = {
    config: { width: 300, idle: 'idle.webm', idleUrl: 'file:///idle.webm', hitBox: { left: 0.3, right: 0.7, top: 0.2, bottom: 1 } },
    onPlay(callback) { onPlay = callback; }, onSay() {}, onThink() {}, onSaid() {}, onTalkState() {},
    reportClip(id, state, reason) { reports.push({ id, state, reason }); },
    travelTime(id, t, duration) { travelTimes.push({ id, t, duration }); },
    reportError(message) { errors.push(new Error(message)); },
    facing() {}, setInteractive() {}, pressed() {}, grab() {}, drop() {}, click() {}, openTalk() {},
    typing() {}, sendText() {}, resizeBubble() { return Promise.resolve(); }, acts() {}, reportSpeech() {},
  };
  dom.window.body = bridge;
  dom.window.BodyMotion = { trimTrail: (trail) => trail, estimateReleaseVelocity: () => ({ vx: 0, vy: 0 }) };
  dom.window.BodyClips = Clips;
  dom.window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  dom.window.addEventListener('error', (event) => { errors.push(event.error ?? new Error(event.message)); event.preventDefault(); });

  const playCounts = new Map();
  const pendingSeeks = new Map();
  for (const video of dom.window.document.querySelectorAll('video')) {
    let currentTime = 0;
    let paused = true;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 10 },
      currentTime: { configurable: true, get: () => currentTime, set: (value) => {
        currentTime = value;
        pendingSeeks.set(video, () => {
          pendingSeeks.delete(video);
          video.dispatchEvent(new dom.window.Event('seeked'));
        });
      } },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, value: false },
    });
    video.load = () => queueMicrotask(() => {
      video.dispatchEvent(new dom.window.Event('loadeddata'));
      video.dispatchEvent(new dom.window.Event('canplay'));
    });
    video.play = () => {
      playCounts.set(video, (playCounts.get(video) ?? 0) + 1);
      paused = false;
      queueMicrotask(() => video.dispatchEvent(new dom.window.Event('playing')));
      return Promise.resolve();
    };
    video.pause = () => { paused = true; };
  }

  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'body.js'), 'utf8'));
  try {
    const segment = { startSec: 2, endSec: 4, durationSec: 4 };
    onPlay({ id: 'run-segment', clip: 'run.webm', loop: false, facing: 'left', segment,
      travel: { x: 0.8, leadSec: 0, tailSec: 0 }, url: 'file:///run.webm' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(reports.filter((report) => report.id === 'run-segment'), [], 'loading alone cannot commit before seeked');
    const video = [...pendingSeeks.keys()][0];
    assert.ok(video);
    assert.equal(playCounts.get(video), undefined, 'no pre-segment frames play while seeking');
    pendingSeeks.get(video)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(video.classList.contains('is-front'), true);
    assert.equal(video.currentTime, segment.startSec, 'the segment start is sought before playback commits');
    assert.equal(playCounts.get(video), 1);

    const frame = () => { const queued = frames.splice(0); for (const callback of queued) callback(16.67); };
    video.currentTime = segment.endSec + 0.08;
    frame();
    assert.equal(video.paused, true, 'the outgoing video cannot continue into the stop tail while its buffer is not ready');
    assert.equal(video.currentTime, segment.endSec, 'an overshot boundary is clamped before waiting');
    assert.equal(video.classList.contains('is-front'), true);
    const buffer = [...pendingSeeks.keys()].find((item) => item !== video);
    assert.ok(buffer);
    pendingSeeks.get(buffer)();
    frame();
    const nextVideo = [...dom.window.document.querySelectorAll('video')].find((item) => item.classList.contains('is-front'));
    assert.notEqual(nextVideo, video);
    assert.equal(nextVideo.currentTime, segment.startSec, 'only the moving range loops');
    assert.equal(nextVideo.paused, false);
    assert.equal(playCounts.get(video), 1, 'looping does not replay the clip or its start-up');
    assert.deepEqual(travelTimes.at(-1), { id: 'run-segment', t: 2, duration: 4 });
    assert.deepEqual(reports.filter((report) => report.id === 'run-segment').map((report) => report.state), ['playing']);

    pendingSeeks.get(video)(); // the hidden-side seek must complete before the next cycle
    frame();
    nextVideo.currentTime = segment.endSec + 0.08;
    frame();
    assert.equal(video.paused, true);
    assert.equal(playCounts.get(video), 1);
    assert.equal(nextVideo.currentTime, segment.endSec, 'the final frame is also bounded to the moving range');
    assert.deepEqual(travelTimes.at(-1), { id: 'run-segment', t: 4, duration: 4 });
    assert.deepEqual(reports.filter((report) => report.id === 'run-segment').map((report) => report.state), ['playing', 'ended']);
    assert.equal(errors.length, 0);

    const finalFront = [...dom.window.document.querySelectorAll('video')].find((item) => item.classList.contains('is-front'));
    onPlay({ id: 'after-run', clip: 'idle.webm', facing: 'left', url: 'file:///idle.webm' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(
      [...dom.window.document.querySelectorAll('video')].find((item) => item.classList.contains('is-front')),
      finalFront,
      'the next request loads into the hidden side after an in-generation handoff',
    );
  } finally { dom.window.close(); }
});
