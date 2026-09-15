import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('agent-builder stops at one grounded hypothesis until the owner answers', async () => {
  const skill = await readFile(fileURLToPath(new URL('../skills/agent-builder/SKILL.md', import.meta.url)), 'utf8');
  const gate = skill.slice(skill.indexOf('Before any test-building call'), skill.indexOf('## Start from the local project'));

  const headings = ['ТРЕБОВАНИЯ', 'НАБЛЮДАЕМОЕ', 'НЕИЗВЕСТНО', 'ГИПОТЕЗА', 'Проверим?'];
  assert.ok(headings.every((heading, index) => gate.indexOf(heading) >= 0
    && (index === 0 || gate.indexOf(heading) > gate.indexOf(headings[index - 1]!))));
  assert.match(gate, /ровно одн[ау] гипотез/);
  assert.match(gate, /источник владельца.*точн.*цитат/);
  assert.match(gate, /путь.*строк|диалог.*событи/);
  assert.match(gate, /existing code.*assistant reply.*saved outcome.*observations/i);
  assert.match(gate, /observable effect.*НЕЯСНО/i);
  assert.match(gate, /Недостаточно данных для гипотезы\nДобавьте требования владельца и хотя бы одно наблюдение из репозитория или записанного диалога\./);
  assert.match(gate, /«да».*контекст.*[Фф]аз[ыа] 3/);
  assert.match(gate, /«нет».*нов.*доказательств/);
  assert.match(gate, /не сохраня.*гипотез.*не (?:созда|стро).*тест.*не запуска.*агент.*не сохраня.*регресси/);
  assert.match(skill, /Do not propose production\/synthetic cards during Phase 2/);
  assert.match(skill, /Пустой ответ не означает.*без (?:диалогов|них)/);
});
