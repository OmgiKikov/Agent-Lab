import { fingerprint } from '../contracts.js';
import { logUndecided, type LogUndecided } from '../card/log-judge.js';
import { normalizeText } from '../card/checks.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { oneLine } from '../text.js';
import type { Finding, FindingReview, LogAnalysis } from './schema.js';

/*
 * What a log analysis found, derived once from its record (DISCOVER): pure, no I/O and no model — every surface lays
 * out these rows and words them through discover/text.ts.
 *
 *   coverage   every conversation of the log ─► read ─► judgeable ─► analysed ─► decided on at least one rule
 *   traffic    the topics of all read conversations: what customers come with — never mixed with the violations
 *   problems   violations grouped by the rule and the behaviour it asks (not by topic), each with how many of the
 *              conversations it was decided on it broke, what could not be decided, and the conversations that show it
 *   gaps       topics no rule of the owner was found for: a gap in the rules, never a violation
 *
 * A violation counts in a conversation where the judge found it and the owner did not dispute it; the owner's word is
 * read beside the judge's (the latest per finding), never instead of the record.
 */

export interface Quote { seq: number; role: 'customer' | 'agent' | 'other'; quote: string }
export interface Example { key: string; dialogueId: string; quotes: Quote[]; rationale?: string; review?: FindingReview['verdict'] }
export interface ProblemView {
  /** The rule and the behaviour it asks: the same across topics and analyses whose plans say the same. */
  key: string;
  duty: { text: string; mustNot: boolean; acceptable?: string; violation?: string };
  rules: { quote: string; source: string }[];
  topics: string[];
  /** Conversations where it was broken (not disputed by the owner), where it was decided at all, and where it was not. */
  violations: number; checked: number; unknown: number;
  /** Every conversation it was broken in, in the order of the findings. */
  dialogueIds: string[];
  confirmed: number; disputed: number;
  examples: Example[];
}
export interface AnalysisView {
  id: string; status: LogAnalysis['status']; unfinished?: LogAnalysis['unfinished']; error?: string; message: string;
  file: string; mode: LogAnalysis['mode']; createdAt: string;
  coverage: {
    logged: number; readable: number; judgeable: number;
    unjudgeable: { reason: LogAnalysis['selection']['unjudgeable'][number]['reason']; count: number }[];
    picked: number; method: LogAnalysis['selection']['method']; perTopic: number;
    /** Analysed conversations decided on at least one rule, those judged but decided on none, those no rule reached. */
    decided: number; undecided: number; notReached: number;
  };
  traffic?: { title: string; dialogues: number; share: number; picked: number }[];
  problems: ProblemView[];
  /** Rules decided on at least one conversation and broken in none; `disputed`: the judge's violations the owner disputed. */
  clean: { text: string; checked: number; disputed: number }[];
  undecided: { reason: LogUndecided; count: number }[];
  gaps: { title: string; reason: NonNullable<LogAnalysis['topics'][number]['planFailure']>; conversations: number }[];
  models: LogAnalysis['models'];
  budget: LogAnalysis['budget'];
}

