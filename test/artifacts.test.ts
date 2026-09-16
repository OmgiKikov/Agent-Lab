import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { demoEvaluationInput, demoInput } from '../src/demo.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { htmlReport, jsonReport, markdownReport } from '../src/report.js';
import { sealJudgeReceipt } from '../src/judge.js';
import type { Experiment, JudgeAudit } from '../src/contracts.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-artifacts-'));
  const lab = new ExperimentLab(directory); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  return { lab, directory };
}
async function twoRuns(t: TestContext) {
  const { lab, directory } = await setup(t);
  const input = demoEvaluationInput(); input.scenarioCount = 1; input.targetVersion = 'before-v1';
  const created = await lab.create(input); await lab.waitForIdle();
  const ready = await lab.get(created.id);
  await lab.start(ready.id, { approved: true, reviewer: 'human', expectedHash: draftHash(ready) }); await lab.waitForIdle();
  const before = await lab.get(ready.id);
  assert.equal(before.trials[0]?.outcome, 'fail');
  const repeated = await lab.repeat(before.id);
  const edited = await lab.updateDraft(repeated.id, draftHash(repeated), {
    agent: { ...repeated.revisions[0]!.spec, tools: [...repeated.revisions[0]!.spec.tools, 'update_record'] }, targetVersion: 'after-v2',
  });
  await lab.start(edited.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) }); await lab.waitForIdle();
  const after = await lab.get(edited.id);
  assert.equal(after.trials[0]?.outcome, 'pass');
  return { lab, directory, before, after };
}

test('navigation-independent snapshots export matching comparisons and paired evidence in every format', async t => {
  const { lab, directory, before, after } = await twoRuns(t);
  const reopened = await evidenceBundle(after, lab.store);
  const visited = await evidenceBundle(after, lab.store, before.id);
  assert.deepEqual(visited, reopened);
  assert.equal(reopened.comparisonSource?.kind, 'parent');
  assert.equal(reopened.comparison?.fixed.length, 1);
  assert.deepEqual(reopened.comparison?.pairs.map(p => [p.beforeTrialId, p.afterTrialId]), [[before.trials[0]!.id, after.trials[0]!.id]]);
  const a = await exportArtifacts(reopened, directory);
  const b = await exportArtifacts(visited, directory);
  for (const name of ['report', 'htmlReport', 'snapshot'] as const) {
    assert.equal(await readFile(a[name], 'utf8'), await readFile(b[name], 'utf8'));
    assert.equal((await stat(a[name])).mode & 0o777, 0o600);
  }
  const snapshot = JSON.parse(await readFile(a.snapshot, 'utf8'));
  assert.deepEqual(snapshot.comparison, reopened.comparison);
  assert.deepEqual(snapshot.before, before);
  assert.equal(JSON.parse(await readFile(a.evidence, 'utf8')).id, after.id, 'canonical evidence remains a raw Experiment');
  // The journal stays next to the record; the export only names it.
  assert.deepEqual(Object.keys(snapshot.traceJournal).sort(), ['bytes', 'file']);
  assert.equal(snapshot.traceJournal.file, `${after.id}.trace.jsonl`);
  assert.equal(typeof snapshot.traceJournal.bytes, 'number');
  assert.equal(snapshot.traceJournal.bytes, Buffer.byteLength(reopened.traceJournal));
  const firstJournalLine = reopened.traceJournal.split('\n').find(Boolean);
  assert.ok(firstJournalLine, 'the fixture run wrote a journal');
  assert.equal((await readFile(a.snapshot, 'utf8')).includes(firstJournalLine), false);
  const html = await readFile(a.htmlReport, 'utf8');
  const markdown = await readFile(a.report, 'utf8');
  for (const text of [html, markdown]) {
    assert.match(text, /before-v1/); assert.match(text, /after-v2/);
    assert.match(text, /cannot update/); assert.match(text, /has been moved/);
    assert.match(text, new RegExp(before.trials[0]!.id)); assert.match(text, new RegExp(after.trials[0]!.id));
  }
  const anchors = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, anchors.size, 'HTML anchors must be unique');
  for (const href of html.matchAll(/href="#([^"]+)"/g)) assert.ok(anchors.has(href[1]), `missing target: ${href[1]}`);
  const different = { ...before, id: 'manually-selected-baseline' }; await lab.store.save(different);
  const explicit = await evidenceBundle(after, lab.store, different.id);
  assert.equal(explicit.comparisonSource?.kind, 'selected');
  assert.match(htmlReport(explicit), /База выбрана вручную/);
  const incomplete = await evidenceBundle({ ...after, trials: [] }, lab.store);
  for (const report of [htmlReport(incomplete), markdownReport(incomplete)]) {
    assert.match(report, /Несравнимо/); assert.match(report, /Нет попытки.*после/);
  }
});

