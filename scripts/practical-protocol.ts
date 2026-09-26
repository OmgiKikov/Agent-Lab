/*
 * Report B — the practical-use protocol: Lab on a fixed set of real, anonymised dialogues whose rules experts labelled,
 * measured against thresholds the owner fixed BEFORE the run. It is apart from report A (scripts/semantic-proofs.ts,
 * deterministic contract checks): A says the contract holds on constructed cases; B says how Lab does on the owner's
 * conversations — false accusations, missed violations, what it got wrong about rules and cards, what it cost.
 *
 *   protocol (the owner's, fixed first: sample, strata, thresholds, when and by whom) ─┐
 *   labelled dialogues (real anonymised, or synthetic — said so) ──────────────────────┼─► DISCOVER on them ─► vs labels
 *   check runs in the data folder (VERIFY made from the analysis), optional ──────────┘   └─► VERIFY facts ─► report
 *
 * The harness never invents a threshold or a label: a protocol with an empty threshold, sample or date gives metrics and
 * no verdict, and real dialogues are refused until the protocol is fixed. The protocol's hash is in the report, so a
 * threshold changed after the run shows. Whether the owner walked the Pi path alone is the owner's observation, reported
 * as given. Real dialogues never go into the repository: they stay in the owner's data folder (0600).
 *
 *   npx tsx scripts/practical-protocol.ts --protocol P.json --dataset D.json [--data-dir DIR] [--live --provider P --model M] [--json]
 *
 * The files in examples/practical-protocol/ are a template to fill and a synthetic teaching fixture (the teaching
 * runtime, labels written by the author — not experts): a self-check of the harness, never evidence about Lab.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { normalizeText } from '../src/card/checks.js';
import { fingerprint, settingsSchema, type Experiment } from '../src/contracts.js';
import { createDemoAnalysisRuntime } from '../src/demo.js';
import { analysisView } from '../src/discover/view.js';
import type { LogAnalysis } from '../src/discover/schema.js';
import { ExperimentLab } from '../src/experiment.js';
import { buildResultView } from '../src/result-view.js';
import { importBatch } from '../src/scenario-library.js';

const STRATA = ['successful', 'failing', 'undecided', 'long', 'rule_exceptions', 'rag', 'tool_actions'] as const;
const rate = z.number().min(0).max(1).nullable();
const protocolSchema = z.object({
  format: z.literal('agent-lab-practical-protocol-1'),
  /** When and by whom the protocol was fixed: before the run, never after it. */
  fixedAt: z.iso.datetime().nullable(), fixedBy: z.string().nullable(),
  sample: z.object({ size: z.number().int().positive().nullable(), strata: z.object(Object.fromEntries(STRATA.map(name => [name, z.number().int().nonnegative().nullable()]))) }),
  thresholds: z.object({
    falseAccusationRate: rate, missedViolationRate: rate, applicabilityErrorRate: rate, ruleExtractionErrorRate: rate,
    cardErrorRate: rate, simulatorDeviationRate: rate, cardsAcceptedWithoutReworkMin: rate, reproducedOnSourceVersionMin: rate,
    maxCallsPerUsefulResult: z.number().positive().nullable(), maxCostPerUsefulResultUsd: z.number().nonnegative().nullable(),
  }),
  /** The owner's own observation of the Pi path: did they walk it without editing JSON and without the author's help. */
  piPath: z.object({ walkedWithoutEditingJson: z.boolean().nullable(), walkedWithoutAuthorsHelp: z.boolean().nullable(), notes: z.string() }),
}).passthrough();
type Protocol = z.infer<typeof protocolSchema>;

const labelSchema = z.object({ rule: z.string().min(1), verdict: z.enum(['violated', 'held', 'not_applicable', 'undecided']), labeller: z.string().min(1) });
const datasetSchema = z.object({
  format: z.literal('agent-lab-labelled-dialogues-1'),
  /** `synthetic`: invented or teaching dialogues — the report says so on every line that matters. */
  provenance: z.enum(['real-anonymised', 'synthetic']),
  /** `teaching`: the deterministic teaching runtime, which knows only the teaching dialogues and rule. */
  runtime: z.enum(['teaching', 'live']),
  task: z.string().min(1), file: z.string().min(1),
  materials: z.array(z.object({ name: z.string().min(1), content: z.string().min(1), kind: z.enum(['knowledge', 'prompt']).optional() })).min(1),
  logContract: z.object({ tools: z.array(z.string().min(1)).min(1) }).optional(),
  dialogues: z.array(z.object({ id: z.string().min(1), strata: z.array(z.enum(STRATA)).min(1), labels: z.array(labelSchema).min(1) }).passthrough()).min(1),
}).passthrough();
type Dataset = z.infer<typeof datasetSchema>;

