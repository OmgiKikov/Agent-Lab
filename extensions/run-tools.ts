import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { isRunning } from '../src/contracts.js';
import { situationViews } from '../src/card/view.js';
import { draftHash } from '../src/experiment.js';
import { identifierPattern, sha256Pattern } from '../src/ids.js';
import { countText } from '../src/plural.js';
import { expectationSheet, testPlanLines } from '../src/quality.js';
import { plannedTrials } from '../src/run.js';
import { libraryHash } from '../src/scenario-library.js';
import { sameTargetVersion } from '../src/target-version.js';
import { safeText } from '../src/text.js';
import { ProgressRow, RUN_MESSAGE, STOP_HINT } from './background.ts';
import { agentLine, progressText, row, runStamp, runWhen, stoppedLines } from './conversation.ts';
import type { LabHost } from './host.ts';
import { ask, displayFor, NeedsOwner, requireInteractive } from './lab-ui.ts';
import { cardPlan, launchRun } from './launch.ts';
import { summary } from './summary.ts';

/*
 * Starting, accepting and repeating a set (ui-spec §4.6): one native dialog starts a run — accepting a card draft's
 * ready situations in the same dialog —, a long run continues in the session and its result arrives as a message,
 * progress and stop are requests of their own. Nothing here starts a run without the owner's pick in that dialog.
 */

const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];

