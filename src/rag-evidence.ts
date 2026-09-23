import { assessmentEventContent, fingerprint, RAG_RUBRICS, type Rubric, type Runtime, type TraceEvent, type Trial } from './contracts.js';

type Input = Parameters<NonNullable<Runtime['assess']>>[0];

/** Bind the adapter's last context to its next reply, in trace order (seq is an identity, not a clock). */
function ragReplyContexts(trial: Pick<Trial, 'events'>) {
  const contexts: { userSeqs: number[]; retrievalSeq?: number; answerSeq: number }[] = [];
  const userSeqs: number[] = [];
  let retrievalSeq: number | undefined;
  for (const event of trial.events) {
    if (event.type === 'user') { userSeqs.push(event.seq); retrievalSeq = undefined; }
    if (event.type === 'retrieval') retrievalSeq = event.seq;
    if (event.type === 'assistant') {
      contexts.push({ userSeqs: [...userSeqs], ...(retrievalSeq === undefined ? {} : { retrievalSeq }), answerSeq: event.seq });
      retrievalSeq = undefined;
    }
  }
  return contexts;
}

/** Only delivered text and adapter-reported context can be evidence for a RAG diagnostic. */
export function ragJudgeEvents(input: Input, metricId: string): TraceEvent[] {
  return input.trial.events.flatMap<TraceEvent>(event => {
    if (event.type === 'retrieval') {
      const value = event.result as { chunks?: unknown; complete?: unknown; stage?: unknown } | undefined;
      return [{ seq: event.seq, type: event.type, result: { chunks: value?.chunks, complete: value?.complete,
        ...(value?.stage ? { stage: value.stage } : {}) } }];
    }
    if (event.type === 'user' || event.type === 'assistant' && metricId === 'rag_context_faithfulness') {
      return [{ seq: event.seq, type: event.type, text: event.text ?? '' }];
    }
    return [];
  });
}

/** A separate payload, not a prompt-only promise to ignore reference answers and hidden fixtures. */
export function ragJudgeInput(input: Input, metric: Rubric) {
  metric = RAG_RUBRICS.find(rubric => rubric.id === metric.id) ?? metric;
  const reference = metric.id === 'rag_context_recall';
  return {
    scenario: { metrics: [metric], ...(reference ? {
      successCriteria: input.scenario.successCriteria,
      ...(input.scenario.execution ? { evaluatorView: input.scenario.execution.evaluatorView } : {}),
    } : {}) },
    sources: reference ? input.sources.filter(source => source.kind !== 'prompt')
      .map(({ id, name, content }) => ({ id, name, content, hash: fingerprint(content) })) : [],
    evaluationScope: reference
      ? 'Context sufficiency against the supplied reference materials for delivered user requests only. This is not measured recall over the entire knowledge base.'
      : 'Only delivered user messages and the adapter-reported context are available. No reference answer, owner policy, planned user facts or fixture state is supplied.',
    replyContexts: ragReplyContexts(input.trial),
    trial: { userMode: input.trial.userMode,
      events: ragJudgeEvents(input, metric.id).map(event => ({ seq: event.seq, type: event.type, content: assessmentEventContent(event) })) },
  };
}

/** A later retrieval cannot be the cited support for an earlier answer. Every answer needs its own pair for a pass. */
export function ragFaithfulnessEvidence(trial: Pick<Trial, 'events'>, evidence: number[], result: 'pass' | 'fail'): boolean {
  const contexts = ragReplyContexts(trial);
  const cited = new Set(evidence);
  const supported = contexts.filter(context => cited.has(context.answerSeq) && context.retrievalSeq !== undefined && cited.has(context.retrievalSeq));
  return result === 'pass' ? contexts.length > 0 && supported.length === contexts.length
    : supported.length > 0 && contexts.filter(context => cited.has(context.answerSeq)).every(context => supported.includes(context));
}
