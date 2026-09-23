import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { experimentSchema, fingerprint, type Experiment } from '../src/contracts.js';
import { cardSchema, disclosureSchema, expectationSchema, libraryV2Schema, scenarioLibrarySchema, turnSchema, type Card, type LibraryV2 } from '../src/card/schema.js';
import { libraryV1Of, requireLibraryV1 } from '../src/card/legacy-v1.js';
import { text } from '../src/ids.js';
import { libraryHash, snapshotDigest, verifiedAcceptance, verifyAcceptedRun } from '../src/scenario-library.js';
import { ExperimentStore } from '../src/store.js';
import { libraryV1File } from './helpers/library-v1.js';
import { libraryFixture } from './helpers/scenario-library.js';
import { strictSchemaProblems } from './helpers/strict-schema.js';

const event = (eventIndex: number) => ({ batchId: 'batch_1', dialogueId: 'late', eventIndex });
const card = (): Card => ({
  id: `card_${'c'.repeat(64)}`, number: 1, title: 'Номер раскрывается по просьбе', topic: 'Возврат оплаты',
  origin: { kind: 'dialogue', batchId: 'batch_1', dialogueId: 'late' },
  client: {
    wants: 'Получить инструкцию по возврату', writes: 'Помогите с возвратом.', writesSource: { kind: 'dialogue', event: event(0) },
    knows: [
      { id: 'f1', label: 'Номер терминала', value: '5678', disclosure: 'on_request', source: { kind: 'dialogue', event: event(2) } },
      { id: 'f2', label: 'Дата покупки', disclosure: 'unknown', source: { kind: 'unconfirmed' } },
    ],
    leaves: 'Получил инструкцию по возврату или понял, что агент не поможет',
    turn: { kind: 'report', after: 'агент объяснил, как оформить возврат', says: 'А если чек потерян?', source: { kind: 'owner', receiptId: 'receipt_1' } },
  },
  agentMust: [
    { id: 'e1', text: 'запросить номер терминала не больше одного раза', requirementIds: ['refund_rule'], observation: 'reply' },
    { id: 'e2', text: 'объяснить, как оформить возврат', requirementIds: ['refund_rule'], appliesWhen: 'клиент назвал номер терминала', observation: 'reply' },
  ],
  coverage: [{ event: event(2), as: 'fact' }],
  revision: 1,
});

/** A card library on the materials of the first-format fixture run, with one review claim and one owner receipt. */
async function cardLibrary(): Promise<{ library: LibraryV2; record: Experiment }> {
  const record = experimentSchema.parse(await libraryV1File('run.json'));
  const brief = card();
  const library: LibraryV2 = {
    formatVersion: 2, id: 'cards_library', revision: 1, createdAt: '2026-09-23T00:00:00.000Z',
    imports: [{ id: 'batch_1', contentHash: 'b'.repeat(64) }], sources: record.sources, requirements: record.requirements,
    readingManifest: [{ dialogueId: 'late', batchId: 'batch_1', sourceIds: record.sources.map(source => source.id), cardIds: [brief.id] }],
    cards: [brief], nextNumber: 2,
    claims: [{ key: 'd'.repeat(64), kind: 'fact', subject: 'f1', basisHash: 'e'.repeat(64), status: 'ready', reason: 'Номер назван клиентом в диалоге.',
      reviewer: { protocol: 'card-review-v1', model: 'test-model' } }],
    receipts: [{ id: 'receipt_1', at: '2026-09-23T00:00:00.000Z', via: 'pi-confirm', ownerWords: 'Клиент потом спрашивает про потерянный чек',
      command: { kind: 'set_turn', cardId: brief.id, turn: { kind: 'report', after: 'агент объяснил, как оформить возврат', says: 'А если чек потерян?' } } }],
  };
  // The run of the accepted card: any compiled definition works here; only its stored hash is checked.
  const scenario = { ...structuredClone(record.scenarios[0]!), id: brief.id, familyId: brief.id };
  const definitions = [{ cardId: brief.id, definitionHash: fingerprint(scenario) }];
  const seal = { libraryHash: libraryHash(library), cardIds: [brief.id], definitions };
  library.acceptance = { revision: 1, ...seal, snapshotHash: snapshotDigest(library, seal) };
  const run = { ...structuredClone(record), librarySnapshot: library, scenarios: [scenario], trials: [], selectedScenarioIds: undefined,
    acceptedTests: [{ testId: 'accepted_card', scenarioId: brief.id, definitionHash: fingerprint(scenario), acceptedAt: '2026-09-23T00:00:00.000Z' }] };
  return { library, record: experimentSchema.parse(run) };
}

