import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourceIdentity } from '../src/normalize.js';
import { ExperimentLab, draftHash, measurementHash } from '../src/experiment.js';
import { createInputSchema, type Runtime } from '../src/contracts.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { acceptLibrary, importBatch, compileLibrary, editLibrary, libraryHash, libraryQuality } from '../src/scenario-library.js';
import { libraryFixture, proposals, rawDialogues, sources, requirements } from './helpers/scenario-library.js';

function semanticFindings(library: ReturnType<typeof libraryFixture>) {
  return library.variants.flatMap(variant => ['userState', ...variant.userState.facts.map(fact => `userState.facts.${fact.id}`), 'behaviorPolicy', 'environmentFixture', 'businessScenarioId', 'duplicates', ...variant.evaluationSpec.checkpoints.map(cp => `evaluationSpec.checkpoints.${cp.id}`)].map(path => ({ variantId: variant.id, path, status: 'ready', reason: 'Проверены смысл, хронология и применимость' })));
}
function runtimeFixture(payloads: any[]): Runtime {
  return {
    ...createDemoRuntime(),
    async openTarget() { return { async respond() { return 'Уточните номер терминала'; }, async close() {} }; },
    async userTurn({ user }) { payloads.push({ simulator: user }); return { done: true, message: '' }; },
    async prepare() { return { requirements: requirements.map(r => ({ ...r, sourceId: 'source-1' })), questions: [], agent: { name: 'Агент', instructions: 'Уточните номер терминала', tools: [] }, scenarios: [] }; },
    async scenarioProposals(input, ctx) {
      ctx.beforeCall(); payloads.push(structuredClone(input));
      return proposals(input.batchId).filter(p => input.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId));
    },
    async assessScenarioProposals(input, ctx) { ctx.beforeCall(); return input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Проверены смысл, хронология и применимость' }))); },
  } as Runtime;
}
const input = () => createInputSchema.parse({ task: 'Проверить возвраты', mode: 'demo', materials: sources.map(({ name, content }) => ({ name, content })), dialogues: rawDialogues, originalImport: importBatch(rawDialogues),
  scenarioCount: 0, validationCount: 1, settings: { maxCalls: 30 } });

