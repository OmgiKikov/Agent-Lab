import type { Criterion } from '../contracts.js';
import { logUndecided, type LogUndecided } from '../card/log-judge.js';
import { criterionHash } from '../criterion.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { planCriterion } from './criteria.js';
import { oneLine } from '../text.js';
import type { Finding, FindingReview, LogAnalysis, PlanIssue } from './schema.js';

/*
 * What a log analysis found, derived once from its record (DISCOVER): pure, no I/O and no model — every surface lays
 * out these rows and words them through discover/text.ts.
 *
 *   coverage   every conversation of the log ─► read ─► judgeable ─► selected ─► processed (judged, or skipped with a
 *              reason) ─► decided on at least one rule; selected and not processed is said apart, never as analysed
 *   traffic    the topics of all read conversations: what customers come with — never mixed with the violations
 *   problems   violations grouped by their criterion (criterion.ts: the rules, the behaviour, the ways, the violation,
 *              the channel — never the topic), each with how many of the conversations it was decided on it broke, what
 *              could not be decided, the conversations that show it, and those where it held with evidence
 *   gaps       topics with no plan: Lab's work not finishing (typed), a gap the planner reported that the reviewer did not
 *              confirm (Lab's reading), or a confirmed gap in the owner's rules — only the last asks the owner for a rule
 *
 * A violation counts in a conversation where the judge found it and the owner did not dispute it; the owner's word is
 * read beside the judge's (the latest per finding), never instead of the record.
 */

export interface Quote { seq: number; role: 'customer' | 'agent' | 'other'; quote: string }
/**
 * One example of a violation. `absent`: the criterion requires a call of this tool, and the conversation — complete, under
 * the owner's contract that the log records every call of it — holds none: the action was not made, not merely unseen.
 */
export interface Example { key: string; dialogueId: string; quotes: Quote[]; rationale?: string; review?: FindingReview['verdict']; absent?: string }
/** Why a finding decided nothing: the log judge's reasons (card/log-judge.ts), and a required call whose absence the log cannot show. */
export type FindingUndecided = LogUndecided | 'call_unconfirmed';
export interface ProblemView {
  /** The criterion's hash (criterion.ts): the same across topics and analyses whose plans say exactly the same. */
  key: string;
  /** The criterion the violations break, as the judge read it: what a check of the problem carries into its situations. */
  criterion: Criterion;
  duty: { text: string; mustNot: boolean; acceptable?: string; violation?: string };
  rules: { quote: string; source: string }[];
  topics: string[];
  /** Conversations where it was broken (not disputed by the owner), where it was decided at all, and where it was not. */
  violations: number; checked: number; unknown: number;
  /** Every conversation it was broken in, in the order of the findings. */
  dialogueIds: string[];
  /**
   * Conversations where it applied, was decided and held: every finding of it there passed, complete, with evidence, and
   * no word of the owner overrode it. Only these may stand beside the violations as controls of a check (discover/verify.ts);
   * a conversation it could not be decided on, or that never reached it, is none.
   */
  held: string[];
  confirmed: number; disputed: number;
  examples: Example[];
}
export interface AnalysisView {
  id: string; status: LogAnalysis['status']; unfinished?: LogAnalysis['unfinished']; error?: string; message: string;
  file: string; mode: LogAnalysis['mode']; createdAt: string;
  coverage: {
    logged: number; readable: number; judgeable: number;
    unjudgeable: { reason: LogAnalysis['selection']['unjudgeable'][number]['reason']; count: number }[];
    /** Selected conversations; `perTopic` bounds the examples a topic's plan reads (`beyond: 'shared'`), or — before — the topic. */
    picked: number; method: LogAnalysis['selection']['method']; perTopic: number; beyond?: 'shared';
    /** Selected conversations that were processed: judged, or skipped with the reason the log cannot show a rule. */
    processed: number;
    /** Processed conversations decided on at least one rule, those processed but decided on none, those selected and never processed. */
    decided: number; undecided: number; notReached: number;
    /** Selected conversations beyond their topic's plan examples: judged on the rules every variation of the plan shares. */
    sharedOnly: number;
  };
  /** The analysis this one continues, with how many it had selected and how many findings came over with no call. */
  continues?: NonNullable<LogAnalysis['continues']>;
  /** The tools the owner declared the log records every call of; absent — none declared. */
  recorded?: string[];
  traffic?: { title: string; dialogues: number; share: number; picked: number }[];
  problems: ProblemView[];
  /**
   * Criteria the judge found broken where the owner disputed every violation: no problem any more, and never lost — each
   * example keeps the owner's mark, so they can open it again and see their own word.
   */
  overruled: ProblemView[];
  /** Rules decided on at least one conversation and broken in none; `disputed`: the judge's violations the owner disputed. */
  /** `key`, `held`, `topics`: the criterion, where it held with evidence and its topics — a check's neighbours come from them (discover/verify.ts). */
  clean: { text: string; checked: number; disputed: number; key: string; held: string[]; topics: string[] }[];
  undecided: { reason: FindingUndecided; count: number }[];
  /**
   * Topics with no plan: `reason` how the work ended; `issue` why Lab's own work did not finish; `rulesGap` what the
   * planner reported the materials are silent on, and whether the reviewer confirmed it — only then the owner's gap.
   */
  gaps: { title: string; reason: NonNullable<LogAnalysis['topics'][number]['planFailure']>; issue?: PlanIssue; rulesGap?: NonNullable<LogAnalysis['topics'][number]['rulesGap']>; conversations: number }[];
  models: LogAnalysis['models'];
  budget: LogAnalysis['budget'];
}

