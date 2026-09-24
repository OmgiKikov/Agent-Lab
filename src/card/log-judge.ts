import { EXPECTATIONS_PROTOCOL, fingerprint, type Experiment, type TraceEvent } from '../contracts.js';
import { judgeAuditSchema, validateAssessments, type JudgeAudit, type MetricAssessment, type Rubric } from '../assessment.js';
import type { CallContext } from '../runtime.js';
import { Stopped } from '../errors.js';
import { castVotes, JUDGE_PROMPT, JUDGE_PROTOCOL, judgmentRows, type Respond } from '../judge.js';
import { clip } from '../text.js';
import { LOGGED_MODE, logJudgmentReceiptSchema, type LogJudgeRequest, type LogJudgment, type LogJudgmentReceipt, type LoggedDialogue } from './calibration.js';
import type { Expectation } from './expectations.js';

/*
 * The judge on a recorded conversation (docs/design/card-v2-spec.md §10.3): judgment (b) of an expectation, next to judgment (a) on
 * the synthetic attempt. Same JUDGE_PROMPT, same two-vote protocol (judge.ts castVotes); only the input differs.
 * The input is the logged dialogue as it was recorded — no brief of the customer (the log is the situation; the
 * card's reading of it is not whispered to the judge), no simulator, no stand state — and the rubric is the log
 * variant of the expectation. It carries its mode and the import's content hash, so its input hash can never be
 * a synthetic one, and its protocol hash carries the mode, so neither judgment can close the other's receipt.
 */

/** The judge protocol on recorded conversations under one judge configuration; never equal to a synthetic protocol hash. */
export const logProtocolHash = (configurationHash?: string): string => fingerprint({ protocol: JUDGE_PROTOCOL, mode: LOGGED_MODE, configuration: configurationHash });

type KeyParts = Pick<LogJudgmentReceipt, 'definitionHash' | 'expectationId' | 'importContentHash' | 'dialogueId' | 'protocolHash'>;
/** The address of one expectation judged on one recorded conversation: while none of these changed, its receipt holds. */
export const calibrationKey = (parts: KeyParts): string => fingerprint({ definitionHash: parts.definitionHash, expectationId: parts.expectationId,
  importContentHash: parts.importContentHash, dialogueId: parts.dialogueId, protocolHash: parts.protocolHash });

const withoutStop = (text: string): string => text.endsWith('.') ? text.slice(0, -1) : text;

/**
 * One expectation's rubric on a recorded conversation. «Наступило» is the moment the agent should already have
 * done it; for a duty that depends on the agent's path, the moment its condition arose. Unlike the synthetic
 * rubric there is no «if it never happened, it is not broken»: a conversation that never got there leaves both
 * conditions not_met — not measured, never a pass.
 */
export function logRubric(expectation: Pick<Expectation, 'id' | 'text' | 'requirementIds' | 'appliesWhen'>, letter: string, card: string): Rubric {
  const duty = withoutStop(expectation.text);
  const arose = expectation.appliesWhen === undefined ? 'Ожидание наступило' : `Условие «${withoutStop(expectation.appliesWhen)}» возникло`;
  return { id: expectation.id, subject: 'agent', name: clip(expectation.text, 120),
    description: `Ожидание ${letter} ${card}. Основание — требования ${expectation.requirementIds.join(', ')} (см. requirements).`,
    passCriteria: `${arose}, и выполнено: ${duty}.`, failCriteria: `${arose}, но не выполнено: ${duty}.` };
}

const LOG_SCOPE = 'Записанный разговор реального клиента с агентом прода: ни агент, ни клиент не запускались, реплики взяты из лога как есть. '
  + 'Оценивайте только записанное. Ожидание наступает в тот момент разговора, когда агент уже должен был его выполнить. '
  + 'Если разговор до этого момента не дошёл — клиент ушёл, разговор оборвался или перешёл к оператору, — оба условия not_met. '
  + 'Слова агента доказывают только то, что сказано; действия агента видны только в записанных событиях инструментов и состояния.';

