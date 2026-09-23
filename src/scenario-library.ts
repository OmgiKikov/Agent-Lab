import { requiredUserTurns, createUserState, allowedUserActions, advanceUser, USER_CONTROLLER_PROTOCOL } from './user-controller.js';
import { USER_CONTROLLER_ROLE, CHECKPOINT_ROLE, LEGACY_CHECKPOINT_ROLE } from './prompts.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isIdentifier } from './ids.js';
import { LibraryConflict } from './errors.js';
import { CHECKPOINT_PROTOCOL, checkSchema, scenarioSchema, worldSchema, valueTokens, type Requirement, type Scenario, type Source } from './contracts.js';
import {
  importBatchSchema, libraryPatchSchema, scenarioLibrarySchema, scenarioProposalSchema, scenarioVariantSchema,
  type BusinessScenario, type ImportBatch, type LibraryPatch, type LibraryQualityIssue,
  type ScenarioLibrary, type ScenarioVariant, type SourceDialogue, type SemanticFinding,
} from './scenario-contracts.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const exactTokens = (value: string) => (normalize(value).match(/[\p{L}\p{N}_:./-]+/gu) ?? []).map(token => token.replace(/[.,:]+$/, '')).filter(Boolean);
function containsExactValue(text: string, value: string): boolean {
  const haystack = exactTokens(text);
  const needle = exactTokens(value);
  return needle.length > 0 && haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token));
}
const uniqueRefs = (refs: SourceDialogue[]) => [...new Map(refs.map(ref => [`${ref.batchId}/${ref.dialogueId}`, ref])).values()];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function scalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (record(value)) return Object.values(value).flatMap(scalarValues);
  return typeof value === 'string' || typeof value === 'number' ? [String(value)] : [];
}

/** No inference: ingest source evidence verbatim and give every retained event a stable index. */
export function importBatch(raw: unknown): ImportBatch {
  const serialized = JSON.stringify(raw);
  if (!serialized || serialized.length > 12_000_000) throw new Error('Импорт пуст или превышает 12000000 символов');
  const parsed = z.json().parse(raw);
  if (record(parsed) && parsed.formatVersion !== undefined && parsed.formatVersion !== 1) throw new Error('Неподдерживаемая версия импорта');
  const rows = Array.isArray(parsed) ? parsed : record(parsed) ? parsed.dialogues : undefined;
  if (!Array.isArray(rows)) throw new Error('Ожидается массив диалогов или объект {dialogues: [...]}');
  if (rows.length > 300) throw new Error('В одном импорте допустимо не больше 300 диалогов');
  const contentHash = digest(rows);
  const batch: ImportBatch = { formatVersion: 1, id: `import_${contentHash.slice(0, 32)}`, contentHash, createdAt: new Date().toISOString(), dialogues: [], rejected: [] };
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const reasons: string[] = [];
    const dialogueId = record(row) && typeof row.id === 'string' ? row.id : undefined;
    if (!dialogueId || !isIdentifier(dialogueId)) reasons.push('Некорректный id диалога');
    if (dialogueId && seen.has(dialogueId)) reasons.push('Повторяющийся id диалога');
    if (dialogueId) seen.add(dialogueId);
    const rich = record(row) && Array.isArray(row.events);
    const events = record(row) ? (rich ? row.events : row.messages) : undefined;
    const retained: ImportBatch['dialogues'][number]['events'] = [];
    if (!Array.isArray(events) || events.length === 0 || events.length > (rich ? 120 : 60)) reasons.push('Пустые события или превышен лимит событий');
    else events.forEach((event, eventIndex) => {
      if (!record(event)) { reasons.push(`Событие ${eventIndex}: ожидается объект`); return; }
      const type = rich ? event.type : 'message';
      if (!['message', 'tool', 'retrieval', 'state'].includes(String(type))) { reasons.push(`Событие ${eventIndex}: неизвестный тип`); return; }
      const candidate = { index: eventIndex, type, ...(typeof event.role === 'string' ? { role: event.role } : {}), ...(typeof event.content === 'string' ? { content: event.content } : {}), data: event };
      const validated = importBatchSchema.shape.dialogues.element.shape.events.element.safeParse(candidate);
      if (!validated.success || type === 'message' && (event.role !== 'user' && event.role !== 'assistant' && event.role !== 'system' || typeof event.content !== 'string')) reasons.push(`Событие ${eventIndex}: некорректная роль или пустое содержимое`);
      else retained.push(validated.data);
    });
    const userEvents = retained.filter(event => event.type === 'message' && event.role === 'user');
    if (!userEvents.length) reasons.push('Нет пользовательских реплик');
    if (userEvents.length && userEvents.every(event => /^(?:\s|\*|x|х|\[(?:redacted|masked|скрыто|удалено)\]|<[^>]+>)+$/i.test(event.content ?? ''))) reasons.push('Пользовательские реплики полностью замаскированы');
    const observation = record(row) ? row.observation ?? (rich ? 'unknown' : 'partial') : 'unknown';
    if (!['complete', 'partial', 'unknown'].includes(String(observation))) reasons.push('Некорректная полнота наблюдения');
    if (reasons.length) batch.rejected.push({ index, ...(dialogueId ? { id: dialogueId.slice(0, 200) } : {}), reasons: [...new Set(reasons)].slice(0, 20), original: row });
    else batch.dialogues.push({ id: dialogueId!, events: retained, observation: observation as 'complete' | 'partial' | 'unknown', original: row });
  });
  return importBatchSchema.parse(batch);
}

function businessIdentity(business: Pick<BusinessScenario, 'key' | 'goal' | 'conditions' | 'requirementIds'>): string {
  return digest({ key: normalize(business.key), goal: normalize(business.goal), conditions: business.conditions.map(normalize).sort(), requirementIds: [...business.requirementIds].sort() });
}

const factIdentity = (fact: ScenarioVariant['userState']['facts'][number]) => canonical({ statement: normalize(fact.statement), value: fact.value });
const actionIdentity = (variant: ScenarioVariant, action: ScenarioVariant['behaviorPolicy']['actions'][number]) => canonical({
  kind: action.kind,
  facts: action.factIds.map(id => variant.userState.facts.find(fact => fact.id === id)).filter(Boolean).map(fact => factIdentity(fact!)).sort(),
  payload: action.payload ? normalize(action.payload) : undefined,
  ifAsked: action.ifAsked ? normalize(action.ifAsked) : undefined,
});
const referencedActionIdentity = (variant: ScenarioVariant, actionId: string) => {
  const action = variant.behaviorPolicy.actions.find(item => item.id === actionId);
  return action ? actionIdentity(variant, action) : canonical({ missingAction: true });
};

