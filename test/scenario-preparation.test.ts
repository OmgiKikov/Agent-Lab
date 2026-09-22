import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourceIdentity } from '../src/normalize.js';
import { ExperimentLab, draftHash, measurementHash } from '../src/experiment.js';
import { createInputSchema, type Runtime } from '../src/contracts.js';
import { createDemoRuntime, demoInput, demoTarget } from '../src/demo.js';
import { acceptLibrary, importBatch, compileLibrary, editLibrary, libraryHash, libraryQuality } from '../src/scenario-library.js';
import { libraryFixture, proposals as legacyProposals, rawDialogues, sources, requirements } from './helpers/scenario-library.js';

function proposals(batchId: string) {
  return legacyProposals(batchId).map(proposal => ({ ...proposal, variant: { ...proposal.variant,
    ...(proposal.variant.sourceDialogues[0]?.dialogueId === 'repeated' ? { sourceCoverage: [{ batchId, dialogueId: 'repeated', eventIndex: 2,
      disposition: 'omitted' as const, actionIds: [], factIds: [], reason: 'Переспрос неподтверждённого срока старого агента не становится исходным знанием клиента.' }] } : {}),
  } }));
}

function semanticFindings(library: ReturnType<typeof libraryFixture>) {
  return library.variants.flatMap(variant => ['userState', ...variant.userState.facts.map(fact => `userState.facts.${fact.id}`), 'behaviorPolicy', 'environmentFixture', ...(variant.sourceCoverageRequired || variant.sourceCoverage?.length ? ['sourceCoverage'] : []), 'businessScenarioId', 'duplicates', ...variant.evaluationSpec.checkpoints.map(cp => `evaluationSpec.checkpoints.${cp.id}`)].map(path => ({ variantId: variant.id, path, status: 'ready', reason: 'Проверены смысл, хронология и применимость' })));
}
function runtimeFixture(payloads: any[]): Runtime {
  return {
    ...createDemoRuntime(),
    async userTurn({ user }) { payloads.push({ simulator: user }); return { done: true, message: '' }; },
    async groundRequirements() { return { requirements: requirements.map(r => ({ ...r, sourceId: 'source-1' })), questions: [] }; },
    async scenarioProposals(input, ctx) {
      ctx.beforeCall(); payloads.push(structuredClone(input));
      return proposals(input.batchId).filter(p => input.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId));
    },
    async assessScenarioProposals(input, ctx) { ctx.beforeCall(); return input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Проверены смысл, хронология и применимость' }))); },
  } as Runtime;
}
const input = () => createInputSchema.parse({ task: 'Проверить возвраты', mode: 'demo', materials: sources.map(({ name, content }) => ({ name, content })), dialogues: rawDialogues, originalImport: importBatch(rawDialogues),
  scenarioCount: 0, target: demoTarget(), settings: { maxCalls: 30 } });

