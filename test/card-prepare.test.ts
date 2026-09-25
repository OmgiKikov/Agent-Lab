import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, materialSources, type Experiment } from '../src/contracts.js';
import type { Runtime } from '../src/runtime.js';
import { preparationBudget, preparationCeiling, promptLoad, promptsOversize } from '../src/card/budget.js';
import { citationId, type DialogueProposal } from '../src/card/proposal.js';
import { compileCard } from '../src/card/compile.js';
import { pendingReviewCalls, storedEvidence } from '../src/card/prepare.js';
import { preparationProgressSchema, type CardPreparation } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { CommandRefused, STOP_LABEL } from '../src/errors.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { StructuredTaskError } from '../src/llm/structured.js';
import { scenarioSources } from '../src/judge.js';
import { consentText } from '../src/miner/plan.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash, verifyAcceptedRun } from '../src/scenario-library.js';
import { cardInput, cardRuntime, policy, proposals, refundRule, type Received } from './helpers/card-prep.js';

/*
 * C9: preparing cards — the dialogues to prepare, the articles read for them, one proposal that cites the agent's
 * prompts and the articles directly, binding and checks, the reviewer's claims — resumes by units of work and never
 * repeats a paid call whose cost is unknown. Accepting compiles each card once and seals it; the run and the result
 * read the sealed definitions.
 */

async function withLab(runtime: Runtime, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-cards-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}
const received = (): Received => ({ proposals: [], reviews: [] });
const progressOf = (record: Experiment) => record.preparationProgress as CardPreparation;
const proposedFor = (seen: Received) => seen.proposals.map(request => request.call.source.kind === 'dialogue' ? request.call.source.dialogueId : request.call.source.unit);
async function statuses(lab: ExperimentLab, id: string) {
  const { library, experiment } = await lab.readCards(id);
  return [...cardStatuses({ library, evidence: await storedEvidence(lab.store, library), maxTurns: experiment.settings.maxTurns }).values()].map(item => item.status);
}
/**
 * Continues a preparation stopped at the ceiling the owner agreed to: that ceiling covers every resume, so without the
 * owner's word on a new one nothing is sent; with it, the preparation goes on up to it (lab/library.ts).
 */
async function resumeWithCeiling(lab: ExperimentLab, id: string, callCeiling = 40): Promise<void> {
  const { library } = await lab.readCards(id);
  await assert.rejects(lab.resumePreparation(id, libraryHash(library)), (error: Error) => error instanceof CommandRefused && /новый потолок/.test(error.message));
  await lab.resumePreparation(id, libraryHash(library), { callCeiling });
}

