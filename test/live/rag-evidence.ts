/** Explicit live judge controls through the real module adapter and evaluation loop. Run from an isolated snapshot. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_JUDGE, emptyUsage, fingerprint, scenarioSchema, settingsSchema, type Scenario, type Trial } from '../../src/contracts.js';
import { evaluateTrial } from '../../src/evaluation.js';
import { createPiRuntime } from '../../src/pi.js';
import { ExperimentStore } from '../../src/store.js';
import { JUDGE_PROTOCOL } from '../../src/judge.js';

if (!process.argv.includes('--run')) throw new Error('Для платных контрольных вызовов явно укажите --run.');
const value = (flag: string) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
const maxCalls = Number(value('--max-calls'));
if (!Number.isInteger(maxCalls) || maxCalls < 12 || maxCalls > 120) throw new Error('Укажите явный --max-calls от 12 до 120.');
const ledgerPath = value('--ledger');
const controls = JSON.parse(await readFile(new URL('../fixtures/rag-evidence-controls.json', import.meta.url), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'rag-evidence-controls-'));
const store = new ExperimentStore(join(directory, '.agent-lab'));
const settings = settingsSchema.parse({ provider: DEFAULT_JUDGE.provider, model: DEFAULT_JUDGE.model, judge: DEFAULT_JUDGE,
  maxCalls, repeats: 1, maxTurns: 2, timeoutMs: 90000, userModes: ['static'] });
const sources = [{ ...controls.reference, hash: fingerprint(controls.reference.content) }];
const scenario: Scenario = { ...scenarioSchema.parse({ id: 'rag-control', familyId: 'rag-controls', provenance: 'synthetic',
  title: 'Учебная консультация по возврату', requirementIds: [], goalObservation: 'reply',
  successCriteria: 'Дать общую инструкцию по актуальной статье, без обязательного номера терминала.',
  user: { goal: 'Узнать, как оформить возврат', opening: controls.question, facts: 'Номер терминала неизвестен.', behavior: 'Задать вопрос один раз.', maxFollowUps: 0 },
  checks: [], metrics: [], initialState: { records: {}, writableFields: [], transientFailures: 0 } }), split: 'dev' };
const revision = { id: 'rag-control-target', parentId: null, createdAt: new Date().toISOString(), hypothesis: 'Fixed adapter control',
  spec: { name: 'Fixed control', instructions: 'The module adapter supplies the response.', tools: [] } };
const usage = emptyUsage(), trials: { caseId: string; expected: Record<string, string>; trial: Trial }[] = [];
const runId = randomUUID();
const code = Object.fromEntries(await Promise.all(['judge.ts', 'rag-evidence.ts', 'contracts.ts', 'targets.ts', 'evaluation.ts', 'pi.ts'].map(async file =>
  [file, fingerprint(await readFile(new URL('../../src/' + file, import.meta.url), 'utf8'))])));
const plan = { id: 'gen_' + randomUUID(), formatVersion: '1' as const, kind: 'rag-evidence-control-plan',
  evidenceKind: controls.evidenceKind, settings, controls, scenario, code, judgeProtocol: JUDGE_PROTOCOL };
const persist = () => writeFile(join(directory, 'report.json'), JSON.stringify({ plan, usage, trials }, null, 2), { mode: 0o600 });
try {
  await store.init();
  await store.saveGeneratorRecord(plan);
  await writeFile(join(directory, 'plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, maxCalls, controls: controls.cases.length }));
  const runtime = await createPiRuntime(settings);
  for (const control of controls.cases) {
    const path = join(directory, control.id + '.mjs');
    const response = { reply: control.reply, retrievals: control.retrievals, retrievalsComplete: true, eventsComplete: true, resetConfirmed: true, version: 'rag-control-v1' };
    await writeFile(path, 'export function createSession(){return {async respond(){return ' + JSON.stringify(response) + ';}};}\n', { mode: 0o600 });
    const trial = await evaluateTrial({ runtime, revision, scenario, sources, requirements: [], settings, repeat: 0,
      manifestHash: fingerprint(plan), userMode: 'static', target: { kind: 'module', path, exportName: 'createSession' },
      ctx: { signal: new AbortController().signal, timeoutMs: settings.timeoutMs,
        beforeCall() {
          if (usage.calls >= maxCalls) throw new Error('Лимит контрольного аудита исчерпан.');
          if (ledgerPath) {
            const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
            if (ledger.calls >= ledger.limit || ledger.calls + (ledger.previousCycleCalls ?? 0) >= (ledger.aggregateLimit ?? Infinity)) throw new Error('Общий лимит вызовов исчерпан.');
            ledger.calls++; writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
          }
          usage.calls++;
        },
        addUsage(value) { usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens;
          usage.costUsd = value.costUsd === null || usage.costUsd === null ? null : usage.costUsd + value.costUsd; },
        onTrace(id, event) { store.appendTrace(runId, id, event); },
        onJudgment(id, audit, final) { store.writeJudgeAudit(runId, id, audit); if (final) store.appendJudgment(runId, id, audit); },
      } });
    trials.push({ caseId: control.id, expected: control.expected, trial });
    await persist();
    console.log(JSON.stringify({ caseId: control.id, error: trial.assessmentError, usage: trial.usage,
      grades: trial.assessments?.map(row => ({ metric: row.metricId, expected: control.expected[row.metricId], actual: row.result })) }));
  }
  await store.saveGeneratorRecord({ id: 'gen_' + randomUUID(), formatVersion: '1', kind: 'rag-evidence-control-report', planId: plan.id, usage, trials });
  if (trials.some(row => row.trial.assessmentError || !row.trial.assessments?.length
    || Object.entries(row.expected).some(([metric, expected]) => row.trial.assessments?.find(a => a.metricId === metric)?.result !== expected))) process.exitCode = 1;
} finally { await persist(); await store.close(); }