export function registerRunTools(pi: ExtensionAPI, host: LabHost): void {
  const { operations, open, reading, findRun, focus, feedResult, askOwner } = host;
  pi.registerTool({
    ...displayFor('agent_lab_accept'),
    name: 'agent_lab_accept', label: 'Confirm what the agent must do',
    description: "Accept the ready situations of a draft for a run without running it (agent_lab_run accepts them itself in the same dialog that starts the run); for a draft of a record made before situations, show what the agent must do in each and record the owner's confirmation. The consent comes from a native Pi dialog only; the model never supplies it. It never runs the agent or calls a model.",
    parameters: Type.Object({ id: Type.String({ pattern: identifierPattern }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      requireInteractive(ctx, 'Утвердить ситуации можно в интерактивном терминале Pi. В CLI: accept --id RUN --yes.');
      signal?.throwIfAborted();
      const { lab, close } = await open(ctx.cwd);
      try {
        await lab.init();
        const record = await lab.get(params.id);
        const note = `Утверждение · ${runStamp(record)}`;
        if (record.librarySnapshot?.formatVersion === 2 && record.phase === 'review') {
          const context = await lab.cardContext(record.id);
          const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
          const ready = views.filter(view => view.status === 'ready');
          if (!ready.length) return askOwner(callId, new NeedsOwner('needs_owner_input', 'Утверждать нечего: ни одна ситуация не готова. Покажите владельцу вопросы по ситуациям.', [], 'Утверждать нечего: ни одна ситуация ещё не готова.'));
          const plan = cardPlan(context.experiment, views);
          if (!await ask(ctx, `Утвердить ${countText(ready.length, ['ситуацию', 'ситуации', 'ситуаций'])} для прогона?`,
            [...ready.map(view => `${view.number}  ${view.brief.title}`), '', 'Агент сейчас не запускается; запуск — отдельно.'], 'Утвердить')) {
            return feedResult(callId, { accepted: false, message: 'The owner did not accept. Nothing changed.' }, { tone: 'warning', rows: [row('Не утверждено; агент не запускался.')] }, note);
          }
          const accepted = await lab.acceptCards(record.id, libraryHash(context.library), ready.map(view => view.id));
          return feedResult(callId, { accepted: true, id: record.id, situations: ready.map(view => view.number), draftHash: draftHash(accepted.experiment) },
            { rows: [row(`Утверждено ${countText(ready.length, ['ситуация', 'ситуации', 'ситуаций'])}; агент не запускался.`, 'text', true),
              row(`Прогон: ${countText(plan.conversations, CONVERSATIONS)} — скажите «запусти».`, 'muted')] }, note);
        }
        // A set of more than one situation is confirmed as one sheet; one test keeps its own definition.
        const multiple = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1;
        const sheet = multiple ? expectationSheet(record) : undefined;
        const projection = multiple ? undefined : testPlanLines(record);
        const hash = sheet?.draftHash ?? projection!.draftHash;
        signal?.throwIfAborted();
        const confirmed = sheet
          ? await ask(ctx, `Подтвердить ожидания: ${sheet.countText}?`, sheet.compactLines(), 'Подтвердить все')
          : await ask(ctx, projection!.lines.at(-1)!, projection!.lines.slice(0, -2), 'Подтвердить');
        if (!confirmed) return feedResult(callId, { id: record.id, accepted: false, draftHash: hash, message: 'Ожидания не подтверждены. Прогон не начнётся, пока они не подтверждены.', ...(sheet ? { sheetLines: sheet.lines } : {}) },
          { tone: 'warning', rows: [row('Ожидания не подтверждены; агент не запускался.')] }, note);
        signal?.throwIfAborted();
        const accepted = await lab.acceptDraft(record.id, hash);
        return feedResult(callId, { id: accepted.id, accepted: true, draftHash: hash, acceptedDraftHash: accepted.acceptedDraftHash,
          message: 'Ожидания подтверждены. Можно запускать.', ...(sheet ? { sheetLines: expectationSheet(accepted).lines } : {}) },
          { rows: [row(`Ожидания подтверждены${sheet ? `: ${sheet.countText}` : ''}; агент не запускался — скажите «запусти».`, 'text', true)] }, note);
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_repeat'),
    name: 'agent_lab_repeat', label: 'Prepare another run of the same cards',
    description: 'Copy a previously approved evaluation into a fresh draft without model generation: the way to check a new agent version on the same cards. Preserves cards, materials and settings, captures current local code identity, clears results and approvals; the source run is kept. scenarios names the cards to repeat by title or number; omit for the whole set. Then use agent_lab_run, and agent_lab_inspect compare:true for before/after.',
    parameters: Type.Object({ id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run to repeat: id, short id or words of its task. Omit for the run this conversation works on.' })),
      scenarios: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 40, description: 'Cards to repeat, by title or number in the run. Omit for the whole set.' })),
      scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40, description: 'Repeat only these existing tests by exact id; omit for the whole regression set.' })),
      controlScenarioIds: Type.Optional(Type.Array(Type.String({ pattern: identifierPattern }), { minItems: 1, maxItems: 5, description: 'Mark existing situations as positive controls: real dialogues the agent is known to handle. They are shown apart and never enter the headline number. Each control runs as one turn (the opening and the agent\'s first reply, no simulator), so simulator drift cannot hide a broken judge or connection; controls are left out of the repeat diff.' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const source = await findRun(directory, params.id, ctx);
        const titles = source.scenarios.map((item, index) => `${index + 1}. ${safeText(item.title)}`);
        const chosen = params.scenarioIds ?? params.scenarios?.map(ref => {
          const wanted = ref.trim().toLocaleLowerCase('ru');
          const matches = /^#?\d+$/.test(wanted) ? [source.scenarios[Number(wanted.replace('#', '')) - 1]].filter(item => !!item)
            : source.scenarios.filter(item => item.id === ref || item.title.toLocaleLowerCase('ru').includes(wanted));
          if (matches.length !== 1) throw new NeedsOwner(matches.length ? 'ambiguous_reference' : 'unknown_reference',
            matches.length ? `«${ref}» подходит к нескольким ситуациям. Спросите владельца, какая нужна.` : `Ситуации «${ref}» в этом прогоне нет.`, titles.slice(0, 15));
          return matches[0]!.id;
        });
        const { lab, close } = await open(ctx.cwd);
        try {
          await lab.init();
          const record = await lab.repeat(source.id, chosen, params.controlScenarioIds);
          focus.set(directory, record.id);
          const moved = !!source.targetFingerprint && !!record.targetFingerprint && !sameTargetVersion(source.targetFingerprint, record.targetFingerprint);
          const feed = { rows: [row(`Повтор готов: ${record.scenarios.length} из ${countText(source.scenarios.length, SITUATIONS)} прогона ${runWhen(source)}; исходный прогон сохранён.`, 'text', true),
            row(moved ? 'Код агента изменился — проверяется новая версия.' : 'Код агента с прошлого прогона не менялся.', moved ? 'accent' as const : 'muted' as const),
            row('Ожидания те же; после запуска результат сравнится с исходным прогоном. Скажите «запусти».', 'muted')],
            more: record.scenarios.map((item, index) => row(`${index + 1}  ${safeText(item.title)}`)), expand: 'ситуации повтора' };
          return feedResult(callId, { ...summary(record, lab.store.directory), sourceRunId: source.id, agentCodeChanged: moved }, feed, `Повтор · ${runStamp(record)}`);
        } finally { await close(); }
      } catch (error) { return askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_run'), name: 'agent_lab_run', label: 'Run the accepted set',
    description: 'start (default): run the accepted set of one run after a native confirmation of the exact plan shown: agent and version, set, attempts, models and spending limits. A short run ends in this row; a long one continues in the background, the conversation stays free and the result arrives as a message. progress: read the current run, preparation or semantic assessment from this session’s live executor or stored data. stop: stop the run, preparation or semantic assessment of this session and keep what is recorded; only when the owner asks. Does not record human review of expectations or results. Cannot run headlessly or without the human confirmation. Never bypass this tool through shell or internal APIs.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the run this conversation works on.' })),
      action: Type.Optional(Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('progress')])),
      expectedHash: Type.Optional(Type.String({ pattern: sha256Pattern, description: 'Optional: refuse when the draft differs from the one you inspected. The confirmation always refers to the state it shows.' })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const action = params.action ?? 'start';
      const directory = resolve(ctx.cwd, '.agent-lab');
      const job = operations.current(directory);
      try {
        if (action === 'progress') {
          // A named run is answered about that run; only a request without a reference means «the one going on now».
          const named = params.id ? await findRun(directory, params.id, ctx) : undefined;
          const record = job && (!named || named.id === job.id) ? await job.lab.get(job.id) : named ?? await findRun(directory, undefined, ctx);
          const running = isRunning(record.phase);
          const note = `Прогресс · ${runStamp(record)}`;
          if (job?.kind === 'assessment' && job.id === record.id) {
            return feedResult(callId, { id: record.id, operationId: job.operationId, operationKind: job.kind, phase: record.phase,
              running, assessment: true, preparation: false, ownedByThisSession: true, usage: record.usage, maxCalls: record.settings.maxCalls,
              instruction: 'The check of changed situations is active in this session. Its result will arrive as a message; stop cancels it and keeps the draft. Do not poll.' },
              { rows: [row('Проверяю изменённые ситуации в фоне; итог придёт сообщением.', 'text', true)] }, note);
          }
          const preparing = record.phase === 'preparing';
          const unusable = record.trials.filter(trial => trial.outcome === 'invalid' || trial.outcome === 'cancelled').length;
          const feed = { rows: running ? [row(progressText(record), 'text', true), row(`Идёт в фоне; ${STOP_HINT}.`, 'muted')] : [row(`Сейчас ничего не идёт: ${runWhen(record)} — ${record.trials.length ? 'прогон завершён' : 'черновик'}.`, 'muted')] };
          if (preparing) return feedResult(callId, { id: record.id, phase: record.phase, running, preparation: true, ownedByThisSession: !!job && job.id === record.id, usage: record.usage, maxCalls: record.settings.maxCalls,
            ...(job?.id === record.id ? { instruction: 'The preparation continues in the background; its result will arrive as a message. Do not poll.' } : {}) }, feed, note);
          return feedResult(callId, { id: record.id, phase: record.phase, running, ownedByThisSession: !!job && job.id === record.id, finishedDialogues: record.trials.length, plannedDialogues: plannedTrials(record), unusable, usage: record.usage, maxCalls: record.settings.maxCalls },
            feed, note);
        }
        if (action === 'stop') {
          if (!job) throw new Error('В этой сессии ничего не идёт: ни прогона, ни подготовки, ни проверки. Работу другой сессии Pi останавливают там.');
          const preparation = job.kind === 'preparation';
          const assessment = job.kind === 'assessment';
          const going = assessment ? 'проверка ситуаций' : preparation ? 'подготовка ситуаций' : 'прогон';
          // The run the owner named must be the one that is going: another run is never stopped in its place.
          if (params.id) {
            const named = await findRun(directory, params.id, ctx);
            if (named.id !== job.id) throw new NeedsOwner('needs_owner_input', `Назван прогон ${runWhen(named)}, а сейчас идёт ${going} ${runWhen(await reading(directory).get(job.id))}. Ничего не остановлено. Спросите владельца, останавливать ли идущую работу.`, [],
              `Вы назвали прогон ${runWhen(named)}, а сейчас идёт ${going}. Я ничего не остановил — остановить её?`);
          }
          await operations.stop(job);
          const record = await reading(directory).get(job.id);
          const note = `Остановлено · ${runStamp(record)}`;
          if (assessment) {
            const message = 'Проверка ситуаций остановлена. Правки и уже проверенное сохранены; остальное можно проверить позже.';
            return feedResult(callId, { id: record.id, operationId: job.operationId, operationKind: job.kind, phase: record.phase, stopped: true, usage: record.usage, message },
              { tone: 'warning', rows: [row(message)] }, note);
          }
          if (preparation) {
            const cards = record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : 0;
            const saved = [record.error ? 'Подготовка остановлена.' : 'Подготовка успела завершиться до остановки.',
              cards ? `Сохранено ${countText(cards, SITUATIONS)}: их можно смотреть и менять, подготовку — продолжить с того же места.` : 'Ситуации собрать не успели; записанное сохранено.'];
            return feedResult(callId, { id: record.id, phase: record.phase, stopped: true, savedSituations: cards, savedRequirements: record.requirements.length, usage: record.usage, message: saved.join(' ') },
              { tone: 'warning', rows: [row(saved[0]!, 'text', true), row(saved[1]!, 'muted')] }, note);
          }
          const lines = stoppedLines(record);
          return feedResult(callId, { id: record.id, phase: record.phase, stopped: true, savedDialogues: record.trials.length, plannedDialogues: plannedTrials(record), message: lines.join(' ') },
            { tone: 'warning', rows: [row(lines[0]!, 'text', true), row(lines[1]!, 'muted')] }, note);
        }
        requireInteractive(ctx, 'Запуск подтверждается в интерактивном терминале Pi. В CI: evaluate --input suite.json --yes с явным бюджетом.');
        const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
        signal.throwIfAborted();
        const found = await findRun(directory, params.id, ctx);
        focus.set(directory, found.id);
        const owned = await open(ctx.cwd, 'wait');
        let detached = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let polling: Promise<void> = Promise.resolve();
        const progressRow = new ProgressRow(ctx, RUN_MESSAGE);
        try {
          await owned.lab.init();
          const draft = await owned.lab.get(found.id);
          if (draft.workflow !== 'evaluate' || (params.expectedHash && params.expectedHash !== draftHash(draft))) throw new Error('План изменился. Прочитайте актуальный черновик через agent_lab_inspect.');
          if (draft.phase !== 'review') throw new Error(isRunning(draft.phase) ? 'Этот прогон уже идёт.'
            : 'Этот прогон уже выполнен, его результат не меняется. Чтобы проверить снова, подготовьте повтор (agent_lab_repeat).');
          // Nothing has started yet: an Esc before the dialog ends the action.
          signal.throwIfAborted();
          // One native dialog: a card draft is accepted with its ready situations as it starts; an unconnected agent is connected first.
          const started = await launchRun(ctx, owned.lab, draft);
          if (!started) {
            const output = { id: draft.id, cancelled: true, message: 'Запуск отменён. Ситуации сохранены; не повторяйте запрос запуска без новой просьбы пользователя.' };
            return feedResult(callId, output, { tone: 'warning', rows: [row('Не запускаю: вы отказались. Ситуации сохранены, агент не запускался.')] }, `Запуск · ${runStamp(draft)}`);
          }
          // The run has started: from here an Esc, even one pressed while it was starting, hands it to the session.
          const progress = async () => {
            const current = await owned.lab.get(draft.id);
            progressRow.show(progressText(current));
            onUpdate?.({ content: [{ type: 'text', text: safeText(progressText(current)) }], details: { id: current.id } });
          };
          await progress();
          timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
          // A short run ends in this row. A long one, or Esc, hands the run to the session: interrupting the action never stops the run.
          const inline = await new Promise<boolean>(settle => {
            const wait = setTimeout(() => settle(false), host.inlineRunMs);
            const onAbort = () => settle(false);
            if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
            void owned.lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(wait); signal.removeEventListener('abort', onAbort); });
          });
          clearInterval(timer); timer = undefined; await polling; progressRow.clear();
          if (!inline) {
            const record = await owned.lab.get(draft.id);
            detached = true;
            host.background.detach(ctx, owned, draft.id, 'chat');
            return feedResult(callId, { id: draft.id, background: true, phase: record.phase, finishedDialogues: record.trials.length, plannedDialogues: plannedTrials(record),
              instruction: 'The run continues in the background and its result will arrive as a message. Tell the owner in one short sentence and end your turn; do not poll. Reads (scenarios, recorded dialogues) still work; edits and new runs wait until it ends.' },
              { rows: [row(`Прогон идёт: ${countText(plannedTrials(record), CONVERSATIONS)} с агентом ${agentLine(record, ctx.cwd)}. Результат придёт сюда сообщением.`, 'text', true),
                row(`Разговор свободен; ${STOP_HINT}.`, 'muted')] }, `Прогон · ${runStamp(record)}`);
          }
          // `content` stays the model's JSON; the session holds ids only (REV-01): the block is drawn from the remembered view.
          const { output, details } = await host.verdictOutput(await owned.lab.get(draft.id), owned.lab);
          return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details };
        } finally {
          clearInterval(timer); await polling;
          if (!detached) { progressRow.clear(); await owned.close(); }
        }
      } catch (error) { return askOwner(callId, error); }
    },
  });
}
