#!/usr/bin/env node
// Offline reference calculation. Deliberately does not import the production counting helpers.
// This checks arithmetic and evidence eligibility, not the correctness of a model's interpretation.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { buildResultView } from '../dist/result-view.js';
import { hasCompleteJudgment, observableSources, scenarioSources } from '../dist/judge.js';

const { values } = parseArgs({ options: { record: { type: 'string' }, output: { type: 'string' }, snapshot: { type: 'boolean', default: false } } });
if (!values.record || !values.output) throw new Error('Usage: node scripts/reconcile-metric.mjs --record FILE --output NEW_JSON [--snapshot]');
const raw = await readFile(values.record);
const record = JSON.parse(raw);
const requireScope = (condition, reason) => { if (!condition) throw new Error(`Unsupported audit input: ${reason}`); };
const terminal = ['results_review', 'complete', 'interrupted', 'failed', 'cancelled'].includes(record.phase);
requireScope(terminal || values.snapshot, 'live run; use --snapshot for provisional output');
requireScope(record.workflow !== 'compare' && !record.assessmentTrialIds, 'comparison or reassessment subset');
requireScope(!record.humanReviews.length, 'human overrides require a separate reconciliation');
requireScope(record.settings.userModes.length === 1 && record.settings.userModes[0] === 'reactive', 'requires reactive-only run');
requireScope(Number.isInteger(record.settings.repeats) && record.settings.repeats > 0, 'repeat count');
requireScope(new Set(record.scenarios.map(s => s.id)).size === record.scenarios.length, 'duplicate scenario IDs');
requireScope(new Set(record.trials.map(t => t.id)).size === record.trials.length, 'duplicate trial IDs');
requireScope(record.trials.every(t => record.scenarios.some(s => s.id === t.scenarioId)), 'orphan trial');
const controls = new Set(record.positiveControlScenarioIds ?? []);
const receipts = [];
const rows = record.scenarios.filter(s => !controls.has(s.id)).map(scenario => {
  const expectations = scenario.execution?.evaluatorView.expectations;
  requireScope(scenario.execution?.evaluation === 'expectations-v1' && expectations?.length, 'requires compiled expectations');
  requireScope(expectations.every(e => e.observation === 'reply'), 'only reply evidence supported');
  requireScope(!scenario.checks.length, 'direct checks are outside this reference calculation');
  requireScope(scenario.metrics.filter(m => m.subject === 'simulator').length === 1 && scenario.metrics.some(m => m.id === 'user_fidelity'), 'requires one fidelity metric');
  const trials = record.trials.filter(t => t.scenarioId === scenario.id);
  const seen = new Set();
  let intact = true;
  const attempts = trials.map(trial => {
    requireScope(trial.countingVersion === 2 && !trial.checks.length, 'counting version or direct checks');
    const key = `${trial.userMode}:${trial.repeat}`;
    if (seen.has(key) || trial.userMode !== 'reactive' || !Number.isInteger(trial.repeat) || trial.repeat < 0 || trial.repeat >= record.settings.repeats
      || trial.familyId !== scenario.familyId || trial.split !== scenario.split || (record.manifestHash && trial.manifestHash !== record.manifestHash)) intact = false;
    seen.add(key);
    requireScope(isDeepStrictEqual(trial.initialState, scenario.initialState), 'initial state drift');
    const reasons = [];
    if (!['pass', 'fail', 'ungraded'].includes(trial.outcome)) reasons.push(`outcome:${trial.outcome}`);
    if (trial.assessmentError) reasons.push('judge_error');
    if (scenario.initialState.external && trial.observation?.resetConfirmed !== true) reasons.push('reset_unconfirmed');
    if ((trial.simulatorChecks ?? []).some(c => !c.passed)) reasons.push('customer_check_failed');
    const used = trial.events.some(e => e.type === 'simulator');
    if (used && trial.assessments?.find(a => a.metricId === 'user_fidelity')?.result !== 'pass') reasons.push('customer_fidelity_not_pass');
    const results = expectations.map(expectation => {
      const assessment = trial.assessments?.find(a => a.metricId === expectation.id);
      const supported = assessment?.evidence?.some(seq => trial.events.some(e => e.seq === seq && e.type === 'assistant'));
      return { id: expectation.id, result: supported && ['pass', 'fail'].includes(assessment.result) ? assessment.result : 'unknown' };
    });
    let verdict = 'unknown';
    if (!reasons.length) verdict = trial.outcome === 'fail' || results.some(r => r.result === 'fail') ? 'fail'
      : results.every(r => r.result === 'pass') ? 'pass' : 'unknown';
    receipts.push({ trialId: trial.id, present: !!(trial.judgeReceipt || trial.judgeAudit), assessmentError: !!trial.assessmentError,
      claimsComplete: trial.judgeReceipt?.complete === true, valid: hasCompleteJudgment({ scenario,
      trial, sources: observableSources(scenarioSources(record, scenario), record.requirements) }) });
    return { trialId: trial.id, repeat: trial.repeat, verdict, reasons, expectations: results };
  });
  const verdict = !intact ? 'unknown' : attempts.some(a => a.verdict === 'fail') ? 'fail'
    : attempts.length === record.settings.repeats && attempts.every(a => a.verdict === 'pass') ? 'pass' : 'unknown';
  return { scenarioId: scenario.id, verdict, intact, attempts };
});
const passed = rows.filter(r => r.verdict === 'pass').length;
const failed = rows.filter(r => r.verdict === 'fail').length;
const unknown = rows.length - passed - failed;
const reference = { passed, failed, unknown, total: rows.length, accuracy: passed + failed ? passed / (passed + failed) : null,
  bounds: rows.length ? [passed / rows.length, (passed + unknown) / rows.length] : null };
// Only after the independent calculation, compare with the application's result.
const view = buildResultView(record);
const differences = rows.flatMap(row => {
  const actual = view.cards.find(c => c.scenarioId === row.scenarioId)?.outcome;
  return actual === row.verdict ? [] : [{ scenarioId: row.scenarioId, reference: row.verdict, application: actual }];
});
const countsMatch = view.headline.passed === passed && view.headline.decided === passed + failed && view.headline.accuracy === reference.accuracy
  && view.notMeasured.of === rows.length && view.headline.range === null;
const report = { protocol: 'reply-metric-reconciliation-1', runId: record.id, sourceHash: createHash('sha256').update(raw).digest('hex'),
  phase: record.phase, provisional: !terminal, createdAt: new Date().toISOString(), reference, countsMatch, differences, receipts, rows,
  limitations: ['Checks arithmetic, plan membership and cited evidence channel, not semantic correctness.', 'Same-model agreement is not independent calibration.', 'Targeted situations do not estimate production traffic.'] };
await writeFile(values.output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ runId: record.id, provisional: report.provisional, reference, countsMatch, differences: differences.length,
  receipts: { valid: receipts.filter(r => r.valid).length, present: receipts.filter(r => r.present).length, total: receipts.length } }));
if (!countsMatch || differences.length || receipts.some(r => r.claimsComplete && !r.valid)) process.exitCode = 1;
