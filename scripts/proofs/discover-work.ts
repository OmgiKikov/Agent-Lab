/*
 * F — Lab's failure is never the owner's rules (item 3): a planner answer that fails the schema, a quote not verbatim, a
 * request over the model's window are Lab's work not finishing; a gap the planner reports is the owner's only once the
 * reviewer confirms it.
 * G — DISCOVER does not end at 8 conversations a topic (item 4): 40 conversations of one topic, the first sample bounded,
 * the conversations beyond the plan's examples fitted to its variations before they are judged — one no variation fits
 * gets a plan of its own —, a stop said as a stop, a continuation that pays only for the new conversations, frequency
 * never as all traffic.
 */
import { join } from 'node:path';
import { planSlips, type PlanCall, type PlanProposal } from '../../src/card/plan.js';
import { GAP_CLAIM } from '../../src/card/review.js';
import { judgeLogged, logProtocolHash } from '../../src/card/log-judge.js';
import { settingsSchema } from '../../src/contracts.js';
import { continuationConsentText } from '../../src/discover/consent.js';
import { analysisLines, gapLine, headline, limitLines, nextStep } from '../../src/discover/text.js';
import { analysisView } from '../../src/discover/view.js';
import { ExperimentLab } from '../../src/experiment.js';
import type { AnalyzeInput } from '../../src/lab/discover.js';
import { ProviderFailure } from '../../src/llm/model-call.js';
import { StructuredTaskError } from '../../src/llm/structured.js';
import { buildTopicMap, type TopicTaskRunner } from '../../src/miner/topic-map.js';
import type { Runtime } from '../../src/runtime.js';
import { importBatch } from '../../src/scenario-library.js';
import { claim, folder } from './common.js';

export const EXPLAIN = 'Если клиент просит вернуть оплату, объясните, как оформить возврат.';
const ASK_ORDER = 'Если номера заказа нет, спросите номер заказа.';
export const RULES = `${EXPLAIN} ${ASK_ORDER}`;
const conversations = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `c${String(index + 1).padStart(2, '0')}`,
  messages: [{ role: 'user', content: `Верните оплату, пожалуйста (${index + 1}).` }, { role: 'assistant', content: 'Подайте заявление в поддержку.' }] }));

/** A judge that passes on the agent's reply, in the judge's own format; `calls` counts its votes. */
export function passingJudge(calls: { count: number }, onCall?: () => void): Runtime['logJudge'] {
  return { provider: 'stub', model: 'stub-judge', protocolHash: logProtocolHash(), assess: (request, ctx) => judgeLogged(request, { provider: 'stub', id: 'stub-judge' }, ctx, async (_prompt, input) => {
    calls.count++; onCall?.();
    const data = JSON.parse(input) as { scenario: { metrics: { id: string }[] }; dialogue: { events: { seq: number; type: string; content: string }[] } };
    const reply = data.dialogue.events.find(event => event.type === 'assistant')!;
    return JSON.stringify({ assessments: [{ metricId: data.scenario.metrics[0]!.id, rationale: 'Агент объяснил.', evidence: [reply.seq], citations: [{ seq: reply.seq, quote: reply.content }], passCondition: 'met', failCondition: 'not_met' }] });
  }) };
}

/** A plan that binds: one shared expectation, one of the first variation only. */
export function goodPlan(call: PlanCall): PlanProposal {
  const ids = call.examples.map(example => example.dialogueId);
  return { question: 'Клиент просит вернуть оплату', variations: [{ title: 'Номер заказа назван', examples: ids.slice(0, 4) }, { title: 'Номера заказа нет', examples: ids.slice(4) }],
    expectations: [
      { text: 'объяснить, как оформить возврат', strength: 'must', acceptable: null, violation: null, basis: [{ sourceId: 'source-1', quote: EXPLAIN, kind: 'behavior' }], variations: null, observation: 'reply', tool: null },
      { text: 'спросить номер заказа', strength: 'must', acceptable: null, violation: null, basis: [{ sourceId: 'source-1', quote: ASK_ORDER, kind: 'behavior' }], variations: [1], observation: 'reply', tool: null },
    ], uncovered: null } as unknown as PlanProposal;
}

