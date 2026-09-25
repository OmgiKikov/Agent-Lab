import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { comparisonFeed, failureFeed } from '../extensions/conversation.ts';
import { cardPlan } from '../extensions/launch.ts';
import { queueDraft } from '../extensions/decisions.ts';
import { feedFor } from '../extensions/render/feed.ts';
import { TOOL } from '../extensions/steps.ts';
import { judgedScreen } from '../extensions/workspace-screens.ts';
import { REVIEW_CALLS } from '../src/card/budget.js';
import { calibrationCaveats, disagreementText, hintText } from '../src/card/calibration-view.js';
import type { DialogueProposal } from '../src/card/proposal.js';
import { ruleBarText } from '../src/card/rulebook.js';
import { layoutRows, type SituationView } from '../src/card/view.js';
import { caveatText } from '../src/caveats.js';
import { compareRuns, VERSION_UNKNOWN_NOTE, type RunComparison } from '../src/comparison.js';
import type { Experiment, Trial } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { decisions } from '../src/inbox.js';
import { markdownReport, htmlReport } from '../src/report.js';
import {
  caveatRows, chatBlock, comparisonRows, conversationRows, judgeQuestionText, MAX_WIDTH, plainText, resultScreen, trialTurns, whenText, type ResultRow,
} from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import type { Runtime } from '../src/runtime.js';
import { safeLine } from '../src/text.js';
import { cardInput, cardRuntime, proposals, type Received } from './helpers/card-prep.js';
import { calibrated, loggedAttempt, loggedRun, logReceipt, logReview } from './helpers/calibration.js';
import { output, registered } from './helpers/pi-session.js';

/*
 * The result's surfaces say one thing in one set of words: the chat, the board, the command line and the customer report
 * lay out rows made in result-text.ts (and card/calibration-view.ts), each for its reader — the owner spoken to in Pi, the
 * owner spoken about on the page sent on. Invented data; no model is called.
 */

const unwrapped = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
/** A Markdown page read as plain words: its escapes dropped. */
const plainPage = (markdown: string) => unwrapped(markdown).replaceAll('\\', '');

/* ───────────────────────────── the chat's explanation of a situation that disagrees with production ───────────────────────────── */

test('a situation that failed by another repeat is explained with the attempt the calibration compared beside its log', { timeout: 60000 }, async t => {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const base = calibrated(run, number => number === 1 ? ['pass', 'fail'] : ['pass', 'pass']);
  const [first, second] = run.scenarios;
  // The first repeat of №1 explained the refund, its second did not: the number reads the second, the calibration the first.
  const explained = (trial: Trial): Trial => ({ ...trial, events: trial.events.map(event => event.type === 'assistant' ? { ...event, text: 'Возврат возможен. Подайте заявление.' } : event) });
  const record: Experiment = { ...base, settings: { ...base.settings, repeats: 2 }, trials: [explained(base.trials[0]!), base.trials[1]!,
    loggedAttempt('attempt_1_2', first!, { e1: 'pass', e2: 'fail' }, 1), loggedAttempt('attempt_2_2', second!, { e1: 'pass', e2: 'pass' }, 1)] };
  const view = buildResultView(record);
  const [differs] = view.calibration!.disagreements;
  assert.deepEqual([view.failures.map(failure => failure.trialId), differs!.trialIds, differs!.attempt], [['attempt_1_2'], ['attempt_1'], 1]);
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-explain-compared-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const lab = new ExperimentLab(join(cwd, '.agent-lab'));
  await lab.init();
  try { await lab.store.save(record); await lab.store.writeImport(run.batch); } finally { await lab.close(); }
  const { tools, shutdown } = registered();
  t.after(shutdown);
  const ctx = { cwd, mode: 'tui', hasUI: true, ui: {} } as unknown as ExtensionContext;
  const result = await tools.get(TOOL.explain)!.execute('explain', { situation: 1 }, undefined, undefined, ctx);
  const feed = feedFor(result.details as Parameters<typeof feedFor>[0])!;
  const rows = feed.rows.map(row => row.text), more = (feed.more ?? []).map(row => row.text);
  assert.match(rows[0]!, /^✗ 1 {2}Возврат оплаты — номер по просьбе/, 'the failure is its own attempt');
  assert.equal(rows.at(-1), 'С продом не совпало (попытка 1): Б · объяснить, как оформить возврат — в синтетике: выполнил, в проде: нет', 'the repeat compared is named');
  const compared = more.indexOf('Разговор в прогоне · попытка 1');
  assert.ok(compared > 0, more.join('\n'));
  assert.ok(more.slice(compared).some(text => text === 'Агент    Возврат возможен. Подайте заявление.'), 'the compared attempt\'s own words stand beside the log');
  assert.ok(more.includes('Разговор из логов') && more.includes('Клиент   Спасибо!'), 'and the logged conversation');
  const answer = output(result);
  assert.equal(answer.said, '«Уточните номер терминала.»', 'the reply the judge pointed at, in the words every surface uses');
  assert.deepEqual([answer.production.attempt, answer.production.comparedConversation.at(-1)], [1, { who: 'агент', text: 'Возврат возможен. Подайте заявление.' }]);
});

