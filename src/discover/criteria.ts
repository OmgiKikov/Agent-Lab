import { fingerprint, type Criterion, type Requirement, type Source } from '../contracts.js';
import type { LogJudgeRequest } from '../card/calibration.js';
import { logSkip } from '../card/calibration-scope.js';
import { expectationLetter, expectationRubric } from '../card/compile.js';
import type { Expectation } from '../card/expectations.js';
import { logJudgeInput } from '../card/log-judge.js';
import type { BusinessScenario } from '../card/schema.js';
import { criterionHash, criterionOf } from '../criterion.js';
import { observableSources } from '../judge.js';
import { workInputIssue } from '../limits.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { ANALYSIS_PROTOCOL, type LogAnalysis } from './schema.js';

/*
 * What a log analysis asks the judge: an expectation of a topic's plan (card/plan.ts) — a criterion (criterion.ts): the
 * owner's rules on verbatim quotes, the ways, the violation, the channel — put to one logged conversation, exactly as a
 * card's expectation is put to its conversation in a calibration (card/log-judge.ts): the same frozen `logged-v2` input,
 * the same two votes, the same channel rule. What differs is who owns the criterion: the plan, not an accepted card, so
 * nothing of a card or a run is in its address.
 *
 *   plan expectation ─► criterion (its channel the plan's: the reply unless the logs recorded tools and the plan chose one)
 *                    ─► criterion hash: the same criterion a check of the problem carries into its situations (discover/verify.ts)
 *   criterion + what the judge reads of it + import + conversation + judge protocol ─► key: while none changed, a finding holds
 *
 * Which expectations apply to a conversation is the plan's word, not the judge's: the plan names each analysed
 * conversation under the variation of the topic it stands for, and a variation's expectations are the ones that apply —
 * a conversation it named under none gets the expectations every variation shares. The judge then still decides whether
 * the moment of the expectation came at all (both conditions not met: not exercised). A criterion seen on the tools or the
 * state meets a log that did not record that channel completely: the judge is not asked (calibration-scope.ts logSkip).
 */

type PlanExpectation = BusinessScenario['expectations'][number];

/** The expectations of a plan that apply to a conversation of `variationId`; without one, those every variation shares. */
export function applicableExpectations(scenario: BusinessScenario, variationId: string | undefined): PlanExpectation[] {
  return scenario.expectations.filter(expectation => !expectation.variationIds || (variationId !== undefined && expectation.variationIds.includes(variationId)));
}

/**
 * A plan expectation as the judge reads it: on the channel the plan named — the agent's reply unless the plan, reading
 * logs that recorded tools or state, named that channel. The judge's own rule holds that the agent's words prove only
 * what was said, never that an action happened (card/expectations.ts channelHolds).
 */
export function judgedExpectation(expectation: PlanExpectation): Expectation {
  return { id: expectation.id, text: expectation.text, requirementIds: expectation.requirementIds, observation: expectation.observation ?? 'reply',
    ...(expectation.observation === 'tool' && expectation.tool ? { tool: expectation.tool } : {}),
    ...(expectation.strength ? { strength: expectation.strength } : {}),
    ...(expectation.acceptable !== undefined ? { acceptable: expectation.acceptable } : {}),
    ...(expectation.violation !== undefined ? { violation: expectation.violation } : {}) };
}

/** The criterion an expectation of the analysis's plan stands for; undefined when a rule it cites is not in the analysis. */
export const planCriterion = (analysis: Pick<LogAnalysis, 'requirements'>, expectation: PlanExpectation): Criterion | undefined =>
  criterionOf(expectation, analysis.requirements);

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

/**
 * One expectation of a plan put to one logged conversation, with the address of its finding; `skipped` — the log cannot
 * show it, and the judge is not asked.
 */
export interface AnalysisJob { key: string; criterionHash: string; request: LogJudgeRequest; scenarioId: string; expectationId: string; variationId?: string; dialogueId: string;
  skipped?: 'no_agent_reply' | 'channel_unobserved' }

/** The judge's request for an expectation of `scenario` on one conversation of the analysis's import. */
export function analysisJob(analysis: Pick<LogAnalysis, 'task' | 'sources' | 'requirements'>, batch: Pick<ImportBatch, 'contentHash'>, scenario: BusinessScenario,
  expectation: PlanExpectation, dialogue: ImportBatch['dialogues'][number], variationId: string | undefined, protocolHash: string): AnalysisJob {
  const judged = judgedExpectation(expectation);
  const letter = expectationLetter(expectation.id);
  const card = `сценария «${scenario.topic}»`;
  const cited = new Set(expectation.requirementIds);
  const requirements: Requirement[] = analysis.requirements.filter(requirement => cited.has(requirement.id));
  const criterion = criterionOf(expectation, analysis.requirements);
  if (!criterion) throw new Error('Правило ожидания не найдено среди правил разбора.');
  // The rubric of a card's expectation seen on the tools, as a run and a calibration judge it (card/compile.ts).
  const request: Omit<LogJudgeRequest, 'key'> = { expectation: judged, letter, card, rubric: expectationRubric(judged, letter, card, { toolLog: judged.observation === 'tool' }), requirements,
    sources: judgedSources(analysis, expectation.requirementIds), importContentHash: batch.contentHash,
    dialogue: { observation: dialogue.observation, events: dialogue.events } };
  // What the judge reads apart from the conversation — the rubric, the rules, the sources — is in the key beside the criterion.
  const { dialogue: _dialogue, importContentHash: _import, ...judgedInput } = logJudgeInput({ ...request, key: '' });
  const hash = criterionHash(criterion);
  const key = fingerprint({ protocol: ANALYSIS_PROTOCOL, criterionHash: hash, judged: fingerprint(judgedInput), importContentHash: batch.contentHash, dialogueId: dialogue.id, protocolHash });
  const skipped = logSkip(judged, dialogue);
  return { key, criterionHash: hash, request: { ...request, key }, scenarioId: scenario.id, expectationId: expectation.id, ...(variationId ? { variationId } : {}), dialogueId: dialogue.id,
    ...(skipped ? { skipped } : {}) };
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
