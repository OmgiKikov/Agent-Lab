import type { Experiment } from './contracts.js';
import type { Verdict } from './run.js';

/*
 * How close the number is to real traffic (E2): the counted situations grouped by the topic of the
 * logged conversations they came from, each topic's share of those conversations, and the accuracy
 * weighted by that share. A topic is a business scenario of the accepted library. A logged
 * conversation has a topic when a business scenario of the library names it as a source; topics of
 * the conversations that never became situations arrive with the scenario miner, and until then the
 * shares are counted over the conversations whose topic is known — the view says how many that is.
 * Pure: no I/O, no wording.
 */

export interface TopicRow {
  id: string; title: string;
  /** Counted situations of this topic, and how many of them the agent handled out of those decided. */
  situations: number; passed: number; decided: number;
  /** This topic's share of the logged conversations with a known topic; null when no logged conversation has one. */
  share: number | null;
}
export interface TopicView {
  /** Largest share first, then the most situations, then the library order. */
  rows: TopicRow[];
  /** Topics of logged conversations without any counted situation: their share of the conversations with a known topic. */
  uncovered: { topics: number; share: number } | null;
  /** The per-topic accuracy weighted by each measured topic's share of conversations; null without shares or with fewer than two measured topics. */
  weighted: number | null;
  /** Logged conversations of the imports, and those among them with a known topic. */
  logged: number; labeled: number;
}

interface CountedCard { scenarioId: string; outcome: Verdict; control: boolean }

/** The topic rows of a run made from a library with at least two topics among its counted situations; null otherwise. */
export function topicView(record: Experiment, cards: CountedCard[]): TopicView | null {
  const library = record.librarySnapshot;
  if (!library) return null;
  const topicOf = new Map(library.variants.map(variant => [variant.id, variant.businessScenarioId]));
  const counted = cards.filter(card => !card.control && topicOf.has(card.scenarioId));
  const used = new Set(counted.map(card => topicOf.get(card.scenarioId)!));
  if (used.size < 2) return null;
  // Each logged conversation counts once, for the first topic that names it.
  const logged = new Set(library.imports.flatMap(batch => batch.dialogues.map(dialogue => `${batch.id}|${dialogue.id}`)));
  const labels = new Map<string, string>();
  for (const topic of library.businessScenarios) {
    for (const source of topic.sourceDialogues) {
      const key = `${source.batchId}|${source.dialogueId}`;
      if (logged.has(key) && !labels.has(key)) labels.set(key, topic.id);
    }
  }
  const conversations = new Map<string, number>();
  for (const topic of labels.values()) conversations.set(topic, (conversations.get(topic) ?? 0) + 1);
  const labeled = labels.size;
  const share = (id: string): number | null => labeled ? (conversations.get(id) ?? 0) / labeled : null;
  const order = new Map(library.businessScenarios.map((topic, index) => [topic.id, index]));
  const rows = library.businessScenarios.filter(topic => used.has(topic.id)).map((topic): TopicRow => {
    const own = counted.filter(card => topicOf.get(card.scenarioId) === topic.id);
    const passed = own.filter(card => card.outcome === 'pass').length;
    return { id: topic.id, title: topic.title, situations: own.length, passed, decided: passed + own.filter(card => card.outcome === 'fail').length, share: share(topic.id) };
  }).sort((a, b) => (b.share ?? 0) - (a.share ?? 0) || b.situations - a.situations || order.get(a.id)! - order.get(b.id)!);
  const measured = rows.filter(row => row.decided > 0 && row.share !== null && row.share > 0);
  const measuredShare = measured.reduce((sum, row) => sum + row.share!, 0);
  const weighted = measured.length >= 2 && measuredShare > 0
    ? measured.reduce((sum, row) => sum + row.share! * (row.passed / row.decided), 0) / measuredShare : null;
  const missing = [...conversations.keys()].filter(id => !used.has(id));
  const uncovered = labeled && missing.length
    ? { topics: missing.length, share: missing.reduce((sum, id) => sum + (conversations.get(id) ?? 0), 0) / labeled } : null;
  return { rows, uncovered, weighted, logged: logged.size, labeled };
}
