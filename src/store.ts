import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, watch } from 'node:fs';
import { mkdir, open, readFile, readdir, readlink, unlink, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { judgeAuditSchema, type JudgeAudit } from './assessment.js';
import { judgeCheckSchema, type JudgeCheck } from './judge-check.js';
import { experimentSchema, fingerprint, type Experiment, type TraceEvent } from './contracts.js';
import { createFileExclusive, writeFileAtomic, writeFileAtomicSync } from './fs-atomic.js';
import type { GeneratorEvidence } from './generator-evidence.js';
import { libraryHash } from './scenario-library.js';
import { ScenarioFiles } from './scenario-store.js';
import { oneLine } from './text.js';
import { isIdentifier } from './ids.js';
import { LockedError } from './errors.js';
import type { ImportBatch } from './scenario-contracts.js';
import type { ScenarioLibrary } from './card/schema.js';
import { readTopicMapFile, writeTopicMapFile } from './miner/files.js';
import { readProposedFile, writeProposedFile, writeReadingFile } from './spreadsheet/files.js';
import type { ProposedReading } from './spreadsheet/reading-task.js';
import { readPurposeFile, writePurposeFile, type PurposeProposal } from './prompt-purpose.js';
import type { TableReading } from './spreadsheet/mapping.js';
import type { TopicMap, TopicMapKey, TopicMapProgress } from './miner/topic-map.js';
import type { LogVersionJournal } from './card/calibration.js';

/*
 * Storage, and only storage, of one data folder: a record per run as one atomic JSON file, the writer's lock, the
 * append-only journals and sidecars of every dialogue and judgment, the content-addressed file areas the records
 * point at (imports, libraries, the owners' declarations, topic maps, spreadsheet readings, prompt purposes) and the publication
 * journal that finishes a library write interrupted halfway. Every write goes through the one writer's queue; every
 * read works without the lock. What a phase allows, what a command changes and what a run may spend is decided in
 * lab/, never here.
 */

type AuditFolder = 'judge' | 'calibration' | 'judge-check';
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/*
 * The writer's lock (`.lock`) and the gate of its recovery (`.recovery`) name the process that holds them: its PID and
 * token, the machine it runs on — the host name and, where the system tells them, the boot and the PID namespace — and
 * when the process started. A lock is taken from its holder only when the holder's death is proved:
 *
 *   an empty file ─────────────────────── older than EMPTY_GRACE_MS: its writer died between creating and writing it
 *   written on this machine (same host, boot and PID namespace; or by a Lab before machines were recorded)
 *     with our own PID ────────────────── no store of this process holds it (a restarted container gives PID 1 again)
 *     with another PID ────────────────── that process is gone, or the PID now belongs to a process started at another time
 *   written elsewhere (another machine, container or PID namespace, where its PID means nothing here)
 *                     ─────────────────── its heartbeat is older than STALE_MS
 *
 * The holder renews the heartbeat — the lock file's modification time — every HEARTBEAT_MS, and stops writing once the
 * lock is no longer its own. A file no Lab wrote is never taken: it waits for a person.
 */
/** How often the writer renews its lock's heartbeat. */
const HEARTBEAT_MS = 10_000;
/** A lock written elsewhere is dead once its heartbeat is this old: well past a missed beat or two, and clock skew between machines. */
const STALE_MS = 60_000;
/** An empty lock or gate: a Lab creates it and writes its holder at once, so an empty one this old was left by a dead process. */
const EMPTY_GRACE_MS = 5_000;

/** The process a lock or a recovery gate names. A lock of an earlier Lab names only its PID and token. */
interface Holder { pid: number; token: string; host?: string; boot?: string; pidNamespace?: string; started?: number }
/** A lock or gate as found: its holder — undefined while the file is empty, null when no Lab wrote it — its heartbeat and its file. */
interface Found { holder: Holder | null | undefined; beatMs: number; file: number }

/** When a process started, in clock ticks since boot (field 22 of /proc/<pid>/stat); undefined where the system does not tell. */
async function startOf(pid: number): Promise<number | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  // The command name (field 2) is in parentheses and may hold spaces and parentheses: the fields after it follow the last ')'.
  const field = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const started = field ? Number(field) : NaN;
  return Number.isSafeInteger(started) ? started : undefined;
}

