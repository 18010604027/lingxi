import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('workbench/onboarding.js'), 'utf8');
const fresh = () => {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', url: 'file:///workbench/index.html' });
  dom.window.eval(source);
  return dom;
};

describe('workbench first-run onboarding', () => {
  it('requires an actually configured model and complete profile to skip', () => {
    const dom = fresh();
    expect(dom.window.LingxiOnboarding.onboardingReady({ model: { configured: false }, profile: { name: '她', user: '我', constitution: '设定' } })).toBe(false);
    expect(dom.window.LingxiOnboarding.onboardingReady({ model: { configured: true }, profile: { name: '她', user: '我', constitution: '设定' } })).toBe(true);
  });

  it('walks model, profile and real say steps without inventing pack selection', async () => {
    const dom = fresh(); const root = dom.window.document.querySelector('#root');
    const savedModels = []; const savedProfiles = []; const said = [];
    const flow = dom.window.LingxiOnboarding.mountOnboarding(root, {
      model: { apiUrl: 'http://local/v1', model: 'chat', keyConfigured: false }, profile: {},
      saveModel: async (value) => { savedModels.push(value); return { keyConfigured: true }; },
      saveProfile: async (value) => { savedProfiles.push(value); },
      say: async (value) => { said.push(value); },
    });
    expect(root.textContent).toContain('连接聊天模型');
    root.querySelector('[name="apiKey"]').value = 'secret'; root.querySelector('form').requestSubmit(); await Promise.resolve();
    await expect.poll(() => flow.step).toBe(1); expect(savedModels[0].model).toBe('chat');
    expect(root.textContent).toContain('沿用当前显示的形象'); expect(root.textContent).toContain('暂不提供切换入口');
    root.querySelector('[name="name"]').value = '灵犀'; root.querySelector('[name="user"]').value = '我'; root.querySelector('[name="constitution"]').value = '温和';
    root.querySelector('form').requestSubmit(); await Promise.resolve();
    await expect.poll(() => flow.step).toBe(2); expect(savedProfiles[0].name).toBe('灵犀');
    root.querySelector('[name="text"]').value = '你好'; root.querySelector('form').requestSubmit(); await Promise.resolve();
    await expect.poll(() => root.innerHTML).toBe(''); expect(said).toEqual(['你好']);
  });
});
