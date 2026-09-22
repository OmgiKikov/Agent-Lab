import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioSchema } from '../src/contracts.js';
import { importBatch, createLibrary, libraryHash, libraryQuality, editLibrary, acceptLibrary, compileLibrary, librarySnapshot, recordSemanticAssessment, semanticPaths } from '../src/scenario-library.js';
import { libraryFixture, proposals, rawDialogues, sources, requirements } from './helpers/scenario-library.js';

test('groups explicit business proposals and compiles only grounded initial facts', () => {
  const draft = libraryFixture();
  const library = acceptLibrary(draft, libraryHash(draft), ['variant_1', 'variant_2']);
  const compiled = compileLibrary(library);
  assert.equal(compiled.length, 2);
  assert.equal(library.businessScenarios.length, 1);
  assert.equal(library.businessScenarios[0]!.sourceDialogues.length, 2);
  assert.deepEqual(compiled[0]!.user.knows, ['Номер терминала: 1234']);
  assert.ok(!JSON.stringify(compiled[1]!.user).includes('три дня'));
  assert.equal(library.variants[1]!.userState.facts[0]!.availability, 'learned_in_source');
  for (const { split, ...scenario } of compiled) assert.ok(scenarioSchema.safeParse(scenario).success);
});

test('import preserves rich evidence and rejects invalid records individually', () => {
  const rich = { formatVersion: 1, dialogues: [
    { id: 'rich', observation: 'partial', events: [
      { type: 'message', role: 'user', content: 'Помогите' },
      { type: 'tool', name: 'lookup', arguments: { key: 'x' }, result: { status: 'pending' } },
      { type: 'retrieval', query: 'возврат', documents: [{ text: 'правило' }] },
      { type: 'state', snapshot: { status: 'pending' } },
    ] },
    { id: 'rich', messages: [{ role: 'user', content: 'Дубль' }] },
    { id: 'empty', messages: [{ role: 'user', content: ' ' }] },
    { id: 'masked', messages: [{ role: 'user', content: '[REDACTED]' }] },
  ] };
  const batch = importBatch(rich);
  assert.equal(batch.dialogues.length, 1);
  assert.equal(batch.rejected.length, 3);
  assert.equal(batch.dialogues[0]!.events[1]!.index, 1);
  assert.deepEqual(batch.dialogues[0]!.original, rich.dialogues[0]);
  assert.equal(batch.dialogues[0]!.observation, 'partial');
  assert.equal(importBatch(structuredClone(rich)).id, batch.id);
  assert.equal(importBatch({ dialogues: rawDialogues }).id, importBatch(rawDialogues).id);
  assert.throws(() => importBatch({ formatVersion: 999, dialogues: [] }), /верси|version/i);
  assert.throws(() => importBatch(Array.from({ length: 301 }, () => rawDialogues[0])), /300/);
});

test('uncertainty, forged citations and unsupported environment stay reviewable but cannot be accepted', () => {
  const batch = importBatch(rawDialogues);
  const p = proposals(batch.id);
  p[0]!.business.grouping.status = 'uncertain';
  p[0]!.variant.userState.facts[0]!.availability = 'uncertain';
  p[1]!.variant.userState.facts[0]!.origin.quote = 'В источнике этого нет';
  const draft = createLibrary({ batch, sources, requirements, proposals: p });
  const issues = libraryQuality(draft);
  assert.ok(issues.some(i => i.code === 'uncertain_grouping'));
  assert.ok(issues.some(i => i.code === 'uncertain_fact'));
  assert.ok(issues.some(i => i.code === 'invalid_citation'));
  assert.throws(() => acceptLibrary(draft, libraryHash(draft), ['variant_1']), /готов|ready/i);
});

test('selection preserves excluded drafts and edits cannot change an accepted snapshot', () => {
  const draft = libraryFixture();
  assert.throws(() => compileLibrary(draft), /принят|accepted/i);
  const accepted = acceptLibrary(draft, libraryHash(draft), ['variant_1']);
  const before = JSON.stringify(accepted);
  const snapshot = librarySnapshot(accepted);
  const variant = structuredClone(accepted.variants[0]!);
  variant.title = 'Новое название';
  const patch = { kind: 'upsert_variant' as const, variant, reason: 'Уточнено название' };
  assert.throws(() => editLibrary(accepted, 'stale', patch), /измен|хеш/i);
  const changed = editLibrary(accepted, libraryHash(accepted), patch);
  assert.equal(changed.revision, accepted.revision + 1);
  assert.equal(changed.acceptance, undefined);
  assert.equal(changed.variants.length, 2);
  assert.equal(JSON.stringify(accepted), before);
  assert.equal(compileLibrary(accepted).length, 1);
  assert.equal(snapshot.variants.length, 1);
  snapshot.variants[0]!.title = 'Внешняя мутация';
  assert.equal(accepted.variants[0]!.title, 'Возврат 1');
});

test('changed opening or allowed replies cannot smuggle excluded facts into user view', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[1]!);
  variant.userState.opening = 'Срок три дня, верно?';
  const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Правка opening' });
  assert.ok(libraryQuality(changed).some(i => i.code === 'excluded_fact_leak'));
  assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_2']), /готов|ready/i);
  variant.userState.opening = 'Помогите';
  variant.behaviorPolicy.actions = [{ id: 'answer', kind: 'clarify', factIds: [], payload: 'Срок три дня' }];
  variant.behaviorPolicy.transitions[0]!.actionId = 'answer';
  const reply = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Правка ответа' });
  assert.ok(libraryQuality(reply).some(i => i.code === 'excluded_fact_leak'));
});

