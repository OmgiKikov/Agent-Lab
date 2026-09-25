import type { Experiment } from './contracts.js';
import type { EvidenceBundle } from './artifacts.js';
import { toHtml, toMarkdown, type Block, type CardItem, type DisagreementItem, type Example, type FailureItem, type Report, type Said } from './blocks.js';
import { calibrationCaveats, conversationsText, disagreementText, exclusionsLine, hintText } from './card/calibration-view.js';
import type { FailureExplanation } from './explain.js';
import { coverageLine, sharePercent, uncoveredLine } from './miner/coverage.js';
import { countText, pluralForm } from './plural.js';
import {
  accuracyParts, alarmRow, causeItems, evaluationEvidenceLines, caveatRows, comparisonRows, countingLines, DUNNO_MARK, dunnoMark, judgeCheckText, noErrorsText, noRuleText, realityParts, reasonLabel,
  operabilityText, saidText, scenarioRows, situationOutcomeText, toolExpectationsText, trialTurns, trustSegments, type ResultRow,
} from './result-text.js';
import { buildResultView, type ResultCard, type ResultView } from './result-view.js';
import { briefFields, situationBrief } from './card/view.js';
import { ruleBarText } from './card/rulebook.js';
import { oneLine } from './text.js';

/*
 * The customer report: the result the owner reads in Pi, as one page for someone who never opened
 * Pi. It is built only from the ResultView of the run (plus the stored dialogues it quotes), in the
 * order a reader asks: how good is the agent, can I trust the number, where does it fail and why,
 * what was checked, each failure with its evidence, and what the result does not prove. Its words
 * are result-text.ts's, for this reader. Its reader did none of the owner's work, so
 * the page speaks about the owner of the agent, never to «вы», and asks its reader to do nothing: the
 * owner's next steps stay in the owner's tools. A situation made from a logged conversation opens
 * with the customer's first message verbatim, so the page quotes that message and its footer says so,
 * with the values Lab wrote over the log's masking marks marked in the brief; the calibration names a
 * logged conversation and never shows it. No ids, hashes or model internals on the page; the machine
 * snapshot (jsonReport) keeps those.
 */

/** The page speaks about the owner of the agent: its reader is whoever the owner sends it to. */
const READER = 'others' as const;
const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dateText = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
};

/**
 * Rows of result-text.ts as the page lays them out: a heading row names its section, a row at the margin is a paragraph
 * (muted as its role is), and the rows indented under it are one list.
 */
function rowBlocks(rows: readonly ResultRow[]): Block[] {
  const blocks: Block[] = [];
  for (const row of rows) {
    const last = blocks.at(-1);
    if (row.indent && last?.kind === 'list') last.items.push(row.text);
    else if (row.indent) blocks.push({ kind: 'list', items: [row.text] });
    else if (row.text) blocks.push({ kind: 'paragraph', muted: row.role === 'muted', text: row.text });
  }
  return blocks;
}
/** A block of result-text.ts under its own heading as one section of the page. */
const rowSection = (rows: readonly ResultRow[]): Block[] => rows[0]?.role === 'heading' ? [{ kind: 'section', title: rows[0].text, blocks: rowBlocks(rows.slice(1)) }] : [];

/** What the agent said in a failure: the reply the judge pointed at is quoted and marked as the error; otherwise why nothing is quoted. */
const saidOf = (failure: FailureExplanation): Said => ({ text: saidText(failure), quoted: !!failure.said });

const example = (failure: FailureExplanation): Example => {
  const rule = failure.violated ?? failure.rules[0];
  return { situation: oneLine(failure.title), expected: failure.expected ?? 'не записано в ситуации', said: saidOf(failure), rule: rule ? `«${rule.quote}»` : null };
};

function chipOf(card: ResultCard): CardItem['chip'] {
  if (card.control) return card.outcome === 'pass' ? { text: 'контроль ✓', tone: 'accent' } : { text: card.outcome === 'fail' ? 'контроль ✗' : 'контроль ?', tone: 'err' };
  const text = situationOutcomeText(card, READER);
  return card.outcome === 'pass' ? { text: `✓ ${text}`, tone: 'ok' } : card.outcome === 'fail' ? { text: `✗ ${text}`, tone: 'err' } : { text: `? ${text}`, tone: 'warn' };
}

