import { checkpointReceiptValid } from './checkpoints.js';
import { z } from 'zod';
import { assessmentEventContent, assessmentRubrics, fingerprint, metricApplies, metricAssessmentSchema, observableRule, RAG_METRIC_IDS, validateAssessments, judgeReceiptSchema, type CallContext, type JudgeAudit, type JudgeReceipt, type MetricAssessment, type Requirement, type Runtime, type Scenario, type Source } from './contracts.js';
import { ASSESS_ROLE, DATA_BOUNDARY } from './prompts.js';
import { ragFaithfulnessEvidence, ragJudgeEvents, ragJudgeInput } from './rag-evidence.js';

const condition = z.enum(['met', 'not_met', 'unclear']);
const responseSchema = z.strictObject({ assessments: z.array(metricAssessmentSchema.omit({ result: true, findings: true }).required({ citations: true }).extend({
  passCondition: condition, failCondition: condition,
})).max(8) });
// Anthropic's grammar supports the object shape, but not these size/range bounds.
// The complete responseSchema above still validates every original response locally.
export const JUDGE_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'agent_lab_judgment', strict: true,
  schema: JSON.parse(JSON.stringify(z.toJSONSchema(responseSchema), (key, value) =>
    ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'].includes(key) ? undefined : value)),
} };
export const JUDGE_PROMPT = `${ASSESS_ROLE}\n${DATA_BOUNDARY}
Evaluate passCriteria and failCriteria INDEPENDENTLY against the same evidence. Report met, not_met or unclear for EACH condition. Do not choose which condition takes precedence. If both apply, preserve both as met. An unspecified scope or priority is unclear; never invent one. Explain both conditions in rationale. A condition that is not exercised is unclear, not automatically met or not_met.
Events of type retrieval contain exact fragments observed by the adapter. stage=retrieved means the search service response only; stage=model_context (also the legacy default) means the actual answering-model context. Sufficiency and relevance assess the recorded stage; faithfulness requires model_context and stays unknown for search-only evidence. replyContexts binds each answerSeq to its own retrievalSeq and preceding userSeqs. Never use a later context to justify an earlier answer or combine contexts into a fictional context that no reply received.
For rag_context_faithfulness, assess business claims only against the context bound to that answer; do not use model memory, earlier assistant claims or an assumed reference answer. A pass needs citations to EVERY answer and its own retrieval event; a fail needs the offending answer and its own retrieval event, including an empty context. Quote actual content, not just event IDs. No reference sources, expected answer, planned user facts or fixture state are supplied to this check.
In this RAG-only check, business claims mean rules, terms and procedures from knowledge documents. A report of a tool action or a specific customer's current account/request status is outside this metric: those observations are deliberately withheld. If the reply only reports such a status or asks for clarification and makes no knowledge claim, both conditions are unclear; do not invent a RAG failure or a vacuous pass.
For rag_context_relevance, compare the context with delivered user requests only; the tested answers and reference materials are withheld. Cite user and retrieval events. If the delivered messages do not establish the information need, return unclear.
For rag_context_recall, compare each supplied context with applicable reference materials for the delivered requests. Never treat reference sources as retrieved context. This is a sufficiency check against those supplied materials, not proof of recall over the entire knowledge base. Cite retrieval events and delivered user messages; the tested answer is withheld.
Return exactly one compact JSON object, without markdown fences, matching this schema:
${JSON.stringify(z.toJSONSchema(responseSchema))}`;
export const JUDGE_PROTOCOL = fingerprint({ version: 13, promptSources: 'observable-rules', ragEvidence: 'metric-isolated-reply-context-with-stage-v1', citations: 'verbatim-decoded-chunks', goalObservation: 'owner-selected-cited-channel', unobservedActions: 'deterministic-unknown', prompt: JUDGE_PROMPT, responseFormat: JUDGE_RESPONSE_FORMAT, applicability: 'reactive-actor-was-called', repeatsPerMetric: 2, aggregation: 'per-metric-unanimous-exclusive-conditions', repair: false, temperature: '0 for non-reasoning models; otherwise default', thinking: 'medium for reasoning models; otherwise off', maxTokens: 16384 });
type Input = Parameters<NonNullable<Runtime['assess']>>[0];
/** Rationale texts written into assessments. Reason detection matches these constants; their text is part of stored records. */
export const GOAL_UNSUPPORTED_RATIONALE = 'Достижение цели не подтверждено цитированным доказательством выбранного владельцем типа; слова агента оцениваются отдельно.';
export const AGREED_RATIONALE_PREFIX = 'Совпало 2/2 оценок этой рубрики в свежих сессиях; это не проверка правильности.';
export const SPLIT_RATIONALE_PREFIX = 'Судья разошёлся на неизменном входе:';
/** Votes of one dialogue sent at once; a full card set stays well under typical provider rate limits. */
const JUDGE_CONCURRENCY = 8;

