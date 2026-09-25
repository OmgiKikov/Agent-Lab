import { fingerprint, type AgentSpec, type Experiment, type Source } from '../contracts.js';
import { Stopped } from '../errors.js';
import type { CallContext, Runtime } from '../runtime.js';
import { MAX_PREPARATION_PARALLEL, PREPARATION_PARALLEL, RECORD_REQUIREMENT_LIMIT, SOURCES_PER_DIALOGUE, workInputIssue } from '../limits.js';
import { ProviderFailure, type ProviderFailureKind } from '../llm/model-call.js';
import { StructuredTaskError } from '../llm/structured.js';
import { withTrafficTopic } from '../miner/cards.js';
import { replacementFor, unitTopic, type LogSample } from '../miner/plan.js';
import { countText } from '../plural.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { libraryHash } from '../scenario-library.js';
import { selectScenarioSources } from '../scenario-sources.js';
import type { ExperimentStore } from '../store.js';
import { clip } from '../text.js';
import { PROPOSAL_ATTEMPTS, promptsOversize } from './budget.js';
import { importEvidence, loggedMessages, type CardEvidence } from './checks.js';
import { addCard, createLibraryV2, recordClaims, replaceCard, requireLibraryV2, withRequirements } from './library.js';
import { rulebookOf } from './rulebook.js';
import { bindProposal, cardProposalProblem, cardProposalSchema, proposalCall, proposalPayload, proposalRequirements, type CardProposalRequest, type ProposalCall } from './proposal.js';
import { blockedClaims, claimReceipts, pendingClaims, reviewedBrief, reviewRequests, ReviewTooLarge, type CardReview, type ReviewContext } from './review.js';
import type { Card, CardPreparation, LibraryV2, PreparationProgress } from './schema.js';

/*
 * Preparing situations — from dialogues of an import, or from the owner's rules alone (docs/design/card-v2-spec.md §8, C9):
 *
 *   each unit:  (a knowledge base too large for one call) articles chosen from its table of contents
 *               ─► ONE proposal that reads the dialogue, ALL the agent's prompts and the articles in full,
 *                  and cites for every duty the sentences it rests on
 *               ─► binding (each cited sentence becomes a rule of the library) + checks ─► review
 *               ─► a card the reviewer blocked: ONE revision with the reviewer's reasons ─► binding + checks ─► review
 *
 * There is no step that writes the rules out first: the prompts and the articles are the rules, and a duty cites them
 * verbatim. Over the request's cap the last articles give way; the prompts and the customer's messages never do, and
 * prompts too large for any request refuse the preparation before anything is paid (budget.ts promptsOversize).
 * Every finished step is saved with the draft, so a resume continues a unit from its next step and never pays for a
 * finished one again. A paid call names its unit and step first; a call that dies in flight leaves the name behind,
 * and a resume never repeats it, because its cost is unknown. Each unit has one allowance of proposal calls, repairs
 * included, that survives a resume.
 *
 * How a step's failure ends, by what is known of its cost (llm/model-call.ts ProviderDelivery):
 *
 *   the answers never passed Lab's checks, or the request is over the model's window ─► the unit is left out with why;
 *                                                                     its seat goes to the next conversation of its topic
 *   turned away before any answer began — by the call budget or by the provider ─► no charge in doubt: the unit waits in
 *                                     the queue, no new unit is taken, the units at work finish and are saved
 *   cut off after its answer began, or by a stop ─► its cost is unknown: the preparation stops, and the resume leaves
 *                                                   the unit out, never asking again
 *
 * Several units are worked on at once (`parallel`), taken in plan order. The draft does not depend on which unit
 * finishes first: each unit's card step — its card with the rules it cites, or why it makes none, with the replacement
 * it calls in — lands in the order the units were taken, so the cards are numbered in plan order.
 *
 *   unit 1: read ──► propose ──► card №1 ──► review
 *   unit 2: read ──► propose ─ waits for unit 1 ─► card №2 ──► review
 *   unit 3: read ─ waits for unit 2 ─► propose (it is offered the cards made before it) ──► card №3 ──► review
 */

/** The checkpoint's protocol. `cards-v1` grounded the rules before the proposals; its drafts are read and checked, never continued. */
export const CARD_PROTOCOL = 'cards-v2';
const PREVIOUS_PROTOCOL = 'cards-v1';
const PREVIOUS_PREPARATION = 'Эта подготовка сделана прежней версией Lab — подготовьте заново.';
/** Later customer messages one card can account for. */
const LATER_MESSAGES = 60;
const CARD_LIMIT = 200;

/** The agent a run evaluates when the owner names none: it runs outside Lab with its own instructions and tools. Surfaces name it by how it is started. */
export const EXTERNAL_AGENT: AgentSpec = { name: 'External agent', instructions: 'The agent under evaluation runs outside Agent Lab and keeps its own instructions and tools.', tools: [] };

/** The agent label of a prepared draft: the owner's, or the external agent under test. Set once, by the first preparation. */
function ensureAgentRevision(record: Experiment, agent: AgentSpec | undefined): void {
  if (record.revisions.length) return;
  const spec = agent ?? EXTERNAL_AGENT;
  const baseline = { id: fingerprint(spec), parentId: null, spec, hypothesis: 'Конфигурация агента для библиотеки сценариев.', createdAt: new Date().toISOString() };
  record.revisions = [baseline]; record.selectedRevisionId = baseline.id;
}

