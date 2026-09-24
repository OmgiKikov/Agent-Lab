import { fingerprint, internalPromptRule, type AgentSpec, type Experiment, type Requirement, type Source } from '../contracts.js';
import type { CallContext, Grounding, GroundingInput, Runtime } from '../runtime.js';
import { AGENT_RULE_CHARS, MAX_PREPARATION_PARALLEL, PREPARATION_PARALLEL, SOURCES_PER_DIALOGUE, workInputIssue } from '../limits.js';
import { StructuredTaskError } from '../llm/structured.js';
import { withTrafficTopic } from '../miner/cards.js';
import { replacementFor, unitTopic, type LogSample } from '../miner/plan.js';
import { countText } from '../plural.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { libraryHash } from '../scenario-library.js';
import { promptGroundingPlan, selectScenarioSources } from '../scenario-sources.js';
import type { ExperimentStore } from '../store.js';
import { clip } from '../text.js';
import { PROPOSAL_ATTEMPTS } from './budget.js';
import { importEvidence, loggedMessages, type CardEvidence } from './checks.js';
import { addCard, createLibraryV2, recordClaims, requireLibraryV2, withRequirements } from './library.js';
import { bindsBot, rulebookOf } from './rulebook.js';
import { bindProposal, cardProposalProblem, cardProposalSchema, proposalCall, proposalPayload, type CardProposalRequest } from './proposal.js';
import { claimReceipts, pendingClaims, reviewRequests, ReviewTooLarge, type CardReview, type ReviewContext } from './review.js';
import type { Card, CardPreparation, LibraryV2 } from './schema.js';

/*
 * Preparing situations — from dialogues of an import, or from the owner's rules alone (docs/design/card-v2-spec.md §8, C9):
 *
 *   plan: units ─► grounding of the whole policy, once, when the materials fit one call
 *         or else the agent's prompts alone, once, in chunks ─► the agent's rules, offered to every dialogue
 *   each unit:  articles (large knowledge base) ─► the rules for this dialogue + the agent's rules that decide it
 *               ─► proposal ─► binding + checks ─► review
 *
 * Every finished step is saved with the draft, so a resume continues a unit from its next step and never pays for a
 * finished one again. A paid call names its unit and step first; a call that dies in flight leaves the name behind,
 * and a resume never repeats it, because its cost is unknown. Each unit has one allowance of proposal calls, repairs
 * included, that survives a resume.
 *
 * Several units are worked on at once (`parallel`), taken in plan order; the grounding before them runs alone. The
 * draft does not depend on which unit finishes first: each unit's card step — its card, or why it makes none, with
 * the replacement it calls in — lands in the order the units were taken, so the cards are numbered in plan order.
 *
 *   unit 1: read ──► propose ──► card №1 ──► review
 *   unit 2: read ──► propose ─ waits for unit 1 ─► card №2 ──► review
 *   unit 3: read ─ waits for unit 2 ─► propose (it is offered the cards made before it) ──► card №3 ──► review
 */

const PROTOCOL = 'cards-v1';
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

/**
 * Adds one dialogue's requirements to the record: a rule already known by its source, exact quote and meaning keeps its id,
 * a new rule whose id is taken gets a numbered one. Returns only this dialogue's requirements, with the ids a card must cite.
 */