/**
 * The judge never reads the agent's prompt as text. A prompt source reaches it as the numbered
 * rules a user could observe, extracted at preparation and filtered again here, so an internal
 * format or tool instruction cannot become a verdict. Every other source is passed unchanged.
 */
export function observableSources(sources: Source[], requirements: Requirement[]): Source[] {
  return sources.map(source => {
    if (source.kind !== 'prompt') return source;
    const rules = requirements.filter(r => r.sourceId === source.id && observableRule(r)).map((r, i) => `${i + 1}. «${r.quote}»`);
    const content = rules.length
      ? `Наблюдаемые правила промпта агента, извлечённые при подготовке; внутренние правила формата ответа и работы с инструментами исключены:\n${rules.join('\n')}`
      : 'Наблюдаемых правил из промпта агента не извлечено: ни одно правило промпта к этому диалогу не применимо.';
    return { ...source, content };
  });
}

/**
 * Which sources one card's judge reads. A record prepared from a few materials keeps them all (its judgments were verified
 * with that input); a record prepared from a large knowledge base (per-dialogue article selection) gives the judge the prompt
 * sources plus the articles its requirements cite, so a vote never carries hundreds of articles.
 */
export function scenarioSources(record: { sources: Source[]; requirements: Requirement[]; preparationProgress?: { sourceSelection?: unknown } }, scenario: Pick<Scenario, 'requirementIds' | 'execution'>): Source[] {
  if (!record.preparationProgress?.sourceSelection) return record.sources;
  const cited = new Set([...scenario.requirementIds, ...(scenario.execution?.evaluatorView.requirements ?? []).map(r => r.id)]);
  const sourceIds = new Set(record.requirements.filter(r => cited.has(r.id)).map(r => r.sourceId));
  return record.sources.filter(source => source.kind === 'prompt' || sourceIds.has(source.id));
}

/** This is the complete, frozen judge input. Prior verdicts, usage and run identity are deliberately absent. */
export function judgeInput(input: Input) {
  const metric = input.scenario.metrics?.length === 1 ? input.scenario.metrics[0] : undefined;
  if (metric && RAG_METRIC_IDS.has(metric.id)) return ragJudgeInput(input, metric);
  const observationMissing = !input.trial.observation || input.trial.observation.state === 'missing';
  const scope = input.trial.userMode === 'static'
    ? 'Opening and first answer ONLY. Planned follow-ups were not delivered. Never penalize the agent for their absence.'
    : 'Evaluate only delivered requests, within the rubric stage.';
  return {
    scenario: { ...(input.scenario.execution ? { execution: { protocol: input.scenario.execution.checkpointProtocol, checkpointHash: input.scenario.execution.checkpointHash, evaluatorView: input.scenario.execution.evaluatorView } } : {}), metrics: input.scenario.metrics, successCriteria: input.scenario.successCriteria, checks: input.scenario.checks, goalObservation: input.scenario.goalObservation,
      user: input.trial.userMode === 'static' ? { ...input.scenario.user, script: [], maxFollowUps: 0 } : input.scenario.user },
    evaluationScope: observationMissing
      ? `${scope} Agent prose proves only what was said. Without observed state, action-dependent pass conditions remain unclear; assess reply quality independently.`
      : scope,
    sources: input.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content, hash: fingerprint(content) })),
    trial: { userMode: input.trial.userMode,
      events: input.trial.events.map(event => ({ seq: event.seq, type: event.type, content: assessmentEventContent(event) })),
      observation: input.trial.observation ?? { state: 'missing', tools: 'partial' }, initialState: input.trial.initialState,
      finalState: observationMissing ? null : input.trial.finalState },
  };
}