/** Whether the owner fixed everything a verdict needs: the date, the sample and every threshold. */
function fixed(protocol: Protocol): boolean {
  return !!protocol.fixedAt && !!protocol.fixedBy && protocol.sample.size !== null && Object.values(protocol.sample.strata).every(value => value !== null)
    && Object.values(protocol.thresholds).every(value => value !== null);
}

type LabVerdict = 'fail' | 'pass' | 'unknown' | 'not_applied';
/**
 * Lab's verdict on one expert rule in one conversation: its criteria whose cited rule is that rule — the quote or the
 * sentence it stands in, compared exactly after one normalisation —, failed in any (not disputed by the owner), passed
 * in all decided, decided in none, or none applied.
 */
function labVerdict(analysis: LogAnalysis, dialogueId: string, rule: string): LabVerdict {
  const wanted = normalizeText(rule);
  const cites = new Set(analysis.requirements.filter(requirement => normalizeText(requirement.quote) === wanted || normalizeText(requirement.text) === wanted).map(requirement => requirement.id));
  const disputed = new Set(analysis.reviews.filter(review => review.verdict === 'disputed').map(review => review.key));
  const findings = analysis.findings.filter(finding => finding.dialogueId === dialogueId && analysis.scenarios.find(scenario => scenario.id === finding.scenarioId)
    ?.expectations.find(expectation => expectation.id === finding.expectationId)?.requirementIds.some(id => cites.has(id)));
  if (!findings.length) return 'not_applied';
  if (findings.some(finding => finding.result === 'fail' && !disputed.has(finding.key))) return 'fail';
  return findings.some(finding => finding.result === 'pass') ? 'pass' : 'unknown';
}

const share = (part: number, whole: number): number | null => whole ? part / whole : null;
const percent = (value: number | null): string => value === null ? 'не измерено' : `${Math.round(value * 1000) / 10}%`;

/** A check's cards accepted with no rework by the owner: no command that rewrote the card before acceptance. */
const REWORK = new Set(['edit_card', 'edit_client', 'edit_expectation', 'remove_expectation', 'remove_fact', 'set_fact', 'set_fact_disclosure', 'set_turn', 'set_references', 'fill_masked']);
function verifyFacts(runs: readonly Experiment[]) {
  const accepted = runs.flatMap(run => { const library = run.librarySnapshot; return library?.formatVersion === 2 && library.acceptance ? library.acceptance.cardIds.map(cardId => ({ run, library, cardId })) : []; })
    .filter((item, index, all) => all.findIndex(other => other.cardId === item.cardId) === index);
  const reworked = accepted.filter(({ library, cardId }) => library.receipts.some(receipt => (receipt.command as { cardId?: string }).cardId === cardId
    && (REWORK.has(receipt.command.kind) || receipt.command.kind === 'answer_question' && !!receipt.ownerWords)));
  const views = runs.filter(run => run.trials.length).map(run => ({ run, view: buildResultView(run) }));
  const counted = views.flatMap(({ view }) => view.cards.filter(card => !card.control));
  const deviated = counted.filter(card => card.reason === 'simulator_deviated' || card.reason === 'simulator_unclear').length;
  const wrong = views.reduce((sum, { view }) => sum + (view.wrongExpectations ?? 0), 0);
  const expectations = counted.reduce((sum, card) => sum + card.parts.length, 0);
  const checks = views.flatMap(({ run, view }) => view.problemCheck && !view.problemCheck.unbound && run.fromAnalysis ? [{ run, check: view.problemCheck }] : []);
  // The first run of each check is the one on the version the logs came from, as the owner runs it (the baseline).
  const baselines = checks.filter(({ run }) => !run.parentRunId);
  return {
    cards: accepted.length, acceptedWithoutRework: share(accepted.length - reworked.length, accepted.length),
    cardErrorRate: share(wrong, expectations), simulatorDeviationRate: share(deviated, counted.length),
    reproducedOnSourceVersion: share(baselines.filter(({ check }) => check.reproduced === 'yes').length, baselines.length),
    calls: runs.reduce((sum, run) => sum + run.usage.calls, 0), costUsd: runs.some(run => run.usage.costUsd === null) ? null : runs.reduce((sum, run) => sum + (run.usage.costUsd ?? 0), 0),
    reproduced: baselines.filter(({ check }) => check.reproduced === 'yes').length,
  };
}

