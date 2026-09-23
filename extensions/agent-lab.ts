import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { z } from 'zod';
import { ExperimentLab, draftHash, resultHash } from '../src/experiment.js';
import { agentSchema, createInputSchema, DEFAULT_JUDGE, dialogueSchema, draftPatchSchema, reassessmentSchema, runnableTargetSchema, isRunning, SCENARIO_LIMIT, settingsSchema, type Experiment } from '../src/contracts.js';
import { plannedTrials } from '../src/run.js';
import { expectationSheet, testPlanLines, trialProofLines } from '../src/quality.js';
import { demoInput } from '../src/demo.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { buildResultView, type ResultView } from '../src/result-view.js';
import { MAX_WIDTH, nextRows, plainText, resultScreen } from '../src/result-text.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from '../src/connection.js';
import { readData, selectValidationDialogues, readDialogueImport, importDialogues } from '../src/imports.js';
import { expandMaterials } from '../src/materials.js';
import { MATERIAL_CHARS, MATERIAL_LIMIT } from '../src/limits.js';
import { libraryHash } from '../src/scenario-library.js';
import { countsText, situationData, situationEntry, situationViews } from '../src/card/view.js';
import { safeText, shortId } from '../src/text.js';
import { identifierPattern, isIdentifier, sha256Pattern } from '../src/ids.js';
import { sameTargetVersion } from '../src/target-version.js';
import { isVerdictDetails, rememberView, renderAgentLabResult, VERDICT_KIND, type VerdictDetails } from './render/verdict-block.ts';
import { isFeedDetails, rememberFeed, renderFeedResult } from './render/feed.ts';
import { comparisonFeed, dialogueFeed, failureFeed, progressLines, referenceProblem, targetText, resolveRun, statusFeed, stoppedLines, row, type Feed, type Resolved } from './conversation.ts';
import { registerCardTools, situationFeed, situationsFeed, situationsNow } from './card-tools.ts';
import { launchRun } from './launch.ts';
import { registerBoardCommand } from './board-command.ts';
import { registerReviewTools } from './review-tools.ts';
import { progressLine } from './flow.ts';
import { SessionOperations, type SessionOperation as Job } from './operations.ts';
import { displayFor, inputError, legacyResult, NeedsOwner, returnToBoard, isInteractive, requireInteractive } from './lab-ui.ts';

/** C-119: what the model reads instead of the block, so it does not restate the number and the causes (CTX-08). */
const SHOWN_TO_OWNER = 'Блок с точностью и причинами уже показан владельцу. Не копируйте его строки. Назовите точность одной фразой и объясните по-человечески, где и почему агент хромает: что просили клиенты, что агент сделал вместо этого, какое правило владельца это нарушает; что он делает хорошо и насколько числу можно верить. Затем предложите следующий шаг.';


/** `view` is the evidence bundle's view when the caller has one, so stability matches the CLI summary. */
function summary(record: Experiment, directory: string, view?: ResultView) {
  const comparison = record.comparisons.findLast(c => c.split === 'control');
  const block = record.trials.length ? view ?? buildResultView(record) : undefined;
  // A draft carries its whole expectation sheet, so what the agent must do stays in the chat history (UI-SPEC Chat step 5).
  const sheet = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length ? expectationSheet(record) : undefined;
  return {
    ...(sheet ? { sheetLines: sheet.lines } : {}),
    // Lead with the answer: the same screen the board and the CLI show — the number, the trust line, the
    // causes, every error, what was not measured and the owner's disagreements — then the view it is made of.
    ...(block ? { resultLines: plainText(resultScreen(block, { surface: 'board', details: true }), MAX_WIDTH).split('\n'), view: block } : {}),
    id: record.id, runKind: record.runKind ?? 'evaluation', phase: record.phase, mode: record.mode, workflow: record.workflow,
    reviewMode: record.reviewMode, resultsReviewedAt: record.resultsReviewedAt,
    draftHash: draftHash(record), acceptedDraftHash: record.acceptedDraftHash, resultHash: record.trials.length ? resultHash(record) : undefined,
    message: record.message, error: record.error, questions: record.questions,
    scenarioCount: record.scenarios.length, revisionCount: record.revisions.length,
    target: record.target, dialogueCount: record.dialogues.length,
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
    nextStep: block ? nextRows(block, 'chat')[0]?.text : undefined,
    artifacts: { evidence: resolve(directory, `${record.id}.json`),
      ...(record.trials.length ? { traceJournal: resolve(directory, `${record.id}.trace.jsonl`) } : {}) },
  };
}

/**
 * What the model is told about the conversation. The four stages stay the product logic; they are
 * no longer a route through four screens, and no answer may be a list of keys to press.
 */