/** What a preparation plan was made from; limits and the time budget may change between resumes, nothing else. */
export function preparationInputHash(record: Experiment, protocol: string): string {
  const { maxCalls: _calls, maxDurationMs: _duration, timeoutMs: _timeout, ...settings } = record.settings;
  return fingerprint({ protocol, task: record.task, mode: record.mode, sources: record.sources,
    target: record.target, notes: record.notes, originalImport: record.originalImport, settings });
}

/** What a preparation turns into situations. */
export type CardPlan =
  /** Dialogues of an import: the logs' sample (miner/plan.ts) — its picks, and the conversations that replace a pick left out. */
  | { kind: 'dialogues'; batch: ImportBatch; sample: LogSample }
  /** Situations from the owner's rules alone, when there are no logs. */
  | { kind: 'rules'; count: number };

/**
 * Where a preparation saves its draft after every step: the store's publication, told to whoever follows the work
 * (lab/operation.ts). It takes the record as it is at the call (store.ts snapshot): the units at work go on changing the
 * live record while the save waits its turn, and the saved progress must name only cards of the saved library.
 */
export type DraftPublisher = Pick<ExperimentStore, 'publishLibrary'>;

/** Why a unit makes no situation, in the owner's words; the model-facing reasons of its rejected answers are not the owner's. */
const UNUSABLE_SELECTION = 'Ни один ответ модели не прошёл проверку Lab: статьи под этот разговор не выбраны.';
const UNUSABLE_PROPOSAL = 'Ни один ответ модели не прошёл проверку Lab: ситуация не составлена.';
const ALLOWANCE_SPENT = `Для этой ситуации исчерпаны ${PROPOSAL_ATTEMPTS} попыток предложить вариант, который проходит проверку Lab.`;
const UNBOUND_PROPOSAL = 'Предложенная ситуация не прошла проверку Lab и не сохранена.';
const OVER_WINDOW = 'Разговор вместе с материалами не поместился в окно модели.';
const INTERRUPTED = 'Подготовка прервалась во время платного вызова: его стоимость неизвестна, поэтому этот источник не разбирается повторно.';
/** Why a preparation stopped on an answer cut off after it began: the one failure whose cost nobody knows. */
const CUT = 'Ответ модели оборвался на середине: стоимость этого вызова неизвестна, поэтому его разговор не будет разобран повторно. Готовые ситуации сохранены; продолжите подготовку, когда связь с моделью наладится.';
/** What the provider said when it turned a request away before any answer began: nothing was billed. */
const REFUSED: Partial<Record<ProviderFailureKind, string>> = {
  'rate limit': 'Провайдер модели ограничил частоту запросов.',
  overloaded: 'Провайдер модели перегружен или временно недоступен.',
  'connection failure': 'Нет связи с провайдером модели.',
  'insufficient credit': 'У провайдера модели закончились средства: пополните счёт.',
  'access denied': 'Провайдер модели отказал в доступе: проверьте ключ и права на модель.',
  unavailable: 'Модель недоступна: проверьте ключ и права на модель.',
};

/** A unit's proposal allowance ran out: its own reason, whichever step wrapped it. */
class AllowanceSpent extends StructuredTaskError {}

/** The causes an error carries, itself first: a structured task wraps what it could not finish (llm/structured.ts). */
function* causes(error: unknown): Generator<unknown> {
  for (let cause = error, depth = 0; cause !== undefined && depth < 8; cause = cause instanceof Error ? cause.cause : undefined, depth++) yield cause;
}
/**
 * The call budget's refusal of a new call (lab/operation.ts): the calls already under way go on. A stop that aborts
 * the work — a cancel, the time limit, a budget that cuts the calls at work — reaches the preparation through its signal.
 */
function budgetStop(error: unknown): Stopped | undefined {
  for (const cause of causes(error)) if (cause instanceof Stopped) return cause.reason === 'budget' ? cause : undefined;
  return undefined;
}
/** The provider turned the request away before any answer began: nothing was billed. */
const providerRefusal = (error: unknown): ProviderFailure | undefined => error instanceof ProviderFailure && error.delivery === 'refused' ? error : undefined;
/** A request too large for the model's window: the same request is refused again, so its unit is left out. */
const overWindow = (error: unknown): boolean => providerRefusal(error)?.kind === 'context limit';
/** Why a preparation or a check stopped on the provider's refusal, and the way on: what was made is kept, nothing is lost. */
function refusalText(failure: ProviderFailure, work: 'preparation' | 'check'): string {
  const why = REFUSED[failure.kind] ?? 'Провайдер модели отклонил запрос.';
  const when = failure.retryable ? ' через несколько минут' : ', когда причина устранена';
  return work === 'preparation' ? `${why} Готовые ситуации сохранены, и ни один разговор не потерян: продолжите подготовку${when}.`
    : `${why} Проверенное сохранено: повторите проверку${when}.`;
}
/** Whether one of the owner's commands names the card: an edit, an answer, a settled doubt, a filled mark. */
const namedByOwner = (library: LibraryV2, cardId: string): boolean => library.receipts.some(({ command }) =>
  'cardId' in command ? command.cardId === cardId : command.kind === 'decide_plausible' && command.facts.some(fact => fact.cardId === cardId));
