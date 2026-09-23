import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Experiment } from '../src/contracts.js';
import { contains } from '../src/card/checks.js';
import { hostGrant, requiredAuthority, wordsOf, type HostGrant, type Prepared } from '../src/card/commands.js';
import type { CardCommand } from '../src/card/schema.js';
import { briefRows, changeText, chip, countsText, detailRows, formatNote, listRows, situationData, situationEntry, situationViews, type SituationView } from '../src/card/view.js';
import { CommandRefused, LibraryConflict, UnknownReference } from '../src/errors.js';
import type { ExperimentLab } from '../src/experiment.js';
import { libraryHash } from '../src/scenario-library.js';
import { clip, safeText, shortId } from '../src/text.js';
import { ownerMessages, row, type Feed } from './conversation.ts';
import { displayFor, isInteractive, NeedsOwner, requireInteractive, returnToBoard } from './lab-ui.ts';
import type { LabLease, SessionOperations } from './operations.ts';
import { situationRows } from './render/situation.ts';

/*
 * The chat's hands on a draft of cards (card-v2 §5): one read tool and narrow command tools, each a thin
 * adapter over src/card/commands.ts. The model names a situation by its number and a fact or a duty by the
 * id the read tool showed (f2, e1); it never carries hashes or passes an approval. What the host needs from
 * the owner comes from the owner: the words of a wording verbatim in their own messages, anything else a
 * native dialog showing the exact change. A card changed by a command is checked again within the agreed
 * calls, in the row of the command when that is quick, as a later message when it is not.
 */

export interface CardToolHost {
  inlineCheckMs: number;
  operations: SessionOperations;
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  findRun: (directory: string, ref?: string, ctx?: { sessionManager?: { getEntries?: () => unknown[] } }) => Promise<Experiment>;
  focus: Map<string, string>;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
  /** A check too long for the row of its command: it goes on in the session and reports back as a message. */
  backgroundCheck: (ctx: ExtensionContext, owned: LabLease, id: string, card: number | undefined) => void;
  /** A continued preparation: it goes on in the session and its situations arrive as a message. */
  backgroundPreparation: (ctx: ExtensionContext, owned: LabLease, id: string) => void;
}

/** The situations of a record with their status now; a card draft reads its imports for that. `running`: a check of them is going on. */
export async function situationsNow(lab: ExperimentLab, record: Experiment, running = false): Promise<{ views: SituationView[]; running: boolean }> {
  if (record.librarySnapshot?.formatVersion !== 2) return { views: situationViews(record, { maxTurns: record.settings.maxTurns }), running: false };
  const { experiment, evidence, numbers } = await lab.cardContext(record.id);
  return { views: situationViews(experiment, { evidence, numbers, maxTurns: experiment.settings.maxTurns }), running };
}

/** The list in the chat (ui-spec §4.10): the counts and who waits for an answer; every situation in three lines on expand. */
export function situationsFeed(record: Experiment, views: SituationView[], running = false): Feed {
  const waiting = views.filter(view => view.status === 'needs_owner');
  const note = formatNote(record);
  return {
    rows: [row(countsText(views), 'text', true),
      ...(waiting.length ? [row(`Ждут ответа: ${waiting.slice(0, 3).map(view => `${view.number} ${clip(view.brief.title, 60)}`).join(' · ')}${waiting.length > 3 ? ` · ещё ${waiting.length - 3}` : ''}`, 'warning', false, 2)] : []),
      ...(note ? [row(note, 'muted', false, 2)] : [])],
    more: situationRows(views.flatMap(view => listRows(view, { running }))),
  };
}

