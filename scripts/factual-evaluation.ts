/**
 * Live calibration of the article-only path. Fixtures have authored labels; a real replay has NO quality label.
 * No network without --live. Outputs containing real data stay in a private local data folder, never the repository.
 * npx tsx scripts/factual-evaluation.ts --live --provider openai-codex --model gpt-5.6-sol --max-calls 25 [--real-analysis PATH]
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { settingsSchema } from '../src/contracts.js';
import { analysisSchema } from '../src/discover/schema.js';
import { analysisView } from '../src/discover/view.js';
import { subsetImport } from '../src/discover/verify.js';
import { ExperimentLab } from '../src/experiment.js';
import { Stopped } from '../src/errors.js';
import { createPiRuntime } from '../src/pi.js';
import type { CallContext, Runtime } from '../src/runtime.js';
import { importBatch } from '../src/scenario-library.js';
import { importBatchSchema } from '../src/scenario-contracts.js';
import type { AnalyzeInput } from '../src/lab/discover.js';

const correct = 'Возврат зачисляется в течение трёх рабочих дней.';
const wrong = 'Возврат зачисляется в течение десяти рабочих дней.';
type Expected = 'supported' | 'contradicted' | 'unknown' | 'no_claims';
const cases: { id: string; question: string; reply: string; source: string; expected: Expected }[] = [
  { id: 'correct_fact', question: 'Когда придут деньги за возврат?', reply: correct, source: correct, expected: 'supported' },
  { id: 'wrong_deadline', question: 'Когда придут деньги за возврат?', reply: wrong, source: correct, expected: 'contradicted' },
  { id: 'operator_sms', question: 'Где узнать мой тариф?', reply: 'С этим поможет оператор. Передам ему ваш вопрос.', source: 'Сотрудник должен предложить отправить СМС с инструкцией. Отправь СМС через внутреннюю систему.', expected: 'no_claims' },
  { id: 'missing_reference', question: 'Какая комиссия за возврат?', reply: 'Комиссия за возврат составляет два процента.', source: correct, expected: 'unknown' },
  { id: 'masked_value', question: 'Когда придут деньги за возврат?', reply: 'Возврат зачисляется в течение # рабочих дней.', source: correct, expected: 'unknown' },
  { id: 'customer_misattribution', question: 'Я слышал, что возврат идёт десять дней. Это так?', reply: correct, source: correct, expected: 'supported' },
  { id: 'omitted_employee_steps', question: 'Где посмотреть тариф?', reply: 'Тариф можно посмотреть в СберБизнес.', source: 'Тариф можно посмотреть в СберБизнес. Сотрудник должен предложить СМС. Предупреди, что собственное оборудование может не отображаться.', expected: 'supported' },
  { id: 'different_product', question: 'Когда придёт возврат по банковскому переводу?', reply: 'По банковскому переводу возврат приходит в течение десяти рабочих дней.', source: 'Для покупок по банковской карте возврат зачисляется в течение трёх рабочих дней.', expected: 'unknown' },
  { id: 'historical_terms', question: 'Сегодня 1 июня 2026 года. Какая комиссия сейчас?', reply: 'Сейчас комиссия составляет один процент.', source: 'С 1 января 2027 года комиссия составляет два процента.', expected: 'unknown' },
  { id: 'wrong_fee', question: 'Какая комиссия по тарифу Альфа?', reply: 'Комиссия по тарифу Альфа составляет один процент.', source: 'Комиссия по тарифу Альфа составляет два процента.', expected: 'contradicted' },
  { id: 'alternative_navigation', question: 'Где оформить заявку?', reply: 'Откройте меню «Заявки» и нажмите «Новая заявка».', source: 'Для оформления заявки откройте раздел «Услуги» и нажмите «Подключить».', expected: 'unknown' },
  { id: 'unestablished_prerequisite', question: 'Как включить QR на моём терминале?', reply: 'Подайте отдельное заявление на QR в личном кабинете.', source: 'Если клиент подключает новый терминал, QR-код автоматически отображается на экране оборудования.', expected: 'unknown' },
];

const { values } = parseArgs({ options: { live: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' },
  'max-calls': { type: 'string' }, 'real-analysis': { type: 'string' }, out: { type: 'string' } } });
if (!values.live) {
  console.log(`Только план: ${cases.length} вымышленных случаев с заранее заданными ответами. Для вызова модели нужны --live, --provider, --model и --max-calls.`);
  process.exit(0);
}
const ceiling = Number(values['max-calls']);
if (!values.provider || !values.model || !Number.isInteger(ceiling) || ceiling < 1) throw new Error('Укажите модель и положительный целый предел --max-calls.');
const settings = settingsSchema.parse({ provider: values.provider, model: values.model,
  judge: { provider: values.provider, model: values.model }, timeoutMs: 120000 });
const underlying = await createPiRuntime(settings);
let calls = 0;
const bounded = (ctx: CallContext): CallContext => ({ ...ctx, beforeCall() {
  if (calls >= ceiling) throw new Stopped('budget');
  ctx.beforeCall(); calls++;
  console.log(`Обращение к модели ${calls}/${ceiling}`);
} });
const runtime: Runtime = { ...underlying,
  factChecker: { ...underlying.factChecker!, check: (request, ctx) => underlying.factChecker!.check(request, bounded(ctx)) },
  selectSources: (request, ctx) => underlying.selectSources!(request, bounded(ctx)),
};
const directory = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), 'agent-lab-factual-eval-'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const results: { case: string; expected: Expected; pass: boolean; status: string; facts: ReturnType<typeof analysisView>['facts']; calls: number }[] = [];
async function run(name: string, input: AnalyzeInput) {
  const lab = new ExperimentLab(join(directory, name, '.agent-lab'), runtime);
  await lab.init();
  try {
    const consent = await lab.analysisConsent(input);
    const started = await lab.analyze(input, { callCeiling: Math.min(consent.callCeiling, ceiling - calls) });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    return { analysis, view: analysisView(analysis, input.logs) };
  } finally { await lab.close(); }
}

for (const item of cases) {
  if (calls >= ceiling) break;
  console.log(`Проверка ${results.length + 1}/${cases.length}: ${item.id}`);
  const before = calls;
  const result = await run(item.id, { task: 'Проверить только фактические утверждения в ответах по статье', mode: 'live', file: 'вымышленный случай',
    materials: [{ name: 'Справочная статья', content: item.source, kind: 'knowledge' }],
    logs: importBatch([{ id: item.id, messages: [{ role: 'user', content: item.question }, { role: 'assistant', content: item.reply }] }]), settings, requested: 1 });
  const facts = result.view.facts!;
  const pass = result.analysis.status === 'done' && facts.completed === 1 && (item.expected === 'contradicted' ? facts.contradicted > 0
    : facts.contradicted === 0 && (item.expected === 'supported' ? facts.supported > 0 : item.expected === 'unknown' ? facts.unknown > 0 : facts.noClaims === 1));
  results.push({ case: item.id, expected: item.expected, pass, status: result.analysis.status, facts, calls: calls - before });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${item.id}: ${JSON.stringify(facts)}`);
}
let real: unknown;
let realIncomplete = false;
if (values['real-analysis'] && calls < ceiling) {
  const path = resolve(values['real-analysis']);
  const earlier = analysisSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const batch = importBatchSchema.parse(JSON.parse(await readFile(join(dirname(dirname(path)), 'imports', `${earlier.logs.importId}.json`), 'utf8')));
  const ids = earlier.selection.picked.slice(0, 3);
  console.log(`Реальная проверка: те же ${ids.length} разговора. Экспертных меток нет; процент точности не вычисляется.`);
  const before = calls, start = performance.now();
  const result = await run('real', { task: earlier.task, mode: 'live', file: earlier.logs.file,
    materials: earlier.sources.map(({ name, content, kind }) => ({ name, content, kind })),
    logs: subsetImport(batch, ids), settings, requested: ids.length });
  real = { provenance: 'real-unlabelled', analysisId: result.analysis.id, status: result.analysis.status, facts: result.view.facts,
    calls: calls - before, seconds: Math.round((performance.now() - start) / 1000), selected: result.analysis.selection.picked.length };
  console.log(`Результат реальной пробы: ${JSON.stringify(real)}`);
  realIncomplete = result.analysis.status !== 'done' || (result.view.facts?.failed ?? 0) > 0;
}
const report = { protocol: 'factual-eval-v1', model: settings.model, provider: settings.provider,
  synthetic: { total: cases.length, completed: results.length, passed: results.filter(result => result.pass).length, results }, real, calls, ceiling };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(`Отчёт сохранён локально: ${join(directory, 'report.json')}`);
if (results.length !== cases.length || results.some(result => !result.pass) || realIncomplete) process.exitCode = 1;
