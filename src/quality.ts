import type { Experiment, Scenario, Trial, UserMode } from './contracts.js';
import { fingerprint } from './contracts.js';
import { agentRubricResult, automaticTrialResult, latestHumanReviews, measured, measurementUsable, observedRecord, simulatorUsable } from './outcomes.js';
import { awaitingVerdict, cardOutcome, humanFindings, isAgentFailure, verdictSummary, type VerdictSummary } from './comparison.js';

/*
 * The first screen. One question — "how good is the agent on these cards?" — answered in
 * the order a person reads it: the accuracy per card, the accuracy per criterion, why it
 * failed (top causes with a quote each), what the judge could not decide, what a human has
 * to look at (only the disputed part), and one line of limits. Nothing here is a new
 * number: every figure is derived from the same outcome helpers that CI, comparisons and
 * the verdict use, so the demo screen cannot disagree with the detailed evidence.
 */
export interface QualityMetric {
  id: string; name: string; kind: 'code' | 'rubric';
  /** Dialogues, not cards: a card may be measured in several modes. */
  passed: number; failed: number; unknown: number; total: number;
  /** passed / (passed + failed); null when nothing was decided. */
  accuracy: number | null;
}
export interface QualityCause {
  name: string; description: string; stage?: string; dialogues: number;
  /** The card title and one cited reason from the first dialogue of the cluster. */
  example?: { trialId: string; card: string; quote: string; seq?: number };
  promptQuotes: string[];
}
export interface QualitySummary {
  /** Cards decided across all measured modes: pass only when every usable dialogue passed. */
  cards: { passed: number; failed: number; unknown: number; notReached: number; total: number; accuracy: number | null };
  metrics: QualityMetric[];
  causes: QualityCause[];
  /** How sure the automatic verdict is: decided dialogues vs those the judge left unknown or a human disputes. */
  judge: { decided: number; unknown: number; disputed: number; label: string };
  /** Unique dialogues needing review. Categories may overlap. */
  humanQueue: { unknownJudgments: number; disagreements: number; simulatorFlags: number; total: number; pendingFailures: number };
  /** Explicit complete reviews of individual dialogues; partial and legacy reviews do not count. */
  human: { reviewed: number; total: number };
  scope: { cards: number; dialogues: number; modes: UserMode[]; provenance: string; target: string; judgeModel?: string };
  cost: { usd: number | null; calls: number; elapsedMs: number };
  /** One sentence of limits; the detailed reasons stay in the verdict. */
  limits: string;
  headline: string;
}

const modeNames: Record<UserMode, string> = { static: 'одна реплика', scripted: 'по сценарию', reactive: 'живой пользователь' };
const rate = (passed: number, failed: number): number | null => passed + failed ? passed / (passed + failed) : null;
export const percent = (value: number | null): string => value === null ? '—' : `${Math.round(value * 100)}%`;
/** Russian plural: plural(2, ['диалог', 'диалога', 'диалогов']) → «2 диалога». */
export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10, mod100 = n % 100;
  const form = mod10 === 1 && mod100 !== 11 ? forms[0] : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? forms[1] : forms[2];
  return `${n} ${form}`;
}
export const dialogues = (n: number) => plural(n, ['диалог', 'диалога', 'диалогов']);
export const cardsWord = (n: number) => plural(n, ['карточка', 'карточки', 'карточек']);
const cardsOf = (n: number) => plural(n, ['карточки', 'карточек', 'карточек']);