test('merge and split preserve variant identities and source frequency', () => {
  const draft = libraryFixture();
  const originalId = draft.businessScenarios[0]!.id;
  const split = editLibrary(draft, libraryHash(draft), { kind: 'split_business', businessScenarioId: originalId, newBusiness: { key: 'special', title: 'Отдельное условие', goal: 'Узнать условия возврата', conditions: ['Особое условие'], requirementIds: ['terminal_rule'], grouping: { status: 'confirmed', reason: 'Решение владельца' } }, variantIds: ['variant_2'], reason: 'Разные условия' });
  assert.equal(split.businessScenarios.length, 2);
  assert.deepEqual(split.variants.map(v => v.id), ['variant_1', 'variant_2']);
  const newId = split.variants[1]!.businessScenarioId;
  const merged = editLibrary(split, libraryHash(split), { kind: 'merge_business', targetId: originalId, sourceIds: [newId], reason: 'Общие условия' });
  assert.equal(merged.businessScenarios.length, 1);
  assert.equal(merged.businessScenarios[0]!.sourceDialogues.length, 2);
  assert.equal(merged.variants[1]!.businessScenarioId, originalId);
});

test('owner fact edits record provenance and explicit variant removal preserves the import', () => {
  const draft = libraryFixture();
  const edited = editLibrary(draft, libraryHash(draft), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number', statement: 'Номер терминала: 5678', value: '5678', availability: 'initial', editId: 'owner_1', reason: 'Владелец исправил опечатку' });
  assert.equal(edited.variants[0]!.userState.facts[0]!.origin.kind, 'owner');
  assert.ok(libraryQuality(edited).some(issue => issue.code === 'semantic_variant_pending'));
  const checked = recordSemanticAssessment(edited, edited.variants.flatMap(variant => semanticPaths(variant).map(path => ({ variantId: variant.id, path, status: 'ready' as const, reason: 'Проверено' }))));
  assert.deepEqual(compileLibrary(acceptLibrary(checked, libraryHash(checked), ['variant_1']))[0]!.user.knows, ['Номер терминала: 5678']);
  const removed = editLibrary(edited, libraryHash(edited), { kind: 'remove_variant', variantId: 'variant_1', reason: 'Исключить' });
  assert.equal(removed.variants.length, 1);
  assert.equal(removed.imports[0]!.dialogues.length, 2);
});

test('owner text edits cover opening, goal, expectation and checkpoint rule while preserving citations', () => {
  let library = libraryFixture();
  const edits = [
    { field: 'opening', value: 'Помогите оформить возврат' },
    { field: 'goal', value: 'Оформить возврат безопасно' },
    { field: 'successCriteria', value: 'Агент запросил номер терминала и объяснил следующий шаг' },
    { field: 'checkpointRule', checkpointId: 'ask_terminal', value: 'Агент запросил номер терминала до инструкции' },
  ] as const;
  for (const [index, edit] of edits.entries()) library = editLibrary(library, libraryHash(library), {
    kind: 'edit_variant_text', variantId: 'variant_1', ...edit, editId: `owner_text_${index}`, reason: 'Явная правка владельца',
  });
  const variant = library.variants[0]!;
  assert.equal(variant.userState.opening, edits[0].value);
  assert.equal(variant.userState.goal, edits[1].value);
  assert.equal(variant.evaluationSpec.successCriteria, edits[2].value);
  assert.equal(variant.evaluationSpec.checkpoints[0]!.rule, edits[3].value);
  assert.equal(variant.evaluationSpec.checkpoints[0]!.quote, 'Уточните номер терминала');
  assert.equal(variant.history.filter(entry => entry.textEdit).length, 4);
  assert.ok(libraryQuality(library).some(issue => issue.code === 'semantic_variant_pending'));
  assert.throws(() => acceptLibrary(library, libraryHash(library), ['variant_1']), /готов/);
});

test('exact duplicate variants and ungrounded synthetic changes are blocked', () => {
  const draft = libraryFixture();
  const duplicate = structuredClone(draft.variants[0]!);
  duplicate.id = 'duplicate';
  const doubled = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant: duplicate, reason: 'Дубль' });
  assert.ok(libraryQuality(doubled).some(i => i.code === 'duplicate_variant'));
  const synthetic = structuredClone(draft.variants[0]!);
  synthetic.id = 'synthetic';
  synthetic.provenance = 'synthetic';
  synthetic.userState.opening = 'Другой вопрос';
  const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant: synthetic, reason: 'Изменение' });
  assert.ok(libraryQuality(changed).some(i => i.code === 'synthetic_provenance'));
});

test('source content and citation matching preserve original whitespace', () => {
  const raw = [{ id: 'spaced', messages: [{ role: 'user', content: '  Личный номер: 1234  ' }] }];
  const batch = importBatch(raw);
  assert.equal(batch.dialogues[0]!.events[0]!.content, '  Личный номер: 1234  ');
});

