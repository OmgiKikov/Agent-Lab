#!/usr/bin/env node
// Live-check helper for plan 01-10: a spend guard and read-only record checks.
// Stored runs hold bank dialogues, so this script prints ids, counts, sizes and costs only:
// never card titles, dialogue text, judge rationales or exclusion reasons.
//
//   node live-check.mjs budget --reference RUN --ledger FILE --next run|reassess|build:N [--cap 10]
//   node live-check.mjs spent --ledger FILE [--cap 10]
//   node live-check.mjs record --id RUN
//   node live-check.mjs build-plan --task FILE --dialogues FILE
//   node live-check.mjs build-status --since ISO
//   node live-check.mjs watch --id RUN|latest-assessment-of:RUN|latest-child-of:RUN --pid PID --ledger FILE [--cap 10] [--minutes 45]
//   node live-check.mjs pick-counted --id RUN --exclude SCENARIO     (plan 01-12)
//   node live-check.mjs control --id RUN                             (plan 01-12; exit 0 pass, 1 not all pass, 2 no control)
//
// Common options: --dist DIR (default <repo>/dist), --data DIR (default <repo>/.agent-lab).
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: {
  dist: { type: 'string', default: resolve(repo, 'dist') },
  data: { type: 'string', default: resolve(repo, '.agent-lab') },
  reference: { type: 'string' }, ledger: { type: 'string' }, next: { type: 'string' },
  cap: { type: 'string', default: '10' }, id: { type: 'string' }, task: { type: 'string' },
  dialogues: { type: 'string' }, since: { type: 'string' }, pid: { type: 'string' },
  minutes: { type: 'string', default: '45' }, exclude: { type: 'string' },
} });
const cap = Number(values.cap);
const load = name => import(pathToFileURL(resolve(values.dist, name)).href);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
// The key of a full judge audit inside a record or a journal line (not the word inside a rationale).
const AUDIT_KEY = '"judgeAudit":';
const RUNNING = new Set(['preparing', 'evaluating']);
const money = value => `$${value.toFixed(4)}`;

