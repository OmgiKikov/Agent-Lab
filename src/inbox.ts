import type { Experiment } from './contracts.js';
import { convertible, libraryV1Of } from './card/legacy-v1.js';
import type { QuestionChoice } from './card/status.js';
import type { SituationView } from './card/view.js';
import { countText, pluralForm } from './plural.js';
import type { ResultView } from './result-view.js';
import { whenText } from './result-text.js';
import type { NotMeasuredCode } from './run.js';
import { clip, oneLine } from './text.js';

/*
 * «Нужно ваше решение» (docs/design/ui-spec.md §8.3): only what Lab cannot decide itself and what changes what is measured — one
 * plain phrase and two or three actions. The queue is never stored: it is derived from the records each time, so a
 * decision disappears by itself once the record no longer calls for it. What spoils the measurement comes first,
 * then the questions about situations, then spending. Disputed situations never block running the ready ones.
 * Pure: the words are here, every surface only places them.
 */

export type DecisionAction =
  /** The owner's answer to a situation's question: its ready-made command. */
  | { kind: 'answer'; cardId: string; situation: number; choice: QuestionChoice }
  /** Take a situation out of the draft: it is then not run. */
  | { kind: 'remove'; cardId: string; situation: number }
  /** A missing rule is said in words: the request goes to the conversation. */
  | { kind: 'add_rule'; situation: number }
  /** Open one situation, found by its id among those shown; `situations` opens the whole list. */
  | { kind: 'open_situation'; scenarioId: string }
  | { kind: 'open_situations' }
  | { kind: 'open_conversation'; runId: string; trialId: string }
  /** The judge assesses every recorded conversation of the run again, as a new result: the agent does not run. */
  | { kind: 'reassess'; runId: string }
  /** The connection to the agent is checked in the conversation, with the owner's consent there. */
  | { kind: 'check_connection' }
  | { kind: 'raise_limit'; runId: string; to: number }
  | { kind: 'check_situations'; runId: string }
  | { kind: 'resume_preparation'; runId: string }
  /** A draft of the first format goes on as a new draft of cards; the old one stays as it was. */
  | { kind: 'convert_draft'; runId: string }
  /** The owner's word on which agent version wrote an import's logs: a version, or null — «неизвестна». */
  | { kind: 'declare_log_version'; importId: string; version: string | null }
  /** The same word in the owner's own text: the surface asks for it before declaring. */
  | { kind: 'name_log_version'; importId: string };

export interface DecisionChoice {
  label: string; action: DecisionAction;
  /** Whether the choice itself settles the decision; one that only opens the object leaves it in the queue. */
  settles: boolean;
}
export interface Decision {
  /** Stable while the decision stands, so the cursor stays on it across refreshes. */
  key: string;
  /** What it is about: «Ситуация 2 · Возврат оплаты — номер только по просьбе», «Прогон сегодня в 14:05». */
  subject: string;
  text: string;
  choices: DecisionChoice[];
}

export interface InboxInput {
  /**
   * The situations being worked on — a draft, or the newest run's set, whose changes go into a fresh draft — with their
   * status now, and the checks a draft's changes still owe.
   */
  draft?: { record: Experiment; views: readonly SituationView[]; pendingCalls: number };
  /** The newest run with a result. */
  run?: { record: Experiment; view: ResultView };
  /**
   * The imports the newest run took its situations from, and whether the owner has named the agent version behind
   * them since: read from each import's journal by the surface. Without it no decision about the logs is derived.
   */
  logs?: readonly { importId: string; declared: boolean }[];
  now?: Date;
}

/** The key of the decision that answers a situation's question: what the chat names it by. */
export const questionKey = (cardId: string, questionId: string): string => `question:${cardId}:${questionId}`;

const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const subjectOf = (view: SituationView) => `Ситуация ${view.number} · ${clip(view.brief.title, 90)}`;

/** Where a conversation was not measured, grouped by whose side it failed on: each side asks a different decision. */
const SIDE: Partial<Record<NotMeasuredCode, 'agent' | 'client' | 'judge'>> = {
  agent_error: 'agent', service_reply: 'agent', reset_unconfirmed: 'agent',
  simulator_deviated: 'client', simulator_unclear: 'client', simulator_error: 'client', turn_limit: 'client',
  judge_error: 'judge', judge_unavailable: 'judge', judge_stopped: 'judge',
};

