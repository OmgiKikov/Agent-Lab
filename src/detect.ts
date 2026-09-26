import type { Dirent } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONNECTION_FORMAT, readConnection } from './connection.js';
import { runnableTargetSchema, type RunnableTarget } from './contracts.js';
import { parseImportText } from './imports.js';
import { IMPORT_DIALOGUE_LIMIT, IMPORT_FILE_BYTES, MATERIAL_CHARS } from './limits.js';
import { MATERIAL_EXTENSIONS, materialText } from './materials.js';
import { codePrompts, jsonPrompts, MIN_PROMPT_CHARS, type PromptCandidate } from './prompt-candidates.js';
import { countText, pluralForm } from './plural.js';
import { logImport, sampleWords, type Verdict } from './scenario-library.js';
import type { LeftOutIssue } from './scenario-contracts.js';
import { codeFacts, codeHasWord, FACTORY, languageOf, type CodeFacts, type Language } from './source-facts.js';
import { proposeTableBytes } from './spreadsheet/import.js';
import { TABLE_EXTENSIONS } from './spreadsheet/workbook.js';

/*
 * What Lab can tell about a project folder before asking the owner anything: how to reach the agent,
 * which files hold logged conversations, where the knowledge base and the agent's prompts are — files named so, string
 * constants in its code and prompt fields of its JSON (prompt-candidates.ts), each offered for the owner to choose. It only
 * reads, within fixed caps: it never runs or imports a file, never follows a link out of the folder,
 * and never keeps a secret (a .env file yields variable names; a local address loses its credentials
 * and query). Every finding names the file it came from; the owner confirms before anything runs.
 * The agent is recognised by evidence of a contract, never by a name alone: a module by createSession and the
 * respond of the session it returns, a local address only under a key that names the agent — never a model
 * server's (Ollama, LM Studio and the like) — and an address is always the owner's pick, never a sure candidate.
 */

/** One observation behind an agent candidate, made in `file` (relative to the project root). */
export type AgentEvidence =
  | { kind: 'connection'; file: string }                              // a saved Agent Lab connection
  | { kind: 'script'; file: string; name: string; command: string }  // package.json: scripts.start = python agent.py
  | { kind: 'factory'; file: string }                                 // exports createSession returning a session with respond
  | { kind: 'json_lines'; file: string }                              // reads requests from stdin line by line, answers JSON
  | { kind: 'runs'; file: string; helper: string }                    // a program that runs the JSON-lines loop a helper module defines
  | { kind: 'no_entry'; file: string }                                // defines its loop, but started it runs nothing
  | { kind: 'protocol_fields'; file: string }                         // names the fields of an Agent Lab request
  | { kind: 'url'; file: string; url: string }                        // a local address under a key that names the agent
  | { kind: 'interpreter'; file: string };                            // the project's own Python environment: .venv/bin/python
export type Confidence = 'high' | 'medium' | 'low';
/** A connection target ready for use (absolute paths) and why Lab believes it is the agent. */
export interface AgentCandidate { target: RunnableTarget; confidence: Confidence; evidence: AgentEvidence[] }
/**
 * A file the import accepts as logged conversations; `complete: false` counted only the beginning of a file too big to import whole.
 * A spreadsheet (`table`) is counted under the reading Lab proposes, which the owner confirms before the import; `question`: Lab
 * sees the conversations but must ask one thing first (a marker or a role it does not know, the id column), so nothing is counted as rejected yet.
 */
/** `roles`: role names of the log's conversations Lab does not know — who writes under them is asked before a preparation. */
export interface LogFile { file: string; dialogues: number; rejected: number; complete: boolean; table?: 'ready' | 'question'; roles?: string[] }
export interface MaterialFolder { folder: string; documents: number }
/** Paths are relative to `root`, except inside `target`. */
export interface ProjectDetection {
  root: string; agents: AgentCandidate[]; logs: LogFile[]; materials: MaterialFolder[];
  /** Texts that may be the agent's prompts, verbatim; which of them are the bot's rules the owner chooses. */
  prompts: PromptCandidate[];
  /** Variable names from the .env files in the root; the values never enter the result. */
  env: { files: string[]; names: string[] };
  /** A cap stopped the walk or the reading early, so something may be missing. */
  truncated: boolean;
}

const LIMITS = { depth: 5, entries: 20_000, reads: 800, bytes: 48_000_000, textBytes: 256_000, headBytes: 1_000_000, configDepth: 2 };
/** Dependencies, builds, caches and tests. Hidden folders (.git, .agent-lab, .context, .venv) are skipped as well. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', 'venv', '__pycache__', 'site-packages', 'test', 'tests', '__tests__']);
/** Folder names that usually hold a knowledge base. */
const KNOWLEDGE = new Set(['knowledge', 'knowledge-base', 'knowledge_base', 'kb', 'wiki', 'faq', 'articles', 'materials', 'docs', 'documents', 'rag', 'corpus', 'база-знаний', 'статьи', 'материалы']);
const CONFIGS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf']);
/** Interpreters a package script may start the agent with; anything else is a tool, not the agent. */
const INTERPRETERS = new Set(['python', 'python3', 'node', 'tsx', 'bun']);
/** Scripts that conventionally start the program itself. */
const RUN_SCRIPTS = new Set(['start', 'agent', 'bot', 'serve']);
/** Characters of shell syntax (chains, pipes, variables, quoting): such a script is not one plain command. */
const SHELL = '&|;<>$`"\'()*';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
/** Words of a config key that name the agent itself. */
const AGENT_WORDS = new Set(['agent', 'bot', 'chatbot', 'assistant']);
/** Words of a config key that name a model server or a model client: such an address is the agent's model, not the agent. */
const MODEL_WORDS = new Set(['llm', 'llms', 'model', 'models', 'ollama', 'openai', 'lmstudio', 'vllm', 'llama', 'llamacpp', 'gpt', 'gigachat', 'anthropic', 'mistral',
  'embedding', 'embeddings', 'completion', 'completions', 'inference', 'tgi', 'kobold', 'koboldcpp', 'gpt4all', 'localai', 'jan']);