/** Why a step's answers never passed, in the owner's words. */
function unusableText(stage: 'select' | 'propose', error: StructuredTaskError): string {
  if ([...causes(error)].some(cause => cause instanceof AllowanceSpent)) return ALLOWANCE_SPENT;
  return stage === 'select' ? UNUSABLE_SELECTION : UNUSABLE_PROPOSAL;
}

/** The messages the store holds for a library's imports: what its cards cite. */
export async function storedEvidence(store: Pick<ExperimentStore, 'readImport'>, library: LibraryV2): Promise<CardEvidence> {
  return importEvidence(await Promise.all(library.imports.map(item => store.readImport(item.id))));
}

/** Review calls the cards still need: the budget question of an explicit check. */
export function pendingReviewCalls(library: LibraryV2, evidence: CardEvidence): number {
  const context = { library, evidence };
  return library.cards.reduce((sum, card) => {
    try { return sum + reviewRequests(card, pendingClaims(card, context), context).length; } catch (error) { if (error instanceof ReviewTooLarge) return sum; throw error; }
  }, 0);
}

type Stage = NonNullable<CardPreparation['activeStage']>;
type InFlight = NonNullable<CardPreparation['active']>[number];

/** Units worked on at once, as the owner asks for them: one to MAX_PREPARATION_PARALLEL. */
export function preparationParallel(value: number | undefined): number {
  const parallel = value ?? PREPARATION_PARALLEL;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PREPARATION_PARALLEL) throw new Error(`Одновременно можно готовить от 1 до ${MAX_PREPARATION_PARALLEL} ситуаций.`);
  return parallel;
}
/** A card cites at most three sentences for each of its three duties. */
const CARD_CITATIONS = 9;
/** A card the reviewer blocked and the reviewer's reason for each blocked claim. */
type Revision = { card: Card; blocked: { claim: string; reason: string }[] };

