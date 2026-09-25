import { EXPECTATIONS_PROTOCOL, fingerprint, type Experiment, type TraceEvent } from '../contracts.js';
import { judgeAuditSchema, validateAssessments, type JudgeAudit, type MetricAssessment } from '../assessment.js';
import type { CallContext } from '../runtime.js';
import { Stopped } from '../errors.js';
import { castVotes, JUDGE_PROMPT, JUDGE_PROTOCOL, judgmentRows, type Respond } from '../judge.js';
import { LOGGED_MODE, LOGGED_MODE_V1, logJudgmentReceiptSchema, type LogJudgeRequest, type LogJudgment, type LogJudgmentReceipt, type LoggedDialogue } from './calibration.js';
import { channelHolds, COUNTING_VERSION } from './expectations.js';

/*
 * The judge on a recorded conversation (docs/design/card-v2-spec.md §10.3): judgment (b) of an expectation, next to judgment (a) on
 * the synthetic attempt. Same JUDGE_PROMPT, same two-vote protocol (judge.ts castVotes), the same rubric — the accepted
 * definition's own, strength, what else fulfils it and what breaks it included — and the same channel rule
 * (expectations.ts channelHolds); only the conversation differs. The input is the logged dialogue as it was recorded —
 * no brief of the customer (the log is the situation; the card's reading of it is not whispered to the judge), no
 * simulator, no stand state. It carries its mode and the import's content hash, so its input hash can never be a
 * synthetic one, and its protocol hash carries the mode, so neither judgment can close the other's receipt.
 */

/** The judge protocol on recorded conversations under one judge configuration; never equal to a synthetic protocol hash. */
export const logProtocolHash = (configurationHash?: string): string => fingerprint({ protocol: JUDGE_PROTOCOL, mode: LOGGED_MODE, configuration: configurationHash });

type KeyParts = Pick<LogJudgmentReceipt, 'definitionHash' | 'expectationId' | 'importContentHash' | 'dialogueId' | 'protocolHash'>;
/** The address of one expectation judged on one recorded conversation: while none of these changed, its receipt holds. */
export const calibrationKey = (parts: KeyParts): string => fingerprint({ definitionHash: parts.definitionHash, expectationId: parts.expectationId,
  importContentHash: parts.importContentHash, dialogueId: parts.dialogueId, protocolHash: parts.protocolHash });

type LoggedEvent = { seq: number; type: 'user' | 'assistant' | 'tool' | 'retrieval' | 'state'; content: string; tool?: string };
/**
 * The events of a logged dialogue as the judge reads them: `seq` is the event's index in the import; the
 * customer's and the agent's messages always, tool, retrieval and state events only from a completely
 * recorded dialogue. System messages are not the conversation. A tool event names its tool when the log's event does (a
 * string `tool`, as the adapter contract names it): the channel rule reads it.
 */
function loggedEvents(dialogue: LoggedDialogue): LoggedEvent[] {
  const complete = dialogue.observation === 'complete';
  return dialogue.events.flatMap((event): LoggedEvent[] => {
    if (event.type === 'message') return (event.role === 'user' || event.role === 'assistant') && event.content !== undefined ? [{ seq: event.index, type: event.role, content: event.content }] : [];
    if (!complete) return [];
    const tool = event.type === 'tool' ? (event.data as { tool?: unknown } | null)?.tool : undefined;
    return [{ seq: event.index, type: event.type, content: event.content ?? JSON.stringify(event.data), ...(typeof tool === 'string' && tool ? { tool } : {}) }];
  });
}

/**
 * What the judge is told about a recorded conversation (`logged-v2`). The rubric is the synthetic one; what differs is
 * the conversation, which may end before the expectation was due: both conditions not_met then say it was not exercised
 * (logUndecided `not_exercised_in_log`). An expectation under a condition is due once its condition arose, and what holds
 * when it never arose is the rubric's own word, as on the synthetic side.
 */