test('a preparation that died during a paid call is not silently repeated', async () => {
  const { resumeScenarioLibrary } = await import('../src/scenario-preparation.js');
  const library = libraryFixture();
  const record = { id: 'run', preparationProgress: { protocol: 'chronological-scenarios-v1', processed: ['terminal'], pending: ['repeated'], excluded: [], status: 'partial', activeDialogueId: 'repeated' }, librarySnapshot: library } as never;
  await assert.rejects(() => resumeScenarioLibrary(record, input(), undefined, runtimeFixture([]), { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, {} as never), /стоимость неизвестна/);
});

test('transport corrections and domain repair share a persisted per-source attempt allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-shared-attempts-'));
  const runtime = runtimeFixture([]), generate = runtime.scenarioProposals!;
  let spent = 0;
  runtime.scenarioProposals = async (request, context) => {
    if (request.dialogues[0]!.id !== 'terminal') return generate(request, context);
    // Simulate three completed provider attempts inside the structured-response runtime.
    for (let i = 0; i < 3; i++) { context.beforeCall(); spent++; }
    const proposal = proposals(request.batchId)[0]!;
    proposal.variant.evaluationSpec.checkpoints[0]!.requirementId = 'absent_requirement';
    return [proposal];
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const partial = await lab.readLibrary(seed.id);
    assert.equal(spent, 5, 'a domain retry cannot grant another five transport retries');
    assert.equal(partial.experiment.preparationProgress!.activeDialogueId, undefined, 'allowance exhaustion did not dispatch an ambiguous call');
    assert.ok(partial.experiment.preparationProgress!.pending.includes('terminal'));
    assert.ok(partial.library.variants.some(card => card.id === 'variant_2'), 'unrelated sources still finish');
    assert.deepEqual(partial.experiment.preparationProgress!.generationAttempts?.find(item => item.dialogueId === 'terminal'), { dialogueId: 'terminal', calls: 5 });
    await lab.resumePreparation(seed.id, libraryHash(partial.library)); await lab.waitForIdle();
    assert.equal(spent, 5, 'resuming cannot reset the per-source allowance');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('public preparation resume uses CAS, preserves owner edits and histories, and only extracts pending dialogues', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-preparation-resume-'));
  const runtime = runtimeFixture([]), generate = runtime.scenarioProposals!;
  let unavailable = true;
  const requested: string[] = [];
  runtime.scenarioProposals = async (request, context) => {
    const id = request.dialogues[0]!.id; requested.push(id);
    if (id === 'repeated' && unavailable) throw new Error('No provider call was started');
    return generate(request, context);
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const partial = await lab.readLibrary(seed.id);
    assert.deepEqual(partial.experiment.preparationProgress!.pending, ['repeated']);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(partial.library), ['variant_1']);
    await assert.rejects(lab.resumePreparation(seed.id, libraryHash(accepted.library)), /Принятый/);
    const edited = await lab.editLibrary(seed.id, libraryHash(accepted.library), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number',
      statement: 'Номер терминала: 5678', value: '5678', availability: 'initial', editId: 'owner_resume', reason: 'Владелец уточнил номер' });
    const before = structuredClone(edited.library.variants[0]!);
    const calls = edited.experiment.usage.calls;
    await assert.rejects(lab.resumePreparation(seed.id, libraryHash(partial.library)), /хеш устарел/);
    unavailable = false; requested.length = 0;
    await lab.resumePreparation(seed.id, libraryHash(edited.library)); await lab.waitForIdle();
    const result = await lab.get(seed.id);
    assert.equal(result.error, null);
    assert.deepEqual(requested, ['repeated']);
    assert.deepEqual(result.preparationProgress!.pending, []);
    assert.equal(result.librarySnapshot!.variants.length, 2);
    const original = result.librarySnapshot!.variants.find(variant => variant.id === before.id)!;
    assert.deepEqual(original.history, before.history);
    assert.deepEqual(original.userState, before.userState);
    assert.equal(original.businessScenarioId, before.businessScenarioId);
    assert.equal(original.revision, before.revision);
    assert.equal(original.familyId, before.familyId);
    assert.equal(original.userState.facts[0]!.origin.kind, 'owner');
    assert.ok(result.usage.calls > calls);
    assert.equal(result.librarySnapshot!.acceptance, undefined);
    assert.equal(result.trials.length, 0);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed paid extraction keeps its active marker and cannot be repeated by resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-preparation-unknown-call-'));
  const runtime = runtimeFixture([]), generate = runtime.scenarioProposals!;
  let calls = 0;
  runtime.scenarioProposals = async (request, context) => {
    if (request.dialogues[0]!.id !== 'repeated') return generate(request, context);
    context.beforeCall(); calls++; throw new Error('Provider disconnected after accepting the request');
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const partial = await lab.readLibrary(seed.id);
    assert.equal(partial.experiment.preparationProgress!.activeDialogueId, 'repeated');
    assert.equal(partial.experiment.preparationProgress!.activeStage, 'extract');
    await assert.rejects(lab.resumePreparation(seed.id, libraryHash(partial.library)), /стоимость неизвестна/);
    assert.equal(calls, 1);
    assert.equal(partial.library.variants.length, 1, 'the previously generated case remains reviewable');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an observe action is a customer sentence and does not need an initial fact', async () => {
  const { libraryQuality } = await import('../src/scenario-library.js');
  const { requiredUserTurns } = await import('../src/user-controller.js');
  const library = libraryFixture();
  const variant = library.variants[0]!;
  variant.behaviorPolicy.actions.push({ id: 'screen', kind: 'observe', factIds: [], payload: 'Не вижу терминал на экране' });
  variant.behaviorPolicy.transitions.push({ from: 'waiting', to: 'waiting', actionId: 'screen', when: 'Агент отправил клиента к экрану терминала' });
  assert.equal(libraryQuality(library).some(issue => issue.code === 'invalid_policy' && issue.message.includes('Наблюдение')), false);
  assert.ok(requiredUserTurns(variant.behaviorPolicy, variant.userState.facts.filter(fact => fact.availability === 'initial')) >= 1);
  variant.behaviorPolicy.actions.find(action => action.id === 'screen')!.factIds = ['terminal_number'];
  assert.ok(libraryQuality(library).some(issue => issue.message.includes('Наблюдение')));
});