test('from logs to the number: import → cards → review → acceptance → run → result', async () => {
  const seen = received();
  await withLab(cardRuntime(seen), async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.equal(experiment.phase, 'review', experiment.error ?? '');
    const progress = progressOf(experiment);
    assert.deepEqual([progress.status, progress.processed, progress.pending, progress.excluded], ['complete', ['late', 'known'], [], []]);
    assert.deepEqual(library.cards.map(card => [card.number, card.title, card.client.writes]), [
      [1, 'Возврат оплаты — номер по просьбе', 'Помогите с возвратом.'], [2, 'Возврат оплаты — номер назван сразу', 'Номер терминала: 1234. Помогите с возвратом.']]);
    assert.deepEqual(library.readingManifest.map(row => [row.dialogueId, row.sourceIds, row.cardIds]), [['late', ['source-1'], [library.cards[0]!.id]], ['known', ['source-1'], [library.cards[1]!.id]]]);
    assert.deepEqual([proposedFor(seen), seen.reviews.length, experiment.usage.calls], [['late', 'known'], 2, 4], 'one proposal and one review per dialogue: no call writes the rules out first');
    assert.deepEqual(seen.proposals.map(request => request.call.sources.map(source => source.id)), [['source-1'], ['source-1']], 'each proposal reads the owner\'s materials in full');
    assert.deepEqual(experiment.requirements, [{ ...refundRule, sourceId: 'source-1' }], 'both cards cite one sentence: it is one rule of the library');
    assert.deepEqual(library.requirements, experiment.requirements);
    assert.deepEqual(library.cards.map(card => card.agentMust.map(duty => duty.requirementIds)), [[[refundRule.id], [refundRule.id]], [[refundRule.id], [refundRule.id]]]);
    assert.deepEqual(seen.proposals.map(request => request.topics), [[], ['Возврат оплаты']], 'a topic already used is offered as it is written');
    assert.deepEqual(await statuses(lab, draft.id), ['ready', 'ready']);

    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    const definitions = accepted.library.acceptance!.definitions;
    assert.deepEqual(definitions.map(item => item.definitionHash), accepted.experiment.scenarios.map(scenario => fingerprint(scenario)));
    assert.deepEqual(accepted.experiment.acceptedTests!.map(item => item.definitionHash), definitions.map(item => item.definitionHash));
    assert.equal(definitions[0]!.definitionHash, fingerprint(compileCard(library.cards[0]!, { requirements: library.requirements, maxTurns: experiment.settings.maxTurns })), 'compiled once, at acceptance, by the card compiler');
    verifyAcceptedRun(accepted.experiment);
    await assert.rejects(lab.acceptCards(draft.id, libraryHash(library), [library.cards[0]!.id]), /хеш устарел/, 'an acceptance is made on the draft the owner saw');

    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment), requireAccepted: true });
    await lab.waitForIdle();
    const finished = await lab.get(draft.id);
    assert.equal(finished.phase, 'results_review', finished.error ?? '');
    const view = buildResultView(finished);
    assert.deepEqual([view.headline.passed, view.headline.decided], [1, 2]);
    assert.deepEqual(view.cards.map(card => [card.title, card.outcome, card.parts.map(part => `${part.label} ${part.outcome}`)]), [
      ['Возврат оплаты — номер по просьбе', 'pass', ['А pass', 'Б pass']],
      ['Возврат оплаты — номер назван сразу', 'fail', ['А fail', 'Б fail']]]);
    const again = await lab.repeat(draft.id);
    verifyAcceptedRun(again);
    assert.deepEqual(again.scenarios.map(scenario => fingerprint(scenario)), definitions.map(item => item.definitionHash), 'a repeat runs the sealed definitions as they are');
  });
});

test('open questions an older preparation left on the record do not block an accepted card set: each card was reviewed on its own', async () => {
  await withLab(cardRuntime(received()), async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    // Grounding a large knowledge base per dialogue (cards-v1) left questions like these on the record (the owner's live run had 12).
    const withQuestions = { ...accepted.experiment, questions: ['Какой канал обслуживания у клиента?'] };
    await lab.store.save(withQuestions);
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(withQuestions) });
    await lab.waitForIdle();
    const finished = await lab.get(draft.id);
    assert.equal(finished.phase, 'results_review', finished.error ?? '');
    assert.deepEqual(finished.questions, withQuestions.questions, 'the questions stay on the record for the owner');
  });
});

test('a resume continues every unit from its next step: a card made before the budget ran out is only reviewed', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  const propose = runtime.proposeCard!;
  // The first proposal needs three repairs, so the preparation's four calls end right before its review. One unit at a
  // time: the second dialogue's step never starts beside the first.
  runtime.proposeCard = async (request, ctx) => {
    if (!seen.proposals.length) for (let repair = 0; repair < 3; repair++) ctx.beforeCall();
    return propose(request, ctx);
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput(), { callCeiling: 4, parallel: 1 });
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.deepEqual([stopped.phase, stopped.stop, stopped.error], ['review', 'budget', STOP_LABEL.budget], 'a budget stop is typed, and the owner reads it in their words');
    const progress = progressOf(stopped);
    assert.deepEqual([progress.pending, progress.active, progress.generationAttempts?.filter(item => item.calls > 0)], [['late', 'known'], undefined, [{ dialogueId: 'late', calls: 4 }]],
      'the budget stops a step before its next request: nothing is in doubt');
    assert.deepEqual([progress.callCeiling, progress.spentCalls], [4, 4], 'the checkpoint keeps the ceiling the owner agreed to and what the preparation spent');
    assert.deepEqual(preparationBudget(stopped), { ceiling: 4, spent: 4, left: 0, pending: 2, resume: 4 + 2 * (6 + 2 * 2) }, 'what is left, and what continuing needs, as data');
    assert.deepEqual(await statuses(lab, draft.id), ['checking']);
    await resumeWithCeiling(lab, draft.id);
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.deepEqual([resumed.error, resumed.stop], [null, undefined]);
    assert.deepEqual([proposedFor(seen), seen.reviews.length], [['late', 'known'], 2], 'the card of the first dialogue is not proposed again');
    assert.deepEqual(progressOf(resumed).generationAttempts, [{ dialogueId: 'late', calls: 4 }, { dialogueId: 'known', calls: 1 }]);
    assert.deepEqual([progressOf(resumed).callCeiling, progressOf(resumed).spentCalls], [40, 7], 'the new ceiling covers the whole preparation, the first launch included');
    assert.deepEqual(await statuses(lab, draft.id), ['ready', 'ready']);
  });
});

