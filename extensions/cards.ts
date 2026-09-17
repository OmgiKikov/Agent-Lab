import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Experiment, Scenario, Trial } from '../dist/contracts.js';
import { describeCheck, fingerprint } from '../dist/contracts.js';
import { awaitingVerdict, verdictSummary, isAgentFailure, humanFindings, humanFindingText, repeatResultText, plannedTrials, type RunComparison, type VerdictNote } from '../dist/comparison.js';
import { expectationSheet, qualitySummary, qualityLines, type ExpectationRole, type ExpectationSheet } from '../dist/quality.js';
import { agreementSample, judgeAgreement, type JudgeAgreement } from '../dist/agreement.js';
import { GOAL_METRIC_ID, headlineMetricIds, markTargets, measurementUsable, recordedResult, RULES_METRIC_ID } from '../dist/outcomes.js';
import type { EvidenceBundle } from '../dist/artifacts.js';
import { situationEvidence } from '../dist/explain.js';
import { buildResultView, causeSection, DISAGREEMENT_BOARD_TITLE, disagreementRows, failureListRows, resultViewRows, SECTION_TEXT, type DisagreementRow, type ResultRow, type ResultView, type SectionRow } from '../dist/result-view.js';

/** All material, model and persisted text crosses this boundary before terminal rendering. */
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export const activePhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);
const phases: Record<string, string> = {
  preparing: 'ПОДГОТОВКА', review: 'ПРОВЕРЬТЕ КАРТОЧКИ', evaluating: 'ИДУТ ДИАЛОГИ',
  results_review: 'ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ', complete: 'ЗАВЕРШЕНО', cancelled: 'ОСТАНОВЛЕНО',
  error: 'ОШИБКА', interrupted: 'ПРЕРВАНО', baseline: 'БАЗОВАЯ ВЕРСИЯ', improving: 'УЛУЧШЕНИЕ', control: 'КОНТРОЛЬ',
};
export const verdicts: Record<string, string> = {
  pass: 'ПРОЙДЕНО', fail: 'НЕ ПРОЙДЕНО', unknown: 'НЕЯСНО', invalid: 'НЕВАЛИДНЫЙ ТЕСТ', cancelled: 'ОСТАНОВЛЕНО', ungraded: 'ПО РУБРИКАМ',
};

/**
 * Review order (UI-SPEC F12): the review queue leads — first the failures the judge recorded and
 * the owner has not answered yet, then the passes drawn for a double-check — and today's rank
 * (waiting for a verdict, flagged, failed, the rest) follows. Answering a situation takes it out of
 * groups 0 and 1, so the same list position lands on the next case and a person goes through the
 * failures and then the checked successes without navigating.
 */
export function reviewOrder(record: Experiment): Trial[] {
  const pending = awaitingVerdict(record);
  const flagged = new Set(humanFindings(record).map(f => f.trialId));
  const agreement = judgeAgreement(record);
  const unmarked = new Set(agreement.unmarked);
  const queued = new Set(agreement.queueFailures);
  const rank = (trial: Trial) => unmarked.has(trial.id) ? (queued.has(trial.id) ? 0 : 1)
    : pending.has(trial.id) ? 2 : flagged.has(trial.id) ? 3 : isAgentFailure(record, trial) || trial.outcome === 'invalid' ? 4 : 5;
  return record.trials.map((trial, index) => ({ trial, index })).sort((a, b) => rank(a.trial) - rank(b.trial) || a.index - b.index).map(v => v.trial);
}

/** What a one-key answer would land on for the selected situation (UI-SPEC F10). */
export type AgreementTarget =
  /** A positive control: it is not part of the agreement count. */
  | { kind: 'control' }
  /** The measurement is not usable (the simulator deviated, the judge failed, the dialogue was marked invalid…), so the headline does not count it and there is nothing to agree with (CTX-03). */
  | { kind: 'unmeasured' }
  /** The judge said nothing decisive about the main question, so there is nothing to agree with. */
  | { kind: 'undecided' }
  /** `metricIds` are the metrics a one-key answer lands on, from `markTargets`: the headline metrics whose recorded result is the situation's verdict, goal first. */
  | { kind: 'ready'; metricIds: string[]; judgeVerdict: 'pass' | 'fail'; sampled: boolean };

/**
 * UI-D-21: the agreement keys are inert unless the situation is usable and shows a recorded judge
 * verdict by the headline rule. The verdict and its targets come from `markTargets`, which reads
 * `trial.assessments` only — never `agentMetricResult`, or a mark would be compared with a verdict
 * it had already changed. An unusable situation is not in the agreement at all (CR-01), so its keys
 * are inert too.
 */
export function agreementTarget(record: Experiment, trial: Trial | undefined): AgreementTarget | undefined {
  if (!trial || record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) return undefined;
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  if (scenario && (record.positiveControlScenarioIds ?? []).includes(scenario.id)) return { kind: 'control' };
  if (!scenario || !measurementUsable(scenario, trial, record.humanReviews)) return { kind: 'unmeasured' };
  const targets = markTargets(scenario, trial);
  if (!targets) return { kind: 'undecided' };
  return { kind: 'ready', metricIds: targets.metricIds, judgeVerdict: targets.verdict, sampled: agreementSample(record).includes(trial.id) };
}

/**
 * The agreement block (UI-SPEC F10, CTX-06): the owner reads what the agent had to do, what it said
 * and which rule applies before the judge's verdict and the keys. The title carries no ✗/✓, so the
 * verdict is never seen before the evidence (UI-D-06).
 */
export function agreementBlockLines(record: Experiment, trial: Trial): Line[] {
  const target = agreementTarget(record, trial);
  // UI-D-21: where there is nothing to agree with, one muted row says why, and the keys stay inert.
  if (target?.kind === 'control') return [line('Контрольная ситуация — в согласие с судьёй не входит.', 'muted')];
  if (target?.kind === 'unmeasured') return [line('Ситуация не измерена — отметка согласия не нужна.', 'muted')];
  if (target?.kind === 'undecided') return [line('Судья не вынес решения — отметка согласия не нужна.', 'muted')];
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  if (target?.kind !== 'ready' || !scenario) return [];
  const failed = target.judgeVerdict === 'fail';
  const marks = judgeAgreement(record).marks.filter(m => m.trialId === trial.id);
  const mark = marks.find(m => !m.stale);
  const keys = (text: string, color: ThemeColor): Line => ({ ...line(text, color), hang: 2, breakAt: ' · ' });
  const answer: Line[] = mark
    ? [keys('Изменить отметку: y согласен · n не согласен · s не могу сказать', 'muted'),
      ...(mark.answer === 'agree' ? [line('Ваша отметка: = согласен', 'success')]
        : mark.answer === 'disagree' ? [line('Ваша отметка: ! не согласен', 'warning'), line(`Причина: «${oneLine(safeText(mark.note))}»`, 'text', false, 2)]
        : [line('Ваша отметка: ~ не могу сказать', 'muted')])]
    // CTX-21/CTX-28: a mark given under the previous counting rule answered another question; a judge that changed keeps the phase-3 row.
    : marks.some(m => m.staleRule) ? [line('Ваша отметка поставлена по прежнему правилу подсчёта. Отметьте заново: y · n · s', 'warning')]
    : marks.length ? [line('Ваша отметка устарела: судья сменился. Отметьте заново: y · n · s', 'warning')]
    : [keys('y — согласен · n — не согласен · s — не могу сказать', 'accent')];
  // CTX-10: on a card with prompt rules the judge row names which half failed (C-322); it wraps like
  // the key rows. A card without the rules check and a pass keep C-70 byte for byte.
  const halves = failed ? failedHalves(scenario, trial) : '';
  return [
    line('ПРОВЕРКА СУДЬИ', 'accent', true),
    line(scenario.title, 'text', true),
    line(failed ? 'Проверьте провал: сначала прочитайте доказательство.'
      : target.sampled ? 'Проверьте и успех: судья мог ошибочно похвалить.'
      : 'Судья счёл ситуацию успешной. Проверьте, если сомневаетесь.', 'muted'),
    // The first target is the goal on a double failure, and its explanation carries both halves («оба»).
    ...situationEvidence(record, scenario, trial, target.metricIds[0]!).map(sectionRow),
    !failed ? line('Судья: ✓ справился', 'success') : halves ? keys(`Судья: ✗ не справился${halves}`, 'error') : line('Судья: ✗ не справился', 'error'),
    ...answer,
    line(''),
  ];
}
/** The owner's own words on one row: whitespace runs become one space, nothing is cut. */
const oneLine = (value: string) => value.replace(/\s+/gu, ' ').trim();
/**
 * What the judge failed on a card that carries both headline metrics, from the recorded results
 * (never the human ones): both halves, the request alone or the rules alone; empty without the
 * prompt-rule check, so those cards keep the phase-3 row.
 */
