'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const bodyScript = fs.readFileSync(path.join(__dirname, '..', 'body.js'), 'utf8');
const talkScript = fs.readFileSync(path.join(__dirname, '..', 'talk.js'), 'utf8');
const until = async (condition, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

function bodyPage() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="bubble" role="status"></div>
    <div id="stage"><video id="video-a"></video><video id="video-b"></video>
      <div id="hit"><button id="talk" type="button">说</button></div>
    </div>
  </body></html>`, { runScripts: 'outside-only', url: 'file:///body.html' });
  const receipts = [];
  const actions = [];
  const touches = [];
  let onSay;
  let onThink;
  let onSaid;
  let onTalkState;
  let openTalkCalls = 0;
  let nextInputId = 1;
  const sent = [];
  const bridge = {
    config: { width: 300, hitBox: { left: 0.3, right: 0.7, top: 0.2, bottom: 1 } },
    onPlay() {}, onSay(callback) { onSay = callback; }, onThink(callback) { onThink = callback; },
    onSaid(callback) { onSaid = callback; }, onTalkState(callback) { onTalkState = callback; }, openTalk() { openTalkCalls++; },
    resizeBubble() { return Promise.resolve(); }, setInteractive() {}, pressed() {},
    grab(payload) { touches.push({ kind: 'grab', ...payload }); }, drop(payload) { touches.push({ kind: 'drop', ...payload }); },
    click(payload) { touches.push({ kind: 'click', ...payload }); }, pet(payload) { touches.push({ kind: 'pet', ...payload }); },
    facing() {}, acts(value) { actions.push(value); }, reportClip() {}, reportError() {}, reportSpeech(id, outputId, state) { receipts.push({ id, ...(outputId ? { outputId } : {}), state: state ?? outputId }); },
  };
  dom.window.body = bridge;
  dom.window.BodyClips = {
    createClipState() {
      return { request() { return { side: 0, gen: 1, replaced: [] }; }, markPlaying() {}, markEnded() {}, fail() {}, commit() {}, isPending() { return false; } };
    },
  };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.eval(bodyScript);
  function talkSend(value) {
    const form = dom.window.document.createElement('form');
    form.id = 'bar'; form.innerHTML = '<input id="text"><button id="send" type="submit">发送</button>';
    dom.window.document.body.appendChild(form);
    dom.window.talk = {
      send(text) {
        sent.push(text);
        const id = `input-${nextInputId++}`;
        onSaid({ id, text });
        onThink({ on: true });
      },
      close() {},
    };
    dom.window.eval(talkScript);
    const input = dom.window.document.getElementById('text');
    input.value = value;
    dom.window.document.getElementById('send').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    form.remove();
  }
  return {
    dom, receipts, actions, touches, sent, talkSend, openTalkCalls: () => openTalkCalls,
    say: (payload) => onSay(payload), said: (payload) => onSaid(payload), think: (payload) => onThink(payload), talkState: (payload) => onTalkState(payload),
  };
}

function speechBubble(page) { return [...page.dom.window.document.querySelectorAll('body > .bubble.say, body > #bubble.say')].at(-1); }

test('clean body startup has no thinking placeholder', () => {
  const page = bodyPage();
  try { assert.equal(page.dom.window.document.querySelector('.bubble-thinking'), null); }
  finally { page.dom.window.close(); }
});

function touch(page, type, x, y, buttons = type === 'pointerup' ? 0 : 1) {
  const hit = page.dom.window.document.getElementById('hit');
  hit.getBoundingClientRect = () => ({ left: 100, top: 100, right: 200, bottom: 200, width: 100, height: 100 });
  const event = new page.dom.window.MouseEvent(type, { bubbles: true, button: 0, buttons, clientX: x, clientY: y, screenX: x, screenY: y });
  (type === 'pointerdown' ? hit : page.dom.window).dispatchEvent(event);
}

test('a click carries body-relative contact without changing an active speech bubble', () => {
  const page = bodyPage();
  try {
    page.say({ id: 301, text: '我还在说话', hold: 4 });
    const bubble = speechBubble(page);
    touch(page, 'pointerdown', 125, 140); touch(page, 'pointerup', 125, 140);
    assert.equal(page.touches.length, 1);
    assert.equal(page.touches[0].kind, 'click');
    assert.equal(page.touches[0].position.x, 0.25);
    assert.equal(page.touches[0].position.y, 0.4);
    assert.equal(speechBubble(page), bubble);
    assert.equal(page.dom.window.document.querySelector('.bubble-thinking'), null);
  } finally { page.dom.window.close(); }
});

test('ordinary dragging emits pickup and release with no extra click or pet', () => {
  const page = bodyPage();
  try {
    touch(page, 'pointerdown', 125, 140); touch(page, 'pointermove', 145, 150); touch(page, 'pointerup', 145, 150);
    assert.deepEqual(page.touches.map(t => t.kind), ['grab', 'drop']);
    // The page hands the pointer path over; the movement maths stays on the main side, where the pack's module runs.
    assert.ok(Array.isArray(page.touches[1].trail));
  } finally { page.dom.window.close(); }
});

test('deliberate hold then stroking stays in place and closes exactly one pet gesture', async () => {
  const page = bodyPage();
  try {
    touch(page, 'pointerdown', 125, 140);
    await new Promise(resolve => setTimeout(resolve, 480));
    assert.equal(page.dom.window.document.getElementById('hit').style.cursor, 'ew-resize');
    touch(page, 'pointermove', 145, 140); touch(page, 'pointermove', 120, 140); touch(page, 'pointerup', 120, 140);
    assert.deepEqual(page.touches.map(t => [t.kind, t.phase]), [['pet', 'started'], ['pet', 'completed']]);
    assert.equal(page.touches[0].interactionId, page.touches[1].interactionId);
  } finally { page.dom.window.close(); }
});

test('speech reports completion only when its bubble finishes', async () => {
  const page = bodyPage();
  try {
    page.say({ id: 17, text: '甲' });
    assert.equal(page.receipts.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 1900));
    assert.deepEqual(page.receipts, [{ id: 17, state: 'completed' }]);
  } finally { page.dom.window.close(); }
});

test('the talk button delegates to the single detached composer and hides overlapping speech', () => {
  const page = bodyPage();
  try {
    page.say({ id: 18, text: '她的回复' });
    const bubble = speechBubble(page);
    assert.match(bubble.textContent, /她/);
    const talk = page.dom.window.document.getElementById('talk');
    talk.dispatchEvent(new page.dom.window.Event('pointerenter', { bubbles: true }));
    talk.dispatchEvent(new page.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(page.openTalkCalls(), 1);
    assert.equal(page.dom.window.document.querySelector('.b-own'), null);
    page.talkState({ open: true });
    assert.equal(bubble.hidden, true);
    page.talkState({ open: false });
    assert.equal(bubble.hidden, false);
    assert.match(bubble.textContent, /她/);
  } finally { page.dom.window.close(); }
});

test('a second speech queued while the first bubble is holding still plays', async () => {
  const page = bodyPage();
  try {
    page.say({ text: '甲' });
    page.say({ text: '乙' });
    await new Promise((resolve) => setTimeout(resolve, 1900));
    assert.match(speechBubble(page).textContent, /乙/);
  } finally { page.dom.window.close(); }
});

test('each typed message owns one short bubble slot and the next reply follows without stale user text', async () => {
  const page = bodyPage();
  try {
    const doc = page.dom.window.document;
    const firstHold = 2500 + 150 * Array.from('甲').length;
    const secondHold = 2500 + 150 * Array.from('乙').length;
    page.talkSend('1');
    const user1 = doc.querySelector('[data-item-id="input-1"]');
    const waiting1 = doc.querySelector('.bubble-thinking');
    assert.equal(user1?.textContent, '1');
    assert.ok(waiting1);
    assert.notEqual(user1, waiting1);
    assert.ok(!waiting1.hidden);

    page.say({ id: 46, replyId: 'reply-1', text: '甲乙', beats: [
      { text: '甲', outputId: 'reply-1:0', hold: firstHold },
      { text: '乙', outputId: 'reply-1:1', hold: secondHold },
    ] });
    await until(() => /甲/.test(speechBubble(page)?.textContent || ''), 2500);
    assert.equal(doc.querySelector('.bubble-thinking'), null);
    await until(() => /乙/.test(speechBubble(page)?.textContent || ''), firstHold + 2500);
    await until(() => ['reply-1:0', 'reply-1:1'].every((outputId) => page.receipts.some((receipt) => receipt.outputId === outputId && receipt.state === 'completed')), firstHold + secondHold + 2500);
    await until(() => !doc.querySelector('.bubble.say.is-on'), 3000);
    await until(() => !doc.querySelector('.bubble-trail'), 1000);
    assert.equal(doc.querySelector('[data-item-id="input-1"]'), null);
    assert.equal(doc.querySelector('.bubble-thinking'), null);

    page.talkSend('12');
    assert.deepEqual(page.sent, ['1', '12']);
    const user12 = doc.querySelector('[data-item-id="input-2"]');
    assert.equal(user12?.textContent, '12');
    assert.equal(doc.querySelector('.bubble-thinking') !== null, true);
    assert.doesNotMatch(doc.body.textContent, /甲|乙/);
    page.say({ id: 47, replyId: 'reply-2', text: '收到', beats: [{ text: '收到', outputId: 'reply-2:0', hold: 2500 + 150 * 2 }] });
    await until(() => /收到/.test(speechBubble(page)?.textContent || ''), 2500);
    assert.equal(doc.querySelector('.bubble-thinking'), null);
    await until(() => page.receipts.some((receipt) => receipt.outputId === 'reply-2:0' && receipt.state === 'completed'), 5000);
    await until(() => !doc.querySelector('.bubble.say.is-on'), 1000);
    assert.equal(doc.querySelector('.bubble-thinking'), null);
    assert.equal(doc.querySelector('[data-item-id="input-1"]'), null);
  } finally { page.dom.window.close(); }
});

test('one reply keeps beat order and trail while Talk pauses display and a new reply queues', async () => {
  const page = bodyPage();
  try {
    page.think({ on: true });
    page.say({ id: 31, replyId: 'reply-1', text: '甲甲甲甲甲甲甲甲甲甲甲甲乙乙', beats: [
      { text: '甲甲甲甲甲甲甲甲甲甲甲甲', outputId: 'reply-1:0', hold: 0.05, anchors: [{ at: 2, actions: [{ id: 'wave' }] }] },
      { text: '乙乙', outputId: 'reply-1:1', hold: 0.05 },
    ] });
    const bubble = page.dom.window.document.getElementById('bubble');
    assert.match(speechBubble(page).textContent, /甲/);
    await new Promise((resolve) => setTimeout(resolve, 130));
    page.talkState({ open: true });
    const pausedText = bubble.textContent;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(bubble.textContent, pausedText);
    const submitted = [];
    const form = page.dom.window.document.createElement('form');
    form.id = 'bar'; form.innerHTML = '<input id="text"><button id="send" type="submit">发送</button>';
    page.dom.window.document.body.appendChild(form);
    page.dom.window.talk = { send(text) { submitted.push(text); }, close() {} };
    page.dom.window.eval(talkScript);
    const input = page.dom.window.document.getElementById('text');
    input.value = '继续说一句';
    page.dom.window.document.getElementById('send').dispatchEvent(new page.dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    assert.deepEqual(submitted, ['继续说一句']);
    page.think({ on: false });
    page.say({ id: 32, replyId: 'reply-2', text: '新输入的回复', beats: [{ text: '新输入的回复', outputId: 'reply-2:0', hold: 0.05 }] });
    assert.equal(bubble.hidden, true);
    page.talkState({ open: false });
    await until(() => /乙/.test(speechBubble(page).textContent), 3500);
    assert.match(speechBubble(page).textContent, /乙/);
    assert.match(page.dom.window.document.querySelector('.bubble-trail')?.textContent || '', /甲甲甲/);
    assert.deepEqual(page.actions, [[{ id: 'wave' }]]);
    await until(() => ['reply-1:0', 'reply-1:1', 'reply-2:0'].every((outputId) => page.receipts.some((receipt) => receipt.outputId === outputId && receipt.state === 'completed')), 8000);
    for (const outputId of ['reply-1:0', 'reply-1:1', 'reply-2:0']) {
      const states = page.receipts.filter((receipt) => receipt.outputId === outputId).map((receipt) => receipt.state);
      assert.ok(states.includes('paused'), `${outputId} records pause`);
      assert.ok(states.includes('resumed'), `${outputId} records resume`);
      assert.equal(states.at(-1), 'completed', `${outputId} reaches its own terminal receipt`);
      assert.equal(states.filter((state) => state === 'completed').length, 1);
    }
    assert.ok(page.receipts.findIndex((receipt) => receipt.outputId === 'reply-1:0' && receipt.state === 'completed')
      < page.receipts.findIndex((receipt) => receipt.outputId === 'reply-1:1' && receipt.state === 'completed'));
    assert.ok(page.receipts.findIndex((receipt) => receipt.outputId === 'reply-1:1' && receipt.state === 'completed')
      < page.receipts.findIndex((receipt) => receipt.outputId === 'reply-2:0' && receipt.state === 'completed'));
    assert.equal(page.dom.window.document.querySelector('.b-think'), null);
  } finally { page.dom.window.close(); }
});

test('thinking mark gives way when the queued reply begins appearing', () => {
  const page = bodyPage();
  try {
    page.think({ on: true });
    assert.ok(page.dom.window.document.querySelector('.b-think'));
    page.say({ id: 20, text: '回复已经显示' });
    const bubble = speechBubble(page);
    assert.equal(bubble.hidden, false);
    assert.match(bubble.textContent, /回/);
    assert.equal(page.dom.window.document.querySelector('.b-think'), null);
    page.think({ on: false });
  } finally { page.dom.window.close(); }
});

test('a later processing projection does not recreate thinking after a reply arrives', async () => {
  const page = bodyPage();
  try {
    page.think({ on: true });
    page.say({ id: 21, text: '先回复', beats: [{ text: '先回复', hold: 0.01 }] });
    assert.equal(page.dom.window.document.querySelector('.bubble-thinking'), null);
    page.think({ on: true });
    assert.equal(page.dom.window.document.querySelector('.bubble-thinking'), null);
    page.think({ on: false });
    await until(() => !page.dom.window.document.querySelector('.bubble.say.is-on'));
    page.think({ on: true });
    assert.ok(page.dom.window.document.querySelector('.bubble-thinking'));
  } finally { page.dom.window.close(); }
});

test('detached talk window button sends once on pointerdown', () => {
  const dom = new JSDOM(`<!doctype html><form id="bar"><input id="text"><button id="send" type="submit">发送</button></form>`, { runScripts: 'outside-only' });
  const sent = [];
  let closed = 0;
  dom.window.talk = { send(text) { sent.push(text); }, close() { closed += 1; } };
  dom.window.eval(talkScript);
  const text = dom.window.document.getElementById('text');
  const button = dom.window.document.getElementById('send');
  text.value = '独立输入窗口';
  button.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(sent, ['独立输入窗口']);
  assert.equal(closed, 0);
  dom.window.close();
});