test('a paid call that died in flight is never repeated: its dialogue is left out, the others go on', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  const propose = runtime.proposeCard!;
  let died = 0;
  runtime.proposeCard = async (request, ctx) => {
    if (request.call.source.kind === 'dialogue' && request.call.source.dialogueId === 'late') { ctx.beforeCall(); died++; throw new Error('Provider disconnected after accepting the request'); }
    return propose(request, ctx);
  };
  await withLab(runtime, async lab => {
    // One unit at a time: the second dialogue waits for the resume (card-prepare-parallel.test.ts covers several at once).
    const draft = await lab.create(cardInput(), { parallel: 1 });
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.equal(stopped.phase, 'review');
    assert.match(stopped.error ?? '', /Provider disconnected/);
    assert.deepEqual(progressOf(stopped).active, [{ dialogueId: 'late', stage: 'propose' }], 'the call is named before it is sent');
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    const progress = progressOf(resumed);
    assert.equal(died, 1, 'the dialogue is not asked again');
    assert.deepEqual([progress.status, progress.pending, progress.processed], ['complete', [], ['late', 'known']]);
    assert.match(progress.excluded.find(item => item.dialogueId === 'late')?.reason ?? '', /стоимость неизвестна/);
    assert.deepEqual((await lab.readCards(draft.id)).library.cards.map(card => [card.number, card.origin]), [[1, { kind: 'dialogue', batchId: resumed.originalImport!.id, dialogueId: 'known' }]]);
  });
});

test('each dialogue has one allowance of proposal calls, repairs included, and a resume does not renew it', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  const propose = runtime.proposeCard!;
  let spent = 0;
  // The model never gets the first dialogue right: every request is charged, none is accepted.
  runtime.proposeCard = async (request, ctx) => {
    if (request.call.source.kind === 'dialogue' && request.call.source.dialogueId === 'late') for (;;) { ctx.beforeCall(); spent++; }
    return propose(request, ctx);
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput(), { callCeiling: 4 });
    await lab.waitForIdle();
    assert.equal(spent, 4, 'the preparation\'s ceiling ran out first');
    await resumeWithCeiling(lab, draft.id);
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.equal(spent, 6, 'two calls were left of the allowance');
    const progress = progressOf(resumed);
    assert.deepEqual(progress.generationAttempts?.find(item => item.dialogueId === 'late'), { dialogueId: 'late', calls: 6 });
    assert.match(progress.excluded.find(item => item.dialogueId === 'late')?.reason ?? '', /исчерпаны 6 попыток/);
    assert.deepEqual((await lab.readCards(draft.id)).library.cards.length, 1, 'the other dialogue still becomes a card');
  });
});