/** The latest word of the owner on each finding. */
function latestReviews(reviews: readonly FindingReview[]): Map<string, FindingReview> {
  const latest = new Map<string, FindingReview>();
  for (const review of reviews) latest.set(review.key, review);
  return latest;
}

/** Why one finding decided nothing: a required call the log cannot show, else the log judge's own reason. */
export function findingUndecided(finding: Finding): FindingUndecided | undefined {
  if (finding.skipped === 'call_unconfirmed') return finding.skipped;
  return logUndecided({ ...finding, skipped: finding.skipped });
}

/** The role of an event of the logged conversation, when the import is at hand. */
function roleOf(batch: Pick<ImportBatch, 'dialogues'> | undefined, dialogueId: string, seq: number): Quote['role'] {
  const event = batch?.dialogues.find(dialogue => dialogue.id === dialogueId)?.events.find(item => item.index === seq);
  return event?.type === 'message' ? event.role === 'user' ? 'customer' : event.role === 'assistant' ? 'agent' : 'other' : 'other';
}

export function analysisView(analysis: LogAnalysis, batch?: Pick<ImportBatch, 'dialogues'>): AnalysisView {
  const reviews = latestReviews(analysis.reviews);
  const sourceName = new Map(analysis.sources.map(source => [source.id, source.name]));
  const topicOf = new Map(analysis.topics.map(group => [group.scenarioId, group.title]));
  const counted = (finding: Finding) => finding.result === 'fail' && reviews.get(finding.key)?.verdict !== 'disputed';

  // Problems: the findings of one criterion over every topic whose plan has it — derived from the plan, never read off
  // a stored hash, so an analysis made before the kernel groups the same way.
  const groups = new Map<string, { findings: Finding[]; criterion: Criterion; duty: ProblemView['duty']; rules: ProblemView['rules']; topics: Set<string> }>();
  for (const finding of analysis.findings) {
    const scenario = analysis.scenarios.find(item => item.id === finding.scenarioId);
    const expectation = scenario?.expectations.find(item => item.id === finding.expectationId);
    const criterion = expectation && planCriterion(analysis, expectation);
    if (!scenario || !expectation || !criterion) continue;
    const rules = criterion.requirements.map(requirement => ({ quote: requirement.quote, source: sourceName.get(requirement.sourceId) ?? requirement.sourceId }));
    const key = criterionHash(criterion);
    const group = groups.get(key) ?? { findings: [], criterion, rules, topics: new Set<string>(),
      duty: { text: expectation.text, mustNot: expectation.strength === 'must_not', ...(expectation.acceptable ? { acceptable: expectation.acceptable } : {}), ...(expectation.violation ? { violation: expectation.violation } : {}) } };
    group.findings.push(finding);
    group.topics.add(topicOf.get(finding.scenarioId) ?? scenario.topic);
    groups.set(key, group);
  }
  const conversations = (findings: readonly Finding[], hit: (finding: Finding) => boolean) => new Set(findings.filter(hit).map(finding => finding.dialogueId)).size;
  const contract = analysis.logs.contract;
  const views = [...groups].map(([key, group]): ProblemView => {
    const violated = group.findings.filter(counted);
    const decided = (finding: Finding) => finding.result !== 'unknown';
    // A failure of a criterion that requires a tool's call, where the complete conversation under the owner's contract holds none: the action was not made.
    const tool = group.criterion.observation === 'tool' ? group.criterion.tool : undefined;
    const absent = (finding: Finding) => !!tool && !!contract?.tools.includes(tool) && !!batch?.dialogues.find(dialogue => dialogue.id === finding.dialogueId && dialogue.observation === 'complete'
      && !dialogue.events.some(event => event.type === 'tool' && (event.data as { tool?: unknown } | null)?.tool === tool));
    // The examples: the counted violations first, then those the owner disputed — shown with their mark, never dropped.
    const failed = group.findings.filter(finding => finding.result === 'fail');
    const examples = [...violated, ...failed.filter(finding => !violated.includes(finding))].slice(0, 5).map((finding): Example => {
      const review = reviews.get(finding.key)?.verdict;
      // One quote an event, in the order of the conversation: the votes may cite the same message twice.
      const quotes = [...finding.evidence].sort((a, b) => a.seq - b.seq).filter((item, index, all) => all.findIndex(other => other.seq === item.seq) === index);
      return { key: finding.key, dialogueId: finding.dialogueId, quotes: quotes.map(item => ({ seq: item.seq, role: roleOf(batch, finding.dialogueId, item.seq), quote: oneLine(item.quote) })),
        ...(finding.rationale ? { rationale: oneLine(finding.rationale) } : {}), ...(review ? { review } : {}), ...(absent(finding) ? { absent: tool! } : {}) };
    });
    // A pass, complete and with its evidence, that the owner did not take back: their «нарушение есть» or «не уверен» on it does.
    const held = (finding: Finding) => {
      const word = reviews.get(finding.key)?.verdict;
      return finding.result === 'pass' && finding.complete && !finding.skipped && finding.evidence.length > 0 && (word === undefined || word === 'disputed');
    };
    const passed = [...new Set(group.findings.filter(held).map(finding => finding.dialogueId))]
      .filter(dialogueId => group.findings.every(finding => finding.dialogueId !== dialogueId || held(finding)));
    return { key, criterion: group.criterion, duty: group.duty, rules: group.rules, topics: [...group.topics], dialogueIds: [...new Set(violated.map(finding => finding.dialogueId))], held: passed,
      violations: conversations(group.findings, counted), checked: conversations(group.findings, decided),
      unknown: conversations(group.findings, finding => finding.result === 'unknown' && !group.findings.some(other => other.dialogueId === finding.dialogueId && decided(other))),
      confirmed: conversations(group.findings, finding => finding.result === 'fail' && reviews.get(finding.key)?.verdict === 'confirmed'),
      disputed: conversations(group.findings, finding => finding.result === 'fail' && reviews.get(finding.key)?.verdict === 'disputed'), examples };
  });

  const undecided = new Map<FindingUndecided, number>();
  for (const finding of analysis.findings) {
    const reason = findingUndecided(finding);
    if (reason) undecided.set(reason, (undecided.get(reason) ?? 0) + 1);
  }
  const picked = analysis.selection.picked;
  const extra = new Set(analysis.topics.flatMap(group => group.extra ?? []));
  const judged = new Set(analysis.findings.map(finding => finding.dialogueId));
  const decidedOn = new Set(analysis.findings.filter(finding => finding.result !== 'unknown').map(finding => finding.dialogueId));
  const unjudgeable = (['no_customer', 'no_agent_reply'] as const).map(reason => ({ reason, count: analysis.selection.unjudgeable.filter(item => item.reason === reason).length }))
    .filter(item => item.count);
  const traffic = analysis.traffic && { labeled: analysis.traffic.labeled, topics: analysis.traffic.topics };
  return {
    id: analysis.id, status: analysis.status, ...(analysis.unfinished ? { unfinished: analysis.unfinished } : {}), ...(analysis.error ? { error: analysis.error } : {}),
    message: analysis.message, file: analysis.logs.file, mode: analysis.mode, createdAt: analysis.createdAt,
    coverage: { logged: analysis.logs.conversations, readable: analysis.logs.readable, judgeable: analysis.logs.readable - analysis.selection.unjudgeable.length,
      unjudgeable, picked: picked.length, method: analysis.selection.method, perTopic: analysis.selection.perTopic, ...(analysis.selection.beyond ? { beyond: analysis.selection.beyond } : {}),
      processed: picked.filter(id => judged.has(id)).length,
      decided: picked.filter(id => decidedOn.has(id)).length, undecided: picked.filter(id => judged.has(id) && !decidedOn.has(id)).length,
      notReached: picked.filter(id => !judged.has(id)).length, sharedOnly: picked.filter(id => extra.has(id) && judged.has(id)).length },
    ...(analysis.continues ? { continues: analysis.continues } : {}), ...(contract ? { recorded: [...contract.tools] } : {}),
    ...(traffic ? { traffic: traffic.topics.map(topic => ({ title: topic.title, dialogues: topic.dialogues, share: topic.dialogues / traffic.labeled,
      picked: analysis.topics.find(group => group.topicId === topic.id)?.dialogueIds.length ?? 0 })) } : {}),
    problems: views.filter(view => view.violations > 0).sort((a, b) => b.violations - a.violations || b.checked - a.checked),
    overruled: views.filter(view => view.violations === 0 && view.disputed > 0),
    clean: views.filter(view => view.violations === 0 && view.checked > 0).map(view => ({ text: view.duty.text, checked: view.checked, disputed: view.disputed, key: view.key, held: view.held, topics: view.topics })),
    undecided: [...undecided].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    gaps: analysis.topics.flatMap(group => group.planFailure ? [{ title: group.title, reason: group.planFailure, ...(group.planIssue ? { issue: group.planIssue } : {}),
      ...(group.rulesGap ? { rulesGap: group.rulesGap } : {}), conversations: group.dialogueIds.length + (group.extra?.length ?? 0) }] : []),
    models: analysis.models, budget: analysis.budget,
  };
}

/** A finding of the analysis by its key, with the problem it belongs to; undefined for a key the analysis does not have. */
export function findingOf(analysis: LogAnalysis, key: string): Finding | undefined {
  return analysis.findings.find(finding => finding.key === key);
}

/** Every criterion of the analysis with where it held with evidence: the problems and the rules kept everywhere they were decided. */
export function criteriaHeld(view: Pick<AnalysisView, 'problems' | 'clean'>): { key: string; held: string[]; topics: string[] }[] {
  return [...view.problems, ...view.clean].map(item => ({ key: item.key, held: item.held, topics: item.topics }));
}
