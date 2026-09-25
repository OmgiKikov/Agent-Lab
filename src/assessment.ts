import { z } from 'zod';
import type { Scenario, TraceEvent, Trial } from './contracts.js';
import { identifierSchema as identifier } from './ids.js';

/*
 * What a judgment is made of: the rubrics a situation is judged by — its own, the harness's standard ones and the RAG
 * diagnostics — the assessment of each with its quoted evidence, the full audit of one judgment and the receipt it
 * leaves on the trial. The shapes are stored in records and inside the judge's protocol hash: they never change.
 */

const text = z.string().trim().min(1);
/**
 * Which job of the agent this criterion is about. A dialogue is a chain of jobs — understand
 * the request, look things up, act, compose the answer, validate it — and a single end-to-end
 * verdict cannot say which link broke. The label changes nothing in measurement and everything
 * in diagnosis: results are grouped by it. Optional, because a one-step agent has one job.
 */
export const stage = { stage: text.max(80).optional() };
export const rubricSchema = z.strictObject({
  id: identifier, name: text.max(120), subject: z.enum(['agent', 'simulator']),
  description: text.max(2000), passCriteria: text.max(2000), failCriteria: text.max(2000), ...stage,
});
export type Rubric = z.infer<typeof rubricSchema>;
export const simulatorFidelity: Rubric = {
  id: 'user_fidelity', name: 'Верность симулятора', subject: 'simulator',
  description: 'Соблюдение заданных фактов, цели, поведения и лимита реплик; персона и характеристики учитываются только если заданы.',
  passCriteria: 'Пользователь следует карточке, отвечает на необходимые уточнения только известными фактами и соблюдает каждое условие остановки. Если карточка требует закончить после достаточной инструкции, дальнейших реплик нет. Не оценивает агента и не выдумывает его ответы или результаты инструментов.',
  failCriteria: 'Пользователь придумывает факты, знает скрытые ответы или состояние, меняет роль, оценивает агента, пропускает обязательное уточнение или продолжает разговор вопреки карточке. Новый вопрос после достаточной инструкции нарушает требование закончить, даже если все сообщённые факты верны. Неудача агента сама по себе не является провалом симулятора.',
};
/** Added by the harness to generated external cards when a source is the agent's own prompt: «по правилам промпта он этого сказать не мог». */
export const promptCompliance: Rubric = {
  id: 'prompt_compliance', name: 'Соблюдение правил промпта', subject: 'agent',
  description: 'Ответ соблюдает явные правила собственного промпта агента (источник с пометкой «промпт агента»): формат ответа, обязательные элементы, запреты. Проверяются только правила, которые пользователь может наблюдать в ответе; внутренние инструкции по инструментам и машинный формат ответа (JSON, именованные поля, обёртка) не оцениваются: клиент их не видит.',
  passCriteria: 'Каждое явное правило промпта, применимое к этому диалогу, соблюдено: формат, обязательные элементы и запреты выполнены. Если ни одно правило не применимо к доставленным репликам, условие выполнено.',
  failCriteria: 'Хотя бы одно явное правило промпта нарушено: неверный формат или структура, пропущен обязательный элемент, сказано запрещённое, дан ответ вне разрешённого периметра. В rationale процитируйте нарушенное правило дословно из источника-промпта и реплику, которая его нарушает.',
};
export const goalAttainment: Rubric = {
  id: 'goal_attainment', name: 'Достижение цели', subject: 'agent',
  description: 'Достиг ли пользователь заявленной цели по наблюдаемым фактам диалога.',
  passCriteria: 'Цель достигнута; если требовалось действие, его результат подтверждён наблюдаемым состоянием или событием инструмента.',
  failCriteria: 'Наблюдаемые факты показывают, что цель не достигнута или достигнута неверно. Одно заявление агента о ненаблюдавшемся действии не доказывает ни успех, ни провал.',
};
export const replyQuality: Rubric = {
  id: 'reply_quality', name: 'Качество ответа', subject: 'agent',
  description: 'Насколько ответ корректен, уместен, заземлён и исполним для пользователя независимо от результата внешнего действия.',
  passCriteria: 'Ответ корректен по материалам владельца, отвечает на запрос и, если следующий шаг нужен, даёт его без выдуманных фактов.',
  failCriteria: 'Ответ неверен, не по существу, неисполняем, противоречит материалам владельца или выдаёт неподтверждённое за факт.',
};
/**
 * Diagnostic-only RAG rubrics. Judgments under judge.ts JUDGE_PROTOCOL voted on them when the adapter reported retrieval
 * events; a new judgment does not, and they stay here so those judgments still read and verify.
 */
