import type { Source } from './contracts.js';
import type { CallContext, Runtime, SourceSelectionInput } from './runtime.js';
import { SELECTED_SOURCE_BYTES, SELECTED_SOURCE_CHARS, SOURCES_PER_DIALOGUE, serializedBytes, workInputIssue } from './limits.js';

/** Whole articles only: selection never silently truncates a procedure or exception. */
export function fitScenarioSources(ids: string[], knowledge: Source[], prompts: Source[]): Source[] {
  const chosen: Source[] = [];
  let chars = SELECTED_SOURCE_CHARS;
  let bytes = SELECTED_SOURCE_BYTES - serializedBytes(prompts);
  for (const id of new Set(ids)) {
    const source = knowledge.find(s => s.id === id);
    if (!source || chosen.length >= SOURCES_PER_DIALOGUE || source.content.length > chars || serializedBytes(source) > bytes) continue;
    chosen.push(source); chars -= source.content.length; bytes -= serializedBytes(source);
  }
  return chosen;
}

/** Independent reference reading, using customer evidence rather than the tested agent's suggested solution. */
export async function selectScenarioSources(input: SourceSelectionInput, knowledge: Source[], prompts: Source[],
  runtime: Pick<Runtime, 'selectSources'>, ctx: CallContext): Promise<Source[]> {
  if (!runtime.selectSources) throw new Error('Выбор статей недоступен.');
  const request = { ...input, dialogue: { ...input.dialogue, messages: input.dialogue.messages.filter(m => m.role === 'user') } };
  const issue = workInputIssue(request);
  if (issue) throw new Error(issue);
  const selection = await runtime.selectSources(request, ctx);
  const chosen = fitScenarioSources(selection.sourceIds, knowledge, prompts);
  if (!chosen.length) return [];
  const reading = { sources: [] as Source[], selectedSourceIds: chosen.map(s => s.id), unreadSourceIds: chosen.map(s => s.id) };
  for (const source of chosen) {
    const next = { ...reading, sources: [...reading.sources, source], unreadSourceIds: reading.unreadSourceIds.filter(id => id !== source.id) };
    if (!workInputIssue({ ...request, reading: next })) Object.assign(reading, next);
  }
  if (!reading.sources.length) return chosen;
  // Exactly one revision; the journal preserves both title selection and the supplied article texts.
  const revised = await runtime.selectSources({ ...request, reading }, ctx);
  if (!revised.sourceIds.length) return [];
  // The first answer names the article for the customer's original goal first (SOURCE_SELECTION_ROLE). A revision
  // that read a broad setup article must not displace it: the revision orders what it keeps, and the goal article it
  // left out stays in front — as alternative reference evidence, never as an established condition of the situation.
  const goal = chosen[0]!.id;
  return fitScenarioSources(revised.sourceIds.includes(goal) ? revised.sourceIds : [goal, ...revised.sourceIds], knowledge, prompts);
}
