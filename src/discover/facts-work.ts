import { fingerprint, type Source } from '../contracts.js';
import { citationId } from '../card/proposal.js';
import { criterionOf, criterionHash } from '../criterion.js';
import { workInputIssue, SOURCES_PER_DIALOGUE } from '../limits.js';
import { ProviderFailure } from '../llm/model-call.js';
import { StructuredTaskError, TASK_ATTEMPTS } from '../llm/structured.js';
import { seededOrder } from '../miner/topic-map.js';
import { selectScenarioSources } from '../scenario-sources.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { clip } from '../text.js';
import type { AnalysisWork } from './analyze.js';
import { unjudgeable } from './criteria.js';
import { canonicalFacts, FACT_ATTEMPTS, FACT_PROTOCOL, factAnswerSchema, factProblem, reviewedFacts, type FactAnswer, type FactCheck, type FactRequest } from './facts.js';
import { ANALYSIS_TOTAL_LIMIT, findingSchema, type LogAnalysis } from './schema.js';

/** Worst case, including bounded repairs: two source selections, a check and review of alleged contradictions only. */
export const factCeiling = (task: string, sources: readonly Source[], conversations: number): number =>
  conversations * (FACT_ATTEMPTS * 2 + (workInputIssue({ task, sources }) ? TASK_ATTEMPTS * 2 : 0));

export const factKey = (analysis: Pick<LogAnalysis, 'task' | 'sources'>, importHash: string, dialogueId: string, protocolHash: string): string =>
  fingerprint({ protocol: FACT_PROTOCOL, task: analysis.task, sources: analysis.sources.map(({ id, hash, name, kind }) => ({ id, hash, name, kind })), importHash, dialogueId, protocolHash });

/** A deterministic sample; no model categorises hundreds of conversations before the first useful result. */
export function selectFactConversations(analysis: LogAnalysis, batch: ImportBatch, count: number): string[] {
  analysis.selection.unjudgeable = batch.dialogues.flatMap(dialogue => { const reason = unjudgeable(dialogue); return reason ? [{ dialogueId: dialogue.id, reason }] : []; });
  const excluded = new Set([...analysis.selection.picked, ...analysis.selection.unjudgeable.map(item => item.dialogueId)]);
  const room = Math.max(0, Math.min(count, ANALYSIS_TOTAL_LIMIT - analysis.selection.picked.length));
  const ids = seededOrder(batch.dialogues.map(dialogue => dialogue.id).filter(id => !excluded.has(id)), batch.contentHash, id => `facts:${id}`).slice(0, room);
  analysis.selection.method = 'sample';
  analysis.selection.picked.push(...ids);
  return ids;
}

const messagesOf = (dialogue: ImportBatch['dialogues'][number]): FactRequest['messages'] => dialogue.events.flatMap(event =>
  event.type === 'message' && (event.role === 'user' || event.role === 'assistant') && event.content
    ? [{ seq: event.index, role: event.role, content: event.content }] : []);

function bindFacts(analysis: LogAnalysis, record: FactCheck): void {
  const scenarioId = `facts_${fingerprint(record.dialogueId).slice(0, 24)}`;
  analysis.findings = analysis.findings.filter(finding => finding.dialogueId !== record.dialogueId);
  analysis.scenarios = analysis.scenarios.filter(scenario => scenario.id !== scenarioId);
  analysis.topics = analysis.topics.filter(topic => !topic.dialogueIds.includes(record.dialogueId));
  analysis.assignments = analysis.assignments.filter(item => item.dialogueId !== record.dialogueId);
  const decided = record.claims.filter(claim => claim.result !== 'unknown' && claim.reference);
  if (!decided.length) return;
  // A criterion is the source fact, independent of the particular wrong wording. VERIFY can carry it unchanged.
  const expectations = decided.map((claim, index) => {
    const reference = claim.reference!;
    const id = citationId(reference.sourceId, reference.quote);
    if (!analysis.requirements.some(requirement => requirement.id === id)) analysis.requirements.push({ id, sourceId: reference.sourceId,
      quote: reference.quote, text: reference.quote, kind: 'knowledge', critical: true, observable: true });
    return { id: `s${index + 1}`, text: clip(`не искажать факт: ${reference.quote}`, 300), strength: 'must_not' as const, requirementIds: [id],
      acceptable: 'Факт можно объяснить другими словами. Пропуск детали или передача человеку сами по себе не противоречие.',
      violation: clip(`Агент явно утверждает факт, противоречащий источнику: «${reference.quote}»`, 600) };
  });
  analysis.scenarios.push({ id: scenarioId, topic: clip(record.question, 120), question: record.question,
    variations: [{ id: 'v1', title: clip(record.question, 160), origin: 'logs', examples: [record.dialogueId] }], expectations });
  analysis.topics.push({ title: clip(record.question, 120), dialogueIds: [record.dialogueId], scenarioId });
  analysis.assignments.push({ dialogueId: record.dialogueId, scenarioId, variationId: 'v1' });
  decided.forEach((claim, index) => {
    const expectation = expectations[index]!;
    const hash = criterionHash(criterionOf(expectation, analysis.requirements)!);
    analysis.findings.push(findingSchema.parse({ key: fingerprint({ check: record.key, agent: claim.agent, criterion: hash }),
      dialogueId: record.dialogueId, scenarioId, expectationId: expectation.id, variationId: 'v1', criterionHash: hash,
      mode: FACT_PROTOCOL, protocolHash: record.protocolHash, inputHash: record.inputHash!, provider: record.provider, model: record.model,
      votes: [], result: claim.result === 'contradicted' ? 'fail' : 'pass', complete: true,
      evidence: [{ seq: claim.agent.seq, quote: claim.agent.quote }], rationale: claim.reason }));
  });
}

