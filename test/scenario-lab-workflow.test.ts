import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/* The shipped teaching example (examples/scenario-lab-demo.mjs) and its deterministic agent, judge and runtime. */

test('reproducible demo prepares situations, records the owner\'s answer, runs the accepted ones and repeats them on a fixed agent version', async () => {
  const demo = await import('../examples/scenario-lab-demo.mjs').catch(() => assert.fail('A reproducible isolated scenario-lab demo is required'));
  const directory = await mkdtemp(join(tmpdir(), 'scenario-workflow-'));
  try {
    const report = await demo.verifyScenarioLab(directory);
    assert.equal(report.evidenceKind, 'deterministic-integration');
    assert.deepEqual(report.library, { dialogues: 2, situations: 2 });
    assert.equal(report.ownerReceipt, true); assert.equal(report.sourceUnchanged, true);
    assert.deepEqual(report.baseline, { passed: 1, decided: 2 }, 'the deliberately broken agent asks again for a number it was already given');
    assert.deepEqual(report.fixed, { passed: 2, decided: 2 });
    assert.equal(report.persistedLinksResolve, true);
    const candidate = JSON.parse(await readFile(join(directory, '.agent-lab', `${report.repeatRunId}.json`), 'utf8'));
    const lateCard = candidate.librarySnapshot.cards.find((card: any) => card.origin.dialogueId === 'late');
    const late = candidate.trials.filter((t: any) => t.scenarioId === lateCard.id);
    assert.equal(late.length, 2);
    for (const trial of late) {
      assert.deepEqual(trial.events.filter((e: any) => e.type === 'user').map((e: any) => e.text), ['Помогите с возвратом.', 'Номер терминала: 5678']);
      assert.ok(trial.events.some((e: any) => e.type === 'assistant' && e.text.includes('Подайте заявление')));
      assert.equal(trial.checkpoints, undefined, 'each expectation of the card is judged on its own');
      assert.equal(trial.assessments.find((a: any) => a.metricId === 'e2')?.result, 'pass');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('checkpoint proof labels explain decisions in Russian while preserving checkpoint identifiers', async () => {
  const { trialProofLines } = await import('../src/quality.js');
  const { demoEvaluateRecord } = await import('./helpers/demo-record.js');
  const fixture = await demoEvaluateRecord('scenario-proof-labels-');
  try {
    const trial = fixture.record.trials[0]!;
    trial.checkpoints = ['pass', 'fail', 'unknown', 'not_applicable'].map((result, i) => ({ checkpointId: `cp_${i}`, requirementId: 'rule', observation: 'reply', role: 'required', result, evidence: [1], rationale: 'Учебное решение' })) as any;
    const text = trialProofLines(fixture.record, trial.id).lines.join('\n');
    for (const label of ['ВЫПОЛНЕНО [cp_0]', 'НАРУШЕНО [cp_1]', 'НЕ ОПРЕДЕЛЕНО [cp_2]', 'НЕ ПРИМЕНИМО [cp_3]']) assert.ok(text.includes(label));
  } finally { await fixture.lab.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test('demo direct invocation through a symlink path prints an isolated review draft and launch command', async () => {
  const { symlink } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { resolve } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'scenario-launch-'));
  let seeded: string | undefined;
  try {
    await symlink(resolve('examples'), join(directory, 'examples'), 'dir');
    const result = await promisify(execFile)(process.execPath, [join(directory, 'examples/scenario-lab-demo.mjs')]);
    assert.match(result.stdout, /developer-authored-synthetic-fixture/);
    const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf('\ncd ')));
    seeded = report.directory; assert.equal(report.ready, 1); assert.equal(report.needsOwner, 1); assert.equal(report.unusable, 0);
    assert.match(result.stdout, /--no-extensions.*--skill/);
  } finally { if (seeded) await rm(seeded, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
});


test('the teaching judge fails a repeated question in other words and a missing refund instruction', async () => {
  const { demoScenarioRuntime } = await import('../examples/scenario-lab-demo.mjs');
  const runtime = demoScenarioRuntime();
  const assess = async (id: string, replies: string[]) => {
    const events = [{ seq: 0, type: 'user', text: 'Номер терминала: 1234. Помогите с возвратом.' }, ...replies.map((text, i) => ({ seq: i + 1, type: 'assistant', text }))];
    return (await runtime.assess({ scenario: { metrics: [{ id }] }, sources: [], trial: { events } }))[0].result;
  };
  assert.equal(await assess('ask_once', ['Какой у вас номер терминала?']), 'fail');
  assert.equal(await assess('refund_explanation', ['Спасибо, номер записан.']), 'fail');
  assert.equal(await assess('refund_explanation', ['Возврат возможен. Подайте заявление в поддержку.']), 'pass');
});

test('teaching baseline explains refund after finite disclosure while retaining the initial-number defect', async () => {
  const { createSession } = await import('../examples/scenario-lab-target.mjs');
  const late = createSession({ initialState: { records: {} } });
  assert.match((await late.respond('Помогите с возвратом.')).reply, /Уточните/);
  assert.match((await late.respond('Номер терминала: 5678')).reply, /Подайте заявление/);
  const known = createSession({ initialState: { records: {} } });
  assert.match((await known.respond('Номер терминала: 1234. Помогите с возвратом.')).reply, /Уточните/);
});
