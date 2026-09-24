import { ROLES, ROLE_WORDS, columnLabel, tableChoicesSchema, type MarkerRole, type TableChoices } from '../spreadsheet/mapping.js';
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
/** The owner's choices from the command line; each overrides what Lab would propose. */
export function tableChoicesOf(values: Record<string, string | boolean | string[] | undefined>): TableChoices {
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : undefined;
  // A shell passes \n and \t literally; the owner means the characters.
  const separator = text('separator')?.replace('\\n', '\n').replace('\\t', '\t');
  return tableChoicesSchema.parse({
    ...text('sheet') ? { sheet: text('sheet') } : {}, ...text('id-column') ? { id: text('id-column') } : {},
    ...text('text-column') ? { text: text('text-column') } : {}, ...separator ? { separator } : {},
    ...text('markers') ? { markers: rolePairs(text('markers')!, '--markers', true).map(({ label, role }) => ({ token: label, role })) } : {},
    ...text('role-column') ? { role: text('role-column') } : {},
    ...text('roles') ? { roles: rolePairs(text('roles')!, '--roles', false).map(({ label, role }) => ({ value: label, role })) } : {},
    ...text('order-column') ? { order: text('order-column') } : values['row-order'] ? { order: null } : {},
    ...text('where') ? { where: whereChoice(text('where')!) } : {},
  });
}
/** How to answer the proposal from the command line. */
export function importHints(proposal: TableProposal): string[] {
  const words = ROLES.map(role => ROLE_WORDS[role]).join('|');
  if (proposal.status === 'refused') return ['Поправьте выбор и повторите команду.'];
  if (proposal.status === 'ready') return ['Загрузить: та же команда с --yes.',
    'Поправить: --sheet, --id-column, --text-column; метки — --markers CLIENT=клиент,AGENT=агент и --separator; сообщение в строке — --role-column, --roles, --order-column или --row-order.',
    ...!proposal.mapping.filter && proposal.selectable.length ? ['Отобрать разговоры: --where "КОЛОНКА" покажет её значения, --where "КОЛОНКА=ЗНАЧЕНИЕ|ЗНАЧЕНИЕ" оставит только их.'] : []];
  const question = proposal.question;
  switch (question.kind) {
    case 'marker': return [`Ответ: та же команда с --markers ${question.token}=${words}|текст.`];
    case 'role': return [`Ответ: та же команда с --roles "${question.value}=${words}".`];
    case 'id': return ['Ответ: та же команда с --id-column КОЛОНКА.'];
    case 'text': return ['Ответ: та же команда с --text-column КОЛОНКА.'];
    case 'where': return [`Ответ: та же команда с --where "${columnLabel(question.column)}=${question.values[0]?.value ?? ''}" — значение как написано в таблице; несколько — через |. Все разговоры — без --where.`];
  }
}
