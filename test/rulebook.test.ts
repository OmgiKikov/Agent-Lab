import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceBundle } from '../src/artifacts.js';
import { hostGrant } from '../src/card/commands.js';
import { storedEvidence } from '../src/card/prepare.js';
import { cardProposalSchema } from '../src/card/proposal.js';
import { bindsBot, DEFAULT_RULEBOOK, rulebookLines, rulebookOf, rulebookView, shownRulebook, withKind, withRules } from '../src/card/rulebook.js';
import { libraryV2Schema, type CardCommand } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { experimentSchema, fingerprint, type Requirement } from '../src/contracts.js';
import { CommandRefused } from '../src/errors.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { markdownReport } from '../src/report.js';
import { plainText, resultScreen } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import type { Runtime } from '../src/runtime.js';
import { libraryHash, verifyAcceptedRun } from '../src/scenario-library.js';
import { cardInput, cardRuntime, policy, proposals, refundRule, type Received } from './helpers/card-prep.js';
import { openWorkspace } from './helpers/workspace.js';

/*
 * W1 «Свод правил»: the grounding types every rule; the rulebook says which kinds bind the bot. An operator procedure the
 * owner did not include stays in the library but is never offered to the proposal and cannot be cited; including it —
 * one rule or the whole kind — is an owner command with a receipt and a new revision; taking it back sends the cards that
 * cite it to the owner. A result names the bar it was judged by. Stored libraries without kinds read exactly as before.
 */

const OPERATOR_QUOTE = 'Если номера нет, уточните номер терминала.';
const operatorRule: Omit<Requirement, 'sourceId'> = { id: 'op_rule', text: 'Оператор уточняет номер терминала, если его нет.', quote: OPERATOR_QUOTE, critical: false, kind: 'operator_procedure' };
const received = (): Received => ({ proposals: [], reviews: [], grounding: 0 });

/** The fixture runtime whose grounding typed its rules: the refund rule is the bot's behaviour, the other an operator's step. */
function typedRuntime(seen: Received): Runtime {
  return { ...cardRuntime(seen), async groundRequirements(input, ctx) {
    ctx.beforeCall(); seen.grounding++;
    const sourceId = input.sources[0]!.id;
    return { requirements: [{ ...refundRule, kind: 'behavior', sourceId }, { ...operatorRule, sourceId }], questions: [] };
  } };
}

async function withLab(runtime: Runtime, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-rulebook-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}
async function statuses(lab: ExperimentLab, id: string) {
  const { library, experiment } = await lab.readCards(id);
  return cardStatuses({ library, evidence: await storedEvidence(lab.store, library), maxTurns: experiment.settings.maxTurns });
}
async function command(lab: ExperimentLab, id: string, raw: Parameters<ExperimentLab['prepareCardCommand']>[1]) {
  const prepared = await lab.prepareCardCommand(id, raw, { via: 'cli-yes' });
  const applied = await lab.applyCardCommand(id, prepared, hostGrant(prepared, 'confirmed'));
  return { prepared, library: applied.library };
}

test('an operator procedure the owner did not include is never offered and cannot be cited; included, it binds; taken back, its cards return to the owner', async () => {
  const seen = received();
  await withLab(typedRuntime(seen), async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    assert.deepEqual(library.requirements.map(item => [item.id, item.kind]), [['refund_rule', 'behavior'], ['op_rule', 'operator_procedure']], 'the kinds are stored with the rules');
    assert.equal(library.rulebook, undefined, 'a new draft keeps the default rulebook implicit');
    assert.ok(seen.proposals.length === 2 && seen.proposals.every(request => request.requirements.map(item => item.id).join() === 'refund_rule'
      && request.call.requirementIds.join() === 'refund_rule'), 'the proposal is offered only the rules that bind the bot');
    const citing = { ...proposals.late, agentMust: [{ ...proposals.late.agentMust[0]!, requirementIds: ['op_rule'] }] };
    assert.equal(cardProposalSchema(seen.proposals[0]!.call).safeParse(citing).success, false, 'the model cannot cite a rule outside the rulebook');
    assert.deepEqual(rulebookLines(rulebookView(library)), [
      'Свод правил: бота судят по 1 из 2 правил',
      '  ✓ правила поведения бота: 1 — входят',
      '  ✓ сведения из базы знаний: 0 — входят',
      '  · инструкции для операторов: 1 — не входят',
      'Источники: промпт агента — 0 правил, база знаний — 2 правила',
    ]);

    const card = library.cards[0]!;
    const cite: CardCommand = { kind: 'edit_expectation', cardId: card.id, expectationId: 'e1', requirementIds: ['op_rule'] };
    await assert.rejects(lab.prepareCardCommand(draft.id, cite, { via: 'cli-yes' }),
      (error: unknown) => error instanceof CommandRefused && error.message.includes('инструкция для операторов') && error.message.includes('не входят в свод правил'));

    // The owner includes the one rule: a receipt, a new revision; nothing is sent back.
    const included = await command(lab, draft.id, { kind: 'set_rulebook', rulebook: withRules(DEFAULT_RULEBOOK, { include: ['op_rule'] }) });
    assert.deepEqual(included.prepared.rulebook, { before: DEFAULT_RULEBOOK, after: { kinds: ['behavior', 'knowledge'], included: ['op_rule'] }, flagged: [] });
    assert.equal(included.library.revision, library.revision + 1);
    assert.equal(included.library.receipts.at(-1)!.command.kind, 'set_rulebook');
    assert.ok(bindsBot(rulebookOf(included.library), operatorRule));
    await command(lab, draft.id, cite);
    await lab.recheckCards(draft.id); await lab.waitForIdle();
    assert.equal((await statuses(lab, draft.id)).get(card.id)!.status, 'ready', 'an included rule may back an expectation');
    await assert.rejects(command(lab, draft.id, { kind: 'set_rulebook', rulebook: rulebookOf(included.library) }), /Так уже записано/);

    // Taken back: the card whose expectation rests on it waits for the owner, and the question says which expectation lost its rule.
    const back = await command(lab, draft.id, { kind: 'set_rulebook', rulebook: DEFAULT_RULEBOOK });
    assert.deepEqual(back.prepared.rulebook!.flagged, [card.number]);
    const waiting = (await statuses(lab, draft.id)).get(card.id)!;
    assert.equal(waiting.status, 'needs_owner');
    assert.match(waiting.question!.text, /^Агент должен «не запрашивать номер терминала повторно, если клиент его уже назвал» — по правилу «Если номера нет, уточните номер терминала\.», а это инструкция для операторов/);
    assert.deepEqual(waiting.question!.choices.map(choice => choice.label), ['Да, бот обязан', 'Убрать это ожидание', 'Убрать ситуацию']);
    // «Да, бот обязан» is the rulebook with this rule included: the card is ready again.
    const answered = await command(lab, draft.id, { kind: 'answer_question', cardId: card.id, questionId: waiting.question!.id, choice: 'a' });
    assert.deepEqual(rulebookOf(answered.library).included, ['op_rule']);
    assert.equal((await statuses(lab, draft.id)).get(card.id)!.status, 'ready');

    // The whole kind, with one toggle: operator instructions bind as a kind; the owner's single inclusion stays theirs.
    const operators = await command(lab, draft.id, { kind: 'set_rulebook', rulebook: withKind(rulebookOf(answered.library), 'operator_procedure', true) });
    assert.deepEqual(rulebookOf(operators.library), { kinds: ['behavior', 'knowledge', 'operator_procedure'], included: ['op_rule'] });
    assert.equal(shownRulebook(operators.library)!.binding, 2);
  });
});

