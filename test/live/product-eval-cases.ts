import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL, type ToolName } from '../../extensions/steps.ts';
import type { Experiment } from '../../src/contracts.js';
import type { LibraryV2 } from '../../src/card/schema.js';
import { draftHash, ExperimentLab } from '../../src/experiment.js';
import { demoInput } from '../../src/demo.js';
import { libraryHash } from '../../src/scenario-library.js';
import { ExperimentStore } from '../../src/store.js';
import { refundReading, scriptedLogJudge } from '../helpers/calibration.js';
import { cardInput, cardRuntime, dialogues, policy } from '../helpers/card-prep.js';
import { acceptedDemoDraft } from '../helpers/demo-record.js';

/*
 * The product eval (quality bar 8): fixed owner phrases, each against a fixed project, with the tool a correct model
 * calls and the state it must leave. The native dialogs are answered by a scripted owner. The runner
 * (product-eval.ts) plays them against a real model; CI only checks that the cases, their projects and the scorer
 * hold together (test/product-eval.test.ts). Invented data only.
 */

/** The projects the phrases are said in. */
export type Fixture = 'folder' | 'draft' | 'run' | 'calibrated';

/** One tool call as the session saw it. */
export interface Call { name: string; args: Record<string, unknown> }

export interface EvalCase {
  id: string;
  /** What the owner says, exactly. */
  phrase: string;
  fixture: Fixture;
  /** How the owner answers a native dialog; the first answer when unset. Undefined closes the dialog. */
  pick?: (title: string, options: string[]) => string | undefined;
  /** The tool a correct model reaches — after reads only — and what its arguments must say. */
  expect: { tool: ToolName; args?: (args: Record<string, unknown>) => boolean };
  /** What the project must hold afterwards; the problem in words, or undefined. */
  state?: (cwd: string) => Promise<string | undefined>;
}

/** Tools that only read: a correct model may call them before the one the phrase asks for. */
const READS: ReadonlySet<string> = new Set([TOOL.status, TOOL.cards, TOOL.results, TOOL.explain]);

const records = (cwd: string): Promise<Experiment[]> => new ExperimentStore(join(cwd, '.agent-lab')).list();
const says = (label: string) => (_title: string, options: string[]) => options.find(option => option.includes(label));

export const CASES: readonly EvalCase[] = [
  { id: 'check-the-agent', phrase: 'Проверь моего агента в этой папке. Логи и промпт лежат тут же.', fixture: 'folder', pick: says('Не сейчас'),
    expect: { tool: TOOL.prepare, args: args => args.withoutLogs === undefined && args.demo === undefined },
    state: async cwd => (await records(cwd)).length ? 'the owner declined the consent, yet a preparation was started' : undefined },
  { id: 'show-situations', phrase: 'Покажи, какие ситуации получились.', fixture: 'draft', expect: { tool: TOOL.cards } },
  { id: 'answer-question', phrase: 'Да, клиент знал номер терминала заранее — ответь так на вопрос ситуации.', fixture: 'draft', pick: (_title, options) => options[0],
    expect: { tool: TOOL.decide, args: args => typeof args.decision === 'string' && String(args.decision).startsWith('question:') },
    state: async cwd => {
      const library = (await records(cwd))[0]?.librarySnapshot as LibraryV2 | undefined;
      return library?.receipts.some(receipt => receipt.command.kind === 'settle_claim') ? undefined : 'no answer was recorded';
    } },
  { id: 'customer-knows-nothing', phrase: 'В ситуации, где клиент называет номер терминала только по просьбе, пусть он вообще не знает номер.', fixture: 'draft', pick: says('Записать'),
    expect: { tool: TOOL.edit, args: args => (args.change as { kind?: string } | undefined)?.kind === 'fact' && (args.change as { when?: string }).when === 'unknown' },
    state: async cwd => {
      const library = (await records(cwd))[0]?.librarySnapshot as LibraryV2 | undefined;
      const late = library?.cards.find(card => card.origin.kind === 'dialogue' && card.origin.dialogueId === 'late');
      return late?.client.knows.some(fact => fact.disclosure === 'unknown') ? undefined : 'the customer of that situation still knows the number';
    } },
  { id: 'run-ready', phrase: 'Запусти готовые.', fixture: 'draft', pick: says('Запустить'),
    expect: { tool: TOOL.run, args: args => args.action === undefined || args.action === 'start' },
    state: async cwd => (await records(cwd)).some(record => record.trials.length) ? undefined : 'nothing ran' },
  { id: 'why-it-fails', phrase: 'Покажи первую ошибку: что агент сказал и какое правило нарушил?', fixture: 'run', expect: { tool: TOOL.explain } },
  { id: 'judge-is-right', phrase: 'По первой ошибке судья прав.', fixture: 'run', pick: says('Да, судья прав'),
    expect: { tool: TOOL.agree, args: args => typeof args.situation === 'number' },
    state: async cwd => (await records(cwd)).some(record => record.humanReviews.length) ? undefined : 'no mark on the judge was recorded' },
  { id: 'customer-report', phrase: 'Сохрани отчёт для заказчика.', fixture: 'run', expect: { tool: TOOL.results, args: args => args.report === true },
    state: async cwd => (await readdir(join(cwd, '.agent-lab', 'exports')).catch(() => [])).some(file => file.endsWith('.html')) ? undefined : 'no report was saved' },
  { id: 'run-again', phrase: 'Прогони этот набор ещё раз.', fixture: 'run', pick: says('Не сейчас'), expect: { tool: TOOL.run },
    state: async cwd => (await records(cwd)).some(record => record.parentRunId && !record.trials.length) ? undefined : 'no repeat of the set was prepared' },
  { id: 'logs-version', phrase: 'Логи записаны той же версией агента, что мы сейчас проверяли.', fixture: 'calibrated', pick: (_title, options) => options[0],
    expect: { tool: TOOL.decide, args: args => typeof args.decision === 'string' && String(args.decision).startsWith('logs:') },
    state: async cwd => {
      const run = (await records(cwd)).find(record => record.calibration);
      const journal = run?.originalImport && await new ExperimentStore(join(cwd, '.agent-lab')).readLogVersions(run.originalImport.id);
      return journal?.declarations.length ? undefined : 'the logs\' version was not recorded';
    } },
];

