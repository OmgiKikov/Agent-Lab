import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import type { Experiment } from '../src/contracts.js';
import { contains, type CardEvidence } from '../src/card/checks.js';
import { hostGrant, wordsOf, type HostGrant, type Prepared } from '../src/card/commands.js';
import { identifierPattern } from '../src/ids.js';
import { convertible } from '../src/card/legacy-v1.js';
import { cardChangeSchema, type Card, type CardCommand, type LibraryV2 } from '../src/card/schema.js';
import type { Reference } from '../src/reference.js';
import { cardStatuses } from '../src/card/status.js';
import { rulebookChangeLines, rulebookLines, rulebookOf, shownRulebook, withKind, withRules } from '../src/card/rulebook.js';
import { briefRows, changeText, chip, countsText, detailRows, formatNote, listRows, situationViews, type SituationView } from '../src/card/view.js';
import { CommandRefused, LibraryConflict, UnknownReference } from '../src/errors.js';
import { countText } from '../src/plural.js';
import type { ExperimentLab } from '../src/experiment.js';
import { situationCoverage } from '../src/miner/cards.js';
import { clip, safeText } from '../src/text.js';
import { ownerMessages, row, runStamp } from './conversation.ts';
import { displayFor, isInteractive, NeedsOwner, recordErrorText, requireInteractive } from './lab-ui.ts';
import { situationOutput, situationsOutput } from './model-output.ts';
import type { LabLease, SessionOperations } from './operations.ts';
import { recordFor } from './records.ts';
import type { Feed } from './render/feed.ts';
import { situationRows } from './render/situation.ts';
import { TOOL } from './steps.ts';

/*
 * The chat's hands on a draft of situations (docs/design/card-v2-spec.md §5): one read tool and one change tool, a thin adapter over the
 * owner commands of src/card/commands.ts. The model names a situation by its number and a fact or a duty by the id the
 * read tool showed (f2, e1); it never carries hashes or passes an approval. Every change is the owner's only after
 * «Записать» in a native dialog that shows it exactly; words the owner wrote in their own messages never stand in for
 * that dialog — they only let its receipt say the wording is the owner's. A changed situation is checked again within
 * the agreed calls — in the row of the change when that is quick, as a later message when it is not. Answers to a
 * situation's question go through the decisions (decide-tool).
 */

export interface SituationHost {
  inlineCheckMs: number;
  operations: SessionOperations;
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
  /** A check too long for the row of its change: it goes on in the session and reports back as a message. */
  backgroundCheck: (ctx: ExtensionContext, owned: LabLease, id: string, card: number | undefined) => void;
}

/** What the coverage of the logs' topics is read from: a card draft and the imports its cards cite. */
export interface CoverageSource { library: LibraryV2; evidence: CardEvidence }

/** The situations of a record with their status now; a card draft reads its imports for that. `running`: a check of them is going on. */
export async function situationsNow(lab: ExperimentLab, record: Experiment, running = false): Promise<{ record: Experiment; views: SituationView[]; running: boolean; topics?: CoverageSource }> {
  if (record.librarySnapshot?.formatVersion !== 2) return { record, views: situationViews(record, { maxTurns: record.settings.maxTurns }), running: false };
  const { experiment, library, evidence, numbers } = await lab.cardContext(record.id);
  return { record: experiment, views: situationViews(experiment, { evidence, numbers, maxTurns: experiment.settings.maxTurns }), running, topics: { library, evidence } };
}

/** «15 ситуаций покрывают 9 из 11 тем — 94% диалогов» and the topics without a ready situation; undefined without the logs' topics. */
function coverageOf(source: CoverageSource | undefined, maxTurns: number): { line: string; uncovered: string | undefined } | undefined {
  if (!source) return undefined;
  return situationCoverage(source.library, cardStatuses({ library: source.library, evidence: source.evidence, maxTurns }));
}

/** A situation's status as the answer of a change: «Ситуация 2 готова». */
export function statusText(view: SituationView, running = false): string {
  const status = view.status === 'checking' && running ? 'проверяется' : { ready: 'готова', needs_owner: 'ждёт вашего ответа', unusable: 'не подходит для теста', checking: 'ждёт проверки' }[view.status];
  return `Ситуация ${view.number} ${status}${view.version && view.status === 'ready' ? ` · версия ${view.version}` : ''}`;
}

/**
 * The situations in the chat (docs/design/ui-spec.md §4.10): the counts, then who waits for an answer or how much of the logs'
 * topics the ready ones cover; every situation in three lines on expand. `next` is the last summary row when the
 * caller has a step to name.
 */