/** Ports model servers listen on by default: Ollama, LM Studio, Jan, GPT4All, KoboldCpp. */
const MODEL_PORTS = new Set(['11434', '1234', '1337', '4891', '5001']);
/** API paths of model servers: OpenAI-compatible and Ollama's. */
const MODEL_PATHS = ['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/models', '/api/generate', '/api/embed', '/api/tags', '/api/pull', '/api/show'];
/** Where a project keeps its own Python, relative to the root: the agent runs with the packages installed there, not with whatever python is on PATH. */
const PYTHON_ENVIRONMENTS = ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe'];
/** A plain interpreter name a package script or a Python agent is started with. */
const PYTHONS = new Set(['python', 'python3']);
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

interface Entry { path: string; rel: string; depth: number }
interface Script { evidence: Extract<AgentEvidence, { kind: 'script' }>; argv: string[]; cwd: string; entry: string }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEnvFile = (name: string): boolean => name === '.env' || name.startsWith('.env.');
/** A stored Lab record, whole or as its JSON report: its situations quote the owner's rules and the agent's prompt, never the agent's own. */
const labRecord = (value: unknown): boolean => isRecord(value) && value.schemaVersion === '1' && typeof value.id === 'string' && Array.isArray(value.trials);
/**
 * A file Lab itself wrote — a saved set, a check's report, a record or its JSON report: never the agent's prompt, its
 * logs or its address, whatever text it holds. A saved connection is one too, read as the agent's connection only.
 */
const labFile = (raw: unknown): boolean => isRecord(raw) && (typeof raw.format === 'string' && raw.format.startsWith('agent-lab-') || labRecord(raw) || labRecord(raw.experiment));
const extOf = (entry: Entry): string => extname(entry.path).toLowerCase();

/** A file named as a prompt, or in a folder of prompts: `system_prompt.md`, `prompts/answer.txt`, `agent_doc_type_prompt.json`. */
function namedPrompt(file: Entry): boolean {
  const parts = file.rel.split(sep).map(part => part.toLowerCase()), title = basename(parts.at(-1)!, extname(parts.at(-1)!));
  return title.includes('prompt') || title.includes('промпт') || parts.slice(0, -1).some(part => part === 'prompts' || part === 'промпты');
}

/** Breadth first, so a capped walk keeps the files nearest the root. Links are not followed: the walk cannot leave the folder or loop. */
async function walk(root: string): Promise<{ files: Entry[]; truncated: boolean }> {
  const files: Entry[] = [], queue = [{ dir: root, depth: 0 }];
  let seen = 0;
  for (const { dir, depth } of queue) {
    const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > LIMITS.entries) return { files, truncated: true };
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < LIMITS.depth && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)) queue.push({ dir: path, depth: depth + 1 }); }
      else if (entry.isFile() && (!entry.name.startsWith('.') || depth === 0 && isEnvFile(entry.name))) files.push({ path, rel: relative(root, path), depth });
    }
  }
  return { files, truncated: false };
}

/** Reads within the caps: a file over its own cap, or over what is left of the budget, is not read at all. */
class Reader {
  truncated = false;
  private reads = 0; private bytes = 0;
  async text(path: string, cap: number): Promise<string | undefined> {
    const size = await stat(path).then(info => info.size, () => Infinity);
    if (size > cap || !this.take(size)) return undefined;
    return readFile(path, 'utf8').catch(() => undefined);
  }
  /** The bytes of a binary file within its cap. */
  async binary(path: string, cap: number): Promise<Buffer | undefined> {
    const size = await stat(path).then(info => info.size, () => Infinity);
    if (size > cap || !this.take(size)) return undefined;
    return readFile(path).catch(() => undefined);
  }
  /** Whole lines from the beginning of a file too big to read whole. */
  async head(path: string): Promise<string | undefined> {
    if (!this.take(LIMITS.headBytes)) return undefined;
    const file = await open(path, 'r').catch(() => undefined);
    if (!file) return undefined;
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(LIMITS.headBytes), 0, LIMITS.headBytes, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      return text.slice(0, text.lastIndexOf('\n') + 1);
    } finally { await file.close(); }
  }
  private take(size: number): boolean {
    if (this.reads >= LIMITS.reads || this.bytes + size > LIMITS.bytes) { this.truncated = true; return false; }
    this.reads++; this.bytes += size;
    return true;
  }
}

