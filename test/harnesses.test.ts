import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createInputSchema, goldenToScenario, validatePreparation } from '../src/contracts.js';

/*
 * Обвязки агентов живут сбоку от ядра (harnesses/), но их файлы обязаны проходить контракты ядра:
 * иначе ошибка в них находится только на рабочем стенде.
 */

test('the shipped agent_oc end2end card passes preparation validation', async () => {
  // Карточку в примере правят руками, а её ошибки видны только в живом прогоне: проверка
  // state_equals требует, чтобы запись и поле уже существовали в initialState, а меняющееся
  // поле было объявлено writableFields. Без этого теста ошибка находится на рабочем стенде.
  const template = JSON.parse(await readFile(new URL('../harnesses/agent-oc/e2e/task.json', import.meta.url), 'utf8'));
  const input = createInputSchema.parse(template);
  const sources = input.materials.map((m, i) => ({ id: `s${i}`, name: m.name, content: m.content, hash: 'hash' }));
  validatePreparation({
    requirements: [{ id: 'r1', text: 'Агент отвечает клиенту', sourceId: sources[0]!.id, quote: sources[0]!.content.slice(0, 40), critical: false }],
    questions: [], agent: { name: 'agent_oc', instructions: 'Прод-путь ветки B', tools: [] },
    scenarios: input.goldenCases.map(goldenToScenario),
  }, sources, 'evaluate');
});
