import { readFileSync } from 'node:fs';
import { chmod, cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage, experimentSchema, type Experiment, type Runtime } from '../../src/contracts.js';
import { createDemoRuntime, demoTarget } from '../../src/demo.js';
import { libraryV1Schema, type LibraryV1 } from '../../src/scenario-contracts.js';
import { ExperimentLab } from '../../src/experiment.js';
import { assessRepeated } from '../../src/judge.js';

/*
 * test/fixtures/library-v1: a finished live run of an accepted first-format library (business groups of
 * variants, required checkpoints plus the `library_required` rubric), written by the code that made such
 * runs (commit 125b0c1) from the teaching demo's two invented refund dialogues: the teaching agent over
 * HTTP, the demo's deterministic controller and checkpoint judge, and the real judge path with a scripted
 * offline provider. The second vote on one dialogue disagrees, so one verdict is a judge split.
 *   run.json, run.trace.jsonl, run.judge/  the stored run: record, journal, judge audits
 *   library.json                           the accepted library file as the store wrote it
 * Old runs must open, re-assess and repeat without migration or recompilation; these files hold the
 * product to that, whatever the card format and its compiler become.
 */
const FIXTURE = new URL('../fixtures/library-v1/', import.meta.url);

export async function libraryV1File(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, FIXTURE), 'utf8'));
}

type JudgeData = { scenario: { metrics: { id: string }[] }; trial: { events: { seq: number; type: string; content?: string }[] } };

/**
 * The fixture's judge for new judgments, a deterministic stand-in for the model: a vote fails when the
 * agent asked again for the terminal number the customer had already given, and passes otherwise.
 */
function libraryV1Judge(data: JudgeData): string {
  let told = false;
  let repeated: JudgeData['trial']['events'][number] | undefined;
  for (const event of data.trial.events) {
    if (event.type === 'user' && event.content?.includes('Номер терминала:')) told = true;
    if (event.type === 'assistant' && told && event.content?.includes('Уточните номер терминала')) repeated ??= event;
  }
  const cited = repeated ?? data.trial.events.filter(event => event.type === 'assistant').at(-1)!;
  return JSON.stringify({ assessments: data.scenario.metrics.map(metric => ({
    metricId: metric.id, passCondition: repeated ? 'not_met' : 'met', failCondition: repeated ? 'met' : 'not_met',
    rationale: repeated ? 'Агент повторно запросил номер, который клиент уже назвал.' : 'Номер запрошен один раз, возврат объяснён.',
    evidence: [cited.seq], citations: [{ seq: cited.seq, quote: cited.content }],
  })) });
}

/** The demo's controller and checkpoint judge with the real two-vote judge protocol over the stand-in above. */
export function libraryV1Runtime(): Runtime {
  return { ...createDemoRuntime(),
    assess: (input, ctx) => assessRepeated(input, { provider: 'fixture', id: 'library-v1-judge' }, ctx,
      async (_prompt, data) => libraryV1Judge(JSON.parse(data) as JudgeData)) };
}

/** The fixture run in a fresh writer store, with its journal and judge audits. The caller owns cleanup. */
export async function libraryV1Run(runtime: Runtime = libraryV1Runtime()) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-library-v1-'));
  const lab = new ExperimentLab(join(directory, 'runs'), runtime);
  await lab.init();
  const record = experimentSchema.parse(await libraryV1File('run.json'));
  await lab.store.save(record);
  const trace = join(lab.store.directory, `${record.id}.trace.jsonl`);
  await cp(new URL('run.trace.jsonl', FIXTURE), trace);
  await chmod(trace, 0o600);
  await cp(new URL('run.judge/', FIXTURE), join(lab.store.directory, `${record.id}.judge`), { recursive: true });
  return { lab, directory, record: await lab.get(record.id) };
}

/** The fixture run as the store wrote it: its cards are the first format's compiled variants, as they were accepted. */
export function storedRunV1(): Experiment {
  return experimentSchema.parse(JSON.parse(readFileSync(new URL('run.json', FIXTURE), 'utf8')));
}

/** The accepted first-format library of the fixture, as the store wrote it. */
export function storedLibraryV1(): LibraryV1 {
  return libraryV1Schema.parse(JSON.parse(readFileSync(new URL('library.json', FIXTURE), 'utf8')));
}

/**
 * A first-format draft as its preparation left it, never accepted or run: the fixture run's task, materials, rules and
 * import with its library before acceptance, against the teaching agent. `data`: the store's directory (a fresh one by
 * default). The caller owns cleanup.
 */
export async function firstFormatDraft(options: { runtime?: Runtime; data?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-first-format-draft-'));
  const lab = new ExperimentLab(options.data ?? join(directory, 'runs'), options.runtime ?? libraryV1Runtime());
  await lab.init();
  const run = experimentSchema.parse(await libraryV1File('run.json'));
  const library = storedLibraryV1();
  delete library.acceptance;
  for (const variant of library.variants) variant.ownerDecision = 'pending';
  const draft: Experiment = { ...run, id: 'first_format_draft', phase: 'review', message: 'Библиотека подготовлена.', target: demoTarget(), librarySnapshot: library,
    scenarios: [], acceptedTests: [], trials: [], comparisons: [], iterations: [], humanReviews: [], usage: emptyUsage(), reviewedAt: null, reviewMode: null, manifestHash: null, error: null };
  delete draft.acceptedDraftHash; delete draft.targetRelease;
  await lab.store.save(experimentSchema.parse(draft));
  return { lab, directory, record: await lab.get(draft.id) };
}