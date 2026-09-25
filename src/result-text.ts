import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { caveatLines } from './caveats.js';
import { CALIBRATION_CAVEATS, conversationsText, disagreementText, exclusionsLine, logVerdictsText, type CalibrationDisagreement, type LogTarget } from './card/calibration-view.js';
import { countingRuleText } from './card/expectations.js';
import { ruleBarText } from './card/rulebook.js';
import { VERSION_UNKNOWN_NOTE, type RunComparison } from './comparison.js';
import type { Experiment, Trial } from './contracts.js';
import type { FailureExplanation } from './explain.js';
import type { JudgeCheckSummary } from './judge-check.js';
import { sharePercent } from './miner/coverage.js';
import { countText, pluralForm } from './plural.js';
import { NOT_MEASURED_ABOUT_OWNER, type BrokenPart, type ExamWithheld, type NextStep, type ResultView, type TrustIssue } from './result-view.js';
import type { NotMeasuredCode } from './run.js';
import type { ImportBatch } from './scenario-contracts.js';
import { oneLine } from './text.js';

/*
 * The words of a result, the only copy. The chat block, the board, the CLI summary and the report
 * all say the same lines in the same order (docs/design/ui-spec.md §4.7, §4.10, §8.5):
 *
 *   ✗ Числу пока не верить: …                                    ← a failed control, or too much unmeasured
 *   Точность агента: 72% — справился в 18 из 25 ситуаций          ← the answer, coloured by level; no interval
 *   По выбранным ситуациям; не прогноз… · мало данных · не измерено 2 из 25 — …   ← one trust line
 *   По темам / Почему ошибается / Дальше                          ← rows with a right-hand counter
 *
 * The number carries no interval, here or anywhere: its situations are a curated set drawn from the logs, not customers
 * sampled independently from production (interval.ts). «мало данных» says what a small count does to it.
 *
 * Rows are semantic (a role, an indent, a text, an optional right-hand counter or « · » parts);
 * `fitRows` lays them out as plain lines of a given width, so every surface wraps identically and
 * Pi only paints. The owner is spoken to («вы»); a page the owner sends on speaks about the owner
 * (`Reader`). Here too: a conversation's turns, the question about the judge, the comparison of two
 * runs and what a result does not prove (its caveats). Pure: no I/O, no escaping — each surface
 * escapes at its own boundary.
 */

export type ResultRole =
  | 'accuracy:good' | 'accuracy:warn' | 'accuracy:bad' | 'accuracy:none' | 'alarm'
  /** `trust:small` is the trust line with a warning in it — a small sample, unmeasured situations, a judge that built the situations. */
  | 'trust' | 'trust:small' | 'reality' | 'calibration' | 'heading' | 'item' | 'item:muted' | 'failed' | 'quote' | 'muted'
  | 'next' | 'next:first' | 'good' | 'blank';
export interface ResultRow {
  role: ResultRole; indent: number; text: string;
  /** A right-aligned counter that is never cut; `short` replaces it on a narrow screen as « — short» after the text. */
  right?: string; short?: string;
  /** Parts joined by « · »; a long row breaks only between parts, each broken line ending with «·». */
  parts?: string[];
  /** Extra indent of wrapped lines under a label column («Агент ответил   «…»»). */
  hang?: number;
}
export type Surface = 'chat' | 'board' | 'cli';
/**
 * Who reads the words: the owner of the agent in Pi and on the command line, spoken to («вы проверили»), or whoever the
 * owner sends the customer report to, who is told about the owner («владелец агента проверил») and asked to do nothing.
 */
export type Reader = 'owner' | 'others';

/** From this rounded percent the agent does well; below MIXED_FROM it does badly (docs/design/ui-spec.md §4.7 colours). */
export const GOOD_FROM = 80;
export const MIXED_FROM = 50;
/**
 * Percent of counted situations (decided + not measured; controls and pending never count) strictly above which
 * a measurement is thin: the number is never «good» and the headline names how many were not measured (OD-3).
 */
export const NOT_MEASURED_WARN_ABOVE = 10;
/** Wider terminals keep the 100-column layout with margins (docs/design/ui-spec.md §6). */
export const MAX_WIDTH = 100;

const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
/** The participle agrees with the count: «проверена 1 ситуация», «проверены 3 ситуации», «проверено 5 ситуаций». */
const CHECKED: [string, string, string] = ['проверена', 'проверены', 'проверено'];
/**
 * The one sentence of a result in which nothing failed: how much was checked, and that it promises nothing about live
 * customers. With situations left unmeasured it never says «Ошибок нет»: only the measured ones had none.
 */
export const noErrorsText = (decided: number, unmeasured = 0): string => unmeasured
  ? `Среди измеренных ошибок нет: ${pluralForm(decided, CHECKED)} ${countText(decided, SITUATIONS)}, не измерено ${unmeasured}. Это не гарантия для живых клиентов.`
  : `Ошибок нет. Это не гарантия для живых клиентов: ${pluralForm(decided, CHECKED)} ${countText(decided, SITUATIONS)}.`;
/** Genitive after «из»: «1 из 1 ситуации», «9 из 13 ситуаций». */
const SITUATIONS_OF: [string, string, string] = ['ситуации', 'ситуаций', 'ситуаций'];
/** Genitive after «из»: «из 1 разговора», «из 5 разговоров». */
const CONVERSATIONS_OF: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
const ERRORS: [string, string, string] = ['ошибка', 'ошибки', 'ошибок'];
const PASSES: [string, string, string] = ['успех', 'успеха', 'успехов'];
const TOPICS: [string, string, string] = ['тема', 'темы', 'тем'];
const CAUSES: [string, string, string] = ['причина', 'причины', 'причин'];
const percent = (value: number) => `${Math.round(value * 100)}%`;
const blank: ResultRow = { role: 'blank', indent: 0, text: '' };

/** The rounded percent the headline prints; the colour thresholds apply to it, never to the raw share. */
function percentOf(view: ResultView): number | null {
  return view.headline.decided && view.headline.accuracy !== null ? Math.round(view.headline.accuracy * 100) : null;
}

export type Level = 'good' | 'warn' | 'bad' | 'none';
/** Why the percent waits, by how the connection's exam ended (ResultView.connection). */
const EXAM_WITHHELD: Readonly<Record<ExamWithheld, string>> = {
  absent: 'подключение агента не проверено экзаменом', failed: 'подключение агента не прошло экзамен',
};
/**
 * The answer of every result surface in three pieces, so the report can set the number large:
 * «Точность агента:» · «72%» · «— справился в 18 из 25 ситуаций». Without a decided situation the
 * value is null and the tail says why.
 */
export function accuracyParts(view: ResultView): { lead: string; value: string | null; tail: string; level: Level } {
  const lead = 'Точность агента:';
  const value = percentOf(view);
  if (value === null) {
    const { passed, decided } = view.headline;
    const unexamined = view.connection !== undefined && view.connection !== 'passed' ? EXAM_WITHHELD[view.connection] : null;
    const tail = view.phase === 'review' || (view.phase === 'preparing' || view.phase === 'checking') && !view.pending ? 'прогон ещё не запускался'
      : view.pending ? `считается — ждут проверки ${countText(view.pending, SITUATIONS)}`
      : unexamined && decided ? `не считается: ${unexamined}. Справился в ${passed} из ${decided} ${pluralForm(decided, SITUATIONS_OF)}, ошибся в ${decided - passed}`
      : 'нет данных — ни одна ситуация не измерена';
    return { lead, value: null, tail, level: unexamined && decided ? 'warn' : 'none' };
  }
  const { passed, decided } = view.headline;
  const unmeasured = view.notMeasured.total;
  // Integer arithmetic: more than NOT_MEASURED_WARN_ABOVE percent of the counted situations were not measured.
  const thin = unmeasured * 100 > NOT_MEASURED_WARN_ABOVE * (decided + unmeasured);
  const level: Level = value >= GOOD_FROM ? 'good' : value >= MIXED_FROM ? 'warn' : 'bad';
  return { lead, value: `${value}%`, tail: `— справился в ${passed} из ${decided} ${pluralForm(decided, SITUATIONS_OF)}${thin ? `, ещё ${unmeasured} не измерено` : ''}`,
    level: thin && level === 'good' ? 'warn' : level };
}

/** The answer of the result screen, the same everywhere. */
export function accuracyRow(view: ResultView): ResultRow {
  const { lead, value, tail, level } = accuracyParts(view);
  return { role: `accuracy:${level}`, indent: 0, text: [lead, value, tail].filter(Boolean).join(' ') };
}

