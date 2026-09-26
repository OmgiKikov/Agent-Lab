import type { LogAnalysis } from '../src/discover/schema.js';
import { analysisLines, coverageLines, exampleLine, headline, limitLines, nextStep, problemSize, problemTitle, trafficLine, unansweredLine } from '../src/discover/text.js';
import { analysisView, type AnalysisView } from '../src/discover/view.js';
import type { ExperimentLab } from '../src/experiment.js';
import { clip, safeText } from '../src/text.js';
import { row } from './conversation.ts';
import type { Feed } from './render/feed.ts';

/*
 * A log analysis for the chat (DISCOVER): the model's JSON — what was analysed, the violations with how often among the
 * conversations they were checked on, verbatim examples, what could not be decided and the limits — and the rows the
 * owner reads: the answer first, the three largest problems with one example each, everything else under ctrl+o. The
 * words are discover/text.ts's; nothing here words the result anew.
 */

/** When the analysis was made, as the note of its row names it: never a title or a quote. */
const stampOf = (analysis: Pick<LogAnalysis, 'createdAt'>): string => new Date(analysis.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** An example by its place: «1.2» — the second example of the first problem, as the owner and the model name it. */
export function exampleAt(view: AnalysisView, place: { problem: number; example?: number }) {
  const problem = view.problems[place.problem - 1];
  const example = problem?.examples[(place.example ?? 1) - 1];
  return problem && example ? { problem, example } : undefined;
}

/** What the model reads of an analysis, and what it is asked to do with it. */
export function analysisOutput(view: AnalysisView): Record<string, unknown> {
  return {
    ...(view.checking ? { checking: view.checking, facts: view.facts } : {}),
    analysis: view.id, status: view.status, ...(view.unfinished ? { unfinished: view.unfinished } : {}), file: view.file,
    selected: view.coverage.picked, analysed: view.coverage.processed, notReached: view.coverage.notReached, of: view.coverage.logged, decidedIn: view.coverage.decided,
    unansweredConversations: view.coverage.unjudgeable.find(item => item.reason === 'no_agent_reply')?.count ?? 0,
    ...(view.coverage.sharedOnly ? { judgedOnSharedRulesOnly: view.coverage.sharedOnly } : {}), ...(view.continues ? { continues: view.continues.analysisId, reusedFindings: view.continues.reused } : {}),
    ...(view.coverage.fitted ? { fittedToTopicPlan: view.coverage.fitted } : {}), ...(view.coverage.ownPlan ? { judgedUnderOwnPlan: view.coverage.ownPlan } : {}),
    // Why the analysis ended short, in the owner's words: said as it is, never as a gap in the owner's rules.
    ...(view.status !== 'done' && view.status !== 'running' ? { ended: analysisLines(view)[1] } : {}),
    ...(view.recorded ? { logRecordsEveryCallOf: view.recorded } : {}),
    ...(view.traffic ? { traffic: view.traffic.map(topic => ({ topic: topic.title, share: Math.round(topic.share * 100) / 100 })) } : {}),
    problems: view.problems.map((problem, index) => ({
      number: index + 1, violation: problemTitle(problem), size: problemSize(problem), inConversations: problem.violations, checkedIn: problem.checked, notDecidedIn: problem.unknown,
      knowledgeOnly: problem.knowledgeOnly,
      rules: problem.rules.map(rule => ({ quote: clip(rule.quote, 400), source: rule.source })), topics: problem.topics,
      examples: problem.examples.slice(0, 3).map((example, place) => ({ example: `${index + 1}.${place + 1}`, conversation: example.dialogueId,
        said: example.quotes.map(quote => ({ by: quote.role, quote: clip(quote.quote, 400) })), ...(example.rationale ? { judge: clip(example.rationale, 600) } : {}),
        ...(example.review ? { owner: example.review } : {}) })),
    })),
    ...(view.checking === 'facts' ? { supportedFacts: view.clean.map(item => ({ fact: item.text, checkedIn: item.checked })) }
      : { noViolations: view.clean.map(item => ({ rule: item.text, checkedIn: item.checked })) }),
    ...(view.overruled.length ? { disputedByOwner: view.overruled.map(problem => ({ violation: problemTitle(problem), disputed: problem.disputed })) } : {}),
    notDecided: coverageLines(view),
    gaps: view.gaps.map(gap => ({ topic: gap.title, reason: gap.reason, ...(gap.issue ? { labWorkUnfinished: gap.issue } : {}),
      ...(gap.rulesGap ? { rulesGap: gap.rulesGap.confirmed ? 'confirmed by the reviewer' : 'not confirmed: Lab\'s reading, not the owner\'s gap' } : {}), conversations: gap.conversations })),
    limits: limitLines(view), next: nextStep(view),
    instruction: 'This is an analysis of logged conversations (no situation was made, the agent did not run). Tell the owner in 3–6 short Russian sentences: '
      + (view.checking === 'facts' ? 'This is a factual comparison of actual assertions, not a bot-duty checklist. Report supported, contradicted and unknown claims separately. For a possible contradiction show the assistant quote and the reference quote. Do not ask whether a handoff was allowed or whether an employee step was mandatory: this check makes neither judgment. The owner can confirm the factual contradiction before turning it into a regression check. ' : '')
      + 'how many conversations were analysed (analysed) of those selected (selected) and of how many in the log; the main violations, each with how often among the conversations it was checked on and one verbatim example; '
      + 'what could not be decided and why; that the frequency is among the analysed conversations, not all traffic. Present findings as possible issues, never established breaches. For rule-based analyses only, a knowledgeOnly finding needs the owner to decide whether these facts were required in that reply and whether a handoff was allowed. If unansweredConversations is positive, name it as a separate signal whose cause needs checking, never as a judged violation. Do not invent findings. '
      + 'A gap is the owner\'s missing rule only when rulesGap is confirmed; labWorkUnfinished is Lab\'s own work not finishing — never ask the owner to add a rule for it. '
      + 'Offer ONE next step from `next`: to say whether the judge is right about an example (agent_lab_analyze with review {problem, example}; the host asks the owner, you never pass the verdict), '
      + 'to continue with the next conversations (agent_lab_analyze with analysis and more; the host asks the owner), to open it in /agent-lab, '
      + 'or to make a check of a new agent version from a problem (agent_lab_prepare with fromAnalysis {analysis, problem}).',
  };
}

/** The answer of an analysis — in the row of its call, or as the message of one that outlived it. */
export async function analysisAnswer(lab: ExperimentLab, analysis: LogAnalysis): Promise<{ output: Record<string, unknown>; feed: Feed; note: string; stamp: string }> {
  const batch = await lab.store.readImport(analysis.logs.importId).catch(() => undefined);
  const view = analysisView(analysis, batch);
  const top = view.problems.slice(0, 3);
  const lines = analysisLines(view, { examples: 2 });
  const unanswered = unansweredLine(view);
  const rows = [row(safeText(headline(view)), view.problems.length || view.status !== 'done' ? 'warning' : undefined, true),
    ...(view.status !== 'done' ? [row(safeText(lines.find(line => line.startsWith('Разбор не закончен:')) ?? analysis.message), 'warning')] : []),
    ...(unanswered ? [row(safeText(unanswered), 'warning')] : []),
    ...top.flatMap((problem, index) => [row(safeText(`${index + 1}. ${problemTitle(problem)} — ${problemSize(problem)}${problem.knowledgeOnly ? ' · по базе знаний, требуется ваша оценка' : ''}`)),
      ...problem.examples.slice(0, 1).map(example => row(safeText(exampleLine(example)), 'muted', false, 3))]),
    ...(view.problems.length > top.length ? [row(`…и ещё ${view.problems.length - top.length}`, 'muted')] : []),
    row(safeText(nextStep(view)), 'muted')];
  const traffic = trafficLine(view);
  const uncertainFacts = view.facts && (view.facts.unknown > 0 || view.facts.failed > 0 || view.coverage.decided === 0);
  const feed: Feed = { title: view.status === 'done' ? 'Разбор логов' : 'Разбор логов не закончен', tone: view.status === 'done' ? (view.problems.length || unanswered || uncertainFacts ? 'warning' : 'success') : 'warning',
    rows, more: [...(traffic ? [row(safeText(traffic), 'muted')] : []), ...lines.slice(1).map(line => row(safeText(line), 'muted'))], expand: 'весь разбор' };
  return { output: analysisOutput(view), feed, note: `Разбор логов · ${stampOf(analysis)}`, stamp: analysis.updatedAt };
}