test('hidden fixture values and excluded values in cannotKnow cannot reach user payloads', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[1]!);
  variant.userState.cannotKnow = ['Не знает срок три дня'];
  let changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Проверка изоляции' });
  assert.ok(libraryQuality(changed).some(i => i.code === 'excluded_fact_leak'));
  variant.userState.cannotKnow = ['Внутренний статус'];
  variant.userState.opening = 'Мой внутренний статус secret-approved';
  variant.environmentFixture = { mode: 'managed', initialState: { records: { refund: { status: 'secret-approved' } }, writableFields: [] }, contract: { confirmed: true, reset: true, operations: ['lookup_record'], observations: ['reply', 'state'] } };
  changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Проверка скрытого статуса' });
  assert.ok(libraryQuality(changed).some(i => i.code === 'hidden_state_leak'));
});

test('synthetic variants retain operation provenance and dependency family after a split', () => {
  const draft = libraryFixture();
  const synthetic = structuredClone(draft.variants[0]!);
  synthetic.id = 'synthetic_valid';
  synthetic.provenance = 'synthetic';
  synthetic.parentVariantId = 'variant_1';
  synthetic.mutationReason = 'Другой личный номер';
  synthetic.userState.facts[0] = { id: 'terminal_number', statement: 'Номер терминала: 5678', value: '5678', availability: 'initial', reason: 'Контролируемое изменение', origin: { kind: 'synthetic', parentVariantId: 'variant_1', operation: 'replace_terminal', reason: 'Другой личный номер' } };
  const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant: synthetic, reason: 'Новый вариант' });
  assert.equal(changed.variants[2]!.quality, 'ready');
  assert.equal(changed.variants[2]!.familyId, changed.variants[0]!.familyId);
  const compiled = compileLibrary(acceptLibrary(changed, libraryHash(changed), ['synthetic_valid']));
  assert.deepEqual(compiled[0]!.user.knows, ['Номер терминала: 5678']);
  assert.equal(compiled[0]!.provenance, 'synthetic');
});

test('changing accepted payloads invalidates the acceptance receipt', () => {
  const draft = libraryFixture();
  const accepted = acceptLibrary(draft, libraryHash(draft), ['variant_1']);
  accepted.variants[0]!.userState.opening = 'Изменено после принятия';
  assert.throws(() => compileLibrary(accepted), /неизмен|принят/i);
});

test('required checks compile separately from diagnostic observations and environment', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  variant.evaluationSpec.checkpoints[0]!.check = { id: 'ask_terminal', kind: 'answer_contains', description: 'Вопрос о терминале', value: 'терминал' };
  variant.evaluationSpec.checkpoints.push({ id: 'diagnostic', requirementId: 'terminal_rule', quote: 'Уточните номер терминала', applicability: 'Всегда', observation: 'reply', role: 'diagnostic', rule: 'Диагностический секрет', check: { id: 'diagnostic', kind: 'answer_contains', description: 'Диагностика', value: 'secret' } });
  const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Разделение проверок' });
  const compiled = compileLibrary(acceptLibrary(changed, libraryHash(changed), ['variant_1']))[0]!;
  assert.deepEqual(compiled.checks.map(c => c.id), ['ask_terminal']);
  assert.equal(compiled.metrics, undefined);
  assert.ok(!JSON.stringify(compiled.user).includes('Диагностический секрет'));
});

test('policies cannot reference excluded facts, dangling states or unreachable stops', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[1]!);
  variant.behaviorPolicy.actions = [{ id: 'answer', kind: 'answer', factIds: ['duration'] }];
  variant.behaviorPolicy.transitions = [{ from: 'waiting', to: 'missing', actionId: 'answer', when: 'Получен вопрос' }];
  const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Невалидная политика' });
  const codes = libraryQuality(changed).map(i => i.code);
  assert.ok(codes.includes('excluded_fact_action'));
  assert.ok(codes.includes('invalid_policy'));
  assert.ok(codes.includes('unreachable_stop'));
  const danglingAction = structuredClone(draft.variants[0]!);
  danglingAction.behaviorPolicy.transitions[0]!.actionId = 'missing_action';
  const invalidAction = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant: danglingAction, reason: 'Невалидная ссылка действия' });
  assert.ok(libraryQuality(invalidAction).some(issue => issue.code === 'invalid_policy'), 'invalid references stay reviewable instead of crashing duplicate canonicalization');
});

test('unsupported managed fixtures and forged requirement citations prevent acceptance', () => {
  const batch = importBatch(rawDialogues);
  const p = proposals(batch.id);
  p[0]!.variant.environmentFixture.mode = 'managed';
  const draft = createLibrary({ batch, sources, requirements: [{ ...requirements[0]!, quote: 'Выдуманное правило' }], proposals: p });
  const codes = libraryQuality(draft).map(i => i.code);
  assert.ok(codes.includes('unsupported_environment'));
  assert.ok(codes.includes('invalid_requirement'));
  assert.throws(() => acceptLibrary(draft, libraryHash(draft), ['variant_1']), /готов/);
});

test('model proposals cannot forge owner provenance or owner personas', () => {
  const batch = importBatch(rawDialogues);
  const p = proposals(batch.id) as any[];
  p[0].variant.userState.facts[0].origin = { kind: 'owner', editId: 'invented', text: 'Якобы сказал владелец' };
  p[0].variant.userState.persona = { text: 'Якобы профиль владельца', ownerEditId: 'invented' };
  const draft = createLibrary({ batch, sources, requirements, proposals: p });
  const codes = libraryQuality(draft).map(i => i.code);
  assert.ok(codes.includes('unverified_owner_fact'));
  assert.ok(codes.includes('unverified_owner_persona'));
  assert.throws(() => acceptLibrary(draft, libraryHash(draft), ['variant_1']), /готов/);
});

