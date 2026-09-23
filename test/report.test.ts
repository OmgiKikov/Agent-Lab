import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { emptyUsage, experimentSchema, goalAttainment, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type MetricAssessment, type Trial } from '../src/contracts.js';
import type { EvidenceBundle } from '../src/artifacts.js';
import { toHtml, toMarkdown, type Block, type Report } from '../src/blocks.js';
import { SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { htmlReport, jsonReport, markdownReport, runReport } from '../src/report.js';
import { REPORT_CSS } from '../src/report-style.js';
import { buildResultView } from '../src/result-view.js';
import { situationBrief } from '../src/brief.js';
import type { Card as BriefCard } from '../src/card/schema.js';
import { briefCard, cardRun, compiledCard, requirements } from './helpers/cards.js';

/*
 * The customer report as a reader meets it: the block tree runReport builds from a run, and its two
 * renderings. Records are built the way the result-view tests build them; the library snapshot
 * carries only what the report reads (topics, variants, the imported dialogues they came from).
 */

const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];
type Library = NonNullable<Experiment['librarySnapshot']>;

// Distinctive ids, each with a long hex run, so a leak onto the page cannot hide.
const RUN_ID = 'run-7e3f9a1c2b4d8e6f';
const MANIFEST = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const BATCH = 'batch-4e1f7a2b9c3d';
const NO_RECEIPT = 'sit-a1b2c3d4e5f6';
const WITH_RECEIPT = 'sit-0f1e2d3c4b5a';
const TERMS = 'sit-9a8b7c6d5e4f';
const PICKUP = 'sit-5e4f3a2b1c0d';
const trialId = (scenarioId: string) => `att-${scenarioId.slice(4)}-b7c6d5e4f3a2`;

const REFUND_QUOTE = 'Возврат возможен без чека, если покупатель назвал номер заказа.';
const TERM_QUOTE = 'Деньги возвращаются в течение 10 дней.';
const CRITERIA = 'Оформить возврат по номеру заказа и назвать срок возврата денег';
const OPENING = 'Здравствуйте! Хочу вернуть наушники, чек не сохранился.';
const REFUSAL = 'Без чека вернуть деньги нельзя, приходите с чеком.';
const CAUSE = 'Требует чек, хотя правило разрешает возврат без него';

function card(id: string, title: string, overrides: Partial<Card> = {}): Card {
  return {
    id, familyId: id, title, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev', ...overrides,
  };
}
const vote = (metricId: string, result: Result, rationale = 'Обоснование.'): MetricAssessment =>
  ({ metricId, result, rationale, evidence: result === 'unknown' ? [] : [1] });

/** The client's opening → the agent's reply → the simulator ends the dialogue; one reactive attempt. */
function attempt(scenarioId: string, goal: Result, [client, agent]: [string, string], goalRationale?: string): Trial {
  return {
    id: trialId(scenarioId), revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: MANIFEST,
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [
      { seq: 0, type: 'user', text: client },
      { seq: 1, type: 'assistant', text: agent },
      { seq: 2, type: 'simulator', result: { message: '', done: true } },
    ],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [vote('goal_attainment', goal, goalRationale), vote('reply_quality', 'pass'), vote('user_fidelity', 'pass')],
  };
}

function run(cards: Card[], trials: Trial[], overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: RUN_ID, task: 't', mode: 'live', workflow: 'evaluate', createdAt: '2026-09-18T09:30:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z',
    phase: 'results_review', message: '', sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: MANIFEST, reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [], ...overrides,
  };
}

interface VariantInput {
  topic: string; title: string; provenance?: Card['provenance']; dialogue?: string; parent?: string;
  goal: string; opening: string; facts?: { statement: string; value?: string; availability: 'initial' | 'learned_in_source' | 'uncertain' }[];
  cannotKnow?: string[]; missing?: string[]; leaves?: string; criteria: string; must: { rule: string; quote: string }[];
}
/** A library variant with only the fields a situation brief and the topic view read. */
function variant(id: string, input: VariantInput) {
  return {
    id, title: input.title, businessScenarioId: input.topic, provenance: input.provenance ?? 'production',
    sourceDialogues: input.dialogue ? [{ batchId: BATCH, dialogueId: input.dialogue }] : [], ...(input.parent ? { parentVariantId: input.parent } : {}),
    userState: { goal: input.goal, opening: input.opening, facts: input.facts ?? [], cannotKnow: input.cannotKnow ?? [], missing: input.missing ?? [] },
    behaviorPolicy: { terminalStates: ['done'], transitions: input.leaves ? [{ from: 'asking', to: 'done', actionId: 'finish', when: input.leaves }] : [] },
    evaluationSpec: { successCriteria: input.criteria, goalObservation: 'reply', checkpoints: [
      ...input.must.map(must => ({ role: 'required', rule: must.rule, quote: must.quote })),
      { role: 'diagnostic', rule: 'Поздороваться с клиентом', quote: 'Приветствуйте клиента.' },
    ] },
  };
}

