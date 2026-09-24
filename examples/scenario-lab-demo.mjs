import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentLab } from '../dist/experiment.js';
import { draftHash } from '../dist/lab/record.js';
import { createInputSchema } from '../dist/contracts.js';
import { createDemoRuntime, demoInput, demoTarget } from '../dist/demo.js';
import { hostGrant } from '../dist/card/commands.js';
import { situationViews } from '../dist/card/view.js';
import { libraryHash } from '../dist/scenario-library.js';
import { buildResultView } from '../dist/result-view.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** Explicit deterministic teaching adapter from the product itself. It is never evidence of model quality. */
export const demoScenarioRuntime = createDemoRuntime;

/** The draft's situations with their status now: the cards' checks read the imports they cite. */
async function situations(lab, id) {
  const context = await lab.cardContext(id);
  return { context, views: situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns }) };
}

export async function seedScenarioLab(directory, options = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).includes('.agent-lab')) throw new Error('Выберите новую папку: существующая .agent-lab не изменяется.');
  const lab = new ExperimentLab(join(directory, '.agent-lab'), demoScenarioRuntime());
  try {
    await lab.init();
    const base = demoInput();
    const seed = await lab.create(createInputSchema.parse({ ...base, mode: options.live ? 'live' : 'demo',
      settings: { ...base.settings, ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}) } }));
    await lab.waitForIdle(); const draft = await lab.get(seed.id); assert.equal(draft.phase, 'review', draft.error ?? '');
    const { views } = await situations(lab, draft.id);
    const count = status => views.filter(view => view.status === status).length;
    return { directory, runId: draft.id, evidenceKind: 'developer-authored-synthetic-fixture', next: `В Pi: /agent-lab ${draft.id}`,
      ready: count('ready'), needsOwner: count('needs_owner'), unusable: count('unusable') };
  } finally { await lab.close(); }
}

/**
 * The whole teaching path without a model: two situations prepared from the two dialogues, the owner's answer to the one
 * question, acceptance of the ready ones, a run on the deliberately broken agent, and a repeat on its fixed version.
 */
export async function verifyScenarioLab(directory) {
  const seeded = await seedScenarioLab(directory), lab = new ExperimentLab(join(directory, '.agent-lab'), demoScenarioRuntime());
  try {
    await lab.init();
    const adapterBytes = await readFile(demoTarget().path, 'utf8');
    const prepared = await situations(lab, seeded.runId);
    const imported = await readFile(join(lab.store.directory, 'imports', `${prepared.context.experiment.originalImport.id}.json`), 'utf8');
    // The owner's answer: the customer knew the number before the conversation and names it when asked.
    for (const view of prepared.views) if (view.question?.id) {
      const answer = await lab.prepareCardCommand(seeded.runId, { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: 'a' }, { via: 'cli-yes' });
      await lab.applyCardCommand(seeded.runId, answer, hostGrant(answer, 'confirmed'));
    }
    const answered = await situations(lab, seeded.runId);
    const ready = answered.views.filter(view => view.status === 'ready').map(view => view.id);
    const accepted = await lab.acceptCards(seeded.runId, libraryHash(answered.context.library), ready);
    const acceptedHash = libraryHash(accepted.library);
    await lab.start(seeded.runId, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
    const source = await lab.get(seeded.runId), sourceBytes = await readFile(join(lab.store.directory, `${source.id}.json`), 'utf8');
    // The same accepted set against a fixed version of the agent: a new draft; the finished run stays byte-identical.
    const repeat = await lab.repeat(source.id);
    const fixedDraft = await lab.updateDraft(repeat.id, draftHash(repeat), { target: demoTarget(true), targetVersion: 'demo-fixed-v1' });
    await lab.start(fixedDraft.id, { approved: true, expectedHash: draftHash(fixedDraft) }); await lab.waitForIdle();
    const fixed = await lab.get(fixedDraft.id);
    assert.equal(fixed.phase, 'results_review', fixed.error ?? '');
    assert.equal(await readFile(join(lab.store.directory, `${source.id}.json`), 'utf8'), sourceBytes);
    assert.equal(await readFile(join(lab.store.directory, 'imports', `${source.originalImport.id}.json`), 'utf8'), imported);
    assert.equal(libraryHash(await lab.store.readLibrary(accepted.library.id, acceptedHash)), acceptedHash);
    assert.equal(await readFile(demoTarget().path, 'utf8'), adapterBytes);
    const passed = record => { const { headline } = buildResultView(record); return { passed: headline.passed, decided: headline.decided }; };
    return { evidenceKind: 'deterministic-integration', directory, runId: source.id, repeatRunId: fixed.id,
      library: { dialogues: JSON.parse(imported).dialogues.length, situations: accepted.library.cards.length },
      ownerReceipt: accepted.library.receipts.some(receipt => receipt.basisHash !== undefined), sourceUnchanged: true,
      baseline: passed(source), fixed: passed(fixed), persistedLinksResolve: true };
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
    console.log('Это вымышленный учебный черновик. Подготовка не вызывала модель; в Pi ответ на вопрос ситуации 2 и запуск используют настроенную модель и сохранённый бюджет.');
  }
}
