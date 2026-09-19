import { createHash } from 'node:crypto';
import { z } from 'zod';
import { checkSchema, scenarioSchema, worldSchema, valueTokens, type Requirement, type Scenario, type Source } from './contracts.js';
import {
  importBatchSchema, libraryPatchSchema, scenarioLibrarySchema, scenarioProposalSchema,
  type BusinessScenario, type ImportBatch, type LibraryPatch, type LibraryQualityIssue,
  type ScenarioLibrary, type ScenarioVariant, type SourceDialogue,
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
    if (!dialogueId || !/^[A-Za-z0-9_-]{1,80}$/.test(dialogueId) || ['__proto__', 'prototype', 'constructor'].includes(dialogueId)) reasons.push('Некорректный id диалога');
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

export function createLibrary(input: { id?: string; batch: ImportBatch; sources: Source[]; requirements: Requirement[]; proposals: unknown[]; createdAt?: string }): ScenarioLibrary {
  if (input.proposals.length > 200) throw new Error('Допустимо не больше 200 вариантов');
  const batch = importBatchSchema.parse(input.batch);
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
  const library = scenarioLibrarySchema.parse({ formatVersion: 1, id: input.id ?? `library_${digest({ batchId: batch.id, proposals: input.proposals }).slice(0, 24)}`, revision: 1, createdAt: input.createdAt ?? new Date().toISOString(), imports: [batch], sources: input.sources, requirements: input.requirements, businessScenarios: [...groups.values()], variants });
  return refreshQuality(library);
}

/** Includes all source evidence and drafts; acceptance is a receipt over this document. */
export function libraryHash(library: ScenarioLibrary): string {
  const { acceptance: _acceptance, ...body } = library;
  return digest(body);
}

export function libraryQuality(library: ScenarioLibrary): LibraryQualityIssue[] {
  const issues: LibraryQualityIssue[] = [];
  const add = (code: string, path: string, message: string, variantId?: string, severity: LibraryQualityIssue['severity'] = 'blocked') => issues.push({ code, path, message, ...(variantId ? { variantId } : {}), severity });
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
    if (!group) problem('missing_business', 'businessScenarioId', 'Бизнес-сценарий отсутствует');
    if (group?.grouping.status === 'uncertain') problem('uncertain_grouping', 'businessScenarioId', group.grouping.reason, 'needs_review');
    if (group?.requirementIds.some(id => !library.requirements.some(r => r.id === id))) problem('missing_requirement', 'businessScenarioId', 'Ссылка на неизвестное требование');
    if (variant.provenance === 'production' && !variant.sourceDialogues.length) problem('missing_source', 'sourceDialogues', 'Для production нужны исходные диалоги');
    for (const ref of variant.sourceDialogues) if (!validRef(ref)) problem('missing_source', 'sourceDialogues', 'Исходный диалог не найден');
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
        const sourceTokens = new Set(exactTokens(origin.quote));
        const eventTokens = new Set(exactTokens(event?.content ?? ''));
        const fabricatedToken = exactTokens(fact.statement).some(token => /\p{N}/u.test(token) && (!sourceTokens.has(token) || !eventTokens.has(token)));
        if (fabricatedToken || fact.value !== undefined && (!containsExactValue(origin.quote, String(fact.value)) || !containsExactValue(event?.content ?? '', String(fact.value)))) problem('ungrounded_value', path, 'Точное значение факта отсутствует в цитате или исходном событии');
        if (fact.availability === 'initial' && event?.role !== 'user') problem('agent_fact_as_initial', path, 'Ответ старого агента не является исходным знанием пользователя');
      } else if (origin.kind === 'owner' && !variant.history.some(h => h.author === 'owner' && h.factEdit?.factId === fact.id && h.factEdit.editId === origin.editId && h.factEdit.factHash === digest(fact))) problem('unverified_owner_fact', path, 'Нет записанной правки владельца, подтверждающей факт');
      else if (origin.kind === 'synthetic' && (variant.provenance !== 'synthetic' || origin.parentVariantId !== variant.parentVariantId || !library.variants.some(p => p.id === origin.parentVariantId && p.id !== v))) problem('synthetic_provenance', path, 'Синтетическое допущение не связано с родителем варианта');
    }
    const persona = variant.userState.persona;
    if (persona && !variant.history.some(h => h.author === 'owner' && h.personaEdit?.editId === persona.ownerEditId && h.personaEdit.personaHash === digest(persona))) problem('unverified_owner_persona', 'userState.persona', 'Нет записанного выбора профиля владельцем');
    const initial = variant.userState.facts.filter(f => f.availability === 'initial');
    const policy = variant.behaviorPolicy;
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
      if (action.factIds.some(id => !initial.some(f => f.id === id))) problem('excluded_fact_action', 'behaviorPolicy.actions', 'Действие ссылается на недоступный факт');
      if ((action.kind === 'answer' || action.kind === 'correct') && !action.factIds.length) problem('invalid_policy', 'behaviorPolicy.actions', 'Ответ должен ссылаться на исходные факты');
      if (action.kind === 'change_intent' && !action.payload) problem('invalid_policy', 'behaviorPolicy.actions', 'Смена намерения должна быть объявлена');
    }
    for (const transition of policy.transitions) if (!states.has(transition.from) || !states.has(transition.to) || !actionIds.has(transition.actionId) || policy.terminalStates.includes(transition.from)) problem('invalid_policy', 'behaviorPolicy.transitions', 'Недопустимый переход');
    let frontier = new Set([policy.initialState]);
    let terminalReachable = policy.terminalStates.includes(policy.initialState);
    for (let i = 0; i < policy.maxFollowUps && !terminalReachable; i++) {
      frontier = new Set(policy.transitions.filter(t => frontier.has(t.from)).map(t => t.to));
      terminalReachable = policy.terminalStates.some(s => frontier.has(s));
    }
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
            else if (world.success && !Object.is(state[check.field], check.value) && !world.data.writableFields.includes(check.field)) problem('unreachable_state_check', path, 'Ожидаемое изменение поля не разрешено fixture');
          }
          const operations = 'tool' in check ? [check.tool] : check.kind === 'fresh_read_before_update' ? ['lookup_record', 'update_record'] : [];
          if (operations.some(operation => environment.mode !== 'managed' || !environment.contract?.operations.includes(operation))) problem('unsupported_check_operation', path, 'Проверка требует неподдержанной операции fixture');
        }
      }
      if (!supportsObservation(cp.observation)) problem('unobservable_checkpoint', path, 'Не подтверждён канал наблюдения');
    }
    // Excludes names and evidence references: exact duplicates cannot inflate the runnable set.
    const fingerprint = digest({ business: group && businessIdentity(group), user: { ...variant.userState, facts: initial.map(f => ({ statement: normalize(f.statement), value: f.value })) }, policy, environment, evaluation: variant.evaluationSpec });
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

