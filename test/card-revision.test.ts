import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Experiment } from '../src/contracts.js';
import type { Runtime } from '../src/runtime.js';
import { preparationCeiling, PROPOSAL_ATTEMPTS } from '../src/card/budget.js';
import { citationId, type DialogueProposal } from '../src/card/proposal.js';
import { storedEvidence } from '../src/card/prepare.js';
import { cardSchema, preparationProgressSchema, type CardPreparation } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { consentText, rulesConsentText } from '../src/miner/plan.js';
import { buildResultView } from '../src/result-view.js';
import { realityParts } from '../src/result-text.js';
import { libraryHash, verifyAcceptedRun } from '../src/scenario-library.js';
import { cardInput, cardRuntime, policy, proposals, type Received } from './helpers/card-prep.js';

/*
 * W5b: a card the reviewer blocked is written once more against the reviewer's reasons, inside the unit's proposal
 * allowance and the consented ceiling, and never again on a resume; a customer who cannot say what is wrong is a
 * situation of its own, counted apart in the result.
 */

async function withLab(runtime: Runtime, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-revision-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}
const received = (): Received => ({ proposals: [], reviews: [] });
const progressOf = (record: Experiment) => record.preparationProgress as CardPreparation;
const lateOf = (seen: Received) => seen.proposals.filter(request => request.call.source.kind === 'dialogue' && request.call.source.dialogueId === 'late');
async function statuses(lab: ExperimentLab, id: string) {
  const { library, experiment } = await lab.readCards(id);
  return [...cardStatuses({ library, evidence: await storedEvidence(lab.store, library), maxTurns: experiment.settings.maxTurns }).values()].map(item => item.status);
}

const BLOCKED = 'Правило не требует повторно объяснять возврат после отказа.';
/** The revised duty the model writes once it reads the reviewer's reason. */
const revisedLate: DialogueProposal = { ...proposals.late, agentMust: [proposals.late.agentMust[0]!,
  { ...proposals.late.agentMust[1]!, text: 'объяснить, как оформить возврат, после того как клиент назвал номер терминала' }] };

/** The reviewer blocks the second duty of the `late` card while its text is the first one; `always` keeps blocking every revision too. */
function blockingRuntime(seen: Received, options: { always?: boolean } = {}): Runtime {
  const runtime = cardRuntime(seen);
  const propose = runtime.proposeCard!, review = runtime.reviewCard!;
  runtime.proposeCard = async (request, ctx) => request.revision ? (ctx.beforeCall(), seen.proposals.push(structuredClone(request)), revisedLate) : propose(request, ctx);
  runtime.reviewCard = async (request, ctx) => {
    const answer = await review(request, ctx);
    const duty = request.payload.card.agentMust.find(item => item.id === 'e2');
    const blocked = request.payload.card.title === proposals.late.title && request.aliases.includes('expectation_e2')
      && (options.always || duty?.text === proposals.late.agentMust[1]!.text);
    return blocked ? { ...answer, verdicts: { ...answer.verdicts, expectation_e2: { status: 'blocked', reason: BLOCKED } } } : answer;
  };
  return runtime;
}

test('a blocked card is revised once with the reviewer\'s reasons, keeps its number and becomes ready', async () => {
  const seen = received();
  await withLab(blockingRuntime(seen), async lab => {
    const draft = await lab.create(cardInput(), { parallel: 1 });
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.equal(experiment.error, null);
    const late = lateOf(seen);
    assert.equal(late.length, 2, 'one proposal and one revision');
    assert.deepEqual(late[1]!.revision?.blocked, [{ claim: 'expectation_e2', reason: BLOCKED }]);
    assert.equal((late[1]!.revision?.previous as { title: string }).title, proposals.late.title, 'the revision reads the card the reviewer read');
    assert.deepEqual(library.cards.map(card => [card.number, card.revision, card.agentMust[1]!.text]),
      [[1, 2, revisedLate.agentMust[1]!.text], [2, 1, proposals.known.agentMust[1]!.text]]);
    assert.deepEqual(library.readingManifest.map(row => row.cardIds), [[library.cards[0]!.id], [library.cards[1]!.id]], 'the revision takes the reading row');
    const progress = progressOf(experiment);
    assert.deepEqual([progress.revised, progress.cards?.map(row => row.cardId), progress.processed, progress.excluded],
      [['late'], library.cards.map(card => card.id), ['late', 'known'], []]);
    assert.deepEqual(progress.generationAttempts, [{ dialogueId: 'late', calls: 2 }, { dialogueId: 'known', calls: 1 }], 'the revision spends the unit\'s allowance');
    assert.deepEqual(await statuses(lab, draft.id), ['ready', 'ready']);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    verifyAcceptedRun(accepted.experiment);
  });
});

test('a revision the reviewer still blocks leaves the card unusable, and it is not revised again', async () => {
  const seen = received();
  await withLab(blockingRuntime(seen, { always: true }), async lab => {
    const draft = await lab.create(cardInput(), { parallel: 1 });
    await lab.waitForIdle();
    assert.equal(lateOf(seen).length, 2);
    assert.deepEqual(await statuses(lab, draft.id), ['unusable', 'ready']);
    assert.deepEqual(progressOf(await lab.get(draft.id)).revised, ['late']);
    // Only the blocked card is revised: the ready one never goes back.
    assert.equal(seen.proposals.filter(request => request.revision).length, 1);
  });
});

