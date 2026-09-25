import { simulatorWasUsed, type Experiment, type Realism } from './contracts.js';
import { normalizeText, type CardEvidence } from './card/checks.js';

/*
 * How close the customers Lab played are to the real ones, told without a model and apart from whether they kept to
 * their situation (the judge's fidelity rubric): for the situations made from a logged conversation, what the customer
 * wrote after their request — the synthetic customer after its opening, the logged customer after the message the card's
 * opening was taken from — how many messages and how long. Both sides are counted from the same point: a greeting the
 * real customer wrote before the request is not a later message. It never calls a customer «human»: it says whether the
 * two differ in what most changes an agent's task — how much a customer writes, and how long they stay. Stored with the
 * run (lab/run.ts); never moves the number.
 *
 *   trial (the customer played by Lab) ──its card, from a log──► the logged conversation
 *        synthetic: the customer's messages after the opening  ⟷  logged: the customer's messages after the request
 *        ─► over the run: messages a conversation, words a message ─► realismDifference: markedly more or fewer of either
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
    const { batchId, dialogueId } = card.origin;
    const logged = evidence.messages(batchId, dialogueId);
    if (!logged) continue;
    // The request is the logged message the card's opening was taken from; a card that wrote its own opening counts from
    // the customer's first message, as the log judge does (calibration-scope.ts logSkip).
    const source = card.client.writesSource;
    const request = source.kind === 'dialogue' && source.event.batchId === batchId && source.event.dialogueId === dialogueId ? source.event.eventIndex
      : logged.find(message => message.role === 'user')?.index;
    if (request === undefined) continue;
    const later = logged.filter(message => message.role === 'user' && message.index > request).map(message => message.content);
    const played = trial.events.filter(event => event.type === 'user').slice(1).map(event => event.text ?? '');
    sides.synthetic.conversations++; sides.synthetic.messages += played.length; sides.synthetic.words += played.reduce((sum, text) => sum + words(text), 0);
    sides.logged.conversations++; sides.logged.messages += later.length; sides.logged.words += later.reduce((sum, text) => sum + words(text), 0);
  }
  const conversations = sides.synthetic.conversations;
  if (!conversations) return undefined;
  const of = (side: typeof sides.synthetic) => ({ messages: side.messages / side.conversations, words: side.messages ? side.words / side.messages : 0 });
  return { conversations, synthetic: of(sides.synthetic), logged: of(sides.logged) };
}

/** A share this far from one either way is a marked difference: half as much again, or two thirds and less. */
const MORE = 1.5, FEWER = 2 / 3;

/**
 * Where the played customer differs markedly from the logged one, in each measure and either direction: `messages` after
 * the request (a conversation's mean, and at least one message apart — a fraction of a message is no difference to an
 * agent), `words` in a message (only where both sides wrote after the request). Null where they are alike, or where the
 * logged side gives nothing to compare with.
 */
export function realismDifference(realism: Pick<Realism, 'synthetic' | 'logged'>): { messages: 'more' | 'fewer' | null; words: 'more' | 'fewer' | null } {
  const { synthetic, logged } = realism;
  const apart = Math.abs(synthetic.messages - logged.messages) >= 1;
  const messages = !apart ? null : logged.messages === 0 || synthetic.messages >= MORE * logged.messages ? 'more' : synthetic.messages <= FEWER * logged.messages ? 'fewer' : null;
  const ratio = synthetic.messages && logged.messages && logged.words ? synthetic.words / logged.words : null;
  const wordy = ratio === null ? null : ratio >= MORE ? 'more' : ratio <= FEWER ? 'fewer' : null;
  return { messages, words: wordy };
}