/** Rows the import accepts, counted with the import's own reading of the whole file: a conversation id is taken once in it. */
function dialogueCount(raw: unknown, known: ReadonlyMap<number, LeftOutIssue>): { dialogues: number; rejected: number; roles?: string[] } | undefined {
  const rows = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.dialogues) ? raw.dialogues : undefined;
  if (!rows?.length) return undefined;
  let verdicts: Verdict[];
  try { ({ verdicts } = logImport(raw, { known })); } catch { return undefined; } // the import refuses the file as a whole: not a log Lab can take
  // A conversation under a role name Lab does not know is a conversation all the same: who writes under it is the owner's word.
  const unmapped = verdicts.filter(verdict => verdict?.every(issue => issue.code === 'roles'));
  const roles = [...new Set(unmapped.flatMap(verdict => verdict!.map(issue => issue.value ?? '')))].filter(Boolean).slice(0, 12);
  const rejected = verdicts.filter(Boolean).length - unmapped.length, dialogues = verdicts.length - rejected;
  return dialogues ? { dialogues, rejected, ...(roles.length ? { roles } : {}) } : undefined;
}

/** A spreadsheet of logs under the reading Lab would propose; a table without conversations, or one Lab cannot read, is not a log. */
function tableLog(file: string, path: string, bytes: Buffer): LogFile | undefined {
  let proposal: ReturnType<typeof proposeTableBytes>;
  try { proposal = proposeTableBytes(path, bytes); } catch { return undefined; }
  if (proposal.status === 'ready') return proposal.preview.usable || proposal.preview.dialogues
    ? { file, dialogues: proposal.preview.usable, rejected: proposal.preview.dialogues - proposal.preview.usable, complete: true, table: 'ready' } : undefined;
  return proposal.status === 'question' && proposal.found ? { file, dialogues: proposal.found, rejected: 0, complete: true, table: 'question' } : undefined;
}

/** An http(s) address on this machine, without credentials, query or fragment: those may carry secrets. Never a model server's. */
function localUrl(value: string): string | undefined {
  const url = value.startsWith('http://') || value.startsWith('https://') ? URL.parse(value) : null;
  if (!url || !LOCAL_HOSTS.has(url.hostname) || MODEL_PORTS.has(url.port)) return undefined;
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (path === '/v1' || MODEL_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return undefined;
  return `${url.protocol}//${url.host}${url.pathname}`;
}
/** The words of a config key: `agent_url`, `agentUrl`, `AGENT-URL` → agent, url. A key is structure, not text. */
function keyWords(key: string): string[] {
  const words: string[] = [];
  let word = '';
  for (let i = 0; i < key.length; i++) {
    const char = key[i]!, lower = char.toLowerCase(), upper = char.toUpperCase();
    const letter = lower !== upper, digit = char >= '0' && char <= '9';
    if (!letter && !digit) { if (word) words.push(word); word = ''; continue; }
    // camelCase: a capital after a small letter or a digit begins a word.
    const previous = key[i - 1];
    if (word && char === upper && letter && previous !== undefined && (previous >= '0' && previous <= '9' || previous !== previous.toUpperCase())) { words.push(word); word = ''; }
    word += lower;
  }
  if (word) words.push(word);
  return words;
}
/** A config value is the agent's address when a key on its way names the agent and none names a model. */
function agentKeys(keys: readonly string[]): boolean {
  const words = keys.flatMap(keyWords);
  return words.some(word => AGENT_WORDS.has(word)) && !words.some(word => MODEL_WORDS.has(word));
}
/** String values of a parsed config with the keys on their way; nesting deeper than any real config is not descended into. */
const stringLeaves = (value: unknown, keys: string[] = []): { keys: string[]; value: string }[] => typeof value === 'string' ? [{ keys, value }] : keys.length > 32 ? []
  : Array.isArray(value) ? value.flatMap(item => stringLeaves(item, keys)) : isRecord(value) ? Object.entries(value).flatMap(([key, item]) => stringLeaves(item, [...keys, key])) : [];
const unquote = (value: string) => value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0] ? value.slice(1, -1) : value;
/**
 * `key: value` (YAML, nesting by indentation), `key = value` and `[section]` (TOML, INI) values with the keys on their
 * way. A config's syntax is structure; a line it does not know is skipped, never guessed.
 */
function configValues(text: string): { keys: string[]; value: string }[] {
  const out: { keys: string[]; value: string }[] = [];
  const nesting: { indent: number; key: string }[] = [];
  let section: string[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) { section = trimmed.slice(1, -1).split('.').map(part => unquote(part.trim())); nesting.length = 0; continue; }
    const indent = raw.length - raw.trimStart().length;
    while (nesting.length && nesting.at(-1)!.indent >= indent) nesting.pop();
    const item = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed;
    const colon = item.indexOf(': '), equals = item.indexOf('=');
    const at = equals > 0 && (colon < 0 || equals < colon) ? equals : colon > 0 ? colon : item.endsWith(':') ? item.length - 1 : -1;
    const keys = [...section, ...nesting.map(level => level.key)];
    if (at < 0) { if (item !== trimmed) out.push({ keys, value: unquote(item) }); continue; }
    const key = unquote(item.slice(0, at).trim()), rest = item.slice(at + 1).trim();
    if (!rest) { nesting.push({ indent, key }); continue; }
    // A quoted value ends at its closing quote; an unquoted one where a comment begins.
    const value = rest[0] === '"' || rest[0] === "'" ? rest.slice(1, Math.max(1, rest.indexOf(rest[0], 1))) : rest.split(' #')[0]!.trim();
    out.push({ keys: [...keys, key], value });
  }
  return out;
}

