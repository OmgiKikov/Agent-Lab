import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { createInputSchema, type Runtime } from '../src/contracts.js';
import { createDemoRuntime } from '../src/demo.js';
import { scenarioLibrarySchema } from '../src/scenario-contracts.js';
import { acceptLibrary, libraryHash, libraryQuality } from '../src/scenario-library.js';
import { libraryFixture, coverageProposals as proposals, rawDialogues, sources, requirements } from './helpers/scenario-library.js';

const input = (logs = true) => createInputSchema.parse({ task: 'Проверить возвраты', mode: 'demo', materials: sources.map(({ name, content }) => ({ name, content })), dialogues: logs ? rawDialogues : [], scenarioCount: 2, settings: { maxCalls: 100, repeats: 1, userModes: ['reactive'] } });
function runtimeFixture(): Runtime {
  return { ...createDemoRuntime(),
    async prepare() { return { requirements: requirements.map(r => ({ ...r, sourceId: 'source-1' })), questions: [], agent: { name: 'Агент', instructions: 'Уточните номер терминала', tools: [] }, scenarios: [] }; },
    async scenarioProposals(request, ctx) { ctx.beforeCall(); return proposals(request.batchId).filter(p => request.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId)) as any; },
    async assessScenarioProposals(request, ctx) { ctx.beforeCall(); return request.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Детерминированная проверка синтетического примера' }))); },
    async openTarget() { return { async respond() { return 'Уточните номер терминала'; }, async close() {} }; },
    async selectUserAction() { return { actionId: 'finish', factIds: [] }; },
    async assessCheckpoints({ checkpoints, events }) { return checkpoints.map(cp => ({ checkpointId: cp.id, result: 'pass' as const, rationale: 'Номер запрошен', evidence: [events.find(e => e.type === 'assistant')!.index] })); },
  } as Runtime;
}

for (const [name, mutate] of Object.entries({
  'finish payload': (p: any) => { p.actions[0].payload = 'Спасибо, понятно'; },
  'finish facts': (p: any) => { p.actions[0].factIds = ['terminal_number']; },
  'ambiguous transition': (p: any) => { p.transitions.push({ ...p.transitions[0], to: 'waiting' }); },
  'nonterminal finish': (p: any) => { p.transitions[0].to = 'waiting'; p.actions.push({ id: 'missing', kind: 'missing', factIds: [] }); p.transitions.push({ ...p.transitions[0], actionId: 'missing', to: 'done' }); },
  'empty clarification': (p: any) => { p.actions.push({ id: 'clarify', kind: 'clarify', factIds: [] }); p.transitions.push({ ...p.transitions[0], actionId: 'clarify' }); },
  'unreachable declared intention': (p: any) => { p.actions.push({ id: 'change', kind: 'change_intent', factIds: [], payload: 'Хочу отменить возврат' }); },
})) test(`admission shares controller invariants: ${name}; historical record remains readable`, () => {
  const library = libraryFixture(); mutate(library.variants[0]!.behaviorPolicy);
  assert.doesNotThrow(() => scenarioLibrarySchema.parse(library), 'persisted historical shape stays readable');
  assert.ok(libraryQuality(library).some(i => i.variantId === 'variant_1' && i.code === 'controller_policy'), 'new admission must detect runtime-invalid policy');
  assert.throws(() => acceptLibrary(library, libraryHash(library), ['variant_1']), /готов/);
});

