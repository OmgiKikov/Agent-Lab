import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { isRunning, type Experiment } from '../src/contracts.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { resultHash } from '../src/experiment.js';
import { identifierPattern } from '../src/ids.js';
import { plannedTrials } from '../src/run.js';
import { situationEntry } from '../src/card/view.js';
import { safeText } from '../src/text.js';
import { comparisonFeed, dialogueFeed, failureFeed, progressText, row, runStamp, runWhen, statusFeed } from './conversation.ts';
import type { LabHost } from './host.ts';
import { displayFor, NeedsOwner } from './lab-ui.ts';
import { rememberView, VERDICT_KIND, type VerdictDetails } from './render/verdict-block.ts';
import { situationsFeed, situationsNow } from './card-tools.ts';
import { summary } from './summary.ts';

/*
 * Reading what exists (ui-spec §4.10): the runs of the project, a run's result, one failure, any recorded
 * conversation, a repeat against its source run, the report for the customer. Read-only: nothing here approves
 * a draft, marks the judge or runs the agent.
 */

export function registerResultTools(pi: ExtensionAPI, host: LabHost): void {
  const { operations, reading, findRun, focus, feedResult, askOwner, rememberShown, recallShown } = host;
  pi.registerTool({
    ...displayFor('agent_lab_inspect'),
    name: 'agent_lab_inspect', label: 'Read results and evidence',
    description: 'Read-only. Without options: the result of a run (or its draft) with the failure list. failure: one failed situation by its number in that list or by title — expectation, what the agent said, the owner rule and the dialogue. dialogue: any recorded dialogue by situation title or number; trialId: by exact id. compare:true compares a repeat with its source run (or compare:"<run>" with another run). export:true writes local HTML and Markdown reports and an AgentSpec snapshot. This tool never approves a draft or result. Legacy comparison control traces remain hidden until the control phase stops.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the run this conversation works on.' })),
      failure: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1, maxLength: 300 })], { description: 'Number in the failure list (1 = first) or the situation title.' })),
      dialogue: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'Situation title or number whose recorded dialogue to open.' })),
      trialId: Type.Optional(Type.String({ pattern: identifierPattern })),
      compare: Type.Optional(Type.Union([Type.Boolean(), Type.String({ minLength: 1, maxLength: 200 })])),
      export: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const lab = reading(directory);
        const record = await findRun(directory, params.id, ctx);
        focus.set(directory, record.id);
        const before = typeof params.compare === 'string' ? await findRun(directory, params.compare, ctx) : undefined;
        const bundle = await evidenceBundle(record, lab.store, before?.id);
        const controlVisible = record.workflow === 'evaluate' || !!record.controlConsumedAt && !isRunning(record.phase);
        const visible = (trial: Experiment['trials'][number] | undefined) => {
          if (trial?.split === 'control' && !controlVisible) throw new Error('Control evidence stays hidden until the final control phase stops.');
          return trial;
        };
        const note = `Результат · ${runStamp(record)}`;
        if (params.failure !== undefined) {
          const view = bundle.view;
          const titles = view.failures.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
          if (!view.failures.length) return feedResult(callId, { failures: 0, notMeasured: view.notMeasured.total, message: 'No failed situation in the headline of this run.' },
            { rows: [row('В этом прогоне агент не ошибся ни в одной ситуации.', 'text', true), ...(view.notMeasured.total ? [row(`Не измерено ситуаций: ${view.notMeasured.total}.`, 'muted')] : [])] }, note);
          const wanted = String(params.failure).trim();
          // A number names the row of the failure list the owner last saw; when the list has changed since, the same situation is opened.
          const remembered = recallShown(ctx, 'failures', record.id) ?? view.failures.map(item => item.scenarioId);
          rememberShown('failures', record.id, remembered);
          const numbered = /^#?\d+$/.test(wanted) ? remembered[Number(wanted.replace('#', '')) - 1] : undefined;
          const byNumber = /^#?\d+$/.test(wanted) ? view.failures.filter(item => item.scenarioId === numbered) : undefined;
          const matches = byNumber ?? view.failures.filter(item => item.title.toLocaleLowerCase('ru').includes(wanted.toLocaleLowerCase('ru')));
          if (matches.length !== 1) throw new NeedsOwner(matches.length ? 'ambiguous_reference' : 'unknown_reference',
            matches.length ? `Ошибка «${wanted}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Ошибки «${wanted}» в списке нет: всего ошибок ${view.failures.length}.`, titles);
          const index = view.failures.indexOf(matches[0]!);
          const trial = visible(bundle.record.trials.find(item => item.id === matches[0]!.trialId));
          return feedResult(callId, { failure: { number: index + 1, of: view.failures.length, title: matches[0]!.title, kind: matches[0]!.kind, lines: matches[0]!.lines }, trial },
            failureFeed(bundle.record, view, index)!, `Ошибка ${index + 1} · ${runStamp(record)}`);
        }
        if (params.dialogue || params.trialId) {
          let trial = params.trialId ? bundle.record.trials.find(item => item.id === params.trialId) : undefined;
          if (params.trialId && !trial) throw new Error('Такого разговора в этом прогоне нет.');
          if (!trial) {
            const wanted = params.dialogue!.trim().toLocaleLowerCase('ru');
            const scenarios = /^#?\d+$/.test(wanted) ? [bundle.record.scenarios[Number(wanted.replace('#', '')) - 1]].filter(item => !!item)
              : bundle.record.scenarios.filter(item => item.title.toLocaleLowerCase('ru').includes(wanted) || item.id === params.dialogue);
            const titles = bundle.record.scenarios.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
            if (scenarios.length !== 1) throw new NeedsOwner(scenarios.length ? 'ambiguous_reference' : 'unknown_reference',
              scenarios.length ? `«${params.dialogue}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Ситуации «${params.dialogue}» в этом прогоне нет.`, titles.slice(0, 15));
            const attempts = bundle.record.trials.filter(item => item.scenarioId === scenarios[0]!.id);
            trial = attempts.find(item => item.outcome === 'fail') ?? attempts[0];
            if (!trial) throw new Error(`По ситуации «${safeText(scenarios[0]!.title)}» ещё нет записанного разговора.`);
          }
          return feedResult(callId, visible(trial), dialogueFeed(bundle.record, trial), `Разговор · ${runStamp(record)}`);
        }
        if (params.compare) {
          if (!bundle.comparison || !bundle.comparisonSource || !bundle.before) return feedResult(callId, { comparable: false, warnings: bundle.warnings, message: 'This run has no source run to compare with. Prepare a repeat of an earlier run, or name the run to compare with.' },
            { tone: 'warning', rows: [row('Сравнивать не с чем: у этого прогона нет исходного. Назовите прогон для сравнения или подготовьте повтор прошлого.')] }, note);
          return feedResult(callId, { comparison: bundle.comparison, comparisonSource: bundle.comparisonSource, warnings: bundle.warnings }, comparisonFeed(bundle.comparison, bundle.before),
            `Сравнение · ${runStamp(record)}`);
        }
        const artifacts = params.export ? await exportArtifacts(bundle, lab.store.directory) : undefined;
        const output = {
          ...summary(record, lab.store.directory, bundle.view), agent: record.revisions.find(r => r.id === record.selectedRevisionId)?.spec,
          settings: record.settings, requirements: record.requirements, profiles: record.profiles,
          scenarios: record.scenarios.filter(s => s.split === 'dev' || controlVisible), revisions: record.revisions, iterations: record.iterations,
          trials: record.trials.filter(t => t.split === 'dev' || controlVisible).map(t => ({ id: t.id, revisionId: t.revisionId, scenarioId: t.scenarioId, split: t.split, outcome: t.outcome, reason: t.reason })),
          ...(bundle.comparison ? { comparison: bundle.comparison, comparisonSource: bundle.comparisonSource } : {}),
          warnings: bundle.warnings,
          ...(artifacts ? { artifacts } : {}),
        };
        // The report for the customer is a file: the row says where it is, in words the owner can pass on.
        if (artifacts) return feedResult(callId, output, { rows: [row('Отчёт для заказчика сохранён: одна страница HTML, открывается без интернета.', 'text', true),
          row(safeText(artifacts.htmlReport.replace(`${ctx.cwd}/`, '')), 'muted'), row('Рядом — тот же отчёт в Markdown и снимок доказательств.', 'muted')] }, `Отчёт · ${runStamp(record)}`);
        // A run with conversations opens with the same result block as a finished run; a draft shows its situations.
        if (record.trials.length) {
          const resultKey = `${record.id}:${resultHash(record)}`;
          rememberView(resultKey, bundle.view);
          const details: VerdictDetails = { kind: VERDICT_KIND, version: 1, runId: record.id, resultKey };
          return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details };
        }
        const { views, topics } = await situationsNow(lab, record);
        return feedResult(callId, { ...output, situations: views.map(situationEntry) }, situationsFeed(record, views, false, topics), `Ситуации · ${runStamp(record)}`);
      } catch (error) { return askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_status'),
    name: 'agent_lab_status', label: 'What exists in this project',
    description: 'Read-only. Lists the runs of this project (draft, running, finished), the run this session works on and any run in progress. Call it first when you do not know what exists. Costs nothing and asks nothing.',
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, _params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      const records = (await reading(directory).list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const active = operations.current(directory);
      rememberShown('runs', directory, records.map(record => record.id));
      const feed = statusFeed(records, active);
      if (active) feed.rows.push(row(progressText(await active.lab.get(active.id)), 'accent'));
      const output = { runs: records.slice(0, 40).map(record => ({ id: record.id, when: runWhen(record), task: record.task, phase: record.phase, updatedAt: record.updatedAt,
        situations: record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : record.librarySnapshot?.formatVersion === 1 ? record.librarySnapshot.variants.length : record.scenarios.length,
        accepted: !!record.librarySnapshot?.acceptance, agentConnected: record.target.kind !== 'unconnected',
        trials: record.trials.length, plannedTrials: plannedTrials(record), parentRunId: record.parentRunId })),
        workingOn: focus.get(directory) ?? null, runningInThisSession: active?.id ?? null,
        activeOperation: active ? { id: active.operationId, runId: active.id, kind: active.kind } : null };
      return feedResult(callId, output, feed, 'Что есть в проекте');
    },
  });
}
