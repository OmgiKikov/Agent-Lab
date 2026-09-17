#!/usr/bin/env node
// Read-only «before/after» counts of undecided situations over stored runs, through a built dist/.
// Stored runs hold bank dialogues, so only ids, reason codes and numbers leave this script:
// no card titles, dialogue turns, judge rationales or exclusion reasons.
//
//   node measure-undecided.mjs [--dist DIR] [--data DIR] --id RUN [--id RUN …]
//     --cards PREFIX,PREFIX       per-card lines for scenario ids with these prefixes
//     --print-trials              with --cards: one `trial=` line per matching trial
//     --explain                   per failed situation: row roles and verification counts, no text
//   node measure-undecided.mjs --newest-assessment-of RUN --since ISO
//     prints the id of the newest reassessment of RUN created at or after ISO; exit 1 when none
//
// A RUN may be a full id or a unique prefix. Exit 2 when a requested record is missing.
// `simulatorCut` and `JUDGE_PROTOCOL_V10` are optional exports, so the phase-1 dist also works.
// `explain.js` is optional too: a dist without it prints `explain=n/a` instead of the rows.
import { parseArgs } from 'node:util';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: {
  dist: { type: 'string', default: resolve(repo, 'dist') },
  data: { type: 'string', default: resolve(repo, '.agent-lab') },
  id: { type: 'string', multiple: true, default: [] },
  cards: { type: 'string' },
  'print-trials': { type: 'boolean', default: false },
  explain: { type: 'boolean', default: false },
  'newest-assessment-of': { type: 'string' },
  since: { type: 'string' },
} });
const load = name => import(pathToFileURL(resolve(values.dist, name)).href);
const [{ ExperimentStore }, { buildResultView }, judge, { fingerprint }] =
  await Promise.all(['store.js', 'result-view.js', 'judge.js', 'contracts.js'].map(load));
const { JUDGE_PROTOCOL, JUDGE_PROTOCOL_V10, simulatorCut } = judge;
// Optional: a dist built before 02-04 has no explanations at all.
const { failureExplanation } = await load('explain.js').catch(() => ({}));
if (values.explain && typeof failureExplanation !== 'function') console.log('explain=n/a');

const store = new ExperimentStore(values.data);
const FIDELITY = 'user_fidelity';

async function resolveId(prefix) {
  let names;
  try { names = await readdir(values.data); } catch { names = []; }
  const ids = [...new Set(names.filter(n => n.endsWith('.json') && n.startsWith(prefix)).map(n => n.slice(0, -5)))];
  return ids.length === 1 ? ids[0] : null;
}

if (values['newest-assessment-of']) {
  const source = (await resolveId(values['newest-assessment-of'])) ?? values['newest-assessment-of'];
  const since = values.since ? Date.parse(values.since) : -Infinity;
  if (Number.isNaN(since)) { console.error('--since is not an ISO date'); process.exit(2); }
  const newest = (await store.list())
    .filter(r => r.assessmentOf === source && Date.parse(r.createdAt) >= since)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!newest) process.exit(1);
  console.log(newest.id);
  process.exit(0);
}

/** v10 / v11 / null for one judged trial. */
function protocolVersion(trial) {
  const judged = trial.judgeAudit ?? trial.judgeReceipt;
  if (!judged) return null;
  const wrap = protocol => judged.configurationHash ? fingerprint({ protocol, configuration: judged.configurationHash }) : protocol;
  if (JUDGE_PROTOCOL_V10 === undefined) return judged.protocolHash === wrap(JUDGE_PROTOCOL) ? 'v10' : null;
  if (judged.protocolHash === wrap(JUDGE_PROTOCOL_V10)) return 'v10';
  if (judged.protocolHash === wrap(JUDGE_PROTOCOL)) return 'v11';
  return null;
}

/** The fidelity votes of one audit: isolated attempts carry one metric each, legacy attempts carry all. */
function fidelityVotes(audit) {
  return audit.attempts.flatMap(attempt => {
    if (attempt.metricId !== undefined) return attempt.metricId === FIDELITY && attempt.assessments?.[0] ? [attempt.assessments[0]] : [];
    const vote = attempt.assessments?.find(item => item.metricId === FIDELITY);
    return vote ? [vote] : [];
  });
}

