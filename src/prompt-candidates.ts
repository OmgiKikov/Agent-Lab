import { MATERIAL_CHARS } from './limits.js';
import { identifierChar, regexEnd, regexMayStart, type Language } from './source-facts.js';

/*
 * Where an agent keeps its prompts besides files named «prompt»: string constants in its code (`SYSTEM_PROMPT = """…"""`,
 * `const answerPrompt = \`…\``), the system role of a chat template (`("system", SYSTEM_PROMPT)`, `{ role: 'system',
 * content: … }`, `SystemMessage(content=…)`), and JSON files whose fields hold one (an MLS-style `agent_prompt.json`).
 * Everything is read as code and structure, never run or imported: a small lexer finds identifiers, punctuation and
 * string literals, and the patterns are over those tokens. The text of a prompt is kept verbatim — an f-string or a
 * template literal keeps its `{placeholders}` — and only decoded where the language itself decodes it (`\n`). Which
 * candidates are the bot's rules is the owner's choice; nothing here judges a prompt by its words.
 */

export type PromptOrigin = 'file' | 'code' | 'json';
/** A text that may be one of the agent's prompts, and where it is. */
export interface PromptCandidate {
  /** Stable: the file relative to the project, and `#identifier` for a constant or a field — the same as long as the code names it so. */
  id: string;
  file: string;
  /** The constant, the JSON field path, or the chat template a literal system message stands in. */
  identifier?: string;
  origin: PromptOrigin;
  /** Passed as the system role of a chat template, not only named like a prompt. */
  system?: true;
  chars: number;
  /** The prompt, verbatim. */
  text: string;
}

/** Shorter literals are version tags, labels and keys, not prompts. */
export const MIN_PROMPT_CHARS = 40;
/** Candidates one file may give: a file of more is a data file, not a set of prompts. */
const PER_FILE = 60;
/** Nesting deeper than any real JSON of prompts is not descended into. */
const JSON_DEPTH = 32;

/** The lower-case words of an identifier: `SYSTEM_PROMPT_IDP` → system, prompt, idp; `answerPrompt` → answer, prompt. */
export function identifierWords(name: string): string[] {
  const words: string[] = [];
  let word = '';
  const flush = () => { if (word) words.push(word.toLocaleLowerCase('en-US')); word = ''; };
  for (let i = 0; i < name.length; i++) {
    const char = name[i]!, previous = name[i - 1];
    const upper = char !== char.toLowerCase(), lowerBefore = previous !== undefined && previous !== previous.toUpperCase();
    if (char === '_' || char === '-' || char === '.' || char === ' ') { flush(); continue; }
    if (upper && lowerBefore) flush();
    word += char;
  }
  flush();
  return words;
}

/** An identifier or a field that names a prompt: …PROMPT…, system_message, system template, instructions. */
export function namesPrompt(name: string): boolean {
  const words = identifierWords(name);
  const has = (...options: string[]) => words.some(word => options.includes(word));
  return has('prompt', 'prompts', 'промпт', 'instruction', 'instructions') || has('system') && (words.length === 1 || has('message', 'template', 'msg'));
}

/* ───────────────────────────── code ───────────────────────────── */

type Token =
  | { kind: 'name'; text: string; line: number }
  | { kind: 'string'; value: string; line: number }
  | { kind: 'punct'; text: string; line: number };

/** Two-character operators the patterns must not mistake for `=`, `:` or `(`. */
const PAIRS = new Set(['==', '!=', '<=', '>=', '=>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', ':=', '->', '**', '//']);
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`', '\n': '' };

/** A literal's text as the language gives it: common escapes decoded, a raw string or anything else left as written. */
function decoded(body: string, raw: boolean): string {
  if (raw || !body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    const next = body[i + 1];
    if (char === '\\' && next !== undefined && next in ESCAPES) { out += ESCAPES[next]; i++; }
    else out += char;
  }
  return out;
}

/** Where a JavaScript template literal opened at `start` ends; `${…}` inside it is kept as written, nested braces counted. */
function templateEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') i++;
    else if (depth === 0 && char === '`') return i;
    else if (char === '$' && source[i + 1] === '{') { depth++; i++; }
    else if (depth > 0 && char === '{') depth++;
    else if (depth > 0 && char === '}') depth--;
  }
  return source.length;
}

