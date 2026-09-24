import { ragEvidenceComplete } from './assessment.js';
import type { Trial } from './contracts.js';

export interface Observability { level: 0 | 1 | 2 | 3; reply: boolean; tools: boolean; retrievals: boolean; state: boolean }

/**
 * What the adapter proved it can show, read from real probe trials rather than from its claims.
 * Each channel is reported on its own; the level is cumulative: 0 replies, 1 tool checks,
 * 2 article checks, 3 state checks.
 */
export function observabilityLevel(trials: Pick<Trial, 'events' | 'observation'>[]): Observability {
  const every = (predicate: (trial: Pick<Trial, 'events' | 'observation'>) => boolean) => trials.length > 0 && trials.every(predicate);
  const reply = every(t => t.events.some(e => e.type === 'assistant'));
  const tools = every(t => t.observation?.tools === 'complete');
  const retrievals = every(t => ragEvidenceComplete(t, 'retrieval'));
  const state = every(t => t.observation?.state === 'reported' && t.observation.resetConfirmed === true);
  return { level: !reply || !tools ? 0 : !retrievals ? 1 : !state ? 2 : 3, reply, tools, retrievals, state };
}