/** «Почему ошибается»: the causes every surface names (causeItems), each with up to three of its failures quoted, and how many more there are. */
function causesBlock(view: ResultView): Block[] {
  if (!view.failures.length) {
    return view.headline.decided ? [{ kind: 'paragraph', muted: false, text: noErrorsText(view.headline.decided, view.notMeasured.total) }] : [];
  }
  const { items, more, moreText } = causeItems(view);
  const shown = items.map(cause => ({ title: cause.text, count: countText(cause.count, SITUATIONS),
    examples: view.failures.filter(failure => cause.scenarioIds.includes(failure.scenarioId)).slice(0, 3).map(example) }));
  return [{ kind: 'section', title: 'Почему ошибается', blocks: [{ kind: 'causes', items: shown }, ...(more ? [{ kind: 'paragraph' as const, muted: true, text: moreText }] : [])] }];
}

/**
 * «По сценариям»: the business scenarios of the plan in result-text.ts's rows, as one table — a scenario, its variations
 * under it, and the expectations it broke, muted, beside no count of their own.
 */
const scenariosBlock = (view: ResultView): Block[] => {
  const [heading, ...rows] = scenarioRows(view);
  if (!heading) return [];
  return [{ kind: 'section', title: heading.text, blocks: [{ kind: 'table', head: ['Сценарий и его варианты', heading.right ?? ''],
    rows: rows.map(row => ({ muted: row.role !== 'item', cells: [row.indent > 2 ? `— ${row.text}` : row.text, row.right ?? ''] })) }] }];
};

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

/** How the judge was checked without a person, in one sentence of the fine print. */
function judgeCheckBasis(check: NonNullable<ResultView['judgeCheck']>): string {
  const unjudged = check.unjudged ? ` Без вердикта остались ${check.unjudged}: они не считаются ни пойманными, ни пропущенными, и проверка не считается полной.` : '';
  return `Судью проверили без человека: в копию разговора, который он засчитал, Lab подбрасывал предполагаемую ошибку в ответ агента, и тот же судья оценивал копию заново; ${check.controls ? 'контрольные копии оставались без изменений' : 'контрольных копий не было'}. Исходные разговоры и оценки не менялись. Это диагностика, а не независимая проверка: качество подброшенных ошибок и контрольных ответов человек не подтверждал.${unjudged}`;
}

/** How the number was made and what it rests on, in plain sentences for the fine print; the owner's own checks are said about the owner. */
function basisBlock(bundle: EvidenceBundle, view: ResultView): Block {
  const { agreement, breakdown, coverage, scope, stability } = view;
  const lines = [
    ...countingLines(view),
    ...(view.bar ? [`${ruleBarText(view.bar, READER)}.`] : []),
    `${countText(scope.cards, SITUATIONS)} · ${countText(scope.dialogues, ['разговор', 'разговора', 'разговоров'])} · клиента играет Lab${scope.judgeModel ? ` · судья — ${scope.judgeModel}` : ''}${scope.target ? ` · версия агента ${scope.target}` : ''}${scope.costUsd ? ` · $${scope.costUsd.toFixed(2)}` : ''}`,
    ...coverageSentence(view),
    ...(toolExpectationsText(view) ? [`${toolExpectationsText(view)}.`] : []),
    ...(breakdown.goal.decided ? [`Запрос выполнен: ${breakdown.goal.met} из ${breakdown.goal.decided}.${breakdown.rules.decided ? ` Правила промпта нарушены: ${breakdown.rules.broken} из ${breakdown.rules.decided}.` : ''}`] : []),
    agreement.checked ? `Владелец агента согласился с решениями судьи в ${agreement.agreed} из ${countText(agreement.checked, ['проверенного случая', 'проверенных случаев', 'проверенных случаев'])}.`
      : view.reviewed.situations ? `Владелец агента сам проверил ${countText(view.reviewed.situations, ['ситуацию', 'ситуации', 'ситуаций'])}.`
      : agreement.queueFailures.length + agreement.sampledPasses.length ? 'Решения судьи ещё не проверялись человеком.' : '',
    ...(view.judgeCheck ? [judgeCheckBasis(view.judgeCheck)] : []),
    ...(view.reviewed.contradicted ? [`В ${countText(view.reviewed.contradicted, ['ситуации', 'ситуациях', 'ситуациях'])} отметка владельца агента по всему разговору расходится с итогом: итог считается по ожиданиям ситуации, отметка по всему разговору в число не входит.`] : []),
    ...(coverage.excluded.length ? [`Из ${countText(coverage.examined, ['разговора', 'разговоров', 'разговоров'])} в набор ${pluralForm(coverage.included, ['вошёл', 'вошли', 'вошли'])} ${coverage.included}; не вошли: ${coverage.excluded.map(item => `${item.label} — ${item.count}`).join(', ')}.`] : []),
    ...(stability?.skipped ? [`Стабильность не проверена: ${stability.skipped}.`] : stability?.unstable.length
      ? [`Нестабильны при повторе: ${stability.unstable.map(row => oneLine(row.title)).join(', ')}.`] : []),
    ...bundle.warnings,
  ].filter(Boolean);
  return { kind: 'section', title: 'Как считали', blocks: [{ kind: 'list', items: lines }] };
}