/** Identifiers, punctuation and string literals of a source file, comments dropped; Python's string prefixes (f, r, b, u) read with their literal. */
function tokens(source: string, language: Language): Token[] {
  const out: Token[] = [], python = language === 'python';
  let line = 1;
  const advance = (from: number, to: number) => { for (let k = from; k < to; k++) if (source[k] === '\n') line++; };
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    const start = i, at = line;
    if (char.trim() === '') { if (char === '\n') line++; i++; continue; }
    if (python ? char === '#' : source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (!python && source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); const to = end < 0 ? source.length : end + 2; advance(i, to); i = to; continue; }
    let prefix = '';
    if (python && identifierChar(char)) {
      let end = i;
      while (end < source.length && end - i < 2 && 'rRbBuUfF'.includes(source[end]!)) end++;
      if (end > i && (source[end] === '"' || source[end] === "'")) prefix = source.slice(i, end).toLowerCase();
    }
    const quoteAt = i + prefix.length, quoteChar = source[quoteAt];
    if (quoteChar === '"' || quoteChar === "'" || !python && quoteChar === '`') {
      let body: string, end: number;
      if (quoteChar === '`') { end = templateEnd(source, quoteAt); body = source.slice(quoteAt + 1, end); end += 1; }
      else {
        const quote = python && source.startsWith(quoteChar.repeat(3), quoteAt) ? quoteChar.repeat(3) : quoteChar;
        let k = quoteAt + quote.length;
        while (k < source.length && !source.startsWith(quote, k) && (quote.length === 3 || source[k] !== '\n')) k += source[k] === '\\' ? 2 : 1;
        body = source.slice(quoteAt + quote.length, k); end = Math.min(source.length, k + quote.length);
      }
      out.push({ kind: 'string', value: decoded(body, prefix.includes('r')), line: at });
      advance(start, end); i = end; continue;
    }
    // After a string literal `/` divides; after a word or a mark the source-facts rule decides.
    const previous = out.at(-1);
    if (!python && char === '/' && regexMayStart(previous === undefined ? undefined : previous.kind === 'string' ? ')' : previous.text)) {
      const end = regexEnd(source, i); advance(i, end); i = end; continue;
    }
    if (identifierChar(char)) { let end = i + 1; while (identifierChar(source[end])) end++; out.push({ kind: 'name', text: source.slice(i, end), line: at }); i = end; continue; }
    const pair = source.slice(i, i + 2);
    if (PAIRS.has(pair)) { out.push({ kind: 'punct', text: pair, line: at }); i += 2; continue; }
    out.push({ kind: 'punct', text: char, line: at }); i++;
  }
  return out;
}

const isPunct = (token: Token | undefined, text: string): boolean => token?.kind === 'punct' && token.text === text;
const nameOf = (token: Token | undefined): string | undefined => token?.kind === 'name' ? token.text : token?.kind === 'string' ? token.value : undefined;

/**
 * A string expression at `at`: literals joined by `+`, or placed side by side (Python, JavaScript inside parentheses; on
 * one line outside them), optionally in parentheses. Undefined when anything else is part of it.
 */
function literalAt(list: Token[], at: number): { value: string; end: number } | undefined {
  const open = isPunct(list[at], '(');
  let i = open ? at + 1 : at;
  if (list[i]?.kind !== 'string') return undefined;
  let value = '';
  let last = list[i]!.line;
  while (list[i]?.kind === 'string') {
    value += (list[i] as { value: string }).value;
    last = list[i]!.line; i++;
    if (isPunct(list[i], '+') && list[i + 1]?.kind === 'string') { i++; continue; }
    if (list[i]?.kind === 'string' && !open && list[i]!.line !== last) break;
  }
  if (open) { if (!isPunct(list[i], ')')) return undefined; i++; }
  return { value, end: i };
}

/** The value of an annotated assignment `NAME: type = …` whose type starts at `at`: `str`, `typing.Final[str]`, `string`. */
function annotated(list: Token[], at: number): ReturnType<typeof literalAt> {
  let k = at;
  if (list[k]?.kind !== 'name') return undefined;
  k++;
  while (isPunct(list[k], '.') && list[k + 1]?.kind === 'name') k += 2;
  if (isPunct(list[k], '[')) for (let level = 0; k < list.length; k++) {
    if (isPunct(list[k], '[')) level++;
    else if (isPunct(list[k], ']') && --level === 0) { k++; break; }
  }
  return isPunct(list[k], '=') ? literalAt(list, k + 1) : undefined;
}

/** What one source file shows: its prompt candidates, every string constant by name, and names it passes as the system role without defining them. */
export interface CodePrompts { candidates: PromptCandidate[]; constants: Map<string, string>; systemNames: Set<string> }

