# Верифицируемый эталон в карточке — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** в карточку сценария можно занести эталон (id статьи базы знаний и/или ожидаемый факт), Lab проверяет его кодом там, где это наблюдаемо, и судьёй там, где нужен смысл.

**Architecture:** эталон — поле `references` в `scenarioSchema`. Производные проверки и рубрика судьи выводятся из эталонов одной функцией `withReferenceCriteria` внутри `validatePreparation`. Эту функцию проходят сборка, правка, приёмка и переоценка, поэтому все потребители `scenario.checks` и `scenario.metrics` (отчёт, диагноз, сравнение) работают без изменений. Проверки считает `grade()` по событиям `retrieval` и ответам. Контракт адаптера описан в документе, уровень наблюдаемости считается из пробных trial в `doctor`.

**Tech Stack:** TypeScript ESM strict, zod 4, `node:test` через `tsx`; Python 3 для адаптера Agent OS.

**Спека:** `docs/superpowers/specs/2026-09-24-verifiable-cards-design.md`

---

## Правила выполнения

- Точечные тесты гонять в рабочем дереве: `npx tsx --test test/<file>.test.ts` (не удаляет `dist/`).
- Проверка типов: `npx tsc --noEmit -p .`
- Полный прогон **только** из снимка (из CLAUDE.md: `npm test` удаляет `dist/`, который импортирует живое расширение Pi):
  ```bash
  SNAP=$(mktemp -d) && git archive HEAD | tar -x -C "$SNAP" && ln -s "$PWD/node_modules" "$SNAP/node_modules" && (cd "$SNAP" && npm test)
  ```
- Перед правками: `git status` и `git log -3`. В worktree могут работать другие сессии.
- Строки для пользователя на русском, идентификаторы на английском.

## Отклонения от спеки (решены при планировании)

1. **«`unknown`» для проверки статьи.** В `CheckResult` нет состояния `unknown`: неизмеримая проверка во всём коде делает `grade()` исключением, и trial становится `invalid`, как для `eventsComplete`. `source_retrieved` следует тому же правилу: статья найдена → pass; не найдена и полнота подтверждена → fail; не найдена без подтверждения → исключение «не измерено». Перед прогоном об этом заранее предупреждает уровень наблюдаемости в `doctor`.
2. **`answer_reference_tokens` смотрит все ответы агента**, а не только последний, как и `answer_contains`: в многоходовом диалоге факт может прозвучать раньше.
3. **Правка эталонов** идёт через существующий `agent_lab_edit` (карточка передаётся целиком вместе с `references`), без отдельных операций `add/update/remove_reference`: YAGNI, механизм правки карточки уже есть.
4. **Проверку «битого эталона» при приёмке** (текст должен встречаться в чанке `source`) переносим в Task 13 для `proposed`: для них текст сверяется дословно с загруженными материалами. Для эталонов асессора содержимого чанков на этапе приёмки нет.
5. **Лимиты:** не больше 4 эталонов на карточку, текст эталона до 400 символов, id эталона до 60 символов: производные id (`ref_<id>_source`) должны укладываться в 80.

## Файлы

| Файл | Что меняется |
|---|---|
| `src/contracts.ts` | `referenceSchema`, `scenarioSchema.references`, два новых вида проверок, `describeCheck`, `withReferenceCriteria`, `unconfirmedReferences`, вызов в `validatePreparation`, `reassessmentSchema.criteria[].references`, `dialogueSchema.expected`, `dialogueToScenario` |
| `src/evaluation.ts` | `grade()`: `source_retrieved`, `answer_reference_tokens` |
| `src/experiment.ts` | `acceptDraft`: блок при неподтверждённых эталонах |
| `src/targets.ts` | `retrievals[].chunkId` |
| `src/observability.ts` (новый) | `observabilityLevel(trials)` |
| `src/connection.ts` | `doctor()` возвращает `observability` |
| `test/references.test.ts` (новый) | тесты эталонов, проверок, уровня |
| `docs/adapter-contract.md` (новый) | контракт адаптера |
| `examples/ADAPTER-BUILDER-PROMPT.md` (новый) | промпт для написания адаптера |
| `examples/adapter-reference.mjs`, `examples/agent_lab_adapter.py` (новые) | референсные адаптеры |
| `examples/agent-oc-adapter.py` | уровень 2: `retrievals` |

---

# Фаза A. Ядро: эталон → проверки → оценка

### Task 1: Схема эталона и новые виды проверок

**Files:**
- Modify: `src/contracts.ts` (рядом с `checkSchema` ~163, `describeCheck` ~176, `scenarioSchema` ~317)
- Create: `test/references.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
// test/references.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeCheck, referenceSchema, scenarioSchema } from '../src/contracts.js';

const baseCard = {
  id: 'card_1', familyId: 'card_1', title: 'Возврат', requirementIds: [], provenance: 'production' as const,
  user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'Сколько ждать возврат?', maxFollowUps: 0 },
  initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [],
};

test('reference needs a source or a text', () => {
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'owner', confirmed: true }).success, false);
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'owner', confirmed: true, text: 'До 5 рабочих дней' }).success, true);
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'assessor', confirmed: true, source: { doc: 'ACQ-123', chunk: 'c7' } }).success, true);
});

test('only a model proposal may stay unconfirmed', () => {
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'assessor', confirmed: false, text: 'x 5' }).success, false);
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'proposed', confirmed: false, text: 'x 5' }).success, true);
});

test('a card without references parses exactly as before', () => {
  const parsed = scenarioSchema.parse(baseCard);
  assert.equal('references' in parsed, false);
});

test('a card holds at most four references with unique ids', () => {
  const reference = (id: string) => ({ id, origin: 'owner', confirmed: true, text: 'До 5 дней' });
  assert.equal(scenarioSchema.safeParse({ ...baseCard, references: ['a', 'b', 'c', 'd'].map(reference) }).success, true);
  assert.equal(scenarioSchema.safeParse({ ...baseCard, references: ['a', 'b', 'c', 'd', 'e'].map(reference) }).success, false);
  assert.equal(scenarioSchema.safeParse({ ...baseCard, references: ['a', 'a'].map(reference) }).success, false);
});

test('derived checks describe themselves to the owner', () => {
  assert.equal(describeCheck({ id: 'x', description: 'd', kind: 'source_retrieved', doc: 'ACQ-123', chunk: 'c7' }), 'Найдена статья ACQ-123, фрагмент c7');
  assert.equal(describeCheck({ id: 'x', description: 'd', kind: 'answer_reference_tokens', value: 'До 5 рабочих дней, комиссия 1.5%' }), 'В ответах есть значения эталона: 1.5%');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx tsx --test test/references.test.ts`