/** Scripts that start one file with an interpreter (`python agent.py`); shell syntax is never interpreted. Start scripts come first. */
function packageScripts(manifest: unknown, file: Entry): Script[] {
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? Object.entries(manifest.scripts) : [];
  return scripts.flatMap(([name, command]): Script[] => {
    if (typeof command !== 'string' || [...SHELL].some(mark => command.includes(mark))) return [];
    const argv = command.trim().split(/\s+/);
    const entry = argv.slice(1).find(arg => !arg.startsWith('-'));
    if (!INTERPRETERS.has(argv[0] ?? '') || !entry) return [];
    return [{ evidence: { kind: 'script', file: file.rel, name, command: argv.join(' ') }, argv, cwd: dirname(file.path), entry: resolve(dirname(file.path), entry) }];
  }).sort((a, b) => Number(!RUN_SCRIPTS.has(a.evidence.name)) - Number(!RUN_SCRIPTS.has(b.evidence.name)));
}

/** The project's own Python, when it keeps one; only its existence is checked — nothing is run or read. */
async function projectPython(root: string): Promise<string | undefined> {
  for (const file of PYTHON_ENVIRONMENTS) if (await stat(join(root, file)).then(info => info.isFile(), () => false)) return file;
  return undefined;
}

const envNameStart = (char: string | undefined): boolean => char === '_' || !!char && (char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z');
const envNameChar = (char: string | undefined): boolean => envNameStart(char) || !!char && char >= '0' && char <= '9';
const base64Char = (char: string): boolean => envNameChar(char) || char === '+' || char === '/' || char === '-';
/** The longest name a connection reads from the environment (http-template.ts envNameSchema). */
const ENV_NAME_CHARS = 100;
/** An unquoted value this long, all of base64, may be a key wrapped over several lines. */
const WRAPPED_BASE64 = 16;
/**
 * A line of nothing but base64 (standard or url-safe), `=` padding only at its end: `open` when more of it may follow,
 * `closed` when padding ended it; undefined for anything else.
 */
function base64Run(line: string): 'open' | 'closed' | undefined {
  let end = line.length;
  while (end > 0 && line[end - 1] === '=') end--;
  if (!end || line.length - end > 2 || ![...line.slice(0, end)].every(base64Char)) return undefined;
  return end < line.length ? 'closed' : 'open';
}

/**
 * The variable names of a .env file: only well-formed assignments, `NAME=value` from the very start of a line (`export `
 * before it allowed), the way a shell and dotenv take them. A value quoted with ', " or ` may run over several lines,
 * an unquoted PEM block (-----BEGIN … -----END) is one value, and a long unquoted base64 value may be wrapped over the
 * lines after it, its last one ending in `=` padding: every such line belongs to the value, never to a name. Every value
 * is skipped as it is read, so neither a secret nor a piece of one (the tail of a key) ever reaches the result.
 */
export function envFileNames(text: string): string[] {
  const names = new Set<string>();
  const lineEnd = (from: number) => { const end = text.indexOf('\n', from); return end < 0 ? text.length : end; };
  const blank = (at: number) => text[at] === ' ' || text[at] === '\t';
  /** The line before continued an unquoted base64 value: a line of base64 now is more of it. */
  let wrapped = false;
  let i = 0;
  while (i < text.length) {
    const end = lineEnd(i);
    const line = text.slice(i, text[end - 1] === '\r' ? end - 1 : end);
    if (wrapped) {
      const run = base64Run(line);
      wrapped = run === 'open';
      if (run) { i = end + 1; continue; }
    }
    let j = i;
    if (text.startsWith('export', j) && blank(j + 'export'.length)) { j += 'export'.length; while (blank(j)) j++; }
    const start = j;
    if (envNameStart(text[j])) { j++; while (envNameChar(text[j])) j++; }
    const name = text.slice(start, j);
    while (blank(j)) j++;
    // `NAME==…`: a «value» of padding is the tail of a base64 value wrapped over lines, not an assignment.
    if (!name || name.length > ENV_NAME_CHARS || text[j] !== '=' || text[j + 1] === '=') { i = end + 1; continue; }
    names.add(name);
    j++;
    while (blank(j)) j++;
    const quote = text[j];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A quoted value may run over lines; inside double quotes a backslash escapes the next character.
      let k = j + 1;
      while (k < text.length && text[k] !== quote) k += quote === '"' && text[k] === '\\' ? 2 : 1;
      i = lineEnd(Math.min(k + 1, text.length)) + 1;
    } else if (text.startsWith('-----BEGIN', j)) {
      const close = text.indexOf('-----END', j);
      i = close < 0 ? text.length : lineEnd(close) + 1;
    } else {
      const value = text.slice(j, i + line.length);
      wrapped = value.length >= WRAPPED_BASE64 && base64Run(value) === 'open';
      i = end + 1;
    }
  }
  return [...names];
}

/** Variable names only: the values are skipped as they are read, so a secret never reaches the result. */
async function envNames(files: Entry[], reader: Reader): Promise<ProjectDetection['env']> {
  const names = new Set<string>();
  for (const file of files) for (const name of envFileNames(await reader.text(file.path, LIMITS.textBytes) ?? '')) names.add(name);
  return { files: files.map(file => file.rel), names: [...names].sort() };
}

/** The files a target starts: its module, or those of its command arguments. */
const entryFiles = (target: RunnableTarget, root: string): string[] =>
  target.kind === 'module' ? [target.path] : target.kind === 'command' ? target.args.map(arg => resolve(target.cwd ?? root, arg)) : [];
