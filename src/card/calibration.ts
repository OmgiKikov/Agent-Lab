import { z } from 'zod';
import type { CallContext, Requirement, Source } from '../contracts.js';
import { identifierSchema as id, sha256Schema as hash, text } from '../ids.js';
import type { ImportBatch } from '../scenario-contracts.js';
import type { Expectation } from './expectations.js';

/*
 * Sim-to-real calibration (card-v2 §10): the stored shapes. The owner's thesis is that synthetic customers in
 * situations taken from real logs give an accuracy close to production. Each expectation of a situation from a
 * log is therefore judged twice: (a) on the synthetic run, as every expectation is, and (b) on the recorded
 * conversation itself — the real customer and the real agent's replies, with no agent, simulator or stand
 * started. The two never share a receipt, a sidecar or a protocol hash, so neither can pass for the other.
 * Agreement is a trust line next to the number; the number itself never changes because of it.
 *
 * Every schema here is stored: a new field is `.optional()`, never `.default()`. This module imports nothing
 * at run time but zod and the id shapes, so the record contract can hold it without an import cycle.
 */

export const CALIBRATION_PROTOCOL = 'sim-to-real-v1';
/** The judge's mode on a recorded conversation; a change of its input builder is a new mode, never an edit of this one. */
export const LOGGED_MODE = 'logged-v1';

/**
 * The owner's word on which version of the agent wrote an import's logs; `null` — «неизвестно». A command of
 * its own: the declaration is kept beside the import, never in a library, so declaring after an acceptance
 * leaves every library hash and acceptance as it was.
 */
export const logVersionCommandSchema = z.strictObject({ kind: z.literal('declare_log_version'), importId: id, version: text(200).nullable() });
export type LogVersionCommand = z.infer<typeof logVersionCommandSchema>;

/** One declaration exactly as the owner confirmed it, with where they confirmed it. */
const logVersionReceiptSchema = z.strictObject({ id, at: z.iso.datetime(), via: z.enum(['pi-confirm', 'board', 'cli-yes']), command: logVersionCommandSchema });
export type LogVersionReceipt = z.infer<typeof logVersionReceiptSchema>;

/**
 * The declarations of one import (`imports/<importId>.declarations.json`), only ever appended: the last one
 * holds. An export mixing agent versions is split into separate imports, one version each.
 */
export const logVersionJournalSchema = z.strictObject({
  formatVersion: z.literal(1), importId: id, contentHash: hash,
  declarations: z.array(logVersionReceiptSchema).min(1).max(1000),
}).refine(journal => journal.declarations.every(item => item.command.importId === journal.importId), 'A declaration names another import')
  .refine(journal => new Set(journal.declarations.map(item => item.id)).size === journal.declarations.length, 'Declaration ids repeat');
export type LogVersionJournal = z.infer<typeof logVersionJournalSchema>;

const condition = z.enum(['met', 'not_met', 'unclear']);
const verdict = z.enum(['pass', 'fail', 'unknown']);

/**
 * The receipt of one expectation judged on one recorded conversation. It is addressed by content — the
 * accepted definition, the expectation, the immutable import, the dialogue and the judge's protocol — so a
 * repeat or a reassessment with nothing of that changed reuses it for free. `votes` lists every answer in
 * order, a malformed one re-asked included (`error`); two answers that parse are the votes, and the result is
 * theirs when they agree. `skipped`: the log could not show the expectation, and the judge was not asked.
 */
export const logJudgmentReceiptSchema = z.strictObject({
  mode: z.literal(LOGGED_MODE),
  key: hash,
  cardId: id, expectationId: id, definitionHash: hash,
  importId: id, importContentHash: hash, dialogueId: id,
  protocolHash: hash, inputHash: hash, auditHash: hash.optional(),
  provider: text(120), model: text(200),
  skipped: z.enum(['no_agent_reply', 'channel_unobserved']).optional(),
  votes: z.array(z.strictObject({ pass: condition.optional(), fail: condition.optional(), result: verdict.optional(), error: z.literal(true).optional() })).max(4),
  result: verdict,
  complete: z.boolean(),
});
export type LogJudgmentReceipt = z.infer<typeof logJudgmentReceiptSchema>;

/**
 * A run's calibration, only ever added to. `logVersions` is the snapshot of the declarations it used, so the
 * result reads the same whatever is declared later; an import nobody declared has no row and counts as
 * unknown. `unfinished`: the calibration stopped before every expectation was judged — the budget of the run
 * could not cover it (it is then skipped whole before any call) or the run was stopped.
 */
export const calibrationSchema = z.strictObject({
  protocol: z.literal(CALIBRATION_PROTOCOL),
  logVersions: z.array(z.strictObject({ importId: id, contentHash: hash, version: text(200).nullable(), receiptId: id })).max(30),
  testedVersion: text(200).nullable(),
  entries: z.array(logJudgmentReceiptSchema).max(600),
  unfinished: z.enum(['budget', 'stopped']).optional(),
});
export type Calibration = z.infer<typeof calibrationSchema>;

/** The run setting: calibrate after the synthetic run (`auto`, the default) or not at all. */
export const calibrationSettingSchema = z.enum(['auto', 'off']);

/** A logged dialogue as the log judge reads it. */
export type LoggedDialogue = Pick<ImportBatch['dialogues'][number], 'observation' | 'events'>;

/** One expectation of an accepted definition put to the judge on its recorded conversation. */
export interface LogJudgeRequest {
  /** The key the judgment is addressed by; its audit sidecar is named by it. */
  key: string;
  /** The expectation as the accepted definition holds it, with the letter and the situation it is read by («карточки №3»). */
  expectation: Expectation; letter: string; card: string;
  /** The owner rules the expectation cites, as the accepted definition holds them. */
  requirements: Requirement[];
  /** The owner's materials, prompt sources as their observable rules — what the synthetic judgment reads. */
  sources: Source[];
  importContentHash: string;
  dialogue: LoggedDialogue;
}

/** The judge's side of a receipt; the calibration adds what the key is made of. */
export type LogJudgment = Pick<LogJudgmentReceipt, 'protocolHash' | 'inputHash' | 'auditHash' | 'provider' | 'model' | 'votes' | 'result' | 'complete'>;

/** The judge of recorded conversations a runtime offers: who it is, the protocol every key carries, and one judgment. */
export interface LogJudge {
  provider: string; model: string;
  protocolHash: string;
  assess(request: LogJudgeRequest, ctx: CallContext): Promise<LogJudgment>;
}
