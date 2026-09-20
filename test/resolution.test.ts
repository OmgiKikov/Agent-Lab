import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as resolution from '../src/resolution.js';
import { issueRecord } from './helpers/issues.js';
import { syncIssues } from '../src/issues.js';
import { qualitySummary } from '../src/quality.js';
import { headlineCardOutcome } from '../src/comparison.js';
import { experimentSchema, fingerprint, type Experiment } from '../src/contracts.js';
import { ExperimentStore } from '../src/store.js';

function fixture() {
  const before = issueRecord(); before.settings.repeats = 3;
  const regression = structuredClone(before.scenarios[0]!); regression.id = 'regression'; regression.familyId = 'regression'; regression.split = 'control';
  before.scenarios.push(regression);
  before.trials = before.scenarios.flatMap(s => Array.from({ length: 3 }, (_, repeat) => ({ ...structuredClone(before.trials[0]!), id: `${s.id}_${repeat}`, scenarioId: s.id, familyId: s.familyId, split: s.split, repeat, outcome: s.id === 'regression' ? 'pass' as const : 'fail' as const, checks: [{ ...before.trials[0]!.checks[0]!, passed: s.id === 'regression' }] })));
  delete before.failureModes;
  const issue = syncIssues(before, []).issues[0]!;
  const candidate = structuredClone(before); candidate.id = 'candidate'; candidate.parentRunId = before.id; candidate.phase = 'review'; candidate.trials = []; candidate.reviewedAt = null; candidate.manifestHash = null;
  candidate.revisions[0]!.spec.instructions = 'Repaired';
  const request = { issueId: issue.id, baselineRunId: before.id, candidateRunId: candidate.id, reproducerIds: ['case_a'], regressionIds: ['regression'], stability: { kind: 'all-pass' as const, repeats: 3 } };
  return { before, candidate, issue, request };
}
function executed(candidate: Experiment, before: Experiment) {
  const after = structuredClone(candidate); after.phase = 'results_review'; after.manifestHash = 'new_manifest'; after.reviewedAt = '2026-09-21'; after.updatedAt = '2026-09-21';
  after.trials = before.trials.map(t => ({ ...structuredClone(t), id: `new_${t.id}`, outcome: 'pass' as const, manifestHash: 'new_manifest', checks: t.checks.map(c => ({ ...c, passed: true })) })); return after;
}

test('literal planned-attempt table keeps invalid or missing attempts outside accuracy', () => {
  const rows = [ ['pass','pass','pass','pass'], ['pass','pass','fail','fail'], ['pass','pass','unknown','unknown'], ['pass','fail','unknown','fail'], ['pass','pass','invalid','unknown'], ['pass','fail','invalid','unknown'], ['pass','pass','missing','unknown'] ];
  for (const [a,b,c,expected] of rows) {
    const r = issueRecord(); r.settings.repeats = 3;
    r.scenarios[0]!.metrics = [{ id: 'goal_attainment', name: 'Goal', subject: 'agent', passCriteria: 'Done', failCriteria: 'Not done' }];
    r.trials = [a,b,c].flatMap((value,repeat) => value === 'missing' ? [] : [{ ...structuredClone(r.trials[0]!), id: `t${repeat}`, repeat, outcome: value === 'invalid' ? 'invalid' : 'pass', checks: [{ ...r.trials[0]!.checks[0]!, passed: true }], assessments: [{ metricId: 'goal_attainment', result: value === 'unknown' ? 'unknown' : value === 'fail' ? 'fail' : 'pass', rationale: 'Fixture', evidence: [1] }] }] as Experiment['trials']);
    assert.equal(headlineCardOutcome(r,r.scenarios[0]!).outcome, expected, `${a}/${b}/${c}`);
    assert.equal(qualitySummary(r).cards.passed, expected === 'pass' ? 1 : 0);
  }
});

