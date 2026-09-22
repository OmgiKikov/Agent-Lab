/** Explicit, bounded live audit through the public product path. Run in an isolated build snapshot. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExperimentLab } from '../../src/experiment.js';
import { evaluateProductPreparation } from '../../src/generator-evaluation.js';
import { createInputSchema, fingerprint } from '../../src/contracts.js';

if (!process.argv.includes('--run')) throw new Error('Для платного модельного аудита явно укажите --run.');
const file = process.argv[process.argv.indexOf('--input') + 1];
if (!process.argv.includes('--input') || !file) throw new Error('Укажите --input с обычным JSON-входом ExperimentLab.create.');
const raw = JSON.parse(await readFile(resolve(file), 'utf8'));
if (!Number.isInteger(raw.settings?.maxCalls) || raw.settings.maxCalls < 5 || raw.settings.maxCalls > 120)
  throw new Error('Во входе нужен явный settings.maxCalls от 5 до 120.');
if (!raw.settings?.provider || !raw.settings?.model) throw new Error('Укажите provider и model во входе.');
if (raw.confirmedHypothesis) throw new Error('Этот аудит измеряет подготовку библиотеки из материалов и диалогов.');
const input = createInputSchema.parse({ ...raw, mode: 'live' });
const directory = await mkdtemp(join(tmpdir(), 'generator-product-audit-'));
const lab = new ExperimentLab(join(directory, '.agent-lab'));
const files = ['pi.ts', 'prompts.ts', 'scenario-preparation.ts', 'scenario-work.ts', 'scenario-library.ts', 'scenario-contracts.ts', 'generator-evidence.ts'];
const code = Object.fromEntries(await Promise.all(files.map(async name => [name, fingerprint(await readFile(new URL(`../../src/${name}`, import.meta.url), 'utf8'))])));
try {
  await lab.init();
  const report = await evaluateProductPreparation(lab, input, { code, node: process.version, evidenceKind: 'live-product-preparation', independentAudit: false });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, id: report.id, experimentId: report.experimentId, usage: report.usage, readiness: report.readiness, attempts: report.attempts, error: report.error }, null, 2));
  if (report.error || report.preparation?.status !== 'complete') process.exitCode = 1;
} finally { await lab.close(); }