/**
 * Four situations of two topics from six logged conversations (refund 3, delivery 2, bonuses 1 without a
 * situation): refund without a receipt failed, refund with a receipt and delivery terms passed, pickup
 * is unmeasured (the judge split). The failure has an owner rule quoted from its source and a cause.
 */
function libraryRun(overrides: Partial<Experiment> = {}): Experiment {
  const library = {
    formatVersion: 1,
    imports: [{ id: BATCH, dialogues: ['dlg-a01', 'dlg-a02', 'dlg-a03', 'dlg-a04', 'dlg-a05', 'dlg-a06'].map(id => ({ id })) }],
    businessScenarios: [
      { id: 'topic-refund', title: 'Возврат покупки', sourceDialogues: ['dlg-a01', 'dlg-a02', 'dlg-a03'].map(dialogueId => ({ batchId: BATCH, dialogueId })) },
      { id: 'topic-delivery', title: 'Доставка', sourceDialogues: ['dlg-a04', 'dlg-a05'].map(dialogueId => ({ batchId: BATCH, dialogueId })) },
      { id: 'topic-bonus', title: 'Бонусы', sourceDialogues: [{ batchId: BATCH, dialogueId: 'dlg-a06' }] },
    ],
    variants: [
      variant(NO_RECEIPT, { topic: 'topic-refund', title: 'Возврат без чека', dialogue: 'dlg-a02', goal: 'Вернуть деньги за наушники без чека', opening: OPENING,
        facts: [{ statement: 'Номер заказа', value: 'A-1043', availability: 'initial' }, { statement: 'Дата покупки', value: '3 сентября', availability: 'learned_in_source' },
          { statement: 'Цвет упаковки', availability: 'uncertain' }],
        cannotKnow: ['Остаток бонусов на карте'], missing: ['Номер чека'], leaves: 'агент назвал срок возврата денег', criteria: CRITERIA,
        must: [{ rule: 'Принять возврат без чека по номеру заказа', quote: REFUND_QUOTE }, { rule: 'Назвать срок возврата денег', quote: TERM_QUOTE }] }),
      variant(WITH_RECEIPT, { topic: 'topic-refund', title: 'Возврат с чеком', parent: NO_RECEIPT, goal: 'Вернуть наушники с чеком', opening: 'Хочу вернуть наушники, чек есть.',
        criteria: 'Оформить возврат', must: [{ rule: 'Назвать срок возврата денег', quote: TERM_QUOTE }] }),
      variant(TERMS, { topic: 'topic-delivery', title: 'Сроки доставки', provenance: 'curated', goal: 'Узнать срок доставки в Казань', opening: 'Сколько ехать заказу до Казани?',
        criteria: 'Назвать срок доставки', must: [{ rule: 'Назвать срок доставки по городу', quote: 'Срок доставки называется по городу получателя.' }] }),
      variant(PICKUP, { topic: 'topic-delivery', title: 'Доставка в пункт выдачи', provenance: 'synthetic', goal: 'Забрать заказ в пункте выдачи', opening: 'Можно забрать заказ в пункте выдачи?',
        criteria: 'Объяснить выбор пункта выдачи', must: [{ rule: 'Объяснить, как выбрать пункт выдачи', quote: 'Пункт выдачи выбирается при оформлении.' }] }),
    ],
  } as unknown as Library;
  const cards = [
    card(NO_RECEIPT, 'Возврат без чека', { requirementIds: ['req-refund'], successCriteria: CRITERIA }),
    card(WITH_RECEIPT, 'Возврат с чеком', { requirementIds: ['req-refund'], successCriteria: 'Оформить возврат' }),
    card(TERMS, 'Сроки доставки', { provenance: 'curated', successCriteria: 'Назвать срок доставки' }),
    card(PICKUP, 'Доставка в пункт выдачи', { provenance: 'synthetic', successCriteria: 'Объяснить выбор пункта выдачи' }),
  ];
  const trials = [
    attempt(NO_RECEIPT, 'fail', [OPENING, REFUSAL]),
    attempt(WITH_RECEIPT, 'pass', ['Хочу вернуть наушники, чек есть.', 'Оформил возврат, деньги придут в течение 10 дней.']),
    attempt(TERMS, 'pass', ['Сколько ехать заказу до Казани?', 'Доставка до Казани занимает 3–5 дней.']),
    attempt(PICKUP, 'unknown', ['Можно забрать заказ в пункте выдачи?', 'Да, выберите пункт выдачи при оформлении.'],
      `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`),
  ];
  return run(cards, trials, {
    targetVersion: 'support-bot 2.3', librarySnapshot: library,
    sources: [{ id: 'src-refund', name: 'Правила возврата', content: `Общие положения магазина.\n${REFUND_QUOTE}\n${TERM_QUOTE}`, hash: 'h', kind: 'knowledge' }],
    requirements: [{ id: 'req-refund', text: 'Принимать возврат без чека по номеру заказа', sourceId: 'src-refund', quote: REFUND_QUOTE, critical: true }],
    failureModes: [{ id: 'mode-receipt', name: CAUSE, description: 'Агент отказывает без чека.', trialIds: [trialId(NO_RECEIPT)] }],
    ...overrides,
  });
}