/** Why a situation was not measured, for its reader: the reasons that name the owner are said about the owner on a page for others. */
export function reasonLabel(reason: { code: NotMeasuredCode; label: string }, reader: Reader = 'owner'): string {
  return reader === 'others' ? NOT_MEASURED_ABOUT_OWNER[reason.code] ?? reason.label : reason.label;
}

/**
 * «не измерено 2 из 25 — агент не ответил», «… — чаще всего агент не ответил (6)»; `situations` names the noun after the
 * count, as the alarm says it. Null when every counted situation was measured.
 */
function unmeasuredText(view: Pick<ResultView, 'notMeasured'>, reader: Reader, situations: boolean): string | null {
  const { total, of, reasons } = view.notMeasured;
  const [main] = reasons;
  if (!total || !main) return null;
  const label = reasonLabel(main, reader);
  return `не измерено ${total} из ${of}${situations ? ` ${pluralForm(of, SITUATIONS_OF)}` : ''} — ${reasons.length === 1 ? label : `чаще всего ${label} (${main.count})`}`;
}

/**
 * What the alarm above the number names: the most serious issue that leaves the number shown (ResultView.trustIssues);
 * a withheld percent says its own reason in the number's row.
 */
const alarmIssue = (view: Pick<ResultView, 'trustIssues'>): Exclude<TrustIssue, 'connection'> | undefined =>
  view.trustIssues.find((issue): issue is Exclude<TrustIssue, 'connection'> => issue !== 'connection');

/** The unmeasured share stands above the number: it raised the alarm, and nothing more serious took the alarm's one row. */
const unmeasuredAlarm = (view: Pick<ResultView, 'trustIssues'>): boolean => alarmIssue(view) === 'unmeasured';

/** Where the judge failed its check, as the alarm says it; each reader is told what to do or what is to be done. */
const JUDGE_ALARM: Readonly<Record<NonNullable<JudgeCheckSummary['distrust']>, (owner: boolean) => string>> = {
  misses: owner => `судья пропускает подброшенные ошибки — ${owner ? 'проверьте его решения' : 'его решения нужно проверить'}`,
  false_alarms: owner => `судья не засчитывает верные ответы — ${owner ? 'проверьте его решения' : 'его решения нужно проверить'}`,
  incomplete: owner => `проверка судьи неполная — ${owner ? 'повторите её' : 'её нужно повторить'}`,
};

/**
 * Above the number when the number is not to be trusted yet (ResultView.trustIssues): a positive control failed or was
 * not measured, the judge failed its check, or too many counted situations were not measured — the most serious one.
 * A failed control comes first: it says the connection or the judge is broken; the unmeasured share then stays in the
 * trust line.
 */
export function alarmRow(view: ResultView, reader: Reader = 'owner'): ResultRow | null {
  const owner = reader === 'owner';
  const issue = alarmIssue(view);
  const { alarm, cards } = view.control;
  if (issue === 'control' && alarm) {
    const many = cards.length > 1;
    const what = alarm === 'failed' ? (many ? 'контрольные ситуации не прошли' : 'контрольная ситуация не прошла')
      : alarm === 'unmeasured' ? (many ? 'контрольные ситуации не измерены' : 'контрольная ситуация не измерена')
        : 'контрольные ситуации не прошли или не измерены';
    return { role: 'alarm', indent: 0, text: `✗ Числу пока не верить: ${what} — ${owner ? 'проверьте' : 'нужно проверить'} связь с агентом` };
  }
  if (issue === 'judge' && view.judgeCheck?.distrust) return { role: 'alarm', indent: 0, text: `✗ Числу пока не верить: ${JUDGE_ALARM[view.judgeCheck.distrust](owner)}` };
  const unmeasured = issue === 'unmeasured' ? unmeasuredText(view, reader, true) : null;
  return unmeasured ? { role: 'alarm', indent: 0, text: `✗ Числу пока не верить: ${unmeasured}` } : null;
}

/** Situations whose verdict is not stable: repeats inside the run disagreed, or it flipped against the source run. */
export const unstableCount = (view: ResultView) => view.cards.filter(card => !card.control && (card.flaky || card.unstable)).length;

/**
 * The one trust line under the number, in segments: what the number is read over and a small-sample warning, what was not measured
 * and the main reason (a warning; above the number instead when it raised the alarm), what is still being checked, the
 * owner's agreement with the judge, the unstable situations. `warn` marks the segments a surface colours as a warning.
 * A segment with nothing to say is left out; the first one starts the sentence.
 */
export function trustSegments(view: ResultView, reader: Reader = 'owner'): { text: string; warn: boolean }[] {
  const { headline, agreement } = view;
  const parts: { text: string; warn: boolean }[] = [];
  const add = (text: string, warn = false) => { parts.push({ text, warn }); };
  const owner = reader === 'owner';
  if (headline.decided) add('По выбранным ситуациям; не прогноз для всего трафика');
  if (headline.smallSample) add('мало данных', true);
  const unmeasured = unmeasuredAlarm(view) ? null : unmeasuredText(view, reader, false);
  if (unmeasured) add(unmeasured, true);
  if (view.pending) add(`ещё проверяется ${view.pending}`);
  const reviewed = countText(view.reviewed.situations, ['ситуацию', 'ситуации', 'ситуаций']);
  if (agreement.checked) add(`с судьёй согласны ${agreement.agreed} из ${agreement.checked}`);
  else if (view.reviewed.situations) add(owner ? `вы проверили ${reviewed}` : `владелец агента проверил ${reviewed}`);
  else if (agreement.queueFailures.length + agreement.sampledPasses.length) add('судью ещё не проверяли');
  if (view.sameModelJudge) add('судья — та же модель, что готовила ситуации', true);
  if (view.reviewed.contradicted) add(`${owner ? 'ваши отметки' : 'отметки владельца агента'} расходятся с итогом: ${view.reviewed.contradicted}`, true);
  const unstable = unstableCount(view);
  if (unstable) add(`нестабильно ${unstable}`);
  // A customer who could not answer most questions played a thinner situation than the real one: worth a warning.
  const dunno = dunnoText(view);
  if (dunno) add(dunno, !!view.customer && view.customer.missing > view.customer.answer);
  return parts.map((part, i) => i ? part : { ...part, text: part.text.charAt(0).toLocaleUpperCase('ru') + part.text.slice(1) });
}

/** «3 ожидания проверены по вызовам инструментов агента»: said under «Как считали»; null when every expectation was read from the replies. */
export function toolExpectationsText(view: Pick<ResultView, 'scope'>): string | null {
  const count = view.scope.toolExpectations;
  return count ? `${countText(count, ['ожидание проверено', 'ожидания проверены', 'ожиданий проверены'])} по вызовам инструментов агента` : null;
}

/**
 * «Как считали»: how a situation is counted, one line per counting rule the result names (ResultView.countingRules, in
 * the words of card/expectations.ts), then what the percent leaves out. A rule name no edition knows adds nothing.
 */
export function countingLines(view: Pick<ResultView, 'countingRules' | 'control'>): string[] {
  const rules = view.countingRules.split(', ').flatMap(rule => countingRuleText(rule) ?? []);
  const controls = view.control.cards.length ? ' Контрольные ситуации проверяют связь с агентом и судью и в процент тоже не входят.' : '';
  return [...rules, `Не измеренные ситуации в процент не входят.${controls}`];
}

/**
 * «Клиент не знал ответа на 40% вопросов агента»: the customer's «не знаю» among every reply to an agent's question
 * (a fact named or «не знаю»); null when no controlled customer was asked anything or never said «не знаю». Said on
 * every surface in these words.
 */
export function dunnoText(view: Pick<ResultView, 'customer'>): string | null {
  const moves = view.customer;
  const asked = moves ? moves.answer + moves.missing : 0;
  return moves && asked && moves.missing ? `клиент не знал ответа на ${percent(moves.missing / asked)} вопросов агента` : null;
}

/** Next to a failed situation whose customer said «не знаю» and then left (customer-moves.ts): a mark to look at, not a verdict. */
export const DUNNO_MARK = 'ответ клиента «не знаю» мог помешать';

/** The mark of one situation, when its customer's «не знаю» may have blocked the goal. */
export const dunnoMark = (view: Pick<ResultView, 'customer'>, scenarioId: string): string | null => view.customer?.blocked.includes(scenarioId) ? DUNNO_MARK : null;

