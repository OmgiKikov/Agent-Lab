import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Experiment, Scenario, Trial } from '../dist/contracts.js';
import { describeCheck } from '../dist/contracts.js';
import { awaitingVerdict, verdictSummary, isAgentFailure, humanFindings, humanFindingText, repeatResultText, plannedTrials, type RunComparison, type VerdictNote } from '../dist/comparison.js';
import { qualitySummary, qualityLines, dialogues as dlg } from '../dist/quality.js';
import type { EvidenceBundle } from '../dist/artifacts.js';

/** All material, model and persisted text crosses this boundary before terminal rendering. */
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export const activePhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);
const phases: Record<string, string> = {
  preparing: 'ПОДГОТОВКА', review: 'ПРОВЕРЬТЕ КАРТОЧКИ', evaluating: 'ИДУТ ДИАЛОГИ',
  results_review: 'ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ', complete: 'ЗАВЕРШЕНО', cancelled: 'ОСТАНОВЛЕНО',
  error: 'ОШИБКА', interrupted: 'ПРЕРВАНО', baseline: 'БАЗОВАЯ ВЕРСИЯ', improving: 'УЛУЧШЕНИЕ', control: 'КОНТРОЛЬ',
};
export const verdicts: Record<string, string> = {
  pass: 'ПРОЙДЕНО', fail: 'НЕ ПРОЙДЕНО', unknown: 'НЕЯСНО', invalid: 'НЕВАЛИДНЫЙ ТЕСТ', cancelled: 'ОСТАНОВЛЕНО', ungraded: 'ПО РУБРИКАМ',
};

/**
 * Review order: dialogues still waiting for a decisive verdict come first, then the rest.
 * Reviewing one moves it out of the queue, so the same position lands on the next case
 * and a person can go through failures without navigating.
 */
export function reviewOrder(record: Experiment): Trial[] {
  const pending = awaitingVerdict(record);
  const flagged = new Set(humanFindings(record).map(f => f.trialId));
  const rank = (trial: Trial) => pending.has(trial.id) ? 0 : flagged.has(trial.id) ? 1 : isAgentFailure(record, trial) || trial.outcome === 'invalid' ? 2 : 3;
  return record.trials.map((trial, index) => ({ trial, index })).sort((a, b) => rank(a.trial) - rank(b.trial) || a.index - b.index).map(v => v.trial);
}

export type Section = 'agent' | 'cards' | 'results';
export type BoardAction =
  | { type: 'close' }
  | { type: 'back' }
  | { type: 'new' }
  | { type: 'demo' }
  | { type: 'open'; id: string }
  | { type: 'discuss' | 'run' | 'annotate' | 'finalize' | 'export' | 'openReport' | 'cancel' | 'repeat'; record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean; trialId?: string; reviewMs?: number }
  | { type: 'verdict'; verdict: 'pass' | 'fail'; record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean; trialId?: string; reviewMs?: number };
export interface BoardOptions {
  records?: Experiment[];
  record?: Experiment;
  section?: Section;
  selected?: number;
  load?: () => Promise<Pick<EvidenceBundle, 'record' | 'comparison' | 'before' | 'warnings'>>;
  comparison?: RunComparison;
  before?: Experiment;
  notice?: { message: string; kind: 'info' | 'error' };
  warnings?: string[];
  reportPath?: string;
  query?: string;
  pendingOnly?: boolean;
  reviewTimes?: Map<string, number>;
}
type BoardTheme = Pick<Theme, 'fg' | 'bold'>;
type Line = { text: string; color?: ThemeColor; bold?: boolean };
const line = (text: unknown, color?: ThemeColor, bold = false): Line => ({ text: safeText(text), color, bold });
const json = (value: unknown) => JSON.stringify(value, null, 2);
const outcomeColor = (value: string): ThemeColor => value === 'pass' ? 'success' : value === 'fail' || value === 'invalid' ? 'error' : 'warning';

