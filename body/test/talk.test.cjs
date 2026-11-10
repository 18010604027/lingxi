'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const talkScript = fs.readFileSync(path.join(__dirname, '..', 'talk.js'), 'utf8');

function talkPage() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <form id="bar"><input id="text" type="text"><button id="send" type="submit">send</button></form>
  </body></html>`, { runScripts: 'outside-only', url: 'file:///talk.html' });
  const sent = [];
  const closes = 0;
  const composing = [];
  const closed = [];
  dom.window.talk = {
    send(text) { sent.push(text); },
    close() { closed.push(true); },
    composing(value) { composing.push(value); },
  };
  dom.window.eval(talkScript);
  const document = dom.window.document;
  return {
    dom, sent, closed, composing,
    text: document.getElementById('text'),
    form: document.getElementById('bar'),
    button: document.getElementById('send'),
    fire: (target, type, init = {}) => target.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true, ...init })),
    key: (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    composition: (target, type) => target.dispatchEvent(new dom.window.CompositionEvent(type, { bubbles: true })),
  };
}

test('Enter through the form sends the line once', () => {
  const page = talkPage();
  page.text.value = '你好';
  page.fire(page.form, 'submit');
  page.fire(page.form, 'submit');
  assert.deepEqual(page.sent, ['你好']);
  page.dom.window.close();
});

test('an input method keeps its confirming Enter and nothing is sent', () => {
  const page = talkPage();
  page.text.value = 'nihao';
  page.composition(page.text, 'compositionstart');
  assert.deepEqual(page.composing, [true]);
  const enter = new page.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  page.text.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  page.fire(page.form, 'submit');
  assert.deepEqual(page.sent, []);
  page.composition(page.text, 'compositionend');
  page.text.value = '你好';
  page.fire(page.form, 'submit');
  assert.deepEqual(page.sent, ['你好']);
  page.dom.window.close();
});

test('losing focus to the candidate window does not close the input window', () => {
  const page = talkPage();
  page.composition(page.text, 'compositionstart');
  page.fire(page.dom.window, 'blur');
  assert.deepEqual(page.closed, []);
  page.composition(page.text, 'compositionend');
  page.fire(page.dom.window, 'blur');
  assert.deepEqual(page.closed, [true]);
  page.dom.window.close();
});

test('the send button and the later submit send once, and the input method blocks the button too', () => {
  const page = talkPage();
  page.text.value = '在吗';
  page.button.dispatchEvent(new page.dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.deepEqual(page.sent, ['在吗']);
  page.fire(page.form, 'submit');
  assert.deepEqual(page.sent, ['在吗']);

  const other = talkPage();
  other.text.value = 'nihao';
  other.composition(other.text, 'compositionstart');
  other.button.dispatchEvent(new other.dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.deepEqual(other.sent, []);
  other.dom.window.close();
});
