import { z } from 'zod';
import { assessmentEventContent, assessmentRubrics, fingerprint, MACHINE_FORMAT, metricApplies, metricAssessmentSchema, RAG_METRIC_IDS, validateAssessments, type CallContext, type JudgeAudit, type MetricAssessment, type Requirement, type Runtime, type Source } from './contracts.js';
import { ASSESS_ROLE, DATA_BOUNDARY } from './prompts.js';

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
Events of type retrieval are the exact RAG fragments the target adapter says were supplied for that reply. For rag_context_* rubrics, compare those events with the delivered user request and the applicable owner requirements. Never treat the full owner sources as retrieved context. Cite retrieval events and assistant events that support the decision; if the trace cannot establish the condition, return unclear.
Return exactly one compact JSON object, without markdown fences, matching this schema:
${JSON.stringify(z.toJSONSchema(responseSchema))}`;
export const JUDGE_PROTOCOL = fingerprint({ version: 10, promptSources: 'observable-rules', ragEvidence: 'adapter-reported-retrieval-events', goalObservation: 'owner-selected-cited-channel', unobservedActions: 'deterministic-unknown', prompt: JUDGE_PROMPT, responseFormat: JUDGE_RESPONSE_FORMAT, applicability: 'reactive-actor-was-called', repeatsPerMetric: 2, aggregation: 'per-metric-unanimous-exclusive-conditions', repair: false, temperature: '0 for non-reasoning models; otherwise default', thinking: 'medium for reasoning models; otherwise off', maxTokens: 16384 });
type Input = Parameters<NonNullable<Runtime['assess']>>[0];

/**
 * The judge never reads the agent's prompt as text. A prompt source reaches it as the numbered
 * rules a user could observe, extracted at preparation and filtered again here, so an internal
 * format or tool instruction cannot become a verdict. Every other source is passed unchanged.
 */
export function observableSources(sources: Source[], requirements: Requirement[]): Source[] {
  return sources.map(source => {
    if (source.kind !== 'prompt') return source;
    const rules = requirements.filter(r => r.sourceId === source.id && !MACHINE_FORMAT.test(r.quote)).map((r, i) => `${i + 1}. «${r.quote}»`);
    const content = rules.length
      ? `Наблюдаемые правила промпта агента, извлечённые при подготовке; внутренние правила формата ответа и работы с инструментами исключены:\n${rules.join('\n')}`
      : 'Наблюдаемых правил из промпта агента не извлечено: ни одно правило промпта к этому диалогу не применимо.';
    return { ...source, content };
  });
}

/** This is the complete, frozen judge input. Prior verdicts, usage and run identity are deliberately absent. */
export function judgeInput(input: Input) {
  const observationMissing = !input.trial.observation || input.trial.observation.state === 'missing';
  const scope = input.trial.userMode === 'static'
    ? 'Opening and first answer ONLY. Planned follow-ups were not delivered. Never penalize the agent for their absence.'
    : 'Evaluate only delivered requests, within the rubric stage.';
  return {
    scenario: { metrics: input.scenario.metrics, successCriteria: input.scenario.successCriteria, checks: input.scenario.checks, goalObservation: input.scenario.goalObservation,
      user: input.trial.userMode === 'static' ? { ...input.scenario.user, script: [], maxFollowUps: 0 } : input.scenario.user },
    evaluationScope: observationMissing
      ? `${scope} Agent prose proves only what was said. Without observed state, action-dependent pass conditions remain unclear; assess reply quality independently.`
      : scope,
    sources: input.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content })),
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
    let result = passCondition === 'met' && failCondition === 'not_met' ? 'pass'
      : failCondition === 'met' && passCondition === 'not_met' ? 'fail' : 'unknown';
    if (row.evidence.some(seq => !events.has(seq))) throw new Error(`Assessment ${row.metricId} cites a nonexistent trace event`);
    if (result !== 'unknown' && !row.evidence.length) throw new Error(`Assessment ${row.metricId} needs trace evidence for pass/fail`);
    const citedEvents = row.evidence.map(seq => input.trial.events.find(event => event.seq === seq)!);
    const replyConfirms = citedEvents.some(event => event.type === 'assistant');
    if (RAG_METRIC_IDS.has(row.metricId) && result !== 'unknown') {
      if (!citedEvents.some(event => event.type === 'retrieval') || !metricApplies(metrics.find(metric => metric.id === row.metricId)!, input.trial)
        || row.metricId === 'rag_context_faithfulness' && !replyConfirms
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
    return validateAssessments(metrics.filter(m => m.id === row.metricId), input.trial.events, [{ ...row, result,
      ...(unsupportedGoal ? { rationale: 'Достижение цели не подтверждено цитированным доказательством выбранного владельцем типа; слова агента оцениваются отдельно.' } : {}),
    }])[0]!;
  });
}

/** Historical verdicts remain readable, but incomplete or stale receipts cannot support a comparison. */
export function hasCompleteJudgment(input: Input): boolean {
  if (!input.scenario) return false;
  const metrics = assessmentRubrics(input.scenario, input.trial);
  if (!metrics.length) return true;
  const audit = input.trial.judgeAudit;
  if (!audit || input.trial.assessmentError || audit.prompt !== JUDGE_PROMPT) return false;
  const expectedProtocol = audit.configurationHash
    ? fingerprint({ protocol: JUDGE_PROTOCOL, configuration: audit.configurationHash }) : JUDGE_PROTOCOL;
  if (audit.protocolHash !== expectedProtocol) return false;
  const applicable = metrics.filter(m => metricApplies(m, input.trial));
  const data = judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } });
  if (audit.inputHash !== fingerprint(data)) return false;
  try { if (fingerprint(JSON.parse(audit.input)) !== audit.inputHash) return false; } catch { return false; }
  const isolated = audit.attempts.some(a => a.metricId !== undefined);
  if (audit.attempts.length !== (isolated ? applicable.length * 2 : applicable.length ? 2 : 0)) return false;
  try {
    for (const attempt of audit.attempts) {
      if (attempt.error || !attempt.raw?.trim()) return false;
      const requested = isolated ? applicable.filter(m => m.id === attempt.metricId) : applicable;
      if (isolated && (requested.length !== 1 || !attempt.input
        || fingerprint(JSON.parse(attempt.input)) !== fingerprint(judgeInput({ ...input, scenario: { ...input.scenario, metrics: requested } })))) return false;
      if (fingerprint(parseJudgment(attempt.raw, input, requested)) !== fingerprint(attempt.assessments)) return false;
    }
  } catch { return false; }
  return applicable.every(m => {
    const votes = audit.attempts.filter(a => !isolated || a.metricId === m.id).map(a => a.assessments?.find(v => v.metricId === m.id)?.result);
    if (votes.length !== 2 || votes.some(v => !v)) return false;
    const result = votes.every(v => v === votes[0]) ? votes[0] : 'unknown';
    return input.trial.assessments?.find(v => v.metricId === m.id)?.result === result;
  });
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
  const save = () => ctx.onJudgment?.(input.trial.id, structuredClone(audit));
  save();
  for (const metric of applicable) for (let repeat = 0; repeat < 2; repeat++) {
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
      if (!RAG_METRIC_IDS.has(metric.id)) throw error;
      continue;
    }
    save(); // Persist the original response before parsing; never repair a judgment in-place.
    try {
      attempt.assessments = parseJudgment(attempt.raw, input, [metric]);
    } catch (error) {
      attempt.error = error instanceof Error ? error.message.slice(0, 4000) : 'Invalid judgment';
    }
    save();
  }
  if (audit.attempts.some(a => a.error && !RAG_METRIC_IDS.has(a.metricId ?? ''))) throw new Error('Judge response rejected; original responses and errors are preserved in judgeAudit');
  return metrics.map(metric => {
    if (notApplicable.includes(metric.id)) return { metricId: metric.id, result: 'unknown', evidence: [], rationale: RAG_METRIC_IDS.has(metric.id)
      ? 'Полный RAG-контекст каждого ответа не подтверждён адаптером; причина не установлена.' : 'Не применяется: реактивный симулятор не вызывался.' };
    const attempts = audit.attempts.filter(a => a.metricId === metric.id);
    if (attempts.some(a => a.error)) return { metricId: metric.id, result: 'unknown', evidence: [], rationale: 'RAG-диагностика не завершена: ошибка судьи сохранена в judgeAudit. Основная оценка не изменена.' };
    const votes = attempts.map(a => a.assessments![0]!);
    if (votes.every(v => v.result === votes[0]!.result)) return { ...votes[0]!, rationale: `Совпало 2/2 оценок этой рубрики в свежих сессиях; это не проверка правильности. ${votes[0]!.rationale}`.slice(0, 4000) };
    return { metricId: metric.id, result: 'unknown', evidence: [...new Set(votes.flatMap(v => v.evidence))].slice(0, 30),
      rationale: `Судья разошёлся на неизменном входе: ${votes.map(v => v.result).join(' / ')}. Основания каждой оценки сохранены в judgeAudit.` };
  });
}
