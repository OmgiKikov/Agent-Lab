import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { z } from 'zod';
import { ExperimentLab, draftHash, planDiscovery, resultHash } from '../dist/experiment.js';
import { agentSchema, createInputSchema, discoverInputSchema, DEFAULT_JUDGE, describeCheck, dialogueSchema, draftPatchSchema, goldenCaseSchema, reassessmentSchema, ownerProfileSchema, SCENARIO_LIMIT, settingsSchema, targetSchema, type Experiment, type HumanReviewInput } from '../dist/contracts.js';
import { awaitingVerdict, cardVerdict, evidenceSummary, headlineCardOutcome, plannedTrials } from '../dist/comparison.js';
import { judgeAgreement } from '../dist/agreement.js';
import { discoveryBrief, expectationSheet, qualityLines, qualitySummary, scoreBrief, testPlanLines, trialProofLines, type ScoreBrief } from '../dist/quality.js';
import { demoEvaluationInput, demoInput } from '../dist/demo.js';
import { evidenceBundle, exportArtifacts } from '../dist/artifacts.js';
import { agreementSectionLines, allFailuresPointer, buildResultView, causeSection, resultViewLines, SECTION_TEXT, type ResultView } from '../dist/result-view.js';
import { rowsToLines } from '../dist/explain.js';
import { scoreSettings } from '../dist/normalize.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from '../dist/connection.js';
import { inspectPrompt, promptVersion, proposePrompt } from '../dist/prompt-edit.js';
import { readData, selectValidationDialogues } from '../dist/imports.js';
import { ExperimentStore } from '../dist/store.js';
import { activePhases, reviewOrder, safeText, showBoard, trialLines, type BoardAction, type BoardOptions, type Section } from './cards.ts';
import { rememberView, renderAgentLabResult, VERDICT_KIND, type VerdictDetails } from './render/verdict-block.ts';

/** C-119: what the model reads instead of the block, so it does not restate the number and the causes (CTX-08). */
const SHOWN_TO_OWNER = 'Блок-вердикт уже показан владельцу. Не пересказывайте число и причины; ответьте на вопрос или предложите следующий шаг.';

/**
 * Today's tool-row text for every result that is not a phase-4 verdict block: old sessions whose
 * `details` hold the whole summary, and the tools that still return it. Unchanged (UI-SPEC B4).
 */
function legacyResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  const raw = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (options.expanded) return new Text(safeText(raw), 0, 0);
  try {
    const data = JSON.parse(raw);
    // The ResultView block is the first thing shown; no surface computes its own headline count.
    const block: string | undefined = Array.isArray(data.viewLines) && data.viewLines.length ? data.viewLines.join('\n') : undefined;
    // Why the agent failed, in the same words as the CLI: never a separate list of cause names.
    // The owner's disagreements with the judge (F7) and where to mark the rest (F8) sit between
    // that section and the pointer to the board, so the pointer stays the last row (UI-SPEC F7).
    const failureRows: string[] = Array.isArray(data.failureLines) ? data.failureLines : [];
    const pointer = (failureRows.at(-1) ?? '').startsWith('Все провалы — ') ? failureRows.at(-1) : undefined;
    const causeBlock = pointer ? failureRows.slice(0, -1) : failureRows;
    const agreementBlock: string[] = Array.isArray(data.disagreementLines) ? data.disagreementLines : [];
    const parts = [causeBlock, agreementBlock].filter(rows => rows.length).map(rows => rows.join('\n'));
    if (pointer) parts.push(pointer);
    const failures: string | undefined = parts.length ? parts.join('\n\n') : undefined;
    if (data.brief) return new Text(theme.fg('text', safeText([data.scoreState, block, failures, data.brief].filter(Boolean).join('\n\n'))), 0, 0);
    if (data.proofs?.length) return new Text(theme.fg('text', safeText([
      data.error ?? block ?? data.quality?.headline ?? data.evidence?.verdict?.headline,
      ...(data.error ? [] : [failures]),
      ...data.proofs.map((proof: { lines: string[] }) => proof.lines.join('\n')),
    ].filter(Boolean).join('\n\n'))), 0, 0);
    const title = data.error ?? (data.phase === 'review' ? data.message ?? `Готово ${data.scenarioCount} сценариев. Посмотрите их перед запуском.`
      : block ?? data.quality?.headline ?? data.evidence?.verdict?.headline ?? data.message ?? 'Доказательства прочитаны.');
    // A draft answer shows the whole sheet under its title: the owner reads it without opening the board.
    const sheetLines: string[] | undefined = Array.isArray(data.sheetLines) && data.sheetLines.length ? data.sheetLines : undefined;
    const lines = [title, ...(title === block && failures ? ['', failures] : []),
      ...(sheetLines ? ['', ...sheetLines] : []), ...(data.quality?.queue ? [data.quality.queue] : [])];
    return new Text(theme.fg(data.error ? 'error' : 'text', safeText(lines.join('\n'))), 0, 0);
  } catch { return new Text(safeText(raw), 0, 0); }
}
const toolDisplay: Pick<ToolDefinition, 'renderCall' | 'renderResult'> = {
  renderCall: (_args, theme) => new Text(theme.fg('accent', 'Проверка агента'), 0, 0),
  // The verdict block for phase-4 details; everything else keeps today's look (UI-SPEC B3, B4).
  renderResult: (result, options, theme) => renderAgentLabResult(result, options, theme, legacyResult),
};
const returnToBoard = (ctx: ExtensionContext, id: string) => {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  ctx.ui?.setStatus?.('agent-lab', `Agent Lab · ${id.slice(0, 8)} · /agent-lab ${id} — детали`);
};
const inputError = (error: unknown): string => safeText(error instanceof Error ? error.message : error);

/**
 * What is being checked, in the owner's words. A set of more than one situation leads with the
 * compact expectation sheet (UI-D-04): the same rows the board and the tool text show, at most two
 * rules each. A single test keeps its full definition.
 *
 * Confirming seals `fingerprint(scenario)` for every card — the checks, the initial state and the
 * simulator facts too — so a set that is not built from production logs also lists the opening
 * request and the exact checks under the sheet. In a validation set the opening and the checks come
 * from the logged dialogue itself, which the log line above the sheet already says.
 */
function runScope(record: Experiment): string[] {
  const sheet = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1
    ? expectationSheet(record) : undefined;
  if (sheet) {
    const fromLog = record.scenarios.every(scenario => scenario.provenance === 'production');
    const sealed = fromLog ? [] : record.scenarios.flatMap(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`,
      ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)]);
    return [...(fromLog ? ['Клиент отвечает на уточнения симулятором, используя только факты из лога.', ''] : []),
      ...sheet.compactLines(record.id).map(item => safeText(item)),
      ...(sealed.length ? ['', 'Что вы подтверждаете дословно:', ...sealed] : [])];
  }
  return record.scenarios.map(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`,
    ...(record.settings.userModes.includes('scripted') ? (s.user.script ?? []).map((message, i) => `  Продолжение ${i + 1}: ${safeText(message)}`) : []),
    `  Ожидается: ${safeText(s.successCriteria)}`, ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)].join('\n'));
}

function runPlan(record: Experiment): string {
  const target = record.target.kind === 'sandbox' ? 'Учебная песочница' : record.target.kind === 'http' ? record.target.url
    : record.target.kind === 'module' ? record.target.path : `${[record.target.command, ...record.target.args].join(' ')}${record.target.cwd ? ` · ${record.target.cwd}` : ''}`;
  return [
    ...runScope(record),
    '', `Диалогов: ${plannedTrials(record)}. Режимы: ${record.settings.userModes.join(', ')}.`,
    `До ${record.settings.maxCalls} вызовов, ${Math.round(record.settings.maxDurationMs / 1000)} секунд, ${record.settings.maxTurns} ходов.`,
    record.mode === 'demo' ? 'Учебный пример: без модели и оплаты.' : `Модель: ${safeText(record.settings.provider)}/${safeText(record.settings.model)}. Стоимость зависит от фактических вызовов.`,
    ...(record.mode === 'live' ? [`Судья: ${safeText(record.settings.judge?.provider ?? record.settings.provider)}/${safeText(record.settings.judge?.model ?? record.settings.model)}; по 2 вызова в свежих сессиях на каждую применимую рубрику.`] : []),
    'Если адаптер передаёт полный RAG-контекст: ещё до 6 вызовов судьи на диалог в пределах указанного бюджета; диагностика отдельно от accuracy.',
    `Агент: ${safeText(target)}`, `Версия тестов: ${draftHash(record).slice(0, 12)}`,
    'Подтверждая, вы подтверждаете ожидания ситуаций выше. Оценки судьи вы не проверяли.',
  ].join('\n');
}

