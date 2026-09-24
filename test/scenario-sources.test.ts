import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitScenarioSources, promptGroundingPlan, selectScenarioSources } from '../src/scenario-sources.js';
import { serializedBytes, workInputIssue } from '../src/limits.js';
import type { Source } from '../src/contracts.js';
import type { CallContext, SourceSelectionInput } from '../src/runtime.js';

const ctx = { signal: new AbortController().signal } as CallContext;
const sources: Source[] = [
  { id: 'settings', name: 'Как настроить онлайн-кассу', content: 'Только для кассы, которая уже подключена. Выберите нужную кассу в списке.', hash: 'settings-hash' },
  { id: 'connect', name: 'Как подключить онлайн-оплату в личном кабинете', content: 'Подключение онлайн-оплаты. Клиентский путь. Перейдите в раздел Все продукты и услуги.', hash: 'connect-hash' },
];
const input: SourceSelectionInput = { task: 'Подготовить тест', catalog: sources.map(s => ({ id: s.id, name: s.name, chars: s.content.length })),
  dialogue: { id: 'real-opening', messages: [{ role: 'user', content: 'Как подключить онлайн оплату' },
    { role: 'assistant', content: 'Выберите уже подключённую кассу.' }, { role: 'user', content: 'Там нет никакой кассы' }] }, limit: 5 };

test('reference selection withholds old agent instructions and can replace the title shortlist after reading scope', async () => {
  const requests: SourceSelectionInput[] = [];
  const selected = await selectScenarioSources(input, sources, { selectSources: async request => {
    requests.push(structuredClone(request));
    return { sourceIds: request.reading ? ['connect', 'settings'] : ['settings'] };
  } }, ctx);
  assert.deepEqual(selected.map(s => s.id), ['connect', 'settings']);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual(request.dialogue.messages.map(m => m.role), ['user', 'user']);
  assert.deepEqual(requests[1]!.reading!.sources, [sources[0]]);
  assert.deepEqual(requests[1]!.reading!.unreadSourceIds, []);
  assert.equal(input.dialogue.messages.length, 3, 'source chronology remains intact');
});

test('bounded review identifies unread whole articles and never truncates their text', async () => {
  const large = [{ ...sources[0]!, content: 'я'.repeat(11900) }, { ...sources[1]!, content: 'ю'.repeat(2500) }];
  const catalog = Array.from({ length: 240 }, (_, i) => ({ id: `extra-${i}`, name: 'Длинное название статьи '.repeat(3), chars: 100 }));
  let review: SourceSelectionInput | undefined;
  const selected = await selectScenarioSources({ ...input, catalog: [...input.catalog, ...catalog] }, large, { selectSources: async request => {
    assert.ok(serializedBytes(request) <= 64000);
    if (request.reading) review = request;
    return { sourceIds: ['settings', 'connect'] };
  } }, ctx);
  assert.ok(review?.reading);
  for (const source of review.reading.sources) assert.equal(source.content, large.find(s => s.id === source.id)!.content);
  assert.ok(review.reading.unreadSourceIds.includes('settings'));
  assert.deepEqual(selected, [large[0], large[1]], 'the revision\'s order, both articles whole');
});

test('a reference revision cannot replace the article named first for the customer\'s goal with a narrower setup article', async () => {
  const selected = await selectScenarioSources(input, sources, { selectSources: async request => ({ sourceIds: request.reading ? ['settings'] : ['connect'] }) }, ctx);
  assert.deepEqual(selected.map(s => s.id), ['connect', 'settings'], 'the goal article the revision left out stays in front');
  const reordered = await selectScenarioSources(input, sources, { selectSources: async request => ({ sourceIds: request.reading ? ['settings', 'connect'] : ['connect', 'settings'] }) }, ctx);
  assert.deepEqual(reordered.map(s => s.id), ['settings', 'connect'], 'an article the revision kept is where the revision put it');
});

test('unsupported revision remains empty and byte limits do not cut procedures to make them fit', async () => {
  assert.deepEqual(fitScenarioSources(['settings', 'settings', 'unknown', 'connect'], [{ ...sources[0]!, content: 'я'.repeat(17000) }, sources[1]!]), [sources[1]]);
  const selected = await selectScenarioSources(input, sources, { selectSources: async request => ({ sourceIds: request.reading ? [] : ['settings'] }) }, ctx);
  assert.deepEqual(selected, []);
});

test('the agent\'s prompts are grounded in as few calls as fit, in order; a prompt too large for one call is left out with the reason', () => {
  const prompt = (index: number, chars: number): Source => ({ id: `p${index}`, name: `prompt ${index}`, content: 'п'.repeat(chars), hash: `h${index}`, kind: 'prompt' });
  const prompts = Array.from({ length: 40 }, (_, index) => prompt(index + 1, 3000));
  const huge = prompt(99, 70_000);
  const plan = promptGroundingPlan('Проверить', [sources[0]!, ...prompts.slice(0, 20), huge, ...prompts.slice(20)]);
  assert.deepEqual(plan.chunks.flat().map(source => source.id), prompts.map(source => source.id), 'every prompt once, in the record\'s order, no article');
  assert.ok(plan.chunks.length > 1 && plan.chunks.length < prompts.length, `${plan.chunks.length} chunks`);
  assert.ok(plan.chunks.every(chunk => !workInputIssue({ task: 'Проверить', sources: chunk })), 'each chunk fits one call');
  assert.ok(plan.chunks.slice(0, -1).every((chunk, index) => workInputIssue({ task: 'Проверить', sources: [...chunk, plan.chunks[index + 1]![0]!] })), 'a chunk takes prompts while they fit');
  assert.deepEqual(plan.skipped.map(item => item.source.id), ['p99']);
  assert.match(plan.skipped[0]!.reason, /^Промпт «prompt 99» не помещается в один запрос/);
  assert.deepEqual(promptGroundingPlan('Проверить', sources), { chunks: [], skipped: [] });
});