function metricRows(record: Experiment): QualityMetric[] {
  // Only identical rubric definitions share a row; labels alone do not define a criterion.
  const rows = new Map<string, QualityMetric>();
  const reviews = latestHumanReviews(record);
  const bump = (row: QualityMetric, result: 'pass' | 'fail' | 'unknown') => { row.total++; if (result === 'pass') row.passed++; else if (result === 'fail') row.failed++; else row.unknown++; };
  const usable = (scenario: Scenario | undefined, trial: Trial) => measurementUsable(scenario, trial, record.humanReviews);
  for (const trial of record.trials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!scenario || !measured(trial)) continue;
    if (scenario.checks.length) {
      const row = rows.get('code') ?? { id: 'code', name: 'Точные проверки · код', kind: 'code', passed: 0, failed: 0, unknown: 0, total: 0, accuracy: null };
      rows.set('code', row);
      bump(row, !usable(scenario, trial) ? 'unknown' : trial.outcome === 'pass' ? 'pass' : trial.outcome === 'fail' ? 'fail' : 'unknown');
    }
    for (const metric of (scenario.metrics ?? []).filter(m => m.subject === 'agent')) {
      const key = `rubric:${fingerprint(metric)}`;
      const row = rows.get(key) ?? { id: metric.id, name: metric.name, kind: 'rubric', passed: 0, failed: 0, unknown: 0, total: 0, accuracy: null };
      rows.set(key, row);
      const human = reviews.get(`${trial.id}|metric:${metric.id}`)?.verdict;
      if (human === 'invalid') continue;
      const result = human ?? trial.assessments?.find(a => a.metricId === metric.id)?.result;
      bump(row, !usable(scenario, trial) || !result ? 'unknown' : result);
    }
  }
  return [...rows.values()].map(row => ({ ...row, accuracy: rate(row.passed, row.failed) }))
    .sort((a, b) => Number(b.kind === 'code') - Number(a.kind === 'code'));
}

/** Cut at a sentence boundary so a quoted reason never ends mid-word on the first screen. */
export function shorten(text: string, limit = 220): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf(': '));
  return `${(stop > limit / 2 ? head.slice(0, stop + 1) : head.replace(/\s+\S*$/, '')).trim()}…`;
}
/** The reason a person would quote first: the failed exact check, otherwise the failed agent rubric's cited rationale. */
function firstReason(record: Experiment, trial: Trial): { quote: string; seq?: number } {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const check = trial.checks.find(c => !c.passed);
  if (check) return { quote: check.evidence || check.description };
  const assessment = trial.assessments?.find(a => a.result === 'fail' && scenario?.metrics?.some(m => m.id === a.metricId && m.subject === 'agent'));
  if (assessment) return { quote: shorten(assessment.rationale.replace(/^Совпало \d\/\d оценок этой рубрики в свежих сессиях; это не проверка правильности\.\s*/, '').replace(/^Pass condition is not met:\s*/i, '')), seq: assessment.evidence[0] };
  return { quote: trial.reason };
}

function causes(record: Experiment, v: VerdictSummary): QualityCause[] {
  const title = (trial: Trial) => record.scenarios.find(s => s.id === trial.scenarioId)?.title ?? trial.scenarioId;
  const clusters = (record.failureModes ?? []).map(mode => {
    const trials = mode.trialIds.map(id => record.trials.find(t => t.id === id)).filter((t): t is Trial => !!t);
    const first = trials[0];
    return { name: mode.name, description: mode.description, stage: mode.stage, dialogues: trials.length, promptQuotes: mode.promptQuotes ?? [],
      ...(first ? { example: { trialId: first.id, card: title(first), ...firstReason(record, first) } } : {}) };
  }).sort((a, b) => b.dialogues - a.dialogues);
  if (clusters.length) return clusters;
  // Before clustering ran (or when it found nothing), the weakest criteria are the causes we can name.
  return v.weakSpots.map(spot => {
    const failing = record.trials.find(t => spot.kind === 'check' ? t.checks.some(c => !c.passed && c.description === spot.description)
      : t.assessments?.some(a => a.result === 'fail' && record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.some(m => m.id === a.metricId && m.name === spot.description)));
    return { name: spot.description, description: spot.kind === 'check' ? 'Точная проверка не пройдена.' : 'Рубрика агента не выполнена по оценке судьи.', stage: spot.stage, dialogues: spot.failures, promptQuotes: [],
      ...(failing ? { example: { trialId: failing.id, card: title(failing), ...firstReason(record, failing) } } : {}) };
  });
}