const ADDRESS_QUOTE = 'Адрес можно сменить до передачи заказа курьеру.';
/** One old-format card (no library variant) the agent handled. */
function legacyRun(): Experiment {
  const scenario = card('card-3c2b1a0f9e8d', 'Смена адреса доставки', {
    requirementIds: ['req-address'], successCriteria: 'Сменить адрес доставки и подтвердить новый адрес',
    user: { goal: 'Сменить адрес доставки заказа A-2051', facts: 'f', behavior: 'b', opening: 'Можно поменять адрес доставки?', maxFollowUps: 3,
      knows: ['Номер заказа A-2051'], answers: [{ ifAsked: 'Какой новый адрес?', reply: 'Новый адрес — ул. Ленина, 5' }], cannotKnow: ['Передан ли заказ курьеру'] },
  });
  return run([scenario], [attempt(scenario.id, 'pass', ['Можно поменять адрес доставки?', 'Готово: адрес заказа A-2051 изменён на ул. Ленина, 5.'])], {
    sources: [{ id: 'src-delivery', name: 'Правила доставки', content: ADDRESS_QUOTE, hash: 'h', kind: 'knowledge' }],
    requirements: [{ id: 'req-address', text: 'Менять адрес до передачи курьеру', sourceId: 'src-delivery', quote: ADDRESS_QUOTE, critical: true }],
  });
}

const bundleOf = (record: Experiment): EvidenceBundle => ({ record, view: buildResultView(record), warnings: [], traceJournal: '' });

function section(report: Report, title: string): Block[] {
  const found = report.blocks.find(block => block.kind === 'section' && block.title === title);
  assert.ok(found?.kind === 'section', `no section «${title}»`);
  return found.blocks;
}

