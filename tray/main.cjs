'use strict';
const { app, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
let tray = null;
let quitting = false;
function send(type) { if (typeof process.send === 'function') process.send({ type }); }
function icon() {
  return nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 32, height: 32 });
}
app.whenReady().then(() => {
  tray = new Tray(icon());
  tray.setToolTip('灵犀');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '灵犀', enabled: false }, { type: 'separator' },
    { label: '显示灵犀', click: () => send('show-workbench') },
    { label: '显示身体', click: () => send('show-body') },
    { type: 'separator' },
    { label: '退出灵犀', click: () => { send('quit'); quitting = true; app.quit(); } },
  ]));
  // A normal left click and a double click both mean “show”. The operation is
  // idempotent, so the platform's click-before-double-click sequence is safe.
  tray.on('click', () => send('show-workbench'));
  tray.on('double-click', () => send('show-workbench'));
});
process.on('message', (message) => { if (message?.type === 'quit' && !quitting) { quitting = true; app.quit(); } });
app.on('before-quit', () => { tray?.destroy(); tray = null; });
