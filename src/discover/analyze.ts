import { randomUUID } from 'node:crypto';
import type { JudgeAudit } from '../assessment.js';
import { loggedMessages } from '../card/checks.js';
import { bindPlan, planPayload, planProposalSchema, planSlipKind, type PlanCall } from '../card/plan.js';
import { PLAN_MESSAGE_CHARS, PLAN_MESSAGES } from '../card/prepare.js';
import { gapRequest, GAP_CLAIM } from '../card/review.js';
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
import { FIT_BATCH, fitAnswerSchema, fitProblem, NO_FIT, type FitRequest } from './fit.js';
import { carryFactChecks, runFactAnalysis, selectFactConversations } from './facts-work.js';
import { knowledgeOnly } from './facts.js';
import { ANALYSIS_PROTOCOL, FACT_ANALYSIS_PROTOCOL, ANALYSIS_TOTAL_LIMIT, findingSchema, type Finding, type LogAnalysis, type LogContract, type PlanIssue } from './schema.js';

/*
 * The work of one log analysis (DISCOVER), after the owner agreed to its ceiling. No situation is made and nothing of the
 * agent runs: the topic map, the plans and the judge read the logged conversations and the owner's materials only.
 *
 *   1. selection  readable conversations the judge can read (a customer's message and an agent's reply) ─► the import's
 *                 topic map (reused when stored) ─► up to `requested`, seats by each topic's share of the read
 *                 conversations (miner/sample.ts allocate) ─► a topic's first `perTopic` are its plan's examples, the
 *                 rest of its seats its `extra` conversations
 *   2. plans      per topic: its examples' customer words + the materials (+ what its logs recorded besides the replies,
 *                 and the tools the owner declared the log records) ─► proposeScenario ─► the harness binds every quote
 *                 verbatim (card/plan.ts) ─► the variation each example stands for. A plan no answer bound is Lab's work
 *                 not finishing, typed (PLAN_ISSUES); a plan that says the sources are silent is a gap only once the
 *                 reviewer confirms it (card/review.ts gapRequest, as a preparation's checkGap does)
 *   3. fit        per topic, its extra conversations' customer words ─► fitConversations (discover/fit.ts) ─► each under
 *                 the variation it is in, or none. The ones the topic's plan does not fit become the examples of the
 *                 topic's `others` group, planned (2) and fitted (3) the same way; what that plan does not fit either is
 *                 never judged, and said so
 *   4. findings   per conversation, each expectation of its variation and the shared ones ─► the log judge, two votes, told
 *                 the situation the expectation is for (card/log-judge.ts `logged-v3`); one the log cannot show is kept as
 *                 skipped, with no call (criteria.ts analysisSkip)
 *
 * Every step is saved before the next call, so what was paid for is never lost: a stop, the budget or a failure leave
 * the findings made so far, and the analysis says what it did not reach. A provider that does not answer ends one step,
 * never the analysis: a topic's plan or its fit is left unfinished (`provider_failed`), a judgment incomplete, and the rest
 * goes on; nothing is asked again silently. A continuation (continueFrom) is a new analysis that carries the earlier one's
 * plans and every complete finding whose key still holds, asks again what did not finish, and selects the next conversations.
 */

/** Findings judged at once: two votes each, so four keep eight requests in flight, as a calibration does. */
const CONCURRENCY = 4;
/** The quotes a finding keeps of the votes that decided it. */
const EVIDENCE = 12;
/** Groups an analysis keeps at most (analysisSchema.topics): a topic's first group and the group of what its plan did not fit. */
const GROUPS = 40;

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

/** A topic's selected conversations as a group: the first `perTopic` its plan's examples, the rest its extra conversations. */
function groupOf(title: string, topicId: Group['topicId'], picked: readonly string[], perTopic: number): Group {
  const extra = picked.slice(perTopic);
  return { title: clip(title, 120), ...(topicId ? { topicId } : {}), dialogueIds: picked.slice(0, perTopic), ...(extra.length ? { extra } : {}) };
}

