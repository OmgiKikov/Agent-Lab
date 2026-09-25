import type { Experiment, Source } from '../contracts.js';
import { MODEL_INPUT_BYTES, serializedBytes, workInputIssue } from '../limits.js';
import { TASK_ATTEMPTS } from '../llm/structured.js';

/*
 * What work on situations may spend: their preparation, and a run of them. Each unit of a preparation (a logged
 * conversation, or one situation from the rules) has its own allowance of proposal calls; the whole preparation has one
 * ceiling, stated in the owner's consent before anything is paid and kept in its checkpoint as its budget over its
 * creation and every resume, so the promise and the stop are the same number. A run is counted the same way — every
 * answer passing the first time — and its plan must fit the draft's limit before it starts. Every operation's time runs
 * from its own start.
 */

/** Revisions of a card the reviewer blocked (card/prepare.ts): one, whatever it gives. */
const REVISIONS = 1;
/**
 * Proposal calls one unit may spend over all resumes, repairs included: every request one proposal task may make
 * (its first answer and its repairs, llm/structured.ts TASK_ATTEMPTS) to write its card, and at least one more for each
 * revision of a card the reviewer blocked.
 */
export const PROPOSAL_ATTEMPTS = TASK_ATTEMPTS + REVISIONS;
/** Calls a conversation spends choosing articles of a knowledge base too large for one request: from the titles, then on reading them. */
const READING_CALLS = 2;
/** Review requests one card makes at most: its story and its duties apart when together they do not fit one request. */
export const REVIEW_CALLS = 2;
/** Reviews one unit may need: its card's, and its revision's. */
const REVIEWS = 2;

/**
 * The most model calls a preparation makes: the topic map's calls, and for each situation promised the choice of
 * articles of a large knowledge base for its conversation, its proposal allowance and the review of its card and of that
 * card's one revision. Requests are counted as the topic map's are — each answer passing the first time — and only the
 * proposal allowance holds its repairs; a preparation whose repairs reach the ceiling stops there with what it made, and
 * continues on the owner's word. A conversation that makes no situation spends out of the same ceiling, so the
 * preparation never spends more than it promised — over its creation and every resume together (preparationBudget).
 */
export function preparationCeiling(input: { task: string; sources: readonly Source[]; situations: number; fromLogs: boolean; topicMapCalls?: number }): number {
  const whole = !workInputIssue({ task: input.task, sources: input.sources });
  const reading = whole || !input.fromLogs ? 0 : READING_CALLS;
  return (input.topicMapCalls ?? 0) + input.situations * (reading + PROPOSAL_ATTEMPTS + REVIEWS * REVIEW_CALLS);
}

/** Where a preparation stands against its ceiling. */
export interface PreparationBudget {
  /** The calls it may make over its creation and every resume: what the owner agreed to, or raised it to. */
  ceiling: number;
  /** The calls it made so far. */
  spent: number;
  /** What is left of the ceiling. */
  left: number;
  /** Units — conversations, or situations from the rules — still to prepare. */
  pending: number;
  /** The ceiling a continuation of every pending unit needs at most: what the owner is asked to agree to when `left` cannot cover it. */
  resume: number;
}

/**
 * The accounts of a card preparation: its ceiling, its spending, what is left, and what continuing it would need. A
 * checkpoint written before the preparation kept its own accounts is read by the rule of its time: the draft's limit as
 * its ceiling, the record's calls as its spending. Undefined for a first-format preparation, which never continues.
 */
export function preparationBudget(record: Pick<Experiment, 'task' | 'sources' | 'settings' | 'usage' | 'preparationProgress' | 'originalImport'>): PreparationBudget | undefined {
  const progress = record.preparationProgress;
  if (!progress || progress.protocol === 'chronological-scenarios-v1') return undefined;
  const ceiling = progress.callCeiling ?? record.settings.maxCalls;
  const spent = progress.spentCalls ?? record.usage.calls;
  const pending = progress.pending.length;
  const needs = preparationCeiling({ task: record.task, sources: record.sources, situations: pending, fromLogs: !!record.originalImport });
  return { ceiling, spent, left: Math.max(0, ceiling - spent), pending, resume: Math.max(ceiling, spent + needs) };
}

/** The longest any one operation may take: the most the settings allow a run. */
export const LONGEST_OPERATION_MS = 14_400_000;
/** The time one situation's preparation is given: its reading, its proposal with repairs, its review and one revision. */
const SITUATION_TIME_MS = 180_000;
/** The time one call of the logs' topic map is given. */
const MAP_CALL_TIME_MS = 60_000;

