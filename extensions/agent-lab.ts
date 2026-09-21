import {generatorConfigSchema} from '../dist/generator-corpus.js';
import {generatorSummary, selectNextVariants, generatorSelectionSchema} from '../dist/generator-evaluation.js';
import {generatorRequestSchema} from '../dist/generator-service.js';
import { resolutionRequestSchema } from '../dist/resolution.js';
import { compactIssues, compactDiagnostic, resolutionText, resolutionRunText, compactResolution, compactFixBundle } from '../dist/issue-view.js';
import { showIssueWorkspace } from './issues.ts';
import { diagnosticPreparationSchema } from '../dist/diagnostics.js';
import { issueDecisionSchema } from '../dist/issues.js';
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
import { markTargets } from '../dist/outcomes.js';
import { discoveryBrief, expectationSheet, qualityLines, qualitySummary, scoreBrief, testPlanLines, trialProofLines, type ScoreBrief } from '../dist/quality.js';
import { demoEvaluationInput, demoInput } from '../dist/demo.js';
import { evidenceBundle, exportArtifacts } from '../dist/artifacts.js';
import { agreementSectionLines, allFailuresPointer, buildResultView, causeSection, resultViewLines, SECTION_TEXT, type ResultView } from '../dist/result-view.js';
import { rowsToLines } from '../dist/explain.js';
import { scoreSettings } from '../dist/normalize.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from '../dist/connection.js';
import { inspectPrompt, promptVersion, proposePrompt } from '../dist/prompt-edit.js';
import { readData, selectValidationDialogues, readDialogueImport, importDialogues } from '../dist/imports.js';
import { ExperimentStore } from '../dist/store.js';
import { libraryHash } from '../dist/scenario-library.js';
import { semanticWorkStatus } from '../dist/scenario-work.js';
import { libraryPatchSchema } from '../dist/scenario-contracts.js';
import { activePhases, reviewOrder, safeText, showBoard, trialLines, type BoardAction, type BoardOptions, type Section } from './cards.ts';
import { scenarioErrorText, scenarioLibrarySummary } from './scenarios.ts';
import { isVerdictDetails, rememberView, renderAgentLabResult, VERDICT_KIND, type VerdictDetails } from './render/verdict-block.ts';
import { callText, isFeedDetails, rememberFeed, renderFeedResult, setFeedRestorer, type FeedDetails, type FeedRef } from './render/feed.ts';
import { ACCEPTANCE_PAGE, acceptanceLines, authorize, ownerAsked, changeRows, checkRow, comparisonFeed, deriveVariantInput, dialogueFeed, disputedCheckpoints, ownerRemarks, plainIssue, failureFeed, libraryFeed, orderedVariants, ownerBasis, ownerMessages,
  planLines, progressLines, referenceProblem, referenceQuestion, targetText, resolveFact, resolveGroup, resolveRun, resolveVariant, semanticDebt, stateRows, statusFeed, stoppedLines, variantDiff, variantFeed, variantNumber,
  type CheckOutcome, type Feed, type Resolved } from './conversation.ts';
import type { InstructionObjects } from './conversation.ts';
import type { LibraryPatch, ScenarioLibrary, ScenarioVariant } from '../dist/scenario-contracts.js';
import type { VariantOperation } from '../dist/scenario-variants.js';
import { progressLine } from './flow.ts';

/** C-119: what the model reads instead of the block, so it does not restate the number and the causes (CTX-08). */
const SHOWN_TO_OWNER = 'Блок с точностью и причинами уже показан владельцу. Не копируйте его строки. Назовите точность одной фразой и объясните по-человечески, где и почему агент хромает: что просили клиенты, что агент сделал вместо этого, какое правило владельца это нарушает; что он делает хорошо и насколько числу можно верить. Затем предложите следующий шаг.';

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
/** Every tool row says what is being done in the owner's words; arguments, JSON and hashes stay with the model. */
const displayFor = (name: string): Pick<ToolDefinition, 'renderCall' | 'renderResult'> => ({
  renderCall: (args, theme) => new Text(theme.fg('accent', safeText(callText(name, args as Record<string, unknown>))), 0, 0),
  // A feed for conversational results, the verdict block for phase-4 details, today's look for the rest (UI-SPEC B3, B4).
  renderResult: (result, options, theme, context) => context?.isError
    ? new Text(theme.fg('error', safeText(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))), 0, 0)
    : renderFeedResult(result, options, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult), () => context?.invalidate?.()),
});
const returnToBoard = (ctx: ExtensionContext, id: string) => {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  ctx.ui?.setStatus?.('agent-lab', `Agent Lab · прогон ${id.slice(0, 8)}`);
};
const inputError = (error: unknown): string => {
  const message = safeText(error instanceof Error ? error.message : error);
  return message.startsWith('This data directory is already open')
    ? 'Другая сессия выполняет проверку. Историю, диалоги и экспорт можно смотреть здесь. Изменения и новый запуск будут доступны после её завершения.'
    : message;
};

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

