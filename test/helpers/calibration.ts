import { fingerprint, type Experiment, type Scenario, type Trial } from '../../src/contracts.js';
import { logJudgmentReceiptSchema, logReviewSchema, type Calibration, type LogJudge, type LogJudgmentReceipt, type LogReview } from '../../src/card/calibration.js';
import { importEvidence, loggedMessages } from '../../src/card/checks.js';
import { applyCommand, hostGrant, prepareCommand } from '../../src/card/commands.js';
import { acceptLibraryV2, addCard, createLibraryV2 } from '../../src/card/library.js';
import { calibrationKey, judgeLogged, logProtocolHash } from '../../src/card/log-judge.js';
import { bindProposal, proposalCall, type DialogueProposal } from '../../src/card/proposal.js';
import type { LibraryV2 } from '../../src/card/schema.js';
import type { ImportBatch } from '../../src/scenario-contracts.js';
import { importBatch, libraryHash } from '../../src/scenario-library.js';
import { reviewed } from './card-library.js';
import { policy, proposals, refundRule } from './card-prep.js';
import { cardAttempt, cardRun } from './cards.js';

/*
 * A judge of recorded conversations for tests: the real two-vote protocol (card/log-judge.ts judgeLogged) over
 * scripted answers, so receipts, sidecars and keys are the product's own; and calibrated runs built from the
 * record alone, for the view. No model is called; invented data.
 */

/** The judge's input of one vote, as far as a scripted answer reads it. */
export interface LogVoteInput {
  scenario: { metrics: { id: string }[]; execution: { expectations: { id: string; text: string }[] } };
  dialogue: { observation: string; events: { seq: number; type: string; content: string }[] };
}
/** What one vote says: a verdict on the agent's last reply, «the conversation never got there», «cannot tell», or a malformed answer. */
export type LogVote = 'pass' | 'fail' | 'not_reached' | 'unclear' | 'malformed';

/** A well-formed answer for `vote`: a pass or a fail cites the agent's last reply verbatim. */
export function logAnswer(data: LogVoteInput, vote: Exclude<LogVote, 'malformed'>): string {
  const reply = data.dialogue.events.filter(event => event.type === 'assistant').at(-1);
  const decided = vote === 'pass' || vote === 'fail';
  const conditions = vote === 'pass' ? ['met', 'not_met'] : vote === 'fail' ? ['not_met', 'met'] : vote === 'not_reached' ? ['not_met', 'not_met'] : ['unclear', 'unclear'];
  return JSON.stringify({ assessments: [{ metricId: data.scenario.metrics[0]!.id, passCondition: conditions[0], failCondition: conditions[1],
    rationale: `Сценарный голос: ${vote}.`, evidence: decided && reply ? [reply.seq] : [], citations: decided && reply ? [{ seq: reply.seq, quote: reply.content }] : [] }] });
}

/**
 * The log judge of a test: `decide` gives each vote (0-based over the whole judge, in request order); every request
 * passes the run's budget gate first, as a model call does, and is counted in `calls`.
 */
export function scriptedLogJudge(decide: (data: LogVoteInput, vote: number) => LogVote, calls = { count: 0 }): LogJudge {
  const model = { provider: 'fixture', id: 'log-judge' };
  return { provider: model.provider, model: model.id, protocolHash: logProtocolHash(),
    assess: (request, ctx) => judgeLogged(request, model, ctx, async (_prompt, input) => {
      ctx.beforeCall();
      const vote = decide(JSON.parse(input) as LogVoteInput, calls.count++);
      return vote === 'malformed' ? 'это не JSON' : logAnswer(JSON.parse(input) as LogVoteInput, vote);
    }) };
}

/**
 * The teaching refund reading of a logged conversation, the same reading the synthetic judge of card-prep.ts
 * applies: duty «не запрашивать повторно» fails when the agent asked for the number after the customer gave it;
 * duty «объяснить возврат» passes when the agent explained how to apply, and otherwise fails — or, when it
 * depends on the number and the conversation ended right after the customer named it, was never reached.
 */
export function refundReading(data: LogVoteInput): LogVote {
  const expectation = data.scenario.execution.expectations[0]!;
  const events = data.dialogue.events;
  let given = false, repeated = false;
  for (const event of events) {
    if (event.type === 'user' && event.content.includes('терминала: ')) given = true;
    if (event.type === 'assistant' && given && event.content.includes('номер терминала')) repeated = true;
  }
  // A card's duty А, or the first-format checkpoint it stands for.
  if (expectation.id === 'e1' || expectation.id === 'ask_once') return repeated ? 'fail' : 'pass';
  if (events.some(event => event.type === 'assistant' && event.content.includes('Подайте заявление'))) return 'pass';
  const last = events.at(-1);
  return last?.type === 'user' && last.content.includes('терминала: ') ? 'not_reached' : 'fail';
}

