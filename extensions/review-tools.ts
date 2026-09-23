import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { judgeAgreement } from '../src/agreement.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import type { Experiment } from '../src/contracts.js';
import { markTargets } from '../src/outcomes.js';
import { accuracyRow } from '../src/result-text.js';
import { buildResultView, type ResultView } from '../src/result-view.js';
import { safeText, shortId } from '../src/text.js';
import { humanAnnotation } from './board-command.ts';
import { reviewOrder, trialLines } from './cards.ts';
import { row, type Feed } from './conversation.ts';
import { displayFor, NeedsOwner, requireInteractive } from './lab-ui.ts';
import type { LabLease } from './operations.ts';

/*
 * The owner's review of the judge from the conversation: a verdict on one dialogue with the owner's own reason,
 * and the quick mark «согласен / не согласен / не могу сказать» on the judge's decision about one situation.
 * The answer always comes from a native dialog; the model only names what is reviewed and can never supply it.
 */

export interface ReviewHost {
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  findRun: (directory: string, ref?: string, ctx?: { sessionManager?: { getEntries?: () => unknown[] } }) => Promise<Experiment>;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
  summary: (record: Experiment, directory: string, view?: ResultView) => object;
  /** The failure list as the owner last saw it, so «первый провал» means the row they saw. */
  recallShown: (ctx: { sessionManager?: { getEntries?: () => unknown[] } } | undefined, kind: 'runs' | 'failures', key: string) => string[] | undefined;
}

