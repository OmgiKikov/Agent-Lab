import { z } from 'zod';
import { requestTemplateSchema } from './http-template.js';

/*
 * Who answers the simulated user: an external agent speaking a JSON contract (see targets.ts); its secrets stay
 * in environment variables. `sandbox` is a retired built-in agent: old records still parse, nothing runs it.
 * `unconnected` is a draft whose situations were prepared before the agent was connected (the owner's decision
 * of 23.09): nothing runs until it is, and Lab asks for the connection right before the run.
 */
const text = z.string().trim().min(1);
const promptFile = z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute prompt path required').optional();
const absolutePath = z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required');
/** Deploys the version under test before a run. Identity still comes from the adapter's `version`; the hook only performs the rollout. */
const releaseSchema = z.strictObject({
  command: z.string().min(1).max(4000), args: z.array(z.string().max(4000)).max(50).default([]),
  cwd: absolutePath.optional(), timeoutMs: z.number().int().min(1000).max(600000).default(120000),
}).optional();
/** Substrings of a reply that mean the stand, not the agent, answered («нет ответа от смежной системы»): such a dialogue is not measured. */
const serviceReplies = z.array(text.max(300)).max(20).optional();
/**
 * The test customer of the stand, as the owner declares it: what every simulated customer knows about their own
 * account (terminal number, shop, INN…) and names when the agent asks. A bank agent identifies its customer first;
 * without these the simulated customer can only say «не знаю», and the conversation fails on the stand, not on the agent.
 */
export const customerProfileSchema = z.array(z.strictObject({
  label: text.max(120), value: z.union([text.max(300), z.number(), z.boolean()]), askedAs: text.max(200).optional(),
})).max(20).optional();
export type CustomerProfile = NonNullable<z.infer<typeof customerProfileSchema>>;
const customerProfile = customerProfileSchema;
/** A field of a retired feature: old connections and records still parse, nothing reads it. */
const retired = z.unknown().optional();
const httpTargetSchema = z.strictObject({
  kind: z.literal('http'), diagnosticCapabilities: retired, promptFile, serviceReplies, customerProfile, url: z.string().url().max(2000),
  headersEnv: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Invalid header name'), z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/, 'Header values must name environment variables')).default({}),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  release: releaseSchema,
  /** The agent's own request format (http-template.ts); without it Lab speaks its own JSON contract. */
  request: requestTemplateSchema.optional(),
}).refine(target => !(target.request && target.promptFile), { message: 'Агент в своём формате запроса не получает промпт из файла: уберите promptFile или request.', path: ['promptFile'] });
const moduleTargetSchema = z.strictObject({
  kind: z.literal('module'), diagnosticCapabilities: retired, promptFile, serviceReplies, customerProfile, path: z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required'),
  exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/).default('createSession'),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
  release: releaseSchema,
});
/** A local process (for example `python3 agent.py`) speaking one JSON request/reply per line over stdin/stdout. */
const commandTargetSchema = z.strictObject({
  kind: z.literal('command'), diagnosticCapabilities: retired, promptFile, serviceReplies, customerProfile, command: z.string().min(1).max(4000), args: z.array(z.string().max(4000)).max(50).default([]),
  cwd: z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required').optional(),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  release: releaseSchema,
});
const unconnectedTargetSchema = z.strictObject({ kind: z.literal('unconnected') });
export const targetSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('sandbox') }), httpTargetSchema, moduleTargetSchema, commandTargetSchema, unconnectedTargetSchema]);
export type Target = z.infer<typeof targetSchema>;
export const SANDBOX_RETIRED = 'Встроенная учебная песочница больше не запускается: подключите своего агента (http, module или command). Сохранённые результаты песочницы по-прежнему открываются.';
export const UNCONNECTED = 'Агент ещё не подключён: скажите, как его запускать — команда, файл модуля или адрес.';
const targetError = (issue: { input?: unknown }) => issue.input === undefined ? 'Укажите подключение агента: http, module или command.'
  : (issue.input as { kind?: unknown } | null)?.kind === 'sandbox' ? SANDBOX_RETIRED : undefined;
/** A target Lab can run today. A run and a changed connection take only these. */
export const runnableTargetSchema = z.discriminatedUnion('kind', [httpTargetSchema, moduleTargetSchema, commandTargetSchema], { error: targetError });
export type RunnableTarget = z.infer<typeof runnableTargetSchema>;
/** What a new draft names: an agent Lab can run, or none yet — its situations are prepared now, the connection is asked for before the run. */
export const draftTargetSchema = z.discriminatedUnion('kind', [httpTargetSchema, moduleTargetSchema, commandTargetSchema, unconnectedTargetSchema], { error: targetError });
/** The same message wherever a stored record would have to run a target it cannot. */
export function runnableTarget(target: Target): RunnableTarget {
  if (target.kind === 'sandbox') throw new Error(SANDBOX_RETIRED);
  if (target.kind === 'unconnected') throw new Error(UNCONNECTED);
  return target;
}
/** A target that names how to reach an agent: not retired, not waiting for its connection. */
export const isRunnable = (target: Target): target is RunnableTarget => target.kind !== 'sandbox' && target.kind !== 'unconnected';
