import type { Experiment } from '../src/contracts.js';
import type { ExperimentStore } from '../src/store.js';
import { roleChoices } from '../src/llm/models.js';
import { planTopicMap, reusableTopicMap, topicMapKey } from '../src/miner/topic-map.js';
import { clip, safeLine } from '../src/text.js';

/** Read the preparation's durable checkpoints. Never infer completed work from elapsed time. */
export async function preparationDetails(store: ExperimentStore, record: Experiment): Promise<{ details: string[]; share?: number }> {
  const details: string[] = [];
  const unsuitable = new Set<string>();
  let share: number | undefined;
  const progress = record.preparationProgress;
  const source = record.originalImport;
  const batch = source ? await store.readImport(source.id).catch(() => undefined) : undefined;
  if (batch && batch.contentHash === source?.contentHash) {
    const choice = roleChoices(record.settings).builder;
    const builder = { provider: choice.provider, id: choice.model };
    const stored = await store.readTopicMap(topicMapKey(batch, builder)).catch(() => undefined);
    const plan = planTopicMap(batch, builder, stored);
    for (const item of plan.excluded) unsuitable.add(item.dialogueId);
    const map = reusableTopicMap(stored, batch, builder) ?? plan.resume;
    const classified = Object.keys(map?.assignments ?? {}).length;
    details.push(`Темы: размечено ${classified} из ${plan.dialogues} диалогов${map ? ` · найдено тем: ${map.topics.length}` : ''}.`);
    if (plan.excluded.length) details.push(`Не подходят для подготовки: ${plan.excluded.length} диалогов.`);
    if (!progress) share = classified / Math.max(1, plan.dialogues);
    if (map) {
      details.push(`Найденные темы: ${map.topics.map(topic => topic.title).join(' · ')}.`);
      details.push('Примеры разметки из логов:');
      const shown = new Set<string>();
      for (const dialogue of batch.dialogues) {
        const topicId = map.assignments[dialogue.id];
        if (!topicId || shown.has(topicId)) continue;
        const title = map.topics.find(topic => topic.id === topicId)?.title ?? 'Другое';
        const words = dialogue.events.filter(event => event.type === 'message' && event.role === 'user').map(event => event.content).join(' ');
        if (!words.trim()) continue;
        details.push(`«${clip(safeLine(words), 180)}» → ${title}`);
        shown.add(topicId);
        if (shown.size === 3) break;
      }
    }
  }
  if (progress) {
    const count = progress.requestedCount ?? progress.processed.length + progress.pending.length;
    share = progress.processed.length / Math.max(1, count);
    details.push(`Подготовлено ситуаций: ${progress.processed.length} из ${count}. Осталось в очереди: ${progress.pending.length}.`);
    const stages = { select: 'подбираю материалы', ground: 'проверяю основания', propose: 'составляю ситуацию', review: 'проверяю ситуацию', extract: 'извлекаю ситуацию', repair: 'исправляю ситуацию' };
    const active = ('active' in progress ? progress.active : undefined) ?? (progress.activeStage ? [{ stage: progress.activeStage }] : []);
    if (active.length) details.push(`Сейчас: ${active.map(item => stages[item.stage]).join(' · ')}.`);
    const failed = progress.excluded.filter(item => !unsuitable.has(item.dialogueId));
    if (failed.length) details.push(`Не составлены ситуации из ${failed.length} диалогов. Последняя причина: ${clip(safeLine(failed.at(-1)!.reason), 240)}`);
  }
  return { details, ...(share === undefined ? {} : { share }) };
}
