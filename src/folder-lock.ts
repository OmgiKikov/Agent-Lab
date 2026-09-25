import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, readFile, readlink, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { createFileExclusive } from './fs-atomic.js';

/*
 * The writer's lock of a data folder (`.lock`) and the gate of its recovery (`.recovery`) name the process that holds
 * them: its PID and token, the machine it runs on — the host name and, where the system tells them, the boot and the PID
 * namespace —, when the process started and the program it runs. A lock is taken from its holder only when the holder's
 * death is proved:
 *
 *   an empty file ────────────────── older than EMPTY_GRACE_MS: its writer died between creating and writing it
 *   written on this machine (same host, boot and PID namespace; or by a Lab before machines were recorded)
 *     with our own PID ───────────── no store of this process holds it (a restarted container gives PID 1 again)
 *     with another PID ───────────── that process is gone, or the PID now belongs to another process:
 *       · the kernel's start tick of the PID is not the holder's (Linux, /proc: exact)
 *       · the PID's start by the clock at its start (`ps` lstart) is not the holder's (systems without /proc — macOS: to the second)
 *       · a lock that names no start (written before Lab recorded one on this system): the PID's process started after
 *         the lock's last heartbeat, which its holder, alive with this PID, wrote
 *       · the heartbeat is older than STALE_MS and the PID now runs another program than the holder's
 *   written elsewhere (another machine, container or PID namespace, where its PID means nothing here)
 *                      ───────────── its heartbeat is older than STALE_MS
 *
 * The holder renews the heartbeat — the lock file's modification time — every HEARTBEAT_MS, and stops writing once the
 * lock is no longer its own. A file no Lab wrote is never taken: it waits for a person.
 *
 * What this guarantees:
 *   · On one machine there are never two writers. The lock is created exclusively (a link that fails when the name is
 *     taken); a live holder is never proved dead — its PID is alive, started when the lock says (or before its last
 *     heartbeat), and runs its program —; and a lock found dead is taken only under the recovery gate, after it is
 *     checked again there. A frozen process (a laptop asleep, SIGSTOP) is alive: it keeps its lock.
 *   · Across machines sharing a folder (a network folder), a holder is proved dead only by a heartbeat older than
 *     STALE_MS, which assumes the machines' clocks agree within about 50 s and that a live writer's event loop beats at
 *     least once a minute. A writer frozen for longer — a laptop asleep — can lose the folder to another machine. When it
 *     wakes, its first write finds the heartbeat overdue, checks the lock before writing, finds it is no longer its own
 *     and stops writing (store.ts). The one window left is a takeover finishing within the same moments in which the
 *     frozen writer wakes and renews its heartbeat: a file lock without fencing cannot close it.
 */

/** How often the writer renews its lock's heartbeat. */
export const HEARTBEAT_MS = 10_000;
/** A lock written elsewhere is dead once its heartbeat is this old: well past a missed beat or two, and clock skew between machines. */
export const STALE_MS = 60_000;
/** An empty lock or gate: a Lab creates it and writes its holder at once, so an empty one this old was left by a dead process. */
export const EMPTY_GRACE_MS = 5_000;
/**
 * How far two readings of one process's start may differ: `ps` tells it to the second, and a process's own clock at its
 * start (performance.timeOrigin) comes after the kernel's by as long as its runtime took to start, which a loaded machine
 * can stretch. Another process given the same PID within this span of the holder's start is not a case that happens.
 */
const START_SLACK_MS = 5_000;

/** The process a lock or a gate names. A lock of an earlier Lab names only its PID and token, or no start and program. */
export interface Holder {
  pid: number; token: string; host?: string; boot?: string; pidNamespace?: string;
  /** When the process started, in clock ticks since boot (field 22 of /proc/<pid>/stat). */
  started?: number;
  /** When the process started by the clock, in ms since the epoch, as the process itself read it at its start. */
  startedAt?: number;
  /** The program the process runs (its executable's name). */
  program?: string;
}
/** A lock or gate as found: its holder — undefined while the file is empty, null when no Lab wrote it — its heartbeat and its file. */
export interface Found { holder: Holder | null | undefined; beatMs: number; file: number }

/** What the system tells of a process: each answer undefined where it does not tell. Injected where the rules are checked. */
export interface Processes {
  /** This machine and this process, as a lock names them. */
  self(): Promise<Omit<Holder, 'token'>>;
  alive(pid: number): boolean;
  /** The kernel's start tick of the process: /proc/<pid>/stat. */
  startTick(pid: number): Promise<number | undefined>;
  /** When the process started by the clock at its start, in ms since the epoch, and the program it runs: `ps`. */
  seen(pid: number): Promise<{ startedAt?: number; program?: string }>;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/** When a process started, in clock ticks since boot (field 22 of /proc/<pid>/stat); undefined where the system does not tell. */
async function startTick(pid: number): Promise<number | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  // The command name (field 2) is in parentheses and may hold spaces and parentheses: the fields after it follow the last ')'.
  const field = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const started = field ? Number(field) : NaN;
  return Number.isSafeInteger(started) ? started : undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * A line of `ps -o lstart= -o comm=` in the C locale and UTC: «Thu Sep 25 17:43:12 2026 /bin/zsh». lstart is the clock
 * the kernel read when the process started, so a later change of the clock does not move it; comm may hold spaces.
 */
export function psLine(line: string): { startedAt?: number; program?: string } {
  const fields = line.trim().split(/\s+/);
  const [, month, day, time, year] = fields;
  const clock = time?.split(':').map(Number);
  const monthIndex = MONTHS.indexOf(month ?? '');
  const startedAt = monthIndex >= 0 && clock?.length === 3 && clock.every(Number.isInteger) && /^\d{1,2}$/.test(day ?? '') && /^\d{4}$/.test(year ?? '')
    ? Date.UTC(Number(year), monthIndex, Number(day), clock[0]!, clock[1]!, clock[2]!) : undefined;
  const command = fields.slice(5).join(' ');
  const program = command ? basename(command).replace(/^-/, '') : undefined;
  return { ...(startedAt !== undefined ? { startedAt } : {}), ...(program ? { program } : {}) };
}

/** Asks `ps` about one process; nothing when there is no `ps`, it takes no `lstart` (BusyBox) or the process is gone. */
function psSeen(pid: number): Promise<{ startedAt?: number; program?: string }> {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], { timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (error, stdout) => resolve(error ? {} : psLine(String(stdout))));
  });
}

