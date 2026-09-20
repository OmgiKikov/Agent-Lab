import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('agent-builder discovers one saved hypothesis and hands it to one test after the owner answers', async () => {
  const skill = await readFile(fileURLToPath(new URL('../skills/agent-builder/SKILL.md', import.meta.url)), 'utf8');
  const discovery = skill.slice(skill.indexOf('## Real dialogues at the start'), skill.indexOf('## Start from the local project'));

  assert.match(discovery, /mode:"discover"/);
  assert.match(discovery, /up to 300 dialogues/);
  assert.match(discovery, /call plan.*native confirmation.*before the first provider call/is);
  assert.match(discovery, /selection evidence, not production accuracy/i);
  assert.match(discovery, /exact dialogue\/event observations/i);
  assert.match(discovery, /НАБЛЮДЕНИЕ: ответ агента \(reply\).*Проверим\?/s);
  assert.match(discovery, /On «да».*exact returned `fromRunId`.*exact returned `hypothesis`/s);
  assert.match(discovery, /re-reads the saved run and builds exactly that one test/i);
  assert.match(discovery, /do not ask.*another technical confirmation round/i);
  assert.match(discovery, /On refusal or correction, build nothing/i);
  assert.match(discovery, /agent_lab_accept.*separate decision/is);
  assert.match(discovery, /Acceptance does not run the agent/i);
  assert.match(skill, /Пустой ответ не означает.*без (?:диалогов|них)/);
});

test('agent-builder makes the scenario library the primary validation workspace', async () => {
  const skill = await readFile(fileURLToPath(new URL('../skills/agent-builder/SKILL.md', import.meta.url)), 'utf8');

  assert.match(skill, /Логи\s*→\s*Сценарии\s*→\s*Прогон\s*→\s*Результаты/);
  assert.match(skill, /agent_lab_scenarios/);
  assert.match(skill, /accepted revision/i);
  assert.match(skill, /source quote/i);
  assert.match(skill, /semantic readiness/i);
  assert.match(skill, /Acceptance does not run the agent/i);
  assert.match(skill, /remaining.*budget/is);
  assert.doesNotMatch(skill, /stable outcome-blind candidate pool/i);
  assert.doesNotMatch(skill, /all expected results.*existing run confirmation/i);
});
