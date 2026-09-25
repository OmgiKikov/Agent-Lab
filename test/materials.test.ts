import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docxText } from '../src/docx.js';
import { expandMaterials, materialText, readMaterialFiles } from '../src/materials.js';
import { MATERIAL_PART_CHARS } from '../src/limits.js';
import { docxFile, docxHtmlChunk, zipArchive } from './helpers/zip.js';

test('docxText returns the paragraphs of a Word document, one per line, with runs joined', () => {
  const file = docxFile([
    ['Как оформить возврат', ' по эквайрингу'],
    ['Шаг 1.', { tab: true }, 'Откройте раздел «Операции» & найдите платёж <до 30 дней>.'],
    [],
    ['Шаг 2.', { br: true }, 'Нажмите «Возврат».'],
  ]);
  assert.equal(docxText(file), 'Как оформить возврат по эквайрингу\nШаг 1.\tОткройте раздел «Операции» & найдите платёж <до 30 дней>.\nШаг 2.\nНажмите «Возврат».');
});

test('docxText reads stored (uncompressed) archives as well as deflated ones', () => {
  assert.equal(docxText(docxFile([['Тариф 1,6%']], { deflate: false })), 'Тариф 1,6%');
});

test('docxText reads a knowledge-base export whose body is an HTML chunk: blocks become lines, cells are tab-separated, markup and images are dropped', () => {
  const html = '<html lang="ru">\n<meta charSet="UTF-8">\n<body>\n<h1 data-id="a1">Как настроить Callback-уведомления</h1>\n'
    + '<p data-id="b2">Доступна <strong>API-интеграция</strong> для сайтов &amp; приложений &mdash; см. <a href="https://x">инструкцию</a>.</p>\n'
    + '<ul><li>Регистрация сотрудников</li>\n <li>Привязка карт</li></ul>\n'
    + '<section class="spoiler"><section class="spoiler__title">Как обратиться в поддержку</section><section class="spoiler__content"><p>1. Сообщи клиенту:</p></section></section>\n'
    + '<table><tbody><tr><td>Тариф</td><td>1,6&nbsp;%</td></tr><tr><td>Срок</td><td>до 30<br>дней</td></tr></tbody></table>\n'
    + '<img src="image001.jpg" alt="скриншот"><script>alert(1)</script><style>p{}</style>\n</body></html>';
  assert.equal(docxText(docxHtmlChunk(html)), [
    'Как настроить Callback-уведомления',
    'Доступна API-интеграция для сайтов & приложений — см. инструкцию.',
    'Регистрация сотрудников',
    'Привязка карт',
    'Как обратиться в поддержку',
    '1. Сообщи клиенту:',
    'Тариф\t1,6 %',
    'Срок\tдо 30',
    'дней',
  ].join('\n'));
});

