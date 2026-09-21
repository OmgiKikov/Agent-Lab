import assert from 'node:assert/strict';
import { test } from 'node:test';
import { libraryFixture } from './helpers/scenario-library.js';
import { semanticContentHash, semanticPaths } from '../src/scenario-library.js';
import { emptyUsage, type CallContext } from '../src/contracts.js';

const ctx: CallContext = { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} };

test('200 variants with 20 facts and 12 checkpoints use bounded requests and complete separate relation findings', async () => {
  const planner = await import('../src/scenario-preparation.js');
  assert.equal(typeof planner.assessScenarioLibrary, 'function', 'initial preparation and reassessment share bounded work');
  const library = libraryFixture();
  const seed = library.variants[0]!;
  library.variants = Array.from({ length: 200 }, (_, i) => ({ ...structuredClone(seed), id: `large_${i}`,
    userState: { ...structuredClone(seed.userState), facts: Array.from({ length: 20 }, (_, j) => ({ ...structuredClone(seed.userState.facts[0]!), id: `fact_${j}` })) },
    evaluationSpec: { ...structuredClone(seed.evaluationSpec), checkpoints: Array.from({ length: 12 }, (_, j) => ({ ...structuredClone(seed.evaluationSpec.checkpoints[0]!), id: `checkpoint_${j}` })) },
  }));
  const expectedHash = semanticContentHash(library);
  let calls = 0, partials = 0, relations = 0;
  const relationCandidates = new Set<string>();
  const result = await planner.assessScenarioLibrary(library, { async assessScenarioProposals(input, context) {
    context.beforeCall(); calls++;
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 64000, 'serialized request byte ceiling');
    assert.ok(input.fields.reduce((n, f) => n + f.paths.length, 0) <= 6, 'bounded response cardinality');
    assert.equal(input.contentHash, expectedHash);
    if (input.scope === 'relations') { relations++; for (const candidate of input.comparisonCandidates) relationCandidates.add(candidate.id); }
    return input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } }, ctx, async partial => {
    partials++; assert.equal(partial.semanticAssessment!.contentHash, expectedHash);
  });
  assert.ok(calls > 200); assert.ok(partials > 1); assert.ok(relations > 0); assert.equal(relationCandidates.size, 200);
  assert.equal(result.semanticAssessment!.findings.length, 7400);
  for (const variant of result.variants) for (const path of semanticPaths(variant)) assert.equal(result.semanticAssessment!.findings.filter(f => f.variantId === variant.id && f.path === path && f.status === 'ready').length, 1);
});

test('an interrupted semantic plan preserves partial findings bound to the complete unchanged evidence', async () => {
  const { assessScenarioLibrary } = await import('../src/scenario-work.js');
  const { acceptLibrary, libraryHash } = await import('../src/scenario-library.js');
  const library = libraryFixture(); const partials: typeof library[] = [];
  let calls = 0;
  await assert.rejects(() => assessScenarioLibrary(library, { async assessScenarioProposals(input) {
    if (++calls === 2) throw new Error('interrupted assessment');
    return input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } }, ctx, async partial => { partials.push(structuredClone(partial)); }), /interrupted/);
  const last = partials.at(-1)!;
  assert.ok(last.semanticAssessment!.findings.length > 0);
  assert.equal(last.semanticAssessment!.contentHash, semanticContentHash(library));
  assert.deepEqual(last.imports, library.imports);
  assert.throws(() => acceptLibrary(last, libraryHash(last), ['variant_1']), /готов/);
});

