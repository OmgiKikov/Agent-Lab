import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { hostGrant } from '../src/card/commands.js';
import type { CardCommand } from '../src/card/schema.js';
import { situationViews, type SituationAction, type SituationView } from '../src/card/view.js';
import type { Experiment, HumanReviewInput } from '../src/contracts.js';
import { awaitingVerdict } from '../src/comparison.js';
import { judgeAgreement } from '../src/agreement.js';
import { demoInput } from '../src/demo.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { ExperimentLab, resultHash } from '../src/experiment.js';
import { expectationSheet } from '../src/quality.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardVerdict, headlineCardOutcome } from '../src/run.js';
import { safeText } from '../src/text.js';
import { reviewOrder, showBoard, type BoardAction, type BoardOptions, type Section } from './cards.ts';
import { boardDiscussionContext, inputError, requireInteractive } from './lab-ui.ts';
import { launchRun } from './launch.ts';
import type { LabLease, SessionOperation, SessionOperations } from './operations.ts';
import { scenarioErrorText } from './scenarios.ts';

/*
 * The /agent-lab board: the loop that shows the board, takes the owner's action and does it through the same
 * ExperimentLab operations the chat uses. A situation's numbered action becomes a typed command here, in native
 * dialogs — a key press or a pick is the owner's confirmation, text they type is their own words; what needs
 * words about a new situation or a rule goes to the conversation. The board never holds the only copy of state.
 */

export interface BoardHost {
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  operations: SessionOperations;
  detach: (ctx: ExtensionContext, directory: string, owned: LabLease, id: string, origin: SessionOperation['origin']) => SessionOperation;
  backgroundPreparation: (ctx: ExtensionContext, owned: LabLease, id: string) => void;
  backgroundCheck: (ctx: ExtensionContext, owned: LabLease, id: string, card: number | undefined) => void;
}

