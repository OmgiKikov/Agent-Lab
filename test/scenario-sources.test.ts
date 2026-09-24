import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitScenarioSources, selectScenarioSources } from '../src/scenario-sources.js';
import { serializedBytes } from '../src/limits.js';
import type { CallContext, Source, SourceSelectionInput } from '../src/contracts.js';

const ctx = { signal: new AbortController().signal } as CallContext;
const sources: Source[] = [
  { id: 'settings', name: 'Как настроить интернет-терминал', content: 'Только для интернет-эквайринга от Сбера. Не ЮKassa! Выберите нужный интернет-терминал.' },
  { id: 'connect', name: 'Как подключить интернет-эквайринг ЮKassa через СберБизнес', content: 'Подключение ЮKassa. Клиентский путь. Перейдите в раздел Все продукты и услуги.' },
];
const input: SourceSelectionInput = { task: 'Подготовить тест', catalog: sources.map(s => ({ id: s.id, name: s.name, chars: s.content.length })),
  dialogue: { id: 'real-opening', messages: [{ role: 'user', content: 'Как подключить интернет эквайринг' },
    { role: 'assistant', content: 'Выберите уже существующий интернет-терминал.' }, { role: 'user', content: 'Там нету интернет терминала' }] }, limit: 5 };

test('reference selection withholds old agent instructions and can replace the title shortlist after reading scope', async () => {
  const requests: SourceSelectionInput[] = [];
  const selected = await selectScenarioSources(input, sources, [], { selectSources: async request => {
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
  const selected = await selectScenarioSources({ ...input, catalog: [...input.catalog, ...catalog] }, large, [], { selectSources: async request => {
    assert.ok(serializedBytes(request) <= 64000);
    if (request.reading) review = request;
    return { sourceIds: ['settings', 'connect'] };
  } }, ctx);
  assert.ok(review?.reading);
  for (const source of review.reading.sources) assert.equal(source.content, large.find(s => s.id === source.id)!.content);
  assert.ok(review.reading.unreadSourceIds.includes('settings'));
  assert.deepEqual(selected, [large[1], large[0]]);
});

test('a reference revision cannot replace the article naming the original goal with a narrower setup article', async () => {
  const selected = await selectScenarioSources(input, sources, [], { selectSources: async request => ({ sourceIds: request.reading ? ['settings'] : ['connect'] }) }, ctx);
  assert.deepEqual(selected.map(s => s.id), ['connect', 'settings']);
});

test('unsupported revision remains empty and byte limits do not cut procedures to make them fit', async () => {
  assert.deepEqual(fitScenarioSources(['settings', 'settings', 'unknown', 'connect'], [{ ...sources[0]!, content: 'я'.repeat(17000) }, sources[1]!], []), [sources[1]]);
  const selected = await selectScenarioSources(input, sources, [], { selectSources: async request => ({ sourceIds: request.reading ? [] : ['settings'] }) }, ctx);
  assert.deepEqual(selected, []);
});
