import type { Experiment, Trial } from './contracts.js';
import type { EvidenceBundle } from './artifacts.js';
import { toHtml, toMarkdown, type Block, type CardItem, type DisagreementItem, type FailureItem, type Report, type Turn } from './blocks.js';
import { CALIBRATION_CAVEATS, conversationsText, disagreementText, exclusionsLine } from './card/calibration-view.js';
import type { FailureExplanation } from './explain.js';
import { coverageLine, sharePercent, uncoveredLine } from './miner/coverage.js';
import { countText } from './plural.js';
import { accuracyParts, alarmRow, realityParts, trustSegments } from './result-text.js';
import { buildResultView, type ResultCard, type ResultView } from './result-view.js';
import { situationBrief, situationNumber } from './card/view.js';
import { oneLine } from './text.js';

/*
 * The customer report: the result the owner reads in Pi, as one page for someone who never opened
 * Pi. It is built only from the ResultView of the run (plus the stored dialogues it quotes), in the
 * order a reader asks: how good is the agent, can I trust the number, where does it fail and why,
 * what was checked, and each failure with its evidence. The owner's next steps stay in the owner's
 * tools: the reader of this file cannot act on them. No ids, hashes or model internals on the page;
 * the machine snapshot (jsonReport) keeps those.
 */

const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dateText = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
};

/** The dialogue of one attempt, client and agent only, in the order it happened. */
function turnsOf(trial: Trial | undefined): Turn[] {
  return (trial?.events ?? []).filter(event => (event.type === 'user' || event.type === 'assistant') && oneLine(event.text ?? ''))
    .map(event => ({ who: event.type === 'user' ? 'Клиент' as const : 'Агент' as const, text: oneLine(event.text) }));
}

const example = (failure: FailureExplanation) => ({
  situation: oneLine(failure.title), expected: failure.expected ?? 'не записано в ситуации', said: failure.said?.quote ?? null,
  rule: (failure.violated ?? failure.rules[0])?.quote ?? null,
});

function chipOf(card: ResultCard, view: ResultView): CardItem['chip'] {
  if (card.control) return card.outcome === 'pass' ? { text: 'контроль ✓', tone: 'accent' } : { text: card.outcome === 'fail' ? 'контроль ✗' : 'контроль ?', tone: 'err' };
  if (card.outcome === 'pass') return { text: '✓ справился', tone: 'ok' };
  if (card.outcome === 'fail') return { text: '✗ не справился', tone: 'err' };
  const reason = view.notMeasured.reasons.find(item => item.scenarioIds.includes(card.scenarioId));
  return { text: reason ? `? не измерено — ${reason.label}` : '? ещё проверяется', tone: 'warn' };
}

/** «Почему ошибается»: each cause with up to three of its failures quoted; without causes, the failures themselves. */
function causesBlock(view: ResultView): Block[] {
  if (!view.failures.length) {
    return view.headline.decided ? [{ kind: 'paragraph', muted: false,
      text: `Ошибок нет. Это не гарантия для живых клиентов: проверено ${countText(view.headline.decided, SITUATIONS)}.` }] : [];
  }
  const items = view.topCauses.length
    ? view.topCauses.map(cause => ({ title: oneLine(cause.name), count: countText(cause.count, SITUATIONS),
      examples: view.failures.filter(failure => cause.scenarioIds.includes(failure.scenarioId)).slice(0, 3).map(example) }))
    : view.failures.slice(0, 3).map(failure => ({ title: oneLine(failure.title), count: '1 ситуация', examples: [example(failure)] }));
  return [{ kind: 'section', title: 'Почему ошибается', blocks: [{ kind: 'causes', items }] }];
}

function topicsBlock(view: ResultView): Block[] {
  const topics = view.topics;
  if (!topics?.rows.some(row => row.decided)) return [];
  const shares = topics.rows.some(row => row.share !== null);
  const rows = topics.rows.map(row => ({ muted: false, cells: [row.title, row.decided ? `${row.passed} из ${row.decided}` : '—', ...(shares ? [row.share === null ? '—' : sharePercent(row.share)] : [])] }));
  if (topics.uncovered) rows.push({ muted: true, cells: ['Не покрыто ситуациями', '—', sharePercent(topics.uncovered.share)] });
  return [{ kind: 'section', title: 'По темам', blocks: [{ kind: 'table', head: ['Тема', 'справился', ...(shares ? ['доля диалогов'] : [])], rows }] }];
}

