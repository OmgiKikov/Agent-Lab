import { Stopped } from '../errors.js';
import { fingerprint, internalPromptRule, type AgentSpec, type CallContext, type Experiment, type Grounding, type GroundingInput, type Requirement, type Runtime, type Source } from '../contracts.js';
import { SOURCES_PER_DIALOGUE } from '../limits.js';
import { StructuredTaskError } from '../llm/structured.js';
import { withTrafficTopic } from '../miner/cards.js';
import { replacementFor, unitTopic, type LogSample } from '../miner/plan.js';
import { countText } from '../plural.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { libraryHash } from '../scenario-library.js';
import { selectScenarioSources } from '../scenario-sources.js';
import { workInputIssue } from '../scenario-work.js';
import type { ExperimentStore } from '../store.js';
import { clip } from '../text.js';
import { importEvidence, loggedMessages, type CardEvidence } from './checks.js';
import { addCard, createLibraryV2, recordClaims, requireLibraryV2, withRequirements } from './library.js';
import { bindProposal, cardProposalProblem, cardProposalSchema, proposalCall, proposalPayload, type CardProposalRequest } from './proposal.js';
import { claimReceipts, pendingClaims, reviewRequests, ReviewTooLarge, type CardReview, type ReviewContext } from './review.js';
import type { Card, CardPreparation, LibraryV2 } from './schema.js';

/*
 * Preparing situations — from dialogues of an import, or from the owner's rules alone (card-v2 C9):
 *
 *   plan: units ─► grounding of the whole policy, once, when the materials fit one call
 *   each unit:  articles (large knowledge base) ─► the rules for this dialogue ─► proposal ─► binding + checks ─► review
 *
 * Every finished step is saved with the draft, so a resume continues a unit from its next step and never pays for a
 * finished one again. A paid call names its unit and step first; a call that dies in flight leaves the name behind,
 * and a resume never repeats it, because its cost is unknown. Each unit has one allowance of proposal calls, repairs
 * included, that survives a resume.
 */

const PROTOCOL = 'cards-v1';
/** Proposal calls one unit may spend over all resumes, repairs included. */
const PROPOSAL_ATTEMPTS = 5;
/** Later customer messages one card can account for. */
const LATER_MESSAGES = 60;
const CARD_LIMIT = 200;

/** The agent a run evaluates when the owner names none: it runs outside Lab with its own instructions and tools. */
const EXTERNAL_AGENT: AgentSpec = { name: 'External agent', instructions: 'The agent under evaluation runs outside Agent Lab and keeps its own instructions and tools.', tools: [] };

