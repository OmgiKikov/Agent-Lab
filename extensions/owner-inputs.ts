import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { settingsSchema } from '../src/contracts.js';
import { detectProject, type ProjectDetection } from '../src/detect.js';
import { readDialogueImport } from '../src/imports.js';
import { expandMaterials, promptMaterials } from '../src/materials.js';
import { ensureSomethingFits, loggedRolesToMap, NothingFits } from '../src/miner/plan.js';
import type { PromptCandidate } from '../src/prompt-candidates.js';
import { countText } from '../src/plural.js';
import type { ImportBatch } from '../src/scenario-contracts.js';
import type { Encoding } from '../src/spreadsheet/csv.js';
import { TABLE_EXTENSIONS } from '../src/spreadsheet/workbook.js';
import { safeText } from '../src/text.js';
import { row } from './conversation.ts';
import { NeedsOwner, requireInteractive } from './lab-ui.ts';
import type { LabHost } from './host.ts';
import { choosePromptsWithLab } from './prompt-choice.ts';
import { confirmedBefore, importTable } from './table-import.ts';

/*
 * What a request about the owner's logs names, made into what Lab reads: the log file — found in the project folder
 * when the request names none —, a spreadsheet read only through the reading its owner confirmed, the role names the
 * owner mapped, and the rules — the files named, the prompts the owner picks among those Lab finds, the owner's own
 * words. Shared by the preparation of situations (prepare-tool.ts) and the analysis of the logs (analyze-tool.ts):
 * the same questions, each in the words of the work it serves. Nothing is spent here.
 */

export type OwnerWork = 'prepare' | 'analyze';

/** What each work says where the words differ. */
const WORDS: Readonly<Record<OwnerWork, { not: string; cancelled: string; pick: string; rulesOption: boolean; noLogs: string; noLogsOwner: string }>> = {
  prepare: { not: 'Не собираю', cancelled: 'Сбор ситуаций отменён', pick: 'Из каких логов собрать ситуации?', rulesOption: true,
    noLogs: 'В папке проекта нет файлов с разговорами. Спросите владельца, где лежат логи (JSON, JSONL, XLSX или CSV), — или пусть скажет «начать без логов» (withoutLogs).',
    noLogsOwner: 'Есть записи разговоров с агентом? Назовите файл с логами — или скажите «начать без логов».' },
  analyze: { not: 'Не разбираю', cancelled: 'Разбор логов отменён', pick: 'Какие логи разобрать?', rulesOption: false,
    noLogs: 'В папке проекта нет файлов с разговорами. Спросите владельца, где лежат логи (JSON, JSONL, XLSX или CSV).',
    noLogsOwner: 'Где записи разговоров агента? Назовите файл с логами — JSON, JSONL, XLSX или CSV.' },
};

/** What the owner's request names; every field optional, as the tools' parameters are. */
export interface OwnerRequest {
  task?: string; logs?: string; withoutLogs?: true; materials?: string[]; prompts?: string[]; rules?: string;
  table?: { sheet?: string; id?: string; text?: string; where?: { column: string; values?: string[] }; request?: string; collapseRepeats?: boolean; interfaceMarkup?: boolean;
    encoding?: Encoding; answer?: string; expected?: { column: string; kind: 'answer' | 'article' | 'code' | 'article_or_code' }[] };
}

/** What Lab reads of the owner's request: the logs as an import (none from the rules alone), the rules, what was skipped. */
export interface OwnerInputs {
  logs: string | 'rules';
  libraryImport?: ImportBatch;
  expanded: Awaited<ReturnType<typeof expandMaterials>>;
  prompts: PromptCandidate[];
  files: { materialFiles: string[]; promptFiles: string[] };
  found: ProjectDetection | undefined;
  notes: string[];
}

