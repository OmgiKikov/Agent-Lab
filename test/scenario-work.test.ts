import assert from 'node:assert/strict';
import { test } from 'node:test';
import { libraryFixture } from './helpers/scenario-library.js';
import { semanticContentHash, semanticPaths } from '../src/scenario-library.js';
import { emptyUsage, type CallContext } from '../src/contracts.js';

const ctx: CallContext = { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} };

test('a card cannot hide its reading evidence by removing editable source references', async () => {
  const { checkerSourceIds, planSemanticWork } = await import('../src/scenario-work.js');
  const library = libraryFixture(), card = library.variants[0]!;
  const batchId = library.imports[0]!.id, dialogueId = card.sourceDialogues[0]!.dialogueId;
  library.sources.push({ id: 'uncited', name: 'Исключение', content: 'Отдельное исключение из общего правила', hash: 'fixture' });
  library.readingManifest = [{ batchId, dialogueId, sourceIds: ['policy', 'uncited'], variantIds: [card.id], requestHash: 'a'.repeat(64) }];
  card.sourceDialogues = []; card.userState.facts = []; delete card.sourceCoverageBasis;
  assert.ok(checkerSourceIds(library, [card.id]).includes('uncited'));
  const job = planSemanticWork(library).jobs.find(job => job.input.scope === 'fields' && job.input.fields[0]?.variantId === card.id)!;
  assert.ok(job.input.library.imports.some(batch => batch.id === batchId && batch.dialogues.some(d => d.id === dialogueId)));
  const child = structuredClone(card); child.id = 'derived'; child.parentVariantId = card.id;
  library.variants.push(child);
  assert.ok(checkerSourceIds(library, [child.id]).includes('uncited'));
  assert.ok(!checkerSourceIds(library, [library.variants[1]!.id]).includes('uncited'), 'immutable binding does not expand unrelated jobs');
});

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
  assert.equal(result.semanticAssessment!.findings.length, 7600);
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
  assert.equal(partial.semanticAssessment!.findings.find(f => f.variantId === 'relation_0' && f.path === 'duplicates')!.status, 'blocked', 'an observed blocking finding stays blocked while other comparisons remain pending');
  assert.equal(partial.semanticAssessment!.findings.find(f => f.variantId === 'relation_0' && f.path === 'businessScenarioId')!.status, 'needs_review', 'local grounding and a partial set of comparisons cannot establish readiness');
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

test('business membership has a source-grounded local job as well as bounded relation comparisons', async () => {
  const { planSemanticWork } = await import('../src/scenario-work.js');
  const library = libraryFixture();
  library.businessScenarios[0]!.goal = 'Клиент хочет использовать неподтверждённый продукт';
  const plan = planSemanticWork(library);
  for (const variant of library.variants) {
    const local = plan.jobs.find(job => job.input.scope === 'fields' && job.input.fields.some(field => field.variantId === variant.id && field.paths.includes('businessScenarioId')))!.input;
    assert.equal(local.library.businessScenarios[0]!.goal, library.businessScenarios[0]!.goal);
    assert.deepEqual(local.library.sources, library.sources, 'the original policy is present, not only extracted requirements');
    const ref = variant.sourceDialogues[0]!;
    const original = library.imports.find(batch => batch.id === ref.batchId)!.dialogues.find(dialogue => dialogue.id === ref.dialogueId)!;
    assert.deepEqual(local.library.imports[0]!.dialogues[0]!.events, original.events, 'the entire chronology grounds asserted business conditions');
    assert.equal(local.comparisonCandidates.length, 0, 'source evidence does not compete with duplicate comparison payloads');
    assert.ok(plan.jobs.some(job => job.input.scope === 'relations' && job.input.fields.some(field => field.variantId === variant.id && field.paths.includes('businessScenarioId'))));
  }
  assert.ok(plan.jobs.every(job => Buffer.byteLength(JSON.stringify(job.input)) <= 64000));
});

test('business admission conservatively combines local grounding and relational grouping', async () => {
  const { assessScenarioLibrary } = await import('../src/scenario-work.js');
  const { acceptLibrary, libraryHash } = await import('../src/scenario-library.js');
  for (const blockingScope of ['fields', 'relations'] as const) {
    const library = libraryFixture();
    const reason = blockingScope === 'fields' ? 'Источник не устанавливает приписанный продукт' : 'Одинаковый бизнес необоснованно разделён';
    const checked = await assessScenarioLibrary(library, { async assessScenarioProposals(input) {
      return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path,
        status: field.variantId === 'variant_1' && path === 'businessScenarioId' && input.scope === blockingScope ? 'blocked' as const : 'ready' as const,
        reason: input.scope === blockingScope ? reason : 'Другая проверка не обнаружила проблемы' })));
    } }, ctx, async () => {});
    const finding = checked.semanticAssessment!.findings.find(item => item.variantId === 'variant_1' && item.path === 'businessScenarioId')!;
    assert.equal(finding.status, 'blocked', `${blockingScope} cannot be overwritten by ready in the other scope`);
    assert.equal(finding.reason, reason);
    assert.throws(() => acceptLibrary(checked, libraryHash(checked), ['variant_1']), /готов/);
  }
});

