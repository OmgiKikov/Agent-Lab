import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointReceiptValid, directChecks, requiredCheckpointResult } from '../src/checkpoints.js';
import { experimentSchema, type Experiment, type Scenario, type Trial } from '../src/contracts.js';
import { hasCompleteJudgment, observableSources, scenarioSources } from '../src/judge.js';
import { automaticTrialResult } from '../src/outcomes.js';
import { libraryV1File } from './helpers/library-v1.js';

/*
 * The frozen read path of first-format runs judged by the checkpoint judge (test/fixtures/library-v1):
 * nothing writes checkpoint verdicts any more, but the stored ones keep their rule and their receipts.
 */

const stored = async () => experimentSchema.parse(await libraryV1File('run.json'));
const cardOf = (record: Experiment, trial: Trial): Scenario => record.scenarios.find(item => item.id === trial.scenarioId)!;

test('a stored checkpoint verdict keeps its frozen rule: every required checkpoint, then the library rubric', async () => {
  const record = await stored();
  for (const trial of record.trials) {
    const scenario = cardOf(record, trial);
    assert.ok(checkpointReceiptValid(scenario, trial), `receipt of ${trial.id}`);
    const checkpoint = requiredCheckpointResult(scenario, trial);
    assert.ok(checkpoint === 'pass' || checkpoint === 'fail', 'the stored checkpoints decided the attempt');
    if (checkpoint === 'fail') assert.equal(automaticTrialResult(scenario, trial, record.humanReviews), 'fail', 'a failed required checkpoint fails the attempt');
  }
});

test('a changed checkpoint verdict no longer matches its receipt: the attempt is undecided and its judgment incomplete', async () => {
  const record = await stored();
  const trial = structuredClone(record.trials.find(item => requiredCheckpointResult(cardOf(record, item), item) === 'fail')!);
  const scenario = cardOf(record, trial);
  trial.checkpoints = trial.checkpoints!.map(checkpoint => ({ ...checkpoint, result: 'pass' as const }));
  assert.equal(checkpointReceiptValid(scenario, trial), false);
  assert.equal(requiredCheckpointResult(scenario, trial), 'unknown', 'a verdict its receipt does not back decides nothing');
  assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(scenarioSources(record, scenario), record.requirements), trial }), false);
});

test('only an attempt with a checkpoint verdict is graded without the checkpoints\' exact checks', async () => {
  const record = await stored();
  const [trial] = record.trials;
  const scenario: Scenario = { ...cardOf(record, trial!), checks: [{ id: 'literal', kind: 'answer_contains', description: 'Уточнение', value: 'номер' }] };
  const view = scenario.execution!.evaluatorView;
  if (!('checkpoints' in view)) throw new Error('a first-format card');
  const withCheck: Scenario = { ...scenario, execution: { ...scenario.execution!, evaluatorView: { ...view,
    checkpoints: [...view.checkpoints, { ...view.checkpoints[0]!, id: 'exact', check: scenario.checks[0] }] } } as Scenario['execution'] };
  assert.deepEqual(directChecks(withCheck, trial!).map(check => check.id), [], 'the checkpoint judge applied it where the checkpoint applied');
  const { checkpoints: _verdicts, checkpointReceipt: _receipt, ...projected } = trial!;
  assert.deepEqual(directChecks(withCheck, projected).map(check => check.id), ['literal'], 'judged through the projection, the exact check is direct');
  assert.equal(requiredCheckpointResult(withCheck, projected), undefined, 'without a checkpoint verdict there is no checkpoint half');
  assert.equal(checkpointReceiptValid(withCheck, projected), true, 'and no receipt to demand');
});