export function registerReviewTools(pi: ExtensionAPI, host: ReviewHost): void {
  const { open, findRun, feedResult, askOwner, summary, recallShown } = host;
  pi.registerTool({
    ...displayFor('agent_lab_review'), name: 'agent_lab_review', label: 'Ask for a human verdict',
    description: 'Show a recorded dialogue and its evidence, then ask the human to choose a verdict and explanation in native Pi UI. Call after discussing a concrete finding. Only id and trialId are accepted: the model cannot supply a human verdict. Cancellation saves no annotation. After a confirmed dev failure, use agent_lab_prompt for a requested fix.',
    parameters: Type.Object({ id: Type.String(), trialId: Type.String() }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, _onUpdate, ctx) {
      const { id, trialId } = z.strictObject({ id: z.string().uuid(), trialId: z.string().min(1) }).parse(params);
      requireInteractive(ctx, 'Вердикт человека требует интерактивного терминала.');
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      try {
        await lab.init();
        let record = await lab.get(id);
        if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Нужен завершённый прогон.');
        const selected = reviewOrder(record).findIndex(t => t.id === trialId);
        const trial = reviewOrder(record)[selected];
        if (!trial) throw new Error('Такого диалога в этом эксперименте нет.');
        const started = performance.now();
        // The native multiline viewer scrolls long traces. Its editable copy is never persisted.
        const viewed = await ctx.ui.editor('Прочитайте диалог · Enter — к оценке, Esc — закрыть. Исходная запись сохранится.',
          trialLines(trial, record, true).map(line => safeText(line.text)).join('\n')) !== undefined;
        signal.throwIfAborted();
        const reviews = viewed ? await humanAnnotation(ctx, record, selected, performance.now() - started) : undefined;
        signal.throwIfAborted();
        if (!reviews) return { content: [{ type: 'text', text: JSON.stringify({ id, cancelled: true, message: 'Оценка отменена. Не запрашивайте её снова без просьбы пользователя.' }) }], details: { cancelled: true } };
        for (const review of reviews) record = await lab.addHumanReview(id, review);
        const bundle = await evidenceBundle(record, lab.store);
        const output = { ...summary(record, lab.store.directory, bundle.view), artifacts: await exportArtifacts(bundle, lab.store.directory) };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_agree'), name: 'agent_lab_agree', label: 'Owner marks the judge\'s decision',
    description: 'The owner\'s own mark on the judge\'s decision about one situation of a finished run: согласен, не согласен (with their reason) or не могу сказать. The answer is chosen by the owner in a native Pi dialog; you pass only which situation (failure: its number in the failure list, or dialogue: its title or number) and can never supply the answer. This is what tells how far the accuracy number can be trusted.',
    parameters: Type.Object({ id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), failure: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1, maxLength: 300 })])),
      dialogue: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      requireInteractive(ctx, 'Отметку о решении судьи ставит только владелец в интерактивном терминале.');
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const record = await findRun(directory, params.id, ctx);
        if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Отметить согласие с судьёй можно в завершённом прогоне.');
        const view = buildResultView(record);
        const titles = record.scenarios.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
        const wanted = String(params.failure ?? params.dialogue ?? '').trim();
        if (!wanted) throw new NeedsOwner('needs_owner_input', 'Не сказано, о какой ситуации речь. Спросите владельца.', titles.slice(0, 15));
        const remembered = recallShown(ctx, 'failures', record.id) ?? view.failures.map(item => item.scenarioId);
        const scenarioId = params.failure !== undefined && /^#?\d+$/.test(wanted) ? remembered[Number(wanted.replace('#', '')) - 1]
          : /^#?\d+$/.test(wanted) ? record.scenarios[Number(wanted.replace('#', '')) - 1]?.id
          : record.scenarios.filter(item => item.title.toLocaleLowerCase('ru').includes(wanted.toLocaleLowerCase('ru'))).map(item => item.id).find((_, index, all) => all.length === 1);
        const scenario = record.scenarios.find(item => item.id === scenarioId);
        if (!scenario) throw new NeedsOwner('unknown_reference', `Ситуация «${wanted}» не найдена однозначно. Спросите владельца, какая нужна.`, titles.slice(0, 15));
        const attempts = record.trials.filter(item => item.scenarioId === scenario.id);
        const trial = attempts.find(item => item.id === view.failures.find(failure => failure.scenarioId === scenario.id)?.trialId) ?? attempts[0];
        const targets = trial ? markTargets(scenario, trial) : undefined;
        if (!trial || !targets) throw new Error(`У ситуации «${safeText(scenario.title)}» нет решения судьи, с которым можно согласиться или поспорить.`);
        const failed = targets.verdict === 'fail';
        const started = performance.now();
        const options = ['Согласен с судьёй', 'Не согласен с судьёй', 'Не могу сказать'];
        const picked = await ctx.ui.select(safeText(`«${scenario.title}» — судья решил: ${failed ? 'не справился' : 'справился'}. Ваше мнение?`), options);
        if (!picked) return feedResult(callId, { cancelled: true, mutated: false }, { rows: [row('Отметка не поставлена.', 'muted')] }, 'Отметка не поставлена');
        const answer = picked === options[0] ? 'agree' as const : picked === options[1] ? 'disagree' as const : 'unsure' as const;
        let note = answer === 'agree' ? 'Быстрая отметка: согласен с судьёй.' : 'Быстрая отметка: не могу сказать.';
        if (answer === 'disagree') {
          const reason = await ctx.ui.editor(`Судья решил: ${failed ? 'не справился' : 'справился'}. Почему вы не согласны? Коротко, своими словами.`, '');
          if (!reason?.trim()) return feedResult(callId, { cancelled: true, mutated: false }, { rows: [row('Несогласие не сохранено: нужна ваша причина.', 'warning')] }, 'Отметка не поставлена');
          note = reason.trim().slice(0, 3000);
        }
        const { lab, close } = await open(ctx.cwd);
        try {
          await lab.init();
          const verdict = answer === 'unsure' ? 'unknown' as const : answer === 'disagree' ? (failed ? 'pass' as const : 'fail' as const) : targets.verdict;
          const durationMs = Math.min(3600000, Math.round(performance.now() - started));
          for (const [index, metricId] of targets.metricIds.entries()) await lab.addHumanReview(record.id, { trialId: trial.id, metricId, source: 'quick', verdict, judgeVerdict: targets.verdict, note, ...(index === 0 ? { durationMs } : {}) });
          const after = await lab.get(record.id);
          const agreement = judgeAgreement(after);
          const fresh = buildResultView(after);
          const word = answer === 'agree' ? 'согласен с судьёй' : answer === 'disagree' ? 'не согласен с судьёй' : 'не могу сказать';
          const feed: Feed = { rows: [row(`Отмечено вашим решением: ${word} · «${safeText(scenario.title)}»`, 'success', true),
            row(agreement.queueFailures.length ? `Проверено провалов: ${agreement.failures.checked} из ${agreement.queueFailures.length}.` : `Проверено успехов: ${agreement.sampleChecked} из ${agreement.sampledPasses.length}.`, undefined, false, 1),
            row(safeText(accuracyRow(fresh).text), answer === 'disagree' ? 'accent' : 'muted', false, 1)] };
          return feedResult(callId, { id: record.id, scenarioId: scenario.id, trialId: trial.id, answer, headline: accuracyRow(fresh).text, checkedFailures: agreement.failures.checked, queueFailures: agreement.queueFailures.length }, feed,
            `Отметка владельца · прогон ${shortId(record.id)}`);
        } finally { await close(); }
      } catch (error) { return askOwner(callId, error); }
    },
  });
}