/** One topic for every conversation: the stub's topic map, through the real map builder and its checks. */
const oneTopic: TopicTaskRunner = async (task, input) => {
  const items = task.id === 'topic-classification' ? (input as { conversations: { dialogueId: string }[] }).conversations : [];
  const value = task.output.parse(task.id === 'topic-proposal' ? { topics: [{ title: 'Возврат оплаты', description: 'Клиент просит вернуть оплату.' }] }
    : { assignments: items.map(({ dialogueId }) => ({ dialogueId, topicId: 't1' })) });
  const problem = task.check?.(value);
  if (problem) throw new Error(typeof problem === 'string' ? problem : problem.reason);
  return value;
};
const BUILDER = { provider: 'stub', id: 'stub-builder' };
export const topicMap: Runtime['topicMap'] = { builder: BUILDER, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder: BUILDER, run: oneTopic, ctx, onProgress }) };

/**
 * A fitter by the conversation's number, in the planner's format: every fourth fits no variation (another request of the
 * topic), an odd one the first variation, the rest the second — so each way a conversation goes is seen.
 */
export const numberOf = (dialogueId: string): number => Number(dialogueId.slice(1));
export const fitter: Runtime['fitConversations'] = async request => ({ fits: request.conversations.map(({ dialogueId }) => {
  const number = numberOf(dialogueId);
  return { dialogueId, variation: number % 4 === 0 ? 'none' : number % 2 ? request.variations[0]!.id : request.variations[1]?.id ?? request.variations[0]!.id };
}) });

const input = (count: number, requested?: number): AnalyzeInput => ({ task: 'Бот помогает с возвратом оплаты', mode: 'live', file: 'логи возвратов', materials: [{ name: 'Правила возвратов', content: RULES }],
  logs: importBatch(conversations(count)), settings: settingsSchema.parse({ timeoutMs: 60000 }), ...(requested ? { requested } : {}) });

export async function withLab<T>(name: string, runtime: Runtime, work: (lab: ExperimentLab) => Promise<T>): Promise<T> {
  const lab = new ExperimentLab(join(await folder(name), '.agent-lab'), runtime);
  await lab.init();
  try { return await work(lab); } finally { await lab.close(); }
}
export async function analysed(lab: ExperimentLab, analyze: AnalyzeInput) {
  const started = await lab.analyze(analyze, { callCeiling: 2000 });
  await lab.waitForIdle();
  const analysis = await lab.getAnalysis(started.id);
  return { analysis, view: analysisView(analysis, await lab.store.readImport(analysis.logs.importId)) };
}