/**
 * A saved connection in the project folder itself — the one Lab or the owner put there. One deeper in the tree (a
 * vendored tool, a cloned example) is someone else's: it may start anything and run any release hook, so it is only
 * ever the owner's pick.
 */
const ownConnection = (item: AgentEvidence): boolean => item.kind === 'connection' && !item.file.includes(sep);
/**
 * Sure only when a file speaks Lab's contract whole: a module's createSession with its respond, or a JSON-lines loop,
 * and the fields of a Lab request besides; either alone may expect other fields — or when it is the project's own saved
 * connection. A script or an address alone shows nothing of the protocol. Whatever is not sure is the owner's pick.
 */
function confidence(evidence: AgentEvidence[]): Confidence {
  const kinds = new Set(evidence.map(item => item.kind));
  if (evidence.some(ownConnection)) return 'high';
  // A loop nothing starts is no program: whatever its file shows, it is at most a guess.
  if (kinds.has('no_entry')) return 'low';
  const contract = kinds.has('factory') || kinds.has('json_lines');
  return contract && kinds.has('protocol_fields') ? 'high' : contract ? 'medium' : 'low';
}

/**
 * The files a Python import names, nearest first: `lab.protocol` → lab/protocol.py or lab/protocol/__init__.py beside
 * the importing file, then at the project root; a relative `.protocol` only from the importing file's package.
 */
function pythonModule(module: string, dir: string, root: string): string[] {
  let dots = 0;
  while (module[dots] === '.') dots++;
  const parts = module.slice(dots).split('.').filter(Boolean);
  const bases = dots ? [resolve(dir, ...Array<string>(dots - 1).fill('..'))] : [dir, root];
  return bases.flatMap(base => parts.length ? [`${join(base, ...parts)}.py`, join(base, ...parts, '__init__.py')] : [join(base, '__init__.py')]);
}

