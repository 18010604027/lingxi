/** Minimal Lingxi-owned contracts shared by app services and the agent runtime. */

export type Language = 'zh' | 'en' | string;
export type ToolTag = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';
export type DescribeText = string | { zh: string; en: string };
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
export interface ToolCallContext {
  role: string; log: Logger; callId?: string; round?: number; signal?: AbortSignal;
}
export interface ToolOutcome { text: string; blobs?: unknown[]; failed?: true }
export interface ToolDef {
  name: string; description: string; parameters: Record<string, unknown>;
  tags: readonly ToolTag[]; barrierAfter?: boolean; endsTurn?: boolean; interruptible?: boolean;
  handler(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string | ToolOutcome>;
}
export interface EventEnvelope {
  cursor: number; run?: string; type: string; ts: string; source: string;
  origin: 'external' | 'internal'; tags?: readonly string[];
  contextDelivery?: 'deliver' | 'archive-only'; text: string; senderKey?: string;
  meta?: Record<string, unknown>; ephemeral?: true;
}
export interface EventStoreReader {
  get(cursor: number): EventEnvelope | undefined;
  latestCursor(): number;
  range(query: { fromCursor?: number; toCursor?: number; fromTs?: string; toTs?: string; source?: string; origin?: string; senderKey?: string; limit?: number }): EventEnvelope[];
  around(cursor: number, before: number, after: number): EventEnvelope[];
  grep(query: { keyword: string; context: number; source?: string; origin?: string; senderKey?: string; fromTs?: string; toTs?: string; limit?: number }): Array<{ hitCursor: number; events: EventEnvelope[] }>;
}
export interface SessionDecl { id: string; label?: string; [key: string]: unknown }
export interface CoreApi { injectInternal(text: string, mode?: string): boolean | void; log: Logger; [key: string]: unknown }
export interface FrontInputEvent { type: string; text: string; trigger?: TriggerMode; meta?: Record<string, unknown>; id?: string }
export interface FrontEventSource { enqueue(event: FrontInputEvent): boolean; log: Logger }
export interface WorldHost {
  pushEvent(event: Record<string, unknown>, options?: Record<string, unknown>): Promise<EventEnvelope>;
  store?: EventStoreReader;
}
export interface WorldWebUiDecl { [key: string]: unknown }
export interface World {
  id: string; tools(): ToolDef[]; start(host: WorldHost): Promise<void>; stop(): Promise<void>;
  envPromptVars?(): Record<string, string> | null | Promise<Record<string, string> | null>;
  webUi?(language?: string): WorldWebUiDecl;
}
export type SessionOpeningReason = 'new' | 'restarted' | 'cleared';
export type WorldLifecycleEvent = { kind: 'mounted' | 'unmounted' | 'restarted'; id: string; label: string }
  | { kind: 'visibility'; id: string; label: string; visible: boolean };
export type TriggerMode = 'flush' | 'preempt' | 'interrupt' | 'daily' | 'idle' | 'never' | 'piggyback' | 'debounce';