test('stored libraries of both formats parse to themselves through one union', async () => {
  const v1 = libraryFixture();
  assert.equal(fingerprint(scenarioLibrarySchema.parse(v1)), fingerprint(v1));
  const stored = await libraryV1File('library.json');
  assert.equal(fingerprint(scenarioLibrarySchema.parse(stored)), fingerprint(stored));
  const { library, record } = await cardLibrary();
  const raw = JSON.parse(JSON.stringify(library));
  assert.equal(fingerprint(scenarioLibrarySchema.parse(raw)), fingerprint(raw), 'a card library round-trips without defaults or rewrites');
  assert.deepEqual(libraryV2Schema.parse(raw), library);
  const run = JSON.parse(JSON.stringify(record));
  assert.equal(fingerprint(experimentSchema.parse(run)), fingerprint(run), 'a run carries a card library snapshot as it is');
  assert.equal(libraryV1Of(record), undefined);
  assert.throws(() => requireLibraryV1(library), /новом формате/);
  assert.equal(requireLibraryV1(stored as never).formatVersion, 1);
});

test('the store keeps a card library by its hash and reads it back unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-card-library-'));
  const store = new ExperimentStore(directory);
  try {
    await store.init();
    const { library } = await cardLibrary();
    await store.writeLibrary(library);
    assert.deepEqual(await store.readLibrary(library.id), library);
    assert.deepEqual(await store.readLibrary(library.id, libraryHash(library)), library);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('card schemas are strict: unknown fields, repeated ids and broken structure are refused', async () => {
  const { library } = await cardLibrary();
  const refused = (change: (value: LibraryV2 & Record<string, unknown>) => void) => {
    const value = structuredClone(library) as LibraryV2 & Record<string, unknown>;
    change(value);
    return !scenarioLibrarySchema.safeParse(value).success;
  };
  assert.ok(refused(value => { value.extra = true; }), 'library');
  assert.ok(refused(value => { Object.assign(value.cards[0]!, { quality: 'ready' }); }), 'card');
  assert.ok(refused(value => { Object.assign(value.cards[0]!.client.knows[0]!, { availability: 'initial' }); }), 'fact');
  assert.ok(refused(value => { Object.assign(value.receipts[0]!.command, { approved: true }); }), 'owner command');
  assert.ok(refused(value => { Object.assign(value.claims[0]!.reviewer, { temperature: 0 }); }), 'claim reviewer');
  assert.ok(refused(value => { value.cards[0]!.client.knows[1]!.id = 'f1'; }), 'repeated fact id');
  assert.ok(refused(value => { value.cards.push(structuredClone(value.cards[0]!)); }), 'repeated card id');
  assert.ok(refused(value => { value.cards.push({ ...structuredClone(value.cards[0]!), id: `card_${'a'.repeat(64)}` }); }), 'repeated card number');
  assert.ok(refused(value => { value.nextNumber = 1; }), 'a number that could be given again');
  assert.ok(refused(value => { value.cards[0]!.coverage[0]!.as = 'ignored'; }), 'an ignored message without a reason');
  assert.ok(refused(value => { value.cards[0]!.client.writesSource = { kind: 'model' }; }), 'a model-written opening on a dialogue card');
  assert.ok(refused(value => { value.acceptance!.definitions = []; }), 'an accepted card without its definition');
  assert.ok(refused(value => { value.cards[0]!.agentMust = []; }), 'a card without expectations');
  assert.ok(refused(value => { value.cards[0]!.client.knows[0]!.disclosure = 'uncertain' as never; }), 'disclosure outside the three');
  const rules = structuredClone(library.cards[0]!);
  rules.origin = { kind: 'rules', requirementIds: ['refund_rule'] };
  rules.client.writesSource = { kind: 'model' };
  rules.coverage = [];
  assert.equal(cardSchema.safeParse(rules).success, true, 'a card from the owner rules alone opens with the model words');
});

test('an accepted card library is verified by its sealed definition hashes, never by recompiling', async () => {
  const { library, record } = await cardLibrary();
  assert.equal(verifiedAcceptance(library).definitions.length, 1);
  verifyAcceptedRun(record);
  const renamed = structuredClone(record);
  (renamed.librarySnapshot as LibraryV2).cards[0]!.title = 'Другое название';
  assert.throws(() => verifyAcceptedRun(renamed), /изменены после утверждения/);
  const edited = structuredClone(record);
  edited.scenarios[0]!.title = 'Другое название';
  edited.acceptedTests = edited.acceptedTests!.map(entry => ({ ...entry, definitionHash: fingerprint(edited.scenarios[0]) }));
  assert.throws(() => verifyAcceptedRun(edited), /отличается от утверждённой/, 'the run entry cannot vouch for a card the receipt sealed differently');
  const resealed = structuredClone(record);
  const acceptance = (resealed.librarySnapshot as LibraryV2).acceptance!;
  acceptance.definitions = [{ cardId: acceptance.cardIds[0]!, definitionHash: 'f'.repeat(64) }];
  assert.throws(() => verifyAcceptedRun(resealed), /изменены после утверждения/, 'the definitions are inside the sealed digest');
});

test('the proposal parts are strict-output ready: per-call enums of events, ids and closed nullable objects', () => {
  // The per-call schema of a card proposal (card-v2 §2.2) is composed of these parts; nulls stand for absent values.
  const call = { customerEvents: [0, 2], laterEvents: [2], requirementIds: ['refund_rule'] as [string, ...string[]], observations: ['reply'] as ['reply'] };
  const proposal = z.strictObject({
    title: text(160), wants: text(300), writesEvent: z.literal(call.customerEvents),
    knows: z.array(z.strictObject({ label: text(120), value: z.union([text(120), z.number(), z.boolean()]).nullable(), disclosure: disclosureSchema,
      from: z.literal(call.customerEvents).nullable(), askedAs: text(200).nullable() })).max(8),
    turn: z.strictObject({ kind: turnSchema.shape.kind, after: text(300), from: z.literal(call.laterEvents) }).nullable(),
    agentMust: z.array(z.strictObject({ text: text(300), requirementIds: z.array(z.enum(call.requirementIds)).min(1).max(3),
      appliesWhen: text(300).nullable(), observation: z.enum(call.observations) })).min(1).max(3),
    coverage: z.strictObject(Object.fromEntries(call.laterEvents.map(index => [String(index), z.strictObject({ as: z.enum(['fact', 'turn', 'stop', 'ignored']), reason: text(200).nullable() })]))),
  });
  assert.deepEqual(strictSchemaProblems(proposal), []);
  assert.deepEqual((z.toJSONSchema(z.literal(call.customerEvents)) as { enum: number[] }).enum, [0, 2], 'an event reference is an enum of this call');
  assert.equal(proposal.safeParse({ title: 'Т', wants: 'Х', writesEvent: 1, knows: [], turn: null, coverage: { 2: { as: 'fact', reason: null } },
    agentMust: [{ text: 'Т', requirementIds: ['refund_rule'], appliesWhen: null, observation: 'reply' }] }).success, false, 'an event outside the call is refused');
  // Stored shapes are not proposal parts: an optional field or a discriminated union would be refused by strict output.
  assert.ok(strictSchemaProblems(cardSchema).some(problem => problem.endsWith('optional property')));
  assert.ok(strictSchemaProblems(z.strictObject({ expectation: expectationSchema })).some(problem => problem.endsWith('optional property')));
  assert.ok(strictSchemaProblems(z.strictObject({ source: turnSchema.shape.source })).some(problem => problem.endsWith('oneOf')));
});
