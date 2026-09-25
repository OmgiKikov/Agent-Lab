import { dutyNotes, dutySections } from '../src/card/duty-words.js';
import { situationActions, type SituationView } from '../src/card/view.js';
import type { Line, Screen, SpaceData, Hint } from './workspace-screens.ts';
import type { Tone } from './render/theme.ts';
import { row, wrap, box, beside, metrics, selection, quote, numbered } from './render/panels.ts';
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
export function situationExplanation(view: SituationView, width: number, editable: boolean, sources = true): Line[] {
  const status = STATUS[view.status];
  const body: Line[] = [...wrap(view.brief.title, width).map(line => line.map(part => ({ ...part, bold: true }))),
    ...wrap(`${status.short}  ·  ${view.brief.source.replace(/^Из диалога/i, 'Из лога')}`, width, status.tone), []];
  if (view.question) body.push(row('Нужно ваше решение', 'warning', true), ...wrap(readable(view.question.text), width), []);
  if (editable) {
    const actions = situationActions(view);
    if (actions.length) body.push(...wrap(actions.map((action, index) =>
      `[${index + 1}] ${action.kind === 'answer' ? action.choice.label : action.label}`).join('   '), width, 'accent'), []);
  }
  body.push(row('Запрос клиента', 'text', true), ...quote(view.brief.writes, width), []);
  if (view.status === 'unusable') {
    body.push(...wrap('Почему пока нельзя запустить', width, 'error'),
      ...wrap('Lab составил карточку с ошибками. Это не оценка вашего агента.', width, 'muted'), []);
    for (const [index, problem] of view.problems.entries()) body.push(...numbered(readable(problem), index + 1, width), []);
    if (!view.problems.length) body.push(...wrap('Причина не сохранена. Нельзя объяснить отказ по имеющимся данным.', width), []);
  }
  for (const { heading, items } of dutySections(view.brief.must)) {
    body.push(row(heading, 'text', true), []);
    for (const { number, duty: must } of items) {
      body.push(...numbered(must.text, number, width), ...dutyNotes(must).flatMap(note => wrap(note, width, 'muted')));
      if (sources && must.rule) body.push(row('Основание в материалах:', 'muted'), ...wrap(`«${must.rule}»`, width, 'muted'));
      body.push([]);
    }
  }
  if (!sources) body.push(...wrap('Enter  Открыть основания из материалов', width, 'accent'));
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
  const body: Line[] = [row('Ситуации для проверки', 'text', true),
    ...wrap(width >= 100 ? 'Выберите обращение слева. Справа — запрос клиента и критерии ответа.' : '↑↓ Сменить ситуацию · Enter Открыть карточку', width, 'muted'), [],
    ...metrics([
      { label: 'ГОТОВЫ', value: String(ready), note: 'можно запускать', tone: 'success' },
      { label: 'НУЖЕН ВАШ ОТВЕТ', value: String(questions), note: 'уточнения по карточкам', tone: questions ? 'warning' : 'muted' },
      { label: 'НА ДОРАБОТКЕ', value: String(blocked + checking), note: blocked || checking ? `ошибки Lab: ${blocked} · на проверке: ${checking}` : 'замечаний к карточкам нет', tone: blocked ? 'error' : 'muted' },
    ], width), []];
  const items: number[] = [];
  let anchor = body.length;
  if (width < 100) {
    items.push(anchor);
    body.push(row(`Ситуация ${chosen.number} · ${selected + 1} из ${cards.length}`, 'accent', true), [], ...situationExplanation(chosen, width, set.editable, false));
  } else {
    const leftWidth = Math.floor(width * 0.38), rightWidth = width - leftWidth - 2;
    const start = Math.max(0, Math.min(selected - 3, cards.length - 7));
    const shown = cards.slice(start, start + 7);
    const list: Line[] = [];
    if (start) list.push(row(`↑ Ещё ${start}`, 'muted'), []);
    for (const card of shown) {
      const mine = card.id === chosen.id;
      const at = body.length + 2 + list.length;
      items.push(at);
      if (mine) anchor = at;
      const status = STATUS[card.status];
      const titleLines = wrap(card.brief.title, leftWidth - 11);
      const title = titleLines.slice(0, 2).map((line, i) => row(`${i ? '      ' : `${mine ? '›' : ' '} ${String(card.number).padStart(2, '0')}  `}${line.map(part => part.text).join('')}${i === 1 && titleLines.length > 2 ? '…' : ''}`, mine ? 'accent' : 'text', mine));
      const item = [...title, row(`      ${status.short}`, status.tone)];
      list.push(...(mine ? selection(item, leftWidth - 4) : item), []);
    }
    const below = cards.length - start - shown.length;
    if (below) list.push(row(`↓ Ещё ${below}`, 'muted'));
    const detail = situationExplanation(chosen, rightWidth - 4, set.editable, false);
    const height = Math.max(list.length, detail.length);
    while (list.length < height) list.push([]);
    while (detail.length < height) detail.push([]);
    body.push(...beside(box(`Ситуации · ${cards.length}`, list, leftWidth), box(`Карточка ${chosen.number} из ${cards.length}`, detail, rightWidth, 'accent'), leftWidth));
  }
  return { head: [], body, foot, anchor, items };
}