Expected: FAIL — `referenceSchema` не экспортируется.

- [ ] **Step 3: Реализация в `src/contracts.ts`**

Перед `export const checkSchema` добавить:

```ts
/**
 * The expected result of a card: the knowledge-base article the agent must retrieve and/or the fact
 * it must convey. The origin says who vouches for it; a model proposal counts only once a person confirms it.
 */
export const referenceSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  origin: z.enum(['assessor', 'log', 'proposed', 'owner']),
  source: z.strictObject({ doc: text.max(500), chunk: text.max(500).optional() }).optional(),
  text: text.max(400).optional(),
  confirmed: z.boolean(),
}).refine(r => r.source !== undefined || r.text !== undefined, 'Эталон должен содержать source или text.')
  .refine(r => r.origin === 'proposed' || r.confirmed, 'Неподтверждённым может быть только эталон, предложенный моделью.');
export type Reference = z.infer<typeof referenceSchema>;
```

В `checkSchema` перед закрывающей `]);` добавить:

```ts
  /** Derived from a reference: the article (and chunk) is among the chunks retrieved for some reply. */
  z.strictObject({ ...checkBase, kind: z.literal('source_retrieved'), doc: text.max(500), chunk: text.max(500).optional() }),
  /** Derived from a reference: every value token of the expected fact appears in the assistant replies. */
  z.strictObject({ ...checkBase, kind: z.literal('answer_reference_tokens'), value: text.max(400) }),
```

В `describeCheck` перед строкой `if (check.kind === 'tool_called')`:

```ts
  if (check.kind === 'source_retrieved') return `Найдена статья ${check.doc}${check.chunk ? `, фрагмент ${check.chunk}` : ''}`;
  if (check.kind === 'answer_reference_tokens') return `В ответах есть значения эталона: ${[...valueTokens(check.value)].join(', ')}`;
```

В `scenarioSchema` после `metrics: ...optional(),`:

```ts
  references: z.array(referenceSchema).max(4).refine(v => unique(v.map(r => r.id)), 'Повторяются идентификаторы эталонов.').optional(),
```

- [ ] **Step 4: Тест проходит, типы сходятся**

Run: `npx tsx --test test/references.test.ts && npx tsc --noEmit -p .`
Expected: PASS; tsc без ошибок. Если tsc укажет на исчерпывающие `switch`/цепочки по `check.kind` (например, `grade()` падает в ветку инструментов), они закрываются в Task 3. Допустимо временно получить там ошибку типа `check.tool` — тогда перейти к Task 3 до коммита.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts test/references.test.ts
git commit -m "feat(cards): эталон карточки и виды проверок статьи и значений"
```

### Task 2: Вывод проверок и рубрики из эталонов

**Files:**
- Modify: `src/contracts.ts` (новые функции после `describeCheck`; вызов в `validatePreparation` в начале цикла `for (const s of p.scenarios)`)
- Test: `test/references.test.ts`

- [ ] **Step 1: Падающие тесты**

Дописать в `test/references.test.ts` (импорт расширить `withReferenceCriteria, REFERENCE_METRIC_ID, unconfirmedReferences, validatePreparation, type Scenario`):

```ts
const card = (references: unknown[], extra: Partial<Scenario> = {}) =>
  scenarioSchema.parse({ ...baseCard, metrics: [{ id: 'm', name: 'M', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }], references, ...extra });

test('a source reference becomes a retrieval check at the search stage', () => {
  const { checks } = withReferenceCriteria(card([{ id: 'r1', origin: 'assessor', confirmed: true, source: { doc: 'ACQ-123' } }]));
  assert.deepEqual(checks.map(c => [c.id, c.kind, c.stage]), [['ref_r1_source', 'source_retrieved', 'поиск']]);
});

test('a text reference with values becomes a token check and a judge rubric', () => {
  const { checks, metrics } = withReferenceCriteria(card([{ id: 'r1', origin: 'owner', confirmed: true, text: 'Возврат до 5 рабочих дней' }]));
  assert.deepEqual(checks.map(c => c.kind), ['answer_reference_tokens']);
  assert.ok(metrics?.some(m => m.id === REFERENCE_METRIC_ID && m.passCriteria.includes('Возврат до 5 рабочих дней')));
});

test('a text reference without values gets only the judge rubric', () => {
  const { checks, metrics } = withReferenceCriteria(card([{ id: 'r1', origin: 'owner', confirmed: true, text: 'Нужно обратиться в отделение' }]));
  assert.equal(checks.length, 0);
  assert.ok(metrics?.some(m => m.id === REFERENCE_METRIC_ID));
});

test('derivation replaces stale derived criteria instead of accumulating them', () => {
  const once = card([{ id: 'r1', origin: 'owner', confirmed: true, source: { doc: 'A-1' }, text: 'Срок 5 дней' }]);
  const twice = { ...once, ...withReferenceCriteria(once) };
  const edited = { ...twice, references: [{ id: 'r1', origin: 'owner' as const, confirmed: true, source: { doc: 'B-2' } }] };
  const { checks, metrics } = withReferenceCriteria(edited);
  assert.deepEqual(checks.map(c => c.kind === 'source_retrieved' ? c.doc : c.kind), ['B-2']);
  assert.equal(metrics?.some(m => m.id === REFERENCE_METRIC_ID), false);
});

