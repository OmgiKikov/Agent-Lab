import { randomUUID } from 'node:crypto';
import type { JudgeAudit } from '../assessment.js';
import { loggedMessages } from '../card/checks.js';
import { bindPlan, planProblem, planProposalSchema, type PlanCall } from '../card/plan.js';
import { PLAN_MESSAGE_CHARS, PLAN_MESSAGES } from '../card/prepare.js';
import { DEFAULT_RULEBOOK } from '../card/rulebook.js';
import type { BusinessScenario } from '../card/schema.js';
import { fingerprint, type Source } from '../contracts.js';
import { logJudgeInput } from '../card/log-judge.js';
import { SOURCES_PER_DIALOGUE, workInputIssue } from '../limits.js';
import { ProviderFailure } from '../llm/model-call.js';
import { StructuredTaskError } from '../llm/structured.js';
import { trafficSummary } from '../miner/coverage.js';
import { topicMapOf } from '../miner/plan.js';
import { allocate } from '../miner/sample.js';
import { seededOrder, topicDialogues, topicTitle, type TopicMap } from '../miner/topic-map.js';
import type { CallContext, Runtime } from '../runtime.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { selectScenarioSources } from '../scenario-sources.js';
import type { ExperimentStore } from '../store.js';
import { clip } from '../text.js';
import { countText } from '../plural.js';
import type { Operation } from '../lab/operation.js';
import { analysisJob, applicableExpectations, planAssignments, unjudgeable, type AnalysisJob } from './criteria.js';
import { findingSchema, type Finding, type LogAnalysis } from './schema.js';

/*
 * The work of one log analysis (DISCOVER), after the owner agreed to its ceiling. No situation is made and nothing of the
 * agent runs: the topic map, the plans and the judge read the logged conversations and the owner's materials only.
 *
 *   1. selection  readable conversations the judge can read (a customer's message and an agent's reply) ─► the import's
 *                 topic map (reused when stored) ─► up to `requested`, seats by each topic's share of the read
 *                 conversations, at most `perTopic` of one (miner/sample.ts allocate)
 *   2. plans      per topic: its conversations' customer words + the materials (+ the tools and the state its logs
 *                 recorded, if any) ─► proposeScenario ─► the harness binds every quote verbatim (card/plan.ts) ─► the
 *                 variation each conversation stands for
 *   3. findings   per conversation, each expectation of its variation ─► the log judge, two votes (card/log-judge.ts);
 *                 one the log cannot show (a tool or state not recorded completely) is kept as skipped, with no call
 *
 * Every step is saved before the next call, so what was paid for is never lost: a stop, the budget or a failure leave
 * the findings made so far, and the analysis says what it did not reach.
 */

/** Findings judged at once: two votes each, so four keep eight requests in flight, as a calibration does. */
const CONCURRENCY = 4;
/** The quotes a finding keeps of the votes that decided it. */
const EVIDENCE = 12;

export interface AnalysisWork {
  runtime: Runtime;
  ctx: CallContext;
  operation: Operation;
  store: Pick<ExperimentStore, 'readTopicMap' | 'writeTopicMap' | 'writeAnalysisAudit'>;
  /** Saves the analysis with a progress line and tells whoever follows it. */
  checkpoint(message: string): Promise<void>;
  /** A progress line that is not saved on its own: the next checkpoint carries it. */
  say(message: string): void;
}

type Group = LogAnalysis['topics'][number];

/**
 * The conversations of each topic analysed: seats over the topics by their share of the traffic (miner/sample.ts
 * allocate), at most `perTopic` of one, each topic's in the order a preparation's sample takes them — so an analysis
 * and a preparation of the same logs look at the same conversations first.
 */
