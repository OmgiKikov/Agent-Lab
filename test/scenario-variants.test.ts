import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptLibrary, compileLibrary, editLibrary, libraryHash, libraryQuality, recordSemanticAssessment, semanticPaths } from '../src/scenario-library.js';
import { proposeVariant } from '../src/scenario-variants.js';
import { libraryFixture } from './helpers/scenario-library.js';

const request = (parentId: string, operation: Parameters<typeof proposeVariant>[1]['operation'], input: Record<string, unknown>) => ({
  parentId, operation, reason: `Проверить ${operation}`, input,
});
const admit = (library: ReturnType<typeof libraryFixture>) => recordSemanticAssessment(library,
  library.variants.flatMap(variant => semanticPaths(variant).map(path => ({ variantId: variant.id, path, status: 'ready' as const, reason: 'Проверено' }))));

test('targeted variants cover disclosure, missing data, ambiguity, changed intent and supported tool failure', () => {
  const cases = [
    ['reveal_on_request', { factId: 'terminal_number', ifAsked: 'Какой номер терминала?' }],
    ['missing_fact', { factId: 'terminal_number', ifAsked: 'Какой номер терминала?' }],
    ['ambiguous_opening', { opening: 'Помогите, пожалуйста' }],
    ['changed_intent', { intent: 'Теперь отмените возврат', afterActionId: 'finish' }],
  ] as const;
  for (const [operation, input] of cases) {
    const source = libraryFixture();
    const before = structuredClone(source);
    const result = proposeVariant(source, request('variant_1', operation, input), libraryHash(source));
    assert.deepEqual(source, before, `${operation} не меняет исходную ревизию`);
    assert.equal(result.library.variants.length, source.variants.length + 1);
    assert.equal(result.variant.parentVariantId, 'variant_1');
    assert.equal(result.variant.provenance, 'synthetic');
    assert.equal(result.variant.history.at(-1)?.author, 'generator');
    assert.ok(result.diff.length > 0);
    assert.ok(libraryQuality(result.library).some(issue => issue.variantId === result.variant.id && issue.code === 'semantic_variant_pending'));
  }

  const managed = libraryFixture();
  managed.variants[0]!.environmentFixture = {
    mode: 'managed',
    initialState: { records: {}, writableFields: [], transientFailures: 0 },
    contract: { operations: ['lookup_record', 'update_record'], reset: true, observations: ['reply', 'tool'], confirmed: true },
  };
  const tool = proposeVariant(managed, request('variant_1', 'tool_failure', { operation: 'update_record', failures: 1 }), libraryHash(managed));
  assert.equal((tool.variant.environmentFixture.initialState as { transientFailures?: number }).transientFailures, 1);
  assert.throws(() => proposeVariant(managed, request('variant_1', 'tool_failure', { operation: 'lookup_record' }), libraryHash(managed)), /update_record|сбо/i);
  assert.throws(() => proposeVariant(libraryFixture(), request('variant_1', 'tool_failure', { operation: 'lookup_record' }), libraryHash(libraryFixture())), /fixture|операц|управляем/i);
});

test('disclosure keeps a known fact out of the opening and missing data creates no synthetic fact', () => {
  const disclosureSource = libraryFixture();
  const disclosure = proposeVariant(disclosureSource, request('variant_1', 'reveal_on_request', {
    factId: 'terminal_number', ifAsked: 'Назовите номер терминала', reply: 'Номер терминала: 1234',
  }), libraryHash(disclosureSource)).variant;
  assert.doesNotMatch(disclosure.userState.opening, /1234/);
  assert.ok(disclosure.behaviorPolicy.actions.some(action => action.kind === 'answer' && action.factIds.includes('terminal_number') && action.ifAsked));

  const missingSource = libraryFixture();
  const missingResult = proposeVariant(missingSource, request('variant_1', 'missing_fact', {
    factId: 'terminal_number', ifAsked: 'Назовите номер терминала',
  }), libraryHash(missingSource));
  const missing = missingResult.variant;
  assert.equal(missing.userState.facts.some(fact => fact.id === 'terminal_number'), false);
  assert.ok(missing.userState.missing.includes('Номер терминала'));
  assert.ok(missing.behaviorPolicy.actions.some(action => action.kind === 'missing' && action.factIds.length === 0));
  assert.equal(missing.behaviorPolicy.actions.some(action => action.factIds.includes('terminal_number') || /1234/.test(action.payload ?? '')), false);
  delete missing.semanticReviewRequired;
  const compiled = compileLibrary(acceptLibrary(missingResult.library, libraryHash(missingResult.library), [missing.id]))[0]!;
  assert.doesNotMatch(JSON.stringify(compiled.user), /1234/, 'удалённое значение отсутствует во всём исполнимом UserView');
});

