import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '../src/contracts.js';
import { ExperimentStore } from '../src/store.js';
const api = async () => import('../src/generator-evaluation.js').catch(() => assert.fail('Generator evaluation API must exist'));
const context = () => ({ signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} });
const config = { instructions: 'Сохраняйте происхождение фактов; правила задаёт владелец.', temperature: 0 };

test('corpus has 24 explicit developer labels, eight per dimension and disjoint lineage splits', async () => {
  const { loadGeneratorCorpus } = await api(); const corpus = await loadGeneratorCorpus();
  assert.equal(corpus.cases.length, 24);
  assert.equal(corpus.cases.filter(c => c.split === 'dev').length, 16);
  assert.equal(corpus.cases.filter(c => c.split === 'holdout').length, 8);
  for (const dimension of ['provenance', 'applicability', 'variants']) assert.equal(corpus.cases.filter(c => c.dimension === dimension).length, 8);
  assert.equal(corpus.labelStatus, 'developer-labeled');
  for (const c of corpus.cases) { assert.ok(c.input.ownerRequirement); assert.ok(c.input.source); assert.ok(c.expected); assert.equal(corpus.cases.some(other => other.lineage === c.lineage && other.split !== c.split), false); }
});

test('actual generated learned-fact leakage and wrong applicability are errors rather than expected-label passes', async () => {
  const { evaluateGenerator, loadGeneratorCorpus } = await api(); const corpus = await loadGeneratorCorpus();
  const report = await evaluateGenerator(corpus, { config, transport: 'deterministic-test', async generate(input) {
    return { facts: [{ id: 'duration', availability: 'initial' }], applicability: 'applicable', duplicate: 'none', validity: 'valid', rationale: 'Предположение' };
  } }, false, context());
  assert.equal(report.cases.length, 24); assert.ok(report.dimensions.provenance.errors > 0); assert.ok(report.dimensions.applicability.errors > 0);
  assert.ok(report.cases.some(c => c.errors.includes('learned_fact_leak')));
  assert.equal(report.transport, 'deterministic-test'); assert.ok(report.cases[0].rawOutput);
});

test('three controls execute actual runner tools and controller, independently report judge misses and false positives', async () => {
  const { runGeneratorControls } = await api();
  const deterministic = await runGeneratorControls(undefined, context());
  assert.deepEqual(deterministic.execution.map(c => c.result), ['fail','pass','fail','pass','fail','pass']);
  assert.ok(deterministic.execution[2].trial.events.some(e => e.type === 'tool_result' && e.result.ok === false));
  assert.ok(deterministic.execution[4].trial.events.some(e => e.type === 'user' && e.text.includes('Отмените')));
  const allPass = await runGeneratorControls({ async assessCheckpoints(input) { return input.checkpoints.map(c => ({ checkpointId: c.checkpoint.id, result: 'pass', evidence: c.allowedEvidence, rationale: 'Ошибочная оценка' })); } }, context());
  assert.equal(allPass.calibration.missedDefects, 3); assert.equal(allPass.calibration.falsePositives, 0);
});

test('selection blocks invalid, leaked, exact and unresolved semantic duplicates before rewarding coverage', async () => {
  const { selectNextVariants } = await api();
  const base = { quality: 'ready', provenanceErrors: 0, applicabilityErrors: 0, validity: 'valid', duplicate: 'none', coverage: ['new'], unmetConditions: 1, reproducibleIssues: 0, instability: 0, targetFailures: 0 };
  const selected = selectNextVariants([{ ...base, id: 'good', contentHash: 'same' }, { ...base, id: 'copy', contentHash: 'same', targetFailures: 999 }, { ...base, id: 'invalid', contentHash: 'bad', validity: 'invalid', targetFailures: 999 }, { ...base, id: 'semantic', contentHash: 'semantic', duplicate: 'unresolved' }, { ...base, id: 'leak', contentHash: 'leak', provenanceErrors: 1 }], []);
  assert.deepEqual(selected.selected.map(c => c.id), ['good']); assert.equal(selected.excluded.length, 4);
});