/** Per conversation: select reference articles, compare actual claims, then challenge only proposed contradictions. */
export async function runFactAnalysis(analysis: LogAnalysis, batch: ImportBatch, work: AnalysisWork): Promise<void> {
  const checker = work.runtime.factChecker;
  if (!checker) throw new Error('В этой среде недоступна проверка фактов по статьям.');
  if (!analysis.selection.picked.length) selectFactConversations(analysis, batch, analysis.selection.requested);
  analysis.factChecks ??= [];
  for (const [index, dialogueId] of analysis.selection.picked.entries()) {
    work.ctx.signal.throwIfAborted();
    const dialogue = batch.dialogues.find(item => item.id === dialogueId);
    if (!dialogue) continue;
    const key = factKey(analysis, batch.contentHash, dialogueId, checker.protocolHash);
    let record: FactCheck | undefined = analysis.factChecks.find(item => item.dialogueId === dialogueId && item.key === key);
    if (record?.complete) continue;
    if (!record) {
      record = { key, dialogueId, protocolHash: checker.protocolHash, provider: checker.provider, model: checker.model, sourceIds: [],
        question: 'Факты в ответе', claims: [], note: 'Проверка не завершена.', complete: false, reviewed: false, stage: 'check' };
      analysis.factChecks = [...analysis.factChecks.filter(item => item.dialogueId !== dialogueId), record];
    }
    delete record.issue;
    const position = `${index + 1} из ${analysis.selection.picked.length}`;
    const messages = messagesOf(dialogue);
    try {
      let sources = record.sourceIds.map(id => analysis.sources.find(source => source.id === id)).filter((source): source is Source => !!source);
      if (!sources.length) {
        await work.checkpoint(`Разговор ${position}: подбираю статьи для проверки фактов.`);
        sources = !workInputIssue({ task: analysis.task, sources: analysis.sources }) ? analysis.sources : await selectScenarioSources({
          task: analysis.task, limit: SOURCES_PER_DIALOGUE, catalog: analysis.sources.map(({ id, name, content }) => ({ id, name, chars: content.length })),
          dialogue: { id: dialogueId, messages: messages.map(({ role, content }) => ({ role, content })) },
        }, analysis.sources, work.runtime, work.ctx);
        record.sourceIds = sources.map(source => source.id);
      }
      if (!sources.length) {
        Object.assign(record, { complete: true, stage: 'done', issue: 'no_sources', note: 'Подходящих статей не найдено. Это не доказывает ошибку в ответе.' });
        await work.checkpoint(`Разговор ${position}: подходящие статьи не найдены, выводов нет.`);
        continue;
      }
      const request: FactRequest = { task: analysis.task, messages, sources };
      if (workInputIssue(request)) {
        record.issue = 'context_window'; record.note = 'Разговор и статьи не поместились в один запрос. Текст не обрезан.';
        await work.checkpoint(`Разговор ${position}: слишком большой для проверки, выводов нет.`);
        continue;
      }
      const check = async (input: FactRequest): Promise<FactAnswer> => {
        const answer = factAnswerSchema.parse(await checker.check(input, work.ctx));
        const problem = factProblem(answer, input);
        if (problem) throw new StructuredTaskError(problem, { outcome: 'domain' });
        return canonicalFacts(answer, input);
      };
      if (record.stage === 'check') {
        await work.checkpoint(`Разговор ${position}: сверяю утверждения бота со статьями.`);
        const answer = await check(request);
        Object.assign(record, answer, { inputHash: fingerprint(request), stage: 'review' });
        await work.checkpoint(`Разговор ${position}: проверено утверждений — ${record.claims.length}.`);
      }
      const alleged = record.claims.filter(claim => claim.result === 'contradicted');
      if (alleged.length) {
        await work.checkpoint(`Разговор ${position}: перепроверяю возможные противоречия — ${alleged.length}.`);
        const review = await check({ ...request, review: alleged });
        const answer = reviewedFacts({ question: record.question, claims: record.claims, note: record.note }, review);
        Object.assign(record, answer, { reviewed: true });
      }
      record.complete = true; record.stage = 'done';
      bindFacts(analysis, record);
      await work.checkpoint(`Разговор ${position}: проверка фактов завершена.`);
    } catch (error) {
      if (work.ctx.signal.aborted) throw error;
      if (error instanceof ProviderFailure && !error.retryable && error.kind !== 'context limit') throw error;
      if (!(error instanceof ProviderFailure) && !(error instanceof StructuredTaskError) && !(error instanceof Error && error.name === 'ZodError')) throw error;
      record.issue = error instanceof ProviderFailure ? error.kind === 'context limit' ? 'context_window' : 'provider' : 'invalid_answer';
      record.note = 'Проверку не удалось закончить. Результат не засчитан ни как ошибка, ни как правильный ответ.';
      await work.checkpoint(`Разговор ${position}: проверка не завершена; продолжение повторит незаконченный шаг.`);
    }
  }
}

/** Carry only records of the same data and checker; incomplete reviews retain their paid first reading. */
export function carryFactChecks(analysis: LogAnalysis, batch: ImportBatch, protocolHash: string): void {
  analysis.factChecks = (analysis.factChecks ?? []).filter(record => record.key === factKey(analysis, batch.contentHash, record.dialogueId, protocolHash));
  const done = new Set(analysis.factChecks.filter(record => record.complete).map(record => record.dialogueId));
  analysis.findings = analysis.findings.filter(finding => done.has(finding.dialogueId));
}
