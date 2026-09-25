import type { Source } from '../contracts.js';
import { referencesSchema, type Reference } from '../reference.js';
import { normalizeText } from './checks.js';

/*
 * The assessor's markup of one logged conversation, read into the reference of the situation made from it. A column
 * of the table said what it holds (spreadsheet/mapping.ts EXPECTED_KINDS); the import carried the cells with the
 * conversation (`original.expected`). An expected answer that stands word for word in an article of the knowledge
 * base names that article too, by the article's heading; a short answer with no spaces in it is an answer code.
 * Nothing here is guessed from a model: what is not found stays text for the judge.
 *
 *   original.expected ─► article id ─────────────────► source.doc
 *                     ─► article id or code ─┬─ an article of the base ─► source.doc
 *                                            └─ else ─► outcome
 *                     ─► code ───────────────────────► outcome
 *                     ─► answer ─┬─ one word ────────► outcome
 *                                ├─ in an article ───► source.doc + text
 *                                └─ elsewhere ───────► text
 */

/** A code is a single word of this many characters at most: «202-2», «404». A sentence is never read as one. */
const CODE_CHARS = 40;
const TEXT_CHARS = 1000;

interface Expected { kind: 'answer' | 'article' | 'code' | 'article_or_code'; value: string }

/** The reference the assessor's markup gives a situation; undefined when the conversation carries none. */
export function assessorReference(original: unknown, sources: readonly Source[]): Reference[] | undefined {
  const expected = expectedOf(original);
  if (!expected.length) return undefined;
  let doc: string | undefined, text: string | undefined, code: string | undefined;
  for (const item of expected) {
    const value = item.value.trim();
    if (item.kind === 'article' || item.kind === 'article_or_code' && articleIds(sources).has(value)) doc ??= value.slice(0, 500);
    else if (item.kind === 'code' || isCode(value)) code ??= value;
    else {
      doc ??= articleOf(value, sources);
      if (value.length <= TEXT_CHARS) text ??= value;
    }
  }
  if (doc === undefined && text === undefined && code === undefined) return undefined;
  const references = referencesSchema.safeParse([{ id: 'assessor', origin: 'assessor', confirmed: true,
    ...doc !== undefined ? { source: { doc } } : {}, ...text !== undefined ? { text } : {}, ...code !== undefined ? { outcome: { value: code } } : {} }]);
  return references.success ? references.data : undefined;
}

function expectedOf(original: unknown): Expected[] {
  const list = original && typeof original === 'object' ? (original as { expected?: unknown }).expected : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => item && typeof item === 'object' && ['answer', 'article', 'code', 'article_or_code'].includes((item as Expected).kind)
    && typeof (item as Expected).value === 'string' && (item as Expected).value.trim() ? [item as Expected] : []);
}

const isCode = (value: string): boolean => value.length <= CODE_CHARS && !/\s/.test(value);

/**
 * The article of the knowledge base whose text is the expected answer, word for word after the one normalisation: its
 * id is the heading over it — the last word of the heading when that word holds a digit («Статья 24» → «24»), else the
 * whole heading. Undefined when no article holds it, or when two different articles do.
 */
export function articleOf(answer: string, sources: readonly Source[]): string | undefined {
  const wanted = normalizeText(answer);
  const found = new Set(sources.filter(source => source.kind !== 'prompt').flatMap(source => sections(source.content))
    .filter(section => normalizeText(section.body) === wanted || normalizeText(section.body).includes(wanted) && wanted.length >= 80).map(section => section.id));
  return found.size === 1 ? [...found][0] : undefined;
}

/** The ids of every article of the knowledge base, as their headings name them. */
const articleIds = (sources: readonly Source[]): Set<string> =>
  new Set(sources.filter(source => source.kind !== 'prompt').flatMap(source => sections(source.content)).map(section => section.id));

/** The sections of a Markdown text: each heading line and the text under it up to the next heading. */
function sections(content: string): { id: string; body: string }[] {
  const out: { id: string; body: string }[] = [];
  let current: { id: string; lines: string[] } | undefined;
  for (const line of content.split('\n')) {
    const heading = line.startsWith('#') ? line.replace(/^#+/, '').trim() : undefined;
    if (heading) {
      if (current) out.push({ id: current.id, body: current.lines.join('\n') });
      const last = heading.split(/\s+/).at(-1) ?? heading;
      current = { id: (/\d/.test(last) ? last : heading).slice(0, 500), lines: [] };
    } else current?.lines.push(line);
  }
  if (current) out.push({ id: current.id, body: current.lines.join('\n') });
  return out.filter(section => section.body.trim());
}