test('without logs: situations from the owner\'s rules, each different, the opening written by the model', async () => {
  const seen = received();
  await withLab(cardRuntime(seen), async lab => {
    const draft = await lab.create(cardInput({ dialogues: [], scenarioCount: 2 }));
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.equal(experiment.error, null);
    assert.deepEqual(progressOf(experiment).processed, ['rules_1', 'rules_2']);
    assert.deepEqual(proposedFor(seen), ['rules_1', 'rules_2']);
    assert.deepEqual(seen.proposals.map(request => request.written), [[], ['Возврат без логов 1']], 'the next situation knows the ones already written');
    assert.deepEqual(library.cards.map(card => [card.origin.kind, card.client.writesSource.kind, card.client.knows.length, card.coverage.length]), [['rules', 'model', 0, 0], ['rules', 'model', 0, 0]]);
    assert.deepEqual(seen.reviews.map(request => request.aliases), [['goal', 'expectation_e1', 'leak'], ['goal', 'expectation_e1', 'leak']]);
    assert.deepEqual(await statuses(lab, draft.id), ['ready', 'ready']);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    assert.deepEqual(accepted.experiment.scenarios.map(scenario => scenario.provenance), ['curated', 'curated']);
  });
});

test('a draft the previous Lab prepared (cards-v1) is not continued, but its cards are still checked', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  const review = runtime.reviewCard!;
  let first = true;
  runtime.reviewCard = async (request, ctx) => {
    if (first) { first = false; ctx.beforeCall(); throw new StructuredTaskError('the reviewer\'s answer did not pass its schema'); }
    return review(request, ctx);
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput({ dialogues: [...cardInput().dialogues, { id: 'third', messages: [{ role: 'user', content: 'Помогите с возвратом.' }] }] }), { callCeiling: 4 });
    await lab.waitForIdle();
    const made = await lab.get(draft.id);
    // The checkpoint as the previous Lab wrote it: the policy grounded once, a dialogue still waiting.
    const previous = { ...progressOf(made), protocol: 'cards-v1' as const, groundingComplete: true };
    await lab.store.save({ ...made, error: null, preparationProgress: previous });
    const library = (await lab.readCards(draft.id)).library;
    assert.deepEqual(previous.pending, ['third']);
    await assert.rejects(lab.resumePreparation(draft.id, libraryHash(library)), /Эта подготовка сделана прежней версией Lab — подготовьте заново\./);
    assert.deepEqual(proposedFor(seen), ['late', 'known'], 'nothing is proposed again');
    await lab.checkCards(draft.id, libraryHash(library));
    await lab.waitForIdle();
    assert.deepEqual(await statuses(lab, draft.id), ['ready', 'ready'], 'the explicit check reads the stored rules the cards cite, however they were written out');
  });
});

test('a review that died in flight keeps its card unchecked; only the owner\'s explicit check asks again', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  const review = runtime.reviewCard!;
  let first = true;
  runtime.reviewCard = async (request, ctx) => {
    if (first) { first = false; ctx.beforeCall(); throw new Error('Provider disconnected after accepting the request'); }
    return review(request, ctx);
  };
  await withLab(runtime, async lab => {
    // One unit at a time: the second dialogue is prepared on the resume, after the first one's review died.
    const draft = await lab.create(cardInput(), { parallel: 1 });
    await lab.waitForIdle();
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.deepEqual([progressOf(resumed).processed, progressOf(resumed).excluded], [['late', 'known'], []], 'the card of the first dialogue stays');
    assert.deepEqual(await statuses(lab, draft.id), ['checking', 'ready']);
    const { library } = await lab.readCards(draft.id);
    assert.equal(pendingReviewCalls(library, await storedEvidence(lab.store, library)), 1);
    assert.equal(seen.reviews.length, 1, 'the resume did not ask the reviewer again');
    await lab.checkCards(draft.id, libraryHash(library));
    await lab.waitForIdle();
    assert.deepEqual(await statuses(lab, draft.id), ['ready', 'ready']);
    assert.deepEqual(seen.reviews.map(request => request.aliases.length), [5, 6], 'the explicit check asked the first card\'s claims, once');
  });
});

