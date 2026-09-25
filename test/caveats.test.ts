import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCaveat, CAUSE_FAILURES, caveatLines, caveatSchema, caveatText, type Caveat } from '../src/caveats.js';
import { experimentSchema, type Experiment } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';

/*
 * What a record's result does not prove (caveats.ts): notes typed by their code, each once, about the work done on
 * that very record, read in the owner's words; the strings older records keep still read. Invented data.
 */

const EVERY: Caveat[] = [{ code: 'demo' }, { code: 'automated_review' }, { code: 'expectations_review' }, { code: 'scripted_skipped', situations: 2 },
  { code: 'state_unconfirmed' }, ...CAUSE_FAILURES.map((cause): Caveat => ({ code: 'causes_unnamed', cause })), { code: 'reassessment' }, { code: 'code_only' },
  { code: 'usage_incomplete' }, { code: 'judge_fallback', from: 'openrouter/openai/gpt-5.6-sol', to: 'giga/GigaChat-3-Ultra' }];

test('every note is typed and read in the owner\'s words; a note of the same kind is kept once', () => {
  for (const caveat of EVERY) {
    assert.deepEqual(caveatSchema.parse(caveat), caveat);
    const text = caveatText(caveat);
    assert.ok(/[А-Яа-яЁё]/.test(text) && text.endsWith('.'), `${caveat.code}: ${text}`);
    assert.ok(!text.includes(caveat.code), 'never the code itself on a screen');
  }
  assert.equal(new Set(EVERY.map(caveatText)).size, EVERY.length, 'each note says something of its own');
  assert.equal(caveatText({ code: 'scripted_skipped', situations: 1 }), 'Без сценария — 1 ситуация: в сценарном режиме их не запускали.');
  const record: Pick<Experiment, 'caveats' | 'limitations'> = { limitations: [] };
  addCaveat(record, { code: 'expectations_review' });
  addCaveat(record, { code: 'scripted_skipped', situations: 1 });
  addCaveat(record, { code: 'expectations_review' });
  addCaveat(record, { code: 'scripted_skipped', situations: 3 });
  assert.deepEqual(record.caveats, [{ code: 'expectations_review' }, { code: 'scripted_skipped', situations: 3 }], 'once each, the newer count kept');
});

test('an old record\'s notes still read: the ones written for the owner as they are, the English diagnostics never', async () => {
  const stored = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/legacy-demo-draft.json', import.meta.url), 'utf8')));
  assert.equal(stored.caveats, undefined, 'a record written before typed notes has none, and parses as it was');
  const old = { ...stored, limitations: [...stored.limitations, 'Процесс остановился между сохранениями: число вызовов и токенов может быть неполным.'] };
  assert.deepEqual(caveatLines(old), ['Процесс остановился между сохранениями: число вызовов и токенов может быть неполным.']);
  assert.deepEqual(caveatLines({ ...old, caveats: [{ code: 'usage_incomplete' }] })[0], 'Процесс останавливался между сохранениями: число вызовов модели и расход могут быть неполными.',
    'typed notes first, then the older ones');
});

test('every note is about the work of its own record: repeats never pile up notes, and a repeat of a re-assessment never says the agent did not run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-caveats-'));
  const lab = new ExperimentLab(directory, cardRuntime());
  try {
    await lab.init();
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    const accepted = (await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id))).experiment;
    const run = async (record: Experiment) => {
      await lab.start(record.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(record) });
      await lab.waitForIdle();
      return lab.get(record.id);
    };
    let last = await run(accepted);
    for (let repeat = 0; repeat < 2; repeat++) {
      const next = await lab.repeat(last.id);
      assert.equal(next.caveats, undefined, 'a fresh draft starts without the run\'s notes');
      last = await run(next);
    }
    assert.deepEqual([last.phase, last.caveats], ['results_review', [{ code: 'expectations_review' }]], 'the third run says it once');
    assert.deepEqual(last.limitations, []);

    const reassessed = await lab.reassess(last.id, { codeOnly: true });
    await lab.waitForIdle();
    assert.deepEqual((await lab.get(reassessed.id)).caveats, [{ code: 'reassessment' }, { code: 'code_only' }]);
    const again = await lab.repeat(reassessed.id);
    assert.equal(again.caveats, undefined, 'the repeat of a re-assessment runs the agent: nothing says it did not');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
