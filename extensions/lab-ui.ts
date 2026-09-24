import type { AgentToolResult, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { safeText } from '../src/text.js';
import { LibraryConflict, LockedError, StaleRevisionError } from '../src/errors.js';
import type { Experiment } from '../src/contracts.js';
import { convertible } from '../src/card/legacy-v1.js';
import { ActionHead, contentText, lineBody, renderFeedResult, callText } from './render/feed.ts';
import { renderAgentLabResult } from './render/verdict-block.ts';
import type { Tone } from './render/theme.ts';

/**
 * A result that is neither a feed nor a result block: a progress update while the action runs, or the details an
 * older session stored. Never raw JSON: the progress text is written for the owner, an old record's details are not.
 */
export function legacyResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  if (options.isPartial) return lineBody(contentText(result).split('\n')[0] ?? '', 'muted', theme);
  return lineBody('Это действие из прошлой сессии — попросите показать его ещё раз.', 'muted', theme);
}

/** What the ● of a tool row shows while no result has arrived, and after: the result tells its own colour. */
interface RowState { tone?: Tone }

/**
 * Every Agent Lab tool draws its own row, Claude-Code-like (ui-spec §4.10): «● what is being done», then its
 * summary under └ and details on ctrl+o. Pi's coloured box is not used: the row is the component.
 */
export const displayFor = (name: string): Pick<ToolDefinition, 'renderShell' | 'renderCall' | 'renderResult'> => ({
  renderShell: 'self',
  renderCall: (args, theme, context) => {
    // Pi shares one state object between the call and the result of a row; a host that gives none keeps the tone local.
    const state: RowState = context.state ?? {};
    return new ActionHead(callText(name, args as Record<string, unknown>), theme,
      () => context.isError ? 'error' : state.tone ?? (context.isPartial ? 'muted' : 'success'));
  },
  renderResult: (result, options, theme, context) => {
    const state: RowState = context.state ?? {};
    if (context.isError) { state.tone = 'error'; return lineBody(contentText(result), 'error', theme); }
    if (options.isPartial) { state.tone = 'muted'; return legacyResult(result, options, theme); }
    return renderFeedResult(result, options, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult, tone => { state.tone = tone; }), tone => { state.tone = tone; });
  },
});

/** Native confirmations exist only in Pi's interactive terminal. */
export const isInteractive = (ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>): boolean => !!ctx.hasUI && ctx.mode === 'tui';
/** What needs a person's native confirmation never runs headless: outside the terminal the call fails with `message`. */
export function requireInteractive(ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>, message: string): void {
  if (!isInteractive(ctx)) throw new Error(message);
}

/**
 * A native question with Russian answers instead of Yes/No (ui-spec §2): true only when the owner picked `yes`.
 * `body` is shown under the question; both are escaped here.
 */
export async function ask(ctx: Pick<ExtensionContext, 'ui'>, question: string, body: string[], yes: string, no = 'Не сейчас'): Promise<boolean> {
  const title = [question, ...(body.length ? ['', ...body] : [])].map(line => safeText(line)).join('\n');
  return await ctx.ui.select(title, [yes, no]) === yes;
}

/** Why an action did not happen, in the owner's words: never a stack, never the model-facing text of a question. */
export const inputError = (error: unknown): string => safeText(error instanceof LockedError
  ? 'Другая сессия Pi сейчас ведёт работу в этой папке. Смотреть можно здесь; изменения и запуск — после её завершения.'
  : error instanceof NeedsOwner ? error.ownerText ?? error.message
  : error instanceof StaleRevisionError ? error.message
  : error instanceof LibraryConflict ? 'Ситуации изменились. Откройте их заново и повторите по свежему состоянию.'
  : error instanceof Error ? error.message : String(error));

/** The model has to put a question to the owner; nothing was written. `code` says what is missing. */
export class NeedsOwner extends Error {
  constructor(readonly code: 'ambiguous_reference' | 'unknown_reference' | 'needs_owner_input' | 'declined', message: string,
    readonly options: string[] = [], readonly ownerText?: string) { super(message); }
}

/** What the workspace hands to the conversation with a request about one object: stable identities, never a copy of editable state. */
export function boardDiscussionContext(record: Experiment, situation?: { number: number; id: string }) {
  return { run: record.id, phase: record.phase, ...(situation ? { situation: situation.number } : {}),
    task: record.librarySnapshot?.formatVersion === 2
      ? 'The request concerns this Agent Lab run and, if named here, the situation by its number. Read it fresh with agent_lab_cards; change it with agent_lab_edit; its question is answered through agent_lab_decide; run with agent_lab_run. For results read agent_lab_results and agent_lab_explain, and tell observations from suspected causes. The owner decides in native dialogs; never invent a human verdict or change the external agent without an explicit request.'
      : `The request concerns this Agent Lab run. Read its situations with agent_lab_cards (an older format: they are only read${convertible(record) ? '; the draft goes on in the current format through its decision in agent_lab_decide' : ''}) and its result with agent_lab_results and agent_lab_explain; tell observations from suspected causes. Run only with agent_lab_run and its native plan. Never invent a human verdict or change the external agent without an explicit request.`,
  };
}