/**
 * «Сверка с продом»: the situations not compared and why, then each disagreement between the synthetic run and
 * the logged conversation — the expectation, both verdicts, the hint and where both conversations are, with the
 * run's conversation shown. The logged conversation itself is named, never quoted.
 */
function calibrationBlock(bundle: EvidenceBundle): Block[] {
  const calibration = bundle.view.calibration;
  if (!calibration) return [];
  const excluded = exclusionsLine(calibration, READER);
  const items: DisagreementItem[] = calibration.disagreements.map(item => ({ number: item.number, title: oneLine(item.title),
    expectations: item.expectations.map(row => oneLine(disagreementText(row, READER))), hint: hintText(item.suggests, READER), conversations: conversationsText(item),
    dialogue: trialTurns(bundle.record.trials.find(trial => trial.id === item.trialIds[0])) }));
  const body: Block[] = [
    ...(excluded ? [{ kind: 'paragraph' as const, muted: true, text: excluded }] : []),
    ...(items.length ? [{ kind: 'disagreements' as const, items }] : []),
    ...(calibration.compared ? [{ kind: 'list' as const, items: [...calibrationCaveats(READER)] }] : []),
  ];
  // Nothing beyond the line under the number (a calibration skipped for its budget): no section.
  return body.length ? [{ kind: 'section', title: 'Сверка с продом', blocks: [{ kind: 'paragraph', muted: false, text: calibration.text }, ...body] }] : [];
}

/** «Было → стало»: the comparison with the run this one repeats, in the words result-text.ts gives a page for others. */
function comparisonBlock(bundle: EvidenceBundle): Block[] {
  const { comparison, before } = bundle;
  if (!comparison || !before) return [];
  return [{ kind: 'section', title: 'Было → стало', blocks: rowBlocks(comparisonRows(comparison, before, { reader: READER, selected: bundle.comparisonSource?.kind === 'selected' })) }];
}

/**
 * What the footer owes a reader about the logs: a situation made from them opens with the customer's first message
 * as it was written, and the values Lab wrote over the log's masking marks are marked in the brief.
 */
function logsNote(record: Experiment, cards: readonly CardItem[]): string[] {
  const library = record.librarySnapshot;
  const fromLogs = record.scenarios.some(scenario => scenario.provenance === 'production')
    || (library?.formatVersion === 2 && library.cards.some(card => card.client.writesSource.kind === 'dialogue'));
  if (!fromLogs) return [];
  const filled = cards.some(card => card.brief.filled?.length);
  return [`Первые реплики клиентов в ситуациях из логов взяты из записанных разговоров дословно${filled ? '; значения, которые Lab подставил вместо обезличенных, помечены «подставлено вместо обезличенного»' : ''}.`];
}