const LOG_SCOPE = 'A recorded conversation of a real customer with the production agent: neither was run here, the messages are the log as it was recorded. '
  + 'Judge only what was recorded, by the supplied rubric — the same one a synthetic conversation of this situation is judged by. '
  + 'The expectation is due at the moment of the conversation when the agent should already have met it; an expectation under a condition is due once its condition arose. '
  + 'If the conversation ended before that moment — the customer left, the conversation broke off or was handed to a person — both conditions are not_met: it was not exercised here. '
  + 'Where the rubric says what holds when its condition never arose, follow the rubric. '
  + 'The agent\'s words prove only what was said; its actions show only in the recorded tool and state events.';

/**
 * The complete, frozen input of judgment (b) in its mode `logged-v2`. Any change to what it holds or how it is
 * rendered is a new mode, never an edit here. Stored receipts of every mode are checked against the input their own
 * audit keeps (logJudgmentComplete), never against a rendering made again.
 */
export function logJudgeInput(request: LogJudgeRequest) {
  const { expectation } = request;
  const cited = new Set(expectation.requirementIds);
  return {
    mode: LOGGED_MODE as typeof LOGGED_MODE,
    importContentHash: request.importContentHash,
    scenario: { execution: { evaluation: EXPECTATIONS_PROTOCOL, expectations: [expectation], requirements: request.requirements.filter(requirement => cited.has(requirement.id)) },
      metrics: [request.rubric] },
    evaluationScope: LOG_SCOPE,
    sources: request.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content, hash: fingerprint(content) })),
    dialogue: { observation: request.dialogue.observation, events: loggedEvents(request.dialogue) },
  };
}
/** The input of a stored audit, of either mode: `logged-v1` judged the log by a rubric of its own and named no tool. */
type LogInput = Omit<ReturnType<typeof logJudgeInput>, 'mode'> & { mode: typeof LOGGED_MODE | typeof LOGGED_MODE_V1 };

const TRACE_TYPE = { user: 'user', assistant: 'assistant', tool: 'tool_result', retrieval: 'retrieval', state: 'observation' } as const;
/** The same events in the shape the citation check reads: a quote must be verbatim in the event it cites. */
const traceEvents = (events: readonly LoggedEvent[]): TraceEvent[] => events.map(event => ({ seq: event.seq, type: TRACE_TYPE[event.type], text: event.content }));
/** The event type a `logged-v1` verdict had to cite on its expectation's channel, as its receipts were sealed. */
const CHANNEL_V1 = { reply: 'assistant', tool: 'tool', state: 'state' } as const;

/**
 * One vote read from the judge's answer. It must cover exactly this rubric, cite events of this conversation
 * and quote them verbatim, or it is asked once more; a pass or a fail that does not hold on the expectation's channel
 * is read as unknown, the answer itself kept as it was. The rules are those of the vote's mode: `logged-v2` reads the
 * channel by the synthetic side's own rule (expectations.ts channelHolds: a complete log shows the call the agent never
 * made) and asks meaningful quotes, as the judge's protocol does; a stored `logged-v1` vote reads as it was sealed.
 */
function parseLogVote(raw: string, input: LogInput): MetricAssessment[] {
  const rubric = input.scenario.metrics[0]!;
  const expectation = input.scenario.execution.expectations[0]!;
  const rows = judgmentRows(raw);
  if (rows.length !== 1 || rows[0]!.metricId !== rubric.id) throw new Error('Assessment must cover every requested metric exactly once');
  const { passCondition, failCondition, ...row } = rows[0]!;
  const result = passCondition === 'met' && failCondition === 'not_met' ? 'pass' : failCondition === 'met' && passCondition === 'not_met' ? 'fail' : 'unknown';
  const current = input.mode === LOGGED_MODE;
  const assessment = validateAssessments([rubric], traceEvents(input.dialogue.events), [{ ...row, result }], { meaningfulQuotes: current })[0]!;
  if (result === 'unknown') return [assessment];
  const cited = input.dialogue.events.filter(event => assessment.evidence.includes(event.seq));
  const complete = input.dialogue.observation === 'complete';
  const holds = current ? channelHolds(expectation, result, { reply: cited.some(event => event.type === 'assistant'),
    tools: cited.filter(event => event.type === 'tool').map(event => event.tool), state: cited.some(event => event.type === 'state') },
  { toolsComplete: complete, stateObserved: complete, edition: COUNTING_VERSION })
    : cited.some(event => event.type === CHANNEL_V1[expectation.observation]);
  return [holds ? assessment : { ...assessment, result: 'unknown' }];
}