/** Looks through the project folder and proposes the agent connection, the logs, the materials and the prompt. Read-only. */
export async function detectProject(cwd: string): Promise<ProjectDetection> {
  const root = resolve(cwd);
  if (!await stat(root).then(info => info.isDirectory(), () => false)) throw new Error(`Папка проекта не найдена: ${root}`);
  const walked = await walk(root);
  const reader = new Reader();
  const env = await envNames(walked.files.filter(file => file.depth === 0 && isEnvFile(basename(file.path))), reader);
  const drafts = new Map<string, { target: RunnableTarget; evidence: AgentEvidence[] }>();
  const add = (key: string, target: unknown, evidence: AgentEvidence[]) => {
    const known = drafts.get(key), parsed = known ? undefined : runnableTargetSchema.safeParse(target);
    if (known) known.evidence.push(...evidence); else if (parsed?.success) drafts.set(key, { target: parsed.data, evidence });
  };
  const addUrls = (values: { keys: string[]; value: string }[], file: Entry) => {
    const urls = values.flatMap(item => agentKeys(item.keys) ? localUrl(item.value) ?? [] : []);
    for (const url of new Set(urls)) add(`url:${url}`, { kind: 'http', url }, [{ kind: 'url', file: file.rel, url }]);
  };
  const logs: LogFile[] = [], scripts: Script[] = [], prompts: PromptCandidate[] = [];

  // Data first: logs and saved connections matter most when a cap cuts the reading short.
  for (const file of walked.files) {
    const ext = extOf(file), config = file.depth <= LIMITS.configDepth;
    if (ext === '.json' || ext === '.jsonl') {
      const whole = await reader.text(file.path, IMPORT_FILE_BYTES);
      const text = whole ?? (ext === '.jsonl' ? await reader.head(file.path) : undefined);
      if (text === undefined) continue;
      let raw: unknown, known: ReadonlyMap<number, LeftOutIssue>;
      try { ({ raw, known } = parseImportText(text, ext === '.jsonl')); } catch { continue; }
      if (isRecord(raw) && raw.format === CONNECTION_FORMAT) {
        const connection = await readConnection(file.path).catch(() => undefined);
        if (connection) add(`connection:${file.rel}`, connection.target, [{ kind: 'connection', file: file.rel }]);
        continue;
      }
      if (labFile(raw)) continue;
      const count = dialogueCount(raw, known);
      if (count) logs.push({ file: file.rel, ...count, complete: whole !== undefined });
      else if (ext === '.json') {
        // A JSON of prompts (an MLS-style agent_prompt.json, or a config with a system field) is read whole, like any config.
        if (whole !== undefined) prompts.push(...jsonPrompts(raw, file.rel, namedPrompt(file)));
        if (config && basename(file.path) === 'package.json') scripts.push(...packageScripts(raw, file));
        if (config) addUrls(stringLeaves(raw), file);
      }
    } else if (TABLE_EXTENSIONS.has(ext)) {
      const bytes = await reader.binary(file.path, IMPORT_FILE_BYTES);
      const log = bytes && tableLog(file.rel, file.path, bytes);
      if (log) logs.push(log);
    } else if (CONFIGS.has(ext) && config && !basename(file.path).includes('-lock.')) {
      // YAML, TOML and INI are read line by line for their keys: an address counts only under a key that names the agent.
      addUrls(configValues(await reader.text(file.path, LIMITS.textBytes) ?? ''), file);
    }
  }

  // A Python agent is started with the project's own environment when it keeps one.
  const python = await projectPython(root);
  const interpreter = (command: string): { command: string; evidence: AgentEvidence[] } => python && PYTHONS.has(command)
    ? { command: join(root, python), evidence: [{ kind: 'interpreter', file: python }] } : { command, evidence: [] };
  // Constants of every source file, so a system message naming a constant of another module finds it there.
  const constants: { file: string; names: Map<string, string> }[] = [], systemNames = new Set<string>();
  // Every source file is read first: which program runs the loop a helper module defines shows only once both are.
  const sources: { file: Entry; language: Language; facts: CodeFacts; factory: boolean }[] = [];
  for (const file of walked.files) {
    const language = languageOf(file.path), name = basename(file.path);
    if (!language || name.includes('.test.') || name.includes('.spec.')) continue;
    const source = await reader.text(file.path, LIMITS.textBytes);
    if (source === undefined) continue;
    const found = codePrompts(source, language, file.rel);
    prompts.push(...found.candidates); constants.push({ file: file.rel, names: found.constants });
    for (const system of found.systemNames) systemNames.add(system);
    const facts = codeFacts(source, language);
    // A module is the agent by its contract, not by a name: Next.js keeps a createSession for its logins, with no respond.
    sources.push({ file, language, facts, factory: facts.factory && codeHasWord(source, language, 'respond') });
  }
  // A program that imports a helper's JSON-lines loop and runs it is the agent; the helper alone runs nothing.
  const loops = new Map(sources.filter(item => item.facts.jsonLines).map(item => [item.file.path, item]));
  const helpersOf = new Map<Entry, (typeof sources)[number][]>(), run = new Set<string>();
  for (const item of sources) if (item.facts.entry) for (const module of item.facts.runs) {
    const helper = pythonModule(module, dirname(item.file.path), root).map(path => loops.get(path)).find(found => found !== undefined);
    if (!helper || helper === item) continue;
    helpersOf.set(item.file, [...helpersOf.get(item.file) ?? [], helper]);
    run.add(helper.file.path);
  }
  for (const { file, language, facts, factory } of sources) {
    const script = scripts.find(item => item.entry === file.path), helpers = helpersOf.get(file) ?? [];
    if (!factory && !facts.jsonLines && !helpers.length) continue;
    // A helper whose loop a program of the project runs is proposed as that program, unless a package script starts it itself.
    if (!factory && run.has(file.path) && !script) continue;
    const started = interpreter(script ? script.argv[0]! : language === 'python' ? 'python3' : 'node');
    const evidence: AgentEvidence[] = [...(script ? [script.evidence] : []),
      ...(factory || facts.jsonLines ? [{ kind: factory ? 'factory' as const : 'json_lines' as const, file: file.rel }, ...(facts.protocol ? [{ kind: 'protocol_fields' as const, file: file.rel }] : [])] : []),
      ...helpers.flatMap((helper): AgentEvidence[] => [{ kind: 'runs', file: file.rel, helper: helper.file.rel }, { kind: 'json_lines', file: helper.file.rel },
        ...(helper.facts.protocol ? [{ kind: 'protocol_fields' as const, file: helper.file.rel }] : [])]),
      // Started as it is, a file that only defines its loop — no `__main__` guard, no call, no package script — runs nothing.
      ...(!factory && !facts.entry && !script ? [{ kind: 'no_entry' as const, file: file.rel }] : []),
      ...(factory ? [] : started.evidence)];
    add(`file:${file.path}`, factory ? { kind: 'module', path: file.path }
      : script ? { kind: 'command', command: started.command, args: script.argv.slice(1), cwd: script.cwd }
      : { kind: 'command', command: started.command, args: [file.rel], cwd: root }, evidence);
  }
  // A start script whose file shows no protocol is still how the owner runs the program: offered, with low confidence.
  for (const script of scripts) if (RUN_SCRIPTS.has(script.evidence.name) && !drafts.has(`file:${script.entry}`)) {
    const started = interpreter(script.argv[0]!);
    add(`file:${script.entry}`, { kind: 'command', command: started.command, args: script.argv.slice(1), cwd: script.cwd }, [script.evidence, ...started.evidence]);
  }
  // The project's own saved connection absorbs what the files it starts showed, so one agent is proposed once; a
  // connection from deeper in the tree does not, so the project's own file stays a choice without it.
  for (const [key, draft] of drafts) if (key.startsWith('connection:') && draft.evidence.some(ownConnection)) for (const entry of entryFiles(draft.target, root)) {
    const same = drafts.get(`file:${entry}`);
    if (same) { draft.evidence.push(...same.evidence); drafts.delete(`file:${entry}`); }
  }

  const has = (agent: AgentCandidate, kind: AgentEvidence['kind']) => agent.evidence.some(item => item.kind === kind) ? 0 : 1;
  const own = (agent: AgentCandidate) => agent.evidence.some(ownConnection) ? 0 : 1;
  const depth = (agent: AgentCandidate) => agent.evidence[0]!.file.split(sep).length;
  const agents = [...drafts.values()].map(draft => ({ ...draft, confidence: confidence(draft.evidence) }))
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || own(a) - own(b) || has(a, 'script') - has(b, 'script')
      || depth(a) - depth(b) || a.evidence[0]!.file.localeCompare(b.evidence[0]!.file));

  for (const name of systemNames) for (const { file, names } of constants) {
    const text = names.get(name);
    const known = prompts.find(item => item.file === file && item.identifier === name);
    if (known) known.system = true;
    else if (text !== undefined && text.trim().length >= MIN_PROMPT_CHARS && text.length <= MATERIAL_CHARS) prompts.push({ id: `${file}#${name}`, file, identifier: name, origin: 'code', system: true, chars: text.length, text });
  }

  const folders = new Map<string, number>();
  for (const file of walked.files) {
    const ext = extOf(file);
    if (!MATERIAL_EXTENSIONS.has(ext)) continue;
    const parts = file.rel.split(sep), lower = parts.map(part => part.toLowerCase());
    if (namedPrompt(file)) {
      const bytes = await reader.binary(file.path, LIMITS.headBytes);
      const text = bytes && materialText(file.path, bytes);
      // A file named as a prompt is one, however short: only an empty or unreadable one is not offered.
      if (text && text.length <= MATERIAL_CHARS) prompts.push({ id: file.rel, file: file.rel, origin: 'file', chars: text.length, text });
      continue;
    }
    const at = lower.slice(0, -1).findIndex(part => KNOWLEDGE.has(part));
    if (at >= 0) { const folder = parts.slice(0, at + 1).join(sep); folders.set(folder, (folders.get(folder) ?? 0) + 1); }
  }
  const depthOf = (file: string) => file.split(sep).length;
  // Nearest the root first; within a file, in the order the file gives them (Array.prototype.sort is stable).
  prompts.sort((a, b) => depthOf(a.file) - depthOf(b.file) || a.file.localeCompare(b.file));
  return {
    root, agents,
    logs: logs.sort((a, b) => b.dialogues - a.dialogues || a.file.localeCompare(b.file)),
    materials: [...folders].map(([folder, documents]) => ({ folder, documents })).sort((a, b) => b.documents - a.documents || a.folder.localeCompare(b.folder)),
    prompts,
    env, truncated: walked.truncated || reader.truncated,
  };
}

