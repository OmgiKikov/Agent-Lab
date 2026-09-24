import type { LogVersionCommand, LogVersionJournal } from './card/calibration.js';
import type { CardEvidence } from './card/checks.js';
import type { HostGrant, Prepared, PreparedLogVersion, Via } from './card/commands.js';
import type { Conversion } from './card/convert.js';
import type { CardCommand, LibraryV2 } from './card/schema.js';
import type { DialogueNumbers } from './card/view.js';
import type { Connection } from './connection.js';
import type { CreateInput, DraftPatch, Experiment, HumanReviewInput, ReassessmentInput, Settings } from './contracts.js';
import type { Runtime } from './runtime.js';
import { createDemoRuntime } from './demo.js';
import { captureGeneratorEvidence } from './generator-evidence.js';
import type { Lab } from './lab/context.js';
import * as library from './lab/library.js';
import { OperationRunner, type Follower } from './lab/operation.js';
import { isRunning, moveTo } from './phases.js';
import * as review from './lab/review.js';
import * as run from './lab/run.js';
import { createPiRuntime } from './pi.js';
import { ExperimentStore } from './store.js';

/*
 * Agent Lab's engine over one data folder, with one writer at a time. The surfaces — Pi's tools and workspace, the CLI —
 * call these operations and nothing below them. The work itself lives in lab/, every move of a record's phase checked
 * against the phase table (phases.ts):
 *
 *   record.ts     the hashes a record is sealed by; new drafts and fresh copies
 *   operation.ts  the one long operation at a time: budget, time, checkpoints, and the followers told of each change
 *   library.ts    situations: prepare, check, change by the owner's commands, accept
 *   run.ts        a run: the draft it starts from, the owner's confirmation, the dialogues
 *   review.ts     results: a re-assessment, a person's verdicts
 */
export class ExperimentLab {
  readonly store: ExperimentStore;
  private readonly operations: OperationRunner;
  private readonly lab: Lab;
  private initializing: Promise<void> | undefined;
  constructor(directory: string, private readonly injectedRuntime?: Runtime) {
    this.store = new ExperimentStore(directory);
    this.operations = new OperationRunner(this.store);
    this.lab = { store: this.store, operations: this.operations, get: id => this.get(id), list: () => this.list(), runtime: record => this.runtime(record) };
  }

  /** Opens the folder as its writer; records a previous process left running are marked interrupted, their evidence kept. */
  init(): Promise<void> {
    if (this.operations.closing) return Promise.reject(new Error('Experiment Lab is closing.'));
    return this.initializing ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    await this.store.init();
    try {
      for (const record of await this.store.list()) if (isRunning(record.phase)) {
        moveTo(record, 'interrupted'); record.message = 'Предыдущий процесс остановился. Собранные данные сохранены.';
        record.usage.costUsd = null;
        record.limitations.push('Процесс остановился между сохранениями: число вызовов и токенов может быть неполным.');
        record.error = record.message; record.updatedAt = new Date().toISOString(); await this.store.save(record);
      }
      this.operations.open();
    } catch (error) { await this.store.close(); throw error; }
  }

  async get(id: string): Promise<Experiment> { return this.operations.snapshot(id) ?? this.store.get(id); }
  async list(): Promise<Experiment[]> {
    const records = await this.store.list();
    return records.map(record => this.operations.snapshot(record.id) ?? record);
  }
  /** Follows the running operation: `follower` is told of every change of its record as it happens; returns how to stop. */
  follow(follower: Follower): () => void { return this.operations.follow(follower); }