test('an answer the harness cannot bind is never kept, whatever the runtime says', async () => {
  const runtime = cardRuntime();
  const propose = runtime.proposeCard!;
  runtime.proposeCard = async (request, ctx) => request.call.source.kind === 'dialogue' && request.call.source.dialogueId === 'late'
    ? (ctx.beforeCall(), { ...proposals.late, knows: [{ ...proposals.late.knows[0]!, value: '5679' }] }) : propose(request, ctx);
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.match(progressOf(experiment).excluded.find(item => item.dialogueId === 'late')?.reason ?? '', /не прошла проверку: knows\[0\] "Номер терминала": the value "5679"/);
    assert.deepEqual(library.cards.map(card => card.number), [1]);
  });
});

/** A large knowledge base beside ten of the agent's prompts: the articles are chosen per dialogue, the prompts read with every one. */
const promptMaterials = [{ name: 'Правила возвратов', content: policy },
  { name: 'Доставка', content: 'Условия доставки по городу и области. '.repeat(4800) }, { name: 'Гарантия', content: 'Гарантийный ремонт и обслуживание. '.repeat(4800) },
  ...Array.from({ length: 10 }, (_, index) => ({ name: `reply_${index + 1}`, content: `Ответ клиенту номер ${index + 1}. Не обещай перезвонить, если можешь ответить сразу. ${'Сообщите сроки. '.repeat(40)}`, kind: 'prompt' as const }))];
const PROMPT_SENTENCE = 'Ответ клиенту номер 1. Не обещай перезвонить, если можешь ответить сразу.';

/** The fixture runtime on the prompts: the refund article is chosen for every dialogue, and the second duty cites the first prompt's sentence. */
function promptRuntime(seen: Received) {
  const runtime = cardRuntime(seen);
  const catalogs: string[][] = [];
  runtime.selectSources = async (input, ctx) => { ctx.beforeCall(); catalogs.push(input.catalog.map(item => item.name)); return { sourceIds: ['source-1'] }; };
  const propose = runtime.proposeCard!;
  runtime.proposeCard = async (request, ctx) => {
    const proposal = await propose(request, ctx) as DialogueProposal;
    const prompt = request.call.sources.find(source => source.kind === 'prompt')!;
    return { ...proposal, agentMust: proposal.agentMust.map((duty, index) => index === 1
      ? { ...duty, basis: [...duty.basis, { sourceId: prompt.id, quote: PROMPT_SENTENCE, rule: 'Отвечать сразу, не обещая перезвонить.', kind: 'behavior' as const }] } : duty) };
  };
  return { runtime, catalogs };
}
const promptIds = (record: Experiment) => record.sources.filter(source => source.kind === 'prompt').map(source => source.id);

test('every proposal reads all the agent\'s prompts and the articles chosen for its dialogue, and a card cites a prompt and an article directly', async () => {
  const seen = received();
  const { runtime, catalogs } = promptRuntime(seen);
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput({ materials: promptMaterials }));
    await lab.waitForIdle();
    const record = await lab.get(draft.id);
    assert.equal(record.error, null);
    assert.deepEqual(progressOf(record).excluded, [], 'no dialogue is left out');
    assert.ok(catalogs.length > 0 && catalogs.every(names => names.includes('Доставка') && !names.some(name => name.startsWith('reply_'))), 'the catalog is the articles alone');
    assert.deepEqual(seen.proposals.map(request => request.call.sources.map(source => source.id)), [[...promptIds(record), 'source-1'], [...promptIds(record), 'source-1']],
      'the prompts first, then the article chosen for the dialogue');
    const prompt = promptIds(record)[0]!;
    const promptRule = citationId(prompt, PROMPT_SENTENCE);
    assert.deepEqual(record.requirements.map(item => [item.id, item.sourceId, item.kind]), [[refundRule.id, 'source-1', 'behavior'], [promptRule, prompt, 'behavior']],
      'one rule per cited sentence, in the source it is quoted from; two cards citing it share it');
    const { library } = await lab.readCards(draft.id);
    assert.deepEqual(library.cards.map(card => card.agentMust.map(duty => duty.requirementIds)), [[[refundRule.id], [refundRule.id, promptRule]], [[refundRule.id], [refundRule.id, promptRule]]]);
    assert.deepEqual(library.readingManifest.map(row => row.sourceIds), [[...promptIds(record), 'source-1'], [...promptIds(record), 'source-1']], 'the reading row is what the proposal read');
    assert.equal(progressOf(record).promptGrounding, undefined, 'no step reads the prompts apart');
  });
});

