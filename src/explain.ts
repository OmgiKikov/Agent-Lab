import { type Experiment, type MetricAssessment, type Scenario, type Trial, verbatimSpan } from './contracts.js';
import { agentMetricResult, automaticTrialResult } from './outcomes.js';
import { pluralForm } from './plural.js';

/*
 * Why a situation failed, in the owner's words: what the agent had to do, what it said, and
 * which of the owner's rules the situation rests on. Built from the stored record only: no
 * model call, so old runs are explained as soon as they are opened. Every part is checked
 * against the record (the reply against its event, a rule quote against its source); a part
 * that fails its check is replaced by a named «не подтверждено» row, never guessed.
 * Pure: no I/O, no escaping, raw text; every surface escapes at its own boundary. Imports only
 * contracts.js, outcomes.js, comparison.js, judge.js and plural.js; it must not import
 * experiment.ts, quality.ts or result-view.ts.
 */
export const UNVERIFIED = 'объяснение не подтверждено цитатой';

export type ExplanationRole = 'title' | 'example' | 'expected' | 'said' | 'rule' | 'more' | 'violated' | 'cut' | 'unverified';
export interface ExplanationRow { role: ExplanationRole; indent: number; text: string }
/** One owner rule: its number in the owner's materials and where to find it. */
export interface RuleRef {
  number: number; requirementId: string; sourceId: string; sourceName: string;
  /** 1-based line of the quote start; null for a one-line source. */
  line: number | null;
  /** The source's own characters, whitespace runs collapsed to one space. */
  quote: string;
  prompt: boolean;
}
export interface FailureExplanation {
  scenarioId: string; trialId: string; title: string;
  /** goal: the situation goal failed; rules: only the prompt-rule check failed. */
  kind: 'goal' | 'rules';
  /** The verified agent reply; null when it could not be shown verbatim. */
  said: { seq: number; quote: string; judgeCited: boolean } | null;
  /** Verified rules shown or counted, knowledge first; unverified ones are only counted. */
  rules: RuleRef[];
  unverifiedRules: number;
  moreRules: number;
  violated?: RuleRef;
  judgedBeforeSeq?: number;
  rows: ExplanationRow[];
  lines: string[];
}

const GOAL = 'goal_attainment';
const RULE_FORMS: [string, string, string] = ['правило', 'правила', 'правил'];
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

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
    const span = source ? verbatimSpan(source.content, requirement.quote) : undefined;
    if (!source || span === undefined) return [];
    const offset = source.content.indexOf(span);
    return offset < 0 ? [] : [{ requirement, index, sourceIndex, source, span, offset }];
  }).sort((a, b) => a.sourceIndex - b.sourceIndex || a.offset - b.offset || a.index - b.index);
  const register = new Map<string, RuleRef>();
  for (const row of rows) {
    if (register.has(row.requirement.id)) continue;
    const multiline = /\n/.test(row.source.content.trim());
    register.set(row.requirement.id, {
      number: register.size + 1, requirementId: row.requirement.id, sourceId: row.source.id, sourceName: row.source.name,
      line: multiline ? row.source.content.slice(0, row.offset).split('\n').length : null,
      quote: collapse(row.span), prompt: row.source.kind === 'prompt',
    });
  }
  return register;
}

/** `Правило 7 · Возврат покупки: «…»`; the line is named only for a multi-line source. */
export function ruleText(rule: RuleRef, word = 'Правило'): string {
  return `${word} ${rule.number} · ${collapse(rule.sourceName)}${rule.line === null ? '' : `, строка ${rule.line}`}: «${rule.quote}»`;
}

export function rowsToLines(rows: ExplanationRow[]): string[] {
  return rows.map(row => ' '.repeat(row.indent) + row.text);
}

function assessment(trial: Trial, metricId: string): MetricAssessment | undefined {
  return trial.assessments?.find(item => item.metricId === metricId);
}

/** The agent reply the judge cited, checked against the stored event. */
function saidRow(trial: Trial, cited: MetricAssessment | undefined): { row: ExplanationRow; said: FailureExplanation['said'] } {
  const replies = trial.events.filter(event => event.type === 'assistant' && typeof event.text === 'string');
  const citation = cited?.citations?.find(item => replies.some(event => event.seq === item.seq));
  if (citation) {
    const quote = collapse(citation.quote);
    return { row: { role: 'said', indent: 2, text: `Сказал (реплика #${citation.seq}): «${quote}»` }, said: { seq: citation.seq, quote, judgeCited: true } };
  }
  const last = replies.filter(event => collapse(event.text ?? '')).at(-1);
  if (last) {
    const quote = collapse(last.text ?? '');
    return { row: { role: 'said', indent: 2, text: `Сказал (реплика #${last.seq}, судья не указал реплику): «${quote}»` }, said: { seq: last.seq, quote, judgeCited: false } };
  }
  return { row: { role: 'unverified', indent: 2, text: 'Сказал: в записи нет ответа агента.' }, said: null };
}

/**
 * The explanation of one failed situation, or null when the record holds no failed attempt
 * for it. `trial` picks the attempt (a cause example); otherwise the first failed one is used.
 */
export function failureExplanation(record: Experiment, scenario: Scenario, trial?: Trial): FailureExplanation | null {
  const reviews = record.humanReviews;
  const hasGoal = scenario.metrics?.some(metric => metric.subject === 'agent' && metric.id === GOAL) ?? false;
  const goalFailed = (item: Trial) => hasGoal ? agentMetricResult(item, GOAL, reviews) === 'fail' : automaticTrialResult(scenario, item, reviews) === 'fail';
  const attempts = record.trials.filter(item => item.scenarioId === scenario.id);
  const chosen = trial ?? attempts.find(goalFailed);
  if (!chosen || chosen.scenarioId !== scenario.id || !goalFailed(chosen)) return null;
  const register = ruleRegister(record);
  const rules = [...new Set(scenario.requirementIds)].flatMap(id => register.get(id) ?? [])
    .sort((a, b) => Number(a.prompt) - Number(b.prompt) || a.number - b.number);
  const rows: ExplanationRow[] = [{ role: 'title', indent: 0, text: `✗ ${collapse(scenario.title)}` }];
  rows.push({ role: 'expected', indent: 2, text: `Должен был: ${collapse(scenario.successCriteria ?? '')}` });
  const { row, said } = saidRow(chosen, assessment(chosen, GOAL));
  rows.push(row);
  for (const rule of rules.slice(0, 2)) rows.push({ role: 'rule', indent: 2, text: ruleText(rule) });
  const moreRules = Math.max(0, rules.length - 2);
  if (moreRules) rows.push({ role: 'more', indent: 2, text: `и ещё ${moreRules} ${pluralForm(moreRules, RULE_FORMS)}` });
  return {
    scenarioId: scenario.id, trialId: chosen.id, title: scenario.title, kind: 'goal', said, rules, unverifiedRules: 0, moreRules,
    rows, lines: rowsToLines(rows),
  };
}
