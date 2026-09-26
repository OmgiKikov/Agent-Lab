import { fingerprint, materialSources, settingsSchema } from '../../src/contracts.js';
import { FACT_PROTOCOL, factProblem, type FactAnswer, type FactChecker, type FactRequest } from '../../src/discover/facts.js';
import { analysisConsentText } from '../../src/discover/consent.js';
import { checkLink } from '../../src/discover/verify.js';
import { criterionHash } from '../../src/criterion.js';
import { analysisView } from '../../src/discover/view.js';
import { headline } from '../../src/discover/text.js';
import { continueFrom } from '../../src/discover/analyze.js';
import { ProviderFailure } from '../../src/llm/model-call.js';
import { importBatch } from '../../src/scenario-library.js';
import { claim } from './common.js';
import { analysed, withLab } from './discover-work.js';
import type { AnalyzeInput } from '../../src/lab/discover.js';
import { AnalysisBoard, newAnalysisState } from '../../extensions/analysis-board.ts';
import { analysesView } from '../../extensions/board-command.ts';

const FACT = 'Возврат зачисляется в течение трёх рабочих дней.';
const WRONG = 'Возврат зачисляется в течение десяти рабочих дней.';
const materials = [{ name: 'Справка о возвратах', kind: 'knowledge' as const, content: `${FACT} Сотрудник может предложить отправить инструкцию по СМС.` }];
const rows = [WRONG, FACT, 'С этим поможет оператор.', 'Комиссия составляет два процента.', 'Срок возврата — # рабочих дней.', FACT]
  .map((content, i) => ({ id: `f${i + 1}`, messages: [{ role: 'user', content: 'Когда вернут деньги?' }, { role: 'assistant', content }] }));
const input = (count = 6): AnalyzeInput => ({ task: 'Проверить факты в ответах по справочным статьям', mode: 'live', file: 'вымышленные разговоры',
  materials, logs: importBatch(rows), requested: count, settings: settingsSchema.parse({}) });

function answer(request: FactRequest): FactAnswer {
  if (request.review) return { question: 'Срок возврата', claims: request.review, note: 'Противоречие перепроверено.' };
  const agent = request.messages.find(message => message.role === 'assistant')!;
  const handoff = agent.content.includes('оператор');
  const unknown = agent.content.includes('#') || agent.content.includes('Комиссия');
  return { question: 'Срок возврата', note: handoff ? 'В ответе только передача человеку.' : 'Проверено утверждение о сроке.',
    claims: handoff ? [] : [{ agent: { seq: agent.seq, quote: agent.content }, result: unknown ? 'unknown' : agent.content === WRONG ? 'contradicted' : 'supported',
      relation: unknown ? agent.content.includes('#') ? 'masked' : 'missing_reference' : 'same_fact',
      reference: unknown ? null : { sourceId: request.sources[0]!.id, quote: FACT }, reason: unknown ? 'По статье нельзя проверить значение.' : 'Сравнены два утверждения о сроке.' }] };
}