/** The trust line as plain parts, the way the terminal surfaces print it. */
export const trustParts = (view: ResultView): string[] => trustSegments(view).map(part => part.text);

/** «Внятные запросы: 7 из 9 · Невнятные: 1 из 3» — handled of decided; empty when no counted customer was vague. */
export function clarityParts(view: Pick<ResultView, 'clarity'>): string[] {
  const clarity = view.clarity;
  return clarity ? [`Внятные запросы: ${clarity.clear.passed} из ${clarity.clear.decided}`, `Невнятные: ${clarity.vague.passed} из ${clarity.vague.decided}`] : [];
}

/**
 * The second trust line: how close the number is to real traffic — the topics' shares, and clear requests apart from
 * vague ones. The weighted estimate says which share of the conversations its measured topics hold (coverage.ts gives
 * none below half), and how many conversations have a known topic at all.
 */
export function realityParts(view: ResultView): string[] {
  const topics = view.topics;
  const clarity = clarityParts(view);
  if (!topics || topics.weighted === null) return clarity;
  const notes = [...(topics.measuredShare < 1 ? [`измерены темы ${sharePercent(topics.measuredShare)} диалогов`] : []),
    ...(topics.labeled < topics.logged ? [`темы известны у ${topics.labeled} из ${countText(topics.logged, CONVERSATIONS_OF)}`] : [])];
  return [`С учётом частоты тем — около ${percent(topics.weighted)}${notes.length ? ` (${notes.join('; ')})` : ''}`, ...clarity];
}

/** Where a judge check leaves the judge untrusted: the warning after its counts. */
const DISTRUST_TEXT: Record<NonNullable<JudgeCheckSummary['distrust']>, string> = {
  misses: 'судья не распознал часть изменений, которые генератор считает ошибками',
  false_alarms: 'оценка неизменённых ответов нестабильна',
  incomplete: 'проверка судьи неполная: не все ответы получили вердикт или нет контрольных копий',
};
const PLANTED: [string, string, string] = ['подброшенной ошибки', 'подброшенных ошибок', 'подброшенных ошибок'];

/**
 * «Судья поймал 9 из 10 подброшенных ошибок, ложных тревог 0 из 10» — the judge checked without a person
 * (judge-check.ts), with the warning when it misses planted errors or fails correct replies. Null without a check.
 */
export function judgeCheckText(view: Pick<ResultView, 'judgeCheck'>): { text: string; warn: boolean } | null {
  const check = view.judgeCheck;
  if (!check) return null;
  const parts = [`Судья поймал ${check.detected} из ${check.planted} ${pluralForm(check.planted, PLANTED)}`,
    ...(check.controls ? [`ложных тревог ${check.falseAlarms} из ${countText(check.controls, ['неизменённой копии', 'неизменённых копий', 'неизменённых копий'])}`] : []),
    ...(check.unjudged ? [`без вердикта ${check.unjudged}`] : [])];
  const text = `${parts.join(', ')}${check.distrust ? ` — ${DISTRUST_TEXT[check.distrust]}` : ''}. Это диагностика, а не проверка на независимых эталонах.`;
  return { text, warn: check.distrust !== null };
}

/** Three separate evidence statements. Agreement and consistency never certify correctness. */
export function evaluationEvidenceLines(view: ResultView): string[] {
  const { agreement, simulator, headline, notMeasured } = view;
  const judge = blindText(view) ?? (agreement.checked
    ? `Судья: человек согласился в ${agreement.agreed} из ${countText(agreement.checked, ['проверенного разговора', 'проверенных разговоров', 'проверенных разговоров'])}; это сверка после показа оценки, не слепая калибровка.`
    : 'Судья: ручной сверки оценок этого прогона пока нет.');
  const customer = simulator?.conversations ? customerText(simulator) : 'Клиент: реактивное поведение в этом прогоне не измерено.';
  const remaining = Math.max(0, notMeasured.of - headline.decided);
  const metric = `Метрика: оценено ${headline.decided} из ${countText(notMeasured.of, SITUATIONS_OF)}. Процент относится только к оценённым ситуациям.`;
  const bounds = view.connection && view.connection !== 'passed' ? 'Процент и его границы появятся, когда подключение агента пройдёт экзамен.'
    : notMeasured.of > 0 && remaining > 0
    ? `По полному набору возможны ${percent(headline.passed / notMeasured.of)}–${percent((headline.passed + remaining) / notMeasured.of)} успеха, в зависимости от ${countText(remaining, ['оставшейся ситуации', 'оставшихся ситуаций', 'оставшихся ситуаций'])}. Это границы, не прогноз.`
    : 'Повторы одной ситуации не являются независимыми клиентами; этот набор не доказывает качество на всём трафике.';
  const realism = realismText(view);
  return [judge, customer, ...(realism ? [realism.text] : []), metric, bounds];
}

/**
 * «Клиент: …» — whether the customer Lab played kept to its situation, as the judge read it, over the reactive
 * conversations: the confirmed ones of all, then only the counts that are not zero; the conversations its heuristic
 * checks marked for review, apart. A model's verdict is recorded evidence, not proof the customer behaved like a person.
 */
function customerText(simulator: NonNullable<ResultView['simulator']>): string {
  const tail = [...(simulator.failed ? [`отошёл от ситуации — ${simulator.failed}`] : []), ...(simulator.unknown ? [`судья не уверен — ${simulator.unknown}`] : []),
    ...(simulator.notChecked ? [`не проверялось — ${simulator.notChecked}`] : [])];
  const flags = simulator.heuristicFlags ? ` Ещё в ${countText(simulator.heuristicFlags, ['разговоре', 'разговорах', 'разговорах'])} есть подозрения к клиенту — пометки на разбор.` : '';
  return `Клиент: судья подтвердил, что клиент держался своей ситуации, в ${simulator.passed} из ${countText(simulator.conversations, CONVERSATIONS_OF)}${tail.length ? `; ${tail.join(', ')}` : ''}.${flags}`;
}

/**
 * The judge against the owner's blind labels (blind.ts): how often they agree, and each kind of disagreement — the false
 * «справился» first: an error of the agent the number hides. Null before the first label.
 */
export function blindText(view: Pick<ResultView, 'blind'>): string | null {
  const blind = view.blind;
  if (!blind?.labelled) return null;
  const decided = blind.agreed + blind.falsePasses.length + blind.falseFails.length;
  const parts = [`ложных «справился» — ${blind.falsePasses.length}`, `ложных «не справился» — ${blind.falseFails.length}`,
    ...(blind.judgeUndecided ? [`судья не решил, где решили вы, — ${blind.judgeUndecided}`] : []), ...(blind.ownerUnsure ? [`вы не смогли решить — ${blind.ownerUnsure}`] : []),
    ...(blind.wrongExpectations ? [`ожидание неверно — ${blind.wrongExpectations}`] : [])];
  const tail = blind.falsePasses.length ? ' Судья пропускал ошибки агента: где оценивал только он, процент может быть завышен.' : '';
  return `Судья, слепая проверка: совпал с вами в ${blind.agreed} из ${countText(decided, ['оценки', 'оценок', 'оценок'])}; ${parts.join(', ')}${blind.labelled < blind.drawn ? ` (размечено ${blind.labelled} из ${blind.drawn})` : ''}.${tail}`;
}

/** A mean as a person reads it: «1,5», «3». */
const decimal = (value: number): string => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/**
 * The second assessment of the customer, apart from whether it kept to its situation: how the customers Lab played
 * compare with the logged ones of the same situations (realism.ts) — how many messages after the opening, how many words
 * in one. A customer much wordier than the real ones makes the agent's task easier than in production: that is a
 * warning. Null for a run with no situation from a log.
 */
export function realismText(view: Pick<ResultView, 'realism'>): { text: string; warn: boolean } | null {
  const found = view.realism;
  if (!found) return null;
  const ratio = found.logged.words ? found.synthetic.words / found.logged.words : null;
  const wordy = ratio !== null && ratio >= 1.5, terse = ratio !== null && ratio <= 2 / 3;
  return { warn: wordy || terse,
    text: `Похожесть клиента на реальных (${countText(found.conversations, ['разговор', 'разговора', 'разговоров'])} по ситуациям из логов): реплик после первой — в среднем ${decimal(found.synthetic.messages)} у клиента Lab и ${decimal(found.logged.messages)} у реального; слов в реплике — ${decimal(found.synthetic.words)} и ${decimal(found.logged.words)}.${
      wordy ? ' Клиент Lab заметно многословнее реальных: с ним агенту может быть легче, чем в проде.' : terse ? ' Клиент Lab заметно немногословнее реальных.' : ''} Это сравнение длины и числа реплик, а не оценка того, похож ли клиент на человека.` };
}

