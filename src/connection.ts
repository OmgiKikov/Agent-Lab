import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { addUsage, checkSchema, emptyUsage, experimentSchema, fingerprint, isRunnable, runnableTargetSchema, settingsSchema, targetSchema, worldSchema, type Experiment, type Scenario, type Target } from './contracts.js';
import type { Runtime } from './runtime.js';
import { evaluateTrial } from './evaluation.js';
import { hasCompleteJudgment, observableSources, scenarioSources, sealJudgeReceipt } from './judge.js';
import { sourceIdentity } from './normalize.js';
import { preflightTarget } from './targets.js';
import { writeFileAtomic } from './fs-atomic.js';
import { SUITE_FORMAT } from './suite.js';

const step = z.strictObject({ message: z.string().trim().min(1).max(3000), reply: z.string().min(1).max(8000) });
const probeSchema = z.strictObject({
  initialState: worldSchema, write: step, read: step, reset: step,
  checks: z.array(checkSchema).max(10).default([]),
}).refine(p => p.read.reply !== p.reset.reply, 'Проверка должна различать сохранённую историю и новую сессию.');
/** Marks a saved connection file; project detection recognises one by it before reading the file as a connection. */
export const CONNECTION_FORMAT = 'agent-lab-connection-1';
const connectionSchema = z.strictObject({ format: z.literal(CONNECTION_FORMAT), target: runnableTargetSchema,
  targetVersion: z.string().trim().min(1).max(200).optional(), probe: probeSchema.optional(), verifiedAt: z.string().optional() });
export type Connection = z.infer<typeof connectionSchema>;

/** Only paths have a base directory. Arguments and environment variable names remain literal. */
export function resolveTarget(raw: unknown, base: string): Target {
  if (!raw || typeof raw !== 'object') return targetSchema.parse(raw);
  const target = { ...raw } as Record<string, unknown>;
  if (typeof target.promptFile === 'string') target.promptFile = resolve(base, target.promptFile);
  if (target.kind === 'module' && typeof target.path === 'string') target.path = resolve(base, target.path);
  if (target.kind === 'command') {
    target.cwd = resolve(base, typeof target.cwd === 'string' ? target.cwd : '.');
    if (typeof target.command === 'string' && target.command.includes('/')) target.command = resolve(target.cwd as string, target.command);
  }
  if (target.kind !== 'sandbox' && target.release && typeof target.release === 'object') {
    const release = { ...(target.release as Record<string, unknown>) };
    release.cwd = resolve(base, typeof release.cwd === 'string' ? release.cwd : '.');
    if (typeof release.command === 'string' && release.command.includes('/')) release.command = resolve(typeof release.cwd === 'string' ? release.cwd : base, release.command);
    target.release = release;
  }
  return targetSchema.parse(target);
}

export function portableTarget(target: Target, base: string): unknown {
  const path = (file: string) => relative(base, file) || '.';
  const executable = (cwd: string, file: string) => { const value = relative(cwd, file); return value.includes('/') ? value : `./${value}`; };
  const prompt = isRunnable(target) && target.promptFile ? { promptFile: path(target.promptFile) } : {};
  const release = isRunnable(target) && target.release ? { release: { ...target.release, ...(target.release.cwd ? { cwd: path(target.release.cwd) } : {}),
    command: isAbsolute(target.release.command) ? executable(target.release.cwd ?? base, target.release.command) : target.release.command } } : {};
  if (target.kind === 'module') return { ...target, ...prompt, ...release, path: path(target.path) };
  if (target.kind !== 'command') return { ...target, ...prompt, ...release };
  const cwd = target.cwd ?? process.cwd();
  return { ...target, ...prompt, ...release, cwd: path(cwd), command: isAbsolute(target.command) ? executable(cwd, target.command) : target.command,
    args: target.args.map(arg => isAbsolute(arg) && /\.(?:[cm]?js|ts|py|sh)$/.test(arg) ? relative(cwd, arg) : arg) };
}