function failedHalves(scenario: Scenario, trial: Trial): string {
  if (headlineMetricIds(scenario).length < 2) return '';
  const goal = recordedResult(trial, GOAL_METRIC_ID) === 'fail';
  const rules = recordedResult(trial, RULES_METRIC_ID) === 'fail';
  return goal && rules ? ' — запрос не выполнен · правила промпта нарушены' : goal ? ' — запрос не выполнен' : rules ? ' — правила промпта нарушены' : '';
}

/**
 * Section-3 list rows, in review order. `waiting` is what the `u` filter keeps: a situation the
 * board is still waiting on.
 */
export function resultEntries(record: Experiment): { id: string; text: string; waiting: boolean }[] {
  const pending = awaitingVerdict(record);
  const flagged = new Set(humanFindings(record).map(f => f.trialId));
  const agreement = judgeAgreement(record);
  const unmarked = new Set(agreement.unmarked);
  const queued = new Set(agreement.queueFailures);
  const answers = new Map(agreement.marks.filter(m => !m.stale).map(m => [m.trialId, m.answer]));
  return reviewOrder(record).map(trial => {
    const answer = answers.get(trial.id);
    const today = flagged.has(trial.id) ? 'ЗАМЕЧАНИЕ ЧЕЛОВЕКА' : isAgentFailure(record, trial) ? 'НЕ ПРОЙДЕНО' : verdicts[trial.outcome];
    // A situation still in the queue says what to do with it; an answered one says what was said.
    const queue = unmarked.has(trial.id) ? queued.has(trial.id) ? 'ПРОВЕРЬТЕ ПРОВАЛ' : 'ПРОВЕРЬТЕ И УСПЕХ' : undefined;
    const label = queue ?? (answer === 'disagree' ? 'НЕСОГЛАСИЕ С СУДЬЁЙ' : today);
    const suffix = answer === 'agree' ? ' · = согласен' : answer === 'unsure' ? ' · ~ не могу сказать' : '';
    // UI-D-22: «только неразобранные» keeps the unanswered queue, not just today's pending dialogues.
    const waiting = !!queue || pending.has(trial.id);
    return { id: trial.id, waiting,
      // One `●` at most: doubt keeps the situation waiting, and today's rule would add a second.
      text: `${queue || answer === 'unsure' || (!answer && pending.has(trial.id)) ? '● ' : ''}${label} · ${record.scenarios.find(s => s.id === trial.scenarioId)?.title ?? trial.scenarioId} · ${trial.userMode ?? 'reactive'} #${trial.repeat + 1}${suffix}` };
  });
}

/**
 * The section-3 review header (UI-SPEC F11): how far the owner got through the judge's decisions.
 * «Проверено» counts only current «согласен» and «не согласен» marks — the same count as the
 * C-95 notice (`failures.checked`, `sampleChecked`); an unsure mark is named only once nothing
 * unmarked is left. The frame truncates header rows, so each text has a measured narrow form:
 * wide ≤ 48 columns from `inner` 48, narrow ≤ 34 below it (the board's minimum inner is 36).
 */
export function reviewHeader(record: Experiment, inner: number, agreement: JudgeAgreement = judgeAgreement(record)):
  { text: string; color: 'warning' | 'success' | 'muted' } {
  const wide = inner >= 48;
  const Q = agreement.queueFailures.length;
  const S = agreement.sampledPasses.length;
  const x = agreement.failures.checked;
  const y = agreement.sampleChecked;
  const K = agreement.unsure;
  if (!Q && !S) return { color: 'muted', text: wide ? 'Проверять нечего: судья не вынес решений.' : 'Судья не вынес решений.' };
  if (agreement.unmarked.length) return { color: 'warning', text: !S
    ? wide ? `Проверено провалов: ${x} из ${Q} · успехов нет` : `Провалы ${x} из ${Q} · успехов нет`
    : !Q ? wide ? `Проверено успехов: ${y} из ${S} · провалов нет` : `Успехи ${y} из ${S} · провалов нет`
    : wide ? `Проверено провалов: ${x} из ${Q} · успехов: ${y} из ${S}` : `Провалы ${x} из ${Q} · успехи ${y} из ${S}` };
  if (K) return { color: 'warning', text: wide ? `Не решено: ${K}. y или n — чтобы завершить разбор.` : `Не решено: ${K}. Нажмите y или n.` };
  if (record.phase === 'results_review') return { color: 'success', text: wide ? 'Проверка окончена. f — завершить разбор.' : 'Всё проверено. f — завершить.' };
  return { color: 'muted', text: wide ? 'Проверка окончена.' : 'Всё проверено.' };
}

/** The last tier of both phases names the answers only as keys; F10's key row carries their full names. */
const KEYS_ONLY_TIER = 'y · n · s — согласие с судьёй';
/** Key Map Registry: the first footer line of section 3, widest first; widths measured with `visibleWidth`. */
const RESULTS_FOOTER: Record<'results_review' | 'complete', readonly string[]> = {
  results_review: [
    'a Обсудить · y Согласен с судьёй · n Не согласен · s Не могу сказать · v Оценить подробно · f Завершить разбор',
    'y Согласен с судьёй · n Не согласен · s Не могу сказать · v Оценить подробно · f Завершить разбор',
    'y Согласен · n Не согласен · s Не могу сказать · f Завершить разбор',
    'y Согласен · n Не согласен · s Не могу сказать',
    KEYS_ONLY_TIER,
  ],
  complete: [
    'y Согласен с судьёй · n Не согласен · s Не могу сказать · r Повторить прогон · x Экспортировать',
    'y Согласен · n Не согласен · s Не могу сказать · r Повторить прогон',
    'y Согласен · n Не согласен · s Не могу сказать',
    KEYS_ONLY_TIER,
  ],
};
const REPORT_PREFIX = 'o Открыть отчёт · ';

/**
 * The first footer line of section 3 (UI-D-10, UI-D-27): the first tier that fits `inner`. With a
 * report the tier must also fit the `o` prefix; when none does (inner < 47) the prefix is dropped
 * and `o` keeps working unprinted. The last tier (29) is narrower than the minimum inner (36), so
 * the row is never cut.
 */
export function resultsFooter(phase: 'results_review' | 'complete', inner: number, hasReport: boolean): string {
  const tiers = RESULTS_FOOTER[phase];
  const fit = (room: number) => tiers.find(tier => visibleWidth(tier) <= room);
  const withReport = hasReport ? fit(inner - visibleWidth(REPORT_PREFIX)) : undefined;
  return withReport !== undefined ? REPORT_PREFIX + withReport : fit(inner) ?? tiers.at(-1)!;
}

export type Section = 'agent' | 'cards' | 'results';
export type BoardAction =
  | { type: 'close' }
  | { type: 'back' }
  | { type: 'new' }
  | { type: 'demo' }
  | { type: 'open'; id: string }
  | { type: 'discuss' | 'run' | 'annotate' | 'finalize' | 'export' | 'openReport' | 'cancel' | 'repeat' | 'accept'; record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean; trialId?: string; reviewMs?: number }
  /** The owner rewrites one expectation in their own words; the text itself comes from the native editor, never from here. */
  | { type: 'expect'; scenarioId: string; record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean }
  /**
   * CTX-01/CTX-18: the owner answered the judge with one key. The answer carries the judgment it
   * refers to, so a verdict that moved while the situation was on screen is refused by the lab.
   * `metricIds` are every metric that decided the situation (CTX-15): one key, one mark per metric.
   */
  | { type: 'agree'; answer: 'agree' | 'disagree' | 'unsure'; trialId: string; metricIds: string[]; judgeVerdict: 'pass' | 'fail';
      record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean; reviewMs?: number };
export interface BoardOptions {
  records?: Experiment[];
  record?: Experiment;
  section?: Section;
  selected?: number;
  load?: () => Promise<Pick<EvidenceBundle, 'record' | 'comparison' | 'before' | 'warnings' | 'view'>>;
  /** The headline block of `record`; ignored when it belongs to another run. */
  view?: ResultView;
  comparison?: RunComparison;
  before?: Experiment;
  notice?: { message: string; kind: 'success' | 'info' | 'error' };
  warnings?: string[];
  reportPath?: string;
  query?: string;
  pendingOnly?: boolean;
  reviewTimes?: Map<string, number>;
}
type BoardTheme = Pick<Theme, 'fg' | 'bold'>;
/**
 * `lead` replaces the first line's indent with a same-width prefix (the sheet gutter `▸ ` and the number `12.`).
 * `hang` is the continuation column when it is not `indent + 2`; `breakAt` names the separator a key
 * hint row breaks at, so a narrow board never splits one key from its word.
 */
type Line = { text: string; color?: ThemeColor; bold?: boolean; indent?: number; lead?: string; hang?: number; breakAt?: string };
const line = (text: unknown, color?: ThemeColor, bold = false, indent?: number): Line => ({ text: safeText(text), color, bold, ...(indent ? { indent } : {}) });