test('full chronological preparation keeps original import, awaits real acceptance and compiles only initial facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-preparation-'));
  const payloads: any[] = [], lab = new ExperimentLab(directory, runtimeFixture(payloads));
  try {
    await lab.init();
    const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.get(seed.id);
    assert.ok(draft.librarySnapshot, 'new runtime prepares a library');
    assert.equal(draft.phase, 'review', draft.error ?? '');
    assert.deepEqual(payloads[1].dialogues[0].messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(payloads[1].dialogues[0].events.map((m: any) => m.index), [0, 1, 2]);
    assert.equal(draft.librarySnapshot.businessScenarios.length, 1);
    assert.equal(draft.librarySnapshot.variants.length, 2, 'requested run count must not truncate analysis');
    assert.equal(draft.scenarios.length, 0, 'preview never fabricates acceptance');
    assert.equal(draft.librarySnapshot.acceptance, undefined);
    await assert.rejects(() => lab.start(seed.id, { approved: true, expectedHash: draftHash(draft) }), /библиотек|принят/i);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(draft.librarySnapshot), ['variant_2']);
    assert.equal(accepted.library.variants.length, 2);
    assert.equal(accepted.experiment.scenarios.length, 1);
    assert.doesNotMatch(JSON.stringify(accepted.experiment.scenarios[0]!.user), /три дня/);
    assert.equal((await lab.store.readImport(draft.originalImport!.id)).dialogues.length, 2);
    assert.deepEqual(accepted.experiment.librarySnapshot!.imports[0]!.dialogues[1]!.original, rawDialogues[1]);
    assert.notEqual(draftHash(draft), draftHash(accepted.experiment));
    assert.notEqual(measurementHash(draft), measurementHash(accepted.experiment));
    const identity = sourceIdentity(accepted.experiment, ['variant_2']);
    assert.equal(identity.libraryHash, libraryHash(accepted.library));
    assert.equal(identity.importHash, accepted.experiment.originalImport!.contentHash);
    await assert.rejects(() => lab.updateDraft(seed.id, draftHash(accepted.experiment), { removeScenarioIds: ['variant_2'] }), /библиотек/i);
    await lab.start(seed.id, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
    assert.doesNotMatch(JSON.stringify(payloads.filter(p => p.simulator)), /три дня/);
    const repeated = await lab.repeat(seed.id, ['variant_2']);
    assert.deepEqual(repeated.librarySnapshot, accepted.experiment.librarySnapshot);
    assert.deepEqual(repeated.originalImport, draft.originalImport);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('semantic admission is separate from citations and is invalidated by facts and requirements edits', () => {
  const library = libraryFixture();
  Object.assign(library, { semanticRequired: true });
  assert.throws(() => acceptLibrary(library, libraryHash(library), ['variant_1']), /готов|смысл/i);
});

test('rich imports keep tool/state events and rejected rows before a legacy projection or selection', async () => {
  const imports = await import('../src/imports.js');
  assert.equal(typeof imports.importDialogues, 'function', 'raw ingestion returns batch alongside legacy projection');
  const imported = imports.importDialogues([
    { id: 'rich', observation: 'partial', events: [{ type: 'message', role: 'user', content: 'Нужна помощь' }, { type: 'tool', data: { name: 'lookup' } }, { type: 'state', data: { value: 17 } }, { type: 'message', role: 'assistant', content: 'Ответ' }] },
    { id: 'bad', messages: [{ role: 'other', content: 'Нет' }] },
  ]);
  assert.equal(imported.originalImport.dialogues[0]!.events.length, 4);
  assert.equal(imported.originalImport.rejected.length, 1);
  assert.deepEqual(imported.dialogues[0]!.messages.map(m => m.role), ['user', 'assistant']);
  const parsed = createInputSchema.parse({ ...input(), originalImport: imported.originalImport, dialogues: [] });
  assert.equal(parsed.originalImport!.dialogues.length, 1, 'rich evidence need not fit legacy cards');
});

test('cancellation preserves processed, excluded and pending without making a runnable draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-partial-'));
  const payloads: any[] = [];
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const runtime = runtimeFixture(payloads);
  const original = runtime.scenarioProposals!;
  runtime.scenarioProposals = async (value, ctx) => {
    if (value.dialogues[0]!.id !== 'terminal') {
      entered();
      await new Promise<void>((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
    }
    return original(value, ctx);
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const batch = importBatch([...rawDialogues, { id: 'bad', messages: [] }]);
    const seed = await lab.create({ ...input(), originalImport: batch });
    await blocked; await lab.cancel(seed.id); await lab.waitForIdle();
    const stopped = await lab.get(seed.id);
    assert.deepEqual(stopped.preparationProgress!.processed, ['terminal']);
    assert.deepEqual(stopped.preparationProgress!.pending, ['repeated']);
    assert.equal(stopped.preparationProgress!.excluded[0]!.dialogueId, 'bad');
    assert.equal(stopped.preparationProgress!.status, 'cancelled');
    assert.equal(stopped.librarySnapshot!.variants.length, 1);
    assert.equal(stopped.scenarios.length, 0);
    assert.equal((await lab.store.readImport(batch.id)).rejected.length, 1);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('owner correction invalidates semantic admission, reassessment binds new content and changed requirements cannot run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-owner-'));
  const lab = new ExperimentLab(directory, runtimeFixture([]));
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    const changed = await lab.editLibrary(seed.id, libraryHash(draft.library), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number',
      statement: 'Номер терминала: 4321', value: '4321', availability: 'initial', editId: 'owner_correction', reason: 'Владелец исправил номер' });
    assert.equal(changed.library.variants[0]!.userState.facts[0]!.origin.kind, 'owner');
    assert.ok(libraryQuality(changed.library).some(issue => issue.code === 'semantic_pending'));
    await assert.rejects(() => lab.acceptLibrary(seed.id, libraryHash(changed.library), ['variant_1']), /готов/);
    await lab.assessLibrary(seed.id, libraryHash(changed.library)); await lab.waitForIdle();
    const checked = await lab.readLibrary(seed.id);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(checked.library), ['variant_1']);
    assert.match(accepted.experiment.scenarios[0]!.user.facts, /4321/);
    const altered = structuredClone(accepted.experiment);
    altered.requirements[0]!.text = 'Другое требование';
    await lab.store.save(altered);
    await assert.rejects(() => lab.acceptDraft(seed.id, draftHash(altered)), /Требования/);
    await assert.rejects(() => lab.start(seed.id, { approved: true, expectedHash: draftHash(altered) }), /Требования/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('suite export/import preserves new identity and restores immutable imports in a different store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-suite-'));
  const lab = new ExperimentLab(join(directory, 'first'), runtimeFixture([]));
  const loadedLab = new ExperimentLab(join(directory, 'second'), runtimeFixture([]));
  try {
    await lab.init(); await loadedLab.init();
    const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(draft.library), ['variant_1', 'variant_2']);
    const file = await lab.saveSuite(seed.id, join(directory, 'suite.json'), ['variant_1']);
    const loaded = await loadedLab.loadSuite(file);
    assert.deepEqual(loaded.librarySnapshot, accepted.library);
    assert.deepEqual(loaded.selectedScenarioIds, ['variant_1']);
    assert.equal((await loadedLab.store.readImport(loaded.originalImport!.id)).dialogues.length, 2);
    assert.equal((await loadedLab.store.readLibrary(accepted.library.id, libraryHash(accepted.library))).variants.length, 2);
    assert.equal((await loadedLab.store.readLibrary(accepted.library.id)).revision, accepted.library.revision);
    await loadedLab.acceptDraft(loaded.id, draftHash(loaded));
  } finally { await lab.close(); await loadedLab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a semantic contradiction with a matching citation stays actionable and cannot be accepted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-semantic-'));
  const runtime = runtimeFixture([]);
  runtime.assessScenarioProposals = async ({ fields }) => fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready', reason: 'Проверено' }))).map(f => f.variantId === 'variant_1' && f.path === 'userState.facts.terminal_number'
    ? { ...f, status: 'needs_review', reason: 'Цитата совпадает, но применимость номера к этому запросу не доказана' } : f) as any;
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    assert.equal(draft.library.variants[0]!.quality, 'needs_review');
    assert.ok(draft.library.variants[0]!.issues.some(i => i.path.endsWith('userState.facts.terminal_number')));
    await assert.rejects(() => lab.acceptLibrary(seed.id, libraryHash(draft.library), ['variant_1']), /готов/);
    assert.equal(draft.experiment.scenarios.length, 0);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('budget exhaustion persists the exact unprocessed set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-budget-'));
  const runtime = runtimeFixture([]);
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const prepare = runtime.prepare; runtime.prepare = async (value, ctx) => { for (let i = 0; i < 4; i++) ctx.beforeCall(); return prepare(value, ctx); };
    const preparedInput = input(); preparedInput.settings.maxCalls = 5;
    const seed = await lab.create(preparedInput); await lab.waitForIdle();
    const result = await lab.get(seed.id);
    assert.deepEqual(result.preparationProgress!.processed, ['terminal']);
    assert.deepEqual(result.preparationProgress!.pending, ['repeated']);
    assert.equal(result.scenarios.length, 0);
    assert.ok(result.error);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('library run settings can change without using the legacy card editor or retaining draft approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-settings-'));
  const lab = new ExperimentLab(directory, runtimeFixture([]));
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.get(seed.id);
    const changed = await lab.updateDraft(seed.id, draftHash(draft), { settings: { repeats: 2 } });
    assert.equal(changed.settings.repeats, 2);
    assert.equal(changed.scenarios.length, 0);
    assert.equal(changed.librarySnapshot!.acceptance, undefined);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(changed.librarySnapshot!), ['variant_1']);
    const updated = await lab.updateDraft(seed.id, draftHash(accepted.experiment), { settings: { repeats: 3 } });
    assert.equal(updated.acceptedDraftHash, undefined);
    assert.equal(updated.librarySnapshot!.acceptance!.snapshotHash, accepted.library.acceptance!.snapshotHash);
    await assert.rejects(() => lab.setExpectation(seed.id, draftHash(updated), 'variant_1', 'Изменение'), /библиотек/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('criteria reassessment and positive controls cannot silently change accepted library cards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-gate-'));
  const lab = new ExperimentLab(directory, runtimeFixture([]));
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(draft.library), ['variant_1']);
    await lab.start(seed.id, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
    await assert.rejects(() => lab.reassess(seed.id, { criteria: [{ scenarioId: 'variant_1', successCriteria: 'Другое ожидание' }], codeOnly: true }), /библиотек/);
    await assert.rejects(() => lab.repeat(seed.id, ['variant_1'], ['variant_1']), /библиотек/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the core preserves raw dialogue text before schema normalization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-raw-'));
  const runtime = runtimeFixture([]);
  runtime.scenarioProposals = async () => [];
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const raw = { ...input(), originalImport: undefined, dialogues: [{ id: 'raw', messages: [{ role: 'user', content: '  Исходный текст  ' }] }] };
    const seed = await lab.create(raw as any); await lab.waitForIdle();
    const record = await lab.get(seed.id);
    const batch = await lab.store.readImport(record.originalImport!.id);
    assert.equal(batch.dialogues[0]!.events[0]!.content, '  Исходный текст  ');
    assert.deepEqual(batch.dialogues[0]!.original, raw.dialogues[0]);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reassessing an accepted library clears per-variant owner decisions as well as the receipt', async () => {
  const { recordSemanticAssessment } = await import('../src/scenario-library.js');
  const draft = libraryFixture(), accepted = acceptLibrary(draft, libraryHash(draft), ['variant_1']);
  const reassessed = recordSemanticAssessment(accepted, semanticFindings(accepted) as any);
  assert.equal(reassessed.acceptance, undefined);
  assert.ok(reassessed.variants.every(v => v.ownerDecision === 'pending'));
});