/** The topics of a map, largest first, each with its conversations the judge can read in the order a preparation's sample takes them. */
function rankedTopics(map: TopicMap, skip: ReadonlySet<string>): { topicId: string; size: number; candidates: string[] }[] {
  const groups = [...topicDialogues(map)];
  const ranked = seededOrder(groups, map.contentHash, ([topicId]) => `topic:${topicId}`).sort((a, b) => b[1].length - a[1].length);
  return ranked.map(([topicId, dialogueIds]) => ({ topicId, size: dialogueIds.length, candidates: seededOrder(dialogueIds.filter(id => !skip.has(id)), map.contentHash, id => `pick:${id}`) }));
}

/**
 * The conversations of each topic analysed: seats over the topics by their share of the traffic (miner/sample.ts
 * allocate), as many of one topic as its seats — its first `perTopic` its plan's examples —, each topic's in the order a
 * preparation's sample takes them, so an analysis and a preparation of the same logs look at the same conversations first.
 */
function pickByTopic(map: TopicMap, count: number, perTopic: number, skip: ReadonlySet<string>): Group[] {
  const ranked = rankedTopics(map, skip);
  const seats = allocate(ranked.map(topic => topic.size), count, ranked.map(topic => topic.candidates.length));
  return ranked.flatMap((topic, index): Group[] => seats[index]
    ? [groupOf(topicTitle(map, topic.topicId) ?? topic.topicId, topic.topicId as NonNullable<Group['topicId']>, topic.candidates.slice(0, seats[index]), perTopic)] : []);
}

/** Without a topic map: the first readable conversations, a group of `perTopic` at a time, each group its own plan. */
function pickInOrder(ids: readonly string[], count: number, perTopic: number, start = 0): Group[] {
  const picked = ids.slice(0, count);
  const groups: Group[] = [];
  for (let at = 0; at < picked.length; at += perTopic) {
    const dialogueIds = picked.slice(at, at + perTopic);
    groups.push({ title: `Разговоры ${start + at + 1}–${start + at + dialogueIds.length}`, dialogueIds });
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
    groups = pickInOrder(batch.dialogues.map(dialogue => dialogue.id).filter(id => !skip.has(id)), requested, perTopic).slice(0, GROUPS);
    analysis.selection.method = 'order';
  }
  analysis.selection.beyond = 'fitted';
  analysis.topics = groups;
  analysis.selection.picked = groups.flatMap(group => [...group.dialogueIds, ...group.extra ?? []]);
  await work.checkpoint(`Выбрано ${countText(analysis.selection.picked.length, ['разговор', 'разговора', 'разговоров'])} из ${countText(groups.length, ['темы', 'тем', 'тем'])}. Нахожу правила, которые к ним относятся.`);
}

/**
 * The next `more` conversations of a continued analysis, none selected before: seats over the topics by their share of the
 * traffic, as many of one topic as it has left. A topic already planned takes them as extra conversations; a topic new to
 * the analysis gets a group whose first `perTopic` its plan reads. Without a topic map, the next ones in the log's order.
 */
