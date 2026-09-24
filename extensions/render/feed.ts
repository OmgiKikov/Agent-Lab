import { keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { safeText } from '../../src/text.js';
import { GLYPH, renderRows, type PaintTheme, type Row, type Tone } from './theme.ts';

/*
 * One Agent Lab action in the chat, the way Claude Code draws a tool (docs/design/ui-spec.md §4.10):
 *
 *   [action] Собираю ситуации из logs.jsonl              what is being done, the sign tinted by how it ended
 *     [branch] 12 ситуаций: 9 готовы · 2 ждут ответа     the answer, one to three lines
 *              Первый вопрос — ситуация 2: …
 *              ctrl+o все 12 ситуаций                    only when something waits behind it
 *
 * The signs are GLYPH.action and GLYPH.branch (theme.ts).
 *
 * `app.tools.expand` opens the rest under the summary: the situations, the brief, the conversation — never
 * JSON, hashes or tool arguments, which stay in the model's content.
 *
 * The session file is 0644, so `details` hold a key and a neutral note only (REV-01). The rows live in
 * memory while Pi runs; a reopened session shows the note, and the same request rebuilds the rows from
 * the 0600 store.
 */

/** How an action ended: done, waiting for the owner, or failed. The colour of its sign. */
export type FeedTone = 'success' | 'warning' | 'error';

export interface Feed {
  /** The summary under the action: the answer first, one to three rows. */
  rows: Row[];
  /** What ctrl+o opens under the summary. */
  more?: Row[];
  tone?: FeedTone;
  /** What ctrl+o opens, in the owner's words: «все 12 ситуаций», «весь разговор». */
  expand?: string;
  /** The head of a result that arrives later as a message («Прогон остановлен»); a tool row has its own. */
  title?: string;
}

const FEED_KIND = 'agent-lab/feed';

/** `note` names the action and the run by its date and counts — never a title, a quote or a value. */
interface FeedDetails { kind: typeof FEED_KIND; version: 1; feedKey: string; note: string }

export function isFeedDetails(value: unknown): value is FeedDetails {
  if (!value || typeof value !== 'object') return false;
  const details = value as Partial<FeedDetails>;
  return details.kind === FEED_KIND && details.version === 1 && typeof details.feedKey === 'string' && typeof details.note === 'string';
}

const FEED_CACHE_SIZE = 200;
const feeds = new Map<string, Feed>();

/** Keep the rows of one action under its key and return the details the session may store. */
export function rememberFeed(feedKey: string, feed: Feed, note: string): FeedDetails {
  feeds.delete(feedKey);
  feeds.set(feedKey, feed);
  for (const key of feeds.keys()) {
    if (feeds.size <= FEED_CACHE_SIZE) break;
    feeds.delete(key);
  }
  return { kind: FEED_KIND, version: 1, feedKey, note };
}
export const feedFor = (details: FeedDetails): Feed | null => feeds.get(details.feedKey) ?? null;
export function forgetFeeds(): void { feeds.clear(); }

/** Where the summary starts, and where every row under it and the hint stand. */
const BRANCH_INDENT = 2, BODY_INDENT = 4;

/** The summary and, when expanded, the rest: the first row hangs from the branch sign, the others stand under its text. */
export function bodyRows(feed: Feed, expanded: boolean): Row[] {
  const [first, ...rest] = feed.rows;
  const under = (row: Row): Row => ({ ...row, indent: BODY_INDENT + (row.indent ?? 0), ...(row.hang !== undefined ? { hang: BODY_INDENT + row.hang } : {}) });
  const more = expanded && feed.more?.length ? [{ text: '' }, ...feed.more.map(under)] : [];
  return [...(first ? [{ ...first, indent: BRANCH_INDENT, mark: { text: GLYPH.branch, tone: 'muted' as const } }] : []), ...rest.map(under), ...more];
}

/** The hint under a summary: what ctrl+o opens, or «свернуть»; Pi's own styled key text, so it is not escaped again. */
export function hintLines(hint: string, width: number): string[] {
  return wrapTextWithAnsi(hint, Math.max(1, width - BODY_INDENT)).map(line => ' '.repeat(BODY_INDENT) + line);
}

/** The row of the action itself: its sign and what is being done. `tone` is read when drawn, so a result that arrives later colours it. */
export class ActionHead implements Component {
  constructor(private readonly title: string, private readonly theme: PaintTheme, private readonly tone: () => Tone) {}
  invalidate(): void {}
  render(width: number): string[] {
    return renderRows([{ text: this.title, tone: 'text', bold: true, mark: { text: GLYPH.action, tone: this.tone() } }], this.theme, width);
  }
}

/** The summary of an action and, on ctrl+o, the rest; the hint only when there is something behind it. */
export class ActionBody implements Component {
  constructor(private readonly feed: Feed, private readonly expanded: boolean, private readonly theme: PaintTheme,
    private readonly hint: (expanded: boolean, what: string) => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    const more = !!this.feed.more?.length;
    return [...renderRows(bodyRows(this.feed, this.expanded), this.theme, width),
      ...(more ? hintLines(this.hint(this.expanded, this.feed.expand ?? 'подробнее'), width) : [])];
  }
}

/** A head and a body as one component: how a message that arrives later (a finished run, a prepared set) is drawn. */
export class ActionBlock implements Component {
  constructor(private readonly head: Component, private readonly body: Component) {}
  invalidate(): void {}
  render(width: number): string[] { return [...this.head.render(width), ...this.body.render(width)]; }
}

/** Pi's hint for the expand key; `what` names what it opens. */
export const expandHint = (expanded: boolean, what: string): string => keyHint('app.tools.expand', expanded ? 'свернуть' : what);

/** The tone of the action's sign for a feed: its own, success by default. */
export const feedTone = (feed: Feed | null): Tone => feed?.tone ?? 'success';

/** One summary line in a tone: a partial result, an error, the note of a reopened session. */
export const lineBody = (text: string, tone: Tone, theme: PaintTheme): Component => new ActionBody({ rows: [{ text, tone }] }, false, theme, expandHint);

type Fallback = (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme) => Component;

/**
 * Feed details draw the feed's body; everything else (the result block, progress text, old sessions) goes to
 * `fallback`. `onTone` learns how the action ended, for its sign.
 */
export function renderFeedResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, fallback: Fallback,
  onTone: (tone: Tone) => void = () => {}): Component {
  try {
    const details: unknown = result.details;
    if (!isFeedDetails(details)) return fallback(result, options, theme);
    const feed = feedFor(details);
    // A reopened session keeps only the note: the rows are asked for again from the 0600 store.
    if (!feed) { onTone('muted'); return lineBody(`${details.note} · сессия открыта заново: попросите показать это ещё раз`, 'muted', theme); }
    onTone(feedTone(feed));
    return new ActionBody(feed, options.expanded, theme, expandHint);
  } catch {
    return fallback(result, options, theme);
  }
}