test('generated finish payload gets repair feedback before acceptance and runs through the shared controller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-finish-')), runtime = runtimeFixture(); let feedback = false;
  runtime.scenarioProposals = async request => {
    const p = proposals(request.batchId).find(p => p.variant.sourceDialogues[0]!.dialogueId === request.dialogues[0]!.id)!;
    if (!request.feedback) (p.variant.behaviorPolicy.actions[0] as any).payload = 'Спасибо, понятно';
    else feedback = request.feedback.issues.some(i => i.code === 'controller_policy');
    return [p] as any;
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input()); await lab.waitForIdle();
    assert.ok(feedback, 'a real generated shape must be repaired before admission');
    const draft = await lab.readLibrary(seed.id), accepted = await lab.acceptLibrary(seed.id, libraryHash(draft.library), ['variant_1']);
    await lab.start(seed.id, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
    const run = await lab.get(seed.id);
    assert.equal(run.trials.length, 1); assert.notEqual(run.trials[0]!.outcome, 'invalid');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('no-log preparation creates honest curated review/edit/accept/controller library', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-no-log-')), runtime = runtimeFixture(); let requestSeen: any;
  runtime.scenarioProposals = async request => {
    requestSeen = request;
    const p = proposals(request.batchId)[0]!;
    Object.assign(p.variant, { provenance: 'curated', sourceDialogues: [] });
    Object.assign(p.variant.userState, { facts: [], cannotKnow: [], missing: [] });
    return [p] as any;
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input(false)); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    assert.equal(draft.experiment.phase, 'review', draft.experiment.error ?? '');
    assert.deepEqual(draft.library.imports, []); assert.equal(draft.experiment.originalImport, undefined);
    assert.equal(draft.library.variants[0]!.provenance, 'curated'); assert.equal(draft.library.variants[0]!.quality, 'ready');
    assert.equal(draft.experiment.scenarios.length, 0); assert.deepEqual(requestSeen.dialogues, []);
    assert.equal(requestSeen.preparationMode, 'owner_requirements');
    const changed = await lab.editLibrary(seed.id, libraryHash(draft.library), { kind: 'add_fact', variantId: 'variant_1', factId: 'owner_number', statement: 'Номер терминала: 4321', value: '4321', availability: 'initial', editId: 'owner_added', reason: 'Владелец явно задал данные примера' } as any);
    const fact = changed.library.variants[0]!.userState.facts[0]!;
    assert.equal(fact.origin.kind, 'owner'); assert.ok(changed.library.variants[0]!.history.some(h => h.factEdit?.factId === fact.id));
    await lab.assessLibrary(seed.id, libraryHash(changed.library)); await lab.waitForIdle();
    const reviewed = await lab.readLibrary(seed.id), accepted = await lab.acceptLibrary(seed.id, libraryHash(reviewed.library), ['variant_1']);
    assert.equal(accepted.experiment.scenarios[0]!.execution?.protocol, 'controlled-user-v1');
    await lab.start(seed.id, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
    assert.notEqual((await lab.get(seed.id)).trials[0]!.outcome, 'invalid');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reproducible demo exercises persisted import, owner edit, accepted run and a repeat on a fixed agent version', async () => {
  const demo = await import('../examples/scenario-lab-demo.mjs').catch(() => assert.fail('A reproducible isolated scenario-lab demo is required'));
  const directory = await mkdtemp(join(tmpdir(), 'scenario-workflow-'));
  try {
    const report = await demo.verifyScenarioLab(directory);
    assert.equal(report.evidenceKind, 'deterministic-integration');
    assert.deepEqual(report.library, { dialogues: 2, groups: 1, variants: 2 });
    assert.equal(report.ownerReceipt, true); assert.equal(report.sourceUnchanged, true);
    assert.deepEqual(report.baseline, { passed: 1, decided: 2 }, 'the deliberately broken agent asks again for a number it was already given');
    assert.deepEqual(report.fixed, { passed: 2, decided: 2 });
    assert.equal(report.persistedLinksResolve, true);
    const candidate = JSON.parse(await readFile(join(directory, '.agent-lab', `${report.repeatRunId}.json`), 'utf8'));
    const late = candidate.trials.filter((t: any) => t.scenarioId === 'late_number');
    assert.equal(late.length, 2);
    for (const trial of late) {
      assert.deepEqual(trial.events.filter((e: any) => e.type === 'user').map((e: any) => e.text), ['Помогите с возвратом.', 'Номер терминала: 5678']);
      assert.ok(trial.events.some((e: any) => e.type === 'assistant' && e.text.includes('Подайте заявление')));
      assert.equal(trial.checkpoints.find((c: any) => c.checkpointId === 'refund_explanation')?.result, 'pass');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('no-log invented dialogue and owner fact cannot become ready even when semantic evaluator approves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-no-log-invention-')), runtime = runtimeFixture();
  runtime.scenarioProposals = async () => {
    const p = proposals('invented_import')[0]!;
    p.variant.provenance = 'curated';
    (p.variant.userState.facts[0] as any).origin = { kind: 'owner', editId: 'fabricated', text: 'Модель предположила' };
    return [p] as any;
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init(); const seed = await lab.create(input(false)); await lab.waitForIdle();
    const draft = await lab.readLibrary(seed.id);
    assert.deepEqual(draft.library.imports, []);
    assert.equal(draft.library.variants[0]!.quality, 'blocked');
    assert.ok(draft.library.variants[0]!.issues.some(i => i.code === 'missing_source'));
    assert.ok(draft.library.variants[0]!.issues.some(i => i.code === 'unverified_owner_fact'));
    await assert.rejects(lab.acceptLibrary(seed.id, libraryHash(draft.library), ['variant_1']), /готов/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('checkpoint proof labels explain decisions in Russian while preserving checkpoint identifiers', async () => {
  const { trialProofLines } = await import('../src/quality.js');
  const { demoEvaluateRecord } = await import('./helpers/demo-record.js');
  const fixture = await demoEvaluateRecord('scenario-proof-labels-');
  try {
    const trial = fixture.record.trials[0]!;
    trial.checkpoints = ['pass', 'fail', 'unknown', 'not_applicable'].map((result, i) => ({ checkpointId: `cp_${i}`, requirementId: 'rule', observation: 'reply', role: 'required', result, evidence: [1], rationale: 'Учебное решение' })) as any;
    const text = trialProofLines(fixture.record, trial.id).lines.join('\n');
    for (const label of ['ВЫПОЛНЕНО [cp_0]', 'НАРУШЕНО [cp_1]', 'НЕ ОПРЕДЕЛЕНО [cp_2]', 'НЕ ПРИМЕНИМО [cp_3]']) assert.ok(text.includes(label));
  } finally { await fixture.lab.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test('demo direct invocation through a symlink path prints an isolated review draft and launch command', async () => {
  const { symlink } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { resolve } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'scenario-launch-'));
  let seeded: string | undefined;
  try {
    await symlink(resolve('examples'), join(directory, 'examples'), 'dir');
    const result = await promisify(execFile)(process.execPath, [join(directory, 'examples/scenario-lab-demo.mjs')]);
    assert.match(result.stdout, /developer-authored-synthetic-fixture/);
    const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf('\ncd ')));
    seeded = report.directory; assert.equal(report.ready, 1); assert.equal(report.needsReview, 0); assert.equal(report.blocked, 1);
    assert.match(result.stdout, /--no-extensions.*--skill/);
  } finally { if (seeded) await rm(seeded, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
});


test('teaching checkpoint assessor rejects alternative repeated questions and missing refund instructions', async () => {
  const { demoScenarioRuntime } = await import('../examples/scenario-lab-demo.mjs');
  const runtime = demoScenarioRuntime();
  const assess = async (id: string, replies: string[]) => {
    const dialogue = [{ seq: 0, type: 'user', text: 'Номер терминала: 1234. Помогите с возвратом.' }, ...replies.map((text, i) => ({ seq: i + 1, type: 'assistant', text }))];
    return (await runtime.assessCheckpoints({ checkpoints: [{ checkpoint: { id }, dialogue, evidence: dialogue.slice(1), allowedEvidence: dialogue.slice(1).map(e => e.seq) }] }))[0].result;
  };
  assert.equal(await assess('ask_once', ['Какой у вас номер терминала?']), 'fail');
  assert.equal(await assess('refund_explanation', ['Спасибо, номер записан.']), 'fail');
  assert.equal(await assess('refund_explanation', ['Возврат возможен. Подайте заявление в поддержку.']), 'pass');
});

test('teaching baseline explains refund after finite disclosure while retaining the initial-number defect', async () => {
  const { createSession } = await import('../examples/scenario-lab-target.mjs');
  const late = createSession({ initialState: { records: {} } });
  assert.match((await late.respond('Помогите с возвратом.')).reply, /Уточните/);
  assert.match((await late.respond('Номер терминала: 5678')).reply, /Подайте заявление/);
  const known = createSession({ initialState: { records: {} } });
  assert.match((await known.respond('Номер терминала: 1234. Помогите с возвратом.')).reply, /Уточните/);
});