function pickByTopic(map: TopicMap, count: number, perTopic: number, skip: ReadonlySet<string>): Group[] {
  const groups = [...topicDialogues(map)];
  const ranked = seededOrder(groups, map.contentHash, ([topicId]) => `topic:${topicId}`).sort((a, b) => b[1].length - a[1].length);
  const candidates = ranked.map(([, dialogueIds]) => seededOrder(dialogueIds.filter(id => !skip.has(id)), map.contentHash, id => `pick:${id}`));
  const seats = allocate(ranked.map(([, dialogueIds]) => dialogueIds.length), count, candidates.map(list => Math.min(list.length, perTopic)));
  return ranked.flatMap(([topicId], index): Group[] => seats[index]
    ? [{ title: clip(topicTitle(map, topicId) ?? topicId, 120), topicId: topicId as NonNullable<Group['topicId']>, dialogueIds: candidates[index]!.slice(0, seats[index]) }] : []);
}

/** Without a topic map: the first readable conversations, a group of `perTopic` at a time. */
function pickInOrder(ids: readonly string[], count: number, perTopic: number): Group[] {
  const picked = ids.slice(0, count);
  const groups: Group[] = [];
  for (let start = 0; start < picked.length; start += perTopic) {
    const dialogueIds = picked.slice(start, start + perTopic);
    groups.push({ title: `Разговоры ${start + 1}–${start + dialogueIds.length}`, dialogueIds });
  }
  return groups;
}

async function select(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  const skipped = batch.dialogues.flatMap(dialogue => { const reason = unjudgeable(dialogue); return reason ? [{ dialogueId: dialogue.id, reason }] : []; });
  analysis.selection.unjudgeable = skipped;
  const skip = new Set(skipped.map(item => item.dialogueId));
  const { requested, perTopic } = analysis.selection;
  let groups: Group[];
  if (work.runtime.topicMap) {
    const map = await topicMapOf(work.store, batch, work.runtime.topicMap, work.ctx, message => work.checkpoint(message));
    const traffic = trafficSummary(map);
    if (traffic) analysis.traffic = traffic;
    groups = pickByTopic(map, requested, perTopic, skip);
    analysis.selection.method = 'topics';
  } else {
    groups = pickInOrder(batch.dialogues.map(dialogue => dialogue.id).filter(id => !skip.has(id)), requested, perTopic);
    analysis.selection.method = 'order';
  }
  analysis.topics = groups;
  analysis.selection.picked = groups.flatMap(group => group.dialogueIds);
  await work.checkpoint(`Выбрано ${countText(analysis.selection.picked.length, ['разговор', 'разговора', 'разговоров'])} из ${countText(groups.length, ['темы', 'тем', 'тем'])}. Нахожу правила, которые к ним относятся.`);
}

/**
 * What the topic's conversations recorded besides the replies: the tools the agent called, by name, and whether a state
 * is recorded. Undefined when they recorded neither: the plan is then asked about replies alone, as a preparation's is.
 */
function channelsOf(batch: ImportBatch, dialogueIds: readonly string[]): PlanCall['channels'] {
  const events = dialogueIds.flatMap(id => batch.dialogues.find(dialogue => dialogue.id === id)?.events ?? []);
  const tools = events.filter(event => event.type === 'tool');
  const state = events.some(event => event.type === 'state');
  if (!tools.length && !state) return undefined;
  // A tool event names its tool as the log judge reads it (card/log-judge.ts loggedEvents).
  const names = [...new Set(tools.flatMap(event => { const tool = (event.data as { tool?: unknown } | null)?.tool; return typeof tool === 'string' && tool.trim() ? [tool] : []; }))].sort();
  return { tools: names.slice(0, 40), toolEvents: tools.length > 0, state };
}

/** The materials one topic's plan reads: all of them when they fit one request, otherwise the prompts and the articles chosen for the topic. */
async function planSources(analysis: LogAnalysis, examples: PlanCall['examples'], work: AnalysisWork): Promise<Source[]> {
  const prompts = analysis.sources.filter(source => source.kind === 'prompt');
  const articles = analysis.sources.filter(source => source.kind !== 'prompt');
  if (!workInputIssue({ task: analysis.task, sources: analysis.sources }) || !articles.length) return [...prompts, ...articles];
  const chosen = await selectScenarioSources({ task: analysis.task, limit: SOURCES_PER_DIALOGUE, catalog: articles.map(({ id, name, content }) => ({ id, name, chars: content.length })),
    dialogue: { id: 'topic', messages: examples.flatMap(example => example.customer.map(content => ({ role: 'user' as const, content }))) } }, articles, work.runtime, work.ctx);
  return [...prompts, ...chosen];
}

