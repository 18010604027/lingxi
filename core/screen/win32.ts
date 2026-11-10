/**
 * What reading the screen needs from Windows, through koffi (moved from the old pet package's cua/engine/win32.ts;
 * the pixels now come from node-screenshots, capture.ts): the top-level windows in z-order, the program
 * of a process, the pointer, the last input, the foreground window, and where typing goes (the caret, else the
 * focused control, through an isolated PowerShell helper for UI Automation).
 *
 * Coordinates are physical pixels of the virtual screen: the primary display's top-left corner is (0, 0), displays
 * left of or above it are negative. The process declares itself per-monitor DPI aware (v2) when this loads, so no
 * API here returns scaled values (the brain process has no windows of its own for that to change).
 */
import koffi from 'koffi';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { DeskRect, InputFocusResult } from './types.ts';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

koffi.alias('HANDLE', 'void *');
koffi.alias('HWND', 'HANDLE');

koffi.struct('POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
  cbSize: 'uint32_t', flags: 'uint32_t', hwndActive: 'HWND', hwndFocus: 'HWND', hwndCapture: 'HWND',
  hwndMenuOwner: 'HWND', hwndMoveSize: 'HWND', hwndCaret: 'HWND', rcCaret: RECT,
});
const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32_t', dwTime: 'uint32_t' });
koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)');

const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *info)');
const GetTickCount = kernel32.func('uint32_t __stdcall GetTickCount()');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(HWND hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(HWND hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(HWND hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(HWND hwnd, _Out_ RECT *rect)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hwnd, int index)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32_t *pid)');
const OpenProcess = kernel32.func('HANDLE __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(HANDLE process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(HANDLE handle)');
const GetForegroundWindow = user32.func('HWND __stdcall GetForegroundWindow()');
const GetGUIThreadInfo = user32.func('bool __stdcall GetGUIThreadInfo(uint32_t thread, _Inout_ GUITHREADINFO *info)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(HWND hwnd, _Inout_ POINT *point)');
const DwmGetWindowAttributeInt = dwmapi.func('long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ int *value, uint32_t size)');
const DwmGetWindowAttributeRect = dwmapi.func('long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ RECT *value, uint32_t size)');
const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

SetProcessDpiAwarenessContext(-4);

let focusHelper: ChildProcessWithoutNullStreams | null = null;
let helperReady = false;
let focusPending: { resolve: (result: InputFocusResult | null) => void; window: string; timer: NodeJS.Timeout } | null = null;

/** Close the isolated UI Automation helper during a normal application stop. */
export function closeInputFocusHelper(): Promise<void> {
  const child = focusHelper;
  if (!child) return Promise.resolve();
  helperReady = false;
  if (focusPending) {
    clearTimeout(focusPending.timer);
    focusPending.resolve(null);
    focusPending = null;
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    child.once('exit', done);
    child.once('close', done);
    try { child.stdin.end(); } catch { done(); }
  });
}

function startFocusHelper(): void {
  if (focusHelper) return;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./win32-caret.ps1', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  focusHelper = child;
  const startupTimer = setTimeout(() => child.kill(), 5000);
  const lines = createInterface({ input: child.stdout });
  const finish = () => {
    clearTimeout(startupTimer); lines.close();
    if (focusHelper !== child) return;
    focusHelper = null; helperReady = false;
    if (focusPending) { clearTimeout(focusPending.timer); focusPending.resolve(null); focusPending = null; }
  };
  child.once('exit', finish); child.once('error', finish);
  child.stderr.resume();
  lines.on('line', line => {
    if (line === 'ready') { clearTimeout(startupTimer); helperReady = true; return; }
    const pending = focusPending;
    if (!pending || focusHelper !== child) return;
    focusPending = null; clearTimeout(pending.timer);
    try {
      const selected = (JSON.parse(line) as { selected: null | { x: number; y: number; width: number; height: number; window: string; pid: number; source: 'gui-thread' | 'msaa' | 'uia'; kind: 'caret' | 'focus'; controlType: number | null } }).selected;
      if (!selected || !['gui-thread', 'msaa', 'uia'].includes(selected.source) || !['caret', 'focus'].includes(selected.kind)
        || selected.window !== pending.window || selected.window !== koffi.address(GetForegroundWindow()).toString(16)
        || ![selected.x, selected.y, selected.width, selected.height].every(Number.isFinite) || selected.width < 0 || selected.height <= 0) { pending.resolve(null); return; }
      pending.resolve({ kind: selected.kind, source: selected.source, window: selected.window, pid: selected.pid,
        rect: { x: selected.x, y: selected.y, width: selected.width, height: selected.height }, controlType: selected.controlType, observedAtMs: Date.now() });
    } catch { pending.resolve(null); }
  });
}