class Preparation {
  private readonly evidence: CardEvidence;
  /** Units whose step failed before any call was sent: they stay pending for a resume. */
  private readonly unsent: { unit: string; message: string }[] = [];
  /** Why no new unit is taken: the budget or the provider turned a request away. The units at work finish first. */
  private halt: Error | undefined;
  /** The units taken, in plan order, each with the moment its card step has landed. */
  private readonly turns: { unit: string; landed: Promise<void> }[] = [];
  /** The last save asked for: units at work never write the draft at the same time. */
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly record: Experiment, private readonly progress: CardPreparation, private readonly batch: ImportBatch | undefined,
    private library: LibraryV2, private readonly runtime: Runtime, private readonly ctx: CallContext, private readonly publisher: DraftPublisher,
    private published: string | undefined, private readonly parallel = 1) {
    this.evidence = importEvidence(batch ? [batch] : []);
  }

  /**
   * Saves one at a time, in the order they were asked for: every step is still saved and told to the followers. Each
   * save writes the draft as it is when its turn comes, and the next one expects exactly that library.
   */
  private publish(): Promise<void> {
    const save = this.saving.then(async () => {
      const library = this.library;
      this.record.librarySnapshot = library;
      await this.publisher.publishLibrary(this.record, library, this.published);
      this.published = libraryHash(library);
    });
    this.saving = save.catch(() => undefined);
    return save;
  }

  /** Takes a unit in plan order; the returned function says its card step has landed. */
  private take(unit: string): () => void {
    let land!: () => void;
    this.turns.push({ unit, landed: new Promise<void>(resolve => { land = resolve; }) });
    return land;
  }

  /** Resolves once every unit taken before `unit` has landed its card step; at once for a unit the pool never took. */
  private async inTurn(unit: string): Promise<void> {
    const index = this.turns.findIndex(turn => turn.unit === unit);
    await Promise.all(this.turns.slice(0, Math.max(index, 0)).map(turn => turn.landed));
  }

  /** The unit still has a call whose cost is unknown. */
  private inFlight(unit: string): boolean {
    return this.progress.active?.some(entry => entry.dialogueId === unit) ?? false;
  }

  /**
   * A proposal is offered what the cards made before it hold — their topics, or the titles already written from the
   * owner's rules — unless the logs' map names the unit's topic: such a unit proposes only after the units before it.
   */
  private readsEarlierCards(unit: string, dialogue: ImportBatch['dialogues'][number] | undefined): boolean {
    return !(dialogue && this.batch && unitTopic(this.progress, this.library, this.batch.id, unit));
  }

  /** A unit made its card, or its card was removed by the owner: processed. */
  private finish(unit: string): void {
    this.progress.pending = this.progress.pending.filter(id => id !== unit);
    if (!this.progress.processed.includes(unit)) this.progress.processed.push(unit);
  }

  /**
   * A unit that makes no situation is left out with its reason — counted once, as left out, never also as processed.
   * `replace`: the unit's own reason, so a sampled conversation gives its seat to the next one of its topic.
   */
  private exclude(unit: string, reason: string, replace = true): void {
    const { progress } = this;
    progress.excluded.push({ dialogueId: unit, reason: clip(reason, 2000) });
    progress.pending = progress.pending.filter(id => id !== unit);
    // Every unit tried so far — made, waiting or left out — is not a replacement.
    const tried = { sample: progress.sample, pending: progress.pending, processed: [...progress.processed, ...progress.excluded.map(item => item.dialogueId)] };
    const next = replace ? replacementFor(tried, unit) : undefined;
    if (next) progress.pending.push(next);
  }

  /** A proposal step spends the unit's own allowance first, then the run's budget. */
  private allowance(unit: string): CallContext {
    const attempts = this.progress.generationAttempts ??= [];
    return { ...this.ctx, beforeCall: () => {
      let spent = attempts.find(item => item.dialogueId === unit);
      if (!spent) { spent = { dialogueId: unit, calls: 0 }; attempts.push(spent); }
      if (spent.calls >= PROPOSAL_ATTEMPTS) throw new AllowanceSpent(ALLOWANCE_SPENT);
      this.ctx.beforeCall(); spent.calls++;
    } };
  }

  /**
   * One paid step. Its unit and stage are saved before the call and cleared when it returns, or when it failed with no
   * charge in doubt. Answers that never passed are told in the owner's words, whatever the model was told.
   */
  private async call<T>(unit: string | undefined, stage: Stage, work: (ctx: CallContext) => Promise<T>): Promise<T> {
    // A review of a card no unit names (an owner's copy, a converted draft) is a step of the explicit check alone.
    const entry: InFlight = unit === undefined ? { stage } : { dialogueId: unit, stage };
    (this.progress.active ??= []).push(entry);
    await this.publish();
    const base = stage === 'propose' && unit !== undefined ? this.allowance(unit) : this.ctx;
    // This step's own requests: the other units' calls move the record's count beside it. The check and the count of
    // the shared ceiling stay one synchronous step, so units at work together never pass it.
    let sent = 0, refused = false;
    const ctx: CallContext = { ...base, beforeCall: () => {
      try { base.beforeCall(); } catch (error) { refused = true; throw error; }
      sent++;
    } };
    const clear = () => {
      const active = (this.progress.active ?? []).filter(item => item !== entry);
      if (active.length) this.progress.active = active; else delete this.progress.active;
    };
    try {
      const result = await work(ctx);
      // The card is numbered where it lands: the answer waits, still named in flight, for the units taken before it.
      if (stage === 'propose' && unit !== undefined) await this.inTurn(unit);
      clear();
      return result;
    } catch (error) {
      // No call sent: nothing was charged. Complete replies that failed the contract were charged and counted; a step the
      // budget refused had its earlier requests answered; a last request the provider turned away before any answer
      // began was not billed, and one it answered whole was billed at the usage it reported: nothing is unknown in any of
      // these. A request cut off after its answer began, or in flight by a cancel or the time limit, stays named.
      const accounted = error instanceof ProviderFailure && error.delivery !== 'cut';
      if (!sent || refused || error instanceof StructuredTaskError || accounted) clear();
      // A proposal the provider turned away generated nothing: it gives the unit back the allowance it took, so refusals
      // never use up a conversation's attempts. (Missing credentials refuse before any charge: that kind takes nothing.)
      const refusal = providerRefusal(error);
      if (refusal && refusal.kind !== 'unavailable' && sent && stage === 'propose' && unit !== undefined) {
        const spent = this.progress.generationAttempts?.find(item => item.dialogueId === unit);
        if (spent?.calls) spent.calls--;
      }
      if (error instanceof StructuredTaskError && (stage === 'select' || stage === 'propose')) throw new StructuredTaskError(unusableText(stage, error), { cause: error });
      throw error;
    }
  }

  /**
   * What one unit's proposal reads: every prompt of the agent, then the articles — all of them when the knowledge base
   * fits one call, else the ones chosen for this dialogue from the table of contents (saved, so never paid for twice).
   */
  private async readFor(unit: string, dialogue: ImportBatch['dialogues'][number] | undefined, whole: boolean): Promise<Source[] | { excluded: string }> {
    const { record, progress } = this;
    const prompts = record.sources.filter(source => source.kind === 'prompt');
    const articles = record.sources.filter(source => source.kind !== 'prompt');
    if (whole || !dialogue) return [...prompts, ...articles];
    let chosen = progress.sourceSelection?.find(row => row.dialogueId === unit)?.sourceIds;
    if (!chosen) {
      const messages = loggedMessages(dialogue);
      const selected = !articles.length ? [] : await this.call(unit, 'select', ctx => selectScenarioSources({ task: record.task, limit: SOURCES_PER_DIALOGUE,
        catalog: articles.map(({ id, name, content }) => ({ id, name, chars: content.length })),
        dialogue: { id: unit, messages: messages.map(({ role, content }) => ({ role, content })) } }, articles, this.runtime, ctx));
      chosen = selected.map(source => source.id);
      progress.sourceSelection = [...(progress.sourceSelection ?? []), { dialogueId: unit, sourceIds: chosen }];
      await this.publish();
    }
    if (!chosen.length && !prompts.length) return { excluded: 'Не удалось подобрать статьи под этот разговор в пределах запроса. Это не доказывает, что правила в базе нет.' };
    // Looked up in the record, in the order chosen: the prompts are never among them, they are read with every dialogue.
    return [...prompts, ...chosen.flatMap(id => articles.find(source => source.id === id) ?? [])];
  }

  /**
   * The card of a unit: proposed, checked by the harness itself, bound and added with the rules it cites — or the reason
   * the unit makes none. With `revision`, the card the reviewer blocked is written again against the reviewer's reasons
   * and replaces it.
   */
  private async propose(unit: string, dialogue: ImportBatch['dialogues'][number] | undefined, read: Source[], revision?: Revision): Promise<Card | { excluded: string }> {
    const { record, batch, progress } = this;
    if (!revision && this.library.cards.length >= CARD_LIMIT) return { excluded: `В наборе уже ${CARD_LIMIT} ситуаций.` };
    if (record.requirements.length + CARD_CITATIONS > RECORD_REQUIREMENT_LIMIT) return { excluded: `В наборе уже ${countText(record.requirements.length, ['правило', 'правила', 'правил'])} — больше одна подготовка не держит.` };
    // What binds the bot: the kinds of the owner's rulebook, and the single rules of another kind the owner included.
    const rulebook = rulebookOf(this.library);
    const binds: ProposalCall['binds'] = { kinds: rulebook.kinds,
      rules: this.library.requirements.filter(requirement => rulebook.included.includes(requirement.id)).map(({ sourceId, quote }) => ({ sourceId, quote })) };
    const messages = dialogue ? loggedMessages(dialogue) : [];
    const call = (sources: readonly Source[]) => proposalCall({ source: dialogue && batch ? { kind: 'dialogue', batchId: batch.id, dialogueId: unit } : { kind: 'rules', unit },
      messages, sources, binds, maxTurns: record.settings.maxTurns,
      // The tool channel the probe before the preparation confirmed: its tools may be what a duty is observed on.
      ...(record.toolChannel?.confirmed ? { confirmedObservations: ['tool' as const], tools: record.toolChannel.tools } : {}) });
    if (!read.length) return { excluded: 'Для этой ситуации нет материалов владельца.' };
    if (call(read).laterEvents.length > LATER_MESSAGES) return { excluded: `После первой реплики клиент пишет ещё больше ${LATER_MESSAGES} раз — для одной ситуации это слишком много.` };
    // A sampled conversation's topic is the map's: the model is offered it alone, and the card takes it as the map words it.
    const topic = dialogue && batch ? unitTopic(progress, this.library, batch.id, unit) : undefined;
    const request = (sources: readonly Source[]): CardProposalRequest => ({ task: record.task, call: call(sources),
      topics: topic ? [topic.title] : [...new Set(this.library.cards.map(card => card.topic))],
      written: dialogue ? [] : this.library.cards.filter(card => card.origin.kind === 'rules' && card.id !== revision?.card.id).map(card => card.title),
      ...(revision ? { revision: { previous: reviewedBrief(revision.card, this.library), blocked: revision.blocked } } : {}) });
    // Over the request's cap the last articles give way first; the agent's prompts and the customer's messages never do.
    const prompts = read.filter(source => source.kind === 'prompt').length;
    let sources = read;
    while (sources.length > prompts && workInputIssue(proposalPayload(request(sources)))) sources = sources.slice(0, -1);
    const oversize = workInputIssue(proposalPayload(request(sources)));
    if (oversize) return { excluded: prompts ? `Промпты агента вместе с этим разговором не помещаются в один запрос. ${oversize}` : oversize };
    if (!sources.length) return { excluded: 'Статьи не помещаются в запрос вместе с сообщениями клиента.' };
    if (sources.length < read.length && progress.sourceSelection?.some(item => item.dialogueId === unit)) {
      const kept = new Set(sources.map(source => source.id));
      progress.sourceSelection = progress.sourceSelection.map(item => item.dialogueId === unit ? { dialogueId: unit, sourceIds: item.sourceIds.filter(id => kept.has(id)) } : item);
    }
    const asked = request(sources);
    if (!this.runtime.proposeCard) throw new Error('Эта среда не умеет готовить ситуации.');
    const answer = await this.call(unit, 'propose', ctx => this.runtime.proposeCard!(asked, ctx));
    // The runtime's own check is not taken on trust: the harness parses, finds every quote, holds every kind to the rulebook, binds and checks.
    // Its reasons are the model's, in English: the owner reads that the situation did not pass.
    const parsed = cardProposalSchema(asked.call).safeParse(answer);
    if (!parsed.success || cardProposalProblem(parsed.data, asked.call)) return { excluded: UNBOUND_PROPOSAL };
    const card = withTrafficTopic(bindProposal(parsed.data, asked.call, revision ? revision.card.number : this.library.nextNumber), topic);
    // A sentence another card already cites is already a rule of the library, by the same id: the first wording stays.
    const cited = proposalRequirements(parsed.data, asked.call).filter(requirement => !record.requirements.some(known => known.id === requirement.id));
    const requirements = [...record.requirements, ...cited];
    const next = revision ? replaceCard(withRequirements(this.library, requirements), revision.card.id, card)
      : addCard(withRequirements(this.library, requirements), card, dialogue && batch ? { dialogueId: unit, batchId: batch.id, sourceIds: sources.map(source => source.id) } : undefined);
    // A card that could never be checked is not kept: its review is sized against the draft that holds its reading row.
    const context: ReviewContext = { library: next, evidence: this.evidence };
    try { reviewRequests(card, pendingClaims(card, context), context); }
    catch (error) { if (error instanceof ReviewTooLarge) return { excluded: error.message }; throw error; }
    record.requirements = requirements;
    this.library = next;
    const made = next.cards.find(item => item.number === card.number)!;
    progress.cards = [...(progress.cards ?? []).filter(item => item.dialogueId !== unit), { dialogueId: unit, cardId: made.id }];
    if (revision) progress.revised = [...progress.revised ?? [], unit];
    await this.publish();
    return made;
  }

  /**
   * A card the reviewer blocked goes back to the proposal once, with the reviewer's reason for each blocked claim; the
   * revision is bound, checked and reviewed like a new card, and replaces it. A doubt only the owner can settle is the
   * owner's, not a revision's. The revision is spent whatever it gives: a revision that fails its checks, or runs out of
   * the unit's proposal allowance, leaves the blocked card as it was; a resume never revises again.
   */
  private async revise(unit: string, dialogue: ImportBatch['dialogues'][number] | undefined, card: Card, whole: boolean): Promise<void> {
    if (this.progress.revised?.includes(unit)) return;
    // A card of a logged conversation is written again only beside that conversation; a card the owner changed or
    // decided on is theirs, and no model writes it over.
    if (card.origin.kind === 'dialogue' && !dialogue || namedByOwner(this.library, card.id)) return;
    const blocked = blockedClaims(card, { library: this.library, evidence: this.evidence });
    if (!blocked.length) return;
    const spent = async () => { this.progress.revised = [...this.progress.revised ?? [], unit]; await this.publish(); };
    let revised: Card | { excluded: string };
    try {
      // The unit's reading is saved with the draft: reading it again sends no call.
      const read = await this.readFor(unit, dialogue, whole);
      revised = 'excluded' in read ? read : await this.propose(unit, dialogue, read, { card, blocked });
    } catch (error) {
      this.ctx.signal.throwIfAborted();
      if (error instanceof StructuredTaskError || overWindow(error)) { await spent(); return; }
      throw error;
    }
    if ('excluded' in revised) { await spent(); return; }
    await this.review(revised, unit);
  }

  /** The reviewer answers every claim of the card no receipt answers yet; a similar claim already answered is not asked again. */
  async review(card: Card, unit: string | undefined): Promise<void> {
    const context: ReviewContext = { library: this.library, evidence: this.evidence };
    const claims = pendingClaims(card, context);
    for (const request of reviewRequests(card, claims, context)) {
      if (!this.runtime.reviewCard) throw new Error('Эта среда не умеет проверять ситуации.');
      let review: CardReview;
      try { review = await this.call(unit, 'review', ctx => this.runtime.reviewCard!(request, ctx)); }
      catch (error) {
        this.ctx.signal.throwIfAborted();
        // The card keeps what was made and waits for an explicit check; its status says it is not checked.
        if (error instanceof StructuredTaskError || overWindow(error)) return;
        throw error;
      }
      this.library = recordClaims(this.library, claimReceipts(claims.filter(claim => request.aliases.includes(claim.alias)), review));
      await this.publish();
    }
  }

  /**
   * The owner's explicit check of one card: the reviewer's claims, then the one revision a blocked card is owed — the
   * one the consent of its preparation promised (miner/plan.ts), when its review did not happen inside the preparation.
   * Only a unit this preparation proposed is owed one (it has an allowance); a card converted from the first format is not.
   */
  async check(card: Card, unit: string | undefined, whole: boolean): Promise<void> {
    await this.review(card, unit);
    if (unit === undefined || this.progress.protocol !== CARD_PROTOCOL || !this.progress.generationAttempts?.some(item => item.dialogueId === unit)) return;
    const reviewed = this.library.cards.find(item => item.id === card.id);
    if (reviewed) await this.revise(unit, this.batch?.dialogues.find(item => item.id === unit), reviewed, whole);
  }

  /**
   * The card a unit made: undefined while it has none, null when the owner removed it. A checkpoint an earlier Lab
   * saved while another unit's step was landing can name a card its library does not hold: such a unit is not finished.
   * It goes on with the card its conversation made, if the draft holds one, or makes its card again.
   */
  private cardOf(unit: string): Card | null | undefined {
    const made = this.progress.cards?.find(item => item.dialogueId === unit);
    if (!made) return undefined;
    const card = this.library.cards.find(item => item.id === made.cardId);
    if (card) return card;
    if (this.library.receipts.some(receipt => receipt.command.kind === 'remove_card' && receipt.command.cardId === made.cardId)) return null;
    const own = this.library.cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === unit && item.origin.batchId === this.batch?.id);
    this.progress.cards = [...(this.progress.cards ?? []).filter(item => item.dialogueId !== unit), ...own ? [{ dialogueId: unit, cardId: own.id }] : []];
    return own;
  }

  /** `landed`: the unit's card step is done, and the units after it may land theirs. */
  private async prepareUnit(unit: string, whole: boolean, landed: () => void): Promise<void> {
    const dialogue = this.batch?.dialogues.find(item => item.id === unit);
    let card = this.cardOf(unit);
    // The owner removed the card of an unfinished unit: nothing is made again.
    if (card === null) { this.finish(unit); await this.publish(); return; }
    if (!card) {
      const read = await this.readFor(unit, dialogue, whole);
      if (!('excluded' in read) && this.readsEarlierCards(unit, dialogue)) await this.inTurn(unit);
      const proposed = 'excluded' in read ? read : await this.propose(unit, dialogue, read);
      // A unit left out calls in its replacement: in plan order too, so the next units are the same whoever finishes first.
      if ('excluded' in proposed) { await this.inTurn(unit); this.exclude(unit, proposed.excluded); landed(); await this.publish(); return; }
      card = proposed;
    }
    landed();
    await this.review(card, unit);
    await this.revise(unit, dialogue, card, whole);
    this.finish(unit);
    await this.publish();
  }

  /**
   * A paid call that died in flight is never repeated: a unit without its card is left out; a card whose review died
   * keeps what was made and waits for an explicit check. A `cards-v1` draft may have died grounding the owner's rules
   * for every unit, which nothing can do without.
   */
  settleInterrupted(): void {
    const { activeDialogueId, activeStage, active = [] } = this.progress;
    // A checkpoint written before units were worked on at once names its one call in the two single fields.
    const calls: InFlight[] = [...active, ...activeStage ? [activeDialogueId === undefined ? { stage: activeStage } : { dialogueId: activeDialogueId, stage: activeStage }] : []];
    if (calls.some(call => call.stage === 'ground' && call.dialogueId === undefined)) throw new Error('Подготовка остановилась во время чтения правил владельца. Стоимость этого вызова неизвестна, и он не повторяется молча: подготовьте новый черновик.');
    // An earlier Lab counted a unit it left out among the processed ones too: it counts once, as left out.
    const left = new Set(this.progress.excluded.map(item => item.dialogueId));
    if (this.progress.processed.some(id => left.has(id))) this.progress.processed = this.progress.processed.filter(id => !left.has(id));
    for (const { dialogueId: unit, stage } of calls) {
      if (unit === undefined) continue;
      // A call in flight for a unit that has its card was its review, or its revision (the reading or the proposal of
      // it): the card stays, and a revision in flight is spent.
      if (this.progress.cards?.some(item => item.dialogueId === unit)) {
        if (stage !== 'review' && !this.progress.revised?.includes(unit)) this.progress.revised = [...this.progress.revised ?? [], unit];
        this.finish(unit);
      } else this.exclude(unit, INTERRUPTED);
    }
    delete this.progress.activeDialogueId; delete this.progress.activeStage; delete this.progress.active;
  }

  async run(): Promise<void> {
    const { record, progress, ctx } = this;
    this.settleInterrupted();
    progress.status = 'preparing';
    await this.publish();
    try {
      ctx.signal.throwIfAborted();
      // Materials too large for one call are read per dialogue, the model picking articles from the table of contents.
      const issue = workInputIssue({ task: record.task, sources: record.sources });
      const whole = !issue;
      if (issue && !(this.batch && this.runtime.selectSources)) {
        // The materials fit no call: no conversation could take a unit's seat either.
        for (const unit of [...progress.pending]) this.exclude(unit, issue, false);
      } else if (!whole) progress.sourceSelection ??= [];
      // A replacement joins the pending units while the run goes on; a unit whose step failed unsent stays pending for a resume.
      const tried = new Set<string>();
      const next = () => progress.pending.find(id => !tried.has(id));
      const failures: unknown[] = [];
      const worker = async (): Promise<void> => {
        for (let unit = next(); unit !== undefined && !failures.length && !this.halt; unit = next()) {
          tried.add(unit);
          const landed = this.take(unit);
          try {
            ctx.signal.throwIfAborted();
            await this.prepareUnit(unit, whole, landed);
          } catch (error) {
            ctx.signal.throwIfAborted();
            // One source's unusable answer never hides the others: it is left out with why.
            const unusable = error instanceof StructuredTaskError ? error.message : overWindow(error) ? OVER_WINDOW : undefined;
            if (unusable !== undefined) { await this.inTurn(unit); this.exclude(unit, unusable); landed(); await this.publish(); continue; }
            // A call whose cost is unknown stops the preparation; the resume leaves its unit out.
            if (this.inFlight(unit)) throw error instanceof ProviderFailure ? new Error(CUT, { cause: error }) : error;
            // Turned away before anything began: the unit waits for the resume, and no new unit is taken.
            const refusal = providerRefusal(error);
            const stop = budgetStop(error) ?? (refusal && new Error(refusalText(refusal, 'preparation'), { cause: error }));
            if (stop) { this.halt ??= stop; continue; }
            this.unsent.push({ unit, message: error instanceof Error ? error.message : String(error) });
          } finally { landed(); }
        }
      };
      // A failure or a refusal stops the taking of new units; the preparation ends once the units at work have landed what they can.
      await Promise.all(Array.from({ length: this.parallel }, () => worker().catch(error => { failures.push(error); })));
      if (failures.length) throw failures[0];
      progress.status = progress.pending.length ? 'partial' : 'complete';
      await this.publish();
      if (this.halt) throw this.halt;
      const [first] = this.unsent;
      if (first) throw new Error(`Не удалось разобрать ${countText(this.unsent.length, ['источник', 'источника', 'источников'])} — вызов модели не состоялся: ${first.message} Продолжите подготовку, когда причина устранена.`);
    } catch (error) {
      if (progress.status === 'preparing') progress.status = ctx.signal.aborted ? 'cancelled' : 'partial';
      await this.publish();
      throw error;
    }
  }
}