test('variant slices count 2/2 + 10/20 as 12/22 and keep provenance denominators', () => {
  const r = issueRecord(), template = r.scenarios[0]!, trial = r.trials[0]!;
  r.scenarios = Array.from({length:22},(_,i)=>({...structuredClone(template),id:`s${i}`,familyId:i<2?'small':'large',provenance:i<2?'production' as const:i<12?'curated' as const:'synthetic' as const}));
  r.trials = r.scenarios.map((s,i)=>({...structuredClone(trial),id:`t${i}`,scenarioId:s.id,familyId:s.familyId,outcome:i<12?'pass':'fail',checks:trial.checks.map(c=>({...c,passed:i<12}))}));
  const q = qualitySummary(r);
  assert.equal(q.cards.passed,12); assert.equal(q.cards.total,22);
  assert.deepEqual(q.slices.groups.map(g=>[g.id,g.passed,g.measured,g.planned]),[['small',2,2,2],['large',10,20,20]]);
  assert.deepEqual(q.slices.provenance.map(g=>[g.id,g.passed,g.measured]),[['production',2,2],['curated',10,10],['synthetic',0,10]]);
});

test('resolution freezes both suites and returns separate repaired and acceptance decisions', () => {
  const {before,candidate,issue,request} = fixture();
  const policy = resolution.prepareResolutionPolicy(request,issue,before,candidate);
  const after = executed(candidate,before);
  assert.equal(resolution.evaluateResolution(policy,before,after,{before,after}).candidateAcceptable,true);
  after.trials.find(t=>t.scenarioId==='regression')!.checks[0]!.passed = false; after.trials.find(t=>t.scenarioId==='regression')!.outcome='fail';
  const result = resolution.evaluateResolution(policy,before,after,{before,after});
  assert.equal(result.defectReproduced,false); assert.equal(result.defectNoLongerReproduced,true); assert.equal(result.candidateAcceptable,false);
  assert.equal(resolution.applyResolution(issue,policy,result).status,'checking');
});

test('policy rejects one attempt and post-execution declaration; mismatches and service evidence never close', () => {
  const {before,candidate,issue,request} = fixture();
  assert.throws(()=>resolution.prepareResolutionPolicy({...request,stability:{kind:'all-pass',repeats:1}},issue,before,candidate),/повтор|2/);
  assert.throws(()=>resolution.prepareResolutionPolicy(request,issue,before,executed(candidate,before)),/запуск|результат|черновик/);
  const policy = resolution.prepareResolutionPolicy(request,issue,before,candidate);
  for (const mutate of [ (r:Experiment)=>{r.settings.repeats=1;}, (r:Experiment)=>{r.evaluatorVersion='changed';}, (r:Experiment)=>{r.scenarios[0]!.user.facts='Changed';}, (r:Experiment)=>{r.revisions[0]!.spec.instructions='Another';}, (r:Experiment)=>{r.runKind='diagnostic';}, (r:Experiment)=>{r.runKind='generator';}, (r:Experiment)=>{r.trials.pop();}, (r:Experiment)=>{r.trials[0]!.diagnosticReceipt={requestHash:'x',arm:'intervention',applied:true,appliedCount:1,factorHash:'x'} as any;} ]) {
    const after = executed(candidate,before); mutate(after);
    assert.notEqual(resolution.evaluateResolution(policy,before,after,{before,after}).candidateAcceptable,true);
  }
  assert.throws(()=>resolution.evaluateResolution({...policy,stability:{kind:'all-pass',repeats:2}},before,executed(candidate,before),{before,after:executed(candidate,before)}),/измен|хеш/);
});