/** A path the owner or the model named: `~/…` is the owner's home, anything else is relative to the project. */
export function projectPath(named: string, cwd: string): string {
  return named === '~' || named.startsWith('~/') ? join(homedir(), named.slice(1)) : resolve(cwd, named);
}
/** How a path is shown to the owner: inside the project relative to it, elsewhere from ~. */
export function shownPath(file: string, cwd: string): string {
  const inside = relative(cwd, file);
  if (inside && !inside.startsWith('..')) return inside;
  const home = homedir();
  return file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

/** Which of the logs Lab found in the project folder: the one there is, or the owner's pick of several; «rules» — the owner chose to start without logs. */
async function logsOf(ctx: ExtensionContext, found: ProjectDetection | undefined, work: OwnerWork): Promise<string | 'rules' | undefined> {
  const words = WORDS[work];
  const logs = found?.logs ?? [];
  if (!logs.length) throw new NeedsOwner('needs_owner_input', words.noLogs, [], words.noLogsOwner);
  if (logs.length === 1) return join(found!.root, logs[0]!.file);
  requireInteractive(ctx, 'В папке несколько файлов с логами: какой взять, решает владелец в интерактивном терминале Pi. Назовите файл в logs.');
  const labels = logs.slice(0, 8).map(log => safeText(`${log.file} — ${countText(log.dialogues, ['разговор', 'разговора', 'разговоров'])}${log.table ? ', таблица' : ''}`));
  const without = 'Без логов — по вашим правилам';
  const picked = await ctx.ui.select(safeText(`${words.pick}\n\nLab нашёл в папке проекта несколько файлов с разговорами:`), [...labels, ...words.rulesOption ? [without] : [], 'Не сейчас']);
  if (words.rulesOption && picked === without) return 'rules';
  const index = labels.indexOf(picked ?? '');
  return index < 0 ? undefined : join(found!.root, logs[index]!.file);
}

/** A prompt id the request named that Lab did not find: the model named it wrong, the owner is asked. */
function unknownPrompt(id: string, found: ProjectDetection | undefined): never {
  const known = (found?.prompts ?? []).slice(0, 12).map(prompt => prompt.id);
  throw new NeedsOwner('unknown_reference', `Промпта ${id} Lab в проекте не нашёл.${known.length ? ` Есть: ${known.join('; ')}.` : ''} Спросите владельца, какой нужен.`, known,
    'Такого промпта Lab в проекте не нашёл — какой из найденных задаёт ответ клиенту?');
}

/** The answers to «кто пишет под этой ролью?»: a role of the conversation, or the owner's word that Lab should leave those conversations aside. */
const ROLE_ANSWERS = [['клиент', 'user'], ['агент — бот, которого проверяем', 'assistant'], ['служебное', 'system']] as const;
const LEAVE_ROLE = 'не знаю — оставить эти разговоры в стороне';

/**
 * Who writes under each role name of the logs Lab does not know (`client`, `operator`): one native question per name,
 * never guessed — a bank's «operator» may be a person, not the bot. `declined` when the owner stepped back.
 */
async function askLoggedRoles(ctx: ExtensionContext, names: readonly string[]): Promise<ReadonlyMap<string, 'user' | 'assistant' | 'system'> | 'declined'> {
  const roles = new Map<string, 'user' | 'assistant' | 'system'>();
  for (const name of names) {
    const picked = await ctx.ui.select(safeText(`Кто пишет сообщения с ролью «${name}» в логах?\n\nLab читает роли user, assistant, system и tool, а эту не угадывает: под ней может быть и бот, и живой сотрудник.`),
      [...ROLE_ANSWERS.map(([label]) => label), LEAVE_ROLE, 'Не сейчас']);
    const role = ROLE_ANSWERS.find(([label]) => label === picked)?.[1];
    if (role) roles.set(name, role);
    else if (picked !== LEAVE_ROLE) return 'declined';
  }
  return roles;
}

/** The owner stepped back: nothing was spent or written, and the model is told not to ask again unless they do. */
export function declined(host: Pick<LabHost, 'feedResult'>, callId: string, text: string, work: OwnerWork = 'prepare'): AgentToolResult<unknown> {
  return host.feedResult(callId, { cancelled: true, spent: 0, instruction: 'The owner stepped back: nothing was spent or written. Do not ask again unless they do.' },
    { tone: 'warning', rows: [row(text)] }, WORDS[work].cancelled);
}

/**
 * The owner's logs and rules as Lab reads them for `work`, or the answer that ends the request here: the owner declined
 * a question, or a spreadsheet could not be read. A preparation also refuses logs no situation can be made from; an
 * analysis judges what a situation could not be made of, and checks its own conversations in its consent.
 */
export async function ownerInputs(host: Pick<LabHost, 'open' | 'feedResult'>, callId: string, ctx: ExtensionContext, signal: AbortSignal, params: OwnerRequest,
  work: OwnerWork): Promise<OwnerInputs | AgentToolResult<unknown>> {
  const { not } = WORDS[work];
  const directory = resolve(ctx.cwd, '.agent-lab');
  const named = !!(params.materials || params.prompts || params.rules);
  // A prompt named by its id (file#CONSTANT) is one Lab finds in the project, verbatim.
  const byId = (params.prompts ?? []).filter(item => item.includes('#'));
  // Lab looks through the project for what the request did not name: the logs, the rules, how the agent is started.
  const found = params.logs && named && !byId.length ? undefined : await detectProject(ctx.cwd).catch(() => undefined);
  const logs = params.withoutLogs && work === 'prepare' ? 'rules' as const : params.logs ? projectPath(params.logs, ctx.cwd) : await logsOf(ctx, found, work);
  if (logs === undefined) return declined(host, callId, `${not}: файл с логами не выбран. Ничего не потрачено.`, work);
  if (logs !== 'rules' && !await stat(logs).then(info => info.isFile(), () => false)) {
    throw new NeedsOwner('unknown_reference', `Файла с логами ${shownPath(logs, ctx.cwd)} нет. Спросите владельца, где он лежит.`, [], `Файла ${shownPath(logs, ctx.cwd)} нет — где лежат логи?`);
  }
  // The model can say this itself from the project or the owner's words: a plain error it corrects, never a question to
  // the owner. The owner reads it too, so it names no parameter: the tool's schema tells the model which one it is.
  if (!params.task) throw new Error('Не хватает описания агента: одной-двумя фразами — что он делает и что проверить.');
  // The rules: the files named, otherwise the knowledge folders found in the project and the prompts the owner picks among
  // those found; the owner's own words on top.
  let prompts: PromptCandidate[];
  if (named) {
    prompts = byId.map(id => found?.prompts.find(prompt => prompt.id === id) ?? unknownPrompt(id, found));
  } else {
    if (found?.prompts.length) requireInteractive(ctx, 'Какие промпты — правила ответа бота, выбираете вы в интерактивном терминале Pi: откройте Agent Lab там (agent-lab chat) — или назовите промпты сами. Ничего не потрачено.');
    let picked: PromptCandidate[] | 'declined' = [];
    if (found?.prompts.length) {
      // The writer's lease for the length of the choice: a proposal Lab's model makes is stored for the next look.
      const owned = await host.open(ctx.cwd);
      try { await owned.lab.init(); picked = await choosePromptsWithLab(ctx, owned.lab, found.prompts, signal); } finally { await owned.close(); }
    }
    if (picked === 'declined') return declined(host, callId, `${not}: промпты не выбраны. Ничего не потрачено.`, work);
    prompts = picked;
  }
  const files = named ? { materialFiles: (params.materials ?? []).map(item => projectPath(item, ctx.cwd)),
    promptFiles: (params.prompts ?? []).filter(item => !item.includes('#')).map(item => projectPath(item, ctx.cwd)) }
    : { materialFiles: (found?.materials ?? []).map(item => join(found!.root, item.folder)), promptFiles: [] };
  const inline = [...(params.rules ? [{ name: 'Правила из разговора', content: params.rules }] : []),
    ...promptMaterials(prompts).map(({ name, content, kind }) => ({ name, content, kind }))];
  const expanded = await expandMaterials({ ...(inline.length ? { materials: inline } : {}), ...files }, ctx.cwd);
  if (!expanded.materials.length) throw new NeedsOwner('needs_owner_input', 'Нет правил, по которым судить агента: Lab не нашёл ни промпта, ни базы знаний. Спросите владельца, где они (файлы или папка: materials, prompts), или пусть напишет правила словами (rules).', [],
    'По каким правилам судить агента? Назовите файл с промптом или базой знаний — или напишите правила словами.');
  const notes = [...expanded.skipped.slice(0, 20).map(item => `Пропущен ${shownPath(item.file, ctx.cwd)}: ${item.reason}.`),
    ...(expanded.skipped.length > 20 ? [`…и ещё ${expanded.skipped.length - 20} пропущенных файлов.`] : [])];

  // The logs become an import: a spreadsheet only through the reading its owner confirmed.
  let libraryImport: ImportBatch | undefined;
  if (logs !== 'rules') {
    if (TABLE_EXTENSIONS.has(extname(logs).toLowerCase())) {
      const { sheet, id, text, where, request: words, collapseRepeats, interfaceMarkup, encoding, answer, expected } = params.table ?? {};
      // The owner's corrections, said in words; which conversations to keep is asked natively when no value was named.
      const choices = { ...(sheet ? { sheet } : {}), ...(id ? { id } : {}), ...(text ? { text } : {}), ...(where ? { where } : {}), ...(collapseRepeats === undefined ? {} : { collapseRepeats }), ...(interfaceMarkup === undefined ? {} : { interfaceMarkup }),
        ...(encoding ? { encoding } : {}), ...(answer ? { perRow: 'question' as const, answer } : {}), ...(expected?.length ? { expected } : {}) };
      if (Object.keys(choices).length || words || !await confirmedBefore(logs, directory)) {
        requireInteractive(ctx, 'Как читать таблицу, решаете вы в интерактивном терминале Pi: откройте Agent Lab там (agent-lab chat) и повторите просьбу. Ничего не прочитано и не потрачено.');
        const owned = await host.open(ctx.cwd);
        let imported: Awaited<ReturnType<typeof importTable>>;
        try {
          await owned.lab.init();
          // The chat's model reads the table, as it prepares the situations after it; without one Lab reads it by itself and says so.
          const settings = ctx.model && settingsSchema.parse({ provider: ctx.model.provider, model: ctx.model.id });
          const reader = settings && (await owned.lab.modelRuntime(settings)).tableReading;
          imported = await importTable(ctx, owned.lab.store, logs, choices, reader && settings ? { reader, timeoutMs: settings.timeoutMs, signal, ...(words ? { words } : {}) } : undefined);
        } finally { await owned.close(); }
        if ('declined' in imported) return declined(host, callId, `Таблицу не загружаю: вы не подтвердили, как её читать. Ничего не потрачено.`, work);
        if ('refused' in imported) return host.feedResult(callId, { refused: imported.refused, instruction: 'Nothing was read. Tell the owner why in one sentence; they may name the sheet or a column (table).' },
          { tone: 'warning', rows: [row(safeText(imported.refused))] }, 'Таблица не прочитана');
      }
    }
    const read = async (roles?: ReadonlyMap<string, 'user' | 'assistant' | 'system'>) => {
      try { return await readDialogueImport(logs, { directory, ...(roles ? { roles } : {}) }); }
      catch (error) { throw new Error(safeText(`Не удалось прочитать логи ${shownPath(logs, ctx.cwd)}: ${error instanceof Error ? error.message : String(error)} Агент не запускался, ничего не потрачено.`)); }
    };
    libraryImport = await read();
    // A table's roles are its confirmed reading; a JSON log's unknown role names are the owner's word, asked before the consent.
    const names = TABLE_EXTENSIONS.has(extname(logs).toLowerCase()) ? [] : loggedRolesToMap(libraryImport);
    if (names.length) {
      requireInteractive(ctx, `В логах роли, которых Lab не знает (${names.join(', ')}): кто пишет под ними, решаете вы в интерактивном терминале Pi. Откройте Agent Lab там (agent-lab chat) и повторите просьбу. Ничего не потрачено.`);
      const roles = await askLoggedRoles(ctx, names);
      if (roles === 'declined') return declined(host, callId, `${not}: вы не сказали, кто пишет под ролями логов. Ничего не потрачено.`, work);
      if (roles.size) libraryImport = await read(roles);
    }
    // Logs no situation can be made from are refused with every reason and the way out, the engine's own words.
    if (work === 'prepare') {
      try { ensureSomethingFits(libraryImport); } catch (error) { throw error instanceof NothingFits ? new Error(error.message) : error; }
    }
  }
  return { logs, ...(libraryImport ? { libraryImport } : {}), expanded, prompts, files, found, notes };
}

/** Whether `read` is an answer that ended the request, not the owner's inputs. */
export const endedEarly = (read: OwnerInputs | AgentToolResult<unknown>): read is AgentToolResult<unknown> => 'content' in read;
