import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { judgeAgreement } from '../src/agreement.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { disagreementText, logRefusal, logTargets } from '../src/card/calibration-view.js';
import { situationNumber } from '../src/card/view.js';
import type { Experiment, Trial } from '../src/contracts.js';
import { isRunning } from '../src/phases.js';
import { detectionLines, detectProject, evidenceText, targetLabel, type ProjectDetection } from '../src/detect.js';
import type { ExperimentLab } from '../src/experiment.js';
import { resultHash } from '../src/lab/record.js';
import { countText } from '../src/plural.js';
import { suiteHoldsLogs, suiteSavedText } from '../src/suite.js';
import { accuracyRow, loggedTurns, logDisagreementRows, logQuestionText, saidText, trialTurns } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import { clip, oneLine, safeText } from '../src/text.js';
import { comparisonFeed, dialogueFeed, failureFeed, feedRows, progressText, row, runStamp, statusFeed } from './conversation.ts';
import { busyFor, chatQueue, writer } from './decisions.ts';
import { agreementTarget, blindCheck, judgeWord, markRefusal, recordLogMark, recordMark, seenVerdicts, type Answer } from './judge-review.ts';
import { displayFor, NeedsOwner, requireInteractive } from './lab-ui.ts';
import { resultOutput } from './model-output.ts';
import type { LabLease, SessionOperations } from './operations.ts';
import { projectPath } from './prepare-tool.ts';
import { recordEntry, recordFor } from './records.ts';
import type { Feed } from './render/feed.ts';
import { rememberView, VERDICT_KIND, type VerdictDetails } from './render/verdict-block.ts';
import { TOOL } from './steps.ts';

/*
 * Reading what exists (docs/design/ui-spec.md §4.10) and the owner's word on the judge: what the project holds and what Lab found in
 * its folder, a run's result, one situation of a run explained, and «судья прав?». The reads never approve, run or
 * spend; the owner's answer about the judge comes only from their native dialog.
 */

export interface ResultHost {
  operations: SessionOperations;
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
}

const closed = { additionalProperties: false } as const;
const runRef = Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'The run id from an earlier Agent Lab result. Omit for the newest run with a result.' }));
const number = Type.Integer({ minimum: 1, maximum: 999, description: 'The situation number, as the result lists its failures.' });
const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const DOCUMENTS: [string, string, string] = ['документ', 'документа', 'документов'];

/** What Lab found in the folder, for the model: how to start the agent, the logs, the rules. */
function foundOutput(found: ProjectDetection) {
  return {
    agents: found.agents.slice(0, 3).map(agent => ({ start: targetLabel(agent.target, found.root), sure: agent.confidence === 'high', why: agent.evidence.map(evidenceText) })),
    logs: found.logs.slice(0, 5).map(log => ({ file: log.file, conversations: log.dialogues, ...(log.table ? { table: true } : {}) })),
    materials: found.materials.slice(0, 5).map(item => ({ folder: item.folder, documents: item.documents })), prompts: found.prompts.slice(0, 20).map(prompt => ({ id: prompt.id, chars: prompt.chars, ...(prompt.system ? { system: true } : {}) })),
  };
}

/** What Lab found, in one row: the agent, the logs, the rules; the whole proposal on expand. */
function foundRows(found: ProjectDetection): { rows: Feed['rows']; more: Feed['rows'] } {
  const agent = found.agents[0], log = found.logs[0], material = found.materials[0];
  const parts = [agent ? `агент — ${targetLabel(agent.target, found.root)}` : 'как запускать агента, не видно',
    log ? `логи — ${log.file} (${countText(log.dialogues, CONVERSATIONS)})` : 'логов нет',
    ...(material ? [`материалы — ${material.folder} (${countText(material.documents, DOCUMENTS)})`] : []), ...(found.prompts.length ? [`промпты — ${found.prompts.length} на выбор`] : [])];
  return { rows: [row(`В папке: ${parts.join(' · ')}`, 'muted')], more: detectionLines(found).map(line => row(line, line && !line.startsWith(' ') ? 'accent' : undefined)) };
}

/** The situation of `record` numbered `number`: a card's own number, the place in the run for older formats. */
function scenarioNumbered(record: Experiment, number: number) {
  const index = record.scenarios.findIndex((scenario, at) => situationNumber(record, scenario.id, at + 1) === number);
  if (index < 0) throw new NeedsOwner('unknown_reference', `Ситуации №${number} в этом прогоне нет. Есть: ${record.scenarios.map((scenario, at) => `${situationNumber(record, scenario.id, at + 1)}. ${oneLine(scenario.title)}`).slice(0, 15).join('; ')}.`,
    record.scenarios.map((scenario, at) => `${situationNumber(record, scenario.id, at + 1)}. ${oneLine(scenario.title)}`).slice(0, 15), `Ситуации №${number} в этом прогоне нет.`);
  return record.scenarios[index]!;
}