  create(raw: CreateInput, options?: library.CreateOptions): Promise<Experiment> { return library.create(this.lab, raw, options); }
  readCards(id: string): Promise<{ library: LibraryV2; experiment: Experiment }> { return library.readCards(this.lab, id); }
  acceptCards(id: string, expectedHash: string, cardIds: string[]): Promise<{ library: LibraryV2; experiment: Experiment }> { return library.acceptCards(this.lab, id, expectedHash, cardIds); }
  checkCards(id: string, expectedHash: string): Promise<Experiment> { return library.checkCards(this.lab, id, expectedHash); }
  cardContext(id: string): Promise<{ experiment: Experiment; library: LibraryV2; evidence: CardEvidence; numbers: DialogueNumbers }> { return library.cardContext(this.lab, id); }
  editableCards(id: string): Promise<{ id: string; copiedFrom?: string }> { return library.editableCards(this.lab, id); }
  prepareCardCommand(id: string, command: CardCommand, options: { via: Via; ownerWords?: string }): Promise<Prepared> { return library.prepareCardCommand(this.lab, id, command, options); }
  applyCardCommand(id: string, prepared: Prepared, grant: HostGrant): Promise<{ library: LibraryV2; experiment: Experiment }> { return library.applyCardCommand(this.lab, id, prepared, grant); }
  recheckCards(id: string, options?: { defer?: boolean; expectedHash?: string; explicit?: boolean }) { return library.recheckCards(this.lab, id, options); }
  prepareLogVersion(command: LogVersionCommand, options: { via: Via; at?: string }): Promise<PreparedLogVersion> { return library.prepareLogVersion(this.lab, command, options); }
  applyLogVersion(prepared: PreparedLogVersion, grant: HostGrant): Promise<LogVersionJournal> { return library.applyLogVersion(this.lab, prepared, grant); }
  resumePreparation(id: string, expectedHash: string, options?: library.PreparationOptions): Promise<Experiment> { return library.resumePreparation(this.lab, id, expectedHash, options); }
  convertV1Draft(id: string): Promise<Pick<Conversion, 'library' | 'left' | 'calls'> & { experiment: Experiment }> { return library.convertV1Draft(this.lab, id); }

  updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> { return run.updateDraft(this.lab, id, expectedHash, raw); }
  acceptDraft(id: string, expectedHash: string): Promise<Experiment> { return run.acceptDraft(this.lab, id, expectedHash); }
  repeat(id: string, scenarioIds?: string[], controlScenarioIds?: string[]): Promise<Experiment> { return run.repeat(this.lab, id, scenarioIds, controlScenarioIds); }
  saveSuite(id: string, file: string, scenarioIds?: string[]): Promise<string> { return run.saveSuite(this.lab, id, file, scenarioIds); }
  loadSuite(file: string, scenarioIds?: string[], connection?: Connection): Promise<Experiment> { return run.loadSuite(this.lab, file, scenarioIds, connection); }
  start(id: string, options: run.StartOptions): Promise<Experiment> { return run.start(this.lab, id, options); }

  reassess(id: string, raw?: ReassessmentInput, options?: { carryUsage?: boolean }): Promise<Experiment> { return review.reassess(this.lab, id, raw, options); }
  addHumanReview(id: string, raw: HumanReviewInput): Promise<Experiment> { return review.addHumanReview(this.lab, id, raw); }
  reviewResults(id: string, expectedHash: string): Promise<Experiment> { return review.reviewResults(this.lab, id, expectedHash); }

  /** Stops the operation running `id`; what it recorded is kept. */
  async cancel(id: string): Promise<Experiment> { return this.operations.cancel(id); }
  /** Resolves when the running operation has ended and its last checkpoint is saved. */
  async waitForIdle(): Promise<void> { await this.operations.idle(); }
  async close(): Promise<void> {
    this.operations.shutdown();
    try { await this.initializing; await this.operations.settled(); } finally { await this.store.close(); }
  }

  /** The models of a step outside any run — reading a spreadsheet of logs before preparing: the injected runtime, else Pi's for `settings`. */
  modelRuntime(settings: Settings): Promise<Runtime> { return this.injectedRuntime ? Promise.resolve(this.injectedRuntime) : createPiRuntime(settings); }

  private async runtime(record: Experiment): Promise<Runtime> {
    const runtime = this.injectedRuntime ?? (record.mode === 'demo' ? createDemoRuntime() : await createPiRuntime(record.settings));
    return captureGeneratorEvidence(runtime, event => this.store.appendGeneratorEvidence(record.id, event));
  }
}