/* ───────────────────────────── one wording of two runs compared ───────────────────────────── */

const comparison = (overrides: Partial<RunComparison> = {}): RunComparison => ({ headline: 'Исправлено 1, сломалось 1, без изменений 0 из 2 ситуаций.', comparable: true, pairs: [],
  coverage: { plannedPairs: 2, validPairs: 2, excludedPairs: 0, missingBefore: 0, missingAfter: 0, invalidBefore: 0, invalidAfter: 0 },
  cards: { shared: 2, onlyBefore: [], onlyAfter: [] }, fixed: [{ scenarioId: 'a', title: 'Возврат — номер назван сразу', tier: 'regression' }],
  regressed: [{ scenarioId: 'b', title: 'Статус заявки', tier: 'regression' }], incomparable: [], unchanged: { passing: 0, failing: 0 }, ungraded: 0, includesRubrics: true,
  notes: ['Сравнение по 2 ситуациям: разница может быть случайной, повторы новых ситуаций не добавляют.', VERSION_UNKNOWN_NOTE], versionUnknown: true, ...overrides });
const before = { createdAt: '2026-09-19T16:02:00.000Z', targetVersion: 'baseline-v1' };

test('two runs compared are said once: the owner gets every note and the next step, the page for others what changed and on what it stands', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');
  const owner = comparisonRows(comparison(), before, { now });
  assert.deepEqual(owner.map(row => [row.role, row.text]), [
    ['item', `Сравнение с прогоном ${whenText(before.createdAt, now)} — версия baseline-v1. Исправлено 1, сломалось 1, без изменений 0 из 2 ситуаций.`],
    ['muted', 'Сравнимо 2 из 2 разговоров · исправлено 1 · сломалось 1 · без изменений 0'],
    ['failed', 'Сломалось: Статус заявки'], ['good', 'Исправлено: Возврат — номер назван сразу'],
    ['heading', 'Оговорки'], ['muted', 'Сравнение по 2 ситуациям: разница может быть случайной, повторы новых ситуаций не добавляют.'], ['muted', VERSION_UNKNOWN_NOTE],
    ['next:first', 'Дальше: назовите версию агента при запуске — тогда повтор покажет, что изменила новая версия.']]);
  const others = comparisonRows(comparison(), before, { reader: 'others' });
  assert.deepEqual(others.map(row => row.text), ['Сравнение с прошлым прогоном — версия baseline-v1. Исправлено 1, сломалось 1, без изменений 0 из 2 ситуаций.',
    'Сравнимо 2 из 2 разговоров · исправлено 1 · сломалось 1 · без изменений 0', 'Сломалось: Статус заявки', 'Исправлено: Возврат — номер назван сразу', VERSION_UNKNOWN_NOTE],
  'the unknown version is said, never asked for, and nothing else addresses the owner');
  assert.ok(!VERSION_UNKNOWN_NOTE.includes('Назовите'), 'the note itself asks nothing');
  assert.equal(comparisonRows(comparison(), before, { reader: 'others', selected: true })[0]!.text.startsWith('База выбрана вручную — версия baseline-v1.'), true);
  // Runs that could not be compared at all: each situation once, the reason in the notes below it.
  const apart = comparisonRows(comparison({ comparable: false, versionUnknown: undefined, notes: ['Выбран один и тот же прогон.'], fixed: [], regressed: [], headline: 'Прогоны несравнимы (4 пары попыток): исправления и поломки не подсчитаны.',
    incomparable: [0, 1].flatMap(repeat => ['Статус заявки', 'Возврат'].map(title => ({ scenarioId: title, title, tier: 'regression' as const, userMode: 'reactive' as const, repeat, reason: 'Выбран один и тот же прогон.' }))) }), before);
  assert.deepEqual(apart.filter(row => row.text.startsWith('Несравнимо')).map(row => row.text), ['Несравнимо: Статус заявки', 'Несравнимо: Возврат']);

  // The chat lays out the same rows: the answer and the counts, everything else on expand.
  const feed = comparisonFeed(comparison(), before, { now });
  assert.deepEqual([...feed.rows, ...feed.more ?? []].map(row => row.text).filter(Boolean), owner.map(row => row.text));
  // The customer report: the same words for others, and none of the owner's steps.
  const report = markdownReport({ record: comparisonRecord(), view: buildResultView(comparisonRecord()), warnings: [], traceJournal: '', comparison: comparison(), before: { ...comparisonRecord(), ...before } });
  for (const text of ['## Было → стало', 'Сломалось: Статус заявки', 'Исправлено: Возврат — номер назван сразу', VERSION_UNKNOWN_NOTE]) assert.ok(plainPage(report).includes(text), text);
  assert.equal(report.includes('Назовите'), false);
  assert.equal(report.includes('назовите версию'), false);
});