/**
 * Board wrapping (UI-SPEC «Width, Wrap and Theme Rules»): an explanation row keeps its indent and
 * continues two columns further in, so a long quote is read in full instead of being cut. Nothing
 * is truncated: every word of every row stays on the board.
 */
export function wrapRows(rows: Line[], inner: number): Line[] {
  const width = Math.max(1, Math.floor(inner));
  return rows.flatMap(row => {
    const indent = row.indent ?? 0;
    const hang = row.hang ?? indent + 2;
    // A terminal too narrow for the hanging indent falls back to plain wrapping, still never wider.
    if ((!indent && row.hang === undefined) || width <= hang + 1) return wrapTextWithAnsi(row.lead ? row.lead + row.text : row.text, width).map(text => ({ ...row, text }));
    const body = Math.max(1, width - hang);
    const pieces = (row.breakAt ? packAt(row.text, row.breakAt, body) : undefined) ?? wrapTextWithAnsi(row.text, body);
    return pieces.map((text, i) => ({ ...row, text: (i ? ' '.repeat(hang) : row.lead ?? ' '.repeat(indent)) + text }));
  });
}

/**
 * A key hint split only at its separator, each line ending with the separator mark when another
 * part follows; undefined when one part alone is wider than `width`, so plain wrapping takes over.
 */
function packAt(text: string, separator: string, width: number): string[] | undefined {
  const parts = text.split(separator);
  const mark = separator.trimEnd();
  const lines: string[] = [];
  let current = '';
  for (const [i, part] of parts.entries()) {
    const tail = i < parts.length - 1 ? mark : '';
    const joined = current ? `${current}${separator}${part}` : part;
    if (visibleWidth(joined + tail) <= width) { current = joined; continue; }
    if (!current || visibleWidth(part + tail) > width) return undefined;
    lines.push(current + mark);
    current = part;
  }
  return [...lines, current];
}
const json = (value: unknown) => JSON.stringify(value, null, 2);
const outcomeColor = (value: string): ThemeColor => value === 'pass' ? 'success' : value === 'fail' || value === 'invalid' ? 'error' : 'warning';

/*
 * One color per row, decided by the row's role (UI-SPEC «Row role → token»): the board never
 * colors a row by its position in the list, and never rewords or reorders what result-view.ts
 * and explain.ts produced.
 */
const VIEW_ROLE: Record<ResultRow['role'], { color: ThemeColor; bold: boolean }> = {
  lead: { color: 'text', bold: true }, line: { color: 'muted', bold: false },
  detail: { color: 'muted', bold: false }, situation: { color: 'warning', bold: false },
  alarm: { color: 'error', bold: true },
  agreement: { color: 'text', bold: false }, 'agreement-tail': { color: 'muted', bold: false },
};
const SECTION_ROLE: Record<SectionRow['role'], { color?: ThemeColor; bold: boolean }> = {
  cause: { color: 'accent', bold: false }, example: { color: 'text', bold: true }, title: { color: 'error', bold: true },
  expected: { color: 'text', bold: false }, said: { color: 'text', bold: false },
  rule: { color: 'muted', bold: false }, more: { color: 'muted', bold: false }, violated: { color: 'muted', bold: false },
  unverified: { color: 'warning', bold: false }, blank: { bold: false },
};
/** The expectation sheet uses the same role → token rule (UI-SPEC «Row role → token»): `warning` only means «не подтверждено». */
const SHEET_ROLE: Record<ExpectationRole, ThemeColor> = {
  expected: 'text', rule: 'muted', unverified: 'warning', more: 'muted', marker: 'warning',
};
const DISAGREEMENT_ROLE: Record<DisagreementRow['role'], ThemeColor | undefined> = {
  'dis-title': 'warning', 'dis-verdicts': 'text', 'dis-reason': 'text', blank: undefined,
};
/** F7 on the board (CTX-11, UI-D-16): the heading and every current disagreement; nothing when there is none. */
const disagreementLines = (view: ResultView): Line[] => view.agreement.disagreements.length
  ? [line(DISAGREEMENT_BOARD_TITLE, 'accent', true), ...disagreementRows(view).map(row => line(row.text, DISAGREEMENT_ROLE[row.role], false, row.indent))]
  : [];
const viewRow = (row: ResultRow): Line => line(row.text, VIEW_ROLE[row.role].color, VIEW_ROLE[row.role].bold, row.indent);
const sectionRow = (row: SectionRow): Line => line(row.text, SECTION_ROLE[row.role].color, SECTION_ROLE[row.role].bold, row.indent);

function scenarioLines(scenario: Scenario, record: Experiment, expanded: boolean): Line[] {
  const profile = record.profiles.find(p => p.id === scenario.profileId);
  const origin = scenario.provenance === 'synthetic' ? 'Синтетическая карточка' : scenario.provenance === 'production' ? 'Из реального диалога' : 'Golden-карточка';
  if (!expanded) return [
    line(scenario.title, 'accent', true),
    line(`Первая реплика: «${scenario.user.opening}»`),
    ...(scenario.user.script !== undefined ? scenario.user.script.map((message, i) => line(`Продолжение ${i + 1}: «${message}»`)) : []),
    line(''), line(`Цель: ${scenario.user.goal}`),
    line(`Успех: ${scenario.successCriteria || scenario.checks.map(c => c.description).join('; ') || 'По рубрикам ниже.'}`),
    ...scenario.checks.map(c => line(`Проверяется: ${describeCheck(c)}`)),
    line(''), line(`${origin} · ${tierLabels[scenario.tier]} · ${scenario.checks.length} точных проверок · ${scenario.metrics?.length ?? 0} рубрик`, 'muted'),
    ...(profile ? [line(`Профиль ${profile.id}${profile.draftOverride ? ' · правка черновика' : ''}`, 'muted')] : []),
    line('Enter — пользователь, факты, поведение и все критерии', 'muted'),
  ];
  const rows = [
    line(scenario.title, 'accent', true),
    line(`${scenario.id} · ${tierLabels[scenario.tier] ?? scenario.tier} · ${scenario.provenance === 'synthetic' ? 'Синтетическая карточка' : scenario.provenance === 'production' ? 'Из реального диалога' : 'Golden-карточка'}${record.workflow !== 'evaluate' ? ` · ${scenario.split === 'control' ? 'Контроль: скрыт от билдера' : 'Разработка'}` : ''}`, 'muted'),
    line(''), line('ПОЛЬЗОВАТЕЛЬ', 'accent'),
    line(scenario.user.persona || 'Без персоны · по цели, фактам и поведению'),
    ...(profile ? [line(`Профиль ${profile.id} · ${profile.source === 'owner' ? 'задан владельцем' : 'legacy-данные'}${profile.draftOverride ? ' · правка черновика' : ''}`, 'muted')] : []),
    ...(scenario.user.characteristics ?? []).map(v => line(`• ${v}`)),
    line(`Цель: ${scenario.user.goal}`), line(`Поведение: ${scenario.user.behavior}`),
    ...(scenario.user.knows ?? []).map(v => line(`Известно: ${v}`)),
    ...(scenario.user.cannotKnow ?? []).map(v => line(`Не знает: ${v}`)),
    ...(scenario.user.answers ?? []).map(a => line(`Если спросят ${a.ifAsked}: «${a.reply}»`)),
    ...(scenario.initialState.external ? [line('Внешний мир', 'accent'), line(json(scenario.initialState.external))] : []),
    line(`Знает: ${scenario.user.facts}`), line(`Первая реплика: «${scenario.user.opening}»`),
    line(`Лимит: ${scenario.user.maxFollowUps ?? Math.max(0, record.settings.maxTurns - 1)} ответов после первой реплики`, 'muted'),
    line(''), line('УСПЕХ', 'accent'), line(scenario.successCriteria || 'Описан проверками и метриками ниже.'),
    ...scenario.checks.map(c => line(`□ ${c.stage ? `[${c.stage}] ` : ''}${c.description} [${c.id}] · ${describeCheck(c)}`)),
    ...(scenario.user.script !== undefined ? [line('РЕПЛИКИ ПО СЦЕНАРИЮ', 'accent'), line(`1. ${scenario.user.opening}`),
      ...scenario.user.script.map((message, i) => line(`${i + 2}. ${message}`))] : []),
    ...(scenario.metrics ?? []).flatMap(m => [
      line(`${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.stage ? `[${m.stage}] ` : ''}${m.name} [${m.id}]`, 'text', true),
      line(m.description), line(`Прошёл: ${m.passCriteria}`), line(`Не прошёл: ${m.failCriteria}`),
    ]),
    line(''), line('ДОПУЩЕНИЯ', 'accent'),
    ...(scenario.assumptions?.length ? scenario.assumptions.map(v => line(`• ${v}`)) : [line('Не указаны', 'muted')]),
  ];
  if (expanded) rows.push(
    ...(profile ? [line(''), line('ИСХОДНЫЙ ПРОФИЛЬ', 'accent'), line(profile.persona ?? 'Без персоны'),
      ...profile.characteristics.map(v => line(`• ${v}`)), ...(profile.observedStyle ? [line(profile.observedStyle, 'muted')] : []),
      ...profile.evidenceDialogueIds.flatMap(id => [line(`Диалог ${id}`, 'muted'),
        ...record.dialogues.find(d => d.id === id)?.messages.filter(m => m.role === 'user').map(m => line(`«${m.content}»`)) ?? []]),
    ] : []),
    line(''), line('ОСНОВАНИЯ В МАТЕРИАЛАХ', 'accent'),
    ...record.requirements.filter(r => scenario.requirementIds.includes(r.id)).flatMap(r => [
      line(`${r.id} · ${r.text}`, 'text', true),
      line(`${record.sources.find(s => s.id === r.sourceId)?.name ?? r.sourceId}: «${r.quote}»`, 'muted'),
    ]),
    line(''), line('НАЧАЛЬНОЕ СОСТОЯНИЕ', 'accent'), line(json(scenario.initialState)),
    line(''), line('ТОЧНЫЕ ПРОВЕРКИ', 'accent'), line(json(scenario.checks)),
  );
  return rows;
}

