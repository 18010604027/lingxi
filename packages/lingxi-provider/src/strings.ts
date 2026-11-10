import type { Language } from './vendors.ts';

/** What the console shows of this provider: its description, the thinking levels, the protocol setting and its error. */
const zh = {
  description: (names: readonly string[]) => `接 ${names.join('、')};按接口地址认出是哪一家、走哪种协议。思考可调四档。`,
  tiers: { off: '不思考', low: '思考 · 快', high: '思考 · 标准', max: '思考 · 最深' },
  protocol: '协议',
  protocolHint: '留空时,列出的服务用它自己的协议,其他地址用 responses。responses:POST <地址>/responses;chat:POST <地址>/chat/completions。',
  badProtocol: (protocols: string) => `协议只能是 ${protocols}`,
  httpRemote: "远程地址只能用 https:http 不加密，API Key 和对话会明文传输。本机和局域网的地址可以用 http。",
};

export const en: typeof zh = {
  description: (names: readonly string[]) => `One module for ${names.join(', ')}; the base URL tells which service it is and which protocol it takes. Thinking has four levels.`,
  tiers: { off: 'No thinking', low: 'Thinking · fast', high: 'Thinking · standard', max: 'Thinking · deepest' },
  protocol: 'Protocol',
  protocolHint: 'Unset: the listed service uses its own protocol, any other URL uses responses. responses: POST <URL>/responses; chat: POST <URL>/chat/completions.',
  badProtocol: (protocols: string) => `The protocol must be one of ${protocols}`,
  httpRemote: "A remote address must use https: http is not encrypted, so the API Key and the conversation would travel in plain text. Addresses on this computer or the local network may use http.",
};

export const providerText = (language: Language) => language === 'zh' || language === 'zh-Hant' ? zh : en;