/**
 * «Работоспособность»: the conversations where the customer got no reply of the agent, apart from its quality — «в 2 из
 * 20 разговоров клиент не получил ответа агента (агент не дал ответа — 1, вместо агента ответил стенд — 1)». Null when
 * the agent answered in every conversation.
 */
export function operabilityText(view: Pick<ResultView, 'operability'>): string | null {
  const found = view.operability;
  if (!found) return null;
  const parts = [...(found.noReply ? [`агент не дал ответа — ${found.noReply}`] : []), ...(found.serviceReply ? [`вместо агента ответил стенд — ${found.serviceReply}`] : []),
    ...(found.broken ? [`сбой агента — ${found.broken}`] : [])];
  const total = found.noReply + found.serviceReply + found.broken;
  return `Работоспособность: в ${total} из ${countText(found.conversations, CONVERSATIONS_OF)} клиент не получил ответа агента (${parts.join(', ')}). Эти разговоры не считаются ошибками агента по существу и не входят в процент.`;
}

/**
 * The first block of every surface: alarm, number, trust line, whether the agent answered at all, reality line, the judge
 * check, how the synthetic customers compare with production, and the evidence lines. `brief`: without the reality and
 * the evidence lines — the board's first screen, which keeps them under its details.
 */
export function headRows(view: ResultView, options: { brief?: boolean } = {}): ResultRow[] {
  const segments = trustSegments(view);
  const trust = segments.map(part => part.text);
  // The brief head — the board's first screen — leaves the fine print to the details: the reality line and the evidence lines.
  const reality = options.brief ? [] : realityParts(view);
  const checked = judgeCheckText(view);
  const operability = operabilityText(view);
  return [
    ...[alarmRow(view)].filter((row): row is ResultRow => row !== null),
    accuracyRow(view),
    // A terminal paints a row in one colour: a trust line with a warning in it is painted as the warning.
    ...(trust.length ? [{ role: segments.some(part => part.warn) ? 'trust:small' : 'trust', indent: 0, text: trust.join(' · '), parts: trust } as ResultRow] : []),
    // Whether the agent answered at all stands apart from how well: a conversation without its reply is its working state.
    ...(operability ? [{ role: 'trust:small', indent: 0, text: operability } as ResultRow] : []),
    ...(reality.length ? [{ role: 'reality', indent: 0, text: reality.join(' · '), parts: reality } as ResultRow] : []),
    // How far the judge itself can be trusted, measured without a person: a failed check raised the alarm above the
    // number, and here its counts say why, as a warning.
    ...(checked ? [{ role: checked.warn ? 'trust:small' : 'calibration', indent: 0, text: checked.text } as ResultRow] : []),
    // The answer to «can the number be trusted against production»: it stays under the number even where the reality line folds away.
    ...(view.calibration ? [{ role: 'calibration', indent: 0, text: view.calibration.text } as ResultRow] : []),
    ...(options.brief ? [] : evaluationEvidenceLines(view).map(text => ({ role: 'trust' as const, indent: 0, text }))),
  ];
}

/**
 * «Сверка с продом» (docs/design/card-v2-spec.md §10.4–10.5): what was not compared and why, each situation where the synthetic
 * customer and the logged one led to different verdicts — the expectation, both verdicts, what the customers'
 * paths suggest and where both conversations are — and what the agreement does not prove.
 */
export function calibrationRows(view: Pick<ResultView, 'calibration'>): ResultRow[] {
  const calibration = view.calibration;
  if (!calibration) return [];
  const excluded = exclusionsLine(calibration);
  const body: ResultRow[] = [
    ...(excluded ? [{ role: 'muted' as const, indent: 2, text: excluded }] : []),
    ...calibration.disagreements.flatMap(item => [{ role: 'item' as const, indent: 2, text: `№${item.number}  ${oneLine(item.title)}` }, ...disagreementDetails(item, 5)]),
    ...(calibration.compared ? CALIBRATION_CAVEATS.map(text => ({ role: 'muted' as const, indent: 2, text })) : []),
  ];
  // Nothing beyond the line under the number (a calibration skipped for its budget): no block.
  return body.length ? [{ role: 'heading', indent: 0, text: 'Сверка с продом' }, ...body] : [];
}

/** Under a disagreement: each expectation decided differently with both verdicts and whose they are, the hint, where both conversations are. */
function disagreementDetails(item: CalibrationDisagreement, indent: number): ResultRow[] {
  return [...item.expectations.map(row => ({ role: 'quote' as const, indent, text: oneLine(disagreementText(row)) })),
    { role: 'muted', indent, text: item.hint }, { role: 'muted', indent, text: conversationsText(item) }];
}

/**
 * One disagreement of the calibration opened — its own screen on the board, the explanation of its situation in the
 * chat: what «Сверка с продом» says of it, then the run's attempt the calibration compared and the logged conversation,
 * whichever is at hand. `title`: the row naming the situation, for a screen of its own.
 */
export function logDisagreementRows(item: CalibrationDisagreement, options: { title?: boolean; attempt?: readonly Turn[]; log?: readonly Turn[] } = {}): ResultRow[] {
  const attempt = conversationRows(options.attempt ?? [], { heading: `Разговор в прогоне${item.attempt === undefined ? '' : ` · попытка ${item.attempt}`}` });
  const log = conversationRows(options.log ?? [], { heading: 'Разговор из логов' });
  return [...(options.title ? [{ role: 'failed' as const, indent: 0, text: `≠ №${item.number}  ${oneLine(item.title)}`, right: 'сверка с продом' }, blank] : []),
    ...disagreementDetails(item, 4), ...[attempt, log].filter(rows => rows.length).flatMap(rows => [blank, ...rows])];
}

/* ───────────────────────────── conversations and the question about the judge ───────────────────────────── */

/** One turn of a conversation as every surface signs it: «Клиент» or «Агент», never an event number (docs/design/ui-spec.md §2). */
export interface Turn { who: 'Клиент' | 'Агент'; text: string }

/** The customer's and the agent's turns of an attempt, in the order they happened; a turn without words is left out. */
export function trialTurns(trial: Pick<Trial, 'events'> | undefined): Turn[] {
  return (trial?.events ?? []).filter(event => (event.type === 'user' || event.type === 'assistant') && oneLine(event.text ?? ''))
    .map(event => ({ who: event.type === 'user' ? 'Клиент' as const : 'Агент' as const, text: oneLine(event.text) }));
}

/** The same turns of a logged conversation: the customer's and the agent's messages. */
export function loggedTurns(dialogue: Pick<ImportBatch['dialogues'][number], 'events'> | undefined): Turn[] {
  return (dialogue?.events ?? []).flatMap(event => event.type === 'message' && (event.role === 'user' || event.role === 'assistant') && oneLine(event.content)
    ? [{ who: event.role === 'user' ? 'Клиент' as const : 'Агент' as const, text: oneLine(event.content) }] : []);
}

/** The column the words of a turn start at, after «Клиент» or «Агент». */
export const TURN_HANG = 9;
/** «Клиент   Номер терминала: 1234.»: one turn, the words in their column. */
export const turnText = (turn: Turn): string => `${turn.who.padEnd(TURN_HANG)}${turn.text}`;

/** A conversation under its heading — «Разговор» by default —, each turn hanging in its column; nothing for a conversation without turns. */
export function conversationRows(turns: readonly Turn[], options: { heading?: string; indent?: number } = {}): ResultRow[] {
  const indent = options.indent ?? 4;
  return turns.length ? [{ role: 'heading', indent, text: options.heading ?? 'Разговор' },
    ...turns.map(turn => ({ role: 'quote' as const, indent: indent + 2, text: turnText(turn), hang: TURN_HANG }))] : [];
}

/** The owner's answer to the question about the judge: it is right, it is wrong (with the owner's reason), or the owner cannot tell. */
export type JudgeAnswer = 'agree' | 'disagree' | 'unsure';
/** The owner's answer as it is shown back: «Ваш ответ: нет, судья ошибся». */
export const ANSWER_TEXT: Readonly<Record<JudgeAnswer, string>> = { agree: 'да, судья прав', disagree: 'нет, судья ошибся', unsure: 'не знаю' };

