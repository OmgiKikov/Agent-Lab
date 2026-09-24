import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { Experiment } from '../src/contracts.js';
import type { ExperimentLab } from '../src/experiment.js';
import type { Background } from './background.ts';
import type { LabLease, SessionOperations } from './operations.ts';
import type { Feed } from './render/feed.ts';

/** What reads the lists the owner was shown back from a reopened session. */
export type ShownReader = { sessionManager?: { getEntries?: () => unknown[] } };

/**
 * What every Agent Lab tool of one Pi session shares: the writer lease, the long work of the session, the run the
 * conversation works on and the lists the owner was shown. The tool modules take the parts they need.
 */
export interface LabHost {
  inlineRunMs: number;
  inlineCheckMs: number;
  inlineBuildMs: number;
  operations: SessionOperations;
  background: Background;
  open(cwd: string, pendingCheck?: 'cancel' | 'wait'): Promise<LabLease>;
  /** The live executor when this session owns the folder, otherwise the durable record. */
  reading(directory: string): ExperimentLab;
  /** The run a request means: an id, a short id, task words, or — with no reference — the run this conversation works on. */
  findRun(directory: string, ref?: string, ctx?: ShownReader): Promise<Experiment>;
  /** The run this conversation last worked on, per data directory: a default for «запусти», never a store of its own. */
  focus: Map<string, string>;
  feedResult(callId: string, output: unknown, feed: Feed, note: string): AgentToolResult<unknown>;
  /** An owner question as an ordinary result: the feed shows what to clarify, the model is told not to guess. */
  askOwner(callId: string, error: unknown): AgentToolResult<unknown>;
  rememberShown(kind: 'runs' | 'failures', key: string, ids: string[]): void;
  recallShown(ctx: ShownReader | undefined, kind: 'runs' | 'failures', key: string): string[] | undefined;
  /** The result of a finished run: the model's JSON and the details its block is drawn from. */
  verdictOutput(record: Experiment, lab: ExperimentLab): Promise<{ output: Record<string, unknown>; details: unknown }>;
  /** A check too long for the row of its command. */
  backgroundCheck(ctx: Parameters<Background['check']>[0], owned: LabLease, id: string, card: number | undefined): void;
  /** A continued preparation. */
  backgroundPreparation(ctx: Parameters<Background['preparation']>[0], owned: LabLease, id: string): void;
}
