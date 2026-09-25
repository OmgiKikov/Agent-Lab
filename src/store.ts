import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, utimesSync, watch } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { judgeAuditSchema, type JudgeAudit } from './assessment.js';
import { judgeCheckSchema, type JudgeCheck } from './judge-check.js';
import { experimentSchema, fingerprint, type Experiment, type TraceEvent } from './contracts.js';
import { createFileExclusive, syncDirectory, writeFileAtomic, writeFileAtomicSync } from './fs-atomic.js';
import { clearGate, find, HEARTBEAT_MS, held, provedDead, sameFound, SYSTEM, tokenNow, type Found, type Processes } from './folder-lock.js';
import type { GeneratorEvidence } from './generator-evidence.js';
import { libraryHash } from './scenario-library.js';
import { LibraryMemo, ScenarioFiles } from './scenario-store.js';
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
import type { SentCalls } from './lab/interrupted.js';

/*
 * Storage, and only storage, of one data folder: a record per run as one atomic JSON file, the writer's lock, the
 * append-only journals and sidecars of every dialogue and judgment, the content-addressed file areas the records
 * point at (imports, libraries, the owners' declarations, topic maps, spreadsheet readings, prompt purposes) and the publication
 * journal that finishes a library write interrupted halfway. Every write goes through the one writer's queue; every
 * read works without the lock. What a phase allows, what a command changes and what a run may spend is decided in
 * lab/, never here.
 */

type AuditFolder = 'judge' | 'calibration' | 'judge-check';

/**
 * A writer whose heartbeat is this late was frozen — a laptop asleep, a stopped process — and may have lost its lock to
 * another machine meanwhile (folder-lock.ts): before its next write it reads the lock again.
 */
