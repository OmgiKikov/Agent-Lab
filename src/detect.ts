import type { Dirent } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { CONNECTION_FORMAT, readConnection } from './connection.js';
import { runnableTargetSchema, type RunnableTarget } from './contracts.js';
import { parseImportText } from './imports.js';
import { IMPORT_DIALOGUE_LIMIT, IMPORT_FILE_BYTES } from './limits.js';
import { MATERIAL_EXTENSIONS } from './materials.js';
import { countText, pluralForm } from './plural.js';
import { importBatch } from './scenario-library.js';
import { codeFacts, FACTORY, languageOf } from './source-facts.js';

/*
 * What Lab can tell about a project folder before asking the owner anything: how to reach the agent,
 * which files hold logged conversations, where the knowledge base and the agent's prompt are. It only
 * reads, within fixed caps: it never runs or imports a file, never follows a link out of the folder,
 * and never keeps a secret (a .env file yields variable names; a local address loses its credentials
 * and query). Every finding names the file it came from; the owner confirms before anything runs.
 */

/** One observation behind an agent candidate, made in `file` (relative to the project root). */
export type AgentEvidence =
  | { kind: 'connection'; file: string }                              // a saved Agent Lab connection
  | { kind: 'script'; file: string; name: string; command: string }  // package.json: scripts.start = python agent.py
  | { kind: 'factory'; file: string }                                 // exports createSession, the module contract
  | { kind: 'json_lines'; file: string }                              // reads requests from stdin line by line, answers JSON
  | { kind: 'protocol_fields'; file: string }                         // names the fields of an Agent Lab request
  | { kind: 'url'; file: string; url: string };                       // a local address in a config file
export type Confidence = 'high' | 'medium' | 'low';
/** A connection target ready for use (absolute paths) and why Lab believes it is the agent. */
export interface AgentCandidate { target: RunnableTarget; confidence: Confidence; evidence: AgentEvidence[] }
/** A file the import accepts as logged conversations; `complete: false` counted only the beginning of a file too big to import whole. */
export interface LogFile { file: string; dialogues: number; rejected: number; complete: boolean }
export interface MaterialFolder { folder: string; documents: number }
/** Paths are relative to `root`, except inside `target`. */
export interface ProjectDetection {
  root: string; agents: AgentCandidate[]; logs: LogFile[]; materials: MaterialFolder[]; prompts: string[];
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
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

interface Entry { path: string; rel: string; depth: number }
interface Script { evidence: Extract<AgentEvidence, { kind: 'script' }>; argv: string[]; cwd: string; entry: string }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEnvFile = (name: string): boolean => name === '.env' || name.startsWith('.env.');
const extOf = (entry: Entry): string => extname(entry.path).toLowerCase();

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

/** Rows the import accepts, counted with the import's own rules; a log longer than one import batch is counted batch by batch. */
function dialogueCount(raw: unknown): { dialogues: number; rejected: number } | undefined {
  const rows = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.dialogues) ? raw.dialogues : undefined;
  if (!rows?.length) return undefined;
  let dialogues = 0, rejected = 0;
  try {
    for (let start = 0; start < rows.length; start += IMPORT_DIALOGUE_LIMIT) {
      const slice = rows.slice(start, start + IMPORT_DIALOGUE_LIMIT);
      const batch = importBatch(isRecord(raw) ? { ...raw, dialogues: slice } : slice);
      dialogues += batch.dialogues.length; rejected += batch.rejected.length;
    }
  } catch { return undefined; } // the import refuses the file as a whole: not a log Lab can take
  return dialogues ? { dialogues, rejected } : undefined;
}

/** An http(s) address on this machine, without credentials, query or fragment: those may carry secrets. */
function localUrl(value: string): string | undefined {
  const url = value.startsWith('http://') || value.startsWith('https://') ? URL.parse(value) : null;
  return url && LOCAL_HOSTS.has(url.hostname) ? `${url.protocol}//${url.host}${url.pathname}` : undefined;
}
/** String values of a parsed config; nesting deeper than any real config is not descended into. */
const stringLeaves = (value: unknown, depth = 0): string[] => typeof value === 'string' ? [value] : depth > 32 ? []
  : Array.isArray(value) ? value.flatMap(item => stringLeaves(item, depth + 1)) : isRecord(value) ? Object.values(value).flatMap(item => stringLeaves(item, depth + 1)) : [];

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

/** Variable names only: the text after `=` is dropped on the spot, so a secret never reaches the result. */
async function envNames(files: Entry[], reader: Reader): Promise<ProjectDetection['env']> {
  const names = new Set<string>();
  for (const file of files) for (const line of (await reader.text(file.path, LIMITS.textBytes) ?? '').split('\n')) {
    const at = line.indexOf('=');
    const name = at < 0 ? '' : line.slice(0, at).trim();
    const bare = name.startsWith('export ') ? name.slice('export '.length).trim() : name;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) names.add(bare);
  }
  return { files: files.map(file => file.rel), names: [...names].sort() };
}

