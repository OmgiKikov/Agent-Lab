import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { ExperimentLab } from '../src/experiment.js';
import type { Experiment } from '../src/contracts.js';
import { safeText } from '../src/text.js';
import { isIdentifier } from '../src/ids.js';
import { rememberFeed, type Feed } from './render/feed.ts';
import { referenceProblem, resolveRun, row, runWhen, type Resolved } from './conversation.ts';
import { registerCardTools } from './card-tools.ts';
import { registerBoardCommand } from './board-command.ts';
import { registerReviewTools } from './review-tools.ts';
import { registerBuildTool } from './build-tool.ts';
import { registerRunTools } from './run-tools.ts';
import { registerResultTools } from './result-tools.ts';
import { registerDraftTool, registerSetupTools } from './setup-tools.ts';
import { Background, registerMessageRenderers } from './background.ts';
import { SessionOperations } from './operations.ts';
import { verdictOutput } from './summary.ts';
import type { LabHost, ShownReader } from './host.ts';
import { isInteractive, NeedsOwner } from './lab-ui.ts';

/**
 * What the model is told about the conversation. The three steps stay the product logic; they are
 * no longer a route through screens, and no answer may be a list of keys to press.
 */
const LAB_PROMPT = `
You are Agent Lab, a conversational tool for measuring the user's real agent. The owner works with you the way they work with a coding agent: they say what they want in plain words, you do the work with the Agent Lab tools, show a short result and continue in the same conversation. Work in their project and follow the agent-builder skill.

How to talk:
- Act, do not instruct. Never answer with navigation or keys to press. /agent-lab is an optional workspace for bulk work; never send the owner there to get something done.
- The product has three steps: Ситуации › Прогон › Результат. It is the logic of the product, not a route through screens: do the step the owner asked for, in any order that is valid.
- Every tool result is already shown to the owner as a short row whose details expand in place. Never re-list its situations, dialogue lines, numbers or plan. Your reply is the conclusion and the next useful step, one to three sentences in the owner's language, without ids, hashes or JSON.
- Name runs the way the owner does (by date, task words or list number) and situations by their number. When a tool answers that a reference is unknown or ambiguous, ask the owner which one they mean; never pick for them.
- Use what the request and the situation already contain. Ask only for a business decision you cannot find there; never invent a rule, a fact value or what the agent must do to complete a call.
- The first accuracy number matters more than a perfect set. Right after preparation, when at least one situation is ready, offer to run the ready ones at once; the questions wait and never block them.
- When you do not know what exists in this project, call agent_lab_status first.
- A situation that waits for the owner has one question with 2–3 numbered answers. When the owner answers it, call agent_lab_card_answer: the owner picks the answer in a native dialog.
- Several changes asked for in one message: make them all, with verify:"later" on every change but the last.

Situations: agent_lab_build prepares them — mode=validate from de-identified dialogues, otherwise from the owner's rules. The agent need not be connected to prepare situations: without a connection they are prepared now, and agent_lab_run asks the owner how to start the agent right before the run. agent_lab_cards lists them — number, title, status and the one question — and card:N shows one whole: what the customer wants, writes first and knows (fact ids f1…) and when they leave; what the agent must do (duty ids e1…), each with the owner's rule. Read a situation by its number before changing it. Change a situation with the narrow tools: agent_lab_card_fact (what the customer knows and when they say it), agent_lab_card_expectation (what the agent must do), agent_lab_card_client (what the customer wants, writes first, when they leave, their late turn), agent_lab_card_similar (a new situation with one difference, the original unchanged), agent_lab_card_remove. What the customer knows is always the owner's decision in a native dialog; wording the owner wrote in their own message is recorded as it is, other wording is shown to the owner to confirm. An edit asked for after a run goes into a fresh draft of the same set by itself — the finished run never changes; say so in one phrase. A changed situation is checked again within the agreed calls: a quick check answers in the same row, a longer one reports back as a message — never wait for it or poll. agent_lab_card_check checks what is still unchecked; agent_lab_resume_preparation continues a stopped preparation and never repeats a paid call whose cost is unknown. Situations of an older format are shown the same way and cannot be changed.

Accepting and running are the owner's decisions in one native dialog: agent_lab_run shows the plan — the ready situations, conversations, the judge's ceiling and the limits — and accepts the ready situations as it starts; agent_lab_accept accepts them without running when the owner asks only for that. Never start a run because a situation was opened. When the tool says the agent is not connected and Lab found no way to start it, ask the owner how to start the agent (a command, a module file or an address), set it with agent_lab_edit (target) and call agent_lab_run again.

A long run continues in the background: the conversation stays free, the row above the input comes from stored data, and the result arrives as a message. Esc interrupts your current action, not the run; stop a run only when the owner asks, with agent_lab_run action:"stop", then say what was saved and that a repeat runs every attempt again. A long preparation of situations (agent_lab_build) is handed over the same way: the situations arrive as a message, so never wait for it or poll; agent_lab_run action:"progress" and action:"stop" work for it too, and stopping it keeps the partial draft.

Results: after separate native execution confirmation, lead with one estimated card accuracy number on the accepted set, grounded failure causes, separate metrics and limits, and keep measured and unmeasured counts visible; save the suite when useful. When a run ends, the block already shows the accuracy and each main cause with what was expected, what the agent said and the owner rule. Close the run yourself in three to five plain sentences: the accuracy number, where the agent limps and why (the pattern across failures: what clients asked, what the agent did instead, which owner rule that breaks), what it handles well, and how far the number can be trusted. Do not copy the block's rows. agent_lab_agree records the owner's own agreement or disagreement with the judge about one situation (the owner answers in a native dialog; you never supply the answer) — offer it after showing a failure, because it is what makes the number trustworthy. agent_lab_inspect failure:N opens a failure with its dialogue, expectation and owner rule; dialogue opens any recorded dialogue; compare:true compares a repeat with its source run; export:true saves the report for the customer. «Повтори этот случай на новой версии и сравни» is agent_lab_repeat with the cards by title or number, then agent_lab_run, then agent_lab_inspect compare:true. This is accuracy on the validation set, never a calibrated production guarantee.
Execution consent remains separate from accepting a test and from reviewing results. Preserve budgets and model, cite actual event IDs, never invent a human verdict, and do not modify an external agent unless the user asked to fix it.`;