const ragContextRecall: Rubric = {
  id: 'rag_context_recall', name: 'RAG · нужное знание найдено', subject: 'agent',
  description: 'Достаточно ли переданного агенту контекста по приложенным требованиям владельца; это не полнота поиска по всей базе знаний.',
  passCriteria: 'Найденные RAG-фрагменты содержат все существенные факты и правила, необходимые для корректного ответа на доставленный запрос пользователя.',
  failCriteria: 'В найденных RAG-фрагментах отсутствует хотя бы один существенный факт или правило, без которого нельзя корректно выполнить доставленный запрос пользователя.',
};
const ragContextRelevance: Rubric = {
  id: 'rag_context_relevance', name: 'RAG · найденное по делу', subject: 'agent',
  description: 'Насколько найденные RAG-фрагменты относятся к доставленному запросу пользователя.',
  passCriteria: 'Найденные RAG-фрагменты относятся к доставленному запросу и не состоят преимущественно из посторонней информации.',
  failCriteria: 'Найденные RAG-фрагменты не относятся к доставленному запросу или преимущественно состоят из посторонней информации, мешающей использовать нужное знание.',
};
const ragContextFaithfulness: Rubric = {
  id: 'rag_context_faithfulness', name: 'RAG · ответ подтверждён найденным', subject: 'agent',
  description: 'Подтверждаются ли утверждения ответа о правилах, условиях и процедурах найденными RAG-фрагментами. Результаты инструментов и текущее состояние конкретной заявки эта метрика не проверяет.',
  passCriteria: 'Ответ содержит проверяемые утверждения о правилах, условиях или процедурах; каждое из них подтверждается найденными RAG-фрагментами и не противоречит им.',
  failCriteria: 'Ответ содержит хотя бы одно утверждение о правилах, условиях или процедурах, которое не подтверждается найденными RAG-фрагментами или противоречит им.',
};
export const RAG_RUBRICS = [ragContextRecall, ragContextRelevance, ragContextFaithfulness] as const;
export const RAG_METRIC_IDS = new Set<string>(RAG_RUBRICS.map(metric => metric.id));
const assessmentFindingSchema = z.strictObject({
  criterion: text.max(2000), result: z.enum(['pass', 'fail', 'unknown']), rationale: text.max(1000),
  citations: z.array(z.strictObject({ seq: z.number().int().nonnegative(), quote: z.string().min(1).max(2000) })).max(6),
});
export const metricAssessmentSchema = z.strictObject({
  metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']),
  // Up to 16 delivered replies, each with its own user request, retrieval and answer citation.
  rationale: text.max(4000), evidence: z.array(z.number().int().nonnegative()).max(48),
  findings: z.array(assessmentFindingSchema).min(1).max(12).optional(),
  citations: z.array(z.strictObject({ seq: z.number().int().nonnegative(), quote: z.string().min(1).max(2000) })).max(48).optional(),
});
export type MetricAssessment = z.infer<typeof metricAssessmentSchema>;
/**
 * Whether a rubric is voted on in this dialogue. The fixed opening belongs to the card, not to the reactive actor. A RAG
 * diagnostic is voted on only under `ragDiagnostics` — the rule of the judgments that voted on them (judge.ts
 * JUDGE_PROTOCOL) — and then only on complete evidence; today it is never voted on.
 */
