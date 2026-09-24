import type { Experiment, Trial } from './contracts.js';
import { describeCheck, internalPromptRule } from './contracts.js';
import { assessmentEventContent } from './assessment.js';
import { automaticTrialResult } from './outcomes.js';
import { pluralForm } from './plural.js';
import { oneLine, safeText } from './text.js';
import { ruleRegister, ruleText, UNVERIFIED } from './explain.js';
import { draftHash } from './lab/record.js';
import { judgedScenario } from './card/legacy-v1.js';

/*
 * What a draft asks before it runs and what one dialogue proves after it: the expectation sheet of a
 * draft, the one-test proposal an owner accepts, and the proof lines of one stored dialogue. The
 * result of a run is not here: it is derived in run.ts and shown through result-view.ts.
 */
interface TestPlanLines {
  lines: string[];
  draftHash: string;
}

/** `expected` — «Должен: …»; `rule` — a verified owner rule; `unverified` — a named gap; `more` — the compact tail; `marker` — «ожидание изменено владельцем». */
export type ExpectationRole = 'expected' | 'rule' | 'unverified' | 'more' | 'marker';
interface ExpectationCard {
  scenarioId: string;
  title: string;
  /** `1.`, `12.` — the situation's position in the draft. */
  label: string;
  goal: string;
  details: { role: ExpectationRole; text: string }[];
  ownerEdited: boolean;
}
export interface ExpectationSheet {
  draftHash: string;
  count: number;
  /** `13 ситуаций` */
  countText: string;
  labelWidth: number;
  cards: ExpectationCard[];
  lines: string[];
  /** At most two rule rows per situation, and how many more there are. */
  compactLines(): string[];
}

interface TrialProofLines {
  trialId: string;
  scenarioId: string;
  outcome: Trial['outcome'];
  automaticVerdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  lines: string[];
}


const field = (label: string, value: string): string[] => [label, ...safeText(value).split('\n').map(line => `  ${line}`)];
const labelled = (label: string, value: string): string[] => {
  const [first = '', ...rest] = safeText(value).split('\n');
  return [`${label}${first}`, ...rest.map(line => `  ${line}`)];
};

const SITUATION_FORMS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const SHEET_RULE_FORMS: [string, string, string] = ['правило', 'правила', 'правил'];

/**
 * What the agent must do in every situation of a draft, in the owner's words: the goal, the
 * expectation that will be scored, and every owner rule the situation rests on. Built from the
 * record only, with the same rule numbering and row shape as the failure explanations, so the
 * owner sees the same `Правило N` before the run and after it.
 */
export function expectationSheet(record: Experiment): ExpectationSheet {
  if (record.workflow !== 'evaluate') throw new Error('Показать ожидания можно только для теста workflow evaluate.');
  if (record.phase !== 'review') throw new Error('Показать ожидания можно только для незапущенного черновика.');
  // The confirmation is bound to the draft's hash, which the start checks; the owner reads the expectations, never the hash.
  const hash = draftHash(record);
  const count = record.scenarios.length;
  const countText = `${count} ${pluralForm(count, SITUATION_FORMS)}`;
  const labelWidth = `${count}.`.length;
  if (!count) {
    const empty = ['Ситуаций пока нет.', 'Они появятся после подготовки: скажите в чате, что проверить.'];
    return { draftHash: hash, count, countText, labelWidth, cards: [], lines: empty, compactLines: () => [...empty] };
  }
  const register = ruleRegister(record);
  const requirements = new Map(record.requirements.map(item => [item.id, item]));
  const edited = new Set(record.ownerExpectationScenarioIds ?? []);
  const built = record.scenarios.map((scenario, index) => {
    const ids = [...new Set(scenario.requirementIds)]
      .filter(id => { const item = requirements.get(id); return !item || !internalPromptRule(record.sources, item); });
    const rules = ids.flatMap(id => requirements.has(id) ? register.get(id) ?? [] : [])
      .sort((a, b) => Number(a.prompt) - Number(b.prompt) || a.number - b.number);
    const criteria = oneLine(scenario.successCriteria ?? '');
    const must: { role: ExpectationRole; text: string } = criteria
      ? { role: 'expected', text: `Должен: ${criteria}` }
      : { role: 'unverified', text: 'Должен: ожидание не записано.' };
    const ruleRows: { role: ExpectationRole; text: string }[] = ids.length
      ? [...rules.map(rule => ({ role: 'rule' as const, text: ruleText(rule) })),
        ...Array.from({ length: ids.length - rules.length }, () => ({ role: 'unverified' as const, text: `Правило: ${UNVERIFIED}` }))]
      : [{ role: 'unverified', text: 'Правило: у ситуации нет правила из ваших материалов.' }];
    const ownerEdited = edited.has(scenario.id);
    const markerRows: { role: ExpectationRole; text: string }[] = ownerEdited
      ? [{ role: 'marker', text: 'Ожидание изменено владельцем — с прошлыми прогонами не сравнивается.' }] : [];
    const card: ExpectationCard = {
      scenarioId: scenario.id, title: oneLine(scenario.title), label: `${index + 1}.`,
      goal: `Ситуация: ${oneLine(scenario.user.goal)}`,
      details: [must, ...ruleRows, ...markerRows], ownerEdited,
    };
    return { card, must, ruleRows, markerRows };
  });
  const block = (card: ExpectationCard, details: { text: string }[]): string[] => [
    `${card.label.padStart(labelWidth)} ${card.goal}`,
    ...details.map(detail => `${' '.repeat(labelWidth + 1)}${detail.text}`),
  ];
  const head = `Что агент должен сделать: ${countText}. Номер правила — порядок в ваших материалах.`;
  const lines = [head, '', ...built.flatMap(item => [...block(item.card, item.card.details), ''])].slice(0, -1);
  const compactLines = (): string[] => [head, '', ...built.flatMap(item => {
    const shown = item.ruleRows.slice(0, 2);
    const hidden = item.ruleRows.length - shown.length;
    const more = hidden ? [{ text: `и ещё ${hidden} ${pluralForm(hidden, SHEET_RULE_FORMS)}` }] : [];
    return [...block(item.card, [item.must, ...shown, ...more, ...item.markerRows]), ''];
  })].slice(0, -1);
  return { draftHash: hash, count, countText, labelWidth, cards: built.map(item => item.card), lines, compactLines };
}