/** This process as a lock names it: read once. */
let self: Promise<Omit<Holder, 'token'>> | undefined;
const thisProcess = () => self ??= (async () => {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
  const pidNamespace = await readlink('/proc/self/ns/pid').catch(() => '');
  const started = await startTick(process.pid);
  return { pid: process.pid, host: hostname(), ...(boot ? { boot } : {}), ...(pidNamespace ? { pidNamespace } : {}), ...(started === undefined ? {} : { started }),
    startedAt: Math.round(performance.timeOrigin), program: basename(process.execPath) };
})();

/** The system's own answers. */
export const SYSTEM: Processes = { self: thisProcess, alive, startTick, seen: psSeen };

/** Tokens of the locks and gates this process holds, shared by every copy of this module loaded in it (Pi loads the extension through jiti). */
export const held = ((globalThis as Record<symbol, unknown>)[Symbol.for('agent-lab.store.held')] ??= new Set<string>()) as Set<string>;

export function holderIn(text: string): Holder | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const { pid, token, host, boot, pidNamespace, started, startedAt, program } = raw as Record<string, unknown>;
  const named = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string' && value.length > 0;
  const count = (value: unknown): value is number | undefined => value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof token !== 'string' || !token || !named(host) || !named(boot) || !named(pidNamespace)
    || !count(started) || !count(startedAt) || !named(program)) return null;
  return { pid, token, ...(host ? { host } : {}), ...(boot ? { boot } : {}), ...(pidNamespace ? { pidNamespace } : {}), ...(started === undefined ? {} : { started }),
    ...(startedAt === undefined ? {} : { startedAt }), ...(program ? { program } : {}) };
}

/** A lock or gate as it is now; null when there is none. */
export async function find(path: string): Promise<Found | null> {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const info = await file.stat();
    const text = await file.readFile('utf8');
    return { holder: text ? holderIn(text) : undefined, beatMs: info.mtimeMs, file: info.ino };
  } finally { await file.close(); }
}

/** The token a lock names now, read at once; null when there is none or it cannot be read. For a writer's check before a write. */
export function tokenNow(path: string): string | null {
  try { return holderIn(readFileSync(path, 'utf8'))?.token ?? null; } catch { return null; }
}

export const sameFound = (a: Found, b: Found): boolean => a.holder && b.holder ? a.holder.pid === b.holder.pid && a.holder.token === b.holder.token
  : a.holder === b.holder && a.file === b.file;

/** Program names as the system tells them: Linux's comm keeps 15 characters. */
const sameProgram = (a: string, b: string): boolean => a.slice(0, 15) === b.slice(0, 15);

/** Whether the holder of a lock or gate is proved dead (the diagram above). `processes`: what the system tells, injected in checks. */
export async function provedDead(found: Found, processes: Processes = SYSTEM, now = Date.now()): Promise<boolean> {
  const { holder } = found;
  if (holder === null) return false;
  const age = now - found.beatMs;
  if (holder === undefined) return age > EMPTY_GRACE_MS;
  const here = await processes.self();
  const local = holder.host === undefined || holder.host === here.host && holder.boot === here.boot && holder.pidNamespace === here.pidNamespace;
  if (!local) return age > STALE_MS;
  if (holder.pid === here.pid) return !held.has(holder.token);
  if (!processes.alive(holder.pid)) return true;
  if (holder.started !== undefined) {
    const tick = await processes.startTick(holder.pid);
    if (tick !== undefined) return tick !== holder.started;
  }
  const seen = await processes.seen(holder.pid);
  // The start by the clock decides only for a lock written where /proc tells no tick (macOS): on Linux `ps` derives it
  // from the boot time, which moves whenever the clock is set.
  if (holder.started === undefined && seen.startedAt !== undefined) {
    if (holder.startedAt !== undefined) return Math.abs(seen.startedAt - holder.startedAt) > START_SLACK_MS;
    if (seen.startedAt > found.beatMs + START_SLACK_MS) return true;
  }
  const program = holder.program ?? here.program;
  return age > STALE_MS && seen.program !== undefined && program !== undefined && !sameProgram(seen.program, program);
}

/**
 * Removes a gate whose holder is proved dead, if it is still the gate found. Only the process that marks that gate
 * first may: two processes clearing it at once could otherwise each remove the gate the other has just made.
 */
export async function clearGate(path: string, gate: Found): Promise<boolean> {
  const marker = `${path}.${createHash('sha256').update(gate.holder ? gate.holder.token : `empty:${gate.file}`).digest('hex').slice(0, 16)}.clearing`;
  if (!await createFileExclusive(marker, '')) return false;
  try {
    const current = await find(path);
    if (current && sameFound(current, gate)) await unlink(path);
    return true;
  } finally { await unlink(marker).catch(() => {}); }
}