/** A Word document whose body is `body` as Word writes it, and further parts beside it. */
function wordDocument(body: string, parts: Array<{ name: string; data: string | Buffer }> = []): Buffer {
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
    + ` xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return zipArchive([{ name: 'word/document.xml', data: document }, ...parts]);
}
const run = (text: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (...runs: string[]) => `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${runs.join('')}</w:p>`;
const box = (text: string) => `<w:txbxContent>${paragraph(run(text))}</w:txbxContent>`;
const cell = (...paragraphs: string[]) => `<w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${paragraphs.join('')}</w:tc>`;

test('docxText keeps what Word shows: the text after a frame, a text box once, breaks of every type, tables as rows of tab-separated cells', () => {
  const body = [
    // A text box: Word writes it for new readers (mc:Choice) and again for old ones (mc:Fallback); the paragraph goes on after it.
    paragraph(run('Перед рамкой.'), `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx>${box('Правило в рамке: возврат за 30 дней.')}</wps:txbx></wps:wsp></w:drawing></mc:Choice>`
      + `<mc:Fallback><w:pict><v:shape><v:textbox>${box('Правило в рамке: возврат за 30 дней.')}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`, run(' После рамки — тоже правило.')),
    paragraph(run('Страница один'), '<w:r><w:br w:type="page"/></w:r>', run('страница два'), '<w:r><w:br w:type="textWrapping" w:clear="all"/></w:r>', run('и строка')),
    paragraph(run('Удалено: '), '<w:del w:id="1" w:author="x"><w:r><w:delText>старое правило</w:delText></w:r></w:del>',
      '<w:ins w:id="2" w:author="x">' + run('новое правило') + '</w:ins>', '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>', run(' стр. 7'), '<w:r><w:fldChar w:fldCharType="end"/></w:r>'),
    `<w:tbl><w:tblPr/><w:tr>${cell(paragraph(run('Тариф')), paragraph(run('с НДС')))}${cell(paragraph(run('Ставка')))}${cell()}</w:tr>`
      + `<w:tr>${cell(paragraph(run('Базовый')))}${cell(paragraph(run('1,6%'), '<w:r><w:tab/></w:r>', run('от оборота')))}${cell(paragraph(run('30 дней')))}</w:tr></w:tbl>`,
    paragraph(run('Знак вне Юникода: &#1114112; и &#x41;&amp;&lt;.')),
  ].join('');
  assert.equal(docxText(wordDocument(body)), [
    'Правило в рамке: возврат за 30 дней.',
    'Перед рамкой. После рамки — тоже правило.',
    'Страница один\nстраница два\nи строка',
    'Удалено: новое правило стр. 7',
    'Тариф с НДС\tСтавка\t',
    'Базовый\t1,6% от оборота\t30 дней',
    'Знак вне Юникода: &#1114112; и A&<.',
  ].join('\n'));
});

test('docxText reads the HTML chunks of an export in their place, all parts within one budget of unpacked bytes', () => {
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="c1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="c1.mht"/>'
    + '<Relationship Id="c2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="c2.mht"/></Relationships>';
  const mht = (html: string) => ['MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="b"', '', '--b', 'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit', '', html, '--b--', ''].join('\r\n');
  const placed = wordDocument(paragraph(run('Вступление.')) + '<w:altChunk r:id="c1"/>' + paragraph(run('Между частями.')) + '<w:altChunk r:id="c2"/>', [
    { name: 'word/_rels/document.xml.rels', data: rels }, { name: 'word/c1.mht', data: mht('<p>Первая часть &#1114112;</p>') }, { name: 'word/c2.mht', data: mht('<p>Вторая часть</p>') }]);
  assert.equal(docxText(placed), 'Вступление.\nПервая часть &#1114112;\nМежду частями.\nВторая часть');
  // Two parts that each unpack to a little over half of what one document may: together they are refused.
  const half = Buffer.alloc(33_000_000);
  const bomb = wordDocument('<w:altChunk r:id="c1"/><w:altChunk r:id="c2"/>', [
    { name: 'word/_rels/document.xml.rels', data: rels }, { name: 'word/c1.mht', data: half }, { name: 'word/c2.mht', data: half }]);
  assert.ok(bomb.length < 1_000_000);
  assert.throws(() => docxText(bomb), /Документ Word распаковывается больше чем в 64 МБ — Lab такие файлы не читает/);
  assert.throws(() => docxText(wordDocument('<!DOCTYPE x>')), /Документ Word/);
});

test('docxText rejects a file that is not a Word document', () => {
  assert.throws(() => docxText(Buffer.from('just text')), /не является документом Word/);
});

test('readMaterialFiles turns a folder of articles into materials: docx, md and txt are read, images and duplicates are set aside with a reason', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'materials-'));
  try {
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'Как оформить возврат.docx'), docxFile([['Возврат оформляется через терминал. '.repeat(3)]]));
    await writeFile(join(directory, 'nested', 'Тарифы.md'), '# Тарифы\n\nСтавка комиссии зависит от оборота торговой точки.\n');
    await writeFile(join(directory, 'Тарифы (копия).txt'), '# Тарифы\n\nСтавка комиссии зависит от оборота торговой точки.\n');
    await writeFile(join(directory, 'Пустая.txt'), '\n');
    await writeFile(join(directory, 'схема.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { materials, skipped } = await readMaterialFiles([directory], 'knowledge');
    assert.deepEqual(materials.map(m => [m.name, m.kind, m.content.length > 40]), [['Как оформить возврат', 'knowledge', true], ['Тарифы', 'knowledge', true]]);
    assert.equal(materials[1]!.content, '# Тарифы\n\nСтавка комиссии зависит от оборота торговой точки.');
    assert.deepEqual(skipped.map(s => [s.file.replace(directory, ''), s.reason]), [
      ['/Пустая.txt', 'нет текста'],
      ['/схема.png', 'формат не поддерживается: только .docx, .md, .txt, .html'],
      ['/Тарифы (копия).txt', 'дубликат «Тарифы»'],
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a document saved in Windows-1251 or UTF-16 is read in its encoding; garbled text never becomes a rule', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'materials-'));
  try {
    const rule = 'Комиссия за эквайринг — 1,6% от оборота торговой точки, возврат за 30 дней.';
    const cp1251 = (text: string) => Buffer.from([...text].map(char => { const code = char.charCodeAt(0);
      return code < 0x80 ? code : code === 0x401 ? 0xa8 : code === 0x451 ? 0xb8 : code === 0x2014 ? 0x97 : code >= 0x410 && code <= 0x44f ? code - 0x350 : 0x3f; }));
    await writeFile(join(directory, 'Тарифы.txt'), cp1251(`Тарифы. ${rule}`));
    await writeFile(join(directory, 'Возвраты.html'), cp1251(`<html><head><meta charset="windows-1251"></head><body><p>${rule}</p></body></html>`));
    await writeFile(join(directory, 'Правила.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`# Правила\n\n${rule}`, 'utf16le')]));
    await writeFile(join(directory, 'Испорчено.txt'), `Комиссия: ${'�'.repeat(6)} 1% — так выглядит текст, однажды прочитанный не в своей кодировке.`);
    await writeFile(join(directory, 'Картинка.txt'), Buffer.concat([Buffer.from('PNG'), Buffer.alloc(60)]));
    const { materials, skipped } = await readMaterialFiles([directory], 'knowledge');
    assert.deepEqual(materials.map(item => [item.name, item.content]), [['Возвраты', rule], ['Правила', `# Правила\n\n${rule}`], ['Тарифы', `Тарифы. ${rule}`]]);
    assert.deepEqual(skipped.map(item => [item.file.replace(directory, ''), item.reason]), [
      ['/Испорчено.txt', 'в тексте испорченные знаки «�» — сохраните файл заново в UTF-8 из исходного документа'],
      ['/Картинка.txt', 'это не текст: в файле нулевые байты — сохраните его как текст в UTF-8'],
    ]);
    assert.equal(materialText('prompt.txt', cp1251(rule)), rule, 'a prompt file the detector offers is read the same way');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('readMaterialFiles reads a prompt file as the agent’s own instructions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'materials-'));
  try {
    await writeFile(join(directory, 'prompt.md'), 'Отвечай клиенту вежливо. НИКОГДА не сообщай персональные данные.');
    const { materials } = await readMaterialFiles([join(directory, 'prompt.md')], 'prompt');
    assert.deepEqual(materials, [{ name: 'prompt', kind: 'prompt', content: 'Отвечай клиенту вежливо. НИКОГДА не сообщай персональные данные.', file: join(directory, 'prompt.md') }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('readMaterialFiles refuses a path that does not exist instead of silently building expectations from nothing', async () => {
  await assert.rejects(() => readMaterialFiles(['/nowhere/статьи'], 'knowledge'), /не найден/);
});

test('expandMaterials merges inline materials with files read from paths relative to the task, prompts marked as such', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'materials-'));
  try {
    await mkdir(join(directory, 'статьи'));
    await writeFile(join(directory, 'статьи', 'Возврат.md'), 'Возврат оформляется через терминал в течение 30 дней.');
    await writeFile(join(directory, 'prompt.txt'), 'Отвечай клиенту вежливо и по делу, без служебных пометок.');
    const expanded = await expandMaterials({ materials: [{ name: 'Заметка', content: 'Инкассация вне периметра агента, отвечать отказом.' }], materialFiles: ['статьи'], promptFiles: ['prompt.txt'] }, directory);
    assert.deepEqual(expanded.materials.map(m => [m.name, m.kind ?? 'knowledge']), [['Заметка', 'knowledge'], ['Возврат', 'knowledge'], ['prompt', 'prompt']]);
    assert.deepEqual(expanded.skipped, []);
    assert.equal(expanded.read, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('readMaterialFiles splits a long article into parts at paragraph boundaries so every part fits one model call and nothing is cut', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'materials-'));
  try {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Раздел ${i + 1}. ${'Порядок действий описан подробно. '.repeat(25)}`.trim());
    await writeFile(join(directory, 'Большая статья.md'), paragraphs.join('\n\n'));
    const { materials } = await readMaterialFiles([directory], 'knowledge');
    assert.ok(materials.length >= 3, `expected several parts, got ${materials.length}`);
    assert.deepEqual(materials.map(m => m.name), materials.map((_, i) => `Большая статья · часть ${i + 1}/${materials.length}`));
    assert.ok(materials.every(m => m.content.length <= MATERIAL_PART_CHARS && m.content.length > 0));
    assert.equal(materials.map(m => m.content).join('\n\n'), paragraphs.join('\n\n'), 'the parts are the article, verbatim');
    assert.ok(materials.every(m => m.file === join(directory, 'Большая статья.md')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
