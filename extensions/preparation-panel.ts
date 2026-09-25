import { span, row, fit, wrap, box, beside, metrics } from './render/panels.ts';
import type { SituationView } from '../src/card/view.js';
import { countText } from '../src/plural.js';
import type { PreparationView } from './preparation-progress.ts';
import type { Line } from './workspace-screens.ts';

export const WORKSPACE_WIDTH = 140;
/** A compact dashboard: measured counts, current work and customer excerpts, with a stacked narrow layout. */
export function preparationPanel(view: PreparationView, cards: SituationView[], available: number, frame = 0): Line[] {
  const width = Math.max(20, Math.min(available, WORKSPACE_WIDTH));
  const ready = cards.filter(card => card.status === 'ready').length;
  const blocked = cards.filter(card => card.status === 'unusable').length;
  const count = view.cards;
  const logs = view.logs;
  const title = view.state === 'paused' ? 'Подготовка остановлена' : view.state === 'complete' ? 'Ситуации собраны' : count ? 'Собираем ситуации' : 'Изучаем реальные обращения';
  const subtitle = count ? `${count.completed} из ${count.total} собрано` : logs ? `${logs.classified} из ${logs.total} разговоров из логов разобрано` : 'Подключаем агента и читаем материалы';
  const ratio = count ? count.completed / Math.max(1, count.total) : logs ? logs.classified / Math.max(1, logs.total) : 0;
  const barWidth = Math.max(10, Math.min(width - 8, 72));
  const filled = Math.round(barWidth * Math.max(0, Math.min(1, ratio)));
  const meta = `${view.elapsedMinutes} мин${view.costUsd === null ? '' : `   ·   $${view.costUsd.toFixed(2)}`}`;
  const mark = view.state === 'working' ? ['◐', '◓', '◑', '◒'][frame % 4] : view.state === 'paused' ? '◷' : '✓';
  const body: Line[] = [...wrap(`${mark}  ${title}`, width, view.state === 'paused' ? 'text' : 'accent').map(line => line.map(part => ({ ...part, bold: true }))), [],
    ...wrap(`${subtitle}   ·   ${meta}`, width),
    [span('━'.repeat(filled), 'accent'), span('─'.repeat(barWidth - filled), 'borderMuted')], []];

  body.push(...metrics([
    { label: 'РАЗОБРАНО', value: logs ? `${logs.classified} / ${logs.total}` : '—', note: 'разговоров из логов', tone: 'text' },
    { label: 'ТЕМЫ', value: logs ? String(logs.topics.length) : '—', note: 'в обращениях клиентов', tone: 'text' },
    { label: 'ГОТОВЫ', value: String(ready), note: 'можно запускать', tone: 'success' },
    { label: 'ОШИБКИ', value: String(blocked), note: 'в карточках Lab', tone: blocked ? 'error' : 'muted' },
  ], width), []);
  const columns = width >= 100;
  const leftWidth = columns ? Math.floor((width - 2) * 0.43) : width;
  const rightWidth = columns ? width - leftWidth - 2 : width;
  const current: Line[] = [];
  if (view.activities.length) {
    for (const activity of view.activities) current.push(...wrap(`● ${activity.label}${activity.count > 1 ? ` × ${activity.count}` : ''}`, leftWidth - 4, 'accent'));
  } else current.push(...wrap(view.state === 'working' ? 'Ждём следующий результат подготовки' : view.state === 'paused' ? 'Работа остановлена. Результаты сохранены.' : 'Подготовка завершена. Карточки ниже.', leftWidth - 4));
  if (count) current.push([], ...wrap(`${countText(count.pending, ['ситуация', 'ситуации', 'ситуаций'])} в очереди`, leftWidth - 4, 'muted'));
  if (logs) current.push([], ...wrap(`${logs.classified === logs.total ? '✓' : '◌'} Разбор логов${logs.classified === logs.total ? ' завершён' : ' идёт'}`, leftWidth - 4, logs.classified === logs.total ? 'success' : 'text'));
  if (logs?.excluded) current.push(...wrap(`Пропущено до генерации: ${logs.excluded}`, leftWidth - 4, 'muted'));
  if (count?.failed) current.push([], ...wrap(`Не удалось собрать карточку: ${count.failed}`, leftWidth - 4, 'error'), ...wrap('Причины сохранены в журнале подготовки.', leftWidth - 4, 'muted'));
  const examples: Line[] = [];
  for (const [i, example] of view.examples.entries()) {
    if (i) examples.push([]);
    examples.push(row(fit(`${String(i + 1).padStart(2, '0')}  ${example.topic}`, rightWidth - 4), 'accent', true));
    const lines = wrap(`«${example.quote}»`, rightWidth - 4);
    examples.push(...lines.slice(0, 2));
    if (lines.length > 2) examples[examples.length - 1] = row(fit(lines[1]!.map(part => part.text).join(''), rightWidth - 5) + '…');
  }
  if (!examples.length) examples.push(...wrap('Первые примеры появятся после разметки диалогов.', rightWidth - 4, 'muted'));
  if (columns) {
    const height = Math.max(current.length, examples.length);
    while (current.length < height) current.push([]);
    while (examples.length < height) examples.push([]);
  }
  const left = box('Что делает Lab', current, leftWidth), right = box('Обращения из ваших логов', examples, rightWidth);
  body.push(...(columns ? beside(left, right, leftWidth) : [...left, [], ...right]), []);
  return body;
}