/** A finished run the comparison tests hang their report on. */
function comparisonRecord(): Experiment {
  const run = loggedRun(1, () => ({ e1: 'pass', e2: 'pass' }));
  return run.record;
}

test('the command line\'s diff prints the comparison rows the chat shows', { timeout: 60000 }, async t => {
  const record = comparisonRecord();
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-diff-rows-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(directory);
  await lab.init();
  try { await lab.store.save(record); } finally { await lab.close(); }
  const env = { ...process.env };
  delete env.AGENT_LAB_SESSION;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'diff', '--before', record.id, '--after', record.id, '--data-dir', directory], { env });
  let stdout = '';
  child.stdout.on('data', data => { stdout += data; });
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 2, 'a run against itself is not comparable');
  const rows = comparisonRows(compareRuns(record, record), record).map(row => ({ ...row, text: safeLine(row.text), ...(row.parts ? { parts: row.parts.map(safeLine) } : {}) }));
  assert.equal(stdout, `${plainText(rows, MAX_WIDTH)}\n`);
  assert.match(stdout, /Несравнимо: /);
});

/* ───────────────────────────── the judge's decisions on the board and in the chat ───────────────────────────── */

test('a pass drawn for a double-check shows the conversation and the question in result-text.ts\'s words; a failure quotes only what the judge pointed at', () => {
  const run = loggedRun(2, number => ({ e1: 'pass', e2: number === 2 ? 'fail' : 'pass' }));
  const record = run.record;
  const view = buildResultView(record);
  const pass = record.trials[0]!;
  const screen = judgedScreen({ record, view }, pass.id, undefined, undefined, 100).body.map(line => line.map(part => part.text).join('')).join('\n');
  const conversation = plainText(conversationRows(trialTurns(pass)), 100).split('\n');
  for (const line of conversation) assert.ok(screen.includes(line.trimEnd()), `${line}\n${screen}`);
  assert.ok(screen.includes(`${judgeQuestionText('pass')}   1 да · 2 нет · 3 не знаю`), screen);
  // A reply the judge never pointed at is no evidence of the failure: the chat says why nothing is quoted, as every surface does.
  const failure = view.failures[0]!;
  const uncited = { ...view, failures: [{ ...failure, said: null, unsaid: 'not_cited' as const }] };
  const rows = failureFeed(record, uncited, 0)!.rows.map(row => row.text);
  assert.equal(rows[1], `Ожидалось: ${failure.expected ?? 'не записано в ситуации'} · Агент: судья не указал реплику`);
  const rule = failure.violated ?? failure.rules[0];
  assert.ok(rows[2]!.startsWith(rule ? `Правило: «${rule.quote}»` : 'Правило: у ситуации нет правила из ваших материалов'), rows[2]);
});

test('a situation\'s rows wrap without changing the text: a long address breaks with nothing inserted and a quote keeps its line breaks', () => {
  const address = 'https://support.example.com/refunds/terminal-1234567890/confirm?operation=987654321&lang=ru';
  const text = `Откройте ${address} и подтвердите возврат.\nвторая строка\n\nчетвёртая строка`;
  for (const width of [40, 60, 100]) {
    const lines = layoutRows([{ role: 'field', indent: 2, text, hang: 10 }], width).map(line => line.text);
    const bodies = lines.map((line, index) => line.slice(index ? 3 + 10 : 3));
    assert.equal(bodies.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), `${width}: a character was lost or added`);
    assert.ok(bodies.join('').includes(address), `${width}: the address was broken apart`);
    assert.deepEqual(bodies.slice(-3), ['вторая строка', '', 'четвёртая строка'], `${width}: ${JSON.stringify(bodies)}`);
  }
});

/* ───────────────────────────── the page others read ───────────────────────────── */

