import { z } from 'zod';
import type { Scenario, Trial } from './contracts.js';
import type { RunDerivation } from './run.js';
import { USER_CONTROLLER_PROTOCOL } from './user-controller.js';
import { CARD_CUSTOMER_PROTOCOLS, CUSTOMER_MOVES } from './card-customer.js';

/*
 * What the customer Lab plays did in a run, read from the recorded moves of the controlled customer: how often
 * they answered the agent's question, said «не знаю», turned or left. A move is the action the controller chose;
 * its kind is the one the accepted definition gave that action, so nothing here reads what anyone wrote. Only a
 * controlled customer records moves: a run without them (older records, a free simulator) has nothing to show,
 * and the result says nothing rather than zero. Pure: no I/O, no wording.
 */

/** A turn is a late change of intent or a report of what the customer sees; `other` is a first-format clarification or correction. */
export type MoveKind = 'answer' | 'missing' | 'turn' | 'finish' | 'other';

/** The customer's moves over the counted conversations, and the failed situations where «не знаю» may have blocked the goal. */
export interface CustomerMoves {
  answer: number; missing: number; turn: number; finish: number; other: number;
  /** Failed counted situations with at least one failed conversation whose customer said «не знаю» and then left. */
  blocked: string[];
}

/** The part of a controller event its readers need (here and card/calibration-view.ts); anything else in the event is not needed and not checked. */
export const controllerEvent = z.object({ protocol: z.literal(USER_CONTROLLER_PROTOCOL), decision: z.object({ actionId: z.string() }), accepted: z.literal(true) });

/** A move of the customer who speaks in their own words (card-customer.ts): its kind is the move the harness checked. */
const freeEvent = z.object({ protocol: z.enum(CARD_CUSTOMER_PROTOCOLS), move: z.enum(CUSTOMER_MOVES) });
const FREE_KIND: Record<typeof CUSTOMER_MOVES[number], MoveKind> = { answer: 'answer', dunno: 'missing', clarify: 'other', turn: 'turn', leave: 'finish' };

/** The moves of one conversation, in order, as kinds of the actions its definition declares; an action it does not declare is skipped. */
export function trialMoves(scenario: Scenario, trial: Trial): MoveKind[] {
  const actions = scenario.execution?.userView.policy.actions ?? [];
  return trial.events.flatMap(event => {
    if (event.type !== 'simulator') return [];
    const spoken = freeEvent.safeParse(event.result);
    if (spoken.success) return [FREE_KIND[spoken.data.move]];
    const parsed = controllerEvent.safeParse(event.result);
    const action = parsed.success ? actions.find(item => item.id === parsed.data.decision.actionId) : undefined;
    if (!action) return [];
    const kind: MoveKind = action.kind === 'answer' || action.kind === 'missing' || action.kind === 'finish' ? action.kind
      : action.kind === 'change_intent' || action.kind === 'observe' ? 'turn' : 'other';
    return [kind];
  });
}

/**
 * «Не знаю» may have blocked the goal when the customer said it at least once and the conversation ended with the
 * customer leaving after it: the agent's question went unanswered and the customer gave up rather than the talk
 * running out. It is a mark to look at, never a verdict: the agent may have failed for another reason.
 */
export const dunnoThenLeft = (moves: readonly MoveKind[]): boolean => moves.includes('missing') && moves.at(-1) === 'finish';

/**
 * The customer's moves over a run's counted situations; null when no conversation recorded a controlled move. A
 * conversation that ran into the run's limit on the customer's messages (`trial.turnLimit`) ended because the talk ran
 * out, not because the customer gave up, so its last move never marks the situation as blocked by «не знаю».
 */
export function customerMoves(run: RunDerivation): CustomerMoves | null {
  const counts: Record<MoveKind, number> = { answer: 0, missing: 0, turn: 0, finish: 0, other: 0 };
  let recorded = false;
  const failed = new Set(run.failedAttempts.map(trial => trial.id));
  const blocked = new Set<string>();
  for (const situation of run.situations) {
    if (situation.control) continue;
    for (const { trial } of situation.attempts) {
      const moves = trialMoves(situation.scenario, trial);
      if (!moves.length) continue;
      recorded = true;
      for (const move of moves) counts[move]++;
      if (failed.has(trial.id) && !trial.turnLimit && dunnoThenLeft(moves)) blocked.add(situation.scenario.id);
    }
  }
  return recorded ? { ...counts, blocked: [...blocked] } : null;
}