/** Execution identity excludes incidental state/action/fact ids while retaining their reference graph. */
function policyIdentity(variant: ScenarioVariant): unknown {
  const policy = variant.behaviorPolicy;
  let stateLabels = new Map(policy.states.map(state => [state, digest({ initial: state === policy.initialState, terminal: policy.terminalStates.includes(state) })]));
  for (let pass = 0; pass < policy.states.length + 1; pass++) {
    const next = new Map<string, string>();
    for (const state of policy.states) {
      const outgoing = policy.transitions.filter(item => item.from === state).map(item => ({
        when: normalize(item.when), action: referencedActionIdentity(variant, item.actionId), to: stateLabels.get(item.to),
      })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
      const incoming = policy.transitions.filter(item => item.to === state).map(item => ({
        when: normalize(item.when), action: referencedActionIdentity(variant, item.actionId), from: stateLabels.get(item.from),
      })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
      next.set(state, digest({ initial: state === policy.initialState, terminal: policy.terminalStates.includes(state), outgoing, incoming }));
    }
    stateLabels = next;
  }
  return {
    version: policy.version, maxFollowUps: policy.maxFollowUps, repetitionLimit: policy.repetitionLimit,
    initial: stateLabels.get(policy.initialState), terminals: policy.terminalStates.map(state => stateLabels.get(state)).sort(),
    states: policy.states.map(state => stateLabels.get(state)).sort(),
    actions: policy.actions.map(action => actionIdentity(variant, action)).sort(),
    transitions: policy.transitions.map(item => canonical({ from: stateLabels.get(item.from), to: stateLabels.get(item.to),
      action: referencedActionIdentity(variant, item.actionId), when: normalize(item.when) })).sort(),
  };
}

function executionFingerprint(library: ScenarioLibrary, variant: ScenarioVariant): string {
  const group = library.businessScenarios.find(item => item.id === variant.businessScenarioId);
  const initial = variant.userState.facts.filter(fact => fact.availability === 'initial');
  return digest({
    business: group && { goal: normalize(group.goal), conditions: group.conditions.map(normalize).sort() },
    user: { goal: normalize(variant.userState.goal), opening: normalize(variant.userState.opening),
      facts: initial.map(factIdentity).sort(), cannotKnow: variant.userState.cannotKnow.map(normalize).sort(),
      missing: variant.userState.missing.map(normalize).sort(), persona: variant.userState.persona ? normalize(variant.userState.persona.text) : undefined },
    policy: policyIdentity(variant), environment: variant.environmentFixture,
    evaluation: { successCriteria: normalize(variant.evaluationSpec.successCriteria), goalObservation: variant.evaluationSpec.goalObservation,
      checkpoints: variant.evaluationSpec.checkpoints.map(checkpoint => ({ applicability: normalize(checkpoint.applicability),
        observation: checkpoint.observation, role: checkpoint.role, rule: normalize(checkpoint.rule), check: checkpoint.check })).sort((a, b) => canonical(a).localeCompare(canonical(b))) },
  });
}

export function createLibrary(input: { id?: string; batch?: ImportBatch; sources: Source[]; requirements: Requirement[]; proposals: unknown[]; createdAt?: string; semanticRequired?: true }): ScenarioLibrary {
  if (input.proposals.length > 200) throw new Error('Допустимо не больше 200 вариантов');
  const batch = input.batch ? importBatchSchema.parse(input.batch) : undefined;
  const groups = new Map<string, BusinessScenario>();
  const variants: ScenarioVariant[] = [];
  for (const raw of input.proposals) {
    const { business, variant } = scenarioProposalSchema.parse(raw);
    const key = businessIdentity(business);
    const existing = groups.get(key);
    const businessScenarioId = existing?.id ?? `business_${key.slice(0, 24)}`;
    const group = existing ?? { ...business, id: businessScenarioId, sourceDialogues: [] };
    if (business.grouping.status === 'uncertain') group.grouping = business.grouping;
    group.sourceDialogues = uniqueRefs([...group.sourceDialogues, ...variant.sourceDialogues]);
    groups.set(key, group);
    variants.push({ ...variant, businessScenarioId, familyId: businessScenarioId, revision: 1, quality: 'needs_review', issues: [], ownerDecision: 'pending', history: [{ author: 'generator', reason: 'Структурированное предложение из источников', revision: 1 }] });
  }
  unifyFamilies(variants);
  const library = scenarioLibrarySchema.parse({ checkpointContext:'observed-tools-v1', formatVersion: 1, id: input.id ?? `library_${digest({ batchId: batch?.id, proposals: input.proposals }).slice(0, 24)}`, revision: 1, createdAt: input.createdAt ?? new Date().toISOString(), imports: batch ? [batch] : [], ...(input.semanticRequired ? { semanticRequired: true } : {}), sources: input.sources, requirements: input.requirements, businessScenarios: [...groups.values()], variants });
  return refreshQuality(library);
}

/** Add generated cases to a draft without re-generating the history or authority of existing cards. */
export function appendScenarioProposals(library: ScenarioLibrary, proposals: unknown[], requirements: Requirement[]): ScenarioLibrary {
  if (library.acceptance) throw new Error('Принятый набор нельзя дополнять подготовкой. Сначала создайте новый черновик.');
  const next = scenarioLibrarySchema.parse(library);
  const added = createLibrary({ id: next.id, batch: next.imports[0], sources: next.sources, requirements, proposals, semanticRequired: true });
  if (next.variants.length + added.variants.length > 200) throw new Error('Допустимо не больше 200 вариантов');
  if (added.variants.some(variant => next.variants.some(existing => existing.id === variant.id))) throw new Error('Новое предложение использует ID существующей карточки.');
  for (const group of added.businessScenarios) {
    const existing = next.businessScenarios.find(item => businessIdentity(item) === businessIdentity(group));
    if (existing) {
      existing.sourceDialogues = uniqueRefs([...existing.sourceDialogues, ...group.sourceDialogues]);
      for (const variant of added.variants.filter(item => item.businessScenarioId === group.id)) {
        variant.businessScenarioId = existing.id;
        variant.familyId = next.variants.find(item => item.businessScenarioId === existing.id)?.familyId ?? existing.id;
      }
    } else next.businessScenarios.push(group);
  }
  next.requirements = structuredClone(requirements);
  next.variants.push(...added.variants);
  unifyFamilies(next.variants);
  next.revision++;
  return refreshQuality(next);
}

/** Includes all source evidence and drafts; acceptance is a receipt over this document. */
export function libraryHash(library: ScenarioLibrary): string {
  const { acceptance: _acceptance, ...body } = library;
  return digest(body);
}

/** Findings bind to all evidence and editable content, not derived quality or acceptance badges. */
export function semanticContentHash(library: ScenarioLibrary): string {
  return digest({ imports: library.imports, sources: library.sources, requirements: library.requirements,
    ...(library.readingManifest ? { readingManifest: library.readingManifest } : {}),
    businessScenarios: library.businessScenarios, variants: library.variants.map(({ quality, issues, ownerDecision, ...content }) => content) });
}
export function semanticPaths(variant: ScenarioVariant, options: { includeOutcome?: boolean } = {}): string[] {
  return ['userState', ...variant.userState.facts.map(f => `userState.facts.${f.id}`), 'behaviorPolicy', 'environmentFixture',
    ...(variant.sourceCoverageRequired || variant.sourceCoverageBasis?.length || variant.sourceCoverage?.length ? ['sourceCoverage'] : []),
    ...(options.includeOutcome === false ? [] : ['evaluationSpec.successCriteria']),
    'businessScenarioId', 'duplicates', ...variant.evaluationSpec.checkpoints.map(c => `evaluationSpec.checkpoints.${c.id}`)];
}

/** Only actions on a bounded, completable controller path count as preserved source behavior. */
function reachableSourceActions(variant: ScenarioVariant): Set<string> {
  const queue = [createUserState(variant.behaviorPolicy, variant.userState.facts.filter(f => f.availability === 'initial'))];
  const seen = new Set<string>(), reached = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    if (index >= 2000) throw new Error('Покрытие исходных реплик требует слишком сложного пути политики');
    const state = queue[index]!;
    const key = canonical([state.position, state.counts, state.followUps, state.changed]);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const action of allowedUserActions(state, '')) {
      reached.add(action.id);
      queue.push(advanceUser(state, { actionId: action.id, factIds: action.factIds }).state);
    }
  }
  return reached;
}
export function recordSemanticAssessment(library: ScenarioLibrary, findings: SemanticFinding[], contextVersion?: number): ScenarioLibrary {
  const next = scenarioLibrarySchema.parse(library);
  delete next.acceptance;
  next.semanticRequired = true;
  for (const variant of next.variants) { variant.ownerDecision = 'pending'; delete variant.semanticReviewRequired; }
  next.semanticAssessment = { ...(contextVersion ? { contextVersion } : {}), contentHash: semanticContentHash(next), findings };
  return refreshQuality(next);
}

