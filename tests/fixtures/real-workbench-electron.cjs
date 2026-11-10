'use strict';
// Visible controlled acceptance; only the existing preload, renderer and API bridge are used.
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { call } = require('../../workbench/bridge.cjs');
app.setPath('userData', process.env.WORKBENCH_TEST_PROFILE);
const access = { port: Number(process.env.WORKBENCH_TEST_PORT), token: process.env.WORKBENCH_TEST_TOKEN };
const evidenceDir = process.env.WORKBENCH_TEST_EVIDENCE;
const steps = [];
let finished = false;
app.on('window-all-closed', () => {
  if (finished) return;
  writeFileSync(path.join(evidenceDir, 'ui-evidence.json'), JSON.stringify({ ok: false, steps, error: 'Window closed before acceptance completed' }, null, 2));
  app.exit(1);
});
const record = (step, detail) => {
  const row = { at: new Date().toISOString(), step, ...detail };
  steps.push(row);
  writeFileSync(path.join(evidenceDir, 'ui-progress.json'), JSON.stringify(steps, null, 2));
  process.stdout.write(`${JSON.stringify(row)}\n`);
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const testState = async () => {
  const response = await fetch(`http://127.0.0.1:${access.port}/lingxi/test-state`, { headers: { 'x-lingxi-token': process.env.WORKBENCH_TEST_TOKEN } });
  if (!response.ok) throw new Error('Unable to read controlled fixture state');
  return response.json();
};
let activeWindow;
async function until(check, label) {
  for (;;) {
    if (!activeWindow || activeWindow.isDestroyed()) throw new Error(`Window closed while waiting for ${label}`);
    const value = await check();
    if (value) return value;
    await pause();
  }
}
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const narrow = process.env.WORKBENCH_TEST_NARROW === '1';
  const win = new BrowserWindow({ width: narrow ? 620 : 1040, height: 760, autoHideMenuBar: true, frame: false, title: '灵犀受控验收（临时数据）',
    webPreferences: { preload: path.resolve(__dirname, '../../workbench/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  activeWindow = win;
  const visible = () => !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  win.webContents.on('console-message', (_event, _level, message) => record('renderer-console', { message }));
  win.webContents.on('render-process-gone', (_event, detail) => record('renderer-gone', detail));
  ipcMain.handle('lingxi:call', (event, operation, body) => {
    if (win.isDestroyed() || event.sender.isDestroyed()) return false;
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid sender');
    if (operation === 'outputReceipt' && !visible()) return { recorded: false };
    return call(access, operation, body);
  });
  ipcMain.handle('lingxi:window', (event, action) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
    if (action === 'minimize') win.minimize(); else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } else if (action === 'close') win.close(); else return false;
    return true;
  });
  ipcMain.handle('lingxi:visible', (event) => event.sender === win.webContents && visible());
  for (const name of ['show', 'hide', 'minimize', 'restore']) win.on(name, () => {
    if (!win.isDestroyed()) win.webContents.send('lingxi:visibility', visible());
  });
  await win.loadFile(path.resolve(__dirname, '../../workbench/index.html'));
  // `document.visibilityState` can be visible even while an Electron window remains hidden.
  // The receipt contract requires the native window to be visible too.
  win.show();
  win.focus();
  const evaluate = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) {
      record('renderer-evaluate-failed', { code, error: error.message, stack: error.stack });
      throw error;
    }
  };
  await until(() => evaluate("!!document.querySelector('#say-form')"), 'chat form after navigation');
  record('window-ready', { nativeVisible: visible(), document: await evaluate('document.visibilityState'), viewport: await evaluate('({ width: innerWidth, height: innerHeight })') });
  if (process.env.WORKBENCH_TEST_WINDOW_CONTROLS === '1') {
    const drag = await evaluate("getComputedStyle(document.querySelector('.window-bar')).webkitAppRegion");
    const controls = await evaluate("getComputedStyle(document.querySelector('.window-actions')).webkitAppRegion");
    if (drag !== 'drag' || controls !== 'no-drag') throw new Error('Window drag areas are not configured');
    await evaluate("document.querySelector('[data-window=maximize]').click()");
    await until(() => win.isMaximized(), 'window maximize');
    await evaluate("document.querySelector('[data-window=maximize]').click()");
    await until(() => !win.isMaximized(), 'window restore');
    await evaluate("document.querySelector('[data-window=minimize]').click()");
    await until(() => win.isMinimized(), 'window minimize');
    win.restore(); win.show(); win.focus();
    await until(async () => visible() && await evaluate("document.visibilityState === 'visible'"), 'window visible after restore');
    record('window-controls', { drag, controls, restored: visible(), maximized: win.isMaximized() });
  }

  if (process.env.WORKBENCH_TEST_CLOSE_AFTER_READY === '1') { win.close(); return; }
  if (process.env.WORKBENCH_TEST_SETTINGS_ONLY === '1') {
    await evaluate("document.querySelector('[data-page=settings]').click()");
    await until(() => evaluate("!!document.querySelector('#runtime-settings-form textarea[name=constitution]')"), 'settings form');
    const settingsShot = path.join(evidenceDir, 'settings-page.png');
    writeFileSync(settingsShot, (await win.webContents.capturePage()).toPNG());
    const geometry = await evaluate(`(() => { const c=document.querySelector('#content'), f=document.querySelector('.settings-footer'), r=f.getBoundingClientRect(); c.scrollTop=c.scrollHeight; const b=f.getBoundingClientRect(); return { viewport:innerHeight, footerBottom:b.bottom, footerVisible:b.bottom<=innerHeight, sections:[...document.querySelectorAll('.settings-group h2')].map(x=>x.textContent) }; })()`);
    await evaluate(`(() => { const x=document.querySelector('textarea[name=constitution]'); x.value='新的角色设定：喜欢晴天'; x.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-page=behind]').click(); })()`);
    await until(() => evaluate("!!document.querySelector('.settings-leave-dialog')"), 'unsaved changes dialog');
    const dialogShot = path.join(evidenceDir, 'settings-leave-options.png');
    writeFileSync(dialogShot, (await win.webContents.capturePage()).toPNG());
    const choices = await evaluate("[...document.querySelectorAll('.settings-leave-dialog [data-choice]')].map(x=>x.textContent.trim())");
    await evaluate("document.querySelector('[data-choice=stay]').click()");
    const draftKept = await evaluate("document.querySelector('textarea[name=constitution]').value==='新的角色设定：喜欢晴天'");
    await evaluate("document.querySelector('[data-page=behind]').click()");
    await until(() => evaluate("!!document.querySelector('.settings-leave-dialog')"), 'save and leave option');
    await evaluate("document.querySelector('[data-choice=save]').click()");
    await until(() => evaluate("document.querySelector('#title')?.textContent==='后台'"), 'navigate after save');
    const saved = (await testState()).workbenchSettings.profile.constitution === '新的角色设定：喜欢晴天';
    await evaluate("document.querySelector('[data-page=settings]').click()");
    await until(() => evaluate("!!document.querySelector('input[name=user]')"), 'settings restored after navigation');
    await evaluate(`(() => { const x=document.querySelector('input[name=user]'); x.value='不应保存'; x.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-page=now]').click(); })()`);
    await until(() => evaluate("!!document.querySelector('.settings-leave-dialog')"), 'discard option');
    await evaluate("document.querySelector('[data-choice=discard]').click()");
    await until(() => evaluate("document.querySelector('#title')?.textContent==='此刻'"), 'navigate after discard');
    const discarded = (await testState()).workbenchSettings.profile.user === '测试者';
    const ok = visible() && geometry.footerVisible && geometry.sections.join('|') === '角色与称呼|表达与对话|前台模型|后台执行'
      && choices.join('|') === '继续编辑|放弃更改|保存并离开' && draftKept && saved && discarded;
    record('settings-save-and-leave-acceptance', { geometry, choices, draftKept, saved, discarded, settingsShot, dialogShot });
    writeFileSync(path.join(evidenceDir, 'settings-acceptance.json'), JSON.stringify({ ok, geometry, choices, draftKept, saved, discarded, settingsShot, dialogShot }, null, 2));
    finished = true;
    app.exit(ok ? 0 : 1);
    return;
  }
  if (process.env.WORKBENCH_TEST_ACTIVITY_DETAIL_ONLY === '1') {
    const toggle = await until(() => evaluate("document.querySelector('#activity-toggle')"), 'activity switch');
    const rect = await evaluate("(() => { const r=document.querySelector('#activity-toggle').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()");
    const pixel = (x,y) => ({x:Math.round(x),y:Math.round(y)});
    const styles = async () => evaluate(`(() => { const b=document.querySelector('#activity-toggle'), t=b.querySelector('.switch-track'), l=b.querySelector(':scope > span:last-child'); const s=getComputedStyle(b), ts=getComputedStyle(t), ls=getComputedStyle(l); return {checked:b.getAttribute('aria-checked'),hovered:b.matches(':hover'),buttonBackground:s.backgroundColor,buttonOutline:s.outlineStyle,labelBackground:ls.backgroundColor,trackBackground:ts.backgroundColor,trackOutline:ts.outlineWidth}; })()`);
    const move = async (x,y) => { win.webContents.sendInputEvent({type:'mouseMove',...pixel(x,y)}); await pause(); };
    const click = async (x,y) => { win.webContents.sendInputEvent({type:'mouseDown',...pixel(x,y),button:'left',clickCount:1}); win.webContents.sendInputEvent({type:'mouseUp',...pixel(x,y),button:'left',clickCount:1}); await pause(); };
    const centerX=rect.x+rect.width/2, centerY=rect.y+rect.height/2;
    const offBefore=await styles();
    const activeShot=path.join(evidenceDir,'activity-switch-active.png');
    win.webContents.sendInputEvent({type:'mouseDown',...pixel(centerX,centerY),button:'left',clickCount:1}); await pause();
    const offActive=await styles();
    writeFileSync(activeShot,(await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({type:'mouseUp',...pixel(centerX,centerY),button:'left',clickCount:1}); await pause();
    await pause();
    let mouseOn=await evaluate("document.querySelector('#activity-toggle')?.getAttribute('aria-checked')==='true'");
    const onHover=await styles();
    const onShot=path.join(evidenceDir,'activity-switch-on.png');
    writeFileSync(onShot,(await win.webContents.capturePage()).toPNG());
    const offShot=path.join(evidenceDir,'activity-switch-off.png');
    await click(centerX,centerY);
    const offHover=await styles();
    writeFileSync(offShot,(await win.webContents.capturePage()).toPNG());
    const mouseOff=offHover.checked==='false' && offHover.hovered;
    record('activity-switch-mouse-click',{mouseOn,mouseOff,rect,centerX,centerY,offBefore,onHover,offHover});
    if(!mouseOn){ await evaluate("document.querySelector('#activity-toggle').click()"); await until(() => evaluate("document.querySelector('#activity-toggle')?.getAttribute('aria-checked')==='true'"),'switch on after mouse diagnosis'); }
    if(!mouseOff){ await evaluate("document.querySelector('#activity-toggle').click()"); await until(() => evaluate("document.querySelector('#activity-toggle')?.getAttribute('aria-checked')==='false'"),'switch off after mouse diagnosis'); }
    await click(centerX,centerY);
    await until(() => evaluate("document.querySelector('#activity-toggle')?.getAttribute('aria-checked')==='true'"),'switch on for timeline');
    const on=await styles();
    for(let i=0;i<30;i+=1){ const text=await evaluate("document.querySelector('#conversation')?.textContent || ''"); if(text.includes('请帮我整理待办。')&&text.includes('已按优先级整理 3 项待办。')&&text.includes('精力充足；有点无聊，想活动')) break; await pause(); }
    const timelineKinds=await evaluate("[...document.querySelectorAll('#conversation .timeline-event')].map(x=>x.textContent.trim())");
    const chatText=await evaluate("document.querySelector('#conversation')?.textContent || ''");
    const controls=await evaluate("[...document.querySelectorAll('#content button')].map(x=>x.textContent.trim())");
    await evaluate("document.querySelector('#refresh').focus()");
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'TAB'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'TAB'}); await pause();
    const tab=await styles();
    const tabTarget=await evaluate("document.activeElement?.id");
    await evaluate(`(() => { const b=document.querySelector('#activity-toggle'); window.__activityKeys=[]; b.addEventListener('keydown',e=>window.__activityKeys.push('down:'+e.key),true); b.addEventListener('keyup',e=>window.__activityKeys.push('up:'+e.key),true); b.addEventListener('click',()=>window.__activityKeys.push('click'),true); })()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'SPACE'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'SPACE'}); await pause();
    const space=await evaluate("document.querySelector('#activity-toggle')?.getAttribute('aria-checked')");
    const activeAfterSpace=await evaluate("document.activeElement?.id");
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'}); await pause();
    const enter=await evaluate("document.querySelector('#activity-toggle')?.getAttribute('aria-checked')");
    const keyEvents=await evaluate("window.__activityKeys");
    const ok=visible() && mouseOn && mouseOff && offBefore.checked==='false' && offActive.checked==='false' && offActive.hovered && offActive.buttonBackground==='rgba(0, 0, 0, 0)' && offActive.labelBackground==='rgba(0, 0, 0, 0)' && offActive.buttonOutline==='none' && offHover.checked==='false' && offHover.buttonBackground==='rgba(0, 0, 0, 0)' && offHover.labelBackground==='rgba(0, 0, 0, 0)' && offHover.hovered && offHover.trackBackground!==offBefore.trackBackground
      && onHover.checked==='true' && onHover.buttonBackground==='rgba(0, 0, 0, 0)' && onHover.labelBackground==='rgba(0, 0, 0, 0)' && onHover.trackBackground!==offBefore.trackBackground
      && on.checked==='true' && on.buttonBackground==='rgba(0, 0, 0, 0)' && on.labelBackground==='rgba(0, 0, 0, 0)' && tabTarget==='activity-toggle' && tab.buttonOutline==='none' && tab.trackOutline==='2px'
      && space==='false' && enter==='true' && timelineKinds.some(x=>x.includes('前台处理状态')) && timelineKinds.some(x=>x.includes('身体动作'))
      && timelineKinds.some(x=>x.includes('后台返回结果')) && chatText.includes('请帮我整理待办。') && timelineKinds.some(x=>x.includes('委派任务 · 已返回'))
      && existsSync(offShot) && existsSync(onShot);
    record('activity-switch-and-timeline', { mouseOn, mouseOff, offBefore, offActive, onHover, offHover, on, tab, tabTarget, space, activeAfterSpace, enter, keyEvents, chatText, timelineKinds, controls, activeShot, offShot, onShot });
    writeFileSync(path.join(evidenceDir,'activity-detail-acceptance.json'),JSON.stringify({ok,mouseOn,mouseOff,offBefore,offActive,onHover,offHover,on,tab,tabTarget,space,activeAfterSpace,enter,keyEvents,chatText,timelineKinds,controls,activeShot,offShot,onShot},null,2));
    finished=true; app.exit(ok?0:1); return;
  }
  if (process.env.WORKBENCH_TEST_REOPEN_ONLY === '1') {
    const expectedIds = JSON.parse(process.env.WORKBENCH_TEST_REOPEN_OUTPUT_IDS || '[]');
    const initial = await call(access, 'outputs', { after: 0 });
    const expected = initial.outputs.filter((item) => expectedIds.includes(item.id));
    if (!expectedIds.length || expected.length !== expectedIds.length) throw new Error('Persisted output ids are missing after host restart');
    if (expectedIds.some((id) => !initial.receipts.some((receipt) => receipt.outputId === id && receipt.channel === 'workbench' && receipt.state === 'presented'))) {
      throw new Error('Persisted workbench presentation receipts are missing after host restart');
    }
    const text = await until(async () => {
      const value = await evaluate("document.querySelector('#conversation')?.textContent || ''");
      return expected.every((part) => value.includes(part.text)) ? value : null;
    }, 'persisted output after host restart');
    const renderedCount = await evaluate('document.querySelectorAll("#conversation [data-output-id]").length');
    if (renderedCount !== expectedIds.length) throw new Error(`Persisted output rendered ${renderedCount} times; expected ${expectedIds.length}`);
    await pause();
    const after = await call(access, 'outputs', { after: 0 });
    const beforeReceipts = initial.receipts.filter((receipt) => receipt.channel === 'workbench').length;
    const afterReceipts = after.receipts.filter((receipt) => receipt.channel === 'workbench').length;
    if (afterReceipts !== beforeReceipts) throw new Error('Reopened workbench duplicated presentation receipts');
    const screenshot = path.join(evidenceDir, 'workbench-reopened.png');
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    const isolation = await evaluate("({ node: typeof process, document: document.visibilityState })");
    const ok = visible() && isolation.document === 'visible' && isolation.node === 'undefined';
    record('host-reopen-results-rendered-once', { text, outputIds: expectedIds, renderedCount, beforeReceipts, afterReceipts, nativeVisible: visible(), isolation, screenshot });
    writeFileSync(path.join(evidenceDir, 'ui-reopen-evidence.json'), JSON.stringify({ ok, outputIds:expectedIds, receiptCount:afterReceipts, steps, isolation, screenshot }, null, 2));
    finished = true;
    app.exit(ok ? 0 : 1);
    return;
  }
  if (process.env.WORKBENCH_TEST_INTERACTION_REOPEN === '1') {
    await until(() => evaluate("!!document.querySelector('#say-form')"), 'chat after application relaunch');
    await until(() => evaluate("document.querySelector('#front-state')?.textContent.includes('前台处理失败：fixture reconnect boundary')"), 'front state after application relaunch');
    await evaluate("document.querySelector('[data-page=behind]').click()");
    await until(() => evaluate("document.body.textContent.includes('连接中断，结果未知') && document.body.textContent.includes('cancelling · framework-v1')"), 'persisted tasks after application relaunch');
    const screenshot = path.join(evidenceDir, 'workbench-reopened.png');
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    const isolation = await evaluate("({ node: typeof process, visible: document.visibilityState })");
    const ok = visible() && isolation.visible === 'visible' && isolation.node === 'undefined';
    record('application-reopened-state-restored', { screenshot, isolation, taskText: await evaluate("document.querySelector('#content')?.textContent") });
    writeFileSync(path.join(evidenceDir, 'ui-reopen-evidence.json'), JSON.stringify({ ok, steps, isolation, screenshot }, null, 2));
    finished = true;
    app.exit(ok ? 0 : 1);
    return;
  }
  if (process.env.WORKBENCH_TEST_ACTIVITY_ONLY === '1') {
    await until(() => evaluate("!!document.querySelector('#activity-toggle')"), 'activity controls');
    record('activity-controls-ready');
    await evaluate("document.querySelector('#activity-toggle').click()");
    const text = await until(async () => {
      const value = await evaluate("document.querySelector('#conversation')?.textContent || ''");
      return value.includes('代码助手') && value.includes('执行状态') && value.includes('已启动') && value.includes('第 2 次尝试') ? value : null;
    }, 'persisted activity in detailed timeline');
    record('activity-timeline-ready', { text });
    const source = await call(access, 'activity', {});
    record('activity-source-checked', { agentSource: source.sources.find((item) => item.id === 'agents') });
    if (JSON.stringify(source).includes('private') || JSON.stringify(source).includes('secret')) throw new Error('Private activity payload reached API response');
    const screenshot = path.join(evidenceDir, 'workbench.png');
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    const isolation = await evaluate("({ node: typeof process, visible: document.visibilityState })");
    const ok = visible() && isolation.visible === 'visible' && isolation.node === 'undefined';
    record('agent-activity-rendered', { text, source: source.sources.find((item) => item.id === 'agents'), screenshot });
    writeFileSync(path.join(evidenceDir, 'ui-evidence.json'), JSON.stringify({ ok, steps, isolation, screenshot }, null, 2));
    finished = true;
    app.exit(ok ? 0 : 1);
    return;
  }
  if (process.env.WORKBENCH_TEST_INTERACTION_REOPEN === '1') {
    await until(() => evaluate("!!document.querySelector('#say-form')"), 'chat after application relaunch');
    await until(() => evaluate("document.querySelector('#front-state')?.textContent.includes('前台处理失败：fixture reconnect boundary')"), 'front state after application relaunch');
    await evaluate("document.querySelector('[data-page=behind]').click()");
    await until(() => evaluate("document.body.textContent.includes('连接中断，结果未知') && document.body.textContent.includes('cancelling · framework-v1')"), 'persisted tasks after application relaunch');
    const screenshot = path.join(evidenceDir, 'workbench-reopened.png');
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    const isolation = await evaluate("({ node: typeof process, visible: document.visibilityState })");
    const ok = visible() && isolation.visible === 'visible' && isolation.node === 'undefined';
    record('application-reopened-state-restored', { screenshot, isolation, taskText: await evaluate("document.querySelector('#content')?.textContent") });
    writeFileSync(path.join(evidenceDir, 'ui-reopen-evidence.json'), JSON.stringify({ ok, steps, isolation, screenshot }, null, 2));
    finished = true;
    app.exit(ok ? 0 : 1);
    return;
  }
  if (process.env.WORKBENCH_TEST_INTERACTION_ONLY === '1') {
    await evaluate(`(() => { const input=document.querySelector('#say'); input.value='切页与刷新期间保留的草稿'; input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); input.setSelectionRange(4,4); document.querySelector('#refresh').click(); })()`);
    const draftState = await until(async () => evaluate("(() => { const input=document.querySelector('#say'); return input?.value==='切页与刷新期间保留的草稿' && document.activeElement===input && input.selectionStart===4; })()"), 'chat draft and focus after refresh');
    await evaluate(`(() => { const input=document.querySelector('#say'); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
    const chatImeGuard = (await testState()).submitted === 0;
    await evaluate(`document.querySelector('#say').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
    record('chat-draft-focus-ime', { draftFocusPreserved: !!draftState, compositionGuard: chatImeGuard });
    await until(() => evaluate("!!document.querySelector('[data-free-answer=\\\"先处理哪一项？\\\"] input')"), 'pending question input');
    await evaluate(`(() => { const input = document.querySelector('form[data-free-answer] input'); input.value = '先处理可取消项'; input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
    const compositionGuard = (await call(access, 'asks')).length === 1;
    await evaluate(`(() => { const input = document.querySelector('form[data-free-answer] input'); input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
    await until(async () => !(await call(access, 'asks')).length, 'question answer accepted');
    await until(() => evaluate("document.querySelector('#front-state')?.textContent.includes('前台处理失败：fixture reconnect boundary')"), 'front failure visible');
    record('question-answer-and-front-state', { compositionGuard, answerAccepted: true });
    await evaluate("document.querySelector('[data-page=behind]').click()");
    await until(() => evaluate("!!document.querySelector('[data-cancel=\\\"cancel-ui-1\\\"]') && document.body.textContent.includes('连接中断，结果未知')"), 'cancel and unknown controls');
    await evaluate("document.querySelector('[data-cancel=\\\"cancel-ui-1\\\"]').click()");
    await until(async () => (await call(access, 'tasks')).open?.find((task) => task.id === 'cancel-ui-1')?.status === 'cancelling', 'cancellation requested');
    record('cancel-and-unknown-visible', { cancellation: (await call(access, 'tasks')).open.find((task) => task.id === 'cancel-ui-1').status,
      unknownReason: (await call(access, 'tasks')).open.find((task) => task.id === 'unknown-ui-1').result });
    const screenshot = path.join(evidenceDir, 'workbench.png');
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    const isolation = await evaluate("({ node: typeof process, visible: document.visibilityState })");
    const ok = visible() && isolation.visible === 'visible' && isolation.node === 'undefined';
    record('interaction-session-complete', { screenshot, isolation });
    writeFileSync(path.join(evidenceDir, 'ui-session-evidence.json'), JSON.stringify({ ok, steps, isolation, screenshot }, null, 2));
    finished = true;
    app.exit(ok ? 0 : 1);
    return;
  }
  const submit = (text) => evaluate(`(() => { const input = document.querySelector('#say'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#say-form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); })()`);
  await submit('请把这些材料交给后台整理为待办清单：周一交报告；周三与小林讨论；周五复查。整理期间我还要继续聊天。');
  const task = await until(async () => {
    const tasks = await call(access, 'tasks');
    return tasks.open?.find((item) => item.status === 'running');
  }, 'background task running');
  record('background-running', { taskId: task.id, runnerId: task.runnerId });
  await evaluate("document.querySelector('[data-page=behind]').click()");
  await until(() => evaluate(`!!document.querySelector('form[data-note="${task.id}"]')`), 'task note form');
  await evaluate(`(() => { const form = document.querySelector('form[data-note="${task.id}"]'); form.querySelector('input').value = '补充要求：按日期升序，每项增加一句验收标准。'; form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); })()`);
  await until(() => evaluate(`!document.querySelector('form[data-note="${task.id}"] input')?.value`), 'task note receipt');
  record('note-submitted-through-workbench', { taskId: task.id });
  await evaluate("document.querySelector('[data-page=now]').click()");
  await until(() => evaluate("!!document.querySelector('#say-form')"));
  const previous = new Set((await call(access, 'outputs', { after: 0 })).outputs.map((item) => item.id));
  await submit('顺便聊一句，猫为什么喜欢晒太阳？请直接简短回答这个问题，不必等后台。');
  const chat = await until(async () => {
    const outputs = await call(access, 'outputs', { after: 0 });
    return outputs.outputs.find((item) => !previous.has(item.id) && /猫/.test(item.text) && /太阳|晒|温暖/.test(item.text));
  }, 'chat output');
  const tasksAtChat = await call(access, 'tasks');
  const concurrent = tasksAtChat.open.some((item) => item.id === task.id && item.status === 'running');
  record('persona-chat-output', { text: chat.text, originalTaskStillRunning: concurrent });
  const result = await until(async () => {
    const tasks = await call(access, 'tasks');
    const outputs = await call(access, 'outputs', { after: 0 });
    // One response can contain several speech bubbles. Validate their combined content, not one part.
    const parts = outputs.outputs.filter((item) => item.cursor > chat.cursor);
    const text = parts.map((item) => item.text).join('\n');
    return /验收|标准/.test(text) && /周一/.test(text) && /周三/.test(text) && /周五/.test(text)
      && tasks.done?.some((item) => item.id === task.id && item.status === 'done')
      && tasks.done.filter((item) => item.status === 'done').length >= 2
      && new Set(parts.map((item) => item.messageId)).size >= 2
      && tasks.open?.length === 0 ? { parts, tasks } : null;
  }, 'durable result output');
  await until(() => evaluate(`(() => { const text = document.querySelector('#conversation')?.textContent || ''; return ${JSON.stringify(result.parts.map((item) => item.text))}.every(part => text.includes(part)); })()`), 'result rendered in conversation');
  record('result-rendered', { nativeVisible: visible(), document: await evaluate('document.visibilityState'), parts: result.parts });
  const receipts = await until(async () => {
    const snapshot = await call(access, 'outputs', { after: 0 });
    const found = snapshot.receipts.filter((item) => result.parts.some((part) => part.id === item.outputId)
      && item.channel === 'workbench' && item.state === 'presented');
    return found.length === result.parts.length ? found : null;
  }, 'result workbench receipts');
  record('result-rendered-and-receipted', { outputIds: result.parts.map((part) => part.id), receipts });
  const isolation = await evaluate("({ node: typeof process, bridge: typeof window.lingxi.call, visible: document.visibilityState })");
  const screenshot = path.join(evidenceDir, 'workbench.png');
  writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  const ok = concurrent && isolation.node === 'undefined' && isolation.visible === 'visible' && visible();
  writeFileSync(path.join(evidenceDir, 'ui-evidence.json'), JSON.stringify({ ok, steps, isolation, screenshot }, null, 2));
  record('acceptance-complete', { ok, screenshot, isolation });
  finished = true;
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  writeFileSync(path.join(evidenceDir, 'ui-evidence.json'), JSON.stringify({ ok: false, steps, error: error.message, stack: error.stack, nativeVisible: !!activeWindow && !activeWindow.isDestroyed() && activeWindow.isVisible() }, null, 2));
  process.stderr.write(`${error.stack}\n`);
  finished = true;
  app.exit(1);
});
