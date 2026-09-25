import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { CallContext } from '../runtime.js';
import { countText } from '../plural.js';
import { DATA_BOUNDARY } from '../prompts.js';
import { callModel, ProviderFailure, type ChatMessage } from './model-call.js';
import { jsonMode, type ModelRole, type ModelTable } from './models.js';

/*
 * A structured task is one typed question to a model: who answers it, what it is told, the exact shape
 * of the answer and the domain rules the answer must satisfy. The harness owns routing, the output
 * contract, repair and the evidence callbacks; a task owns only its content.
 *
 *   input ─► request ─► JSON.parse ─► schema ─► check ─► value
 *              ▲──── repair: the exact reason, at most TASK_ATTEMPTS requests in all ────┘
 */

export interface StructuredTask<O> {
  /** Stable identity: the evidence journal names the task by it, and routing never reads prompt text. */
  readonly id: string;
  /** The owner-facing name of the step, prefixed to its errors. */
  readonly label: string;
  readonly role: ModelRole;
  readonly instructions: string;
  /** The answer's shape, built per call so a reference can be an enum of exactly the ids this call supplied. */
  readonly output: z.ZodType<O>;
  /** A domain rule the schema cannot express; its message goes back to the model verbatim. Pure. */
  readonly check?: (value: O) => string | undefined;
  /**
   * A large evidence task: the answer and the request are capped in bytes, and a repair starts a fresh request
   * carrying the original input and only the latest rejected draft, so failed drafts never pile up in context.
   */
  readonly bounded?: { outputBytes: number; requestBytes: number };
  /** Fewer requests than TASK_ATTEMPTS: a small step whose owner agreed to exactly that many calls. */
  readonly attempts?: number;
}

/** One structured task answered by its role's model: runStructured bound to a runtime and its model table, or a test's stand-in. */
export type TaskRunner = <O>(task: StructuredTask<O>, input: unknown, ctx: CallContext) => Promise<O>;

/**
 * The requests one task may make: the first answer and its repairs together. Repairing a nearly correct object is a
 * much easier task for a model than writing one from scratch, so a rejected answer goes back with the exact reason.
 * Attempts are bounded: after the last the step fails out loud instead of spinning and spending the owner's budget.
 * Rejection text is model-facing and stays English, like the roles; what the owner reads is the Russian error.
 */
export const TASK_ATTEMPTS = 5;

/**
 * The output cap of a bounded task, in tokens, for an answer admitted up to `outputBytes` UTF-8 bytes. The one sure
 * relation between the two units: every token a model writes is at least one byte of text, so `outputBytes` tokens
 * always fit an admissible answer. A runaway answer stops at a few times the admissible size (an average token is
 * several bytes), not at the model's own maximum; that margin is also what a reasoning model's thinking may use first.
 */
const MIN_BYTES_PER_TOKEN = 1;
/** The output cap of a task without a byte bound. */
const DEFAULT_OUTPUT_TOKENS = 16_384;

/** Complete replies were received and charged, but none of them passed the output contract. */
export class StructuredTaskError extends Error {}

const outputContract = (schema: z.ZodType) => `Return exactly one compact JSON object, without markdown fences or pretty-printing whitespace, matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(schema))}\nInside strings, escape double quotes as \\" and line breaks as \\n; when copying source text, «» may stand for its straight double quotes.`;
const userMessage = (text: string): ChatMessage => ({ role: 'user', content: text, timestamp: Date.now() });
const NOT_JSON = 'Return one JSON object and nothing else; escape line breaks inside strings as \\n.';
const repairOf = (rejection: string) => `Your previous answer was rejected. ${rejection}\nReturn the corrected object in full, as one compact JSON object and nothing else.`;

type Admission<O> = { ok: true; value: O } | { ok: false; outcome: 'syntax' | 'schema' | 'domain'; reason: string };
/** The text is parsed as written: broken quotes, raw line breaks and a missing brace are a failed attempt, never a local rewrite. */
function admit<O>(task: StructuredTask<O>, text: string): Admission<O> {
  if (task.bounded && Buffer.byteLength(text, 'utf8') > task.bounded.outputBytes) {
    return { ok: false, outcome: 'schema', reason: `The reply exceeds ${task.bounded.outputBytes} UTF-8 bytes. Shorten it without dropping required fields. ${NOT_JSON}` };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim()); }
  catch (error) {
    return { ok: false, outcome: 'syntax', reason: `The reply was not a single JSON object (Output is not JSON: ${error instanceof Error ? error.message : 'unreadable'}). ${NOT_JSON}` };
  }
  const validated = task.output.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, outcome: 'schema', reason: `These fields do not match the schema: ${validated.error.issues.map(issue => `${issue.path.join('.') || 'root'} (${issue.message})`).join('; ')}.` };
  }
  const problem = task.check?.(validated.data);
  return problem ? { ok: false, outcome: 'domain', reason: problem } : { ok: true, value: validated.data };
}

