import { z } from 'zod';
import type { JudgeAudit, MetricAssessment } from './assessment.js';
import type { LogJudge } from './card/calibration.js';
import type { CardProposal, CardProposalRequest } from './card/proposal.js';
import type { CardReview, CardReviewRequest } from './card/review.js';
import type { FailureMode, Requirement, Scenario, Source, TraceEvent, Trial, Usage } from './contracts.js';
import { identifierSchema as identifier } from './ids.js';
import type { BuilderModel, TopicMap, TopicMapPlan, TopicMapProgress } from './miner/topic-map.js';
import type { TableReader } from './spreadsheet/reading-task.js';
import type { AllowedUserAction, UserDecision, UserView } from './user-controller.js';

/*
 * What the engine asks of the world outside it: a model for every role (Runtime), the agent under test (TargetSession),
 * and the context every call is made in — its budget, its time limit and the evidence callbacks (CallContext). The
 * Pi runtime (pi.ts), the teaching example (demo.ts) and the tests each provide their own.
 */

export interface CallContext {
  onGeneratorTransport?(transport:{role:string;provider:string;model:string;api:string;requestedTemperature?:number;effectiveTemperature:number|'provider-default'}):void;
  onGeneratorOutput?(response:{role:string;text:string;attempt?:number;incomplete?:boolean}):void;
  onGeneratorValidation?(validation:{attempt:number;accepted:boolean;reason?:string;outcome?:'syntax'|'schema'|'domain'}):void;
  signal: AbortSignal; timeoutMs: number;
  beforeCall(): void;
  addUsage(usage: Omit<Usage, 'calls'>): void;
  onTrace?(trialId: string, event: TraceEvent): void;
  onTargetEvent?(event: Omit<TraceEvent, 'seq'>): void;
  /** Called on every audit change; final is true exactly once, after the last vote of this judgment settled. */
  onJudgment?(trialId: string, audit: JudgeAudit, final?: boolean): void;
}
export interface DialogueMessage { role: 'user' | 'assistant'; content: string }
export interface TargetSession { respond(message: string): Promise<string>; close(): Promise<void> }
export const userTurnSchema = z.strictObject({ done: z.boolean(), message: z.string().max(6000) }).refine(v => v.done || v.message.trim().length > 0, 'Empty user message');
export type UserTurn = z.infer<typeof userTurnSchema>;
export interface GroundingInput {
  task: string; sources: Source[];
  /** Ground only the rules that decide one dialogue: the customer's own messages, never the old agent's replies. */
  focus?: { dialogueId: string; customerMessages: string[] };
}
export interface Grounding { requirements: Requirement[]; questions: string[] }
export interface SourceSelectionInput {
  task: string;
  /** Knowledge articles only, titles and sizes; prompt sources are always included and are not offered. */
  catalog: Array<{ id: string; name: string; chars: number }>;
  dialogue: { id: string; messages: DialogueMessage[] };
  limit: number;
  /** A bounded second reading can revise the title-based shortlist. Unread articles are not certified as checked. */
  reading?: { sources: Source[]; selectedSourceIds: string[]; unreadSourceIds: string[] };
}
export const sourceSelectionSchema = z.strictObject({ sourceIds: z.array(identifier).max(40) });
export type SourceSelection = z.infer<typeof sourceSelectionSchema>;
export interface Runtime {
  generatorTransport?:'pi-model'|'deterministic-test';
  /** The controlled customer's next move: one of `actions`, the moves allowed right now. The harness renders the message. */
  selectUserAction?(input: { user: UserView; state: string; actions: AllowedUserAction[]; messages: DialogueMessage[]; turn: number }, ctx: CallContext): Promise<UserDecision>;
  /** One card from one dialogue or from the owner's rules alone; every reference in the answer is an enum of this call. */
  proposeCard?(input: CardProposalRequest, ctx: CallContext): Promise<CardProposal>;
  /** The independent reviewer's verdict on each listed claim of one card, and the model that gave it. */
  reviewCard?(input: CardReviewRequest, ctx: CallContext): Promise<CardReview>;
  /** Owner requirements with exact quotes from the supplied sources, and the business questions they leave open. */
  groundRequirements?(input: GroundingInput, ctx: CallContext): Promise<Grounding>;
  /** The free LLM user of scenarios without an `execution` block: recorded runs made before the scenario library. */
  userTurn?(input: { user: Scenario['user']; messages: DialogueMessage[]; turn: number }, ctx: CallContext): Promise<UserTurn>;
  assess?(input: { scenario: Scenario; sources: Source[]; trial: Trial }, ctx: CallContext): Promise<MetricAssessment[]>;
  /** The same judge on a recorded conversation (card/log-judge.ts): one expectation, two votes, a receipt of its own. */
  logJudge?: LogJudge;
  /** Which articles of a large knowledge base one dialogue needs: the model reads the table of contents, never the bodies. */
  selectSources?(input: SourceSelectionInput, ctx: CallContext): Promise<SourceSelection>;
  /** The topic map of an import (miner/topic-map.ts), built by `builder` from a plan made for it; each finished step reaches `onProgress` before the next call. */
  topicMap?: { builder: BuilderModel; build(plan: TopicMapPlan, ctx: CallContext, onProgress: (progress: TopicMapProgress) => Promise<void>): Promise<TopicMap> };
  /** How a spreadsheet of logs reads (spreadsheet/reading-task.ts): proposed by `builder` from a few rows, checked on every row. */
  tableReading?: TableReader;
  failureModes?(input: { task: string; failures: { trialId: string; card: string; reason: string; failed: string[]; trace: string }[]; prompt?: string }, ctx: CallContext): Promise<FailureMode[]>;
}
