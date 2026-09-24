import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Experiment } from '../src/contracts.js';

/*
 * The model sees only the tools of the step the project is at (quality bar 2): what can be done next, never all
 * nine at once. The step is read from the records, never from the conversation:
 *
 *   nothing yet            ──► status, prepare
 *   situations exist       ──► + cards, edit, decide, run
 *   a run has conversations ──► + results, explain, agree
 *
 * Pi's own tools (read, bash, …) and other extensions' tools are left exactly as they are.
 */

export const TOOL = {
  status: 'agent_lab_status', prepare: 'agent_lab_prepare', cards: 'agent_lab_cards', edit: 'agent_lab_edit', decide: 'agent_lab_decide',
  run: 'agent_lab_run', results: 'agent_lab_results', explain: 'agent_lab_explain', agree: 'agent_lab_agree',
} as const;
export type ToolName = typeof TOOL[keyof typeof TOOL];
const LAB_TOOLS: ReadonlySet<string> = new Set(Object.values(TOOL));

/** The Lab tools of the step `records` are at, in the order the work goes. */
export function stepTools(records: readonly Pick<Experiment, 'trials'>[]): ToolName[] {
  if (!records.length) return [TOOL.status, TOOL.prepare];
  const situations: ToolName[] = [TOOL.status, TOOL.prepare, TOOL.cards, TOOL.edit, TOOL.decide, TOOL.run];
  return records.some(record => record.trials.length) ? [...situations, TOOL.results, TOOL.explain, TOOL.agree] : situations;
}

/**
 * Makes the Lab tools of the current step the active ones. A change applies from the model's next call, so a tool
 * that moves the project to the next step hands the model that step's tools in the same turn.
 */
export function activateStep(pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>, records: readonly Pick<Experiment, 'trials'>[]): void {
  const active = pi.getActiveTools();
  const next = [...active.filter(name => !LAB_TOOLS.has(name)), ...stepTools(records)];
  if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
}