/** Why a whole reply that cannot be used as it stands (ProviderFailure delivery `answered`) is rejected, in the model's terms. */
const unusable = (failure: ProviderFailure): string => failure.kind === 'length'
  ? `The reply was cut off at the output limit before it was complete. Return a more compact object without dropping required fields. ${NOT_JSON}`
  : `The reply was empty. ${NOT_JSON}`;

/** The step's label leads the message; the error keeps its class and its typed fields, so callers still branch on the kind of failure. */
function labelled(label: string, error: unknown): Error {
  const message = `${label}: ${error instanceof Error ? error.message : 'шаг не удался'}`;
  if (error instanceof StructuredTaskError) return new StructuredTaskError(message, { cause: error });
  if (error instanceof ProviderFailure) {
    return new ProviderFailure(error.kind, message, { delivery: error.delivery, retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }), cause: error });
  }
  return new Error(message, { cause: error });
}

/** «модель 5 раз подряд вернула ответ…», or without the count when the step had one request. */
const repeatedRejection = (attempts: number): string =>
  `модель ${attempts > 1 ? `${countText(attempts, ['раз', 'раза', 'раз'])} подряд ` : ''}вернула ответ, который не проходит проверку`;

/**
 * Asks the task's role model until the answer passes or the attempts run out. Every raw reply, including the
 * partial text of an incomplete one, and every rejection reach the evidence callbacks of `ctx`. A whole reply the
 * provider delivered but that cannot be used (cut at the output cap, empty) was charged like any other and is
 * repaired like any other; a request the provider refused or cut off ends the task with its ProviderFailure.
 */
export async function runStructured<O>(runtime: ModelRuntime, models: ModelTable, task: StructuredTask<O>, input: unknown, ctx: CallContext): Promise<O> {
  const model = models[task.role];
  const format = jsonMode(model);
  const request = {
    system: `${task.instructions}\n${DATA_BOUNDARY}\n${outputContract(task.output)}`,
    maxTokens: task.bounded ? Math.ceil(task.bounded.outputBytes / MIN_BYTES_PER_TOKEN) : DEFAULT_OUTPUT_TOKENS,
    // A reasoning model thinks by the provider's default otherwise, and a long think cuts the answer at maxTokens.
    ...(model.reasoning ? { reasoning: 'minimal' as const } : {}),
    ...(format ? { responseFormat: format } : {}),
    ...(task.bounded ? { maxRequestBytes: task.bounded.requestBytes } : {}),
  };
  ctx.onGeneratorTransport?.({ role: task.id, provider: model.provider, model: model.id, api: model.api, effectiveTemperature: 'provider-default' });
  let messages = [userMessage(JSON.stringify(input))];
  let rejection = '';
  const attempts = Math.min(task.attempts ?? TASK_ATTEMPTS, TASK_ATTEMPTS);
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let reply: Awaited<ReturnType<typeof callModel>>;
      try {
        reply = await callModel(runtime, model, { ...request, messages }, ctx,
          text => ctx.onGeneratorOutput?.({ role: task.id, text, attempt, incomplete: true }));
      } catch (error) {
        if (!(error instanceof ProviderFailure) || error.delivery !== 'answered') throw error;
        rejection = unusable(error);
        ctx.onGeneratorValidation?.({ attempt, accepted: false, reason: rejection, outcome: 'syntax' });
        // No reply message to continue from: the repair is a fresh request with the original input.
        messages = [userMessage(JSON.stringify({ input, repair: repairOf(rejection) }))];
        continue;
      }
      ctx.onGeneratorOutput?.({ role: task.id, text: reply.text, attempt });
      const admission = admit(task, reply.text);
      if (admission.ok) {
        ctx.onGeneratorValidation?.({ attempt, accepted: true });
        return admission.value;
      }
      rejection = admission.reason;
      ctx.onGeneratorValidation?.({ attempt, accepted: false, reason: rejection, outcome: admission.outcome });
      const repair = repairOf(rejection);
      // A bounded task keeps the original evidence and only the latest failure: accumulated full drafts can exhaust the context.
      messages = task.bounded
        ? [userMessage(JSON.stringify({ input, repair, ...(Buffer.byteLength(reply.text, 'utf8') <= task.bounded.outputBytes
          ? { previousReply: reply.text } : { previousReplyOmitted: 'Rejected reply exceeds the output limit; regenerate compactly from the original evidence.' }) }))]
        : [...messages, reply.message, userMessage(repair)];
    }
    throw new StructuredTaskError(`${repeatedRejection(attempts)}. Последняя причина: ${rejection}`);
  } catch (error) {
    throw labelled(task.label, error);
  }
}
