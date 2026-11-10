/* First-run setup for the standalone workbench. It only uses existing settings and say APIs. */
'use strict';
(function () {

const text = (value) => String(value ?? '');
const escapeHtml = (value) => text(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function onboardingReady(snapshot = {}) {
  const model = snapshot.model || {};
  const profile = snapshot.profile || {};
  const connected = model.configured === true;
  return connected && Boolean(profile.name?.trim() && profile.user?.trim() && profile.constitution?.trim());
}

function mountOnboarding(root, options = {}) {
  if (!root || typeof root.appendChild !== 'function') throw new Error('onboarding root is required');
  for (const name of ['saveModel', 'saveProfile', 'say']) if (typeof options[name] !== 'function') throw new Error(`${name} is required`);
  const state = { step: 0, model: { ...(options.model || {}) }, profile: { ...(options.profile || {}) }, packLabel: options.packLabel || '当前启动配置', sent: false };
  const finish = () => { root.replaceChildren(); options.onComplete?.(); };
  const draw = () => {
    root.innerHTML = `<section class="onboarding" aria-labelledby="onboarding-title"><div class="onboarding-progress">第 ${state.step + 1} / 3 步</div><h1 id="onboarding-title">先把灵犀准备好</h1><p class="onboarding-lead">只需几步就能开始正常聊天。以后可以在“设置”里重新打开。</p><form class="onboarding-card">${stepHtml()}<p class="onboarding-error" role="alert"></p></form></section>`;
    root.querySelector('form')?.addEventListener('submit', submit);
    root.querySelector('[data-onboarding-back]')?.addEventListener('click', () => { state.step = Math.max(0, state.step - 1); draw(); });
    root.querySelector('[data-onboarding-skip]')?.addEventListener('click', finish);
  };
  const stepHtml = () => {
    if (state.step === 0) return `<h2>连接聊天模型</h2><p>填写已有服务的地址、模型名和密钥。密钥保存在本机，保存后不回显。</p><label>API 地址<input name="apiUrl" type="url" required value="${escapeHtml(state.model.apiUrl)}" autocomplete="url"></label><label>模型<input name="model" required value="${escapeHtml(state.model.model)}" autocomplete="off"></label><label>API Key<input name="apiKey" type="password" ${state.model.keyConfigured ? 'placeholder="已配置；留空保持不变"' : 'required'} autocomplete="new-password"></label><button class="send" type="submit">保存并继续</button>`;
    if (state.step === 1) return `<h2>确认形象和人设</h2><p>沿用当前显示的形象。更换形象需要配置本地形象包；本页暂不提供切换入口。</p><label>她的名字<input name="name" maxlength="40" required value="${escapeHtml(state.profile.name)}"></label><label>她怎么称呼你<input name="user" maxlength="40" required value="${escapeHtml(state.profile.user)}"></label><label>角色设定<textarea name="constitution" maxlength="12000" rows="8" required>${escapeHtml(state.profile.constitution)}</textarea></label><div class="onboarding-actions"><button type="button" data-onboarding-back>上一步</button><button class="send" type="submit">保存并继续</button></div>`;
    return `<h2>试着和她说一句</h2><p>有了模型连接后，可以先聊一句，之后再慢慢完善人设。发出后回到对话页，那里会显示实际回复；当前引导不会自动生成或下载形象素材。</p><label>消息<input name="text" maxlength="2000" required placeholder="你好，认识一下"></label><div class="onboarding-actions"><button type="button" data-onboarding-back>上一步</button><button class="send" type="submit">发送并打开对话</button></div><p>外部代码执行器可以以后再配，不影响聊天和人设配置。</p><button type="button" data-onboarding-skip>稍后再试</button>`;
  };
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      if (state.step === 0) {
        const result = await options.saveModel({ apiUrl: text(data.apiUrl), model: text(data.model), apiKey: text(data.apiKey) });
        state.model = { ...state.model, ...result, apiUrl: text(data.apiUrl), model: text(data.model), keyConfigured: Boolean(result?.keyConfigured || state.model.keyConfigured || data.apiKey) };
        state.step = 1;
      } else if (state.step === 1) {
        await options.saveProfile({ name: text(data.name), user: text(data.user), constitution: text(data.constitution) });
        state.profile = { name: text(data.name), user: text(data.user), constitution: text(data.constitution) };
        state.step = 2;
      } else {
        await options.say(text(data.text)); state.sent = true; finish(); return;
      }
      draw();
    } catch (error) {
      const note = form.querySelector('.onboarding-error'); note.textContent = `未完成：${error?.message || error}`;
      if (button) button.disabled = false;
    }
  }
  draw();
  return { close: finish, get step() { return state.step; } };
}

if (typeof window !== 'undefined') window.LingxiOnboarding = { onboardingReady, mountOnboarding };
})();
