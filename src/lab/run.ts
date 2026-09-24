import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { calibrateRun } from '../card/calibrate.js';
import { portableTarget, rememberConnection, resolveTarget, suiteEvidence, type Connection } from '../connection.js';
import { SANDBOX_RETIRED, draftPatchSchema, experimentSchema, fingerprint, isRunnable, runnableTarget, scriptIssue, settingsSchema, unconfirmedReferences, validateFailureModes, validatePreparation, type DraftPatch, type Experiment, type Revision, type Scenario, type UserMode } from '../contracts.js';
import type { CallContext, Runtime } from '../runtime.js';
import { evaluateTrial } from '../evaluation.js';
import { scenarioSources } from '../judge.js';
import { evaluatorVersion } from '../pi.js';
import { deriveRun, plannedTrials } from '../run.js';
import { verifyAcceptedRun } from '../scenario-library.js';
import { SUITE_FORMAT, carriedImports, suiteText } from '../suite.js';
import { preflightTarget, readPrompt, runRelease } from '../targets.js';
import { sameTargetVersion, targetFingerprint } from '../target-version.js';
import type { Lab } from './context.js';
import { isRunning, moveTo } from '../phases.js';
import { draftHash, freshDraft, measurementHash, retainAcceptedTests, revision } from './record.js';

/*
 * A run: the draft it starts from — its settings and connection, a repeat of an accepted set, a set saved to or
 * loaded from a file — the owner's confirmation that freezes what is measured, and the dialogues themselves:
 *
 *   start ─► release hook ─► every user mode × situation × repeat (a pool of `parallel`) ─► failure causes ─► calibration
 *
 * The measurement manifest is checked before and after every dialogue, the agent's code fingerprint too: a suite or
 * an agent that drifts mid-run stops the run instead of being graded.
 */

/** Dialogues a run may hold open against the target at once. */
const MAX_PARALLEL = 16;