/** The report of one run as blocks; `htmlReport` and `markdownReport` render the same tree. */
export function runReport(bundle: EvidenceBundle): Report {
  const { record } = bundle;
  const view = bundle.view;
  const accuracy = accuracyParts(view);
  const trust = trustSegments(view, READER);
  const reality = realityParts(view);
  const judgeChecked = judgeCheckText(view);
  const alarm = alarmRow(view, READER);
  const trials = new Map(record.trials.map(trial => [trial.id, trial]));
  const byScenario = (id: string) => record.trials.filter(trial => trial.scenarioId === id);
  const failed = new Map(view.failures.map(failure => [failure.scenarioId, failure]));
  // A situation keeps the number the owner knows it by in Pi: a card's own, the place in the run for older formats.
  const numbers = new Map(view.cards.map(card => [card.scenarioId, card.number]));
  const cards: CardItem[] = view.cards.flatMap(card => {
    const scenario = record.scenarios.find(item => item.id === card.scenarioId);
    if (!scenario) return [];
    const failure = failed.get(card.scenarioId);
    // The same projection every surface reads the situation from (card/view.ts), its lines in the same order.
    const brief = situationBrief(record, scenario, bundle.dialogueNumbers, READER);
    return [{ number: numbers.get(card.scenarioId)!, brief, client: briefFields(brief), chip: chipOf(card),
      dialogue: trialTurns(failure ? trials.get(failure.trialId) : byScenario(card.scenarioId)[0]) }];
  });
  const failures: FailureItem[] = view.failures.map(failure => {
    const rule = failure.violated ?? failure.rules[0];
    return { number: numbers.get(failure.scenarioId) ?? 0, title: oneLine(failure.title), expected: failure.expected ?? 'не записано в ситуации',
      said: saidOf(failure), rule: rule ? `«${rule.quote}» — ${oneLine(rule.sourceName)}` : noRuleText(READER), dialogue: trialTurns(trials.get(failure.trialId)),
      ...(dunnoMark(view, failure.scenarioId) ? { customer: DUNNO_MARK } : {}) };
  });
  const unmeasured = view.notMeasured.reasons.flatMap(reason => reason.scenarioIds.map(id => `${oneLine(view.cards.find(card => card.scenarioId === id)?.title ?? id)}: ${reasonLabel(reason, READER)}`));
  return {
    title: `Проверка агента · ${countText(view.cards.length, SITUATIONS)}`,
    meta: [dateText(view.createdAt), ...(view.scope.target ? [`версия ${view.scope.target}`] : []), ...(view.mode === 'demo' ? ['учебный пример'] : [])],
    head: [
      ...(alarm ? [{ kind: 'alarm' as const, text: alarm.text }] : []),
      { kind: 'accuracy', lead: accuracy.lead, value: accuracy.value, tail: accuracy.tail, level: accuracy.level },
      ...(trust.length ? [{ kind: 'trust' as const, parts: trust }] : []),
      ...(operabilityText(view) ? [{ kind: 'trust' as const, parts: [{ text: operabilityText(view)!, warn: true }] }] : []),
      ...(reality.length ? [{ kind: 'trust' as const, parts: reality.map(text => ({ text, warn: false })) }] : []),
      ...(judgeChecked ? [{ kind: 'trust' as const, parts: [judgeChecked] }] : []),
      ...(view.calibration ? [{ kind: 'trust' as const, parts: [{ text: view.calibration.text, warn: false }] }] : []),
    ],
    blocks: [
      { kind: 'section', title: 'Основания доверия', blocks: [{ kind: 'list', items: evaluationEvidenceLines(view) }] },
      ...scenariosBlock(view),
      ...topicsBlock(view),
      ...causesBlock(view),
      ...(cards.length ? [{ kind: 'section' as const, title: 'Ситуации', blocks: [{ kind: 'cards' as const, items: cards }] }] : []),
      ...(failures.length ? [{ kind: 'section' as const, title: 'Разбор ошибок', blocks: [{ kind: 'failures' as const, items: failures }] }] : []),
      ...(unmeasured.length ? [{ kind: 'section' as const, title: 'Не измерено', blocks: [{ kind: 'list' as const, items: unmeasured }] }] : []),
      ...calibrationBlock(bundle),
      ...comparisonBlock(bundle),
      basisBlock(bundle, view),
      ...rowSection(caveatRows(view, READER)),
    ],
    footer: [`Отчёт Agent Lab · ${dateText(view.createdAt)}`, 'Полные записи разговоров и оценок судьи хранятся у владельца агента.', ...logsNote(record, cards)],
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
