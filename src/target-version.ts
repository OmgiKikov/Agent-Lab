import { execFile } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fingerprint, isRunnable, type Target } from './contracts.js';

/*
 * The agent version a record names, and whether two records name the same one.
 *
 *   module   <code>:<launch>        code: the adapter file, the Git state of its folder, the prompt
 *   command  <code>:<launch>[:cwd]  code: the entry file, the Git state of the command's working folder (cwd), the prompt
 *   http     http:<hash>            the address and the request template: the connection, not the code behind it
 *
 * A command's code is where it runs: an adapter kept in Lab's own repository (a harness) that starts the agent in the
 * agent's folder names the agent's version, and an edit of Lab names none. Where the working folder is another
 * repository than the entry file's, the fingerprint says `:cwd`, so it is never compared with one the earlier
 * algorithm took from the entry file's repository. An address says nothing of the code redeployed behind it: an http
 * agent's version is known only from the owner's name for it or the version its replies report.
 */

const exec = promisify(execFile);
// ponytail: one cached repository snapshot; independent active repositories may recompute, never reuse stale data.
let cached: { key: string; changes: string } | undefined;

const commandEntry = (args: string[]): string | undefined => args.find(arg => /\.(?:[cm]?js|ts|py|sh)$/.test(arg));
/** The same entry point is checked before preparation and fingerprinted before execution. */
export function targetEntryPath(target: Target): string | undefined {
  const entry = target.kind === 'module' ? target.path : target.kind === 'command' ? commandEntry(target.args) : undefined;
  return entry ? resolve(target.kind === 'command' ? target.cwd ?? process.cwd() : '.', entry) : undefined;
}

/**
 * The agent version a record names. For a module or a command: `<code>:<launch>` — the code part is the entry file,
 * the Git state and the prompt; the launch part is what the code does not show — the module export or the command
 * arguments (the entry file itself stands for its path, which differs between machines). For an http agent: the hash
 * of its address, request template and prompt. Records written before the launch part existed carry the code part alone.
 */
export async function targetFingerprint(target: Target): Promise<string | undefined> {
  if (target.kind === 'http') {
    const prompt = target.promptFile ? fingerprint(await readFile(target.promptFile, 'utf8')) : null;
    return `http:${fingerprint({ url: target.url, request: target.request ?? null, headersEnv: target.headersEnv, prompt })}`;
  }
  const { code, cwd } = await codeFingerprint(target);
  const launch = target.kind === 'module' ? { exportName: target.exportName }
    : target.kind === 'command' ? { args: target.args.map(arg => arg === commandEntry(target.args) ? '<entry>' : arg) } : undefined;
  const version = code && launch ? `${code}:${fingerprint(launch).slice(0, 16)}` : code;
  return version && cwd ? `${version}:cwd` : version;
}

type Relation = 'same' | 'changed' | 'unknown';
type Parsed = { http: string } | { code: string; launch?: string; cwd: boolean };
function parse(value: string): Parsed {
  if (value.startsWith('http:')) return { http: value.slice('http:'.length) };
  const [code = '', launch, tag] = value.split(':');
  return { code, ...(launch ? { launch } : {}), cwd: tag === 'cwd' };
}

/**
 * What two fingerprints say of the agent: the same version, another one, or nothing. «Unknown» is never «the same»:
 * a missing fingerprint, two fingerprints of one address (the code behind it may have been redeployed), and a
 * fingerprint of the earlier algorithm against one of the working folder's repository say nothing. An old
 * fingerprint without the launch part is compared on its code alone.
 */
export function targetVersionRelation(a: string | undefined, b: string | undefined): Relation {
  if (!a || !b) return 'unknown';
  const x = parse(a), y = parse(b);
  if ('http' in x || 'http' in y) return 'http' in x && 'http' in y && x.http !== y.http ? 'changed' : 'unknown';
  if (x.cwd !== y.cwd) return 'unknown';
  if (x.code !== y.code) return 'changed';
  return x.launch === undefined || y.launch === undefined || x.launch === y.launch ? 'same' : 'changed';
}

/**
 * Whether a fingerprint taken now shows no change against the one a record holds: both taken, and no part of them
 * differs. It guards a run against an agent edited under it, so it stops only on proof; comparisons of results ask
 * agentVersionRelation instead, which never takes «unknown» for «the same».
 */
export function sameTargetVersion(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && targetVersionRelation(a, b) !== 'changed';
}

/** What a record says of its agent's version: Lab's fingerprint, the owner's name for it, the version its replies reported. */
export interface VersionEvidence { targetFingerprint?: string | undefined; targetVersion?: string | undefined; targetRelease?: string | undefined }

