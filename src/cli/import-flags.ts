import type { Encoding } from '../spreadsheet/csv.js';
import { ROLES, ROLE_WORDS, columnLabel, tableChoicesSchema, type ExpectedKind, type MarkerRole, type TableChoices } from '../spreadsheet/mapping.js';
import type { TableProposal } from '../spreadsheet/proposal.js';

/*
 * How `agent-lab import` takes the owner's answers about a spreadsheet of logs from its flags — the same choices the
 * chat asks one native question at a time — and what the command says to answer the next question.
 */

/** The owner's words for who writes a message, as `--markers` and `--roles` take them. */
const ROLE_BY_WORD: Readonly<Record<string, MarkerRole>> = {
  клиент: 'user', client: 'user', user: 'user', агент: 'assistant', agent: 'assistant', assistant: 'assistant',
  служебное: 'system', system: 'system', текст: 'text', text: 'text',
};
/** `CLIENT=клиент,AGENT=агент` → pairs; a value may itself hold `=`, the role word is after the last one. */
function rolePairs(text: string, flag: string, allowText: boolean): { label: string; role: MarkerRole }[] {
  return text.split(',').map(pair => {
    const at = pair.lastIndexOf('='), label = pair.slice(0, at).trim(), role = ROLE_BY_WORD[pair.slice(at + 1).trim().toLowerCase()];
    if (at < 1 || !label || !role || role === 'text' && !allowText) throw new Error(`${flag}: ожидается ${allowText ? 'МЕТКА' : 'ЗНАЧЕНИЕ'}=клиент|агент|служебное${allowText ? '|текст' : ''}, через запятую.`);
    return { label, role };
  });
}
/**
 * `--where "КОЛОНКА=ЗНАЧЕНИЕ|ЗНАЧЕНИЕ"` → the column and the exact values to keep; the column alone asks which
 * of its values to keep. The column ends at the first `=`: a value may hold `=`, and `|` parts the values, as
 * list-like values (`['A', 'B']`) hold commas. An empty value keeps the conversations whose cell is empty.
 */
function whereChoice(text: string): NonNullable<TableChoices['where']> {
  const at = text.indexOf('=');
  const column = (at < 0 ? text : text.slice(0, at)).trim();
  if (!column) throw new Error('--where: ожидается КОЛОНКА=ЗНАЧЕНИЕ, несколько значений — через |; одна КОЛОНКА покажет её значения.');
  return at < 0 ? { column } : { column, values: text.slice(at + 1).split('|').map(value => value.trim()) };
}
/**
 * `build --roles client=клиент,operator=агент`: who writes under the role names of a JSON log Lab does not know — the
 * owner's word, never Lab's guess. Undefined without the flag.
 */
export function loggedRolesOf(text: string | undefined): ReadonlyMap<string, 'user' | 'assistant' | 'system'> | undefined {
  if (text === undefined) return undefined;
  const pairs = rolePairs(text, '--roles', false);
  return new Map(pairs.map(({ label, role }) => [label, role as 'user' | 'assistant' | 'system']));
}

/** How to answer role names Lab does not know from the command line: the flag of the same command, a role for each. */
export const loggedRolesHint = (names: readonly string[]): string =>
  `Кто есть кто: та же команда с --roles "${names.map(name => `${name}=РОЛЬ`).join(',')}", где РОЛЬ — клиент, агент или служебное.`;

/** `--encoding`: the names an owner may know an encoding by. */
const ENCODING_BY_NAME: Readonly<Record<string, Encoding>> = {
  'utf-8': 'utf-8', utf8: 'utf-8', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', unicode: 'utf-16le',
  'windows-1251': 'windows-1251', cp1251: 'windows-1251', '1251': 'windows-1251', 'windows-1252': 'windows-1252', cp1252: 'windows-1252', '1252': 'windows-1252', latin1: 'windows-1252',
};
function encodingOf(name: string): Encoding {
  const encoding = ENCODING_BY_NAME[name.trim().toLowerCase()];
  if (!encoding) throw new Error('--encoding: ожидается utf-8, utf-16, windows-1251 или windows-1252.');
  return encoding;
}

