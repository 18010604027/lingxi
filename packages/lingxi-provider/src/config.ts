import { PROTOCOLS, locate, vendorOf, type Protocol, type Language } from './vendors.ts';
import { plainRemote } from './address.ts';
import { providerText } from './strings.ts';

export interface ProviderEntry {
  kind?: string;
  baseUrl: string;
  secret?: string;
  spec: { model: string; thinking?: boolean; reasoningEffort?: string; temperature?: number; maxTokens?: number };
  multimodal?: boolean;
  options?: { protocol?: Protocol | '' };
}

export const protocolOf = (entry: ProviderEntry): Protocol =>
  entry.options?.protocol || locate(entry.baseUrl)?.site.protocol || 'responses';

export function validateEntry(entry: ProviderEntry, language: Language = 'en'): void {
  const protocol = entry.options?.protocol;
  if (protocol && !PROTOCOLS.includes(protocol)) throw new Error(providerText(language).badProtocol(PROTOCOLS.join(' / ')));
  if (plainRemote(entry.baseUrl)) throw new Error(providerText(language).httpRemote);
}

/** Image policy belongs to the endpoint, even when a generic adapter accepts image blocks. */
export function acceptsImages(entry: ProviderEntry): boolean {
  const vendor = vendorOf(entry.baseUrl);
  return entry.multimodal === true && (!vendor || (vendor.vision ?? []).includes(entry.spec.model));
}
