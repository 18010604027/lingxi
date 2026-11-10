/**
 * ds-pet body — preload bridge.
 *
 * Only the handful of window/page operations the body needs.  The page never
 * receives ipcRenderer, Node, or a generic "send anything" channel.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const config = Object.freeze(ipcRenderer.sendSync('body:config'));

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function position(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return undefined;
  return { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) };
}

contextBridge.exposeInMainWorld('body', {
  config,

  /** Page-side hit test: true while the pointer is inside the character box. */
  setInteractive(interactive) {
    ipcRenderer.send('body:interactive', !!interactive);
  },

  /** Visible answer buttons that should temporarily receive the mouse. */
  setOptionRects(rects) {
    const list = Array.isArray(rects) ? rects : [];
    ipcRenderer.send('body:option-rects', list.slice(0, 16).map((r) => ({
      left: finite(r && r.left), top: finite(r && r.top),
      right: finite(r && r.right), bottom: finite(r && r.bottom),
    })).filter((r) => r.right > r.left && r.bottom > r.top));
  },

  /** True between pointerdown and pointerup, including the pre-threshold press. */
  pressed(value) {
    ipcRenderer.send('body:pressed', !!value);
  },

  /** Grow the window upward to fit the bubble; resolves to the accepted extra height. */
  resizeBubble(extra) {
    return ipcRenderer.invoke('body:bubble', finite(extra, 0));
  },

  /** Pickup threshold crossed. at = epoch ms; pressX/Y = original pointer screen point. */
  grab(payload) {
    ipcRenderer.send('body:grab', {
      at: finite(payload && payload.at, Date.now()),
      pressX: finite(payload && payload.pressX, 0),
      pressY: finite(payload && payload.pressY, 0),
      position: position(payload && payload.position),
    });
  },

  /** Released after a pickup; velocity is pointer px/s from the last 150ms. */
  drop(payload) {
    // The page sends the pointer path; the movement maths (the figure pack's) turns it into a release speed.
    const trail = Array.isArray(payload && payload.trail) ? payload.trail.slice(-200).map((sample) => ({
      t: finite(sample && sample.t), x: finite(sample && sample.x), y: finite(sample && sample.y),
    })) : [];
    ipcRenderer.send('body:drop', { trail, now: finite(payload && payload.now, Date.now()) });
  },

  click(payload) {
    ipcRenderer.send('body:click', {
      interactionId: typeof payload?.interactionId === 'string' ? payload.interactionId : undefined,
      startedAt: finite(payload?.startedAt, Date.now()), position: position(payload?.position),
    });
  },

  pet(payload) {
    if (!payload || !['started', 'completed', 'cancelled'].includes(payload.phase) || typeof payload.interactionId !== 'string') return;
    ipcRenderer.send('body:pet', { interactionId: payload.interactionId, phase: payload.phase,
      at: finite(payload.at, Date.now()), position: position(payload.position) });
  },

  /** The talk button was pressed: main.cjs opens her input window beside her. */
  openTalk() {
    ipcRenderer.send('body:talk');
  },

  /** The committed clip's facing, so hello/pose report the visible facing. */
  facing(value) {
    if (value === 'left' || value === 'right') ipcRenderer.send('body:facing', value);
  },

  /**
   * One animation-frame sample of a travelling clip.  `t` is the media's
   * currentTime in seconds and `duration` its full length; the main process
   * turns that into the window x, so no movement clock lives in the page.
   */
  travelTime(id, t, duration) {
    if (typeof id !== 'string' && !Number.isFinite(id)) return;
    const time = Number(t);
    const total = Number(duration);
    if (!Number.isFinite(time) || !Number.isFinite(total)) return;
    ipcRenderer.send('body:travel-time', { id, t: time, duration: total });
  },

  /** playing / ended / replaced / failed, for a brain-issued clip id. */
  reportClip(id, state, reason) {
    ipcRenderer.send('body:clip', {
      id,
      state,
      reason: typeof reason === 'string' ? reason : undefined,
    });
  },

  reportSpeech(id, outputId, state) {
    ipcRenderer.send('body:speech', { id, ...(outputId ? { outputId } : {}), state });
  },

  reportError(message) {
    ipcRenderer.send('body:error', String(message));
  },

  onPlay(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('body:play', (_event, payload) => callback(payload));
  },

  onSay(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('body:say', (_event, payload) => callback(payload));
  },

  /** What the person typed: the page shows it as their own line. */
  onSaid(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('body:said', (_event, payload) => callback(payload));
  },

  answer(payload) {
    if (!payload || typeof payload.questionId !== 'string' || typeof payload.question !== 'string' || typeof payload.text !== 'string') return;
    ipcRenderer.send('body:answer', payload);
  },

  /** Whether her input window is open: the bubble is hidden while it is, since both sit above her. */
  onTalkState(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('body:talk-state', (_event, payload) => callback(payload));
  },

  /** Whether the model is working: the page shows `…` until it answers or fails. */
  onThink(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('body:think', (_event, payload) => callback(payload));
  },
  /** Actions the page fires itself: a beat's lead-in, or an anchor at a typed offset. */
  acts(actions) {
    ipcRenderer.send('body:acts', actions);
  },

  /** The hop out and back in of a blink: `{phase: 'out'|'in'}`. */
  onBlink(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('body:blink', (_event, payload) => callback(payload));
  },
});