/** The visible text of the page: no style or script, tags dropped, entities decoded. */
const htmlText = (html: string) => html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** The Markdown as read: escapes removed, entities decoded. */
const markdownText = (markdown: string) => markdown.replace(/\\([\\`*_{}[\]()#|])/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Every string of the tree, in the order a reader meets it. */
function contentOf(report: Report): string[] {
  const walk = (block: Block): string[] => {
    switch (block.kind) {
      case 'alarm': return [block.text];
      case 'accuracy': return [block.lead, ...(block.value ? [block.value] : []), block.tail];
      case 'trust': return block.parts.map(part => part.text);
      case 'section': return [block.title, ...block.blocks.flatMap(walk)];
      case 'table': return [...block.head, ...block.rows.flatMap(row => row.cells)];
      case 'causes': return block.items.flatMap(cause => [cause.title, cause.count,
        ...cause.examples.flatMap(example => [example.situation, example.expected, ...(example.said ? [example.said] : []), ...(example.rule ? [example.rule] : [])])]);
      case 'cards': return block.items.flatMap(item => [item.brief.title, item.chip.text, item.brief.source, item.brief.wants, item.brief.writes,
        ...item.brief.knows.flatMap(fact => [fact.what, fact.when]), ...(item.brief.leaves ? [item.brief.leaves] : []),
        ...item.brief.must.flatMap(must => [must.text, ...(must.rule ? [must.rule] : [])]), ...item.dialogue.map(turn => turn.text)]);
      case 'failures': return block.items.flatMap(item => [item.title, item.expected, ...(item.said ? [item.said] : []),
        ...(item.rule ? [item.rule.quote, item.rule.source] : []), ...item.dialogue.map(turn => turn.text)]);
      case 'list': return block.items;
      case 'paragraph': return [block.text];
    }
  };
  return [report.title, ...report.meta, ...[...report.head, ...report.blocks].flatMap(walk), ...report.footer];
}

/** Each string is found after the previous one. */
function assertInOrder(text: string, strings: string[], label: string) {
  let at = 0;
  for (const value of strings) {
    const found = text.indexOf(value, at);
    assert.ok(found >= 0, `${label}: «${value}» is missing or out of order`);
    at = found + value.length;
  }
}

test('the report reads in the order a customer asks: number, trust, topics, causes, situations, failures, unmeasured, method', () => {
  const report = runReport(bundleOf(libraryRun()));
  assert.equal(report.title, 'Проверка агента · 4 ситуации');
  assert.deepEqual(report.meta, ['18 сентября 2026, 09:30 UTC', 'версия support-bot 2.3']);

  assert.deepEqual(report.head.map(block => block.kind), ['accuracy', 'trust', 'trust']);
  const [accuracy, trust, reality] = report.head;
  assert.ok(accuracy?.kind === 'accuracy');
  assert.deepEqual([accuracy.lead, accuracy.value, accuracy.tail, accuracy.level], ['Точность агента:', '67%', '— справился в 2 из 3 ситуаций', 'warn']);
  assert.ok(accuracy.band, 'the interval band is drawn under the number');
  assert.deepEqual(accuracy.band.range.map(share => Math.round(share * 100)), [21, 94]);
  assert.equal(Math.round((accuracy.band.weighted ?? 0) * 100), 70);
  assert.ok(trust?.kind === 'trust');
  assert.deepEqual(trust.parts, [
    { text: 'Вероятно, от 21% до 94% (95%)', warn: false }, { text: 'мало данных', warn: true },
    { text: 'не измерено 1 — судья не уверен — его оценки разошлись', warn: false }, { text: 'судью ещё не проверяли', warn: false },
  ]);
  assert.ok(reality?.kind === 'trust');
  assert.deepEqual(reality.parts, [{ text: 'С учётом частоты тем — около 70%', warn: false }]);

  // A customer cannot act on the owner's next steps, so the page has no «Дальше».
  assert.deepEqual(report.blocks.map(block => block.kind === 'section' ? block.title : block.kind),
    ['По темам', 'Почему ошибается', 'Ситуации', 'Разбор ошибок', 'Не измерено', 'Как считали']);

  assert.deepEqual(section(report, 'По темам'), [{ kind: 'table', head: ['Тема', 'справился', 'доля диалогов'], rows: [
    { muted: false, cells: ['Возврат покупки', '1 из 2', '50%'] }, { muted: false, cells: ['Доставка', '1 из 1', '33%'] },
    { muted: true, cells: ['Не покрыто ситуациями', '—', '17%'] },
  ] }]);
  assert.deepEqual(section(report, 'Почему ошибается'), [{ kind: 'causes', items: [{ title: CAUSE, count: '1 ситуация',
    examples: [{ situation: 'Возврат без чека', expected: CRITERIA, said: REFUSAL, rule: REFUND_QUOTE }] }] }]);

  const [cards] = section(report, 'Ситуации');
  assert.ok(cards?.kind === 'cards');
  assert.deepEqual(cards.items.map(item => [item.number, item.brief.title, item.brief.source, item.chip]), [
    [1, 'Возврат без чека', 'из диалога №2', { text: '✗ не справился', tone: 'err' }],
    [2, 'Возврат с чеком', 'похожая на «Возврат без чека»', { text: '✓ справился', tone: 'ok' }],
    [3, 'Сроки доставки', 'добавлена вами', { text: '✓ справился', tone: 'ok' }],
    [4, 'Доставка в пункт выдачи', 'по вашему правилу', { text: '? не измерено — судья не уверен — его оценки разошлись', tone: 'warn' }],
  ]);
  // The brief of a library situation: the client's side from the variant, the agent's duties from its required checkpoints.
  assert.deepEqual(cards.items[0]!.brief, {
    title: 'Возврат без чека', source: 'из диалога №2', wants: 'Вернуть деньги за наушники без чека', writes: OPENING,
    knows: [
      { what: 'Номер заказа: A-1043', when: 'сразу' }, { what: 'Дата покупки: 3 сентября', when: 'если спросят' }, { what: 'Цвет упаковки', when: '?' },
      { what: 'Остаток бонусов на карте', when: 'не знает' }, { what: 'Номер чека', when: 'не знает' },
    ],
    leaves: 'агент назвал срок возврата денег', turn: null,
    must: [{ text: 'Принять возврат без чека по номеру заказа', rule: REFUND_QUOTE }, { text: 'Назвать срок возврата денег', rule: TERM_QUOTE }],
  });
  assert.deepEqual(cards.items[0]!.dialogue, [{ who: 'Клиент', text: OPENING }, { who: 'Агент', text: REFUSAL }]);

  assert.deepEqual(section(report, 'Разбор ошибок'), [{ kind: 'failures', items: [{ number: 1, title: 'Возврат без чека', expected: CRITERIA, said: REFUSAL,
    rule: { quote: REFUND_QUOTE, source: 'Правила возврата' }, dialogue: [{ who: 'Клиент', text: OPENING }, { who: 'Агент', text: REFUSAL }] }] }]);
  assert.deepEqual(section(report, 'Не измерено'), [{ kind: 'list', items: ['Доставка в пункт выдачи: судья не уверен — его оценки разошлись'] }]);

  const [method] = section(report, 'Как считали');
  assert.ok(method?.kind === 'list');
  assert.match(method.items[0] ?? '', /^Ситуация засчитана, если агент выполнил запрос клиента/);
  assert.match(method.items[1] ?? '', /^4 ситуации · 4 разговора · клиента играет Lab.* · версия агента support-bot 2\.3$/);
  assert.ok(method.items.includes('Запрос выполнен: 2 из 3.'), JSON.stringify(method.items));
  assert.ok(method.items.includes('Решения судьи ещё не проверялись человеком.'), JSON.stringify(method.items));
});

test('HTML and Markdown carry the same content in the same order', () => {
  const report = runReport(bundleOf(libraryRun()));
  const content = contentOf(report);
  const html = toHtml(report);
  const markdown = toMarkdown(report);
  assertInOrder(htmlText(html), content, 'HTML');
  assertInOrder(markdownText(markdown), content, 'Markdown');
  // The public entry points render exactly this tree.
  assert.equal(htmlReport(libraryRun()), html);
  assert.equal(markdownReport(libraryRun()), markdown);
  for (const [format, text] of [['HTML', htmlText(html)], ['Markdown', markdownText(markdown)]]) {
    assertInOrder(text!, ['Точность агента:', 'По темам', 'Почему ошибается', 'Ситуации', 'Разбор ошибок', 'Не измерено', 'Как считали'], format!);
    assert.equal(text!.includes('Дальше'), false, `${format} has no owner's next steps`);
    assert.equal(text!.includes('Отчёт для заказчика'), false, `${format} does not offer itself`);
  }
  // The brief keeps its labels in both renderings.
  assertInOrder(htmlText(html), ['КЛИЕНТ', 'Хочет', 'Пишет', 'Знает', 'Уходит', 'АГЕНТ ДОЛЖЕН', `правило: «${REFUND_QUOTE}»`], 'HTML brief');
  assertInOrder(markdownText(markdown), ['**Клиент**', '- Хочет:', '- Пишет:', '- Знает:', '- Уходит:', '**Агент должен**', `— правило: «${REFUND_QUOTE}»`], 'Markdown brief');
  // A failure: expected → the agent's words → the owner's rule with its source, then the dialogue.
  for (const text of [htmlText(html), markdownText(markdown)]) {
    const failures = text.slice(text.indexOf('Разбор ошибок'));
    assertInOrder(failures, ['Ожидалось', CRITERIA, 'Агент ответил', `«${REFUSAL}»`, 'Правило', `«${REFUND_QUOTE}» — Правила возврата`, OPENING, REFUSAL], 'failure');
  }
});

