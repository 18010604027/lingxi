/**
 * What reading the screen hands back (moved from the old pet package's cua/engine-ipc.ts; only what
 * reading the bottom and glancing at the screen need).
 */

/** A rectangle in the system's desktop coordinates (on Windows, physical pixels of the virtual screen). */
export interface DeskRect { x: number; y: number; width: number; height: number }

export interface StripWindow { app: string | null; title: string; rect: DeskRect; foreground: boolean }

export interface InputFocusResult {
  kind: 'caret' | 'focus';
  source: 'gui-thread' | 'msaa' | 'uia';
  rect: DeskRect;
  window: string;
  pid: number;
  controlType: number | null;
  observedAtMs: number;
}

export interface StripResult {
  /** Physical desktop geometry; focus rectangles are not proof of typing. */
  inputFocus?: InputFocusResult | null;
  display: DeskRect & { index: number; scale: number };
  /** Windows on the display, not minimized, topmost first, their rectangles clipped to the display. */
  windows: StripWindow[];
  cursor: { x: number; y: number };
  idleMs: number;
  /** The display's bottom band, grey, a byte a pixel, row by row; `top` is its top edge in desktop coordinates. */
  strip: { width: number; height: number; gray: Uint8Array; top: number } | null;
}

/** Marks on the bottom band, in desktop physical pixels (x only: they run the band's height). */
export interface BandMarks {
  zones: Array<[number, number]>;
  points: Array<{ x: number; color: 'blue' | 'green' | 'yellow' | 'magenta' }>;
}

export interface BandResult {
  jpeg: Uint8Array;
  width: number;
  height: number;
  display: DeskRect & { index: number; scale: number };
}

export interface Presence {
  /** Milliseconds since the person's last keyboard or mouse input; -1 when none is on record. */
  idleMs: number;
  foregroundApp: string | null;
  foreground: string | null;
}
