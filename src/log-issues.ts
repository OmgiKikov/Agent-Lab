import { LOGGED_CONVERSATION_CHARS, LOGGED_CUSTOMER_MESSAGES, LOGGED_MESSAGE_CHARS } from './limits.js';
import { countText } from './plural.js';
import { LEFT_OUT_CODES, type LeftOutCode, type LeftOutCount, type LeftOutIssue } from './scenario-contracts.js';

/*
 * Why a logged conversation makes no situation, in the owner's words — the one place they are worded. The reader of a
 * log (scenario-library.ts, spreadsheet/dialogues.ts) finds each reason typed, with the value that shows it; every
 * surface that tells the owner what is left out — the consent of a preparation, a table's preview, a refusal when
 * nothing fits — counts them here and lays out these words:
 *
 *   row issues ─► countLeftOut: each conversation once, under its first reason (LEFT_OUT_CODES order) ─► leftOutWords
 *
 * Numbers name the limit the product enforces (limits.ts), so the words and the check never drift apart.
 */

const chars = (count: number): string => count.toLocaleString('ru-RU');
/** «больше 61 раза»: the genitive after «больше». */
const TIMES: [string, string, string] = ['раза', 'раз', 'раз'];
const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const quoted = (value: string): string => `«${value}»`;

/** The reason of many conversations, as a line of the consent counts them: «id повторяется — 2 («c1», «c4»)». */
const LEFT_OUT_WORDS: Readonly<Record<LeftOutCode, string>> = {
  line: 'строка не читается как JSON',
  large: `разговор больше ${chars(LOGGED_CONVERSATION_CHARS)} знаков`,
  shape: 'запись — не разговор: нет id и списка сообщений',
  roles: 'роли, которых Lab не знает',
  id: 'id не из латинских букв, цифр, «_» и «-» (до 80 знаков)',
  duplicate: 'id повторяется',
  shared: 'один id у разных разговоров',
  empty: 'нет ни одного сообщения',
  event: 'событие не читается',
  long_message: `сообщение длиннее ${chars(LOGGED_MESSAGE_CHARS)} знаков`,
  blank: 'пустое сообщение',
  observation: 'неизвестная полнота наблюдения (observation)',
  no_text: 'пустой текст разговора',
  no_marker: 'текст не начинается с метки роли',
  unmapped: 'роль сообщения не указана в разметке',
  no_order: 'у сообщения нет порядкового номера или времени',
  no_customer: 'нет ни одной реплики клиента',
  masked: 'все реплики клиента скрыты обезличиванием',
  long: `клиент пишет больше ${LOGGED_CUSTOMER_MESSAGES} ${TIMES[0]}`,
  hidden: 'реплика клиента целиком скрыта обезличиванием',
};

/** A reason as a count of conversations reads: «id повторяется». */
export const leftOutPhrase = (code: LeftOutCode): string => LEFT_OUT_WORDS[code];

/** One conversation's reason, as its row of the import records it: the value in it when there is one. */
export function issueText(issue: LeftOutIssue): string {
  const value = issue.value;
  switch (issue.code) {
    case 'line': return `${value ? `Строка ${value}` : 'Строка'} не читается как JSON: в файле .jsonl каждая непустая строка — один разговор.`;
    case 'large': return `Разговор больше ${chars(LOGGED_CONVERSATION_CHARS)} знаков JSON — Lab столько не хранит в одном разговоре.`;
    case 'shape': return 'Запись — не разговор: нужен объект с id и списком messages (или events).';
    case 'roles': return `Роль ${quoted(value ?? '')} Lab не знает: он читает user — клиент, assistant — агент, system — служебное, tool — инструмент.`;
    case 'id': return value === undefined ? 'Нет id разговора.' : `Id ${quoted(value)} не годится: нужны латинские буквы, цифры, «_» и «-», до 80 знаков.`;
    case 'duplicate': return `Id ${quoted(value ?? '')} повторяется: разговор с таким id уже есть выше.`;
    case 'shared': return `Id ${quoted(value ?? '')} носят разные разговоры: его строки идут не подряд или в разные дни.`;
    case 'empty': return 'В разговоре нет ни одного сообщения.';
    case 'event': return `${value ? `Событие ${value}` : 'Событие'} не читается: нужен объект с type (message, tool, retrieval, state), role и content.`;
    case 'long_message': return `Сообщение длиннее ${chars(LOGGED_MESSAGE_CHARS)} знаков${value ? ` (${value})` : ''}: это вставленный документ, а не сообщение.`;
    case 'blank': return 'Пустое сообщение: у сообщения нет текста.';
    case 'observation': return `Полнота наблюдения ${quoted(value ?? '')} неизвестна: нужна complete, partial или unknown.`;
    case 'no_text': return 'Пустой текст разговора.';
    case 'no_marker': return 'Текст не начинается с метки роли.';
    case 'unmapped': return `Роль сообщения ${value ? `${quoted(value)} ` : ''}не указана в разметке.`;
    case 'no_order': return 'У сообщения нет порядкового номера или времени.';
    case 'no_customer': return 'В разговоре нет ни одной реплики клиента.';
    case 'masked': return 'Все реплики клиента скрыты обезличиванием.';
    case 'long': return `Клиент пишет ${value ? `${value} ${TIMES[2]}` : `больше ${LOGGED_CUSTOMER_MESSAGES} ${TIMES[0]}`} — ситуация держит первую реплику и ещё ${LOGGED_CUSTOMER_MESSAGES - 1}.`;
    case 'hidden': return 'Реплика клиента целиком скрыта обезличиванием.';
  }
}

