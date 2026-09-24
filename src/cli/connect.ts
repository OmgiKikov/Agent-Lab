import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkTemplate, CONNECTION_FORMAT, rememberConnection, saveConnection, type Connection } from '../connection.js';
import { connectionFromCurl } from '../curl.js';
import { pointerSchema } from '../http-template.js';
import type { TemplateTarget } from '../targets.js';
import { countText } from '../plural.js';
import { safeLine } from '../text.js';

/*
 * The command-line side of an HTTP agent in its own format: `connect --curl` writes the connection from the owner's
 * curl, `doctor` on such a connection shows the reply's structure and saves the path of its text. Each step asks
 * only what Lab cannot infer (which field is the message, which is the text of the reply), by a flag the owner types.
 */

const write = (lines: string[]) => { process.stdout.write(`${lines.map(line => safeLine(line)).join('\n')}\n`); };
const characters = (length: number) => countText(length, ['символ', 'символа', 'символов']);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export interface ConnectFlags { curl?: string; message?: string; conversation?: string[]; output?: string; yes?: boolean }

/** `agent-lab connect --curl FILE|-`: the fields first, then the preview, then — with --yes — the file. */
export async function connectFromCurl(flags: ConnectFlags): Promise<void> {
  if (!flags.curl) throw new Error('Укажите команду curl: --curl запрос.txt или --curl - (из стандартного ввода).');
  const source = flags.curl === '-' ? await readStdin() : await readFile(flags.curl, 'utf8');
  const made = connectionFromCurl(source, { ...(flags.message !== undefined ? { message: flags.message } : {}), ...(flags.conversation?.length ? { conversation: flags.conversation } : {}) });
  const warnings = made.warnings.map(warning => `! ${warning}`);
  if (made.kind === 'ask_message') {
    write([...warnings, 'Строковые поля тела запроса:', ...made.fields.map(field => `  ${field.pointer} · ${characters(field.length)}`), '',
      'Какое поле — сообщение клиента? Укажите его: agent-lab connect --curl … --message /путь']);
    process.exitCode = 2;
    return;
  }
  const output = resolve(flags.output ?? 'connection.json');
  const preview = [...made.lines, ...warnings];
  if (!flags.yes) { write([...preview, '', `Записать в ${output}: та же команда с --yes.`]); return; }
  try { await saveConnection(output, { format: CONNECTION_FORMAT, target: made.target }, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Файл ${output} уже есть: укажите другой --output.`); throw error; }
  write([...preview, '', `Записано: ${output}.`, `Дальше: agent-lab doctor --connection ${output} --yes — одно пробное сообщение покажет строение ответа агента.`]);
}

/**
 * `agent-lab doctor` on an agent in its own format. Without the text's path: one message and the reply's structure,
 * then the owner picks the path (--reply). With it: two turns of one conversation, and the path is saved once both
 * are answered — into the named connection file and Lab's remembered connection.
 */
export async function doctorTemplate(input: { connection: Connection; target: TemplateTarget; file?: string; reply?: string; yes?: boolean; directory: string }): Promise<void> {
  const reply = input.reply !== undefined ? pointerSchema.parse(input.reply) : input.target.request.reply;
  const requests = reply === undefined ? 1 : 2;
  if (!input.yes) {
    write([`Lab отправит агенту ${requests === 1 ? 'одно пробное сообщение' : 'два пробных сообщения в одном разговоре'} по адресу ${input.target.url}.`]);
    throw new Error(`Для ${requests === 1 ? 'пробного запроса' : 'двух пробных запросов'} укажите --yes.`);
  }
  const check = await checkTemplate(input.target, reply);
  const structure = ['Строение ответа агента (значения не показаны):', ...check.structure.length ? check.structure.map(field => `  ${field.pointer || '/'} · ${characters(field.length)}`) : ['  строковых полей нет']];
  if (reply === undefined) {
    write([...structure, '', `Какое поле — текст ответа агента? Укажите его: agent-lab doctor --connection ${input.file ?? 'подключение.json'} --reply /путь --yes`]);
    process.exitCode = 2;
    return;
  }
  const [first, second] = check.turns;
  const lines = [...structure, '',
    first === null || first === undefined ? `Текста по пути ${reply} в ответе нет.` : `Ответ на первое сообщение: ${characters(first)} по пути ${reply}.`,
    ...second === undefined ? [] : [second === null ? 'Второе сообщение в том же разговоре осталось без текста ответа.' : `Второе сообщение в том же разговоре: ${characters(second)}.`],
    'Сброс: каждая ситуация — новый идентификатор разговора; инструменты и состояние агент не показывает, поэтому оцениваются его ответы.'];
  if (!check.passed) { write([...lines, '', 'Подключение не готово: проверьте путь --reply или ответы агента.']); process.exitCode = 2; return; }
  const connection: Connection = { ...input.connection, target: { ...input.target, request: { ...input.target.request, reply } } };
  if (input.file && reply !== input.target.request.reply) await saveConnection(input.file, connection, true);
  await rememberConnection(input.directory, connection);
  write([...lines, '', `Подключение готово${input.file && reply !== input.target.request.reply ? `: путь ответа ${reply} сохранён в ${input.file}` : ''}.`]);
}
