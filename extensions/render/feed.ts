import { keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Feed } from '../conversation.ts';
import { safeText } from '../../src/text.js';
import { renderRows, type PaintTheme, type Row } from './theme.ts';

/*
 * The chat feed: what one Agent Lab action looks like in the conversation. A row of the feed is a
 * short sentence about the result; `app.tools.expand` opens the card, the source, the dialogue or
 * the before/after of a change under it. JSON, hashes and tool arguments stay in the model's content.
 *
 * The session file is 0644, so `details` hold ids and a neutral note only (REV-01). The rows live in
 * memory while Pi runs; a reopened session shows the note, and the same request rebuilds the rows
 * from the 0600 store.
 */

const FEED_KIND = 'agent-lab/feed';

/** `note` names the action and the run by short id and counts — never a title, a quote or a value. */
interface FeedDetails { kind: typeof FEED_KIND; version: 1; feedKey: string; note: string }

export function isFeedDetails(value: unknown): value is FeedDetails {
  if (!value || typeof value !== 'object') return false;
  const details = value as Partial<FeedDetails>;
  return details.kind === FEED_KIND && details.version === 1 && typeof details.feedKey === 'string' && typeof details.note === 'string';
}

const FEED_CACHE_SIZE = 200;
const feeds = new Map<string, Feed>();

/** Keep the rows of one action under its tool call id and return the details the session may store. */
export function rememberFeed(feedKey: string, feed: Feed, note: string): FeedDetails {
  feeds.delete(feedKey);
  feeds.set(feedKey, feed);
  for (const key of feeds.keys()) {
    if (feeds.size <= FEED_CACHE_SIZE) break;
    feeds.delete(key);
  }
  return { kind: FEED_KIND, version: 1, feedKey, note };
}
const feedFor = (details: FeedDetails): Feed | null => feeds.get(details.feedKey) ?? null;
export function forgetFeeds(): void { feeds.clear(); }

/** Rows first, details only when expanded, and the expand hint only when there is something behind it. */
class FeedBlock implements Component {
  constructor(private readonly feed: Feed, private readonly expanded: boolean, private readonly theme: PaintTheme, private readonly hint: (expanded: boolean) => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    const more = this.feed.more?.length ? this.feed.more : undefined;
    const rows: Row[] = this.expanded && more ? [...this.feed.rows, { text: '' }, ...more] : this.feed.rows;
    return [...renderRows(rows, this.theme, width), ...(more ? wrapTextWithAnsi(this.hint(this.expanded), width) : [])];
  }
}

type Fallback = (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme) => Component;

/** Feed details draw the feed; everything else (verdict blocks, progress text, errors, old sessions) goes to `fallback`. */
export function renderFeedResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, fallback: Fallback): Component {
  try {
    const details: unknown = result.details;
    if (!isFeedDetails(details)) return fallback(result, options, theme);
    const feed = feedFor(details);
    // A reopened session keeps only the note: the rows are asked for again from the 0600 store.
    if (!feed) return new Text(theme.fg('muted', safeText(`${details.note} · сессия открыта заново: попросите показать это ещё раз`)), 0, 0);
    return new FeedBlock(feed, options.expanded, theme, expanded => keyHint('app.tools.expand', expanded ? 'свернуть' : 'подробнее'));
  } catch {
    return fallback(result, options, theme);
  }
}

/** The line of a tool call in the feed: what is being done, in the owner's words. No argument dump, no ids. */
export function callText(tool: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const card = typeof a.card === 'number' ? ` ${a.card}` : '';
  if (tool === 'agent_lab_build') {
    const file = typeof a.dialoguesFile === 'string' ? ` · ${a.dialoguesFile.split('/').at(-1)}` : '';
    return a.mode === 'validate' ? `Собираю ситуации из логов${file}` : a.mode === 'demo' ? 'Готовлю учебный пример' : 'Готовлю ситуации по вашим правилам';
  }
  if (tool === 'agent_lab_run') return a.action === 'stop' ? 'Останавливаю прогон' : a.action === 'progress' ? 'Смотрю, как идёт прогон' : 'Готовлю запуск';
  if (tool === 'agent_lab_inspect') return a.failure !== undefined ? `Открываю ошибку ${String(a.failure)}` : a.dialogue || a.trialId ? 'Открываю разговор'
    : a.compare ? 'Сравниваю с прошлым прогоном' : a.export ? 'Сохраняю отчёт' : 'Читаю результат';
  if (tool === 'agent_lab_cards') return card ? `Открываю ситуацию${card}` : 'Показываю ситуации';
  const fixed: Record<string, string> = {
    agent_lab_status: 'Смотрю, что уже есть', agent_lab_card_fact: `Меняю ситуацию${card}: что знает клиент`, agent_lab_card_expectation: `Меняю ситуацию${card}: что должен агент`,
    agent_lab_card_client: `Меняю ситуацию${card}: клиент`, agent_lab_card_answer: `Записываю ваш ответ по ситуации${card}`, agent_lab_card_similar: `Добавляю похожую на ситуацию${card}`,
    agent_lab_card_remove: `Убираю ситуацию${card}`, agent_lab_card_check: 'Проверяю ситуации', agent_lab_resume_preparation: 'Продолжаю подготовку ситуаций',
    agent_lab_edit: 'Правлю настройки черновика', agent_lab_accept: 'Утверждаю ситуации', agent_lab_repeat: 'Готовлю повтор набора',
    agent_lab_suite: a.action === 'save' ? 'Сохраняю набор в файл' : a.action === 'load' ? 'Загружаю набор из файла' : 'Смотрю сохранённые наборы',
    agent_lab_connection: a.action === 'check' ? 'Проверяю подключение к агенту' : 'Читаю подключение к агенту', agent_lab_reassess: 'Переоцениваю сохранённые разговоры',
    agent_lab_review: 'Показываю разговор для вашей оценки', agent_lab_agree: 'Записываю вашу отметку о решении судьи',
  };
  return fixed[tool] ?? 'Agent Lab';
}
