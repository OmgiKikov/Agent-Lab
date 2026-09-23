import type { AgentToolResult, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';
import { safeText, shortId } from '../src/text.js';
import { LockedError } from '../src/errors.js';
import type { Section } from './cards.ts';
import type { Experiment } from '../src/contracts.js';
import { callText, renderFeedResult } from './render/feed.ts';
import { renderAgentLabResult } from './render/verdict-block.ts';

export function legacyResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  const raw = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (options.expanded) return new Text(safeText(raw), 0, 0);
  try {
    const data = JSON.parse(raw);
    // A result travels as the lines of the result screen (result-text.ts), the same rows the board and the CLI show.
    const block: string | undefined = Array.isArray(data.resultLines) && data.resultLines.length ? data.resultLines.join('\n') : undefined;
    if (data.brief) return new Text(theme.fg('text', safeText([data.scoreState, block, data.brief].filter(Boolean).join('\n\n'))), 0, 0);
    if (data.proofs?.length) return new Text(theme.fg('text', safeText([
      data.error ?? block, ...data.proofs.map((proof: { lines: string[] }) => proof.lines.join('\n')),
    ].filter(Boolean).join('\n\n'))), 0, 0);
    const title = data.error ?? (data.phase === 'review' ? data.message ?? `Готово ${data.scenarioCount} сценариев. Посмотрите их перед запуском.`
      : block ?? data.message ?? 'Доказательства прочитаны.');
    const sheetLines: string[] | undefined = Array.isArray(data.sheetLines) && data.sheetLines.length ? data.sheetLines : undefined;
    return new Text(theme.fg(data.error ? 'error' : 'text', safeText([title, ...(sheetLines ? ['', ...sheetLines] : [])].join('\n'))), 0, 0);
  } catch { return new Text(safeText(raw), 0, 0); }
}

export const displayFor = (name: string): Pick<ToolDefinition, 'renderCall' | 'renderResult'> => ({
  renderCall: (args, theme) => new Text(theme.fg('accent', safeText(callText(name, args as Record<string, unknown>))), 0, 0),
  renderResult: (result, options, theme, context) => context?.isError
    ? new Text(theme.fg('error', safeText(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))), 0, 0)
    : renderFeedResult(result, options, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult)),
});

/** Native confirmations exist only in Pi's interactive terminal. */
export const isInteractive = (ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>): boolean => !!ctx.hasUI && ctx.mode === 'tui';
/** What needs a person's native confirmation never runs headless: outside the terminal the call fails with `message`. */
export function requireInteractive(ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>, message: string): void {
  if (!isInteractive(ctx)) throw new Error(message);
}

export const returnToBoard = (ctx: ExtensionContext, id: string) => {
  if (!isInteractive(ctx)) return;
  ctx.ui?.setStatus?.('agent-lab', `Agent Lab · прогон ${shortId(id)}`);
};

export const inputError = (error: unknown): string => error instanceof LockedError
  ? 'Другая сессия выполняет проверку. Историю, диалоги и экспорт можно смотреть здесь. Изменения и новый запуск будут доступны после её завершения.'
  : safeText(error instanceof Error ? error.message : error);

export const DIFF_FIELD: Record<string, string> = { opening: 'первая реплика', goal: 'цель клиента', expectation: 'ожидаемый результат', rule: 'правило проверки', fact: 'факт' };

/** The model has to put a question to the owner; nothing was written. `code` says what is missing. */
export class NeedsOwner extends Error {
  constructor(readonly code: 'ambiguous_reference' | 'unknown_reference' | 'needs_owner_input' | 'declined', message: string,
    readonly options: string[] = [], readonly ownerText?: string) { super(message); }
}

/** The board passes stable identities, never a second copy of editable state: the run, and the situation it shows by its number. */
export function boardDiscussionContext(record: Experiment, section: Section, situation?: { number: number; id: string }) {
  return { experimentId: record.id, phase: record.phase, ...(section === 'cards' && situation ? { situation: situation.number } : {}),
    task: record.librarySnapshot?.formatVersion === 2
      ? 'The user request concerns the selected Agent Lab run and, if named here, the situation by its number. Read it fresh with agent_lab_cards (card: the number). Change it with the situation tools (agent_lab_card_*), add a similar one with agent_lab_card_similar; the owner decides in native dialogs. Run with agent_lab_run. For results inspect actual dialogues and tell observations from suspected causes. Never invent human verdicts or alter the external agent without an explicit request.'
      : 'The user request concerns this selected Agent Lab run. Read it with agent_lab_inspect and its situations with agent_lab_cards (read-only in an older format). Inspect actual dialogues for results; tell observations from suspected causes and never invent human verdicts. Run only with agent_lab_run and its native plan confirmation. Do not alter the external agent without an explicit request.',
  };
}
