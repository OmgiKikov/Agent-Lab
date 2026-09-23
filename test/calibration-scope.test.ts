import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCommand, applyLogVersion, hostGrant, prepareCommand, prepareLogVersion, requiredAuthority, wordsOf, type PreparedLogVersion } from '../src/card/commands.js';
import { calibrationCalls, calibrationMode, calibratable, cardExclusion, cardLogSituation, logSkip, runLogSituations, testedVersion, variantExclusion } from '../src/card/calibration-scope.js';
import { logVersionJournalSchema, type LogVersionJournal } from '../src/card/calibration.js';
import { cardSchema, type Card } from '../src/card/schema.js';
import { fingerprint, type Experiment, type Trial } from '../src/contracts.js';
import { CommandRefused, StaleRevisionError } from '../src/errors.js';
import { draftHash, ExperimentLab } from '../src/experiment.js';
import { importBatch, libraryHash, verifyAcceptedRun } from '../src/scenario-library.js';
import { libraryV1Schema, scenarioVariantSchema } from '../src/scenario-contracts.js';
import { ExperimentStore } from '../src/store.js';
import { cardDraft, cardNumbered, type CardDraft } from './helpers/card-library.js';
import { cardInput, cardRuntime, dialogues } from './helpers/card-prep.js';
import { briefCard } from './helpers/cards.js';
import { libraryV1File } from './helpers/library-v1.js';

/*
 * C14: which agent version wrote the logs (the owner's declaration, kept beside the import and only appended),
 * which version was tested, whether agreement is a calibration or only a comparison, and which situations are
 * the situations of their logs. Invented data only.
 */

const AT = '2026-09-23T12:00:00.000Z';
const batch = importBatch(dialogues);
const declare = (journal: LogVersionJournal | undefined, version: string | null): { prepared: PreparedLogVersion; next: LogVersionJournal } => {
  const prepared = prepareLogVersion(journal, batch, { kind: 'declare_log_version', importId: batch.id, version }, { via: 'cli-yes', at: AT });
  return { prepared, next: applyLogVersion(journal, prepared, hostGrant(prepared, 'confirmed')) };
};