test('an alarm, a paragraph and hostile strings render alike in both formats', () => {
  const hostile = '<script>alert(1)</script> & [link](javascript:x) *bold* #1 | `code`';
  const report: Report = {
    title: `Проверка агента · ${hostile}`, meta: ['18 сентября 2026, 09:30 UTC'],
    head: [
      { kind: 'alarm', text: '✗ Числу пока не верить: контрольная ситуация не прошла — проверьте связь с агентом' },
      { kind: 'accuracy', lead: 'Точность агента:', value: null, tail: 'нет данных — ни одна ситуация не измерена', level: 'none', band: null },
    ],
    blocks: [
      { kind: 'paragraph', muted: false, text: `Ошибок нет: ${hostile}` },
      { kind: 'section', title: 'Как считали', blocks: [{ kind: 'list', items: [hostile] }] },
    ],
    footer: ['Отчёт Agent Lab'],
  };
  const html = toHtml(report);
  const markdown = toMarkdown(report);
  assertInOrder(htmlText(html), contentOf(report), 'HTML');
  assertInOrder(markdownText(markdown), contentOf(report), 'Markdown');
  assert.equal(html.match(/<script\b/g)?.length, 1, 'only the report\'s own script');
  assert.doesNotMatch(markdown, /<script|\[link\]\(javascript/);
});

test('no run id, trial id or hash reaches the page; the JSON snapshot keeps them', () => {
  const record = libraryRun();
  const bundle = bundleOf(record);
  const ids = [RUN_ID, MANIFEST, BATCH, ...record.trials.map(trial => trial.id), ...record.scenarios.map(scenario => scenario.id), 'dlg-a02', 'topic-refund', 'req-refund', 'src-refund', 'mode-receipt'];
  const html = htmlReport(bundle);
  const markdown = markdownReport(bundle);
  for (const [format, page] of [['HTML', html], ['Markdown', markdown]] as const) {
    for (const id of ids) assert.equal(page.includes(id), false, `${format} prints ${id}`);
  }
  for (const [format, text] of [['HTML', htmlText(html)], ['Markdown', markdownText(markdown)]] as const) {
    assert.doesNotMatch(text, /[0-9a-f]{12,}/i, `${format} shows a hash-like string`);
  }
  const snapshot = jsonReport(bundle);
  for (const id of [RUN_ID, MANIFEST, trialId(NO_RECEIPT)]) assert.ok(snapshot.includes(id), id);
});

test('a demo run is labelled «учебный пример»; a live run is not', () => {
  const live = libraryRun();
  const demo = libraryRun({ mode: 'demo' });
  assert.ok(runReport(bundleOf(demo)).meta.includes('учебный пример'));
  for (const page of [htmlReport(demo), markdownReport(demo)]) assert.match(page, /учебный пример/);
  for (const page of [htmlReport(live), markdownReport(live)]) assert.doesNotMatch(page, /учебный пример/);
});

test('a card reads as its own brief: when each fact is said, the turn, and every expectation with its owner rule', () => {
  const card = briefCard();
  const similar: BriefCard = { ...briefCard({ turn: null }), id: `card_${'e'.repeat(64)}`, number: 4, origin: { kind: 'similar', parentId: card.id, change: { kind: 'turn', turn: null } } };
  const scenarios = [compiledCard(card), compiledCard(similar)];
  const record = cardRun(scenarios, [], 1, { librarySnapshot: { formatVersion: 2, requirements, cards: [card, similar] } as unknown as Library });
  const [first, second] = scenarios.map(scenario => situationBrief(record, scenario));
  const [terminal, receipt] = requirements.map(item => item.quote);
  assert.deepEqual(first, {
    title: 'Возврат без номера в первой реплике', source: 'из разговора в логах', wants: 'Получить инструкцию по возврату', writes: 'Помогите с возвратом, я Анна.',
    knows: [{ what: 'Имя: Анна', when: 'сразу' }, { what: 'Номер терминала: 5678', when: 'если спросят' }, { what: 'Сумма: 1200', when: 'если спросят' }, { what: 'Дата покупки', when: 'не знает' }],
    leaves: 'получил инструкцию по возврату или понял, что агент не поможет',
    turn: 'после «агент объяснил, как оформить возврат»: «Тогда лучше отмените покупку.»',
    must: [{ text: 'запросить номер терминала не больше одного раза', rule: terminal }, { text: 'объяснить, как оформить возврат', rule: terminal },
      { text: 'предложить возврат по выписке', rule: receipt }],
  });
  assert.deepEqual([second?.source, second?.turn], ['похожая на №3', null]);
});

test('an old-format situation reads as a brief built from its card', () => {
  const report = runReport(bundleOf(legacyRun()));
  const [cards] = section(report, 'Ситуации');
  assert.ok(cards?.kind === 'cards');
  assert.deepEqual(cards.items.map(item => item.brief), [{
    title: 'Смена адреса доставки', source: 'из разговора в логах', wants: 'Сменить адрес доставки заказа A-2051', writes: 'Можно поменять адрес доставки?',
    knows: [{ what: 'Номер заказа A-2051', when: 'сразу' }, { what: 'Новый адрес — ул. Ленина, 5', when: 'если спросят' }, { what: 'Передан ли заказ курьеру', when: 'не знает' }],
    leaves: null, turn: null, must: [{ text: 'Сменить адрес доставки и подтвердить новый адрес', rule: ADDRESS_QUOTE }],
  }]);
  assert.deepEqual(cards.items[0]!.chip, { text: '✓ справился', tone: 'ok' });
  // Without failures the page says so and makes no promise for live clients.
  assert.deepEqual(report.blocks.map(block => block.kind === 'section' ? block.title : block.kind), ['paragraph', 'Ситуации', 'Как считали']);
  const html = htmlText(htmlReport(legacyRun()));
  const markdown = markdownText(markdownReport(legacyRun()));
  assertInOrder(html, ['Хочет', 'Сменить адрес доставки заказа A-2051', 'Знает', 'Новый адрес — ул. Ленина, 5 — если спросят', 'АГЕНТ ДОЛЖЕН',
    'Сменить адрес доставки и подтвердить новый адрес', `правило: «${ADDRESS_QUOTE}»`], 'HTML');
  assertInOrder(markdown, ['- Хочет: Сменить адрес доставки заказа A-2051', '- Знает: Новый адрес — ул. Ленина, 5 — если спросят', '**Агент должен**',
    `1. Сменить адрес доставки и подтвердить новый адрес — правило: «${ADDRESS_QUOTE}»`], 'Markdown');
  for (const text of [html, markdown]) {
    assert.match(text, /Ошибок нет\. Это не гарантия для живых клиентов: проверено 1 ситуация\./);
    assert.equal(text.includes('Уходит'), false, 'an old card does not say when the client leaves');
  }
});

test('the stored legacy demo run renders in both formats and names its failures', async () => {
  const record = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/legacy-demo-run.json', import.meta.url), 'utf8')));
  const report = runReport(bundleOf(record));
  const [failures] = section(report, 'Разбор ошибок');
  assert.ok(failures?.kind === 'failures');
  const titles = ['Move an appointment', 'Change preference after the first response'];
  assert.deepEqual(failures.items.map(item => item.title), titles);
  assert.ok(failures.items.every(item => item.said && item.rule), 'each failure quotes the agent and the owner rule');
  for (const text of [htmlText(htmlReport(record)), markdownText(markdownReport(record))]) {
    assertInOrder(text, ['учебный пример', 'Точность агента:', '0%', '— справился в 0 из 2 ситуаций', 'Разбор ошибок', ...titles], 'legacy');
    assert.equal(text.includes(record.id), false);
  }
});

test('the page is dark by default and prints on a light page', () => {
  const [screen, print] = REPORT_CSS.split('@media print');
  assert.ok(print, 'a print block exists');
  const luminance = (css: string, token: string) => {
    const short = css.match(new RegExp(`--${token}:#([0-9a-f]{6}|[0-9a-f]{3})\\b`, 'i'))?.[1];
    assert.ok(short, `--${token} is set`);
    const hex = short.length === 3 ? [...short].map(digit => digit + digit).join('') : short;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  assert.match(screen!, /color-scheme:dark/);
  assert.ok(luminance(screen!, 'page') < 0.1 && luminance(screen!, 'text') > 0.6, 'light text on a dark page on screen');
  assert.match(print, /color-scheme:light/);
  assert.ok(luminance(print, 'page') > 0.9 && luminance(print, 'text') < 0.2, 'dark text on a white page in print');
  assert.ok(htmlReport(libraryRun()).includes(`<style>${REPORT_CSS}</style>`), 'the style is inline');
});