function parseJudgment(raw: string, input: Input, metrics: NonNullable<Input['scenario']['metrics']>): MetricAssessment[] {
  const rows = responseSchema.parse(JSON.parse(raw)).assessments;
  const ids = new Set(metrics.map(m => m.id));
  if (rows.length !== ids.size || new Set(rows.map(r => r.metricId)).size !== ids.size || rows.some(r => !ids.has(r.metricId))) {
    throw new Error('Assessment must cover every requested metric exactly once');
  }
  const events = new Set(input.trial.events.map(e => e.seq));
  return rows.map(({ passCondition, failCondition, ...row }) => {
    let result: MetricAssessment['result'] = passCondition === 'met' && failCondition === 'not_met' ? 'pass'
      : failCondition === 'met' && passCondition === 'not_met' ? 'fail' : 'unknown';
    if (row.evidence.some(seq => !events.has(seq))) throw new Error(`Assessment ${row.metricId} cites a nonexistent trace event`);
    if (result !== 'unknown' && !row.evidence.length) throw new Error(`Assessment ${row.metricId} needs trace evidence for pass/fail`);
    const availableEvents = RAG_METRIC_IDS.has(row.metricId) ? ragJudgeEvents(input, row.metricId) : input.trial.events;
    if (row.evidence.some(seq => !availableEvents.some(event => event.seq === seq))) throw new Error('Assessment cites evidence withheld from this metric');
    const citedEvents = row.evidence.map(seq => availableEvents.find(event => event.seq === seq)!);
    const replyConfirms = citedEvents.some(event => event.type === 'assistant');
    if (RAG_METRIC_IDS.has(row.metricId) && result !== 'unknown') {
      if (!citedEvents.some(event => event.type === 'retrieval') || !metricApplies(metrics.find(metric => metric.id === row.metricId)!, input.trial)
        || row.metricId === 'rag_context_faithfulness' && !ragFaithfulnessEvidence(input.trial, row.evidence, result)
        || row.metricId === 'rag_context_recall' && !input.sources.some(source => source.kind !== 'prompt')) {
        result = 'unknown';
        row.rationale = 'Для RAG-вывода нужны полный контекст каждого ответа, цитаты найденного и, для полноты знания, требования из базы знаний владельца.';
      }
    }
    const expectedTools = input.scenario.checks.flatMap(check =>
      check.kind === 'tool_called' || check.kind === 'tool_count' && check.min > 0 ? [{ tool: check.tool, id: check.id }] : []);
    const toolConfirms = citedEvents.some(event => {
      if (event.type !== 'tool_result' || !event.tool) return false;
      const checkIds = expectedTools.filter(check => check.tool === event.tool).map(check => check.id);
      const value = event.result && typeof event.result === 'object' ? event.result as Record<string, unknown> : undefined;
      const index = input.trial.events.indexOf(event);
      const call = input.trial.events[index - 1];
      return checkIds.length > 0 && input.trial.checks.some(check => checkIds.includes(check.id) && check.passed)
        && call?.type === 'tool_call' && call.tool === event.tool && (value?.ok === true || value?.success === true);
    });
    const stateChecks = input.scenario.checks.filter(check => check.kind === 'state_equals');
    const stateConfirms = input.trial.observation?.state !== undefined && input.trial.observation.state !== 'missing'
      && stateChecks.length > 0 && stateChecks.every(check => input.trial.checks.some(result => result.id === check.id && result.passed))
      && citedEvents.some(event => event.state && stateChecks.every(check => Object.is(event.state!.records[check.recordId]?.[check.field], check.value)));
    const goalConfirmed = input.scenario.goalObservation === 'reply' ? replyConfirms
      : input.scenario.goalObservation === 'tool' ? toolConfirms
      : input.scenario.goalObservation === 'state' ? stateConfirms : false;
    const unsupportedGoal = row.metricId === 'goal_attainment' && result !== 'unknown' && !goalConfirmed;
    if (unsupportedGoal) result = 'unknown';
    return validateAssessments(metrics.filter(m => m.id === row.metricId), availableEvents, [{ ...row, result,
      ...(unsupportedGoal ? { rationale: GOAL_UNSUPPORTED_RATIONALE } : {}),
    }])[0]!;
  });
}

const expectedProtocol = (configurationHash: string | undefined) => configurationHash
  ? fingerprint({ protocol: JUDGE_PROTOCOL, configuration: configurationHash }) : JUDGE_PROTOCOL;

/** Unanimous votes keep their result; any disagreement is unknown. Missing votes never aggregate. */
function recordedAggregate(input: Input, metricId: string, votes: (string | undefined)[]): boolean {
  if (votes.length !== 2 || votes.some(v => !v)) return false;
  const result = votes.every(v => v === votes[0]) ? votes[0] : 'unknown';
  return input.trial.assessments?.find(v => v.metricId === metricId)?.result === result;
}

/**
 * The receipt a trial keeps when its full audit lives in the sidecar file. `complete` is the
 * full-audit verdict at write time; a legacy attempt that failed can never seal as complete.
 */
