import type { GeneratorEvidence } from './generator-evidence.js';
import { fingerprint } from './contracts.js';
import { writeFileAtomic, writeFileAtomicSync } from './fs-atomic.js';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { experimentSchema, judgeAuditSchema, type Experiment, type TraceEvent, type JudgeAudit } from './contracts.js';

import { libraryHash } from './scenario-library.js';
import { ScenarioFiles } from './scenario-store.js';
import { oneLine } from './text.js';
import { isIdentifier } from './ids.js';
import { LockedError } from './errors.js';
import type { ImportBatch, ScenarioLibrary } from './scenario-contracts.js';

type LockOwner = { pid: number; token: string };
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}
export class ExperimentStore {
  readonly directory: string;
  diagnostics: { id: string; message: string }[] = [];
  private lockToken: string | null = null;
  private writerQueue: Promise<unknown> = Promise.resolve();
  private async writeTransaction<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writerQueue.then(async () => {
      if (!this.lockToken) throw new Error('Для изменения записи откройте лабораторию как писатель.');
      await this.recoverPendingPublications();
      return work();
    });
    this.writerQueue = pending.catch(() => {});
    return pending;
  }
  readImport(id: string): Promise<ImportBatch> { return new ScenarioFiles(this.directory).readImport(id); }
  writeImport(batch: ImportBatch): Promise<ImportBatch> { return this.writeTransaction(() => new ScenarioFiles(this.directory).writeImport(batch)); }
  readLibrary(id: string, hash?: string): Promise<ScenarioLibrary> { return new ScenarioFiles(this.directory).readLibrary(id, hash); }
  writeLibrary(library: ScenarioLibrary, expectedHash?: string): Promise<void> {
    return this.writeTransaction(() => new ScenarioFiles(this.directory).writeLibrary(library, expectedHash));
  }
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
  constructor(directory: string) { this.directory = resolve(directory); }
  private path(id: string): string {
    if (!isIdentifier(id)) throw new Error('Invalid experiment ID');
    return join(this.directory, `${id}.json`);
  }
  private async owner(): Promise<LockOwner | null> {
    const lockPath = join(this.directory, '.lock');
    let raw: unknown;
    try { raw = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!raw || typeof raw !== 'object' || !('pid' in raw) || typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0
      || !('token' in raw) || typeof raw.token !== 'string' || !raw.token) {
      throw new Error(`Некорректный lock: ${lockPath}. Исходный файл сохранён; проверьте владельца перед восстановлением.`);
    }
    return { pid: raw.pid, token: raw.token };
  }
  private async acquire(): Promise<void> {
    const path = join(this.directory, '.lock');
    let lock;
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LockedError(); throw error; }
    const token = randomUUID();
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, token })); this.lockToken = token; }
    catch (error) { await unlink(path); throw error; }
    finally { await lock.close(); }
  }
  /** Only writers initialize; atomic records and the journal can be read without owning the lock. */
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const observed = await this.owner();
    if (!observed) { await this.acquire(); try { await this.recoverPublications(); } catch (error) { await this.close(); throw error; } return; }
    if (alive(observed.pid)) throw new LockedError();
    // ponytail: one recovery gate per local directory; ambiguous gates need manual inspection, not recursive lock recovery.
    const recoveryPath = join(this.directory, '.recovery');
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Восстановление уже занято: ${recoveryPath}. Если предыдущий процесс завершился, проверьте этот файл; действующий lock не изменён.`);
      throw error;
    }
    try {
      await recovery.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
      const current = await this.owner();
      if (current) {
        if (current.pid !== observed.pid || current.token !== observed.token || alive(current.pid)) throw new LockedError();
        await unlink(join(this.directory, '.lock'));
      }
      await this.acquire();
      await this.recoverPublications();
    } finally {
      try { await recovery.close(); } finally { await unlink(recoveryPath); }
    }
  }
  async close(): Promise<void> {
    await this.writerQueue;
    if (!this.lockToken) return;
    const token = this.lockToken;
    this.lockToken = null;
    const lockPath = join(this.directory, '.lock');
    const owner = await this.owner();
    if (owner?.token === token) await unlink(lockPath);
  }
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
  /** Full audit of one trial's judgment in `{id}.judge/{trialId}.json`, replaced atomically on every call. */
  private judgeAuditPath(id: string, trialId: string): string {
    this.path(id);
    if (!isIdentifier(trialId)) throw new Error('Invalid trial ID');
    return join(this.directory, `${id}.judge`, `${trialId}.json`);
  }
  // Synchronous on purpose: onJudgment is synchronous, and a crash must leave the last complete audit on disk.
  writeJudgeAudit(id: string, trialId: string, audit: JudgeAudit): void {
    if (!this.lockToken) throw new Error('Для записи оценки откройте лабораторию как писатель.');
    // The path check comes first: an unsafe id must be refused before anything touches the disk.
    const target = this.judgeAuditPath(id, trialId);
    const content = JSON.stringify(judgeAuditSchema.parse(audit));
    mkdirSync(join(this.directory, `${id}.judge`), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(target, content);
  }
  async readJudgeAudit(id: string, trialId: string): Promise<JudgeAudit | null> {
    const target = this.judgeAuditPath(id, trialId);
    let file;
    try { file = await open(target, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      if ((await file.stat()).size > 20_000_000) throw new Error('Judge audit exceeds 20 MB');
      return judgeAuditSchema.parse(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  }
}
