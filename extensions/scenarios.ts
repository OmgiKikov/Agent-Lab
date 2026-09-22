import type { Experiment } from '../src/contracts.js';
import type { ScenarioLibrary, ScenarioVariant } from '../src/scenario-contracts.js';
import { libraryHash } from '../src/scenario-library.js';
import { semanticWorkStatus } from '../src/scenario-work.js';
import type { FlowRow } from './flow.ts';

const r = (text: string, color?: FlowRow['color'], bold = false): FlowRow => ({ text, color, bold });
const status = (variant: ScenarioVariant) => variant.quality === 'ready' ? 'готов' : variant.quality === 'blocked' ? 'заблокирован' : 'требует решения';
const libraryOf = (record: Experiment): ScenarioLibrary | undefined => record.librarySnapshot;
const semanticCache = new Map<string, ReturnType<typeof semanticWorkStatus>>();

function cachedSemanticWork(library: ScenarioLibrary) {
  const key = `${library.id}/${library.revision}/${library.semanticAssessment?.contentHash ?? 'none'}/${library.semanticAssessment?.workReceipts?.length ?? 0}`;
  const cached = semanticCache.get(key);
  if (cached) return cached;
  const status = semanticWorkStatus(library);
  semanticCache.set(key, status);
  if (semanticCache.size > 64) semanticCache.delete(semanticCache.keys().next().value!);
  return status;
}

const actionLabel = (action: ScenarioVariant['behaviorPolicy']['actions'][number]) => ({
  answer: 'ответить', missing: 'сообщить, что данных нет', clarify: 'уточнить', correct: 'исправить ответ',
  change_intent: 'сменить намерение', finish: 'завершить разговор', observe: 'сообщить, что видит',
})[action.kind];

export interface ScenarioEntry { id: string; index: number; text: string; businessScenarioId: string }

export function scenarioEntries(record: Experiment): ScenarioEntry[] {
  const library = libraryOf(record);
  if (!library) return record.scenarios.map((scenario, index) => ({ id: scenario.id, index, text: scenario.title, businessScenarioId: scenario.familyId }));
  return library.businessScenarios.flatMap(group => library.variants.filter(variant => variant.businessScenarioId === group.id).map(variant => ({
    id: variant.id, index: library.variants.indexOf(variant), businessScenarioId: group.id,
    text: `${group.title} › ${variant.title} · ${status(variant)}`,
  })));
}

function factOrigin(library: ScenarioLibrary, fact: ScenarioVariant['userState']['facts'][number]): string[] {
  if (fact.origin.kind === 'owner') return [`Правка владельца ${fact.origin.editId}: «${fact.origin.text}»`];
  if (fact.origin.kind === 'synthetic') return [`Синтетическое допущение от ${fact.origin.parentVariantId}: ${fact.origin.operation} · ${fact.origin.reason}`];
  const origin = fact.origin;
  const dialogue = library.imports.find(batch => batch.id === origin.batchId)?.dialogues.find(item => item.id === origin.dialogueId);
  const event = dialogue?.events.find(item => item.index === origin.eventIndex);
  return [`Источник ${origin.dialogueId}, событие ${origin.eventIndex}: «${origin.quote}»`,
    ...(event?.content && event.content !== origin.quote ? [`Полная реплика: «${event.content}»`] : [])];
}

export function pendingLibrarySelection(record: Experiment, selected: string[]): boolean {
  const accepted = record.librarySnapshot?.acceptance?.variantIds;
  return !!accepted && (accepted.length !== selected.length || selected.some(id => !accepted.includes(id)));
}