/**
 * One topic's plan: what its customers come with and what the owner's rules ask of the agent, every expectation on a
 * verbatim quote — the preparation's own planner, checked and bound by the same harness (card/plan.ts). Undefined when
 * no answer bound: the topic is then a gap the analysis names, never judged by invented rules.
 */
async function planTopic(analysis: LogAnalysis, batch: ImportBatch, group: Group, work: AnalysisWork): Promise<BusinessScenario | undefined> {
  const examples = group.dialogueIds.flatMap(id => {
    const dialogue = batch.dialogues.find(item => item.id === id);
    const customer = dialogue ? loggedMessages(dialogue).filter(message => message.role === 'user').slice(0, PLAN_MESSAGES).map(message => clip(message.content, PLAN_MESSAGE_CHARS)) : [];
    return customer.length ? [{ dialogueId: id, customer }] : [];
  });
  const read = await planSources(analysis, examples, work);
  const [first, ...rest] = read.map(({ id, name, content, kind }) => ({ id, name, content, ...(kind ? { kind } : {}) }));
  if (!first || !examples.length || !work.runtime.proposeScenario) return undefined;
  const channels = channelsOf(batch, group.dialogueIds);
  const call: PlanCall = { topic: { title: group.title, ...(group.topicId && analysis.traffic ? { key: { batchId: batch.id, id: group.topicId } } : {}) },
    examples, sources: [first, ...rest], binds: { kinds: DEFAULT_RULEBOOK.kinds, rules: [] }, ...(channels ? { channels } : {}) };
  let answer: unknown;
  try { answer = await work.runtime.proposeScenario({ task: analysis.task, call }, work.ctx); }
  catch (error) {
    // No answer that holds, or a request too large for the model's window: the topic has no plan; anything else stops the analysis.
    if (error instanceof StructuredTaskError || error instanceof ProviderFailure && error.delivery === 'refused' && error.kind === 'context limit') return undefined;
    throw error;
  }
  // The runtime's own check is not taken on trust: the harness parses, finds every quote and holds every kind to the rulebook.
  const parsed = planProposalSchema(call).safeParse(answer);
  if (!parsed.success || planProblem(parsed.data, call)) return undefined;
  const { scenario, requirements } = bindPlan(parsed.data, call);
  analysis.requirements = [...analysis.requirements, ...requirements.filter(requirement => !analysis.requirements.some(known => known.id === requirement.id))];
  return scenario;
}

async function plan(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  for (const [index, group] of analysis.topics.entries()) {
    if (group.scenarioId || group.planFailure) continue;
    work.ctx.signal.throwIfAborted();
    await work.checkpoint(`Нахожу правила темы «${group.title}» — ${index + 1} из ${analysis.topics.length}`);
    // A stop while the call is out leaves its cost unknown: the topic is not planned again silently.
    group.planFailure = 'interrupted';
    const scenario = await planTopic(analysis, batch, group, work);
    delete group.planFailure;
    if (!scenario) { group.planFailure = 'unusable'; continue; }
    group.scenarioId = scenario.id;
    analysis.scenarios = [...analysis.scenarios.filter(item => item.id !== scenario.id), scenario];
    analysis.assignments = [...analysis.assignments.filter(item => !group.dialogueIds.includes(item.dialogueId)), ...planAssignments(scenario, group.dialogueIds)];
  }
}

