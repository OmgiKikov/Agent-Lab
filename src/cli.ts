#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { ExperimentLab, draftHash } from './experiment.js';
import { demoInput } from './demo.js';
import { createInputSchema, type Settings } from './contracts.js';
import { compareRuns, evidenceSummary, evaluationExitCode } from './comparison.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from './connection.js';
import { readData, readDialogueImport, importDialogues } from './imports.js';
import { expandMaterials } from './materials.js';
import { getPiStatus } from './pi.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { expectationSheet, qualityLines, qualitySummary, testPlanLines, trialProofLines } from './quality.js';
import { ExperimentStore } from './store.js';
import { agreementSectionLines, allFailuresTitle, buildResultView, causeSection, failureListRows, resultViewLines, SECTION_TEXT } from './result-view.js';
import { rowsToLines } from './explain.js';
import { evidenceBundle, exportArtifacts, resolveVerified } from './artifacts.js';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { libraryHash } from './scenario-library.js';
import { chooseEditableDraft, draftIsBusy } from './scenario-draft.js';
import { libraryPatchSchema } from './scenario-contracts.js';
import { semanticWorkStatus } from './scenario-work.js';

const percent = (value: number | null) => value === null ? 'нет данных' : `${Math.round(value * 100)}%`;
const safeText = (value: unknown) => stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
const safeLine = (value: unknown) => safeText(value).replace(/\n+/g, ' ');
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
    'golden-file': { type: 'string' }, 'dialogues-file': { type: 'string' }, candidate: { type: 'string' },
    hypothesis: { type: 'string' }, trial: { type: 'string', multiple: true },
    yes: { type: 'boolean' }, verify: { type: 'string' }, case: { type: 'string', multiple: true }, control: { type: 'string', multiple: true }, parallel: { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('  agent-lab summary --id RUN [--json]     Сколько ситуаций агент прошёл, что не измерено и почему\n');
    process.stdout.write('  agent-lab accept --id RUN [--yes]      Что агент должен сделать в каждой ситуации; --yes подтверждает все ожидания\n');
    process.stdout.write('Agent Lab — validation set, accuracy и причины провалов вашего агента.\n\n  agent-lab                         Диалог в текущем проекте\n  agent-lab chat [опции Pi]          Напишите задачу обычными словами\n  agent-lab save-suite --id RUN --output .evals/regression.json [--case ID]\n  agent-lab evaluate --input .evals/regression.json --yes [--case ID] [--parallel 4]\n\nevaluate: 0 — все оценки пройдены; 1 — зарегистрирован провал; 2 — ошибка теста/среды или неполные данные.\n--yes разрешает расход в пределах сохранённых лимитов; ручной оценкой ожиданий это не считается.\n\n');
    process.stdout.write('  agent-lab doctor --connection connection.json --yes\n  agent-lab suites --directory .evals\n  agent-lab reassess --id RUN [--input criteria.json] --yes\n  agent-lab reassess --id RUN --code-only\n  evaluate принимает --connection; build — --golden-file и --dialogues-file (JSON/JSONL).\n\n');
    process.stdout.write('  agent-lab scenarios --id RUN --operation inspect [--json]\n  agent-lab scenarios --id RUN --operation edit|merge|split|variant|assess|resume|accept --expected-hash HASH [--input action.json] [--yes]\n');
    process.stdout.write('Дополнительно: run --id RUN --yes [--parallel 4] · build --input task.json · repeat --id RUN [--case SCENARIO_ID] [--control SCENARIO_ID] · diff --before RUN --after RUN · export --id RUN --format html --output report.html · status.\n'); return;
  }
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await getPiStatus(), null, 2)}\n`); return; }
  const directory = values['data-dir'] ?? resolve('.agent-lab');
  if (command === 'suites') { process.stdout.write(JSON.stringify(await listSuites(values.directory ?? '.evals'), null, 2) + '\n'); return; }
  if (command === 'scenarios') {
    if (!values.id || !values.operation) throw new Error('Укажите --id RUN и --operation inspect|edit|merge|split|variant|assess|resume|accept.');
    if (!['inspect', 'edit', 'merge', 'split', 'variant', 'assess', 'resume', 'accept'].includes(values.operation)) throw new Error('Неизвестная операция scenarios.');
    const lab = new ExperimentLab(directory);
    const present = async () => {
      const { library, experiment } = await lab.readLibrary(values.id!);
      const work = semanticWorkStatus(library);
      return { id: experiment.id, libraryId: library.id, revision: library.revision, libraryHash: libraryHash(library), acceptance: library.acceptance,
        selectedVariantIds: library.acceptance?.variantIds ?? [], nextAction: library.acceptance ? 'run' : library.variants.some(v => v.quality === 'ready') ? 'accept' : 'review',
        progress: experiment.preparationProgress,
        budget: { usedCalls: experiment.usage.calls, maxCalls: experiment.settings.maxCalls, remainingCalls: Math.max(0, experiment.settings.maxCalls - experiment.usage.calls),
          semanticTotalJobs: work.totalJobs, semanticCompletedJobs: work.completedJobs, semanticPendingJobs: work.pendingJobs, skipped: work.skipped },
        businessScenarios: library.businessScenarios, variants: library.variants.map(variant => ({ ...variant,
          environmentFixture: { mode: variant.environmentFixture.mode, contract: variant.environmentFixture.contract } })), agentRun: false };
    };
    if (values.operation === 'inspect') { await writeStdout(`${JSON.stringify(await present(), null, 2)}\n`); return; }
    if (!values['expected-hash']) throw new Error('Укажите --expected-hash из свежего scenarios inspect.');
    if (values.verify && !['auto', 'later'].includes(values.verify)) throw new Error('--verify должен быть auto или later.');
    const payload = values.input ? JSON.parse(await readFile(values.input, 'utf8')) : {};
    await lab.init();
    try {
    const settled = await lab.get(values.id);
    if (settled.librarySnapshot && values.operation !== 'resume') {
      const headHash = await lab.store.readLibrary(settled.librarySnapshot.id).then(libraryHash, () => libraryHash(settled.librarySnapshot!));
      const choice = chooseEditableDraft({ settled, holders: await lab.list(), headHash, busy: draftIsBusy });
      if (choice.action === 'busy') throw new Error(`Прогон ${values.id.slice(0, 8)} выполняется. Правки — после остановки.`);
      if (choice.action === 'use') throw new Error(`Актуальный черновик — ${choice.id.slice(0, 8)}. Укажите его в --id.`);
      if (choice.action === 'copy') throw new Error(`Прогон ${values.id.slice(0, 8)} уже выполнен и не меняется. Создайте черновик того же набора и правьте его.`);
    }
      if (values.operation === 'variant') await lab.proposeVariant(values.id, values['expected-hash'], payload);
      else if (values.operation === 'resume') {
        if (!values.yes) throw new Error('Продолжение расходует оставшийся модельный бюджет; укажите --yes после проверки плана.');
        await lab.resumePreparation(values.id, values['expected-hash']); await lab.waitForIdle();
      } else if (values.operation === 'assess') {
        if (!values.yes) throw new Error('Смысловая проверка расходует модельный бюджет; укажите --yes после проверки плана.');
        const current = await lab.readLibrary(values.id); const plan = semanticWorkStatus(current.library);
        const remaining = Math.max(0, current.experiment.settings.maxCalls - current.experiment.usage.calls);
        if (!remaining && plan.pendingJobs) throw new Error(`Осталось ${plan.pendingJobs} смысловых вызовов, бюджет исчерпан; увеличьте settings.maxCalls через edit. Использованный бюджет не сбрасывается.`);
        await lab.recheckLibrary(values.id, { expectedHash: values['expected-hash'], explicit: true }); await lab.waitForIdle();
      } else if (values.operation === 'accept') {
        if (!values.yes) throw new Error('Принятие фиксирует выбранную ревизию; укажите --yes. Агент запускаться не будет.');
        if (!Array.isArray(payload.variantIds)) throw new Error('В --input нужен объект {"variantIds":[...]}.');
        await lab.acceptLibrary(values.id, values['expected-hash'], payload.variantIds);
      } else {
        const patch = libraryPatchSchema.parse(payload.patch ?? payload);
        const expectedKind = values.operation === 'merge' ? 'merge_business' : values.operation === 'split' ? 'split_business' : undefined;
        if (expectedKind && patch.kind !== expectedKind) throw new Error(`${values.operation} требует patch.kind=${expectedKind}.`);
        await lab.editLibrary(values.id, values['expected-hash'], patch, values.yes ? 'owner' : 'assistant');
      }
      if (values.verify === 'auto' && ['edit', 'merge', 'split', 'variant'].includes(values.operation)) {
        await lab.recheckLibrary(values.id); await lab.waitForIdle();
      }
      await writeStdout(`${JSON.stringify(await present(), null, 2)}\n`); return;
    } finally { await lab.close(); }
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
    const q = qualitySummary(record);
    // The source run is read-only context for stability; the whole evidence bundle (trace journal) is not needed here.
    const baseId = record.assessmentOf ?? record.parentRunId;
    // The same verified path as Pi and the exports: receipts checked against sidecars, source resolved once.
    const verified = await resolveVerified(record, store, baseId);
    const view = buildResultView(verified.record, { before: verified.before });
    const { warnings } = verified;
    if (values.json) { process.stdout.write(`${JSON.stringify({ ...q, view, warnings }, null, 2)}\n`); return; }
    const text = qualityLines(q);
    // One denominator in the first block; the other scores stay below «Подробности».
    // Block, top causes with a full example, every failed situation, then the details. Each row is escaped on its own.
    const section = causeSection(view);
    const causeLines = section ? ['', SECTION_TEXT[section.kind].text, ...rowsToLines(section.rows).map(safeLine)] : [];
    // Where the owner overturned the judge, and where the rest of the queue is marked (F7, F8).
    const agreement = agreementSectionLines(view);
    const agreementLines = agreement.length ? ['', ...agreement.map(line => line ? safeLine(line) : line)] : [];
    const failureLines = view.failures.length ? ['', allFailuresTitle(view.failures.length), ...rowsToLines(failureListRows(view)).map(safeLine)] : [];
    process.stdout.write([...resultViewLines(view, { details: true }).map(safeLine), ...warnings.map(warning => `Внимание: ${safeLine(warning)}`),
      ...causeLines, ...agreementLines, ...failureLines, '', 'Подробности:', ...text.metrics, '',
      ...(text.rag.length ? [...text.rag, ''] : []), text.queue, '', text.scope, text.limits, ''].join('\n'));
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
        ...(diff.regressed.length ? ['Сломалось:', ...diff.regressed.map(r => `  - [${r.tier}] ${r.title} (${r.scenarioId})`), ''] : []),
        ...(diff.fixed.length ? ['Исправлено:', ...diff.fixed.map(r => `  + [${r.tier}] ${r.title} (${r.scenarioId})`), ''] : []),
        ...(diff.incomparable.length ? ['Несравнимо:', ...diff.incomparable.map(r => `  ? [${r.tier}] ${r.title} (${r.scenarioId}, ${r.userMode} #${r.repeat + 1}): ${r.reason}`), ''] : []),
        ...(diff.stages.length ? ['По этапам работы агента:', ...diff.stages.map(st => `  ${st.stage}: ${percent(st.before)} → ${percent(st.after)}`), ''] : []),
        'По ступеням:', ...diff.tiers.filter(t => t.before.graded || t.after.graded).map(t => `  ${t.tier}: ${t.before.passed}/${t.before.graded} → ${t.after.passed}/${t.after.graded}`), '',
        ...(diff.notes.length ? ['Оговорки:', ...diff.notes.map(n => `  · ${n}`), ''] : []),
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
      process.stdout.write(JSON.stringify({ id: record.id, phase: record.phase, assessmentOf: record.assessmentOf,
        evaluatorVersion: record.evaluatorVersion, artifacts: await exportArtifacts(bundle, directory), evidence: bundle.evidence }, null, 2) + '\n');
      process.exitCode = record.phase === 'results_review' && !record.trials.some(t => t.assessmentError || ['invalid', 'cancelled'].includes(t.outcome)) ? 0 : 2; return;
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
      const v = evidenceSummary(record).verdict;
      const quality = qualitySummary(record);
      process.exitCode = evaluationExitCode(record);
      process.stdout.write(JSON.stringify({ id: record.id, exitCode: process.exitCode,
        quality: { ...qualityLines(quality), primary: quality.primary, cards: quality.cards, strict: quality.strict, metrics: quality.metrics, causes: quality.causes },
        verdict: v, comparison: bundle.comparison, view: bundle.view, artifacts }, null, 2) + '\n');
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
      const libraryImport = values['dialogues-file'] ? await readDialogueImport(values['dialogues-file']) : raw.dialogues ? importDialogues(raw.dialogues) : undefined;
      const input = createInputSchema.parse({ ...raw, ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(values['golden-file'] ? { goldenCases: await readData(values['golden-file'], 'golden') } : {}),
        ...(libraryImport ? { originalImport: libraryImport.originalImport, dialogues: libraryImport.dialogues.slice(0, 200) } : {}) });
      const prepared = await lab.create(input); id = prepared.id; await lab.waitForIdle();
      const current = await lab.get(id);
      if (current.phase !== 'review') throw new Error(current.error ?? 'Preparation failed');
      if (command === 'prepare' || command === 'build') { process.stdout.write(`${JSON.stringify(current, null, 2)}\n`); return; }
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
      const quality = qualitySummary(result);
      // The source run is read-only context for stability, as in `summary`.
      const verified = await resolveVerified(result, lab.store, result.parentRunId);
      const view = buildResultView(verified.record, { before: verified.before });
      process.stdout.write(`${JSON.stringify({ id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode,
        ...(result.workflow === 'evaluate' ? { quality: { ...qualityLines(quality), primary: quality.primary, cards: quality.cards, strict: quality.strict, metrics: quality.metrics, causes: quality.causes },
          verdict: evidenceSummary(result).verdict, exitCode: evaluationExitCode(result),
          proofs: result.trials.map(trial => trialProofLines(result, trial.id)) } : {}),
        comparison: result.comparisons.at(-1), view, ...(verified.warnings.length ? { warnings: verified.warnings } : {}), artifact: resolve(lab.store.directory, `${id}.json`) }, null, 2)}\n`);
      if (result.workflow === 'evaluate') process.exitCode = evaluationExitCode(result);
      if (!['complete', 'results_review'].includes(result.phase)) throw new Error(result.error ?? 'Experiment did not complete');
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lab.close();
  }
}
void main().catch(error => { process.stderr.write(`Agent Lab: ${safeLine(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = process.argv[2] === 'evaluate' ? 2 : 1; });