export function sealJudgeReceipt(audit: JudgeAudit, complete: boolean): JudgeReceipt {
  const votes: JudgeReceipt['votes'] = [];
  for (const attempt of audit.attempts) {
    if (attempt.superseded) continue;
    if (attempt.metricId !== undefined) {
      const result = attempt.assessments?.[0]?.result;
      votes.push({ metricId: attempt.metricId, ...(result ? { result } : {}), ...(attempt.error ? { error: true } : {}) });
      continue;
    }
    if (attempt.error) complete = false;
    for (const assessment of attempt.assessments ?? []) votes.push({ metricId: assessment.metricId, result: assessment.result });
  }
  return judgeReceiptSchema.parse({
    protocolHash: audit.protocolHash, inputHash: audit.inputHash, provider: audit.provider, model: audit.model,
    ...(audit.configurationHash ? { configurationHash: audit.configurationHash } : {}),
    ...(audit.transport ? { transport: audit.transport } : {}),
    auditHash: fingerprint(audit), votes, notApplicable: audit.notApplicable, complete,
  });
}

/**
 * A receipt is trusted only as far as the record backs it: the input hash is re-derived from the
 * current record and the votes must re-aggregate to the recorded assessments.
 */
function hasCompleteReceipt(input: Input, receipt: JudgeReceipt, metrics: NonNullable<Input['scenario']['metrics']>): boolean {
  if (!receipt.complete || input.trial.assessmentError) return false;
  if (receipt.protocolHash !== expectedProtocol(receipt.configurationHash)) return false;
  const applicable = metrics.filter(m => metricApplies(m, input.trial));
  const notApplicable = metrics.filter(m => !metricApplies(m, input.trial)).map(m => m.id);
  if (fingerprint(receipt.notApplicable) !== fingerprint(notApplicable)) return false;
  if (receipt.inputHash !== fingerprint(judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } }))) return false;
  if (receipt.votes.some(v => v.error) || receipt.votes.length !== applicable.length * 2) return false;
  return applicable.every(m => recordedAggregate(input, m.id, receipt.votes.filter(v => v.metricId === m.id).map(v => v.result)));
}

/** Historical verdicts remain readable, but incomplete or stale receipts cannot support a comparison. */
export function hasCompleteJudgment(input: Input): boolean {
  if (!input.scenario || !checkpointReceiptValid(input.scenario, input.trial)) return false;
  const metrics = assessmentRubrics(input.scenario, input.trial);
  if (!metrics.length) return true;
  const audit = input.trial.judgeAudit;
  // A record with the full audit is always judged by it; the receipt serves records without one.
  if (!audit && input.trial.judgeReceipt) return hasCompleteReceipt(input, input.trial.judgeReceipt, metrics);
  if (!audit || input.trial.assessmentError || audit.prompt !== JUDGE_PROMPT) return false;
  if (audit.protocolHash !== expectedProtocol(audit.configurationHash)) return false;
  const applicable = metrics.filter(m => metricApplies(m, input.trial));
  const data = judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } });
  if (audit.inputHash !== fingerprint(data)) return false;
  try { if (fingerprint(JSON.parse(audit.input)) !== audit.inputHash) return false; } catch { return false; }
  const counted = audit.attempts.filter(a => !a.superseded);
  const isolated = counted.some(a => a.metricId !== undefined);
  if (counted.length !== (isolated ? applicable.length * 2 : applicable.length ? 2 : 0)) return false;
  try {
    for (const attempt of counted) {
      if (attempt.error || !attempt.raw?.trim()) return false;
      const requested = isolated ? applicable.filter(m => m.id === attempt.metricId) : applicable;
      if (isolated && (requested.length !== 1 || !attempt.input
        || fingerprint(JSON.parse(attempt.input)) !== fingerprint(judgeInput({ ...input, scenario: { ...input.scenario, metrics: requested } })))) return false;
      if (fingerprint(parseJudgment(attempt.raw, input, requested)) !== fingerprint(attempt.assessments)) return false;
    }
  } catch { return false; }
  return applicable.every(m => recordedAggregate(input, m.id,
    counted.filter(a => !isolated || a.metricId === m.id).map(a => a.assessments?.find(v => v.metricId === m.id)?.result)));
}

