/**
 * ds-pet body — the two-video clip switching state, as plain functions.
 *
 * The page owns two <video> elements and this module owns *which* one is front
 * and *which generation* is allowed to commit.  A later play request always
 * wins: loading into the hidden element takes time, and a slow load finishing
 * after a newer request must not replace the newer clip.
 *
 * The two-video generation counter is this body's own state machine, kept
 * separate so node:test can drive it.
 *
 * UMD so node:test can require() the same state machine the page runs.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BodyClips = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FACINGS = new Set(['left', 'right']);

  /**
   * @param {{facing?:'left'|'right'}} [options]
   */
  function createClipState(options) {
    let facing = options && FACINGS.has(options.facing) ? options.facing : 'left';
    // Side 0 is <video> A, side 1 is B.  `front` only matters for choosing the
    // hidden element; it starts at A with nothing shown.
    let front = 0;
    let generation = 0;
    let current = null; // committed clip
    let pending = null; // loading clip

    const isQuiet = (clip) => !clip || clip.id === null || clip.id === undefined;

    function eventFor(clip, state, reason) {
      if (isQuiet(clip)) return null;
      const event = { id: clip.id, state };
      if (reason !== undefined) event.reason = reason;
      return event;
    }

    return {
      /**
       * Start loading a clip into the hidden element.
       * A pending clip that has not committed is reported `replaced` right
       * away; a playing clip is only reported `replaced` when the new clip
       * actually commits (a failed load must leave the old clip running).
       */
      request(request) {
        const replaced = [];
        if (pending) {
          const old = eventFor(pending, 'replaced');
          if (old) replaced.push(old);
        }
        generation += 1;
        const requestedFacing = request && FACINGS.has(request.facing) ? request.facing : null;
        const side = front === 0 ? 1 : 0;
        pending = {
          gen: generation,
          id: request && request.id !== undefined ? request.id : null,
          clip: request ? request.clip : '',
          loop: !!(request && request.loop),
          facing: requestedFacing || facing,
          source: request && request.source ? request.source : 'brain',
          side,
        };
        return { gen: generation, side, replaced, facing: pending.facing };
      },

      /** Is this generation still the one loading? */
      isPending(gen) {
        return !!pending && pending.gen === gen;
      },

      /**
       * The hidden video can play.  Commit it if it is still the newest
       * request; return the old front side and any `replaced` event.
       */
      commit(gen) {
        if (!pending || pending.gen !== gen) return null;
        const next = pending;
        pending = null;
        const previous = current;
        current = {
          gen: next.gen,
          id: next.id,
          clip: next.clip,
          loop: next.loop,
          facing: next.facing,
          source: next.source,
          side: next.side,
          playReported: false,
          ended: false,
          failed: false,
        };
        front = next.side;
        facing = next.facing;
        return {
          gen,
          side: next.side,
          previousSide: previous ? previous.side : null,
          previous,
          // A clip that already ended (or failed to play) was not cut short;
          // only report `replaced` for one that was still current when the new
          // clip took the stage.
          replaced:
            previous && !previous.ended && !previous.failed ? eventFor(previous, 'replaced') : null,
          facing,
          id: next.id,
        };
      },

      /** Report `playing` once, for the current generation only. */
      markPlaying(gen) {
        if (!current || current.gen !== gen || current.playReported || current.failed) return null;
        current.playReported = true;
        return eventFor(current, 'playing');
      },

      /** Report `ended` once for a non-looping current clip. */
      markEnded(gen) {
        if (!current || current.gen !== gen || current.ended || current.failed) return null;
        if (current.loop) return null;
        current.ended = true;
        return eventFor(current, 'ended');
      },

      /**
       * A load or play failure.  A loading clip is dropped; a committed clip
       * that never reached `playing` is reported failed but stays displayed
       * (its last frame) until something else is committed.
       */
      fail(gen, reason) {
        if (pending && pending.gen === gen) {
          const failed = pending;
          pending = null;
          return eventFor(failed, 'failed', reason);
        }
        if (current && current.gen === gen && !current.failed) {
          current.failed = true;
          return eventFor(current, 'failed', reason);
        }
        return null;
      },

      currentFacing() {
        return facing;
      },

      current() {
        return current ? { ...current } : null;
      },

      pending() {
        return pending ? { ...pending } : null;
      },

      frontSide() {
        return front;
      },

      /** Keep an in-generation double-buffer handoff aligned with the next request side. */
      setFrontSide(side) {
        if (side !== 0 && side !== 1) return false;
        front = side;
        if (current) current.side = side;
        return true;
      },
    };
  }

  return { createClipState };
});
