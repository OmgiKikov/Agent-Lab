import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { CALIBRATION_CAVEATS, conversationsText, disagreementText, exclusionsLine } from './card/calibration-view.js';
import { ruleBarText } from './card/rulebook.js';
import type { Experiment } from './contracts.js';
import type { FailureExplanation } from './explain.js';
import type { JudgeCheckSummary } from './judge-check.js';
import { sharePercent } from './miner/coverage.js';
import { countText, pluralForm } from './plural.js';
import type { NextStep, ResultView } from './result-view.js';
import { oneLine } from './text.js';

/*
 * The words of a result, the only copy. The chat block, the board, the CLI summary and the report
 * all say the same lines in the same order (docs/design/ui-spec.md §4.7, §4.10, §8.5):
 *
 *   Точность агента: 72% — справился в 18 из 25 ситуаций          ← the answer, coloured by level
 *     (…, ещё 4 не измерено — above NOT_MEASURED_WARN_ABOVE %, never coloured good)
 *   Вероятно, от 52% до 86% (95%) · не измерено 2 — … · …          ← one trust line
 *   С учётом частоты тем — около 70%                              ← only when topics are known
 *   По темам / Почему ошибается / Дальше                          ← rows with a right-hand counter
 *
 * Rows are semantic (a role, an indent, a text, an optional right-hand counter or « · » parts);
 * `fitRows` lays them out as plain lines of a given width, so every surface wraps identically and
 * Pi only paints. Pure: no I/O, no escaping — each surface escapes at its own boundary.
 */

export type ResultRole =
  | 'accuracy:good' | 'accuracy:warn' | 'accuracy:bad' | 'accuracy:none' | 'alarm'
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
/** The one sentence of a result in which nothing failed: how much was checked, and that it promises nothing about live customers. */
export const noErrorsText = (decided: number): string =>
  `Ошибок нет. Это не гарантия для живых клиентов: ${pluralForm(decided, CHECKED)} ${countText(decided, SITUATIONS)}.`;
/** Genitive after «из»: «1 из 1 ситуации», «9 из 13 ситуаций». */
const SITUATIONS_OF: [string, string, string] = ['ситуации', 'ситуаций', 'ситуаций'];
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
/**
 * The answer of every result surface in three pieces, so the report can set the number large:
 * «Точность агента:» · «72%» · «— справился в 18 из 25 ситуаций». Without a decided situation the
 * value is null and the tail says why.
 */
