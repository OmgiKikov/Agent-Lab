import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { appointmentAgent, legacyDemoMetrics, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { htmlReport, jsonReport, markdownReport } from '../src/report.js';
import { FONT_STYLESHEET, REPORT_SCRIPT } from '../src/report-style.js';
import { buildResultView } from '../src/result-view.js';
import { sealJudgeReceipt } from '../src/judge.js';
import type { Experiment } from '../src/contracts.js';
import type { JudgeAudit } from '../src/assessment.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-artifacts-'));
  const lab = new ExperimentLab(directory, legacyDemoRuntime()); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  return { lab, directory };
}
/** One old-format card against the appointment agent without its update tool, then the same card after the fix. */
async function twoRuns(t: TestContext) {
  const { lab, directory } = await setup(t);
  const draft = await legacyDraft(lab, { count: 1 });
  const ready = await lab.updateDraft(draft.id, draftHash(draft), { targetVersion: 'before-v1' });
  await lab.start(ready.id, { approved: true, reviewer: 'human', expectedHash: draftHash(ready) }); await lab.waitForIdle();
  const before = await lab.get(ready.id);
  assert.equal(before.trials[0]?.outcome, 'fail');
  const repeated = await lab.repeat(before.id);
  const edited = await lab.updateDraft(repeated.id, draftHash(repeated), { target: appointmentAgent('createRepairedSession'), targetVersion: 'after-v2' });
  await lab.start(edited.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) }); await lab.waitForIdle();
  const after = await lab.get(edited.id);
  assert.equal(after.trials[0]?.outcome, 'pass');
  return { lab, directory, before, after };
}

