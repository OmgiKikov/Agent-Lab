import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { draftPatchSchema, reassessmentSchema, type RunnableTarget } from '../src/contracts.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from '../src/connection.js';
import { targetLabel } from '../src/detect.js';
import { resultHash } from '../src/experiment.js';
import { identifierPattern, sha256Pattern } from '../src/ids.js';
import { countText } from '../src/plural.js';
import { safeText } from '../src/text.js';
import { agentLine, row, runStamp } from './conversation.ts';
import type { LabHost } from './host.ts';
import { ask, displayFor, isInteractive, requireInteractive } from './lab-ui.ts';
import { rememberView, VERDICT_KIND } from './render/verdict-block.ts';
import { summary } from './summary.ts';

/*
 * The run's settings and the agent's connection, saved sets of situations and the re-assessment of recorded
 * conversations. Spending more — a higher limit, a probe of the agent, a re-assessment by the judge — is always the
 * owner's pick in a native dialog; nothing here is raised or spent silently.
 */

const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];

/** The draft's settings and connection; registered before the run tools, so the model reads the tools in the order of the work. */
export function registerDraftTool(pi: ExtensionAPI, host: LabHost): void {
  const { open, focus, feedResult } = host;
  pi.registerTool({
    ...displayFor('agent_lab_edit'),
    name: 'agent_lab_edit', label: 'Edit an unapproved agent draft',
    description: 'Edit the run settings, the agent connection (target), targetVersion or the agent label of a draft after inspecting its current draftHash. Situations change only through the situation tools (agent_lab_card_*). Human approval stays pending. Cannot change started experiments, run dialogues, record human verdicts, or approve results.',
    parameters: Type.Object({ id: Type.String({ pattern: identifierPattern }), expectedHash: Type.String({ pattern: sha256Pattern }), patch: Type.Unsafe(z.toJSONSchema(draftPatchSchema, { io: 'input' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      try {
        await lab.init();
        const patch = draftPatchSchema.parse(params.patch);
        // A higher spending limit is the owner's decision: in the terminal it is asked natively, never raised silently.
        const before = await lab.get(params.id);
        const raised = patch.settings?.maxCalls !== undefined && patch.settings.maxCalls > before.settings.maxCalls;
        if (raised && isInteractive(ctx) && !await ask(ctx, `Поднять лимит до ${patch.settings!.maxCalls} вызовов модели?`,
          [`Сейчас ${before.settings.maxCalls}; уже потрачено ${before.usage.calls} — потраченное не сбрасывается.`], 'Поднять лимит')) {
          return feedResult(callId, { id: before.id, cancelled: true, mutated: false, message: 'Лимит не изменён.' }, { tone: 'warning', rows: [row('Лимит не изменён.')] }, 'Лимит не изменён');
        }
        const record = await lab.updateDraft(params.id, params.expectedHash, patch);
        const output = summary(record, lab.store.directory);
        focus.set(lab.store.directory, record.id);
        // What changed, in one row; the agent as the owner knows it under it.
        const parts = [patch.target ? 'подключение к агенту' : '', patch.targetVersion ? `версия агента — ${patch.targetVersion}` : '', patch.settings ? 'настройки и лимиты' : '',
          patch.agent ? 'описание агента' : ''].filter(Boolean);
        return feedResult(callId, output, { rows: [row(`Изменено: ${safeText(parts.join(', ') || 'ничего')}.`, 'text', true),
          row(`Агент: ${agentLine(record, ctx.cwd)}`, 'muted'), row('Запуск подтверждается заново.', 'muted')] }, `Настройки · ${runStamp(record)}`);
      } finally { await close(); }
    },
  });
}

/** Saved sets of situations, the agent's connection and the re-assessment of recorded conversations. */
export function registerSetupTools(pi: ExtensionAPI, host: LabHost): void {
  const { open, focus, feedResult } = host;
  pi.registerTool({
    ...displayFor('agent_lab_suite'), name: 'agent_lab_suite', label: 'Save or load reusable tests',
    description: 'Save selected tests as a versionable .evals/*.json file, or load that file into a fresh draft without model generation. Preserves original provenance and criteria. Clears results and approvals. Saving never overwrites an existing file. Use after a useful finding or when the user wants a regression test. Loading does not run it; inspect then use agent_lab_run.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('save'), Type.Literal('load'), Type.Literal('list')]), connectionFile: Type.Optional(Type.String()), file: Type.String({ minLength: 1 }),
      id: Type.Optional(Type.String()), scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      const where = (file: string) => safeText(file.replace(`${ctx.cwd}/`, ''));
      try {
        await lab.init();
        if (params.action === 'list') {
          const suites = await listSuites(resolve(ctx.cwd, params.file));
          return feedResult(callId, suites, { rows: [row(suites.length ? `Сохранённых наборов: ${suites.length}` : 'Сохранённых наборов нет.', 'text', true)],
            ...(suites.length ? { more: suites.map(suite => 'error' in suite ? row(`${where(suite.file)} — ${safeText(suite.error)}`, 'muted')
              : row(`${where(suite.file)} — ${safeText(suite.task)} · ${countText(suite.cases.length, SITUATIONS)}`)), expand: 'все наборы' } : {}) }, 'Сохранённые наборы');
        }
        if (params.action === 'save') {
          if (!params.id) throw new Error('Укажите прогон, из которого сохранить ситуации.');
          const file = await lab.saveSuite(params.id, resolve(ctx.cwd, params.file), params.scenarioIds);
          return feedResult(callId, { file, message: 'Тесты сохранены. Их можно добавить в Git и запускать после каждой правки.', nextStep: `agent-lab evaluate --input ${JSON.stringify(file)} --yes` },
            { rows: [row(`Набор сохранён: ${where(file)}`, 'text', true), row('Его можно добавить в Git и запускать после каждой правки агента.', 'muted')] }, 'Набор сохранён');
        }
        const record = await lab.loadSuite(resolve(ctx.cwd, params.file), params.scenarioIds, params.connectionFile ? await readConnection(resolve(ctx.cwd, params.connectionFile)) : undefined);
        focus.set(lab.store.directory, record.id);
        return feedResult(callId, summary(record, lab.store.directory), { rows: [row(`Набор загружен: ${countText(record.scenarios.length, SITUATIONS)}; агент не запускался.`, 'text', true),
          row('Скажите «запусти», чтобы прогнать его.', 'muted')] }, `Набор · ${runStamp(record)}`);
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_connection'), name: 'agent_lab_connection', label: 'Check agent connection',
    description: 'Inspect a saved connection or run its explicit three-request history/reset probe. Use file for portable JSON config; omit to use the remembered successful connection. check asks the human to approve the concrete requests. Reports actual evidence; never claims trusted state merely from adapter assertions.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('inspect'), Type.Literal('check')]), file: Type.Optional(Type.String()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      const directory = resolve(ctx.cwd, '.agent-lab');
      const connection = params.file ? await readConnection(resolve(ctx.cwd, params.file)) : await rememberedConnection(directory);
      if (!connection) throw new Error('Сохранённого подключения нет. Укажите файл подключения.');
      const label = (target: RunnableTarget) => safeText(targetLabel(target, ctx.cwd));
      const agent = `${label(connection.target)}${connection.targetVersion ? ` · версия ${safeText(connection.targetVersion)}` : ''}`;
      if (params.action !== 'check') return feedResult(callId, connection, { rows: [row(`Агент: ${agent}`, 'text', true),
        row(connection.probe ? 'Проверку истории и сброса можно запустить: скажите «проверь подключение».' : 'Проверка истории и сброса не описана в файле подключения.', 'muted')] }, 'Подключение к агенту');
      if (!connection.probe) throw new Error('Добавьте probe.write/read/reset и initialState в файл подключения.');
      requireInteractive(ctx, 'Проверка подключения идёт с вашего согласия в интерактивном терминале Pi.');
      if (!await ask(ctx, 'Проверить подключение: 3 запроса к агенту?', [`Агент: ${agent}`, `Запросы: «${safeText(connection.probe.write.message)}», «${safeText(connection.probe.read.message)}», «${safeText(connection.probe.reset.message)}».`,
        'Модель не вызывается; проверяются история разговора и сброс состояния.'], 'Проверить')) {
        return feedResult(callId, { cancelled: true }, { tone: 'warning', rows: [row('Проверка отменена; к агенту не обращались.')] }, 'Проверка подключения');
      }
      const result = await doctor(connection, AbortSignal.any([signal, ctx.signal].filter((s): s is AbortSignal => !!s)));
      if (result.passed) await rememberConnection(directory, connection);
      return feedResult(callId, result, { tone: result.passed ? 'success' : 'warning',
        rows: [row(result.passed ? 'Подключение работает: история и сброс подтверждены; подключение запомнено.' : 'Проверка подключения не прошла.', 'text', true), row(safeText(result.message), 'muted')] }, 'Проверка подключения');
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_reassess'), name: 'agent_lab_reassess', label: 'Reassess recorded evidence',
    description: 'Evaluate new checks/rubrics on existing trial traces without calling the target or simulator. Creates a separate immutable result retaining the original run. codeOnly uses no model; judge overrides are optional. This cannot demonstrate an agent improvement. Ask native confirmation before model spending.',
    parameters: Type.Object({ id: Type.String(), input: Type.Optional(Type.Unsafe(z.toJSONSchema(reassessmentSchema, { io: 'input' }))) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      const input = reassessmentSchema.parse(params.input ?? {});
      const { lab, close } = await open(ctx.cwd);
      const cancel = () => { void close(); };
      try {
        await lab.init();
        const original = await lab.get(params.id);
        if (!input.codeOnly) {
          requireInteractive(ctx, 'Переоценка судьёй идёт с вашего согласия в интерактивном терминале Pi.');
          const conversations = input.trialIds?.length ?? original.trials.length;
          if (!await ask(ctx, `Переоценить ${countText(conversations, ['сохранённый разговор', 'сохранённых разговора', 'сохранённых разговоров'])}?`,
            ['Агент не запускается: судья заново оценивает записанные разговоры.', `Не больше ${original.settings.maxCalls} вызовов модели и ${Math.max(1, Math.round(original.settings.maxDurationMs / 60_000))} мин.`], 'Переоценить')) {
            return feedResult(callId, { cancelled: true }, { tone: 'warning', rows: [row('Переоценка отменена; ничего не потрачено.')] }, 'Переоценка');
          }
        }
        signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
        const draft = await lab.reassess(params.id, input);
        await lab.waitForIdle();
        const record = await lab.get(draft.id);
        const bundle = await evidenceBundle(record, lab.store);
        const output = { ...summary(record, lab.store.directory, bundle.view), assessmentOf: record.assessmentOf, artifacts: await exportArtifacts(bundle, lab.store.directory) };
        focus.set(lab.store.directory, record.id);
        const resultKey = `${record.id}:${resultHash(record)}`;
        rememberView(resultKey, bundle.view);
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: { kind: VERDICT_KIND, version: 1 as const, runId: record.id, resultKey } };
      } finally { signal?.removeEventListener('abort', cancel); await close(); }
    },
  });
}
