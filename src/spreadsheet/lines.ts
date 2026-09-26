import { countText } from '../plural.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { sampleWords } from '../scenario-library.js';
import { ROLE_WORDS, columnLabel, type ReadingBasis } from './mapping.js';
import type { TableProposal, TableQuestion } from './proposal.js';

/*
 * The proposal in the owner's words: how Lab will read the table and what comes out, in counts — never
 * a word of the conversations themselves. Markers, role values and the values of a column of categories
 * are the export's structure, not its content, and the owner needs to see them to confirm them. The
 * caller makes every line safe to print.
 */

const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const ROWS: [string, string, string] = ['строка', 'строки', 'строк'];
const MESSAGES: [string, string, string] = ['сообщение', 'сообщения', 'сообщений'];
/** «398 из 866 разговоров»: the count after «из». */
const CONVERSATIONS_OF: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
/** «в 120 разговорах». */
const CONVERSATIONS_IN: [string, string, string] = ['разговоре', 'разговорах', 'разговорах'];
const VALUES: [string, string, string] = ['разное значение', 'разных значения', 'разных значений'];
const MORE_VALUES: [string, string, string] = ['значение', 'значения', 'значений'];
const ENCODING_NAMES = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16', 'windows-1251': 'Windows-1251', 'windows-1252': 'Windows-1252' } as const;
const quoted = (text: string) => `«${text}»`;
/** A value of a column of categories as written; an empty cell has no text to quote. */
const shownValue = (value: string) => value ? quoted(value) : 'пусто';
const shown = (separator: string) => separator === '\n' ? 'переносом строки' : separator === '\t' ? 'табуляцией' : `знаком ${quoted(separator.trim() || separator)}`;
const delimiterName = (delimiter: string) => delimiter === '\t' ? 'табуляция' : quoted(delimiter);

/** The first line: which file, which sheet, how big. */
function headLine(proposal: TableProposal): string {
  const where = proposal.csv ? `разделитель ${delimiterName(proposal.csv.delimiter)} · кодировка: ${ENCODING_NAMES[proposal.csv.encoding]}` : `лист ${quoted(proposal.sheet)}`;
  const rows = proposal.status === 'ready' ? proposal.preview.rows : undefined;
  return [`Таблица ${proposal.file.name}`, where, ...rows === undefined ? [] : [countText(rows, ROWS)]].join(' · ');
}

const ROWS_READ: [string, string, string] = ['строку', 'строки', 'строк'];
/** Who proposed the reading, under the first line: the model and how much of the table it read, or Lab by itself and why. */
function basisLine(basis: ReadingBasis): string {
  if (basis.kind === 'model') return `Разметку предложила модель Lab — она прочитала ${countText(basis.rows, ROWS_READ)} таблицы; по этой разметке Lab сам прочитал и проверил каждую строку.`;
  switch (basis.why) {
    case 'no_model': return 'Разметку Lab предположил сам, без модели, — по частоте слов в таблице; проверьте её.';
    case 'model_failed': return 'Модель Lab не нашла разметку, которая сходится с таблицей, — Lab предположил её сам, по частоте слов; проверьте её.';
    case 'owner': return 'С вашими поправками разметка модели Lab не сходится с таблицей — остальное Lab предположил сам, по частоте слов; проверьте.';
  }
}