/**
 * What an owner resolution is about: the remark, and the exact card, requirements and sources it was made on. The remark's words alone
 * are not an identity — the same sentence about a rewritten rule is a new question for the owner.
 */
export function resolutionHash(library: ScenarioLibrary, variant: ScenarioVariant, path: string, reason: string): string {
  const { quality, issues, ownerDecision, history, revision, semanticReviewRequired, ...content } = variant;
  return digest({ path, reason, card: content, requirements: library.requirements, sources: library.sources.map(source => source.hash) });
}

/** Additive binding on new receipts; old accepted snapshots keep their original hash and remain executable. */
export function resolutionBusinessHash(library: ScenarioLibrary, variant: ScenarioVariant): string {
  const group = library.businessScenarios.find(item => item.id === variant.businessScenarioId);
  return digest(group ? { goal: group.goal, conditions: group.conditions, requirementIds: group.requirementIds } : null);
}

/** Conservative shared question identity: the same rule, applicability, source version and exact checker uncertainty. */
export function resolutionQuestionHash(library: ScenarioLibrary, variant: ScenarioVariant, path: string, reason: string): string | undefined {
  const checkpoint = variant.evaluationSpec.checkpoints.find(item => path === `evaluationSpec.checkpoints.${item.id}`);
  const requirement = checkpoint && library.requirements.find(item => item.id === checkpoint.requirementId);
  const source = requirement && library.sources.find(item => item.id === requirement.sourceId);
  if (!checkpoint || !requirement || !source) return undefined;
  const { id: _id, ...rule } = checkpoint;
  return digest({ rule, requirement, source: { id: source.id, hash: source.hash }, business: resolutionBusinessHash(library, variant), reason });
}

