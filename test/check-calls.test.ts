import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_CALLS } from '../src/card/budget.js';
import { hostGrant } from '../src/card/commands.js';
import { pendingReviewCalls, storedEvidence } from '../src/card/prepare.js';
import type { DialogueProposal } from '../src/card/proposal.js';
import type { CardPreparation } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import type { Experiment } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { decisions } from '../src/inbox.js';
import { StructuredTaskError } from '../src/llm/structured.js';
import type { Runtime } from '../src/runtime.js';
import { libraryHash } from '../src/scenario-library.js';
import { queueDraft } from '../extensions/decisions.ts';
import { cardInput, cardRuntime, proposals, type Received } from './helpers/card-prep.js';

/*
 * The owner's check of a draft's situations reviews every open claim and makes the one revision a blocked card is owed
 * (card/prepare.ts reviewCards). What it may spend (card/check-calls.ts) — the «до N вызовов» of its button and the
 * number its budget question weighs — holds that revision too. Scripted runtimes, invented data; no model is called.
 */

async function withLab(runtime: Runtime, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-check-calls-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}
const received = (): Received => ({ proposals: [], reviews: [] });
const progressOf = (record: Experiment) => record.preparationProgress as CardPreparation;
const revisions = (seen: Received) => seen.proposals.filter(request => request.revision).length;
async function statuses(lab: ExperimentLab, id: string) {
  const { library, experiment } = await lab.readCards(id);
  return [...cardStatuses({ library, evidence: await storedEvidence(lab.store, library), maxTurns: experiment.settings.maxTurns }).values()].map(item => item.status);
}

/** The revised duty the model writes once it reads the reviewer's reason. */
const revisedLate: DialogueProposal = { ...proposals.late, agentMust: [proposals.late.agentMust[0]!,
  { ...proposals.late.agentMust[1]!, text: 'объяснить, как оформить возврат, после того как клиент назвал номер терминала' }] };

/** The reviewer blocks the second duty of the `late` card while it reads as first written; the revision it accepts. */
function blockingRuntime(seen: Received): Runtime {
  const runtime = cardRuntime(seen);
  const propose = runtime.proposeCard!, review = runtime.reviewCard!;
  runtime.proposeCard = async (request, ctx) => request.revision ? (ctx.beforeCall(), seen.proposals.push(structuredClone(request)), revisedLate) : propose(request, ctx);
  runtime.reviewCard = async (request, ctx) => {
    const answer = await review(request, ctx);
    const duty = request.payload.card.agentMust.find(item => item.id === 'e2');
    const blocked = request.payload.card.title === proposals.late.title && request.aliases.includes('expectation_e2') && duty?.text === proposals.late.agentMust[1]!.text;
    return blocked ? { ...answer, verdicts: { ...answer.verdicts, expectation_e2: { status: 'blocked', reason: 'Правило не требует повторно объяснять возврат.' } } } : answer;
  };
  return runtime;
}

test('a card whose review did not happen inside the preparation: the check\'s «до N вызовов» holds the revision the review may call for', async () => {
  const seen = received();
  const runtime = blockingRuntime(seen);
  // The reviewer's first answer inside the preparation never passes: the first card waits for the owner's check.
  const review = runtime.reviewCard!;
  let first = true;
  runtime.reviewCard = async (request, ctx) => {
    if (first) { first = false; ctx.beforeCall(); throw new StructuredTaskError('Проверка ситуации: the reviewer\'s answer did not pass its schema'); }
    return review(request, ctx);
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput(), { parallel: 1 });
    await lab.waitForIdle();
    const made = await lab.get(draft.id);
    assert.deepEqual(await statuses(lab, draft.id), ['checking', 'ready']);
    const { decision } = await lab.recheckCards(draft.id, { defer: true });
    // Its one review request, and — should the review block the card — the new card's proposal and its review.
    assert.deepEqual(decision, { action: 'skipped', pendingJobs: 1 + 1 + REVIEW_CALLS, remainingCalls: 60 });
    const queued = await queueDraft(lab, made);
    assert.equal(queued?.pendingCalls, 1 + 1 + REVIEW_CALLS, 'the chat and the board weigh the same number');
    const offer = decisions({ draft: queued! }).find(item => item.key === `check:${draft.id}`);
    assert.equal(offer?.choices[0]?.label, 'Проверить (до 4 вызовов модели)');

    await lab.checkCards(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const checked = await lab.get(draft.id);
    assert.deepEqual([checked.phase, checked.error, revisions(seen), await statuses(lab, draft.id)], ['review', null, 1, ['ready', 'ready']], 'the review blocked the card, and the check revised it');
    const spent = checked.usage.calls - made.usage.calls;
    assert.ok(spent <= 1 + 1 + REVIEW_CALLS, `the check spent ${spent} calls: no more than it said`);
    assert.equal((await lab.recheckCards(draft.id, { defer: true })).decision.action, 'not_needed', 'the revision owed is spent: nothing is left to check');
  });
});

test('a blocked card whose revision the preparation\'s ceiling cut short: the check is offered, with that revision in its estimate', async () => {
  const seen = received();
  await withLab(blockingRuntime(seen), async lab => {
    // The ceiling covers the first card's proposal and review; its revision is refused before it is sent.
    const draft = await lab.create(cardInput(), { callCeiling: 2, parallel: 1 });
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.deepEqual([stopped.phase, stopped.stop, revisions(seen)], ['review', 'budget', 0]);
    assert.deepEqual([await statuses(lab, draft.id), progressOf(stopped).revised], [['unusable'], undefined], 'the card is blocked, and its revision is still owed');
    // No claim is open, and yet the check has work: the revision, never a claim's review.
    const { decision } = await lab.recheckCards(draft.id, { defer: true });
    assert.deepEqual(decision, { action: 'skipped', pendingJobs: 1 + REVIEW_CALLS, remainingCalls: 60 });

    await lab.checkCards(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const checked = await lab.get(draft.id);
    assert.deepEqual([checked.phase, checked.error, revisions(seen), await statuses(lab, draft.id)], ['review', null, 1, ['ready']]);
    const spent = checked.usage.calls - stopped.usage.calls;
    assert.ok(spent <= 1 + REVIEW_CALLS, `the check spent ${spent} calls: no more than it said`);
    assert.equal((await lab.recheckCards(draft.id, { defer: true })).decision.action, 'not_needed');
  });
});

test('a card the owner changed is theirs: the check owes it no revision, and its estimate is its review alone', async () => {
  const seen = received();
  await withLab(blockingRuntime(seen), async lab => {
    const draft = await lab.create(cardInput(), { callCeiling: 2, parallel: 1 });
    await lab.waitForIdle();
    assert.equal((await lab.recheckCards(draft.id, { defer: true })).decision.action, 'skipped', 'the blocked card is owed its revision');
    const late = (await lab.readCards(draft.id)).library.cards[0]!;
    const edit = await lab.prepareCardCommand(draft.id, { kind: 'edit_expectation', cardId: late.id, expectationId: 'e2', text: 'объяснить, как оформить возврат, и назвать срок' }, { via: 'cli-yes' });
    await lab.applyCardCommand(draft.id, edit, hostGrant(edit, 'confirmed'));
    const { library, evidence } = await lab.cardContext(draft.id);
    const reviews = pendingReviewCalls(library, evidence);
    assert.ok(reviews > 0, 'the owner\'s wording opens a claim');
    assert.deepEqual((await lab.recheckCards(draft.id, { defer: true })).decision, { action: 'skipped', pendingJobs: reviews, remainingCalls: 60 },
      'no model writes the owner\'s card over: the check reviews it, and that is all');
  });
});
