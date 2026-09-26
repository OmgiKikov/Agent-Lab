import { cardSchema, type BusinessScenario, type Card } from '../card/schema.js';
import { normalizeText } from '../card/checks.js';
import type { Criterion, FromAnalysis, Requirement } from '../contracts.js';
import { criterionHash, expectationCriterionHash, type CriterionLike } from '../criterion.js';
import { importBatch } from '../scenario-library.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { clip } from '../text.js';
import type { LogAnalysis } from './schema.js';
import { problemTitle } from './text.js';
import type { ProblemView } from './view.js';

/*
 * From a problem found in the logs (DISCOVER) to a check of the agent (VERIFY): the same criterion, carried over whole.
 * The check is the ordinary preparation of situations from logs — the same plan, cards, acceptance and run —, with one
 * rule of the harness on top: every card made from a conversation the check names carries the problem's criterion as
 * one of its duties, exactly (its hash), so the run's verdict on that duty is the verdict on the problem.
 *
 *   problem ─► the conversations where it was broken, then those where the same criterion applied, was decided and held
 *              with evidence (controls; a conversation it was not decided on is none)
 *           ─► their original rows read again ─► a new import ─► agent_lab_prepare ─► a card per conversation
 *           ─► withCriterion: the card's duty that is the criterion, or the criterion put in ─► situations the owner accepts
 *
 * The draft keeps the link (contracts.ts `fromAnalysis`): the analysis, the problem, the conversations, the criterion.
 */

/** Conversations one check of a problem is made from at most: the examples one plan of a topic reads. */
export const CHECK_CONVERSATIONS = 8;
/** Seats of a check kept for controls while there are any: the violations never take them all. */
const CONTROL_SEATS = 2;

/**
 * The conversations a check of `problem` is made from: those it was broken in, then its controls — conversations where
 * the same criterion held with evidence (ProblemView.held); at most `limit`, a seat or two kept for controls.
 */
export function problemConversations(problem: Pick<ProblemView, 'dialogueIds' | 'held'>, limit = CHECK_CONVERSATIONS): { dialogueIds: string[]; broken: string[]; controls: string[] } {
  const broken = problem.dialogueIds.slice(0, Math.max(1, limit - Math.min(problem.held.length, CONTROL_SEATS)));
  const controls = problem.held.filter(id => !broken.includes(id)).slice(0, limit - broken.length);
  return { dialogueIds: [...broken, ...controls], broken, controls };
}

/**
 * The link a check of `problem` keeps in its draft (contracts.ts `fromAnalysis`): the analysis, the problem, the
 * conversations — broken first, then controls — and the problem's criterion frozen with its hash.
 */
export function checkLink(analysis: Pick<LogAnalysis, 'id'>, problem: Pick<ProblemView, 'key' | 'criterion' | 'dialogueIds' | 'held' | 'duty'>): { link: FromAnalysis; controls: string[] } {
  const { dialogueIds, broken, controls } = problemConversations(problem);
  return { controls, link: { analysisId: analysis.id, problemKey: problem.key, title: clip(problemTitle(problem), 300), dialogueIds, broken,
    criterion: structuredClone(problem.criterion), criterionHash: problem.key } };
}

/** The controls of a check: the conversations of its link the problem was not found in. */
export const controlsOf = (link: Pick<FromAnalysis, 'dialogueIds' | 'broken'>): string[] => link.dialogueIds.filter(id => !link.broken.includes(id));

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

/** The criterion a check carries, when its link has one whose hash is its own: a link that does not is no criterion. */
export function linkedCriterion(link: FromAnalysis | undefined): { criterion: Criterion; hash: string } | undefined {
  if (!link?.criterion || !link.criterionHash || criterionHash(link.criterion) !== link.criterionHash) return undefined;
  return { criterion: link.criterion, hash: link.criterionHash };
}

/**
 * Whether a duty is the criterion of `hash`: the same criterion (criterion.ts) under no condition of its own — a duty
 * that applies only on some path of the conversation judges less than the criterion does.
 */
export const carriesCriterion = (duty: CriterionLike & { appliesWhen?: string | undefined }, requirements: readonly Requirement[], hash: string): boolean =>
  duty.appliesWhen === undefined && expectationCriterionHash(duty, requirements) === hash;

/**
 * A card of a conversation a check names, carrying the check's criterion as one of its duties exactly. A duty that is the
 * criterion stays as it is; otherwise the duty with the criterion's words (up to case and spacing) becomes the criterion,
 * keeping its id — the builder's reading of the same duty —; otherwise the criterion is added, or takes the place of the
 * last duty when the card has three. `requirements`: the library's rules with the criterion's among them. When the card's
 * plan has an expectation that is the same criterion, the duty names it, as a duty of the plan does.
 */
export function withCriterion(card: Card, criterion: Criterion, requirements: readonly Requirement[], plan?: BusinessScenario): Card {
  const hash = criterionHash(criterion);
  if (card.agentMust.some(duty => carriesCriterion(duty, requirements, hash))) return card;
  const planned = plan?.id === card.scenarioRef?.scenarioId ? plan?.expectations.find(expectation => expectationCriterionHash(expectation, requirements) === hash) : undefined;
  const duty = (id: string): Card['agentMust'][number] => ({ id, text: criterion.text, requirementIds: criterion.requirements.map(requirement => requirement.id),
    observation: criterion.observation, ...(criterion.tool ? { tool: criterion.tool } : {}), ...(criterion.strength ? { strength: criterion.strength } : {}),
    ...(criterion.acceptable !== undefined ? { acceptable: criterion.acceptable } : {}), ...(criterion.violation !== undefined ? { violation: criterion.violation } : {}),
    ...(planned ? { planExpectationId: planned.id } : {}) });
  const same = card.agentMust.findIndex(item => normalizeText(item.text) === normalizeText(criterion.text));
  const at = same >= 0 ? same : card.agentMust.length < 3 ? card.agentMust.length : card.agentMust.length - 1;
  const id = card.agentMust[at]?.id ?? `e${Math.max(0, ...card.agentMust.map(item => Number(item.id.slice(1)) || 0)) + 1}`;
  const agentMust = [...card.agentMust.slice(0, at), duty(id), ...card.agentMust.slice(at + 1)];
  return cardSchema.parse({ ...card, agentMust });
}
