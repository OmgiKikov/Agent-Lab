import { resolve } from 'node:path';
import type { Experiment } from '../src/contracts.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { draftHash, resultHash, type ExperimentLab } from '../src/experiment.js';
import { expectationSheet, trialProofLines } from '../src/quality.js';
import { buildResultView, type ResultView } from '../src/result-view.js';
import { MAX_WIDTH, nextRows, plainText, resultScreen } from '../src/result-text.js';
import { rememberView, VERDICT_KIND, type VerdictDetails } from './render/verdict-block.ts';

/*
 * What the chat's model reads about a run: the tool content, never drawn for the owner. The owner sees the
 * feed or the result block; the model gets the same numbers as JSON, with the result screen's lines so it
 * never has to restate or recount them.
 */

/** What the model reads instead of the block, so it does not restate the number and the causes. */
export const SHOWN_TO_OWNER = 'Блок с точностью и причинами уже показан владельцу. Не копируйте его строки. Назовите точность одной фразой и объясните по-человечески, где и почему агент хромает: что просили клиенты, что агент сделал вместо этого, какое правило владельца это нарушает; что он делает хорошо и насколько числу можно верить. Затем предложите следующий шаг.';

/** `view` is the evidence bundle's view when the caller has one, so stability matches the CLI summary. */
export function summary(record: Experiment, directory: string, view?: ResultView) {
  const comparison = record.comparisons.findLast(c => c.split === 'control');
  const block = record.trials.length ? view ?? buildResultView(record) : undefined;
  // A draft carries its whole expectation sheet, so what the agent must do stays in the model's context.
  const sheet = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length ? expectationSheet(record) : undefined;
  return {
    ...(sheet ? { sheetLines: sheet.lines } : {}),
    // Lead with the answer: the same screen the workspace and the CLI show — the number, the trust line, the
    // causes, every error, what was not measured and the owner's disagreements — then the view it is made of.
    ...(block ? { resultLines: plainText(resultScreen(block, { surface: 'board', details: true }), MAX_WIDTH).split('\n'), view: block } : {}),
    id: record.id, runKind: record.runKind ?? 'evaluation', phase: record.phase, mode: record.mode, workflow: record.workflow,
    reviewMode: record.reviewMode, resultsReviewedAt: record.resultsReviewedAt,
    draftHash: draftHash(record), acceptedDraftHash: record.acceptedDraftHash, resultHash: record.trials.length ? resultHash(record) : undefined,
    message: record.message, error: record.error, questions: record.questions,
    scenarioCount: record.scenarios.length, revisionCount: record.revisions.length,
    target: record.target, dialogueCount: record.dialogues.length,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, parentRunId: record.parentRunId,
    positiveControlScenarioIds: record.positiveControlScenarioIds,
    trialCount: record.trials.length, humanReviews: record.humanReviews ?? [], usage: record.usage, failureModes: record.failureModes ?? [],
    comparison: comparison && {
      baselineId: comparison.baselineId, candidateId: comparison.candidateId,
      baselinePasses: comparison.baselinePasses, candidatePasses: comparison.candidatePasses,
      verdict: comparison.verdict, fixed: comparison.fixed, regressed: comparison.regressed,
      validPairs: comparison.validPairs, plannedPairs: comparison.plannedPairs,
      scenarioFamilies: comparison.families, delta: comparison.delta, interval: comparison.interval, reasons: comparison.reasons,
    },
    limitations: record.limitations,
    nextStep: block ? nextRows(block, 'chat')[0]?.text : undefined,
    artifacts: { evidence: resolve(directory, `${record.id}.json`),
      ...(record.trials.length ? { traceJournal: resolve(directory, `${record.id}.trace.jsonl`) } : {}) },
  };
}

/**
 * The result of a finished run for the model and for the chat: the model reads the JSON, the owner the block drawn
 * from the remembered view; the session keeps ids only (REV-01). `shown` learns the failure list as the owner saw it.
 */
export async function verdictOutput(record: Experiment, lab: ExperimentLab, shown: (failureIds: string[]) => void) {
  const bundle = await evidenceBundle(record, lab.store);
  if (bundle.view) shown(bundle.view.failures.map(item => item.scenarioId));
  const output = { ...summary(record, lab.store.directory, bundle.view), proofs: record.trials.map(trial => trialProofLines(record, trial.id)),
    comparison: bundle.comparison, artifacts: await exportArtifacts(bundle, lab.store.directory), shownToOwner: SHOWN_TO_OWNER };
  let details: VerdictDetails | { id: string } = { id: record.id };
  if (bundle.view) {
    const resultKey = `${record.id}:${resultHash(record)}`;
    rememberView(resultKey, bundle.view);
    details = { kind: VERDICT_KIND, version: 1, runId: record.id, resultKey };
  }
  return { output, details };
}