test('the customer report says the owner\'s own word about the owner — marks, chosen rules, hints, caveats —, and Pi says it to the owner', () => {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const base = calibrated(run, number => number === 1 ? ['pass', 'pass'] : ['pass', 'fail']);
  // The owner read №1's attempt and failed duty Б, which the log judge passed: one side is the owner's word.
  const record: Experiment = { ...base, caveats: [{ code: 'expectations_review' }, { code: 'causes_unnamed', cause: 'budget' }],
    humanReviews: [{ id: 'review_1', createdAt: 'now', trialId: 'attempt_1', metricId: 'e2', verdict: 'fail', note: 'Агент не объяснил возврат.' }] };
  const view = buildResultView(record);
  const [differs] = view.calibration!.disagreements;
  assert.equal(disagreementText(differs!.expectations[0]!), 'Б · объяснить, как оформить возврат — в синтетике: нет (ваша отметка), в проде: выполнил');
  assert.equal(disagreementText(differs!.expectations[0]!, 'others'), 'Б · объяснить, как оформить возврат — в синтетике: нет (отметка владельца агента), в проде: выполнил');
  assert.equal(hintText(differs!.suggests), differs!.hint, 'the owner\'s hint is the one the view carries');
  assert.equal(hintText(differs!.suggests, 'others'), 'В попытке решение владельца агента, по логу — судьи: прав ли судья по логу, не проверено.');
  assert.equal(ruleBarText({ prompt: 1, knowledge: 2, operators: 'chosen', chosen: 2 }), 'Оценка по правилам: 1 из промпта агента, 2 из базы знаний (из инструкций для операторов — только отмеченные вами (2))');
  assert.equal(ruleBarText({ prompt: 1, knowledge: 2, operators: 'chosen', chosen: 2 }, 'others'),
    'Оценка по правилам: 1 из промпта агента, 2 из базы знаний (из инструкций для операторов — только отмеченные владельцем агента (2))');
  assert.ok(calibrationCaveats('others')[0].includes('владелец агента не поправлял судью') && calibrationCaveats()[0].includes('вы не поправляли судью'));
  // Excluded because the owner could not tell from the log: said about the owner on the page.
  const unsure = buildResultView({ ...record, humanReviews: [], calibration: { ...record.calibration!,
    reviews: [logReview(logReceipt(run, 2, 'e1', 'pass'), 'unknown'), logReview(logReceipt(run, 2, 'e2', 'fail'), 'unknown')] } });
  const bundle = { record, view: unsure, warnings: [], traceJournal: '' };
  const page = plainPage(markdownReport(bundle));
  for (const text of ['владелец агента не смог решить по логу (1)', 'Перед запуском владелец агента подтвердил ожидания ситуаций, а не вердикты судьи.',
    'Причины провалов не названы: не хватило лимита вызовов модели.', '## Оговорки']) assert.ok(page.includes(text), `${text}\n${page}`);
  const pageWith = plainPage(markdownReport({ record, view, warnings: [], traceJournal: '' }));
  assert.ok(pageWith.includes('(отметка владельца агента)') && pageWith.includes('В попытке решение владельца агента'), pageWith);
  for (const words of ['ваша отметка', 'вы подтвердили', 'отмеченные вами', 'вы не смогли', 'проверьте, прав ли судья', 'ваши отметки']) {
    assert.equal(page.includes(words) || pageWith.includes(words), false, `the page says «${words}»`);
  }
  assert.ok(htmlReport({ record, view, warnings: [], traceJournal: '' }).includes('Оговорки'));
});

/* ───────────────────────────── what a result does not prove ───────────────────────────── */

test('the caveats a run carries stand under its result in the owner\'s words: the command line, the board\'s details, the chat unfolded — and only there', () => {
  const run = loggedRun(2, number => ({ e1: 'pass', e2: number === 2 ? 'fail' : 'pass' }));
  const record: Experiment = { ...run.record, caveats: [{ code: 'expectations_review' }, { code: 'causes_unnamed', cause: 'budget' }],
    limitations: ['Процесс остановился между сохранениями: число вызовов и токенов может быть неполным.', 'An English diagnostic nobody reads.'] };
  const view = buildResultView(record);
  const lines = ['Перед запуском вы подтвердили ожидания ситуаций, а не вердикты судьи.', 'Причины провалов не названы: не хватило лимита вызовов модели.',
    'Процесс остановился между сохранениями: число вызовов и токенов может быть неполным.'];
  assert.deepEqual(caveatRows(view).map(row => row.text), ['Оговорки', ...lines], 'the typed notes, then an older record\'s owner-worded ones');
  assert.equal(caveatText({ code: 'expectations_review' }), lines[0]);
  const shown = (rows: ResultRow[]) => unwrapped(plainText(rows, MAX_WIDTH));
  for (const [where, rows] of [['CLI', resultScreen(view, { surface: 'cli' })], ['board details', resultScreen(view, { surface: 'board', details: true })],
    ['chat unfolded', chatBlock(view, { expanded: true })]] as const) {
    for (const line of lines) assert.ok(shown(rows).includes(line), `${where}: ${line}`);
    assert.equal(shown(rows).includes('An English diagnostic'), false);
  }
  for (const [where, rows] of [['board', resultScreen(view, { surface: 'board' })], ['chat folded', chatBlock(view, { expanded: false })]] as const) {
    assert.equal(shown(rows).includes(lines[0]!), false, `${where} keeps its first screen short`);
  }
  assert.deepEqual(caveatRows(buildResultView(run.record)), [], 'a run without a note has no block');
});

