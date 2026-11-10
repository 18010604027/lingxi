/**
 * The brain's end of the link to the body (body/README.md has the protocol). The body connects as a WebSocket client
 * with a token; this end sends it commands and keeps what it last said about itself: where it is, which way it faces,
 * the work area it stands on. Every message from it is also given out as an event, for the behaviour system.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';

export interface TouchPosition { x: number; y: number }

export type BodyMessage =
  | { t: 'hello'; display: { x: number; y: number; width: number; height: number; scale: number }; x: number; facing: 'left' | 'right' }
  | { t: 'clip'; id: number; state: 'playing' | 'ended' | 'replaced' | 'failed'; reason?: string }
  | { t: 'move'; id: number; state: 'arrived' | 'interrupted'; x: number }
  | { t: 'grab'; x: number; at: number; interactionId?: string; position?: TouchPosition }
  | { t: 'drop'; x: number; vx: number; vy: number; interactionId?: string; at?: number }
  | { t: 'drag-move'; interactionId: string; at: number; x: number; y: number }
  | { t: 'landed'; x: number; interactionId?: string; at?: number }
  | { t: 'click'; x: number; interactionId?: string; at?: number; startedAt?: number; position?: TouchPosition }
  | { t: 'pet'; x: number; interactionId: string; at: number; phase: 'started' | 'completed' | 'cancelled'; position?: TouchPosition }
  // where the pointer is on screen, so cursor can mean the pointer (T1 gap: the body did not report it)
  | { t: 'pointer'; x: number; y: number }
  | { t: 'busy'; for: string; id: number }
  | { t: 'pose'; x: number; facing: 'left' | 'right' }
  /** The person typed a line into her input window on the desktop (body/main.cjs `body:talk-send`). */
  | { t: 'typed'; text: string }
  | { t: 'answer'; questionId: string; question: string; text: string; requestId?: string }
  | { t: 'act'; actions: unknown[] }
  | { t: 'speech'; id: number; outputId?: string; state: 'paused' | 'resumed' | 'completed' | 'interrupted' }
  | { t: 'error'; message: string };

export type BodyCommand =
  | { t: 'play'; clip: string; loop?: boolean; facing?: 'left' | 'right'; endSec?: number; segment?: { startSec: number; endSec: number; durationSec: number }; travel?: { x: number; leadSec: number; tailSec: number } }
  | { t: 'move'; x: number; mode: 'instant' | 'line' | 'spring'; ms?: number }
  | {
      t: 'say';
      text: string;
      ms?: number;
      replyId?: string;
      question?: { id: string; question: string; options: string[]; at: number; requestId?: string };
      /** Each beat is one bubble, typed out by the page; previous beats remain as trails. */
      beats?: Array<{ text: string; outputId?: string; hold?: number; actions?: unknown[]; anchors?: Array<{ at: number; actions: unknown[] }> }>;
      /** Seconds the last beat stays up at least. */
      hold?: number;
    }
  /** What the person typed: shown as their own line above her bubbles. */
  | { t: 'said'; text: string }
  /** Reveal the window: it starts hidden until the brain has placed her where she may stand. */
  | { t: 'show' }
  | { t: 'stop' };

export class BodyLink extends EventEmitter {
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private next = 1;
  readonly token = randomBytes(18).toString('hex');
  /** What the body last said about itself. */
  x = 0.5;
  /** The pointer on screen, as last reported by the body; null until it reports once. */
  pointer: { x: number; y: number } | null = null;
  facing: 'left' | 'right' = 'left';
  areaWidth = 0;
  /** The work area it stands on, in DIPs, with the display's scale; null before it said hello. */
  display: { x: number; y: number; width: number; height: number; scale: number } | null = null;

  /** Starts listening on 127.0.0.1 and gives the address the body connects to (its `BODY_WS`). */
  async start(port = 0): Promise<string> {
    const server = new WebSocketServer({ host: '127.0.0.1', port, path: '/body' });
    this.server = server;
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    server.on('connection', (ws, req) => {
      if (new URL(req.url ?? '', 'http://x').searchParams.get('token') !== this.token) { ws.close(4001, 'bad token'); return; }
      this.socket?.close(4000, 'replaced');
      this.socket = ws;
      ws.on('message', (data) => this.received(String(data)));
      ws.on('close', () => { if (this.socket === ws) { this.socket = null; this.emit('gone'); } });
    });
    const address = server.address();
    return `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/body?token=${this.token}`;
  }

  get connected(): boolean { return this.socket !== null; }

  /** Sends a command; returns its id (stop and say take none back). */
  send(command: BodyCommand): number {
    const id = this.next++;
    this.socket?.send(JSON.stringify({ ...command, id }));
    return id;
  }

  /** The first message for which `match` holds, from now on; disconnect rejects the wait. */
  waitFor(match: (m: BodyMessage) => boolean): Promise<BodyMessage> {
    if (!this.connected) return Promise.reject(new Error('body disconnected'));
    return new Promise((resolve, reject) => {
      const onMessage = (m: BodyMessage) => {
        if (!match(m)) return;
        cleanup();
        resolve(m);
      };
      const onGone = () => { cleanup(); reject(new Error('body disconnected')); };
      const cleanup = () => { this.off('message', onMessage); this.off('gone', onGone); };
      this.on('message', onMessage);
      this.once('gone', onGone);
    });
  }

  close(): void {
    this.socket?.close();
    this.server?.close();
  }

  private received(text: string): void {
    let m: BodyMessage;
    try { m = JSON.parse(text) as BodyMessage; } catch { return; }
    if (m.t === 'hello') { this.x = m.x; this.facing = m.facing; this.areaWidth = m.display.width; this.display = m.display; this.emit('hello', m); }
    if (m.t === 'pose') { this.x = m.x; this.facing = m.facing; }
    if (m.t === 'move' || m.t === 'landed' || m.t === 'drop' || m.t === 'grab' || m.t === 'click') this.x = m.x;
    if (m.t === 'pointer') this.pointer = { x: m.x, y: m.y };
    this.emit('message', m);
  }
}
