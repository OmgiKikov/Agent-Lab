/*
 * Interface elements a chat platform writes into an agent's message — a button, a card, a transition to a screen — as a
 * fenced block (```transition-code … ```), and as an export flattens it: its line breaks turned into spaces, its backticks
 * standing apart («` ` ` transition-code ACQUIRING_AGENT-REPORT_CREATE ` ` `»). The customer sees the element, not the
 * words inside it; read as the agent's words, it is «an internal system named to the customer». So a reading the owner
 * confirmed (`interfaceMarkup: 'fenced'`) puts one mark of the element in place of each block. Structure only: fences are
 * found by their characters, and the words inside a block are never read.
 */

/** What stands in a message where an interface element was. */
export const INTERFACE_ELEMENT = '(элемент интерфейса)';

/** The index right after a fence starting at `at` — three backticks, each apart from the next by at most one space — or -1. */
function fenceEnd(content: string, at: number): number {
  let index = at;
  for (let ticks = 0; ticks < 3; ticks++) {
    if (ticks && content[index] === ' ' && content[index + 1] === '`') index++;
    if (content[index] !== '`') return -1;
    index++;
  }
  return index;
}

/** The first fence at or after `from`: where it starts and the index after it; undefined when none is left. */
function nextFence(content: string, from: number): { start: number; end: number } | undefined {
  for (let tick = content.indexOf('`', from); tick >= 0; tick = content.indexOf('`', tick + 1)) {
    const end = fenceEnd(content, tick);
    if (end >= 0) return { start: tick, end };
  }
  return undefined;
}

/** The fenced blocks of a message, each from its opening fence to the end of its closing one; a fence left open is none. */
export function fencedBlocks(content: string): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  for (let open = nextFence(content, 0); open; ) {
    const close = nextFence(content, open.end);
    if (!close) break;
    blocks.push({ start: open.start, end: close.end });
    open = nextFence(content, close.end);
  }
  return blocks;
}

/** A message with each fenced block replaced by the mark of an interface element; unchanged when it holds none. */
export function withoutInterfaceMarkup(content: string): string {
  const blocks = fencedBlocks(content);
  if (!blocks.length) return content;
  let read = '', at = 0;
  for (const block of blocks) {
    read += `${content.slice(at, block.start)}${INTERFACE_ELEMENT}`;
    at = block.end;
  }
  return read + content.slice(at);
}