function checkHash(library: ScenarioLibrary, expectedHash: string): void {
  if (libraryHash(library) !== expectedHash) throw new Error('Библиотека изменилась: хеш устарел');
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

export function editLibrary(library: ScenarioLibrary, expectedHash: string, rawPatch: LibraryPatch): ScenarioLibrary {
  checkHash(library, expectedHash);
  const patch = libraryPatchSchema.parse(rawPatch);
  const next = scenarioLibrarySchema.parse(library);
  const old = new Map(next.variants.map(v => [v.id, digest(v)]));
  const oldPersonas = new Map(next.variants.map(v => [v.id, digest(v.userState.persona ?? null)]));
  const getVariant = (id: string) => { const v = next.variants.find(v => v.id === id); if (!v) throw new Error(`Вариант ${id} не найден`); return v; };
  const getBusiness = (id: string) => { const b = next.businessScenarios.find(b => b.id === id); if (!b) throw new Error(`Бизнес-сценарий ${id} не найден`); return b; };
  if (patch.kind === 'upsert_variant') {
    getBusiness(patch.variant.businessScenarioId);
    const index = next.variants.findIndex(v => v.id === patch.variant.id);
    if (index < 0) next.variants.push({ ...patch.variant, revision: 1, history: [] });
    else next.variants[index] = { ...patch.variant, revision: next.variants[index]!.revision, history: next.variants[index]!.history, familyId: next.variants[index]!.familyId };
  } else if (patch.kind === 'remove_variant') {
    getVariant(patch.variantId);
    next.variants = next.variants.filter(v => v.id !== patch.variantId);
  } else if (patch.kind === 'edit_fact') {
    const variant = getVariant(patch.variantId);
    const fact = variant.userState.facts.find(f => f.id === patch.factId);
    if (!fact) throw new Error('Факт не найден');
    Object.assign(fact, { statement: patch.statement, availability: patch.availability, reason: patch.reason, origin: { kind: 'owner', editId: patch.editId, text: patch.reason } });
    if (patch.value === undefined) delete fact.value; else fact.value = patch.value;
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
      const fact = patch.kind === 'edit_fact' && patch.variantId === variant.id ? variant.userState.facts.find(f => f.id === patch.factId) : undefined;
      const persona = variant.userState.persona;
      variant.history.push({
        ...(previousHash ? { previousHash } : {}), author: 'owner', reason: patch.reason, revision: variant.revision,
        ...(fact && patch.kind === 'edit_fact' ? { factEdit: { factId: fact.id, editId: patch.editId, factHash: digest(fact) } } : {}),
        ...(patch.kind === 'upsert_variant' && patch.variant.id === variant.id && persona && oldPersonas.get(variant.id) !== digest(persona) ? { personaEdit: { editId: persona.ownerEditId, personaHash: digest(persona) } } : {}),
      });
    }
    variant.ownerDecision = 'pending';
  }
  next.revision++;
  delete next.acceptance;
  return refreshQuality(next);
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
  const actionNames = { answer: 'Ответить известными фактами', missing: 'Сообщить отсутствие данных', clarify: 'Уточнить запрос', correct: 'Исправить личный факт', change_intent: 'Сменить намерение', finish: 'Завершить разговор' };
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
