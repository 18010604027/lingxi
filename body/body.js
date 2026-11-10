/**
 * ds-pet body — page.
 *
 * Two video elements, one speech bubble, one hit box.  The page never decides
 * what to do: it loads the clip URL it is given, mirrors it for facing, and
 * reports what the media actually did.  Window movement, grabbing, falling and
 * the brain socket all live in main.cjs.
 *
 * The hidden-video handoff and the pointer/hit flow are this body's own and keep
 * their deciding parts in main.cjs.
 */

(function () {
  'use strict';

  const bridge = window.body;
  const Clips = window.BodyClips;
  if (!bridge || !Clips) {
    console.error('[body] preload or shared scripts missing');
    return;
  }

  const config = bridge.config || {};
  const width = Number(config.width) || 300;
  // the box that answers the hand, as shares of the clip's canvas
  const box = config.hitBox || { left: 0.3, right: 0.7, top: 0.2, bottom: 1 };

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--stage-height', `${(width * 9) / 16}px`);
  rootStyle.setProperty('--bubble-max-height', `${Math.max(60, Number(config.maxBubbleHeight) || 320)}px`);

  let bubble = document.getElementById('bubble');
  bubble.hidden = true;
  const hit = document.getElementById('hit');
  hit.style.left = `${box.left * 100}%`;
  hit.style.width = `${(box.right - box.left) * 100}%`;
  hit.style.top = `${box.top * 100}%`;
  hit.style.height = `${(box.bottom - box.top) * 100}%`;

  // Her talk button: it shows while the pointer is over her, and opens her input window (main.cjs `openTalk`).
  // Only the hit box takes the pointer, so the button lives inside it; its own presses never start a grab.
  const talk = document.getElementById('talk');
  hit.addEventListener('pointerenter', () => hit.classList.add('near'));
  hit.addEventListener('pointerleave', () => hit.classList.remove('near'));
  talk.addEventListener('pointerdown', (event) => event.stopPropagation());
  talk.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    hit.classList.remove('near');
    bridge.openTalk();
  });

  // -------------------------------------------------------------------------
  // clips
  // -------------------------------------------------------------------------

  const videos = [document.getElementById('video-a'), document.getElementById('video-b')];
  for (const video of videos) {
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = false;
  }

  const clips = Clips.createClipState({ facing: 'left' });
  let loadAbort = null;
  let loadTimer = null;

  function reportClip(event) {
    if (!event || event.id === null || event.id === undefined) return;
    bridge.reportClip(event.id, event.state, event.reason);
  }

  function mediaReason(video) {
    const error = video && video.error;
    const code = error && Number(error.code);
    const names = {
      1: 'aborted',
      2: 'network error',
      3: 'decode error',
      4: 'source not supported',
    };
    return `media error ${Number.isFinite(code) ? code : '?'} (${names[code] || 'unknown'})`;
  }

  function prepareVideo(video) {
    if (loadAbort) {
      try {
        loadAbort.abort();
      } catch {
        /* ignore */
      }
      loadAbort = null;
    }
    if (loadTimer) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
    video.pause();
    video.onplaying = null;
    video.onended = null;
    video.onerror = null;
    video.classList.remove('is-front');
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      /* ignore */
    }
  }

  // A travelling clip drives the window from its own time, every frame (task 03): one pass of the clip, still at its
  // start and its end, moving in between.
  let travelGen = -1;
  function startTravel(id, video, generation, endSec) {
    travelGen = generation;
    const step = () => {
      if (travelGen !== generation) return;
      const duration = video.duration;
      const cutoff = Number.isFinite(endSec) && endSec >= 0 && Number.isFinite(duration) && duration > 0
        ? Math.min(endSec, duration)
        : null;
      if (Number.isFinite(duration) && duration > 0) {
        const mediaTime = video.ended ? duration : video.currentTime;
        bridge.travelTime(id, cutoff === null ? mediaTime : Math.min(mediaTime, cutoff), duration);
      }
      if (!video.ended && (cutoff === null || video.currentTime < cutoff)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function startSegmentTravel(id, video, generation, segment, sourceUrl) {
    travelGen = generation;
    let currentVideo = video;
    let nextVideo = videos.find((candidate) => candidate !== video) || null;
    let nextReady = false;
    let elapsed = 0;
    let lastTime = segment.startSec;
    let finished = false;

    const prepareLoopBuffer = (buffer, loadSource = false) => {
      nextReady = false;
      let canPlay = Number(buffer.readyState) >= 3;
      let sought = false;
      const updateReady = () => {
        if (canPlay && sought) nextReady = true;
      };
      buffer.addEventListener('canplay', () => {
        canPlay = true;
        updateReady();
      }, { once: true });
      buffer.addEventListener('seeked', () => {
        sought = Math.abs(buffer.currentTime - segment.startSec) <= 0.08;
        updateReady();
      }, { once: true });
      try {
        if (loadSource) {
          buffer.src = sourceUrl;
          buffer.load();
        }
        buffer.currentTime = segment.startSec;
      } catch (error) {
        fail(error);
      }
    };

    const fail = (error) => {
      if (finished || travelGen !== generation) return;
      finished = true;
      travelGen = -1;
      reportClip(clips.fail(generation, `segment playback failed: ${error && error.message ? error.message : String(error)}`));
    };

    const finish = () => {
      if (finished || travelGen !== generation) return;
      finished = true;
      travelGen = -1;
      bridge.travelTime(id, segment.durationSec, segment.durationSec);
      currentVideo.pause();
      reportClip(clips.markEnded(generation));
    };

    const step = (nativeEnded = false) => {
      if (finished || travelGen !== generation) return;
      const mediaTime = currentVideo.currentTime;
      if (!Number.isFinite(mediaTime)) {
        requestAnimationFrame(() => step());
        return;
      }
      if (mediaTime >= segment.endSec) {
        currentVideo.pause();
        if (mediaTime > segment.endSec) {
          try { currentVideo.currentTime = segment.endSec; } catch { /* media may be replacing the source */ }
        }
      }

      const sample = Math.min(segment.endSec, Math.max(segment.startSec, mediaTime));
      if (sample > lastTime) elapsed += sample - lastTime;
      lastTime = sample;
      bridge.travelTime(id, Math.min(elapsed, segment.durationSec), segment.durationSec);
      if (elapsed >= segment.durationSec) {
        finish();
        return;
      }

      if (nativeEnded || currentVideo.ended || mediaTime >= segment.endSec) {
        if (!nextReady || !nextVideo) {
          // Hold at the segment boundary while the other video seeks/buffers.
          // Leaving this video playing here exposes the source clip's tail
          // (often a stop/fall pose) before the next loop is ready.
          requestAnimationFrame(() => step());
          return;
        }
        const oldVideo = currentVideo;
        currentVideo = nextVideo;
        nextVideo = oldVideo;
        oldVideo.classList.remove('is-front');
        oldVideo.pause();
        currentVideo.classList.add('is-front');
        clips.setFrontSide?.(videos.indexOf(currentVideo));
        const result = currentVideo.play();
        if (result && typeof result.catch === 'function') result.catch(fail);
        nextVideo.classList.remove('is-front');
        prepareLoopBuffer(nextVideo);
        if (finished) return;
        lastTime = segment.startSec;
      }
      requestAnimationFrame(() => step());
    };

    try {
      if (nextVideo && sourceUrl) {
        prepareLoopBuffer(nextVideo, true);
      }
    } catch (error) {
      fail(error);
    }
    return {
      start() { requestAnimationFrame(() => step()); },
      ended() { step(true); },
    };
  }

  function watchEnd(video, generation, endSec) {
    if (!Number.isFinite(endSec) || endSec < 0) return;
    const step = () => {
      const current = clips.current();
      if (!current || current.gen !== generation || current.ended || current.failed) return;
      if (Number.isFinite(video.currentTime) && video.currentTime >= endSec) {
        video.pause();
        try { video.currentTime = endSec; } catch { /* media may be replacing the source */ }
        reportClip(clips.markEnded(generation));
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function applyCommit(commit, video, generation, endSec, segment, hasTravel) {
    travelGen = -1;
    reportClip(commit.replaced);

    videos.forEach((item, index) => {
      if (index === commit.side) {
        item.classList.add('is-front');
      } else {
        item.classList.remove('is-front');
        item.pause();
        item.onplaying = null;
        item.onended = null;
        item.onerror = null;
      }
    });

    // only the incoming clip turns; the outgoing one fades out as it was, or it would flip just before it goes
    video.style.transform = commit.facing === 'right' ? 'scaleX(-1)' : '';
    bridge.facing(commit.facing);

    video.onplaying = () => {
      reportClip(clips.markPlaying(generation));
    };
    const segmentTravel = segment && hasTravel ? startSegmentTravel(commit.id, video, generation, segment, video.src) : null;
    video.onended = () => {
      if (segmentTravel) segmentTravel.ended();
      else reportClip(clips.markEnded(generation));
    };
    video.onerror = () => {
      reportClip(clips.fail(generation, mediaReason(video)));
    };
    if (!segment) watchEnd(video, generation, endSec);
    if (segmentTravel) segmentTravel.start();

    const playResult = video.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch((error) => {
        const reason = `play failed: ${error && error.message ? error.message : String(error)}`;
        reportClip(clips.fail(generation, reason));
      });
    }
    if (hasTravel && !segment) startTravel(commit.id, video, generation, endSec);
  }

  function requestPlay(payload) {
    if (!payload || typeof payload.url !== 'string' || !payload.url) {
      if (payload && payload.id !== null && payload.id !== undefined) {
        bridge.reportClip(payload.id, 'failed', 'no clip URL');
      }
      return;
    }

    const quiet = payload.id === null || payload.id === undefined;
    const request = clips.request({
      id: quiet ? null : payload.id,
      clip: payload.clip,
      loop: !!payload.loop,
      facing: payload.facing === 'left' || payload.facing === 'right' ? payload.facing : null,
      source: quiet ? 'idle' : 'brain',
    });
    for (const event of request.replaced) reportClip(event);

    const video = videos[request.side];
    prepareVideo(video);

    const generation = request.gen;
    const controller = new AbortController();
    loadAbort = controller;
    const timer = setTimeout(() => {
      if (!clips.isPending(generation)) return;
      const event = clips.fail(generation, 'load timed out');
      finish(() => {
        if (event) reportClip(event);
        else console.error('[body] idle clip load timed out');
      });
    }, 10000);
    loadTimer = timer;
    let settled = false;

    function finish(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (loadTimer === timer) loadTimer = null;
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      if (loadAbort === controller) loadAbort = null;
      if (callback) callback();
    }

    function fail(reason) {
      if (!clips.isPending(generation)) {
        finish();
        return;
      }
      const event = clips.fail(generation, reason);
      finish(() => {
        if (event) reportClip(event);
        else if (quiet) console.error('[body] idle clip failed:', reason);
      });
    }

    let segmentSeekStarted = false;
    let segmentSeeked = !payload.segment;
    const commitReady = () => {
      if (settled || !segmentSeeked) return;
      if (!clips.isPending(generation)) {
        finish();
        return;
      }
      const commit = clips.commit(generation);
      if (!commit) {
        finish();
        return;
      }
      finish(() => {
        applyCommit(commit, video, generation, Number(payload.endSec), payload.segment, !!payload.travel && !quiet);
      });
    };

    const onSegmentSeeked = () => {
      if (settled || !payload.segment) return;
      if (Math.abs(video.currentTime - payload.segment.startSec) > 0.08) {
        fail(`segment seek landed at ${video.currentTime}, expected ${payload.segment.startSec}`);
        return;
      }
      segmentSeeked = true;
      commitReady();
    };
    if (payload.segment) {
      video.addEventListener('seeked', onSegmentSeeked, { signal: controller.signal });
    }

    const onReady = () => {
      if (settled) return;
      if (!clips.isPending(generation)) {
        finish();
        return;
      }
      if (payload.segment && !segmentSeekStarted) {
        segmentSeekStarted = true;
        try {
          video.currentTime = payload.segment.startSec;
        } catch (error) {
          fail(`segment seek failed: ${error && error.message ? error.message : String(error)}`);
          return;
        }
        return;
      }
      commitReady();
    };

    video.addEventListener('loadeddata', onReady, { signal: controller.signal });
    video.addEventListener('canplay', onReady, { signal: controller.signal });
    video.addEventListener('error', () => fail(mediaReason(video)), { signal: controller.signal });

    video.loop = payload.segment ? false : !!payload.loop;
    video.src = payload.url;
    video.load();
  }

  bridge.onPlay(requestPlay);

  if (config.idleUrl) {
    requestPlay({
      id: null,
      clip: config.idle,
      loop: true,
      facing: 'left',
      url: config.idleUrl,
    });
  } else {
    const reason = config.idleError || 'BODY_CLIPS is not set';
    console.error('[body] idle clip unavailable:', reason);
    bridge.reportError(`idle clip unavailable: ${reason}`);
  }

  // -------------------------------------------------------------------------
  // speech bubble
  // -------------------------------------------------------------------------

  let sayTimer = null;

  function defaultSayMs(text) {
    return Math.min(12000, 2500 + 150 * Array.from(text).length);
  }

  function resizeBubble(extra) {
    try {
      const result = bridge.resizeBubble(extra);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error('[body] bubble resize failed:', error));
      }
    } catch (error) {
      console.error('[body] bubble resize failed:', error);
    }
  }

  // The bubble sits just above her head, sized to its text, and types the text out. The window is grown once, to the
  // whole text's height, before typing starts, so typing never resizes the window.
  let bubbleText = document.createElement('span');
  bubble.appendChild(bubbleText);
  const TYPE_MS = 1000 / 30;
  const PAUSE_MS = 120;
  const PAUSE_AFTER = new Set(Array.from('，。！？、；：…,.!?;:'));
  let typeTimer = null;
  let fadeTimer = null;
  // how far her head is below the top of the clip's canvas: the bubble may come down that far without the window growing
  const headRoom = ((width * 9) / 16) * box.top;
  // Room for the tallest bubble is reserved once, at load: growing the window per message clipped the top of the
  // text whenever the growth did not arrive before the next paint (user, 10-29 "字上半没有了").
  rootStyle.setProperty('--bubble-bottom', `${((width * 9) / 16) * (1 - box.top) + 6}px`);

  function stopTyping() {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
  }

  function clearBubbleVisual() {
    stopTyping();
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    bubble.classList.remove('is-on', 'is-long');
    bubbleText.textContent = '';
    bubble.scrollTop = 0;
  }

  function hideBubble() {
    sayGeneration += 1;
    if (sayTimer) {
      clearTimeout(sayTimer);
      sayTimer = null;
    }
    stopTyping();
    // fade out, then let the window shrink back
    bubble.classList.remove('is-on');
    const generation = sayGeneration;
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      if (generation !== sayGeneration) return;
      clearBubbleVisual();
      resizeBubble(0);
    }, 160);
  }

  async function showSay(payload) {
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    const generation = ++sayGeneration;
    if (sayTimer) {
      clearTimeout(sayTimer);
      sayTimer = null;
    }
    clearBubbleVisual();
    if (!text) {
      resizeBubble(0);
      return;
    }

    // measure the whole text, unseen, to grow the window once
    bubble.style.visibility = 'hidden';
    bubbleText.textContent = text;
    // offsetHeight: the box's own height, untouched by the scale it fades in from
    const height = bubble.offsetHeight;
    const long = bubble.scrollHeight > bubble.clientHeight + 1;
    bubbleText.textContent = '';
    bubble.style.visibility = '';
    const extra = Math.max(0, Math.ceil(height) + 16 - Math.floor(headRoom));
    try {
      await bridge.resizeBubble(extra);
    } catch (error) {
      console.error('[body] bubble resize failed:', error);
    }
    if (generation !== sayGeneration) return;

    bubble.classList.toggle('is-long', long);
    bubble.classList.add('is-on');
    const chars = Array.from(text);
    let shown = 0;
    const ms = payload && Number.isFinite(payload.ms) ? Math.max(0, payload.ms) : defaultSayMs(text);
    const typeNext = () => {
      typeTimer = null;
      if (generation !== sayGeneration) return;
      shown += 1;
      bubbleText.textContent = chars.slice(0, shown).join('');
      if (long) bubble.scrollTop = bubble.scrollHeight;
      if (shown < chars.length) {
        typeTimer = setTimeout(typeNext, PAUSE_AFTER.has(chars[shown - 1]) ? PAUSE_MS : TYPE_MS);
        return;
      }
      // the time it stays counts from when it is all shown
      sayTimer = setTimeout(() => {
        sayTimer = null;
        if (generation !== sayGeneration) return;
        hideBubble();
      }, ms);
    };
    typeNext();
  }

  // -------------------------------------------------------------------------
  // Speech, input echoes and thinking share one head-centred stack.
  //
  // One surface (`#bubble`) whose content depends on the current item; a queue of speech items; the text
  // types out at 20 characters a second with punctuation costing five; a finished beat of a say is kept as a trail
  // above the bubble (at most two); what the person typed goes in its own line above the trails (at most three).
  // Everything is laid out each frame from her anchor, so nothing is left to drift.
  // -------------------------------------------------------------------------

  const MAX_TRAILS = 2;
  const MAX_LINES = 3;
  const LINE_FADE_MS = 400;
  // A typed line is a short-lived item of its own. A later input replaces the
  // old user line, while model trails remain owned by the reply queue.
  const LINE_STAY_MS = 2600;
  const CHARS_PER_SEC = 20;
  const PAUSE = /[,.!?;:…，。！？；：、]/;
  const LEAD_MS = 450;
  const TRAIL_GAP = 6;
  const LINE_GAP = 8;

  const queue = [];
  let item = null;
  let typing = null;
  let holding = null;
  let resumeTyping = null;
  let activeStep = null;

  const trails = [];
  const lines = [];
  let talkOpen = false;
  let thinkBubble = null;

  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  /** The point everything hangs from: the middle of her head, in page coordinates. */
  function anchor() {
    const stage = document.getElementById('stage');
    const rect = stage.getBoundingClientRect();
    const topOfHead = rect.top + rect.height * (box.top ?? 0.2);
    return { x: rect.left + rect.width / 2, y: topOfHead };
  }

  /** Where the bubble sits: just above her head, centred, inside the window. */
  function bubbleBox() {
    const width = Math.min(bubble.offsetWidth || 0, innerWidth - 16);
    const a = anchor();
    const left = Math.max(8, Math.min(a.x - width / 2, innerWidth - width - 8));
    const top = a.y - (bubble.offsetHeight || 0) - 6;
    return { left, top, width, height: bubble.offsetHeight || 0 };
  }

  // CSS translates each stack item by half its width. Supply its centre here,
  // not its left edge, so input, thinking and reply trails stay on one axis.
  function placeStackItem(el, centre, top) {
    const width = el.offsetWidth;
    const left = Math.max(8, Math.min(centre - width / 2, innerWidth - width - 8));
    el.style.left = `${left + width / 2}px`;
    el.style.top = `${top}px`;
  }

  /** Trails above the bubble, newest nearest to it, each easing to its place. */
  function placeTrails(box, dt) {
    if (!trails.length) return box;
    const k = dt > 0 ? Math.min(1, dt * 12) : 1;
    let bottom = box.top - TRAIL_GAP;
    let top = box.top;
    for (let i = trails.length - 1; i >= 0; i -= 1) {
      const trail = trails[i];
      const el = trail.el;
      if (trail.fadeAt !== null) continue;
      const want = Math.max(8, bottom - el.offsetHeight);
      trail.oy = trail.oy === null ? want : trail.oy + (want - trail.oy) * k;
      placeStackItem(el, box.left + box.width / 2, trail.oy);
      bottom = want - TRAIL_GAP;
      top = want;
    }
    return { left: box.left, top, width: box.width, height: box.height + (box.top - top) };
  }

  /** The person's lines above the trails, newest at the bottom. */
  function placeLines(box, dt) {
    if (!lines.length) return box;
    const k = dt > 0 ? Math.min(1, dt * 12) : 1;
    let bottom = box.top - LINE_GAP;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.fadeAt !== null) continue;
      const el = line.el;
      el.classList.toggle('older', i !== lines.length - 1);
      const want = Math.max(8, bottom - el.offsetHeight);
      line.oy = line.oy === null ? want : line.oy + (want - line.oy) * k;
      placeStackItem(el, anchor().x, line.oy);
      bottom = want - LINE_GAP;
    }
    return box;
  }

  /** Every frame: the bubble, then the trails, then the person's lines, and the window grown to hold them. */
  let optionRectsKey = '';
  function syncOptionRects() {
    const rects = [...document.querySelectorAll('.ask-option')]
      .filter((el) => !el.disabled && el.offsetWidth > 0 && el.offsetHeight > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
    const key = JSON.stringify(rects.map((r) => [
      Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom),
    ]));
    if (key === optionRectsKey) return;
    optionRectsKey = key;
    bridge.setOptionRects?.(rects);
  }

  function layout(dt) {
    syncOptionRects();
    const liveLines = lines.filter((line) => line.fadeAt === null);
    if (bubble.hidden && !liveLines.length) return;
    const box = bubble.hidden ? { left: anchor().x, top: anchor().y, width: 0, height: 0 } : bubbleBox();
    const withTrails = placeTrails(box, dt);
    placeLines(withTrails, dt);
    // grow the window by what the stack needs ABOVE her head: the bubble plus trails plus lines, minus the room the
    // page already has above her (`,the stage's top`), which is what keeps everything inside the window.
    const stagePx = (Number(config.width) || 300) * 9 / 16;
    // the share of the clip above her head (config.hitBox.top), never the bubble's pixel top
    const headRoom = stagePx * (Number(config.hitBox && config.hitBox.top) || 0.2);
    const stack = (bubble.hidden ? 0 : bubble.offsetHeight)
      + trails.filter((x) => x.fadeAt === null).reduce((n, x) => n + x.el.offsetHeight + TRAIL_GAP, 0)
      + lines.filter((x) => x.fadeAt === null).reduce((n, x) => n + x.el.offsetHeight + LINE_GAP, 0);
    // a bubble never needs more than a screenful: cap it so a bad measurement cannot stretch the window
    const needed = Math.max(0, Math.min(400, Math.ceil(stack + 8 - headRoom)));
    if (needed !== currentExtra) {
      currentExtra = needed;
      resizeBubble(needed);
    }
  }

  let currentExtra = -1;

  function openBubble(kind, html) {
    const next = make('div', `bubble ${kind}`);
    next.innerHTML = html;
    bubbleText = document.createElement('span');
    next.appendChild(bubbleText);
    document.body.appendChild(next);
    bubble = next;
    bubble.hidden = talkOpen;
    bubble.classList.add('is-on');
  }

  // A bubble fades before it goes: hiding it in the same frame reads as a glitch (user, 10-29). The window keeps its
  // height until the trails have faded too, then shrinks back.
  let closeTimer = null;
  let shrinkTimer = null;
  function closeBubble() {
    item = null;
    const closing = bubble;
    closing.classList.remove('is-on');
    fadeTrails();
    setTimeout(() => closing.remove(), 170);
    if (shrinkTimer) clearTimeout(shrinkTimer);
    shrinkTimer = setTimeout(() => {
      shrinkTimer = null;
      resizeBubble(0);
      currentExtra = 0;
    }, LINE_FADE_MS + 120);
  }

  function reportBeat(it, beat, state) {
    if (!beat?.outputId) return;
    const prior = it.partStates.get(beat.outputId);
    if (['completed', 'interrupted'].includes(prior) || prior === state) return;
    it.partStates.set(beat.outputId, state);
    bridge.reportSpeech?.(it.commandId, beat.outputId, state);
  }

  function reportReplyState(state) {
    for (const speech of [...(item ? [item] : []), ...queue]) {
      if (speech.kind !== 'say') continue;
      for (const beat of speech.beats || []) reportBeat(speech, beat, state);
    }
  }

  function pauseSayQueue() {
    if (typing) { clearTimeout(typing); typing = null; }
    if (item && activeStep) resumeTyping = activeStep;
    reportReplyState('paused');
    if (item && holding) {
      clearTimeout(holding);
      holding = null;
      item.holdRemaining = Math.max(0, item.holdUntil - Date.now());
    }
  }

  function resumeSayQueue() {
    reportReplyState('resumed');
    if (resumeTyping) { const resume = resumeTyping; resumeTyping = null; resume(); return; }
    if (item && item.holdRemaining !== undefined) {
      const it = item;
      const delay = it.holdRemaining;
      delete it.holdRemaining;
      it.holdUntil = Date.now() + delay;
      holding = setTimeout(() => {
        holding = null;
        if (it.kind === 'user') { it.state = 'ended'; bubble.dataset.itemState = it.state; closeBubble(); pump(); }
        else { reportBeat(it, it.beats[it.i], 'completed'); nextBeat(); }
      }, delay);
      return;
    }
    if (item) { nextBeat(); return; }
    pump();
  }

  function fadeTrails() {
    for (const trail of [...trails]) fadeTrail(trail);
  }

  function fadeTrail(trail) {
    if (!trail || trail.fadeAt !== null) return;
    trail.fadeAt = Date.now();
    trail.el.classList.add('is-fading');
    setTimeout(() => { trail.el.remove(); trails.splice(trails.indexOf(trail), 1); }, LINE_FADE_MS);
  }

  function fadeLine(line) {
    if (!line || line.fadeAt !== null) return;
    line.fadeAt = Date.now();
    line.el.classList.add('is-fading');
    setTimeout(() => { line.el.remove(); lines.splice(lines.indexOf(line), 1); }, LINE_FADE_MS);
  }

  function keepAsTrail(el) {
    el.classList.remove('bubble', 'say', 'is-on');
    el.classList.add('bubble-trail');
    el.style.bottom = 'auto';
    trails.push({ el, fadeAt: null, oy: null });
    while (trails.filter((t) => t.fadeAt === null).length > MAX_TRAILS) fadeTrail(trails.find((t) => t.fadeAt === null));
  }

  let nextLineId = 1;
  function addLine(text, payload) {
    const el = make('div', 'bubble-line', text);
    el.dataset.itemId = String(payload?.id ?? `user:${nextLineId++}`);
    el.dataset.itemState = 'displayed';
    document.body.appendChild(el);
    const line = { el, fadeAt: null, oy: null };
    lines.push(line);
    while (lines.filter((entry) => entry.fadeAt === null).length > MAX_LINES) fadeLine(lines.find((entry) => entry.fadeAt === null));
    setTimeout(() => fadeLine(line), LINE_STAY_MS);
  }

  function startUserLine(entry) {
    addLine(entry.text, { id: entry.id });
  }

  /** One say: its beats one after another, each typed out, each previous one kept as a trail. */
  function startSay(it) {
    item = it;
    it.i = -1;
    openBubble('say', '');
    bubble.dataset.itemId = String(it.replyId || it.commandId);
    bubble.dataset.itemState = 'displayed';
    nextBeat();
  }

  function showQuestionOptions(it) {
    const question = it.question;
    if (!question || !Array.isArray(question.options) || !question.options.length || bubble.querySelector('.ask-options')) return;
    const box = make('div', 'ask-options');
    for (const option of question.options) {
      const button = make('button', 'ask-option', option);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (box.dataset.answered) return;
        box.dataset.answered = '1';
        for (const child of box.querySelectorAll('button')) child.disabled = true;
        bridge.answer?.({ questionId: question.id, question: question.question, text: option, ...(question.requestId ? { requestId: question.requestId } : {}) });
        setTimeout(() => { if (item === it) closeBubble(); }, 180);
      });
      box.append(button);
    }
    bubble.append(box);
    bubble.classList.add('ask-bubble');
  }

  function nextBeat() {
    const it = item;
    if (!it || it.kind !== 'say') return;
    if (talkOpen) return;
    it.i += 1;
    const beat = it.beats[it.i];
    if (!beat) {
      if (it.legacyReceiptId !== undefined) bridge.reportSpeech?.(it.legacyReceiptId, undefined, 'completed');
      closeBubble(); pump(); return;
    }
    if (it.i > 0) {
      keepAsTrail(bubble);
      openBubble('say', '');
    }
    bubble.dataset.itemId = String(beat.outputId || it.replyId || it.commandId);
    bubble.dataset.itemState = 'displayed';
    if (beat.actions && beat.actions.length) {
      const run = () => bridge.acts(beat.actions);
      if (it.i === 0) run(); else setTimeout(run, LEAD_MS);
    }
    bubbleText.textContent = '';
    if (!beat.text) { nextBeat(); return; }
    typeBeat(beat, () => {
      const length = Array.from(beat.text).length;
      const last = it.i === it.beats.length - 1;
      const holdMs = Number.isFinite(beat.hold) ? Math.max(0, beat.hold) : (last ? Math.max(1.6 + length * 0.07, it.hold || 0) : 0.9 + length * 0.03) * 1000;
      if (last && it.question) { showQuestionOptions(it); return; }
      it.holdUntil = Date.now() + holdMs;
      holding = setTimeout(() => { holding = null; delete it.holdUntil; bubble.dataset.itemState = 'ended'; reportBeat(it, beat, 'completed'); nextBeat(); }, holdMs);
    });
  }

  function typeBeat(beat, done) {
    const speech = item;
    const chars = Array.from(beat.text);
    let shown = 0;
    let acc = 0;
    let fired = 0;
    const anchors = beat.anchors || [];
    const interval = 1000 / CHARS_PER_SEC;
    const schedule = () => { typing = setTimeout(step, interval); };
    const step = () => {
      if (talkOpen) { typing = null; resumeTyping = schedule; return; }
      acc += 1;
      while (acc >= 1 && shown < chars.length) {
        shown += 1;
        acc -= PAUSE.test(chars[shown - 1]) ? 5 : 1;
        bubbleText.textContent = chars.slice(0, shown).join('');
        if (speech?.waitForDisplay) {
          speech.waitForDisplay = false;
          waitingForSay = false;
          hideThinkingBubble();
          syncThinking();
        }
        while (fired < anchors.length && anchors[fired].at <= shown) {
          bridge.acts(anchors[fired].actions);
          fired += 1;
        }
      }
      if (shown >= chars.length) { typing = null; activeStep = null; done(); return; }
      schedule();
    };
    activeStep = step;
    step();
  }

  function pump() {
    if (item) return;
    const next = queue.shift();
    if (!next) return;
    if (next.kind === 'say') startSay(next);
    else if (next.kind === 'user') startUserLine(next);
  }

  bridge.onSay((payload) => {
    const beats = payload?.beats?.length ? payload.beats : (payload?.text ? [{ text: payload.text }] : []);
    if (!beats.length) return;
    // A real reply ends this turn's waiting indicator immediately. Later model
    // rounds in the same turn must not bring it back while the reply is visible.
    replyPresented = true;
    hostThinking = false;
    waitingForSay = false;
    setOptimisticThinking(false);
    syncThinking();
    const commandId = payload.id;
    const supplied = payload.beats?.length ? payload.beats : beats;
    const reply = { kind: 'say', replyId: payload.replyId, commandId, beats: supplied,
      hold: Number(payload.hold) || 0, waitForDisplay: true, partStates: new Map(),
      ...(payload.question && typeof payload.question.id === 'string' ? { question: payload.question } : {}),
      ...(payload.beats?.some((beat) => beat.outputId) ? {} : { legacyReceiptId: commandId }) };
    queue.push(reply);
    if (talkOpen) reportReplyState('paused');
    if (!item && !talkOpen) pump();
  });

  bridge.onTalkState((payload) => {
    talkOpen = Boolean(payload && payload.open);
    if (talkOpen) {
      pauseSayQueue();
      bubble.hidden = true;
      return;
    }
    if (item || thinking) bubble.hidden = false;
    resumeSayQueue();
  });

  // A live thinking mark only while the model is working: it pulses from one
  // to three dots, then disappears when the answer lands or the turn fails.
  let thinking = false;
  let optimisticThinking = false;
  let hostThinking = false;
  let waitingForSay = false;
  // A later processing projection can belong to the same turn after a visible
  // reply. Keep it from recreating a stale thinking bubble until the next user line.
  let replyPresented = false;
  let thinkTimer = null;
  let thinkPhase = 0;
  function pulseThinking() {
    const mark = thinkBubble?.el.querySelector('.b-think');
    if (!mark) return;
    mark.textContent = '·'.repeat((thinkPhase++ % 3) + 1);
  }
  function stopThinkingPulse() {
    if (thinkTimer) clearInterval(thinkTimer);
    thinkTimer = null;
  }
  function showThinking() {
    if (thinkBubble || item) return;
    const mark = make('p', 'b-think', '');
    mark.setAttribute('aria-label', '正在思考');
    const el = make('div', 'bubble think bubble-thinking is-on');
    el.dataset.itemId = `think:${Date.now()}`;
    el.append(mark);
    document.body.appendChild(el);
    const line = { el, fadeAt: null, oy: null };
    lines.push(line);
    thinkBubble = { el, line };
    pulseThinking();
    stopThinkingPulse();
    thinkTimer = setInterval(pulseThinking, 360);
  }
  function hideThinkingBubble() {
    if (!thinkBubble) return;
    thinkBubble.el.remove();
    lines.splice(lines.indexOf(thinkBubble.line), 1);
    thinkBubble = null;
    stopThinkingPulse();
  }
  function setThinking(on) {
    if (on === thinking) {
      if (on) showThinking();
      return;
    }
    thinking = on;
    if (on) {
      showThinking();
    } else if (thinkBubble) {
      hideThinkingBubble();
    } else {
      stopThinkingPulse();
    }
  }
  function syncThinking() { setThinking(optimisticThinking || hostThinking || waitingForSay); }
  function setOptimisticThinking(on) { optimisticThinking = on; syncThinking(); }
  bridge.onThink((payload) => {
    const on = Boolean(payload && payload.on);
    hostThinking = on && !replyPresented;
    if (!on) replyPresented = false;
    if (!hostThinking) optimisticThinking = false;
    syncThinking();
  });
  window.__lingxiThink = setThinking;
  bridge.onSaid((payload) => {
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    if (text) { replyPresented = false; addLine(text, payload); }
  });

  // one frame loop for the whole stack
  let lastFrame = 0;
  function frame(now) {
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    try { layout(dt); } catch (error) { console.error('[body] layout failed:', error && error.message); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // -------------------------------------------------------------------------
  // hand: click / pickup / drop
  // -------------------------------------------------------------------------

  const DRAG_THRESHOLD = 5;
  const PET_HOLD_MS = 450;
  let pressed = false;
  let dragging = false;
  let petReady = false;
  let petting = false;
  let petTimer = null;
  let touchId = null;
  let touchStartedAt = 0;
  let touchPosition = null;
  let pressScreen = null;
  let capturedPointerId = null;
  let trail = [];
  // Keep the last moments of the pointer path; the movement maths (the pack's) turns it into a release speed.
  const trimTrail = (list, now, keepMs) => {
    const cutoff = now - keepMs;
    let i = 0;
    while (i < list.length && list[i].t < cutoff) i++;
    return i ? list.slice(i) : list;
  };
  let interactive = null;

  function newTouchId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (kind) => {
      const value = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
      return (kind === 'x' ? value : (value & 3) | 8).toString(16);
    });
  }

  function relativeTouch(event) {
    const rect = hit.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / (rect.height || 1))),
    };
  }

  function clearPetHold() {
    if (petTimer !== null) clearTimeout(petTimer);
    petTimer = null;
    hit.style.cursor = '';
  }

  function setInteractive(on) {
    const next = !!on;
    if (next === interactive) return;
    interactive = next;
    bridge.setInteractive(next);
  }

  function hitContains(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    const rect = hit.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    );
  }

  function eventTime(event) {
    const now = performance.now();
    const stamp = Number(event && event.timeStamp);
    // Some synthetic events use epoch milliseconds; keep the trail on
    // performance.now()'s clock when the stamp is not plausibly high-res.
    return Number.isFinite(stamp) && Math.abs(now - stamp) < 60000 ? stamp : now;
  }

  function addSample(event) {
    if (!event) return;
    const x = Number(event.screenX);
    const y = Number(event.screenY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    trail.push({ t: eventTime(event), x, y });
    trail = trimTrail(trail, performance.now(), 400);
  }

  function addCoalesced(event) {
    let events = [event];
    if (event && typeof event.getCoalescedEvents === 'function') {
      try {
        const list = event.getCoalescedEvents();
        if (list && list.length) events = list;
      } catch {
        /* fall back to the event itself */
      }
    }
    for (const item of events) addSample(item);
  }

  function onMouseMove(event) {
    if (dragging) {
      setInteractive(true);
      return;
    }
    if (pressed) {
      setInteractive(true);
      return;
    }
    // the 说 button sits above her head, outside the hit box: without its own rect the window kept ignoring the mouse
    // there, so the button could not be pressed (user, 10-29)
    // While her input is open the whole window stays interactive: the box is above her head, outside the hit box, and
    // turning click-through back on made the textarea unclickable (user, 10-29).
    const talkRect = talk.getBoundingClientRect();
    const overTalk =
      !talk.disabled &&
      event.clientX >= talkRect.left && event.clientX < talkRect.right &&
      event.clientY >= talkRect.top && event.clientY < talkRect.bottom;
    setInteractive(hitContains(event.clientX, event.clientY) || overTalk);
  }

  function onPointerDown(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (!hitContains(event.clientX, event.clientY)) return;
    pressed = true;
    dragging = false;
    petReady = false;
    petting = false;
    touchId = newTouchId();
    touchStartedAt = Date.now();
    touchPosition = relativeTouch(event);
    clearPetHold();
    // Movement before this deliberate hold is pickup; movement after it is stroking in place.
    petTimer = setTimeout(() => {
      petTimer = null;
      if (!pressed || dragging) return;
      petReady = true;
      hit.style.cursor = 'ew-resize';
    }, PET_HOLD_MS);
    pressScreen = { x: event.screenX, y: event.screenY };
    trail = [];
    addSample(event);
    bridge.pressed(true);
    capturedPointerId = event.pointerId;
    try {
      hit.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best effort */
    }
    setInteractive(true);
  }

  function onPointerMove(event) {
    if (!pressed) return;
    if (event.buttons === 0) {
      // The release was lost (window moved away, capture dropped); settle now.
      finishPress(event, true);
      return;
    }
    addCoalesced(event);
    if (petReady) {
      if (hitContains(event.clientX, event.clientY)) {
        touchPosition = relativeTouch(event);
        if (!petting && pressScreen && Math.hypot(event.screenX - pressScreen.x, event.screenY - pressScreen.y) > DRAG_THRESHOLD) {
          petting = true;
          bridge.pet({ interactionId: touchId, phase: 'started', position: touchPosition, at: Date.now() });
        }
      }
      return;
    }
    if (!dragging && pressScreen) {
      const dx = Number(event.screenX) - pressScreen.x;
      const dy = Number(event.screenY) - pressScreen.y;
      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        dragging = true;
        clearPetHold();
        hit.classList.add('dragging');
        bridge.grab({
          at: Date.now(),
          pressX: pressScreen.x,
          pressY: pressScreen.y,
          position: touchPosition,
        });
      }
    }
    if (dragging) setInteractive(true);
  }

  function finishPress(event, cancelled) {
    if (!pressed && !dragging) return;
    const wasDragging = dragging;
    const wasPetting = petting;
    clearPetHold();
    pressed = false;
    dragging = false;
    petReady = false;
    petting = false;
    hit.classList.remove('dragging');
    bridge.pressed(false);
    if (capturedPointerId !== null) {
      try {
        hit.releasePointerCapture(capturedPointerId);
      } catch {
        /* ignore */
      }
      capturedPointerId = null;
    }

    if (event) addSample(event);
    if (wasPetting) {
      bridge.pet({ interactionId: touchId, phase: cancelled ? 'cancelled' : 'completed', position: touchPosition, at: Date.now() });
    } else if (wasDragging) {
      bridge.drop({ trail: trail.slice(-200), now: performance.now() });
    } else if (!cancelled) {
      bridge.click({ interactionId: touchId, startedAt: touchStartedAt, position: touchPosition });
    }
    trail = [];

    if (event && Number.isFinite(event.clientX)) {
      // the 说 button sits above her head, outside the hit box: without its own rect the window kept ignoring the mouse
    // there, so the button could not be pressed (user, 10-29)
    // While her input is open the whole window stays interactive: the box is above her head, outside the hit box, and
    // turning click-through back on made the textarea unclickable (user, 10-29).
    const talkRect = talk.getBoundingClientRect();
    const overTalk =
      !talk.disabled &&
      event.clientX >= talkRect.left && event.clientX < talkRect.right &&
      event.clientY >= talkRect.top && event.clientY < talkRect.bottom;
    setInteractive(hitContains(event.clientX, event.clientY) || overTalk);
    } else {
      setInteractive(false);
    }
  }

  hit.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', (event) => finishPress(event, false));
  window.addEventListener('pointercancel', (event) => finishPress(event, true));
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseleave', () => {
    if (!pressed && !dragging) setInteractive(false);
  });
  window.addEventListener('blur', () => {
    if (pressed || dragging) finishPress(null, true);
    else setInteractive(false);
  });
  hit.addEventListener('lostpointercapture', () => {
    if (pressed || dragging) finishPress(null, true);
  });
  window.addEventListener('dragstart', (event) => event.preventDefault());
  window.addEventListener('contextmenu', (event) => event.preventDefault());
})();