/** The project a case is said in, built from invented data with deterministic runtimes: no model, no keys. */
export async function buildFixture(fixture: Fixture): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `agent-lab-eval-${fixture}-`));
  const data = join(cwd, '.agent-lab');
  if (fixture === 'folder') {
    await writeFile(join(cwd, 'logs.jsonl'), dialogues.map(dialogue => JSON.stringify(dialogue)).join('\n') + '\n');
    await mkdir(join(cwd, 'prompts'));
    await writeFile(join(cwd, 'prompts', 'system.md'), `Ты — агент поддержки эквайринга. ${policy}\n`);
    await writeFile(join(cwd, 'agent.mjs'), 'export async function createSession() {\n  return { async respond() { return { reply: \'Уточните номер терминала.\' }; } };\n}\n');
    return cwd;
  }
  if (fixture === 'calibrated') {
    const lab = new ExperimentLab(data, { ...cardRuntime(), logJudge: scriptedLogJudge(refundReading) });
    await lab.init();
    try {
      const draft = await lab.create(cardInput());
      await lab.waitForIdle();
      const { library } = await lab.readCards(draft.id);
      const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
      await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment) });
      await lab.waitForIdle();
    } finally { await lab.close(); }
    return cwd;
  }
  const lab = new ExperimentLab(data);
  await lab.init();
  try {
    if (fixture === 'draft') { await lab.create(demoInput()); await lab.waitForIdle(); return cwd; }
    const accepted = await acceptedDemoDraft(lab);
    await lab.start(accepted.id, { approved: true, expectedHash: draftHash(accepted) });
    await lab.waitForIdle();
  } finally { await lab.close(); }
  return cwd;
}

/**
 * A case's verdict from what the model called and what the project holds: the expected tool is reached through reads
 * only, its arguments say what the phrase meant, and the state changed as it must.
 */
export async function score(item: EvalCase, calls: readonly Call[], cwd: string): Promise<{ passed: boolean; notes: string[] }> {
  const notes: string[] = [];
  const at = calls.findIndex(call => call.name === item.expect.tool);
  if (at < 0) notes.push(`${item.expect.tool} was not called (called: ${calls.map(call => call.name).join(', ') || 'nothing'})`);
  else {
    const before = calls.slice(0, at).filter(call => !READS.has(call.name));
    if (before.length) notes.push(`before ${item.expect.tool}: ${before.map(call => call.name).join(', ')}, which change the project`);
    if (item.expect.args && !calls.slice(at).some(call => call.name === item.expect.tool && item.expect.args!(call.args))) notes.push(`${item.expect.tool} was called with other arguments: ${JSON.stringify(calls[at]!.args)}`);
  }
  const problem = item.state ? await item.state(cwd) : undefined;
  if (problem) notes.push(problem);
  return { passed: !notes.length, notes };
}
