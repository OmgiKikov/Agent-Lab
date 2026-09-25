import { internalPromptRule, type Experiment, type Scenario, type Trial } from './contracts.js';
import type { MetricAssessment } from './assessment.js';
import { verbatimSpanAt } from './verbatim.js';
import { headlineRule, type CountedExpectation } from './card/expectations.js';
import { agentMetricResult, automaticTrialResult, expectationResult, measurementUsable } from './outcomes.js';
import { AGREED_RATIONALE_PREFIX } from './judge.js';
import { oneLine } from './text.js';

/*
 * Why a situation failed, as data the surfaces word (result-text.ts, report.ts): what the agent had to
 * do, the reply the judge pointed at, and which of the owner's rules the situation rests on. Built from
 * the stored record only: no model call, so old runs are explained as soon as they are opened. Every part
 * is checked against the record (the reply against its event, a rule quote against its source); a part
 * that fails its check is left out with its reason kept, never guessed.
 * Pure: no I/O, no escaping, raw text; every surface escapes at its own boundary. Imports only
 * contracts.js, assessment.js, verbatim.js, card/expectations.js, outcomes.js, judge.js and text.js;
 * it must not import the engine (experiment.ts, lab/), quality.ts or result-view.ts.
 */

/** Stands where a rule quote that fails its check would be (quality.ts). */
export const UNVERIFIED = 'объяснение не подтверждено цитатой';

/** One owner rule: its number in the owner's materials and where to find it. */
interface RuleRef {
  number: number; requirementId: string; sourceId: string; sourceName: string;
  /** 1-based line of the quote start; null for a short source, found by name alone. */
  line: number | null;
  /** The source's own characters, whitespace runs collapsed to one space. */
  quote: string;
  prompt: boolean;
}
export interface FailureExplanation {
  scenarioId: string; trialId: string; title: string;
  /**
   * goal: the situation goal failed (the prompt rules passed or the card has no such check);
   * rules: only the prompt-rule check failed; both: the goal and the prompt-rule check failed in the same attempt.
   */
  kind: 'goal' | 'rules' | 'both';
  /** What the agent had to do, in the situation's or the rule's own words; null when the record does not say it. */
  expected: string | null;
  /**
   * The agent reply the judge pointed at — its citation, else the reply its evidence names — verified against the
   * stored event; null when there is none to show. A reply the judge did not point at is never put here: it would
   * read as the evidence of the failure.
   */
  said: { seq: number; quote: string } | null;
  /**
   * Why `said` is null: the judge pointed at no reply of the agent (a tool call, the state, or nothing at all), the
   * words it quotes are not in the reply it names, or the attempt holds no reply.
   */
  unsaid?: 'not_cited' | 'unverified' | 'no_reply';
  /** The verified owner rules the situation rests on, knowledge first; the first one is shown when no violated rule is named. */
  rules: RuleRef[];
  /** The one registered prompt rule the failed prompt-rule check quotes; absent when it cannot be named uniquely. */
  violated?: RuleRef;
}

const GOAL = 'goal_attainment';
const COMPLIANCE = 'prompt_compliance';
/**
 * A «…» span of the judge's rationale long enough to identify a rule. The stored prompt-rule rubric asks the judge to
 * quote the violated rule verbatim in its rationale (assessment.ts promptCompliance); that rubric and its judgments sit
 * inside stored hashes and carry no rule id, so the quote is the only link. A card names its rules by id instead.
 */
const QUOTED_SPAN = /«([^«»]{12,})»/g;
/**
 * How close a span must be before it may name a rule. Twelve characters is a coincidence in Russian
 * rule text («оплата картой» is 13), and a surface asserts the rule flatly, so a near-miss must stay
 * unnamed: a span inside a rule has to cover most of it, and a rule inside a long judge span has to
 * be long enough to be that rule and not a common phrase.
 */
const MIN_SPAN_RATIO = 0.6;
const MIN_CONTAINED_QUOTE = 24;
/**
 * A line number helps only in a long source. Knowledge files of a few lines are found by name,
 * so `, строка L` is added only from this many non-blank lines up.
 */
const NUMBERED_FROM = 4;
const nonBlankLines = (content: string) => content.split('\n').filter(row => row.trim()).length;

/**
 * Owner rule numbers: sources in the order supplied, then the start of the verbatim quote in
 * its source, then the requirement's array position. A requirement whose source is missing or
 * whose quote is not verbatim in it gets no number. Model ids and the judge's own numbering
 * never decide the order, so a repeat or reassessment copy numbers the rules the same way.
 */