test('a revision that died in flight is never repeated on resume: the blocked card stays as it was', async () => {
  const seen = received();
  const runtime = blockingRuntime(seen);
  let died = 0;
  const propose = runtime.proposeCard!;
  runtime.proposeCard = async (request, ctx) => {
    if (request.revision) { ctx.beforeCall(); died++; throw new Error('Provider disconnected after accepting the request'); }
    return propose(request, ctx);
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput(), { parallel: 1 });
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.deepEqual(progressOf(stopped).active, [{ dialogueId: 'late', stage: 'propose' }]);
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const progress = progressOf(await lab.get(draft.id));
    assert.equal(died, 1, 'the revision is not sent again');
    assert.deepEqual([progress.status, progress.processed, progress.excluded, progress.revised], ['complete', ['late', 'known'], [], ['late']]);
    assert.deepEqual(await statuses(lab, draft.id), ['unusable', 'ready'], 'the blocked card keeps its place and its reason');
  });
});

test('the consented ceiling holds each situation\'s revision, and the consent says so', () => {
  const sources = [{ id: 'source-1', name: 'Правила', content: policy, hash: 'h' }];
  const one = preparationCeiling({ task: 'Проверить', sources, situations: 1, fromLogs: false });
  assert.equal(PROPOSAL_ATTEMPTS, 6, 'five calls to write the card and one to revise it');
  assert.equal(one, PROPOSAL_ATTEMPTS + 2 * 2, 'the allowance, the card\'s review and its revision\'s');
  assert.equal(preparationCeiling({ task: 'Проверить', sources, situations: 3, fromLogs: false }), 3 * (PROPOSAL_ATTEMPTS + 4));
  const consent = consentText({ conversations: 2, usable: 2, promised: 2, excluded: [], callCeiling: 21, topicMapCalls: 0, prompts: { count: 0, bytes: 0 } }, 'логов');
  assert.match(consent.lines.at(-1)!, /одна переделка каждой ситуации/);
  assert.match(rulesConsentText(2, 21).lines.at(-1)!, /одна переделка каждой ситуации/);
});

/** The `late` customer cannot say what they want: the card says so, and its duty is to clarify, citing the owner's rule. */
const clarifyQuote = 'Если номера нет, уточните номер терминала.';
const vagueLate: DialogueProposal = { ...proposals.late, clarity: 'vague', wants: 'Не может сформулировать, в чём дело: упоминает возврат, номер терминала не назвал',
  agentMust: [{ text: 'уточнить номер терминала, не угадывая порядок возврата', appliesWhen: null, observation: 'reply',
    basis: [{ sourceId: 'source-1', quote: clarifyQuote, rule: 'Без номера терминала агент сначала уточняет его.', kind: 'behavior' }] },
    proposals.late.agentMust[1]!] };

test('a vague customer is a situation: its card is marked vague, its duty cites a rule, and the result counts it apart', async () => {
  const runtime = cardRuntime(received());
  const propose = runtime.proposeCard!;
  runtime.proposeCard = async (request, ctx) => {
    const answer = await propose(request, ctx);
    return request.call.source.kind === 'dialogue' && request.call.source.dialogueId === 'late' ? vagueLate : answer;
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput(), { parallel: 1 });
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    assert.deepEqual(library.cards.map(card => [card.clarity, card.agentMust[0]!.requirementIds]),
      [['vague', [citationId('source-1', clarifyQuote)]], [undefined, [citationId('source-1', proposals.known.agentMust[0]!.basis[0]!.quote)]]],
      'a clear request is written as every card before the field was');
    assert.deepEqual(await statuses(lab, draft.id), ['ready', 'ready']);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment), requireAccepted: true });
    await lab.waitForIdle();
    const view = buildResultView(await lab.get(draft.id));
    assert.deepEqual(view.clarity, { clear: { passed: 0, decided: 1 }, vague: { passed: 1, decided: 1 } });
    assert.deepEqual(realityParts(view), ['Внятные запросы: 0 из 1', 'Невнятные: 1 из 1']);
  });
});

test('old cards and checkpoints parse as stored: no clarity, no revision', () => {
  const card = cardSchema.parse({ id: 'card_old', number: 1, title: 'Старая', topic: 'Возврат', origin: { kind: 'rules', requirementIds: ['refund_rule'] },
    client: { wants: 'Вернуть оплату', writes: 'Как вернуть оплату?', writesSource: { kind: 'model' }, knows: [], leaves: 'получил ответ' },
    agentMust: [{ id: 'e1', text: 'объяснить возврат', requirementIds: ['refund_rule'], observation: 'reply' }], coverage: [], revision: 1 });
  assert.equal(card.clarity, undefined);
  const progress = preparationProgressSchema.parse({ protocol: 'cards-v1', inputHash: 'a'.repeat(64), status: 'complete', pending: [], processed: ['late'], excluded: [], groundingComplete: true });
  assert.equal((progress as CardPreparation).revised, undefined);
});