test('reopening completes a journaled library edit after a one-shot experiment write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-recovery-'));
  const lab = new ExperimentLab(directory, runtimeFixture([]));
  const reopened = new ExperimentLab(directory, runtimeFixture([]));
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const before = await lab.readLibrary(seed.id);
    const store = lab.store as any, save = store.saveRecord.bind(store);
    let fail = true;
    store.saveRecord = async (...args: unknown[]) => {
      if (fail) { fail = false; throw Object.assign(new Error('one-shot experiment write failure'), { code: 'EIO' }); }
      return save(...args);
    };
    await assert.rejects(() => lab.editLibrary(seed.id, libraryHash(before.library), { kind: 'remove_variant', variantId: 'variant_2', reason: 'Выбран первый' }), /one-shot/);
    assert.equal((await lab.store.readLibrary(before.library.id)).variants.length, 1);
    assert.equal((await lab.readLibrary(seed.id)).library.variants.length, 2);
    await lab.close(); await reopened.init();
    const recovered = await reopened.readLibrary(seed.id);
    assert.equal(recovered.library.variants.length, 1, 'valid B publication finishes through the public reopen path');
    await assert.rejects(() => reopened.editLibrary(seed.id, libraryHash(before.library), { kind: 'remove_variant', variantId: 'variant_1', reason: 'Устаревшая правка' }), /хеш|измен/);
    const changed = await reopened.editLibrary(seed.id, libraryHash(recovered.library), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number',
      statement: 'Номер терминала: 4321', value: '4321', availability: 'initial', editId: 'after_recovery', reason: 'После восстановления' });
    assert.equal(changed.library.variants[0]!.userState.facts[0]!.value, '4321');
  } finally { await lab.close(); await reopened.close(); await rm(directory, { recursive: true, force: true }); }
});

