import { ROLE_WORDS, ROLES, columnLabel, type ExpectedKind, type MarkerRole, type TableChoices } from './mapping.js';
import { whereChoices } from './lines.js';
import type { TableQuestion } from './proposal.js';

/*
 * The one question Lab asks about a spreadsheet, as the numbered answers of a native dialog. Each answer is the
 * owner's choice it stands for, so the host proposes again with it and never guesses a reading. The answers name
 * the export's structure only — columns, markers, role values — never a word of a conversation.
 */

/** One numbered answer: what the owner reads, and the choice it adds to the proposal. */
export interface TableAnswer { label: string; choices: TableChoices }

/** Who may write the messages a marker starts, and «not a marker» for a word Lab took for one. */
const MARKER_ROLES: readonly MarkerRole[] = [...ROLES, 'text'];
const MARKER_WORDS: Readonly<Record<MarkerRole, string>> = { ...ROLE_WORDS, text: 'не метка — слово в тексте сообщения' };

const EXPECTED_WORDS: Readonly<Record<ExpectedKind, string>> = { answer: 'ожидаемый ответ', article: 'id статьи базы знаний', code: 'код ответа', article_or_code: 'id статьи или код ответа' };

/** The answers of `question`, in the order the dialog numbers them. */
export function questionAnswers(question: TableQuestion): TableAnswer[] {
  switch (question.kind) {
    case 'text': return question.columns.map(column => ({ label: `колонка «${columnLabel(column)}»`, choices: { text: columnLabel(column) } }));
    case 'id': return question.columns.map(column => ({ label: `колонка «${columnLabel(column)}»`, choices: { id: columnLabel(column) } }));
    // Each answer adds a column to those already chosen; the last one closes the list.
    case 'expected': return [...question.columns.flatMap(({ column, kinds }) => kinds.map(kind => ({ label: `колонка «${columnLabel(column)}» — ${EXPECTED_WORDS[kind]}`,
      choices: { expected: [...question.chosen, { column: columnLabel(column), kind }] } }))),
      { label: question.chosen.length ? 'больше нет' : 'такой колонки нет', choices: { expected: question.chosen, expectedDone: true } }];
    case 'marker': return MARKER_ROLES.map(role => ({ label: MARKER_WORDS[role], choices: { markers: [{ token: question.token, role }] } }));
    case 'role': return ROLES.map(role => ({ label: ROLE_WORDS[role], choices: { roles: [{ value: question.value, role }] } }));
    // One value per answer, labelled as the preview counts it; several values are kept through the CLI's `--where A|B`.
    case 'where': {
      const labels = whereChoices(question);
      return question.values.map((item, index) => ({ label: labels[index]!, choices: { where: { column: columnLabel(question.column), values: [item.value] } } }));
    }
    case 'repeats': return [{ label: 'убрать повторы — каждый обмен один раз', choices: { collapseRepeats: true } }, { label: 'оставить как написано', choices: { collapseRepeats: false } }];
    case 'markup': return [{ label: 'да — это кнопки и переходы интерфейса, клиент не читает их как текст', choices: { interfaceMarkup: true } },
      { label: 'нет — клиент видит это как текст', choices: { interfaceMarkup: false } }];
  }
}

/** The owner's choices with one more answer: a marker or a role value is decided once and the decisions add up; a column or a sheet is replaced. */
export function withAnswer(choices: TableChoices, answer: TableChoices): TableChoices {
  const { markers, roles } = answer;
  return {
    ...choices, ...answer,
    ...(markers ? { markers: [...(choices.markers ?? []).filter(item => !markers.some(next => next.token === item.token)), ...markers] } : {}),
    ...(roles ? { roles: [...(choices.roles ?? []).filter(item => !roles.some(next => next.value === item.value)), ...roles] } : {}),
  };
}