/** What the votes that decided a finding cite, verbatim, and the first of their reasons. */
function evidenceOf(audit: JudgeAudit | undefined, result: Finding['result']): Pick<Finding, 'evidence' | 'rationale'> {
  const decisive = (audit?.attempts ?? []).flatMap(attempt => !attempt.error && !attempt.superseded && attempt.assessments?.[0] ? [attempt.assessments[0]] : [])
    .filter(assessment => result === 'unknown' || assessment.result === result);
  const evidence: Finding['evidence'] = [];
  for (const citation of decisive.flatMap(assessment => assessment.citations ?? [])) {
    if (evidence.length >= EVIDENCE) break;
    if (!evidence.some(item => item.seq === citation.seq && item.quote === citation.quote)) evidence.push({ seq: citation.seq, quote: citation.quote });
  }
  const rationale = decisive[0]?.rationale;
  return { evidence: result === 'unknown' ? [] : evidence, ...(rationale ? { rationale: clip(rationale, 4000) } : {}) };
}

/** Every expectation of every analysed conversation, in topic order, that has no finding yet. */
function pendingJobs(analysis: LogAnalysis, batch: ImportBatch, protocolHash: string): AnalysisJob[] {
  const done = new Set(analysis.findings.map(finding => finding.key));
  return analysis.topics.flatMap(group => {
    const scenario = analysis.scenarios.find(item => item.id === group.scenarioId);
    if (!scenario) return [];
    return group.dialogueIds.flatMap(dialogueId => {
      const dialogue = batch.dialogues.find(item => item.id === dialogueId);
      if (!dialogue) return [];
      const variationId = analysis.assignments.find(item => item.dialogueId === dialogueId)?.variationId;
      return applicableExpectations(scenario, variationId).map(expectation => analysisJob(analysis, batch, scenario, expectation, dialogue, variationId, protocolHash))
        .filter(job => !done.has(job.key));
    });
  });
}

async function judge(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  const judge = work.runtime.logJudge;
  if (!judge) throw new Error('Эта среда не умеет оценивать записанные разговоры.');
  const jobs = pendingJobs(analysis, batch, judge.protocolHash);
  const total = analysis.findings.length + jobs.length;
  let next = 0;
  let stop: unknown;
  const worker = async (): Promise<void> => {
    while (next < jobs.length && stop === undefined) {
      const job = jobs[next++]!;
      // The log cannot show it: kept as a finding that decided nothing, with no call (as a calibration keeps it).
      if (job.skipped) {
        analysis.findings.push(findingSchema.parse({ key: job.key, dialogueId: job.dialogueId, scenarioId: job.scenarioId, expectationId: job.expectationId,
          ...(job.variationId ? { variationId: job.variationId } : {}), criterionHash: job.criterionHash, mode: 'logged-v2', protocolHash: judge.protocolHash,
          inputHash: fingerprint(logJudgeInput(job.request)), provider: judge.provider, model: judge.model, skipped: job.skipped, votes: [], result: 'unknown', complete: true, evidence: [] }));
        continue;
      }
      let audit: JudgeAudit | undefined;
      const ctx: CallContext = { ...work.ctx, onTrace: undefined, onTargetEvent: undefined,
        onJudgment: (key, value) => { work.store.writeAnalysisAudit(analysis.id, key, value); audit = value; } };
      try {
        const judgment = await judge.assess(job.request, ctx);
        analysis.findings.push(findingSchema.parse({ key: job.key, dialogueId: job.dialogueId, scenarioId: job.scenarioId, expectationId: job.expectationId,
          ...(job.variationId ? { variationId: job.variationId } : {}), criterionHash: job.criterionHash, mode: 'logged-v2', ...judgment, ...evidenceOf(audit, judgment.result) }));
        const violations = new Set(analysis.findings.filter(finding => finding.result === 'fail').map(finding => finding.dialogueId)).size;
        await work.checkpoint(`Оцениваю разговоры: ${analysis.findings.length} из ${total} проверок${violations ? ` · нарушения в ${countText(violations, ['разговоре', 'разговорах', 'разговорах'])}` : ''}`);
      } catch (error) { stop ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));
  if (stop !== undefined) throw stop;
}

/** Runs an analysis from where its record stands: the selection, the plans, then the findings. */
export async function runAnalysis(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  if (!analysis.topics.length) await select(analysis, batch, work);
  await plan(analysis, batch, work);
  await judge(analysis, batch, work);
}

/** The id of a new analysis: random, it holds no meaning. */
export const analysisId = (): string => `analysis-${randomUUID()}`;