export async function readConnection(file: string): Promise<Connection> {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return connectionSchema.parse({ ...raw, target: resolveTarget(raw.target, dirname(resolve(file))) });
}
export async function rememberedConnection(directory: string): Promise<Connection | undefined> {
  try { return await readConnection(resolve(directory, 'connection.local.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export async function rememberConnection(directory: string, connection: Connection): Promise<void> {
  const previous = await rememberedConnection(directory);
  if (!connection.probe && previous?.probe && fingerprint(previous.target) === fingerprint(connection.target)) connection = { ...connection, probe: previous.probe };
  const path = resolve(directory, 'connection.local.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(connectionSchema.parse({ ...connection, verifiedAt: new Date().toISOString() }), null, 2) + '\n');
}

export async function listSuites(directory: string) {
  const files = await readdir(directory);
  return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => {
    const path = resolve(directory, file);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (raw.format !== SUITE_FORMAT) return { file: path, error: 'Не является набором Agent Lab.' };
      const record = experimentSchema.parse({ ...raw.definition, target: resolveTarget(raw.definition.target, dirname(path)) });
      const accepted = (record.acceptedTests ?? []).filter(test => {
        const scenario = record.scenarios.find(candidate => candidate.id === test.scenarioId);
        return scenario !== undefined && fingerprint(scenario) === test.definitionHash;
      });
      return { file: path, task: record.task, cases: record.scenarios.map(s => ({ id: s.id, title: s.title, tier: s.tier })),
        acceptedCount: accepted.length, acceptedTestIds: accepted.map(test => test.testId),
        sourceRunId: record.sourceEvidence?.runId ?? record.parentRunId, sourceTrials: record.sourceEvidence?.trials.length ?? 0 };
    } catch (error) { return { file: path, error: error instanceof Error ? error.message : String(error) }; }
  }));
}

/** An explicit three-request probe exercises history and reset, using the real adapter path. */
export async function doctor(connection: Connection, signal = new AbortController().signal) {
  const probe = probeSchema.parse(connection.probe);
  await preflightTarget(connection.target);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error('Connection probe exceeded 180 seconds')), 180000);
  const usage = emptyUsage();
  // Scripted probe cards without rubrics: nothing here calls a model or generates a user.
  const runtime: Runtime = {};
  const settings = settingsSchema.parse({ repeats: 1, maxTurns: 2, maxCalls: 5, userModes: ['scripted'], maxDurationMs: 180000 });
  const spec = { name: 'Connection probe', instructions: 'Use the external connection.', tools: [] };
  const revision = { id: fingerprint(spec), spec, parentId: null, hypothesis: 'Connection probe', createdAt: new Date().toISOString() };
  const makeCard = (reset: boolean): Scenario => ({ id: reset ? 'probe-reset' : 'probe-history', familyId: 'probe', split: 'dev',
    title: reset ? 'Новая сессия и сброс состояния' : 'Два хода с сохранением истории', tier: 'smoke', provenance: 'curated', requirementIds: [],
    user: { goal: 'Проверить подключение', facts: 'Заданы владельцем адаптера', behavior: 'Следовать сценарию',
      opening: reset ? probe.reset.message : probe.write.message, script: reset ? [] : [probe.read.message], maxFollowUps: reset ? 0 : 1 },
    initialState: probe.initialState,
    checks: [{ id: 'reply', kind: 'answer_equals', description: 'Ожидаемый ответ проверки подключения', value: reset ? probe.reset.reply : probe.read.reply },
      ...(reset ? Object.entries(probe.initialState.records).flatMap(([recordId, fields]) => Object.entries(fields).map(([field, value], i) =>
        ({ id: `reset-${recordId}-${i}`, kind: 'state_equals' as const, description: 'Новая сессия восстановила исходное состояние', recordId, field, value }))) : probe.checks)],
  });
  try {
    const trials = [];
    for (const reset of [false, true]) trials.push(await evaluateTrial({ runtime, revision, scenario: makeCard(reset), sources: [], requirements: [], repeat: 0,
      manifestHash: fingerprint(probe), settings, userMode: 'scripted', target: connection.target,
      ctx: { signal: combined, timeoutMs: 60000, beforeCall() { combined.throwIfAborted(); if (++usage.calls > 3) throw new Error('Probe call limit exceeded'); },
        addUsage(u) { addUsage(usage, u); } } }));
    const firstReply = trials[0]!.events.find(e => e.type === 'assistant')?.text;
    const passed = trials.every(t => t.outcome === 'pass') && firstReply === probe.write.reply
      && trials.every(t => t.observation?.resetConfirmed === true && t.observation.tools === 'complete' && !!t.observation.version)
      && trials[0]!.observation?.version === trials[1]!.observation?.version;
    return { format: 'agent-lab-doctor-1', passed, createdAt: new Date().toISOString(), target: connection.target, trials,
      message: passed ? 'История и сброс прошли заданную проверку; адаптер сообщил версию и полную трассу в заявленной области инструментов.'
        : 'Проверьте ответы, итоговое состояние, resetConfirmed, eventsComplete и стабильную version.',
      limitation: 'Это проверка заданного поведения. Состояние и полноту событий сообщает адаптер; его реализацию нужно сверять с тестовой системой.' };
  } finally { clearTimeout(timer); }
}

/**
 * The source attempts a saved suite or a reassessment carries. A legacy full judge audit is
 * replaced by a receipt sealed with the full verifier now, so the copy never duplicates the audit.
 */
export function suiteEvidence(record: Experiment, scenarioIds: string[]) {
  const selected = new Set(scenarioIds);
  const trials = record.trials.filter(trial => selected.has(trial.scenarioId)).map(trial => {
    const copy = structuredClone(trial);
    if (copy.judgeAudit) {
      const scenario = record.scenarios.find(s => s.id === copy.scenarioId);
      const complete = !!scenario && hasCompleteJudgment({ scenario, sources: observableSources(scenarioSources(record, scenario), record.requirements), trial: copy });
      copy.judgeReceipt ??= sealJudgeReceipt(copy.judgeAudit, complete);
      delete copy.judgeAudit;
    }
    return copy;
  });
  const trialIds = new Set(trials.map(trial => trial.id));
  return { runId: record.id, ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}), trials,
    humanReviews: record.humanReviews.filter(review => trialIds.has(review.trialId)).map(review => structuredClone(review)),
    identity: sourceIdentity(record, scenarioIds) };
}