export function metricApplies(metric: Rubric, trial: Pick<Trial, 'userMode' | 'events'>, options: { ragDiagnostics?: boolean } = {}): boolean {
  if (RAG_METRIC_IDS.has(metric.id)) return !!options.ragDiagnostics && ragEvidenceComplete(trial, metric.id === 'rag_context_faithfulness' ? 'model_context' : 'retrieval');
  return metric.id !== 'user_fidelity' || metric.subject !== 'simulator'
    || trial.userMode === 'reactive' && trial.events.some(event => event.type === 'simulator');
}
export const judgeAuditSchema = z.strictObject({
  protocolHash: text, inputHash: text, provider: text, model: text,
  configurationHash: text.optional(),
  transport: z.strictObject({ api: text, upstream: text.optional(), structured: z.boolean() }).optional(),
  prompt: text, input: text,
  attempts: z.array(z.strictObject({
    metricId: identifier.optional(), input: text.optional(),
    startedAt: text, raw: z.string().optional(), error: text.optional(),
    assessments: z.array(metricAssessmentSchema).optional(),
    /** A malformed answer the judge was asked to give again: kept for the record, not counted as a vote. */
    superseded: z.literal(true).optional(),
  })).max(48),
  notApplicable: z.array(identifier),
});
export type JudgeAudit = z.infer<typeof judgeAuditSchema>;
/**
 * The small trace a judgment leaves on the trial when the full audit lives in the sidecar
 * `{runId}.judge/{trialId}.json`. It alone never proves a judgment: the verifier re-derives the
 * input hash from the record and re-aggregates these votes against the recorded assessments.
 */
