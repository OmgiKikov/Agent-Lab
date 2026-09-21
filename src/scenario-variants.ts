import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scenarioVariantSchema, type ScenarioLibrary, type ScenarioVariant } from './scenario-contracts.js';
import { addGeneratedVariant } from './scenario-library.js';

export type VariantOperation = 'reveal_on_request' | 'missing_fact' | 'ambiguous_opening' | 'changed_intent' | 'tool_failure';
export interface VariantRequest {
  parentId: string;
  operation: VariantOperation;
  reason: string;
  input: unknown;
}
export interface VariantFieldDiff { path: string; before?: unknown; after?: unknown }
export interface VariantProposalResult { library: ScenarioLibrary; variant: ScenarioVariant; diff: VariantFieldDiff[] }

const shortText = z.string().trim().min(1).max(1000);
const inputs = {
  reveal_on_request: z.strictObject({ factId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), opening: z.string().trim().min(1).max(3000).optional(), ifAsked: z.string().trim().min(1).max(300), reply: shortText.optional() }),
  missing_fact: z.strictObject({ factId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), opening: z.string().trim().min(1).max(3000).optional(),
    missingDescription: z.string().trim().min(1).max(300).optional(), ifAsked: z.string().trim().min(1).max(300), reply: shortText.optional() }),
  ambiguous_opening: z.strictObject({ opening: z.string().trim().min(1).max(3000) }),
  changed_intent: z.strictObject({ intent: z.string().trim().min(1).max(1000), afterActionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }),
  tool_failure: z.strictObject({ operation: z.string().trim().min(1).max(200), failures: z.number().int().min(1).max(15).default(1) }),
} as const;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const changed = (diff: VariantFieldDiff[], path: string, before: unknown, after: unknown) => diff.push({ path, before: structuredClone(before), after: structuredClone(after) });

/**
 * Removing a revealed fact removes the transitions that revealed it. States nothing reaches any more,
 * their transitions and the actions only they used leave with it; an action that was never
 * referenced stays for the quality gate to report.
 */
function pruneUnreachable(policy: ScenarioVariant['behaviorPolicy'], referencedBefore: Set<string>): void {
  const reachable = new Set([policy.initialState]);
  for (let grew = true; grew;) {
    grew = false;
    for (const transition of policy.transitions) if (reachable.has(transition.from) && !reachable.has(transition.to)) { reachable.add(transition.to); grew = true; }
  }
  const terminal = policy.terminalStates.filter(state => reachable.has(state));
  if (!terminal.length) return;
  policy.states = policy.states.filter(state => reachable.has(state));
  policy.terminalStates = terminal;
  policy.transitions = policy.transitions.filter(transition => reachable.has(transition.from));
  const used = new Set(policy.transitions.map(transition => transition.actionId));
  policy.actions = policy.actions.filter(action => used.has(action.id) || !referencedBefore.has(action.id));
}

function addPolicyAction(variant: ScenarioVariant, operation: VariantOperation, action: ScenarioVariant['behaviorPolicy']['actions'][number], when: string, diff: VariantFieldDiff[], referencedBefore?: Set<string>): void {
  const policy = variant.behaviorPolicy;
  if (policy.terminalStates.includes(policy.initialState)) throw new Error('Нельзя добавить продолжение: исходное состояние уже завершает разговор');
  const target = policy.terminalStates[0];
  if (!target) throw new Error('В политике нет конечного состояния');
  const before = structuredClone(policy);
  const suffix = digest({ operation, action, when }).slice(0, 10);
  action.id = `${operation}_${suffix}`.slice(0, 80);
  if (policy.actions.some(item => item.id === action.id)) throw new Error('Такой целевой переход уже существует');
  policy.actions.push(action);
  policy.transitions.push({ from: policy.initialState, to: target, actionId: action.id, when });
  policy.maxFollowUps = Math.max(1, policy.maxFollowUps);
  if (referencedBefore) pruneUnreachable(policy, referencedBefore);
  changed(diff, 'behaviorPolicy', before, policy);
}