const LAB_PROMPT = `
You are Agent Lab, a conversational tool for measuring the user's real agent. The owner works with you the way they work with a coding agent: they say what they want in plain words, you do the work with the Agent Lab tools, show a short result and continue in the same conversation. Work in their project and follow the agent-builder skill.

How to talk:
- Act, do not instruct. Never answer with navigation or keys to press. /agent-lab is an optional board for bulk work; never send the owner there to get something done.
- The product has three steps: Ситуации › Прогон › Результат. It is the logic of the product, not a route through screens: do the step the owner asked for, in any order that is valid.
- Every tool result is already shown to the owner as a short card whose details expand in place. Never re-list its situations, dialogue lines, numbers or plan. Your reply is the conclusion and the next useful step, one to three sentences in the owner's language, without ids, hashes or JSON.
- Name runs the way the owner does (by task words or list number) and situations by their number. When a tool answers that a reference is unknown or ambiguous, ask the owner which one they mean; never pick for them.
- Use what the request and the situation already contain. Ask only for a business decision you cannot find there; never invent a rule, a fact value or what the agent must do to complete a call.
- The first accuracy number matters more than a perfect set. Right after preparation, when at least one situation is ready, offer to run the ready ones at once; the questions wait and never block them.
- When you do not know what exists in this project, call agent_lab_status first.
- A situation that waits for the owner has one question with 2–3 numbered answers. When the owner answers it, call agent_lab_card_answer: the owner picks the answer in a native dialog.
- Several changes asked for in one message: make them all, with verify:"later" on every change but the last.

Situations: agent_lab_build prepares them — mode=validate from de-identified dialogues, otherwise from the owner's rules. agent_lab_cards lists them — number, title, status and the one question — and card:N shows one whole: what the customer wants, writes first and knows (fact ids f1…) and when they leave; what the agent must do (duty ids e1…), each with the owner's rule. Read a situation by its number before changing it. Change a situation with the narrow tools: agent_lab_card_fact (what the customer knows and when they say it), agent_lab_card_expectation (what the agent must do), agent_lab_card_client (what the customer wants, writes first, when they leave, their late turn), agent_lab_card_similar (a new situation with one difference, the original unchanged), agent_lab_card_remove. What the customer knows is always the owner's decision in a native dialog; wording the owner wrote in their own message is recorded as it is, other wording is shown to the owner to confirm. An edit asked for after a run goes into a fresh draft of the same set by itself — the finished run never changes; say so in one phrase. A changed situation is checked again within the agreed calls: a quick check answers in the same row, a longer one reports back as a message — never wait for it or poll. agent_lab_card_check checks what is still unchecked; agent_lab_resume_preparation continues a stopped preparation and never repeats a paid call whose cost is unknown. Situations of an older format are shown the same way and cannot be changed.

Accepting and running are the owner's decisions in one native dialog: agent_lab_run shows the plan — the ready situations, conversations, the judge's ceiling and the limits — and accepts the ready situations as it starts; agent_lab_accept accepts them without running when the owner asks only for that. Never start a run because a situation was opened.

A long run continues in the background: the conversation stays free, progress above the input comes from stored data, and the result arrives as a message. Esc interrupts your current action, not the run; stop a run only when the owner asks, with agent_lab_run action:"stop", then say what was saved and that a repeat runs every attempt again. A long preparation of scenarios (agent_lab_build) is handed over the same way: the scenarios arrive as a message, so never wait for it or poll; agent_lab_run action:"progress" and action:"stop" work for it too, and stopping it keeps the partial draft.

Results: after separate native execution confirmation, lead with one estimated card accuracy number on the accepted set, grounded failure causes, separate metrics and limits, and keep measured and unmeasured counts visible; save the suite when useful. When a run ends, the block already shows the accuracy and each main cause with what was expected, what the agent said and the owner rule. Close the run yourself in three to five plain sentences: the accuracy number, where the agent limps and why (the pattern across failures: what clients asked, what the agent did instead, which owner rule that breaks), what it handles well, and how far the number can be trusted. Do not copy the block's rows. agent_lab_agree records the owner's own agreement or disagreement with the judge about one situation (the owner answers in a native dialog; you never supply the answer) — offer it after showing a failure, because it is what makes the number trustworthy. agent_lab_inspect failure:N opens a failure with its dialogue, expectation and owner rule; dialogue opens any recorded dialogue; compare:true compares a repeat with its source run. «Повтори этот случай на новой версии и сравни» is agent_lab_repeat with the cards by title or number, then agent_lab_run, then agent_lab_inspect compare:true. This is accuracy on the validation set, never a calibrated production guarantee.
Execution consent remains separate from accepting a test and from reviewing results. Preserve budgets and model, cite actual event IDs, never invent a human verdict, and do not modify an external agent unless the user asked to fix it.`;


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
const RUN_MESSAGE = 'agent-lab-run';
const CHECK_MESSAGE = 'agent-lab-check';
const BUILD_MESSAGE = 'agent-lab-build';
/** Custom session entry that keeps a shown list (ids only) across a restart of Pi. */
const SHOWN_ENTRY = 'agent-lab-shown';
/** What a finished preparation answers with: the model JSON and, for a prepared library, the feed of its scenarios. */
type Prepared = { output: Record<string, unknown>; feed?: Feed; note?: string };
/** After a stopped preparation: what the partial draft holds. Counts only — the same lines go into the session file. */
const preparationStoppedLines = (record: Experiment): string[] => {
  const cards = record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : 0;
  return [`Подготовка ${shortId(record.id)} ${record.error ? 'остановлена' : 'успела завершиться до остановки'}.`, cards
    ? `Сохранён черновик: ситуаций ${cards}. Их можно смотреть и менять; подготовку можно продолжить с того же места.`
    : `Ситуации собрать не успели. Запись сохранена: правил ${record.requirements.length}, вызовов модели ${record.usage.calls}.`];
};

