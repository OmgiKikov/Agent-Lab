/*
 * One business case end to end, deterministically, through the Pi tools of the real extension (a fake `pi`, a scripted
 * owner who answers every native dialog) and then the command line a CI runs:
 *
 *   logs + materials ─► agent_lab_analyze: a grounded problem ─► the owner confirms its example (native dialog)
 *   ─► agent_lab_prepare fromAnalysis: cards carrying the same criterion, a neighbour for the rest ─► agent_lab_decide
 *   ─► agent_lab_run on the baseline: reproduced ─► candidates: the regressed one (problem fixed, neighbour broken) and
 *      the fixed one ─► agent_lab_results: the two answers apart ─► agent_lab_results save: a suite of the known problem
 *   ─► agent-lab evaluate (CI) against each version: exit codes
 *
 * The teaching agent (examples/scenario-lab-target.mjs) in its three versions and the deterministic teaching runtime:
 * no model, no key. «Works for this case» is all it shows — never judge quality on real conversations, full traffic
 * coverage or that no regression will come later.
 *
 *   npx tsx scripts/business-case.ts   (after npm run build: the CI step calls dist/cli.js)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import agentLab from '../extensions/agent-lab.ts';
import { createDemoAnalysisRuntime, demoTarget } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { ExperimentStore } from '../src/store.js';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cwd = await mkdtemp(join(tmpdir(), 'business-case-'));
const directory = join(cwd, '.agent-lab');
await mkdir(directory, { recursive: true, mode: 0o700 });
const target = (exportName: string) => ({ ...demoTarget(), exportName });
const connection = (exportName: string) => ({ format: 'agent-lab-connection-1', target: target(exportName) });
await writeFile(join(directory, 'connection.local.json'), JSON.stringify(connection('createSession')));

type Tool = { name: string; execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: { text: string }[] }> };
const tools = new Map<string, Tool>();
const active = { names: ['read', 'bash', 'edit', 'write'] };
await agentLab({ registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: () => {}, registerMessageRenderer: () => {}, on: () => {},
  sendMessage: () => {}, sendUserMessage: () => {}, getActiveTools: () => [...active.names], setActiveTools: (names: string[]) => { active.names = [...names]; } } as never,
{ gateway: { connect: async () => ({ failure: { kind: 'not configured' } }) } as never, createLab: (dir: string) => new ExperimentLab(dir, createDemoAnalysisRuntime()),
  inlineRunMs: 600_000, inlineBuildMs: 600_000, inlineCheckMs: 600_000 } as never);

/** The owner: every native dialog is logged; a pick comes from the script, else the first option — the one that goes on. */
const dialogs: string[] = [];
const picks: string[] = [];
const ctx = { cwd, hasUI: true, mode: 'tui', model: { provider: 'agent-lab', id: 'demo' }, modelRegistry: { getAvailable: () => [] },
  ui: { select: async (title: string, options: string[]) => { const pick = picks.shift() ?? options[0]!; dialogs.push(`${title.split('\n')[0]} → ${pick}`); return pick; },
    confirm: async (title: string) => { dialogs.push(`${title.split('\n')[0]} → да`); return true; },
    editor: async (title: string) => { dialogs.push(`${title} → (слова владельца)`); return 'Агент переспросил номер, который клиент назвал сразу.'; },
    input: async () => undefined, notify: () => {}, setStatus: () => {}, setWidget: () => {}, custom: async () => undefined } };
const call = async (name: string, params: unknown) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return JSON.parse((await tool.execute(`call-${name}`, params, undefined, undefined, ctx)).content[0]!.text) as Record<string, unknown>;
};
const say = (title: string, ...lines: unknown[]) => { console.log(`\n── ${title}`); for (const line of lines) console.log(typeof line === 'string' ? line : JSON.stringify(line, null, 1)); };
const lastDialog = () => dialogs.at(-1) ?? '';
/** What the case must show at each step; a miss is printed and fails the script. */
const expect = (ok: boolean, what: string) => { console.log(`${ok ? 'OK  ' : 'MISS'} ${what}`); if (!ok) process.exitCode = 1; };
type ProblemFromLogs = { reproducedOnThisVersion?: string; againstRepeatedRun?: string; restOfCheck?: { broken?: string[]; regressionTests?: number } };