/** This process as a lock names it: read once. */
let self: Promise<Omit<Holder, 'token'>> | undefined;
const thisProcess = () => self ??= (async () => {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
  const pidNamespace = await readlink('/proc/self/ns/pid').catch(() => '');
  const started = await startOf(process.pid);
  return { pid: process.pid, host: hostname(), ...(boot ? { boot } : {}), ...(pidNamespace ? { pidNamespace } : {}), ...(started === undefined ? {} : { started }) };
})();

/** Tokens of the locks and gates this process holds, shared by every copy of this module loaded in it (Pi loads the extension through jiti). */
const held = ((globalThis as Record<symbol, unknown>)[Symbol.for('agent-lab.store.held')] ??= new Set<string>()) as Set<string>;

function holderIn(text: string): Holder | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const { pid, token, host, boot, pidNamespace, started } = raw as Record<string, unknown>;
  const named = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string' && value.length > 0;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof token !== 'string' || !token || !named(host) || !named(boot) || !named(pidNamespace)
    || started !== undefined && (typeof started !== 'number' || !Number.isSafeInteger(started) || started < 0)) return null;
  return { pid, token, ...(host ? { host } : {}), ...(boot ? { boot } : {}), ...(pidNamespace ? { pidNamespace } : {}), ...(started === undefined ? {} : { started }) };
}

/** A lock or gate as it is now; null when there is none. */
async function find(path: string): Promise<Found | null> {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const info = await file.stat();
    const text = await file.readFile('utf8');
    return { holder: text ? holderIn(text) : undefined, beatMs: info.mtimeMs, file: info.ino };
  } finally { await file.close(); }
}

const sameFound = (a: Found, b: Found): boolean => a.holder && b.holder ? a.holder.pid === b.holder.pid && a.holder.token === b.holder.token
  : a.holder === b.holder && a.file === b.file;

/** Whether the holder of a lock or gate is proved dead (the diagram above). */
async function provedDead(found: Found): Promise<boolean> {
  const { holder } = found;
  if (holder === null) return false;
  const age = Date.now() - found.beatMs;
  if (holder === undefined) return age > EMPTY_GRACE_MS;
  const here = await thisProcess();
  const local = holder.host === undefined || holder.host === here.host && holder.boot === here.boot && holder.pidNamespace === here.pidNamespace;
  if (!local) return age > STALE_MS;
  if (holder.pid === process.pid) return !held.has(holder.token);
  if (!alive(holder.pid)) return true;
  if (holder.started === undefined) return false;
  const started = await startOf(holder.pid);
  return started !== undefined && started !== holder.started;
}

/**
 * Removes a gate whose holder is proved dead, if it is still the gate found. Only the process that marks that gate
 * first may: two processes clearing it at once could otherwise each remove the gate the other has just made.
 */
async function clearGate(path: string, gate: Found): Promise<boolean> {
  const marker = `${path}.${createHash('sha256').update(gate.holder ? gate.holder.token : `empty:${gate.file}`).digest('hex').slice(0, 16)}.clearing`;
  if (!await createFileExclusive(marker, '')) return false;
  try {
    const current = await find(path);
    if (current && sameFound(current, gate)) await unlink(path);
    return true;
  } finally { await unlink(marker).catch(() => {}); }
}