/** `view` is the evidence bundle's view when the caller has one, so stability matches the CLI summary. */
function summary(record: Experiment, directory: string, view?: ResultView) {
  const comparison = record.comparisons.findLast(c => c.split === 'control');
  const evidence = evidenceSummary(record);
  const quality = record.trials.length ? qualitySummary(record) : undefined;
  const block = record.trials.length ? view ?? buildResultView(record) : undefined;
  const section = block ? causeSection(block) : null;
  const failureLines = block && section
    ? [SECTION_TEXT[section.kind].text, ...rowsToLines(section.rows), ...(block.failures.length ? [allFailuresPointer(record.id)] : [])]
    : undefined;
  // A draft carries its whole expectation sheet, so what the agent must do stays in the chat history (UI-SPEC Chat step 5).
  const sheet = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length ? expectationSheet(record) : undefined;
  return {
    ...(sheet ? { sheetLines: sheet.lines } : {}),
    // Lead with the answer a person asked for; the detailed evidence follows in the same object.
    ...(quality ? { quality: { ...qualityLines(quality), primary: quality.primary, cards: quality.cards, strict: quality.strict, metrics: quality.metrics, causes: quality.causes.slice(0, 5), humanQueue: quality.humanQueue, human: quality.human } } : {}),
    // The same block lines the CLI summary prints first (block only, no details).
    ...(block ? { view: block, viewLines: resultViewLines(block) } : {}),
    // The same failure section the CLI prints under the block; raw text, escaped by each surface.
    ...(failureLines ? { failureLines } : {}),
    // The same disagreement list and next-step row the CLI prints after the causes (F7, F8).
    ...(block ? { disagreementLines: agreementSectionLines(block) } : {}),
    id: record.id, phase: record.phase, mode: record.mode, workflow: record.workflow,
    reviewMode: record.reviewMode, resultsReviewedAt: record.resultsReviewedAt,
    draftHash: draftHash(record), acceptedDraftHash: record.acceptedDraftHash, resultHash: record.trials.length ? resultHash(record) : undefined,
    message: record.message, error: record.error, questions: record.questions,
    scenarioCount: record.scenarios.length, revisionCount: record.revisions.length,
    target: record.target, dialogueCount: record.dialogues.length, profileCount: record.profiles.length, evidence,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, parentRunId: record.parentRunId,
    positiveControlScenarioIds: record.positiveControlScenarioIds,
    trialCount: record.trials.length, humanReviews: record.humanReviews ?? [], usage: record.usage, failureModes: record.failureModes ?? [],
    comparison: comparison && {
      baselineId: comparison.baselineId, candidateId: comparison.candidateId,
      baselinePasses: comparison.baselinePasses, candidatePasses: comparison.candidatePasses,
      verdict: comparison.verdict, fixed: comparison.fixed, regressed: comparison.regressed,
      validPairs: comparison.validPairs, plannedPairs: comparison.plannedPairs,
      scenarioFamilies: comparison.families, delta: comparison.delta, interval: comparison.interval, reasons: comparison.reasons,
    },
    limitations: record.limitations,
    nextStep: evidence.verdict.nextSteps[0] ? `Дальше: ${evidence.verdict.nextSteps[0].text}` : undefined,
    artifacts: { evidence: resolve(directory, `${record.id}.json`),
      ...(record.trials.length ? { traceJournal: resolve(directory, `${record.id}.trace.jsonl`) } : {}) },
  };
}

const renderScoreBrief = (brief: ScoreBrief): string => brief.status === 'insufficient'
  ? `${brief.heading}\n${brief.body}`
  : [
    'ТРЕБОВАНИЯ', ...brief.requirements.map(item => `• ${safeText(item)}`), '',
    'НАБЛЮДАЕМОЕ', ...brief.observations.map(item => `• ${safeText(item)}`), '',
    'НЕИЗВЕСТНО', ...brief.unknowns.map(item => `• ${safeText(item)}`), '',
    'ГИПОТЕЗА', safeText(brief.hypothesis), '', brief.question,
  ].join('\n');