/** Run settings, the connection, its version and the agent label; the situations themselves change only through the library. */
export function updateDraft(lab: Lab, id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> {
  return lab.operations.change(async () => {
    const record = await lab.store.get(id);
    if (record.phase !== 'review') throw new Error('Править можно только незапущенный черновик. Готовые доказательства остаются как есть, для изменений создайте новый эксперимент.');
    if (draftHash(record) !== expectedHash) throw new Error('Черновик изменился. Откройте карточки заново, прежде чем править.');
    const patch = draftPatchSchema.parse(raw);
    if (record.librarySnapshot?.acceptance) verifyAcceptedRun(record);
    record.settings = settingsSchema.parse({ ...record.settings, ...patch.settings,
      roles: Object.fromEntries(Object.entries({ ...record.settings.roles, ...patch.settings?.roles }).filter(([, value]) => value !== null)) });
    if (patch.target) record.target = patch.target;
    if (patch.targetVersion) record.targetVersion = patch.targetVersion;
    if (patch.agent) { record.revisions = [revision(patch.agent, null, 'Конфигурация агента обновлена владельцем.')]; record.selectedRevisionId = record.revisions[0]!.id; }
    await preflightTarget(record.target); record.targetFingerprint = await targetFingerprint(record.target);
    record.evaluatorVersion = evaluatorVersion(record.settings);
    delete record.acceptedDraftHash;
    record.reviewedAt = null; record.reviewMode = null; record.manifestHash = null;
    await lab.operations.checkpoint(record, 'review', `${patch.agent ? 'Агент обновлён. ' : ''}Настройки прогона обновлены. Подтвердите новую версию перед запуском.`);
    return structuredClone(record);
  });
}

/** Confirms the expectations of a draft made before libraries: one confirmation covers every situation of it. */
export function acceptDraft(lab: Lab, id: string, expectedHash: string): Promise<Experiment> {
  return lab.operations.change(async () => {
    const record = await lab.store.get(id);
    verifyAcceptedRun(record);
    if (record.workflow !== 'evaluate') throw new Error('Принять тест можно только в workflow evaluate.');
    if (record.phase !== 'review') throw new Error('Принять можно только незапущенный черновик.');
    if (!record.scenarios.length) throw new Error('Подтверждать нечего: в черновике нет ситуаций.');
    const pendingReferences = unconfirmedReferences(record.scenarios);
    if (pendingReferences.length) throw new Error(`Подтвердите или удалите эталоны, предложенные моделью: ${pendingReferences.join(', ')}.`);
    const currentHash = draftHash(record);
    if (expectedHash !== currentHash) throw new Error('Черновик изменился, пока вы смотрели. Проверьте ожидания ещё раз.');
    // One confirmation covers every situation of the draft; an entry whose definition did not change keeps its identity and date.
    const previous = new Map((record.acceptedTests ?? []).map(test => [test.scenarioId, test]));
    const acceptedAt = new Date().toISOString();
    const accepted = record.scenarios.map(scenario => {
      const definitionHash = fingerprint(scenario);
      const kept = previous.get(scenario.id);
      return kept?.definitionHash === definitionHash ? kept : { testId: randomUUID(), scenarioId: scenario.id, definitionHash, acceptedAt };
    });
    if (record.acceptedDraftHash === currentHash && previous.size === accepted.length
      && accepted.every(test => previous.get(test.scenarioId) === test)) return structuredClone(record);
    record.acceptedTests = accepted;
    record.acceptedDraftHash = currentHash;
    await lab.store.save(record);
    return structuredClone(record);
  });
}

/** Reuse the exact reviewed materials and cards; only evidence and approvals start afresh. */
export function repeat(lab: Lab, id: string, scenarioIds?: string[], controlScenarioIds?: string[]): Promise<Experiment> {
  return lab.operations.change(async () => {
    const previous = await lab.store.get(id);
    if (previous.workflow !== 'evaluate' || !previous.reviewedAt || isRunning(previous.phase)) {
      throw new Error('Повторить можно остановленный или завершённый прогон с утверждёнными карточками.');
    }
    if (previous.target.kind === 'sandbox') throw new Error(SANDBOX_RETIRED);
    const record = freshDraft(previous, scenarioIds);
    if (controlScenarioIds) {
      if (!controlScenarioIds.length || controlScenarioIds.length > 5 || new Set(controlScenarioIds).size !== controlScenarioIds.length) {
        throw new Error('Контрольных ситуаций может быть от 1 до 5, без повторов.');
      }
      const missing = controlScenarioIds.find(controlId => !record.scenarios.some(s => s.id === controlId));
      if (missing !== undefined) throw new Error(`Контрольная ситуация должна быть из этого набора: ${missing}.`);
      record.positiveControlScenarioIds = [...controlScenarioIds];
    }
    // A control keeps its accepted card: the one-turn rule is applied when it runs (evaluateTrial).
    record.targetFingerprint = await targetFingerprint(record.target);
    verifyAcceptedRun(record);
    await lab.store.save(record);
    return structuredClone(record);
  });
}

/** A versionable local definition: provenance survives, run results and approvals do not; a card library's logs travel with it (suite.ts). */
export async function saveSuite(lab: Lab, id: string, file: string, scenarioIds?: string[]): Promise<string> {
  const previous = await lab.get(id);
  if (previous.workflow !== 'evaluate' || !previous.scenarios.length || isRunning(previous.phase)) throw new Error('Сначала дождитесь готовых тестов.');
  const definition = freshDraft(previous, scenarioIds);
  verifyAcceptedRun(definition);
  if (previous.trials.length) definition.sourceEvidence = suiteEvidence(previous, definition.scenarios.map(s => s.id));
  const path = resolve(file);
  const text = await suiteText(lab.store, definition, portableTarget(definition.target, dirname(path)));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  return path;
}

/** A saved set as a fresh draft of this store: checked before anything is written, its logs kept next to every other import. */
export function loadSuite(lab: Lab, file: string, scenarioIds?: string[], connection?: Connection): Promise<Experiment> {
  return lab.operations.change(async () => {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (raw.format !== SUITE_FORMAT) throw new Error('Нужен файл тестов Agent Lab, сохранённый через save-suite.');
    const previous = experimentSchema.parse({ ...raw.definition, target: connection?.target ?? resolveTarget(raw.definition.target, dirname(resolve(file))),
      ...(connection?.targetVersion ? { targetVersion: connection.targetVersion } : {}) });
    if (previous.workflow !== 'evaluate') throw new Error('Файл должен содержать обычные тесты evaluate.');
    // Checked before anything is written: a damaged suite leaves the store as it was.
    const imports = carriedImports(raw, previous);
    const record = freshDraft(previous, scenarioIds);
    // Keep the original run as the comparison source, not the exported draft's temporary ID.
    record.parentRunId = previous.parentRunId;
    runnableTarget(record.target);
    const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions,
      scenarios: record.scenarios.map(({ split: _split, ...s }) => s) }, record.sources);
    record.scenarios = prepared.scenarios;
    retainAcceptedTests(record);
    await preflightTarget(record.target);
    record.targetFingerprint = await targetFingerprint(record.target);
    verifyAcceptedRun(record);
    // The logs its situations cite join this store's imports; one already here with the same content stays as it is.
    for (const batch of imports) await lab.store.writeImport(batch);
    await lab.store.save(record);
    return structuredClone(record);
  });
}