/** The prompt candidates of one source file (`file` relative to the project root). */
export function codePrompts(source: string, language: Language, file: string): CodePrompts {
  const list = tokens(source, language);
  const constants = new Map<string, string>();
  const found = new Map<string, PromptCandidate>();
  const systemNames = new Set<string>();
  const add = (identifier: string, text: string, system: boolean) => {
    if (text.trim().length < MIN_PROMPT_CHARS || text.length > MATERIAL_CHARS) return;
    let key = identifier;
    for (let n = 2; found.has(key) && found.get(key)!.text !== text; n++) key = `${identifier}~${n}`;
    const known = found.get(key);
    if (known) { if (system) known.system = true; return; }
    if (found.size >= PER_FILE) return;
    found.set(key, { id: `${file}#${key}`, file, identifier: key, origin: 'code', ...(system ? { system: true as const } : {}), chars: text.length, text });
  };
  // Assignments first: a system message may name a constant defined further down the file.
  let target: string | undefined, depth = 0;
  const targets: (string | undefined)[] = [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i]!;
    if (token.kind === 'punct' && '([{'.includes(token.text)) depth++;
    if (token.kind === 'punct' && ')]}'.includes(token.text)) depth = Math.max(0, depth - 1);
    const name = nameOf(token);
    // NAME = …, NAME: type = …, key: … (an object), "key": … (a dict), name=… (a keyword argument).
    let value: ReturnType<typeof literalAt>;
    // The type of an annotation (`NAME: str = …`) is no constant of its own.
    if (name !== undefined && isPunct(list[i + 1], '=') && !isPunct(list[i - 1], ':')) value = literalAt(list, i + 2);
    else if (name !== undefined && isPunct(list[i + 1], ':')) value = literalAt(list, i + 2) ?? (token.kind === 'name' ? annotated(list, i + 2) : undefined);
    if (depth === 0 && token.kind === 'name' && isPunct(list[i + 1], '=')) target = token.text;
    targets[i] = target;
    if (!value || name === undefined) continue;
    if (!constants.has(name)) constants.set(name, value.value);
    if (namesPrompt(name)) add(name, value.value, false);
  }
  // The system role of a chat template: ("system", X), { role: "system", content: X }, SystemMessage(content=X).
  const systemValue = (at: number, where: string) => {
    const literal = literalAt(list, at);
    if (literal) return add(`${where}:system`, literal.value, true);
    const name = list[at]?.kind === 'name' ? (list[at] as { text: string }).text : undefined;
    if (!name) return;
    const text = constants.get(name);
    if (text !== undefined) add(name, text, true); else systemNames.add(name);
  };
  for (let i = 0; i < list.length; i++) {
    const token = list[i]!;
    const where = targets[i] ?? 'template';
    if ((isPunct(token, '(') || isPunct(token, '[')) && list[i + 1]?.kind === 'string' && (list[i + 1] as { value: string }).value === 'system' && isPunct(list[i + 2], ',')) systemValue(i + 3, where);
    if (nameOf(token) === 'role' && isPunct(list[i + 1], ':') && list[i + 2]?.kind === 'string' && (list[i + 2] as { value: string }).value === 'system') {
      // The content of the same object, before or after the role, at the object's own level.
      let open = i, level = 0;
      for (; open >= 0; open--) { const t = list[open]!; if (isPunct(t, '}')) level++; else if (isPunct(t, '{')) { if (level === 0) break; level--; } }
      if (open < 0) continue;
      for (let k = open + 1, inner = 0; k < list.length; k++) {
        const t = list[k]!;
        if (isPunct(t, '{') || isPunct(t, '[') || isPunct(t, '(')) inner++;
        else if (isPunct(t, '}') || isPunct(t, ']') || isPunct(t, ')')) { if (inner === 0) break; inner--; }
        else if (inner === 0 && nameOf(t) === 'content' && isPunct(list[k + 1], ':')) { systemValue(k + 2, where); break; }
      }
    }
    if (token.kind === 'name') {
      const words = identifierWords(token.text);
      if (!words.includes('system') || !words.includes('message')) continue;
      let k = i + 1;
      if (isPunct(list[k], '.') && list[k + 1]?.kind === 'name') k += 2;
      if (!isPunct(list[k], '(')) continue;
      systemValue(nameOf(list[k + 1]) === 'content' && isPunct(list[k + 2], '=') ? k + 3 : k + 1, where);
    }
  }
  return { candidates: [...found.values()], constants, systemNames };
}

/* ───────────────────────────── JSON ───────────────────────────── */

/** A field path as written in JavaScript: `prompt`, `messages[0].content`, `["system prompt"]`. */
function pathOf(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  const plain = key.length > 0 && [...key].every(char => identifierChar(char)) && !(key[0]! >= '0' && key[0]! <= '9');
  return plain ? parent ? `${parent}.${key}` : key : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * The prompt fields of a parsed JSON file: every long string in a file named like a prompt, else the long strings under a
 * key that names one (prompt, system, template, instructions) or the content of a message whose role is system.
 */
export function jsonPrompts(raw: unknown, file: string, fileNamesPrompt: boolean): PromptCandidate[] {
  const found: PromptCandidate[] = [];
  const visit = (value: unknown, path: string, named: boolean, system: boolean, depth: number) => {
    if (found.length >= PER_FILE || depth > JSON_DEPTH) return;
    if (typeof value === 'string') {
      if ((named || system || fileNamesPrompt) && value.trim().length >= MIN_PROMPT_CHARS && value.length <= MATERIAL_CHARS) {
        found.push({ id: path ? `${file}#${path}` : file, file, ...(path ? { identifier: path } : {}), origin: 'json', ...(system ? { system: true as const } : {}), chars: value.length, text: value });
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, pathOf(path, index), named, false, depth + 1)); return; }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const systemMessage = record.role === 'system';
    for (const [key, item] of Object.entries(record)) {
      const words = identifierWords(key);
      visit(item, pathOf(path, key), named || namesPrompt(key) || words.includes('system') || words.includes('template'), systemMessage && key === 'content', depth + 1);
    }
  };
  visit(raw, '', false, false, 0);
  return found;
}