export async function humanAnnotation(ctx: ExtensionContext, record: Experiment, selected: number, readingMs = 0, reviewTimes?: Map<string, number>): Promise<HumanReviewInput[] | undefined> {
  const started = performance.now();
  const trial = reviewOrder(record)[selected];
  if (!trial) return;
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const targets: { label: string; ids: { metricId?: string; checkId?: string } }[] = [
    { label: 'Весь диалог', ids: {} },
    ...(scenario?.metrics ?? []).map(m => ({ label: `Критерий · ${safeText(m.name)} [${m.id}]`, ids: { metricId: m.id } })),
    ...(trial.simulatorChecks ?? []).map(c => ({ label: `Симулятор · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id } })),
    ...trial.checks.map(c => ({ label: `Проверка · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id } })),
  ];
  const choice = await ctx.ui.select('Область вашей оценки', targets.map(t => t.label));
  const target = targets.find(t => t.label === choice);
  if (!target) return;
  const simulator = !!target.ids.checkId && trial.simulatorChecks?.some(c => c.id === target.ids.checkId) || !!target.ids.metricId && scenario?.metrics?.some(m => m.id === target.ids.metricId && m.subject === 'simulator');
  const choices = [{ value: 'fail', label: simulator ? 'Ошибся симулятор' : 'Ошибся агент' }, { value: 'invalid', label: 'Ошибся тест' }, { value: 'unknown', label: 'Данных недостаточно' }, { value: 'pass', label: simulator ? 'Симулятор соблюдает карточку' : 'Агент выполнил задачу' }] as const;
  const answer = await ctx.ui.select(`Диалог ${trial.id} · исходная оценка сохранится`, choices.map(v => v.label));
  const verdict = choices.find(v => v.label === answer)?.value;
  if (!verdict) return;
  const note = await ctx.ui.editor('Пояснение · укажите реплики # и причину согласия или ошибки', '');
  if (note === undefined) return;
  const wholeDialogue = !target.ids.metricId && !target.ids.checkId;
  if (wholeDialogue && ![...note.matchAll(/#(\d+)\b/g)].some(match => trial.events.some(event => event.seq === Number(match[1])))) {
    ctx.ui.notify?.('Полный разбор отменён: в пояснении укажите номер события из этого диалога, например #1.', 'warning');
    return;
  }
  return [{ trialId: trial.id, ...target.ids, verdict, note, ...(wholeDialogue ? { reviewedDialogue: true as const } : {}),
    durationMs: Math.min(3600000, Math.round(performance.now() - started + (reviewTimes?.get(`${record.id}|${trial.id}`) ?? readingMs))) }];
}


const WHEN = { 'сразу': 'initial', 'если спросят': 'on_request', 'не знает': 'unknown' } as const;
const WHEN_CHOICES = ['сразу', 'если спросят', 'не знает'] as const;

/** One field of a situation the owner rewrites in their own words, in a native editor. */
async function ownWords(ctx: ExtensionCommandContext, title: string, current: string): Promise<string | undefined> {
  const text = (await ctx.ui.editor(title, current))?.trim();
  return text && text !== current ? text : undefined;
}

/**
 * «Изменить» (ui-spec §4.5): a native menu of what to change, then the change itself — the customer's words and
 * the duties in the owner's own words, what the customer knows as the owner's pick.
 */
async function editCommand(ctx: ExtensionCommandContext, view: SituationView): Promise<{ command: CardCommand; words?: string } | undefined> {
  const { brief } = view;
  const menu = ['Что клиент пишет', 'Что клиент хочет', 'Что клиент знает и когда скажет', 'Что агент должен', 'Когда клиент уходит'];
  const picked = await ctx.ui.select(`Что изменить в ситуации ${view.number}?`, menu);
  const client = (field: 'writes' | 'wants' | 'leaves', title: string, current: string) => ownWords(ctx, title, current)
    .then(text => text === undefined ? undefined : { command: { kind: 'edit_client', cardId: view.id, [field]: text } as CardCommand, words: text });
  if (picked === menu[0]) return client('writes', 'Первая реплика клиента · дословно', brief.writes);
  if (picked === menu[1]) return client('wants', 'Чего хочет клиент', brief.wants);
  if (picked === menu[4]) return client('leaves', 'Когда клиент уходит', brief.leaves ?? '');
  if (picked === menu[3]) {
    const duties = brief.must.map((duty, index) => `${index + 1}  ${duty.text}`);
    const index = duties.length === 1 ? 0 : duties.indexOf(await ctx.ui.select('Какое ожидание изменить?', duties) ?? '');
    const expectationId = view.refs.must[index];
    if (index < 0 || !expectationId) return undefined;
    const text = await ownWords(ctx, 'Что агент должен · своими словами', brief.must[index]!.text);
    return text === undefined ? undefined : { command: { kind: 'edit_expectation', cardId: view.id, expectationId, text }, words: text };
  }
  if (picked !== menu[2]) return undefined;
  const facts = brief.knows.flatMap((fact, index) => view.refs.knows[index] ? [{ id: view.refs.knows[index]!, label: `${fact.what} — ${fact.when}` }] : []);
  const add = 'Добавить факт';
  const factPick = await ctx.ui.select('Какой факт?', [...facts.map(fact => fact.label), add]);
  if (factPick === add) {
    const label = (await ctx.ui.editor('Что знает клиент · например «Номер терминала»', ''))?.trim();
    const value = label && (await ctx.ui.editor('Значение · оставьте пустым, если его нет', ''))?.trim();
    const when = label && await ctx.ui.select('Когда клиент это скажет?', [...WHEN_CHOICES]);
    if (!label || value === undefined || !when) return undefined;
    return { command: { kind: 'set_fact', cardId: view.id, label, ...(value ? { value } : {}), disclosure: WHEN[when as keyof typeof WHEN] } };
  }
  const fact = facts.find(item => item.label === factPick);
  if (!fact) return undefined;
  const remove = 'Убрать факт';
  const when = await ctx.ui.select('Когда клиент это скажет?', [...WHEN_CHOICES, remove]);
  if (!when) return undefined;
  return { command: when === remove ? { kind: 'remove_fact', cardId: view.id, factId: fact.id }
    : { kind: 'set_fact_disclosure', cardId: view.id, factId: fact.id, disclosure: WHEN[when as keyof typeof WHEN] } };
}

/** The command a numbered action of a situation stands for; undefined when the owner stepped back. */
async function situationCommand(ctx: ExtensionCommandContext, action: SituationAction, view: SituationView): Promise<{ command: CardCommand; words?: string } | undefined> {
  if (action.kind === 'answer') {
    const { choice } = action;
    const question = view.question;
    if (!question?.id) return undefined;
    const text = choice.needsText ? (await ctx.ui.editor(`${choice.label} — своими словами`, choice.command.kind === 'edit_client' ? choice.command.wants ?? choice.command.writes ?? ''
      : choice.command.kind === 'edit_expectation' ? choice.command.text ?? '' : ''))?.trim() : undefined;
    if (choice.needsText && !text) return undefined;
    return { command: { kind: 'answer_question', cardId: view.id, questionId: question.id, choice: choice.id, ...(text ? { text } : {}) }, ...(text ? { words: text } : {}) };
  }
  if (action.kind === 'remove') {
    const picked = await ctx.ui.select(safeText(`Убрать ситуацию ${view.number} «${view.brief.title}» из черновика?\nРазговоры из логов и прошлые прогоны не тронуты.`), ['Убрать', 'Не сейчас']);
    return picked === 'Убрать' ? { command: { kind: 'remove_card', cardId: view.id } } : undefined;
  }
  return action.kind === 'edit' ? editCommand(ctx, view) : undefined;
}

/** The situations of a record with their status now, for the board. */
async function boardSituations(lab: ExperimentLab, record: Experiment): Promise<SituationView[]> {
  if (record.librarySnapshot?.formatVersion !== 2) return situationViews(record, { maxTurns: record.settings.maxTurns });
  const context = await lab.cardContext(record.id);
  return situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
}

/** The /agent-lab board command. */
export function registerBoardCommand(pi: ExtensionAPI, host: BoardHost): void {
  const { open, operations, detach, backgroundPreparation, backgroundCheck } = host;
  pi.registerCommand('agent-lab', {
    description: 'Проверить агента: /agent-lab, /agent-lab demo или /agent-lab /путь/к/проекту',
    async handler(args, ctx) {
      requireInteractive(ctx, 'Human review requires the native Pi terminal. Start interactive Pi and open /agent-lab. Headless tools only prepare and edit drafts.');
      const startRequest = args.trim() === 'new' || args.trim().startsWith('/') || args.trim().startsWith('~');
      let handoff: { request: string; context: unknown } | undefined;
      // Opening history is a read, not a writer operation. In particular, never call init()
      // here: it acquires the lock and recovers running records as interrupted.
      const directory = resolve(ctx.cwd, '.agent-lab');
      const reader = operations.reader(directory);
      let lab = reader;
      let lease: Awaited<ReturnType<typeof open>> | undefined;
      const reading = () => operations.reader(directory);
      const release = async () => {
        const owned = lease; lease = undefined; lab = reader;
        if (owned) await owned.close();
      };
      const writing = async (pendingCheck: 'cancel' | 'wait' = 'cancel') => {
        if (lease) return;
        const owned = await open(ctx.cwd, pendingCheck);
        try { await owned.lab.init(); lease = owned; lab = owned.lab; }
        catch (error) { await owned.close(); throw error; }
      };
      try {
        let id = startRequest || args.trim() === 'demo' ? undefined : args.trim() || undefined;
        if (id) {
          const candidates = (await reading().list()).filter(record => record.id === id || record.id.startsWith(id!));
          const exact = candidates.find(record => record.id === id);
          if (exact) id = exact.id;
          else if (candidates.length === 1) id = candidates[0]!.id;
          else throw new Error(candidates.length ? 'Нашлось несколько прогонов. Откройте /agent-lab и выберите нужный.' : 'Прогон не найден. Откройте /agent-lab, чтобы посмотреть историю.');
        }
        let section: Section | undefined;
        let selected = 0;
        let query = '';
        let pendingOnly = false;
        let dialogueOpen = false;
        let beforeId: string | undefined;
        let newRequested = startRequest;
        let demoRequested = args.trim() === 'demo';
        let reportPath: string | undefined;
        // Elapsed time with the dialogue visible plus its verdict form, including time spent idle.
        const reviewTimes = new Map<string, number>();
        let notice: BoardOptions['notice'];
        const inform = (message: string, kind: 'success' | 'info' | 'error' = 'success') => {
          notice = { message: safeText(message), kind };
        };
        while (true) {
          const record = id ? await reading().get(id) : undefined;
          const bundle = record ? await evidenceBundle(record, reader.store, beforeId) : undefined;
          const situations = record ? await boardSituations(reading(), record) : undefined;
          const job = record && operations.current(directory);
          const action: BoardAction = demoRequested ? { type: 'demo' } : newRequested ? { type: 'new' } : await showBoard(ctx, record
            ? { record, section, selected, query, pendingOnly, dialogueOpen, comparison: bundle?.comparison, before: bundle?.before, notice, reportPath, reviewTimes,
                warnings: bundle?.warnings, view: bundle?.view, situations, checking: job?.kind === 'assessment' && job.id === record.id,
                load: async () => {
                  const fresh = await reading().get(record.id);
                  return { ...await evidenceBundle(fresh, reader.store, beforeId), situations: await boardSituations(reading(), fresh) };
                } }
            : { records: await reading().list(), loadRecords: () => reading().list(), notice, warnings: reader.store.diagnostics.map(d => `${d.id}: ${d.message}`) });
          notice = undefined;
          if ('record' in action && (action.record.updatedAt !== record?.updatedAt || action.record.phase !== record?.phase)) reportPath = undefined;
          if (action.type === 'demo') {
            demoRequested = false;
            try {
              await writing();
              const draft = await lab.create(demoInput(), { cards: true });
              await lab.waitForIdle();
              id = draft.id; section = 'cards'; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined;
              inform('Учебный пример: агент переспрашивает уже названный номер терминала. Ответьте на вопрос ситуации 2 и запустите готовые. Модель и провайдер не нужны.');
            } catch (error) { inform(inputError(error), 'error'); }
            finally { await release(); }
            continue;
          }
          if (action.type === 'new') {
            const request = newRequested && args.trim() !== 'new' ? `Проверь агента в ${args.trim()}`
              : await ctx.ui.editor('Папка агента и что проверить · своими словами', '');
            newRequested = false;
            if (!request?.trim()) continue;
            handoff = { request, context: { task: 'Prepare a new Agent Lab draft. Ask once for optional real dialogue logs or an explicit choice to start without them; honor the answer already given in this conversation. Read the authorized local agent project and relevant materials; infer or prepare its adapter. Use agent_lab_build, then explain the situations found in plain language and use agent_lab_run when the user asked to check the agent. Do not claim human review. Follow the agent-builder skill.' } };
            break;
          }
          if (action.type === 'open') { id = action.id; section = undefined; selected = 0; query = ''; pendingOnly = false; dialogueOpen = false; beforeId = undefined; reportPath = undefined; continue; }
          if (action.type === 'close' || action.type === 'back') {
            // Navigating away is not cancellation. The session owns a started run until
            // completion (or Pi shutdown), independently of this board's lifetime.
            if (action.type === 'close') break;
            id = undefined; section = undefined; selected = 0; query = ''; pendingOnly = false; dialogueOpen = false; beforeId = undefined; reportPath = undefined; continue;
          }
          section = action.section; selected = action.selected;
          query = 'query' in action ? action.query ?? '' : ''; pendingOnly = 'pendingOnly' in action ? action.pendingOnly ?? false : false;
          dialogueOpen = 'dialogueOpen' in action ? action.dialogueOpen ?? false : false;
          try {
            if (!['discuss', 'export', 'openReport', 'cancel', 'situation'].includes(action.type)) await writing(action.type === 'run' ? 'wait' : 'cancel');
            if (action.type === 'situation') {
              const { action: chosen, situation } = action;
              if (chosen.kind === 'similar' || chosen.kind === 'rule') {
                // A new situation or a missing rule is said in words: the request goes to the conversation, where the model builds the command and the owner confirms it.
                const request = (await ctx.ui.editor(chosen.kind === 'similar' ? `Чем похожая отличается от ситуации ${situation.number}? Например: клиент не знает номер`
                  : `Какое правило решает ситуацию ${situation.number}? Своими словами или файл с правилами`, ''))?.trim();
                if (!request) continue;
                handoff = { request: `${chosen.kind === 'similar' ? `Добавь ситуацию, похожую на ${situation.number}` : `Для ситуации ${situation.number} нужно правило`}: ${request}`,
                  context: boardDiscussionContext(action.record, action.section, situation) };
                break;
              }
              const decided = await situationCommand(ctx, chosen, situation);
              if (!decided) continue;
              await writing();
              const prepared = await lab.prepareCardCommand(action.record.id, decided.command, { via: 'board', ...(decided.words ? { ownerWords: decided.words } : {}) });
              // The key press and the pick in the native dialog are the owner's decision; text they typed is their own words.
              await lab.applyCardCommand(action.record.id, prepared, hostGrant(prepared, decided.words ? 'words' : 'confirmed'));
              const check = await lab.recheckCards(action.record.id);
              if (check.decision.action === 'run' && lease) {
                backgroundCheck(ctx, lease, action.record.id, decided.command.kind === 'remove_card' ? undefined : situation.number);
                lease = undefined; lab = reader;
                inform(`Ситуация ${situation.number}: записано. Проверяю её в фоне — итог появится здесь и в чате.`);
              } else inform(check.decision.action === 'needs_budget' ? `Записано. Чтобы проверить ситуацию, нужно вызовов модели: ${check.decision.pendingJobs}, осталось ${check.decision.remainingCalls}.`
                : decided.command.kind === 'remove_card' ? `Ситуация ${situation.number} убрана из черновика.` : `Ситуация ${situation.number}: записано.`, check.decision.action === 'needs_budget' ? 'info' : 'success');
            } else if (action.type === 'checkCards') {
              const check = await lab.recheckCards(action.record.id, { explicit: true });
              if (check.decision.action === 'run' && lease) { backgroundCheck(ctx, lease, action.record.id, undefined); lease = undefined; lab = reader; inform('Проверяю ситуации в фоне — итог появится здесь и в чате.'); }
              else inform('Проверять нечего: все ситуации проверены.', 'info');
            } else if (action.type === 'resumePreparation') {
              if (!lease || !action.record.librarySnapshot) throw new Error('Нет сохранённой подготовки, которую можно продолжить.');
              await lab.resumePreparation(action.record.id, libraryHash(action.record.librarySnapshot));
              backgroundPreparation(ctx, lease, action.record.id); lease = undefined; lab = reader;
              inform('Продолжаю подготовку с сохранённого места. Итог появится в чате.');
            } else if (action.type === 'discuss') {
              const r = action.record;
              const request = await ctx.ui.editor(r.phase === 'review' ? 'Что изменить или уточнить? · обычными словами' : 'Что разобрать вместе с Pi?',
                r.phase === 'review' ? '' : 'Объясни, что сломалось, на каких репликах это видно и что делать дальше.');
              if (!request?.trim()) continue;
              const discussionBundle = action.trialId ? await evidenceBundle(r, lab.store, beforeId) : undefined;
              const comparedPair = discussionBundle?.comparison?.pairs.find(pair => pair.afterTrialId === action.trialId);
              handoff = { request, context: { ...boardDiscussionContext(r, action.section, (await boardSituations(lab, r))[action.selected]), trialId: action.trialId,
                ...(comparedPair ? { comparisonSource: discussionBundle?.comparisonSource, comparedPair } : {}) } };
              break;
            } else if (action.type === 'repeat') {
              const next = await lab.repeat(action.record.id);
              beforeId = action.record.id; id = next.id; section = 'cards'; selected = 0; query = ''; pendingOnly = false; dialogueOpen = false; reportPath = undefined;
              inform(`Создан повтор того же набора: ${next.scenarios.length} ситуаций. Исходный прогон сохранён. r — запуск.`);
            } else if (action.type === 'run') {
              const r = await lab.get(action.record.id);
              if (r.workflow !== 'evaluate') throw new Error('Старый сравнительный эксперимент с доски не запускается.');
              // One native dialog: a draft of cards is accepted with its ready situations as it starts.
              if (await launchRun(ctx, lab, r)) {
                // The session owns the run from here: leaving the board, or the conversation going on, never stops it.
                const owned = lease!;
                lease = undefined; lab = reader;
                detach(ctx, directory, owned, r.id, 'board');
                section = 'results'; selected = 0;
                reportPath = undefined;
              }
            } else if (action.type === 'accept') {
              // TRUST-10: one key confirms every expectation of the shown draft version, and only that version.
              const r = await lab.get(action.record.id);
              const sheet = expectationSheet(r);
              if (r.acceptedDraftHash === sheet.draftHash) inform('Ожидания уже подтверждены. r — запуск.', 'info');
              else {
                await lab.acceptDraft(r.id, sheet.draftHash);
                inform(`Ожидания подтверждены: ${sheet.countText}. r — запуск.`);
              }
              section = 'cards';
            } else if (action.type === 'cancel') {
              const job = operations.current(directory);
              if (!job || job.directory !== directory || job.id !== action.record.id) {
                throw new Error('Этот прогон запущен в другой сессии. Здесь доступен просмотр; остановите его в сессии, которая его запустила.');
              }
              if (!await ctx.ui.confirm(job.kind === 'assessment' ? 'Остановить проверку ситуаций?' : job.kind === 'preparation' ? 'Остановить подготовку?' : 'Остановить прогон?', 'Текущая работа остановится. Уже записанные ситуации, проверки и разговоры сохранятся. Для возврата в историю останавливать работу не нужно.')) continue;
              await operations.stop(job);
              reportPath = undefined;
            } else if (action.type === 'agree') {
              // CTX-18: a mark exists only because the owner pressed a key here, and a disagreement
              // only because they typed a reason into the native editor. No tool writes one.
              const before = await lab.get(action.record.id);
              const current = judgeAgreement(before).marks.find(m => m.trialId === action.trialId && !m.stale);
              const card = before.scenarios.find(s => s.id === before.trials.find(t => t.id === action.trialId)?.scenarioId);
              const title = card?.title ?? '';
              // CTX-15: one key answers every metric that decided the situation, goal first (markTargets).
              const ids = action.metricIds;
              const failed = action.judgeVerdict === 'fail';
              const started = performance.now();
              let disagreeIds = ids;
              let note: string;
              if (action.answer === 'disagree') {
                // CTX-16/CTX-25: only a disagreement moves the number, so only «не согласен» on two
                // metrics asks which half the owner disputes; Esc saves nothing and says nothing.
                if (ids.length > 1) {
                  const options = failed
                    ? ['Запрос выполнен — судья ошибся', 'Правила промпта соблюдены — судья ошибся', 'С обоими: запрос выполнен и правила соблюдены']
                    : ['Запрос не выполнен — судья ошибся', 'Правила промпта нарушены — судья ошибся', 'С обоими: запрос не выполнен и правила нарушены'];
                  const picked = await ctx.ui.select('С чем вы не согласны?', options);
                  if (picked === undefined) continue;
                  disagreeIds = picked === options[0] ? [ids[0]!] : picked === options[1] ? [ids[1]!] : ids;
                }
                // UI-D-28: `n` always opens the editor, prefilled with the reason already given, so
                // the same key edits a reason; the duplicate check runs only after it closes.
                const reason = await ctx.ui.editor(`Судья решил: ${failed ? 'не справился' : 'справился'}. Почему вы не согласны? Коротко, своими словами.`,
                  current?.answer === 'disagree' ? current.note : '');
                if (reason === undefined) continue;
                // Input validation, not display: the schema caps a stored reason at 3000 characters,
                // so the owner is told to shorten it instead of losing the text to a write error.
                if (!reason.trim()) { inform('Несогласие не сохранено: напишите причину.', 'error'); continue; }
                if (reason.length > 3000) { inform('Причина длиннее 3000 знаков. Сократите и попробуйте снова.', 'error'); continue; }
                // The same disputed half with the same reason is already the current mark: nothing is written.
                const disputed = current?.answer === 'disagree' ? current.targets.filter(t => t.answer === 'disagree').map(t => t.metricId).join(' ') : undefined;
                if (current && disputed === disagreeIds.join(' ') && reason.trim() === current.note.trim()) { inform('Отметка уже стоит: не согласен.', 'info'); continue; }
                note = reason;
              } else {
                // UI-D-19: the same answer again on every target writes nothing, so the record keeps one mark per answer (CTX-17).
                if (current && current.targets.every(t => t.answer === action.answer)) { inform(`Отметка уже стоит: ${action.answer === 'agree' ? 'согласен' : 'не могу сказать'}.`, 'info'); continue; }
                note = action.answer === 'agree' ? 'Быстрая отметка: согласен с судьёй.' : 'Быстрая отметка: не могу сказать.';
              }
              // CTX-05: reading time on the board plus the time the answer itself took, recorded once.
              const durationMs = Math.min(3600000, Math.round((action.reviewMs ?? 0) + performance.now() - started));
              for (const [i, metricId] of ids.entries()) {
                // CTX-04: согласен — вердикт судьи, не согласен — противоположный, не могу сказать — сомнение.
                // Disputing one half of a double failure means agreeing with the other half (RESEARCH A6).
                const disputes = action.answer === 'disagree' && disagreeIds.includes(metricId);
                const verdict = action.answer === 'unsure' ? 'unknown' as const : disputes ? (failed ? 'pass' as const : 'fail' as const) : action.judgeVerdict;
                // The lab stamps the counting rule and the judge snapshot itself; the request never names them.
                await lab.addHumanReview(action.record.id, {
                  trialId: action.trialId, metricId, source: 'quick', verdict, judgeVerdict: action.judgeVerdict,
                  note: action.answer === 'disagree' && !disputes ? 'Быстрая отметка: согласен с судьёй.' : note,
                  ...(i === 0 ? { durationMs } : {}),
                });
              }
              reviewTimes.delete(`${action.record.id}|${action.trialId}`);
              reportPath = undefined;
              const afterRecord = await lab.get(action.record.id);
              const after = judgeAgreement(afterRecord);
              // C-98: a mark on a finished run reopens the review, and the notice says so.
              const reopened = before.phase === 'complete' ? ' Разбор снова открыт: f — завершить.' : '';
              const progress = after.queueFailures.length
                ? `Проверено провалов: ${after.failures.checked} из ${after.queueFailures.length}.`
                : `Проверено успехов: ${after.sampleChecked} из ${after.sampledPasses.length}.`;
              // CR-02 notice: «Итог пересчитан» only when the situation's headline verdict moved;
              // otherwise the notice names what still fails, so the number is never claimed to have changed.
              const disagreed = () => {
                const was = card ? cardVerdict(before, card).outcome : undefined;
                const now = card ? cardVerdict(afterRecord, card).outcome : undefined;
                if (card && now !== was) return `Отмечено: не согласен · «${title}». Итог пересчитан с учётом вашей отметки.`;
                if (!card || now !== 'fail') return `Отмечено: не согласен · «${title}». Итог не изменился.`;
                const parts = headlineCardOutcome(afterRecord, card);
                const what = parts.goal === 'fail' && parts.rules === 'fail' ? 'запрос не выполнен, нарушены правила промпта'
                  : parts.goal === 'fail' ? 'запрос не выполнен'
                  : parts.rules === 'fail' ? 'нарушены правила промпта'
                  : 'остальные провалы — через v';
                return `Отмечено: не согласен · «${title}». Ситуация остаётся «не справился»: ${what}.`;
              };
              inform(action.answer === 'agree' ? `Отмечено: согласен с судьёй · «${title}». ${progress}${reopened}`
                : action.answer === 'disagree' ? `${disagreed()}${reopened}`
                : `Отмечено: не могу сказать · «${title}». В итоге остаётся оценка судьи; чтобы закрыть ситуацию, позже нажмите y или n.${reopened}`);
            } else if (action.type === 'annotate') {
              const index = action.trialId ? reviewOrder(action.record).findIndex(t => t.id === action.trialId) : action.selected;
              const reviews = await humanAnnotation(ctx, action.record, index, action.reviewMs, reviewTimes);
              if (reviews) { for (const review of reviews) { await lab.addHumanReview(action.record.id, review); reviewTimes.delete(`${action.record.id}|${review.trialId}`); } reportPath = undefined; }
            } else if (action.type === 'finalize') {
              const r = action.record;
              const pending = awaitingVerdict(r).size;
              if (pending) {
                section = 'results'; pendingOnly = true; selected = 0; query = '';
                inform(`Не разобрано ситуаций: ${pending}. y / n — согласие с судьёй · v — подробная оценка.`, 'error');
                continue;
              }
              const hash = resultHash(r);
              const invalid = r.trials.filter(t => t.outcome === 'invalid' || t.outcome === 'cancelled').length;
              const ungraded = r.trials.filter(t => t.outcome === 'ungraded').length;
              if (await ctx.ui.confirm('Завершить человеческий аудит?', `Я проверил диалоги, основания оценок и поведение симуляторов.\nДиалогов: ${r.trials.length}; невалидных/остановленных: ${invalid}; без объективной оценки: ${ungraded}.\nОтдельных заметок человека: ${r.humanReviews?.length ?? 0}. ${r.mode === 'demo' ? 'Сценарные оценки демо останутся отдельными от моих.' : 'Оценки модели останутся отдельными от моих.'}\nОтметка согласия ставится на оценки, из-за которых ситуация решена: запрос и правила промпта; остальные критерии — через v.\nВерсия результатов: ${hash}\nПодтвердить проверку всего набора?`)) {
                const reviewed = await lab.reviewResults(r.id, hash);
                section = 'agent'; selected = 0; query = ''; pendingOnly = false;
                const artifacts = await exportArtifacts(await evidenceBundle(reviewed, lab.store, beforeId), lab.store.directory);
                reportPath = artifacts.htmlReport;
                inform('Разбор завершён. HTML-отчёт сохранён. o — открыть отчёт.');
              }
            } else if (action.type === 'export') {
              const artifacts = await exportArtifacts(await evidenceBundle(action.record, lab.store, beforeId), lab.store.directory);
              reportPath = artifacts.htmlReport;
              inform('HTML, Markdown и снимок доказательств сохранены. o — открыть отчёт.');
              ctx.ui.notify(safeText(`Отчёт: ${artifacts.htmlReport}\nMarkdown: ${artifacts.report}\nДоказательства: ${artifacts.evidence}`), 'info');
            } else if (action.type === 'openReport' && reportPath) {
              const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
              const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', reportPath] : [reportPath];
              await promisify(execFile)(command, args, { timeout: 10000 });
              inform('Отчёт открыт в браузере.');
            }
          } catch (error) {
            // A start refused for stale expectations names the key that fixes it (UI-SPEC Board flow 4).
            const message = scenarioErrorText(error);
            inform(message.startsWith('Сначала подтвердите ожидания ситуаций') ? `${message} y — подтвердить.` : message, 'error');
          } finally { await release(); }
        }
      } finally { await release(); }
      if (handoff) {
        pi.sendMessage({ customType: 'agent-lab-context', content: JSON.stringify(handoff.context), display: false }, { deliverAs: 'followUp' });
        pi.sendUserMessage(handoff.request, { deliverAs: 'followUp', expandPromptTemplates: false });
      }
    },
  });
}