/** The files a target starts: its module, or those of its command arguments. */
const entryFiles = (target: RunnableTarget, root: string): string[] =>
  target.kind === 'module' ? [target.path] : target.kind === 'command' ? target.args.map(arg => resolve(target.cwd ?? root, arg)) : [];
/** Sure only when a file speaks Lab's contract; a bare JSON-lines loop may expect other fields; a script or an address alone shows nothing of the protocol. */
function confidence(evidence: AgentEvidence[]): Confidence {
  const kinds = new Set(evidence.map(item => item.kind));
  return kinds.has('connection') || kinds.has('factory') || kinds.has('json_lines') && kinds.has('protocol_fields') ? 'high' : kinds.has('json_lines') ? 'medium' : 'low';
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
  const addUrls = (values: string[], file: Entry) => {
    for (const url of new Set(values.flatMap(value => localUrl(value) ?? []))) add(`url:${url}`, { kind: 'http', url }, [{ kind: 'url', file: file.rel, url }]);
  };
  const logs: LogFile[] = [], scripts: Script[] = [];

  // Data first: logs and saved connections matter most when a cap cuts the reading short.
  for (const file of walked.files) {
    const ext = extOf(file), config = file.depth <= LIMITS.configDepth;
    if (ext === '.json' || ext === '.jsonl') {
      const whole = await reader.text(file.path, IMPORT_FILE_BYTES);
      const text = whole ?? (ext === '.jsonl' ? await reader.head(file.path) : undefined);
      if (text === undefined) continue;
      let raw: unknown;
      try { raw = parseImportText(text, ext === '.jsonl'); } catch { continue; }
      if (isRecord(raw) && raw.format === CONNECTION_FORMAT) {
        const connection = await readConnection(file.path).catch(() => undefined);
        if (connection) add(`connection:${file.rel}`, connection.target, [{ kind: 'connection', file: file.rel }]);
        continue;
      }
      const count = dialogueCount(raw);
      if (count) logs.push({ file: file.rel, ...count, complete: whole !== undefined });
      else if (ext === '.json' && config) {
        if (basename(file.path) === 'package.json') scripts.push(...packageScripts(raw, file));
        addUrls(stringLeaves(raw), file);
      }
    } else if (CONFIGS.has(ext) && config && !basename(file.path).includes('-lock.')) {
      // YAML, TOML and INI are not parsed: a value is anything between spaces, quotes, `=` and commas, kept only if it is a local address.
      addUrls((await reader.text(file.path, LIMITS.textBytes))?.split(/[\s"'=,]+/) ?? [], file);
    }
  }

  for (const file of walked.files) {
    const language = languageOf(file.path), name = basename(file.path);
    if (!language || name.includes('.test.') || name.includes('.spec.')) continue;
    const source = await reader.text(file.path, LIMITS.textBytes);
    if (source === undefined) continue;
    const facts = codeFacts(source, language), script = scripts.find(item => item.entry === file.path);
    if (!facts.factory && !facts.jsonLines) continue;
    const evidence: AgentEvidence[] = [...(script ? [script.evidence] : []), { kind: facts.factory ? 'factory' : 'json_lines', file: file.rel },
      ...(facts.protocol ? [{ kind: 'protocol_fields' as const, file: file.rel }] : [])];
    add(`file:${file.path}`, facts.factory ? { kind: 'module', path: file.path }
      : script ? { kind: 'command', command: script.argv[0], args: script.argv.slice(1), cwd: script.cwd }
      : { kind: 'command', command: language === 'python' ? 'python3' : 'node', args: [file.rel], cwd: root }, evidence);
  }
  // A start script whose file shows no protocol is still how the owner runs the program: offered, with low confidence.
  for (const script of scripts) if (RUN_SCRIPTS.has(script.evidence.name) && !drafts.has(`file:${script.entry}`))
    add(`file:${script.entry}`, { kind: 'command', command: script.argv[0], args: script.argv.slice(1), cwd: script.cwd }, [script.evidence]);
  // A saved connection absorbs what the files it starts showed, so one agent is proposed once.
  for (const [key, draft] of drafts) if (key.startsWith('connection:')) for (const entry of entryFiles(draft.target, root)) {
    const same = drafts.get(`file:${entry}`);
    if (same) { draft.evidence.push(...same.evidence); drafts.delete(`file:${entry}`); }
  }

  const has = (agent: AgentCandidate, kind: AgentEvidence['kind']) => agent.evidence.some(item => item.kind === kind) ? 0 : 1;
  const depth = (agent: AgentCandidate) => agent.evidence[0]!.file.split(sep).length;
  const agents = [...drafts.values()].map(draft => ({ ...draft, confidence: confidence(draft.evidence) }))
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || has(a, 'connection') - has(b, 'connection') || has(a, 'script') - has(b, 'script')
      || depth(a) - depth(b) || a.evidence[0]!.file.localeCompare(b.evidence[0]!.file));

  const folders = new Map<string, number>(), prompts: Entry[] = [];
  for (const file of walked.files) {
    const ext = extOf(file);
    if (!MATERIAL_EXTENSIONS.has(ext)) continue;
    const parts = file.rel.split(sep), lower = parts.map(part => part.toLowerCase()), title = basename(lower.at(-1)!, ext);
    if (title.includes('prompt') || title.includes('промпт') || lower.slice(0, -1).some(part => part === 'prompts' || part === 'промпты')) { prompts.push(file); continue; }
    const at = lower.slice(0, -1).findIndex(part => KNOWLEDGE.has(part));
    if (at >= 0) { const folder = parts.slice(0, at + 1).join(sep); folders.set(folder, (folders.get(folder) ?? 0) + 1); }
  }
  return {
    root, agents,
    logs: logs.sort((a, b) => b.dialogues - a.dialogues || a.file.localeCompare(b.file)),
    materials: [...folders].map(([folder, documents]) => ({ folder, documents })).sort((a, b) => b.documents - a.documents || a.folder.localeCompare(b.folder)),
    prompts: prompts.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel)).map(file => file.rel),
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
    case 'protocol_fields': return `${evidence.file}: знает поля запроса Agent Lab (sessionId, initialState)`;
    case 'url': return `${evidence.file}: адрес ${evidence.url}`;
  }
}

