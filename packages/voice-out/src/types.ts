export interface Sentence { text: string; startCharacter: number; endCharacter: number }
export interface SpeechMark { endCharacter: number; atMs: number }
export interface AudioClip {
  wav: Uint8Array;
  durationMs: number;
  /** Confirmed alignment, in Unicode code points of this sentence. Absent when the backend supplies none. */
  marks?: SpeechMark[];
}
export interface SpeechBackend { synthesize(text: string, signal: AbortSignal): Promise<AudioClip> }
export interface OutputEndpoint { id: string; formFactor: number | null; revision: number }
export interface OutputDevices {
  current(): Promise<OutputEndpoint | null>;
  /** Report every endpoint change, including A→B→A. */
  subscribe(onChange: () => void): () => void;
}
export interface Playback {
  finished: Promise<void>;
  /** Resolves after rendering stops; returns the device's rendered position, not time since start. */
  stop(): Promise<{ playedMs: number }>;
}
export interface AudioPlayer {
  /** Pin this endpoint. Never migrate or fall back to the default device after it disappears. */
  start(clip: AudioClip, endpointId: string, onProgress: (playedMs: number) => void): Playback;
}
export interface HeardReceipt {
  completedSentences: number;
  /** Zero-based active sentence, or null before playback and after full completion. */
  sentenceIndex: number | null;
  playedMs: number;
  /** Null means partial character alignment is unknown. */
  partialCharacters: number | null;
  confirmedCharacters: number;
  confirmedText: string;
}
export type SpeechResult = { kind: 'completed' | 'interrupted' | 'failed'; reason?: string; heard: HeardReceipt };
export interface OutputChallenge { id: string; requestId: string; endpointId: string; generation: number; revision: number }
export interface SpeechState { kind: 'queued' | 'confirmation-required' | 'synthesizing' | 'playing' | 'finished'; challenge?: OutputChallenge }
export interface SpeechHandle {
  id: string;
  readonly state: SpeechState;
  done: Promise<SpeechResult>;
  /** Call only after this challenge has been explicitly confirmed by the person. */
  confirm(challengeId: string): Promise<boolean>;
  interrupt(): Promise<SpeechResult>;
}