export async function practicalReport(protocol: Protocol, protocolHash: string, dataset: Dataset, lab: ExperimentLab, settings: z.infer<typeof settingsSchema>) {
  if (dataset.provenance === 'real-anonymised' && !fixed(protocol)) {
    throw new Error('Протокол не зафиксирован: до прогона на настоящих диалогах заполните fixedAt, fixedBy, размер выборки, слои и все пороги. Ничего не запущено.');
  }
  const rows = dataset.dialogues.map(({ strata: _strata, labels: _labels, ...row }) => row);
  const started = await lab.analyze({ task: dataset.task, mode: dataset.runtime === 'teaching' ? 'demo' : 'live', materials: dataset.materials, logs: importBatch(rows), file: dataset.file, settings,
    requested: Math.min(128, dataset.dialogues.length), ...(dataset.logContract ? { logContract: { tools: dataset.logContract.tools, via: 'cli-yes' as const } } : {}) },
  { callCeiling: (await lab.analysisConsent({ task: dataset.task, mode: dataset.runtime === 'teaching' ? 'demo' : 'live', materials: dataset.materials, logs: importBatch(rows), file: dataset.file, settings, requested: Math.min(128, dataset.dialogues.length) })).callCeiling });
  await lab.waitForIdle();
  const analysis = await lab.getAnalysis(started.id);
  const view = analysisView(analysis, await lab.store.readImport(analysis.logs.importId));
  const pairs = dataset.dialogues.flatMap(dialogue => dialogue.labels.map(label => ({ dialogue, label, lab: labVerdict(analysis, dialogue.id, label.rule) })));
  const labFails = pairs.filter(pair => pair.lab === 'fail');
  const expertViolations = pairs.filter(pair => pair.label.verdict === 'violated');
  const applicable = pairs.filter(pair => pair.label.verdict !== 'undecided');
  const applicability = applicable.filter(pair => (pair.label.verdict === 'not_applicable') !== (pair.lab === 'not_applied'));
  const rules = [...new Set(pairs.map(pair => normalizeText(pair.label.rule)))];
  const extracted = rules.filter(rule => analysis.requirements.some(requirement => normalizeText(requirement.quote) === rule || normalizeText(requirement.text) === rule));
  const truePositives = labFails.filter(pair => pair.label.verdict === 'violated').length;
  const runs = (await lab.list()).filter(run => run.fromAnalysis?.analysisId === analysis.id);
  const verify = verifyFacts(runs);
  const useful = truePositives + verify.reproduced;
  const calls = analysis.budget.spent + verify.calls;
  const metrics = {
    falseAccusationRate: share(labFails.filter(pair => pair.label.verdict !== 'violated').length, labFails.length),
    missedViolationRate: share(expertViolations.filter(pair => pair.lab !== 'fail').length, expertViolations.length),
    applicabilityErrorRate: share(applicability.length, applicable.length),
    ruleExtractionErrorRate: share(rules.length - extracted.length, rules.length),
    cardErrorRate: verify.cardErrorRate, simulatorDeviationRate: verify.simulatorDeviationRate,
    cardsAcceptedWithoutReworkMin: verify.acceptedWithoutRework, reproducedOnSourceVersionMin: verify.reproducedOnSourceVersion,
    // An analysis records its calls, not their price: the cost is known only where nothing is paid (the teaching runtime).
    maxCallsPerUsefulResult: useful ? calls / useful : null, maxCostPerUsefulResultUsd: useful && dataset.runtime === 'teaching' ? 0 : null,
  };
  const missed = { saidPass: expertViolations.filter(pair => pair.lab === 'pass').length, undecided: expertViolations.filter(pair => pair.lab === 'unknown').length, notApplied: expertViolations.filter(pair => pair.lab === 'not_applied').length };
  const strata = Object.fromEntries(STRATA.map(name => [name, dataset.dialogues.filter(dialogue => dialogue.strata.includes(name)).length]));
  const verdictable = fixed(protocol) && dataset.provenance === 'real-anonymised';
  const verdicts = verdictable ? Object.fromEntries(Object.entries(metrics).map(([name, value]) => {
    const limit = protocol.thresholds[name as keyof Protocol['thresholds']]!;
    if (value === null) return [name, 'не измерено'];
    const holds = name.endsWith('Min') ? value >= limit : value <= limit;
    return [name, holds ? 'PASS' : 'FAIL'];
  })) : undefined;
  const sampleShort = protocol.sample.size !== null && dataset.dialogues.length < protocol.sample.size;
  return { protocolHash, fixed: fixed(protocol), provenance: dataset.provenance, analysisId: analysis.id, dialogues: dataset.dialogues.length, strata,
    sampleShort, labelled: pairs.length, lab: { fails: labFails.length, truePositives, missed }, metrics, verdicts, piPath: protocol.piPath,
    coverage: view.coverage, calls, verify: { cards: verify.cards, runs: runs.length } };
}

