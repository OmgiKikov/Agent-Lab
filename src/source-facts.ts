import { extname } from 'node:path';

/*
 * What a source file shows about speaking to Agent Lab, read as code and never run or imported:
 * whether it exports the module contract, whether it answers JSON lines over stdin, whether it
 * names the fields of a Lab request, whether it runs anything when started, and which modules'
 * functions it runs. A small lexer drops comments and consumes strings, template literals and
 * regular expressions whole, so text inside them never reads as code; it keeps where each word
 * stands — a Python statement's indentation, whether a Node word is inside a function's body.
 */

export type Language = 'python' | 'node';
const LANGUAGES: Record<string, Language> = { '.py': 'python', '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.ts': 'node', '.mts': 'node', '.cts': 'node' };
/** The language of a program file Lab can start (`.d.ts` declarations never run); undefined for anything else. */
export const languageOf = (file: string): Language | undefined => file.endsWith('.d.ts') ? undefined : LANGUAGES[extname(file).toLowerCase()];
/** The function a module target calls by default (its `exportName`). */
export const FACTORY = 'createSession';
/**
 * `entry`: the file does something when started — a `__main__` guard, a stdin loop or a call of a function of its own
 * or imported at the top of a Python file, a stdin read or such a call outside every function of a Node file; a file
 * that only defines its loop runs nothing. `runs`: the modules whose imported functions a Python file calls
 * (`from lab.protocol import serve` … `serve(…)` → `lab.protocol`), leading dots of a relative import kept.
 */
export interface CodeFacts { factory: boolean; jsonLines: boolean; protocol: boolean; entry: boolean; runs: string[] }

/** Keywords after which `/` opens a regular expression rather than divides. */
const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
export const identifierChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
const until = (source: string, mark: string, from: number): number => { const at = source.indexOf(mark, from); return at < 0 ? source.length : at + mark.length; };

/**
 * Where a word stands: a Python word's line indentation and whether it opens a statement (the first word of a line
 * outside brackets); a Node word's number of enclosing function bodies.
 */
interface Place { indent: number; start: boolean; functions: number }
/** Python statements that only define: nothing in them runs when the file starts. */
const DEFINITIONS = new Set(['def', 'class', 'async', '@', 'import', 'from']);
/** Words after which a Node `( … ) {` opens a block of statements, not a function's body. */
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/** The words (identifiers, single punctuation marks) and the string literals of a source file, comments dropped; each word's place. */
function lex(source: string, language: Language): { words: string[]; strings: Set<string>; places: Place[] } {
  const words: string[] = [], strings = new Set<string>(), places: Place[] = [], python = language === 'python';
  let indent = 0, lineStart = true, brackets = 0, functions = 0, lastOpened = -1;
  const opened: number[] = [], braces: boolean[] = [];
  const indentAt = (from: number) => { let end = from; while (source[end] === ' ' || source[end] === '\t') end++; return end; };
  const push = (word: string) => { places.push({ indent, start: lineStart && brackets === 0, functions }); words.push(word); lineStart = false; };
  for (let i = indentAt(0); i < source.length;) {
    const char = source[i]!;
    if (char === '\n') { const next = indentAt(i + 1); indent = next - i - 1; lineStart = true; i = next; }
    else if (char.trim() === '') i++;
    else if (python && char === '\\' && source[i + 1] === '\n') i += 2; // a line continued: the next one opens no statement
    else if (python ? char === '#' : source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; }
    else if (!python && source.startsWith('/*', i)) i = until(source, '*/', i + 2);
    else if (char === '"' || char === "'" || !python && char === '`') {
      const quote = python && source.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      let end = i + quote.length;
      while (end < source.length && !source.startsWith(quote, end)) end += source[end] === '\\' ? 2 : 1;
      strings.add(source.slice(i + quote.length, end));
      lineStart = false;
      i = end + quote.length;
    } else if (!python && char === '/' && regexMayStart(words.at(-1))) i = regexEnd(source, i);
    else if (identifierChar(char)) { let end = i + 1; while (identifierChar(source[end])) end++; push(source.slice(i, end)); i = end; }
    else {
      if (python && '([{'.includes(char)) brackets++;
      if (python && ')]}'.includes(char)) brackets = Math.max(0, brackets - 1);
      if (!python && char === '(') opened.push(words.length);
      if (!python && char === ')') lastOpened = opened.pop() ?? -1;
      if (!python && char === '{') {
        // A function's body: after `=>`, or after `( … )` that no if/for/while/switch/catch heads (`for await (…)` too).
        const previous = words.at(-1), head = words[lastOpened - 1];
        const body = previous === '>' && words.at(-2) === '=' || previous === ')' && head !== undefined
          && !BLOCK_HEADS.has(head) && !(head === 'await' && words[lastOpened - 2] === 'for');
        braces.push(body);
        push(char);
        if (body) functions++;
      } else if (!python && char === '}') { if (braces.pop()) functions--; push(char); }
      else push(char);
      i++;
    }
  }
  return { words, strings, places };
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

/** Whether the file's code — not a comment or a string — uses the word: the `respond` of the session a module returns. */
export const codeHasWord = (source: string, language: Language, word: string): boolean => lex(source, language).words.includes(word);

/**
 * The names a Python file imports with `from MODULE import …`, by module: `from lab.protocol import serve as run` →
 * lab.protocol: run; `from common import *` → common: `*`, every name the file does not define itself.
 */
function pythonImports(words: readonly string[], places: readonly Place[]): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'from' || !places[i]!.start) continue;
    let j = i + 1, module = '';
    while (j < words.length && words[j] !== 'import' && !places[j]!.start) module += words[j++];
    if (words[j] !== 'import' || !module) continue;
    const names = imports.get(module) ?? new Set<string>();
    for (j++; j < words.length && !places[j]!.start; j++) {
      const word = words[j]!;
      if (word === '*') names.add('*');
      else if (identifierChar(word[0]) && word !== 'as') names.add(words[j + 1] === 'as' && words[j + 2] ? words[(j += 2)]! : word);
    }
    imports.set(module, names);
  }
  return imports;
}