/**
 * Whether two runs tested the same version of the agent. «The same» needs proof — the owner's equal names, equal
 * versions the agent reported, or equal code fingerprints — and no part that differs; an owner's name on one side only
 * is a change. Anything else is «unknown»: a result is never called unstable, nor fixed by a new version, on it.
 */
export function agentVersionRelation(a: VersionEvidence, b: VersionEvidence): Relation {
  const parts: Relation[] = [
    a.targetVersion === undefined && b.targetVersion === undefined ? 'unknown' : a.targetVersion === b.targetVersion ? 'same' : 'changed',
    a.targetRelease === undefined || b.targetRelease === undefined ? 'unknown' : a.targetRelease === b.targetRelease ? 'same' : 'changed',
    targetVersionRelation(a.targetFingerprint, b.targetFingerprint),
  ];
  return parts.includes('changed') ? 'changed' : parts.includes('same') ? 'same' : 'unknown';
}

/** The repository a folder is in, or null outside one. */
async function repository(folder: string): Promise<string | null> {
  try { return (await exec('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { timeout: 5000 })).stdout.replace(/\r?\n$/, ''); }
  catch { return null; }
}

/** The commit and the tracked changes of the repository `folder` is in; undefined outside one. `key` names the snapshot's owner for the cache. */
async function gitState(folder: string, key: string): Promise<{ commit: string; changes: string } | undefined> {
  let commit: string;
  try { commit = (await exec('git', ['-C', folder, 'rev-parse', 'HEAD'], { timeout: 5000 })).stdout.trim(); }
  catch { return undefined; } // A standalone adapter can still be identified by its content.
  const git = async (args: string[]) => (await exec('git', ['-C', folder, ...args], { timeout: 5000, maxBuffer: 20_000_000 })).stdout;
  const root = (await git(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  const names = (await git(['diff', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean);
  const metadata = await Promise.all(names.map(async name => {
    try { const s = await lstat(resolve(root, name), { bigint: true }); return [name, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].map(String); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, 'deleted']; throw error; }
  }));
  const snapshot = fingerprint({ path: key, commit, metadata });
  if (cached?.key !== snapshot) cached = { key: snapshot, changes: await git(['diff', '--no-relative', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']) };
  return { commit, changes: cached.changes };
}

/** An entry file's content, with the reason in the owner's words when it cannot be read. */
async function entryContent(path: string): Promise<string> {
  const entryStat = await stat(path);
  if (!entryStat.isFile()) throw Object.assign(new Error(), { code: 'EISDIR' });
  if (entryStat.size > 5_000_000) throw Object.assign(new Error(), { code: 'EFBIG' });
  return readFile(path, 'utf8');
}

/**
 * Local code identity without persisting source code, diffs or environment secrets. A module is its file and its
 * folder's repository; a command is its entry file and its working folder's repository — `cwd` when that is not the
 * repository the entry file is in, where the earlier algorithm looked.
 */
async function codeFingerprint(target: Target): Promise<{ code?: string; cwd?: true }> {
  const path = targetEntryPath(target);
  const prompt = isRunnable(target) && target.promptFile ? await readFile(target.promptFile, 'utf8') : undefined;
  const folder = target.kind === 'command' ? target.cwd ?? process.cwd() : path ? dirname(path) : undefined;
  if (!path && (target.kind !== 'command' || !folder)) return prompt === undefined ? {} : { code: fingerprint({ prompt }) };
  try {
    const content = path ? await entryContent(path) : undefined;
    const state = await gitState(folder!, path ?? folder!);
    if (content === undefined && !state) return prompt === undefined ? {} : { code: fingerprint({ prompt }) };
    // Fingerprints cover the entry point and tracked Git changes; remote services, untracked dependencies and environment changes need targetVersion.
    const code = fingerprint({ content, commit: state?.commit, changes: state?.changes, prompt });
    const elsewhere = target.kind === 'command' && (!path || await repository(dirname(path)) !== await repository(folder!));
    return { code, ...(elsewhere ? { cwd: true as const } : {}) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' || code === 'ENOTDIR' ? `Не найден файл агента: ${path}. Исправьте путь в подключении.`
      : code === 'EISDIR' ? `Вместо файла агента указана папка: ${path}. Выберите файл адаптера.`
      : code === 'EFBIG' ? 'Точка входа агента превышает 5 МБ. Укажите небольшой адаптер.'
      : code === 'EACCES' || code === 'EPERM' ? `Нет доступа к файлу агента: ${path}. Проверьте права чтения.`
      : `Не удалось проверить версию агента: ${path ?? folder}. Проверьте доступ к файлам и состояние Git; черновик можно повторить после исправления.`);
  }
}