/* ───────────────────────────── a calibrated run built from the record alone ───────────────────────────── */

/** Dialogue `i` of an invented export: an even one names the number when asked and thanks the agent; an odd one names it at once. */
function loggedDialogue(i: number) {
  return i % 2 === 0
    ? { id: `d${i}`, messages: [{ role: 'user' as const, content: `Помогите с возвратом, заказ ${i}.` }, { role: 'assistant' as const, content: 'Уточните номер терминала.' },
      { role: 'user' as const, content: `Номер терминала: ${5000 + i}` }, { role: 'assistant' as const, content: 'Возврат возможен. Подайте заявление в поддержку.' }, { role: 'user' as const, content: 'Спасибо!' }] }
    : { id: `d${i}`, messages: [{ role: 'user' as const, content: `Номер терминала: ${1000 + i}. Помогите с возвратом.` }, { role: 'assistant' as const, content: 'Уточните номер терминала.' }] };
}
const proposalOf = (i: number): DialogueProposal => {
  const base = i % 2 === 0 ? proposals.late : proposals.known;
  return { ...base, title: `${base.title}, заказ ${i}`, knows: base.knows.map(fact => ({ ...fact, value: String(i % 2 === 0 ? 5000 + i : 1000 + i) })) };
};

export interface LoggedRun { record: Experiment; batch: ImportBatch; library: LibraryV2; scenarios: Scenario[] }
type Verdict = 'pass' | 'fail' | 'unknown';

/** One move of the customer Lab plays, as evaluation.ts records it. */
export const controllerMove = (actionId: string) => ({ protocol: 'controlled-user-v1', decision: { actionId }, accepted: true, from: 'talk', to: actionId === 'leave' ? 'done' : 'talk' });

/** An attempt of cards.ts whose customer left after the agent's first reply, the move recorded as the controller records it. */
export function loggedAttempt(id: string, scenario: Scenario, results: Record<string, Verdict>, repeat = 0, extra: Partial<Trial> = {}): Trial {
  const trial = cardAttempt(id, scenario, results, repeat, extra);
  return { ...trial, events: trial.events.map(event => event.type === 'simulator' ? { ...event, result: controllerMove('leave') } : event) };
}

/**
 * A finished run of `count` cards made from an invented export, accepted as a preparation accepts them (card №k from
 * dialogue d{k-1}); the cards listed in `edited` had their customer changed by the owner before acceptance. Each
 * card's one attempt carries `synthetic(number)` for its duties А and Б.
 */