test('resuming a split relation pass reuses completed calls and retains conservative findings until every candidate block completes', async () => {
  const { assessScenarioLibrary, planSemanticWork, semanticWorkStatus } = await import('../src/scenario-work.js');
  const { fingerprint } = await import('../src/contracts.js');
  const library = libraryFixture(), seed = library.variants[0]!;
  library.variants = Array.from({ length: 10 }, (_, i) => ({ ...structuredClone(seed), id: `relation_${i}`,
    userState: { ...structuredClone(seed.userState), facts: Array.from({ length: 20 }, (_, j) => ({ ...structuredClone(seed.userState.facts[0]!), id: `fact_${j}`, statement: 'x'.repeat(300) })) },
  }));
  const planned = planSemanticWork(library).jobs.filter(j => j.input.scope === 'relations');
  assert.ok(planned.filter(j => j.input.fields[0]!.variantId === 'relation_0').length > 1);
  const finished = new Set<string>(); let relationCalls = 0, partial = library;
  const runtime = { async assessScenarioProposals(value: Parameters<NonNullable<import('../src/contracts.js').Runtime['assessScenarioProposals']>>[0]) {
    const hash = fingerprint(value); assert.ok(!finished.has(hash), 'completed calls must not repeat');
    if (value.scope === 'relations' && ++relationCalls === 2) throw new Error('interrupted relation block');
    finished.add(hash);
    return value.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path,
      status: value.scope === 'relations' && relationCalls === 1 && path === 'duplicates' ? 'blocked' as const : 'ready' as const, reason: 'Проверено' })));
  } };
  await assert.rejects(() => assessScenarioLibrary(library, runtime, ctx, async next => { partial = structuredClone(next); }), /interrupted relation/);
  const status = semanticWorkStatus(partial);
  assert.equal(status.completedJobs, finished.size);
  assert.equal(status.pendingJobs, status.totalJobs - finished.size, 'resume estimate excludes persisted same-content receipts');
  assert.equal(partial.semanticAssessment!.findings.find(f => f.variantId === 'relation_0' && f.path === 'duplicates')!.status, 'needs_review');
  const complete = await assessScenarioLibrary(partial, runtime, ctx, async () => {});
  assert.equal(complete.semanticAssessment!.findings.find(f => f.variantId === 'relation_0' && f.path === 'duplicates')!.status, 'blocked');
  assert.equal(complete.semanticAssessment!.findings.find(f => f.variantId === 'relation_0' && f.path === 'businessScenarioId')!.status, 'ready');
});

test('a complete semantic assessment reports no pending calls and same-content reassessment makes no calls', async () => {
  const { assessScenarioLibrary, semanticWorkStatus } = await import('../src/scenario-work.js');
  const library = libraryFixture(); let calls = 0;
  const runtime = { async assessScenarioProposals(input: Parameters<NonNullable<import('../src/contracts.js').Runtime['assessScenarioProposals']>>[0]) {
    calls++;
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } };
  const complete = await assessScenarioLibrary(library, runtime, ctx, async () => {});
  const initialCalls = calls;
  const status = semanticWorkStatus(complete);
  assert.ok(initialCalls > 0);
  assert.equal(status.completedJobs, status.totalJobs);
  assert.equal(status.pendingJobs, 0);
  let persisted = 0;
  const repeated = await assessScenarioLibrary(complete, runtime, ctx, async () => { persisted++; });
  assert.equal(calls, initialCalls, 'same-content complete assessment does not spend model calls again');
  assert.equal(persisted, 0, 'same-content complete assessment does not publish fake progress revisions');
  assert.deepEqual(repeated, complete);
});

test('cross-group comparisons retain actual membership and complete differing policy fixture and checkpoints', async () => {
  const { planSemanticWork } = await import('../src/scenario-work.js');
  const library = libraryFixture(), seed = library.variants[0]!, business = library.businessScenarios[0]!;
  library.businessScenarios.push({ ...structuredClone(business), id: 'other_business' });
  library.variants = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(seed), id: `cross_${i}` }));
  const child = library.variants[3]!;
  child.businessScenarioId = 'other_business';
  child.behaviorPolicy.actions[0]!.payload = 'Сообщить номер только после уточнения';
  child.environmentFixture.initialState = { records: { terminal: { failure: true } }, writableFields: [] };
  child.evaluationSpec.checkpoints[0]!.rule = 'При отказе инструмента объяснить невозможность завершить возврат';
  const plan = planSemanticWork(library);
  const input = plan.jobs.find(j => j.input.scope === 'relations' && j.input.fields.some(f => f.variantId === 'cross_0') && j.input.comparisonCandidates.some(c => c.id === child.id))!.input;
  const candidate = input.comparisonCandidates.find(c => c.id === child.id)!;
  assert.equal(candidate.businessScenarioId, child.businessScenarioId);
  assert.notEqual(candidate.businessScenarioId, input.library.variants[0]!.businessScenarioId);
  assert.equal(candidate.business.goal, business.goal, 'same-goal split remains visible via actual grouping IDs');
  assert.deepEqual(candidate.behaviorPolicy, child.behaviorPolicy);
  assert.deepEqual(candidate.environmentFixture, child.environmentFixture);
  assert.deepEqual(candidate.evaluationSpec, child.evaluationSpec);
  assert.deepEqual(candidate.userState, child.userState);
  assert.ok(plan.jobs.every(j => Buffer.byteLength(JSON.stringify(j.input)) <= 64000 && j.outputBytes <= 12000));
  child.environmentFixture.initialState = { payload: 'x'.repeat(70000) };
  const oversized = planSemanticWork(library);
  assert.ok(oversized.skipped.some(f => f.variantId === 'cross_0' && f.path === 'duplicates' && f.status === 'needs_review'), 'unrepresentable complete candidate cannot be declared checked');
});