/** The order reasons are told in: a conversation with several counts under the first, so the counts add up to the conversations. */
const priority = (code: LeftOutCode): number => LEFT_OUT_CODES.indexOf(code);
/** Values kept to show a reason: enough to recognise it, never the whole log. */
const SHOWN_VALUES = 12;

/** Reasons whose value is what the owner looks for — the line, the id or the value as written; any other is shown by the conversation's id. */
const NAMED_BY_VALUE: ReadonlySet<LeftOutCode> = new Set(['line', 'id', 'observation', 'unmapped']);

/** A conversation left out: why, and its id as the log writes it, when it has one. */
export interface LeftOutRow { issues: readonly LeftOutIssue[]; id?: string }

/**
 * Each conversation once, under its first reason, with the values that show it: for unknown roles every role name
 * (the owner maps them all at once), for an unreadable line the line, for an id the id as written, else the
 * conversation's id. The most frequent reason first; equal counts in LEFT_OUT_CODES order.
 */
export function countLeftOut(rows: Iterable<LeftOutRow>): LeftOutCount[] {
  const counts = new Map<LeftOutCode, LeftOutCount>();
  for (const row of rows) {
    const first = [...row.issues].sort((a, b) => priority(a.code) - priority(b.code))[0];
    if (!first) continue;
    const entry = counts.get(first.code) ?? { code: first.code, count: 0, values: [] };
    entry.count++;
    const shown = first.code === 'roles' ? row.issues.filter(issue => issue.code === 'roles').map(issue => issue.value ?? '')
      : [NAMED_BY_VALUE.has(first.code) ? first.value ?? '' : row.id ?? first.value ?? ''];
    for (const value of shown) if (value && entry.values.length < SHOWN_VALUES && !entry.values.includes(value)) entry.values.push(value.slice(0, 200));
    counts.set(first.code, entry);
  }
  return sortCounts([...counts.values()]);
}

/** Counts of two parts of one log as one: the same reason adds up, its values joined. */
export function mergeLeftOut(...parts: readonly (readonly LeftOutCount[])[]): LeftOutCount[] {
  const merged = new Map<LeftOutCode, LeftOutCount>();
  for (const item of parts.flat()) {
    const entry = merged.get(item.code) ?? { code: item.code, count: 0, values: [] };
    entry.count += item.count;
    for (const value of item.values) if (entry.values.length < SHOWN_VALUES && !entry.values.includes(value)) entry.values.push(value);
    merged.set(item.code, entry);
  }
  return sortCounts([...merged.values()]);
}

const sortCounts = (counts: LeftOutCount[]): LeftOutCount[] => counts.sort((a, b) => b.count - a.count || priority(a.code) - priority(b.code));

/** Examples after a count: «(«c1», «c4» и др.)». Role names are named in the reason itself. */
function examples(item: LeftOutCount): string {
  if (item.code === 'roles' || !item.values.length) return '';
  const shown = item.values.slice(0, 3).map(value => item.code === 'line' ? `строка ${value}` : quoted(value));
  return ` (${shown.join(', ')}${item.count > shown.length ? ' и др.' : ''})`;
}

/** Each reason with its count: «id повторяется — 1 («c1»)», «роли «client», «operator» Lab не знает — 50», the most frequent first. */
export function leftOutWords(counts: readonly LeftOutCount[]): string[] {
  return counts.map(item => `${item.code === 'roles' && item.values.length ? `роли ${item.values.map(quoted).join(', ')} Lab не знает` : LEFT_OUT_WORDS[item.code]} — ${item.count}${examples(item)}`);
}

/** Every conversation counted, whatever its reason. */
export const leftOutTotal = (counts: readonly LeftOutCount[]): number => counts.reduce((sum, item) => sum + item.count, 0);

/** The role names of the log Lab does not know, as written: what the owner maps. */
export const unknownRoles = (counts: readonly LeftOutCount[]): string[] => counts.find(item => item.code === 'roles')?.values ?? [];

/**
 * The line that says which role names Lab reads and how the owner tells it who writes under the others; undefined when
 * every role is known. Never guessed: a bank's «operator» may be a person, not the bot.
 */
export function rolesLine(counts: readonly LeftOutCount[]): string | undefined {
  const item = counts.find(entry => entry.code === 'roles');
  if (!item) return undefined;
  return `Lab читает роли user — клиент, assistant — агент, system — служебное, tool — инструмент, а чужие не угадывает: скажите, кто пишет под ${item.values.map(quoted).join(', ')}`
    + ` (${countText(item.count, CONVERSATIONS)}), — или переименуйте роли в файле.`;
}

/**
 * What to do when no conversation of the log fits, by the reason most of them have: the way out of the most frequent
 * one. The roles are answered by the owner's word, so their line says it.
 */
export function wayOut(counts: readonly LeftOutCount[]): string {
  switch (counts[0]?.code) {
    case 'roles': return rolesLine(counts)!;
    case 'line': case 'shape': return 'Сохраните логи в JSON Lines: одна строка — один разговор, {"id": "…", "messages": [{"role": "user", "content": "…"}, …]}.';
    case 'id': case 'duplicate': case 'shared': return 'Дайте каждому разговору свой id из латинских букв, цифр, «_» и «-».';
    case 'no_customer': return 'Проверьте, что сообщения клиента помечены ролью user.';
    case 'long': return `Ситуацию Lab собирает из разговора, где клиент пишет не больше ${LOGGED_CUSTOMER_MESSAGES} ${TIMES[0]}: выгрузите период, где есть такие разговоры.`;
    case 'masked': case 'hidden': return 'Обезличивание скрыло то, что писал клиент: выгрузите логи, где вместо данных стоят метки вроде [ФИО], а слова клиента остались.';
    default: return 'Исправьте логи и загрузите их снова.';
  }
}