test('conditional disclosure removes an existing unconditional reveal of the selected fact', () => {
  const source = libraryFixture();
  const policy = source.variants[0]!.behaviorPolicy;
  policy.actions = [{ id: 'always_reveal', kind: 'answer', factIds: ['terminal_number'], payload: 'Номер терминала: 1234' }];
  policy.transitions = [{ from: 'waiting', to: 'done', actionId: 'always_reveal', when: 'После любого ответа агента' }];
  const proposed = proposeVariant(source, request('variant_1', 'reveal_on_request', {
    factId: 'terminal_number', ifAsked: 'Агент прямо запросил номер терминала',
  }), libraryHash(source));
  const checked = admit(proposed.library);
  const compiled = compileLibrary(acceptLibrary(checked, libraryHash(checked), [proposed.variant.id]))[0]!;
  assert.equal(proposed.variant.behaviorPolicy.actions.some(action => action.id === 'always_reveal'), false);
  const reveals = proposed.variant.behaviorPolicy.actions.filter(action => action.factIds.includes('terminal_number') || /1234/.test(action.payload ?? ''));
  assert.equal(reveals.length, 1);
  assert.match(reveals[0]!.ifAsked ?? '', /прямо запросил/i);
  assert.equal(proposed.variant.behaviorPolicy.transitions.some(transition => transition.when === 'После любого ответа агента'), false);
  assert.doesNotMatch(compiled.user.behavior, /После любого ответа агента/);
  assert.deepEqual(compiled.user.answers, [{ ifAsked: 'Агент прямо запросил номер терминала', reply: 'Номер терминала: 1234' }]);
});

test('disclosure and missing-fact operations can replace a source opening that revealed the selected value', () => {
  for (const operation of ['reveal_on_request', 'missing_fact'] as const) {
    const source = libraryFixture();
    source.variants[0]!.userState.opening = 'Терминал 1234 не работает';
    const result = proposeVariant(source, request('variant_1', operation, {
      factId: 'terminal_number', opening: 'Терминал не работает', ifAsked: 'Какой номер терминала?',
    }), libraryHash(source));
    assert.equal(result.variant.userState.opening, 'Терминал не работает');
    if (operation === 'missing_fact') assert.doesNotMatch(JSON.stringify(result.variant.userState), /1234/);
  }
});

test('missing fact accepts a value-free slot for a natural-language fact without a separate value', () => {
  const source = libraryFixture();
  const fact = source.variants[0]!.userState.facts[0]!;
  fact.statement = 'Пользователь работает в отделении на Невском 10';
  delete fact.value;
  source.variants[0]!.userState.opening = 'Нужна помощь с отделением';
  const result = proposeVariant(source, request('variant_1', 'missing_fact', {
    factId: fact.id, missingDescription: 'Адрес отделения', ifAsked: 'В каком отделении вы работаете?',
  }), libraryHash(source)).variant;
  assert.deepEqual(result.userState.missing, ['Адрес отделения']);
  assert.doesNotMatch(JSON.stringify(result.userState), /Невском 10/);
  assert.throws(() => proposeVariant(source, request('variant_1', 'missing_fact', {
    factId: fact.id, ifAsked: 'В каком отделении вы работаете?',
  }), libraryHash(source)), /описание|данн/i);
});

test('missing fact removes a nonnumeric secret from an inherited owner persona and compiled UserView', () => {
  const source = libraryFixture();
  const variant = structuredClone(source.variants[0]!);
  variant.userState.facts[0]!.statement = 'Кодовое слово: Сокол';
  variant.userState.facts[0]!.value = 'Сокол';
  variant.userState.facts[0]!.origin = { kind: 'owner', editId: 'owner_secret', text: 'Владелец указал кодовое слово' };
  variant.userState.persona = { text: 'Помнит кодовое слово Сокол', ownerEditId: 'owner_persona' };
  let edited = editLibrary(source, libraryHash(source), { kind: 'upsert_variant', variant, reason: 'Владелец задал персону' });
  edited = editLibrary(edited, libraryHash(edited), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number',
    statement: 'Кодовое слово: Сокол', value: 'Сокол', availability: 'initial', editId: 'owner_secret', reason: 'Владелец указал кодовое слово' });
  const proposed = proposeVariant(edited, request('variant_1', 'missing_fact', {
    factId: 'terminal_number', missingDescription: 'Кодовое слово', ifAsked: 'Какое кодовое слово?',
  }), libraryHash(edited));
  assert.equal(proposed.variant.userState.persona, undefined);
  const checked = admit(proposed.library);
  const compiled = compileLibrary(acceptLibrary(checked, libraryHash(checked), [proposed.variant.id]))[0]!;
  assert.doesNotMatch(JSON.stringify(compiled.user), /Сокол/i);
});