export function accuracyParts(view: ResultView): { lead: string; value: string | null; tail: string; level: Level } {
  const lead = 'Точность агента:';
  const value = percentOf(view);
  if (value === null) {
    const tail = view.phase === 'review' || view.phase === 'preparing' && !view.pending ? 'прогон ещё не запускался'
      : view.pending ? `считается — ждут проверки ${countText(view.pending, SITUATIONS)}`
      : 'нет данных — ни одна ситуация не измерена';
    return { lead, value: null, tail, level: 'none' };
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

/** Above the number when a positive control failed or was not measured: the number is not to be trusted yet. */
export function alarmRow(view: ResultView): ResultRow | null {
  const { alarm, cards } = view.control;
  if (!alarm) return null;
  const many = cards.length > 1;
  const what = alarm === 'failed' ? (many ? 'контрольные ситуации не прошли' : 'контрольная ситуация не прошла')
    : alarm === 'unmeasured' ? (many ? 'контрольные ситуации не измерены' : 'контрольная ситуация не измерена')
      : 'контрольные ситуации не прошли или не измерены';
  return { role: 'alarm', indent: 0, text: `✗ Числу пока не верить: ${what} — проверьте связь с агентом` };
}

/** Situations whose verdict is not stable: repeats inside the run disagreed, or it flipped against the source run. */
export const unstableCount = (view: ResultView) => view.cards.filter(card => !card.control && (card.flaky || card.unstable)).length;

/**
 * The one trust line under the number, in segments: the 95% interval (and a small-sample warning, the
 * one segment a surface may colour as a warning), what was not measured and the main reason, what is
 * still being checked, the owner's agreement with the judge, the unstable situations. A segment with
 * nothing to say is left out; the first one starts the sentence.
 */
export function trustSegments(view: ResultView): { text: string; warn: boolean }[] {
  const { headline, notMeasured, agreement } = view;
  const parts: { text: string; warn: boolean }[] = [];
  const add = (text: string, warn = false) => { parts.push({ text, warn }); };
  if (headline.range) add(`Вероятно, от ${percent(headline.range[0])} до ${percent(headline.range[1])} (95%)`);
  if (headline.smallSample) add('мало данных', true);
  const [main] = notMeasured.reasons;
  if (main) add(notMeasured.reasons.length === 1 ? `не измерено ${notMeasured.total} — ${main.label}`
    : `не измерено ${notMeasured.total} — чаще всего ${main.label} (${main.count})`);
  if (view.pending) add(`ещё проверяется ${view.pending}`);
  if (agreement.checked) add(`с судьёй согласны ${agreement.agreed} из ${agreement.checked}`);
  else if (view.reviewed.situations) add(`вы проверили ${countText(view.reviewed.situations, ['ситуацию', 'ситуации', 'ситуаций'])}`);
  else if (agreement.queueFailures.length + agreement.sampledPasses.length) add('судью ещё не проверяли');
  if (view.sameModelJudge) add('судья — та же модель, что готовила ситуации', true);
  if (view.reviewed.contradicted) add(`ваши отметки расходятся с итогом: ${view.reviewed.contradicted}`, true);
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
 * «Клиент не знал ответа на 40% вопросов агента»: the customer's «не знаю» among every reply to an agent's question
 * (a fact named or «не знаю»); null when no controlled customer was asked anything. Said on every surface in these words.
 */
export function dunnoText(view: Pick<ResultView, 'customer'>): string | null {
  const moves = view.customer;
  const asked = moves ? moves.answer + moves.missing : 0;
  return moves && asked ? `клиент не знал ответа на ${percent(moves.missing / asked)} вопросов агента` : null;
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

/** The second trust line: how close the number is to real traffic — the topics' shares, and clear requests apart from vague ones. */
export function realityParts(view: ResultView): string[] {
  const topics = view.topics;
  const clarity = clarityParts(view);
  if (!topics || topics.weighted === null) return clarity;
  const known = topics.labeled < topics.logged ? ` (темы известны у ${topics.labeled} из ${topics.logged} разговоров)` : '';
  return [`С учётом частоты тем — около ${percent(topics.weighted)}${known}`, ...clarity];
}

/** Where a judge check leaves the judge untrusted: the warning after its counts. */
const DISTRUST_TEXT: Record<NonNullable<JudgeCheckSummary['distrust']>, string> = {
  misses: 'судье нельзя доверять: пропускает подброшенные ошибки',
  false_alarms: 'судье нельзя доверять: находит ошибки в верных ответах',
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
    ...(check.controls ? [`ложных тревог ${check.falseAlarms} из ${check.controls}`] : [])];
  const text = `${parts.join(', ')}${check.distrust ? ` — ${DISTRUST_TEXT[check.distrust]}` : ''}`;
  return { text, warn: check.distrust !== null };
}

/** The first block of every surface: alarm, number, trust line, reality line, the judge check, and how the synthetic customers compare with production. */
export function headRows(view: ResultView): ResultRow[] {
  const trust = trustParts(view);
  const reality = realityParts(view);
  const checked = judgeCheckText(view);
  return [
    ...[alarmRow(view)].filter((row): row is ResultRow => row !== null),
    accuracyRow(view),
    ...(trust.length ? [{ role: view.headline.smallSample ? 'trust:small' : 'trust', indent: 0, text: trust.join(' · '), parts: trust } as ResultRow] : []),
    ...(reality.length ? [{ role: 'reality', indent: 0, text: reality.join(' · '), parts: reality } as ResultRow] : []),
    // How far the judge itself can be trusted, measured without a person: a warning is an alarm, like a failed control.
    ...(checked ? [{ role: checked.warn ? 'alarm' : 'calibration', indent: 0, text: checked.text } as ResultRow] : []),
    // The answer to «can the number be trusted against production»: it stays under the number even where the reality line folds away.
    ...(view.calibration ? [{ role: 'calibration', indent: 0, text: view.calibration.text } as ResultRow] : []),
  ];
}

/**
 * «Сверка с продом» (docs/design/card-v2-spec.md §10.4–10.5): what was not compared and why, each situation where the synthetic
 * customer and the logged one led to different verdicts — the expectation, both verdicts, what the customers'
 * paths suggest and where both conversations are — and what the agreement does not prove.
 */
export function calibrationRows(view: ResultView): ResultRow[] {
  const calibration = view.calibration;
  if (!calibration) return [];
  const excluded = exclusionsLine(calibration);
  const body: ResultRow[] = [
    ...(excluded ? [{ role: 'muted' as const, indent: 2, text: excluded }] : []),
    ...calibration.disagreements.flatMap(item => [
      { role: 'item' as const, indent: 2, text: `№${item.number}  ${oneLine(item.title)}` },
      ...item.expectations.map(row => ({ role: 'quote' as const, indent: 5, text: oneLine(disagreementText(row)) })),
      { role: 'muted' as const, indent: 5, text: item.hint },
      { role: 'muted' as const, indent: 5, text: conversationsText(item) },
    ]),
    ...(calibration.compared ? CALIBRATION_CAVEATS.map(text => ({ role: 'muted' as const, indent: 2, text })) : []),
  ];
  // Nothing beyond the line under the number (a calibration skipped for its budget): no block.
  return body.length ? [{ role: 'heading', indent: 0, text: 'Сверка с продом' }, ...body] : [];
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

/** «Ожидалось · Агент · Правило» of one failure in two compact rows, the way a cause example and the chat say it. */
function exampleRows(example: FailureExplanation, indent: number): ResultRow[] {
  const said = example.said ? `Агент: «${example.said.quote}»` : 'Агент: ответ не подтверждён цитатой';
  const expected = example.expected ? `Ожидалось: ${example.expected}` : 'Ожидалось: не записано в ситуации';
  const rule = example.violated ?? example.rules[0];
  return [
    { role: 'muted', indent, text: oneLine(example.title) },
    { role: 'quote', indent, text: `${expected} · ${said}` },
    ...(rule ? [{ role: 'quote' as const, indent, text: `Правило: «${rule.quote}»` }] : []),
  ];
}

/**
 * «Почему ошибается»: up to three causes with their size, largest first, each with its example when
 * `examples`; without recorded causes, the failed situations by title. When something was decided
 * and nothing failed, the one honest sentence about what that does not prove.
 */
export function causeRows(view: ResultView, options: { examples?: boolean } = {}): ResultRow[] {
  if (!view.failures.length) {
    return view.headline.decided ? [{ role: 'good', indent: 0, text: noErrorsText(view.headline.decided) }] : [];
  }
  const rows: ResultRow[] = [{ role: 'heading', indent: 0, text: 'Почему ошибается' }];
  if (view.topCauses.length) {
    view.topCauses.forEach((cause, i) => {
      rows.push({ role: 'item', indent: 2, text: `${i + 1}  ${oneLine(cause.name)}`, right: countText(cause.count, SITUATIONS), short: String(cause.count) });
      if (options.examples) rows.push(...exampleRows(cause.example, 5));
    });
    return rows;
  }
  view.failures.slice(0, 3).forEach((failure, i) => {
    rows.push({ role: 'item', indent: 2, text: `${i + 1}  ${oneLine(failure.title)}` });
    if (options.examples) rows.push(...exampleRows(failure, 5).slice(1));
  });
  if (view.failures.length > 3) rows.push({ role: 'muted', indent: 2, text: `и ещё ${countText(view.failures.length - 3, ERRORS)}` });
  return rows;
}

/** «Не измерено»: every unmeasured situation with its reason, grouped in the order of the reasons. */
export function unmeasuredRows(view: ResultView): ResultRow[] {
  if (!view.notMeasured.total) return [];
  const titles = new Map(view.cards.map(card => [card.scenarioId, oneLine(card.title)]));
  return [{ role: 'heading', indent: 0, text: 'Не измерено' },
    ...view.notMeasured.reasons.flatMap(reason => reason.scenarioIds.map(id => ({ role: 'item:muted' as const, indent: 2, text: `${titles.get(id) ?? id}: ${reason.label}` })))];
}

/** Every failed situation once, in record order, with what was expected, the agent's words and the rule (E7). */
export function errorListRows(view: ResultView): ResultRow[] {
  if (!view.failures.length) return [];
  return [{ role: 'heading', indent: 0, text: 'Все ошибки' }, ...view.failures.flatMap((failure, i) => {
    const mark = dunnoMark(view, failure.scenarioId);
    return [
      { role: 'failed' as const, indent: 2, text: `✗ ${i + 1}  ${oneLine(failure.title)}` },
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

/** One next step as a row of the «Дальше» list on the board and in the report. */
export function nextStepText(step: NextStep): string {
  switch (step.kind) {
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
    case 'why_unmeasured': return `Посмотреть, почему не измерено ${countText(step.count, SITUATIONS)}`;
    case 'repeat': return 'Повторить прогон на новой версии агента';
    case 'report': return 'Отчёт для заказчика';
  }
}

/** The same step said in the conversation: what to ask for, in the owner's words. */
function chatNextText(step: NextStep): string {
  switch (step.kind) {
    case 'check_connection': return 'Дальше: проверьте связь с агентом — скажите «проверь подключение».';
    case 'wait': return 'Дальше: дождитесь конца прогона — результат придёт сюда.';
    case 'review_judge': return 'Дальше: проверьте, прав ли судья, — скажите «покажи ошибку 1».';
    case 'why_unmeasured': return 'Дальше: спросите, почему ситуации не измерены.';
    case 'repeat': return 'Дальше: исправьте агента и скажите «повтори прогон».';
    case 'report': return 'Дальше: скажите «отчёт для заказчика».';
  }
}

/** The same step on the command line: the command that does it, with the full run id a command needs. */
function cliNextText(step: NextStep, runId: string): string {
  switch (step.kind) {
    case 'check_connection': return 'Проверьте подключение: agent-lab doctor --yes';
    case 'wait': return 'Дождитесь конца прогона';
    case 'review_judge': return 'Проверьте, прав ли судья: откройте прогон в Pi (/agent-lab)';
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
 * owner's disagreements and the calibration against production; the run line and «Дальше» last.
 * Blocks are separated by one blank row, never two.
 */
export function resultScreen(view: ResultView, options: { surface: 'board' | 'cli'; details?: boolean; now?: Date }): ResultRow[] {
  // The board keeps its first screen short; its details and the CLI list every error, the unmeasured situations and the owner's disagreements once.
  const full = options.surface === 'cli' || !!options.details;
  const blocks = [headRows(view), topicRows(view), causeRows(view), ...(full ? [errorListRows(view), unmeasuredRows(view), disagreementRows(view), calibrationRows(view)] : []),
    [runLine(view, options.now), ...barRows(view)], nextRows(view, options.surface)];
  return blocks.filter(rows => rows.length).flatMap((rows, i) => i ? [blank, ...rows] : rows);
}

/**
 * The chat block (docs/design/ui-spec.md §4.10). Collapsed: the number, the trust line, the calibration line and the causes in one row.
 * Expanded: the number, the trust and reality lines, every cause with its example, the unmeasured
 * situations and «Дальше». The host adds the ctrl+o hint under the last row.
 */
export function chatBlock(view: ResultView, options: { expanded: boolean }): ResultRow[] {
  const head = headRows(view).map(row => row.role.startsWith('accuracy') || row.role === 'alarm' ? row : { ...row, indent: 2 });
  if (!options.expanded) {
    const causes = view.topCauses.length
      ? view.topCauses.map(cause => `${oneLine(cause.name)} (${cause.count})`)
      : view.failures.slice(0, 3).map(failure => oneLine(failure.title));
    const more = view.topCauses.length ? view.failures.length - view.topCauses.reduce((n, cause) => n + cause.count, 0) : view.failures.length - 3;
    const causeParts = [...causes, ...(more > 0 ? [`ещё ${countText(more, view.topCauses.length ? CAUSES : ERRORS)}`] : [])];
    const noErrors = causeRows(view).filter(row => row.role === 'good').map(row => ({ ...row, indent: 2 }));
    return [...head.filter(row => row.role !== 'reality'), ...noErrors,
      ...(causeParts.length ? [{ role: 'muted' as const, indent: 2, text: `Чаще всего: ${causeParts.join(' · ')}`, parts: [`Чаще всего: ${causeParts[0]}`, ...causeParts.slice(1)] }] : [])];
  }
  const indent = (rows: ResultRow[]) => rows.map(row => ({ ...row, indent: row.indent + 2 }));
  const blocks = [head, indent(causeRows(view, { examples: true })), indent(unmeasuredRows(view)), indent(nextRows(view, 'chat'))];
  return blocks.filter(rows => rows.length).flatMap((rows, i) => i ? [blank, ...rows] : rows);
}

/** One failure explained on one screen (E7): expected → the agent's words → the owner's rule → the conversation. */
export function failureRows(view: ResultView, record: Pick<Experiment, 'trials'>, index: number): ResultRow[] {
  const failure = view.failures[index];
  if (!failure) return [];
  const label = (name: string, text: string): ResultRow => ({ role: 'item', indent: 4, text: `${name.padEnd(16)}${text}`, hang: 16 });
  const rule = failure.violated ?? failure.rules[0];
  const trial = record.trials.find(item => item.id === failure.trialId);
  const turns = (trial?.events ?? []).filter(event => (event.type === 'user' || event.type === 'assistant') && oneLine(event.text ?? ''));
  const unmarked = view.agreement.unmarked.includes(failure.trialId);
  const mark = dunnoMark(view, failure.scenarioId);
  return [
    { role: 'failed', indent: 0, text: `✗ ${index + 1}  ${oneLine(failure.title)}`, right: `ошибка ${index + 1} из ${view.failures.length}` },
    blank,
    label('Ожидалось', failure.expected ?? 'не записано в ситуации'),
    label('Агент ответил', failure.said ? `«${failure.said.quote}»` : 'ответ не подтверждён цитатой'),
    ...(rule ? [label('Правило', `«${rule.quote}»`), { role: 'muted' as const, indent: 20, text: oneLine(rule.sourceName) }] : [label('Правило', 'у ситуации нет правила из ваших материалов')]),
    ...(mark ? [label('Клиент', mark)] : []),
    ...(turns.length ? [blank, { role: 'heading' as const, indent: 4, text: 'Разговор' },
      ...turns.map(event => ({ role: 'quote' as const, indent: 6, text: `${(event.type === 'user' ? 'Клиент' : 'Агент').padEnd(9)}${oneLine(event.text)}`, hang: 9 }))] : []),
    ...(unmarked ? [blank, { role: 'next:first' as const, indent: 0, text: 'Судья решил: не справился. Вы согласны?' }] : []),
  ];
}

/** Word-wrap in terminal columns (wide characters count double); a word longer than the line is split, so a quote always fits. */
const wrap = (text: string, width: number): string[] => wrapTextWithAnsi(text, Math.max(1, width));
// truncateToWidth closes its ellipsis with style resets for a live terminal; these rows are plain text, painted later by role.
const clipTo = (text: string, width: number) => stripTerminalSequences(truncateToWidth(text, Math.max(1, width), '…'));

/**
 * Plain lines of at most `width` (capped at MAX_WIDTH) terminal columns: a right counter aligned to
 * the edge (its text clipped with «…», the counter never), « · » parts packed per line, everything
 * else word-wrapped under its hanging indent. One layout for the board, the chat and the CLI, so the
 * three never wrap differently; widths are measured in columns, never in string length.
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
    if (row.parts) {
      const lines: string[] = [];
      let current = '';
      for (const [i, part] of row.parts.entries()) {
        const tail = i < row.parts.length - 1 ? ' ·' : '';
        const joined = current ? `${current} · ${part}` : part;
        const limit = lines.length ? room - 2 : room;
        if (visibleWidth(joined + tail) <= limit || !current) { current = joined; continue; }
        lines.push(`${current} ·`);
        current = part;
      }
      lines.push(current);
      return lines.flatMap((line, i) => wrap(line, i ? room - 2 : room).map(piece => ({ role: row.role, text: (i ? `${pad}  ` : pad) + piece })));
    }
    if (!row.text) return [{ role: row.role, text: '' }];
    const hang = row.hang ?? 0;
    const [first = '', ...rest] = wrap(row.text, room);
    const tail = rest.join(' ');
    return [{ role: row.role, text: pad + first }, ...(tail ? wrap(tail, room - hang).map(piece => ({ role: row.role, text: pad + ' '.repeat(hang) + piece })) : [])];
  });
}

/** The rows as plain text: the CLI prints this, and the saved text renders are made with it. */
export const plainText = (rows: ResultRow[], width: number) => fitRows(rows, width).map(line => line.text.trimEnd()).join('\n');