/** The question in one sentence, with the answers the owner can give. */
export function questionText(question: TableQuestion, found: number): string {
  switch (question.kind) {
    case 'text': return `Lab не нашёл разговоров: в какой колонке их текст? Колонки: ${question.columns.map(column => quoted(columnLabel(column))).join(', ')}.`;
    case 'expected': return question.chosen.length
      ? `Эталон асессора: ${question.chosen.map(item => quoted(item.column)).join(', ')}. Есть ещё колонка ожидаемого результата?`
      : `Одна строка — один вопрос клиента: Lab видит ${countText(found, ROWS)}. В какой колонке ожидаемый результат асессора — он станет эталоном каждой ситуации?`;
    case 'id': return `${found ? `Lab видит ${countText(found, CONVERSATIONS)}. ` : ''}В какой колонке id разговора? Подходят: ${question.columns.map(column => quoted(columnLabel(column))).join(', ')}.`;
    case 'marker': return `Lab видит ${countText(found, CONVERSATIONS)}, но не знает, кто пишет сообщения с меткой ${question.token} в колонке ${quoted(columnLabel(question.column))} (${countText(question.messages, MESSAGES)}): клиент, агент, служебное — или это не метка, а слово в тексте?`;
    case 'role': return `Lab видит ${countText(found, CONVERSATIONS)}, но не знает, кто пишет сообщения со значением ${quoted(question.value)} в колонке ${quoted(columnLabel(question.column))} (${countText(question.messages, MESSAGES)}): клиент, агент или служебное?`;
    case 'where': return `Какие разговоры оценивать? Lab видит ${countText(found, CONVERSATIONS)}; в колонке ${quoted(columnLabel(question.column))} у них ${countText(question.values.length + question.more, VALUES)}`
      + ` — выберите одно или несколько${question.more ? `; ниже ${question.values.length} самых частых` : ''}.`;
    case 'repeats': return `В ${question.dialogues} из ${countText(question.of, CONVERSATIONS_OF)} один и тот же обмен повторяется подряд — убрать повторы?`
      + ` Копий — ${countText(question.messages, MESSAGES)}; каждый обмен останется один раз.`;
    case 'markup': return `В ${question.dialogues} из ${countText(question.of, CONVERSATIONS_OF)} ответы агента содержат вставки в тройных обратных кавычках (\`\`\` … \`\`\`) — ${countText(question.messages, MESSAGES)}.`
      + ' Это элементы интерфейса — кнопки и переходы, которые клиент не читает как текст? Тогда Lab прочитает каждую вставку как «(элемент интерфейса)», а не как слова агента.';
  }
}

/** The answers of «Какие разговоры оценивать?» in the order of `question.values`: each value as written and its conversations. The chat numbers them as its choices do. */
export const whereChoices = (question: Extract<TableQuestion, { kind: 'where' }>): string[] =>
  question.values.map(item => `${shownValue(item.value)} — ${countText(item.dialogues, CONVERSATIONS)}`);
/** The line under the listed values when there are more: the owner names any of them in words. */
export const moreValuesLine = (more: number): string => `ещё ${countText(more, MORE_VALUES)} — назовите нужное сами`;

type ReadyProposal = Extract<TableProposal, { status: 'ready' }>;

const EXPECTED_WORDS = { answer: 'ожидаемый ответ (Lab найдёт его статью в базе знаний; короткий код — код ответа)', article: 'id статьи базы знаний', code: 'код ответа', article_or_code: 'id статьи или код ответа (что есть среди статей базы знаний — статья)' } as const;

/** How the mapping reads the table, one line per choice; without a choice of conversations, the columns they could be chosen by. */
function readingLines({ mapping, preview, selectable }: ReadyProposal): string[] {
  const layout = mapping.layout;
  const counted = (label: string) => countText(preview.messages.find(item => item.label === label)?.count ?? 0, MESSAGES);
  const lines = layout.kind === 'question_per_row'
    ? [`  Один случай — одна строка${mapping.id ? `; id — колонка ${quoted(columnLabel(mapping.id))}` : ''}.`,
      `  Вопрос клиента — колонка ${quoted(columnLabel(mapping.text))} · ${counted('вопрос')}.`,
      layout.answer ? `  Ответ агента из лога — колонка ${quoted(columnLabel(layout.answer))} · ${counted('ответ')}.` : '  Ответа агента в таблице нет: разговор начнётся с вопроса.']
    : layout.kind === 'dialogue_per_row'
    ? [`  Один разговор — одна строка; id разговора — колонка ${quoted(columnLabel(mapping.id!))}.`,
      layout.separator === undefined ? `  Текст — колонка ${quoted(columnLabel(mapping.text))}: сообщения ничем не отделены — новое начинается с каждой метки:`
        : `  Текст — колонка ${quoted(columnLabel(mapping.text))}: сообщения отделены ${shown(layout.separator)}, каждое начинается с метки:`,
      ...layout.markers.map(marker => `    ${marker.token} — ${ROLE_WORDS[marker.role]} · ${counted(marker.token)}`)]
    : [`  Одно сообщение — одна строка; id разговора — колонка ${quoted(columnLabel(mapping.id!))}.`,
      `  Кто пишет — колонка ${quoted(columnLabel(layout.role))}:`,
      ...layout.roles.map(item => `    ${quoted(item.value)} — ${ROLE_WORDS[item.role]} · ${counted(item.value)}`),
      `  Текст — колонка ${quoted(columnLabel(mapping.text))}; порядок сообщений — ${layout.order ? `по колонке ${quoted(columnLabel(layout.order))}` : 'как строки в таблице'}.`];
  for (const item of mapping.expected ?? []) lines.push(`  Ожидание асессора — колонка ${quoted(columnLabel(item.column))}: ${EXPECTED_WORDS[item.kind]} — станет эталоном ситуации.`);
  if (preview.kept.length === 1) lines.push(`  Колонку ${quoted(preview.kept[0]!)} Lab сохранит при разговорах как есть; в оценке она не участвует.`);
  else if (preview.kept.length) lines.push(`  Колонки ${preview.kept.map(quoted).join(', ')} Lab сохранит при разговорах как есть; в оценке они не участвуют.`);
  if (!mapping.filter && selectable.length) lines.push(`  Разговоры можно отобрать по ${selectable.length === 1 ? 'колонке' : 'колонкам'} ${selectable.map(column => quoted(columnLabel(column))).join(', ')}.`);
  return lines;
}