export function scenarioRows(record: Experiment, variantId?: string, selectedVariantIds: string[] = []): FlowRow[] {
  const library = libraryOf(record);
  if (!library) return [r('Сценарии из старой записи', 'accent', true), r('Эта запись использует прежние карточки; их можно читать и повторять без перезаписи.', 'muted')];
  const variant = library.variants.find(item => item.id === variantId) ?? library.variants[0];
  if (!variant) return [r('СЦЕНАРИИ', 'accent', true), r('В библиотеке пока нет вариантов.', 'muted')];
  const group = library.businessScenarios.find(item => item.id === variant.businessScenarioId);
  const selected = selectedVariantIds.includes(variant.id);
  const rows: FlowRow[] = [
    r('СЦЕНАРИИ', 'accent', true),
    r(`Ревизия ${library.revision} · вариантов ${library.variants.length} · выбрано для прогона: ${selectedVariantIds.length}`, 'muted'),
    r(''), r(`${selected ? '☑' : '☐'} ${variant.title}`, variant.quality === 'ready' ? 'success' : 'warning', true),
    r(`Готовность: ${status(variant)} · происхождение: ${({ production: 'из диалогов', curated: 'по требованиям владельца', synthetic: 'синтетический' })[variant.provenance]}${variant.parentVariantId ? ` · родитель ${variant.parentVariantId}` : ''}`),
  ];
  if (group) {
    rows.push(r(`Группа: ${group.title}`, 'accent', true), r(group.goal));
    rows.push(r(`Исходных диалогов: ${group.sourceDialogues.length} · условий: ${group.conditions.length}`, 'muted'));
    if (group.grouping.status === 'uncertain') rows.push(r(`Нужно решение владельца: ${group.grouping.reason}`, 'warning', true), r('m объединить группу · s разделить выбранные варианты', 'accent'));
  }
  rows.push(r(''), r('ПОЛЬЗОВАТЕЛЬ', 'accent', true), r(`Цель: ${variant.userState.goal}`), r(`Первая реплика: «${variant.userState.opening}»`));
  if (variant.userState.facts.length) for (const fact of variant.userState.facts) {
    rows.push(r(`${fact.availability === 'initial' ? 'Знает' : fact.availability === 'learned_in_source' ? 'Узнал в старом разговоре; в стартовые знания не попадёт' : 'Неясный факт'}: ${fact.statement}`, fact.availability === 'initial' ? 'text' : 'warning'));
    rows.push(...factOrigin(library, fact).map(text => r(text, 'muted')));
  }
  if (variant.userState.missing.length) rows.push(r(`Нет данных: ${variant.userState.missing.join('; ')}`, 'warning'));
  if (variant.userState.cannotKnow.length) rows.push(r(`Не может знать: ${variant.userState.cannotKnow.join('; ')}`, 'muted'));
  rows.push(r(''), r('ПОВЕДЕНИЕ И СРЕДА', 'accent', true),
    r(`${variant.behaviorPolicy.states.length} состояния · до ${variant.behaviorPolicy.maxFollowUps} продолжений · предел повторов ${variant.behaviorPolicy.repetitionLimit}`),
    r(variant.environmentFixture.mode === 'managed'
      ? `Управляемая fixture: ${variant.environmentFixture.contract?.operations.join(', ') || 'операции не подтверждены'} · сброс ${variant.environmentFixture.contract?.reset ? 'подтверждён' : 'не подтверждён'}`
      : 'Обычный prompt/RAG без управляемого backend', 'muted'));
  for (const transition of variant.behaviorPolicy.transitions) {
    const action = variant.behaviorPolicy.actions.find(item => item.id === transition.actionId);
    if (!action) continue;
    const payload = action.payload ? `: ${action.payload}` : '';
    const request = action.ifAsked ? ` · если спросили: ${action.ifAsked}` : '';
    rows.push(r(`${transition.when} → ${actionLabel(action)}${payload}${request}`, action.kind === 'change_intent' || action.kind === 'missing' ? 'accent' : 'muted'));
  }
  rows.push(r(''), r('ОЖИДАЕМЫЙ РЕЗУЛЬТАТ', 'accent', true), r(variant.evaluationSpec.successCriteria, 'text', true));
  for (const checkpoint of variant.evaluationSpec.checkpoints) rows.push(r(`${checkpoint.role === 'required' ? 'Обязательно' : 'Диагностика'} · ${checkpoint.observation}: ${checkpoint.rule}`), r(`Требование ${checkpoint.requirementId}: «${checkpoint.quote}»`, 'muted'));
  if (variant.issues.length) rows.push(r(''), r('НУЖНО РЕШИТЬ', 'warning', true), ...variant.issues.map(issue => r(`• ${issue.message}`, issue.severity === 'blocked' ? 'warning' : 'muted')));
  rows.push(r(''), r('Space выбрать/исключить · e изменить реплику, цель, ожидание, правило или факт · v добавить целевой вариант · Delete удалить', 'accent'), r('g смысловая проверка · y принять выбранные · принятие не запускает агента', 'muted'));
  return rows;
}