function mergeRequirements(record: Experiment, extracted: Requirement[], sources: Source[]): Requirement[] {
  const focused: Requirement[] = [];
  for (const requirement of extracted) {
    if (!sources.some(source => source.id === requirement.sourceId)) throw new Error('Требование ссылается на статью вне выбранных материалов.');
    const known = record.requirements.find(known => known.sourceId === requirement.sourceId && known.quote === requirement.quote
      && known.text === requirement.text && known.critical === requirement.critical);
    if (known) { focused.push(known); continue; }
    let id = requirement.id;
    for (let n = 2; record.requirements.some(known => known.id === id); n++) id = `${requirement.id}_${n}`;
    const merged = { ...requirement, id };
    record.requirements.push(merged); focused.push(merged);
  }
  return focused;
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
type Reading = { sources: Source[]; requirements: Requirement[] };

/** Units worked on at once, as the owner asks for them: one to MAX_PREPARATION_PARALLEL. */
export function preparationParallel(value: number | undefined): number {
  const parallel = value ?? PREPARATION_PARALLEL;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PREPARATION_PARALLEL) throw new Error(`Одновременно можно готовить от 1 до ${MAX_PREPARATION_PARALLEL} ситуаций.`);
  return parallel;
}

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

  private ground(request: GroundingInput, ctx: CallContext): Promise<Grounding> {
    if (!this.runtime.groundRequirements) throw new Error('Эта среда не умеет извлекать требования из материалов владельца.');
    return this.runtime.groundRequirements(request, ctx);
  }

  /**
   * The agent's prompts on the per-dialogue path: grounded alone, once, before any dialogue, one chunk per call
   * (scenario-sources.ts promptGroundingPlan). Every finished chunk is saved; a resume continues from the next one.
   */
  private async groundPrompts(): Promise<void> {
    const { record, progress } = this;
    const plan = promptGroundingPlan(record.task, record.sources);
    if (!plan.chunks.length && !plan.skipped.length) return;
    // A checkpoint written before this step existed plans it on its resume; the draft's own limit bounds that resume.
    const state = progress.promptGrounding ??= { chunks: plan.chunks.length, done: 0, requirementIds: [],
      ...(plan.skipped.length ? { skipped: plan.skipped.map(({ source, reason }) => ({ sourceId: source.id, reason: clip(reason, 2000) })) } : {}) };
    while (state.done < state.chunks) {
      this.ctx.signal.throwIfAborted();
      const chunk = plan.chunks[state.done]!;
      try {
        const grounded = await this.call(undefined, 'ground', ctx => this.ground({ task: record.task, sources: chunk }, ctx));
        record.questions = [...new Set([...record.questions, ...grounded.questions])].slice(0, 12);
        const ids = mergeRequirements(record, grounded.requirements, chunk).map(requirement => requirement.id);
        state.requirementIds = [...new Set([...state.requirementIds, ...ids])];
        this.library = withRequirements(this.library, record.requirements);
      } catch (error) {
        this.ctx.signal.throwIfAborted();
        // An answer that never passed its checks leaves these prompts out, with the reason; the other chunks go on.
        if (!(error instanceof StructuredTaskError)) throw error;
        state.skipped = [...state.skipped ?? [], ...chunk.map(source => ({ sourceId: source.id, reason: clip(`Правила промпта «${source.name}» не прочитаны: ${error.message}`, 2000) }))];
      }
      state.done++;
      await this.publish();
    }
  }

  /** The agent's rules one dialogue may be decided by: from its prompts, seen by the customer, and inside the owner's rulebook. */
  private agentRules(): Requirement[] {
    const ids = new Set(this.progress.promptGrounding?.requirementIds ?? []);
    const rulebook = rulebookOf(this.library);
    return this.record.requirements.filter(requirement => ids.has(requirement.id) && !internalPromptRule(this.record.sources, requirement) && bindsBot(rulebook, requirement));
  }

  /**
   * A large knowledge base is read per dialogue: the articles it needs from the table of contents, then the rules that
   * decide it — from those articles, and among the agent's rules grounded once from its prompts.
   */
  private async readFor(unit: string, dialogue: ImportBatch['dialogues'][number]): Promise<Reading | { excluded: string }> {
    const { record, progress } = this;
    // The prompts were grounded once for every dialogue (groundPrompts): the catalog is the articles alone.
    const articles = record.sources.filter(source => source.kind !== 'prompt');
    const messages = loggedMessages(dialogue);
    const offered = this.agentRules();
    let chosen = progress.sourceSelection?.find(row => row.dialogueId === unit)?.sourceIds;
    if (!chosen) {
      const selected = !articles.length ? [] : await this.call(unit, 'select', ctx => selectScenarioSources({ task: record.task, limit: SOURCES_PER_DIALOGUE,
        catalog: articles.map(({ id, name, content }) => ({ id, name, chars: content.length })),
        dialogue: { id: unit, messages: messages.map(({ role, content }) => ({ role, content })) } }, articles, this.runtime, ctx));
      chosen = selected.map(source => source.id);
      progress.sourceSelection = [...(progress.sourceSelection ?? []), { dialogueId: unit, sourceIds: chosen }];
      await this.publish();
    }
    if (!chosen.length && !offered.length) return { excluded: 'Не удалось подобрать статьи под этот разговор в пределах запроса. Это не доказывает, что правила в базе нет.' };
    // Looked up in the record: a row saved before the prompts were grounded once may name a prompt chosen for this dialogue.
    let sources = chosen.flatMap(id => record.sources.find(source => source.id === id) ?? []);
    let row = progress.focus?.find(item => item.dialogueId === unit);
    if (!row) {
      // The same article can answer different questions: the rules are grounded for this customer's messages only.
      const customerMessages = messages.filter(message => message.role === 'user').map(message => message.content);
      let agentRules = offered.map(({ id, text }) => ({ id, text: clip(text, AGENT_RULE_CHARS) }));
      const request = (): GroundingInput => ({ task: record.task, sources, focus: { dialogueId: unit, customerMessages, ...(agentRules.length ? { agentRules } : {}) } });
      // Over the request's cap the last articles give way first, then the agent's rules from the end of their order: the
      // customer's messages are the dialogue itself and are never cut. The articles kept are the dialogue's reading.
      while (sources.length && workInputIssue(request())) sources = sources.slice(0, -1);
      while (agentRules.length && workInputIssue(request())) agentRules = agentRules.slice(0, -1);
      const oversize = workInputIssue(request());
      if (oversize) return { excluded: oversize };
      if (!sources.length && !agentRules.length) return { excluded: 'Статьи и правила агента не помещаются в запрос вместе с сообщениями клиента.' };
      if (sources.length < chosen.length) {
        const kept = sources.map(source => source.id);
        progress.sourceSelection = (progress.sourceSelection ?? []).map(item => item.dialogueId === unit ? { dialogueId: unit, sourceIds: kept } : item);
      }
      const grounded = await this.call(unit, 'ground', ctx => this.ground(request(), ctx));
      record.questions = [...new Set([...record.questions, ...grounded.questions])].slice(0, 12);
      const focus = mergeRequirements(record, grounded.requirements, sources).map(requirement => requirement.id);
      // The runtime's answer is not taken on trust: only rules that were offered count.
      const allowed = new Set(agentRules.map(rule => rule.id));
      const agentRuleIds = [...new Set(grounded.agentRuleIds ?? [])].filter(id => allowed.has(id));
      row = { dialogueId: unit, requirementIds: focus, ...(agentRuleIds.length ? { agentRuleIds } : {}) };
      progress.focus = [...(progress.focus ?? []), row];
      this.library = withRequirements(this.library, record.requirements);
      await this.publish();
    }
    const ids = new Set([...row.requirementIds, ...row.agentRuleIds ?? []]);
    return { sources, requirements: record.requirements.filter(requirement => ids.has(requirement.id)) };
  }

  /** The card of a unit: proposed, checked by the harness itself, bound and added — or the reason the unit makes none. */
  private async propose(unit: string, dialogue: ImportBatch['dialogues'][number] | undefined, reading: Reading): Promise<Card | { excluded: string }> {
    const { record, batch } = this;
    if (this.library.cards.length >= CARD_LIMIT) return { excluded: `В наборе уже ${CARD_LIMIT} ситуаций.` };
    // An internal rule of the agent's prompt (a machine output format) is recorded but never becomes an expectation; a rule
    // outside the owner's rulebook (an operator instruction the owner did not include) stays in the library and is never offered.
    const rulebook = rulebookOf(this.library);
    // The sources of a rule are the record's: the agent's rules cite prompts the dialogue's reading does not carry again.
    const judged = reading.requirements.filter(requirement => !internalPromptRule(this.record.sources, requirement));
    const rules = judged.filter(requirement => bindsBot(rulebook, requirement));
    if (!rules.length) return { excluded: judged.length ? 'Этот разговор решают только правила вне свода правил (например, инструкции для операторов), а по ним бота не судят.'
      : 'Правила владельца не решают этот разговор, а ситуация без правила не строится.' };
    const call = proposalCall({ source: dialogue && batch ? { kind: 'dialogue', batchId: batch.id, dialogueId: unit } : { kind: 'rules', unit },
      messages: dialogue ? loggedMessages(dialogue) : [], requirements: rules, maxTurns: record.settings.maxTurns });
    if (call.laterEvents.length > LATER_MESSAGES) return { excluded: `После первой реплики клиент пишет ещё больше ${LATER_MESSAGES} раз — для одной ситуации это слишком много.` };
    // A sampled conversation's topic is the map's: the model is offered it alone, and the card takes it as the map words it.
    const topic = dialogue && batch ? unitTopic(this.progress, this.library, batch.id, unit) : undefined;
    const request: CardProposalRequest = { task: record.task, call, requirements: rules.map(({ id, text, quote }) => ({ id, text, quote })),
      articles: reading.sources.map(({ id, name, content, kind }) => ({ id, name, content, ...(kind ? { kind } : {}) })),
      topics: topic ? [topic.title] : [...new Set(this.library.cards.map(card => card.topic))],
      written: dialogue ? [] : this.library.cards.filter(card => card.origin.kind === 'rules').map(card => card.title) };
    const oversize = workInputIssue(proposalPayload(request));
    if (oversize) return { excluded: oversize };
    if (!this.runtime.proposeCard) throw new Error('Эта среда не умеет готовить ситуации.');
    const answer = await this.call(unit, 'propose', ctx => this.runtime.proposeCard!(request, ctx));
    // The runtime's own check is not taken on trust: the harness parses, binds and checks the answer itself.
    const parsed = cardProposalSchema(call).safeParse(answer);
    const problem = parsed.success ? cardProposalProblem(parsed.data, call) : parsed.error.message;
    if (!parsed.success || problem) return { excluded: `Предложенная ситуация не прошла проверку: ${problem}` };
    const card = withTrafficTopic(bindProposal(parsed.data, call, this.library.nextNumber), topic);
    const next = addCard(this.library, card, dialogue && batch ? { dialogueId: unit, batchId: batch.id, sourceIds: reading.sources.map(source => source.id) } : undefined);
    // A card that could never be checked is not kept: its review is sized against the draft that holds its reading row.
    const context: ReviewContext = { library: next, evidence: this.evidence };
    try { reviewRequests(card, pendingClaims(card, context), context); }
    catch (error) { if (error instanceof ReviewTooLarge) return { excluded: error.message }; throw error; }
    this.library = next;
    this.progress.cards = [...(this.progress.cards ?? []), { dialogueId: unit, cardId: card.id }];
    await this.publish();
    return card;
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
      const reading = whole || !dialogue ? { sources: this.record.sources, requirements: this.record.requirements } : await this.readFor(unit, dialogue);
      if (!('excluded' in reading) && this.readsEarlierCards(unit, dialogue)) await this.inTurn(unit);
      const proposed = 'excluded' in reading ? reading : await this.propose(unit, dialogue, reading);
      // A unit left out calls in its replacement: in plan order too, so the next units are the same whoever finishes first.
      if ('excluded' in proposed) { await this.inTurn(unit); this.exclude(unit, proposed.excluded); landed(); await this.publish(); return; }
      card = proposed;
    }
    landed();
    await this.review(card, unit);
    this.finish(unit);
    await this.publish();
  }

  /**
   * A paid call that died in flight is never repeated. The grounding of the whole policy, or of a chunk of the agent's
   * prompts, cannot be done without; a unit
   * without its card is left out; a card whose review died keeps what was made and waits for an explicit check.
   */
  settleInterrupted(): void {
    const { activeDialogueId, activeStage, active = [] } = this.progress;
    // A checkpoint written before units were worked on at once names its one call in the two single fields.
    const calls: InFlight[] = [...active, ...activeStage ? [activeDialogueId === undefined ? { stage: activeStage } : { dialogueId: activeDialogueId, stage: activeStage }] : []];
    if (calls.some(call => call.stage === 'ground' && call.dialogueId === undefined)) throw new Error('Подготовка остановилась во время чтения правил владельца. Стоимость этого вызова неизвестна, и он не повторяется молча: подготовьте новый черновик.');
    for (const { dialogueId: unit, stage } of calls) {
      if (unit === undefined) continue;
      if (stage === 'review') this.finish(unit);
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
      // Materials too large for one grounding call are read per dialogue, the model picking articles from the table of contents.
      const issue = workInputIssue({ task: record.task, sources: record.sources });
      const whole = !issue;
      if (issue && !(this.batch && this.runtime.selectSources)) {
        // The materials fit no call: no conversation could take a unit's seat either.
        for (const unit of [...progress.pending]) this.exclude(unit, issue, false);
      } else if (whole && !progress.groundingComplete) {
        const grounded = await this.call(undefined, 'ground', callCtx => this.ground({ task: record.task, sources: record.sources }, callCtx));
        record.requirements = grounded.requirements; record.questions = grounded.questions;
        this.library = withRequirements(this.library, record.requirements);
        progress.groundingComplete = true;
        await this.publish();
      } else if (!whole) {
        progress.sourceSelection ??= [];
        await this.groundPrompts();
      }
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

/** Prepares a new draft of cards from the plan, `parallel` units at once: the library is published after every step. */
export async function prepareCards(record: Experiment, plan: CardPlan, agent: AgentSpec | undefined, runtime: Runtime, ctx: CallContext, publisher: DraftPublisher, parallel = 1): Promise<void> {
  const batch = plan.kind === 'dialogues' ? plan.batch : undefined;
  const sample = plan.kind === 'dialogues' ? plan.sample : undefined;
  const units = plan.kind === 'dialogues' ? plan.sample.picked : Array.from({ length: plan.count }, (_, index) => `rules_${index + 1}`);
  if (new Set(units).size !== units.length || (batch && units.some(id => !batch.dialogues.some(dialogue => dialogue.id === id)))) {
    throw new Error('В плане подготовки повторяется диалог или есть диалог, которого нет в импорте.');
  }
  const progress: CardPreparation = { protocol: PROTOCOL, inputHash: preparationInputHash(record, PROTOCOL), status: 'preparing',
    pending: [...units], processed: [], groundingComplete: false, requestedCount: sample ? sample.count : units.length,
    ...(sample ? { sample: sample.strata } : {}), excluded: (sample?.excluded ?? []).map(({ dialogueId, reason }) => ({ dialogueId, reason })) };
  record.preparationProgress = progress;
  ensureAgentRevision(record, agent);
  const library = createLibraryV2({ id: `library_${record.id}`, imports: batch ? [{ id: batch.id, contentHash: batch.contentHash }] : [], sources: record.sources, requirements: [],
    ...(sample?.traffic ? { traffic: [sample.traffic] } : {}) });
  await new Preparation(record, progress, batch, library, runtime, ctx, publisher, undefined, parallel).run();
}

/** Continues a card preparation from its saved steps, `parallel` units at once. A call that died in flight is never repeated. */
export async function resumeCards(record: Experiment, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, publisher: DraftPublisher, parallel = 1): Promise<void> {
  const progress = record.preparationProgress;
  if (progress?.protocol !== PROTOCOL) throw new Error('Эту подготовку нельзя продолжить: нет сохранённого плана.');
  if (progress.inputHash !== preparationInputHash(record, PROTOCOL)) throw new Error('Входы или модель подготовки изменились. Подготовьте новый черновик.');
  if (record.originalImport && (!batch || batch.id !== record.originalImport.id || batch.contentHash !== record.originalImport.contentHash)) throw new Error('Исходный импорт подготовки изменился или отсутствует.');
  if (!record.librarySnapshot) throw new Error('Черновик ситуаций не сохранён; продолжить нельзя.');
  const library = requireLibraryV2(record.librarySnapshot);
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
  await new Preparation(record, progress, batch, structuredClone(library), runtime, ctx, publisher, libraryHash(library), parallel).run();
}

/** The owner's explicit check: every claim of every card no receipt answers yet, in card order. */
export async function reviewCards(record: Experiment, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, publisher: DraftPublisher): Promise<void> {
  const progress = record.preparationProgress;
  if (progress?.protocol !== PROTOCOL || !record.librarySnapshot) throw new Error('Проверять нечего: у черновика нет ситуаций нового формата.');
  const library = requireLibraryV2(record.librarySnapshot);
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
  const preparation = new Preparation(record, progress, batch, structuredClone(library), runtime, ctx, publisher, libraryHash(library));
  preparation.settleInterrupted();
  for (const card of [...library.cards].sort((a, b) => a.number - b.number)) {
    ctx.signal.throwIfAborted();
    await preparation.review(card, progress.cards?.find(item => item.cardId === card.id)?.dialogueId);
  }
}
