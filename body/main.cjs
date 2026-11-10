/**
 * ds-pet body — Electron main process.
 *
 * The body carries things out.  It never chooses a clip or a destination:
 * every play/move/say/stop arrives as a JSON message on BODY_WS, and every
 * user gesture is reported back.  The page only plays video and measures the
 * speech bubble; the main process owns the window, the 60 Hz move/fall clock,
 * the drag follow and the WebSocket client.
 *
 * The transparent always-on-top window and the screen-saver topmost level are this
 * body's own; the movement/fall maths lives in motion.cjs.
 */

'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');

// A debug port lets the harness drive this window (click, type, read the page) without the person's help.
if (process.env.BODY_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', String(process.env.BODY_DEBUG_PORT));
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const protocol = require('./protocol.cjs');
const { loadMotion } = require('./motion-loader.cjs');
// The movement maths is the figure pack's own; a pack without one stops the body with a clear message.
let motion;
try {
  const loadedMotion = loadMotion();
  motion = loadedMotion.motion;
  console.log(`BODY_MOTION=` + JSON.stringify({ source: loadedMotion.source }));
} catch (error) {
  console.error(`BODY_MOTION_ERROR=` + error.message);
  app.exit(1);
}
const { configureUserData, writeBootMarker } = require('./user-data.cjs');

// Test and preview runs can keep Chromium state beside their other temporary data.
const userDataReadback = configureUserData(app);
if (userDataReadback) console.log(`BODY_USER_DATA_READBACK=${JSON.stringify({
  actualPath: userDataReadback.actualPath,
  expectedRoot: userDataReadback.expectedRoot,
})}`);

// Controlled hosts can prove the effective Chromium profile without reading profile contents.
if (process.env.BODY_BOOT_MARKER) {
  if (!userDataReadback) throw new Error('BODY_BOOT_MARKER requires a verified temporary userData root');
  writeBootMarker(userDataReadback, {
    pid: process.pid,
    parentPid: process.ppid,
    execPath: process.execPath,
    startedAt: Date.now() - process.uptime() * 1000,
    userData: userDataReadback.actualPath,
    expectedRoot: userDataReadback.expectedRoot,
  });
}

// The figure's measures for these clips:
// the size the character is drawn at, where its feet are on the 640×360 canvas, and the box that answers the hand.
const DEFAULT_WIDTH = 462;
const CANVAS_W = 640;
const CANVAS_H = 360;
const FEET_Y = 330;
// The pack says where her body may be touched (hit.box, in clip-canvas coordinates); this is the figure's own.
const DEFAULT_HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
const HIT_BOX = (() => {
  const raw = process.env.BODY_HIT_BOX;
  if (!raw) return DEFAULT_HIT_BOX;
  try {
    const box = JSON.parse(raw);
    if ([box.x0, box.y0, box.x1, box.y1].every((v) => Number.isFinite(v)) && box.x1 > box.x0 && box.y1 > box.y0) return box;
  } catch { /* the default stands */ }
  return DEFAULT_HIT_BOX;
})();
const DEFAULT_IDLE = '待机呼吸休闲.webm';
const RECONNECT_MS = 2000;
const POSE_MS = 1000;
const BUBBLE_PAD = 16; // 8px gap above the stage + 8px at the top of the bubble

app.setName('ds-pet-body');
// Muted clips normally autoplay, but the brain may load a clip before any
// user gesture; this keeps Chromium from blocking it.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Transparent layered windows on Windows have DWM artefacts while playing
// video when hardware compositing is used (black borders / disappearing
// overlaps).  The body disables it for the same class of window; it only
// paints a 300px clip, so software compositing is cheap.
if (process.platform === 'win32') app.disableHardwareAcceleration();

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

const BODY_WIDTH = Math.max(40, Math.round(envNumber('BODY_WIDTH', DEFAULT_WIDTH)));
const BASE_HEIGHT = Math.round((BODY_WIDTH * 9) / 16);
/** Empty canvas under the feet, in window pixels: the window hangs this much below the work area's bottom. */
const FOOT_PAD = Math.round((BASE_HEIGHT * (CANVAS_H - FEET_Y)) / CANVAS_H);
const CLIPS_DIR = process.env.BODY_CLIPS || '';
const BODY_WS = process.env.BODY_WS || '';
const BODY_IDLE = process.env.BODY_IDLE || DEFAULT_IDLE;

/** @type {BrowserWindow|null} */
let win = null;
let pageReady = false;
const pageQueue = [];
let bubbleExtra = 0;
let ignoring = true;
let facing = 'left';
let pagePressed = false;

/** 'idle' | 'moving' | 'held' | 'falling' */
let mode = 'idle';
/** @type {null|{id:any, area:any, model:any}} */
let move = null;
/** @type {null|{id:any, area:any, startLeft:number, targetLeft:number, leadSec:number, tailSec:number, duration:number|null, active:boolean}} */
let travel = null;
/** @type {null|{offsetX:number, offsetY:number}} */
let drag = null;
let dragInteractionId = null;
let petInteractionId = null;

function touchPosition(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return {};
  return { position: { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) } };
}
let lastDragReport = 0;
/** @type {null|{area:any, bounds:any, width:number, height:number, state:any}} */
let fall = null;

