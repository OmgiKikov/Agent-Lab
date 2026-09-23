import { Type } from 'typebox';
import { z } from 'zod';
import { identifierPattern, sha256Pattern } from '../src/ids.js';
import { behaviorPolicySchema, variantProposalSchema, type BehaviorPolicy, type ScenarioVariant } from '../src/scenario-contracts.js';

// Internal superset for the dispatcher. The model receives only the matching operation branch.
export const scenarioParameters = Type.Object({
    operation: Type.Union(['show', 'inspect', 'edit', 'behavior', 'edit_group', 'variant', 'resolve', 'merge', 'split', 'remove', 'assess', 'resume', 'accept', 'budget'].map(value => Type.Literal(value))),
    issue: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: 'resolve: the open question number in the first selected card. With variants, only the identical question shared by every selected card is settled; omit when there is exactly one shared question.' })),
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the run this conversation works on.' })),
    variant: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'One card: its title, its number in the shown list, or its id. For variant it is the parent card.' })),
    variants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 200, description: 'Several cards, for accept, split or resolve. Grouped resolve accepts up to eight explicitly selected cards with the same rule, applicability and checker question; one native confirmation previews the exact scope.' })),
    groups: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 2, maxItems: 20, description: 'merge: business groups by title, number or id; the first one keeps its name.' })),
    group: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'edit_group: existing business group by title, number or id. Set title, goal and/or conditions directly; every card in this group is rechecked. Other groups stay unchanged.' })),
    source: Type.Optional(Type.Boolean({ description: 'show: include the source dialogue and the quotes the card was built from.' })),
    change: Type.Optional(Type.Object({
      field: Type.Union(['opening', 'goal', 'expectation', 'rule', 'fact'].map(value => Type.Literal(value))),
      value: Type.Optional(Type.String({ maxLength: 3000, description: 'The new text; for a fact, its exact value.' })),
      rule: Type.Optional(Type.String({ maxLength: 300, description: 'field=rule: which rule, by its words or id; "disputed" means every rule the checker calls inapplicable to this card. Omit when the card has one rule.' })),
      remove: Type.Optional(Type.Boolean({ description: 'field=rule: take the rule out of this card. At least one rule must stay.' })),
      applicability: Type.Optional(Type.String({ maxLength: 1000, description: 'field=rule: when the rewritten rule applies, in the owner\'s words.' })),
      fact: Type.Optional(Type.String({ maxLength: 300, description: 'field=fact: which fact, by its words, value or id. Omit to add a new fact.' })),
      statement: Type.Optional(Type.String({ maxLength: 300, description: 'field=fact: the fact as a sentence, e.g. «Номер договора: 778899».' })),
      availability: Type.Optional(Type.Union(['initial', 'learned_in_source', 'uncertain'].map(value => Type.Literal(value)), { description: 'initial: the client knew it before the conversation, even when they reveal it only on request.' })),
    }, { additionalProperties: false })),
    behaviorPolicy: Type.Optional(Type.Unsafe<BehaviorPolicy>({ ...z.toJSONSchema(behaviorPolicySchema), description: 'Complete reactive client policy: states, actions and transitions. Uses existing fact IDs; cannot create knowledge or owner facts.' })),
    sourceCoverage: Type.Optional(Type.Unsafe<NonNullable<ScenarioVariant['sourceCoverage']>>({ ...z.toJSONSchema(variantProposalSchema.shape.sourceCoverage.unwrap()), description: 'Complete accounting of later source customer events. conditional_action uses actionIds and empty factIds; initial_fact uses factIds and empty actionIds; omitted uses empty arrays and an evidence-based reason. Original evidence is immutable.' })),
    kind: Type.Optional(Type.Union(['reveal_on_request', 'missing_fact', 'ambiguous_opening', 'changed_intent', 'tool_failure'].map(value => Type.Literal(value)), { description: 'variant: what differs from the parent card.' })),
    fact: Type.Optional(Type.String({ maxLength: 300, description: 'variant: which known fact is withheld or missing, in words. Omit when the card has one known fact.' })),
    opening: Type.Optional(Type.String({ maxLength: 3000, description: 'variant: a first client message, only when the derived one is not what the owner asked for.' })),
    ifAsked: Type.Optional(Type.String({ maxLength: 300, description: 'variant: how the agent\'s request for the fact is recognised. Omit: the tool derives it from the fact.' })),
    reply: Type.Optional(Type.String({ maxLength: 1000, description: 'variant: what the client answers, only when the owner dictated it.' })),
    missingDescription: Type.Optional(Type.String({ maxLength: 300, description: 'missing_fact: a short name of the missing data without its value, e.g. «Номер терминала» — not a sentence. Omit: the tool takes it from the fact.' })),
    intent: Type.Optional(Type.String({ maxLength: 1000, description: 'changed_intent: what the client wants instead, in the owner\'s words.' })),
    afterAction: Type.Optional(Type.String({ maxLength: 80 })), failures: Type.Optional(Type.Integer({ minimum: 1, maximum: 15 })),
    title: Type.Optional(Type.String({ maxLength: 200, description: 'split/edit_group: the new group name.' })),
    goal: Type.Optional(Type.String({ minLength: 1, maxLength: 3000, description: 'split/edit_group: the group goal, in the owner\'s words. Omit to keep the existing goal; this does not edit individual client goals.' })),
    conditions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20, description: 'split/edit_group: the complete group conditions, in the owner\'s words. Omit to keep existing conditions; [] removes them. Use edit_group to fix group context without moving cards.' })),
    select: Type.Optional(Type.Literal('ready', { description: 'accept: every card that is ready.' })),
    maxCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, description: 'budget: the new total call limit; used calls are never reset.' })),
    ownerQuote: Type.Optional(Type.String({ maxLength: 1000, description: 'The owner\'s exact words that asked for this change, when they are not in their latest message. Checked against the real session.' })),
    verify: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('later')], { description: 'later: skip the semantic recheck until the last edit of a series.' })),
    expectedLibraryHash: Type.Optional(Type.String({ pattern: sha256Pattern })),
    variantIds: Type.Optional(Type.Array(Type.String({ pattern: identifierPattern }), { minItems: 1, maxItems: 200 })),
    variantId: Type.Optional(Type.String({ pattern: identifierPattern })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false });