export async function selectMore(analysis: LogAnalysis, batch: ImportBatch, more: number, work: Pick<AnalysisWork, 'runtime' | 'store' | 'ctx' | 'checkpoint'>): Promise<string[]> {
  if (analysis.checking === 'facts') return selectFactConversations(analysis, batch, more);
  const taken = new Set([...analysis.selection.picked, ...analysis.selection.unjudgeable.map(item => item.dialogueId)]);
  const room = Math.min(more, ANALYSIS_TOTAL_LIMIT - analysis.selection.picked.length);
  const perTopic = analysis.selection.perTopic;
  const added: string[] = [];
  if (analysis.selection.method === 'topics' && work.runtime.topicMap) {
    const map = await topicMapOf(work.store, batch, work.runtime.topicMap, work.ctx, message => work.checkpoint(message));
    const ranked = rankedTopics(map, taken);
    const seats = allocate(ranked.map(topic => topic.size), room, ranked.map(topic => topic.candidates.length));
    ranked.forEach((topic, index) => {
      const picked = topic.candidates.slice(0, seats[index] ?? 0);
      if (!picked.length) return;
      const group = analysis.topics.find(item => item.topicId === topic.topicId);
      if (group) group.extra = [...group.extra ?? [], ...picked];
      else if (analysis.topics.length < GROUPS) analysis.topics.push(groupOf(topicTitle(map, topic.topicId) ?? topic.topicId, topic.topicId as NonNullable<Group['topicId']>, picked, perTopic));
      else return;
      added.push(...picked);
    });
  } else {
    const next = batch.dialogues.map(dialogue => dialogue.id).filter(id => !taken.has(id) && !unjudgeable(batch.dialogues.find(dialogue => dialogue.id === id)!));
    const groups = pickInOrder(next, room, perTopic, analysis.selection.picked.length).slice(0, Math.max(0, GROUPS - analysis.topics.length));
    analysis.topics.push(...groups);
    added.push(...groups.flatMap(group => group.dialogueIds));
  }
  analysis.selection.picked = [...analysis.selection.picked, ...added];
  analysis.selection.beyond = 'fitted';
  return added;
}

/**
 * What the topic's conversations recorded besides the replies — the tools the agent called there, by name, and whether a
 * state is recorded —, the tools the owner declared the log records every call of, and that a rule may require a tool no
 * log shows (card/plan.ts PlanCall.channels `byRule`): what a rule requires never comes from what the logs happen to hold.
 */
function channelsOf(batch: ImportBatch, dialogueIds: readonly string[], contract: LogContract | undefined): NonNullable<PlanCall['channels']> {
  const events = dialogueIds.flatMap(id => batch.dialogues.find(dialogue => dialogue.id === id)?.events ?? []);
  const tools = events.filter(event => event.type === 'tool');
  const state = events.some(event => event.type === 'state');
  // A tool event names its tool as the log judge reads it (card/log-judge.ts loggedEvents).
  const names = [...new Set(tools.flatMap(event => { const tool = (event.data as { tool?: unknown } | null)?.tool; return typeof tool === 'string' && tool.trim() ? [tool] : []; }))].sort();
  return { tools: names.slice(0, 40), toolEvents: tools.length > 0, state, ...(contract ? { recorded: [...contract.tools] } : {}), byRule: true };
}

/** A request the provider refused because it does not fit the model's window. */
const overWindow = (error: unknown): boolean => error instanceof ProviderFailure && error.delivery === 'refused' && error.kind === 'context limit';
/**
 * The provider did not answer one call for a passing reason — a connection that broke, a request that never came back, a
 * rate limit —, and no stop of the operation is behind it: that one step did not finish, and the rest goes on. A refusal
 * that repeats on every call (no access, no credit) is not one: it ends the analysis, as a stop does.
 */
const providerFailed = (error: unknown, signal: AbortSignal): boolean => error instanceof ProviderFailure && error.retryable && !signal.aborted;

/** The materials one topic's plan reads: all of them when they fit one request, otherwise the prompts and the articles chosen for the topic. */
async function planSources(analysis: LogAnalysis, examples: PlanCall['examples'], work: AnalysisWork): Promise<Source[] | PlanIssue> {
  const prompts = analysis.sources.filter(source => source.kind === 'prompt');
  const articles = analysis.sources.filter(source => source.kind !== 'prompt');
  if (!workInputIssue({ task: analysis.task, sources: analysis.sources }) || !articles.length) return [...prompts, ...articles];
  if (!work.runtime.selectSources) return 'source_selection';
  const input = { task: analysis.task, limit: SOURCES_PER_DIALOGUE, catalog: articles.map(({ id, name, content }) => ({ id, name, chars: content.length })),
    dialogue: { id: 'topic', messages: examples.flatMap(example => example.customer.map(content => ({ role: 'user' as const, content }))) } };
  if (workInputIssue(input)) return 'context_window';
  try { return [...prompts, ...await selectScenarioSources(input, articles, work.runtime, work.ctx)]; }
  catch (error) {
    if (error instanceof StructuredTaskError) return 'source_selection';
    if (overWindow(error)) return 'context_window';
    if (providerFailed(error, work.ctx.signal)) return 'provider_failed';
    throw error;
  }
}