// 1. Logs and materials → the grounded problem (the teaching logs and the owner's rule).
const analysed = await call('agent_lab_analyze', { demo: true });
expect(((analysed.problems as unknown[]) ?? []).length > 0, 'DISCOVER grounded a problem on a verbatim rule');
say('1. agent_lab_analyze — logs + materials → problems', { analysed: analysed.analysed, of: analysed.of, problems: (analysed.problems as { number: number; violation: string; size: string; rules: unknown; examples: unknown }[])
  .map(problem => ({ number: problem.number, violation: problem.violation, size: problem.size, rules: problem.rules })) });

// 2. The owner's word on the example, natively; the model never passes the verdict.
picks.push('Да, это нарушение');
const reviewed = await call('agent_lab_analyze', { analysis: 'latest', review: { problem: 1, example: 1 } });
say('2. the owner confirms example 1.1', lastDialog(), reviewed.reviewed);

// 3. The owner's check: cards from the problem's conversation, carrying the same criterion, and a neighbour.
const prepared = await call('agent_lab_prepare', { fromAnalysis: { analysis: 'latest', problem: 1 } });
say('3. agent_lab_prepare fromAnalysis — the check', dialogs.find(line => line.includes('Собрать')) ?? lastDialog(), { counts: prepared.counts ?? prepared.situations });
const store = new ExperimentStore(directory);
const draft = (await store.list()).find(record => record.fromAnalysis);
const analysis = (await store.listAnalyses())[0]!;
const library = draft?.librarySnapshot?.formatVersion === 2 ? draft.librarySnapshot : undefined;
say('   the draft keeps the link', { broken: draft?.fromAnalysis?.broken, neighbours: draft?.fromAnalysis?.neighbours, criterionHash: draft?.fromAnalysis?.criterionHash?.slice(0, 16),
  cards: library?.cards.map(card => ({ dialogue: card.origin.kind === 'dialogue' ? card.origin.dialogueId : card.origin.kind, duties: card.agentMust.map(duty => duty.text) })),
  problemFindingCriterion: analysis.findings.find(finding => finding.dialogueId === 'known' && finding.result === 'fail')?.criterionHash.slice(0, 16) });
expect(!!draft?.fromAnalysis?.criterionHash && analysis.findings.some(finding => finding.dialogueId === 'known' && finding.result === 'fail' && finding.criterionHash === draft.fromAnalysis?.criterionHash),
  'the check carries the very criterion DISCOVER found (same hash)');

// 4. The owner answers the one question of the check (the neighbour's customer named the number only when asked).
const queue = await call('agent_lab_decide', {});
for (const decision of (queue.decisions ?? []) as { key: string; about: string; text: string; answers: { number: number; label: string }[] }[]) {
  const answered = await call('agent_lab_decide', { decision: decision.key, choice: 1 });
  say('4. agent_lab_decide', { about: decision.about, question: decision.text, answer: decision.answers[0]?.label, decided: answered.decided, notice: answered.notice });
}

// 5. The baseline version: the problem reproduces.
const result = async (runId?: string) => call('agent_lab_results', runId ? { run: runId } : {});
const runOf = async (params: Record<string, unknown>) => {
  const started = await call('agent_lab_run', params);
  const runs = (await store.list()).filter(record => record.trials.length).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { started, run: runs[0]! };
};
const baseline = await runOf({});
const facts = (output: Record<string, unknown>) => (output.lines as string[]).filter(line => line.trim()).slice(0, 40);
const baselineResult = await result(baseline.run.id);
say('5. agent_lab_run — baseline (demo-baseline-v1)', lastDialog(), ...facts(baselineResult));
expect((baselineResult.problemFromLogs as ProblemFromLogs | undefined)?.reproducedOnThisVersion === 'yes', 'baseline: the problem reproduces');

