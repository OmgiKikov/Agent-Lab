#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { ExperimentLab, draftHash, planDiscovery } from './experiment.js';
import { demoInput } from './demo.js';
import { createInputSchema, discoverInputSchema } from './contracts.js';
import { compareRuns, evidenceSummary, evaluationExitCode } from './comparison.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from './connection.js';
import { inspectPrompt, promptVersion, proposePrompt } from './prompt-edit.js';
import { readData } from './imports.js';
import { getPiStatus } from './pi.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { discoveryBrief, qualityLines, qualitySummary, scoreBrief, testPlanLines, trialProofLines, type ScoreBrief } from './quality.js';
import { ExperimentStore } from './store.js';
import { evidenceBundle, exportArtifacts } from './artifacts.js';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

const percent = (value: number | null) => value === null ? 'нет данных' : `${Math.round(value * 100)}%`;
const safeText = (value: unknown) => stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
const safeLine = (value: unknown) => safeText(value).replace(/\n+/g, ' ');
const scoreInputError = (error: unknown) => new Error(`Не удалось прочитать записи: ${safeLine(error instanceof Error ? error.message : String(error))}. Исправьте JSON/JSONL и повторите команду; агент не запускался.`);
const renderScoreBrief = (brief: ScoreBrief): string => brief.status === 'insufficient'
  ? `${brief.heading}\n${brief.body}`
  : [
    'ТРЕБОВАНИЯ', ...brief.requirements.map(item => `• ${safeText(item)}`), '',
    'НАБЛЮДАЕМОЕ', ...brief.observations.map(item => `• ${safeText(item)}`), '',
    'НЕИЗВЕСТНО', ...brief.unknowns.map(item => `• ${safeText(item)}`), '',
    'ГИПОТЕЗА', safeText(brief.hypothesis), '', brief.question,
  ].join('\n');
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
    task: { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    format: { type: 'string', default: 'json' }, json: { type: 'boolean' },
    connection: { type: 'string' }, directory: { type: 'string' }, 'code-only': { type: 'boolean' },
    'golden-file': { type: 'string' }, 'dialogues-file': { type: 'string' }, candidate: { type: 'string' },
    hypothesis: { type: 'string' }, trial: { type: 'string', multiple: true },
    yes: { type: 'boolean' }, case: { type: 'string', multiple: true }, parallel: { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('  agent-lab summary --id RUN [--json]     Качество агента: карточки, критерии, причины, что разметить\n');
    process.stdout.write('  agent-lab accept --id RUN [--yes]\n');
    process.stdout.write('Agent Lab — проверьте, что сломала правка вашего агента.\n\n  agent-lab                         Диалог в текущем проекте\n  agent-lab chat [опции Pi]          Напишите задачу обычными словами\n  agent-lab save-suite --id RUN --output .evals/regression.json [--case ID]\n  agent-lab evaluate --input .evals/regression.json --yes [--case ID] [--parallel 4]\n\nevaluate: 0 — все оценки пройдены; 1 — зарегистрирован провал; 2 — ошибка теста/среды или неполные данные.\n--yes разрешает расход в пределах сохранённых лимитов; ручной оценкой ожиданий это не считается.\n\n');
    process.stdout.write('  agent-lab doctor --connection connection.json --yes\n  agent-lab suites --directory .evals\n  agent-lab discover --input dialogues.jsonl --task task.json [--yes] [--json]\n  agent-lab discover-resume --id RUN [--yes] [--json]\n  agent-lab discover-build --id RUN [--yes] [--json]\n  agent-lab score --input dialogues.jsonl --task task.json --yes [--json]\n  agent-lab score --input dialogues.jsonl --task task.json --code-only [--json]\n  agent-lab reassess --id RUN [--input criteria.json] --yes\n  agent-lab reassess --id RUN --code-only\n  agent-lab prompt-propose --id RUN --candidate prompt.md --hypothesis TEXT --trial TRIAL\n  agent-lab prompt-apply --input proposal.json --yes\n  evaluate принимает --connection; build — --golden-file и --dialogues-file (JSON/JSONL).\n\n');
    process.stdout.write('Дополнительно: run --id RUN --yes [--parallel 4] · build --input task.json · repeat --id RUN · diff --before RUN --after RUN · export --id RUN --format html --output report.html · status.\nКонтракты подключения: docs/REFERENCE.md.\n'); return;
  }
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await getPiStatus(), null, 2)}\n`); return; }
  const directory = values['data-dir'] ?? resolve('.agent-lab');
  if (command === 'suites') { process.stdout.write(JSON.stringify(await listSuites(values.directory ?? '.evals'), null, 2) + '\n'); return; }
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
    const record = await new ExperimentStore(directory).get(values.id);
    const q = qualitySummary(record);
    if (values.json) { process.stdout.write(`${JSON.stringify(q, null, 2)}\n`); return; }
    const text = qualityLines(q);
    process.stdout.write([text.headline, ...text.metrics, '', ...(text.causes.length ? ['Почему:', ...text.causes, ''] : []), text.judge, text.queue, '', text.scope, text.limits, ''].join('\n'));
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
  if (command === 'discover') {
    if (!values.input || !values.task) throw new Error('Укажите --input dialogues.jsonl --task task.json. Без --yes будет показан только план и бюджет.');
    let input;
    try {
      const raw: Record<string, unknown> = JSON.parse(await readFile(values.task, 'utf8'));
      const dialogues = await readData(values.input, 'dialogues', { maxItems: 300 });
      const connection = values.connection ? await readConnection(values.connection) : !raw.target ? await rememberedConnection(directory) : undefined;
      input = discoverInputSchema.parse({ ...raw, mode: raw.mode ?? 'live',
        ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}), dialogues });
    } catch (error) {
      throw scoreInputError(error);
    }
    const plan = planDiscovery(input);
    const shownPlan = { type: 'discovery_plan', dialogueCount: input.dialogues.length, batches: plan.batchCount,
      selectedCap: plan.selectedCap, nominalCalls: plan.nominalCalls, maxCalls: plan.maxCalls,
      maxDurationMs: plan.maxDurationMs, oversizedDialogueIds: plan.oversizedIds };
    await writeStdout(values.json
      ? `${JSON.stringify(shownPlan)}\n`
      : ['ПЛАН DISCOVERY', `Диалогов: ${shownPlan.dialogueCount}.`, `Партий первичного разбора: ${shownPlan.batches}.`,
        `Подробно проверить: до ${shownPlan.selectedCap}.`, `План: ${shownPlan.nominalCalls} модельных вызовов; потолок: ${shownPlan.maxCalls}; время: до ${Math.ceil(shownPlan.maxDurationMs / 1000)} секунд.`,
        ...(shownPlan.oversizedDialogueIds.length ? [`Не войдут целиком: ${shownPlan.oversizedDialogueIds.join(', ')}.`] : []), ''].join('\n'));
    if (!values.yes) {
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'next_step', command: `agent-lab discover --input ${values.input} --task ${values.task} --yes${values.json ? ' --json' : ''}` })}\n`
        : 'Для запуска discovery повторите команду с --yes. До подтверждения модель не вызывается.\n');
      return;
    }
    const discoveryLab = new ExperimentLab(directory);
    const closeDiscovery = () => { void discoveryLab.close().catch(error => { process.stderr.write(`${safeLine(error.message)}\n`); process.exitCode = 2; }); };
    process.once('SIGINT', closeDiscovery); process.once('SIGTERM', closeDiscovery);
    try {
      await discoveryLab.init();
      const started = await discoveryLab.discover(input);
      await discoveryLab.waitForIdle();
      const record = await discoveryLab.get(started.id);
      const brief = discoveryBrief(record);
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'discovery_result', id: record.id, phase: brief.status, plan: shownPlan, brief, text: brief.lines.join('\n') })}\n`
        : `${brief.lines.join('\n')}\n`);
      process.exitCode = brief.status === 'ready' ? 0 : 2;
    } finally {
      process.removeListener('SIGINT', closeDiscovery); process.removeListener('SIGTERM', closeDiscovery);
      await discoveryLab.close();
    }
    return;
  }
  if (command === 'discover-resume') {
    if (!values.id) throw new Error('Укажите --id RUN незавершённого discovery.');
    const source = await new ExperimentStore(directory).get(values.id);
    if (!source.discovery) throw new Error('Указанный run не является discovery.');
    const callsUsed = Math.max(source.usage.calls, source.discovery.callsUsed);
    const maxCalls = source.discovery.callPlan.maxCalls;
    const maxDurationMs = source.discovery.callPlan.maxDurationMs;
    const elapsedMs = source.discovery.elapsedMs ?? 0;
    if (source.discovery.callPlan.legacyBudgetMissing) throw new Error('Старая discovery-запись не содержит исходный бюджет; начните новый discovery run.');
    if (source.discovery.activeCall) throw new Error(`Discovery остановился во время модельного вызова «${source.discovery.activeCall}»; безопасное возобновление невозможно.`);
    if (['ready', 'insufficient'].includes(source.discovery.phase)) throw new Error('Этот discovery run не требует возобновления.');
    if (callsUsed >= maxCalls) throw new Error('Бюджет discovery исчерпан; найденные доказательства сохранены.');
    if (elapsedMs >= maxDurationMs) throw new Error('Лимит времени discovery исчерпан; найденные доказательства сохранены.');
    const commandLine = `agent-lab discover-resume --id ${source.id} --yes --data-dir ${JSON.stringify(directory)}${values.json ? ' --json' : ''}`;
    const status = { type: 'discovery_resume', id: source.id, status: source.discovery.phase,
      callsUsed, maxCalls, remainingCalls: Math.max(0, maxCalls - callsUsed), elapsedMs,
      maxDurationMs, remainingDurationMs: Math.max(0, maxDurationMs - elapsedMs), command: commandLine };
    if (!values.yes) {
      await writeStdout(values.json ? `${JSON.stringify(status)}\n` : [
        'DISCOVERY RESUME', `Статус: ${status.status}.`, `Вызовы: ${callsUsed}/${maxCalls} (осталось не более ${status.remainingCalls}).`,
        `Время: ${Math.ceil(elapsedMs / 1000)}/${Math.ceil(maxDurationMs / 1000)} секунд (осталось до ${Math.ceil(status.remainingDurationMs / 1000)}).`, `Для возобновления: ${commandLine}`, '',
      ].join('\n'));
      return;
    }
    const resumeLab = new ExperimentLab(directory);
    await resumeLab.init();
    try {
      const started = await resumeLab.resumeDiscovery(source.id);
      await resumeLab.waitForIdle();
      const record = await resumeLab.get(started.id);
      const brief = discoveryBrief(record);
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'discovery_result', id: record.id, phase: brief.status, resumed: true, brief, text: brief.lines.join('\n') })}\n`
        : `${brief.lines.join('\n')}\n`);
      process.exitCode = brief.status === 'ready' ? 0 : 2;
    } finally {
      await resumeLab.close();
    }
    return;
  }
  if (command === 'discover-build') {
    if (!values.id) throw new Error('Укажите --id RUN готового discovery.');
    const source = await new ExperimentStore(directory).get(values.id);
    const brief = discoveryBrief(source);
    if (brief.status !== 'ready' || !brief.hypothesis) throw new Error('В discovery нет готовой сохранённой гипотезы.');
    if (!values.yes) {
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'hypothesis_confirmation', id: source.id, hypothesis: brief.hypothesis,
          command: `agent-lab discover-build --id ${source.id} --yes${values.json ? ' --json' : ''}` })}\n`
        : `${brief.lines.join('\n')}\n\nЧтобы собрать черновик теста: agent-lab discover-build --id ${source.id} --yes\n`);
      return;
    }
    const buildLab = new ExperimentLab(directory);
    await buildLab.init();
    try {
      const started = await buildLab.buildFromDiscovery(source.id, brief.hypothesis);
      await buildLab.waitForIdle();
      const record = await buildLab.get(started.id);
      const projection = testPlanLines(record);
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'test_proposal', id: record.id, fromRunId: source.id, hypothesis: brief.hypothesis,
          text: projection.lines.join('\n'), lines: projection.lines, draftHash: projection.draftHash })}\n`
        : `${projection.lines.join('\n')}\n\nЧерновик собран: ${record.id}. Агент не запускался.\n`);
    } finally {
      await buildLab.close();
    }
    return;
  }
  if (!['demo', 'prepare', 'build', 'score', 'repeat', 'run', 'accept', 'save-suite', 'evaluate', 'reassess', 'prompt-propose', 'prompt-apply'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'evaluate' && (!values.input || !values.yes)) throw new Error('Для запуска сохранённых тестов укажите --input suite.json --yes. Лимиты и подключение берутся из файла.');
  const lab = new ExperimentLab(directory);
  await lab.init();
  const cancel = () => { void lab.close().catch(error => { process.stderr.write(`${safeLine(error.message)}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    let id = values.id;
    if (command === 'prompt-propose') {
      if (!id || !values.candidate || !values.hypothesis || !values.trial?.length) throw new Error('Укажите --id RUN --candidate prompt.md --hypothesis TEXT --trial TRIAL.');
      const result = await proposePrompt(directory, await lab.get(id), { candidate: await readFile(values.candidate, 'utf8'), hypothesis: values.hypothesis, trialIds: values.trial });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return;
    }
    if (command === 'prompt-apply') {
      if (!values.input) throw new Error('Укажите --input proposal.json.');
      const proposal = await inspectPrompt(values.input);
      process.stdout.write(proposal.diff + '\n');
      if (!values.yes) throw new Error('Для подготовки отдельной версии укажите --yes после просмотра diff.');
      const draft = await promptVersion(lab, values.input, proposal.reviewHash);
      process.stdout.write(JSON.stringify({ id: draft.id, phase: draft.phase, target: draft.target,
        nextStep: `agent-lab run --id ${draft.id} --yes` }, null, 2) + '\n'); return;
    }
    if (command === 'accept') {
      if (!id) throw new Error('Укажите --id RUN.');
      const record = await lab.get(id);
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
    if (command === 'score') {
      if (!values.input || !values.task || (!values.yes && !values['code-only'])) {
        throw new Error('Укажите --input dialogues.jsonl --task task.json и --yes (модель) или --code-only. Агент не запускается.');
      }
      let input;
      try {
        const raw: Record<string, unknown> = JSON.parse(await readFile(values.task, 'utf8'));
        const dialogues = await readData(values.input, 'dialogues');
        const connection = values.connection ? await readConnection(values.connection) : !raw.target ? await rememberedConnection(directory) : undefined;
        input = createInputSchema.parse({ ...raw, mode: raw.mode ?? 'live', ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
          dialogues, scenarioCount: 0 });
      } catch (error) {
        throw scoreInputError(error);
      }
      const seed = await lab.score(input, { codeOnly: values['code-only'] });
      await lab.waitForIdle();
      const imported = await lab.get(seed.id);
      if (imported.phase !== 'results_review') throw new Error(imported.error ?? 'Импорт диалогов не удался; агент не запускался.');
      let record = imported;
      if (!values['code-only'] && !imported.questions.length) {
        const pending = await lab.reassess(seed.id, {}, { carryUsage: true });
        await lab.waitForIdle();
        record = await lab.get(pending.id);
      }
      const bundle = await evidenceBundle(record, lab.store);
      const artifacts = await exportArtifacts(bundle, directory);
      const quality = qualityLines(qualitySummary(record));
      const output = { id: record.id, phase: record.phase, imported: imported.trials.length, questions: record.questions,
        ...(record.assessmentOf ? { assessmentOf: record.assessmentOf } : {}),
        ...(values['code-only'] ? { scoreState: 'Оценено по коду без вызовов модели; кластеры провалов не строились.' } : {}),
        brief: renderScoreBrief(scoreBrief(record)), quality, artifacts, evidence: bundle.evidence };
      if (values.json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      else process.stdout.write([
        ...('scoreState' in output ? [output.scoreState, ''] : []), output.brief,
        ...(record.questions.length ? ['', 'ВОПРОСЫ ВЛАДЕЛЬЦУ', ...record.questions.map(question => `• ${safeText(question)}`)] : []),
        '', 'АРТЕФАКТЫ', ...Object.entries(artifacts).map(([name, path]) => `• ${name}: ${safeText(path)}`), '',
      ].join('\n'));
      process.exitCode = record.phase === 'results_review' && !record.questions.length
        && !record.trials.some(trial => trial.assessmentError || ['invalid', 'cancelled'].includes(trial.outcome)) ? 0 : 2;
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
      process.exitCode = evaluationExitCode(record);
      process.stdout.write(JSON.stringify({ id: record.id, exitCode: process.exitCode, verdict: v, comparison: bundle.comparison, artifacts }, null, 2) + '\n');
      return;
    }
    if (command === 'demo' || command === 'prepare' || command === 'build') {
      if (command !== 'demo' && !values.input) throw new Error('Provide --input task.json');
      const raw = command === 'demo' ? demoInput() : JSON.parse(await readFile(values.input!, 'utf8'));
      const connection = command === 'demo' ? undefined : values.connection ? await readConnection(values.connection) : !raw.target ? await rememberedConnection(directory) : undefined;
      const input = createInputSchema.parse({ ...raw, ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(values['golden-file'] ? { goldenCases: await readData(values['golden-file'], 'golden') } : {}),
        ...(values['dialogues-file'] ? { dialogues: await readData(values['dialogues-file'], 'dialogues') } : {}) });
      const prepared = await lab.create(input); id = prepared.id; await lab.waitForIdle();
      const current = await lab.get(id);
      if (current.phase !== 'review') throw new Error(current.error ?? 'Preparation failed');
      if (command === 'prepare' || command === 'build') { process.stdout.write(`${JSON.stringify(current, null, 2)}\n`); return; }
    }
    if (!id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
    if (command === 'repeat') {
      const record = await lab.repeat(id, values.case);
      process.stdout.write(`${JSON.stringify({ id: record.id, phase: record.phase, parentRunId: record.parentRunId, targetVersion: record.targetVersion, nextStep: 'Откройте /agent-lab в Pi, проверьте версию агента и подтвердите запуск.' }, null, 2)}\n`);
    } else if (command === 'run' || command === 'demo') {
      const draft = await lab.get(id);
      if (command === 'run' && !values.yes) throw new Error('Для запуска согласованных тестов укажите --yes.');
      await lab.start(id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft), ...(values.parallel ? { parallel: Number(values.parallel) } : {}) }); await lab.waitForIdle();
      const result = await lab.get(id);
      process.stdout.write(`${JSON.stringify({ id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode,
        ...(result.workflow === 'evaluate' ? { verdict: evidenceSummary(result).verdict, exitCode: evaluationExitCode(result),
          proofs: result.trials.map(trial => trialProofLines(result, trial.id)) } : {}),
        comparison: result.comparisons.at(-1), artifact: resolve(lab.store.directory, `${id}.json`) }, null, 2)}\n`);
      if (result.workflow === 'evaluate') process.exitCode = evaluationExitCode(result);
      if (!['complete', 'results_review'].includes(result.phase)) throw new Error(result.error ?? 'Experiment did not complete');
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lab.close();
  }
}
void main().catch(error => { process.stderr.write(`Agent Lab: ${safeLine(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = ['evaluate', 'score', 'discover', 'discover-resume', 'discover-build'].includes(process.argv[2] ?? '') ? 2 : 1; });
