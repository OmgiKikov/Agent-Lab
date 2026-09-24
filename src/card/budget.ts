import type { Source } from '../contracts.js';
import { workInputIssue } from '../limits.js';

/*
 * What a preparation of situations may spend. Each unit (a logged conversation, or one situation from the rules) has
 * its own allowance of proposal calls; the whole preparation has one ceiling, stated in the owner's consent before
 * anything is paid and enforced as that preparation's budget, so the promise and the stop are the same number.
 */

/** Proposal calls one unit may spend over all resumes, repairs included. */
export const PROPOSAL_ATTEMPTS = 5;
/** Calls that read the rules of the whole policy, once for every unit, when they fit one request. */
const POLICY_CALLS = 1;
/** Calls a conversation spends reading a knowledge base too large for one request: two choices of articles, then its rules. */
const READING_CALLS = 3;
/** Review requests one card makes at most: its story and its duties apart when together they do not fit one request. */
const REVIEW_CALLS = 2;

/**
 * The most model calls a preparation makes: the topic map's calls, the policy read once when it fits one request,
 * and for each situation promised the reading of a large knowledge base for its conversation, its proposal allowance
 * and the review of its card. Requests are counted as the topic map's are — each answer passing the first time — and
 * only the proposal allowance holds its repairs; a preparation whose repairs reach the ceiling stops there with what it
 * made, and continues on the owner's word. A conversation that makes no situation spends out of the same ceiling, so
 * the preparation never spends more than it promised. A resume is bounded by the draft's limit.
 */
export function preparationCeiling(input: { task: string; sources: readonly Source[]; situations: number; fromLogs: boolean; topicMapCalls?: number }): number {
  const whole = !workInputIssue({ task: input.task, sources: input.sources });
  const reading = whole || !input.fromLogs ? 0 : READING_CALLS;
  return (input.topicMapCalls ?? 0) + (whole ? POLICY_CALLS : 0) + input.situations * (reading + PROPOSAL_ATTEMPTS + REVIEW_CALLS);
}
