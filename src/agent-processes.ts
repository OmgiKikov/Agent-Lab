import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeFileAtomicSync } from './fs-atomic.js';

/*
 * The agent processes Lab starts, so none outlives it. A command or module session runs its agent in a process group of
 * its own (targets.ts), and ending the session ends the whole group — SIGTERM, then SIGKILL to what is left after a
 * short grace — so a helper the agent started with its output redirected goes with it. The groups alive now are kept:
 *
 *   in memory   ended when Lab gets SIGINT or SIGTERM (then Lab ends as the signal would have ended it) and when it exits
 *   on disk     one 0600 note per Lab process in `agents/` of the data folder it writes, rewritten as groups start and
 *               end: a Lab killed outright (kill -9) leaves its note, and the next Lab to open the folder ends the groups
 *               of a Lab that is gone — only a group whose leader is still the process Lab started: the same command,
 *               started the same second. A pid the system has given to another process since is never signalled.
 *
 * A group whose leader is gone while helpers of it live on cannot be told from a stranger's and is left alone.
 * Windows has no process groups: nothing is kept there.
 */

/** How long a group has between SIGTERM and SIGKILL. */
const END_GRACE_MS = 1000;
/** How far a process's start time, as `ps` says it (to the second), may be from the moment Lab noted it. */
const SAME_START_MS = 2000;
const REGISTRY = 'agents';
const grouped = process.platform !== 'win32';

interface Group { pgid: number; argv: string[]; startedAt: number }
const live = new Map<number, Group>();
/** The data folders this Lab writes: each keeps its note of this Lab's groups. */
const folders = new Set<string>();
const labStart = Math.round(performance.timeOrigin);
const note = `${process.pid}-${labStart}.json`;
const noteSchema = z.object({
  lab: z.object({ pid: z.number().int().positive(), startedAt: z.number() }),
  groups: z.array(z.object({ pgid: z.number().int().positive(), argv: z.array(z.string()).min(1), startedAt: z.number() })),
});

/** Sends `signal` to every process of the group; false when the group is gone or not Lab's to signal. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pgid, signal); return true; }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === 'ESRCH' || code === 'EPERM') return false; throw error; }
}

/** Writes this Lab's note in every folder it writes; a folder that cannot keep it loses only the kill -9 safety net. */
function record(): void {
  for (const folder of folders) {
    const file = join(folder, REGISTRY, note);
    try {
      if (!live.size) { unlinkSync(file); continue; }
      mkdirSync(join(folder, REGISTRY), { recursive: true, mode: 0o700 });
      writeFileAtomicSync(file, JSON.stringify({ lab: { pid: process.pid, startedAt: labStart }, groups: [...live.values()] }));
    } catch { /* ENOENT on removal, or a folder that is gone */ }
  }
}

const handlers = new Map<NodeJS.Signals, () => void>();
/** Lab's own stop ends its agents first: SIGTERM at once, SIGKILL after the grace, then Lab ends as the signal ends it — unless someone else listens. */
function watchLab(): void {
  if (handlers.size) return;
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      const ending = closeAllTargets();
      if (process.listenerCount(name) > 1) return;
      void ending.finally(() => { process.off(name, handler); process.kill(process.pid, name); });
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }
  // An exit cannot wait: whatever is left gets both signals at once.
  process.on('exit', () => { for (const pgid of live.keys()) { signalGroup(pgid, 'SIGTERM'); signalGroup(pgid, 'SIGKILL'); } });
}

/** Keeps the group an agent was started in (`pgid`, its leader's pid) until it is ended. */
export function trackGroup(pgid: number, argv: readonly string[]): void {
  if (!grouped) return;
  live.set(pgid, { pgid, argv: [...argv], startedAt: Date.now() });
  watchLab();
  record();
}

/** Stops keeping a group: it has ended, or it is meant to live on (a release hook's server). */
export function untrackGroup(pgid: number): void {
  if (live.delete(pgid)) record();
}

