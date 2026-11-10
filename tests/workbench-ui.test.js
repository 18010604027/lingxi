import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('standalone workbench', () => {
  it('renders a page of a large timeline and reuses unchanged rows as new actions arrive', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts:'outside-only', pretendToBeVisual:true, url:'file:///workbench/index.html' });
    dom.window.setInterval = () => 1;
    const items = Array.from({ length:4000 }, (_, i) => ({ id:`motion:${i}`, kind:'body-motion', source:'events', position:String(i), at:new Date(Date.UTC(2026,10,10,0,0,i)).toISOString(), summary:'Idle', state:i % 2 ? 'completed' : 'started' }));
    const call = async (operation) => operation === 'status' ? { body:{},front:{state:'idle'} }
      : operation === 'settings' ? { user:'测试者' }
      : operation === 'history' ? { available:true,cursor:0,lines:[] }
      : operation === 'outputs' ? { available:true,cursor:0,outputs:[] }
      : operation === 'asks' ? []
      : operation === 'activity' ? { available:true,cursor:String(items.length),hasMore:false,sources:[],items }
      : {};
    dom.window.lingxi = { call };
    try {
      dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8') + '\nwindow.__timelineTest = { loadActivity, loadOlderHistory, renderConversation };');
      await tick(); await tick();
      await dom.window.__timelineTest.loadActivity();
      const timeline = dom.window.document.querySelector('#conversation');
      expect(timeline.querySelectorAll('details')).toHaveLength(80);
      expect(dom.window.document.querySelectorAll('*').length).toBeLessThan(1000);
      const retained = timeline.querySelector('[data-activity-id="motion:3999"]');
      items.push({ ...items.at(-1), id:'motion:4000', position:'4000', at:'2026-11-10T02:00:00Z' });
      await dom.window.__timelineTest.loadActivity();
      expect(timeline.querySelectorAll('details')).toHaveLength(80);
      expect(timeline.querySelector('[data-activity-id="motion:3999"]')).toBe(retained);
      expect(timeline.querySelector('[data-activity-id="motion:4000"]')).not.toBeNull();
      expect(timeline.querySelector('[data-activity-id="motion:3920"]')).toBeNull();
      await dom.window.__timelineTest.loadOlderHistory();
      expect(timeline.querySelectorAll('details')).toHaveLength(160);
      expect(timeline.querySelector('[data-activity-id="motion:3999"]')).toBe(retained);
      expect(timeline.querySelector('[data-activity-id="motion:3920"]')).not.toBeNull();
    } finally { dom.window.close(); }
  });

  it('keeps timeline nodes and listeners when polling unchanged activity', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts:'outside-only', pretendToBeVisual:true, url:'file:///workbench/index.html' });
    const call = async (operation) => operation === 'status' ? { name:'灵犀', front:{ state:'idle' }, body:{} }
      : operation === 'settings' ? { user:'测试者' }
      : operation === 'history' ? { available:true, cursor:0, lines:[] }
      : operation === 'outputs' ? { available:true, cursor:0, outputs:[] }
      : operation === 'asks' ? []
      : operation === 'activity' ? { available:true, cursor:'1', hasMore:false, sources:[], items:[{ id:'motion:1', kind:'body-motion', source:'events', position:'1', at:'2026-11-10T03:00:00Z', summary:'Idle', state:'completed' }] }
      : {};
    dom.window.lingxi = { call };
    try {
      dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8') + '\nwindow.__timelineTest = { loadActivity, renderConversation };');
      await tick(); await tick();
      await dom.window.__timelineTest.loadActivity();
      const entry = dom.window.document.querySelector('details[data-activity-id="motion:1"]');
      expect(entry).not.toBeNull();
      const mutations = [];
      const observer = new dom.window.MutationObserver(records => mutations.push(...records));
      observer.observe(entry.parentNode, { childList:true });
      for (let i=0; i<20; i++) dom.window.__timelineTest.renderConversation();
      await tick();
      expect(dom.window.document.querySelector('details[data-activity-id="motion:1"]')).toBe(entry);
      expect(mutations).toHaveLength(0);
      entry.open = true;
      await tick();
      dom.window.__timelineTest.renderConversation();
      const expanded = dom.window.document.querySelector('details[data-activity-id="motion:1"]');
      expect(expanded.open).toBe(true);
      dom.window.__timelineTest.renderConversation();
      expect(dom.window.document.querySelector('details[data-activity-id="motion:1"]')).toBe(expanded);
      observer.disconnect();
    } finally { dom.window.close(); }
  });

  it('opens runtime settings, saves supported Codex policy, and never renders the saved key', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const saved = [];
    const snapshot = () => ({ model:{ provider:'local', protocol:'responses', apiUrl:'http://127.0.0.1:9000/v1', model:'test-model', keyConfigured:true }, executor:{ provider:'codex', sandboxMode:'workspace-write', networkAccess:'deny', taskDirectory:'C:/temp/task', description:'Codex CLI' }, apply:{ model:{ requiresRestart:false, message:'聊天后续请求使用新配置' }, executor:{ requiresRestart:true, message:'执行器重启后生效' } } });
    let current = snapshot();
    const call = vi.fn(async (operation, payload) => operation === 'status' ? { name:'灵犀', front:{ state:'idle' }, body:{} }
      : operation === 'settings' ? { name:'灵犀', user:'用户' }
      : operation === 'runtimeSettings' ? current
      : operation === 'saveRuntimeSettings' ? (saved.push(payload), current = { ...current, model:{ ...current.model, ...Object.fromEntries(Object.entries(payload.model || {}).filter(([key]) => key !== 'apiKey')), keyConfigured: current.model.keyConfigured || Boolean(payload.model?.apiKey) }, executor:{ ...current.executor, ...(payload.executor || {}) } }, current)
      : operation === 'asks' ? [] : {});
    Object.assign(dom.window, { lingxi:{ call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8'));
    await tick(); await tick();
    dom.window.document.querySelector('[data-page="settings"]').click();
    await tick(); await tick();
    const content = dom.window.document.querySelector('#content');
    expect(content.textContent).toContain('后台执行');
    expect(content.textContent).toContain('Codex');
    expect(content.textContent).toContain('读取范围仍由 Codex CLI 的沙箱策略决定');
    expect(content.textContent).toContain('聊天后续请求使用新配置');
    expect(content.textContent).toContain('执行器重启后生效');
    expect(content.querySelector('[name="apiKey"]').value).toBe('');
    content.querySelector('[name="sandboxMode"]').value = 'read-only';
    content.querySelector('[name="sandboxMode"]').dispatchEvent(new dom.window.Event('change', { bubbles:true }));
    expect(content.querySelector('[name="networkAccess"]').value).toBe('deny');
    expect(content.querySelector('[name="networkAccess"]').disabled).toBe(true);
    content.querySelector('#runtime-settings-form').dispatchEvent(new dom.window.Event('submit', { bubbles:true, cancelable:true }));
    await tick(); await tick();
    expect(saved[0].model.apiKey).toBe('');
    content.querySelector('[name="apiKey"]').value = 'temporary-test-key';
    content.querySelector('#runtime-settings-form').dispatchEvent(new dom.window.Event('submit', { bubbles:true, cancelable:true }));
    await tick(); await tick();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual({ model:{ protocol:'responses', apiUrl:'http://127.0.0.1:9000/v1', model:'test-model', apiKey:'temporary-test-key' }, executor:{ provider:'codex', sandboxMode:'read-only', networkAccess:'deny' } });
    expect(content.textContent).not.toContain('temporary-test-key');
    expect(content.querySelector('[name="apiKey"]').value).toBe('');
    dom.window.close();
  });

  it('keeps the same identity and front status while switching pages', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts:'outside-only', pretendToBeVisual:true, url:'file:///workbench/index.html' });
    let state = 'processing';
    const call = async (operation) => operation === 'status' ? { name:'灵犀', body:{ connected:true }, front:{ state } }
      : operation === 'settings' ? { name:'灵犀', user:'测试者' }
      : operation === 'runtimeSettings' ? { model:{ provider:'fixture', protocol:'responses', apiUrl:'http://127.0.0.1/v1', model:'fixture', keyConfigured:false }, executor:{ provider:null, sandboxMode:null, networkAccess:null, taskDirectory:null, description:'无代码执行器' }, apply:{ model:{ message:'' }, executor:{ message:'' } } }
      : operation === 'history' ? { available:true, lines:[] } : operation === 'memory' ? { episodes:[] } : operation === 'asks' ? [] : {};
    Object.assign(dom.window, { lingxi:{ call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8'));
    await tick(); await tick();
    expect(dom.window.document.querySelector('#identity-name').textContent).toBe('灵犀');
    expect(dom.window.document.querySelector('#identity-state').textContent).toContain('正在处理');
    for (const page of ['behind','memory','settings','now']) {
      dom.window.document.querySelector(`[data-page="${page}"]`).click();
      await tick(); await tick();
      expect(dom.window.document.querySelector('#identity-name').textContent).toBe('灵犀');
      expect(dom.window.document.querySelector('#identity-state').textContent).toContain('正在处理');
    }
    state = 'idle';
    dom.window.document.querySelector('#refresh').click(); await tick(); await tick();
    expect(dom.window.document.querySelector('#identity-state').textContent).toContain('前台空闲');
    dom.window.close();
  });

  it('interleaves body motion with chat by default and adds detailed records only when toggled', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let sharedTick;
    let motionState = '';
    const actionId = '12345678-1234-1234-1234-123456789abc';
    dom.window.setInterval = (callback, ms) => { if (ms === 2500) sharedTick = callback; return 1; };
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'history' ? { available:true, cursor:3, lines:[{run:'r',cursor:1,ts:'2026-11-03T10:00:00Z',who:'person',kind:'said',text:'你好'}, {run:'r',cursor:3,ts:'2026-11-03T10:00:03Z',who:'pet',kind:'say',text:'我在'}] }
      : operation === 'activity' ? {available:true,cursor:motionState || 'c1',hasMore:false,sources:[],items:motionState ? [
        {id:`motion:${motionState}`,source:'events',position:motionState === 'started' ? '4' : '5',at:motionState === 'started' ? '2026-11-03T10:00:04Z' : '2026-11-03T10:00:05Z',role:'body',kind:'body-motion',summary:'跑步',state:motionState,actionId}
      ] : [
        {id:'a',source:'events',position:'2',at:'2026-11-03T10:00:02Z',role:'body',kind:'body-motion',summary:'身体动作反馈'},
        {id:'b',source:'tools',position:'1',at:'2026-11-03T10:00:01Z',role:'front',kind:'tool',summary:'工具已执行'}]} : {});
    Object.assign(dom.window, { lingxi:{call} }); dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8'));
    await tick(); await tick();
    const timeline=dom.window.document.querySelector('#conversation');
    expect(timeline.textContent).toContain('身体动作反馈');
    expect(timeline.textContent).not.toContain('工具已执行');
    expect(timeline.textContent.indexOf('你好')).toBeLessThan(timeline.textContent.indexOf('身体动作反馈'));
    expect(timeline.textContent.indexOf('身体动作反馈')).toBeLessThan(timeline.textContent.indexOf('我在'));
    dom.window.document.querySelector('#activity-toggle').click(); await tick();
    expect(timeline.textContent).toContain('工具已执行');
    expect(timeline.textContent.indexOf('你好')).toBeLessThan(timeline.textContent.indexOf('工具已执行'));
    expect(timeline.textContent.indexOf('工具已执行')).toBeLessThan(timeline.textContent.indexOf('身体动作反馈'));
    dom.window.document.querySelector('#activity-toggle').click(); await tick();
    expect(timeline.textContent).not.toContain('工具已执行');
    expect(timeline.textContent).toContain('身体动作反馈');
    const historyReads = call.mock.calls.filter(([op]) => ['history','historySince'].includes(op)).length;
    motionState = 'started'; sharedTick(); await tick(); await tick();
    expect(timeline.querySelector('[data-activity-id="motion:started"]').textContent).toContain('已启动');
    motionState = 'done'; sharedTick(); await tick(); await tick();
    const started = timeline.querySelector('[data-activity-id="motion:started"]');
    const done = timeline.querySelector('[data-activity-id="motion:done"]');
    expect(started.textContent).toContain(actionId);
    expect(done.textContent).toContain(actionId);
    expect(done.textContent).toContain('已完成');
    expect(call.mock.calls.filter(([op]) => ['history','historySince'].includes(op))).toHaveLength(historyReads);
    expect(call.mock.calls.filter(([op]) => op === 'activity').slice(-2).map(([, body]) => body.cursor)).toEqual(['c1','started']);
    expect(call.mock.calls.filter(([op]) => ['say','answer','outputReceipt'].includes(op))).toHaveLength(0);
    dom.window.close();
  });

  it('keeps entries without timestamps after dated chat instead of comparing unrelated cursors', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const call = async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'history' ? { available:true, cursor:1, lines:[{run:'r',cursor:1,ts:'2026-11-03T10:00:00Z',who:'person',kind:'said',text:'有时间的聊天'}] }
      : operation === 'activity' ? {available:true,cursor:'c1',hasMore:false,sources:[],items:[{id:'unknown-time',source:'tools',position:'1',at:null,kind:'tool',summary:'时间未知的过程'}]} : {};
    Object.assign(dom.window, { lingxi:{call} }); dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8'));
    await tick(); await tick();
    dom.window.document.querySelector('#activity-toggle').click(); await tick();
    const text = dom.window.document.querySelector('#conversation').textContent;
    expect(text.indexOf('有时间的聊天')).toBeLessThan(text.indexOf('时间未知的过程'));
    dom.window.close();
  });

  it('keeps previously seen activity and shows an explicit gap after source reset', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let reads = 0;
    const call = async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'activity' ? (++reads === 1
        ? { available:true, cursor:'c1', hasMore:false, sources:[{id:'agents',status:'available'}], items:[{id:'agent:old',source:'agents',position:'1',at:'2026-11-03T10:00:00Z',role:'coder',kind:'agent-state',summary:'raw old text',state:'running'}] }
        : { available:false, cursor:'c1', hasMore:false, reset:true, sources:[{id:'agents',status:'partial',detail:'cursor gap'}], items:[] }) : {};
    Object.assign(dom.window, { lingxi:{call} }); dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8'));
    await tick(); await tick();
    dom.window.document.querySelector('#activity-toggle').click(); await tick(); await tick();
    const timeline = dom.window.document.querySelector('#conversation').textContent;
    expect(timeline).toContain('处理中');
    expect(timeline).toContain('记录存在缺口，详细过程可能不完整');
    expect(dom.window.document.querySelector('#activity-status').textContent).toContain('过程记录已重置');
    dom.window.close();
  });

  it('opens a read-only activity view, retains partial-source notices, and escapes public summaries', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'activity' ? { available: true, cursor: 'c1', hasMore: false, sources: [{ id:'agent', status:'partial', detail:'部分记录' }], items: [{ id:'i1', source:'body', position:'1', at:'t', role:'身体', kind:'body-motion', summary:'<动作>', state:'完成' }] } : {});
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    dom.window.document.querySelector('#activity-toggle').click();
    await tick(); await tick();
    expect(dom.window.document.querySelector('#conversation').textContent).toContain('<动作>');
    expect(dom.window.document.querySelector('#activity-status').textContent).toContain('部分记录');
    expect(dom.window.document.querySelector('#conversation').querySelector('动作')).toBeNull();
    expect(call.mock.calls.filter(([op]) => ['say','answer','outputReceipt'].includes(op))).toHaveLength(0);
    dom.window.close();
  });

  it('renders only projected agent state/tool summaries when detailed flow is enabled', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const call = async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'activity' ? { available:true, cursor:'a1', hasMore:false, sources:[{id:'agents',status:'partial',detail:'covered since activation'}], items:[
        {id:'agent:1',source:'agents',position:'1',at:'2026-11-04T00:00:00Z',role:'coder',kind:'agent-state',summary:'private raw payload',state:'started',taskId:'task-1',provider:'codex',attempt:2,rawText:'private raw payload'},
        {id:'agent:2',source:'agents',position:'2',at:'2026-11-04T00:00:01Z',role:'coder',kind:'agent-tool',summary:'private tool title',state:'started',toolTitle:'private tool title'},
      ]} : {};
    Object.assign(dom.window, { lingxi:{call} }); dom.window.eval(readFileSync(resolve('workbench/renderer.js'),'utf8'));
    await tick(); await tick();
    const timeline = dom.window.document.querySelector('#conversation');
    expect(timeline.textContent).not.toContain('执行器已启动');
    dom.window.document.querySelector('#activity-toggle').click(); await tick();
    expect(timeline.textContent).toContain('代码助手');
    expect(timeline.textContent).toContain('后台状态');
    expect(timeline.textContent).toContain('已启动');
    expect(timeline.textContent).toContain('Codex');
    expect(timeline.textContent).toContain('第 2 次尝试');
    expect(timeline.textContent).toContain('代码助手调用已登记工具');
    expect(timeline.textContent).toContain('开始调用');
    expect(timeline.textContent).not.toContain('private');
    const sourceStatus = dom.window.document.querySelector('#activity-status').textContent;
    expect(sourceStatus).toContain('后台活动：已接入后台交办、返回和代码助手公开执行事件；记录覆盖可能不完整。');
    expect(sourceStatus).not.toContain('当前不可用');
    dom.window.close();
  });

  it('routes the custom window controls and loads older conversation without duplicating current rows', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const windowAction = vi.fn();
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'settings' ? { name: 'test', user: 'test' }
      : operation === 'history' ? { available: true, cursor: 81, lines: Array.from({length:80},(_,i)=>({run:'r',cursor:i+2,who:'person',kind:'said',text:i===79?'新消息':`已有${i}`})) }
      : operation === 'historySince' ? { available: true, cursor: 81, lines: [{ run: 'r', cursor: 1, who: 'person', kind: 'said', text: '旧消息' }, ...Array.from({length:80},(_,i)=>({run:'r',cursor:i+2,who:'person',kind:'said',text:i===79?'新消息':`已有${i}`}))] } : {});
    Object.assign(dom.window, { lingxi: { call, window: windowAction } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    for (const action of ['minimize', 'maximize', 'close']) dom.window.document.querySelector(`[data-window="${action}"]`).click();
    expect(windowAction.mock.calls.map(([action]) => action)).toEqual(['minimize', 'maximize', 'close']);
    const conversation = dom.window.document.querySelector('#conversation');
    expect(conversation.querySelector('#history-all')).toBeNull();
    Object.defineProperty(conversation, 'scrollHeight', { configurable:true, value:2000 });
    Object.defineProperty(conversation, 'clientHeight', { configurable:true, value:500 });
    conversation.scrollTop = 40; conversation.dispatchEvent(new dom.window.Event('scroll'));
    conversation.scrollTop = 0; conversation.dispatchEvent(new dom.window.Event('scroll'));
    await tick(); await tick();
    expect(call).toHaveBeenCalledWith('historySince', { after:0 });
    const text = dom.window.document.querySelector('#conversation').textContent;
    expect(text.indexOf('旧消息')).toBeLessThan(text.indexOf('新消息'));
    expect(text.match(/新消息/g)).toHaveLength(1);
    dom.window.close();
  });

  it('requires native window visibility even when Electron reports a visible document', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let nativeVisible = false;
    let changed;
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'outputs' ? { available: true, cursor: 1, outputs: [{ id: 'native:0', text: '窗口文字', kind: 'say', cursor: 1 }] }
        : operation === 'outputReceipt' ? { recorded: true } : {});
    Object.assign(dom.window, { lingxi: { call, visible: async () => nativeVisible, onVisibility: (listener) => { changed = listener; } } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    expect(call.mock.calls.filter(([operation]) => operation === 'outputReceipt')).toHaveLength(0);
    nativeVisible = true; changed(true);
    await tick(); await tick();
    expect(call.mock.calls.filter(([operation]) => operation === 'outputReceipt')).toEqual([['outputReceipt', { id: 'native:0' }]]);
    changed(true); await tick();
    expect(call.mock.calls.filter(([operation]) => operation === 'outputReceipt')).toHaveLength(1);
    dom.window.close();
  });
  it('uses the same chat submit path for Enter and clicking, preserving focus and a failed draft', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let attempts = 0;
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'say' ? { delivered: ++attempts > 1 } : {});
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    const input = dom.window.document.querySelector('#say');
    input.value = '失败保留'; input.focus();
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick(); await tick();
    expect(attempts).toBe(1);
    expect(input.value).toBe('失败保留');
    expect(dom.window.document.activeElement).toBe(input);
    dom.window.document.querySelector('#say-form button').click();
    await tick(); await tick();
    expect(call.mock.calls.filter(([operation]) => operation === 'say')).toEqual([
      ['say', { text: '失败保留' }], ['say', { text: '失败保留' }],
    ]);
    expect(input.value).toBe('');
    dom.window.close();
  });

  it('keeps an answer draft and its focus across polling and refresh; composition cannot submit it', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let poll;
    dom.window.setInterval = (callback, ms) => { if (ms === 1000) poll = callback; return 1; };
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? [{ id: 'q1', question: '喝什么', options: [] }]
      : operation === 'answer' ? { delivered: false } : {});
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    let input = dom.window.document.querySelector('[data-free-answer] input');
    input.value = '还在想'; input.focus(); input.setSelectionRange(2, 2);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    poll(); await tick(); await tick();
    expect(dom.window.document.querySelector('[data-free-answer] input')).toBe(input);
    dom.window.document.querySelector('#refresh').click(); await tick(); await tick();
    input = dom.window.document.querySelector('[data-free-answer] input');
    expect(input.value).toBe('还在想');
    expect(dom.window.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    input.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(call.mock.calls.filter(([operation]) => operation === 'answer')).toHaveLength(0);
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick(); await tick();
    expect(call).toHaveBeenCalledWith('answer', { question: '喝什么', text: '还在想', questionId: 'q1' });
    expect(input.value).toBe('还在想');
    dom.window.close();
  });

  it('does not acknowledge a hidden page and only shows processing reported by the host', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let poll;
    dom.window.setInterval = (callback, ms) => { if (ms === 1000) poll = callback; return 1; };
    let front;
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {}, front } : operation === 'asks' ? []
      : operation === 'outputs' ? { available: true, cursor: 1, outputs: [{ id: 'o:0', text: '已生成文字', kind: 'say', cursor: 1 }] }
        : operation === 'outputReceipt' ? { recorded: true } : {});
    Object.assign(dom.window, { lingxi: { call } });
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'hidden' });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    expect(dom.window.document.querySelector('#front-state').textContent).toBe('前台处理状态未知');
    expect(call.mock.calls.filter(([operation]) => operation === 'outputReceipt')).toHaveLength(0);
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await tick(); await tick();
    expect(call).toHaveBeenCalledWith('outputReceipt', { id: 'o:0' });
    front = { state: 'processing', inputCursors: [3] };
    poll(); await tick(); await tick();
    expect(dom.window.document.querySelector('#front-state').textContent).toBe('前台正在处理');
    front = { state: 'failed', inputCursors: [3], error: '<网络断开>' };
    poll(); await tick(); await tick();
    expect(dom.window.document.querySelector('#front-state').textContent).toBe('前台处理失败：<网络断开>');
    expect(dom.window.document.querySelector('#front-state').childElementCount).toBe(0);
    dom.window.close();
  });
  it('shows notes requiring review on failed and interrupted tasks as text', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'tasks' ? {
      open: [{ id: 't1', status: 'unknown', runnerId: 'legacy-v1', what: '中断', notesToReview: ['<b>不要解释成 HTML</b>'] }],
      done: [{ id: 't2', status: 'failed', runnerId: 'framework-v1', what: '失败', notesToReview: ['后来的要求'] }],
    } : operation === 'status' ? { body: {} } : operation === 'asks' ? [] : {} } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    dom.window.document.querySelector('[data-page="behind"]').click();
    await tick(); await tick();
    expect(dom.window.document.body.textContent).toContain('补充记录（处理情况待核对）');
    expect(dom.window.document.body.textContent).toContain('<b>不要解释成 HTML</b>');
    expect(dom.window.document.querySelector('b')).toBeNull();
    expect(dom.window.document.body.textContent).toContain('后来的要求');
    dom.window.close();
  });
  it('shows the persisted runner and current progress for background work', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'tasks' ? {
      open: [{ id: 't1', status: 'running', runnerId: 'framework-v1', what: '整理材料', progress: '正在读取案例' }], done: [],
    } : operation === 'status' ? { body: {} } : operation === 'asks' ? [] : {} } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    dom.window.document.querySelector('[data-page="behind"]').click();
    await tick();
    await tick();
    expect(dom.window.document.body.textContent).toContain('执行中');
    expect(dom.window.document.body.textContent).toContain('framework-v1');
    expect(dom.window.document.body.textContent).toContain('正在读取案例');
    dom.window.close();
  });

  it('requests cancellation without claiming the running task has already stopped', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let cancelRequested = false;
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? []
      : operation === 'tasks' ? { open: [{ id:'cancel-1', status:cancelRequested ? 'cancelling' : 'running', runnerId:'framework-v1', what:'临时整理' }], done:[] }
        : operation === 'cancelTask' ? (cancelRequested = true, { cancelling:true }) : {});
    Object.assign(dom.window, { lingxi:{ call }, confirm: vi.fn(() => true) });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    dom.window.document.querySelector('[data-page="behind"]').click();
    await tick(); await tick();
    dom.window.document.querySelector('[data-cancel="cancel-1"]').click();
    await tick(); await tick();
    expect(call).toHaveBeenCalledWith('cancelTask', { id:'cancel-1' });
    expect(dom.window.document.body.textContent).toContain('取消中');
    expect(dom.window.document.body.textContent).not.toContain('已取消');
    dom.window.close();
  });

  it('shows which task is waiting for a permission answer', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'tasks' ? {
      open: [{ id: 't1', status: 'running', runnerId: 'legacy-v1', what: '整理材料' }], done: [],
      permissions: [{ id: 'p1', taskId: 't1', state: 'pending' }],
    } : operation === 'status' ? { body: {} } : operation === 'asks' ? [] : {} } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    dom.window.document.querySelector('[data-page="behind"]').click();
    await tick(); await tick();
    expect(dom.window.document.body.textContent).toContain('等待权限答复');
    dom.window.close();
  });

  it('shows shared state and sends text through the bridge', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const call = vi.fn(async (operation) => {
      if (operation === 'status') return { name:'灵犀', feelingState:{summary:'精神不错'}, body: { connected: true }, model: { name: 'fixture', configured: true } };
      if (operation === 'asks') return [];
      if (operation === 'settings') return { name: '不应覆盖的设置名', user: '小王' };
      if (operation === 'say') return { delivered: true };
      throw new Error('unexpected operation');
    });
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    expect(dom.window.document.body.textContent).toContain('精神不错');
    expect(dom.window.document.body.textContent).toContain('灵犀 · 她称呼你：小王');
    expect(dom.window.document.body.textContent).toContain('模型：fixture · 凭据已设置或无需凭据');
    const input = dom.window.document.querySelector('#say');
    input.value = '在吗';
    dom.window.document.querySelector('#say-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(call).toHaveBeenCalledWith('say', { text: '在吗' });
    expect(dom.window.document.body.textContent).toContain('已接收，等待前台处理');
    dom.window.close();
  });

  it('shows recent shared conversation on the current page', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? [] : operation === 'settings' ? { name: 'test', user: 'test' } : operation === 'history' ? { available: true, lines: [{ who: 'person', kind: 'said', text: '你好' }, { who: 'pet', kind: 'say', text: '我在' }, { who: 'pet', kind: 'glance', text: '不属于对话的观察' }] } : {} } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    expect(dom.window.document.querySelector('.chat-heading h2')).toBeNull();
    expect(dom.window.document.body.textContent).toContain('你好');
    expect(dom.window.document.body.textContent).toContain('我在');
    expect(dom.window.document.body.textContent).not.toContain('不属于对话的观察');
    dom.window.close();
  });

  it('retries incremental history from the same cursor without replacing a draft', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let poll;
    dom.window.setInterval = (callback, ms) => { if (ms === 1000) poll = callback; return 1; };
    dom.window.clearInterval = () => {};
    let reads = 0;
    const call = vi.fn(async (operation) => {
      if (operation === 'status') return { body: {} };
      if (operation === 'asks') return [];
      if (operation === 'settings') return { name: 'test', user: 'test' };
      if (operation === 'history') return { available: true, cursor: 7, lines: [] };
      if (operation === 'historySince') {
        if (++reads === 1) throw new Error('offline');
        return { available: true, cursor: 8, lines: [{ who: 'pet', kind: 'say', text: '回复到了' }] };
      }
      throw new Error('unexpected operation');
    });
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    const input = dom.window.document.querySelector('#say');
    input.value = '正在写的草稿';
    poll(); await tick();
    poll(); await tick();
    expect(call.mock.calls.filter(([operation]) => operation === 'historySince')).toEqual([
      ['historySince', { after: 7 }], ['historySince', { after: 7 }],
    ]);
    expect(dom.window.document.querySelector('#say')).toBe(input);
    expect(input.value).toBe('正在写的草稿');
    expect(dom.window.document.querySelector('#conversation').textContent).toContain('回复到了');
    dom.window.close();
  });

  it('retries the initial history read after the host was unavailable', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let poll;
    dom.window.setInterval = (callback, ms) => { if (ms === 1000) poll = callback; return 1; };
    let historyReads = 0;
    Object.assign(dom.window, { lingxi: { call: async (operation) => {
      if (operation === 'status') return { body: {} };
      if (operation === 'asks') return [];
      if (operation === 'settings') return { name: 'test', user: 'test' };
      if (operation === 'history') {
        historyReads++;
        if (historyReads === 1) throw new Error('host starting');
        return { available: true, cursor: 3, lines: [{ who: 'person', kind: 'said', text: '恢复了' }] };
      }
      return {};
    } } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    expect(historyReads).toBe(1);
    const input = dom.window.document.querySelector('#say');
    input.value = '正在输入';
    poll(); await tick(); await tick();
    expect(historyReads).toBe(2);
    expect(dom.window.document.body.textContent).toContain('恢复了');
    expect(dom.window.document.querySelector('#say')).toBe(input);
    expect(input.value).toBe('正在输入');
    dom.window.close();
  });

  it('keeps unsent text when the front does not accept it', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? [] : { delivered: false } } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    const input = dom.window.document.querySelector('#say');
    input.value = '保留这句话';
    dom.window.document.querySelector('#say-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(input.value).toBe('保留这句话');
    expect(dom.window.document.body.textContent).toContain('没有送达');
    dom.window.close();
  });
  it('does not submit the same question twice while an answer is pending', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let finish;
    const call = vi.fn((operation) => operation === 'answer' ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(operation === 'status' ? { body: {} } : operation === 'asks' ? [{ question: '什么时候？', options: ['现在'] }] : { name: 'test', user: 'test' }));
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    const button = dom.window.document.querySelector('[data-answer]');
    button.click(); button.click();
    expect(call.mock.calls.filter(([operation]) => operation === 'answer')).toHaveLength(1);
    finish({ delivered: true });
    await tick(); await tick();
    dom.window.close();
  });

  it('does not submit while an input method is composing', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const call = vi.fn(async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? [] : operation === 'say' ? { delivered: true } : { name: 'test', user: 'test' });
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    const input = dom.window.document.querySelector('#say');
    const form = dom.window.document.querySelector('#say-form');
    input.value = '你好';
    input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(call.mock.calls.filter(([operation]) => operation === 'say')).toHaveLength(0);
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(call.mock.calls.filter(([operation]) => operation === 'say')).toHaveLength(1);
    dom.window.close();
  });

  it('does not double-submit or erase text edited while a send is pending', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let finish;
    const call = vi.fn((operation) => operation === 'say' ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(operation === 'status' ? { body: {} } : operation === 'asks' ? [] : { name: 'test', user: 'test' }));
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    const form = dom.window.document.querySelector('#say-form');
    const input = dom.window.document.querySelector('#say');
    input.value = '第一句';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(call.mock.calls.filter(([operation]) => operation === 'say')).toHaveLength(1);
    input.value = '继续写的内容';
    finish({ delivered: true });
    await tick();
    expect(input.value).toBe('继续写的内容');
    expect(form.querySelector('button').disabled).toBe(false);
    dom.window.close();
  });

  it('keeps a chat draft when switching pages and refreshing', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'status' ? { body: {} } : operation === 'asks' ? [] : operation === 'settings' ? { name: 'test', user: 'test' } : operation === 'history' ? { available: true, lines: [] } : operation === 'memory' ? { episodes: [] } : {} } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    const input = dom.window.document.querySelector('#say');
    input.value = '还没发出的草稿';
    dom.window.document.querySelector('[data-page="memory"]').click();
    await tick(); await tick();
    dom.window.document.querySelector('[data-page="now"]').click();
    await tick(); await tick();
    expect(dom.window.document.querySelector('#say').value).toBe('还没发出的草稿');
    dom.window.close();
  });

  it('keeps new text and blocks a duplicate while a send crosses a refresh', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let finish;
    const call = vi.fn((operation) => operation === 'say' ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(operation === 'status' ? { body: {} } : operation === 'asks' ? [] : { name: 'test', user: 'test' }));
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    dom.window.document.querySelector('#say').value = '第一句';
    dom.window.document.querySelector('#say-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    dom.window.document.querySelector('#refresh').click();
    await tick();
    const input = dom.window.document.querySelector('#say');
    expect(dom.window.document.querySelector('#say-form button').disabled).toBe(true);
    input.value = '下一句';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    finish({ delivered: true });
    await tick();
    expect(input.value).toBe('下一句');
    expect(dom.window.document.querySelector('#say-result').textContent).toContain('已接收');
    expect(dom.window.document.querySelector('#say-form button').disabled).toBe(false);
    expect(call.mock.calls.filter(([operation]) => operation === 'say')).toHaveLength(1);
    dom.window.close();
  });

  it('shows a send failure after switching away and back', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    let fail;
    const call = (operation) => operation === 'say' ? new Promise((_, reject) => { fail = reject; })
      : Promise.resolve(operation === 'status' ? { body: {} } : operation === 'asks' ? [] : operation === 'history' ? { available: true, lines: [] } : operation === 'memory' ? { episodes: [] } : { name: 'test', user: 'test' });
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick();
    dom.window.document.querySelector('#say').value = '保留原话';
    dom.window.document.querySelector('#say-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    dom.window.document.querySelector('[data-page="memory"]').click();
    await tick();
    fail(new Error('连接中断'));
    await tick();
    dom.window.document.querySelector('[data-page="now"]').click();
    await tick(); await tick();
    expect(dom.window.document.querySelector('#say').value).toBe('保留原话');
    expect(dom.window.document.querySelector('#say-result').textContent).toContain('连接中断');
    dom.window.close();
  });

  it('preserves a task note while the background page refreshes', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const call = vi.fn(async (operation) => operation === 'tasks' ? { open: [{ id: 't1', status: 'running', runnerId: 'legacy-v1', what: '整理' }], done: [] } : operation === 'status' ? { body: {} } : operation === 'asks' ? [] : { name: 'test', user: 'test' });
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    dom.window.document.querySelector('[data-page="behind"]').click();
    await tick(); await tick();
    dom.window.document.querySelector('form[data-note] input').value = '补充要求';
    dom.window.document.querySelector('#refresh').click();
    await tick(); await tick();
    expect(dom.window.document.querySelector('form[data-note] input').value).toBe('补充要求');
    dom.window.close();
  });

  it('shows the reason for an unknown task before asking whether to redo it', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'tasks' ? { open: [{ id: 't1', status: 'unknown', runnerId: 'framework-v1', what: '整理', result: '连接中断，结果未知' }], done: [] } : operation === 'status' ? { body: {} } : operation === 'asks' ? [] : { name: 'test', user: 'test' } } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    dom.window.document.querySelector('[data-page="behind"]').click();
    await tick(); await tick();
    expect(dom.window.document.body.textContent).toContain('连接中断，结果未知');
    dom.window.close();
  });

  it('shows the recorded code provider and makes missing legacy identity visible', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    Object.assign(dom.window, { lingxi: { call: async (operation) => operation === 'tasks' ? { open: [
      { id: 't1', to: 'coder', status: 'unknown', runnerId: 'legacy-v1', codeProvider: 'dsh', what: '任务一' },
      { id: 't2', to: 'coder', status: 'unknown', runnerId: 'legacy-v1', codeProvider: null, what: '任务二' },
    ], done: [] } : operation === 'status' ? { body: {} } : operation === 'asks' ? [] : { name: 'test', user: 'test' } } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    dom.window.document.querySelector('[data-page="behind"]').click();
    await tick(); await tick();
    expect(dom.window.document.body.textContent).toContain('执行器：dsh');
    expect(dom.window.document.body.textContent).toContain('执行器未记录');
    dom.window.close();
  });

  it('shows where the action library lives, reloads it, and saves the avoidance switch', async () => {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    const runtime = { model: { provider: 'fixture', protocol: 'responses', apiUrl: 'http://127.0.0.1/v1', model: 'fixture', keyConfigured: false },
      executor: { provider: null, sandboxMode: null, networkAccess: null, taskDirectory: null, description: '无代码执行器' },
      apply: { model: { message: '' }, executor: { message: '' } } };
    const workbench = {
      profile: { name: '灵犀', user: '你', constitution: '' },
      conversation: { language: 'zh', context: { maxTokens: 128000, softRatio: .85, keepRatio: .25, firstTurn: false }, rounds: { soft: 20, hard: 40 }, apply: {} },
      behavior: { avoidance: true, apply: '保存后立即生效。' },
      actions: [], actionsApply: '',
      actionLibrary: '[]', actionLibraryFile: 'D:/lingxi/actions.json', libraryProblems: ['old: no clips'],
    };
    const call = vi.fn(async (operation) => operation === 'status' ? { name: '灵犀', front: { state: 'idle' }, body: {} }
      : operation === 'settings' ? { name: '灵犀', user: '你' }
      : operation === 'runtimeSettings' ? runtime
      : operation === 'workbenchSettings' ? workbench
      : operation === 'saveWorkbenchSettings' ? workbench
      : operation === 'asks' ? [] : {});
    Object.assign(dom.window, { lingxi: { call } });
    dom.window.eval(readFileSync(resolve('workbench/renderer.js'), 'utf8'));
    await tick(); await tick();
    dom.window.document.querySelector('[data-page="settings"]').click();
    await tick(); await tick();
    let content = dom.window.document.querySelector('#content');
    expect(content.textContent).toContain('前台和后台角色都用这一个模型');
    expect(content.querySelector('[data-library-file]').value).toBe('D:/lingxi/actions.json');
    expect(content.textContent).toContain('old: no clips');
    // There is no reload button: reading the page re-reads the file.
    expect(content.querySelector('[data-library-reload]')).toBeNull();

    // switching the avoidance setting still goes through the same save call
    content = dom.window.document.querySelector('#content');
    const avoidance = content.querySelector('[name="avoidance"]');
    avoidance.value = 'off';
    avoidance.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    content.querySelector('#runtime-settings-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
    expect(call.mock.calls.some(([operation, payload]) => operation === 'saveWorkbenchSettings' && payload?.behavior?.avoidance === false)).toBe(true);
    dom.window.close();
  });
});
