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
    async assessScenarioProposals(input, ctx) { ctx.beforeCall(); return semanticFindings(input.library); },
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
  runtime.assessScenarioProposals = async ({ library }) => semanticFindings(library).map(f => f.variantId === 'variant_1' && f.path === 'userState.facts.terminal_number'
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