const EXPECTED_BY_WORD: Readonly<Record<string, ExpectedKind>> = { ответ: 'answer', answer: 'answer', статья: 'article', article: 'article', код: 'code', code: 'code', 'статья-или-код': 'article_or_code' };
/** `--expected-column "КОЛОНКА=ответ|статья|код"` → the assessor's column and what it holds; the column alone holds the expected answer. */
function expectedChoice(text: string): { column: string; kind: ExpectedKind } {
  const at = text.lastIndexOf('=');
  const column = (at < 0 ? text : text.slice(0, at)).trim(), kind = at < 0 ? 'answer' : EXPECTED_BY_WORD[text.slice(at + 1).trim().toLowerCase()];
  if (!column || !kind) throw new Error('--expected-column: ожидается КОЛОНКА=ответ|статья|код.');
  return { column, kind };
}
/** The owner's choices from the command line; each overrides what Lab would propose. */
export function tableChoicesOf(values: Record<string, string | boolean | string[] | undefined>): TableChoices {
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : undefined;
  // A shell passes \n and \t literally; the owner means the characters, every one of them («\n\n» is an empty line).
  const separator = text('separator')?.replaceAll('\\n', '\n').replaceAll('\\t', '\t');
  if (separator && values['no-separator']) throw new Error('Выберите одно: --separator ЗНАК или --no-separator.');
  if (values['collapse-repeats'] && values['keep-repeats']) throw new Error('Выберите одно: --collapse-repeats или --keep-repeats.');
  return tableChoicesSchema.parse({
    ...text('sheet') ? { sheet: text('sheet') } : {}, ...text('id-column') ? { id: text('id-column') } : {},
    ...text('text-column') ? { text: text('text-column') } : {}, ...separator ? { separator } : values['no-separator'] ? { separator: null } : {},
    ...text('markers') ? { markers: rolePairs(text('markers')!, '--markers', true).map(({ label, role }) => ({ token: label, role })) } : {},
    ...text('role-column') ? { role: text('role-column') } : {},
    ...text('roles') ? { roles: rolePairs(text('roles')!, '--roles', false).map(({ label, role }) => ({ value: label, role })) } : {},
    ...text('order-column') ? { order: text('order-column') } : values['row-order'] ? { order: null } : {},
    ...text('where') ? { where: whereChoice(text('where')!) } : {},
    ...values['collapse-repeats'] ? { collapseRepeats: true } : values['keep-repeats'] ? { collapseRepeats: false } : {},
    ...text('encoding') ? { encoding: encodingOf(text('encoding')!) } : {},
    ...text('answer-column') ? { perRow: 'question', answer: text('answer-column') } : {},
    ...text('expected-column') ? { perRow: 'question', expected: [expectedChoice(text('expected-column')!)], expectedDone: true } : values['no-expected'] ? { expected: [], expectedDone: true } : {},
  });
}
/** How to answer the proposal from the command line. */
export function importHints(proposal: TableProposal): string[] {
  const words = ROLES.map(role => ROLE_WORDS[role]).join('|');
  if (proposal.status === 'refused') return ['Поправьте выбор и повторите команду.'];
  if (proposal.status === 'ready') return ['Загрузить: та же команда с --yes.',
    'Поправить: --sheet, --id-column, --text-column; метки — --markers CLIENT=клиент,AGENT=агент и --separator ЗНАК или --no-separator; сообщение в строке — --role-column, --roles, --order-column или --row-order.',
    ...proposal.csv ? ['Текст читается кракозябрами — другая кодировка: --encoding windows-1251, windows-1252 или utf-8.'] : [],
    ...!proposal.mapping.filter && proposal.selectable.length ? ['Отобрать разговоры: --where "КОЛОНКА" покажет её значения, --where "КОЛОНКА=ЗНАЧЕНИЕ|ЗНАЧЕНИЕ" оставит только их.'] : [],
    ...proposal.preview.repeats && !proposal.mapping.collapseRepeats ? ['Убрать повторы обменов: --collapse-repeats.'] : []];
  const question = proposal.question;
  switch (question.kind) {
    case 'marker': return [`Ответ: та же команда с --markers ${question.token}=${words}|текст.`];
    case 'role': return [`Ответ: та же команда с --roles "${question.value}=${words}".`];
    case 'id': return ['Ответ: та же команда с --id-column КОЛОНКА.'];
    case 'text': return ['Ответ: та же команда с --text-column КОЛОНКА.'];
    case 'expected': return ['Ответ: та же команда с --expected-column "КОЛОНКА=ответ|статья|код" или с --no-expected, если такой колонки нет.'];
    case 'where': return [`Ответ: та же команда с --where "${columnLabel(question.column)}=${question.values[0]?.value ?? ''}" — значение как написано в таблице; несколько — через |. Все разговоры — без --where.`];
    case 'repeats': return ['Ответ: та же команда с --collapse-repeats — убрать повторы, или с --keep-repeats — оставить как написано.'];
  }
}
