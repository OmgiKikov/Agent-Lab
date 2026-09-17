import { MACHINE_FORMAT, type Experiment, type MetricAssessment, type Requirement, type Scenario, type Trial, verbatimSpanAt } from './contracts.js';
import { agentMetricResult, automaticTrialResult } from './outcomes.js';
import { AGREED_RATIONALE_PREFIX } from './judge.js';
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
/**
 * The status line that stands where an agent reply would be quoted. It is never wrapped in «…»:
 * a surface that quoted it would state that the agent said these words.
 */
export const UNVERIFIED_REPLY = 'реплика агента не подтверждена цитатой';

export type ExplanationRole = 'title' | 'example' | 'expected' | 'said' | 'rule' | 'more' | 'violated' | 'unverified';
export interface ExplanationRow { role: ExplanationRole; indent: number; text: string }
/** One owner rule: its number in the owner's materials and where to find it. */
export interface RuleRef {
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
  /** The verified agent reply; null when it could not be shown verbatim. */
  said: { seq: number; quote: string; judgeCited: boolean } | null;
  /** Verified rules shown or counted, knowledge first; unverified ones are only counted. */
  rules: RuleRef[];
  unverifiedRules: number;
  moreRules: number;
  /** The one registered prompt rule the failed prompt-rule check quotes; absent when it cannot be named uniquely. */
  violated?: RuleRef;
  rows: ExplanationRow[];
  lines: string[];
}

const GOAL = 'goal_attainment';
const COMPLIANCE = 'prompt_compliance';
/** A «…» span of the judge's rationale long enough to identify a rule. */
const QUOTED_SPAN = /«([^«»]{12,})»/g;
/**
 * How close a span must be before it may name a rule. Twelve characters is a coincidence in Russian
 * rule text («оплата картой» is 13), and the row asserts the rule flatly, so a near-miss must stay
 * unnamed: a span inside a rule has to cover most of it, and a rule inside a long judge span has to
 * be long enough to be that rule and not a common phrase.
 */
const MIN_SPAN_RATIO = 0.6;
const MIN_CONTAINED_QUOTE = 24;
const RULE_FORMS: [string, string, string] = ['правило', 'правила', 'правил'];
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
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
      quote: collapse(row.span), prompt: row.source.kind === 'prompt',
    });
  }
  return register;
}

/** `Правило 7 · Возврат покупки: «…»`; the line is named only for a source of several lines. */
export function ruleText(rule: RuleRef, word = 'Правило'): string {
  return `${word} ${rule.number} · ${collapse(rule.sourceName)}${rule.line === null ? '' : `, строка ${rule.line}`}: «${rule.quote}»`;
}

export function rowsToLines(rows: { indent: number; text: string }[]): string[] {
  return rows.map(row => ' '.repeat(row.indent) + row.text);
}

function assessment(trial: Trial, metricId: string): MetricAssessment | undefined {
  return trial.assessments?.find(item => item.metricId === metricId);
}

/**
 * The agent reply behind the verdict, checked against the stored event: the first cited
 * agent reply; a reply named only by evidence is shown whole; otherwise the last reply,
 * marked as not chosen by the judge.
 */
function saidRow(trial: Trial, cited: MetricAssessment | undefined): { row: ExplanationRow; said: FailureExplanation['said'] } {
  const replies = trial.events.filter(event => event.type === 'assistant' && typeof event.text === 'string' && collapse(event.text));
  const reply = (seq: number) => replies.find(event => event.seq === seq);
  const shown = (seq: number, quote: string, judgeCited: boolean): ReturnType<typeof saidRow> => ({
    row: { role: 'said', indent: 2, text: `Сказал (реплика #${seq}${judgeCited ? '' : ', судья не указал реплику'}): «${quote}»` },
    said: { seq, quote, judgeCited },
  });
  const citation = cited?.citations?.find(item => reply(item.seq));
  if (citation) {
    return reply(citation.seq)?.text?.includes(citation.quote)
      ? shown(citation.seq, collapse(citation.quote), true)
      : { row: { role: 'unverified', indent: 2, text: `Сказал (реплика #${citation.seq}): ${UNVERIFIED}` }, said: null };
  }
  const evidence = cited && !cited.citations ? cited.evidence.map(reply).find(Boolean) : undefined;
  if (evidence) return shown(evidence.seq, collapse(evidence.text ?? ''), true);
  const last = replies.at(-1);
  if (last) return shown(last.seq, collapse(last.text ?? ''), false);
  return { row: { role: 'unverified', indent: 2, text: 'Сказал: в записи нет ответа агента.' }, said: null };
}

