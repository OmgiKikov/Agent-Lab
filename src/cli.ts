#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { ExperimentLab, draftHash } from './experiment.js';
import { demoInput } from './demo.js';
import { createInputSchema } from './contracts.js';
import { compareRuns } from './comparison.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from './connection.js';
import { detectionLines, detectProject } from './detect.js';
import { readDialogueImport, importDialogues } from './imports.js';
import { expandMaterials } from './materials.js';
import { getPiStatus } from './pi.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { expectationSheet, testPlanLines, trialProofLines } from './quality.js';
import { ExperimentStore } from './store.js';
import { buildResultView, exitCodeOf, type ResultView } from './result-view.js';
import { MAX_WIDTH, plainText, resultScreen, type ResultRow } from './result-text.js';
import { evidenceBundle, exportArtifacts, importNumbers, resolveVerified } from './artifacts.js';
import { libraryHash } from './scenario-library.js';
import { hostGrant, requiredAuthority, wordsOf } from './card/commands.js';
import { conversionText } from './card/convert.js';
import { cardCommandSchema } from './card/schema.js';
import { actionRow, briefRows, changeText, countsText, detailRows, formatNote, listRows, plainSituationText, situationActions, situationData, situationViews, type SituationView } from './card/view.js';
import { safeLine } from './text.js';
import { countText } from './plural.js';
import { logImports } from './card/calibration-scope.js';
import { confirmTableImport, proposeTableImport } from './spreadsheet/import.js';
import { importedLine, proposalLines } from './spreadsheet/lines.js';
import { ROLES, ROLE_WORDS, tableChoicesSchema, type MarkerRole, type TableChoices } from './spreadsheet/mapping.js';
import type { TableProposal } from './spreadsheet/proposal.js';

/**
 * The rows of the result screen with every text made safe for a terminal before layout: titles, quotes
 * and the owner's reasons come from records, and the layout must measure what will actually be printed.
 */
const cliRows = (view: ResultView): ResultRow[] => resultScreen(view, { surface: 'cli' }).map(row => ({ ...row, text: safeLine(row.text),
  ...(row.right === undefined ? {} : { right: safeLine(row.right) }), ...(row.short === undefined ? {} : { short: safeLine(row.short) }),
  ...(row.parts ? { parts: row.parts.map(safeLine) } : {}) }));
/** The result screen as the terminal shows it: the same rows as the board, wrapped to the terminal width. */
const screenText = (view: ResultView, warnings: string[]) => [plainText(cliRows(view), process.stdout.columns ?? MAX_WIDTH),
  ...warnings.map(warning => `Внимание: ${safeLine(warning)}`), ''].join('\n');
/** What `evaluate`, `run` and `reassess` print for a script: the one view, its exit code and the screen lines. */
const machineResult = (view: ResultView) => ({ view, exitCode: exitCodeOf(view), lines: plainText(cliRows(view), MAX_WIDTH).split('\n') });
const writeStdout = (value: string): Promise<void> => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error?: Error | null) => {
    if (settled) return;
    settled = true;
    process.stdout.off('error', onError);
    if (error) reject(error); else resolve();
  };
  const onError = (error: Error) => finish(error);
  process.stdout.once('error', onError);
  process.stdout.write(value, finish);
});