/** How much of the logs the situations stand for: «15 ситуаций покрывают 9 из 11 тем — 94% диалогов. Не покрыты: …». */
function coverageSentence(view: ResultView): string[] {
  const line = view.topicCoverage && coverageLine(view.topicCoverage);
  if (!view.topicCoverage || !line) return [];
  const uncovered = uncoveredLine(view.topicCoverage);
  return [`${line}.${uncovered ? ` ${uncovered}.` : ''}`];
}

/** How the number was made and what it rests on, in plain sentences for the fine print. */
function basisBlock(bundle: EvidenceBundle, view: ResultView): Block {
  const { agreement, breakdown, coverage, scope, stability } = view;
  const lines = [
    'Ситуация засчитана, если агент выполнил запрос клиента и не нарушил правил своего промпта во всех разговорах этой ситуации. Не измеренные ситуации в процент не входят; контрольные ситуации проверяют связь и судью и в процент не входят.',
    `${countText(scope.cards, SITUATIONS)} · ${countText(scope.dialogues, ['разговор', 'разговора', 'разговоров'])} · клиента играет Lab${scope.judgeModel ? ` · судья — ${scope.judgeModel}` : ''}${scope.target ? ` · версия агента ${scope.target}` : ''}${scope.costUsd ? ` · $${scope.costUsd.toFixed(2)}` : ''}`,
    ...coverageSentence(view),
    ...(breakdown.goal.decided ? [`Запрос выполнен: ${breakdown.goal.met} из ${breakdown.goal.decided}.${breakdown.rules.decided ? ` Правила промпта нарушены: ${breakdown.rules.broken} из ${breakdown.rules.decided}.` : ''}`] : []),
    agreement.checked ? `С решениями судьи вы согласились в ${agreement.agreed} из ${agreement.checked} проверенных случаев.`
      : view.reviewed.situations ? `Вы сами проверили ${countText(view.reviewed.situations, ['ситуацию', 'ситуации', 'ситуаций'])}.`
      : agreement.queueFailures.length + agreement.sampledPasses.length ? 'Решения судьи ещё не проверялись человеком.' : '',
    ...(view.reviewed.contradicted ? [`В ${countText(view.reviewed.contradicted, ['ситуации', 'ситуациях', 'ситуациях'])} ваша отметка по всему разговору расходится с итогом: итог считается по ожиданиям ситуации, отметка по всему разговору в число не входит.`] : []),
    ...(coverage.excluded.length ? [`Из ${coverage.examined} разговоров в набор вошли ${coverage.included}; не вошли: ${coverage.excluded.map(item => `${item.label} — ${item.count}`).join(', ')}.`] : []),
    ...(stability?.skipped ? [`Стабильность не проверена: ${stability.skipped}.`] : stability?.unstable.length
      ? [`Нестабильны при повторе: ${stability.unstable.map(row => oneLine(row.title)).join(', ')}.`] : []),
    ...bundle.warnings,
  ].filter(Boolean);
  return { kind: 'section', title: 'Как считали', blocks: [{ kind: 'list', items: lines }] };
}

/**
 * «Сверка с продом»: the situations not compared and why, then each disagreement between the synthetic run and
 * the logged conversation — the expectation, both verdicts, the hint and where both conversations are, with the
 * run's conversation shown. A logged conversation is production data: the report names it and never quotes it.
 */
