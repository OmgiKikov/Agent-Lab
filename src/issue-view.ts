import type { IssueJournal } from './issues.js';
import type { DiagnosticFile } from './diagnostics.js';
import { fingerprint, type Experiment, type Trial } from './contracts.js';
export interface PageInput { offset?: number; limit?: number }
export function page<T>(items: T[], options: PageInput = {}) {
  const offset = Math.max(0, Math.floor(options.offset ?? 0)), limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 10)));
  return { total: items.length, offset, items: items.slice(offset, offset + limit), ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}) };
}
const excerpt = (value: string, max = 2000) => value.length <= max ? value : `${value.slice(0, max)}… [полный текст в сохранённой трассе]`;
export function trialDetail(trial: Trial, options: PageInput = {}) {
  const { events, judgeAudit: _, checkpointReceipt, initialState, finalState, ...rest } = trial;
  return { ...rest, reason: excerpt(rest.reason), checks: rest.checks.map(c => ({ ...c, evidence: excerpt(c.evidence) })), initialState: { hash: fingerprint(initialState), content: excerpt(JSON.stringify(initialState)) }, finalState: { hash: fingerprint(finalState), content: excerpt(JSON.stringify(finalState)) }, ...(checkpointReceipt ? { checkpointReceipt: { ...checkpointReceipt, decisions: undefined } } : {}), events: page(events.map(e => ({ seq: e.seq, type: e.type, tool: e.tool, content: excerpt(e.text ?? JSON.stringify(e.result ?? e.args ?? e.state ?? '')), truncated: (e.text ?? JSON.stringify(e.result ?? e.args ?? e.state ?? '')).length > 2000 })), options) };
}
export function compactIssues(journal: IssueJournal, options: PageInput & { id?: string; assessmentId?: string; eventOffset?: number } = {}) {
  const filtered = journal.issues.filter(i => !options.id || i.id === options.id || i.evidence.some(e => e.runId === options.id));
  const selected = page(filtered, options.id ? { limit: 20 } : options);
  const evidence = options.assessmentId ? filtered.flatMap(i => i.evidence).find(e => e.assessmentId === options.assessmentId) : undefined;
  if (options.assessmentId && !evidence) throw new Error('Точная оценка не найдена.');
  return { formatVersion: '1', total: selected.total, nextOffset: selected.nextOffset,
    issues: selected.items.map(i => ({ id: i.id, kind: i.kind, observation: i.observation, status: i.status, mergedInto: i.mergedInto, identity: { ...i.identity, mechanism: excerpt(i.identity.mechanism, 500) }, occurrences: i.occurrences.length, evidenceCount: i.evidence.length,
      evidence: page(i.evidence.map(({ assessment: _, eventSeq, ...ref }) => ({ ...ref, eventSeq: eventSeq.slice(0, 10), eventCount: eventSeq.length })), options.id ? options : { limit: 2 }), experiments: page(i.experiments), history: page(i.history.slice().reverse().map(h => ({ ...h, reason: excerpt(h.reason, 300), evidenceIds: h.evidenceIds.slice(0, 3) })), { limit: 3 }) })),
    suggestions: page(journal.suggestions.filter(s => !options.id || s.issueId === options.id || s.candidateId === options.id), options),
    ...(evidence ? { detail: { ...evidence, assessment: { ...evidence.assessment, trial: trialDetail(evidence.assessment.trial, { offset: options.eventOffset, limit: options.limit }) } } } : {}) };
}
export function compactDiagnostic(file: DiagnosticFile, run?: Experiment, options: PageInput & { trialId?: string } = {}) {
  const { source, ...plan } = file.plan;
  const trial = options.trialId ? run?.trials.find(t => t.id === options.trialId) : undefined;
  if (options.trialId && !trial) throw new Error('Трасса пары не найдена.');
  return { formatVersion: file.formatVersion, plan: { ...plan, sourceRunId: source.id, versions: { targetVersion: source.targetVersion, targetFingerprint: source.targetFingerprint, targetRelease: source.targetRelease, evaluatorVersion: source.evaluatorVersion, libraryRevision: source.librarySnapshot?.revision }, plannedPairs: plan.repeats * source.settings.userModes.length }, runId: file.runId,
    ...(file.result ? { result: { ...file.result, pairs: page(file.result.pairs, options) } } : {}),
    ...(run ? { run: { id: run.id, phase: run.phase, runKind: run.runKind, usage: run.usage, error: run.error, trialCount: run.trials.length } } : {}),
    ...(trial ? { detail: trialDetail(trial, options) } : {}) };
}

