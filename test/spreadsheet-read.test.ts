import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xmlTokens, decodeEntities } from '../src/spreadsheet/xml.js';
import { readXlsx } from '../src/spreadsheet/xlsx.js';
import { readCsv } from '../src/spreadsheet/csv.js';
import { tableFormat } from '../src/spreadsheet/workbook.js';
import { columnIndex, columnLetter } from '../src/spreadsheet/sheet.js';
import { ArchiveTooLarge, zipEntries, zipRead } from '../src/zip.js';
import { zipArchive } from './helpers/zip.js';
import { xlsxFile } from './helpers/xlsx.js';

test('the XML tokenizer reads elements, attributes in either quotes, entities, CDATA, and skips comments and declarations', () => {
  const tokens = [...xmlTokens(`${String.fromCharCode(0xfeff)}<?xml version="1.0"?><!-- note --><x:row r=\'2\' spans="1:3"><c r="A2" t="s"/><t xml:space="preserve"> a &amp; b &#x41;&#66; &lt;&gt;</t><![CDATA[<raw & text>]]></x:row>`)];
  assert.deepEqual(tokens.map(token => token.kind === 'open' ? [token.kind, token.name, Object.fromEntries(token.attributes), token.empty] : token.kind === 'close' ? [token.kind, token.name] : [token.kind, token.text]), [
    ['open', 'x:row', { r: '2', spans: '1:3' }, false],
    ['open', 'c', { r: 'A2', t: 's' }, true],
    ['open', 't', { 'xml:space': 'preserve' }, false],
    ['text', ' a & b AB <>'],
    ['close', 't'],
    ['text', '<raw & text>'],
    ['close', 'x:row'],
  ]);
  // A `>` inside an attribute value belongs to the value.
  const [tag] = [...xmlTokens('<a title="1 > 0"/>')];
  assert.equal(tag?.kind === 'open' && tag.attributes.get('title'), '1 > 0');
  // Unknown entities stay as written: without a DTD nothing defines them.
  assert.equal(decodeEntities('R&D &nbsp; &#xZZ; &amp;'), 'R&D &nbsp; &#xZZ; &');
});

test('a document type declaration and broken markup are refused with a plain reason', () => {
  assert.throws(() => [...xmlTokens('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')], /DTD/);
  assert.throws(() => [...xmlTokens('<row r="1"')], /повреждена: не закрыт тег/);
  assert.throws(() => [...xmlTokens('<c r=1/>')], /без кавычек/);
  assert.throws(() => [...xmlTokens('<!-- open')], /комментарий/);
});

test('the ZIP reader returns stored and deflated entries, and refuses an entry that unpacks beyond the cap', () => {
  const archive = zipArchive([{ name: 'a.txt', data: 'stored', deflate: false }, { name: 'b.txt', data: 'deflated '.repeat(100) }]);
  const entries = zipEntries(archive)!;
  assert.deepEqual(entries.map(entry => [entry.name, entry.method]), [['a.txt', 0], ['b.txt', 8]]);
  assert.equal(zipRead(archive, entries[0]!, 100).toString(), 'stored');
  assert.equal(zipRead(archive, entries[1]!, 10_000).toString(), 'deflated '.repeat(100));
  assert.throws(() => zipRead(archive, entries[1]!, 100), ArchiveTooLarge);
  assert.equal(zipEntries(Buffer.from('plain text, not an archive')), null);
  // A declared size that lies does not get past the cap: the inflater stops at it.
  const bomb = zipArchive([{ name: 'bomb.xml', data: Buffer.alloc(5_000_000) }]);
  const [entry] = zipEntries(bomb)!;
  assert.throws(() => zipRead(bomb, { ...entry!, size: 10 }, 1_000_000), ArchiveTooLarge);
  // A changed byte is caught by the checksum.
  const damaged = Buffer.from(archive), at = 30 + 'a.txt'.length;
  damaged[at] = damaged[at]! ^ 0xff;
  assert.throws(() => zipRead(damaged, zipEntries(damaged)![0]!, 100), /повреждён/);
});

test('column letters and indexes are each other\'s inverse', () => {
  for (const [index, letters] of [[0, 'A'], [25, 'Z'], [26, 'AA'], [51, 'AZ'], [52, 'BA'], [701, 'ZZ'], [702, 'AAA']] as const) {
    assert.equal(columnLetter(index), letters);
    assert.equal(columnIndex(letters), index);
    assert.equal(columnIndex(letters.toLowerCase()), index);
  }
  for (const text of ['', 'A1', 'Ж', 'ABCD']) assert.equal(columnIndex(text), undefined, text);
});

test('an .xlsx sheet reads shared, inline and rich strings, numbers, booleans, empty and merged cells as the owner sees them', () => {
  const file = xlsxFile([{
    name: 'Данные',
    rows: [
      ['Id', 'Текст', 'Дата', 'Флаг'],
      ['d1', { inline: 'CLIENT привет & «пока» ` AGENT <здравствуйте>' }, 45909.4375, true],
      ['d2', { rich: ['CLIENT жирный ', 'и обычный'], phonetic: 'ふりがな' }, null, false],
      [null, 'текст_x000D_\nперенос _x005F_x000D_ буквально', null, null],
      ['merged', 'A', 'B', null],
      [null, null, null, null],
      [null, 'после объединения', null, null],
    ],
    merges: ['A5:A7', 'C5:D5'],
  }], { extra: [{ name: 'xl/styles.xml', data: '<styleSheet/>' }] });
  const [sheet] = readXlsx(file);
  assert.equal(sheet?.name, 'Данные');
  assert.deepEqual(sheet?.rows, [
    ['Id', 'Текст', 'Дата', 'Флаг'],
    ['d1', 'CLIENT привет & «пока» ` AGENT <здравствуйте>', '45909.4375', 'TRUE'],
    ['d2', 'CLIENT жирный и обычный', '', 'FALSE'],
    ['', 'текст\r\nперенос _x000D_ буквально'],
    ['merged', 'A', 'B', 'B'],
    ['merged'],
    ['merged', 'после объединения'],
  ]);
});

