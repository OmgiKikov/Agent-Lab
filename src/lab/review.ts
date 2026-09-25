import { randomUUID } from 'node:crypto';
import { calibrateRun } from '../card/calibrate.js';
import { COUNTING_VERSION } from '../card/expectations.js';
import { judgedScenario } from '../card/legacy-v1.js';
import { awaitingVerdict } from '../comparison.js';
import { suiteEvidence } from '../connection.js';
import { addCaveat } from '../caveats.js';
import { addUsage, emptyUsage, fingerprint, humanReviewInputSchema, reassessmentSchema, validatePreparation, type Experiment, type HumanReviewInput, type ReassessmentInput } from '../contracts.js';
import { assessmentRubrics } from '../assessment.js';
import { assessTrial, grade } from '../evaluation.js';
import { judgmentFailure, scenarioSources } from '../judge.js';
import { countingRuleFor, markTargets, measurementUsable } from '../outcomes.js';
import { evaluatorVersion } from '../pi.js';
import { CODE_ONLY_ASSESSMENT } from '../run.js';
import { verifyAcceptedRun } from '../scenario-library.js';
import { simulatorChecks } from '../simulator.js';
import type { Lab } from './context.js';
import { isRunning, moveTo } from '../phases.js';
import { draftBudget, freshDraft, measurementHash, resultHash, retainAcceptedTests } from './record.js';
import { nameFailureModes } from './run.js';

/*
 * The results of a finished run, read again: a re-assessment of the recorded dialogues under new criteria or another
 * judge — a separate result, the original never changes — and a person's verdicts, kept apart from the judge's.
 */