test('missing parents and journals remain explicit without losing current evidence', async t => {
  const { lab, before, after } = await twoRuns(t);
  const record = { ...after, parentRunId: 'missing-parent' };
  const bundle = await evidenceBundle(record, {
    get: id => lab.store.get(id),
    traceJournal: async () => { throw new Error('fixture journal unavailable'); },
  });
  assert.equal(bundle.before, undefined); assert.equal(bundle.comparison, undefined);
  assert.equal(bundle.warnings.length, 2);
  assert.equal(bundle.record.trials[0]?.id, after.trials[0]?.id);
  for (const content of [htmlReport(bundle), markdownReport(bundle), jsonReport(bundle)]) {
    assert.match(content, /missing-parent/); assert.match(content, /fixture journal unavailable/);
    assert.match(content, /has been moved/);
  }
  const legacy = { ...after, parentRunId: 'legacy-source', sourceEvidence: {
    runId: 'legacy-source', trials: [structuredClone(before.trials[0]!)], humanReviews: [],
  } };
  const recovered = await evidenceBundle(legacy, lab.store);
  assert.equal(recovered.comparisonSource?.kind, 'embedded');
  assert.equal(recovered.view?.stability?.skipped, 'исходный прогон недоступен', 'a legacy suite has no source identity for stability');
  // A source that exists but cannot be read is reported, not replaced by the embedded copy.
  const unreadable = await evidenceBundle(legacy, { get: async () => { throw new Error('Experiment record exceeds 50 MB'); }, traceJournal: async () => '' });
  assert.equal(unreadable.before, undefined);
  assert.equal(unreadable.comparisonSource?.kind, 'parent');
  assert.match(unreadable.warnings[0] ?? '', /не удалось прочитать.*встроенная копия не подставлялась.*50 MB/);
  assert.equal(recovered.comparison?.fixed.length, 1, 'legacy one-trial suite evidence remains readable');
});

test('a saved suite carries every attempt and compares from embedded evidence in a fresh data directory', async t => {
  const { lab, directory } = await setup(t);
  const input = demoEvaluationInput(); input.scenarioCount = 1;
  input.settings = { ...input.settings, repeats: 2, userModes: ['static'] };
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  assert.deepEqual(before.trials.map(trial => trial.outcome), ['fail', 'fail']);
  const suite = await lab.saveSuite(before.id, join(directory, 'portable-suite.json'));

  const portableDirectory = await mkdtemp(join(tmpdir(), 'agent-lab-portable-'));
  const portable = new ExperimentLab(portableDirectory); await portable.init();
  t.after(async () => { await portable.close(); await rm(portableDirectory, { recursive: true, force: true }); });
  const loaded = await portable.loadSuite(suite);
  assert.equal(loaded.sourceEvidence?.trials.length, 2);
  const changed = await portable.updateDraft(loaded.id, draftHash(loaded), {
    agent: { ...loaded.revisions[0]!.spec, tools: [...loaded.revisions[0]!.spec.tools, 'update_record'] },
  });
  await portable.start(changed.id, { approved: true, reviewer: 'human', expectedHash: draftHash(changed) }); await portable.waitForIdle();
  const after = await portable.get(changed.id);
  const bundle = await evidenceBundle(after, portable.store);
  assert.equal(bundle.comparisonSource?.kind, 'embedded');
  assert.equal(bundle.before?.id, before.id);
  assert.equal(bundle.comparison?.fixed.length, 1);
  assert.ok(loaded.sourceEvidence?.identity, 'a new suite embeds the source run identity');
  assert.equal(bundle.view?.stability?.skipped, 'агент изменился между прогонами', 'a fix of the agent is not called instability');
  assert.equal(bundle.comparison?.regressed.length, 0);
  assert.equal(bundle.comparison?.pairs.length, 2);
  assert.match(bundle.warnings.join('\n'), /парный diff, не статистическая оценка/);
});

