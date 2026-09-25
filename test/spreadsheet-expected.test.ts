import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessorReference, articleOf } from '../src/card/assessor.js';
import { importTable } from '../src/spreadsheet/dialogues.js';
import { proposalLines } from '../src/spreadsheet/lines.js';
import { proposeTable, type TableProposal } from '../src/spreadsheet/proposal.js';
import type { TableChoices } from '../src/spreadsheet/mapping.js';
import { readWorkbook, tableFileOf } from '../src/spreadsheet/workbook.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * A sheet of reviewed cases: one customer question per row, the agent's logged reply, and the assessor's expected
 * result — the reply the agent should have given, or an answer code. Read as the owner says, it carries the markup
 * with each conversation; the markup becomes the situation's reference.
 */

const ARTICLE = 'Код услуги (ИНО) — это индивидуальный номер объекта инкассации, используемый для заказа и отмены инкассации.';
const HEADER = ['Вопрос клиента', 'Условия кейса', 'Ожидалось', 'Получилось', 'Версия'];
const rows: CellSpec[][] = [HEADER,
  ['Как узнать код клиента для инкассации', 'Полномочия: 3', ARTICLE, 'Обратитесь в отделение.', 'Новая'],
  ['Как узнать код клиента для инкассации', 'Полномочия: 0', ARTICLE, 'Код в памятке.', 'Старая'],
  ['Закажи инкассацию на завтра', 'Полномочия: 3', '202-2', 'Готово, заказал.', 'Новая'],
];
const choices: TableChoices = { perRow: 'question', text: 'Вопрос клиента', answer: 'Получилось', expected: [{ column: 'Ожидалось', kind: 'answer' }] };

function ready(proposal: TableProposal): Extract<TableProposal, { status: 'ready' }> {
  assert.equal(proposal.status, 'ready', JSON.stringify(proposal.status === 'refused' ? proposal.reason : proposal));
  return proposal as Extract<TableProposal, { status: 'ready' }>;
}
function read(chosen: TableChoices) {
  const bytes = xlsxFile([{ name: 'раг', rows }]), file = tableFileOf('кейсы.xlsx', bytes), workbook = readWorkbook(bytes, file);
  const proposal = ready(proposeTable(workbook, file, chosen));
  return { proposal, batch: importTable(workbook.sheets[0]!, proposal.mapping).batch };
}

test('one question per row: each row is its own case, named by its row, with the agent\'s logged reply', () => {
  const { batch } = read(choices);
  assert.deepEqual(batch.dialogues.map(item => item.id), ['row_2', 'row_3', 'row_4'], 'two rows asking the same question are two cases');
  assert.deepEqual(batch.dialogues[0]!.events.map(event => [event.role, event.content]), [['user', 'Как узнать код клиента для инкассации'], ['assistant', 'Обратитесь в отделение.']]);
});

test('the assessor\'s column travels with each conversation and is not kept as an ordinary column', () => {
  const { batch } = read(choices);
  const original = batch.dialogues[2]!.original as { expected?: unknown; columns?: Record<string, string> };
  assert.deepEqual(original.expected, [{ kind: 'answer', value: '202-2' }]);
  assert.deepEqual(Object.keys(original.columns ?? {}), ['Условия кейса', 'Версия']);
});

test('the owner sees how the table is read, the assessor\'s column included', () => {
  const lines = proposalLines(read(choices).proposal).join('\n');
  assert.match(lines, /Вопрос клиента — колонка «Вопрос клиента»/);
  assert.match(lines, /Ответ агента из лога — колонка «Получилось»/);
  assert.match(lines, /Ожидание асессора — колонка «Ожидалось».*станет эталоном ситуации/);
});

test('a question column is the owner\'s to name', () => {
  const bytes = xlsxFile([{ name: 'раг', rows }]), file = tableFileOf('кейсы.xlsx', bytes);
  const proposal = proposeTable(readWorkbook(bytes, file), file, { perRow: 'question' });
  assert.equal(proposal.status, 'refused');
});

const kb = [{ id: 'source-1', name: 'knowledge-base', hash: 'h', content: `# База знаний\n\n## Статья 24\n\n${ARTICLE}\n\n## Статья 32\n\nКод выдаёт менеджер.\n` }];

test('an expected answer that stands in an article names the article and stays the text for the judge', () => {
  assert.equal(articleOf(ARTICLE, kb), '24');
  assert.deepEqual(assessorReference({ expected: [{ kind: 'answer', value: ARTICLE }] }, kb),
    [{ id: 'assessor', origin: 'assessor', confirmed: true, source: { doc: '24' }, text: ARTICLE }]);
});

test('a one-word expected answer is an answer code; a code column and an article column are read as they say', () => {
  assert.deepEqual(assessorReference({ expected: [{ kind: 'answer', value: '202-2' }] }, kb), [{ id: 'assessor', origin: 'assessor', confirmed: true, outcome: { value: '202-2' } }]);
  assert.deepEqual(assessorReference({ expected: [{ kind: 'article', value: '32' }, { kind: 'code', value: '200' }] }, kb),
    [{ id: 'assessor', origin: 'assessor', confirmed: true, source: { doc: '32' }, outcome: { value: '200' } }]);
});

test('an answer no article holds stays text for the judge; no markup gives no reference', () => {
  assert.deepEqual(assessorReference({ expected: [{ kind: 'answer', value: 'Позвоните в поддержку банка.' }] }, kb),
    [{ id: 'assessor', origin: 'assessor', confirmed: true, text: 'Позвоните в поддержку банка.' }]);
  assert.equal(assessorReference({ columns: { Ожидалось: 'x' } }, kb), undefined);
});

test('a text column without role marks reads as one question per row, and Lab asks which column holds the assessor\'s result', async () => {
  const { questionAnswers, withAnswer } = await import('../src/spreadsheet/answers.js');
  const bytes = xlsxFile([{ name: 'раг', rows }]), file = tableFileOf('кейсы.xlsx', bytes), workbook = readWorkbook(bytes, file);
  const asked = proposeTable(workbook, file, { text: 'Вопрос клиента' });
  assert.equal(asked.status, 'question');
  const question = (asked as Extract<TableProposal, { status: 'question' }>).question;
  assert.equal(question.kind, 'expected');
  const answers = questionAnswers(question);
  assert.ok(answers.some(answer => answer.label === 'колонка «Ожидалось» — ожидаемый ответ'));
  assert.equal(answers.at(-1)!.label, 'такой колонки нет');
  const chosen = answers.find(answer => answer.label === 'колонка «Ожидалось» — ожидаемый ответ')!;
  const proposal = ready(proposeTable(workbook, file, withAnswer({ text: 'Вопрос клиента' }, chosen.choices)));
  assert.deepEqual(proposal.mapping.expected, [{ column: { index: 2, header: 'Ожидалось' }, kind: 'answer' }]);
  assert.equal(ready(proposeTable(workbook, file, { text: 'Вопрос клиента', expected: [] })).mapping.expected, undefined, 'the owner said there is none');
});
