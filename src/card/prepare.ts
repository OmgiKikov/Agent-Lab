import { fingerprint, type AgentSpec, type Experiment, type Source } from '../contracts.js';
import type { CallContext, Runtime } from '../runtime.js';
import { MAX_PREPARATION_PARALLEL, PREPARATION_PARALLEL, RECORD_REQUIREMENT_LIMIT, SOURCES_PER_DIALOGUE, workInputIssue } from '../limits.js';
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
import { cardSchema, type Card, type CardPreparation, type LibraryV2, type PreparationProgress } from './schema.js';
import { assessorReference } from './assessor.js';

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

/** Where a preparation saves its draft after every step: the store's publication, told to whoever follows the work (lab/operation.ts). */
export type DraftPublisher = Pick<ExperimentStore, 'publishLibrary'>;

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

  private finish(unit: string): void {
    this.progress.pending = this.progress.pending.filter(id => id !== unit);
    if (!this.progress.processed.includes(unit)) this.progress.processed.push(unit);
  }

  /** `replace`: the unit's own reason, so a sampled conversation gives its seat to the next one of its topic. */
  private exclude(unit: string, reason: string, replace = true): void {
    this.progress.excluded.push({ dialogueId: unit, reason: clip(reason, 2000) });
    this.finish(unit);
    const next = replace ? replacementFor(this.progress, unit) : undefined;
    if (next) this.progress.pending.push(next);
  }

  /** A proposal step spends the unit's own allowance first, then the run's budget. */
  private allowance(unit: string): CallContext {
    const attempts = this.progress.generationAttempts ??= [];
    return { ...this.ctx, beforeCall: () => {
      let spent = attempts.find(item => item.dialogueId === unit);
      if (!spent) { spent = { dialogueId: unit, calls: 0 }; attempts.push(spent); }
      if (spent.calls >= PROPOSAL_ATTEMPTS) throw new StructuredTaskError(`исчерпаны ${PROPOSAL_ATTEMPTS} попыток предложить ситуацию, которая проходит проверку`);
      this.ctx.beforeCall(); spent.calls++;
    } };
  }

  /** One paid step. Its unit and stage are saved before the call and cleared when it returns, or when it failed with no charge in doubt. */
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
      // No call sent: nothing was charged. Complete replies that failed the contract were charged and counted, and a step
      // the budget refused had its earlier requests answered: nothing is unknown in any of these. A request cut off in
      // flight — by a cancel, or by the budget another unit ran out — stays named.
      if (!sent || refused || error instanceof StructuredTaskError) clear();
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
    const parsed = cardProposalSchema(asked.call).safeParse(answer);
    const problem = parsed.success ? cardProposalProblem(parsed.data, asked.call) : parsed.error.message;
    if (!parsed.success || problem) return { excluded: `Предложенная ситуация не прошла проверку: ${problem}` };
    const bound = withTrafficTopic(bindProposal(parsed.data, asked.call, revision ? revision.card.number : this.library.nextNumber), topic);
    // The assessor's markup of this conversation, carried by the import, is the situation's reference from the start.
    const references = dialogue ? assessorReference(dialogue.original, record.sources) : undefined;
    const card = references ? cardSchema.parse({ ...bound, references }) : bound;
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
    const blocked = blockedClaims(card, { library: this.library, evidence: this.evidence });
    if (!blocked.length) return;
    const spent = async () => { this.progress.revised = [...this.progress.revised ?? [], unit]; await this.publish(); };
    // The unit's reading is saved with the draft: reading it again sends no call.
    const read = await this.readFor(unit, dialogue, whole);
    if ('excluded' in read) { await spent(); return; }
    let revised: Card | { excluded: string };
    try { revised = await this.propose(unit, dialogue, read, { card, blocked }); }
    catch (error) {
      this.ctx.signal.throwIfAborted();
      if (error instanceof StructuredTaskError) { await spent(); return; }
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
        if (error instanceof StructuredTaskError) return;
        throw error;
      }
      this.library = recordClaims(this.library, claimReceipts(claims.filter(claim => request.aliases.includes(claim.alias)), review));
      await this.publish();
    }
  }

  /** `landed`: the unit's card step is done, and the units after it may land theirs. */
  private async prepareUnit(unit: string, whole: boolean, landed: () => void): Promise<void> {
    const dialogue = this.batch?.dialogues.find(item => item.id === unit);
    const made = this.progress.cards?.find(item => item.dialogueId === unit);
    let card = made && this.library.cards.find(item => item.id === made.cardId);
    // The owner removed the card of an unfinished unit: nothing is made again.
    if (made && !card) { this.finish(unit); await this.publish(); return; }
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
    for (const { dialogueId: unit, stage } of calls) {
      if (unit === undefined) continue;
      // A proposal in flight for a unit that has its card was that card's revision: the blocked card stays, the revision is spent.
      const revising = stage === 'propose' && !!this.progress.cards?.some(item => item.dialogueId === unit);
      if (revising) this.progress.revised = [...this.progress.revised ?? [], unit];
      if (stage === 'review' || revising) this.finish(unit);
      else this.exclude(unit, 'Подготовка прервалась во время платного вызова: его стоимость неизвестна, поэтому этот источник не разбирается повторно.');
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
        for (let unit = next(); unit !== undefined && !failures.length; unit = next()) {
          tried.add(unit);
          const landed = this.take(unit);
          try {
            ctx.signal.throwIfAborted();
            await this.prepareUnit(unit, whole, landed);
          } catch (error) {
            ctx.signal.throwIfAborted();
            // One source's unusable answer never hides the others. A call that died in flight stops the preparation.
            if (error instanceof StructuredTaskError) { await this.inTurn(unit); this.exclude(unit, error.message); landed(); await this.publish(); continue; }
            if (this.inFlight(unit)) throw error;
            this.unsent.push({ unit, message: error instanceof Error ? error.message : String(error) });
          } finally { landed(); }
        }
      };
      // A failure stops the taking of new units; the preparation ends once the units at work have landed what they can.
      await Promise.all(Array.from({ length: this.parallel }, () => worker().catch(error => { failures.push(error); })));
      if (failures.length) throw failures[0];
      progress.status = progress.pending.length ? 'partial' : 'complete';
      await this.publish();
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
 * The owner's explicit check: every claim of every card no receipt answers yet, in card order. A `cards-v1` draft is
 * checked as well: its cards cite stored rules, however they were written out.
 */
export async function reviewCards(record: Experiment, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, publisher: DraftPublisher): Promise<void> {
  const progress = record.preparationProgress;
  if ((progress?.protocol !== CARD_PROTOCOL && progress?.protocol !== PREVIOUS_PROTOCOL) || !record.librarySnapshot) throw new Error('Проверять нечего: у черновика нет ситуаций нового формата.');
  const library = requireLibraryV2(record.librarySnapshot);
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
  const preparation = new Preparation(record, progress, batch, structuredClone(library), runtime, ctx, publisher, libraryHash(library));
  preparation.settleInterrupted();
  for (const card of [...library.cards].sort((a, b) => a.number - b.number)) {
    ctx.signal.throwIfAborted();
    await preparation.review(card, progress.cards?.find(item => item.cardId === card.id)?.dialogueId);
  }
}
