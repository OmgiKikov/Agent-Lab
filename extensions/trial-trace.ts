import type { Trial } from '../src/contracts.js';
import type { Line } from './workspace-screens.ts';
import { row, wrap } from './render/panels.ts';

/** The recorded tool boundary, including actual sources and replies; never reconstruct evidence from a later lookup. */
export function trialTrace(trial: Trial, width: number): Line[] {
  const body: Line[] = [row('ЗАПРОСЫ, ИНСТРУМЕНТЫ И ОТВЕТЫ', 'accent', true),
    ...wrap('Сохранённая трасса этого разговора. PgUp / PgDn — листать, d — вернуться к оценке.', width, 'muted'), []];
  const value = (item: unknown): Line[] => (typeof item === 'string' ? item : JSON.stringify(item, null, 2) ?? 'Нет данных')
    .split('\n').flatMap(line => wrap(line, width));
  for (const event of trial.events) {
    if (event.type === 'user' || event.type === 'assistant') {
      body.push(row(event.type === 'user' ? 'КЛИЕНТ' : 'АГЕНТ', 'accent', true), ...value(event.text), []);
    } else if (event.type === 'tool_call') {
      body.push(...wrap(`→ ${event.tool}`, width, 'accent'), ...value(event.args), []);
    } else if (event.type === 'tool_result') {
      body.push(...wrap(`← Ответ ${event.tool}`, width, 'success'), ...value(event.result), []);
    } else if (event.type === 'error') {
      body.push(row('ОШИБКА', 'error', true), ...value(event.text ?? event.result), []);
    }
  }
  if (!trial.events.some(event => event.type === 'tool_call')) body.push(...wrap('Запросы к инструментам в этой трассе не сохранены.', width, 'muted'));
  return body;
}