export function libraryQuality(library: ScenarioLibrary): LibraryQualityIssue[] {
  const issues: LibraryQualityIssue[] = [];
  const add = (code: string, path: string, message: string, variantId?: string, severity: LibraryQualityIssue['severity'] = 'blocked') => issues.push({ code, path, message, ...(variantId ? { variantId } : {}), severity });
  if (library.semanticRequired) {
    const assessment = library.semanticAssessment;
    const contentHash = semanticContentHash(library);
    for (const variant of library.variants) {
      if (!assessment || assessment.contentHash !== contentHash) {
        add('semantic_pending', `variants.${variant.id}`, 'Смысловая проверка отсутствует или устарела', variant.id, 'needs_review');
        continue;
      }
      // Before v11 the outcome had no separate obligation. Historical accepted snapshots remain readable;
      // a new assessment explicitly checks it and cannot become ready on checkpoint findings alone.
      const paths = semanticPaths(variant, { includeOutcome: (assessment.contextVersion ?? 0) >= 11
        || assessment.findings.some(finding => finding.variantId === variant.id && finding.path === 'evaluationSpec.successCriteria') });
      for (const path of paths) {
        const findings = assessment.findings.filter(f => f.variantId === variant.id && f.path === path);
        if (findings.length !== 1) add('semantic_missing', `variants.${variant.id}.${path}`, 'Нужна отдельная смысловая проверка поля', variant.id, 'needs_review');
        else if (findings[0]!.status !== 'ready') {
          // A question the owner settled in their own name stays settled for exactly that remark; a blocking remark is never the owner's to waive.
          const settled = findings[0]!.status === 'needs_review' && library.ownerResolutions?.some(item => item.variantId === variant.id && item.path === path
            && item.findingHash === resolutionHash(library, variant, path, findings[0]!.reason)
            && (!item.businessHash || item.businessHash === resolutionBusinessHash(library, variant)));
          if (!settled) add('semantic_finding', `variants.${variant.id}.${path}`, findings[0]!.reason, variant.id, findings[0]!.status as 'needs_review' | 'blocked');
        }
      }
      for (const finding of assessment.findings.filter(f => f.variantId === variant.id && !paths.includes(f.path) && f.status !== 'ready')) {
        add('semantic_finding', `variants.${variant.id}.${finding.path}`, finding.reason, variant.id, finding.status as 'needs_review' | 'blocked');
      }
    }
  }
  const duplicateIds = (values: { id: string }[], path: string) => {
    const seen = new Set<string>();
    for (const value of values) { if (seen.has(value.id)) add('duplicate_id', path, `Повторяющийся id: ${value.id}`); seen.add(value.id); }
  };
  duplicateIds(library.variants, 'variants'); duplicateIds(library.businessScenarios, 'businessScenarios'); duplicateIds(library.requirements, 'requirements'); duplicateIds(library.sources, 'sources'); duplicateIds(library.imports, 'imports');
  const validRef = (ref: SourceDialogue) => library.imports.find(b => b.id === ref.batchId)?.dialogues.find(d => d.id === ref.dialogueId);
  for (const requirement of library.requirements) {
    const source = library.sources.find(s => s.id === requirement.sourceId);
    if (!source?.content.includes(requirement.quote)) add('invalid_requirement', `requirements.${requirement.id}`, 'Цитата требования отсутствует в источнике');
  }
  const fingerprints = new Map<string, string>();
  for (const variant of library.variants) {
    const v = variant.id;
    const problem = (code: string, path: string, message: string, severity: LibraryQualityIssue['severity'] = 'blocked') => add(code, `variants.${v}.${path}`, message, v, severity);
    const group = library.businessScenarios.find(b => b.id === variant.businessScenarioId);
    if (variant.semanticReviewRequired) problem('semantic_variant_pending', '', 'Изменённый или целевой вариант требует смысловой проверки', 'needs_review');
    if (!group) problem('missing_business', 'businessScenarioId', 'Бизнес-сценарий отсутствует');
    if (group?.grouping.status === 'uncertain') problem('uncertain_grouping', 'businessScenarioId', group.grouping.reason, 'needs_review');
    if (group?.requirementIds.some(id => !library.requirements.some(r => r.id === id))) problem('missing_requirement', 'businessScenarioId', 'Ссылка на неизвестное требование');
    if (variant.provenance === 'production' && !variant.sourceDialogues.length) problem('missing_source', 'sourceDialogues', 'Для production нужны исходные диалоги');
    for (const ref of variant.sourceDialogues) if (!validRef(ref)) problem('missing_source', 'sourceDialogues', 'Исходный диалог не найден');
    if (variant.sourceCoverageRequired || variant.sourceCoverageBasis?.length || variant.sourceCoverage?.length) {
      const coverage = variant.sourceCoverage ?? [];
      if (variant.sourceCoverageRequired && !variant.sourceCoverageBasis?.length) problem('source_coverage_basis', 'sourceCoverage', 'Отсутствует сохранённое основание обязательного покрытия исходных реплик');
      const basis = variant.sourceCoverageBasis ?? variant.sourceDialogues.flatMap(ref => (validRef(ref)?.events.filter(e => e.type === 'message' && e.role === 'user').slice(1) ?? [])
        .map(event => ({ ...ref, eventIndex: event.index })));
      const later = basis.flatMap(ref => {
        const event = validRef(ref)?.events.filter(e => e.type === 'message' && e.role === 'user').slice(1).find(e => e.index === ref.eventIndex);
        if (!event) problem('source_coverage_basis', 'sourceCoverage', 'Обязательная исходная реплика не найдена в сохранённом импорте');
        if (!variant.sourceDialogues.some(source => source.batchId === ref.batchId && source.dialogueId === ref.dialogueId)) {
          problem('source_coverage_reference', 'sourceCoverage', 'Нельзя заменить или удалить исходный диалог обязательного покрытия');
        }
        return event ? [{ ...ref, event }] : [];
      });
      const sameTurn = (entry: (typeof coverage)[number], turn: (typeof later)[number]) => entry.batchId === turn.batchId && entry.dialogueId === turn.dialogueId && entry.eventIndex === turn.event.index;
      if (variant.sourceCoverageRequired && !variant.sourceDialogues.length) problem('source_coverage_missing', 'sourceCoverage', 'Для проверки покрытия нужны исходные диалоги');
      if (!library.semanticRequired) problem('source_coverage_review', 'sourceCoverage', 'Покрытие исходных реплик требует смысловой проверки', 'needs_review');
      for (const turn of later) if (coverage.filter(entry => sameTurn(entry, turn)).length !== 1) {
        problem('source_coverage_missing', 'sourceCoverage', `Нужен ровно один разбор исходной реплики ${turn.dialogueId} #${turn.event.index}`);
      }
      let reachable: Set<string> | undefined;
      for (const entry of coverage) {
        if (!later.some(turn => sameTurn(entry, turn))) problem('source_coverage_reference', 'sourceCoverage', 'Разбор ссылается не на последующую реплику клиента из источника');
        if (entry.disposition === 'conditional_action') {
          try { reachable ??= reachableSourceActions(variant); }
          catch { problem('source_coverage_action', 'sourceCoverage', 'Нельзя подтвердить достижимость исходного продолжения в политике'); }
          if (entry.factIds.length) problem('source_coverage_action', 'sourceCoverage', 'conditional_action требует пустой factIds; факты указываются внутри behaviorPolicy.actions, а в sourceCoverage — только actionIds');
          if (!entry.actionIds.length || entry.actionIds.some(id => !reachable?.has(id) || variant.behaviorPolicy.actions.find(a => a.id === id)?.kind === 'finish')) {
            problem('source_coverage_action', 'sourceCoverage', 'Исходное продолжение должно ссылаться на достижимое действие клиента с сообщением');
          }
        } else if (entry.disposition === 'initial_fact') {
          if (!entry.factIds.length || entry.actionIds.length || entry.factIds.some(id => {
            const fact = variant.userState.facts.find(f => f.id === id);
            if (!fact || fact.availability !== 'initial') return true;
            if (fact.origin.kind === 'owner') return !ownerFactReceipt(library, variant, fact) || !variant.sourceCoverageBasis?.some(turn => turn.batchId === entry.batchId && turn.dialogueId === entry.dialogueId && turn.eventIndex === entry.eventIndex);
            return fact.origin.kind !== 'dialogue' || fact.origin.batchId !== entry.batchId || fact.origin.dialogueId !== entry.dialogueId || fact.origin.eventIndex !== entry.eventIndex;
          })) problem('source_coverage_fact', 'sourceCoverage', 'Исходное знание должно ссылаться на исходный факт с происхождением в этой реплике; наблюдение после инструкции проверяется отдельно');
        } else if (entry.actionIds.length || entry.factIds.length) problem('source_coverage_reference', 'sourceCoverage', 'Исключение реплики содержит только обоснование, без ссылок на действия или факты');
      }
    }
    if (variant.provenance === 'synthetic' && (!variant.parentVariantId || !variant.mutationReason || !library.variants.some(p => p.id === variant.parentVariantId && p.id !== v))) problem('synthetic_provenance', 'parentVariantId', 'Нужны родительский вариант и причина изменения');
    const factIds = new Set<string>();
    const values = new Map<string, string>();
    for (const fact of variant.userState.facts) {
      const path = `userState.facts.${fact.id}`;
      if (factIds.has(fact.id)) problem('duplicate_fact', path, 'Повторяющийся id факта');
      factIds.add(fact.id);
      if (fact.availability === 'uncertain') problem('uncertain_fact', path, fact.reason, 'needs_review');
      if (fact.value !== undefined && !containsExactValue(fact.statement, String(fact.value))) problem('fact_value_mismatch', path, 'Точное значение отсутствует в утверждении');
      if (fact.availability === 'initial') {
        const key = normalize(fact.statement.split(':')[0]!);
        if (fact.value !== undefined && values.has(key) && values.get(key) !== String(fact.value)) problem('contradictory_facts', path, 'Исходные факты противоречат друг другу');
        if (fact.value !== undefined) values.set(key, String(fact.value));
      }
      const origin = fact.origin;
      if (origin.kind === 'dialogue') {
        const event = validRef(origin)?.events.find(e => e.index === origin.eventIndex);
        if (!variant.sourceDialogues.some(r => r.batchId === origin.batchId && r.dialogueId === origin.dialogueId) || !event?.content?.includes(origin.quote)) problem('invalid_citation', `${path}.origin`, 'Цитата не совпадает с указанным событием источника');
        // Without an explicit value, only a normalized source extract is deterministically grounded.
        const verbatim = [origin.quote, event?.content ?? ''].every(source => normalize(source).includes(normalize(fact.statement)) && containsExactValue(source, fact.statement));
        if (fact.value === undefined && !verbatim) problem('unverified_fact_statement', path, 'Пересказ без точного значения требует проверки: укажите подтверждённое значение или исправьте факт от имени владельца', 'needs_review');
        const sourceTokens = new Set(exactTokens(origin.quote));
        const eventTokens = new Set(exactTokens(event?.content ?? ''));
        const fabricatedToken = exactTokens(fact.statement).some(token => /\p{N}/u.test(token) && (!sourceTokens.has(token) || !eventTokens.has(token)));
        if (fabricatedToken || fact.value !== undefined && (!containsExactValue(origin.quote, String(fact.value)) || !containsExactValue(event?.content ?? '', String(fact.value)))) problem('ungrounded_value', path, 'Точное значение факта отсутствует в цитате или исходном событии');
        if (fact.availability === 'initial' && event?.role !== 'user') problem('agent_fact_as_initial', path, 'Ответ старого агента не является исходным знанием пользователя');
      } else if (origin.kind === 'owner' && !ownerFactReceipt(library, variant, fact)) problem('unverified_owner_fact', path, 'Нет записанной правки владельца, подтверждающей факт');
      else if (origin.kind === 'synthetic' && (variant.provenance !== 'synthetic' || origin.parentVariantId !== variant.parentVariantId || !library.variants.some(p => p.id === origin.parentVariantId && p.id !== v))) problem('synthetic_provenance', path, 'Синтетическое допущение не связано с родителем варианта');
    }
    const persona = variant.userState.persona;
    if (persona && !ownerPersonaReceipt(library, variant, persona)) problem('unverified_owner_persona', 'userState.persona', 'Нет записанного выбора профиля владельцем');
    const initial = variant.userState.facts.filter(f => f.availability === 'initial');
    const policy = variant.behaviorPolicy;
    try { requiredUserTurns(policy, initial); }
    catch (error) { problem('controller_policy', 'behaviorPolicy', error instanceof Error ? error.message : String(error)); }
    const payloads = [variant.userState.goal, variant.userState.opening, variant.userState.persona?.text ?? '', ...variant.userState.missing, ...variant.userState.cannotKnow, ...policy.actions.flatMap(a => [a.payload ?? '', a.ifAsked ?? '']), ...policy.transitions.map(t => t.when)];
    for (const fact of variant.userState.facts.filter(f => f.availability !== 'initial')) {
      const excluded = normalize(String(fact.value ?? fact.statement));
      if ([...payloads, ...initial.map(f => f.statement)].some(p => normalize(p).includes(excluded))) problem('excluded_fact_leak', 'userState', 'Исключённый факт попал в пользовательскую реплику или политику');
    }
    const allowedTokens = valueTokens(initial.map(f => f.statement).join(' '));
    if (payloads.some(p => [...valueTokens(p)].some(token => !allowedTokens.has(token)))) problem('ungrounded_user_value', 'userState', 'В пользовательских данных есть значение без исходного факта');
    const states = new Set(policy.states);
    const actionIds = new Set(policy.actions.map(a => a.id));
    if (!states.has(policy.initialState) || policy.terminalStates.some(s => !states.has(s)) || actionIds.size !== policy.actions.length) problem('invalid_policy', 'behaviorPolicy', 'Неизвестное состояние или повторяющееся действие');
    for (const action of policy.actions) {
      if (action.kind === 'observe') {
        if (action.factIds.length || !action.payload) problem('invalid_policy', 'behaviorPolicy.actions', 'Наблюдение после действия агента записывается репликой, без исходного факта');
        continue;
      }
      if (action.factIds.some(id => !initial.some(f => f.id === id))) problem('excluded_fact_action', 'behaviorPolicy.actions', 'Действие ссылается на недоступный факт');
      if ((action.kind === 'answer' || action.kind === 'correct') && !action.factIds.length) problem('invalid_policy', 'behaviorPolicy.actions', 'Ответ должен ссылаться на исходные факты');
      if (action.kind === 'change_intent' && !action.payload) problem('invalid_policy', 'behaviorPolicy.actions', 'Смена намерения должна быть объявлена');
    }
    for (const transition of policy.transitions) if (!states.has(transition.from) || !states.has(transition.to) || !actionIds.has(transition.actionId) || policy.terminalStates.includes(transition.from)) problem('invalid_policy', 'behaviorPolicy.transitions', 'Недопустимый переход');
    // An empty finish consumes no target reply; admission uses message cost, not edge count.
    const distances = new Map<string, number>([[policy.initialState, 0]]);
    for (let iteration = 0; iteration < policy.states.length; iteration++) for (const transition of policy.transitions) {
      const action = policy.actions.find(a => a.id === transition.actionId);
      const cost = (distances.get(transition.from) ?? Infinity) + (action?.kind === 'finish' ? 0 : 1);
      if (cost < (distances.get(transition.to) ?? Infinity)) distances.set(transition.to, cost);
    }
    const terminalReachable = policy.terminalStates.some(state => (distances.get(state) ?? Infinity) <= policy.maxFollowUps);
    if (!terminalReachable) problem('unreachable_stop', 'behaviorPolicy', 'Завершение недостижимо в пределах лимита продолжений');
    const environment = variant.environmentFixture;
    const world = worldSchema.safeParse(environment.initialState);
    const initialText = initial.map(f => normalize(f.statement));
    const hiddenValues = scalarValues(environment.initialState).map(normalize).filter(value => value.length >= 3 && !initialText.some(fact => fact.includes(value)));
    if (hiddenValues.some(value => payloads.some(payload => normalize(payload).includes(value)))) problem('hidden_state_leak', 'userState', 'Скрытое значение окружения попало в пользовательские данные');
    if (!world.success) problem('invalid_environment', 'environmentFixture', 'Окружение несовместимо с исполнимым Scenario');
    if (environment.mode === 'prompt' && world.success && (Object.keys(world.data.records).length || world.data.writableFields.length || world.data.transientFailures || world.data.external)) problem('unsupported_environment', 'environmentFixture', 'Управляемое состояние требует подтверждённого договора fixture');
    if (environment.mode === 'managed' && (!environment.contract?.confirmed || !environment.contract.reset)) problem('unsupported_environment', 'environmentFixture', 'Не подтверждены договор и сброс окружения');
    const supportsObservation = (observation: 'reply' | 'tool' | 'state') => observation === 'reply' || environment.mode === 'managed' && environment.contract?.confirmed && environment.contract.reset && environment.contract.observations.includes(observation);
    if (!supportsObservation(variant.evaluationSpec.goalObservation)) problem('unobservable_goal', 'evaluationSpec.goalObservation', 'Не подтверждён канал наблюдения результата');
    const checkpoints = variant.evaluationSpec.checkpoints;
    if (!checkpoints.some(c => c.role === 'required')) problem('missing_expectation', 'evaluationSpec', 'Нужна обязательная контрольная точка');
    const cpIds = new Set<string>();
    for (const cp of checkpoints) {
      if (cpIds.has(cp.id)) problem('duplicate_checkpoint', 'evaluationSpec.checkpoints', 'Повторяющийся id контрольной точки');
      cpIds.add(cp.id);
      const requirement = library.requirements.find(r => r.id === cp.requirementId);
      if (!requirement || !group?.requirementIds.includes(cp.requirementId) || !requirement.quote.includes(cp.quote)) problem('invalid_checkpoint_citation', `evaluationSpec.checkpoints.${cp.id}`, 'Контрольная точка не подтверждена применимым требованием');
      const path = `evaluationSpec.checkpoints.${cp.id}`;
      if (cp.check !== undefined) {
        const parsed = checkSchema.safeParse(cp.check);
        if (!parsed.success) problem('invalid_check', path, 'Проверка несовместима с исполнимым Scenario');
        else {
          const check = parsed.data;
          const channel = ({ state_equals: 'state', tool_called: 'tool', tool_not_called: 'tool', tool_count: 'tool', fresh_read_before_update: 'tool', answer_contains: 'reply', answer_equals: 'reply', answer_omits: 'reply' } as const)[check.kind];
          if (channel !== cp.observation) problem('check_observation_mismatch', path, 'Канал конкретной проверки не совпадает с объявленным наблюдением');
          if (!supportsObservation(channel)) problem('unobservable_checkpoint', path, 'Не подтверждён канал конкретной проверки');
          if (check.kind === 'state_equals') {
            const state = world.success ? world.data.records[check.recordId] : undefined;
            if (!state || !Object.hasOwn(state, check.field)) problem('invalid_state_check', path, 'Запись или поле проверки отсутствует в fixture');
            else if (world.success && !Object.is(state[check.field], check.value) && (!world.data.writableFields.includes(check.field) || environment.mode !== 'managed' || !environment.contract?.operations.includes('update_record'))) problem('unreachable_state_check', path, 'Изменение состояния требует доступного для записи поля и объявленной операции update_record');
          }
          const operations = 'tool' in check ? [check.tool] : check.kind === 'fresh_read_before_update' ? ['lookup_record', 'update_record'] : [];
          if (operations.some(operation => environment.mode !== 'managed' || !environment.contract?.operations.includes(operation))) problem('unsupported_check_operation', path, 'Проверка требует неподдержанной операции fixture');
        }
      }
      if (!supportsObservation(cp.observation)) problem('unobservable_checkpoint', path, 'Не подтверждён канал наблюдения');
    }
    // Excludes names and evidence references: exact duplicates cannot inflate the runnable set.
    const fingerprint = executionFingerprint(library, variant);
    const duplicate = fingerprints.get(fingerprint);
    if (duplicate) { problem('duplicate_variant', 'id', `Точный дубль варианта ${duplicate}`); add('duplicate_variant', `variants.${duplicate}.id`, `Точный дубль варианта ${v}`, duplicate); }
    else fingerprints.set(fingerprint, v);
    try { compileVariant(library, variant); } catch { problem('incompatible_scenario', '', 'Вариант не помещается в исполнимый контракт Scenario'); }
  }
  return issues;
}

