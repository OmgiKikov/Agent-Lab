import type { AgentToolResult, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';
import { safeText, shortId } from '../src/text.js';
import { LockedError } from '../src/errors.js';
import type { Section } from './cards.ts';
import type { Experiment } from '../src/contracts.js';
import { libraryHash } from '../src/scenario-library.js';
import { libraryV1Of } from '../src/card/legacy-v1.js';
import { callText, renderFeedResult } from './render/feed.ts';
import { renderAgentLabResult } from './render/verdict-block.ts';

export function legacyResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  const raw = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (options.expanded) return new Text(safeText(raw), 0, 0);
  try {
    const data = JSON.parse(raw);
    const block: string | undefined = Array.isArray(data.viewLines) && data.viewLines.length ? data.viewLines.join('\n') : undefined;
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
    const sheetLines: string[] | undefined = Array.isArray(data.sheetLines) && data.sheetLines.length ? data.sheetLines : undefined;
    const lines = [title, ...(title === block && failures ? ['', failures] : []),
      ...(sheetLines ? ['', ...sheetLines] : []), ...(data.quality?.queue ? [data.quality.queue] : [])];
    return new Text(theme.fg(data.error ? 'error' : 'text', safeText(lines.join('\n'))), 0, 0);
  } catch { return new Text(safeText(raw), 0, 0); }
}

export const displayFor = (name: string): Pick<ToolDefinition, 'renderCall' | 'renderResult'> => ({
  renderCall: (args, theme) => new Text(theme.fg('accent', safeText(callText(name, args as Record<string, unknown>))), 0, 0),
  renderResult: (result, options, theme, context) => context?.isError
    ? new Text(theme.fg('error', safeText(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))), 0, 0)
    : renderFeedResult(result, options, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult), () => context?.invalidate?.()),
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

/** The board passes stable identities and the viewed revision, not a second copy of editable state. */
export function boardDiscussionContext(record: Experiment, section: Section, selectedIndex: number) {
  const library = record.librarySnapshot;
  const variant = section === 'cards' ? libraryV1Of(record)?.variants[selectedIndex] : undefined;
  return { experimentId: record.id, phase: record.phase,
    ...(library ? { libraryId: library.id, expectedLibraryHash: libraryHash(library),
      ...(variant ? { variantId: variant.id, businessScenarioId: variant.businessScenarioId } : {}) }
      : section === 'cards' ? { scenarioId: record.scenarios[selectedIndex]?.id } : {}),
    task: library
      ? 'The user request concerns the selected Agent Lab experiment and variant, if named here. Read fresh cards and original evidence with agent_lab_scenarios (variantId as variant, source:true when needed). Use the dedicated card, group, behavior, variant and assessment tools for corrections; preserve saved work and pending sources. Resume pending extraction with agent_lab_resume_preparation. A changed revision requires a fresh read before editing. Accept a reviewed set with agent_lab_accept_set and run separately with agent_lab_run, using native confirmations. For results inspect actual trial traces and distinguish observations from suspected causes. Never invent human verdicts or alter the external agent without an explicit request.'
      : 'The user request concerns this selected Agent Lab experiment. Inspect fresh evidence with agent_lab_inspect. Correct a draft through agent_lab_edit with its current hash. Inspect actual trial traces for results; distinguish observations from suspected causes and never invent human verdicts. Run only with agent_lab_run and native plan confirmation. Do not alter the external agent without an explicit request.',
  };
}
