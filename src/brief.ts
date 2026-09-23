import type { Experiment, Scenario } from './contracts.js';
import { oneLine } from './text.js';

/*
 * A situation as the owner reads it (ui-spec §3.1): the title and where it came from; the client —
 * what they want, what they write first, what they know and when they say it, when they leave; and
 * what the agent must do, each with the owner's rule. Projected from what a run stores today: a
 * library card (its variant in the library snapshot and its compiled checkpoints) or a legacy
 * scenario (validate path) with its success criteria. Everything else stays in the record.
 */

export interface Brief {
  title: string;
  /** «из диалога №17», «похожая на «…»», «по вашему правилу», «добавлена вами», «из разговора в логах». */
  source: string;
  wants: string;
  writes: string;
  knows: { what: string; when: 'сразу' | 'если спросят' | 'не знает' | '?' }[];
  leaves: string | null;
  must: { text: string; rule: string | null }[];
}

const WHEN = { initial: 'сразу', learned_in_source: 'если спросят', uncertain: '?' } as const;

export function situationBrief(record: Experiment, scenario: Scenario): Brief {
  const library = record.librarySnapshot;
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
    const must = (scenario.execution?.evaluatorView.checkpoints ?? variant.evaluationSpec.checkpoints)
      .filter(checkpoint => checkpoint.role === 'required').map(checkpoint => ({ text: oneLine(checkpoint.rule), rule: oneLine(checkpoint.quote) || null }));
    return {
      title: oneLine(scenario.title), source,
      wants: oneLine(variant.userState.goal), writes: oneLine(variant.userState.opening),
      knows: [
        ...variant.userState.facts.map(fact => ({ what: oneLine(fact.value === undefined ? fact.statement : `${fact.statement}: ${fact.value}`), when: WHEN[fact.availability] })),
        ...[...variant.userState.cannotKnow, ...variant.userState.missing].map(item => ({ what: oneLine(item), when: 'не знает' as const })),
      ],
      leaves: finish ? oneLine(finish.when) : null,
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
    leaves: null,
    must: [{ text: oneLine(scenario.successCriteria ?? '') || 'справиться с запросом клиента', rule: rule ? oneLine(rule.quote) : null }],
  };
}