function scenarioLines(scenario: Scenario, record: Experiment, expanded: boolean): Line[] {
  const profile = record.profiles.find(p => p.id === scenario.profileId);
  const origin = scenario.provenance === 'synthetic' ? 'Синтетическая карточка' : scenario.provenance === 'production' ? 'Из реального диалога' : 'Golden-карточка';
  if (!expanded) return [
    line(scenario.title, 'accent', true),
    line(`Первая реплика: «${scenario.user.opening}»`),
    ...(scenario.user.script !== undefined ? scenario.user.script.map((message, i) => line(`Продолжение ${i + 1}: «${message}»`)) : []),
    line(''), line(`Цель: ${scenario.user.goal}`),
    line(`Успех: ${scenario.successCriteria || scenario.checks.map(c => c.description).join('; ') || 'По рубрикам ниже.'}`),
    ...scenario.checks.map(c => line(`Проверяется: ${describeCheck(c)}`)),
    line(''), line(`${origin} · ${tierLabels[scenario.tier]} · ${scenario.checks.length} точных проверок · ${scenario.metrics?.length ?? 0} рубрик`, 'muted'),
    ...(profile ? [line(`Профиль ${profile.id}${profile.draftOverride ? ' · правка черновика' : ''}`, 'muted')] : []),
    line('Enter — пользователь, факты, поведение и все критерии', 'muted'),
  ];
  const rows = [
    line(scenario.title, 'accent', true),
    line(`${scenario.id} · ${tierLabels[scenario.tier] ?? scenario.tier} · ${scenario.provenance === 'synthetic' ? 'Синтетическая карточка' : scenario.provenance === 'production' ? 'Из реального диалога' : 'Golden-карточка'}${record.workflow !== 'evaluate' ? ` · ${scenario.split === 'control' ? 'Контроль: скрыт от билдера' : 'Разработка'}` : ''}`, 'muted'),
    line(''), line('ПОЛЬЗОВАТЕЛЬ', 'accent'),
    line(scenario.user.persona || 'Без персоны · по цели, фактам и поведению'),
    ...(profile ? [line(`Профиль ${profile.id} · ${profile.source === 'owner' ? 'задан владельцем' : 'legacy-данные'}${profile.draftOverride ? ' · правка черновика' : ''}`, 'muted')] : []),
    ...(scenario.user.characteristics ?? []).map(v => line(`• ${v}`)),
    line(`Цель: ${scenario.user.goal}`), line(`Поведение: ${scenario.user.behavior}`),
    ...(scenario.user.knows ?? []).map(v => line(`Известно: ${v}`)),
    ...(scenario.user.cannotKnow ?? []).map(v => line(`Не знает: ${v}`)),
    ...(scenario.user.answers ?? []).map(a => line(`Если спросят ${a.ifAsked}: «${a.reply}»`)),
    ...(scenario.initialState.external ? [line('Внешний мир', 'accent'), line(json(scenario.initialState.external))] : []),
    line(`Знает: ${scenario.user.facts}`), line(`Первая реплика: «${scenario.user.opening}»`),
    line(`Лимит: ${scenario.user.maxFollowUps ?? Math.max(0, record.settings.maxTurns - 1)} ответов после первой реплики`, 'muted'),
    line(''), line('УСПЕХ', 'accent'), line(scenario.successCriteria || 'Описан проверками и метриками ниже.'),
    ...scenario.checks.map(c => line(`□ ${c.stage ? `[${c.stage}] ` : ''}${c.description} [${c.id}] · ${describeCheck(c)}`)),
    ...(scenario.user.script !== undefined ? [line('РЕПЛИКИ ПО СЦЕНАРИЮ', 'accent'), line(`1. ${scenario.user.opening}`),
      ...scenario.user.script.map((message, i) => line(`${i + 2}. ${message}`))] : []),
    ...(scenario.metrics ?? []).flatMap(m => [
      line(`${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.stage ? `[${m.stage}] ` : ''}${m.name} [${m.id}]`, 'text', true),
      line(m.description), line(`Прошёл: ${m.passCriteria}`), line(`Не прошёл: ${m.failCriteria}`),
    ]),
    line(''), line('ДОПУЩЕНИЯ', 'accent'),
    ...(scenario.assumptions?.length ? scenario.assumptions.map(v => line(`• ${v}`)) : [line('Не указаны', 'muted')]),
  ];
  if (expanded) rows.push(
    ...(profile ? [line(''), line('ИСХОДНЫЙ ПРОФИЛЬ', 'accent'), line(profile.persona ?? 'Без персоны'),
      ...profile.characteristics.map(v => line(`• ${v}`)), ...(profile.observedStyle ? [line(profile.observedStyle, 'muted')] : []),
      ...profile.evidenceDialogueIds.flatMap(id => [line(`Диалог ${id}`, 'muted'),
        ...record.dialogues.find(d => d.id === id)?.messages.filter(m => m.role === 'user').map(m => line(`«${m.content}»`)) ?? []]),
    ] : []),
    line(''), line('ОСНОВАНИЯ В МАТЕРИАЛАХ', 'accent'),
    ...record.requirements.filter(r => scenario.requirementIds.includes(r.id)).flatMap(r => [
      line(`${r.id} · ${r.text}`, 'text', true),
      line(`${record.sources.find(s => s.id === r.sourceId)?.name ?? r.sourceId}: «${r.quote}»`, 'muted'),
    ]),
    line(''), line('НАЧАЛЬНОЕ СОСТОЯНИЕ', 'accent'), line(json(scenario.initialState)),
    line(''), line('ТОЧНЫЕ ПРОВЕРКИ', 'accent'), line(json(scenario.checks)),
  );
  return rows;
}

