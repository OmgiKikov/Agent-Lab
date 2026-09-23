import { keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Feed } from '../conversation.ts';
import { safeText } from '../cards.ts';
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

export const FEED_KIND = 'agent-lab/feed';

/**
 * Where the rows can be rebuilt from when the memory copy is gone (a reopened session, an evicted entry): the run and the
 * immutable library revisions by hash. Ids and hashes only — the session file never gets card text (REV-01).
 */
export interface FeedRef { view: 'library' | 'card' | 'change'; directory: string; runId: string; libraryId: string; hash: string; beforeHash?: string; variantId?: string }
/** `note` names the action and the run by short id and counts — never a title, a quote or a value. */
export interface FeedDetails { kind: typeof FEED_KIND; version: 1; feedKey: string; note: string; ref?: FeedRef }

export function isFeedDetails(value: unknown): value is FeedDetails {
  if (!value || typeof value !== 'object') return false;
  const details = value as Partial<FeedDetails>;
  return details.kind === FEED_KIND && details.version === 1 && typeof details.feedKey === 'string' && typeof details.note === 'string';
}

const FEED_CACHE_SIZE = 200;
const feeds = new Map<string, Feed>();

/** Keep the rows of one action under its tool call id and return the details the session may store. */
export function rememberFeed(feedKey: string, feed: Feed, note: string, ref?: FeedRef): FeedDetails {
  feeds.delete(feedKey);
  feeds.set(feedKey, feed);
  for (const key of feeds.keys()) {
    if (feeds.size <= FEED_CACHE_SIZE) break;
    feeds.delete(key);
  }
  return { kind: FEED_KIND, version: 1, feedKey, note, ...(ref ? { ref } : {}) };
}
export const feedFor = (details: FeedDetails): Feed | null => feeds.get(details.feedKey) ?? null;
export function forgetFeeds(): void { feeds.clear(); }

/** Rows first, details only when expanded, and the expand hint only when there is something behind it. */
export class FeedBlock implements Component {
  constructor(private readonly feed: Feed, private readonly expanded: boolean, private readonly theme: PaintTheme, private readonly hint: (expanded: boolean) => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    const more = this.feed.more?.length ? this.feed.more : undefined;
    const rows: Row[] = this.expanded && more ? [...this.feed.rows, { text: '' }, ...more] : this.feed.rows;
    return [...renderRows(rows, this.theme, width), ...(more ? wrapTextWithAnsi(this.hint(this.expanded), width) : [])];
  }
}

type Fallback = (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme) => Component;

/** The cache only speeds drawing up. What a row showed is rebuilt from the stored revisions it points at. */
let restorer: ((ref: FeedRef) => Promise<Feed | null>) | undefined;
export function setFeedRestorer(restore: typeof restorer): void { restorer = restore; }
const restoring = new Set<string>();
function restore(details: FeedDetails, redraw?: () => void): boolean {
  if (!details.ref || !restorer) return false;
  if (restoring.has(details.feedKey)) return true;
  restoring.add(details.feedKey);
  void restorer(details.ref).then(feed => { if (feed) { rememberFeed(details.feedKey, feed, details.note, details.ref); redraw?.(); } })
    .catch(() => {}).finally(() => { restoring.delete(details.feedKey); });
  return true;
}

/** Feed details draw the feed; everything else (verdict blocks, progress text, errors, old sessions) goes to `fallback`. */
export function renderFeedResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, fallback: Fallback, redraw?: () => void): Component {
  try {
    const details: unknown = result.details;
    if (!isFeedDetails(details)) return fallback(result, options, theme);
    const feed = feedFor(details);
    if (!feed) {
      // Rebuilt from the stored revision when the row points at one; otherwise the note and an honest hint.
      const coming = restore(details, redraw);
      return new Text(theme.fg('muted', safeText(`${details.note} · ${coming ? 'восстанавливаю из сохранённой ревизии' : 'сессия открыта заново: попросите показать это ещё раз'}`)), 0, 0);
    }
    return new FeedBlock(feed, options.expanded, theme, expanded => keyHint('app.tools.expand', expanded ? 'свернуть' : 'подробнее'));
  } catch {
    return fallback(result, options, theme);
  }
}

