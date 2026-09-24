import type { Source } from '../contracts.js';
import { MODEL_INPUT_BYTES, serializedBytes, workInputIssue } from '../limits.js';
import { TASK_ATTEMPTS } from '../llm/structured.js';

/*
 * What a preparation of situations may spend. Each unit (a logged conversation, or one situation from the rules) has
 * its own allowance of proposal calls; the whole preparation has one ceiling, stated in the owner's consent before
 * anything is paid and enforced as that preparation's budget, so the promise and the stop are the same number.
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
const REVIEW_CALLS = 2;
/** Reviews one unit may need: its card's, and its revision's. */
const REVIEWS = 2;

/**
 * The most model calls a preparation makes: the topic map's calls, and for each situation promised the choice of
 * articles of a large knowledge base for its conversation, its proposal allowance and the review of its card and of that
 * card's one revision. Requests are counted as the topic map's are — each answer passing the first time — and only the
 * proposal allowance holds its repairs; a preparation whose repairs reach the ceiling stops there with what it made, and
 * continues on the owner's word. A conversation that makes no situation spends out of the same ceiling, so the
 * preparation never spends more than it promised. A resume is bounded by the draft's limit.
 */
export function preparationCeiling(input: { task: string; sources: readonly Source[]; situations: number; fromLogs: boolean; topicMapCalls?: number }): number {
  const whole = !workInputIssue({ task: input.task, sources: input.sources });
  const reading = whole || !input.fromLogs ? 0 : READING_CALLS;
  return (input.topicMapCalls ?? 0) + input.situations * (reading + PROPOSAL_ATTEMPTS + REVIEWS * REVIEW_CALLS);
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