test('a proposal over the request\'s cap gives up its last articles first; the agent\'s prompts and the customer\'s messages never', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  runtime.selectSources = async (_input, ctx) => { ctx.beforeCall(); return { sourceIds: ['source-1', 'source-2'] }; };
  // Two chosen articles of about 45 KB each beside prompts of about 160 KB: together they overflow one request.
  const materials = [{ name: 'Правила возвратов', content: `${policy} ${'Подробности возврата. '.repeat(1100)}` },
    { name: 'Доставка', content: 'Условия доставки по городу и области. '.repeat(650) }, { name: 'Гарантия', content: 'Гарантийный ремонт и обслуживание. '.repeat(9000) },
    ...Array.from({ length: 4 }, (_, index) => ({ name: `reply_${index + 1}`, content: `Ответ ${index + 1}. ${'Сообщите сроки. '.repeat(1400)}`, kind: 'prompt' as const }))];
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput({ materials }));
    await lab.waitForIdle();
    const record = await lab.get(draft.id);
    assert.equal(record.error, null);
    assert.deepEqual(seen.proposals.map(request => request.call.sources.map(source => source.id)), [[...promptIds(record), 'source-1'], [...promptIds(record), 'source-1']]);
    assert.deepEqual(progressOf(record).sourceSelection, [{ dialogueId: 'late', sourceIds: ['source-1'] }, { dialogueId: 'known', sourceIds: ['source-1'] }], 'the articles kept are the dialogue\'s reading');
  });
});

test('prompts too large for any request refuse the preparation before a single call, in the owner\'s words', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  let calls = 0;
  runtime.selectSources = async (_input, ctx) => { ctx.beforeCall(); calls++; return { sourceIds: [] }; };
  const materials = [{ name: 'Правила возвратов', content: policy },
    ...Array.from({ length: 3 }, (_, index) => ({ name: `reply_${index + 1}`, content: `Ответ ${index + 1}. ${'Сообщите сроки и условия. '.repeat(3500)}`, kind: 'prompt' as const }))];
  const refusal = promptsOversize('Проверить', materialSources(materials))!;
  assert.match(refusal, /^Промпты агента занимают \d+ КБ, а в один запрос модели помещается 240 КБ вместе с разговором\. .*ничего не потрачено\. Выберите меньше промптов/);
  await withLab(runtime, async lab => {
    await assert.rejects(lab.create(cardInput({ materials })), error => error instanceof Error && error.message === refusal);
    assert.deepEqual([calls, seen.proposals.length, (await lab.list()).length], [0, 0, 0], 'nothing is spent and no draft is written');
  });
  assert.equal(promptsOversize('Проверить', materialSources(promptMaterials)), undefined, 'prompts that fit are read whole');
});

test('a checkpoint written by the previous Lab (cards-v1) parses as it was stored', () => {
  const stored = { protocol: 'cards-v1', inputHash: 'a'.repeat(64), status: 'partial', pending: ['known'], processed: ['late'], excluded: [], groundingComplete: false,
    promptGrounding: { chunks: 2, done: 1, requirementIds: ['agent_reply_1'] },
    sourceSelection: [{ dialogueId: 'late', sourceIds: ['source-1', 'source-4'] }], focus: [{ dialogueId: 'late', requirementIds: ['refund_rule'], agentRuleIds: ['agent_reply_1'] }] };
  assert.deepEqual(preparationProgressSchema.parse(stored), stored);
});