test('fix bundle minimizes dev evidence with no nested control, imports or full experiment', async () => {
  const {before,issue}=fixture(); before.scenarios[1]!.user.facts='CONTROL_SECRET'; before.trials.filter(t=>t.scenarioId==='regression').forEach(t=>t.events.push({seq:8,type:'assistant',text:'CONTROL_SECRET'}));
  before.librarySnapshot=(await import('./helpers/scenario-library.js')).libraryFixture();before.librarySnapshot.variants[1]!.userState.facts[0]!.statement='CONTROL_SECRET';
  before.originalImport={id:'CONTROL_SECRET',contentHash:'a'.repeat(64)};
  before.humanReviews.push({id:'developer_fixture_review',createdAt:'2026-09-20',trialId:before.trials.at(-1)!.id,verdict:'pass',note:'Developer synthetic fixture: #8 CONTROL_SECRET',reviewedDialogue:true});
  const parsed=experimentSchema.safeParse(before);assert.equal(parsed.success,true,JSON.stringify(parsed.error?.issues));
  const bundle = resolution.createFixBundle(issue,parsed.data!);
  assert.deepEqual(bundle.controlTrials,[]); assert.doesNotMatch(JSON.stringify(bundle),/CONTROL_SECRET|librarySnapshot|originalImport/);
  assert.ok(bundle.devTrials.length); assert.equal('record' in bundle,false);
});

test('journal persists declaration before execution, rejects replacement, and only later candidate recurrence reopens', async t => {
  const dir=await mkdtemp(join(tmpdir(),'resolution-')); t.after(()=>rm(dir,{recursive:true,force:true})); const store=new ExperimentStore(dir); await store.init(); t.after(()=>store.close());
  const {before,candidate,issue,request}=fixture(); await store.save(before); await store.save(candidate); await store.syncIssues(before);
  const policy=resolution.prepareResolutionPolicy(request,issue,before,candidate); await store.declareResolution(policy);
  assert.equal((await store.readResolution(policy.id)).policy.ruleHash,policy.ruleHash);
  await assert.rejects(store.declareResolution({...policy,stability:{kind:'all-pass',repeats:2}}),/измен|хеш/);
  await store.beginResolutionForRun(candidate);
  const after=executed(candidate,before); await store.save(after);
  const result=await store.finishResolution(policy.id); assert.equal(result.issue.status,'resolved');
  await store.rebuildIssues(); assert.equal((await store.readIssues())[0]!.status,'resolved');
  const old=structuredClone(before); old.id='old_reindexed'; old.trials[0]!.id='old_trial'; await store.syncIssues(old); assert.equal((await store.readIssues())[0]!.status,'resolved');
  const next=structuredClone(after); next.id='later'; next.createdAt='2099-01-01'; next.reviewedAt='2099-01-01'; next.updatedAt='2099-01-01'; next.trials[0]!.id='later_failure'; next.trials[0]!.outcome='fail'; next.trials[0]!.checks[0]!.passed=false;
  await store.syncIssues(next); assert.equal((await store.readIssues())[0]!.status,'reproduced');
});

test('public Lab methods persist policy before running and reject edited frozen drafts', async t => {
  const { ExperimentLab, draftHash } = await import('../src/experiment.js'); const { createDemoRuntime } = await import('../src/demo.js');
  const dir=await mkdtemp(join(tmpdir(),'resolution-lab-')); t.after(()=>rm(dir,{recursive:true,force:true})); let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}); const runtime=createDemoRuntime(); const lab=new ExperimentLab(dir,{...runtime,async openTarget(...args){await gate;return runtime.openTarget(...args);}}); await lab.init(); t.after(()=>lab.close());
  const {before}=fixture(); before.scenarios.forEach(s=>{s.successCriteria='Статус изменён';s.split='dev';}); before.trials.forEach(t=>{t.split='dev';}); before.requirements=[{id:'rule',text:'Изменить статус',sourceId:'policy',quote:'Изменить статус',critical:true}]; before.sources=[{id:'policy',name:'Правило',content:'Изменить статус',hash:'policy'}]; before.evaluatorVersion=(await import('../src/pi.js')).evaluatorVersion(before.settings); await lab.store.save(before); await lab.store.syncIssues(before);
  const issue=(await lab.store.readIssues())[0]!;
  const candidate=await lab.registerCandidate(before.id,{target:{kind:'sandbox'},targetVersion:'new-code-commit'});
  const policy=await lab.prepareResolution({issueId:issue.id,baselineRunId:before.id,candidateRunId:candidate.id,reproducerIds:['case_a'],regressionIds:['regression'],stability:{kind:'all-pass',repeats:3}});
  assert.equal((await lab.store.readResolution(policy.id)).policy.ruleHash,policy.ruleHash);
  const changed=structuredClone(candidate); changed.settings.maxTurns++; await lab.store.save(changed);
  await assert.rejects(lab.startResolution(policy.id,{approved:true}),/измен/);
  await lab.store.save(candidate);
  await lab.startResolution(policy.id,{approved:true});
  try { await assert.rejects(lab.resolveIssue(policy.id),/заверш|выполня/); assert.equal((await lab.store.readResolution(policy.id)).result,undefined); } finally { release(); }
  await lab.waitForIdle();
  const result=await lab.resolveIssue(policy.id); assert.ok(result.result); assert.equal(result.issue.status,'checking');
});

