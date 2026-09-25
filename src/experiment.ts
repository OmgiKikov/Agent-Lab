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
import { isRunning } from './phases.js';
import { markInterrupted } from './lab/interrupted.js';
import * as review from './lab/review.js';
import * as judgeCheck from './lab/judge-check.js';
import type { JudgeCheck, JudgeCheckPlan } from './judge-check.js';
import * as run from './lab/run.js';
import { createPiRuntime } from './pi.js';
import { ExperimentStore } from './store.js';
import { adoptAgentRegistry } from './agent-processes.js';

/*
 * Agent Lab's engine over one data folder, with one writer at a time. The surfaces — Pi's tools and workspace, the CLI —
 * call these operations and nothing below them. The work itself lives in lab/, every move of a record's phase checked
 * against the phase table (phases.ts):
 *
 *   record.ts     the hashes a record is sealed by; new drafts and fresh copies
 *   operation.ts  the one long operation at a time: budget, time, checkpoints, and the followers told of each change
 *   library.ts    situations: prepare, check, change by the owner's commands, accept
 *   run.ts        a run: the draft it starts from, the owner's confirmation, the dialogues
 *   review.ts     results: a re-assessment, a person's verdicts — on the run's conversations and on the logged ones
 *   judge-check.ts the judge checked with planted errors and untouched controls, beside the run
 */
export class ExperimentLab {
  readonly store: ExperimentStore;
  private readonly operations: OperationRunner;
  private readonly lab: Lab;
  private initializing: Promise<void> | undefined;
  /** Fresh drafts the owner sees before anything is written (Lab.preview): gone with this lab, written by their first change. */
  private readonly previews = new Map<string, Experiment>();
  constructor(directory: string, private readonly injectedRuntime?: Runtime) {
    this.store = new ExperimentStore(directory);
    this.operations = new OperationRunner(this.store);
    this.lab = { store: this.store, operations: this.operations, get: id => this.get(id), list: () => this.list(), runtime: record => this.runtime(record),
      preview: record => { this.previews.set(record.id, structuredClone(record)); } };
  }

  /**
   * Opens the folder as its writer. A record a previous process left running goes where its phase's restart rule says
   * (phases.ts), its evidence kept and the calls it sent after its last checkpoint counted (lab/interrupted.ts): a draft
   * whose check was cut short is the owner's draft again, anything else is marked interrupted.
   */
  init(): Promise<void> {
    if (this.operations.closing) return Promise.reject(new Error('Лаборатория закрывается.'));
    return this.initializing ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    await this.store.init();
    try {
      // The agents a Lab killed outright left running end now; this Lab's own are kept in the folder it writes (agent-processes.ts).
      // A safety net, never a reason the folder does not open.
      await adoptAgentRegistry(this.store.directory).catch(() => {});
      for (const record of await this.store.list()) if (isRunning(record.phase)) {
        markInterrupted(record, await this.store.sentCalls(record.id));
        record.updatedAt = new Date().toISOString(); await this.store.save(record);
      }
      this.operations.open();
    } catch (error) { await this.store.close(); throw error; }
  }