/** @type {WebSocket|null} */
let socket = null;
let socketOpen = false;
let reconnectTimer = null;
let poseTimer = null;
let tickTimer = null;
let topmostTimer = null;
let pointerTimer = null;
let pointerTimer2 = null;
let optionRects = [];
let lastTick = performance.now();
let quitting = false;

/** Her input window, while it is open (the talk button opens it). */
let talk = null;
/** True while the input method is composing: its candidate window takes focus, the input window must stay. */
let talkComposing = false;
const TALK = { width: 340, height: 52, gap: 8 };

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

function displayOfWindow() {
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay();
  const bounds = win.getBounds();
  // Use the character's feet, not the whole window: a tall speech bubble must
  // not move the body to another display for geometry purposes.
  return screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height - 1),
  });
}

function currentArea() {
  return displayOfWindow().workArea;
}

function shareOfWindow(area) {
  if (!win || win.isDestroyed()) return 0;
  const bounds = win.getBounds();
  return motion.centreShare(area, bounds.width, bounds.x);
}

function positionTalk() {
  if (!talk || talk.isDestroyed() || !win || win.isDestroyed()) return;
  const area = displayOfWindow().workArea;
  const bounds = win.getBounds();
  const talkBounds = talk.getBounds();
  const headY = bounds.y + bubbleExtra + (HIT_BOX.y0 / CANVAS_H) * BASE_HEIGHT;
  const x = Math.round(Math.min(Math.max(area.x + 8, bounds.x + (bounds.width - talkBounds.width) / 2), area.x + area.width - talkBounds.width - 8));
  const y = Math.round(Math.max(area.y + 8, headY - talkBounds.height - TALK.gap));
  talk.setPosition(x, y, false);
}

// The bounds last asked for. Moving compares against these, never against a read-back: on a scaled display the
// read-back never equals what was set, and comparing with it resets the window every frame.
let asked = null;

function setWindowPosition(left, top) {
  if (!win || win.isDestroyed()) return;
  const size = asked ?? win.getBounds();
  const rect = { x: Math.round(left), y: Math.round(top), width: size.width, height: size.height };
  if (asked && asked.x === rect.x && asked.y === rect.y && asked.width === rect.width && asked.height === rect.height) return;
  asked = rect;
  win.setBounds(rect, false);
  positionTalk();
}

function setWindowX(left) {
  if (!win || win.isDestroyed()) return;
  const now = asked ?? win.getBounds();
  setWindowPosition(left, now.y);
}

// ---------------------------------------------------------------------------
// speech bubble geometry
// ---------------------------------------------------------------------------

function maxBubbleExtra() {
  const area = currentArea();
  return Math.max(0, Math.floor(area.height - BASE_HEIGHT - 24));
}

/**
 * Grow/shrink the window upward while keeping its bottom edge (and therefore
 * the character) fixed on screen.  If a drag or fall is in flight, move its
 * coordinate state by the same amount so the pointer/physics stay coherent.
 */
