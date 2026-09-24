import type { CallContext, Runtime, Source, SourceSelectionInput } from './contracts.js';
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
  // Keep direct title matches as alternative reference evidence, not as established scenario conditions.
  // A broad setup article must not displace the article naming the original connection question.
  const words = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const stop = new Set(['как', 'что', 'где', 'мне', 'я', 'в', 'на', 'по', 'с', 'и', 'ли', 'пожалуйста']);
  const goal = [...new Set(words(request.dialogue.messages[0]?.content ?? '').filter(w => !stop.has(w)))];
  const direct = goal.length >= 2 ? knowledge.filter(s => {
    const title = new Set(words(s.name));
    return goal.every(w => title.has(w));
  }).slice(0, 2).map(s => s.id) : [];
  return fitScenarioSources([...direct, ...revised.sourceIds], knowledge, prompts);
}
