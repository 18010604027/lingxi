'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { call } = require('../../workbench/bridge.cjs');

app.setPath('userData', process.env.WORKBENCH_TEST_PROFILE);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, webPreferences: { preload: path.resolve(__dirname, '../../workbench/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  ipcMain.handle('lingxi:visible', () => { const visible = !win.isDestroyed() && win.isVisible() && !win.isMinimized(); process.stdout.write(JSON.stringify({step:'visible',visible,minimized:win.isMinimized()})+'\n'); return visible; });
  ipcMain.handle('lingxi:call', (event, operation, body) => {
    if (win.isDestroyed()) throw new Error('Window closed');
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid sender');
    return call({ port: Number(process.env.WORKBENCH_TEST_PORT), token: 'e'.repeat(48) }, operation, body).then(result => { if (['outputs','outputReceipt'].includes(operation)) process.stdout.write(JSON.stringify({step:operation,body,result})+'\n'); return result; }).catch(error => { process.stdout.write(JSON.stringify({step:'ipc-error',operation,error:error.message})+'\n'); throw error; });
  });
  win.webContents.on('console-message', (_e, _l, message) => process.stdout.write(JSON.stringify({step:'console',message})+'\n'));
  await win.loadFile(path.resolve(__dirname, '../../workbench/index.html'));
  win.show();
  process.stdout.write(JSON.stringify({step:'show-called',visible:win.isVisible(),minimized:win.isMinimized()})+'\n');
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const check = () => !!document.querySelector('[data-answer]') && document.querySelector('#conversation')?.textContent.includes('离线窗口文字');
    if (check()) { resolve(); return; }
    const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
    observer.observe(document.querySelector('#content'), { childList: true, subtree: true });
  })`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  process.stdout.write(JSON.stringify({step:'final-native',visible:win.isVisible(),minimized:win.isMinimized()})+'\n');
  const result = await win.webContents.executeJavaScript(`({ text: document.body.innerText, visibility: document.visibilityState, node: typeof process, bridge: typeof window.lingxi.call })`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.exit(result.text.includes('身体暂时离线') && result.text.includes('离线窗口文字') && result.text.includes('独立问题') && result.node === 'undefined' && result.bridge === 'function' ? 0 : 1);
}).catch((error) => { process.stderr.write(`${error.stack}\n`); app.exit(1); });