/** One piece of evidence in the owner's words. */
export function evidenceText(evidence: AgentEvidence): string {
  switch (evidence.kind) {
    case 'connection': return `${evidence.file}: сохранённое подключение Agent Lab`;
    case 'script': return `${evidence.file}: scripts.${evidence.name} = ${evidence.command}`;
    case 'factory': return `${evidence.file}: объявляет ${FACTORY} — Lab подключит модуль напрямую`;
    case 'json_lines': return `${evidence.file}: читает запросы из stdin построчно и отвечает JSON`;
    case 'runs': return `${evidence.file}: запускает цикл запросов из ${evidence.helper}`;
    case 'no_entry': return `${evidence.file}: только объявляет цикл запросов — запущенный сам по себе, файл ничего не делает`;
    case 'protocol_fields': return `${evidence.file}: знает поля запроса Agent Lab (sessionId, initialState)`;
    case 'url': return `${evidence.file}: адрес ${evidence.url}`;
    case 'interpreter': return `${evidence.file}: окружение Python проекта — агент запустится с его пакетами`;
  }
}

/** A file as the owner finds it: inside `root` relative to it, elsewhere from ~ or whole — never a chain of «../». */
function shownFile(file: string, root: string): string {
  // The filesystem root is no project folder: a path relative to it would only lose its leading «/».
  const inside = dirname(root) === root ? '' : relative(root, file);
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside;
  const home = homedir();
  return file.startsWith(`${home}${sep}`) ? `~${file.slice(home.length)}` : file;
}

/** Characters a word of a command needs no quotes for; with any other — a space, a quote, `;`, `$`, a letter beyond Latin — it is quoted. */
const PLAIN_WORD = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-~');
/** A word of a command as a shell would take it: single-quoted wherever its bounds would not show otherwise. A command line is structure. */
export const shellWord = (word: string): string => word && [...word].every(char => PLAIN_WORD.has(char)) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * A command exactly as Lab starts it — the program and every argument word for word, quoted where a shell would need
 * it, so `bash -c 'touch x; …'` never reads as several arguments. Only an absolute path is shortened: from `cwd` when
 * it lies inside it (a program as `./deploy.sh`, never to be taken for one found on PATH), from ~ otherwise.
 */
export function commandText(command: string, args: readonly string[], cwd: string): string {
  const shown = (part: string) => isAbsolute(part) ? shownFile(part, cwd) : part;
  const program = shown(command);
  const local = isAbsolute(command) && !program.startsWith('~') && !isAbsolute(program);
  return [local ? `./${program}` : program, ...args.map(shown)].map(shellWord).join(' ');
}

/** The folder a command runs in, as the owner finds it: the project folder itself, a folder inside it, a path from ~. */
export const folderText = (folder: string, root: string): string => relative(root, folder) ? `в папке ${shownFile(folder, root)}` : 'в папке проекта';

/** A connection's release hook as the run dialog and the owner's pick say it: the command word for word and its folder. */
export const releaseText = (release: NonNullable<RunnableTarget['release']>, root: string): string =>
  `${commandText(release.command, release.args, release.cwd ?? root)} ${folderText(release.cwd ?? root, root)}`;

/** How the owner recognises the agent: its start command, its module or its address; files are shown from where the agent starts. */
export function targetLabel(target: RunnableTarget, root: string): string {
  if (target.kind === 'command') return commandText(target.command, target.args, target.cwd ?? root);
  return target.kind === 'module' ? `модуль ${shownFile(target.path, root)}` : target.url;
}

/**
 * What the owner must know of a candidate before taking it, beyond how it starts: that it is a connection saved deeper
 * in the tree, which nothing shows to be theirs, and the release hook it would run before every run.
 */