test('same title with different applicable requirements does not merge business groups', () => {
  const batch = importBatch(rawDialogues);
  const p = proposals(batch.id);
  p[1]!.business.requirementIds = ['other_rule'];
  p[1]!.variant.evaluationSpec.checkpoints[0]!.requirementId = 'other_rule';
  const library = createLibrary({ batch, sources, requirements: [...requirements, { ...requirements[0]!, id: 'other_rule' }], proposals: p });
  assert.equal(library.businessScenarios.length, 2);
});

test('declared intent changes survive compilation without exposing evaluation criteria', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  variant.behaviorPolicy.actions = [{ id: 'change', kind: 'change_intent', factIds: [], payload: 'Теперь хочу отменить заявку' }, { id: 'finish', kind: 'finish', factIds: [] }];
  variant.behaviorPolicy.states = ['waiting', 'changed', 'done'];
  variant.behaviorPolicy.transitions = [{ from: 'waiting', to: 'changed', actionId: 'change', when: 'После первой инструкции' }, { from: 'changed', to: 'done', actionId: 'finish', when: 'После отмены' }];
  const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Смена намерения' });
  const compiled = compileLibrary(acceptLibrary(changed, libraryHash(changed), ['variant_1']))[0]!;
  assert.ok(compiled.user.behavior.includes('Теперь хочу отменить заявку'));
  assert.ok(!JSON.stringify(compiled.user).includes('Уточнён номер терминала'));
});

test('structured limits reject overlong fact sets and policies without truncating proposals', () => {
  const batch = importBatch(rawDialogues);
  const p = proposals(batch.id);
  p[0]!.variant.userState.facts = Array.from({ length: 21 }, (_, i) => ({ ...p[0]!.variant.userState.facts[0]!, id: `fact_${i}` }));
  assert.throws(() => createLibrary({ batch, sources, requirements, proposals: p }), /20/);
  const longPolicy = proposals(batch.id);
  longPolicy[0]!.variant.behaviorPolicy.maxFollowUps = 16;
  assert.throws(() => createLibrary({ batch, sources, requirements, proposals: longPolicy }), /15/);
  assert.throws(() => createLibrary({ batch, sources, requirements, proposals: Array.from({ length: 201 }, () => p[0]) }), /200/);
});

test('changing the accepted selection creates a new revision identity', () => {
  const draft = libraryFixture();
  const first = acceptLibrary(draft, libraryHash(draft), ['variant_1']);
  const same = acceptLibrary(first, libraryHash(first), ['variant_1']);
  assert.equal(same.acceptance!.snapshotHash, first.acceptance!.snapshotHash);
  const second = acceptLibrary(first, libraryHash(first), ['variant_2']);
  assert.equal(second.revision, first.revision + 1);
  assert.notEqual(second.acceptance!.snapshotHash, first.acceptance!.snapshotHash);
  assert.deepEqual(compileLibrary(first).map(v => v.id), ['variant_1']);
});

test('dialogue fact values stay grounded when the optional value field is omitted', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  delete variant.userState.facts[0]!.value;
  const grounded = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Без отдельного value' });
  assert.deepEqual(compileLibrary(acceptLibrary(grounded, libraryHash(grounded), ['variant_1']))[0]!.user.knows, ['Номер терминала: 1234']);
  for (const fabricated of ['5678', '12']) {
    variant.userState.facts[0]!.statement = `Номер терминала: ${fabricated}`;
    const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Проверка точного значения' });
    assert.ok(libraryQuality(changed).some(i => i.code === 'ungrounded_value'), fabricated);
    assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
  }
});

test('an exact fact value cannot be grounded by a prefix of another value', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  variant.userState.facts[0]!.statement = 'Номер терминала: 123';
  variant.userState.facts[0]!.value = '123';
  let changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Значение не совпадает с цитатой' });
  assert.ok(libraryQuality(changed).some(i => i.code === 'ungrounded_value'));
  assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
  if (variant.userState.facts[0]!.origin.kind === 'dialogue') variant.userState.facts[0]!.origin.quote = 'Номер терминала: 123';
  changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Цитата обрезает исходное значение' });
  assert.ok(libraryQuality(changed).some(i => i.code === 'ungrounded_value'));
  assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
  variant.userState.facts[0]!.statement = 'Номер терминала: 1234';
  changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Значение не совпадает с утверждением' });
  assert.ok(libraryQuality(changed).some(i => i.code === 'fact_value_mismatch'));
});

test('state and tool goals require matching managed observation capabilities', () => {
  const draft = libraryFixture();
  for (const observation of ['state', 'tool'] as const) {
    const variant = structuredClone(draft.variants[0]!);
    variant.evaluationSpec.goalObservation = observation;
    let changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Недоступный исход' });
    assert.ok(libraryQuality(changed).some(i => i.code === 'unobservable_goal'), observation);
    assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
    variant.environmentFixture = { mode: 'managed', initialState: { records: {}, writableFields: [] }, contract: { confirmed: true, reset: true, operations: [], observations: ['reply'] } };
    changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Канал не поддержан договором' });
    assert.ok(libraryQuality(changed).some(i => i.code === 'unobservable_goal'), observation);
  }
});