function applyBubbleExtra(value) {
  if (!win || win.isDestroyed()) return 0;
  const requested = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  const next = clamp(requested, 0, maxBubbleExtra());
  if (next === bubbleExtra) return bubbleExtra;

  const bounds = win.getBounds();
  const height = BASE_HEIGHT + next;
  const delta = height - bounds.height;
  const y = bounds.y - delta;

  if (fall) {
    fall.state.y -= delta;
    fall.height = height;
    fall.bounds = motion.fallBounds(fall.area, fall.width, height, FOOT_PAD);
  }
  if (drag) {
    // The pointer stays put; after the window edge moves by -delta, its offset
    // inside the window grows by delta.
    drag.offsetY += delta;
  }

  bubbleExtra = next;
  asked = { x: asked?.x ?? bounds.x, y, width: bounds.width, height };
  win.setBounds(asked, false);
  positionTalk();
  return bubbleExtra;
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  // where she stood last time (BODY_START_X, kept by the plugin host), else the middle
  const started = Number(process.env.BODY_START_X);
  const share = Number.isFinite(started) && started >= 0 && started <= 1 ? started : 0.5;
  const left = motion.targetLeft(area, BODY_WIDTH, share);
  const top = motion.bottomTop(area, BASE_HEIGHT, FOOT_PAD);

  win = new BrowserWindow({
    width: BODY_WIDTH,
    height: BASE_HEIGHT,
    x: Math.round(left),
    y: Math.round(top),
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true, // but showInactive(), so it only focuses when clicked
    resizable: false,
    // macOS otherwise clamps a window to the menu bar; the hand may lift the
    // character above the work area before it falls back.
    enableLargerThanScreen: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  // screen-saver is the level that stays above the taskbar on Windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* not supported on every platform */
  }
  // On Windows, forwarding installs a global WH_MOUSE_LL hook. Cursor polling
  // below handles hit testing without putting Electron on the input path.
  win.setIgnoreMouseEvents(true);
  ignoring = true;

  // Kept hidden while the brain works out where she may stand; `{t:'show'}` reveals her.
  const HIDDEN_START = process.env.BODY_HIDDEN === '1';
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed() && !HIDDEN_START) win.showInactive();
  });
  // A paintWhenInitiallyHidden edge case can keep ready-to-show away forever;
  // showInactive is harmless if it already fired.
  setTimeout(() => {
    if (!HIDDEN_START && win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  }, 800).unref?.();

  win.webContents.on('did-finish-load', () => {
    pageReady = true;
    while (pageQueue.length) {
      const item = pageQueue.shift();
      win.webContents.send(item.channel, item.payload);
    }
  });
  // the page's own log lines reach this process (otherwise a renderer error is invisible from outside)
  win.webContents.on('console-message', (_event, level, message) => {
    if (process.env.LINGXI_DEBUG === '1' && String(message).startsWith('[bubble]')) console.log(String(message).slice(0, 200));
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    pagePressed = false;
    console.error('[body] renderer gone:', details && details.reason);
  });
  win.on('closed', () => {
    win = null;
    pageReady = false;
    pagePressed = false;
    pageQueue.length = 0;
    clearInterval(tickTimer);
    clearInterval(topmostTimer);
    clearInterval(pointerTimer);
  clearInterval(pointerTimer2);
    stopPose();
  });

  win.loadFile(path.join(__dirname, 'body.html')).catch((error) => {
    console.error('[body] page load failed:', error && error.message ? error.message : String(error));
  });

  // Re-assert the topmost band occasionally: WS_EX_TOPMOST can be cleared by
  // other topmost tools while the window is still visible.
  topmostTimer = setInterval(() => {
    if (win && !win.isDestroyed() && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 5000);
  topmostTimer.unref?.();

  pointerTimer = setInterval(pollPointer, 60);
  // the same tick also tells the brain where the pointer is (T1: cursor could not mean the mouse before)
  pointerTimer2 = setInterval(reportPointer, 120);
  pointerTimer2.unref?.();
  pointerTimer.unref?.();
}

function setInteractive(interactive) {
  if (!win || win.isDestroyed()) return;
  const ignore = !interactive;
  if (ignore === ignoring) return;
  ignoring = ignore;
  win.setIgnoreMouseEvents(ignore);
}

/**
 * Hover test from the real cursor. Polling avoids a global mouse hook and
 * also handles a move command sliding the character under a stationary
 * pointer with no event at all. Polling the cursor keeps
 * "click-through everywhere except the hit box" true in that case.  A press
 * (below the pick-up threshold) also blocks the fallback from turning
 * click-through back on before pointerup arrives.
 */
/** Report where the pointer is (screen coordinates) so `cursor` can mean the pointer, not her own place. */
let lastPointer = null;
function reportPointer() {
  try {
    const at = screen.getCursorScreenPoint();
    if (lastPointer && Math.abs(at.x - lastPointer.x) + Math.abs(at.y - lastPointer.y) < 3) return;
    lastPointer = at;
    sendOutgoing({ t: 'pointer', x: Math.round(at.x), y: Math.round(at.y) });
  } catch { /* a display can go away between polls */ }
}

function pointerInsideHitBox() {
  if (!win || win.isDestroyed()) return false;
  const bounds = win.getBounds();
  const point = screen.getCursorScreenPoint();
  const stageTop = bounds.y + bounds.height - BASE_HEIGHT;
  const left = bounds.x + (HIT_BOX.x0 / CANVAS_W) * bounds.width;
  const right = bounds.x + (HIT_BOX.x1 / CANVAS_W) * bounds.width;
  const top = stageTop + (HIT_BOX.y0 / CANVAS_H) * BASE_HEIGHT;
  const bottom = stageTop + (HIT_BOX.y1 / CANVAS_H) * BASE_HEIGHT;
  return point.x >= left && point.x < right && point.y >= top && point.y < bottom;
}

function pointerInsideOption() {
  if (!win || win.isDestroyed() || !optionRects.length) return false;
  const bounds = win.getBounds();
  const point = screen.getCursorScreenPoint();
  const stageTop = bounds.y + bounds.height - BASE_HEIGHT;
  return optionRects.some((rect) => {
    const left = bounds.x + rect.left;
    const right = bounds.x + rect.right;
    const top = stageTop + rect.top;
    const bottom = stageTop + rect.bottom;
    return point.x >= left && point.x < right && point.y >= top && point.y < bottom;
  });
}

function pollPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (pointerInsideHitBox() || pointerInsideOption()) {
    setInteractive(true);
  } else if (mode !== 'held' && !pagePressed) {
    setInteractive(false);
  }
}

// ---------------------------------------------------------------------------
// page messages
// ---------------------------------------------------------------------------

function sendToPage(channel, payload) {
  if (!win || win.isDestroyed()) return false;
  if (!pageReady) {
    if (pageQueue.length < 200) pageQueue.push({ channel, payload });
    return true;
  }
  try {
    win.webContents.send(channel, payload);
    return true;
  } catch (error) {
    console.error('[body] page send failed:', error && error.message ? error.message : String(error));
    return false;
  }
}

function resolveClip(name) {
  if (!CLIPS_DIR) return { ok: false, reason: 'BODY_CLIPS is not set' };
  if (!path.isAbsolute(CLIPS_DIR)) return { ok: false, reason: 'BODY_CLIPS is not an absolute path' };
  if (!protocol.isClipName(name)) return { ok: false, reason: 'clip is not a file name' };
  const file = path.join(CLIPS_DIR, name);
  try {
    if (!fs.statSync(file).isFile()) return { ok: false, reason: `missing file: ${name}` };
  } catch {
    return { ok: false, reason: `missing file: ${name}` };
  }
  return { ok: true, url: pathToFileURL(file).href };
}

function pageConfig() {
  const idle = resolveClip(BODY_IDLE);
  const area = currentArea();
  const maxExtra = Math.max(0, Math.floor(area.height - BASE_HEIGHT - 24));
  return {
    width: BODY_WIDTH,
    height: BASE_HEIGHT,
    hitBox: { left: HIT_BOX.x0 / CANVAS_W, right: HIT_BOX.x1 / CANVAS_W, top: HIT_BOX.y0 / CANVAS_H, bottom: HIT_BOX.y1 / CANVAS_H },
    idle: BODY_IDLE,
    selftest: process.env.BODY_SELFTEST === '1',
    idleUrl: idle.ok ? idle.url : '',
    idleError: idle.ok ? null : idle.reason,
    // The page adds BUBBLE_PAD (16) when it asks for extra height, so leave
    // that pad out of the text area itself.
    maxBubbleHeight: Math.max(60, maxExtra - BUBBLE_PAD),
  };
}

// ---------------------------------------------------------------------------
// move / drag / fall
// ---------------------------------------------------------------------------

function moveReport(current, state) {
  if (!current || current.id === undefined) return;
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
  const x = bounds ? motion.centreShare(current.area, bounds.width, bounds.x) : 0;
  sendOutgoing({ t: 'move', id: current.id, state, x });
}

function interruptMove() {
  if (!move) return false;
  const current = move;
  move = null;
  if (mode === 'moving') mode = 'idle';
  moveReport(current, 'interrupted');
  return true;
}

function finishMove() {
  if (!move) return;
  const current = move;
  move = null;
  if (mode === 'moving') mode = 'idle';
  moveReport(current, 'arrived');
}

/**
 * A travel is the page's per-frame clip time driving the window.  It is a
 * different kind of move from the 60 Hz line/spring timer, so it has its own
 * slot; only one of `move`/`travel` should be live at once.
 */
function interruptTravel() {
  if (!travel) return false;
  const current = travel;
  travel = null;
  // A clip that is still loading never moved the window; report only a travel
  // that actually started.  Its `clip` event already says what happened.
  if (current.active) moveReport(current, 'interrupted');
  return true;
}

function finishTravel() {
  if (!travel) return;
  const current = travel;
  travel = null;
  setWindowX(current.targetLeft);
  moveReport(current, 'arrived');
}

/**
 * One animation-frame sample from the page.  The x is computed from the clip's
 * currentTime through the same pure function the tests drive, never from a
 * wall-clock timer in the main process.
 */
function applyTravelTime(payload) {
  if (!travel || !win || win.isDestroyed()) return;
  const id = payload && payload.id;
  const t = Number(payload && payload.t);
  const duration = Number(payload && payload.duration);
  if (!protocol.isId(id) || id !== travel.id) return;
  if (!Number.isFinite(t) || !Number.isFinite(duration) || duration < 0) return;

  travel.duration = duration;
  travel.active = true;
  if (duration === 0) {
    finishTravel();
    return;
  }
  setWindowX(
    motion.travelX({
      start: travel.startLeft,
      target: travel.targetLeft,
      leadSec: travel.leadSec,
      tailSec: travel.tailSec,
      duration,
      t,
    }),
  );
  const arriveAt = Math.max(0, duration - travel.tailSec);
  if (t >= arriveAt) finishTravel();
}

function startMove(command) {
  if (!win || win.isDestroyed()) return;
  const area = currentArea();
  const bounds = win.getBounds();
  const target = motion.targetLeft(area, bounds.width, command.x);
  interruptTravel(); // a move replaces a travel as it replaces a move
  interruptMove(); // a replaced move reports interrupted before the new one
  const model = motion.createMove({
    mode: command.mode,
    from: bounds.x,
    to: target,
    ms: command.ms,
  });
  move = { id: command.id, area, model };
  mode = 'moving';
  if (model.done) {
    setWindowX(model.x);
    finishMove();
  }
}

function beginGrab(payload) {
  if (!win || win.isDestroyed()) return;
  if (mode === 'held' && drag) return;
  interruptTravel();
  if (mode === 'moving') interruptMove();
  if (mode === 'falling') {
    fall = null;
    mode = 'idle';
  }
  const bounds = win.getBounds();
  const cursor = screen.getCursorScreenPoint();
  let pressX = Number(payload && payload.pressX);
  let pressY = Number(payload && payload.pressY);
  // The page sends the original press point; if it is missing or implausible
  // (DPI/synthetic event), fall back to the real cursor at pickup.
  if (
    !Number.isFinite(pressX) ||
    !Number.isFinite(pressY) ||
    Math.hypot(pressX - cursor.x, pressY - cursor.y) > 150
  ) {
    pressX = cursor.x;
    pressY = cursor.y;
  }
  drag = { offsetX: pressX - bounds.x, offsetY: pressY - bounds.y };
  dragInteractionId = randomUUID();
  lastDragReport = 0;
  mode = 'held';
  const at = Number(payload && payload.at);
  sendOutgoing({
    t: 'grab',
    x: motion.centreShare(currentArea(), bounds.width, bounds.x),
    at: Number.isFinite(at) ? at : Date.now(),
    interactionId: dragInteractionId,
    ...touchPosition(payload && payload.position),
  });
}

function startFall(vx, vy, shouldThrow = true) {
  if (!win || win.isDestroyed()) return;
  const area = currentArea();
  const bounds = win.getBounds();
  const clamped = motion.clampWindow(area, bounds.width, bounds.height, bounds.x, bounds.y, FOOT_PAD);
  // The pack's release algorithm decides whether this is a throw. The body only
  // applies the returned velocity; it must not keep a second threshold here.
  const throwVx = shouldThrow ? vx : 0;
  fall = {
    area,
    bounds: motion.fallBounds(area, bounds.width, bounds.height, FOOT_PAD),
    width: bounds.width,
    height: bounds.height,
    // "fall straight down": the drop's reported vy is information for the
    // brain; the body starts from rest vertically and lets gravity do it.
    state: { x: clamped.x, y: clamped.y, vx: throwVx, vy: 0 },
  };
  mode = 'falling';
  setWindowPosition(clamped.x, clamped.y);
}

function endGrab(payload) {
  if (!drag || mode !== 'held') return;
  if (!win || win.isDestroyed()) return;
  // The page sends the pointer path; the movement maths (the figure pack's) turns it into a release speed.
  const trail = Array.isArray(payload && payload.trail) ? payload.trail.filter((sample) => sample
    && Number.isFinite(sample.t) && Number.isFinite(sample.x) && Number.isFinite(sample.y)).slice(-200) : [];
  const now = Number(payload && payload.now);
  const release = motion.estimateReleaseVelocity(trail, Number.isFinite(now) ? now : Date.now());
  const releaseVx = Number.isFinite(release && release.vx) ? release.vx : 0;
  const releaseVy = Number.isFinite(release && release.vy) ? release.vy : 0;
  const bounds = win.getBounds();
  const area = currentArea();
  const x = motion.centreShare(area, bounds.width, bounds.x);
  drag = null;
  sendOutgoing({ t: 'drop', x, vx: releaseVx, vy: releaseVy, interactionId: dragInteractionId, at: Date.now() });
  startFall(releaseVx, releaseVy, release?.throw !== false);
}

// ---------------------------------------------------------------------------
// 60 Hz clock
// ---------------------------------------------------------------------------

function tick() {
  if (!win || win.isDestroyed()) return;
  const now = performance.now();
  const dt = Math.max(0, (now - lastTick) / 1000);
  lastTick = now;

  if (mode === 'moving' && move) {
    const x = move.model.step(dt);
    setWindowX(x);
    if (move.model.done) finishMove();
    return;
  }

  if (mode === 'held' && drag) {
    const point = screen.getCursorScreenPoint();
    setWindowPosition(point.x - drag.offsetX, point.y - drag.offsetY);
    if (dragInteractionId && now - lastDragReport >= 120) {
      lastDragReport = now;
      sendOutgoing({ t: 'drag-move', interactionId: dragInteractionId, at: Date.now(), x: point.x, y: point.y });
    }
    return;
  }

  if (mode === 'falling' && fall) {
    const result = motion.fallStep(fall.state, dt, fall.bounds);
    fall.state = { x: result.x, y: result.y, vx: result.vx, vy: result.vy };
    setWindowPosition(result.x, result.y);
    if (result.atRest) {
      const current = fall;
      fall = null;
      mode = 'idle';
      const bounds = win.getBounds();
      sendOutgoing({
        t: 'landed',
        x: motion.centreShare(current.area, bounds.width, bounds.x),
        ...(dragInteractionId ? { interactionId: dragInteractionId, at: Date.now() } : {}),
      });
      dragInteractionId = null;
    }
  }
}

// ---------------------------------------------------------------------------
// brain socket
// ---------------------------------------------------------------------------

function sendOutgoing(message) {
  const check = protocol.validateOutgoing(message);
  if (!check.ok) {
    console.error('[body] refusing to send malformed message:', check.error, message);
    return false;
  }
  if (!socketOpen || !socket || socket.readyState !== 1) return false;
  try {
    socket.send(protocol.encodeMessage(message));
    return true;
  } catch (error) {
    console.error('[body] send failed:', error && error.message ? error.message : String(error));
    return false;
  }
}

function sendHello() {
  if (!win || win.isDestroyed()) return;
  const display = displayOfWindow();
  const area = display.workArea;
  const bounds = win.getBounds();
  sendOutgoing({
    t: 'hello',
    display: {
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      scale: display.scaleFactor,
    },
    x: motion.centreShare(area, bounds.width, bounds.x),
    facing,
  });
}

function sendPose() {
  if (!socketOpen || !win || win.isDestroyed()) return;
  sendOutgoing({ t: 'pose', x: shareOfWindow(currentArea()), facing });
}

function startPose() {
  stopPose();
  poseTimer = setInterval(sendPose, POSE_MS);
}

function stopPose() {
  if (poseTimer) clearInterval(poseTimer);
  poseTimer = null;
}

function scheduleReconnect() {
  if (quitting) return;
  if (!BODY_WS || typeof WebSocket !== 'function' || reconnectTimer || socket) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

async function onSocketMessage(event) {
  let data = event && event.data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try {
      data = await data.text();
    } catch {
      /* leave it to the type check below */
    }
  }
  const parsed = protocol.parseMessage(data);
  if (!parsed.ok) {
    sendOutgoing({ t: 'error', message: parsed.error });
    return;
  }
  handleCommand(parsed.value);
}

function handleCommand(command) {
  // While held or falling the body takes no movement/speech commands: it
  // reports busy and drops them.  A `play` during a grab is the one deliberate
  // exception — the hand section says the brain may pick a held clip *after*
  // `grab` — so a clip can still be chosen while the pointer is down.
  const locked = mode === 'held' || mode === 'falling';
  const heldClipChoice = mode === 'held' && command.t === 'play';
  if (locked && !heldClipChoice) {
    sendOutgoing({ t: 'busy', for: command.t, id: command.id === undefined ? null : command.id });
    return;
  }

  switch (command.t) {
    case 'play': {
      const resolved = resolveClip(command.clip);
      if (!resolved.ok) {
        sendOutgoing({ t: 'clip', id: command.id, state: 'failed', reason: resolved.reason });
        return;
      }

      // A travel is a movement command, so it takes over from a line/spring
      // move.  A plain play leaves a move alone.  Either way the clip replaces
      // any travel's clip; only a travel that has actually started reports
      // `move interrupted`.
      const wantsTravel = !!command.travel;
      if (wantsTravel) interruptMove();
      interruptTravel();

      // A play while held is allowed for a held clip, but the hand owns the
      // window then; the clip still plays once, just without travel.
      const canTravel = wantsTravel && mode !== 'held' && win && !win.isDestroyed();
      if (canTravel) {
        const area = currentArea();
        const bounds = win.getBounds();
        travel = {
          id: command.id,
          area,
          startLeft: bounds.x,
          targetLeft: motion.targetLeft(area, bounds.width, command.travel.x),
          leadSec: command.travel.leadSec,
          tailSec: command.travel.tailSec,
          duration: null,
          active: false,
        };
      }

      sendToPage('body:play', {
        id: command.id,
        clip: command.clip,
        loop: wantsTravel ? false : command.loop,
        facing: command.facing,
        endSec: command.endSec,
        segment: canTravel ? command.segment : undefined,
        travel: canTravel
          ? { leadSec: travel.leadSec, tailSec: travel.tailSec }
          : undefined,
        url: resolved.url,
      });
      return;
    }

    case 'move':
      startMove(command);
      return;

    case 'think':
      sendToPage('body:think', { on: !!command.on });
      return;
    case 'said':
      sendToPage('body:said', { text: command.text });
      return;

    case 'show':
      if (win && !win.isDestroyed()) win.showInactive();
      return;

    case 'say': {
      let ms = command.ms;
      if (ms === null) {
        const chars = Array.from(command.text).length;
        ms = Math.min(12000, 2500 + 150 * chars);
      }
      sendToPage('body:say', {
        text: command.text,
        ...(command.id !== undefined ? { id: command.id } : {}),
        ...(command.replyId !== undefined ? { replyId: command.replyId } : {}),
        ...(command.question ? { question: command.question } : {}),
        ms,
        // Beats go through whole: the page types them, keeps trails and fires their actions
        ...(command.beats ? { beats: command.beats } : {}),
        ...(command.hold !== null && command.hold !== undefined ? { hold: command.hold } : {}),
        maxBubbleHeight: Math.max(60, maxBubbleExtra() - BUBBLE_PAD),
      });
      return;
    }

    case 'stop': {
      if (!move) return;
      if (command.id !== null && move.id !== command.id) return;
      interruptMove();
      return;
    }

    default:
      // protocol.cjs already rejects unknown types; keep this defensive.
      sendOutgoing({ t: 'error', message: `unknown command type: ${command.t}` });
  }
}

function connect() {
  if (!BODY_WS || typeof WebSocket !== 'function' || socket) return;
  let next;
  try {
    next = new WebSocket(BODY_WS);
  } catch (error) {
    console.error('[body] WebSocket connect failed:', error && error.message ? error.message : String(error));
    scheduleReconnect();
    return;
  }
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    socketOpen = true;
    console.error('[body] brain connected');
    sendHello();
    startPose();
  });

  next.addEventListener('message', (event) => {
    if (socket !== next) return;
    onSocketMessage(event).catch((error) => {
      console.error('[body] message handling failed:', error && error.message ? error.message : String(error));
    });
  });

  next.addEventListener('error', (event) => {
    const reason = event && event.message ? event.message : 'socket error';
    console.error('[body] WebSocket error:', reason);
    // The close event will schedule the retry; closing here also covers
    // implementations that only emit error.
    try {
      if (next.readyState !== 3) next.close();
    } catch {
      /* ignore */
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    socketOpen = false;
    stopPose();
    console.error('[body] brain disconnected; retrying in ' + RECONNECT_MS + 'ms');
    scheduleReconnect();
  });
}