/** The owner's confirmation of a run. `parallel` is an execution knob, not a measurement setting: dialogues are independent, so several may run at once without changing what is measured. */
export interface StartOptions { approved: boolean; reviewer?: 'human' | 'expectations' | 'automated'; expectedHash?: string; parallel?: number; requireAccepted?: boolean }

/** Freezes what is measured — the draft the owner confirmed — and runs its dialogues in the background. */
export async function start(lab: Lab, id: string, options: StartOptions): Promise<Experiment> {
  const parallel = options.parallel ?? 1;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) throw new Error(`Параллельных диалогов может быть от 1 до ${MAX_PARALLEL}.`);
  return lab.operations.change(async () => {
    const record = await lab.store.get(id);
    verifyAcceptedRun(record);
    if (record.phase !== 'review') throw new Error('Запустить можно только эксперимент, ожидающий проверки. Чтобы поменять набор карточек, создайте новый.');
    if (record.workflow !== 'evaluate') throw new Error('Сравнение с автоматическим улучшением агента больше не запускается: такой прогон можно только открыть. Для новой проверки подготовьте библиотеку сценариев.');
    runnableTarget(record.target);
    if (!options.approved) throw new Error('Набор карточек замораживается только после вашего подтверждения.');
    const pendingReferences = unconfirmedReferences(record.scenarios);
    if (pendingReferences.length) throw new Error(`Подтвердите или удалите эталоны, предложенные моделью: ${pendingReferences.join(', ')}.`);
    if (options.expectedHash !== draftHash(record)) {
      throw new Error('Нужно подтверждение именно этой версии черновика. Откройте свежие тесты и план запуска.');
    }
    // The Pi path asks for confirmed expectations; CLI `run` and `evaluate` keep today's behaviour (CTX-22).
    if (options.requireAccepted && record.acceptedDraftHash !== draftHash(record)) {
      throw new Error('Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены.');
    }
    // Grounding's open questions gate a first-format draft, whose rules were read once for the whole set. Cards are
    // reviewed one by one and each doubt becomes that card's own owner question, so an accepted card set runs; the
    // questions stay on the record for the owner.
    if (record.questions.length && record.librarySnapshot?.formatVersion !== 2) throw new Error('Сначала ответьте на бизнес-вопросы из черновика: добавьте ответы в материалы и подготовьте новый эксперимент.');
    // A control delivers only its opening, so its script never has to fit.
    if (record.settings.userModes.includes('scripted')) for (const scenario of record.scenarios.filter(s => !record.positiveControlScenarioIds?.includes(s.id))) {
      const issue = scriptIssue(scenario.user, record.settings.maxTurns);
      if (issue) throw new Error(`${scenario.title}: ${issue}`);
    }
    await preflightTarget(record.target);
    if (record.evaluatorVersion && record.evaluatorVersion !== evaluatorVersion(record.settings)) throw new Error('Версия оценщика изменилась. Обновите черновик и проверьте условия запуска.');
    if (record.targetFingerprint && !sameTargetVersion(record.targetFingerprint, await targetFingerprint(record.target))) {
      throw new Error('Код агента изменился после подготовки карточек. Обновите подключение в настройках и подтвердите новую версию.');
    }
    record.reviewedAt = new Date().toISOString();
    record.reviewMode = options.reviewer ?? 'human';
    if (record.reviewMode === 'automated') record.limitations.push('Ожидания ситуаций проверены автоматически, без человека: спорные вердикты стоит посмотреть, однозначные годятся как предварительный результат.');
    // The owner confirmed the expectations, and nothing else. The verdicts are produced after this
    // point, so no confirmation here can mean a person checked them: say so instead of going quiet.
    if (record.reviewMode === 'expectations') record.limitations.push('Владелец подтвердил ожидания ситуаций перед запуском. Определения карточек и оценки судьи человеком не проверялись.');
    record.manifestHash = measurementHash(record);
    moveTo(record, 'evaluating');
    record.message = 'Выполняю согласованный план проверки.';
    await lab.operations.launch(record, ctx => evaluateReviewed(lab, record, ctx, parallel), { ownsMutation: true });
    return structuredClone(record);
  });
}