/** How the owner recognises the agent: its start command, its module or its address. */
export function targetLabel(target: RunnableTarget, root: string): string {
  if (target.kind === 'command') return [target.command, ...target.args].join(' ');
  return target.kind === 'module' ? `модуль ${relative(root, target.path)}` : target.url;
}

const CONFIDENCE_NOTE: Record<Confidence, string> = { high: '', medium: ' — похоже на агента; формат запросов Lab проверит при подключении', low: ' — возможно, агент; как он отвечает, не видно' };
const SHOWN = 3;

/** The proposal as plain lines for the terminal; the caller makes each line safe to print. */
export function detectionLines(detection: ProjectDetection): string[] {
  const { root, agents, logs, materials, prompts, env } = detection;
  const more = (count: number) => count > SHOWN ? [`  … ещё ${count - SHOWN}`] : [];
  return [
    `Agent Lab посмотрел папку «${basename(root)}» — ничего не запускал и не менял.`, '',
    'Агент',
    ...agents.length ? agents.slice(0, SHOWN).flatMap(agent => [`  ${agent.confidence === 'high' ? '✓' : '?'} ${targetLabel(agent.target, root)}${CONFIDENCE_NOTE[agent.confidence]}`,
      ...agent.evidence.map(item => `      ${evidenceText(item)}`)]) : ['  не нашёл — Lab спросит, как запускать агента'],
    ...more(agents.length), '',
    'Логи с разговорами',
    ...logs.length ? logs.slice(0, SHOWN).map(log => `  ${log.file} — ${log.complete ? '' : 'в начале файла '}${countText(log.dialogues, ['разговор', 'разговора', 'разговоров'])}`
      + (log.rejected ? `, ${countText(log.rejected, ['запись', 'записи', 'записей'])} ${pluralForm(log.rejected, ['не подошла', 'не подошли', 'не подошли'])}` : '')
      + (log.complete ? '' : `; дальше не читался: файл больше ${IMPORT_FILE_BYTES / 1_000_000} МБ`))
      : ['  не нашёл файлов JSON или JSONL с разговорами'],
    ...more(logs.length), '',
    'Материалы',
    ...materials.length ? materials.slice(0, SHOWN).map(item => `  ${item.folder} — ${countText(item.documents, ['документ', 'документа', 'документов'])}`) : ['  не нашёл папок с документами'],
    ...more(materials.length), '',
    'Промпт агента',
    ...prompts.length ? prompts.slice(0, SHOWN).map(file => `  ${file}`) : ['  не нашёл'],
    ...more(prompts.length),
    ...env.names.length ? ['', `Переменные из ${env.files.join(', ')}: ${env.names.join(', ')} — значения Lab не читает.`] : [],
    ...detection.truncated ? ['', 'Папка большая: просмотрена только часть файлов.'] : [],
  ];
}
