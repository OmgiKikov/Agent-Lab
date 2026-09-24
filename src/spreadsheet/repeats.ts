/*
 * Some exports copy exchanges: the same client message and agent reply stand two to six times in a row, or
 * the last exchange twice. Read as written, each copy is a turn that never happened — the client asking
 * again and the agent answering the same. Only the owner can tell an export's copies from a client who
 * really said the same thing twice, so nothing is dropped unless the owner chose it (the mapping's
 * `collapseRepeats`); what a choice would drop is counted either way, for the owner to decide on.
 */

/** A message as copies are told apart: who writes it and what it says. */
interface Said { role?: string; content: string }

const same = (a: Said, b: Said) => a.role === b.role && a.content === b.content;

/**
 * The messages with every repeated block read once: when a block of consecutive messages is immediately
 * followed by the same block (same roles, same texts; a block of one message or more), the copy is dropped
 * — repeatedly, left to right, so an exchange written four times stays once. A client's message that comes
 * back later with another reply around it is no copy and stays.
 */
export function withoutRepeats<T extends Said>(messages: readonly T[]): T[] {
  const kept: T[] = [];
  for (const message of messages) {
    kept.push(message);
    // What was kept before holds no block followed by its copy, so a copy can only end at the message just added;
    // dropping it leaves a beginning of what was kept before, which holds none either.
    for (let length = 1; length * 2 <= kept.length; length++) {
      const start = kept.length - 2 * length;
      let copy = true;
      for (let i = 0; i < length && copy; i++) copy = same(kept[start + i]!, kept[start + length + i]!);
      if (copy) { kept.length -= length; break; }
    }
  }
  return kept;
}