test('HTML is self-contained, escapes evidence, exposes event anchors and labels whole-dialogue verdicts precisely', async t => {
  const { lab, after } = await twoRuns(t);
  const bundle = await evidenceBundle(after, lab.store);
  bundle.record.task = '<script>alert("x")</script>\n' + 'Long task '.repeat(80);
  bundle.record.trials[0]!.events[0]!.text = '<img src=x onerror=alert(1)>\u001b[31m';
  const html = htmlReport(bundle);
  assert.match(html, /&lt;script&gt;alert/); assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /<iframe|<img|<link|<form|\u001b\[/i);
  assert.match(html, /default-src 'none'/); assert.match(html, /summary:|:focus-visible/);
  assert.match(html, /Исходная задача и подключение/);
  assert.match(html, /Разобрано человеком/); assert.match(html, /Человек: вердикта нет/);
  assert.doesNotMatch(html, /Человек: не разбирал/);
  const h1 = html.match(/<h1>(.*?)<\/h1>/)?.[1] ?? '';
  assert.ok(h1.length < 180, h1);
  assert.match(html, /Long task/);
});

test('unmeasured code checks and simulator criticism cannot masquerade as absent checks or an agent failure', async t => {
  const { after } = await twoRuns(t);
  const invalid = { ...after, trials: after.trials.map(trial => ({ ...trial, outcome: 'invalid' as const, reason: 'fixture unavailable', checks: [], assessments: [] })) };
  assert.match(htmlReport(invalid), /Проверки заданы, измерений нет/);
  assert.doesNotMatch(htmlReport(invalid), /Кодовых проверок не задано/);
  const rubric = { ...after, scenarios: after.scenarios.map(s => ({ ...s, checks: [] })), trials: after.trials.map(trial => ({ ...trial, outcome: 'ungraded' as const, checks: [], assessments: [
    { metricId: 'demo_follow_ups', result: 'fail' as const, rationale: 'SIMULATOR_CRITICISM', evidence: [0] },
    { metricId: 'demo_task_state', result: 'fail' as const, rationale: 'AGENT_FAILURE', evidence: [0] },
  ] })) };
  const html = htmlReport(rubric);
  const attention = html.match(/<section id="attention">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(attention, /AGENT_FAILURE/); assert.doesNotMatch(attention, /SIMULATOR_CRITICISM/);
});

test('legacy reports lead with selected control evidence and retain explicit revision and split labels', async t => {
  const { lab } = await setup(t);
  const created = await lab.create(demoInput()); await lab.waitForIdle();
  await lab.start(created.id, { approved: true, reviewer: 'automated' }); await lab.waitForIdle();
  const record = await lab.get(created.id);
  assert.equal(record.phase, 'complete', record.error ?? '');
  const bundle = await evidenceBundle(record, lab.store);
  assert.equal(bundle.evidence.verdict.passed, 8); assert.equal(bundle.evidence.verdict.graded, 8);
  const html = htmlReport(bundle);
  assert.match(html, /Итог по контрольным карточкам выбранной версии/);
  assert.match(html, /Исходная версия: 4\/8 → выбранная версия: 8\/8/);
  assert.match(html, /Исходная версия/); assert.match(html, /Выбранная версия/); assert.match(html, /Карточки разработки/);
  assert.doesNotMatch(html, /Пройдено 24 из 40/);
});

test('a human failure on a green dialogue reaches every export and keeps original results', async t => {
  const { lab, after } = await twoRuns(t);
  const trial = after.trials[0]!;
  const measured = JSON.stringify(trial);
  const reviewed = await lab.addHumanReview(after.id, { trialId: trial.id, verdict: 'fail', note: 'QA: missed requirement <script>not executable</script>' });
  const bundle = await evidenceBundle(reviewed, lab.store);
  assert.equal(bundle.evidence.verdict.review.disagreements, 1);
  assert.equal(JSON.stringify(reviewed.trials[0]), measured);
  const html = htmlReport(bundle);
  assert.match(html, /Человек отметил проблемы: 1/);
  assert.match(html, /Расхождение оценок/);
  assert.match(html, /missed requirement &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>not executable/);
  assert.match(html, new RegExp(`href="#trial-${after.id}-${trial.id}"`));
  assert.match(markdownReport(bundle), /Расхождение оценок/);
  assert.match(jsonReport(bundle), /inspect_human_findings/);
});

test('every export preserves simulator-check evidence without research scorecards', async t => {
  const { lab, after } = await twoRuns(t);
  const trial = after.trials[0]!;
  assert.equal(trial.userMode, 'reactive');
  const seq = trial.events.length;
  trial.events = [...trial.events, { seq, type: 'simulator', result: { message: 'again', done: false } }, { seq: seq + 1, type: 'user', text: 'again' }, { seq: seq + 2, type: 'assistant', text: 'ok' }];
  trial.simulatorChecks = [{ id: 'simulator_loop', description: 'Повтор пары ответ агента → реплика пользователя (эвристика)', passed: false, evidence: `Подозрение: реплика #${seq + 1} повторяет реплику #0 <script>`, seq: seq + 1, heuristic: true }];
  const bundle = await evidenceBundle(after, lab.store);
  const html = htmlReport(bundle);
  assert.match(html, /Проверки симулятора · эвристики/);
  assert.match(html, new RegExp(`Подозрение: реплика #${seq + 1} повторяет реплику #0 &lt;script&gt;`)); assert.doesNotMatch(html, /#0 <script>/);
  assert.doesNotMatch(html, /<section id="simulator">|<h2>Ценность режимов<\/h2>/);
  // The suspicion parks the dialogue in "needs a verdict" instead of letting a green code result stand unchallenged.
  const attention = html.match(/<section id="attention">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(attention, /Нужен вердикт/);
  const markdown = markdownReport(bundle);
  assert.match(markdown, /Симулятор · эвристика · simulator\\_loop/);
  assert.doesNotMatch(markdown, /## Симулятор|## Ценность режимов/);
  const json = JSON.parse(jsonReport(bundle));
  assert.equal(json.experiment.trials[0].simulatorChecks[0].id, 'simulator_loop');
  assert.equal(json.evidence.simulator, undefined);
  assert.equal(json.evidence.modeValue, undefined);
});

test('a receipt-only trial names its judge and sidecar file without embedding any audit', async t => {
  const { lab, after } = await twoRuns(t);
  const audit: JudgeAudit = { protocolHash: 'protocol-<v1>', inputHash: 'input', provider: 'openrouter', model: 'judge-<model>', prompt: 'p', input: '{}',
    attempts: [0, 1, 2].map(() => ({ startedAt: 'now', raw: 'RAW_JUDGE_REPLY', assessments: [{ metricId: 'demo_task_state', result: 'pass' as const, rationale: 'r', evidence: [0] }] })), notApplicable: [] };
  const trial = after.trials[0]!;
  delete trial.judgeAudit;
  trial.judgeReceipt = sealJudgeReceipt(audit, true);
  const legacy = structuredClone(trial);
  delete legacy.judgeReceipt;
  legacy.judgeAudit = audit;
  after.sourceEvidence = { runId: 'legacy-source', trials: [legacy], humanReviews: [] };
  const bundle = await evidenceBundle(after, lab.store);
  const html = htmlReport(bundle);
  assert.match(html, new RegExp(`${after.id}\\.judge/${trial.id}\\.json`));
  assert.match(html, /openrouter\/judge-&lt;model&gt;/);
  assert.match(html, /protocol-&lt;v1&gt;/);
  assert.match(html, /3 вызовов в свежих сессиях/);
  assert.doesNotMatch(html, /&quot;attempts&quot;|"attempts"/);
  assert.doesNotMatch(html, /RAW_JUDGE_REPLY/, 'the embedded source run carries no serialized audit');
  assert.doesNotMatch(html, /judge-<model>/);
  const markdown = markdownReport(bundle);
  assert.match(markdown, /Судья: openrouter\/judge-&lt;model&gt;, 3 вызовов в свежих сессиях/);
  assert.match(markdown, /\.judge\/.*\.json/);
  assert.doesNotMatch(markdown, /RAW_JUDGE_REPLY/);

  // A legacy trial keeps its audit in the record, but the reports still only name it.
  const old = structuredClone(after);
  old.trials[0] = structuredClone(legacy);
  const oldBundle = await evidenceBundle(old, lab.store);
  const oldHtml = htmlReport(oldBundle);
  assert.match(oldHtml, /3 вызовов в свежих сессиях/);
  assert.doesNotMatch(oldHtml, /RAW_JUDGE_REPLY/);
  assert.match(markdownReport(oldBundle), /Судья: openrouter\/judge-&lt;model&gt;, 3 вызовов.*в экспорт они не входят/);
  assert.doesNotMatch(oldHtml, /полные данные и сравнение доступны в JSON-снимке/);
  // No exported report embeds a full audit, legacy records included.
  const oldJson = jsonReport(oldBundle);
  assert.doesNotMatch(oldJson, /RAW_JUDGE_REPLY|"judgeAudit"/);
  assert.equal(JSON.parse(oldJson).judgeAudits.omittedLegacyAudits, 2);
  assert.match(JSON.parse(oldJson).judgeAudits.location, /\.judge\//);
});

test('receipts are checked against their sidecar files before a comparison trusts them', async t => {
  const { lab, before, after } = await twoRuns(t);
  const receiptRun = (run: Experiment) => {
    const copy = structuredClone(run);
    for (const trial of copy.trials) {
      const audit: JudgeAudit = { protocolHash: 'p', inputHash: 'i', provider: 'offline', model: 'judge', prompt: 'p', input: '{}',
        attempts: [{ startedAt: 'now', raw: `raw ${trial.id}` }], notApplicable: [] };
      delete trial.judgeAudit;
      trial.judgeReceipt = sealJudgeReceipt(audit, true);
      lab.store.writeJudgeAudit(copy.id, trial.id, audit);
    }
    return copy;
  };
  const current = receiptRun(after);
  const clean = await evidenceBundle(current, lab.store);
  assert.ok(clean.warnings.every(warning => !/квитанция|полной оценки/.test(warning)), JSON.stringify(clean.warnings));
  assert.ok(clean.record.trials.every(trial => trial.judgeReceipt?.complete));
  // An edited sidecar no longer matches its sealed hash.
  const tampered = current.trials[0]!;
  lab.store.writeJudgeAudit(current.id, tampered.id, { protocolHash: 'p', inputHash: 'i', provider: 'offline', model: 'judge', prompt: 'p', input: '{}',
    attempts: [{ startedAt: 'now', raw: 'edited' }], notApplicable: [] });
  const edited = await evidenceBundle(current, lab.store);
  assert.equal(edited.record.trials[0]!.judgeReceipt?.complete, false);
  assert.equal(current.trials[0]!.judgeReceipt?.complete, true, 'the stored record is never changed');
  assert.ok(edited.warnings.some(warning => warning.includes('не совпала') && warning.includes(tampered.id)), JSON.stringify(edited.warnings));
  // A missing sidecar keeps the record-only check and says so.
  const orphan = structuredClone(current);
  orphan.id = 'receipt-without-sidecar';
  delete orphan.parentRunId;
  const missing = await evidenceBundle(orphan, lab.store);
  assert.ok(missing.record.trials.every(trial => trial.judgeReceipt?.complete));
  assert.ok(missing.warnings.some(warning => warning.includes('не найден') && warning.includes('только по самой записи')), JSON.stringify(missing.warnings));
  assert.equal(before.id, current.parentRunId);
});