export function situationsFeed(record: Experiment, views: SituationView[], running = false, topics?: CoverageSource, next?: string): Feed {
  const waiting = views.filter(view => view.status === 'needs_owner');
  const note = formatNote(record);
  const coverage = coverageOf(topics, record.settings.maxTurns);
  const waitingLine = waiting.length ? `Ждут ответа: ${waiting.slice(0, 3).map(view => `${view.number} ${clip(view.brief.title, 60)}`).join(' · ')}${waiting.length > 3 ? ` · ещё ${waiting.length - 3}` : ''}` : undefined;
  const lines = [waitingLine, coverage?.line, note].filter((line): line is string => !!line);
  const rulebook = topics && shownRulebook(topics.library);
  return {
    tone: waiting.length ? 'warning' : 'success',
    rows: [row(countsText(views), 'text', true), ...lines.slice(0, next ? 1 : 2).map(line => row(line, 'muted')), ...(next ? [row(next, 'muted')] : [])],
    // The coverage line may already stand in the summary; its uncovered topics are named on expand.
    more: [...(coverage?.uncovered ? [row(coverage.uncovered, 'muted'), row('')] : []), ...(rulebook ? [...rulebookLines(rulebook).map(line => row(line, 'muted')), row('')] : []),
      ...situationRows(views.flatMap(view => listRows(view, { running })))],
    expand: `все ${views.length}: что пишет клиент и что должен агент`,
  };
}

/** One situation in the chat: its title and status, what the customer writes and the first duty, its question; the whole brief — and «d» when asked — on expand. */
export function situationFeed(view: SituationView, options: { running?: boolean; details?: boolean } = {}): Feed {
  const { brief } = view;
  return {
    tone: view.status === 'ready' ? 'success' : 'warning',
    rows: [row(`${view.number}  ${brief.title} · ${chip(view, options.running).text}`, 'text', true),
      row(`Клиент: «${clip(brief.writes, 120)}» · Агент должен: ${clip(brief.must[0]?.text ?? '—', 120)}`),
      ...(view.question ? [row(`Вопрос: ${view.question.text}`, 'warning')] : view.problems[0] ? [row(`Не подходит: ${view.problems[0]}`, 'muted')] : [])],
    more: situationRows([...briefRows(view, { running: options.running }), ...(options.details ? [{ role: 'blank' as const, indent: 0, text: '' }, ...detailRows(view)] : [])]),
    expand: 'вся ситуация',
  };
}

const closed = { additionalProperties: false } as const;
const runRef = Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'The run or draft id from an earlier Agent Lab result. Omit for the one the project works on now.' }));
const number = Type.Integer({ minimum: 1, maximum: 999, description: 'The situation number, as shown.' });
const text = (max: number, description: string) => Type.Optional(Type.String({ minLength: 1, maxLength: max, description }));
const factId = Type.String({ pattern: '^f[0-9]{1,3}$', description: 'A fact id (f1…).' });
const when = Type.Enum(['initial', 'on_request', 'unknown'], { description: 'initial: in the first message; on_request: when the agent asks; unknown: does not know it.' });
const turn = Type.Union([Type.Object({ kind: Type.Enum(['change_intent', 'report']), after: Type.String({ minLength: 1, maxLength: 300 }),
  says: Type.String({ minLength: 1, maxLength: 1000 }) }, closed), Type.Null()], { description: 'The customer\'s late turn: says it after the agent does `after`; null: none.' });