test('a result names the bar it was judged by; a run whose rules have no kinds names none', async () => {
  for (const typed of [true, false]) await withLab(typed ? typedRuntime(received()) : cardRuntime(received()), async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    verifyAcceptedRun(accepted.experiment);
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment) });
    await lab.waitForIdle();
    const finished = await lab.get(draft.id);
    const bundle = await evidenceBundle(finished, lab.store);
    const screen = plainText(resultScreen(bundle.view, { surface: 'cli' }), 100);
    const line = 'Оценка по правилам: 0 из промпта агента, 1 из базы знаний (инструкции для операторов не входят)';
    if (typed) {
      assert.deepEqual(bundle.view.bar, { prompt: 0, knowledge: 1, operators: 'excluded', chosen: 0 });
      assert.ok(screen.includes(line), screen);
      assert.ok(markdownReport(bundle).includes('Оценка по правилам: 0 из промпта агента, 1 из базы знаний'), 'the report states the same bar');
    } else {
      assert.equal(bundle.view.bar, null);
      assert.ok(!screen.includes('Оценка по правилам'), 'no bar is guessed for rules without kinds');
    }
  });
});

test('stored records and libraries without kinds parse unchanged and bind every rule as before', async () => {
  for (const file of ['recorded-run.json', 'legacy-demo-run.json', 'legacy-demo-draft.json', 'library-v1/run.json']) {
    const raw = JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
    const parsed = experimentSchema.parse(raw);
    assert.equal(fingerprint(parsed), fingerprint(raw), file);
    assert.equal(buildResultView(parsed).bar, null, `${file}: no bar for rules grounded before kinds`);
  }
  await withLab(cardRuntime(received()), async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const raw = JSON.parse(JSON.stringify((await lab.readCards(draft.id)).library));
    const parsed = libraryV2Schema.parse(raw);
    assert.equal(fingerprint(parsed), fingerprint(raw));
    assert.equal(libraryHash(parsed), libraryHash(raw));
    assert.ok(parsed.requirements.every(requirement => requirement.kind === undefined && bindsBot(rulebookOf(parsed), requirement)));
    assert.equal(shownRulebook(parsed), undefined, 'no rulebook is shown for rules without kinds');
    assert.ok(policy.includes(OPERATOR_QUOTE), 'the fixture quote is verbatim in the policy');
  });
});

test('the workspace shows «Свод правил» beside the situations, and one key lets operator instructions in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-rulebook-board-'));
  try {
    const lab = new ExperimentLab(directory, typedRuntime(received()));
    await lab.init();
    await lab.create(cardInput()); await lab.waitForIdle();
    await lab.close();
    const { screen, press, actions } = await openWorkspace(directory, state => { state.area = 'rules'; });
    const text = screen(100);
    assert.match(text, /Ситуации 2 {2}· {2}Свод правил {2}· {2}Прогоны 0/);
    assert.match(text, /^ Свод правил: бота судят по 1 из 2 правил$/m);
    assert.match(text, /^ {3}· инструкции для операторов: 1 — не входят$/m);
    assert.match(text, /^ {3}1 {2}Судить бота и по инструкциям для операторов$/m);
    press('1');
    assert.equal(actions[0]?.type, 'rulebook');
    assert.ok(actions[0]?.type === 'rulebook' && actions[0].operatorInstructions === true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