async function evaluateReviewed(lab: Lab, record: Experiment, ctx: CallContext, parallel: number): Promise<void> {
  const runtime = await lab.runtime(record);
  const agent = record.revisions[0];
  if (!agent || !record.manifestHash) throw new Error('Missing reviewed agent or measurement manifest.');
  await release(lab, record, ctx);
  await runSuite(lab, record, runtime, agent, ctx, parallel);
  frozenGuard(record, record.manifestHash, ctx)();
  await nameFailureModes(record, runtime, ctx);
  if (record.trials.some(t => !['invalid', 'cancelled'].includes(t.outcome))) {
    await rememberConnection(lab.store.directory, { format: 'agent-lab-connection-1', target: runnableTarget(record.target), targetVersion: record.targetVersion });
  }
  // The synthetic result is complete; the same situations are now judged on their recorded conversations.
  await calibrateRun(record, { runtime, ctx, store: lab.store, checkpoint: message => lab.operations.checkpoint(record, record.phase, message) });
  await lab.operations.checkpoint(record, 'results_review', 'Диалоги и оценки готовы. Разберите провалы и проверьте поведение симулятора, прежде чем принимать результат.');
}

/** Re-checks the frozen manifest before and after every trial; a drifted suite stops the run instead of grading it. */
function frozenGuard(record: Experiment, hash: string, ctx: CallContext): () => void {
  return () => {
    ctx.signal.throwIfAborted();
    if (measurementHash(record) !== hash) throw new Error('The approved evaluation conditions changed. Create a fresh reviewed run.');
  };
}

/** The rollout of the version under test. The adapter's reported `version` remains the identity; this only performs the deployment. */
async function release(lab: Lab, record: Experiment, ctx: CallContext): Promise<void> {
  const target = runnableTarget(record.target);
  if (!target.release) return;
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_LAB_RUN_ID: record.id,
    ...(record.targetVersion ? { AGENT_LAB_TARGET_VERSION: record.targetVersion } : {}),
    ...(target.promptFile ? { AGENT_LAB_PROMPT_FILE: target.promptFile, AGENT_LAB_PROMPT_HASH: fingerprint(await readPrompt(target.promptFile)) } : {}) };
  await lab.operations.checkpoint(record, record.phase, 'Разворачиваю проверяемую версию агента (хук выпуска).');
  record.releaseLog = await runRelease(target.release, env, ctx.signal);
  ctx.signal.throwIfAborted();
  if (record.releaseLog.exitCode !== 0) throw new Error(`Хук выпуска завершился с кодом ${record.releaseLog.exitCode ?? record.releaseLog.signal ?? 'unknown'}: ${record.releaseLog.stderr.trim().slice(-500) || 'без вывода'}`);
}