/** The unmeasured conversations of the newest run: one decision per side, the most frequent reason named. */
function unmeasured(run: NonNullable<InboxInput['run']>, when: string): Decision[] {
  const { record, view } = run;
  const bySide = new Map<'agent' | 'client' | 'judge', { count: number; label: string; scenarioIds: string[] }>();
  for (const reason of view.notMeasured.reasons) {
    const side = SIDE[reason.code];
    if (!side) continue;
    const known = bySide.get(side);
    // Reasons come largest first, so the first one of a side names it.
    bySide.set(side, known ? { ...known, count: known.count + reason.count, scenarioIds: [...known.scenarioIds, ...reason.scenarioIds] }
      : { count: reason.count, label: reason.label, scenarioIds: [...reason.scenarioIds] });
  }
  return [...bySide].flatMap(([side, item]) => {
    const trial = record.trials.find(candidate => candidate.scenarioId === item.scenarioIds[0]);
    if (!trial) return [];
    const open: DecisionChoice = { label: 'Открыть разговор', action: { kind: 'open_conversation', runId: record.id, trialId: trial.id }, settles: false };
    const count = `${countText(item.count, SITUATIONS)} не ${pluralForm(item.count, ['измерена', 'измерены', 'измерены'])}`;
    if (side === 'agent') return [{ key: `unmeasured:${record.id}:agent`, subject: `Прогон ${when}`, text: `${count}: ${item.label} — проверьте связь с агентом.`,
      choices: [open, { label: 'Проверить связь с агентом', action: { kind: 'check_connection' }, settles: false }] }];
    if (side === 'client') return [{ key: `unmeasured:${record.id}:client`, subject: `Прогон ${when}`,
      text: `${count}: ${item.label} — ${pluralForm(item.count, ['этот разговор', 'эти разговоры', 'эти разговоры'])} не ${pluralForm(item.count, ['годится', 'годятся', 'годятся'])} для оценки.`,
      choices: [open, { label: 'Открыть ситуацию', action: { kind: 'open_situation', scenarioId: item.scenarioIds[0]! }, settles: false }] }];
    return [{ key: `unmeasured:${record.id}:judge`, subject: `Прогон ${when}`, text: `${count}: ${item.label}. Судья может оценить записанные разговоры заново — агент не запускается.`,
      choices: [{ label: 'Переоценить судьёй', action: { kind: 'reassess', runId: record.id }, settles: true }, open] }];
  });
}

/**
 * The logs' agent version (docs/design/card-v2-spec.md §10.2): a run compared its situations with logs whose version nobody named, so the
 * agreement with production is only a comparison. One decision per such import, until the owner names the version —
 * the next calibration reads it; a finished run keeps what it used.
 */
function logVersions(record: Experiment, logs: NonNullable<InboxInput['logs']>, when: string): Decision[] {
  const calibration = record.calibration;
  if (!calibration) return [];
  const tested = calibration.testedVersion?.trim();
  return logs.filter(item => !item.declared && !calibration.logVersions.some(row => row.importId === item.importId)).map(({ importId }): Decision => {
    const choices: DecisionChoice[] = [
      { label: 'Назвать версию', action: { kind: 'name_log_version', importId }, settles: true },
      { label: 'Неизвестна', action: { kind: 'declare_log_version', importId, version: null }, settles: true },
    ];
    // The version the run itself tested is the likeliest answer: the logs of a baseline come from the agent as it runs in production.
    if (tested) choices.unshift({ label: `Та же, что проверяли — ${clip(oneLine(tested), 40)}`, action: { kind: 'declare_log_version', importId, version: tested }, settles: true });
    return { key: `logs:${importId}`, subject: `Сверка с продом · прогон ${when}`,
      text: 'Какая версия агента записала логи? Пока она не названа, совпадение с продом — только сравнение, а не калибровка.', choices };
  });
}