const limitTexts: Record<string, string> = {
  demo: 'сценарное демо', all_synthetic: 'все карточки синтетические', no_human: 'судья не сверен с человеком', few_graded: 'мало оценённых диалогов',
  small_sample: 'карточек меньше ориентира 30', invalid: 'есть невалидные диалоги', rubric_only: 'только оценки модели, кода нет',
  judge_unknown: 'у судьи есть неясные оценки', simulator_flagged: 'есть пометки симулятора', incomplete_run: 'прогон неполный',
};

export function qualitySummary(input: Experiment): QualitySummary {
  const record = observedRecord(input);
  const v = verdictSummary(record);
  const reached = new Set(record.trials.filter(measured).map(t => t.scenarioId));
  const cardOutcomes = record.scenarios.map(s => ({ scenario: s, outcome: cardOutcome(record, s) }));
  const cards = { passed: cardOutcomes.filter(o => o.outcome === 'pass').length, failed: cardOutcomes.filter(o => o.outcome === 'fail').length,
    unknown: cardOutcomes.filter(o => reached.has(o.scenario.id) && o.outcome === 'unknown').length,
    notReached: cardOutcomes.filter(o => !reached.has(o.scenario.id)).length, total: record.scenarios.length, accuracy: null as number | null };
  cards.accuracy = rate(cards.passed, cards.failed);
  const metrics = metricRows(record);
  const rubricUnknown = metrics.filter(m => m.kind === 'rubric').reduce((n, m) => n + m.unknown, 0);
  const decided = record.trials.filter(t => automaticTrialResult(record.scenarios.find(s => s.id === t.scenarioId), t, record.humanReviews) !== 'unknown').length;
  const reviews = latestHumanReviews(record);
  const human = { reviewed: record.trials.filter(t => reviews.get(`${t.id}|dialogue`)?.reviewedDialogue === true).length, total: record.trials.length };
  const undecidedByHuman = (t: Trial) => !['pass', 'fail', 'invalid'].includes(reviews.get(`${t.id}|dialogue`)?.verdict ?? '');
  const scenarioOf = (t: Trial) => record.scenarios.find(s => s.id === t.scenarioId);
  const pending = awaitingVerdict(record);
  const unknownIds = record.trials.filter(t => measured(t) && agentRubricResult(scenarioOf(t), t, record.humanReviews) === 'unknown' && undecidedByHuman(t)).map(t => t.id);
  // A human overruling a simulator suspicion is the intended resolution, not a disagreement to revisit.
  const disagreementIds = new Set(humanFindings(record).filter(f => f.disagreement && f.subject !== 'simulator').map(f => f.trialId));
  const simulatorIds = record.trials.filter(t => pending.has(t.id) && measured(t) && !simulatorUsable(scenarioOf(t), t, record.humanReviews)).map(t => t.id);
  const disagreements = disagreementIds.size;
  const humanQueue = { unknownJudgments: unknownIds.length, disagreements, simulatorFlags: simulatorIds.length,
    total: new Set([...pending, ...unknownIds, ...disagreementIds, ...simulatorIds]).size,
    pendingFailures: record.trials.filter(t => pending.has(t.id) && isAgentFailure(record, t)).length };
  const measuredTrials = record.trials.filter(measured).length;
  const judgeLabel = !measuredTrials ? 'оценок ещё нет'
    : `автоматически оценено ${decided} из ${measuredTrials}; без решения ${measuredTrials - decided}`;
  const p = v.provenance;
  const provenance = [p.curated.cards ? `golden ${p.curated.cards}` : '', p.production.cards ? `из логов ${p.production.cards}` : '', p.synthetic.cards ? `синтетика ${p.synthetic.cards}` : ''].filter(Boolean).join(' · ') || 'карточек нет';
  const target = record.targetVersion ?? record.targetRelease ?? (record.target.kind === 'sandbox' ? 'песочница' : record.targetFingerprint?.slice(0, 12) ?? 'версия не названа');
  const judgeModel = record.trials.find(t => t.judgeAudit)?.judgeAudit?.model ?? record.settings.roles?.judge?.model ?? record.settings.judge?.model;
  const limitCodes = v.confidenceReasons.map(r => r.code).filter(code => code in limitTexts);
  const limits = limitCodes.length ? `Границы: ${[...new Set(limitCodes.map(c => limitTexts[c]!))].slice(0, 4).join(' · ')}.` : 'Границы: см. статистику.';
  const headline = `Справился с ${cards.passed} из ${cardsOf(cards.passed + cards.failed)} (${percent(cards.accuracy)}), ${cards.unknown} без решения, ${cards.notReached} не дошли; разобрано человеком ${human.reviewed} из ${plural(human.total, ['диалога', 'диалогов', 'диалогов'])}.`;
  return { cards, metrics, causes: causes(record, v), judge: { decided, unknown: rubricUnknown, disputed: disagreements, label: judgeLabel }, humanQueue,
    human,
    scope: { cards: record.scenarios.length, dialogues: measuredTrials, modes: record.settings.userModes, provenance, target, ...(judgeModel ? { judgeModel } : {}) },
    cost: { usd: record.usage.costUsd, calls: record.usage.calls, elapsedMs: record.trials.reduce((n, t) => n + t.elapsedMs, 0) }, limits, headline };
}