/** A requirement id as the lab stores it (ids.ts): the model is held to the stored shape before any command is built. */
const ruleId = Type.String({ pattern: identifierPattern });
const ruleIds = Type.Array(ruleId, { minItems: 1, maxItems: 20 });
/** One change of one situation, or of the set's rulebook: what the model may ask the owner's draft to become. */
const change = Type.Union([
  Type.Object({ kind: Type.Literal('fact'), fact: Type.Optional(factId), label: text(120, 'What the fact is, e.g. «Номер терминала»; without fact, a new one.'),
    value: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Number(), Type.Boolean()])), when: Type.Optional(when), remove: Type.Optional(Type.Literal(true)) }, closed),
  Type.Object({ kind: Type.Literal('duty'), duty: Type.String({ pattern: '^e[0-9]{1,2}$', description: 'A duty id (e1…).' }), text: text(300, 'What the agent must do, as an infinitive.'),
    rules: Type.Optional(Type.Array(ruleId, { minItems: 1, maxItems: 3, description: 'Requirement ids of the owner rules it rests on.' })),
    appliesWhen: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()], { description: 'When it applies; null: always.' })), remove: Type.Optional(Type.Literal(true)) }, closed),
  Type.Object({ kind: Type.Literal('client'), wants: text(300, 'What the customer wants.'), writes: text(3000, 'Their exact first message.'), leaves: text(300, 'When they leave.') }, closed),
  Type.Object({ kind: Type.Literal('turn'), turn }, closed),
  Type.Object({ kind: Type.Literal('similar'), differs: Type.Union([
    Type.Object({ kind: Type.Literal('when'), fact: factId, when, writes: text(3000, 'A new first message without the value.') }, closed),
    Type.Object({ kind: Type.Literal('opening'), writes: Type.String({ minLength: 1, maxLength: 3000 }) }, closed),
    Type.Object({ kind: Type.Literal('turn'), turn }, closed),
  ], { description: 'The one difference; the original stays as it is.' }), title: Type.Optional(Type.String({ maxLength: 160 })) }, closed),
  Type.Object({ kind: Type.Literal('reference'), reference: Type.Optional(Type.String({ maxLength: 60 })), doc: Type.Optional(Type.String({ maxLength: 500 })),
    text: Type.Optional(Type.String({ maxLength: 1000 })), proposed: Type.Optional(Type.Literal(true)), remove: Type.Optional(Type.Literal(true)) }, closed),
  Type.Object({ kind: Type.Literal('remove') }, closed),
  Type.Object({ kind: Type.Literal('unmask') }, closed),
  Type.Object({ kind: Type.Literal('rules'), operatorInstructions: Type.Optional(Type.Boolean()), bind: Type.Optional(ruleIds), unbind: Type.Optional(ruleIds) },
    { ...closed, description: 'The set\'s rulebook; omit situation.' }),
]);
const editParameters = Type.Object({ run: runRef, situation: Type.Optional(number),
  changes: Type.Array(change, { minItems: 1, maxItems: 12, description: 'One change, or several of ONE situation that fit only together.' }),
  later: Type.Optional(Type.Literal(true, { description: 'Check after the next changes, not now.' })) }, closed);
type ChangeRequest = Static<typeof change>;
/** The changes that go together as one series of one situation: what the customer knows, the duties, the customer's words, the turn. */
const SERIES = new Set<ChangeRequest['kind']>(['fact', 'duty', 'client', 'turn']);