export function ruleRegister(record: Pick<Experiment, 'sources' | 'requirements'>): Map<string, RuleRef> {
  const rows = record.requirements.flatMap((requirement, index) => {
    const sourceIndex = record.sources.findIndex(source => source.id === requirement.sourceId);
    const source = record.sources[sourceIndex];
    // The offset is the one the match was made at, never a fresh search for the matched text: a
    // sentence that repeats in the source must not pull the rule's line back to the first copy.
    const found = source ? verbatimSpanAt(source.content, requirement.quote) : undefined;
    if (!source || !found) return [];
    return [{ requirement, index, sourceIndex, source, span: found.span, offset: found.offset }];
  }).sort((a, b) => a.sourceIndex - b.sourceIndex || a.offset - b.offset || a.index - b.index);
  const register = new Map<string, RuleRef>();
  for (const row of rows) {
    if (register.has(row.requirement.id)) continue;
    const numbered = nonBlankLines(row.source.content) >= NUMBERED_FROM;
    register.set(row.requirement.id, {
      number: register.size + 1, requirementId: row.requirement.id, sourceId: row.source.id, sourceName: row.source.name,
      line: numbered ? row.source.content.slice(0, row.offset).split('\n').length : null,
      quote: oneLine(row.span), prompt: row.source.kind === 'prompt',
    });
  }
  return register;
}

/** `Правило 7 · Возврат покупки: «…»`; the line is named only for a source of several lines. */
export function ruleText(rule: RuleRef, word = 'Правило'): string {
  return `${word} ${rule.number} · ${oneLine(rule.sourceName)}${rule.line === null ? '' : `, строка ${rule.line}`}: «${rule.quote}»`;
}

function assessment(trial: Trial, metricId: string): MetricAssessment | undefined {
  return trial.assessments?.find(item => item.metricId === metricId);
}

/**
 * The agent reply behind the verdict, checked against the stored event: the first cited agent reply, else a
 * reply the judge's evidence names, shown whole. Nothing else stands in for it: the last reply of a conversation
 * the judge did not point at proves nothing about the failure.
 */
function saidOf(trial: Trial, cited: MetricAssessment | undefined): Pick<FailureExplanation, 'said' | 'unsaid'> {
  const replies = trial.events.filter(event => event.type === 'assistant' && typeof event.text === 'string' && oneLine(event.text));
  const reply = (seq: number) => replies.find(event => event.seq === seq);
  const citation = cited?.citations?.find(item => reply(item.seq));
  if (citation) {
    return reply(citation.seq)?.text?.includes(citation.quote)
      ? { said: { seq: citation.seq, quote: oneLine(citation.quote) } }
      : { said: null, unsaid: 'unverified' };
  }
  const evidence = cited && !cited.citations ? cited.evidence.map(reply).find(Boolean) : undefined;
  if (evidence) return { said: { seq: evidence.seq, quote: oneLine(evidence.text ?? '') } };
  return { said: null, unsaid: replies.length ? 'not_cited' : 'no_reply' };
}

/**
 * The prompt rule a failed prompt-rule check names: the «…» spans of its rationale (the agreed
 * prefix removed) are matched against registered, observable prompt rules. A match must be exact or
 * near-exact, and exactly one distinct rule may match; a weak match, none or several name nothing,
 * so nothing is guessed.
 */