test('business grounding stays pending until relation jobs complete and resumes without repeating grounded work', async () => {
  const { assessScenarioLibrary } = await import('../src/scenario-work.js');
  const { fingerprint } = await import('../src/contracts.js');
  const library = libraryFixture(), completed = new Set<string>();
  let interrupt = true, partial = library;
  const runtime = { async assessScenarioProposals(input: Parameters<NonNullable<import('../src/contracts.js').Runtime['assessScenarioProposals']>>[0]) {
    if (input.scope === 'relations' && interrupt) { interrupt = false; throw new Error('stop before grouping'); }
    const hash = fingerprint(input);
    assert.ok(!completed.has(hash), 'resume reuses completed local receipts');
    completed.add(hash);
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } };
  await assert.rejects(() => assessScenarioLibrary(library, runtime, ctx, async value => { partial = structuredClone(value); }), /stop before grouping/);
  for (const variant of library.variants) assert.equal(partial.semanticAssessment!.findings.find(finding => finding.variantId === variant.id && finding.path === 'businessScenarioId')!.status, 'needs_review');
  const complete = await assessScenarioLibrary(partial, runtime, ctx, async () => {});
  for (const variant of library.variants) assert.equal(complete.semanticAssessment!.findings.find(finding => finding.variantId === variant.id && finding.path === 'businessScenarioId')!.status, 'ready');
});

test('a skipped source-grounding job cannot be made ready by evidence-free relations', async () => {
  const { assessScenarioLibrary, planSemanticWork } = await import('../src/scenario-work.js');
  const library = libraryFixture();
  library.sources[0]!.content += '\n' + 'x'.repeat(70000);
  const plan = planSemanticWork(library);
  assert.ok(plan.skipped.some(finding => finding.variantId === 'variant_1' && finding.path === 'businessScenarioId'));
  assert.ok(plan.jobs.some(job => job.input.scope === 'relations'));
  const complete = await assessScenarioLibrary(library, { async assessScenarioProposals(input) {
    assert.equal(input.scope, 'relations');
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path, status: 'ready' as const, reason: 'Сгенерированные условия выглядят согласованно' })));
  } }, ctx, async () => {});
  const finding = complete.semanticAssessment!.findings.find(item => item.variantId === 'variant_1' && item.path === 'businessScenarioId')!;
  assert.equal(finding.status, 'needs_review');
  assert.match(finding.reason, /байт|предел/);
});

test('editing one card keeps the other card\'s field receipts, and the reading manifest stays visible to the checker', async () => {
  const { assessScenarioLibrary, checkerSourceIds, planSemanticWork, semanticWorkStatus } = await import('../src/scenario-work.js');
  const { editLibrary, libraryHash } = await import('../src/scenario-library.js');
  const library = libraryFixture();
  library.sources.push({ id: 'unread', name: 'Непроцитированная', content: 'Срок возврата зависит от канала', hash: 'unread-hash' });
  library.readingManifest = [{ dialogueId: 'terminal', sourceIds: ['policy', 'unread'] }];
  const checked = await assessScenarioLibrary(library, { async assessScenarioProposals(input) {
    if (input.scope === 'fields' && input.fields.some(field => field.variantId === 'variant_1')) assert.ok(input.library.sources.some(source => source.id === 'unread'));
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } }, ctx, async () => {});
  assert.deepEqual(checkerSourceIds(checked, ['variant_1']), ['policy', 'unread']);
  const edited = editLibrary(checked, libraryHash(checked), { kind: 'edit_variant_text', variantId: 'variant_2', field: 'opening', value: 'Когда вернут оплату?', editId: 'owner_1', reason: 'Владелец в разговоре: «Когда вернут оплату?»' });
  const status = semanticWorkStatus(edited);
  assert.ok(status.completedJobs > 0, 'the untouched card still has receipts');
  assert.ok(status.pendingJobs > 0, 'the edited card and its comparisons run again');
  assert.ok(status.completedJobs < status.totalJobs);
  const plan = planSemanticWork(edited);
  assert.equal(plan.contentHash, status.contentHash);
});