test('the consent\'s ceiling holds per situation its choice of articles, its proposals and its review, and the consent names the prompts\' size', () => {
  const sources = materialSources(promptMaterials);
  assert.equal(preparationCeiling({ task: 'Проверить', sources, situations: 2, fromLogs: true }), 2 * (2 + 6 + 2 * 2), 'two choices of articles, six proposals (one of them the revision), the reviews of the card and of its revision');
  assert.equal(preparationCeiling({ task: 'Проверить', sources, situations: 2, fromLogs: false }), 2 * (6 + 2 * 2), 'without logs no dialogue picks articles');
  assert.equal(preparationCeiling({ task: 'Проверить', sources: materialSources([{ name: 'Правила возвратов', content: policy }]), situations: 2, fromLogs: true, topicMapCalls: 3 }), 3 + 2 * 10,
    'materials that fit one call are read whole: no choice of articles');
  const prompts = promptLoad(sources);
  assert.equal(prompts.count, 10);
  const text = consentText({ conversations: 2, usable: 2, promised: 2, topicMapCalls: 2, prompts, callCeiling: 30, excluded: [], asksAgent: false }, 'logs.jsonl');
  assert.deepEqual(text.lines.slice(-2), [`Промпты агента — 10 промптов, ${Math.ceil(prompts.bytes / 1000)} КБ — читаются целиком с каждым разговором.`,
    'Расход — не больше 30 вызовов модели на всю подготовку, из них 2 — на разметку тем. Сюда входит одна переделка каждой ситуации, которую не пропустила проверка. Это потолок, а не прогноз; агент не запускается.']);
  const none = consentText({ conversations: 2, usable: 2, promised: 2, topicMapCalls: 0, prompts: { count: 0, bytes: 0 }, callCeiling: 14, excluded: [], asksAgent: false }, 'logs.jsonl');
  assert.ok(!none.lines.some(line => line.startsWith('Промпты')), 'no prompts, no line');
});

test('a large knowledge base is read per dialogue: the articles and the rules chosen for a dialogue are kept and never paid for twice', async () => {
  const seen = received();
  const runtime = cardRuntime(seen);
  const selections: string[] = [];
  runtime.selectSources = async (input, ctx) => { ctx.beforeCall(); selections.push(input.dialogue.id); return { sourceIds: ['source-1'] }; };
  const propose = runtime.proposeCard!;
  let unavailable = true;
  // The provider is unreachable before any request for the second dialogue: nothing is charged, the dialogue waits.
  runtime.proposeCard = async (request, ctx) => {
    if (unavailable && request.call.source.kind === 'dialogue' && request.call.source.dialogueId === 'known') throw new Error('Провайдер недоступен.');
    return propose(request, ctx);
  };
  const materials = [{ name: 'Правила возвратов', content: policy },
    { name: 'Доставка', content: 'Условия доставки по городу и области. '.repeat(4800) }, { name: 'Гарантия', content: 'Гарантийный ремонт и обслуживание. '.repeat(4800) }];
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput({ materials }));
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.match(stopped.error ?? '', /Не удалось разобрать 1 источник — вызов модели не состоялся: Провайдер недоступен\./);
    const progress = progressOf(stopped);
    assert.deepEqual([progress.pending, progress.processed], [['known'], ['late']]);
    assert.deepEqual(progress.sourceSelection, [{ dialogueId: 'late', sourceIds: ['source-1'] }, { dialogueId: 'known', sourceIds: ['source-1'] }]);
    assert.equal(progress.focus, undefined, 'no rules are written out for a dialogue');
    assert.deepEqual(stopped.requirements.map(item => item.id), [refundRule.id], 'the sentence the first card cites is its rule');
    unavailable = false;
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.equal(resumed.error, null);
    // Each dialogue: two selection requests (titles, then the chosen articles' texts), once; then its one proposal.
    assert.deepEqual([selections, proposedFor(seen)], [['late', 'late', 'known', 'known'], ['late', 'known']]);
    assert.deepEqual(resumed.requirements.map(item => item.id), [refundRule.id], 'the second card cites the same sentence: still one rule');
    const { library } = await lab.readCards(draft.id);
    assert.deepEqual(library.readingManifest.map(row => [row.dialogueId, row.sourceIds]), [['late', ['source-1']], ['known', ['source-1']]]);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    assert.deepEqual(scenarioSources(accepted.experiment, accepted.experiment.scenarios[0]!).map(source => source.id), ['source-1'], 'the judge reads the articles the card cites, not the whole base');
  });
});