/** The question to the owner about one decision of the judge: «Судья решил: не справился. Вы согласны?». */
export const judgeQuestionText = (verdict: 'pass' | 'fail'): string => `Судья решил: ${VERDICT_WORD[verdict]}. Вы согласны?`;

/** The same about the judge's reading of a logged conversation, expectation by expectation. */
export const logQuestionText = (targets: readonly Pick<LogTarget, 'letter' | 'judge'>[]): string => `Судья по логу решил: ${logVerdictsText(targets)}. Вы согласны?`;

/** «1 из 2», with the situations not measured beside it: a scenario is never read as handled on what was not measured. */
const handledCell = (item: { passed: number; decided: number; unmeasured: number }): string =>
  `${item.decided ? `${item.passed} из ${item.decided}` : '—'}${item.unmeasured ? ` · не измерено ${item.unmeasured}` : ''}`;

/**
 * «По сценариям» — the owner's business question answered in the plan's words (card/plan.ts): each scenario of the run,
 * the customers' question and how many of its situations the agent handled; under it each variation, when there are
 * several, and the expectations it broke most often, of the situations they were judged in. Shown once a situation of
 * a scenario is decided or left unmeasured.
 */
export function scenarioRows(view: Pick<ResultView, 'scenarios'>): ResultRow[] {
  const scenarios = view.scenarios?.filter(scenario => scenario.decided || scenario.unmeasured) ?? [];
  if (!scenarios.length) return [];
  return [{ role: 'heading', indent: 0, text: 'По сценариям', right: 'справился' }, ...scenarios.flatMap((scenario): ResultRow[] => [
    { role: 'item', indent: 2, text: `«${oneLine(scenario.question)}»`, right: handledCell(scenario) },
    ...(scenario.variations.length > 1 ? scenario.variations.filter(variation => variation.decided || variation.unmeasured)
      .map((variation): ResultRow => ({ role: 'item:muted', indent: 4, text: `${oneLine(variation.title)}${variation.origin !== 'logs' ? ' — не из логов' : ''}`, right: handledCell(variation) })) : []),
    ...scenario.broken.slice(0, 2).map((item): ResultRow => ({ role: 'muted', indent: 4,
      text: `Нарушено: ${item.mustNot ? 'нельзя — ' : ''}${oneLine(item.text)} — в ${item.count} из ${countText(item.of, SITUATIONS_OF)}` })),
  ])];
}

const MAX_TOPICS = 5;
/** «По темам»: at most five topics by share, the rest in one row, then the share no situation covers. */
export function topicRows(view: ResultView): ResultRow[] {
  const topics = view.topics;
  // A table of dashes says nothing: topics are shown once at least one of them has a decided situation.
  if (!topics?.rows.some(row => row.decided)) return [];
  const shares = topics.rows.some(row => row.share !== null);
  // A share is read like the coverage line reads it: a small topic never shows as 0%, nor a large one as 100%.
  const cells = (passed: number, decided: number, share: number | null) => {
    const handled = (decided ? `${passed} из ${decided}` : '—').padStart(9);
    return shares ? `${handled}   ${(share === null ? '—' : sharePercent(share)).padStart(13)}` : handled;
  };
  const shown = topics.rows.slice(0, MAX_TOPICS);
  const rest = topics.rows.slice(MAX_TOPICS);
  const rows: ResultRow[] = [{ role: 'heading', indent: 0, text: 'По темам', right: shares ? 'справился   доля диалогов' : 'справился' }];
  for (const row of shown) rows.push({ role: 'item', indent: 2, text: row.title, right: cells(row.passed, row.decided, row.share) });
  if (rest.length) {
    const sum = (key: 'passed' | 'decided') => rest.reduce((n, row) => n + row[key], 0);
    rows.push({ role: 'item', indent: 2, text: `Ещё ${countText(rest.length, TOPICS)}`,
      right: cells(sum('passed'), sum('decided'), shares ? rest.reduce((n, row) => n + (row.share ?? 0), 0) : null) });
  }
  if (topics.uncovered) rows.push({ role: 'item:muted', indent: 2, text: 'Не покрыто ситуациями', right: cells(0, 0, topics.uncovered.share) });
  return rows;
}

/**
 * What the agent said in a failure, the same on every surface: the reply the judge pointed at, quoted; otherwise why
 * nothing is quoted. A reply the judge did not point at is never quoted as the evidence of a failure.
 */
export function saidText(failure: Pick<FailureExplanation, 'said' | 'unsaid'>): string {
  if (failure.said) return `«${failure.said.quote}»`;
  return failure.unsaid === 'not_cited' ? 'судья не указал реплику' : failure.unsaid === 'no_reply' ? 'в записи нет ответа агента' : 'ответ не подтверждён цитатой';
}

/** Where a failure names no rule, for its reader. */
export const noRuleText = (reader: Reader = 'owner'): string => reader === 'owner' ? 'у ситуации нет правила из ваших материалов' : 'у ситуации нет правила из материалов владельца агента';

/** «Ожидалось · Агент · Правило» of one failure in two compact rows, the way a cause example and the chat say it. */
function exampleRows(example: FailureExplanation, indent: number): ResultRow[] {
  const expected = example.expected ? `Ожидалось: ${example.expected}` : 'Ожидалось: не записано в ситуации';
  const rule = example.violated ?? example.rules[0];
  return [
    { role: 'muted', indent, text: oneLine(example.title) },
    { role: 'quote', indent, text: `${expected} · Агент: ${saidText(example)}` },
    ...(rule ? [{ role: 'quote' as const, indent, text: `Правило: «${rule.quote}»` }] : []),
  ];
}

/** «и ещё 2 причины»: the recorded causes past the three «Почему ошибается» names. */
export const moreCausesText = (count: number): string => `и ещё ${countText(count, CAUSES)}`;

/** A failed part of a verdict as a cause says it: «Нарушено: объяснить, как оформить возврат», «Не выполнен запрос клиента». */
export function brokenText(part: BrokenPart): string {
  switch (part.kind) {
    case 'expectation': return `Нарушено: ${part.mustNot ? 'нельзя — ' : ''}${part.text}`;
    case 'checks': return 'Не пройдены точные проверки';
    case 'goal': return 'Не выполнен запрос клиента';
    case 'rules': return 'Нарушены правила промпта';
  }
}

/** «Почему ошибается» names this many causes; the rest are only counted. */
const TOP_CAUSES = 3;

/** One cause of «Почему ошибается»: its words, the situations it failed, the failure that shows it. */
export interface CauseItem { text: string; count: number; scenarioIds: string[]; example: FailureExplanation;
  /** A cause named by the failure itself — the situation's title, where nothing else says why —: its example needs no title row. */
  titled?: true }

/**
 * The causes «Почему ошибается» names, largest first — the causes the run named; where it named none, what the failed
 * situations broke, in the card's own words; only where not even that is known (a legacy card decided by its strict
 * result), the failed situations by title — at most three, and how many more there are (`more`, counted in causes, or in
 * errors for titles). Every surface lists these, and a cursor opens a cause by its first situation.
 */
export function causeItems(view: Pick<ResultView, 'topCauses' | 'moreCauses' | 'broken' | 'failures'>): { items: CauseItem[]; more: number; moreText: string } {
  if (view.topCauses.length) return { items: view.topCauses.map(cause => ({ text: oneLine(cause.name), count: cause.count, scenarioIds: cause.scenarioIds, example: cause.example })),
    more: view.moreCauses, moreText: moreCausesText(view.moreCauses) };
  const failed = new Map(view.failures.map(failure => [failure.scenarioId, failure]));
  const broken = view.broken.flatMap(item => {
    const example = item.scenarioIds.map(id => failed.get(id)).find(failure => failure !== undefined);
    return example ? [{ text: brokenText(item.part), count: item.count, scenarioIds: item.scenarioIds, example }] : [];
  });
  const more = (total: number) => Math.max(0, total - TOP_CAUSES);
  if (broken.length) return { items: broken.slice(0, TOP_CAUSES), more: more(broken.length), moreText: moreCausesText(more(broken.length)) };
  return { items: view.failures.slice(0, TOP_CAUSES).map(failure => ({ text: oneLine(failure.title), count: 1, scenarioIds: [failure.scenarioId], example: failure, titled: true as const })),
    more: more(view.failures.length), moreText: `и ещё ${countText(more(view.failures.length), ERRORS)}` };
}