/**
 * The starting state of a one-test definition in words: each record with its fields, what the agent may change, the
 * tool failures it meets first; a value of the agent's own test environment as it is stored.
 */
function stateLines(state: Experiment['scenarios'][number]['initialState']): string[] {
  const records = Object.entries(state.records).map(([id, fields]) => `- ${id}: ${Object.entries(fields).map(([name, value]) => `${name} = ${String(value)}`).join(', ')}`);
  const external = Object.entries(state.external ?? {}).map(([name, value]) => `- ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return [...(records.length ? ['Записи:', ...records] : []),
    ...(state.writableFields.length ? [`Агент может менять: ${state.writableFields.join(', ')}`] : []),
    ...(state.transientFailures ? [`Сбоев инструмента в начале: ${state.transientFailures}`] : []),
    ...(external.length ? ['Окружение агента:', ...external] : [])];
}

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
  const observation = { reply: 'ответ агента', tool: 'результат инструмента', state: 'итоговое состояние' }[scenario.goalObservation];
  const hash = draftHash(record);
  const user = scenario.user;
  const maxFollowUps = Math.min(user.maxFollowUps ?? record.settings.maxTurns - 1, record.settings.maxTurns - 1);
  const requirements = scenario.requirementIds.map(id => {
    const requirement = record.requirements.find(item => item.id === id);
    if (!requirement) return '- правило не найдено в материалах';
    const source = record.sources.find(item => item.id === requirement.sourceId);
    return `- ${requirement.text}${source ? ` · ${source.name}: «${requirement.quote}»` : ''}`;
  });
  const situation = [
    `Название: ${scenario.title}`,
    `Цель: ${user.goal}`,
    `Факты: ${user.facts}`,
    `Поведение: ${user.behavior}`,
    `Максимум продолжений: ${maxFollowUps} (всего ходов в разговоре: ${record.settings.maxTurns})`,
    ...(user.persona ? [`Персона: ${user.persona}`] : []),
    ...(user.characteristics?.length ? [`Характеристики:\n${user.characteristics.map(item => `- ${item}`).join('\n')}`] : []),
    ...(user.knows?.length ? [`Известно пользователю:\n${user.knows.map(item => `- ${item}`).join('\n')}`] : []),
    ...(user.cannotKnow?.length ? [`Пользователь не знает:\n${user.cannotKnow.map(item => `- ${item}`).join('\n')}`] : []),
    ...(user.answers?.length ? [`Ответы на уточнения:\n${user.answers.map(item => `- «${item.ifAsked}» → «${item.reply}»`).join('\n')}`] : []),
    ...(requirements.length ? [`Требования:\n${requirements.join('\n')}`] : []),
    ...(scenario.assumptions?.length ? [`Допущения:\n${scenario.assumptions.map(item => `- ${item}`).join('\n')}`] : []),
    ...(stateLines(scenario.initialState).length ? [`Исходное состояние:\n${stateLines(scenario.initialState).join('\n')}`] : []),
  ].join('\n');
  const input = [
    `Начальная реплика: ${user.opening}`,
    ...(record.settings.userModes.includes('scripted') ? [user.script?.length
      ? `Продолжения по сценарию:\n${user.script.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
      : 'Продолжений по сценарию нет'] : []),
    ...(record.settings.userModes.includes('reactive') ? ['Клиента играет Lab: продолжения — его ответы агенту по этой карточке'] : []),
    ...(record.settings.userModes.includes('static') ? ['Только начальная реплика'] : []),
  ].join('\n');
  const success = [
    `Критерий результата: ${scenario.successCriteria}`,
    scenario.checks.length ? `Точные проверки:\n${scenario.checks.map(check => [
      `- ${check.description}`,
      `  Условие: ${describeCheck(check)}`,
      ...(check.stage ? [`  Этап: ${check.stage}`] : []),
    ].join('\n')).join('\n')}` : 'Точные проверки: нет',
    scenario.metrics?.length ? `Что оценивает судья:\n${scenario.metrics.map(metric => [
      `- ${metric.name} · ${metric.subject === 'simulator' ? 'клиент в симуляции' : 'агент'}`,
      `  Описание: ${metric.description}`,
      `  Справился: ${metric.passCriteria}`,
      `  Не справился: ${metric.failCriteria}`,
      ...(metric.stage ? [`  Этап: ${metric.stage}`] : []),
    ].join('\n')).join('\n')}` : 'Что оценивает судья: ничего',
  ].join('\n');
  return {
    draftHash: hash,
    // The confirmation seals this exact definition by the draft's hash, which the start checks; the owner reads the definition.
    lines: [
      'Тест',
      ...field('Ситуация', situation),
      '',
      ...field('Вход', input),
      '',
      ...field('Успех', success),
      '',
      ...field('Наблюдение', observation),
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
  const automaticVerdict = automaticTrialResult(scenario, trial);
  const turns = trial.events.filter(event => event.type === 'user' || event.type === 'assistant').sort((a, b) => a.seq - b.seq)
    .flatMap(event => labelled(`#${event.seq} ${event.type === 'user' ? 'ПОЛЬЗОВАТЕЛЬ' : 'АГЕНТ'}: `, assessmentEventContent(event)));
  const checks = trial.checks.flatMap(check => [
    ...labelled(`${check.passed ? 'PASS' : 'FAIL'} [${check.id}] `, check.description),
    ...labelled('  Доказательство: ', check.evidence || '—'),
  ]);
  const rubrics = (trial.assessments ?? []).flatMap(assessment => {
    const name = judgedScenario(scenario, trial).metrics?.find(metric => metric.id === assessment.metricId)?.name ?? assessment.metricId;
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
    automaticVerdict,
    reason: trial.reason,
    lines: [
      'ДОКАЗАТЕЛЬСТВО',
      `Тест: ${safeText(scenario.id)} · ${safeText(scenario.title)}`,
      `Диалог: ${safeText(trial.id)}`,
      `Исход: ${trial.outcome}`,
      `Автоматический вердикт: ${automaticVerdict}`,
      ...labelled('Причина: ', trial.reason),
      '',
      'РЕПЛИКИ',
      ...(turns.length ? turns : ['—']),
      '',
      'ПРОВЕРКИ',
      ...(checks.length ? checks : ['—']),
      '',
      ...(trial.checkpoints?.length ? ['КОНТРОЛЬНЫЕ ТОЧКИ', ...trial.checkpoints.flatMap(cp => [
        `${({ pass: 'ВЫПОЛНЕНО', fail: 'НАРУШЕНО', unknown: 'НЕ ОПРЕДЕЛЕНО', not_applicable: 'НЕ ПРИМЕНИМО' })[cp.result]} [${cp.checkpointId}] · ${cp.role === 'required' ? 'обязательная' : 'диагностика'} · требование ${cp.requirementId} · события ${cp.evidence.map(seq => `#${seq}`).join(', ') || '—'}`,
        ...labelled('  Обоснование: ', cp.rationale),
      ]), ''] : []),
      'ОЦЕНКИ',
      ...(rubrics.length ? rubrics : ['—']),
    ],
  };
}