type Vote = LogJudgmentReceipt['votes'][number];
/** Every answer of an audit in order: a malformed or failed one is an error; the others carry their two conditions and their result. */
function auditVotes(audit: JudgeAudit): Vote[] {
  return audit.attempts.map((attempt): Vote => {
    const assessment = attempt.assessments?.[0];
    if (attempt.error || attempt.raw === undefined || !assessment) return { error: true };
    const [row] = judgmentRows(attempt.raw);
    return { pass: row!.passCondition, fail: row!.failCondition, result: assessment.result };
  });
}

const cast = (vote: Vote): boolean => !vote.error && vote.result !== undefined;
/** The result of the votes: the two that hold, when they agree; anything else is unknown. */
export function voteResult(votes: readonly Vote[]): 'pass' | 'fail' | 'unknown' {
  const [first, second, ...more] = votes.filter(cast);
  return first && second && !more.length && first.result === second.result ? first.result! : 'unknown';
}
/** Both votes found that the conversation never reached the moment of the expectation: not measured on the log. */
export const notExercised = (votes: readonly Vote[]): boolean => {
  const held = votes.filter(cast);
  return held.length === 2 && held.every(vote => vote.pass === 'not_met' && vote.fail === 'not_met');
};

/** A vote whose two conditions decided — one met, the other not — and whose result is unknown: its verdict cited no event of the expectation's channel (parseLogVote). */
const unsupported = (vote: Vote): boolean => vote.result === 'unknown'
  && (vote.pass === 'met' && vote.fail === 'not_met' || vote.pass === 'not_met' && vote.fail === 'met');

/** Why a receipt of judgment (b) decided nothing. */
export type LogUndecided = NonNullable<LogJudgmentReceipt['skipped']> | 'judge_failed' | 'not_exercised_in_log' | 'judge_split' | 'no_evidence' | 'judge_unclear';

/**
 * Why one receipt decided nothing, read from what it recorded and never from the judge's words: the log could not
 * show the expectation (no call was made), the judge gave no usable answer (a request failed or its answers could
 * not be read — the receipt is incomplete), both votes found the conversation never got there, the two votes
 * differ, both decided without citing an event of the expectation's channel, or the judge could not tell — as the
 * synthetic side tells the same cases apart (expectations.ts undecidedExpectation). Undefined when it decided.
 */
export function logUndecided(receipt: Pick<LogJudgmentReceipt, 'skipped' | 'complete' | 'votes' | 'result'>): LogUndecided | undefined {
  if (receipt.skipped) return receipt.skipped;
  if (!receipt.complete) return 'judge_failed';
  if (receipt.result !== 'unknown') return undefined;
  if (notExercised(receipt.votes)) return 'not_exercised_in_log';
  const held = receipt.votes.filter(cast);
  if (held[0]?.result !== held[1]?.result) return 'judge_split';
  return held.length && held.every(unsupported) ? 'no_evidence' : 'judge_unclear';
}

/**
 * Judgment (b): two votes on one expectation over one recorded conversation, a malformed answer asked once
 * more. The audit is reported on every change through `ctx.onJudgment` under the request's key. A stop (the
 * run's cancel, time or budget) ends it and is thrown; any other failure is this judgment's own and comes back
 * as an incomplete receipt with the answers that were given.
 */
