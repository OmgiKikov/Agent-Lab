import { fingerprint, type Requirement, type Source } from '../contracts.js';
import type { LogJudgeRequest } from '../card/calibration.js';
import { expectationLetter, expectationRubric } from '../card/compile.js';
import type { Expectation } from '../card/expectations.js';
import { logJudgeInput } from '../card/log-judge.js';
import type { BusinessScenario } from '../card/schema.js';
import { observableSources } from '../judge.js';
import { workInputIssue } from '../limits.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { ANALYSIS_PROTOCOL, type LogAnalysis } from './schema.js';

/*
 * What a log analysis asks the judge: an expectation of a topic's plan (card/plan.ts) — the owner's rules on verbatim
 * quotes — put to one logged conversation, exactly as a card's expectation is put to its conversation in a calibration
 * (card/log-judge.ts): the same frozen `logged-v2` input, the same two votes, the same channel rule. What differs is who
 * owns the criterion: the plan, not an accepted card, so nothing of a card or a run is in its address.
 *
 *   plan expectation ─► as judged (reply channel, the rubric of a card's expectation) ─► criterion hash
 *   criterion + import + conversation + judge protocol ─► key: while none changed, a finding holds
 *
 * Which expectations apply to a conversation is the plan's word, not the judge's: the plan names each analysed
 * conversation under the variation of the topic it stands for, and a variation's expectations are the ones that apply —
 * a conversation it named under none gets the expectations every variation shares. The judge then still decides whether
 * the moment of the expectation came at all (both conditions not met: not exercised).
 */

type PlanExpectation = BusinessScenario['expectations'][number];

/** The expectations of a plan that apply to a conversation of `variationId`; without one, those every variation shares. */
export function applicableExpectations(scenario: BusinessScenario, variationId: string | undefined): PlanExpectation[] {
  return scenario.expectations.filter(expectation => !expectation.variationIds || (variationId !== undefined && expectation.variationIds.includes(variationId)));
}

/**
 * A plan expectation as the judge reads it: on the agent's replies — the plan does not say which duty is an action, and
 * the judge's own rule holds that the agent's words prove only what was said, never that an action happened.
 */
export function judgedExpectation(expectation: PlanExpectation): Expectation {
  return { id: expectation.id, text: expectation.text, requirementIds: expectation.requirementIds, observation: 'reply',
    ...(expectation.strength ? { strength: expectation.strength } : {}),
    ...(expectation.acceptable !== undefined ? { acceptable: expectation.acceptable } : {}),
    ...(expectation.violation !== undefined ? { violation: expectation.violation } : {}) };
}

/**
 * The sources the judge reads for an analysis: all of them when they fit one request, otherwise the prompts and the
 * articles the expectation's rules cite — every prompt shown as its observable rules only (judge.ts observableSources).
 */
function judgedSources(analysis: Pick<LogAnalysis, 'task' | 'sources' | 'requirements'>, requirementIds: readonly string[]): Source[] {
  const whole = !workInputIssue({ task: analysis.task, sources: analysis.sources });
  const cited = new Set(analysis.requirements.filter(requirement => requirementIds.includes(requirement.id)).map(requirement => requirement.sourceId));
  const read = whole ? analysis.sources : analysis.sources.filter(source => source.kind === 'prompt' || cited.has(source.id));
  return observableSources(read, analysis.requirements);
}

/** One expectation of a plan put to one logged conversation, with the address of its finding. */
export interface AnalysisJob { key: string; criterionHash: string; request: LogJudgeRequest; scenarioId: string; expectationId: string; variationId?: string; dialogueId: string }

/** The judge's request for an expectation of `scenario` on one conversation of the analysis's import. */
export function analysisJob(analysis: Pick<LogAnalysis, 'task' | 'sources' | 'requirements'>, batch: Pick<ImportBatch, 'contentHash'>, scenario: BusinessScenario,
  expectation: PlanExpectation, dialogue: ImportBatch['dialogues'][number], variationId: string | undefined, protocolHash: string): AnalysisJob {
  const judged = judgedExpectation(expectation);
  const letter = expectationLetter(expectation.id);
  const card = `сценария «${scenario.topic}»`;
  const cited = new Set(expectation.requirementIds);
  const requirements: Requirement[] = analysis.requirements.filter(requirement => cited.has(requirement.id));
  const request: Omit<LogJudgeRequest, 'key'> = { expectation: judged, letter, card, rubric: expectationRubric(judged, letter, card), requirements,
    sources: judgedSources(analysis, expectation.requirementIds), importContentHash: batch.contentHash,
    dialogue: { observation: dialogue.observation, events: dialogue.events } };
  // The criterion is what the judge reads apart from the conversation: the expectation, its rubric, its rules, the sources.
  const { dialogue: _dialogue, importContentHash: _import, ...criterion } = logJudgeInput({ ...request, key: '' });
  const criterionHash = fingerprint({ protocol: ANALYSIS_PROTOCOL, criterion });
  const key = fingerprint({ protocol: ANALYSIS_PROTOCOL, criterionHash, importContentHash: batch.contentHash, dialogueId: dialogue.id, protocolHash });
  return { key, criterionHash, request: { ...request, key }, scenarioId: scenario.id, expectationId: expectation.id, ...(variationId ? { variationId } : {}), dialogueId: dialogue.id };
}

/** The variation of its topic's plan each conversation stands for, as the plan named it. */
export function planAssignments(scenario: BusinessScenario, dialogueIds: readonly string[]): LogAnalysis['assignments'] {
  return dialogueIds.map(dialogueId => {
    const variation = scenario.variations.find(item => item.examples.includes(dialogueId));
    return { dialogueId, scenarioId: scenario.id, ...(variation ? { variationId: variation.id } : {}) };
  });
}

/** Why a readable conversation cannot be judged: the customer wrote nothing, or the agent answered nothing. */
export function unjudgeable(dialogue: ImportBatch['dialogues'][number]): 'no_customer' | 'no_agent_reply' | undefined {
  const said = (role: 'user' | 'assistant') => dialogue.events.some(event => event.type === 'message' && event.role === role && !!event.content?.trim());
  if (!said('user')) return 'no_customer';
  if (!said('assistant')) return 'no_agent_reply';
  return undefined;
}