  /** A record as it is now: the running one's live copy, the stored file, or — until a change writes it — a fresh draft this lab previews. */
  async get(id: string): Promise<Experiment> {
    const running = this.operations.snapshot(id);
    if (running) return running;
    const preview = this.previews.get(id);
    if (!preview) return this.store.get(id);
    try {
      const written = await this.store.get(id);
      this.previews.delete(id);
      return written;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return structuredClone(preview);
    }
  }
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
  /** The draft an owner command goes to; `preview`: a fresh copy of a finished run, written only with the change applied to it. */
  editableCards(id: string): Promise<{ id: string; copiedFrom?: string; preview?: true }> { return library.editableCards(this.lab, id); }
  prepareCardCommand(id: string, command: CardCommand, options: { via: Via; ownerWords?: string }): Promise<Prepared> { return library.prepareCardCommand(this.lab, id, command, options); }
  applyCardCommand(id: string, prepared: Prepared, grant: HostGrant): Promise<{ library: LibraryV2; experiment: Experiment }> { return library.applyCardCommand(this.lab, id, prepared, grant); }
  /** Lab's plausible values over one card's masking marks, as the command the owner confirms; one model call, nothing written to the draft. */
  proposeFill(id: string, cardId: string): Promise<Extract<CardCommand, { kind: 'fill_masked' }>> { return library.proposeFill(this.lab, id, cardId); }
  recheckCards(id: string, options?: { defer?: boolean; expectedHash?: string; explicit?: boolean }) { return library.recheckCards(this.lab, id, options); }
  prepareLogVersion(command: LogVersionCommand, options: { via: Via; at?: string }): Promise<PreparedLogVersion> { return library.prepareLogVersion(this.lab, command, options); }
  applyLogVersion(prepared: PreparedLogVersion, grant: HostGrant): Promise<LogVersionJournal> { return library.applyLogVersion(this.lab, prepared, grant); }
  resumePreparation(id: string, expectedHash: string, options?: library.ResumeOptions): Promise<Experiment> { return library.resumePreparation(this.lab, id, expectedHash, options); }
  queueVariations(id: string, expectedHash: string): Promise<{ experiment: Experiment; queued: { scenario: string; variation: string }[] }> { return library.queueVariations(this.lab, id, expectedHash); }
  convertV1Draft(id: string): Promise<Pick<Conversion, 'library' | 'left' | 'calls'> & { experiment: Experiment }> { return library.convertV1Draft(this.lab, id); }

  updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> { return run.updateDraft(this.lab, id, expectedHash, raw); }
  acceptDraft(id: string, expectedHash: string): Promise<Experiment> { return run.acceptDraft(this.lab, id, expectedHash); }
  /** A fresh draft of a run's accepted set; `preview`: shown before anything is written, written by its first change (Lab.preview). */
  repeat(id: string, scenarioIds?: string[], controlScenarioIds?: string[], options?: run.RepeatOptions): Promise<Experiment> { return run.repeat(this.lab, id, scenarioIds, controlScenarioIds, options); }
  saveSuite(id: string, file: string, scenarioIds?: string[], options?: { replace?: boolean }): Promise<string> { return run.saveSuite(this.lab, id, file, scenarioIds, options); }
  loadSuite(file: string, scenarioIds?: string[], connection?: Connection): Promise<Experiment> { return run.loadSuite(this.lab, file, scenarioIds, connection); }
  start(id: string, options: run.StartOptions): Promise<Experiment> { return run.start(this.lab, id, options); }

  reassess(id: string, raw?: ReassessmentInput, options?: { carryUsage?: boolean }): Promise<Experiment> { return review.reassess(this.lab, id, raw, options); }
  addHumanReview(id: string, raw: HumanReviewInput): Promise<Experiment> { return review.addHumanReview(this.lab, id, raw); }
  /** The owner's verdict on the judge's reading of a logged conversation (`log:{key}` of the run's calibration): kept beside the receipt, never over it. */
  addLogReview(id: string, raw: review.LogReviewInput): Promise<Experiment> { return review.addLogReview(this.lab, id, raw); }
  reviewResults(id: string, expectedHash: string): Promise<Experiment> { return review.reviewResults(this.lab, id, expectedHash); }
  /** How many calls a judge check of a finished run would take, and what it samples; spends nothing. */
  planJudgeCheck(id: string, options?: judgeCheck.JudgeCheckOptions): Promise<JudgeCheckPlan> { return judgeCheck.planJudgeCheck(this.lab, id, options); }
  /** Plants errors into copies of the run's dialogues and re-judges them: the result is the run's sidecar, the run never changes. */
  checkJudge(id: string, options?: judgeCheck.JudgeCheckOptions): Promise<JudgeCheck> { return judgeCheck.checkJudge(this.lab, id, options); }

  /** Stops the operation running `id`; what it recorded is kept. */
  async cancel(id: string): Promise<Experiment> { return this.operations.cancel(id) ?? this.store.get(id); }
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
