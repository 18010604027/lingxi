# 灵犀身体

A small Electron window that carries out a brain's decisions. It plays one of the
transparent VP9 clips in `BODY_CLIPS`, moves its window, shows a speech bubble,
and lets the user pick the character up and throw it. It never chooses a clip or
a destination itself.

The brain is a separate Node process. They talk over a WebSocket: the body is
the client, the brain is the server. `try-brain.mjs` is a stand-in brain for
trying things by hand.

## Requirements

- Electron, supplied by whatever runs the body (`electron main.cjs`).
- Node 22+ for the body's built-in global `WebSocket` client. Electron embeds
  its own Node; if that build has no global `WebSocket`, the body logs
  `global WebSocket is missing ...` and cannot connect. There is deliberately no
  `ws` dependency and no hand-written client fallback.
- A directory of `.webm` clips, passed as an absolute path in `BODY_CLIPS`.

## Run

Start the stand-in brain first:

```sh
node try-brain.mjs
```

It prints a random `BODY_WS`, for example:

```text
BODY_WS=ws://127.0.0.1:54321/body?token=6f...
run: BODY_CLIPS=<absolute clips dir> BODY_WS='ws://127.0.0.1:54321/body?token=6f...' electron main.cjs
```

Then start the body in another terminal (POSIX shell):

```sh
BODY_CLIPS=/absolute/path/to/clips \
BODY_MOTION=/absolute/path/to/pack/motion.cjs \
BODY_WS='ws://127.0.0.1:54321/body?token=6f...' \
electron main.cjs
```

PowerShell equivalent:

```powershell
$env:BODY_CLIPS = 'C:\absolute\path\to\clips'
$env:BODY_MOTION = 'C:\absolute\path\to\pack\motion.cjs'
$env:BODY_WS = 'ws://127.0.0.1:54321/body?token=6f...'
electron main.cjs
```

`try-brain.mjs` reads these stdin commands and prints every message from the
body:

```text
play <clip> [loop] [right|left]
move <x> [line|spring|instant] [ms]
say <text>
stop
help
quit
```

`move` defaults to `line`; if `ms` is omitted the body uses 1000 ms. `say` with
no text clears the bubble.

Run the headless tests with:

```sh
npm test
# or
node --test
```

## 应用入口

日常运行从仓库根执行 `pnpm start`，由应用统一启动身体、工作台和托盘。身体需要使用者自己的形象包、片段和 `motion.cjs`；格式见 [形象包说明](../packs/README.md)。正常退出使用托盘菜单。

下文的独立协议示例用于开发，不是另一套产品入口。

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BODY_CLIPS` | unset | Absolute path to the clip directory. Required for idle/play. |
| `BODY_WS` | unset | WebSocket URL of the brain, e.g. `ws://127.0.0.1:47811/body?token=...`. |
| `BODY_WIDTH` | `300` | Width of the clip's 16:9 box in DIP/CSS pixels. |
| `BODY_HIT` | `0.4` | Width of the hit box as a share of the box. Height is fixed at `0.8`, bottom-aligned. |
| `BODY_IDLE` | `待机呼吸休闲.webm` | Clip looped before any command arrives. |

The initial window is centred horizontally on the primary display and stands on
the bottom of that display's work area. After that its x is wherever a `move`
or a drag leaves it; it is not persisted across restarts.

## Window and interaction
- Frameless, transparent, always on top at Electron's `screen-saver` level
  (above the taskbar), skipped from the taskbar, no native shadow.
- Shown with `showInactive()`; it can take focus when clicked, but does not steal
  it at startup.
- The page is the clip's 16:9 box. The speech bubble is placed above it; when a
  bubble needs room the main process grows the window **upward** while keeping
  its bottom edge fixed, so the character does not move on screen.
- Clicks pass through everywhere except the hit box:
  `setIgnoreMouseEvents(true)` is the default and the window
  becomes interactive only while the pointer is inside the middle
  `BODY_HIT`-wide, bottom-aligned 80%-high box. The main process polls the real
  cursor at 60 ms, including option hit regions. Mouse forwarding stays off
  because it installs a global low-level mouse hook on Windows. A stationary
  pointer still works when a `move` slides the character under it.
- The character is 640×360 in the clips. `facing: 'right'` applies
  `scaleX(-1)`; `'left'` shows the clip as authored. Omitting `facing` keeps the
  last committed facing.

## Talking to her