/** The latest word of the owner on each finding. */
function latestReviews(reviews: readonly FindingReview[]): Map<string, FindingReview> {
  const latest = new Map<string, FindingReview>();
  for (const review of reviews) latest.set(review.key, review);
  return latest;
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

  // Problems: the findings of one duty — its rules and its words — over every topic that has it.
  const groups = new Map<string, { findings: Finding[]; duty: ProblemView['duty']; rules: ProblemView['rules']; topics: Set<string> }>();
  for (const finding of analysis.findings) {
    const scenario = analysis.scenarios.find(item => item.id === finding.scenarioId);
    const expectation = scenario?.expectations.find(item => item.id === finding.expectationId);
    if (!scenario || !expectation) continue;
    const rules = analysis.requirements.filter(requirement => expectation.requirementIds.includes(requirement.id))
      .map(requirement => ({ quote: requirement.quote, source: sourceName.get(requirement.sourceId) ?? requirement.sourceId }));
    const key = fingerprint({ rules: rules.map(rule => rule.quote).sort(), mustNot: expectation.strength === 'must_not', text: normalizeText(expectation.text) });
    const group = groups.get(key) ?? { findings: [], rules, topics: new Set<string>(),
      duty: { text: expectation.text, mustNot: expectation.strength === 'must_not', ...(expectation.acceptable ? { acceptable: expectation.acceptable } : {}), ...(expectation.violation ? { violation: expectation.violation } : {}) } };
    group.findings.push(finding);
    group.topics.add(topicOf.get(finding.scenarioId) ?? scenario.topic);
    groups.set(key, group);
  }
  const conversations = (findings: readonly Finding[], hit: (finding: Finding) => boolean) => new Set(findings.filter(hit).map(finding => finding.dialogueId)).size;
  const views = [...groups].map(([key, group]): ProblemView => {
    const violated = group.findings.filter(counted);
    const decided = (finding: Finding) => finding.result !== 'unknown';
    const examples = violated.slice(0, 5).map((finding): Example => {
      const review = reviews.get(finding.key)?.verdict;
      // One quote an event, in the order of the conversation: the votes may cite the same message twice.
      const quotes = [...finding.evidence].sort((a, b) => a.seq - b.seq).filter((item, index, all) => all.findIndex(other => other.seq === item.seq) === index);
      return { key: finding.key, dialogueId: finding.dialogueId, quotes: quotes.map(item => ({ seq: item.seq, role: roleOf(batch, finding.dialogueId, item.seq), quote: oneLine(item.quote) })),
        ...(finding.rationale ? { rationale: oneLine(finding.rationale) } : {}), ...(review ? { review } : {}) };
    });
    return { key, duty: group.duty, rules: group.rules, topics: [...group.topics], dialogueIds: [...new Set(violated.map(finding => finding.dialogueId))],
      violations: conversations(group.findings, counted), checked: conversations(group.findings, decided),
      unknown: conversations(group.findings, finding => finding.result === 'unknown' && !group.findings.some(other => other.dialogueId === finding.dialogueId && decided(other))),
      confirmed: conversations(group.findings, finding => finding.result === 'fail' && reviews.get(finding.key)?.verdict === 'confirmed'),
      disputed: conversations(group.findings, finding => finding.result === 'fail' && reviews.get(finding.key)?.verdict === 'disputed'), examples };
  });

  const undecided = new Map<LogUndecided, number>();
  for (const finding of analysis.findings) {
    const reason = logUndecided(finding);
    if (reason) undecided.set(reason, (undecided.get(reason) ?? 0) + 1);
  }
  const picked = analysis.selection.picked;
  const judged = new Set(analysis.findings.map(finding => finding.dialogueId));
  const decidedOn = new Set(analysis.findings.filter(finding => finding.result !== 'unknown').map(finding => finding.dialogueId));
  const unjudgeable = (['no_customer', 'no_agent_reply'] as const).map(reason => ({ reason, count: analysis.selection.unjudgeable.filter(item => item.reason === reason).length }))
    .filter(item => item.count);
  const traffic = analysis.traffic && { labeled: analysis.traffic.labeled, topics: analysis.traffic.topics };
  return {
    id: analysis.id, status: analysis.status, ...(analysis.unfinished ? { unfinished: analysis.unfinished } : {}), ...(analysis.error ? { error: analysis.error } : {}),
    message: analysis.message, file: analysis.logs.file, mode: analysis.mode, createdAt: analysis.createdAt,
    coverage: { logged: analysis.logs.conversations, readable: analysis.logs.readable, judgeable: analysis.logs.readable - analysis.selection.unjudgeable.length,
      unjudgeable, picked: picked.length, method: analysis.selection.method, perTopic: analysis.selection.perTopic,
      decided: picked.filter(id => decidedOn.has(id)).length, undecided: picked.filter(id => judged.has(id) && !decidedOn.has(id)).length,
      notReached: picked.filter(id => !judged.has(id)).length },
    ...(traffic ? { traffic: traffic.topics.map(topic => ({ title: topic.title, dialogues: topic.dialogues, share: topic.dialogues / traffic.labeled,
      picked: analysis.topics.find(group => group.topicId === topic.id)?.dialogueIds.length ?? 0 })) } : {}),
    problems: views.filter(view => view.violations > 0).sort((a, b) => b.violations - a.violations || b.checked - a.checked),
    clean: views.filter(view => view.violations === 0 && view.checked > 0).map(view => ({ text: view.duty.text, checked: view.checked, disputed: view.disputed })),
    undecided: [...undecided].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    gaps: analysis.topics.flatMap(group => group.planFailure ? [{ title: group.title, reason: group.planFailure, conversations: group.dialogueIds.length }] : []),
    models: analysis.models, budget: analysis.budget,
  };
}

/** A finding of the analysis by its key, with the problem it belongs to; undefined for a key the analysis does not have. */
export function findingOf(analysis: LogAnalysis, key: string): Finding | undefined {
  return analysis.findings.find(finding => finding.key === key);
}
