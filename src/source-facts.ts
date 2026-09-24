import { extname } from 'node:path';

/*
 * What a source file shows about speaking to Agent Lab, read as code and never run or imported:
 * whether it exports the module contract, whether it answers JSON lines over stdin, whether it
 * names the fields of a Lab request. A small lexer drops comments and consumes strings, template
 * literals and regular expressions whole, so text inside them never reads as code.
 */

export type Language = 'python' | 'node';
const LANGUAGES: Record<string, Language> = { '.py': 'python', '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.ts': 'node', '.mts': 'node', '.cts': 'node' };
/** The language of a program file Lab can start (`.d.ts` declarations never run); undefined for anything else. */
export const languageOf = (file: string): Language | undefined => file.endsWith('.d.ts') ? undefined : LANGUAGES[extname(file).toLowerCase()];
/** The function a module target calls by default (its `exportName`). */
export const FACTORY = 'createSession';
export interface CodeFacts { factory: boolean; jsonLines: boolean; protocol: boolean }

/** Keywords after which `/` opens a regular expression rather than divides. */
const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
export const identifierChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
const until = (source: string, mark: string, from: number): number => { const at = source.indexOf(mark, from); return at < 0 ? source.length : at + mark.length; };

/** The words (identifiers, single punctuation marks) and the string literals of a source file, comments dropped. */
function lex(source: string, language: Language): { words: string[]; strings: Set<string> } {
  const words: string[] = [], strings = new Set<string>(), python = language === 'python';
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (char.trim() === '') i++;
    else if (python ? char === '#' : source.startsWith('//', i)) i = until(source, '\n', i);
    else if (!python && source.startsWith('/*', i)) i = until(source, '*/', i + 2);
    else if (char === '"' || char === "'" || !python && char === '`') {
      const quote = python && source.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      let end = i + quote.length;
      while (end < source.length && !source.startsWith(quote, end)) end += source[end] === '\\' ? 2 : 1;
      strings.add(source.slice(i + quote.length, end));
      i = end + quote.length;
    } else if (!python && char === '/' && regexMayStart(words.at(-1))) i = regexEnd(source, i);
    else if (identifierChar(char)) { let end = i + 1; while (identifierChar(source[end])) end++; words.push(source.slice(i, end)); i = end; }
    else { words.push(char); i++; }
  }
  return { words, strings };
}
/** Whether `/` after `previous` (the last word) opens a regular expression rather than divides. */
export const regexMayStart = (previous: string | undefined): boolean =>
  previous === undefined || BEFORE_REGEX.has(previous) || !identifierChar(previous[0]) && !')]}'.includes(previous);
/** Where the regular expression literal opened at `start` ends. */
export function regexEnd(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') i++;
    else if (char === '\n') return i; // a division after all: go on from the next line
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) { i++; while (identifierChar(source[i])) i++; return i; }
  }
  return source.length;
}

/** ESM `export [async] function|const createSession`, `export { … as createSession }`, CommonJS `exports.createSession =` or `module.exports = { createSession }`. */
function exportsFactory(w: string[]): boolean {
  return w.some((word, i) => {
    if (word === 'export') {
      const j = w[i + 1] === 'async' ? i + 2 : i + 1;
      if (w[j] === 'function') return w[j + 1] === FACTORY || w[j + 1] === '*' && w[j + 2] === FACTORY;
      if (w[j] === 'const' || w[j] === 'let' || w[j] === 'var') return w[j + 1] === FACTORY;
      if (w[j] === '{') for (let k = j + 1; k < w.length && w[k] !== '}'; k++) if (w[k] === FACTORY ? w[k + 1] !== 'as' : w[k] === 'as' && w[k + 1] === FACTORY) return true;
      return false;
    }
    if (word === 'exports' && w[i + 1] === '.' && w[i + 2] === FACTORY && w[i + 3] === '=') return true;
    if (word !== 'module' || w[i + 1] !== '.' || w[i + 2] !== 'exports' || w[i + 3] !== '=' || w[i + 4] !== '{') return false;
    for (let k = i + 5, depth = 1; k < w.length && depth > 0; k++) {
      if (w[k] === '{') depth++;
      else if (w[k] === '}') depth--;
      else if (depth === 1 && w[k] === FACTORY && (w[k - 1] === '{' || w[k - 1] === ',')) return true;
    }
    return false;
  });
}

/** The module contract (Node only), a JSON-lines loop over stdin, and the Lab request field names a file uses. */
export function codeFacts(source: string, language: Language): CodeFacts {
  const { words, strings } = lex(source, language);
  const has = (...sequence: string[]) => words.some((_, i) => sequence.every((word, k) => words[i + k] === word));
  const jsonLines = language === 'python'
    ? (has('sys', '.', 'stdin') || has('input', '(')) && has('json', '.', 'loads') && has('json', '.', 'dumps')
    : has('process', '.', 'stdin') && has('JSON', '.', 'parse') && has('JSON', '.', 'stringify');
  const protocol = ['sessionId', 'initialState'].some(name => strings.has(name) || words.includes(name));
  return { factory: language === 'node' && exportsFactory(words), jsonLines, protocol };
}