test('semantic findings get one automatic repair with the same variant identities, followed by fresh assessment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-semantic-repair-'));
  const runtime = runtimeFixture([]), seen: any[] = [];
  runtime.scenarioProposals = async request => {
    seen.push(structuredClone(request));
    return proposals(request.batchId).filter(p => request.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId)).map(p => {
      if (!request.feedback) p.variant.userState.goal = 'Неподтверждённая цель';
      return p;
    });
  };
  runtime.assessScenarioProposals = async request => request.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path,
    status: path === 'userState' && request.library.variants.find(v => v.id === f.variantId)?.userState.goal === 'Неподтверждённая цель' ? 'blocked' as const : 'ready' as const,
    reason: 'Цель должна соответствовать исходному запросу' })));
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle(); const result = await lab.get(seed.id);
    assert.equal(result.error, null);
    assert.equal(seen.filter(r => r.feedback?.issues.some((i: any) => i.code === 'semantic_finding')).length, 2);
    assert.deepEqual(result.librarySnapshot!.variants.map(v => v.id), ['variant_1', 'variant_2']);
    assert.ok(result.librarySnapshot!.variants.every(v => v.quality === 'ready'));
    assert.equal(result.librarySnapshot!.acceptance, undefined);
    assert.equal(result.scenarios.length, 0);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an empty semantic repair cannot delete a blocked case or restart an unbounded repair loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-empty-repair-'));
  const runtime = runtimeFixture([]), generate = runtime.scenarioProposals!;
  let repairs = 0;
  runtime.scenarioProposals = async (request, ctx) => {
    if (request.feedback?.issues.some(i => i.code === 'semantic_finding')) { repairs++; return []; }
    return generate(request, ctx);
  };
  runtime.assessScenarioProposals = async request => request.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path,
    status: path === 'userState' ? 'blocked' as const : 'ready' as const, reason: 'Недостаточно оснований для цели' })));
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle(); const result = await lab.get(seed.id);
    assert.equal(result.error, null);
    assert.equal(repairs, 2);
    assert.equal(result.librarySnapshot!.variants.length, 2);
    assert.ok(result.librarySnapshot!.variants.every(v => v.quality === 'blocked'));
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('large Russian articles fit the byte budget and the same article is grounded separately for each customer question', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-real-kb-budget-'));
  const runtime = runtimeFixture([]), groundings: any[] = [], requests: any[] = [];
  const quotes = ['Уточните номер терминала.', 'Уточните причину возврата.'];
  runtime.selectSources = async () => ({ sourceIds: ['source-2', 'source-3'] });
  runtime.groundRequirements = async request => {
    groundings.push(structuredClone(request));
    const index = groundings.length - 1;
    return { requirements: [{ id: `rule_${index}`, sourceId: 'source-2', quote: quotes[index]!, text: quotes[index]!, critical: false }], questions: [] };
  };
  runtime.scenarioProposals = async request => { requests.push(structuredClone(request)); return []; };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const seed = await lab.create({ ...input(), materials: [
      { name: 'Другая статья', content: 'Описание '.repeat(2500) },
      { name: 'Терминал и возврат', content: quotes.join('\n') + '\n' + 'я'.repeat(11900) },
      { name: 'Дополнительная статья', content: 'ю'.repeat(12000) },
    ] });
    await lab.waitForIdle(); const result = await lab.get(seed.id);
    assert.equal(result.error, null);
    assert.equal(groundings.length, 2, 'each focus needs its own grounding even when source ids match');
    assert.deepEqual(groundings.map(r => r.focus.dialogueId), ['terminal', 'repeated']);
    assert.deepEqual(result.preparationProgress!.sourceSelection!.map(s => s.sourceIds), [['source-2'], ['source-2']]);
    assert.deepEqual(requests.map(r => r.requirements.map((v: any) => v.id)), [['rule_0'], ['rule_1']], 'rules from another focus stay out of this request');
    for (const request of [...groundings, ...requests]) assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 64000);
    assert.equal(result.requirements.length, 2, 'the record retains both grounded rules');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the same quote with a different focused meaning does not reuse an earlier requirement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-rule-meaning-'));
  const runtime = runtimeFixture([]), focused: string[][] = [];
  const quote = 'Перед изменением уточните данные; при консультации номер не обязателен.';
  let count = 0;
  runtime.selectSources = async () => ({ sourceIds: ['source-1'] });
  runtime.groundRequirements = async () => ({ requirements: [{ id: 'rule', sourceId: 'source-1', quote,
    text: ++count === 1 ? 'Перед изменением уточните данные.' : 'При консультации номер не обязателен.', critical: true }], questions: [] });
  runtime.scenarioProposals = async request => { focused.push(request.requirements.map(r => r.id)); return []; };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create({ ...input(), materials: [{ name: 'Правило', content: quote }, { name: 'Большая база', content: 'я'.repeat(40000) }] });
    await lab.waitForIdle(); const result = await lab.get(seed.id);
    assert.equal(result.error, null);
    assert.deepEqual(focused, [['rule'], ['rule_2']]);
    assert.equal(result.requirements.length, 2);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('full chronological preparation keeps original import, awaits real acceptance and compiles only initial facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-preparation-'));
  const payloads: any[] = [], lab = new ExperimentLab(directory, runtimeFixture(payloads));
  try {
    await lab.init();
    const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.get(seed.id);
    assert.ok(draft.librarySnapshot, 'new runtime prepares a library');
    assert.equal(draft.phase, 'review', draft.error ?? '');
    assert.equal(draft.error, null, draft.error ?? '');
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
    await assert.rejects(() => lab.updateDraft(seed.id, draftHash(accepted.experiment), { removeScenarioIds: ['variant_2'] } as never), /removeScenarioIds/, 'a draft patch cannot carry cards: they change only in the library');
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
  const runtime = runtimeFixture([]), assess = runtime.assessScenarioProposals!;
  let ownerEvidenceSeen = false;
  runtime.assessScenarioProposals = async (request, ctx) => {
    if (request.library.variants.some(v => v.userState.facts.some(f => f.origin.kind === 'owner'))) {
      assert.ok(request.ownerFactEvidence.some(e => e.variantId === 'variant_1' && e.factId === 'terminal_number' && e.editId === 'owner_correction' && e.status === 'verified'));
      ownerEvidenceSeen = true;
    }
    return assess(request, ctx);
  };
  const lab = new ExperimentLab(directory, runtime);
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
    assert.equal(ownerEvidenceSeen, true, 'public edit/reassessment passes authenticated owner evidence');
    const altered = structuredClone(accepted.experiment);
    altered.requirements[0]!.text = 'Другое требование';
    await lab.store.save(altered);
    await assert.rejects(() => lab.acceptDraft(seed.id, draftHash(altered)), /Требования/);
    await assert.rejects(() => lab.start(seed.id, { approved: true, expectedHash: draftHash(altered) }), /Требования/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('targeted variants publish through the owning writer and preserve the accepted revision as immutable history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-targeted-'));
  const lab = new ExperimentLab(directory, runtimeFixture([]));
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(draft.library), ['variant_1']);
    const acceptedHash = libraryHash(accepted.library);
    const result = await lab.proposeVariant(seed.id, acceptedHash, {
      parentId: 'variant_1', operation: 'ambiguous_opening', reason: 'Проверить неоднозначное начало', input: { opening: 'Помогите с этим' },
    });
    assert.equal(result.experiment.scenarios.length, 0, 'новую ревизию нужно принять отдельно');
    assert.equal(result.library.acceptance, undefined);
    assert.equal(result.variant.history.at(-1)?.author, 'generator');
    assert.deepEqual((await lab.store.readLibrary(accepted.library.id, acceptedHash)).acceptance, accepted.library.acceptance);
    await assert.rejects(() => lab.proposeVariant(seed.id, acceptedHash, {
      parentId: 'variant_1', operation: 'ambiguous_opening', reason: 'Устаревшая правка', input: { opening: 'Ещё одно начало' },
    }), /хеш|измен/i);
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
    const ground = runtime.groundRequirements!; runtime.groundRequirements = async (value, ctx) => { for (let i = 0; i < 4; i++) ctx.beforeCall(); return ground(value, ctx); };
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
    await assert.rejects(() => lab.updateDraft(seed.id, draftHash(updated), { scenarios: [] } as never), /scenarios/, 'expectations change only in the library, never through the draft');
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
      p.variant.sourceCoverage = [{ batchId: batch.id, dialogueId: 'late', eventIndex: 2, disposition: 'initial_fact', actionIds: [], factIds: ['terminal_number'], reason: 'Личный номер известен заранее и сообщается после вопроса агента.' }] as any;
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

