import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparationDetails } from '../extensions/preparation-progress.ts';
import { preparationPanel } from '../extensions/preparation-panel.ts';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ExperimentLab } from '../src/experiment.js';
import { newRecord } from '../src/lab/record.js';
import { demoInput } from '../src/demo.js';
import { topicMapKey } from '../src/miner/topic-map.js';
import { BUILDER, importOf, MASKED, TOPICS, world } from './helpers/miner.js';

test('preparation shows only its own valid topic checkpoint and real customer examples', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-preparation-view-'));
  const lab = new ExperimentLab(directory);
  try {
    await lab.init();
    const batch = await lab.store.writeImport(importOf([...world(), MASKED]));
    const record = newRecord(demoInput());
    record.settings.roles.builder = { provider: BUILDER.provider, model: BUILDER.id };
    record.originalImport = { id: batch.id, contentHash: batch.contentHash };
    const topics = TOPICS.map(({ title, description }, i) => ({ id: `t${i + 1}`, title, description }));
    const assignments = Object.fromEntries(world().slice(0, 34).map(item => [item.id, topics.find(topic => topic.title === item.topic)?.id ?? 'other']));
    const partial = { formatVersion: 1 as const, ...topicMapKey(batch, BUILDER), topics, assignments };
    await lab.store.writeTopicMap(partial);
    const view = await preparationDetails(lab.store, record);
    assert.equal(view.share, 0.34);
    const text = preparationPanel(view.preparation, [], 120).map(line => line.map(span => span.text).join('')).join('\n');
    assert.match(text, /34 из 100 диалогов размечено/);
    assert.match(text, /Пропущено до генерации: 1/);
    assert.match(text, /Хочу вернуть деньги за покупку/);
    assert.match(text, /Возврат оплаты/);
    assert.doesNotMatch(text, /Понимаю, сейчас помогу/);
    view.preparation.examples[0]!.quote = 'Пример\u001b[31m: возврат\nиз логов';
    for (const width of [24, 40, 60, 84, 100, 120, 140, 240]) {
      const lines = preparationPanel(view.preparation, [], width);
      assert.ok(lines.length > 4);
      assert.ok(lines.every(line => line.every(span => !span.text.includes('\u001b') && !span.text.includes('\n'))));
      assert.ok(lines.every(line => visibleWidth(line.map(span => span.text).join('')) <= width), `overflow at ${width}`);
    }
    record.settings.roles.builder.model = 'another-model';
    const other = await preparationDetails(lab.store, record);
    assert.equal(other.share, 0);
    assert.equal(other.preparation.examples.length, 0);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