test('changed rule requires fresh baseline as well as fresh candidate', async t => {
  const dir=await mkdtemp(join(tmpdir(),'resolution-policy-')); t.after(()=>rm(dir,{recursive:true,force:true})); const store=new ExperimentStore(dir); await store.init(); t.after(()=>store.close());
  const {before,candidate,issue,request}=fixture(); await store.save(before);await store.save(candidate);await store.syncIssues(before);
  const policy=resolution.prepareResolutionPolicy(request,issue,before,candidate);await store.declareResolution(policy);
  const another=structuredClone(candidate);another.id='another';another.revisions[0]!.spec.instructions='Another repair';await store.save(another);
  await assert.rejects(store.declareResolution(resolution.prepareResolutionPolicy({...request,candidateRunId:another.id},issue,before,another)),/ОБЕИХ|баз/);
  const after=executed(candidate,before);await store.save(after);
  await assert.rejects(store.finishResolution(policy.id),/запуск/);
});

test('resolution projection displays both decisions and fixed suite scope', async () => {
  const { resolutionText }=await import('../src/issue-view.js');
  const {before,candidate,issue,request}=fixture(); const policy=resolution.prepareResolutionPolicy(request,issue,before,candidate),after=executed(candidate,before);
  after.trials.find(t=>t.scenarioId==='regression')!.checks[0]!.passed=false;after.trials.find(t=>t.scenarioId==='regression')!.outcome='fail';
  const text=resolutionText({policy,result:resolution.evaluateResolution(policy,before,after,{before,after})});
  assert.match(text,/дефект больше не воспроизводится: да/);assert.match(text,/Кандидат можно принять: нет/);assert.match(text,/3 повторов/);
});

test('a reassessment of preclosure execution cannot masquerade as a later recurrence', () => {
 const {before,candidate,issue,request}=fixture(),policy=resolution.prepareResolutionPolicy(request,issue,before,candidate),after=executed(candidate,before);
 const closed=resolution.applyResolution(issue,policy,resolution.evaluateResolution(policy,before,after,{before,after}),'2026-09-22');
 const rejudged=structuredClone(after);rejudged.id='new_assessment';rejudged.assessmentOf=after.id;rejudged.executionRunId=after.id;rejudged.createdAt='2026-09-23';rejudged.updatedAt='2026-09-23';rejudged.trials[0]!.outcome='fail';rejudged.trials[0]!.checks[0]!.passed=false;
 assert.equal(syncIssues(rejudged,[closed]).issues[0]!.status,'resolved');
});

test('run confirmation includes actual candidate attempts and budget before native execution', async () => {
 const view=await import('../src/issue-view.js'),{before,candidate,issue,request}=fixture();const policy=resolution.prepareResolutionPolicy(request,issue,before,candidate);
 const text=view.resolutionRunText({policy},candidate);
 assert.match(text,/6 попыток/);assert.match(text,new RegExp(`${candidate.settings.maxCalls} вызовов`));assert.match(text,/static/);assert.match(text,/секунд/);
});

test('resolution cannot close after a source issue assessment was replaced with a different failure', () => {
 const {before,candidate,issue,request}=fixture();
 before.trials[0]!.events[1]!.text='A different execution';
 assert.throws(()=>resolution.prepareResolutionPolicy(request,issue,before,candidate),/доказательств|оценк/);
});

