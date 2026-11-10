/**
 * The model service this provider offers: DeepSeek. `id` doubles as the name of its endpoint in the app
 * (`endpointName`), and `secret` as the name its key is stored under. The base URL, protocol, starting model,
 * image input and context window are from DeepSeek's own documentation (read 2026-09-24; the model list checked
 * 2026-10-09).
 *
 * This file imports nothing, so the browser and the app's first-run seed can use it.
 */

/** Thinking levels retained by endpoint configuration. */
export type Effort = 'none' | 'low' | 'high' | 'max';

/** The effort value a service takes for each level where it differs; null leaves the effort out. */
export type EffortMap = Partial<Record<Effort, string | null>>;

/**
 * How requests are sent: `responses` is `POST <baseUrl>/responses`, `chat` is
 * `POST <baseUrl>/chat/completions`.
 */
export type Protocol = 'responses' | 'chat';
export const PROTOCOLS: readonly Protocol[] = ['responses', 'chat'];

/** A service's mainland China platform or its international one. */
export type Region = 'cn' | 'intl';
const REGIONS: readonly Region[] = ['cn', 'intl'];

/** Languages accepted by the endpoint picker; this data module imports no runtime. */
export type Language = 'zh' | 'zh-Hant' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es-419' | 'pt-BR' | 'it' | 'ru';

/** Text in Chinese and English; see `localized` for the fallback of a language without an entry. */
export type Localized = { zh: string; en: string } & Partial<Record<Language, string>>;

/** `text` in `language`: traditional Chinese falls back to simplified, every other language to English. */
export function localized(text: Localized, language: Language): string {
  return text[language] ?? (language === 'zh-Hant' ? text.zh : text.en);
}

export interface Site {
  /** The URL the protocol's paths follow. */
  baseUrl: string;
  protocol: Protocol;
  /** Where a key is created. */
  keyUrl: string;
}

export interface Vendor {
  id: string;
  /** Shown to the person. */
  names: Localized;
  /** Placeholder of the key box: how the service's keys start. */
  keyHint: Localized;
  secret: string;
  sites: { global: Site };
  /** The model a new endpoint starts with: a fast, cheap current model that reads images. */
  model: string;
  /** Other model names offered next to `model` where one is typed; any name the service takes works. */
  models?: readonly string[];
  /** Models that read images. */
  vision?: readonly string[];
  /** Context windows the service states, where its model list does not report them. */
  contextWindows?: Readonly<Record<string, number>>;
  /**
   * Responses with past reasoning sent back as text: whether a tool call with no reasoning recorded
   * before it gets a placeholder reasoning item. Enabled explicitly for the known endpoint.
   */
  syntheticReasoning?: boolean;
}

const brand = (name: string): Localized => ({ zh: name, en: name });
const hint = (prefix: string): Localized => brand(`${prefix}…`);

/** The one service the app offers. */
export const VENDORS: readonly Vendor[] = [
  {
    id: 'deepseek', names: brand('DeepSeek'), keyHint: hint('sk-'), secret: 'DEEPSEEK_API_KEY',
    sites: { global: { baseUrl: 'https://api.deepseek.com', protocol: 'responses', keyUrl: 'https://platform.deepseek.com/api_keys' } },
    model: 'deepseek-flash', models: ['deepseek-v4-pro'],
    vision: ['deepseek-flash'], contextWindows: { 'deepseek-flash': 1_000_000, 'deepseek-v4-pro': 1_000_000 },
    // the endpoint answers 400 when a tool call in the input has no reasoning before it
    syntheticReasoning: true,
  },
];

/** The regions a service has separate platforms for; none for a service with one platform. */
export const regionsOf = (v: Vendor): Region[] => ('global' in v.sites ? [] : [...REGIONS]);

/** The platform of `v` that serves `region`. */
export const siteOf = (v: Vendor, region: Region): Site => ('global' in v.sites ? v.sites.global : v.sites[region]);

/** The name of the app's endpoint for `v` on `region`: the id, with `-intl` for an international platform. */
export const endpointName = (v: Vendor, region: Region): string => ('global' in v.sites || region === 'cn' ? v.id : `${v.id}-intl`);

export const vendorName = (v: Vendor, language: Language): string => localized(v.names, language);

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export interface Located {
  vendor: Vendor;
  /** Null for a service with one platform. */
  region: Region | null;
  site: Site;
}

/** The service and platform an endpoint's base URL points at, or null for any other URL. */
export function locate(baseUrl: string | undefined): Located | null {
  if (!baseUrl) return null;
  const url = trimSlash(baseUrl.trim());
  for (const vendor of VENDORS) {
    const sites: Array<[Region | null, Site]> = 'global' in vendor.sites ? [[null, vendor.sites.global]] : REGIONS.map((r) => [r, siteOf(vendor, r)]);
    for (const [region, site] of sites) if (url === site.baseUrl || url.startsWith(`${site.baseUrl}/`)) return { vendor, region, site };
  }
  return null;
}

/** The service an endpoint's base URL points at, or null for any other URL. */
export const vendorOf = (baseUrl: string | undefined): Vendor | null => locate(baseUrl)?.vendor ?? null;

/** Mainland China for Chinese, the international platforms for every other language. */
export const defaultRegion = (language: Language): Region => (language === 'zh' ? 'cn' : 'intl');

/** A new endpoint's config for `v` on `region` (`kind: 'lingxi'`) with `model`; the key goes into its `.env` under `v.secret`. */
export function vendorEntry(v: Vendor, model = v.model, region: Region = 'cn') {
  return {
    kind: 'lingxi',
    baseUrl: siteOf(v, region).baseUrl,
    secret: v.secret,
    spec: { model, thinking: true, reasoningEffort: 'high' },
    multimodal: (v.vision ?? []).includes(model),
    pricing: [],
    options: {},
  };
}