const OVERDUE_MS = HEARTBEAT_MS * 1.5;
/** A temporary file of an atomic write (fs-atomic.ts): its target's name, a UUID, `.tmp`. */
const TEMPORARY = /^(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** Files at the folder's top that processes without the writer's lock write too. */
const OTHERS_FILES: ReadonlySet<string> = new Set(['.lock', '.recovery', 'connection.local.json', 'gateway.json']);
/** No live write of a file takes this long. */
const LIVE_WRITE_MS = 60_000;

export class ExperimentStore {
  readonly directory: string;
  diagnostics: { id: string; message: string }[] = [];
  private lockToken: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** When this writer last found its lock its own and renewed it. */
  private beatAt = 0;
  /** This writer lost its lock while it held it: another process took the folder. */
  private lost = false;
  private writerQueue: Promise<unknown> = Promise.resolve();
  /** What this writer knows of its libraries, so an unchanged one is not validated, hashed and read back on every save. */
  private readonly memo = new LibraryMemo();
  /** `processes`: what the system tells of the lock's holder (folder-lock.ts); injected only to check the lock's rules. */
  constructor(directory: string, private readonly processes: Processes = SYSTEM) { this.directory = resolve(directory); }
  private path(id: string): string {
    if (!isIdentifier(id)) throw new Error('Invalid experiment ID');
    return join(this.directory, `${id}.json`);
  }
  private files(): ScenarioFiles { return new ScenarioFiles(this.directory, this.memo); }
  private get lockPath(): string { return join(this.directory, '.lock'); }

  /* ── the writer: the lock and the queue every write goes through ── */
  /** The lock as it is now; a lock no Lab wrote is refused and kept for a person to inspect. */
  private async lock(): Promise<Found | null> {
    const found = await find(this.lockPath);
    if (found?.holder === null) throw new Error(`Некорректный lock: ${this.lockPath}. Исходный файл сохранён; проверьте владельца перед восстановлением.`);
    return found;
  }
  private async acquire(): Promise<void> {
    const token = randomUUID();
    if (!await createFileExclusive(this.lockPath, JSON.stringify({ ...await this.processes.self(), token }))) throw new LockedError(this.directory);
    this.lockToken = token; held.add(token); this.memo.forget(); this.beatAt = Date.now(); this.lost = false;
    this.heartbeat = setInterval(() => { void this.beat(); }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }
  /** Renews the lock's heartbeat. A lock that is no longer this writer's — removed, or taken as dead — ends its writing. */
  private async beat(): Promise<void> {
    const token = this.lockToken;
    if (!token) return;
    let current: Found | null;
    // A beat that cannot read the lock is tried again at the next one.
    try { current = await find(this.lockPath); } catch { return; }
    if (this.lockToken !== token) return;
    if (current?.holder?.token !== token) { this.release(token); return; }
    const now = new Date();
    await utimes(this.lockPath, now, now).catch(() => {});
    this.beatAt = now.getTime();
  }
  /**
   * Refuses a write this store may not make now, with `message` when it never was the writer. A writer whose heartbeat is
   * overdue was frozen and may have lost its lock to another machine meanwhile: it reads the lock first, synchronously,
   * and stops writing when the lock is no longer its own — then the refusal is that another process holds the folder.
   */
  private assertWriting(message: string): void {
    const token = this.lockToken;
    if (token && Date.now() - this.beatAt > OVERDUE_MS) {
      if (tokenNow(this.lockPath) !== token) this.release(token);
      else {
        const now = new Date();
        try { utimesSync(this.lockPath, now, now); } catch { /* the next beat renews it */ }
        this.beatAt = now.getTime();
      }
    }
    if (!this.lockToken) throw this.lost ? new LockedError(this.directory) : new Error(message);
  }
  private release(token: string): void {
    if (this.lockToken === token) { this.lockToken = null; this.lost = true; }
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    held.delete(token); this.memo.forget();
  }
  /**
   * Passes the one recovery gate of the folder, clearing once a gate its dead holder left. A gate held by a process
   * that may be alive, or that no Lab wrote, refuses: it needs manual inspection, not recursive recovery.
   */
  private async throughGate(work: () => Promise<void>): Promise<void> {
    const path = join(this.directory, '.recovery');
    const token = randomUUID();
    const text = JSON.stringify({ ...await this.processes.self(), token });
    for (let attempt = 0; !await createFileExclusive(path, text); attempt++) {
      const gate = await find(path);
      if (attempt === 0 && (!gate || await provedDead(gate, this.processes) && await clearGate(path, gate))) continue;
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
      if (!await provedDead(observed, this.processes)) throw new LockedError(this.directory);
      await this.throughGate(async () => {
        // Under the gate: the lock is still the one found dead, or someone took the folder meanwhile.
        const current = await this.lock();
        if (current) {
          if (!sameFound(current, observed) || !await provedDead(current, this.processes)) throw new LockedError(this.directory);
          await unlink(this.lockPath);
        }
        await this.acquire();
      });
    }
    await this.sweepTemporaries();
    try { await this.recoverPublications(); } catch (error) { await this.close(); throw error; }
  }
  /**
   * Removes what dead processes left of their writes: the temporary files of atomic writes (`<name>.<uuid>.tmp`) and the
   * markers of a gate's clearing. Every write of the store goes through its one writer, so once this writer holds the
   * folder its own kinds of temporary file are never a live write's. The files at the folder's top that processes without
   * the lock write too — a lock attempt, the remembered connection of `doctor`, the gateway's settings when the folder is
   * the home one — are removed only when older than LIVE_WRITE_MS, which no live write takes.
   */
  private async sweepTemporaries(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory, { recursive: true }); } catch { return; }
    for (const name of names) {
      const temporary = TEMPORARY.exec(basename(name));
      const marker = dirname(name) === '.' && name.endsWith('.clearing') && (name.startsWith('.lock.') || name.startsWith('.recovery.'));
      if (!temporary && !marker) continue;
      const path = join(this.directory, name);
      if (marker || dirname(name) === '.' && OTHERS_FILES.has(temporary![1]!)) {
        const info = await stat(path).catch(() => undefined);
        if (!info || Date.now() - info.mtimeMs < LIVE_WRITE_MS) continue;
      }
      await unlink(path).catch(() => {});
    }
  }
  async close(): Promise<void> {
    await this.writerQueue;
    const token = this.lockToken;
    if (!token) return;
    this.lockToken = null;
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    try {
      const owner = await this.lock();
      if (owner?.holder?.token === token) await unlink(this.lockPath);
    } finally { held.delete(token); this.memo.forget(); }
  }
  private async writeTransaction<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writerQueue.then(async () => {
      this.assertWriting('Для изменения записи откройте лабораторию как писатель.');
      await this.recoverPendingPublications();
      return work();
    });
    this.writerQueue = pending.catch(() => {});
    return pending;
  }

  /* ── records ── */
  /**
   * The record as it is at the call, validated and detached from the live one: a write waits its turn in the queue,
   * and what the caller changes meanwhile belongs to its next save. The library is the one the caller holds, as the memo
   * admitted it: a run saves the same accepted snapshot at every checkpoint.
   */
  private snapshot(record: Experiment): Experiment {
    const validated = experimentSchema.parse(record);
    if (record.librarySnapshot && validated.librarySnapshot) validated.librarySnapshot = this.memo.admit(record.librarySnapshot, validated.librarySnapshot).library;
    return validated;
  }
  async save(record: Experiment): Promise<void> {
    const validated = this.snapshot(record);
    await this.writeTransaction(() => this.saveRecord(validated));
  }
  private async saveRecord(validated: Experiment): Promise<void> {
    this.assertWriting('Для изменения записи откройте лабораторию как писатель.');
    if (validated.librarySnapshot) await this.files().retainLibrary(validated.librarySnapshot);
    // A checkpoint covers the evidence its record points at: the dialogue lines and the judges' audits reach the disk first.
    await this.flushEvidence(validated.id);
    await writeFileAtomic(this.path(validated.id), JSON.stringify(validated, null, 2));
  }
  /**
   * What a record's work wrote since its last checkpoint without flushing it: the trace journal, which takes a line per
   * event of every dialogue, and the folders of the audits replaced at every vote — too many to flush one by one. They are
   * flushed at the record's next checkpoint (saveRecord). The other journals flush every line: one per call or verdict.
   */
  private readonly unflushed = new Map<string, Set<string>>();
  private written(id: string, path: string): void {
    const paths = this.unflushed.get(id) ?? new Set<string>();
    paths.add(path); this.unflushed.set(id, paths);
  }
  private async flushEvidence(id: string): Promise<void> {
    const paths = this.unflushed.get(id);
    if (!paths) return;
    this.unflushed.delete(id);
    for (const path of paths) {
      if (path.endsWith('.jsonl')) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
      else await syncDirectory(path);
    }
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
    this.assertWriting('Для записи трассы откройте лабораторию как писатель.');
    this.path(id);
    if (!isIdentifier(trialId)) throw new Error('Invalid trial ID');
    const path = join(this.directory, `${id}.trace.jsonl`);
    appendFileSync(path, `${JSON.stringify({ trialId, event })}\n`, { mode: 0o600 });
    this.written(id, path);
  }
  /** Same writer as the library; each raw attempt is durable before parsing or another call. */
  appendGeneratorEvidence(id: string, event: GeneratorEvidence): void {
    this.assertWriting('Для записи генерации откройте лабораторию как писатель.');
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
  /**
   * A call counts as spent when it is sent: an operation on the record `id` writes its counts here, on disk, before the
   * call's request leaves (lab/operation.ts), so calls made after the last checkpoint survive a crash. One line per call
   * in `{id}.calls.jsonl`; the counts only grow, so the most of each is the truth whatever launch wrote it.
   */
  appendCall(id: string, counts: SentCalls): void {
    this.assertWriting('Для записи вызова откройте лабораторию как писатель.');
    this.path(id);
    appendFileSync(join(this.directory, `${id}.calls.jsonl`), `${JSON.stringify(counts)}\n`, { mode: 0o600, flush: true });
  }
  /** The most of each count the calls journal of `id` holds; undefined without a journal. A line cut by a crash is skipped. */
  async sentCalls(id: string): Promise<SentCalls | undefined> {
    this.path(id);
    let text: string;
    try { text = await readFile(join(this.directory, `${id}.calls.jsonl`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    let sent: SentCalls | undefined;
    for (const line of text.split('\n')) {
      let row: unknown;
      try { row = line ? JSON.parse(line) : undefined; } catch { continue; }
      const { calls, spent } = (row ?? {}) as Partial<SentCalls>;
      if (!Number.isSafeInteger(calls) || calls! < 0) continue;
      sent = { calls: Math.max(sent?.calls ?? 0, calls!),
        ...(Number.isSafeInteger(spent) && spent! >= 0 ? { spent: Math.max(sent?.spent ?? 0, spent!) } : sent?.spent !== undefined ? { spent: sent.spent } : {}) };
    }
    return sent;
  }
  /**
   * Lab's own defects met by an operation on the record `id` — an SDK that threw instead of answering — each with its
   * stack, in `{id}.diagnostics.jsonl`: for whoever reports it, never shown to the owner as it is.
   */
  appendDiagnostic(id: string, defect: Error): void {
    this.assertWriting('Для записи журнала откройте лабораторию как писатель.');
    this.path(id);
    const cause = defect.cause;
    const line = { at: new Date().toISOString(), error: `${defect.name}: ${defect.message}`,
      ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.stack ?? `${cause.name}: ${cause.message}` : String(cause) }) };
    appendFileSync(join(this.directory, `${id}.diagnostics.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600, flush: true });
  }
  appendJudgment(id: string, trialId: string, audit: JudgeAudit): void {
    this.assertWriting('Для записи оценки откройте лабораторию как писатель.');
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
    this.assertWriting('Для записи оценки откройте лабораторию как писатель.');
    // The path check comes first: an unsafe id must be refused before anything touches the disk.
    const target = this.auditPath(id, folder, name);
    const content = JSON.stringify(judgeAuditSchema.parse(audit));
    mkdirSync(join(this.directory, `${id}.${folder}`), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(target, content);
    this.written(id, join(this.directory, `${id}.${folder}`));
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
  /** A stored library, read and checked afresh: the head, or the revision `hash` names. */
  readLibrary(id: string, hash?: string): Promise<ScenarioLibrary> { return new ScenarioFiles(this.directory).readLibrary(id, hash); }
  writeLibrary(library: ScenarioLibrary, expectedHash?: string): Promise<void> {
    return this.writeTransaction(() => this.files().writeLibrary(library, expectedHash));
  }

  /* ── publication: a library and its record written together, finished after a crash ── */
  /** Finish durable publication intents before accepting another mutation; readers remain lock-free. */
  recoverPublications(): Promise<void> { return this.writeTransaction(async () => {}); }
  private async recoverPendingPublications(): Promise<void> {
    const files = this.files();
    for (const { record, expectedHash } of await files.pendingPublications()) {
      const library = record.librarySnapshot!;
      const current = await files.readLibrary(library.id).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      if (!current || libraryHash(current) !== libraryHash(library)) await files.writeLibrary(library, expectedHash);
      await this.saveRecord(record);
      await files.finishPublication(record.id);
    }
  }
  /**
   * Saves a draft's library and its record together. Both are taken as they are at the call (see snapshot): the units
   * of a preparation go on changing the live record while this save waits its turn, and a saved record must never name
   * a card its saved library does not hold.
   */
  async publishLibrary(record: Experiment, library: ScenarioLibrary, expectedHash?: string): Promise<void> {
    const next = this.snapshot({ ...record, librarySnapshot: library });
    const published = next.librarySnapshot!;
    await this.writeTransaction(async () => {
      const files = this.files();
      await files.checkLibraryWrite(published, expectedHash);
      // The library is the head already (a step that changed only the record): the record alone is written, atomically.
      if (expectedHash === this.memo.admit(published).hash) { await this.saveRecord(next); return; }
      await files.retainLibrary(published);
      await files.writePublication(next, expectedHash);
      await files.writeLibrary(published, expectedHash ?? this.memo.admit(published).hash);
      await this.saveRecord(next);
      await files.finishPublication(next.id);
    });
  }
}
