'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { call } = require('../../workbench/bridge.cjs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../../workbench/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  ipcMain.handle('lingxi:call', (event, operation, body) => {
    if (event.sender !== win.webContents) throw new Error('Invalid sender');
    return call({ port: Number(process.env.WORKBENCH_TEST_PORT), token: 'x'.repeat(48) }, operation, body);
  });
  await win.loadFile(path.resolve(__dirname, '../../workbench/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#say');
    input.value = '触发增量';
    document.querySelector('#say-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (process.env.WORKBENCH_TEST_SCREENSHOT) {
    const image = await win.webContents.capturePage();
    require('node:fs').writeFileSync(process.env.WORKBENCH_TEST_SCREENSHOT, image.toPNG());
  }
  const result = await win.webContents.executeJavaScript(`({ text: document.body.innerText, node: typeof process, bridge: typeof window.lingxi.call })`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.exit(result.text.includes('精神不错') && result.text.includes('fixture-model') && result.text.includes('测试消息') && result.text.includes('测试回复') && result.text.includes('增量回复') && result.node === 'undefined' && result.bridge === 'function' ? 0 : 1);
}).catch((error) => { process.stderr.write(`${error.stack}\n`); app.exit(1); });