test('workbook sheets come in the workbook\'s order; stored archives read the same as deflated ones', () => {
  const sheets = [{ name: 'Сводка', rows: [['итого', 2]] }, { name: 'Диалоги', rows: [['id'], ['a']], hidden: true as const }];
  assert.deepEqual(readXlsx(xlsxFile(sheets, { deflate: false })), readXlsx(xlsxFile(sheets)));
  assert.deepEqual(readXlsx(xlsxFile(sheets)).map(sheet => sheet.name), ['Сводка', 'Диалоги']);
});

test('what is not an .xlsx workbook is refused with a reason the owner can act on', () => {
  assert.throws(() => readXlsx(Buffer.from('id,text\n1,hi\n')), /не ZIP-архив/);
  assert.throws(() => readXlsx(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(100)])), /старого формата \(\.xls\) или файл под паролем/);
  assert.throws(() => readXlsx(zipArchive([{ name: 'word/document.xml', data: '<w:document/>' }])), /нет xl\/workbook\.xml/);
  assert.throws(() => readXlsx(xlsxFile([{ name: 'Лист', rows: [[{ raw: '<c r="A1" t="s"><v>7</v></c>' }]] }])), /ссылается на строку, которой нет/);
  // A sheet part that unpacks into more than the workbook budget, from an archive of a few kilobytes.
  const bomb = zipArchive([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="Лист" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="…/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(65_000_000, 0x20) },
  ]);
  assert.ok(bomb.length < 200_000, 'the archive is small on disk');
  assert.throws(() => readXlsx(bomb), /распаковывается больше чем в 64 МБ/);
});

test('CSV follows RFC 4180: quoted delimiters, doubled quotes and line breaks inside a field; CRLF and LF records', () => {
  const text = 'id,text,note\r\n1,"CLIENT привет, ` AGENT ""да""",x\r\n2,"первая строка\nвторая",\n3,плоский "кавычки" внутри,"a"b\n';
  assert.deepEqual(readCsv(Buffer.from(text)).rows, [
    ['id', 'text', 'note'],
    ['1', 'CLIENT привет, ` AGENT "да"', 'x'],
    ['2', 'первая строка\nвторая', ''],
    ['3', 'плоский "кавычки" внутри', 'ab'],
  ]);
  assert.deepEqual(readCsv(Buffer.from('a,b\n1,2')).rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(readCsv(Buffer.from('a,b\n1,""')).rows, [['a', 'b'], ['1', '']]);
  assert.throws(() => readCsv(Buffer.from('id,text\n1,"не закрыта\n2,x\n')), /в строке 2 не закрыта кавычка/);
  // A sheet bigger than any export of conversations is refused, not read in part.
  assert.throws(() => readCsv(Buffer.from(`id,text\n${'1,x\n'.repeat(100_000)}`)), /В листе больше 100\u00a0000 строк/);
});

test('CSV dialect: the delimiter and the encoding are detected, and a confirmed dialect is used as given', () => {
  const semicolons = 'id;текст;дата\n1;"a;b";09.09.2026\n2;c;10.09.2026\n';
  assert.deepEqual(readCsv(Buffer.from(semicolons)).dialect, { delimiter: ';', encoding: 'utf-8' });
  assert.deepEqual(readCsv(Buffer.from(semicolons)).rows[1], ['1', 'a;b', '09.09.2026']);
  assert.deepEqual(readCsv(Buffer.from('id\ttext\n1\thi, there\n')).dialect.delimiter, '\t');
  // The byte order mark is not part of the first header.
  assert.deepEqual(readCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('id,text\n1,x\n')])).rows[0], ['id', 'text']);
  const cp1251 = Buffer.from([0xe8, 0xe4, 0x3b, 0xf2, 0xe5, 0xea, 0xf1, 0xf2, 0x0a, 0x31, 0x3b, 0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]); // «ид;текст\n1;привет\n»
  assert.deepEqual(readCsv(cp1251), { rows: [['ид', 'текст'], ['1', 'привет']], dialect: { delimiter: ';', encoding: 'windows-1251' } });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('id\ttext\n1\tпривет\n', 'utf16le')]);
  assert.deepEqual(readCsv(utf16), { rows: [['id', 'text'], ['1', 'привет']], dialect: { delimiter: '\t', encoding: 'utf-16le' } });
  // Told, not guessed: a confirmed comma reads the semicolon file as one column.
  assert.deepEqual(readCsv(Buffer.from(semicolons), { delimiter: ',', encoding: 'utf-8' }).rows[0], ['id;текст;дата']);
});

test('only .xlsx and .csv are tables; other spreadsheet formats get the way to a readable one', () => {
  assert.equal(tableFormat('/x/Logs.XLSX'), 'xlsx');
  assert.equal(tableFormat('logs.csv'), 'csv');
  assert.throws(() => tableFormat('logs.xls'), /Excel 97–2003 \(\.xls\) сохраните как \.xlsx или \.csv/);
  assert.throws(() => tableFormat('logs.jsonl'), /не таблица/);
});
