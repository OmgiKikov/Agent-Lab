import { simulatorWasUsed, type Experiment } from './contracts.js';
import { metricApplies } from './assessment.js';

/** Recorded checks, not a claim that a model verdict proves realistic customer behaviour. */
export interface SimulatorEvidence {
  conversations: number;
  passed: number;
  failed: number;
  unknown: number;
  notChecked: number;
  heuristicFlags: number;
}

export function simulatorEvidence(record: Pick<Experiment, 'scenarios' | 'trials' | 'positiveControlScenarioIds'>): SimulatorEvidence {
  const result: SimulatorEvidence = { conversations: 0, passed: 0, failed: 0, unknown: 0, notChecked: 0, heuristicFlags: 0 };
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  for (const trial of record.trials) {
    if (controls.has(trial.scenarioId) || !simulatorWasUsed(trial)) continue;
    result.conversations++;
    const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
    const metrics = scenario?.metrics?.filter(metric => metric.subject === 'simulator' && metricApplies(metric, trial)) ?? [];
    if (!metrics.length) result.notChecked++;
    else {
      const verdicts = metrics.map(metric => trial.assessments?.find(item => item.metricId === metric.id)?.result);
      if (verdicts.includes('fail')) result.failed++;
      else if (verdicts.every(verdict => verdict === 'pass')) result.passed++;
      else result.unknown++;
    }
    if (trial.simulatorChecks?.some(check => !check.passed)) result.heuristicFlags++;
  }
  return result;
}