export async function proofFacts(): Promise<void> {
  const request: FactRequest = { task: input().task, sources: materialSources(materials),
    messages: [{ seq: 0, role: 'user', content: WRONG }, { seq: 1, role: 'assistant', content: WRONG }] };
  const valid = answer(request);
  claim('J', !factProblem(valid, request), 'an explicit wrong value with both exact quotations is admitted');
  const changed = (mutate: (value: FactAnswer) => void) => { const value = structuredClone(valid); mutate(value); return factProblem(value, request); };
  claim('J', !!changed(value => { value.claims[0]!.agent.seq = 0; }), 'customer words cannot be cited as the bot assertion');
  claim('J', !!changed(value => { value.claims[0]!.reference = null; }), 'a contradiction without a source quotation is refused');
  claim('J', !!changed(value => { value.claims[0]!.relation = 'operator_workflow'; }), 'an operator workflow cannot be counted as a factual contradiction');
  const masked = { ...request, messages: [{ seq: 1, role: 'assistant' as const, content: 'Возврат зачисляется в течение # рабочих дней.' }] };
  const maskAnswer = structuredClone(valid); maskAnswer.claims[0]!.agent.quote = masked.messages[0]!.content;
  claim('J', !!factProblem(maskAnswer, masked), 'a masked value cannot be decided even when a model says contradicted');
  const review = { ...request, review: valid.claims };
  claim('J', !!factProblem({ ...valid, claims: [] }, review), 'a second reading must answer every allegation, not silently omit it');

  const calls: string[] = [];
  const checker: FactChecker = { provider: 'stub', model: 'facts', protocolHash: fingerprint(FACT_PROTOCOL), check: async (request, ctx) => {
    ctx.beforeCall(); calls.push(`${request.review ? 'review' : 'check'}:${request.messages.find(message => message.role === 'assistant')?.content}`);
    return answer(request);
  } };
  await withLab('j-facts', { factChecker: checker, topicMap: { builder: { provider: 'stub', id: 'unused' }, build: async () => { throw new Error('Facts must not build a topic map'); } } }, async lab => {
    const consent = await lab.analysisConsent(input(5));
    claim('J', consent.checking === 'facts' && consent.topicMapCalls === 0 && analysisConsentText(consent, 'лог').lines.some(line => line.includes('Разметка всех тем')),
      'article-only input previews factual checking with no paid topic map');
    const first = await analysed(lab, input(5));
    const before = calls.length;
    const more = await lab.continuationConsent({ analysisId: first.analysis.id, more: 1 });
    const started = await lab.continueAnalysis({ analysisId: first.analysis.id, more: 1 }, { callCeiling: more.callCeiling });
    await lab.waitForIdle();
    const final = await lab.getAnalysis(started.id);
    const view = analysisView(final, input().logs);
    const legacy = structuredClone(final); delete legacy.checking; delete legacy.factChecks; legacy.protocol = 'discover-v3';
    const migrated = continueFrom(legacy, input().logs, checker.protocolHash, { id: 'new-facts', createdAt: final.createdAt, updatedAt: final.updatedAt,
      budget: { ceiling: 100, spent: 0 }, models: final.models, requested: 1 });
    claim('J', migrated.checking === 'facts' && migrated.findings.length === 0 && migrated.continues?.reused === 0 && legacy.findings.length > 0,
      'continuing an old article-duty analysis starts factual checking without carrying the old allegations or changing history');
    claim('J', final.status === 'done' && final.factChecks?.length === 6 && view.facts?.supported === 2 && view.facts.contradicted === 1
      && view.facts.unknown === 2 && view.facts.noClaims === 1, 'wrong fact, correct facts, missing source, mask and a handoff remain distinct');
    claim('J', calls.length - before <= 2 && final.continues?.reused === first.analysis.findings.length, 'continuation reuses completed checks and pays only for the new conversation');
    claim('J', view.problems.length === 1 && view.problems[0]!.dialogueIds.join() === 'f1' && view.problems[0]!.held.length === 2,
      'the wrong reply is the only problem; correctly stated facts provide controls');
    const link = checkLink(final, view.problems[0]!).link;
    claim('J', !!link.criterion && criterionHash(link.criterion) === view.problems[0]!.key && link.broken.join() === 'f1'
      && link.criterion.requirements[0]?.quote === FACT, 'the problem carries the source fact unchanged into VERIFY, not the wrong reply');
    claim('J', headline(view).includes('Проверка фактов') && !headline(view).includes('нарушений правил не найдено'), 'the report names its factual scope, never an overall agent grade');
    const board = new AnalysisBoard(await analysesView(lab), newAnalysisState({ id: final.id }),
      { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as never, () => {}, () => {}, () => 200);
    board.handleInput('\r');
    const screen = board.render(120).join('\n');
    claim('J', screen.includes(FACT) && screen.includes(WRONG) && screen.includes('Сравните утверждение бота') && !screen.includes('обязательны ли'),
      'the real Pi problem screen shows both quotes and asks about the contradiction, not an invented bot duty');
  });

  let drop = true, initialCalls = 0, reviews = 0;
  await withLab('j-review-retry', { factChecker: { ...checker, check: async (request, ctx) => {
    ctx.beforeCall();
    if (request.review) { reviews++; if (drop) throw new ProviderFailure('connection failure', 'connection failed'); }
    else initialCalls++;
    return answer(request);
  } } }, async lab => {
    const onlyWrong = { ...input(1), logs: importBatch([rows[0]]) };
    const first = await analysed(lab, onlyWrong);
    claim('J', first.analysis.findings.length === 0 && first.analysis.factChecks?.[0]?.stage === 'review' && !first.analysis.factChecks[0].complete,
      'an interrupted contradiction review produces no accusation');
    drop = false;
    const consent = await lab.continuationConsent({ analysisId: first.analysis.id, more: 1 });
    const next = await lab.continueAnalysis({ analysisId: first.analysis.id, more: 1 }, { callCeiling: consent.callCeiling });
    await lab.waitForIdle();
    const done = await lab.getAnalysis(next.id);
    claim('J', done.findings[0]?.result === 'fail' && initialCalls === 1 && reviews === 2, 'continuation retries only the unfinished review, reusing the first paid answer');
  });
}
