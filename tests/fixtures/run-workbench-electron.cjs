'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const server = http.createServer((req, res) => {
  if (req.headers['x-lingxi-token'] !== 'x'.repeat(48)) { res.writeHead(401).end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/lingxi/status' ? { feeling: '精神不错', body: { connected: true }, model: { name: 'fixture-model', configured: true } }
    : req.url === '/lingxi/settings' ? { name: '灵犀', user: '测试者' }
    : req.url === '/lingxi/history' ? { available: true, cursor: 2, lines: [{ who: 'person', kind: 'said', text: '测试消息' }, { who: 'pet', kind: 'say', text: '测试回复' }] }
    : req.url === '/lingxi/say' ? { delivered: true }
    : req.url === '/lingxi/history-since?after=2' ? { available: true, cursor: 3, lines: [{ who: 'pet', kind: 'say', text: '增量回复' }] } : []));
});
server.listen(0, '127.0.0.1', () => {
  const env = { ...process.env, WORKBENCH_TEST_PORT: String(server.address().port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = path.resolve(__dirname, '../../node_modules/electron/dist/electron.exe');
  const child = spawn(executable, [path.join(__dirname, 'workbench-electron.cjs')], { env, stdio: 'inherit' });
  child.on('exit', (code) => { server.close(); process.exitCode = code ?? 1; });
  child.on('error', (error) => { console.error(error); server.close(); process.exitCode = 1; });
});