test('extraction receives bounded deterministic repair feedback and prior business context without changing evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-repair-'));
  const runtime = runtimeFixture([]), requests: any[] = [];
  runtime.scenarioProposals = async (request, ctx) => {
    ctx.beforeCall(); requests.push(structuredClone(request));
    const proposal = proposals(request.batchId).find(p => p.variant.sourceDialogues[0]!.dialogueId === request.dialogues[0]!.id)!;
    if (request.dialogues[0]!.id === 'terminal' && !request.feedback) {
      proposal.variant.environmentFixture.initialState = { records: [], writableFields: [] } as any;
      proposal.variant.userState.facts[0]!.statement = 'Номер терминала';
    }
    return [proposal] as any;
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const repaired = await lab.readLibrary(seed.id);
    assert.equal(requests.length, 3, 'malformed model proposal gets one bounded repair call');
    assert.ok(requests[1].feedback.issues.some((issue: any) => issue.code === 'invalid_environment'));
    assert.ok(requests[1].feedback.issues.some((issue: any) => issue.code === 'fact_value_mismatch'));
    assert.equal(requests[2].businessCatalog.length, 1, 'later source sees the existing business goal and conditions');
    assert.equal(repaired.library.businessScenarios.length, 1);
    assert.equal(repaired.library.variants[0]!.quality, 'ready');
    for (const request of requests) assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 64000);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('near-limit rich evidence is sent whole and an oversized dialogue is retained pending with a reason', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-rich-envelope-'));
  const raw = [50_000, 120_000].map((size, i) => ({ id: i ? 'huge' : 'near', observation: 'partial', events: [
    { type: 'message', role: 'user', content: 'Номер терминала: 1234' },
    { type: 'tool', payload: 'x'.repeat(size) }, { type: 'message', role: 'assistant', content: 'Уточнение' },
  ] }));
  const batch = importBatch(raw), requests: any[] = [];
  const runtime = runtimeFixture([]);
  runtime.scenarioProposals = async request => {
    requests.push(structuredClone(request));
    const p = proposals(request.batchId)[0]!;
    p.variant.sourceDialogues[0]!.dialogueId = 'near';
    p.variant.userState.facts[0]!.origin.dialogueId = 'near';
    return [p] as any;
  };
  const assess = runtime.assessScenarioProposals!;
  runtime.assessScenarioProposals = async (request, ctx) => {
    requests.push(structuredClone(request));
    return assess(request, ctx);
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create({ ...input(), originalImport: batch, dialogues: [] }); await lab.waitForIdle();
    const result = await lab.get(seed.id);
    assert.equal(result.phase, 'review', result.error ?? '');
    assert.deepEqual(result.preparationProgress!.processed, ['near']);
    assert.deepEqual(result.preparationProgress!.pending, ['huge']);
    assert.match(result.preparationProgress!.excluded.find(e => e.dialogueId === 'huge')!.reason, /байт|предел/);
    for (const request of requests) assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 64000);
    assert.equal(requests[0].dialogues[0].events[1].data.payload.length, 50000);
    assert.equal(requests.find(r => r.scope === 'fields').library.imports[0].dialogues[0].events[1].data.payload.length, 50000);
    assert.equal(result.librarySnapshot!.imports[0]!.dialogues[1]!.events[1]!.data.payload.length, 120000);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('late independent personal disclosure is repaired as initial knowledge without leaking an old assistant duration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-disclosure-'));
  const raw = [rawDialogues[0], { id: 'late', messages: [{ role: 'user', content: 'Когда будет возврат?' }, { role: 'assistant', content: 'Назовите номер терминала' }, { role: 'user', content: 'Номер терминала: 5678' }] }];
  const batch = importBatch(raw), runtime = runtimeFixture([]); let repaired = false;
  runtime.scenarioProposals = async (request, ctx) => {
    ctx.beforeCall();
    const p = proposals(batch.id)[0]!;
    if (request.dialogues[0]!.id === 'late') {
      p.variant.id = 'late_variant'; p.variant.sourceDialogues[0]!.dialogueId = 'late';
      Object.assign(p.variant.userState.facts[0]!, { statement: 'Номер терминала: 5678', value: '5678', availability: request.feedback ? 'initial' : 'learned_in_source',
        origin: { kind: 'dialogue', batchId: batch.id, dialogueId: 'late', eventIndex: 2, quote: 'Номер терминала: 5678' } });
      p.variant.behaviorPolicy.actions.push({ id: 'give_id', kind: 'answer', factIds: ['terminal_number'], payload: '5678', ifAsked: 'Номер терминала?' } as any);
      p.variant.behaviorPolicy.transitions.unshift({ from: 'waiting', to: 'waiting', actionId: 'give_id', when: 'Агент запросил номер терминала' });
      if (request.feedback) { repaired = true; assert.ok(request.feedback.issues.some(i => i.code === 'excluded_fact_action')); }
    }
    return [p] as any;
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create({ ...input(), originalImport: batch, dialogues: [] }); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    assert.ok(repaired); assert.equal(draft.library.businessScenarios.length, 1);
    const late = draft.library.variants.find(v => v.id === 'late_variant')!;
    assert.equal(late.quality, 'ready'); assert.equal(late.userState.facts[0]!.availability, 'initial');
    assert.equal(late.userState.facts[0]!.origin.kind, 'dialogue'); assert.doesNotMatch(late.userState.opening, /5678/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('public assessment resumes interrupted same-content work from a reviewable partial library', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-resume-'));
  const runtime = runtimeFixture([]), original = runtime.assessScenarioProposals!;
  const completed: string[] = []; let calls = 0, fail = true;
  runtime.assessScenarioProposals = async (value, ctx) => {
    if (++calls === 2 && fail) throw new Error('temporary semantic transport failure');
    const signature = JSON.stringify(value.fields) + JSON.stringify(value.comparisonCandidates);
    assert.ok(!completed.includes(signature), 'completed same-content work is not requested again');
    const result = await original(value, ctx); completed.push(signature); return result;
  };
  let lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const partial = await lab.get(seed.id);
    assert.equal(partial.phase, 'review', 'partial library remains editable and assessable');
    assert.match(partial.error!, /temporary semantic/);
    assert.ok(partial.librarySnapshot!.semanticAssessment!.findings.length > 0);
    await lab.close(); fail = false; lab = new ExperimentLab(directory, runtime); await lab.init();
    await lab.assessLibrary(seed.id, libraryHash(partial.librarySnapshot!)); await lab.waitForIdle();
    const done = await lab.get(seed.id); assert.equal(done.phase, 'review');
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(done.librarySnapshot!), ['variant_1', 'variant_2']);
    assert.equal(accepted.experiment.scenarios.length, 2);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