/** The single trial loop: every user mode, every scenario, every repeat, one checkpoint per trial. */
async function runSuite(lab: Lab, record: Experiment, runtime: Runtime, agent: Revision, ctx: CallContext, parallel: number): Promise<void> {
  const hash = record.manifestHash;
  if (!hash) throw new Error('Missing measurement manifest.');
  const guard = frozenGuard(record, hash, ctx);
  const scenarios = record.scenarios;
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  const planned = plannedTrials({ ...record, scenarios });
  // Every attempt in the order it would run one at a time; a pool of `parallel` workers takes them from the front,
  // so a finished dialogue is recorded as soon as it ends and the trial order is the completion order.
  const firstTrial = record.trials.length;
  const attempts: Array<{ userMode: UserMode; scenario: Scenario; repeat: number }> = [];
  for (const userMode of record.settings.userModes) {
    const skipped: string[] = [];
    for (const scenario of scenarios) {
      if (userMode === 'scripted' && scenario.user.script === undefined) { skipped.push(scenario.id); continue; }
      for (let repeat = 0; repeat < record.settings.repeats; repeat++) attempts.push({ userMode, scenario, repeat });
    }
    if (skipped.length) {
      const note = `Scripted mode skipped ${skipped.length} card(s) without a script: ${skipped.join(', ')}.`;
      if (!record.limitations.includes(note)) record.limitations.push(note);
    }
  }
  const fingerprintCheck = async (message: string) => {
    if (record.targetFingerprint && !sameTargetVersion(record.targetFingerprint, await targetFingerprint(record.target))) throw new Error(message);
  };
  let completed = 0, next = 0, rerun = 0;
  let failed = false;
  const worker = async () => {
    while (next < attempts.length && !failed) {
      const { userMode, scenario, repeat } = attempts[next++]!;
      const prefix = record.settings.userModes.length > 1 ? `[${userMode}] ` : '';
      const running = () => parallel > 1 ? ` · параллельно ${Math.min(parallel, attempts.length - completed)}` : '';
      guard();
      await fingerprintCheck('Код внешнего агента изменился во время прогона. Создайте повтор с новой версией.');
      const progress = () => `${prefix}${scenario.title} · диалог ${completed + 1}/${planned}${running()}`;
      lab.operations.say(record, `${progress()} · открываем сессию`);
      const dialogue = () => evaluateTrial({ runtime, revision: agent, scenario, repeat, manifestHash: hash, sources: record.sources, judgeSources: scenarioSources(record, scenario), requirements: record.requirements, settings: record.settings,
        control: controls.has(scenario.id), onStage: stage => lab.operations.say(record, `${progress()} · ${{ target: 'ответ агента', user: 'реплика пользователя', assessment: 'оценка критериев' }[stage]}`),
        ctx: { ...ctx, onTrace: (trialId, event) => {
          ctx.onTrace?.(trialId, event);
          const stage = event.type === 'user' ? 'ждём ответ агента' : event.type === 'assistant' ? 'ответ получен · готовим следующий шаг'
            : event.type === 'simulator' ? 'реплика симулятора готова' : event.type === 'tool_call' ? `инструмент ${event.tool ?? ''}`
            : event.type === 'tool_result' ? 'инструмент завершён' : event.type === 'retrieval' ? 'RAG-контекст получен' : 'сбой диалога';
          lab.operations.say(record, `${progress()} · ${stage}`);
        } }, userMode, target: record.target });
      let trial = await dialogue();
      // A stand that failed once (a 500, a dropped connection) says nothing about the agent: the conversation is run
      // again, once, from the start. The failed one stays in the trace journal and the record names how many were
      // rerun; an empty reply is the agent's own answer and is never rerun.
      if (standFailed(trial) && !ctx.signal.aborted) {
        lab.operations.say(record, `${progress()} · сбой стенда, повторяю разговор`);
        trial = await dialogue();
        rerun++;
      }
      record.trials.push(trial);
      if (scenario.initialState.external && trial.observation?.resetConfirmed !== true) {
        const note = 'Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.';
        if (!record.limitations.includes(note)) record.limitations.push(note);
      }
      if (trial.observation?.version) {
        if (record.targetRelease && record.targetRelease !== trial.observation.version) throw new Error('Внешний агент сообщил разные версии в одном прогоне. Сравнение недоступно.');
        record.targetRelease = trial.observation.version;
      }
      completed++;
      await lab.operations.checkpoint(record, record.phase, `${prefix}${scenario.title} · ${repeat + 1}/${record.settings.repeats}`);
      await fingerprintCheck('Код внешнего агента изменился во время диалога. Результат сохранён, но сравнение недоступно.');
      guard();
    }
  };
  // One failure stops the pool: the other workers finish the dialogue they are in and take no more; the first error is the run's error.
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(parallel, attempts.length)) }, () => worker().catch(error => { failed = true; throw error; })));
  // Dialogues finish in any order when run together; the record keeps them in card order so reports and reviews read the same every time.
  const cardOrder = new Map(attempts.map((attempt, index) => [`${attempt.scenario.id}|${attempt.userMode}|${attempt.repeat}`, index]));
  const position = (trial: Experiment['trials'][number]) => cardOrder.get(`${trial.scenarioId}|${trial.userMode}|${trial.repeat}`) ?? attempts.length;
  record.trials.push(...record.trials.splice(firstTrial).sort((a, b) => position(a) - position(b)));
  if (rerun) record.limitations.push(`Разговоров, повторённых после сбоя стенда: ${rerun}.`);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
}