export async function proofLabFailures(): Promise<void> {
  const blames = (text: string) => text.includes('допишите') || text.includes('Добавьте правило') || text.includes('добавьте в материалы правило');
  const planners: [string, Runtime['proposeScenario'], string][] = [
    ['quote not verbatim', async ({ call }) => { const plan = goodPlan(call); plan.expectations[0]!.basis[0]!.quote = 'Объясните клиенту, как вернуть деньги.'; return plan; }, 'quote_not_verbatim'],
    ['answer failed the schema', async () => { throw new StructuredTaskError('План сценария: модель 5 раз подряд вернула ответ, который не проходит проверку', { outcome: 'schema' }); }, 'answer_schema'],
    ['context window too small', async () => { throw new ProviderFailure('context limit', 'context window exceeded', { delivery: 'refused' }); }, 'context_window'],
  ];
  for (const [what, proposeScenario, issue] of planners) {
    const { view } = await withLab('f', { proposeScenario, logJudge: passingJudge({ count: 0 }) }, lab => analysed(lab, input(3)));
    const gap = view.gaps[0];
    const text = [...analysisLines(view), nextStep(view)].join(' ');
    claim('F', gap?.issue === issue && !gap.rulesGap && !blames(text) && gapLine(gap).includes('Это работа Lab, а не ваши правила'),
      `(${what}) while a fitting rule exists: topic ${gap?.reason}/${gap?.issue} — «${gap ? gapLine(gap) : ''}»; next: «${nextStep(view)}»`);
  }
  // A gap the planner reports: the reviewer decides whether it is the owner's.
  for (const confirmed of [false, true]) {
    const reviewer: Runtime['reviewCard'] = async () => ({ verdicts: { [GAP_CLAIM]: confirmed ? { status: 'ready', reason: 'Ни одно предложение материалов не говорит о возврате.' }
      : { status: 'needs_owner', reason: 'Первое предложение правил говорит, как оформить возврат.' } }, model: 'stub/reviewer' });
    const silent: Runtime['proposeScenario'] = async ({ call }) => ({ ...goodPlan(call), expectations: [], uncovered: 'как вернуть оплату за заказ' } as PlanProposal);
    const { view } = await withLab('f-gap', { proposeScenario: silent, reviewCard: reviewer, logJudge: passingJudge({ count: 0 }) }, lab => analysed(lab, input(3)));
    const gap = view.gaps[0];
    claim('F', gap?.rulesGap?.confirmed === confirmed && (confirmed ? nextStep(view).includes('добавьте в материалы правило') && gapLine(gap).includes('Проверяющий подтвердил')
      : !blames([...analysisLines(view), nextStep(view)].join(' ')) && gapLine(gap).includes('не пробел в ваших правилах')),
      `(planner says the rules are silent, reviewer ${confirmed ? 'confirms' : 'disagrees'}) stored apart: rulesGap.confirmed = ${gap?.rulesGap?.confirmed} — «${gap ? gapLine(gap) : ''}»`);
  }
  // The harness's own reading types the slip: a paraphrased quote is «quote», whatever else the answer holds.
  const call: PlanCall = { topic: { title: 't' }, examples: [{ dialogueId: 'c01', customer: ['x'] }], sources: [{ id: 'source-1', name: 'Правила', content: RULES }], binds: { kinds: ['behavior'], rules: [] } };
  const paraphrased = goodPlan({ ...call, examples: [{ dialogueId: 'c01', customer: ['x'] }] });
  paraphrased.expectations[0]!.basis[0]!.quote = 'Объясните, как вернуть деньги.';
  claim('F', planSlips(paraphrased as PlanProposal, { ...call, channels: { tools: [], toolEvents: false, state: false, byRule: true }, gaps: true }).some(slip => slip.kind === 'quote'),
    'the plan harness types a paraphrased quote as «quote» (the typed issue a Pi planner\'s last rejection carries)');
}