/**
 * Prepares a new draft of cards from the plan, `parallel` units at once: the library is published after every step.
 * Prompts too large for any request refuse it before the first call; a resume reads the same inputs, sealed by the input hash.
 */
export async function prepareCards(record: Experiment, plan: CardPlan, agent: AgentSpec | undefined, runtime: Runtime, ctx: CallContext, publisher: DraftPublisher, parallel = 1): Promise<void> {
  const batch = plan.kind === 'dialogues' ? plan.batch : undefined;
  const sample = plan.kind === 'dialogues' ? plan.sample : undefined;
  const units = plan.kind === 'dialogues' ? plan.sample.picked : Array.from({ length: plan.count }, (_, index) => `rules_${index + 1}`);
  if (new Set(units).size !== units.length || (batch && units.some(id => !batch.dialogues.some(dialogue => dialogue.id === id)))) {
    throw new Error('В плане подготовки повторяется диалог или есть диалог, которого нет в импорте.');
  }
  const prompts = promptsOversize(record.task, record.sources);
  if (prompts) throw new Error(prompts);
  const progress: CardPreparation = { protocol: CARD_PROTOCOL, inputHash: preparationInputHash(record, CARD_PROTOCOL), status: 'preparing',
    pending: [...units], processed: [], requestedCount: sample ? sample.count : units.length,
    ...(sample ? { sample: sample.strata } : {}), excluded: (sample?.excluded ?? []).map(({ dialogueId, reason }) => ({ dialogueId, reason })) };
  record.preparationProgress = progress;
  ensureAgentRevision(record, agent);
  const library = createLibraryV2({ id: `library_${record.id}`, imports: batch ? [{ id: batch.id, contentHash: batch.contentHash }] : [], sources: record.sources, requirements: [],
    ...(sample?.traffic ? { traffic: [sample.traffic] } : {}) });
  await new Preparation(record, progress, batch, library, runtime, ctx, publisher, undefined, parallel).run();
}

