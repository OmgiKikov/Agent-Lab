#!/usr/bin/env node
// Read-only counts over stored pilot runs through a built dist/. Prints ids and numbers only:
// stored runs hold bank dialogues, so no card names, dialogue turns or judge wording leave this script.
//
//   node verify-stored-runs.mjs [--dist DIR] [--data DIR]
//     --expect RUN:PASSED:DECIDED:NOT_MEASURED   (repeatable)
//     --audit RUN:COMPLETE/JUDGED                (repeatable)
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: {
  dist: { type: 'string', default: resolve(repo, 'dist') },
  data: { type: 'string', default: resolve(repo, '.agent-lab') },
  expect: { type: 'string', multiple: true, default: [] },
  audit: { type: 'string', multiple: true, default: [] },
} });
const load = name => import(pathToFileURL(resolve(values.dist, name)).href);
const [{ ExperimentStore }, { buildResultView }, { hasCompleteJudgment, observableSources }, { measured }] =
  await Promise.all(['store.js', 'result-view.js', 'judge.js', 'outcomes.js'].map(load));

const expectations = new Map(values.expect.map(item => {
  const [id, passed, decided, notMeasured] = item.split(':');
  return [id, { passed: Number(passed), decided: Number(decided), notMeasured: Number(notMeasured) }];
}));
const audits = new Map(values.audit.map(item => {
  const [id, counts] = item.split(':');
  const [complete, judged] = counts.split('/').map(Number);
  return [id, { complete, judged }];
}));

const store = new ExperimentStore(values.data);
let mismatch = false;
for (const id of new Set([...expectations.keys(), ...audits.keys()])) {
  const record = await store.get(id);
  const view = buildResultView(record);
  const sources = observableSources(record.sources, record.requirements);
  let judged = 0;
  let complete = 0;
  for (const trial of record.trials) {
    const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
    if (!scenario?.metrics?.length || !measured(trial)) continue;
    judged++;
    if (hasCompleteJudgment({ scenario, sources, trial })) complete++;
  }
  const reasons = view.notMeasured.reasons.map(item => `${item.code}:${item.count}`).join(',') || '-';
  const exclusions = view.coverage.excluded.reduce((n, item) => n + item.count, 0);
  console.log(`${id.slice(0, 8)} cards=${view.cards.length} passed=${view.headline.passed} decided=${view.headline.decided} `
    + `notMeasured=${view.notMeasured.total} reasons=${reasons} exclusions=${exclusions} audit=${complete}/${judged}`);
  const expected = expectations.get(id);
  if (expected && (expected.passed !== view.headline.passed || expected.decided !== view.headline.decided || expected.notMeasured !== view.notMeasured.total)) {
    mismatch = true;
    console.log(`MISMATCH ${id} expected ${expected.passed}/${expected.decided}/${expected.notMeasured}, got ${view.headline.passed}/${view.headline.decided}/${view.notMeasured.total}`);
  }
  const audit = audits.get(id);
  if (audit && (audit.complete !== complete || audit.judged !== judged)) {
    mismatch = true;
    console.log(`MISMATCH ${id} audit expected ${audit.complete}/${audit.judged}, got ${complete}/${judged}`);
  }
}
process.exitCode = mismatch ? 1 : 0;