/** The module contract (Node only), a JSON-lines loop over stdin, the Lab request field names a file uses, whether it runs anything, what it runs. */
export function codeFacts(source: string, language: Language): CodeFacts {
  const { words, strings, places } = lex(source, language);
  const at = (i: number, ...sequence: string[]) => sequence.every((word, k) => words[i + k] === word);
  const has = (...sequence: string[]) => words.some((_, i) => at(i, ...sequence));
  const python = language === 'python';
  const stdin = (i: number) => python ? at(i, 'sys', '.', 'stdin') || at(i, 'input', '(') : at(i, 'process', '.', 'stdin');
  const jsonLines = python ? words.some((_, i) => stdin(i)) && has('json', '.', 'loads') && has('json', '.', 'dumps')
    : words.some((_, i) => stdin(i)) && has('JSON', '.', 'parse') && has('JSON', '.', 'stringify');
  const protocol = ['sessionId', 'initialState'].some(name => strings.has(name) || words.includes(name));
  // What the file defines and imports; a call of one of them where the file runs code on its start makes it a program.
  const own = new Set(words.flatMap((word, i) => (word === 'def' || word === 'function') && words[i + 1] && identifierChar(words[i + 1]![0]) ? [words[i + 1]!] : []));
  const imports = python ? pythonImports(words, places) : new Map<string, Set<string>>();
  const importedFrom = (name: string) => [...imports].filter(([, names]) => names.has(name) || names.has('*') && !own.has(name)).map(([module]) => module);
  const called = (i: number) => identifierChar(words[i]![0]) && words[i + 1] === '(' && !['def', 'function', '.', 'new', 'class'].includes(words[i - 1] ?? '');
  // Where code runs on start: in a Python statement at the top of the file — not a definition —, in Node outside every function's body.
  const heads: number[] = [];
  for (let i = 0, head = 0; i < words.length; i++) { if (places[i]!.start) head = i; heads.push(head); }
  const top = (i: number) => python ? places[heads[i]!]!.indent === 0 && !DEFINITIONS.has(words[heads[i]!]!) : places[i]!.functions === 0;
  const mainGuard = python && strings.has('__main__') && (has('__name__', '=', '=') || has('=', '=', '__name__'));
  const runs = new Set<string>();
  let entry = mainGuard;
  for (let i = 0; i < words.length; i++) {
    if (top(i) && stdin(i)) entry = true;
    if (!called(i)) continue;
    const name = words[i]!, from = importedFrom(name);
    for (const module of from) runs.add(module);
    if (top(i) && (own.has(name) || from.length)) entry = true;
  }
  return { factory: language === 'node' && exportsFactory(words), jsonLines, protocol, entry, runs: python ? [...runs] : [] };
}