function violatedRule(record: Experiment, trial: Trial, register: Map<string, RuleRef>): RuleRef | undefined {
  if (agentMetricResult(trial, COMPLIANCE, record.humanReviews) !== 'fail') return undefined;
  const rationale = (assessment(trial, COMPLIANCE)?.rationale ?? '').replace(AGREED_RATIONALE_PREFIX, '');
  const normal = (value: string) => oneLine(value).toLowerCase();
  const spans = [...rationale.matchAll(QUOTED_SPAN)].map(match => normal(match[1] ?? '')).filter(span => span.length >= 12);
  const found = new Map<number, RuleRef>();
  for (const requirement of record.requirements) {
    const rule = register.get(requirement.id);
    if (!rule?.prompt || internalPromptRule(record.sources, requirement)) continue;
    const quote = normal(rule.quote);
    if (spans.some(span => (quote.includes(span) && span.length >= Math.ceil(quote.length * MIN_SPAN_RATIO))
      || (span.includes(quote) && quote.length >= MIN_CONTAINED_QUOTE))) found.set(rule.number, rule);
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}

/** The owner rule number a failed prompt-rule check names, or null when it cannot be named uniquely (or the rules were kept). */
export function violatedRuleNumber(record: Experiment, trial: Trial): number | null {
  return violatedRule(record, trial, ruleRegister(record))?.number ?? null;
}

/**
 * The explanation of one failed situation, or null when the record holds no failed attempt
 * for it. `trial` picks the attempt (a cause example); otherwise, among the usable attempts only
 * (so the explained failure is always one the number counts), the first attempt whose goal
 * failed is used, then the first whose prompt-rule check failed. An attempt where the goal and
 * the prompt-rule check both failed is «оба»; a legacy card without the goal rubric keeps the
 * phase-2 kinds.
 */
export function failureExplanation(record: Experiment, scenario: Scenario, trial?: Trial): FailureExplanation | null {
  const reviews = record.humanReviews;
  const agentMetrics = (scenario.metrics ?? []).filter(metric => metric.subject === 'agent').map(metric => metric.id);
  const hasGoal = agentMetrics.includes(GOAL);
  const goalFailed = (item: Trial) => hasGoal ? agentMetricResult(item, GOAL, reviews) === 'fail' : automaticTrialResult(scenario, item, reviews) === 'fail';
  const rulesFailed = (item: Trial) => agentMetricResult(item, COMPLIANCE, reviews) === 'fail';
  const usable = record.trials.filter(item => item.scenarioId === scenario.id && measurementUsable(scenario, item, reviews));
  const chosen = trial ?? usable.find(goalFailed) ?? usable.find(rulesFailed);
  if (!chosen || chosen.scenarioId !== scenario.id) return null;
  const kind = hasGoal && goalFailed(chosen) && rulesFailed(chosen) ? 'both' : goalFailed(chosen) ? 'goal' : rulesFailed(chosen) ? 'rules' : null;
  if (!kind) return null;

  const rule = headlineRule(scenario, [chosen]);
  const failed = rule.kind === 'expectations' ? rule.expectations.filter(expectation => expectationResult(chosen, expectation, reviews) === 'fail') : [];
  const cited = failed[0] ? assessment(chosen, failed[0].id) : kind === 'rules' ? assessment(chosen, COMPLIANCE)
    : assessment(chosen, GOAL) ?? chosen.assessments?.find(item => item.result === 'fail' && agentMetrics.includes(item.metricId));
  const register = ruleRegister(record);
  // A card may fail on code alone — the article its reference names was not retrieved: then that check is what it owed.
  const failedChecks = chosen.checks.filter(check => !check.passed && isReferenceCheck(check.id));
  const owedScenario = !failed.length && failedChecks.length ? { ...scenario, successCriteria: failedChecks.map(check => oneLine(check.description)).join('; ') } : owed(scenario, failed);
  const violated = violatedRule(record, chosen, register);
  return {
    scenarioId: scenario.id, trialId: chosen.id, title: scenario.title, kind,
    expected: expectedOf(record, owedScenario, kind, violated, register), ...saidOf(chosen, cited),
    rules: rulesOf(record, owedScenario, register), ...(violated ? { violated } : {}),
  };
}

/**
 * A card counted by its expectations owed exactly the expectations at stake — «Б — объяснить, как оформить
 * возврат» — and rests on the owner rules those expectations cite.
 */
function owed(scenario: Scenario, expectations: CountedExpectation[]): Scenario {
  if (!expectations.length) return scenario;
  return { ...scenario, successCriteria: expectations.map(expectation => `${expectation.letter} — ${oneLine(expectation.text)}`).join('; '),
    requirementIds: [...new Set(expectations.flatMap(expectation => expectation.requirementIds))] };
}

/** The verified owner rules a situation rests on, knowledge first. Internal prompt rules (a machine output format) are never shown. */
function rulesOf(record: Experiment, scenario: Scenario, register: Map<string, RuleRef>): RuleRef[] {
  const requirements = new Map(record.requirements.map(item => [item.id, item]));
  return [...new Set(scenario.requirementIds)].flatMap(id => {
    const requirement = requirements.get(id);
    return requirement && !internalPromptRule(record.sources, requirement) ? register.get(id) ?? [] : [];
  }).sort((a, b) => Number(a.prompt) - Number(b.prompt) || a.number - b.number);
}

/**
 * What the agent had to do: for a failed prompt-rule check alone, the one violated rule; otherwise the
 * situation's own criteria, else the words of its first rule. Null when the record says none of it.
 */
function expectedOf(record: Experiment, scenario: Scenario, kind: FailureExplanation['kind'], violated: RuleRef | undefined, register: Map<string, RuleRef>): string | null {
  if (kind === 'rules') return violated ? `соблюдать правило «${violated.quote}»` : null;
  const criteria = oneLine(scenario.successCriteria ?? '');
  if (criteria) return criteria;
  const first = rulesOf(record, scenario, register)[0];
  return first ? oneLine(record.requirements.find(item => item.id === first.requirementId)?.text ?? '') || null : null;
}

/** A check derived from a card's reference (contracts.ts referenceChecks): the only code check a card of the library carries. */
const isReferenceCheck = (id: string) => id.startsWith('ref_');