export async function proofBeyondEight(): Promise<void> {
  const calls = { count: 0 };
  await withLab('g', { topicMap, proposeScenario: async ({ call }) => goodPlan(call), fitConversations: fitter, logJudge: passingJudge(calls) }, async lab => {
    // (1) 40 conversations of one topic, 24 asked for: 24 selected — the plan reads 8, the other 16 are fitted to its variations first.
    const first = await analysed(lab, input(40));
    const group = first.analysis.topics.find(item => !item.others)!;
    const others = first.analysis.topics.find(item => item.others);
    const scenario = first.analysis.scenarios.find(item => item.id === group.scenarioId)!;
    const [shared, second] = [scenario.expectations.find(expectation => !expectation.variationIds)!, scenario.expectations.find(expectation => expectation.variationIds)!];
    const onFirstPlan = (id: string) => first.analysis.findings.filter(finding => finding.dialogueId === id && finding.scenarioId === scenario.id).map(finding => finding.expectationId).sort();
    const extra = group.extra ?? [];
    const fitsFirst = extra.filter(id => numberOf(id) % 4 && numberOf(id) % 2), fitsSecond = extra.filter(id => numberOf(id) % 4 && !(numberOf(id) % 2)), none = extra.filter(id => !(numberOf(id) % 4));
    claim('G', first.analysis.topics.filter(item => !item.others).length === 1 && first.analysis.selection.picked.length === 24 && group.dialogueIds.length === 8 && extra.length === 16
      && fitsFirst.every(id => JSON.stringify(onFirstPlan(id)) === JSON.stringify([shared.id])) && fitsSecond.every(id => JSON.stringify(onFirstPlan(id)) === JSON.stringify([shared.id, second.id].sort())),
      `(1) one topic of 40, 24 requested: selected ${first.analysis.selection.picked.length} (plan examples ${group.dialogueIds.length}, beyond them ${extra.length}); fitted to the first variation → its duty only (${fitsFirst.length}), to the second → the shared one and its own (${fitsSecond.length})`);
    const ownScenario = others && first.analysis.scenarios.find(item => item.id === others.scenarioId);
    claim('G', none.length > 0 && none.every(id => onFirstPlan(id).length === 0) && JSON.stringify(group.unfit) === JSON.stringify(none) && !!others && JSON.stringify(others.dialogueIds) === JSON.stringify(none)
      && !!ownScenario && none.every(id => first.analysis.findings.some(finding => finding.dialogueId === id && finding.scenarioId === ownScenario.id)),
      `(1) a conversation no variation fits is never judged by the plan: ${none.length} unfit (${none.join(', ')}) → the group «${others?.title}» with a plan of its own, judged there`);
    const said = analysisLines(first.view).find(line => line.includes('сверил с найденным планом')) ?? '';
    claim('G', first.view.coverage.sharedOnly === 0 && first.view.coverage.fitted === fitsFirst.length + fitsSecond.length && first.view.coverage.ownPlan === none.length && said.includes('нашёл правила отдельно'),
      `(1) said apart: «${said}»`);
    // (3) A continuation: the next conversations, fitted, and no call again for what was done.
    const consent = await lab.continuationConsent({ analysisId: first.analysis.id, more: 10 });
    const before = calls.count;
    const started = await lab.continueAnalysis({ analysisId: first.analysis.id, more: 10 }, { callCeiling: consent.callCeiling });
    await lab.waitForIdle();
    const next = await lab.getAnalysis(started.id);
    const earlier = await lab.getAnalysis(first.analysis.id);
    const fresh = next.selection.picked.filter(id => !first.analysis.selection.picked.includes(id));
    const added = next.findings.filter(finding => !first.analysis.findings.some(old => old.key === finding.key));
    claim('G', consent.reused === first.analysis.findings.length && next.continues?.reused === first.analysis.findings.length && fresh.length === 10
      && added.length > 0 && added.every(finding => fresh.includes(finding.dialogueId)) && calls.count - before === added.length * 2,
      `(3) continued by 10: reused ${next.continues?.reused} findings with no call, judged only the 10 new (${added.length} findings, ${calls.count - before} votes); selected now ${next.selection.picked.length}`);
    claim('G', earlier.findings.length === first.analysis.findings.length && earlier.updatedAt === first.analysis.updatedAt && next.id !== earlier.id,
      `(3) the earlier analysis is unchanged and stays its own record; consent: «${continuationConsentText(consent).lines[1]}»`);
    // (5) Frequency is among the analysed, never of all traffic.
    claim('G', limitLines(first.view)[0]!.includes('не доля всего трафика') && !headline(first.view).includes('%'),
      `(5) «${limitLines(first.view)[0]}»; headline «${headline(first.view)}»`);
    // (4) Asking for more than the plan reads is never capped at 8: 128 asked of 40 takes all 40.
    const all = await analysed(lab, input(40, 128));
    claim('G', all.analysis.selection.picked.length === 40, `(4) 128 asked of 40 in one topic: selected ${all.analysis.selection.picked.length}, not 8`);
  });
  // (2) A stop at the first conversation: the headline says how many of the selected were analysed, never all of them.
  const ref: { lab?: ExperimentLab; id?: string } = {};
  await withLab('g-stop', { topicMap, proposeScenario: async ({ call }) => goodPlan(call), fitConversations: fitter, logJudge: passingJudge({ count: 0 }, () => { if (ref.lab && ref.id) void ref.lab.cancelAnalysis(ref.id); }) }, async lab => {
    ref.lab = lab;
    const started = await lab.analyze(input(40), { callCeiling: 2000 });
    ref.id = started.id;
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    const view = analysisView(analysis, await lab.store.readImport(analysis.logs.importId));
    claim('G', analysis.status === 'stopped' && view.coverage.processed < view.coverage.picked && view.coverage.picked === 24 && !headline(view).startsWith('Разобрано 24')
      && headline(view).includes('из 24 разговоров, выбранных'),
      `(2) stopped at the first judgment: processed ${view.coverage.processed} of ${view.coverage.picked} selected — «${headline(view)}»`);
  });
}
