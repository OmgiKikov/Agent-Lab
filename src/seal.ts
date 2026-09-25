import { fingerprint, type Experiment, type Trial } from './contracts.js';

/*
 * The seal of a run's evidence. Every attempt a run or a re-assessment records is sealed once, where the engine records
 * it; wherever the number is derived (run.ts deriveRun) every seal is made again from the record and compared — no I/O,
 * so every surface and the CI exit code read the same verdict. An attempt recorded before seals existed has none; where
 * it carries a judge receipt, the receipt's votes must still give the results it sealed.
 *
 *   attempt recorded ──sealTrial──► trial.seal (never written again)
 *   deriveRun ──recordIntegrity──► 'sealed' · 'unsealed' (nothing to check) · 'altered': «запись изменена после прогона», no percent
 *
 * A seal has no secret: whoever computes it again can forge it, as they could a receipt. It makes an edit of the record
 * visible — a verdict turned, an attempt's words changed, a judgment's evidence moved, a duty taken out of the situation
 * it was judged by, a situation or an attempt taken out of the run — never merely unlikely. A field a later release adds to a stored shape must stay optional, never
 * defaulted, or it would change the seal of every attempt recorded before it (the rule the stored shapes already keep).
 */

/** The seal's own rule: a change of what it covers is a new name, never an edit. */
export const TRIAL_SEAL = 'trial-seal-v1';

/** What of a run the seals hold besides each attempt: its situations, each by its definition, and the attempts it plans. */
type Sealed = Pick<Experiment, 'scenarios' | 'settings' | 'positiveControlScenarioIds' | 'assessmentTrialIds'>;

/**
 * The run's plan as the number reads it: which situations it holds (by id), how many attempts of which customer each
 * gets, which are controls, which attempts a re-assessment judged again. Taking a situation or an attempt out of a run,
 * or making a failed situation a control, changes it.
 */
const planOf = (record: Sealed): string => fingerprint({ scenarios: record.scenarios.map(scenario => scenario.id).sort(), repeats: record.settings.repeats,
  userModes: record.settings.userModes, controls: [...record.positiveControlScenarioIds ?? []].sort(), assessed: record.assessmentTrialIds ?? null });

/** The seal of one attempt from its parts: the attempt as recorded, its situation's definition hash and the run's plan. */
function seal(trial: Trial, definition: string | null, plan: string): string {
  const { seal: _seal, ...recorded } = trial;
  const receipt = recorded.judgeReceipt && { ...recorded.judgeReceipt, complete: undefined };
  return fingerprint({ protocol: TRIAL_SEAL, trial: { ...recorded, ...(receipt ? { judgeReceipt: receipt } : {}) }, definition, plan });
}

/**
 * The seal of one recorded attempt of `record`: the whole attempt but the seal itself and its judge receipt's
 * `complete` — a reader's own verdict on the sidecar audit, which a reader that cannot match the sidecar marks false in
 * its copy (artifacts.ts) —, the definition of the situation it was judged by, and the run's plan.
 */
export function sealTrial(trial: Trial, record: Sealed): string {
  const definition = record.scenarios.find(scenario => scenario.id === trial.scenarioId);
  return seal(trial, definition ? fingerprint(definition) : null, planOf(record));
}

/**
 * Whether the judge receipt of an attempt recorded before seals still gives the results it sealed: each assessment's result
 * is the unanimous result of its two votes (unknown when they differ, when a vote failed, or where the rubric did not
 * apply). A verdict the votes cannot tell apart — fewer than two votes, a judgment older than receipts — is not held
 * against the record.
 */
function receiptHolds(trial: Trial): boolean {
  const receipt = trial.judgeReceipt;
  if (!receipt || !trial.assessments) return true;
  return trial.assessments.every(assessment => {
    if (receipt.notApplicable.includes(assessment.metricId)) return assessment.result === 'unknown';
    const votes = receipt.votes.filter(vote => vote.metricId === assessment.metricId);
    if (!votes.length) return assessment.result === 'unknown';
    if (votes.some(vote => vote.error)) return assessment.result === 'unknown';
    const [first, second, ...more] = votes;
    if (!first?.result || !second?.result || more.length) return true;
    return assessment.result === (first.result === second.result ? first.result : 'unknown');
  });
}

/** How far a record's evidence can be believed; `altered` withholds the number on every surface. */
export type Integrity = 'sealed' | 'unsealed' | 'altered';

/**
 * The record's evidence as the number may use it: `altered` when a sealed attempt no longer matches its seal — its own
 * content, or the definition of its situation — or an older attempt's judge receipt no longer gives its recorded results;
 * `sealed` when every attempt is sealed and holds;
 * `unsealed` otherwise — a record written before seals, with nothing that contradicts it (nothing to check is not an
 * alteration). Pure.
 */
export function recordIntegrity(record: Pick<Experiment, 'trials'> & Sealed): Integrity {
  let sealed = record.trials.length > 0;
  const plan = record.trials.some(trial => trial.seal !== undefined) ? planOf(record) : '';
  const definitions = new Map<string, string | null>();
  const definitionOf = (id: string): string | null => {
    if (!definitions.has(id)) { const scenario = record.scenarios.find(item => item.id === id); definitions.set(id, scenario ? fingerprint(scenario) : null); }
    return definitions.get(id)!;
  };
  for (const trial of record.trials) {
    if (trial.seal === undefined) {
      sealed = false;
      if (!receiptHolds(trial)) return 'altered';
    } else if (seal(trial, definitionOf(trial.scenarioId), plan) !== trial.seal) return 'altered';
  }
  return sealed ? 'sealed' : 'unsealed';
}
