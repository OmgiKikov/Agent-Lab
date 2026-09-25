import { z } from 'zod';
import type { TaskRunner } from './llm/structured.js';
import type { BuilderModel } from './miner/topic-map.js';
import type { CallContext } from './runtime.js';
import { BUILDER_CALLS } from './judge-check.js';

/*
 * The builder's one question of a judge check (judge-check.ts): rewrite one agent reply of a recorded dialogue so
 * that one expectation is clearly broken. The answer names the reply by an enum of this dialogue's reply indices;
 * the harness applies it to a copy of the dialogue only. The prompt is not part of any stored hash: a check keeps
 * the builder's answer itself.
 */

/**
 * What the builder reads: the one expectation as the definition holds it — its words, whether it forbids
 * (`strength: 'must_not'`), when it applies, what else fulfils it and what breaks it —, the owner rules it cites
 * (verbatim) and the agent's replies by index.
 */
export interface PlantRequest {
  expectation: { text: string; strength?: 'must_not'; appliesWhen?: string; acceptable?: string; violation?: string };
  rules: string[];
  replies: { index: number; text: string }[];
}
export interface PlantedError { replyIndex: number; newReply: string; whatWasBroken: string }
/** The builder of planted errors: its model, and the call that writes one error. */
export interface ErrorPlanter {
  builder: BuilderModel;
  plant(request: PlantRequest, ctx: CallContext): Promise<PlantedError>;
}

export const PLANT_ERROR_ROLE = `You plant one deliberate error to test a judge of an AI agent.
You receive one expectation the agent under test must meet, the owner rules it cites (verbatim quotes) and the agent's replies of one recorded conversation, each with its index.
The expectation holds its text; strength "must_not" when the text names what the agent must NOT do; appliesWhen, the condition under which it applies; acceptable, another path that also meets it; violation, what breaking it looks like.
Choose the reply where this expectation is decided and rewrite that one reply so the expectation is clearly and unambiguously broken: for a "must_not" expectation do what it forbids; otherwise omit what it requires or state the opposite of it. When violation is given, break it that way; never write a reply that the acceptable path allows. A careful reader must see the violation from the new reply alone.
Keep the reply natural and plausible for this agent: the same language, tone and length, no hint that it was altered. Change nothing that the expectation does not need.
Return the index of the reply you rewrote, the full new reply, and whatWasBroken: one short sentence in Russian (at most 160 characters) naming what the new reply breaks, in plain words.`;

/** The answer of one planting, bound to the replies this call offered. */
export function plantedErrorSchema(request: PlantRequest) {
  const indices = request.replies.map(reply => reply.index);
  return z.strictObject({
    replyIndex: z.literal(indices as [number, ...number[]], { error: `Not a reply index of this dialogue: answer one of ${indices.join(', ')}.` }),
    newReply: z.string().trim().min(1).max(6000),
    whatWasBroken: z.string().trim().min(1).max(160),
  });
}

/** One planted error written by the builder in exactly one request: the owner's ceiling counts it as one call. */
export function plantError(request: PlantRequest, work: { run: TaskRunner; ctx: CallContext }): Promise<PlantedError> {
  if (!request.replies.length) throw new Error('В разговоре нет ответа агента: подбросить ошибку некуда.');
  const original = new Map(request.replies.map(reply => [reply.index, reply.text.trim()]));
  return work.run({
    id: 'plant-error', label: 'Подброшенная ошибка', role: 'builder', instructions: PLANT_ERROR_ROLE, attempts: BUILDER_CALLS,
    output: plantedErrorSchema(request),
    check: value => value.newReply === original.get(value.replyIndex) ? `The new reply is identical to reply ${value.replyIndex}: rewrite it so the expectation is broken.` : undefined,
  }, request, work.ctx);
}
