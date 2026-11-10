import { randomUUID } from 'node:crypto';
import type { OutputChallenge, OutputDevices, OutputEndpoint } from './types.ts';

export interface OutputPermit { requestId: string; endpoint: OutputEndpoint; generation: number }
export type OutputDecision = { kind: 'allowed'; permit: OutputPermit } | { kind: 'confirmation-required'; challenge: OutputChallenge } | { kind: 'unavailable' };

/** Only Windows Headphones (3) and Headset (5) are automatic. Names and Bluetooth alone are not evidence. */
export function isHeadphone(formFactor: number | null): boolean { return formFactor === 3 || formFactor === 5; }

export class OutputGuard {
  private generation = 0;
  private observed: OutputEndpoint | null | undefined;
  private pending = new Map<string, OutputChallenge>();
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;

  constructor(private readonly devices: OutputDevices) {
    this.unsubscribe = devices.subscribe(() => this.invalidate());
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  stop() { this.unsubscribe(); this.pending.clear(); this.listeners.clear(); }
  forget(requestId: string) { for (const [id, c] of this.pending) if (c.requestId === requestId) this.pending.delete(id); }

  async request(requestId: string): Promise<OutputDecision> {
    const endpoint = await this.snapshot();
    if (!endpoint) return { kind: 'unavailable' };
    if (isHeadphone(endpoint.formFactor)) return { kind: 'allowed', permit: { requestId, endpoint, generation: this.generation } };
    const challenge = { id: randomUUID(), requestId, endpointId: endpoint.id, generation: this.generation, revision: endpoint.revision };
    this.pending.set(challenge.id, challenge);
    return { kind: 'confirmation-required', challenge };
  }
  async confirm(id: string, requestId: string): Promise<OutputPermit | null> {
    const challenge = this.pending.get(id);
    if (!challenge || challenge.requestId !== requestId) return null;
    this.pending.delete(id);
    const endpoint = await this.snapshot();
    if (!endpoint || challenge.generation !== this.generation || challenge.endpointId !== endpoint.id || challenge.revision !== endpoint.revision) return null;
    return { requestId, endpoint, generation: this.generation };
  }
  async valid(permit: OutputPermit): Promise<boolean> {
    const endpoint = await this.snapshot();
    return !!endpoint && permit.generation === this.generation && endpoint.id === permit.endpoint.id && endpoint.revision === permit.endpoint.revision;
  }
  private async snapshot(): Promise<OutputEndpoint | null> {
    const endpoint = await this.devices.current();
    if (this.observed !== undefined && (endpoint?.id !== this.observed?.id || endpoint?.revision !== this.observed?.revision || endpoint?.formFactor !== this.observed?.formFactor)) this.invalidate();
    this.observed = endpoint;
    return endpoint;
  }
  private invalidate() {
    this.generation++; this.pending.clear();
    for (const listener of this.listeners) listener();
  }
}