function runPlan(record: Experiment, cwd?: string): string {
  // One plan for the chat and the board: agent and version, the accepted set, attempts, models and limits.
  if (record.librarySnapshot?.acceptance) return [...planLines(record, cwd).map(line => safeText(line)), `Версия тестов: ${draftHash(record).slice(0, 12)}`,
    'Полные факты, источники и правила остаются в карточках сценариев.',
    record.acceptedDraftHash === draftHash(record) ? 'Принятие набора уже записано отдельно; это подтверждение запуска агента именно по этому плану.'
      : 'Состав набора принят раньше, но черновик с тех пор изменился (повтор, настройки или подключение). «Да» подтверждает те же ожидания для этого плана и запускает агента.'].join('\n');
  return [
    ...runScope(record),
    '', `Диалогов: ${plannedTrials(record)}. Режимы: ${record.settings.userModes.join(', ')}.`,
    `До ${record.settings.maxCalls} вызовов, ${Math.round(record.settings.maxDurationMs / 1000)} секунд, ${record.settings.maxTurns} ходов.`,
    record.mode === 'demo' ? 'Учебный пример: без модели и оплаты.' : `Модель: ${safeText(record.settings.provider)}/${safeText(record.settings.model)}. Стоимость зависит от фактических вызовов.`,
    ...(record.mode === 'live' ? [`Судья: ${safeText(record.settings.judge?.provider ?? record.settings.provider)}/${safeText(record.settings.judge?.model ?? record.settings.model)}; по 2 вызова в свежих сессиях на каждую применимую рубрику.`] : []),
    'Если адаптер передаёт полный RAG-контекст: ещё до 6 вызовов судьи на диалог в пределах указанного бюджета; диагностика отдельно от accuracy.',
    `Агент: ${safeText(record.target.kind === 'sandbox' ? 'Учебная песочница' : `${targetText(record)}${record.target.kind === 'command' && record.target.cwd ? ` · ${record.target.cwd}` : ''}`)}`, `Версия тестов: ${draftHash(record).slice(0, 12)}`,
    'Подтверждая, вы подтверждаете ожидания ситуаций выше. Оценки судьи вы не проверяли.',
    ...(record.acceptedDraftHash === draftHash(record) ? [] : ['Да — подтвердить все ожидания и начать прогон.']),
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
    id: record.id, runKind: record.runKind ?? 'evaluation', phase: record.phase, mode: record.mode, workflow: record.workflow,
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

/**
 * What the model is told about the conversation. The four stages stay the product logic; they are
 * no longer a route through four screens, and no answer may be a list of keys to press.
 */
const LAB_PROMPT = `
You are Agent Lab, a conversational tool for measuring the user's real agent. The owner works with you the way they work with a coding agent: they say what they want in plain words, you do the work with the Agent Lab tools, show a short result and continue in the same conversation. Work in their project and follow the agent-builder skill.

How to talk:
- Act, do not instruct. Never answer with navigation or keys to press. /agent-lab is an optional board for bulk work; never send the owner there to get something done.
- The primary validation flow is Логи → Сценарии → Прогон → Результаты. It is the logic of the product, not a route through screens: do the step the owner asked for, in any order that is valid.
- Every tool result is already shown to the owner as a short card whose details expand in place. Never re-list its cards, dialogue lines, numbers or plan. Your reply is the conclusion and the next useful step, one to three sentences in the owner's language, without ids, hashes or JSON.
- Name runs, cards, groups and failures the way the owner does: by title or list number. The tools accept such references. When a tool answers that a reference is ambiguous or unknown, ask the owner which one they mean; never pick for them.
- Use what the request and the card already contain. Ask only for a business decision you cannot find there; never invent a rule, a fact value or an expected result to complete a call.
- The first accuracy number matters more than a perfect set. Right after preparation, when at least one card is ready, offer to accept and run the ready ones at once and to settle the disputed ones afterwards. A checker's open question the owner answers with «да, это моё правило» is settled with operation resolve (their native decision), not by rewriting the card.
- When you do not know what exists in this project, call agent_lab_status first.
- A card that waits for a decision needs one plain question to the owner that would settle it (the tool gives the checker's remarks in plain words as issuesInPlainWords); do not retell the checker.
- Several changes asked for in one message: make them all, with verify:"later" on every edit but the last.

Logs and scenarios: use agent_lab_build mode=validate to import de-identified dialogues, then agent_lab_scenarios to show grouped variants, source quotes and indexes, lineage, pending sources, origin readiness and semantic readiness. agent_lab_scenarios operations: show (the draft, one card, source:true for the source dialogue), edit (change the opening, goal, expectation, rule or a fact of one card), variant (kind missing_fact, reveal_on_request, ambiguous_opening, changed_intent or tool_failure; the tool takes the fact, the opening without its value and the conditions from the parent card), merge, split, remove, assess, accept, budget. A draft edit is recorded under the owner's own message, which the tool reads from the session itself; pass ownerQuote with their exact words when an earlier message asked for the change. A change is carried out only when the owner's own message asks for that operation; a mention, a quoted log line, a prohibition or a request they took back is not an instruction, and the tool then asks the owner natively. What the client knew beforehand and any fact recorded in the owner's name is always the owner's native decision. Fact values and expectations must come from the owner's words: when the tool answers needs_owner_input, put its question to the owner; never fabricate owner facts from model text. A rule the checker calls inapplicable to a card (disputedChecks) is removed with change:{field:"rule", rule:"…" or "disputed", remove:true} or rewritten with value and applicability, when the owner agrees; a card keeps at least one rule. An edit asked for after a run goes into a fresh draft of the same set by itself — the finished run never changes; say so in one phrase and keep working on the draft. After a change the tool rechecks meaning itself within the agreed call limit: a fast recheck is in the same result, a long one continues in the background while the conversation goes on and reports back as a message — never wait for it or poll. Semantic reassessment resumes semantic jobs only; it does not process pending sources. When it reports needs_budget, show its call estimate and ask before operation budget: a deliberate settings.maxCalls increase is required when the remaining cumulative budget is insufficient; never reset usage. Use recorded user facts with a reactive simulator, and exclude masked-only turns and unavailable customer-data cases with explicit reasons.

Acceptance and run are two separate owner decisions. The owner selects ready variants and accepts one immutable accepted revision in a native confirmation; acceptance does not run the agent. Never accept a set the owner has not seen in this conversation, and never start a run because a card was opened. agent_lab_run shows a compact plan in its own native confirmation: agent and version, accepted revision and selected count, planned dialogues, models and remaining cumulative budget; full expectations remain in the cards. Always tell apart the draft, the accepted set and the running snapshot: a draft edit drops acceptance and never changes a running or a past run.

A long run continues in the background: the conversation stays free, progress above the input comes from stored data, and the result arrives as a message. Esc interrupts your current action, not the run; stop a run only when the owner asks, with agent_lab_run action:"stop", then say what was saved and that a repeat runs every attempt again. A long preparation of scenarios (agent_lab_build) is handed over the same way: the scenarios arrive as a message, so never wait for it or poll; agent_lab_run action:"progress" and action:"stop" work for it too, and stopping it keeps the partial draft.

Results: after separate native execution confirmation, lead with one estimated card accuracy number on the accepted set, grounded failure causes, separate metrics and limits, and keep measured and unmeasured counts visible; save the suite when useful. When a run ends, the block already shows the accuracy and each main cause with what was expected, what the agent said and the owner rule. Close the run yourself in three to five plain sentences: the accuracy number, where the agent limps and why (the pattern across failures: what clients asked, what the agent did instead, which owner rule that breaks), what it handles well, and how far the number can be trusted. Do not copy the block's rows. agent_lab_agree records the owner's own agreement or disagreement with the judge about one situation (the owner answers in a native dialog; you never supply the answer) — offer it after showing a failure, because it is what makes the number trustworthy. agent_lab_inspect failure:N opens a failure with its dialogue, expectation and owner rule; dialogue opens any recorded dialogue; compare:true compares a repeat with its source run. «Повтори этот случай на новой версии и сравни» is agent_lab_repeat with the cards by title or number, then agent_lab_run, then agent_lab_inspect compare:true. This is accuracy on the validation set, never a calibrated production guarantee.

To mine one new regression test, call agent_lab_build mode=discover. Discovery selects evidence, proposes one saved hypothesis and ends with literal Проверим?. It is selection, not an accuracy estimate. Show that saved brief exactly; do not reconstruct or paraphrase it. If the owner answers yes, call mode=discover again with the exact fromRunId and hypothesis; it re-reads the saved evidence and builds exactly one editable test. A refusal or correction builds nothing. Use agent_lab_accept for this supplemental one-test flow: show what the agent must do, and let the owner confirm or correct it in their own words. agent_lab_run asks to confirm expectations first when they are not confirmed. Execution consent remains separate from accepting a test and from reviewing results. Preserve budgets and model, cite actual event IDs, never invent a human verdict, and do not modify an external agent unless the user asked to fix it.`;

/** A schema error in the owner's language: which field and what is wrong, never a raw issue dump. */
function plainInputError(error: unknown): Error {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error : new Error(String(error));
  return new Error(`Не удалось подготовить проверку: ${error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || 'вход'} — ${issue.message}`).join('; ')}. Ничего не запущено и не потрачено.`);
}
/** People and models name files relative to the project; the stored target keeps absolute paths. */
function projectTarget(target: unknown, cwd: string): unknown {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
  const fixed: Record<string, unknown> = { ...target as Record<string, unknown> };
  for (const key of ['path', 'promptFile', 'cwd']) if (typeof fixed[key] === 'string' && fixed[key]) fixed[key] = resolve(cwd, fixed[key] as string);
  return fixed;
}

/** How long a run, a semantic recheck and a preparation stay in the row of their own tool call before they continue in the background. */
export interface AgentLabOptions { inlineRunMs?: number; inlineCheckMs?: number; inlineBuildMs?: number }
/** A card field as the owner reads it in the native question about a change. */
const DIFF_FIELD: Record<string, string> = { opening: 'первая реплика', goal: 'цель клиента', expectation: 'ожидаемый результат', rule: 'правило проверки', fact: 'факт' };
const RUN_MESSAGE = 'agent-lab-run';
const CHECK_MESSAGE = 'agent-lab-check';
const BUILD_MESSAGE = 'agent-lab-build';
/** Custom session entry that keeps a shown list (ids only) across a restart of Pi. */
const SHOWN_ENTRY = 'agent-lab-shown';
/** The work this session owns after its row ended. One slot: a run and a preparation hold the same writer lock, so they never coexist. */
type Job = { kind: 'run' | 'preparation'; directory: string; id: string; lab: ExperimentLab; done: Promise<void>; origin: 'board' | 'chat'; quiet?: boolean };
/** What a finished preparation answers with: the model JSON and, for a prepared library, the feed of its scenarios. */
type Prepared = { output: Record<string, unknown>; feed?: Feed; note?: string };
/** After a stopped preparation: what the partial draft holds. Counts only — the same lines go into the session file. */
const preparationStoppedLines = (record: Experiment): string[] => {
  const variants = record.librarySnapshot?.variants ?? [];
  return [`Подготовка ${record.id.slice(0, 8)} ${record.error ? 'остановлена' : 'успела завершиться до остановки'}.`, variants.length
    ? `Сохранён черновик: карточек ${variants.length}, из них готовых ${variants.filter(variant => variant.quality === 'ready').length}. Их можно смотреть, править и принимать.`
    : `Карточки собрать не успели. Запись сохранена: требований ${record.requirements.length}, вызовов модели ${record.usage.calls}.`];
};
/** A request the owner has to settle: nothing was written, and the feed shows the question instead of an error. */
type OwnerQuestion = { status: 'ambiguous_reference' | 'unknown_reference' | 'needs_owner_input' | 'declined'; options: string[]; ownerText?: string };
/** `message` instructs the model; `ownerText` is what the owner reads in the feed when the two differ. */
const needsOwner = (status: OwnerQuestion['status'], message: string, options: string[] = [], ownerText?: string): Error => Object.assign(new Error(message), { needsOwner: { status, options, ownerText } });
const ownerQuestion = (error: unknown): OwnerQuestion | undefined => error instanceof Error ? (error as Error & { needsOwner?: OwnerQuestion }).needsOwner : undefined;
const row = (text: string, tone?: Feed['rows'][number]['tone'], bold = false, indent = 0) => ({ text, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}), ...(indent ? { indent } : {}) });
const shortRun = (id: string): string => id.slice(0, 8);

/** Conversational execution asks the human to authorize a concrete plan; it never invents human reviews. */
export default function agentLab(pi: ExtensionAPI, options: AgentLabOptions = {}) {
  const inlineRunMs = options.inlineRunMs ?? 20_000;
  /** A recheck that finishes this fast is reported in the row of the edit; a longer one reports back as a message. */
  const inlineCheckMs = options.inlineCheckMs ?? 3_000;
  const inlineBuildMs = options.inlineBuildMs ?? 5_000;
  let activeClose: (() => Promise<void>) | undefined;
  let boardRun: Job | undefined;
  /** The run this conversation last worked on, per data directory. A default for «запусти», never a store of its own. */
  const focus = new Map<string, string>();
  /** The library hash the model was last shown, per run: a chat edit applies to the state the model saw (CAS), without the model carrying hashes. */
  /** Lists as they were last shown, so «второй прогон» and «второй провал» mean the second row the owner saw, not the second row of a fresh query. */
  const shownRuns = new Map<string, string[]>();
  const shownFailures = new Map<string, string[]>();
  /**
   * A shown list is also written into the session (ids only, REV-01), so «второй прогон» keeps meaning the row the owner saw
   * after Pi is reopened. The same list shown again is not written twice.
   */
  const rememberShown = (kind: 'runs' | 'failures', key: string, ids: string[]): void => {
    const lists = kind === 'runs' ? shownRuns : shownFailures;
    const known = lists.get(key);
    lists.set(key, ids);
    if (known && known.length === ids.length && known.every((id, index) => id === ids[index])) return;
    try { pi.appendEntry?.(SHOWN_ENTRY, { kind, key, ids }); } catch { /* a session that cannot be written still works from memory */ }
  };
  /** The list as last shown: from memory, otherwise from the newest entry of the reopened session. */
  const recallShown = (ctx: { sessionManager?: { getEntries?: () => unknown[] } } | undefined, kind: 'runs' | 'failures', key: string): string[] | undefined => {
    const lists = kind === 'runs' ? shownRuns : shownFailures;
    if (lists.has(key)) return lists.get(key);
    let entries: unknown[];
    try { entries = ctx?.sessionManager?.getEntries?.() ?? []; } catch { return undefined; }
    const stored = entries.flatMap(entry => {
      const item = entry as { type?: string; customType?: string; data?: { kind?: unknown; key?: unknown; ids?: unknown } } | null;
      const ids = item?.type === 'custom' && item.customType === SHOWN_ENTRY && item.data?.kind === kind && item.data.key === key ? item.data.ids : undefined;
      return Array.isArray(ids) && ids.every(id => typeof id === 'string') ? [ids as string[]] : [];
    }).at(-1);
    if (stored) lists.set(key, stored);
    return stored;
  };
  /** The card last shown or changed, per library: the only card «её», «там» or «эту» in the owner's next message can mean. Memory only — after a restart the owner is asked. */
  const lastCard = new Map<string, string>();
  const seenLibrary = new Map<string, string>();
  /** When each of those states was shown: redirected to another record of the same library, an edit applies to whichever view is the newer one. */
  const seenTick = new Map<string, number>();
  let seenClock = 0;
  const markSeen = (key: string, hash: string): void => { seenLibrary.set(key, hash); seenTick.set(key, ++seenClock); };
  /**
   * A semantic recheck that outlived its row. It holds the writer lock, so the next writer decides
   * its fate: a new edit cancels it (finished receipts stay, the recheck restarts after the edit),
   * an acceptance or a run waits for it.
   */
  let activeCheck: { directory: string; id: string; lab: ExperimentLab; done: Promise<void>; cancelled: boolean } | undefined;
  const settleCheck = async (directory: string, mode: 'cancel' | 'wait'): Promise<void> => {
    const check = activeCheck;
    if (!check || check.directory !== directory) return;
    if (mode === 'cancel') { check.cancelled = true; await check.lab.cancel(check.id).catch(() => {}); }
    await check.done;
  };
  const open = async (cwd: string, pendingCheck: 'cancel' | 'wait' = 'cancel') => {
    await settleCheck(resolve(cwd, '.agent-lab'), pendingCheck);
    if (activeClose) throw new Error(boardRun?.kind === 'preparation'
      ? `Сейчас идёт подготовка сценариев ${shortRun(boardRun.id)}. Готовые сценарии, диалоги и результаты можно смотреть; правки и новый запуск — после её завершения или остановки.`
      : boardRun
      ? `Сейчас идёт прогон ${shortRun(boardRun.id)}. Сценарии, диалоги и результаты можно смотреть; правки и новый запуск — после его завершения или остановки.`
      : 'Уже идёт другая операция Agent Lab. Историю и готовые результаты можно открыть; новый запуск — после её завершения.');
    const lab = new ExperimentLab(resolve(cwd, '.agent-lab'));
    let closing: Promise<void> | undefined;
    const close = () => closing ??= lab.close().finally(() => { if (activeClose === close) activeClose = undefined; });
    activeClose = close;
    return { lab, close };
  };
  /** Reads never take the writer lock; a run owned by this session is read through its own lab. */
  const reading = (directory: string): ExperimentLab => boardRun?.directory === directory ? boardRun.lab : new ExperimentLab(directory);
  const runName = (record: Experiment): string => `${shortRun(record.id)} «${safeText(record.task).slice(0, 60)}»`;
  /** The run a request means: an id, a short id, task words, or — with no reference — the run this conversation works on. Never a silent guess among several. */
  const findRun = async (directory: string, ref?: string, ctx?: Parameters<typeof recallShown>[0]): Promise<Experiment> => {
    const reader = reading(directory);
    const wanted = ref?.trim();
    if (wanted && /^[a-zA-Z0-9_-]{1,80}$/.test(wanted)) { try { return await reader.get(wanted); } catch { /* a short id or task words: look through the list */ } }
    const stored = await reader.list();
    // Numbers resolve against the list the owner was shown; without one, against the same newest-first order the list uses.
    const shown = recallShown(ctx, 'runs', directory) ?? [];
    const rank = (record: Experiment): number => { const at = shown.indexOf(record.id); return at < 0 ? shown.length : at; };
    const records = [...stored].sort((x, y) => rank(x) - rank(y) || y.updatedAt.localeCompare(x.updatedAt));
    if (wanted) {
      const resolved: Resolved<Experiment> = resolveRun(records, wanted);
      if (resolved.kind === 'one') return resolved.item;
      throw needsOwner(resolved.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference',
        referenceProblem('Прогон', wanted, resolved, (resolved.kind === 'many' ? resolved.items : records).map(runName)));
    }
    const focused = records.find(record => record.id === focus.get(directory));
    if (focused) return focused;
    const current = records.filter(record => ['preparing', 'review', 'evaluating', 'results_review'].includes(record.phase));
    if (current.length === 1) return current[0]!;
    if (records.length === 1) return records[0]!;
    if (!records.length) throw needsOwner('unknown_reference', 'В этом проекте ещё нет прогонов. Сначала соберите сценарии: нужны агент и, если есть, логи.');
    throw needsOwner('ambiguous_reference', `Неясно, о каком прогоне речь. Спросите владельца: ${records.slice(0, 8).map(runName).join('; ')}.`, records.slice(0, 8).map(runName));
  };
  const feedResult = (callId: string, output: unknown, feed: Feed, note: string, ref?: FeedRef) =>
    ({ content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: rememberFeed(callId, feed, note, ref) });
  // A row of an earlier session, or one the cache let go, is redrawn from the immutable revisions it points at — the state it showed, not today's.
  setFeedRestorer(async ref => {
    const store = new ExperimentStore(ref.directory);
    const [record, library] = await Promise.all([store.get(ref.runId), store.readLibrary(ref.libraryId, ref.hash)]);
    const then: Experiment = { ...record, librarySnapshot: library };
    const stamp = row(`Восстановлено из сохранённой ревизии ${library.revision}.`, 'muted');
    if (ref.view === 'library') { const feed = libraryFeed(then); return { rows: [stamp, ...feed.rows.filter(item => !item.text.startsWith('Вызовы модели')), ], more: feed.more }; }
    const variant = library.variants.find(item => item.id === ref.variantId);
    if (!variant) return null;
    const card = variantFeed(then, variant);
    if (ref.view === 'card' || !ref.beforeHash) return { rows: [stamp, ...card.rows], more: card.more };
    const before = (await store.readLibrary(ref.libraryId, ref.beforeHash)).variants.find(item => item.id === ref.variantId);
    return { rows: [stamp, row(`Правка карточки «${safeText(variant.title)}»`, 'success', true), ...(before ? changeRows(variantDiff(before, variant)) : [row('Карточка появилась в этой ревизии.', 'muted', false, 1)])],
      more: [...card.rows, row(''), ...(card.more ?? [])] };
  });
  /** An owner question becomes an ordinary result: the feed shows what to clarify, the model is told not to guess. */
  const askOwner = (callId: string, error: unknown) => {
    const question = ownerQuestion(error);
    if (!question) throw error;
    const message = safeText((error as Error).message);
    return feedResult(callId, { status: question.status, mutated: false, message, options: question.options,
      instruction: 'Nothing was written. Put this question to the owner in plain words; do not pick an option or invent a value yourself.' },
      { rows: [row(safeText(question.ownerText ?? message), 'warning'), ...question.options.map(option => row(`• ${safeText(option)}`, undefined, false, 1))] }, 'Agent Lab · нужно уточнение владельца');
  };
  /** The verdict of a finished run for the model and for the feed; `details` stay ids only (REV-01). */
  const verdictOutput = async (record: Experiment, lab: ExperimentLab) => {
    const bundle = await evidenceBundle(record, lab.store);
    if (bundle.view) rememberShown('failures', record.id, bundle.view.failures.map(item => item.scenarioId));
    const output = { ...summary(record, lab.store.directory, bundle.view), proofs: record.trials.map(trial => trialProofLines(record, trial.id)),
      comparison: bundle.comparison, artifacts: await exportArtifacts(bundle, lab.store.directory), shownToOwner: SHOWN_TO_OWNER };
    let details: VerdictDetails | { id: string } = { id: record.id };
    if (bundle.view) {
      const resultKey = `${record.id}:${resultHash(record)}`;
      rememberView(resultKey, bundle.view);
      details = { kind: VERDICT_KIND, version: 1, runId: record.id, resultKey };
    }
    return { output, details };
  };
  /**
   * A started run belongs to the Pi session, not to the row or the board that started it: the
   * conversation stays free, progress comes from the stored record, and the result of a chat run
   * arrives as a message. Closing Pi still ends the work it owns. A preparation is handed over the same
   * way: `prepared` builds its answer once it has ended, from the stored record.
   */
  const detach = (ctx: ExtensionContext, directory: string, owned: Awaited<ReturnType<typeof open>>, id: string, origin: Job['origin'], prepared?: (finished: Experiment) => Promise<Prepared>): Job => {
    const job: Job = { kind: prepared ? 'preparation' : 'run', directory, id, lab: owned.lab, done: Promise.resolve(), origin };
    const widget = prepared ? BUILD_MESSAGE : RUN_MESSAGE;
    boardRun = job;
    let updates = Promise.resolve();
    let shown = '';
    const update = async () => {
      if (boardRun !== job) return;
      const record = await job.lab.get(id);
      const lines = progressLines(record).map(line => safeText(line));
      if (lines.join('\n') === shown) return;
      shown = lines.join('\n');
      ctx.ui.setStatus?.('agent-lab-progress', safeText(progressLine(record)));
      ctx.ui.setWidget?.(widget, [...lines, prepared ? 'Разговор свободен. Остановить подготовку — так и напишите; Esc её не останавливает.'
        : 'Разговор свободен. Остановить прогон — так и напишите; Esc его не останавливает.']);
    };
    const timer = setInterval(() => { updates = updates.then(update).catch(() => {}); }, 750);
    updates = updates.then(update).catch(() => {});
    job.done = (async () => {
      try {
        await owned.lab.waitForIdle();
        const finished = await owned.lab.get(id);
        returnToBoard(ctx, id);
        const complete = finished.phase === 'results_review' || finished.phase === 'complete';
        if (prepared) {
          // A stop the owner asked for is answered in its own row; every other ending reports back, a failed one as plainly as a finished one.
          if (!job.quiet) {
            const answer = await prepared(finished);
            const failed = [`Подготовка ${shortRun(id)} не завершена${finished.phase === 'cancelled' ? ': она остановлена' : ''}.`, ...(finished.error ? [safeText(finished.error)] : [])];
            pi.sendMessage({ customType: BUILD_MESSAGE, display: true, content: JSON.stringify(answer.output),
              details: answer.feed ? rememberFeed(`build:${id}:${finished.updatedAt}`, answer.feed, answer.note ?? `Сценарии прогона ${shortRun(id)}`)
                : rememberFeed(`build:${id}:${finished.updatedAt}`, { rows: finished.phase === 'review' && !finished.error ? [row('Подготовка завершена. Агент не запускался.', 'success', true), ...stateRows(finished)]
                  : failed.map((line, index) => row(line, index ? 'error' : 'warning', !index)) }, `Подготовка ${shortRun(id)}`),
            }, { deliverAs: 'followUp', triggerTurn: true });
          }
        } else if (origin === 'board') ctx.ui.notify?.(complete ? `Проверка завершена: /agent-lab ${shortRun(id)} — открыть результат.`
          : `Проверка ${shortRun(id)} остановлена. Записанные диалоги доступны в истории.`, 'info');
        else if (!job.quiet) {
          const announced = complete ? await verdictOutput(finished, owned.lab) : undefined;
          const stopped = stoppedLines(finished);
          pi.sendMessage({ customType: RUN_MESSAGE, display: true,
            content: JSON.stringify(announced?.output ?? { id, phase: finished.phase, error: finished.error, trialCount: finished.trials.length, plannedTrials: plannedTrials(finished), message: stopped.join(' ') }),
            details: announced && isVerdictDetails(announced.details) ? announced.details
              : rememberFeed(`run:${id}:${finished.updatedAt}`, { rows: [...stopped.map(line => row(line, 'warning')), ...(finished.error ? [row(safeText(finished.error), 'error')] : [])] }, `Прогон ${shortRun(id)} остановлен`),
          }, { deliverAs: 'followUp', triggerTurn: true });
        }
      } catch (error) { ctx.ui.notify?.(`Не удалось завершить ${prepared ? 'подготовку' : 'проверку'}: ${inputError(error)}`, 'error'); }
      finally {
        clearInterval(timer);
        try { await updates; ctx.ui.setStatus?.('agent-lab-progress', undefined); ctx.ui.setWidget?.(widget, undefined); }
        finally { try { await owned.close(); } finally { if (boardRun === job) boardRun = undefined; } }
      }
    })();
    // A UI or close failure must remain observable without an unhandled rejection.
    void job.done.catch(error => console.error(`Agent Lab: ${inputError(error)}`));
    return job;
  };
  /** Hash moves made by this session's own semantic rechecks: bookkeeping on top of the state the model saw, never an owner-visible change. */
  const checkMoves = new Map<string, string>();
  /**
   * A recheck too long for the row of its edit. The conversation goes on; the outcome arrives as a
   * message — silently when the card is ready, with a turn when the owner has something to decide.
   * An assessment the owner asked for (`asked`) always ends with a turn: they are waiting for its answer.
   */
  const backgroundCheck = (ctx: ExtensionContext, directory: string, id: string, owned: Awaited<ReturnType<typeof open>>, usedBefore: number, startHash: string, variantId?: string, asked = false): void => {
    const check = { directory, id, lab: owned.lab, done: Promise.resolve(), cancelled: false };
    activeCheck = check;
    let updates = Promise.resolve();
    let shown = '';
    const update = async () => {
      if (activeCheck !== check) return;
      const text = `Перепроверяю смысл изменённых карточек · вызовов модели: ${Math.max(0, (await owned.lab.get(id)).usage.calls - usedBefore)}`;
      if (text === shown) return;
      shown = text;
      ctx.ui.setWidget?.(CHECK_MESSAGE, [text, 'Можно продолжать: новая правка перезапустит проверку, уже проверенное не пропадёт.']);
    };
    const timer = setInterval(() => { updates = updates.then(update).catch(() => {}); }, 750);
    updates = updates.then(update).catch(() => {});
    check.done = (async () => {
      try {
        await owned.lab.waitForIdle();
        const { experiment, library } = await owned.lab.readLibrary(id);
        checkMoves.set(`${directory}|${id}|${startHash}`, libraryHash(library));
        if (check.cancelled) return;
        markSeen(`${directory}|${id}`, libraryHash(library));
        const variant = variantId ? library.variants.find(item => item.id === variantId) : undefined;
        const failed = experiment.phase !== 'review' || !!experiment.error;
        const outcome: CheckOutcome = failed ? { status: 'failed', message: safeText(experiment.error ?? experiment.message) }
          : { status: 'done', calls: Math.max(0, experiment.usage.calls - usedBefore) };
        const waiting = orderedVariants(library).filter(item => item.quality !== 'ready');
        const disputed = variant ? disputedCheckpoints(variant) : [];
        const card = variant ? variantFeed(experiment, variant) : undefined;
        const feed: Feed = { rows: [checkRow(outcome, variant),
          ...(variant ? ownerRemarks(variant.issues).slice(0, 3).map(item => row(`• ${safeText(plainIssue(library, variant, item))}`, 'warning', false, 1)) : []),
          ...(disputed.length ? [row(`Под вопросом проверки: ${disputed.map(item => `«${safeText(item.rule)}»`).join('; ')}. Их можно переписать или убрать — скажите как.`, 'accent', false, 1)] : []),
          row(`Готовы ${library.variants.length - waiting.length} из ${library.variants.length} карточек.`, 'muted', false, 1)],
          ...(card ? { more: [...card.rows, row(''), ...(card.more ?? [])] } : {}) };
        pi.sendMessage({ customType: CHECK_MESSAGE, display: true,
          content: JSON.stringify({ status: 'semantic_check_finished', runId: id, check: outcome, ...scenarioLibrarySummary(experiment, library.acceptance?.variantIds ?? []),
            ...(variant ? { variant: { id: variant.id, title: variant.title, quality: variant.quality, issues: variant.issues.map(item => plainIssue(library, variant, item)), disputedChecks: disputed.map(item => ({ id: item.id, rule: item.rule })) } } : {}),
            instruction: asked ? 'The semantic assessment the owner asked for finished. Tell them the outcome in one or two sentences; use this libraryHash from now on.'
              : 'The background recheck of the last edit finished. Mention it only if the owner has something to decide; use this libraryHash from now on.' }),
          details: rememberFeed(`check:${id}:${libraryHash(library)}`, feed, `Смысловая перепроверка · прогон ${shortRun(id)}`),
        }, { deliverAs: 'followUp', triggerTurn: asked || failed || (!!variant && variant.quality !== 'ready') });
      } catch (error) { ctx.ui.notify?.(`Перепроверка не завершилась: ${inputError(error)}`, 'error'); }
      finally {
        clearInterval(timer);
        try { await updates; ctx.ui.setWidget?.(CHECK_MESSAGE, undefined); }
        finally { try { await owned.close(); } finally { if (activeCheck === check) activeCheck = undefined; } }
      }
    })();
    void check.done.catch(error => console.error(`Agent Lab: ${inputError(error)}`));
  };
  // The result message of background work: the same verdict block or feed a tool row would draw.
  for (const kind of [RUN_MESSAGE, CHECK_MESSAGE, BUILD_MESSAGE]) pi.registerMessageRenderer?.(kind, (message, renderOptions, theme) => {
    const text = typeof message.content === 'string' ? message.content : '';
    const result = { content: [{ type: 'text' as const, text: isFeedDetails(message.details) ? message.details.note : text }], details: message.details };
    return renderFeedResult(result, { expanded: renderOptions.expanded, isPartial: false }, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult));
  });
  pi.registerTool({...displayFor('agent_lab_generator'),name:'agent_lab_generator',label:'Качество генератора',description:'Отдельная оценка/ограниченная оптимизация генератора. Не меняет принятые наборы и промпт агента. inspect/select не расходуют модельный бюджет.',
    parameters:Type.Object({operation:Type.Union(['evaluate','optimize','select','inspect'].map(value=>Type.Literal(value))),id:Type.Optional(Type.String()),
      request:Type.Optional(Type.Unsafe(z.toJSONSchema(generatorRequestSchema,{io:'input'}))),candidates:Type.Optional(Type.Unsafe<z.input<typeof generatorSelectionSchema.shape.candidates>>(z.toJSONSchema(generatorSelectionSchema.shape.candidates))),history:Type.Optional(Type.Unsafe<z.input<typeof generatorSelectionSchema.shape.history>>(z.toJSONSchema(generatorSelectionSchema.shape.history)))}),
    async execute(_toolCallId,params,_signal,_onUpdate,ctx){
      let result:unknown;
      if(params.operation==='select')result=selectNextVariants(params.candidates,params.history);
      else if(params.operation==='inspect'){if(!params.id)throw new Error('Укажите id записи генератора.');result=generatorSummary(await new ExperimentStore(resolve(ctx.cwd,'.agent-lab')).readGeneratorRecord(params.id));}
      else {if(!params.request)throw new Error('Нужны config и ограниченные settings.');const {lab,close}=await open(ctx.cwd);try{await lab.init();result=generatorSummary(params.operation==='evaluate'?await lab.evaluateGenerator(generatorRequestSchema.parse(params.request),{signal:_signal}):await lab.optimizeGenerator(generatorRequestSchema.parse(params.request),{signal:_signal}));}finally{await close();}}
      return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
    }});
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1' || !ctx.hasUI || ctx.mode !== 'tui') return;
    ctx.ui.setTitle(`Agent Lab · ${ctx.cwd.split('/').at(-1)}`);
    ctx.ui.setHeader((_tui, theme) => new Text(theme.bold('Agent Lab') + '\nНасколько хорош ваш агент — на карточках пользователей, с причинами провалов.\n' + safeText(ctx.cwd), 1, 1));
    ctx.ui.setWidget('agent-lab-start', ['Напишите, что нужно, обычными словами — Lab сделает это сам и покажет результат здесь же:',
      '«Посмотри агента в этой папке, вот логи: logs.jsonl, собери сценарии» · «Покажи, какие ситуации нашёл» · «Добавь случай, где клиент не знает номер» · «Прими готовые и запусти» · «Покажи второй провал» · «Повтори на новой версии и сравни».',
      'Подробности любого шага раскрываются там же, где появились. /agent-lab — необязательная доска для массовой работы · /agent-lab demo — учебный пример без модели.']);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1') return;
    ctx.ui?.setWidget?.('agent-lab-start', undefined);
    return { systemPrompt: event.systemPrompt + LAB_PROMPT };
  });
  pi.registerTool({
    ...displayFor('agent_lab_build'),
    name: 'agent_lab_build', label: 'Prepare agent and business-scenario tests',
    description: 'Prepare agent checks. mode=validate selects up to 15 measurable prompt/RAG cases from up to 300 de-identified dialogues, grounds expectations in owner requirements and gives user facts to a reactive simulator; unavailable customer data and masked-only utterances are excluded. It does not run the agent. mode=discover mines one regression hypothesis. mode=score evaluates recorded replies without running the agent. mode=demo is the built-in example.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: 120000 }), kind: Type.Optional(Type.Union([Type.Literal('knowledge'), Type.Literal('prompt')], { description: "'prompt' marks the agent's own system prompt: observable rules are extracted from it and every generated card gets the prompt_compliance rubric" })) }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      generatorConfig:Type.Optional(Type.Unsafe(z.toJSONSchema(generatorConfigSchema,{io:'input'}))),
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
      dialogues: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(z.json()).max(300), { io: 'input' }))),
      notes: Type.Optional(Type.String({ maxLength: 8000, description: "The owner's own hints about users, goals and situations, in their words. First-class input for synthetic cards; never treated as a business rule." })),
      profiles: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(ownerProfileSchema).max(6), { io: 'input' }))),
      fromRunId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$', description: 'Exact saved discovery run returned by the previous mode=discover call.' })),
      resumeRunId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$', description: 'Safely interrupted discovery run to continue after native budget confirmation. Do not combine with fromRunId or hypothesis.' })),
      hypothesis: Type.Optional(Type.String({ minLength: 1, maxLength: 3000, description: 'Exact saved hypothesis returned by the previous mode=discover call.' })),
      mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('demo'), Type.Literal('score'), Type.Literal('discover'), Type.Literal('validate')])),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const { goldenFile, dialoguesFile, connectionFile, withoutDialogues, codeOnly, fromRunId, resumeRunId, hypothesis, ...rest } = params;
      const operation = rest.mode ?? 'live';
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      if (operation !== 'discover' && (fromRunId || resumeRunId || hypothesis)) throw new Error('fromRunId, resumeRunId и hypothesis используются только с mode=discover.');
      if (resumeRunId && (fromRunId || hypothesis)) throw new Error('resumeRunId нельзя совмещать с fromRunId или hypothesis.');
      if (operation === 'discover' && fromRunId) {
        if (!hypothesis) throw new Error('После ответа владельца передайте точную сохранённую hypothesis вместе с fromRunId.');
        const { lab, close } = await open(ctx.cwd);
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
        const { lab, close } = await open(ctx.cwd);
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
      const libraryImport = !['score', 'discover', 'demo'].includes(operation) && (dialoguesFile || rest.dialogues)
        ? dialoguesFile ? await readDialogueImport(resolve(ctx.cwd, dialoguesFile)) : importDialogues(rest.dialogues) : undefined;
      try { dialogues = libraryImport ? libraryImport.dialogues.slice(0, ['discover', 'validate'].includes(operation) ? 300 : 200) : (dialoguesFile ? await readData(resolve(ctx.cwd, dialoguesFile), 'dialogues', { maxItems: ['discover', 'validate'].includes(operation) ? 300 : 200 }) : rest.dialogues); }
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
      if (operation === 'validate' && !parsedDialogues.length && !libraryImport?.originalImport.dialogues.length) throw new Error('Для validation set укажите JSON/JSONL с обезличенными реальными диалогами.');
      if (operation !== 'demo' && !parsedDialogues.length && !libraryImport?.originalImport.dialogues.length && withoutDialogues !== true) {
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
      const sourceDialogueCount = libraryImport?.originalImport.dialogues.length ?? parsedDialogues.length;
      const validationCount = operation === 'validate' ? rest.validationCount ?? 15 : 0;
      if (operation === 'validate') {
        parsedDialogues = selectValidationDialogues(parsedDialogues, Math.min(40, validationCount * 3));
        if (!parsedDialogues.length && !libraryImport?.originalImport.dialogues.length) throw new Error('В логах нет пригодных диалогов с 1–16 репликами пользователя без полностью замаскированных реплик.');
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для сборки validation set нужен native Pi confirmation в интерактивном терминале.');
      }
      if (operation === 'discover') {
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для discovery нужен native Pi confirmation в интерактивном терминале.');
        const connection = connectionFile ? await readConnection(resolve(ctx.cwd, connectionFile)) : !rest.target ? await rememberedConnection(resolve(ctx.cwd, '.agent-lab')) : undefined;
        const input = discoverInputSchema.parse({ task: rest.task, materials: rest.materials, existingAgent: rest.existingAgent,
          target: connection?.target ?? projectTarget(rest.target, ctx.cwd), targetVersion: connection?.targetVersion ?? rest.targetVersion,
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
        const { lab, close } = await open(ctx.cwd);
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
      let input: z.infer<typeof createInputSchema>;
      try { input = createInputSchema.parse({
        ...(mode === 'demo' ? demoEvaluationInput() : {}), ...rest, ...(rest.target ? { target: projectTarget(rest.target, ctx.cwd) } : {}), scenarioCount: ['score', 'validate'].includes(operation) ? 0 : rest.scenarioCount ?? (mode === 'demo' ? 3 : 1),
        ...(operation === 'validate' ? { validationCount } : {}), mode, workflow: 'evaluate',
        ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(goldenFile ? { goldenCases: await readData(resolve(ctx.cwd, goldenFile), 'golden') } : {}),
        ...(dialogues !== undefined ? { dialogues: parsedDialogues.slice(0, 200) } : {}),
        ...(libraryImport ? { originalImport: libraryImport.originalImport } : {}),
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
      }); } catch (error) { throw plainInputError(error); }
      // The spending question comes last: a request that cannot start never asks the owner for money.
      if (operation === 'validate' && !await ctx.ui.confirm('Разобрать логи и собрать сценарии?', safeText([
        `Диалогов в выгрузке: ${sourceDialogueCount}; к разбору подходят ${parsedDialogues.length}; карточек получится не больше ${Math.min(validationCount, Math.max(parsedDialogues.length, 1))}.`,
        'Один подходящий диалог — одна карточка. Диалоги без правил владельца или с недоступными данными клиента исключаются с причиной; прежние оценки не используются.',
        `Это расход на модель: не больше ${input.settings.maxCalls} вызовов и ${Math.ceil(input.settings.maxDurationMs / 60_000)} минут. Это потолок, а не прогноз: тратится только то, что понадобится на эти диалоги. Агент сейчас не запускается — запуск подтверждается отдельно.`,
      ].join('\n')))) return feedResult(callId, { status: 'cancelled', calls: 0, mutated: false, message: 'The owner declined. Nothing was spent or changed; do not ask again unless they request it.' },
        { rows: [row('Разбор логов отменён. Ничего не потрачено и не изменено.', 'warning')] }, 'Разбор логов отменён');
      const owned = await open(ctx.cwd);
      const { lab, close } = owned;
      // Only a terminal can take a preparation over: the hand-over draws its progress and delivers its result through `ctx.ui` and a message.
      const interactive = operation !== 'score' && !!ctx.hasUI && ctx.mode === 'tui' && !!ctx.ui;
      let handedOver = false;
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
        /** The answer of a preparation that has ended — in the row of this call, or as the message of one that outlived it. */
        const prepared = async (record: Experiment, interrupted: boolean): Promise<Prepared> => {
          const bundle = await evidenceBundle(record, lab.store);
          const output = { ...summary(record, lab.store.directory, bundle.view),
            ...(operation === 'validate' ? { validation: { sourceDialogues: sourceDialogueCount, candidateDialogues: parsedDialogues.length, sampledDialogues: record.scenarios.length, estimatedAccuracyAfterRun: true } } : {}),
            artifacts: await exportArtifacts(bundle, lab.store.directory), ...(interrupted ? { cancelled: true } : {}) };
          returnToBoard(ctx, record.id);
          focus.set(lab.store.directory, record.id);
          // A prepared library answers with the scenarios themselves: what was found, what is ready, what waits for the owner.
          if (!record.librarySnapshot || record.phase !== 'review') return { output };
          const library = record.librarySnapshot;
          markSeen(`${lab.store.directory}|${record.id}`, libraryHash(library));
          const feed = libraryFeed(record);
          const readyCount = library.variants.filter(variant => variant.quality === 'ready').length;
          feed.rows.unshift(row(interrupted ? 'Подготовка прервана; разобранное сохранено.' : library.imports.length ? 'Сценарии собраны из логов. Агент не запускался.' : 'Сценарии собраны по требованиям. Агент не запускался.', interrupted ? 'warning' : 'success', true),
            // The first number should not wait for every dispute: what is ready can run now.
            row(readyCount ? `Готовые карточки (${readyCount}) можно принять и запустить прямо сейчас — первая точность будет по ним; спорные разберём после.`
              : 'Готовых карточек пока нет. По каждой ниже сказано, что мешает: вопрос проверяющего можно закрыть вашим решением, и карточка станет готовой.', 'accent'));
          return { output: { ...output, ...scenarioLibrarySummary(record, library.acceptance?.variantIds ?? []),
            groups: library.businessScenarios.map((group, index) => ({ number: index + 1, id: group.id, title: group.title })),
            variants: orderedVariants(library).map((variant, index) => ({ number: index + 1, id: variant.id, title: variant.title, quality: variant.quality, provenance: variant.provenance, issueCount: variant.issues.length })) },
            feed, note: `Сценарии прогона ${shortRun(record.id)} · ревизия ${library.revision}` };
        };
        // In the terminal Esc interrupts the action, not the work: from here an abort hands the preparation over instead of cancelling it.
        if (interactive) signal.removeEventListener('abort', cancel);
        id = (await lab.create(input)).id;
        if (signal.aborted && !interactive) cancel();
        await progress();
        timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
        // A short preparation ends in this row. A long one, or Esc, goes to the session the way a long run does.
        const inline = !interactive ? (await lab.waitForIdle(), true) : await new Promise<boolean>(settle => {
          const wait = setTimeout(() => settle(false), inlineBuildMs);
          const onAbort = () => settle(false);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
          void lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(wait); signal.removeEventListener('abort', onAbort); });
        });
        if (!inline) {
          clearInterval(timer); timer = undefined; await polling;
          const record = await lab.get(id);
          handedOver = true;
          // The record ends with an error exactly when the preparation was cut short: stopped, out of calls or out of time.
          detach(ctx, lab.store.directory, owned, id, 'chat', finished => prepared(finished, !!finished.error));
          focus.set(lab.store.directory, id);
          return feedResult(callId, { id, background: true, phase: record.phase, usage: record.usage, maxCalls: record.settings.maxCalls,
            instruction: 'The preparation continues in the background and its result (the scenarios) will arrive as a message. Tell the owner in one short sentence and end your turn; do not poll. Reads still work; edits, a new preparation and runs wait until it ends. Stop it only when the owner asks: agent_lab_run action:"stop".' },
            { rows: [row('Подготовка сценариев идёт в фоне.', 'success', true), ...progressLines(record).map(line => row(safeText(line), undefined, false, 1)),
              row('Разговор свободен: готовые прогоны и сценарии можно смотреть. Собранные сценарии появятся здесь отдельным сообщением.', 'muted', false, 1),
              row('Esc прерывает только текущее действие. Чтобы остановить подготовку, так и напишите.', 'muted', false, 1)] }, `Подготовка ${shortRun(id)} идёт в фоне`);
        }
        await progress();
        const done = await prepared(await lab.get(id), signal.aborted && !interactive);
        return done.feed ? feedResult(callId, done.output, done.feed, done.note ?? '') : { content: [{ type: 'text', text: JSON.stringify(done.output, null, 2) }], details: done.output };
      } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; if (!handedOver) await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_inspect'),
    name: 'agent_lab_inspect', label: 'Read results and evidence',
    description: 'Read-only. Without options: the result of a run (or its draft) with the failure list. failure: one failed situation by its number in that list or by title — expectation, what the agent said, the owner rule and the dialogue. dialogue: any recorded dialogue by situation title or number; trialId: by exact id. compare:true compares a repeat with its source run (or compare:"<run>" with another run). export:true writes local HTML and Markdown reports and an AgentSpec snapshot. This tool never approves a draft or result. Legacy comparison control traces remain hidden until the control phase stops.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the run this conversation works on.' })),
      failure: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1, maxLength: 300 })], { description: 'Number in the failure list (1 = first) or the situation title.' })),
      dialogue: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'Situation title or number whose recorded dialogue to open.' })),
      trialId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' })),
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
        const beforeId = typeof params.compare === 'string' ? (await findRun(directory, params.compare, ctx)).id : undefined;
        const bundle = await evidenceBundle(record, lab.store, beforeId);
        const controlVisible = record.workflow === 'evaluate' || !!record.controlConsumedAt && !activePhases.has(record.phase);
        const visible = (trial: Experiment['trials'][number] | undefined) => {
          if (trial?.split === 'control' && !controlVisible) throw new Error('Control evidence stays hidden until the final control phase stops.');
          return trial;
        };
        returnToBoard(ctx, record.id);
        const note = `Результаты прогона ${shortRun(record.id)}`;
        if (params.failure !== undefined) {
          const view = bundle.view ?? buildResultView(bundle.record);
          const titles = view.failures.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
          if (!view.failures.length) return feedResult(callId, { failures: 0, notMeasured: view.notMeasured.total, message: 'No failed situation in the headline of this run.' },
            { rows: [row('В этом прогоне нет провалов по основному показателю.', 'success'), ...(view.notMeasured.total ? [row(`Не измерено ситуаций: ${view.notMeasured.total}.`, 'warning', false, 1)] : [])] }, note);
          const wanted = String(params.failure).trim();
          // A number names the row of the failure list the owner last saw; when the list has changed since, the same situation is opened.
          const remembered = recallShown(ctx, 'failures', record.id) ?? view.failures.map(item => item.scenarioId);
          rememberShown('failures', record.id, remembered);
          const numbered = /^#?\d+$/.test(wanted) ? remembered[Number(wanted.replace('#', '')) - 1] : undefined;
          const byNumber = /^#?\d+$/.test(wanted) ? view.failures.filter(item => item.scenarioId === numbered) : undefined;
          const matches = byNumber ?? view.failures.filter(item => item.title.toLocaleLowerCase('ru').includes(wanted.toLocaleLowerCase('ru')));
          if (matches.length !== 1) throw needsOwner(matches.length ? 'ambiguous_reference' : 'unknown_reference',
            matches.length ? `Провал «${wanted}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Провала «${wanted}» в списке нет: всего провалов ${view.failures.length}.`, titles);
          const index = view.failures.indexOf(matches[0]!);
          const trial = visible(bundle.record.trials.find(item => item.id === matches[0]!.trialId));
          return feedResult(callId, { failure: { number: index + 1, of: view.failures.length, title: matches[0]!.title, kind: matches[0]!.kind, lines: matches[0]!.lines }, trial },
            failureFeed(bundle.record, view, index)!, `Провал ${index + 1} из ${view.failures.length} · прогон ${shortRun(record.id)}`);
        }
        if (params.dialogue || params.trialId) {
          let trial = params.trialId ? bundle.record.trials.find(item => item.id === params.trialId) : undefined;
          if (params.trialId && !trial) throw new Error('Trial not found in this experiment.');
          if (!trial) {
            const wanted = params.dialogue!.trim().toLocaleLowerCase('ru');
            const scenarios = /^#?\d+$/.test(wanted) ? [bundle.record.scenarios[Number(wanted.replace('#', '')) - 1]].filter(item => !!item)
              : bundle.record.scenarios.filter(item => item.title.toLocaleLowerCase('ru').includes(wanted) || item.id === params.dialogue);
            const titles = bundle.record.scenarios.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
            if (scenarios.length !== 1) throw needsOwner(scenarios.length ? 'ambiguous_reference' : 'unknown_reference',
              scenarios.length ? `«${params.dialogue}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Ситуации «${params.dialogue}» в этом прогоне нет.`, titles.slice(0, 15));
            const attempts = bundle.record.trials.filter(item => item.scenarioId === scenarios[0]!.id);
            trial = attempts.find(item => item.outcome === 'fail') ?? attempts[0];
            if (!trial) throw new Error(`По ситуации «${safeText(scenarios[0]!.title)}» ещё нет записанного диалога.`);
          }
          return feedResult(callId, visible(trial), dialogueFeed(bundle.record, trial), `Диалог · прогон ${shortRun(record.id)}`);
        }
        if (params.compare) {
          if (!bundle.comparison || !bundle.comparisonSource) return feedResult(callId, { comparable: false, warnings: bundle.warnings, message: 'This run has no source run to compare with. Prepare a repeat of an earlier run, or name the run to compare with.' },
            { rows: [row('Сравнивать не с чем: у этого прогона нет исходного. Назовите прогон для сравнения или подготовьте повтор прошлого прогона.', 'warning')] }, note);
          return feedResult(callId, { comparison: bundle.comparison, comparisonSource: bundle.comparisonSource, warnings: bundle.warnings }, comparisonFeed(bundle.comparison, bundle.comparisonSource.beforeId),
            `Сравнение прогонов ${shortRun(bundle.comparisonSource.beforeId)} → ${shortRun(record.id)}`);
        }
        const output = {
          ...summary(record, lab.store.directory, bundle.view), agent: record.revisions.find(r => r.id === record.selectedRevisionId)?.spec,
          settings: record.settings, requirements: record.requirements, profiles: record.profiles,
          scenarios: record.scenarios.filter(s => s.split === 'dev' || controlVisible), revisions: record.revisions, iterations: record.iterations,
          trials: record.trials.filter(t => t.split === 'dev' || controlVisible).map(t => ({ id: t.id, revisionId: t.revisionId, scenarioId: t.scenarioId, split: t.split, outcome: t.outcome, reason: t.reason })),
          ...(bundle.comparison ? { comparison: bundle.comparison, comparisonSource: bundle.comparisonSource } : {}),
          warnings: bundle.warnings,
          ...(params.export ? { artifacts: await exportArtifacts(bundle, lab.store.directory) } : {}),
        };
        // A run with dialogues opens with the same ResultView block as the CLI summary; a draft shows its scenarios.
        if (record.trials.length) return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: { id: record.id } };
        return feedResult(callId, output, libraryFeed(record), note);
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
      const active = boardRun?.directory === directory ? boardRun : undefined;
      rememberShown('runs', directory, records.map(record => record.id));
      const feed = statusFeed(records, active);
      if (active) feed.rows.push(...progressLines(await active.lab.get(active.id)).map(line => row(line, 'accent')));
      const output = { runs: records.slice(0, 40).map(record => ({ id: record.id, shortId: shortRun(record.id), task: record.task, phase: record.phase, updatedAt: record.updatedAt,
        variants: record.librarySnapshot?.variants.length ?? record.scenarios.length, acceptedVariants: record.librarySnapshot?.acceptance?.variantIds.length ?? null,
        trials: record.trials.length, plannedTrials: plannedTrials(record), parentRunId: record.parentRunId })),
        workingOn: focus.get(directory) ?? null, runningInThisSession: active?.id ?? null };
      return feedResult(callId, output, feed, `Agent Lab · прогонов: ${records.length}`);
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_scenarios'),
    name: 'agent_lab_scenarios', label: 'Show and revise scenarios',
    description: 'The scenario library of one run, through the same versioned API as the board and the CLI. show: the draft, one card (variant) or its source dialogue (source:true). edit: change one card. resolve: the owner settles a checker\'s open question about a card in their own name («да, это моё правило») — always their native decision; a blocking remark cannot be settled this way. variant: add a targeted synthetic card from a parent; the tool derives the fact, the opening and the conditions from the parent. merge/split: business groups. remove, assess (semantic recheck), accept (native confirmation; never runs the agent), budget (native confirmation). Cards, groups and facts are named by title, list number or id. Edits are recorded under the owner\'s own message read from the session; fact values and expectations the owner never said are refused with a question for the owner. Meaning is rechecked after a change within the agreed call limit.',
    parameters: Type.Object({
      operation: Type.Union(['show', 'inspect', 'edit', 'variant', 'resolve', 'merge', 'split', 'remove', 'assess', 'accept', 'budget'].map(value => Type.Literal(value))),
      issue: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: 'resolve: which remark of the card the owner settles, by its number in the card; omit for every open remark of the card.' })),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the run this conversation works on.' })),
      variant: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'One card: its title, its number in the shown list, or its id. For variant it is the parent card.' })),
      variants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 200, description: 'Several cards, for accept and split.' })),
      groups: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 2, maxItems: 20, description: 'merge: business groups by title, number or id; the first one keeps its name.' })),
      source: Type.Optional(Type.Boolean({ description: 'show: include the source dialogue and the quotes the card was built from.' })),
      change: Type.Optional(Type.Object({
        field: Type.Union(['opening', 'goal', 'expectation', 'rule', 'fact'].map(value => Type.Literal(value))),
        value: Type.Optional(Type.String({ maxLength: 3000, description: 'The new text; for a fact, its exact value.' })),
        rule: Type.Optional(Type.String({ maxLength: 300, description: 'field=rule: which rule, by its words or id; "disputed" means every rule the checker calls inapplicable to this card. Omit when the card has one rule.' })),
        remove: Type.Optional(Type.Boolean({ description: 'field=rule: take the rule out of this card. At least one rule must stay.' })),
        applicability: Type.Optional(Type.String({ maxLength: 1000, description: 'field=rule: when the rewritten rule applies, in the owner\'s words.' })),
        fact: Type.Optional(Type.String({ maxLength: 300, description: 'field=fact: which fact, by its words, value or id. Omit to add a new fact.' })),
        statement: Type.Optional(Type.String({ maxLength: 300, description: 'field=fact: the fact as a sentence, e.g. «Номер договора: 778899».' })),
        availability: Type.Optional(Type.Union(['initial', 'learned_in_source', 'uncertain'].map(value => Type.Literal(value)), { description: 'initial: the client knew it before the conversation, even when they reveal it only on request.' })),
      }, { additionalProperties: false })),
      kind: Type.Optional(Type.Union(['reveal_on_request', 'missing_fact', 'ambiguous_opening', 'changed_intent', 'tool_failure'].map(value => Type.Literal(value)), { description: 'variant: what differs from the parent card.' })),
      fact: Type.Optional(Type.String({ maxLength: 300, description: 'variant: which known fact is withheld or missing, in words. Omit when the card has one known fact.' })),
      opening: Type.Optional(Type.String({ maxLength: 3000, description: 'variant: a first client message, only when the derived one is not what the owner asked for.' })),
      ifAsked: Type.Optional(Type.String({ maxLength: 300, description: 'variant: how the agent\'s request for the fact is recognised. Omit: the tool derives it from the fact.' })),
      reply: Type.Optional(Type.String({ maxLength: 1000, description: 'variant: what the client answers, only when the owner dictated it.' })),
      missingDescription: Type.Optional(Type.String({ maxLength: 300, description: 'missing_fact: a short name of the missing data without its value, e.g. «Номер терминала» — not a sentence. Omit: the tool takes it from the fact.' })),
      intent: Type.Optional(Type.String({ maxLength: 1000, description: 'changed_intent: what the client wants instead, in the owner\'s words.' })),
      afterAction: Type.Optional(Type.String({ maxLength: 80 })), failures: Type.Optional(Type.Integer({ minimum: 1, maximum: 15 })),
      title: Type.Optional(Type.String({ maxLength: 200, description: 'split: the name of the new group.' })), goal: Type.Optional(Type.String({ maxLength: 3000 })),
      select: Type.Optional(Type.Literal('ready', { description: 'accept: every card that is ready.' })),
      maxCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, description: 'budget: the new total call limit; used calls are never reset.' })),
      ownerQuote: Type.Optional(Type.String({ maxLength: 1000, description: 'The owner\'s exact words that asked for this change, when they are not in their latest message. Checked against the real session.' })),
      verify: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('later')], { description: 'later: skip the semantic recheck until the last edit of a series.' })),
      expectedLibraryHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
      patch: Type.Optional(Type.Any()), request: Type.Optional(Type.Any()),
      variantIds: Type.Optional(Type.Array(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), { minItems: 1, maxItems: 200 })),
      variantId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      const operation = params.operation === 'inspect' ? 'show' : params.operation;
      const output = (record: Experiment, library: ScenarioLibrary, shown?: ScenarioVariant) => {
        const semantic = semanticWorkStatus(library);
        const offset = shown ? 0 : params.cursor ?? 0;
        const limit = shown ? 1 : params.limit ?? 20;
        const page = shown ? [shown] : orderedVariants(library).slice(offset, offset + limit);
        const detail = shown ? page.map(variant => ({
          id: variant.id, title: variant.title, quality: variant.quality, ownerDecision: variant.ownerDecision, provenance: variant.provenance,
          businessScenarioId: variant.businessScenarioId, parentVariantId: variant.parentVariantId, mutationReason: variant.mutationReason,
          opening: variant.userState.opening, goal: variant.userState.goal, successCriteria: variant.evaluationSpec.successCriteria,
          facts: variant.userState.facts.map(fact => ({ id: fact.id, statement: fact.statement, value: fact.value, availability: fact.availability, reason: fact.reason, origin: fact.origin })),
          missing: variant.userState.missing, cannotKnow: variant.userState.cannotKnow, issues: variant.issues,
          issuesInPlainWords: variant.issues.map(item => plainIssue(library, variant, item)), disputedChecks: disputedCheckpoints(variant).map(item => ({ id: item.id, rule: item.rule })),
          sourceDialogues: variant.sourceDialogues,
          behavior: variant.behaviorPolicy.transitions.map(transition => { const action = variant.behaviorPolicy.actions.find(item => item.id === transition.actionId);
            return { condition: transition.when, actionId: transition.actionId, action: action?.kind ?? 'invalid', payload: action?.payload, ifAsked: action?.ifAsked }; }),
          checkpoints: variant.evaluationSpec.checkpoints.map(item => ({ id: item.id, rule: item.rule, quote: item.quote, observation: item.observation, role: item.role })),
          environment: { mode: variant.environmentFixture.mode, contract: variant.environmentFixture.contract },
          ...(params.source ? { sourceEvents: variant.sourceDialogues.map(ref => ({ ...ref, events: (library.imports.find(batch => batch.id === ref.batchId)?.dialogues.find(item => item.id === ref.dialogueId)?.events ?? [])
            .map(event => ({ index: event.index, role: event.role ?? event.type, content: event.content })) })) } : {}),
        })) : undefined;
        return {
          ...scenarioLibrarySummary(record, library.acceptance?.variantIds ?? []),
          runId: record.id, progress: record.preparationProgress,
          budget: { usedCalls: record.usage.calls, maxCalls: record.settings.maxCalls, remainingCalls: Math.max(0, record.settings.maxCalls - record.usage.calls),
            semanticTotalJobs: semantic.totalJobs, semanticCompletedJobs: semantic.completedJobs, semanticPendingJobs: semantic.pendingJobs, skipped: semantic.skipped },
          groups: library.businessScenarios.map((group, index) => ({ number: index + 1, id: group.id, title: group.title, goal: group.goal, grouping: group.grouping,
            variantCount: library.variants.filter(variant => variant.businessScenarioId === group.id).length })),
          variants: page.map(variant => ({ number: variantNumber(library, variant), id: variant.id, businessScenarioId: variant.businessScenarioId, title: variant.title, quality: variant.quality,
            provenance: variant.provenance, parentVariantId: variant.parentVariantId, issueCount: variant.issues.length, sourceCount: variant.sourceDialogues.length })),
          page: { offset, limit, total: library.variants.length, nextCursor: offset + page.length < library.variants.length ? offset + page.length : null },
          ...(detail ? { detail } : {}),
          agentRun: false,
        };
      };
      const titled = (library: ScenarioLibrary, items: ScenarioVariant[]) => items.map(item => `${variantNumber(library, item)}. ${safeText(item.title)}`);
      const pickVariant = (library: ScenarioLibrary, ref: string | undefined): ScenarioVariant => {
        if (!ref) throw needsOwner('unknown_reference', 'Не сказано, о какой карточке речь. Спросите владельца.', titled(library, orderedVariants(library)).slice(0, 12));
        const resolved = resolveVariant(library, ref);
        if (resolved.kind === 'one') return resolved.item;
        const candidates = titled(library, resolved.kind === 'many' ? resolved.items : orderedVariants(library));
        throw needsOwner(resolved.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference', referenceProblem('Карточка', ref, resolved, candidates), candidates.slice(0, 12), referenceQuestion(ref, resolved));
      };
      const pickGroup = (library: ScenarioLibrary, ref: string) => {
        const resolved = resolveGroup(library, ref);
        if (resolved.kind === 'one') return resolved.item;
        const candidates = (resolved.kind === 'many' ? resolved.items : library.businessScenarios).map(group => safeText(group.title));
        throw needsOwner(resolved.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference', referenceProblem('Группа', ref, resolved, candidates), candidates.slice(0, 12), referenceQuestion(ref, resolved));
      };
      try {
        const found = await findRun(directory, params.id, ctx);
        focus.set(directory, found.id);
        const seenKey = `${directory}|${found.id}`;
        if (!found.librarySnapshot) {
          if (operation !== 'show') throw new Error('У этого прогона прежние карточки без библиотеки сценариев. Ожидания правятся через agent_lab_accept, настройки — через agent_lab_edit.');
          returnToBoard(ctx, found.id);
          return feedResult(callId, summary(found, directory), libraryFeed(found), `Сценарии прогона ${shortRun(found.id)}`);
        }
        if (operation === 'show') {
          const { experiment, library } = await reading(directory).readLibrary(found.id);
          const ref = params.variant ?? params.variantId;
          const shown = ref ? pickVariant(library, ref) : undefined;
          if (shown) lastCard.set(`${directory}|${library.id}`, shown.id);
          markSeen(seenKey, libraryHash(library));
          returnToBoard(ctx, experiment.id);
          return feedResult(callId, output(experiment, library, shown), shown ? variantFeed(experiment, shown, { source: params.source }) : libraryFeed(experiment),
            `Сценарии прогона ${shortRun(experiment.id)} · ревизия ${library.revision}`,
            { view: shown ? 'card' : 'library', directory, runId: experiment.id, libraryId: library.id, hash: libraryHash(library), ...(shown ? { variantId: shown.id } : {}) });
        }
        const messages = ownerMessages(ctx);
        /** Conversation authority first, the native dialog second, a question to the owner when a value was never said. */
        const decide = async (request: Omit<Parameters<typeof authorize>[0], 'messages' | 'quote'>): Promise<string> => {
          const authority = authorize({ ...request, messages, quote: params.ownerQuote });
          if (authority.kind === 'ask') throw needsOwner('needs_owner_input', authority.message, [], authority.ownerMessage);
          if (authority.kind === 'confirm') {
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Эта правка не подтверждена словами владельца в разговоре, а native-подтверждение недоступно без интерактивного терминала. В CLI: scenarios --operation edit --input patch.json.');
            if (!await ctx.ui.confirm('Записать это от вашего имени?', safeText(authority.question))) throw needsOwner('declined', 'Владелец не подтвердил правку. Ничего не записано.');
          }
          return authority.reason;
        };
        /** What the owner's message has to name for a change to need no extra stop: these cards (or groups) among all there are. */
        const cardObjects = (library: ScenarioLibrary, cards: ScenarioVariant[]): InstructionObjects => ({ kind: 'card', exhaustive: cards.length >= library.variants.length,
          targets: cards.map(card => ({ number: variantNumber(library, card), title: card.title, otherTitles: library.variants.filter(item => item.id !== card.id).map(item => item.title),
            lastTouched: lastCard.get(`${directory}|${library.id}`) === card.id })) });
        const groupObjects = (library: ScenarioLibrary, groups: ScenarioLibrary['businessScenarios']): InstructionObjects => ({ kind: 'group', exhaustive: groups.length >= library.businessScenarios.length,
          targets: groups.map(group => ({ number: library.businessScenarios.indexOf(group) + 1, title: group.title, otherTitles: library.businessScenarios.filter(item => item.id !== group.id).map(item => item.title) })) });
        // An acceptance waits for a recheck that is still going; any other change cancels and restarts it.
        const owned = await open(ctx.cwd, operation === 'accept' ? 'wait' : 'cancel');
        const { lab, close } = owned;
        let handedOver = false;
        let draftId = found.id;
        let newerRevision = false;
        const cancel = () => { void lab.cancel(draftId).catch(() => {}); };
        try {
          await lab.init();
          // A run that has dialogues never changes. An edit asked for after it goes into a fresh draft of the same set, and says so.
          let movedFrom: Experiment | undefined;
          // Read again under the lock: a recheck of this session may have been going when the run was looked up.
          const settled = await lab.get(found.id);
          if (activePhases.has(settled.phase)) throw new Error(`Прогон ${shortRun(found.id)} сейчас выполняется. Сценарии можно смотреть; правки — после его завершения или остановки.`);
          // A library has one line of revisions. The record to edit is the draft that holds its newest revision;
          // when only finished runs hold it, the newest of them is copied into a fresh draft.
          const headHash = await lab.store.readLibrary(settled.librarySnapshot!.id).then(libraryHash, () => libraryHash(settled.librarySnapshot!));
          if (settled.phase !== 'review' || libraryHash(settled.librarySnapshot!) !== headHash) {
            const holders = (await lab.list()).filter(item => item.librarySnapshot?.id === settled.librarySnapshot!.id && libraryHash(item.librarySnapshot) === headHash)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const draft = holders.find(item => item.phase === 'review' && !item.trials.length);
            const source = holders.find(item => !activePhases.has(item.phase) && !!item.reviewedAt) ?? settled;
            draftId = (draft ?? await lab.repeat(source.id)).id;
            movedFrom = settled;
            newerRevision = libraryHash(settled.librarySnapshot!) !== headHash;
            focus.set(directory, draftId);
          }
          const draftKey = `${directory}|${draftId}`;
          const current = await lab.readLibrary(draftId);
          let library = current.library;
          // The state the model saw, plus nothing but this session's own semantic bookkeeping on top of it.
          // Redirected to another record of the same library, the edit applies to the view the model saw last: after looking at an older run
          // its card numbers may differ, so that edit is refused once and the newest revision is shown.
          const latestView = (seenTick.get(seenKey) ?? 0) > (seenTick.get(draftKey) ?? 0) ? seenKey : draftKey;
          let expected = params.expectedLibraryHash ?? seenLibrary.get(latestView) ?? seenLibrary.get(seenKey);
          if (!expected) throw new Error('Сначала прочитайте сценарии этого прогона (operation:"show"): правка применяется к состоянию, которое вы видели.');
          for (let hop = 0; hop < 16 && checkMoves.has(`${draftKey}|${expected}`); hop++) expected = checkMoves.get(`${draftKey}|${expected}`)!;
          /**
           * The semantic recheck a change needs, within the agreed call limit: in this row when it is fast, as a later message when it is not.
           * `askedHash` marks the owner's explicit assess: it checks the state the model saw, is never postponed, and with fewer calls left
           * than jobs owed it still runs — a bounded partial assessment — instead of asking for budget.
           */
          const verify = async (variantId?: string, wait = false, askedHash?: string): Promise<CheckOutcome> => {
            const fresh = await lab.readLibrary(draftId);
            let debt: ReturnType<typeof semanticDebt>;
            try { debt = semanticDebt(fresh.experiment, fresh.library); } catch (error) { return { status: 'failed', message: inputError(error) }; }
            if (!debt.pendingJobs) return { status: 'not_needed' };
            if (params.verify === 'later' && !wait && !askedHash) return { status: 'skipped', ...debt };
            if (!askedHash && debt.pendingJobs > debt.remainingCalls) return { status: 'needs_budget', ...debt };
            const startHash = askedHash ?? libraryHash(fresh.library);
            onUpdate?.({ content: [{ type: 'text', text: `Перепроверяю смысл изменённых карточек · до ${Math.min(debt.pendingJobs, debt.remainingCalls)} вызовов модели…` }], details: { id: draftId, phase: 'preparing' } });
            // A stale view refuses an explicit assess the way it refuses any other operation: with the fresh state, not as a failed check.
            try { await lab.assessLibrary(draftId, startHash); } catch (error) { if (askedHash) throw error; return { status: 'failed', message: inputError(error) }; }
            // Without a terminal an abort still cancels an explicit assess; one that fired before the work was registered is caught up here.
            if (askedHash && wait && signal.aborted) cancel();
            const inline = wait ? (await lab.waitForIdle(), true) : await new Promise<boolean>(settle => {
              const timer = setTimeout(() => settle(false), inlineCheckMs);
              const onAbort = () => settle(false);
              signal.addEventListener('abort', onAbort, { once: true });
              void lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
            });
            if (!inline) {
              handedOver = true;
              backgroundCheck(ctx, directory, draftId, owned, fresh.experiment.usage.calls, startHash, variantId, !!askedHash);
              return { status: 'running', ...debt };
            }
            const after = await lab.get(draftId);
            checkMoves.set(`${draftKey}|${startHash}`, libraryHash((await lab.readLibrary(draftId)).library));
            return after.phase === 'review' && !after.error ? { status: 'done', calls: Math.max(0, after.usage.calls - fresh.experiment.usage.calls) }
              : { status: 'failed', message: safeText(after.error ?? after.message) };
          };
          /** Every change answers the same way: what happened, «было → стало», the recheck, and which state the draft is in now. */
          let changedHash: string | undefined;
          const changed = async (headline: string, extra: Feed['rows'], variantId: string | undefined, payload: Record<string, unknown>, note: string) => {
            changedHash = libraryHash((await lab.readLibrary(draftId)).library);
            const check = await verify(variantId);
            const fresh = await lab.readLibrary(draftId);
            markSeen(draftKey, libraryHash(fresh.library));
            const variant = variantId ? fresh.library.variants.find(item => item.id === variantId) : undefined;
            if (variant) lastCard.set(`${directory}|${fresh.library.id}`, variant.id);
            const card = variant ? variantFeed(fresh.experiment, variant) : undefined;
            const moved = movedFrom ? [row(movedFrom.phase === 'review' ? 'Правка сделана в черновике последней ревизии этого набора.'
              : `Прогон ${shortRun(movedFrom.id)} уже выполнен и не меняется: правка сделана в черновике того же набора.`, 'accent', false, 1)] : [];
            const disputed = variant && check.status !== 'running' ? disputedCheckpoints(variant) : [];
            const feed: Feed = { rows: [row(headline, 'success', true), ...moved, ...extra, checkRow(check, variant),
              ...(variant && check.status === 'done' ? ownerRemarks(variant.issues).slice(0, 3).map(item => row(`• ${safeText(plainIssue(fresh.library, variant, item))}`, 'warning', false, 1)) : []),
              ...(disputed.length ? [row(`Под вопросом проверки: ${disputed.map(item => `«${safeText(item.rule)}»`).join('; ')}. Их можно переписать или убрать — скажите как.`, 'accent', false, 1)] : []),
              ...stateRows(fresh.experiment)],
              ...(card ? { more: [...card.rows, row(''), ...(card.more ?? [])] } : {}) };
            returnToBoard(ctx, fresh.experiment.id);
            return feedResult(callId, { ...output(fresh.experiment, fresh.library, variant), ...payload, check, mutated: true,
              ...(movedFrom ? { draftRunId: draftId, unchangedRunId: movedFrom.id, instruction: 'The finished run is immutable, so the change went into a fresh draft of the same set. Tell the owner in one phrase and keep working on draftRunId.' } : {}),
              ...(check.status === 'running' ? { checkNote: 'The semantic recheck continues in the background and will report back as a message. Do not wait for it and do not poll; further edits are fine.' } : {}) }, feed, note,
              variant ? { view: 'change', directory, runId: draftId, libraryId: fresh.library.id, hash: changedHash ?? libraryHash(fresh.library), beforeHash: expected, variantId: variant.id } : undefined);
          };
          const knownTexts = (variant: ScenarioVariant): string[] => [variant.userState.opening, variant.userState.goal, variant.evaluationSpec.successCriteria,
            ...variant.userState.facts.flatMap(fact => [fact.statement, String(fact.value ?? '')]), ...variant.userState.missing,
            ...variant.evaluationSpec.checkpoints.flatMap(item => [item.rule, item.quote]), ...library.requirements.flatMap(item => [item.text, item.quote]),
            ...variant.sourceDialogues.flatMap(ref => library.imports.find(batch => batch.id === ref.batchId)?.dialogues.find(item => item.id === ref.dialogueId)?.events.map(event => event.content ?? '') ?? [])];
          /** Where a fact value may come from besides the owner's words: the card's own facts and what the client said in the source dialogue — never the old agent's replies, expectations or requirements. */
          const factSources = (variant: ScenarioVariant): string[] => [...variant.userState.facts.flatMap(fact => [fact.statement, String(fact.value ?? '')]),
            ...variant.sourceDialogues.flatMap(ref => library.imports.find(batch => batch.id === ref.batchId)?.dialogues.find(item => item.id === ref.dialogueId)?.events.filter(event => event.role === 'user').map(event => event.content ?? '') ?? [])];
          const editId = `owner_${Date.now().toString(36)}`;

          if (operation === 'variant') {
            const legacy = params.request as { parentId?: string; operation?: VariantOperation; reason?: string; input?: unknown } | undefined;
            const parent = pickVariant(library, params.variant ?? legacy?.parentId);
            const kind = (params.kind ?? legacy?.operation) as VariantOperation | undefined;
            if (!kind) throw new Error('Укажите kind: чем вариант отличается от исходной карточки.');
            let input = legacy?.input;
            if (input === undefined) {
              const derived = deriveVariantInput(parent, kind, { fact: params.fact, opening: params.opening, ifAsked: params.ifAsked, reply: params.reply,
                missingDescription: params.missingDescription, intent: params.intent, afterAction: params.afterAction, failures: params.failures });
              if (derived.kind === 'ask') throw needsOwner('needs_owner_input', derived.message);
              input = derived.input;
            }
            // The same authority whatever the form of the call: a ready-made request.input gets no rights the conversational form lacks.
            // The simulated client may only say values the owner or the parent card already hold.
            const spoken = Object.values(input && typeof input === 'object' ? input as Record<string, unknown> : {}).filter((value): value is string => typeof value === 'string');
            await decide({ intent: 'variant', objects: cardObjects(library, [parent]), simulated: [...spoken, ...[params.opening, params.reply, params.intent].filter((text): text is string => !!text)], known: knownTexts(parent),
              summary: `Добавить к карточке «${parent.title}» синтетический вариант: ${kind}` });
            const reason = legacy?.reason ?? ownerBasis(messages, params.ownerQuote)?.reason ?? 'Целевой вариант по запросу в разговоре';
            const proposed = await lab.proposeVariant(draftId, expected, { parentId: parent.id, operation: kind, reason, input });
            return await changed(`Добавлен синтетический вариант «${safeText(proposed.variant.title)}»`,
              [...changeRows(proposed.diff), row(`Исходная карточка «${safeText(parent.title)}» не изменена.`, 'muted', false, 1)], proposed.variant.id,
              { variant: proposed.variant, diff: proposed.diff, parentUnchanged: true }, `Добавлен вариант · прогон ${shortRun(draftId)}`);
          }
          if (operation === 'assess') {
            const debt = semanticDebt(current.experiment, library);
            if (!debt.remainingCalls && debt.pendingJobs) throw new Error(`Осталось ${debt.pendingJobs} смысловых вызовов, модельный бюджет исчерпан. Увеличьте лимит (operation:"budget") с согласия владельца; использованный бюджет не сбрасывается.`);
            // In the terminal a long assessment goes on behind the conversation and reports back as a message; Esc hands it over, too.
            // Without a terminal there is nowhere to report to, so the call waits, and an abort still cancels the work.
            const interactive = !!ctx.hasUI && ctx.mode === 'tui' && !!ctx.ui;
            let check: CheckOutcome = { status: 'not_needed' };
            if (debt.pendingJobs) {
              if (!interactive) signal.addEventListener('abort', cancel, { once: true });
              try { check = await verify(undefined, !interactive, expected); } finally { signal.removeEventListener('abort', cancel); }
            }
            const fresh = await lab.readLibrary(draftId);
            returnToBoard(ctx, fresh.experiment.id);
            if (check.status === 'running') return feedResult(callId, { ...output(fresh.experiment, fresh.library), check, mutated: true,
              checkNote: 'The semantic assessment continues in the background and will report back as a message. Do not wait for it and do not poll; reads and further edits are fine.' },
              { rows: [row(`Смысловая проверка идёт в фоне · до ${Math.min(debt.pendingJobs, debt.remainingCalls)} вызовов модели.`, 'success', true),
                row('Разговор свободен. Итог появится здесь отдельным сообщением; новая правка перезапустит проверку, уже проверенное не пропадёт.', 'muted', false, 1)] }, `Смысловая проверка · прогон ${shortRun(draftId)}`);
            markSeen(draftKey, libraryHash(fresh.library));
            const feed = libraryFeed(fresh.experiment);
            feed.rows.unshift(row(debt.pendingJobs ? `Смысловая проверка завершена · вызовов модели: ${Math.max(0, fresh.experiment.usage.calls - current.experiment.usage.calls)}` : 'Смысловая проверка не нужна: непроверенных изменений нет.', 'success', true));
            return feedResult(callId, { ...output(fresh.experiment, fresh.library), mutated: debt.pendingJobs > 0 }, feed, `Смысловая проверка · прогон ${shortRun(draftId)}`);
          }
          if (operation === 'accept') {
            // «Готовые» means checked: a recheck still owed by earlier edits runs first when the agreed limit covers it.
            const owed = await verify(undefined, true);
            if (owed.status === 'done') { library = (await lab.readLibrary(draftId)).library; expected = libraryHash(library); }
            const ids = params.variantIds ?? (params.variants ? params.variants.map(ref => pickVariant(library, ref).id)
              : params.select === 'ready' ? orderedVariants(library).filter(item => item.quality === 'ready').map(item => item.id) : []);
            if (!ids.length) throw needsOwner('needs_owner_input', params.select === 'ready' ? 'Готовых карточек нет: каждая ждёт решения или заблокирована. Покажите владельцу замечания.' : 'Не сказано, какие карточки принять. Спросите владельца.');
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Принятие библиотеки требует native Pi confirmation; в CLI используйте scenarios --operation accept --yes.');
            const chosen = orderedVariants(library).filter(item => ids.includes(item.id));
            const left = orderedVariants(library).filter(item => !ids.includes(item.id));
            const tail = [...(left.length ? ['', `Не входят (${left.length}): ${left.slice(0, 6).map(item => `${safeText(item.title)} — ${item.quality === 'ready' ? 'не выбрана' : item.quality === 'blocked' ? 'заблокирована' : 'ждёт решения'}`).join('; ')}${left.length > 6 ? '…' : ''}`] : []),
              '', 'Агент не запускается. Запуск подтверждается отдельно.'];
            const cards = ids.length % 10 === 1 && ids.length % 100 !== 11 ? 'карточку' : [2, 3, 4].includes(ids.length % 10) && ![12, 13, 14].includes(ids.length % 100) ? 'карточки' : 'карточек';
            const question = `Принять ${ids.length} ${cards} как набор для проверки?`;
            let agreed = false;
            if (chosen.length <= ACCEPTANCE_PAGE) agreed = await ctx.ui.confirm(question, safeText([...acceptanceLines(library, chosen), ...tail].join('\n')));
            else {
              // A large set is paged inside the native dialog: every definition can be read there, accepting is possible on any page,
              // and the dialog itself counts what was not opened — it never claims that something was shown elsewhere.
              const accept = `Принять все ${ids.length} ${cards}`, next = 'Показать следующие определения', refuse = 'Не принимать';
              const opened = new Set<string>();
              for (let from = 0; ;) {
                signal.throwIfAborted();
                const page = chosen.slice(from, from + ACCEPTANCE_PAGE);
                for (const item of page) opened.add(item.id);
                const unseen = chosen.length - opened.size;
                const picked = await ctx.ui.select(safeText([question, `Определения карточек ${from + 1}–${from + page.length} из ${chosen.length} · ${unseen ? `ещё не открыто: ${unseen}` : 'открыты все'}`,
                  '', ...acceptanceLines(library, page), ...tail].join('\n')), [accept, from + ACCEPTANCE_PAGE < chosen.length ? next : 'Показать определения с начала', refuse]);
                if (picked === accept) { agreed = true; break; }
                if (picked === undefined || picked === refuse) break;
                from = from + ACCEPTANCE_PAGE < chosen.length ? from + ACCEPTANCE_PAGE : 0;
              }
            }
            if (!agreed) {
              return feedResult(callId, { cancelled: true, mutated: false, message: 'Принятие отменено. Агент не запускался.' }, { rows: [row('Принятие отменено. Набор не изменился, агент не запускался.', 'warning')] }, 'Принятие отменено');
            }
            const accepted = await lab.acceptLibrary(draftId, expected, ids);
            markSeen(draftKey, libraryHash(accepted.library));
            returnToBoard(ctx, accepted.experiment.id);
            const feed: Feed = { rows: [row(`Принят набор: ревизия ${accepted.library.revision}, ${ids.length} из ${library.variants.length} карточек. Агент не запускался.`, 'success', true),
              ...(left.length ? [row(`Остались вне набора: ${left.length}.`, 'muted', false, 1)] : []), row('План запуска (подтверждается отдельно):', 'accent', false, 1),
              ...planLines(accepted.experiment, ctx.cwd).map(line => row(safeText(line), undefined, false, 3))], more: titled(accepted.library, chosen).map(line => row(line, undefined, false, 1)) };
            return feedResult(callId, { ...output(accepted.experiment, accepted.library), accepted: true, draftHash: draftHash(accepted.experiment), plan: planLines(accepted.experiment, ctx.cwd), mutated: true }, feed,
              `Принят набор · прогон ${shortRun(draftId)} · ревизия ${accepted.library.revision}`);
          }
          if (operation === 'budget') {
            if (!params.maxCalls) throw new Error('Укажите maxCalls: новый общий лимит вызовов модели.');
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Изменение лимита расходов требует native Pi confirmation.');
            const record = current.experiment;
            if (params.maxCalls <= record.usage.calls) throw new Error(`Лимит должен быть больше уже использованных ${record.usage.calls} вызовов.`);
            if (!await ctx.ui.confirm('Изменить лимит вызовов модели?', safeText(`Было: ${record.settings.maxCalls}. Станет: ${params.maxCalls}. Уже использовано ${record.usage.calls}; использованные вызовы не сбрасываются.`))) {
              return feedResult(callId, { cancelled: true, mutated: false }, { rows: [row('Лимит не изменён.', 'warning')] }, 'Лимит не изменён');
            }
            await lab.updateDraft(draftId, draftHash(record), { settings: { maxCalls: params.maxCalls } });
            return await changed(`Лимит вызовов модели: ${record.settings.maxCalls} → ${params.maxCalls}`, [], undefined, { maxCalls: params.maxCalls }, `Лимит вызовов · прогон ${shortRun(draftId)}`);
          }

          if (operation === 'resolve') {
            const card = pickVariant(library, params.variant ?? params.variantId);
            const open = ownerRemarks(card.issues).filter(item => item.code === 'semantic_finding' && item.severity === 'needs_review');
            const chosen = params.issue ? open.slice(params.issue - 1, params.issue) : open;
            if (!chosen.length) throw needsOwner('needs_owner_input', card.issues.some(item => item.severity === 'blocked')
              ? 'У этой карточки блокирующее замечание: его снимает исправление карточки, а не решение владельца.' : 'У этой карточки нет открытых вопросов, которые владелец может закрыть своим решением.');
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Закрыть вопрос проверяющего может только владелец в интерактивном терминале.');
            const plain = chosen.map(item => plainIssue(library, card, item));
            if (!await ctx.ui.confirm('Закрыть вопрос своим решением?', safeText([`Карточка «${card.title}». Проверяющий сомневается:`, ...plain.map(text => `• ${text}`), '',
              'Да — это ваше решение как владельца: карточка считается верной в этой части. Оно записывается от вашего имени и видно в карточке. Если карточку изменить, вопрос может открыться снова.'].join('\n')))) {
              throw needsOwner('declined', 'Владелец не закрыл вопрос. Ничего не записано.');
            }
            const reason = ownerBasis(messages, params.ownerQuote)?.reason ?? 'Решение владельца в диалоге Pi.';
            for (const item of chosen) {
              const path = item.path.replace(`variants.${card.id}.`, '');
              expected = libraryHash((await lab.editLibrary(draftId, expected, { kind: 'resolve_finding', variantId: card.id, path, editId: `owner_${Date.now().toString(36)}`, reason })).library);
            }
            return await changed(`Вопрос по карточке «${safeText(card.title)}» закрыт вашим решением`, plain.map(text => row(`было под вопросом: ${safeText(text)}`, 'muted', false, 1)), card.id,
              { resolved: plain, recordedReason: reason }, `Решение владельца · прогон ${shortRun(draftId)}`);
          }
          let patch: LibraryPatch;
          let target: ScenarioVariant | undefined;
          let headline: string;
          if (params.patch) {
            patch = libraryPatchSchema.parse(params.patch);
            const expectedKind = operation === 'merge' ? 'merge_business' : operation === 'split' ? 'split_business' : operation === 'remove' ? 'remove_variant' : undefined;
            if (expectedKind && patch.kind !== expectedKind) throw new Error(`Операция ${operation} требует patch.kind=${expectedKind}.`);
            if (patch.kind === 'upsert_variant') throw new Error('Целая карточка от модели не записывается. Меняйте одно поле через change или добавляйте вариант через operation:"variant".');
            // The owner's waiver of a checker's question has one door: operation resolve with its native decision. A ready-made patch is not another one.
            if (patch.kind === 'resolve_finding') throw new Error('Вопрос проверяющего закрывает только владелец: operation:"resolve" с его native-решением. Готовый patch для этого не принимается.');
            const patched = 'variantId' in patch ? patch.variantId : undefined;
            target = library.variants.find(item => item.id === patched);
            const attributed = patch.kind === 'edit_fact' || patch.kind === 'add_fact' ? [patch.statement, String(patch.value ?? '')]
              : patch.kind === 'edit_variant_text' && ['successCriteria', 'checkpointRule'].includes(patch.field) ? [patch.value] : [];
            const simulated = patch.kind === 'edit_variant_text' && !attributed.length ? [patch.value] : [];
            const namedIds = patch.kind === 'merge_business' ? [patch.targetId, ...patch.sourceIds] : patch.kind === 'split_business' ? patch.variantIds : [];
            patch = { ...patch, reason: await decide({ intent: patch.kind === 'remove_variant' ? 'remove' : patch.kind === 'merge_business' ? 'merge' : patch.kind === 'split_business' ? 'split' : 'edit',
              provenance: patch.kind === 'edit_fact' || patch.kind === 'add_fact', attributed, simulated, known: target ? (patch.kind === 'edit_fact' || patch.kind === 'add_fact' ? factSources(target) : knownTexts(target)) : [],
              // A ready-made patch names its objects by id: the owner's message still has to name the same cards or groups.
              objects: target ? cardObjects(library, [target]) : patch.kind === 'merge_business' ? groupObjects(library, library.businessScenarios.filter(group => namedIds.includes(group.id)))
                : patch.kind === 'split_business' ? cardObjects(library, library.variants.filter(item => namedIds.includes(item.id))) : undefined,
              summary: `${target ? `Карточка «${target.title}» · ` : ''}${patch.kind}: ${JSON.stringify(params.patch).slice(0, 600)}` }) } as LibraryPatch;
            headline = patch.kind === 'remove_variant' ? `Карточка «${safeText(target?.title ?? patch.variantId)}» убрана из черновика` : patch.kind === 'merge_business' ? 'Группы объединены' : patch.kind === 'split_business' ? 'Карточки выделены в отдельную группу' : `Карточка «${safeText(target?.title ?? '')}» изменена`;
          } else if (operation === 'merge') {
            if (!params.groups) throw needsOwner('needs_owner_input', 'Не сказано, какие группы объединить. Спросите владельца.', library.businessScenarios.map(group => safeText(group.title)));
            const [into, ...sources] = params.groups.map(ref => pickGroup(library, ref));
            if (!into || !sources.length || sources.some(group => group.id === into.id)) throw needsOwner('needs_owner_input', 'Для объединения нужны две разные группы. Уточните у владельца.', library.businessScenarios.map(group => safeText(group.title)));
            const summaryText = `Объединить группы: «${into.title}» + ${sources.map(group => `«${group.title}»`).join(' + ')}`;
            patch = { kind: 'merge_business', targetId: into.id, sourceIds: sources.map(group => group.id), reason: await decide({ intent: 'merge', objects: groupObjects(library, [into, ...sources]), summary: summaryText }) };
            headline = `Группы объединены: «${safeText(into.title)}» + ${sources.map(group => `«${safeText(group.title)}»`).join(' + ')} → «${safeText(into.title)}»`;
          } else if (operation === 'split') {
            const moving = (params.variants ?? (params.variant ? [params.variant] : [])).map(ref => pickVariant(library, ref));
            const source = library.businessScenarios.find(group => group.id === moving[0]?.businessScenarioId);
            if (!moving.length || !source) throw needsOwner('needs_owner_input', 'Не сказано, какие карточки выделить в отдельную группу. Спросите владельца.');
            if (!params.title) throw needsOwner('needs_owner_input', 'Спросите владельца, как назвать новую группу.');
            const reason = await decide({ intent: 'split', objects: cardObjects(library, moving), summary: `Выделить в группу «${params.title}»: ${moving.map(item => item.title).join('; ')}` });
            patch = { kind: 'split_business', businessScenarioId: source.id, variantIds: moving.map(item => item.id), reason,
              newBusiness: { key: `split_${Date.now().toString(36)}`, title: params.title, goal: params.goal ?? source.goal, conditions: source.conditions, requirementIds: source.requirementIds, grouping: { status: 'confirmed', reason } } };
            headline = `Новая группа «${safeText(params.title)}»: ${moving.map(item => `«${safeText(item.title)}»`).join(', ')}`;
          } else if (operation === 'remove') {
            target = pickVariant(library, params.variant ?? params.variantId);
            patch = { kind: 'remove_variant', variantId: target.id, reason: await decide({ intent: 'remove', objects: cardObjects(library, [target]), summary: `Убрать карточку «${target.title}» из новой ревизии` }) };
            headline = `Карточка «${safeText(target.title)}» убрана из черновика. Исходный импорт и прошлые прогоны сохранены.`;
          } else {
            const change = params.change;
            if (!change) throw new Error('Для edit укажите change: какое поле карточки изменить.');
            target = pickVariant(library, params.variant ?? params.variantId);
            const card = target;
            if (change.field === 'fact') {
              const named = change.fact ? resolveFact(card, change.fact) : undefined;
              if (named && named.kind !== 'one') throw needsOwner(named.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference',
                referenceProblem('Факт', change.fact!, named, card.userState.facts.map(fact => safeText(fact.statement))), card.userState.facts.map(fact => safeText(fact.statement)));
              const existing = named?.kind === 'one' ? named.item : undefined;
              const statement = change.statement ?? existing?.statement;
              if (!statement) throw needsOwner('needs_owner_input', 'Спросите владельца, как сформулировать новый факт о клиенте.');
              const value = change.value !== undefined && change.value !== String(existing?.value ?? '') ? change.value : existing?.value;
              const availability = (change.availability ?? existing?.availability ?? 'initial') as 'initial' | 'learned_in_source' | 'uncertain';
              // Confirming a fact as it stands is still an owner decision: it turns a model reading of the log into the owner's word.
              if (existing && statement === existing.statement && value === existing.value && availability === existing.availability && existing.origin.kind === 'owner') throw new Error('Факт уже такой и уже подтверждён владельцем: менять нечего.');
              const attributed = [...(statement !== existing?.statement ? [statement] : []), ...(value !== existing?.value && value !== undefined ? [String(value)] : [])];
              const knew = { initial: 'клиент знал это до разговора', learned_in_source: 'клиент узнал это только в старом разговоре', uncertain: 'неясно, знал ли клиент заранее' }[availability];
              const reason = await decide({ intent: 'edit', provenance: true, objects: cardObjects(library, [card]), attributed, known: factSources(card),
                summary: `${existing ? 'Записать от вашего имени' : 'Добавить от вашего имени'} факт клиента в карточке «${card.title}»:\n«${statement}»${value !== undefined ? ` (значение: ${value})` : ''}\n${knew}.` });
              patch = { kind: existing ? 'edit_fact' : 'add_fact', variantId: card.id, factId: existing?.id ?? `fact_${Date.now().toString(36)}`, statement, ...(value !== undefined ? { value } : {}), availability, editId, reason };
            } else {
              const field = change.field === 'expectation' ? 'successCriteria' as const : change.field === 'rule' ? 'checkpointRule' as const : change.field as 'opening' | 'goal';
              const checkpoints = card.evaluationSpec.checkpoints;
              const wantedRule = change.rule?.trim().toLocaleLowerCase('ru');
              const named = field !== 'checkpointRule' ? [] : wantedRule === 'disputed' ? disputedCheckpoints(card) : checkpoints.length === 1 && !wantedRule ? checkpoints
                : checkpoints.filter(item => !!wantedRule && (item.id === change.rule || item.rule.toLocaleLowerCase('ru').includes(wantedRule)));
              if (field === 'checkpointRule' && (!named.length || (named.length > 1 && !change.remove))) throw needsOwner('ambiguous_reference', 'Уточните у владельца, о каком правиле проверки речь.', checkpoints.map(item => safeText(item.rule)));
              if (change.remove) {
                if (field !== 'checkpointRule') throw new Error('Убрать можно только правило проверки (field:"rule").');
                const kept = checkpoints.filter(item => !named.includes(item));
                if (!kept.length) throw needsOwner('needs_owner_input', 'Без единой проверки карточку нечем измерять. Спросите владельца, чем заменить правило, и перепишите его (value), а не убирайте.');
                const reason = await decide({ intent: 'remove', objects: cardObjects(library, [card]), summary: `Убрать из карточки «${card.title}» проверки: ${named.map(item => `«${item.rule}»`).join('; ')}` });
                patch = { kind: 'upsert_variant', reason, variant: { ...structuredClone(card), semanticReviewRequired: true, evaluationSpec: { ...card.evaluationSpec, checkpoints: kept } } };
              } else {
                if (!change.value?.trim()) throw needsOwner('needs_owner_input', 'Нет нового текста. Спросите владельца, как должно быть.');
                const checkpoint = named[0];
                const owned = field === 'successCriteria' || field === 'checkpointRule';
                const texts = [change.value, ...(change.applicability ? [change.applicability] : [])];
                const reason = await decide({ intent: 'edit', ...(owned ? { attributed: texts } : { simulated: texts }), known: knownTexts(card), objects: cardObjects(library, [card]),
                  summary: `Карточка «${card.title}» · ${DIFF_FIELD[change.field] ?? change.field}: «${change.value}»${change.applicability ? ` · когда применимо: «${change.applicability}»` : ''}` });
                // A rule that also changes when it applies is a new state of the whole check, so the card is replaced as one owner edit.
                patch = checkpoint && change.applicability
                  ? { kind: 'upsert_variant', reason, variant: { ...structuredClone(card), semanticReviewRequired: true, evaluationSpec: { ...card.evaluationSpec,
                      checkpoints: checkpoints.map(item => item.id === checkpoint.id ? { ...item, rule: change.value!.trim(), applicability: change.applicability!.trim() } : item) } } }
                  : { kind: 'edit_variant_text', variantId: card.id, field, ...(checkpoint ? { checkpointId: checkpoint.id } : {}), value: change.value.trim(), editId, reason };
              }
            }
            headline = `Карточка «${safeText(card.title)}» изменена`;
          }
          const edited = await lab.editLibrary(draftId, expected, patch);
          const after = target ? edited.library.variants.find(item => item.id === target!.id) : undefined;
          const diff = target && after ? variantDiff(target, after) : [];
          return await changed(headline, changeRows(diff), after?.id, { recordedReason: patch.reason, diff }, `Правка сценариев · прогон ${shortRun(draftId)} · ревизия ${edited.library.revision}`);
        } catch (error) {
          if (/хеш устарел|библиотека изменилась/i.test(error instanceof Error ? error.message : '')) {
            const fresh = await reading(directory).readLibrary(draftId);
            markSeen(`${directory}|${draftId}`, libraryHash(fresh.library));
            markSeen(seenKey, libraryHash(fresh.library));
            const feed = libraryFeed(fresh.experiment);
            feed.rows.unshift(row(newerRevision ? `У этого набора есть ревизия новее, чем в прогоне ${shortRun(found.id)}: правки идут в неё. Ничего не записано; ниже она — решите по ней.`
              : 'Сценарии изменились с тех пор, как я их читал (доска или другая сессия). Ничего не записано; ниже свежее состояние.', 'warning', true));
            return feedResult(callId, { status: 'stale_library', mutated: false, ...output(fresh.experiment, fresh.library),
              instruction: 'The library changed since you last saw it. Decide again on this fresh state and repeat the operation if it still applies.' }, feed, `Сценарии изменились · прогон ${shortRun(draftId)}`);
          }
          throw error;
        } finally { if (!handedOver) await close(); }
      } catch (error) { return askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_edit'),
    name: 'agent_lab_edit', label: 'Edit an unapproved agent draft',
    description: 'Edit a draft after inspecting its current draftHash. scenarios upserts full cards by id and preserves omitted cards. Delete only explicitly with removeScenarioIds. AgentSpec, settings, target and targetVersion may also change. Human approval stays pending. Cannot change started experiments, run dialogues, record human verdicts, or approve results. Expectations of situations are changed by the owner through agent_lab_accept, not by this tool.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), patch: Type.Unsafe({ ...z.toJSONSchema(draftPatchSchema, { io: 'input' }), description: 'profileEdits replaces draft overrides on existing profiles and updates all linked cards. Original profiles and evidence stay intact. override:null restores original; persona:null clears persona; characteristics:[] clears traits. Omitted override fields use the original. Use scenarios to link/unlink profileId.' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      try {
        await lab.init();
        const patch = draftPatchSchema.parse(params.patch);
        // A higher spending limit is the owner's decision: in the terminal it is confirmed natively, never raised silently.
        const before = await lab.get(params.id);
        if (patch.settings?.maxCalls !== undefined && patch.settings.maxCalls > before.settings.maxCalls && ctx.hasUI && ctx.mode === 'tui'
          && !await ctx.ui.confirm('Увеличить лимит вызовов модели?', safeText(`Было: ${before.settings.maxCalls}. Станет: ${patch.settings.maxCalls}. Уже использовано ${before.usage.calls}; использованные вызовы не сбрасываются.`))) {
          return { content: [{ type: 'text', text: JSON.stringify({ id: before.id, cancelled: true, mutated: false, message: 'Лимит не изменён.' }) }], details: { cancelled: true } };
        }
        const record = await lab.updateDraft(params.id, params.expectedHash, patch);
        const output = summary(record, lab.store.directory);
        returnToBoard(ctx, record.id);
        focus.set(lab.store.directory, record.id);
        // What changed, in one row; the whole expectation sheet waits behind the expand key.
        const parts = [patch.target ? 'подключение к агенту' : '', patch.targetVersion ? `версия агента — ${patch.targetVersion}` : '', patch.settings ? 'настройки и лимиты' : '',
          patch.scenarios?.length || patch.removeScenarioIds?.length ? 'карточки' : '', patch.agent ? 'описание агента' : '', patch.profileEdits?.length ? 'профили клиентов' : ''].filter(Boolean);
        const feed: Feed = { rows: [row(`Черновик обновлён: ${safeText(parts.join(', ') || 'без видимых изменений')}.`, 'success', true),
          row(`Агент: ${safeText(targetText(record).replaceAll(`${ctx.cwd}/`, ''))}${record.targetVersion ? ` · версия ${safeText(record.targetVersion)}` : ''}`, undefined, false, 1),
          row('После изменения запуск подтверждается заново.', 'muted', false, 1), ...stateRows(record)],
          ...(output.sheetLines ? { more: output.sheetLines.map(line => row(safeText(line))) } : {}) };
        return feedResult(callId, output, feed, `Черновик обновлён · прогон ${shortRun(record.id)}`);
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_accept'),
    name: 'agent_lab_accept', label: 'Confirm what the agent must do',
    description: "Show the owner what the agent must do in each situation of the set (or the complete one-test definition) and record their confirmation, or their own-words correction of one expectation. The text and the consent come from native Pi dialogs only; the model supplies neither. It never runs the agent, calls a model, or saves a suite.",
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для принятия теста нужен интерактивный терминал. В CLI используйте accept --id RUN --yes.');
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
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
    ...displayFor('agent_lab_repeat'),
    name: 'agent_lab_repeat', label: 'Prepare another run of the same cards',
    description: 'Copy a previously approved evaluation into a fresh draft without model generation: the way to check a new agent version on the same cards. Preserves cards, materials and settings, captures current local code identity, clears results and approvals; the source run is kept. scenarios names the cards to repeat by title or number; omit for the whole set. Then use agent_lab_run, and agent_lab_inspect compare:true for before/after.',
    parameters: Type.Object({ id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run to repeat: id, short id or words of its task. Omit for the run this conversation works on.' })),
      scenarios: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 40, description: 'Cards to repeat, by title or number in the run. Omit for the whole set.' })),
      scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40, description: 'Repeat only these existing tests by exact id; omit for the whole regression set.' })),
      controlScenarioIds: Type.Optional(Type.Array(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), { minItems: 1, maxItems: 5, description: 'Mark existing situations as positive controls: real dialogues the agent is known to handle. They are shown apart and never enter the headline number. Each control runs as one turn (the opening and the agent\'s first reply, no simulator), so simulator drift cannot hide a broken judge or connection; controls are left out of the repeat diff.' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const source = await findRun(directory, params.id, ctx);
        const titles = source.scenarios.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
        const chosen = params.scenarioIds ?? params.scenarios?.map(ref => {
          const wanted = ref.trim().toLocaleLowerCase('ru');
          const matches = /^#?\d+$/.test(wanted) ? [source.scenarios[Number(wanted.replace('#', '')) - 1]].filter(item => !!item)
            : source.scenarios.filter(item => item.id === ref || item.title.toLocaleLowerCase('ru').includes(wanted));
          if (matches.length !== 1) throw needsOwner(matches.length ? 'ambiguous_reference' : 'unknown_reference',
            matches.length ? `«${ref}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Ситуации «${ref}» в прогоне ${shortRun(source.id)} нет.`, titles.slice(0, 15));
          return matches[0]!.id;
        });
        const { lab, close } = await open(ctx.cwd);
        try {
          await lab.init();
          const record = await lab.repeat(source.id, chosen, params.controlScenarioIds);
          focus.set(directory, record.id);
          returnToBoard(ctx, record.id);
          const moved = !!source.targetFingerprint && !!record.targetFingerprint && source.targetFingerprint !== record.targetFingerprint;
          const feed: Feed = { rows: [row(`Подготовлен повтор: ${record.scenarios.length} из ${source.scenarios.length} ситуаций прогона ${shortRun(source.id)}. Исходный прогон сохранён.`, 'success', true),
            row(moved ? 'Код агента изменился с прошлого прогона: проверяется новая версия.' : 'Код агента с прошлого прогона не менялся.', moved ? 'accent' : 'muted', false, 1),
            row('Ожидания те же, результаты и подтверждения очищены. После запуска результат сравнится с исходным прогоном.', 'muted', false, 1), ...stateRows(record)],
            more: record.scenarios.map((item, index) => row(`${index + 1}. ${safeText(item.title)}`, undefined, false, 1)) };
          return feedResult(callId, { ...summary(record, lab.store.directory), sourceRunId: source.id, agentCodeChanged: moved }, feed, `Повтор прогона ${shortRun(source.id)} → ${shortRun(record.id)}`);
        } finally { await close(); }
      } catch (error) { return askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_issues'), name: 'agent_lab_issues', label: 'Постоянные проблемы',
    description: 'Прочитать постоянные проблемы и точные исходные оценки, обновить индекс из прогона, восстановить индекс или сохранить подтверждённое владельцем объединение. Название само по себе не доказывает общий механизм. inspect id принимает проблему или прогон.',
    parameters: Type.Object({ operation: Type.Union(['inspect', 'sync', 'rebuild', 'merge'].map(value => Type.Literal(value))), id: Type.Optional(Type.String()), assessmentId: Type.Optional(Type.String()), offset: Type.Optional(Type.Number({ minimum: 0 })), eventOffset: Type.Optional(Type.Number({ minimum: 0 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })), decision: Type.Optional(Type.Unsafe(z.toJSONSchema(issueDecisionSchema))) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted(); const { lab, close } = await open(ctx.cwd);
      try {
        if (params.operation !== 'inspect') {
          if (params.operation === 'merge') {
            const decision = issueDecisionSchema.parse(params.decision);
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Объединение требует решения владельца в интерактивном терминале.');
            if (!await ctx.ui.confirm('Объединить проблемы?', safeText(`${decision.fromIssueId} → ${decision.intoIssueId}\n${decision.reason}`))) return { content: [{ type: 'text', text: JSON.stringify({ cancelled: true }) }], details: { cancelled: true } };
          }
          await lab.init();
          if (params.operation === 'sync') { if (!params.id) throw new Error('Укажите исходный прогон.'); await lab.store.syncIssues(await lab.get(params.id)); }
          else if (params.operation === 'merge') await lab.store.decideIssue(issueDecisionSchema.parse(params.decision));
          else await lab.store.rebuildIssues();
        }
        const journal = await lab.store.readIssueJournal();
        const output = compactIssues(journal, params.operation === 'inspect' ? params : {});
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_resolution'), name: 'agent_lab_resolution', label: 'Проверка исправления',
    description: 'Dev-пакет, отдельный кандидат, заранее сохранённое правило с воспроизводящим и регрессионным наборами и два раздельных решения. Промпт требует фактически подтверждённых человеком dev-ошибок.',
    parameters: Type.Object({ operation: Type.Union(['bundle','candidate','prompt','prepare','inspect','run','resolve'].map(v=>Type.Literal(v))), id: Type.Optional(Type.String()), input: Type.Optional(Type.Any()), offset:Type.Optional(Type.Number({minimum:0})), limit:Type.Optional(Type.Number({minimum:1,maximum:20})), trialId:Type.Optional(Type.String()) }, {additionalProperties:false}),
    executionMode: 'sequential',
    async execute(_callId,params,signal,_onUpdate,ctx) {
      signal?.throwIfAborted(); const {lab,close}=await open(ctx.cwd);
      try {
        const input=params.input ?? {}; let output:unknown;
        if(params.operation==='inspect') { if(!params.id) throw new Error('Укажите политику.'); const file=await lab.store.readResolution(params.id); output=compactResolution(file,params); }
        else if(params.operation==='bundle') output=compactFixBundle(await lab.createFixBundle(input.issueId,input.sourceRunId),params);
        else {
          if(params.operation==='run') {
            if(!params.id) throw new Error('Укажите политику.');
            if(!ctx.hasUI||ctx.mode!=='tui') throw new Error('Запуск требует подтверждения в терминале; CLI resolutions --operation run --id POLICY --yes.');
            if(!await ctx.ui.confirm('Запустить проверку исправления?',safeText(resolutionRunText(await lab.store.readResolution(params.id),await lab.get((await lab.store.readResolution(params.id)).policy.candidateRunId))))) return {content:[{type:'text',text:JSON.stringify({cancelled:true})}],details:{cancelled:true}};
          }
          await lab.init();
          if(params.operation==='candidate') { const draft=await lab.registerCandidate(input.sourceRunId,input); output={id:draft.id,sourceRunId:draft.parentRunId,phase:draft.phase,targetVersion:draft.targetVersion,scenarioCount:draft.scenarios.length,repeats:draft.settings.repeats,plannedTrials:plannedTrials(draft)}; }
          else if(params.operation==='prompt') output=await lab.proposeIssueFix(input.issueId,input.sourceRunId,input);
          else if(params.operation==='prepare') { const policy=await lab.prepareResolution(resolutionRequestSchema.parse(input)); output=compactResolution({policy},params); }
          else if(params.operation==='resolve'&&params.id) { const {issue,...file}=await lab.resolveIssue(params.id); output={...compactResolution(file,params),issue:{id:issue.id,status:issue.status}}; }
          else if(params.operation==='run'&&params.id) {
            const run=await lab.startResolution(params.id,{approved:true}),cancel=()=>{void lab.cancel(run.id);}; signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted) cancel();
            try {await lab.waitForIdle();} finally {signal?.removeEventListener('abort',cancel);}
            const file=await lab.resolveIssue(params.id); output=compactResolution(file,params);
          } else throw new Error('Укажите действие и ID политики.');
        }
        return {content:[{type:'text',text:JSON.stringify(output,null,2)}],details:{}};
      } finally {await close();}
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_diagnostics'), name: 'agent_lab_diagnostics', label: 'Парная диагностика',
    description: 'prepare сохраняет неизменный план одной гипотезы без вызовов агента, inspect читает план, парный результат и исходные трассы, run запускает оба плеча через общий исполнитель после native подтверждения бюджета. Диагностика исключена из точности и не закрывает дефекты. Неподдерживаемое вмешательство отклоняется до расхода.',
    parameters: Type.Object({ operation: Type.Union(['prepare', 'inspect', 'run'].map(value => Type.Literal(value))), id: Type.Optional(Type.String()), trialId: Type.Optional(Type.String()), offset: Type.Optional(Type.Number({ minimum: 0 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })), input: Type.Optional(Type.Unsafe(z.toJSONSchema(diagnosticPreparationSchema))) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, _onUpdate, ctx) {
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s)); signal.throwIfAborted();
      const { lab, close } = await open(ctx.cwd); let runId: string | undefined;
      const cancel = () => { if (runId) void lab.cancel(runId).catch(() => {}); };
      try {
        let output: unknown;
        if (params.operation === 'prepare') {
          const request = diagnosticPreparationSchema.parse(params.input); await lab.init();
          const plan = await lab.prepareDiagnostic(request.issueId, request.sourceRunId, request.intervention, request.repeats);
          output = compactDiagnostic(await lab.store.readDiagnostic(plan.id));
        } else {
          if (!params.id) throw new Error('Укажите ID сохранённого плана.');
          let file = await lab.store.readDiagnostic(params.id);
          if (params.operation === 'run' && !file.runId) {
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Запуск диагностики требует интерактивного подтверждения. В CLI используйте diagnostics --operation run --id PLAN --yes.');
            const plan = file.plan;
            const text = `${plan.intervention.hypothesis}\nОдин фактор: ${plan.intervention.kind}\nИсходный снимок: ${plan.sourceHash.slice(0, 12)}\nПар: ${plan.repeats * plan.source.settings.userModes.length}; общий лимит ${plan.budget.maxCalls} вызовов, ${Math.round(plan.budget.maxDurationMs / 1000)} секунд.\nДиагностика не закрывает проблему и не входит в общую точность.`;
            if (!await ctx.ui.confirm('Запустить парную диагностику?', safeText(text))) return { content: [{ type: 'text', text: JSON.stringify({ cancelled: true }) }], details: { cancelled: true } };
            signal.throwIfAborted(); await lab.init();
            runId = (await lab.startDiagnostic(params.id)).id; signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
            await lab.waitForIdle(); file = await lab.store.readDiagnostic(params.id);
          }
          output = compactDiagnostic(file, file.runId ? await lab.get(file.runId) : undefined, params);
          if (file.runId) returnToBoard(ctx, file.runId);
        }
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { signal.removeEventListener('abort', cancel); await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_run'), name: 'agent_lab_run', label: 'Run the accepted set',
    description: 'start (default): run the accepted set of one run after a native confirmation of the exact plan shown: agent and version, set, attempts, models and spending limits. A short run ends in this row; a long one continues in the background, the conversation stays free and the result arrives as a message. progress: read how far the run (or a preparation of scenarios that continues in the background) is, from stored data. stop: stop the run or the preparation of this session and keep what is recorded; only when the owner asks. Does not record human review of expectations or results. Cannot run headlessly or without the human confirmation. Never bypass this tool through shell or internal APIs.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the run this conversation works on.' })),
      action: Type.Optional(Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('progress')])),
      expectedHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$', description: 'Optional: refuse when the draft differs from the one you inspected. The confirmation always refers to the state it shows.' })),
      ownerQuote: Type.Optional(Type.String({ maxLength: 1000, description: 'stop: the owner\'s exact words asking to stop.' })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const action = params.action ?? 'start';
      const directory = resolve(ctx.cwd, '.agent-lab');
      const job = boardRun?.directory === directory ? boardRun : undefined;
      try {
        if (action === 'progress') {
          // A named run is answered about that run; only a request without a reference means «the one going on now».
          const named = params.id ? await findRun(directory, params.id, ctx) : undefined;
          const record = job && (!named || named.id === job.id) ? await job.lab.get(job.id) : named ?? await findRun(directory, undefined, ctx);
          const running = activePhases.has(record.phase);
          // A preparation of this session is answered in its own words: no dialogue is planned before the scenarios exist.
          const preparing = record.phase === 'preparing';
          const unusable = record.trials.filter(trial => trial.outcome === 'invalid' || trial.outcome === 'cancelled').length;
          const feed: Feed = { rows: running ? progressLines(record).map(line => row(safeText(line), 'accent')) : [row(`Прогон ${shortRun(record.id)} сейчас не идёт.`, 'muted'), ...stateRows(record)] };
          if (preparing) return feedResult(callId, { id: record.id, phase: record.phase, running, preparation: true, ownedByThisSession: !!job && job.id === record.id, usage: record.usage, maxCalls: record.settings.maxCalls,
            ...(job?.id === record.id ? { instruction: 'The preparation continues in the background; its result will arrive as a message. Do not poll.' } : {}) },
            feed, `Подготовка ${shortRun(record.id)}`);
          return feedResult(callId, { id: record.id, phase: record.phase, running, ownedByThisSession: !!job && job.id === record.id, finishedDialogues: record.trials.length, plannedDialogues: plannedTrials(record), unusable, usage: record.usage, maxCalls: record.settings.maxCalls },
            feed, `Прогресс прогона ${shortRun(record.id)}`);
        }
        if (action === 'stop') {
          if (!job) throw new Error('В этой сессии нет идущего прогона или подготовки. Работа, запущенная в другой сессии Pi, останавливается только там.');
          const preparation = job.kind === 'preparation';
          const going = `${preparation ? 'подготовка' : 'прогон'} ${shortRun(job.id)}`;
          // The run the owner named must be the one that is going: another run is never stopped in its place.
          if (params.id) {
            const named = await findRun(directory, params.id, ctx);
            if (named.id !== job.id) throw needsOwner('needs_owner_input', `Назван прогон ${shortRun(named.id)}, а сейчас идёт ${going}. Ничего не остановлено. Спросите владельца, останавливать ли ${preparation ? 'идущую' : 'идущий'}.`, [],
              `Вы назвали прогон ${shortRun(named.id)}, а сейчас идёт ${going}. Я ничего не остановил — остановить ${preparation ? 'её' : 'идущий'}?`);
          }
          // Stopping throws away attempts in flight, and a stopped run cannot be continued: the owner's own words must ask for it
          // («не останавливай» is not such a request); otherwise the native dialog decides.
          if (!ownerAsked(ownerMessages(ctx), 'stop', params.ownerQuote).asked) {
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error(`Остановка ${preparation ? 'подготовки' : 'прогона'} требует просьбы владельца или native-подтверждения.`);
            if (!await ctx.ui.confirm(preparation ? 'Остановить подготовку?' : 'Остановить прогон?', preparation ? 'Разбор остановится. Уже собранные карточки сохранятся в черновике.'
              : 'Текущие попытки будут остановлены. Уже записанные диалоги сохранятся. Продолжить этот прогон потом нельзя.')) {
              return preparation ? feedResult(callId, { cancelled: true, mutated: false }, { rows: [row('Подготовка продолжается.', 'muted')] }, 'Подготовка продолжается')
                : feedResult(callId, { cancelled: true, mutated: false }, { rows: [row('Прогон продолжается.', 'muted')] }, 'Прогон продолжается');
            }
          }
          job.quiet = true;
          // A preparation that ended on its own in the meantime has nothing to cancel; what it saved is reported all the same.
          await job.lab.cancel(job.id).catch(error => { if (!preparation) throw error; }); await job.done;
          const record = await reading(directory).get(job.id);
          if (preparation) {
            const saved = preparationStoppedLines(record);
            const library = record.librarySnapshot;
            if (library) markSeen(`${directory}|${record.id}`, libraryHash(library));
            return feedResult(callId, { id: record.id, phase: record.phase, stopped: true, savedVariants: library?.variants.length ?? 0, savedRequirements: record.requirements.length, usage: record.usage, message: saved.join(' ') },
              { rows: saved.map((line, index) => row(safeText(line), index ? 'muted' : 'warning', !index)) }, `Подготовка ${shortRun(record.id)} остановлена`);
          }
          const lines = stoppedLines(record);
          return feedResult(callId, { id: record.id, phase: record.phase, stopped: true, savedDialogues: record.trials.length, plannedDialogues: plannedTrials(record), message: lines.join(' ') },
            { rows: lines.map((line, index) => row(safeText(line), index ? 'muted' : 'warning', !index)) }, `Прогон ${shortRun(record.id)} остановлен`);
        }
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для нового запуска нужен интерактивный терминал. В CI используйте evaluate --input suite.json --yes с явно заданным бюджетом.');
        const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
        signal.throwIfAborted();
        const found = await findRun(directory, params.id, ctx);
        focus.set(directory, found.id);
        const owned = await open(ctx.cwd);
        let detached = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let polling: Promise<void> = Promise.resolve();
        try {
          await owned.lab.init();
          const draft = await owned.lab.get(found.id);
          const hash = draftHash(draft);
          if (draft.workflow !== 'evaluate' || (params.expectedHash && params.expectedHash !== hash)) throw new Error('План изменился. Прочитайте актуальный черновик через agent_lab_inspect.');
          if (draft.phase !== 'review') throw new Error(activePhases.has(draft.phase) ? `Прогон ${shortRun(draft.id)} уже идёт.`
            : `Прогон ${shortRun(draft.id)} уже выполнен, его результат не меняется. Чтобы проверить снова, подготовьте повтор (agent_lab_repeat).`);
          if (draft.librarySnapshot && !draft.librarySnapshot.acceptance) throw needsOwner('needs_owner_input',
            'Набор ещё не принят: после разбора логов или правки карточек владелец принимает набор заново. Покажите сценарии и предложите принять готовые; запуск будет после этого.');
          // UI-D-02 in chat: unconfirmed expectations are confirmed in the same native dialog that starts the run.
          const confirmed = draft.acceptedDraftHash === hash;
          const plan = runPlan(draft, ctx.cwd);
          if (!await ctx.ui.confirm(confirmed ? 'Запустить проверку?' : 'Подтвердить ожидания и запустить?', plan)) {
            const output = { id: draft.id, cancelled: true, message: 'Запуск отменён. Тесты сохранены; не повторяйте запрос запуска без новой просьбы пользователя.' };
            return { content: [{ type: 'text' as const, text: JSON.stringify(output) }],
              details: rememberFeed(callId, { rows: [row('Запуск отменён. Набор сохранён, агент не запускался.', 'warning')] }, 'Запуск отменён') };
          }
          signal.throwIfAborted();
          if (!confirmed) await owned.lab.acceptDraft(draft.id, hash);
          await owned.lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: hash, parallel: runParallel(draft), requireAccepted: true });
          const progress = async () => {
            const r = await owned.lab.get(draft.id);
            const text = safeText(progressLine(r));
            ctx.ui.setStatus?.('agent-lab-progress', text);
            onUpdate?.({ content: [{ type: 'text', text: `${text}\n${safeText(r.message)}` }], details: { id: r.id, phase: r.phase } });
          };
          await progress();
          timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
          // A short run ends in this row. A long one, or Esc, hands the run to the session: interrupting the action never stops the run.
          const inline = await new Promise<boolean>(settle => {
            const wait = setTimeout(() => settle(false), inlineRunMs);
            const onAbort = () => settle(false);
            signal.addEventListener('abort', onAbort, { once: true });
            void owned.lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(wait); signal.removeEventListener('abort', onAbort); });
          });
          clearInterval(timer); timer = undefined; await polling;
          if (!inline) {
            const record = await owned.lab.get(draft.id);
            detached = true;
            detach(ctx, directory, owned, draft.id, 'chat');
            const lines = progressLines(record);
            return feedResult(callId, { id: draft.id, background: true, phase: record.phase, finishedDialogues: record.trials.length, plannedDialogues: plannedTrials(record),
              instruction: 'The run continues in the background and its result will arrive as a message. Tell the owner in one short sentence and end your turn; do not poll. Reads (scenarios, recorded dialogues) still work; edits and new runs wait until it ends.' },
              { rows: [row('Прогон запущен и идёт в фоне.', 'success', true), ...lines.map(line => row(safeText(line), undefined, false, 1)),
                row('Разговор свободен: готовые диалоги и сценарии можно смотреть. Результат появится здесь отдельным сообщением.', 'muted', false, 1),
                row('Esc прерывает только текущее действие. Чтобы остановить прогон, так и напишите.', 'muted', false, 1)] }, `Прогон ${shortRun(draft.id)} идёт в фоне`);
          }
          await progress();
          // `content` stays the model's JSON plus C-119; the session holds ids only (REV-01, T-04-03):
          // the block is drawn from the remembered view, never from text written into the 0644 session file.
          const { output, details } = await verdictOutput(await owned.lab.get(draft.id), owned.lab);
          returnToBoard(ctx, draft.id);
          return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details };
        } finally {
          clearInterval(timer); await polling;
          if (!detached) { ctx.ui.setStatus?.('agent-lab-progress', undefined); await owned.close(); }
        }
      } catch (error) { return askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_suite'), name: 'agent_lab_suite', label: 'Save or load reusable tests',
    description: 'Save selected tests as a versionable .evals/*.json file, or load that file into a fresh draft without model generation. Preserves original provenance and criteria. Clears results and approvals. Saving never overwrites an existing file. Use after a useful finding or when the user wants a regression test. Loading does not run it; inspect then use agent_lab_run.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('save'), Type.Literal('load'), Type.Literal('list')]), connectionFile: Type.Optional(Type.String()), file: Type.String({ minLength: 1 }),
      id: Type.Optional(Type.String()), scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
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
    ...displayFor('agent_lab_connection'), name: 'agent_lab_connection', label: 'Check agent connection',
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
    ...displayFor('agent_lab_reassess'), name: 'agent_lab_reassess', label: 'Reassess recorded evidence',
    description: 'Evaluate new checks/rubrics on existing trial traces without calling the target or simulator. Creates a separate immutable result retaining the original run. codeOnly uses no model; judge overrides are optional. This cannot demonstrate an agent improvement. Ask native confirmation before model spending.',
    parameters: Type.Object({ id: Type.String(), input: Type.Optional(Type.Unsafe(z.toJSONSchema(reassessmentSchema, { io: 'input' }))) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const input = reassessmentSchema.parse(params.input ?? {});
      const { lab, close } = await open(ctx.cwd);
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
    ...displayFor('agent_lab_review'), name: 'agent_lab_review', label: 'Ask for a human verdict',
    description: 'Show a recorded dialogue and its evidence, then ask the human to choose a verdict and explanation in native Pi UI. Call after discussing a concrete finding. Only id and trialId are accepted: the model cannot supply a human verdict. Cancellation saves no annotation. After a confirmed dev failure, use agent_lab_prompt for a requested fix.',
    parameters: Type.Object({ id: Type.String(), trialId: Type.String() }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, _onUpdate, ctx) {
      const { id, trialId } = z.strictObject({ id: z.string().uuid(), trialId: z.string().min(1) }).parse(params);
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Вердикт человека требует интерактивного терминала.');
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
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Отметку о решении судьи ставит только владелец в интерактивном терминале.');
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const record = await findRun(directory, params.id, ctx);
        if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Отметить согласие с судьёй можно в завершённом прогоне.');
        const view = buildResultView(record);
        const titles = record.scenarios.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
        const wanted = String(params.failure ?? params.dialogue ?? '').trim();
        if (!wanted) throw needsOwner('needs_owner_input', 'Не сказано, о какой ситуации речь. Спросите владельца.', titles.slice(0, 15));
        const remembered = recallShown(ctx, 'failures', record.id) ?? view.failures.map(item => item.scenarioId);
        const scenarioId = params.failure !== undefined && /^#?\d+$/.test(wanted) ? remembered[Number(wanted.replace('#', '')) - 1]
          : /^#?\d+$/.test(wanted) ? record.scenarios[Number(wanted.replace('#', '')) - 1]?.id
          : record.scenarios.filter(item => item.title.toLocaleLowerCase('ru').includes(wanted.toLocaleLowerCase('ru'))).map(item => item.id).find((_, index, all) => all.length === 1);
        const scenario = record.scenarios.find(item => item.id === scenarioId);
        if (!scenario) throw needsOwner('unknown_reference', `Ситуация «${wanted}» не найдена однозначно. Спросите владельца, какая нужна.`, titles.slice(0, 15));
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
            row(safeText(fresh.headline.text), answer === 'disagree' ? 'accent' : 'muted', false, 1)] };
          return feedResult(callId, { id: record.id, scenarioId: scenario.id, trialId: trial.id, answer, headline: fresh.headline.text, checkedFailures: agreement.failures.checked, queueFailures: agreement.queueFailures.length }, feed,
            `Отметка владельца · прогон ${shortRun(record.id)}`);
        } finally { await close(); }
      } catch (error) { return askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_prompt'), name: 'agent_lab_prompt', label: 'Review one prompt change',
    description: 'propose saves an isolated candidate prompt and diff, citing human-confirmed dev failures. Never use control feedback. apply requires native diff review and creates a draft with the EXACT same capability/regression cards and a candidate promptFile; then use agent_lab_run. Adapter must attest promptHash. Original prompt file is preserved.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('propose'), Type.Literal('inspect'), Type.Literal('apply')]),
      id: Type.Optional(Type.String()), file: Type.Optional(Type.String()), candidate: Type.Optional(Type.String({ maxLength: 96000 })),
      hypothesis: Type.Optional(Type.String({ maxLength: 3000 })), trialIds: Type.Optional(Type.Array(Type.String(), { maxItems: 40 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
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
      // Opening history is a read, not a writer operation. In particular, never call init()
      // here: it acquires the lock and recovers running records as interrupted.
      const directory = resolve(ctx.cwd, '.agent-lab');
      const reader = new ExperimentLab(directory);
      let lab = reader;
      let lease: Awaited<ReturnType<typeof open>> | undefined;
      const reading = () => boardRun?.directory === directory ? boardRun.lab : reader;
      const release = async () => {
        const owned = lease; lease = undefined; lab = reader;
        if (owned) await owned.close();
      };
      const writing = async () => {
        if (lease) return;
        const owned = await open(ctx.cwd);
        try { await owned.lab.init(); lease = owned; lab = owned.lab; }
        catch (error) { await owned.close(); throw error; }
      };
      try {
        let id = startRequest || args.trim() === 'demo' ? undefined : args.trim() || undefined;
        if (id) {
          const candidates = (await reading().list()).filter(record => record.id === id || record.id.startsWith(id!));
          const exact = candidates.find(record => record.id === id);
          if (exact) id = exact.id;
          else if (candidates.length === 1) id = candidates[0]!.id;
          else throw new Error(candidates.length ? 'Нашлось несколько прогонов. Откройте /agent-lab и выберите нужный.' : 'Прогон не найден. Откройте /agent-lab, чтобы посмотреть историю.');
        }
        let section: Section | undefined;
        let selected = 0;
        let query = '';
        let pendingOnly = false;
        let dialogueOpen = false;
        let beforeId: string | undefined;
        let newRequested = startRequest;
        let demoRequested = args.trim() === 'demo';
        let reportPath: string | undefined;
        const scenarioSelections = new Map<string, string[]>();
        // Elapsed time with the dialogue visible plus its verdict form, including time spent idle.
        const reviewTimes = new Map<string, number>();
        let notice: BoardOptions['notice'];
        const inform = (message: string, kind: 'success' | 'info' | 'error' = 'success') => {
          notice = { message: safeText(message), kind };
        };
        while (true) {
          const record = id ? await reading().get(id) : undefined;
          if (record?.librarySnapshot && !scenarioSelections.has(record.id)) scenarioSelections.set(record.id, record.librarySnapshot.acceptance?.variantIds.slice()
            ?? record.librarySnapshot.variants.filter(variant => variant.quality === 'ready').map(variant => variant.id));
          const bundle = record ? await evidenceBundle(record, reader.store, beforeId) : undefined;
          const action: BoardAction = demoRequested ? { type: 'demo' } : newRequested ? { type: 'new' } : await showBoard(ctx, record
            ? { record, section, selected, query, pendingOnly, dialogueOpen, selectedVariantIds: scenarioSelections.get(record.id), comparison: bundle?.comparison, before: bundle?.before, notice, reportPath, reviewTimes,
                warnings: bundle?.warnings, view: bundle?.view, load: async () => evidenceBundle(await reading().get(record.id), reader.store, beforeId) }
            : { records: await reading().list(), loadRecords: () => reading().list(), notice, warnings: reader.store.diagnostics.map(d => `${d.id}: ${d.message}`) });
          notice = undefined;
          if ('record' in action && (action.record.updatedAt !== record?.updatedAt || action.record.phase !== record?.phase)) reportPath = undefined;
          if (action.type === 'demo') {
            demoRequested = false;
            try {
              await writing();
              const draft = await lab.create(demoEvaluationInput());
              await lab.waitForIdle();
              id = draft.id; section = 'cards'; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined;
              inform('Учебный пример: агенту не хватает инструмента изменения записи. r — найти провал. Модель и провайдер не нужны.');
            } catch (error) { inform(inputError(error), 'error'); }
            finally { await release(); }
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
          if (action.type === 'open') { id = action.id; section = undefined; selected = 0; query = ''; pendingOnly = false; dialogueOpen = false; beforeId = undefined; reportPath = undefined; continue; }
          if (action.type === 'close' || action.type === 'back') {
            // Navigating away is not cancellation. The session owns a started run until
            // completion (or Pi shutdown), independently of this board's lifetime.
            if (action.type === 'close') break;
            id = undefined; section = undefined; selected = 0; query = ''; pendingOnly = false; dialogueOpen = false; beforeId = undefined; reportPath = undefined; continue;
          }
          section = action.section; selected = action.selected;
          if ('selectedVariantIds' in action) scenarioSelections.set(action.record.id, action.selectedVariantIds);
          query = 'query' in action ? action.query ?? '' : ''; pendingOnly = 'pendingOnly' in action ? action.pendingOnly ?? false : false;
          dialogueOpen = 'dialogueOpen' in action ? action.dialogueOpen ?? false : false;
          try {
            if (!['discuss', 'export', 'openReport', 'cancel', 'issues'].includes(action.type)) await writing();
            if (action.type === 'issues') {
              const next = await showIssueWorkspace(ctx, action.record, reading(), async () => { await writing(); return lab; });
              if (next) { id = next; section = 'results'; selected = 0; }
            } else if (action.type === 'acceptLibrary') {
              const shown = action.record.librarySnapshot;
              if (!shown) throw new Error('Библиотека сценариев отсутствует.');
              const accepted = await lab.acceptLibrary(action.record.id, libraryHash(shown), action.variantIds);
              scenarioSelections.set(action.record.id, accepted.library.acceptance!.variantIds.slice());
              section = 'agent'; selected = 0;
              inform(`Принята ревизия ${accepted.library.revision}: ${action.variantIds.length} вариантов. Агент не запускался. 3 — проверить план запуска.`);
            } else if (action.type === 'editScenario') {
              const shown = action.record.librarySnapshot;
              if (!shown) throw new Error('Библиотека сценариев отсутствует.');
              const variant = shown.variants.find(item => item.id === action.variantId);
              if (!variant) throw new Error('Выбранный вариант уже отсутствует.');
              const textFields = [
                { label: 'Первая реплика пользователя', field: 'opening' as const, value: variant.userState.opening },
                { label: 'Цель пользователя', field: 'goal' as const, value: variant.userState.goal },
                { label: 'Ожидаемый результат', field: 'successCriteria' as const, value: variant.evaluationSpec.successCriteria },
                ...variant.evaluationSpec.checkpoints.map(checkpoint => ({ label: `Правило проверки · ${checkpoint.id}`, field: 'checkpointRule' as const, value: checkpoint.rule, checkpointId: checkpoint.id })),
              ];
              const factOptions = variant.userState.facts.map(fact => safeText(`Факт · ${fact.statement} · ${fact.availability}`));
              const options = [...textFields.map(item => item.label), ...factOptions, 'Добавить факт владельца'];
              const picked = await ctx.ui.select('Что изменить своими словами?', options);
              if (!picked) continue;
              const textField = textFields.find(item => item.label === picked);
              if (textField) {
                const value = await ctx.ui.editor(`${textField.label} · обычным текстом`, textField.value);
                if (!value?.trim() || value.trim() === textField.value) continue;
                const reason = await ctx.ui.editor('Почему вы вносите эту правку?', 'Правка владельца в разделе «Сценарии»');
                if (!reason?.trim()) continue;
                await lab.editLibrary(action.record.id, libraryHash(shown), { kind: 'edit_variant_text', variantId: variant.id,
                  field: textField.field, ...('checkpointId' in textField ? { checkpointId: textField.checkpointId } : {}), value: value.trim(),
                  editId: `owner_${Date.now().toString(36)}`, reason: reason.trim() });
              } else {
                const fact = variant.userState.facts[factOptions.indexOf(picked)];
                const adding = picked === 'Добавить факт владельца';
                if (!fact && !adding) continue;
                const statement = await ctx.ui.editor('Факт пользователя · обычным текстом', fact?.statement ?? '');
                if (statement === undefined || !statement.trim()) continue;
                const currentValue = fact?.value === undefined ? '' : String(fact.value);
                const valueText = await ctx.ui.editor('Точное значение · оставьте пустым, если отдельного значения нет', currentValue);
                if (valueText === undefined) continue;
                const availability = await ctx.ui.select('Когда пользователь знает этот факт?', ['initial · знает до разговора', 'learned_in_source · узнал только в старом разговоре', 'uncertain · нужно уточнить']);
                if (!availability) continue;
                const reason = await ctx.ui.editor('Почему вы исправляете факт?', 'Правка владельца в разделе «Сценарии»');
                if (!reason?.trim()) continue;
                await lab.editLibrary(action.record.id, libraryHash(shown), { kind: adding ? 'add_fact' : 'edit_fact', variantId: variant.id, factId: fact?.id ?? `fact_${Date.now().toString(36)}`,
                  statement: statement.trim(), ...(valueText.trim() ? { value: valueText.trim() } : {}), availability: availability.split(' ')[0] as 'initial' | 'learned_in_source' | 'uncertain',
                  editId: `owner_${Date.now().toString(36)}`, reason: reason.trim() });
              }
              scenarioSelections.set(action.record.id, []);
              inform('Правка записана как явное решение владельца. Цитаты источников сохранены. Выполните смысловую проверку: g.');
            } else if (action.type === 'variant') {
              const shown = action.record.librarySnapshot;
              if (!shown) throw new Error('Библиотека сценариев отсутствует.');
              const variant = shown.variants.find(item => item.id === action.variantId);
              if (!variant) throw new Error('Выбранный вариант уже отсутствует.');
              const labels = ['Раскрыть известный факт только по запросу', 'Сделать известный факт отсутствующим', 'Неоднозначная первая реплика', 'Смена намерения на выбранном шаге', 'Временный сбой update_record'];
              const operation = await ctx.ui.select('Какой целевой вариант добавить?', labels);
              if (!operation) continue;
              let requestInput: Record<string, unknown>;
              if (operation === labels[0] || operation === labels[1]) {
                const facts = variant.userState.facts.filter(fact => fact.availability === 'initial');
                const choices = facts.map(fact => safeText(fact.statement));
                const fact = facts[choices.indexOf(await ctx.ui.select('Какой известный факт изменить?', choices) ?? '')];
                if (!fact) continue;
                const value = String(fact.value ?? '');
                const suggestedOpening = value ? variant.userState.opening.replaceAll(value, '').replace(/\s{2,}/g, ' ').trim() : variant.userState.opening;
                const opening = await ctx.ui.editor('Первая реплика без выбранного значения', suggestedOpening);
                if (!opening?.trim()) continue;
                const ifAsked = await ctx.ui.editor('Как понять, что агент запросил этот факт?', `Агент запросил: ${fact.statement.split(':')[0]}`);
                if (!ifAsked?.trim()) continue;
                let missingDescription: string | undefined;
                if (operation === labels[1]) {
                  const separator = fact.statement.indexOf(':');
                  const suggested = separator > 0 ? fact.statement.slice(0, separator).trim() : fact.id.replaceAll('_', ' ');
                  const written = await ctx.ui.editor('Название отсутствующих данных без секретного значения', suggested);
                  if (!written?.trim()) continue;
                  missingDescription = written.trim();
                }
                requestInput = { factId: fact.id, opening: opening.trim(), ifAsked: ifAsked.trim(), ...(missingDescription ? { missingDescription } : {}) };
              } else if (operation === labels[2]) {
                const opening = await ctx.ui.editor('Новая неоднозначная первая реплика', variant.userState.opening);
                if (!opening?.trim()) continue;
                requestInput = { opening: opening.trim() };
              } else if (operation === labels[3]) {
                const choices = variant.behaviorPolicy.actions.map(item => `${item.id} · ${item.kind}${item.kind === 'finish' ? ' · сменить намерение вместо завершения' : ''}`);
                const chosen = await ctx.ui.select('После какого шага сменить намерение?', choices);
                const actionId = chosen?.split(' · ')[0];
                if (!actionId) continue;
                const intent = await ctx.ui.editor('Новое намерение пользователя', '');
                if (!intent?.trim()) continue;
                requestInput = { intent: intent.trim(), afterActionId: actionId };
              } else {
                const failures = await ctx.ui.editor('Сколько первых update_record завершатся временной ошибкой?', '1');
                if (!failures || !/^\d+$/.test(failures.trim())) continue;
                requestInput = { operation: 'update_record', failures: Number(failures) };
              }
              const reason = await ctx.ui.editor('Зачем нужен этот синтетический вариант?', operation);
              if (!reason?.trim()) continue;
              const kind = operation === labels[0] ? 'reveal_on_request' : operation === labels[1] ? 'missing_fact' : operation === labels[2] ? 'ambiguous_opening' : operation === labels[3] ? 'changed_intent' : 'tool_failure';
              const proposed = await lab.proposeVariant(action.record.id, libraryHash(shown), { parentId: variant.id, operation: kind, reason: reason.trim(), input: requestInput });
              scenarioSelections.set(action.record.id, []);
              selected = proposed.library.variants.findIndex(item => item.id === proposed.variant.id);
              inform(`Добавлен синтетический вариант «${safeText(proposed.variant.title)}». Он требует смысловой проверки.`);
            } else if (action.type === 'removeVariant') {
              const shown = action.record.librarySnapshot;
              if (!shown) throw new Error('Библиотека сценариев отсутствует.');
              const variant = shown.variants.find(item => item.id === action.variantId);
              if (!variant || !await ctx.ui.confirm('Удалить вариант из новой ревизии?', safeText(`${variant.title}\nИсходный импорт и прошлые снимки сохранятся.`))) continue;
              await lab.editLibrary(action.record.id, libraryHash(shown), { kind: 'remove_variant', variantId: variant.id, reason: 'Владелец удалил вариант в native workspace' });
              scenarioSelections.set(action.record.id, action.selectedVariantIds.filter(id => id !== variant.id));
              inform('Вариант удалён из новой ревизии; исходный импорт и прошлые прогоны сохранены.');
            } else if (action.type === 'mergeScenarios') {
              const shown = action.record.librarySnapshot;
              if (!shown) throw new Error('Библиотека сценариев отсутствует.');
              const targets = shown.businessScenarios.filter(group => group.id !== action.businessScenarioId);
              const labels = targets.map(group => safeText(`${group.title} · ${group.goal}`));
              const target = targets[labels.indexOf(await ctx.ui.select('С какой группой объединить выбранную?', labels) ?? '')];
              if (!target) continue;
              const reason = await ctx.ui.editor('Почему это один бизнес-сценарий?', 'Решение владельца о группировке');
              if (!reason?.trim()) continue;
              await lab.editLibrary(action.record.id, libraryHash(shown), { kind: 'merge_business', targetId: target.id, sourceIds: [action.businessScenarioId], reason: reason.trim() });
              scenarioSelections.set(action.record.id, []); inform('Группы объединены. Выполните смысловую проверку: g.');
            } else if (action.type === 'splitScenario') {
              const shown = action.record.librarySnapshot;
              if (!shown) throw new Error('Библиотека сценариев отсутствует.');
              const source = shown.businessScenarios.find(group => group.id === action.businessScenarioId);
              if (!source) throw new Error('Группа уже отсутствует.');
              const title = await ctx.ui.editor('Название новой бизнес-группы', `${source.title} · отдельный случай`);
              const goal = title === undefined ? undefined : await ctx.ui.editor('Цель новой бизнес-группы', source.goal);
              const reason = goal === undefined ? undefined : await ctx.ui.editor('Почему вариант нужно отделить?', 'Решение владельца о группировке');
              if (!title?.trim() || !goal?.trim() || !reason?.trim()) continue;
              await lab.editLibrary(action.record.id, libraryHash(shown), { kind: 'split_business', businessScenarioId: source.id,
                newBusiness: { key: `split_${Date.now().toString(36)}`, title: title.trim(), goal: goal.trim(), conditions: source.conditions,
                  requirementIds: source.requirementIds, grouping: { status: 'confirmed', reason: reason.trim() } }, variantIds: [action.variantId], reason: reason.trim() });
              scenarioSelections.set(action.record.id, []); inform('Вариант выделен в отдельную бизнес-группу. Выполните смысловую проверку: g.');
            } else if (action.type === 'assessLibrary') {
              const shown = action.record.librarySnapshot;
              if (!shown) throw new Error('Библиотека сценариев отсутствует.');
              const plan = semanticWorkStatus(shown); const remaining = Math.max(0, action.record.settings.maxCalls - action.record.usage.calls);
              if (!remaining && plan.pendingJobs) { inform(`Осталось ${plan.pendingJobs} смысловых вызовов, бюджет исчерпан. b — увеличить maxCalls; использованный бюджет не сбрасывается.`, 'error'); continue; }
              if (!await ctx.ui.confirm('Запустить смысловую проверку?', `Осталось ${plan.pendingJobs} из ${plan.totalJobs} вызовов · сохранено ${plan.completedJobs} · доступно сейчас ${remaining}.${plan.pendingJobs > remaining ? ` Будет выполнено до ${remaining}, частичный результат сохранится.` : ''} Ожидающие источники: ${action.record.preparationProgress?.pending.length ?? 0}; они не будут обработаны этой операцией.`)) continue;
              await lab.assessLibrary(action.record.id, libraryHash(shown)); await lab.waitForIdle();
              scenarioSelections.set(action.record.id, []); inform('Смысловая проверка завершена. Просмотрите замечания и выберите готовые варианты.');
            } else if (action.type === 'editBudget') {
              const current = await lab.get(action.record.id);
              const written = await ctx.ui.editor('Новый общий потолок model calls · уже использованные вызовы сохранятся', String(current.settings.maxCalls));
              const maxCalls = Number(written);
              if (!Number.isInteger(maxCalls) || maxCalls <= current.usage.calls) { inform(`Введите целое число больше уже использованных ${current.usage.calls}.`, 'error'); continue; }
              await lab.updateDraft(current.id, draftHash(current), { settings: { maxCalls } });
              inform(`Общий потолок увеличен до ${maxCalls}; использовано ${current.usage.calls}.`);
            } else if (action.type === 'discuss') {
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
              const next = await lab.repeat(action.record.id);
              beforeId = action.record.id; id = next.id; section = 'cards'; selected = 0; query = ''; pendingOnly = false; dialogueOpen = false; reportPath = undefined;
              inform(`Создан повтор того же набора: ${next.scenarios.length} ситуаций. Исходный прогон сохранён. Проверьте ожидания перед новым запуском.`);
            } else if (action.type === 'run') {
              const r = await lab.get(action.record.id);
              if (r.workflow !== 'evaluate') throw new Error('Legacy comparison records cannot run from the evaluation board.');
              const hash = draftHash(r);
              // UI-D-02: an unconfirmed draft confirms every expectation and starts in one dialog.
              const confirmed = r.acceptedDraftHash === hash;
              const plan = runPlan(r, ctx.cwd);
              if (await ctx.ui.confirm(confirmed ? 'Запустить проверку?' : 'Подтвердить ожидания и запустить?', plan)) {
                if (!confirmed) await lab.acceptDraft(r.id, hash);
                await lab.start(r.id, { approved: true, reviewer: 'expectations', expectedHash: hash, parallel: runParallel(r), requireAccepted: true });
                // The session owns the run from here: leaving the board, or the conversation going on, never stops it.
                const owned = lease!;
                lease = undefined; lab = reader;
                detach(ctx, directory, owned, r.id, 'board');
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
              const job = boardRun;
              if (!job || job.directory !== directory || job.id !== action.record.id) {
                throw new Error('Этот прогон запущен в другой сессии. Здесь доступен просмотр; остановите его в сессии, которая его запустила.');
              }
              if (!await ctx.ui.confirm('Остановить прогон?', 'Текущие попытки будут остановлены. Уже записанные диалоги сохранятся. Для возврата в историю останавливать прогон не нужно.')) continue;
              await job.lab.cancel(action.record.id); await job.done;
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
            const message = scenarioErrorText(error);
            inform(message.startsWith('Сначала подтвердите ожидания ситуаций') ? `${message} y — подтвердить.` : message, 'error');
          } finally { await release(); }
        }
      } finally { await release(); }
      if (handoff) {
        pi.sendMessage({ customType: 'agent-lab-context', content: JSON.stringify(handoff.context), display: false }, { deliverAs: 'followUp' });
        pi.sendUserMessage(handoff.request, { deliverAs: 'followUp', expandPromptTemplates: false });
      }
    },
  });
  pi.on('session_shutdown', async () => { await activeClose?.(); });
}
