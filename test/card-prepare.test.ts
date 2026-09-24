import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, materialSources, type Experiment } from '../src/contracts.js';
import type { GroundingInput, Runtime } from '../src/runtime.js';
import { preparationCeiling, promptGroundingCalls } from '../src/card/budget.js';
import type { DialogueProposal } from '../src/card/proposal.js';
import { compileCard } from '../src/card/compile.js';
import { pendingReviewCalls, storedEvidence } from '../src/card/prepare.js';
import { preparationProgressSchema, type CardPreparation, type LibraryV2 } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { scenarioSources } from '../src/judge.js';
import { consentText } from '../src/miner/plan.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash, verifyAcceptedRun } from '../src/scenario-library.js';
import { cardInput, cardRuntime, policy, proposals, refundRule, type Received } from './helpers/card-prep.js';

/*
 * C9: preparing cards — the dialogues to prepare, the rules read for them, a proposal, binding and checks, the
 * reviewer's claims — resumes by units of work and never repeats a paid call whose cost is unknown. Accepting
 * compiles each card once and seals it; the run and the result read the sealed definitions.
 */

async function withLab(runtime: Runtime, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-cards-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}
const received = (): Received => ({ proposals: [], reviews: [], grounding: 0 });
const progressOf = (record: Experiment) => record.preparationProgress as CardPreparation;
const proposedFor = (seen: Received) => seen.proposals.map(request => request.call.source.kind === 'dialogue' ? request.call.source.dialogueId : request.call.source.unit);
async function statuses(lab: ExperimentLab, id: string) {
  const { library, experiment } = await lab.readCards(id);
  return [...cardStatuses({ library, evidence: await storedEvidence(lab.store, library), maxTurns: experiment.settings.maxTurns }).values()].map(item => item.status);
}
/** A stopped preparation's draft with a larger limit, as the owner raises it before continuing: a resume is bounded by the draft's limit. */
async function raiseBudget(lab: ExperimentLab, id: string): Promise<LibraryV2> {
  const draft = await lab.get(id);
  await lab.updateDraft(id, draftHash(draft), { settings: { maxCalls: 40 } });
  return (await lab.readCards(id)).library;
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
    assert.deepEqual([seen.grounding, proposedFor(seen), seen.reviews.length, experiment.usage.calls], [1, ['late', 'known'], 2, 5], 'the rules are read once; one proposal and one review per dialogue');
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

test('open grounding questions do not block an accepted card set: each card was reviewed and asked on its own', async () => {
  await withLab(cardRuntime(received()), async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    // Grounding a large knowledge base per dialogue leaves questions like these on the record (the owner's live run had 12).
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
  // The first proposal needs three repairs, so the preparation's five calls end right before its review. One unit at a
  // time: the second dialogue's step never starts beside the first.
  runtime.proposeCard = async (request, ctx) => {
    if (!seen.proposals.length) for (let repair = 0; repair < 3; repair++) ctx.beforeCall();
    return propose(request, ctx);
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput(), { callCeiling: 5, parallel: 1 });
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.match(stopped.error ?? '', /budget exhausted/);
    const progress = progressOf(stopped);
    assert.deepEqual([progress.pending, progress.active, progress.generationAttempts], [['late', 'known'], undefined, [{ dialogueId: 'late', calls: 4 }]],
      'the budget stops a step before its next request: nothing is in doubt');
    assert.deepEqual(await statuses(lab, draft.id), ['checking']);
    const library = await raiseBudget(lab, draft.id);
    await lab.resumePreparation(draft.id, libraryHash(library));
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.equal(resumed.error, null);
    assert.deepEqual([proposedFor(seen), seen.reviews.length, seen.grounding], [['late', 'known'], 2, 1], 'the card of the first dialogue is not proposed again, the rules are not read again');
    assert.deepEqual(progressOf(resumed).generationAttempts, [{ dialogueId: 'late', calls: 4 }, { dialogueId: 'known', calls: 1 }]);
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
    const draft = await lab.create(cardInput(), { callCeiling: 5 });
    await lab.waitForIdle();
    assert.equal(spent, 4, 'the preparation\'s ceiling ran out first');
    await lab.resumePreparation(draft.id, libraryHash(await raiseBudget(lab, draft.id)));
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.equal(spent, 5, 'one call was left of the allowance');
    const progress = progressOf(resumed);
    assert.deepEqual(progress.generationAttempts?.find(item => item.dialogueId === 'late'), { dialogueId: 'late', calls: 5 });
    assert.match(progress.excluded.find(item => item.dialogueId === 'late')?.reason ?? '', /исчерпаны 5 попыток/);
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

test('the grounding of the whole policy that died in flight cannot be continued: a resume refuses', async () => {
  const runtime = cardRuntime();
  let grounding = 0;
  runtime.groundRequirements = async (_input, ctx) => { ctx.beforeCall(); grounding++; throw new Error('Provider disconnected after accepting the request'); };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.deepEqual(progressOf(stopped).active, [{ stage: 'ground' }]);
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    assert.match((await lab.get(draft.id)).error ?? '', /чтения правил владельца/);
    assert.equal(grounding, 1);
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

/** A large knowledge base beside 40 of the agent's prompts: canned replies of about 3 KB each, far more than one call holds. */
const promptMaterials = [{ name: 'Правила возвратов', content: policy },
  { name: 'Доставка', content: 'Условия доставки по городу и области. '.repeat(4800) }, { name: 'Гарантия', content: 'Гарантийный ремонт и обслуживание. '.repeat(4800) },
  ...Array.from({ length: 40 }, (_, index) => ({ name: `reply_${index + 1}`, content: `Ответ клиенту номер ${index + 1}. ${'Сообщите сроки. '.repeat(400)}`, kind: 'prompt' as const }))];

/**
 * The fixture runtime on the prompts: a chunk of prompts yields one rule per prompt, a dialogue's grounding finds the
 * refund rule in its article and names the first agent rule offered, and the proposal cites that agent rule in its second duty.
 */
function promptRuntime(seen: Received) {
  const runtime = cardRuntime(seen);
  const chunks: string[][] = [], focused: GroundingInput[] = [], catalogs: string[][] = [];
  runtime.selectSources = async (input, ctx) => { ctx.beforeCall(); catalogs.push(input.catalog.map(item => item.name)); return { sourceIds: ['source-1'] }; };
  runtime.groundRequirements = async (input, ctx) => {
    ctx.beforeCall();
    if (!input.focus) {
      chunks.push(input.sources.map(source => source.id));
      return { questions: [], requirements: input.sources.map(source => ({ id: `agent_${source.name}`, text: `Сообщить сроки (${source.name}).`, quote: source.content.slice(0, 20),
        sourceId: source.id, critical: true, observable: true, kind: 'behavior' as const })) };
    }
    focused.push(structuredClone(input));
    return { requirements: [{ ...refundRule, sourceId: input.sources[0]!.id }], questions: [], agentRuleIds: [input.focus.agentRules![0]!.id, 'not_offered'] };
  };
  const propose = runtime.proposeCard!;
  runtime.proposeCard = async (request, ctx) => {
    const proposal = await propose(request, ctx) as DialogueProposal;
    const agent = request.requirements.find(requirement => requirement.id.startsWith('agent_'));
    return agent ? { ...proposal, agentMust: proposal.agentMust.map((duty, index) => index === 1 ? { ...duty, requirementIds: [agent.id] } : duty) } : proposal;
  };
  return { runtime, chunks, focused, catalogs };
}
const promptIds = (record: Experiment) => record.sources.filter(source => source.kind === 'prompt').map(source => source.id);

test('the agent\'s prompts are grounded once, in chunks, and every dialogue is offered the agent\'s rules: a card cites one', async () => {
  const seen = received();
  const { runtime, chunks, focused, catalogs } = promptRuntime(seen);
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput({ materials: promptMaterials }));
    await lab.waitForIdle();
    const record = await lab.get(draft.id);
    assert.equal(record.error, null);
    const progress = progressOf(record);
    assert.deepEqual(progress.excluded, [], 'no dialogue is left out');
    assert.deepEqual(chunks.flat(), promptIds(record), 'every prompt is read once, in order, with no article');
    assert.ok(chunks.length > 1 && chunks.length < 40, `${chunks.length} calls for 40 prompts`);
    assert.deepEqual([progress.promptGrounding?.chunks, progress.promptGrounding?.done, progress.promptGrounding?.requirementIds.length], [chunks.length, chunks.length, 40]);
    assert.equal(promptGroundingCalls(record.task, record.sources), chunks.length, 'the consent counts exactly these calls');
    assert.ok(catalogs.length > 0 && catalogs.every(names => names.includes('Доставка') && !names.some(name => name.startsWith('reply_'))), 'the catalog is the articles alone');
    assert.deepEqual(focused.map(input => input.sources.map(source => source.id)), [['source-1'], ['source-1']], 'a dialogue reads its article, not the prompts again');
    assert.ok(focused.every(input => input.focus!.agentRules!.length === 40 && input.focus!.agentRules!.every(rule => rule.id.startsWith('agent_') && rule.text.length <= 200)));
    assert.deepEqual(progress.focus, [{ dialogueId: 'late', requirementIds: ['refund_rule'], agentRuleIds: ['agent_reply_1'] },
      { dialogueId: 'known', requirementIds: ['refund_rule'], agentRuleIds: ['agent_reply_1'] }], 'only an offered agent rule is kept');
    assert.deepEqual(seen.proposals.map(request => [request.requirements.map(item => item.id), request.articles.map(item => item.id)]),
      [[['agent_reply_1', 'refund_rule'], ['source-1']], [['agent_reply_1', 'refund_rule'], ['source-1']]], 'the proposal gets the agent rule, not the prompt text');
    const { library } = await lab.readCards(draft.id);
    assert.deepEqual(library.cards.map(card => card.agentMust.map(duty => duty.requirementIds)), [[['refund_rule'], ['agent_reply_1']], [['refund_rule'], ['agent_reply_1']]]);
  });
});

test('a resume continues the agent\'s prompts from the next chunk; a chunk that died in flight is never repeated silently', async () => {
  const seen = received();
  const { runtime, chunks } = promptRuntime(seen);
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput({ materials: promptMaterials }), { callCeiling: 1 });
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.match(stopped.error ?? '', /budget exhausted/);
    assert.deepEqual([progressOf(stopped).promptGrounding?.done, progressOf(stopped).active, chunks.length], [1, undefined, 1], 'the budget stops before the next chunk is sent');
    await lab.resumePreparation(draft.id, libraryHash(await raiseBudget(lab, draft.id)));
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.equal(resumed.error, null);
    assert.deepEqual(chunks.flat(), promptIds(resumed), 'the first chunk is not read again');
    assert.equal(progressOf(resumed).promptGrounding?.requirementIds.length, 40);
  });

  const ground = runtime.groundRequirements!;
  let sent = 0;
  runtime.groundRequirements = async (input, ctx) => {
    if (!input.focus && ++sent === 2) { ctx.beforeCall(); throw new Error('Provider disconnected after accepting the request'); }
    return ground(input, ctx);
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(cardInput({ materials: promptMaterials }));
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.deepEqual([progressOf(stopped).active, progressOf(stopped).promptGrounding?.done], [[{ stage: 'ground' }], 1]);
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    assert.match((await lab.get(draft.id)).error ?? '', /чтения правил владельца/);
    assert.equal(sent, 2, 'the chunk whose cost is unknown is not sent again');
  });
});

