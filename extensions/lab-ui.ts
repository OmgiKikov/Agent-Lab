import type { AgentToolResult, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { z } from 'zod';
import { safeText } from '../src/text.js';
import type { Experiment } from '../src/contracts.js';
import { convertible } from '../src/card/legacy-v1.js';
import { forOwner, ownerText, problemOf, recordErrorText as storedErrorText, stopOf, stoppedByOwner } from '../src/error-text.js';
import { TOOL } from './steps.ts';
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
 * Every Agent Lab tool draws its own row, Claude-Code-like (docs/design/ui-spec.md §4.10): «● what is being done», then its
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
    // Pi's own refusals (a schema, a tool not in this step) are said in the owner's words, never as Pi wrote them.
    if (context.isError) { state.tone = 'error'; return lineBody(toolErrorText(contentText(result)), 'error', theme); }
    if (options.isPartial) { state.tone = 'muted'; return legacyResult(result, options, theme); }
    return renderFeedResult(result, options, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult, tone => { state.tone = tone; }), tone => { state.tone = tone; });
  },
});

/** Native confirmations exist only in Pi's interactive terminal. */
export const isInteractive = (ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>): boolean => !!ctx.hasUI && ctx.mode === 'tui';
/**
 * What needs a person's native confirmation never runs headless: outside the terminal the call fails with `message`.
 * The model reads the message too, so it says what the owner does in their own words and never hands the model a
 * command line that would consent for the owner.
 */
export function requireInteractive(ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>, message: string): void {
  if (!isInteractive(ctx)) throw new Error(message);
}

/**
 * A native question with Russian answers instead of Yes/No (docs/design/ui-spec.md §2): true only when the owner picked `yes`.
 * `body` is shown under the question; both are escaped here.
 */
export async function ask(ctx: Pick<ExtensionContext, 'ui'>, question: string, body: string[], yes: string, no = 'Не сейчас'): Promise<boolean> {
  const title = [question, ...(body.length ? ['', ...body] : [])].map(line => safeText(line)).join('\n');
  return await ctx.ui.select(title, [yes, no]) === yes;
}

/** The model has to put a question to the owner; nothing was written. `code` says what is missing; `ownerText` is what the owner reads — never the model's instruction or an id. */
export class NeedsOwner extends Error {
  constructor(readonly code: 'ambiguous_reference' | 'unknown_reference' | 'needs_owner_input' | 'declined', message: string,
    readonly options: string[], readonly ownerText: string) { super(message); }
}

/* ───────────────────────────── errors in the owner's words ───────────────────────────── */

/** The fields an input names, as the owner calls them. */
const FIELD: Readonly<Record<string, string>> = {
  task: 'описание агента', materials: 'правила', rules: 'правило', requirementIds: 'правило', bind: 'правило', unbind: 'правило', included: 'правила свода', kinds: 'виды правил',
  text: 'формулировка', appliesWhen: 'условие', label: 'название факта', value: 'значение факта', askedAs: 'вопрос агента о факте', disclosure: 'когда клиент называет факт',
  when: 'когда клиент называет факт', wants: 'чего хочет клиент', writes: 'первая реплика клиента', leaves: 'когда клиент уходит', says: 'слова клиента', after: 'после чего',
  turn: 'поворот', title: 'название ситуации', maxCalls: 'лимит вызовов модели', maxDurationMs: 'время на работу', timeoutMs: 'время на один ответ', maxTurns: 'число реплик клиента',
  repeats: 'число попыток', scenarioCount: 'число ситуаций', situations: 'число ситуаций', note: 'причина', version: 'версия агента', url: 'адрес агента',
  command: 'команда запуска агента', path: 'файл агента', module: 'файл агента', args: 'аргументы запуска',
};

/** A zod error as the owner reads it: the field and what is wrong with it, never a raw issue dump. */
export function zodText(error: z.ZodError): string {
  return error.issues.slice(0, 3).map(issue => {
    const name = [...issue.path].reverse().find((key): key is string => typeof key === 'string');
    return `${name !== undefined && Object.hasOwn(FIELD, name) ? FIELD[name] : 'значение'} — ${problemOf(issue)}`;
  }).join('; ');
}

/** The original of an error the owner is not shown: for whoever reads the terminal's error output. */
function diagnose(error: unknown): void {
  process.stderr.write(`Agent Lab: ${error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)}\n`);
}

