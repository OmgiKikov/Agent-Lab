import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Experiment, Trial } from '../src/contracts.js';
import { agreementSample, awaitingVerdict, judgeAgreement } from '../src/agreement.js';
import type { ExperimentLab } from '../src/experiment.js';
import { resultHash } from '../src/lab/record.js';
import { markTargets, measurementUsable } from '../src/outcomes.js';
import { cardVerdict, headlineCardOutcome } from '../src/run.js';
import { headlineRule } from '../src/card/expectations.js';
import { clip, oneLine, safeLine } from '../src/text.js';

/*
 * «Проверить, прав ли судья» (docs/design/ui-spec.md §4.8): the owner's own word on the judge's decision about one situation — the
 * failures the judge recorded first, then a few passes drawn for a double-check. A mark exists only because the owner
 * picked an answer in the workspace or in a native dialog, and a disagreement only with the owner's own reason; no
 * tool and no model ever writes one. Shared by the workspace and the chat.
 */

/** What an answer would land on for one conversation. */
export type AgreementTarget =
  /** A positive control: not part of the agreement count. */
  | { kind: 'control' }
  /** Not measured (the customer left the situation, the judge failed…): nothing to agree with. */
  | { kind: 'unmeasured' }
  /** The judge said nothing decisive about the main question. */
  | { kind: 'undecided' }
  /** `metricIds`: the judgments an answer lands on, goal first; `sampled`: a pass drawn for a double-check. */
  | { kind: 'ready'; metricIds: string[]; judgeVerdict: 'pass' | 'fail'; sampled: boolean };

/** The judge's decision an answer about `trial` would land on; read from the recorded judgments only, never from a verdict the owner already changed. */
export function agreementTarget(record: Experiment, trial: Trial | undefined): AgreementTarget | undefined {
  if (!trial || record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) return undefined;
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  if (scenario && (record.positiveControlScenarioIds ?? []).includes(scenario.id)) return { kind: 'control' };
  if (!scenario || !measurementUsable(scenario, trial, record.humanReviews)) return { kind: 'unmeasured' };
  const targets = markTargets(scenario, trial);
  if (!targets) return { kind: 'undecided' };
  return { kind: 'ready', metricIds: targets.metricIds, judgeVerdict: targets.verdict, sampled: agreementSample(record).includes(trial.id) };
}

/** Why no answer about the judge can land on `target`, in the owner's words; undefined when one can. */
export function markRefusal(target: AgreementTarget | undefined): string | undefined {
  if (target?.kind === 'ready') return undefined;
  return target?.kind === 'control' ? 'Контрольная ситуация — в согласие с судьёй не входит.'
    : target?.kind === 'unmeasured' ? 'Ситуация не измерена — соглашаться не с чем.' : 'Судья не вынес решения по этой ситуации — соглашаться не с чем.';
}

/** The judge's own decision in the owner's words: what they are asked to agree with. */
export const judgeWord = (verdict: 'pass' | 'fail'): string => verdict === 'fail' ? 'не справился' : 'справился';

export type Answer = 'agree' | 'disagree' | 'unsure';
const WORD: Record<Answer, string> = { agree: 'согласен с судьёй', disagree: 'не согласен с судьёй', unsure: 'не знаю' };

/**
 * What the owner can dispute on a situation decided by several judgments — each alone, or all of them —, in the words
 * of the situation: its duties by letter on a card, the request and the prompt's rules on an older generated card.
 */
function disputable(scenario: Experiment['scenarios'][number] | undefined, trial: Trial, ids: string[], failed: boolean): { label: string; ids: string[] }[] {
  const rule = headlineRule(scenario, [trial]);
  if (rule.kind === 'expectations') {
    const duty = (id: string) => rule.expectations.find(item => item.id === id);
    return [...ids.map(id => ({ label: `${duty(id)?.letter ?? id} — ${clip(duty(id)?.text ?? '', 80)}: ${failed ? 'агент это сделал' : 'агент этого не сделал'}`, ids: [id] })),
      { label: failed ? 'Со всеми: агент сделал всё это' : 'Со всеми: агент не сделал ничего из этого', ids }];
  }
  const labels = failed ? ['Запрос выполнен — судья ошибся', 'Правила промпта соблюдены — судья ошибся', 'С обоими: запрос выполнен и правила соблюдены']
    : ['Запрос не выполнен — судья ошибся', 'Правила промпта нарушены — судья ошибся', 'С обоими: запрос не выполнен и правила нарушены'];
  return [{ label: labels[0]!, ids: [ids[0]!] }, { label: labels[1]!, ids: [ids[1]!] }, { label: labels[2]!, ids }];
}

/** Said once the last answer of the queue is given: the review has ended by itself. */
export const REVIEW_DONE = 'Все ответы даны — проверка судьи завершена.';

/**
 * «Проверить, прав ли судья» ends by itself (docs/design/ui-spec.md §5): once every conversation of the queue carries a decided answer
 * and nothing else waits for the owner, the review is recorded as done — bound to the results as they are now. A doubt
 * («не знаю») keeps it open. True when this call ended it.
 */