/** A separate result over the same facts. No target session or simulator is opened. */
export function reassess(lab: Lab, id: string, raw: ReassessmentInput = {}, options: { carryUsage?: boolean } = {}): Promise<Experiment> {
  return lab.operations.change(async () => {
    const input = reassessmentSchema.parse(raw);
    const previous = await lab.store.get(id);
    if (previous.workflow !== 'evaluate' || isRunning(previous.phase) || !previous.trials.length) throw new Error('Нужен завершённый прогон с сохранёнными трассами.');
    if (previous.questions.length) throw new Error('Сначала ответьте на открытые вопросы владельца; оценка по неуточнённым требованиям не запускается.');
    if (input.trialIds?.some(id => !previous.trials.some(t => t.id === id))) throw new Error('Неизвестный исходный диалог.');
    const record = freshDraft(previous);
    if (options.carryUsage) record.usage = structuredClone(previous.usage);
    for (const criteria of input.criteria) {
      const scenario = record.scenarios.find(s => s.id === criteria.scenarioId);
      if (!scenario) throw new Error(`Нет карточки ${criteria.scenarioId}`);
      const { scenarioId: _, ...patch } = criteria;
      Object.assign(scenario, patch);
    }
    const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions,
      scenarios: record.scenarios.map(({ split: _, ...s }) => s) }, record.sources);
    record.scenarios = prepared.scenarios;
    verifyAcceptedRun(record);
    retainAcceptedTests(record);
    if (input.judge) { record.settings.judge = input.judge; delete record.settings.roles.judge; }
    record.evaluatorVersion = evaluatorVersion(record.settings);
    record.assessmentOf = previous.id;
    let execution = previous;
    const ancestry = new Set<string>();
    while (execution.assessmentOf && !execution.executionRunId) {
      if (ancestry.has(execution.id)) throw new Error('Цикл переоценок.'); ancestry.add(execution.id);
      execution = await lab.store.get(execution.assessmentOf);
    }
    record.executionRunId = execution.executionRunId ?? execution.id;
    const trials = previous.trials.filter(t => !input.trialIds || input.trialIds.includes(t.id));
    record.assessmentTrialIds = trials.map(t => t.id);
    record.evidenceHash = fingerprint(trials.map(t => ({ id: t.id, events: t.events, initialState: t.initialState, finalState: t.finalState, observation: t.observation })));
    record.sourceEvidence = suiteEvidence(previous, record.scenarios.map(s => s.id));
    record.targetRelease = previous.targetRelease;
    record.reviewedAt = new Date().toISOString(); record.reviewMode = 'automated';
    record.manifestHash = measurementHash(record);
    addCaveat(record, { code: 'reassessment' });
    if (input.codeOnly) addCaveat(record, { code: 'code_only' });
    moveTo(record, 'evaluating');
    await lab.operations.launch(record, async (ctx, operation) => {
      const runtime = input.codeOnly ? undefined : await lab.runtime(record);
      for (const original of trials) {
        ctx.signal.throwIfAborted();
        const trial = structuredClone(original);
        // A re-assessment is a new result: its attempts are counted by today's edition of the rules, the source run by its own.
        trial.countingVersion = COUNTING_VERSION;
        const scenario = record.scenarios.find(s => s.id === trial.scenarioId)!;
        trial.usage = emptyUsage(); delete trial.externalUsage; delete trial.assessments; delete trial.assessmentError; delete trial.assessmentFailure; delete trial.judgeAudit; delete trial.judgeReceipt; delete trial.checkpoints; delete trial.checkpointReceipt;
        trial.manifestHash = record.manifestHash!;
        if (record.target.kind !== 'sandbox' && !trial.observation) trial.observation = { state: 'missing', tools: 'partial' };
        const started = performance.now();
        for (const event of trial.events) lab.store.appendTrace(record.id, trial.id, event);
        if (!['invalid', 'cancelled'].includes(original.outcome)) {
          try {
            trial.checks = [];
            trial.checks = grade(scenario, trial);
            trial.simulatorChecks = simulatorChecks(scenario, trial);
            // Preserve execution failures (empty answer / turn budget), independent of new criteria.
            const executionFailed = original.outcome === 'fail' && original.checks.every(c => c.passed);
            trial.outcome = executionFailed || trial.checks.some(c => !c.passed) ? 'fail' : trial.checks.length ? 'pass' : 'ungraded';
            trial.reason = executionFailed ? original.reason : 'Точные проверки пересчитаны по сохранённым фактам.';
            // The checkpoint verdicts are gone from the copy: a first-format card is judged through its projection.
            const judged = judgedScenario(scenario, trial);
            if (assessmentRubrics(judged, trial).length && runtime) trial.assessments = await assessTrial(runtime, scenario, scenarioSources(record, scenario), trial, { ...ctx,
              beforeCall() { ctx.beforeCall(); trial.usage.calls++; },
              addUsage(usage) { ctx.addUsage(usage); addUsage(trial.usage, usage); } }, record.requirements);
            else if (judged.metrics?.length) { trial.assessmentError = CODE_ONLY_ASSESSMENT; trial.assessmentFailure = 'code_only'; }
          } catch (error) {
            trial.assessmentError = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
            trial.assessmentFailure = judgmentFailure(error, ctx.signal);
            if (!trial.checks.length || ctx.signal.aborted) trial.outcome = ctx.signal.aborted ? 'cancelled' : 'invalid';
            // The saved facts could not be graded again (a reset or a state the agent never confirmed): the agent's side, not the judge's.
            if (trial.outcome === 'invalid') trial.invalidCause = 'agent';
          }
        }
        trial.elapsedMs = Math.round(performance.now() - started);
        record.trials.push(trial);
        await lab.operations.checkpoint(record, 'evaluating', `Переоценено ${record.trials.length}/${trials.length}. Агент не запускался.`);
      }
      if (runtime) await nameFailureModes(record, runtime, ctx);
      if (runtime) await calibrateRun(record, { runtime, ctx, store: lab.store, checkpoint: message => lab.operations.checkpoint(record, record.phase, message), callsLeft: () => operation.callLimit - operation.spent });
      await lab.operations.checkpoint(record, 'results_review', 'Переоценка готова. Исходные трассы, оценки и ручные решения сохранены в исходном прогоне.');
    }, { ownsMutation: true, budget: draftBudget(record) });
    return structuredClone(record);
  });
}