/** What the owner reads when the cause is not theirs to act on; the original goes to the terminal's error output. */
export const UNKNOWN_ERROR = 'Не получилось из-за внутренней ошибки Agent Lab. Попробуйте ещё раз; подробности — в выводе ошибок терминала.';

/**
 * Why an action did not happen, in the owner's words, with the way on: the chat's and the workspace's use of the one
 * translator (src/error-text.ts), plus what only the chat has — a question to the owner, a field of a tool's input. What
 * the owner is not shown never reaches the model either: a neutral phrase does, and the original goes to the terminal's
 * error output.
 */
export function inputError(error: unknown): string {
  if (error instanceof NeedsOwner) return safeText(error.ownerText);
  if (error instanceof z.ZodError) return safeText(`Не получилось: ${zodText(error)}. Ничего не записано.`);
  const known = ownerText(error, 'chat');
  if (known) {
    if (known.detail !== undefined) diagnose(error);
    return safeText(known.text);
  }
  diagnose(error);
  return UNKNOWN_ERROR;
}

/**
 * Why long work stopped, as its record keeps it, in the owner's words: a stop's fixed label by its kind, the engine's own
 * message as it is, anything else — a diagnostic the owner cannot act on — as a neutral phrase. Undefined without an error.
 */
export function recordErrorText(error: string | null | undefined): string | undefined {
  const text = storedErrorText(error, 'chat');
  return text === undefined ? undefined : safeText(text);
}
export { stopOf, stoppedByOwner };

/**
 * Pi's own refusal of a Lab tool call, which never reached the tool, in the owner's words (the model still reads Pi's
 * text): arguments its schema refused, or a tool that is not among this step's (steps.ts). Pi's texts are read by their
 * fixed beginnings, the one place that reads them; anything else a Lab tool failed with was already said by inputError.
 */
export function toolErrorText(text: string): string {
  if (text.startsWith('Validation failed for tool ')) return 'Модель передала инструменту Lab неверные параметры — ничего не сделано. Она поправит запрос сама; если нет — повторите просьбу своими словами.';
  const named = text.startsWith('Tool ') && text.endsWith(' not found') ? text.slice(5, -10) : undefined;
  const missing = named?.startsWith('"') && named.endsWith('"') ? named.slice(1, -1) : named;
  if (missing !== undefined) {
    const later = STEP_OF[missing];
    return later ? `Модель обратилась к инструменту, который откроется позже: ${later}. Ничего не сделано.`
      : 'Модель обратилась к инструменту, которого здесь нет. Ничего не сделано.';
  }
  if (text === 'Operation aborted') return 'Остановлено.';
  return forOwner(text) ? text : UNKNOWN_ERROR;
}
/** When each Lab tool the model may reach for too early becomes one of the step's (steps.ts). */
const STEP_OF: Readonly<Record<string, string>> = {
  [TOOL.cards]: 'ситуации появятся после подготовки', [TOOL.edit]: 'ситуации появятся после подготовки', [TOOL.decide]: 'ситуации появятся после подготовки',
  [TOOL.run]: 'прогон — когда ситуации подготовлены', [TOOL.results]: 'результаты — после первого прогона с разговорами',
  [TOOL.explain]: 'разбор — после первого прогона с разговорами', [TOOL.agree]: 'сверка — после первого прогона с разговорами',
};

/** What the workspace hands to the conversation with a request about one object: stable identities, never a copy of editable state. */
export function boardDiscussionContext(record: Experiment, situation?: { number: number; id: string }) {
  return { run: record.id, phase: record.phase, ...(situation ? { situation: situation.number } : {}),
    task: record.librarySnapshot?.formatVersion === 2
      ? 'The request concerns this Agent Lab run and, if named here, the situation by its number. Read it fresh with agent_lab_cards; change it with agent_lab_edit; its question is answered through agent_lab_decide; run with agent_lab_run. For results read agent_lab_results and agent_lab_explain, and tell observations from suspected causes. The owner decides in native dialogs; never invent a human verdict or change the external agent without an explicit request.'
      : `The request concerns this Agent Lab run. Read its situations with agent_lab_cards (an older format: they are only read${convertible(record) ? '; the draft goes on in the current format through its decision in agent_lab_decide' : ''}) and its result with agent_lab_results and agent_lab_explain; tell observations from suspected causes. Run only with agent_lab_run and its native plan. Never invent a human verdict or change the external agent without an explicit request.`,
  };
}
