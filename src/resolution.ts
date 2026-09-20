import { checkpointReceiptValid } from './checkpoints.js';
import { fingerprint, type Experiment } from './contracts.js';
import type { Issue } from './issues.js';
import { resolutionRequestSchema, resolutionPolicySchema, type ResolutionRequest, type ResolutionPolicy, type ResolutionResult } from './resolution-contracts.js';
import { resolutionTargetIdentity } from './normalize.js';
import { libraryHash } from './scenario-library.js';
import { cardOutcome, compareRuns, headlineCardOutcome } from './comparison.js';
import { measurementUsable, trialAssessmentComplete } from './outcomes.js';
export { resolutionRequestSchema, type ResolutionRequest, type ResolutionPolicy, type ResolutionResult } from './resolution-contracts.js';

function revisionId(record: Experiment): string {
  const ids = [...new Set(record.trials.map(t => t.revisionId))];
  const selected = ids.length === 1 ? ids[0]! : record.selectedRevisionId ?? (record.revisions.length === 1 ? record.revisions[0]!.id : undefined);
  if (!selected || ids.some(id => id !== selected) || !record.revisions.some(r => r.id === selected)) throw new Error('Нужна одна точная версия исходного прогона.');
  return selected;
}
function ordinary(record: Experiment): boolean { return record.workflow === 'evaluate' && !record.assessmentOf && record.runKind !== 'diagnostic' && record.runKind !== 'generator' && !record.trials.some(t => t.diagnosticReceipt); }
export function resolutionEvidenceHash(record: Experiment): string { return fingerprint({ id:record.id, trials:record.trials, humanReviews:record.humanReviews, phase:record.phase }); }
export function resolutionDraftHash(record: Experiment): string {
  return fingerprint({ target:resolutionTargetIdentity(record,revisionId(record)), scenarios:record.scenarios, sources:record.sources, requirements:record.requirements, settings:record.settings, evaluatorVersion:record.evaluatorVersion, library:record.librarySnapshot, imports:record.originalImport,positiveControls:record.positiveControlScenarioIds });
}
function suiteIdentity(record: Experiment, ids: string[]) {
  const scenarios = ids.map(id => { const value=record.scenarios.find(s=>s.id===id); if (!value) throw new Error(`Нет обязательного варианта ${id}.`); return value; });
  return { ids, hash:fingerprint({scenarios,sources:record.sources,requirements:record.requirements,library:record.librarySnapshot ? libraryHash(record.librarySnapshot) : null,imports:record.originalImport}),
    protocolHash:fingerprint({settings:record.settings,evaluatorVersion:record.evaluatorVersion,execution:scenarios.map(s=>s.execution)}),
    revision:record.librarySnapshot ? String(record.librarySnapshot.revision) : fingerprint(scenarios), repeats:record.settings.repeats };
}
export function verifyResolutionPolicy(policy: ResolutionPolicy): void {
  const {ruleHash,...body}=resolutionPolicySchema.parse(policy);
  if(fingerprint(body)!==ruleHash) throw new Error('Правило изменено: хеш политики не совпадает. Нужны новые прогоны обеих версий.');
}
export function prepareResolutionPolicy(raw: ResolutionRequest, issue: Issue, before: Experiment, candidate: Experiment): ResolutionPolicy {
  const request=resolutionRequestSchema.parse(raw);
  if(issue.id!==request.issueId || issue.kind!=='defect' || issue.mergedInto) throw new Error('Нужен действующий дефект.');
  if(before.id!==request.baselineRunId || candidate.id!==request.candidateRunId || before.id===candidate.id) throw new Error('Идентичности прогонов не совпадают.');
  if(!ordinary(before)||!ordinary(candidate)) throw new Error('Диагностика, генератор и переоценка не закрывают дефект.');
  if(candidate.phase!=='review'||candidate.trials.length||candidate.reviewedAt) throw new Error('Политика сохраняется до запуска кандидата, только для нового черновика.');
  if(!['results_review','complete'].includes(before.phase)) throw new Error('Нужна завершённая исходная база.');
  if(request.stability.repeats!==before.settings.repeats || candidate.settings.repeats!==request.stability.repeats) throw new Error('Число повторов должно совпадать с обоими наборами.');
  const all=[...request.reproducerIds,...request.regressionIds];
  if(new Set(all).size!==all.length || all.some(id=>before.positiveControlScenarioIds?.includes(id))) throw new Error('Нужны отдельные непересекающиеся наборы без служебных контролей.');
  if(fingerprint(before.scenarios.map(s=>s.id).sort())!==fingerprint(candidate.scenarios.map(s=>s.id).sort())||fingerprint(before.positiveControlScenarioIds??[])!==fingerprint(candidate.positiveControlScenarioIds??[])) throw new Error('Состав кандидатного набора изменён: нужна новая сопоставимая база.');
  if(before.scenarios.some(s=>!before.positiveControlScenarioIds?.includes(s.id)&&!all.includes(s.id))) throw new Error('Оба набора вместе должны покрывать весь исходный набор: есть пропущенные варианты. Для меньшего охвата выполните новую явную базу.');
  if(!issue.evidence.some(e=>e.runId===before.id&&request.reproducerIds.includes(e.assessment.scenario.id))) throw new Error('Воспроизводящий набор не содержит исходного доказательства дефекта.');
  const sourceProofs=issue.evidence.filter(e=>e.runId===before.id&&request.reproducerIds.includes(e.assessment.scenario.id));
  if(sourceProofs.some(e=>fingerprint(before.trials.find(t=>t.id===e.trialId)??null)!==fingerprint(e.assessment.trial)||fingerprint(before.scenarios.find(s=>s.id===e.assessment.scenario.id)??null)!==fingerprint(e.assessment.scenario))) throw new Error('Исходные доказательства или оценки проблемы были заменены; нужна новая база.');
  const reproducer=suiteIdentity(before,request.reproducerIds), regression=suiteIdentity(before,request.regressionIds);
  if(fingerprint(reproducer)!==fingerprint(suiteIdentity(candidate,request.reproducerIds))||fingerprint(regression)!==fingerprint(suiteIdentity(candidate,request.regressionIds))) throw new Error('Набор или протокол изменён: нужна новая сопоставимая база.');
  const baselineRevisionId=revisionId(before),candidateRevisionId=revisionId(candidate);
  const baselineIdentity=resolutionTargetIdentity(before,baselineRevisionId),candidateIdentity=resolutionTargetIdentity(candidate,candidateRevisionId);
  if(baselineIdentity===candidateIdentity) throw new Error('Кандидат должен иметь отдельную фактическую идентичность агента.');
  for(const record of [before,candidate]) if(record.target.kind!=='sandbox'&&!record.targetFingerprint&&!record.targetVersion) throw new Error('Для внешнего агента нужна идентичность кода или неизменная версия сервиса.');
  const body={...request,formatVersion:'1' as const,id:`resolution_${fingerprint({...request,baselineIdentity,candidateIdentity}).slice(0,40)}`,declaredAt:new Date().toISOString(),baselineIdentity,candidateIdentity,baselineRevisionId,candidateRevisionId,baselineEvidenceHash:resolutionEvidenceHash(before),candidateDraftHash:resolutionDraftHash(candidate),reproducer,regression};
  return resolutionPolicySchema.parse({...body,ruleHash:fingerprint(body)});
}
function projection(record: Experiment, ids: string[]): Experiment { const trials=record.trials.filter(t=>ids.includes(t.scenarioId)); return {...record,scenarios:record.scenarios.filter(s=>ids.includes(s.id)),trials,humanReviews:record.humanReviews.filter(r=>trials.some(t=>t.id===r.trialId))}; }
function assessSuite(policy:ResolutionPolicy, role:'reproducer'|'regression', before:Experiment,after:Experiment) {
  const suite=policy[role], reasons:string[]=[];
  for(const [name,record,identity,revision] of [['Исходный',before,policy.baselineIdentity,policy.baselineRevisionId],['Кандидат',after,policy.candidateIdentity,policy.candidateRevisionId]] as const) {
    if(!ordinary(record)) reasons.push(`${name}: служебный прогон, диагностическая квитанция или переоценка.`);
    if(!['results_review','complete'].includes(record.phase)) reasons.push(`${name}: прогон не завершён.`);
    if(resolutionTargetIdentity(record,revision)!==identity||record.trials.some(t=>suite.ids.includes(t.scenarioId)&&t.revisionId!==revision)) reasons.push(`${name}: версия агента отличается.`);
    if(fingerprint(suiteIdentity(record,suite.ids))!==fingerprint(suite)) reasons.push(`${name}: набор, ревизия или протокол изменён; нужна новая база.`);
  }
  const b=projection(before,suite.ids),a=projection(after,suite.ids), comparison=compareRuns(b,a);
  if(!comparison.comparable) reasons.push(...comparison.notes);
  for(const record of [b,a]) for(const scenario of record.scenarios) {
    const trials=record.trials.filter(t=>t.scenarioId===scenario.id);
    const expected=record.settings.userModes.filter(m=>m!=='scripted'||scenario.user.script!==undefined).length*suite.repeats;
    if(trials.length!==expected||new Set(trials.map(t=>`${t.userMode}:${t.repeat}`)).size!==expected||trials.some(t=>!checkpointReceiptValid(scenario,t)||!measurementUsable(scenario,t,record.humanReviews)||!trialAssessmentComplete(scenario,t,record.humanReviews))) reasons.push(`${scenario.title}: неполные или неопределённые обязательные попытки.`);
  }
  return {reasons, rows:suite.ids.map(scenarioId=>({scenarioId,before:cardOutcome(b,b.scenarios.find(s=>s.id===scenarioId)!),after:cardOutcome(a,a.scenarios.find(s=>s.id===scenarioId)!)}))};
}
/** Pure evidence evaluation. Only the store's declaration/start/result journal can close an issue. */
export function evaluateResolution(policy:ResolutionPolicy,before:Experiment,after:Experiment,regressions:{before:Experiment;after:Experiment}):ResolutionResult {
  verifyResolutionPolicy(policy);
  const common:string[]=[];
  if(before.id!==policy.baselineRunId||after.id!==policy.candidateRunId||regressions.before.id!==before.id||regressions.after.id!==after.id) common.push('Идентичности исходного и кандидатного прогонов отличаются.');
  try { if(resolutionDraftHash(after)!==policy.candidateDraftHash) common.push('Полный снимок кандидата изменён после объявления политики: нужна новая сопоставимая база.'); } catch(error) { common.push((error as Error).message); }
  if(resolutionEvidenceHash(before)!==policy.baselineEvidenceHash) common.push('Исходные оценки изменены после объявления политики.');
  let repro:ReturnType<typeof assessSuite>,reg:ReturnType<typeof assessSuite>;
  try { repro=assessSuite(policy,'reproducer',before,after); reg=assessSuite(policy,'regression',regressions.before,regressions.after); }
  catch(error) { common.push((error as Error).message); repro={reasons:[],rows:[]};reg={reasons:[],rows:[]}; }
  const reproComplete=!common.length&&!repro.reasons.length&&repro.rows.length>0;
  const baselineFailed=repro.rows.some(r=>r.before==='fail');
  const defectNoLongerReproduced=reproComplete&&baselineFailed ? repro.rows.every(r=>r.after==='pass') : null;
  const defectReproduced=defectNoLongerReproduced===null?null:!defectNoLongerReproduced;
  const regressionComplete=!common.length&&!reg.reasons.length&&reg.rows.length>0;
  const candidateAcceptable=defectNoLongerReproduced===false?false:defectNoLongerReproduced===true&&regressionComplete ? reg.rows.every(r=>r.after==='pass'&&r.before!=='unknown') : null;
  return {defectReproduced,defectNoLongerReproduced,candidateAcceptable,reasons:[...common,...repro.reasons.map(r=>`Воспроизведение: ${r}`),...reg.reasons.map(r=>`Регрессии: ${r}`),...(!baselineFailed?['Исходный дефект не воспроизведён в зафиксированной базе.']:[])],beforeRunId:before.id,afterRunId:after.id,reproducer:repro.rows,regression:reg.rows,trialIds:[...before.trials,...after.trials].map(t=>t.id),scope:'Вывод только по зафиксированным вариантам и версии агента; статистическое улучшение продукта не доказано.'};
}
export function applyResolution(issue:Issue,policy:ResolutionPolicy,result:ResolutionResult,at=new Date().toISOString()):Issue {
  const next=structuredClone(issue); next.status=result.defectNoLongerReproduced===true&&result.candidateAcceptable===true?'resolved':'checking';
  next.history.push({at,status:next.status,reason:`Политика ${policy.id}: дефект больше не воспроизводится — ${result.defectNoLongerReproduced}; кандидат можно принять — ${result.candidateAcceptable}. ${result.scope}`,evidenceIds:issue.evidence.map(e=>e.assessmentId)});
  if(next.status==='resolved') next.resolution={policyId:policy.id,candidateIdentity:policy.candidateIdentity,closedAt:at};
  return next;
}
/** Allowlisted dev fields only: never embed Experiment/library/import or unrelated review objects. */
export function createFixBundle(issue:Issue,record:Experiment) {
  if(!ordinary(record)) throw new Error('Пакет исправления доступен только для обычного dev-прогона.');
  const ids=new Set(issue.evidence.filter(e=>e.runId===record.id&&e.assessment.scenario.split==='dev').map(e=>e.trialId));
  const scenarios=record.scenarios.filter(s=>s.split==='dev'&&!record.positiveControlScenarioIds?.includes(s.id)&&record.trials.some(t=>ids.has(t.id)&&t.scenarioId===s.id)&&headlineCardOutcome(record,s).outcome==='fail');
  const devTrials=record.trials.filter(t=>ids.has(t.id)&&scenarios.some(s=>s.id===t.scenarioId)&&measurementUsable(scenarios.find(s=>s.id===t.scenarioId),t,record.humanReviews)&&trialAssessmentComplete(scenarios.find(s=>s.id===t.scenarioId)!,t,record.humanReviews));
  if(!devTrials.length) throw new Error('Нужны полные пригодные dev-доказательства этой проблемы.');
  return {format:'agent-lab-fix-1',issue:{id:issue.id,observation:issue.observation,hypotheses:issue.hypotheses},sourceRunId:record.id,targetIdentity:resolutionTargetIdentity(record,revisionId(record)),reproducer:structuredClone(scenarios),devTrials:structuredClone(devTrials),controlTrials:[],instructions:['Измените только агента; тесты, контрольные ответы и судья недоступны для изменения.','Перед сравнением сохраните ResolutionPolicy с повторными попытками и отдельным регрессионным набором.','Зарегистрируйте отдельный target и targetVersion; Lab повторит тот же снимок.','Для prompt-propose нужны фактические подтверждённые человеком ошибки dev. Применение к исходному агенту решает владелец.']};
}