While the pointer is over her, a small **说** button shows at the top of her hit box (the only area that takes the
pointer; everything else is click-through). Pressing it opens `talk.html`, a frameless one-line window just above her:
Enter or 发送 sends the line to the brain as `{t:'typed', text}`, Esc or a click outside closes it. The body decides
nothing here — it carries the words, the brain hands them to the front exactly as the DSH page's box does.

If the body disconnects while a clip-backed behavior command is waiting, the pending command now settles as
`unknown` instead of holding the behavior queue open. The front is told that completion could not be confirmed.
Queued actions are not replayed on reconnect; the next `hello` only restores idle behavior. A hand interrupt remains
an `interrupted` result and is reported separately.

## Playing clips

Two muted `<video>` elements are used. A play request loads the hidden element;
when it can play (or is already decoded) it becomes visible and the other one is
hidden and paused. Every request increments a generation number, so a slow load
that finishes after a newer request is ignored. The page reports `playing` only
from the video's `playing` event.

- `loop: true` loops until the next command.
- Non-looping clips report `ended` and hold their last frame.
- Missing files and media errors report `failed` with a reason. Missing files
  are detected in the main process before the page is asked to load them.
- A clip that is replaced while still loading reports `replaced` immediately;
  the clip that is actually playing reports `replaced` when a newer clip
  commits (unless it already reported `ended` or `failed`, in which case it was
  not cut short). A failed load of the newer clip leaves the old one playing.

## Moving

`move` interprets `x` as the window **centre** relative to the work-area width
of the display the body is on: `0` is the left edge, `1` the right edge. The
target is clamped so the whole window stays on screen. `y` is not changed by a
move.

A main-process 60 Hz timer drives all movement:

- `instant`: put the window there immediately.
- `line`: constant speed over `ms` (default 1000).
- `spring`: a damped spring (stiffness `K=200`, damping `C=30`) integrated by the
  same 60 Hz timer.

A new `move` replaces one under way; the replaced move reports
`{t:'move', id, state:'interrupted', x}`. A grab also interrupts a move.

## Picking up, throwing and falling

- Press on the hit box; moving more than 6 px turns it into a pickup. The body
  reports `grab`, interrupts any move, and follows the pointer from the main
  process at 60 Hz so the original press point stays under the pointer.
- Releasing reports `drop` with the release position and the pointer velocity
  estimated from the last 150 ms (endpoint direction, peak weighting,
  acceleration gain, soft speed clamp). Then the body falls.
- The fall starts from rest vertically and uses gravity `1400 px/s²`, ground
  restitution `0.3`, ground friction `2.5 /s`, and the body's rest thresholds.
  It bounces until it settles and reports `landed` with the final x. The drop
  start is clamped into the work area first, so a release partly off-screen
  falls from the nearest fully visible rectangle.
- A release faster than 500 px/s is a throw: the horizontal component carries
  on, is slowed while on the ground, and bounces off the work-area sides with the
  same 0.3 restitution. The reported `vy` is informational; the body always
  starts the fall from rest so the character falls "straight down".
- A press and release without crossing the 6 px threshold reports `click`.
- Pressing and moving more than 6 px while the body is falling cancels the fall
  (no `landed`) and starts a new grab/drop cycle. This is the one way to catch a
  thrown pet; it is otherwise subject to the same pickup threshold.
- While held or falling, `move`, `say` and `stop` are not executed: each gets
  `{t:'busy', for:<command t>, id}` and is dropped. `play` is allowed **while
  held** because the hand section lets the brain choose a held clip after
  receiving `grab`; `play` while falling is busy. The body never chooses a held
  clip itself.

## Protocol

All messages are JSON objects with a `t` field. `x` is always the window centre
as a share of the current work-area width (so it can be slightly below 0 or
above 1 during a drag, and is normally inside `[0,1]` for moves/landings). The
display rectangle in `hello` is the display's **work area**.

### Brain → body

| Message | Fields | Notes |
| --- | --- | --- |
| `play` | `id`, `clip`, `loop?`, `facing?`, `endSec?`, `segment?`, `travel?` | `clip` is a bare file name in `BODY_CLIPS`; path separators are rejected. `facing` is `left`/`right`. Optional `endSec` stops at that media time and reports the normal `ended` clip state. `segment` and `endSec` are mutually exclusive. A segment `{startSec,endSec,durationSec}` seeks to its start, loops only that native-speed range until the accumulated media time reaches `durationSec`, then reports the normal `ended` state once. It requires `travel` with zero `leadSec` and `tailSec`. |
| `move` | `id`, `x`, `mode`, `ms?` | `mode` is `instant`/`line`/`spring`; `x` is the target centre share. |
| `say` | `text`, `ms?` | Empty `text` clears the bubble. Default duration is `min(12s, 2.5s + 0.15s per character)`. |
| `stop` | `id?` | Stops the move under way and reports it interrupted. With an `id`, only a move with exactly that id is stopped. Clips are untouched. |