/** Pure deterministic proposal. Persistence belongs to ExperimentLab so CAS and writer ownership stay intact. */
export function proposeVariant(library: ScenarioLibrary, request: VariantRequest, expectedHash: string): VariantProposalResult {
  const parent = library.variants.find(item => item.id === request.parentId);
  if (!parent) throw new Error(`Вариант ${request.parentId} не найден`);
  const reason = shortText.parse(request.reason);
  const input = inputs[request.operation].parse(request.input) as any;
  const variant = scenarioVariantSchema.parse(structuredClone(parent));
  const diff: VariantFieldDiff[] = [];
  variant.id = `variant_${request.operation}_${digest({ parentId: request.parentId, operation: request.operation, input }).slice(0, 24)}`;
  variant.title = `${parent.title} · ${({ reveal_on_request: 'раскрытие по запросу', missing_fact: 'нет данных', ambiguous_opening: 'неоднозначное начало', changed_intent: 'смена намерения', tool_failure: 'сбой инструмента' } as const)[request.operation]}`;
  variant.provenance = 'synthetic'; variant.parentVariantId = parent.id; variant.mutationReason = reason;
  variant.revision = 1; variant.quality = 'needs_review'; variant.issues = []; variant.ownerDecision = 'pending'; variant.history = [];

  if (request.operation === 'reveal_on_request') {
    const fact = variant.userState.facts.find(item => item.id === input.factId && item.availability === 'initial');
    if (!fact) throw new Error('Для раскрытия нужен существующий исходный факт');
    const value = String(fact.value ?? fact.statement);
    if (input.opening && normalized(input.opening) !== normalized(variant.userState.opening)) {
      changed(diff, 'userState.opening', variant.userState.opening, input.opening);
      variant.userState.opening = input.opening;
    }
    if (normalized(variant.userState.opening).includes(normalized(value))) throw new Error('Факт уже раскрыт в первой реплике');
    const policyBefore = structuredClone(variant.behaviorPolicy);
    const referencedBefore = new Set(policyBefore.transitions.map(transition => transition.actionId));
    const factSecrets = [normalized(value), normalized(fact.statement)];
    const priorRevealActions = new Set(variant.behaviorPolicy.actions.filter(action => action.factIds.includes(fact.id)
      || factSecrets.some(secret => normalized(action.payload ?? '').includes(secret))).map(action => action.id));
    variant.behaviorPolicy.actions = variant.behaviorPolicy.actions.filter(action => !priorRevealActions.has(action.id));
    variant.behaviorPolicy.transitions = variant.behaviorPolicy.transitions.filter(transition => !priorRevealActions.has(transition.actionId));
    if (priorRevealActions.size) changed(diff, 'behaviorPolicy', policyBefore, variant.behaviorPolicy);
    addPolicyAction(variant, request.operation, { id: 'pending', kind: 'answer', factIds: [fact.id], ifAsked: input.ifAsked, payload: input.reply ?? fact.statement }, input.ifAsked, diff, referencedBefore);
  } else if (request.operation === 'missing_fact') {
    const fact = variant.userState.facts.find(item => item.id === input.factId && item.availability === 'initial');
    if (!fact) throw new Error('Для отсутствующего факта выберите существующий исходный факт');
    if (input.opening && normalized(input.opening) !== normalized(variant.userState.opening)) {
      changed(diff, 'userState.opening', variant.userState.opening, input.opening);
      variant.userState.opening = input.opening;
    }
    const separator = fact.statement.indexOf(':');
    const derivedLabel = separator > 0 ? fact.statement.slice(0, separator).trim() : undefined;
    const missingLabel = input.missingDescription ?? derivedLabel;
    if (!missingLabel) throw new Error('Укажите value-free описание отсутствующих данных, например «Адрес отделения».');
    const factsBefore = structuredClone(variant.userState.facts);
    variant.userState.facts = variant.userState.facts.filter(item => item.id !== fact.id);
    changed(diff, 'userState.facts', factsBefore, variant.userState.facts);
    const before = [...variant.userState.missing];
    if (!variant.userState.missing.some(item => normalized(item) === normalized(missingLabel))) variant.userState.missing.push(missingLabel);
    changed(diff, 'userState.missing', before, variant.userState.missing);
    const policyBefore = structuredClone(variant.behaviorPolicy);
    const referencedBefore = new Set(policyBefore.transitions.map(transition => transition.actionId));
    const removedSecrets = [fact.value === undefined ? undefined : normalized(String(fact.value)), normalized(fact.statement)].filter((value): value is string => !!value);
    const persona = variant.userState.persona;
    if (persona && removedSecrets.some(secret => normalized(persona.text).includes(secret))) {
      changed(diff, 'userState.persona', persona, undefined);
      delete variant.userState.persona;
    }
    const removedActions = new Set(variant.behaviorPolicy.actions.filter(action => action.factIds.includes(fact.id)
      || (action.kind === 'answer' || action.kind === 'correct') && removedSecrets.some(secret => normalized(action.payload ?? '').includes(secret))).map(action => action.id));
    variant.behaviorPolicy.actions = variant.behaviorPolicy.actions.filter(action => !removedActions.has(action.id));
    variant.behaviorPolicy.transitions = variant.behaviorPolicy.transitions.filter(transition => !removedActions.has(transition.actionId));
    if (removedActions.size) changed(diff, 'behaviorPolicy', policyBefore, variant.behaviorPolicy);
    addPolicyAction(variant, request.operation, { id: 'pending', kind: 'missing', factIds: [], ifAsked: input.ifAsked,
      payload: input.reply ?? `У меня нет данных: ${missingLabel}.` }, input.ifAsked, diff, referencedBefore);
    const retainedUserText = [variant.userState.goal, variant.userState.opening, variant.userState.persona?.text ?? '', ...variant.userState.missing, ...variant.userState.cannotKnow,
      ...variant.userState.facts.map(item => item.statement), ...variant.behaviorPolicy.actions.flatMap(action => [action.payload ?? '', action.ifAsked ?? '']),
      ...variant.behaviorPolicy.transitions.map(transition => transition.when)];
    if (retainedUserText.some(text => removedSecrets.some(secret => normalized(text).includes(secret)))) throw new Error('Удалённое значение уже раскрыто в другом поле пользователя; укажите value-free описание и первую реплику');
  } else if (request.operation === 'ambiguous_opening') {
    if (normalized(input.opening) === normalized(parent.userState.opening)) throw new Error('Первая реплика не изменилась');
    changed(diff, 'userState.opening', variant.userState.opening, input.opening);
    variant.userState.opening = input.opening;
  } else if (request.operation === 'changed_intent') {
    const policy = variant.behaviorPolicy;
    const matches = policy.transitions.filter(transition => transition.actionId === input.afterActionId);
    if (matches.length !== 1) throw new Error('Для смены намерения выберите один существующий шаг политики');
    if (policy.maxFollowUps >= 15) throw new Error('В политике нет места для дополнительного шага смены намерения');
    const before = structuredClone(policy);
    const selected = matches[0]!;
    const priorTarget = selected.to;
    const priorActionId = selected.actionId;
    const priorAction = policy.actions.find(action => action.id === priorActionId)!;
    const suffix = digest({ operation: request.operation, input }).slice(0, 10);
    const stateId = `changed_intent_${suffix}`.slice(0, 80);
    const actionId = `changed_intent_${digest({ intent: input.intent }).slice(0, 10)}`.slice(0, 80);
    if (policy.states.includes(stateId) || policy.actions.some(action => action.id === actionId)) throw new Error('Такой переход смены намерения уже существует');
    policy.states.push(stateId);
    policy.actions.push({ id: actionId, kind: 'change_intent', factIds: [], payload: input.intent });
    selected.to = stateId;
    if (priorAction.kind === 'finish') {
      selected.actionId = actionId;
      policy.transitions.push({ from: stateId, to: priorTarget, actionId: priorActionId, when: `После обработки нового намерения выполнить шаг ${input.afterActionId}` });
    } else {
      policy.transitions.push({ from: stateId, to: priorTarget, actionId, when: `После шага ${input.afterActionId} сменить намерение` });
    }
    policy.maxFollowUps += 1;
    changed(diff, 'behaviorPolicy', before, policy);
  } else {
    const fixture = variant.environmentFixture;
    if (input.operation !== 'update_record') throw new Error('Управляемый сбой поддержан только для update_record');
    if (fixture.mode !== 'managed' || !fixture.contract?.confirmed || !fixture.contract.reset || !fixture.contract.operations.includes(input.operation)) {
      throw new Error(`Fixture не подтверждает управляемую операцию ${input.operation}`);
    }
    if (!fixture.initialState || typeof fixture.initialState !== 'object' || Array.isArray(fixture.initialState)) throw new Error('Fixture не содержит объект начального состояния');
    const before = structuredClone(fixture);
    fixture.initialState = { ...fixture.initialState, transientFailures: input.failures };
    changed(diff, 'environmentFixture', before, fixture);
  }

  const next = addGeneratedVariant(library, expectedHash, variant, reason);
  const stored = next.variants.find(item => item.id === variant.id)!;
  return { library: next, variant: stored, diff };
}