/** The conversation of a situation that stands for it: the attempt the judge failed, else its first. */
const attemptOf = (record: Experiment, scenarioId: string, failedTrialId?: string): Trial | undefined => {
  const attempts = record.trials.filter(trial => trial.scenarioId === scenarioId);
  return attempts.find(trial => trial.id === failedTrialId) ?? attempts.find(trial => trial.outcome === 'fail') ?? attempts[0];
};

export function registerResultTools(pi: Pick<ExtensionAPI, 'registerTool'>, host: ResultHost): void {
  pi.registerTool({
    ...displayFor(TOOL.status), name: TOOL.status, label: 'What exists in this project',
    description: 'Read-only and free. The runs of this project, newest first, with their ids; the work going on now; how many decisions wait for the owner; and — before anything is prepared, or while the agent is not connected — what Lab found in the project folder: how to start the agent, log files, rules and the agent\'s prompt. Call it first when you do not know what exists.',
    parameters: Type.Object({}, closed),
    executionMode: 'sequential',
    async execute(callId, _params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      const reader = host.reading(directory);
      const records = await reader.list();
      const active = host.operations.current(directory);
      // What Lab found in the folder matters before anything is prepared, and while the agent is not connected.
      const found = !records.length || records[0]!.target.kind === 'unconnected' ? await detectProject(ctx.cwd).catch(() => undefined) : undefined;
      const decisions = records.length ? (await chatQueue(reader)).decisions.length : 0;
      const feed = statusFeed(records, active);
      if (active) feed.rows.push(row(progressText(await active.lab.get(active.id)), 'accent'));
      if (decisions) feed.rows.push(row(`Нужно ваше решение: ${decisions}`, 'warning'));
      if (found) {
        const shown = foundRows(found);
        if (!records.length) {
          // A found agent or log already answers «какого агента и где логи»: the empty project is not asked for them again.
          if (found.agents.length || found.logs.length) feed.rows = [row('Прогонов пока нет.', 'muted')];
          feed.more = shown.more; feed.expand = 'что Lab нашёл в папке';
        }
        feed.rows.push(...shown.rows);
      }
      return host.feedResult(callId, { runs: records.slice(0, 12).map(record => recordEntry(record)), ...(active ? { working: { run: active.id, kind: active.kind } } : {}),
        decisions, ...(found ? { found: foundOutput(found) } : {}) }, feed, 'Что есть в проекте');
    },
  });
  pi.registerTool({
    ...displayFor(TOOL.results), name: TOOL.results, label: 'The result of a run',
    description: 'Read-only. The result of a run (the newest by default): the accuracy with its trust line and the comparison with production, the causes, every failure by its situation number, what was not measured. compare: this repeat against the run it repeats. report: saves the one-page report for the customer and says where. save: saves the run\'s situations as a suite file (a path such as .evals/regression.json); nothing runs. A suite made from logs holds the customers\' conversations: it stays on the owner\'s machine, out of Git.',
    parameters: Type.Object({ run: runRef, compare: Type.Optional(Type.Literal(true)), report: Type.Optional(Type.Literal(true)),
      save: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'Where to save the suite file.' })) }, closed),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const lab = host.reading(directory);
        const record = recordFor(await lab.list(), params.run, 'results');
        const note = `Результат · ${runStamp(record)}`;
        if (params.save) {
          const file = await lab.saveSuite(record.id, projectPath(params.save, ctx.cwd));
          const shown = file.replace(`${ctx.cwd}/`, '');
          // A suite made from the logs holds the customers' conversations: the owner is told to keep it out of Git, in the
          // same words as `agent-lab save-suite`. Only a suite without them gets the command for CI — in the owner's row alone.
          const logs = suiteHoldsLogs(record);
          const advice = suiteSavedText(record);
          return host.feedResult(callId, { run: record.id, suite: file, holdsLogs: logs, advice,
            instruction: logs ? 'The suite holds conversations from the owner\'s logs. Tell the owner in one sentence, as advice says: keep it out of Git and do not share it.'
              : 'Tell the owner in one sentence that the suite can go into Git and run in their CI after every change of the agent; the command is shown to them.' },
          { ...(logs ? { tone: 'warning' as const } : {}),
            rows: [row(`Набор сохранён: ${safeText(shown)}`, 'text', true), row(advice, logs ? 'warning' : 'muted'),
              ...(logs ? [] : [row(safeText(`В CI: agent-lab evaluate --input ${JSON.stringify(shown)} --yes`), 'muted')])] }, 'Набор сохранён');
        }
        if (!record.trials.length) return host.feedResult(callId, { run: record.id, result: null, instruction: 'This run has no result yet.' },
          { tone: 'warning', rows: [row('У этого прогона ещё нет результата.')] }, note);
        const bundle = await evidenceBundle(record, lab.store);
        if (params.compare) {
          if (!bundle.comparison || !bundle.before) return host.feedResult(callId, { run: record.id, comparable: false, instruction: 'This run repeats no earlier run: nothing to compare with.' },
            { tone: 'warning', rows: [row('Сравнивать не с чем: этот прогон не повторяет прошлый.')] }, note);
          return host.feedResult(callId, { run: record.id, before: bundle.before.id, headline: bundle.comparison.headline, comparable: bundle.comparison.comparable,
            fixed: bundle.comparison.fixed.map(item => item.title), regressed: bundle.comparison.regressed.map(item => item.title), warnings: bundle.warnings },
          comparisonFeed(bundle.comparison, bundle.before, { selected: bundle.comparisonSource?.kind === 'selected' }), `Сравнение · ${runStamp(record)}`);
        }
        if (params.report) {
          const artifacts = await exportArtifacts(bundle, directory);
          return host.feedResult(callId, { run: record.id, report: artifacts.htmlReport, markdown: artifacts.report },
            { rows: [row('Отчёт для заказчика сохранён: одна страница HTML, открывается без интернета.', 'text', true),
              row(safeText(artifacts.htmlReport.replace(`${ctx.cwd}/`, '')), 'muted'), row('Рядом — тот же отчёт в Markdown и снимок доказательств.', 'muted')] }, `Отчёт · ${runStamp(record)}`);
        }
        // The same result block as a finished run's; the session holds ids only (REV-01).
        const resultKey = `${bundle.record.id}:${resultHash(bundle.record)}`;
        rememberView(resultKey, bundle.view);
        const details: VerdictDetails = { kind: VERDICT_KIND, version: 1, runId: bundle.record.id, resultKey };
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...resultOutput(bundle.record, bundle.view), ...(bundle.warnings.length ? { warnings: bundle.warnings } : {}) }, null, 2) }], details };
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor(TOOL.explain), name: TOOL.explain, label: 'One situation of a run explained',
    description: 'Read-only. One situation of a run by its number: what was expected, what the agent said, the owner\'s rule, how the judge decided and the whole conversation; when the synthetic customer and the logged conversation led to different verdicts, both, with where they parted.',
    parameters: Type.Object({ run: runRef, situation: number }, closed),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const lab = host.reading(directory);
        const bundle = await evidenceBundle(recordFor(await lab.list(), params.run, 'results'), lab.store);
        const { record, view } = bundle;
        const scenario = scenarioNumbered(record, params.situation);
        const index = view.failures.findIndex(failure => failure.scenarioId === scenario.id);
        const failure = view.failures[index];
        const differs = view.calibration?.disagreements.find(item => item.cardId === scenario.id);
        // The calibration set one attempt against the logged conversation, whatever the others did: a situation that did not
        // fail is shown by that attempt, a failure by its own — and the compared attempt is then shown beside the log.
        const compared = differs && record.trials.find(item => item.id === differs.trialIds[0]);
        const trial = failure ? attemptOf(record, scenario.id, failure.trialId) : compared ?? attemptOf(record, scenario.id);
        if (!trial) throw new NeedsOwner('unknown_reference', `По ситуации №${params.situation} ещё нет записанного разговора.`, [], `По ситуации ${params.situation} ещё нет записанного разговора.`);
        const feed = failure ? failureFeed(record, view, index)! : dialogueFeed(record, trial);
        const other = compared && compared.id !== trial.id ? compared : undefined;
        if (differs) {
          feed.rows.push(row(`С продом не совпало${differs.attempt === undefined ? '' : ` (попытка ${differs.attempt})`}: ${oneLine(disagreementText(differs.expectations[0]!))}`, 'warning'));
          const batch = await lab.store.readImport(differs.log.importId).catch(() => undefined);
          const logged = batch?.dialogues.find(item => item.id === differs.log.dialogueId);
          feed.more = [...feed.more ?? [], row(''), row('Сверка с продом', 'accent', true),
            ...feedRows(logDisagreementRows(differs, { ...(other ? { attempt: trialTurns(other) } : {}), log: loggedTurns(logged) }), 2)];
        }
        const talk = (attempt: typeof trial) => trialTurns(attempt).slice(0, 40).map(turn => ({ who: turn.who === 'Клиент' ? 'клиент' : 'агент', text: clip(turn.text, 600) }));
        return host.feedResult(callId, { run: record.id, situation: params.situation, title: oneLine(scenario.title), outcome: trial.outcome,
          ...(failure ? { expected: failure.expected, said: saidText(failure), rule: (failure.violated ?? failure.rules[0])?.quote ?? null } : {}),
          conversation: talk(trial), ...(differs ? { production: { expectations: differs.expectations.map(item => disagreementText(item)), hint: differs.hint,
            ...(differs.attempt === undefined ? {} : { attempt: differs.attempt }), ...(other ? { comparedConversation: talk(other) } : {}),
            ...(logTargets(record, scenario.id).length ? { instruction: 'When the owner doubts the judge\'s reading of the logged conversation, offer agent_lab_agree with log: true.' } : {}) } } : {}) },
        feed, `Ситуация ${params.situation} · ${runStamp(record)}`);
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor(TOOL.agree), name: TOOL.agree, label: 'The owner\'s word on the judge',
    description: 'The owner\'s own word on the judge\'s decision about one situation of a finished run: yes, the judge is right / no (with the owner\'s reason) / don\'t know — chosen by the owner in a native dialog; you only name the situation by its number and never supply the answer. It is what makes the accuracy trustworthy: offer it after showing a failure. log: the judge\'s reading of the situation\'s logged conversation (the comparison with production) instead of the run\'s. blind: the judge\'s blind check — omit situation; the owner labels up to 20 of the agent\'s answers in native dialogs WITHOUT seeing the judge\'s verdicts, then sees where the judge differs, false passes first. Offer it before any verdict is discussed, when the result says the judge was not checked blind; never tell the owner the judge\'s verdicts before it.',
    parameters: Type.Object({ run: runRef, situation: Type.Optional(number), log: Type.Optional(Type.Literal(true)), blind: Type.Optional(Type.Literal(true)) }, closed),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        requireInteractive(ctx, 'Ответ о решении судьи даёте вы — в интерактивном терминале Pi.');
        // Work going on in this session holds the writer's lease: said before the question, so the owner's answer is never lost.
        const busy = await busyFor(host.operations, directory);
        if (busy) throw new Error(busy);
        const record = recordFor(await host.reading(directory).list(), params.run, 'results');
        if (isRunning(record.phase)) throw new Error('Прогон ещё идёт: ответить о решении судьи можно, когда он завершится.');
        if (params.blind) {
          const { notice, labelled } = await blindCheck(ctx, writer(host.operations, host.open, ctx.cwd, directory), () => host.reading(directory).get(record.id));
          const fresh = buildResultView(await host.reading(directory).get(record.id));
          return host.feedResult(callId, { run: record.id, blind: true, labelled, notice, falsePasses: fresh.blind?.falsePasses.map(diff => ({ situation: situationNumber(record, diff.scenarioId, 0), expectation: diff.letter })) ?? [],
            falseFails: fresh.blind?.falseFails.map(diff => ({ situation: situationNumber(record, diff.scenarioId, 0), expectation: diff.letter })) ?? [],
            instruction: 'Tell the owner in plain words how the judge compares with their labels. Where it differs, offer to open that situation (agent_lab_explain) and to fix the expectation when the owner found it wrong.' },
          { rows: [row(safeText(notice), 'text', true), row(safeText(accuracyRow(fresh).text), 'muted')] }, `Слепая проверка судьи · ${runStamp(record)}`);
        }
        if (params.situation === undefined) throw new NeedsOwner('unknown_reference', 'Назовите ситуацию по номеру — или проверку судьи вслепую (blind).', [], 'О какой ситуации ответ?');
        const scenario = scenarioNumbered(record, params.situation);
        if (params.log) return await agreeOnLog(callId, ctx, record, scenario, params.situation, directory);
        const view = buildResultView(record);
        const trial = attemptOf(record, scenario.id, view.failures.find(failure => failure.scenarioId === scenario.id)?.trialId);
        if (!trial) throw new NeedsOwner('unknown_reference', `У ситуации №${params.situation} нет записанного разговора.`, [], `У ситуации ${params.situation} нет записанного разговора.`);
        // The owner is asked about the judge's own decision, never a verdict their earlier marks already turned; and only
        // where there is one: a control, an unmeasured situation or an undecided judge is said so before any question.
        const target = agreementTarget(record, trial);
        const refused = markRefusal(target);
        if (refused || target?.kind !== 'ready') return host.feedResult(callId, { run: record.id, marked: false, reason: refused ?? null, instruction: 'Nothing was asked or written. Tell the owner why in one sentence.' },
          { tone: 'warning', rows: [row(refused ?? 'Ответ не записан.')] }, 'Ответ о судье');
        const options = ['Да, судья прав', 'Нет, судья ошибся', 'Не знаю'];
        const picked = await ctx.ui.select(safeText(`«${oneLine(scenario.title)}» — судья решил: ${judgeWord(target.judgeVerdict)}. Судья прав?`), options);
        if (!picked) return host.feedResult(callId, { run: record.id, marked: false }, { tone: 'warning', rows: [row('Ответ не записан.')] }, 'Ответ о судье');
        const answer: Answer = picked === options[0] ? 'agree' : picked === options[1] ? 'disagree' : 'unsure';
        // The judge's decision the owner was shown goes with the answer: a judgment that moved since is refused, never overwritten.
        const notice = await writer(host.operations, host.open, ctx.cwd, directory)(async lab => recordMark(ctx, lab, await lab.get(record.id), trial.id, answer, { seen: target.judgeVerdict }));
        if (!notice) return host.feedResult(callId, { run: record.id, marked: false }, { tone: 'warning', rows: [row('Ответ не записан.')] }, 'Ответ о судье');
        const after = await host.reading(directory).get(record.id);
        const agreement = judgeAgreement(after);
        const fresh = buildResultView(after);
        return host.feedResult(callId, { run: record.id, situation: params.situation, answer, headline: accuracyRow(fresh).text, waiting: agreement.unmarked.length },
          { rows: [row(safeText(notice), 'text', true), row(safeText(accuracyRow(fresh).text), 'muted'),
            row(agreement.unmarked.length ? `Ждут вашего ответа: ${agreement.unmarked.length}.` : 'Все решения судьи, которые стоило проверить, проверены.', 'muted')] }, `Ответ о судье · ${runStamp(record)}`);
      } catch (error) { return host.askOwner(callId, error); }
    },
  });

  /**
   * The owner's word on the judge's reading of a situation's logged conversation (docs/design/card-v2-spec.md §10.3): the
   * verdicts the judge gave there, asked natively; what the owner was shown goes with the answer. The calibration moves,
   * the number never does.
   */
  async function agreeOnLog(callId: string, ctx: ExtensionContext, record: Experiment, scenario: Experiment['scenarios'][number],
    situation: number, directory: string): Promise<AgentToolResult<unknown>> {
    const refused = logRefusal(record, scenario.id);
    if (refused) return host.feedResult(callId, { run: record.id, log: true, marked: false, reason: refused, instruction: 'Nothing was asked or written. Tell the owner why in one sentence.' },
      { tone: 'warning', rows: [row(refused)] }, 'Ответ о судье по логу');
    const targets = logTargets(record, scenario.id);
    const options = ['Да, судья прав', 'Нет, судья ошибся', 'Не знаю'];
    const picked = await ctx.ui.select(safeText(`«${oneLine(scenario.title)}». ${logQuestionText(targets)}`), options);
    if (!picked) return host.feedResult(callId, { run: record.id, log: true, marked: false }, { tone: 'warning', rows: [row('Ответ не записан.')] }, 'Ответ о судье по логу');
    const answer: Answer = picked === options[0] ? 'agree' : picked === options[1] ? 'disagree' : 'unsure';
    const notice = await writer(host.operations, host.open, ctx.cwd, directory)(async lab => recordLogMark(ctx, lab, await lab.get(record.id), scenario.id, answer, { seen: seenVerdicts(targets) }));
    if (!notice) return host.feedResult(callId, { run: record.id, log: true, marked: false }, { tone: 'warning', rows: [row('Ответ не записан.')] }, 'Ответ о судье по логу');
    const calibration = buildResultView(await host.reading(directory).get(record.id)).calibration;
    return host.feedResult(callId, { run: record.id, situation, log: true, answer, calibration: calibration?.text ?? null },
      { rows: [row(safeText(notice), 'text', true), ...(calibration ? [row(safeText(calibration.text), 'muted')] : [])] }, `Ответ о судье по логу · ${runStamp(record)}`);
  }
}