/** One situation in the chat: its title, chip and two lines; the whole brief — and «d» when asked — on expand. */
export function situationFeed(view: SituationView, options: { running?: boolean; details?: boolean } = {}): Feed {
  const { brief } = view;
  return {
    rows: [row(`${view.number}  ${brief.title} · ${chip(view, options.running).text}`, 'text', true),
      row(`Клиент: «${clip(brief.writes, 120)}» · Агент должен: ${clip(brief.must[0]?.text ?? '—', 120)}`, undefined, false, 4),
      ...(view.question ? [row(`Вопрос: ${view.question.text}`, 'warning', false, 4)] : view.problems[0] ? [row(`Не подходит: ${view.problems[0]}`, 'muted', false, 4)] : [])],
    more: situationRows([...briefRows(view, { running: options.running }), ...(options.details ? [{ role: 'blank' as const, indent: 0, text: '' }, ...detailRows(view)] : [])]),
  };
}

const card = Type.Integer({ minimum: 1, maximum: 999, description: 'The situation\'s number, as shown.' });
const run = Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Run: id, short id or words of its task. Omit for the draft this conversation works on.' }));
const later = Type.Optional(Type.Literal('later', { description: 'later: check the changed situation after the last change of a series, not now.' }));
const closed = { additionalProperties: false } as const;