function refreshQuality(library: ScenarioLibrary): ScenarioLibrary {
  const issues = libraryQuality(library);
  for (const variant of library.variants) {
    variant.issues = issues.filter(i => !i.variantId || i.variantId === variant.id);
    variant.quality = variant.issues.some(i => i.severity === 'blocked') ? 'blocked' : variant.issues.length ? 'needs_review' : 'ready';
  }
  return scenarioLibrarySchema.parse(library);
}

/** Harness-authenticated owner grounding; semantic readiness is still assessed independently. */
export function ownerFactEvidence(library: ScenarioLibrary, variant: ScenarioVariant): { variantId: string; factId: string; editId: string; status: 'verified' | 'unverified' }[] {
  return variant.userState.facts.flatMap(fact => fact.origin.kind === 'owner' ? [{
    variantId: variant.id, factId: fact.id, editId: fact.origin.editId,
    status: ownerFactReceipt(library, variant, fact) ? 'verified' as const : 'unverified' as const,
  }] : []);
}

function ownerFactReceipt(library: ScenarioLibrary, variant: ScenarioVariant, fact: ScenarioVariant['userState']['facts'][number], seen = new Set<string>()): boolean {
  if (seen.has(variant.id)) return false;
  seen.add(variant.id);
  if (variant.history.some(entry => entry.author === 'owner' && entry.factEdit?.factId === fact.id
    && fact.origin.kind === 'owner' && entry.factEdit.editId === fact.origin.editId && entry.factEdit.factHash === digest(fact))) return true;
  if (!variant.parentVariantId) return false;
  const parent = library.variants.find(item => item.id === variant.parentVariantId);
  const inherited = parent?.userState.facts.find(item => item.id === fact.id);
  return !!parent && !!inherited && digest(inherited) === digest(fact) && ownerFactReceipt(library, parent, inherited, seen);
}

