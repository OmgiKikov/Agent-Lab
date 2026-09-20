import type { Experiment } from '../dist/contracts.js';
import { plannedTrials } from '../dist/comparison.js';

/** Presentation only: all counts and states come from the current record. */
export interface FlowRow { text: string; color?: 'accent' | 'text' | 'muted' | 'warning' | 'success'; bold?: boolean }
const r = (text: string, color?: FlowRow['color'], bold = false): FlowRow => ({ text, color, bold });

export function progressLine(record: Experiment): string {
  if (record.phase === 'preparing') return `Подготовка: ${record.scenarios.length ? `готово ситуаций ${record.scenarios.length}` : 'собираем ожидания'} · вызовов ${record.usage.calls}`;
  const cost = record.mode === 'demo' ? 'без оплаты' : record.usage.costUsd === null ? 'стоимость неизвестна' : `$${record.usage.costUsd.toFixed(3)} (оценка)`;
  return `Диалогов ${record.trials.length} из ${plannedTrials(record)} · ${cost}`;
}

export function preparationRows(record: Experiment): FlowRow[] {
  const started = record.phase === 'preparing';
  const confirmed = !!record.targetFingerprint || record.target.kind === 'sandbox';
  return [r(started ? 'Подготавливаем проверку' : 'План проверки', 'accent', true), r(record.task, 'text', true), r(''),
    r(`${confirmed ? '✓' : '○'} Агент: ${record.target.kind === 'sandbox' ? 'учебная песочница' : record.target.kind === 'command' ? 'локальное приложение' : record.target.kind === 'http' ? 'HTTP-подключение' : 'модуль'}`, confirmed ? 'success' : 'muted'),
    r(`${record.sources.length ? '✓' : '○'} Материалы: ${record.sources.length} источников`, record.sources.length ? 'success' : 'muted'),
    r(`${record.dialogues.length ? '✓' : '○'} Диалоги: ${record.dialogues.length ? record.dialogues.length : 'без логов; ситуации по описанию'}`, 'muted'),
    r(`${record.requirements.length ? '✓' : '○'} Требования: ${record.requirements.length ? record.requirements.length : 'выделяем из материалов'}`, 'muted'),
    r(`${record.scenarios.length ? '✓' : '○'} Ситуации: ${record.scenarios.length ? record.scenarios.length : 'ищем проверяемые ожидания'}`, 'muted'),
    ...(record.reviewedAt ? [r(`Карточки: ${record.reviewMode === 'human' ? 'подтверждены человеком' : record.reviewMode === 'expectations' ? 'ожидания подтверждены владельцем' : 'автоматическая проверка'}`, 'muted')] : []),
    r(''), ...(record.questions.length ? [r('Нужно уточнить', 'warning', true), ...record.questions.map(q => r(q, 'warning')), r('a — ответить своими словами в Pi', 'accent')]
      : [r(started ? 'После подготовки покажем ожидания. Запуск агента подтверждается отдельно.' : 'Откройте ожидания и проверьте, что агент должен сделать.', 'text')]),
    ...(record.error ? [r('Подготовка не завершена', 'warning', true), r(record.error, 'warning'), r('Данные сохранены. a — обсудить, что исправить, и подготовить новый черновик.', 'accent')] : []),
    r('Технические сведения о подключении — d.', 'muted')];
}

export function activeRunRows(record: Experiment): FlowRow[] {
  if (record.phase === 'preparing') return preparationRows(record);
  const total = plannedTrials(record), finished = record.trials.length;
  const failed = record.trials.filter(t => t.outcome === 'invalid' || t.outcome === 'cancelled').length;
  return [r('Проверяем агента', 'accent', true), r(progressLine(record), 'text', true), r(''),
    r(`Осталось попыток: ${Math.max(0, total - finished)}. Время до завершения пока не оценивается.`, 'muted'),
    r(`Последнее состояние: ${record.message}`, 'text'),
    ...(failed ? [r(`Есть непригодные попытки: ${failed}. Причины доступны в разборе.`, 'warning')] : []),
    r(''), r(finished ? 'Enter — посмотреть уже записанные диалоги.' : 'Первые диалоги появятся после ответа агента и оценки.', 'accent'),
    r('Можно уйти в историю или закрыть доску: работа продолжится, пока открыт Pi.', 'muted'),
    r('c — явно остановить прогон с сохранением полученных результатов.', 'muted')];
}
