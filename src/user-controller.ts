import { z } from 'zod';
import { behaviorPolicySchema, type BehaviorPolicy } from './scenario-contracts.js';

export const USER_CONTROLLER_PROTOCOL = 'controlled-user-v1';
/**
 * The controller's whole answer: which of the moves allowed right now the customer makes, as one of
 * exactly their ids. The harness renders the message from the chosen action — its fixed words or its
 * facts — so the answer carries no text and no fact references that could be wrong.
 */
export function userDecisionSchema(actions: readonly Pick<AllowedUserAction, 'id'>[]) {
  const [first, ...rest] = actions.map(action => action.id);
  if (first === undefined) throw new Error('Симулятор: у клиента не осталось допустимых действий.');
  return z.strictObject({ actionId: z.enum([first, ...rest]) });
}
export interface UserDecision { actionId: string }
export const userViewSchema = z.strictObject({
  goal: z.string(), opening: z.string(), policy: behaviorPolicySchema,
  facts: z.array(z.strictObject({ id: z.string(), statement: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).optional() })).max(20),
  missing: z.array(z.string()).max(20), persona: z.string().optional(),
});
export type UserView = z.infer<typeof userViewSchema>;
interface UserState { policy: BehaviorPolicy; facts: UserView['facts']; position: string; counts: Record<string, number>; followUps: number; changed: string[] }
export type AllowedUserAction = BehaviorPolicy['actions'][number] & { to: string; when: string };

export function createUserState(policy: BehaviorPolicy, facts: UserView['facts']): UserState {
  const parsed = behaviorPolicySchema.parse(policy);
  if (!parsed.states.includes(parsed.initialState) || parsed.terminalStates.some(s => !parsed.states.includes(s))) throw new Error('Симулятор: неизвестное состояние политики');
  if (new Set(parsed.actions.map(a => a.id)).size !== parsed.actions.length || new Set(facts.map(f => f.id)).size !== facts.length) throw new Error('Симулятор: повтор идентификатора');
  for (const a of parsed.actions) {
    if (a.factIds.some(id => !facts.some(f => f.id === id))) throw new Error('Симулятор: действие ссылается на неразрешённый факт');
    if (a.kind === 'finish' && (a.payload || a.factIds.length)) throw new Error('Симулятор: finish не должен содержать сообщение');
    if (a.kind === 'observe' && (a.factIds.length || !a.payload)) throw new Error('Симулятор: наблюдение — это реплика клиента, без ссылки на исходный факт');
    if (a.kind !== 'finish' && a.kind !== 'observe' && !a.payload && !a.factIds.length && a.kind !== 'missing') throw new Error('Симулятор: нет разрешённого сообщения');
  }
  const edges = new Set<string>();
  for (const t of parsed.transitions) {
    const a = parsed.actions.find(a => a.id === t.actionId);
    if (!a || !parsed.states.includes(t.from) || !parsed.states.includes(t.to) || parsed.terminalStates.includes(t.from)) throw new Error('Симулятор: недопустимый переход');
    const key = `${t.from}/${t.actionId}`;
    if (edges.has(key)) throw new Error('Симулятор: неоднозначный переход'); edges.add(key);
    if (a.kind === 'finish' && !parsed.terminalStates.includes(t.to)) throw new Error('Симулятор: finish должен завершать диалог');
  }
  return { policy: structuredClone(parsed), facts: structuredClone(facts), position: parsed.initialState, counts: {}, followUps: 0, changed: [] };
}

function candidates(state: UserState): AllowedUserAction[] {
  if (state.policy.terminalStates.includes(state.position)) return [];
  return state.policy.transitions.filter(t => t.from === state.position).flatMap(t => {
    const a = state.policy.actions.find(a => a.id === t.actionId)!;
    if ((state.counts[a.id] ?? 0) >= state.policy.repetitionLimit || (a.kind !== 'finish' && state.followUps >= state.policy.maxFollowUps)) return [];
    return [{ ...a, to: t.to, when: t.when }];
  });
}
function moved(state: UserState, action: AllowedUserAction): UserState {
  return { ...state, position: action.to, counts: { ...state.counts, [action.id]: (state.counts[action.id] ?? 0) + 1 },
    followUps: state.followUps + (action.kind === 'finish' ? 0 : 1), changed: action.kind === 'change_intent' ? [...new Set([...state.changed, action.id])] : [...state.changed] };
}
function complete(state: UserState): boolean {
  return state.policy.terminalStates.includes(state.position) && state.policy.actions.filter(a => a.kind === 'change_intent').every(a => state.changed.includes(a.id));
}
/**
 * Bounded graph search: a finish cannot skip a declared staged intention. A move that stays where it is and
 * changes no intention (answering one more question) only spends a follow-up and a repetition, so every way
 * to the end after it is also open without it: it never shortens the way and is not searched. This keeps the
 * search to the moves between states, however many questions a customer can answer.
 */
function distance(state: UserState, memo = new Map<string, number>(), budget = { remaining: 20000 }): number {
  if (complete(state)) return 0;
  if (--budget.remaining < 0) throw new Error('Симулятор: политика слишком сложна для проверки конечного пути');
  const key = JSON.stringify([state.position, state.counts, state.changed]);
  if (memo.has(key)) return memo.get(key)!;
  let best = Infinity;
  for (const action of candidates(state)) {
    if (action.to === state.position && action.kind !== 'change_intent') continue;
    best = Math.min(best, (action.kind === 'finish' ? 0 : 1) + distance(moved(state, action), memo, budget));
  }
  memo.set(key, best);
  return best;
}
export function allowedUserActions(state: UserState, _observation: string): AllowedUserAction[] {
  // Natural-language conditions are selected by the model from the visible reply. The graph,
  // references, repetitions, exact payload and required staged requests are enforced here.
  return candidates(state).filter(a => Number.isFinite(distance(moved(state, a))));
}
export function requiredUserTurns(policy: BehaviorPolicy, facts: UserView['facts']): number {
  const value = distance(createUserState(policy, facts));
  if (!Number.isFinite(value)) throw new Error('Симулятор: обязательный путь не помещается в политику или недостижим');
  return value + 1;
}
/** One move of the customer; the message is the action's own payload or the statements of its facts, never text from the decision. */
export function advanceUser(state: UserState, decision: UserDecision): { state: UserState; message: string; done: boolean } {
  const action = allowedUserActions(state, '').find(a => a.id === decision.actionId);
  if (!action) throw new Error('Симулятор: действие или переход не разрешены; соблюдайте порядок намерений и предел повторов');
  const next = moved(state, action);
  const message = action.kind === 'finish' ? '' : action.payload ?? (action.kind === 'missing' ? 'У меня нет этих данных.' : action.factIds.map(id => state.facts.find(f => f.id === id)!.statement).join('\n'));
  return { state: next, message, done: complete(next) };
}
