import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { Experiment } from '../src/contracts.js';
import type { ExperimentLab } from '../src/experiment.js';
import type { Background } from './background.ts';
import type { LabLease, SessionOperations } from './operations.ts';
import type { Feed } from './render/feed.ts';

/**
 * What every Agent Lab tool and the workspace of one Pi session share: the writer lease, the long work of the session
 * and how an answer reaches the owner and the model. Each tool module takes the parts it needs; nothing here remembers
 * the conversation — which run a request means is read from the records (records.ts).
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
  feedResult(callId: string, output: unknown, feed: Feed, note: string): AgentToolResult<unknown>;
  /** An owner question as an ordinary result: the feed shows what to clarify, the model is told not to guess. */
  askOwner(callId: string, error: unknown): AgentToolResult<unknown>;
  /** The result of a finished run: the model's JSON and the details its block is drawn from. */
  verdictOutput(record: Experiment, lab: ExperimentLab): Promise<{ output: unknown; details: unknown }>;
  /** A check too long for the row of its change. */
  backgroundCheck(ctx: Parameters<Background['check']>[0], owned: LabLease, id: string, card: number | undefined): void;
}
