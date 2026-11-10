'use strict';
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { call } = require('./bridge.cjs');

const root = path.resolve(__dirname, '..');
const dataDir = process.env.LINGXI_DATA_DIR || path.join(root, 'build', 'lingxi-pet', 'home', 'lingxi', 'data');

if (process.platform === 'win32') app.setAppUserModelId('com.lingxi.pet');

// The tray can ask us to show the window before app.whenReady() has installed
// the BrowserWindow. Keep that request until the window exists instead of
// silently dropping it.
let showPending = false;
process.on('message', (message) => {
  if (message?.type === 'show') {
    showPending = true;
    if (windowRef) present();
  }
  if (message?.type === 'quit' && !app.isQuitting) { app.isQuitting = true; app.quit(); }
});
let windowRef = null;
function present() {
  const win = windowRef;
  if (!win || win.isDestroyed()) return;
  showPending = false;
  if (win.isMinimized()) win.restore();
  const wasAlwaysOnTop = win.isAlwaysOnTop();
  // Windows can refuse a foreground switch from a tray process when another
  // app owns focus. A one-call always-on-top raise is enough to acquire the
  // foreground; restore the user's original setting immediately afterwards.
  if (!wasAlwaysOnTop) win.setAlwaysOnTop(true);
  win.show();
  // show() normally focuses, but app.focus() is needed when the tray process
  // was the active Electron app and the workbench was hidden.
  app.focus();
  win.focus();
  if (!wasAlwaysOnTop) win.setAlwaysOnTop(false);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ width: 1040, height: 720, minWidth: 520, minHeight: 480, autoHideMenuBar: true, frame: false, show: false,
    title: '灵犀', icon: path.join(root, 'tray', 'icon.ico'), backgroundColor: '#101a20', webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    } });
  windowRef = win;
  win.on('focus', () => win.setAlwaysOnTop(false));
  ipcMain.handle('lingxi:call', async (event, operation, body) => {
    if (win.isDestroyed()) throw new Error('Window closed');
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid sender');
    if (operation === 'outputReceipt' && (!win.isVisible() || win.isMinimized())) return { recorded: false };
    const access = JSON.parse(await readFile(path.join(dataDir, 'lingxi-api.json'), 'utf8'));
    return call(access, operation, body);
  });
  ipcMain.handle('lingxi:window', (event, action) => {
    if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
    else return false;
    return true;
  });
  const visible = () => !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  ipcMain.handle('lingxi:visible', (event) => {
    if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
    return visible();
  });
  for (const name of ['show', 'hide', 'minimize', 'restore']) win.on(name, () => {
    if (!win.isDestroyed()) win.webContents.send('lingxi:visibility', visible());
  });
  win.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  void win.loadFile(path.join(__dirname, 'index.html'));
  if (showPending) present();
});
app.on('window-all-closed', () => app.quit());