function ownerPersonaReceipt(library: ScenarioLibrary, variant: ScenarioVariant, persona: NonNullable<ScenarioVariant['userState']['persona']>, seen = new Set<string>()): boolean {
  if (seen.has(variant.id)) return false;
  seen.add(variant.id);
  if (variant.history.some(entry => entry.author === 'owner' && entry.personaEdit?.editId === persona.ownerEditId && entry.personaEdit.personaHash === digest(persona))) return true;
  if (!variant.parentVariantId) return false;
  const parent = library.variants.find(item => item.id === variant.parentVariantId);
  return !!parent && !!parent.userState.persona && digest(parent.userState.persona) === digest(persona) && ownerPersonaReceipt(library, parent, parent.userState.persona, seen);
}

function checkHash(library: ScenarioLibrary, expectedHash: string): void {
  if (libraryHash(library) !== expectedHash) throw new LibraryConflict('Библиотека изменилась: хеш устарел');
}
function unifyFamilies(variants: ScenarioVariant[]): void {
  for (let iteration = 0; iteration < variants.length; iteration++) {
    let changed = false;
    for (const v of variants) for (const other of variants) {
      if (v === other || v.familyId === other.familyId) continue;
      if (v.businessScenarioId === other.businessScenarioId || v.parentVariantId === other.id || other.parentVariantId === v.id || v.sourceDialogues.some(r => other.sourceDialogues.some(s => s.batchId === r.batchId && s.dialogueId === r.dialogueId))) {
        const family = [v.familyId, other.familyId].sort()[0]!;
        v.familyId = family; other.familyId = family; changed = true;
      }
    }
    if (!changed) break;
  }
}