test('optimizer freezes final config and consumes holdout without feedback or nested errors reaching proposer', async t => {
  const { optimizeGenerator, loadGeneratorCorpus } = await api();
  const corpus = await loadGeneratorCorpus(); for (const c of corpus.cases.filter(c => c.split === 'holdout')) c.input.source += ' DISTINCTIVE_HOLDOUT_SECRET';
  const directory = await mkdtemp(join(tmpdir(), 'generator-')); const store = new ExperimentStore(directory); await store.init(); t.after(async () => { await store.close(); await rm(directory,{recursive:true,force:true}); });
  const requests = []; let holdoutStarted = false;
  const generator = { config, transport: 'deterministic-test', async generate(input) {
    if (input.source.includes('DISTINCTIVE_HOLDOUT_SECRET')) { holdoutStarted = true; throw new Error('DISTINCTIVE_HOLDOUT_SECRET nested result'); }
    return { facts: [], applicability: 'unknown', duplicate: 'none', validity: 'unknown', rationale: 'Недостаточно данных' };
  }, async propose(input) { assert.equal(holdoutStarted, false); requests.push(structuredClone(input)); return { ...config, instructions: config.instructions + ' Проверяйте цитаты.' }; } };
  const result = await optimizeGenerator({ corpus, generator, maxCandidates: 1, controls: false }, { ...context(), store });
  assert.equal(result.holdout.cases.length, 8); assert.equal(result.holdout.cases.every(c => c.error.includes('DISTINCTIVE_HOLDOUT_SECRET')), true);
  assert.doesNotMatch(JSON.stringify(requests), /DISTINCTIVE_HOLDOUT_SECRET|holdout/);
  assert.equal(result.finalConfigHash, result.holdout.configHash);
  await assert.rejects(optimizeGenerator({ corpus, generator, maxCandidates: 1, controls: false }, { ...context(), store }), /использован|consumed/i);
  assert.deepEqual(await store.readGeneratorRecord(result.id), result);
  await assert.rejects(store.saveGeneratorRecord({ ...result, finalConfigHash: 'tampered' }), /неизмен|immutable/i);
  assert.equal((await stat(join(directory,'generator-evals',`${result.id}.json`))).mode & 0o777,0o600);
  const reader = new ExperimentStore(directory); assert.deepEqual(await reader.readGeneratorRecord(result.id),result);
  await assert.rejects(reader.saveGeneratorRecord(result), /писател/i);
});

test('comparison cannot reward abstention or target failure and rejects dimension regression', async () => {
  const { compareGenerators, evaluateGenerator, loadGeneratorCorpus }=await api();const corpus=await loadGeneratorCorpus();
  const generator={config,transport:'deterministic-test',async generate(){return {facts:[],applicability:'unknown',duplicate:'none',validity:'unknown',rationale:'Неизвестно'};}};
  const baseline=await evaluateGenerator(corpus,generator,false,context()), candidate=structuredClone(baseline);
  candidate.dimensions.provenance.errors--;candidate.dimensions.applicability.errors++;
  assert.equal(compareGenerators(baseline,candidate).admitted,false);
  const abstain=structuredClone(baseline);abstain.dimensions.provenance.errors--;abstain.dimensions.provenance.unknown++;
  assert.equal(compareGenerators(baseline,abstain).admitted,false);
});

test('public bounded lab evaluation persists partial failures and never modifies a target suite', async t => {
  const { ExperimentLab }=await import('../src/experiment.js');
  const directory=await mkdtemp(join(tmpdir(),'generator-lab-'));let calls=0;
  const lab=new ExperimentLab(directory,{async generateScenarioCase(input,ctx){ctx.beforeCall();calls++;throw new Error('transport failure');}} as any);
  await lab.init();t.after(async()=>{await lab.close();await rm(directory,{recursive:true,force:true});});
  assert.equal(typeof lab.evaluateGenerator,'function','Lab must expose bounded generator evaluation');
  const report=await lab.evaluateGenerator({config,caseIds:['p1','p2'],controls:false,settings:{maxCalls:1,maxDurationMs:10000}});
  assert.equal(calls,1);assert.equal(report.cases.length,2);assert.equal(report.dimensions.provenance.unknown,2);
  assert.deepEqual(await lab.store.list(),[]);assert.deepEqual(await lab.store.readGeneratorRecord(report.id),report);
});

test('direct holdout audits consume revision and cannot be relabeled as fresh', async t => {
  const {evaluateGenerator,loadGeneratorCorpus}=await api();const corpus=await loadGeneratorCorpus();corpus.cases=corpus.cases.filter(c=>c.split==='holdout');
  const directory=await mkdtemp(join(tmpdir(),'generator-audit-')),store=new ExperimentStore(directory);await store.init();t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  const generator={config,transport:'deterministic-test',async generate(){return {facts:[],applicability:'unknown',duplicate:'none',validity:'unknown',rationale:'Нет данных'};}};
  await evaluateGenerator(corpus,generator,false,{...context(),store});
  await assert.rejects(evaluateGenerator({...corpus,revision:'renamed'},generator,false,{...context(),store}),/использован/);
});