function calibrationBlock(bundle: EvidenceBundle): Block[] {
  const calibration = bundle.view.calibration;
  if (!calibration) return [];
  const excluded = exclusionsLine(calibration);
  const items: DisagreementItem[] = calibration.disagreements.map(item => ({ number: item.number, title: oneLine(item.title),
    expectations: item.expectations.map(row => oneLine(disagreementText(row))), hint: item.hint, conversations: conversationsText(item),
    dialogue: turnsOf(bundle.record.trials.find(trial => trial.id === item.trialIds[0])) }));
  const body: Block[] = [
    ...(excluded ? [{ kind: 'paragraph' as const, muted: true, text: excluded }] : []),
    ...(items.length ? [{ kind: 'disagreements' as const, items }] : []),
    ...(calibration.compared ? [{ kind: 'list' as const, items: [...CALIBRATION_CAVEATS] }] : []),
  ];
  // Nothing beyond the line under the number (a calibration skipped for its budget): no section.
  return body.length ? [{ kind: 'section', title: 'Сверка с продом', blocks: [{ kind: 'paragraph', muted: false, text: calibration.text }, ...body] }] : [];
}

function comparisonBlock(bundle: EvidenceBundle): Block[] {
  const { comparison } = bundle;
  if (!comparison) return [];
  const version = bundle.before?.targetVersion ?? bundle.before?.targetRelease;
  const source = `${bundle.comparisonSource?.kind === 'selected' ? 'База выбрана вручную' : 'Сравнение с прошлым прогоном'}${version ? ` — версия ${version}` : ''}.`;
  return [{ kind: 'section', title: 'Было → стало', blocks: [
    { kind: 'paragraph', muted: false, text: `${source} ${comparison.headline}` },
    ...(comparison.fixed.length + comparison.regressed.length ? [{ kind: 'list' as const, items: [
      ...comparison.regressed.map(row => `Сломалось: ${oneLine(row.title)}`), ...comparison.fixed.map(row => `Исправлено: ${oneLine(row.title)}`)] }] : []),
  ] }];
}

/** The report of one run as blocks; `htmlReport` and `markdownReport` render the same tree. */
export function runReport(bundle: EvidenceBundle): Report {
  const { record } = bundle;
  const view = bundle.view;
  const accuracy = accuracyParts(view);
  const trust = trustSegments(view);
  const reality = realityParts(view);
  const alarm = alarmRow(view);
  const trials = new Map(record.trials.map(trial => [trial.id, trial]));
  const byScenario = (id: string) => record.trials.filter(trial => trial.scenarioId === id);
  const failed = new Map(view.failures.map(failure => [failure.scenarioId, failure]));
  // A situation keeps the number the owner knows it by in Pi: a card's own, the place in the run for older formats.
  const numbers = new Map(view.cards.map((card, index) => [card.scenarioId, situationNumber(record, card.scenarioId, index + 1)]));
  const cards: CardItem[] = view.cards.flatMap(card => {
    const scenario = record.scenarios.find(item => item.id === card.scenarioId);
    if (!scenario) return [];
    const failure = failed.get(card.scenarioId);
    return [{ number: numbers.get(card.scenarioId)!, brief: situationBrief(record, scenario, bundle.dialogueNumbers), chip: chipOf(card, view),
      dialogue: turnsOf(failure ? trials.get(failure.trialId) : byScenario(card.scenarioId)[0]) }];
  });
  const failures: FailureItem[] = view.failures.map(failure => {
    const rule = failure.violated ?? failure.rules[0];
    return { number: numbers.get(failure.scenarioId) ?? 0, title: oneLine(failure.title), expected: failure.expected ?? 'не записано в ситуации',
      said: failure.said?.quote ?? null, rule: rule ? { quote: rule.quote, source: oneLine(rule.sourceName) } : null, dialogue: turnsOf(trials.get(failure.trialId)) };
  });
  const unmeasured = view.notMeasured.reasons.flatMap(reason => reason.scenarioIds.map(id => `${oneLine(view.cards.find(card => card.scenarioId === id)?.title ?? id)}: ${reason.label}`));
  return {
    title: `Проверка агента · ${countText(view.cards.length, SITUATIONS)}`,
    meta: [dateText(view.createdAt), ...(view.scope.target ? [`версия ${view.scope.target}`] : []), ...(view.mode === 'demo' ? ['учебный пример'] : [])],
    head: [
      ...(alarm ? [{ kind: 'alarm' as const, text: alarm.text }] : []),
      { kind: 'accuracy', lead: accuracy.lead, value: accuracy.value, tail: accuracy.tail, level: accuracy.level,
        band: view.headline.range && view.headline.accuracy !== null ? { point: view.headline.accuracy, range: view.headline.range, weighted: view.topics?.weighted ?? null } : null },
      ...(trust.length ? [{ kind: 'trust' as const, parts: trust }] : []),
      ...(reality.length ? [{ kind: 'trust' as const, parts: reality.map(text => ({ text, warn: false })) }] : []),
      ...(view.calibration ? [{ kind: 'trust' as const, parts: [{ text: view.calibration.text, warn: false }] }] : []),
    ],
    blocks: [
      ...topicsBlock(view),
      ...causesBlock(view),
      ...(cards.length ? [{ kind: 'section' as const, title: 'Ситуации', blocks: [{ kind: 'cards' as const, items: cards }] }] : []),
      ...(failures.length ? [{ kind: 'section' as const, title: 'Разбор ошибок', blocks: [{ kind: 'failures' as const, items: failures }] }] : []),
      ...(unmeasured.length ? [{ kind: 'section' as const, title: 'Не измерено', blocks: [{ kind: 'list' as const, items: unmeasured }] }] : []),
      ...calibrationBlock(bundle),
      ...comparisonBlock(bundle),
      basisBlock(bundle, view),
    ],
    footer: [`Отчёт Agent Lab · ${dateText(view.createdAt)}`, 'Полные записи разговоров и оценок судьи хранятся у владельца агента.'],
  };
}