export function trialLines(trial: Trial, record: Experiment, expanded: boolean): Line[] {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const findings = humanFindings(record).filter(f => f.trialId === trial.id);
  const rows = [
    line(scenario?.title ?? trial.scenarioId, 'accent', true),
    line(`${verdicts[trial.outcome]} · ${trial.userMode} · повтор ${trial.repeat + 1}`, outcomeColor(trial.outcome)),
    ...findings.map(f => line(expanded ? humanFindingText(f) : humanFindingText(f).slice(0, 240), 'warning')),
    ...(record.workflow !== 'evaluate' ? [line(`Версия агента: ${trial.revisionId}`, 'muted')] : []),
    line(trial.reason),
    ...(trial.observation ? [line(`Наблюдение: состояние ${trial.observation.state} · события ${trial.observation.tools} · сброс ${trial.observation.resetConfirmed === true ? 'заявлен' : 'не подтверждён'}`, 'muted')] : []),
    ...(trial.externalUsage ? [line(`Внешний агент: ${trial.externalUsage.calls} вызовов · стоимость ${trial.externalUsage.costUsd === null ? 'неизвестна' : `$${trial.externalUsage.costUsd.toFixed(4)}`}`, 'muted')] : []),
    line(`Модель лаборатории: ${trial.usage.calls} вызовов · ${(trial.elapsedMs / 1000).toFixed(1)} с · стоимость ${trial.usage.costUsd === null ? 'неизвестна' : `$${trial.usage.costUsd.toFixed(4)}`}`, 'muted'),
    ...(record.target.kind !== 'sandbox' ? [line('Вызовы и расходы внешнего агента в эту оценку не входят.', 'muted')] : []),
    line(''), line('ДЕТЕРМИНИРОВАННЫЕ ПРОВЕРКИ', 'accent'),
    ...(trial.checks.length ? trial.checks.flatMap(c => [
      line(`${c.passed ? '✓' : '×'} ${c.description} [${c.id}]`, c.passed ? 'success' : 'error'), line(c.evidence, 'muted'),
    ]) : [line('Проверок состояния нет. Итог не означает успех по всем метрикам.', 'muted')]),
    ...(trial.userMode === 'reactive' ? [line(''), line('ПРОВЕРКИ СИМУЛЯТОРА · эвристики', 'accent'),
      ...(trial.simulatorChecks?.length ? trial.simulatorChecks.flatMap(c => [line(`${c.passed ? '✓' : '?'} ${c.description} [${c.id}]`, c.passed ? 'success' : 'warning'), line(c.evidence, 'muted')])
        : [line('Не применялись: симулятор не отправил реплик после первой.', 'muted')])] : []),
    line(''), line(record.mode === 'demo' ? 'СЦЕНАРНАЯ ОЦЕНКА ДЕМО — ПРОВЕРЬТЕ ПО ТРАССЕ' : 'ОЦЕНКА МОДЕЛЬЮ — ПРОВЕРЬТЕ ПО ТРАССЕ', 'accent'),
    ...(scenario?.metrics ?? []).flatMap(m => {
      const a = trial.assessments?.find(a => a.metricId === m.id);
      return [line(`${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.name}: ${a ? verdicts[a.result] : 'НЕТ ОЦЕНКИ'}`, a ? outcomeColor(a.result) : 'warning'),
        line(a?.rationale ?? 'Оценка отсутствует; это не прохождение.'),
        line(`Основания: ${a?.evidence.length ? a.evidence.map(seq => `#${seq}`).join(', ') : 'не указаны'}`, 'muted'),
        ...(expanded ? [line(`Критерий успеха: ${m.passCriteria}`), line(`Критерий провала: ${m.failCriteria}`)] : [])];
    }),
    ...(trial.assessmentError ? [line(`Ошибка оценщика: ${trial.assessmentError}`, 'error')] : []),
    line(''), line('ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ', 'accent'),
    ...(record.humanReviews?.filter(r => r.trialId === trial.id).flatMap(r => [
      line(`${verdicts[r.verdict]} · ${r.metricId ? `метрика ${r.metricId}` : r.checkId ? `проверка ${r.checkId}` : 'весь диалог'}`, outcomeColor(r.verdict)), line(r.note),
    ]) ?? []),
  ];
  if (!record.humanReviews?.some(r => r.trialId === trial.id)) rows.push(line(
    verdictSummary(record).review.status === 'complete' ? 'Разбор набора завершён; у этого диалога отдельного вердикта нет: p — пройдено, n — не пройдено, v — подробно.'
      : 'Вердикта человека нет. p — пройдено, n — не пройдено, v — подробно с пояснением.', 'muted'));
  const transcript: Line[] = [line('ДИАЛОГ', 'accent', true)];
  const roles = { user: 'ПОЛЬЗОВАТЕЛЬ', assistant: 'АГЕНТ', simulator: 'СИМУЛЯТОР', tool_call: 'ВЫЗОВ', tool_result: 'РЕЗУЛЬТАТ', error: 'ОШИБКА' };
  for (const event of trial.events) {
    if (!expanded && !['user', 'assistant', 'error'].includes(event.type)) continue;
    transcript.push(line(`#${event.seq}  ${roles[event.type]}${event.tool ? ` · ${event.tool}` : ''}`, event.type === 'user' ? 'accent' : event.type === 'error' ? 'error' : 'text', true));
    if (event.text !== undefined) transcript.push(line(event.text));
    if (expanded && event.args !== undefined) transcript.push(line(json(event.args), 'muted'));
    if (expanded && event.result !== undefined) transcript.push(line(json(event.result), 'muted'));
    if (expanded && event.state !== undefined) transcript.push(line(json(event.state), 'muted'));
    transcript.push(line(''));
  }
  const tools = [...new Set(trial.events.filter(e => e.type === 'tool_call').map(e => e.tool))];
  if (!expanded && tools.length) transcript.push(line(`Инструменты: ${tools.join(' · ')}. Enter — раскрыть трассу.`, 'muted'));
  const problem = trial.checks.find(c => !c.passed)?.description
    ?? trial.assessments?.find(a => a.result === 'fail')?.rationale ?? trial.assessmentError;
  rows.splice(2 + findings.length, 0, ...transcript, ...(problem ? [line(`Требует внимания: ${problem}`, 'warning'), line('')] : []));
  if (expanded) rows.push(line(`Диалог: ${trial.id}`, 'muted'));
  if (expanded) rows.push(line('СОСТОЯНИЕ ДО', 'accent'), line(json(trial.initialState)), line('СОСТОЯНИЕ ПОСЛЕ', 'accent'), line(json(trial.finalState)));
  return rows;
}

const tierLabels: Record<string, string> = { smoke: 'дымовые', regression: 'регрессия', frontier: 'фронтир' };
/** Verdict wording comes from the record itself, so the board, the report and the CLI never disagree. */
const noteText = (note: VerdictNote): string => note.text;

/** The simple layer: how good the agent is on these cards, why it failed, what the judge could not settle, what to do next. */
function verdictLines(record: Experiment, expanded = false, comparison?: RunComparison): Line[] {
  const v = verdictSummary(record);
  if (!expanded) {
    const q = qualitySummary(record);
    const text = qualityLines(q);
    const finding = v.review.findings[0];
    const broken = record.trials.find(t => t.outcome === 'invalid');
    const measuredAny = q.scope.dialogues > 0;
    return [line('ИТОГ', 'accent', true),
      ...(measuredAny ? [line(q.headline, 'text', true), line(v.headline, 'muted')] : [line(v.headline, 'text', true)]),
      ...(measuredAny && q.metrics.length ? text.metrics.map(m => line(m)) : []),
      line(''),
      ...(finding ? [line(humanFindingText(finding), 'warning')] : []),
      ...(broken ? [line('НЕ ИЗМЕРЕНО', 'error'), line(`${record.scenarios.find(s => s.id === broken.scenarioId)?.title ?? broken.scenarioId}: ${broken.reason}`, 'warning')] : []),
      ...(q.causes.length ? [line('ЧТО ТРЕБУЕТ ВНИМАНИЯ', 'accent'),
        ...q.causes.slice(0, 3).flatMap((c, i) => [
          line(`${i + 1}. ${c.name} — ${dlg(c.dialogues)}${c.stage ? ` · ${c.stage}` : ''}`, 'warning'),
          ...(c.example ? [line(`   ${c.example.card}: «${c.example.quote}»${c.example.seq !== undefined ? ` · реплики #${c.example.seq}` : ''}`, 'muted')] : []),
          ...c.promptQuotes.slice(0, 1).map(quote => line(`   Правило промпта: «${quote}»`, 'muted')),
        ]), line('3 — открыть диалог и основание оценки', 'muted')]
        : measuredAny ? [line('Провалов не зарегистрировано. Это не гарантия качества в реальном трафике.', 'success')] : [line('Сохраните полезные тесты и повторите их после следующей правки.')]),
      line(''),
      ...(measuredAny ? [line(text.judge), line(text.queue, q.humanQueue.total ? 'warning' : 'muted')] : []),
      line(`Дальше: ${v.nextSteps[0]?.text ?? 'Повторите тест после изменения агента.'}`),
      line('a — обсудить результат · r — повторить набор · Enter — все детали', 'accent'),
      ...(comparison ? [line(`После исправления: ${comparison.headline}`, 'accent')] : []),
      ...(measuredAny ? [line(text.scope, 'muted'), line(text.limits, 'muted')] : []),
      line(`Выполнено ${v.execution.completed}/${v.execution.planned} · ожидают разбора ${v.review.pending} · сбоев ${v.invalid} · тестов отклонено ${v.review.invalid}`, 'muted'),
    ];
  }
  const p = v.provenance;
  const examples = record.trials.filter(t => isAgentFailure(record, t)).slice(0, 3);
  return [
    line('ИТОГ', 'accent', true),
    line(v.headline, 'text', true),
    ...(v.review.findings.length ? [line(''), line('ЗАМЕЧАНИЯ ЧЕЛОВЕКА', 'warning', true),
      ...v.review.findings.slice(0, 3).flatMap(f => [line(record.scenarios.find(s => s.id === record.trials.find(t => t.id === f.trialId)?.scenarioId)?.title ?? f.trialId, 'text', true),
        line(humanFindingText(f).slice(0, 300), 'warning')]),
      line('3 — открыть диалоги и полные пояснения · a — обсудить исправление', 'muted')] : []),
    ...(v.repeats.some(r => r.passed && r.failed) ? [line(''), line('РАЗБРОС ПОПЫТОК', 'warning', true),
      ...v.repeats.filter(r => r.passed && r.failed).slice(0, 3).map(r => line(repeatResultText(r), 'warning')),
      line('Это наблюдения, а не вероятность будущего успеха.', 'muted')] : []),
    ...(examples.length ? [line(''), line('ЧТО ТРЕБУЕТ ВНИМАНИЯ', 'accent'), ...examples.flatMap(t => {
      const scenario = record.scenarios.find(s => s.id === t.scenarioId);
      const check = t.checks.find(c => !c.passed);
      const assessment = t.assessments?.find(a => a.result === 'fail' && scenario?.metrics?.some(m => m.id === a.metricId && m.subject === 'agent'));
      return [line(scenario?.title ?? t.scenarioId, 'text', true),
        line(check?.evidence || check?.description || assessment?.rationale || t.reason),
        line(`Диалог ${t.id}${!check && assessment?.evidence.length ? ` · реплики #${assessment.evidence.join(', #')}` : ''}`, 'muted')];
    }), line('3 — открыть диалоги · a — обсудить причины и следующие шаги с Pi'), line('')] : []),
    line(`Карточки: синтетических ${p.synthetic.cards}, golden ${p.curated.cards}, из продакшна ${p.production.cards}.`, 'muted'),
    line(v.weakSpots.length ? `Автоматические замечания: ${v.weakSpots.map(w => `${w.stage ? `[${w.stage}] ` : ''}${w.description} (${w.failures} провал(ов))`).join('; ')}.` : 'Автоматические проверки не отметили провалов.'),
    ...(v.stages.length ? [line('По этапам работы агента:', 'accent'),
      ...v.stages.map(st => line(`  ${st.stage}: ${st.passed} из ${st.evaluated}`, st.passed === st.evaluated ? 'success' : 'warning'))] : []),
    line(`Выполнено: ${v.execution.completed}/${v.execution.planned} · не измерено ${v.execution.invalid} · остановлено ${v.execution.cancelled} · пропущено ${v.execution.missing}`, 'muted'),
    line(`Кодовые проверки: ${v.graded ? `${v.passed}/${v.graded} пройдено` : 'нет'} · рубрики: ${v.rubric.assessed ? `${v.rubric.passed}/${v.rubric.assessed} без замечаний` : 'нет оценок'}`),
    line(`Вердикт на весь диалог: ${v.review.reviewed}/${v.review.total} · пройдено ${v.review.passed}, не пройдено ${v.review.failed}`),
    line(`Провалов без решения: ${v.review.pending} · расхождений с ручной оценкой: ${v.review.disagreements}`, 'muted'),
    line(`Разбор: ${v.review.status === 'complete' ? 'завершён' : 'не завершён'}`, 'muted'),
    ...(v.tiers.some(t => t.graded) ? [line(`Кодовые проверки по ступеням: ${v.tiers.filter(t => t.graded).map(t => `${tierLabels[t.tier]} ${t.passed}/${t.graded}`).join(' · ')}.`, 'muted')] : []),
    ...(record.failureModes?.length ? [line('Типы провалов:', 'accent'),
      ...record.failureModes.flatMap(mode => [
        line(`• ${mode.name}${mode.stage ? ` [${mode.stage}]` : ''} — ${mode.trialIds.length} диалог(ов)`, 'warning'),
        line(`  ${mode.description}`, 'muted'),
        ...(mode.promptQuotes ?? []).map(q => line(`  Цитата промпта · гипотеза: «${q}»`, 'muted')),
      ])] : []),
    line('Что дальше:', 'accent'), ...v.nextSteps.map(step => line(`• ${noteText(step)}`)),
  ];
}
function verdictHeadline(record: Experiment): string {
  const q = qualitySummary(record);
  return `Итог: ${q.headline} · 1 подробнее`;
}

/** A single native Pi component: immutable snapshots in, explicit human intentions out. */
export class LabBoard implements Component {
  private record?: Experiment;
  private section: Section;
  private selected: number;
  private scroll = 0;
  private maxScroll = 0;
  private expanded = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private loading = false;
  private loadError = '';
  private query: string;
  private pendingOnly: boolean;
  private searching = false;
  private help = false;
  private viewedTrial?: string;
  private viewedAt = performance.now();

  constructor(private options: BoardOptions, private theme: BoardTheme, private done: (action: BoardAction) => void,
    private redraw: () => void, private rows: () => number = () => 32) {
    this.record = options.record;
    this.section = options.section ?? (this.record?.trials.length || this.record?.questions.length || this.record?.phase === 'error' ? 'agent' : 'cards');
    this.selected = options.selected ?? 0;
    this.query = options.query ?? '';
    this.pendingOnly = options.pendingOnly ?? false;
    if (options.load && this.record && activePhases.has(this.record.phase)) {
      this.timer = setInterval(() => { void this.refresh(); }, 750);
    }
  }
  private async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const refreshed = await this.options.load!();
      if (this.disposed) return;
      const { record } = refreshed;
      if (record.updatedAt !== this.record?.updatedAt || record.phase !== this.record?.phase) {
        this.options.reportPath = undefined;
        this.options.notice = undefined;
      }
      this.record = record;
      Object.assign(this.options, { comparison: refreshed.comparison, before: refreshed.before, warnings: refreshed.warnings });
      this.loadError = '';
      if (!activePhases.has(record.phase)) { clearInterval(this.timer); this.timer = undefined; }
      this.redraw();
    } catch (error) {
      if (!this.disposed) { this.loadError = safeText(error instanceof Error ? error.message : error); this.redraw(); }
    }
    finally { this.loading = false; }
  }
  dispose() { this.disposed = true; clearInterval(this.timer); }
  invalidate() {}
  private recordReading(next?: string) {
    const now = performance.now();
    const times = this.options.reviewTimes ??= new Map();
    if (this.viewedTrial) times.set(this.viewedTrial, Math.min(3600000, (times.get(this.viewedTrial) ?? 0) + now - this.viewedAt));
    this.viewedTrial = next; this.viewedAt = now;
  }
  private finish(action: BoardAction) {
    this.recordReading();
    if ((action.type === 'verdict' || action.type === 'annotate') && action.trialId) action.reviewMs = Math.round(this.options.reviewTimes?.get(`${action.record.id}|${action.trialId}`) ?? 0);
    this.dispose(); this.done(action);
  }
  private entries(): { text: string; index: number; id: string }[] {
    const record = this.record;
    let entries: { text: string; index: number; id: string }[];
    if (!record) entries = (this.options.records ?? []).map((r, index) => ({ text: `${phases[r.phase] ?? r.phase} · ${r.task}`, index, id: r.id }));
    else if (this.section === 'results') {
      const pending = awaitingVerdict(record);
      const flagged = new Set(humanFindings(record).map(f => f.trialId));
      entries = reviewOrder(record).map((t, index) => ({ id: t.id, index,
        text: `${pending.has(t.id) ? '● ' : ''}${flagged.has(t.id) ? 'ЗАМЕЧАНИЕ ЧЕЛОВЕКА' : isAgentFailure(record, t) ? 'НЕ ПРОЙДЕНО' : verdicts[t.outcome]} · ${record.scenarios.find(s => s.id === t.scenarioId)?.title ?? t.scenarioId} · ${t.userMode ?? 'reactive'} #${t.repeat + 1}`,
      })).filter(e => !this.pendingOnly || pending.has(e.id));
    } else if (this.section === 'cards') entries = record.scenarios.map((s, index) => ({ text: `${s.tier === 'smoke' ? '◆ ' : ''}${s.title}`, index, id: s.id }));
    else entries = [];
    return entries.filter(e => safeText(e.text).toLocaleLowerCase().includes(this.query.toLocaleLowerCase()));
  }
  handleInput(data: string) {
    if (this.disposed) return;
    const key = (value: Parameters<typeof matchesKey>[1]) => matchesKey(data, value);
    if (this.searching) {
      if (key('escape')) { this.searching = false; this.query = ''; }
      else if (key('enter')) this.searching = false;
      else if (key('backspace')) this.query = Array.from(this.query).slice(0, -1).join('');
      else if (!/[\x00-\x1f\x7f-\x9f]/.test(data)) this.query = (this.query + safeText(data)).slice(0, 100);
      this.selected = 0; this.scroll = 0; this.redraw(); return;
    }
    if (key('q') || key('ctrl+c')) return this.finish({ type: 'close' });
    if (key('escape')) {
      if (this.help) { this.help = false; this.redraw(); return; }
      if (this.query || this.pendingOnly) { this.query = ''; this.pendingOnly = false; this.selected = 0; this.redraw(); return; }
      return this.finish({ type: this.record ? 'back' : 'close' });
    }
    if (data === '?') { this.help = !this.help; this.scroll = 0; this.redraw(); return; }
    if (this.help && !['pageDown', 'right', 'pageUp', 'left', 'home', 'end'].some(k => key(k as Parameters<typeof matchesKey>[1]))) return;
    if (data === '/' && (!this.record || ['cards', 'results'].includes(this.section))) { this.searching = true; this.redraw(); return; }
    if (!this.record && key('n')) return this.finish({ type: 'new' });
    if (!this.record && key('d')) return this.finish({ type: 'demo' });
    if (this.record) {
      const section = key('1') ? 'agent' : key('2') ? 'cards' : key('3') ? 'results' : undefined;
      if (section) { this.section = section; this.selected = 0; this.scroll = 0; this.query = ''; this.help = false; }
      if (key('u') && this.section === 'results') { this.pendingOnly = !this.pendingOnly; this.selected = 0; this.scroll = 0; }
      const editable = this.record.workflow === 'evaluate' && this.record.phase === 'review';
      const reviewable = this.record.workflow === 'evaluate' && this.section === 'results'
        && ['results_review', 'complete'].includes(this.record.phase) && this.entries().length > 0;
      const entry = this.entries()[this.selected];
      const state = { record: this.record, section: this.section, selected: this.selected, query: this.query, pendingOnly: this.pendingOnly,
        ...(this.section === 'results' && entry ? { trialId: entry.id } : {}) };
      if (key('a') && !activePhases.has(this.record.phase)) return this.finish({ type: 'discuss', ...state,
        selected: this.section === 'cards' && entry ? entry.index : this.selected });
      if (reviewable && (key('p') || key('n'))) return this.finish({ type: 'verdict', verdict: key('p') ? 'pass' : 'fail', ...state });
      const finished = this.record.workflow === 'evaluate' && !!this.record.reviewedAt && !activePhases.has(this.record.phase);
      const type = key('r') && editable && !this.record.questions.length ? 'run'
        : key('r') && finished ? 'repeat'
        : key('v') && reviewable ? 'annotate'
        : key('f') && this.record.phase === 'results_review' ? 'finalize'
        : key('x') ? 'export'
        : key('o') && this.options.reportPath ? 'openReport'
        : key('c') && activePhases.has(this.record.phase) ? 'cancel' : undefined;
      if (type) return this.finish({ type, ...state });
    }
    const entries = this.entries();
    if (key('down') || key('j')) { this.selected = Math.min(entries.length - 1, this.selected + 1); this.scroll = 0; }
    if (key('up') || key('k')) { this.selected = Math.max(0, this.selected - 1); this.scroll = 0; }
    if (key('pageDown') || key('right')) this.scroll = Math.min(this.maxScroll, this.scroll + Math.max(1, this.rows() - 12));
    if (key('pageUp') || key('left')) this.scroll = Math.max(0, this.scroll - Math.max(1, this.rows() - 12));
    if (key('home')) this.scroll = 0;
    if (key('end')) this.scroll = this.maxScroll;
    if (key('enter')) {
      if (!this.record && entries[this.selected]) return this.finish({ type: 'open', id: entries[this.selected]!.id });
      this.expanded = !this.expanded;
    }
    this.redraw();
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(4, this.rows());
    const entries = this.entries();
    const reading = this.section === 'results' && !this.help && !this.searching ? entries[this.selected]?.id : undefined;
    this.recordReading(reading ? `${this.record!.id}|${reading}` : undefined);
    const sidebar = !this.help && width >= 110 && entries.length > 0 ? 32 : 0;
    const inner = Math.max(1, width - 4 - (sidebar ? sidebar + 3 : 0));
    const paint = (row: Line) => {
      let value = row.text;
      if (row.bold) value = this.theme.bold(value);
      return row.color ? this.theme.fg(row.color, value) : value;
    };
    const frame = (content: string) => width < 6 ? truncateToWidth(content, width, '…')
      : `${this.theme.fg('borderMuted', '│')} ${truncateToWidth(content, Math.max(1, width - 4), '…', true)} ${this.theme.fg('borderMuted', '│')}`;
    const header = [line('AGENT LAB  /  Проверка агента', 'accent', true)];
    const record = this.record;
    if (record) {
      const unresolved = record.phase === 'complete' && awaitingVerdict(record).size > 0;
      header.push(line(`${unresolved ? 'НЕРАЗОБРАННЫЕ ПРОВАЛЫ' : phases[record.phase] ?? record.phase} · ${record.mode === 'demo' ? 'ДЕМО · без модели' : 'ЖИВОЙ ПРОГОН'}`, activePhases.has(record.phase) ? 'accent' : record.phase === 'complete' && !unresolved ? 'success' : 'warning'));
      header.push(line([['agent', '1 Обзор'], ['cards', `2 Карточки ${record.scenarios.length}`], ['results', `3 Диалоги ${record.trials.length}`]]
        .map(([id, label]) => this.section === id ? `[${label}]` : label).join('   '), 'muted'));
      if (this.section === 'results' && record.trials.length) {
        const review = verdictSummary(record).review;
        const pending = review.pending;
        const failures = record.trials.filter(t => isAgentFailure(record, t)).length;
        header.push(line(pending
          ? `Разбор: осталось ${pending} провал(ов) из ${failures}. Отмечены точкой.`
          : review.findings.length ? `Замечания человека: ${review.flagged} диалогов · расхождения оценок: ${review.disagreements}.`
          : failures ? `Разбор: все ${failures} провал(ов) разобраны.` : 'Автоматические проверки не отметили провалов.', pending || review.findings.length ? 'warning' : 'muted'));
      }
      header.push(line(`${record.trials.length && !activePhases.has(record.phase) ? verdictHeadline(record) : record.phase === 'review' ? 'Проверьте цель, первую реплику и критерии. r — запуск.' : record.message}${this.loadError ? ` · ${this.loadError}` : ''}`));
    } else header.push(line('n — свой агент · d — учебный пример без провайдера', 'muted'));
    if (this.options.notice) header.push(line(this.options.notice.message, this.options.notice.kind === 'error' ? 'error' : 'success'));
    if (this.options.warnings?.length) header.push(line(`Внимание: ${this.options.warnings[0]}${this.options.warnings.length > 1 ? ` (+${this.options.warnings.length - 1})` : ''}`, 'warning'));
    const items = entries.map(e => e.text);
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    const visibleItems = record ? 1 : Math.max(1, Math.min(4, Math.floor(height / 5)));
    const from = Math.max(0, Math.min(this.selected - Math.floor(visibleItems / 2), items.length - visibleItems));
    if (items.length && !sidebar) for (let i = from; i < Math.min(items.length, from + visibleItems); i++) {
      header.push(line(`${i === this.selected ? '▸' : ' '} ${i + 1}/${items.length}  ${items[i]}`, i === this.selected ? 'accent' : 'muted', i === this.selected));
    }
    if (this.searching || this.query || this.pendingOnly) header.push(line(`${this.pendingOnly ? '● Только неразобранные · ' : ''}Поиск: ${this.query}${this.searching ? '▎  Enter — применить' : ' · Esc — сбросить'}`, 'accent'));
    if (record && activePhases.has(record.phase)) {
      const planned = plannedTrials(record);
      const filled = planned ? Math.min(20, Math.round(record.trials.length / planned * 20)) : 0;
      header.push(line(`${'━'.repeat(filled)}${'─'.repeat(20 - filled)}  ${record.trials.length} / ${planned} диалогов · c Остановить`, 'accent'));
    }
    let detail: Line[] = [];
    if (!record) {
      const chosen = this.options.records?.[entries[this.selected]?.index ?? -1];
      detail = chosen ? [line(chosen.task, 'text', true), line(`Создан: ${chosen.createdAt}`, 'muted'), line(chosen.phase === 'review' ? 'Черновик готов. Откройте его, чтобы проверить и уточнить сценарии.' : chosen.trials.length ? verdictSummary(chosen).headline : chosen.message)]
        : [line('НАСКОЛЬКО ХОРОШ ВАШ АГЕНТ', 'accent', true), line(''),
          line('1  Подключение', 'text', true), line('   Agent Lab читает папку агента: промпт, точку входа, базу знаний.', 'muted'),
          line('2  Карточки', 'text', true), line('   Ситуации пользователей — из правил промпта, статей или ваших логов.', 'muted'),
          line('3  Диалоги', 'text', true), line('   Каждая карточка проигрывается с агентом: одна реплика, по сценарию, живой пользователь.', 'muted'),
          line('4  Качество', 'text', true), line('   Справился / не справился по карточкам, причины с цитатами, что разметить человеку.', 'muted'), line(''),
          line('n  Проверить своего агента · укажите папку и что проверить', 'accent'),
          line('d  Учебный пример за минуту · без модели и ключей', 'accent'), line(''),
          line('Оценки модели и ваши вердикты хранятся отдельно; результат повторяем и сравним с прошлым прогоном.', 'muted')];
    } else if (this.section === 'cards') {
      const scenario = record.scenarios[entries[this.selected]?.index ?? -1];
      detail = scenario ? scenarioLines(scenario, record, this.expanded) : [line(this.query ? 'Ничего не найдено. Esc — сбросить поиск.' : 'Карточки появятся после подготовки.', 'muted')];
    } else if (this.section === 'results') {
      const trial = reviewOrder(record).find(t => t.id === entries[this.selected]?.id);
      detail = trial ? trialLines(trial, record, this.expanded) : this.query || this.pendingOnly ? [line('Ничего не найдено. Esc — сбросить фильтр.', 'muted')]
        : activePhases.has(record.phase) ? [line('ДИАЛОГ ВЫПОЛНЯЕТСЯ', 'accent', true), line(record.message), line('Первый результат появится после ответа и проверки критериев.', 'muted'), line('c — остановить с сохранением уже полученных реплик', 'muted')]
        : [line('Диалогов ещё нет.', 'text', true), line(record.phase === 'review' ? 'Проверьте карточки и нажмите r для запуска.' : record.error ?? 'Прогон остановлен до завершения первой попытки.')];
    } else {
      const agent = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec;
      detail = [...(record.trials.length ? [...verdictLines(record, this.expanded), line('')] : []), line(record.task, 'text', true),
        ...(record.error ? [line('НЕ УДАЛОСЬ ЗАВЕРШИТЬ', 'warning'), line(record.error), line('a Обсудить исправление с Pi · исходные данные сохранены'), line('')] : []),
        ...(record.questions.length ? [line('ТРЕБУЮТСЯ УТОЧНЕНИЯ', 'warning'), ...record.questions.map(q => line(`• ${q}`)), line('Нажмите a и ответьте своими словами. Pi подготовит уточнённый черновик.')] : []),
        line(''), line('ПОДКЛЮЧЕНИЕ', 'accent'), line(record.target.kind === 'sandbox' ? agent?.name ?? 'Песочница' : record.target.kind === 'module' ? record.target.path : record.target.kind === 'http' ? record.target.url : [record.target.command, ...record.target.args].join(' ')),
        ...(record.assessmentOf ? [line(`Переоценка ${record.assessmentOf} · агент не запускался`, 'warning')] : []),
        line(`Оценщик: ${record.evaluatorVersion?.slice(0, 12) ?? 'версия не записана'}`, 'muted'),
        line(`Версия: ${record.targetVersion ?? record.targetRelease ?? record.targetFingerprint?.slice(0, 12) ?? 'не указана'}`, 'muted'),
        ...(this.expanded ? [line(agent?.instructions ?? '')] : []),
        ...(record.target.kind === 'sandbox' ? [line(`Инструменты: ${agent?.tools.join(', ') || 'нет'}`, 'muted')] : []),
        line(''), line('ПЛАН ПРОГОНА', 'accent'), line(`${record.scenarios.length} карточек · ${plannedTrials(record)} диалогов · ${record.settings.userModes.join(' / ')}`),
        line(`До ${record.settings.maxTurns} ходов · ${record.settings.maxCalls} вызовов модели · ${Math.round(record.settings.maxDurationMs / 60000)} мин`, 'muted'),
        ...(this.expanded ? [line(json(record.settings))] : []),
        line(''), line('ПРОВЕРКА ЧЕЛОВЕКОМ', 'accent'),
        line(`Карточки: ${record.reviewedAt ? record.reviewMode === 'human' ? 'подтверждены человеком' : 'автоматическая проверка' : 'ожидают проверки'}`),
        line(`Диалоги с заметкой: ${new Set(record.humanReviews?.map(r => r.trialId)).size} / ${record.trials.length}`),
        line(`Разбор: ${verdictSummary(record).review.status === 'complete' ? 'завершён' : 'ещё не завершён'}`),
        line(`${record.usage.calls} ${record.mode === 'demo' ? 'сценарных' : 'модельных'} вызовов · стоимость ${record.usage.costUsd === null ? 'неизвестна' : `$${record.usage.costUsd.toFixed(4)}`}`, 'muted'),
        line(''), line('ОСНОВАНИЯ', 'accent'),
        ...record.requirements.flatMap(r => [line(`${r.id} · ${r.text}`, 'text', true), line(`${record.sources.find(s => s.id === r.sourceId)?.name ?? r.sourceId}: «${r.quote}»`, 'muted')]),
        ...(this.expanded ? record.sources.flatMap(s => [line(''), line(s.name, 'accent'), line(s.content)]) : []),
        line(''), ...record.limitations.map(v => line(`• ${v}`, 'muted')),
        ...(record.error ? [line(record.error, 'error')] : []),
      ];
      if (record.trials.length && !this.expanded) detail = verdictLines(record, false, this.options.comparison);
    }
    if (this.options.warnings?.length) detail.push(line(''), line('ДИАГНОСТИКА', 'warning'), ...this.options.warnings.map(w => line(w, 'warning')));
    if (this.help) detail = [line('КЛАВИШИ', 'accent', true), line('1 Обзор — качество агента · 2 Карточки · 3 Диалоги'), line('a — правка или разбор словами с Pi · n в списке — новая проверка'), line('↑ ↓ или j k — выбрать карточку или диалог'), line('← → или PgUp PgDn — прокрутить подробности'), line('/ — поиск по списку · u — только неразобранные диалоги'), line('Enter — раскрыть источники, инструменты и состояния'), line('p / n — вердикт на выбранный диалог · v — оценить критерий'), line('r — запустить черновик или создать повтор готового прогона'), line('x — экспортировать · c — остановить запуск · Esc — назад · q — закрыть'), line(''), line('Все оценки и подтверждения относятся к показанной версии.', 'muted')];
    const content = detail.flatMap(row => wrapTextWithAnsi(row.text, inner).map(text => paint({ ...row, text })));
    const footer = record ? [
      record.workflow !== 'evaluate' ? 'Сравнительный эксперимент · только просмотр и экспорт'
        : record.phase === 'review' ? `a Правка словами · ${record.questions.length ? 'Ответьте на вопросы' : 'r Запустить'}`
        : activePhases.has(record.phase) ? 'c Остановить · обновляется автоматически'
        : record.phase === 'results_review' ? this.section === 'results' ? 'a Обсудить · p Пройдено · n Провал · v Оценка · f Завершить' : 'a Обсудить · 3 Диалоги · f Завершить · r Повторить · x Экспорт'
        : record.reviewedAt ? 'a Обсудить результат · r Повторить · x Экспорт' : 'a Обсудить исправление · результат сохранён',
      inner < 80 ? '↑↓ Выбор · ←→ Текст · Enter Детали · / Поиск · ? Помощь'
        : `↑↓ Выбор · PgUp/PgDn Текст · Enter ${this.expanded ? 'Свернуть' : 'Подробнее'} · / Поиск · u Неразобранные · ? Помощь`,
    ] : ['n Свой агент · d Демо · ↑↓ Выбор · Enter Открыть · ? Помощь'];
    if (this.options.reportPath && record) footer[0] = `o Открыть отчёт · ${footer[0]}`;
    const available = Math.max(1, height - header.length - footer.length - 4);
    this.maxScroll = Math.max(0, content.length - available);
    this.scroll = Math.min(this.scroll, this.maxScroll);
    if (this.maxScroll > 0 && record) footer[1] = `${this.scroll + 1}–${Math.min(content.length, this.scroll + available)}/${content.length} · ${inner < 80 ? '←→ Текст · ↑↓ Выбор · Enter Детали · ?' : footer[1]}`;
    const border = (left: string, right: string) => this.theme.fg('borderMuted', width < 2 ? '─' : left + '─'.repeat(width - 2) + right);
    const body = content.slice(this.scroll, this.scroll + available);
    const listFrom = Math.max(0, Math.min(this.selected - Math.floor(available / 2), entries.length - available));
    const bodyRows = sidebar ? Array.from({ length: available }, (_, i) => {
      const index = listFrom + i;
      const entry = entries[index];
      const label = entry ? `${index === this.selected ? '▸ ' : '  '}${safeText(entry.text)}` : '';
      const left = this.theme.fg(index === this.selected ? 'accent' : 'muted', truncateToWidth(label, sidebar, '…', true));
      return frame(`${left} ${this.theme.fg('borderMuted', '│')} ${body[i] ?? ''}`);
    }) : body.map(frame);
    const rows = [border('╭', '╮'), ...header.map(r => frame(paint(r))), frame(this.theme.fg('borderMuted', '─'.repeat(Math.max(1, width - 4)))),
      ...bodyRows, ...footer.map((text, i) => frame(this.theme.fg(i ? 'dim' : 'accent', text))), border('╰', '╯')];
    // Even very small terminals remain valid; Pi requires each rendered line to fit.
    return rows.slice(0, height).map(row => visibleWidth(row) > width ? truncateToWidth(row, width, '…') : row);
  }
}

export function showBoard(ctx: ExtensionContext, options: BoardOptions): Promise<BoardAction> {
  return ctx.ui.custom<BoardAction>((tui, theme, _keys, done) =>
    new LabBoard(options, theme, done, () => tui.requestRender(), () => tui.terminal.rows),
  { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
}