type LoggedEvent = { seq: number; type: 'user' | 'assistant' | 'tool' | 'retrieval' | 'state'; content: string };
/**
 * The events of a logged dialogue as the judge reads them: `seq` is the event's index in the import; the
 * customer's and the agent's messages always, tool, retrieval and state events only from a completely
 * recorded dialogue. System messages are not the conversation.
 */
function loggedEvents(dialogue: LoggedDialogue): LoggedEvent[] {
  const complete = dialogue.observation === 'complete';
  return dialogue.events.flatMap((event): LoggedEvent[] => {
    if (event.type === 'message') return (event.role === 'user' || event.role === 'assistant') && event.content !== undefined ? [{ seq: event.index, type: event.role, content: event.content }] : [];
    return complete ? [{ seq: event.index, type: event.type, content: event.content ?? JSON.stringify(event.data) }] : [];
  });
}

/**
 * The complete, frozen input of judgment (b), version 1. Any change to what it holds or how it is rendered is a
 * new mode (`logged-v2`), never an edit here: stored receipts are checked against this very rendering.
 */
export function logJudgeInputV1(request: LogJudgeRequest) {
  const { expectation } = request;
  const cited = new Set(expectation.requirementIds);
  return {
    mode: LOGGED_MODE,
    importContentHash: request.importContentHash,
    scenario: { execution: { evaluation: EXPECTATIONS_PROTOCOL, expectations: [expectation], requirements: request.requirements.filter(requirement => cited.has(requirement.id)) },
      metrics: [logRubric(expectation, request.letter, request.card)] },
    evaluationScope: LOG_SCOPE,
    sources: request.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content, hash: fingerprint(content) })),
    dialogue: { observation: request.dialogue.observation, events: loggedEvents(request.dialogue) },
  };
}
type LogInput = ReturnType<typeof logJudgeInputV1>;

const TRACE_TYPE = { user: 'user', assistant: 'assistant', tool: 'tool_result', retrieval: 'retrieval', state: 'observation' } as const;
/** The same events in the shape the citation check reads: a quote must be verbatim in the event it cites. */
const traceEvents = (events: readonly LoggedEvent[]): TraceEvent[] => events.map(event => ({ seq: event.seq, type: TRACE_TYPE[event.type], text: event.content }));
/** The event type a verdict must cite on an expectation's channel, as on the synthetic side (expectations.ts). */
const CHANNEL = { reply: 'assistant', tool: 'tool_result', state: 'observation' } as const;

/**
 * One vote read from the judge's answer. It must cover exactly this rubric, cite events of this conversation
 * and quote them verbatim, or it is asked once more; a pass or a fail that cites nothing on the expectation's
 * channel is read as unknown, the answer itself kept as it was.
 */
function parseLogVote(raw: string, input: LogInput): MetricAssessment[] {
  const rubric = input.scenario.metrics[0]!;
  const rows = judgmentRows(raw);
  if (rows.length !== 1 || rows[0]!.metricId !== rubric.id) throw new Error('Assessment must cover every requested metric exactly once');
  const { passCondition, failCondition, ...row } = rows[0]!;
  const result = passCondition === 'met' && failCondition === 'not_met' ? 'pass' : failCondition === 'met' && passCondition === 'not_met' ? 'fail' : 'unknown';
  const events = traceEvents(input.dialogue.events);
  const assessment = validateAssessments([rubric], events, [{ ...row, result }])[0]!;
  const channel = CHANNEL[input.scenario.execution.expectations[0]!.observation];
  const onChannel = events.some(event => event.type === channel && assessment.evidence.includes(event.seq));
  return [result === 'unknown' || onChannel ? assessment : { ...assessment, result: 'unknown' }];
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

/**
 * Judgment (b): two votes on one expectation over one recorded conversation, a malformed answer asked once
 * more. The audit is reported on every change through `ctx.onJudgment` under the request's key. A stop (the
 * run's cancel, time or budget) ends it and is thrown; any other failure is this judgment's own and comes back
 * as an incomplete receipt with the answers that were given.
 */
export async function judgeLogged(request: LogJudgeRequest, model: { provider: string; id: string; configurationHash?: string; transport?: JudgeAudit['transport'] },
  ctx: CallContext, respond: Respond): Promise<LogJudgment> {
  const data = logJudgeInputV1(request);
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
