/*
 * C — what a rule requires is kept apart from what the logs observe (item 1). A rule requires a call of create_refund; the
 * logs hold the agent's words «возврат оформлен», a call of another tool, a partly recorded conversation, the call itself.
 * The criterion stays an action on create_refund whatever the logs hold; words never pass it; a missing call is a failure
 * only where the owner's contract says the log records every call of that tool, and «не видно» everywhere else.
 */
import { join } from 'node:path';
import { planSlips, type PlanCall, type PlanProposal } from '../../src/card/plan.js';
import { judgeLogged, logProtocolHash, type logJudgeInput } from '../../src/card/log-judge.js';
import { settingsSchema } from '../../src/contracts.js';
import { exampleLine } from '../../src/discover/text.js';
import { analysisView } from '../../src/discover/view.js';
import { ExperimentLab } from '../../src/experiment.js';
import type { AnalyzeInput } from '../../src/lab/discover.js';
import type { Runtime } from '../../src/runtime.js';
import { importBatch } from '../../src/scenario-library.js';
import { claim, folder } from './common.js';

const REFUND_RULE = 'Возврат оплаты агент оформляет только инструментом create_refund.';
const ASK = 'Верните деньги за заказ 42, пожалуйста.';
const SAID = 'Готово, возврат оформлен.';
type Row = { id: string; observation: 'complete' | 'partial'; events: Record<string, unknown>[] };
const row = (id: string, observation: Row['observation'], tool?: 'find_order' | 'create_refund'): Row => ({ id, observation, events: [
  { type: 'message', role: 'user', content: `${ASK} (${id})` },
  ...(tool === 'find_order' ? [{ type: 'tool', tool: 'find_order', content: 'order 42: paid 1500' }] : tool === 'create_refund' ? [{ type: 'tool', tool: 'create_refund', content: 'refund 42 created: 1500' }] : []),
  { type: 'message', role: 'assistant', content: SAID }] });

/** A planner that reads the rule and requires the call it names, in the shape the call asks. */
const planner = (offered: PlanCall['channels'][]): Pick<Runtime, 'proposeScenario'> => ({
  async proposeScenario(input) {
    offered.push(input.call.channels);
    return { question: 'Клиент просит вернуть оплату', variations: [{ title: 'Клиент просит вернуть оплату за заказ', examples: input.call.examples.map(example => example.dialogueId) }],
      expectations: [{ text: 'оформить возврат инструментом create_refund', strength: 'must', acceptable: null, violation: 'агент говорит, что возврат оформлен, а create_refund не вызван',
        basis: [{ sourceId: 'source-1', quote: REFUND_RULE, kind: 'behavior' }], variations: null, observation: 'tool', tool: 'create_refund' }], uncovered: null } as unknown as PlanProposal;
  },
});

type JudgeEvent = { seq: number; type: string; content: string; tool?: string };
/**
 * A judge in the judge's own answer format. `rubric`: passes on a create_refund result, fails on the agent's claim without
 * one. `credulous`: passes on the agent's words, citing whatever it sees — the channel rule must not let it through.
 */
function judge(kind: 'rubric' | 'credulous', asked: string[]): Runtime['logJudge'] {
  return { provider: 'stub', model: `${kind}-judge`, protocolHash: logProtocolHash(), assess: (request, ctx) => judgeLogged(request, { provider: 'stub', id: `${kind}-judge` }, ctx,
    async (_prompt, input) => {
      const data = JSON.parse(input) as { scenario: { metrics: { id: string }[] }; dialogue: { events: JudgeEvent[] } };
      const events = data.dialogue.events;
      asked.push(events.find(event => event.type === 'user')!.content);
      const refund = events.find(event => event.type === 'tool_result' && event.tool === 'create_refund');
      const claimEvent = events.find(event => event.type === 'assistant')!;
      const cited = kind === 'credulous' ? events.filter(event => event.type !== 'user') : refund ? [refund] : [claimEvent];
      const pass = kind === 'credulous' || !!refund;
      return JSON.stringify({ assessments: [{ metricId: data.scenario.metrics[0]!.id, rationale: refund ? 'create_refund вернул результат.' : 'Агент говорит, что возврат оформлен.',
        evidence: cited.map(event => event.seq), citations: cited.map(event => ({ seq: event.seq, quote: event.content })), passCondition: pass ? 'met' : 'not_met', failCondition: pass ? 'not_met' : 'met' }] });
    }) };
}

async function analyse(name: string, rows: Row[], runtime: Runtime, contract?: string[]) {
  const lab = new ExperimentLab(join(await folder(name), '.agent-lab'), runtime);
  await lab.init();
  try {
    const input: AnalyzeInput = { task: 'Бот оформляет возвраты', mode: 'live', file: 'журнал возвратов', materials: [{ name: 'Правило возвратов', content: REFUND_RULE }],
      logs: importBatch(rows), settings: settingsSchema.parse({ timeoutMs: 60000 }), ...(contract ? { logContract: { tools: contract, via: 'cli-yes' as const } } : {}) };
    const started = await lab.analyze(input, { callCeiling: 200 });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    const batch = await lab.store.readImport(analysis.logs.importId);
    const audit = async (dialogueId: string) => { const found = analysis.findings.find(item => item.dialogueId === dialogueId); return found && lab.store.readAnalysisAudit(analysis.id, found.key); };
    return { analysis, view: analysisView(analysis, batch), finding: (id: string) => analysis.findings.find(item => item.dialogueId === id), audit };
  } finally { await lab.close(); }
}

