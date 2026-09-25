import type { Experiment } from '../src/contracts.js';
import type { ExperimentStore } from '../src/store.js';
import { roleChoices } from '../src/llm/models.js';
import { leftBeforeSpending } from '../src/miner/plan.js';
import { planTopicMap, reusableTopicMap, topicMapKey } from '../src/miner/topic-map.js';
import { clip, safeLine } from '../src/text.js';

export interface PreparationView {
  state: 'working' | 'paused' | 'complete';
  logs?: { classified: number; total: number; excluded: number; topics: string[] };
  examples: { quote: string; topic: string }[];
  /** `gaps`: units the owner's rules leave open — told apart from the ones Lab failed to make. */
  cards?: { completed: number; total: number; pending: number; failed: number; gaps?: number; lastFailure?: string };
  activities: { label: string; count: number }[];
  elapsedMinutes: number;
  costUsd: number | null;
}

/** Read durable checkpoints; the screen decides layout, never reconstructs numbers from prose. */
export async function preparationDetails(store: ExperimentStore, record: Experiment, now = Date.now()): Promise<{ preparation: PreparationView; share?: number }> {
  const state = record.phase === 'preparing' ? 'working' : record.preparationProgress?.pending.length ? 'paused' : 'complete';
  const until = state === 'working' ? now : Date.parse(record.updatedAt);
  const preparation: PreparationView = { state, examples: [], activities: [], elapsedMinutes: Math.max(0, Math.round((until - Date.parse(record.createdAt)) / 60_000)), costUsd: record.usage.costUsd };
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
    // Left out before anything was spent — refused by the import, or no situation can be made of them: never a failure.
    for (const item of leftBeforeSpending(batch, plan.unsuitable)) unsuitable.add(item.dialogueId);
    const map = reusableTopicMap(stored, batch, builder) ?? plan.resume;
    const classified = Object.keys(map?.assignments ?? {}).length;
    preparation.logs = { classified, total: plan.dialogues, excluded: plan.unsuitable.length, topics: map?.topics.map(topic => topic.title) ?? [] };
    if (!progress) share = classified / Math.max(1, plan.dialogues);
    if (map) {
      const shown = new Set<string>();
      for (const dialogue of batch.dialogues) {
        const topicId = map.assignments[dialogue.id];
        if (!topicId || shown.has(topicId)) continue;
        const topic = map.topics.find(item => item.id === topicId)?.title ?? 'Другое';
        const words = dialogue.events.filter(event => event.type === 'message' && event.role === 'user').map(event => event.content).join(' ');
        if (!words.trim()) continue;
        preparation.examples.push({ quote: clip(safeLine(words), 180), topic });
        shown.add(topicId);
        if (shown.size === 3) break;
      }
    }
  }
  if (progress) {
    const total = progress.requestedCount ?? progress.processed.length + progress.pending.length;
    share = progress.processed.length / Math.max(1, total);
    const gaps = progress.excluded.filter(item => 'uncovered' in item && item.uncovered).length;
    const failed = progress.excluded.filter(item => !unsuitable.has(item.dialogueId) && !('uncovered' in item && item.uncovered));
    preparation.cards = { completed: progress.processed.length, total, pending: progress.pending.length, failed: failed.length, ...(gaps ? { gaps } : {}),
      ...(failed.length ? { lastFailure: clip(safeLine(failed.at(-1)!.reason), 240) } : {}) };
    const stages = { select: 'Подбор материалов', ground: 'Проверка оснований', plan: 'План сценария', propose: 'Составление ситуаций', review: 'Проверка ситуаций', extract: 'Извлечение ситуаций', repair: 'Исправление ситуаций' };
    const active = ('active' in progress ? progress.active : undefined) ?? (progress.activeStage ? [{ stage: progress.activeStage }] : []);
    for (const item of state === 'working' ? active : []) {
      const label = stages[item.stage];
      const existing = preparation.activities.find(activity => activity.label === label);
      if (existing) existing.count++; else preparation.activities.push({ label, count: 1 });
    }
  }
  return { preparation, ...(share === undefined ? {} : { share }) };
}