test('executable checks cannot disguise their evidence channel as a reply', () => {
  const draft = libraryFixture();
  for (const check of [
    { id: 'state', kind: 'state_equals', recordId: 'refund', field: 'status', value: 'done', description: 'Статус' },
    { id: 'tool', kind: 'tool_called', tool: 'lookup_record', description: 'Вызов инструмента' },
  ]) {
    const variant = structuredClone(draft.variants[0]!);
    variant.evaluationSpec.checkpoints[0]!.check = check;
    const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Неверный канал проверки' });
    assert.ok(libraryQuality(changed).some(i => i.code === 'check_observation_mismatch'), check.kind);
    assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
  }
});

test('state checks require an existing field and a reachable expected value', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  variant.evaluationSpec.goalObservation = 'state';
  variant.evaluationSpec.checkpoints[0]!.observation = 'state';
  variant.evaluationSpec.checkpoints[0]!.check = { id: 'state', kind: 'state_equals', recordId: 'refund', field: 'status', value: 'done', description: 'Статус' };
  for (const initialState of [
    { records: {}, writableFields: ['status'] },
    { records: { refund: { other: 'pending' } }, writableFields: ['status'] },
    { records: { refund: { status: 'pending' } }, writableFields: [] },
  ]) {
    variant.environmentFixture = { mode: 'managed', initialState, contract: { confirmed: true, reset: true, operations: ['lookup_record', 'update_record'], observations: ['reply', 'state', 'tool'] } };
    const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Недостижимое состояние' });
    assert.ok(libraryQuality(changed).some(i => i.code === 'invalid_state_check' || i.code === 'unreachable_state_check'));
    assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
  }
  variant.environmentFixture.initialState = { records: { refund: { status: 'pending' } }, writableFields: ['status'] };
  const valid = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Достижимое состояние' });
  const compiled = compileLibrary(acceptLibrary(valid, libraryHash(valid), ['variant_1']))[0]!;
  assert.equal(compiled.goalObservation, 'state');
  assert.equal(compiled.checks[0]!.kind, 'state_equals');
});

test('tool checks require a supported fixture operation', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  variant.evaluationSpec.checkpoints[0]!.observation = 'tool';
  variant.evaluationSpec.checkpoints[0]!.check = { id: 'tool', kind: 'tool_called', tool: 'lookup_record', description: 'Вызов инструмента' };
  variant.environmentFixture = { mode: 'managed', initialState: { records: {}, writableFields: [] }, contract: { confirmed: true, reset: true, operations: [], observations: ['reply', 'tool'] } };
  const invalid = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Нет операции' });
  assert.ok(libraryQuality(invalid).some(i => i.code === 'unsupported_check_operation'));
  assert.throws(() => acceptLibrary(invalid, libraryHash(invalid), ['variant_1']), /готов/);
  variant.environmentFixture.contract!.operations = ['lookup_record'];
  const valid = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Операция поддержана' });
  assert.equal(compileLibrary(acceptLibrary(valid, libraryHash(valid), ['variant_1']))[0]!.checks[0]!.kind, 'tool_called');
});

test('rewritten dialogue facts without explicit values require review even for alphabetic identifiers', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  delete variant.userState.facts[0]!.value;
  for (const statement of ['Номер терминала: ABCD', 'Терминал пользователя — известен']) {
    variant.userState.facts[0]!.statement = statement;
    const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Непроверенный пересказ' });
    assert.equal(changed.variants[0]!.quality, 'needs_review');
    assert.ok(libraryQuality(changed).some(i => i.code === 'unverified_fact_statement' && i.severity === 'needs_review'));
    assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
  }
  variant.userState.facts[0]!.statement = 'номер   терминала: 1234';
  const normalized = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Нормализованная цитата' });
  assert.equal(normalized.variants[0]!.quality, 'ready');
  assert.deepEqual(compileLibrary(acceptLibrary(normalized, libraryHash(normalized), ['variant_1']))[0]!.user.knows, ['номер   терминала: 1234']);
});

test('changed state requires an explicitly supported mutation operation, not only a writable field', () => {
  const draft = libraryFixture();
  const variant = structuredClone(draft.variants[0]!);
  variant.evaluationSpec.goalObservation = 'state';
  variant.evaluationSpec.checkpoints[0]!.observation = 'state';
  variant.evaluationSpec.checkpoints[0]!.check = { id: 'state', kind: 'state_equals', recordId: 'refund', field: 'status', value: 'done', description: 'Статус' };
  variant.environmentFixture = { mode: 'managed', initialState: { records: { refund: { status: 'pending' } }, writableFields: ['status'] }, contract: { confirmed: true, reset: true, operations: [], observations: ['reply', 'state'] } };
  for (const operations of [[], ['lookup_record'], ['custom_mutate']]) {
    variant.environmentFixture.contract!.operations = operations;
    const changed = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Нет поддержанной операции изменения' });
    assert.ok(libraryQuality(changed).some(i => i.code === 'unreachable_state_check'), JSON.stringify(operations));
    assert.throws(() => acceptLibrary(changed, libraryHash(changed), ['variant_1']), /готов/);
  }
  variant.environmentFixture.contract!.operations = ['update_record'];
  const mutable = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Поддержанная операция изменения' });
  assert.equal(compileLibrary(acceptLibrary(mutable, libraryHash(mutable), ['variant_1']))[0]!.checks[0]!.kind, 'state_equals');
  variant.environmentFixture.contract!.operations = [];
  variant.evaluationSpec.checkpoints[0]!.check = { id: 'state', kind: 'state_equals', recordId: 'refund', field: 'status', value: 'pending', description: 'Исходный статус' };
  const unchanged = editLibrary(draft, libraryHash(draft), { kind: 'upsert_variant', variant, reason: 'Изменение состояния не требуется' });
  assert.equal(compileLibrary(acceptLibrary(unchanged, libraryHash(unchanged), ['variant_1']))[0]!.checks[0]!.kind, 'state_equals');
});