/** A bare record reads as a bundle with its own view and nothing resolved around it. */
function bundleOf(input: Experiment | EvidenceBundle): EvidenceBundle {
  return 'record' in input ? input : { record: input, view: buildResultView(input), warnings: [], traceJournal: '' };
}

/** The styled, self-contained customer report. */
export const htmlReport = (input: Experiment | EvidenceBundle): string => toHtml(runReport(bundleOf(input)));
/** The same report as Markdown. */
export const markdownReport = (input: Experiment | EvidenceBundle): string => toMarkdown(runReport(bundleOf(input)));

/** The embedded source run without the heavy judge audits; receipts and verdicts stay. */
function sourceEvidenceWithoutAudits(source: NonNullable<Experiment['sourceEvidence']>) {
  return { ...source, trials: source.trials.map(({ judgeAudit: _audit, ...trial }) => trial) };
}
/** A run for export: legacy full judge audits are left out, receipts and verdicts stay. */
function runWithoutAudits(run: Experiment): Experiment {
  return { ...run, trials: run.trials.map(({ judgeAudit: _audit, ...trial }) => trial),
    ...(run.sourceEvidence ? { sourceEvidence: sourceEvidenceWithoutAudits(run.sourceEvidence) } : {}) };
}

/**
 * The machine snapshot: the run record without full judge audits, the ResultView every surface
 * shows, the comparison when there is one. The trace journal and full judge audits stay next to the
 * record; the export only names them.
 */
export function jsonReport(bundle: EvidenceBundle): string {
  const { record, traceJournal, before, ...evidence } = bundle;
  // Counted over exactly what runWithoutAudits strips: each run's trials and its embedded source trials.
  const legacyAudits = [record, ...(before ? [before] : [])].reduce((n, run) => n
    + [...run.trials, ...run.sourceEvidence?.trials ?? []].filter(trial => trial.judgeAudit).length, 0);
  return JSON.stringify({ experiment: runWithoutAudits(record), ...(before ? { before: runWithoutAudits(before) } : {}), ...evidence,
    traceJournal: { file: `${record.id}.trace.jsonl`, bytes: Buffer.byteLength(traceJournal) },
    judgeAudits: { included: false, omittedLegacyAudits: legacyAudits,
      location: `Полные ответы судьи остаются в локальной папке Agent Lab: ${record.id}.judge/<trialId>.json или, для старых записей, в ${record.id}.json.` } }, null, 2);
}