/** A person's verdict on a finished dialogue: kept beside the judge's, never over it. */
export function addHumanReview(lab: Lab, id: string, raw: HumanReviewInput): Promise<Experiment> {
  return lab.operations.change(async () => {
    const record = await lab.store.get(id);
    if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Вердикты человека можно ставить только по завершённым диалогам.');
    const input = humanReviewInputSchema.parse(raw);
    const trial = record.trials.find(t => t.id === input.trialId);
    if (!trial) throw new Error('Такого диалога в этом эксперименте нет.');
    const objectiveCheck = input.checkId && trial.checks.some(c => c.id === input.checkId);
    const simulatorCheck = input.checkId && trial.simulatorChecks?.some(c => c.id === input.checkId);
    if (objectiveCheck && simulatorCheck) throw new Error('ID проверки неоднозначен: он занят объективной проверкой и проверкой симулятора.');
    if (input.checkId && !objectiveCheck && !simulatorCheck) throw new Error('Такой объективной проверки или проверки симулятора в этом диалоге нет.');
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (input.metricId && (!scenario || !assessmentRubrics(judgedScenario(scenario, trial), trial).some(m => m.id === input.metricId))) throw new Error('Такой рубрики в этой карточке нет.');
    // The counting rule is stamped by the lab on quick marks only; a caller value is never kept.
    if (input.source !== 'quick') delete input.countingRules;
    if (input.metricId) {
      const recorded = trial.assessments?.find(a => a.metricId === input.metricId)?.result;
      const judged = trial.judgeReceipt ?? trial.judgeAudit;
      // A one-key mark is an answer to one judgment, so it is refused where the number cannot
      // move (a control, an unmeasured situation), when there is no recorded decision to answer,
      // on a metric that did not decide the situation, and when the judgment moved while the
      // person was looking at it.
      if (input.source === 'quick') {
        if (record.positiveControlScenarioIds?.includes(trial.scenarioId)) throw new Error('Контрольная ситуация — в согласие с судьёй не входит.');
        if (!scenario || !measurementUsable(scenario, trial, record.humanReviews)) throw new Error('Эта ситуация не измерена — отметка согласия не нужна.');
        const targets = markTargets(scenario, trial);
        if (!targets) throw new Error('Судья не вынес решения по этой ситуации — соглашаться не с чем.');
        if (!targets.metricIds.includes(input.metricId)) throw new Error('Отметку согласия можно поставить только на оценку, из-за которой ситуация решена.');
        if (recorded !== 'pass' && recorded !== 'fail') throw new Error('Судья не вынес решения по этой ситуации — соглашаться не с чем.');
        if (input.judgeVerdict !== undefined && input.judgeVerdict !== recorded) throw new Error('Оценка судьи изменилась, пока вы смотрели. Проверьте ситуацию ещё раз.');
        input.countingRules = countingRuleFor(scenario, trial);
      }
      // What the verdict argues with is read from the trial; a caller value is never kept.
      if (recorded) input.judgeVerdict = recorded; else delete input.judgeVerdict;
      if (judged) input.judge = { protocolHash: judged.protocolHash, inputHash: judged.inputHash }; else delete input.judge;
    }
    (record.humanReviews ??= []).push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
    delete record.resultsReviewedAt; delete record.resultsReviewHash;
    await lab.operations.checkpoint(record, 'results_review', 'Ваше решение записано отдельно от оценки судьи.');
    return structuredClone(record);
  });
}

/** A person's confirmation that every failed dialogue of a finished run has a decision. */
export function reviewResults(lab: Lab, id: string, expectedHash: string): Promise<Experiment> {
  return lab.operations.change(async () => {
    const record = await lab.store.get(id);
    if (record.workflow !== 'evaluate' || record.phase !== 'results_review') throw new Error('Нет завершённого набора диалогов, ожидающего аудита.');
    if (resultHash(record) !== expectedHash) throw new Error('Результаты изменились. Откройте их заново, прежде чем подтверждать аудит.');
    const pending = awaitingVerdict(record).size;
    if (pending) throw new Error(`Нельзя завершить разбор: ${pending} диалогов без решения. Оцените проваленные критерии или весь диалог. Если ошибочен сам тест, отметьте весь диалог «Невалидный тест» с причиной; «неясно» оставляет вопрос открытым.`);
    record.resultsReviewedAt = new Date().toISOString(); record.resultsReviewHash = expectedHash;
    await lab.operations.checkpoint(record, 'complete', 'Разбор результатов завершён. Проверки, оценки судьи и ваши решения хранятся отдельно.');
    return structuredClone(record);
  });
}
