import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fingerprint } from './contracts.js';
import { writeFileAtomic } from './fs-atomic.js';
import { sha256Schema, text } from './ids.js';
import { StructuredTaskError, type StructuredTask, type TaskRunner } from './llm/structured.js';
import type { BuilderModel } from './miner/topic-map.js';
import { PROMPT_PURPOSE_ROLE } from './prompts.js';
import type { PromptCandidate } from './prompt-candidates.js';
import type { CallContext } from './runtime.js';
import { countText, pluralForm } from './plural.js';
import { clip, oneLine } from './text.js';

/*
 * Which of the prompts Lab found write the reply to the customer. An agent keeps dozens of prompts in its code — most
 * of them classifiers, extractors and validators — and a newcomer cannot tell them apart by name, so Lab's builder
 * model reads the beginning of each and proposes a purpose with a one-line reason. The proposal is advice: it ticks
 * the customer_reply prompts in advance, and only the owner's confirmed pick becomes prompt materials.
 *
 *   candidates ─► batches under a byte cap ─► one task per batch (keys = an enum of this call) ─► verdicts
 *                                                     └── cached under hash(ids + texts, model, version) ──► free next look
 *
 * A batch whose answer never passes the schema leaves its prompts «назначение не определено»; a provider failure
 * stores nothing. The cache lives in the data folder, `prompts/purposes-<key>.json`, private like every record.
 */

export const PROMPT_PURPOSES = ['customer_reply', 'classifier', 'extraction', 'validation', 'other'] as const;
export type PromptPurpose = typeof PROMPT_PURPOSES[number];
/** The owner's words for each purpose. */
export const PURPOSE_TEXT: Readonly<Record<PromptPurpose, string>> = {
  customer_reply: 'ответ клиенту', classifier: 'классификатор', extraction: 'извлечение данных', validation: 'проверка ответа', other: 'другое',
};
/** What the model reads of each prompt: its beginning, verbatim. */
export const HEAD_CHARS = 1500;
export const REASON_CHARS = 160;
/** A batch's request stays under this many UTF-8 bytes of prompt data, and names at most BATCH_SIZE prompts. */
const BATCH_BYTES = 36_000;
const BATCH_SIZE = 24;
/** One answer and one repair per batch: the owner agreed to about one call per batch, never more than twice that. */
export const PURPOSE_ATTEMPTS = 2;
/** What a stored proposal was made by: the instruction, how much of each prompt was read, the purposes. */
export const PROMPT_PURPOSE_VERSION = fingerprint({ role: PROMPT_PURPOSE_ROLE, head: HEAD_CHARS, reason: REASON_CHARS, purposes: PROMPT_PURPOSES, attempts: PURPOSE_ATTEMPTS });

/** What the model is shown of one prompt, under the key it answers by. */
interface PurposeItem { key: string; id: string; file: string; identifier?: string; chars: number; head: string }
const itemOf = (candidate: PromptCandidate, index: number): PurposeItem => ({ key: `p${index + 1}`, id: candidate.id, file: candidate.file,
  ...(candidate.identifier ? { identifier: candidate.identifier } : {}), chars: candidate.chars, head: candidate.text.slice(0, HEAD_CHARS) });