/**
 * «Почему ошибается»: up to three causes with their size, largest first (causeItems), each with its example when
 * `examples`, and how many more there are. When something was decided and nothing failed, the one honest sentence
 * about what that does not prove — and that only the measured situations had no error when some were not measured.
 */
export function causeRows(view: ResultView, options: { examples?: boolean } = {}): ResultRow[] {
  if (!view.failures.length) {
    const unmeasured = view.notMeasured.total;
    return view.headline.decided ? [{ role: unmeasured ? 'muted' : 'good', indent: 0, text: noErrorsText(view.headline.decided, unmeasured) }] : [];
  }
  const { items, more, moreText } = causeItems(view);
  return [{ role: 'heading', indent: 0, text: 'Почему ошибается' }, ...items.flatMap((cause, i): ResultRow[] => [
    { role: 'item', indent: 2, text: `${i + 1}  ${cause.text}`, right: countText(cause.count, SITUATIONS), short: String(cause.count) },
    ...(options.examples ? exampleRows(cause.example, 5).slice(cause.titled ? 1 : 0) : []),
  ]), ...(more ? [{ role: 'muted' as const, indent: 2, text: moreText }] : [])];
}

/**
 * «Оговорки»: what this record's result does not prove (caveats.ts) — why its causes were not named, a re-assessment, a
 * judge that stood in for another… —, one short row each, in the words caveats.ts gives its reader; nothing without any.
 */
export function caveatRows(view: Pick<ResultView, 'notes'>, reader: Reader = 'owner'): ResultRow[] {
  const lines = caveatLines(view.notes, reader);
  return lines.length ? [{ role: 'heading', indent: 0, text: 'Оговорки' }, ...lines.map(text => ({ role: 'muted' as const, indent: 2, text }))] : [];
}

/** «Не измерено»: every unmeasured situation with its reason, grouped in the order of the reasons. */
export function unmeasuredRows(view: ResultView): ResultRow[] {
  if (!view.notMeasured.total) return [];
  const titles = new Map(view.cards.map(card => [card.scenarioId, oneLine(card.title)]));
  return [{ role: 'heading', indent: 0, text: 'Не измерено' },
    ...view.notMeasured.reasons.flatMap(reason => reason.scenarioIds.map(id => ({ role: 'item:muted' as const, indent: 2, text: `${titles.get(id) ?? id}: ${reason.label}` })))];
}

/** «№2»: a situation as every surface names it, by the number the owner knows it by (ResultCard.number). */
export const situationLabel = (view: Pick<ResultView, 'cards'>, scenarioId: string): string => {
  const number = view.cards.find(card => card.scenarioId === scenarioId)?.number;
  return number === undefined ? '' : `№${number}`;
};

/** Every failed situation once, in record order, with what was expected, the agent's words and the rule (E7). */
export function errorListRows(view: ResultView): ResultRow[] {
  if (!view.failures.length) return [];
  return [{ role: 'heading', indent: 0, text: 'Все ошибки' }, ...view.failures.flatMap((failure, i) => {
    const mark = dunnoMark(view, failure.scenarioId);
    return [
      { role: 'failed' as const, indent: 2, text: `✗ ${situationLabel(view, failure.scenarioId)}  ${oneLine(failure.title)}` },
      ...exampleRows(failure, 5).slice(1),
      ...(mark ? [{ role: 'muted' as const, indent: 5, text: mark }] : []),
    ];
  })];
}

const VERDICT_WORD = { pass: 'справился', fail: 'не справился' } as const;
/** The owner's side of one headline half after a mark: the half as it now stands, or that the owner could not tell. */
const HALF_WORD: Record<string, Record<'pass' | 'fail' | 'unsure', string>> = {
  goal_attainment: { pass: 'запрос выполнен', fail: 'запрос не выполнен', unsure: 'про запрос не уверены' },
  prompt_compliance: { pass: 'правила промпта соблюдены', fail: 'правила промпта нарушены', unsure: 'про правила промпта не уверены' },
};

/**
 * What the owner said about one situation. A full overturn is one word, the opposite of the judge's.
 * When the owner overturned one of the two halves that decided it, the verdict word alone would read
 * «не справился → не справился» (CTX-26), so the row names the halves instead: the overturned one
 * first, then the other — the judge's side where the owner agreed, «не уверены» where they could not tell.
 */
function ownerSide(view: ResultView, item: ResultView['agreement']['disagreements'][number]): string {
  if (!item.overturned) return VERDICT_WORD[item.human];
  const overturned = new Set(item.overturned);
  const opposite = item.judge === 'fail' ? 'pass' : 'fail';
  const targets = view.agreement.marks.find(mark => mark.trialId === item.trialId)?.targets ?? [];
  const half = (target: (typeof targets)[number]) => {
    const words = HALF_WORD[target.metricId];
    if (!words) return VERDICT_WORD[target.answer === 'disagree' ? opposite : item.judge];
    return target.answer === 'unsure' ? words.unsure : words[target.answer === 'disagree' ? opposite : item.judge];
  };
  return [...targets.filter(target => overturned.has(target.metricId)), ...targets.filter(target => !overturned.has(target.metricId))].map(half).join('; ');
}

/**
 * Where the owner overturned the judge (F7): the situation, both sides and the owner's reason in
 * full, in the card order of the record. Only current disagreements: an unsure or a stale mark overturned nothing.
 */
export function disagreementRows(view: ResultView): ResultRow[] {
  const items = view.agreement.disagreements;
  if (!items.length) return [];
  return [{ role: 'heading', indent: 0, text: 'Вы не согласились с судьёй' }, ...items.flatMap(item => [
    { role: 'item' as const, indent: 2, text: oneLine(item.title) },
    { role: 'muted' as const, indent: 4, text: `Судья: ${VERDICT_WORD[item.judge]} → вы: ${ownerSide(view, item)}` },
    ...(oneLine(item.note) ? [{ role: 'quote' as const, indent: 4, text: `Причина: «${oneLine(item.note)}»` }] : []),
  ])];
}

/** The fix a connection's exam asks for, by how it ended: every surface says it first while the percent waits. */
const EXAM_STEP: Readonly<Record<ExamWithheld, { board: string; chat: string; cli: string }>> = {
  absent: { board: 'Добавить экзамен подключения — без него процент не считается',
    chat: 'Дальше: добавьте экзамен подключения — скажите «составь экзамен подключения»: без него процент не считается.',
    cli: 'Добавьте экзамен подключения: раздел exam в файле подключения, затем agent-lab doctor --connection подключение.json --yes' },
  failed: { board: 'Исправить подключение: экзамен не пройден — без него процент не считается',
    chat: 'Дальше: исправьте подключение — экзамен не пройден, процент не считается; скажите «проверь подключение».',
    cli: 'Исправьте подключение и сдайте экзамен: agent-lab doctor --connection подключение.json --yes' },
};

/** One next step as a row of the «Дальше» list on the board and in the report. */
export function nextStepText(step: NextStep): string {
  switch (step.kind) {
    case 'exam': return EXAM_STEP[step.status].board;
    case 'check_connection': return 'Проверить связь с агентом и судью — пока это не сделано, числу не верить';
    case 'wait': return 'Дождаться конца прогона — результат появится сам';
    case 'review_judge': {
      const parts = [
        ...(step.failures ? [`${countText(step.failures, ERRORS)} ${pluralForm(step.failures, ['ждёт', 'ждут', 'ждут'])} вашего «да» или «нет»`] : []),
        ...(step.passes ? [`${countText(step.passes, PASSES)} на перепроверку`] : []),
        ...(step.unsure ? [`${step.unsure} с ответом «не знаю»`] : []),
      ];
      return `Проверить, прав ли судья — ${parts.join(', ')}`;
    }
    case 'blind_check': return `Проверить судью вслепую — ${countText(step.left, ['оценка', 'оценки', 'оценок'])} без его вердиктов`;
    case 'why_unmeasured': return `Посмотреть, почему ${pluralForm(step.count, ['не измерена', 'не измерены', 'не измерено'])} ${countText(step.count, SITUATIONS)}`;
    case 'repeat': return 'Повторить прогон на новой версии агента';
    case 'report': return 'Отчёт для заказчика';
  }
}