test('semantic context authenticates owner facts including inherited receipts without rewriting chronology', async () => {
  const { editLibrary, libraryHash, libraryQuality } = await import('../src/scenario-library.js');
  const { planSemanticWork } = await import('../src/scenario-work.js');
  const source = libraryFixture(), original = structuredClone(source.imports);
  const edited = editLibrary(source, libraryHash(source), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number', statement: 'Номер терминала: 4321', value: '4321', availability: 'initial', editId: 'owner_prior_knowledge', reason: 'Владелец уточнил исходное личное знание' });
  const child = structuredClone(edited.variants[0]!);
  child.id = 'inherited'; child.parentVariantId = 'variant_1'; child.provenance = 'synthetic'; child.history = [{ author: 'generator', revision: 1, reason: 'Унаследован факт' }];
  edited.variants.push(child);
  const evidence = (library: typeof edited, id: string) => (planSemanticWork(library).jobs.find(j => j.input.scope === 'fields' && j.input.fields[0]!.variantId === id)!.input as any).ownerFactEvidence;
  for (const id of ['variant_1', 'inherited']) assert.deepEqual(evidence(edited, id), [{ variantId: id, factId: 'terminal_number', editId: 'owner_prior_knowledge', status: 'verified' }]);
  assert.deepEqual(edited.imports, original, 'owner authority is an additional source, never a rewritten log');
  const tampered = structuredClone(edited); tampered.variants[0]!.userState.facts[0]!.availability = 'learned_in_source';
  assert.equal(evidence(tampered, 'variant_1')[0].status, 'unverified');
  assert.equal(evidence(tampered, 'inherited')[0].status, 'unverified', 'stale parent chain cannot vouch for child');
  const invented = structuredClone(edited); invented.variants[0]!.history = [];
  assert.equal(evidence(invented, 'variant_1')[0].status, 'unverified');
  assert.ok(libraryQuality(invented).some(i => i.code === 'unverified_owner_fact'));
  const minted = structuredClone(edited); minted.variants[0]!.history.at(-1)!.author = 'generator';
  assert.equal(evidence(minted, 'variant_1')[0].status, 'unverified');
});

test('new owner evidence context does not reuse old semantic findings while historical acceptance stays intact', async () => {
  const { assessScenarioLibrary, planSemanticWork, semanticWorkStatus } = await import('../src/scenario-work.js');
  const { recordSemanticAssessment, acceptLibrary, libraryHash, editLibrary } = await import('../src/scenario-library.js');
  const { fingerprint } = await import('../src/contracts.js');
  const original = libraryFixture();
  const library = editLibrary(original, libraryHash(original), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number', statement: 'Номер терминала: 4321', value: '4321', availability: 'initial', editId: 'verified_but_inconsistent', reason: 'Подтверждён факт; первая реплика всё ещё содержит другой номер' });
  // Historical assessment predates the context contract; its accepted hash remains readable.
  const findings = library.variants.flatMap(v => semanticPaths(v).map(path => ({ variantId: v.id, path, status: 'ready' as const, reason: 'Историческая оценка' })));
  const oldFinal = acceptLibrary(recordSemanticAssessment(library, findings), libraryHash(recordSemanticAssessment(library, findings)), ['variant_1']);
  const bytes = JSON.stringify(oldFinal);
  assert.ok(semanticWorkStatus(oldFinal).pendingJobs > 0, 'explicit reassessment uses new context version');
  assert.equal(JSON.stringify(oldFinal), bytes, 'reading a legacy accepted snapshot does not change it');
  const plan = planSemanticWork(oldFinal);
  const partial = structuredClone(oldFinal);
  partial.semanticAssessment = { contentHash: plan.contentHash, findings, workReceipts: plan.jobs.map(job => ({
    workHash: fingerprint({ evidenceVersion: 2, contentHash: plan.contentHash, scope: job.input.scope, fields: job.input.fields, candidates: job.input.comparisonCandidates.map(c => c.id) }),
    findings: job.input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Старый контекст' }))),
  })) };
  assert.equal(semanticWorkStatus(partial).completedJobs, 0);
  let calls = 0;
  const complete = await assessScenarioLibrary(partial, { async assessScenarioProposals(input) {
    calls++;
    if (input.fields.some(f => f.variantId === 'variant_1')) assert.ok(input.ownerFactEvidence.some(e => e.editId === 'verified_but_inconsistent' && e.status === 'verified'));
    return input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: path === 'userState' ? 'needs_review' as const : 'ready' as const, reason: 'Остаётся конкретное смысловое противоречие' })));
  } }, ctx, async () => {});
  assert.equal(calls, plan.jobs.length);
  assert.equal(semanticWorkStatus(complete).pendingJobs, 0);
  assert.throws(() => acceptLibrary(complete, libraryHash(complete), ['variant_1']), /готов/, 'verified evidence never forces semantic approval');
});