/** Current input caret, then accessibility caret, then the focused control. Reads geometry only; never infers typing. */
export async function inputFocus(): Promise<InputFocusResult | null> {
  const foreground = GetForegroundWindow();
  if (!foreground) return null;
  const address = koffi.address(foreground).toString(16), pid = [0];
  const thread = GetWindowThreadProcessId(foreground, pid);
  const info = { cbSize: koffi.sizeof(GUITHREADINFO), flags: 0, hwndActive: null, hwndFocus: null, hwndCapture: null,
    hwndMenuOwner: null, hwndMoveSize: null, hwndCaret: null, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
  if (GetGUIThreadInfo(thread, info) && info.hwndCaret) {
    const a = { x: info.rcCaret.left, y: info.rcCaret.top }, b = { x: info.rcCaret.right, y: info.rcCaret.bottom };
    if (ClientToScreen(info.hwndCaret, a) && ClientToScreen(info.hwndCaret, b) && b.y > a.y && b.x >= a.x && koffi.address(GetForegroundWindow()).toString(16) === address) {
      return { kind: 'caret', source: 'gui-thread', window: address, pid: pid[0]!, rect: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }, controlType: null, observedAtMs: Date.now() };
    }
  }
  startFocusHelper();
  // The first call warms the isolated COM helper. A slow provider cannot block the engine indefinitely.
  if (!helperReady || focusPending || !focusHelper) return null;
  return new Promise(resolve => {
    const child = focusHelper!;
    const timer = setTimeout(() => { if (focusPending?.timer === timer) { focusPending = null; resolve(null); child.kill(); } }, 200);
    focusPending = { resolve, window: address, timer };
    try {
      child.stdin.write(`${address}\n`);
    } catch {
      if (focusPending?.timer === timer) { clearTimeout(timer); focusPending = null; resolve(null); }
    }
  });
}

process.once('exit', () => focusHelper?.kill());

export function cursor(): { x: number; y: number } {
  const p = { x: 0, y: 0 };
  GetCursorPos(p);
  return p;
}

/** Tick (ms since boot, wraps at 2^32) of the last input from any source. */
export function lastInputTick(): number {
  const info = { cbSize: koffi.sizeof(LASTINPUTINFO), dwTime: 0 };
  GetLastInputInfo(info);
  return info.dwTime;
}

export function tick(): number {
  return GetTickCount();
}

export interface WindowInfo {
  title: string;
  pid: number;
  rect: DeskRect;
  minimized: boolean;
  foreground: boolean;
}

function frameRect(hwnd: unknown): DeskRect {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  if (DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(RECT)) !== 0) GetWindowRect(hwnd, r);
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/** Visible, titled, uncloaked top-level windows in z-order (topmost first). */
export function windows(): WindowInfo[] {
  const fg = koffi.address(GetForegroundWindow());
  const out: WindowInfo[] = [];
  const buf = new Uint16Array(512);
  EnumWindows((hwnd: unknown) => {
    if (!IsWindowVisible(hwnd)) return true;
    if (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return true;
    const cloaked = [0];
    if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) return true;
    const n = GetWindowTextW(hwnd, buf, buf.length);
    if (n <= 0) return true;
    const title = String.fromCharCode(...buf.subarray(0, n));
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    const address = koffi.address(hwnd);
    out.push({ title, pid: pid[0], rect: frameRect(hwnd), minimized: IsIconic(hwnd), foreground: address === fg });
    return true;
  }, 0);
  return out;
}

/** The executable's file name of process `pid` ("cmd.exe"), null when it cannot be read. */
export function processName(pid: number): string | null {
  const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!process) return null;
  try {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    if (!QueryFullProcessImageNameW(process, 0, buf, size)) return null;
    const path = String.fromCharCode(...buf.subarray(0, size[0]));
    return path.slice(path.lastIndexOf('\\') + 1);
  } finally {
    CloseHandle(process);
  }
}
