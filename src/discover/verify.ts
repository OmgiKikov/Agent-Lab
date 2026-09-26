import { importBatch } from '../scenario-library.js';
import type { ImportBatch } from '../scenario-contracts.js';
import type { LogAnalysis } from './schema.js';
import type { ProblemView } from './view.js';

/*
 * From a problem found in the logs (DISCOVER) to a check of the agent (VERIFY): the conversations a check of the problem
 * is made from, as an import of their own. The check itself is the ordinary preparation of situations from logs — the
 * same plan, cards, acceptance and run — so nothing here makes a test in a new format:
 *
 *   problem ─► the conversations where it was broken, then the other analysed conversations of its topics
 *            (the opposite case the same rules ask: «номер назван — не спрашивай» next to «номера нет — уточни»)
 *          ─► their original rows read again ─► a new import ─► agent_lab_prepare ─► situations the owner accepts
 *
 * The draft keeps the link (contracts.ts `discovery`): which analysis, which problem, which conversations.
 */

/** Conversations one check of a problem is made from at most: the examples one plan of a topic reads. */
export const CHECK_CONVERSATIONS = 8;

/**
 * The conversations a check of `problem` is made from: every conversation it was broken in, then the other analysed
 * conversations of the topics it was found in — a fix of the problem must not break those — at most `limit`.
 */
export function problemConversations(analysis: Pick<LogAnalysis, 'topics'>, problem: Pick<ProblemView, 'dialogueIds' | 'topics'>, limit = CHECK_CONVERSATIONS): string[] {
  const others = analysis.topics.filter(group => problem.topics.includes(group.title)).flatMap(group => group.dialogueIds);
  return [...new Set([...problem.dialogueIds, ...others])].slice(0, limit);
}

/**
 * An import of some conversations of `batch`: their original rows read again, the way the batch read them (its table of
 * masks and the owner's word on role names), so each conversation is the one the analysis judged. A new import, sealed
 * by its own content hash; `batch` is never changed.
 */
export function subsetImport(batch: ImportBatch, dialogueIds: readonly string[]): ImportBatch {
  const rows = dialogueIds.map(id => batch.dialogues.find(dialogue => dialogue.id === id)).filter(dialogue => !!dialogue).map(dialogue => dialogue.original);
  if (!rows.length) throw new Error('Разговоров этой проблемы в логах разбора больше нет.');
  return importBatch(rows, new Map(), { maskVersion: batch.maskVersion ?? 1, ...(batch.roles ? { roles: new Map(batch.roles.map(item => [item.value, item.role])) } : {}) });
}