/** The owner's words for who writes a message, as `--markers` and `--roles` take them. */
const ROLE_BY_WORD: Readonly<Record<string, MarkerRole>> = {
  клиент: 'user', client: 'user', user: 'user', агент: 'assistant', agent: 'assistant', assistant: 'assistant',
  служебное: 'system', system: 'system', текст: 'text', text: 'text',
};
/** `CLIENT=клиент,AGENT=агент` → pairs; a value may itself hold `=`, the role word is after the last one. */
function rolePairs(text: string, flag: string, allowText: boolean): { label: string; role: MarkerRole }[] {
  return text.split(',').map(pair => {
    const at = pair.lastIndexOf('='), label = pair.slice(0, at).trim(), role = ROLE_BY_WORD[pair.slice(at + 1).trim().toLowerCase()];
    if (at < 1 || !label || !role || role === 'text' && !allowText) throw new Error(`${flag}: ожидается ${allowText ? 'МЕТКА' : 'ЗНАЧЕНИЕ'}=клиент|агент|служебное${allowText ? '|текст' : ''}, через запятую.`);
    return { label, role };
  });
}
/** The owner's choices from the command line; each overrides what Lab would propose. */
function tableChoicesOf(values: Record<string, string | boolean | string[] | undefined>): TableChoices {
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : undefined;
  // A shell passes \n and \t literally; the owner means the characters.
  const separator = text('separator')?.replace('\\n', '\n').replace('\\t', '\t');
  return tableChoicesSchema.parse({
    ...text('sheet') ? { sheet: text('sheet') } : {}, ...text('id-column') ? { id: text('id-column') } : {},
    ...text('text-column') ? { text: text('text-column') } : {}, ...separator ? { separator } : {},
    ...text('markers') ? { markers: rolePairs(text('markers')!, '--markers', true).map(({ label, role }) => ({ token: label, role })) } : {},
    ...text('role-column') ? { role: text('role-column') } : {},
    ...text('roles') ? { roles: rolePairs(text('roles')!, '--roles', false).map(({ label, role }) => ({ value: label, role })) } : {},
    ...text('order-column') ? { order: text('order-column') } : values['row-order'] ? { order: null } : {},
  });
}
/** How to answer the proposal from the command line. */
function importHints(proposal: TableProposal): string[] {
  const words = ROLES.map(role => ROLE_WORDS[role]).join('|');
  if (proposal.status === 'refused') return ['Поправьте выбор и повторите команду.'];
  if (proposal.status === 'ready') return ['Загрузить: та же команда с --yes.',
    'Поправить: --sheet, --id-column, --text-column; метки — --markers CLIENT=клиент,AGENT=агент и --separator; сообщение в строке — --role-column, --roles, --order-column или --row-order.'];
  const question = proposal.question;
  switch (question.kind) {
    case 'marker': return [`Ответ: та же команда с --markers ${question.token}=${words}|текст.`];
    case 'role': return [`Ответ: та же команда с --roles "${question.value}=${words}".`];
    case 'id': return ['Ответ: та же команда с --id-column КОЛОНКА.'];
    case 'text': return ['Ответ: та же команда с --text-column КОЛОНКА.'];
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'chat' || (!args.length && process.stdin.isTTY)) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
    const child = spawn(process.execPath, [resolve(piRoot, 'dist/bundle/cli.js'), '--no-extensions', '--no-skills', '-e', resolve(root, 'extensions/agent-lab.ts'),
      '--skill', resolve(root, 'skills/agent-builder/SKILL.md'), ...args.slice(args[0] === 'chat' ? 1 : 0)],
    { stdio: 'inherit', env: { ...process.env, AGENT_LAB_SESSION: '1' } });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1))); });
    return;
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, output: { type: 'string' },
    task: { type: 'string' }, operation: { type: 'string' }, 'expected-hash': { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    format: { type: 'string', default: 'json' }, json: { type: 'boolean' },
    connection: { type: 'string' }, directory: { type: 'string' }, 'code-only': { type: 'boolean' },
    'dialogues-file': { type: 'string' }, trial: { type: 'string', multiple: true },
    yes: { type: 'boolean' }, case: { type: 'string', multiple: true }, control: { type: 'string', multiple: true }, parallel: { type: 'string' },
    card: { type: 'string' }, choice: { type: 'string' }, text: { type: 'string' }, check: { type: 'boolean' }, resume: { type: 'boolean' }, accept: { type: 'boolean' }, convert: { type: 'boolean' },
    'agent-version': { type: 'string' }, unknown: { type: 'boolean' }, import: { type: 'string' },
    file: { type: 'string' }, sheet: { type: 'string' }, 'id-column': { type: 'string' }, 'text-column': { type: 'string' }, separator: { type: 'string' },
    markers: { type: 'string' }, 'role-column': { type: 'string' }, roles: { type: 'string' }, 'order-column': { type: 'string' }, 'row-order': { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('  agent-lab detect [--directory ПАПКА] [--json]  Что Lab нашёл в папке проекта: агента, логи, материалы, промпт\n');
    process.stdout.write('  agent-lab import --file логи.xlsx [--yes] [--json]  Как Lab прочитает таблицу логов (.xlsx, .csv); --yes загружает её\n');
    process.stdout.write('  agent-lab summary --id RUN [--json]     Сколько ситуаций агент прошёл, что не измерено и почему\n');
    process.stdout.write('  agent-lab logs --id RUN [--agent-version ВЕРСИЯ | --unknown] [--yes]   Какая версия агента записала логи: только тогда сверка с продом — калибровка\n');
    process.stdout.write('  agent-lab accept --id RUN [--yes]      Что агент должен сделать в каждой ситуации; --yes подтверждает все ожидания\n');
    process.stdout.write('Agent Lab — validation set, accuracy и причины провалов вашего агента.\n\n  agent-lab                         Диалог в текущем проекте\n  agent-lab chat [опции Pi]          Напишите задачу обычными словами\n  agent-lab save-suite --id RUN --output .evals/regression.json [--case ID]\n  agent-lab evaluate --input .evals/regression.json --yes [--case ID] [--parallel 4]\n\nevaluate: 0 — все оценки пройдены; 1 — зарегистрирован провал; 2 — ошибка теста/среды или неполные данные.\n--yes разрешает расход в пределах сохранённых лимитов; ручной оценкой ожиданий это не считается.\n\n');
    process.stdout.write('  agent-lab doctor --connection connection.json --yes\n  agent-lab suites --directory .evals\n  agent-lab reassess --id RUN [--input criteria.json] --yes\n  agent-lab reassess --id RUN --code-only\n  evaluate принимает --connection; build — --dialogues-file (JSON/JSONL).\n\n');
    process.stdout.write('  agent-lab cards --id RUN [--card N] [--json]           Ситуации: что пишет и знает клиент, что должен агент, статус и вопрос\n'
      + '  agent-lab cards --id RUN --card N --choice a|b|c [--text «…»] --yes   Ответ на вопрос ситуации\n'
      + '  agent-lab cards --id RUN --input команда.json [--yes]   Команда владельца; без --yes — только «было → стало»\n'
      + '  agent-lab cards --id RUN --check|--resume|--accept --yes   Проверить ситуации · продолжить подготовку · утвердить готовые\n'
      + '  agent-lab cards --id RUN --convert     Черновик старого формата — продолжить в новом формате; старый останется как есть\n');
    process.stdout.write('Дополнительно: run --id RUN --yes [--parallel 4] · build --input task.json · repeat --id RUN [--case SCENARIO_ID] [--control SCENARIO_ID] · diff --before RUN --after RUN · export --id RUN --format html --output report.html · status.\n'); return;
  }
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await getPiStatus(), null, 2)}\n`); return; }
  if (command === 'detect') {
    // Read-only: nothing is started, imported or written; a .env file contributes variable names only.
    const detection = await detectProject(values.directory ?? process.cwd());
    await writeStdout(values.json ? `${JSON.stringify(detection, null, 2)}\n` : `${detectionLines(detection).map(safeLine).join('\n')}\n`);
    return;
  }
  const directory = values['data-dir'] ?? resolve('.agent-lab');
  if (command === 'import') {
    if (!values.file) throw new Error('Укажите таблицу: agent-lab import --file логи.xlsx');
    // Reads only, until the owner says --yes to a complete proposal; the answer to a question is a flag of the same command.
    const proposal = await proposeTableImport(values.file, tableChoicesOf(values));
    const lines = proposalLines(proposal);
    if (proposal.status !== 'ready' || !values.yes) {
      await writeStdout(values.json ? `${JSON.stringify(proposal, null, 2)}\n` : `${[...lines, '', ...importHints(proposal)].map(line => safeLine(line)).join('\n')}\n`);
      if (proposal.status === 'refused' || values.yes) process.exitCode = 1;
      return;
    }
    const lab = new ExperimentLab(directory);
    await lab.init();
    try {
      const { batch } = await confirmTableImport(lab.store, values.file, proposal);
      await writeStdout(values.json ? `${JSON.stringify({ importId: batch.id, dialogues: batch.dialogues.length, proposal }, null, 2)}\n`
        : `${[...lines, '', importedLine(batch), `Дальше: agent-lab build --input задача.json --dialogues-file ${values.file}`].map(line => safeLine(line)).join('\n')}\n`);
    } finally { await lab.close(); }
    return;
  }
  if (command === 'suites') { process.stdout.write(JSON.stringify(await listSuites(values.directory ?? '.evals'), null, 2) + '\n'); return; }
  if (command === 'cards') {
    if (!values.id) throw new Error('Укажите --id RUN.');
    const lab = new ExperimentLab(directory);
    const situations = async (id: string) => {
      const record = await lab.get(id);
      if (record.librarySnapshot?.formatVersion !== 2) return { record, views: situationViews(record, { maxTurns: record.settings.maxTurns }) };
      const context = await lab.cardContext(id);
      return { record: context.experiment, views: situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns }) };
    };
    /** The list, or one situation with its question and its actions — the same rows the chat and the board draw. JSON carries each situation's id: a command file names its card by it. */
    const show = async (id: string, changes: string[] = []) => {
      const { record, views } = await situations(id);
      const number = values.card === undefined ? undefined : Number(values.card);
      const view = number === undefined ? undefined : views.find(item => item.number === number);
      if (number !== undefined && !view) throw new Error(`Ситуации №${values.card} нет. Есть: ${views.map(item => item.number).join(', ')}.`);
      if (values.json) { await writeStdout(`${JSON.stringify({ runId: id, counts: countsText(views), ...(changes.length ? { changes } : {}), ...(view ? { situation: { id: view.id, ...situationData(view), details: view.details } } : { situations: views.map(item => ({ id: item.id, ...situationData(item) })) }) }, null, 2)}\n`); return; }
      const actions = view && !view.question ? situationActions(view) : [];
      const rows = view ? [...briefRows(view), ...(actions.length ? [{ role: 'blank' as const, indent: 0, text: '' }, actionRow(actions)] : []), { role: 'blank' as const, indent: 0, text: '' }, ...detailRows(view)]
        : views.flatMap(item => listRows(item));
      const head = view ? [] : [countsText(views), ...(formatNote(record) ? [formatNote(record)!] : []), ''];
      await writeStdout(`${[...changes, ...(changes.length ? [''] : []), ...head.map(line => line && ` ${safeLine(line)}`), plainSituationText(rows.map(row => ({ ...row, text: safeLine(row.text) })), process.stdout.columns ?? 100)].join('\n')}\n`);
    };
    if (values.convert) {
      // Free and deterministic: the new draft's situations wait for a check the owner starts with --check --yes.
      await lab.init();
      try {
        const converted = await lab.convertV1Draft(values.id);
        const text = conversionText(converted);
        if (values.json) { await writeStdout(`${JSON.stringify({ runId: converted.experiment.id, convertedFrom: values.id, left: converted.left, checkCalls: converted.calls }, null, 2)}\n`); return; }
        await writeStdout(`${[text.summary, ...text.left, text.check, `Проверить: agent-lab cards --id ${converted.experiment.id} --check --yes`, ''].map(line => safeLine(line)).join('\n')}\n`);
        await show(converted.experiment.id);
      } finally { await lab.close(); }
      return;
    }
    if (!values.input && !values.choice && !values.check && !values.resume && !values.accept) { await show(values.id); return; }
    await lab.init();
    try {
      const target = values.check || values.resume || values.accept ? { id: values.id } : await lab.editableCards(values.id);
      if (target.id !== values.id) process.stderr.write(`Прогон ${values.id} уже выполнен и не меняется: правка идёт в черновик ${target.id}.\n`);
      if (values.resume || values.check || values.accept) {
        if (!values.yes) throw new Error(values.accept ? 'Утверждение фиксирует готовые ситуации для прогона; укажите --yes. Агент не запускается.' : 'Это расходует вызовы модели в пределах лимита; укажите --yes.');
        const { record, views } = await situations(target.id);
        if (values.resume) { if (!record.librarySnapshot) throw new Error('Продолжать нечего.'); await lab.resumePreparation(target.id, libraryHash(record.librarySnapshot)); await lab.waitForIdle(); }
        else if (values.check) { await lab.recheckCards(target.id, { explicit: true }); await lab.waitForIdle(); }
        else {
          const ready = views.filter(view => view.status === 'ready');
          if (!ready.length) throw new Error('Утверждать нечего: ни одна ситуация не готова.');
          await lab.acceptCards(target.id, libraryHash((await lab.cardContext(target.id)).library), ready.map(view => view.id));
        }
        await show(target.id); return;
      }
      let command: ReturnType<typeof cardCommandSchema.parse>;
      if (values.choice) {
        const view: SituationView | undefined = (await situations(target.id)).views.find(item => item.number === Number(values.card));
        if (!view?.question?.id) throw new Error(`У ситуации ${values.card ?? '(укажите --card N)'} нет открытого вопроса.`);
        if (!['a', 'b', 'c'].includes(values.choice)) throw new Error('--choice: a, b или c — ответ из списка вопроса.');
        command = { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: values.choice as 'a' | 'b' | 'c', ...(values.text ? { text: values.text } : {}) };
      } else command = cardCommandSchema.parse(JSON.parse(await readFile(values.input!, 'utf8')));
      // The command file and the text on the command line are the owner's own: their words, confirmed by --yes.
      const words = wordsOf(command).join('\n');
      const prepared = await lab.prepareCardCommand(target.id, command, { via: 'cli-yes', ...(words && words.length <= 1000 ? { ownerWords: words } : {}) });
      const changes = prepared.diff.flatMap(item => item.changes.map(change => `${item.number}  ${changeText(change)}`));
      if (!values.yes) {
        await writeStdout(`${[...changes, '', ...(prepared.recheck.length ? ['После записи Lab проверит изменённое заново.'] : []), 'Записать: та же команда с --yes.'].map(line => safeLine(line)).join('\n')}\n`);
        return;
      }
      await lab.applyCardCommand(target.id, prepared, hostGrant(prepared, requiredAuthority(prepared.command) === 'owner-words' && words ? 'words' : 'confirmed'));
      const check = await lab.recheckCards(target.id);
      if (check.decision.action === 'run') await lab.waitForIdle();
      await show(target.id, changes.map(line => safeLine(line)));
    } finally { await lab.close(); }
    return;
  }
  if (command === 'logs') {
    if (!values.id) throw new Error('Укажите --id RUN.');
    if (values['agent-version'] !== undefined && values.unknown) throw new Error('Либо --agent-version, либо --unknown.');
    const lab = new ExperimentLab(directory);
    const importIds = logImports(await lab.get(values.id));
    const said = (version: string | null | undefined) => version === undefined ? 'не указана' : version ?? 'неизвестна';
    if (values['agent-version'] === undefined && !values.unknown) {
      const rows = await Promise.all(importIds.map(async id => `${id} · ${countText((await lab.store.readImport(id)).dialogues.length, ['разговор', 'разговора', 'разговоров'])}`
        + ` · версия агента: ${said((await lab.store.readLogVersions(id))?.declarations.at(-1)?.command.version)}`));
      await writeStdout(`${[...rows.length ? rows : ['У этого прогона нет логов.'], '', 'Указать версию: agent-lab logs --id RUN --agent-version ВЕРСИЯ --yes (или --unknown)'].map(line => safeLine(line)).join('\n')}\n`);
      return;
    }
    const importId = values.import ?? (importIds.length === 1 ? importIds[0] : undefined);
    if (!importId || !importIds.includes(importId)) throw new Error(`Укажите --import: ${importIds.join(', ') || 'у этого прогона нет логов'}.`);
    const prepared = await lab.prepareLogVersion({ kind: 'declare_log_version', importId, version: values.unknown ? null : values['agent-version']! }, { via: 'cli-yes' });
    const change = `Версия агента в логах: было «${said(prepared.change.before)}», стало «${said(prepared.change.after)}».`;
    if (!values.yes) { await writeStdout(`${safeLine(change)}\nЗаписать: та же команда с --yes.\n`); return; }
    await lab.init();
    try { await lab.applyLogVersion(prepared, hostGrant(prepared, 'confirmed')); } finally { await lab.close(); }
    await writeStdout(`${safeLine(change)} Записано: следующая сверка с продом прочтёт её.\n`);
    return;
  }
  if (command === 'doctor') {
    const connection = values.connection ? await readConnection(values.connection) : await rememberedConnection(directory);
    if (!connection?.probe) throw new Error('Укажите --connection с probe.write/read/reset и initialState.');
    if (!values.yes) { process.stdout.write(JSON.stringify({ target: connection.target, probe: connection.probe, requests: 3 }, null, 2) + '\n'); throw new Error('Для трёх пробных запросов укажите --yes.'); }
    const result = await doctor(connection);
    if (result.passed) await rememberConnection(directory, connection);
    if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.passed ? 0 : 2; return;
  }
  if (command === 'summary') {
    if (!values.id) throw new Error('Укажите --id RUN');
    const store = new ExperimentStore(directory);
    const record = await store.get(values.id);
    // The source run is read-only context for stability; the same verified path as Pi and the exports:
    // receipts checked against sidecars, source resolved once. The trace journal is not needed here.
    const verified = await resolveVerified(record, store, record.assessmentOf ?? record.parentRunId);
    const numbers = verified.record.calibration?.entries.length ? await importNumbers(verified.record, importId => store.readImport(importId)) : undefined;
    const view = buildResultView(verified.record, { before: verified.before, ...(numbers ? { numbers } : {}) });
    if (values.json) { process.stdout.write(`${JSON.stringify({ ...machineResult(view), warnings: verified.warnings }, null, 2)}\n`); return; }
    process.stdout.write(screenText(view, verified.warnings));
    return;
  }
  // Reading an atomic snapshot must not take the writer lock or mark another process interrupted.
  if (command === 'export' || command === 'diff') {
    const store = new ExperimentStore(directory);
    if (command === 'export') {
      if (!values.id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
      if (!['json', 'html', 'markdown'].includes(values.format!)) throw new Error('Формат экспорта: json, html или markdown.');
      const bundle = await evidenceBundle(await store.get(values.id), store, values.before);
      const content = values.format === 'html' ? htmlReport(bundle) : values.format === 'markdown' ? markdownReport(bundle) : jsonReport(bundle);
      if (values.output) await writeFile(values.output, content, { mode: 0o600 }); else process.stdout.write(`${content}\n`);
    } else {
      if (!values.before || !values.after) throw new Error('Укажите два прогона: --before RUN_ID --after RUN_ID');
      const [before, after] = await Promise.all([store.get(values.before), store.get(values.after)]);
      const diff = compareRuns(before, after);
      if (values.json) process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
      else process.stdout.write([
        diff.headline, '',
        ...(diff.regressed.length ? ['Сломалось:', ...diff.regressed.map(r => `  ✗ ${safeLine(r.title)}`), ''] : []),
        ...(diff.fixed.length ? ['Исправлено:', ...diff.fixed.map(r => `  ✓ ${safeLine(r.title)}`), ''] : []),
        ...(diff.incomparable.length ? ['Несравнимо:', ...diff.incomparable.map(r => `  ? ${safeLine(r.title)} (попытка ${r.repeat + 1}): ${safeLine(r.reason)}`), ''] : []),
        ...(diff.notes.length ? ['Оговорки:', ...diff.notes.map(n => `  · ${safeLine(n)}`), ''] : []),
      ].join('\n') + '\n');
      if (!diff.comparable) process.exitCode = 2;
    }
    return;
  }
  if (!['demo', 'prepare', 'build', 'repeat', 'run', 'accept', 'save-suite', 'evaluate', 'reassess'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'evaluate' && (!values.input || !values.yes)) throw new Error('Для запуска сохранённых тестов укажите --input suite.json --yes. Лимиты и подключение берутся из файла.');
  const lab = new ExperimentLab(directory);
  await lab.init();
  const cancel = () => { void lab.close().catch(error => { process.stderr.write(`${safeLine(error.message)}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    let id = values.id;
    if (command === 'accept') {
      if (!id) throw new Error('Укажите --id RUN.');
      const record = await lab.get(id);
      if (record.scenarios.length > 1) {
        const sheet = expectationSheet(record);
        await writeStdout(values.json
          ? `${JSON.stringify({ type: 'test_proposal', text: sheet.lines.join('\n'), lines: sheet.lines, draftHash: sheet.draftHash })}\n`
          : `${sheet.lines.map(safeLine).join('\n')}\n`);
        if (!values.yes) {
          await writeStdout(values.json
            ? `${JSON.stringify({ type: 'next_step', command: `agent-lab accept --id ${id} --yes` })}\n`
            : `\nПодтвердить все ожидания: agent-lab accept --id ${id} --yes\n`);
          return;
        }
        const confirmed = await lab.acceptDraft(id, sheet.draftHash);
        await writeStdout(values.json
          ? `${JSON.stringify({ type: 'accepted', id: confirmed.id, acceptedDraftHash: confirmed.acceptedDraftHash, agentRun: false })}\n`
          : `\nОжидания подтверждены: ${sheet.countText}.\n`);
        return;
      }
      const projection = testPlanLines(record);
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'test_proposal', text: projection.lines.join('\n'), lines: projection.lines, draftHash: projection.draftHash })}\n`
        : `${projection.lines.join('\n')}\n`);
      if (!values.yes) {
        await writeStdout(values.json
          ? `${JSON.stringify({ type: 'next_step', command: `agent-lab accept --id ${id} --yes` })}\n`
          : `\nЧтобы принять этот тест: agent-lab accept --id ${id} --yes\n`);
        return;
      }
      const accepted = await lab.acceptDraft(id, projection.draftHash);
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'accepted', id: accepted.id, acceptedDraftHash: accepted.acceptedDraftHash, agentRun: false })}\n`
        : `\nТест принят: ${accepted.acceptedDraftHash}. Агент не запускался.\n`);
      return;
    }
    if (command === 'reassess') {
      if (!id || (!values.yes && !values['code-only'])) throw new Error('Укажите --id RUN и --yes (модель) или --code-only (без модели).');
      const patch = values.input ? JSON.parse(await readFile(values.input, 'utf8')) : {};
      const draft = await lab.reassess(id, { ...patch, ...(values.trial ? { trialIds: values.trial } : {}), ...(values['code-only'] ? { codeOnly: true } : {}) });
      await lab.waitForIdle();
      const record = await lab.get(draft.id);
      const bundle = await evidenceBundle(record, lab.store);
      const result = machineResult(bundle.view);
      process.stdout.write(JSON.stringify({ id: record.id, phase: record.phase, assessmentOf: record.assessmentOf,
        evaluatorVersion: record.evaluatorVersion, artifacts: await exportArtifacts(bundle, directory), ...result }, null, 2) + '\n');
      process.exitCode = result.exitCode; return;
    }
    if (command === 'save-suite') {
      if (!id || !values.output) throw new Error('Укажите --id RUN --output .evals/regression.json.');
      process.stdout.write(`${await lab.saveSuite(id, values.output, values.case)}\n`); return;
    }
    if (command === 'evaluate') {
      const draft = await lab.loadSuite(values.input!, values.case, values.connection ? await readConnection(values.connection) : undefined);
      await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft), ...(values.parallel ? { parallel: Number(values.parallel) } : {}) });
      await lab.waitForIdle();
      const record = await lab.get(draft.id);
      const bundle = await evidenceBundle(record, lab.store, values.before);
      const artifacts = await exportArtifacts(bundle, lab.store.directory);
      const result = machineResult(bundle.view);
      process.exitCode = result.exitCode;
      process.stdout.write(JSON.stringify({ id: record.id, ...result, comparison: bundle.comparison, artifacts }, null, 2) + '\n');
      return;
    }
    if (command === 'demo' || command === 'prepare' || command === 'build') {
      if (command !== 'demo' && !values.input) throw new Error('Provide --input task.json');
      let raw = command === 'demo' ? demoInput() : JSON.parse(await readFile(values.input!, 'utf8'));
      if (command !== 'demo' && (raw.materialFiles || raw.promptFiles)) {
        // Articles and prompts named by path are read by Lab itself: whole files, no model in between, no item limit of a tool call.
        const { materialFiles, promptFiles, ...task } = raw;
        const expanded = await expandMaterials({ materials: task.materials, materialFiles, promptFiles }, dirname(resolve(values.input!)));
        for (const item of expanded.skipped) process.stderr.write(`Пропущен ${item.file}: ${item.reason}\n`);
        process.stderr.write(`Прочитано материалов из файлов: ${expanded.read}.\n`);
        raw = { ...task, materials: expanded.materials };
      }
      const connection = command === 'demo' ? undefined : values.connection ? await readConnection(values.connection) : !raw.target ? await rememberedConnection(directory) : undefined;
      const libraryImport = values['dialogues-file'] ? await readDialogueImport(values['dialogues-file'], { directory }) : raw.dialogues ? importDialogues(raw.dialogues) : undefined;
      const input = createInputSchema.parse({ ...raw, ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(libraryImport ? { originalImport: libraryImport.originalImport, dialogues: libraryImport.dialogues.slice(0, 200) } : {}) });
      const prepared = await lab.create(input); id = prepared.id; await lab.waitForIdle();
      const current = await lab.get(id);
      if (current.phase !== 'review') throw new Error(current.error ?? 'Preparation failed');
      if (command === 'prepare' || command === 'build') { process.stdout.write(`${JSON.stringify(current, null, 2)}\n`); return; }
      // The teaching example takes the owner's path: answer its one question («Да» — the customer knew the number), then accept every ready situation.
      const context = await lab.cardContext(id);
      for (const view of situationViews(context.experiment, { evidence: context.evidence, maxTurns: context.experiment.settings.maxTurns })) if (view.question?.id) {
        const answer = await lab.prepareCardCommand(id, { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: 'a' }, { via: 'cli-yes' });
        await lab.applyCardCommand(id, answer, hostGrant(answer, 'confirmed'));
      }
      const answered = await lab.cardContext(id);
      const ready = situationViews(answered.experiment, { evidence: answered.evidence, maxTurns: answered.experiment.settings.maxTurns }).filter(view => view.status === 'ready');
      await lab.acceptCards(id, libraryHash(answered.library), ready.map(view => view.id));
    }
    if (!id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
    if (command === 'repeat') {
      const record = await lab.repeat(id, values.case, values.control);
      process.stdout.write(`${JSON.stringify({ id: record.id, phase: record.phase, parentRunId: record.parentRunId, targetVersion: record.targetVersion,
        positiveControlScenarioIds: record.positiveControlScenarioIds, nextStep: 'Откройте /agent-lab в Pi, проверьте версию агента и подтвердите запуск.' }, null, 2)}\n`);
    } else if (command === 'run' || command === 'demo') {
      const draft = await lab.get(id);
      if (command === 'run' && !values.yes) throw new Error('Для запуска согласованных тестов укажите --yes.');
      await lab.start(id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft), ...(values.parallel ? { parallel: Number(values.parallel) } : {}) }); await lab.waitForIdle();
      const result = await lab.get(id);
      // The source run is read-only context for stability, as in `summary`.
      const verified = await resolveVerified(result, lab.store, result.parentRunId);
      const view = buildResultView(verified.record, { before: verified.before });
      process.stdout.write(`${JSON.stringify({ id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode,
        ...(result.workflow === 'evaluate' ? { ...machineResult(view), proofs: result.trials.map(trial => trialProofLines(result, trial.id)) } : { view }),
        comparison: result.comparisons.at(-1), ...(verified.warnings.length ? { warnings: verified.warnings } : {}), artifact: resolve(lab.store.directory, `${id}.json`) }, null, 2)}\n`);
      if (result.workflow === 'evaluate') process.exitCode = exitCodeOf(view);
      if (!['complete', 'results_review'].includes(result.phase)) throw new Error(result.error ?? 'Experiment did not complete');
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lab.close();
  }
}
void main().catch(error => { process.stderr.write(`Agent Lab: ${safeLine(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = process.argv[2] === 'evaluate' ? 2 : 1; });
