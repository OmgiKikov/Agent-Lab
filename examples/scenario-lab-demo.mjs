import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentLab, draftHash } from '../dist/experiment.js';
import { createInputSchema, fingerprint } from '../dist/contracts.js';
import { createDemoRuntime } from '../dist/demo.js';
import { libraryHash } from '../dist/scenario-library.js';
import { evaluateGenerator, loadGeneratorCorpus } from '../dist/generator-evaluation.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const policy = 'Если номер терминала уже указан, не запрашивайте его повторно; объясните возврат. Если номера нет, уточните номер терминала.';
export const dialogues = [
  { id: 'known', messages: [{ role: 'user', content: 'Номер терминала: 1234. Помогите с возвратом.' }, { role: 'assistant', content: 'Уточните номер терминала.' }] },
  { id: 'late', messages: [{ role: 'user', content: 'Помогите с возвратом.' }, { role: 'assistant', content: 'Уточните номер терминала.' }, { role: 'user', content: 'Номер терминала: 5678' }] },
];
const target = (fixed = false) => ({ kind: 'module', path: join(root, 'examples/scenario-lab-target.mjs'), exportName: fixed ? 'createFixedSession' : 'createSession', diagnosticCapabilities: { protocol: 'paired-intervention-v1', toolResponse: false, ragFragment: true } });
function proposal(batchId, dialogue) {
  const known = dialogue.id === 'known', number = known ? '1234' : '5678';
  return {
    business: { key: 'refund', title: 'Возврат оплаты', goal: 'Получить инструкцию по возврату оплаты', conditions: [], requirementIds: ['refund_rule'], grouping: { status: 'confirmed', reason: 'Одинаковая цель и правило; номер отличается по способу раскрытия' } },
    variant: { id: known ? 'known_number' : 'late_number', title: known ? 'Номер уже в первой реплике' : 'Номер раскрывается по просьбе', purpose: 'Проверить уместность запроса номера', provenance: 'production', sourceDialogues: [{ batchId, dialogueId: dialogue.id }],
      userState: { goal: 'Получить инструкцию по возврату', opening: dialogue.messages[0].content, facts: [{ id: 'terminal', statement: `Номер терминала: ${number}`, value: number, availability: known ? 'initial' : 'uncertain', reason: known ? 'Личные данные в первой реплике' : 'Учебный спорный факт: подтвердите, что личный номер был известен до разговора', origin: { kind: 'dialogue', batchId, dialogueId: dialogue.id, eventIndex: known ? 0 : 2, quote: `Номер терминала: ${number}` } }], cannotKnow: [], missing: [] },
      behaviorPolicy: { version: 1, initialState: 'waiting', states: ['waiting', 'done'], terminalStates: ['done'], maxFollowUps: 1, repetitionLimit: 1, actions: [{ id: 'finish', kind: 'finish', factIds: [] }], transitions: [{ from: 'waiting', to: 'done', actionId: 'finish', when: 'Получена инструкция или уточняющий вопрос' }] },
      environmentFixture: { mode: 'prompt', initialState: { records: {}, writableFields: [] } },
      evaluationSpec: { goalObservation: 'reply', successCriteria: known ? 'Агент не запрашивает указанный номер повторно' : 'Агент уточняет номер, которого нет в первой реплике', checkpoints: [{ id: 'ask_once', requirementId: 'refund_rule', quote: policy, applicability: known ? 'Номер указан в первой реплике' : 'В первой реплике нет номера', observation: 'reply', role: 'required', rule: known ? 'Не запрашивать номер повторно' : 'Уточнить номер терминала', check: { id: 'number', kind: known ? 'answer_omits' : 'answer_contains', value: 'Уточните номер терминала', description: 'Уместность запроса номера' } }] },
    },
  };
}
/** Explicit deterministic teaching adapter. It is never evidence of model quality. */
export function demoScenarioRuntime() {
  return { ...createDemoRuntime(),
    async prepare(input) { return { requirements: [{ id: 'refund_rule', sourceId: input.sources[0].id, text: policy, quote: policy, critical: true }], questions: [], agent: { name: 'Учебный агент возвратов', instructions: policy, tools: [] }, scenarios: [] }; },
    async scenarioProposals(input) { return input.dialogues.map(d => proposal(input.batchId, dialogues.find(source => source.id === d.id))); },
    async assessScenarioProposals(input) { return input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready', reason: 'Заранее разобранный разработчиком учебный пример; не модельная оценка' }))); },
    async selectUserAction() { return { actionId: 'finish', factIds: [] }; },
    async assessCheckpoints(input) { return input.checkpoints.map(c => ({ checkpointId: c.checkpoint.id, result: 'pass', evidence: c.allowedEvidence, rationale: 'В учебном наборе условие применимо; точная проверка вычисляется из ответа' })); },
    async assess({ scenario, trial }) { return (scenario.metrics ?? []).map(metric => ({ metricId: metric.id, result: trial.checks.every(c => c.passed) ? 'pass' : 'fail', evidence: trial.events.filter(e => e.type === 'assistant').map(e => e.seq), rationale: 'Детерминированная учебная оценка по точным проверкам' })); },
  };
}
export async function seedScenarioLab(directory, options = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).includes('.agent-lab')) throw new Error('Выберите новую папку: существующая .agent-lab не изменяется.');
  const lab = new ExperimentLab(join(directory, '.agent-lab'), demoScenarioRuntime());
  try {
    await lab.init();
    const seed = await lab.create(createInputSchema.parse({ task: 'Учебная проверка возвратов: два вымышленных диалога', mode: options.live ? 'live' : 'demo', target: target(), materials: [{ name: 'Учебное правило владельца', content: policy }], dialogues,
      scenarioCount: 0, settings: { repeats: 2, maxCalls: 60, maxTurns: 3, maxDurationMs: 300000, timeoutMs: 60000, userModes: ['reactive'], ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}) } }));
    await lab.waitForIdle(); const draft = await lab.get(seed.id); assert.equal(draft.phase, 'review', draft.error ?? '');
    return { directory, runId: draft.id, evidenceKind: 'developer-authored-synthetic-fixture', next: `В Pi: /agent-lab ${draft.id}`, ready: draft.librarySnapshot.variants.filter(v => v.quality === 'ready').length, needsReview: draft.librarySnapshot.variants.filter(v => v.quality === 'needs_review').length };
  } finally { await lab.close(); }
}
export async function verifyScenarioLab(directory) {
  const seeded = await seedScenarioLab(directory), lab = new ExperimentLab(join(directory, '.agent-lab'), demoScenarioRuntime());
  try {
    await lab.init(); const draft = await lab.readLibrary(seeded.runId);
    const adapterBytes = await readFile(target().path, 'utf8');
    const imported = await readFile(join(lab.store.directory, 'imports', `${draft.experiment.originalImport.id}.json`), 'utf8');
    const changed = await lab.editLibrary(seeded.runId, libraryHash(draft.library), { kind: 'edit_fact', variantId: 'late_number', factId: 'terminal', statement: 'Номер терминала: 5678', value: '5678', availability: 'initial', editId: 'demo_owner_confirmed', reason: 'Учебная явная правка: личный номер был известен до разговора' });
    await lab.assessLibrary(seeded.runId, libraryHash(changed.library)); await lab.waitForIdle();
    const reviewed = await lab.readLibrary(seeded.runId), accepted = await lab.acceptLibrary(seeded.runId, libraryHash(reviewed.library), ['known_number', 'late_number']);
    const acceptedHash = libraryHash(accepted.library);
    await lab.start(seeded.runId, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
    const source = await lab.get(seeded.runId), sourceBytes = await readFile(join(lab.store.directory, `${source.id}.json`), 'utf8');
    const issue = (await lab.store.readIssues()).find(i => i.kind === 'defect'); assert.ok(issue, JSON.stringify(source.trials));
    const repeat = await lab.repeat(source.id); await lab.start(repeat.id, { approved: true, expectedHash: draftHash(repeat) }); await lab.waitForIdle();
    const repeatedIssue = (await lab.store.readIssues()).find(i => i.id === issue.id); assert.ok(repeatedIssue);
    const plan = await lab.prepareDiagnostic(issue.id, source.id, { kind: 'rag-fragment', sourceId: source.sources[0].id, sourceHash: fingerprint(policy), content: policy, hypothesis: 'Проверить действие доступного правила на повторный запрос номера' }, 2);
    const diagnostic = await lab.startDiagnostic(plan.id); await lab.waitForIdle(); const diagnosis = await lab.store.readDiagnostic(plan.id);
    const candidate = await lab.registerCandidate(source.id, { target: target(true), targetVersion: 'demo-fixed-v1' });
    const resolution = await lab.prepareResolution({ issueId: issue.id, baselineRunId: source.id, candidateRunId: candidate.id, reproducerIds: ['known_number'], regressionIds: ['late_number'], stability: { kind: 'all-pass', repeats: 2 } });
    const frozen = await lab.store.readResolution(resolution.id); assert.equal(frozen.result, undefined); assert.equal((await lab.get(candidate.id)).trials.length, 0);
    await lab.startResolution(resolution.id, { approved: true }); await lab.waitForIdle(); const resolved = await lab.resolveIssue(resolution.id);
    const corpus = await loadGeneratorCorpus(); corpus.cases = corpus.cases.filter(c => c.split === 'dev').slice(0, 2);
    const generator = await evaluateGenerator(corpus, { config: { instructions: 'Учебный заведомо неполный генератор', temperature: 0 }, transport: 'deterministic-test', async generate(input) { return { facts: input.factCandidates.map(f => ({ id: f.id, availability: 'unavailable' })), applicability: 'unknown', duplicate: 'none', validity: 'unknown', rationale: 'Учебная неполная оценка; улучшение не заявлено' }; } }, false, { store: lab.store, signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} });
    for (const proof of repeatedIssue.evidence) { const record = await lab.get(proof.runId); assert.ok(record.trials.some(t => t.id === proof.trialId)); }
    assert.equal((await lab.store.readGeneratorRecord(generator.id)).id, generator.id);
    assert.equal((await lab.store.readDiagnostic(plan.id)).runId, diagnostic.id);
    assert.equal((await lab.store.readResolution(resolution.id)).policy.candidateRunId, candidate.id);
    assert.equal(await readFile(join(lab.store.directory, `${source.id}.json`), 'utf8'), sourceBytes);
    assert.equal(await readFile(join(lab.store.directory, 'imports', `${source.originalImport.id}.json`), 'utf8'), imported);
    assert.equal(libraryHash(await lab.store.readLibrary(accepted.library.id, acceptedHash)), acceptedHash);
    assert.equal(await readFile(target().path, 'utf8'), adapterBytes);
    return { evidenceKind: 'deterministic-integration', directory, runId: source.id, repeatRunId: repeat.id, candidateRunId: candidate.id, diagnosisId: plan.id, policyId: resolution.id, generatorId: generator.id,
      library: { dialogues: draft.library.imports[0].dialogues.length, groups: draft.library.businessScenarios.length, variants: draft.library.variants.length }, ownerReceipt: changed.library.variants[1].history.some(h => h.factEdit?.editId === 'demo_owner_confirmed'), sourceUnchanged: true,
      issueId: issue.id, repeatedIssueId: repeatedIssue.id, issueAssessmentLinks: repeatedIssue.evidence.length, diagnosis: diagnosis.result.conclusion, diagnosticTrials: (await lab.get(diagnostic.id)).trials.length,
      policyFrozenBeforeRun: true, defectNoLongerReproduced: resolved.result.defectNoLongerReproduced, candidateAcceptable: resolved.result.candidateAcceptable, generatorCases: generator.cases.length, generatorTransport: generator.transport, persistedLinksResolve: true };
  } finally { await lab.close(); }
}
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const verify = process.argv.includes('--verify');
  const directory = await mkdtemp(join(tmpdir(), verify ? 'scenario-lab-proof-' : 'scenario-lab-demo-'));
  const report = verify ? await verifyScenarioLab(directory) : await seedScenarioLab(directory, { live: true, provider: process.env.AGENT_LAB_PROVIDER, model: process.env.AGENT_LAB_MODEL });
  await writeFile(join(directory, 'demo-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!verify) {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    console.log(`cd ${quote(directory)}\n${quote(join(root, 'node_modules/.bin/pi'))} --no-extensions -e ${quote(join(root, 'extensions/agent-lab.ts'))} --no-skills --skill ${quote(join(root, 'skills/agent-builder/SKILL.md'))} --no-context-files --no-session`);
    console.log('Это вымышленный учебный черновик. Подготовка не вызывала модель; g и запуск в Pi используют настроенную модель и сохранённый бюджет.');
  }
}