export function registerCardTools(pi: ExtensionAPI, host: CardToolHost): void {
  pi.registerTool({
    ...displayFor('agent_lab_cards'), name: 'agent_lab_cards', label: 'Show situations',
    description: 'Read-only. The situations of a draft or a run: each one\'s number, title, status and its one open question with numbered answers. card: one situation by its number, whole — what the customer wants, writes and knows (fact ids f1…) and what the agent must do (duty ids e1…); details: also how it is run and judged. Read the situation by its number before changing it.',
    parameters: Type.Object({ id: run, card: Type.Optional(card), details: Type.Optional(Type.Boolean()) }, closed),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const record = await host.findRun(directory, params.id, ctx);
        host.focus.set(directory, record.id);
        returnToBoard(ctx, record.id);
        const job = host.operations.current(directory);
        const { views, running } = await situationsNow(host.reading(directory), record, job?.kind === 'assessment' && job.id === record.id);
        const readOnly = record.librarySnapshot?.formatVersion !== 2 || record.phase !== 'review';
        const note = `Ситуации прогона ${shortId(record.id)}`;
        if (params.card === undefined) {
          return host.feedResult(callId, { runId: record.id, readOnly, ...(formatNote(record) ? { note: formatNote(record) } : {}), counts: countsText(views), situations: views.map(situationEntry) },
            situationsFeed(record, views, running), note);
        }
        const view = views.find(item => item.number === params.card);
        if (!view) throw new NeedsOwner('unknown_reference', `Ситуации №${params.card} нет. Спросите владельца, какая нужна.`, views.map(item => `${item.number}. ${item.brief.title}`).slice(0, 15));
        return host.feedResult(callId, { runId: record.id, readOnly, situation: situationData(view), ...(params.details ? { details: view.details } : {}) },
          situationFeed(view, { running, details: params.details }), `Ситуация №${view.number} · прогон ${shortId(record.id)}`);
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
  registerCommandTools(pi, host);
}

/** What followed a change: the card checked again (here or later as a message), or why not now. */
type CheckState = { status: 'none' | 'done' | 'running' | 'skipped' } | { status: 'needs_budget'; pendingJobs: number; remainingCalls: number } | { status: 'failed'; message: string };
const CHECK_TEXT = (check: CheckState): string | undefined => check.status === 'running' ? 'Проверяю изменённую ситуацию в фоне — итог придёт сюда отдельным сообщением. Можно продолжать.'
  : check.status === 'skipped' ? 'Проверю после последней правки серии.'
  : check.status === 'needs_budget' ? `Чтобы проверить изменённую ситуацию, нужно вызовов модели: ${check.pendingJobs}, а в лимите осталось ${check.remainingCalls}. Скажите, если поднять лимит.`
  : check.status === 'failed' ? `Проверка не завершилась: ${check.message} Правка сохранена.` : undefined;

/** The status of a situation in one line, as the chip says it. */
const statusLine = (view: SituationView, running = false) => `Ситуация ${view.number}: ${chip(view, running).text}`;

/** The situation the model named, in the draft a change goes to; a finished run is never changed, its edit goes into a fresh draft of the same set. */
async function draftSituation(host: CardToolHost, lab: ExperimentLab, directory: string, record: Experiment, number: number) {
  if (record.librarySnapshot?.formatVersion !== 2) throw new CommandRefused(record.librarySnapshot ? 'Это ситуации старого формата: их можно посмотреть и повторить принятые, но не изменить.'
    : 'Ситуации этого прогона записаны до наборов ситуаций: их можно посмотреть и повторить, но не изменить.');
  const target = await lab.editableCards(record.id);
  host.focus.set(directory, target.id);
  const context = await lab.cardContext(target.id);
  const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
  const view = views.find(item => item.number === number);
  if (!view) throw new UnknownReference('card', views.map(item => `№${item.number} ${clip(item.brief.title, 60)}`), `Ситуации №${number} в черновике нет.`);
  return { target, context, view };
}

/**
 * The owner's decision on a command. A wording the owner wrote in their own message is theirs as it stands;
 * anything else — a decision about the customer, or words the model chose — is shown as the exact change in a
 * native dialog, and only «Записать» makes it the owner's.
 */
async function decide(ctx: ExtensionContext, lab: ExperimentLab, id: string, command: CardCommand, heading: string): Promise<{ prepared: Prepared; grant: HostGrant } | undefined> {
  const words = wordsOf(command);
  const said = ownerMessages(ctx);
  const verbatim = requiredAuthority(command) === 'owner-words' && words.length > 0 && words.every(text => said.some(message => contains(message, text)));
  const joined = words.join('\n');
  const prepared = await lab.prepareCardCommand(id, command, { via: 'pi-confirm', ...(verbatim && joined.length <= 1000 ? { ownerWords: joined } : {}) });
  if (verbatim) return { prepared, grant: hostGrant(prepared, 'words') };
  requireInteractive(ctx, 'Это решение владельца: его подтверждают в интерактивном терминале Pi. Без него: agent-lab cards --id RUN --input команда.json --yes.');
  const lines = prepared.diff.flatMap(item => item.changes.map(change => `${item.number}  ${changeText(change)}`));
  const picked = await ctx.ui.select(safeText([heading, ...(lines.length ? ['', ...lines] : []), '', 'Записать это от вашего имени?'].join('\n')), ['Записать', 'Не записывать']);
  return picked === 'Записать' ? { prepared, grant: hostGrant(prepared, 'confirmed') } : undefined;
}

/** A command the owner picked in a native dialog: the pick is the confirmation. */
async function chosen(lab: ExperimentLab, id: string, command: CardCommand): Promise<{ prepared: Prepared; grant: HostGrant }> {
  const prepared = await lab.prepareCardCommand(id, command, { via: 'pi-confirm' });
  return { prepared, grant: hostGrant(prepared, 'confirmed') };
}

/** The claims a change opened are checked within the agreed calls: here when it is quick, as a later message when it is not, or later on the owner's word. */
async function recheck(host: CardToolHost, ctx: ExtensionContext, owned: LabLease, id: string, number: number | undefined, later: boolean, signal: AbortSignal | undefined, explicit = false): Promise<CheckState> {
  const { decision, before } = await owned.lab.recheckCards(id, { defer: later, explicit });
  if (decision.action === 'not_needed') return { status: 'none' };
  if (decision.action === 'skipped') return { status: 'skipped' };
  if (decision.action === 'needs_budget') return { status: 'needs_budget', pendingJobs: decision.pendingJobs, remainingCalls: decision.remainingCalls };
  const interactive = isInteractive(ctx) && !!ctx.ui;
  const inline = !interactive ? (await owned.lab.waitForIdle(), true) : await new Promise<boolean>(settle => {
    const timer = setTimeout(() => settle(false), host.inlineCheckMs);
    const onAbort = () => settle(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    void owned.lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
  });
  if (!inline) { host.backgroundCheck(ctx, owned, id, number); return { status: 'running' }; }
  const after = await owned.lab.get(id);
  return after.phase === 'review' && !after.error ? { status: before.usage.calls === after.usage.calls ? 'none' : 'done' } : { status: 'failed', message: safeText(after.error ?? after.message) };
}

interface ChangeParams { id?: string; card: number; verify?: 'later' }
/** A command to apply; `decided`: the owner already chose it in a native dialog (an answer to a question), so it is not asked twice. */
interface Built { command: CardCommand; heading: string; decided?: true }

/**
 * One command on one situation, the same way for every command tool: the draft, the owner's decision, the new
 * revision, the check, and an answer with «было → стало» and the card's status now.
 */
async function changeSituation(host: CardToolHost, callId: string, ctx: ExtensionContext, signal: AbortSignal | undefined, params: ChangeParams,
  build: (view: SituationView, context: Awaited<ReturnType<ExperimentLab['cardContext']>>) => Built | null | Promise<Built | null>): Promise<AgentToolResult<unknown>> {
  const directory = resolve(ctx.cwd, '.agent-lab');
  let handedOver = false;
  try {
    const found = await host.findRun(directory, params.id, ctx);
    const owned = await host.open(ctx.cwd);
    try {
      await owned.lab.init();
      const { target, context, view } = await draftSituation(host, owned.lab, directory, found, params.card);
      const built = await build(view, context);
      const decided = !built ? undefined : built.decided ? await chosen(owned.lab, target.id, built.command) : await decide(ctx, owned.lab, target.id, built.command, built.heading);
      if (!built || !decided) return host.feedResult(callId, { applied: false, declined: true, message: 'The owner did not confirm. Nothing was written; do not ask again unless they do.' },
        { rows: [row('Не записано: вы не подтвердили.', 'warning')] }, `Ситуация №${view.number} не изменена`);
      const { command } = built;
      await owned.lab.applyCardCommand(target.id, decided.prepared, decided.grant);
      // A new situation (a similar one) is read by its id: its number is new.
      const subject = command.kind === 'add_similar' ? decided.prepared.scope[0]! : view.id;
      const removed = command.kind === 'remove_card';
      const check = removed ? { status: 'none' as const } : await recheck(host, ctx, owned, target.id, view.number, params.verify === 'later', signal);
      handedOver = check.status === 'running';
      const fresh = await host.reading(directory).cardContext(target.id);
      const after = situationViews(fresh.experiment, { evidence: fresh.evidence, numbers: fresh.numbers, maxTurns: fresh.experiment.settings.maxTurns }).find(item => item.id === subject);
      const changes = decided.prepared.diff.flatMap(item => item.changes.map(changeText));
      const copied = target.copiedFrom && target.copiedFrom !== target.id;
      returnToBoard(ctx, target.id);
      const headline = removed ? `Ситуация ${view.number} убрана из черновика. Исходные разговоры и прошлые прогоны не тронуты.`
        : after ? statusLine(after, check.status === 'running') : `Ситуация ${view.number} изменена.`;
      const feed: Feed = { rows: [row(headline, after?.status === 'ready' ? 'success' : 'warning', true),
        ...(copied ? [row('Прошлый прогон не меняется: правка сделана в черновике того же набора.', 'accent', false, 2)] : []),
        ...changes.map(text => row(text, undefined, false, 2)),
        ...(CHECK_TEXT(check) ? [row(CHECK_TEXT(check)!, 'muted', false, 2)] : [])],
        ...(after ? { more: situationRows(briefRows(after, { running: check.status === 'running' })) } : {}) };
      return host.feedResult(callId, { applied: true, runId: target.id, ...(copied ? { unchangedRunId: target.copiedFrom,
        instruction: 'The finished run never changes, so the change went into a fresh draft of the same set. Say so in one phrase and keep working on runId.' } : {}),
        changes, check, ...(after ? { situation: situationData(after) } : {}),
        ...(check.status === 'running' ? { checkNote: 'The check continues in the background and reports back as a message. Do not wait for it or poll; further changes are fine.' } : {}) },
        feed, `Ситуация №${after?.number ?? view.number} · прогон ${shortId(target.id)}`);
    } finally { if (!handedOver) await owned.close(); }
  } catch (error) {
    if (error instanceof CommandRefused) return host.feedResult(callId, { applied: false, refused: error.message, instruction: 'Nothing was written. Tell the owner why in one sentence; do not repeat the same call.' },
      { rows: [row(safeText(error.message), 'warning')] }, 'Не записано');
    if (error instanceof LibraryConflict) return host.feedResult(callId, { applied: false, stale: true, message: error.message, instruction: 'The draft changed since it was read. Read it again with agent_lab_cards and decide on the fresh state.' },
      { rows: [row(safeText(error.message), 'warning'), row('Ничего не записано.', 'muted', false, 2)] }, 'Ситуации изменились');
    if (error instanceof UnknownReference) return host.askOwner(callId, new NeedsOwner('unknown_reference', `${error.message} Есть: ${error.allowed.slice(0, 12).join('; ')}.`, error.allowed.slice(0, 12)));
    return host.askOwner(callId, error);
  }
}

const disclosure = Type.Union([Type.Literal('initial'), Type.Literal('on_request'), Type.Literal('unknown')],
  { description: 'initial: says it in the first message; on_request: names it only when the agent asks; unknown: does not know it.' });
const turnShape = Type.Object({ kind: Type.Union([Type.Literal('change_intent'), Type.Literal('report')]), after: Type.String({ minLength: 1, maxLength: 300, description: 'After what the agent does, in plain words.' }),
  says: Type.String({ minLength: 1, maxLength: 1000, description: 'What the customer says then.' }) }, closed);
const text = (max: number, description: string) => Type.Optional(Type.String({ minLength: 1, maxLength: max, description }));

function registerCommandTools(pi: ExtensionAPI, host: CardToolHost): void {
  pi.registerTool({
    ...displayFor('agent_lab_card_answer'), name: 'agent_lab_card_answer', label: 'Answer a situation\'s question',
    description: 'The owner answers the one open question of a situation: the question and its numbered answers open in a native dialog and the owner picks. choice: the answer the owner already named in the conversation, shown to them; text: their own words for an answer that needs words (they can correct them in the native editor).',
    parameters: Type.Object({ id: run, card, choice: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })), text: text(1000, 'The owner\'s words for an answer that needs them.'), verify: later }, closed),
    executionMode: 'sequential',
    execute: (callId, params, signal, _onUpdate, ctx) => changeSituation(host, callId, ctx, signal, params, async view => {
      const question = view.question;
      if (!question?.id || !question.choices.length) throw new CommandRefused(`У ситуации ${view.number} нет открытого вопроса.`);
      requireInteractive(ctx, 'На вопрос о ситуации отвечает владелец в интерактивном терминале Pi. Без него: agent-lab cards --id RUN --card N --choice a --yes.');
      const named = params.choice === undefined ? undefined : question.choices[params.choice - 1];
      const labels = question.choices.map((choice, index) => `${index + 1}  ${choice.label}`);
      const picked = await ctx.ui.select(safeText([`Ситуация ${view.number} «${view.brief.title}»`, '', question.text, ...(named ? ['', `В разговоре вы ответили: «${named.label}»`] : [])].join('\n')),
        [...labels, 'Не сейчас']);
      const choice = question.choices[labels.indexOf(picked ?? '')];
      if (!choice) return null;
      let words: string | undefined;
      if (choice.needsText) {
        words = (await ctx.ui.editor(`${choice.label} — своими словами`, params.text ?? wordsOf(choice.command)[0] ?? ''))?.trim();
        if (!words) return null;
      }
      return { command: { kind: 'answer_question', cardId: view.id, questionId: question.id, choice: choice.id, ...(words ? { text: words } : {}) }, heading: question.text, decided: true };
    }),
  });
  pi.registerTool({
    ...displayFor('agent_lab_resume_preparation'), name: 'agent_lab_resume_preparation', label: 'Continue preparing situations',
    description: 'Continues a preparation that stopped (the owner stopped it, the calls or the time ran out) from its saved place, within the calls left. A paid call that died in flight is never repeated. The situations arrive as a message.',
    parameters: Type.Object({ id: run }, closed),
    executionMode: 'sequential',
    async execute(callId, params, _signal, _onUpdate, ctx) {
      const directory = resolve(ctx.cwd, '.agent-lab');
      let handedOver = false;
      try {
        const found = await host.findRun(directory, params.id, ctx);
        if (!found.librarySnapshot) throw new CommandRefused('У этого прогона нет подготовки, которую можно продолжить.');
        requireInteractive(ctx, 'Продолжение подготовки докладывает в чат: нужен интерактивный терминал Pi. Без него: agent-lab cards --id RUN --resume --yes.');
        const owned = await host.open(ctx.cwd);
        try {
          await owned.lab.init();
          await owned.lab.resumePreparation(found.id, libraryHash(found.librarySnapshot));
          host.backgroundPreparation(ctx, owned, found.id); handedOver = true;
          return host.feedResult(callId, { id: found.id, background: true, instruction: 'The preparation continues in the background; its situations arrive as a message. Do not poll.' },
            { rows: [row('Продолжаю подготовку с сохранённого места. Ситуации придут сюда отдельным сообщением.', 'success', true)] }, `Подготовка ${shortId(found.id)} продолжена`);
        } finally { if (!handedOver) await owned.close(); }
      } catch (error) {
        if (error instanceof CommandRefused) return host.feedResult(callId, { refused: error.message }, { rows: [row(safeText(error.message), 'warning')] }, 'Продолжать нечего');
        return host.askOwner(callId, error);
      }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_card_check'), name: 'agent_lab_card_check', label: 'Check the situations again',
    description: 'Checks every situation of a draft that is not checked yet — after changes checked later, or when the agreed calls ran out — within the calls left. A long check continues in the background and reports back as a message.',
    parameters: Type.Object({ id: run }, closed),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      const directory = resolve(ctx.cwd, '.agent-lab');
      let handedOver = false;
      try {
        const found = await host.findRun(directory, params.id, ctx);
        if (found.librarySnapshot?.formatVersion !== 2 || found.phase !== 'review') throw new CommandRefused('Проверять нечего: проверяются ситуации черновика нового формата.');
        const owned = await host.open(ctx.cwd);
        try {
          await owned.lab.init();
          const check = await recheck(host, ctx, owned, found.id, undefined, false, signal, true);
          handedOver = check.status === 'running';
          const fresh = await host.reading(directory).cardContext(found.id);
          const views = situationViews(fresh.experiment, { evidence: fresh.evidence, numbers: fresh.numbers, maxTurns: fresh.experiment.settings.maxTurns });
          const feed = situationsFeed(fresh.experiment, views, handedOver);
          feed.rows.unshift(row(check.status === 'none' ? 'Проверять нечего: все ситуации проверены.' : check.status === 'done' ? 'Проверка завершена.' : CHECK_TEXT(check) ?? '', check.status === 'failed' || check.status === 'needs_budget' ? 'warning' : 'success', true));
          return host.feedResult(callId, { runId: found.id, check, counts: countsText(views), situations: views.map(situationEntry) }, feed, `Проверка ситуаций · прогон ${shortId(found.id)}`);
        } finally { if (!handedOver) await owned.close(); }
      } catch (error) {
        if (error instanceof CommandRefused) return host.feedResult(callId, { refused: error.message }, { rows: [row(safeText(error.message), 'warning')] }, 'Проверка не нужна');
        return host.askOwner(callId, error);
      }
    },
  });
  pi.registerTool({
    ...displayFor('agent_lab_card_fact'), name: 'agent_lab_card_fact', label: 'Change what the customer knows',
    description: 'What the customer of one situation knows and when they say it. fact: an id from agent_lab_cards (f1…); without it a new fact is added. disclosure alone changes when the customer names the fact; label/value rewrite it; remove:true takes it out. Always the owner\'s decision: the owner confirms the exact change in a native dialog.',
    parameters: Type.Object({ id: run, card, fact: Type.Optional(Type.String({ pattern: '^f[0-9]{1,3}$' })), label: text(120, 'What the fact is, e.g. «Номер терминала».'),
      value: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Number(), Type.Boolean()])), disclosure: Type.Optional(disclosure),
      remove: Type.Optional(Type.Boolean()), verify: later }, closed),
    executionMode: 'sequential',
    execute: (callId, params, signal, _onUpdate, ctx) => changeSituation(host, callId, ctx, signal, params, (view, { library }) => {
      const card = library.cards.find(item => item.id === view.id)!;
      const fact = params.fact === undefined ? undefined : card.client.knows.find(item => item.id === params.fact);
      if (params.fact !== undefined && !fact) throw new UnknownReference('fact', card.client.knows.map(item => `${item.id} ${item.label}`), `У ситуации №${view.number} нет факта ${params.fact}.`);
      const heading = `Ситуация ${view.number} «${view.brief.title}»: что знает клиент`;
      if (params.remove) {
        if (!fact) throw new CommandRefused('Скажите, какой факт убрать.');
        return { command: { kind: 'remove_fact', cardId: card.id, factId: fact.id }, heading };
      }
      if (params.label !== undefined || params.value !== undefined) {
        const disclosed = params.disclosure ?? fact?.disclosure;
        if (!disclosed) throw new CommandRefused('Скажите, когда клиент называет новый факт: сразу, если спросят, или не знает.');
        return { command: { kind: 'set_fact', cardId: card.id, ...(fact ? { factId: fact.id } : {}), label: params.label ?? fact!.label,
          ...(params.value !== undefined ? { value: params.value } : fact?.value !== undefined ? { value: fact.value } : {}), disclosure: disclosed }, heading };
      }
      if (!fact || !params.disclosure) throw new CommandRefused('Скажите, что изменить в факте: когда клиент его называет, его текст или убрать его.');
      return { command: { kind: 'set_fact_disclosure', cardId: card.id, factId: fact.id, disclosure: params.disclosure }, heading };
    }),
  });
  pi.registerTool({
    ...displayFor('agent_lab_card_expectation'), name: 'agent_lab_card_expectation', label: 'Change what the agent must do',
    description: 'One duty of one situation (an id from agent_lab_cards: e1…): new wording, the owner rules it rests on (requirement ids), when it applies (appliesWhen; null: always), or remove:true. Wording in the owner\'s own words from their message is written as it is; otherwise the owner confirms it in a native dialog. A situation keeps at least one duty.',
    parameters: Type.Object({ id: run, card, expectation: Type.String({ pattern: '^e[0-9]{1,2}$' }), text: text(300, 'What the agent must do, as an infinitive.'),
      rules: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 3 })),
      appliesWhen: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()])), remove: Type.Optional(Type.Boolean()), verify: later }, closed),
    executionMode: 'sequential',
    execute: (callId, params, signal, _onUpdate, ctx) => changeSituation(host, callId, ctx, signal, params, view => {
      const heading = `Ситуация ${view.number} «${view.brief.title}»: что должен агент`;
      return params.remove ? { command: { kind: 'remove_expectation', cardId: view.id, expectationId: params.expectation }, heading }
        : { command: { kind: 'edit_expectation', cardId: view.id, expectationId: params.expectation, ...(params.text !== undefined ? { text: params.text } : {}),
          ...(params.rules ? { requirementIds: params.rules } : {}), ...(params.appliesWhen !== undefined ? { appliesWhen: params.appliesWhen } : {}) }, heading };
    }),
  });
  pi.registerTool({
    ...displayFor('agent_lab_card_client'), name: 'agent_lab_card_client', label: 'Change the customer\'s words',
    description: 'The customer of one situation: what they want (wants), their first message (writes), when they leave (leaves), or their late turn (turn; null removes it) — the turn alone or the other fields, not both at once. The owner\'s own words from their message are written as they are; words you propose are shown to the owner to confirm.',
    parameters: Type.Object({ id: run, card, wants: text(300, 'What the customer wants.'), writes: text(3000, 'The customer\'s exact first message.'), leaves: text(300, 'When the customer leaves.'),
      turn: Type.Optional(Type.Union([turnShape, Type.Null()])), verify: later }, closed),
    executionMode: 'sequential',
    execute: (callId, params, signal, _onUpdate, ctx) => changeSituation(host, callId, ctx, signal, params, view => {
      const heading = `Ситуация ${view.number} «${view.brief.title}»: клиент`;
      const client = params.wants !== undefined || params.writes !== undefined || params.leaves !== undefined;
      if (params.turn !== undefined && client) throw new CommandRefused('Поворот и слова клиента меняются по одному: сначала одно, потом другое.');
      if (params.turn !== undefined) return { command: { kind: 'set_turn', cardId: view.id, turn: params.turn }, heading };
      return { command: { kind: 'edit_client', cardId: view.id, ...(params.wants !== undefined ? { wants: params.wants } : {}),
        ...(params.writes !== undefined ? { writes: params.writes } : {}), ...(params.leaves !== undefined ? { leaves: params.leaves } : {}) }, heading };
    }),
  });
  pi.registerTool({
    ...displayFor('agent_lab_card_similar'), name: 'agent_lab_card_similar', label: 'Add a similar situation',
    description: 'A new situation made from one situation with exactly one difference: a fact the customer names differently (disclosure; a new first message in writes when the value leaves it), another first message (opening), or another late turn (turn; null: none). The original stays as it is. What the customer knows is the owner\'s decision; a proposed first message is shown to the owner to confirm.',
    parameters: Type.Object({ id: run, card, change: Type.Union([
      Type.Object({ kind: Type.Literal('disclosure'), fact: Type.String({ pattern: '^f[0-9]{1,3}$' }), disclosure, writes: text(3000, 'The new first message, without the value.') }, closed),
      Type.Object({ kind: Type.Literal('opening'), writes: Type.String({ minLength: 1, maxLength: 3000 }) }, closed),
      Type.Object({ kind: Type.Literal('turn'), turn: Type.Union([turnShape, Type.Null()]) }, closed),
    ]), title: text(160, 'The new situation\'s title; by default the original\'s with the difference.'), verify: later }, closed),
    executionMode: 'sequential',
    execute: (callId, params, signal, _onUpdate, ctx) => changeSituation(host, callId, ctx, signal, params, view => {
      const { change } = params;
      return { heading: `Похожая на ситуацию ${view.number} «${view.brief.title}»`, command: { kind: 'add_similar', parentId: view.id, ...(params.title !== undefined ? { title: params.title } : {}),
        change: change.kind === 'disclosure' ? { kind: 'disclosure', factId: change.fact, disclosure: change.disclosure, ...(change.writes !== undefined ? { writes: change.writes } : {}) } : change } };
    }),
  });
  pi.registerTool({
    ...displayFor('agent_lab_card_remove'), name: 'agent_lab_card_remove', label: 'Remove a situation',
    description: 'Takes one situation out of the draft, only when the owner asked for exactly that. The imported dialogues and past runs are not touched; the owner confirms in a native dialog.',
    parameters: Type.Object({ id: run, card }, closed),
    executionMode: 'sequential',
    execute: (callId, params, signal, _onUpdate, ctx) => changeSituation(host, callId, ctx, signal, params,
      view => ({ command: { kind: 'remove_card', cardId: view.id }, heading: `Убрать ситуацию ${view.number} «${view.brief.title}» из черновика?` })),
  });
}