test('historical accepted library cards retain their legacy compiler identity and reject edited definitions', async () => {
  const { assertLibraryRun } = await import('../src/scenario-preparation.js');
  const { fingerprint } = await import('../src/contracts.js');
  const draft = libraryFixture();
  const library = acceptLibrary(draft, libraryHash(draft), ['variant_1']);
  const { execution, ...legacy } = compileLibrary(library)[0]!;
  const record = { librarySnapshot: library, scenarios: [legacy], sources, requirements, workflow: 'evaluate', questions: [], profiles: [],
    revisions: [{ spec: { name: 'Агент', instructions: 'Помогать', tools: [] } }],
    acceptedTests: [{ testId: 'historical_test', scenarioId: legacy.id, definitionHash: fingerprint(legacy), acceptedAt: '2026-09-19T00:00:00.000Z' }] } as any;
  const before = JSON.stringify(record);
  assert.doesNotThrow(() => assertLibraryRun(record));
  assert.equal(JSON.stringify(record), before);
  record.scenarios[0].user.opening = 'Изменённый вход';
  assert.throws(() => assertLibraryRun(record), /Карточки отличаются/);
});

test('policy admission counts empty finish as zero follow-up messages', () => {
  const library = libraryFixture();
  library.variants[0]!.behaviorPolicy = { version: 1, initialState: 'ask', states: ['ask', 'answered', 'done'], terminalStates: ['done'], maxFollowUps: 1, repetitionLimit: 1,
    actions: [{ id: 'answer', kind: 'answer', factIds: ['terminal_number'], payload: 'Номер терминала: 1234' }, { id: 'finish', kind: 'finish', factIds: [] }],
    transitions: [{ from: 'ask', to: 'answered', actionId: 'answer', when: 'Агент уточнил номер' }, { from: 'answered', to: 'done', actionId: 'finish', when: 'Получен ответ' }] };
  assert.doesNotThrow(() => acceptLibrary(library, libraryHash(library), ['variant_1']));
});

function coveredContinuation() {
  const dialogues = structuredClone(rawDialogues);
  dialogues[0]!.messages.push({ role: 'assistant', content: 'Откройте страницу терминала' }, { role: 'user', content: 'На этой странице нет терминала' });
  const batch = importBatch(dialogues);
  const library = createLibrary({ batch, sources, requirements, proposals: proposals(batch.id), semanticRequired: true });
  const variant = library.variants[0]!;
  variant.sourceCoverageRequired = true;
  variant.sourceCoverageBasis = [{ batchId: batch.id, dialogueId: 'terminal', eventIndex: 2 }];
  variant.sourceCoverage = [{ batchId: batch.id, dialogueId: 'terminal', eventIndex: 2, disposition: 'conditional_action', actionIds: ['missing_terminal'], factIds: [], reason: 'Реальное наблюдение после инструкции перейти к терминалу' }];
  variant.behaviorPolicy.actions.push({ id: 'missing_terminal', kind: 'missing', factIds: [], payload: 'На этой странице нет терминала' });
  variant.behaviorPolicy.transitions.push({ from: 'waiting', to: 'done', actionId: 'missing_terminal', when: 'Агент направил клиента на страницу терминала' });
  return library;
}
function assessedCoverage(library: ReturnType<typeof libraryFixture>) {
  return recordSemanticAssessment(library, library.variants.flatMap(variant => semanticPaths(variant).map(path => ({ variantId: variant.id, path, status: 'ready' as const, reason: 'Контрольная оценка' }))));
}

test('new multi-turn admission cannot omit a source turn even when all returned semantic findings say ready', () => {
  const library = coveredContinuation();
  delete library.variants[0]!.sourceCoverage;
  const assessed = assessedCoverage(library);
  assert.ok(libraryQuality(assessed).some(issue => issue.code === 'source_coverage_missing'));
  assert.throws(() => acceptLibrary(assessed, libraryHash(assessed), ['variant_1']), /готов/);
  const legacy = libraryFixture();
  assert.doesNotThrow(() => acceptLibrary(legacy, libraryHash(legacy), ['variant_1', 'variant_2']), 'historical cards do not acquire a new coverage requirement');
});

test('coverage preserves a reachable conditional source reply and allows a valid alternative to finish', () => {
  const library = assessedCoverage(coveredContinuation());
  assert.ok(!libraryQuality(library).some(issue => issue.code.startsWith('source_coverage')), JSON.stringify(libraryQuality(library)));
  const [compiled] = compileLibrary(acceptLibrary(library, libraryHash(library), ['variant_1']));
  assert.ok(compiled!.execution!.userView.policy.actions.some(action => action.id === 'missing_terminal'));
  assert.ok(compiled!.execution!.userView.policy.actions.some(action => action.kind === 'finish'));
  assert.ok(!compiled!.execution!.userView.facts.some(fact => fact.statement.includes('нет терминала')));
});