/**
 * The time a preparation is given from its start: each of its `situations` its share, the topic map its calls. A resume
 * is given the time of the units it has left, so a preparation stopped by its time always continues.
 */
export function preparationTime(situations: number, topicMapCalls = 0): number {
  return Math.min(LONGEST_OPERATION_MS, Math.max(SITUATION_TIME_MS, situations * SITUATION_TIME_MS + topicMapCalls * MAP_CALL_TIME_MS));
}

/** Votes the judge casts on one expectation: of an attempt, and of a situation judged on its logged conversation. */
const JUDGE_VOTES = 2;
/** The one call that names a run's failure causes. */
const CAUSE_NAMING = 1;
/** The most expectations one situation holds: a card has one to three duties. */
export const SITUATION_EXPECTATIONS = 3;

/** One attempt as a run's plan counts it: whether Lab plays a customer who answers the agent, and the expectations the judge votes on. */
export interface PlannedAttempt { customer: boolean; expectations: number }

/**
 * The model calls a run makes when every answer passes the first time: for each attempt the customer's moves — at most
 * one after each of the agent's replies, `maxTurns` in all — and two votes on each expectation it is judged by; then the
 * one naming of the failure causes. Repairs come out of the same limit: a run whose repairs reach it stops there with
 * what it recorded. The comparison with production is not in it: it takes what the run leaves, or is skipped with the
 * reason (card/calibrate.ts).
 */
export function runCalls(attempts: readonly PlannedAttempt[], maxTurns: number): number {
  if (!attempts.length) return 0;
  return attempts.reduce((sum, attempt) => sum + (attempt.customer ? maxTurns : 0) + JUDGE_VOTES * attempt.expectations, 0) + CAUSE_NAMING;
}

/**
 * The call limit a draft of `situations` prepared now is given for its run: each situation at its most expectations,
 * `repeats` attempts of it with a customer Lab plays, and — for situations from logs — each expectation compared with
 * its logged conversation, so the comparison with production is never skipped for want of calls.
 */
export function runLimit(situations: number, settings: { maxTurns: number; repeats: number }, fromLogs: boolean): number {
  const attempts = Array.from({ length: situations * settings.repeats }, (): PlannedAttempt => ({ customer: true, expectations: SITUATION_EXPECTATIONS }));
  return runCalls(attempts, settings.maxTurns) + (fromLogs ? situations * SITUATION_EXPECTATIONS * JUDGE_VOTES : 0);
}

/** The time one attempt is given: the agent's replies, the customer's moves and the judge's votes. */
const ATTEMPT_TIME_MS = 120_000;

/** The time a run of `attempts` conversations is given from its start, one after another; a run that holds several at once ends sooner. */
export function runTime(attempts: number): number {
  return Math.min(LONGEST_OPERATION_MS, Math.max(ATTEMPT_TIME_MS, attempts * ATTEMPT_TIME_MS));
}

/** The agent's prompts among the materials: how many, and the bytes they add to every proposal. */
export function promptLoad(sources: readonly Source[]): { count: number; bytes: number } {
  const prompts = sources.filter(source => source.kind === 'prompt');
  return { count: prompts.length, bytes: prompts.length ? serializedBytes(prompts.map(({ id, name, content }) => ({ id, name, content }))) : 0 };
}

const kilobytes = (bytes: number): number => Math.ceil(bytes / 1000);

/**
 * Why no situation can be prepared at all: every proposal reads all the agent's prompts, and these alone do not fit one
 * request. Asked before anything is paid — the consent, the start of a preparation — never discovered per dialogue.
 */
export function promptsOversize(task: string, sources: readonly Source[]): string | undefined {
  const prompts = sources.filter(source => source.kind === 'prompt');
  if (!prompts.length || !workInputIssue({ task, sources: prompts.map(({ id, name, content }) => ({ id, name, content })) })) return undefined;
  return `Промпты агента занимают ${kilobytes(promptLoad(sources).bytes)} КБ, а в один запрос модели помещается ${kilobytes(MODEL_INPUT_BYTES)} КБ вместе с разговором. `
    + 'Каждая ситуация читает все промпты целиком, поэтому подготовка не начата и ничего не потрачено. Выберите меньше промптов — только те, что пишут ответ клиенту.';
}