/** The candidates in batches: in their order, each batch under the byte cap and the size limit; a single prompt always fits (its head is bounded). */
export function purposeBatches(candidates: readonly PromptCandidate[]): PromptCandidate[][] {
  const batches: PromptCandidate[][] = [];
  let current: PromptCandidate[] = [], bytes = 0;
  for (const candidate of candidates) {
    const size = Buffer.byteLength(JSON.stringify(itemOf(candidate, 0)), 'utf8');
    if (current.length && (bytes + size > BATCH_BYTES || current.length >= BATCH_SIZE)) { batches.push(current); current = []; bytes = 0; }
    current.push(candidate); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}
/** How many calls the proposal is expected to take: one per batch. */
export const purposeCalls = (candidates: readonly PromptCandidate[]): number => purposeBatches(candidates).length;

const verdictSchema = z.strictObject({
  purpose: z.enum(PROMPT_PURPOSES),
  reason: z.string().trim().min(1).max(REASON_CHARS, { error: `The reason is at most ${REASON_CHARS} characters: one short line.` })
    .refine(value => !value.includes('\n'), 'The reason is one line.'),
});
export type PurposeVerdict = z.infer<typeof verdictSchema>;
/** Exactly one answer per listed key: a missing key and an invented one are both rejected, with the key named. */
const answerSchema = (keys: readonly string[]) => z.strictObject({ purposes: z.strictObject(Object.fromEntries(keys.map(key => [key, verdictSchema]))) });
type Answer = { purposes: Record<string, PurposeVerdict> };

/** The task of one batch: its keys are the enum of this call. */
export function purposeTask(keys: readonly string[]): StructuredTask<Answer> {
  return { id: 'prompt-purpose', label: 'Назначение промптов', role: 'builder', instructions: PROMPT_PURPOSE_ROLE,
    output: answerSchema(keys) as z.ZodType<Answer>, attempts: PURPOSE_ATTEMPTS };
}

/** A builder model that sorts prompts: the Pi runtime's, or a test's with scripted replies. */
export interface PurposeReader { builder: BuilderModel; read(batch: readonly PromptCandidate[], ctx: CallContext): Promise<Map<string, PurposeVerdict>> }

/** One batch answered by `run`'s builder model: each candidate's id with its verdict. */
export async function readPurposesWithModel(batch: readonly PromptCandidate[], { run, ctx }: { run: TaskRunner; ctx: CallContext }): Promise<Map<string, PurposeVerdict>> {
  const items = batch.map(itemOf);
  const answer = await run(purposeTask(items.map(item => item.key)), { prompts: items }, ctx);
  return new Map(items.map(item => [item.id, answer.purposes[item.key]!]));
}

/* ───────────────────────────── the stored proposal ───────────────────────────── */

export const purposeProposalSchema = z.strictObject({
  formatVersion: z.literal(1),
  key: sha256Schema,
  model: text(300),
  version: sha256Schema,
  verdicts: z.array(z.strictObject({ id: z.string().min(1).max(4000), ...verdictSchema.shape })).max(10_000),
  /** Why a batch's prompts stayed undetermined: its last rejection. */
  failure: z.string().max(20_000).optional(),
  usage: z.strictObject({ calls: z.number().int().nonnegative(), costUsd: z.number().nonnegative().nullable() }),
  createdAt: z.iso.datetime(),
});
export type PurposeProposal = z.infer<typeof purposeProposalSchema>;

/** One stored proposal per set of candidates (their ids and whole texts), model and version: a changed prompt is proposed afresh. */
export const purposeKey = (candidates: readonly PromptCandidate[], builder: BuilderModel): string =>
  fingerprint({ candidates: candidates.map(candidate => ({ id: candidate.id, text: candidate.text })), model: `${builder.provider}/${builder.id}`, version: PROMPT_PURPOSE_VERSION });

/**
 * Lab's model proposes the purpose of every candidate within PURPOSE_ATTEMPTS calls per batch. A batch that never
 * passes leaves its prompts undetermined and says why; a provider failure is thrown: nothing was proposed, nothing is kept.
 */
export async function proposePurposes(candidates: readonly PromptCandidate[], reader: PurposeReader, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PurposeProposal> {
  const signal = options.signal ?? new AbortController().signal;
  const batches = purposeBatches(candidates);
  const ceiling = PURPOSE_ATTEMPTS * batches.length;
  const usage = { calls: 0, costUsd: 0 as number | null };
  const ctx: CallContext = { signal, timeoutMs: options.timeoutMs,
    beforeCall() {
      signal.throwIfAborted();
      if (usage.calls >= ceiling) throw new Error(`Назначение промптов: больше ${ceiling} вызовов модели не согласовано.`);
      usage.calls++;
    },
    addUsage(value) { usage.costUsd = usage.costUsd === null || value.costUsd === null ? null : usage.costUsd + value.costUsd; },
  };
  const verdicts: PurposeProposal['verdicts'] = [];
  let failure: string | undefined;
  for (const batch of batches) {
    try {
      for (const [id, verdict] of await reader.read(batch, ctx)) verdicts.push({ id, ...verdict });
    } catch (error) {
      if (!(error instanceof StructuredTaskError)) throw error;
      failure = error.message.slice(0, 20_000);
    }
  }
  return purposeProposalSchema.parse({ formatVersion: 1, key: purposeKey(candidates, reader.builder), model: `${reader.builder.provider}/${reader.builder.id}`,
    version: PROMPT_PURPOSE_VERSION, verdicts, ...(failure ? { failure } : {}), usage, createdAt: new Date().toISOString() });
}

const proposalPath = (directory: string, key: string): string => {
  if (!sha256Schema.safeParse(key).success) throw new Error('Некорректный ключ назначения промптов');
  return join(directory, 'prompts', `purposes-${key}.json`);
};
/** The proposal stored under `key`; undefined when there is none or the file is damaged — then it is proposed again. */
export async function readPurposeFile(directory: string, key: string): Promise<PurposeProposal | undefined> {
  try {
    const parsed = purposeProposalSchema.safeParse(JSON.parse(await readFile(proposalPath(directory, key), 'utf8')));
    return parsed.success && parsed.data.key === key ? parsed.data : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
/** Stores a proposal (0600 in a 0700 folder), replacing an earlier one under the same key. */
export async function writePurposeFile(directory: string, proposal: PurposeProposal): Promise<void> {
  const parsed = purposeProposalSchema.parse(proposal);
  await mkdir(join(directory, 'prompts'), { recursive: true, mode: 0o700 });
  await writeFileAtomic(proposalPath(directory, parsed.key), JSON.stringify(parsed));
}

/* ───────────────────────────── what the owner sees ───────────────────────────── */

/** A candidate as Lab proposes it: its purpose and reason when the model gave one, and whether it is ticked in advance. */
export interface ProposedPrompt { candidate: PromptCandidate; verdict?: PurposeVerdict; suggested: boolean }

/** The candidates in the order Lab proposes: by purpose, customer_reply first, undetermined last, otherwise as found; customer_reply ticked. */
export function proposedPrompts(candidates: readonly PromptCandidate[], proposal: PurposeProposal | undefined): ProposedPrompt[] {
  const verdicts = new Map(proposal?.verdicts.map(({ id, purpose, reason }) => [id, { purpose, reason }]));
  const rank = (item: ProposedPrompt) => item.verdict ? PROMPT_PURPOSES.indexOf(item.verdict.purpose) : PROMPT_PURPOSES.length;
  return candidates.map(candidate => {
    const verdict = verdicts.get(candidate.id);
    return { candidate, ...(verdict ? { verdict } : {}), suggested: verdict?.purpose === 'customer_reply' };
  }).map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item);
}

/** The purpose in the owner's words, one line: «ответ клиенту · …причина», or «назначение не определено». */
export function purposeLine(item: ProposedPrompt, width = 90): string {
  return item.verdict ? clip(oneLine(`${PURPOSE_TEXT[item.verdict.purpose]} · ${item.verdict.reason}`), width) : 'назначение не определено';
}

const CALLS: [string, string, string] = ['вызов', 'вызова', 'вызовов'];
/** What the proposal costs, in the owner's words: «≈2 вызова». */
export const purposeCallsText = (candidates: readonly PromptCandidate[]): string => `≈${countText(purposeCalls(candidates), CALLS)}`;
/** What the owner agrees to before the model reads the prompts. */
export function purposeConsentLine(candidates: readonly PromptCandidate[]): string {
  return `Lab может прочитать начало ${candidates.length} ${pluralForm(candidates.length, ['промпта', 'промптов', 'промптов'])} своей моделью и отметить те, что пишут ответ клиенту: ${purposeCallsText(candidates)}.`;
}