test('a card without references keeps its criteria object-identical', () => {
  const plain = scenarioSchema.parse({ ...baseCard, checks: [{ id: 'c', kind: 'answer_contains', description: 'd', value: 'x' }] });
  const derived = withReferenceCriteria(plain);
  assert.equal(derived.checks, plain.checks);
  assert.equal(derived.metrics, plain.metrics);
});

test('unconfirmed proposals are listed as card/reference', () => {
  const scenarios = [card([{ id: 'r1', origin: 'proposed', confirmed: false, text: 'Срок 5 дней' }]), card([])];
  assert.deepEqual(unconfirmedReferences(scenarios), ['card_1/r1']);
});
```

И тест, что `validatePreparation` применяет вывод:

```ts
test('validation materialises reference criteria into the card', () => {
  const prepared = validatePreparation({ requirements: [], questions: [], agent: { name: 'A', instructions: 'i', tools: [] },
    scenarios: [{ ...card([{ id: 'r1', origin: 'owner', confirmed: true, source: { doc: 'ACQ-1' } }]), successCriteria: 's' }] }, [], 'evaluate');
  assert.ok(prepared.scenarios[0]!.checks.some(c => c.kind === 'source_retrieved'));
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx tsx --test test/references.test.ts`
Expected: FAIL — `withReferenceCriteria` не экспортируется.

- [ ] **Step 3: Реализация**

В `src/contracts.ts` после `describeCheck`:

```ts
export const REFERENCE_METRIC_ID = 'reference_match';
const DERIVED_CHECK_KINDS: ReadonlySet<Check['kind']> = new Set(['source_retrieved', 'answer_reference_tokens']);

/**
 * The checks and the judge rubric a card's references imply. Rebuilt from the references on every
 * validation, so the expectation lives only in `references` and an edit never leaves stale criteria.
 */
export function withReferenceCriteria<S extends Pick<Scenario, 'checks' | 'metrics' | 'references'>>(scenario: S): Pick<S, 'checks' | 'metrics'> {
  const references = scenario.references ?? [];
  const stale = scenario.checks.some(c => DERIVED_CHECK_KINDS.has(c.kind)) || !!scenario.metrics?.some(m => m.id === REFERENCE_METRIC_ID);
  if (!references.length && !stale) return { checks: scenario.checks, metrics: scenario.metrics };
  const checks = [...scenario.checks.filter(c => !DERIVED_CHECK_KINDS.has(c.kind)), ...references.flatMap(referenceChecks)];
  const kept = (scenario.metrics ?? []).filter(m => m.id !== REFERENCE_METRIC_ID);
  const texts = references.flatMap(r => r.text ? [r.text] : []);
  const metrics = texts.length ? [...kept, referenceMatch(texts)] : kept;
  return { checks, metrics: metrics.length || scenario.metrics ? metrics : undefined };
}

export function unconfirmedReferences(scenarios: Pick<Scenario, 'id' | 'references'>[]): string[] {
  return scenarios.flatMap(s => (s.references ?? []).filter(r => !r.confirmed).map(r => `${s.id}/${r.id}`));
}

function referenceChecks(reference: Reference): Check[] {
  const checks: Check[] = [];
  if (reference.source) checks.push({ id: `ref_${reference.id}_source`, kind: 'source_retrieved', stage: 'поиск',
    description: `Агент нашёл эталонную статью ${reference.source.doc}`, doc: reference.source.doc,
    ...(reference.source.chunk ? { chunk: reference.source.chunk } : {}) });
  if (reference.text && valueTokens(reference.text).size) checks.push({ id: `ref_${reference.id}_tokens`, kind: 'answer_reference_tokens', stage: 'ответ',
    description: 'Ответ содержит значения из эталона', value: reference.text });
  return checks;
}

function referenceMatch(texts: string[]): Rubric {
  const expected = texts.map(t => `«${t}»`).join('; ');
  return { id: REFERENCE_METRIC_ID, name: 'Совпадение с эталоном', subject: 'agent', stage: 'ответ',
    description: `Передают ли ответы агента факты эталона: ${expected}.`,
    passCriteria: `Ответы агента передают каждый факт эталона (${expected}) по смыслу, перефраз допустим, и ничему в нём не противоречат.`,
    failCriteria: `Хотя бы один факт эталона (${expected}) не передан, искажён или ответ ему противоречит.` };
}
```

(`Rubric` и `Scenario` объявлены ниже по файлу. Функции используют их только в типах, поэтому порядок объявления на рантайм не влияет. Если `rubricSchema` объявлен после этого места и tsc жалуется на `Rubric` в значении, перенести блок функций сразу после `replyQuality`.)

В `validatePreparation` первой строкой тела `for (const s of p.scenarios) {`:

```ts
    Object.assign(s, withReferenceCriteria(s));
    if (s.checks.length > 12) throw new Error(`Карточка ${s.id}: вместе с проверками эталонов больше 12 проверок. Уберите лишние проверки или эталоны.`);
    if ((s.metrics?.length ?? 0) > 8) throw new Error(`Карточка ${s.id}: вместе с рубрикой эталона больше 8 рубрик.`);
```

Если `withReferenceCriteria` вернул `metrics: undefined`, `Object.assign` запишет ключ со значением `undefined`. Чтобы fingerprint старых карточек не поменялся, вместо `Object.assign` использовать:

```ts
    const derived = withReferenceCriteria(s);
    s.checks = derived.checks;
    if (derived.metrics) s.metrics = derived.metrics; else delete s.metrics;
```

- [ ] **Step 4: Тесты проходят**

Run: `npx tsx --test test/references.test.ts test/contracts.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts test/references.test.ts
git commit -m "feat(cards): проверки и рубрика судьи выводятся из эталонов при каждой валидации"
```

### Task 3: Оценка `source_retrieved` и `answer_reference_tokens`

**Files:**
- Modify: `src/evaluation.ts` (`grade()` ~71–122)
- Test: `test/references.test.ts`

- [ ] **Step 1: Падающие тесты**

Дописать (импорт `grade` из `../src/evaluation.js`, `emptyUsage, type Check, type TraceEvent, type Trial` из contracts):

```ts
const world = { records: {}, writableFields: [], transientFailures: 0 };
const gradedCard = (checks: Check[]): Scenario => ({ ...scenarioSchema.parse({ ...baseCard, checks }), split: 'dev' });
const trialWith = (events: TraceEvent[]): Trial => ({ id: 't', revisionId: 'r', scenarioId: 'card_1', familyId: 'card_1', repeat: 0,
  userMode: 'static', split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], events,
  initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 0, observation: { state: 'missing', tools: 'complete' } });
const retrieval = (chunks: unknown[], complete: boolean): TraceEvent => ({ seq: 2, type: 'retrieval', result: { chunks, complete } });
const dialogue = (middle: TraceEvent, answer = 'Возврат займёт до 5 рабочих дней.'): TraceEvent[] =>
  [{ seq: 1, type: 'user', text: 'Сколько ждать?' }, middle, { seq: 3, type: 'assistant', text: answer }];
const sourceCheck = (chunk?: string): Check => ({ id: 's', kind: 'source_retrieved', description: 'd', doc: 'ACQ-123', ...(chunk ? { chunk } : {}) });

test('retrieved article passes', () => {
  const [result] = grade(gradedCard([sourceCheck()]), trialWith(dialogue(retrieval([{ source: 'ACQ-123', content: 'x' }], true))));
  assert.equal(result!.passed, true);
});

test('missing article fails when the adapter confirmed the full context', () => {
  const [result] = grade(gradedCard([sourceCheck()]), trialWith(dialogue(retrieval([{ source: 'OTHER', content: 'x' }], true))));
  assert.equal(result!.passed, false);
});

test('missing article without confirmed context is not measured', () => {
  assert.throws(() => grade(gradedCard([sourceCheck()]), trialWith(dialogue(retrieval([{ source: 'OTHER', content: 'x' }], false)))), /retrievalsComplete/);
});

test('chunk-level reference needs the same chunk', () => {
  const trial = trialWith(dialogue(retrieval([{ source: 'ACQ-123', chunkId: 'c1', content: 'x' }], true)));
  assert.equal(grade(gradedCard([sourceCheck('c7')]), trial)[0]!.passed, false);
  assert.equal(grade(gradedCard([sourceCheck('c1')]), trial)[0]!.passed, true);
});

test('reference tokens pass when every value is in the replies', () => {
  const check: Check = { id: 'v', kind: 'answer_reference_tokens', description: 'd', value: 'до 5 рабочих дней, комиссия 1.5%' };
  const noValue = { seq: 2, type: 'observation' } as TraceEvent;
  assert.equal(grade(gradedCard([check]), trialWith(dialogue(noValue, 'Комиссия 1.5%, срок — 5 дней.')))[0]!.passed, true);
  assert.equal(grade(gradedCard([check]), trialWith(dialogue(noValue, 'Комиссия 2%.')))[0]!.passed, false);
});
```

Примечание: в `valueTokens` токен — это ≥3 символа с цифрой. `5` не токен, `1.5%` → после regex `1.5` (символ `%` в класс не входит). Если ассерт из Task 1 про `describeCheck` вернёт `1.5` вместо `1.5%`, исправить ожидание теста на фактический токен `1.5`, а не менять `valueTokens`: правило токенов общее с симулятором.

- [ ] **Step 2: Тесты падают**

Run: `npx tsx --test test/references.test.ts`
Expected: FAIL — `source_retrieved` уходит в ветку инструментов.

- [ ] **Step 3: Реализация в `grade()`**

Импорт `ragEvidenceComplete, valueTokens` из `./contracts.js` (добавить к существующему импорту). Перед строкой `const answers = ...` в `grade()`:

```ts
  const retrieved = retrievedChunks(trial.events);
```

В цепочке `if/else` внутри `scenario.checks.map` перед `} else if (check.kind === 'fresh_read_before_update') {`:

```ts
    } else if (check.kind === 'source_retrieved') {
      const found = retrieved.some(chunk => chunk.source === check.doc && (check.chunk === undefined || chunk.chunkId === check.chunk));
      if (!found && !ragEvidenceComplete(trial)) throw new Error('Адаптер не подтвердил полноту найденных фрагментов (retrievalsComplete). Проверка статьи не измерена.');
      passed = found;
      evidence = `${check.doc}${check.chunk ? `#${check.chunk}` : ''} ${found ? 'есть' : 'нет'} среди найденных фрагментов: ${[...new Set(retrieved.map(c => c.source))].join(', ') || 'ничего не найдено'}.`;
    } else if (check.kind === 'answer_reference_tokens') {
      const said = valueTokens(answers);
      const missing = [...valueTokens(check.value)].filter(token => !said.has(token));
      passed = !missing.length;
      evidence = missing.length ? `В ответах нет значений эталона: ${missing.join(', ')}.` : 'Все значения эталона есть в ответах.';
```

В конец `src/evaluation.ts`:

```ts
function retrievedChunks(events: TraceEvent[]): { source: string; chunkId?: string }[] {
  return events.flatMap(event => {
    const chunks = event.type === 'retrieval' ? (event.result as { chunks?: unknown } | undefined)?.chunks : undefined;
    return Array.isArray(chunks) ? chunks.filter((c): c is { source: string; chunkId?: string } => typeof c?.source === 'string') : [];
  });
}
```

(`TraceEvent` импортировать как type, если его ещё нет в импорте.)

- [ ] **Step 4: Тесты проходят**

Run: `npx tsx --test test/references.test.ts test/evaluation.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluation.ts test/references.test.ts
git commit -m "feat(grade): проверка найденной статьи и значений эталона в ответе"
```

### Task 4: Приёмка блокируется неподтверждёнными эталонами

**Files:**
- Modify: `src/experiment.ts` (`acceptDraft`, после проверки `!record.scenarios.length`)
- Test: `test/references.test.ts` (логика уже покрыта `unconfirmedReferences` в Task 2), `test/experiment.test.ts`

- [ ] **Step 1: Найти в `test/experiment.test.ts` существующий тест `acceptDraft` и его фикстуру**

Run: `grep -n "acceptDraft" test/experiment.test.ts | head`
По образцу ближайшего теста написать новый: черновик, одна карточка которого получила через `lab.edit`/`editDraft` (метод, который используют соседние тесты) эталон `{ id: 'r1', origin: 'proposed', confirmed: false, text: 'Срок 5 дней' }`; `acceptDraft(id, draftHash(record))` падает с `/Подтвердите или удалите эталоны/`. После правки на `confirmed: true` приёмка проходит.

- [ ] **Step 2: Тест падает**

Run: `npx tsx --test test/experiment.test.ts`
Expected: FAIL — приёмка проходит.

- [ ] **Step 3: Реализация**

В `acceptDraft` после `if (!record.scenarios.length) ...`:

```ts
      const pending = unconfirmedReferences(record.scenarios);
      if (pending.length) throw new Error(`Подтвердите или удалите эталоны, предложенные моделью: ${pending.join(', ')}.`);
```

Импорт `unconfirmedReferences` из `./contracts.js`.

- [ ] **Step 4: Тест проходит**

Run: `npx tsx --test test/experiment.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/experiment.ts test/experiment.test.ts
git commit -m "feat(accept): неподтверждённый эталон модели не пускает карточку в прогон"
```

### Task 5: Эталоны при переоценке сохранённого прогона

**Files:**
- Modify: `src/contracts.ts` (`reassessmentSchema.criteria`)
- Test: `test/experiment.test.ts`

- [ ] **Step 1: Падающий тест**

Найти тест `reassess` в `test/experiment.test.ts` (`grep -n "reassess(" test/experiment.test.ts`). По его образцу: завершённый прогон на внешнем fake-адаптере, чей ответ содержит `retrievals: [{ source: 'ACQ-123', content: '…' }], retrievalsComplete: true`. Затем `reassess(id, { codeOnly: true, criteria: [{ scenarioId, references: [{ id: 'r1', origin: 'owner', confirmed: true, source: { doc: 'ACQ-123' } }] }] })`. Ожидание: у trial новой записи есть проверка `ref_r1_source` с `passed: true`, а `events` исходного trial не изменились (`fingerprint` равен).

- [ ] **Step 2: Тест падает**

Run: `npx tsx --test test/experiment.test.ts`
Expected: FAIL — `references` отвергается `strictObject`.

- [ ] **Step 3: Реализация**

В `reassessmentSchema.criteria` добавить поле:

```ts
    references: z.array(referenceSchema).max(4).optional(),
```

`reassess` уже делает `Object.assign(scenario, patch)` и затем `validatePreparation`, поэтому проверки выводятся сами.

- [ ] **Step 4: Тест проходит**

Run: `npx tsx --test test/experiment.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Полный прогон из снимка и commit**

```bash
git add src/contracts.ts test/experiment.test.ts
git commit -m "feat(reassess): эталоны добавляются к записанным прогонам без повторного запуска агента"
SNAP=$(mktemp -d) && git archive HEAD | tar -x -C "$SNAP" && ln -s "$PWD/node_modules" "$SNAP/node_modules" && (cd "$SNAP" && npm test)
```
Expected: все тесты зелёные.

---

# Фаза B. Контракт наблюдаемости

### Task 6: `chunkId` в контракте и уровень наблюдаемости в `doctor`

**Files:**
- Modify: `src/targets.ts:131-135`
- Create: `src/observability.ts`
- Modify: `src/connection.ts` (`doctor`, объект результата)
- Test: `test/references.test.ts`

- [ ] **Step 1: Падающие тесты**

```ts
import { externalReplySchema } from '../src/targets.js';
import { observabilityLevel } from '../src/observability.js';

test('adapter may report a chunk id', () => {
  const reply = externalReplySchema.parse({ reply: 'ok', retrievals: [{ source: 'ACQ-123', chunkId: 'c7', content: 'x' }], retrievalsComplete: true });
  assert.equal(typeof reply === 'string' ? undefined : reply.retrievals?.[0]?.chunkId, 'c7');
});

test('observability level is read from what the probe actually returned', () => {
  const replyOnly = { ...trialWith(dialogue({ seq: 2, type: 'observation' })), observation: { state: 'missing' as const, tools: 'partial' as const } };
  assert.deepEqual(observabilityLevel([replyOnly]), { level: 0, reply: true, tools: false, retrievals: false, state: false });
  const rag = { ...trialWith(dialogue(retrieval([{ source: 'A', content: 'x' }], true))), observation: { state: 'missing' as const, tools: 'complete' as const } };
  assert.deepEqual(observabilityLevel([rag]), { level: 2, reply: true, tools: true, retrievals: true, state: false });
});
```

- [ ] **Step 2: Тесты падают**

Run: `npx tsx --test test/references.test.ts`

- [ ] **Step 3: Реализация**

`src/targets.ts`, в объекте чанка `retrievals`:

```ts
      chunkId: z.string().trim().min(1).max(500).optional(),
```

`src/observability.ts`:

```ts
import { ragEvidenceComplete, type Trial } from './contracts.js';

export interface Observability { level: 0 | 1 | 2 | 3; reply: boolean; tools: boolean; retrievals: boolean; state: boolean }

/**
 * What the adapter proved it can show, read from real probe trials rather than from its claims.
 * Each level opens its own checks: 0 replies, 1 tool checks, 2 article checks, 3 state checks.
 */
export function observabilityLevel(trials: Pick<Trial, 'events' | 'observation'>[]): Observability {
  const every = (predicate: (trial: Pick<Trial, 'events' | 'observation'>) => boolean) => trials.length > 0 && trials.every(predicate);
  const reply = every(t => t.events.some(e => e.type === 'assistant'));
  const tools = every(t => t.observation?.tools === 'complete');
  const retrievals = every(t => ragEvidenceComplete(t));
  const state = every(t => t.observation?.state === 'reported' && t.observation.resetConfirmed === true);
  return { level: !reply || !tools ? 0 : !retrievals ? 1 : !state ? 2 : 3, reply, tools, retrievals, state };
}
```

Каждый флаг честно описывает свой канал, а `level` накопительный, как лесенка в спеке: уровень 2 требует уровней 0 и 1.

`src/connection.ts`, в `doctor` в объекте `return { format: 'agent-lab-doctor-1', ... }` добавить поле и строку в `message` не менять:

```ts
      observability: observabilityLevel(trials),
```

(импорт `observabilityLevel` из `./observability.js`).

- [ ] **Step 4: Тесты проходят**

Run: `npx tsx --test test/references.test.ts test/targets.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

```bash
git add src/targets.ts src/observability.ts src/connection.ts test/references.test.ts
git commit -m "feat(connection): проверка подключения показывает, что адаптер реально наблюдает"
```

### Task 7: Документ контракта адаптера

**Files:**
- Create: `docs/adapter-contract.md`

- [ ] **Step 1: Написать документ** (русский, ~200 строк). Разделы:
  1. **Зачем.** Lab верит только тому, что адаптер показал; слова агента — не событие.
  2. **Протокол.** `command`: JSON-lines через stdin/stdout, запрос `{"type":"respond","sessionId","scenarioId","initialState","messages","message"}`, закрытие `{"type":"close"}` (сверить с `examples/echo-agent.py` и `src/targets.ts`). `http`: тот же JSON-ответ (сверить с обработчиком http в `src/targets.ts`).
  3. **Ответ.** Таблица всех полей `externalReplySchema` из `src/targets.ts` с лимитами: `reply`, `events[]`, `eventsComplete`, `eventScope`, `retrievals[]` (`source`, `chunkId`, `content`, `score`), `retrievalsComplete`, `records`, `resetConfirmed`, `version`, `usage`, `measurementError`.
  4. **Лесенка уровней 0–3** — таблица из спеки: что отдаёт адаптер → какие проверки становятся измеримыми.
  5. **Правила полноты.** `*Complete: true` ставится только если код адаптера доказывает, что показано всё (например, читает полный журнал вызовов этого хода). Иначе флаг не ставится, и Lab честно не измеряет.
  6. **`source` — стабильный id статьи**, тот же, что пишет асессор в разметке. Не URL и не заголовок. Всё найденное в базе знаний — в `retrievals`, даже если агент получил это через tool.
  7. **Как проверить.** `agent_lab_connection` → поле `observability` (`level`, каналы).
  8. **Типичные ошибки:** `eventsComplete: true` без доказательства; `source` = заголовок; чанки только последнего поиска вместо всех за ход; секреты в `records`.

- [ ] **Step 2: Сверить каждое поле документа со схемой**

Run: `grep -n "z.strictObject\|: z\." src/targets.ts | sed -n 1,40p`. Каждое поле из таблицы есть в схеме, лимиты совпадают.

- [ ] **Step 3: Commit**

```bash
git add docs/adapter-contract.md
git commit -m "docs: контракт адаптера и лесенка наблюдаемости"
```

### Task 8: Промпт для написания адаптера

**Files:**
- Create: `examples/ADAPTER-BUILDER-PROMPT.md`

- [ ] **Step 1: Написать промпт** — готовый текст, который владелец вставляет coding-агенту в репозитории своего агента:

```markdown
# Задача: адаптер Agent Lab для этого агента

Ты пишешь адаптер, через который Agent Lab прогоняет этого агента на тестовых диалогах и видит
всё, что агент сделал. Контракт: <путь к agent-lab>/docs/adapter-contract.md — прочитай целиком.
Образец максимальной детализации: <путь к agent-lab>/examples/agent-oc-adapter.py.

## Порядок работы
1. Найди публичную точку, через которую агент обрабатывает одну реплику пользователя в сессии.
   Не меняй код агента: адаптер только вызывает и читает.
2. Найди, где агент фиксирует за один ход: вызовы инструментов (имя, аргументы, результат),
   найденные фрагменты базы знаний (id статьи, id фрагмента, текст, score), логи, итоговое состояние.
3. Отобрази найденное в поля контракта: инструменты → `events`, фрагменты → `retrievals`
   (в том числе, если агент получил их через tool), состояние → `records`.
4. Флаги полноты (`eventsComplete`, `retrievalsComplete`, `resetConfirmed`) ставь `true` только там,
   где код адаптера доказывает, что показано всё за этот ход. Если не уверен — не ставь.
5. `source` — стабильный id статьи из базы знаний, тот же, которым асессоры размечают диалоги.

## Чек-лист детализации
- [ ] каждый tool-вызов хода с args и result
- [ ] каждый найденный фрагмент с source, chunkId, content, score
- [ ] версия агента (`version`), usage модели, если доступен
- [ ] новая изолированная сессия на каждый диалог, `resetConfirmed`
- [ ] ни одного секрета или ПДн в `records` и `events`

## Проверка
Запусти `agent_lab_connection` с `action: check`. Поле `observability.level` должно быть ожидаемым
(для RAG-агента — не ниже 2). Приложи вывод к отчёту.
```

- [ ] **Step 2: Commit**

```bash
git add examples/ADAPTER-BUILDER-PROMPT.md
git commit -m "docs(examples): промпт для написания адаптера с максимальной детализацией"
```

### Task 9: Референсные адаптеры TS и Python

**Files:**
- Create: `examples/adapter-reference.mjs`, `examples/agent_lab_adapter.py`
- Test: `test/targets.test.ts` (по образцу существующих тестов command-адаптера на `examples/echo-agent.py`)

- [ ] **Step 1: Посмотреть образец протокола**

Run: `sed -n 1,80p examples/echo-agent.py && grep -n "echo-agent" test/*.test.ts | head`

- [ ] **Step 2: Падающий тест** — по образцу найденного теста echo-агента: command-цель `node examples/adapter-reference.mjs`, один ход; в trial есть событие `retrieval` с `source: 'KB-1'`, `chunkId: 'c1'` и `tool_call` `search_kb`; `observabilityLevel([trial]).level === 2`. То же для `python3 examples/agent_lab_adapter.py`.

- [ ] **Step 3: `examples/adapter-reference.mjs`** — JSON-lines цикл на `node:readline`. Функция `ask(session, message)` — игрушечный RAG над встроенной базой из двух статей (`KB-1`: «Возврат по эквайрингу занимает до 5 рабочих дней», `KB-2`: «Комиссия за эквайринг 1.5%»). Выбор статьи по совпадению слов. Ответ: `reply`, `events: [{ tool: 'search_kb', args: { query }, result: { docIds } }]`, `eventsComplete: true`, `eventScope: ['search_kb']`, `retrievals: [{ source, chunkId: 'c1', content, score }]`, `retrievalsComplete: true`, `resetConfirmed: true`, `version: 'reference-1'`. На `{"type":"close"}` выход.

- [ ] **Step 4: `examples/agent_lab_adapter.py`** — хелпер + тот же демо-агент:

```python
@dataclass(frozen=True)
class Retrieval:
    source: str
    content: str
    chunk_id: Optional[str] = None
    score: Optional[float] = None

@dataclass(frozen=True)
class ToolEvent:
    tool: str
    args: Any = None
    result: Any = None

@dataclass(frozen=True)
class Reply:
    reply: str
    events: Sequence[ToolEvent] = ()
    retrievals: Sequence[Retrieval] = ()
    events_complete: bool = False
    retrievals_complete: bool = False
    reset_confirmed: bool = False
    version: Optional[str] = None

    def to_wire(self) -> Dict[str, Any]: ...  # camelCase-поля контракта, пустые опускаются

def serve(ask: Callable[[str, str], Reply]) -> None: ...  # цикл stdin/stdout, "close" → выход
```

Демо внизу файла: `if __name__ == "__main__": serve(demo_ask)` с той же базой из двух статей.

- [ ] **Step 5: Тесты проходят, commit**

```bash
npx tsx --test test/targets.test.ts
git add examples/adapter-reference.mjs examples/agent_lab_adapter.py test/targets.test.ts
git commit -m "feat(examples): референсные адаптеры уровня 2 на TS и Python"
```

---

# Фаза C. Agent OS и живая проверка

### Task 10: Адаптер Agent OS на уровне 2

**Files:**
- Modify: `examples/agent-oc-adapter.py`

- [ ] **Step 1: Найти, где Agent OS отдаёт найденные фрагменты**

Run (репозиторий agent_oc рядом с playground, путь как в runbook `docs/AGENT-OC-RUNBOOK.md`):
```bash
grep -rn "doc_count\|chunks\|retriev\|documents" ../agent_oc/harness_core* ../agent_oc/*/ --include=*.py | head -40
```
Нужно найти в результате `run_turn(...)["actions"]` (или в логах хода) список документов с id и текстом. Записать в коммит-сообщение, откуда берутся поля.

- [ ] **Step 2: Отобразить в `retrievals`**

В `respond()` добавить `"retrievals": as_retrievals(result)` и `"retrievalsComplete": True` — **только** если найденный источник содержит все документы, переданные модели в этом ходе. Если полноту доказать нельзя, флаг не ставить. `as_retrievals` возвращает `[{"source": <стабильный id документа>, "chunkId": <id фрагмента, если есть>, "content": <текст ≤12000>, "score": <число, если есть>}]`, не больше 20 штук и не больше 60000 символов суммарно (лимиты `externalReplySchema`). Если документов больше, оставить первые 20 и НЕ ставить `retrievalsComplete`.

- [ ] **Step 3: Проверка подключения**

Run: `agent_lab_connection check` с конфигом Agent OS (из runbook).
Expected: `observability.level >= 2`, `retrievals: true`.

- [ ] **Step 4: Commit**

```bash
git add examples/agent-oc-adapter.py
git commit -m "feat(agent-oc): адаптер отдаёт найденные фрагменты базы знаний"
```

### Task 11: Живая проверка на Agent OS

- [ ] **Step 1:** Черновик из 3–5 карточек Agent OS. Через `agent_lab_edit` добавить эталоны: минимум один `owner` с `source` (статья, которую агент должен найти), один `owner` с `text` (факт со значением), одну карточку с намеренно неверным `doc`.
- [ ] **Step 2:** Приёмка и прогон (стоимость около $2, спросить владельца перед запуском).
- [ ] **Step 3:** В отчёте есть проверки `ref_*` на стадиях «поиск» и «ответ», неверный `doc` даёт fail, а не pass, рубрика «Совпадение с эталоном» оценена.
- [ ] **Step 4:** `agent_lab_reassess` старого прогона Agent OS с эталонами (`codeOnly`) → проверки посчитаны по сохранённым данным.
- [ ] **Step 5:** Записать результаты (id прогонов, что прошло / упало) в `.planning/` или в описание PR. Прод-данные в репозиторий не коммитить.

---

# Фаза D. Откуда берутся эталоны

### Task 12: Разметка асессора и эталон из лога при импорте

**Files:**
- Modify: `src/contracts.ts` (`dialogueSchema`, `dialogueToScenario`), `src/imports.ts` (`importDialogues`)
- Test: `test/references.test.ts`

- [ ] **Step 1: Выяснить путь импорта до карточки**

Run: `grep -n "dialogueToScenario\|importDialogues\|readDialogueImport" src/*.ts extensions/agent-lab.ts | head` и `sed -n 1,40p src/scenario-contracts.ts`. Выяснить: (а) какие команды строят карточки из `dialogueSchema` через `dialogueToScenario`; (б) где в `ImportBatch` лежит исходный JSON диалога (`original`) и события `retrieval`/`tool`.

- [ ] **Step 2: Падающие тесты**

```ts
test('assessor markup in a dialogue becomes confirmed references', () => {
  const dialogue = dialogueSchema.parse({ id: 'd1', outcome: 'success', messages: [{ role: 'user', content: 'Сколько ждать?' }],
    expected: [{ doc: 'ACQ-123', text: 'До 5 рабочих дней' }] });
  const scenario = dialogueToScenario(dialogue, { goal: 'Узнать срок' });
  assert.deepEqual(scenario.references, [{ id: 'assessor_1', origin: 'assessor', confirmed: true, source: { doc: 'ACQ-123' }, text: 'До 5 рабочих дней' }]);
});

test('importing keeps the markup of each dialogue', () => {
  const { dialogues } = importDialogues(/* минимальный формат импорта из существующего теста импорта + поле expected у диалога */);
  assert.deepEqual(dialogues[0]!.expected, [{ doc: 'ACQ-123' }]);
});
```

Формат вызова `importDialogues` взять из ближайшего существующего теста импорта (`grep -n "importDialogues" test/*.ts`).

- [ ] **Step 3: Реализация**

`dialogueSchema`:
```ts
  expected: z.array(z.strictObject({ doc: text.max(500).optional(), chunk: text.max(500).optional(), text: text.max(400).optional() })
    .refine(e => e.doc !== undefined || e.text !== undefined, 'Разметка должна содержать doc или text.')).max(4).optional(),
```
`dialogueToScenario` — в возвращаемый объект:
```ts
    ...(dialogue.expected?.length ? { references: dialogue.expected.map((e, i) => ({ id: `assessor_${i + 1}`, origin: 'assessor' as const, confirmed: true,
      ...(e.doc ? { source: { doc: e.doc, ...(e.chunk ? { chunk: e.chunk } : {}) } } : {}), ...(e.text ? { text: e.text } : {}) })) } : {}),
```
`importDialogues` — передать `expected` из `dialogue.original`, если это объект с массивом `expected`.

Эталон из лога (`origin: 'log'`): если в `ImportBatch` у успешного диалога (`outcome: 'success'`) есть события `retrieval` с `data.source` (или `data.chunks[].source`), и у диалога нет разметки асессора, взять уникальные `source` (до 4) как `references` с `origin: 'log'`. Реализовать тем же тестом с событием `retrieval` в формате, найденном в Step 1. Если в формате импорта таких событий нет, записать это в `.planning/` и пропустить.

- [ ] **Step 4: Тесты проходят, commit**

```bash
npx tsx --test test/references.test.ts && npx tsc --noEmit -p .
git add src/contracts.ts src/imports.ts test/references.test.ts
git commit -m "feat(import): разметка асессора и найденные в логе статьи становятся эталоном карточки"
```

### Task 13: Эталон, предложенный моделью по базе знаний

**Files:**
- Modify: `src/prompts.ts` (роль сборки карточек), `src/pi.ts` (схема ответа роли, пост-обработка ~570–600), `src/contracts.ts` (grounding эталона)
- Test: `test/references.test.ts`, `test/pi.test.ts`

- [ ] **Step 1: Найти роль и схему сборки карточек**

Run: `grep -n "GOALS_ROLE\|SCENARIOS_ROLE\|verbatimSpan" src/prompts.ts src/pi.ts src/contracts.ts | head -20`

- [ ] **Step 2: Падающий тест grounding**

```ts
test('a proposed reference must quote a knowledge source verbatim', () => {
  const sources = [{ id: 's1', name: 'kb', content: 'Возврат по эквайрингу занимает до 5 рабочих дней.', hash: 'h', kind: 'knowledge' as const }];
  assert.deepEqual(groundedProposals([{ id: 'r1', origin: 'proposed', confirmed: false, text: 'до 5 рабочих дней' }], sources).map(r => r.id), ['r1']);
  assert.deepEqual(groundedProposals([{ id: 'r2', origin: 'proposed', confirmed: false, text: 'до 3 дней' }], sources), []);
});
```

- [ ] **Step 3: Реализация**

`src/contracts.ts`:
```ts
/** A model proposal survives only if its text is a verbatim span of a knowledge source; an invalid one is dropped, never repaired. */
export function groundedProposals(references: Reference[], sources: Source[]): Reference[] {
  const knowledge = sources.filter(s => s.kind !== 'prompt');
  return references.filter(r => r.origin !== 'proposed' || r.text === undefined || knowledge.some(s => verbatimSpan(s.content, r.text!) !== undefined));
}
```
(сигнатуру `verbatimSpan` сверить с `contracts.ts`; если она возвращает другое значение, использовать её так же, как её использует grounding требований.)

В роли сборки: если у карточки нет эталона и есть источник `knowledge`, модель предлагает до 2 `references` с `origin: 'proposed'`, `confirmed: false`, `text` — дословной цитатой, `source.doc` — `name` источника. В пост-обработке `pi.ts` рядом с фильтрацией `MACHINE_FORMAT` применить `groundedProposals`.

- [ ] **Step 4: Тесты, commit**

```bash
npx tsx --test test/references.test.ts test/pi.test.ts && npx tsc --noEmit -p .
git add src/contracts.ts src/prompts.ts src/pi.ts test/references.test.ts test/pi.test.ts
git commit -m "feat(build): модель предлагает эталон по базе знаний, человек подтверждает"
```

- [ ] **Step 5: Полный прогон из снимка**

```bash
SNAP=$(mktemp -d) && git archive HEAD | tar -x -C "$SNAP" && ln -s "$PWD/node_modules" "$SNAP/node_modules" && (cd "$SNAP" && npm test)
```

---

## Порядок и точки остановки

Фаза A → B → C → D. После каждой фазы — полный прогон из снимка и короткий отчёт владельцу. Живой прогон Agent OS (Task 11) стоит денег: запускать только после явного «да».