/** A new version of the agent, as the owner connects it: the project's connection file with its exam, then the run names it. */
const candidate = async (exportName: string, version: string) => {
  await writeFile(join(cwd, 'connection.json'), JSON.stringify(connection(exportName)));
  return runOf({ run: baseline.run.id, agent: { module: join(repo, 'examples/scenario-lab-target.mjs'), factory: exportName, version } });
};
// 6. The regressed candidate: fixes the problem, breaks «спросить отсутствующий номер».
const regressed = await candidate('createRegressedSession', 'demo-regressed-v1');
const regressedResult = await result(regressed.run.id);
say('6. agent_lab_run — regressed candidate against the baseline', ...facts(regressedResult));
const local = regressedResult.problemFromLogs as ProblemFromLogs | undefined;
expect(local?.againstRepeatedRun === 'fixed' && !!local.restOfCheck?.broken?.length, 'regressed candidate: the problem fixed locally AND the regression of another rule reported apart');

// 7. The fixed candidate.
const fixed = await candidate('createFixedSession', 'demo-fixed-v1');
const fixedResult = await result(fixed.run.id);
say('7. agent_lab_run — fixed candidate against the baseline', ...facts(fixedResult));
const good = fixedResult.problemFromLogs as ProblemFromLogs | undefined;
expect(good?.againstRepeatedRun === 'fixed' && !good.restOfCheck?.broken?.length && (good.restOfCheck?.regressionTests ?? 0) > 0, 'fixed candidate: fixed, and the regression tests confirmed on the baseline hold');

// 8. Saved as the suite of the known problem.
const saved = await call('agent_lab_results', { run: fixed.run.id, save: true });
const suiteFile = saved.suite as string | undefined;
const suite = suiteFile && existsSync(suiteFile) ? JSON.parse(await readFile(suiteFile, 'utf8')) as { purpose?: string; problem?: unknown } : undefined;
say('8. agent_lab_results save — the suite', { file: suiteFile?.replace(cwd, '<project>'), purpose: suite?.purpose, problem: suite?.problem });
expect(suite?.purpose === 'known_problem', 'the suite is saved as the known problem\'s (PROTECT metadata)');

// 9. CI: agent-lab evaluate of the saved suite against each version — its exit code.
if (!suiteFile) throw new Error(`the suite was not saved: ${JSON.stringify(saved).slice(0, 400)}`);
const ci = join(cwd, 'ci');
await mkdir(ci, { recursive: true });
for (const [exportName, expected] of [['createFixedSession', 0], ['createRegressedSession', 1], ['createSession', 1]] as const) {
  const file = join(ci, `${exportName}.connection.json`);
  await writeFile(file, JSON.stringify(connection(exportName)));
  const outcome = spawnSync(process.execPath, [join(repo, 'dist/cli.js'), 'evaluate', '--input', suiteFile, '--connection', file, '--data-dir', join(ci, exportName), '--yes'], { encoding: 'utf8' });
  const json = outcome.stdout ? JSON.parse(outcome.stdout) as { exitCode: number; lines: string[] } : undefined;
  say(`9. agent-lab evaluate — ${exportName}`, `exit ${outcome.status} (expected ${expected})`, ...(json?.lines.filter(line => line.includes('Точность') || line.includes('Итог') || line.includes('Сломалось') || line.includes('Воспроизведена') || line.includes('не воспроизведена')) ?? [outcome.stderr.slice(0, 400)]));
  expect(outcome.status === expected && json?.exitCode === expected && Array.isArray(json.lines),
    `CI: agent-lab evaluate on ${exportName} returns an evaluation report and exits ${expected}`);
}
say('Native dialogs the owner answered', ...dialogs);
console.log(`\nproject: ${cwd}`);