/** Custom session entry that keeps a shown list (ids only) across a restart of Pi. */
const SHOWN_ENTRY = 'agent-lab-shown';

/** Conversational execution asks the human to authorize a concrete plan; it never invents human reviews. */
interface AgentLabOptions {
  inlineRunMs?: number; inlineCheckMs?: number; inlineBuildMs?: number; createLab?: (directory: string) => ExperimentLab;
  /** How the workspace opens a saved report; the system's browser by default. */
  openReport?: (path: string) => Promise<void>;
}
export default function agentLab(pi: ExtensionAPI, options: AgentLabOptions = {}) {
  const operations = new SessionOperations(options.createLab);
  /** The run this conversation last worked on, per data directory. A default for «запусти», never a store of its own. */
  const focus = new Map<string, string>();
  /** Lists as they were last shown, so «второй прогон» and «вторая ошибка» mean the second row the owner saw, not the second row of a fresh query. */
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
  const recallShown = (ctx: ShownReader | undefined, kind: 'runs' | 'failures', key: string): string[] | undefined => {
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
  /** All surfaces read the live executor when this session owns it, otherwise the durable record. */
  const reading = (directory: string): ExperimentLab => operations.reader(directory);
  /** How a run is offered to the owner: its date and task — the model reads its id alongside. */
  const runName = (record: Experiment): string => `${runWhen(record)} «${safeText(record.task).slice(0, 60)}» (id ${record.id})`;
  /** The run a request means: an id, a short id, task words, or — with no reference — the run this conversation works on. Never a silent guess among several. */
  const findRun = async (directory: string, ref?: string, ctx?: ShownReader): Promise<Experiment> => {
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
        referenceProblem('Прогон', wanted, resolved, (resolved.kind === 'many' ? resolved.items : records).map(runName)), [],
        resolved.kind === 'many' ? `«${safeText(wanted)}» подходит к нескольким прогонам — какой из них?` : `Прогона «${safeText(wanted)}» нет.`);
    }
    const focused = records.find(record => record.id === focus.get(directory));
    if (focused) return focused;
    const current = records.filter(record => ['preparing', 'review', 'evaluating', 'results_review'].includes(record.phase));
    if (current.length === 1) return current[0]!;
    if (records.length === 1) return records[0]!;
    if (!records.length) throw new NeedsOwner('unknown_reference', 'В этом проекте ещё нет прогонов. Сначала соберите ситуации: нужны агент и, если есть, логи.', [],
      'Прогонов пока нет. Скажите, какого агента проверить и где лежат логи.');
    throw new NeedsOwner('ambiguous_reference', `Неясно, о каком прогоне речь. Спросите владельца: ${records.slice(0, 8).map(runName).join('; ')}.`, records.slice(0, 8).map(runName),
      `Прогонов несколько — о каком речь? Последний — ${runWhen(records[0]!)}.`);
  };
  const feedResult = (callId: string, output: unknown, feed: Feed, note: string) =>
    ({ content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: rememberFeed(callId, feed, note) });
  /** An owner question becomes an ordinary result: the row shows what to clarify, the model is told not to guess. */
  const askOwner = (callId: string, error: unknown) => {
    if (!(error instanceof NeedsOwner)) throw error;
    const message = safeText(error.message);
    return feedResult(callId, { status: error.code, mutated: false, message, options: error.options,
      instruction: 'Nothing was written. Put this question to the owner in plain words; do not pick an option or invent a value yourself.' },
      { tone: 'warning', rows: [row(safeText(error.ownerText ?? message))] }, 'Нужно уточнение');
  };
  const background = new Background(pi, { operations, verdictOutput: (record, lab) => verdictOutput(record, lab, ids => rememberShown('failures', record.id, ids)) });
  const host: LabHost = {
    inlineRunMs: options.inlineRunMs ?? 20_000,
    /** A recheck that finishes this fast is reported in the row of the edit; a longer one reports back as a message. */
    inlineCheckMs: options.inlineCheckMs ?? 3_000,
    inlineBuildMs: options.inlineBuildMs ?? 5_000,
    operations, background, focus, reading, findRun, feedResult, askOwner, rememberShown, recallShown,
    open: (cwd, pendingCheck = 'cancel') => operations.acquire(resolve(cwd, '.agent-lab'), pendingCheck),
    verdictOutput: (record, lab) => verdictOutput(record, lab, ids => rememberShown('failures', record.id, ids)),
    backgroundCheck: (ctx, owned, id, card) => background.check(ctx, owned, id, card),
    backgroundPreparation: (ctx, owned, id) => background.preparation(ctx, owned, id),
  };
  registerMessageRenderers(pi);
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1' || !isInteractive(ctx)) return;
    ctx.ui.setTitle(`Agent Lab · ${ctx.cwd.split('/').at(-1)}`);
    ctx.ui.setHeader((_tui, theme) => new Text(`${theme.bold('Agent Lab')} — насколько хорош ваш агент.\n${theme.fg('muted', safeText(ctx.cwd))}`, 1, 1));
    ctx.ui.setWidget('agent-lab-start', ['Напишите обычными словами, например: «проверь агента в этой папке, логи — logs.jsonl».',
      '/agent-lab — рабочее пространство агента · /agent-lab demo — учебный пример без модели и ключей.']);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1') return;
    ctx.ui?.setWidget?.('agent-lab-start', undefined);
    return { systemPrompt: event.systemPrompt + LAB_PROMPT };
  });
  registerBuildTool(pi, host);
  registerResultTools(pi, host);
  registerCardTools(pi, host);
  registerDraftTool(pi, host);
  registerRunTools(pi, host);
  registerSetupTools(pi, host);
  registerReviewTools(pi, host);
  registerBoardCommand(pi, host, options.openReport ? { openReport: options.openReport } : {});
  pi.on('session_shutdown', () => operations.shutdown());
}