test('semantic receipts bind the complete evidence request, including business meaning and chronology', async () => {
  const { assessScenarioLibrary, semanticWorkStatus } = await import('../src/scenario-work.js');
  const checked = await assessScenarioLibrary(libraryFixture(), { async assessScenarioProposals(input) {
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } }, ctx, async () => {});
  assert.equal(semanticWorkStatus(checked).pendingJobs, 0);
  for (const mutate of [
    (library: typeof checked) => { library.businessScenarios[0]!.conditions.push('Только для другого продукта'); },
    (library: typeof checked) => { library.requirements[0]!.text = 'Противоположное бизнес-правило'; },
    (library: typeof checked) => { library.imports[0]!.dialogues[0]!.events[0]!.content = 'Другой исходный запрос'; },
    (library: typeof checked) => { library.sources[0]!.content += '\nУ этого правила есть исключение.'; },
  ]) {
    const changed = structuredClone(checked); mutate(changed);
    assert.ok(semanticWorkStatus(changed).pendingJobs > 0, 'every changed input invalidates dependent receipts');
  }
});

test('complete work receipts still reduce admission after interruption before the final publication', async () => {
  const { assessScenarioLibrary, semanticWorkStatus } = await import('../src/scenario-work.js');
  let last = libraryFixture();
  await assessScenarioLibrary(last, { async assessScenarioProposals(input) {
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } }, ctx, async partial => { last = structuredClone(partial); });
  assert.equal(semanticWorkStatus(last).pendingJobs, 0, 'all calls were durably saved before the final reducer');
  const reduced = await assessScenarioLibrary(last, { async assessScenarioProposals() { throw new Error('A saved call must not repeat'); } }, ctx, async () => {});
  assert.equal(reduced.semanticAssessment!.contentHash, semanticContentHash(reduced));
  assert.ok(reduced.variants.every(variant => variant.quality === 'ready'), 'cached evidence is reduced into ready cards');
});

test('overall expected result has its own required source-grounded assessment and cannot hide behind valid checkpoints', async () => {
  const { assessScenarioLibrary, planSemanticWork, semanticWorkStatus } = await import('../src/scenario-work.js');
  const { acceptLibrary, libraryHash, libraryQuality, recordSemanticAssessment, compileLibrary } = await import('../src/scenario-library.js');
  const library = libraryFixture();
  const card = library.variants[0]!;
  card.evaluationSpec.successCriteria = 'Агент уточнил номер терминала и гарантировал возврат за три дня.';
  const plan = planSemanticWork(library);
  assert.equal(plan.jobs.flatMap(job => job.input.fields.flatMap(field => field.paths.filter(path => field.variantId === card.id && path === 'evaluationSpec.successCriteria'))).length, 1);
  const checked = await assessScenarioLibrary(library, { async assessScenarioProposals(input) {
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path,
      status: field.variantId === card.id && path === 'evaluationSpec.successCriteria' ? 'blocked' as const : 'ready' as const,
      reason: path === 'evaluationSpec.successCriteria' ? 'В источнике нет гарантии срока.' : 'Основание проверено.' })));
  } }, ctx, async () => {});
  assert.ok(libraryQuality(checked).some(issue => issue.path.endsWith('evaluationSpec.successCriteria') && issue.severity === 'blocked'));
  assert.throws(() => acceptLibrary(checked, libraryHash(checked), [card.id]), /готов/);
  checked.semanticAssessment!.findings = checked.semanticAssessment!.findings.filter(f => f.path !== 'evaluationSpec.successCriteria');
  assert.ok(libraryQuality(checked).some(issue => issue.code === 'semantic_missing' && issue.path.endsWith('evaluationSpec.successCriteria')));
  assert.equal(semanticWorkStatus(checked).needsFinalization, true, 'complete receipts cannot bypass missing final obligation');
  const historical = recordSemanticAssessment(library, library.variants.flatMap(v => semanticPaths(v, { includeOutcome: false }).map(path => ({ variantId: v.id, path, status: 'ready' as const, reason: 'Historical v10 result' }))), 10);
  const accepted = acceptLibrary(historical, libraryHash(historical), [card.id]), bytes = JSON.stringify(accepted);
  assert.equal(compileLibrary(accepted).length, 1, 'old acceptance remains executable, not silently regraded');
  assert.equal(JSON.stringify(accepted), bytes);
  assert.ok(semanticWorkStatus(accepted).pendingJobs > 0, 'an explicit new assessment must use the new obligation');
});

test('semantic requests exclude historical edit chatter and badges while retaining authenticated fact evidence', async () => {
  const { planSemanticWork } = await import('../src/scenario-work.js');
  const library = libraryFixture();
  library.variants[0]!.history.push({ author: 'assistant', reason: 'Старое предложение: ВЫДУМАННОЕ ПРАВИЛО, больше не актуально', revision: 2 });
  const plan = planSemanticWork(library);
  assert.ok(!JSON.stringify(plan.jobs).includes('ВЫДУМАННОЕ ПРАВИЛО'));
  for (const job of plan.jobs) {
    assert.ok(job.input.library.variants.every(v => !v.history.length && !v.issues.length));
    assert.ok(job.input.comparisonCandidates.every(v => !v.history.length));
  }
});