/** The adapter supplies authorship separately from model-owned patch data. */
export function editLibrary(library: ScenarioLibrary, expectedHash: string, rawPatch: LibraryPatch, author: 'owner' | 'assistant' = 'owner'): ScenarioLibrary {
  checkHash(library, expectedHash);
  const patch = libraryPatchSchema.parse(rawPatch);
  if (author !== 'owner' && ['edit_fact', 'add_fact', 'resolve_finding', 'resolve_findings'].includes(patch.kind)) throw new Error('Для факта или решения от имени владельца нужно его подтверждение.');
  const next = scenarioLibrarySchema.parse(library);
  // Bind legacy decisions only when editing a new draft. Reading/compiling an accepted historical snapshot stays byte-identical.
  if (next.ownerResolutions) next.ownerResolutions = next.ownerResolutions.map(receipt => {
    const variant = next.variants.find(item => item.id === receipt.variantId);
    return receipt.businessHash || !variant ? receipt : { ...receipt, businessHash: resolutionBusinessHash(next, variant) };
  });
  const old = new Map(next.variants.map(v => [v.id, digest(v)]));
  const oldPersonas = new Map(next.variants.map(v => [v.id, digest(v.userState.persona ?? null)]));
  const getVariant = (id: string) => { const v = next.variants.find(v => v.id === id); if (!v) throw new Error(`Вариант ${id} не найден`); return v; };
  const getBusiness = (id: string) => { const b = next.businessScenarios.find(b => b.id === id); if (!b) throw new Error(`Бизнес-сценарий ${id} не найден`); return b; };
  if (patch.kind === 'upsert_variant') {
    getBusiness(patch.variant.businessScenarioId);
    const index = next.variants.findIndex(v => v.id === patch.variant.id);
    if (index < 0) next.variants.push({ ...patch.variant, revision: 1, history: [] });
    else next.variants[index] = { ...patch.variant,
      ...(next.variants[index]!.sourceCoverageRequired ? { sourceCoverageRequired: true as const } : {}),
      ...(next.variants[index]!.sourceCoverageBasis ? { sourceCoverageBasis: structuredClone(next.variants[index]!.sourceCoverageBasis) } : {}),
      revision: next.variants[index]!.revision, history: next.variants[index]!.history, familyId: next.variants[index]!.familyId };
  } else if (patch.kind === 'remove_variant') {
    getVariant(patch.variantId);
    next.variants = next.variants.filter(v => v.id !== patch.variantId);
  } else if (patch.kind === 'edit_fact' || patch.kind === 'add_fact') {
    const variant = getVariant(patch.variantId);
    let fact = variant.userState.facts.find(f => f.id === patch.factId);
    if (patch.kind === 'add_fact') {
      if (fact) throw new Error('Факт с таким id уже существует');
      if (variant.userState.facts.length >= 20) throw new Error('Допустимо не больше 20 фактов');
      fact = { id: patch.factId, statement: patch.statement, availability: patch.availability, reason: patch.reason, origin: { kind: 'owner', editId: patch.editId, text: patch.reason } };
      variant.userState.facts.push(fact);
    }
    if (!fact) throw new Error('Факт не найден');
    Object.assign(fact, { statement: patch.statement, availability: patch.availability, reason: patch.reason, origin: { kind: 'owner', editId: patch.editId, text: patch.reason } });
    if (patch.value === undefined) delete fact.value; else fact.value = patch.value;
    variant.semanticReviewRequired = true;
  } else if (patch.kind === 'resolve_findings') {
    if (!next.semanticAssessment || next.semanticAssessment.contentHash !== semanticContentHash(next)) throw new LibraryConflict('Библиотека изменилась: смысловая проверка устарела');
    // Validate the complete scope before recording any receipt. The owning store publishes this one library revision atomically.
    const resolutions = patch.findings.map(item => {
      const variant = getVariant(item.variantId);
      const findings = next.semanticAssessment!.findings.filter(finding => finding.variantId === variant.id && finding.path === item.path);
      const finding = findings[0];
      if (!semanticPaths(variant).includes(item.path) || findings.length !== 1 || !finding || finding.status === 'ready') throw new Error('По выбранному полю нет единственного открытого вопроса проверяющего');
      if (finding.status === 'blocked') throw new Error('Это замечание блокирует запуск: его снимает исправление карточки, а не решение владельца');
      const findingHash = resolutionHash(next, variant, item.path, finding.reason);
      if (item.findingHash !== findingHash) throw new LibraryConflict('Библиотека изменилась: вопрос или его основание устарели');
      const businessHash = resolutionBusinessHash(next, variant);
      if (next.ownerResolutions?.some(old => old.variantId === item.variantId && old.path === item.path && old.findingHash === findingHash && (!old.businessHash || old.businessHash === businessHash))) throw new Error('Выбранный вопрос уже закрыт решением владельца');
      return { ...item, businessHash, editId: patch.editId, reason: patch.reason, questionHash: resolutionQuestionHash(next, variant, item.path, finding.reason) };
    });
    if (new Set(resolutions.map(item => item.variantId)).size > 1
      && (!resolutions[0]!.questionHash || resolutions.some(item => item.questionHash !== resolutions[0]!.questionHash))) {
      throw new Error('Выбранные карточки не имеют одного общего вопроса по тому же правилу и условиям. Ничего не записано.');
    }
    next.ownerResolutions = [...(next.ownerResolutions ?? []).filter(old => !resolutions.some(item => item.variantId === old.variantId && item.path === old.path)),
      ...resolutions.map(({ questionHash: _questionHash, ...receipt }) => receipt)];
  } else if (patch.kind === 'resolve_finding') {
    const variant = getVariant(patch.variantId);
    const finding = next.semanticAssessment?.findings.find(item => item.variantId === variant.id && item.path === patch.path);
    if (!finding || finding.status === 'ready') throw new Error('По этому полю нет открытого вопроса проверяющего');
    if (finding.status === 'blocked') throw new Error('Это замечание блокирует запуск: его снимает исправление карточки, а не решение владельца');
    next.ownerResolutions = [...(next.ownerResolutions ?? []).filter(item => !(item.variantId === variant.id && item.path === patch.path)),
      { variantId: variant.id, path: patch.path, findingHash: resolutionHash(next, variant, patch.path, finding.reason), editId: patch.editId, reason: patch.reason }];
  } else if (patch.kind === 'edit_behavior') {
    const variant = getVariant(patch.variantId);
    if (patch.behaviorPolicy) variant.behaviorPolicy = structuredClone(patch.behaviorPolicy);
    if (patch.sourceCoverage) variant.sourceCoverage = structuredClone(patch.sourceCoverage);
    variant.semanticReviewRequired = true;
  } else if (patch.kind === 'edit_variant_text') {
    const variant = getVariant(patch.variantId);
    if (patch.field === 'opening') variant.userState.opening = patch.value;
    else if (patch.field === 'goal') variant.userState.goal = patch.value;
    else if (patch.field === 'successCriteria') variant.evaluationSpec.successCriteria = patch.value;
    else {
      if (!patch.checkpointId) throw new Error('Для правила выберите контрольную точку');
      const checkpoint = variant.evaluationSpec.checkpoints.find(item => item.id === patch.checkpointId);
      if (!checkpoint) throw new Error('Контрольная точка не найдена');
      checkpoint.rule = patch.value;
    }
    variant.semanticReviewRequired = true;
  } else if (patch.kind === 'edit_business') {
    const group = getBusiness(patch.businessScenarioId);
    if (patch.title !== undefined) group.title = patch.title;
    if (patch.goal !== undefined) group.goal = patch.goal;
    if (patch.conditions !== undefined) group.conditions = [...patch.conditions];
    // Repair legacy grouping metadata from the card definitions, never from model claims about readiness.
    group.requirementIds = [...new Set([...group.requirementIds, ...next.variants.filter(v => v.businessScenarioId === group.id).flatMap(v => v.evaluationSpec.checkpoints.map(c => c.requirementId))])];
    group.grouping = { status: 'confirmed', reason: patch.reason };
    for (const variant of next.variants.filter(item => item.businessScenarioId === group.id)) variant.semanticReviewRequired = true;
  } else if (patch.kind === 'merge_business') {
    const target = getBusiness(patch.targetId);
    if (patch.sourceIds.includes(target.id)) throw new Error('Нельзя объединить бизнес-сценарий с самим собой');
    for (const id of patch.sourceIds) {
      const source = getBusiness(id);
      target.sourceDialogues = uniqueRefs([...target.sourceDialogues, ...source.sourceDialogues]);
      target.requirementIds = [...new Set([...target.requirementIds, ...source.requirementIds])];
      target.conditions = [...new Set([...target.conditions, ...source.conditions])];
      for (const v of next.variants.filter(v => v.businessScenarioId === id)) v.businessScenarioId = target.id;
    }
    target.grouping = { status: 'confirmed', reason: patch.reason };
    next.businessScenarios = next.businessScenarios.filter(b => !patch.sourceIds.includes(b.id));
  } else {
    const source = getBusiness(patch.businessScenarioId);
    const moving = patch.variantIds.map(getVariant);
    if (moving.some(v => v.businessScenarioId !== source.id)) throw new Error('Вариант принадлежит другому бизнес-сценарию');
    const id = `business_${businessIdentity(patch.newBusiness).slice(0, 24)}`;
    if (next.businessScenarios.some(b => b.id === id)) throw new Error('Бизнес-сценарий с такими условиями уже существует');
    next.businessScenarios.push({ ...patch.newBusiness, id, sourceDialogues: uniqueRefs(moving.flatMap(v => v.sourceDialogues)) });
    for (const v of moving) v.businessScenarioId = id;
    source.sourceDialogues = uniqueRefs(next.variants.filter(v => v.businessScenarioId === source.id).flatMap(v => v.sourceDialogues));
  }
  unifyFamilies(next.variants);
  for (const group of next.businessScenarios) group.sourceDialogues = uniqueRefs([...group.sourceDialogues, ...next.variants.filter(v => v.businessScenarioId === group.id).flatMap(v => v.sourceDialogues)]);
  for (const variant of next.variants) {
    const previousHash = old.get(variant.id);
    if (previousHash !== digest(variant)) {
      if (previousHash) variant.revision++;
      const fact = (patch.kind === 'edit_fact' || patch.kind === 'add_fact') && patch.variantId === variant.id ? variant.userState.facts.find(f => f.id === patch.factId) : undefined;
      const persona = variant.userState.persona;
      variant.history.push({
        ...(previousHash ? { previousHash } : {}), author, reason: patch.reason, revision: variant.revision,
        ...(fact && (patch.kind === 'edit_fact' || patch.kind === 'add_fact') ? { factEdit: { factId: fact.id, editId: patch.editId, factHash: digest(fact) } } : {}),
        ...(patch.kind === 'upsert_variant' && patch.variant.id === variant.id && persona && oldPersonas.get(variant.id) !== digest(persona) ? { personaEdit: { editId: persona.ownerEditId, personaHash: digest(persona) } } : {}),
        ...(patch.kind === 'edit_variant_text' && patch.variantId === variant.id ? { textEdit: { editId: patch.editId, field: patch.field, valueHash: digest(patch.value) } } : {}),
      });
    }
    variant.ownerDecision = 'pending';
  }
  next.revision++;
  delete next.acceptance;
  return refreshQuality(next);
}