async function humanAnnotation(ctx: ExtensionContext, record: Experiment, selected: number, readingMs = 0, reviewTimes?: Map<string, number>): Promise<HumanReviewInput[] | undefined> {
  const started = performance.now();
  const trial = reviewOrder(record)[selected];
  if (!trial) return;
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const targets: { label: string; ids: { metricId?: string; checkId?: string } }[] = [
    { label: 'Весь диалог', ids: {} },
    ...(scenario?.metrics ?? []).map(m => ({ label: `Критерий · ${safeText(m.name)} [${m.id}]`, ids: { metricId: m.id } })),
    ...(trial.simulatorChecks ?? []).map(c => ({ label: `Симулятор · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id } })),
    ...trial.checks.map(c => ({ label: `Проверка · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id } })),
  ];
  const choice = await ctx.ui.select('Область вашей оценки', targets.map(t => t.label));
  const target = targets.find(t => t.label === choice);
  if (!target) return;
  const simulator = !!target.ids.checkId && trial.simulatorChecks?.some(c => c.id === target.ids.checkId) || !!target.ids.metricId && scenario?.metrics?.some(m => m.id === target.ids.metricId && m.subject === 'simulator');
  const choices = [{ value: 'fail', label: simulator ? 'Ошибся симулятор' : 'Ошибся агент' }, { value: 'invalid', label: 'Ошибся тест' }, { value: 'unknown', label: 'Данных недостаточно' }, { value: 'pass', label: simulator ? 'Симулятор соблюдает карточку' : 'Агент выполнил задачу' }] as const;
  const answer = await ctx.ui.select(`Диалог ${trial.id} · исходная оценка сохранится`, choices.map(v => v.label));
  const verdict = choices.find(v => v.label === answer)?.value;
  if (!verdict) return;
  const note = await ctx.ui.editor('Пояснение · укажите реплики # и причину согласия или ошибки', '');
  if (note === undefined) return;
  const wholeDialogue = !target.ids.metricId && !target.ids.checkId;
  if (wholeDialogue && ![...note.matchAll(/#(\d+)\b/g)].some(match => trial.events.some(event => event.seq === Number(match[1])))) {
    ctx.ui.notify?.('Полный разбор отменён: в пояснении укажите номер события из этого диалога, например #1.', 'warning');
    return;
  }
  return [{ trialId: trial.id, ...target.ids, verdict, note, ...(wholeDialogue ? { reviewedDialogue: true as const } : {}),
    durationMs: Math.min(3600000, Math.round(performance.now() - started + (reviewTimes?.get(`${record.id}|${trial.id}`) ?? readingMs))) }];
}

/** A real agent is independent per dialogue, so several run at once; the scripted sandbox keeps its deterministic order. */
function runParallel(record: Experiment): number {
  return record.target.kind === 'sandbox' ? 1 : Math.max(1, Math.min(8, record.scenarios.length * record.settings.userModes.length * record.settings.repeats));
}

/** Conversational execution asks the human to authorize a concrete plan; it never invents human reviews. */
export default function agentLab(pi: ExtensionAPI) {
  let activeClose: (() => Promise<void>) | undefined;
  const open = (cwd: string) => {
    if (activeClose) throw new Error('Another Agent Lab operation is active. Finish it or cancel it first.');
    const lab = new ExperimentLab(resolve(cwd, '.agent-lab'));
    let closing: Promise<void> | undefined;
    const close = () => closing ??= lab.close().finally(() => { activeClose = undefined; });
    activeClose = close;
    return { lab, close };
  };
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1' || !ctx.hasUI || ctx.mode !== 'tui') return;
    ctx.ui.setTitle(`Agent Lab · ${ctx.cwd.split('/').at(-1)}`);
    ctx.ui.setHeader((_tui, theme) => new Text(theme.bold('Agent Lab') + '\nНасколько хорош ваш агент — на карточках пользователей, с причинами провалов.\n' + safeText(ctx.cwd), 1, 1));
    ctx.ui.setWidget('agent-lab-start', ['Напишите: «Проверь агента в этой папке». Agent Lab найдёт промпт и точку входа, спросит про реальные диалоги (можно без них), предложит карточки пользователей и после запуска покажет качество: справился / не справился, почему, что разметить.',
      'Можно точнее: «Проверь, как агент отвечает про возврат по закрытому договору» или «Воспроизведи эту ошибку: …». /agent-lab — доска с карточками, диалогами и качеством · /agent-lab demo — учебный пример без модели.']);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1') return;
    ctx.ui?.setWidget?.('agent-lab-start', undefined);
    return { systemPrompt: event.systemPrompt + `\nYou are Agent Lab, a conversational tool for measuring the user's real agent. Work in their project and follow the agent-builder skill. The primary flow with de-identified real dialogues is agent_lab_build mode=validate: select up to 15 measurable prompt/RAG cases, ground expectations in owner requirements, use recorded user facts with a reactive simulator instead of scripted follow-ups, exclude masked-only turns and unavailable customer-data cases with explicit reasons, show the actual expectations and sources in the existing run confirmation, run the unchanged real agent after native confirmation, then lead with one estimated card accuracy number, grounded failure causes, separate metrics and limits; save the suite when useful. This is accuracy on the validation set, never a calibrated production guarantee. To mine one new regression test, call agent_lab_build mode=discover. Discovery selects evidence, proposes one saved hypothesis and ends with literal Проверим?. It is selection, not an accuracy estimate. Show that saved brief exactly; do not reconstruct or paraphrase it. If the owner answers yes, call mode=discover again with the exact fromRunId and hypothesis; it re-reads the saved evidence and builds exactly one editable test. A refusal or correction builds nothing. Use agent_lab_accept to show the owner what the agent must do in each situation; the owner confirms all expectations or corrects one in their own words there. agent_lab_run asks to confirm expectations first when they are not confirmed. Execution consent remains separate from accepting a test and from reviewing results. Preserve budgets and model, cite actual event IDs, never invent a human verdict, and do not modify an external agent unless the user asked to fix it.` };
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_build', label: 'Prepare agent and business-scenario tests',
    description: 'Prepare agent checks. mode=validate selects up to 15 measurable prompt/RAG cases from up to 300 de-identified dialogues, grounds expectations in owner requirements and gives user facts to a reactive simulator; unavailable customer data and masked-only utterances are excluded. It does not run the agent. mode=discover mines one regression hypothesis. mode=score evaluates recorded replies without running the agent. mode=demo is the built-in example.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: 120000 }), kind: Type.Optional(Type.Union([Type.Literal('knowledge'), Type.Literal('prompt')], { description: "'prompt' marks the agent's own system prompt: observable rules are extracted from it and every generated card gets the prompt_compliance rubric" })) }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      existingAgent: Type.Optional(Type.Unsafe(z.toJSONSchema(agentSchema))),
      settings: Type.Optional(Type.Unsafe(z.toJSONSchema(settingsSchema, { io: 'input' }))),
      scenarioCount: Type.Optional(Type.Integer({ minimum: 0, maximum: SCENARIO_LIMIT })),
      validationCount: Type.Optional(Type.Integer({ minimum: 1, maximum: SCENARIO_LIMIT, description: 'Cards in mode=validate; defaults to 15.' })),
      connectionFile: Type.Optional(Type.String()), goldenFile: Type.Optional(Type.String()), dialoguesFile: Type.Optional(Type.String()),
      withoutDialogues: Type.Optional(Type.Boolean({ description: 'Set true only when the user explicitly chose to start without real dialogues. Otherwise ask for optional JSON/JSONL logs before building a live run.' })),
      codeOnly: Type.Optional(Type.Boolean({ description: 'With mode=score, preserve recorded facts without any model calls.' })),
      target: Type.Optional(Type.Unsafe(z.toJSONSchema(targetSchema, { io: 'input' }))),
      targetVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Agent release, commit or remote deployment version.' })),
      goldenCases: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(goldenCaseSchema).max(40), { io: 'input' }))),
      dialogues: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(dialogueSchema).max(300), { io: 'input' }))),
      notes: Type.Optional(Type.String({ maxLength: 8000, description: "The owner's own hints about users, goals and situations, in their words. First-class input for synthetic cards; never treated as a business rule." })),
      profiles: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(ownerProfileSchema).max(6), { io: 'input' }))),
      fromRunId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$', description: 'Exact saved discovery run returned by the previous mode=discover call.' })),
      resumeRunId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$', description: 'Safely interrupted discovery run to continue after native budget confirmation. Do not combine with fromRunId or hypothesis.' })),
      hypothesis: Type.Optional(Type.String({ minLength: 1, maxLength: 3000, description: 'Exact saved hypothesis returned by the previous mode=discover call.' })),
      mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('demo'), Type.Literal('score'), Type.Literal('discover'), Type.Literal('validate')])),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, onUpdate, ctx) {
      const { goldenFile, dialoguesFile, connectionFile, withoutDialogues, codeOnly, fromRunId, resumeRunId, hypothesis, ...rest } = params;
      const operation = rest.mode ?? 'live';
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      if (operation !== 'discover' && (fromRunId || resumeRunId || hypothesis)) throw new Error('fromRunId, resumeRunId и hypothesis используются только с mode=discover.');
      if (resumeRunId && (fromRunId || hypothesis)) throw new Error('resumeRunId нельзя совмещать с fromRunId или hypothesis.');
      if (operation === 'discover' && fromRunId) {
        if (!hypothesis) throw new Error('После ответа владельца передайте точную сохранённую hypothesis вместе с fromRunId.');
        const { lab, close } = open(ctx.cwd);
        try {
          await lab.init();
          const started = await lab.buildFromDiscovery(fromRunId, hypothesis);
          await lab.waitForIdle();
          const record = await lab.get(started.id);
          if (record.phase !== 'review') throw new Error(record.error ?? 'Не удалось собрать тест из сохранённого discovery.');
          const testPlan = testPlanLines(record);
          const output = { ...summary(record, lab.store.directory), fromRunId, confirmedHypothesis: hypothesis,
            builtTests: record.scenarios.length, accepted: false, agentRun: false,
            brief: testPlan.lines.join('\n'), testPlan,
            nextStep: 'Покажите владельцу полный тест и используйте agent_lab_accept только для его явного принятия.' };
          returnToBoard(ctx, record.id);
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
        } finally { await close(); }
      }
      if (operation === 'discover' && resumeRunId) {
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для возобновления discovery нужен native Pi confirmation в интерактивном терминале. CLI: discover-resume --id RUN --yes.');
        const source = await new ExperimentStore(resolve(ctx.cwd, '.agent-lab')).get(resumeRunId);
        if (!source.discovery) throw new Error('Указанный run не является discovery.');
        const callsUsed = Math.max(source.usage.calls, source.discovery.callsUsed);
        const maxCalls = source.discovery.callPlan.maxCalls;
        const maxDurationMs = source.discovery.callPlan.maxDurationMs;
        if (source.discovery.callPlan.legacyBudgetMissing) throw new Error('Старая discovery-запись не содержит исходный бюджет; начните новый discovery run.');
        if (source.discovery.activeCall) throw new Error(`Discovery остановился во время модельного вызова «${source.discovery.activeCall}»; безопасное возобновление невозможно.`);
        if (['ready', 'insufficient'].includes(source.discovery.phase)) throw new Error('Этот discovery run не требует возобновления.');
        if (callsUsed >= maxCalls) throw new Error('Бюджет discovery исчерпан; найденные доказательства сохранены.');
        const planText = safeText([
          `Статус: ${source.discovery.phase}.`,
          `Вызовы: ${callsUsed}/${maxCalls}; осталось не более ${Math.max(0, maxCalls - callsUsed)}.`,
          `Сохранённый общий лимит времени: до ${Math.ceil(maxDurationMs / 1000)} секунд (это не обещание оставшегося времени).`,
          'Продолжить сохранённый отбор кандидатов? Агент и симулятор не запускаются.',
        ].join('\n'));
        if (!await ctx.ui.confirm('Возобновить discovery?', planText)) {
          const output = { status: 'cancelled', calls: 0, mutated: false, resumeRunId,
            discoveryStatus: source.discovery.phase, callsUsed, maxCalls, remainingCalls: Math.max(0, maxCalls - callsUsed), maxDurationMs };
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
        }
        signal.throwIfAborted();
        const { lab, close } = open(ctx.cwd);
        const cancel = () => { void lab.cancel(resumeRunId).catch(() => {}); };
        try {
          await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
          onUpdate?.({ content: [{ type: 'text', text: 'Продолжаю поиск проверяемого сигнала…' }], details: { phase: 'discovery' } });
          await lab.resumeDiscovery(resumeRunId);
          if (signal.aborted) cancel();
          await lab.waitForIdle();
          const record = await lab.get(resumeRunId);
          const projected = discoveryBrief(record);
          const output = { id: record.id, phase: projected.status, resumed: true,
            plan: { dialogueCount: source.discovery.totalDialogues, batches: source.discovery.callPlan.batches,
              selectedCap: source.discovery.callPlan.selectedCap, nominalCalls: source.discovery.callPlan.nominalCalls,
              maxCalls, maxDurationMs },
            brief: projected.lines.join('\n'), discovery: projected,
            ...(projected.fromRunId && projected.hypothesis ? { fromRunId: projected.fromRunId, hypothesis: projected.hypothesis } : {}),
            agentRun: false, accepted: false };
          returnToBoard(ctx, record.id);
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
        } finally { signal.removeEventListener('abort', cancel); await close(); }
      }
      if (operation === 'discover' && hypothesis) throw new Error('Для точной сборки из discovery нужны и fromRunId, и hypothesis.');
      if (operation === 'score') onUpdate?.({ content: [{ type: 'text', text: 'Читаю требования и записи…' }], details: { phase: 'reading' } });
      let dialogues: unknown;
      try { dialogues = dialoguesFile ? await readData(resolve(ctx.cwd, dialoguesFile), 'dialogues', { maxItems: ['discover', 'validate'].includes(operation) ? 300 : 200 }) : rest.dialogues; }
      catch (error) {
        if (!['score', 'discover', 'validate'].includes(operation)) throw error;
        throw new Error(safeText(`Не удалось прочитать записи: ${error instanceof Error ? error.message : String(error)}. Исправьте JSON/JSONL и повторите команду; агент не запускался.`));
      }
      let parsedDialogues: z.infer<typeof dialogueSchema>[];
      try { parsedDialogues = z.array(dialogueSchema).max(['discover', 'validate'].includes(operation) ? 300 : 200).parse(dialogues ?? []); }
      catch (error) {
        if (!['score', 'discover', 'validate'].includes(operation)) throw error;
        throw new Error(safeText(`Не удалось прочитать записи: ${error instanceof Error ? error.message : String(error)}. Исправьте JSON/JSONL и повторите команду; агент не запускался.`));
      }
      if (operation === 'discover' && !parsedDialogues.length) {
        const output = { status: 'needs_input', message: 'Для discovery укажите JSON/JSONL с обезличенными реальными диалогами.',
          nextStep: 'Ask for dialoguesFile or dialogues, then call mode=discover again.' };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
      }
      if (operation === 'validate' && !parsedDialogues.length) throw new Error('Для validation set укажите JSON/JSONL с обезличенными реальными диалогами.');
      if (operation !== 'demo' && !parsedDialogues.length && withoutDialogues !== true) {
        const output = { status: 'needs_input', message: 'Есть реальные диалоги с агентом? Укажите файл JSON/JSONL с обезличенными разговорами или скажите «начать без логов».',
          nextStep: 'Ask the user in ordinary language. Import their supplied dialoguesFile/dialogues, or set withoutDialogues=true after their explicit choice to skip. Do not silently skip or search unrelated logs.' };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
      }
      if (operation === 'score' && !parsedDialogues.length) {
        const output = { status: 'insufficient', dialogueCount: 0,
          brief: 'Недостаточно данных для гипотезы\nДобавьте требования владельца и хотя бы одно наблюдение из репозитория или записанного диалога.' };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
      }
      if (operation === 'score' && !codeOnly && (!ctx.hasUI || ctx.mode !== 'tui')) throw new Error('Для модельной оценки нужен native Pi confirmation в интерактивном терминале.');
      const supplied = (rest.settings ?? {}) as Partial<z.infer<typeof settingsSchema>>;
      const sourceDialogueCount = parsedDialogues.length;
      const validationCount = operation === 'validate' ? rest.validationCount ?? 15 : 0;
      if (operation === 'validate') {
        parsedDialogues = selectValidationDialogues(parsedDialogues, Math.min(40, validationCount * 3));
        if (!parsedDialogues.length) throw new Error('В логах нет пригодных диалогов с 1–16 репликами пользователя без полностью замаскированных реплик.');
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для сборки validation set нужен native Pi confirmation в интерактивном терминале.');
        const maxCalls = supplied.maxCalls ?? Math.max(140, 2 * parsedDialogues.length + 19 * validationCount + 20);
        const maxDurationMs = supplied.maxDurationMs ?? Math.max(180_000, 180_000 * parsedDialogues.length);
        if (!await ctx.ui.confirm('Собрать validation set?', safeText([
          `Исходных диалогов: ${sourceDialogueCount}; outcome-blind пул: ${parsedDialogues.length}; карточек: ${validationCount}.`,
          'Один применимый реальный диалог → одна карточка с живым симулятором. Случаи без правил владельца или с недоступными данными клиента исключаются до запуска; старые оценки не используются.',
          `Сборка и будущий прогон разделены. Потолок набора: ${maxCalls} модельных вызовов, до ${Math.ceil(maxDurationMs / 60_000)} минут.`,
        ].join('\n')))) return { content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled', calls: 0, mutated: false }) }], details: { status: 'cancelled' } };
      }
      if (operation === 'discover') {
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для discovery нужен native Pi confirmation в интерактивном терминале.');
        const connection = connectionFile ? await readConnection(resolve(ctx.cwd, connectionFile)) : !rest.target ? await rememberedConnection(resolve(ctx.cwd, '.agent-lab')) : undefined;
        const input = discoverInputSchema.parse({ task: rest.task, materials: rest.materials, existingAgent: rest.existingAgent,
          target: connection?.target ?? rest.target, targetVersion: connection?.targetVersion ?? rest.targetVersion,
          dialogues: parsedDialogues, notes: rest.notes, mode: 'live',
          settings: { repeats: 1, maxCalls: 20, maxDurationMs: 180000, judge: DEFAULT_JUDGE, ...supplied,
            provider: supplied.provider || ctx.model?.provider || '', model: supplied.model || ctx.model?.id || '' } });
        const plan = planDiscovery(input);
        const planText = safeText([
          `${input.dialogues.length} диалогов · ${plan.batchCount} партий первичного разбора.`,
          `Подробно проверить: до ${plan.selectedCap}.`,
          `План: ${plan.nominalCalls} модельных вызовов; потолок: ${plan.maxCalls}; время: до ${Math.ceil(plan.maxDurationMs / 1000)} секунд.`,
          'Это отбор кандидатов, не оценка accuracy. Агент и симулятор не запускаются.',
        ].join('\n'));
        if (!await ctx.ui.confirm('Найти полезный тест в записанных диалогах?', planText)) {
          const output = { status: 'cancelled', calls: 0, mutated: false,
            plan: { dialogueCount: input.dialogues.length, batches: plan.batchCount, selectedCap: plan.selectedCap, nominalCalls: plan.nominalCalls,
              maxCalls: plan.maxCalls, maxDurationMs: plan.maxDurationMs } };
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
        }
        signal.throwIfAborted();
        const { lab, close } = open(ctx.cwd);
        let id: string | undefined;
        const cancel = () => { if (id) void lab.cancel(id).catch(() => {}); };
        try {
          await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
          onUpdate?.({ content: [{ type: 'text', text: 'Ищу повторяющийся проверяемый сигнал…' }], details: { phase: 'discovery' } });
          id = (await lab.discover(input)).id;
          if (signal.aborted) cancel();
          await lab.waitForIdle();
          const record = await lab.get(id);
          const projected = discoveryBrief(record);
          const output = { id: record.id, phase: projected.status,
            plan: { dialogueCount: input.dialogues.length, batches: plan.batchCount, selectedCap: plan.selectedCap, nominalCalls: plan.nominalCalls,
              maxCalls: plan.maxCalls, maxDurationMs: plan.maxDurationMs },
            brief: projected.lines.join('\n'), discovery: projected,
            ...(projected.fromRunId && projected.hypothesis ? { fromRunId: projected.fromRunId, hypothesis: projected.hypothesis } : {}),
            agentRun: false, accepted: false };
          returnToBoard(ctx, record.id);
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
        } finally { signal.removeEventListener('abort', cancel); await close(); }
      }
      const mode = operation === 'demo' ? 'demo' : 'live';
      const connection = mode === 'demo' ? undefined : connectionFile ? await readConnection(resolve(ctx.cwd, connectionFile)) : !rest.target ? await rememberedConnection(resolve(ctx.cwd, '.agent-lab')) : undefined;
      const input = createInputSchema.parse({
        ...(mode === 'demo' ? demoEvaluationInput() : {}), ...rest, scenarioCount: ['score', 'validate'].includes(operation) ? 0 : rest.scenarioCount ?? (mode === 'demo' ? 3 : 1),
        ...(operation === 'validate' ? { validationCount } : {}), mode, workflow: 'evaluate',
        ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(goldenFile ? { goldenCases: await readData(resolve(ctx.cwd, goldenFile), 'golden') } : {}),
        ...(dialogues !== undefined ? { dialogues: parsedDialogues } : {}),
        // Score settings come from the helper the CLI uses, so both paths save the same budget, judge and timeout.
        settings: operation === 'score' ? { ...scoreSettings(parsedDialogues.length, supplied, mode),
          provider: supplied.provider || ctx.model?.provider || '', model: supplied.model || ctx.model?.id || '' }
          : { ...(mode === 'demo' ? demoInput().settings : {}), repeats: 1,
          maxCalls: operation === 'validate' ? Math.max(140, 2 * parsedDialogues.length + 19 * validationCount + 20) : 20,
          maxDurationMs: operation === 'validate' ? Math.max(180_000, 180_000 * parsedDialogues.length) : 180_000,
          ...(mode === 'live' ? { judge: DEFAULT_JUDGE } : {}),
          // Grounding many materials with a small model routinely exceeds the two-minute default per call.
          ...(operation === 'validate' ? { timeoutMs: 600_000 } : {}),
          ...supplied,
          ...(operation === 'validate' ? { maxTurns: 6, userModes: ['reactive'] } : {}),
          provider: supplied.provider || ctx.model?.provider || '', model: supplied.model || ctx.model?.id || '' },
      });
      const { lab, close } = open(ctx.cwd);
      let id: string | undefined;
      let polling: Promise<void> = Promise.resolve();
      let timer: ReturnType<typeof setInterval> | undefined;
      let lastProgress = '';
      let scoreStage: 'import' | 'judge' = 'import';
      const progress = async () => {
        if (!id || !onUpdate) return;
        const record = await lab.get(id);
        if (operation === 'score' && !record.trials.length) return;
        const text = operation === 'score' ? safeText(`${scoreStage === 'import' ? 'Импортировано' : 'Оценено'} ${record.trials.length} из ${parsedDialogues.length} диалогов · вызовов ${record.usage.calls}`)
          : safeText(`${record.phase === 'preparing' ? 'Готовлю требования и тест' : 'Тест готов'}: ${record.message} · вызовов ${record.usage.calls}`);
        if (text !== lastProgress) { lastProgress = text; onUpdate({ content: [{ type: 'text', text }], details: { id, phase: record.phase } }); }
      };
      const cancel = () => { if (id) void lab.cancel(id).catch(() => {}); };
      try {
        await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
        if (operation === 'score') {
          id = (await lab.score(input, { codeOnly: true })).id;
          if (signal.aborted) cancel();
          await progress(); timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
          await lab.waitForIdle(); await progress();
          let record = await lab.get(id);
          if (!codeOnly) {
            signal.throwIfAborted();
            const nominalMinCalls = parsedDialogues.length * 5 + 2;
            const nominalMaxCalls = parsedDialogues.length * 7 + 2;
            const confirmed = await ctx.ui.confirm('Оценить записанные диалоги?', safeText([
              `Агент и симулятор не запускаются. ${parsedDialogues.length} ${parsedDialogues.length === 1 ? 'диалог' : 'диалогов'}.`,
              `План: ${nominalMinCalls}–${nominalMaxCalls} модельных вызовов; потолок: ${input.settings.maxCalls}.`,
              `Время: до ${Math.ceil(input.settings.maxDurationMs / 60_000)} минут.`,
            ].join('\n')));
            if (!confirmed) {
              const bundle = await evidenceBundle(record, lab.store);
              const output = { ...summary(record, lab.store.directory, bundle.view), cancelled: true, brief: renderScoreBrief(scoreBrief(record)),
                artifacts: await exportArtifacts(bundle, lab.store.directory) };
              return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
            }
            signal.throwIfAborted(); lastProgress = ''; id = undefined;
            id = (await lab.score(input)).id; if (signal.aborted) cancel();
            await lab.waitForIdle(); await progress();
            record = await lab.get(id);
            if (record.phase === 'results_review' && !record.error && !record.questions.length) {
              signal.throwIfAborted(); scoreStage = 'judge'; lastProgress = ''; const scoredId = record.id; id = undefined;
              id = (await lab.reassess(scoredId, {}, { carryUsage: true })).id; if (signal.aborted) cancel();
              await lab.waitForIdle(); await progress(); record = await lab.get(id);
            }
          }
          const bundle = await evidenceBundle(record, lab.store);
          const output = { ...summary(record, lab.store.directory, bundle.view), ...(codeOnly ? { scoreState: 'Оценено по коду без вызовов модели; кластеры провалов не строились.' } : {}),
            brief: renderScoreBrief(scoreBrief(record)),
            artifacts: await exportArtifacts(bundle, lab.store.directory), ...(signal.aborted ? { cancelled: true } : {}) };
          returnToBoard(ctx, id);
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
        }
        id = (await lab.create(input)).id;
        if (signal.aborted) cancel();
        await progress();
        timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
        await lab.waitForIdle(); await progress();
        const record = await lab.get(id);
        const bundle = await evidenceBundle(record, lab.store);
        const output = { ...summary(record, lab.store.directory, bundle.view),
          ...(operation === 'validate' ? { validation: { sourceDialogues: sourceDialogueCount, candidateDialogues: parsedDialogues.length, sampledDialogues: record.scenarios.length, estimatedAccuracyAfterRun: true } } : {}),
          artifacts: await exportArtifacts(bundle, lab.store.directory), ...(signal.aborted ? { cancelled: true } : {}) };
        returnToBoard(ctx, id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_inspect', label: 'Inspect agent cards and evidence',
    description: 'Read a saved draft and its hash, or a full trial transcript/state using trialId. export=true creates local HTML and Markdown reports and an AgentSpec snapshot. This tool never approves a draft or result. Legacy comparison control traces remain hidden until the control phase stops.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), trialId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' })), export: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        const record = await lab.get(params.id);
        const bundle = await evidenceBundle(record, lab.store);
        const controlVisible = record.workflow === 'evaluate' || !!record.controlConsumedAt && !activePhases.has(record.phase);
        const trial = params.trialId ? record.trials.find(t => t.id === params.trialId) : undefined;
        if (params.trialId && !trial) throw new Error('Trial not found in this experiment.');
        if (trial?.split === 'control' && !controlVisible) throw new Error('Control evidence stays hidden until the final control phase stops.');
        const output = trial ?? {
          ...summary(record, lab.store.directory, bundle.view), agent: record.revisions.find(r => r.id === record.selectedRevisionId)?.spec,
          settings: record.settings, requirements: record.requirements, profiles: record.profiles,
          scenarios: record.scenarios.filter(s => s.split === 'dev' || controlVisible), revisions: record.revisions, iterations: record.iterations,
          trials: record.trials.filter(t => t.split === 'dev' || controlVisible).map(t => ({ id: t.id, revisionId: t.revisionId, scenarioId: t.scenarioId, split: t.split, outcome: t.outcome, reason: t.reason })),
          ...(bundle.comparison ? { comparison: bundle.comparison, comparisonSource: bundle.comparisonSource } : {}),
          warnings: bundle.warnings,
          ...(params.export ? { artifacts: await exportArtifacts(bundle, lab.store.directory) } : {}),
        };
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: { id: record.id } };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_edit', label: 'Edit an unapproved agent draft',
    description: 'Edit a draft after inspecting its current draftHash. scenarios upserts full cards by id and preserves omitted cards. Delete only explicitly with removeScenarioIds. AgentSpec, settings, target and targetVersion may also change. Human approval stays pending. Cannot change started experiments, run dialogues, record human verdicts, or approve results. Expectations of situations are changed by the owner through agent_lab_accept, not by this tool.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), patch: Type.Unsafe({ ...z.toJSONSchema(draftPatchSchema, { io: 'input' }), description: 'profileEdits replaces draft overrides on existing profiles and updates all linked cards. Original profiles and evidence stay intact. override:null restores original; persona:null clears persona; characteristics:[] clears traits. Omitted override fields use the original. Use scenarios to link/unlink profileId.' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        const record = await lab.updateDraft(params.id, params.expectedHash, draftPatchSchema.parse(params.patch));
        const output = summary(record, lab.store.directory);
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_accept', label: 'Confirm what the agent must do',
    description: "Show the owner what the agent must do in each situation of the set (or the complete one-test definition) and record their confirmation, or their own-words correction of one expectation. The text and the consent come from native Pi dialogs only; the model supplies neither. It never runs the agent, calls a model, or saves a suite.",
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для принятия теста нужен интерактивный терминал. В CLI используйте accept --id RUN --yes.');
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let record = await lab.get(params.id);
        // A set of more than one situation is confirmed as one sheet (UI-D-03); one test keeps its own definition.
        if (record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1) {
          const answer = (output: Record<string, unknown>) => {
            returnToBoard(ctx, record.id);
            return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: output };
          };
          while (true) {
            signal?.throwIfAborted();
            const sheet = expectationSheet(record);
            const body = `${sheet.compactLines(record.id).map(item => safeText(item)).join('\n')}\n\nДа — подтвердить все. Нет — поправить одну ситуацию или отменить.`;
            if (await ctx.ui.confirm(`Подтвердить ожидания: ${sheet.countText}?`, body)) {
              signal?.throwIfAborted();
              const accepted = await lab.acceptDraft(record.id, sheet.draftHash);
              return answer({ id: accepted.id, accepted: true, draftHash: sheet.draftHash, acceptedDraftHash: accepted.acceptedDraftHash,
                message: `Ожидания подтверждены: ${sheet.countText}. Можно запускать.`, sheetLines: expectationSheet(accepted).lines });
            }
            signal?.throwIfAborted();
            if (await ctx.ui.select('Что сделать с ожиданиями?', ['Поправить ожидание одной ситуации', 'Не подтверждать сейчас'])
              !== 'Поправить ожидание одной ситуации') {
              return answer({ id: record.id, accepted: false, draftHash: sheet.draftHash,
                message: 'Ожидания не подтверждены. Прогон не начнётся, пока они не подтверждены.', sheetLines: sheet.lines });
            }
            signal?.throwIfAborted();
            const options = sheet.cards.map(card => safeText(`${card.label} ${card.title}`));
            const card = sheet.cards[options.indexOf(await ctx.ui.select('Какую ситуацию поправить?', options) ?? '')];
            if (!card) continue;
            const scenario = record.scenarios.find(item => item.id === card.scenarioId);
            const current = scenario?.successCriteria ?? '';
            const written = await ctx.ui.editor('Что агент должен сделать в этой ситуации? Своими словами.', current);
            if (written === undefined) continue;
            const text = written.trim();
            if (!text || text === current.trim()) { ctx.ui.notify?.('Ожидание не изменено.', 'info'); continue; }
            if (text.length > 3000) { ctx.ui.notify?.('Ожидание длиннее 3000 знаков. Сократите и попробуйте снова.', 'error'); continue; }
            try { record = await lab.setExpectation(record.id, sheet.draftHash, card.scenarioId, written); }
            catch (error) { ctx.ui.notify?.(inputError(error), 'error'); record = await lab.get(record.id); }
          }
        }
        const projection = testPlanLines(record);
        const question = projection.lines.at(-1)!;
        const body = projection.lines.slice(0, -2).join('\n');
        if (!await ctx.ui.confirm(question, body)) {
          return { content: [{ type: 'text', text: JSON.stringify({ id: record.id, accepted: false, draftHash: projection.draftHash,
            message: 'Тест не принят и остался доступен для правки. Агент не запускался.' }) }], details: { id: record.id, accepted: false } };
        }
        signal?.throwIfAborted();
        const accepted = await lab.acceptDraft(record.id, projection.draftHash);
        const output = { id: accepted.id, accepted: true, draftHash: projection.draftHash, acceptedDraftHash: accepted.acceptedDraftHash,
          message: 'Тест принят. Агент не запускался.' };
        returnToBoard(ctx, accepted.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_repeat', label: 'Prepare another run of the same cards',
    description: 'Copy a previously approved evaluation into a fresh draft without model generation. Preserves cards, materials and settings, captures current local code identity, clears results and approvals. Inspect it and use agent_lab_run; /agent-lab is an optional detailed view.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40, description: 'Repeat only these existing tests; omit for the whole regression set.' })),
      controlScenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), { minItems: 1, maxItems: 5, description: 'Mark existing situations as positive controls: real dialogues the agent is known to handle. They are shown apart and never enter the headline number. Each control runs as one turn (the opening and the agent\'s first reply, no simulator), so simulator drift cannot hide a broken judge or connection; controls are left out of the repeat diff.' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try { await lab.init(); const record = await lab.repeat(params.id, params.scenarioIds, params.controlScenarioIds); const output = summary(record, lab.store.directory);
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_run', label: 'Run the proposed tests',
    description: 'Run the exact inspected evaluation draft, with native confirmation of its target, tests and budget. Does not record human review of expectations or results. Stay in the conversation and inspect the evidence after running. Cannot run headlessly or without the human confirmation. Never bypass this tool through shell or internal APIs.',
    parameters: Type.Object({ id: Type.String(), expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, onUpdate, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для нового запуска нужен интерактивный терминал. В CI используйте evaluate --input suite.json --yes с явно заданным бюджетом.');
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      let timer: ReturnType<typeof setInterval> | undefined;
      let polling: Promise<void> = Promise.resolve();
      const cancel = () => { void lab.cancel(params.id).catch(() => {}); };
      try {
        await lab.init();
        const draft = await lab.get(params.id);
        if (draft.workflow !== 'evaluate' || draftHash(draft) !== params.expectedHash) throw new Error('План изменился. Прочитайте актуальный черновик через agent_lab_inspect.');
        // UI-D-02 in chat: unconfirmed expectations are confirmed in the same native dialog that starts the run.
        const confirmed = draft.acceptedDraftHash === params.expectedHash;
        const plan = confirmed ? runPlan(draft) : `${runPlan(draft)}\nДа — подтвердить все ожидания и начать прогон.`;
        if (!await ctx.ui.confirm(confirmed ? 'Запустить проверку?' : 'Подтвердить ожидания и запустить?', plan)) {
          return { content: [{ type: 'text', text: JSON.stringify({ id: draft.id, cancelled: true, message: 'Запуск отменён. Тесты сохранены; не повторяйте запрос запуска без новой просьбы пользователя.' }) }], details: { cancelled: true } };
        }
        signal.throwIfAborted();
        if (!confirmed) await lab.acceptDraft(draft.id, params.expectedHash);
        await lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: params.expectedHash, parallel: runParallel(draft), requireAccepted: true });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        const progress = async () => {
          const r = await lab.get(draft.id);
          onUpdate?.({ content: [{ type: 'text', text: safeText(`Проверено ${r.trials.length} из ${plannedTrials(r)} · ${r.message}`) }], details: { id: r.id, phase: r.phase } });
        };
        await progress();
        timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
        await lab.waitForIdle(); await progress();
        const record = await lab.get(draft.id);
        const bundle = await evidenceBundle(record, lab.store);
        // `content` stays the model's JSON plus C-119; the session holds ids only (REV-01, T-04-03):
        // the block is drawn from the remembered view, never from text written into the 0644 session file.
        const output = { ...summary(record, lab.store.directory, bundle.view), proofs: record.trials.map(trial => trialProofLines(record, trial.id)),
          comparison: bundle.comparison, artifacts: await exportArtifacts(bundle, lab.store.directory), shownToOwner: SHOWN_TO_OWNER };
        const resultKey = `${record.id}:${resultHash(record)}`;
        let details: VerdictDetails | { id: string } = { id: record.id };
        if (bundle.view) {
          rememberView(resultKey, bundle.view);
          details = { kind: VERDICT_KIND, version: 1, runId: record.id, resultKey };
        }
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details };
      } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_suite', label: 'Save or load reusable tests',
    description: 'Save selected tests as a versionable .evals/*.json file, or load that file into a fresh draft without model generation. Preserves original provenance and criteria. Clears results and approvals. Saving never overwrites an existing file. Use after a useful finding or when the user wants a regression test. Loading does not run it; inspect then use agent_lab_run.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('save'), Type.Literal('load'), Type.Literal('list')]), connectionFile: Type.Optional(Type.String()), file: Type.String({ minLength: 1 }),
      id: Type.Optional(Type.String()), scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let output: unknown;
        if (params.action === 'list') output = await listSuites(resolve(ctx.cwd, params.file));
        else if (params.action === 'save') {
          if (!params.id) throw new Error('Укажите прогон, из которого сохранить тесты.');
          const file = await lab.saveSuite(params.id, resolve(ctx.cwd, params.file), params.scenarioIds);
          output = { file, message: 'Тесты сохранены. Их можно добавить в Git и запускать после каждой правки.', nextStep: `agent-lab evaluate --input ${JSON.stringify(file)} --yes` };
        } else output = summary(await lab.loadSuite(resolve(ctx.cwd, params.file), params.scenarioIds, params.connectionFile ? await readConnection(resolve(ctx.cwd, params.connectionFile)) : undefined), lab.store.directory);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_connection', label: 'Check agent connection',
    description: 'Inspect a saved connection or run its explicit three-request history/reset probe. Use file for portable JSON config; omit to use the remembered successful connection. check asks the human to approve the concrete requests. Reports actual evidence; never claims trusted state merely from adapter assertions.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('inspect'), Type.Literal('check')]), file: Type.Optional(Type.String()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const directory = resolve(ctx.cwd, '.agent-lab');
      const connection = params.file ? await readConnection(resolve(ctx.cwd, params.file)) : await rememberedConnection(directory);
      if (!connection) throw new Error('Сохранённого подключения нет. Укажите файл подключения.');
      let output: unknown = connection;
      if (params.action === 'check') {
        if (!connection.probe) throw new Error('Добавьте probe.write/read/reset и initialState в файл подключения.');
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Проверка подключения требует native Pi confirmation.');
        if (!await ctx.ui.confirm('Проверить историю и сброс · 3 запроса?', safeText(JSON.stringify({ target: connection.target, probe: connection.probe }, null, 2)))) return { content: [{ type: 'text', text: 'Проверка отменена.' }], details: {} };
        const result = await doctor(connection, AbortSignal.any([signal, ctx.signal].filter((s): s is AbortSignal => !!s)));
        if (result.passed) await rememberConnection(directory, connection);
        output = result;
      }
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_reassess', label: 'Reassess recorded evidence',
    description: 'Evaluate new checks/rubrics on existing trial traces without calling the target or simulator. Creates a separate immutable result retaining the original run. codeOnly uses no model; judge overrides are optional. This cannot demonstrate an agent improvement. Ask native confirmation before model spending.',
    parameters: Type.Object({ id: Type.String(), input: Type.Optional(Type.Unsafe(z.toJSONSchema(reassessmentSchema, { io: 'input' }))) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const input = reassessmentSchema.parse(params.input ?? {});
      const { lab, close } = open(ctx.cwd);
      const cancel = () => { void close(); };
      try {
        await lab.init();
        const original = await lab.get(params.id);
        if (!input.codeOnly) {
          if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Переоценка моделью требует native Pi confirmation.');
          if (!await ctx.ui.confirm('Переоценить сохранённые ответы?', safeText(`Агент не запускается. Диалогов: ${input.trialIds?.length ?? original.trials.length}. До ${original.settings.maxCalls} вызовов, ${original.settings.maxDurationMs / 1000} секунд.\n${JSON.stringify(input, null, 2)}`))) return { content: [{ type: 'text', text: 'Переоценка отменена.' }], details: {} };
        }
        signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
        const draft = await lab.reassess(params.id, input);
        await lab.waitForIdle();
        const record = await lab.get(draft.id);
        const bundle = await evidenceBundle(record, lab.store);
        const output = { ...summary(record, lab.store.directory, bundle.view), assessmentOf: record.assessmentOf,
          artifacts: await exportArtifacts(bundle, lab.store.directory) };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { signal?.removeEventListener('abort', cancel); await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_review', label: 'Ask for a human verdict',
    description: 'Show a recorded dialogue and its evidence, then ask the human to choose a verdict and explanation in native Pi UI. Call after discussing a concrete finding. Only id and trialId are accepted: the model cannot supply a human verdict. Cancellation saves no annotation. After a confirmed dev failure, use agent_lab_prompt for a requested fix.',
    parameters: Type.Object({ id: Type.String(), trialId: Type.String() }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, _onUpdate, ctx) {
      const { id, trialId } = z.strictObject({ id: z.string().uuid(), trialId: z.string().min(1) }).parse(params);
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Вердикт человека требует интерактивного терминала.');
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
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
    ...toolDisplay, name: 'agent_lab_prompt', label: 'Review one prompt change',
    description: 'propose saves an isolated candidate prompt and diff, citing human-confirmed dev failures. Never use control feedback. apply requires native diff review and creates a draft with the EXACT same capability/regression cards and a candidate promptFile; then use agent_lab_run. Adapter must attest promptHash. Original prompt file is preserved.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('propose'), Type.Literal('inspect'), Type.Literal('apply')]),
      id: Type.Optional(Type.String()), file: Type.Optional(Type.String()), candidate: Type.Optional(Type.String({ maxLength: 96000 })),
      hypothesis: Type.Optional(Type.String({ maxLength: 3000 })), trialIds: Type.Optional(Type.Array(Type.String(), { maxItems: 40 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let output: unknown;
        if (params.action === 'propose') {
          if (!params.id || !params.candidate || !params.hypothesis || !params.trialIds) throw new Error('Нужны id, candidate, hypothesis и trialIds подтверждённых ошибок.');
          output = await proposePrompt(lab.store.directory, await lab.get(params.id), { candidate: params.candidate, hypothesis: params.hypothesis, trialIds: params.trialIds });
        } else {
          if (!params.file) throw new Error('Укажите file предложения.');
          const file = resolve(ctx.cwd, params.file);
          const inspected = await inspectPrompt(file);
          if (params.action === 'inspect') output = inspected;
          else {
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Выбор версии промпта требует native Pi review.');
            if (!await ctx.ui.confirm('Проверить эту версию промпта?', safeText(inspected.proposal.hypothesis + '\n' + inspected.diff))) return { content: [{ type: 'text', text: 'Изменение отменено.' }], details: {} };
            output = summary(await promptVersion(lab, file, inspected.reviewHash), lab.store.directory);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { await close(); }
    },
  });
  pi.registerCommand('agent-lab', {
    description: 'Проверить агента: /agent-lab, /agent-lab demo или /agent-lab /путь/к/проекту',
    async handler(args, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Human review requires the native Pi terminal. Start interactive Pi and open /agent-lab. Headless tools only prepare and edit drafts.');
      const startRequest = args.trim() === 'new' || args.trim().startsWith('/') || args.trim().startsWith('~');
      let handoff: { request: string; context: unknown } | undefined;
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let id = startRequest || args.trim() === 'demo' ? undefined : args.trim() || undefined;
        let section: Section | undefined;
        let selected = 0;
        let query = '';
        let pendingOnly = false;
        let beforeId: string | undefined;
        let newRequested = startRequest;
        let demoRequested = args.trim() === 'demo';
        let reportPath: string | undefined;
        // Elapsed time with the dialogue visible plus its verdict form, including time spent idle.
        const reviewTimes = new Map<string, number>();
        let notice: BoardOptions['notice'];
        const inform = (message: string, kind: 'success' | 'info' | 'error' = 'success') => {
          notice = { message: safeText(message), kind };
        };
        while (true) {
          const record = id ? await lab.get(id) : undefined;
          const bundle = record ? await evidenceBundle(record, lab.store, beforeId) : undefined;
          const action: BoardAction = demoRequested ? { type: 'demo' } : newRequested ? { type: 'new' } : await showBoard(ctx, record
            ? { record, section, selected, query, pendingOnly, comparison: bundle?.comparison, before: bundle?.before, notice, reportPath, reviewTimes,
                warnings: bundle?.warnings, view: bundle?.view, load: async () => evidenceBundle(await lab.get(record.id), lab.store, beforeId) }
            : { records: await lab.list(), notice, warnings: lab.store.diagnostics.map(d => `${d.id}: ${d.message}`) });
          notice = undefined;
          if ('record' in action && (action.record.updatedAt !== record?.updatedAt || action.record.phase !== record?.phase)) reportPath = undefined;
          if (action.type === 'demo') {
            demoRequested = false;
            try {
              const draft = await lab.create(demoEvaluationInput());
              await lab.waitForIdle();
              id = draft.id; section = 'cards'; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined;
              inform('Учебный пример: агенту не хватает инструмента изменения записи. r — найти провал. Модель и провайдер не нужны.');
            } catch (error) { inform(inputError(error), 'error'); }
            continue;
          }
          if (action.type === 'new') {
            const request = newRequested && args.trim() !== 'new' ? `Проверь агента в ${args.trim()}`
              : await ctx.ui.editor('Папка агента и что проверить · своими словами', '');
            newRequested = false;
            if (!request?.trim()) continue;
            handoff = { request, context: { task: 'Prepare a new Agent Lab draft. Ask once for optional real dialogue logs or an explicit choice to start without them; honor the answer already given in this conversation. Read the authorized local agent project and relevant materials; infer or prepare its adapter. Use agent_lab_build, then explain the proposed user scenarios in plain language. Explain the first test and use agent_lab_run when the user asked to check the agent. Do not claim human review. Follow the agent-builder skill.' } };
            break;
          }
          if (action.type === 'open') { id = action.id; section = undefined; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined; continue; }
          if (action.type === 'close' || action.type === 'back') {
            const latest = id ? await lab.get(id) : undefined;
            if (latest && activePhases.has(latest.phase)) {
              if (!await ctx.ui.confirm('Остановить диалоги и выйти?', 'Текущий запуск будет остановлен. Уже записанные доказательства сохранятся.')) continue;
              await lab.cancel(latest.id); await lab.waitForIdle();
            }
            if (action.type === 'close') break;
            id = undefined; section = undefined; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined; continue;
          }
          section = action.section; selected = action.selected;
          query = action.query ?? ''; pendingOnly = action.pendingOnly ?? false;
          try {
            if (action.type === 'discuss') {
              const r = action.record;
              const request = await ctx.ui.editor(r.phase === 'review' ? 'Что изменить или уточнить? · обычными словами' : 'Что разобрать вместе с Pi?',
                r.phase === 'review' ? '' : 'Объясни, что сломалось, на каких репликах это видно и что делать дальше.');
              if (!request?.trim()) continue;
              const discussionBundle = action.trialId ? await evidenceBundle(r, lab.store, beforeId) : undefined;
              const comparedPair = discussionBundle?.comparison?.pairs.find(pair => pair.afterTrialId === action.trialId);
              handoff = { request, context: { experimentId: r.id, phase: r.phase,
                scenarioId: action.section === 'cards' ? r.scenarios[action.selected]?.id : undefined, trialId: action.trialId,
                ...(comparedPair ? { comparisonSource: discussionBundle?.comparisonSource, comparedPair } : {}),
                task: 'This user request concerns the selected Agent Lab experiment. Inspect fresh evidence with agent_lab_inspect. For draft corrections, use agent_lab_edit with the current hash and summarize changes. For unresolved business questions or a preparation error, read the original evidence file and prepare a new draft with the supplied corrections; preserve the old one. For results, inspect actual trial traces and report the failure, cited trial/event IDs, whether a human confirmed it, and a concrete next step. Distinguish facts from suspected causes. Never overwrite measured results or invent human verdicts. Use agent_lab_run for requested execution with native plan confirmation. Do not alter the external agent without an explicit request to fix it.' } };
              break;
            } else if (action.type === 'repeat') {
              const scenarioId = action.section === 'results' ? action.record.trials.find(t => t.id === action.trialId)?.scenarioId : undefined;
              const next = await lab.repeat(action.record.id, scenarioId ? [scenarioId] : undefined);
              beforeId = action.record.id; id = next.id; section = 'agent'; selected = 0; query = ''; pendingOnly = false; reportPath = undefined;
            } else if (action.type === 'run') {
              const r = action.record;
              if (r.workflow !== 'evaluate') throw new Error('Legacy comparison records cannot run from the evaluation board.');
              const hash = draftHash(r);
              // UI-D-02: an unconfirmed draft confirms every expectation and starts in one dialog.
              const confirmed = r.acceptedDraftHash === hash;
              const plan = confirmed ? runPlan(r) : `${runPlan(r)}\nДа — подтвердить все ожидания и начать прогон.`;
              if (await ctx.ui.confirm(confirmed ? 'Запустить проверку?' : 'Подтвердить ожидания и запустить?', plan)) {
                if (!confirmed) await lab.acceptDraft(r.id, hash);
                await lab.start(r.id, { approved: true, reviewer: 'expectations', expectedHash: hash, parallel: runParallel(r), requireAccepted: true });
                section = 'results'; selected = 0;
                reportPath = undefined;
              }
            } else if (action.type === 'expect') {
              // TRUST-11 (CTX-20): the expectation text exists only if the owner typed it into the native editor.
              const r = await lab.get(action.record.id);
              const scenario = r.scenarios.find(item => item.id === action.scenarioId);
              if (!scenario) throw new Error('Такой ситуации в черновике уже нет. Проверьте ожидания ещё раз.');
              section = 'cards';
              const written = await ctx.ui.editor('Что агент должен сделать в этой ситуации? Своими словами.', scenario.successCriteria ?? '');
              if (written === undefined) continue;
              const text = written.trim();
              if (!text || text === (scenario.successCriteria ?? '').trim()) { inform('Ожидание не изменено.', 'info'); continue; }
              if (text.length > 3000) { inform('Ожидание длиннее 3000 знаков. Сократите и попробуйте снова.', 'error'); continue; }
              await lab.setExpectation(r.id, draftHash(r), action.scenarioId, written);
              inform(`Ожидание изменено: «${safeText(scenario.title)}». Подтвердите ожидания снова: y.`);
            } else if (action.type === 'accept') {
              // TRUST-10: one key confirms every expectation of the shown draft version, and only that version.
              const r = await lab.get(action.record.id);
              const sheet = expectationSheet(r);
              if (r.acceptedDraftHash === sheet.draftHash) inform('Ожидания уже подтверждены. r — запуск.', 'info');
              else {
                await lab.acceptDraft(r.id, sheet.draftHash);
                inform(`Ожидания подтверждены: ${sheet.countText}. r — запуск.`);
              }
              section = 'cards';
            } else if (action.type === 'cancel') {
              await lab.cancel(action.record.id); await lab.waitForIdle();
              reportPath = undefined;
            } else if (action.type === 'agree') {
              // CTX-18: a mark exists only because the owner pressed a key here, and a disagreement
              // only because they typed a reason into the native editor. No tool writes one.
              const before = await lab.get(action.record.id);
              const current = judgeAgreement(before).marks.find(m => m.trialId === action.trialId && !m.stale);
              const card = before.scenarios.find(s => s.id === before.trials.find(t => t.id === action.trialId)?.scenarioId);
              const title = card?.title ?? '';
              // CTX-15: one key answers every metric that decided the situation, goal first (markTargets).
              const ids = action.metricIds;
              const failed = action.judgeVerdict === 'fail';
              const started = performance.now();
              let disagreeIds = ids;
              let note: string;
              if (action.answer === 'disagree') {
                // CTX-16/CTX-25: only a disagreement moves the number, so only «не согласен» on two
                // metrics asks which half the owner disputes; Esc saves nothing and says nothing.
                if (ids.length > 1) {
                  const options = failed
                    ? ['Запрос выполнен — судья ошибся', 'Правила промпта соблюдены — судья ошибся', 'С обоими: запрос выполнен и правила соблюдены']
                    : ['Запрос не выполнен — судья ошибся', 'Правила промпта нарушены — судья ошибся', 'С обоими: запрос не выполнен и правила нарушены'];
                  const picked = await ctx.ui.select('С чем вы не согласны?', options);
                  if (picked === undefined) continue;
                  disagreeIds = picked === options[0] ? [ids[0]!] : picked === options[1] ? [ids[1]!] : ids;
                }
                // UI-D-28: `n` always opens the editor, prefilled with the reason already given, so
                // the same key edits a reason; the duplicate check runs only after it closes.
                const reason = await ctx.ui.editor(`Судья решил: ${failed ? 'не справился' : 'справился'}. Почему вы не согласны? Коротко, своими словами.`,
                  current?.answer === 'disagree' ? current.note : '');
                if (reason === undefined) continue;
                // Input validation, not display: the schema caps a stored reason at 3000 characters,
                // so the owner is told to shorten it instead of losing the text to a write error.
                if (!reason.trim()) { inform('Несогласие не сохранено: напишите причину.', 'error'); continue; }
                if (reason.length > 3000) { inform('Причина длиннее 3000 знаков. Сократите и попробуйте снова.', 'error'); continue; }
                // The same disputed half with the same reason is already the current mark: nothing is written.
                const disputed = current?.answer === 'disagree' ? current.targets.filter(t => t.answer === 'disagree').map(t => t.metricId).join(' ') : undefined;
                if (current && disputed === disagreeIds.join(' ') && reason.trim() === current.note.trim()) { inform('Отметка уже стоит: не согласен.', 'info'); continue; }
                note = reason;
              } else {
                // UI-D-19: the same answer again on every target writes nothing, so the record keeps one mark per answer (CTX-17).
                if (current && current.targets.every(t => t.answer === action.answer)) { inform(`Отметка уже стоит: ${action.answer === 'agree' ? 'согласен' : 'не могу сказать'}.`, 'info'); continue; }
                note = action.answer === 'agree' ? 'Быстрая отметка: согласен с судьёй.' : 'Быстрая отметка: не могу сказать.';
              }
              // CTX-05: reading time on the board plus the time the answer itself took, recorded once.
              const durationMs = Math.min(3600000, Math.round((action.reviewMs ?? 0) + performance.now() - started));
              for (const [i, metricId] of ids.entries()) {
                // CTX-04: согласен — вердикт судьи, не согласен — противоположный, не могу сказать — сомнение.
                // Disputing one half of a double failure means agreeing with the other half (RESEARCH A6).
                const disputes = action.answer === 'disagree' && disagreeIds.includes(metricId);
                const verdict = action.answer === 'unsure' ? 'unknown' as const : disputes ? (failed ? 'pass' as const : 'fail' as const) : action.judgeVerdict;
                // The lab stamps the counting rule and the judge snapshot itself; the request never names them.
                await lab.addHumanReview(action.record.id, {
                  trialId: action.trialId, metricId, source: 'quick', verdict, judgeVerdict: action.judgeVerdict,
                  note: action.answer === 'disagree' && !disputes ? 'Быстрая отметка: согласен с судьёй.' : note,
                  ...(i === 0 ? { durationMs } : {}),
                });
              }
              reviewTimes.delete(`${action.record.id}|${action.trialId}`);
              reportPath = undefined;
              const afterRecord = await lab.get(action.record.id);
              const after = judgeAgreement(afterRecord);
              // C-98: a mark on a finished run reopens the review, and the notice says so.
              const reopened = before.phase === 'complete' ? ' Разбор снова открыт: f — завершить.' : '';
              const progress = after.queueFailures.length
                ? `Проверено провалов: ${after.failures.checked} из ${after.queueFailures.length}.`
                : `Проверено успехов: ${after.sampleChecked} из ${after.sampledPasses.length}.`;
              // CR-02 notice: «Итог пересчитан» only when the situation's headline verdict moved;
              // otherwise the notice names what still fails, so the number is never claimed to have changed.
              const disagreed = () => {
                const was = card ? cardVerdict(before, card).outcome : undefined;
                const now = card ? cardVerdict(afterRecord, card).outcome : undefined;
                if (card && now !== was) return `Отмечено: не согласен · «${title}». Итог пересчитан с учётом вашей отметки.`;
                if (!card || now !== 'fail') return `Отмечено: не согласен · «${title}». Итог не изменился.`;
                const parts = headlineCardOutcome(afterRecord, card);
                const what = parts.goal === 'fail' && parts.rules === 'fail' ? 'запрос не выполнен, нарушены правила промпта'
                  : parts.goal === 'fail' ? 'запрос не выполнен'
                  : parts.rules === 'fail' ? 'нарушены правила промпта'
                  : 'остальные провалы — через v';
                return `Отмечено: не согласен · «${title}». Ситуация остаётся «не справился»: ${what}.`;
              };
              inform(action.answer === 'agree' ? `Отмечено: согласен с судьёй · «${title}». ${progress}${reopened}`
                : action.answer === 'disagree' ? `${disagreed()}${reopened}`
                : `Отмечено: не могу сказать · «${title}». В итоге остаётся оценка судьи; чтобы закрыть ситуацию, позже нажмите y или n.${reopened}`);
            } else if (action.type === 'annotate') {
              const index = action.trialId ? reviewOrder(action.record).findIndex(t => t.id === action.trialId) : action.selected;
              const reviews = await humanAnnotation(ctx, action.record, index, action.reviewMs, reviewTimes);
              if (reviews) { for (const review of reviews) { await lab.addHumanReview(action.record.id, review); reviewTimes.delete(`${action.record.id}|${review.trialId}`); } reportPath = undefined; }
            } else if (action.type === 'finalize') {
              const r = action.record;
              const pending = awaitingVerdict(r).size;
              if (pending) {
                section = 'results'; pendingOnly = true; selected = 0; query = '';
                inform(`Не разобрано ситуаций: ${pending}. y / n — согласие с судьёй · v — подробная оценка.`, 'error');
                continue;
              }
              const hash = resultHash(r);
              const invalid = r.trials.filter(t => t.outcome === 'invalid' || t.outcome === 'cancelled').length;
              const ungraded = r.trials.filter(t => t.outcome === 'ungraded').length;
              if (await ctx.ui.confirm('Завершить человеческий аудит?', `Я проверил диалоги, основания оценок и поведение симуляторов.\nДиалогов: ${r.trials.length}; невалидных/остановленных: ${invalid}; без объективной оценки: ${ungraded}.\nОтдельных заметок человека: ${r.humanReviews?.length ?? 0}. ${r.mode === 'demo' ? 'Сценарные оценки демо останутся отдельными от моих.' : 'Оценки модели останутся отдельными от моих.'}\nОтметка согласия ставится на оценки, из-за которых ситуация решена: запрос и правила промпта; остальные критерии — через v.\nВерсия результатов: ${hash}\nПодтвердить проверку всего набора?`)) {
                const reviewed = await lab.reviewResults(r.id, hash);
                section = 'agent'; selected = 0; query = ''; pendingOnly = false;
                const artifacts = await exportArtifacts(await evidenceBundle(reviewed, lab.store, beforeId), lab.store.directory);
                reportPath = artifacts.htmlReport;
                inform('Разбор завершён. HTML-отчёт сохранён. o — открыть отчёт.');
              }
            } else if (action.type === 'export') {
              const artifacts = await exportArtifacts(await evidenceBundle(action.record, lab.store, beforeId), lab.store.directory);
              reportPath = artifacts.htmlReport;
              inform('HTML, Markdown и снимок доказательств сохранены. o — открыть отчёт.');
              ctx.ui.notify(safeText(`Отчёт: ${artifacts.htmlReport}\nMarkdown: ${artifacts.report}\nДоказательства: ${artifacts.evidence}`), 'info');
            } else if (action.type === 'openReport' && reportPath) {
              const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
              const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', reportPath] : [reportPath];
              await promisify(execFile)(command, args, { timeout: 10000 });
              inform('Отчёт открыт в браузере.');
            }
          } catch (error) {
            // A start refused for stale expectations names the key that fixes it (UI-SPEC Board flow 4).
            const message = inputError(error);
            inform(message.startsWith('Сначала подтвердите ожидания ситуаций') ? `${message} y — подтвердить.` : message, 'error');
          }
        }
      } finally { await close(); }
      if (handoff) {
        pi.sendMessage({ customType: 'agent-lab-context', content: JSON.stringify(handoff.context), display: false }, { deliverAs: 'followUp' });
        pi.sendUserMessage(handoff.request, { deliverAs: 'followUp', expandPromptTemplates: false });
      }
    },
  });
  pi.on('session_shutdown', async () => { await activeClose?.(); });
}
