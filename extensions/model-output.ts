import type { Experiment } from '../src/contracts.js';
import { evidenceBundle } from '../src/artifacts.js';
import { countsText, formatNote, situationData, situationEntry, situationNumber, type SituationView } from '../src/card/view.js';
import { questionKey, type Decision } from '../src/inbox.js';
import type { ExperimentLab } from '../src/experiment.js';
import { resultHash } from '../src/lab/record.js';
import { MAX_WIDTH, nextRows, plainText, resultScreen } from '../src/result-text.js';
import type { ResultView } from '../src/result-view.js';
import { rememberView, VERDICT_KIND, type VerdictDetails } from './render/verdict-block.ts';

/*
 * What the chat's model reads — the tool content, never drawn for the owner. It is short and typed: the ids and
 * numbers the next call names, the counts, and the lines the owner can read on the board when the model has to
 * talk about them. Records, views, settings and hashes stay in the store; the owner sees the feed rows.
 */

/** What the model reads instead of the result block, so it does not restate the number and the causes. */
export const SHOWN_TO_OWNER = 'Блок с точностью и причинами уже показан владельцу. Не копируйте его строки. Назовите точность одной фразой и объясните по-человечески, где и почему агент хромает: что просили клиенты, что агент сделал вместо этого, какое правило владельца это нарушает; что он делает хорошо и насколько числу можно верить. Затем предложите следующий шаг.';

/** A situation in a list: its number, title, status, and — when it waits for the owner — its question and the decision that answers it. */
export function situationItem(view: SituationView) {
  const entry = situationEntry(view);
  return view.question?.id && view.question.choices.length ? { ...entry, decision: questionKey(view.id, view.question.id) } : entry;
}

/** The situations of a record for the model: the run id the next call names, the counts, each situation in a line or two. */
export function situationsOutput(record: Experiment, views: readonly SituationView[], extra: Record<string, unknown> = {}) {
  const note = formatNote(record);
  return { run: record.id, counts: countsText(views), ...(note ? { note } : {}), situations: views.map(situationItem), ...extra };
}

/** One situation whole: the brief with the ids a change names (f1, e1), its question and its decision. */
export function situationOutput(record: Experiment, view: SituationView, extra: Record<string, unknown> = {}) {
  return { run: record.id, situation: { ...situationData(view), ...(view.question?.id && view.question.choices.length ? { decision: questionKey(view.id, view.question.id) } : {}) }, ...extra };
}

/** The decisions that wait for the owner, as the model names them in agent_lab_decide. */
export const decisionsOutput = (decisions: readonly Decision[]) => decisions.map(decision => ({
  key: decision.key, about: decision.subject, text: decision.text,
  answers: decision.choices.filter(choice => choice.settles).map((choice, index) => ({ number: index + 1, label: choice.label })),
}));

/** A run's result for the model: the screen the owner can open on the board, each failure by its situation number, the next step. */
export function resultOutput(record: Experiment, view: ResultView) {
  const position = (scenarioId: string) => record.scenarios.findIndex(scenario => scenario.id === scenarioId) + 1;
  return {
    run: record.id,
    lines: plainText(resultScreen(view, { surface: 'board', details: true }), MAX_WIDTH).split('\n'),
    failures: view.failures.map(failure => ({ situation: situationNumber(record, failure.scenarioId, position(failure.scenarioId)), title: failure.title })),
    ...(view.notMeasured.total ? { notMeasured: view.notMeasured.total } : {}),
    next: nextRows(view, 'chat')[0]?.text ?? null,
    shownToOwner: SHOWN_TO_OWNER,
  };
}

/**
 * The result of a finished run for the chat: the model's content and the details its block is drawn from. The session
 * keeps ids only (REV-01): the view itself is remembered in memory under the result's key.
 */
export async function verdictOutput(record: Experiment, lab: ExperimentLab): Promise<{ output: ReturnType<typeof resultOutput>; details: VerdictDetails }> {
  const { view } = await evidenceBundle(record, lab.store);
  const resultKey = `${record.id}:${resultHash(record)}`;
  rememberView(resultKey, view);
  return { output: resultOutput(record, view), details: { kind: VERDICT_KIND, version: 1, runId: record.id, resultKey } };
}
