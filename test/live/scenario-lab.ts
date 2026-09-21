/** Bounded real-model smoke probe. Run only deliberately: it uses configured provider credits. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExperimentLab, draftHash } from '../../src/experiment.js';
import { libraryHash } from '../../src/scenario-library.js';
import { createInputSchema } from '../../src/contracts.js';

if (!process.argv.includes('--run')) throw new Error('Для модельного учебного запуска явно укажите --run.');
const directory = await mkdtemp(join(tmpdir(), 'scenario-lab-live-'));
const lab = new ExperimentLab(join(directory, '.agent-lab'));
try {
  await lab.init();
  const seed = await lab.create(createInputSchema.parse({
    task: 'Проверить, не запрашивает ли агент уже известный номер терминала повторно. Все данные вымышлены.', mode: 'live',
    materials: [{ name: 'Правило владельца', content: 'Если номер терминала уже указан, не запрашивайте его повторно; объясните возврат. Если номера нет, уточните номер терминала.' }],
    dialogues: [{ id: 'known', messages: [{ role: 'user', content: 'Номер терминала: 1234. Помогите с возвратом.' }, { role: 'assistant', content: 'Уточните номер терминала.' }] },
      { id: 'late', messages: [{ role: 'user', content: 'Помогите с возвратом.' }, { role: 'assistant', content: 'Уточните номер терминала.' }, { role: 'user', content: 'Номер терминала: 5678' }] }],
    target: { kind: 'module', path: resolve('examples/scenario-lab-target.mjs'), exportName: 'createSession' }, scenarioCount: 0,
    settings: { provider: process.env.AGENT_LAB_PROVIDER ?? '', model: process.env.AGENT_LAB_MODEL ?? '', repeats: 1, maxCalls: 40, maxTurns: 3, maxDurationMs: 600000, timeoutMs: 90000, userModes: ['reactive'] },
  }));
  await lab.waitForIdle();
  let record = await lab.get(seed.id);
  const ready = record.librarySnapshot?.variants.filter(v => v.quality === 'ready').map(v => v.id) ?? [];
  if (ready.length && !record.error) {
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(record.librarySnapshot!), ready);
    await lab.start(seed.id, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle(); record = await lab.get(seed.id);
  }
  const report = { evidenceKind: 'actual-configured-model-roles-with-deterministic-target', directory, id: record.id, phase: record.phase, error: record.error,
    usage: record.usage, libraryRevision: record.librarySnapshot?.revision, acceptedIds: ready,
    pending: record.librarySnapshot?.variants.filter(v => v.quality !== 'ready').map(v => ({ id: v.id, quality: v.quality, issues: v.issues })),
    trials: record.trials.map(t => ({ id: t.id, outcome: t.outcome, reason: t.reason, checkpoints: t.checkpoints })),
    limits: 'Synthetic smoke probe; no expert labels, model-quality guarantee or owner subjective acceptance. No automatic owner fact edits. A partial draft is retained for review.' };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (record.error || !record.trials.length || record.trials.some(t => t.outcome === 'invalid' || t.outcome === 'cancelled')) process.exitCode = 1;
} finally { await lab.close(); }