/** A topic's plan, or why there is none: Lab's own work not finishing, typed; or a gap the planner reported, with what it read. */
type Planned = { scenario: BusinessScenario } | { issue: PlanIssue } | { gap: string; read: Source[] };

/** The owner-facing kind of a plan no answer bound, from the typed rejection — never from its words. */
function issueOf(error: StructuredTaskError): PlanIssue {
  if (error.outcome !== 'domain') return 'answer_schema';
  return error.issue === 'quote' ? 'quote_not_verbatim' : 'answer_check';
}

/**
 * One topic's plan: what its customers come with and what the owner's rules ask of the agent, every expectation on a
 * verbatim quote — the preparation's own planner, checked and bound by the same harness (card/plan.ts). No plan is never
 * told as a gap in the owner's rules: an answer that failed the schema, a quote not verbatim, a request too large for the
 * model's window, articles that could not be chosen — each is Lab's work not finishing, by its kind; only the planner's
 * word that the sources are silent is a gap, and only once the reviewer confirms it (reviewGap).
 */
async function planTopic(analysis: LogAnalysis, batch: ImportBatch, group: Group, work: AnalysisWork): Promise<Planned> {
  const examples = group.dialogueIds.flatMap(id => {
    const customer = customerWords(batch, id);
    return customer.length ? [{ dialogueId: id, customer }] : [];
  });
  if (!work.runtime.proposeScenario) return { issue: 'planner_unavailable' };
  const read = await planSources(analysis, examples, work);
  if (typeof read === 'string') return { issue: read };
  const [first, ...rest] = read.map(({ id, name, content, kind }) => ({ id, name, content, ...(kind ? { kind } : {}) }));
  if (!first || !examples.length) return { issue: 'source_selection' };
  const call: PlanCall = { topic: { title: group.title, ...(group.topicId && analysis.traffic ? { key: { batchId: batch.id, id: group.topicId } } : {}) },
    examples, sources: [first, ...rest], binds: { kinds: DEFAULT_RULEBOOK.kinds, rules: [] }, channels: channelsOf(batch, group.dialogueIds, analysis.logs.contract), gaps: true };
  if (workInputIssue(planPayload({ task: analysis.task, call }))) return { issue: 'context_window' };
  let answer: unknown;
  try { answer = await work.runtime.proposeScenario({ task: analysis.task, call }, work.ctx); }
  catch (error) {
    // No answer that holds, a request too large for the model's window, or a provider that did not answer: Lab's work on
    // the topic did not finish; a stop, or anything else, stops the analysis.
    if (error instanceof StructuredTaskError) return { issue: issueOf(error) };
    if (overWindow(error)) return { issue: 'context_window' };
    if (providerFailed(error, work.ctx.signal)) return { issue: 'provider_failed' };
    throw error;
  }
  // The runtime's own check is not taken on trust: the harness parses, finds every quote and holds every kind to the rulebook.
  const parsed = planProposalSchema(call).safeParse(answer);
  if (!parsed.success) return { issue: 'answer_schema' };
  const slip = planSlipKind(parsed.data, call);
  if (slip) return { issue: slip === 'quote' ? 'quote_not_verbatim' : 'answer_check' };
  const { uncovered } = parsed.data as { uncovered?: string | null };
  if (!parsed.data.expectations.length && uncovered) return { gap: uncovered, read };
  const { scenario, requirements } = bindPlan(parsed.data, call);
  analysis.requirements = [...analysis.requirements, ...requirements.filter(requirement => !analysis.requirements.some(known => known.id === requirement.id))];
  return { scenario };
}