test('rejected public targeted proposal retains bounded request and original error without publishing child', async t => {
  const {demoEvaluateRecord}=await import('./helpers/demo-record.js');const {libraryFixture}=await import('./helpers/scenario-library.js');const {libraryHash}=await import('../src/scenario-library.js');
  const {lab,directory,record}=await demoEvaluateRecord();t.after(async()=>{await lab.close();await rm(directory,{recursive:true,force:true});});
  const library=libraryFixture();record.phase='review';record.librarySnapshot=library;await lab.store.publishLibrary(record,library);
  const before=await lab.readLibrary(record.id);
  await assert.rejects(lab.proposeVariant(record.id,libraryHash(library),{parentId:'missing',operation:'ambiguous_opening',reason:'Проверить отсутствие родителя',input:{opening:'Что делать?'}}),/родител|вариант/i);
  const files=await (await import('node:fs/promises')).readdir(join(lab.store.directory,'generator-evals'));
  assert.equal(files.length,1);const audit=await lab.store.readGeneratorRecord(files[0].replace('.json',''));
  assert.equal(audit.kind,'rejected-targeted-proposal');assert.equal(audit.libraryHash,libraryHash(library));assert.equal(audit.attempt.parentId,'missing');assert.ok(audit.rejection);
  assert.deepEqual((await lab.readLibrary(record.id)).library,before.library);
  lab.store.saveGeneratorRecord=async()=>{throw new Error('audit write denied');};
  await assert.rejects(lab.proposeVariant(record.id,libraryHash(library),{parentId:'missing',operation:'ambiguous_opening',reason:'Повторная попытка',input:{opening:'Что делать?'}}), /Вариант missing не найден.*Аудит отклонения не сохранён.*audit write denied/);
});

test('consumed holdout cannot be bypassed by reordering, renaming or auditing an overlapping subset',async t=>{
 const {evaluateGenerator,loadGeneratorCorpus}=await api();const corpus=await loadGeneratorCorpus();corpus.cases=corpus.cases.filter(c=>c.split==='holdout');
 const directory=await mkdtemp(join(tmpdir(),'generator-overlap-')),store=new ExperimentStore(directory);await store.init();t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
 const generator={config,transport:'deterministic-test',async generate(){throw new Error('unknown');}};
 await evaluateGenerator(corpus,generator,false,{...context(),store});
 await assert.rejects(evaluateGenerator({...corpus,cases:corpus.cases.slice(0,1).map(c=>({...c,id:'renamed'}))},generator,false,{...context(),store}),/использован/);
});

test('control calibration reports false positives separately and preserves tool failure before claim',async()=>{
 const {runGeneratorControls}=await api();const result=await runGeneratorControls({async assessCheckpoints(input){return input.checkpoints.map(c=>{if(c.checkpoint.id==='failed_update'){assert.equal(c.context.find(e=>e.type==='tool_result').seq,2);assert.equal(c.dialogue.find(e=>e.type==='assistant').seq,3);}return {checkpointId:c.checkpoint.id,result:'fail',evidence:c.allowedEvidence,rationale:'Ошибка судьи'};});}},context());
 assert.equal(result.calibration.falsePositives,3);assert.equal(result.calibration.missedDefects,0);
});

test('public generator respects cancellation before any model call',async t=>{
 const {ExperimentLab}=await import('../src/experiment.js');const directory=await mkdtemp(join(tmpdir(),'generator-cancel-'));let calls=0;
 const lab=new ExperimentLab(directory,{async generateScenarioCase(){calls++;throw new Error('unexpected');}} as any);await lab.init();t.after(async()=>{await lab.close();await rm(directory,{recursive:true,force:true});});
 const controller=new AbortController();controller.abort(new Error('Explicit cancellation'));
 await assert.rejects(lab.evaluateGenerator({config,controls:false,caseIds:['p1']},{signal:controller.signal}),/Explicit cancellation/);assert.equal(calls,0);
});

test('conservative admission rejects a new learned leak hidden by another improvement',async()=>{
 const {evaluateGenerator,loadGeneratorCorpus,compareGenerators}=await api();const corpus=await loadGeneratorCorpus();
 const baseline=await evaluateGenerator(corpus,{config,transport:'deterministic-test',async generate(){throw new Error('Unknown');}},false,context());
 const candidate=structuredClone(baseline);candidate.dimensions.applicability.errors--;candidate.cases[0].errors=['learned_fact_leak'];
 assert.equal(compareGenerators(baseline,candidate).admitted,false);
});

test('consumed holdout from an earlier report remains consumed after audit key upgrades',async t=>{
 const {evaluateGenerator,loadGeneratorCorpus}=await api();const corpus=await loadGeneratorCorpus();corpus.cases=corpus.cases.filter(c=>c.id==='a6');
 const directory=await mkdtemp(join(tmpdir(),'generator-legacy-audit-')),store=new ExperimentStore(directory);await store.init();t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
 await store.saveGeneratorRecord({id:'gen_earlier',formatVersion:'1',kind:'generator-evaluation',corpus,holdoutConsumed:true});
 await assert.rejects(evaluateGenerator(corpus,{config,transport:'deterministic-test',async generate(){throw new Error('Must not run');}},false,{...context(),store}),/использован/);
});
