import { z } from 'zod';
import type { JudgeAudit, MetricAssessment } from './assessment.js';
import type { LogJudge } from './card/calibration.js';
import type { ErrorPlanter } from './judge-check-task.js';
import type { CardProposal, CardProposalRequest } from './card/proposal.js';
import type { PlanProposal, PlanRequest } from './card/plan.js';
import type { FitAnswer, FitRequest } from './discover/fit.js';
import type { FactChecker } from './discover/facts.js';
import type { CardReview, CardReviewRequest } from './card/review.js';
import type { MaskFiller } from './card/unmask.js';
import type { FailureMode, Scenario, Source, TraceEvent, Trial, Usage } from './contracts.js';
import { identifierSchema as identifier } from './ids.js';
import type { BuilderModel, TopicMap, TopicMapPlan, TopicMapProgress } from './miner/topic-map.js';
import type { PurposeReader } from './prompt-purpose.js';
import type { ConnectionReader } from './connect.js';
import type { TableReader } from './spreadsheet/reading-task.js';
import type { AllowedUserAction, UserDecision, UserView } from './user-controller.js';
import type { CustomerBrief, CustomerReply, OfferedButton } from './card-customer.js';
import type { CutOff } from './judge.js';

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
  /**
   * A defect of Lab or its SDK met by a call (llm/model-call.ts ModelCallDefect), before it is thrown: the operation writes
   * it, with its stack, to its journal. Without it the error output gets it.
   */
  onDefect?(defect: Error): void;
}
export interface DialogueMessage { role: 'user' | 'assistant'; content: string }
/** A button of the agent's last reply the customer pressed: its place in that reply, its text as shown, the value the adapter gave it. */
export interface ButtonChoice { index: number; text: string; value?: string }
/** `choice` is set when the message is a press of one of the buttons the agent's last reply offered. */
export interface TargetSession { respond(message: string, options?: { choice?: ButtonChoice }): Promise<string>; close(): Promise<void> }
export const userTurnSchema = z.strictObject({ done: z.boolean(), message: z.string().max(6000) }).refine(v => v.done || v.message.trim().length > 0, 'Empty user message');
export type UserTurn = z.infer<typeof userTurnSchema>;
export interface SourceSelectionInput {
  task: string;
  /** Articles by title and size; the agent's prompts are never in it — every proposal reads them all (card/prepare.ts). */
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
  /** A card's customer in their own words (card-customer.ts): the next move and message; the harness checks it before the agent sees it. */
  speakAsCustomer?(input: { brief: CustomerBrief; messages: DialogueMessage[]; turn: number; turned: boolean; buttons?: OfferedButton[] }, ctx: CallContext): Promise<CustomerReply>;
  /** One card from one dialogue or from the owner's rules alone; every reference in the answer is an enum of this call. */
  proposeCard?(input: CardProposalRequest, ctx: CallContext): Promise<CardProposal>;
  /** The business scenario of one topic, before its cards (card/plan.ts): a proposal the harness checks and binds. */
  proposeScenario?(input: PlanRequest, ctx: CallContext): Promise<PlanProposal>;
  /**
   * Which variation of a topic's plan each of the topic's other conversations is in, or none (discover/fit.ts): the builder
   * reads the customers' words; every reference of the answer is an enum of the call.
   */
  fitConversations?(input: FitRequest, ctx: CallContext): Promise<FitAnswer>;
  /** The independent reviewer's verdict on each listed claim of one card, and the model that gave it. */
  reviewCard?(input: CardReviewRequest, ctx: CallContext): Promise<CardReview>;
  /** The free LLM user of scenarios without an `execution` block: recorded runs made before the scenario library. */
  userTurn?(input: { user: Scenario['user']; messages: DialogueMessage[]; turn: number }, ctx: CallContext): Promise<UserTurn>;
  /** The judge of one dialogue; `cutOff`: the agent's side broke it before its end, and it is judged up to the break (judge.ts assessCutOff). */
  assess?(input: { scenario: Scenario; sources: Source[]; trial: Trial; cutOff?: CutOff }, ctx: CallContext): Promise<MetricAssessment[]>;
  /** The same judge on a recorded conversation (card/log-judge.ts): one expectation, two votes, a receipt of its own. */
  logJudge?: LogJudge;
  /** Actual factual statements compared with reference articles, without inferring duties from employee scripts. */
  factChecker?: FactChecker;
  /** The builder's planted errors of a judge check (judge-check-task.ts): one agent reply rewritten so one expectation is broken. */
  plantError?: ErrorPlanter;
  /** The builder's plausible values over the masking marks of one existing card (card/unmask.ts), made into a command the owner confirms. */
  maskFill?: MaskFiller;
  /** Which articles of a large knowledge base one dialogue needs: the model reads the table of contents, never the bodies. */
  selectSources?(input: SourceSelectionInput, ctx: CallContext): Promise<SourceSelection>;
  /** The topic map of an import (miner/topic-map.ts), built by `builder` from a plan made for it; each finished step reaches `onProgress` before the next call. */
  topicMap?: { builder: BuilderModel; build(plan: TopicMapPlan, ctx: CallContext, onProgress: (progress: TopicMapProgress) => Promise<void>): Promise<TopicMap> };
  /** How a spreadsheet of logs reads (spreadsheet/reading-task.ts): proposed by `builder` from a few rows, checked on every row. */
  tableReading?: TableReader;
  /** Which of the agent's prompts write the reply to the customer (prompt-purpose.ts): proposed by `builder` from each prompt's beginning, confirmed by the owner. */
  promptPurposes?: PurposeReader;
  /** How an agent in its own request format is connected (connect.ts): the message field of the owner's curl and the text of the agent's reply, proposed by `builder`, confirmed by the owner. */
  connectionReading?: ConnectionReader;
  failureModes?(input: { task: string; failures: { trialId: string; card: string; reason: string; failed: string[]; trace: string }[]; prompt?: string }, ctx: CallContext): Promise<FailureMode[]>;
  /**
   * Whether this network reaches the judge at all, asked before a run's first paid call: a key says the judge may be
   * used, not that it can be reached. A network check, never a model request, so nothing is billed. Absent where there
   * is nothing to reach (a deterministic runtime).
   */
  judgeReachable?(signal: AbortSignal): Promise<boolean>;
}