/**
 * Today's dialogue rows. `agreementShown` says the F10 block stands above them: its quick mark is
 * then not listed again, and the row that names the keys is left to the block.
 */
export function trialLines(trial: Trial, record: Experiment, expanded: boolean, agreementShown = false): Line[] {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const findings = humanFindings(record).filter(f => f.trialId === trial.id);
  const rows = [
    line(scenario?.title ?? trial.scenarioId, 'accent', true),
    line(`${verdicts[trial.outcome]} · ${trial.userMode} · повтор ${trial.repeat + 1}`, outcomeColor(trial.outcome)),
    ...findings.map(f => line(expanded ? humanFindingText(f) : humanFindingText(f).slice(0, 240), 'warning')),
    ...(record.workflow !== 'evaluate' ? [line(`Версия агента: ${trial.revisionId}`, 'muted')] : []),
    line(trial.reason),
    ...(trial.observation ? [line(`Наблюдение: состояние ${trial.observation.state} · события ${trial.observation.tools} · сброс ${trial.observation.resetConfirmed === true ? 'заявлен' : 'не подтверждён'}`, 'muted')] : []),
    ...(trial.externalUsage ? [line(`Внешний агент: ${trial.externalUsage.calls} вызовов · стоимость ${trial.externalUsage.costUsd === null ? 'неизвестна' : `$${trial.externalUsage.costUsd.toFixed(4)}`}`, 'muted')] : []),
    line(`Модель лаборатории: ${trial.usage.calls} вызовов · ${(trial.elapsedMs / 1000).toFixed(1)} с · стоимость ${trial.usage.costUsd === null ? 'неизвестна' : `$${trial.usage.costUsd.toFixed(4)}`}`, 'muted'),
    ...(record.target.kind !== 'sandbox' ? [line('Вызовы и расходы внешнего агента в эту оценку не входят.', 'muted')] : []),
    line(''), line('ДЕТЕРМИНИРОВАННЫЕ ПРОВЕРКИ', 'accent'),
    ...(trial.checks.length ? trial.checks.flatMap(c => [
      line(`${c.passed ? '✓' : '×'} ${c.description} [${c.id}]`, c.passed ? 'success' : 'error'), line(c.evidence, 'muted'),
    ]) : [line('Проверок состояния нет. Итог не означает успех по всем метрикам.', 'muted')]),
    ...(trial.userMode === 'reactive' ? [line(''), line('ПРОВЕРКИ СИМУЛЯТОРА · эвристики', 'accent'),
      ...(trial.simulatorChecks?.length ? trial.simulatorChecks.flatMap(c => [line(`${c.passed ? '✓' : '?'} ${c.description} [${c.id}]`, c.passed ? 'success' : 'warning'), line(c.evidence, 'muted')])
        : [line('Не применялись: симулятор не отправил реплик после первой.', 'muted')])] : []),
    line(''), line(record.mode === 'demo' ? 'СЦЕНАРНАЯ ОЦЕНКА ДЕМО — ПРОВЕРЬТЕ ПО ТРАССЕ' : 'ОЦЕНКА МОДЕЛЬЮ — ПРОВЕРЬТЕ ПО ТРАССЕ', 'accent'),
    ...(scenario?.metrics ?? []).flatMap(m => {
      const a = trial.assessments?.find(a => a.metricId === m.id);
      return [line(`${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.name}: ${a ? verdicts[a.result] : 'НЕТ ОЦЕНКИ'}`, a ? outcomeColor(a.result) : 'warning'),
        line(a?.rationale ?? 'Оценка отсутствует; это не прохождение.'),
        line(`Основания: ${a?.evidence.length ? a.evidence.map(seq => `#${seq}`).join(', ') : 'не указаны'}`, 'muted'),
        ...(expanded ? [line(`Критерий успеха: ${m.passCriteria}`), line(`Критерий провала: ${m.failCriteria}`)] : [])];
    }),
    ...(trial.assessmentError ? [line(`Ошибка оценщика: ${trial.assessmentError}`, 'error')] : []),
    line(''), line('ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ', 'accent'),
    ...(record.humanReviews?.filter(r => r.trialId === trial.id && !(agreementShown && r.source === 'quick')).flatMap(r => [
      line(`${verdicts[r.verdict]} · ${r.metricId ? `метрика ${r.metricId}` : r.checkId ? `проверка ${r.checkId}` : 'весь диалог'}`, outcomeColor(r.verdict)), line(r.note),
    ]) ?? []),
  ];
  // C-77/C-78: `p` is retired and `n` now means «не согласен», so this row names only `v`.
  if (!agreementShown && !record.humanReviews?.some(r => r.trialId === trial.id)) rows.push(line(
    verdictSummary(record).review.status === 'complete' ? 'Разбор набора завершён; у этого диалога отдельного вердикта нет. v — оценить подробно.'
      : 'Вердикта человека нет. v — оценить критерий или весь диалог.', 'muted'));
  const transcript: Line[] = [line('ДИАЛОГ', 'accent', true)];
  const roles = { user: 'ПОЛЬЗОВАТЕЛЬ', assistant: 'АГЕНТ', simulator: 'СИМУЛЯТОР', retrieval: 'RAG-КОНТЕКСТ', tool_call: 'ВЫЗОВ', tool_result: 'РЕЗУЛЬТАТ', error: 'ОШИБКА' };
  for (const event of trial.events) {
    if (!expanded && !['user', 'assistant', 'error'].includes(event.type)) continue;
    transcript.push(line(`#${event.seq}  ${roles[event.type]}${event.tool ? ` · ${event.tool}` : ''}`, event.type === 'user' ? 'accent' : event.type === 'error' ? 'error' : 'text', true));
    if (event.text !== undefined) transcript.push(line(event.text));
    if (expanded && event.args !== undefined) transcript.push(line(json(event.args), 'muted'));
    if (expanded && event.result !== undefined) transcript.push(line(json(event.result), 'muted'));
    if (expanded && event.state !== undefined) transcript.push(line(json(event.state), 'muted'));
    transcript.push(line(''));
  }
  const tools = [...new Set(trial.events.filter(e => e.type === 'tool_call').map(e => e.tool))];
  if (!expanded && tools.length) transcript.push(line(`Инструменты: ${tools.join(' · ')}. Enter — раскрыть трассу.`, 'muted'));
  const problem = trial.checks.find(c => !c.passed)?.description
    ?? trial.assessments?.find(a => a.result === 'fail')?.rationale ?? trial.assessmentError;
  rows.splice(2 + findings.length, 0, ...transcript, ...(problem ? [line(`Требует внимания: ${problem}`, 'warning'), line('')] : []));
  if (expanded) rows.push(line(`Диалог: ${trial.id}`, 'muted'));
  if (expanded) rows.push(line('СОСТОЯНИЕ ДО', 'accent'), line(json(trial.initialState)), line('СОСТОЯНИЕ ПОСЛЕ', 'accent'), line(json(trial.finalState)));
  return rows;
}

const tierLabels: Record<string, string> = { smoke: 'дымовые', regression: 'регрессия', frontier: 'фронтир' };
/** Verdict wording comes from the record itself, so the board, the report and the CLI never disagree. */
const noteText = (note: VerdictNote): string => note.text;

/** The simple layer: how good the agent is on these cards, why it failed, what the judge could not settle, what to do next. */
function verdictLines(record: Experiment, expanded = false, comparison?: RunComparison, view: ResultView = buildResultView(record)): Line[] {
  const v = verdictSummary(record);
  if (!expanded) {
    const q = qualitySummary(record);
    const text = qualityLines(q);
    const finding = v.review.findings[0];
    const measuredAny = q.scope.dialogues > 0;
    const section = causeSection(view);
    const disagreements = disagreementLines(view);
    // The first block is ResultView's, row for row: the board never counts or picks a not-measured card itself.
    return [line('ИТОГ', 'accent', true),
      ...(measuredAny ? resultViewRows(view).map(viewRow) : [line(v.headline, 'text', true)]),
      ...(measuredAny && q.metrics.length ? text.metrics.map(m => line(m)) : []),
      ...(measuredAny ? text.rag.map(item => line(item, 'muted')) : []),
      line(''),
      ...(finding ? [line(humanFindingText(finding), 'warning')] : []),
      // The same explanations the CLI and the Pi result show; nothing here is clipped or reworded.
      ...(section ? [line(SECTION_TEXT[section.kind].board, 'accent', true), ...section.rows.map(sectionRow)]
        : measuredAny ? [line('Провалов не зарегистрировано. Это не гарантия качества в реальном трафике.', 'success')] : [line('Сохраните полезные тесты и повторите их после следующей правки.')]),
      // UI-SPEC F7 S3: the owner's disagreements follow the causes and come before the pointer to all failures.
      ...(disagreements.length ? [line(''), ...disagreements] : []),
      ...(section && view.failures.length ? [...(disagreements.length ? [line('')] : []), line(SECTION_TEXT.all.hint, 'muted')] : []),
      line(''),
      ...(measuredAny ? [line(text.judge), line(text.queue, q.humanQueue.total ? 'warning' : 'muted')] : []),
      line(`Дальше: ${v.nextSteps[0]?.text ?? 'Повторите тест после изменения агента.'}`),
      line('a — обсудить результат · r — повторить набор · Enter — все детали', 'accent'),
      ...(comparison ? [line(`После исправления: ${comparison.headline}`, 'accent')] : []),
      ...(measuredAny ? [line(text.scope, 'muted'), line(text.limits, 'muted')] : []),
      line(`Выполнено ${v.execution.completed}/${v.execution.planned} · спорных ${q.humanQueue.total} · сбоев ${v.invalid} · тестов отклонено ${v.review.invalid}`, 'muted'),
    ];
  }
  const p = v.provenance;
  return [
    line('ИТОГ', 'accent', true),
    ...resultViewRows(view).map(viewRow),
    line(''),
    ...(view.agreement.disagreements.length ? [...disagreementLines(view), line('')] : []),
    // Every failure, in record order, with the explanation the CLI and the collapsed result show.
    ...(view.failures.length ? [line(SECTION_TEXT.all.board, 'accent', true), ...failureListRows(view).map(sectionRow), line('')] : []),
    ...(v.review.findings.length ? [line(''), line('ЗАМЕЧАНИЯ ЧЕЛОВЕКА', 'warning', true),
      ...v.review.findings.slice(0, 3).flatMap(f => [line(record.scenarios.find(s => s.id === record.trials.find(t => t.id === f.trialId)?.scenarioId)?.title ?? f.trialId, 'text', true),
        line(humanFindingText(f).slice(0, 300), 'warning')]),
      line('3 — открыть диалоги и полные пояснения · a — обсудить исправление', 'muted')] : []),
    ...(v.repeats.some(r => r.passed && r.failed) ? [line(''), line('РАЗБРОС ПОПЫТОК', 'warning', true),
      ...v.repeats.filter(r => r.passed && r.failed).slice(0, 3).map(r => line(repeatResultText(r), 'warning')),
      line('Это наблюдения, а не вероятность будущего успеха.', 'muted')] : []),
    ...(view.failures.length ? [line('3 — открыть диалоги · a — обсудить причины и следующие шаги с Pi', 'muted'), line('')] : []),
    line(`Карточки: синтетических ${p.synthetic.cards}, golden ${p.curated.cards}, из продакшна ${p.production.cards}.`, 'muted'),
    line(v.weakSpots.length ? `Автоматические замечания: ${v.weakSpots.map(w => `${w.stage ? `[${w.stage}] ` : ''}${w.description} (${w.failures} провал(ов))`).join('; ')}.` : 'Автоматические проверки не отметили провалов.'),
    ...(v.stages.length ? [line('По этапам работы агента:', 'accent'),
      ...v.stages.map(st => line(`  ${st.stage}: ${st.passed} из ${st.evaluated}`, st.passed === st.evaluated ? 'success' : 'warning'))] : []),
    line(`Выполнено: ${v.execution.completed}/${v.execution.planned} · не измерено ${v.execution.invalid} · остановлено ${v.execution.cancelled} · пропущено ${v.execution.missing}`, 'muted'),
    line(`Кодовые проверки: ${v.graded ? `${v.passed}/${v.graded} пройдено` : 'нет'} · рубрики: ${v.rubric.assessed ? `${v.rubric.passed}/${v.rubric.assessed} без замечаний` : 'нет оценок'}`),
    line(`Вердикт на весь диалог: ${v.review.reviewed}/${v.review.total} · пройдено ${v.review.passed}, не пройдено ${v.review.failed}`),
    line(`Провалов без решения: ${v.review.pending} · расхождений с ручной оценкой: ${v.review.disagreements}`, 'muted'),
    line(`Разбор: ${v.review.status === 'complete' ? 'завершён' : 'не завершён'}`, 'muted'),
    ...(v.tiers.some(t => t.graded) ? [line(`Кодовые проверки по ступеням: ${v.tiers.filter(t => t.graded).map(t => `${tierLabels[t.tier]} ${t.passed}/${t.graded}`).join(' · ')}.`, 'muted')] : []),
    ...(record.failureModes?.length ? [line('Типы провалов:', 'accent'),
      ...record.failureModes.flatMap(mode => [
        line(`• ${mode.name}${mode.stage ? ` [${mode.stage}]` : ''} — ${mode.trialIds.length} диалог(ов)`, 'warning'),
        line(`  ${mode.description}`, 'muted'),
        ...(mode.promptQuotes ?? []).map(q => line(`  Цитата промпта · гипотеза: «${q}»`, 'muted')),
      ])] : []),
    line('Что дальше:', 'accent'), ...v.nextSteps.map(step => line(`• ${noteText(step)}`)),
  ];
}
function verdictHeadline(view: ResultView): string {
  return `Итог: ${view.headline.text} · 1 подробнее`;
}

/** A single native Pi component: immutable snapshots in, explicit human intentions out. */
export class LabBoard implements Component {
  private record?: Experiment;
  private section: Section;
  private selected: number;
  private scroll = 0;
  private maxScroll = 0;
  private expanded = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private loading = false;
  private loadError = '';
  private query: string;
  private pendingOnly: boolean;
  private searching = false;
  private help = false;
  private viewedTrial?: string;
  private viewedAt = performance.now();
  private sheetCache?: { record: Experiment; sheet?: ExpectationSheet };
  /** Row index of the selected situation's first sheet row, before wrapping; set while the detail is built. */
  private sheetAnchor?: number;
  /** ↑/↓ put the selected situation at the top of the body; an explicit scroll key hands control back. */
  private followSelection = true;

  constructor(private options: BoardOptions, private theme: BoardTheme, private done: (action: BoardAction) => void,
    private redraw: () => void, private rows: () => number = () => 32) {
    this.record = options.record;
    this.section = options.section ?? (this.record?.trials.length || this.record?.questions.length || this.record?.phase === 'error' ? 'agent' : 'cards');
    this.selected = options.selected ?? 0;
    this.query = options.query ?? '';
    this.pendingOnly = options.pendingOnly ?? false;
    if (options.load && this.record && activePhases.has(this.record.phase)) {
      this.timer = setInterval(() => { void this.refresh(); }, 750);
    }
  }
  private async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const refreshed = await this.options.load!();
      if (this.disposed) return;
      const { record } = refreshed;
      if (record.updatedAt !== this.record?.updatedAt || record.phase !== this.record?.phase) {
        this.options.reportPath = undefined;
        this.options.notice = undefined;
      }
      this.record = record;
      Object.assign(this.options, { comparison: refreshed.comparison, before: refreshed.before, warnings: refreshed.warnings, view: refreshed.view });
      this.loadError = '';
      if (!activePhases.has(record.phase)) { clearInterval(this.timer); this.timer = undefined; }
      this.redraw();
    } catch (error) {
      if (!this.disposed) { this.loadError = safeText(error instanceof Error ? error.message : error); this.redraw(); }
    }
    finally { this.loading = false; }
  }
  /**
   * What the agent must do in every situation of this draft (UI-SPEC F5). Only an unstarted
   * evaluate draft has one; every other record keeps today's card detail.
   */
  private sheet(): ExpectationSheet | undefined {
    const record = this.record;
    if (!record || record.workflow !== 'evaluate' || record.phase !== 'review') return undefined;
    if (this.sheetCache?.record !== record) {
      let sheet: ExpectationSheet | undefined;
      try { sheet = expectationSheet(record); } catch { sheet = undefined; }
      this.sheetCache = { record, sheet };
    }
    return this.sheetCache.sheet;
  }
  /**
   * The sheet as board rows: heading, then every situation of `entries` (so the search filters it)
   * with its gutter, right-aligned number, expectation and all owner rules, then the version row.
   */
  private sheetRows(sheet: ExpectationSheet, entries: { index: number }[]): Line[] {
    if (!sheet.cards.length) return [line(sheet.lines[0], 'text', true), line(sheet.lines[1], 'muted')];
    const column = 2 + sheet.labelWidth + 1;
    const rows: Line[] = [line(sheet.boardHead[0], 'accent', true), line(sheet.boardHead[1], 'muted'), line('')];
    this.sheetAnchor = undefined;
    entries.forEach((entry, position) => {
      const card = sheet.cards[entry.index];
      if (!card) return;
      const selected = position === this.selected;
      if (selected) this.sheetAnchor = rows.length;
      const label = ' '.repeat(Math.max(0, sheet.labelWidth - visibleWidth(card.label))) + card.label;
      rows.push({ ...line(card.goal, selected ? 'accent' : 'text', true, column), lead: `${selected ? '▸ ' : '  '}${label} ` });
      for (const detail of card.details) rows.push(line(detail.text, SHEET_ROLE[detail.role], false, column));
      rows.push(line(''));
    });
    rows.push(line(sheet.lines.at(-1), 'muted'));
    return rows;
  }
  /**
   * What the draft header says about the expectations (UI-SPEC F5): not confirmed, confirmed, or
   * confirmed and then changed. Open questions come first, so that older text stays untouched.
   *
   * «Ожидание изменено» is said only when an expectation really changed. `draftHash` also covers the
   * judge model, the target fingerprint, the materials and the settings, so a re-preflight or an
   * `agent_lab_edit` of the model must not tell the owner that one of their expectations moved.
   */
  private draftHeadline(record: Experiment): { text: string; color?: ThemeColor } {
    const sheet = this.sheet();
    if (!sheet?.count || record.questions.length) return { text: 'Проверьте цель, первую реплику и критерии. r — запуск.' };
    if (record.acceptedDraftHash === sheet.draftHash) return { text: 'Ожидания подтверждены. r — запуск.', color: 'success' };
    if (record.acceptedDraftHash) {
      // An accepted entry seals the whole card definition, so a dropped entry is a changed expectation.
      const sealed = new Map((record.acceptedTests ?? []).map(test => [test.scenarioId, test.definitionHash]));
      const expectationsChanged = record.scenarios.some(scenario => sealed.get(scenario.id) !== fingerprint(scenario));
      return expectationsChanged
        ? { text: 'Ожидание изменено после подтверждения. y — подтвердить снова.', color: 'warning' }
        : { text: 'Черновик изменился после подтверждения. y — подтвердить снова.', color: 'warning' };
    }
    return { text: `Проверьте ожидания: ${sheet.countText}. y — подтвердить все · e — поправить выбранную.`, color: 'warning' };
  }
  /**
   * The draft's key hints, cut to the terminal (UI-SPEC «Footer, first line»): every label is a verb
   * with its object, and the narrow tiers drop the key the header line already names.
   */
  private draftFooter(record: Experiment, inner: number): string {
    const sheet = this.sheet();
    if (record.questions.length || !sheet?.count) return `a Правка словами · ${record.questions.length ? 'Ответьте на вопросы' : 'r Запустить'}`;
    const confirmed = record.acceptedDraftHash === sheet.draftHash;
    if (inner >= 85) return 'a Правка словами · y Подтвердить ожидания · e Поправить ожидание · r Запустить прогон';
    if (inner >= 61) return 'y Подтвердить всё · e Поправить ожидание · r Запустить прогон';
    if (inner >= 41) return confirmed ? 'r Запустить прогон · e Поправить ожидание' : 'y Подтвердить всё · e Поправить ожидание';
    return confirmed ? 'r Запустить прогон · e Изменить одно' : 'y Подтвердить всё · e Изменить одно';
  }
  /** The supplied view when it describes the shown run; otherwise a fresh one, so a stale view is never shown. */
  private viewFor(record: Experiment): ResultView {
    return this.options.view?.runId === record.id ? this.options.view : buildResultView(record);
  }
  dispose() { this.disposed = true; clearInterval(this.timer); }
  invalidate() {}
  private recordReading(next?: string) {
    const now = performance.now();
    const times = this.options.reviewTimes ??= new Map();
    if (this.viewedTrial) times.set(this.viewedTrial, Math.min(3600000, (times.get(this.viewedTrial) ?? 0) + now - this.viewedAt));
    this.viewedTrial = next; this.viewedAt = now;
  }
  private finish(action: BoardAction) {
    this.recordReading();
    if ((action.type === 'agree' || action.type === 'annotate') && action.trialId) action.reviewMs = Math.round(this.options.reviewTimes?.get(`${action.record.id}|${action.trialId}`) ?? 0);
    this.dispose(); this.done(action);
  }
  private entries(): { text: string; index: number; id: string }[] {
    const record = this.record;
    let entries: { text: string; index: number; id: string }[];
    if (!record) entries = (this.options.records ?? []).map((r, index) => ({ text: `${phases[r.phase] ?? r.phase} · ${r.task}`, index, id: r.id }));
    else if (this.section === 'results') {
      entries = resultEntries(record).flatMap((entry, index) => !this.pendingOnly || entry.waiting
        ? [{ id: entry.id, index, text: entry.text }] : []);
    } else if (this.section === 'cards') {
      const edited = new Set(record.ownerExpectationScenarioIds ?? []);
      entries = record.scenarios.map((s, index) => ({ text: `${s.tier === 'smoke' ? '◆ ' : ''}${s.title}${edited.has(s.id) ? ' · ожидание изменено' : ''}`, index, id: s.id }));
    }
    else entries = [];
    return entries.filter(e => safeText(e.text).toLocaleLowerCase().includes(this.query.toLocaleLowerCase()));
  }
  handleInput(data: string) {
    if (this.disposed) return;
    const key = (value: Parameters<typeof matchesKey>[1]) => matchesKey(data, value);
    if (this.searching) {
      if (key('escape')) { this.searching = false; this.query = ''; }
      else if (key('enter')) this.searching = false;
      else if (key('backspace')) this.query = Array.from(this.query).slice(0, -1).join('');
      else if (!/[\x00-\x1f\x7f-\x9f]/.test(data)) this.query = (this.query + safeText(data)).slice(0, 100);
      this.selected = 0; this.scroll = 0; this.redraw(); return;
    }
    if (key('q') || key('ctrl+c')) return this.finish({ type: 'close' });
    if (key('escape')) {
      if (this.help) { this.help = false; this.redraw(); return; }
      if (this.query || this.pendingOnly) { this.query = ''; this.pendingOnly = false; this.selected = 0; this.redraw(); return; }
      return this.finish({ type: this.record ? 'back' : 'close' });
    }
    if (data === '?') { this.help = !this.help; this.scroll = 0; this.redraw(); return; }
    if (this.help && !['pageDown', 'right', 'pageUp', 'left', 'home', 'end'].some(k => key(k as Parameters<typeof matchesKey>[1]))) return;
    if (data === '/' && (!this.record || ['cards', 'results'].includes(this.section))) { this.searching = true; this.redraw(); return; }
    if (!this.record && key('n')) return this.finish({ type: 'new' });
    if (!this.record && key('d')) return this.finish({ type: 'demo' });
    if (this.record) {
      const section = key('1') ? 'agent' : key('2') ? 'cards' : key('3') ? 'results' : undefined;
      if (section) { this.section = section; this.selected = 0; this.scroll = 0; this.query = ''; this.help = false; this.followSelection = true; }
      if (key('u') && this.section === 'results') { this.pendingOnly = !this.pendingOnly; this.selected = 0; this.scroll = 0; }
      const editable = this.record.workflow === 'evaluate' && this.record.phase === 'review';
      const reviewable = this.record.workflow === 'evaluate' && this.section === 'results'
        && ['results_review', 'complete'].includes(this.record.phase) && this.entries().length > 0;
      const entry = this.entries()[this.selected];
      const state = { record: this.record, section: this.section, selected: this.selected, query: this.query, pendingOnly: this.pendingOnly,
        ...(this.section === 'results' && entry ? { trialId: entry.id } : {}) };
      if (key('a') && !activePhases.has(this.record.phase)) return this.finish({ type: 'discuss', ...state,
        selected: this.section === 'cards' && entry ? entry.index : this.selected });
      // CTX-01/UI-D-01…UI-D-04: three answers, one Latin key each, only where the F10 block is
      // shown. `p` is retired here (UI-D-02); a whole-dialogue verdict is still reachable with `v`.
      const target = reviewable && entry ? agreementTarget(this.record, this.record.trials.find(t => t.id === entry.id)) : undefined;
      if (target?.kind === 'ready' && entry) {
        const answer = key('y') ? 'agree' as const : key('n') ? 'disagree' as const : key('s') ? 'unsure' as const : undefined;
        if (answer) return this.finish({ type: 'agree', answer, ...state, trialId: entry.id, metricIds: target.metricIds, judgeVerdict: target.judgeVerdict });
      }
      const finished = this.record.workflow === 'evaluate' && !!this.record.reviewedAt && !activePhases.has(this.record.phase);
      const type = key('r') && editable && !this.record.questions.length ? 'run'
        : key('r') && finished ? 'repeat'
        : key('v') && reviewable ? 'annotate'
        : key('f') && this.record.phase === 'results_review' ? 'finalize'
        : key('x') ? 'export'
        : key('o') && this.options.reportPath ? 'openReport'
        : key('c') && activePhases.has(this.record.phase) ? 'cancel' : undefined;
      if (type) return this.finish({ type, ...state });
      // TRUST-10/11 (UI-D-01): the expectation sheet is the only scope of `y` and `e`; outside it they do nothing.
      const sheetScope = editable && this.section === 'cards' && !this.record.questions.length && this.record.scenarios.length > 0;
      if (sheetScope && key('y')) return this.finish({ type: 'accept', ...state });
      if (sheetScope && key('e') && entry) return this.finish({ type: 'expect', ...state, scenarioId: entry.id });
    }
    const entries = this.entries();
    if (key('down') || key('j')) { this.selected = Math.min(entries.length - 1, this.selected + 1); this.scroll = 0; this.followSelection = true; }
    if (key('up') || key('k')) { this.selected = Math.max(0, this.selected - 1); this.scroll = 0; this.followSelection = true; }
    if (key('pageDown') || key('right')) { this.scroll = Math.min(this.maxScroll, this.scroll + Math.max(1, this.rows() - 12)); this.followSelection = false; }
    if (key('pageUp') || key('left')) { this.scroll = Math.max(0, this.scroll - Math.max(1, this.rows() - 12)); this.followSelection = false; }
    if (key('home')) { this.scroll = 0; this.followSelection = false; }
    if (key('end')) { this.scroll = this.maxScroll; this.followSelection = false; }
    if (key('enter')) {
      if (!this.record && entries[this.selected]) return this.finish({ type: 'open', id: entries[this.selected]!.id });
      this.expanded = !this.expanded;
    }
    this.redraw();
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(4, this.rows());
    const entries = this.entries();
    const reading = this.section === 'results' && !this.help && !this.searching ? entries[this.selected]?.id : undefined;
    this.recordReading(reading ? `${this.record!.id}|${reading}` : undefined);
    const sidebar = !this.help && width >= 110 && entries.length > 0 ? 32 : 0;
    const inner = Math.max(1, width - 4 - (sidebar ? sidebar + 3 : 0));
    const paint = (row: Line) => {
      let value = row.text;
      if (row.bold) value = this.theme.bold(value);
      return row.color ? this.theme.fg(row.color, value) : value;
    };
    const frame = (content: string) => width < 6 ? truncateToWidth(content, width, '…')
      : `${this.theme.fg('borderMuted', '│')} ${truncateToWidth(content, Math.max(1, width - 4), '…', true)} ${this.theme.fg('borderMuted', '│')}`;
    const header = [line('AGENT LAB  /  Проверка агента', 'accent', true)];
    const record = this.record;
    if (record) {
      const unresolved = record.phase === 'complete' && awaitingVerdict(record).size > 0;
      header.push(line(`${unresolved ? 'НЕРАЗОБРАННЫЕ ПРОВАЛЫ' : phases[record.phase] ?? record.phase} · ${record.mode === 'demo' ? 'ДЕМО · без модели' : 'ЖИВОЙ ПРОГОН'}`, activePhases.has(record.phase) ? 'accent' : record.phase === 'complete' && !unresolved ? 'success' : 'warning'));
      header.push(line([['agent', '1 Обзор'], ['cards', `2 Ситуации ${record.scenarios.length}`], ['results', `3 Диалоги ${record.trials.length}`]]
        .map(([id, label]) => this.section === id ? `[${label}]` : label).join('   '), 'muted'));
      if (this.section === 'results' && record.trials.length) {
        const review = reviewHeader(record, inner);
        header.push(line(review.text, review.color));
      }
      const draft = this.draftHeadline(record);
      header.push(line(`${record.trials.length && !activePhases.has(record.phase) ? verdictHeadline(this.viewFor(record))
        : record.phase === 'review' ? draft.text : record.message}${this.loadError ? ` · ${this.loadError}` : ''}`,
        record.trials.length && !activePhases.has(record.phase) ? undefined : record.phase === 'review' ? draft.color : undefined));
    } else header.push(line('n — свой агент · d — учебный пример без провайдера', 'muted'));
    if (this.options.notice) header.push(line(this.options.notice.message,
      this.options.notice.kind === 'error' ? 'error' : this.options.notice.kind === 'info' ? 'text' : 'success'));
    if (this.options.warnings?.length) header.push(line(`Внимание: ${this.options.warnings[0]}${this.options.warnings.length > 1 ? ` (+${this.options.warnings.length - 1})` : ''}`, 'warning'));
    const items = entries.map(e => e.text);
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    const visibleItems = record ? 1 : Math.max(1, Math.min(4, Math.floor(height / 5)));
    const from = Math.max(0, Math.min(this.selected - Math.floor(visibleItems / 2), items.length - visibleItems));
    if (items.length && !sidebar) for (let i = from; i < Math.min(items.length, from + visibleItems); i++) {
      header.push(line(`${i === this.selected ? '▸' : ' '} ${i + 1}/${items.length}  ${items[i]}`, i === this.selected ? 'accent' : 'muted', i === this.selected));
    }
    if (this.searching || this.query || this.pendingOnly) header.push(line(`${this.pendingOnly ? '● Только неразобранные · ' : ''}Поиск: ${this.query}${this.searching ? '▎  Enter — применить' : ' · Esc — сбросить'}`, 'accent'));
    if (record && activePhases.has(record.phase)) {
      const planned = plannedTrials(record);
      const filled = planned ? Math.min(20, Math.round(record.trials.length / planned * 20)) : 0;
      header.push(line(`${'━'.repeat(filled)}${'─'.repeat(20 - filled)}  ${record.trials.length} / ${planned} диалогов · c Остановить`, 'accent'));
    }
    let detail: Line[] = [];
    this.sheetAnchor = undefined;
    if (!record) {
      const chosen = this.options.records?.[entries[this.selected]?.index ?? -1];
      detail = chosen ? [line(chosen.task, 'text', true), line(`Создан: ${chosen.createdAt}`, 'muted'), line(chosen.phase === 'review' ? 'Черновик готов. Откройте его, чтобы проверить и уточнить сценарии.' : chosen.trials.length ? verdictSummary(chosen).headline : chosen.message)]
        : [line('НАСКОЛЬКО ХОРОШ ВАШ АГЕНТ', 'accent', true), line(''),
          line('1  Подключение', 'text', true), line('   Agent Lab читает папку агента: промпт, точку входа, базу знаний.', 'muted'),
          line('2  Карточки', 'text', true), line('   Ситуации пользователей — из правил промпта, статей или ваших логов.', 'muted'),
          line('3  Диалоги', 'text', true), line('   Каждая карточка проигрывается с агентом: одна реплика, по сценарию, живой пользователь.', 'muted'),
          line('4  Качество', 'text', true), line('   Справился / не справился по карточкам, причины с цитатами, что разметить человеку.', 'muted'), line(''),
          line('n  Проверить своего агента · укажите папку и что проверить', 'accent'),
          line('d  Учебный пример за минуту · без модели и ключей', 'accent'), line(''),
          line('Оценки модели и ваши вердикты хранятся отдельно; результат повторяем и сравним с прошлым прогоном.', 'muted')];
    } else if (this.section === 'cards') {
      const scenario = record.scenarios[entries[this.selected]?.index ?? -1];
      const sheet = this.expanded ? undefined : this.sheet();
      // Section 2 of a draft is the expectation sheet; Enter still opens today's full card detail.
      detail = sheet ? this.sheetRows(sheet, entries)
        : scenario ? scenarioLines(scenario, record, this.expanded)
        : [line(this.query ? 'Ничего не найдено. Esc — сбросить поиск.' : 'Карточки появятся после подготовки.', 'muted')];
      if (sheet && this.query && !entries.length) detail = [line('Ничего не найдено. Esc — сбросить поиск.', 'muted')];
    } else if (this.section === 'results') {
      const trial = reviewOrder(record).find(t => t.id === entries[this.selected]?.id);
      detail = trial ? [...agreementBlockLines(record, trial), ...trialLines(trial, record, this.expanded, agreementTarget(record, trial)?.kind === 'ready')] : this.query || this.pendingOnly ? [line('Ничего не найдено. Esc — сбросить фильтр.', 'muted')]
        : activePhases.has(record.phase) ? [line('ДИАЛОГ ВЫПОЛНЯЕТСЯ', 'accent', true), line(record.message), line('Первый результат появится после ответа и проверки критериев.', 'muted'), line('c — остановить с сохранением уже полученных реплик', 'muted')]
        : [line('Диалогов ещё нет.', 'text', true), line(record.phase === 'review' ? 'Проверьте карточки и нажмите r для запуска.' : record.error ?? 'Прогон остановлен до завершения первой попытки.')];
    } else {
      const agent = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec;
      detail = [...(record.trials.length ? [...verdictLines(record, this.expanded, undefined, this.viewFor(record)), line('')] : []), line(record.task, 'text', true),
        ...(record.error ? [line('НЕ УДАЛОСЬ ЗАВЕРШИТЬ', 'warning'), line(record.error), line('a Обсудить исправление с Pi · исходные данные сохранены'), line('')] : []),
        ...(record.questions.length ? [line('ТРЕБУЮТСЯ УТОЧНЕНИЯ', 'warning'), ...record.questions.map(q => line(`• ${q}`)), line('Нажмите a и ответьте своими словами. Pi подготовит уточнённый черновик.')] : []),
        line(''), line('ПОДКЛЮЧЕНИЕ', 'accent'), line(record.target.kind === 'sandbox' ? agent?.name ?? 'Песочница' : record.target.kind === 'module' ? record.target.path : record.target.kind === 'http' ? record.target.url : [record.target.command, ...record.target.args].join(' ')),
        ...(record.assessmentOf ? [line(`Переоценка ${record.assessmentOf} · агент не запускался`, 'warning')] : []),
        line(`Оценщик: ${record.evaluatorVersion?.slice(0, 12) ?? 'версия не записана'}`, 'muted'),
        line(`Версия: ${record.targetVersion ?? record.targetRelease ?? record.targetFingerprint?.slice(0, 12) ?? 'не указана'}`, 'muted'),
        ...(this.expanded ? [line(agent?.instructions ?? '')] : []),
        ...(record.target.kind === 'sandbox' ? [line(`Инструменты: ${agent?.tools.join(', ') || 'нет'}`, 'muted')] : []),
        line(''), line('ПЛАН ПРОГОНА', 'accent'), line(`${record.scenarios.length} карточек · ${plannedTrials(record)} диалогов · ${record.settings.userModes.join(' / ')}`),
        line(`До ${record.settings.maxTurns} ходов · ${record.settings.maxCalls} вызовов модели · ${Math.round(record.settings.maxDurationMs / 60000)} мин`, 'muted'),
        ...(this.expanded ? [line(json(record.settings))] : []),
        line(''), line('ПРОВЕРКА ЧЕЛОВЕКОМ', 'accent'),
        line(`Карточки: ${!record.reviewedAt ? 'ожидают проверки' : record.reviewMode === 'human' ? 'подтверждены человеком' : record.reviewMode === 'expectations' ? 'ожидания подтверждены владельцем' : 'автоматическая проверка'}`),
        line(`Диалоги с заметкой: ${new Set(record.humanReviews?.map(r => r.trialId)).size} / ${record.trials.length}`),
        line(`Разбор: ${verdictSummary(record).review.status === 'complete' ? 'завершён' : 'ещё не завершён'}`),
        line(`${record.usage.calls} ${record.mode === 'demo' ? 'сценарных' : 'модельных'} вызовов · стоимость ${record.usage.costUsd === null ? 'неизвестна' : `$${record.usage.costUsd.toFixed(4)}`}`, 'muted'),
        line(''), line('ОСНОВАНИЯ', 'accent'),
        ...record.requirements.flatMap(r => [line(`${r.id} · ${r.text}`, 'text', true), line(`${record.sources.find(s => s.id === r.sourceId)?.name ?? r.sourceId}: «${r.quote}»`, 'muted')]),
        ...(this.expanded ? record.sources.flatMap(s => [line(''), line(s.name, 'accent'), line(s.content)]) : []),
        line(''), ...record.limitations.map(v => line(`• ${v}`, 'muted')),
        ...(record.error ? [line(record.error, 'error')] : []),
      ];
      if (record.trials.length && !this.expanded) detail = verdictLines(record, false, this.options.comparison, this.viewFor(record));
    }
    if (this.options.warnings?.length) detail.push(line(''), line('ДИАГНОСТИКА', 'warning'), ...this.options.warnings.map(w => line(w, 'warning')));
    if (this.help) { detail = [line('КЛАВИШИ', 'accent', true), line('1 Обзор — качество агента · 2 Карточки · 3 Диалоги'), line('a — правка или разбор словами с Pi · n в списке — новая проверка'), line('↑ ↓ или j k — выбрать карточку или диалог'), line('← → или PgUp PgDn — прокрутить подробности'), line('/ — поиск по списку · u — только неразобранные диалоги'), line('Enter — раскрыть источники, инструменты и состояния'), line('y / n / s — согласен с судьёй / не согласен / не могу сказать'), line('n — спросит причину · v — оценить критерий или весь диалог'), line('r — запустить черновик или создать повтор готового прогона'), line('y — подтвердить все ожидания · e — поправить ожидание выбранной ситуации'), line('x — экспортировать · c — остановить запуск · Esc — назад · q — закрыть'), line(''), line('Клавиши — латинские буквы: переключите раскладку, если буквы не срабатывают.', 'muted'), line('Все оценки и подтверждения относятся к показанной версии.', 'muted')]; this.sheetAnchor = undefined; }
    const content = wrapRows(detail, inner).map(paint);
    // The selected situation starts the body, so its expectation and rules are read without scrolling.
    if (this.followSelection && this.sheetAnchor !== undefined) this.scroll = wrapRows(detail.slice(0, this.sheetAnchor), inner).length;
    // Section 3 of a finished evaluation picks its own tier and places the report link itself.
    const answerPhase = record?.workflow === 'evaluate' && this.section === 'results'
      && (record.phase === 'results_review' || record.phase === 'complete') ? record.phase : undefined;
    const footer = record ? [
      answerPhase ? resultsFooter(answerPhase, inner, !!this.options.reportPath)
        : record.workflow !== 'evaluate' ? 'Сравнительный эксперимент · только просмотр и экспорт'
        : record.phase === 'review' ? this.draftFooter(record, inner)
        : activePhases.has(record.phase) ? 'c Остановить · обновляется автоматически'
        : record.phase === 'results_review' ? 'a Обсудить · 3 Диалоги · f Завершить · r Повторить · x Экспорт'
        : record.reviewedAt ? 'a Обсудить результат · r Повторить · x Экспорт' : 'a Обсудить исправление · результат сохранён',
      inner < 80 ? '↑↓ Выбор · ←→ Текст · Enter Детали · / Поиск · ? Помощь'
        : `↑↓ Выбор · PgUp/PgDn Текст · Enter ${this.expanded ? 'Свернуть' : 'Подробнее'} · / Поиск · u Неразобранные · ? Помощь`,
    ] : ['n Свой агент · d Демо · ↑↓ Выбор · Enter Открыть · ? Помощь'];
    if (this.options.reportPath && record && !answerPhase) footer[0] = `${REPORT_PREFIX}${footer[0]}`;
    const available = Math.max(1, height - header.length - footer.length - 4);
    this.maxScroll = Math.max(0, content.length - available);
    this.scroll = Math.min(this.scroll, this.maxScroll);
    if (this.maxScroll > 0 && record) footer[1] = `${this.scroll + 1}–${Math.min(content.length, this.scroll + available)}/${content.length} · ${inner < 80 ? '←→ Текст · ↑↓ Выбор · Enter Детали · ?' : footer[1]}`;
    const border = (left: string, right: string) => this.theme.fg('borderMuted', width < 2 ? '─' : left + '─'.repeat(width - 2) + right);
    const body = content.slice(this.scroll, this.scroll + available);
    const listFrom = Math.max(0, Math.min(this.selected - Math.floor(available / 2), entries.length - available));
    const bodyRows = sidebar ? Array.from({ length: available }, (_, i) => {
      const index = listFrom + i;
      const entry = entries[index];
      const label = entry ? `${index === this.selected ? '▸ ' : '  '}${safeText(entry.text)}` : '';
      const left = this.theme.fg(index === this.selected ? 'accent' : 'muted', truncateToWidth(label, sidebar, '…', true));
      return frame(`${left} ${this.theme.fg('borderMuted', '│')} ${body[i] ?? ''}`);
    }) : body.map(frame);
    const rows = [border('╭', '╮'), ...header.map(r => frame(paint(r))), frame(this.theme.fg('borderMuted', '─'.repeat(Math.max(1, width - 4)))),
      ...bodyRows, ...footer.map((text, i) => frame(this.theme.fg(i ? 'dim' : 'accent', text))), border('╰', '╯')];
    // Even very small terminals remain valid; Pi requires each rendered line to fit.
    return rows.slice(0, height).map(row => visibleWidth(row) > width ? truncateToWidth(row, width, '…') : row);
  }
}

export function showBoard(ctx: ExtensionContext, options: BoardOptions): Promise<BoardAction> {
  return ctx.ui.custom<BoardAction>((tui, theme, _keys, done) =>
    new LabBoard(options, theme, done, () => tui.requestRender(), () => tui.terminal.rows),
  { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
}