export async function judgeLogged(request: LogJudgeRequest, model: { provider: string; id: string; configurationHash?: string; transport?: JudgeAudit['transport'] },
  ctx: CallContext, respond: Respond): Promise<LogJudgment> {
  const data = logJudgeInput(request);
  const input = JSON.stringify(data);
  const audit: JudgeAudit = {
    protocolHash: logProtocolHash(model.configurationHash), inputHash: fingerprint(data), provider: model.provider, model: model.id,
    ...(model.configurationHash ? { configurationHash: model.configurationHash } : {}),
    ...(model.transport ? { transport: model.transport } : {}),
    prompt: JUDGE_PROMPT, input, attempts: [], notApplicable: [],
  };
  const save = (final = false) => ctx.onJudgment?.(request.key, structuredClone(audit), final);
  save();
  let failed = false;
  try {
    await castVotes(audit, { metrics: data.scenario.metrics, input: () => input, parse: raw => parseLogVote(raw, data) }, ctx.signal, save, respond);
  } catch (error) {
    if (ctx.signal.aborted || error instanceof Stopped) throw error;
    failed = true;
  }
  // The receipt seals exactly what the sidecar keeps: the schema-normalized audit.
  const stored = judgeAuditSchema.parse(audit);
  const votes = auditVotes(stored);
  return { protocolHash: stored.protocolHash, inputHash: stored.inputHash, auditHash: fingerprint(stored), provider: stored.provider, model: stored.model,
    votes, result: voteResult(votes), complete: !failed && votes.filter(cast).length === 2 };
}

/** The answers of an audit read again from its own stored input: they must give the same votes. */
function sameVotes(audit: JudgeAudit, votes: readonly Vote[]): boolean {
  const data = JSON.parse(audit.input) as LogInput;
  for (const attempt of audit.attempts) {
    if (attempt.error || attempt.raw === undefined) continue;
    if (fingerprint(parseLogVote(attempt.raw, data)) !== fingerprint(attempt.assessments)) return false;
  }
  return fingerprint(auditVotes(audit)) === fingerprint(votes);
}

/**
 * Whether a receipt of judgment (b) stands, without judging or compiling anything again (docs/design/card-v2-spec.md §10.3): it is a
 * receipt of the log judge, of this run's accepted definition and of its own key; it is complete and its votes
 * give its result. With `sidecar`, the audit on disk must also be the one it seals, its stored input must hash
 * to the receipt's input hash and its answers must read again to the same votes. A synthetic attempt's
 * judgment is never one: it has no mode, and its audit's protocol hash is not a log protocol hash.
 */
export function logJudgmentComplete(entry: unknown, record: Pick<Experiment, 'acceptedTests'>, sidecar?: { audit: JudgeAudit | null }): boolean {
  const parsed = logJudgmentReceiptSchema.safeParse(entry);
  if (!parsed.success) return false;
  const receipt = parsed.data;
  if (record.acceptedTests?.find(test => test.scenarioId === receipt.cardId)?.definitionHash !== receipt.definitionHash) return false;
  if (receipt.key !== calibrationKey(receipt) || !receipt.complete) return false;
  if (receipt.skipped) return !receipt.votes.length && receipt.result === 'unknown';
  if (receipt.votes.filter(cast).length !== 2 || voteResult(receipt.votes) !== receipt.result) return false;
  if (!sidecar) return true;
  const { audit } = sidecar;
  if (!audit || !receipt.auditHash || fingerprint(audit) !== receipt.auditHash) return false;
  try {
    return audit.protocolHash === receipt.protocolHash && audit.inputHash === receipt.inputHash && fingerprint(JSON.parse(audit.input)) === receipt.inputHash
      && sameVotes(audit, receipt.votes);
  } catch { return false; }
}