/** Why this Lab cannot continue a saved preparation; undefined for one made the way it prepares now. */
export function notContinuable(progress: PreparationProgress | undefined): string | undefined {
  if (progress?.protocol === CARD_PROTOCOL) return undefined;
  if (!progress) return 'Эту подготовку нельзя продолжить: нет сохранённого плана.';
  return progress.protocol === PREVIOUS_PROTOCOL ? PREVIOUS_PREPARATION : 'Это подготовка старого формата: её не продолжить. Продолжите черновик в новом формате.';
}

/** Continues a card preparation from its saved steps, `parallel` units at once. A call that died in flight is never repeated. */
export async function resumeCards(record: Experiment, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, publisher: DraftPublisher, parallel = 1): Promise<void> {
  const progress = record.preparationProgress;
  if (progress?.protocol !== CARD_PROTOCOL) throw new Error(notContinuable(progress));
  if (progress.inputHash !== preparationInputHash(record, CARD_PROTOCOL)) throw new Error('Входы или модель подготовки изменились. Подготовьте новый черновик.');
  if (record.originalImport && (!batch || batch.id !== record.originalImport.id || batch.contentHash !== record.originalImport.contentHash)) throw new Error('Исходный импорт подготовки изменился или отсутствует.');
  if (!record.librarySnapshot) throw new Error('Черновик ситуаций не сохранён; продолжить нельзя.');
  const library = requireLibraryV2(record.librarySnapshot);
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
  await new Preparation(record, progress, batch, structuredClone(library), runtime, ctx, publisher, libraryHash(library), parallel).run();
}

