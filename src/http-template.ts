import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/*
 * An HTTP agent in its own request format: the owner's envelope with placeholders, sent as is each turn.
 *
 *   template body/headers ──render({{message}}, {{conversation}}, {{uuid}}, {{now}}, {{env:NAME}})──► POST url
 *   reply JSON ──JSON pointer (RFC 6901)──► the agent's text
 *
 * Only the customer's new message goes out each turn: such an agent keeps the conversation itself, by its id.
 * {{conversation}} is fresh per dialogue, so every situation starts a new conversation — that is its reset.
 * Placeholders are parsed over the TEMPLATE only (structure the owner wrote); a reply is read by pointer, never
 * searched. Environment values are read at request time and never stored, like `headersEnv`.
 */

/** Every placeholder the template may hold; anything else in double braces is refused when the connection is read. */
const PLACEHOLDER = /\{\{(message|conversation|uuid|now|env:[A-Z_][A-Z0-9_]{0,99})\}\}/g;
const EXACT = new RegExp(`^${PLACEHOLDER.source}$`);
const BRACES = /\{\{[^{}]*\}\}/g;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.string().max(20000), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonSchema).max(200), z.record(z.string().max(200), jsonSchema)]));

/** RFC 6901: empty for the whole document, otherwise `/`-separated tokens with `~1` for `/` and `~0` for `~`. */
export const pointerSchema = z.string().max(1000).refine(p => p === '' || p.startsWith('/'), 'JSON pointer starts with /');

/** Every string of a JSON value with its pointer, in document order. */
export function stringFields(value: unknown, pointer = ''): { pointer: string; value: string }[] {
  if (typeof value === 'string') return [{ pointer, value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => stringFields(item, `${pointer}/${i}`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) =>
    stringFields(item, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  return [];
}

const unknownPlaceholders = (text: string) => [...text.matchAll(BRACES)].map(m => m[0]).filter(m => !EXACT.test(m));

export const requestTemplateSchema = z.strictObject({
  body: jsonSchema,
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Invalid header name'), z.string().max(4000)).default({}),
  /** Where the agent's text is in its reply; unset until the owner picks it from `agent-lab doctor`. */
  reply: pointerSchema.optional(),
}).superRefine((template, ctx) => {
  const texts = [...stringFields(template.body).map(field => field.value), ...Object.values(template.headers)];
  const unknown = [...new Set(texts.flatMap(unknownPlaceholders))];
  if (unknown.length) ctx.addIssue({ code: 'custom', message: `Неизвестные подстановки в шаблоне: ${unknown.join(', ')}. Доступны {{message}}, {{conversation}}, {{uuid}}, {{now}}, {{env:ИМЯ}}.` });
  if (!stringFields(template.body).some(field => field.value.includes('{{message}}'))) ctx.addIssue({ code: 'custom', path: ['body'], message: 'В теле запроса нет {{message}}: агент не получит сообщение клиента.' });
});
export type RequestTemplate = z.infer<typeof requestTemplateSchema>;

/** The values of one request: the message and conversation of the turn, a fresh id and time. */
export interface RequestValues { message: string; conversation: string }

function renderText(text: string, values: RequestValues & { uuid: string; now: string }): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    if (name === 'message') return values.message;
    if (name === 'conversation') return values.conversation;
    if (name === 'uuid') return values.uuid;
    if (name === 'now') return values.now;
    const variable = name.slice('env:'.length);
    const value = process.env[variable];
    if (!value) throw new Error(`Не задана переменная окружения ${variable} для шаблона запроса. Задайте её перед запуском Pi.`);
    return value;
  });
}

function renderJson(value: Json, render: (text: string) => string): Json {
  if (typeof value === 'string') return render(value);
  if (Array.isArray(value)) return value.map(item => renderJson(item, render));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderJson(item, render)]));
  return value;
}

/** One request's body and headers: {{uuid}} and {{now}} are the same everywhere within it and new in the next. */
export function renderRequest(template: RequestTemplate, values: RequestValues): { body: Json; headers: Record<string, string> } {
  // Match the common curl `date -u +%Y-%m-%dT%H:%M:%SZ` header exactly: some gateways reject milliseconds.
  const all = { ...values, uuid: randomUUID(), now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  const render = (text: string) => renderText(text, all);
  return { body: renderJson(template.body, render), headers: Object.fromEntries(Object.entries(template.headers).map(([name, text]) => [name, render(text)])) };
}

/** The value at an RFC 6901 pointer, or undefined when the path is not there. */
export function atPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  let current = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current && typeof current === 'object' && Object.hasOwn(current, token)) current = (current as Record<string, unknown>)[token];
    else return undefined;
  }
  return current;
}

/** The agent answered, but not where its connection says the text is: the dialogue is not measured, the agent's side is named. */
export class MissingReplyText extends Error {
  constructor(readonly pointer: string) { super(`В ответе агента нет текста по пути ${pointer || '/'}. Проверьте путь: agent-lab doctor покажет строение ответа.`); }
}

export function replyText(document: unknown, pointer: string): string {
  const value = atPointer(document, pointer);
  if (typeof value !== 'string') throw new MissingReplyText(pointer);
  return value;
}

/** The reply's structure for the owner: where its strings are and how long they are — never their values. */
export function replyStructure(document: unknown): { pointer: string; length: number }[] {
  return stringFields(document).slice(0, 100).map(field => ({ pointer: field.pointer, length: field.value.length }));
}