/** Thirty articles of four thousand characters each: far beyond one model call, the size of a real knowledge base. */
function bigKnowledgeBase() {
  const titles = ['Как оформить возврат покупателю', 'Как посмотреть тариф', 'Заблокирован терминал', 'Подключение интернет-эквайринга'];
  return [
    { name: 'prompt.md', kind: 'prompt' as const, content: 'Уточните номер терминала. Отвечайте клиенту вежливо.' },
    ...Array.from({ length: 30 }, (_, i) => ({ name: titles[i] ?? `Статья ${i + 1}`, content: `Статья ${i + 1}. ${'Порядок действий описан в личном кабинете. '.repeat(90)}` })),
  ];
}

test('a knowledge base too large for one call is read per dialogue: the model picks articles from the table of contents, grounding and proposals see only those, and the choice is recorded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-preparation-'));
  const catalogs: any[] = [], groundings: string[][] = [], proposalSources: string[][] = [], proposalRequirements: string[][] = [];
  const runtime: Runtime = {
    ...runtimeFixture([]),
    async selectSources(input, ctx) {
      ctx.beforeCall(); catalogs.push(structuredClone(input));
      const wanted = input.dialogue.messages[0]!.content.includes('терминала') ? 'Заблокирован терминал' : 'Как оформить возврат покупателю';
      return { sourceIds: [input.catalog.find(item => item.name === wanted)!.id] };
    },
    async groundRequirements(input) {
      groundings.push(input.sources.map(source => source.id));
      return { questions: [],
        requirements: input.sources.map(source => ({ id: source.kind === 'prompt' ? 'terminal_rule' : `rule_${source.id}`, sourceId: source.id, critical: true,
          text: source.kind === 'prompt' ? 'Уточните номер терминала' : 'Порядок действий описан в личном кабинете', quote: source.kind === 'prompt' ? 'Уточните номер терминала' : 'Порядок действий описан в личном кабинете.' })) };
    },
    async scenarioProposals(input, ctx) {
      ctx.beforeCall(); proposalSources.push(input.sources.map(source => source.id)); proposalRequirements.push(input.requirements.map(requirement => requirement.id));
      return proposals(input.batchId!).filter(p => input.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId));
    },
  } as Runtime;
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const seed = await lab.create({ ...input(), materials: bigKnowledgeBase() }); await lab.waitForIdle();
    const draft = await lab.get(seed.id);
    assert.equal(draft.phase, 'review', draft.error ?? '');
    assert.equal(draft.error, null, draft.error ?? '');
    assert.equal(draft.preparationProgress!.excluded.length, 0, JSON.stringify(draft.preparationProgress!.excluded));
    assert.equal(catalogs.length, 4, 'title selection and bounded article review per dialogue');
    assert.ok(catalogs.every(c => c.dialogue.messages.every((m: any) => m.role === 'user')));
    assert.ok(catalogs[1].reading.sources.length);
    assert.ok(catalogs[3].reading.sources.length);
    assert.equal(catalogs[0].catalog.length, 30, 'the table of contents lists knowledge articles only');
    assert.deepEqual(Object.keys(catalogs[0].catalog[0]).sort(), ['chars', 'id', 'name'], 'the initial catalog carries titles; the second pass receives a separate bounded reading');
    assert.deepEqual(groundings, [['source-1', 'source-4'], ['source-1', 'source-2']], 'grounding runs per dialogue on the prompt plus the chosen article');
    assert.deepEqual(proposalSources, groundings, 'proposals see exactly what grounding saw');
    assert.deepEqual(proposalRequirements, [['terminal_rule', 'rule_source-4'], ['terminal_rule', 'rule_source-2']]);
    assert.deepEqual(draft.requirements.map(r => r.id), ['terminal_rule', 'rule_source-4', 'rule_source-2'], 'the record keeps the union, each rule once');
    assert.deepEqual(draft.preparationProgress!.sourceSelection, [{ dialogueId: 'terminal', sourceIds: ['source-4'] }, { dialogueId: 'repeated', sourceIds: ['source-2'] }]);
    assert.equal(draft.sources.length, 31, 'the record keeps every article');
    assert.equal(draft.librarySnapshot!.variants.length, 2);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('when the model finds no article for a dialogue in a large knowledge base, the dialogue is set aside with that reason instead of being graded against nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-preparation-'));
  const runtime: Runtime = { ...runtimeFixture([]), async selectSources() { return { sourceIds: [] }; } } as Runtime;
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const seed = await lab.create({ ...input(), materials: bigKnowledgeBase() }); await lab.waitForIdle();
    const draft = await lab.get(seed.id);
    assert.equal(draft.phase, 'review', draft.error ?? '');
    assert.equal(draft.error, null, draft.error ?? '');
    assert.deepEqual(draft.preparationProgress!.excluded.map(e => e.dialogueId), ['terminal', 'repeated']);
    assert.match(draft.preparationProgress!.excluded[0]!.reason, /статьи/);
    assert.equal(draft.librarySnapshot!.variants.length, 0);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the articles chosen for one dialogue are kept within the call budget, in the model’s order of importance, and the kept list is what gets recorded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-preparation-'));
  const groundings: string[][] = [];
  const runtime: Runtime = {
    ...runtimeFixture([]),
    async selectSources(input, ctx) { ctx.beforeCall(); return { sourceIds: input.catalog.slice(0, 5).map(item => item.id) }; },
    async groundRequirements(input) {
      groundings.push(input.sources.map(source => source.id));
      const dialogue = rawDialogues.find(d => d.id === input.focus?.dialogueId)!;
      assert.deepEqual(input.focus, { dialogueId: dialogue.id, customerMessages: dialogue.messages.filter(m => m.role === 'user').map(m => m.content) }, 'grounding carries this customer’s words only');
      return { questions: [],
        requirements: input.sources.map(source => ({ id: source.kind === 'prompt' ? 'terminal_rule' : `rule_${source.id}`, sourceId: source.id, critical: true,
          text: 'Уточните номер терминала', quote: 'Уточните номер терминала' })) };
    },
  } as Runtime;
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const materials = [{ name: 'prompt.md', kind: 'prompt' as const, content: 'Уточните номер терминала. Отвечайте клиенту вежливо.' },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `Статья ${i + 1}`, content: `Уточните номер терминала. ${'Порядок действий описан в личном кабинете. '.repeat(270)}`.slice(0, 12000) }))];
    const seed = await lab.create({ ...input(), materials }); await lab.waitForIdle();
    const draft = await lab.get(seed.id);
    assert.equal(draft.phase, 'review', draft.error ?? '');
    assert.equal(draft.error, null, draft.error ?? '');
    assert.deepEqual(groundings, [['source-1', 'source-2'], ['source-1', 'source-2']], 'one Russian article fits the byte budget per focus');
    assert.deepEqual(draft.preparationProgress!.sourceSelection![0], { dialogueId: 'terminal', sourceIds: ['source-2'] });
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed source remains pending with its error while unrelated cards finish, and real role evidence survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-evidence-'));
  const runtime = runtimeFixture([]), extract = runtime.scenarioProposals!;
  runtime.scenarioProposals = async (request, ctx) => {
    if (request.dialogues[0]!.id === 'terminal') {
      ctx.beforeCall();
      ctx.onGeneratorOutput?.({ role: 'extraction', text: '{broken', attempt: 1 });
      ctx.onGeneratorValidation?.({ attempt: 1, accepted: false, reason: 'Malformed JSON' });
      throw new (await import('../src/generator-errors.js')).InvalidGeneratorResponse('Malformed JSON');
    }
    return extract(request, ctx);
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    const draft = await lab.get(seed.id);
    assert.equal(draft.error, null);
    assert.deepEqual(draft.preparationProgress!.pending, ['terminal']);
    assert.deepEqual(draft.preparationProgress!.processed, ['repeated']);
    assert.match(draft.preparationProgress!.excluded[0]!.reason, /Malformed JSON/);
    assert.equal(draft.preparationProgress!.status, 'partial');
    assert.equal(draft.librarySnapshot!.variants.length, 1);
    const evidence = await lab.store.generatorEvidence(seed.id);
    assert.ok(evidence.some(e => e.kind === 'response' && e.response.text === '{broken'));
    assert.ok(evidence.some(e => e.kind === 'error' && e.error === 'Malformed JSON' && e.usage.calls === 1));
    assert.ok(evidence.some(e => e.kind === 'result' && e.method === 'scenarioProposals'));
    const request = evidence.find(e => e.kind === 'request' && e.method === 'scenarioProposals');
    assert.ok(request?.kind === 'request' && request.inputHash);
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(join(directory, `${seed.id}.generator.jsonl`))).mode & 0o777, 0o600);
    await lab.close();
    const reader = new ExperimentLab(directory);
    assert.deepEqual(await reader.store.generatorEvidence(seed.id), evidence);
    assert.throws(() => reader.store.appendGeneratorEvidence(seed.id, evidence[0]!), /писател/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('new preparation requires coverage after a repair silently deletes later customer evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-coverage-repair-'));
  const runtime = runtimeFixture([]), generate = runtime.scenarioProposals!;
  runtime.scenarioProposals = async (request, ctx) => {
    const result = await generate(request, ctx);
    if (request.feedback?.issues.some(issue => issue.code === 'semantic_finding')) for (const proposal of result) {
      delete proposal.variant.sourceCoverage;
      delete proposal.variant.sourceCoverageRequired;
      delete proposal.variant.sourceCoverageBasis;
    }
    return result;
  };
  runtime.assessScenarioProposals = async request => request.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path,
    status: field.variantId === 'variant_2' && path === 'userState' && request.library.variants.find(v => v.id === field.variantId)?.sourceCoverage?.length ? 'needs_review' as const : 'ready' as const,
    reason: 'Проверить источник и исходную цель' })));
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle(); const record = await lab.get(seed.id);
    const variant = record.librarySnapshot!.variants.find(v => v.id === 'variant_2')!;
    assert.equal(variant.sourceCoverageRequired, true, 'the generator cannot remove the harness requirement');
    assert.deepEqual(variant.sourceCoverageBasis, [{ batchId: record.librarySnapshot!.imports[0]!.id, dialogueId: 'repeated', eventIndex: 2 }]);
    assert.equal(variant.quality, 'blocked');
    assert.ok(variant.issues.some(issue => issue.code === 'source_coverage_missing'));
    assert.equal(record.librarySnapshot!.variants.length, 2, 'the difficult source is retained');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('coverage authority is derived from every preparation request, never retained from generated metadata', async () => {
  for (const claimOpening of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'scenario-coverage-authority-'));
    const runtime = runtimeFixture([]), generate = runtime.scenarioProposals!;
    runtime.scenarioProposals = async (request, ctx) => {
      const result = await generate(request, ctx);
      for (const proposal of result) {
        const ref = proposal.variant.sourceDialogues[0]!;
        proposal.variant.sourceCoverageRequired = true;
        proposal.variant.sourceCoverageBasis = [{ ...ref, eventIndex: 0 }];
        if (claimOpening && ref.dialogueId === 'terminal') proposal.variant.sourceCoverage = [{ ...ref, eventIndex: 0,
          disposition: 'initial_fact', actionIds: [], factIds: ['terminal_number'], reason: 'Модель ошибочно объявила начало продолжением' }];
      }
      return result;
    };
    const lab = new ExperimentLab(directory, runtime);
    try {
      await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle(); const record = await lab.get(seed.id);
      const single = record.librarySnapshot!.variants.find(variant => variant.id === 'variant_1')!;
      assert.equal(single.sourceCoverageRequired, undefined);
      assert.equal(single.sourceCoverageBasis, undefined, 'even an empty basis overwrites fabricated harness authority');
      if (claimOpening) {
        assert.equal(single.sourceCoverage?.[0]?.eventIndex, 0, 'substantive generated claims remain visible for rejection');
        assert.equal(single.quality, 'blocked');
        assert.ok(single.issues.some(issue => issue.code === 'source_coverage_reference'));
      } else assert.equal(single.quality, 'ready');
      const multi = record.librarySnapshot!.variants.find(variant => variant.id === 'variant_2')!;
      assert.equal(multi.sourceCoverageRequired, true);
      assert.deepEqual(multi.sourceCoverageBasis, [{ batchId: record.librarySnapshot!.imports[0]!.id, dialogueId: 'repeated', eventIndex: 2 }]);
      assert.equal(multi.sourceCoverage?.[0]?.eventIndex, 2, 'the real source accounting is retained separately from harness metadata');
    } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