/* ───────────────────────────── the queue of decisions and the run dialog ───────────────────────────── */

const blocked = (seen: Received): Runtime => {
  const runtime = cardRuntime(seen);
  const review = runtime.reviewCard!;
  const blockedDuty = (request: Parameters<typeof review>[0]) => request.payload.card.title === proposals.late.title && request.aliases.includes('expectation_e2');
  runtime.reviewCard = async (request, ctx) => {
    const answer = await review(request, ctx);
    return blockedDuty(request) ? { ...answer, verdicts: { ...answer.verdicts, expectation_e2: { status: 'blocked', reason: 'Правило не требует повторно объяснять возврат.' } } } : answer;
  };
  runtime.proposeCard = async (request, ctx) => { ctx.beforeCall(); seen.proposals.push(structuredClone(request)); return request.revision ? revised : proposals.late; };
  return runtime;
};
const revised: DialogueProposal = { ...proposals.late, agentMust: [proposals.late.agentMust[0]!, { ...proposals.late.agentMust[1]!, text: 'объяснить, как оформить возврат, после номера' }] };

test('the check is offered by its own budget from its start, and for a blocked situation still owed its revision', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-inbox-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(directory, blocked({ proposals: [], reviews: [] }));
  await lab.init();
  t.after(() => lab.close());
  // The ceiling covers the card's proposal and review; its revision is refused before it is sent.
  const draft = await lab.create(cardInput({ dialogues: [cardInput().dialogues![0]!] }), { callCeiling: 2, parallel: 1 });
  await lab.waitForIdle();
  const queued = (await queueDraft(lab, await lab.get(draft.id)))!;
  assert.deepEqual([queued.views.map(view => view.status), queued.pendingCalls], [['unusable'], 1 + REVIEW_CALLS], 'no situation waits for a check, and one is owed its revision');
  const offer = (record: Experiment) => decisions({ draft: { ...queued, record } }).find(item => item.key.startsWith('check:') || item.key.startsWith('budget:'));
  const check = offer(queued.record)!;
  assert.deepEqual([check.key, check.subject, check.text, check.choices[0]!.label], [`check:${draft.id}`, 'Проверка ситуаций',
    'Не подошедшие для теста ситуации Lab может один раз переписать по замечаниям проверки и проверить снова: без этого они не войдут в прогон.', 'Проверить (до 3 вызовов модели)']);
  // Whatever the preparation spent, the check has the whole limit from its start.
  const spent = { ...queued.record, usage: { ...queued.record.usage, calls: queued.record.settings.maxCalls - 1 } };
  assert.equal(offer(spent)!.key, `check:${draft.id}`, 'the calls spent before are not the check\'s');
  const tight = { ...queued.record, settings: { ...queued.record.settings, maxCalls: 2 } };
  const budget = offer(tight)!;
  assert.deepEqual([budget.key, budget.text, budget.choices[0]!.label, budget.choices[0]!.action], [`budget:${draft.id}`,
    'Не подошедшие для теста ситуации Lab может один раз переписать по замечаниям проверки — до 3 вызовов модели, а лимит проверки — 2.', 'Поднять лимит до 3',
    { kind: 'raise_limit', runId: draft.id, to: 3 }]);
});

test('the run dialog counts what stays out in agreeing words', () => {
  const record = loggedRun(1, () => ({ e1: 'pass', e2: 'pass' })).record;
  const view = (status: SituationView['status']) => ({ status }) as SituationView;
  assert.equal(cardPlan(record, [view('unusable'), view('unusable'), view('needs_owner')]).outside, '1 ждёт вашего ответа · 2 не подходят для теста');
  assert.equal(cardPlan(record, [view('unusable')]).outside, '1 не подходит для теста');
  assert.equal(cardPlan(record, [view('unusable'), view('unusable'), view('unusable'), view('unusable'), view('unusable')]).outside, '5 не подходят для теста');
});