Anything that is not one of these shapes (bad JSON, missing fields, unknown
`t`, a path in `clip`, a non-boolean `loop`, etc.) produces
`{t:'error', message}` and is otherwise ignored.

### Body → brain

| Message | Fields | When |
| --- | --- | --- |
| `hello` | `display:{x,y,width,height,scale}`, `x`, `facing` | Once per connection. `display` is the work area and scale factor of the display under the body. |
| `clip` | `id`, `state`, `reason?` | `playing` at the media's `playing` event; `ended` for a non-looping clip; `replaced` for a superseded load/playing clip; `failed` with a reason. |
| `move` | `id`, `state`, `x` | `arrived` or `interrupted`. |
| `grab` | `x`, `at` | Pickup threshold crossed. `at` is milliseconds since the Unix epoch (`Date.now()`). |
| `drop` | `x`, `vx`, `vy` | Release position and pointer velocity in px/s. |
| `landed` | `x` | Fall settled; final centre share. |
| `typed` | `text` | The person typed a line into her input window (below). The brain hands it to the front as if it came from the DSH page. |
| `click` | `x` | Press and release inside the hit box without a pickup. |
| `busy` | `for`, `id` | A command was dropped because the body is held/falling. `id` is `null` when the command had none (e.g. `say`/`stop`). |
| `pose` | `x`, `facing` | Once a second while the socket is connected, including while held or falling. |
| `error` | `message` | An incoming message could not be read. |

The body reconnects to `BODY_WS` every 2 seconds while it cannot connect. It
keeps playing/moving locally while disconnected; `hello` is re-sent on each
connection.

### Clip failures

- Missing file / unset or non-absolute `BODY_CLIPS`: the main process reports
  `failed` without involving the page (`reason` starts with `missing file:` or
  names the environment problem).
- Cannot decode / play / load timeout: the page reports `failed` with a
  `media error N (...)` or `play failed: ...` / `load timed out` reason.

## Files

- `main.cjs` — Electron main process: window, hit/click-through, move ticker,
  drag follow, fall physics, bubble resize, WebSocket client.
- `preload.cjs` — narrow `contextBridge` surface (no `ipcRenderer` in the page).
- `body.html`, `body.css`, `body.js` — two videos, hit box, bubble, hand input.
- `protocol.cjs` — message shapes/checks, no Electron; tested by Node.
- `motion-loader.cjs` — loads the figure pack's `motion.cjs` (line, spring, fall and release-velocity maths);
  without one the body stops and says what the pack is missing.
- `geometry.cjs` — work-area/window coordinate helpers handed to the pack's maths.
- `clips.cjs` — two-video generation/commit state; UMD, also tested by Node.
- `try-brain.mjs` — stand-in brain with a dependency-free RFC 6455 server
  (masked client text frames, fragmentation, ping/pong, close).
- `test/*.test.cjs` — protocol, geometry, motion loading, clip switching, try-brain
  frame/server tests.

## What it does not do

- It does not decide anything. It never picks a clip, changes its own x, or
  chooses when to talk. With no command it only loops `BODY_IDLE` at startup.
- It does not scan or list `BODY_CLIPS`; the brain must name a file.
- It has no audio (videos are muted) and no clip transitions other than the
  hidden-video handoff.
- It does not persist position or state across restarts.
- `move` stays within the display selected at command time; it does not cross
  monitors. Dragging can cross displays, and the drop/fall uses the display
  under the character at release.
- It does not linearise for Windows DPI; everything is in
  Electron DIP/CSS pixels.
- Speech bubbles are plain text (newlines preserved). Very long text is capped
  by the available work-area height and scrolls inside the bubble.
- If the Electron/Node build has no global `WebSocket`, it cannot talk to the
  brain and says so on stderr; it does not bundle a client.
- It does not recover a lost pointer-up if the OS never delivers one and the
  window never blurs; `pointercancel`, `lostpointercapture`, `buttons === 0`
  moves and window blur are all treated as release.