/** The agent label of a prepared draft: the owner's, or the external agent under test. Set once, by the first preparation. */
export function ensureAgentRevision(record: Experiment, agent: AgentSpec | undefined): void {
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
export function mergeRequirements(record: Experiment, extracted: Requirement[], sources: Source[]): Requirement[] {
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

/** The messages the store holds for a library's imports: what its cards cite. */
export async function storedEvidence(store: ExperimentStore, library: LibraryV2): Promise<CardEvidence> {
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
type Reading = { sources: Source[]; requirements: Requirement[] };

class Preparation {
  private readonly evidence: CardEvidence;
  /** Units whose step failed before any call was sent: they stay pending for a resume. */
  private readonly unsent: { unit: string; message: string }[] = [];
  constructor(private readonly record: Experiment, private readonly progress: CardPreparation, private readonly batch: ImportBatch | undefined,
    private library: LibraryV2, private readonly runtime: Runtime, private readonly ctx: CallContext, private readonly store: ExperimentStore,
    private published: string | undefined) {
    this.evidence = importEvidence(batch ? [batch] : []);
  }

  private async publish(): Promise<void> {
    this.record.librarySnapshot = this.library;
    await this.store.publishLibrary(this.record, this.library, this.published);
    this.published = libraryHash(this.library);
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
    const progress = this.progress;
    if (unit === undefined) delete progress.activeDialogueId; else progress.activeDialogueId = unit;
    progress.activeStage = stage;
    await this.publish();
    const spent = this.record.usage.calls;
    const clear = () => { delete progress.activeDialogueId; delete progress.activeStage; };
    try {
      const result = await work(stage === 'propose' && unit !== undefined ? this.allowance(unit) : this.ctx);
      clear();
      return result;
    } catch (error) {
      // No call sent: nothing was charged. Complete replies that failed the contract were charged and counted, and the budget
      // stops a step only before its next request is sent: nothing is unknown in either case.
      const budget = this.ctx.signal.reason instanceof Stopped && this.ctx.signal.reason.reason === 'budget';
      if (this.record.usage.calls === spent || error instanceof StructuredTaskError || budget) clear();
      throw error;
    }
  }

  private ground(request: GroundingInput, ctx: CallContext): Promise<Grounding> {
    if (!this.runtime.groundRequirements) throw new Error('Эта среда не умеет извлекать требования из материалов владельца.');
    return this.runtime.groundRequirements(request, ctx);
  }

  /** A large knowledge base is read per dialogue: the articles it needs from the table of contents, then the rules that decide it. */
  private async readFor(unit: string, dialogue: ImportBatch['dialogues'][number]): Promise<Reading | { excluded: string }> {
    const { record, progress } = this;
    const knowledge = record.sources.filter(source => source.kind !== 'prompt'), prompts = record.sources.filter(source => source.kind === 'prompt');
    const messages = loggedMessages(dialogue);
    let chosen = progress.sourceSelection?.find(row => row.dialogueId === unit)?.sourceIds;
    if (!chosen) {
      const selected = await this.call(unit, 'select', ctx => selectScenarioSources({ task: record.task, limit: SOURCES_PER_DIALOGUE,
        catalog: knowledge.map(({ id, name, content }) => ({ id, name, chars: content.length })),
        dialogue: { id: unit, messages: messages.map(({ role, content }) => ({ role, content })) } }, knowledge, prompts, this.runtime, ctx));
      chosen = selected.map(source => source.id);
      progress.sourceSelection = [...(progress.sourceSelection ?? []), { dialogueId: unit, sourceIds: chosen }];
      await this.publish();
    }
    if (!chosen.length) return { excluded: 'Не удалось подобрать статьи под этот разговор в пределах запроса. Это не доказывает, что правила в базе нет.' };
    const sources = [...prompts, ...chosen.flatMap(id => knowledge.find(source => source.id === id) ?? [])];
    let focus = progress.focus?.find(row => row.dialogueId === unit)?.requirementIds;
    if (!focus) {
      // The same article can answer different questions: the rules are grounded for this customer's messages only.
      const grounded = await this.call(unit, 'ground', ctx => this.ground({ task: record.task, sources,
        focus: { dialogueId: unit, customerMessages: messages.filter(message => message.role === 'user').map(message => message.content) } }, ctx));
      record.questions = [...new Set([...record.questions, ...grounded.questions])].slice(0, 12);
      focus = mergeRequirements(record, grounded.requirements, sources).map(requirement => requirement.id);
      progress.focus = [...(progress.focus ?? []), { dialogueId: unit, requirementIds: focus }];
      this.library = withRequirements(this.library, record.requirements);
      await this.publish();
    }
    const ids = new Set(focus);
    return { sources, requirements: record.requirements.filter(requirement => ids.has(requirement.id)) };
  }

  /** The card of a unit: proposed, checked by the harness itself, bound and added — or the reason the unit makes none. */
  private async propose(unit: string, dialogue: ImportBatch['dialogues'][number] | undefined, reading: Reading): Promise<Card | { excluded: string }> {
    const { record, batch } = this;
    if (this.library.cards.length >= CARD_LIMIT) return { excluded: `В наборе уже ${CARD_LIMIT} ситуаций.` };
    // An internal rule of the agent's prompt (a machine output format) is recorded but never becomes an expectation.
    const rules = reading.requirements.filter(requirement => !internalPromptRule(reading.sources, requirement));
    if (!rules.length) return { excluded: 'Правила владельца не решают этот разговор, а ситуация без правила не строится.' };
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

  private async prepareUnit(unit: string, whole: boolean): Promise<void> {
    const dialogue = this.batch?.dialogues.find(item => item.id === unit);
    const made = this.progress.cards?.find(item => item.dialogueId === unit);
    let card = made && this.library.cards.find(item => item.id === made.cardId);
    // The owner removed the card of an unfinished unit: nothing is made again.
    if (made && !card) { this.finish(unit); await this.publish(); return; }
    if (!card) {
      const reading = whole || !dialogue ? { sources: this.record.sources, requirements: this.record.requirements } : await this.readFor(unit, dialogue);
      const proposed = 'excluded' in reading ? reading : await this.propose(unit, dialogue, reading);
      if ('excluded' in proposed) { this.exclude(unit, proposed.excluded); await this.publish(); return; }
      card = proposed;
    }
    await this.review(card, unit);
    this.finish(unit);
    await this.publish();
  }

  /**
   * A paid call that died in flight is never repeated. The grounding of the whole policy cannot be done without; a unit
   * without its card is left out; a card whose review died keeps what was made and waits for an explicit check.
   */
  settleInterrupted(): void {
    const { activeDialogueId: unit, activeStage: stage } = this.progress;
    if (!stage) return;
    if (stage === 'ground' && unit === undefined) throw new Error('Подготовка остановилась во время чтения правил владельца. Стоимость этого вызова неизвестна, и он не повторяется молча: подготовьте новый черновик.');
    if (unit !== undefined && stage === 'review') this.finish(unit);
    else if (unit !== undefined) this.exclude(unit, 'Подготовка прервалась во время платного вызова: его стоимость неизвестна, поэтому этот источник не разбирается повторно.');
    delete this.progress.activeDialogueId; delete this.progress.activeStage;
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
      } else if (!whole) progress.sourceSelection ??= [];
      // A replacement joins the pending units while the run goes on; a unit whose step failed unsent stays pending for a resume.
      const tried = new Set<string>();
      const next = () => progress.pending.find(id => !tried.has(id));
      for (let unit = next(); unit !== undefined; unit = next()) {
        tried.add(unit);
        ctx.signal.throwIfAborted();
        try { await this.prepareUnit(unit, whole); }
        catch (error) {
          ctx.signal.throwIfAborted();
          // One source's unusable answer never hides the others. A call that died in flight stops the preparation.
          if (error instanceof StructuredTaskError) { this.exclude(unit, error.message); await this.publish(); continue; }
          if (progress.activeDialogueId !== undefined) throw error;
          this.unsent.push({ unit, message: error instanceof Error ? error.message : String(error) });
        }
      }
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

/** Prepares a new draft of cards from the plan: the library is published after every step. */
export async function prepareCards(record: Experiment, plan: CardPlan, agent: AgentSpec | undefined, runtime: Runtime, ctx: CallContext, store: ExperimentStore): Promise<void> {
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
  await new Preparation(record, progress, batch, library, runtime, ctx, store, undefined).run();
}

/** Continues a card preparation from its saved steps. A call that died in flight is never repeated. */
export async function resumeCards(record: Experiment, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, store: ExperimentStore): Promise<void> {
  const progress = record.preparationProgress;
  if (progress?.protocol !== PROTOCOL) throw new Error('Эту подготовку нельзя продолжить: нет сохранённого плана.');
  if (progress.inputHash !== preparationInputHash(record, PROTOCOL)) throw new Error('Входы или модель подготовки изменились. Подготовьте новый черновик.');
  if (record.originalImport && (!batch || batch.id !== record.originalImport.id || batch.contentHash !== record.originalImport.contentHash)) throw new Error('Исходный импорт подготовки изменился или отсутствует.');
  if (!record.librarySnapshot) throw new Error('Черновик ситуаций не сохранён; продолжить нельзя.');
  const library = requireLibraryV2(record.librarySnapshot);
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
  await new Preparation(record, progress, batch, structuredClone(library), runtime, ctx, store, libraryHash(library)).run();
}

/** The owner's explicit check: every claim of every card no receipt answers yet, in card order. */
export async function reviewCards(record: Experiment, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, store: ExperimentStore): Promise<void> {
  const progress = record.preparationProgress;
  if (progress?.protocol !== PROTOCOL || !record.librarySnapshot) throw new Error('Проверять нечего: у черновика нет ситуаций нового формата.');
  const library = requireLibraryV2(record.librarySnapshot);
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
  const preparation = new Preparation(record, progress, batch, structuredClone(library), runtime, ctx, store, libraryHash(library));
  preparation.settleInterrupted();
  for (const card of [...library.cards].sort((a, b) => a.number - b.number)) {
    ctx.signal.throwIfAborted();
    await preparation.review(card, progress.cards?.find(item => item.cardId === card.id)?.dialogueId);
  }
}