const machineFormat = (record: Experiment, requirement: Requirement) =>
  record.sources.find(source => source.id === requirement.sourceId)?.kind === 'prompt' && MACHINE_FORMAT.test(requirement.quote);

/**
 * The prompt rule a failed prompt-rule check names: the «…» spans of its rationale (the agreed
 * prefix removed) are matched against registered, observable prompt rules. A match must be exact or
 * near-exact, and exactly one distinct rule may match; a weak match, none or several name nothing,
 * so nothing is guessed.
 */
function violatedRule(record: Experiment, trial: Trial, register: Map<string, RuleRef>): RuleRef | undefined {
  if (agentMetricResult(trial, COMPLIANCE, record.humanReviews) !== 'fail') return undefined;
  const rationale = (assessment(trial, COMPLIANCE)?.rationale ?? '').replace(AGREED_RATIONALE_PREFIX, '');
  const normal = (value: string) => collapse(value).toLowerCase();
  const spans = [...rationale.matchAll(QUOTED_SPAN)].map(match => normal(match[1] ?? '')).filter(span => span.length >= 12);
  const found = new Map<number, RuleRef>();
  for (const requirement of record.requirements) {
    const rule = register.get(requirement.id);
    if (!rule?.prompt || machineFormat(record, requirement)) continue;
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
 * for it. `trial` picks the attempt (a cause example); otherwise the first attempt whose goal
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
  const attempts = record.trials.filter(item => item.scenarioId === scenario.id);
  const chosen = trial ?? attempts.find(goalFailed) ?? attempts.find(rulesFailed);
  if (!chosen || chosen.scenarioId !== scenario.id) return null;
  const kind = hasGoal && goalFailed(chosen) && rulesFailed(chosen) ? 'both' : goalFailed(chosen) ? 'goal' : rulesFailed(chosen) ? 'rules' : null;
  if (!kind) return null;

  const cited = kind === 'rules' ? assessment(chosen, COMPLIANCE)
    : assessment(chosen, GOAL) ?? chosen.assessments?.find(item => item.result === 'fail' && agentMetrics.includes(item.metricId));
  const details = detailRows(record, scenario, chosen, kind, cited);
  const rows: ExplanationRow[] = [{ role: 'title', indent: 0, text: `✗ ${collapse(scenario.title)}` }, ...details.rows];
  return {
    scenarioId: scenario.id, trialId: chosen.id, title: scenario.title, kind, said: details.said,
    rules: details.rules, unverifiedRules: details.unverifiedRules, moreRules: details.moreRules,
    ...(details.violated ? { violated: details.violated } : {}), rows, lines: rowsToLines(rows),
  };
}

type DetailKind = FailureExplanation['kind'] | 'pass';
interface Details extends Pick<FailureExplanation, 'said' | 'rules' | 'unverifiedRules' | 'moreRules' | 'violated'> { rows: ExplanationRow[] }

/**
 * The F1 detail rows of one attempt, without its title: what the agent had to do, what it said
 * (the reply `cited` points at), the owner rules and, for a failed goal, the violated prompt rule.
 * A double failure («оба») takes the goal rows and always says its second half: the named rule,
 * or a row that the rules were broken but the rule cannot be named. A pass never names a violated rule.
 */
function detailRows(record: Experiment, scenario: Scenario, chosen: Trial, kind: DetailKind, cited: MetricAssessment | undefined): Details {
  const register = ruleRegister(record);
  const requirements = new Map(record.requirements.map(item => [item.id, item]));
  // Internal machine-format prompt rules are never shown or counted; their register numbers stay.
  const ids = [...new Set(scenario.requirementIds)].filter(id => { const item = requirements.get(id); return !item || !machineFormat(record, item); });
  const rules = ids.flatMap(id => requirements.has(id) ? register.get(id) ?? [] : [])
    .sort((a, b) => Number(a.prompt) - Number(b.prompt) || a.number - b.number);
  const unverifiedRules = ids.length - rules.length;
  const listed: (RuleRef | null)[] = [...rules, ...Array<null>(unverifiedRules).fill(null)];
  const shownRules = listed.slice(0, 2);
  const moreRules = listed.length - shownRules.length;
  const violated = kind === 'pass' ? undefined : violatedRule(record, chosen, register);

  const rows: ExplanationRow[] = [];
  const criteria = collapse(scenario.successCriteria ?? '');
  const firstRule = shownRules.find((rule): rule is RuleRef => rule !== null);
  if (kind === 'rules') {
    rows.push(violated
      ? { role: 'expected', indent: 2, text: `Должен был: соблюдать ${ruleText(violated, 'правило')}` }
      : { role: 'unverified', indent: 2, text: `Должен был: соблюдать правила из ваших материалов — ${UNVERIFIED}` });
  } else if (criteria) {
    rows.push({ role: 'expected', indent: 2, text: `Должен был: ${criteria}` });
  } else if (firstRule) {
    rows.push({ role: 'expected', indent: 2, text: `Должен был (из правила): ${collapse(requirements.get(firstRule.requirementId)?.text ?? '')}` });
  } else {
    rows.push({ role: 'unverified', indent: 2, text: 'Должен был: ожидание не записано в ситуации.' });
  }

  const { row, said } = saidRow(chosen, cited);
  rows.push(row);

  if (!listed.length) rows.push({ role: 'unverified', indent: 2, text: 'Правило: у ситуации нет правила из ваших материалов.' });
  for (const rule of shownRules) {
    rows.push(rule ? { role: 'rule', indent: 2, text: ruleText(rule) } : { role: 'unverified', indent: 2, text: `Правило: ${UNVERIFIED}` });
  }
  if (moreRules) rows.push({ role: 'more', indent: 2, text: `и ещё ${moreRules} ${pluralForm(moreRules, RULE_FORMS)}` });
  if (kind !== 'rules' && kind !== 'pass' && violated && !shownRules.some(rule => rule?.number === violated.number)) {
    rows.push({ role: 'violated', indent: 2, text: ruleText(violated, 'Нарушено правило') });
  } else if (kind === 'both' && !violated) {
    rows.push({ role: 'unverified', indent: 2, text: `Нарушены правила промпта — ${UNVERIFIED}` });
  }
  return { rows, said, rules, unverifiedRules, moreRules, ...(violated ? { violated } : {}) };
}

/**
 * The evidence of the agreement block (UI-SPEC F10): the F1 detail rows of one attempt, read on
 * the judge's recorded judgment only. A failure is explained exactly as phase 2 explains it; a pass
 * quotes the reply the judge cited (else the last reply) and never names a violated rule. Every human review is removed first, so the owner's own mark
 * can neither hide nor rewrite the evidence the owner is asked to judge.
 */
export function situationEvidence(record: Experiment, scenario: Scenario, trial: Trial, metricId: string): ExplanationRow[] {
  const judged: Experiment = { ...record, humanReviews: [] };
  const cited = assessment(trial, metricId);
  if (cited?.result === 'pass') return detailRows(judged, scenario, trial, 'pass', cited).rows;
  if (cited?.result !== 'fail') return [];
  const explanation = failureExplanation(judged, scenario, trial);
  if (explanation) return explanation.rows.filter(row => row.role !== 'title');
  return detailRows(judged, scenario, trial, 'goal', cited).rows;
}

/** The same block as a cause example: titled `Пример:` and indented three more columns. */
export function exampleRows(explanation: FailureExplanation): ExplanationRow[] {
  return explanation.rows.map(row => row.role === 'title'
    ? { role: 'example', indent: row.indent + 3, text: `Пример: ${collapse(explanation.title)}` }
    : { ...row, indent: row.indent + 3 });
}