test('coverage rejects nonexistent, unreachable and budget-exhausted source actions', () => {
  for (const change of ['missing', 'unreachable', 'budget'] as const) {
    const library = coveredContinuation();
    const variant = library.variants[0]!;
    if (change === 'missing') variant.sourceCoverage![0]!.actionIds = ['does_not_exist'];
    if (change === 'unreachable') {
      variant.behaviorPolicy.states.push('unreached');
      variant.behaviorPolicy.transitions.find(transition => transition.actionId === 'missing_terminal')!.from = 'unreached';
    }
    if (change === 'budget') variant.behaviorPolicy.maxFollowUps = 0;
    assert.ok(libraryQuality(assessedCoverage(library)).some(issue => issue.code === 'source_coverage_action'), change);
  }
});

test('source-turn accounting rejects duplicate references and fake initial-fact grounding', () => {
  const library = coveredContinuation();
  const entry = library.variants[0]!.sourceCoverage![0]!;
  library.variants[0]!.sourceCoverage!.push(structuredClone(entry));
  assert.ok(libraryQuality(library).some(issue => issue.code === 'source_coverage_missing'));
  library.variants[0]!.sourceCoverage = [{ ...entry, disposition: 'initial_fact', actionIds: [], factIds: ['terminal_number'] }];
  assert.ok(libraryQuality(library).some(issue => issue.code === 'source_coverage_fact'), 'a fact from the opening cannot account for a later induced observation');
  library.variants[0]!.sourceCoverage![0]!.factIds = [];
  assert.ok(libraryQuality(library).some(issue => issue.code === 'source_coverage_fact'));
});

test('omission requires explicit semantic disposition and an edit cannot remove its harness requirement', () => {
  let library = coveredContinuation();
  const variant = library.variants[0]!;
  variant.sourceCoverage![0] = { ...variant.sourceCoverage![0]!, disposition: 'omitted', actionIds: [], reason: 'Предложено исключить реальное препятствие' };
  library = recordSemanticAssessment(library, library.variants.flatMap(v => semanticPaths(v).map(path => ({ variantId: v.id, path,
    status: v.id === variant.id && path === 'sourceCoverage' ? 'blocked' as const : 'ready' as const, reason: 'Наблюдавшееся препятствие исходной цели нельзя исключать' }))));
  assert.throws(() => acceptLibrary(library, libraryHash(library), [variant.id]), /готов/);
  const replacement = structuredClone(library.variants[0]!);
  delete replacement.sourceCoverageRequired; delete replacement.sourceCoverageBasis; delete replacement.sourceCoverage;
  const edited = editLibrary(library, libraryHash(library), { kind: 'upsert_variant', variant: replacement, reason: 'Проверка удаления метаданных' });
  assert.equal(edited.variants[0]!.sourceCoverageRequired, true);
  assert.deepEqual(edited.variants[0]!.sourceCoverageBasis, variant.sourceCoverageBasis);
  assert.ok(libraryQuality(edited).some(issue => issue.code === 'source_coverage_missing'));
});

test('coverage basis survives removed or substituted source references and remains in semantic context', async () => {
  const { planSemanticWork } = await import('../src/scenario-work.js');
  const original = coveredContinuation();
  const single = importBatch([{ id: 'single', messages: [{ role: 'user', content: 'Другой однократный запрос' }] }]);
  original.imports.push(single);
  const basis = structuredClone(original.variants[0]!.sourceCoverageBasis!);
  for (const substitute of [false, true]) {
    const replacement = structuredClone(original.variants[0]!);
    replacement.sourceDialogues = substitute ? [{ batchId: single.id, dialogueId: 'single' }] : [];
    replacement.sourceCoverage = [];
    delete replacement.sourceCoverageRequired;
    if (substitute) replacement.sourceCoverageBasis = [{ batchId: single.id, dialogueId: 'single', eventIndex: 0 }];
    else delete replacement.sourceCoverageBasis;
    const edited = editLibrary(original, libraryHash(original), { kind: 'upsert_variant', variant: replacement, reason: 'Попытка заменить исходную хронологию' });
    assert.deepEqual(edited.variants[0]!.sourceCoverageBasis, basis);
    const assessed = assessedCoverage(edited);
    assert.ok(libraryQuality(assessed).some(issue => issue.code === 'source_coverage_reference'));
    assert.ok(libraryQuality(assessed).some(issue => issue.code === 'source_coverage_missing'));
    assert.throws(() => acceptLibrary(assessed, libraryHash(assessed), ['variant_1']), /готов/);
    const coverageJob = planSemanticWork(edited).jobs.find(job => job.input.scope === 'fields' && job.input.fields.some(field => field.variantId === 'variant_1' && field.paths.includes('sourceCoverage')))!;
    assert.ok(coverageJob.input.library.imports.some(batch => batch.id === basis[0]!.batchId
      && batch.dialogues.some(dialogue => dialogue.id === 'terminal'
        && dialogue.events.some(event => event.index === 2 && event.content === 'На этой странице нет терминала'))),
    'the checker still receives original chronology');
  }
});