const verdictText = (value: string) => ({ pass: 'пройдено', fail: 'провал', unknown: 'не определено', invalid: 'не измерено', cancelled: 'остановлено', ungraded: 'без оценки', not_applicable: 'не применяется' })[value] ?? value;
export function trialText(trial: Trial): string {
  const role = { user: 'Пользователь', assistant: 'Агент', tool_call: 'Вызов инструмента', tool_result: 'Ответ инструмента', simulator: 'Симулятор', observation: 'Наблюдение', retrieval: 'Найденный контекст', error: 'Ошибка' };
  return [`Диалог ${trial.id}`, `Результат: ${verdictText(trial.outcome)}. ${trial.reason}`,
    ...(trial.diagnosticReceipt ? [`Условия: ${trial.diagnosticReceipt.arm === 'baseline' ? 'исходные' : 'вмешательство'}. Изменений ответа: ${trial.diagnosticReceipt.appliedCount}.`] : []),
    ...trial.checks.map(c => `${c.description}: ${c.passed ? 'пройдено' : 'провал'} — ${c.evidence}`),
    ...(trial.checkpoints ?? []).map(c => `Контрольная точка ${c.checkpointId}: ${verdictText(c.result)} — ${c.rationale}`), '',
    ...trial.events.map(e => `#${e.seq} ${role[e.type]}${e.tool ? ` ${e.tool}` : ''}\n${e.text ?? JSON.stringify(e.result ?? e.args ?? e.state ?? '', null, 2)}`)].join('\n');
}
export function issueEvidenceText(evidence: import('./issues.js').IssueEvidence): string {
  const { scenario, trial } = evidence.assessment;
  const criterion = scenario.execution?.evaluatorView.checkpoints.find(c => c.id === evidence.criterionId)?.rule ?? scenario.checks.find(c => c.id === evidence.criterionId)?.description ?? scenario.metrics?.find(m => m.id === evidence.criterionId)?.passCriteria ?? evidence.criterionId;
  return [`Критерий: ${criterion}`, `Ситуация: ${scenario.title}`, `Исходный прогон: ${evidence.runId}`, `Неизменная оценка: ${evidence.assessmentId}`, `Ссылки на события: ${evidence.eventSeq.map(seq => `#${seq}`).join(', ')}`, '', trialText(trial)].join('\n');
}
export function diagnosticText(file: DiagnosticFile): string {
  const { plan, result } = file;
  const heading = !result ? (file.runId ? `Диагностика не завершена или была прервана; итог ещё не сохранён.\nСохранённые трассы: прогон ${file.runId}. Выберите «Открыть трассу пары» или «Открыть прогон».` : 'Диагностика подготовлена; агент ещё не запускался.') : { supports: 'Гипотеза поддержана на проверенных парах.', refutes: 'Гипотеза не поддержана: дефект сохранился.', inconclusive: 'Недостаточно данных для решения по гипотезе.' }[result.conclusion];
  return [heading, `Гипотеза: ${plan.intervention.hypothesis}`, `Изменён один фактор: ${plan.intervention.kind === 'tool-response' ? `ответ инструмента ${plan.intervention.tool}, вызов ${plan.intervention.call}` : 'проверенный фрагмент контекста'}.`,
    `Исходный прогон: ${plan.source.id}`, `Повторов каждой стороны: ${plan.repeats}. Общий бюджет: ${plan.budget.maxCalls} вызовов, ${Math.round(plan.budget.maxDurationMs / 1000)} секунд.`,
    ...(result?.pairs.map(p => `Попытка ${p.repeat + 1}: исходно ${verdictText(p.baseline)} → с вмешательством ${verdictText(p.intervention)}.\n  Диалоги: ${p.baselineTrialId ?? 'не выполнен'} → ${p.interventionTrialId ?? 'не выполнен'}`) ?? []),
    ...(result?.reasons ?? []), 'Диагностика не входит в общую точность, не доказывает единственную причину и не закрывает проблему.'].join('\n');
}

export function resolutionText(file: import('./resolution-contracts.js').ResolutionFile): string {
  const { policy:p, result:r }=file;
  const decision=(v:boolean|null|undefined)=>v===true?'да':v===false?'нет':'решение не принято';
  return [`Правило проверки ${p.id}`,`Воспроизводящий набор: ${p.reproducer.ids.join(', ')} · ревизия ${p.reproducer.revision} · ${p.reproducer.repeats} повторов.`,
    `Отдельный регрессионный набор: ${p.regression.ids.join(', ')} · ревизия ${p.regression.revision} · ${p.regression.repeats} повторов.`,
    'Правило устойчивости: все обязательные критерии каждой запланированной попытки должны пройти; неопределённость или неполнота не дают закрыть дефект.',
    `Исходный прогон: ${p.baselineRunId}. Кандидат: ${p.candidateRunId}.`,
    `Исходный дефект больше не воспроизводится: ${decision(r?.defectNoLongerReproduced)}.`,
    `Кандидат можно принять: ${decision(r?.candidateAcceptable)}.`,
    ...(r?.reasons??[]),r?.scope??'Политика сохранена до исполнения. Изменение правила потребует новых прогонов обеих версий.'].join('\n');
}

export function resolutionRunText(file: import('./resolution-contracts.js').ResolutionFile, candidate: Experiment): string {
  const attempts=candidate.scenarios.reduce((n,s)=>n+candidate.settings.userModes.filter(m=>m!=='scripted'||s.user.script!==undefined).length*candidate.settings.repeats,0);
  const judge=candidate.settings.roles.judge??candidate.settings.judge??candidate.settings;
  return [`Проверка исправления ${file.policy.id.slice(0,20)}.`, `Обязательные наборы: воспроизведение — ${file.policy.reproducer.ids.length}, регрессии — ${file.policy.regression.ids.length}.`, 'Устойчивость: все обязательные критерии каждой попытки должны пройти. Полное правило доступно в просмотре проверки.',`План кандидата: ${attempts} попыток · ${candidate.settings.repeats} повторов · режимы ${candidate.settings.userModes.join(', ')}.`,
    `До ${candidate.settings.maxCalls} вызовов, ${Math.round(candidate.settings.maxDurationMs/1000)} секунд, ${candidate.settings.maxTurns} ходов.`,
    candidate.mode==='demo'?'Учебный пример: без модели и оплаты.':`Модель: ${candidate.settings.provider}/${candidate.settings.model}. Судья: ${judge.provider}/${judge.model}. Стоимость заранее неизвестна; зависит от фактических вызовов.`,
    ...candidate.scenarios.slice(0,3).map(s=>`${excerpt(s.title,80)}: ${excerpt(s.successCriteria??s.user.goal,140)}`),
    ...(candidate.scenarios.length>3?[`Ещё ${candidate.scenarios.length-3} вариантов в неизменном принятом наборе; полные ожидания доступны в «Сценариях».`]:[]),
    'Подтверждая запуск, вы подтверждаете эти ожидания. Это не человеческая проверка будущих оценок судьи.'].join('\n');
}

export function compactResolution(file: import('./resolution-contracts.js').ResolutionFile, options: PageInput = {}) {
  const {policy,result}=file;
  return {startedAt:file.startedAt,completedAt:file.completedAt,policy:{...policy,reproducerIds:page(policy.reproducerIds,options),regressionIds:page(policy.regressionIds,options),
    reproducer:{...policy.reproducer,ids:page(policy.reproducer.ids,options)},regression:{...policy.regression,ids:page(policy.regression.ids,options)}},
    ...(result?{result:{...result,reasons:page(result.reasons.map(r=>excerpt(r,500)),options),reproducer:page(result.reproducer,options),regression:page(result.regression,options),trialIds:page(result.trialIds,options)}}:{})};
}
export function compactFixBundle(bundle: ReturnType<typeof import('./resolution.js').createFixBundle>, options: PageInput & {trialId?:string} = {}) {
  const trial=options.trialId?bundle.devTrials.find(t=>t.id===options.trialId):undefined;
  if(options.trialId&&!trial) throw new Error('Dev-доказательство не найдено.');
  return {format:bundle.format,issue:{...bundle.issue,observation:excerpt(bundle.issue.observation,500),hypotheses:page(bundle.issue.hypotheses.map(h=>excerpt(h,500)),options)},sourceRunId:bundle.sourceRunId,targetIdentity:bundle.targetIdentity,
    devTrialCount:bundle.devTrials.length,controlTrials:[],devTrials:page(bundle.devTrials.map(t=>({id:t.id,scenarioId:t.scenarioId,outcome:t.outcome,eventCount:t.events.length})),options),
    reproducer:page(bundle.reproducer.map(s=>({id:s.id,title:excerpt(s.title,200),expected:excerpt(s.successCriteria??s.user.goal,1000)})),options),instructions:bundle.instructions,
    exportCommand:'agent-lab resolutions --operation bundle --input request.json --data-dir DATA_DIRECTORY',
    ...(trial?{detail:trialDetail(trial,options)}:{})};
}
