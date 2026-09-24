import { isRunning, type Experiment } from './contracts.js';
import { EXTERNAL_AGENT } from './card/prepare.js';
import { targetLabel } from './detect.js';
import { oneLine } from './text.js';

/*
 * The agent's workspace (ui-spec §8): every run of one agent in the project folder, grouped and read from the
 * records alone — the set of situations being worked on, the runs with results, the work going on now. The owner
 * names an agent by its own name or by how it is started; ids and paths inside the project never show.
 *
 *   records ──group by the agent they check──► AgentSpace { draft · runs · active }
 *
 * A draft prepared before its agent was connected belongs to the one agent of the folder, when there is one.
 * Pure: no I/O.
 */

/** How the owner recognises the agent: its own name, else how it is started — a command, a module file, an address. */
export function agentName(record: Pick<Experiment, 'mode' | 'target' | 'revisions'>, cwd?: string): string {
  const named = record.revisions[0]?.spec.name?.trim();
  // The placeholder of an agent the owner did not name says nothing: such an agent is named by how it is started.
  if (named && named !== EXTERNAL_AGENT.name) return oneLine(named);
  if (record.mode === 'demo') return 'учебный агент';
  const target = record.target;
  if (target.kind === 'sandbox') return 'учебная песочница';
  if (target.kind === 'unconnected') return 'агент ещё не подключён';
  return oneLine(targetLabel(target, cwd ?? (target.kind === 'command' && target.cwd || '/')));
}

/** The version the owner or the adapter named; null when none was named (a fingerprint is not a name). */
export const agentVersion = (record: Pick<Experiment, 'targetVersion' | 'targetRelease'>): string | null => {
  const version = record.targetVersion ?? record.targetRelease;
  return version ? oneLine(version) : null;
};

/** The agent and its version in one phrase: «агент поддержки · версия baseline-v1». */
export function agentLine(record: Pick<Experiment, 'mode' | 'target' | 'revisions' | 'targetVersion' | 'targetRelease'>, cwd?: string): string {
  const version = agentVersion(record);
  return `${agentName(record, cwd)}${version ? ` · версия ${version}` : ''}`;
}

/** Which agent a record checks: how it is reached, not which version — a new version of the same agent is the same workspace. */
function agentKey(record: Experiment): string {
  if (record.mode === 'demo') return 'demo';
  const target = record.target;
  switch (target.kind) {
    case 'http': return `http ${target.url}`;
    case 'module': return `module ${target.path}`;
    case 'command': return `command ${[target.command, ...target.args].join(' ')}`;
    case 'sandbox': return 'sandbox';
    case 'unconnected': return 'unconnected';
  }
}

export interface AgentSpace {
  key: string;
  /** Named after its newest connected record. */
  name: string;
  version: string | null;
  demo: boolean;
  /** Every record of this agent, newest first. */
  records: Experiment[];
  /** Records with recorded conversations, newest first: its results. */
  runs: Experiment[];
  /** The newest draft that has not run: the situations being worked on. */
  draft?: Experiment;
  /** A record some session is preparing or running now. */
  active?: Experiment;
}

const newestFirst = (a: Experiment, b: Experiment) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt);

function space(key: string, records: Experiment[]): AgentSpace {
  const sorted = [...records].sort(newestFirst);
  const named = sorted.find(record => record.target.kind !== 'unconnected') ?? sorted[0]!;
  const draft = sorted.find(record => record.phase === 'review' && !record.trials.length);
  const active = sorted.find(record => isRunning(record.phase));
  return { key, name: agentName(named), version: agentVersion(named), demo: key === 'demo', records: sorted,
    runs: sorted.filter(record => record.trials.length > 0), ...(draft ? { draft } : {}), ...(active ? { active } : {}) };
}

/** The agents of a project folder, the one with the newest work first. */
export function agentSpaces(records: readonly Experiment[]): AgentSpace[] {
  const groups = new Map<string, Experiment[]>();
  for (const record of records) {
    const key = agentKey(record);
    groups.set(key, [...groups.get(key) ?? [], record]);
  }
  // Situations prepared before the agent was connected belong to the folder's one agent, when there is exactly one.
  const waiting = groups.get('unconnected');
  const connected = [...groups.keys()].filter(key => key !== 'unconnected' && key !== 'demo');
  if (waiting && connected.length === 1) {
    groups.set(connected[0]!, [...groups.get(connected[0]!)!, ...waiting]);
    groups.delete('unconnected');
  }
  return [...groups].map(([key, items]) => space(key, items)).sort((a, b) => newestFirst(a.records[0]!, b.records[0]!));
}
