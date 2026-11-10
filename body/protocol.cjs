/**
 * ds-pet body — message shapes and checks.
 *
 * Deliberately free of Electron and of any I/O: main.cjs uses this before it
 * touches a window, and node:test loads it directly.  The body is a dumb
 * machine; a message that is not exactly one of the shapes below is rejected
 * and reported as `{ t: 'error', message }`.
 */

'use strict';

const MODES = new Set(['instant', 'line', 'spring']);
const FACINGS = new Set(['left', 'right']);
const CLIP_STATES = new Set(['playing', 'ended', 'replaced', 'failed']);
const MOVE_STATES = new Set(['arrived', 'interrupted']);
const COMMAND_TYPES = new Set(['play', 'move', 'say', 'said', 'show', 'stop', 'think']);

/** Default line-mode duration when `ms` is omitted (milliseconds). */
const DEFAULT_LINE_MS = 1000;

/** A finite id: numbers and non-empty strings are accepted. */
function isId(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/**
 * A clip is a *file name* inside BODY_CLIPS, never a path.  Rejecting
 * separators here keeps main.cjs from having to trust a brain-sent path.
 */
function isClipName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function fail(message) {
  return { ok: false, error: message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateOptionalBoolean(value, field) {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== 'boolean') return fail(`${field} must be a boolean`);
  return { ok: true, value };
}

function validateOptionalFacing(value) {
  if (value === undefined) return { ok: true, value: null };
  if (!FACINGS.has(value)) return fail("facing must be 'left' or 'right'");
  return { ok: true, value };
}

function validateOptionalMs(value, field) {
  if (value === undefined) return { ok: true, value: null };
  if (!isFiniteNumber(value) || value < 0) return fail(`${field} must be a finite number >= 0`);
  return { ok: true, value };
}

function validateOptionalSeconds(value, field) {
  if (value === undefined) return { ok: true, value: null };
  if (!isFiniteNumber(value) || value < 0) return fail(`${field} must be a finite number >= 0`);
  return { ok: true, value };
}

/**
 * `play.travel` couples a walking clip's motion to its own currentTime.  The
 * page reports the time; the main process only needs the two still stretches
 * and the target centre share.
 */
function validateOptionalTravel(value) {
  if (value === undefined) return { ok: true, value: null };
  if (!isObject(value)) return fail('play.travel must be an object');
  if (!isFiniteNumber(value.x)) return fail('play.travel.x must be a finite number');
  if (!isFiniteNumber(value.leadSec) || value.leadSec < 0) {
    return fail('play.travel.leadSec must be a finite number >= 0');
  }
  if (!isFiniteNumber(value.tailSec) || value.tailSec < 0) {
    return fail('play.travel.tailSec must be a finite number >= 0');
  }
  return {
    ok: true,
    value: { x: value.x, leadSec: value.leadSec, tailSec: value.tailSec },
  };
}

function validateOptionalSegment(value) {
  if (value === undefined) return { ok: true, value: null };
  if (!isObject(value)) return fail('play.segment must be an object');
  const { startSec, endSec, durationSec } = value;
  if (!isFiniteNumber(startSec) || startSec < 0) {
    return fail('play.segment.startSec must be a finite number >= 0');
  }
  if (!isFiniteNumber(endSec) || endSec <= startSec) {
    return fail('play.segment.endSec must be a finite number greater than startSec');
  }
  if (!isFiniteNumber(durationSec) || durationSec <= 0) {
    return fail('play.segment.durationSec must be a finite number > 0');
  }
  return { ok: true, value: { startSec, endSec, durationSec } };
}

/**
 * Validate and normalize one brain -> body message.
 *
 * @param {unknown} obj parsed JSON value
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
function validateMessage(obj) {
  if (!isObject(obj)) return fail('message must be a JSON object');
  if (typeof obj.t !== 'string' || obj.t.length === 0) return fail("message needs a string 't'");

  switch (obj.t) {
    case 'play': {
      if (!isId(obj.id)) return fail('play.id must be a string or finite number');
      if (!isClipName(obj.clip)) return fail('play.clip must be a file name with no path separators');
      const loop = validateOptionalBoolean(obj.loop, 'play.loop');
      if (!loop.ok) return loop;
      const facing = validateOptionalFacing(obj.facing);
      if (!facing.ok) return facing;
      const endSec = validateOptionalSeconds(obj.endSec, 'play.endSec');
      if (!endSec.ok) return endSec;
      const travel = validateOptionalTravel(obj.travel);
      if (!travel.ok) return travel;
      const segment = validateOptionalSegment(obj.segment);
      if (!segment.ok) return segment;
      if (segment.value && endSec.value !== null) return fail('play.segment cannot be combined with play.endSec');
      if (segment.value && (!travel.value || travel.value.leadSec !== 0 || travel.value.tailSec !== 0)) {
        return fail('play.segment requires play.travel with leadSec and tailSec set to 0');
      }
      const value = {
        t: 'play',
        id: obj.id,
        clip: obj.clip,
        // A travelling clip always plays once: its tail is the arrival, so
        // looping it would make the window arrive at the wrong time.
        loop: travel.value ? false : loop.value,
        facing: facing.value,
      };
      if (endSec.value !== null) value.endSec = endSec.value;
      if (travel.value) value.travel = travel.value;
      if (segment.value) value.segment = segment.value;
      return { ok: true, value };
    }

    case 'move': {
      if (!isId(obj.id)) return fail('move.id must be a string or finite number');
      if (!isFiniteNumber(obj.x)) return fail('move.x must be a finite number');
      if (!MODES.has(obj.mode)) return fail("move.mode must be 'instant', 'line' or 'spring'");
      const ms = validateOptionalMs(obj.ms, 'move.ms');
      if (!ms.ok) return ms;
      return {
        ok: true,
        value: {
          t: 'move',
          id: obj.id,
          x: obj.x,
          mode: obj.mode,
          // A line move needs a duration; instant/spring do not use it.
          ms: obj.mode === 'line' ? (ms.value === null ? DEFAULT_LINE_MS : ms.value) : ms.value,
        },
      };
    }

    case 'say': {
      if (typeof obj.text !== 'string') return fail('say.text must be a string');
      if (obj.id !== undefined && !isId(obj.id)) return fail('say.id must be a string or finite number');
      if (obj.replyId !== undefined && typeof obj.replyId !== 'string') return fail('say.replyId must be a string');
      const ms = validateOptionalMs(obj.ms, 'say.ms');
      if (!ms.ok) return ms;
      const beats = Array.isArray(obj.beats)
        ? obj.beats.filter((b) => b && typeof b.text === 'string').map((b) => ({
          text: b.text,
          ...(typeof b.outputId === 'string' ? { outputId: b.outputId } : {}),
          ...(Number.isFinite(b.hold) && b.hold >= 0 ? { hold: b.hold } : {}),
          actions: Array.isArray(b.actions) ? b.actions : [],
          anchors: Array.isArray(b.anchors) ? b.anchors.filter((a) => a && Number.isFinite(a.at) && Array.isArray(a.actions)) : [],
        }))
        : null;
      const hold = Number.isFinite(obj.hold) ? Math.max(0, obj.hold) : null;
      let question = null;
      if (obj.question !== undefined) {
        if (!isObject(obj.question) || typeof obj.question.id !== 'string' || typeof obj.question.question !== 'string' || !Array.isArray(obj.question.options) || !Number.isFinite(obj.question.at)) return fail('say.question is malformed');
        question = { id: obj.question.id, question: obj.question.question, options: obj.question.options.filter((o) => typeof o === 'string').slice(0, 3), at: obj.question.at, ...(typeof obj.question.requestId === 'string' ? { requestId: obj.question.requestId } : {}) };
      }
      return { ok: true, value: { t: 'say', text: obj.text, ms: ms.value, ...(obj.id !== undefined ? { id: obj.id } : {}), ...(typeof obj.replyId === 'string' ? { replyId: obj.replyId } : {}), ...(question ? { question } : {}), ...(beats?.length ? { beats } : {}), ...(hold !== null ? { hold } : {}) } };
    }

    case 'think':
      return { ok: true, value: { t: 'think', on: !!obj.on } };
    case 'said': {
      // what the person typed, shown above her own bubbles
      if (typeof obj.text !== 'string') return fail('said.text must be a string');
      return { ok: true, value: { t: 'said', text: obj.text } };
    }
    case 'answer': {
      if (typeof obj.questionId !== 'string' || !obj.questionId) return fail('answer.questionId must be a non-empty string');
      if (typeof obj.question !== 'string') return fail('answer.question must be a string');
      if (typeof obj.text !== 'string' || !obj.text.trim()) return fail('answer.text must be a non-empty string');
      if (obj.requestId !== undefined && typeof obj.requestId !== 'string') return fail('answer.requestId must be a string');
      return { ok: true, value: { t: 'answer', questionId: obj.questionId, question: obj.question, text: obj.text, ...(obj.requestId ? { requestId: obj.requestId } : {}) } };
    }

    case 'show':
      // reveal the window: the brain keeps her hidden until it knows where she may stand
      return { ok: true, value: { t: 'show' } };

    case 'stop': {
      if (obj.id !== undefined && !isId(obj.id)) return fail('stop.id must be a string or finite number');
      return { ok: true, value: { t: 'stop', id: obj.id === undefined ? null : obj.id } };
    }

    default:
      return fail(`unknown command type: ${obj.t}`);
  }
}

/** Decode a text/Buffer/ArrayBuffer WebSocket payload and validate it. */
function parseMessage(raw) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString('utf8');
  } else {
    return fail('message is not text');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (error) {
    return fail(`invalid JSON: ${error && error.message ? error.message : String(error)}`);
  }
  return validateMessage(obj);
}

function validateOutgoingDisplay(display) {
  if (!isObject(display)) return fail('hello.display must be an object');
  for (const key of ['x', 'y', 'width', 'height', 'scale']) {
    if (!isFiniteNumber(display[key])) return fail(`hello.display.${key} must be a finite number`);
  }
  return { ok: true };
}

/**
 * Validate a body -> brain message.  main.cjs runs every outgoing message
 * through this so a typo turns into a log line instead of a malformed frame.
 */
function validateOutgoing(msg) {
  if (isObject(msg) && msg.position !== undefined && (!isObject(msg.position) ||
    !['x', 'y'].every((key) => isFiniteNumber(msg.position[key]) && msg.position[key] >= 0 && msg.position[key] <= 1))) return fail('touch.position must be inside the body hit box');
  if (!isObject(msg) || typeof msg.t !== 'string') return fail('outgoing message needs a string t');
  switch (msg.t) {
    case 'hello': {
      const d = validateOutgoingDisplay(msg.display);
      if (!d.ok) return d;
      if (!isFiniteNumber(msg.x)) return fail('hello.x must be a finite number');
      if (!FACINGS.has(msg.facing)) return fail("hello.facing must be 'left' or 'right'");
      return { ok: true };
    }
    case 'clip':
      if (!isId(msg.id)) return fail('clip.id must be a string or finite number');
      if (!CLIP_STATES.has(msg.state)) return fail('clip.state is not a known state');
      if (msg.reason !== undefined && typeof msg.reason !== 'string') return fail('clip.reason must be a string');
      return { ok: true };
    case 'move':
      if (!isId(msg.id)) return fail('move.id must be a string or finite number');
      if (!MOVE_STATES.has(msg.state)) return fail('move.state must be arrived or interrupted');
      if (!isFiniteNumber(msg.x)) return fail('move.x must be a finite number');
      return { ok: true };
    case 'pointer':
      if (!isFiniteNumber(msg.x) || !isFiniteNumber(msg.y)) return fail('pointer needs finite x and y');
      return { ok: true };

    case 'grab':
      if (!isFiniteNumber(msg.x)) return fail('grab.x must be a finite number');
      if (!isFiniteNumber(msg.at)) return fail('grab.at must be a finite number');
      if (msg.interactionId !== undefined && !isId(msg.interactionId)) return fail('grab.interactionId must be a valid id');
      return { ok: true };
    case 'drop':
      for (const key of ['x', 'vx', 'vy']) if (!isFiniteNumber(msg[key])) return fail(`drop.${key} must be finite`);
      if (msg.interactionId !== undefined && !isId(msg.interactionId)) return fail('drop.interactionId must be a valid id');
      if (msg.at !== undefined && !isFiniteNumber(msg.at)) return fail('drop.at must be finite');
      return { ok: true };
    case 'drag-move':
      if (!isId(msg.interactionId) || !isFiniteNumber(msg.at) || !isFiniteNumber(msg.x) || !isFiniteNumber(msg.y)) return fail('drag-move requires interactionId, time, and finite position');
      return { ok: true };
    case 'landed':
    case 'click':
      if (!isFiniteNumber(msg.x)) return fail(`${msg.t}.x must be a finite number`);
      if (msg.interactionId !== undefined && !isId(msg.interactionId)) return fail('click.interactionId must be a valid id');
      if (msg.at !== undefined && !isFiniteNumber(msg.at)) return fail('click.at must be finite');
      if (msg.startedAt !== undefined && !isFiniteNumber(msg.startedAt)) return fail('click.startedAt must be finite');
      return { ok: true };
    case 'pet':
      if (!isFiniteNumber(msg.x) || !isFiniteNumber(msg.at) || !isId(msg.interactionId)) return fail('pet requires position, time, and interaction id');
      if (!['started', 'completed', 'cancelled'].includes(msg.phase)) return fail('pet.phase must be started, completed or cancelled');
      return { ok: true };
    case 'busy':
      if (!COMMAND_TYPES.has(msg.for)) return fail('busy.for must be a command type');
      if (msg.id !== null && !isId(msg.id)) return fail('busy.id must be null, a string or a finite number');
      return { ok: true };
    case 'pose':
      if (!isFiniteNumber(msg.x)) return fail('pose.x must be a finite number');
      if (!FACINGS.has(msg.facing)) return fail("pose.facing must be 'left' or 'right'");
      return { ok: true };
    case 'typed':
      // what the person typed into her input window; main.cjs trims it before sending
      if (typeof msg.text !== 'string' || msg.text.length === 0) return fail('typed.text must be a non-empty string');
      if (msg.text.length > 2000) return fail('typed.text is longer than 2000 characters');
      return { ok: true };
    case 'answer':
      if (typeof msg.questionId !== 'string' || !msg.questionId) return fail('answer.questionId must be a non-empty string');
      if (typeof msg.question !== 'string') return fail('answer.question must be a string');
      if (typeof msg.text !== 'string' || !msg.text.trim()) return fail('answer.text must be a non-empty string');
      if (msg.requestId !== undefined && typeof msg.requestId !== 'string') return fail('answer.requestId must be a string');
      return { ok: true };
    case 'speech':
      if (!isId(msg.id) || !['paused', 'resumed', 'completed', 'interrupted'].includes(msg.state)) return fail('speech requires a valid id and paused, resumed, completed, or interrupted state');
      if (msg.outputId !== undefined && typeof msg.outputId !== 'string') return fail('speech.outputId must be a string');
      return { ok: true };
    case 'act':
      // actions the page fires itself: a beat's lead-in, or an anchor at a typed offset
      if (!Array.isArray(msg.actions) || msg.actions.length === 0) return fail('act.actions must be a non-empty array');
      return { ok: true };
    case 'error':
      if (typeof msg.message !== 'string') return fail('error.message must be a string');
      return { ok: true };
    default:
      return fail(`unknown outgoing type: ${msg.t}`);
  }
}

function encodeMessage(msg) {
  return JSON.stringify(msg);
}

module.exports = {
  MODES,
  FACINGS,
  CLIP_STATES,
  MOVE_STATES,
  COMMAND_TYPES,
  DEFAULT_LINE_MS,
  isId,
  isClipName,
  validateMessage,
  parseMessage,
  validateOutgoing,
  encodeMessage,
};
