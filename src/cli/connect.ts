import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkTemplate, CONNECTION_FORMAT, rememberConnection, saveConnection, type Connection, type TemplateCheck } from '../connection.js';
import { connectionLines, missingVariables, replyLabel, shownAddress, variableUse } from '../connect.js';
import { connectionFromCurl } from '../curl.js';
import { pointerSchema } from '../http-template.js';
import type { TemplateTarget } from '../targets.js';
import { countText } from '../plural.js';
import { safeLine } from '../text.js';

/*
 * The command-line side of an HTTP agent in its own format: `connect --curl` writes the connection from the owner's
 * curl, `doctor` on such a connection shows the reply's structure and saves the path of its text. Each step asks
 * only what Lab cannot infer (which field is the message, which is the text of the reply), by a flag the owner types.
 * The confirmation is the chat's own (connectionLines): one wording of what a connection sends and keeps.
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
  const asked = connectionFromCurl(source);
  const message = flags.message ?? asked.lastTurn;
  const made = connectionFromCurl(source, { ...(message !== undefined ? { message } : {}), ...(flags.conversation?.length ? { conversation: flags.conversation } : {}) });
  const warnings = made.warnings.map(warning => `! ${warning}`);
  if (made.kind === 'ask_message') {
    const texts = made.fields.filter(field => typeof field.value === 'string' && !field.value.includes('{{'));
    write([...warnings, 'Строковые поля тела запроса:', ...texts.map(field => `  ${field.pointer} · ${characters(field.length)}`), '',
      'Какое поле — сообщение клиента? Укажите его: agent-lab connect --curl … --message /путь']);
    process.exitCode = 2;
    return;
  }
  const output = resolve(flags.output ?? 'connection.json');
  const preview = [...connectionLines(made), ...made.history || made.conversation.length ? [] : ['  Если в запросе есть поле идентификатора разговора, укажите его: --conversation /путь.']];
  if (!flags.yes) { write([...preview, '', `Записать в ${output}: та же команда с --yes.`]); return; }
  try { await saveConnection(output, { format: CONNECTION_FORMAT, target: made.target }, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Файл ${output} уже есть: укажите другой --output.`); throw error; }
  const missing = made.target.kind === 'http' ? missingVariables(made.target) : [];
  write([...preview, '', `Записано: ${output}.`,
    ...missing.length ? [`Перед проверкой задайте в окружении ${missing.map(variable => variableUse(made, variable)).join(', ')}.`] : [],
    `Дальше: agent-lab doctor --connection ${output} --yes — одно пробное сообщение покажет строение ответа агента.`]);
}

/**
 * `agent-lab doctor` on an agent in its own format. Without the text's path: one message and the reply's structure,
 * then the owner picks the path (--reply). With it: two turns of one conversation, what the connection says about the
 * conversation checked by structure, and the connection saved once both are answered — into the named connection
 * file and Lab's remembered connection. `signal` stops the requests (Ctrl+C); with `json` nothing is printed and the
 * check is returned for the caller's one JSON document.
 */
export async function doctorTemplate(input: { connection: Connection; target: TemplateTarget; file?: string; reply?: string; yes?: boolean; directory: string; signal?: AbortSignal; json?: boolean }): Promise<TemplateCheck | undefined> {
  const reply = input.reply !== undefined ? pointerSchema.parse(input.reply) : input.target.request.reply;
  const requests = reply === undefined ? 1 : 2;
  if (!input.yes) {
    write([`Lab отправит агенту ${requests === 1 ? 'одно пробное сообщение' : 'два пробных сообщения в одном разговоре'} по адресу ${shownAddress(input.target)}.`]);
    throw new Error(`Для ${requests === 1 ? 'пробного запроса' : 'двух пробных запросов'} укажите --yes.`);
  }
  const check = await checkTemplate(input.target, reply, input.signal);
  if (input.json) {
    process.exitCode = check.passed && check.request ? 0 : 2;
    if (check.passed && check.request) {
      const connection: Connection = { ...input.connection, target: { ...input.target, request: check.request } };
      if (input.file && JSON.stringify(check.request) !== JSON.stringify(input.target.request)) await saveConnection(input.file, connection, true);
      await rememberConnection(input.directory, connection);
    }
    return check;
  }
  const structure = ['Строение ответа агента (значения не показаны):', ...check.structure.length ? check.structure.map(field => `  ${field.pointer || '/'} · ${characters(field.length)}`) : ['  строковых полей нет']];
  if (check.reply === undefined) {
    write([...structure, '', `Какое поле — текст ответа агента? Укажите его: agent-lab doctor --connection ${input.file ?? 'подключение.json'} --reply /путь --yes`]);
    process.exitCode = 2;
    return;
  }
  const [first, second] = check.turns;
  const lines = [...structure, '',
    first === null || first === undefined ? `Текста по пути ${check.reply} в ответе нет.` : `Ответ на первое сообщение: ${characters(first)} — ${replyLabel(check.reply)}.`,
    ...second === undefined ? [] : [second === null ? 'Второе сообщение в том же разговоре осталось без текста ответа.' : `Второе сообщение в том же разговоре: ${characters(second)}.`],
    'Сброс: каждая ситуация — новый разговор; инструменты и состояние агент не показывает, поэтому оцениваются его ответы.',
    ...check.warnings.map(warning => `! ${warning}`)];
  if (!check.passed || !check.request) { write([...lines, '', `Подключение не готово: ${check.failure ?? 'проверьте путь --reply или ответы агента.'}`]); process.exitCode = 2; return; }
  const connection: Connection = { ...input.connection, target: { ...input.target, request: check.request } };
  const changed = JSON.stringify(check.request) !== JSON.stringify(input.target.request);
  if (input.file && changed) await saveConnection(input.file, connection, true);
  await rememberConnection(input.directory, connection);
  write([...lines, '', `Подключение готово${input.file && changed ? `: путь ответа ${check.reply} сохранён в ${input.file}` : ''}.`]);
}