/** Generator-only append. It cannot mint owner receipts; inherited owner data is verified through the parent chain. */
export function addGeneratedVariant(library: ScenarioLibrary, expectedHash: string, rawVariant: ScenarioVariant, reason: string): ScenarioLibrary {
  checkHash(library, expectedHash);
  const next = scenarioLibrarySchema.parse(library);
  const candidate = scenarioVariantSchema.parse(rawVariant);
  if (next.variants.some(item => item.id === candidate.id)) throw new Error(`Вариант ${candidate.id} уже существует`);
  const parent = candidate.parentVariantId && next.variants.find(item => item.id === candidate.parentVariantId);
  if (!parent || candidate.provenance !== 'synthetic' || !candidate.mutationReason) throw new Error('Целевой вариант должен быть синтетическим потомком существующего варианта');
  if (candidate.businessScenarioId !== parent.businessScenarioId || candidate.familyId !== parent.familyId) throw new Error('Целевой вариант должен сохранить бизнес-группу и семейство родителя');
  if (canonical(candidate.sourceDialogues) !== canonical(parent.sourceDialogues)) throw new Error('Целевой вариант должен сохранить источники родителя');
  if (parent.sourceCoverageRequired) candidate.sourceCoverageRequired = true;
  if (parent.sourceCoverageBasis) candidate.sourceCoverageBasis = structuredClone(parent.sourceCoverageBasis);
  candidate.revision = 1;
  candidate.quality = 'needs_review'; candidate.issues = []; candidate.ownerDecision = 'pending'; candidate.semanticReviewRequired = true;
  candidate.history = [{ author: 'generator', reason, revision: 1 }];
  next.variants.push(candidate);
  unifyFamilies(next.variants);
  for (const variant of next.variants) variant.ownerDecision = 'pending';
  next.revision++;
  delete next.acceptance;
  const refreshed = refreshQuality(next);
  if (refreshed.variants.find(item => item.id === candidate.id)?.issues.some(issue => issue.code === 'duplicate_variant')) throw new Error('Точный дубль варианта уже существует');
  return refreshed;
}

export function acceptLibrary(library: ScenarioLibrary, expectedHash: string, variantIds: string[]): ScenarioLibrary {
  checkHash(library, expectedHash);
  if (!variantIds.length || variantIds.length > 200 || new Set(variantIds).size !== variantIds.length) throw new Error('Нужен непустой набор уникальных вариантов');
  const next = refreshQuality(scenarioLibrarySchema.parse(library));
  for (const id of variantIds) if (!next.variants.some(v => v.id === id && v.quality === 'ready')) throw new Error(`Вариант ${id} не готов к принятию`);
  if (next.acceptance) {
    librarySnapshot(next);
    if (canonical(next.acceptance.variantIds) === canonical(variantIds)) return next;
    next.revision++;
  }
  for (const v of next.variants) v.ownerDecision = variantIds.includes(v.id) ? 'accepted' : 'excluded';
  const bodyHash = libraryHash(next);
  next.acceptance = { revision: next.revision, libraryHash: bodyHash, variantIds: [...variantIds], snapshotHash: digest({ libraryId: next.id, revision: next.revision, libraryHash: bodyHash, variantIds }) };
  return next;
}

function compileVariant(library: ScenarioLibrary, variant: ScenarioVariant): Scenario {
  const known = variant.userState.facts.filter(f => f.availability === 'initial');
  const required = variant.evaluationSpec.checkpoints.filter(c => c.role === 'required');
  const checks = required.filter(c => c.check !== undefined).map(c => checkSchema.parse(c.check));
  const observed = required.filter(c => c.check === undefined);
  const answers = variant.behaviorPolicy.actions.filter(a => a.ifAsked && a.payload).map(a => ({ ifAsked: a.ifAsked!, reply: a.payload! }));
  const actionNames = { answer: 'Ответить известными фактами', missing: 'Сообщить отсутствие данных', clarify: 'Уточнить запрос', correct: 'Исправить личный факт', change_intent: 'Сменить намерение', finish: 'Завершить разговор', observe: 'Сообщить наблюдение' };
  const behavior = variant.behaviorPolicy.transitions.map(transition => {
    const action = variant.behaviorPolicy.actions.find(a => a.id === transition.actionId);
    if (!action) return transition.when;
    const facts = action.factIds.map(id => known.find(f => f.id === id)?.statement).filter(Boolean).join('; ');
    return `${transition.when}: ${actionNames[action.kind]}${action.payload ? ` — ${action.payload}` : ''}${facts ? ` (${facts})` : ''}`;
  }).join('; ');
  const parsed = scenarioSchema.parse({
    id: variant.id, familyId: variant.familyId, title: variant.title,
    requirementIds: library.businessScenarios.find(b => b.id === variant.businessScenarioId)?.requirementIds ?? [], provenance: variant.provenance,
    user: {
      goal: variant.userState.goal, opening: variant.userState.opening,
      facts: known.map(f => f.statement).join('\n') || 'Исходные факты не заданы.', knows: known.map(f => f.statement),
      cannotKnow: variant.userState.cannotKnow, answers,
      behavior: `Используйте только известные факты. Неизвестные данные: ${variant.userState.missing.join('; ') || 'не указаны'}. Предел повторов: ${variant.behaviorPolicy.repetitionLimit}. ${behavior}`,
      maxFollowUps: variant.behaviorPolicy.maxFollowUps,
      ...(variant.userState.persona ? { persona: variant.userState.persona.text } : {}),
    },
    initialState: worldSchema.parse(variant.environmentFixture.initialState), checks,
    execution: { protocol: USER_CONTROLLER_PROTOCOL, ...(library.checkpointContext?{checkpointContext:library.checkpointContext}:{}), checkpointProtocol: CHECKPOINT_PROTOCOL, controllerHash: digest({ protocol: USER_CONTROLLER_PROTOCOL, role: USER_CONTROLLER_ROLE }), checkpointHash: digest({ protocol: CHECKPOINT_PROTOCOL, role: library.checkpointContext?CHECKPOINT_ROLE:LEGACY_CHECKPOINT_ROLE }),
      userView: { goal: variant.userState.goal, opening: variant.userState.opening, facts: known.map(({ id, statement, value }) => ({ id, statement, ...(value !== undefined ? { value } : {}) })), policy: variant.behaviorPolicy, missing: variant.userState.missing, ...(variant.userState.persona ? { persona: variant.userState.persona.text } : {}) },
      environmentView: { mode: variant.environmentFixture.mode, ...(variant.environmentFixture.contract ? { contract: variant.environmentFixture.contract } : {}) },
      evaluatorView: { checkpoints: variant.evaluationSpec.checkpoints, requirements: library.requirements.filter(r => variant.evaluationSpec.checkpoints.some(c => c.requirementId === r.id)) },
    },
    goalObservation: variant.evaluationSpec.goalObservation, successCriteria: variant.evaluationSpec.successCriteria,
    ...(observed.length ? { metrics: [{ id: 'library_required', name: 'Обязательные контрольные точки', subject: 'agent', description: observed.map(c => c.rule).join('\n'), passCriteria: observed.map(c => `${c.applicability}: ${c.rule}`).join('\n'), failCriteria: 'Наблюдаемые доказательства подтверждают нарушение хотя бы одной применимой обязательной контрольной точки.' }] } : {}),
  });
  return { ...parsed, split: 'dev' };
}

/** Additive run metadata. It is a detached copy, so a later edit cannot rewrite a run. */
export function librarySnapshot(library: ScenarioLibrary) {
  const acceptance = library.acceptance;
  if (!acceptance || acceptance.revision !== library.revision || acceptance.libraryHash !== libraryHash(library) || acceptance.snapshotHash !== digest({ libraryId: library.id, revision: library.revision, libraryHash: acceptance.libraryHash, variantIds: acceptance.variantIds })) throw new Error('Нужна неизменная принятая ревизия библиотеки');
  if (libraryQuality(library).some(i => !i.variantId || acceptance.variantIds.includes(i.variantId))) throw new Error('Принятый набор больше не готов');
  const variants = acceptance.variantIds.map(id => { const v = library.variants.find(v => v.id === id); if (!v) throw new Error('Принятый вариант отсутствует'); return v; });
  return structuredClone({ formatVersion: 1 as const, libraryId: library.id, revision: library.revision, libraryHash: acceptance.libraryHash, snapshotHash: acceptance.snapshotHash, variantIds: acceptance.variantIds, imports: library.imports, sources: library.sources, requirements: library.requirements, businessScenarios: library.businessScenarios, variants });
}

export function compileLibrary(library: ScenarioLibrary): Scenario[] {
  return librarySnapshot(library).variants.map(v => compileVariant(library, v));
}