/** The stand, not the agent, broke the conversation: the adapter or the agent's service threw (an `error` event), not an empty reply. */
export function standFailed(trial: Experiment['trials'][number]): boolean {
  return trial.outcome === 'invalid' && (trial.invalidCause === 'agent' || trial.invalidCause === 'measurement') && trial.events.some(event => event.type === 'error');
}

/**
 * Naming the failure precisely is what turns an evaluation into an improvement loop, so the
 * failed dialogues of a finished run are clustered and named — a single failure gets a name
 * too, because one named failure is already a fix to try. When the prompt of the agent is
 * known (the prompt among the owner's materials, the connection's promptFile, or a stored sandbox run's built-in
 * instructions when it is re-assessed), the cluster may quote the fragment that
 * governed the broken behaviour; quotes are checked verbatim. A failed clustering must not
 * lose a completed run: it is recorded as a limitation instead.
 */
export async function nameFailureModes(record: Experiment, runtime: Runtime, ctx: CallContext): Promise<void> {
  // Exactly the attempts the number calls failures: a cause must explain the headline, not a rubric it does not count.
  // Clustering runs just before the run turns to results_review, and a strict legacy card is decided only on a finished
  // run, so the failures are read from the record as it is about to be saved.
  const failed = deriveRun({ ...record, phase: 'results_review' }).failedAttempts;
  if (!runtime.failureModes || !failed.length) return;
  const failures = failed.map(trial => ({
    trialId: trial.id,
    card: record.scenarios.find(s => s.id === trial.scenarioId)?.title ?? trial.scenarioId,
    reason: trial.reason,
    failed: [
      ...trial.checks.filter(c => !c.passed).map(c => c.description),
      ...(trial.assessments ?? []).filter(a => a.result === 'fail').map(a => a.rationale),
    ],
    trace: trial.events.filter(e => e.type !== 'simulator')
      .map(e => `#${e.seq} ${e.type}${e.tool ? ` ${e.tool}` : ''}: ${e.text ?? JSON.stringify(e.result ?? e.args ?? '')}`).join('\n').slice(0, 12000),
  }));
  try {
    const suppliedPrompt = record.sources.filter(source => source.kind === 'prompt').map(source => source.content).join('\n\n') || undefined;
    const prompt = suppliedPrompt ?? (isRunnable(record.target)
      ? (record.target.promptFile ? await readPrompt(record.target.promptFile) : undefined)
      : record.revisions.find(r => r.id === record.selectedRevisionId)?.spec.instructions);
    const modes = await runtime.failureModes({ task: record.task, failures, ...(prompt !== undefined ? { prompt } : {}) }, ctx);
    validateFailureModes(modes, failed, prompt);
    record.failureModes = modes;
  } catch (error) {
    record.limitations.push(`Не удалось назвать типы провалов: ${error instanceof Error ? error.message : String(error)}`);
  }
}