/** The same step said in the conversation: what to ask for, in the owner's words. */
function chatNextText(step: NextStep): string {
  switch (step.kind) {
    case 'exam': return EXAM_STEP[step.status].chat;
    case 'check_connection': return 'Дальше: проверьте связь с агентом — скажите «проверь подключение».';
    case 'wait': return 'Дальше: дождитесь конца прогона — результат придёт сюда.';
    case 'review_judge': return `Дальше: проверьте, прав ли судья, — скажите ${step.situation === null ? '«покажи ошибки»' : `«разбери ситуацию ${step.situation}»`}.`;
    case 'blind_check': return 'Дальше: проверьте судью вслепую — скажите «проверь судью вслепую»: вы оцените ответы агента, не видя его вердиктов.';
    case 'why_unmeasured': return 'Дальше: спросите, почему ситуации не измерены.';
    case 'repeat': return 'Дальше: исправьте агента и скажите «повтори прогон».';
    case 'report': return 'Дальше: скажите «отчёт для заказчика».';
  }
}

/** The same step on the command line: the command that does it, with the full run id a command needs. */
function cliNextText(step: NextStep, runId: string): string {
  switch (step.kind) {
    case 'exam': return EXAM_STEP[step.status].cli;
    case 'check_connection': return 'Проверьте подключение: agent-lab doctor --yes';
    case 'wait': return 'Дождитесь конца прогона';
    case 'review_judge': return 'Проверьте, прав ли судья: откройте прогон в Pi (/agent-lab)';
    case 'blind_check': return 'Проверьте судью вслепую: откройте прогон в Pi (/agent-lab)';
    case 'why_unmeasured': return 'Причины — в списке «Не измерено» выше';
    case 'repeat': return `Повторите прогон: agent-lab repeat --id ${runId}`;
    case 'report': return `Отчёт для заказчика: agent-lab export --id ${runId} --format html`;
  }
}

/** «Дальше»: the recommended step first (accent), then what a finished result always offers. */
export function nextRows(view: ResultView, surface: Surface): ResultRow[] {
  if (!view.next.length) return [];
  if (surface === 'chat') return [{ role: 'next:first', indent: 0, text: chatNextText(view.next[0]!) }];
  const text = (step: NextStep) => surface === 'cli' ? cliNextText(step, view.runId) : nextStepText(step);
  return [{ role: 'heading', indent: 0, text: 'Дальше' },
    ...view.next.map((step, i) => ({ role: i ? 'next' as const : 'next:first' as const, indent: 2, text: text(step) }))];
}

const MONTHS = ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
/** «сегодня в 14:05», «вчера в 18:22», «19 сент. в 16:02» — in the local time of whoever reads it. */
export function whenText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  return days === 0 ? `сегодня в ${time}` : days === 1 ? `вчера в ${time}` : `${at.getDate()} ${MONTHS[at.getMonth()]} в ${time}`;
}

/** «Прогон сегодня в 14:05 · версия baseline-v1 · 14 ситуаций · $0.14 · учебный пример». */
export function runLine(view: ResultView, now?: Date): ResultRow {
  const parts = [`Прогон ${whenText(view.createdAt, now)}`, ...(view.scope.target ? [`версия ${view.scope.target}`] : []), countText(view.scope.cards, SITUATIONS),
    ...(view.scope.costUsd ? [`$${view.scope.costUsd.toFixed(2)}`] : []), ...(view.mode === 'demo' ? ['учебный пример'] : [])];
  return { role: 'muted', indent: 0, text: parts.join(' · '), parts };
}

/** «Оценка по правилам: …» under the run line: the bar the number was measured against; nothing for rules grounded before kinds. */
export function barRows(view: ResultView): ResultRow[] {
  return view.bar ? [{ role: 'muted', indent: 0, text: ruleBarText(view.bar) }] : [];
}

/**
 * The result screen of the board and the CLI (docs/design/ui-spec.md §4.7, §8.5): the head, the topics, the causes,
 * then — on the CLI and under the board's details — every error, the unmeasured situations, the
 * owner's disagreements, the calibration against production and what the result does not prove;
 * the run line and «Дальше» last. Blocks are separated by one blank row, never two.
 */
export function resultScreen(view: ResultView, options: { surface: 'board' | 'cli'; details?: boolean; now?: Date }): ResultRow[] {
  // The board keeps its first screen short; its details and the CLI list every error, the unmeasured situations and the owner's disagreements once.
  const full = options.surface === 'cli' || !!options.details;
  const blocks = [headRows(view), scenarioRows(view), topicRows(view), causeRows(view),
    ...(full ? [errorListRows(view), unmeasuredRows(view), disagreementRows(view), calibrationRows(view), caveatRows(view)] : []),
    [runLine(view, options.now), ...barRows(view)], nextRows(view, options.surface)];
  return blocks.filter(rows => rows.length).flatMap((rows, i) => i ? [blank, ...rows] : rows);
}

/**
 * The chat block (docs/design/ui-spec.md §4.10). Collapsed: the number, the trust line, the calibration line and the causes in one row.
 * Expanded: the number, the trust and reality lines, every cause with its example, the unmeasured
 * situations, what the result does not prove and «Дальше». The host adds the ctrl+o hint under the last row.
 */
export function chatBlock(view: ResultView, options: { expanded: boolean }): ResultRow[] {
  const head = headRows(view).map(row => row.role.startsWith('accuracy') || row.role === 'alarm' ? row : { ...row, indent: 2 });
  if (!options.expanded) {
    const { items, more, moreText } = causeItems(view);
    const causeParts = [...items.map(cause => `${cause.text} (${cause.count})`), ...(more ? [moreText] : [])];
    const noErrors = view.failures.length ? [] : causeRows(view).map(row => ({ ...row, indent: 2 }));
    return [...head.filter(row => row.role !== 'reality'), ...noErrors,
      ...(causeParts.length ? [{ role: 'muted' as const, indent: 2, text: `Чаще всего: ${causeParts.join(' · ')}`, parts: [`Чаще всего: ${causeParts[0]}`, ...causeParts.slice(1)] }] : [])];
  }
  const indent = (rows: ResultRow[]) => rows.map(row => ({ ...row, indent: row.indent + 2 }));
  const blocks = [head, indent(scenarioRows(view)), indent(causeRows(view, { examples: true })), indent(unmeasuredRows(view)), indent(caveatRows(view)), indent(nextRows(view, 'chat'))];
  return blocks.filter(rows => rows.length).flatMap((rows, i) => i ? [blank, ...rows] : rows);
}

/* ───────────────────────────── two runs compared ───────────────────────────── */

/**
 * Two runs compared (comparison.ts), the only copy of its words: the run compared with and the answer, how much could be
 * compared, what broke and what was fixed; then, for the owner, what could not be compared and why, the notes, and the
 * step an unknown version of the agent calls for. The chat, the CLI `diff` and the customer report lay these rows out.
 * A page for others names the run compared with by its version, never by a date that is relative to today, says what
 * changed and on what that stands — the unknown version said, not asked for — and asks nothing: what could not be
 * compared and the other notes tell the owner what to do, and stay in the owner's tools. `selected`: the owner chose
 * the run compared with.
 */
export function comparisonRows(comparison: RunComparison, before: Pick<Experiment, 'createdAt' | 'targetVersion' | 'targetRelease'>,
  options: { reader?: Reader; selected?: boolean; now?: Date } = {}): ResultRow[] {
  const owner = (options.reader ?? 'owner') === 'owner';
  const version = before.targetVersion ?? before.targetRelease;
  const base = options.selected ? 'База выбрана вручную' : owner ? `Сравнение с прогоном ${whenText(before.createdAt, options.now)}` : 'Сравнение с прошлым прогоном';
  const { coverage, fixed, regressed, unchanged, incomparable } = comparison;
  const counts = [`Сравнимо ${coverage.validPairs} из ${countText(coverage.plannedPairs, CONVERSATIONS_OF)}`, `исправлено ${fixed.length}`, `сломалось ${regressed.length}`,
    `без изменений ${unchanged.passing + unchanged.failing}`];
  const rows: ResultRow[] = [
    { role: comparison.comparable ? 'item' : 'trust:small', indent: 0, text: `${base}${version ? ` — версия ${version}` : ''}. ${comparison.headline}` },
    { role: 'muted', indent: 0, text: counts.join(' · '), parts: counts },
    ...regressed.map(item => ({ role: 'failed' as const, indent: 2, text: `Сломалось: ${oneLine(item.title)}` })),
    ...fixed.map(item => ({ role: 'good' as const, indent: 2, text: `Исправлено: ${oneLine(item.title)}` })),
  ];
  if (!owner) return comparison.versionUnknown ? [...rows, { role: 'muted', indent: 0, text: VERSION_UNKNOWN_NOTE }] : rows;
  // Runs that could not be compared at all share one reason — the notes below —, so their situations are named once, without it.
  const repeats = incomparable.some(item => item.repeat > 0);
  const pairs = (comparison.comparable ? incomparable.map(item => `${oneLine(item.title)}${repeats ? ` (попытка ${item.repeat + 1})` : ''} — ${oneLine(item.reason)}`)
    : [...new Set(incomparable.map(item => oneLine(item.title)))]).map(text => ({ role: 'item:muted' as const, indent: 2, text: `Несравнимо: ${text}` }));
  return [...rows, ...pairs,
    ...(comparison.notes.length ? [{ role: 'heading' as const, indent: 0, text: 'Оговорки' }, ...comparison.notes.map(note => ({ role: 'muted' as const, indent: 2, text: note }))] : []),
    ...(comparison.versionUnknown ? [{ role: 'next:first' as const, indent: 0, text: 'Дальше: назовите версию агента при запуске — тогда повтор покажет, что изменила новая версия.' }] : [])];
}