test('required compiled checkpoints can pass without duplicate direct checks, but missing receipt cannot close', async () => {
 const { libraryFixture }=await import('./helpers/scenario-library.js');const {acceptLibrary,compileLibrary,libraryHash}=await import('../src/scenario-library.js');const {checkpointReceipt}=await import('../src/checkpoints.js');
 const {before,candidate}=fixture(),library=libraryFixture();before.librarySnapshot=acceptLibrary(library,libraryHash(library),['variant_1']);
 const scenario=compileLibrary(before.librarySnapshot)[0]!;const regression=structuredClone(scenario);regression.id='reg';regression.familyId='reg';
 before.scenarios=[scenario,regression];const original=structuredClone(before.trials[0]!);
 before.trials=before.scenarios.flatMap(s=>Array.from({length:3},(_,repeat)=>{
  const cp=s.execution!.evaluatorView.checkpoints[0]!; const result=s.id===scenario.id?'fail' as const:'pass' as const;
  const trial={...structuredClone(original),id:`${s.id}_${repeat}`,scenarioId:s.id,familyId:s.familyId,split:s.split,initialState:s.initialState,repeat,checks:[],assessments:(s.metrics??[]).map(m=>({metricId:m.id,result:'pass' as const,rationale:'Developer synthetic fixture',evidence:[1]})),outcome:result,checkpoints:[{checkpointId:cp.id,requirementId:cp.requirementId,role:cp.role,observation:cp.observation,result,evidence:[1],rationale:'Developer synthetic fixture'}]};
  return {...trial,checkpointReceipt:checkpointReceipt(s,trial,trial.checkpoints,[])};
 }));
 const issue=syncIssues(before,[]).issues[0]!;candidate.scenarios=structuredClone(before.scenarios);candidate.librarySnapshot=structuredClone(before.librarySnapshot);
 const policy=resolution.prepareResolutionPolicy({issueId:issue.id,baselineRunId:before.id,candidateRunId:candidate.id,reproducerIds:[scenario.id],regressionIds:['reg'],stability:{kind:'all-pass',repeats:3}},issue,before,candidate);
 const after=executed(candidate,before);for(const trial of after.trials){trial.checkpoints!.forEach(cp=>{cp.result='pass';});trial.checkpointReceipt=checkpointReceipt(after.scenarios.find(s=>s.id===trial.scenarioId)!,trial,trial.checkpoints!,[]);}
 assert.equal(resolution.evaluateResolution(policy,before,after,{before,after}).candidateAcceptable,true);
 delete after.trials[0]!.checkpointReceipt;
 assert.notEqual(resolution.evaluateResolution(policy,before,after,{before,after}).candidateAcceptable,true);
});

test('candidate acceptance cannot omit a previously passing source variant', () => {
 const {before,candidate,issue,request}=fixture();const extra={...structuredClone(before.scenarios[1]!),id:'omitted',familyId:'omitted'};before.scenarios.push(extra);candidate.scenarios.push(structuredClone(extra));
 before.trials.push(...before.trials.filter(t=>t.scenarioId==='regression').map(t=>({...structuredClone(t),id:`omitted_${t.repeat}`,scenarioId:'omitted',familyId:'omitted'})));
 assert.throws(()=>resolution.prepareResolutionPolicy(request,issue,before,candidate),/весь|все|пропущ/);
});

test('a candidate draft created before closure reopens only when its actual later execution fails', () => {
 const {before,candidate,issue,request}=fixture(),policy=resolution.prepareResolutionPolicy(request,issue,before,candidate),after=executed(candidate,before);
 const closed=resolution.applyResolution(issue,policy,resolution.evaluateResolution(policy,before,after,{before,after}),'2026-09-22');
 const later=structuredClone(after);later.id='late_execution';later.createdAt='2026-09-20';later.reviewedAt='2026-09-23';later.updatedAt='2026-09-23';later.trials[0]!.id='late_trial';later.trials[0]!.outcome='fail';later.trials[0]!.checks[0]!.passed=false;
 assert.equal(syncIssues(later,[closed]).issues[0]!.status,'reproduced');
});

