import { situationActions, type SituationView } from '../src/card/view.js';
import type { Line, Screen, SpaceData, Hint } from './workspace-screens.ts';
import type { Tone } from './render/theme.ts';
import { row, fit, wrap, box, beside, metrics } from './render/panels.ts';
import { WORKSPACE_WIDTH } from './preparation-panel.ts';

const STATUS: Record<SituationView['status'], { label: string; short: string; tone: Tone }> = {
  ready: { label: 'Готова к запуску', short: '✓ готова', tone: 'success' },
  needs_owner: { label: 'Есть вопрос к вам', short: '? вопрос', tone: 'warning' },
  unusable: { label: 'Нужно исправить карточку', short: '× исправить', tone: 'error' },
  checking: { label: 'Ожидает проверки', short: '◌ проверка', tone: 'muted' },
};

/** Explain stored field names without changing the reviewer's claim or inventing a diagnosis. */
function readable(reason: string): string {
  return reason.replace(/disclosure on_request/g, '«клиент сообщит по запросу»').replace(/\bon_request\b/g, '«клиент сообщит по запросу»')
    .replace(/value=null/g, 'значение не задано').replace(/\bnull\b/gi, '«не задано»')
    .replace(/\bvague\b/g, '«неясный запрос»').replace(/\bignored\b/g, '«пропустить реплику»')
    .replace(/\bstop\b/g, '«конец разговора»').replace(/\bcoverage\b/g, 'разбор реплик')
    .replace(/\be(\d+)\b/g, 'ожидание №$1');
}

/** Full evidence in reading order; reasons and source quotes are never truncated. */
export function situationExplanation(view: SituationView, width: number, editable: boolean): Line[] {
  const status = STATUS[view.status];
  const body: Line[] = [...wrap(view.brief.title, width).map(line => line.map(part => ({ ...part, bold: true }))),
    row(status.label, status.tone, true), row(view.brief.source, 'muted'), [], row('ЗАПРОС КЛИЕНТА', 'accent', true), ...wrap(`«${view.brief.writes}»`, width), []];
  if (view.status === 'unusable') {
    body.push(row('ПОЧЕМУ КАРТОЧКА НЕ ПРОШЛА ПРОВЕРКУ', 'error', true),
      ...wrap('Это замечания к ситуации, которую составил Lab.', width, 'muted'), []);
    for (const [index, problem] of view.problems.entries()) body.push(...wrap(`${index + 1}. ${readable(problem)}`, width), []);
    if (!view.problems.length) body.push(...wrap('Причина не сохранена. Нельзя объяснить отказ по имеющимся данным.', width), []);
  }
  if (view.question) body.push(row('ВОПРОС К ВАМ', 'warning', true), ...wrap(readable(view.question.text), width), []);
  body.push(row('ЧТО LAB ПРЕДЛАГАЕТ ПРОВЕРЯТЬ', 'accent', true));
  for (const [index, must] of view.brief.must.entries()) {
    body.push(...wrap(`${index + 1}. ${must.text}`, width));
    if (must.rule) body.push(row('Основание в материалах:', 'muted'), ...wrap(`«${must.rule}»`, width, 'muted'));
    body.push([]);
  }
  if (editable) {
    const actions = situationActions(view);
    if (actions.length) body.push(row('ДЕЙСТВИЯ', 'accent', true), ...actions.flatMap((action, index) =>
      wrap(`${index + 1}  ${action.kind === 'answer' ? action.choice.label : action.label}`, width, 'accent')), []);
  }
  body.push(...wrap('a  Обсудить эту ситуацию с Lab', width, 'muted'));
  return body;
}

/** Browse compact titles while the selected card's actual rejection stays readable beside them. */
export function situationBrowser(data: SpaceData, selected: number, available: number, foot: Hint[]): Screen {
  const set = data.set!;
  const cards = set.views;
  const chosen = cards[selected] ?? cards[0]!;
  const width = Math.min(available, WORKSPACE_WIDTH);
  const ready = cards.filter(card => card.status === 'ready').length;
  const blocked = cards.filter(card => card.status === 'unusable').length;
  const questions = cards.filter(card => card.status === 'needs_owner').length;
  const checking = cards.length - ready - blocked - questions;
  const body: Line[] = [row('Ситуации для проверки', 'accent', true),
    ...wrap(`${cards.length} карточек из обращений клиентов · выберите любую, чтобы увидеть запрос и ожидания`, width, 'muted'), [],
    ...metrics([
      { label: 'ГОТОВЫ', value: String(ready), note: 'можно запускать', tone: 'success' },
      { label: 'НУЖЕН ВАШ ОТВЕТ', value: String(questions), note: 'уточнения по карточкам', tone: questions ? 'warning' : 'muted' },
      { label: 'НА ДОРАБОТКЕ', value: String(blocked + checking), note: `${blocked} ошибок · ${checking} на проверке`, tone: blocked ? 'error' : 'muted' },
    ], width), []];
  if (width < 100) {
    body.push(row(`Ситуация ${chosen.number} · ${selected + 1} из ${cards.length}`, 'accent', true), [], ...situationExplanation(chosen, width, set.editable));
  } else {
    const leftWidth = Math.floor(width * 0.38), rightWidth = width - leftWidth - 2;
    const start = Math.max(0, Math.min(selected - 4, cards.length - 10));
    const shown = cards.slice(start, start + 10);
    const list: Line[] = [];
    if (start) list.push(row(`↑ Ещё ${start}`, 'muted'), []);
    for (const card of shown) {
      const mine = card.id === chosen.id;
      const status = STATUS[card.status];
      list.push(row(fit(`${mine ? '›' : ' '} ${String(card.number).padStart(2, '0')}  ${card.brief.title}`, leftWidth - 4), mine ? 'accent' : 'text', mine),
        row(`      ${status.short}`, status.tone), []);
    }
    const below = cards.length - start - shown.length;
    if (below) list.push(row(`↓ Ещё ${below}`, 'muted'));
    const detail = situationExplanation(chosen, rightWidth - 4, set.editable);
    body.push(...beside(box('СИТУАЦИИ', list, leftWidth), box(`СИТУАЦИЯ ${chosen.number}`, detail, rightWidth), leftWidth));
  }
  return { head: [], body, foot, anchor: 0, items: [0] };
}