/**
 * The planner found no rule for the topic's customers: a gap in the owner's rules only when the reviewer confirms that no
 * sentence of what the planner read says what the agent must do — the question a preparation asks of a card's gap
 * (card/review.ts gapRequest). A reviewer who finds one, doubts, or cannot answer leaves it unconfirmed: Lab's reading.
 */
async function reviewGap(batch: ImportBatch, group: Group, asks: string, read: readonly Source[], work: AnalysisWork): Promise<NonNullable<Group['rulesGap']>> {
  const unconfirmed = (reason: string): NonNullable<Group['rulesGap']> => ({ asks: clip(asks, 300), confirmed: false, reason: clip(reason, 600) });
  const dialogue = batch.dialogues.find(item => item.id === group.dialogueIds[0]);
  if (!dialogue || !work.runtime.reviewCard) return unconfirmed('проверить, что правила действительно нет, не удалось');
  const request = gapRequest({ asks, messages: loggedMessages(dialogue), sources: read });
  if (workInputIssue(request.payload)) return unconfirmed('разговор вместе с материалами не поместился в окно модели проверяющего');
  try {
    const review = await work.runtime.reviewCard(request, work.ctx);
    const verdict = review.verdicts[GAP_CLAIM];
    if (verdict?.status === 'ready') return { asks: clip(asks, 300), confirmed: true, reason: clip(verdict.reason, 600), reviewer: clip(review.model, 200) };
    return { ...unconfirmed(verdict?.reason ?? 'проверяющий не ответил'), reviewer: clip(review.model, 200) };
  } catch (error) {
    if (error instanceof StructuredTaskError || overWindow(error)) return unconfirmed('проверяющий не дал ответа, который проходит проверку Lab');
    if (providerFailed(error, work.ctx.signal)) return unconfirmed('связь с моделью проверяющего оборвалась — проверить, что правила нет, не удалось');
    throw error;
  }
}

/** The customer's own words of a logged conversation, as a plan's example reads them: never the old agent's replies. */
function customerWords(batch: ImportBatch, dialogueId: string): string[] {
  const dialogue = batch.dialogues.find(item => item.id === dialogueId);
  return dialogue ? loggedMessages(dialogue).filter(message => message.role === 'user').slice(0, PLAN_MESSAGES).map(message => clip(message.content, PLAN_MESSAGE_CHARS)) : [];
}

/** Every group with no plan yet, planned in turn; a gap the planner reports goes to the reviewer. */
async function planGroups(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  for (const [index, group] of analysis.topics.entries()) {
    if (group.scenarioId || group.planFailure) continue;
    work.ctx.signal.throwIfAborted();
    await work.checkpoint(`Нахожу правила темы «${group.title}» — ${index + 1} из ${analysis.topics.length}`);
    // A stop while the call is out leaves its cost unknown: the topic is not planned again silently.
    group.planFailure = 'interrupted';
    const planned = await planTopic(analysis, batch, group, work);
    if ('gap' in planned) group.rulesGap = await reviewGap(batch, group, planned.gap, planned.read, work);
    delete group.planFailure;
    if (!('scenario' in planned)) {
      group.planFailure = 'unusable';
      if ('issue' in planned) group.planIssue = planned.issue;
      continue;
    }
    const { scenario } = planned;
    group.scenarioId = scenario.id;
    analysis.scenarios = [...analysis.scenarios.filter(item => item.id !== scenario.id), scenario];
    analysis.assignments = [...analysis.assignments.filter(item => !group.dialogueIds.includes(item.dialogueId)), ...planAssignments(scenario, group.dialogueIds)];
  }
}

/** The extra conversations of a group the planner has not fitted yet: none assigned to its plan, none found unfit. */
const unfitted = (analysis: LogAnalysis, group: Group): string[] => (group.extra ?? [])
  .filter(id => !group.unfit?.includes(id) && !analysis.assignments.some(item => item.dialogueId === id && item.scenarioId === group.scenarioId));

