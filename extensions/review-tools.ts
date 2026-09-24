import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { judgeAgreement } from '../src/agreement.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import type { Experiment, Trial } from '../src/contracts.js';
import { accuracyRow } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import { oneLine, safeText } from '../src/text.js';
import { row, runStamp } from './conversation.ts';
import type { LabHost } from './host.ts';
import { humanAnnotation, recordMark, type Answer } from './judge-review.ts';
import { displayFor, NeedsOwner, requireInteractive } from './lab-ui.ts';
import { summary } from './summary.ts';

/*
 * The owner's review of the judge from the conversation: a verdict on one conversation with the owner's own reason,
 * and the answer «согласен / не согласен / не знаю» about the judge's decision on one situation. The answer always
 * comes from a native dialog; the model only names what is reviewed and can never supply it.
 */

/** A recorded conversation as plain lines for the native viewer: the turns numbered, so a verdict on the whole conversation can cite them. */
function conversationText(record: Experiment, trial: Trial): string {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const turns = trial.events.filter(event => (event.type === 'user' || event.type === 'assistant') && oneLine(event.text ?? ''))
    .map(event => `#${event.seq} ${event.type === 'user' ? 'Клиент' : 'Агент'}: ${oneLine(event.text)}`);
  const judged = (trial.assessments ?? []).map(assessment => `${scenario?.metrics?.find(metric => metric.id === assessment.metricId)?.name ?? 'Оценка'}: ${assessment.result} — ${oneLine(assessment.rationale)}`);
  return [oneLine(scenario?.title ?? ''), '', ...turns, ...(judged.length ? ['', 'Как оценил судья', ...judged] : [])].map(line => safeText(line)).join('\n');
}

export function registerReviewTools(pi: ExtensionAPI, host: LabHost): void {
  const { open, findRun, feedResult, askOwner, recallShown } = host;
  pi.registerTool({
    ...displayFor('agent_lab_review'), name: 'agent_lab_review', label: 'Ask for a human verdict',
    description: 'Show a recorded dialogue and its evidence, then ask the human to choose a verdict and explanation in native Pi UI. Call after discussing a concrete finding. Only id and trialId are accepted: the model cannot supply a human verdict. Cancellation saves no annotation. After a confirmed dev failure, use agent_lab_prompt for a requested fix.',
    parameters: Type.Object({ id: Type.String(), trialId: Type.String() }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, _onUpdate, ctx) {
      const { id, trialId } = z.strictObject({ id: z.string().uuid(), trialId: z.string().min(1) }).parse(params);
      requireInteractive(ctx, 'Вашу оценку разговора ставите вы — в интерактивном терминале Pi.');
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      try {
        await lab.init();
        let record = await lab.get(id);
        if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Нужен завершённый прогон.');
        const trial = record.trials.find(item => item.id === trialId);
        if (!trial) throw new Error('Такого разговора в этом прогоне нет.');
        const started = performance.now();
        // The native multiline viewer scrolls long conversations. Its editable copy is never stored.
        const viewed = await ctx.ui.editor('Прочитайте разговор · Enter — к оценке, Esc — закрыть. Запись не меняется.', conversationText(record, trial)) !== undefined;
        signal.throwIfAborted();
        const reviews = viewed ? await humanAnnotation(ctx, record, trial, performance.now() - started) : undefined;
        signal.throwIfAborted();
        if (!reviews) return feedResult(callId, { id, cancelled: true, message: 'Оценка отменена. Не запрашивайте её снова без просьбы пользователя.' },
          { tone: 'warning', rows: [row('Оценка не поставлена.')] }, 'Ваша оценка');
        for (const review of reviews) record = await lab.addHumanReview(id, review);
        const bundle = await evidenceBundle(record, lab.store);
        const output = { ...summary(record, lab.store.directory, bundle.view), artifacts: await exportArtifacts(bundle, lab.store.directory) };
        return feedResult(callId, output, { rows: [row('Ваша оценка сохранена отдельно от оценки судьи.', 'text', true), row(safeText(accuracyRow(bundle.view).text), 'muted')] }, `Ваша оценка · ${runStamp(record)}`);
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
      requireInteractive(ctx, 'Ответ о решении судьи даёте вы — в интерактивном терминале Pi.');
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const record = await findRun(directory, params.id, ctx);
        if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Ответить о решении судьи можно в завершённом прогоне.');
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
        if (!trial) throw new Error(`У ситуации «${safeText(scenario.title)}» нет записанного разговора.`);
        const verdict = view.cards.find(card => card.scenarioId === scenario.id)?.outcome;
        const options = ['Да, судья прав', 'Нет, судья ошибся', 'Не знаю'];
        const picked = await ctx.ui.select(safeText(`«${scenario.title}» — судья решил: ${verdict === 'fail' ? 'не справился' : 'справился'}. Судья прав?`), options);
        if (!picked) return feedResult(callId, { cancelled: true, mutated: false }, { tone: 'warning', rows: [row('Ответ не записан.')] }, 'Ответ о судье');
        const answer: Answer = picked === options[0] ? 'agree' : picked === options[1] ? 'disagree' : 'unsure';
        const { lab, close } = await open(ctx.cwd);
        try {
          await lab.init();
          const notice = await recordMark(ctx, lab, await lab.get(record.id), trial.id, answer);
          if (!notice) return feedResult(callId, { cancelled: true, mutated: false }, { tone: 'warning', rows: [row('Ответ не записан.')] }, 'Ответ о судье');
          const after = await lab.get(record.id);
          const agreement = judgeAgreement(after);
          const fresh = buildResultView(after);
          return feedResult(callId, { id: record.id, scenarioId: scenario.id, trialId: trial.id, answer, headline: accuracyRow(fresh).text, checkedFailures: agreement.failures.checked, queueFailures: agreement.queueFailures.length },
            { rows: [row(safeText(notice), 'text', true), row(safeText(accuracyRow(fresh).text), 'muted'),
              row(agreement.unmarked.length ? `Ждут вашего ответа: ${agreement.unmarked.length}.` : 'Все решения судьи, которые стоило проверить, проверены.', 'muted')] }, `Ответ о судье · ${runStamp(record)}`);
        } finally { await close(); }
      } catch (error) { return askOwner(callId, error); }
    },
  });
}
