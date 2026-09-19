import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioSchema } from '../src/contracts.js';
import { importBatch, createLibrary, libraryHash, libraryQuality, editLibrary, acceptLibrary, compileLibrary, librarySnapshot } from '../src/scenario-library.js';
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
  assert.deepEqual(compileLibrary(acceptLibrary(edited, libraryHash(edited), ['variant_1']))[0]!.user.knows, ['Номер терминала: 5678']);
  const removed = editLibrary(edited, libraryHash(edited), { kind: 'remove_variant', variantId: 'variant_1', reason: 'Исключить' });
  assert.equal(removed.variants.length, 1);
  assert.equal(removed.imports[0]!.dialogues.length, 2);
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
