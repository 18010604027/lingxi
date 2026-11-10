'use strict';
const root = document.querySelector('#root');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { page: 'now', tasks: null, history: null, sayDraft: '', sayResult: '', sending: false, runtimeSettings: null, workbenchSettings: null, settingsDraft: null, settingsDirty: false, settingsSaving: false, settingsMessage: '', taskFeedback: {}, actionDirty: new Set(), onboardingChecked: false, onboardingActive: false, onboardingView: null };
const answering = new Set();
const answerDrafts = new Map();
const activityState = { open: false, cursor: undefined, items: new Map(), sources: [], loading: false, error: '', front: null };
let pendingQuestions = [];
const outputParts = new Map();
const outputReceipts = new Set();
const receiptRequests = new Set();
let outputObserver = null;
const activityExpanded = new Set();
let receiptQueue = Promise.resolve();
let outputCursor = 0;
let pendingSettingsNavigation = null;
let outputRequest = false;
let askSignature = '';
let historyCursor = null;
let historyLines = [];
let historyFullyLoaded = false;
let historyLoading = false;
let chatAwayFromTop = false;
let historyPoll = null;
let historyRequest = false;
const TIMELINE_PAGE_SIZE = 80;
let timelineVisibleCount = TIMELINE_PAGE_SIZE;
let timelineHasOlder = false;
const timelineRowMarkup = new WeakMap();
root.innerHTML = `<div class="shell"><div class="window-bar"><span class="window-title">灵犀</span><div class="window-actions"><button type="button" data-window="minimize" aria-label="最小化" title="最小化">─</button><button type="button" data-window="maximize" aria-label="最大化或还原" title="最大化或还原">□</button><button type="button" data-window="close" aria-label="关闭窗口" title="关闭窗口">×</button></div></div><header class="topbar"><div class="identity"><i class="orb"></i><div><div class="brand" id="identity-name">灵犀</div><div class="subtitle" id="identity-state">连接中</div></div></div><nav aria-label="页面"><button data-page="now" aria-current="page">此刻</button><button data-page="behind">后台</button><button data-page="memory">记忆</button><button data-page="settings">设置</button></nav><div class="top-actions"><span class="connection" id="connection">连接中</span><button id="refresh" class="icon-button" aria-label="刷新" title="刷新">↻</button></div></header><main><div class="page-heading"><div><div class="eyebrow">灵犀工作台</div><h1 id="title">此刻</h1><p class="lead">和桌宠共用同一份状态。</p></div><div class="page-mark" aria-hidden="true"></div></div><div id="content"></div></main></div>`;
const $ = (id) => document.getElementById(id);
const call = (operation, body) => window.lingxi.call(operation, body);
function row(label, text, action = '') { return `<div class="row"><span class="tag">${esc(label)}</span><p>${esc(text)}</p>${action}</div>`; }
function reviewNotes(task) { return task.notesToReview?.length ? `\n补充记录（处理情况待核对）：\n${task.notesToReview.join('\n')}` : ''; }
const taskStateText = { queued: '排队中', running: '执行中', cancelling: '取消中', submitted: '已提交', unknown: '需要处理', done: '已完成', succeeded: '已完成', cancelled: '已取消', failed: '失败' };
function taskCard(task, permissions) {
  const statusLabel = taskStateText[task.status] || task.status;
  const detail = `${task.result || ''}${permissions ? '\n等待权限答复，请在对话中查看请求。' : ''}${task.progress ? `\n最近进展：${task.progress}` : ''}${task.status === 'unknown' && task.result ? `\n中断原因：${task.result}` : ''}${reviewNotes(task)}`;
  const runner = task.to === 'coder' ? (task.codeProvider ? `执行器：${task.codeProvider}` : task.status === 'unknown' ? '执行器未记录' : '') : '';
  const openForNotes = ['queued', 'running', 'cancelling', 'submitted'].includes(task.status);
  const action = task.status === 'unknown'
    ? `<div class="task-actions"><button data-recover="${esc(task.id)}" data-action="resume" aria-label="重做任务；可能重复已经发生的动作" title="从头重新执行，可能重复已经发生的动作">重做</button><button class="danger" data-recover="${esc(task.id)}" data-action="cancel" aria-label="放弃重做；不会撤销已经发生的动作" title="不再重做，不会撤销已经发生的动作">放弃</button></div>`
    : openForNotes ? `<div class="task-actions"><form data-note="${esc(task.id)}"><input aria-label="补充给任务的话" placeholder="补充一句"><button>补充</button></form><button class="danger" data-cancel="${esc(task.id)}">取消</button></div>` : '';
  return `<article class="task-card task-${esc(task.status)}"><div class="task-rail"><span class="task-dot" aria-hidden="true"></span><span class="task-status">${esc(statusLabel)}</span></div><div class="task-main"><div class="task-title">${esc(task.what)}</div><div class="task-meta">${esc(task.runnerId)}${runner ? ` · ${esc(runner)}` : ''}</div><p class="task-detail">${esc(detail)}</p>${action}<span class="task-feedback" data-task-feedback aria-live="polite">${esc(state.taskFeedback[task.id] || '')}</span></div></article>`;
}
function frontText(front) {
  return front?.state === 'processing' ? '前台正在处理' : front?.state === 'failed' ? `前台处理失败：${front.error || '原因未知'}` : front?.state === 'idle' ? '前台空闲' : '前台处理状态未知';
}
function applySummary(apply = {}) {
  return [apply.model?.message && `聊天模型：${apply.model.message}`, apply.executor?.message && `代码执行器：${apply.executor.message}`, apply.message]
    .filter(Boolean).join(' ');
}
function updateSharedIdentity(status) {
  $('identity-name').textContent = status?.name || '灵犀';
  const parts = [status?.body?.connected ? '身体在线' : '身体离线'];
  if (status?.paused) parts.push('前台暂停');
  if (status?.front?.state === 'processing') parts.push('正在处理');
  else if (status?.front?.state === 'failed') parts.push('处理失败');
  else if (status?.front?.state === 'idle') parts.push('前台空闲');
  $('identity-state').textContent = parts.join(' · ');
}
function feelingText(value) {
  const labels = {
    tired: '有些疲倦', 'a bit tired': '稍微有些累', rested: '精神不错',
    'wary, having just been moved away by hand': '刚被挪动，仍有些警觉', 'a little unsettled': '稍有不安',
    'wanting company': '想有人陪伴', restless: '有些无聊，想活动', curious: '有些好奇',
    cheerful: '心情愉快', low: '情绪偏低', 'it is late': '夜深了',
  };
  if (typeof value !== 'string' || !value.trim()) return '状态暂缺';
  return value.split(';').map((part) => { const item = part.trim(); return labels[item] || (/[a-z]/i.test(item) ? '状态已更新' : item); }).join(' · ');
}
function librarySection(file, problems) {
  const rows = Array.isArray(problems) && problems.length
    ? `<p class="settings-note error">载入时跳过了 ${problems.length} 条：${esc(problems.slice(0, 6).join('；'))}${problems.length > 6 ? '…' : ''}</p>`
    : '';
  return `<section class="settings-group"><div class="settings-group-heading"><div><h2>动作库</h2><p>动作、片段、说明和标签都在这个文件里；系统读取时会校验，坏条目会列出来。</p></div></div><div class="settings-fields"><label class="settings-wide">文件<input data-library-file value="${esc(file || '')}" readonly></label></div>${rows}</section>`;
}
function renderRuntimeSettings(settings) {
  state.runtimeSettings = settings;
  const model = settings.model || {};
  const executor = settings.executor || {};
  const draft = state.settingsDraft || {};
  const wb = state.workbenchSettings || {};
  const profile = wb.profile || {};
  const conversation = wb.conversation || {};
  const context = conversation.context || {};
  const rounds = conversation.rounds || {};
  const codex = executor.provider === 'codex';
  const sandboxMode = draft.sandboxMode || (['read-only', 'workspace-write'].includes(executor.sandboxMode) ? executor.sandboxMode : 'workspace-write');
  const networkAccess = draft.networkAccess || (['deny', 'allow'].includes(executor.networkAccess) ? executor.networkAccess : 'deny');
  const protocol = draft.protocol ?? model.protocol ?? 'responses';
  const applyMessage = applySummary(settings.apply);
  const sandboxControls = codex
    ? `<div class="settings-fields"><label>任务目录<input name="taskDirectory" value="${esc(executor.taskDirectory || '')}" readonly></label><label>文件范围<select name="sandboxMode"><option value="read-only" ${sandboxMode === 'read-only' ? 'selected' : ''}>只读</option><option value="workspace-write" ${sandboxMode === 'workspace-write' ? 'selected' : ''}>任务目录可写</option></select></label><label>联网<select name="networkAccess"><option value="deny" ${networkAccess === 'deny' ? 'selected' : ''}>禁止</option><option value="allow" ${networkAccess === 'allow' && sandboxMode !== 'read-only' ? 'selected' : ''} ${sandboxMode === 'read-only' ? 'disabled' : ''}>允许</option></select></label></div><p class="settings-note">Codex CLI 会把这些选择传入任务参数。写入限制在任务目录内；读取范围仍由 Codex CLI 的沙箱策略决定，不由任务目录字段限制。${sandboxMode === 'read-only' ? '只读模式不开放写入和联网。' : ''}</p>`
    : `<div class="settings-fields"><label>任务目录<input value="${esc(executor.taskDirectory || '由当前执行器决定')}" readonly></label></div><p class="settings-note">${esc(executor.description || '当前执行器未提供可配置的沙箱选项。')}</p>`;
  $('content').innerHTML = `<section class="settings-page"><form id="runtime-settings-form" class="settings-form"><section class="settings-group"><div class="settings-group-heading"><div><h2>角色与称呼</h2><p>这里的角色设定会进入灵犀的角色前缀。</p></div></div><div class="settings-fields"><label>她的名字<input name="name" maxlength="40" value="${esc(draft.name ?? profile.name ?? '')}" required></label><label>她怎么称呼你<input name="user" maxlength="40" value="${esc(draft.user ?? profile.user ?? '')}" required></label><label class="settings-wide">角色设定<textarea name="constitution" maxlength="12000" rows="12">${esc(draft.constitution ?? profile.constitution ?? '')}</textarea></label></div><p class="settings-note">保存后用于后续对话，并在工作区保留版本。</p></section><section class="settings-group"><div class="settings-group-heading"><div><h2>表达与对话</h2><p>调整语言、上下文和单次对话轮次。</p></div></div><div class="settings-fields"><label>界面与回复语言<select name="language"><option value="zh" ${(draft.language ?? conversation.language) === 'zh' ? 'selected' : ''}>简体中文</option><option value="en" ${(draft.language ?? conversation.language) === 'en' ? 'selected' : ''}>English</option></select></label><label>上下文上限（tokens）<input name="maxTokens" type="number" min="8000" max="2000000" step="1000" value="${esc(draft.maxTokens ?? context.maxTokens ?? 128000)}"></label><label>开始整理的阈值<input name="softRatio" type="number" min="0.1" max="1" step="0.05" value="${esc(draft.softRatio ?? context.softRatio ?? .85)}"></label><label>整理后保留比例<input name="keepRatio" type="number" min="0.05" max="0.9" step="0.05" value="${esc(draft.keepRatio ?? context.keepRatio ?? .25)}"></label><label>提醒首轮对话<select name="firstTurn"><option value="false" ${(draft.firstTurn ?? context.firstTurn) ? '' : 'selected'}>关闭</option><option value="true" ${(draft.firstTurn ?? context.firstTurn) ? 'selected' : ''}>开启</option></select></label><label>软轮次上限<input name="roundsSoft" type="number" min="1" max="1000" value="${esc(draft.roundsSoft ?? rounds.soft ?? 20)}"></label><label>硬轮次上限<input name="roundsHard" type="number" min="1" max="2000" value="${esc(draft.roundsHard ?? rounds.hard ?? 40)}"></label></div><p class="settings-note">上下文设置保存后生效；轮次上限需要重启灵犀后生效。</p></section><section class="settings-group"><div class="settings-group-heading"><div><h2>前台模型</h2><p>控制灵犀自己的聊天连接。</p></div><span class="settings-status">${model.keyConfigured ? '密钥已设置' : '尚未设置密钥'}</span></div><div class="settings-fields"><label>提供方<input value="${esc(model.provider || '当前配置')}" readonly></label><label>接口协议<select name="protocol"><option value="responses" ${protocol === 'responses' ? 'selected' : ''}>Responses</option><option value="chat" ${protocol === 'chat' ? 'selected' : ''}>Chat Completions</option></select></label><label class="settings-wide">API 地址<input name="apiUrl" value="${esc(draft.apiUrl ?? model.apiUrl ?? '')}" autocomplete="url" required></label><label class="settings-wide">模型<input name="model" value="${esc(draft.model ?? model.model ?? '')}" autocomplete="off" required></label><label class="settings-wide">API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${model.keyConfigured ? '已配置；留空保持不变' : '输入 API Key'}"></label></div><p class="settings-note">密钥不会回显。留空保存时保留已存密钥。</p></section><section class="settings-group"><div class="settings-group-heading"><div><h2>后台执行</h2><p>此设置只影响代码任务，不影响前台聊天。</p></div><span class="settings-status">${esc(executor.provider || '未选择执行器')}</span></div>${sandboxControls}</section><div class="settings-footer"><span class="settings-note" id="settings-message" aria-live="polite">${esc(state.settingsMessage || applyMessage || (state.settingsDirty ? '有尚未保存的更改。' : '所有更改已保存。'))}</span><button type="button" id="open-onboarding">打开首次设置</button><button type="button" id="settings-discard">放弃更改</button><button class="send" type="submit" ${state.settingsSaving || !state.settingsDirty ? 'disabled' : ''}>${state.settingsSaving ? '保存中…' : state.settingsDirty ? '保存更改' : '已保存'}</button></div></form></section>`;
  const settingsForm = $('runtime-settings-form');
  const footer = settingsForm?.querySelector('.settings-footer');
  if (settingsForm && footer) {
    const behavior = wb.behavior || {};
    const avoidance = draft.avoidance !== undefined ? draft.avoidance === 'on' : behavior.avoidance !== false;
    const groups = settingsForm.querySelectorAll(':scope > .settings-group');
    groups[2]?.insertAdjacentHTML('beforeend', '<p class="settings-note">前台和后台角色都用这一个模型；只有代码执行器是单独接入的 harness。</p>');
    groups[3]?.insertAdjacentHTML('beforeend', '<p class="settings-note">代码执行器只负责后台的代码任务，和聊天模型分开配置。</p>');
    footer.insertAdjacentHTML('beforebegin', `<section class="settings-group"><div class="settings-group-heading"><div><h2>行为</h2><p>她要不要绕开屏幕上的窗口。</p></div></div><div class="settings-fields"><label>避障<select name="avoidance"><option value="on" ${avoidance ? 'selected' : ''}>开启，绕开窗口</option><option value="off" ${avoidance ? '' : 'selected'}>关闭，直接走过</option></select></label></div><p class="settings-note">${esc(behavior.apply || '保存后立即生效。')}关掉以后她会从窗口上直接穿过去，不再绕路。</p></section>` + librarySection(wb.actionLibraryFile, wb.libraryProblems));
  }
}
const activityNames = { events:'身体与输出', tools:'工具', agents:'后台活动', reasoning:'思考摘要', body:'身体', front:'前台', output:'输出', control:'控制中心', coder:'代码助手', 'body-motion':'身体动作', 'body-interaction':'身体互动', 'output-receipt':'输出回执', tool:'工具调用', 'agent-state':'后台状态', 'agent-tool':'后台工具', 'agent-message':'后台消息', 'activity-gap':'记录缺口' };
const agentProviderNames = { builtin:'内置执行器', dsh:'DSH', codex:'Codex', claude:'Claude' };
const activityStates = { submitted:'已提交', arrived:'已到达', started:'已启动', queued:'等待中', running:'处理中', cancelling:'取消中', moved:'拖动中', dropped:'已放下', paused:'已暂停', resumed:'已继续', done:'已完成', completed:'已完成', succeeded:'成功', finished:'已结束', presented:'已呈现', wall:'遇阻', interrupted:'已打断', replaced:'已替换', unknown:'状态未知', returned:'已返回', failed:'失败', cancelled:'已取消', tool_started:'开始调用', tool_updated:'调用中', tool_finished:'调用结束' };
const agentToolStates = { started:'开始调用', updated:'调用中', finished:'调用结束' };
const activityName = (value) => activityNames[value] || value || '';
const activityStatus = (value, kind) => (kind === 'agent-tool' ? agentToolStates[value] : undefined) || activityStates[value] || value || '';
function activitySourceStatus(source) {
  const name = activityName(source.id);
  if (source.id === 'reasoning') return '公开推理摘要：没有已接入来源，不展示私有思维。';
  if (source.id === 'agents' && source.status === 'partial') return `${name}：已接入后台交办、返回和代码助手公开执行事件；记录覆盖可能不完整。`;
  if (source.id === 'events' && source.status === 'partial' && source.detail?.startsWith('Existing event history')) return `${name}：部分旧记录可能无法读取。`;
  return `${name}：${source.status === 'partial' ? '部分记录' : '当前不可用'}${source.detail ? `（${source.detail}）` : ''}`;
}
function activitySummary(item) {
  const actor = activityName(item.role || '后台执行器');
  if (item.kind === 'front-state') return '前台处理状态';
  if (item.kind === 'agent-handoff') return item.summary;
  if (item.kind === 'agent-return') return item.summary;
  if (item.kind === 'agent-state') return '执行状态';
  if (item.kind === 'agent-tool') return `${actor}调用已登记工具`;
  if (item.kind === 'agent-message') return '后台发布了一条消息';
  if (item.kind === 'tool') return `${item.summary} · ${activityStatus(item.state, item.kind)}`;
  return item.summary || item.kind;
}
// Compare our generated markup, not Chromium's normalized serialization.
// Boolean attributes and whitespace serialize differently and otherwise cause
// every polling pass to destroy and rebuild an unchanged timeline.
const conversationMarkup = new WeakMap();
function observeOutputs(target) {
  outputObserver?.disconnect();
  outputObserver = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting && document.visibilityState === 'visible') void presentOutput(entry.target.dataset.outputId); }, { root: target, threshold: 0.01 });
  target.querySelectorAll('[data-output-id]').forEach((element) => outputObserver.observe(element));
}
function renderConversation(forcePresentation = false) {
  const target = $('conversation');
  if (!target) return;
  if (!target.dataset.historyScrollBound) {
    target.dataset.historyScrollBound = 'true';
    target.addEventListener('scroll', () => {
      if (target.scrollTop > 32) chatAwayFromTop = true;
      else if (chatAwayFromTop && (timelineHasOlder || !historyFullyLoaded && historyLines.length >= 80)) void loadOlderHistory();
    });
  }
  const lines = historyLines.filter((line) => !line.outputId || !outputParts.has(line.outputId)).filter((line) => line.who === 'person' ? ['said', 'answered'].includes(line.kind) : line.who === 'pet' && ['say', 'ask'].includes(line.kind));
  const recordedAskIds = new Set(lines.filter((line) => line.who === 'pet' && line.kind === 'ask').map((line) => line.messageId));
  for (const ask of pendingQuestions) if (!recordedAskIds.has(ask.id)) {
    lines.push({ who: 'pet', kind: 'ask', text: ask.question, messageId: ask.id, source: 'pending-ask' });
  }
  lines.push(...[...outputParts.values()].map((part) => ({ ...part, who: 'pet', outputId: part.id })));
  lines.push(...[...activityState.items.values()].filter((item) => item.kind === 'body-motion' || activityState.open).map((item) => ({ ...item, activity: true, ts: item.at, cursor: item.source === 'events' ? Number(item.position) || 0 : 0 })));
  if (activityState.open && activityState.front?.updatedAt) lines.push({ id: `front-state:${activityState.front.updatedAt}:${activityState.front.state}`, kind: 'front-state', summary: '前台处理状态', state: activityState.front.state, source: 'front', role: 'front', at: activityState.front.updatedAt, ts: activityState.front.updatedAt, position: 'snapshot', inputCursors: activityState.front.inputCursors, detail: activityState.front.error || (activityState.front.inputCursors?.length ? `对应输入批次：${activityState.front.inputCursors.join('、')}` : ''), activity: true });
  lines.sort((a, b) => {
    const aTime = Date.parse(a.ts || ''), bTime = Date.parse(b.ts || '');
    const aKnown = Number.isFinite(aTime), bKnown = Number.isFinite(bTime);
    // Timestamps order the merged timeline. Unknown timestamps stay at the end;
    // source-local positions and ids only break ties, never imply cross-source causality.
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && bKnown && aTime !== bTime) return aTime - bTime;
    const aSource = String(a.source || (a.activity ? 'activity' : a.who === 'person' ? 'conversation-person' : 'conversation-pet'));
    const bSource = String(b.source || (b.activity ? 'activity' : b.who === 'person' ? 'conversation-person' : 'conversation-pet'));
    return aSource.localeCompare(bSource)
      || Number(a.position ?? a.cursor ?? a.index ?? 0) - Number(b.position ?? b.cursor ?? b.index ?? 0)
      || String(a.id || '').localeCompare(String(b.id || ''));
  });
  timelineHasOlder = lines.length > timelineVisibleCount;
  const visibleLines = lines.slice(-timelineVisibleCount);
  const visible = [];
  for (let i = 0; i < visibleLines.length; i += 1) {
    const line = visibleLines[i];
    if (activityState.open && i > 0) {
      const before = Date.parse(visibleLines[i - 1].ts || ''), after = Date.parse(line.ts || '');
      const gap = after - before;
      if (Number.isFinite(before) && Number.isFinite(after) && gap > 5 * 60_000) {
        const minutes = Math.round(gap / 60_000);
        visible.push({ timeGap: true, id: `time-gap:${visibleLines[i - 1].id}:${line.id}`, minutes, from: visibleLines[i - 1].ts, to: line.ts });
      }
    }
    visible.push(line);
  }
  const previousScroll = target.scrollTop;
  const atEnd = target.scrollHeight - previousScroll - target.clientHeight < 48;
  target.querySelectorAll('details[data-activity-id]').forEach((entry) => { if (entry.open) activityExpanded.add(entry.dataset.activityId); else activityExpanded.delete(entry.dataset.activityId); });
  const focusedActivity = document.activeElement?.closest?.('details[data-activity-id]');
  const focusedActivityId = focusedActivity?.dataset.activityId;
  const focusedAnswer = document.activeElement?.closest?.('form[data-free-answer]') ? {
    key: document.activeElement.closest('form[data-free-answer]').dataset.questionId || document.activeElement.closest('form[data-free-answer]').dataset.freeAnswer,
    selection: [document.activeElement.selectionStart, document.activeElement.selectionEnd],
  } : null;
  target.querySelectorAll('form[data-free-answer]').forEach((form) => answerDrafts.set(form.dataset.questionId || form.dataset.freeAnswer, form.querySelector('input').value));
  const historyLoad = timelineHasOlder || !historyFullyLoaded && historyLines.length >= 80 ? `<button type="button" class="history-load" ${historyLoading ? 'disabled' : ''}>${historyLoading ? '正在加载更早对话…' : esc(state.historyLoadError || '向上滚动加载更早对话')}</button>` : '';
  const markup = (visible.length || historyLoad) ? `${historyLoad}${visible.map((line) => line.timeGap
    ? `<div class="timeline-gap" role="separator"><span>相隔 ${line.minutes} 分钟</span><span>${esc(line.from)} — ${esc(line.to)}</span></div>`
    : line.activity
    ? `<details class="activity-item timeline-event" data-activity-id="${esc(line.id)}" ${activityExpanded.has(line.id) ? 'open' : ''}><summary><span class="tag">${line.kind === 'body-motion' ? '动作' : line.kind === 'body-interaction' ? '互动' : esc(activityName(line.role || line.source))}</span><span>${esc(activitySummary(line))}</span><span class="muted">${esc(activityStatus(line.state, line.kind))}</span></summary><div class="activity-detail">${esc(activityName(line.kind))} · ${esc(activityName(line.source))}${agentProviderNames[line.provider] ? ` · ${agentProviderNames[line.provider]}` : ''}${Number.isSafeInteger(line.attempt) && line.attempt > 0 ? ` · 第 ${line.attempt} 次尝试` : ''}${line.at ? ` · ${esc(line.at)}` : ''}${line.taskId ? ` · 任务 ${esc(line.taskId)}` : ''}${line.callId ? ` · 调用 ${esc(line.callId)}` : ''}${line.actionId ? ` · 动作 ${esc(line.actionId)}` : ''}${line.interactionId ? ` · 互动 ${esc(line.interactionId)}` : ''}${Number.isFinite(line.x) ? ` · 横向 ${Math.round(line.x * 100)}%` : ''}${Number.isFinite(line.from) ? ` · 起点 ${Math.round(line.from * 100)}%` : ''}${Number.isFinite(line.y) ? ` · 纵向 ${Math.round(line.y)}px` : ''}${line.detail || line.text ? `<div class="activity-raw-detail">${esc(line.detail || line.text)}</div>` : ''}</div></details>`
    : (() => {
      const ask = line.who === 'pet' && line.kind === 'ask' ? pendingQuestions.find((question) => question.id === line.messageId) : null;
      const controls = ask ? `<div class="ask-replies">${(ask.options || []).map((option) => `<button type="button" data-answer="${esc(ask.question)}" data-question-id="${esc(ask.id)}" data-text="${esc(option)}">${esc(option)}</button>`).join('')}<form data-free-answer="${esc(ask.question)}" data-question-id="${esc(ask.id)}"><input aria-label="回答：${esc(ask.question)}" maxlength="2000" placeholder="在这里回答"><button>回复</button></form></div>` : '';
      return `<div class="chat-message ${line.who === 'person' ? 'from-person' : 'from-pet'}"${line.outputId ? ` data-output-id="${esc(line.outputId)}"` : ''}>${row(line.who === 'pet' ? '灵犀' : '你', line.text, controls)}</div>`;
    })()).join('')}` : '<div class="muted">还没有对话，写下第一句话吧。</div>';
  const changed = conversationMarkup.get(target) !== markup;
  if (!changed) {
    if (forcePresentation && typeof IntersectionObserver === 'function') observeOutputs(target);
    if (typeof IntersectionObserver !== 'function' && document.visibilityState === 'visible') {
      for (const line of visible) if (line.outputId) void presentOutput(line.outputId);
    }
    return;
  }
  outputObserver?.disconnect();
  const added = [];
  if (changed) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const keys = [ ...(historyLoad ? ['history-load'] : []), ...visible.map(line => String(line.id || line.outputId || line.messageId || `${line.run || ''}:${line.cursor}:${line.who}`)) ];
    const existing = new Map([...target.children].map(el => [el.dataset.timelineKey, el]));
    const retained = new Set();
    let position = target.firstElementChild;
    for (const [index, fresh] of [...template.content.children].entries()) {
      const key = keys[index] || 'empty';
      const signature = fresh.outerHTML;
      const prior = existing.get(key);
      const node = prior && timelineRowMarkup.get(prior) === signature ? prior : fresh;
      node.dataset.timelineKey = key;
      timelineRowMarkup.set(node, signature);
      retained.add(node);
      if (node === position) position = position.nextElementSibling;
      else target.insertBefore(node, position);
      if (node === fresh) added.push(node);
    }
    for (const node of [...target.children]) if (!retained.has(node)) node.remove();
    conversationMarkup.set(target, markup);
  }
  if (changed) {
    added.filter(entry => entry.matches('details[data-activity-id]')).forEach((entry) => entry.addEventListener('toggle', () => { if (entry.open) activityExpanded.add(entry.dataset.activityId); else activityExpanded.delete(entry.dataset.activityId); }));
    added.forEach(bindAnswers);
    added.find(entry => entry.matches('.history-load'))?.addEventListener('click', async (event) => {
      event.preventDefault();
      await loadOlderHistory();
    });
    if (focusedAnswer) for (const form of target.querySelectorAll('form[data-free-answer]')) {
      if ((form.dataset.questionId || form.dataset.freeAnswer) === focusedAnswer.key) {
        const input = form.querySelector('input'); input.focus(); input.setSelectionRange(...focusedAnswer.selection);
      }
    }
  }
  if (focusedActivityId) [...target.querySelectorAll('details[data-activity-id]')].find((entry) => entry.dataset.activityId === focusedActivityId)?.querySelector('summary')?.focus({ preventScroll: true });
  if (typeof IntersectionObserver === 'function') {
    observeOutputs(target);
  }
  target.scrollTop = atEnd ? target.scrollHeight : previousScroll;
  // A receipt means this page inserted the text while visible, never that the person read it.
  if (typeof IntersectionObserver !== 'function' && document.visibilityState === 'visible') for (const line of visible) if (line.outputId) void presentOutput(line.outputId);
}
async function loadOlderHistory() {
  const target = $('conversation');
  if (!target || historyLoading || (!timelineHasOlder && historyFullyLoaded)) return;
  historyLoading = true;
  const oldHeight = target.scrollHeight;
  const oldTop = target.scrollTop;
  renderConversation();
  try {
    if (timelineHasOlder) {
      timelineVisibleCount += TIMELINE_PAGE_SIZE;
      return;
    }
    const history = await call('historySince', { after: 0 });
    if (!history?.available || !Array.isArray(history.lines)) throw new Error('历史暂时不可用');
    const merged = new Map();
    for (const line of [...history.lines, ...historyLines]) merged.set(`${line.run}:${line.cursor}`, line);
    historyLines = [...merged.values()].sort((a, b) => (a.cursor || 0) - (b.cursor || 0));
    historyFullyLoaded = true;
    state.historyLoadError = '';
  } catch (error) {
    state.historyLoadError = error.message;
  } finally {
    historyLoading = false;
    renderConversation();
    if (target === $('conversation')) target.scrollTop = Math.max(0, target.scrollHeight - oldHeight + oldTop);
  }
}
function presentOutput(id) {
  if (outputReceipts.has(id) || receiptRequests.has(id)) return;
  receiptRequests.add(id);
  receiptQueue = receiptQueue.then(async () => {
    try {
      if (state.page !== 'now' || document.visibilityState !== 'visible') return;
      // Electron can report a visible document before its BrowserWindow has ever been shown.
      if (window.lingxi.visible && !await window.lingxi.visible()) return;
      if ((await call('outputReceipt', { id }))?.recorded) outputReceipts.add(id);
    }
    catch { /* A lost response is safe to retry by the same output id. */ }
    finally { receiptRequests.delete(id); }
  });
}
function applyOutputs(update) {
  if (!update?.available || !Array.isArray(update.outputs) || !Number.isSafeInteger(update.cursor)) return;
  if (update.reset) { outputParts.clear(); outputReceipts.clear(); }
  for (const part of update.outputs) outputParts.set(part.id, part);
  outputCursor = update.cursor;
}
async function updateOutputs() {
  if (state.page !== 'now' || outputRequest) return;
  outputRequest = true;
  const generation = refreshGeneration;
  try {
    const [update, asks, status] = await Promise.all([call('outputs', { after: outputCursor }).catch(() => null), call('asks').catch(() => null), call('status').catch(() => null)]);
    if (state.page !== 'now' || generation !== refreshGeneration) return;
    activityState.front = status?.front || null;
    applyOutputs(update);
    renderConversation();
    renderAsks(asks);
    if ($('front-state') && status) $('front-state').textContent = frontText(status.front);
    void loadActivity();
  } catch { /* Keep the committed cursor and drafts during reconnect. */ }
  finally { outputRequest = false; }
}
function renderActivity() {
  const target = $('activity-status');
  if (target) target.textContent = activityState.open ? (activityState.error || activityState.sources.filter((source) => source.status !== 'available').map(activitySourceStatus).join(' · ')) : '';
  if ($('conversation')) renderConversation();
}
async function loadActivity() {
  if (state.page !== 'now' || activityState.loading) return;
  activityState.loading = true; activityState.error = ''; renderActivity();
  try {
    let more;
    do {
      const previous = activityState.cursor;
      const page = await call('activity', previous === undefined ? {} : { cursor: previous });
      if (page?.reset) {
        const resetCursor = typeof page.cursor === 'string' ? page.cursor : previous || 'unknown';
        activityState.items.set(`gap:${resetCursor}`, { id:`gap:${resetCursor}`, source:'events', position:'', at:null, role:'system', kind:'activity-gap', summary:'记录存在缺口，详细过程可能不完整', state:'partial' });
        activityState.sources = Array.isArray(page.sources) ? page.sources : activityState.sources;
        if (!page.available) { activityState.cursor = undefined; throw new Error('过程记录已重置，请重试'); }
      }
      if (!page?.available || !Array.isArray(page.items) || typeof page.cursor !== 'string') throw new Error('过程记录暂时不可用');
      for (const item of page.items) if (typeof item.id === 'string') activityState.items.set(item.id, item);
      activityState.cursor = page.cursor;
      activityState.sources = Array.isArray(page.sources) ? page.sources : [];
      more = page.hasMore === true;
      if (more && page.cursor === previous) throw new Error('过程记录游标未前进，请重试');
    } while (more && state.page === 'now');
  } catch (error) { activityState.error = error.message; }
  finally { activityState.loading = false; renderActivity(); }
}
function renderAsks(asks, force = false) {
  if (!Array.isArray(asks)) return;
  const signature = JSON.stringify(asks);
  if (!force && signature === askSignature) return;
  askSignature = signature;
  pendingQuestions = asks;
  renderConversation();
}
async function updateConversation() {
  if (state.page !== 'now' || historyRequest) return;
  if (historyCursor === null) {
    // The host may still be starting (or the memory projection may be temporarily unavailable).
    historyRequest = true;
    try {
      if (!$('conversation')) { await refresh(); return; }
      const generation = refreshGeneration;
      const history = await call('history');
      if (state.page !== 'now' || historyCursor !== null || generation !== refreshGeneration) return;
      if (history?.available && Number.isSafeInteger(history.cursor) && Array.isArray(history.lines)) {
        historyCursor = history.cursor;
        historyLines = history.lines;
        renderConversation();
      }
    } catch { /* Retry without replacing the input. */ }
    finally { historyRequest = false; }
    return;
  }
  const after = historyCursor;
  historyRequest = true;
  try {
    const update = await call('historySince', { after });
    if (state.page !== 'now' || historyCursor !== after) return;
    if (update.reset) { void refresh(); return; }
    if (update.available && Number.isSafeInteger(update.cursor) && update.cursor >= after && Array.isArray(update.lines)) {
      historyCursor = update.cursor;
      historyLines = historyLines.concat(update.lines);
      renderConversation();
    }
  } catch { /* Retry from the same cursor on the next refresh. */ }
  finally { historyRequest = false; }
}
let refreshGeneration = 0;
let behindPoll = null;
function updateBehindPoll() {
  if (behindPoll) { clearInterval(behindPoll); behindPoll = null; }
  if (state.page === 'behind') behindPoll = setInterval(() => void refresh(), 5000);
  if (historyPoll) { clearInterval(historyPoll); historyPoll = null; }
  if (state.page === 'now' && document.visibilityState === 'visible') historyPoll = setInterval(() => { void updateConversation(); void updateOutputs(); }, 1000);
}
let sharedStateRequest = false;
async function updateSharedState() {
  if (sharedStateRequest) return;
  sharedStateRequest = true;
  try {
    const [status, settings] = await Promise.all([call('status'), call('settings')]);
    activityState.front = status?.front || null;
    updateSharedIdentity(status);
    if (state.page === 'now') {
      if ($('front-state')) $('front-state').textContent = frontText(status.front);
      if ($('content')?.querySelector('.hero strong')) $('content').querySelector('.hero strong').textContent = status.feelingState?.summary || feelingText(status.feeling);
      renderConversation();
      void loadActivity();
    }
  } catch { /* Keep the last actual state while the local API reconnects. */ }
  finally { sharedStateRequest = false; }
}
function editingTaskNote() {
  return [...document.querySelectorAll('form[data-note] input')].some((input) => input.value !== '' || input === document.activeElement);
}
async function refresh() {
  if (state.onboardingActive) return;
  const generation = ++refreshGeneration;
  const currentSay = $('say');
  if (currentSay) state.sayDraft = currentSay.value;
  document.querySelectorAll('form[data-free-answer]').forEach((form) => answerDrafts.set(form.dataset.questionId || form.dataset.freeAnswer, form.querySelector('input').value));
  const focusedSay = currentSay === document.activeElement;
  const selection = currentSay ? [currentSay.selectionStart, currentSay.selectionEnd] : null;
  const activeAnswer = document.activeElement?.closest('form[data-free-answer]');
  const focusedAnswer = activeAnswer ? { key: activeAnswer.dataset.questionId || activeAnswer.dataset.freeAnswer,
    selection: [document.activeElement.selectionStart, document.activeElement.selectionEnd] } : null;
  try {
    const [sharedStatus, sharedSettings] = await Promise.all([call('status'), call('settings')]);
    if (generation !== refreshGeneration) return;
    activityState.front = sharedStatus.front || null;
    updateSharedIdentity(sharedStatus);
    if (!state.onboardingChecked && window.LingxiOnboarding) {
      const [runtimeSettings, workbenchSettings] = await Promise.all([call('runtimeSettings'), call('workbenchSettings')]);
      if (generation !== refreshGeneration) return;
      state.runtimeSettings = runtimeSettings;
      state.workbenchSettings = workbenchSettings;
      state.onboardingChecked = true;
      if (window.LingxiOnboarding && !window.LingxiOnboarding.onboardingReady({
        model: { configured: sharedStatus.model?.configured === true },
        profile: workbenchSettings.profile,
      })) {
        mountOnboarding();
        return;
      }
    }
    if (state.page === 'now') {
      const [asks, history, outputs] = await Promise.all([call('asks'), call('history').catch(() => ({ available: false, lines: [] })), call('outputs', { after: 0 }).catch(() => null)]);
      if (generation !== refreshGeneration) return;
      if ($('say')) state.sayDraft = $('say').value;
      historyLines = history?.available && Array.isArray(history.lines) ? history.lines : [];
      historyFullyLoaded = historyLines.length < 80;
      historyCursor = history?.available && Number.isSafeInteger(history.cursor) ? history.cursor : null;
      applyOutputs(outputs);
      const modelLine = sharedStatus.model ? `模型：${esc(sharedStatus.model.name)} · ${sharedStatus.model.configured ? '凭据已设置或无需凭据' : '缺少凭据或模型配置'}` : '';
      $('content').innerHTML = `<section class="hero"><strong>${esc(sharedStatus.feelingState?.summary || feelingText(sharedStatus.feeling))}</strong><span class="muted">${sharedStatus.body?.connected ? '身体在线' : '身体离线'}${sharedStatus.paused ? ' · 前台暂停' : ''}</span><span class="muted" id="front-state">${esc(frontText(sharedStatus.front))}</span>${modelLine ? `<span class="muted">${modelLine}</span>` : ''}</section><section class="section chat-section"><div class="chat-heading"><div class="chat-tools"><button type="button" id="activity-toggle" class="activity-switch" role="switch" aria-checked="${activityState.open}" aria-label="详细过程"><span class="switch-track"><span class="switch-thumb"></span></span><span>详细过程</span></button></div></div><div id="activity-status" class="muted activity-status"></div><div id="conversation" class="chat-history"></div><form id="say-form" class="chat-compose"><input id="say" maxlength="2000" aria-label="输入消息" placeholder="写下你想告诉她的事"><button class="send">发送</button></form><div class="muted" id="say-result" aria-live="polite"></div></section>`;
      renderAsks(asks, true);
      renderConversation();
      const identity = document.createElement('div');
      identity.className = 'muted';
      identity.textContent = `${sharedStatus.name || '灵犀'} · 她称呼你：${sharedSettings.user}`;
      $('content').querySelector('.hero').append(identity);
      $('say').value = state.sayDraft;
      $('say-result').textContent = state.sayResult;
      $('say-form').querySelector('button').disabled = state.sending;
      if (focusedSay) { $('say').focus(); $('say').setSelectionRange(...selection); }
      if (focusedAnswer) for (const form of document.querySelectorAll('form[data-free-answer]')) {
        if ((form.dataset.questionId || form.dataset.freeAnswer) === focusedAnswer.key) {
          const input = form.querySelector('input'); input.focus(); input.setSelectionRange(...focusedAnswer.selection);
        }
      }
    } else if (state.page === 'behind') {
      const tasks = await call('tasks'); state.tasks = tasks;
      if (generation !== refreshGeneration) return;
      // Do not replace a form the person is typing in, including text entered while the request was in flight.
      if (editingTaskNote()) return;
      const isolation = tasks?.codeAgentIsolation;
      const isolationLine = isolation ? `<section class="section"><h2>代码执行器</h2><p>${esc(isolation.provider)} · 沙箱${isolation.reported?.sandbox ? '已声明' : '未声明'}，网络策略${isolation.reported?.networkPolicy ? '已声明' : '未声明'}；实际隔离尚未验证。</p></section>` : '';
      const openTasks = tasks?.open || [];
      const unknownTasks = openTasks.filter((task) => task.status === 'unknown');
      const activeTasks = openTasks.filter((task) => task.status !== 'unknown');
      const activeTaskCards = activeTasks.length ? activeTasks.map((task) => taskCard(task, tasks?.permissions?.some((permission) => permission.taskId === task.id))).join('') : '<div class="muted">暂时没有。</div>';
      const unknownTaskCards = unknownTasks.map((task) => taskCard(task, false)).join('');
      const doneTasks = tasks?.done?.length ? tasks.done.map((task) => taskCard({ ...task, status: task.status || 'done' }, false)).join('') : '<div class="muted">还没有结果。</div>';
      const unknownSection = unknownTasks.length ? `<section class="section task-section task-unknown-section"><div class="task-section-heading"><div><span class="eyebrow">结果未确认</span><h2>需要处理</h2></div><span class="task-count-unknown">${unknownTasks.length} 项</span></div><p class="task-uncertain-note">系统无法确认任务是否完成。重做会从头执行，可能重复已经发生的动作；放弃重做不会撤销已发生的动作。</p><div class="task-list">${unknownTaskCards}</div></section>` : '';
      $('content').innerHTML = `${isolationLine}<section class="section task-section"><div class="task-section-heading"><div><span class="eyebrow">当前队列</span><h2>正在做</h2></div><span class="muted">${activeTasks.length} 项</span></div><div class="task-list">${activeTaskCards}</div></section>${unknownSection}<section class="section task-section task-completed"><div class="task-section-heading"><div><span class="eyebrow">最近完成</span><h2>刚做完</h2></div><span class="muted">${tasks?.done?.length || 0} 项</span></div><div class="task-list">${doneTasks}</div></section>`;
    } else if (state.page === 'memory') {
      const history = await call('history'); state.history = history;
      const memory = await call('memory');
      if (generation !== refreshGeneration) return;
      $('content').innerHTML = `<section class="section"><h2>最近交互</h2><p class="muted">打开页面或点击刷新时更新。发言在任一页面确认实际呈现后记录。</p>${!history?.available ? '<div class="muted">记忆暂时不可用。</div>' : history.lines?.length ? history.lines.slice(-30).reverse().map((line) => row(line.who === 'pet' ? '灵犀' : '你', line.text)).join('') : '<div class="muted">没有历史。</div>'}</section><section class="section"><h2>话题</h2>${memory?.episodes?.length ? memory.episodes.slice(-20).reverse().map((episode) => row(episode.title, episode.summary)).join('') : '<div class="muted">还没有话题卡。</div>'}</section>`;
    } else {
      const [settings, workbench] = await Promise.all([call('runtimeSettings'), call('workbenchSettings')]);
      if (generation !== refreshGeneration) return;
      state.runtimeSettings = settings;
      state.workbenchSettings = workbench;
      renderRuntimeSettings(settings);
      bindRuntimeSettings();
    }
    $('connection').textContent = '刚刚更新';
    bindActions();
  } catch (error) { if (generation === refreshGeneration) $('connection').textContent = `接口不可用：${error.message}`; }
}
function mountOnboarding() {
  const onboarding = window.LingxiOnboarding;
  if (!onboarding || !state.runtimeSettings || !state.workbenchSettings) return;
  state.onboardingActive = true;
  state.onboardingView = onboarding.mountOnboarding($('content'), {
    model: state.runtimeSettings.model,
    profile: state.workbenchSettings.profile,
    saveModel: async (model) => (await call('saveRuntimeSettings', { model }))?.model || {},
    saveProfile: async (profile) => call('saveWorkbenchSettings', { profile }),
    say: async (text) => call('say', { text }),
    onComplete: () => {
      state.onboardingActive = false;
      state.onboardingView = null;
      navigatePage('now');
    },
  });
}
function bindRuntimeSettings() {
  const form = $('runtime-settings-form');
  if (!form) return;
  const rememberDraft = (event) => {
    const saveButton = form.querySelector('button[type="submit"]');
    if (saveButton && !state.settingsSaving) { saveButton.disabled = false; saveButton.textContent = '保存更改'; }
    if (event.target.name === 'apiKey') {
      state.settingsDirty = true;
      const message = $('settings-message');
      if (message) message.textContent = '有尚未保存的更改。';
      return;
    }
    state.settingsDraft = { ...(state.settingsDraft || {}), [event.target.name]: event.target.value };
    state.settingsDirty = true;
    const message = $('settings-message');
    if (message) message.textContent = '有尚未保存的更改。';
  };
  form.addEventListener('input', rememberDraft);
  form.addEventListener('change', (event) => {
    rememberDraft(event);
    if (event.target.name === 'sandboxMode' && event.target.value === 'read-only') {
      const network = form.elements.namedItem('networkAccess');
      if (network) {
        network.value = 'deny';
        network.disabled = true;
        state.settingsDraft = { ...(state.settingsDraft || {}), networkAccess: 'deny' };
      }
    } else if (event.target.name === 'sandboxMode') {
      const network = form.elements.namedItem('networkAccess');
      if (network) network.disabled = false;
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.settingsSaving) return;
    const data = new FormData(form);
    state.settingsSaving = true;
    state.settingsMessage = '';
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = '保存中…';
    try {
      const change = { model: { protocol: String(data.get('protocol') || ''), apiUrl: String(data.get('apiUrl') || ''), model: String(data.get('model') || ''), apiKey: String(data.get('apiKey') || '') } };
      if (state.runtimeSettings?.executor?.provider === 'codex') {
        change.executor = { provider: 'codex', sandboxMode: String(data.get('sandboxMode') || 'workspace-write'), networkAccess: String(data.get('networkAccess') || 'deny') };
      }
      const avoidance = String(data.get('avoidance') || '');
      const result = await call('saveRuntimeSettings', change);
      await call('saveWorkbenchSettings', { profile: { name: String(data.get('name') || ''), user: String(data.get('user') || ''), constitution: String(data.get('constitution') || '') },
        ...(avoidance === 'on' || avoidance === 'off' ? { behavior: { avoidance: avoidance === 'on' } } : {}),
        conversation: { language: String(data.get('language') || 'zh'), context: { maxTokens: Number(data.get('maxTokens')), softRatio: Number(data.get('softRatio')), keepRatio: Number(data.get('keepRatio')), firstTurn: String(data.get('firstTurn')) === 'true' }, rounds: { soft: Number(data.get('roundsSoft')), hard: Number(data.get('roundsHard')) } } });
      state.runtimeSettings = result;
      state.settingsDraft = null;
      state.settingsDirty = false;
      state.actionDirty.clear();
      state.settingsMessage = applySummary(result.apply) || '设置已保存。';
      await refresh();
      $('connection').textContent = '设置已保存';
      if (pendingSettingsNavigation) { const next = pendingSettingsNavigation; pendingSettingsNavigation = null; navigatePage(next); }
    } catch (error) {
      pendingSettingsNavigation = null;
      state.settingsMessage = `保存失败：${error.message}`;
      submit.textContent = '重试保存';
      $('settings-message').textContent = state.settingsMessage;
    } finally {
      state.settingsSaving = false;
      const button = $('runtime-settings-form')?.querySelector('button[type="submit"]');
      if (button) {
        button.disabled = !state.settingsDirty;
        button.textContent = state.settingsDirty ? '重试保存' : '已保存';
      }
    }
  });
  $('settings-discard')?.addEventListener('click', () => { state.settingsDraft = null; state.settingsDirty = false; state.actionDirty.clear(); state.settingsMessage = ''; void refresh(); });
  $('open-onboarding')?.addEventListener('click', () => {
    if (state.settingsDirty) {
      state.settingsMessage = '先保存或放弃更改，再打开首次设置。';
      $('settings-message').textContent = state.settingsMessage;
      return;
    }
    mountOnboarding();
  });
}
function bindActions() {
  $('activity-toggle')?.addEventListener('click', (event) => { activityState.open = !activityState.open; event.currentTarget.setAttribute('aria-checked', String(activityState.open)); renderActivity(); if (activityState.open) void loadActivity(); });
  $('activity-toggle')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.repeat) return;
    event.preventDefault();
    event.currentTarget.click();
  });
  renderActivity();
  void loadActivity();
  const sayInput = $('say');
  let composing = false;
  sayInput?.addEventListener('compositionstart', () => { composing = true; });
  sayInput?.addEventListener('compositionend', () => { composing = false; });
  sayInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!composing && !event.isComposing && event.keyCode !== 229) $('say-form').requestSubmit();
  });
  sayInput?.addEventListener('input', (event) => { state.sayDraft = event.currentTarget.value; });
  $('say-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (composing) return;
    const form = event.currentTarget;
    const input = form.querySelector('#say');
    const button = form.querySelector('button');
    const sent = input.value;
    if (!sent.trim() || state.sending) return;
    state.sayDraft = sent;
    state.sayResult = '';
    if ($('say-result')) $('say-result').textContent = '';
    state.sending = true;
    button.disabled = true;
    try {
      const result = await call('say', { text: sent });
      if (!result.delivered) throw new Error('没有送达，请检查前台连接');
      if (state.sayDraft === sent) {
        state.sayDraft = '';
        if ($('say')?.value === sent) $('say').value = '';
        if (input.value === sent) input.value = '';
      }
      state.sayResult = '已接收，等待前台处理。';
      void updateConversation();
    } catch (error) { state.sayResult = error.message; }
    finally { state.sending = false; button.disabled = false; const current = $('say-form')?.querySelector('button'); if (current) current.disabled = false; if ($('say-result')) $('say-result').textContent = state.sayResult; if (state.page === 'now' && [input, button, document.body].includes(document.activeElement)) $('say')?.focus(); }
  });
  const act = async (operation, data, key) => { try { const result = await call(operation, data); if (key && !result[key]) throw new Error('操作未生效，请刷新后重试'); await refresh(); } catch (error) { $('connection').textContent = `操作失败：${error.message}`; } };
  document.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => {
    if (!window.confirm('确定取消这项任务吗？')) return;
    void act('cancelTask', { id: button.dataset.cancel }, 'cancelling');
  }));
  document.querySelectorAll('form[data-note]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.querySelector('input'); const button = form.querySelector('button'); const note = input.value;
    if (!note.trim() || button.disabled) return;
    button.disabled = true;
    try {
      const result = await call('noteTask', { id: form.dataset.note, note });
      if (!result.updated) throw new Error('操作未生效，请刷新后重试');
      if (input.value === note) { input.value = ''; input.blur(); }
      state.taskFeedback[form.dataset.note] = '补充已发送';
      await refresh();
    } catch (error) { state.taskFeedback[form.dataset.note] = `补充失败：${error.message}`; const feedback = form.querySelector('[data-task-feedback]'); if (feedback) feedback.textContent = state.taskFeedback[form.dataset.note]; }
    finally { button.disabled = false; }
  }));
  document.querySelectorAll('[data-recover]').forEach((button) => button.addEventListener('click', () => { if (button.dataset.action === 'resume' && !window.confirm('重做会从头开始，可能重复之前的动作。确定重做吗？')) return; void act('recoverTask', { id: button.dataset.recover, action: button.dataset.action }, 'recovered'); }));
}
function bindAnswers(target) {
  const answer = async (question, text, questionId) => {
    const key = questionId || question;
    if (!text.trim() || answering.has(key)) return;
    answering.add(key);
    try {
      const result = await call('answer', { question, text, ...(questionId ? { questionId } : {}) });
      if (!result.delivered) throw new Error('回答未送达，可重试');
      if (answerDrafts.get(key) === text) answerDrafts.delete(key);
      await refresh();
    } catch (error) { $('connection').textContent = `操作失败：${error.message}`; }
    finally { answering.delete(key); }
  };
  target.querySelectorAll('[data-answer]').forEach((button) => button.addEventListener('click', () => void answer(button.dataset.answer, button.dataset.text, button.dataset.questionId)));
  target.querySelectorAll('form[data-free-answer]').forEach((form) => {
    const input = form.querySelector('input');
    const key = form.dataset.questionId || form.dataset.freeAnswer;
    input.value = answerDrafts.get(key) || '';
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('input', () => answerDrafts.set(key, input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!composing && !event.isComposing && event.keyCode !== 229) form.requestSubmit();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (composing) return;
      answerDrafts.set(key, input.value);
      void answer(form.dataset.freeAnswer, input.value, form.dataset.questionId);
    });
  });
}
document.addEventListener('visibilitychange', () => {
  if (state.page === 'now' && document.visibilityState === 'visible') {
    updateBehindPoll();
    void updateConversation();
    void updateOutputs();
    renderConversation(true);
  } else updateBehindPoll();
});
window.lingxi.onVisibility?.((visible) => {
  if (visible && state.page === 'now') {
    updateBehindPoll();
    void updateConversation();
    void updateOutputs();
    renderConversation(true);
  } else if (!visible) updateBehindPoll();
});
document.querySelectorAll('[data-window]').forEach((button) => button.addEventListener('click', () => void window.lingxi.window?.(button.dataset.window)));
function navigatePage(page) {
  if (state.onboardingActive) return;
  state.page = page;
  updateBehindPoll();
  document.querySelectorAll('[data-page]').forEach((item) => item.setAttribute('aria-current', item.dataset.page === page ? 'page' : 'false'));
  $('title').textContent = { now: '此刻', behind: '后台', memory: '记忆', settings: '设置' }[page];
  void refresh();
}
function confirmSettingsLeave(page) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-leave-overlay';
  overlay.innerHTML = `<section class="settings-leave-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-leave-title"><h2 id="settings-leave-title">设置还没保存</h2><p>离开前要怎么处理这些更改？</p><div><button type="button" data-choice="stay">继续编辑</button><button type="button" data-choice="discard">放弃更改</button><button type="button" class="send" data-choice="save">保存并离开</button></div></section>`;
  document.body.append(overlay);
  overlay.querySelector('[data-choice="stay"]').focus();
  overlay.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-choice]')?.dataset.choice;
    if (!choice) return;
    overlay.remove();
    if (choice === 'discard') { state.settingsDraft = null; state.settingsDirty = false; state.settingsMessage = ''; navigatePage(page); }
    if (choice === 'save') {
      const form = $('runtime-settings-form');
      if (!form?.reportValidity()) return;
      pendingSettingsNavigation = page;
      form.requestSubmit();
    }
  });
}
document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => {
  const page = button.dataset.page;
  if (page === state.page) return;
  if (state.page === 'settings' && state.settingsDirty) { confirmSettingsLeave(page); return; }
  navigatePage(page);
}));
$('refresh').addEventListener('click', () => void refresh());
updateBehindPoll();
setInterval(() => void updateSharedState(), 2500);
void refresh();