test('a verified owner edit can correct a mapped initial fact while preserving source coverage and requiring review', () => {
  const dialogues = structuredClone(rawDialogues);
  dialogues[0]!.messages.push({ role: 'assistant', content: 'Подтвердите номер терминала' }, { role: 'user', content: 'Номер терминала: 1234' });
  const batch = importBatch(dialogues);
  let library = createLibrary({ batch, sources, requirements, proposals: proposals(batch.id), semanticRequired: true });
  const variant = library.variants[0]!;
  variant.sourceCoverageRequired = true;
  variant.sourceCoverageBasis = [{ batchId: batch.id, dialogueId: 'terminal', eventIndex: 2 }];
  variant.sourceCoverage = [{ ...variant.sourceCoverageBasis[0]!, disposition: 'initial_fact', actionIds: [], factIds: ['terminal_number'], reason: 'Повтор личного номера по запросу' }];
  variant.userState.facts[0]!.origin = { kind: 'dialogue', batchId: batch.id, dialogueId: 'terminal', eventIndex: 2, quote: 'Номер терминала: 1234' };
  library = assessedCoverage(library);
  const basis = structuredClone(variant.sourceCoverageBasis);
  const edited = editLibrary(library, libraryHash(library), { kind: 'edit_fact', variantId: variant.id, factId: 'terminal_number', statement: 'Номер терминала: 5678', value: '5678', availability: 'initial', editId: 'owner_number_correction', reason: 'Владелец уточнил личный номер' });
  assert.deepEqual(edited.variants[0]!.sourceCoverageBasis, basis);
  assert.ok(!libraryQuality(edited).some(issue => issue.code === 'source_coverage_fact'));
  assert.ok(libraryQuality(edited).some(issue => issue.code === 'semantic_variant_pending'));
  assert.throws(() => acceptLibrary(edited, libraryHash(edited), [variant.id]), /готов/);
  const reviewed = assessedCoverage(edited);
  assert.doesNotThrow(() => acceptLibrary(reviewed, libraryHash(reviewed), [variant.id]));
  reviewed.variants[0]!.userState.facts[0]!.value = '9999';
  reviewed.variants[0]!.userState.facts[0]!.statement = 'Номер терминала: 9999';
  assert.ok(libraryQuality(reviewed).some(issue => issue.code === 'source_coverage_fact'), 'an owner label cannot authenticate a changed fact without its exact edit receipt');
});

test('editing group context reconciles checkpoint requirement references without inventing requirements', () => {
  const library = libraryFixture();
  const extra = { ...requirements[0]!, id: 'second_rule' };
  library.requirements.push(extra);
  library.variants[1]!.evaluationSpec.checkpoints[0]!.requirementId = extra.id;
  assert.ok(libraryQuality(library).some(issue => issue.code === 'invalid_checkpoint_citation'));
  const repaired = editLibrary(library, libraryHash(library), { kind: 'edit_business', businessScenarioId: library.businessScenarios[0]!.id,
    goal: 'Получить помощь с возвратом', reason: 'Общая цель вариантов' }, 'assistant');
  assert.deepEqual(repaired.businessScenarios[0]!.requirementIds, ['terminal_rule', 'second_rule']);
  assert.ok(!libraryQuality(repaired).some(issue => issue.code === 'invalid_checkpoint_citation'));
  assert.deepEqual(repaired.requirements, library.requirements, 'requirements themselves are never invented or altered');
  assert.equal(repaired.variants[1]!.semanticReviewRequired, true, 'applicability of the new context must still be assessed');
});

test('behavior repair preserves immutable evidence and facts and owes semantic review', () => {
  const library = coveredContinuation();
  library.readingManifest = [{ batchId: library.imports[0]!.id, dialogueId: 'terminal', variantIds: ['variant_1'], sourceIds: ['policy'] }];
  const original = structuredClone(library), card = library.variants[0]!;
  card.sourceCoverage![0]!.factIds = ['terminal_number'];
  assert.ok(libraryQuality(library).some(issue => issue.code === 'source_coverage_action' && issue.message.includes('пустой factIds')));
  const repaired = editLibrary(library, libraryHash(library), { kind: 'edit_behavior', variantId: card.id,
    sourceCoverage: original.variants[0]!.sourceCoverage, reason: 'Факт указан в действии, в покрытии нужна ссылка на действие' }, 'assistant');
  assert.ok(!libraryQuality(repaired).some(issue => issue.code === 'source_coverage_action'));
  assert.deepEqual(repaired.imports, original.imports);
  assert.deepEqual(repaired.readingManifest, original.readingManifest);
  assert.deepEqual(repaired.variants[0]!.sourceCoverageBasis, original.variants[0]!.sourceCoverageBasis);
  assert.deepEqual(repaired.variants[0]!.userState, original.variants[0]!.userState);
  assert.deepEqual(repaired.variants[1]!, original.variants[1]!);
  assert.equal(repaired.variants[0]!.history.at(-1)!.author, 'assistant');
  assert.equal(repaired.variants[0]!.semanticReviewRequired, true);
  assert.throws(() => acceptLibrary(repaired, libraryHash(repaired), [card.id]), /готов|ready/i);
  const forged = { kind: 'edit_behavior', variantId: card.id, sourceCoverage: [], sourceCoverageBasis: [], reason: 'Не учитывать источник' };
  assert.throws(() => editLibrary(library, libraryHash(library), forged as never, 'assistant'));
});