function reportText(report: Awaited<ReturnType<typeof practicalReport>>): string[] {
  const synthetic = report.provenance === 'synthetic';
  const m = report.metrics;
  return [
    synthetic ? 'ОТЧЁТ B — СИНТЕТИЧЕСКИЙ САМОКОНТРОЛЬ: учебные диалоги, разметка автора, а не экспертов. Это проверка протокола, не свидетельство о качестве Lab.' : 'Отчёт B — настоящие обезличенные диалоги с экспертной разметкой.',
    `Протокол ${report.protocolHash.slice(0, 12)} · ${report.fixed ? 'зафиксирован до прогона' : 'НЕ зафиксирован — вердиктов нет, только измерения'}.`,
    `Диалогов ${report.dialogues}${report.sampleShort ? ' — меньше выборки из протокола' : ''}; по слоям: ${Object.entries(report.strata).map(([name, count]) => `${name} ${count}`).join(', ')}.`,
    `Разбор ${report.analysisId}: выбрано ${report.coverage.picked}, разобрано ${report.coverage.processed}, правила оценены в ${report.coverage.decided}.`,
    `Ложные обвинения: ${percent(m.falseAccusationRate)} (Lab нашёл нарушение в ${report.lab.fails} из ${report.labelled} пар «разговор × правило»; разметка подтвердила ${report.lab.truePositives}).`,
    `Пропущенные нарушения: ${percent(m.missedViolationRate)} — Lab сказал «соблюдено» ${report.lab.missed.saidPass}, не решил ${report.lab.missed.undecided}, не приложил правило ${report.lab.missed.notApplied}.`,
    `Ошибки применимости правил: ${percent(m.applicabilityErrorRate)}; правила, не извлечённые из материалов: ${percent(m.ruleExtractionErrorRate)}.`,
    `Карточки (${report.verify.cards} из ${report.verify.runs} прогонов проверки): ошибки ожиданий ${percent(m.cardErrorRate)}, отклонения клиента в симуляции ${percent(m.simulatorDeviationRate)}, приняты без доработки ${percent(m.cardsAcceptedWithoutReworkMin)}, воспроизведены на исходной версии ${percent(m.reproducedOnSourceVersionMin)}.`,
    `Вызовов модели на полезный результат: ${m.maxCallsPerUsefulResult === null ? 'не измерено' : Math.round(m.maxCallsPerUsefulResult * 10) / 10} (всего вызовов ${report.calls}); стоимость — ${m.maxCostPerUsefulResultUsd === null ? 'не измерена' : `$${m.maxCostPerUsefulResultUsd}`}.`,
    `Путь в Pi без правки JSON: ${report.piPath.walkedWithoutEditingJson === null ? 'не отмечено' : report.piPath.walkedWithoutEditingJson ? 'да' : 'нет'}; без помощи автора: ${report.piPath.walkedWithoutAuthorsHelp === null ? 'не отмечено' : report.piPath.walkedWithoutAuthorsHelp ? 'да' : 'нет'} — со слов владельца, Lab этого не измеряет.`,
    ...(report.verdicts ? ['Пороги протокола:', ...Object.entries(report.verdicts).map(([name, verdict]) => `  ${name}: ${verdict}`)] : ['Вердиктов по порогам нет: ' + (synthetic ? 'синтетические данные.' : 'протокол не зафиксирован.')]),
  ];
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { protocol: { type: 'string' }, dataset: { type: 'string' }, 'data-dir': { type: 'string' }, live: { type: 'boolean' },
    provider: { type: 'string' }, model: { type: 'string' }, json: { type: 'boolean' }, out: { type: 'string' } } });
  if (!values.protocol || !values.dataset) throw new Error('Укажите --protocol протокол.json и --dataset размеченные-диалоги.json.');
  const protocolText = await readFile(values.protocol, 'utf8');
  const protocol = protocolSchema.parse(JSON.parse(protocolText));
  const dataset = datasetSchema.parse(JSON.parse(await readFile(values.dataset, 'utf8')));
  if (dataset.runtime === 'live' && (!values.live || !values.provider || !values.model)) throw new Error('Живой прогон: укажите --live --provider P --model M; модель вызывается через Pi.');
  const directory = values['data-dir'] ? resolve(values['data-dir']) : join(await mkdtemp(join(tmpdir(), 'practical-protocol-')), '.agent-lab');
  const lab = new ExperimentLab(directory, dataset.runtime === 'teaching' ? createDemoAnalysisRuntime() : undefined);
  await lab.init();
  try {
    const settings = settingsSchema.parse({ ...(values.provider ? { provider: values.provider, model: values.model } : {}), timeoutMs: 600_000 });
    const report = await practicalReport(protocol, fingerprint(JSON.parse(protocolText)), dataset, lab, settings);
    if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${reportText(report).join('\n')}\n`);
    if (report.verdicts && Object.values(report.verdicts).includes('FAIL')) process.exitCode = 1;
  } finally { await lab.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A protocol or dataset that does not hold is said in one line, and nothing ran: exit 2, as the CLI's own refusals.
  await main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
}