function startBrainLink() {
  if (!BODY_WS) {
    console.error('[body] BODY_WS is not set; running without a brain');
    return;
  }
  if (typeof WebSocket !== 'function') {
    console.error(
      '[body] global WebSocket is missing in this Electron/Node build; ' +
        'the body cannot connect to BODY_WS (see README)',
    );
    return;
  }
  connect();
}

// ---------------------------------------------------------------------------
// IPC / app
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// her input window
//
// The talk button in her page opens this: a small frameless window just above her, one line to type in. Enter sends
// what was typed to the brain as `typed`, and the brain hands it to the front the same way the DSH page does; Esc, a
// click outside, or sending closes it. The body still decides nothing: it carries the words and opens the window.
// ---------------------------------------------------------------------------

function closeTalk() {
  if (!talk) return;
  sendToPage('body:talk-state', { open: false });
  const closing = talk;
  talk = null;
  talkComposing = false;
  if (!closing.isDestroyed()) closing.destroy();
}

function openTalk() {
  if (!win || win.isDestroyed()) return;
  if (talk && !talk.isDestroyed()) {
    sendToPage('body:talk-state', { open: true });
    positionTalk();
    talk.show();
    talk.focus();
    return;
  }
  const area = displayOfWindow().workArea;
  const bounds = win.getBounds();
  const x = Math.round(Math.min(Math.max(area.x + 8, bounds.x + (bounds.width - TALK.width) / 2), area.x + area.width - TALK.width - 8));
  const headY = bounds.y + bubbleExtra + (HIT_BOX.y0 / CANVAS_H) * BASE_HEIGHT;
  const y = Math.round(Math.max(area.y + 8, headY - TALK.height - TALK.gap));
  talk = new BrowserWindow({
    width: TALK.width,
    height: TALK.height,
    x,
    y,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'talk-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  talk.setAlwaysOnTop(true, 'screen-saver');
  sendToPage('body:talk-state', { open: true });
  talk.loadFile(path.join(__dirname, 'talk.html')).catch((error) => {
    console.error('[body] input window failed:', error && error.message ? error.message : String(error));
    closeTalk();
  });
  talk.once('ready-to-show', () => {
    if (!talk || talk.isDestroyed()) return;
    positionTalk();
    talk.show();
    talk.focus();
  });
  talk.on('blur', () => { if (!talkComposing) closeTalk(); });
  talk.on('closed', () => {
    talk = null;
  });
}

function registerIpc() {
  ipcMain.on('body:config', (event) => {
    event.returnValue = pageConfig();
  });

  ipcMain.on('body:interactive', (_event, interactive) => {
    setInteractive(!!interactive);
  });

  ipcMain.on('body:option-rects', (_event, rects) => {
    optionRects = Array.isArray(rects) ? rects.filter((r) => (
      r && Number.isFinite(r.left) && Number.isFinite(r.top) &&
      Number.isFinite(r.right) && Number.isFinite(r.bottom) &&
      r.right > r.left && r.bottom > r.top
    )).slice(0, 16) : [];
  });

  ipcMain.on('body:pressed', (_event, value) => {
    pagePressed = !!value;
  });

  // actions the page fires at a typed offset (an anchor), sent on to the brain as her own act
ipcMain.on('body:acts', (_event, actions) => {
  if (Array.isArray(actions) && actions.length) sendOutgoing({ t: 'act', actions });
});

ipcMain.handle('body:bubble', (_event, extra) => applyBubbleExtra(extra));

  ipcMain.on('body:grab', (_event, payload) => beginGrab(payload));

  ipcMain.on('body:drop', (_event, payload) => endGrab(payload));

  ipcMain.on('body:click', (_event, payload) => {
    if (!win || win.isDestroyed() || mode === 'held') return;
    sendOutgoing({ t: 'click', x: shareOfWindow(currentArea()), interactionId: payload?.interactionId || randomUUID(), at: Date.now(),
      ...(Number.isFinite(payload?.startedAt) ? { startedAt: payload.startedAt } : {}), ...touchPosition(payload?.position) });
  });

  ipcMain.on('body:pet', (_event, payload) => {
    if (!win || win.isDestroyed() || mode === 'held' || !payload || typeof payload.interactionId !== 'string') return;
    if (payload.phase === 'started') {
      if (petInteractionId) return;
      petInteractionId = payload.interactionId;
    } else if (!['completed', 'cancelled'].includes(payload.phase) || petInteractionId !== payload.interactionId) return;
    sendOutgoing({ t: 'pet', x: shareOfWindow(currentArea()), interactionId: payload.interactionId,
      phase: payload.phase, at: Date.now(), ...touchPosition(payload.position) });
    if (payload.phase !== 'started') petInteractionId = null;
  });

  ipcMain.on('body:talk', () => openTalk());

  ipcMain.on('body:talk-close', () => closeTalk());

  ipcMain.on('body:talk-composing', (_event, value) => { talkComposing = !!value; });

  ipcMain.on('body:talk-send', (_event, text) => {
    const said = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    closeTalk();
    if (!said) return;
    sendToPage('body:said', { text: said });
    // the brain hands this to the front exactly as if it had come from her page in DSH
    sendOutgoing({ t: 'typed', text: said });
  });

  ipcMain.on('body:answer', (_event, payload) => {
    const message = { t: 'answer', ...(payload && typeof payload === 'object' ? payload : {}) };
    const result = protocol.validateOutgoing(message);
    if (result.ok) sendOutgoing(message);
  });

  ipcMain.on('body:travel-time', (_event, payload) => applyTravelTime(payload));

  ipcMain.on('body:facing', (_event, value) => {
    if (value === 'left' || value === 'right') facing = value;
  });

  ipcMain.on('body:clip', (_event, payload) => {
    const id = payload && payload.id;
    const state = payload && payload.state;
    if (!protocol.isId(id) || !protocol.CLIP_STATES.has(state)) {
      console.error('[body] page sent a malformed clip event:', payload);
      return;
    }
    const message = { t: 'clip', id, state };
    if (payload && typeof payload.reason === 'string') message.reason = payload.reason;
    sendOutgoing(message);
  });

  ipcMain.on('body:speech', (_event, payload) => {
    const message = { t: 'speech', id: payload?.id, ...(payload?.outputId ? { outputId: payload.outputId } : {}), state: payload?.state };
    if (protocol.validateOutgoing(message).ok) sendOutgoing(message);
  });

  ipcMain.on('body:error', (_event, message) => {
    const text = typeof message === 'string' && message ? message : 'unknown page error';
    console.error('[body] page error:', text);
    sendOutgoing({ t: 'error', message: text });
  });
}

app.whenReady().then(() => {
  console.error(
    '[body] starting width=' +
      BODY_WIDTH +
      ' clips=' +
      (CLIPS_DIR || '(unset)') +
      ' ws=' +
      (BODY_WS || '(unset)') +
      ' globalWebSocket=' +
      (typeof WebSocket === 'function' ? 'yes' : 'no'),
  );
  const idle = resolveClip(BODY_IDLE);
  if (!idle.ok) console.error('[body] idle clip unavailable:', idle.reason);
  registerIpc();
  createWindow();
  lastTick = performance.now();
  tickTimer = setInterval(tick, 1000 / 60);
  tickTimer.unref?.();
  startBrainLink();
});

app.on('before-quit', () => {
  quitting = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopPose();
});

process.on('message', (message) => {
  if (message?.type === 'show' && win && !win.isDestroyed()) win.showInactive();
  if (message?.type === 'quit' && !app.isQuitting) app.quit();
});

app.on('window-all-closed', () => {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  app.quit();
});