export function loggedRun(count: number, synthetic: (number: number) => { e1: Verdict; e2: Verdict }, edited: readonly number[] = []): LoggedRun {
  const batch = importBatch(Array.from({ length: count }, (_, i) => loggedDialogue(i)));
  const evidence = importEvidence([batch]);
  const requirements = [{ ...refundRule, sourceId: 'source-1' }];
  const sources = [{ id: 'source-1', name: 'Правила возвратов', content: policy, hash: fingerprint(policy) }];
  let library = createLibraryV2({ id: 'library_logs', imports: [{ id: batch.id, contentHash: batch.contentHash }], createdAt: '2026-09-23T10:00:00.000Z',
    sources, requirements });
  for (const [i, dialogue] of batch.dialogues.entries()) {
    const call = proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId: dialogue.id }, messages: loggedMessages(dialogue), sources, maxTurns: 3 });
    library = addCard(library, bindProposal(proposalOf(i), call, library.nextNumber), { dialogueId: dialogue.id, batchId: batch.id, sourceIds: ['source-1'] });
  }
  library = reviewed(library, evidence);
  for (const number of edited) {
    const card = library.cards.find(item => item.number === number)!;
    const prepared = prepareCommand(library, { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f1', disclosure: 'unknown' }, { evidence, maxTurns: 3, via: 'pi-confirm', at: '2026-09-23T11:00:00.000Z' });
    library = reviewed(applyCommand(library, prepared, hostGrant(prepared, 'confirmed')), evidence);
  }
  const accepted = acceptLibraryV2(library, libraryHash(library), library.cards.map(card => card.id), { evidence, maxTurns: 3 });
  const scenarios = accepted.scenarios;
  const trials: Trial[] = scenarios.map((scenario, index) => loggedAttempt(`attempt_${index + 1}`, scenario, synthetic(index + 1)));
  const record = cardRun(scenarios, trials, 1, { id: 'calibrated_run', librarySnapshot: accepted.library, originalImport: { id: batch.id, contentHash: batch.contentHash },
    acceptedTests: scenarios.map(scenario => ({ testId: `test_${scenario.id.slice(5, 21)}`, scenarioId: scenario.id, definitionHash: fingerprint(scenario), acceptedAt: '2026-09-23T12:00:00.000Z' })) });
  return { record, batch, library: accepted.library, scenarios };
}

/**
 * What the log judge said about one expectation: a verdict, a log that never got there, two votes apart, nothing asked,
 * a judge whose request failed (`failed`, an incomplete receipt), two votes that decided without citing the channel
 * (`unsupported`), two votes that could not tell (`unclear`), or a receipt of another definition (`foreign`).
 */
export type LogVerdict = 'pass' | 'fail' | 'not_reached' | 'split' | 'no_agent_reply' | 'channel_unobserved' | 'failed' | 'unsupported' | 'unclear' | 'foreign';

/** A receipt of the log judge as the calibration stores it, keyed the product's own way. */
export function logReceipt(run: LoggedRun, number: number, expectationId: 'e1' | 'e2', verdict: LogVerdict): LogJudgmentReceipt {
  const scenario = run.scenarios[number - 1]!;
  const identity = { cardId: scenario.id, expectationId, definitionHash: verdict === 'foreign' ? 'f'.repeat(64) : fingerprint(scenario), importId: run.batch.id,
    importContentHash: run.batch.contentHash, dialogueId: `d${number - 1}` };
  const protocolHash = logProtocolHash();
  type Condition = 'met' | 'not_met' | 'unclear';
  const vote = (pass: Condition, fail: Condition, result: Verdict) => ({ pass, fail, result });
  const votes = verdict === 'pass' || verdict === 'foreign' ? [vote('met', 'not_met', 'pass'), vote('met', 'not_met', 'pass')] : verdict === 'fail' ? [vote('not_met', 'met', 'fail'), vote('not_met', 'met', 'fail')]
    : verdict === 'not_reached' ? [vote('not_met', 'not_met', 'unknown'), vote('not_met', 'not_met', 'unknown')] : verdict === 'split' ? [vote('met', 'not_met', 'pass'), vote('not_met', 'met', 'fail')]
    : verdict === 'unsupported' ? [vote('met', 'not_met', 'unknown'), vote('not_met', 'met', 'unknown')] : verdict === 'unclear' ? [vote('unclear', 'unclear', 'unknown'), vote('unclear', 'unclear', 'unknown')]
    : verdict === 'failed' ? [vote('met', 'not_met', 'pass'), { error: true as const }] : [];
  const skipped = verdict === 'no_agent_reply' || verdict === 'channel_unobserved' ? verdict : undefined;
  return logJudgmentReceiptSchema.parse({ mode: 'logged-v1', key: calibrationKey({ ...identity, protocolHash }), ...identity, protocolHash, inputHash: fingerprint({ identity }),
    ...(skipped ? { skipped } : { auditHash: fingerprint({ audit: identity }) }), provider: 'fixture', model: 'log-judge', votes,
    result: verdict === 'foreign' ? 'pass' : verdict === 'pass' || verdict === 'fail' ? verdict : 'unknown', complete: verdict !== 'failed' });
}

/** The owner's verdict on one receipt, `log:{key}`, as a lab operation records it: what the owner saw is read from the receipt. */
export function logReview(receipt: LogJudgmentReceipt, verdict: LogReview['verdict'], source?: 'quick'): LogReview {
  return logReviewSchema.parse({ id: `review_${receipt.key.slice(0, 12)}_${verdict}`, createdAt: '2026-09-24T12:00:00.000Z', key: receipt.key, verdict,
    note: 'Прочитал разговор из логов сам.', ...(source ? { source } : {}), judgeVerdict: receipt.result, judge: { protocolHash: receipt.protocolHash, inputHash: receipt.inputHash } });
}

/**
 * The run with a calibration: `log(number)` gives the log judge's verdicts on each card's duties А and Б (undefined:
 * not judged yet). By default the logs and the run are both of version agent-v7; `logs: null` declares nothing.
 */
export function calibrated(run: LoggedRun, log: (number: number) => [LogVerdict, LogVerdict] | undefined, versions: { logs?: string | null; tested?: string | null } = {}): Experiment {
  const entries = run.scenarios.flatMap((_, index) => {
    const verdicts = log(index + 1);
    return verdicts ? [logReceipt(run, index + 1, 'e1', verdicts[0]), logReceipt(run, index + 1, 'e2', verdicts[1])] : [];
  });
  const logs = versions.logs === undefined ? 'agent-v7' : versions.logs;
  const calibration: Calibration = { protocol: 'sim-to-real-v1', testedVersion: versions.tested === undefined ? 'agent-v7' : versions.tested, entries,
    logVersions: logs === null ? [] : [{ importId: run.batch.id, contentHash: run.batch.contentHash, version: logs, receiptId: 'logs_1' }] };
  return { ...structuredClone(run.record), calibration };
}