export function registerSituationTools(pi: Pick<ExtensionAPI, 'registerTool'>, host: SituationHost): void {
  pi.registerTool({
    ...displayFor(TOOL.cards), name: TOOL.cards, label: 'Show situations',
    description: 'Read-only. The situations of the draft (or of a run): number, title, status (ready, needs_owner, unusable, checking) and, for one waiting for the owner, its question with numbered answers and the decision key agent_lab_decide answers it with. situation: one situation whole — what the customer wants, writes first, knows (fact ids f1…) and when they leave; what the agent must do (duty ids e1…), each with the owner\'s rule; details: also how it is run and judged. Read a situation before changing it.',
    parameters: Type.Object({ run: runRef, situation: Type.Optional(number), details: Type.Optional(Type.Boolean()) }, closed),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const lab = host.reading(directory);
        const found = recordFor(await lab.list(), params.run, 'situations');
        const job = host.operations.current(directory);
        const { record, views, running, topics } = await situationsNow(lab, found, job?.kind === 'assessment' && job.id === found.id);
        const readOnly = record.librarySnapshot?.formatVersion !== 2 || record.phase !== 'review' || record.trials.length > 0;
        if (params.situation === undefined) {
          const rulebook = topics && shownRulebook(topics.library);
          return host.feedResult(callId, situationsOutput(record, views, { readOnly, ...(rulebook ? { rulebook: { lines: rulebookLines(rulebook), operatorInstructions: rulebook.kinds.find(item => item.kind === 'operator_procedure')!.binds } } : {}) }),
            situationsFeed(record, views, running, topics), `Ситуации · ${runStamp(record)}`);
        }
        const view = views.find(item => item.number === params.situation);
        if (!view) throw new NeedsOwner('unknown_reference', `Ситуации №${params.situation} нет. Спросите владельца, какая нужна.`, views.map(item => `${item.number}. ${item.brief.title}`).slice(0, 15),
          `Ситуации ${params.situation} нет — какую открыть?`);
        return host.feedResult(callId, situationOutput(record, view, { readOnly, ...(params.details ? { details: view.details } : {}) }),
          situationFeed(view, { running, ...(params.details ? { details: true } : {}) }), `Ситуация ${view.number} · ${runStamp(record)}`);
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
  pi.registerTool({
    ...displayFor(TOOL.edit), name: TOOL.edit, label: 'Change a situation',
    description: 'Changes one situation of the draft, or the rulebook of the whole set; the owner confirms every change in a native dialog that shows it exactly — wording taken word for word from the owner\'s own message is marked as theirs, never written without that dialog. Each item of changes has a kind: rules — which rules bind the bot: operatorInstructions (instructions for human operators as a whole), bind/unbind (single requirement ids the bot must or no longer must follow), no situation; fact — what the customer knows (fact id; when; label/value rewrite it, without a fact id they add one; remove); duty — what the agent must do (duty id; text, rules, appliesWhen; remove; one duty always stays); client — what the customer wants, writes first or when they leave; turn — the customer\'s late turn (null removes it); reference — what code checks besides the judge: doc (the knowledge-base article id the agent must actually retrieve, as its adapter names it) and/or text (the expected fact; its values are checked by code, its meaning by the judge); reference id to change one, without it a new one; never rewrite a duty\'s text to express this — a duty is only ever judged by the reply; proposed:true when you suggest it yourself; reference id with remove to drop one; similar — a new situation with exactly one difference, the original unchanged; remove — takes the situation out, only when the owner asked for exactly that; unmask — Lab writes plausible values where the de-identified log left marks (#, *): offer it when a situation is unusable for that reason. Fact, duty, client and turn changes of one situation that fit only together (a refusal says «передайте вместе с …») go in one call: checked once, confirmed once. A change after a run goes into a fresh draft of the same set: the finished run never changes, say so in one phrase. The changed situation is checked again within the agreed calls; several situations changed in one message: later:true on every one but the last.',
    parameters: editParameters,
    executionMode: 'sequential',
    execute: (callId, params, signal, _onUpdate, ctx) => changeSituation(host, callId, ctx, signal, params),
  });
}

/** A change named something the draft does not hold: what the owner is asked. */
const UNKNOWN_WORDS: Record<UnknownReference['what'], string> = {
  card: 'Такой ситуации в черновике нет — какую вы имели в виду?',
  fact: 'У этой ситуации нет такого факта — какой вы имели в виду?',
  expectation: 'У этой ситуации нет такого пункта «агент должен» — какой вы имели в виду?',
  choice: 'У этого вопроса нет такого ответа — какой вы выбираете?',
  requirement: 'Такого правила в ваших материалах нет — какое вы имели в виду?',
};

/** What followed a change: the situation checked again (here, or later as a message), or why not now. */
type CheckState = { status: 'none' | 'done' | 'running' | 'skipped' } | { status: 'needs_budget'; pendingJobs: number; remainingCalls: number } | { status: 'failed'; message: string };
const CHECK_TEXT = (check: CheckState): string | undefined => check.status === 'running' ? 'Проверяю изменённую ситуацию в фоне — итог придёт сюда отдельным сообщением. Можно продолжать.'
  : check.status === 'skipped' ? 'Проверю после последней правки серии.'
  : check.status === 'needs_budget' ? `Чтобы проверить изменённую ситуацию, нужно вызовов модели: ${check.pendingJobs}, а в лимите осталось ${check.remainingCalls}. Поднять лимит — ваше решение: скажите «подними лимит».`
  : check.status === 'failed' ? `Проверка не завершилась: ${check.message} Правка сохранена.` : undefined;

/** The situation the model named, in the draft a change goes to; a finished run is never changed, its change goes into a fresh draft of the same set. */
async function draftSituation(lab: ExperimentLab, record: Experiment, number: number) {
  if (record.librarySnapshot?.formatVersion !== 2) throw new CommandRefused(convertible(record) ? 'Это черновик старого формата: его ситуации не меняются. Их можно продолжить в новом формате (решение «Продолжить в новом формате»), а старый черновик останется как есть.'
    : record.librarySnapshot ? 'Это ситуации старого формата: их можно посмотреть и повторить принятые, но не изменить.'
    : 'Ситуации этого прогона записаны до наборов ситуаций: их можно посмотреть и повторить, но не изменить.');
  const target = await lab.editableCards(record.id);
  const context = await lab.cardContext(target.id);
  const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
  const view = views.find(item => item.number === number);
  if (!view) throw new UnknownReference('card', views.map(item => `№${item.number} ${clip(item.brief.title, 60)}`), `Ситуации №${number} в черновике нет.`);
  return { target, context, view };
}

/**
 * Whether `text` stands in `message` word for word: after the one normalisation and never inside a longer word —
 * «обещать возврат» is in «не должен обещать возврат денег», «а» is not in «Агент». The same whole-word reading the
 * checks of a card use (card/checks.ts contains).
 */
export const saidWordForWord = (message: string, text: string): boolean => contains(message, text);

/** Why a change is not written without a terminal: the owner's own way on, never a command line that would consent for them. */
const DECIDES_IN_TERMINAL = 'Изменение ситуации записывается только после вашего «Записать» в интерактивном терминале Pi: откройте Agent Lab там (agent-lab chat) и повторите просьбу. Ничего не записано.';

/**
 * The owner's decision on a command: the exact change in a native dialog, and only «Записать» makes it the owner's.
 * Words the owner wrote in their own messages never replace that dialog — a quoted fragment can turn a rule inside
 * out. When every wording of the change stands word for word in what the owner wrote, the dialog says so, and after
 * «Записать» the receipt keeps them as the owner's words.
 */
async function decide(ctx: ExtensionContext, lab: ExperimentLab, id: string, command: CardCommand, heading: string): Promise<{ prepared: Prepared; grant: HostGrant } | undefined> {
  const words = wordsOf(command);
  const said = ownerMessages(ctx);
  const theirs = words.length > 0 && words.every(text => said.some(message => saidWordForWord(message, text)));
  const joined = words.join('\n');
  const prepared = await lab.prepareCardCommand(id, command, { via: 'pi-confirm', ...(theirs && joined.length <= 1000 ? { ownerWords: joined } : {}) });
  requireInteractive(ctx, DECIDES_IN_TERMINAL);
  const lines = [...prepared.diff.flatMap(item => item.changes.map(change => `${item.number}  ${changeText(change)}`)),
    ...(prepared.rulebook ? rulebookChangeLines(prepared.rulebook.before, prepared.rulebook.after, prepared.next.requirements, prepared.rulebook.flagged) : [])];
  const picked = await ctx.ui.select(safeText([heading, ...(lines.length ? ['', ...lines] : []),
    ...(theirs ? ['', 'Формулировка — ваши слова из разговора.'] : []), '', 'Записать это от вашего имени?'].join('\n')), ['Записать', 'Не записывать']);
  if (picked !== 'Записать') return undefined;
  // Confirmed natively either way; the basis names the owner's words only where the change is nothing but a wording.
  return { prepared, grant: hostGrant(prepared, theirs && prepared.authority === 'owner-words' ? 'words' : 'confirmed') };
}

/** The claims a change opened are checked within the agreed calls: here when it is quick, as a later message when it is not, or later on the owner's word. */
async function recheck(host: SituationHost, ctx: ExtensionContext, owned: LabLease, id: string, number: number | undefined, later: boolean, signal: AbortSignal | undefined): Promise<CheckState> {
  const { decision, before } = await owned.lab.recheckCards(id, { defer: later });
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
  return after.phase === 'review' && !after.error ? { status: before.usage.calls === after.usage.calls ? 'none' : 'done' }
    : { status: 'failed', message: recordErrorText(after.error ?? after.message) ?? 'причина не записана.' };
}

/**
 * «Свод правил» of the set: which kinds of rules, and which single rules, bind the bot. The owner confirms the exact
 * change natively; the situations whose expectations lose their rule come back to the owner with a question.
 */
async function changeRulebook(host: SituationHost, callId: string, ctx: ExtensionContext, found: Experiment, request: Extract<ChangeRequest, { kind: 'rules' }>): Promise<AgentToolResult<unknown>> {
  if (found.librarySnapshot?.formatVersion !== 2) throw new CommandRefused('У ситуаций этого прогона нет свода правил: он есть у наборов нового формата.');
  if (request.operatorInstructions === undefined && !request.bind && !request.unbind) throw new CommandRefused('Скажите, что изменить в своде правил: инструкции для операторов или отдельные правила.');
  const owned = await host.open(ctx.cwd);
  try {
    await owned.lab.init();
    const target = await owned.lab.editableCards(found.id);
    const { library } = await owned.lab.cardContext(target.id);
    const current = rulebookOf(library);
    const kinds = request.operatorInstructions === undefined ? current : withKind(current, 'operator_procedure', request.operatorInstructions);
    const command: CardCommand = { kind: 'set_rulebook', rulebook: withRules(kinds, { ...(request.bind ? { include: request.bind } : {}), ...(request.unbind ? { exclude: request.unbind } : {}) }) };
    const decided = await decide(ctx, owned.lab, target.id, command, 'Свод правил — по каким правилам судить бота');
    if (!decided) return host.feedResult(callId, { applied: false, declined: true, instruction: 'The owner did not confirm. Nothing was written; do not ask again unless they do.' },
      { tone: 'warning', rows: [row('Не записано: вы не подтвердили.')] }, 'Свод правил не изменён');
    const { library: next } = await owned.lab.applyCardCommand(target.id, decided.prepared, decided.grant);
    const changes = rulebookChangeLines(decided.prepared.rulebook!.before, decided.prepared.rulebook!.after, next.requirements, decided.prepared.rulebook!.flagged);
    const shown = shownRulebook(next);
    return host.feedResult(callId, { run: target.id, applied: true, changes, ...(shown ? { rulebook: rulebookLines(shown) } : {}),
      ...(decided.prepared.rulebook!.flagged.length ? { waiting: decided.prepared.rulebook!.flagged, instruction: 'These situations now ask the owner whether the bot must follow the rule their expectation rests on; the answers go through agent_lab_decide.' } : {}) },
    { tone: 'success', rows: [row('Свод правил записан.', 'text', true), ...changes.slice(0, 3).map(line => row(line))],
      ...(shown ? { more: rulebookLines(shown).map(line => row(line, 'muted')), expand: 'свод правил' } : {}) }, `Свод правил · ${runStamp(found)}`);
  } finally { await owned.close(); }
}

/** The command a change stands for, with the heading of its dialog; refused with the reason when the change cannot be made as asked. */
function commandOf(request: ChangeRequest, view: SituationView, library: LibraryV2): { command: CardCommand; heading: string } {
  const title = `Ситуация ${view.number} «${view.brief.title}»`;
  switch (request.kind) {
    case 'fact': {
      const card = library.cards.find(item => item.id === view.id)!;
      const fact = request.fact === undefined ? undefined : card.client.knows.find(item => item.id === request.fact);
      if (request.fact !== undefined && !fact) throw new UnknownReference('fact', card.client.knows.map(item => `${item.id} ${item.label}`), `У ситуации №${view.number} нет факта ${request.fact}.`);
      const heading = `${title}: что знает клиент`;
      if (request.remove) {
        if (!fact) throw new CommandRefused('Скажите, какой факт убрать.');
        return { command: { kind: 'remove_fact', cardId: card.id, factId: fact.id }, heading };
      }
      if (request.label !== undefined || request.value !== undefined) {
        const disclosed = request.when ?? fact?.disclosure;
        if (!disclosed) throw new CommandRefused('Скажите, когда клиент называет новый факт: сразу, если спросят, или не знает.');
        return { command: { kind: 'set_fact', cardId: card.id, ...(fact ? { factId: fact.id } : {}), label: request.label ?? fact!.label,
          ...(request.value !== undefined ? { value: request.value } : fact?.value !== undefined ? { value: fact.value } : {}), disclosure: disclosed }, heading };
      }
      if (!fact || !request.when) throw new CommandRefused('Скажите, что изменить в факте: когда клиент его называет, его текст или убрать его.');
      return { command: { kind: 'set_fact_disclosure', cardId: card.id, factId: fact.id, disclosure: request.when }, heading };
    }
    case 'duty': {
      const heading = `${title}: что должен агент`;
      return request.remove ? { command: { kind: 'remove_expectation', cardId: view.id, expectationId: request.duty }, heading }
        : { command: { kind: 'edit_expectation', cardId: view.id, expectationId: request.duty, ...(request.text !== undefined ? { text: request.text } : {}),
          ...(request.rules ? { requirementIds: request.rules } : {}), ...(request.appliesWhen !== undefined ? { appliesWhen: request.appliesWhen } : {}) }, heading };
    }
    case 'client': return { command: { kind: 'edit_client', cardId: view.id, ...(request.wants !== undefined ? { wants: request.wants } : {}),
      ...(request.writes !== undefined ? { writes: request.writes } : {}), ...(request.leaves !== undefined ? { leaves: request.leaves } : {}) }, heading: `${title}: клиент` };
    case 'turn': return { command: { kind: 'set_turn', cardId: view.id, turn: request.turn }, heading: `${title}: поворот` };
    case 'similar': {
      const { differs } = request;
      return { heading: `Похожая на ситуацию ${view.number} «${view.brief.title}»`, command: { kind: 'add_similar', parentId: view.id, ...(request.title?.trim() ? { title: request.title } : {}),
        change: differs.kind === 'when' ? { kind: 'disclosure', factId: differs.fact, disclosure: differs.when, ...(differs.writes !== undefined ? { writes: differs.writes } : {}) } : differs } };
    }
    case 'reference': return { command: { kind: 'set_references', cardId: view.id, references: referencesAfter(request, library.cards.find(item => item.id === view.id)!) },
      heading: `${title}: что проверяется кодом` };
    case 'remove': return { command: { kind: 'remove_card', cardId: view.id }, heading: `Убрать ситуацию ${view.number} «${view.brief.title}» из черновика?` };
    case 'rules': throw new Error('The rulebook is changed for the whole set, not through one situation.');
    case 'unmask': throw new Error('Masked values are proposed by the lab, not built here.');
  }
}

/**
 * The card's references after one change: a new one gets the next free id; an owner's change is theirs and confirmed, a
 * reference the model suggests waits for the owner. Changing a reference keeps what the change does not name.
 */
function referencesAfter(request: Extract<ChangeRequest, { kind: 'reference' }>, card: Card): Reference[] {
  const current = card.references ?? [];
  const existing = request.reference === undefined ? undefined : current.find(item => item.id === request.reference);
  if (request.reference !== undefined && !existing) throw new CommandRefused(`У ситуации №${card.number} нет эталона ${request.reference}${current.length ? `; есть: ${current.map(item => item.id).join(', ')}` : ''}.`);
  if (request.remove) {
    if (!existing) throw new CommandRefused('Скажите, какой эталон убрать.');
    return current.filter(item => item.id !== existing.id);
  }
  const doc = request.doc ?? existing?.source?.doc, chunk = request.doc === undefined ? existing?.source?.chunk : undefined;
  const text = request.text ?? existing?.text;
  if (doc === undefined && text === undefined) throw new CommandRefused('Скажите, что проверять кодом: статью, которую агент должен найти, и/или ожидаемый ответ.');
  const origin = request.proposed ? 'proposed' as const : 'owner' as const;
  const prefix = origin === 'proposed' ? 'proposed' : 'owner';
  const id = existing?.id ?? Array.from({ length: 5 }, (_, index) => `${prefix}_${index + 1}`).find(candidate => !current.some(item => item.id === candidate))!;
  const reference: Reference = { id, origin, confirmed: origin !== 'proposed', ...(doc !== undefined ? { source: { doc, ...(chunk !== undefined ? { chunk } : {}) } } : {}),
    ...(text !== undefined ? { text } : {}) };
  return existing ? current.map(item => item.id === existing.id ? reference : item) : [...current, reference];
}

/** Lab's values over the situation's masking marks: one model call, made only where the owner can then confirm them. */
async function unmaskOf(ctx: ExtensionContext, lab: ExperimentLab, id: string, view: SituationView): Promise<{ command: CardCommand; heading: string }> {
  requireInteractive(ctx, 'Подставленные значения подтверждает владелец в интерактивном терминале Pi.');
  return { command: await lab.proposeFill(id, view.id), heading: `Ситуация ${view.number} «${view.brief.title}»: Lab подставит значения вместо обезличенных` };
}

/** Several changes of one situation as one series: checked together as they leave it, confirmed and recorded once. */
function seriesOf(requests: readonly ChangeRequest[], view: SituationView, library: LibraryV2): { command: CardCommand; heading: string } {
  if (requests.some(request => !SERIES.has(request.kind))) {
    throw new CommandRefused('Вместе передаются только правки одной ситуации: что знает клиент, что должен агент, слова клиента и поворот. Похожую ситуацию, удаление, подстановку значений и свод правил — отдельно.');
  }
  const changes = requests.map(request => {
    const { cardId: _card, ...change } = commandOf(request, view, library).command as Extract<CardCommand, { cardId: string }>;
    return cardChangeSchema.parse(change);
  });
  return { command: { kind: 'edit_card', cardId: view.id, changes },
    heading: `Ситуация ${view.number} «${view.brief.title}»: ${countText(changes.length, ['изменение', 'изменения', 'изменений'])} вместе` };
}

/**
 * One change of one situation: the draft, the owner's decision, the new revision, the check, and an answer with
 * «было → стало» and the situation's status now.
 */
async function changeSituation(host: SituationHost, callId: string, ctx: ExtensionContext, signal: AbortSignal | undefined, params: Static<typeof editParameters>): Promise<AgentToolResult<unknown>> {
  const { run, situation, later } = params;
  const requests = params.changes;
  const directory = resolve(ctx.cwd, '.agent-lab');
  let handedOver = false;
  try {
    const [request] = requests;
    if (!request) throw new CommandRefused('Скажите, что изменить.');
    const found = recordFor(await host.reading(directory).list(), run, 'situations');
    if (request.kind === 'rules' && requests.length === 1) return await changeRulebook(host, callId, ctx, found, request);
    if (situation === undefined) throw new CommandRefused('Скажите, какую ситуацию изменить: её номер.');
    const owned = await host.open(ctx.cwd);
    try {
      await owned.lab.init();
      const { target, context, view } = await draftSituation(owned.lab, found, situation);
      const built = requests.length > 1 ? seriesOf(requests, view, context.library)
        : request.kind === 'unmask' ? await unmaskOf(ctx, owned.lab, target.id, view)
        : commandOf(request, view, context.library);
      const decided = await decide(ctx, owned.lab, target.id, built.command, built.heading);
      if (!decided) return host.feedResult(callId, { applied: false, declined: true, instruction: 'The owner did not confirm. Nothing was written; do not ask again unless they do.' },
        { tone: 'warning', rows: [row('Не записано: вы не подтвердили.')] }, `Ситуация ${view.number} не изменена`);
      await owned.lab.applyCardCommand(target.id, decided.prepared, decided.grant);
      // A new situation (a similar one) is read by its id: its number is new.
      const subject = built.command.kind === 'add_similar' ? decided.prepared.scope[0]! : view.id;
      const removed = built.command.kind === 'remove_card';
      const check = removed ? { status: 'none' as const } : await recheck(host, ctx, owned, target.id, view.number, !!later, signal);
      handedOver = check.status === 'running';
      const fresh = await host.reading(directory).cardContext(target.id);
      const after = situationViews(fresh.experiment, { evidence: fresh.evidence, numbers: fresh.numbers, maxTurns: fresh.experiment.settings.maxTurns }).find(item => item.id === subject);
      const changes = decided.prepared.diff.flatMap(item => item.changes.map(changeText));
      const copied = target.copiedFrom && target.copiedFrom !== target.id;
      const headline = removed ? `Ситуация ${view.number} убрана из черновика; исходные разговоры и прошлые прогоны не тронуты.`
        : after ? statusText(after, check.status === 'running') : `Ситуация ${view.number} изменена.`;
      // The answer first, then what changed; the rest of what the owner may need to know shares the last line.
      const tail = [copied ? 'прошлый прогон не меняется: правка — в черновике того же набора' : '', CHECK_TEXT(check) ?? ''].filter(Boolean).join('; ');
      const feed: Feed = { tone: removed || after?.status === 'ready' ? 'success' : 'warning',
        rows: [row(headline, 'text', true), ...changes.slice(0, 2).map(text => row(text)), ...(changes.length > 2 ? [row(`и ещё ${changes.length - 2}`, 'muted')] : []),
          ...(tail ? [row(tail.charAt(0).toLocaleUpperCase('ru') + tail.slice(1), 'muted')] : [])],
        ...(after ? { more: situationRows(briefRows(after, { running: check.status === 'running' })), expand: 'вся ситуация' } : {}) };
      const output = after ? situationOutput(fresh.experiment, after, { applied: true, changes, check }) : { run: target.id, applied: true, changes, check };
      return host.feedResult(callId, { ...output, ...(copied ? { unchangedRun: target.copiedFrom, instruction: 'The finished run never changes, so the change went into a fresh draft of the same set. Say so in one phrase and keep working on this draft.' } : {}),
        ...(check.status === 'running' ? { checkNote: 'The check continues in the background and reports back as a message. Do not wait for it or poll; further changes are fine.' } : {}) },
        feed, `Ситуация ${after?.number ?? view.number} · ${runStamp(found)}`);
    } finally { if (!handedOver) await owned.close(); }
  } catch (error) {
    if (error instanceof CommandRefused) return host.feedResult(callId, { applied: false, refused: error.message, instruction: 'Nothing was written. Tell the owner why in one sentence; do not repeat the same call.' },
      { tone: 'warning', rows: [row(safeText(error.message))] }, 'Не записано');
    if (error instanceof LibraryConflict) return host.feedResult(callId, { applied: false, stale: true, message: error.message, instruction: 'The draft changed since it was read. Read it again with agent_lab_cards and decide on the fresh state.' },
      { tone: 'warning', rows: [row(safeText(error.message)), row('Ничего не записано.', 'muted')] }, 'Ситуации изменились');
    // The model reads what there is, by the ids a change names; the owner reads the question in their words, never an id.
    if (error instanceof UnknownReference) return host.askOwner(callId, new NeedsOwner('unknown_reference', `${error.message} Есть: ${error.allowed.slice(0, 12).join('; ')}.`, error.allowed.slice(0, 12),
      UNKNOWN_WORDS[error.what]));
    return host.askOwner(callId, error);
  }
}