test('changed intent has a finite declared transition and variants reject exact behavioral duplicates under renamed ids', () => {
  const source = libraryFixture();
  const changed = proposeVariant(source, request('variant_1', 'changed_intent', {
    intent: 'Теперь отмените возврат', afterActionId: 'finish',
  }), libraryHash(source)).variant;
  const action = changed.behaviorPolicy.actions.find(item => item.kind === 'change_intent');
  assert.ok(action?.payload?.includes('отмените'));
  const inserted = changed.behaviorPolicy.transitions.find(item => item.actionId === action?.id);
  assert.ok(inserted);
  assert.equal(inserted?.from, changed.behaviorPolicy.initialState, 'смена намерения занимает выбранный шаг после ответа агента');
  assert.equal(changed.userState.goal, source.variants[0]!.userState.goal, 'исходная цель сохраняется до перехода');
  assert.ok(changed.behaviorPolicy.transitions.some(item => item.actionId === 'finish' && item.from === inserted?.to), 'завершение перенесено после смены намерения');
  assert.equal(changed.behaviorPolicy.actions.find(item => item.id === inserted?.actionId)?.kind, 'change_intent');
  assert.ok(changed.behaviorPolicy.maxFollowUps <= 15);

  const renamed = structuredClone(source.variants[0]!);
  renamed.id = 'renamed_duplicate';
  renamed.userState.facts[0]!.id = 'fact_alias';
  renamed.behaviorPolicy.states = ['state_a', 'state_b'];
  renamed.behaviorPolicy.initialState = 'state_a';
  renamed.behaviorPolicy.terminalStates = ['state_b'];
  renamed.behaviorPolicy.actions[0]!.id = 'action_alias';
  renamed.behaviorPolicy.transitions[0] = { ...renamed.behaviorPolicy.transitions[0]!, from: 'state_a', to: 'state_b', actionId: 'action_alias' };
  const doubled = editLibrary(source, libraryHash(source), { kind: 'upsert_variant', variant: renamed, reason: 'Проверка канонизации ссылок' });
  const issues = libraryQuality(doubled).filter(issue => issue.code === 'duplicate_variant');
  assert.deepEqual(new Set(issues.map(issue => issue.variantId)), new Set(['variant_1', 'renamed_duplicate']));
});

test('changed intent preserves a non-finish anchor before the inserted change', () => {
  const source = libraryFixture();
  const policy = source.variants[0]!.behaviorPolicy;
  policy.actions = [{ id: 'answer_terminal', kind: 'answer', factIds: ['terminal_number'], payload: 'Номер терминала: 1234' }];
  policy.transitions = [{ from: 'waiting', to: 'done', actionId: 'answer_terminal', when: 'Агент запросил номер' }];
  const child = proposeVariant(source, request('variant_1', 'changed_intent', {
    intent: 'Теперь отмените возврат', afterActionId: 'answer_terminal',
  }), libraryHash(source)).variant;
  const first = child.behaviorPolicy.transitions.find(item => item.from === 'waiting')!;
  const second = child.behaviorPolicy.transitions.find(item => item.from === first.to)!;
  assert.equal(first.actionId, 'answer_terminal');
  assert.equal(child.behaviorPolicy.actions.find(item => item.id === second.actionId)?.kind, 'change_intent');
  assert.equal(second.to, 'done');
});

test('owner-corrected facts retain ancestor provenance without forged owner history in a generated child', () => {
  const source = libraryFixture();
  const ownerEdited = editLibrary(source, libraryHash(source), {
    kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number', statement: 'Номер терминала: 5678',
    value: '5678', availability: 'initial', editId: 'owner_fix_1', reason: 'Владелец исправил номер',
  });
  const result = proposeVariant(ownerEdited, request('variant_1', 'ambiguous_opening', { opening: 'Помогите с этим' }), libraryHash(ownerEdited));
  const child = result.variant;
  assert.equal(child.userState.facts[0]!.origin.kind, 'owner');
  assert.equal(child.history.some(entry => entry.author === 'owner'), false, 'генератор не подделывает квитанцию владельца');
  assert.equal(libraryQuality(result.library).some(issue => issue.variantId === child.id && issue.code === 'unverified_owner_fact'), false);

  child.userState.facts[0]!.statement = 'Номер терминала: 9999';
  child.userState.facts[0]!.value = '9999';
  assert.ok(libraryQuality(result.library).some(issue => issue.variantId === child.id && issue.code === 'unverified_owner_fact'));
});

test('stale hashes and repeated targeted variants are rejected without changing source or accepted snapshots', () => {
  const source = libraryFixture();
  const before = JSON.stringify(source);
  assert.throws(() => proposeVariant(source, request('variant_1', 'ambiguous_opening', { opening: 'Неясный запрос' }), '0'.repeat(64)), /хеш|измени/i);
  const first = proposeVariant(source, request('variant_1', 'ambiguous_opening', { opening: 'Неясный запрос' }), libraryHash(source));
  assert.throws(() => proposeVariant(first.library, request('variant_1', 'ambiguous_opening', { opening: 'Неясный запрос' }), libraryHash(first.library)), /дубл|существ/i);
  assert.equal(JSON.stringify(source), before);
});
