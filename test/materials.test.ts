import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docxText } from '../src/docx.js';
import { expandMaterials, materialText, readMaterialFiles } from '../src/materials.js';
import { MATERIAL_PART_CHARS } from '../src/limits.js';
import { docxFile, docxHtmlChunk } from './helpers/zip.js';

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