const looksLikeId = (value: string): boolean => /^[A-Za-z0-9_-]{16,}$/.test(value) || /^(variant|business|fact|owner)_/.test(value);
const named = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!text || looksLikeId(text)) return '';
  return /^#?\d+$/.test(text) ? ` №${text.replace('#', '')}` : ` «${text}»`;
};

/** The line of a tool call in the feed: what is being done, in the owner's words. No argument dump, no ids. */
export function callText(tool: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  if (tool === 'agent_lab_status') return 'Смотрю, что уже есть';
  if (tool === 'agent_lab_build') {
    const file = typeof a.dialoguesFile === 'string' ? ` · ${a.dialoguesFile.split('/').at(-1)}` : '';
    return a.mode === 'validate' ? `Собираю сценарии из логов${file}` : a.mode === 'demo' ? 'Готовлю учебный пример'
      : a.mode === 'discover' ? `Ищу проверяемую гипотезу в логах${file}` : a.mode === 'score' ? `Оцениваю записанные диалоги${file}` : 'Готовлю сценарии по требованиям';
  }
  if (tool === 'agent_lab_scenarios') {
    const card = named(a.variant);
    switch (a.operation) {
      case 'edit': return `Правлю карточку${card}`;
      case 'variant': return `Добавляю вариант к карточке${card}`;
      case 'remove': return `Убираю карточку${card}`;
      case 'resolve': return `Записываю ваше решение по карточке${card}`;
      case 'merge': return 'Объединяю группы сценариев';
      case 'split': return 'Выделяю карточки в отдельную группу';
      case 'assess': return 'Перепроверяю смысл сценариев';
      case 'accept': return 'Принимаю набор сценариев';
      case 'budget': return 'Меняю лимит вызовов модели';
      default: return a.variant || a.variantId ? `${a.source ? 'Открываю источник карточки' : 'Открываю карточку'}${card}` : 'Читаю сценарии';
    }
  }
  if (tool === 'agent_lab_run') return a.action === 'stop' ? 'Останавливаю прогон' : a.action === 'progress' ? 'Смотрю, как идёт прогон' : 'Готовлю запуск';
  if (tool === 'agent_lab_inspect') return a.failure !== undefined ? `Открываю провал ${String(a.failure)}` : a.dialogue || a.trialId ? 'Открываю диалог'
    : a.compare ? 'Сравниваю с прошлым прогоном' : a.export ? 'Сохраняю отчёт' : 'Читаю результаты';
  const fixed: Record<string, string> = {
    agent_lab_edit: 'Правлю настройки черновика', agent_lab_accept: 'Показываю ожидания на подтверждение', agent_lab_repeat: 'Готовлю повтор набора',
    agent_lab_issues: 'Смотрю постоянные проблемы', agent_lab_resolution: 'Проверяю исправление', agent_lab_diagnostics: 'Проверяю гипотезу парной диагностикой',
    agent_lab_suite: a.action === 'save' ? 'Сохраняю набор в файл' : a.action === 'load' ? 'Загружаю набор из файла' : 'Смотрю сохранённые наборы',
    agent_lab_gateway: a.action === 'save' ? 'Проверяю доступ к шлюзу моделей' : a.action === 'forget' ? 'Отключаю шлюз моделей' : 'Смотрю, подключён ли шлюз моделей',
    agent_lab_import: a.kind === 'cases' ? 'Читаю кейсы из .xlsx' : 'Читаю диалоги из .xlsx',
    agent_lab_connection: a.action === 'check' ? 'Проверяю подключение к агенту' : 'Читаю подключение к агенту', agent_lab_reassess: 'Переоцениваю сохранённые диалоги',
    agent_lab_review: 'Показываю диалог для вашей оценки', agent_lab_agree: 'Записываю вашу отметку о решении судьи', agent_lab_prompt: 'Готовлю изменение промпта', agent_lab_generator: 'Оцениваю генератор сценариев',
  };
  return fixed[tool] ?? 'Agent Lab';
}
