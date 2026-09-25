import type { ResultView } from '../src/result-view.js';
import { accuracyParts, evaluationEvidenceLines, nextStepText, whenText } from '../src/result-text.js';
import type { Line, ResultPick, Screen, SpaceData } from './workspace-screens.ts';
import { box, beside, row, span, wrap, metrics, selection, quote } from './render/panels.ts';

/** The board's overview uses the same verdicts as the report; the complete methodology stays under d. */
function entries(view: ResultView): { title: string; note?: string; pick: ResultPick; group: 'next' | 'failure' }[] {
  const next = view.next.flatMap(step => {
    switch (step.kind) {
      case 'why_unmeasured': return [{ title: `Разобрать ${step.count} ситуаций без оценки`, pick: { kind: 'unmeasured' } as ResultPick }];
      case 'exam': return [{ title: nextStepText(step), pick: { kind: 'connection' } as ResultPick }];
      case 'check_connection': return [{ title: 'Проверить подключение и контрольные ситуации', pick: { kind: 'connection' } as ResultPick }];
      case 'review_judge': return [{ title: 'Проверить оценки судьи', note: 'Открыть разговор и сверить вывод с ответом агента', pick: { kind: 'review' } as ResultPick }];
      case 'blind_check': return [{ title: 'Проверить судью вслепую', note: `${step.left} ответов агента — оценить, не видя вердиктов судьи`, pick: { kind: 'blind' } as ResultPick }];
      case 'repeat': return [{ title: 'Повторить проверку', pick: { kind: 'repeat' } as ResultPick }];
      case 'report': return [{ title: 'Сохранить отчёт', pick: { kind: 'report' } as ResultPick }];
      case 'wait': return [];
    }
  }).map(item => ({ ...item, group: 'next' as const }));
  return [...next, ...view.failures.map(failure => ({ title: failure.title,
    note: failure.said ? `Агент: «${failure.said.quote}»` : 'Открыть разговор, ожидания и оценку',
    pick: { kind: 'failure' as const, trialId: failure.trialId }, group: 'failure' as const }))];
}

export const dashboardPicks = (view: ResultView): ResultPick[] => entries(view).map(entry => entry.pick);

