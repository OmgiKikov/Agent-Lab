import { isCardExecution, type Experiment, type Scenario } from './contracts.js';
import type { Card, LibraryV2 } from './card/schema.js';
import { libraryV1Of } from './card/legacy-v1.js';
import { oneLine } from './text.js';

/*
 * A situation as the owner reads it (ui-spec §3.1): the title and where it came from; the client —
 * what they want, what they write first, what they know and when they say it, when they leave; and
 * what the agent must do, each with the owner's rule. Projected from what a run stores: a card of
 * the library snapshot, a first-format variant (its compiled checkpoints) or a legacy scenario
 * (validate path) with its success criteria. Everything else stays in the record.
 */

export interface Brief {
  title: string;
  /** «из диалога №17», «похожая на №3», «похожая на «…»», «по вашим правилам», «добавлена вами», «из разговора в логах». */
  source: string;
  wants: string;
  writes: string;
  knows: { what: string; when: 'сразу' | 'если спросят' | 'не знает' | '?' }[];
  leaves: string | null;
  /** The customer's late move: «после …: «…»»; null when the situation has none. */
  turn: string | null;
  must: { text: string; rule: string | null }[];
}

const WHEN = { initial: 'сразу', learned_in_source: 'если спросят', uncertain: '?' } as const;
const DISCLOSED = { initial: 'сразу', on_request: 'если спросят', unknown: 'не знает' } as const;

function cardSource(library: LibraryV2, card: Card): string {
  const { origin } = card;
  if (origin.kind === 'similar') {
    const parent = library.cards.find(item => item.id === origin.parentId);
    return parent ? `похожая на №${parent.number}` : 'похожая на другую ситуацию';
  }
  return origin.kind === 'dialogue' ? 'из разговора в логах' : origin.kind === 'owner' ? 'добавлена вами' : 'по вашим правилам';
}

/** A card of the card format, read as it was accepted: its brief is the card itself. */
function cardBrief(library: LibraryV2, card: Card): Brief {
  const quote = new Map(library.requirements.map(item => [item.id, item.quote]));
  const { wants, writes, knows, leaves, turn } = card.client;
  return {
    title: oneLine(card.title), source: cardSource(library, card), wants: oneLine(wants), writes: oneLine(writes),
    // A value the customer does not know is not theirs to state, so only its label is shown.
    knows: knows.map(fact => ({ what: oneLine(fact.value === undefined || fact.disclosure === 'unknown' ? fact.label : `${fact.label}: ${fact.value}`), when: DISCLOSED[fact.disclosure] })),
    leaves: oneLine(leaves), turn: turn ? `после «${oneLine(turn.after)}»: «${oneLine(turn.says)}»` : null,
    must: card.agentMust.map(expectation => {
      const rule = expectation.requirementIds.map(id => quote.get(id)).find(item => item !== undefined);
      return { text: oneLine(expectation.text), rule: rule === undefined ? null : oneLine(rule) || null };
    }),
  };
}

export function situationBrief(record: Experiment, scenario: Scenario): Brief {
  const snapshot = record.librarySnapshot;
  if (snapshot?.formatVersion === 2) {
    const card = snapshot.cards.find(item => item.id === scenario.id);
    if (card) return cardBrief(snapshot, card);
  }
  const library = libraryV1Of(record);
  const variant = library?.variants.find(item => item.id === scenario.id);
  const requirements = new Map(record.requirements.map(item => [item.id, item]));
  if (variant) {
    const origin = variant.sourceDialogues[0];
    const batch = origin && library!.imports.find(item => item.id === origin.batchId);
    const position = batch ? batch.dialogues.findIndex(dialogue => dialogue.id === origin!.dialogueId) : -1;
    const parent = variant.parentVariantId && library!.variants.find(item => item.id === variant.parentVariantId);
    const source = position >= 0 ? `из диалога №${position + 1}` : parent ? `похожая на «${oneLine(parent.title)}»`
      : variant.provenance === 'curated' ? 'добавлена вами' : 'по вашему правилу';
    const finish = variant.behaviorPolicy.transitions.find(item => variant.behaviorPolicy.terminalStates.includes(item.to));
    const execution = scenario.execution && !isCardExecution(scenario.execution) ? scenario.execution : undefined;
    const must = (execution?.evaluatorView.checkpoints ?? variant.evaluationSpec.checkpoints)
      .filter(checkpoint => checkpoint.role === 'required').map(checkpoint => ({ text: oneLine(checkpoint.rule), rule: oneLine(checkpoint.quote) || null }));
    return {
      title: oneLine(scenario.title), source,
      wants: oneLine(variant.userState.goal), writes: oneLine(variant.userState.opening),
      knows: [
        ...variant.userState.facts.map(fact => ({ what: oneLine(fact.value === undefined ? fact.statement : `${fact.statement}: ${fact.value}`), when: WHEN[fact.availability] })),
        ...[...variant.userState.cannotKnow, ...variant.userState.missing].map(item => ({ what: oneLine(item), when: 'не знает' as const })),
      ],
      leaves: finish ? oneLine(finish.when) : null, turn: null,
      must: must.length ? must : [{ text: oneLine(variant.evaluationSpec.successCriteria), rule: null }],
    };
  }
  const rule = scenario.requirementIds.map(id => requirements.get(id)).find(item => !!item);
  return {
    title: oneLine(scenario.title),
    source: scenario.provenance === 'production' ? 'из разговора в логах' : scenario.provenance === 'curated' ? 'добавлена вами' : 'по вашему правилу',
    wants: oneLine(scenario.user.goal), writes: oneLine(scenario.user.opening),
    knows: [
      ...(scenario.user.knows ?? []).map(item => ({ what: oneLine(item), when: 'сразу' as const })),
      ...(scenario.user.answers ?? []).map(item => ({ what: oneLine(item.reply), when: 'если спросят' as const })),
      ...(scenario.user.cannotKnow ?? []).map(item => ({ what: oneLine(item), when: 'не знает' as const })),
    ],
    leaves: null, turn: null,
    must: [{ text: oneLine(scenario.successCriteria ?? '') || 'справиться с запросом клиента', rule: rule ? oneLine(rule.quote) : null }],
  };
}