/** Every decision the records call for now, in the order the owner should take them. */
export function decisions(input: InboxInput): Decision[] {
  const now = input.now;
  const measurement: Decision[] = [], questions: Decision[] = [], spending: Decision[] = [];
  const { draft, run } = input;
  if (draft) {
    // A first-format draft that was never accepted can neither change nor run: its one way on is the card format.
    const first = libraryV1Of(draft.record);
    if (first && !first.acceptance && convertible(draft.record)) questions.push({ key: `convert:${draft.record.id}`, subject: 'Ситуации старого формата',
      text: 'Их можно посмотреть, но не изменить и не утвердить для прогона. В новом формате — можно; старый черновик останется как есть.',
      choices: [{ label: 'Продолжить в новом формате', action: { kind: 'convert_draft', runId: draft.record.id }, settles: true },
        { label: 'Открыть ситуации', action: { kind: 'open_situations' }, settles: false }] });
    // A card set's questions stay decisions after a run of its ready situations: the answer goes into a fresh draft.
    const cards = draft.record.librarySnapshot?.formatVersion === 2;
    const editable = cards && draft.record.phase === 'review' && !draft.record.trials.length;
    // A question several situations share (one word on a plausible fact's label) is one decision, named by all of them.
    const sharing = new Map<string, number[]>();
    for (const view of cards ? draft.views : []) if (view.format === 'card' && view.status === 'needs_owner' && view.question?.id) {
      sharing.set(view.question.id, [...sharing.get(view.question.id) ?? [], view.number]);
    }
    const asked = new Set<string>();
    for (const view of cards ? draft.views : []) {
      if (view.format !== 'card') continue;
      if (view.status === 'unusable') measurement.push({ key: `unusable:${view.id}`, subject: subjectOf(view),
        text: oneLine(view.problems[0] ?? 'Ситуация не подходит для теста.'),
        choices: [{ label: 'Добавить правило', action: { kind: 'add_rule', situation: view.number }, settles: false },
          { label: 'Исключить из запуска', action: { kind: 'remove', cardId: view.id, situation: view.number }, settles: true }] });
      else if (view.status === 'needs_owner' && view.question?.id && view.question.choices.length && !asked.has(view.question.id)) {
        asked.add(view.question.id);
        const numbers = sharing.get(view.question.id) ?? [];
        questions.push({ key: questionKey(view.id, view.question.id), subject: numbers.length > 1 ? `Ситуации ${numbers.join(', ')}` : subjectOf(view),
          text: oneLine(view.question.text),
          choices: view.question.choices.slice(0, 3).map(choice => ({ label: choice.label, action: { kind: 'answer', cardId: view.id, situation: view.number, choice }, settles: true })) });
      }
    }
    const checking = editable ? draft.views.filter(view => view.status === 'checking').length : 0;
    const left = Math.max(0, draft.record.settings.maxCalls - draft.record.usage.calls);
    if (checking && draft.pendingCalls > left) spending.push({ key: `budget:${draft.record.id}`, subject: countText(checking, ['Изменённая ситуация', 'Изменённые ситуации', 'Изменённые ситуации']),
      text: `На проверку ${countText(checking, ['ситуации', 'ситуаций', 'ситуаций'])} нужно ${countText(draft.pendingCalls, ['вызов', 'вызова', 'вызовов'])} модели, а в лимите осталось ${left}.`,
      choices: [{ label: `Поднять лимит до ${draft.record.usage.calls + draft.pendingCalls}`, action: { kind: 'raise_limit', runId: draft.record.id, to: draft.record.usage.calls + draft.pendingCalls }, settles: true },
        { label: 'Открыть ситуации', action: { kind: 'open_situations' }, settles: false }] });
    else if (checking) spending.push({ key: `check:${draft.record.id}`, subject: countText(checking, ['Изменённая ситуация', 'Изменённые ситуации', 'Изменённые ситуации']),
      text: `${countText(checking, ['ситуация ещё не проверена', 'ситуации ещё не проверены', 'ситуаций ещё не проверены'])} — без проверки ${pluralForm(checking, ['она не войдёт', 'они не войдут', 'они не войдут'])} в прогон.`,
      choices: [{ label: `Проверить (до ${countText(draft.pendingCalls, ['вызова', 'вызовов', 'вызовов'])} модели)`, action: { kind: 'check_situations', runId: draft.record.id }, settles: true },
        { label: 'Открыть ситуации', action: { kind: 'open_situations' }, settles: false }] });
    const pending = draft.record.preparationProgress?.pending.length ?? 0;
    if (editable && pending && !draft.record.librarySnapshot?.acceptance) spending.push({ key: `resume:${draft.record.id}`, subject: 'Подготовка ситуаций',
      text: `Подготовка остановилась: ${countText(pending, CONVERSATIONS)} из логов ещё не ${pluralForm(pending, ['разобран', 'разобраны', 'разобраны'])}.`,
      choices: [{ label: 'Продолжить подготовку', action: { kind: 'resume_preparation', runId: draft.record.id }, settles: true },
        { label: 'Открыть ситуации', action: { kind: 'open_situations' }, settles: false }] });
  }
  if (run) {
    const when = whenText(run.record.createdAt, now);
    const control = run.view.control;
    if (control.alarm) {
      const card = control.cards.find(item => item.outcome !== 'pass') ?? control.cards[0];
      const trial = card && run.record.trials.find(item => item.scenarioId === card.scenarioId);
      measurement.push({ key: `control:${run.record.id}`, subject: `Прогон ${when}`,
        text: `${control.alarm === 'unmeasured' ? 'Контрольную ситуацию не удалось измерить' : 'Контрольная ситуация не прошла'} — числу пока не верить.`,
        choices: [...(trial ? [{ label: 'Открыть разговор', action: { kind: 'open_conversation' as const, runId: run.record.id, trialId: trial.id }, settles: false }] : []),
          { label: 'Проверить связь с агентом', action: { kind: 'check_connection' }, settles: false }] });
    }
    measurement.push(...unmeasured(run, when));
    questions.push(...logVersions(run.record, input.logs ?? [], when));
  }
  return [...measurement, ...questions, ...spending];
}

/** «3 решения ждут вас» — the answer of the queue's screen. */
export const decisionsLine = (count: number): string => count
  ? `${countText(count, ['решение ждёт', 'решения ждут', 'решений ждут'])} вас. Запуску готовых ситуаций ${pluralForm(count, ['оно не мешает', 'они не мешают', 'они не мешают'])}.`
  : 'Решений не ждёт ничего.';
