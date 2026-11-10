/**
 * A deliberately small, non-probabilistic read of one recall result. The four labels describe
 * what the retrieved evidence can support; they are not a model confidence score and are not
 * calibrated probabilities. Thresholds stay named so a later C9 evaluation can replace them.
 */
import type { Candidate, Features } from './recall-score.ts';

export type MetaMemoryState = 'remembered' | 'impression' | 'possible' | 'unsupported';

export interface ScoredCandidate extends Candidate { score: number }

export interface MetaMemoryInput {
  candidates: readonly ScoredCandidate[];
  /** Number of topic cards represented by the result. */
  cards: number;
  /** Number of distinct evidence sources supplied by the adapter. */
  sources: number;
  /** Time span covered by the supplied evidence, in days; null means it was not reported. */
  timespanDays: number | null;
}

export interface MetaMemoryResult {
  state: MetaMemoryState;
  /** English guidance for the foreground; this is a hint, not text to quote verbatim. */
  hint: string;
  /** Rule trace for evaluation and later calibration. */
  reason: string;
  candidateCount: number;
  topScore: number | null;
  timespanDays: number | null;
}

/** Conservative initial boundaries. They are heuristics until C9 has labelled results. */
export const METAMEMORY_THRESHOLDS = {
  rememberedCoverage: 0.75,
  rememberedMatch: 0.5,
  rememberedCards: 1,
  rememberedSources: 2,
  impressionCoverage: 0.4,
  impressionMatch: 0.1,
  impressionCards: 1,
  impressionSources: 1,
} as const;

const HINTS: Record<MetaMemoryState, string> = {
  remembered: 'I remember this clearly enough to answer from the retrieved evidence.',
  impression: 'I have an impression, but some details may be missing or dated.',
  possible: 'I may have something about this, but I did not find enough to support it.',
  unsupported: 'I have no basis for this in the retrieved memory.',
};

const finite = (value: number): number => Number.isFinite(value) ? value : 0;
const nonNegative = (value: number): number => Math.max(0, finite(value));
const matchOf = (features: Features): number => nonNegative(features.lineMatch) + nonNegative(features.cardMatch);

function result(state: MetaMemoryState, reason: string, input: MetaMemoryInput, topScore: number | null): MetaMemoryResult {
  return { state, hint: HINTS[state], reason, candidateCount: input.candidates.length, topScore, timespanDays: input.timespanDays };
}

/** Classifies a retrieval result without inventing evidence or treating score as probability. */
export function assessMetaMemory(input: MetaMemoryInput): MetaMemoryResult {
  const top = [...input.candidates].sort((a, b) => finite(b.score) - finite(a.score))[0];
  const topScore = top ? finite(top.score) : null;
  if (!top) return result('unsupported', 'no candidates were returned', input, null);

  const coverage = Math.max(0, Math.min(1, finite(top.features.coverage)));
  const match = matchOf(top.features);
  const cards = Math.max(0, Math.floor(nonNegative(input.cards)));
  const sources = Math.max(0, Math.floor(nonNegative(input.sources)));
  const t = METAMEMORY_THRESHOLDS;
  if (cards >= t.rememberedCards && sources >= t.rememberedSources
    && coverage >= t.rememberedCoverage && match >= t.rememberedMatch) {
    return result('remembered', 'coverage, matching lines/cards, cards, and independent sources meet the clear-evidence boundary', input, topScore);
  }
  if (cards >= t.impressionCards && sources >= t.impressionSources
    && coverage >= t.impressionCoverage && match >= t.impressionMatch) {
    return result('impression', 'some matching evidence is present, but the clear-evidence boundary is not met', input, topScore);
  }
  return result('possible', 'a candidate exists, but the result lacks enough matching evidence or sources', input, topScore);
}