/** Conversational execution asks the human to authorize a concrete plan; it never invents human reviews. */
interface AgentLabOptions { inlineRunMs?: number; inlineCheckMs?: number; inlineBuildMs?: number; createLab?: (directory: string) => ExperimentLab }
export default function agentLab(pi: ExtensionAPI, options: AgentLabOptions = {}) {
  const inlineRunMs = options.inlineRunMs ?? 20_000;
  /** A recheck that finishes this fast is reported in the row of the edit; a longer one reports back as a message. */
  const inlineCheckMs = options.inlineCheckMs ?? 3_000;
  const inlineBuildMs = options.inlineBuildMs ?? 5_000;
  const operations = new SessionOperations(options.createLab);
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
  const open = (cwd: string, pendingCheck: 'cancel' | 'wait' = 'cancel') => operations.acquire(resolve(cwd, '.agent-lab'), pendingCheck);
  /** All surfaces read the live executor when this session owns it, otherwise the durable record. */
  const reading = (directory: string): ExperimentLab => operations.reader(directory);
  const runName = (record: Experiment): string => `${shortId(record.id)} «${safeText(record.task).slice(0, 60)}»`;
  /** The run a request means: an id, a short id, task words, or — with no reference — the run this conversation works on. Never a silent guess among several. */
  const findRun = async (directory: string, ref?: string, ctx?: Parameters<typeof recallShown>[0]): Promise<Experiment> => {
    const reader = reading(directory);
    const wanted = ref?.trim();
    if (wanted && isIdentifier(wanted)) { try { return await reader.get(wanted); } catch { /* a short id or task words: look through the list */ } }
    const stored = await reader.list();
    // Numbers resolve against the list the owner was shown; without one, against the same newest-first order the list uses.
    const shown = recallShown(ctx, 'runs', directory) ?? [];
    const rank = (record: Experiment): number => { const at = shown.indexOf(record.id); return at < 0 ? shown.length : at; };
    const records = [...stored].sort((x, y) => rank(x) - rank(y) || y.updatedAt.localeCompare(x.updatedAt));
    if (wanted) {
      const resolved: Resolved<Experiment> = resolveRun(records, wanted);
      if (resolved.kind === 'one') return resolved.item;
      throw new NeedsOwner(resolved.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference',
        referenceProblem('Прогон', wanted, resolved, (resolved.kind === 'many' ? resolved.items : records).map(runName)));
    }
    const focused = records.find(record => record.id === focus.get(directory));
    if (focused) return focused;
    const current = records.filter(record => ['preparing', 'review', 'evaluating', 'results_review'].includes(record.phase));
    if (current.length === 1) return current[0]!;
    if (records.length === 1) return records[0]!;
    if (!records.length) throw new NeedsOwner('unknown_reference', 'В этом проекте ещё нет прогонов. Сначала соберите сценарии: нужны агент и, если есть, логи.');
    throw new NeedsOwner('ambiguous_reference', `Неясно, о каком прогоне речь. Спросите владельца: ${records.slice(0, 8).map(runName).join('; ')}.`, records.slice(0, 8).map(runName));
  };
  const feedResult = (callId: string, output: unknown, feed: Feed, note: string) =>
    ({ content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: rememberFeed(callId, feed, note) });
  /** An owner question becomes an ordinary result: the feed shows what to clarify, the model is told not to guess. */
  const askOwner = (callId: string, error: unknown) => {
    if (!(error instanceof NeedsOwner)) throw error;
    const message = safeText(error.message);
    return feedResult(callId, { status: error.code, mutated: false, message, options: error.options,
      instruction: 'Nothing was written. Put this question to the owner in plain words; do not pick an option or invent a value yourself.' },
      { rows: [row(safeText(error.ownerText ?? message), 'warning'), ...error.options.map(option => row(`• ${safeText(option)}`, undefined, false, 1))] }, 'Agent Lab · нужно уточнение владельца');
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
  const detach = (ctx: ExtensionContext, _directory: string, owned: Awaited<ReturnType<typeof open>>, id: string, origin: Job['origin'], prepared?: (finished: Experiment) => Promise<Prepared>): Job => {
    const widget = prepared ? BUILD_MESSAGE : RUN_MESSAGE;
    let shown = '';
    return operations.present(owned, { kind: prepared ? 'preparation' : 'run', id, origin,
      progress: async job => {
      const record = await job.lab.get(id);
      const lines = progressLines(record).map(line => safeText(line));
      if (lines.join('\n') === shown) return;
      shown = lines.join('\n');
      ctx.ui.setStatus?.('agent-lab-progress', safeText(progressLine(record)));
      ctx.ui.setWidget?.(widget, [...lines, prepared ? 'Разговор свободен. Остановить подготовку — так и напишите; Esc её не останавливает.'
        : 'Разговор свободен. Остановить прогон — так и напишите; Esc его не останавливает.']);
      },
      complete: async job => {
        const finished = await owned.lab.get(id);
        returnToBoard(ctx, id);
        const complete = finished.phase === 'results_review' || finished.phase === 'complete';
        if (prepared) {
          // A stop the owner asked for is answered in its own row; every other ending reports back, a failed one as plainly as a finished one.
          if (!job.quiet) {
            const answer = await prepared(finished);
            const failed = [`Подготовка ${shortId(id)} не завершена${finished.phase === 'cancelled' ? ': она остановлена' : ''}.`, ...(finished.error ? [safeText(finished.error)] : [])];
            pi.sendMessage({ customType: BUILD_MESSAGE, display: true, content: JSON.stringify(answer.output),
              details: answer.feed ? rememberFeed(`build:${id}:${finished.updatedAt}`, answer.feed, answer.note ?? `Сценарии прогона ${shortId(id)}`)
                : rememberFeed(`build:${id}:${finished.updatedAt}`, { rows: finished.phase === 'review' && !finished.error ? [row('Подготовка завершена. Агент не запускался.', 'success', true)]
                  : failed.map((line, index) => row(line, index ? 'error' : 'warning', !index)) }, `Подготовка ${shortId(id)}`),
            }, { deliverAs: 'followUp', triggerTurn: true });
          }
        } else if (origin === 'board') ctx.ui.notify?.(complete ? `Проверка завершена: /agent-lab ${shortId(id)} — открыть результат.`
          : `Проверка ${shortId(id)} остановлена. Записанные диалоги доступны в истории.`, 'info');
        else if (!job.quiet) {
          const announced = complete ? await verdictOutput(finished, owned.lab) : undefined;
          const stopped = stoppedLines(finished);
          pi.sendMessage({ customType: RUN_MESSAGE, display: true,
            content: JSON.stringify(announced?.output ?? { id, phase: finished.phase, error: finished.error, trialCount: finished.trials.length, plannedTrials: plannedTrials(finished), message: stopped.join(' ') }),
            details: announced && isVerdictDetails(announced.details) ? announced.details
              : rememberFeed(`run:${id}:${finished.updatedAt}`, { rows: [...stopped.map(line => row(line, 'warning')), ...(finished.error ? [row(safeText(finished.error), 'error')] : [])] }, `Прогон ${shortId(id)} остановлен`),
          }, { deliverAs: 'followUp', triggerTurn: true });
        }
      },
      error: error => ctx.ui.notify?.(`Не удалось завершить ${prepared ? 'подготовку' : 'проверку'}: ${inputError(error)}`, 'error'),
      clear: () => { ctx.ui.setStatus?.('agent-lab-progress', undefined); ctx.ui.setWidget?.(widget, undefined); },
    });
  };
  /**
   * The answer of a preparation that has ended, in the row of its call or as the message of one that outlived it: the
   * situations found — the counts, who waits for an answer, every situation on expand — and that the agent did not run.
   */
  const preparedAnswer = async (lab: ExperimentLab, record: Experiment, interrupted: boolean): Promise<Prepared> => {
    const output = summary(record, lab.store.directory);
    if (record.librarySnapshot?.formatVersion !== 2 || record.phase !== 'review') return { output };
    const context = await lab.cardContext(record.id);
    const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
    const feed = situationsFeed(context.experiment, views);
    const ready = views.filter(view => view.status === 'ready').length;
    feed.rows.unshift(row(interrupted ? 'Подготовка прервана; собранное сохранено.' : context.library.imports.length ? 'Ситуации собраны из логов. Агент не запускался.' : 'Ситуации собраны по вашим правилам. Агент не запускался.',
      interrupted ? 'warning' : 'success', true));
    // The first number should not wait for every question: what is ready can run now.
    feed.rows.push(row(ready ? `Готовые (${ready}) можно запустить сразу — первая точность будет по ним; вопросы подождут.`
      : 'Готовых ситуаций пока нет: у каждой сказано, что нужно, — ответ на её вопрос сделает её готовой.', 'accent', false, 2));
    return { output: { ...output, counts: countsText(views), situations: views.map(situationEntry) }, feed, note: `Ситуации прогона ${shortId(record.id)}` };
  };
  const backgroundPreparation = (ctx: ExtensionContext, owned: Awaited<ReturnType<typeof open>>, id: string): void => {
    detach(ctx, owned.directory, owned, id, 'chat', finished => preparedAnswer(owned.lab, finished, !!finished.error));
  };
  /**
   * A check of changed situations too long for the row of its command. The conversation goes on; the outcome arrives as
   * a message — quietly when the situation is ready, with a turn when the owner has something to decide.
   */
  const backgroundCheck = (ctx: ExtensionContext, owned: Awaited<ReturnType<typeof open>>, id: string, card: number | undefined): void => {
    let shown = '';
    let usedBefore: number | undefined;
    operations.present(owned, { kind: 'assessment', id, origin: 'chat',
      progress: async () => {
        const record = await owned.lab.get(id);
        usedBefore ??= record.usage.calls;
        const text = `Проверяю ситуации · вызовов модели: ${record.usage.calls - usedBefore}`;
        if (text === shown) return;
        shown = text;
        ctx.ui.setWidget?.(CHECK_MESSAGE, [text, 'Можно продолжать: новая правка перезапустит проверку, проверенное не пропадёт.']);
      },
      complete: async check => {
        if (check.quiet) return;
        const context = await owned.lab.cardContext(id);
        const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
        const view = card === undefined ? undefined : views.find(item => item.number === card);
        const failed = context.experiment.phase !== 'review' || !!context.experiment.error;
        const feed: Feed = failed ? { rows: [row(`Проверка не завершилась: ${safeText(context.experiment.error ?? context.experiment.message)}`, 'warning', true)] }
          : view ? situationFeed(view) : situationsFeed(context.experiment, views);
        pi.sendMessage({ customType: CHECK_MESSAGE, display: true,
          content: JSON.stringify({ status: failed ? 'check_failed' : 'check_finished', runId: id, ...(view ? { situation: situationData(view) } : { counts: countsText(views) }),
            instruction: 'The background check of changed situations finished. Mention it only if the owner has something to decide.' }),
          details: rememberFeed(`check:${id}:${context.experiment.updatedAt}`, feed, `Проверка ситуаций · прогон ${shortId(id)}`),
        }, { deliverAs: 'followUp', triggerTurn: failed || (view ? view.status !== 'ready' : views.some(item => item.status === 'needs_owner')) });
      },
      error: error => ctx.ui.notify?.(`Проверка не завершилась: ${inputError(error)}`, 'error'),
      clear: () => ctx.ui.setWidget?.(CHECK_MESSAGE, undefined),
    });
  };
  // The result message of background work: the same verdict block or feed a tool row would draw.
  for (const kind of [RUN_MESSAGE, CHECK_MESSAGE, BUILD_MESSAGE]) pi.registerMessageRenderer?.(kind, (message, renderOptions, theme) => {
    const text = typeof message.content === 'string' ? message.content : '';
    const result = { content: [{ type: 'text' as const, text: isFeedDetails(message.details) ? message.details.note : text }], details: message.details };
    return renderFeedResult(result, { expanded: renderOptions.expanded, isPartial: false }, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult));
  });
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1' || !isInteractive(ctx)) return;
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
    description: 'Prepare agent checks. mode=validate selects up to 15 measurable prompt/RAG cases from up to 300 de-identified dialogues, grounds expectations in owner requirements and gives user facts to a reactive simulator; unavailable customer data and masked-only utterances are excluded. It does not run the agent. mode=demo is the built-in example.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: MATERIAL_CHARS }), kind: Type.Optional(Type.Union([Type.Literal('knowledge'), Type.Literal('prompt')], { description: "'prompt' marks the agent's own system prompt: observable rules are extracted from it and every generated card gets the prompt_compliance rubric" })) }, { additionalProperties: false }), { minItems: 1, maxItems: MATERIAL_LIMIT, description: 'Short materials written inline. For files and folders use materialFiles/promptFiles instead of pasting their text: Lab reads them whole.' })),
      materialFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 50, description: 'Knowledge articles: paths of files (.docx, .md, .txt, .html) or folders, absolute or relative to the project. Lab reads every file itself, verbatim; pass the path the owner named, never a retyped excerpt. Hundreds of articles are fine: for each dialogue the model picks the relevant ones from the table of contents.' })),
      promptFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20, description: "Files holding the agent's own system prompt(s) (kind 'prompt'), read whole by Lab." })),
      existingAgent: Type.Optional(Type.Unsafe(z.toJSONSchema(agentSchema))),
      settings: Type.Optional(Type.Unsafe(z.toJSONSchema(settingsSchema, { io: 'input' }))),
      scenarioCount: Type.Optional(Type.Integer({ minimum: 0, maximum: SCENARIO_LIMIT })),
      validationCount: Type.Optional(Type.Integer({ minimum: 1, maximum: SCENARIO_LIMIT, description: 'Cards in mode=validate; defaults to 15.' })),
      connectionFile: Type.Optional(Type.String()), dialoguesFile: Type.Optional(Type.String()),
      withoutDialogues: Type.Optional(Type.Boolean({ description: 'Set true only when the user explicitly chose to start without real dialogues. Otherwise ask for optional JSON/JSONL logs before building a live run.' })),
      target: Type.Optional(Type.Unsafe(z.toJSONSchema(runnableTargetSchema, { io: 'input' }))),
      targetVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Agent release, commit or remote deployment version.' })),
      dialogues: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(z.json()).max(300), { io: 'input' }))),
      mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('demo'), Type.Literal('validate')])),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const { dialoguesFile, connectionFile, withoutDialogues, materialFiles, promptFiles, validationCount: requestedValidation, ...rest } = params;
      const operation = rest.mode ?? 'live';
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const materialNotes: string[] = [];
      if (materialFiles?.length || promptFiles?.length) {
        // Lab reads the owner's files itself: whole articles, no retyping by the model, no per-call item limit.
        const expanded = await expandMaterials({ materials: rest.materials, materialFiles, promptFiles }, ctx.cwd);
        rest.materials = expanded.materials;
        materialNotes.push(`Прочитано из файлов: ${expanded.read}.`);
        for (const item of expanded.skipped.slice(0, 20)) materialNotes.push(`Пропущен ${item.file}: ${item.reason}.`);
        if (expanded.skipped.length > 20) materialNotes.push(`…и ещё ${expanded.skipped.length - 20} пропущенных файлов.`);
      }
      let dialogues: unknown;
      const libraryImport = operation !== 'demo' && (dialoguesFile || rest.dialogues)
        ? dialoguesFile ? await readDialogueImport(resolve(ctx.cwd, dialoguesFile)) : importDialogues(rest.dialogues) : undefined;
      try { dialogues = libraryImport ? libraryImport.dialogues.slice(0, operation === 'validate' ? 300 : 200) : (dialoguesFile ? await readData(resolve(ctx.cwd, dialoguesFile), { maxItems: operation === 'validate' ? 300 : 200 }) : rest.dialogues); }
      catch (error) {
        if (operation !== 'validate') throw error;
        throw new Error(safeText(`Не удалось прочитать записи: ${error instanceof Error ? error.message : String(error)}. Исправьте JSON/JSONL и повторите команду; агент не запускался.`));
      }
      let parsedDialogues: z.infer<typeof dialogueSchema>[];
      try { parsedDialogues = z.array(dialogueSchema).max(operation === 'validate' ? 300 : 200).parse(dialogues ?? []); }
      catch (error) {
        if (operation !== 'validate') throw error;
        throw new Error(safeText(`Не удалось прочитать записи: ${error instanceof Error ? error.message : String(error)}. Исправьте JSON/JSONL и повторите команду; агент не запускался.`));
      }
      if (operation === 'validate' && !parsedDialogues.length && !libraryImport?.originalImport.dialogues.length) throw new Error('Для validation set укажите JSON/JSONL с обезличенными реальными диалогами.');
      if (operation !== 'demo' && !parsedDialogues.length && !libraryImport?.originalImport.dialogues.length && withoutDialogues !== true) {
        const output = { status: 'needs_input', message: 'Есть реальные диалоги с агентом? Укажите файл JSON/JSONL с обезличенными разговорами или скажите «начать без логов».',
          nextStep: 'Ask the user in ordinary language. Import their supplied dialoguesFile/dialogues, or set withoutDialogues=true after their explicit choice to skip. Do not silently skip or search unrelated logs.' };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
      }
      const supplied = (rest.settings ?? {}) as Partial<z.infer<typeof settingsSchema>>;
      const sourceDialogueCount = libraryImport?.originalImport.dialogues.length ?? parsedDialogues.length;
      const validationCount = operation === 'validate' ? requestedValidation ?? 15 : 0;
      if (operation === 'validate') {
        parsedDialogues = selectValidationDialogues(parsedDialogues, Math.min(40, validationCount * 3));
        if (!parsedDialogues.length && !libraryImport?.originalImport.dialogues.length) throw new Error('В логах нет пригодных диалогов с 1–16 репликами пользователя без полностью замаскированных реплик.');
        requireInteractive(ctx, 'Для сборки validation set нужен native Pi confirmation в интерактивном терминале.');
      }
      const mode = operation === 'demo' ? 'demo' : 'live';
      const connection = mode === 'demo' ? undefined : connectionFile ? await readConnection(resolve(ctx.cwd, connectionFile)) : !rest.target ? await rememberedConnection(resolve(ctx.cwd, '.agent-lab')) : undefined;
      let input: z.infer<typeof createInputSchema>;
      // The built-in example is fixed: its own materials, dialogues and teaching agent.
      try { input = mode === 'demo' ? demoInput() : createInputSchema.parse({
        ...rest, ...(rest.target ? { target: projectTarget(rest.target, ctx.cwd) } : {}), scenarioCount: operation === 'validate' ? 0 : rest.scenarioCount ?? 1,
        mode, workflow: 'evaluate',
        ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(dialogues !== undefined ? { dialogues: parsedDialogues.slice(0, 200) } : {}),
        ...(libraryImport ? { originalImport: libraryImport.originalImport } : {}),
        settings: { repeats: 1,
          maxCalls: operation === 'validate' ? Math.max(140, 2 * parsedDialogues.length + 19 * validationCount + 20) : 20,
          maxDurationMs: operation === 'validate' ? Math.max(180_000, 180_000 * parsedDialogues.length) : 180_000,
          judge: DEFAULT_JUDGE,
          // Grounding many materials with a small model routinely exceeds the two-minute default per call.
          ...(operation === 'validate' ? { timeoutMs: 600_000 } : {}),
          ...supplied,
          ...(operation === 'validate' ? { maxTurns: 6, userModes: ['reactive'] } : {}),
          provider: supplied.provider || ctx.model?.provider || '', model: supplied.model || ctx.model?.id || '' },
      }); } catch (error) { throw plainInputError(error); }
      // The spending question comes last: a request that cannot start never asks the owner for money.
      if (operation === 'validate' && !await ctx.ui.confirm('Разобрать логи и собрать ситуации?', safeText([
        `Диалогов в выгрузке: ${sourceDialogueCount}; к разбору подходят ${parsedDialogues.length}; ситуаций получится не больше ${Math.min(validationCount, Math.max(parsedDialogues.length, 1))}.`,
        'Один подходящий диалог — одна ситуация. Диалоги без правил владельца или с недоступными данными клиента исключаются с причиной; прежние оценки не используются.',
        `Это расход на модель: не больше ${input.settings.maxCalls} вызовов и ${Math.ceil(input.settings.maxDurationMs / 60_000)} минут. Это потолок, а не прогноз: тратится только то, что понадобится на эти диалоги. Агент сейчас не запускается — запуск подтверждается отдельно.`,
      ].join('\n')))) return feedResult(callId, { status: 'cancelled', calls: 0, mutated: false, message: 'The owner declined. Nothing was spent or changed; do not ask again unless they request it.' },
        { rows: [row('Разбор логов отменён. Ничего не потрачено и не изменено.', 'warning')] }, 'Разбор логов отменён');
      const owned = await open(ctx.cwd);
      const { lab, close } = owned;
      // Only a terminal can take a preparation over: the hand-over draws its progress and delivers its result through `ctx.ui` and a message.
      const interactive = isInteractive(ctx) && !!ctx.ui;
      let handedOver = false;
      let id: string | undefined;
      let polling: Promise<void> = Promise.resolve();
      let timer: ReturnType<typeof setInterval> | undefined;
      let lastProgress = '';
      const progress = async () => {
        if (!id || !onUpdate) return;
        const record = await lab.get(id);
        const text = safeText(`${record.phase === 'preparing' ? 'Готовлю ситуации' : 'Ситуации готовы'}: ${record.message} · вызовов ${record.usage.calls}`);
        if (text !== lastProgress) { lastProgress = text; onUpdate({ content: [{ type: 'text', text }], details: { id, phase: record.phase } }); }
      };
      const cancel = () => { if (id) void lab.cancel(id).catch(() => {}); };
      try {
        await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
        /** The answer of a preparation that has ended — in the row of this call, or as the message of one that outlived it. */
        const prepared = async (record: Experiment, interrupted: boolean): Promise<Prepared> => {
          const bundle = await evidenceBundle(record, lab.store);
          const output = { ...summary(record, lab.store.directory, bundle.view),
            ...(operation === 'validate' ? { validation: { sourceDialogues: sourceDialogueCount, candidateDialogues: parsedDialogues.length, sampledDialogues: record.scenarios.length, estimatedAccuracyAfterRun: true } } : {}),
            ...(materialNotes.length ? { materialsFromFiles: materialNotes } : {}),
            artifacts: await exportArtifacts(bundle, lab.store.directory), ...(interrupted ? { cancelled: true } : {}) };
          returnToBoard(ctx, record.id);
          focus.set(lab.store.directory, record.id);
          // A prepared draft answers with the situations themselves: what was found, what is ready, what waits for the owner.
          // The answer adds the situations; the exported files and the validation counts of this call stay as they are.
          const situations = await preparedAnswer(lab, record, interrupted);
          return { ...situations, output: { ...situations.output, ...output } };
        };
        // In the terminal Esc interrupts the action, not the work: from here an abort hands the preparation over instead of cancelling it.
        if (interactive) signal.removeEventListener('abort', cancel);
        id = (await lab.create(input, { cards: true })).id;
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
              row('Esc прерывает только текущее действие. Чтобы остановить подготовку, так и напишите.', 'muted', false, 1)] }, `Подготовка ${shortId(id)} идёт в фоне`);
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
        const beforeId = typeof params.compare === 'string' ? (await findRun(directory, params.compare, ctx)).id : undefined;
        const bundle = await evidenceBundle(record, lab.store, beforeId);
        const controlVisible = record.workflow === 'evaluate' || !!record.controlConsumedAt && !isRunning(record.phase);
        const visible = (trial: Experiment['trials'][number] | undefined) => {
          if (trial?.split === 'control' && !controlVisible) throw new Error('Control evidence stays hidden until the final control phase stops.');
          return trial;
        };
        returnToBoard(ctx, record.id);
        const note = `Результаты прогона ${shortId(record.id)}`;
        if (params.failure !== undefined) {
          const view = bundle.view;
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
          if (matches.length !== 1) throw new NeedsOwner(matches.length ? 'ambiguous_reference' : 'unknown_reference',
            matches.length ? `Провал «${wanted}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Провала «${wanted}» в списке нет: всего провалов ${view.failures.length}.`, titles);
          const index = view.failures.indexOf(matches[0]!);
          const trial = visible(bundle.record.trials.find(item => item.id === matches[0]!.trialId));
          return feedResult(callId, { failure: { number: index + 1, of: view.failures.length, title: matches[0]!.title, kind: matches[0]!.kind, lines: matches[0]!.lines }, trial },
            failureFeed(bundle.record, view, index)!, `Провал ${index + 1} из ${view.failures.length} · прогон ${shortId(record.id)}`);
        }
        if (params.dialogue || params.trialId) {
          let trial = params.trialId ? bundle.record.trials.find(item => item.id === params.trialId) : undefined;
          if (params.trialId && !trial) throw new Error('Trial not found in this experiment.');
          if (!trial) {
            const wanted = params.dialogue!.trim().toLocaleLowerCase('ru');
            const scenarios = /^#?\d+$/.test(wanted) ? [bundle.record.scenarios[Number(wanted.replace('#', '')) - 1]].filter(item => !!item)
              : bundle.record.scenarios.filter(item => item.title.toLocaleLowerCase('ru').includes(wanted) || item.id === params.dialogue);
            const titles = bundle.record.scenarios.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
            if (scenarios.length !== 1) throw new NeedsOwner(scenarios.length ? 'ambiguous_reference' : 'unknown_reference',
              scenarios.length ? `«${params.dialogue}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Ситуации «${params.dialogue}» в этом прогоне нет.`, titles.slice(0, 15));
            const attempts = bundle.record.trials.filter(item => item.scenarioId === scenarios[0]!.id);
            trial = attempts.find(item => item.outcome === 'fail') ?? attempts[0];
            if (!trial) throw new Error(`По ситуации «${safeText(scenarios[0]!.title)}» ещё нет записанного диалога.`);
          }
          return feedResult(callId, visible(trial), dialogueFeed(bundle.record, trial), `Диалог · прогон ${shortId(record.id)}`);
        }
        if (params.compare) {
          if (!bundle.comparison || !bundle.comparisonSource) return feedResult(callId, { comparable: false, warnings: bundle.warnings, message: 'This run has no source run to compare with. Prepare a repeat of an earlier run, or name the run to compare with.' },
            { rows: [row('Сравнивать не с чем: у этого прогона нет исходного. Назовите прогон для сравнения или подготовьте повтор прошлого прогона.', 'warning')] }, note);
          return feedResult(callId, { comparison: bundle.comparison, comparisonSource: bundle.comparisonSource, warnings: bundle.warnings }, comparisonFeed(bundle.comparison, bundle.comparisonSource.beforeId),
            `Сравнение прогонов ${shortId(bundle.comparisonSource.beforeId)} → ${shortId(record.id)}`);
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
        // A run with dialogues opens with the same result block as a finished run in the chat (ui-spec §7.1); a draft shows its scenarios.
        if (record.trials.length) {
          const resultKey = `${record.id}:${resultHash(record)}`;
          rememberView(resultKey, bundle.view);
          const details: VerdictDetails = { kind: VERDICT_KIND, version: 1, runId: record.id, resultKey };
          return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details };
        }
        const { views } = await situationsNow(lab, record);
        return feedResult(callId, { ...output, situations: views.map(situationEntry) }, situationsFeed(record, views), note);
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
      if (active) feed.rows.push(...progressLines(await active.lab.get(active.id)).map(line => row(line, 'accent')));
      const output = { runs: records.slice(0, 40).map(record => ({ id: record.id, shortId: shortId(record.id), task: record.task, phase: record.phase, updatedAt: record.updatedAt,
        situations: record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : record.librarySnapshot?.formatVersion === 1 ? record.librarySnapshot.variants.length : record.scenarios.length,
        accepted: !!record.librarySnapshot?.acceptance,
        trials: record.trials.length, plannedTrials: plannedTrials(record), parentRunId: record.parentRunId })),
        workingOn: focus.get(directory) ?? null, runningInThisSession: active?.id ?? null,
        activeOperation: active ? { id: active.operationId, runId: active.id, kind: active.kind } : null };
      return feedResult(callId, output, feed, `Agent Lab · прогонов: ${records.length}`);
    },
  });
  registerCardTools(pi, { inlineCheckMs, operations, open, reading, findRun, focus, feedResult, askOwner, backgroundCheck, backgroundPreparation });
  pi.registerTool({
    ...displayFor('agent_lab_edit'),
    name: 'agent_lab_edit', label: 'Edit an unapproved agent draft',
    description: 'Edit the run settings, the agent connection (target), targetVersion or the agent label of a draft after inspecting its current draftHash. Situations change only through the situation tools (agent_lab_card_*). Human approval stays pending. Cannot change started experiments, run dialogues, record human verdicts, or approve results.',
    parameters: Type.Object({ id: Type.String({ pattern: identifierPattern }), expectedHash: Type.String({ pattern: sha256Pattern }), patch: Type.Unsafe(z.toJSONSchema(draftPatchSchema, { io: 'input' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      try {
        await lab.init();
        const patch = draftPatchSchema.parse(params.patch);
        // A higher spending limit is the owner's decision: in the terminal it is confirmed natively, never raised silently.
        const before = await lab.get(params.id);
        if (patch.settings?.maxCalls !== undefined && patch.settings.maxCalls > before.settings.maxCalls && isInteractive(ctx)
          && !await ctx.ui.confirm('Увеличить лимит вызовов модели?', safeText(`Было: ${before.settings.maxCalls}. Станет: ${patch.settings.maxCalls}. Уже использовано ${before.usage.calls}; использованные вызовы не сбрасываются.`))) {
          return { content: [{ type: 'text', text: JSON.stringify({ id: before.id, cancelled: true, mutated: false, message: 'Лимит не изменён.' }) }], details: { cancelled: true } };
        }
        const record = await lab.updateDraft(params.id, params.expectedHash, patch);
        const output = summary(record, lab.store.directory);
        returnToBoard(ctx, record.id);
        focus.set(lab.store.directory, record.id);
        // What changed, in one row; the whole expectation sheet waits behind the expand key.
        const parts = [patch.target ? 'подключение к агенту' : '', patch.targetVersion ? `версия агента — ${patch.targetVersion}` : '', patch.settings ? 'настройки и лимиты' : '',
          patch.agent ? 'описание агента' : ''].filter(Boolean);
        const feed: Feed = { rows: [row(`Черновик обновлён: ${safeText(parts.join(', ') || 'без видимых изменений')}.`, 'success', true),
          row(`Агент: ${safeText(targetText(record).replaceAll(`${ctx.cwd}/`, ''))}${record.targetVersion ? ` · версия ${safeText(record.targetVersion)}` : ''}`, undefined, false, 1),
          row('После изменения запуск подтверждается заново.', 'muted', false, 1)],
          ...(output.sheetLines ? { more: output.sheetLines.map(line => row(safeText(line))) } : {}) };
        return feedResult(callId, output, feed, `Черновик обновлён · прогон ${shortId(record.id)}`);
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_accept'),
    name: 'agent_lab_accept', label: 'Confirm what the agent must do',
    description: "Accept the ready situations of a draft for a run without running it (agent_lab_run accepts them itself in the same dialog that starts the run); for a draft of a record made before situations, show what the agent must do in each and record the owner's confirmation. The consent comes from a native Pi dialog only; the model never supplies it. It never runs the agent or calls a model.",
    parameters: Type.Object({ id: Type.String({ pattern: identifierPattern }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      requireInteractive(ctx, 'Для принятия теста нужен интерактивный терминал. В CLI используйте accept --id RUN --yes.');
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      try {
        await lab.init();
        const record = await lab.get(params.id);
        if (record.librarySnapshot?.formatVersion === 2 && record.phase === 'review') {
          const context = await lab.cardContext(record.id);
          const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
          const ready = views.filter(view => view.status === 'ready');
          if (!ready.length) return askOwner(callId, new NeedsOwner('needs_owner_input', 'Утверждать нечего: ни одна ситуация не готова. Покажите владельцу вопросы по ситуациям.'));
          const picked = await ctx.ui.select(safeText([`Утвердить готовые ситуации (${ready.length}) для прогона?`, '', ...ready.map(view => `${view.number}  ${view.brief.title}`),
            '', 'Агент сейчас не запускается; запуск — отдельно.'].join('\n')), ['Утвердить', 'Не сейчас']);
          if (picked !== 'Утвердить') return feedResult(callId, { accepted: false, message: 'The owner did not accept. Nothing changed.' }, { rows: [row('Не утверждено. Агент не запускался.', 'warning')] }, 'Не утверждено');
          const accepted = await lab.acceptCards(record.id, libraryHash(context.library), ready.map(view => view.id));
          returnToBoard(ctx, record.id);
          return feedResult(callId, { accepted: true, id: record.id, situations: ready.map(view => view.number), draftHash: draftHash(accepted.experiment) },
            { rows: [row(`Утверждено ситуаций: ${ready.length}. Агент не запускался — скажите «запусти».`, 'success', true)] }, `Утверждены ситуации · прогон ${shortId(record.id)}`);
        }
        // A set of more than one situation is confirmed as one sheet (UI-D-03); one test keeps its own definition.
        if (record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1) {
          const answer = (output: Record<string, unknown>) => {
            returnToBoard(ctx, record.id);
            return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: output };
          };
          signal?.throwIfAborted();
          const sheet = expectationSheet(record);
          const body = `${sheet.compactLines(record.id).map(item => safeText(item)).join('\n')}\n\nДа — подтвердить все. Нет — не подтверждать сейчас.`;
          if (await ctx.ui.confirm(`Подтвердить ожидания: ${sheet.countText}?`, body)) {
            signal?.throwIfAborted();
            const accepted = await lab.acceptDraft(record.id, sheet.draftHash);
            return answer({ id: accepted.id, accepted: true, draftHash: sheet.draftHash, acceptedDraftHash: accepted.acceptedDraftHash,
              message: `Ожидания подтверждены: ${sheet.countText}. Можно запускать.`, sheetLines: expectationSheet(accepted).lines });
          }
          return answer({ id: record.id, accepted: false, draftHash: sheet.draftHash,
            message: 'Ожидания не подтверждены. Прогон не начнётся, пока они не подтверждены. Ожидание ситуации меняется правкой библиотеки сценариев.', sheetLines: sheet.lines });
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
      controlScenarioIds: Type.Optional(Type.Array(Type.String({ pattern: identifierPattern }), { minItems: 1, maxItems: 5, description: 'Mark existing situations as positive controls: real dialogues the agent is known to handle. They are shown apart and never enter the headline number. Each control runs as one turn (the opening and the agent\'s first reply, no simulator), so simulator drift cannot hide a broken judge or connection; controls are left out of the repeat diff.' })) }, { additionalProperties: false }),
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
          if (matches.length !== 1) throw new NeedsOwner(matches.length ? 'ambiguous_reference' : 'unknown_reference',
            matches.length ? `«${ref}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Ситуации «${ref}» в прогоне ${shortId(source.id)} нет.`, titles.slice(0, 15));
          return matches[0]!.id;
        });
        const { lab, close } = await open(ctx.cwd);
        try {
          await lab.init();
          const record = await lab.repeat(source.id, chosen, params.controlScenarioIds);
          focus.set(directory, record.id);
          returnToBoard(ctx, record.id);
          const moved = !!source.targetFingerprint && !!record.targetFingerprint && !sameTargetVersion(source.targetFingerprint, record.targetFingerprint);
          const feed: Feed = { rows: [row(`Подготовлен повтор: ${record.scenarios.length} из ${source.scenarios.length} ситуаций прогона ${shortId(source.id)}. Исходный прогон сохранён.`, 'success', true),
            row(moved ? 'Код агента изменился с прошлого прогона: проверяется новая версия.' : 'Код агента с прошлого прогона не менялся.', moved ? 'accent' : 'muted', false, 1),
            row('Ожидания те же, результаты и подтверждения очищены. После запуска результат сравнится с исходным прогоном.', 'muted', false, 1)],
            more: record.scenarios.map((item, index) => row(`${index + 1}. ${safeText(item.title)}`, undefined, false, 1)) };
          return feedResult(callId, { ...summary(record, lab.store.directory), sourceRunId: source.id, agentCodeChanged: moved }, feed, `Повтор прогона ${shortId(source.id)} → ${shortId(record.id)}`);
        } finally { await close(); }
      } catch (error) { return askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_run'), name: 'agent_lab_run', label: 'Run the accepted set',
    description: 'start (default): run the accepted set of one run after a native confirmation of the exact plan shown: agent and version, set, attempts, models and spending limits. A short run ends in this row; a long one continues in the background, the conversation stays free and the result arrives as a message. progress: read the current run, preparation or semantic assessment from this session’s live executor or stored data. stop: stop the run, preparation or semantic assessment of this session and keep what is recorded; only when the owner asks. Does not record human review of expectations or results. Cannot run headlessly or without the human confirmation. Never bypass this tool through shell or internal APIs.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the run this conversation works on.' })),
      action: Type.Optional(Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('progress')])),
      expectedHash: Type.Optional(Type.String({ pattern: sha256Pattern, description: 'Optional: refuse when the draft differs from the one you inspected. The confirmation always refers to the state it shows.' })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const action = params.action ?? 'start';
      const directory = resolve(ctx.cwd, '.agent-lab');
      const job = operations.current(directory);
      try {
        if (action === 'progress') {
          // A named run is answered about that run; only a request without a reference means «the one going on now».
          const named = params.id ? await findRun(directory, params.id, ctx) : undefined;
          const record = job && (!named || named.id === job.id) ? await job.lab.get(job.id) : named ?? await findRun(directory, undefined, ctx);
          const running = isRunning(record.phase);
          // A preparation of this session is answered in its own words: no dialogue is planned before the scenarios exist.
          if (job?.kind === 'assessment' && job.id === record.id) {
            const message = `Проверка ситуаций ${shortId(record.id)} идёт в фоне · вызовов модели ${record.usage.calls} из ${record.settings.maxCalls}.`;
            return feedResult(callId, { id: record.id, operationId: job.operationId, operationKind: job.kind, phase: record.phase,
              running, assessment: true, preparation: false, ownedByThisSession: true, usage: record.usage, maxCalls: record.settings.maxCalls,
              instruction: 'The check of changed situations is active in this session. Its result will arrive as a message; stop cancels it and keeps the draft. Do not poll.' },
              { rows: [row(message, 'accent')] }, `Проверка ситуаций ${shortId(record.id)}`);
          }
          const preparing = record.phase === 'preparing';
          const unusable = record.trials.filter(trial => trial.outcome === 'invalid' || trial.outcome === 'cancelled').length;
          const feed: Feed = { rows: running ? progressLines(record).map(line => row(safeText(line), 'accent')) : [row(`Прогон ${shortId(record.id)} сейчас не идёт.`, 'muted')] };
          if (preparing) return feedResult(callId, { id: record.id, phase: record.phase, running, preparation: true, ownedByThisSession: !!job && job.id === record.id, usage: record.usage, maxCalls: record.settings.maxCalls,
            ...(job?.id === record.id ? { instruction: 'The preparation continues in the background; its result will arrive as a message. Do not poll.' } : {}) },
            feed, `Подготовка ${shortId(record.id)}`);
          return feedResult(callId, { id: record.id, phase: record.phase, running, ownedByThisSession: !!job && job.id === record.id, finishedDialogues: record.trials.length, plannedDialogues: plannedTrials(record), unusable, usage: record.usage, maxCalls: record.settings.maxCalls },
            feed, `Прогресс прогона ${shortId(record.id)}`);
        }
        if (action === 'stop') {
          if (!job) throw new Error('В этой сессии нет идущего прогона, подготовки или смысловой проверки. Работа, запущенная в другой сессии Pi, останавливается только там.');
          const preparation = job.kind === 'preparation';
          const assessment = job.kind === 'assessment';
          const going = `${assessment ? 'проверка ситуаций' : preparation ? 'подготовка' : 'прогон'} ${shortId(job.id)}`;
          // The run the owner named must be the one that is going: another run is never stopped in its place.
          if (params.id) {
            const named = await findRun(directory, params.id, ctx);
            if (named.id !== job.id) throw new NeedsOwner('needs_owner_input', `Назван прогон ${shortId(named.id)}, а сейчас идёт ${going}. Ничего не остановлено. Спросите владельца, останавливать ли ${preparation ? 'идущую' : 'идущий'}.`, [],
              `Вы назвали прогон ${shortId(named.id)}, а сейчас идёт ${going}. Я ничего не остановил — остановить ${preparation ? 'её' : 'идущий'}?`);
          }
          await operations.stop(job);
          const record = await reading(directory).get(job.id);
          if (assessment) {
            const message = `Проверка ситуаций ${shortId(record.id)} остановлена. Правки и уже проверенное сохранены; остальное можно проверить позже.`;
            return feedResult(callId, { id: record.id, operationId: job.operationId, operationKind: job.kind, phase: record.phase, stopped: true, usage: record.usage, message },
              { rows: [row(message, 'warning')] }, `Проверка ситуаций ${shortId(record.id)} остановлена`);
          }
          if (preparation) {
            const saved = preparationStoppedLines(record);
            const situations = record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : 0;
            return feedResult(callId, { id: record.id, phase: record.phase, stopped: true, savedSituations: situations, savedRequirements: record.requirements.length, usage: record.usage, message: saved.join(' ') },
              { rows: saved.map((line, index) => row(safeText(line), index ? 'muted' : 'warning', !index)) }, `Подготовка ${shortId(record.id)} остановлена`);
          }
          const lines = stoppedLines(record);
          return feedResult(callId, { id: record.id, phase: record.phase, stopped: true, savedDialogues: record.trials.length, plannedDialogues: plannedTrials(record), message: lines.join(' ') },
            { rows: lines.map((line, index) => row(safeText(line), index ? 'muted' : 'warning', !index)) }, `Прогон ${shortId(record.id)} остановлен`);
        }
        requireInteractive(ctx, 'Для нового запуска нужен интерактивный терминал. В CI используйте evaluate --input suite.json --yes с явно заданным бюджетом.');
        const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
        signal.throwIfAborted();
        const found = await findRun(directory, params.id, ctx);
        focus.set(directory, found.id);
        const owned = await open(ctx.cwd, 'wait');
        let detached = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let polling: Promise<void> = Promise.resolve();
        try {
          await owned.lab.init();
          const draft = await owned.lab.get(found.id);
          const hash = draftHash(draft);
          if (draft.workflow !== 'evaluate' || (params.expectedHash && params.expectedHash !== hash)) throw new Error('План изменился. Прочитайте актуальный черновик через agent_lab_inspect.');
          if (draft.phase !== 'review') throw new Error(isRunning(draft.phase) ? `Прогон ${shortId(draft.id)} уже идёт.`
            : `Прогон ${shortId(draft.id)} уже выполнен, его результат не меняется. Чтобы проверить снова, подготовьте повтор (agent_lab_repeat).`);
          // Nothing has started yet: an Esc before the dialog ends the action.
          signal.throwIfAborted();
          // One native dialog: a card draft is accepted with its ready situations as it starts; unconfirmed expectations are confirmed with the run.
          if (!await launchRun(ctx, owned.lab, draft)) {
            const output = { id: draft.id, cancelled: true, message: 'Запуск отменён. Ситуации сохранены; не повторяйте запрос запуска без новой просьбы пользователя.' };
            return { content: [{ type: 'text' as const, text: JSON.stringify(output) }],
              details: rememberFeed(callId, { rows: [row('Запуск отменён. Ситуации сохранены, агент не запускался.', 'warning')] }, 'Запуск отменён') };
          }
          // The run has started: from here an Esc, even one pressed while it was starting, hands it to the session.
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
            if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
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
                row('Esc прерывает только текущее действие. Чтобы остановить прогон, так и напишите.', 'muted', false, 1)] }, `Прогон ${shortId(draft.id)} идёт в фоне`);
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
        requireInteractive(ctx, 'Проверка подключения требует native Pi confirmation.');
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
          requireInteractive(ctx, 'Переоценка моделью требует native Pi confirmation.');
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
  registerReviewTools(pi, { open, findRun, feedResult, askOwner, summary, recallShown });
  registerBoardCommand(pi, { open, operations, detach, backgroundPreparation, backgroundCheck });
  pi.on('session_shutdown', () => operations.shutdown());
}
