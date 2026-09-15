import type { Experiment, Requirement, Scenario, Source, TraceEvent, Trial, UserMode } from './contracts.js';
import { assessmentEventContent, describeCheck, fingerprint, verbatimSpan } from './contracts.js';
import { agentMetricResult, agentRubricResult, automaticTrialResult, latestHumanReviews, measured, measurementUsable, observedRecord, simulatorUsable } from './outcomes.js';
import { awaitingVerdict, cardOutcome, humanFindings, isAgentFailure, verdictSummary, type VerdictSummary } from './comparison.js';
import { draftHash } from './experiment.js';

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

export type ScoreBrief =
  | { status: 'insufficient'; heading: 'Недостаточно данных для гипотезы'; body: 'Добавьте требования владельца и хотя бы одно наблюдение из репозитория или записанного диалога.' }
  | { status: 'ready'; requirements: string[]; observations: string[]; unknowns: string[]; hypothesis: string; question: 'Проверим?' };

const insufficientScoreBrief = (): ScoreBrief => ({
  status: 'insufficient',
  heading: 'Недостаточно данных для гипотезы',
  body: 'Добавьте требования владельца и хотя бы одно наблюдение из репозитория или записанного диалога.',
});

export interface TestPlanLines {
  lines: string[];
  draftHash: string;
}

export interface TrialProofLines {
  trialId: string;
  scenarioId: string;
  outcome: Trial['outcome'];
  reason: string;
  lines: string[];
}

export interface DiscoveryBrief {
  status: 'error' | 'budget_exhausted' | 'partial' | 'ready' | 'insufficient';
  runId: string;
  total: number;
  coarse: number;
  selected: number;
  representatives: number;
  controls: number;
  lines: string[];
  fromRunId?: string;
  hypothesis?: string;
}

const planText = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
const field = (label: string, value: string): string[] => [label, ...planText(value).split('\n').map(line => `  ${line}`)];
const labelled = (label: string, value: string): string[] => {
  const [first = '', ...rest] = planText(value).split('\n');
  return [`${label}${first}`, ...rest.map(line => `  ${line}`)];
};