/** Plain text, one block per surface concern; each surface escapes at its own boundary. */
export function qualityLines(q: QualitySummary): { headline: string; metrics: string[]; causes: string[]; judge: string; queue: string; scope: string; limits: string } {
  const bar = (value: number | null, width = 10) => value === null ? '·'.repeat(width) : `${'█'.repeat(Math.round(value * width))}${'░'.repeat(width - Math.round(value * width))}`;
  return {
    headline: q.headline,
    metrics: q.metrics.map(m => `${bar(m.accuracy)} ${percent(m.accuracy).padStart(4)}  ${m.name} · ${m.passed}/${m.passed + m.failed}${m.unknown ? ` · неясно ${m.unknown}` : ''}`),
    causes: q.causes.slice(0, 3).map((c, i) => `${i + 1}. ${c.name} — ${dialogues(c.dialogues)}${c.example ? `. ${c.example.card}: «${c.example.quote}»` : ''}${c.promptQuotes[0] ? ` · правило промпта: «${c.promptQuotes[0]}»` : ''}`),
    judge: `Судья: ${q.judge.label}.`,
    queue: !q.humanQueue.total ? 'Ручная разметка не требуется: неразобранных диалогов нет.'
      : q.humanQueue.pendingFailures > 0 && q.causes.length ? `Разобрать: ${plural(q.causes.length, ['причину', 'причины', 'причин'])}. Откройте диалоги причин и поставьте каждому отдельный вердикт.`
        : `Разметить человеку: ${q.humanQueue.total} (неясных ${q.humanQueue.unknownJudgments}, расхождений ${q.humanQueue.disagreements}, пометок симулятора ${q.humanQueue.simulatorFlags}; ${plural(q.humanQueue.pendingFailures, ['провал', 'провала', 'провалов'])} без вердикта). Попросите разобрать диалог в чате или откройте его на доске.`,
    scope: `${cardsWord(q.scope.cards)} · ${dialogues(q.scope.dialogues)} · ${q.scope.modes.map(m => modeNames[m]).join(', ')} · ${q.scope.provenance} · версия ${q.scope.target}${q.scope.judgeModel ? ` · судья ${q.scope.judgeModel}` : ''} · ${q.cost.usd === null ? 'стоимость неизвестна' : `$${q.cost.usd.toFixed(2)}`} · ${Math.round(q.cost.elapsedMs / 60000)} мин`,
    limits: q.limits,
  };
}
