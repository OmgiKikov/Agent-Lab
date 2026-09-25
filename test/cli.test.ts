import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { z } from 'zod';
import { errorText, stopText } from '../src/cli/errors.js';
import { tableChoicesOf } from '../src/cli/import-flags.js';
import { demoInput } from '../src/demo.js';
import { LockedError } from '../src/errors.js';
import { ExperimentStore } from '../src/store.js';

/*
 * The command line takes the owner's word as --yes: `build` shows what it would prepare and what it may spend, and
 * prepares only on --yes; inside an Agent Lab chat no command takes --yes, because there the chat asks itself. A
 * command's failure is said in the owner's words with its command's exit code; the first run, `demo`, shows its result.
 * The task file is the built-in teaching example, so preparing calls no model.
 */

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
/** The published binary (`npm run build`): the checks that start many commands run it, as the owner does, without compiling each time. */
const built = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function start(entry: string[], args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Outside a chat the variable is absent: present with any value, an empty one too, it is a command from the chat.
  const { AGENT_LAB_SESSION: _chat, ...outside } = process.env;
  const child = spawn(process.execPath, [...entry, ...args], { env: { ...outside, ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}
const agentLab = (args: string[], env: NodeJS.ProcessEnv = {}) => start(['--import', 'tsx', cli], args, env);
const binary = (args: string[], env: NodeJS.ProcessEnv = {}) => start([built], args, env);
async function folder(t: TestContext): Promise<{ task: string; data: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = join(root, 'task.json');
  await writeFile(task, JSON.stringify(demoInput()));
  return { task, data: join(root, 'data') };
}

test('build shows the consent in the owner\'s words and writes nothing; --yes prepares at most the situations it promised', { timeout: 60000 }, async t => {
  const { task, data } = await folder(t);
  const shown = await agentLab(['build', '--input', task, '--situations', '1', '--data-dir', data]);
  assert.equal(shown.code, 0, shown.stderr);
  const lines = shown.stdout.split('\n');
  assert.equal(lines[0], 'Собрать 1 ситуацию из task.json?');
  assert.ok(lines.includes('В логах 2 разговора, подходят 2. Ситуаций будет не больше 1 — по одной на разговор, из всех тем логов.'), shown.stdout);
  assert.ok(lines.some(line => /^Расход — не больше \d+ вызовов модели на всю подготовку/.test(line)), shown.stdout);
  assert.ok(lines.includes('Собрать: та же команда с --yes. Без него ничего не записано и не потрачено.'), shown.stdout);
  await assert.rejects(readdir(data), { code: 'ENOENT' }, 'nothing is written before --yes');

  const wrong = await agentLab(['build', '--input', task, '--situations', '0', '--data-dir', data]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Число ситуаций — целое от 1 до 200\./);

  const prepared = await agentLab(['build', '--input', task, '--situations', '1', '--yes', '--json', '--data-dir', data]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const made = JSON.parse(prepared.stdout) as { id: string; counts: string; situations: { number: number; status: string }[] };
  assert.equal(made.situations.length, 1, 'the count the consent promised is the most the preparation makes');
  const record = await new ExperimentStore(data).get(made.id);
  assert.equal(record.phase, 'review');
  assert.equal(record.librarySnapshot?.formatVersion, 2);
  assert.equal(record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : undefined, 1);
  // Without --json the owner reads what was made and the way on — never the record with the logs' conversations in it.
  const again = await binary(['build', '--input', task, '--situations', '1', '--yes', '--data-dir', data]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^Собрано: 1 ситуация: /);
  assert.match(again.stdout, /^Черновик: [0-9a-f-]{36}$/m);
  assert.match(again.stdout, /agent-lab run --id [0-9a-f-]{36} --yes/);
  for (const words of ['Помогите с возвратом', 'Номер терминала: 5678', '"librarySnapshot"', '"dialogues"']) assert.ok(!again.stdout.includes(words), `«${words}» reached the terminal`);
});

test('the exit code comes from the command, wherever it stands among the flags: a CI command that cannot measure exits 2, never 1', { timeout: 120000 }, async t => {
  const { task, data } = await folder(t);
  const missing = join(dirname(task), 'nope.json');
  const cases: [string[], number, RegExp][] = [
    [['--data-dir', data, 'evaluate'], 2, /^Agent Lab: Для запуска сохранённых тестов укажите --input suite\.json --yes\./],
    [['--data-dir', data, 'evaluate', '--input', missing, '--yes'], 2, /^Agent Lab: Файл из --input \(.*nope\.json\) не найден\. Проверьте путь\.\n$/],
    [['run', '--id', 'nope', '--yes', '--data-dir', data], 2, /^Agent Lab: Прогона «nope» нет в папке данных .*\. Проверьте --id и --data-dir\.\n$/],
    [['reassess', '--id', 'nope', '--yes', '--data-dir', data], 2, /^Agent Lab: Прогона «nope» нет в папке данных /],
    [['evaluate', '--input', task, '--yes', '--foo', '--data-dir', data], 2, /^Agent Lab: У команды agent-lab evaluate нет флага --foo\. Флаги команды: --input, --yes, --case, --parallel, --connection, --before\. Подробно: agent-lab evaluate --help\.\n$/],
    [['summary', '--id', 'nope', '--data-dir', data], 1, /^Agent Lab: Прогона «nope» нет в папке данных /],
    // A flag of another command is refused, not ignored: here --yes would promise a consent summary never asks for.
    [['summary', '--id', 'x', '--yes', '--data-dir', data], 1, /^Agent Lab: У команды agent-lab summary нет флага --yes\. Флаги команды: --id, --json\./],
    [['nope', '--data-dir', data], 1, /^Agent Lab: Такой команды нет: «nope»\. Команды: detect, import, build, .*\. Подробно: agent-lab --help\.\n$/],
    [['summary', '--id'], 1, /^Agent Lab: После --id нужно значение: --id ЗНАЧЕНИЕ\.\n$/],
    [['summary', '--id', '--json'], 1, /^Agent Lab: После --id нужно значение: --id ЗНАЧЕНИЕ \(сейчас за ним стоит --json\)\.\n$/],
    [['summary', 'nope', '--data-dir', data], 1, /^Agent Lab: Лишнее слово «nope»: команда agent-lab summary принимает только флаги\./],
    [['build', '--input', missing, '--data-dir', data], 1, /^Agent Lab: Файл из --input \(.*nope\.json\) не найден\. Проверьте путь\.\n$/],
  ];
  for (const [args, code, stderr] of cases) {
    const result = await binary(args);
    assert.equal(result.code, code, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, stderr, args.join(' '));
    assert.doesNotMatch(result.stderr, /ENOENT|Unknown|Error:|at /, `${args.join(' ')}: an English diagnostic reached the owner`);
  }
});

test('agent-lab demo — the first run a newcomer sees: the result on screen and the exit code 0; the teaching failure is the lesson, not a failure', { timeout: 60000 }, async t => {
  const { data } = await folder(t);
  const first = await binary(['demo', '--data-dir', data]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, /^Учебный пример: 2 ситуации, без модели и ключей\. На вопрос одной из них Lab ответил «Да» за вас\.\n\n/);
  assert.match(first.stdout, /^ Точность агента: 50% — справился в 1 из 2 ситуаций$/m);
  assert.match(first.stdout, /^ Почему ошибается$/m);
  assert.match(first.stdout, /Учебный агент ошибается нарочно/);
  assert.doesNotMatch(first.stdout, /^\s*[{[]/m, 'no JSON on the screen');
  for (const line of first.stdout.split('\n')) assert.ok(visibleWidth(line) <= 100, `«${line}» is wider than 100 columns`);
  // The same result as JSON for a script, on request; the exit code stays 0.
  const machine = await binary(['demo', '--json', '--data-dir', join(data, 'json')]);
  assert.equal(machine.code, 0, machine.stderr);
  const parsed = JSON.parse(machine.stdout) as { phase: string; view: { headline: { passed: number; decided: number } } };
  assert.equal(parsed.phase, 'results_review');
  assert.deepEqual([parsed.view.headline.passed, parsed.view.headline.decided], [1, 2]);
});

test('--help fits 100 columns: each command as it is typed, then what it does; a command\'s own help is its lines alone', { timeout: 60000 }, async () => {
  const help = await binary(['--help']);
  assert.equal(help.code, 0, help.stderr);
  for (const line of help.stdout.split('\n')) assert.ok(visibleWidth(line) <= 100, `«${line}» is wider than 100 columns`);
  for (const command of ['detect', 'import', 'build', 'cards', 'accept', 'run', 'repeat', 'demo', 'summary', 'logs', 'reassess', 'check-judge', 'export', 'diff', 'save-suite', 'evaluate', 'suites', 'connect', 'doctor', 'status'])
    assert.match(help.stdout, new RegExp(`^ {2}agent-lab ${command}\\b`, 'm'), command);
  assert.match(help.stdout, /^ {6}Учебный пример целиком, без модели и ключей/m);
  const own = await binary(['summary', '--help']);
  assert.equal(own.code, 0);
  assert.equal(own.stdout, '  agent-lab summary --id RUN [--json]\n      Сколько ситуаций агент прошёл, что не измерено и почему\n');
});

test('cards in a shell say the way on as a command, never the keys of the board', { timeout: 60000 }, async t => {
  const { data } = await folder(t);
  const demo = await binary(['demo', '--json', '--data-dir', data]);
  const id = (JSON.parse(demo.stdout) as { id: string }).id;
  const ready = await binary(['cards', '--id', id, '--card', '2', '--data-dir', data]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.doesNotMatch(ready.stdout, /1 Изменить|2 Добавить похожую|3 Не проверять/, 'the board\'s keys mean nothing in a shell');
  assert.match(ready.stdout, new RegExp(`^ Изменить: agent-lab cards --id ${id} --input команда\\.json`, 'm'));
});

test('every failure of a command reaches the owner in their words with the way on; only a defect of Lab keeps its original, under the sentence', () => {
  const context = { directory: '/проект/.agent-lab', files: { input: 'задача.json' } };
  const system = (code: string, path: string) => Object.assign(new Error(`${code}: open '${path}'`), { code, path });
  assert.deepEqual(errorText(new LockedError(), context).detail, undefined);
  assert.match(errorText(new LockedError(), context).text, /^Папку данных сейчас ведёт другой процесс Agent Lab/);
  assert.equal(errorText(system('EACCES', resolve('задача.json')), context).text, `Файл из --input (${resolve('задача.json')}): нет доступа. Проверьте права на файл и папку.`);
  assert.equal(errorText(system('ENOENT', '/проект/.agent-lab/run_1.json'), context).text, 'Прогона «run_1» нет в папке данных /проект/.agent-lab. Проверьте --id и --data-dir.');
  const zod = z.strictObject({ settings: z.strictObject({ maxCalls: z.number().max(10) }) }).safeParse({ settings: { maxCalls: 99 } });
  assert.equal(errorText(zod.error, context).text, 'Файл не в формате Agent Lab: settings.maxCalls — не больше 10. Исправьте файл и повторите.');
  assert.deepEqual(errorText(new Error('Укажите --id RUN.'), context), { text: 'Укажите --id RUN.' });
  const defect = errorText(new TypeError('Cannot read properties of undefined'), context);
  assert.match(defect.text, /^Не получилось из-за внутренней ошибки Agent Lab\./);
  assert.equal(defect.detail, 'Cannot read properties of undefined');
  // A stop a record keeps is its fixed label: read back by exact equality, in the owner's words.
  assert.equal(stopText('Model call budget exhausted.'), 'Закончился лимит вызовов модели; сделанное сохранено. Поднимите settings.maxCalls в задаче и повторите.');
  assert.equal(stopText('socket hang up'), undefined);
});

test('a separator typed on the command line means its characters, every one of them', () => {
  assert.equal(tableChoicesOf({ separator: '\\n\\n' }).separator, '\n\n');
  assert.equal(tableChoicesOf({ separator: '\\t|\\t' }).separator, '\t|\t');
});

test('inside an Agent Lab chat no command takes --yes: the chat asks the owner itself, and nothing is written or spent', { timeout: 60000 }, async t => {
  const { task, data } = await folder(t);
  const chat = { AGENT_LAB_SESSION: '1' };
  for (const args of [['build', '--input', task, '--yes'], ['run', '--id', 'draft', '--yes'], ['reassess', '--id', 'run', '--yes'],
    ['evaluate', '--input', task, '--yes'], ['cards', '--id', 'draft', '--accept', '--yes'], ['logs', '--id', 'run', '--unknown', '--yes']]) {
    const refused = await agentLab([...args, '--data-dir', data], chat);
    assert.notEqual(refused.code, 0, args.join(' '));
    assert.equal(refused.stderr, 'Agent Lab: Из чата Agent Lab команда с --yes не выполняется: в чате согласие на расход и решения спрашивает сам чат. '
      + 'Скажите обычными словами, что сделать, — Lab спросит вас. Ничего не записано и не потрачено.\n', args.join(' '));
  }
  await assert.rejects(readdir(data), { code: 'ENOENT' }, 'no refused command opened the data folder');
  const shown = await agentLab(['build', '--input', task, '--data-dir', data], chat);
  assert.equal(shown.code, 0, 'reading what a preparation would cost is not a decision');
  assert.match(shown.stdout, /^Собрать 2 ситуации из task\.json\?/);
  // Emptying the variable is still a command from the chat: only its absence is outside it.
  for (const value of ['', '0']) {
    const emptied = await agentLab(['build', '--input', task, '--yes', '--data-dir', data], { AGENT_LAB_SESSION: value });
    assert.notEqual(emptied.code, 0, `AGENT_LAB_SESSION=«${value}»`); assert.match(emptied.stderr, /^Agent Lab: Из чата Agent Lab команда с --yes не выполняется/);
  }
  await assert.rejects(readdir(data), { code: 'ENOENT' }, 'nothing was written');
});

test('agent-lab chat opens Pi with a private mask: the session files that keep the customers\' words are the owner\'s alone', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-chat-mask-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A probe loaded before Pi itself: in the process `agent-lab chat` starts (the one given AGENT_LAB_SESSION), it writes what
  // that process was started with and ends it before Pi opens a terminal.
  const probe = join(root, 'probe.mjs'), seen = join(root, 'seen.json');
  await writeFile(probe, `import { writeFileSync } from 'node:fs';
if (process.env.AGENT_LAB_SESSION === '1') {
  const mask = process.umask(0o077); process.umask(mask);
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ mask, entry: process.argv[1] }));
  process.exit(0);
}
`);
  const started = await agentLab(['chat', '--version'], { NODE_OPTIONS: `--import ${probe}` });
  assert.equal(started.code, 0, started.stderr);
  const { mask, entry } = JSON.parse(await readFile(seen, 'utf8')) as { mask: number; entry: string };
  assert.match(entry, /pi-coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js$/, 'the probe ran in Pi\'s own process');
  assert.equal(mask.toString(8), '77', 'what Pi writes in this chat is readable by the owner alone');
});
