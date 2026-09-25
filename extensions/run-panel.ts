import type { Line, SpaceData } from './workspace-screens.ts';
import { row, span, wrap, box, beside, metrics, action } from './render/panels.ts';
import { WORKSPACE_WIDTH } from './preparation-panel.ts';
import { countText } from '../src/plural.js';

/** A launch overview from the same saved plan as the confirmation dialog. */
export function runPanel(data: SpaceData, available: number, details = false): Line[] {
  const set = data.set!;
  const { plan, record } = set;
  const width = Math.max(20, Math.min(available, WORKSPACE_WIDTH));
  const active = data.progress?.kind === 'run';
  const excluded = set.views.filter(view => view.status !== 'ready');
  const body: Line[] = [row(active ? '◐  Прогон идёт' : 'Готовы проверить агента', 'text', true),
    ...wrap(active ? 'Ответы и оценки появляются в «Результате» по мере готовности.' : 'Lab разыграет обращения клиентов и проверит ответы по вашим материалам.', width, 'muted'), []];
  body.push(...metrics([
    { label: 'СИТУАЦИИ', value: `${plan.situations} / ${set.views.length || plan.situations}`, note: 'войдут в проверку', tone: 'accent' },
    { label: 'ПОВТОРЫ', value: String(record.settings.repeats), note: 'для каждой ситуации', tone: 'text' },
    { label: 'РАЗГОВОРЫ', value: String(plan.conversations), note: 'клиента играет Lab', tone: 'text' },
  ], width), []);
  body.push(...action(active ? '→' : 'Enter', active ? 'Смотреть ответы и оценки' : `Перейти к запуску · ${countText(plan.conversations, ['разговор', 'разговора', 'разговоров'])}`, width),
    ...wrap(active ? 'Прогон продолжится, если закрыть доску.' : record.mode === 'demo' ? 'Учебный пример без оплаты.' : 'Платные модели · перед запуском откроется подтверждение', width, 'muted'), []);
  if (active) {
    const share = data.progress?.share;
    if (share !== null && share !== undefined) {
      const size = Math.min(72, width), filled = Math.round(size * Math.max(0, Math.min(1, share)));
      body.push([span('━'.repeat(filled), 'accent'), span('─'.repeat(size - filled), 'borderMuted')]);
    }
    body.push(...wrap(data.progress!.text, width), []);
  }
  const columns = width >= 100;
  const leftWidth = columns ? Math.floor((width - 2) * 0.55) : width;
  const rightWidth = columns ? width - leftWidth - 2 : width;
  const steps: Line[] = [];
  for (const [title, text] of [
    ['01  Клиент обращается', 'Lab берёт запрос из карточки и отвечает на уточнения агента.'],
    ['02  Ваш агент отвечает', 'Разговор проходит через подключённого агента.'],
    ['03  Lab оценивает ответ', 'Сравнивает ответ с ожиданиями карточки и показывает конкретные расхождения.'],
  ]) steps.push(...wrap(title!, leftWidth - 4, 'accent'), ...wrap(text!, leftWidth - 4), []);
  const aside: Line[] = [];
  if (excluded.length) {
    aside.push(...wrap(`Пока вне прогона: ${excluded.length}`, rightWidth - 4, 'warning'), []);
    for (const view of excluded) aside.push(...wrap(`${view.number}. ${view.brief.title}`, rightWidth - 4),
      ...wrap(view.status === 'needs_owner' ? 'Есть вопрос по карточке' : view.status === 'unusable' ? 'Карточку нужно исправить' : 'Проверка ещё не завершена', rightWidth - 4, 'muted'), []);
    aside.push(...wrap('Причины и действия — в «Ситуациях».', rightWidth - 4, 'muted'));
  } else aside.push(...wrap('✓ Все ситуации входят в прогон', rightWidth - 4, 'success'), [],
    ...wrap('В результате будут ответы агента, оценки и причины ошибок.', rightWidth - 4));
  if (columns) {
    const height = Math.max(steps.length, aside.length);
    while (steps.length < height) steps.push([]);
    while (aside.length < height) aside.push([]);
  }
  const left = box('Как пройдёт проверка', steps, leftWidth);
  const right = box(excluded.length ? 'Что пока не войдёт' : 'Готовность', aside, rightWidth);
  body.push(...(columns ? beside(left, right, leftWidth) : [...left, [], ...right]), []);
  body.push(...wrap('d  Параметры и стоимость проверки', width, 'muted'));
  if (details) body.push([], row('Параметры прогона', 'accent', true), ...set.launch?.flatMap(line => wrap(line, width)) ?? []);
  return body;
}