function need(name) {
  if (!values[name]) { process.stderr.write(`Missing --${name}\n`); process.exit(2); }
  return values[name];
}
function recordPath(id) {
  if (!idPattern.test(id)) throw new Error('Invalid run id');
  return join(values.data, `${id}.json`);
}
/** Raw record (no schema): the watch loop may read a record another process is writing. */
async function rawRecord(id) {
  try { return JSON.parse(await readFile(recordPath(id), 'utf8')); } catch { return null; }
}
async function ledgerIds(file) {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  return [...new Set(text.split('\n').map(line => line.trim()).filter(Boolean))];
}
/** Recorded cost of one run; null when calls were made but the cost is unknown. */
function recordCost(record) {
  if (!record) return 0;
  let total = 0;
  let unknown = false;
  const add = usage => {
    if (!usage) return;
    if (usage.costUsd === null || usage.costUsd === undefined) { if (usage.calls > 0) unknown = true; return; }
    total += usage.costUsd;
  };
  add(record.usage);
  for (const trial of record.trials ?? []) add(trial.externalUsage);
  return unknown ? null : total;
}
async function spentOf(ids) {
  let total = 0;
  for (const id of ids) {
    const record = await rawRecord(id);
    if (!record) return null;
    const cost = recordCost(record);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

async function budget() {
  const { ExperimentStore } = await load('store.js');
  const { assessmentRubrics, metricApplies } = await load('contracts.js');
  const ref = await new ExperimentStore(values.data).get(need('reference'));
  let judgeCalls = 0;
  for (const trial of ref.trials) {
    if (!trial.assessments) continue;
    const scenario = ref.scenarios.find(item => item.id === trial.scenarioId);
    if (!scenario) continue;
    judgeCalls += 2 * assessmentRubrics(scenario, trial).filter(metric => metricApplies(metric, trial)).length;
  }
  if (!judgeCalls || ref.usage.costUsd === null) { console.log('spent=? upper=? cap=? decision=STOP'); process.exit(3); }
  const judgeRate = ref.usage.costUsd / judgeCalls;
  const [kind, count] = need('next').split(':');
  const n = Number(count);
  if (!['run', 'reassess', 'build'].includes(kind) || !Number.isFinite(n) || n < 0) throw new Error('--next must be run|reassess|build:N');
  const upper = kind === 'build' ? n * judgeRate : n * 14 * judgeRate * 1.1;
  const spent = await spentOf(await ledgerIds(need('ledger')));
  const go = spent !== null && spent + upper <= cap;
  console.log(`spent=${spent === null ? '?' : money(spent)} upper=${money(upper)} cap=$${cap} decision=${go ? 'GO' : 'STOP'} judgeRate=${money(judgeRate)} judgeCalls=${judgeCalls}`);
  process.exit(go ? 0 : 3);
}

async function spent() {
  const total = await spentOf(await ledgerIds(need('ledger')));
  if (total === null) { console.log('spent=? remaining=?'); process.exit(3); }
  const remaining = cap - total;
  console.log(`spent=${money(total)} remaining=${money(remaining)}`);
  process.exit(remaining < 0 ? 3 : 0);
}

async function countLines(file, needle) {
  let count = 0;
  try {
    const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) if (line.includes(needle)) count++;
  } catch { return 0; }
  return count;
}
async function sizeOf(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

async function record() {
  const id = need('id');
  const text = await readFile(recordPath(id), 'utf8');
  const raw = JSON.parse(text);
  const trials = raw.trials ?? [];
  const sidecarDir = join(values.data, `${id}.judge`);
  let sidecars = 0;
  let sidecarModesOk = true;
  let dirModeOk = false;
  try {
    dirModeOk = ((await stat(sidecarDir)).mode & 0o777) === 0o700;
    for (const name of await readdir(sidecarDir)) {
      if (!name.endsWith('.json')) continue;
      sidecars++;
      if (((await stat(join(sidecarDir, name))).mode & 0o777) !== 0o600) sidecarModesOk = false;
    }
  } catch { /* no sidecar directory */ }
  const trace = join(values.data, `${id}.trace.jsonl`);
  console.log(JSON.stringify({
    id8: id.slice(0, 8), phase: raw.phase, trials: trials.length,
    judged: trials.filter(trial => trial.assessments).length,
    assessmentErrors: trials.filter(trial => trial.assessmentError).length,
    receipts: trials.filter(trial => trial.judgeReceipt).length,
    auditKeys: text.split(AUDIT_KEY).length - 1,
    sidecars, sidecarModesOk, dirModeOk,
    recordBytes: Buffer.byteLength(text), traceBytes: await sizeOf(trace),
    traceAuditLines: await countLines(trace, AUDIT_KEY),
    calls: raw.usage?.calls ?? null, costUsd: recordCost(raw),
    targetFp10: raw.targetFingerprint?.slice(0, 10) ?? null,
    parent8: raw.parentRunId?.slice(0, 8) ?? null,
    assessmentOf8: raw.assessmentOf?.slice(0, 8) ?? null,
    control: (raw.positiveControlScenarioIds ?? []).map(item => item.slice(0, 8)),
  }));
}

async function buildPlan() {
  const { createInputSchema, fingerprint, VERSION } = await load('contracts.js');
  const { readData } = await load('imports.js');
  const raw = JSON.parse(await readFile(need('task'), 'utf8'));
  const dialogues = await readData(need('dialogues'), 'dialogues');
  const input = createInputSchema.parse({ ...raw, dialogues });
  // Same key as src/experiment.ts: the sources are built from materials exactly as newRecord does.
  const sources = input.materials.map((m, i) => ({ id: `source-${i + 1}`, name: m.name, content: m.content, ...(m.kind ? { kind: m.kind } : {}) }));
  const key = fingerprint({ task: input.task, sources: sources.map(({ id, name, content, kind }) => ({ id, name, content, kind })),
    provider: input.settings.provider, model: input.settings.model, roles: input.settings.roles, targetKind: input.target.kind, version: VERSION });
  const cached = (await sizeOf(join(values.data, 'grounding', `${key}.json`))) > 0;
  const n = input.dialogues.length;
  console.log(`cached=${cached} key=${key.slice(0, 8)} dialogues=${n} expectedCalls=${(cached ? 0 : 1) + n} cap=${(cached ? 0 : 5) + 2 * n}`);
}

async function recordsSince(since, match = () => true) {
  const found = [];
  for (const name of await readdir(values.data)) {
    if (!name.endsWith('.json') || !idPattern.test(name.slice(0, -5))) continue;
    const file = join(values.data, name);
    if ((await stat(file)).mtimeMs < since - 5000) continue;
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (typeof raw.createdAt !== 'string' || Date.parse(raw.createdAt) < since || !match(raw)) continue;
    found.push(raw);
  }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function buildStatus() {
  const since = Date.parse(need('since'));
  if (!Number.isFinite(since)) throw new Error('--since must be an ISO time');
  const [raw] = await recordsSince(since, item => !item.assessmentOf);
  if (!raw) { console.log(JSON.stringify({ outcome: 'none' })); process.exit(7); }
  const calls = raw.usage?.calls ?? 0;
  const budgetStop = ['Model call budget exhausted.', 'Experiment time limit reached.'].includes(raw.error);
  const outcome = raw.phase === 'review' ? 'review'
    : raw.phase === 'error' ? (budgetStop ? 'budget_stop' : calls > 0 ? 'crash' : 'failed_before_paid')
    : `other:${raw.phase}`;
  const exclusions = {};
  for (const item of raw.validationExclusions ?? []) exclusions[item.kind] = (exclusions[item.kind] ?? 0) + 1;
  console.log(JSON.stringify({ id: raw.id, id8: raw.id.slice(0, 8), phase: raw.phase, outcome, calls, costUsd: recordCost(raw),
    cards: raw.scenarios?.length ?? 0, dialogues: raw.dialogues?.length ?? 0, exclusions,
    collisionNote: (raw.limitations ?? []).some(line => line.startsWith('Модель выдала совпадающие id целей')) }));
  if (outcome === 'crash') process.stderr.write(`${String(raw.error).slice(0, 60)}\n`);
  process.exit({ review: 0, budget_stop: 4, crash: 5, failed_before_paid: 6 }[outcome] ?? 8);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function watch() {
  const target = need('id');
  const pid = Number(need('pid'));
  const ledger = need('ledger');
  const started = Date.now();
  const deadline = started + Number(values.minutes) * 60_000;
  const sourceId = target.startsWith('latest-assessment-of:') ? target.slice('latest-assessment-of:'.length) : null;
  const parentId = target.startsWith('latest-child-of:') ? target.slice('latest-child-of:'.length) : null;
  let id = sourceId || parentId ? null : target;
  let stopped = false;
  for (;;) {
    if (!id && sourceId) {
      const [found] = await recordsSince(started - 60_000, raw => raw.assessmentOf === sourceId);
      if (found) id = found.id;
    }
    if (!id && parentId) {
      const listed = new Set(await ledgerIds(ledger));
      const [found] = await recordsSince(started - 60_000, raw => raw.parentRunId === parentId && !listed.has(raw.id));
      if (found) { id = found.id; console.log(`resolved id=${id}`); }
    }
    const raw = id ? await rawRecord(id) : null;
    const cost = recordCost(raw);
    const others = await spentOf((await ledgerIds(ledger)).filter(item => item !== id));
    const phase = raw?.phase ?? 'pending';
    console.log(`${new Date().toISOString()} id=${id?.slice(0, 8) ?? '-'} phase=${phase} calls=${raw?.usage?.calls ?? 0} cost=${cost === null ? '?' : money(cost)}`);
    const overCap = others === null || cost === null || others + cost > cap;
    if (!stopped && alive(pid) && (overCap || Date.now() > deadline)) {
      console.log(`STOP reason=${overCap ? 'cap' : 'time'} sending SIGINT to ${pid}`);
      try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ }
      stopped = true;
    }
    if (!alive(pid)) { console.log('process ended'); return; }
    if (raw && !RUNNING.has(phase) && phase !== 'pending') {
      // Give the CLI a moment to write its output after the phase settles.
      await new Promise(done => setTimeout(done, 5000));
      if (!alive(pid)) { console.log('process ended'); return; }
    }
    await new Promise(done => setTimeout(done, 60_000));
  }
}

/** Plan 01-12: the counted card with the fewest recorded events (lower id on a tie). Prints the full id. */
async function pickCounted() {
  const { ExperimentStore } = await load('store.js');
  const { cardVerdict } = await load('comparison.js');
  const run = await new ExperimentStore(values.data).get(need('id'));
  const exclude = need('exclude');
  const controls = new Set(run.positiveControlScenarioIds ?? []);
  const candidates = run.scenarios
    .filter(scenario => scenario.id !== exclude && !controls.has(scenario.id))
    .filter(scenario => ['pass', 'fail'].includes(cardVerdict(run, scenario).outcome))
    .map(scenario => ({ id: scenario.id, events: run.trials.filter(trial => trial.scenarioId === scenario.id)
      .reduce((n, trial) => n + (trial.events?.length ?? 0), 0) }))
    .sort((a, b) => a.events - b.events || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!candidates.length) { process.stderr.write('No counted card\n'); process.exit(3); }
  process.stderr.write(`events=${candidates[0].events} candidates=${candidates.length}\n`);
  console.log(candidates[0].id);
}

/** Plan 01-12: the control entries and the summary block lines the CLI prints (fixed vocabulary only). */
async function control() {
  const { ExperimentStore } = await load('store.js');
  const { resolveSource } = await load('artifacts.js');
  const { buildResultView, resultViewLines } = await load('result-view.js');
  const { metricApplies } = await load('contracts.js');
  const store = new ExperimentStore(values.data);
  const record = await store.get(need('id'));
  const baseId = record.assessmentOf ?? record.parentRunId;
  const before = baseId ? (await resolveSource(record, store, baseId)).before : undefined;
  const view = buildResultView(record, before ? { before } : {});
  const lines = resultViewLines(view);
  const controlIds = new Set(record.positiveControlScenarioIds ?? []);
  const entries = view.control.cards.map(card => {
    const scenario = record.scenarios.find(item => item.id === card.scenarioId);
    const trials = record.trials.filter(trial => trial.scenarioId === card.scenarioId);
    const fidelity = scenario?.metrics?.find(metric => metric.id === 'user_fidelity');
    return {
      id8: card.scenarioId.slice(0, 8), outcome: card.outcome, reason: card.reason ?? null, synthetic: card.synthetic,
      provenance: scenario?.provenance ?? null, maxFollowUps: scenario?.user?.maxFollowUps ?? null, trials: trials.length,
      simulatorEvents: trials.reduce((n, trial) => n + trial.events.filter(event => event.type === 'simulator').length, 0),
      assistantReplies: trials.reduce((n, trial) => n + trial.events.filter(event => event.type === 'assistant').length, 0),
      userFidelityApplies: trials.length > 0 && Boolean(fidelity) && trials.some(trial => metricApplies(fidelity, trial)),
    };
  });
  const out = {
    id8: record.id.slice(0, 8), phase: record.phase, parent8: record.parentRunId?.slice(0, 8) ?? null,
    cards: record.scenarios.length, controlIds: controlIds.size,
    headline: { passed: view.headline.passed, decided: view.headline.decided },
    notMeasured: view.notMeasured.total, warning: view.control.warning !== null,
    controlLine: lines.find(line => line.startsWith('Контроль:')) ?? null,
    stabilityLine: lines.find(line => line.startsWith('Нестабильных:') || line.startsWith('Стабильность не проверена:')) ?? null,
    control: entries,
  };
  console.log(JSON.stringify(out));
  if (!entries.length) process.exit(2);
  process.exit(entries.every(entry => entry.outcome === 'pass') && !out.warning ? 0 : 1);
}

const commands = { budget, spent, record, 'build-plan': buildPlan, 'build-status': buildStatus, watch, 'pick-counted': pickCounted, control };
if (!commands[command]) {
  process.stderr.write('Usage: live-check.mjs budget|spent|record|build-plan|build-status|watch|pick-counted|control …\n');
  process.exit(2);
}
await commands[command]();
