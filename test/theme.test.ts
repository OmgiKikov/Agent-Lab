import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { visibleWidth } from '@earendil-works/pi-tui';
import { GLYPH, paint, renderRows, ROLE_TONE, wrapRow, type PaintTheme, type Row, type Tone } from '../extensions/render/theme.ts';

/*
 * The theme module (04-UI-SPEC «Theme Module», «Render Matrix», CTX-19…CTX-21): one renderer for
 * every host, checked at the five widths on a fake light and a fake dark theme whose markers make a
 * wrong token or a missing reset visible in the output. The lint test keeps width out of our hands.
 */

const WIDTHS = [40, 60, 80, 100, 160];
const TONES: Tone[] = ['text', 'muted', 'dim', 'accent', 'success', 'warning', 'error', 'borderMuted'];

/** Angle-bracket markers for the dark fake, square brackets for the light one; every token is named in its marker. */
const dark: PaintTheme = {
  fg: (color, value) => `<fg:${color}>${value}</fg>`,
  bold: value => `<b>${value}</b>`,
  bg: (color, value) => `<bg:${color}>${value}</bg>`,
} as PaintTheme;
const light: PaintTheme = {
  fg: (color, value) => `[fg:${color}]${value}[/fg]`,
  bold: value => `[b]${value}[/b]`,
  bg: (color, value) => `[bg:${color}]${value}[/bg]`,
} as PaintTheme;
const MARKER = /<\/?(?:fg|bg|b)(?::[a-zA-Z]+)?>|\[\/?(?:fg|bg|b)(?::[a-zA-Z]+)?\]/g;
const plain = (line: string) => line.replace(MARKER, '');
const tokens = (lines: string[]) => [...lines.join('').matchAll(/(?:<|\[)(?:fg|bg):([a-zA-Z]+)(?:>|\])/g)].map(match => match[1]!);
const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

/** About 600 characters of Cyrillic with line breaks, a tab and an escape sequence in the middle. */
const QUOTE = [
  'Здравствуйте! Подскажите, пожалуйста, как оформить возврат средств покупателю по операции через терминал эквайринга, если чек уже закрыт, а смена ещё не завершена; клиент настаивает на возврате именно на карту, с которой платил.',
  'Дополнительно: нужно ли отдельное заявление от клиента, и в какой срок деньги вернутся на счёт\tпокупателя, если банк-эмитент другой?',
  '\x1b[31mМы также хотели бы понять,\x1b[0m применяется ли комиссия за возврат и как она отражается в отчёте по операциям за день.',
  'Спасибо за подробный ответ, будем ждать инструкцию и ссылку на регламент, чтобы передать кассирам на всех точках продаж.',
].join('\n');

test('renderRows keeps every word of a 600-character quote inside 40–160 columns on both fake themes, with only the eight tones', () => {
  assert.ok(QUOTE.length >= 600, `fixture is ${QUOTE.length} characters`);
  const rows: Row[] = [
    { text: 'Точность агента: 0% — справился в 0 из 9 ситуаций', role: 'accuracy:bad' },
    { text: `Агент ответил   «${QUOTE}»`, indent: 2, role: 'quote' },
    { text: QUOTE, indent: 5, tone: 'muted' },
    { text: 'Дальше: скажите «отчёт для заказчика».', role: 'next:first' },
  ];
  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    for (const width of WIDTHS) {
      const lines = renderRows(rows, theme, width);
      for (const line of lines) {
        assert.ok(visibleWidth(plain(line)) <= width, `${name} ${width}: «${plain(line)}» is wider than ${width}`);
        assert.ok(!line.includes('…'), `${name} ${width}: an ellipsis was produced`);
        assert.ok(!plain(line).includes('\x1b'), `${name} ${width}: the escape sequence reached the output`);
      }
      const expected = normalise(['Точность агента: 0% — справился в 0 из 9 ситуаций', `Агент ответил   «${QUOTE}»`, QUOTE, 'Дальше: скажите «отчёт для заказчика».'].join(' ')
        .replace(/\x1b\[[0-9;]*m/g, '').replace(/\t/g, '  '));
      assert.equal(normalise(lines.map(plain).join(' ')), expected, `${name} ${width}: a word was lost or cut`);
      const used = new Set(tokens(lines));
      for (const token of used) assert.ok((TONES as string[]).includes(token), `${name} ${width}: unknown token «${token}»`);
      assert.ok(used.has('error') && used.has('accent') && used.has('muted') && used.has('text'), `${name} ${width}: the roles were painted`);
    }
  }
});

