import { simulatorWasUsed, type Experiment, type Realism } from './contracts.js';
import { normalizeText, type CardEvidence } from './card/checks.js';

/*
 * How close the customers Lab played are to the real ones, told without a model and apart from whether they kept to
 * their situation (the judge's fidelity rubric): for the situations made from a logged conversation, the synthetic
 * customer's messages after the opening against the logged customer's — how many and how long. It never calls a
 * customer «human»: it says whether the two differ in what most changes an agent's task — how much a customer writes,
 * and how long they stay. Stored with the run (lab/run.ts); never moves the number.
 *
 *   trial (the customer played by Lab) ──its card, from a log──► the logged conversation (the card's account of it)
 *        synthetic: the customer's messages after the opening  ⟷  logged: the customer's messages the card accounts for
 *        ─► over the run: messages a conversation, words a message
 */

const words = (text: string): number => normalizeText(text).split(' ').filter(Boolean).length;

/** The comparison over the run's conversations whose situation has a logged conversation at hand; undefined without one. */
export function customerRealism(record: Pick<Experiment, 'trials' | 'librarySnapshot' | 'positiveControlScenarioIds'>, evidence: CardEvidence): Realism | undefined {
  const library = record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot : undefined;
  if (!library) return undefined;
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  const sides = { synthetic: { conversations: 0, messages: 0, words: 0 }, logged: { conversations: 0, messages: 0, words: 0 } };
  for (const trial of record.trials) {
    const card = library.cards.find(item => item.id === trial.scenarioId);
    if (!card || card.origin.kind !== 'dialogue' || controls.has(trial.scenarioId) || !simulatorWasUsed(trial)) continue;
    const logged = evidence.messages(card.origin.batchId, card.origin.dialogueId);
    if (!logged) continue;
    // The card accounts for every customer message of its conversation but the opening, which both sides share word for word.
    const later = card.coverage.flatMap(entry => logged.find(message => message.index === entry.event.eventIndex)?.content ?? []);
    const played = trial.events.filter(event => event.type === 'user').slice(1).map(event => event.text ?? '');
    sides.synthetic.conversations++; sides.synthetic.messages += played.length; sides.synthetic.words += played.reduce((sum, text) => sum + words(text), 0);
    sides.logged.conversations++; sides.logged.messages += later.length; sides.logged.words += later.reduce((sum, text) => sum + words(text), 0);
  }
  const conversations = sides.synthetic.conversations;
  if (!conversations) return undefined;
  const of = (side: typeof sides.synthetic) => ({ messages: side.messages / side.conversations, words: side.messages ? side.words / side.messages : 0 });
  return { conversations, synthetic: of(sides.synthetic), logged: of(sides.logged) };
}