/**
 * What the import will hold: the owner's choice of conversations and how many it keeps of the sheet's, how many
 * of those fit and why the rest do not, and the sample when there are more than one import takes.
 */
function outcomeLines({ mapping, preview, basis }: ReadyProposal): string[] {
  const considered = preview.selected ?? preview.dialogues;
  const rejected = considered - preview.usable;
  const reasons = preview.rejected.slice(0, 4).map(item => `${item.reason.charAt(0).toLowerCase()}${item.reason.slice(1)} — ${item.count}`);
  const lines = mapping.filter && preview.selected !== undefined
    ? [`  Отбор: ${quoted(columnLabel(mapping.filter.column))} = ${mapping.filter.values.map(shownValue).join(' или ')} — ${preview.selected} из ${countText(preview.dialogues, CONVERSATIONS_OF)}.`] : [];
  const repeats = preview.repeats;
  if (repeats) lines.push(mapping.collapseRepeats
    ? `  Повторы убраны: ${countText(repeats.messages, MESSAGES)} в ${countText(repeats.dialogues, CONVERSATIONS_IN)} — каждый обмен остался один раз.`
    : `  В ${countText(repeats.dialogues, CONVERSATIONS_IN)} обмен повторяется подряд (копий — ${countText(repeats.messages, MESSAGES)}); Lab читает их как написано.`);
  const markup = preview.markup;
  if (markup) lines.push(mapping.interfaceMarkup === 'fenced'
    ? `  Вставки в \`\`\` в ответах агента (${countText(markup.messages, MESSAGES)}) читаются как элементы интерфейса, а не как слова агента.`
    : `  Вставки в \`\`\` в ответах агента (${countText(markup.messages, MESSAGES)}) читаются как слова агента.`);
  // The model's verdict is said only while the copies are its decision; the owner's own choice needs no reason.
  const verdict = basis?.kind === 'model' ? basis.repeats : undefined;
  if (repeats && verdict && verdict !== 'none') lines.push(verdict === 'export_copies' ? '  Так решила модель Lab: это копии, которые сделала выгрузка.' : '  Так решила модель Lab: клиенты и правда повторялись.');
  lines.push(`  ${countText(considered, CONVERSATIONS)}: подходят ${preview.usable}${rejected ? `, не подошли ${rejected} (${reasons.join(' · ')}${preview.rejected.length > 4 ? ' · …' : ''})` : ''}.`);
  if (preview.taken < preview.usable) lines.push(`  В одну загрузку входит ${countText(preview.taken, CONVERSATIONS)}: ${sampleWords(preview.taken, preview.usable)}.`);
  return lines;
}

/** The whole proposal as the terminal shows it; the caller adds how to answer. */
export function proposalLines(proposal: TableProposal): string[] {
  if (proposal.status === 'refused') return [headLine(proposal), '', proposal.reason];
  const head = [headLine(proposal), ...proposal.basis ? [basisLine(proposal.basis)] : []];
  if (proposal.status === 'question') return [...head, '', questionText(proposal.question, proposal.found),
    ...proposal.question.kind === 'where' ? [...whereChoices(proposal.question).map((choice, i) => `  ${i + 1}. ${choice}`),
      ...proposal.question.more ? [`  …${moreValuesLine(proposal.question.more)}`] : []] : []];
  return [...head, '', 'Как Lab прочитает таблицу', ...readingLines(proposal), '', 'Что получится', ...outcomeLines(proposal)];
}

/** After the owner confirmed: what was stored. */
export function importedLine(batch: ImportBatch): string {
  return `Загружено: ${countText(batch.dialogues.length, CONVERSATIONS)}. Lab запомнил, как читать эту таблицу: тот же файл даст те же разговоры.`;
}