/**
 * Every planned group's extra conversations fitted to its plan, a call for at most FIT_BATCH of them: each under the
 * variation the planner says it is in, or unfit. A call that did not finish leaves the rest unfitted, with why — never
 * judged by the plan; a continuation fits them again.
 */
async function fitGroups(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  for (const group of analysis.topics) {
    const scenario = analysis.scenarios.find(item => item.id === group.scenarioId);
    if (!scenario || group.fitIssue) continue;
    const pending = unfitted(analysis, group);
    if (!pending.length) continue;
    if (!work.runtime.fitConversations) { group.fitIssue = 'planner_unavailable'; continue; }
    for (let at = 0; at < pending.length; at += FIT_BATCH) {
      const conversations = pending.slice(at, at + FIT_BATCH).map(dialogueId => ({ dialogueId, customer: customerWords(batch, dialogueId) }));
      work.ctx.signal.throwIfAborted();
      await work.checkpoint(`Сверяю другие разговоры темы «${group.title}» с найденными правилами — ${countText(conversations.length, ['разговор', 'разговора', 'разговоров'])}`);
      const request: FitRequest = { task: analysis.task, topic: group.title, question: scenario.question,
        variations: scenario.variations.map(variation => ({ id: variation.id, title: variation.title })), conversations };
      if (workInputIssue(request)) { group.fitIssue = 'context_window'; break; }
      let answer: unknown;
      try { answer = await work.runtime.fitConversations(request, work.ctx); }
      catch (error) {
        if (error instanceof StructuredTaskError) { group.fitIssue = issueOf(error); break; }
        if (overWindow(error)) { group.fitIssue = 'context_window'; break; }
        if (providerFailed(error, work.ctx.signal)) { group.fitIssue = 'provider_failed'; break; }
        throw error;
      }
      // The runtime's own check is not taken on trust: every conversation answered once, by a variation of this plan or none.
      const parsed = fitAnswerSchema(request).safeParse(answer);
      if (!parsed.success || fitProblem(parsed.data, request)) { group.fitIssue = 'answer_schema'; break; }
      for (const fit of parsed.data.fits) {
        if (fit.variation === NO_FIT) group.unfit = [...group.unfit ?? [], fit.dialogueId];
        else analysis.assignments.push({ dialogueId: fit.dialogueId, scenarioId: scenario.id, variationId: fit.variation });
      }
    }
  }
}

/** Extra conversations of an analysis the planner has not fitted to their group's plan yet: fitted before they are judged. */
export const unfittedCount = (analysis: LogAnalysis): number => analysis.selection.beyond === 'fitted'
  ? analysis.topics.reduce((sum, group) => sum + (group.scenarioId ? unfitted(analysis, group).length : 0), 0) : 0;

/** The title of the group of a topic's conversations its first plan did not fit. */
const othersTitle = (title: string): string => clip(`${title} — другие вопросы`, 120);

/**
 * The conversations a topic's first plan did not fit, moved to the topic's `others` group — its examples when the group is
 * new, its extra conversations to fit when it has a plan already. What an `others` group's plan does not fit stays unfit.
 * True when a conversation moved, so there is a plan or a fit to make.
 */
function gatherOthers(analysis: LogAnalysis): boolean {
  let moved = false;
  for (const group of [...analysis.topics]) {
    if (group.others || !group.unfit?.length) continue;
    const title = othersTitle(group.title);
    const others = analysis.topics.find(item => item.others && item.title === title);
    const placed = new Set(others ? [...others.dialogueIds, ...others.extra ?? []] : []);
    const fresh = group.unfit.filter(id => !placed.has(id));
    if (!fresh.length) continue;
    const perTopic = analysis.selection.perTopic;
    if (others) others.extra = [...others.extra ?? [], ...fresh];
    else if (analysis.topics.length < GROUPS) {
      analysis.topics.push({ title, ...(group.topicId ? { topicId: group.topicId } : {}), dialogueIds: fresh.slice(0, perTopic),
        ...(fresh.length > perTopic ? { extra: fresh.slice(perTopic) } : {}), others: true });
    } else continue;
    moved = true;
  }
  return moved;
}