test('a checkpoint written before the prompts were grounded once parses as it was stored', () => {
  const stored = { protocol: 'cards-v1', inputHash: 'a'.repeat(64), status: 'partial', pending: ['known'], processed: ['late'], excluded: [], groundingComplete: false,
    sourceSelection: [{ dialogueId: 'late', sourceIds: ['source-1', 'source-4'] }], focus: [{ dialogueId: 'late', requirementIds: ['refund_rule'] }] };
  assert.deepEqual(preparationProgressSchema.parse(stored), stored);
});

test('the consent\'s ceiling holds the calls that read the agent\'s prompts, and the consent names them', () => {
  const sources = materialSources(promptMaterials);
  const articles = sources.filter(source => source.kind !== 'prompt');
  const calls = promptGroundingCalls('Проверить', sources);
  assert.ok(calls > 1);
  assert.equal(preparationCeiling({ task: 'Проверить', sources, situations: 2, fromLogs: true }), preparationCeiling({ task: 'Проверить', sources: articles, situations: 2, fromLogs: true }) + calls);
  assert.equal(preparationCeiling({ task: 'Проверить', sources, situations: 2, fromLogs: false }), preparationCeiling({ task: 'Проверить', sources: articles, situations: 2, fromLogs: false }), 'without logs no dialogue is read, nor the prompts for one');
  assert.equal(promptGroundingCalls('Проверить', materialSources([{ name: 'Правила возвратов', content: policy }, { name: 'prompt', content: 'Отвечайте вежливо.', kind: 'prompt' }])), 0, 'materials that fit one call are read whole');
  const text = consentText({ conversations: 2, usable: 2, promised: 2, topicMapCalls: 2, promptCalls: calls, callCeiling: 30, excluded: [] }, 'logs.jsonl');
  assert.equal(text.lines.at(-1), `Расход — не больше 30 вызовов модели на всю подготовку, из них 2 — на разметку тем, ${calls} — на правила из промптов агента. Это потолок, а не прогноз; агент не запускается.`);
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
    assert.deepEqual(progress.focus, [{ dialogueId: 'late', requirementIds: ['refund_rule'] }, { dialogueId: 'known', requirementIds: ['refund_rule'] }]);
    assert.deepEqual(stopped.requirements.map(item => item.id), ['refund_rule'], 'the same rule grounded for both dialogues is one rule');
    unavailable = false;
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const resumed = await lab.get(draft.id);
    assert.equal(resumed.error, null);
    // Each dialogue: two selection requests (titles, then the chosen articles' texts) and one grounding, once.
    assert.deepEqual([selections, seen.grounding], [['late', 'late', 'known', 'known'], 2]);
    const { library } = await lab.readCards(draft.id);
    assert.deepEqual(library.readingManifest.map(row => [row.dialogueId, row.sourceIds]), [['late', ['source-1']], ['known', ['source-1']]]);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    assert.deepEqual(scenarioSources(accepted.experiment, accepted.experiment.scenarios[0]!).map(source => source.id), ['source-1'], 'the judge reads the articles the card cites, not the whole base');
  });
});