/** The exact one-test proposal shown before the owner accepts its definition. */
export function testPlanLines(record: Experiment): TestPlanLines {
  if (record.workflow !== 'evaluate') throw new Error('Показать для принятия можно только тест workflow evaluate.');
  if (record.phase !== 'review') throw new Error('Показать для принятия можно только незапущенный черновик.');
  if (record.scenarios.length !== 1) throw new Error('Для принятия нужен ровно один тест.');
  const scenario = record.scenarios[0]!;
  if (!scenario.user.goal.trim() || !scenario.user.opening.trim() || !scenario.successCriteria?.trim()) {
    throw new Error('У теста должны быть непустые ситуация, вход и критерий успеха.');
  }
  if (!scenario.goalObservation) throw new Error('У теста не указан конкретный канал наблюдения.');
  const observation = { reply: 'ответ агента (reply)', tool: 'результат инструмента (tool)', state: 'итоговое состояние (state)' }[scenario.goalObservation];
  const hash = draftHash(record);
  const user = scenario.user;
  const maxFollowUps = Math.min(user.maxFollowUps ?? record.settings.maxTurns - 1, record.settings.maxTurns - 1);
  const requirements = scenario.requirementIds.map(id => {
    const requirement = record.requirements.find(item => item.id === id);
    if (!requirement) return `- [${id}]`;
    const source = record.sources.find(item => item.id === requirement.sourceId);
    return `- [${id}] ${requirement.text}${source ? ` · ${source.name}: «${requirement.quote}»` : ''}`;
  });
  const situation = [
    `Название: ${scenario.title}`,
    `Цель: ${user.goal}`,
    `Факты: ${user.facts}`,
    `Поведение: ${user.behavior}`,
    `Максимум продолжений: ${maxFollowUps} (общий maxTurns: ${record.settings.maxTurns})`,
    ...(user.persona ? [`Персона: ${user.persona}`] : []),
    ...(user.characteristics?.length ? [`Характеристики:\n${user.characteristics.map(item => `- ${item}`).join('\n')}`] : []),
    ...(user.knows?.length ? [`Известно пользователю:\n${user.knows.map(item => `- ${item}`).join('\n')}`] : []),
    ...(user.cannotKnow?.length ? [`Пользователь не знает:\n${user.cannotKnow.map(item => `- ${item}`).join('\n')}`] : []),
    ...(user.answers?.length ? [`Ответы на уточнения:\n${user.answers.map(item => `- «${item.ifAsked}» → «${item.reply}»`).join('\n')}`] : []),
    ...(requirements.length ? [`Требования:\n${requirements.join('\n')}`] : []),
    ...(scenario.assumptions?.length ? [`Допущения:\n${scenario.assumptions.map(item => `- ${item}`).join('\n')}`] : []),
    ...(Object.keys(scenario.initialState.records).length || scenario.initialState.writableFields.length
      || scenario.initialState.transientFailures || scenario.initialState.external !== undefined
      ? [`Исходное состояние: ${JSON.stringify(scenario.initialState)}`] : []),
  ].join('\n');
  const input = [
    `Режимы: ${record.settings.userModes.join(', ')}`,
    `Начальная реплика: ${user.opening}`,
    ...(record.settings.userModes.includes('scripted') ? [user.script?.length
      ? `scripted · продолжения:\n${user.script.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
      : 'scripted · продолжений нет'] : []),
    ...(record.settings.userModes.includes('reactive') ? ['reactive · продолжения генерируются из карточки в ответ на агента'] : []),
    ...(record.settings.userModes.includes('static') ? ['static · только начальная реплика'] : []),
  ].join('\n');
  const success = [
    `Критерий результата: ${scenario.successCriteria}`,
    scenario.checks.length ? `Точные проверки:\n${scenario.checks.map(check => [
      `- [${check.id}] ${check.description}`,
      `  Условие: ${describeCheck(check)}`,
      ...(check.stage ? [`  Этап: ${check.stage}`] : []),
    ].join('\n')).join('\n')}` : 'Точные проверки: нет',
    scenario.metrics?.length ? `Рубрики судьи:\n${scenario.metrics.map(metric => [
      `- [${metric.id}] ${metric.name} · ${metric.subject}`,
      `  Описание: ${metric.description}`,
      `  PASS: ${metric.passCriteria}`,
      `  FAIL: ${metric.failCriteria}`,
      ...(metric.stage ? [`  Этап: ${metric.stage}`] : []),
    ].join('\n')).join('\n')}` : 'Рубрики судьи: нет',
  ].join('\n');
  return {
    draftHash: hash,
    lines: [
      'ТЕСТ',
      ...field('СИТУАЦИЯ', situation),
      '',
      ...field('ВХОД', input),
      '',
      ...field('УСПЕХ', success),
      '',
      ...field('НАБЛЮДЕНИЕ', observation),
      '',
      `Версия: ${hash.slice(0, 12)}`,
      '',
      'Этот тест действительно проверяет нужное поведение?',
    ],
  };
}

/** Compact proof copied only from one persisted dialogue and its saved test definition. */
export function trialProofLines(record: Experiment, trialId: string): TrialProofLines {
  const trial = record.trials.find(item => item.id === trialId);
  if (!trial) throw new Error(`Диалог ${trialId} не найден.`);
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  if (!scenario) throw new Error(`Тест ${trial.scenarioId} для диалога ${trial.id} не найден.`);
  const turns = trial.events.filter(event => event.type === 'user' || event.type === 'assistant').sort((a, b) => a.seq - b.seq)
    .flatMap(event => labelled(`#${event.seq} ${event.type === 'user' ? 'ПОЛЬЗОВАТЕЛЬ' : 'АГЕНТ'}: `, assessmentEventContent(event)));
  const checks = trial.checks.flatMap(check => [
    ...labelled(`${check.passed ? 'PASS' : 'FAIL'} [${check.id}] `, check.description),
    ...labelled('  Доказательство: ', check.evidence || '—'),
  ]);
  const rubrics = (trial.assessments ?? []).flatMap(assessment => {
    const name = scenario.metrics?.find(metric => metric.id === assessment.metricId)?.name ?? assessment.metricId;
    const citations = assessment.evidence.length ? assessment.evidence.map(seq => `#${seq}`).join(', ') : '—';
    return [
      ...labelled(`${assessment.result.toUpperCase()} [${assessment.metricId}] `, `${name} · события: ${citations}`),
      ...labelled('  Обоснование: ', assessment.rationale),
    ];
  });
  return {
    trialId: trial.id,
    scenarioId: scenario.id,
    outcome: trial.outcome,
    reason: trial.reason,
    lines: [
      'ДОКАЗАТЕЛЬСТВО',
      `Тест: ${planText(scenario.id)} · ${planText(scenario.title)}`,
      `Диалог: ${planText(trial.id)}`,
      `Исход: ${trial.outcome}`,
      ...labelled('Причина: ', trial.reason),
      '',
      'РЕПЛИКИ',
      ...(turns.length ? turns : ['—']),
      '',
      'ПРОВЕРКИ',
      ...(checks.length ? checks : ['—']),
      '',
      'ОЦЕНКИ',
      ...(rubrics.length ? rubrics : ['—']),
    ],
  };
}

/** Persisted exploratory selection summary. It never turns selection counts into quality metrics. */
export function discoveryBrief(record: Experiment): DiscoveryBrief {
  const discovery = record.discovery;
  const counts = {
    runId: record.id,
    total: discovery?.totalDialogues ?? record.dialogues.length,
    coarse: discovery?.observations.length ?? 0,
    selected: discovery?.selectedIds.length ?? 0,
    representatives: discovery?.representativeIds.length ?? 0,
    controls: discovery?.controlIds.length ?? 0,
  };
  const countLines = discovery ? [
    `Всего диалогов: ${counts.total}.`,
    `Первичный разбор: ${counts.coarse} из ${counts.total}; партии ${discovery.completedBatchCount} из ${discovery.callPlan.batches}.`,
    `Выбрано для подробной проверки: ${counts.selected}.`,
    `Примеры сигнала: ${counts.representatives}.`,
    `Контроли: ${counts.controls} — false-negative probe, а не оценка production accuracy.`,
    'Это отбор, не accuracy.',
  ] : [
    `Всего диалогов: ${counts.total}.`,
    'Первичный разбор: 0.',
    'Выбрано для подробной проверки: 0.',
    'Примеры сигнала: 0.',
    'Контроли: 0 — false-negative probe.',
    'Это отбор, не accuracy.',
  ];
  const citationIds = discovery?.hypothesis?.eventIds ?? discovery?.observations.flatMap(observation =>
    observation.citations.map(citation => ({ dialogueId: observation.dialogueId, seq: citation.seq }))
  ) ?? [];
  const seen = new Set<string>();
  const citations = citationIds.flatMap(citation => {
    const key = `${citation.dialogueId}:${citation.seq}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const message = record.dialogues.find(dialogue => dialogue.id === citation.dialogueId)?.messages[citation.seq];
    return message ? [`• диалог ${planText(citation.dialogueId)}, событие #${citation.seq}: «${planText(message.content)}»`] : [];
  });
  const evidenceLines = citations.length ? ['', 'ДОКАЗАТЕЛЬСТВА', ...citations] : [];
  if (!discovery) return { status: 'insufficient', ...counts,
    lines: ['НЕДОСТАТОЧНО ДАННЫХ', ...countLines, 'Сохранённого discovery-разбора нет.'] };
  if (discovery.phase === 'error') return { status: 'error', ...counts,
    lines: ['ОШИБКА DISCOVERY', planText(discovery.error ?? record.error ?? 'Discovery не завершён.'), ...countLines, ...evidenceLines] };
  if (discovery.phase === 'budget_exhausted') return { status: 'budget_exhausted', ...counts,
    lines: ['БЮДЖЕТ DISCOVERY ИСЧЕРПАН', planText(discovery.error ?? 'Лимит модельных вызовов исчерпан.'), ...countLines, ...evidenceLines] };
  if (discovery.phase === 'partial' || discovery.phase === 'running') return { status: 'partial', ...counts,
    lines: ['ЧАСТИЧНЫЙ РЕЗУЛЬТАТ DISCOVERY', planText(discovery.error ?? 'Discovery ещё не завершён.'), ...countLines, ...evidenceLines] };
  if (discovery.phase === 'ready' && discovery.hypothesis) {
    const focusSupport = new Set(discovery.hypothesis.eventIds.map(event => event.dialogueId)).size;
    const hypothesis = discovery.hypothesis.text.replace(/\nНАБЛЮДЕНИЕ: ответ агента \(reply\)\s*$/u, '').trim();
    return { status: 'ready', ...counts, fromRunId: record.id, hypothesis: discovery.hypothesis.text,
      lines: [
        `ПОВТОРЯЮЩИЙСЯ СИГНАЛ: ${focusSupport} из ${counts.total} — это отбор, не accuracy.`,
        ...countLines.slice(0, -1),
        ...evidenceLines,
        '',
        'ГИПОТЕЗА',
        ...planText(hypothesis).split('\n'),
        '',
        'НАБЛЮДЕНИЕ: ответ агента (reply)',
        '',
        'Проверим?',
      ] };
  }
  return { status: 'insufficient', ...counts,
    lines: ['НЕДОСТАТОЧНО ДАННЫХ', ...countLines, ...evidenceLines, 'Повторяющийся сигнал минимум в двух диалогах не подтверждён.'] };
}

type GroundedScore = {
  requirement: Requirement; source: Source; quote: string; trial: Trial;
  assessment: NonNullable<Trial['assessments']>[number]; event: TraceEvent;
};
const preview = (text: string): string => shorten(text.replace(/\s+/gu, ' ').trim(), 240);
const missingEvidence = (text: string): boolean => /наблюд|неяс|неизвест|отсутств|нет (?:данных|подтверждения|результата)|observable|observed|missing|state|tool|unclear|insufficient evidence/i.test(text);

function groundedScore(record: Experiment): GroundedScore | undefined {
  // Saved failure modes identify only a trial, not its metric/evidence/requirement chain.
  const resolve = (trial: Trial, result: 'fail' | 'unknown'): GroundedScore | undefined => {
    const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
    if (!scenario || scenario.requirementIds.length !== 1) return;
    const requirement = record.requirements.find(item => item.id === scenario.requirementIds[0]);
    const source = requirement && record.sources.find(item => item.id === requirement.sourceId);
    const quote = source && requirement ? verbatimSpan(source.content, requirement.quote) : undefined;
    if (!requirement || !source || !quote) return;
    for (const assessment of trial.assessments ?? []) {
      const supportedMetric = ['goal_attainment', 'reply_quality'].includes(assessment.metricId)
        || assessment.metricId === 'prompt_compliance' && source.kind === 'prompt';
      if (!supportedMetric || assessment.result !== result || !assessment.rationale.trim()
        || !scenario.metrics?.some(metric => metric.id === assessment.metricId && metric.subject === 'agent')) continue;
      // ponytail: lexical missing-evidence gate; replace it with a reason code if assessments gain one.
      if (result === 'unknown' && !missingEvidence(assessment.rationale)) continue;
      const event = assessment.evidence.map(seq => trial.events.find(item => item.seq === seq))
        .find((item): item is TraceEvent => !!item && item.type !== 'user' && item.type !== 'simulator' && !!assessmentEventContent(item).trim());
      if (!event) continue;
      return { requirement, source, quote, trial, assessment, event };
    }
  };
  for (const result of ['fail', 'unknown'] as const) for (const trial of record.trials) {
    const grounded = resolve(trial, result);
    if (grounded) return grounded;
  }
}

/** Compact evidence proposal; renderers escape external text at their terminal boundary. */
export function scoreBrief(input: Experiment): ScoreBrief {
  const record = observedRecord(input);
  if (record.questions.length) return insufficientScoreBrief();
  const grounded = groundedScore(record);
  if (!grounded) return insufficientScoreBrief();
  const { requirement, source, quote, trial, assessment, event } = grounded;
  const reference = `диалог ${trial.id}, событие #${event.seq}`;
  const labels: Record<TraceEvent['type'], string> = {
    user: 'Реплика пользователя', assistant: 'Ответ агента', simulator: 'Реплика симулятора', tool_call: 'Вызов инструмента',
    tool_result: 'Результат инструмента', error: 'Ошибка',
  };
  const status = { pass: 'ПРОЙДЕНО', fail: 'НЕ ПРОЙДЕНО', unknown: 'НЕЯСНО' } as const;
  const observations = [
    `${labels[event.type]} · ${reference}: «${preview(assessmentEventContent(event))}»`,
    `${assessment.metricId} — ${status[assessment.result]}: ${preview(assessment.rationale)} · ${reference}`,
  ].slice(0, 3);
  const missingGoal = trial.assessments?.find(item => item.metricId === 'goal_attainment' && item.result !== 'pass' && missingEvidence(item.rationale));
  const unknownSeq = missingGoal?.evidence.find(seq => trial.events.some(item => item.seq === seq));
  const unknowns = [
    ...(missingGoal && (trial.observation?.state === 'missing' || trial.observation?.tools === 'partial')
      ? [`НЕЯСНО · результат действия: ${trial.observation?.state === 'missing' ? 'состояние не наблюдалось' : 'состояние наблюдалось'}; ${trial.observation?.tools === 'partial' ? 'события инструментов наблюдались частично' : 'события инструментов наблюдались полностью'} · диалог ${trial.id}`]
      : []),
    ...(missingGoal?.result === 'unknown' ? [`goal_attainment — НЕЯСНО: ${preview(missingGoal.rationale)} · диалог ${trial.id}${unknownSeq === undefined ? '' : `, событие #${unknownSeq}`}`]
      : assessment.result === 'unknown' ? [`${assessment.metricId} — НЕЯСНО: ${preview(assessment.rationale)} · ${reference}`] : []),
  ].slice(0, 3);
  const mechanism = `${assessment.result === 'unknown' ? 'НЕЯСНО: ' : ''}${preview(assessment.rationale)}`;
  return {
    status: 'ready',
    requirements: [`${requirement.id} · источник ${source.id} (${preview(source.name)}): ${preview(requirement.text)} · точная цитата «${preview(quote)}»`],
    observations,
    unknowns,
    hypothesis: `Похоже, ${mechanism} Это может нарушать требование ${requirement.id} (источник ${source.id}); наблюдение — ${reference}.`,
    question: 'Проверим?',
  };
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
const stableMetricIds = new Set(['goal_attainment', 'prompt_compliance', 'reply_quality']);

function metricRows(record: Experiment): QualityMetric[] {
  // Service rubrics have run-wide identity; owner rubrics share a row only when their full definitions match.
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
      const key = `rubric:${stableMetricIds.has(metric.id) ? metric.id : fingerprint(metric)}`;
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
  const assessment = trial.assessments?.find(a => scenario?.metrics?.some(m => m.id === a.metricId && m.subject === 'agent')
    && agentMetricResult(trial, a.metricId, record.humanReviews) === 'fail');
  if (assessment) return { quote: shorten(assessment.rationale.replace(/^Совпало \d\/\d оценок этой рубрики в свежих сессиях; это не проверка правильности\.\s*/, '').replace(/^Pass condition is not met:\s*/i, '')), seq: assessment.evidence[0] };
  return { quote: trial.reason };
}

function causes(record: Experiment, v: VerdictSummary): QualityCause[] {
  const title = (trial: Trial) => record.scenarios.find(s => s.id === trial.scenarioId)?.title ?? trial.scenarioId;
  const clusters = (record.failureModes ?? []).flatMap(mode => {
    const trials = mode.trialIds.map(id => record.trials.find(t => t.id === id)).filter((t): t is Trial => !!t && isAgentFailure(record, t));
    const first = trials[0];
    return first ? [{ name: mode.name, description: mode.description, stage: mode.stage, dialogues: trials.length, promptQuotes: mode.promptQuotes ?? [],
      example: { trialId: first.id, card: title(first), ...firstReason(record, first) } }] : [];
  }).sort((a, b) => b.dialogues - a.dialogues);
  if (clusters.length) return clusters;
  // Before clustering ran (or when it found nothing), the weakest criteria are the causes we can name.
  return v.weakSpots.map(spot => {
    const failing = record.trials.find(t => spot.kind === 'check' ? t.checks.some(c => !c.passed && c.description === spot.description)
      : record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.some(m => m.name === spot.description && agentMetricResult(t, m.id, record.humanReviews) === 'fail'));
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
