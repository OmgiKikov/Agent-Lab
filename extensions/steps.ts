import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Experiment } from '../src/contracts.js';
import { isRunning } from '../src/phases.js';

/*
 * The model sees only the tools of the step the project is at (quality bar 2): what can be done next, never all
 * ten at once. The step is read from what the records hold, never from the conversation — a preparation that made
 * no situation leaves the project where it was:
 *
 *   nothing yet                        ──► status, analyze, prepare, connect
 *   long work going on                 ──► + run (how far it got, and «стоп»)
 *   a preparation left to continue     ──► + decide («Продолжить подготовку»)
 *   situations exist                   ──► + cards, edit, decide, run
 *   a run has conversations            ──► + results, explain, agree
 *
 * Connecting the agent from a pasted curl is open at every step: the owner may bring it before the logs or after. So is
 * the analysis of the logs (DISCOVER): it needs no situation and no agent, and leads nowhere it has to.
 *
 * Pi's own tools (read, bash, …) and other extensions' tools are left exactly as they are.
 */

export const TOOL = {
  status: 'agent_lab_status', analyze: 'agent_lab_analyze', prepare: 'agent_lab_prepare', cards: 'agent_lab_cards', edit: 'agent_lab_edit', decide: 'agent_lab_decide',
  run: 'agent_lab_run', results: 'agent_lab_results', explain: 'agent_lab_explain', agree: 'agent_lab_agree', connect: 'agent_lab_connect',
} as const;
export type ToolName = typeof TOOL[keyof typeof TOOL];
const LAB_TOOLS: ReadonlySet<string> = new Set(Object.values(TOOL));

type StepRecord = Pick<Experiment, 'trials' | 'phase' | 'scenarios' | 'librarySnapshot' | 'preparationProgress'>;

/** Whether `record` holds situations: cards of a set, variants of the first format, or the scenarios of a run. */
export function hasSituations(record: Pick<Experiment, 'scenarios' | 'librarySnapshot'>): boolean {
  const library = record.librarySnapshot;
  return record.scenarios.length > 0 || (library?.formatVersion === 2 ? library.cards.length > 0 : (library?.variants.length ?? 0) > 0);
}

/** The Lab tools of the step `records` are at, in the order the work goes. */
export function stepTools(records: readonly StepRecord[]): ToolName[] {
  const tools: ToolName[] = [TOOL.status, TOOL.analyze, TOOL.prepare, TOOL.connect];
  const situations = records.some(hasSituations);
  const continuable = records.some(record => record.phase === 'review' && !!record.preparationProgress?.pending.length);
  if (situations) tools.push(TOOL.cards, TOOL.edit);
  if (situations || continuable) tools.push(TOOL.decide);
  if (situations || records.some(record => isRunning(record.phase))) tools.push(TOOL.run);
  if (records.some(record => record.trials.length)) tools.push(TOOL.results, TOOL.explain, TOOL.agree);
  return tools;
}

/**
 * Makes the Lab tools of the current step the active ones. A change applies from the model's next call, so a tool
 * that moves the project to the next step hands the model that step's tools in the same turn.
 */
export function activateStep(pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>, records: readonly StepRecord[]): void {
  const active = pi.getActiveTools();
  const next = [...active.filter(name => !LAB_TOOLS.has(name)), ...stepTools(records)];
  if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
}
