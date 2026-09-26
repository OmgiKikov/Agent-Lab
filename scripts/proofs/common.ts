/*
 * What every deterministic proof shares: one claim line each (PASS or FAIL), temporary data folders removed at the end,
 * the teaching agent in its three versions, and the owner's path through a check of a problem — prepared, the teaching
 * owner's answers given, the ready situations accepted, run and repeated with another version. No model, no key.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostGrant } from '../../src/card/commands.js';
import { situationViews } from '../../src/card/view.js';
import { createInputSchema, settingsSchema, type Experiment } from '../../src/contracts.js';
import { demoTarget } from '../../src/demo.js';
import type { LogAnalysis } from '../../src/discover/schema.js';
import { subsetImport } from '../../src/discover/verify.js';
import type { ExperimentLab } from '../../src/experiment.js';
import { draftHash } from '../../src/lab/record.js';
import { libraryHash } from '../../src/scenario-library.js';

let failed = 0;
const folders: string[] = [];

/** One claim of a proof: printed as PASS or FAIL with what it saw. */
export const claim = (proof: string, ok: boolean, text: string): void => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${proof}  ${text}`); };
export const failures = (): number => failed;
/** A fresh data folder for one proof, removed at the end. */
export async function folder(name: string): Promise<string> { const dir = await mkdtemp(join(tmpdir(), `semantic-proofs-${name}-`)); folders.push(dir); return dir; }
export async function cleanUp(): Promise<void> { await Promise.all(folders.map(dir => rm(dir, { recursive: true, force: true }))); }

/** The teaching agent in one of its versions: the baseline asks again for a number it has, the fixed one does not, the regressed one never asks. */
export type Version = 'createSession' | 'createFixedSession' | 'createRegressedSession';
export const version = (exportName: Version) => ({ ...demoTarget(), exportName });

/** A check of the problem, prepared from `dialogueIds`, its questions answered «a» as the teaching owner does, and its ready situations accepted. */
export async function preparedCheck(lab: ExperimentLab, analysis: LogAnalysis, link: Experiment['fromAnalysis'], dialogueIds: string[]): Promise<Experiment> {
  const batch = await lab.store.readImport(analysis.logs.importId);
  const draft = await lab.create(createInputSchema.parse({ task: analysis.task, mode: 'demo', materials: analysis.sources.map(({ name, content }) => ({ name, content })),
    scenarioCount: 0, target: version('createSession'), originalImport: subsetImport(batch, dialogueIds), fromAnalysis: link,
    settings: settingsSchema.parse({ repeats: 1, maxTurns: 6, maxCalls: 200, userModes: ['reactive'] }) }), { situations: dialogueIds.length });
  await lab.waitForIdle();
  let context = await lab.cardContext(draft.id);
  for (const view of situationViews(context.experiment, { evidence: context.evidence, maxTurns: 6 })) if (view.question?.id) {
    const answer = await lab.prepareCardCommand(draft.id, { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: 'a' }, { via: 'cli-yes' });
    await lab.applyCardCommand(draft.id, answer, hostGrant(answer, 'confirmed'));
  }
  context = await lab.cardContext(draft.id);
  const ready = situationViews(context.experiment, { evidence: context.evidence, maxTurns: 6 }).filter(view => view.status === 'ready');
  await lab.acceptCards(draft.id, libraryHash(context.library), ready.map(view => view.id));
  return lab.get(draft.id);
}

/** The accepted draft run to its end, as the owner's one dialog starts it. */
export async function run(lab: ExperimentLab, id: string): Promise<Experiment> {
  const draft = await lab.get(id);
  await lab.start(id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) });
  await lab.waitForIdle();
  return lab.get(id);
}

/** A repeat of `of` — the same accepted situations — against another version of the teaching agent. */
export async function repeatWith(lab: ExperimentLab, of: Experiment, exportName: Version): Promise<Experiment> {
  const fresh = await lab.repeat(of.id);
  const updated = await lab.updateDraft(fresh.id, draftHash(fresh), { target: version(exportName) });
  return run(lab, updated.id);
}