export function logsRows(record: Experiment): FlowRow[] {
  const library = libraryOf(record);
  if (!library) return [r('ЛОГИ', 'accent', true), r(record.dialogues.length ? `Диалогов в старой записи: ${record.dialogues.length}` : 'Запись создана без библиотеки логов.', 'muted')];
  const progress = record.preparationProgress;
  const accepted = library.imports.reduce((sum, batch) => sum + batch.dialogues.length, 0);
  const rejected = library.imports.reduce((sum, batch) => sum + batch.rejected.length, 0);
  const rows = [r('ЛОГИ', 'accent', true), r(`Импортировано диалогов: ${accepted} · отклонено строк: ${rejected}`),
    r(progress ? `Обработано: ${progress.processed.length} · ожидают: ${progress.pending.length} · исключено: ${progress.excluded.length}` : 'Прогресс подготовки не записан.', progress?.pending.length ? 'warning' : 'muted')];
  if (!library.imports.length) rows.push(r('Без логов: варианты основаны на требованиях владельца; импорт и личные факты не выдумываются.', 'muted'));
  if (progress?.pending.length && !library.acceptance) rows.push(r(progress.activeDialogueId ? 'Вызов оборвался в процессе: его стоимость неизвестна; автоматическое повторение недоступно.' : 'u — продолжить разбор оставшихся источников в текущем бюджете', 'accent'));
  if (progress?.status === 'partial') rows.push(r('Разбор частичный: смысловая перепроверка не обработает ожидающие источники.', 'warning'));
  for (const item of progress?.excluded ?? []) rows.push(r(`• ${item.dialogueId}: ${item.reason}`, 'muted'));
  rows.push(...budgetRows(record, library));
  return rows;
}

function budgetRows(record: Experiment, library: ScenarioLibrary): FlowRow[] {
  const remaining = Math.max(0, record.settings.maxCalls - record.usage.calls);
  let estimate = 0, total = 0, completed = 0, skipped = 0;
  try { const plan = cachedSemanticWork(library); estimate = plan.pendingJobs; total = plan.totalJobs; completed = plan.completedJobs; skipped = plan.skipped.length; } catch { skipped = 1; }
  return [r(''), r(`Бюджет модели: использовано ${record.usage.calls} из ${record.settings.maxCalls} · осталось ${remaining}`, remaining ? 'muted' : 'warning'),
    r(`Смысловая проверка: осталось ${estimate} из ${total} вызовов · сохранено ${completed}${skipped ? ` · непомещающихся частей ${skipped}` : ''}`, estimate > remaining ? 'warning' : 'muted'),
    ...(estimate > remaining ? [r(`Текущего остатка хватит на ${remaining} из ${estimate} вызовов; частичный результат сохранится. b — увеличить maxCalls; использованный бюджет не сбрасывается.`, 'accent')] : [])];
}

export function runRows(record: Experiment, selectedVariantIds: string[] = []): FlowRow[] {
  const library = libraryOf(record);
  if (!library) return [r('ПРОГОН', 'accent', true), r(`${record.scenarios.length} карточек · бюджет ${record.usage.calls}/${record.settings.maxCalls}`)];
  const accepted = library.acceptance;
  const pending = pendingLibrarySelection(record, selectedVariantIds);
  const selected = accepted?.variantIds ?? selectedVariantIds;
  const planned = selected.length * record.settings.repeats * record.settings.userModes.length;
  return [r('ПРОГОН', 'accent', true), r(`Ревизия ${library.revision} · выбрано: ${selected.length} · запланировано диалогов: ${planned}`, 'text', true),
    r(`Агент: ${record.revisions.find(item => item.id === record.selectedRevisionId)?.spec.name ?? 'версия не выбрана'}`),
    ...budgetRows(record, library), r(''),
    accepted ? r(`Принят снимок ${accepted.snapshotHash.slice(0, 12)} · свежий план ${record.acceptedDraftHash ? 'готов' : 'нужно подтвердить после изменений'}`, record.acceptedDraftHash ? 'success' : 'warning')
      : r('Сначала принять выбранные готовые варианты в разделе «Сценарии». Это действие не запускает агента.', 'warning'),
    ...(pending ? [r('Выбор изменён: нужно принять заново в разделе «Сценарии». До этого запуск недоступен.', 'warning')] : []),
    r(accepted && !pending ? 'r — открыть отдельное подтверждение запуска' : '2 — вернуться к сценариям', 'accent')];
}

export function scenarioLibrarySummary(record: Experiment, selectedVariantIds: string[] = []) {
  const library = libraryOf(record);
  if (!library) return undefined;
  const quality = { ready: library.variants.filter(item => item.quality === 'ready').length,
    needsReview: library.variants.filter(item => item.quality === 'needs_review').length,
    blocked: library.variants.filter(item => item.quality === 'blocked').length };
  return { libraryId: library.id, revision: library.revision, libraryHash: libraryHash(library), quality, selectedVariantIds,
    acceptedVariantIds: library.acceptance?.variantIds ?? [], nextAction: library.acceptance && !pendingLibrarySelection(record, selectedVariantIds) ? 'run' : quality.ready ? 'accept' : 'review' };
}

export function scenarioErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /хеш устарел|библиотека изменилась/i.test(message)
    ? 'Библиотека изменилась. Откройте сценарии заново и повторите правку по свежей ревизии.'
    : message;
}