test('wrapping never changes the text: a long address breaks with nothing inserted, and every line break of a quote stays', () => {
  const address = 'https://support.example.com/refunds/terminal-1234567890/confirm?operation=987654321&lang=ru';
  const text = `Агент ответил   «Откройте ${address} и подтвердите возврат.»\nвторая строка\n\nчетвёртая строка`;
  for (const width of WIDTHS) {
    const lines = wrapRow({ text, indent: 2, hang: 18 }, width);
    const bodies = lines.map((line, index) => index ? line.replace(/^ {18}/, '') : line.replace(/^ {2}/, ''));
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: «${line}» is wider`);
    // A line is always a piece of the text as it was: nothing is inserted inside a word and no two lines are merged.
    for (const body of bodies) assert.ok(text.includes(body), `${width}: «${body}» is not in the text`);
    assert.equal(bodies.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), `${width}: a character was lost or added`);
    // The address comes back whole from its pieces; the quote's own line breaks, the empty line too, stay line breaks.
    assert.ok(bodies.join('').includes(address), `${width}: the address was broken apart`);
    assert.deepEqual(bodies.slice(-3), ['вторая строка', '', 'четвёртая строка'], `${width}: ${JSON.stringify(bodies)}`);
  }
  // The chat paints the same: the row is escaped, wrapped under its hang and painted, and still says what the agent said.
  const painted = renderRows([{ text, indent: 2, hang: 18, role: 'quote' }], dark, 60).map(plain);
  assert.ok(painted.map(line => line.trim()).join('').includes(address));
});

test('paint puts the weight inside the colour and takes both from the role when the row names none', () => {
  // The answer of result-text.ts, coloured by level (docs/design/ui-spec.md §6).
  assert.equal(paint({ text: 'Точность агента: 86%', role: 'accuracy:good' }, dark), '<fg:success><b>Точность агента: 86%</b></fg>');
  assert.equal(paint({ text: 'Точность агента: 86%', role: 'accuracy:good' }, light), '[fg:success][b]Точность агента: 86%[/b][/fg]');
  assert.equal(paint({ text: 'Точность агента: 72%', role: 'accuracy:warn' }, dark), '<fg:warning><b>Точность агента: 72%</b></fg>');
  assert.equal(paint({ text: 'Точность агента: 40%', role: 'accuracy:bad' }, dark), '<fg:error><b>Точность агента: 40%</b></fg>');
  assert.equal(paint({ text: 'Точность агента: прогон ещё не запускался', role: 'accuracy:none' }, dark), '<fg:text><b>Точность агента: прогон ещё не запускался</b></fg>');
  assert.equal(paint({ text: '✗ Числу пока не верить', role: 'alarm' }, dark), '<fg:error><b>✗ Числу пока не верить</b></fg>');
  assert.equal(paint({ text: 'Вероятно, от 52% до 86% (95%)', role: 'trust' }, dark), '<fg:muted>Вероятно, от 52% до 86% (95%)</fg>');
  assert.equal(paint({ text: 'мало данных', role: 'trust:small' }, dark), '<fg:warning>мало данных</fg>');
  assert.equal(paint({ text: 'Почему ошибается', role: 'heading' }, dark), '<fg:accent><b>Почему ошибается</b></fg>');
  assert.equal(paint({ text: '✗ 1  Возврат', role: 'failed' }, dark), '<fg:error><b>✗ 1  Возврат</b></fg>');
  assert.equal(paint({ text: 'Дальше: …', role: 'next:first' }, dark), '<fg:accent>Дальше: …</fg>');
  assert.equal(paint({ text: 'Отчёт для заказчика', role: 'next' }, dark), '<fg:text>Отчёт для заказчика</fg>');
  assert.equal(paint({ text: 'Ошибок нет.', role: 'good' }, dark), '<fg:success>Ошибок нет.</fg>');
  // An explicit tone wins over the role; a row without either, or with a role the table does not name, is printed as it is.
  assert.equal(paint({ text: 'x', role: 'next:first', tone: 'dim' }, dark), '<fg:dim>x</fg>');
  assert.equal(paint({ text: 'пусто' }, dark), 'пусто');
  assert.equal(paint({ text: '', role: 'blank' }, dark), '');
  const resultRoles = ['accuracy:good', 'accuracy:warn', 'accuracy:bad', 'accuracy:none', 'alarm', 'trust', 'trust:small', 'reality', 'heading', 'item', 'item:muted', 'failed', 'quote', 'muted', 'next', 'next:first', 'good'] as const;
  for (const role of resultRoles) assert.ok(ROLE_TONE[role], `role «${role}» has a token`);
  // Only the result rows of result-text.ts are painted by role now: the old board's roles are gone with it; every tone of the table is one of the eight.
  const table = ROLE_TONE as Record<string, unknown>;
  for (const role of ['verdict:good', 'headline', 'pointer', 'lead', 'agreement', 'dis-title', 'blank']) assert.equal(table[role], undefined, role);
  assert.equal(paint({ text: 'Плохо', role: 'verdict:bad' }, dark), 'Плохо');
  for (const [role, { tone }] of Object.entries(ROLE_TONE)) assert.ok(TONES.includes(tone), `${role}: «${tone}»`);
});

test('the glyph registry holds the few signs of docs/design/ui-spec.md §6 and the chat\'s ● and └, each one column wide', () => {
  assert.deepEqual([GLYPH.pass, GLYPH.fail, GLYPH.unmeasured, GLYPH.selected, GLYPH.more], ['✓', '✗', '?', '›', '↓']);
  assert.deepEqual([GLYPH.action, GLYPH.branch, GLYPH.barFill, GLYPH.barTrack, GLYPH.arrow], ['●', '└', '━', '─', '→']);
  // The old board's signs are gone: selection is «›», a waiting or control mark is a word.
  assert.ok(!Object.values(GLYPH).some(glyph => ['▸', '◆', '=', '!', '~', '+', '*', '/'].includes(glyph)));
  for (const glyph of Object.values(GLYPH)) assert.equal(visibleWidth(glyph), 1, `«${glyph}» is one column`);
});

test('a marked row hangs its text after the sign: ● and └ never have text under them', () => {
  const lines = renderRows([{ text: 'Собираю ситуации из логов, которые лежат в папке выгрузки за прошлый месяц', mark: { text: GLYPH.action, tone: 'success' } },
    { text: 'Двенадцать ситуаций: девять готовы, две ждут вашего ответа, одна не подходит для теста', indent: 2, mark: { text: GLYPH.branch, tone: 'muted' } }], dark, 40).map(plain);
  assert.match(lines[0]!, /^● Собираю/);
  assert.ok(lines.slice(1).some(line => /^ {2}└ Двенадцать/.test(line)), lines.join('\n'));
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, line);
  const branch = lines.findIndex(line => line.includes('└'));
  assert.ok(lines.slice(branch + 1).every(line => line.startsWith('    ')), 'the summary wraps under its text, after «└ »');
  assert.deepEqual(wrapRow({ text: 'один два три четыре', indent: 2, hang: 4 }, 12), ['  один два', '    три', '    четыре']);
});

// ---- Lint (SCREEN-07): width is never measured or cut by hand in the render code. ----

// src/result-text.ts is out of scope on purpose: laying rows out in columns is its job, done with pi-tui visibleWidth.
const here = dirname(fileURLToPath(import.meta.url));
const RENDER_DIR = join(here, '..', 'extensions', 'render');
const BANNED_CALLS = /\.slice\(|\.substring\(|padStart\(|padEnd\(/g;
const BANNED_LENGTH = /\b(?:text|line|title|label|message|quote)\.length\b/g;
const GLYPHS = /[✗✓▸●◆━─→└›↓]/g;

async function renderFiles(): Promise<string[]> {
  const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []))).flat();
  return walk(RENDER_DIR);
}

test('lint: extensions/render never slices, pads or measures displayed text, and draws glyphs only from GLYPH', async () => {
  const files = await renderFiles();
  assert.ok(files.some(file => file.endsWith('theme.ts')) && files.some(file => file.endsWith('verdict-block.ts')), 'both render modules are scanned');
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      assert.equal(line.match(BANNED_CALLS)?.[0], undefined, `${file}:${i + 1}: «${line.trim()}»`);
      assert.equal(line.match(BANNED_LENGTH)?.[0], undefined, `${file}:${i + 1}: «${line.trim()}»`);
    });
    // The GLYPH const itself is the one place a glyph may be written.
    const withoutRegistry = file.endsWith('theme.ts') ? source.replace(/export const GLYPH = \{[\s\S]*?\} as const;/, '') : source;
    withoutRegistry.split('\n').forEach((line, i) => {
      assert.equal(line.match(GLYPHS)?.[0], undefined, `${file}:${i + 1}: a literal glyph outside GLYPH in «${line.trim()}»`);
    });
  }
});