test('adding synthetic cases to candidate results requires a new comparable baseline', () => {
 const {before,candidate,issue,request}=fixture(),policy=resolution.prepareResolutionPolicy(request,issue,before,candidate),after=executed(candidate,before);
 after.scenarios.push({...structuredClone(after.scenarios[0]!),id:'new_synthetic',familyId:'new_family',provenance:'synthetic'});
 assert.equal(resolution.evaluateResolution(policy,before,after,{before,after}).candidateAcceptable,null);
});

test('compact resolution allowlist cannot leak embedded issue assessments from finish result', async () => {
 const {compactResolution}=await import('../src/issue-view.js'),{before,candidate,issue,request}=fixture();const policy=resolution.prepareResolutionPolicy(request,issue,before,candidate);
 const output=compactResolution({policy,issue} as any);
 assert.equal('issue' in output,false);assert.doesNotMatch(JSON.stringify(output),/Статус не изменён/);
});

test('large group composition stays complete in data but bounded and readable in the overview',async()=>{
 const {qualityLines}=await import('../src/quality.js'),r=issueRecord(),s=r.scenarios[0]!;
 r.scenarios=Array.from({length:200},(_,i)=>({...structuredClone(s),id:`s${i}`,familyId:`internal_group_${i}`,title:`Бизнес-ситуация ${i}`}));r.trials=[];
 const q=qualitySummary(r),scope=qualityLines(q).scope;
 assert.equal(q.slices.groups.length,200);assert.ok(scope.length<1000,`Scope length ${scope.length}`);assert.doesNotMatch(scope,/internal_group_|production|curated|synthetic/);assert.match(scope,/Бизнес-ситуация/);
});

test('required dev defect remains exportable when headline goal passes and reaches the human prompt boundary', async t => {
  const { ExperimentLab } = await import('../src/experiment.js');
  const { createDemoRuntime } = await import('../src/demo.js');
  const { cardOutcome } = await import('../src/comparison.js');
  const dir = await mkdtemp(join(tmpdir(), 'required-defect-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lab = new ExperimentLab(dir, createDemoRuntime()); await lab.init(); t.after(() => lab.close());
  const source = issueRecord();
  source.target = { kind: 'http', url: 'http://localhost:8000', headersEnv: {}, timeoutMs: 60000, promptFile: join(dir, 'original.md') };
  source.scenarios[0]!.metrics = [{ id: 'goal_attainment', name: 'Цель', description: 'Developer synthetic fixture: goal succeeds despite required state failure', subject: 'agent', passCriteria: 'Запрос выполнен', failCriteria: 'Запрос не выполнен' }];
  source.trials[0]!.assessments = [{ metricId: 'goal_attainment', result: 'pass', rationale: 'Developer synthetic fixture', evidence: [1] }];
  const record = experimentSchema.parse(source);
  await lab.store.save(record); await lab.store.syncIssues(record);
  const issue = (await lab.store.readIssues())[0]!;
  assert.equal(issue.identity.criterionId, 'done');
  assert.equal(headlineCardOutcome(record, record.scenarios[0]!).outcome, 'pass');
  assert.equal(cardOutcome(record, record.scenarios[0]!), 'fail');
  const bundle = await lab.createFixBundle(issue.id, record.id);
  assert.deepEqual(bundle.devTrials.map(trial => trial.id), [record.trials[0]!.id]);
  assert.deepEqual(bundle.controlTrials, []);
  await assert.rejects(lab.proposeIssueFix(issue.id, record.id, { candidate: 'Repair required state update', hypothesis: 'Retry the required operation', trialIds: [record.trials[0]!.id] }), /подтверждённые человеком/);
  assert.deepEqual((await lab.get(record.id)).humanReviews, []);
  const replaced = structuredClone(record); replaced.trials[0]!.events[1]!.text = 'Different execution';
  assert.throws(() => resolution.createFixBundle(issue, replaced), /доказательств/);
  const incomplete = structuredClone(record); incomplete.settings.repeats = 2;
  assert.throws(() => resolution.createFixBundle(issue, incomplete), /полные пригодные/);
});