export const judgeReceiptSchema = z.strictObject({
  protocolHash: text, inputHash: text, provider: text, model: text,
  configurationHash: text.optional(),
  transport: z.strictObject({ api: text, upstream: text.optional(), structured: z.boolean() }).optional(),
  auditHash: text,
  votes: z.array(z.strictObject({ metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']).optional(), error: z.boolean().optional() })).max(48),
  notApplicable: z.array(identifier),
  complete: z.boolean(),
});
export type JudgeReceipt = z.infer<typeof judgeReceiptSchema>;
export const assessmentEventContent = (event: TraceEvent): string =>
  event.text !== undefined && [event.tool, event.args, event.result, event.state].every(value => value === undefined) ? event.text
    : JSON.stringify({ text: event.text, tool: event.tool, args: event.args, result: event.result, state: event.state });
/**
 * The rubrics of a judgment: the card's own. Under `ragDiagnostics` — the rule of the judgments that voted on them
 * (judge.ts JUDGE_PROTOCOL), kept so they verify — the RAG diagnostics were added whenever the target exposed retrieval
 * evidence. Today they are not added: no view shows them, and they cost six requests per dialogue.
 */
export function assessmentRubrics(scenario: Pick<Scenario, 'metrics'>, trial: Pick<Trial, 'events'>, options: { ragDiagnostics?: boolean } = {}): Rubric[] {
  // These IDs are harness-owned diagnostics; a card cannot replace their criteria with a reference answer.
  const metrics = (scenario.metrics ?? []).map(metric => RAG_RUBRICS.find(rubric => rubric.id === metric.id) ?? metric);
  if (!options.ragDiagnostics || !trial.events.some(event => event.type === 'retrieval')) return metrics;
  for (const rubric of RAG_RUBRICS) if (!metrics.some(metric => metric.id === rubric.id)) metrics.push(rubric);
  return metrics;
}
/** Absence of a chunk is evidence only when the adapter confirms the full context for every delivered reply. */
export function ragEvidenceComplete(trial: Pick<Trial, 'events'>, scope: 'retrieval' | 'model_context' = 'model_context'): boolean {
  let complete = false, replies = 0;
  for (const event of trial.events) {
    if (event.type === 'user') complete = false;
    if (event.type === 'retrieval') {
      const value = event.result as { complete?: unknown; chunks?: unknown; stage?: unknown } | undefined;
      const stage = value?.stage ?? 'model_context';
      complete = value?.complete === true && Array.isArray(value.chunks)
        && (stage === 'model_context' || scope === 'retrieval' && stage === 'retrieved');
    }
    if (event.type === 'assistant') { if (!complete) return false; replies++; complete = false; }
  }
  return replies > 0;
}
/** Quotes may refer to decoded chunk text, including line breaks escaped by the JSON event envelope. */
function eventContainsQuote(event: TraceEvent, quote: string): boolean {
  if (assessmentEventContent(event).includes(quote)) return true;
  if (event.type !== 'retrieval') return false;
  const chunks = (event.result as { chunks?: unknown } | undefined)?.chunks;
  return Array.isArray(chunks) && chunks.some(chunk => typeof chunk?.content === 'string' && chunk.content.includes(quote));
}
export function validateAssessments(metrics: Rubric[], events: TraceEvent[], raw: unknown): MetricAssessment[] {
  const assessments = z.array(metricAssessmentSchema).parse(raw);
  const metricIds = new Set(metrics.map(metric => metric.id));
  if (metricIds.size !== metrics.length || assessments.length !== metricIds.size
    || new Set(assessments.map(a => a.metricId)).size !== metricIds.size || assessments.some(a => !metricIds.has(a.metricId))) {
    throw new Error('Assessment must cover every requested metric exactly once');
  }
  const eventIds = new Set(events.map(event => event.seq));
  for (const assessment of assessments) {
    if (assessment.evidence.some(seq => !eventIds.has(seq))) throw new Error(`Assessment ${assessment.metricId} cites a nonexistent trace event`);
    if (assessment.result !== 'unknown' && !assessment.evidence.length) throw new Error(`Assessment ${assessment.metricId} needs trace evidence for pass/fail`);
    if (assessment.citations) {
      const cited = new Set(assessment.citations.map(c => c.seq));
      if (cited.size !== assessment.evidence.length || assessment.evidence.some(seq => !cited.has(seq))) throw new Error('Evidence must match quoted citations.');
      for (const citation of assessment.citations) {
        const event = events.find(e => e.seq === citation.seq);
        if (!event || !eventContainsQuote(event, citation.quote)) throw new Error(`Citation #${citation.seq} is not a verbatim quote from that event's content.`);
      }
    }
    if (!assessment.findings) continue; // Historical assessments retain their original evidence format.
    const metric = metrics.find(m => m.id === assessment.metricId)!;
    for (const finding of assessment.findings) {
      if (![metric.description, metric.passCriteria, metric.failCriteria].some(text => text.includes(finding.criterion))) {
        throw new Error('Each criterion must be copied verbatim from the supplied rubric; do not invent requirements.');
      }
      if (finding.result !== 'unknown' && !finding.citations.length) throw new Error('Every pass/fail finding needs a quoted trace event.');
      for (const citation of finding.citations) {
        const event = events.find(e => e.seq === citation.seq);
        if (!event || !eventContainsQuote(event, citation.quote)) throw new Error(`Citation #${citation.seq} is not a verbatim quote from that event's content.`);
      }
    }
    const expected = assessment.findings.some(f => f.result === 'fail') ? 'fail' : assessment.findings.some(f => f.result === 'unknown') ? 'unknown' : 'pass';
    const cited = new Set(assessment.findings.flatMap(f => f.citations.map(c => c.seq)));
    if (assessment.result !== expected || cited.size !== assessment.evidence.length || assessment.evidence.some(seq => !cited.has(seq))) {
      throw new Error('Assessment result and evidence must match its findings.');
    }
  }
  return assessments;
}