const common = { id: scenarioParameters.properties.id };
const write = { ...common, ownerQuote: scenarioParameters.properties.ownerQuote, verify: scenarioParameters.properties.verify, expectedLibraryHash: scenarioParameters.properties.expectedLibraryHash };
const required = <K extends keyof typeof scenarioParameters.properties>(key: K) => Type.Required(Type.Object({ value: scenarioParameters.properties[key] })).properties.value;
const view = Type.Object({ ...common, operation: Type.Optional(Type.Union([Type.Literal('show'), Type.Literal('inspect')])),
  variant: scenarioParameters.properties.variant, source: scenarioParameters.properties.source, limit: scenarioParameters.properties.limit, cursor: scenarioParameters.properties.cursor }, { additionalProperties: false });
const surface = (name: string, operation: string, description: string, properties: Record<string, import('typebox').TSchema>) => ({ name, operation, description, parameters: Type.Object(properties, { additionalProperties: false }) });
export const scenarioToolSurfaces = [
  { name: 'agent_lab_scenarios', operation: 'show', description: 'Read the current scenario library, one card or its source. References use displayed number, title or ID. Read before editing; returns the current revision.', parameters: view },
  surface('agent_lab_edit_card', 'edit', 'Edit one draft card; returns its exact diff and semantic recheck. Ordinary wording is an assistant proposal. A client fact or prior knowledge needs native owner confirmation.', { ...write, variant: required('variant'), change: required('change') }),
  surface('agent_lab_edit_behavior', 'behavior', 'Repair a draft card’s reactive client behavior or source-event accounting. Read the card with source:true first. Supply complete behaviorPolicy and/or sourceCoverage; does not change client facts, original evidence or evaluation rules. Requires semantic recheck.', { ...write, variant: required('variant'), behaviorPolicy: scenarioParameters.properties.behaviorPolicy, sourceCoverage: scenarioParameters.properties.sourceCoverage }),
  surface('agent_lab_edit_group', 'edit_group', 'Edit an existing business group title, goal or conditions. Affects every card in this group. Does not create or move cards.', { ...write, group: required('group'), title: scenarioParameters.properties.title, goal: scenarioParameters.properties.goal, conditions: scenarioParameters.properties.conditions }),
  surface('agent_lab_add_variant', 'variant', 'Add a synthetic variant from one parent. Derives known facts and default wording from the parent, preserves it and checks the new card.', { ...write, variant: required('variant'), kind: required('kind'), ...Type.Pick(scenarioParameters, ['fact', 'opening', 'ifAsked', 'reply', 'missingDescription', 'intent', 'afterAction', 'failures']).properties }),
  surface('agent_lab_resolve', 'resolve', 'Ask the owner to settle a non-blocking checker question for one card or an explicit set sharing the same question. Always previews exact scope for native confirmation; cannot waive a blocking finding.', { ...write, variant: scenarioParameters.properties.variant, variants: scenarioParameters.properties.variants, issue: scenarioParameters.properties.issue }),
  surface('agent_lab_merge_groups', 'merge', 'Merge explicitly selected business groups in a draft. First group keeps its name; requires semantic recheck.', { ...write, groups: required('groups') }),
  surface('agent_lab_split_group', 'split', 'Move selected cards into a new business group, preserving other cards. Set new title, goal and conditions or inherit them.', { ...write, variants: required('variants'), title: scenarioParameters.properties.title, goal: scenarioParameters.properties.goal, conditions: scenarioParameters.properties.conditions }),
  surface('agent_lab_remove_card', 'remove', 'Remove one explicitly requested card from the editable draft. Original imports and completed runs are preserved. Never call for a read-only request or a protected card.', { ...write, variant: required('variant') }),
  surface('agent_lab_assess_cards', 'assess', 'Resume unfinished semantic checks within the cumulative budget. Does not extract pending source dialogues. A long check reports its result in the chat.', { ...common, expectedLibraryHash: scenarioParameters.properties.expectedLibraryHash }),
  surface('agent_lab_resume_preparation', 'resume', 'Continue pending source preparation from a saved checkpoint within the remaining budget. Preserves edited cards; refuses ambiguous interrupted paid calls and accepted sets.', { ...common, expectedLibraryHash: scenarioParameters.properties.expectedLibraryHash }),
  surface('agent_lab_accept_set', 'accept', 'Preview and accept an immutable selected set of ready cards after native confirmation. This does not run the target agent.', { ...common, expectedLibraryHash: scenarioParameters.properties.expectedLibraryHash, variants: scenarioParameters.properties.variants, select: scenarioParameters.properties.select }),
  surface('agent_lab_set_budget', 'budget', 'Change the cumulative call ceiling after native confirmation of the exact old/new budget. Used calls are never reset.', { ...common, expectedLibraryHash: scenarioParameters.properties.expectedLibraryHash, maxCalls: required('maxCalls') }),
];