async function withStore(work: (store: ExperimentStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-log-versions-'));
  const store = new ExperimentStore(directory);
  try { await store.init(); await store.writeImport(batch); await work(store); } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('the logs\' version is the owner\'s confirmed word, kept beside the import and only ever appended', async () => {
  await withStore(async store => {
    const first = declare(undefined, 'agent-2026-09');
    assert.equal(first.prepared.authority, 'owner-confirm');
    assert.deepEqual(first.prepared.change, { before: undefined, after: 'agent-2026-09' });
    await store.writeLogVersions(first.next, null);
    const stored = await store.readLogVersions(batch.id);
    assert.deepEqual(stored, first.next);
    assert.deepEqual(stored!.declarations[0], { id: stored!.declarations[0]!.id, at: AT, via: 'cli-yes', command: { kind: 'declare_log_version', importId: batch.id, version: 'agent-2026-09' } });
    assert.equal((await stat(join(store.directory, 'imports', `${batch.id}.declarations.json`))).mode & 0o777, 0o600, 'kept as privately as the logs themselves');

    const second = declare(stored, null);
    assert.deepEqual(second.prepared.change, { before: 'agent-2026-09', after: null }, '«неизвестно» is a declaration too');
    await store.writeLogVersions(second.next, fingerprint(stored));
    const both = (await store.readLogVersions(batch.id))!;
    assert.deepEqual(both.declarations.map(item => item.command.version), ['agent-2026-09', null], 'the last one holds; the first stays as it was');
    assert.deepEqual(both.declarations[0], stored!.declarations[0]);

    await assert.rejects(store.writeLogVersions(second.next, fingerprint(stored)), StaleRevisionError, 'a declaration prepared on an older journal is refused');
    const rewritten = logVersionJournalSchema.parse({ ...both, declarations: [{ ...both.declarations[0]!, command: { ...both.declarations[0]!.command, version: 'другая' } }, both.declarations[1]!,
      { ...both.declarations[1]!, id: 'logs_rewrite' }] });
    await assert.rejects(store.writeLogVersions(rewritten, fingerprint(both)), /только дописывается/, 'an earlier declaration is never rewritten');
    const dropped = logVersionJournalSchema.parse({ ...both, declarations: [both.declarations[1]!] });
    await assert.rejects(store.writeLogVersions(dropped, fingerprint(both)), /только дописывается/, 'nor dropped');
  });
});

test('a declaration needs the owner\'s native confirmation of that very preview; a repeat of the same word is refused', () => {
  const { prepared, next } = declare(undefined, 'v1');
  assert.equal(requiredAuthority(prepared.command), 'owner-confirm');
  assert.deepEqual(wordsOf(prepared.command), [], 'a version is a decision, not a wording');
  assert.throws(() => applyLogVersion(undefined, prepared, hostGrant(prepared, 'words')), CommandRefused, 'the owner\'s words alone do not confirm it');
  assert.throws(() => applyLogVersion(undefined, prepared, { ...hostGrant(prepared, 'confirmed') }), CommandRefused, 'a copy of a grant is no grant');
  assert.throws(() => applyLogVersion(undefined, prepared, hostGrant({ previewHash: prepared.previewHash, via: 'board' }, 'confirmed')), CommandRefused, 'granted where it was not shown');
  assert.throws(() => applyLogVersion(next, prepared, hostGrant(prepared, 'confirmed')), StaleRevisionError, 'the journal moved since the preview');
  assert.throws(() => declare(next, 'v1'), (error: unknown) => error instanceof CommandRefused && error.message === 'Так уже записано.');
  const other = importBatch([{ id: 'other', messages: [{ role: 'user', content: 'Здравствуйте' }] }]);
  assert.throws(() => prepareLogVersion(next, other, { kind: 'declare_log_version', importId: other.id, version: 'v2' }, { via: 'cli-yes' }), CommandRefused, 'a journal belongs to one import');
});

const withVersions = (log: string | null | undefined, tested: string | null) => ({
  logVersions: log === undefined ? [] : [{ importId: batch.id, contentHash: batch.contentHash, version: log, receiptId: 'logs_1' }], testedVersion: tested });
const attempt = (version?: string, answered = true): Pick<Trial, 'events' | 'observation'> => ({
  events: answered ? [{ seq: 0, type: 'user', text: 'Здравствуйте' }, { seq: 1, type: 'assistant', text: 'Добрый день' }] : [{ seq: 0, type: 'user', text: 'Здравствуйте' }],
  observation: { state: 'missing', tools: 'partial', ...(version ? { version } : {}) } });
const tested = (trials: Pick<Trial, 'events' | 'observation'>[], targetVersion?: string) => testedVersion({ trials: trials as Trial[], ...(targetVersion ? { targetVersion } : {}) });

test('calibration only when the logs\' version and the tested version are both known and equal; otherwise a comparison with the reason', () => {
  const table: [string, ReturnType<typeof withVersions>, ReturnType<typeof calibrationMode>][] = [
    ['both known and equal (after trim)', withVersions('agent-v7 ', 'agent-v7'), { mode: 'calibration', versionNote: null }],
    ['they differ', withVersions('agent-v6', 'agent-v7'), { mode: 'comparison', versionNote: 'в логах agent-v6, проверяли agent-v7' }],
    ['the logs never declared', withVersions(undefined, 'agent-v7'), { mode: 'comparison', versionNote: 'версия логов не указана' }],
    ['the logs declared «неизвестно»', withVersions(null, 'agent-v7'), { mode: 'comparison', versionNote: 'версия логов не указана' }],
    ['the tested version unknown', withVersions('agent-v7', null), { mode: 'comparison', versionNote: 'версия проверяемого агента неизвестна' }],
  ];
  for (const [name, calibration, expected] of table) assert.deepEqual(calibrationMode(calibration, [batch.id]), expected, name);
  assert.deepEqual(calibrationMode(withVersions('agent-v7', 'agent-v7'), []), { mode: 'comparison', versionNote: 'версия логов не указана' }, 'no log compared, no calibration');
});

test('the tested version: the adapter\'s when it named one in every answered attempt, else the owner\'s; an adapter naming two tested none', () => {
  assert.equal(tested([attempt('v7'), attempt('v7')], 'v6'), 'v7', 'the adapter\'s word is the identity');
  assert.equal(tested([attempt(), attempt()], 'v6'), 'v6', 'a silent adapter: the owner\'s declaration');
  assert.equal(tested([attempt(), attempt()]), null, 'neither said: unknown');
  assert.equal(tested([attempt('v7'), attempt('v8')], 'v7'), null, 'the adapter reported different versions: no single version was tested');
  assert.deepEqual(calibrationMode(withVersions('v7', tested([attempt('v7'), attempt('v8')], 'v7')), [batch.id]), { mode: 'comparison', versionNote: 'версия проверяемого агента неизвестна' });
  assert.equal(tested([attempt('v7'), attempt(undefined, false)]), 'v7', 'an attempt the agent never answered says nothing');
  assert.equal(tested([attempt('v7'), attempt()], 'v7'), 'v7', 'named in part, and the owner agrees');
  assert.equal(tested([attempt('v7'), attempt()], 'v6'), null, 'named in part, and the owner contradicts it');
});

async function withLab(work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-declare-'));
  const lab = new ExperimentLab(directory, cardRuntime());
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}

test('declaring the logs\' version after acceptance changes no library hash, no acceptance and no run', async () => {
  await withLab(async lab => {
    const draft = await lab.create(cardInput(), { cards: true });
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    const importId = accepted.experiment.originalImport!.id;
    const prepared = await lab.prepareLogVersion({ kind: 'declare_log_version', importId, version: 'agent-v7' }, { via: 'pi-confirm' });
    const journal = await lab.applyLogVersion(prepared, hostGrant(prepared, 'confirmed'));
    assert.deepEqual(journal.declarations.map(item => item.command.version), ['agent-v7']);
    const after = await lab.get(draft.id);
    assert.equal(libraryHash(after.librarySnapshot!), libraryHash(accepted.library), 'the declaration is not library content');
    assert.deepEqual(after.librarySnapshot!.acceptance, accepted.library.acceptance);
    assert.equal(libraryHash(await lab.store.readLibrary(accepted.library.id)), libraryHash(accepted.library));
    assert.equal(draftHash(after), draftHash(accepted.experiment), 'the draft the owner confirmed is the same draft');
    verifyAcceptedRun(after);
    const again = await lab.prepareLogVersion({ kind: 'declare_log_version', importId, version: null }, { via: 'pi-confirm' });
    await assert.rejects(lab.applyLogVersion(again, hostGrant(again, 'words')), CommandRefused);
  });
});

/** The draft's card №1 (the number named on request) after one owner command, confirmed. */
function afterCommand(draft: CardDraft, command: Parameters<typeof prepareCommand>[1]): Card[] {
  const prepared = prepareCommand(draft.library, command, { evidence: draft.evidence, maxTurns: 3, via: 'pi-confirm', at: AT });
  return applyCommand(draft.library, prepared, hostGrant(prepared, 'confirmed')).cards;
}

test('a card is calibrated only when its situation is its log\'s: editing an expectation keeps it, editing the situation does not', () => {
  const draft = cardDraft();
  const late = cardNumbered(draft.library, 1), known = cardNumbered(draft.library, 2);
  const similar = afterCommand(draft, { kind: 'add_similar', parentId: late.id, change: { kind: 'turn', turn: { kind: 'change_intent', after: 'агент объяснил возврат', says: 'А можно лучше обменять?' } } }).at(-1)!;
  const disclosed = afterCommand(draft, { kind: 'set_fact_disclosure', cardId: late.id, factId: 'f1', disclosure: 'unknown' }).find(card => card.id === late.id)!;
  const reworded = afterCommand(draft, { kind: 'edit_expectation', cardId: late.id, expectationId: 'e2', text: 'объяснить, как подать заявление на возврат' }).find(card => card.id === late.id)!;
  const opening = afterCommand(draft, { kind: 'edit_client', cardId: known.id, writes: 'Номер терминала: 1234. Верните деньги.' }).find(card => card.id === known.id)!;
  const brief = briefCard();
  const table: [string, Card, ReturnType<typeof cardExclusion>][] = [
    ['a card of a dialogue', late, undefined],
    ['the other card of a dialogue', known, undefined],
    ['the owner reworded an expectation', reworded, undefined],
    ['a similar card', similar, 'not_from_log'],
    ['a card added by the owner', cardSchema.parse({ ...brief, origin: { kind: 'owner', receiptId: 'owner_1' } }), 'not_from_log'],
    ['a card from the owner\'s rules', cardSchema.parse({ ...brief, origin: { kind: 'rules', requirementIds: ['refund_rule'] }, client: { ...brief.client, writesSource: { kind: 'model' } } }), 'not_from_log'],
    ['the owner decided what the customer knows', disclosed, 'situation_edited'],
    ['the owner rewrote the first message', opening, 'situation_edited'],
    ['a fact nobody vouched for', brief, 'situation_edited'],
  ];
  for (const [name, card, expected] of table) {
    assert.equal(cardExclusion(card), expected, name);
    assert.equal(calibratable(card), expected === undefined, name);
  }
});

test('a first-format situation is calibrated through its projection by the same rule', async () => {
  const library = libraryV1Schema.parse(await libraryV1File('library.json'));
  const known = library.variants.find(variant => variant.id === 'known_number')!;
  const late = library.variants.find(variant => variant.id === 'late_number')!;
  const variant = (change: object) => scenarioVariantSchema.parse({ ...known, ...change });
  const table: [string, typeof known, ReturnType<typeof variantExclusion>][] = [
    ['a production variant as generated', known, undefined],
    ['the owner confirmed a fact in its own words', late, 'situation_edited'],
    ['a synthetic variant', variant({ provenance: 'synthetic' }), 'not_from_log'],
    ['a variant made from another', variant({ parentVariantId: 'late_number' }), 'not_from_log'],
    ['the owner reworded a checkpoint', variant({ history: [...known.history, { author: 'owner', reason: 'правка', revision: 2, textEdit: { editId: 'e1', field: 'checkpointRule', valueHash: 'a'.repeat(64) } }] }), undefined],
    ['the owner rewrote the opening', variant({ history: [...known.history, { author: 'owner', reason: 'правка', revision: 2, textEdit: { editId: 'e1', field: 'opening', valueHash: 'a'.repeat(64) } }] }), 'situation_edited'],
  ];
  for (const [name, item, expected] of table) assert.equal(variantExclusion(item), expected, name);

  const run = await libraryV1File('run.json') as Experiment;
  const situations = runLogSituations(run);
  assert.deepEqual(situations.map(item => [item.id, item.exclusion ?? null, item.expectations.map(e => `${e.letter} ${e.expectation.id}`), item.card]), [
    ['known_number', null, ['А ask_once', 'Б refund_explanation'], `ситуации «${run.scenarios[0]!.title}»`],
    ['late_number', 'situation_edited', ['А ask_once', 'Б refund_explanation'], `ситуации «${run.scenarios[1]!.title}»`]]);
  assert.deepEqual(situations[0]!.log, { importId: library.imports[0]!.id, importContentHash: library.imports[0]!.contentHash, dialogueId: 'known' });
});

test('what a log cannot show is skipped without a call, and the ceiling is two votes for the rest', () => {
  const draft = cardDraft();
  const logged = (id: string) => batch.dialogues.find(dialogue => dialogue.id === id)!;
  const late = logged('late');
  assert.equal(logSkip({ observation: 'reply' }, late, 0), undefined);
  assert.equal(logSkip({ observation: 'reply' }, late, 4), 'no_agent_reply', 'after the customer\'s «Спасибо!» the agent never replied');
  assert.equal(logSkip({ observation: 'tool' }, late, 0), 'channel_unobserved', 'no complete tool log');
  const withTools = { ...late, observation: 'complete' as const, events: [...late.events, { index: 5, type: 'tool' as const, content: 'lookup', data: { tool: 'lookup' } }] };
  assert.equal(logSkip({ observation: 'tool' }, withTools, 0), undefined);
  assert.equal(logSkip({ observation: 'state' }, withTools, 0), 'channel_unobserved', 'tools recorded, state not');
  const unanswered = importBatch([{ id: 'silent', messages: [{ role: 'user', content: 'Помогите с возвратом.' }] }]).dialogues[0]!;
  assert.equal(logSkip({ observation: 'reply' }, unanswered), 'no_agent_reply');

  const situations = draft.library.cards.map(card => cardLogSituation(draft.library, card));
  assert.equal(calibrationCalls(situations, (importId, dialogueId) => importId === draft.batch.id ? logged(dialogueId) : undefined), 8, 'two cards × two expectations × two votes');
  assert.equal(calibrationCalls(situations, () => undefined), 0, 'a conversation that is not at hand is never judged');
});
