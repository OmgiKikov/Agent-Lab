import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Experiment, Scenario } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { evidenceBundle } from '../src/artifacts.js';
import { assessRepeated } from '../src/judge.js';
import { judgeCheckPlan, judgeCheckSummary, type JudgeCheck } from '../src/judge-check.js';
import { plantedErrorSchema } from '../src/judge-check-task.js';
import { markdownReport, htmlReport } from '../src/report.js';
import { buildResultView } from '../src/result-view.js';
import { headRows } from '../src/result-text.js';
import type { Runtime } from '../src/runtime.js';
import { ExperimentStore } from '../src/store.js';
import { cardAttempt, cardRun, compiledCard } from './helpers/cards.js';

/*
 * W6b: the judge is checked without a person. The builder plants one error into a copy of a dialogue the judge
 * passed; the run's own judge reads the copy again. A copy that now fails is a caught error; an untouched control
 * that now fails is a false alarm. The run never changes; the check is a sidecar. Scripted models, invented data.
 */

const PLANTED_MARK = 'ПОДБРОШЕНО';

/** A finished card run: three attempts of one compiled card, every duty passed on the agent's one reply. */
function finishedRun(): Experiment {
  const scenario: Scenario = compiledCard();
  const trials = [1, 2, 3].map(n => cardAttempt(`attempt_${n}`, scenario, { e1: 'pass', e2: 'pass', e3: 'pass' }, n - 1));
  return cardRun([scenario], trials, 3, { createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z' });
}

type Vote = 'pass' | 'fail';
/**
 * The run's judge over scripted votes (the real two-vote protocol of judge.ts), and a builder that marks the reply it
 * rewrites. `decide` reads the reply the judge sees; `calls` counts every request that passed the budget gate.
 */
function scriptedRuntime(decide: (reply: string, trialIndex: number) => Vote, calls = { judge: 0, builder: 0 }): Runtime {
  return {
    generatorTransport: 'deterministic-test',
    assess: (input, ctx) => assessRepeated(input, { provider: 'fixture', id: 'judge' }, ctx, async (_prompt, data) => {
      ctx.beforeCall(); calls.judge++;
      const parsed = JSON.parse(data) as { scenario: { metrics: { id: string }[] }; trial: { events: { seq: number; type: string; content: string }[] } };
      const reply = parsed.trial.events.filter(event => event.type === 'assistant').at(-1)!;
      const vote = decide(reply.content, Number(input.trial.id.slice(-1)));
      return JSON.stringify({ assessments: [{ metricId: parsed.scenario.metrics[0]!.id, passCondition: vote === 'pass' ? 'met' : 'not_met', failCondition: vote === 'pass' ? 'not_met' : 'met',
        rationale: `Сценарный голос: ${vote}.`, evidence: [reply.seq], citations: [{ seq: reply.seq, quote: reply.content }] }] });
    }),
    plantError: { builder: { provider: 'fixture', id: 'builder' }, async plant(request, ctx) {
      ctx.beforeCall(); calls.builder++;
      return plantedErrorSchema(request).parse({ replyIndex: 0, newReply: `${PLANTED_MARK}: номер терминала назовите ещё раз.`, whatWasBroken: 'агент повторно просит номер терминала' });
    } },
  };
}

async function labWith(t: TestContext, runtime: Runtime, record = finishedRun()): Promise<{ lab: ExperimentLab; directory: string; record: Experiment }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-judge-check-'));
  const lab = new ExperimentLab(directory, runtime);
  await lab.init();
  await lab.store.save(record);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  return { lab, directory, record };
}

test('a planted error the judge fails is caught; the original trial and the run never change', async t => {
  const calls = { judge: 0, builder: 0 };
  const { lab, directory, record } = await labWith(t, scriptedRuntime(reply => reply.includes(PLANTED_MARK) ? 'fail' : 'pass', calls));
  const before = JSON.stringify(await lab.store.get(record.id));
  const plan = await lab.planJudgeCheck(record.id, { planted: 4, controls: 3 });
  assert.equal(plan.planted.length, 4); assert.equal(plan.controls.length, 3);
  assert.equal(plan.calls, 4 * (1 + 2) + 3 * 2, 'planted × (builder + two votes) + controls × two votes');
  const check = await lab.checkJudge(record.id, { planted: 4, controls: 3 });
  assert.deepEqual([check.planted, check.detected, check.controls, check.falseAlarms], [4, 4, 3, 0]);
  assert.equal(check.usage.calls, plan.calls, 'the check spends exactly its ceiling');
  assert.deepEqual(calls, { judge: 14, builder: 4 });
  assert.equal(check.judgeModel, 'fixture/judge'); assert.equal(check.builderModel, 'fixture/builder');
  const planted = check.items.filter(item => item.kind === 'planted');
  assert.ok(planted.every(item => item.result === 'fail' && item.replySeq === 1 && item.whatWasBroken === 'агент повторно просит номер терминала' && item.receipt?.complete));
  assert.equal(JSON.stringify(await lab.store.get(record.id)), before, 'the run record is untouched');
  assert.deepEqual(await lab.store.readJudgeCheck(record.id), check);
  const mode = (await stat(join(directory, `${record.id}.judge-check.json`))).mode & 0o777;
  assert.equal(mode, 0o600, 'the sidecar is private');
  assert.equal((await readdir(join(directory, `${record.id}.judge-check`))).length, 7, 'every copy keeps its full audit');
  assert.ok(!(await readdir(directory)).some(name => name === `${record.id}.judge`), 'no audit of the run itself is written');
  assert.equal((await lab.list()).length, 1, 'the sidecar is not read as a record');
});

test('a judge that passes planted errors is not trusted; a judge that fails controls raises false alarms', async t => {
  const blind = await labWith(t, scriptedRuntime(() => 'pass'));
  const missed = await blind.lab.checkJudge(blind.record.id, { planted: 3, controls: 2 });
  assert.deepEqual([missed.planted, missed.detected, missed.falseAlarms], [3, 0, 0]);
  const summary = judgeCheckSummary(missed, blind.record)!;
  assert.equal(summary.distrust, 'misses');
  const view = buildResultView(blind.record, { judgeCheck: missed });
  const row = headRows(view).find(item => item.text.startsWith('Судья поймал'))!;
  assert.equal(row.text, 'Судья поймал 0 из 3 подброшенных ошибок, ложных тревог 0 из 2 — судье нельзя доверять: пропускает подброшенные ошибки');
  assert.equal(row.role, 'alarm');

  const harsh = await labWith(t, scriptedRuntime(() => 'fail'));
  const alarmed = await harsh.lab.checkJudge(harsh.record.id, { planted: 2, controls: 3 });
  assert.deepEqual([alarmed.detected, alarmed.controls, alarmed.falseAlarms], [2, 3, 3]);
  assert.equal(judgeCheckSummary(alarmed, harsh.record)!.distrust, 'false_alarms');
});

test('the trust line reads the same in the summary view and the report; old runs without a check show nothing', async t => {
  const { lab, record } = await labWith(t, scriptedRuntime(reply => reply.includes(PLANTED_MARK) ? 'fail' : 'pass'));
  const plain = await evidenceBundle(await lab.get(record.id), lab.store);
  assert.equal(plain.view.judgeCheck, undefined, 'a run never checked has no judge check');
  assert.ok(!markdownReport(plain).includes('Судья поймал'));
  await lab.checkJudge(record.id, { planted: 3, controls: 3 });
  const bundle = await evidenceBundle(await lab.get(record.id), lab.store);
  const line = 'Судья поймал 3 из 3 подброшенных ошибок, ложных тревог 0 из 3';
  assert.equal(headRows(bundle.view).find(row => row.text.startsWith('Судья'))?.role, 'calibration');
  assert.ok(headRows(bundle.view).some(row => row.text === line));
  assert.ok(markdownReport(bundle).includes(line));
  assert.ok(htmlReport(bundle).includes(line));
  assert.ok(markdownReport(bundle).includes('Судью проверили без человека'));
  // A check of another run is never shown on this one.
  const other = { ...(await lab.store.readJudgeCheck(record.id))!, runId: 'other_run' } satisfies JudgeCheck;
  assert.equal(buildResultView(record, { judgeCheck: other }).judgeCheck, undefined);
});

test('the sample is fixed by the run: the same run gives the same verdicts, and a run with nothing passed is refused', () => {
  const record = finishedRun();
  const first = judgeCheckPlan(record, { planted: 5, controls: 5 });
  const again = judgeCheckPlan(structuredClone(record), { planted: 5, controls: 5 });
  const ids = (plan: typeof first) => plan.planted.map(item => `${item.trial.id}/${item.expectationId}`);
  assert.deepEqual(ids(first), ids(again));
  assert.equal(new Set(ids(first)).size, 5);
  const failed = { ...record, trials: record.trials.map(trial => ({ ...trial, assessments: trial.assessments!.map(a => ({ ...a, result: 'fail' as const })) })) };
  assert.throws(() => judgeCheckPlan(failed), /подбросить ошибку некуда/);
  assert.throws(() => judgeCheckPlan({ ...record, phase: 'evaluating' }), /завершённом прогоне/);
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
async function agentLab(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { env: { ...process.env, AGENT_LAB_SESSION: '' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}

test('check-judge without --yes says the ceiling and spends nothing; summary shows the check once written', { timeout: 60000 }, async t => {
  const { lab, directory, record } = await labWith(t, scriptedRuntime(reply => reply.includes(PLANTED_MARK) ? 'fail' : 'pass'));
  const shown = await agentLab(['check-judge', '--id', record.id, '--planted', '2', '--controls', '1', '--data-dir', directory]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.includes('Не больше 8 вызовов модели'), shown.stdout);
  assert.equal(await new ExperimentStore(directory).readJudgeCheck(record.id), null, 'nothing is written without --yes');
  await lab.checkJudge(record.id, { planted: 2, controls: 1 });
  const summary = await agentLab(['summary', '--id', record.id, '--data-dir', directory]);
  assert.equal(summary.code, 0, summary.stderr);
  assert.ok(summary.stdout.includes('Судья поймал 2 из 2 подброшенных ошибок, ложных тревог 0 из 1'), summary.stdout);
});