export async function proofChannels(): Promise<void> {
  // (1) Every log holds only the words: the criterion stays an action on create_refund, and the words never pass it.
  let offered: PlanCall['channels'][] = [];
  let asked: string[] = [];
  const words = await analyse('c-words', [row('w1', 'complete'), row('w2', 'complete')], { ...planner(offered), logJudge: judge('credulous', asked) });
  const expectation = words.analysis.scenarios[0]?.expectations[0];
  claim('C', expectation?.observation === 'tool' && expectation.tool === 'create_refund' && offered[0]?.tools.length === 0 && offered[0]?.byRule === true,
    `(1) no log shows a tool call (plan offered ${JSON.stringify(offered[0])}), yet the rule's criterion stays an action: observed on ${expectation?.observation}, tool ${expectation?.tool}`);
  claim('C', words.analysis.findings.every(item => item.result === 'unknown' && item.skipped === 'call_unconfirmed') && !asked.length && !words.view.problems.length,
    `(1) «${SAID}» alone: every finding ${JSON.stringify(words.analysis.findings.map(item => [item.dialogueId, item.result, item.skipped]))}; a credulous judge was never asked (${asked.length} calls) — words give no PASS`);
  const call = { topic: { title: 't' }, examples: [{ dialogueId: 'w1', customer: [ASK] }], sources: [{ id: 'source-1', name: 'Правило', content: REFUND_RULE }] as PlanCall['sources'],
    binds: { kinds: ['behavior' as const], rules: [] }, channels: { tools: [], toolEvents: false, state: false, byRule: true as const }, gaps: true as const } satisfies PlanCall;
  const invented = { question: 'q', variations: [{ title: 'v', examples: ['w1'] }], uncovered: null,
    expectations: [{ text: 'оформить возврат', strength: 'must', acceptable: null, violation: null, basis: [{ sourceId: 'source-1', quote: REFUND_RULE, kind: 'behavior' }], variations: null, observation: 'tool', tool: 'issue_refund' }] } as unknown as PlanProposal;
  claim('C', planSlips(invented, call).some(slip => slip.text.includes('"issue_refund"')),
    '(1) the harness refuses a tool the rule does not name and no log shows (issue_refund): a required tool is the rule\'s own word, never invented');

  // (2) The logs show find_order, never create_refund: the requirement does not vanish because it was never seen.
  offered = []; asked = [];
  const found = await analyse('c-found', [row('f1', 'complete', 'find_order'), row('p1', 'partial')], { ...planner(offered), logJudge: judge('credulous', asked) });
  claim('C', JSON.stringify(offered[0]?.tools) === '["find_order"]' && found.analysis.scenarios[0]?.expectations[0]?.tool === 'create_refund',
    `(2) the logs recorded ${JSON.stringify(offered[0]?.tools)} only; the criterion still requires ${found.analysis.scenarios[0]?.expectations[0]?.tool}`);
  // (3) An incomplete journal never proves the call was absent; nor does a complete one without the owner's contract.
  claim('C', found.finding('p1')?.result === 'unknown' && found.finding('p1')?.skipped === 'channel_unobserved' && found.finding('f1')?.skipped === 'call_unconfirmed' && !asked.length,
    `(3) partial log → ${found.finding('p1')?.skipped}; complete log with no contract → ${found.finding('f1')?.skipped}; both UNKNOWN with the reason, the judge not asked`);

  // (4) The owner's contract: the log records every call of create_refund. Absent where required → FAIL; not observable → UNKNOWN.
  asked = [];
  const rows = [row('f1', 'complete', 'find_order'), row('w1', 'complete'), row('p1', 'partial'), row('r1', 'complete', 'create_refund')];
  const contract = await analyse('c-contract', rows, { ...planner([]), logJudge: judge('rubric', asked) }, ['create_refund']);
  const example = contract.view.problems[0]?.examples.find(item => item.dialogueId === 'f1');
  claim('C', contract.finding('f1')?.result === 'fail' && contract.finding('w1')?.result === 'fail' && example?.absent === 'create_refund',
    `(4) under the contract, complete logs with no create_refund: f1 ${contract.finding('f1')?.result}, w1 ${contract.finding('w1')?.result} — «${example ? exampleLine(example) : ''}»`);
  claim('C', contract.finding('p1')?.result === 'unknown' && contract.finding('p1')?.skipped === 'channel_unobserved' && !asked.some(text => text.includes('(p1)')),
    `(4) the partial conversation stays «not observable» even under the contract: ${contract.finding('p1')?.skipped} → ${contract.finding('p1')?.result}`);
  // (5) A confirmed result of the required tool passes; another tool's result never stands in for it.
  const refund = contract.finding('r1');
  claim('C', refund?.result === 'pass' && refund.evidence.some(item => item.quote.includes('refund 42 created')),
    `(5) complete log with the create_refund result: ${refund?.result} on ${JSON.stringify(refund?.evidence)}`);
  const credulous = await analyse('c-credulous', rows, { ...planner([]), logJudge: judge('credulous', []) }, ['create_refund']);
  claim('C', credulous.finding('f1')?.result === 'unknown' && credulous.finding('w1')?.result === 'unknown' && credulous.finding('r1')?.result === 'pass',
    `(5) a judge voting pass on the words and find_order's result: f1 ${credulous.finding('f1')?.result}, w1 ${credulous.finding('w1')?.result} (channel rule), r1 ${credulous.finding('r1')?.result}`);
  const audit = await contract.audit('f1');
  const sent = audit ? JSON.parse(audit.input) as ReturnType<typeof logJudgeInput> : undefined;
  claim('C', new Set(contract.analysis.findings.map(item => item.criterionHash)).size === 1 && sent?.scenario.execution.expectations[0]?.observation === 'tool' && sent.mode === 'logged-v2',
    'every finding carries one criterion hash; the judge was sent the frozen logged-v2 input with the tool expectation');
}