/** One failure explained on one screen (E7): expected → the agent's words → the owner's rule → the conversation. */
export function failureRows(view: ResultView, record: Pick<Experiment, 'trials'>, index: number): ResultRow[] {
  const failure = view.failures[index];
  if (!failure) return [];
  const label = (name: string, text: string): ResultRow => ({ role: 'item', indent: 4, text: `${name.padEnd(16)}${text}`, hang: 16 });
  const rule = failure.violated ?? failure.rules[0];
  const conversation = conversationRows(trialTurns(record.trials.find(item => item.id === failure.trialId)));
  const unmarked = view.agreement.unmarked.includes(failure.trialId);
  const mark = dunnoMark(view, failure.scenarioId);
  return [
    { role: 'failed', indent: 0, text: `✗ ${situationLabel(view, failure.scenarioId)}  ${oneLine(failure.title)}`, right: `ошибка ${index + 1} из ${view.failures.length}` },
    blank,
    label('Ожидалось', failure.expected ?? 'не записано в ситуации'),
    label('Агент ответил', saidText(failure)),
    ...(rule ? [label('Правило', `«${rule.quote}»`), { role: 'muted' as const, indent: 20, text: oneLine(rule.sourceName) }] : [label('Правило', noRuleText())]),
    ...(mark ? [label('Клиент', mark)] : []),
    ...(conversation.length ? [blank, ...conversation] : []),
    ...(unmarked ? [blank, { role: 'next:first' as const, indent: 0, text: judgeQuestionText('fail') }] : []),
  ];
}

/* ───────────────────────────── layout ───────────────────────────── */

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The runs of spaces and the words between them, in order; only a plain space separates words. */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const char of text) {
    const last = out.at(-1);
    if (last !== undefined && (last[0] === ' ') === (char === ' ')) out[out.length - 1] = last + char;
    else out.push(char);
  }
  return out;
}

/** The longest head of `word` that fits in `room` columns, at least one grapheme, and the rest; nothing is added or lost. */
function splitWord(word: string, room: number): [string, string] {
  let head = '', used = 0;
  for (const { segment } of graphemes.segment(word)) {
    const width = visibleWidth(segment);
    if (head && used + width > room) break;
    head += segment; used += width;
  }
  return [head, word.slice(head.length)];
}

/**
 * Word-wrap in terminal columns (wide characters count double) without changing the text: lines break only at spaces
 * — the spaces at a break are dropped, the others kept —, a line break of the text stays one, and a word wider than
 * its line is split between its characters with nothing inserted. `width(i)` is the room of the i-th line, so a
 * hanging indent narrows every line after the first.
 */
export function wrapText(text: string, width: (line: number) => number): string[] {
  const lines: string[] = [];
  const room = () => Math.max(1, width(lines.length));
  for (const paragraph of text.split('\n')) {
    let line = '', pending = '';
    for (const token of tokens(paragraph)) {
      if (token[0] === ' ') { pending += token; continue; }
      if (visibleWidth(line + pending + token) <= room()) { line += pending + token; pending = ''; continue; }
      if (line) lines.push(line);
      line = ''; pending = '';
      let rest = token;
      while (visibleWidth(rest) > room()) {
        const [head, tail] = splitWord(rest, room());
        lines.push(head);
        rest = tail;
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

// truncateToWidth closes its ellipsis with style resets for a live terminal; these rows are plain text, painted later by role.
const clipTo = (text: string, width: number) => stripTerminalSequences(truncateToWidth(text, Math.max(1, width), '…'));

/** The « ·» after a part, and the same separator glued to the part's last word by a no-break space while the part wraps. */
const SEPARATOR = ' ·';
const GLUED = '\u00a0·';

/**
 * The parts of a « · » row packed into lines of `room` columns (continuation lines two narrower): a part goes whole to
 * the next line when it does not fit, and a part longer than a line wraps inside itself. The separator belongs to the
 * part before it, so a broken line ends with «·» and none starts with it; the parts' own text is never changed.
 */
function packParts(parts: readonly string[], room: number): string[] {
  const lines: string[] = [];
  const roomAt = (line: number) => line ? room - 2 : room;
  let current = '';
  for (const [i, part] of parts.entries()) {
    const tail = i < parts.length - 1 ? SEPARATOR : '';
    const joined = current ? `${current} ${part}${tail}` : `${part}${tail}`;
    if (visibleWidth(joined) <= roomAt(lines.length)) { current = joined; continue; }
    if (current) lines.push(current);
    // Wrapped, the part keeps its separator glued to its last word, so the dot never goes down alone.
    const pieces = wrapText(tail ? `${part}${GLUED}` : part, line => roomAt(lines.length + line));
    // A word longer than its line may be split right before the glued separator: its last character goes down with it.
    const last = pieces.at(-1)!;
    if (tail && pieces.length > 1 && (last === '·' || last === GLUED)) {
      const before = pieces[pieces.length - 2]!;
      const glue = last === '·' && before.endsWith('\u00a0') ? '\u00a0' : '';
      const core = before.slice(0, before.length - glue.length);
      const [head, moved] = splitWord(core, Math.max(1, visibleWidth(core) - 1));
      pieces.splice(-2, 2, head, moved + glue + last);
    }
    // The glue was the layout's own: the separator is printed with its plain space, as on an unbroken line.
    const end = pieces.at(-1)!;
    if (tail && end.endsWith(GLUED)) pieces[pieces.length - 1] = end.slice(0, -GLUED.length) + SEPARATOR;
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Plain lines of at most `width` (capped at MAX_WIDTH) terminal columns: a right counter aligned to
 * the edge (its text clipped with «…», the counter never), « · » parts packed per line, everything
 * else word-wrapped under its hanging indent without a character added or lost. One layout for the
 * board, the chat and the CLI, so the three never wrap differently; widths are measured in columns,
 * never in string length.
 */
export function fitRows(rows: ResultRow[], width: number): { role: ResultRole; text: string }[] {
  const edge = Math.max(20, Math.min(width, MAX_WIDTH));
  return rows.flatMap(row => {
    const pad = ' '.repeat(row.indent + 1);
    const room = edge - pad.length;
    if (row.right !== undefined) {
      if (row.short !== undefined && edge < 80) return [{ role: row.role, text: pad + clipTo(row.text, room - visibleWidth(row.short) - 3) + ` — ${row.short}` }];
      const text = clipTo(row.text, room - visibleWidth(row.right) - 2);
      return [{ role: row.role, text: pad + text + ' '.repeat(Math.max(2, room - visibleWidth(text) - visibleWidth(row.right))) + row.right }];
    }
    if (row.parts) return packParts(row.parts, room).map((line, i) => ({ role: row.role, text: (i ? `${pad}  ` : pad) + line }));
    if (!row.text) return [{ role: row.role, text: '' }];
    const hang = row.hang ?? 0;
    return wrapText(row.text, line => line ? room - hang : room).map((piece, i) => ({ role: row.role, text: pad + (i ? ' '.repeat(hang) : '') + piece }));
  });
}

/** The rows as plain text: the CLI prints this, and the saved text renders are made with it. */
export const plainText = (rows: ResultRow[], width: number) => fitRows(rows, width).map(line => line.text.trimEnd()).join('\n');