export class ExperimentStore {
  readonly directory: string;
  diagnostics: { id: string; message: string }[] = [];
  private lockToken: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private writerQueue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.directory = resolve(directory); }
  private path(id: string): string {
    if (!isIdentifier(id)) throw new Error('Invalid experiment ID');
    return join(this.directory, `${id}.json`);
  }

  /* ── the writer: the lock and the queue every write goes through ── */
  /** The lock as it is now; a lock no Lab wrote is refused and kept for a person to inspect. */
  private async lock(): Promise<Found | null> {
    const lockPath = join(this.directory, '.lock');
    const found = await find(lockPath);
    if (found?.holder === null) throw new Error(`Некорректный lock: ${lockPath}. Исходный файл сохранён; проверьте владельца перед восстановлением.`);
    return found;
  }
  private async acquire(): Promise<void> {
    const token = randomUUID();
    if (!await createFileExclusive(join(this.directory, '.lock'), JSON.stringify({ ...await thisProcess(), token }))) throw new LockedError();
    this.lockToken = token; held.add(token);
    this.heartbeat = setInterval(() => { void this.beat(); }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }
  /** Renews the lock's heartbeat. A lock that is no longer this writer's — removed, or taken as dead — ends its writing. */
  private async beat(): Promise<void> {
    const token = this.lockToken;
    if (!token) return;
    const lockPath = join(this.directory, '.lock');
    let current: Found | null;
    // A beat that cannot read the lock is tried again at the next one.
    try { current = await find(lockPath); } catch { return; }
    if (this.lockToken !== token) return;
    if (current?.holder?.token !== token) { this.release(token); return; }
    const now = new Date();
    await utimes(lockPath, now, now).catch(() => {});
  }
  private release(token: string): void {
    if (this.lockToken === token) this.lockToken = null;
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    held.delete(token);
  }
  /**
   * Passes the one recovery gate of the folder, clearing once a gate its dead holder left. A gate held by a process
   * that may be alive, or that no Lab wrote, refuses: it needs manual inspection, not recursive recovery.
   */
  private async throughGate(work: () => Promise<void>): Promise<void> {
    const path = join(this.directory, '.recovery');
    const token = randomUUID();
    const text = JSON.stringify({ ...await thisProcess(), token });
    for (let attempt = 0; !await createFileExclusive(path, text); attempt++) {
      const gate = await find(path);
      if (attempt === 0 && (!gate || await provedDead(gate) && await clearGate(path, gate))) continue;
      throw new Error(`Восстановление уже занято: ${path}. Если предыдущий процесс завершился, проверьте этот файл; действующий lock не изменён.`);
    }
    held.add(token);
    try { await work(); }
    finally { try { await unlink(path); } finally { held.delete(token); } }
  }
  /** Only writers initialize; atomic records and the journal can be read without owning the lock. */
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const observed = await this.lock();
    if (!observed) await this.acquire();
    else {
      if (!await provedDead(observed)) throw new LockedError();
      await this.throughGate(async () => {
        // Under the gate: the lock is still the one found dead, or someone took the folder meanwhile.
        const current = await this.lock();
        if (current) {
          if (!sameFound(current, observed) || !await provedDead(current)) throw new LockedError();
          await unlink(join(this.directory, '.lock'));
        }
        await this.acquire();
      });
    }
    try { await this.recoverPublications(); } catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    await this.writerQueue;
    const token = this.lockToken;
    if (!token) return;
    this.lockToken = null;
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    try {
      const owner = await this.lock();
      if (owner?.holder?.token === token) await unlink(join(this.directory, '.lock'));
    } finally { held.delete(token); }
  }
  private async writeTransaction<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writerQueue.then(async () => {
      if (!this.lockToken) throw new Error('Для изменения записи откройте лабораторию как писатель.');
      await this.recoverPendingPublications();
      return work();
    });
    this.writerQueue = pending.catch(() => {});
    return pending;
  }

  /* ── records ── */
  save(record: Experiment): Promise<void> { return this.writeTransaction(() => this.saveRecord(record)); }
  private async saveRecord(record: Experiment): Promise<void> {
    if (!this.lockToken) throw new Error('Для изменения записи откройте лабораторию как писатель.');
    const validated = experimentSchema.parse(record);
    if (validated.librarySnapshot) await new ScenarioFiles(this.directory).retainLibrary(validated.librarySnapshot);
    await writeFileAtomic(this.path(validated.id), JSON.stringify(validated, null, 2));
  }
  async get(id: string): Promise<Experiment> {
    const file = await open(this.path(id), 'r');
    try {
      if ((await file.stat()).size > 50_000_000) throw new Error('Experiment record exceeds 50 MB');
      const record = experimentSchema.parse(JSON.parse(await file.readFile('utf8')));
      if (record.id !== id) throw new Error('Experiment ID does not match its file');
      return record;
    } finally { await file.close(); }
  }
  async list(): Promise<Experiment[]> {
    this.diagnostics = [];
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const ids = names.filter(n => n.endsWith('.json') && isIdentifier(n.slice(0, -5))).map(n => n.slice(0, -5));
    const results = await Promise.allSettled(ids.map(id => this.get(id)));
    const records: Experiment[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') records.push(result.value);
      else this.diagnostics.push({ id: ids[index]!, message: result.reason instanceof SyntaxError ? 'Некорректный JSON. Исходный файл сохранён.'
        : oneLine(result.reason instanceof Error ? result.reason.message : result.reason).slice(0, 240) });
    });
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /**
   * Calls `changed` with a record's id whenever its file is written — by this process or another — until the returned
   * stop: a reader follows another process's work without asking the disk again and again. A folder the system
   * cannot watch never calls it.
   */
  watch(changed: (id: string) => void): () => void {
    try {
      const watcher = watch(this.directory, (_event, name) => {
        const id = typeof name === 'string' && name.endsWith('.json') ? name.slice(0, -5) : undefined;
        if (id !== undefined && isIdentifier(id)) changed(id);
      });
      watcher.on('error', () => watcher.close());
      return () => watcher.close();
    } catch { return () => {}; }
  }

  /* ── journals and sidecars ── */
  appendTrace(id: string, trialId: string, event: TraceEvent): void {
    if (!this.lockToken) throw new Error('Для записи трассы откройте лабораторию как писатель.');
    this.path(id);
    if (!isIdentifier(trialId)) throw new Error('Invalid trial ID');
    appendFileSync(join(this.directory, `${id}.trace.jsonl`), `${JSON.stringify({ trialId, event })}\n`, { mode: 0o600 });
  }
  /** Same writer as the library; each raw attempt is durable before parsing or another call. */
  appendGeneratorEvidence(id: string, event: GeneratorEvidence): void {
    if (!this.lockToken) throw new Error('Для записи генерации откройте лабораторию как писатель.');
    this.path(id);
    appendFileSync(join(this.directory, `${id}.generator.jsonl`), `${JSON.stringify({ hash: fingerprint(event), event })}\n`, { mode: 0o600, flush: true });
  }
  async generatorEvidence(id: string): Promise<GeneratorEvidence[]> {
    this.path(id);
    const text = await readFile(join(this.directory, `${id}.generator.jsonl`), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    return text.split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line);
      if (!row.event || row.hash !== fingerprint(row.event)) throw new Error('Повреждено доказательство генерации.');
      return row.event as GeneratorEvidence;
    });
  }
  async traceJournal(id: string): Promise<string> {
    this.path(id);
    try { return await readFile(join(this.directory, `${id}.trace.jsonl`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
  appendJudgment(id: string, trialId: string, audit: JudgeAudit): void {
    if (!this.lockToken) throw new Error('Для записи оценки откройте лабораторию как писатель.');
    this.path(id);
    if (!isIdentifier(trialId)) throw new Error('Invalid trial ID');
    // The existing evidence journal also survives interruption during assessment.
    appendFileSync(join(this.directory, `${id}.trace.jsonl`), `${JSON.stringify({ trialId, judgeAudit: judgeAuditSchema.parse(audit) })}\n`, { mode: 0o600, flush: true });
  }
  /**
   * Full audit of one judgment, replaced atomically on every call: a trial's in `{id}.judge/{trialId}.json`, an
   * expectation judged on its recorded conversation (card/log-judge.ts) in `{id}.calibration/{key}.json`, a copy judged
   * by a judge check (judge-check.ts) in `{id}.judge-check/{name}.json`.
   */
  private auditPath(id: string, folder: AuditFolder, name: string): string {
    this.path(id);
    if (!isIdentifier(name)) throw new Error(folder === 'judge' ? 'Invalid trial ID' : folder === 'calibration' ? 'Invalid calibration key' : 'Invalid judge check item');
    return join(this.directory, `${id}.${folder}`, `${name}.json`);
  }
  // Synchronous on purpose: onJudgment is synchronous, and a crash must leave the last complete audit on disk.
  private writeAudit(id: string, folder: AuditFolder, name: string, audit: JudgeAudit): void {
    if (!this.lockToken) throw new Error('Для записи оценки откройте лабораторию как писатель.');
    // The path check comes first: an unsafe id must be refused before anything touches the disk.
    const target = this.auditPath(id, folder, name);
    const content = JSON.stringify(judgeAuditSchema.parse(audit));
    mkdirSync(join(this.directory, `${id}.${folder}`), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(target, content);
  }
  private async readAudit(id: string, folder: AuditFolder, name: string): Promise<JudgeAudit | null> {
    const target = this.auditPath(id, folder, name);
    let file;
    try { file = await open(target, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      if ((await file.stat()).size > 20_000_000) throw new Error('Judge audit exceeds 20 MB');
      return judgeAuditSchema.parse(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  }
  writeJudgeAudit(id: string, trialId: string, audit: JudgeAudit): void { this.writeAudit(id, 'judge', trialId, audit); }
  readJudgeAudit(id: string, trialId: string): Promise<JudgeAudit | null> { return this.readAudit(id, 'judge', trialId); }
  writeCalibrationAudit(id: string, key: string, audit: JudgeAudit): void { this.writeAudit(id, 'calibration', key, audit); }
  readCalibrationAudit(id: string, key: string): Promise<JudgeAudit | null> { return this.readAudit(id, 'calibration', key); }
  writeJudgeCheckAudit(id: string, name: string, audit: JudgeAudit): void { this.writeAudit(id, 'judge-check', name, audit); }
  readJudgeCheckAudit(id: string, name: string): Promise<JudgeAudit | null> { return this.readAudit(id, 'judge-check', name); }
  /** A run's judge check (judge-check.ts), beside the run and never inside it: `{id}.judge-check.json`, replaced whole. */
  writeJudgeCheck(check: JudgeCheck): Promise<void> {
    return this.writeTransaction(async () => {
      const validated = judgeCheckSchema.parse(check);
      await writeFileAtomic(this.checkPath(validated.runId), JSON.stringify(validated, null, 2));
    });
  }
  /** The run's judge check; null when the run was never checked. */
  async readJudgeCheck(id: string): Promise<JudgeCheck | null> {
    let raw: string;
    try { raw = await readFile(this.checkPath(id), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    return judgeCheckSchema.parse(JSON.parse(raw));
  }
  private checkPath(id: string): string { this.path(id); return join(this.directory, `${id}.judge-check.json`); }

  /* ── file areas: imports, the owners' declarations, topic maps, libraries ── */
  readImport(id: string): Promise<ImportBatch> { return new ScenarioFiles(this.directory).readImport(id); }
  writeImport(batch: ImportBatch): Promise<ImportBatch> { return this.writeTransaction(() => new ScenarioFiles(this.directory).writeImport(batch)); }
  /** A spreadsheet's import and the reading the owner confirmed for it, side by side (spreadsheet/files.ts). */
  writeTableImport(batch: ImportBatch, reading: TableReading): Promise<ImportBatch> {
    return this.writeTransaction(async () => {
      const stored = await new ScenarioFiles(this.directory).writeImport(batch);
      await writeReadingFile(this.directory, stored.id, stored.contentHash, reading);
      return stored;
    });
  }
  /** What Lab's model proposed for a spreadsheet under `key` (spreadsheet/files.ts); undefined when it proposed nothing yet. */
  readProposedReading(key: string): Promise<ProposedReading | undefined> { return readProposedFile(this.directory, key); }
  writeProposedReading(proposed: ProposedReading): Promise<void> { return this.writeTransaction(() => writeProposedFile(this.directory, proposed)); }
  /** What Lab's model proposed about the purposes of a set of prompts under `key` (prompt-purpose.ts); undefined when it proposed nothing yet. */
  readPromptPurposes(key: string): Promise<PurposeProposal | undefined> { return readPurposeFile(this.directory, key); }
  writePromptPurposes(proposal: PurposeProposal): Promise<void> { return this.writeTransaction(() => writePurposeFile(this.directory, proposal)); }
  /** The topic map of an import stored under `key`, finished or still being built (miner/files.ts); undefined when there is none. */
  readTopicMap(key: TopicMapKey): Promise<unknown> { return readTopicMapFile(this.directory, key); }
  /** Stores a topic map, or the progress of its build, next to its import. */
  writeTopicMap(value: TopicMap | TopicMapProgress): Promise<void> { return this.writeTransaction(() => writeTopicMapFile(this.directory, value)); }
  /** Which agent version wrote an import's logs, as the owner declared it (card/calibration.ts); undefined before the first declaration. */
  readLogVersions(importId: string): Promise<LogVersionJournal | undefined> { return new ScenarioFiles(this.directory).readLogVersions(importId); }
  /** Appends a declaration to its import's journal, if the journal is still the one it was prepared on. */
  writeLogVersions(journal: LogVersionJournal, expectedHash: string | null): Promise<void> {
    return this.writeTransaction(() => new ScenarioFiles(this.directory).writeLogVersions(journal, expectedHash));
  }
  readLibrary(id: string, hash?: string): Promise<ScenarioLibrary> { return new ScenarioFiles(this.directory).readLibrary(id, hash); }
  writeLibrary(library: ScenarioLibrary, expectedHash?: string): Promise<void> {
    return this.writeTransaction(() => new ScenarioFiles(this.directory).writeLibrary(library, expectedHash));
  }

  /* ── publication: a library and its record written together, finished after a crash ── */
  /** Finish durable publication intents before accepting another mutation; readers remain lock-free. */
  recoverPublications(): Promise<void> { return this.writeTransaction(async () => {}); }
  private async recoverPendingPublications(): Promise<void> {
    const files = new ScenarioFiles(this.directory);
    for (const { record, expectedHash } of await files.pendingPublications()) {
      const library = record.librarySnapshot!;
      const current = await files.readLibrary(library.id).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      if (!current || libraryHash(current) !== libraryHash(library)) await files.writeLibrary(library, expectedHash);
      await this.saveRecord(record);
      await files.finishPublication(record.id);
    }
  }
  publishLibrary(record: Experiment, library: ScenarioLibrary, expectedHash?: string): Promise<void> {
    return this.writeTransaction(async () => {
      const next = experimentSchema.parse({ ...record, librarySnapshot: library });
      const files = new ScenarioFiles(this.directory);
      await files.checkLibraryWrite(library, expectedHash);
      await files.retainLibrary(library);
      await files.writePublication(next, expectedHash);
      await files.writeLibrary(library, expectedHash ?? libraryHash(library));
      await this.saveRecord(next);
      await files.finishPublication(next.id);
    });
  }
}