const prefixes = values.cards ? values.cards.split(',').map(item => item.trim()).filter(Boolean) : [];
let missing = false;
for (const requested of values.id) {
  const id = await resolveId(requested);
  if (!id) { console.log(`MISSING ${requested.slice(0, 8)}`); missing = true; continue; }
  const record = await store.get(id);
  const view = buildResultView(record);
  const judged = record.trials.filter(trial => trial.assessments?.length);
  const versions = { v10: 0, v11: 0 };
  let cutEligible = 0;
  for (const trial of judged) {
    const version = protocolVersion(trial);
    if (version) versions[version]++;
    if (typeof simulatorCut === 'function') {
      const audit = trial.judgeAudit ?? await store.readJudgeAudit(id, trial.id);
      if (audit && simulatorCut(fidelityVotes(audit), trial.events) !== undefined) cutEligible++;
    }
  }
  const cards = view.cards.length, notMeasured = view.notMeasured.total;
  const reasons = view.notMeasured.reasons.map(item => `${item.code}:${item.count}`).join(',') || '-';
  const cuts = record.trials.filter(trial => trial.judgedBeforeSeq !== undefined).length;
  console.log(`${id.slice(0, 8)} cards=${cards} passed=${view.headline.passed} decided=${view.headline.decided} `
    + `notMeasured=${notMeasured} share=${cards ? Math.round(100 * notMeasured / cards) : 0}% reasons=${reasons} `
    + `judged=${judged.length} v10=${versions.v10} `
    + `v11=${JUDGE_PROTOCOL_V10 === undefined ? '-' : versions.v11} cuts=${cuts} `
    + `cutEligible=${typeof simulatorCut === 'function' ? cutEligible : '-'}`);
  if (!prefixes.length) continue;
  for (const row of view.cards) {
    if (!prefixes.some(prefix => row.scenarioId.startsWith(prefix))) continue;
    const trials = record.trials.filter(trial => trial.scenarioId === row.scenarioId);
    const cut = trials.map(trial => trial.judgedBeforeSeq).filter(seq => seq !== undefined);
    console.log(`card=${row.scenarioId.slice(0, 8)} outcome=${row.outcome} reason=${row.reason ?? '-'} cut=${cut.length ? cut.join('/') : '-'}`);
    if (values['print-trials']) for (const trial of trials) console.log(`trial=${trial.id} card=${row.scenarioId.slice(0, 8)}`);
  }
}

/**
 * `--explain`: the shape of every failed situation's explanation, never its text. One line per
 * failed headline situation (controls left out, record order — the same set `buildResultView`
 * puts in `view.failures`), then one run line of totals.
 */
if (values.explain && typeof failureExplanation === 'function') {
  for (const requested of values.id) {
    const id = await resolveId(requested);
    if (!id) continue;
    const record = await store.get(id);
    const view = buildResultView(record);
    const byId = new Map(view.cards.map(card => [card.scenarioId, card]));
    const trialById = new Map(record.trials.map(trial => [trial.id, trial]));
    let judgeCited = 0, unverifiedRows = 0, violated = 0, cuts = 0;
    let failed = 0;
    for (const scenario of record.scenarios) {
      const card = byId.get(scenario.id);
      if (card?.outcome !== 'fail' || card.control) continue;
      const explanation = failureExplanation(record, scenario);
      if (!explanation) continue;
      failed++;
      const cited = explanation.said?.judgeCited === true;
      if (cited) judgeCited++;
      const unverified = explanation.rows.filter(row => row.role === 'unverified').length;
      unverifiedRows += unverified;
      if (explanation.violated) violated++;
      // v10 keeps no cut: `judgedBeforeSeq` is absent, so this column reads `-` on every row.
      const cut = trialById.get(explanation.trialId)?.judgedBeforeSeq;
      if (cut !== undefined) cuts++;
      console.log(`card=${scenario.id.slice(0, 8)} kind=${explanation.kind} `
        + `roles=${explanation.rows.map(row => row.role).join(',')} judgeCited=${cited} `
        + `rules=${explanation.rules.length}+${explanation.moreRules} unverifiedRules=${explanation.unverifiedRules} `
        + `unverifiedRows=${unverified} violated=${explanation.violated ? explanation.violated.number : '-'} `
        + `cut=${cut ?? '-'}`);
    }
    console.log(`explain run=${id.slice(0, 8)} failed=${failed} judgeCited=${judgeCited} `
      + `unverifiedRows=${unverifiedRows} violated=${violated} cut=${cuts} viewFailures=${view.failures.length}`);
  }
}
if (missing) process.exit(2);