test('navigation-independent snapshots export matching comparisons and the same result in every format', async t => {
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
    // Each export creates its own files (`wx`, 0600); the second never overwrites the first.
    assert.notEqual(a[name], b[name]);
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
  const snapshotText = await readFile(a.snapshot, 'utf8');
  assert.equal(snapshotText.includes(firstJournalLine), false);
  // Every format consumes the same bundle: the snapshot carries the very view the pages are built from.
  assert.deepEqual(snapshot.view, JSON.parse(JSON.stringify(reopened.view)));
  const html = await readFile(a.htmlReport, 'utf8');
  const markdown = await readFile(a.report, 'utf8');
  for (const text of [html, markdown]) {
    assert.match(text, /Точность агента/); assert.match(text, /after-v2/);
    assert.match(text, /Было → стало/); assert.match(text, /Исправлено: Move an appointment/);
    assert.match(text, /has been moved/);
    // Run ids, trial ids and hashes stay in the snapshot; the pages never print them.
    for (const id of [before.id, after.id, before.trials[0]!.id, after.trials[0]!.id, after.manifestHash ?? '-'].filter(id => id !== '-')) {
      assert.equal(text.includes(id), false, `the page prints ${id}`);
    }
  }
  assert.ok(snapshotText.includes(after.trials[0]!.id), 'the snapshot keeps the ids');
  const different = { ...before, id: 'manually-selected-baseline' }; await lab.store.save(different);
  const explicit = await evidenceBundle(after, lab.store, different.id);
  assert.equal(explicit.comparisonSource?.kind, 'selected');
  for (const report of [htmlReport(explicit), markdownReport(explicit)]) assert.match(report, /База выбрана вручную/);
  // Without attempts after, nothing is paired and the situation says why it has no verdict.
  const incomplete = await evidenceBundle({ ...after, trials: [] }, lab.store);
  for (const report of [htmlReport(incomplete), markdownReport(incomplete)]) {
    assert.match(report, /Нет совпадающих валидных попыток/);
    assert.match(report, /Move an appointment: прогон остановился раньше/);
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
  // The page says what is missing in words; the ids and the raw error stay in the snapshot, never on the page.
  for (const content of [htmlReport(bundle), markdownReport(bundle)]) {
    assert.match(content, /Исходный прогон не найден\. Сравнение не выполнено/); assert.match(content, /Журнал событий прогона недоступен/);
    assert.match(content, /has been moved/);
    assert.doesNotMatch(content, /missing-parent|fixture journal unavailable/);
  }
  assert.match(jsonReport(bundle), /missing-parent/);
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
  assert.match(unreadable.warnings[0] ?? '', /Исходный прогон не удалось прочитать: Файл повреждён или слишком большой\..*встроенная копия не подставлялась/);
  assert.equal(recovered.comparison?.fixed.length, 1, 'legacy one-trial suite evidence remains readable');
});

test('a saved suite carries every attempt and compares from embedded evidence in a fresh data directory', async t => {
  const { lab, directory } = await setup(t);
  const draft = await legacyDraft(lab, { count: 1, settings: { repeats: 2, userModes: ['static'] } });
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  assert.deepEqual(before.trials.map(trial => trial.outcome), ['fail', 'fail']);
  const suite = await lab.saveSuite(before.id, join(directory, 'portable-suite.json'));

  const portableDirectory = await mkdtemp(join(tmpdir(), 'agent-lab-portable-'));
  const portable = new ExperimentLab(portableDirectory, legacyDemoRuntime()); await portable.init();
  t.after(async () => { await portable.close(); await rm(portableDirectory, { recursive: true, force: true }); });
  const loaded = await portable.loadSuite(suite);
  assert.equal(loaded.sourceEvidence?.trials.length, 2);
  // The fix lives in the same adapter file, so its release label is what names the new version.
  const changed = await portable.updateDraft(loaded.id, draftHash(loaded), { target: appointmentAgent('createRepairedSession'), targetVersion: 'fixed-v2' });
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
  assert.match(bundle.warnings.join('\n'), /это сравнение по парам, не полная копия исходного прогона/);
});

test('HTML is self-contained and every record string is escaped in HTML and Markdown', async t => {
  const { before } = await twoRuns(t);
  const record = structuredClone(before);
  const scenario = record.scenarios[0]!;
  const trial = record.trials[0]!;
  const requirement = record.requirements.find(item => item.id === scenario.requirementIds[0])!;
  const source = record.sources.find(item => item.id === requirement.sourceId)!;
  assert.ok(source.content.includes(requirement.quote), 'the fixture rule is quoted verbatim from its source');
  // The rule stays verbatim in its source, so the failure still quotes it — now with markup in it.
  const quote = 'Before <svg onload=alert(2)> changing & "owner"';
  source.content = source.content.replace(requirement.quote, quote);
  requirement.quote = quote;
  source.name = 'Policy <object data=x>';
  scenario.title = '<script>alert("x")</script> [ссылка](javascript:alert(1))';
  record.targetVersion = `v<2>&"'`;
  trial.events.find(event => event.type === 'user')!.text = '<img src=x onerror=alert(1)>\u001b[31m';
  trial.events.find(event => event.type === 'assistant')!.text = '<iframe src="javascript:alert(1)"></iframe> cannot update';
  record.failureModes = [{ id: 'no-tool', name: 'Нет <u>инструмента</u>', description: 'd', trialIds: [trial.id] }];
  const html = htmlReport(record);
  const markdown = markdownReport(record);

  // One inline script, allowed by its hash; the only outside reference is the optional font stylesheet.
  assert.match(html, /default-src 'none'/);
  assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(REPORT_SCRIPT).digest('base64')}'`), 'the CSP hash matches the script');
  assert.ok(html.includes(`<script>${REPORT_SCRIPT}</script>`));
  assert.equal(html.match(/<script\b/g)?.length, 1);
  assert.deepEqual([...html.matchAll(/<[^>]*\b(?:href|src)="([^"]*)"/g)].map(match => match[1]), [FONT_STYLESHEET]);

  assert.doesNotMatch(html, /<img|<iframe|<svg|<object|<u>|<form|\u001b\[/i);
  for (const text of ['&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; [ссылка](javascript:alert(1))', '&lt;img src=x onerror=alert(1)&gt;',
    '&lt;iframe src=&quot;javascript:alert(1)&quot;&gt;&lt;/iframe&gt; cannot update', 'Before &lt;svg onload=alert(2)&gt; changing &amp; &quot;owner&quot;',
    'Policy &lt;object data=x&gt;', 'Нет &lt;u&gt;инструмента&lt;/u&gt;', 'v&lt;2&gt;&amp;&quot;&#39;']) assert.ok(html.includes(text), text);

  assert.doesNotMatch(markdown, /<script|<img|<iframe|<svg|<object|<u>|\u001b\[/i);
  assert.equal(markdown.includes('[ссылка](javascript:'), false, 'a record string cannot become a Markdown link');
  for (const text of ['&lt;script&gt;alert\\("x"\\)&lt;/script&gt; \\[ссылка\\]\\(javascript:alert\\(1\\)\\)', '&lt;img src=x onerror=alert\\(1\\)&gt;',
    '&lt;iframe src="javascript:alert\\(1\\)"&gt;&lt;/iframe&gt; cannot update', 'Before &lt;svg onload=alert\\(2\\)&gt; changing &amp; "owner"',
    'Policy &lt;object data=x&gt;', 'Нет &lt;u&gt;инструмента&lt;/u&gt;', 'v&lt;2&gt;&amp;"\'']) assert.ok(markdown.includes(text), text);
});

test('unmeasured attempts and simulator criticism cannot masquerade as agent results', async t => {
  const { after } = await twoRuns(t);
  // An attempt that measured nothing is neither a pass nor a failure.
  const invalid = { ...after, trials: after.trials.map(trial => ({ ...trial, outcome: 'invalid' as const, reason: 'fixture unavailable', checks: [], assessments: [] })) };
  for (const report of [htmlReport(invalid), markdownReport(invalid)]) {
    assert.match(report, /нет данных — ни одна ситуация не измерена/);
    assert.match(report, /Move an appointment: агент не ответил/);
    assert.doesNotMatch(report, /✓ справился|✗ не справился|Разбор ошибок/);
  }
  // The same agent failure counts only while the simulated client kept to the card.
  const judged = (simulator: 'pass' | 'fail'): Experiment => ({ ...after, scenarios: after.scenarios.map(s => ({ ...s, checks: [], metrics: legacyDemoMetrics })),
    trials: after.trials.map(trial => ({ ...trial, outcome: 'ungraded' as const, checks: [], assessments: [
      { metricId: 'demo_follow_ups', result: simulator, rationale: 'SIMULATOR_CRITICISM', evidence: [0] },
      { metricId: 'demo_task_state', result: 'fail' as const, rationale: 'AGENT_FAILURE', evidence: [0] },
    ] })) });
  assert.equal(buildResultView(judged('pass')).failures.length, 1);
  const criticised = judged('fail');
  const view = buildResultView(criticised);
  assert.deepEqual(view.failures, []);
  assert.deepEqual(view.notMeasured.reasons.map(reason => reason.code), ['simulator_deviated']);
  for (const report of [htmlReport(criticised), markdownReport(criticised)]) {
    assert.match(report, /\? не измерено — клиент в симуляции отошёл от ситуации/);
    assert.match(report, /Move an appointment: клиент в симуляции отошёл от ситуации/);
    assert.doesNotMatch(report, /✗ не справился|Разбор ошибок|Почему ошибается|SIMULATOR_CRITICISM|AGENT_FAILURE/);
  }
});

test('a human failure on a green dialogue reaches the result in every export and keeps original results', async t => {
  const { lab, after } = await twoRuns(t);
  const trial = after.trials[0]!;
  const measured = JSON.stringify(trial);
  // «Не согласен» with the judge's pass: the owner's verdict decides the situation by the one human-override rule.
  const reviewed = await lab.addHumanReview(after.id, { trialId: trial.id, metricId: 'demo_task_state', source: 'quick', verdict: 'fail', note: 'QA: missed requirement <script>not executable</script>' });
  assert.equal(JSON.stringify(reviewed.trials[0]), measured, 'the recorded attempt is never rewritten');
  const bundle = await evidenceBundle(reviewed, lab.store);
  assert.deepEqual(bundle.view.failures.map(failure => failure.trialId), [trial.id]);
  assert.deepEqual([bundle.view.headline.passed, bundle.view.headline.decided], [0, 1]);
  assert.deepEqual([bundle.view.agreement.agreed, bundle.view.agreement.checked], [0, 1]);
  for (const report of [htmlReport(bundle), markdownReport(bundle)]) {
    assert.match(report, /✗ не справился/); assert.match(report, /Разбор ошибок/);
    assert.match(report, /с судьёй согласны 0 из 1/); assert.match(report, /вы согласились в 0 из 1/);
    assert.doesNotMatch(report, /Ошибок нет|<script>not executable/);
  }
  const snapshot = JSON.parse(jsonReport(bundle));
  assert.deepEqual(snapshot.view.failures.map((failure: { trialId: string }) => failure.trialId), [trial.id]);
  assert.equal(snapshot.experiment.humanReviews[0].note, 'QA: missed requirement <script>not executable</script>');

  // A full review of what decided the situation is the owner's own verdict: it is in the number, and the page says so.
  const full = await lab.addHumanReview(after.id, { trialId: trial.id, metricId: 'demo_task_state', verdict: 'fail', note: 'Полный разбор: время не изменено.' });
  const fullBundle = await evidenceBundle({ ...full, humanReviews: full.humanReviews.filter(review => review.source !== 'quick') }, lab.store);
  assert.deepEqual([fullBundle.view.headline.passed, fullBundle.view.headline.decided], [0, 1]);
  assert.deepEqual(fullBundle.view.reviewed, { situations: 1, contradicted: 0 });
  for (const report of [htmlReport(fullBundle), markdownReport(fullBundle)]) {
    assert.match(report, /✗ не справился/);
    assert.match(report, /вы проверили 1 ситуацию/); assert.match(report, /Вы сами проверили 1 ситуацию\./);
  }
});

/*
 * The counting rule decides a situation by what its expectations say; a whole-dialogue verdict never
 * moved the number (stored runs are counted the same way today). When it says the opposite of the
 * number, the page names the contradiction instead of absorbing it silently or hiding it.
 */
test('an owner\'s whole-dialogue «Ошибся агент» on a green dialogue is named as a contradiction, never silently absorbed', async t => {
  const { lab, after } = await twoRuns(t);
  const trial = after.trials[0]!;
  const reviewed = await lab.addHumanReview(after.id, { trialId: trial.id, verdict: 'fail', note: 'QA: missed requirement <script>not executable</script>' });
  const bundle = await evidenceBundle(reviewed, lab.store);
  assert.deepEqual(bundle.view.reviewed, { situations: 1, contradicted: 1 });
  assert.deepEqual([bundle.view.headline.passed, bundle.view.headline.decided], [1, 1], 'the number follows the counting rule');
  for (const report of [htmlReport(bundle), markdownReport(bundle)]) {
    assert.match(report, /ваши отметки расходятся с итогом: 1/);
    assert.match(report, /В 1 ситуации ваша отметка по всему разговору расходится с итогом/);
    assert.doesNotMatch(report, /<script>not executable/);
  }
});

test('a failed simulator heuristic parks a green dialogue as not measured in every export; the snapshot keeps the check', async t => {
  const { lab, after } = await twoRuns(t);
  const trial = after.trials[0]!;
  assert.equal(trial.userMode, 'reactive');
  const seq = trial.events.length;
  trial.events = [...trial.events, { seq, type: 'simulator', result: { message: 'again', done: false } }, { seq: seq + 1, type: 'user', text: 'again' }, { seq: seq + 2, type: 'assistant', text: 'ok' }];
  trial.simulatorChecks = [{ id: 'simulator_loop', description: 'Повтор пары ответ агента → реплика пользователя (эвристика)', passed: false, evidence: `Подозрение: реплика #${seq + 1} повторяет реплику #0 <script>`, seq: seq + 1, heuristic: true }];
  const bundle = await evidenceBundle(after, lab.store);
  assert.deepEqual(bundle.view.notMeasured.reasons.map(reason => reason.code), ['simulator_deviated']);
  // The suspicion parks the dialogue instead of letting a green code result stand unchallenged.
  for (const report of [htmlReport(bundle), markdownReport(bundle)]) {
    assert.match(report, /Move an appointment: клиент в симуляции отошёл от ситуации/);
    assert.doesNotMatch(report, /✓ справился|Ошибок нет/);
    assert.doesNotMatch(report, /#0 <script>|Ценность режимов|## Симулятор/);
  }
  const json = JSON.parse(jsonReport(bundle));
  assert.equal(json.experiment.trials[0].simulatorChecks[0].id, 'simulator_loop');
  // No research scorecards: the snapshot is the record, the view, the comparison and the names of what stays local.
  assert.deepEqual(Object.keys(json).sort(), ['before', 'comparison', 'comparisonSource', 'experiment', 'judgeAudits', 'traceJournal', 'view', 'warnings']);
});

test('no page embeds a judge audit; the snapshot leaves every audit out and names where they stay', async t => {
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
  for (const report of [htmlReport(bundle), markdownReport(bundle)]) {
    // The judge is named by its model, escaped like every record string; its protocol hash and replies are not on the page.
    assert.match(report, /судья — judge-&lt;model&gt;/);
    assert.doesNotMatch(report, /judge-<model>|protocol-|RAW_JUDGE_REPLY|&quot;attempts&quot;|"attempts"/);
  }

  // A legacy trial keeps its audit in the record, but no page carries it.
  const old = structuredClone(after);
  old.trials[0] = structuredClone(legacy);
  const oldBundle = await evidenceBundle(old, lab.store);
  for (const report of [htmlReport(oldBundle), markdownReport(oldBundle)]) assert.doesNotMatch(report, /RAW_JUDGE_REPLY|protocol-/);
  // No exported snapshot embeds a full audit, legacy records included.
  const oldJson = jsonReport(oldBundle);
  assert.doesNotMatch(oldJson, /RAW_JUDGE_REPLY|"judgeAudit"/);
  assert.equal(JSON.parse(oldJson).judgeAudits.included, false);
  assert.equal(JSON.parse(oldJson).judgeAudits.omittedLegacyAudits, 2);
  // Audits inside the source run's own embedded evidence are counted too.
  const nested = { ...oldBundle, before: { ...oldBundle.before!, sourceEvidence: { runId: 'older-source', trials: [structuredClone(legacy)], humanReviews: [] } } };
  assert.equal(JSON.parse(jsonReport(nested)).judgeAudits.omittedLegacyAudits, 3);
  assert.doesNotMatch(jsonReport(nested), /RAW_JUDGE_REPLY/);
  assert.ok(JSON.parse(oldJson).judgeAudits.location.includes(`${old.id}.judge/<trialId>.json`));
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
  assert.ok(edited.warnings.some(warning => warning.includes('не совпала') && warning.includes('у 1 разговора')), JSON.stringify(edited.warnings));
  assert.ok(edited.warnings.every(warning => !warning.includes(tampered.id)), 'a warning names no trial id');
  // A missing sidecar keeps the record-only check and says so.
  const orphan = structuredClone(current);
  orphan.id = 'receipt-without-sidecar';
  delete orphan.parentRunId;
  const missing = await evidenceBundle(orphan, lab.store);
  assert.ok(missing.record.trials.every(trial => trial.judgeReceipt?.complete));
  assert.ok(missing.warnings.some(warning => warning.includes('не найден') && warning.includes('только по самой записи')), JSON.stringify(missing.warnings));
  assert.equal(before.id, current.parentRunId);
});
