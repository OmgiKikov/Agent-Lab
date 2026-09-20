import { prepareResolutionPolicy, verifyResolutionPolicy, resolutionDraftHash, evaluateResolution, applyResolution } from './resolution.js';
import type { ResolutionPolicy } from './resolution-contracts.js';
import { diagnosticFileSchema, verifyDiagnosticPlan, type DiagnosticFile, type DiagnosticPlan } from './diagnostics.js';
import { atomicPrivateJson } from './issues.js';
import { IssueFiles, syncIssues, decideIssueMerge, issueDecisionSchema, type Issue, type IssueDecision } from './issues.js';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { experimentSchema, judgeAuditSchema, type Experiment, type TraceEvent, type JudgeAudit } from './contracts.js';

import { libraryHash } from './scenario-library.js';
import { ScenarioFiles } from './scenario-store.js';
import type { ImportBatch, ScenarioLibrary } from './scenario-contracts.js';

const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
type LockOwner = { pid: number; token: string };
const busy = () => new Error('This data directory is already open in another Agent Lab instance. Просмотр и экспорт остаются доступны.');
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
  private diagnosticPath(id: string): string { if (!/^diag_[a-f0-9]{40}$/.test(id)) throw new Error('Неверный ID диагностики.'); return join(this.directory, 'diagnostics', `${id}.json`); }
  async readDiagnostic(id: string): Promise<DiagnosticFile> { const value = diagnosticFileSchema.parse(JSON.parse(await readFile(this.diagnosticPath(id), 'utf8'))); verifyDiagnosticPlan(value.plan); if (value.plan.id !== id) throw new Error('ID плана не совпадает.'); return value; }
  saveDiagnostic(value: DiagnosticFile): Promise<void> { return this.writeTransaction(async () => {
    const next = diagnosticFileSchema.parse(value); verifyDiagnosticPlan(next.plan);
    const existing = await this.readDiagnostic(next.plan.id).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    if (existing?.runId && existing.runId !== next.runId || existing?.result && JSON.stringify(existing.result) !== JSON.stringify(next.result)) throw new Error('Диагностика уже выполнена; сохранённый результат неизменяем.');
    await mkdir(join(this.directory, 'diagnostics'), { recursive: true, mode: 0o700 });
    await atomicPrivateJson(this.diagnosticPath(next.plan.id), next);
    const files = new IssueFiles(this.directory), current = await files.read(), issue = current.issues.find(i => i.id === next.plan.issueId);
    if (issue && !issue.experiments.includes(next.plan.id)) { issue.experiments.push(next.plan.id); if (!issue.hypotheses.includes(next.plan.intervention.hypothesis)) issue.hypotheses.push(next.plan.intervention.hypothesis); await files.write(current); }
  }); }
  async readResolution(id: string) {
    const file = (await new IssueFiles(this.directory).read()).resolutions.find(f => f.policy.id === id);
    if (!file) throw new Error('Политика закрытия не найдена.');
    verifyResolutionPolicy(file.policy); return file;
  }
  declareResolution(policy: ResolutionPolicy): Promise<void> { return this.writeTransaction(async () => {
    verifyResolutionPolicy(policy);
    const files = new IssueFiles(this.directory), journal = await files.read();
    const existing = journal.resolutions.find(f => f.policy.id === policy.id);
    if (existing) { if (existing.policy.ruleHash !== policy.ruleHash) throw new Error('Политика неизменна; нужны свежие прогоны обеих версий.'); return; }
    const issue = journal.issues.find(i => i.id === policy.issueId);
    if (!issue) throw new Error('Проблема не найдена.');
    const baseline = await this.get(policy.baselineRunId), candidate = await this.get(policy.candidateRunId);
    const previous = journal.resolutions.filter(f => f.policy.issueId === issue.id);
    if (previous.some(f => f.policy.baselineRunId === baseline.id || Date.parse(baseline.createdAt) <= Date.parse(f.policy.declaredAt))) throw new Error('Изменённая политика требует свежего сравнения ОБЕИХ версий, включая новую базу.');
    const checked = prepareResolutionPolicy({issueId:policy.issueId,baselineRunId:policy.baselineRunId,candidateRunId:policy.candidateRunId,reproducerIds:policy.reproducerIds,regressionIds:policy.regressionIds,stability:policy.stability},issue,baseline,candidate);
    if (checked.candidateDraftHash !== policy.candidateDraftHash || checked.baselineEvidenceHash !== policy.baselineEvidenceHash || checked.baselineIdentity !== policy.baselineIdentity || checked.candidateIdentity !== policy.candidateIdentity || JSON.stringify(checked.reproducer) !== JSON.stringify(policy.reproducer) || JSON.stringify(checked.regression) !== JSON.stringify(policy.regression)) throw new Error('Данные изменились до сохранения политики.');
    // A caller-supplied timestamp never establishes predeclaration: this writer observation does.
    journal.resolutions.push({policy}); issue.status = 'checking';
    issue.history.push({at:new Date().toISOString(),status:'checking',reason:`До запуска сохранена неизменная политика ${policy.id}.`,evidenceIds:[]});
    issue.experiments.push(policy.id); await files.write(journal);
  }); }
  /** Called from the normal start path, so CLI run cannot bypass an attached policy. */
  beginResolutionForRun(record: Experiment): Promise<void> { return this.writeTransaction(async () => {
    const files = new IssueFiles(this.directory), journal = await files.read();
    const declared = journal.resolutions.filter(f => f.policy.candidateRunId === record.id);
    for (const file of declared) {
      verifyResolutionPolicy(file.policy);
      if (file.startedAt || file.result || record.trials.length || record.phase !== 'review') throw new Error('Сравнение по политике уже запускалось.');
      if (resolutionDraftHash(record) !== file.policy.candidateDraftHash) throw new Error('Кандидат, набор или протокол изменён после объявления политики.');
      file.startedAt = new Date().toISOString();
    }
    if (declared.length) await files.write(journal);
  }); }
  finishResolution(id: string) { return this.writeTransaction(async () => {
    const files = new IssueFiles(this.directory), journal = await files.read();
    const file = journal.resolutions.find(f => f.policy.id === id);
    if (!file) throw new Error('Сначала сохраните политику до исполнения.');
    const index = journal.issues.findIndex(i => i.id === file.policy.issueId && !i.mergedInto);
    if (index < 0) throw new Error('Исходная проблема объединена; подготовьте новое сравнение для действующей проблемы.');
    if (file.result) return { ...file, issue: journal.issues[index]! };
    if (!file.startedAt) throw new Error('Нет сохранённого запуска по предварительной политике.');
    const before = await this.get(file.policy.baselineRunId), after = await this.get(file.policy.candidateRunId);
    if (['preparing','review','evaluating','baseline','improving','control'].includes(after.phase)) throw new Error('Кандидат ещё выполняется или не завершён; решение остаётся ожидающим.');
    const result = evaluateResolution(file.policy,before,after,{before,after});
    file.result=result; file.completedAt=new Date().toISOString(); journal.issues[index]=applyResolution(journal.issues[index]!,file.policy,result,file.completedAt);
    await files.write(journal); return {...file,issue:journal.issues[index]!};
  }); }
  async readIssues(): Promise<Issue[]> { return (await new IssueFiles(this.directory).read()).issues; }
  async readIssueJournal() { return new IssueFiles(this.directory).read(); }
  syncIssues(record: Experiment): Promise<Issue[]> { return this.writeTransaction(async () => {
    const files = new IssueFiles(this.directory), current = await files.read(), next = syncIssues(record, current.issues);
    await files.write({ ...current, ...next, suggestions: [...current.suggestions, ...next.suggestions].filter((s, i, all) => all.findIndex(x => x.issueId === s.issueId && x.candidateId === s.candidateId) === i) });
    return next.issues;
  }); }
  decideIssue(raw: IssueDecision): Promise<Issue[]> { return this.writeTransaction(async () => {
    const decision = issueDecisionSchema.parse(raw), files = new IssueFiles(this.directory), current = await files.read();
    const old = current.decisions.find(d => d.id === decision.id);
    if (old) { if (JSON.stringify(old) !== JSON.stringify(decision)) throw new Error('ID решения уже использован.'); return current.issues; }
    const issues = decideIssueMerge(current.issues, decision);
    await files.write({ ...current, issues, decisions: [...current.decisions, decision], suggestions: current.suggestions.filter(s => s.issueId !== decision.fromIssueId && s.candidateId !== decision.fromIssueId) });
    return issues;
  }); }
  rebuildIssues(): Promise<Issue[]> { return this.writeTransaction(async () => {
    const files = new IssueFiles(this.directory), current = await files.read();
    let issues = current.issues;
    for (const record of await this.list()) if (!['preparing', 'review', 'evaluating', 'baseline', 'improving', 'control'].includes(record.phase)) issues = syncIssues(record, issues).issues;
    await files.write({ ...current, issues }); return issues;
  }); }
  constructor(directory: string) { this.directory = resolve(directory); }
  private path(id: string): string {
    if (!idPattern.test(id)) throw new Error('Invalid experiment ID');
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
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy(); throw error; }
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
    if (alive(observed.pid)) throw busy();
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
        if (current.pid !== observed.pid || current.token !== observed.token || alive(current.pid)) throw busy();
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
    const target = this.path(validated.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(validated, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
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
    const ids = names.filter(n => n.endsWith('.json') && idPattern.test(n.slice(0, -5))).map(n => n.slice(0, -5));
    const results = await Promise.allSettled(ids.map(id => this.get(id)));
    const records: Experiment[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') records.push(result.value);
      else this.diagnostics.push({ id: ids[index]!, message: result.reason instanceof SyntaxError ? 'Некорректный JSON. Исходный файл сохранён.'
        : String(result.reason instanceof Error ? result.reason.message : result.reason).replace(/\s+/g, ' ').slice(0, 240) });
    });
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  appendTrace(id: string, trialId: string, event: TraceEvent): void {
    if (!this.lockToken) throw new Error('Для записи трассы откройте лабораторию как писатель.');
    this.path(id);
    if (!idPattern.test(trialId)) throw new Error('Invalid trial ID');
    appendFileSync(join(this.directory, `${id}.trace.jsonl`), `${JSON.stringify({ trialId, event })}\n`, { mode: 0o600 });
  }
  async traceJournal(id: string): Promise<string> {
    this.path(id);
    try { return await readFile(join(this.directory, `${id}.trace.jsonl`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
  appendJudgment(id: string, trialId: string, audit: JudgeAudit): void {
    if (!this.lockToken) throw new Error('Для записи оценки откройте лабораторию как писатель.');
    this.path(id);
    if (!idPattern.test(trialId)) throw new Error('Invalid trial ID');
    // The existing evidence journal also survives interruption during assessment.
    appendFileSync(join(this.directory, `${id}.trace.jsonl`), `${JSON.stringify({ trialId, judgeAudit: judgeAuditSchema.parse(audit) })}\n`, { mode: 0o600, flush: true });
  }
  /** Full audit of one trial's judgment in `{id}.judge/{trialId}.json`, replaced atomically on every call. */
  private judgeAuditPath(id: string, trialId: string): string {
    this.path(id);
    if (!idPattern.test(trialId)) throw new Error('Invalid trial ID');
    return join(this.directory, `${id}.judge`, `${trialId}.json`);
  }
  // Synchronous on purpose: onJudgment is synchronous, and a crash must leave the last complete audit on disk.
  writeJudgeAudit(id: string, trialId: string, audit: JudgeAudit): void {
    if (!this.lockToken) throw new Error('Для записи оценки откройте лабораторию как писатель.');
    const target = this.judgeAuditPath(id, trialId);
    const content = JSON.stringify(judgeAuditSchema.parse(audit));
    mkdirSync(join(this.directory, `${id}.judge`), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, target);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* the temporary file was never created or already renamed */ }
      throw error;
    }
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