/** The text of a result when nothing better can be drawn: escaped, never parsed. */
export const contentText = (result: AgentToolResult<unknown>): string => safeText(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));

/** The line of a tool call in the feed: what is being done, in the owner's words. No argument dump, no ids. */
export function callText(tool: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const number = typeof a.situation === 'number' ? ` ${a.situation}` : '';
  switch (tool) {
    case 'agent_lab_status': return 'Смотрю, что уже есть';
    case 'agent_lab_prepare': {
      if (a.demo === true) return 'Готовлю учебный пример';
      if (typeof a.suite === 'string') return 'Загружаю набор из файла';
      if (a.withoutLogs === true) return 'Готовлю ситуации по вашим правилам';
      return typeof a.logs === 'string' ? `Собираю ситуации из ${a.logs.split('/').at(-1)}` : 'Собираю ситуации из логов';
    }
    case 'agent_lab_cards': return number ? `Открываю ситуацию${number}` : 'Показываю ситуации';
    case 'agent_lab_edit': {
      const kind = (a.change as { kind?: unknown } | undefined)?.kind;
      return kind === 'rules' ? 'Меняю свод правил' : kind === 'similar' ? `Добавляю похожую на ситуацию${number}` : kind === 'remove' ? `Убираю ситуацию${number}`
        : `Меняю ситуацию${number}: ${kind === 'fact' ? 'что знает клиент' : kind === 'duty' ? 'что должен агент' : kind === 'turn' ? 'поворот' : 'клиент'}`;
    }
    case 'agent_lab_decide': return typeof a.decision === 'string' ? 'Записываю ваше решение' : 'Смотрю, что ждёт вашего решения';
    case 'agent_lab_run': return a.action === 'stop' ? 'Останавливаю' : a.action === 'progress' ? 'Смотрю, как идёт работа' : a.action === 'accept' ? 'Утверждаю ситуации' : 'Запускаю прогон';
    case 'agent_lab_results': return a.compare === true ? 'Сравниваю с прошлым прогоном' : a.report === true ? 'Сохраняю отчёт для заказчика' : typeof a.save === 'string' ? 'Сохраняю набор в файл' : 'Показываю результат';
    case 'agent_lab_explain': return `Разбираю ситуацию${number}`;
    case 'agent_lab_connect': return 'Подключаю агента';
    case 'agent_lab_agree': return `Записываю вашу отметку о решении судьи${number ? ` по ситуации${number}` : ''}`;
    default: return 'Agent Lab';
  }
}