/**
 * The owner's explicit check: every claim of every card no receipt answers yet, in card order, and the one revision a
 * blocked card of this Lab's preparation is owed (Preparation.check). A `cards-v1` draft is checked as well: its cards
 * cite stored rules, however they were written out; it is never revised.
 */
export async function reviewCards(record: Experiment, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, publisher: DraftPublisher): Promise<void> {
  const progress = record.preparationProgress;
  if ((progress?.protocol !== CARD_PROTOCOL && progress?.protocol !== PREVIOUS_PROTOCOL) || !record.librarySnapshot) throw new Error('Проверять нечего: у черновика нет ситуаций нового формата.');
  const library = requireLibraryV2(record.librarySnapshot);
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
  const preparation = new Preparation(record, progress, batch, structuredClone(library), runtime, ctx, publisher, libraryHash(library));
  preparation.settleInterrupted();
  const whole = !workInputIssue({ task: record.task, sources: record.sources });
  try {
    for (const card of [...library.cards].sort((a, b) => a.number - b.number)) {
      ctx.signal.throwIfAborted();
      await preparation.check(card, progress.cards?.find(item => item.cardId === card.id)?.dialogueId, whole);
    }
  } catch (error) {
    // The check ends where the budget or the provider refused; what it checked is saved.
    ctx.signal.throwIfAborted();
    const refusal = providerRefusal(error);
    throw budgetStop(error) ?? (refusal ? new Error(refusalText(refusal, 'check'), { cause: error }) : error);
  }
}