export function resultDashboard(data: SpaceData, run: SpaceData['runs'][number], selected: number, actions: string[], width: number): Screen & { picks: ResultPick[] } {
  const { view, record } = run;
  const active = data.progress?.kind === 'run' && data.runs[0] === run;
  const uncertain = view.notMeasured.alarm || !!view.control.alarm;
  const title = active ? 'Проверка идёт' : uncertain ? 'Проверка требует разбора' : !view.headline.decided ? 'Оценки пока нет' : 'Результаты проверки';
  const subtitle = view.control.alarm ? 'Контрольные ситуации не подтвердили надёжность проверки.'
    : uncertain ? `${view.notMeasured.total} из ${view.notMeasured.of} ситуаций не получили оценку. Общий вывод об агенте делать рано.`
    : active ? 'Завершённые разговоры доступны ниже. Результаты обновляются автоматически.'
    : 'Выберите разговор, чтобы увидеть ответ агента и основания оценки.';
  const body: Line[] = [row(title, uncertain ? 'warning' : 'accent', true), ...wrap(subtitle, width, 'muted'), [],
    ...metrics([
      { label: 'СПРАВИЛСЯ', value: String(view.headline.passed), note: 'ситуаций', tone: 'success' },
      { label: 'НЕ СПРАВИЛСЯ', value: String(view.headline.decided - view.headline.passed), note: 'по оценке судьи', tone: view.headline.decided > view.headline.passed ? 'error' : 'muted' },
      { label: active ? 'ЕЩЁ БЕЗ ОЦЕНКИ' : 'НЕ ИЗМЕРЕНО', value: String(view.notMeasured.total + view.pending), note: active ? 'включая ожидающие' : 'нужен разбор причин', tone: view.notMeasured.total + view.pending ? 'warning' : 'muted' },
    ], width), []];
  const columns = width >= 100;
  const leftWidth = columns ? Math.floor((width - 2) * 0.48) : width;
  const rightWidth = columns ? width - leftWidth - 2 : width;
  const summary: Line[] = [];
  if (uncertain) summary.push(...wrap('Итоговая точность не подтверждена', leftWidth - 4, 'warning'));
  else {
    const accuracy = accuracyParts(view);
    summary.push(...wrap(accuracy.value ? `Точность: ${accuracy.value} · ${view.headline.passed} из ${view.headline.decided} оценённых ситуаций` : 'Нет оценённых ситуаций', leftWidth - 4, 'accent'));
  }
  if (view.notMeasured.reasons.length) summary.push([], row('Почему нет оценки', 'text', true));
  for (const reason of view.notMeasured.reasons.slice(0, 3)) summary.push(...wrap(`${reason.count} — ${reason.label}`, leftWidth - 4));
  if (view.notMeasured.reasons.length > 3) summary.push(...wrap('Остальные причины — в подробностях (d)', leftWidth - 4, 'muted'));
  if (active) summary.push(...wrap(data.progress!.text, leftWidth - 4));
  summary.push([], ...wrap(`Прогон ${whenText(record.createdAt, data.now)} · ${record.trials.length} сохранённых разговоров${view.scope.costUsd === null ? '' : ` · $${view.scope.costUsd.toFixed(2)}`}`, leftWidth - 4, 'muted'));
  const items: number[] = [], picks: ResultPick[] = [];
  let anchor: number | undefined;
  const all = entries(view);
  const next: Line[] = [];
  const nextOffsets: number[] = [];
  for (const entry of all.filter(entry => entry.group === 'next')) {
    const mine = picks.length === selected;
    nextOffsets.push(next.length); picks.push(entry.pick);
    const title = wrap(`${mine ? '›' : ' '}  ${entry.title}`, rightWidth - 4, mine ? 'accent' : 'text').map(line => line.map(part => ({ ...part, bold: mine })));
    next.push(...(mine ? selection(title, rightWidth - 4) : title));
    if (mine) next.push(...wrap(entry.note ?? 'Enter  Открыть', rightWidth - 7, 'muted').map(line => [span('   '), ...line]));
    next.push([]);
  }
  if (!next.length) next.push(...wrap(active ? 'Дождитесь завершения разговоров. Оценки появятся автоматически.' : 'Действий пока нет.', rightWidth - 4, 'muted'));
  const nextStart = body.length + (columns ? 0 : summary.length + 5) + 2;
  for (const [index, offset] of nextOffsets.entries()) {
    items.push(nextStart + offset);
    if (index === selected) anchor = nextStart + offset;
  }
  if (columns) {
    const height = Math.max(summary.length, next.length);
    while (summary.length < height) summary.push([]);
    while (next.length < height) next.push([]);
  }
  const left = box('Что известно', summary, leftWidth);
  const right = box('Следующий шаг', next, rightWidth, 'accent');
  body.push(...(columns ? beside(left, right, leftWidth) : [...left, [], ...right]), []);
  if (view.failures.length) body.push(row(`Замечания к ответам агента · ${view.failures.length}`, 'text', true),
    ...wrap('↑↓ Выберите ситуацию · Enter Откройте разговор и оценку', width, 'muted'), []);
  for (const entry of all.filter(entry => entry.group === 'failure')) {
    const mine = picks.length === selected;
    items.push(body.length); picks.push(entry.pick);
    if (mine) anchor = body.length;
    const title = wrap(`${mine ? '›' : ' '}  ${entry.title}`, width, mine ? 'accent' : 'text').map(line => line.map(part => ({ ...part, bold: mine })));
    body.push(...(mine ? selection(title, width) : title));
    if (mine && entry.note) body.push(...quote(entry.note, width - 3).map(line => [span('   '), ...line]));
    body.push([]);
  }
  if (!view.failures.length && view.headline.decided) body.push(row('✓ В оценённых ситуациях замечаний нет', 'success'), []);
  body.push(...box('Надёжность оценки', evaluationEvidenceLines(view).flatMap(text => wrap(text, width - 4)), width), []);
  if (actions.length) body.push(...box('Прогон', actions.flatMap((label, i) => wrap(`${i + 1}  ${label}`, width - 4, 'accent')), width));
  return { head: [], body, items, picks, ...(anchor === undefined ? {} : { anchor }), foot: [
    { key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: 'd', text: 'вся статистика' }, { key: 'Esc', text: 'назад' }, { key: '?', text: 'клавиши' },
  ] };
}