export function candidateWarnings(agent: AgentCandidate, root: string): string[] {
  return [
    ...agent.evidence.some(item => item.kind === 'connection') && !agent.evidence.some(ownConnection) ? ['подключение из вложенной папки — Lab возьмёт его, только если вы выберете'] : [],
    ...agent.target.release ? [`перед прогоном выполнит: ${releaseText(agent.target.release, root)}`] : [],
  ];
}

/**
 * One log in the proposal: how many conversations, how many rows did not fit, the sample one import takes of a longer
 * log, and for a table, that its reading is confirmed at import.
 */
function logLine(log: LogFile): string {
  const counted = `${log.complete ? '' : 'в начале файла '}${countText(log.dialogues, ['разговор', 'разговора', 'разговоров'])}`
    + (log.rejected ? `, ${countText(log.rejected, ['запись', 'записи', 'записей'])} ${pluralForm(log.rejected, ['не подошла', 'не подошли', 'не подошли'])}` : '')
    + (log.complete && log.table !== 'question' && log.dialogues > IMPORT_DIALOGUE_LIMIT ? `; в одну загрузку входит ${IMPORT_DIALOGUE_LIMIT}: ${sampleWords(IMPORT_DIALOGUE_LIMIT, log.dialogues)}` : '');
  if (log.table) return `  ${log.file} — таблица, ${counted}; ${log.table === 'ready' ? 'как её читать, Lab покажет перед загрузкой' : 'перед загрузкой Lab спросит, как её читать'}`;
  const roles = log.roles?.length ? `; роли ${log.roles.map(role => `«${role}»`).join(', ')} Lab не знает — кто пишет под ними, он спросит перед сборкой` : '';
  return `  ${log.file} — ${counted}${roles}${log.complete ? '' : `; дальше Lab не смотрел: файл больше ${IMPORT_FILE_BYTES / 1_000_000} МБ, целиком его Lab прочитает при загрузке`}`;
}

const ORIGIN_TEXT: Record<PromptCandidate['origin'], string> = { file: 'файл', code: 'строка в коде', json: 'поле JSON' };
/** One prompt candidate as the owner picks it: its id (the file, and the constant or field), what it is, its size. */
export function promptLine(prompt: PromptCandidate): string {
  return `${prompt.id} — ${ORIGIN_TEXT[prompt.origin]}${prompt.system ? ', задаёт роль system' : ''}, ${countText(prompt.chars, ['знак', 'знака', 'знаков'])}`;
}
/** Prompts are listed longer than the rest: the owner picks among them. */
const PROMPTS_SHOWN = 20;

const CONFIDENCE_NOTE: Record<Confidence, string> = { high: '', medium: ' — похоже на агента; формат запросов Lab проверит при подключении', low: ' — возможно, агент; как он отвечает, не видно' };
/** An address is connected from the owner's curl: Lab does not know the request the agent there expects. */
const ADDRESS_NOTE = ' — возможно, агент; подключу по вашему curl-запросу к нему';
const SHOWN = 3;

/** The proposal as plain lines for the terminal; the caller makes each line safe to print. */
export function detectionLines(detection: ProjectDetection): string[] {
  const { root, agents, logs, materials, prompts, env } = detection;
  const more = (count: number) => count > SHOWN ? [`  … ещё ${count - SHOWN}`] : [];
  return [
    `Agent Lab посмотрел папку «${basename(root)}» — ничего не запускал и не менял.`, '',
    'Агент',
    ...agents.length ? agents.slice(0, SHOWN).flatMap(agent => {
      const warnings = candidateWarnings(agent, root);
      const note = warnings.length ? ` — ${warnings.join('; ')}` : agent.target.kind === 'http' && !agent.evidence.some(item => item.kind === 'connection') ? ADDRESS_NOTE : CONFIDENCE_NOTE[agent.confidence];
      return [`  ${agent.confidence === 'high' ? '✓' : '?'} ${targetLabel(agent.target, root)}${note}`, ...agent.evidence.map(item => `      ${evidenceText(item)}`)];
    }) : ['  не нашёл — Lab спросит, как запускать агента'],
    ...more(agents.length), '',
    'Логи с разговорами',
    ...logs.length ? logs.slice(0, SHOWN).map(logLine) : ['  не нашёл файлов с разговорами (JSON, JSONL, XLSX, CSV)'],
    ...more(logs.length), '',
    'Материалы',
    ...materials.length ? materials.slice(0, SHOWN).map(item => `  ${item.folder} — ${countText(item.documents, ['документ', 'документа', 'документов'])}`) : ['  не нашёл папок с документами'],
    ...more(materials.length), '',
    'Промпты агента',
    ...prompts.length ? [...prompts.slice(0, PROMPTS_SHOWN).map(prompt => `  ${promptLine(prompt)}`), ...prompts.length > PROMPTS_SHOWN ? [`  … ещё ${prompts.length - PROMPTS_SHOWN}`] : [],
      '  Какие из них задают, что и как бот отвечает клиенту, выбираете вы: они станут правилами поведения бота.'] : ['  не нашёл'],
    ...env.names.length ? ['', `Переменные из ${env.files.join(', ')}: ${env.names.join(', ')} — значения Lab не читает.`] : [],
    ...detection.truncated ? ['', 'Папка большая: просмотрена только часть файлов.'] : [],
  ];
}