async function finishReview(lab: ExperimentLab, id: string): Promise<boolean> {
  const record = await lab.get(id);
  const agreement = judgeAgreement(record);
  if (record.phase !== 'results_review' || agreement.unmarked.length || agreement.unsure || awaitingVerdict(record).size) return false;
  await lab.reviewResults(record.id, resultHash(record));
  return true;
}

/**
 * Records the owner's answer about one conversation and says what changed, or undefined when the owner stepped back.
 * «Не согласен» asks, on a situation decided by two judgments, which of them the owner disputes, and always asks for
 * the owner's reason in a native editor: only a disagreement moves the number, so only it needs words. The same answer
 * given again writes nothing. `seen`: the judge's decision the owner was shown; the lab refuses the answer when the
 * recorded one differs by now.
 */
export async function recordMark(ctx: Pick<ExtensionContext, 'ui'>, lab: ExperimentLab, record: Experiment, trialId: string, answer: Answer,
  options: { readingMs?: number; seen?: 'pass' | 'fail' } = {}): Promise<string | undefined> {
  const started = performance.now();
  const trial = record.trials.find(item => item.id === trialId);
  const target = agreementTarget(record, trial);
  if (!trial || target?.kind !== 'ready') throw new Error(markRefusal(target));
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const title = oneLine(scenario?.title ?? '');
  const current = judgeAgreement(record).marks.find(mark => mark.trialId === trialId && !mark.stale);
  const failed = target.judgeVerdict === 'fail';
  let disputed = target.metricIds;
  let note: string;
  if (answer === 'disagree') {
    if (target.metricIds.length > 1) {
      const parts = disputable(scenario, trial, target.metricIds, failed);
      // A duty's words come from the record: every answer crosses the terminal boundary, and the pick is matched as shown.
      const labels = parts.map(part => safeLine(part.label));
      const picked = await ctx.ui.select('С чем вы не согласны?', labels);
      const part = parts[labels.indexOf(picked ?? '')];
      if (!part) return undefined;
      disputed = part.ids;
    }
    const reason = await ctx.ui.editor(`Судья решил: ${judgeWord(target.judgeVerdict)}. Почему вы не согласны? Коротко, своими словами.`, current?.answer === 'disagree' ? current.note : '');
    if (reason === undefined) return undefined;
    // Input validation, not display: a stored reason is capped at 3000 characters, so the owner is told to shorten it instead of losing the text.
    if (!reason.trim()) return 'Несогласие не сохранено: напишите причину.';
    if (reason.length > 3000) return 'Причина длиннее 3000 знаков — сократите и ответьте снова.';
    const same = current?.answer === 'disagree' ? current.targets.filter(item => item.answer === 'disagree').map(item => item.metricId).join(' ') : undefined;
    if (current && same === disputed.join(' ') && reason.trim() === current.note.trim()) return 'Отметка уже стоит: не согласен.';
    note = reason;
  } else {
    if (current && current.targets.every(item => item.answer === answer)) return `Отметка уже стоит: ${WORD[answer]}.`;
    note = answer === 'agree' ? 'Быстрая отметка: согласен с судьёй.' : 'Быстрая отметка: не могу сказать.';
  }
  const durationMs = Math.min(3600000, Math.round((options.readingMs ?? 0) + performance.now() - started));
  for (const [index, metricId] of target.metricIds.entries()) {
    // Disputing one half of a double decision means agreeing with the other half.
    const disputes = answer === 'disagree' && disputed.includes(metricId);
    const verdict = answer === 'unsure' ? 'unknown' as const : disputes ? (failed ? 'pass' as const : 'fail' as const) : target.judgeVerdict;
    // The lab stamps the counting rule and the judge snapshot itself; the request never names them.
    await lab.addHumanReview(record.id, { trialId, metricId, source: 'quick', verdict, judgeVerdict: options.seen ?? target.judgeVerdict,
      note: answer === 'disagree' && !disputes ? 'Быстрая отметка: согласен с судьёй.' : note, ...(index === 0 ? { durationMs } : {}) });
  }
  const after = await lab.get(record.id);
  const notice = markNotice(record, after, scenario, answer, title);
  return await finishReview(lab, record.id) ? `${notice} ${REVIEW_DONE}` : notice;
}

/** What an answer changed, in one phrase: «Итог пересчитан» only when the situation's verdict moved; otherwise what still fails. */
function markNotice(record: Experiment, after: Experiment, scenario: Experiment['scenarios'][number] | undefined, answer: Answer, title: string): string {
  if (answer !== 'disagree' || !scenario) return `Отмечено: ${WORD[answer]} · «${title}».`;
  const was = cardVerdict(record, scenario).outcome, now = cardVerdict(after, scenario).outcome;
  if (now !== was) return `Отмечено: не согласен · «${title}». Итог пересчитан с учётом вашего ответа.`;
  if (now !== 'fail') return `Отмечено: не согласен · «${title}». Итог не изменился.`;
  const parts = headlineCardOutcome(after, scenario);
  const still = parts.goal === 'fail' && parts.rules === 'fail' ? 'запрос не выполнен, нарушены правила промпта' : parts.goal === 'fail' ? 'запрос не выполнен'
    : parts.rules === 'fail' ? 'нарушены правила промпта' : 'другие ожидания не выполнены';
  return `Отмечено: не согласен · «${title}». Ситуация остаётся «не справился»: ${still}.`;
}