/** Ends a group: SIGTERM to all of it, SIGKILL to what is left after `graceMs`. */
export async function endGroup(pgid: number, graceMs = END_GRACE_MS): Promise<void> {
  if (grouped && signalGroup(pgid, 'SIGTERM')) {
    const until = Date.now() + graceMs;
    while (Date.now() < until && signalGroup(pgid, 0)) await new Promise(resolve => setTimeout(resolve, 25));
    signalGroup(pgid, 'SIGKILL');
  }
  untrackGroup(pgid);
}

/** The groups Lab ended because Lab itself was stopping: their conversations were stopped, not broken by the agent. */
const stopped = new Set<number>();
/** Whether Lab ended this group while stopping (closeAllTargets). */
export const endedByStop = (pgid: number): boolean => stopped.has(pgid);

/** Ends every agent group this Lab started; what a stop of Lab — Ctrl-C in a command — calls before Lab goes. */
export async function closeAllTargets(graceMs = END_GRACE_MS): Promise<void> {
  for (const pgid of live.keys()) stopped.add(pgid);
  await Promise.all([...live.keys()].map(pgid => endGroup(pgid, graceMs)));
}

const exec = promisify(execFile);

/** What `ps` says of a live process: its group, its start (to the second) and its command line; null when there is none. */
async function processOf(pid: number): Promise<{ pgid: number; startedAt: number; command: string } | null> {
  let shown: string;
  try { shown = (await exec('ps', ['-ww', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim(); }
  catch { return null; }
  // The group, then lstart — fixed-width, «Thu Sep  5 17:31:02 2026» — then the command line.
  const row = /^(\d+)\s+(.{24})\s+(.*)$/s.exec(shown);
  const startedAt = row ? Date.parse(row[2]!) : NaN;
  return row && Number.isFinite(startedAt) ? { pgid: Number(row[1]), startedAt, command: row[3]!.trim() } : null;
}

/** The command `ps` shows is the one Lab started: its arguments end it (an interpreter may have been replaced by the one it runs), or its program is the same. */
function sameCommand(argv: readonly string[], shown: string): boolean {
  const args = argv.slice(1).join(' ');
  return args ? shown === argv.join(' ') || shown.endsWith(` ${args}`) : basename(shown.split(' ')[0] ?? '') === basename(argv[0] ?? '');
}

/** Whether the group Lab noted is still the one it started: its leader alive, still leading it, the same command, started the same second. */
async function stillOurs(group: Group): Promise<boolean> {
  const shown = await processOf(group.pgid);
  return !!shown && shown.pgid === group.pgid && Math.abs(shown.startedAt - group.startedAt) <= SAME_START_MS && sameCommand(group.argv, shown.command);
}

/**
 * Keeps this Lab's agent groups in `folder` (a data folder it opened as its writer) and ends the groups a Lab that is
 * gone left there — each only when it is still the group that Lab started.
 */
export async function adoptAgentRegistry(folder: string): Promise<void> {
  if (!grouped) return;
  const directory = join(folder, REGISTRY);
  let names: string[] = [];
  try { names = readdirSync(directory).filter(name => name.endsWith('.json') && name !== note); } catch { /* no note yet */ }
  for (const name of names) {
    let left: z.infer<typeof noteSchema>;
    try { left = noteSchema.parse(JSON.parse(readFileSync(join(directory, name), 'utf8'))); }
    catch { try { unlinkSync(join(directory, name)); } catch { /* gone already */ } continue; }
    // A Lab still running keeps its own agents.
    const owner = await processOf(left.lab.pid);
    if (owner && Math.abs(owner.startedAt - left.lab.startedAt) <= SAME_START_MS) continue;
    for (const group of left.groups) if (await stillOurs(group)) await endGroup(group.pgid);
    try { unlinkSync(join(directory, name)); } catch { /* gone already */ }
  }
  folders.add(folder);
  record();
}