export async function assessRepeated(input: Input, model: { provider: string; id: string; configurationHash?: string; transport?: JudgeAudit['transport'] }, ctx: CallContext,
  respond: (prompt: string, input: string, recordPartial: (raw: string) => void) => Promise<string>): Promise<MetricAssessment[]> {
  const metrics = assessmentRubrics(input.scenario, input.trial);
  if (!metrics.length) return [];
  // Only the harness-owned reactive fidelity rubric has this applicability rule.
  const notApplicable = metrics.filter(m => !metricApplies(m, input.trial)).map(m => m.id);
  const applicable = metrics.filter(m => !notApplicable.includes(m.id));
  const data = judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } });
  const audit: JudgeAudit = {
    protocolHash: model.configurationHash ? fingerprint({ protocol: JUDGE_PROTOCOL, configuration: model.configurationHash }) : JUDGE_PROTOCOL,
    inputHash: fingerprint(data), provider: model.provider, model: model.id,
    ...(model.configurationHash ? { configurationHash: model.configurationHash } : {}),
    ...(model.transport ? { transport: model.transport } : {}),
    prompt: JUDGE_PROMPT, input: JSON.stringify(data), attempts: [], notApplicable,
  };
  const save = (final = false) => ctx.onJudgment?.(input.trial.id, structuredClone(audit), final);
  save();
  // Every vote is an independent fresh request, so one dialogue's votes run together. They are
  // launched in rubric order, which keeps the audit order stable; after any failure nothing new starts.
  const jobs = applicable.flatMap(metric => [{ metric, retry: false }, { metric, retry: false }]);
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (next < jobs.length && failure === undefined) {
      const { metric, retry } = jobs[next++]!;
      ctx.signal.throwIfAborted();
      const attempt: JudgeAudit['attempts'][number] = { metricId: metric.id, startedAt: new Date().toISOString(),
        input: JSON.stringify(judgeInput({ ...input, scenario: { ...input.scenario, metrics: [metric] } })),
      };
      audit.attempts.push(attempt);
      save(); // A crash leaves a visible pending request, not a missing favorable/unfavorable vote.
      try {
        attempt.raw = await respond(JUDGE_PROMPT, attempt.input!, raw => { attempt.raw = raw; save(); });
      } catch (error) {
        attempt.error = error instanceof Error ? error.message.slice(0, 4000) : 'Judge request failed';
        save();
        if (!RAG_METRIC_IDS.has(metric.id)) failure ??= error;
        continue;
      }
      save(); // Persist the original response before parsing; never repair a judgment in-place.
      try {
        attempt.assessments = parseJudgment(attempt.raw, input, [metric]);
      } catch (error) {
        attempt.error = error instanceof Error ? error.message.slice(0, 4000) : 'Invalid judgment';
        // A malformed answer is asked once more as a fresh request; the original stays on record and is not a vote.
        if (!retry) { attempt.superseded = true; jobs.push({ metric, retry: true }); }
      }
      save();
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(JUDGE_CONCURRENCY, jobs.length) },
    () => worker().catch(error => { failure ??= error; throw error; })));
  const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  // Exactly one final report per judgment, whatever happened; it never masks the original error.
  let saveFailure: unknown;
  let saveFailed = false;
  try { save(true); } catch (error) { saveFailed = true; saveFailure = error; }
  if (rejected) throw rejected.reason;
  if (failure !== undefined) throw failure;
  if (saveFailed) throw saveFailure;
  if (audit.attempts.some(a => a.error && !a.superseded && !RAG_METRIC_IDS.has(a.metricId ?? ''))) throw new Error('Judge response rejected; original responses and errors are preserved in judgeAudit');
  return metrics.map(metric => {
    if (notApplicable.includes(metric.id)) return { metricId: metric.id, result: 'unknown', evidence: [], rationale: RAG_METRIC_IDS.has(metric.id)
      ? 'Полный RAG-контекст каждого ответа не подтверждён адаптером; причина не установлена.' : 'Не применяется: реактивный симулятор не вызывался.' };
    const attempts = audit.attempts.filter(a => a.metricId === metric.id && !a.superseded);
    if (attempts.some(a => a.error)) return { metricId: metric.id, result: 'unknown', evidence: [], rationale: 'RAG-диагностика не завершена: ошибка судьи сохранена в judgeAudit. Основная оценка не изменена.' };
    const votes = attempts.map(a => a.assessments![0]!);
    if (votes.every(v => v.result === votes[0]!.result)) return { ...votes[0]!, rationale: `${AGREED_RATIONALE_PREFIX} ${votes[0]!.rationale}`.slice(0, 4000) };
    return { metricId: metric.id, result: 'unknown', evidence: [...new Set(votes.flatMap(v => v.evidence))].slice(0, 30),
      rationale: `${SPLIT_RATIONALE_PREFIX} ${votes.map(v => v.result).join(' / ')}. Основания каждой оценки сохранены в judgeAudit.` };
  });
}