async function plan(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  if (analysis.selection.beyond !== 'fitted') {
    // An analysis made before extra conversations were fitted keeps its reading: they are judged on the shared expectations.
    await planGroups(analysis, batch, work);
    for (const group of analysis.topics) {
      if (!group.scenarioId || !group.extra?.length) continue;
      const assigned = new Set(analysis.assignments.map(item => item.dialogueId));
      analysis.assignments.push(...group.extra.filter(id => !assigned.has(id)).map(dialogueId => ({ dialogueId, scenarioId: group.scenarioId! })));
    }
    return;
  }
  // Plans, then the fit of every other conversation; what a topic's plan does not fit gets a plan of its own — once.
  do {
    await planGroups(analysis, batch, work);
    await fitGroups(analysis, batch, work);
  } while (gatherOthers(analysis));
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

/**
 * Every expectation of every analysed conversation, in topic order: those of its variation and the shared ones — for a
 * plan's example, the variation the plan names; for an extra conversation, the one the planner fitted it to (`fitted`),
 * never one it found unfit or has not fitted yet; before extra conversations were fitted, the shared ones only. With
 * `pending`, only those with no finding yet.
 */
export function analysisJobs(analysis: LogAnalysis, batch: ImportBatch, protocolHash: string, pending = true): AnalysisJob[] {
  if (analysis.checking === 'facts') return [];
  const done = new Set(pending ? analysis.findings.map(finding => finding.key) : []);
  const fitted = analysis.selection.beyond === 'fitted';
  return analysis.topics.flatMap(group => {
    const scenario = analysis.scenarios.find(item => item.id === group.scenarioId);
    if (!scenario) return [];
    return [...group.dialogueIds, ...group.extra ?? []].flatMap(dialogueId => {
      const dialogue = batch.dialogues.find(item => item.id === dialogueId);
      if (!dialogue || group.unfit?.includes(dialogueId)) return [];
      const example = group.dialogueIds.includes(dialogueId);
      const assignment = analysis.assignments.find(item => item.dialogueId === dialogueId && item.scenarioId === scenario.id);
      if (!example && fitted && !assignment) return [];
      const variationId = example || fitted ? assignment?.variationId : undefined;
      return applicableExpectations(scenario, variationId).map(expectation => analysisJob(analysis, batch, scenario, expectation, dialogue, variationId, protocolHash))
        .filter(job => !done.has(job.key));
    });
  });
}

async function judge(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  const judge = work.runtime.logJudge;
  if (!judge) throw new Error('Эта среда не умеет оценивать записанные разговоры.');
  const jobs = analysisJobs(analysis, batch, judge.protocolHash);
  const total = analysis.findings.length + jobs.length;
  let next = 0;
  let stop: unknown;
  const worker = async (): Promise<void> => {
    while (next < jobs.length && stop === undefined) {
      const job = jobs[next++]!;
      // The log cannot show it: kept as a finding that decided nothing, with no call (as a calibration keeps it).
      if (job.skipped) {
        analysis.findings.push(findingSchema.parse({ key: job.key, dialogueId: job.dialogueId, scenarioId: job.scenarioId, expectationId: job.expectationId,
          ...(job.variationId ? { variationId: job.variationId } : {}), criterionHash: job.criterionHash, mode: logJudgeInput(job.request).mode, protocolHash: judge.protocolHash,
          inputHash: fingerprint(logJudgeInput(job.request)), provider: judge.provider, model: judge.model, skipped: job.skipped, votes: [], result: 'unknown', complete: true, evidence: [] }));
        continue;
      }
      let audit: JudgeAudit | undefined;
      const ctx: CallContext = { ...work.ctx, onTrace: undefined, onTargetEvent: undefined,
        onJudgment: (key, value) => { work.store.writeAnalysisAudit(analysis.id, key, value); audit = value; } };
      try {
        const judgment = await judge.assess(job.request, ctx);
        analysis.findings.push(findingSchema.parse({ key: job.key, dialogueId: job.dialogueId, scenarioId: job.scenarioId, expectationId: job.expectationId,
          ...(job.variationId ? { variationId: job.variationId } : {}), criterionHash: job.criterionHash, mode: logJudgeInput(job.request).mode, ...judgment, ...evidenceOf(audit, judgment.result) }));
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
  if (analysis.checking === 'facts') return runFactAnalysis(analysis, batch, work);
  if (!analysis.topics.length) await select(analysis, batch, work);
  await plan(analysis, batch, work);
  await judge(analysis, batch, work);
}

/**
 * A continuation of `earlier` as a new analysis, before anything is spent: its selection, plans and requirements, the
 * owner's words, and every complete finding whose key the current judge still gives — the same criterion, what the judge
 * reads of it (the situation included), the same conversation of the same import, the same judge protocol —, so no call is
 * made again for it. A finding of another judge or of changed inputs is not carried: the earlier analysis keeps it; one
 * the judge did not finish is asked again. A topic whose plan or fit Lab did not finish — never a confirmed gap — is
 * planned or fitted again under the new ceiling; the extra conversations of an analysis made before they were fitted are
 * fitted now.
 */
export function continueFrom(earlier: LogAnalysis, batch: ImportBatch, protocolHash: string, fresh: Pick<LogAnalysis, 'id' | 'createdAt' | 'updatedAt' | 'budget' | 'models'> & { requested: number }): LogAnalysis {
  const next: LogAnalysis = structuredClone({ ...earlier, id: fresh.id, protocol: ANALYSIS_PROTOCOL, createdAt: fresh.createdAt, updatedAt: fresh.updatedAt, budget: fresh.budget, models: fresh.models,
    status: 'running' as const, message: 'Продолжаю разбор.', selection: { ...earlier.selection, requested: fresh.requested, beyond: 'fitted' as const } });
  delete next.unfinished; delete next.error; delete next.failure;
  if (earlier.checking !== 'facts' && knowledgeOnly(earlier.sources)) {
    // Preserve the earlier record, but do not carry its article-derived duties into the new factual comparison.
    next.checking = 'facts'; next.factChecks = []; next.findings = [];
    next.scenarios = []; next.topics = []; next.requirements = []; next.assignments = [];
  }
  if (next.checking === 'facts') {
    next.protocol = FACT_ANALYSIS_PROTOCOL;
    delete next.selection.beyond;
    carryFactChecks(next, batch, protocolHash);
    next.continues = { analysisId: earlier.id, picked: earlier.selection.picked.length, reused: next.findings.length };
    return next;
  }
  for (const group of next.topics) {
    if (group.planFailure && !group.rulesGap?.confirmed) { delete group.planFailure; delete group.planIssue; delete group.rulesGap; }
    delete group.fitIssue;
  }
  if (earlier.selection.beyond !== 'fitted') {
    // Judged on the shared expectations before, fitting or not: now fitted like any other.
    const extra = new Set(next.topics.flatMap(group => group.extra ?? []));
    next.assignments = next.assignments.filter(item => !extra.has(item.dialogueId) || item.variationId !== undefined);
  }
  const holding = new Set(analysisJobs(next, batch, protocolHash, false).map(job => job.key));
  next.findings = next.findings.filter(finding => holding.has(finding.key) && finding.complete);
  next.continues = { analysisId: earlier.id, picked: earlier.selection.picked.length, reused: next.findings.length };
  return next;
}

/** The id of a new analysis: random, it holds no meaning. */
export const analysisId = (): string => `analysis-${randomUUID()}`;
